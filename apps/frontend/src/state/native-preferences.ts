import { invoke } from '@tauri-apps/api/core';
import type { Preferences } from './preferences.ts';

export interface NativePreferencesSnapshot {
	readonly preferences: Preferences;
	readonly invalid: boolean;
	readonly recoveredFields: readonly string[];
}

export interface NativePreferencesImport extends NativePreferencesSnapshot {
	readonly imported: boolean;
	readonly alreadyImported: boolean;
	readonly legacyElectronFound: boolean;
	readonly remainingElectronSettings: readonly string[];
}

/** Serializes preference IPC in this window so an earlier write cannot finish after a later one. */
export function createNativePreferencesAdapter() {
	let tail: Promise<void> = Promise.resolve();
	const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
		const pending = tail.then(operation);
		tail = pending.then(() => undefined, () => undefined);
		return pending;
	};

	return Object.freeze({
		importLegacy(legacyRecord: Readonly<Record<string, string>>): Promise<NativePreferencesImport> {
			return enqueue(() => invoke<NativePreferencesImport>('frontend_settings_import', {
				request: { legacyRecord }
			}));
		},
		read(): Promise<NativePreferencesSnapshot> {
			return enqueue(() => invoke<NativePreferencesSnapshot>('frontend_settings_read'));
		},
		set(key: keyof Preferences, value: unknown): Promise<NativePreferencesSnapshot> {
			return enqueue(() => invoke<NativePreferencesSnapshot>('frontend_settings_set', {
				request: { key, value }
			}));
		},
		reset(): Promise<NativePreferencesSnapshot> {
			return enqueue(() => invoke<NativePreferencesSnapshot>('frontend_settings_reset'));
		}
	});
}
