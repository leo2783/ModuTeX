// SPDX-License-Identifier: Apache-2.0
// The terminal adapter calls only the registered, typed frontend terminal commands.
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import {
	createTerminalController,
	TerminalSessionError,
	type TerminalCallbacks,
	type TerminalController
} from './session.mjs';

export function createTauriTerminalSession(
	workspaceId: string,
	callbacks: TerminalCallbacks,
	signal?: AbortSignal
): TerminalController {
	if (!isTauri()) {
		throw new TerminalSessionError(
			'TERMINAL_UNAVAILABLE',
			'The terminal is available only in the desktop application.'
		);
	}
	if (signal?.aborted) {
		throw new TerminalSessionError('STALE_WORKSPACE', 'workspace is no longer active');
	}

	const ownerId = getCurrentWebviewWindow().label;
	return createTerminalController({
		ownerId,
		workspaceId,
		callbacks,
		signal,
		invokeCommand: (command, args) => invoke<unknown>(command, args),
		listenEvent: async (eventName, receive) => {
			const unlisten = await listen<unknown>(eventName, (event) => {
				receive(event.payload);
			});
			return unlisten;
		}
	});
}
