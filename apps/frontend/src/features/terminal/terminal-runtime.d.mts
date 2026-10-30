import type { TerminalCallbacks, TerminalController } from './session.mjs';
import type { TerminalView, TerminalViewHandlers } from './xterm-view.ts';

export function createTerminalSession(
	workspaceId: string,
	callbacks: TerminalCallbacks,
	signal?: AbortSignal
): Promise<TerminalController>;

export function createTerminalView(
	host: HTMLElement,
	handlers: TerminalViewHandlers
): Promise<TerminalView>;
