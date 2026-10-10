import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { SourceDocument } from '@modutex/document-core';
import type { DiagnosticNavigationRequest } from '../../src/features/source-editor/diagnostics.ts';

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
	JSDOM: new (html: string, options: { url: string; pretendToBeVisual: boolean }) => {
		window: Window & typeof globalThis & { close(): void };
	};
};
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
	url: 'https://modutex.test',
	pretendToBeVisual: true
});

interface HarnessProps {
	readonly document: SourceDocument;
	readonly active?: boolean;
	readonly saving?: boolean;
	readonly diagnosticNavigation?: DiagnosticNavigationRequest | null;
}

interface HarnessController {
	setProps(next: Partial<HarnessProps>): void;
}

interface ClientRuntime {
	readonly SourceViewHarness: any;
	readonly EditorView: { findFromDOM(node: Node): any };
	readonly mount: (component: any, options: { target: Element; props?: any }) => any;
	readonly unmount: (component: any) => Promise<void>;
	readonly flushSync: () => void;
	readonly tick: () => Promise<void>;
}

interface MountedHarness {
	readonly container: HTMLElement;
	readonly runtime: ClientRuntime;
	readonly setProps: (next: Partial<HarnessProps>) => void;
	readonly getView: () => any;
	readonly settle: () => Promise<void>;
	readonly cleanup: () => Promise<void>;
}

const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();
const geometryRestorers: Array<() => void> = [];
let geometryInstalled = false;
let platformInstalled = false;
let bundleDirectory: string | null = null;
let pendingBuild: Promise<unknown> | null = null;
let compiledHarnessPromise: Promise<ClientRuntime> | null = null;

const sourceViewFile = fileURLToPath(new URL('../../src/features/source-editor/SourceView.svelte', import.meta.url));
const diagnosticsFile = fileURLToPath(new URL('../../src/features/source-editor/diagnostics.ts', import.meta.url));
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));

function patchGeometry(target: any, key: string, descriptor: PropertyDescriptor) {
	const previous = Object.getOwnPropertyDescriptor(target, key);
	geometryRestorers.push(() => {
		if (previous) Object.defineProperty(target, key, previous);
		else Reflect.deleteProperty(target, key);
	});
	Object.defineProperty(target, key, { configurable: true, ...descriptor });
}

/** Harness-only geometry: JSDOM has no layout, so CodeMirror needs stable nonzero measurements. */
function installGeometryPolyfills() {
	if (geometryInstalled) return;
	geometryInstalled = true;
	const rectangle = () => ({
		x: 0, y: 0, left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600,
		toJSON() { return {}; }
	});
	const elementPrototype = dom.window.Element.prototype;
	const rangePrototype = dom.window.Range.prototype;
	patchGeometry(elementPrototype, 'getBoundingClientRect', { value: rectangle });
	patchGeometry(elementPrototype, 'getClientRects', { value: () => [rectangle()] });
	patchGeometry(elementPrototype, 'scrollIntoView', { value() {} });
	patchGeometry(rangePrototype, 'getBoundingClientRect', { value: rectangle });
	patchGeometry(rangePrototype, 'getClientRects', { value: () => [rectangle()] });
	for (const [key, value] of Object.entries({
		clientWidth: 800, clientHeight: 600, offsetWidth: 800, offsetHeight: 600,
		scrollWidth: 800, scrollHeight: 600
	})) {
		patchGeometry(dom.window.HTMLElement.prototype, key, { get: () => value });
	}
}

function installPlatformGlobals() {
	if (platformInstalled) return;
	platformInstalled = true;
	installGeometryPolyfills();
	const win = dom.window as unknown as Record<string, unknown>;
	const globals = [
		'window', 'document', 'navigator', 'location', 'MutationObserver', 'Node', 'Element', 'HTMLElement',
		'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement',
		'HTMLMediaElement', 'HTMLAudioElement', 'HTMLVideoElement', 'Text', 'Comment', 'Document',
		'DocumentFragment', 'EventTarget', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
		'FocusEvent', 'InputEvent', 'Range', 'Selection', 'DOMParser', 'customElements',
		'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame'
	];
	for (const key of globals) {
		if (!previousDescriptors.has(key)) previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		const value = key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : win[key];
		if (value !== undefined) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	if (!previousDescriptors.has('PointerEvent')) previousDescriptors.set('PointerEvent', Object.getOwnPropertyDescriptor(globalThis, 'PointerEvent'));
	Object.defineProperty(globalThis, 'PointerEvent', {
		configurable: true,
		writable: true,
		value: dom.window.PointerEvent ?? class PointerEvent extends dom.window.MouseEvent {
			readonly pointerId: number;
			constructor(type: string, init: MouseEventInit & { pointerId?: number } = {}) {
				super(type, init);
				this.pointerId = init.pointerId ?? 0;
			}
		}
	});
	if (!dom.window.Element.prototype.setPointerCapture) {
		dom.window.Element.prototype.setPointerCapture = () => {};
		dom.window.Element.prototype.releasePointerCapture = () => {};
		dom.window.Element.prototype.hasPointerCapture = () => false;
	}
}

function restorePlatformGlobals() {
	for (const [key, descriptor] of previousDescriptors) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousDescriptors.clear();
	for (const restore of geometryRestorers.splice(0).reverse()) restore();
	geometryInstalled = false;
	platformInstalled = false;
}

function cleanupBundleDirectory() {
	const directory = bundleDirectory;
	bundleDirectory = null;
	if (directory) fs.rmSync(directory, { recursive: true, force: true });
}

const harnessSource = (sourcePath: string, diagnosticsPath: string) => `<script lang="ts">
	import SourceView from ${JSON.stringify(sourcePath)};
	import type { SourceDocument } from '@modutex/document-core';
	import type { DiagnosticNavigationRequest } from ${JSON.stringify(diagnosticsPath)};
	type Props = {
		document: SourceDocument;
		onController: (controller: { setProps: (next: {
			document?: SourceDocument;
			active?: boolean;
			saving?: boolean;
			diagnosticNavigation?: DiagnosticNavigationRequest | null;
		}) => void }) => void;
	};
	let { document: initialDocument, onController }: Props = $props();
	let currentDocument = $state.raw(initialDocument);
	let active = $state(true);
	let saving = $state(false);
	let diagnosticNavigation = $state<DiagnosticNavigationRequest | null>(null);
	let diagnosticSequence = 0;
	let callbackCount = $state(0);
	function record() { callbackCount++; }
	function navigateToDiagnostic() {
		diagnosticNavigation = {
			location: { line: 2, utf16Column: 1 },
			documentId: currentDocument.documentId,
			documentVersion: currentDocument.version,
			sequence: ++diagnosticSequence
		};
	}
	onController({ setProps(next) {
		if (next.document !== undefined) currentDocument = next.document;
		if (next.active !== undefined) active = next.active;
		if (next.saving !== undefined) saving = next.saving;
		if ('diagnosticNavigation' in next) diagnosticNavigation = next.diagnosticNavigation ?? null;
	} });
</script>

<button type="button" data-diagnostic-trigger onclick={navigateToDiagnostic}>Navigate to diagnostic</button>

{#key currentDocument.documentId}
	<SourceView document={currentDocument} label="diagnostic.tex" {active} {saving} savedVersion={null}
		diagnosticNavigation={diagnosticNavigation} locale="en"
		onChange={record} onRejected={record} onVisualRejected={record}
		onProjection={record} onParserFailure={record} />
{/key}
`;

async function compileClientHarness(): Promise<ClientRuntime> {
	installPlatformGlobals();
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'diagnostic-navigation-client-'));
	bundleDirectory = directory;
	const harnessFile = path.join(directory, 'SourceViewHarness.svelte');
	const entryFile = path.join(directory, 'entry.js');
	const bundleFile = path.join(directory, 'diagnostic-navigation-client.mjs');
	try {
		fs.writeFileSync(harnessFile, harnessSource(sourceViewFile.replace(/\\/g, '/'), diagnosticsFile.replace(/\\/g, '/')));
		fs.writeFileSync(entryFile, [
			`import { mount, unmount, flushSync, tick } from 'svelte';`,
			`import { EditorView } from '@codemirror/view';`,
			`import SourceViewHarness from ${JSON.stringify(harnessFile.replace(/\\/g, '/'))};`,
			'export { mount, unmount, flushSync, tick, EditorView, SourceViewHarness };'
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
					fileName: () => 'diagnostic-navigation-client.mjs'
				},
				rollupOptions: { external: [] }
			},
			resolve: { dedupe: ['svelte', '@codemirror/state', '@codemirror/view'], conditions: ['browser', 'default'] },
			logLevel: 'silent'
		});
		pendingBuild = buildPromise;
		try {
			await buildPromise;
		} finally {
			if (pendingBuild === buildPromise) pendingBuild = null;
		}
		if (!fs.existsSync(bundleFile)) throw new Error('Vite did not emit the diagnostic client bundle');
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

async function createHarness(source: SourceDocument): Promise<MountedHarness> {
	const runtime = await getCompiledHarness();
	const container = dom.window.document.createElement('div');
	container.className = 'diagnostic-test-harness';
	dom.window.document.body.appendChild(container);
	let component: any = null;
	let controller: HarnessController | null = null;
	let cleaned = false;
	try {
		component = runtime.mount(runtime.SourceViewHarness, {
			target: container,
			props: { document: source, onController: (value: HarnessController) => { controller = value; } }
		});
		runtime.flushSync();
		await runtime.tick();
		runtime.flushSync();
		if (!controller) throw new Error('SourceView harness controller was not initialized');
		if (!container.querySelector('.cm-editor')) throw new Error('SourceView did not mount CodeMirror');

		const setProps = (next: Partial<HarnessProps>) => {
			if (!controller) throw new Error('SourceView harness controller is unavailable');
			controller.setProps(next);
			runtime.flushSync();
		};
		const getView = () => {
			const node = container.querySelector<HTMLElement>('.cm-editor');
			assert.ok(node, 'CodeMirror editor must be mounted');
			const view = runtime.EditorView.findFromDOM(node);
			assert.ok(view, 'CodeMirror public DOM lookup must find the mounted view');
			return view;
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
		return { container, runtime, setProps, getView, settle, cleanup };
	} catch (error) {
		try {
			if (component) await drainUnmount(runtime, component);
		} catch {
			// Preserve the mounting error; the nested finally still removes the mount target.
		} finally {
			container.remove();
		}
		throw error;
	}
}

function diagnostic(source: SourceDocument, sequence: number, line: number, utf16Column: number | null): DiagnosticNavigationRequest {
	return {
		location: { line, utf16Column },
		documentId: source.documentId,
		documentVersion: source.version,
		sequence
	};
}

function modeButton(document: Document, label: string): HTMLButtonElement {
	const button = Array.from(document.querySelectorAll<HTMLButtonElement>('.modes button'))
		.find((candidate) => candidate.textContent?.trim() === label);
	assert.ok(button);
	// JSDOM click() does not perform the browser's pointer-focus default action.
	button.focus();
	return button;
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

test('mounted SourceView maps normalized UTF-16 positions through BOM and CRLF and reveals/focuses from visual mode', { timeout: 180_000 }, async () => {
	const sourceText = '\uFEFFfirst\r\nconst 中😀x = 1;\r\nlast';
	const source = SourceDocument.open(new TextEncoder().encode(sourceText));
	let harness: MountedHarness | undefined;
	try {
		harness = await createHarness(source);
		await harness.settle();
		let view = harness.getView();
		modeButton(dom.window.document, 'Visual').click();
		await harness.settle();
		assert.equal(dom.window.document.querySelector<HTMLElement>('.source')?.hidden, true);
		assert.equal(view.hasFocus, false);

		harness.setProps({ diagnosticNavigation: diagnostic(source, 1, 2, 10) });
		await harness.settle();
		view = harness.getView();
		const line = view.state.doc.line(2);
		const from = line.from + 'const 中😀'.length;
		assert.equal(view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to), 'x');
		assert.equal(view.state.selection.main.from, from);
		assert.equal(view.state.selection.main.to, from + 1);
		assert.equal(view.hasFocus, true);
		assert.equal(dom.window.document.querySelector<HTMLElement>('.source')?.hidden, false);
		assert.equal(dom.window.document.querySelector<HTMLElement>('.visual')?.hidden, true);
		assert.deepEqual(source.toBytes(), new TextEncoder().encode(sourceText));
	} finally {
		if (harness) await harness.cleanup();
	}
});

test('mounted SourceView focuses the editor when navigation originates from its diagnostic button', { timeout: 180_000 }, async () => {
	const source = SourceDocument.open(new TextEncoder().encode('first\nsecond\nlast'));
	let harness: MountedHarness | undefined;
	try {
		harness = await createHarness(source);
		await harness.settle();
		const trigger = harness.container.querySelector<HTMLButtonElement>('[data-diagnostic-trigger]');
		assert.ok(trigger);
		trigger.focus();
		trigger.click();
		await harness.settle();

		const view = harness.getView();
		const line = view.state.doc.line(2);
		assert.equal(view.state.selection.main.from, line.from);
		assert.equal(view.state.selection.main.to, line.from + 1);
		assert.equal(view.hasFocus, true);
		assert.ok(view.dom.contains(view.dom.ownerDocument.activeElement));
	} finally {
		if (harness) await harness.cleanup();
	}
});

test('mounted SourceView preserves newer external input focus during queued diagnostic navigation', { timeout: 180_000 }, async () => {
	const source = SourceDocument.open(new TextEncoder().encode('first\nsecond\nlast'));
	let harness: MountedHarness | undefined;
	try {
		harness = await createHarness(source);
		await harness.settle();
		const view = harness.getView();
		const input = dom.window.document.createElement('input');
		input.type = 'text';
		harness.container.append(input);

		harness.setProps({ diagnosticNavigation: diagnostic(source, 1, 2, 3) });
		const line = view.state.doc.line(2);
		const expectedSelection = { from: line.from + 2, to: line.from + 3 };
		assert.deepEqual(
			{ from: view.state.selection.main.from, to: view.state.selection.main.to },
			expectedSelection
		);
		assert.equal(view.state.doc.sliceString(expectedSelection.from, expectedSelection.to), 'c');

		input.focus();
		await harness.settle();
		assert.deepEqual(
			{ from: view.state.selection.main.from, to: view.state.selection.main.to },
			expectedSelection
		);
		assert.strictEqual(dom.window.document.activeElement, input);
		assert.equal(view.hasFocus, false);

		input.blur();
		harness.setProps({ active: false });
		harness.setProps({ active: true });
		await harness.settle();
		assert.deepEqual(
			{ from: view.state.selection.main.from, to: view.state.selection.main.to },
			expectedSelection
		);
		assert.equal(view.hasFocus, false, 'a cancelled request must not reclaim focus later');
	} finally {
		if (harness) await harness.cleanup();
	}
});

test('mounted SourceView does not steal focus after a newer editor selection supersedes diagnostic navigation before tick', { timeout: 180_000 }, async () => {
	const source = SourceDocument.open(new TextEncoder().encode('first\nsecond\nlast'));
	let harness: MountedHarness | undefined;
	try {
		harness = await createHarness(source);
		await harness.settle();
		const view = harness.getView();
		view.contentDOM.blur();
		harness.setProps({ diagnosticNavigation: diagnostic(source, 1, 2, 1) });
		const diagnosticLine = view.state.doc.line(2);
		assert.equal(view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to), 's');
		assert.equal(view.state.selection.main.from, diagnosticLine.from);
		const replacement = view.state.doc.line(1).from + 2;
		view.dispatch({ selection: { anchor: replacement } });
		const button = modeButton(dom.window.document, 'Source');
		await harness.settle();
		assert.equal(view.state.selection.main.from, replacement);
		assert.equal(view.state.selection.main.to, replacement);
		assert.equal(view.hasFocus, false);
		assert.strictEqual(dom.window.document.activeElement, button);
		assert.deepEqual(source.toBytes(), new TextEncoder().encode('first\nsecond\nlast'));
	} finally {
		if (harness) await harness.cleanup();
	}
});

test('mounted SourceView selects a line without a normalized column and ignores invalid coordinates without changing visual mode', { timeout: 180_000 }, async () => {
	const source = SourceDocument.open(new TextEncoder().encode('\uFEFFfirst\r\n資料😀\r\nlast'));
	let harness: MountedHarness | undefined;
	try {
		harness = await createHarness(source);
		await harness.settle();
		harness.setProps({ diagnosticNavigation: diagnostic(source, 1, 2, null) });
		await harness.settle();
		const view = harness.getView();
		const line = view.state.doc.line(2);
		assert.equal(view.state.selection.main.from, line.from);
		assert.equal(view.state.selection.main.to, line.to);
		assert.equal(view.state.doc.sliceString(line.from, line.to), '資料😀');
		assert.equal(view.hasFocus, true);

		modeButton(dom.window.document, 'Visual').click();
		await harness.settle();
		const previousSelection = { from: view.state.selection.main.from, to: view.state.selection.main.to };
		assert.equal(view.hasFocus, false);
		const invalid = [
			{ line: 0, column: 1 },
			{ line: 99, column: null },
			{ line: 2, column: 0 },
			{ line: 2, column: 6 },
			{ line: 2, column: 4 }
		] as const;
		let sequence = 2;
		for (const value of invalid) {
			harness.setProps({ diagnosticNavigation: diagnostic(source, sequence++, value.line, value.column) });
			await harness.settle();
			assert.deepEqual(
				{ from: view.state.selection.main.from, to: view.state.selection.main.to },
				previousSelection
			);
			assert.equal(view.hasFocus, false);
			assert.equal(dom.window.document.querySelector<HTMLElement>('.source')?.hidden, true);
		}
	} finally {
		if (harness) await harness.cleanup();
	}
});

test('mounted SourceView defers inactive/read-only requests, rejects replaced source identity, and cancels scheduled focus on unmount', { timeout: 180_000 }, async () => {
	const first = SourceDocument.open(new TextEncoder().encode('\uFEFFalpha\r\nbeta'));
	const second = SourceDocument.open(new TextEncoder().encode('\uFEFFother\r\nnew'));
	assert.notEqual(second.documentId, first.documentId);
	let harness: MountedHarness | undefined;
	try {
		harness = await createHarness(first);
		await harness.settle();
		let view = harness.getView();
		harness.setProps({ active: false, diagnosticNavigation: diagnostic(first, 1, 2, 1) });
		await harness.settle();
		assert.equal(view.state.readOnly, true);
		assert.equal(view.state.selection.main.from, 0);
		assert.equal(view.hasFocus, false);

		harness.setProps({ active: true });
		await harness.settle();
		view = harness.getView();
		assert.equal(view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to), 'b');
		assert.equal(view.hasFocus, true);

		view.contentDOM.blur();
		harness.setProps({ saving: true, diagnosticNavigation: diagnostic(first, 2, 1, 1) });
		await harness.settle();
		assert.equal(view.state.readOnly, true);
		assert.equal(view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to), 'b');
		assert.equal(view.hasFocus, false);
		harness.setProps({ saving: false });
		await harness.settle();
		assert.equal(view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to), 'a');
		assert.equal(view.hasFocus, true);

		modeButton(dom.window.document, 'Visual').click();
		await harness.settle();
		harness.setProps({
			diagnosticNavigation: {
				location: { line: 2, utf16Column: 1 },
				documentId: first.documentId,
				documentVersion: first.version + 1,
				sequence: 3
			}
		});
		await harness.settle();
		assert.equal(view.hasFocus, false);
		assert.equal(dom.window.document.querySelector<HTMLElement>('.source')?.hidden, true);

		harness.setProps({ document: second });
		await harness.settle();
		const oldView = view;
		view = harness.getView();
		assert.notStrictEqual(view, oldView, 'workspace source identity replacement remounts the keyed editor');
		assert.equal(view.state.doc.toString(), 'other\nnew');
		assert.equal(view.state.selection.main.from, 0);
		assert.equal(view.hasFocus, false);

		harness.setProps({ diagnosticNavigation: diagnostic(second, 4, 2, 1) });
		await harness.settle();
		view = harness.getView();
		assert.equal(view.state.doc.sliceString(view.state.selection.main.from, view.state.selection.main.to), 'n');
		assert.equal(view.hasFocus, true);

		view.contentDOM.blur();
		harness.setProps({ diagnosticNavigation: diagnostic(second, 5, 1, 1) });
		harness.runtime.flushSync();
		assert.equal(view.hasFocus, false);
		await harness.cleanup();
		await harness.settle();
		assert.equal(dom.window.document.querySelector('.cm-editor'), null);
		assert.equal(view.hasFocus, false, 'a queued focus must not run after the mounted editor is disposed');
	} finally {
		if (harness) await harness.cleanup();
	}
});
