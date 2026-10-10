import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { DEFAULT_PREFERENCES, readPreferences, savePreference, subscribePreferences, effectiveAppearance } from '../../src/state/preferences.ts';
const prefix = 'modutex.frontend.preferences.v1.';
const { JSDOM }: { JSDOM: new (html: string, options: { url: string; storageQuota?: number }) => { window: Window & { StorageEvent: typeof StorageEvent; close(): void } } } = createRequire(import.meta.url)('jsdom');

test('field writes preserve sibling settings and legacy storage; corrupt fields are isolated', () => {
	const dom = new JSDOM('', { url: 'https://modutex.test' });
	try {
		const storage = dom.window.localStorage;
		storage.setItem('legacy.preferences', 'unchanged');
		savePreference(storage, 'sourceFontSize', 20);
		savePreference(storage, 'appearance', 'dark');
		savePreference(storage, 'wrapLines', true);
		assert.deepEqual(readPreferences(storage), { preferences: { ...DEFAULT_PREFERENCES, sourceFontSize: 20, appearance: 'dark', wrapLines: true }, invalid: false });
		storage.setItem(prefix + 'sourceFontSize', '25');
		storage.setItem(prefix + 'showLineNumbers', '{broken');
		assert.deepEqual(readPreferences(storage), { preferences: { ...DEFAULT_PREFERENCES, appearance: 'dark', wrapLines: true }, invalid: true });
		assert.throws(() => savePreference(storage, 'sourceFontSize', 12.5), /INVALID_PREFERENCE/);
		assert.equal(storage.getItem('legacy.preferences'), 'unchanged');
		assert.equal(effectiveAppearance('system', true), 'dark');
		assert.equal(effectiveAppearance('light', true), 'light');
	} finally { dom.window.close(); }
});

test('late storage events read authoritative values; unsubscribe revokes listener', () => {
	const dom = new JSDOM('', { url: 'https://modutex.test' });
	try {
		const window = dom.window; const storage = window.localStorage;
		const seen: string[] = [];
		const unsubscribe = subscribePreferences(window as unknown as Window, (value) => seen.push(value.appearance));
		savePreference(storage, 'appearance', 'dark');
		const late = () => new window.StorageEvent('storage', { key: prefix + 'appearance', newValue: '"light"', storageArea: storage });
		window.dispatchEvent(late());
		assert.deepEqual(seen, ['dark']);
		window.dispatchEvent(new window.StorageEvent('storage', { key: 'legacy.preferences', storageArea: storage }));
		window.dispatchEvent(new window.StorageEvent('storage', { key: prefix + 'appearance', storageArea: window.sessionStorage }));
		assert.deepEqual(seen, ['dark']);
		storage.clear();
		window.dispatchEvent(new window.StorageEvent('storage', { key: null, storageArea: storage }));
		assert.deepEqual(seen, ['dark', 'system']);
		unsubscribe(); unsubscribe(); window.dispatchEvent(late());
		assert.deepEqual(seen, ['dark', 'system']);
	} finally { dom.window.close(); }
});

test('real exhausted storage quota does not report a successful save', () => {
	const dom = new JSDOM('', { url: 'https://modutex.test', storageQuota: 0 });
	try {
		assert.throws(() => savePreference(dom.window.localStorage, 'appearance', 'dark'), { name: 'QuotaExceededError' });
		assert.deepEqual(readPreferences(dom.window.localStorage), { preferences: DEFAULT_PREFERENCES, invalid: false });
	} finally { dom.window.close(); }
});
