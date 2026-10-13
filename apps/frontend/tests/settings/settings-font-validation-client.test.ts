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
const { JSDOM } = require('jsdom') as {
	JSDOM: new (html?: string, options?: { url?: string }) => { window: DOMWindow };
};

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const settingsPath = fileURLToPath(new URL('../../src/pages/Settings.svelte', import.meta.url)).replaceAll('\\', '/');

let tempDir: string | null = null;
let dom: { window: DOMWindow } | null = null;
let client: {
	mount: (component: unknown, options: { target: HTMLElement; props: Record<string, unknown> }) => unknown;
	unmount: (instance: unknown, options?: { outro?: boolean }) => Promise<void>;
	flushSync: (fn?: () => void) => void;
	tick: () => Promise<void>;
	SettingsHarness: unknown;
} | null = null;

const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();

function restoreGlobals(): void {
	for (const [key, descriptor] of previousDescriptors) {
		try {
			if (descriptor === undefined) {
				Reflect.deleteProperty(globalThis, key);
			} else {
				Object.defineProperty(globalThis, key, descriptor);
			}
		} catch {
			// Continue restoring the remaining globals.
		}
	}
	previousDescriptors.clear();
}

function cleanup(): void {
	if (dom) {
		try {
			dom.window.close();
		} catch {
			// Ignore close errors.
		}
		dom = null;
	}
	restoreGlobals();
	if (tempDir) {
		fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	}
	client = null;
}

function installBrowserGlobals(win: DOMWindow): void {
	const explicitDomKeys = [
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
		'HTMLInputElement',
		'HTMLSelectElement',
		'HTMLOptionElement',
		'HTMLButtonElement',
		'HTMLDivElement',
		'HTMLParagraphElement',
		'HTMLHeadingElement',
		'Event',
		'EventTarget',
		'KeyboardEvent',
		'MouseEvent',
		'MutationObserver'
	] as const;

	for (const key of explicitDomKeys) {
		previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		if (key in win) {
			const value = win[key as keyof DOMWindow];
			Object.defineProperty(globalThis, key, {
				value,
				writable: true,
				configurable: true
			});
		}
	}
}

test.after(() => {
	cleanup();
});

test.before(
	async () => {
		const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-font-validation-client-'));
		tempDir = buildDir;
		const harnessFile = path.join(buildDir, 'SettingsHarness.svelte');
		const entryFile = path.join(buildDir, 'entry.js');
		const normalizedHarnessFile = harnessFile.replaceAll('\\', '/');

		fs.writeFileSync(
			harnessFile,
			`<script lang="ts">
	import Settings from ${JSON.stringify(settingsPath)};
	import type { Preferences } from ${JSON.stringify(frontendRoot + '/src/state/preferences.ts')};
	import type { Language } from ${JSON.stringify(frontendRoot + '/src/i18n/text.ts')};

	let {
		initialPreferences,
		initialLocale,
		initialNotice = '',
		onChange,
		onRestore,
		onController
	}: {
		initialPreferences: Preferences;
		initialLocale?: Language;
		initialNotice?: string;
		onChange: <K extends keyof Preferences>(key: K, value: Preferences[K]) => void;
		onRestore: () => void;
		onController?: (ctrl: {
			setLocale: (next: Language) => void;
			setPreferences: (next: Preferences) => void;
		}) => void;
	} = $props();

	let preferences = $state<Preferences>({ ...initialPreferences });
	let locale = $state<Language | undefined>(initialLocale);
	let notice = $state<string>(initialNotice);

	function handleInternalChange<K extends keyof Preferences>(key: K, value: Preferences[K]) {
		preferences = { ...preferences, [key]: value };
		onChange(key, value);
	}

	onController?.({
		setLocale: (next: Language) => { locale = next; },
		setPreferences: (next: Preferences) => { preferences = next; }
	});
</script>

<Settings
	{preferences}
	{locale}
	{notice}
	onChange={handleInternalChange}
	{onRestore}
/>
`
		);

		fs.writeFileSync(
			entryFile,
			`import { mount, unmount, flushSync, tick } from 'svelte';
import SettingsHarness from ${JSON.stringify(normalizedHarnessFile)};
export { mount, unmount, flushSync, tick, SettingsHarness };
`
		);

		await build({
			configFile: false,
			root: frontendRoot,
			plugins: [svelte({ emitCss: false })],
			resolve: {
				dedupe: ['svelte'],
				conditions: ['browser', 'default']
			},
			build: {
				write: true,
				outDir: buildDir,
				emptyOutDir: false,
				lib: {
					entry: entryFile,
					formats: ['es'],
					fileName: () => 'settings-font-validation-client.mjs'
				},
				sourcemap: false,
				minify: false
			},
			logLevel: 'silent'
		});

		dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
			url: 'https://modutex.test'
		});
		installBrowserGlobals(dom.window);

		const bundleUrl = pathToFileURL(path.join(buildDir, 'settings-font-validation-client.mjs')).href;
		client = (await import(bundleUrl)) as typeof client;
	},
	{ timeout: 120_000 }
);

test(
	'Settings font size validates empty/fractional/range input, updates via external preferences, and clears draft on restore even when default font is active',
	{ timeout: 30_000 },
	async () => {
		assert.ok(dom, 'JSDOM environment must be initialized');
		assert.ok(client, 'Vite-built Svelte client must be loaded');
		const win = dom.window;
		const api = client;
		const container = win.document.getElementById('app');
		assert.ok(container);

		const committedChanges: Array<{ key: string; value: unknown }> = [];
		let restoreCount = 0;
		let controller!: {
			setLocale: (next: Language) => void;
			setPreferences: (next: Preferences) => void;
		};

		let mounted: unknown;
		try {
			mounted = api.mount(api.SettingsHarness, {
				target: container,
				props: {
					initialPreferences: { ...DEFAULT_PREFERENCES, sourceFontSize: 14 },
					initialLocale: 'zh-Hant',
					onChange: (key: string, value: unknown) => {
						committedChanges.push({ key, value });
					},
					onRestore: () => {
						restoreCount++;
					},
					onController: (ctrl: typeof controller) => {
						controller = ctrl;
					}
				}
			});
			api.flushSync();
			await api.tick();

			const input = container.querySelector<HTMLInputElement>('#source-font-size');
			assert.ok(input, 'Font size input must exist');
			assert.equal(input.value, '14', 'Initial font size must match preferences');
			assert.equal(input.getAttribute('aria-invalid'), null);
			assert.equal(container.querySelector('#source-font-size-error'), null);

			// 1. Empty draft validation
			input.value = '';
			input.dispatchEvent(new win.Event('input', { bubbles: true }));
			input.dispatchEvent(new win.Event('change', { bubbles: true }));
			api.flushSync();
			await api.tick();

			assert.equal(input.value, '', 'Empty input must remain preserved as draft');
			assert.equal(committedChanges.length, 0, 'No preference change committed for empty input');
			assert.equal(input.getAttribute('aria-invalid'), 'true');
			assert.equal(input.getAttribute('aria-describedby'), 'source-font-size-error');
			assert.ok(container.querySelector('#source-font-size-error'));

			// 2. Fractional value validation
			input.value = '16.5';
			input.dispatchEvent(new win.Event('input', { bubbles: true }));
			input.dispatchEvent(new win.Event('change', { bubbles: true }));
			api.flushSync();
			await api.tick();

			assert.equal(input.value, '16.5');
			assert.equal(committedChanges.length, 0);
			const errorEl = container.querySelector<HTMLElement>('#source-font-size-error');
			assert.ok(errorEl);
			assert.match(errorEl.textContent ?? '', /整數/);

			// 3. Locale change preserves invalid draft and translates error
			controller.setLocale('en');
			api.flushSync();
			await api.tick();

			assert.equal(input.value, '16.5');
			const errorElEn = container.querySelector<HTMLElement>('#source-font-size-error');
			assert.ok(errorElEn);
			assert.match(errorElEn.textContent ?? '', /integer/i);

			// 4. Out-of-bounds input (too high: 30, and too low: 10)
			input.value = '30';
			input.dispatchEvent(new win.Event('input', { bubbles: true }));
			input.dispatchEvent(new win.Event('change', { bubbles: true }));
			api.flushSync();
			await api.tick();

			assert.equal(input.value, '30');
			assert.equal(committedChanges.length, 0);
			assert.match(container.querySelector('#source-font-size-error')?.textContent ?? '', /between 12 and 24/i);

			input.value = '10';
			input.dispatchEvent(new win.Event('input', { bubbles: true }));
			input.dispatchEvent(new win.Event('change', { bubbles: true }));
			api.flushSync();
			await api.tick();

			assert.equal(input.value, '10');
			assert.equal(committedChanges.length, 0);
			assert.match(container.querySelector('#source-font-size-error')?.textContent ?? '', /between 12 and 24/i);

			// 5. Valid input commits exact contract once and clears error
			input.value = '18';
			input.dispatchEvent(new win.Event('input', { bubbles: true }));
			input.dispatchEvent(new win.Event('change', { bubbles: true }));
			api.flushSync();
			await api.tick();

			assert.equal(committedChanges.length, 1);
			assert.deepEqual(committedChanges[0], { key: 'sourceFontSize', value: 18 });
			assert.equal(input.value, '18');
			assert.equal(input.getAttribute('aria-invalid'), null);
			assert.equal(container.querySelector('#source-font-size-error'), null);

			// 6. External preferences update synchronizes input and clears draft/error
			controller.setPreferences({ ...DEFAULT_PREFERENCES, sourceFontSize: 20 });
			api.flushSync();
			await api.tick();

			assert.equal(input.value, '20');
			assert.equal(input.getAttribute('aria-invalid'), null);

			// 7. Reset preferences back to default 14 first
			controller.setPreferences({ ...DEFAULT_PREFERENCES, sourceFontSize: 14 });
			api.flushSync();
			await api.tick();
			assert.equal(input.value, '14');

			// Now introduce an invalid draft while current active pref is already default 14
			input.value = '99';
			input.dispatchEvent(new win.Event('input', { bubbles: true }));
			input.dispatchEvent(new win.Event('change', { bubbles: true }));
			api.flushSync();
			await api.tick();
			assert.equal(input.value, '99');
			assert.equal(input.getAttribute('aria-invalid'), 'true');

			// Click the actual Restore defaults button
			const restoreBtn = container.querySelector<HTMLButtonElement>('.restore-button');
			assert.ok(restoreBtn, 'Restore defaults button must exist');
			restoreBtn.click();
			api.flushSync();
			await api.tick();

			assert.equal(restoreCount, 1, 'Restore callback must be called exactly once');
			assert.equal(input.value, '14', 'Restore must reset invalid draft to default 14 even when pref was already 14');
			assert.equal(input.getAttribute('aria-invalid'), null);
			assert.equal(container.querySelector('#source-font-size-error'), null);
		} finally {
			if (mounted !== undefined) {
				await api.unmount(mounted);
				api.flushSync();
			}
		}
	}
);
