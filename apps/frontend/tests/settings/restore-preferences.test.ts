import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import {
	DEFAULT_PREFERENCES,
	readPreferences,
	savePreference,
	restorePreferences,
	subscribePreferences,
	type Preferences
} from '../../src/state/preferences.ts';

const prefix = 'modutex.frontend.preferences.v1.';
const { JSDOM }: { JSDOM: new (html: string, options: { url: string; storageQuota?: number }) => { window: Window & { StorageEvent: typeof StorageEvent; close(): void } } } = createRequire(import.meta.url)('jsdom');

test('restorePreferences removes only owned known preferences keys and preserves unrelated and legacy storage', () => {
	const dom = new JSDOM('', { url: 'https://modutex.test' });
	try {
		const storage = dom.window.localStorage;
		// Populate unrelated and legacy storage keys
		storage.setItem('legacy.preferences', 'legacy-v0-config');
		storage.setItem('unrelated.user.session', 'active-token-9988');
		storage.setItem('modutex.frontend.document.scratchpad', 'draft content');

		// Populate custom preferences across all supported keys
		savePreference(storage, 'appearance', 'dark');
		savePreference(storage, 'language', 'en');
		savePreference(storage, 'sourceFontSize', 22);
		savePreference(storage, 'showLineNumbers', false);
		savePreference(storage, 'wrapLines', true);
		savePreference(storage, 'compileShortcut', 'mod-shift-b');

		// Pre-condition: preferences are stored and verified
		const before = readPreferences(storage);
		assert.equal(before.invalid, false);
		assert.equal(before.preferences.appearance, 'dark');
		assert.equal(before.preferences.language, 'en');
		assert.equal(before.preferences.sourceFontSize, 22);
		assert.equal(before.preferences.showLineNumbers, false);
		assert.equal(before.preferences.wrapLines, true);
		assert.equal(before.preferences.compileShortcut, 'mod-shift-b');

		// Execute restore
		const result = restorePreferences(storage);

		// Verified outcomes
		assert.equal(result.status, 'restored');
		if (result.status === 'restored') {
			assert.equal(result.invalid, false);
			assert.deepEqual(result.preferences, DEFAULT_PREFERENCES);
		}

		// Owned keys must be completely removed from underlying storage
		assert.equal(storage.getItem(prefix + 'appearance'), null);
		assert.equal(storage.getItem(prefix + 'language'), null);
		assert.equal(storage.getItem(prefix + 'sourceFontSize'), null);
		assert.equal(storage.getItem(prefix + 'showLineNumbers'), null);
		assert.equal(storage.getItem(prefix + 'wrapLines'), null);
		assert.equal(storage.getItem(prefix + 'compileShortcut'), null);

		// Unrelated and legacy keys must be strictly preserved
		assert.equal(storage.getItem('legacy.preferences'), 'legacy-v0-config');
		assert.equal(storage.getItem('unrelated.user.session'), 'active-token-9988');
		assert.equal(storage.getItem('modutex.frontend.document.scratchpad'), 'draft content');
	} finally {
		dom.window.close();
	}
});

test('real failed-storage path on partial removeItem failure returns authoritative reread without fake success', () => {
	const dom = new JSDOM('', { url: 'https://modutex.test' });
	try {
		const baseStorage = dom.window.localStorage;
		baseStorage.setItem('legacy.data', 'preserve-always');
		savePreference(baseStorage, 'appearance', 'dark');
		savePreference(baseStorage, 'language', 'en');
		savePreference(baseStorage, 'sourceFontSize', 18);
		savePreference(baseStorage, 'showLineNumbers', false);

		// Fault injection around real JSDOM storage: removeItem throws for a specific key
		const failingKey = prefix + 'appearance';
		const failingStorage: Pick<Storage, 'getItem' | 'removeItem'> = {
			getItem(key: string) {
				return baseStorage.getItem(key);
			},
			removeItem(key: string) {
				if (key === failingKey) {
					throw new Error('EACCES: storage key locked');
				}
				baseStorage.removeItem(key);
			}
		};

		const result = restorePreferences(failingStorage);

		// Must return 'partial' to indicate partial failure with successful authoritative reread
		assert.equal(result.status, 'partial');
		if (result.status === 'partial') {
			// Re-read actual storage: the locked key remains in its stored state,
			// while successfully removed keys revert to defaults
			assert.equal(result.preferences.appearance, 'dark');
			assert.equal(result.preferences.language, 'zh-Hant');
			assert.equal(result.preferences.sourceFontSize, 14);
			assert.equal(result.preferences.showLineNumbers, true);

			// Check against direct storage read
			const directRead = readPreferences(baseStorage);
			assert.deepEqual(result.preferences, directRead.preferences);
		}

		// Unrelated keys preserved
		assert.equal(baseStorage.getItem('legacy.data'), 'preserve-always');
	} finally {
		dom.window.close();
	}
});

test('interleaved concurrent write between removal and reread returns partial with authoritative state', () => {
	const dom = new JSDOM('', { url: 'https://modutex.test' });
	try {
		const baseStorage = dom.window.localStorage;
		baseStorage.setItem('legacy.preferences', 'legacy-v0-config');
		savePreference(baseStorage, 'appearance', 'dark');
		savePreference(baseStorage, 'language', 'en');
		savePreference(baseStorage, 'sourceFontSize', 20);

		// Interleaving delegate delegating to REAL JSDOM storage:
		// writes a valid non-default preference during a removeItem hook to simulate another window writing concurrently
		const interleavedStorage: Pick<Storage, 'getItem' | 'removeItem'> = {
			getItem(key: string) {
				return baseStorage.getItem(key);
			},
			removeItem(key: string) {
				baseStorage.removeItem(key);
				// When compileShortcut is removed, simulate peer window immediately setting appearance to 'dark'
				if (key === prefix + 'compileShortcut') {
					savePreference(baseStorage, 'appearance', 'dark');
				}
			}
		};

		const result = restorePreferences(interleavedStorage);

		// Must return 'partial' rather than falsely claiming 'restored', because reread contains non-default appearance
		assert.equal(result.status, 'partial');
		if (result.status === 'partial') {
			assert.equal(result.preferences.appearance, 'dark');
			assert.equal(result.preferences.language, 'zh-Hant');
			assert.equal(result.preferences.sourceFontSize, 14);

			// Authoritative state matches real underlying JSDOM storage
			const directRead = readPreferences(baseStorage);
			assert.deepEqual(result.preferences, directRead.preferences);
		}

		// Unrelated keys strictly preserved
		assert.equal(baseStorage.getItem('legacy.preferences'), 'legacy-v0-config');
	} finally {
		dom.window.close();
	}
});

test('unreadable storage fault returns unreadable status without phantom defaults', () => {
	const dom = new JSDOM('', { url: 'https://modutex.test' });
	try {
		const baseStorage = dom.window.localStorage;
		baseStorage.setItem('legacy.keep', 'intact');
		savePreference(baseStorage, 'appearance', 'light');
		savePreference(baseStorage, 'language', 'en');

		// Fault injection: getItem throws during reread
		const unreadableStorage: Pick<Storage, 'getItem' | 'removeItem'> = {
			getItem() {
				throw new Error('CORRUPT_STORAGE_IO');
			},
			removeItem(key: string) {
				baseStorage.removeItem(key);
			}
		};

		const result = restorePreferences(unreadableStorage);

		// Must return 'unreadable', strictly distinguishing from partial or restored
		assert.equal(result.status, 'unreadable');

		// Unrelated key in underlying storage untouched
		assert.equal(baseStorage.getItem('legacy.keep'), 'intact');
	} finally {
		dom.window.close();
	}
});

test('restorePreferences removes corrupt owned fields and resolves invalid flag', () => {
	const dom = new JSDOM('', { url: 'https://modutex.test' });
	try {
		const storage = dom.window.localStorage;
		storage.setItem('other.state', 'safe');
		// Write corrupted values for owned keys
		storage.setItem(prefix + 'sourceFontSize', 'not-a-number');
		storage.setItem(prefix + 'wrapLines', '{truncated-json');
		savePreference(storage, 'appearance', 'dark');

		// Pre-condition: invalid flag is true due to corrupt fields
		const before = readPreferences(storage);
		assert.equal(before.invalid, true);
		assert.equal(before.preferences.appearance, 'dark');

		// Restore removes corrupted keys as well as valid owned keys
		const result = restorePreferences(storage);
		assert.equal(result.status, 'restored');
		if (result.status === 'restored') {
			assert.equal(result.invalid, false);
			assert.deepEqual(result.preferences, DEFAULT_PREFERENCES);
		}
		assert.equal(storage.getItem(prefix + 'sourceFontSize'), null);
		assert.equal(storage.getItem(prefix + 'wrapLines'), null);
		assert.equal(storage.getItem('other.state'), 'safe');
	} finally {
		dom.window.close();
	}
});

test('subscribePreferences handles multi-window storage events when keys are removed', () => {
	const dom = new JSDOM('', { url: 'https://modutex.test' });
	try {
		const window = dom.window;
		const storage = window.localStorage;
		savePreference(storage, 'appearance', 'dark');

		const notifications: Preferences[] = [];
		const unsubscribe = subscribePreferences(window as unknown as Window, (prefs) => {
			notifications.push(prefs);
		});

		// Simulate another window removing the key (restore in peer window)
		storage.removeItem(prefix + 'appearance');
		window.dispatchEvent(new window.StorageEvent('storage', {
			key: prefix + 'appearance',
			oldValue: '"dark"',
			newValue: null,
			storageArea: storage
		}));

		assert.equal(notifications.length, 1);
		assert.equal(notifications[0]?.appearance, 'system');

		// Unrelated key removal must not trigger notification
		storage.removeItem('legacy.data');
		window.dispatchEvent(new window.StorageEvent('storage', {
			key: 'legacy.data',
			oldValue: 'val',
			newValue: null,
			storageArea: storage
		}));
		assert.equal(notifications.length, 1);

		unsubscribe();
	} finally {
		dom.window.close();
	}
});
