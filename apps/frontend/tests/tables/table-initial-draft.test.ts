import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import type { TableDraft } from '../../src/features/tables/source.ts';

type DOMWindow = Window & typeof globalThis & { close(): void };
type Locale = 'zh-Hant' | 'en';
type PanelController = {
	setLocale: (nextLocale: Locale) => void;
	setSession: (key: string, draft: TableDraft | null) => void;
	setInitialDraftOnly: (draft: TableDraft | null) => void;
};
type ClientModule = {
	mount: (component: unknown, options: { target: HTMLElement; props: Record<string, unknown> }) => unknown;
	unmount: (instance: unknown, options?: { outro?: boolean }) => Promise<void>;
	flushSync: (fn?: () => void) => void;
	tick: () => Promise<void>;
	TablePanelHarness: unknown;
};

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as {
	JSDOM: new (html?: string, options?: { url?: string }) => { window: DOMWindow };
};

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const tablePanelPath = fileURLToPath(new URL('../../src/features/tables/TablePanel.svelte', import.meta.url)).replaceAll('\\', '/');

let tempDir: string | null = null;
let dom: { window: DOMWindow } | null = null;
let client: ClientModule | null = null;
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
			// Ignore close errors while restoring globals and cleaning files.
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
		'HTMLTableElement',
		'HTMLTableSectionElement',
		'HTMLTableRowElement',
		'HTMLTableCellElement',
		'HTMLTableColElement',
		'HTMLFieldSetElement',
		'Event',
		'EventTarget',
		'KeyboardEvent',
		'MouseEvent',
		'MutationObserver',
		'HTMLMediaElement',
		'PointerEvent'
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

	previousDescriptors.set('requestAnimationFrame', Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame'));
	Object.defineProperty(globalThis, 'requestAnimationFrame', {
		value: (callback: FrameRequestCallback) => setTimeout(callback, 0),
		writable: true,
		configurable: true
	});
	previousDescriptors.set('cancelAnimationFrame', Object.getOwnPropertyDescriptor(globalThis, 'cancelAnimationFrame'));
	Object.defineProperty(globalThis, 'cancelAnimationFrame', {
		value: (id: number) => clearTimeout(id),
		writable: true,
		configurable: true
	});
}

test.after(() => {
	cleanup();
});

test.before(
	async () => {
		const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'table-initial-draft-client-'));
		tempDir = buildDir;
		const harnessFile = path.join(buildDir, 'TablePanelHarness.svelte');
		const entryFile = path.join(buildDir, 'entry.js');
		const normalizedHarnessFile = harnessFile.replaceAll('\\', '/');

		fs.writeFileSync(
			harnessFile,
			`<script lang="ts">
	import TablePanel from ${JSON.stringify(tablePanelPath)};
	import type { TableDraft } from ${JSON.stringify(fileURLToPath(new URL('../../src/features/tables/source.ts', import.meta.url)).replaceAll('\\', '/'))};
	type Locale = 'zh-Hant' | 'en';
	let {
		initialDraft = null,
		initialSessionKey = 'insert',
		initialLocale = 'zh-Hant',
		onInsert,
		onClose,
		onController
	} = $props<{
		initialDraft?: TableDraft | null;
		initialSessionKey?: string;
		initialLocale?: Locale;
		onInsert: (source: string, booktabs?: boolean) => void;
		onClose: () => void;
		onController: (controller: {
			setLocale: (nextLocale: Locale) => void;
			setSession: (key: string, draft: TableDraft | null) => void;
			setInitialDraftOnly: (draft: TableDraft | null) => void;
		}) => void;
	}>();
	let draft = $state<TableDraft | null>(initialDraft);
	let sessionKey = $state<string>(initialSessionKey);
	let locale = $state<Locale>(initialLocale);
	onController({
		setLocale: (nextLocale: Locale) => { locale = nextLocale; },
		setSession: (key: string, nextDraft: TableDraft | null) => {
			draft = nextDraft;
			sessionKey = key;
		},
		setInitialDraftOnly: (nextDraft: TableDraft | null) => {
			draft = nextDraft;
		}
	});
</script>

<TablePanel
	active={true}
	initialDraft={draft}
	{sessionKey}
	{locale}
	{onInsert}
	{onClose}
/>
`
		);
		fs.writeFileSync(
			entryFile,
			`import { mount, unmount, flushSync, tick } from 'svelte';
import TablePanelHarness from ${JSON.stringify(normalizedHarnessFile)};
export { mount, unmount, flushSync, tick, TablePanelHarness };
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
				outDir: buildDir,
				emptyOutDir: false,
				lib: {
					entry: entryFile,
					formats: ['es'],
					fileName: () => 'table-initial-draft-client.mjs'
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

		const bundleUrl = pathToFileURL(path.join(buildDir, 'table-initial-draft-client.mjs')).href;
		client = (await import(bundleUrl)) as ClientModule;
	},
	{ timeout: 120_000 }
);

test(
	'TablePanel first-mount consumes initialDraft with default insert key, preserves dirty edits on same key, resets on new key, and emits table source',
	{ timeout: 30_000 },
	async () => {
		assert.ok(dom, 'JSDOM environment must be initialized');
		assert.ok(client, 'Actual Vite-built Svelte client must be loaded');
		const win = dom.window;
		const api = client;
		const container = win.document.getElementById('app');
		assert.ok(container);

		const insertedSources: Array<{ source: string; booktabs?: boolean }> = [];
		let closeCount = 0;
		let controller: {
			setLocale: (nextLocale: Locale) => void;
			setSession: (key: string, draft: TableDraft | null) => void;
			setInitialDraftOnly: (draft: TableDraft | null) => void;
		} | undefined;

		// Initial draft provided on first mount with default sessionKey ("insert")
		const firstDraft: TableDraft = {
			rows: 2,
			columns: 2,
			cells: ['Header A', 'Header B', 'Cell 1', 'Cell 2'],
			weights: [1, 1],
			width: 100,
			style: 'three-line',
			rules: 'hline',
			header: true,
			caption: { position: 'none', text: '' }
		};

		let mounted: unknown;
		try {
			mounted = api.mount(api.TablePanelHarness, {
				target: container,
				props: {
					initialDraft: firstDraft,
					initialSessionKey: 'insert',
					initialLocale: 'zh-Hant',
					onInsert: (source: string, booktabs?: boolean) => {
						insertedSources.push({ source, booktabs });
					},
					onClose: () => {
						closeCount++;
					},
					onController: (ctrl: PanelController) => {
						controller = ctrl;
					}
				}
			});
			api.flushSync();
			await api.tick();
			await api.tick();
			api.flushSync();

			const panel = container.querySelector<HTMLElement>('.table-panel');
			assert.ok(panel, 'TablePanel must be mounted in DOM');

			const cellInputs = () => Array.from(panel.querySelectorAll<HTMLInputElement>('tbody td input'));
			const cellValues = () => cellInputs().map((input) => input.value);

			// 1. Verify first-mount consumed actual initialDraft even with default sessionKey ("insert")
			assert.deepEqual(
				cellValues(),
				['Header A', 'Header B', 'Cell 1', 'Cell 2'],
				'First mount must populate cells from initialDraft under default insert key'
			);

			// 2. Perform a local user edit to cell 0 (create dirty draft state)
			const firstCell = cellInputs()[0];
			assert.ok(firstCell);
			firstCell.value = 'Modified Header';
			firstCell.dispatchEvent(new win.Event('input', { bubbles: true }));
			api.flushSync();
			await api.tick();
			assert.equal(cellValues()[0], 'Modified Header', 'Local edit must update displayed cell');

			// 3. Same session: update locale and external initialDraft prop without changing sessionKey
			assert.ok(controller, 'Harness controller must be captured');
			controller.setLocale('en');
			controller.setInitialDraftOnly({
				...firstDraft,
				cells: ['Replaced 1', 'Replaced 2', 'Replaced 3', 'Replaced 4']
			});
			await api.tick();
			api.flushSync();

			// Dirty edits must be preserved because sessionKey has not changed
			assert.equal(
				cellValues()[0],
				'Modified Header',
				'Same-session prop/locale updates must NOT overwrite user dirty draft'
			);

			// 4. New sessionKey transition: reset to new session draft
			const secondDraft: TableDraft = {
				rows: 1,
				columns: 2,
				cells: ['Brand New 1', 'Brand New 2'],
				weights: [1, 2],
				width: 80,
				style: 'full',
				rules: 'hline',
				header: false,
				caption: { position: 'none', text: '' }
			};
			controller.setSession('session-edit-2', secondDraft);
			await api.tick();
			api.flushSync();

			// New session key resets table state to secondDraft
			assert.deepEqual(
				cellValues(),
				['Brand New 1', 'Brand New 2'],
				'New sessionKey must reset table state to the new draft'
			);

			// 5. Trigger insertion and verify actual emitted table source
			const applyButton = panel.querySelector<HTMLButtonElement>('.actions button.primary');
			assert.ok(applyButton);
			applyButton.click();
			api.flushSync();

			assert.equal(insertedSources.length, 1, 'Clicking insert/apply must emit table source');
			assert.match(insertedSources[0]!.source, /\\begin\{tabular\}/);
			assert.match(insertedSources[0]!.source, /Brand New 1/);
			assert.match(insertedSources[0]!.source, /Brand New 2/);
			assert.equal(closeCount, 0);
		} finally {
			if (mounted !== undefined) {
				await api.unmount(mounted);
				api.flushSync();
			}
		}

		assert.equal(container.querySelector('.table-panel'), null, 'Unmount must clean up TablePanel from DOM');
	}
);
