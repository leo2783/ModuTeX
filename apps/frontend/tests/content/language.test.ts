import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { DEFAULT_PREFERENCES, decodePreference, readPreferences, savePreference } from '../../src/state/preferences.ts';
import { text } from '../../src/i18n/text.ts';

const prefix = 'modutex.frontend.preferences.v1.';
const { JSDOM }: { JSDOM: new (html: string, options: { url: string; storageQuota?: number }) => { window: Window & { StorageEvent: typeof StorageEvent; close(): void } } } = createRequire(import.meta.url)('jsdom');

test('language persistence isolates invalid values and preserves other settings', () => {
	const dom = new JSDOM('', { url: 'https://modutex.test' });
	try {
		const storage = dom.window.localStorage;
		storage.setItem('legacy.preferences', 'unchanged');
		savePreference(storage, 'appearance', 'dark');
		savePreference(storage, 'wrapLines', true);

		for (const language of ['en', 'zh-Hant'] as const) {
			savePreference(storage, 'language', language);
			assert.equal(storage.getItem(prefix + 'language'), JSON.stringify(language));
			assert.deepEqual(readPreferences(storage), {
				preferences: { ...DEFAULT_PREFERENCES, language, appearance: 'dark', wrapLines: true },
				invalid: false,
			});
		}

		const overlong = `"${'x'.repeat(63)}"`;
		assert.equal(overlong.length, 65);
		for (const encoded of ['"en-US"', '"zh-CN"', 'null', 'true', '{broken', overlong]) {
			storage.setItem(prefix + 'language', encoded);
			assert.deepEqual(readPreferences(storage), {
				preferences: { ...DEFAULT_PREFERENCES, appearance: 'dark', wrapLines: true },
				invalid: true,
			});
		}
		for (const candidate of ['en-US', 'zh-CN', null, true, '{broken', 'x'.repeat(63)]) {
			assert.throws(() => decodePreference('language', candidate), /INVALID_PREFERENCE/);
		}
		assert.equal(storage.getItem('legacy.preferences'), 'unchanged');
	} finally { dom.window.close(); }
});

test('text locale calls are independent and preference reads are frozen snapshots', () => {
	const dom = new JSDOM('', { url: 'https://modutex.test' });
	try {
		const storage = dom.window.localStorage;
		savePreference(storage, 'language', 'en');
		savePreference(storage, 'appearance', 'dark');
		const english = readPreferences(storage).preferences;
		assert.equal(Object.isFrozen(english), true);

		assert.equal(text('en', '繁體', 'English'), 'English');
		assert.equal(text('zh-Hant', '繁體', 'English'), '繁體');
		assert.equal(text(english.language, '繁體', 'English'), 'English');

		savePreference(storage, 'language', 'zh-Hant');
		savePreference(storage, 'appearance', 'light');
		const traditional = readPreferences(storage).preferences;
		assert.notStrictEqual(traditional, english);
		assert.equal(Object.isFrozen(traditional), true);
		assert.equal(english.language, 'en');
		assert.equal(english.appearance, 'dark');
		assert.equal(traditional.language, 'zh-Hant');
		assert.equal(traditional.appearance, 'light');
		assert.equal(text(traditional.language, '繁體', 'English'), '繁體');
		assert.equal(text(english.language, '繁體', 'English'), 'English');
	} finally { dom.window.close(); }
});
