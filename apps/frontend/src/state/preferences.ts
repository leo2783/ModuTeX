import type { Language } from '../i18n/text.ts';
export interface Preferences {
	readonly language: Language;
	readonly appearance: 'system' | 'light' | 'dark';
	readonly sourceFontSize: number;
	readonly showLineNumbers: boolean;
	readonly wrapLines: boolean;
	readonly compileShortcut: 'mod-enter' | 'mod-shift-b' | 'none';
}
export const DEFAULT_PREFERENCES: Preferences = Object.freeze({ language: 'zh-Hant', appearance: 'system', sourceFontSize: 14, showLineNumbers: true, wrapLines: false, compileShortcut: 'mod-enter' });
const PREFIX = 'modutex.frontend.preferences.v1.';
const keys = Object.keys(DEFAULT_PREFERENCES) as (keyof Preferences)[];
export function decodePreference<K extends keyof Preferences>(key: K, value: unknown): Preferences[K] {
	const valid = key === 'language' ? ['zh-Hant', 'en'].includes(value as string) : key === 'appearance' ? ['system', 'light', 'dark'].includes(value as string) : key === 'sourceFontSize'
		? typeof value === 'number' && Number.isInteger(value) && value >= 12 && value <= 24 : key === 'compileShortcut'
			? ['mod-enter', 'mod-shift-b', 'none'].includes(value as string) : typeof value === 'boolean';
	if (!valid || !keys.includes(key)) throw new Error('INVALID_PREFERENCE');
	return value as Preferences[K];
}
export function readPreferences(storage: Pick<Storage, 'getItem'>): { preferences: Preferences; invalid: boolean } {
	const preferences = { ...DEFAULT_PREFERENCES }; let invalid = false;
	for (const key of keys) {
		const encoded = storage.getItem(PREFIX + key);
		if (encoded === null) continue;
		try {
			if (encoded.length > 64) throw new Error('PREFERENCE_SIZE');
			Object.assign(preferences, { [key]: decodePreference(key, JSON.parse(encoded)) });
		} catch { invalid = true; } // Corrupt one field cannot overwrite valid peer fields or legacy settings.
	}
	return { preferences: Object.freeze(preferences), invalid };
}
export function savePreference<K extends keyof Preferences>(storage: Pick<Storage, 'setItem'>, key: K, value: Preferences[K]): void {
	storage.setItem(PREFIX + key, JSON.stringify(decodePreference(key, value)));
}
export type RestorePreferencesResult =
	| { readonly status: 'restored'; readonly preferences: Preferences; readonly invalid: boolean }
	| { readonly status: 'partial'; readonly preferences: Preferences; readonly invalid: boolean }
	| { readonly status: 'unreadable' };

/** Removes only owned preferences keys, preserving unrelated and legacy storage, and re-reads actual storage. */
export function restorePreferences(storage: Pick<Storage, 'getItem' | 'removeItem'>): RestorePreferencesResult {
	let removalFailed = false;
	for (const key of keys) {
		try {
			storage.removeItem(PREFIX + key);
		} catch {
			removalFailed = true;
		}
	}
	let reread: { preferences: Preferences; invalid: boolean };
	try {
		reread = readPreferences(storage);
	} catch {
		return { status: 'unreadable' };
	}
	const hasNonDefault = keys.some((key) => reread.preferences[key] !== DEFAULT_PREFERENCES[key]);
	if (removalFailed || reread.invalid || hasNonDefault) {
		return { status: 'partial', preferences: reread.preferences, invalid: reread.invalid };
	}
	return { status: 'restored', preferences: reread.preferences, invalid: false };
}
export function effectiveAppearance(value: Preferences['appearance'], systemDark: boolean): 'light' | 'dark' {
	decodePreference('appearance', value);
	return value === 'system' ? systemDark ? 'dark' : 'light' : value;
}
export function subscribePreferences(target: Window, changed: (preferences: Preferences, invalid: boolean) => void): () => void {
	const storage = target.localStorage; let disposed = false;
	const handler = (event: StorageEvent) => {
		if (disposed || event.storageArea !== storage || (event.key !== null && !keys.some((key) => event.key === PREFIX + key))) return;
		const result = readPreferences(storage); changed(result.preferences, result.invalid);
	};
	target.addEventListener('storage', handler);
	return () => { if (!disposed) { disposed = true; target.removeEventListener('storage', handler); } };
}
