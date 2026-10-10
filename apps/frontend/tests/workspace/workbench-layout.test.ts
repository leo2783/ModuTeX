import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

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
const workbenchLayoutPath = fileURLToPath(new URL('../../src/components/WorkbenchLayout.svelte', import.meta.url)).replaceAll('\\', '/');

let tempDir: string | null = null;
let dom: { window: DOMWindow } | null = null;

type DomGlobalKey = Extract<keyof DOMWindow, keyof typeof globalThis>;

// HTMLSummaryElement constructor is non-standard / not present in DOM specs; explicitly omitted
const explicitDomKeys: readonly DomGlobalKey[] = [
	'window',
	'document',
	'navigator',
	'location',
	'Node',
	'Element',
	'HTMLElement',
	'HTMLMediaElement',
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
	'PointerEvent',
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

// 1. Build client entry exporting public Svelte APIs and WorkbenchTestHarness
tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'svelte-workbench-test-'));
const harnessPath = path.join(tempDir, 'WorkbenchTestHarness.svelte').replaceAll('\\', '/');
fs.writeFileSync(
	harnessPath,
	`<script lang="ts">
	import WorkbenchLayout from '${workbenchLayoutPath}';
	import type { Language } from '${frontendRoot}/src/i18n/text.ts';

	let {
		forceMode = 'wide',
		locale = 'zh-Hant',
		initialSplitRatio = 0.5,
		initialActivePane = 'document',
		onPaneChange,
		onRatioChange,
		bindHarness
	}: {
		forceMode?: 'wide' | 'narrow';
		locale?: Language;
		initialSplitRatio?: number;
		initialActivePane?: 'document' | 'pdf';
		onPaneChange?: (pane: 'document' | 'pdf') => void;
		onRatioChange?: (ratio: number) => void;
		bindHarness?: (api: { setForceMode: (m: 'wide' | 'narrow') => void }) => void;
	} = $props();

	let currentMode = $state<'wide' | 'narrow'>(forceMode);
	let activePane = $state<'document' | 'pdf'>(initialActivePane);
	let splitRatio = $state(initialSplitRatio);

	$effect(() => {
		onPaneChange?.(activePane);
	});
	$effect(() => {
		onRatioChange?.(splitRatio);
	});

	bindHarness?.({
		setForceMode: (m: 'wide' | 'narrow') => {
			currentMode = m;
		}
	});
</script>

<div class="harness-root">
	<WorkbenchLayout
		{locale}
		forceMode={currentMode}
		bind:activePane
		bind:splitRatio
	>
		{#snippet sidebarContent()}
			<aside id="test-sidebar">Sidebar Content</aside>
		{/snippet}
		{#snippet editor({ active, hidden, inert })}
			<div id="test-editor-pane" data-active={active ? 'true' : 'false'} data-hidden={hidden ? 'true' : 'false'} data-inert={inert ? 'true' : 'false'}>
				Editor Pane Content
			</div>
		{/snippet}
		{#snippet preview({ active, hidden, inert })}
			<div id="test-preview-pane" data-active={active ? 'true' : 'false'} data-hidden={hidden ? 'true' : 'false'} data-inert={inert ? 'true' : 'false'}>
				Preview Pane Content
			</div>
		{/snippet}
	</WorkbenchLayout>
</div>
`
);

const entryFile = path.join(tempDir, 'entry.js');
fs.writeFileSync(
	entryFile,
	`import { mount, unmount, flushSync, tick } from 'svelte';
import WorkbenchTestHarness from '${harnessPath}';
export { mount, unmount, flushSync, tick, WorkbenchTestHarness };
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
			fileName: () => 'workbench-client.mjs'
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

// JSDOM does not provide PointerEvent by default, polyfill from MouseEvent
const MouseEventConstructor = dom.window.MouseEvent;
if (!Reflect.has(dom.window, 'PointerEvent')) {
	class PointerEventPolyfill extends MouseEventConstructor {
		readonly pointerId: number;
		readonly width: number;
		readonly height: number;
		readonly pressure: number;
		readonly pointerType: string;
		readonly isPrimary: boolean;

		constructor(type: string, params: PointerEventInit = {}) {
			super(type, params);
			this.pointerId = params.pointerId ?? 1;
			this.width = params.width ?? 1;
			this.height = params.height ?? 1;
			this.pressure = params.pressure ?? 0;
			this.pointerType = params.pointerType ?? 'mouse';
			this.isPrimary = params.isPrimary ?? true;
		}
	}
	Reflect.set(dom.window, 'PointerEvent', PointerEventPolyfill);
}

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

// 3. Dynamically import compiled client module
const bundleUrl = pathToFileURL(path.join(tempDir, 'workbench-client.mjs')).href;
const { mount, unmount, flushSync, tick, WorkbenchTestHarness } = (await import(bundleUrl)) as {
	mount: (component: unknown, options: { target: HTMLElement; props: Record<string, unknown> }) => unknown;
	unmount: (instance: unknown, options?: { outro?: boolean }) => Promise<void>;
	flushSync: (fn?: () => void) => void;
	tick: () => Promise<void>;
	WorkbenchTestHarness: unknown;
};

test('narrow viewport (<=960): hides sidebar, shows tabs, keeps both panes mounted, and toggles active/hidden/inert truthfully', async () => {
	assert.ok(dom, 'DOM must be initialized');
	const container = dom.window.document.getElementById('app');
	assert.ok(container);
	container.innerHTML = '';

	let currentPane: 'document' | 'pdf' = 'document';
	const instance = mount(WorkbenchTestHarness, {
		target: container,
		props: {
			forceMode: 'narrow',
			locale: 'zh-Hant',
			initialActivePane: 'document',
			onPaneChange: (p: 'document' | 'pdf') => {
				currentPane = p;
			}
		}
	});
	flushSync();

	try {
		// 1. Sidebar slot must NOT be rendered in narrow mode
		const sidebar = container.querySelector('#test-sidebar');
		assert.equal(sidebar, null, 'Sidebar must be hidden in narrow mode');

		// 2. Workbench tabs and tabpanels with proper ARIA controls and labelling
		const tabList = container.querySelector('[role="tablist"]');
		assert.ok(tabList, 'Tablist must be present in narrow mode');
		const docTab = tabList.querySelector<HTMLButtonElement>('#workbench-tab-document');
		const pdfTab = tabList.querySelector<HTMLButtonElement>('#workbench-tab-pdf');
		assert.ok(docTab);
		assert.ok(pdfTab);

		assert.equal(docTab.getAttribute('aria-controls'), 'workbench-panel-document');
		assert.equal(pdfTab.getAttribute('aria-controls'), 'workbench-panel-pdf');
		assert.equal(docTab.getAttribute('tabindex'), '0');
		assert.equal(pdfTab.getAttribute('tabindex'), '-1');

		const docPanel = container.querySelector<HTMLElement>('#workbench-panel-document');
		const pdfPanel = container.querySelector<HTMLElement>('#workbench-panel-pdf');
		assert.ok(docPanel);
		assert.ok(pdfPanel);
		assert.equal(docPanel.getAttribute('role'), 'tabpanel');
		assert.equal(docPanel.getAttribute('aria-labelledby'), 'workbench-tab-document');
		assert.equal(pdfPanel.getAttribute('role'), 'tabpanel');
		assert.equal(pdfPanel.getAttribute('aria-labelledby'), 'workbench-tab-pdf');

		// 3. Both panes must remain mounted in DOM
		const editorPane = container.querySelector<HTMLElement>('#test-editor-pane');
		const previewPane = container.querySelector<HTMLElement>('#test-preview-pane');
		assert.ok(editorPane, 'Editor pane must remain mounted');
		assert.ok(previewPane, 'Preview pane must remain mounted');

		// Initial active/hidden/inert status
		assert.equal(editorPane.dataset.active, 'true', 'Editor must be active when Document tab selected');
		assert.equal(editorPane.dataset.hidden, 'false');
		assert.equal(editorPane.dataset.inert, 'false');

		assert.equal(previewPane.dataset.active, 'false', 'Preview must be inactive when Document tab selected');
		assert.equal(previewPane.dataset.hidden, 'true');
		assert.equal(previewPane.dataset.inert, 'true');

		// 4. Switch to PDF tab via click
		pdfTab.click();
		flushSync();

		assert.equal(currentPane, 'pdf');
		assert.equal(docTab.getAttribute('aria-selected'), 'false');
		assert.equal(pdfTab.getAttribute('aria-selected'), 'true');
		assert.equal(docTab.getAttribute('tabindex'), '-1');
		assert.equal(pdfTab.getAttribute('tabindex'), '0');

		// Assert pane states flipped without unmounting
		assert.equal(editorPane.dataset.active, 'false');
		assert.equal(editorPane.dataset.hidden, 'true');
		assert.equal(editorPane.dataset.inert, 'true');

		assert.equal(previewPane.dataset.active, 'true');
		assert.equal(previewPane.dataset.hidden, 'false');
		assert.equal(previewPane.dataset.inert, 'false');

		// 5. Keyboard roving navigation between tabs (ArrowLeft, ArrowRight, Home, End)
		pdfTab.focus();
		pdfTab.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
		flushSync();

		assert.equal(currentPane, 'document');
		assert.equal(docTab.getAttribute('aria-selected'), 'true');
		assert.equal(dom.window.document.activeElement, docTab, 'Focus must rove to Document tab');

		docTab.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		flushSync();

		assert.equal(currentPane, 'pdf');
		assert.equal(pdfTab.getAttribute('aria-selected'), 'true');
		assert.equal(dom.window.document.activeElement, pdfTab, 'Focus must rove to PDF tab');

		pdfTab.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
		flushSync();
		assert.equal(currentPane, 'document');
		assert.equal(dom.window.document.activeElement, docTab);
	} finally {
		await unmount(instance);
	}
});

test('wide viewport (>960): renders sidebar, hides tabs, activates both panes, and renders separator with complete ARIA semantics', async () => {
	assert.ok(dom, 'DOM must be initialized');
	const container = dom.window.document.getElementById('app');
	assert.ok(container);
	container.innerHTML = '';

	const instance = mount(WorkbenchTestHarness, {
		target: container,
		props: {
			forceMode: 'wide',
			locale: 'zh-Hant',
			initialSplitRatio: 0.5
		}
	});
	flushSync();

	try {
		// 1. Sidebar slot must be rendered
		const sidebar = container.querySelector('#test-sidebar');
		assert.ok(sidebar, 'Sidebar must be visible in wide mode');

		// 2. Tabs must not be rendered in wide mode
		const tabList = container.querySelector('[role="tablist"]');
		assert.equal(tabList, null, 'Tabs must not be rendered in wide mode');

		// 3. Both editor and preview panes must be active, not hidden, and not inert
		const editorPane = container.querySelector<HTMLElement>('#test-editor-pane');
		const previewPane = container.querySelector<HTMLElement>('#test-preview-pane');
		assert.ok(editorPane);
		assert.ok(previewPane);
		assert.equal(editorPane.dataset.active, 'true');
		assert.equal(editorPane.dataset.hidden, 'false');
		assert.equal(editorPane.dataset.inert, 'false');

		assert.equal(previewPane.dataset.active, 'true');
		assert.equal(previewPane.dataset.hidden, 'false');
		assert.equal(previewPane.dataset.inert, 'false');

		// 4. Draggable separator must be rendered with proper accessibility attributes
		const separator = container.querySelector<HTMLElement>('[role="separator"]');
		assert.ok(separator, 'Draggable separator must exist in wide mode');
		assert.equal(separator.getAttribute('tabindex'), '0');
		assert.equal(separator.getAttribute('aria-orientation'), 'vertical');
		assert.equal(separator.getAttribute('aria-valuenow'), '50');
	} finally {
		await unmount(instance);
	}
});

test('keyboard bounds and resizing respect container-derived 280px minimum constraints', async () => {
	assert.ok(dom, 'DOM must be initialized');
	const container = dom.window.document.getElementById('app');
	assert.ok(container);
	container.innerHTML = '';

	let currentRatio = 0.5;
	const instance = mount(WorkbenchTestHarness, {
		target: container,
		props: {
			forceMode: 'wide',
			initialSplitRatio: 0.5,
			onRatioChange: (r: number) => {
				currentRatio = r;
			}
		}
	});
	flushSync();

	try {
		const separator = container.querySelector<HTMLElement>('[role="separator"]');
		assert.ok(separator);
		const panesContainer = container.querySelector<HTMLElement>('.workbench-panes');
		assert.ok(panesContainer);

		// Provide realistic 1000px container geometry for the calculation algorithm
		// 280px minimum => minAllowed = 280 / 1000 = 0.28, maxAllowed = 1 - 280 / 1000 = 0.72
		panesContainer.getBoundingClientRect = () => ({
			width: 1000,
			height: 600,
			top: 0,
			bottom: 600,
			left: 200,
			right: 1200,
			x: 200,
			y: 0,
			toJSON: () => {}
		});

		separator.focus();
		assert.equal(dom.window.document.activeElement, separator);

		// Home key sets to container-derived minimum (0.28, NOT hardcoded 0.2)
		separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
		flushSync();
		assert.equal(Math.round(currentRatio * 100) / 100, 0.28, 'Home must respect 280px container bound = 0.28');
		assert.equal(separator.getAttribute('aria-valuenow'), '28');

		// ArrowLeft cannot decrease past 0.28
		separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
		flushSync();
		assert.equal(Math.round(currentRatio * 100) / 100, 0.28);

		// End key sets to container-derived maximum (0.72, NOT hardcoded 0.8)
		separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		flushSync();
		assert.equal(Math.round(currentRatio * 100) / 100, 0.72, 'End must respect 280px container bound = 0.72');
		assert.equal(separator.getAttribute('aria-valuenow'), '72');

		// ArrowRight cannot exceed 0.72
		separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		flushSync();
		assert.equal(Math.round(currentRatio * 100) / 100, 0.72);

		// Window resize / container resize clamping test:
		// Container shrinks to 700px: 280px bound => min = 280/700 = 0.40, max = 1 - 280/700 = 0.60
		// Current ratio (0.72) exceeds new maximum (0.60) and must be clamped on resize
		panesContainer.getBoundingClientRect = () => ({
			width: 700,
			height: 600,
			top: 0,
			bottom: 600,
			left: 200,
			right: 900,
			x: 200,
			y: 0,
			toJSON: () => {}
		});

		dom.window.dispatchEvent(new dom.window.Event('resize'));
		flushSync();

		assert.equal(Math.round(currentRatio * 100) / 100, 0.6, 'Resize must clamp existing ratio to new container bound 0.60');
	} finally {
		await unmount(instance);
	}
});

test('pointer ownership ignores second pointer, releases capture cleanly, and cleans up on mid-drag narrow transition', async () => {
	assert.ok(dom, 'DOM must be initialized');
	const container = dom.window.document.getElementById('app');
	assert.ok(container);
	container.innerHTML = '';

	let harnessApi!: { setForceMode: (m: 'wide' | 'narrow') => void };
	let currentRatio = 0.5;

	const instance = mount(WorkbenchTestHarness, {
		target: container,
		props: {
			forceMode: 'wide',
			initialSplitRatio: 0.5,
			onRatioChange: (r: number) => {
				currentRatio = r;
			},
			bindHarness: (api: typeof harnessApi) => {
				harnessApi = api;
			}
		}
	});
	flushSync();

	try {
		const separator = container.querySelector<HTMLElement>('[role="separator"]');
		assert.ok(separator);
		const panesContainer = container.querySelector<HTMLElement>('.workbench-panes');
		assert.ok(panesContainer);

		panesContainer.getBoundingClientRect = () => ({
			width: 1000,
			height: 600,
			top: 0,
			bottom: 600,
			left: 0,
			right: 1000,
			x: 0,
			y: 0,
			toJSON: () => {}
		});

		let capturedPointerId: number | null = null;
		let releaseCalls: number[] = [];

		separator.setPointerCapture = (id: number) => {
			capturedPointerId = id;
		};
		separator.hasPointerCapture = (id: number) => capturedPointerId === id;
		separator.releasePointerCapture = (id: number) => {
			releaseCalls.push(id);
			if (capturedPointerId === id) capturedPointerId = null;
		};

		const PointerEventClass = Reflect.get(dom.window, 'PointerEvent') as typeof PointerEvent;

		// 1. Primary pointerdown establishes ownership
		separator.dispatchEvent(new PointerEventClass('pointerdown', { pointerId: 10, button: 0, bubbles: true }));
		flushSync();

		assert.equal(separator.classList.contains('dragging'), true);
		assert.equal(capturedPointerId, 10, 'Primary pointer 10 must be captured');

		// 2. First pointermove updates ratio
		separator.dispatchEvent(new PointerEventClass('pointermove', { pointerId: 10, clientX: 400, bubbles: true }));
		flushSync();
		assert.equal(Math.round(currentRatio * 100) / 100, 0.4, 'First pointermove must update ratio to 0.4');
		assert.equal(separator.classList.contains('dragging'), true);

		// Two pointermove events separated by Svelte tick continue dragging without effect cleanup abortion
		await tick();
		flushSync();

		// Second pointermove continues drag smoothly
		separator.dispatchEvent(new PointerEventClass('pointermove', { pointerId: 10, clientX: 350, bubbles: true }));
		flushSync();
		assert.equal(Math.round(currentRatio * 100) / 100, 0.35, 'Second pointermove after tick must update ratio to 0.35');
		assert.equal(separator.classList.contains('dragging'), true, 'Dragging must continue across tick');

		// 3. (Blocker 1 regression) Secondary pointerdown while captured is strictly IGNORED
		separator.dispatchEvent(new PointerEventClass('pointerdown', { pointerId: 20, button: 0, bubbles: true }));
		flushSync();

		assert.equal(capturedPointerId, 10, 'Secondary pointer 20 must NOT steal ownership');

		// Secondary pointermove has no effect on split
		const ratioBefore = currentRatio;
		separator.dispatchEvent(new PointerEventClass('pointermove', { pointerId: 20, clientX: 700, bubbles: true }));
		flushSync();
		assert.equal(currentRatio, ratioBefore, 'Movement from secondary pointer 20 must be ignored');

		// 4. (Blocker 2 regression) pointerup releases capture safely and clears internal element before release
		separator.dispatchEvent(new PointerEventClass('pointerup', { pointerId: 10, bubbles: true }));
		flushSync();

		assert.equal(separator.classList.contains('dragging'), false);
		assert.deepEqual(releaseCalls, [10], 'releasePointerCapture must be called for pointer 10');
		assert.equal(capturedPointerId, null);

		// 5. Blur event releases active capture safely
		separator.dispatchEvent(new PointerEventClass('pointerdown', { pointerId: 25, button: 0, bubbles: true }));
		flushSync();
		assert.equal(separator.classList.contains('dragging'), true);
		assert.equal(capturedPointerId, 25);

		dom.window.dispatchEvent(new dom.window.Event('blur'));
		flushSync();
		assert.equal(separator.classList.contains('dragging'), false, 'Blur must release drag');
		assert.ok(releaseCalls.includes(25), 'releasePointerCapture must be called on blur');

		// 6. (Blocker 5 regression) Mid-drag transition to narrow mode cleans up active capture safely
		separator.dispatchEvent(new PointerEventClass('pointerdown', { pointerId: 30, button: 0, bubbles: true }));
		flushSync();
		assert.equal(separator.classList.contains('dragging'), true);
		assert.equal(capturedPointerId, 30);

		// Trigger mode change while dragging
		harnessApi.setForceMode('narrow');
		flushSync();

		assert.equal(container.querySelector('[role="separator"]'), null, 'Separator must be destroyed in narrow mode');
		assert.ok(releaseCalls.includes(30), 'releasePointerCapture must be called on mid-drag transition');
	} finally {
		await unmount(instance);
	}
});
