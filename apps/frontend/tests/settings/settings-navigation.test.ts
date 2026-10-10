import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { DEFAULT_PREFERENCES, type Preferences } from '../../src/state/preferences.ts';
import type { Language } from '../../src/i18n/text.ts';

type DOMWindow = Window & typeof globalThis & { close(): void };

const require = createRequire(import.meta.url);
const { JSDOM }: {
	JSDOM: new (
		html?: string,
		options?: { url?: string; storageQuota?: number }
	) => {
		window: DOMWindow;
	};
} = require('jsdom');

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const settingsPath = fileURLToPath(new URL('../../src/pages/Settings.svelte', import.meta.url)).replaceAll('\\', '/');

let tempDir: string | null = null;
let dom: { window: DOMWindow } | null = null;

type DomGlobalKey = Extract<keyof DOMWindow, keyof typeof globalThis>;

const explicitDomKeys: readonly DomGlobalKey[] = [
	'window',
	'document',
	'navigator',
	'location',
	'Node',
	'Element',
	'HTMLElement',
	'Document',
	'DocumentFragment',
	'Text',
	'Comment',
	'CharacterData',
	'Attr',
	'HTMLInputElement',
	'HTMLSelectElement',
	'HTMLOptionElement',
	'HTMLButtonElement',
	'HTMLAnchorElement',
	'HTMLDivElement',
	'HTMLParagraphElement',
	'HTMLHeadingElement',
	'HTMLFormElement',
	'HTMLTextAreaElement',
	'HTMLSpanElement',
	'HTMLPreElement',
	'HTMLDetailsElement',
	'HTMLUListElement',
	'HTMLLIElement',
	'HTMLCanvasElement',
	'HTMLTemplateElement',
	'HTMLStyleElement',
	'HTMLLinkElement',
	'Event',
	'EventTarget',
	'CustomEvent',
	'KeyboardEvent',
	'MouseEvent',
	'StorageEvent',
	'BeforeUnloadEvent',
	'HashChangeEvent',
	'UIEvent',
	'MutationObserver',
	'Storage'
];

const previousDescriptors = new Map<DomGlobalKey, PropertyDescriptor | undefined>();

function restoreGlobals() {
	for (const [key, desc] of previousDescriptors) {
		try {
			if (desc === undefined) {
				Reflect.deleteProperty(globalThis, key);
			} else {
				Object.defineProperty(globalThis, key, desc);
			}
		} catch {
			// Ignore non-configurable globals
		}
	}
	previousDescriptors.clear();
}

test.after(() => {
	if (dom) {
		try {
			dom.window.close();
		} catch {
			// Ignore close errors
		}
		dom = null;
	}
	restoreGlobals();
	if (tempDir) {
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore temp directory removal errors
		}
		tempDir = null;
	}
});

// 1. Build client entry exporting public Svelte APIs, Settings component, and genuine Svelte runes Harness
tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-settings-nav-'));
const harnessPath = path.join(tempDir, 'Harness.svelte').replaceAll('\\', '/');
fs.writeFileSync(
	harnessPath,
	`<script lang="ts">
	import Settings from '${settingsPath}';
	import type { Preferences } from '${frontendRoot}/src/state/preferences.ts';
	import type { Language } from '${frontendRoot}/src/i18n/text.ts';

	let {
		initialPreferences,
		initialNotice = '',
		initialLocale,
		onRestore,
		bindHarness
	}: {
		initialPreferences: Preferences;
		initialNotice?: string;
		initialLocale?: Language;
		onRestore: () => void;
		bindHarness?: (api: {
			setLocale: (next: Language | undefined) => void;
			setPreferences: (next: Preferences) => void;
			setNotice: (next: string) => void;
			getPreferences: () => Preferences;
			getLocale: () => Language | undefined;
		}) => void;
	} = $props();

	let preferences = $state<Preferences>({ ...initialPreferences });
	let notice = $state<string>(initialNotice);
	let locale = $state<Language | undefined>(initialLocale);

	function setLocale(next: Language | undefined) {
		locale = next;
	}

	function setPreferences(next: Preferences) {
		preferences = next;
	}

	function setNotice(next: string) {
		notice = next;
	}

	function getPreferences(): Preferences {
		return preferences;
	}

	function getLocale(): Language | undefined {
		return locale;
	}

	function handleChange<K extends keyof Preferences>(key: K, value: Preferences[K]) {
		preferences = { ...preferences, [key]: value };
	}

	bindHarness?.({
		setLocale,
		setPreferences,
		setNotice,
		getPreferences,
		getLocale
	});

	export { setLocale, setPreferences, setNotice, getPreferences, getLocale };
</script>

<Settings
	{preferences}
	{notice}
	{locale}
	onChange={handleChange}
	{onRestore}
/>
`
);

const entryFile = path.join(tempDir, 'entry.js');
fs.writeFileSync(
	entryFile,
	`import { mount, unmount, flushSync, tick } from 'svelte';
import Settings from '${settingsPath}';
import Harness from '${harnessPath}';
export { mount, unmount, flushSync, tick, Settings, Harness };
`
);

await build({
	configFile: false,
	root: frontendRoot,
	plugins: [svelte()],
	resolve: {
		conditions: ['browser', 'default']
	},
	build: {
		write: true,
		outDir: tempDir,
		emptyOutDir: false,
		lib: {
			entry: entryFile,
			formats: ['es'],
			fileName: () => 'settings-client.mjs'
		},
		sourcemap: false,
		minify: false
	},
	logLevel: 'silent'
});

// 2. Set real JSDOM globals
dom = new JSDOM(
	'<!DOCTYPE html><html lang="zh-Hant"><body><div id="app"></div></body></html>',
	{ url: 'https://modutex.test' }
);

for (const key of explicitDomKeys) {
	previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	if (key in dom.window) {
		const val = Reflect.get(dom.window, key);
		Object.defineProperty(globalThis, key, {
			value: val,
			writable: true,
			configurable: true
		});
	}
}

// Track scroll targets in JSDOM
const scrolledTargets: string[] = [];
dom.window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
	scrolledTargets.push(this.id);
};

// 3. Dynamically import the compiled client module
const bundleUrl = pathToFileURL(path.join(tempDir, 'settings-client.mjs')).href;
const { mount, unmount, flushSync, Settings, Harness } = (await import(bundleUrl)) as {
	mount: (component: unknown, options: { target: HTMLElement; props: Record<string, unknown> }) => unknown;
	unmount: (instance: unknown, options?: { outro?: boolean }) => Promise<void>;
	flushSync: (fn?: () => void) => void;
	Settings: unknown;
	Harness: unknown;
};

test('section nav buttons update aria-current truthfully and shift focus to h2 headings with tabindex -1', async () => {
	assert.ok(dom, 'DOM must be initialized');
	const container = dom.window.document.getElementById('app');
	assert.ok(container, 'Container element must exist');
	container.innerHTML = '';
	scrolledTargets.length = 0;

	let restored = false;
	const changes: Array<{ key: string; value: unknown }> = [];
	const instance = mount(Settings, {
		target: container,
		props: {
			preferences: { ...DEFAULT_PREFERENCES },
			notice: '',
			locale: 'zh-Hant',
			onChange: <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
				changes.push({ key, value });
			},
			onRestore: () => {
				restored = true;
			}
		}
	});
	flushSync();

	try {
		const aside = container.querySelector('aside');
		assert.ok(aside, 'Aside navigation element must exist');
		const navButtons = Array.from(aside.querySelectorAll('button'));
		assert.equal(navButtons.length, 5, 'Must have 5 section nav buttons');

		const [generalBtn, appearanceBtn, editorBtn, shortcutsBtn, restoreBtn] = navButtons;
		assert.ok(generalBtn, 'General section nav button must exist');
		assert.ok(appearanceBtn, 'Appearance section nav button must exist');
		assert.ok(editorBtn, 'Editor section nav button must exist');
		assert.ok(shortcutsBtn, 'Shortcuts section nav button must exist');
		assert.ok(restoreBtn, 'Restore defaults section nav button must exist');

		// Initial state: first button general-preferences is aria-current="true"
		assert.equal(generalBtn.getAttribute('aria-current'), 'true');
		assert.equal(appearanceBtn.getAttribute('aria-current'), null);
		assert.equal(editorBtn.getAttribute('aria-current'), null);
		assert.equal(shortcutsBtn.getAttribute('aria-current'), null);
		assert.equal(restoreBtn.getAttribute('aria-current'), null);

		// Click Appearance button
		appearanceBtn.click();
		flushSync();
		assert.equal(appearanceBtn.getAttribute('aria-current'), 'true');
		assert.equal(generalBtn.getAttribute('aria-current'), null);
		const appearanceH2 = dom.window.document.querySelector<HTMLHeadingElement>('#appearance');
		assert.ok(appearanceH2, 'Appearance h2 heading must exist');
		assert.equal(appearanceH2.getAttribute('tabindex'), '-1', 'Heading must have tabindex="-1"');
		assert.equal(dom.window.document.activeElement, appearanceH2, 'Focus must move to Appearance h2 heading');
		assert.equal(scrolledTargets.at(-1), 'appearance');

		// Click Editor button
		editorBtn.click();
		flushSync();
		assert.equal(editorBtn.getAttribute('aria-current'), 'true');
		assert.equal(appearanceBtn.getAttribute('aria-current'), null);
		const editorH2 = dom.window.document.querySelector<HTMLHeadingElement>('#editor-preferences');
		assert.ok(editorH2, 'Editor preferences h2 heading must exist');
		assert.equal(editorH2.getAttribute('tabindex'), '-1', 'Heading must have tabindex="-1"');
		assert.equal(dom.window.document.activeElement, editorH2, 'Focus must move to Editor h2 heading');
		assert.equal(scrolledTargets.at(-1), 'editor-preferences');

		// Click Shortcuts button
		shortcutsBtn.click();
		flushSync();
		assert.equal(shortcutsBtn.getAttribute('aria-current'), 'true');
		assert.equal(editorBtn.getAttribute('aria-current'), null);
		const shortcutsH2 = dom.window.document.querySelector<HTMLHeadingElement>('#shortcut-preferences');
		assert.ok(shortcutsH2, 'Shortcuts h2 heading must exist');
		assert.equal(shortcutsH2.getAttribute('tabindex'), '-1', 'Heading must have tabindex="-1"');
		assert.equal(dom.window.document.activeElement, shortcutsH2, 'Focus must move to Shortcuts h2 heading');
		assert.equal(scrolledTargets.at(-1), 'shortcut-preferences');

		// Click Restore defaults button in navigation
		restoreBtn.click();
		flushSync();
		assert.equal(restoreBtn.getAttribute('aria-current'), 'true');
		assert.equal(shortcutsBtn.getAttribute('aria-current'), null);
		const restoreH2 = dom.window.document.querySelector<HTMLHeadingElement>('#restore-preferences');
		assert.ok(restoreH2, 'Restore defaults h2 heading must exist');
		assert.equal(restoreH2.getAttribute('tabindex'), '-1', 'Heading must have tabindex="-1"');
		assert.equal(dom.window.document.activeElement, restoreH2, 'Focus must move to Restore defaults h2 heading');
		assert.equal(scrolledTargets.at(-1), 'restore-preferences');

		// Clicking restore section nav button navigates to section without firing onRestore callback
		assert.equal(restored, false, 'Navigating to restore section must not trigger onRestore callback');
	} finally {
		await unmount(instance);
	}
});

test('focused section nav button activation shifts focus to h2 with tabindex -1 (native Enter/Space keyboard dispatch pending browser runtime)', async () => {
	assert.ok(dom, 'DOM must be initialized');
	const container = dom.window.document.getElementById('app');
	assert.ok(container);
	container.innerHTML = '';
	scrolledTargets.length = 0;

	const instance = mount(Settings, {
		target: container,
		props: {
			preferences: { ...DEFAULT_PREFERENCES },
			notice: '',
			locale: 'zh-Hant',
			onChange: () => {},
			onRestore: () => {}
		}
	});
	flushSync();

	try {
		const aside = container.querySelector('aside');
		assert.ok(aside);
		const shortcutsBtn = aside.querySelectorAll('button')[3];
		assert.ok(shortcutsBtn, 'Shortcuts nav button must exist at index 3');

		// Focus on navigation button
		shortcutsBtn.focus();
		assert.equal(dom.window.document.activeElement, shortcutsBtn, 'Button must be focused before activation');

		// In standard browser runtimes, pressing Enter or Space while focused activates the button (dispatches click).
		// JSDOM does not synthesize click events from keydown, so we test the focused-button activation path directly
		// and verify heading focus transfer with tabindex="-1" while marking native Enter/Space pending real browser runtime.
		shortcutsBtn.click();
		flushSync();

		const shortcutsH2 = dom.window.document.querySelector<HTMLHeadingElement>('#shortcut-preferences');
		assert.ok(shortcutsH2);
		assert.equal(shortcutsH2.getAttribute('tabindex'), '-1');
		assert.equal(dom.window.document.activeElement, shortcutsH2, 'Activating focused nav button must shift focus to h2');
		assert.equal(shortcutsBtn.getAttribute('aria-current'), 'true');
	} finally {
		await unmount(instance);
	}
});

test('genuine Svelte runes harness updates locale and preferences without stealing focus from active control', async () => {
	assert.ok(dom, 'DOM must be initialized');
	const container = dom.window.document.getElementById('app');
	assert.ok(container);
	container.innerHTML = '';

	let harnessApi!: {
		setLocale: (next: Language | undefined) => void;
		setPreferences: (next: Preferences) => void;
		setNotice: (next: string) => void;
		getPreferences: () => Preferences;
		getLocale: () => Language | undefined;
	};

	const instance = mount(Harness, {
		target: container,
		props: {
			initialPreferences: { ...DEFAULT_PREFERENCES },
			initialNotice: '',
			initialLocale: 'zh-Hant',
			onRestore: () => {},
			bindHarness: (api: typeof harnessApi) => {
				harnessApi = api;
			}
		}
	});
	flushSync();

	try {
		assert.ok(harnessApi, 'Harness API must be bound from genuine Svelte runes component');

		// 1. Initial zh-Hant rendered headings
		const mainHeading = dom.window.document.querySelector<HTMLHeadingElement>('#settings-heading');
		const generalHeading = dom.window.document.querySelector<HTMLHeadingElement>('#general-preferences');
		assert.ok(mainHeading);
		assert.ok(generalHeading);
		assert.equal(mainHeading.textContent, '設定');
		assert.equal(generalHeading.textContent, '一般');

		// 2. User focuses on language select
		const langSelect = dom.window.document.querySelector<HTMLSelectElement>('#language-value');
		assert.ok(langSelect);
		langSelect.focus();
		assert.equal(dom.window.document.activeElement, langSelect, 'Language select must hold active focus');

		// 3. Harness updates locale to 'en' (simulating parent state update)
		harnessApi.setLocale('en');
		flushSync();

		// Assert DOM headings truthfully update to English
		assert.equal(mainHeading.textContent, 'Settings', 'Main heading must update to English "Settings"');
		assert.equal(generalHeading.textContent, 'General', 'General section heading must update to English "General"');

		// Assert activeElement remains on language select across locale update (no focus steal)
		assert.equal(dom.window.document.activeElement, langSelect, 'Focus must remain on language select across locale update');

		// 4. User focuses on font size input
		const fontInput = dom.window.document.querySelector<HTMLInputElement>('#source-font-size');
		assert.ok(fontInput);
		fontInput.focus();
		assert.equal(dom.window.document.activeElement, fontInput, 'Font input must hold active focus');
		assert.equal(fontInput.value, String(DEFAULT_PREFERENCES.sourceFontSize));

		// 5. Harness updates preferences (simulating external or parent state update)
		harnessApi.setPreferences({ ...DEFAULT_PREFERENCES, sourceFontSize: 22 });
		flushSync();

		// Assert control value truthfully updates in DOM
		assert.equal(fontInput.value, '22', 'Font size input value must reflect updated parent preferences');

		// Assert activeElement remains on font input across preferences update (no focus steal)
		assert.equal(dom.window.document.activeElement, fontInput, 'Focus must remain on font input across preferences update');

		// 6. User modifies font input triggering onChange, which updates parent harness state
		fontInput.value = '18';
		fontInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
		flushSync();

		// Assert parent state in harness was updated via onChange
		assert.equal(harnessApi.getPreferences().sourceFontSize, 18, 'Parent preferences in harness must update via onChange');

		// Assert activeElement remains on font input across DOM change and parent state mutation
		assert.equal(dom.window.document.activeElement, fontInput, 'Focus must remain on font input across change event and parent state update');
	} finally {
		await unmount(instance);
	}
});

test('setting controls trigger typed onChange callbacks and validate font size bounds', async () => {
	assert.ok(dom, 'DOM must be initialized');
	const container = dom.window.document.getElementById('app');
	assert.ok(container);
	container.innerHTML = '';

	const changes: Array<{ key: string; value: unknown }> = [];
	const instance = mount(Settings, {
		target: container,
		props: {
			preferences: { ...DEFAULT_PREFERENCES },
			notice: '',
			locale: 'zh-Hant',
			onChange: <K extends keyof Preferences>(key: K, value: Preferences[K]) => {
				changes.push({ key, value });
			},
			onRestore: () => {}
		}
	});
	flushSync();

	try {
		// Appearance select
		const appearanceSelect = dom.window.document.querySelector<HTMLSelectElement>('#appearance-value');
		assert.ok(appearanceSelect);
		appearanceSelect.value = 'dark';
		appearanceSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
		flushSync();

		// Line numbers checkbox
		const lineNumbersCheckbox = dom.window.document.querySelector<HTMLInputElement>('#source-line-numbers');
		assert.ok(lineNumbersCheckbox);
		lineNumbersCheckbox.checked = false;
		lineNumbersCheckbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
		flushSync();

		// Wrap lines checkbox
		const wrapLinesCheckbox = dom.window.document.querySelector<HTMLInputElement>('#source-wrapping');
		assert.ok(wrapLinesCheckbox);
		wrapLinesCheckbox.checked = false;
		wrapLinesCheckbox.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
		flushSync();

		// Shortcuts select
		const shortcutSelect = dom.window.document.querySelector<HTMLSelectElement>('#compile-shortcut');
		assert.ok(shortcutSelect);
		shortcutSelect.value = 'mod-shift-b';
		shortcutSelect.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
		flushSync();

		// Font size invalid bounds check
		const fontInput = dom.window.document.querySelector<HTMLInputElement>('#source-font-size');
		assert.ok(fontInput);
		fontInput.value = '50'; // Exceeds max 24
		fontInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
		flushSync();

		assert.equal(changes.some((c) => c.key === 'appearance' && c.value === 'dark'), true);
		assert.equal(changes.some((c) => c.key === 'showLineNumbers' && c.value === false), true);
		assert.equal(changes.some((c) => c.key === 'wrapLines' && c.value === false), true);
		assert.equal(changes.some((c) => c.key === 'compileShortcut' && c.value === 'mod-shift-b'), true);
		// Invalid font size (50) must NOT be recorded
		assert.equal(changes.some((c) => c.key === 'sourceFontSize' && c.value === 50), false);
		// Retain the invalid draft with a visible reason, without committing it.
		assert.equal(fontInput.value, '50');
		assert.equal(fontInput.getAttribute('aria-invalid'), 'true');
		assert.ok(dom.window.document.querySelector('#source-font-size-error[role="alert"]')?.textContent);
		fontInput.value = '16';
		fontInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
		flushSync();
		assert.equal(changes.some((c) => c.key === 'sourceFontSize' && c.value === 16), true);
		assert.equal(fontInput.getAttribute('aria-invalid'), null);
	} finally {
		await unmount(instance);
	}
});

test('required onRestore executes truthfully and explanatory description clarifies frontend scope', async () => {
	assert.ok(dom, 'DOM must be initialized');
	const container = dom.window.document.getElementById('app');
	assert.ok(container);
	container.innerHTML = '';

	let restoredCount = 0;
	const instance = mount(Settings, {
		target: container,
		props: {
			preferences: { ...DEFAULT_PREFERENCES },
			notice: '',
			locale: 'zh-Hant',
			onChange: () => {},
			onRestore: () => {
				restoredCount++;
			}
		}
	});
	flushSync();

	try {
		const restoreSection = dom.window.document.querySelector<HTMLElement>('section[aria-labelledby="restore-preferences"]');
		assert.ok(restoreSection, 'Restore preferences section must exist');

		const description = restoreSection.querySelector<HTMLSpanElement>('.setting-row span');
		assert.ok(description, 'Restore description text must exist');
		const textContent = description.textContent ?? '';

		// Verify clarified wording: only supported frontend preferences, no mention of cache or engine reset
		assert.ok(textContent.includes('支援的前端介面設定'), 'Must clarify supported frontend preferences scope');
		assert.ok(textContent.includes('不會變更文件內容、編譯引擎或快取'), 'Must clarify document, compile engine, and cache are not affected');

		// Click restore button inside section
		const restoreButton = restoreSection.querySelector<HTMLButtonElement>('.restore-button');
		assert.ok(restoreButton, 'Restore button must exist');
		restoreButton.click();
		flushSync();

		assert.equal(restoredCount, 1, 'Clicking restore button must invoke onRestore exactly once');
	} finally {
		await unmount(instance);
	}
});
