import { contextBridge, ipcRenderer } from 'electron';
import type {
	WorkspaceFsChange,
	ManagedCompileRequest,
	ManagedCompileResult,
	DiagramRelinkRequest,
	DiagramRelinkResult,
	DiagramReadRequest,
	DiagramReadResult,
	DiagramWriteRequest,
	DiagramBundleStatusResult,
	DiagramPdfRequest,
	DiagramPdfResult,
	DiagramPdfCancelRequest,
	DiagramPdfCancelResult
} from 'modutex-contracts';

/** unwraps the { ok, value | error } results from main.ts handleFs back into throw semantics. */
async function invokeFs(channel: string, ...args: unknown[]): Promise<unknown> {
	const r = (await ipcRenderer.invoke(channel, ...args)) as { ok: boolean; value?: unknown; error?: string };
	if (r && r.ok) return r.value;
	throw new Error(r?.error ?? 'Unknown error');
}

// main pushes open-path/open-folder on did-finish-load, which can beat the renderer's
// subscription (mount waits on the settings IPC; the route-split boot is fast enough to lose
// that race). Buffer here — preload runs before any page code — and flush on subscribe.
function bufferedChannel<T>(channel: string, map: (...args: unknown[]) => T) {
	const queued: T[] = [];
	let handler: ((v: T) => void) | null = null;
	ipcRenderer.on(channel, (_e, ...args: unknown[]) => {
		const v = map(...args);
		if (handler) handler(v);
		else queued.push(v);
	});
	return (cb: (v: T) => void) => {
		handler = cb;
		while (queued.length) cb(queued.shift()!);
		return () => {
			handler = null;
		};
	};
}
const onOpenPathBuffered = bufferedChannel('main:open-path', (p) => String(p));
const onOpenFolderBuffered = bufferedChannel('main:open-folder', (r) => String(r));

contextBridge.exposeInMainWorld('texpileNative', {
	managedCompile: (request: ManagedCompileRequest): Promise<ManagedCompileResult> => ipcRenderer.invoke('compile:run', request),
	cancelManagedCompile: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('compile:cancel'),
	/** native folder picker; resolves to the chosen absolute path or null. */
	openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
	getSettings: () => ipcRenderer.invoke('settings:get'),
	/** merges a partial update into settings; resolves to the updated settings. */
	setSettings: (partial: Record<string, unknown>) => ipcRenderer.invoke('settings:set', partial),
	/** set the whole-window zoom factor (clamped 0.5..2.5); resolves to the applied factor. */
	setZoomFactor: (factor: number) => ipcRenderer.invoke('window:setZoom', factor),
	/** whether AI-assistant access is enabled, and the loopback port if it is listening. */
	mcpStatus: () => ipcRenderer.invoke('mcp:status'),
	/** turn AI-assistant access on or off; persists and starts/stops the server. */
	mcpSetEnabled: (enabled: boolean) => ipcRenderer.invoke('mcp:setEnabled', enabled),
	/** report what this window is showing, for the MCP get_editor_state tool. Fire and forget:
	 *  it is a cache update, and a dropped one is corrected by the next push. */
	mcpPublishState: (state: unknown) => ipcRenderer.send('mcp:publishState', state),
	/** subscribe to "open this .tex" requests from the OS; buffered, returns an unsubscribe fn. */
	onOpenPath: (cb: (filePath: string) => void) => onOpenPathBuffered(cb),
	/** subscribe to "open this folder" pushes (session restore, Open Folder in New Window). */
	onOpenFolder: (cb: (root: string) => void) => onOpenFolderBuffered(cb),
	/** register this window as the folder's owner; { ok:false } means another window has it (and was focused). */
	claimWorkspace: (root: string) => ipcRenderer.invoke('workspace:claim', root),
	/** mark this window as back on the start screen. */
	releaseWorkspace: () => ipcRenderer.invoke('workspace:release'),
	/** Select and read one validated diagram source from the workspace claimed by this window. */
	diagramRelink: (request: DiagramRelinkRequest): Promise<DiagramRelinkResult | null> => ipcRenderer.invoke('diagram:relink', request),
	diagramRead: (request: DiagramReadRequest): Promise<DiagramReadResult> => ipcRenderer.invoke('diagram:read', request),
	diagramWrite: (request: DiagramWriteRequest): Promise<{ sha256: string; size: number }> => ipcRenderer.invoke('diagram:write', request),
	diagramStatus: (request: DiagramReadRequest): Promise<DiagramBundleStatusResult> => ipcRenderer.invoke('diagram:status', request),
	diagramRenderPdf: (request: DiagramPdfRequest): Promise<DiagramPdfResult> => ipcRenderer.invoke('diagram:render-pdf', request),
	diagramCancelPdf: (request: DiagramPdfCancelRequest): Promise<DiagramPdfCancelResult> =>
		ipcRenderer.invoke('diagram:cancel-pdf', request),
	diagramPrepareDrawioVector: (request: { xml: string }): Promise<{ xml: string }> =>
		ipcRenderer.invoke('diagram:prepare-drawio-vector', request),
	/** open an empty new window. */
	newWindow: () => ipcRenderer.invoke('window:new'),
	/** Help > Toggle Developer Tools; the window's own devtools, not a global */
	toggleDevTools: () => ipcRenderer.send('window:toggle-devtools'),

	// ---- custom title bar. The window is frameless off macOS, so these are the only way to
	// minimise, maximise or close it. `close` goes through the normal close path, unsaved-changes
	// hold included. ----
	windowMinimize: () => ipcRenderer.invoke('window:minimize'),
	/** maximize or restore; resolves to the resulting maximized state. */
	windowToggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
	windowClose: () => ipcRenderer.invoke('window:close'),
	windowIsMaximized: () => ipcRenderer.invoke('window:isMaximized'),
	/** repaint / resize the Chromium-drawn window controls to match our title bar (not macOS). */
	windowSetOverlay: (o: { height?: number; color?: string; symbolColor?: string }) => ipcRenderer.send('window:overlay', o),
	/** subscribe to maximize / full-screen changes, so the title bar can swap its restore icon. */
	onWindowState: (cb: (s: { maximized: boolean; fullScreen: boolean }) => void) => {
		const h = (_e: unknown, s: { maximized: boolean; fullScreen: boolean }) => cb(s);
		ipcRenderer.on('main:window-state', h);
		return () => ipcRenderer.removeListener('main:window-state', h);
	},
	/** describe this window's menus for the native macOS menu bar. Fire and forget: the next push
	 *  corrects a dropped one, and off macOS main just records it. */
	publishMenuState: (state: unknown) => ipcRenderer.send('window:menu-state', state),
	/** subscribe to a native menu selection; the payload is the same `menu:value` string the
	 *  in-app menu bar produces. */
	onMenuAction: (cb: (action: string) => void) => {
		const h = (_e: unknown, action: string) => cb(String(action));
		ipcRenderer.on('main:menu-action', h);
		return () => ipcRenderer.removeListener('main:menu-action', h);
	},
	/** folder picker + new window in one step (deduped against already-open folders). */
	openFolderNewWindow: () => ipcRenderer.invoke('window:openFolderNew'),
	/** subscribe to "this window is about to close" (main holds the close until closeDecision). */
	onBeforeClose: (cb: () => void) => {
		const h = () => cb();
		ipcRenderer.on('app:before-close', h);
		return () => ipcRenderer.removeListener('app:before-close', h);
	},
	/** answer a held close: true proceeds (after flushing), false keeps the window open. */
	closeDecision: (proceed: boolean) => ipcRenderer.send('window:close-decision', proceed),

	/** subscribe to "something in the claimed workspace changed on disk" (debounced in main). */
	onWorkspaceFsChanged: (cb: (change?: WorkspaceFsChange) => void) => {
		const h = (_event: unknown, change?: WorkspaceFsChange) => cb(change);
		ipcRenderer.on('workspace:fs-changed', h);
		return () => ipcRenderer.removeListener('workspace:fs-changed', h);
	},

	/** an MCP tool asking this window for something main cannot answer from its cache. */
	onMcpRequest: (cb: (req: { id: number; kind: string }) => void) => {
		const h = (_e: unknown, req: { id: number; kind: string }) => cb(req);
		ipcRenderer.on('mcp:request', h);
		return () => ipcRenderer.removeListener('mcp:request', h);
	},
	mcpRespond: (id: number, data: unknown) => ipcRenderer.send('mcp:response', { id, data }),

	/** an MCP tool steering this window (open a file, show a diff, change view mode). */
	onMcpCommand: (cb: (cmd: Record<string, unknown>) => void) => {
		const h = (_e: unknown, cmd: Record<string, unknown>) => cb(cmd);
		ipcRenderer.on('mcp:command', h);
		return () => ipcRenderer.removeListener('mcp:command', h);
	},

	/** recursively scan a folder for files of the given extensions (CSV, default 'tex'). */
	fsScan: (root: string, exts?: string) => invokeFs('fs:scan', root, exts),
	/** read a text file -> { content }. */
	fsRead: (path: string) => invokeFs('fs:read', path),
	fsWrite: (path: string, content: string) => invokeFs('fs:write', path, content),
	/** write raw bytes, creating parent dirs -> { ok }. */
	fsWriteBinary: (path: string, data: ArrayBuffer) => invokeFs('fs:writeBinary', path, data),
	/** nested file/folder tree -> { root, children }. */
	fsTree: (root: string) => invokeFs('fs:tree', root),
	/** tree + flat file scan (CSV exts, default 'tex') in ONE walk -> { root, children, files }. */
	fsTreeScan: (root: string, exts?: string) => invokeFs('fs:treeScan', root, exts),
	/** create / delete / restore / rename / copy -> { ok }. */
	fsOp: (body: Record<string, unknown>) => invokeFs('fs:op', body),
	/** undoable delete: backs the entry up (if small enough) then sends it to the OS recycle bin.
	 *  -> { backup } , null when it was too large to copy and so cannot be undone. */
	fsTrash: (body: { path: string; root: string }) => invokeFs('fs:trash', body),
	/** discard a folder's undo backups -> { ok }. */
	fsPurgeUndo: (root: string) => invokeFs('fs:purgeUndo', root),
	/** select a file in the OS file manager (Explorer, Finder, ...) -> { ok }. */
	revealItem: (path: string) => ipcRenderer.invoke('shell:revealItem', path),
	/** find-in-files -> { results, truncated, total? }. */
	fsSearch: (root: string, q: string, regex: boolean, caseSensitive: boolean) => invokeFs('fs:search', root, q, regex, caseSensitive),
	/** { exists, mtimeMs, size }, used to poll for a freshly-written compile output. */
	fsStat: (path: string) => invokeFs('fs:stat', path),
	/** reindent via latexindent -> { formatted }; throws if latexindent isn't on PATH. */
	fsFormatLatex: (path: string, text: string) => invokeFs('fs:formatLatex', path, text),
	synctex: (body: Record<string, unknown>) => invokeFs('synctex:call', body),
	/** Draft-mode compile: runs lualatex with the per-page extractor hook -> the real
	 * engine's exact per-page positioned records. -> { ok, pages, paperW, paperH, ... }. */
	draftCompile: (body: { root: string; mainFile: string }) => invokeFs('draft:compile', body),
	/** Draft-mode instant path: typeset ONE paragraph on the warm daemon (~1-2ms). */
	draftTypeset: (body: { root: string; mainFile: string; text: string; hsize?: number }) => invokeFs('draft:typeset', body),
	/** Stop the warm daemon (draft mode off / preview closed) so it stops holding memory. */
	draftStop: () => invokeFs('draft:stop', {}),
	/** Steal the warm engine from the window that currently owns it (explicit user action). */
	draftTakeover: (body: { root: string }) => invokeFs('draft:takeover', body),
	/** subscribe to "another window took the engine" pushes; returns an unsubscribe fn. */
	onDraftPreempted: (cb: (info: { root: string }) => void) => {
		const h = (_e: unknown, info: { root: string }) => cb(info);
		ipcRenderer.on('draft:preempted', h);
		return () => ipcRenderer.removeListener('draft:preempted', h);
	},
	/** Save the live preview's reconcile PDF via a save dialog -> { saved, path? }. */
	draftSavePdf: (body: { root: string; defaultName: string; to?: string }) => invokeFs('draft:savePdf', body),
	/** Save an already-produced PDF via a save dialog -> { saved, path? }. */
	savePdfAs: (body: { src: string; defaultPath: string; to?: string }) => invokeFs('shell:savePdfAs', body),

	/** per-file git status + branch -> { ok, branch?, entries? }. */
	gitStatus: (root: string) => invokeFs('git:status', root),
	/** committed (HEAD) contents of a file for diffing -> { ok, hasHead, content? }. */
	gitShow: (path: string) => invokeFs('git:show', path),
	gitInit: (dir: string) => invokeFs('git:init', dir),
	/** stage files (empty = all). */
	gitStage: (root: string, paths: string[]) => invokeFs('git:stage', root, paths),
	/** unstage files (empty = all). */
	gitUnstage: (root: string, paths: string[]) => invokeFs('git:unstage', root, paths),
	/** discard unstaged changes to tracked files. */
	gitDiscard: (root: string, paths: string[]) => invokeFs('git:discard', root, paths),
	gitCommit: (root: string, message: string) => invokeFs('git:commit', root, message),
	/** the repo's configured user.name, for attributing comments -> { ok, name }. */
	gitUserName: (root: string) => invokeFs('git:userName', root)
});

// tinymist: compiles Typst documents and serves their language features. The LSP wire format is
// framed in the main process; what crosses here is bare JSON-RPC strings, which is exactly what
// @codemirror/lsp-client's Transport speaks.
contextBridge.exposeInMainWorld('texpileTypst', {
	/** locate tinymist. Resolves null when it isn't installed. */
	resolve: () => ipcRenderer.invoke('typst:resolve'),
	/** probe every external program the app shells out to (latexmk, git, synctex, ...). */
	probeToolchain: () => ipcRenderer.invoke('toolchain:probe'),
	/** fetch tinymist's preview page, theme it, and re-serve it; resolves to a typstpreview:// URL. */
	preparePreview: (host: string, background: string, foreground: string) =>
		ipcRenderer.invoke('typst:preview:prepare', { host, background, foreground }),
	releasePreview: () => ipcRenderer.send('typst:preview:release'),
	/** spawn `tinymist lsp` for this window, rooted at `root`. */
	startLsp: (root: string | null) => ipcRenderer.invoke('typst:lsp:start', root),
	send: (json: string) => ipcRenderer.send('typst:lsp:send', json),
	stopLsp: () => ipcRenderer.send('typst:lsp:stop'),
	/** subscribe to server->client messages. Returns an unsubscribe fn. */
	onMessage: (cb: (json: string) => void) => {
		const h = (_e: unknown, json: string) => cb(json);
		ipcRenderer.on('typst:lsp:message', h);
		return () => ipcRenderer.removeListener('typst:lsp:message', h);
	},
	/** subscribe to server exit. Returns an unsubscribe fn. */
	onExit: (cb: (code: number | null) => void) => {
		const h = (_e: unknown, code: number | null) => cb(code);
		ipcRenderer.on('typst:lsp:exit', h);
		return () => ipcRenderer.removeListener('typst:lsp:exit', h);
	}
});

// terminal bridge to the node-pty shells in the main process, keyed by a string `id`
contextBridge.exposeInMainWorld('texpileTerminal', {
	/** whether node-pty loaded (false if it needs `npm run electron:rebuild`). */
	available: () => ipcRenderer.invoke('terminal:available'),
	/** spawn (or reuse) a shell for `id` in `cwd`. Resolves { ok, shell?, error? }. */
	spawn: (opts: { id: string; cwd?: string; cols?: number; rows?: number }) => ipcRenderer.invoke('terminal:spawn', opts),
	/** send keystrokes (append '\r' to run a command). */
	write: (id: string, data: string) => ipcRenderer.send('terminal:input', { id, data }),
	resize: (id: string, cols: number, rows: number) => ipcRenderer.send('terminal:resize', { id, cols, rows }),
	kill: (id: string) => ipcRenderer.send('terminal:kill', { id }),
	/** subscribe to output; cb gets { id, data }. Returns an unsubscribe fn. */
	onData: (cb: (msg: { id: string; data: string }) => void) => {
		const h = (_e: unknown, msg: { id: string; data: string }) => cb(msg);
		ipcRenderer.on('terminal:data', h);
		return () => ipcRenderer.removeListener('terminal:data', h);
	},
	/** subscribe to shell exit; cb gets { id, code }. Returns an unsubscribe fn. */
	onExit: (cb: (msg: { id: string; code: number }) => void) => {
		const h = (_e: unknown, msg: { id: string; code: number }) => cb(msg);
		ipcRenderer.on('terminal:exit', h);
		return () => ipcRenderer.removeListener('terminal:exit', h);
	}
});
