// Talking to a renderer for the things its state cache cannot answer.
//
// Two directions, deliberately different:
//
//   commands (open_file, show_diff, set_view_mode) are fire-and-forget. The agent is steering the
//   UI; there is nothing to return, and making it wait for a renderer that may be mid-parse would
//   add latency for no information.
//
//   requests (get_unsaved) need a reply, and carry content that would be wasteful to push. A dirty
//   2 MB paper pushed on every keystroke is a lot of IPC for something read rarely, so it is pulled
//   on demand instead - with a timeout, because the renderer really can be blocked for a second or
//   more building a large document.
import type { BrowserWindow } from 'electron';

export type McpCommand =
	| { kind: 'open_file'; path: string; line?: number }
	| { kind: 'show_diff'; path?: string }
	| { kind: 'set_view_mode'; mode: 'visual' | 'source' | 'diff' };

let nextId = 1;
const waiting = new Map<number, (data: unknown) => void>();

/** the renderer answering an earlier request; unknown ids are stale replies past their timeout */
export function deliverResponse(id: number, data: unknown): void {
	const resolve = waiting.get(id);
	if (!resolve) return;
	waiting.delete(id);
	resolve(data);
}

/**
 * Ask a renderer for something, resolving null if it does not answer in time. Null rather than a
 * rejection: "the editor was too busy to say" is a normal answer for a tool call, and an agent can
 * act on it (fall back to reading disk) far more usefully than on an error.
 */
export function request(win: BrowserWindow, kind: string, args?: Record<string, unknown>, timeoutMs = 2000): Promise<unknown> {
	const id = nextId++;
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			waiting.delete(id);
			resolve(null);
		}, timeoutMs);
		waiting.set(id, (data) => {
			clearTimeout(timer);
			resolve(data);
		});
		win.webContents.send('mcp:request', { id, kind, args: args ?? {} });
	});
}

export function sendCommand(win: BrowserWindow, cmd: McpCommand): void {
	win.webContents.send('mcp:command', cmd);
}
