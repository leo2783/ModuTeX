import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createServer } from 'vite';
import { DEFAULT_PREFERENCES, readPreferences, savePreference, subscribePreferences } from '../../src/state/preferences.ts';
import type { Preferences } from '../../src/state/preferences.ts';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const languageKey = 'modutex.frontend.preferences.v1.language';

function withDocument(markup: string, inspect: (document: Document) => void): void {
	const dom = new JSDOM(markup);
	try { inspect(dom.window.document); } finally { dom.window.close(); }
}

test('language storage events reconcile stale values from localStorage', () => {
	const dom = new JSDOM('', { url: 'https://modutex.test' });
	const window = dom.window;
	const storage = window.localStorage;
	const seen: Preferences[] = [];
	let unsubscribe: (() => void) | undefined;
	try {
		savePreference(storage, 'appearance', 'dark');
		savePreference(storage, 'language', 'en');
		unsubscribe = subscribePreferences(window as unknown as Window, (preferences) => seen.push(preferences));
		const dispatch = (key: string | null, area: Storage, newValue: string | null) => {
			window.dispatchEvent(new window.StorageEvent('storage', { key, storageArea: area, newValue }));
		};

		dispatch(languageKey, storage, JSON.stringify('zh-Hant'));
		assert.deepEqual(seen[0], { ...DEFAULT_PREFERENCES, language: 'en', appearance: 'dark' });

		savePreference(storage, 'language', 'zh-Hant');
		assert.deepEqual(readPreferences(storage), {
			preferences: { ...DEFAULT_PREFERENCES, language: 'zh-Hant', appearance: 'dark' },
			invalid: false,
		});
		dispatch(languageKey, storage, JSON.stringify('en'));
		assert.deepEqual(seen[1], { ...DEFAULT_PREFERENCES, language: 'zh-Hant', appearance: 'dark' });

		const beforeIgnoredEvents = seen.length;
		dispatch('unrelated.storage.key', storage, JSON.stringify('en'));
		dispatch(languageKey, window.sessionStorage, JSON.stringify('en'));
		assert.equal(seen.length, beforeIgnoredEvents);

		storage.clear();
		dispatch(null, storage, null);
		assert.deepEqual(seen[2], DEFAULT_PREFERENCES);

		unsubscribe();
		unsubscribe = undefined;
		savePreference(storage, 'language', 'en');
		dispatch(languageKey, storage, JSON.stringify('zh-Hant'));
		assert.equal(seen.length, 3);
	} finally {
		unsubscribe?.();
		window.close();
	}
});

test('Help and Settings SSR reflect locale and preserve source licenses', { timeout: 15000 }, async () => {
	const server = await createServer({
		root: fileURLToPath(new URL('../..', import.meta.url)),
		server: { middlewareMode: true, hmr: false, ws: false },
		logLevel: 'error',
	});
	try {
		const help = await server.ssrLoadModule('/src/pages/Help.svelte');
		const settings = await server.ssrLoadModule('/src/pages/Settings.svelte');
		const { render } = await server.ssrLoadModule('svelte/server');

		const helpCases: {
			locale: 'en' | 'zh-Hant';
			navLabel: string;
			currentTopic: string;
			headings: string[];
			bodyPhrase: string;
		}[] = [
			{ locale: 'en', navLabel: 'Help topics', currentTopic: 'Getting started', headings: ['Open a document', 'Save and preview'], bodyPhrase: 'Choose Open document' },
			{ locale: 'zh-Hant', navLabel: '說明分類', currentTopic: '開始使用', headings: ['開啟文件', '儲存與預覽'], bodyPhrase: '選擇 UTF-8 TeX 文件' },
			{ locale: 'en', navLabel: 'Help topics', currentTopic: 'Getting started', headings: ['Open a document', 'Save and preview'], bodyPhrase: 'Choose Open document' },
		];
		for (const sample of helpCases) {
			const html = render(help.default, { props: { topic: 'getting-started', locale: sample.locale } }).body;
			withDocument(html, (document) => {
				assert.equal(document.querySelector('nav')?.getAttribute('aria-label'), sample.navLabel);
				assert.equal(document.querySelector('nav a[aria-current="page"]')?.textContent, sample.currentTopic);
				assert.equal(document.querySelector('h1')?.textContent, sample.currentTopic);
				const article = document.querySelector('article');
				assert.ok(article);
				assert.equal(article.getAttribute('lang'), sample.locale);
				assert.deepEqual(
					Array.from(article.querySelectorAll('h2'), (heading) => heading.textContent ?? ''),
					sample.headings,
				);
				assert.ok((article.textContent ?? '').includes(sample.bodyPhrase));
			});
		}

		for (const licenseCase of [
			{ topic: 'agpl', file: '../../../../LICENSE', titles: { en: 'AGPL full text', 'zh-Hant': 'AGPL 全文' } },
			{ topic: 'apache', file: '../../../../LICENSES/Apache-2.0.txt', titles: { en: 'Apache full text', 'zh-Hant': 'Apache 全文' } },
		] as const) {
			const actual = (await readFile(new URL(licenseCase.file, import.meta.url), 'utf8')).replace(/\r\n?/g, '\n');
			for (const locale of ['en', 'zh-Hant'] as const) {
				const html = render(help.default, { props: { topic: licenseCase.topic, locale } }).body;
				withDocument(html, (document) => {
					assert.equal(document.querySelector('h1')?.textContent, licenseCase.titles[locale]);
					const license = document.querySelector('pre.license-text');
					assert.ok(license);
					assert.equal(license.getAttribute('lang'), 'en');
					assert.equal(license.textContent, actual);
				});
			}
		}

		const settingsCases: { preferences: Preferences; heading: string; languageLabel: string }[] = [
			{
				preferences: { ...DEFAULT_PREFERENCES, language: 'en', appearance: 'dark', sourceFontSize: 19, showLineNumbers: false, wrapLines: true, compileShortcut: 'mod-shift-b' },
				heading: 'Settings', languageLabel: 'Language',
			},
			{
				preferences: { ...DEFAULT_PREFERENCES, language: 'zh-Hant', appearance: 'light', sourceFontSize: 13, showLineNumbers: true, wrapLines: false, compileShortcut: 'none' },
				heading: '設定', languageLabel: '語言',
			},
		];
		for (const sample of settingsCases) {
			const html = render(settings.default, {
				props: { preferences: sample.preferences, notice: '', locale: sample.preferences.language },
			}).body;
			withDocument(html, (document) => {
				assert.equal(document.querySelector('h1')?.textContent, sample.heading);
				assert.equal(document.querySelector('label[for="language-value"]')?.textContent, sample.languageLabel);
				const language = document.querySelector<HTMLSelectElement>('#language-value');
				assert.ok(language);
				assert.equal(language.value, sample.preferences.language);
				assert.deepEqual(Array.from(language.options, (option) => option.value), ['zh-Hant', 'en']);

				const appearance = document.querySelector<HTMLSelectElement>('#appearance-value');
				assert.equal(appearance?.value, sample.preferences.appearance);
				const fontSize = document.querySelector<HTMLInputElement>('#source-font-size');
				assert.equal(fontSize?.type, 'number');
				assert.equal(fontSize?.value, String(sample.preferences.sourceFontSize));
				const lineNumbers = document.querySelector<HTMLInputElement>('#source-line-numbers');
				assert.equal(lineNumbers?.type, 'checkbox');
				assert.equal(lineNumbers?.checked, sample.preferences.showLineNumbers);
				const wrapping = document.querySelector<HTMLInputElement>('#source-wrapping');
				assert.equal(wrapping?.checked, sample.preferences.wrapLines);
				assert.equal(document.querySelector<HTMLSelectElement>('#compile-shortcut')?.value, sample.preferences.compileShortcut);
			});
		}
	} finally {
		await server.close();
	}
});
