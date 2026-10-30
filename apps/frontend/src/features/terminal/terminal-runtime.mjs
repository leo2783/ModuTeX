// SPDX-License-Identifier: Apache-2.0
// Keep Tauri and xterm out of the initial workbench bundle until the panel is opened.
export async function createTerminalSession(workspaceId, callbacks, signal) {
	const { createTauriTerminalSession } = await import('./tauri-terminal.ts');
	if (signal?.aborted) throw new Error('STALE_WORKSPACE');
	return createTauriTerminalSession(workspaceId, callbacks, signal);
}

export async function createTerminalView(host, handlers) {
	const { createXtermView } = await import('./xterm-view.ts');
	return createXtermView(host, handlers);
}
