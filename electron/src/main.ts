import { app, BrowserWindow, ipcMain, dialog, shell, protocol, session } from 'electron';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { Readable } from 'node:stream';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fsService from './fs-service';
import * as gitService from './git-service';
import * as draftService from './draft-service';
import * as draftDaemon from './draft-daemon';
import * as typstService from './typst-service';
import * as typstPreviewPage from './typst-preview-page';
import * as toolchain from './toolchain';
import { startWorkspaceWatch, stopWorkspaceWatch } from './fs-watch';
import * as mcp from './mcp/server';
import { publishWindowState, forgetWindow, type WindowState } from './mcp/state';
import { deliverResponse } from './mcp/bridge';
import { registerWindowChrome, forgetWindowChrome, watchWindowState } from './window-chrome';
import { registerDiagramRelinkIpc, registerDiagramNativeIpc } from './diagram-ipc';
import { renderDiagramSvgToPdf } from './diagram-pdf';
import { diagramCpu } from './diagram-cpu';
import { createManagedCompileService } from './managed-compile';
import {
	frontendDevelopment,
	frontendBuilt,
	FRONTEND_DEVELOPMENT_URL,
	FRONTEND_BUILT_URL,
	matchesFrontendHostURL
} from './frontend-development';
import { FrontendFiles } from './frontend-files';
import { FrontendWatch } from './frontend-watch';
import { FrontendRecent } from './frontend-recent';
import { FrontendCompiler } from './frontend-compile';
import {
	DRAWIO_PRIVILEGES,
	createDrawioHandler,
	drawioVendorRoot,
	installDrawioNetworkGuard,
	installDrawioNavigationGuard,
	matchesDiagramHostURL
} from './drawio-protocol';

const isDev = !app.isPackaged;
const isFrontendDev = frontendDevelopment(app.isPackaged, process.env.MODUTEX_RENDERER);
const isFrontendBuilt = frontendBuilt(app.isPackaged, process.env.MODUTEX_RENDERER);
const useOriginalFrontend = isFrontendDev || isFrontendBuilt;

// display name for menus/notifications and the Linux WM_CLASS (GNOME matches it against the
// .desktop file's StartupWMClass=ModuTeX; without this the dock shows "modutex-desktop").
// Pin the ModuTeX settings namespace rather than inheriting the upstream package name.
// A dev-channel build (productName ending in "Dev", made with --config.productName="ModuTeX Dev")
// gets its OWN settings dir and instance lock, so a test exe runs beside the installed ModuTeX
// without touching its settings or fighting its single-instance lock.
const devChannel = /[ -]dev$/.test(app.getName().toLowerCase());
const dataDirName = devChannel ? 'modutex-desktop-dev' : 'modutex-desktop';
app.setPath('userData', path.join(app.getPath('appData'), dataDirName));
app.setPath('sessionData', path.join(app.getPath('appData'), dataDirName));
app.setName(devChannel ? 'ModuTeX Dev' : 'ModuTeX');

// Keep the rewrite's development session separate from the published app.
if (useOriginalFrontend) {
	const frontendData = path.join(app.getPath('appData'), 'modutex-frontend-development');
	app.setPath('userData', frontendData);
	app.setPath('sessionData', frontendData);
}

// dev/test hook: userData scopes settings, caches, and the single-instance lock,
// so without this a dev run can't start while an installed ModuTeX is open.
// TEXPILE_USER_DATA is a non-user-visible compatibility hook retained for existing test tooling.
if (isDev && process.env.TEXPILE_USER_DATA) {
	app.setPath('userData', process.env.TEXPILE_USER_DATA);
	app.setPath('sessionData', process.env.TEXPILE_USER_DATA);
}

// ---- multi-window registry (one workspace per window, VS Code model) ----
// what each window has open, keyed by webContents id; null = start screen
type WindowRoot = { raw: string; norm: string };
const windowRoots = new Map<number, WindowRoot | null>();
const frontendFiles = new Map<number, FrontendFiles>();
const frontendWatches = new Map<number, Map<string, { workspaceId: string; watcher: FrontendWatch }>>();
let frontendRecent: FrontendRecent | undefined;
function recentFiles(): FrontendRecent {
	return frontendRecent ??= new FrontendRecent(path.join(app.getPath('userData'), 'frontend-recent-v1.json'));
}
const frontendPickers = new Set<number>();
const diagramGenerations = new Map<number, number>();
let diagramNative: ReturnType<typeof registerDiagramNativeIpc> | undefined;
let managedCompile: ReturnType<typeof createManagedCompileService> | undefined;
let frontendCompiler: FrontendCompiler | undefined;
function stopFrontendWatches(id: number, notify = false): void {
	const watches = frontendWatches.get(id);
	if (!watches) return;
	frontendWatches.delete(id);
	const win = notify ? windowFor(id) : null;
	for (const [subscriptionId, subscription] of watches) {
		if (win && !win.webContents.isDestroyed()) {
			win.webContents.send('frontend:watch:error', { subscriptionId, error: 'STALE_WORKSPACE' });
		}
		subscription.watcher.stop();
	}
}
function invalidateDiagramOwner(id: number): void {
	frontendCompiler?.cancelOwner(id);
	stopFrontendWatches(id);
	frontendFiles.get(id)?.close();
	frontendFiles.delete(id);
	managedCompile?.cancelOwner(id);
	diagramGenerations.set(id, (diagramGenerations.get(id) ?? 0) + 1);
	diagramNative?.invalidate(id);
}
function isAuthorizedSender(
	event: Electron.IpcMainInvokeEvent,
	matcher: (actual: string, expected: string) => boolean
): boolean {
	const win = windowFor(event.sender.id);
	const expected = hostURLs.get(event.sender.id);
	return (
		!!win &&
		!event.sender.isDestroyed() &&
		win.webContents === event.sender &&
		event.senderFrame === event.sender.mainFrame &&
		!!expected &&
		matcher(event.sender.getURL(), expected) &&
		matcher(event.senderFrame.url, expected)
	);
}
function isDiagramHost(event: Electron.IpcMainInvokeEvent): boolean {
	return !useOriginalFrontend && isAuthorizedSender(event, matchesDiagramHostURL);
}
function isFrontendHost(event: Electron.IpcMainInvokeEvent): boolean {
	return useOriginalFrontend && isAuthorizedSender(event, matchesFrontendHostURL);
}
// a file/folder a freshly-created window should open once its renderer loads
type PendingOpen = { kind: 'file' | 'folder'; path: string };
const pendingOpens = new Map<number, PendingOpen>();
// closes held open while the renderer flushes/confirms unsaved edits (see win.on('close'))
const pendingCloses = new Map<number, { settle: (proceed: boolean) => void }>();
// .tex handed over by the OS before any window exists; consumed at whenReady
let initialOpenPath: string | null = null;
// set during shutdown so per-window close cleanup doesn't drain the persisted session
let quitting = false;

// Windows hands out the same folder with varying drive-letter case, so root identity
// must compare case-insensitively there (mirrors the renderer's workspaceStore)
function normRoot(p: string): string {
	const s = path.resolve(p).replace(/[\\/]+$/, '');
	return process.platform === 'win32' ? s.toLowerCase() : s;
}
function windowFor(wcId: number): BrowserWindow | null {
	return BrowserWindow.getAllWindows().find((w) => w.webContents.id === wcId) ?? null;
}
function windowWithRoot(root: string): BrowserWindow | null {
	const n = normRoot(root);
	for (const [wcId, r] of windowRoots) {
		if (r && r.norm === n) {
			const w = windowFor(wcId);
			if (w) return w;
		}
	}
	return null;
}
function focusWindow(w: BrowserWindow): void {
	if (w.isMinimized()) w.restore();
	w.focus();
}
// session restore: settings.openFolders always mirrors the live registry, EXCEPT while
// quitting (or when the last window closes), so the snapshot survives for the next launch
function persistOpenFolders(): void {
	if (quitting) return;
	const roots: string[] = [];
	for (const r of windowRoots.values()) if (r) roots.push(r.raw);
	writeSettings({ openFolders: roots });
}

// GUI launches on macOS/Linux inherit a stripped PATH (no TeX/Homebrew dirs), hiding synctex and
// git. Recover the real PATH from a login shell, reading $PATH between markers so rc noise can't corrupt it.
function fixShellPath(): void {
	if (process.platform === 'win32') return;
	const marker = '__TEXPILE_PATH__';
	try {
		const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash');
		const out = execFileSync(shell, ['-ilc', `printf '${marker}%s${marker}' "$PATH"`], { encoding: 'utf8', timeout: 5000 });
		const m = out.match(new RegExp(`${marker}(.*)${marker}`));
		if (m && m[1]) process.env.PATH = m[1];
	} catch {
		/* fall back to appending the known dirs below */
	}
	// macOS has fixed TeX/Homebrew dirs worth guaranteeing; Linux TeX Live paths are
	// version-stamped, so the probe is all we have there
	if (process.platform === 'darwin') {
		const dirs = (process.env.PATH || '').split(':').filter(Boolean);
		for (const d of ['/Library/TeX/texbin', '/usr/local/bin', '/opt/homebrew/bin', '/opt/local/bin']) {
			if (!dirs.includes(d)) dirs.push(d);
		}
		process.env.PATH = dirs.join(':');
	}
}
fixShellPath();

// must run before app.whenReady(). `standard` gives real origin semantics (module workers
// need this), `supportFetchAPI` lets pdf.js fetch, `stream` avoids buffering whole PDFs.
//
// texfile:// also needs `corsEnabled`, because it is always a DIFFERENT ORIGIN from the page that
// fetches it - app://bundle when packaged, the vite server in dev. Older Chromium let the
// handler's Access-Control-Allow-Origin stand on its own; from Chromium 150 (Electron 43) a
// scheme that has not opted into CORS has its response headers ignored and the fetch rejects
// outright, which is the "Failed to fetch" the PDF pane shows in place of the document.
protocol.registerSchemesAsPrivileged([
	{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
	{ scheme: 'drawio', privileges: DRAWIO_PRIVILEGES },
	{ scheme: 'texfile', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }
]);

// a `standard` scheme enforces strict MIME checks on module scripts and worker imports,
// so text/javascript must be exact
const BUNDLE_MIME: Record<string, string> = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.mjs': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.gif': 'image/gif',
	'.webp': 'image/webp',
	'.ico': 'image/x-icon',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.otf': 'font/otf',
	'.wasm': 'application/wasm',
	'.map': 'application/json',
	'.txt': 'text/plain',
	'.pdf': 'application/pdf',
	'.wav': 'audio/wav'
};

function bundleDir(): string {
	return path.join(process.resourcesPath, 'app-dist');
}

function frontendDistDir(): string {
	return path.join(app.getAppPath(), 'apps', 'frontend', 'dist');
}

// Draft-mode engine .lua files. Shipped outside the asar via extraResources (see
// electron-builder.yml). In dev, __dirname is electron/dist, so the repo's electron/lua
// is one level up.
function luaDir(): string {
	return isDev ? path.join(__dirname, '..', 'lua') : path.join(process.resourcesPath, 'lua');
}

// CSP for the packaged renderer (dev loads from the vite server, which this doesn't touch). The
// strict script-src is the backstop for user-authored content: it cannot execute and therefore
// cannot reach the texfile:// read primitive. img-src omits remote hosts, which also kills any CSS
// url() beacon. The renderer has no production upstream service, so connect-src is local-only.
const RENDERER_CSP = [
	"default-src 'none'",
	"script-src 'self' 'wasm-unsafe-eval'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' texfile: blob: data:",
	"font-src 'self' data:",
	"connect-src 'self' texfile: blob: data:",
	"worker-src 'self' blob:",
	"child-src 'self' blob:",
	"media-src 'self' blob: data:",
	"object-src 'none'",
	"base-uri 'self'",
	// The Typst preview page, which we serve ourselves on loopback (see typst:preview:prepare). It
	// has to be an http://127.0.0.1 origin rather than a custom scheme, because tinymist's data
	// plane rejects websocket handshakes from any other origin. Still a separate origin from
	// app://bundle, so the framed page cannot reach this window's bridges.
	'frame-src drawio://bundle http://127.0.0.1:*',
	"frame-ancestors 'none'",
	"form-action 'self'"
].join('; ');

const FRONTEND_CSP = [
	"default-src 'none'",
	"script-src 'self' 'wasm-unsafe-eval'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' blob: data:",
	"font-src 'self' data:",
	"connect-src 'self' blob: data:",
	"worker-src 'self' blob:",
	"child-src 'self' blob:",
	"media-src 'self' blob: data:",
	"object-src 'none'",
	"base-uri 'self'",
	"frame-src 'none'",
	"frame-ancestors 'none'",
	"form-action 'self'"
].join('; ');

// stream a file (or a byte slice of it) as a fetch Response body without buffering it all.
// node's web ReadableStream type and the DOM lib's don't unify, but the runtime object does.
function fileStream(file: string, range?: { start: number; end: number }): ReadableStream {
	return Readable.toWeb(fs.createReadStream(file, range)) as unknown as ReadableStream;
}

// protocol.handle can't see which window sent the request, so the confinement is the union of
// live claimed roots. realpath both sides: a symlink inside the root must not escape it.
async function insideClaimedRoot(p: string): Promise<boolean> {
	let real: string;
	try {
		real = await fs.promises.realpath(p);
	} catch {
		return false; // missing file: the handler would 404 anyway
	}
	const n = normRoot(real);
	for (const r of windowRoots.values()) {
		if (!r) continue;
		try {
			const rn = normRoot(await fs.promises.realpath(r.raw));
			if (n === rn || n.startsWith(rn + path.sep)) return true;
		} catch {
			/* root vanished (unmounted drive): claim is dead, keep looking */
		}
	}
	return false;
}

function registerProtocolHandlers(): void {
	protocol.handle(
		'drawio',
		createDrawioHandler(drawioVendorRoot(app.isPackaged, process.resourcesPath, __dirname), path.join(__dirname, 'drawio-relay.js'), () => [
			...new Set(
				[...hostURLs.values()].map((raw) => {
					const url = new URL(raw);
					return `${url.protocol}//${url.host}`;
				})
			)
		])
	);
	protocol.handle('app', async (request) => {
		let url: URL;
		try {
			url = new URL(request.url);
		} catch {
			return new Response('Bad request', { status: 400 });
		}
		let root: string;
		let csp: string;
		if (url.host === 'bundle' && !url.port && !url.username && !url.password) {
			root = bundleDir();
			csp = RENDERER_CSP;
		} else if (
			url.host === 'frontend' &&
			!url.port &&
			!url.username &&
			!url.password &&
			!app.isPackaged &&
			useOriginalFrontend
		) {
			root = frontendDistDir();
			csp = FRONTEND_CSP;
		} else {
			return new Response('Forbidden', { status: 403 });
		}
		let rel: string;
		try {
			rel = decodeURIComponent(url.pathname);
		} catch {
			return new Response('Bad request', { status: 400 });
		}
		if (rel === '/' || rel === '') rel = '/index.html';
		const file = path.normalize(path.join(root, rel));
		// path traversal guard: resolved file must stay inside the bundle
		if (!file.startsWith(root + path.sep) && file !== root) {
			return new Response('Forbidden', { status: 403 });
		}
		try {
			const st = await fs.promises.stat(file);
			if (!st.isFile()) return new Response('Not found', { status: 404 });
			const mime = BUNDLE_MIME[path.extname(file).toLowerCase()] ??
				(url.host === 'bundle' ? 'application/octet-stream' : undefined);
			if (!mime) return new Response('Forbidden', { status: 403 });
			const headers: Record<string, string> = { 'Content-Type': mime, 'Content-Length': String(st.size) };
			// vite content-hashes everything under assets/ (name-XXXXXXXX.ext), so those bytes can
			// never change under their URL: cache forever. index.html & co keep stable names and
			// must revalidate on every load.
			if (rel.includes('/assets/') && /-[\w-]{8,}\.[a-z0-9]+$/i.test(rel)) {
				headers['Cache-Control'] = 'public, max-age=31536000, immutable';
			} else {
				headers['Cache-Control'] = 'no-cache';
				headers['Last-Modified'] = st.mtime.toUTCString();
			}
			// CSP is a document-level directive; attach it to the served HTML (ignored on subresources)
			if (mime === 'text/html') headers['Content-Security-Policy'] = csp;
			// big files (wasm, fonts) stream; small ones stay buffered, one readFile is cheaper
			if (st.size > 1_000_000) return new Response(fileStream(file), { headers });
			const data = await fs.promises.readFile(file);
			return new Response(new Uint8Array(data), { headers });
		} catch {
			return new Response('Not found', { status: 404 });
		}
	});

	protocol.handle('texfile', async (request) => {
		const url = new URL(request.url);
		const p = url.searchParams.get('path');
		if (!p) return new Response('Missing path', { status: 400 });
		// texfile:// is a different origin than app://bundle, so pdf.js's fetch needs CORS
		const cors = { 'Access-Control-Allow-Origin': '*' };
		// every request must land inside a claimed workspace root (VS Code's localResourceRoots):
		// nothing renderer-reachable may turn texfile:// into an arbitrary-file read primitive
		if (!(await insideClaimedRoot(p))) return new Response('Forbidden', { status: 403, headers: cors });
		try {
			const st = await fs.promises.stat(p);
			if (!st.isFile()) return new Response('Not found', { status: 404, headers: cors });
			const mime = fsService.MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
			const etag = `"${st.mtimeMs}-${st.size}"`;
			const base: Record<string, string> = {
				...cors,
				'Content-Type': mime,
				'Cache-Control': 'no-cache',
				'Accept-Ranges': 'bytes',
				ETag: etag,
				'Last-Modified': st.mtime.toUTCString()
			};
			// no-cache means "revalidate": a matching ETag turns a reload into a 304 with no body
			if (request.headers.get('if-none-match') === etag) {
				return new Response(null, { status: 304, headers: base });
			}
			// pdf.js fetches PDFs in ranged chunks; end is inclusive, `bytes=start-` means to EOF
			const m = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get('range') ?? '');
			if (m) {
				const start = Number(m[1]);
				const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
				if (start >= st.size || start > end) {
					return new Response(null, { status: 416, headers: { ...cors, 'Content-Range': `bytes */${st.size}` } });
				}
				return new Response(fileStream(p, { start, end }), {
					status: 206,
					headers: {
						...base,
						'Content-Length': String(end - start + 1),
						'Content-Range': `bytes ${start}-${end}/${st.size}`
					}
				});
			}
			return new Response(fileStream(p), { headers: { ...base, 'Content-Length': String(st.size) } });
		} catch {
			return new Response('Not found', { status: 404, headers: cors });
		}
	});
}

function chromeColors(): { height: number; color: string; symbolColor: string; background: string } {
	const s = readSettings();
	const hex = (v: unknown, fallback: string) => (typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : fallback);
	const h = Number(s.chromeHeight);
	return {
		height: Number.isFinite(h) && h > 0 ? h : 32,
		color: hex(s.chromeColor, '#ffffff'),
		symbolColor: hex(s.chromeSymbolColor, '#000000'),
		background: hex(s.chromeBackground, '#ffffff')
	};
}

function createWindow(url: string, pending?: PendingOpen): BrowserWindow {
	const win = new BrowserWindow({
		width: 1280,
		height: 860,
		// below this the panes clip each other and the toolbar overflows
		// 900 was set when the toolbars could only clip: every bar now collapses into its own "..."
		// instead, so a narrow window stays usable. The floor is the pane layout rather than the
		// chrome now - the sidebar's 180 minimum plus the editor's 360 reserve, plus window frame.
		minWidth: 700,
		minHeight: 600,
		title: 'ModuTeX',
		icon: path.join(__dirname, '..', 'icon.png'),
		backgroundColor: chromeColors().background,
		// Custom title bar (TitleBar.svelte). Frameless on Windows/Linux so the menus, the app icon
		// and the window buttons share one row instead of costing two - VS Code's layout, and the
		// reason its chrome is a third the height of ours was.
		//
		// macOS keeps a real frame: `hiddenInset` hides the title bar but leaves the traffic lights,
		// the double-click-to-zoom behaviour and the system menu bar, none of which a frameless
		// window can reproduce. There the menus live in the native bar instead (window-chrome.ts).
		//
		// Off macOS the buttons themselves are Chromium's, not ours: titleBarOverlay reserves a strip
		// at the end of our own title bar and draws minimise / maximise / close into it. Two reasons,
		// one per platform. On Linux the button set is a user setting (GNOME's button-layout,
		// gtk-decoration-layout) - which buttons exist and which side they sit on - and nothing in
		// Electron exposes it, so a hand-drawn set is wrong for anyone who changed it, and wrong by
		// default on stock GNOME, which shows close alone. On Windows 11 a real maximise button pops
		// the Snap Layouts picker on hover; buttons we draw ourselves do not, and that is a feature
		// silently missing today. The overlay restores it.
		//
		// The colours come from whatever the renderer last reported (windowOverlay.ts persists them
		// through registerWindowChrome). They cannot be derived here - the theme lives in
		// localStorage, which only the renderer can read - and Chromium paints the overlay before any
		// HTML exists, so without a remembered value the buttons spend the load in a pale strip on a
		// blank window. The light defaults are the genuine first run only.
		...(useOriginalFrontend ? { frame: true } : process.platform === 'darwin'
			? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 12, y: 10 } }
			: {
					// BOTH, and the pair is load-bearing. `frame: false` alone removes the standard
					// window controls outright, and titleBarOverlay has nothing left to draw - no
					// error, just no buttons. `titleBarStyle: 'hidden'` is what keeps them alive to
					// be overlaid.
					titleBarStyle: 'hidden' as const,
					frame: false,
					titleBarOverlay: {
						height: chromeColors().height,
						color: chromeColors().color,
						symbolColor: chromeColors().symbolColor
					}
				}),
		webPreferences: {
			preload: path.join(__dirname, 'preload.js'),
			contextIsolation: true,
			nodeIntegration: false,
			// explicit (it IS the default): the preload/bridges must never reach any subframe;
			// the renderer CSP forbids frames entirely (frame-src 'none'), this backs that up
			nodeIntegrationInSubFrames: false,
			// Always available, packaged or not, reached through Help > Toggle Developer Tools. No key
			// binding anywhere: a writer must never open a debugger by fumbling a shortcut mid-sentence.
			devTools: true
		}
	});
	// capture now: webContents is gone by the time 'closed' fires
	const wcId = win.webContents.id;
	watchWindowState(win); // feeds the title bar's maximise / restore state
	windowRoots.set(wcId, null);
	if (pending) pendingOpens.set(wcId, pending);
	hostURLs.set(wcId, url);
	win.webContents.on('did-start-navigation', (details) => {
		if (!details.isMainFrame || details.isSameDocument) return;
		invalidateDiagramOwner(wcId);
		windowRoots.set(wcId, null);
		stopWorkspaceWatch(String(wcId));
	});
	win.webContents.once('destroyed', () => {
		invalidateDiagramOwner(wcId);
		diagramGenerations.delete(wcId);
	});
	win.webContents.on('render-process-gone', () => { frontendCompiler?.cancelOwner(wcId); managedCompile?.cancelOwner(wcId); });
	installDrawioNavigationGuard(win.webContents, () => drawioWindowContext(wcId)!);
	win.loadURL(url);
	win.webContents.on('did-finish-load', () => {
		// restore the saved whole-window zoom before the first paint the user sees
		const z = Number(readSettings().uiZoom);
		if (Number.isFinite(z) && z > 0) win.webContents.setZoomFactor(z);
		const p = pendingOpens.get(wcId);
		if (p) {
			pendingOpens.delete(wcId);
			win.webContents.send(p.kind === 'file' ? 'main:open-path' : 'main:open-folder', p.path);
		}
	});
	// Popup details have no initiating frame in Electron 43.5. The shared guard
	// denies every popup instead of exposing an external-browser escape to Draw.io.
	// hold the close so the renderer can flush (autosave's 1.5s debounce) or prompt for unsaved
	// edits; the timeout guarantees a hung renderer can never make the window unclosable
	let closeReady = false;
	win.on('close', (e) => {
		if (closeReady) return;
		if (!windowRoots.get(wcId)) return; // no claimed folder (start screen): nothing to flush
		e.preventDefault();
		// already held (double X-click, quit racing a click): keep the FIRST hold's timer — a
		// second arm would orphan it and the orphan force-closes through the renderer's modal
		if (pendingCloses.has(wcId)) return;
		win.webContents.send('app:before-close');
		const t = setTimeout(() => {
			pendingCloses.delete(wcId);
			closeReady = true;
			if (!win.isDestroyed()) win.close();
		}, 2000);
		pendingCloses.set(wcId, {
			settle: (proceed) => {
				clearTimeout(t);
				if (proceed) {
					closeReady = true;
					if (!win.isDestroyed()) win.close();
				} else if (quitting) {
					quitting = false; // an aborted quit must un-freeze the openFolders snapshot
					persistOpenFolders(); // and re-sync it (windows may have closed before the cancel)
				}
			}
		});
	});
	win.on('closed', () => {
		frontendFiles.delete(wcId);
		frontendPickers.delete(wcId);
		invalidateDiagramOwner(wcId);
		diagramGenerations.delete(wcId);
		hostURLs.delete(wcId);
		preparedDataPlanes.delete(wcId);
		windowRoots.delete(wcId);
		stopWorkspaceWatch(String(wcId));
		pendingOpens.delete(wcId);
		pendingCloses.delete(wcId);
		forgetWindow(wcId); // or a dead window keeps answering get_editor_state
		forgetWindowChrome(wcId); // and hand the macOS menu bar to whichever window is left
		// the closing window owned the warm engine: stop it so it doesn't hold memory orphaned
		if (draftOwner?.wcId === wcId) {
			draftDaemon.stopDaemon();
			draftOwner = null;
		}
		// last window closing means "quit" on win/linux: keep the snapshot for next launch
		if (BrowserWindow.getAllWindows().length > 0) persistOpenFolders();
		// the close hold cancelled the original quit; once every window has agreed, finish it
		// (macOS otherwise stays running with quitting latched and a frozen snapshot)
		else if (quitting) app.quit();
	});
	return win;
}

function startUrl(): string {
	if (isFrontendDev) return FRONTEND_DEVELOPMENT_URL;
	if (isFrontendBuilt) {
		const distIndex = path.join(frontendDistDir(), 'index.html');
		if (!fs.existsSync(distIndex)) {
			throw new Error(`Built frontend index not found at ${distIndex}. Run "npm run frontend:build" before launching.`);
		}
		return FRONTEND_BUILT_URL;
	}
	if (isDev) return process.env.ELECTRON_START_URL || 'http://127.0.0.1:5173';
	return 'app://bundle/index.html';
}

// Narrow original-renderer bridge. Each verb rechecks the owner after asynchronous work.
const frontendErrors = new Set(['BAD_SELECTION', 'BAD_FILE', 'STALE_WORKSPACE', 'LINK_NOT_ALLOWED', 'OUTSIDE_WORKSPACE',
	'FILE_TYPE', 'FILE_TOO_LARGE', 'FILE_CHANGED', 'FILE_CONFLICT', 'ENGINE_UNAVAILABLE', 'TREE_TOO_DEEP', 'TREE_TOO_LARGE', 'BUSY', 'FORBIDDEN', 'RECENT_CORRUPT', 'RECENT_NOT_FOUND']);
function handleFrontendFiles(channel: string, action: (event: Electron.IpcMainInvokeEvent, args: unknown[]) => Promise<unknown>) {
	ipcMain.handle(channel, async (event, ...args: unknown[]) => {
		try {
			if (!isFrontendHost(event)) throw new Error('FORBIDDEN');
			const value = await action(event, args);
			if (!isFrontendHost(event)) throw new Error('FORBIDDEN');
			return { ok: true, value };
		} catch (error) {
			const code = error instanceof Error ? error.message : '';
			return { ok: false, error: frontendErrors.has(code) ? code : 'FILE_OPERATION_FAILED' };
		}
	});
}
function filesFor(id: number): FrontendFiles {
	let files = frontendFiles.get(id);
	if (!files) { files = new FrontendFiles(); frontendFiles.set(id, files); }
	return files;
}
function frontendWatchSubscriptionId(value: unknown): string {
	if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('BAD_FILE');
	return value;
}
function frontendWatchRequest(value: unknown): { workspaceId: string; subscriptionId: string } {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BAD_FILE');
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Reflect.ownKeys(value).length !== 2 ||
		!('value' in (descriptors.workspaceId ?? {})) ||
		!('value' in (descriptors.subscriptionId ?? {}))) throw new Error('BAD_FILE');
	const workspaceId = descriptors.workspaceId!.value;
	if (typeof workspaceId !== 'string' || !workspaceId || workspaceId.length > 128) throw new Error('BAD_FILE');
	return { workspaceId, subscriptionId: frontendWatchSubscriptionId(descriptors.subscriptionId!.value) };
}
function forgetFrontendWatch(id: number, subscriptionId: string, watcher: FrontendWatch): boolean {
	const watches = frontendWatches.get(id);
	if (watches?.get(subscriptionId)?.watcher !== watcher) return false;
	watches.delete(subscriptionId);
	if (!watches.size) frontendWatches.delete(id);
	return true;
}
handleFrontendFiles('frontend:open', async (event, args) => {
	if (args.length !== 1 || (args[0] !== 'file' && args[0] !== 'folder')) throw new Error('BAD_SELECTION');
	const id = event.sender.id;
	if (frontendPickers.has(id)) throw new Error('BUSY');
	frontendPickers.add(id);
	const files = filesFor(id);
	try {
		const result = await dialog.showOpenDialog(windowFor(id)!, {
			title: args[0] === 'file' ? '開啟 TeX 文件' : '開啟工作區',
			properties: args[0] === 'file' ? ['openFile'] : ['openDirectory'],
			...(args[0] === 'file' ? { filters: [{ name: 'LaTeX', extensions: ['tex'] }] } : {})
		});
		if (!isFrontendHost(event) || frontendFiles.get(id) !== files) throw new Error('STALE_WORKSPACE');
		if (result.canceled || !result.filePaths[0]) return null;
		stopFrontendWatches(id, true);
		frontendCompiler?.cancelOwner(id);
		const info = await files.open(result.filePaths[0], args[0]);
		if (!isFrontendHost(event) || frontendFiles.get(id) !== files) { files.close(); throw new Error('STALE_WORKSPACE'); }
		// A history write failure must not turn successful native open into failure.
		await recentFiles().remember(result.filePaths[0], args[0]).catch(() => {});
		return info;
	} finally { frontendPickers.delete(id); }
});
handleFrontendFiles('frontend:recent:list', async (_event, args) => {
	if (args.length !== 1 || args[0] !== null) throw new Error('BAD_FILE');
	return recentFiles().list();
});
handleFrontendFiles('frontend:recent:remove', async (_event, args) => {
	if (args.length !== 1 || typeof args[0] !== 'string') throw new Error('RECENT_NOT_FOUND');
	await recentFiles().remove(args[0]);
});
handleFrontendFiles('frontend:recent:open', async (event, args) => {
	if (args.length !== 1 || typeof args[0] !== 'string') throw new Error('RECENT_NOT_FOUND');
	const id = event.sender.id;
	if (frontendPickers.has(id)) throw new Error('BUSY');
	frontendPickers.add(id);
	const files = filesFor(id);
	try {
		const selected = await recentFiles().resolve(args[0]);
		if (!isFrontendHost(event) || frontendFiles.get(id) !== files) throw new Error('STALE_WORKSPACE');
		stopFrontendWatches(id, true);
		frontendCompiler?.cancelOwner(id);
		const info = await files.open(selected.selected, selected.kind);
		if (!isFrontendHost(event) || frontendFiles.get(id) !== files) { files.close(); throw new Error('STALE_WORKSPACE'); }
		await recentFiles().remember(selected.selected, selected.kind).catch(() => {});
		return info;
	} finally { frontendPickers.delete(id); }
});
handleFrontendFiles('frontend:list', (event, args) => {
	if (args.length !== 1) throw new Error('BAD_FILE');
	return filesFor(event.sender.id).list(args[0]);
});
handleFrontendFiles('frontend:read', (event, args) => {
	if (args.length !== 1) throw new Error('BAD_FILE');
	return filesFor(event.sender.id).read(args[0]);
});
handleFrontendFiles('frontend:write', (event, args) => {
	if (args.length !== 1) throw new Error('BAD_FILE');
	frontendCompiler?.cancelOwner(event.sender.id);
	return filesFor(event.sender.id).write(args[0]);
});
handleFrontendFiles('frontend:close', async (event, args) => {
	if (args.length !== 1 || typeof args[0] !== 'string') throw new Error('BAD_FILE');
	frontendCompiler?.cancelOwner(event.sender.id);
	stopFrontendWatches(event.sender.id);
	filesFor(event.sender.id).close(args[0]);
});

handleFrontendFiles('frontend:watch:start', async (event, args) => {
	if (args.length !== 1) throw new Error('BAD_FILE');
	const { workspaceId, subscriptionId } = frontendWatchRequest(args[0]);
	const id = event.sender.id;
	let subscriptions = frontendWatches.get(id);
	if (subscriptions?.size) throw new Error('BUSY');
	const files = filesFor(id);
	const assertWorkspace = files.saveAsOwner(workspaceId);
	const owner = files.compileOwner();
	subscriptions ??= new Map<string, { workspaceId: string; watcher: FrontendWatch }>();
	frontendWatches.set(id, subscriptions);
	let watcher!: FrontendWatch;
	const assertWatchOwner = () => {
		if (!isFrontendHost(event) || frontendFiles.get(id) !== files ||
			frontendWatches.get(id) !== subscriptions ||
			subscriptions.get(subscriptionId)?.watcher !== watcher) throw new Error('STALE_WORKSPACE');
		assertWorkspace();
		owner.assertCurrent();
	};
	watcher = new FrontendWatch({
		root: owner.root,
		workspaceId,
		assertCurrent: assertWatchOwner,
		emit(fileEvent) {
			assertWatchOwner();
			if (event.sender.isDestroyed()) throw new Error('STALE_WORKSPACE');
			event.sender.send('frontend:watch:event', { subscriptionId, event: fileEvent });
		},
		onError(error) {
			if (!forgetFrontendWatch(id, subscriptionId, watcher)) return;
			if (isFrontendHost(event) && !event.sender.isDestroyed()) {
				event.sender.send('frontend:watch:error', { subscriptionId, error });
			}
		}
	});
	subscriptions.set(subscriptionId, { workspaceId, watcher });
	try {
		await watcher.start();
		assertWatchOwner();
		return null;
	} catch (error) {
		forgetFrontendWatch(id, subscriptionId, watcher);
		watcher.stop();
		throw error;
	}
});

handleFrontendFiles('frontend:watch:stop', async (event, args) => {
	if (args.length !== 1) throw new Error('BAD_FILE');
	const subscriptionId = frontendWatchSubscriptionId(args[0]);
	const watcher = frontendWatches.get(event.sender.id)?.get(subscriptionId)?.watcher;
	if (watcher) {
		forgetFrontendWatch(event.sender.id, subscriptionId, watcher);
		watcher.stop();
	}
	return null;
});

handleFrontendFiles('frontend:save-as', async (event, args) => {
	if (args.length !== 1) throw new Error('BAD_FILE');
	const request = (await import('@modutex/frontend-contracts')).parseSaveAsRequest(args[0], 5 * 1024 * 1024);
	const id = event.sender.id;
	if (frontendPickers.has(id)) throw new Error('BUSY');
	frontendPickers.add(id);
	try {
		const files = filesFor(id);
		const assertOwner = files.saveAsOwner(request.workspaceId);
		assertOwner();
		const result = await dialog.showSaveDialog(windowFor(id)!, { title: '另存 TeX 文件', defaultPath: 'document.tex',
			filters: [{ name: 'LaTeX', extensions: ['tex'] }], properties: ['showOverwriteConfirmation'] });
		if (!isFrontendHost(event) || frontendFiles.get(id) !== files) throw new Error('STALE_WORKSPACE');
		assertOwner();
		if (result.canceled || !result.filePath) return null;
		frontendCompiler?.cancelOwner(id);
		stopFrontendWatches(id, true);
		const receipt = await files.saveAs(result.filePath, request, assertOwner);
		await recentFiles().remember(result.filePath, 'file').catch(() => {});
		return receipt;
	} finally { frontendPickers.delete(id); }
});

handleFrontendFiles('frontend:compile:start', (event, args) => {
	if (args.length !== 1 || !frontendCompiler) throw new Error('ENGINE_UNAVAILABLE');
	return frontendCompiler.start(event, event.sender.id, args[0]);
});
handleFrontendFiles('frontend:compile:result', (event, args) => {
	if (args.length !== 1 || !frontendCompiler) throw new Error('BAD_FILE');
	return frontendCompiler.result(event.sender.id, args[0]);
});
handleFrontendFiles('frontend:compile:cancel', async (event, args) => {
	if (args.length !== 1 || !frontendCompiler) throw new Error('BAD_FILE');
	await frontendCompiler.cancel(event.sender.id, args[0]);
});

ipcMain.handle('dialog:openFolder', async (e) => {
	const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) ?? undefined!, {
		title: 'Open Folder',
		// createDirectory is macOS-only and off by default: without it NSOpenPanel has no New Folder
		// button, so "create new project" and the tutorial (both of which want an EMPTY folder) were
		// impossible without going to Finder first. Ignored on Windows/Linux, which already allow it.
		properties: ['openDirectory', 'createDirectory']
	});
	return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
});

// failures come back as { ok: false, error } instead of rejecting: a rejected handler makes
// Electron dump a stack trace to the main-process console, and some failures here are routine
type FsResult = { ok: true; value: unknown } | { ok: false; error: string };
function handleFs(channel: string, fn: (...args: never[]) => Promise<unknown>): void {
	ipcMain.handle(channel, async (_e, ...args: unknown[]): Promise<FsResult> => {
		try {
			return { ok: true, value: await (fn as (...a: unknown[]) => Promise<unknown>)(...args) };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
}
// like handleFs, for handlers that need the sender (dialog parenting, draft-engine ownership)
function handleFsE(channel: string, fn: (e: Electron.IpcMainInvokeEvent, ...args: never[]) => Promise<unknown>): void {
	ipcMain.handle(channel, async (e, ...args: unknown[]): Promise<FsResult> => {
		try {
			return { ok: true, value: await (fn as (e: Electron.IpcMainInvokeEvent, ...a: unknown[]) => Promise<unknown>)(e, ...args) };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	});
}
handleFs('fs:scan', fsService.scan);
handleFs('fs:read', fsService.read);
handleFs('fs:write', fsService.write);
handleFs('fs:writeBinary', fsService.writeBinary);
handleFs('fs:tree', fsService.tree);
handleFs('fs:treeScan', fsService.treeScan);
handleFs('fs:op', fsService.op);
handleFs('fs:search', fsService.search);
handleFs('fs:stat', fsService.statFile);
handleFs('fs:formatLatex', fsService.formatLatex);
// Reveal a file in the OS file manager. showItemInFolder SELECTS the item in a browser window and
// nothing more - deliberately not shell.openPath, which hands the path to the OS to open with
// whatever is registered for it, and so would turn a tree row into an execution surface.
ipcMain.handle('shell:revealItem', (_e, p: string) => {
	if (typeof p !== 'string' || !p) return { ok: false };
	shell.showItemInFolder(p);
	return { ok: true };
});
/**
 * Where a workspace's undo backups live: under the app's OWN data directory, never inside the
 * project. Namespaced per folder so opening one workspace cannot discard the undo history of a
 * folder another window still has open.
 */
function undoDir(root: string): string {
	const key = createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16);
	return path.join(app.getPath('userData'), 'undo', key);
}
/** Above this, a delete is not made undoable. The backup is a real copy (it crosses volumes), so
 *  the limit is what stops deleting a build directory from duplicating it first. */
const UNDO_MAX_BYTES = 64 * 1024 * 1024;

// The undoable delete. Copy the entry somewhere recoverable when it is small enough, then send the
// original to the OS recycle bin rather than unlinking it - so even a delete too large to undo in
// the editor is still recoverable by the user from their file manager. A null `backup` is how the
// renderer learns not to offer undo for this one.
handleFs('fs:trash', async (body: { path: string; root: string }) => {
	const backup = await fsService.backupForUndo(body.path, undoDir(body.root), UNDO_MAX_BYTES);
	let recycled = true;
	try {
		await shell.trashItem(body.path);
	} catch {
		// Network shares, and Linux boxes with no trash implementation, have nowhere to put it. The
		// file still has to go, so it is unlinked - but the caller is TOLD, because "it is in your
		// recycle bin" is the one thing we must not claim when it is not. With no backup either,
		// this is the only path in the app that destroys something outright.
		recycled = false;
		await fsService.op({ action: 'delete', path: body.path });
	}
	return { backup, recycled };
});

// Drop a folder's backups. Called when that workspace is opened: the undo stack that could reach
// them is memory-only, so anything left from a previous session is already unreachable.
handleFs('fs:purgeUndo', async (root: string) => {
	await fsService.op({ action: 'delete', path: undoDir(root) });
	return { ok: true };
});
handleFs('synctex:call', fsService.synctex);
// One live preview at a time: the warm engine (and its reconcile compiles) belong to one
// window. A second window asking gets a clean 'engine-busy' value instead of silently
// thrashing the daemon between roots; its DraftView offers an explicit takeover.
let draftOwner: { wcId: number; root: string } | null = null;
function draftBusy(e: Electron.IpcMainInvokeEvent, root: string): boolean {
	if (!draftOwner) return false;
	if (draftOwner.wcId === e.sender.id) return false;
	if (normRoot(draftOwner.root) === normRoot(root)) return false;
	if (!windowFor(draftOwner.wcId)) {
		draftOwner = null; // owner window is gone; the engine is free
		return false;
	}
	return true;
}
handleFsE('draft:compile', async (e, body: { root: string; mainFile: string }) => {
	if (draftBusy(e, body.root)) return { ok: false, error: 'engine-busy', ms: 0 };
	draftOwner = { wcId: e.sender.id, root: body.root };
	return draftService.compileDraft({ ...body, engineDir: luaDir() });
});
handleFsE('draft:typeset', async (e, body: { root: string; mainFile: string; text: string; hsize?: number }) => {
	if (draftBusy(e, body.root)) return { ok: false, error: 'engine-busy' };
	draftOwner = { wcId: e.sender.id, root: body.root };
	return draftDaemon.typesetParagraph({ ...body, engineDir: luaDir() });
});
// stop the warm engine when draft mode is switched off / the preview closes, so we don't
// leave an idle lualatex process holding memory for the rest of the session. Only the
// owner may stop it: another window closing its (blocked) preview must not kill ours.
handleFsE('draft:stop', async (e) => {
	if (!draftOwner || draftOwner.wcId === e.sender.id) {
		draftDaemon.stopDaemon();
		draftOwner = null;
	}
	return { ok: true };
});
// explicit user action from the blocked window's DraftView: steal the engine
handleFsE('draft:takeover', async (e, body: { root: string }) => {
	// tell the window LOSING the engine to pause right away; without this it only finds
	// out on its next keystroke and shows a stale "engine ready" state until then
	if (draftOwner && draftOwner.wcId !== e.sender.id) {
		const prev = windowFor(draftOwner.wcId);
		if (prev && !prev.webContents.isDestroyed()) prev.webContents.send('draft:preempted', { root: draftOwner.root });
	}
	draftDaemon.stopDaemon();
	draftOwner = { wcId: e.sender.id, root: body.root };
	return { ok: true };
});
// save the reconcile PDF (the document the live preview mirrors) where the user picks;
// `to` skips the dialog (tests)
handleFsE('draft:savePdf', async (e, body: { root: string; defaultName: string; to?: string }) => {
	const src = path.join(body.root, '_draft', 'draft.pdf');
	if (!fs.existsSync(src)) throw new Error('No compiled PDF yet.');
	let dest = body.to;
	if (!dest) {
		const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender) ?? undefined!, {
			title: 'Save PDF',
			defaultPath: path.join(body.root, body.defaultName),
			filters: [{ name: 'PDF', extensions: ['pdf'] }]
		});
		if (res.canceled || !res.filePath) return { saved: false };
		dest = res.filePath;
	}
	fs.copyFileSync(src, dest);
	return { saved: true, path: dest };
});
// Save an already-produced PDF where the user picks - the Typst preview's Save as PDF goes
// through here. Generic on the SOURCE (draft:savePdf above hardcodes the draft engine's staging
// file) but still PDF-only: the dialog is the user's consent to the destination, not the source.
handleFsE('shell:savePdfAs', async (e, body: { src: string; defaultPath: string; to?: string }) => {
	if (typeof body?.src !== 'string' || !/\.pdf$/i.test(body.src) || !fs.existsSync(body.src)) {
		throw new Error('No compiled PDF yet.');
	}
	let dest = body.to;
	if (!dest) {
		const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(e.sender) ?? undefined!, {
			title: 'Save PDF',
			defaultPath: body.defaultPath,
			filters: [{ name: 'PDF', extensions: ['pdf'] }]
		});
		if (res.canceled || !res.filePath) return { saved: false };
		dest = res.filePath;
	}
	fs.copyFileSync(body.src, dest);
	return { saved: true, path: dest };
});
handleFs('git:status', gitService.gitStatus);
handleFs('git:show', gitService.gitShowHead);
handleFs('git:init', gitService.gitInit);
handleFs('git:stage', gitService.gitStage);
handleFs('git:unstage', gitService.gitUnstage);
handleFs('git:discard', gitService.gitDiscard);
handleFs('git:commit', gitService.gitCommit);
handleFs('git:userName', gitService.gitUserName);

const DEFAULT_SETTINGS = {
	reopenLastFolder: true,
	autosave: true, // off = manual save, warn before switching files
	lastFolder: null as string | null,
	sidebarOpen: true,
	sidebarWidth: 256,
	spellcheck: false,
	dictionary: [] as string[], // spell-check ignore list
	tocFraction: 0.5, // table-of-contents share of the sidebar height (0..1)
	compileCommand: 'latexmk -lualatex -synctex=1 -output-directory=output {main}', // {main} = main file
	compileEngine: 'tectonic',
	compileSentinel: true, // append a marker echo after the compile command to detect completion
	terminalVisible: false,
	terminalHeight: 240,
	pdfPaneWidth: 480,
	pdfPaneOpen: false,
	pdfDarkPages: true, // in dark mode, render PDF pages inverted
	draftMode: false, // preview via the incremental per-page engine instead of the terminal command
	commentAuthor: '', // name on review comments; blank falls back to the repo's git user.name
	uiZoom: 1, // whole-window zoom factor (webContents.setZoomFactor); the View menu adjusts it
	mathPreview: true, // live math preview tooltip in source mode
	sourceLineWrap: true, // soft-wrap long lines in Source mode
	visualMaxWidth: 768, // widest the visual editor's text column may grow, in px
	// Recompile a Typst document once typing settles. On by default: a warm rebuild is ~230ms, so
	// unlike LaTeX's live mode there is no cost that would justify making the user ask for it.
	typstLiveMode: true,
	typstPreviewFollow: false,

	editorKeymap: 'default', // modal keybindings for the source editor: 'default' | 'vim' | 'emacs'
	uiLocale: 'en', // UI display language, not the LaTeX document language. Overridden per-read by
	// the detected system language until the user picks one; see systemUiLocale + readSettings.
	// Let an MCP client (Claude Code, Claude Desktop) see what the editor is showing. Off by
	// default: connecting also requires pasting a config snippet into the client, so defaulting this
	// on would open a loopback port for everyone while buying nothing until they act anyway.
	mcpEnabled: false,
	// Whether a connected client may rewrite the compile command, which is a shell command line and
	// so amounts to running anything this user can. A separate permission from mcpEnabled, and off
	// even when that is on; retargeting only the output DIRECTORY does not need it.
	mcpAllowCompileCommand: false,
	// 0 = use the channel default (mcp.PORT_DEFAULT / PORT_DEFAULT_DEV). Fixed rather than
	// ephemeral so a client config keeps working across restarts; overridable for a port clash.
	mcpPort: 0,
	openFolders: [] as string[] // folders open across windows; maintained here for session restore
};

// The UI languages we ship. Anything else, or a failed probe, falls back to English.
type UiLocale = 'en' | 'de' | 'zh-Hans' | 'zh-Hant';
let cachedLocale: UiLocale | null = null;
/** first-run UI language from the OS. A stored uiLocale always wins (readSettings' merge order),
 *  so a deliberate choice is never overridden on a later launch. */
function systemUiLocale(): UiLocale {
	if (cachedLocale) return cachedLocale;
	let tags: string[] = [];
	try {
		// preferred-languages is in OS preference order; getLocale is the single-value fallback
		tags = app.getPreferredSystemLanguages?.() ?? [];
		if (!tags.length) tags = [app.getLocale()];
	} catch {
		/* both throw before app-ready on some platforms; stay unset and retry on the next read */
	}
	if (!tags.length) return 'en'; // uncached: this was a failed probe, not a real answer
	for (const raw of tags) {
		const tag = raw.toLowerCase();
		if (tag.startsWith('de')) return (cachedLocale = 'de');
		// an explicit script subtag wins over region: zh-Hans-HK is Simplified despite the HK region.
		// Only when no script is present do TW/HK/MO imply Traditional; everything else is Simplified.
		if (tag.startsWith('zh')) {
			const hant = /hant/.test(tag) || (!/hans/.test(tag) && /-(tw|hk|mo)\b/.test(tag));
			return (cachedLocale = hant ? 'zh-Hant' : 'zh-Hans');
		}
		if (tag.startsWith('en')) return (cachedLocale = 'en');
		// unsupported language: keep looking, the user's next preference may be one we ship
	}
	return (cachedLocale = 'en');
}

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function storedSettings(): Record<string, unknown> {
	try {
		// tolerate a UTF-8 BOM (an externally-edited file): JSON.parse rejects it, and the silent
		// catch below would then reset EVERY setting to defaults
		return JSON.parse(fs.readFileSync(settingsFile(), 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
	} catch {
		return {}; // no file yet (genuine first run) or unreadable: fall back to defaults + detection
	}
}
function currentSettings(values: Record<string, unknown>): Record<string, unknown> {
	return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((key) => [key, values[key]]));
}
function readSettings(): Record<string, unknown> {
	// detected system language fills in only until a stored/chosen uiLocale wins (spread order)
	const stored = storedSettings();
	const compileEngine =
		stored.compileEngine === 'system' || stored.compileEngine === 'tectonic'
			? stored.compileEngine
			: typeof stored.compileCommand === 'string' && stored.compileCommand !== DEFAULT_SETTINGS.compileCommand
				? 'system'
				: 'tectonic';
	return currentSettings({ ...DEFAULT_SETTINGS, uiLocale: systemUiLocale(), ...stored, compileEngine });
}
function writeSettings(partial: Record<string, unknown> | undefined): Record<string, unknown> {
	const stored = storedSettings();
	const next = currentSettings({ ...readSettings(), ...stored, ...(partial || {}) });
	// never freeze the auto-detected language into the file: only a previously stored value or a
	// deliberate change (uiLocale in `partial`, from Preferences) persists, so an incidental write
	// like remembering open folders won't stop the app from following the OS language.
	if (!('uiLocale' in stored) && !(partial && 'uiLocale' in partial)) delete next.uiLocale;
	try {
		fs.writeFileSync(settingsFile(), JSON.stringify(next, null, 2));
	} catch (e) {
		console.error('Failed to write settings:', e);
	}
	// hand back the effective settings (with detection applied) so callers see a complete object
	return { ...DEFAULT_SETTINGS, uiLocale: systemUiLocale(), ...next };
}
ipcMain.handle('settings:get', () => readSettings());
ipcMain.handle('settings:set', (_e, partial: Record<string, unknown>) => writeSettings(partial));

// --- Typst / tinymist -------------------------------------------------------
// One language server per window: each window has its own folder, and tinymist's project model is
// rooted at one workspace. Keyed by webContents id so closing one window can't kill another's.
const typstLsps = new Map<number, typstService.LspHandle>();

ipcMain.handle('typst:resolve', () => typstService.resolveTinymist(app.getPath('userData')));

// "which of the programs we shell out to are actually here" - see toolchain.ts. tinymist is not in
// that list because typst:resolve already answers for it, and with more detail (it reports the
// embedded Typst version and which location won).
ipcMain.handle('toolchain:probe', () => toolchain.probeToolchain());

ipcMain.handle('typst:lsp:start', async (e, root: string | null) => {
	const wcId = e.sender.id;
	typstLsps.get(wcId)?.stop();
	typstLsps.delete(wcId);
	const info = await typstService.resolveTinymist(app.getPath('userData'));
	if (!info) return { ok: false, error: 'tinymist was not found on PATH.' };
	try {
		const handle = typstService.startLsp(info.command, root, {
			message: (json) => {
				if (!e.sender.isDestroyed()) e.sender.send('typst:lsp:message', json);
			},
			exit: (code) => {
				typstLsps.delete(wcId);
				if (!e.sender.isDestroyed()) e.sender.send('typst:lsp:exit', code);
			}
		});
		typstLsps.set(wcId, handle);
		// a closed window can no longer release its own server, and the process holds ~90MB
		e.sender.once('destroyed', () => {
			typstLsps.get(wcId)?.stop();
			typstLsps.delete(wcId);
		});
		return { ok: true, info };
	} catch (err) {
		return { ok: false, error: String(err instanceof Error ? err.message : err) };
	}
});

/**
 * Run a Typst compile OUTSIDE the terminal dock.
 *
 * Live preview recompiles every time typing pauses, and routing that through the shell the user can
 * see would fill it with a command per second. The command string is the same one the terminal
 * would have run - it comes from the folder's own compile settings, which the user owns - and it
 * goes through a shell so its `2>out/main.log` redirect still lands where the log watcher looks.
 */
// --- Typst live preview -----------------------------------------------------
// The renderer starts the preview through the language server; here we fetch the page tinymist
// serves for it, prepare it (see typst-preview-page.ts) and re-serve it, which the pane then frames.
//
// Why re-serve instead of framing tinymist's origin directly: served by us, we can theme the page
// and open a postMessage bridge to it.
// Served over LOOPBACK HTTP, not from a custom scheme, and that is forced on us rather than chosen.
// tinymist's data plane validates the Origin header of every websocket handshake (its own
// tool/preview/http.rs, guarding a localhost server against other pages on the machine). It accepts
// its own origin, `vscode-webview://…`, and anything on `http://127.0.0.1` or `http://localhost`.
// A page served from a custom scheme sends `typstpreview://…`, gets rejected, and the socket closes
// with 1006 - so the ONE way to serve a modified copy of their page and still let it connect is to
// serve it from a loopback http origin.
//
// Note this also rules out our own renderer connecting directly in a packaged build, where the
// origin would be `app://bundle`.
const preparedPages = new Map<number, string>();
const hostURLs = new Map<number, string>();
const preparedDataPlanes = new Map<number, string>();
function drawioWindowContext(id: number) {
	const mainURL = hostURLs.get(id);
	if (!mainURL) return undefined;
	return {
		mainURL,
		previewURL: preparedPages.has(id) && pageServerPort ? `http://127.0.0.1:${pageServerPort}/${id}` : undefined,
		dataPlaneOrigin: preparedDataPlanes.get(id),
		matchesHostURL: useOriginalFrontend ? matchesFrontendHostURL : matchesDiagramHostURL
	};
}
let pageServer: import('node:http').Server | null = null;
let pageServerPort = 0;

async function ensurePageServer(): Promise<number> {
	if (pageServer && pageServerPort) return pageServerPort;
	const http = await import('node:http');
	return new Promise<number>((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const id = Number((req.url ?? '').replace(/^\/+/, '').split('?')[0]);
			const page = preparedPages.get(id);
			if (!page) {
				res.writeHead(404, { 'Content-Type': 'text/plain' });
				res.end('No preview prepared');
				return;
			}
			res.writeHead(200, {
				'Content-Type': 'text/html; charset=utf-8',
				'Cache-Control': 'no-store',
				// the page needs its inlined wasm and a socket to tinymist, and nothing else
				'Content-Security-Policy': [
					"default-src 'none'",
					"script-src 'unsafe-inline' 'wasm-unsafe-eval' data:",
					"style-src 'unsafe-inline'",
					'img-src data: blob:',
					'font-src data:',
					'connect-src ws://127.0.0.1:* http://127.0.0.1:* data: blob:',
					"frame-src 'none'",
					"object-src 'none'",
					"base-uri 'none'",
					"form-action 'none'"
				].join('; ')
			});
			res.end(page);
		});
		server.on('error', reject);
		// 127.0.0.1 explicitly, never 0.0.0.0: this must not be reachable from the network
		server.listen(0, '127.0.0.1', () => {
			pageServer = server;
			pageServerPort = (server.address() as import('node:net').AddressInfo).port;
			resolve(pageServerPort);
		});
	});
}

ipcMain.handle('typst:preview:prepare', async (e, body: { host: string; background: string; foreground: string }) => {
	if (e.senderFrame !== e.sender.mainFrame) return { ok: false, error: 'refusing a non-main preview owner' };
	// only ever tinymist's loopback preview server, never an address from anywhere else
	if (!/^127\.0\.0\.1:\d+$/.test(body?.host ?? '')) return { ok: false, error: 'refusing a non-loopback preview host' };
	try {
		const res = await fetch(`http://${body.host}/`, { signal: AbortSignal.timeout(15000) });
		if (!res.ok) return { ok: false, error: `preview server answered ${res.status}` };
		const page = typstPreviewPage.preparePreviewPage(await res.text(), {
			dataPlaneHost: body.host,
			background: cssColour(body.background),
			foreground: cssColour(body.foreground)
		});
		preparedPages.set(e.sender.id, page);
		preparedDataPlanes.set(e.sender.id, `http://${body.host}`);
		e.sender.once('destroyed', () => {
			preparedPages.delete(e.sender.id);
			preparedDataPlanes.delete(e.sender.id);
		});
		const port = await ensurePageServer();
		// one page per window, so the id keeps windows from seeing each other's preview
		return { ok: true, url: `http://127.0.0.1:${port}/${e.sender.id}` };
	} catch (err) {
		return { ok: false, error: String(err instanceof Error ? err.message : err) };
	}
});

ipcMain.on('typst:preview:release', (e) => {
	if (e.senderFrame !== e.sender.mainFrame) return;
	preparedPages.delete(e.sender.id);
	preparedDataPlanes.delete(e.sender.id);
});

/**
 * Colours reach us from the renderer's theme; this bounds them to a colour-shaped charset so they
 * cannot break out of the style rule they are interpolated into (no quotes, braces, semicolons).
 *
 * Deliberately a charset, NOT an allowlist of colour functions: this used to accept only hex/rgb,
 * and when the theme turned out to declare oklch(...) it silently substituted WHITE - which painted
 * the preview's surround and its page edges invisible. A colour space this function has not heard
 * of must still pass.
 */
function cssColour(v: unknown): string {
	const s = String(v ?? '').trim();
	return s.length <= 100 && /^[a-zA-Z#][a-zA-Z0-9#(),.%/\s-]*$/.test(s) ? s : '#ffffff';
}

ipcMain.on('typst:lsp:send', (e, json: string) => typstLsps.get(e.sender.id)?.send(json));
ipcMain.on('typst:lsp:stop', (e) => {
	typstLsps.get(e.sender.id)?.stop();
	typstLsps.delete(e.sender.id);
});

// whole-window zoom: setZoomFactor scales the entire renderer (editor, sidebar, toolbars,
// panels) crisply, unlike a CSS transform. The renderer persists the value in settings.
ipcMain.handle('window:setZoom', (_e, factor: number) => {
	const f = Math.min(2.5, Math.max(0.5, Number(factor) || 1));
	// the persisted uiZoom is app-wide, so keep every window at the same factor
	for (const w of BrowserWindow.getAllWindows()) w.webContents.setZoomFactor(f);
	return f;
});

// ---- multi-window IPC ----
// A folder may be open in exactly one window (two autosavers on the same .tex files would
// silently clobber each other). claim() registers the sender as that folder's window; if
// another live window already has it, that window is focused instead and the caller aborts.
ipcMain.handle('workspace:claim', async (e, root: string) => {
	if (!isDiagramHost(e) || typeof root !== 'string' || !path.isAbsolute(root)) return { ok: false, reason: 'bad-root' };
	const generation = diagramGenerations.get(e.sender.id) ?? 0;
	let raw: string;
	try {
		raw = await fs.promises.realpath(root);
		if (!(await fs.promises.lstat(raw)).isDirectory()) return { ok: false, reason: 'bad-root' };
	} catch {
		return { ok: false, reason: 'bad-root' };
	}
	if (!isDiagramHost(e) || generation !== (diagramGenerations.get(e.sender.id) ?? 0)) return { ok: false, reason: 'bad-root' };
	const norm = normRoot(raw);
	for (const [wcId, r] of windowRoots) {
		if (wcId === e.sender.id || !r || r.norm !== norm) continue;
		const w = windowFor(wcId);
		if (w) {
			focusWindow(w);
			return { ok: false, reason: 'already-open' };
		}
		windowRoots.delete(wcId); // stale entry for a dead window
	}
	invalidateDiagramOwner(e.sender.id);
	windowRoots.set(e.sender.id, { raw, norm });
	persistOpenFolders();
	// watch the claimed root so external writes (another editor, git, an AI agent) reach the
	// renderer's conflict machinery now instead of on the next window focus
	const wcId = e.sender.id;
	startWorkspaceWatch(String(wcId), raw, (change) => windowFor(wcId)?.webContents.send('workspace:fs-changed', change));
	return { ok: true };
});
ipcMain.handle('workspace:release', (e) => {
	if (!isDiagramHost(e)) return { ok: false, reason: 'bad-root' };
	invalidateDiagramOwner(e.sender.id);
	windowRoots.set(e.sender.id, null);
	stopWorkspaceWatch(String(e.sender.id));
	persistOpenFolders();
	return { ok: true };
});
ipcMain.on('window:close-decision', (e, proceed: boolean) => {
	const held = pendingCloses.get(e.sender.id);
	pendingCloses.delete(e.sender.id);
	held?.settle(!!proceed);
});
ipcMain.handle('window:new', () => {
	createWindow(startUrl());
});
// scoped to the sender rather than the focused window: with several workspaces open, the menu
// that was clicked is the one whose console the user wants
ipcMain.on('window:toggle-devtools', (e) => e.sender.toggleDevTools());
// picker + new window in one step, deduped against windows that already have the folder
ipcMain.handle('window:openFolderNew', async (e) => {
	const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender) ?? undefined!, {
		title: 'Open Folder',
		properties: ['openDirectory', 'createDirectory']
	});
	if (res.canceled || res.filePaths.length === 0) return null;
	const root = res.filePaths[0]!;
	const existing = windowWithRoot(root);
	if (existing) focusWindow(existing);
	else focusWindow(createWindow(startUrl(), { kind: 'folder', path: root }));
	return root;
});
// ---- MCP ----
// The server reports editor state and steers the view; it never writes documents. See
// electron/src/mcp/server.ts for why it is hosted in-process rather than spawned.
function mcpPort(): number {
	const configured = Number(readSettings().mcpPort) || 0;
	return configured > 0 ? configured : devChannel ? mcp.PORT_DEFAULT_DEV : mcp.PORT_DEFAULT;
}

function mcpHost(): mcp.McpHost {
	return {
		userDataDir: app.getPath('userData'),
		port: mcpPort(),
		windows: () => BrowserWindow.getAllWindows().map((w) => ({ webContentsId: w.webContents.id, focused: w.isFocused() })),
		rootFor: (wcId) => windowRoots.get(wcId)?.raw ?? null,
		windowObjects: () => BrowserWindow.getAllWindows(),
		windowFor: (root) => {
			// by root when given: focus follows the user's clicks, so a tool that always used the
			// focused window would steer whichever project they happened to be looking at
			const win = root ? windowWithRoot(root) : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
			if (!win) return null;
			return { win, root: windowRoots.get(win.webContents.id)?.raw ?? null };
		},
		onConnectionChange: (client) => {
			for (const w of BrowserWindow.getAllWindows()) w.webContents.send('mcp:connection', client);
		}
	};
}

ipcMain.handle('mcp:status', () => ({ ...mcp.status(), enabled: !!readSettings().mcpEnabled }));
ipcMain.handle('mcp:setEnabled', async (_e, enabled: boolean) => {
	writeSettings({ mcpEnabled: !!enabled });
	if (enabled) await mcp.start(mcpHost());
	else await mcp.stop();
	return { ...mcp.status(), enabled: !!enabled };
});
// renderers push what they are showing; see mcp/state.ts for why this is a push and not a pull
// a renderer answering an mcp:request (get_unsaved, get_diagnostics)
ipcMain.on('mcp:response', (_e, payload: { id: number; data: unknown }) => {
	if (payload && typeof payload.id === 'number') deliverResponse(payload.id, payload.data);
});
ipcMain.on('mcp:publishState', (e, state: Omit<WindowState, 'updatedAt'>) => {
	publishWindowState(e.sender.id, state);
});

// node-pty is a native module: if it isn't built for this Electron ABI the require throws,
// so guard it and let the renderer show the terminal as unavailable
type Pty = typeof import('node-pty');
type IPty = import('node-pty').IPty;
let pty: Pty | null = null;
try {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	pty = require('node-pty');
} catch (e) {
	console.error('node-pty unavailable, run `npm run electron:rebuild`:', e instanceof Error ? e.message : e);
}
const ptys = new Map<string, IPty>();

function defaultShell(): string {
	if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
	// Finder-launched apps may lack SHELL, so fall back to the platform default
	if (process.platform === 'darwin') return process.env.SHELL || '/bin/zsh';
	return process.env.SHELL || '/bin/bash';
}

/**
 * The environment a terminal is spawned with: ours, plus the copy of tinymist we manage ourselves.
 *
 * Only a directory is added, never a command - the shell still resolves `tinymist` (or `latexmk`,
 * or anything else) by name, exactly as a user typing the same command by hand would, so a compile
 * command stays the same string on every machine.
 *
 * Nothing else needs adding: the user's own installs are on PATH, and fixShellPath() has already
 * recovered the login-shell PATH this process was launched without.
 */
function terminalEnv(): NodeJS.ProcessEnv {
	const dirs: string[] = [];
	try {
		const managed = typstService.managedTinymistPath(app.getPath('userData'));
		if (fs.existsSync(managed)) dirs.push(path.dirname(managed));
	} catch {
		// an unreadable userData dir must never stop a terminal from opening
	}
	return toolchain.withPathDirs(process.env, dirs);
}

ipcMain.handle('terminal:available', () => pty != null);

interface TerminalSpawnOpts {
	id?: string;
	cwd?: string;
	cols?: number;
	rows?: number;
}

ipcMain.handle('terminal:spawn', (e, { id, cwd, cols, rows }: TerminalSpawnOpts = {}) => {
	if (!pty) return { ok: false, error: 'node-pty is not built for this Electron build (run `npm run electron:rebuild`).' };
	if (id == null) return { ok: false, error: 'Missing terminal id' };
	// `shell` tells the renderer which chaining syntax works for its done-sentinel
	// (cmd wants `&`, everything else `;`)
	const shellPath = defaultShell();
	const shell = shellPath.split(/[\\/]/).pop() ?? shellPath;
	if (ptys.has(id)) return { ok: true, shell };
	let proc: IPty;
	try {
		// macOS: login shell, so /etc/zprofile runs path_helper and picks up /etc/paths.d
		// (MacTeX registers /Library/TeX/texbin there). A Finder-launched app only has
		// launchd's bare PATH, and a non-login zsh never repairs it - Terminal.app,
		// iTerm and VS Code all spawn login shells for the same reason.
		proc = pty.spawn(shellPath, process.platform === 'darwin' ? ['-l'] : [], {
			name: 'xterm-color',
			cwd: cwd && fs.existsSync(cwd) ? cwd : app.getPath('home'),
			cols: Math.max(1, cols! | 0) || 80,
			rows: Math.max(1, rows! | 0) || 24,
			// the shell must be able to find the tools Preferences says are installed; without this a
			// configured tinymist works for intellisense and for the Toolchain tab, then fails at the
			// compile command with "not recognized" (see withPathDirs)
			env: terminalEnv() as Record<string, string>
		});
	} catch (err) {
		return { ok: false, error: String(err instanceof Error ? err.message : err) };
	}
	const wc = e.sender;
	// coalesce pty output: one renderer message per ~16ms tick (or 64KB burst) instead of
	// one per chunk -- a fast compile can emit thousands of tiny chunks per second
	let buf = '';
	let flushTimer: NodeJS.Timeout | null = null;
	const flush = () => {
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		if (!buf) return;
		const data = buf;
		buf = '';
		if (!wc.isDestroyed()) wc.send('terminal:data', { id, data });
	};
	proc.onData((data) => {
		buf += data;
		if (buf.length >= 64 * 1024) flush();
		else if (!flushTimer) flushTimer = setTimeout(flush, 16);
	});
	proc.onExit(({ exitCode }) => {
		ptys.delete(id);
		flush(); // pending output must land before the exit message, or the tail is lost
		if (!wc.isDestroyed()) wc.send('terminal:exit', { id, code: exitCode });
	});
	ptys.set(id, proc);
	return { ok: true, shell };
});

ipcMain.on('terminal:input', (_e, { id, data } = {} as { id?: string; data?: string }) => {
	const p = id != null ? ptys.get(id) : undefined;
	if (p && data != null) p.write(data);
});

ipcMain.on('terminal:resize', (_e, { id, cols, rows } = {} as { id?: string; cols?: number; rows?: number }) => {
	const p = id != null ? ptys.get(id) : undefined;
	if (!p) return;
	try {
		p.resize(Math.max(1, cols! | 0), Math.max(1, rows! | 0));
	} catch {
		/* a resize after exit can throw; ignore */
	}
});

ipcMain.on('terminal:kill', (_e, { id } = {} as { id?: string }) => {
	const p = id != null ? ptys.get(id) : undefined;
	if (!p) return;
	try {
		p.kill();
	} catch {
		/* ignore */
	}
	if (id != null) ptys.delete(id);
});

// OS "Open With": route the file to the window whose workspace contains it, else an
// empty start-screen window, else a fresh window (the VS Code model)
function requestOpenPath(p: string): void {
	if (!p) return;
	const fileNorm = normRoot(p);
	for (const [wcId, r] of windowRoots) {
		if (!r) continue;
		if (fileNorm === r.norm || fileNorm.startsWith(r.norm + path.sep)) {
			const w = windowFor(wcId);
			if (w && !w.webContents.isLoading()) {
				w.webContents.send('main:open-path', p);
				focusWindow(w);
				return;
			}
		}
	}
	for (const [wcId, r] of windowRoots) {
		if (r) continue;
		const w = windowFor(wcId);
		if (!w) continue;
		if (w.webContents.isLoading()) {
			if (!pendingOpens.has(wcId)) {
				pendingOpens.set(wcId, { kind: 'file', path: p });
				focusWindow(w);
				return;
			}
			continue;
		}
		w.webContents.send('main:open-path', p);
		focusWindow(w);
		return;
	}
	if (app.isReady()) focusWindow(createWindow(startUrl(), { kind: 'file', path: p }));
	else initialOpenPath = p;
}

// Windows/Linux file associations put the path in argv; macOS uses the open-file event
function fileFromArgv(argv: string[]): string | null {
	for (const a of argv.slice(1)) {
		if (!a || a.startsWith('-')) continue;
		if (/\.(tex|ltx|latex)$/i.test(a) && fs.existsSync(a)) return path.resolve(a);
	}
	return null;
}

// macOS "Open With" arrives here, possibly before the window (even before ready)
app.on('open-file', (event, filePath) => {
	event.preventDefault();
	requestOpenPath(filePath);
});

// a second launch routes its file to the right window; launching with no file opens a
// fresh window (VS Code model), instead of just focusing the existing one
if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', (_e, argv) => {
		const p = fileFromArgv(argv);
		if (p) requestOpenPath(p);
		else createWindow(startUrl());
	});
}

app.whenReady().then(() => {
	managedCompile = createManagedCompileService({
		runtime: {
			isPackaged: app.isPackaged,
			resourcesPath: process.resourcesPath,
			appPath: app.getAppPath(),
			userData: app.getPath('userData')
		},
		authorize(rawEvent) {
			const event = rawEvent as Electron.IpcMainInvokeEvent;
			if (useOriginalFrontend) {
				if (!isFrontendHost(event)) throw new Error('UNTRUSTED_SENDER');
				const owner = filesFor(event.sender.id).compileOwner();
				return { root: owner.root, assertCurrent() {
					if (!isFrontendHost(event)) throw new Error('UNTRUSTED_SENDER');
					owner.assertCurrent();
				} };
			}
			if (!isDiagramHost(event)) throw new Error('UNTRUSTED_SENDER');
			const id = event.sender.id,
				root = windowRoots.get(id)?.raw,
				generation = diagramGenerations.get(id) ?? 0;
			if (!root) throw new Error('STALE_WORKSPACE');
			return {
				root,
				assertCurrent() {
					if (!isDiagramHost(event) || windowRoots.get(id)?.raw !== root || (diagramGenerations.get(id) ?? 0) !== generation)
						throw new Error('STALE_WORKSPACE');
				}
			};
		}
	});
	frontendCompiler = new FrontendCompiler(managedCompile, filesFor);
	ipcMain.handle('compile:run', (event, request: unknown) => managedCompile!.run(event, event.sender.id, request));
	ipcMain.handle('compile:cancel', (event, ...args: unknown[]) => {
		if (args.length) return { ok: false };
		try {
			managedCompile!.cancel(event, event.sender.id);
			return { ok: true };
		} catch {
			return { ok: false };
		}
	});
	registerProtocolHandlers();
	installDrawioNetworkGuard(session.defaultSession, drawioWindowContext, (id) => windowFor(id)?.webContents);
	if (!initialOpenPath) initialOpenPath = fileFromArgv(process.argv);

	registerDiagramRelinkIpc({
		registrar: ipcMain,
		workspaceForSender: (senderId) => {
			const win = windowFor(senderId);
			if (!win) return null;
			return windowRoots.get(senderId)?.raw ?? null;
		},
		parentForSender: (sender) => windowFor(sender.id),
		pickFile: async ({ parent, defaultPath, extensions }) => {
			const options: Electron.OpenDialogOptions = {
				defaultPath,
				properties: ['openFile'],
				filters: [{ name: 'Diagram source', extensions: [...extensions] }]
			};
			const result = parent instanceof BrowserWindow ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options);
			return { canceled: result.canceled, filePaths: result.filePaths };
		}
	});
	diagramNative = registerDiagramNativeIpc({
		registrar: ipcMain,
		render: renderDiagramSvgToPdf,
		authorize(event) {
			const nativeEvent = event as Electron.IpcMainInvokeEvent;
			if (!isDiagramHost(nativeEvent)) throw new Error('UNTRUSTED_SENDER');
			const id = event.sender.id;
			const root = windowRoots.get(id)?.raw;
			const generation = diagramGenerations.get(id) ?? 0;
			if (!root) throw new Error('STALE_WORKSPACE');
			return {
				root,
				generation,
				assertCurrent() {
					if (!isDiagramHost(nativeEvent) || windowRoots.get(id)?.raw !== root || (diagramGenerations.get(id) ?? 0) !== generation)
						throw new Error('STALE_WORKSPACE');
				}
			};
		}
	});

	// A client is configured once and expects us to be listening; making this a per-launch button
	// would surface the failure as a connection error inside the client, not here. So once granted,
	// it starts with the app. A failure to bind must not stop the editor from opening.
	if (readSettings().mcpEnabled) mcp.start(mcpHost()).catch((e) => console.error('mcp: failed to start', e));

	// Window controls for the custom title bar, plus - on macOS - the native menu bar, built from
	// what the renderer reports about its own menus. Everywhere else the native menu is removed
	// and the renderer draws it. See window-chrome.ts.
	// persisted so the NEXT launch can paint its window buttons in the right colours before a
	// renderer exists to report them; see chromeColors()
	registerWindowChrome((c) =>
		writeSettings({
			chromeHeight: c.height,
			chromeColor: c.color,
			chromeSymbolColor: c.symbolColor,
			chromeBackground: c.background
		})
	);

	if (initialOpenPath) {
		// launched via a .tex file: that request wins over session restore
		createWindow(startUrl(), { kind: 'file', path: initialOpenPath });
		initialOpenPath = null;
	} else {
		// session restore: one window per remembered folder (openFolders), falling back to
		// the pre-multi-window lastFolder slot for existing installs
		const s = readSettings();
		const remembered = Array.isArray(s.openFolders) && s.openFolders.length ? (s.openFolders as string[]) : [];
		const legacy = typeof s.lastFolder === 'string' && s.lastFolder ? [s.lastFolder] : [];
		const folders =
			s.reopenLastFolder !== false
				? [...new Set((remembered.length ? remembered : legacy).map((f) => path.resolve(f)))].filter((f) => {
						try {
							return fs.statSync(f).isDirectory();
						} catch {
							return false;
						}
					})
				: [];
		if (folders.length) for (const f of folders) createWindow(startUrl(), { kind: 'folder', path: f });
		else createWindow(startUrl());
	}

	app.on('activate', () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow(startUrl());
	});
});

app.on('window-all-closed', () => {
	if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
	quitting = true; // freeze the persisted openFolders snapshot before windows start closing
});

// destructive teardown only once the quit is actually happening: the unsaved-edit hold can
// CANCEL a quit, and a cancelled quit must not have killed every shell and the warm engine
let cpuStoppedForQuit = false;
app.on('will-quit', (event) => {
	managedCompile?.close();
	if (!cpuStoppedForQuit) {
		event.preventDefault();
		cpuStoppedForQuit = true;
		void diagramCpu
			.close()
			.catch((error) => console.error('diagram CPU cleanup failed', error))
			.finally(() => app.quit());
	}
	for (const p of ptys.values()) {
		try {
			p.kill();
		} catch {
			/* ignore */
		}
	}
	ptys.clear();
	draftDaemon.stopDaemon();
	// takes the endpoint file with it, so a stale port/token is never left on disk for the bridge
	void mcp.stop();
});
