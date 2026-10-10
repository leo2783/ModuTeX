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
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
	url: 'https://modutex.test',
	pretendToBeVisual: true
});

type Pane = 'document' | 'pdf';
type Mode = 'wide' | 'narrow';

interface HarnessController {
	setMode(value: Mode): void;
	setPane(value: Pane): void;
	setRatio(value: number): void;
	getPane(): Pane;
	getRatio(): number;
	getDraft(): string;
}

interface ClientRuntime {
	readonly WorkbenchLayoutHarness: any;
	readonly mount: (component: any, options: { target: Element; props?: any }) => any;
	readonly unmount: (component: any) => Promise<void>;
	readonly flushSync: () => void;
	readonly tick: () => Promise<void>;
}

interface MountedHarness {
	readonly container: HTMLElement;
	readonly runtime: ClientRuntime;
	readonly setMode: (value: Mode) => void;
	readonly setPane: (value: Pane) => void;
	readonly setRatio: (value: number) => void;
	readonly getPane: () => Pane;
	readonly getRatio: () => number;
	readonly getDraft: () => string;
	readonly settle: () => Promise<void>;
	readonly cleanup: () => Promise<void>;
}

const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();
let platformInstalled = false;
let bundleDirectory: string | null = null;
let pendingBuild: Promise<unknown> | null = null;
let compiledHarnessPromise: Promise<ClientRuntime> | null = null;

const layoutFile = fileURLToPath(new URL('../../src/components/WorkbenchLayout.svelte', import.meta.url));
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

function installPlatformGlobals() {
	if (platformInstalled) return;
	platformInstalled = true;
	const win = dom.window as unknown as Record<string, unknown>;
	const globals = [
		'window', 'document', 'navigator', 'location', 'MutationObserver', 'Node', 'Element', 'HTMLElement',
		'HTMLButtonElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLMediaElement', 'Text', 'Comment', 'Document',
		'DocumentFragment', 'EventTarget', 'Event', 'CustomEvent', 'KeyboardEvent', 'FocusEvent',
		'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'
	];
	for (const key of globals) {
		if (!previousDescriptors.has(key)) previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		const value = key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : win[key];
		if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
}

function restorePlatformGlobals() {
	for (const [key, descriptor] of previousDescriptors) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousDescriptors.clear();
	platformInstalled = false;
}

function cleanupBundleDirectory() {
	const directory = bundleDirectory;
	bundleDirectory = null;
	if (directory) fs.rmSync(directory, { recursive: true, force: true });
}

const harnessSource = (layoutPath: string) => `<script lang="ts">
	import WorkbenchLayout from ${JSON.stringify(layoutPath)};
	type Pane = 'document' | 'pdf';
	type Mode = 'wide' | 'narrow';
	type Controller = {
		setMode(value: Mode): void;
		setPane(value: Pane): void;
		setRatio(value: number): void;
		getPane(): Pane;
		getRatio(): number;
		getDraft(): string;
	};
	let { onController }: { onController: (controller: Controller) => void } = $props();
	let mode = $state<Mode>('wide');
	let activePane = $state<Pane>('document');
	let splitRatio = $state(0.5);
	let draft = $state('initial draft');
	onController({
		setMode(value) { mode = value; },
		setPane(value) { activePane = value; },
		setRatio(value) { splitRatio = value; },
		getPane() { return activePane; },
		getRatio() { return splitRatio; },
		getDraft() { return draft; }
	});
</script>

<WorkbenchLayout forceMode={mode} bind:activePane bind:splitRatio>
	{#snippet sidebarContent()}
		<aside><button id="sidebar-control" type="button">Sidebar control</button></aside>
	{/snippet}
	{#snippet editor({ active, hidden, inert })}
		<section id="editor-content" data-active={active} {hidden} {inert}>
			<textarea id="draft" bind:value={draft}></textarea>
		</section>
	{/snippet}
	{#snippet preview({ active, hidden, inert })}
		<section id="preview-content" data-active={active} {hidden} {inert}>PDF preview</section>
	{/snippet}
</WorkbenchLayout>
`;

async function compileClientHarness(): Promise<ClientRuntime> {
	installPlatformGlobals();
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-layout-lifetime-'));
	bundleDirectory = directory;
	const harnessFile = path.join(directory, 'WorkbenchLayoutHarness.svelte');
	const entryFile = path.join(directory, 'entry.js');
	const bundleFile = path.join(directory, 'workbench-layout-lifetime.mjs');
	try {
		fs.writeFileSync(harnessFile, harnessSource(layoutFile.replace(/\\/g, '/')));
		fs.writeFileSync(entryFile, [
			`import { mount, unmount, flushSync, tick } from 'svelte';`,
			`import WorkbenchLayoutHarness from ${JSON.stringify(harnessFile.replace(/\\/g, '/'))};`,
			'export { mount, unmount, flushSync, tick, WorkbenchLayoutHarness };'
		].join('\n'));

		const buildPromise = build({
			root: projectRoot,
			configFile: false,
			plugins: [svelte({ emitCss: false })],
			build: {
				write: true,
				outDir: directory,
				emptyOutDir: false,
				lib: {
					entry: entryFile,
					formats: ['es'],
					fileName: () => 'workbench-layout-lifetime.mjs'
				},
				rollupOptions: { external: [] }
			},
			resolve: { dedupe: ['svelte'], conditions: ['browser', 'default'] },
			logLevel: 'silent'
		});
		pendingBuild = buildPromise;
		try {
			await buildPromise;
		} finally {
			if (pendingBuild === buildPromise) pendingBuild = null;
		}
		if (!fs.existsSync(bundleFile)) throw new Error('Vite did not emit the WorkbenchLayout client bundle');
		return await (import(pathToFileURL(bundleFile).href) as Promise<ClientRuntime>);
	} catch (error) {
		cleanupBundleDirectory();
		restorePlatformGlobals();
		throw error;
	}
}

function getCompiledHarness(): Promise<ClientRuntime> {
	if (!compiledHarnessPromise) compiledHarnessPromise = compileClientHarness();
	return compiledHarnessPromise;
}

async function drainUnmount(runtime: ClientRuntime, component: any): Promise<void> {
	const unmounting = runtime.unmount(component);
	try {
		runtime.flushSync();
	} finally {
		try {
			await unmounting;
		} finally {
			runtime.flushSync();
		}
	}
}

async function createHarness(): Promise<MountedHarness> {
	const runtime = await getCompiledHarness();
	const container = dom.window.document.createElement('div');
	container.className = 'workbench-test-harness';
	dom.window.document.body.appendChild(container);
	let component: any = null;
	let controller: HarnessController | null = null;
	let cleaned = false;
	try {
		component = runtime.mount(runtime.WorkbenchLayoutHarness, {
			target: container,
			props: { onController: (value: HarnessController) => { controller = value; } }
		});
		runtime.flushSync();
		await runtime.tick();
		runtime.flushSync();
		if (!controller) throw new Error('WorkbenchLayout harness controller was not initialized');

		const requireController = () => {
			if (!controller) throw new Error('WorkbenchLayout harness controller is unavailable');
			return controller;
		};
		const settle = async () => {
			for (let index = 0; index < 4; index++) {
				await runtime.tick();
				runtime.flushSync();
			}
		};
		const cleanup = async () => {
			if (cleaned) return;
			cleaned = true;
			const mounted = component;
			component = null;
			try {
				if (mounted) await drainUnmount(runtime, mounted);
			} finally {
				container.remove();
			}
		};
		return {
			container, runtime,
			setMode(value) { requireController().setMode(value); runtime.flushSync(); },
			setPane(value) { requireController().setPane(value); runtime.flushSync(); },
			setRatio(value) { requireController().setRatio(value); runtime.flushSync(); },
			getPane() { return requireController().getPane(); },
			getRatio() { return requireController().getRatio(); },
			getDraft() { return requireController().getDraft(); },
			settle, cleanup
		};
	} catch (error) {
		try {
			if (component) await drainUnmount(runtime, component);
		} catch {
			// Preserve the mounting error.
		} finally {
			container.remove();
		}
		throw error;
	}
}

function required<T extends Element>(container: ParentNode, selector: string): T {
	const element = container.querySelector<T>(selector);
	assert.ok(element, `Expected ${selector} to exist`);
	return element;
}

function tab(container: ParentNode, pane: Pane): HTMLButtonElement {
	return required<HTMLButtonElement>(container, `#workbench-tab-${pane}`);
}

function dispatchKey(target: Element, init: KeyboardEventInit): KeyboardEvent {
	const event = new dom.window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
	target.dispatchEvent(event);
	return event;
}

after(async () => {
	try {
		if (pendingBuild) await pendingBuild.catch(() => {});
		if (compiledHarnessPromise) await compiledHarnessPromise.catch(() => {});
	} finally {
		try { restorePlatformGlobals(); }
		finally {
			try { dom.window.close(); }
			finally {
				try { cleanupBundleDirectory(); }
				finally { compiledHarnessPromise = null; }
			}
		}
	}
});

// JSDOM checks DOM and activeElement changes; it cannot establish native CSS-driven focus behavior.
test('wide-to-narrow relocates focused separator/sidebar controls and keeps hidden pane drafts mounted', { timeout: 180_000 }, async () => {
	let harness: MountedHarness | undefined;
	try {
		harness = await createHarness();
		const draft = required<HTMLTextAreaElement>(harness.container, '#draft');
		draft.value = 'unsaved editor draft';
		draft.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
		harness.runtime.flushSync();
		assert.equal(harness.getDraft(), 'unsaved editor draft');

		const separator = required<HTMLElement>(harness.container, '.workbench-separator');
		separator.focus();
		assert.strictEqual(dom.window.document.activeElement, separator);
		harness.setMode('narrow');
		assert.equal(separator.isConnected, false, 'the wide separator node is removed');
		assert.equal(harness.container.querySelector('.workbench-sidebar-slot'), null);
		await harness.settle();
		const documentTab = tab(harness.container, 'document');
		assert.strictEqual(dom.window.document.activeElement, documentTab);

		harness.setPane('pdf');
		assert.equal(required<HTMLElement>(harness.container, '#editor-content').hidden, true);
		assert.strictEqual(required<HTMLTextAreaElement>(harness.container, '#draft'), draft);
		assert.equal(draft.value, 'unsaved editor draft');
		harness.setPane('document');
		assert.equal(required<HTMLElement>(harness.container, '#editor-content').hidden, false);
		assert.strictEqual(required<HTMLTextAreaElement>(harness.container, '#draft'), draft);
		assert.equal(draft.value, 'unsaved editor draft');

		harness.setMode('wide');
		const sidebarControl = required<HTMLButtonElement>(harness.container, '#sidebar-control');
		sidebarControl.focus();
		assert.strictEqual(dom.window.document.activeElement, sidebarControl);
		harness.setMode('narrow');
		assert.equal(sidebarControl.isConnected, false, 'the wide sidebar node is removed');
		await harness.settle();
		assert.strictEqual(dom.window.document.activeElement, tab(harness.container, 'document'));
		assert.strictEqual(required<HTMLTextAreaElement>(harness.container, '#draft'), draft);
		assert.equal(draft.value, 'unsaved editor draft');
	} finally {
		if (harness) await harness.cleanup();
	}
});

test('focus recovery leaves still-visible editor and newly focused external/editor elements alone', { timeout: 180_000 }, async () => {
	let harness: MountedHarness | undefined;
	const external = dom.window.document.createElement('button');
	external.textContent = 'External control';
	dom.window.document.body.appendChild(external);
	try {
		harness = await createHarness();
		const draft = required<HTMLTextAreaElement>(harness.container, '#draft');
		draft.focus();
		harness.setMode('narrow');
		await harness.settle();
		assert.strictEqual(dom.window.document.activeElement, draft, 'a still-visible editor keeps focus');

		harness.setMode('wide');
		const separator = required<HTMLElement>(harness.container, '.workbench-separator');
		separator.focus();
		harness.setMode('narrow');
		draft.focus();
		await harness.settle();
		assert.strictEqual(dom.window.document.activeElement, draft, 'a visible editor focus acquired during relocation is preserved');

		harness.setMode('wide');
		required<HTMLElement>(harness.container, '.workbench-separator').focus();
		harness.setMode('narrow');
		external.focus();
		await harness.settle();
		assert.strictEqual(dom.window.document.activeElement, external, 'a newly focused external element is not displaced');
	} finally {
		if (harness) await harness.cleanup();
		external.remove();
	}
});

test('rapid mode and pane changes recover to the final narrow tab only', { timeout: 180_000 }, async () => {
	let harness: MountedHarness | undefined;
	try {
		harness = await createHarness();
		required<HTMLElement>(harness.container, '.workbench-separator').focus();
		harness.setMode('narrow');
		harness.setPane('pdf');
		harness.setPane('document');
		harness.setMode('wide');
		harness.setMode('narrow');
		harness.setPane('document');
		harness.setPane('pdf');
		await harness.settle();

		assert.equal(harness.getPane(), 'pdf');
		const selectedPdfTab = tab(harness.container, 'pdf');
		assert.equal(selectedPdfTab.getAttribute('aria-selected'), 'true');
		assert.strictEqual(dom.window.document.activeElement, selectedPdfTab);
		assert.equal(tab(harness.container, 'document').getAttribute('aria-selected'), 'false');
	} finally {
		if (harness) await harness.cleanup();
	}
});

test('unmount cancels a pending relocation and preserves newly focused external control', { timeout: 180_000 }, async () => {
	const harness = await createHarness();
	const external = dom.window.document.createElement('button');
	external.textContent = 'Keep focus';
	dom.window.document.body.appendChild(external);
	try {
		const separator = required<HTMLElement>(harness.container, '.workbench-separator');
		separator.focus();
		harness.setMode('narrow');
		assert.equal(separator.isConnected, false);

		const unmounting = harness.cleanup();
		external.focus();
		await unmounting;
		await harness.runtime.tick();
		harness.runtime.flushSync();
		assert.equal(external.isConnected, true);
		assert.strictEqual(dom.window.document.activeElement, external);
	} finally {
		await harness.cleanup();
		external.remove();
	}
});

test('plain layout keys work while modifier and IME keys remain available to the platform', { timeout: 180_000 }, async () => {
	let harness: MountedHarness | undefined;
	try {
		harness = await createHarness();
		const separator = required<HTMLElement>(harness.container, '.workbench-separator');
		harness.setRatio(0.5);

		const right = dispatchKey(separator, { key: 'ArrowRight' });
		harness.runtime.flushSync();
		assert.equal(right.defaultPrevented, true);
		assert.ok(Math.abs(harness.getRatio() - 0.53) < 1e-9);

		for (const ignored of [
			{ key: 'ArrowRight', ctrlKey: true },
			{ key: 'ArrowRight', altKey: true },
			{ key: 'ArrowRight', metaKey: true },
			{ key: 'ArrowRight', shiftKey: true },
			{ key: 'ArrowRight', isComposing: true, keyCode: 229 },
			{ key: 'ArrowRight', keyCode: 229 }
		]) {
			const before = harness.getRatio();
			const event = dispatchKey(separator, ignored);
			harness.runtime.flushSync();
			assert.equal(event.defaultPrevented, false);
			assert.equal(harness.getRatio(), before);
		}

		const left = dispatchKey(separator, { key: 'ArrowLeft' });
		harness.runtime.flushSync();
		assert.equal(left.defaultPrevented, true);
		assert.ok(Math.abs(harness.getRatio() - 0.5) < 1e-9);
		const home = dispatchKey(separator, { key: 'Home' });
		harness.runtime.flushSync();
		assert.equal(home.defaultPrevented, true);
		assert.equal(harness.getRatio(), 0.2);
		const end = dispatchKey(separator, { key: 'End' });
		harness.runtime.flushSync();
		assert.equal(end.defaultPrevented, true);
		assert.equal(harness.getRatio(), 0.8);

		harness.setMode('narrow');
		const documentTab = tab(harness.container, 'document');
		documentTab.focus();
		const shiftedTabKey = dispatchKey(documentTab, { key: 'ArrowRight', shiftKey: true });
		harness.runtime.flushSync();
		assert.equal(shiftedTabKey.defaultPrevented, false);
		assert.equal(harness.getPane(), 'document');
		const composingTabKey = dispatchKey(documentTab, { key: 'ArrowRight', isComposing: true, keyCode: 229 });
		harness.runtime.flushSync();
		assert.equal(composingTabKey.defaultPrevented, false);
		assert.equal(harness.getPane(), 'document');

		const nextTab = dispatchKey(documentTab, { key: 'ArrowRight' });
		harness.runtime.flushSync();
		assert.equal(nextTab.defaultPrevented, true);
		assert.equal(harness.getPane(), 'pdf');
		assert.strictEqual(dom.window.document.activeElement, tab(harness.container, 'pdf'));
	} finally {
		if (harness) await harness.cleanup();
	}
});
