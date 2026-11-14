// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativePreferencesAdapter } from '../../src/state/native-preferences.ts';
import { DEFAULT_PREFERENCES } from '../../src/state/preferences.ts';

test('createNativePreferencesAdapter serializes read, set, importLegacy, and reset across rejections', async () => {
	const globalRecord = globalThis as Record<string, unknown>;
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const order: string[] = [];

	let releaseFirstSet!: () => void;
	const firstSetGate = new Promise<void>((resolve) => {
		releaseFirstSet = resolve;
	});

	const snapshot = {
		preferences: { ...DEFAULT_PREFERENCES, appearance: 'dark' as const },
		invalid: false,
		recoveredFields: []
	};

	try {
		const fakeWindow = {
			__TAURI_INTERNALS__: {
				invoke: async (cmd: string, args?: Record<string, unknown>) => {
					order.push(`start:${cmd}`);
					if (cmd === 'frontend_settings_set') {
						const req = args?.request as { key: string; value: unknown };
						if (req.value === 'dark') {
							await firstSetGate;
							order.push(`end:${cmd}:dark`);
							throw new Error('simulated IPC failure');
						}
						order.push(`end:${cmd}:${String(req.value)}`);
						return snapshot;
					}
					if (cmd === 'frontend_settings_import') {
						order.push(`end:${cmd}`);
						return {
							...snapshot,
							imported: true,
							alreadyImported: false,
							legacyElectronFound: true,
							remainingElectronSettings: []
						};
					}
					order.push(`end:${cmd}`);
					return snapshot;
				}
			}
		};
		Object.defineProperty(globalThis, 'window', {
			value: fakeWindow,
			configurable: true,
			writable: true
		});

		const adapter = createNativePreferencesAdapter();
		const firstSet = adapter.set('appearance', 'dark');
		const secondSet = adapter.set('appearance', 'light');
		const readCall = adapter.read();
		const importCall = adapter.importLegacy({ appearance: '"dark"' });
		const resetCall = adapter.reset();

		await new Promise((resolve) => setTimeout(resolve, 10));
		assert.deepEqual(order, ['start:frontend_settings_set']);

		releaseFirstSet();
		await assert.rejects(firstSet, /simulated IPC failure/);
		const secondRes = await secondSet;
		assert.equal(secondRes.preferences.appearance, 'dark');
		await readCall;
		const imported = await importCall;
		assert.equal(imported.imported, true);
		await resetCall;

		assert.deepEqual(order, [
			'start:frontend_settings_set',
			'end:frontend_settings_set:dark',
			'start:frontend_settings_set',
			'end:frontend_settings_set:light',
			'start:frontend_settings_read',
			'end:frontend_settings_read',
			'start:frontend_settings_import',
			'end:frontend_settings_import',
			'start:frontend_settings_reset',
			'end:frontend_settings_reset'
		]);
	} finally {
		if (previousWindow === undefined) {
			delete globalRecord.window;
		} else {
			Object.defineProperty(globalThis, 'window', previousWindow);
		}
	}
});
