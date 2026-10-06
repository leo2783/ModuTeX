// The renderer half of the tinymist language server: a Transport over the preload bridge, and one
// LSPClient per workspace root.
//
// Everything above this file talks to @codemirror/lsp-client, never to tinymist directly. That is
// deliberate: the intellisense is an integration against the PROTOCOL, so a different Typst server
// would be a change here and nowhere else. (Live preview, if it is ever added, is not like this -
// tinymist's preview is its own private protocol, and would be genuine lock-in.)
import { LSPClient, languageServerExtensions, languageServerSupport } from '@codemirror/lsp-client';
import type { Transport } from '@codemirror/lsp-client';
import type { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';

// @codemirror/lsp-client caps its SIGNATURE tooltips but not its hover tooltips, and tinymist's
// hover for a builtin is the function's whole documentation page - unconstrained, that renders
// as a window-wide wall of text. Same box the signature tooltip gets, a little roomier.
const lspHoverTheme = EditorView.baseTheme({
	'.cm-lsp-hover-tooltip': {
		maxWidth: '38em',
		maxHeight: '16em',
		overflow: 'auto',
		borderRadius: '6px',
		padding: '4px 10px',
		fontSize: '90%',
		lineHeight: '1.45'
	},
	'.cm-lsp-hover-tooltip pre': {
		overflowX: 'auto'
	}
});

/**
 * An absolute filesystem path as a file:// URI.
 *
 * Windows needs the extra slash and a forward-slashed drive path (`file:///C:/a/b`); every path
 * segment is encoded so a folder with a space or a `#` in it doesn't produce a URI the server
 * reads as something else.
 */
export function fileUri(p: string): string {
	const norm = p.replace(/\\/g, '/');
	const withRoot = /^[A-Za-z]:/.test(norm) ? `/${norm}` : norm;
	return (
		'file://' +
		withRoot
			.split('/')
			.map((seg) => (/^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
			.join('/')
	);
}

const bridge = () => (typeof window !== 'undefined' ? window.texpileTypst : undefined);

/** True when the tinymist bridge exists at all (it does not in the browser dev server). */
export const typstBridgeAvailable = () => !!bridge();

function createTransport(): Transport {
	const handlers = new Set<(value: string) => void>();
	const b = bridge();
	// one subscription to the bridge, fanned out here: the client may subscribe and unsubscribe
	// repeatedly over its life, and re-registering an IPC listener each time would leak them
	b?.onMessage((json) => {
		if (handleShowDocument(json, b)) return;
		observeDiagnostics(json);
		for (const h of handlers) h(json);
	});
	return {
		send(message: string) {
			bridge()?.send(message);
		},
		subscribe(handler: (value: string) => void) {
			handlers.add(handler);
		},
		unsubscribe(handler: (value: string) => void) {
			handlers.delete(handler);
		}
	};
}

interface Session {
	root: string | null;
	client: LSPClient;
	/** resolves once the server process is up; the client's own `initializing` follows it */
	started: Promise<boolean>;
}

let session: Session | null = null;

/**
 * How many open editors are using the server.
 *
 * It costs ~90MB resident with one document open, which is worth reclaiming when the last .typ is
 * closed - a LaTeX project that once opened a .typ should not hold a Typst compiler all afternoon.
 * It is never started for a project without a .typ in the first place: only typstLspExtension
 * starts it, and only a .typ editor calls that.
 */
let holders = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

// Shutting down the instant the count hits zero would thrash: switching between two .typ files
// destroys one editor before creating the next, and a restart costs ~1.5s plus re-initialising the
// project. Wait long enough that a file switch never pays it.
const IDLE_GRACE_MS = 30_000;

function cancelIdleStop(): void {
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
}

/**
 * The client for `root`, starting the server if needed. Returns null when tinymist is missing or
 * the bridge isn't there — callers then simply add no LSP extension, and the editor still works.
 */
export async function typstClient(root: string | null): Promise<LSPClient | null> {
	const b = bridge();
	if (!b) return null;
	if (session && session.root === root) return (await session.started) ? session.client : null;

	stopTypstClient();

	const client = new LSPClient({
		rootUri: root ? fileUri(root) : undefined,
		extensions: languageServerExtensions(),
		notificationHandlers: {
			// tinymist's click-to-jump: the framed preview reports the span the user clicked over its
			// own websocket, the server resolves it to a file and range, and it lands here. Same
			// channel tinymist's VS Code extension listens on.
			'tinymist/preview/scrollSource': (_client, params: PreviewJumpInfo) => {
				jumpHandler?.(params);
				return true;
			}
		},
		// tinymist can take a moment on a cold project (it reads fonts and the package cache);
		// the 3s default times out completions that would have arrived
		timeout: 10000
	});

	const started = b.startLsp(root).then((res) => {
		if (!res.ok) return false;
		client.connect(createTransport());
		return true;
	});

	session = { root, client, started };
	return (await started) ? client : null;
}

/** what `tinymist.doStartPreview` answers with */
interface StartPreviewResponse {
	staticServerAddr?: string;
	dataPlanePort?: number;
	isPrimary?: boolean;
}

/** Where a started preview can be reached. */
export interface TypstPreviewTarget {
	/**
	 * `host:port` serving both tinymist's preview page and its data plane websocket.
	 *
	 * tinymist puts the HTTP server and the websocket on the same port, which is what lets the page
	 * find its own socket; we pass this host to both the fetch and the substitution.
	 */
	host: string;
	/** the handle for steering this preview afterwards, e.g. killTypstPreview */
	taskId: string;
}

/**
 * Ask the preview to scroll to a source position, so it follows the caret.
 *
 * The reply is empty either way: the server resolves the position against the compiled document and
 * pushes a `jump` frame down the DATA PLANE, which the framed viewer handles itself. If the position
 * does not correspond to anything in the output, tinymist's resolve_source_loc simply returns None
 * and nothing moves - there is no error to surface, so a silent no-op here is expected, not a fault.
 *
 * `line` and `character` are ZERO-based, as in LSP positions. There is deliberately no default for
 * `character`: the server only resolves positions whose syntax leaf (the one ENDING at the cursor)
 * is text, so column 0 - right after a linebreak - never resolves and the call does nothing.
 */
export async function scrollTypstPreview(
	root: string | null,
	taskId: string,
	file: string,
	line: number,
	character: number
): Promise<void> {
	const client = await typstClient(root);
	if (!client) return;
	try {
		await client.request<{ command: string; arguments: unknown[] }, unknown>('workspace/executeCommand', {
			command: 'tinymist.scrollPreview',
			arguments: [taskId, { event: 'panelScrollTo', filepath: file, line, character }]
		});
	} catch {
		// a preview that has gone away must not break typing
	}
}

/**
 * Stop a preview we started.
 *
 * Closing the websocket only detaches the viewer: the server keeps compiling the document and
 * holding its render state, so without this every open-and-close would leak one live preview into
 * the language server for the rest of the session.
 */
export async function killTypstPreview(root: string | null, taskId: string): Promise<void> {
	const client = await typstClient(root);
	// the reference startTypstPreview took goes back either way: if the client is already gone the
	// preview is gone with it, and holding a count for it would pin a dead server
	try {
		if (client)
			await client.request<{ command: string; arguments: unknown[] }, unknown>('workspace/executeCommand', {
				command: 'tinymist.doKillPreview',
				arguments: [taskId]
			});
	} catch {
		// the server may have dropped the task already (folder switch, server restart); nothing to do
	} finally {
		releaseTypstLsp();
	}
}

/**
 * Start tinymist's incremental preview for `file`.
 *
 * Started through the LANGUAGE SERVER rather than as its own `tinymist preview` process, and that
 * distinction is the whole feature: a standalone preview watches the filesystem, so it would only
 * ever show saved text. Started this way it renders the server's in-memory document, which our
 * client already keeps current through textDocument/didChange on every keystroke. No save, no
 * debounce, no file watching.
 *
 * `--data-plane-host 127.0.0.1:0` asks for an ephemeral port, so a second window cannot collide
 * with the default 23625 (the flag is absent from `tinymist preview --help` in 0.15.2 but is
 * accepted here).
 */
export async function startTypstPreview(root: string | null, file: string): Promise<TypstPreviewTarget | null> {
	// A live preview KEEPS THE SERVER ALIVE. Without this the count only ever tracked open .typ
	// source editors, so leaving source mode (a tab switch, or switching to the visual editor)
	// dropped it to zero and reaped tinymist 30s later - out from under a preview still on screen.
	// The viewer then sat on its last render, retrying a refused socket forever, and every jump
	// died with "WebSocket is already in CLOSING or CLOSED state". Released in killTypstPreview.
	holders++;
	cancelIdleStop();
	const client = await typstClient(root);
	if (!client) {
		releaseTypstLsp();
		return null;
	}
	// The task id is ours to invent - the server just records it - and it is the handle every later
	// command needs, so a preview started without one can be watched but never steered.
	const taskId = `texpile-${Math.random().toString(36).slice(2, 9)}`;
	try {
		const res = await client.request<{ command: string; arguments: unknown[] }, StartPreviewResponse>('workspace/executeCommand', {
			command: 'tinymist.doStartPreview',
			arguments: [['--task-id', taskId, '--data-plane-host', '127.0.0.1:0', '--no-open', file]]
		});
		const host = res?.staticServerAddr ?? (res?.dataPlanePort ? `127.0.0.1:${res.dataPlanePort}` : null);
		// only a preview that actually started keeps its reference; every other exit hands it back,
		// or a failed start would pin the server for the rest of the session
		if (!host) {
			releaseTypstLsp();
			return null;
		}
		return { host, taskId };
	} catch (e) {
		releaseTypstLsp();
		throw e;
	}
}

/**
 * Compile the document and write it out as a PDF, returning the written file's absolute path.
 *
 * `tinymist.exportPdf` is the same command tinymist's VS Code extension binds its Export PDF
 * button to. Like the preview, it renders the server's IN-MEMORY document - no save needed.
 * Errors propagate: unlike a follow scroll, a failed export is something the user asked for and
 * must hear about.
 *
 * `outDir` is the ROOT-RELATIVE directory to write into - pass the folder's build directory so
 * this lands where Compile would have put it, not tinymist's default of "next to the entry
 * file". It has to travel as configuration: where to write is the server-level `outputPath`
 * pattern, and the export command has no per-call override. Pushed before every export;
 * idempotent, and the request that follows it on the same pipe is what reads it.
 */
export async function exportTypstPdf(root: string | null, file: string, outDir?: string | null): Promise<string | null> {
	const client = await typstClient(root);
	if (!client) return null;
	const dir = (outDir ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
	const pattern = dir && dir !== '.' ? `$root/${dir}/$name` : '$root/$dir/$name';
	client.notification('workspace/didChangeConfiguration', { settings: { outputPath: pattern } });
	const res = await client.request<{ command: string; arguments: unknown[] }, { path?: string | null } | null>('workspace/executeCommand', {
		command: 'tinymist.exportPdf',
		arguments: [file]
	});
	return res?.path ?? null;
}

/**
 * Subscribe to "the user clicked somewhere in the preview; put the caret there".
 *
 * The framed page cannot reach us directly and does not need to: it sends the span it was clicked
 * on over the data plane, tinymist resolves it, and the answer arrives here as a plain LSP
 * notification. This is exactly how tinymist's own VS Code extension implements click-to-jump.
 *
 * Positions are ZERO-based `[line, character]`, and either end may be null when the span could not
 * be resolved to a range.
 */
export interface PreviewJumpInfo {
	filepath: string;
	start: [number, number] | null;
	end: [number, number] | null;
}

/**
 * Where a preview jump goes. Held at module scope rather than passed to typstClient because the
 * handler is fixed at CONSTRUCTION - LSPClient takes notificationHandlers as config, and the pane
 * that wants the jumps mounts long after the client exists.
 */
let jumpHandler: ((jump: PreviewJumpInfo) => void) | null = null;

/** Route preview clicks to `handler`, or pass null to stop. */
export function setPreviewJumpHandler(handler: ((jump: PreviewJumpInfo) => void) | null): void {
	jumpHandler = handler;
}

/** file:// URI back to a plain path, undoing fileUri() */
function pathFromUri(uri: string): string {
	try {
		const p = decodeURIComponent(new URL(uri).pathname);
		return /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p;
	} catch {
		return uri;
	}
}

/**
 * Answer the server's `window/showDocument` request, which is how a click in the preview reaches us.
 *
 * Intercepted at the TRANSPORT rather than through the client's notificationHandlers, because this
 * is a REQUEST and not a notification - the server waits for a reply, and an unanswered one would
 * leave it hanging. The client has no hook for server-initiated requests, but the transport is ours.
 *
 * tinymist has a `customizedShowDocument` mode that sends a bespoke notification instead. We
 * deliberately do not turn it on: showDocument is the standard LSP method, so this keeps working if
 * that option ever goes away.
 *
 * Returns true when the message was ours to answer and should not be forwarded on.
 */
function handleShowDocument(json: string, b: NonNullable<ReturnType<typeof bridge>>): boolean {
	let msg: {
		id?: number | string;
		method?: string;
		params?: { uri?: string; selection?: { start?: { line?: number; character?: number } } };
	};
	try {
		msg = JSON.parse(json);
	} catch {
		return false;
	}
	if (msg.method !== 'window/showDocument' || msg.id === undefined) return false;

	const uri = msg.params?.uri;
	if (uri && jumpHandler) {
		const start = msg.params?.selection?.start;
		jumpHandler({
			filepath: pathFromUri(uri),
			start: start ? [start.line ?? 0, start.character ?? 0] : null,
			end: null
		});
	}
	// the server blocks on this reply
	b.send(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { success: !!(uri && jumpHandler) } }));
	return true;
}

/** One LSP diagnostic, as tinymist publishes it; just what the Problems panel needs. */
export interface TypstDiagnostic {
	range: { start: { line: number; character: number }; end?: { line: number; character: number } };
	/** 1 error, 2 warning, 3 info, 4 hint */
	severity?: number;
	message: string;
}

let diagnosticsHandler: ((path: string, diags: TypstDiagnostic[]) => void) | null = null;

/**
 * Subscribe to tinymist's live diagnostics, delivered per FILE - an empty list clears that file,
 * which is LSP's own clearing convention and must be forwarded, not filtered.
 *
 * OBSERVED at the transport, never consumed: the same notification drives the editor's squiggles
 * through the LSP client, and taking it out of the stream would kill those. The Problems panel
 * needs its own tap because in Preview mode no shell compile ever runs, so the log watcher that
 * normally fills the panel has nothing to parse.
 */
export function setTypstDiagnosticsHandler(h: ((path: string, diags: TypstDiagnostic[]) => void) | null): void {
	diagnosticsHandler = h;
}

function observeDiagnostics(json: string): void {
	// cheap substring gate first: this runs on EVERY server message, most of which are not this
	if (!diagnosticsHandler || !json.includes('"textDocument/publishDiagnostics"')) return;
	let msg: { method?: string; params?: { uri?: string; diagnostics?: TypstDiagnostic[] } };
	try {
		msg = JSON.parse(json);
	} catch {
		return;
	}
	if (msg.method !== 'textDocument/publishDiagnostics' || !msg.params?.uri) return;
	diagnosticsHandler(pathFromUri(msg.params.uri), msg.params.diagnostics ?? []);
}

/** Tear the server down (folder switch, no editors left, or the window going away). */
export function stopTypstClient(): void {
	cancelIdleStop();
	holders = 0;
	if (!session) return;
	try {
		session.client.disconnect();
	} catch {
		/* never connected, or already gone */
	}
	bridge()?.stopLsp();
	session = null;
}

/**
 * One open .typ editor has gone away.
 *
 * The server stops once nothing is using it, after a grace period — see IDLE_GRACE_MS.
 */
export function releaseTypstLsp(): void {
	holders = Math.max(0, holders - 1);
	if (holders > 0) return;
	cancelIdleStop();
	idleTimer = setTimeout(() => {
		idleTimer = null;
		// a new editor may have taken a reference while the timer ran
		if (holders === 0) stopTypstClient();
	}, IDLE_GRACE_MS);
}

/**
 * The CodeMirror extension that wires one open .typ file to the server, or null when there is no
 * server to wire it to. `languageID` is tinymist's own id for the dialect.
 */
export async function typstLspExtension(root: string | null, filePath: string): Promise<Extension | null> {
	// take the reference BEFORE awaiting: a pending idle-stop from the editor we are replacing must
	// be cancelled now, not after a 1.5s server start it would otherwise race
	holders++;
	cancelIdleStop();
	const client = await typstClient(root);
	if (!client) {
		releaseTypstLsp();
		return null;
	}
	return [languageServerSupport(client, fileUri(filePath), 'typst'), lspHoverTheme];
}
