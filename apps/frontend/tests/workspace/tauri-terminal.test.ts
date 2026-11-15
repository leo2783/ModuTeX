// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTauriTerminalSession } from '../../src/features/terminal/tauri-terminal.ts';

test('createTauriTerminalSession rejects non-Tauri runtime and aborted signals before IPC', () => {
	const globalRecord = globalThis as Record<string, unknown>;
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const previousIsTauri = Object.getOwnPropertyDescriptor(globalThis, 'isTauri');

	try {
		delete globalRecord.window;
		delete globalRecord.isTauri;

		assert.throws(
			() => createTauriTerminalSession('ws-1', {}),
			(err: { code?: string }) => err.code === 'TERMINAL_UNAVAILABLE'
		);

		const fakeWindow = {
			__TAURI_INTERNALS__: {
				metadata: {
					currentWindow: { label: 'main' },
					currentWebview: { label: 'main', windowLabel: 'main' }
				},
				invoke: async () => {
					throw new Error('should not invoke when signal is already aborted');
				}
			}
		};
		Object.defineProperty(globalThis, 'window', {
			value: fakeWindow,
			configurable: true,
			writable: true
		});
		Object.defineProperty(globalThis, 'isTauri', {
			value: true,
			configurable: true,
			writable: true
		});

		const abort = new AbortController();
		abort.abort();
		assert.throws(
			() => createTauriTerminalSession('ws-1', {}, abort.signal),
			(err: { code?: string }) => err.code === 'STALE_WORKSPACE'
		);
	} finally {
		if (previousWindow === undefined) delete globalRecord.window;
		else Object.defineProperty(globalThis, 'window', previousWindow);
		if (previousIsTauri === undefined) delete globalRecord.isTauri;
		else Object.defineProperty(globalThis, 'isTauri', previousIsTauri);
	}
});
