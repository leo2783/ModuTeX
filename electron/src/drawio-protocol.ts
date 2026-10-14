import * as path from 'node:path';
import { constants, promises as fs } from 'node:fs';
import type { Session, WebContents, WebFrameMain } from 'electron';

export const DRAWIO_ORIGIN = 'drawio://bundle';
export const DRAWIO_INDEX = 'drawio://editor/index.html?embed=1&proto=json&offline=1&local=1&noSaveBtn=1&noExitBtn=1&configure=1';
export const DRAWIO_RELAY = `${DRAWIO_ORIGIN}/relay.html`;

/** Native host authority: canonical URL equality, except the app's two known hash routes. */
export function matchesDiagramHostURL(actual: string, expected: string): boolean {
	const canonical = (raw: string): string | null => {
		try {
			if (raw.length > 8192 || raw.endsWith('#')) return null;
			const url = new URL(raw);
			if (!['http:', 'https:', 'app:'].includes(url.protocol) || url.username || url.password) return null;
			if (url.hash && url.hash !== '#/' && !/^#\/workspace\/*$/.test(url.hash)) return null;
			url.hash = '';
			return url.href;
		} catch {
			return null;
		}
	};
	const target = canonical(actual);
	return target !== null && target === canonical(expected);
}
export const DRAWIO_PRIVILEGES = { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true };
export const DRAWIO_CSP = [
	"default-src 'none'",
	"script-src 'self' 'unsafe-inline' 'unsafe-eval'",
	"style-src 'self' 'unsafe-inline'",
	"img-src 'self' data: blob:",
	"font-src 'self' data:",
	"connect-src 'self' blob: data:",
	"worker-src 'self' blob:",
	"frame-src 'none'",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'none'"
].join('; ');

const MIME: Record<string, string> = {
	'.html': 'text/html',
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.xml': 'application/xml',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.gif': 'image/gif',
	'.jpg': 'image/jpeg',
	'.jpeg': 'image/jpeg',
	'.ico': 'image/x-icon',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2',
	'.ttf': 'font/ttf',
	'.txt': 'text/plain'
};

// Check the raw pathname BEFORE URL parsing can erase dot segments. No platform
// separators, alternate streams, device names or URL credentials reach the filesystem.
export function drawioRelativePath(raw: string): string | null {
	if (raw.length > 4096 || /[\\\u0000-\u0020]/.test(raw)) return null;
	const match = /^drawio:\/\/editor(\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/.exec(raw);
	if (!match) return null;
	let pathname: string;
	try {
		pathname = decodeURIComponent(match[1] ?? '/');
	} catch {
		return null;
	}
	if (/%|\\|:|[\u0000-\u001f]/.test(pathname) || /%2f|%5c/i.test(match[1] ?? '')) return null;
	if (pathname === '/') pathname = '/index.html';
	const segments = pathname.slice(1).split('/');
	if (
		segments.some(
			(segment) =>
				!segment ||
				segment === '.' ||
				segment === '..' ||
				/[. ]$/.test(segment) ||
				/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment)
		)
	)
		return null;
	const relative = segments.join('/');
	if (!MIME[path.extname(relative).toLowerCase()] || (relative.endsWith('.html') && relative !== 'index.html')) return null;
	return relative;
}

export function drawioVendorRoot(isPackaged: boolean, resourcesPath: string, mainDirectory: string): string {
	return path.join(isPackaged ? resourcesPath : path.resolve(mainDirectory, '../..'), 'vendor', 'drawio', 'src', 'main', 'webapp');
}

export async function canonicalDrawioFile(root: string, relative: string): Promise<string> {
	if (drawioRelativePath(`drawio://editor/${relative}`) !== relative) throw new Error('INVALID_DRAWIO_PATH');
	const canonicalRoot = await fs.realpath(root);
	if ((await fs.lstat(root)).isSymbolicLink() || !(await fs.stat(canonicalRoot)).isDirectory()) throw new Error('INVALID_DRAWIO_ROOT');
	let current = canonicalRoot;
	for (const segment of relative.split('/')) {
		current = path.join(current, segment);
		const info = await fs.lstat(current);
		if (info.isSymbolicLink() || (await fs.realpath(current)) !== current) throw new Error('INVALID_DRAWIO_PATH');
	}
	if (!(await fs.stat(current)).isFile()) throw new Error('INVALID_DRAWIO_FILE');
	return current;
}

// The root is chosen by main, never by renderer input. Vendor integrity is checked
// by the retained-resource install/package gates; no arbitrary file loader is exposed.
export function createDrawioHandler(
	root: string,
	relayScript?: string,
	hostOrigins: () => readonly string[] = () => []
): (request: Request) => Promise<Response> {
	return async (request) => {
		if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 });
		if (request.url === `${DRAWIO_ORIGIN}/relay.html` || request.url === `${DRAWIO_ORIGIN}/relay.js`) {
			if (!relayScript) return new Response(null, { status: 404 });
			const csp =
				"default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; frame-src drawio://editor; object-src 'none'; base-uri 'none'; form-action 'none'";
			const isScript = request.url.endsWith('.js');
			const origins = hostOrigins();
			if (!origins.length || origins.some((origin) => !/^(?:app:\/\/bundle|https?:\/\/127\.0\.0\.1:\d+)$/.test(origin)))
				return new Response(null, { status: 403 });
			const body = isScript
				? (await fs.readFile(relayScript, 'utf8')).replace('"__MODUTEX_HOST_ORIGINS__"', JSON.stringify(origins))
				: '<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;height:100vh;overflow:hidden"><script src="/relay.js"></script></body></html>';
			return new Response(request.method === 'HEAD' ? null : body, {
				headers: {
					'Content-Type': isScript ? 'text/javascript' : 'text/html',
					'Content-Security-Policy': csp,
					'Cache-Control': 'no-store',
					'X-Content-Type-Options': 'nosniff'
				}
			});
		}
		const relative = drawioRelativePath(request.url);
		if (!relative) return new Response(null, { status: 403 });
		try {
			const file = await canonicalDrawioFile(root, relative);
			const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
			try {
				const info = await handle.stat();
				if (!info.isFile() || info.size > 32 * 1024 * 1024 || (await canonicalDrawioFile(root, relative)) !== file)
					return new Response(null, { status: 403 });
				const pathnameInfo = await fs.stat(file);
				if (pathnameInfo.dev !== info.dev || pathnameInfo.ino !== info.ino) return new Response(null, { status: 403 });
				const headers = {
					'Content-Type': MIME[path.extname(file).toLowerCase()],
					'Content-Security-Policy': DRAWIO_CSP,
					'X-Content-Type-Options': 'nosniff',
					'Cache-Control': 'no-store'
				};
				if (request.method === 'HEAD') return new Response(null, { headers });
				// Bound even a concurrently growing file. This is not a claim of an OS
				// sandbox against a privileged process mutating the trusted vendor tree.
				const bytes = new Uint8Array(info.size + 1);
				let used = 0;
				while (used < bytes.length) {
					const { bytesRead } = await handle.read(bytes, used, bytes.length - used, used);
					if (!bytesRead) break;
					used += bytesRead;
				}
				if (used !== info.size) return new Response(null, { status: 403 });
				return new Response(bytes.subarray(0, used), { headers });
			} finally {
				await handle.close();
			}
		} catch {
			return new Response(null, { status: 404 });
		}
	};
}

type Frame = Pick<WebFrameMain, 'url' | 'parent'>;
export type Context = {
	mainURL: string;
	previewURL?: string;
	dataPlaneOrigin?: string;
	matchesHostURL?: (actual: string, expected: string) => boolean;
};
export type DrawioContextLookup = (webContentsId: number) => Context | undefined;

function sameOrigin(left: string, right: string): boolean {
	try {
		const a = new URL(left),
			b = new URL(right);
		return !a.username && !a.password && !b.username && !b.password && a.protocol === b.protocol && a.host === b.host;
	} catch {
		return false;
	}
}

export function hasDrawioAncestor(frame: Frame | null | undefined): boolean {
	try {
		const seen = new Set<Frame>();
		for (let current = frame; current; current = current.parent) {
			if (seen.has(current) || seen.size > 128) return true;
			seen.add(current);
			if (sameOrigin(current.url, DRAWIO_ORIGIN) || sameOrigin(current.url, 'drawio://editor')) return true;
		}
		return false;
	} catch {
		return true;
	}
}

function frameURLs(frame: Frame): string[] | null {
	try {
		const result: string[] = [],
			seen = new Set<Frame>();
		for (let current: Frame | null = frame; current; current = current.parent) {
			if (seen.has(current) || seen.size > 128) return null;
			seen.add(current);
			result.push(current.url);
		}
		return result;
	} catch {
		return null;
	}
}

export function allowDrawioNetwork(
	details: Pick<Electron.OnBeforeRequestListenerDetails, 'url' | 'resourceType' | 'frame'>,
	context?: Context,
	bootstrap = false
): boolean {
	const matchesHost = context?.matchesHostURL ?? matchesDiagramHostURL;
	if (hasDrawioAncestor(details.frame) || !context) return false;
	if (!details.frame) return bootstrap && details.resourceType === 'mainFrame' && matchesHost(details.url, context.mainURL);
	const urls = frameURLs(details.frame);
	if (
		bootstrap &&
		details.resourceType === 'mainFrame' &&
		matchesHost(details.url, context.mainURL) &&
		urls?.length === 1 &&
		['', 'about:blank'].includes(urls[0])
	)
		return true;
	if (!urls || !matchesHost(urls.at(-1) ?? '', context.mainURL)) return false;
	if (
		context.previewURL &&
		(urls[0] === context.previewURL || (details.resourceType === 'subFrame' && details.url === context.previewURL))
	) {
		return (
			details.url === context.previewURL ||
			(!!context.dataPlaneOrigin && sameOrigin(details.url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'), context.dataPlaneOrigin))
		);
	}
	// A worker without a requesting frame is deliberately NOT authorized by referrer.
	return (
		urls.length === 1 &&
		matchesHost(urls[0], context.mainURL) &&
		sameOrigin(details.url.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:'), context.mainURL)
	);
}

export function allowDrawioNavigation(
	event: Pick<Electron.WebContentsWillFrameNavigateEventParams, 'url' | 'isMainFrame' | 'frame' | 'initiator'>,
	context: Context
): boolean {
	const matchesHost = context?.matchesHostURL ?? matchesDiagramHostURL;
	// Only a wrapper's first blank child may load the fixed pinned editor URL.
	try {
		if (
			!event.isMainFrame &&
			event.url === DRAWIO_INDEX &&
			event.frame &&
			['', 'about:blank'].includes(event.frame.url) &&
			event.frame.parent?.url === DRAWIO_RELAY &&
			event.initiator?.url === DRAWIO_RELAY &&
			event.frame.parent === event.initiator
		)
			return true;
	} catch {
		return false;
	}
	if (hasDrawioAncestor(event.frame) || hasDrawioAncestor(event.initiator)) return false;
	if (!event.frame || !event.initiator) return false;
	const initiator = frameURLs(event.initiator);
	if (!initiator || initiator.length !== 1 || !matchesHost(initiator[0], context.mainURL)) return false;
	if (event.isMainFrame) return matchesHost(event.url, context.mainURL);
	return event.url === DRAWIO_RELAY || event.url === context.previewURL;
}

// Electron supports only one listener of each webRequest kind. Register once for
// this shared session, not once per window (which would overwrite earlier guards).
export function installDrawioNetworkGuard(
	session: Session,
	lookup: DrawioContextLookup,
	ownedContents: (id: number) => WebContents | undefined
): void {
	session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
		const context = details.webContentsId === undefined ? undefined : lookup(details.webContentsId);
		let bootstrap = false;
		try {
			const contents = details.webContentsId === undefined ? undefined : ownedContents(details.webContentsId);
			if (
				!contents ||
				contents.isDestroyed() ||
				contents.id !== details.webContentsId ||
				contents.session !== session ||
				(details.webContents && details.webContents !== contents)
			) {
				callback({ cancel: true });
				return;
			}
			if (details.frame) {
				let root = details.frame;
				const seen = new Set<WebFrameMain>();
				while (root.parent) {
					if (seen.has(root) || seen.size >= 128) {
						callback({ cancel: true });
						return;
					}
					seen.add(root);
					root = root.parent;
				}
				if (root !== contents.mainFrame) {
					callback({ cancel: true });
					return;
				}
			}
			bootstrap =
				!!context &&
				details.resourceType === 'mainFrame' &&
				(context.matchesHostURL ?? matchesDiagramHostURL)(details.url, context.mainURL) &&
				(!details.frame || details.frame === contents.mainFrame) &&
				['', 'about:blank'].includes(contents.getURL());
		} catch {
			callback({ cancel: true });
			return;
		}
		callback({ cancel: !allowDrawioNetwork(details, context, bootstrap) });
	});
}

export function installDrawioNavigationGuard(contents: WebContents, context: () => Context): void {
	contents.setWindowOpenHandler(() => ({ action: 'deny' }));
	const navigate = (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
		if (!allowDrawioNavigation(event, context())) event.preventDefault();
	};
	contents.on('will-frame-navigate', navigate);
	contents.on('will-redirect', navigate);
}
