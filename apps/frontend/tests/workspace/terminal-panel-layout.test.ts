import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
	JSDOM: new (html: string, options: { url: string; pretendToBeVisual: boolean }) => {
		window: Window & typeof globalThis & { close(): void };
	};
};
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
	url: 'https://modutex.test',
	pretendToBeVisual: true
});

const frontendRoot = fileURLToPath(new URL('../../', import.meta.url)).replaceAll('\\', '/');
const dockPath = fileURLToPath(new URL('../../src/components/WorkbenchDock.svelte', import.meta.url)).replaceAll('\\', '/');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'terminal-panel-layout-'));
const previous = new Map<string, PropertyDescriptor | undefined>();
const globals = [
	'window', 'document', 'navigator', 'location', 'Node', 'Element', 'HTMLElement', 'Text', 'Comment',
	'CharacterData', 'Attr', 'Document', 'DocumentFragment', 'HTMLDivElement', 'HTMLButtonElement', 'HTMLSpanElement', 'HTMLParagraphElement',
	'HTMLMediaElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLOptionElement', 'HTMLFormElement', 'HTMLTextAreaElement', 'HTMLTemplateElement', 'HTMLStyleElement', 'Event', 'EventTarget', 'CustomEvent',
	'KeyboardEvent', 'MouseEvent', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'
];
for (const key of globals) {
	previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
	const value = key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : Reflect.get(dom.window, key);
	if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const harnessPath = path.join(tempDir, 'WorkbenchDockHarness.svelte').replaceAll('\\', '/');
const entryPath = path.join(tempDir, 'entry.js');
fs.writeFileSync(harnessPath, `<script lang="ts">
	import WorkbenchDock from '${dockPath}';
	let { onState }: { onState: (state: { sizes: number[][]; starts: number[][]; fitCount: () => number; wasDisposed: () => boolean; wasClosed: () => boolean }) => void } = $props();
	let activeTab: 'problems' | 'output' | 'terminal' | null = $state(null);
	const sizes: number[][] = [];
	const starts: number[][] = [];
	let fitCount = 0;
	let wasDisposed = false;
	let wasClosed = false;
	const controller = {
		availability: async () => ({ available: true, reason: '', detail: '' }),
		start: async (cols: number, rows: number) => { starts.push([cols, rows]); },
		send: () => true,
		resize: (cols: number, rows: number) => { sizes.push([cols, rows]); return true; },
		close: async () => { wasClosed = true; }
	};
	const sessionFactory = async () => controller;
	const viewFactory = async (_host: HTMLElement, handlers: { onInput(value: string): void; onResize(cols: number, rows: number): void }) => ({
		write: async () => {},
		fit: () => { fitCount++; handlers.onResize(88 + fitCount, 28); },
		focus: () => {},
		size: () => ({ cols: 100, rows: 30 }),
		reset: () => {},
		dispose: () => { wasDisposed = true; }
	});
	onState({ sizes, starts, fitCount: () => fitCount, wasDisposed: () => wasDisposed, wasClosed: () => wasClosed });
</script>
<div class="terminal-test-container">
	<WorkbenchDock bind:activeTab workspaceId="test-workspace" locale="en" terminalSessionFactory={sessionFactory} terminalViewFactory={viewFactory} />
</div>
`);
fs.writeFileSync(entryPath, `import { mount, unmount, flushSync, tick } from 'svelte';
import TerminalPanelHarness from '${harnessPath}';
export { mount, unmount, flushSync, tick, TerminalPanelHarness };
`);

await build({
	configFile: false,
	root: frontendRoot,
	plugins: [svelte({ emitCss: false })],
	resolve: { dedupe: ['svelte'], conditions: ['browser', 'default'] },
	build: {
		write: true,
		outDir: tempDir,
		emptyOutDir: false,
		lib: { entry: entryPath, formats: ['es'], fileName: () => 'terminal-panel-client.mjs' },
		rollupOptions: { external: [] },
		sourcemap: false,
		minify: false
	},
	logLevel: 'silent'
});

const client = await import(pathToFileURL(path.join(tempDir, 'terminal-panel-client.mjs')).href) as {
	mount: (component: unknown, options: { target: HTMLElement; props: Record<string, unknown> }) => unknown;
	unmount: (component: unknown) => Promise<void>;
	flushSync: () => void;
	tick: () => Promise<void>;
	TerminalPanelHarness: unknown;
};

after(async () => {
	try {
		dom.window.close();
		fs.rmSync(tempDir, { recursive: true, force: true });
	} finally {
		for (const [key, descriptor] of previous) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
});

test('bottom dock resizes with pointer and keyboard, preserves the hidden PTY, and stops only on the terminal action', { timeout: 180_000 }, async () => {
	const target = dom.window.document.getElementById('app');
	assert.ok(target);
	let state!: { sizes: number[][]; starts: number[][]; fitCount: () => number; wasDisposed: () => boolean; wasClosed: () => boolean };
	const instance = client.mount(client.TerminalPanelHarness, {
		target,
		props: { onState: (value: typeof state) => { state = value; } }
	});
	client.flushSync();
	const parent = target.querySelector<HTMLElement>('.terminal-test-container');
	const dock = target.querySelector<HTMLElement>('.workbench-dock');
	const terminalTab = target.querySelector<HTMLButtonElement>('#workbench-dock-tab-terminal');
	const closeDock = target.querySelector<HTMLButtonElement>('.workbench-dock-close');
	const panel = target.querySelector<HTMLElement>('#workbench-terminal-panel');
	const terminalTabPanel = target.querySelector<HTMLElement>('#workbench-dock-panel-terminal');
	assert.ok(parent && dock && terminalTab && closeDock && panel && terminalTabPanel);
	parent.getBoundingClientRect = () => ({
		width: 800,
		height: 600,
		top: 20,
		bottom: 620,
		left: 0,
		right: 800,
		x: 0,
		y: 20,
		toJSON: () => {}
	});

	const settle = async () => {
		for (let index = 0; index < 6; index++) {
			await new Promise((resolve) => setTimeout(resolve, 0));
			await client.tick();
			client.flushSync();
		}
	};

	try {
		assert.equal(terminalTabPanel.hidden, true);
		terminalTab.click();
		await settle();
		assert.equal(terminalTab.getAttribute('aria-selected'), 'true');
		assert.equal(terminalTabPanel.hidden, false);
		assert.equal(panel.hidden, false);

		const separator = target.querySelector<HTMLElement>('.workbench-dock-separator');
		assert.ok(separator);
		assert.equal(separator.getAttribute('aria-orientation'), 'horizontal');
		assert.equal(separator.getAttribute('aria-controls'), 'workbench-dock-body');
		assert.equal(separator.getAttribute('aria-valuemin'), '180');
		assert.equal(separator.getAttribute('aria-valuemax'), '452');

		const pointer = (name: string, clientY: number) => {
			const event = new dom.window.MouseEvent(name, { bubbles: true, button: 0, clientY });
			Object.defineProperty(event, 'pointerId', { value: 7 });
			return event;
		};
		separator.dispatchEvent(pointer('pointerdown', 300));
		separator.dispatchEvent(pointer('pointermove', 420));
		client.flushSync();
		assert.equal(dock.style.height, '200px', 'pointer drag changes the real dock height');
		separator.dispatchEvent(pointer('pointerup', 420));
		await settle();
		assert.ok(state.fitCount() >= 2, 'terminal view refits after a visible dock resize');

		target.querySelector<HTMLButtonElement>('[data-terminal-action="start"]')?.click();
		await settle();
		assert.deepEqual(state.starts, [[100, 30]], 'PTY starts at the current terminal view dimensions');
		assert.deepEqual(state.sizes.at(-1), [100, 30], 'PTY receives its initial live size');
		const sizesBeforeDrag = state.sizes.length;
		separator.dispatchEvent(pointer('pointerdown', 420));
		separator.dispatchEvent(pointer('pointermove', 430));
		separator.dispatchEvent(pointer('pointerup', 430));
		await settle();
		assert.equal(dock.style.height, '190px', 'pointer drag changes the real dock height');
		assert.ok(state.sizes.length > sizesBeforeDrag, 'live PTY receives the refitted dimensions after dragging');

		const problemsTab = target.querySelector<HTMLButtonElement>('#workbench-dock-tab-problems');
		assert.ok(problemsTab);
		problemsTab.focus();
		problemsTab.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
		client.flushSync();
		assert.equal(target.querySelector<HTMLButtonElement>('#workbench-dock-tab-output')?.getAttribute('aria-selected'), 'true', 'arrow navigation selects the next dock tab');
		terminalTab.click();
		await settle();
		const fittedBeforeHide = state.fitCount();
		problemsTab.click();
		await settle();
		assert.equal(terminalTabPanel.hidden, true, 'switching tabs hides terminal content');
		assert.equal(state.wasClosed(), false, 'switching tabs keeps the PTY session alive');
		assert.equal(state.wasDisposed(), false, 'switching tabs keeps the terminal view mounted');
		terminalTab.click();
		await settle();
		assert.ok(state.fitCount() > fittedBeforeHide, 'terminal is fitted again when its tab becomes visible');
		assert.ok(state.sizes.length >= 4, 'PTY receives the restored dimensions when the tab becomes visible');

		separator.focus();
		separator.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
		client.flushSync();
		await settle();
		assert.equal(separator.getAttribute('aria-valuenow'), '452');
		assert.equal(dock.style.height, '148px', 'keyboard resize updates the same shared dock');
		assert.ok(state.fitCount() > fittedBeforeHide, 'terminal view refits after keyboard resizing');

		closeDock.click();
		await settle();
		assert.equal(terminalTabPanel.hidden, true, 'the dock X hides the panel content');
		assert.equal(dom.window.document.activeElement, closeDock, 'closing the dock keeps keyboard focus on its close control');
		assert.equal(state.wasClosed(), false, 'the dock X does not stop the terminal process');
		assert.equal(state.wasDisposed(), false, 'the dock X does not unmount the terminal view');
		terminalTab.click();
		await settle();
		target.querySelector<HTMLButtonElement>('[data-terminal-action="close"]')?.click();
		await settle();
		assert.equal(state.wasClosed(), true);
		assert.equal(state.wasDisposed(), true);
	} finally {
		await client.unmount(instance);
	}
});
