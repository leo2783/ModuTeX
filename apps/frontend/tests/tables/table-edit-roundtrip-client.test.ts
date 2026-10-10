import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
	JSDOM: new (html: string, options?: { url?: string; pretendToBeVisual?: boolean }) => {
		window: Window & typeof globalThis & { close(): void };
	};
};
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { SourceDocument, parseSource } from '@modutex/document-core';
import {
	createTable,
	columnPercentages,
	tableSource,
	parseTable,
	tableAt,
	type TableDraft
} from '../../src/features/tables/source.ts';
import {
	createSourceState,
	rangeInsertionTarget,
	insertionTarget,
	insertionTransaction,
	sourceState,
	historyTransaction
} from '../../src/features/source-editor/state.ts';

const dom = new JSDOM('<!doctype html><html><body><div id="mount-root"></div></body></html>', {
	url: 'https://modutex.test',
	pretendToBeVisual: true
});

if (!dom.window.Element.prototype.setPointerCapture) {
	dom.window.Element.prototype.setPointerCapture = () => {};
	dom.window.Element.prototype.releasePointerCapture = () => {};
	dom.window.Element.prototype.hasPointerCapture = () => false;
}
dom.window.confirm = () => true;

const previousDescriptors = new Map<string, PropertyDescriptor | undefined>();

function installPlatformGlobals() {
	const win = dom.window as unknown as Record<string, unknown>;
	const globals = [
		'window',
		'document',
		'navigator',
		'location',
		'MutationObserver',
		'Node',
		'Element',
		'HTMLElement',
		'HTMLButtonElement',
		'HTMLInputElement',
		'HTMLSelectElement',
		'HTMLTableElement',
		'Text',
		'Comment',
		'Document',
		'DocumentFragment',
		'EventTarget',
		'Event',
		'CustomEvent',
		'MouseEvent',
		'KeyboardEvent',
		'FocusEvent',
		'HTMLDivElement',
		'HTMLFieldSetElement',
		'HTMLHeadingElement',
		'HTMLLabelElement',
		'HTMLOptionElement',
		'HTMLParagraphElement',
		'HTMLMediaElement',
		'HTMLAudioElement',
		'HTMLVideoElement',
		'getComputedStyle',
		'requestAnimationFrame',
		'cancelAnimationFrame',
		'HTMLTableSectionElement',
		'HTMLTableRowElement',
		'HTMLTableCellElement',
		'HTMLTableColElement'
	];

	for (const key of globals) {
		if (!previousDescriptors.has(key)) {
			previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		}
		const value =
			key === 'getComputedStyle'
				? dom.window.getComputedStyle.bind(dom.window)
				: win[key];
		Object.defineProperty(globalThis, key, {
			configurable: true,
			writable: true,
			value
		});
	}

	if (!previousDescriptors.has('PointerEvent')) {
		previousDescriptors.set('PointerEvent', Object.getOwnPropertyDescriptor(globalThis, 'PointerEvent'));
	}
	Object.defineProperty(globalThis, 'PointerEvent', {
		configurable: true,
		writable: true,
		value:
			dom.window.PointerEvent ??
			class PointerEvent extends (dom.window.MouseEvent as unknown as typeof MouseEvent) {
				readonly pointerId: number;
				constructor(type: string, dict: { pointerId?: number } & MouseEventInit = {}) {
					super(type, dict);
					this.pointerId = dict.pointerId ?? 0;
				}
			}
	});
}

function restorePlatformGlobals() {
	for (const [key, descriptor] of previousDescriptors) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
	previousDescriptors.clear();
}

const tablePanelFile = fileURLToPath(new URL('../../src/features/tables/TablePanel.svelte', import.meta.url));
const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
let bundleDirectory: string | null = null;

function cleanupBundleDirectory() {
	const directory = bundleDirectory;
	bundleDirectory = null;
	if (directory) fs.rmSync(directory, { recursive: true, force: true });
}

after(async () => {
	try { restorePlatformGlobals(); }
	finally {
		try { dom.window.close(); }
		finally {
			try { cleanupBundleDirectory(); }
			finally { compiledHarnessPromise = null; }
		}
	}
});

let compiledHarnessPromise: Promise<{
	TablePanelHarness: any;
	mount: (component: any, options: { target: Element; props?: any }) => any;
	unmount: (component: any) => Promise<void>;
	flushSync: () => void;
	tick: () => Promise<void>;
}> | null = null;

function boundedWait<T>(label: string, promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

async function compileClientHarness() {
	installPlatformGlobals();

	try {
		const normalizedTablePanel = tablePanelFile.replace(/\\/g, '/');
		const sourceFile = fileURLToPath(new URL('../../src/features/tables/source.ts', import.meta.url)).replace(/\\/g, '/');
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'table-panel-client-'));
		bundleDirectory = directory;
		const harnessFile = path.join(directory, 'TablePanelHarness.svelte');
		const entryFile = path.join(directory, 'entry.js');
		const bundleFile = path.join(directory, 'table-panel-client.mjs');

		fs.writeFileSync(harnessFile, `<script lang="ts">
	import TablePanel from ${JSON.stringify(normalizedTablePanel)};
	import type { TableDraft } from ${JSON.stringify(sourceFile)};
	type Locale = 'zh-Hant' | 'en';
	type PanelProps = {
		active: boolean;
		locked?: boolean;
		initialDraft?: TableDraft | null;
		sessionKey?: string;
		editing?: boolean;
		locale?: Locale;
		onInsert: (source: string, booktabs?: boolean) => void;
		onClose: () => void;
	};
	type PanelController = { setProps: (next: Partial<PanelProps>) => void };
	let {
		active: initialActive = true,
		locked: initialLocked = false,
		initialDraft: initialTableDraft = null,
		sessionKey: initialSessionKey = 'insert',
		editing: initialEditing = false,
		locale: initialLocale = 'zh-Hant',
		onInsert,
		onClose,
		onController
	} = $props<PanelProps & { onController: (controller: PanelController) => void }>();
	let active = $state(initialActive);
	let locked = $state(initialLocked);
	let initialDraft = $state<TableDraft | null>(initialTableDraft);
	let sessionKey = $state(initialSessionKey);
	let editing = $state(initialEditing);
	let locale = $state<Locale>(initialLocale);
	let insertHandler = $state(onInsert);
	let closeHandler = $state(onClose);
	onController({
		setProps(next) {
			if (next.active !== undefined) active = next.active;
			if (next.locked !== undefined) locked = next.locked;
			if ('initialDraft' in next) initialDraft = next.initialDraft ?? null;
			if (next.sessionKey !== undefined) sessionKey = next.sessionKey;
			if (next.editing !== undefined) editing = next.editing;
			if (next.locale !== undefined) locale = next.locale;
			if (next.onInsert !== undefined) insertHandler = next.onInsert;
			if (next.onClose !== undefined) closeHandler = next.onClose;
		}
	});
</script>

<TablePanel
	{active}
	{locked}
	{initialDraft}
	{sessionKey}
	{editing}
	{locale}
	onInsert={insertHandler}
	onClose={closeHandler}
/>
`);
		fs.writeFileSync(entryFile, [
			`import { mount, unmount, flushSync, tick } from 'svelte';`,
			`import TablePanelHarness from ${JSON.stringify(harnessFile.replace(/\\/g, '/'))};`,
			'export { mount, unmount, flushSync, tick, TablePanelHarness };'
		].join('\n'));

		await boundedWait('Vite client bundle build', build({
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
					fileName: () => 'table-panel-client.mjs'
				},
				rollupOptions: {
					external: []
				}
			},
			resolve: {
				dedupe: ['svelte'],
				conditions: ['browser', 'default']
			},
			logLevel: 'silent'
		}), 120_000);
		if (!fs.existsSync(bundleFile)) throw new Error('Vite build did not emit the client bundle');

		return await boundedWait('Vite client bundle import', import(pathToFileURL(bundleFile).href), 30_000) as {
			TablePanelHarness: any;
			mount: (component: any, options: { target: Element; props?: any }) => any;
			unmount: (component: any) => Promise<void>;
			flushSync: () => void;
			tick: () => Promise<void>;
		};
	} catch (error) {
		try { cleanupBundleDirectory(); }
		finally { restorePlatformGlobals(); }
		throw error;
	}
}

function getCompiledHarness() {
	if (!compiledHarnessPromise) {
		compiledHarnessPromise = compileClientHarness();
	}
	return compiledHarnessPromise;
}

interface HarnessProps {
	active: boolean;
	locked?: boolean;
	initialDraft?: TableDraft | null;
	sessionKey?: string;
	editing?: boolean;
	locale?: 'zh-Hant' | 'en';
	onInsert: (source: string, booktabs?: boolean) => void;
	onClose: () => void;
}

interface HarnessController {
	setProps: (newProps: Partial<HarnessProps>) => void;
}

interface HarnessInstance {
	readonly dom: InstanceType<typeof JSDOM>;
	readonly container: HTMLElement;
	readonly component: any;
	readonly setProps: (newProps: Partial<HarnessProps>) => void;
	readonly flushSync: () => void;
	readonly settle: () => Promise<void>;
	readonly cleanup: () => Promise<void>;
}

async function createHarness(props: HarnessProps): Promise<HarnessInstance> {
	const { TablePanelHarness, mount, unmount, flushSync, tick } = await getCompiledHarness();

	const container = dom.window.document.createElement('div');
	container.className = 'test-harness-container';
	dom.window.document.body.appendChild(container);

	let component: any = null;
	let controller: HarnessController | null = null;
	try {
		component = mount(TablePanelHarness, {
			target: container,
			props: {
				...props,
				onController: (value: HarnessController) => { controller = value; }
			}
		});
		flushSync();
		await boundedWait('initial TablePanel render', tick());
		flushSync();
		if (!controller) throw new Error('TablePanel runes controller was not initialized');
		if (!container.querySelector('.table-panel')) throw new Error('TablePanel did not render');

		const setProps = (newProps: Partial<HarnessProps>) => {
			if (!controller) throw new Error('TablePanel runes controller is unavailable');
			controller.setProps(newProps);
			flushSync();
		};

		const settle = async () => {
			await boundedWait('TablePanel Svelte update', tick());
			flushSync();
		};

		let cleaned = false;
		const cleanup = async () => {
			if (cleaned) return;
			cleaned = true;
			const mounted = component;
			component = null;
			try {
				if (mounted) {
					try { await unmount(mounted); }
					finally { flushSync(); }
				}
			} finally {
				container.remove();
			}
		};

		return { dom, container, component, setProps, flushSync, settle, cleanup };
	} catch (error) {
		try {
			if (component) {
				const mounted = component;
				component = null;
				try { await unmount(mounted); }
				finally { flushSync(); }
			}
		} catch {
			// Preserve the mounting error while still removing the temporary DOM.
		}
		container.remove();
		throw error;
	}
}

function assertDraftEquivalent(actual: TableDraft, expected: TableDraft, message?: string) {
	const prefix = message ? `${message}: ` : '';
	// tableSource serializes column-width fractions to six decimals; compare geometry after that real round-trip.
	const serializedExpected = parseTable(tableSource(expected));
	assert.ok(serializedExpected, `${prefix}expected draft must round-trip through table source`);
	assert.equal(actual.rows, expected.rows, message ? `${message}: rows` : 'rows mismatch');
	assert.equal(actual.columns, expected.columns, message ? `${message}: columns` : 'columns mismatch');
	assert.deepEqual(actual.cells, expected.cells, message ? `${message}: cells` : 'cells mismatch');
	assert.equal(actual.header, expected.header, message ? `${message}: header` : 'header mismatch');
	assert.equal(actual.style, expected.style, message ? `${message}: style` : 'style mismatch');
	// An omitted rule is the same emitted default as an explicit hline rule.
	assert.equal(actual.rules ?? 'hline', expected.rules ?? 'hline', message ? `${message}: rules` : 'rules mismatch');
	assert.deepEqual(actual.caption, expected.caption, message ? `${message}: caption` : 'caption mismatch');
	assert.ok(Math.abs(actual.width - serializedExpected.width) < 1e-9,
		`${prefix}serialized width mismatch (actual: ${actual.width}, expected: ${serializedExpected.width})`);
	const actualRatios = columnPercentages(actual);
	const expectedRatios = columnPercentages(serializedExpected);
	assert.equal(actualRatios.length, expectedRatios.length);
	for (let i = 0; i < actualRatios.length; i++) {
		assert.ok(Math.abs(actualRatios[i]! - expectedRatios[i]!) < 1e-9,
			`${prefix}column ratio at index ${i} mismatch (actual: ${actualRatios[i]}, expected: ${expectedRatios[i]})`);
	}
}

test('re-editing existing three-line table preserves caption, rules, weights and round-trips via source patch', async () => {
	const initialDraft: TableDraft = {
		rows: 2,
		columns: 3,
		cells: ['Name', 'Category', 'Score', 'Alice', 'Engineering', '98'],
		weights: [2, 3, 5],
		width: 85,
		header: true,
		style: 'three-line',
		rules: 'booktabs',
		caption: { position: 'above', text: 'Evaluation Results' }
	};

	const initialTeX = tableSource(initialDraft);
	const prefix = '% Document prefix with comments and preserved BOM\r\n\\begin{document}\n';
	const suffix = '\r\n% Suffix text\n\\end{document}';
	const documentBytes = new TextEncoder().encode('\uFEFF' + prefix + initialTeX + suffix);
	const originalDoc = SourceDocument.open(documentBytes);

	let editorState = createSourceState(originalDoc);
	const initialProjection = parseSource(originalDoc);
	const located = tableAt(originalDoc, initialProjection, prefix.length + 10);
	assert.ok(located, 'tableAt should locate initial table');
	assertDraftEquivalent(located.draft, initialDraft, 'tableAt should produce equivalent draft to initialDraft');

	let appliedSource: string | null = null;
	let appliedBooktabs: boolean | undefined;
	let closed = false;

	const harness = await createHarness({
		active: true,
		locked: false,
		initialDraft: located.draft,
		sessionKey: `${located.span.documentId}:${located.span.version}:${located.span.from}:${located.span.to}`,
		editing: true,
		locale: 'zh-Hant',
		onInsert: (source, booktabs) => {
			appliedSource = source;
			appliedBooktabs = booktabs;
		},
		onClose: () => {
			closed = true;
		}
	});

	try {
		const cellInputs = Array.from(harness.container.querySelectorAll<HTMLInputElement>('tbody td input'));
		assert.equal(cellInputs.length, 6);
		assert.equal(cellInputs[0]!.value, 'Name');
		assert.equal(cellInputs[5]!.value, '98');

		const lastCellInput = cellInputs[5]!;
		lastCellInput.value = '100';
		lastCellInput.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
		harness.flushSync();

		const firstCellInput = cellInputs[0]!;
		firstCellInput.value = 'Candidate Name';
		firstCellInput.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
		harness.flushSync();

		const weightInputs = Array.from(harness.container.querySelectorAll<HTMLInputElement>('.widths input'));
		assert.equal(weightInputs.length, 3);
		// parseTable returns serialized width fractions, not the original [2, 3, 5] weight scale.
		weightInputs[0]!.value = String(located.draft.weights[1]!);
		weightInputs[0]!.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
		harness.flushSync();

		const applyButton = harness.container.querySelector<HTMLButtonElement>('button.primary');
		assert.ok(applyButton, 'Apply button must exist');
		assert.equal(applyButton.textContent?.trim(), '套用');
		applyButton.click();
		harness.flushSync();

		assert.ok(appliedSource !== null, 'onInsert must be called on Apply');
		assert.equal(appliedBooktabs, true, 'booktabs rule flag must be true');

		const parsedRoundtrip = parseTable(appliedSource);
		assert.ok(parsedRoundtrip, 'Applied source must parse cleanly via parseTable');
		assert.equal(parsedRoundtrip.caption.position, 'above');
		assert.equal(parsedRoundtrip.caption.text, 'Evaluation Results');
		assert.equal(parsedRoundtrip.rules, 'booktabs');
		assert.equal(parsedRoundtrip.style, 'three-line');
		assert.ok(Math.abs(parsedRoundtrip.width - 85) < 1e-4);
		const expectedWeightsAfterEdit = [3, 3, 5];
		const expectedWeightTotal = expectedWeightsAfterEdit.reduce((total, weight) => total + weight, 0);
		const expectedPercentages = expectedWeightsAfterEdit.map((weight) => weight / expectedWeightTotal * 100);
		const parsedPercentages = columnPercentages(parsedRoundtrip);
		for (let i = 0; i < 3; i++) {
			assert.ok(Math.abs(parsedPercentages[i]! - expectedPercentages[i]!) < 1e-3);
		}
		assert.equal(parsedRoundtrip.cells[0], 'Candidate Name');
		assert.equal(parsedRoundtrip.cells[5], '100');

		const target = rangeInsertionTarget(editorState, located.span);
		const editTx = insertionTransaction(editorState, target, appliedSource);
		editorState = editTx.state;

		const modifiedDoc = editorState.field(sourceState).projection.document;
		assert.ok(modifiedDoc.read().startsWith(prefix));
		assert.ok(modifiedDoc.read().endsWith(suffix));
		assert.equal(modifiedDoc.profile.bom, true);

		const modifiedParsed = parseSource(modifiedDoc);
		const modifiedLocated = tableAt(modifiedDoc, modifiedParsed, prefix.length + 10);
		assert.ok(modifiedLocated);
		assert.deepEqual(modifiedLocated.draft, parsedRoundtrip);

		const undoTx = historyTransaction(editorState, 'undo');
		assert.ok(undoTx, 'undo transaction should be available');
		editorState = undoTx.state;

		const revertedDoc = editorState.field(sourceState).projection.document;
		assert.deepEqual(revertedDoc.toBytes(), originalDoc.toBytes(), 'Undo must restore exact original bytes');
		assert.equal(editorState.field(sourceState).dirty, false);
		assert.equal(closed, false);
	} finally {
		await harness.cleanup();
	}
});

test('canceling table edit triggers onClose without writing to source or invoking onInsert', async () => {
	const initialDraft: TableDraft = {
		rows: 2,
		columns: 2,
		cells: ['X', 'Y', '10', '20'],
		weights: [1, 1],
		width: 80,
		header: true,
		style: 'three-line',
		rules: 'hline',
		caption: { position: 'none', text: '' }
	};

	const initialTeX = tableSource(initialDraft);
	const prefix = '\\documentclass{article}\n\\begin{document}\n';
	const suffix = '\n\\end{document}\n';
	const originalDoc = SourceDocument.open(new TextEncoder().encode(prefix + initialTeX + suffix));
	const initialVersion = originalDoc.version;
	const initialBytes = originalDoc.toBytes();

	let editorState = createSourceState(originalDoc);
	const projection = parseSource(originalDoc);
	const located = tableAt(originalDoc, projection, prefix.length + 5);
	assert.ok(located);

	let onInsertCalled = false;
	let onCloseCalled = false;

	const harness = await createHarness({
		active: true,
		locked: false,
		initialDraft: located.draft,
		sessionKey: 'edit-session-cancel',
		editing: true,
		locale: 'zh-Hant',
		onInsert: () => {
			onInsertCalled = true;
		},
		onClose: () => {
			onCloseCalled = true;
		}
	});

	try {
		const cellInputs = Array.from(harness.container.querySelectorAll<HTMLInputElement>('tbody td input'));
		assert.ok(cellInputs.length > 0);

		cellInputs[0]!.value = 'Mutated_Never_Applied';
		cellInputs[0]!.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
		harness.flushSync();

		const cancelButton = Array.from(harness.container.querySelectorAll<HTMLButtonElement>('.actions button')).find(
			(btn) => btn.textContent?.trim() === '取消'
		);
		assert.ok(cancelButton, 'Cancel button must exist in actions');
		cancelButton.click();
		harness.flushSync();

		assert.equal(onCloseCalled, true, 'onClose must be invoked on Cancel');
		assert.equal(onInsertCalled, false, 'onInsert must NOT be invoked on Cancel');

		const currentDoc = editorState.field(sourceState).projection.document;
		assert.equal(currentDoc.version, initialVersion);
		assert.deepEqual(currentDoc.toBytes(), initialBytes);
		assert.equal(editorState.field(sourceState).dirty, false);
	} finally {
		await harness.cleanup();
	}
});

test('round-trip preserves caption with escaping, horizontal lines, width and custom weights through real API', async () => {
	const initialDraft: TableDraft = {
		rows: 3,
		columns: 2,
		cells: ['Special & %', 'Val #1', 'Item_A', '10%', 'Item_B', '20%'],
		weights: [1.5, 3.5],
		width: 75,
		header: true,
		style: 'horizontal',
		caption: { position: 'below', text: 'Rates & Stats (#1)' }
	};

	const initialTeX = tableSource(initialDraft);
	const prefix = '% leading\n';
	const suffix = '\n% trailing\n';
	const originalDoc = SourceDocument.open(new TextEncoder().encode(prefix + initialTeX + suffix));

	let editorState = createSourceState(originalDoc);
	const projection = parseSource(originalDoc);
	const located = tableAt(originalDoc, projection, prefix.length + 5);
	assert.ok(located);

	let appliedSource: string | null = null;

	const harness = await createHarness({
		active: true,
		locked: false,
		initialDraft: located.draft,
		sessionKey: 'edit-session-horizontal',
		editing: true,
		locale: 'en',
		onInsert: (source) => {
			appliedSource = source;
		},
		onClose: () => {}
	});

	try {
		const captionInput = harness.container.querySelector<HTMLInputElement>('.caption input');
		assert.ok(captionInput, 'Caption input must be present');
		assert.equal(captionInput.value, 'Rates & Stats (#1)');

		captionInput.value = 'Updated Rates & Stats (#2)';
		captionInput.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
		harness.flushSync();

		const weightInputs = Array.from(harness.container.querySelectorAll<HTMLInputElement>('.widths input'));
		assert.equal(weightInputs.length, 2);
		// Keep the parsed first-column scale while changing the intended proportion to 1.5:4.5.
		weightInputs[1]!.value = String(located.draft.weights[0]! * 3);
		weightInputs[1]!.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
		harness.flushSync();

		const applyButton = harness.container.querySelector<HTMLButtonElement>('button.primary');
		assert.ok(applyButton);
		assert.equal(applyButton.textContent?.trim(), 'Apply');
		applyButton.click();
		harness.flushSync();

		assert.ok(appliedSource !== null);
		const parsed = parseTable(appliedSource);
		assert.ok(parsed);
		assert.equal(parsed.style, 'horizontal');
		assert.equal(parsed.caption.position, 'below');
		assert.equal(parsed.caption.text, 'Updated Rates & Stats (#2)');
		assert.ok(Math.abs(parsed.width - 75) < 1e-4);
		const expectedWeightsAfterEdit = [1.5, 4.5];
		const expectedWeightTotal = expectedWeightsAfterEdit.reduce((total, weight) => total + weight, 0);
		const expectedPercentages = expectedWeightsAfterEdit.map((weight) => weight / expectedWeightTotal * 100);
		const parsedPercentages = columnPercentages(parsed);
		for (let i = 0; i < expectedPercentages.length; i++) {
			assert.ok(Math.abs(parsedPercentages[i]! - expectedPercentages[i]!) < 1e-9);
		}

		const target = rangeInsertionTarget(editorState, located.span);
		const editTx = insertionTransaction(editorState, target, appliedSource);
		editorState = editTx.state;

		const updatedDoc = editorState.field(sourceState).projection.document;
		const parsedDoc = parseSource(updatedDoc);
		const updatedLocated = tableAt(updatedDoc, parsedDoc, prefix.length + 5);
		assert.ok(updatedLocated);
		assert.equal(updatedLocated.draft.caption.text, 'Updated Rates & Stats (#2)');
		assertDraftEquivalent(updatedLocated.draft, parsed, 'updated SourceDocument table');

		const undoTx = historyTransaction(editorState, 'undo');
		assert.ok(undoTx);
		assert.deepEqual(undoTx.state.field(sourceState).projection.document.toBytes(), originalDoc.toBytes());
		assert.equal(undoTx.state.field(sourceState).dirty, false);
	} finally {
		await harness.cleanup();
	}
});

test('re-editing existing full border table updates weights and caption position round-tripping cleanly', async () => {
	const initialDraft: TableDraft = {
		rows: 2,
		columns: 2,
		cells: ['Alpha', 'Beta', 'Gamma', 'Delta'],
		weights: [1, 2],
		width: 90,
		header: true,
		style: 'full',
		rules: 'hline',
		caption: { position: 'above', text: 'Grid Matrix' }
	};

	const initialTeX = tableSource(initialDraft);
	const prefix = '% Leading notes\r\n\\begin{document}\n';
	const suffix = '\r\n\\end{document}\n';
	const originalDoc = SourceDocument.open(new TextEncoder().encode('\uFEFF' + prefix + initialTeX + suffix));

	let editorState = createSourceState(originalDoc);
	const projection = parseSource(originalDoc);
	const located = tableAt(originalDoc, projection, prefix.length + 8);
	assert.ok(located);

	let appliedSource: string | null = null;

	const harness = await createHarness({
		active: true,
		locked: false,
		initialDraft: located.draft,
		sessionKey: 'edit-session-full',
		editing: true,
		locale: 'zh-Hant',
		onInsert: (source) => {
			appliedSource = source;
		},
		onClose: () => {}
	});

	try {
		const captionSelect = Array.from(harness.container.querySelectorAll<HTMLSelectElement>('.options select')).find((select) =>
			Array.from(select.options).some((opt) => opt.value === 'above' || opt.value === 'below')
		);
		assert.ok(captionSelect, 'Caption select must exist');
		captionSelect.value = 'below';
		captionSelect.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
		harness.flushSync();

		const weightInputs = Array.from(harness.container.querySelectorAll<HTMLInputElement>('.widths input'));
		assert.equal(weightInputs.length, 2);
		// The parsed draft stores width fractions (0.3, 0.6); use those to produce the intended 3:2 ratio.
		weightInputs[0]!.value = String(located.draft.weights[1]! * 1.5);
		weightInputs[0]!.dispatchEvent(new harness.dom.window.Event('change', { bubbles: true }));
		harness.flushSync();

		const cellInputs = Array.from(harness.container.querySelectorAll<HTMLInputElement>('tbody td input'));
		cellInputs[1]!.value = 'Beta Modified';
		cellInputs[1]!.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
		harness.flushSync();

		const applyButton = harness.container.querySelector<HTMLButtonElement>('button.primary');
		assert.ok(applyButton);
		applyButton.click();
		harness.flushSync();

		assert.ok(appliedSource !== null);
		const parsed = parseTable(appliedSource);
		assert.ok(parsed);
		assert.equal(parsed.style, 'full');
		assert.equal(parsed.caption.position, 'below');
		assert.equal(parsed.caption.text, 'Grid Matrix');
		assert.ok(Math.abs(parsed.width - 90) < 1e-4);
		const expectedWeightsAfterEdit = [3, 2];
		const expectedWeightTotal = expectedWeightsAfterEdit.reduce((total, weight) => total + weight, 0);
		const expectedPercentages = expectedWeightsAfterEdit.map((weight) => weight / expectedWeightTotal * 100);
		const parsedPercentages = columnPercentages(parsed);
		for (let i = 0; i < expectedPercentages.length; i++) {
			assert.ok(Math.abs(parsedPercentages[i]! - expectedPercentages[i]!) < 1e-9);
		}
		assert.equal(parsed.cells[1], 'Beta Modified');

		const target = rangeInsertionTarget(editorState, located.span);
		const editTx = insertionTransaction(editorState, target, appliedSource);
		editorState = editTx.state;

		const modifiedDoc = editorState.field(sourceState).projection.document;
		assert.ok(modifiedDoc.read().startsWith(prefix));
		assert.ok(modifiedDoc.read().endsWith(suffix));
		assert.equal(modifiedDoc.profile.bom, true);

		const modifiedProjection = parseSource(modifiedDoc);
		const modifiedLocated = tableAt(modifiedDoc, modifiedProjection, prefix.length + 8);
		assert.ok(modifiedLocated);
		assert.deepEqual(modifiedLocated.draft, parsed);

		const undoTx = historyTransaction(editorState, 'undo');
		assert.ok(undoTx);
		assert.deepEqual(undoTx.state.field(sourceState).projection.document.toBytes(), originalDoc.toBytes());
		assert.equal(undoTx.state.field(sourceState).dirty, false);
	} finally {
		await harness.cleanup();
	}
});

test(
	'same mounted TablePanel inserts, closes, rebases a new edit session, and cancels without remounting',
	{ timeout: 180_000 },
	async () => {
	const initialDraft1: TableDraft = {
		rows: 2,
		columns: 2,
		cells: ['A1', 'B1', 'A2', 'B2'],
		weights: [0.4, 0.4],
		width: 80,
		header: true,
		style: 'three-line',
		rules: 'hline',
		caption: { position: 'none', text: '' }
	};

	const initialTeX1 = tableSource(initialDraft1);
	const prefix = '% Document prefix with comments and preserved BOM\r\n\\begin{document}\n';
	const emptyParagraph = '\n';
	const suffix = '\r\n% Suffix text\n\\end{document}';
	const originalBytes = new TextEncoder().encode('\uFEFF' + prefix + emptyParagraph + initialTeX1 + suffix);
	const originalDoc = SourceDocument.open(originalBytes);
	assert.equal(
		originalDoc.read().slice(prefix.length - 1, prefix.length + emptyParagraph.length),
		'\n' + emptyParagraph,
		'The insertion selection must be at an actual empty paragraph before the existing table'
	);
	const initialVersion = originalDoc.version;

	let editorState = createSourceState(originalDoc);
	const emptyParagraphTarget = rangeInsertionTarget(editorState, {
		documentId: originalDoc.documentId, version: originalDoc.version,
		from: prefix.length, to: prefix.length
	});
	assert.equal(editorState.doc.sliceString(0, emptyParagraphTarget.from), prefix.replace(/\r\n|\r/g, '\n'));
	editorState = editorState.update({ selection: { anchor: emptyParagraphTarget.from } }).state;

	const appliedSources: Array<{ source: string; booktabs?: boolean }> = [];
	let closeCount = 0;

	const harness = await createHarness({
		active: true,
		locked: false,
		initialDraft: initialDraft1,
		sessionKey: 'insert',
		editing: false,
		locale: 'zh-Hant',
		onInsert: (source, booktabs) => {
			appliedSources.push({ source, booktabs });
		},
		onClose: () => {
			closeCount++;
		}
	});

	try {
		const parsedInitialDraft = parseTable(initialTeX1);
		assert.ok(parsedInitialDraft, 'Initial table source must parse cleanly');
		assertDraftEquivalent(parsedInitialDraft, initialDraft1, 'initial insertion draft');
		const initialInputs = Array.from(harness.container.querySelectorAll<HTMLInputElement>('tbody td input'));
		assert.deepEqual(initialInputs.map((input) => input.value), initialDraft1.cells);
		assert.equal(harness.container.querySelector<HTMLButtonElement>('button.primary')?.textContent?.trim(), '插入');

		initialInputs[0]!.value = 'A1_Inserted';
		initialInputs[0]!.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
		await harness.settle();
		initialInputs[3]!.value = 'B2_Inserted';
		initialInputs[3]!.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
		await harness.settle();

		const insertButton = harness.container.querySelector<HTMLButtonElement>('button.primary');
		assert.ok(insertButton, 'Insert button must exist');
		insertButton.click();
		await harness.settle();
		assert.equal(appliedSources.length, 1, 'The mounted Insert button must invoke onInsert');
		assert.equal(appliedSources[0]!.booktabs, false);
		const parsedInsertion = parseTable(appliedSources[0]!.source);
		assert.ok(parsedInsertion, 'Inserted source must round-trip through parseTable');
		assert.deepEqual(parsedInsertion.cells, ['A1_Inserted', 'B1', 'A2', 'B2_Inserted']);
		assert.equal(appliedSources[0]!.source, tableSource(parsedInsertion));

		const insertionTargetAtSelection = insertionTarget(editorState);
		assert.equal(insertionTargetAtSelection.version, initialVersion);
		assert.equal(insertionTargetAtSelection.from, emptyParagraphTarget.from);
		assert.equal(insertionTargetAtSelection.to, emptyParagraphTarget.to);
		const insertionTx = insertionTransaction(editorState, insertionTargetAtSelection, appliedSources[0]!.source);
		editorState = insertionTx.state;
		const documentAfterInsertion = editorState.field(sourceState).projection.document;
		const bytesAfterInsertion = documentAfterInsertion.toBytes();
		assert.notEqual(documentAfterInsertion.version, initialVersion);
		assert.equal(documentAfterInsertion.profile.bom, true);
		assert.ok(documentAfterInsertion.read().startsWith(prefix));
		assert.ok(documentAfterInsertion.read().endsWith(suffix));
		const normalizeEols = (source: string) => source.replace(/\r\n|\r/g, '\n');
		const expectedInsertedPrefix = normalizeEols(
			prefix + appliedSources[0]!.source + emptyParagraph + initialTeX1
		);
		assert.ok(
			normalizeEols(documentAfterInsertion.read()).startsWith(expectedInsertedPrefix),
			'The inserted table must remain separated from the existing table by the empty paragraph newline'
		);

		const projectionAfterInsertion = parseSource(documentAfterInsertion);
		const locatedAfterInsertion = tableAt(documentAfterInsertion, projectionAfterInsertion, prefix.length + 10);
		assert.ok(locatedAfterInsertion, 'Inserted table must be located in the updated SourceDocument');
		assert.equal(locatedAfterInsertion.span.version, documentAfterInsertion.version);
		assert.deepEqual(locatedAfterInsertion.draft, parsedInsertion);

		// Leave a local-only value behind, then close through the mounted header button.
		initialInputs[0]!.value = 'Unapplied_After_Insert';
		initialInputs[0]!.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
		await harness.settle();
		const closeButton1 = harness.container.querySelector<HTMLButtonElement>('.header button.text-button');
		assert.ok(closeButton1, 'Header close button must exist');
		closeButton1.click();
		await harness.settle();
		assert.equal(closeCount, 1, 'The mounted Close button must invoke onClose');
		harness.setProps({ active: false, locked: false, initialDraft: null, sessionKey: 'closed-after-insert' });
		await harness.settle();
		assert.equal(harness.container.querySelector('fieldset')?.disabled, true);
		assert.equal(editorState.field(sourceState).projection.document.version, documentAfterInsertion.version);
		assert.deepEqual(editorState.field(sourceState).projection.document.toBytes(), bytesAfterInsertion);

		const editSession1Key = `${locatedAfterInsertion.span.documentId}:${locatedAfterInsertion.span.version}:${locatedAfterInsertion.span.from}:${locatedAfterInsertion.span.to}`;
		harness.setProps({
			active: true,
			locked: false,
			initialDraft: locatedAfterInsertion.draft,
			sessionKey: editSession1Key,
			editing: true,
			locale: 'en'
		});
		await harness.settle();
		const editInputs1 = Array.from(harness.container.querySelectorAll<HTMLInputElement>('tbody td input'));
		assert.deepEqual(editInputs1.map((input) => input.value), parsedInsertion.cells, 'A new edit session must load the committed draft');
		assert.notEqual(editInputs1[0]!.value, 'Unapplied_After_Insert', 'Uncommitted insert-session state must not leak into a new session');
		assert.equal(harness.container.querySelector<HTMLButtonElement>('button.primary')?.textContent?.trim(), 'Apply');

		editInputs1[0]!.value = 'A1_Edited';
		editInputs1[0]!.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
		await harness.settle();
		const staleParentDraft: TableDraft = {
			...locatedAfterInsertion.draft,
			cells: locatedAfterInsertion.draft.cells.map((cell, index) => index === 0 ? 'Parent_Stale_Value' : cell)
		};
		harness.setProps({ initialDraft: staleParentDraft, locale: 'en' });
		await harness.settle();
		assert.equal(editInputs1[0]!.value, 'A1_Edited', 'Same-session prop updates must preserve a dirty local edit');

		const applyButton1 = harness.container.querySelector<HTMLButtonElement>('button.primary');
		assert.ok(applyButton1, 'Apply button must exist');
		applyButton1.click();
		await harness.settle();
		assert.equal(appliedSources.length, 2, 'The mounted Apply button must invoke onInsert');
		const parsedEdit = parseTable(appliedSources[1]!.source);
		assert.ok(parsedEdit, 'Applied edit source must round-trip through parseTable');
		assert.equal(parsedEdit.cells[0], 'A1_Edited');
		assert.equal(parsedEdit.cells[3], 'B2_Inserted');
		assert.equal(appliedSources[1]!.source, tableSource(parsedEdit));

		const editTarget1 = rangeInsertionTarget(editorState, locatedAfterInsertion.span);
		assert.equal(editTarget1.version, documentAfterInsertion.version);
		editorState = insertionTransaction(editorState, editTarget1, appliedSources[1]!.source).state;
		const documentAfterEdit = editorState.field(sourceState).projection.document;
		const bytesAfterEdit = documentAfterEdit.toBytes();
		assert.notEqual(documentAfterEdit.version, documentAfterInsertion.version);
		assert.equal(documentAfterEdit.profile.bom, true);
		assert.ok(documentAfterEdit.read().startsWith(prefix));
		assert.ok(documentAfterEdit.read().endsWith(suffix));

		const projectionAfterEdit = parseSource(documentAfterEdit);
		const locatedAfterEdit = tableAt(documentAfterEdit, projectionAfterEdit, prefix.length + 10);
		assert.ok(locatedAfterEdit, 'Edited table must be located at the new SourceDocument version');
		assert.equal(locatedAfterEdit.span.version, documentAfterEdit.version);
		assert.deepEqual(locatedAfterEdit.draft, parsedEdit);

		// Dirty the panel after Apply so the next session must rebase from the updated source.
		const stalePanelInput = harness.container.querySelectorAll<HTMLInputElement>('tbody td input')[0]!;
		stalePanelInput.value = 'Unapplied_After_Edit';
		stalePanelInput.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
		await harness.settle();
		const closeButton2 = harness.container.querySelector<HTMLButtonElement>('.header button.text-button');
		assert.ok(closeButton2);
		closeButton2.click();
		await harness.settle();
		assert.equal(closeCount, 2);
		harness.setProps({ active: false, locked: false, initialDraft: null, sessionKey: 'closed-after-edit' });
		await harness.settle();
		assert.equal(editorState.field(sourceState).projection.document.version, documentAfterEdit.version);
		assert.deepEqual(editorState.field(sourceState).projection.document.toBytes(), bytesAfterEdit);

		const editSession2Key = `${locatedAfterEdit.span.documentId}:${locatedAfterEdit.span.version}:${locatedAfterEdit.span.from}:${locatedAfterEdit.span.to}`;
		assert.notEqual(editSession2Key, editSession1Key, 'The new edit session must use the refreshed source identity');
		harness.setProps({
			active: true,
			locked: false,
			initialDraft: locatedAfterEdit.draft,
			sessionKey: editSession2Key,
			editing: true,
			locale: 'zh-Hant'
		});
		await harness.settle();
		const editInputs2 = Array.from(harness.container.querySelectorAll<HTMLInputElement>('tbody td input'));
		assert.deepEqual(editInputs2.map((input) => input.value), locatedAfterEdit.draft.cells, 'New-session draft must rebase from the latest SourceDocument');
		assert.equal(editInputs2[0]!.value, 'A1_Edited');
		assert.notEqual(editInputs2[0]!.value, 'Unapplied_After_Edit');

		const versionBeforeCancel = editorState.field(sourceState).projection.document.version;
		const bytesBeforeCancel = editorState.field(sourceState).projection.document.toBytes();
		const dirtyBeforeCancel = editorState.field(sourceState).dirty;
		const appliesBeforeCancel = appliedSources.length;
		editInputs2[0]!.value = 'Mutated_Draft_To_Cancel';
		editInputs2[0]!.dispatchEvent(new harness.dom.window.Event('input', { bubbles: true }));
		await harness.settle();
		const cancelButton = Array.from(harness.container.querySelectorAll<HTMLButtonElement>('.actions button')).find(
			(button) => button.textContent?.trim() === '取消'
		);
		assert.ok(cancelButton, 'Cancel button must exist');
		cancelButton.click();
		await harness.settle();
		assert.equal(closeCount, 3, 'The mounted Cancel button must invoke onClose');
		harness.setProps({ active: false, locked: false, initialDraft: null, sessionKey: 'closed-after-cancel' });
		await harness.settle();
		const documentAfterCancel = editorState.field(sourceState).projection.document;
		assert.equal(documentAfterCancel.version, versionBeforeCancel, 'Cancel must not advance the document version');
		assert.deepEqual(documentAfterCancel.toBytes(), bytesBeforeCancel, 'Cancel must not mutate document bytes');
		assert.equal(editorState.field(sourceState).dirty, dirtyBeforeCancel, 'Cancel must not alter the shared dirty state');
		assert.equal(appliedSources.length, appliesBeforeCancel, 'Cancel must not invoke onInsert');

		// The two committed UI transactions share CodeMirror history; cancellation adds none.
		const undoEdit = historyTransaction(editorState, 'undo');
		assert.ok(undoEdit, 'Undo of the committed edit must be available after Cancel');
		editorState = undoEdit.state;
		const afterUndoEdit = editorState.field(sourceState).projection.document;
		assert.equal(afterUndoEdit.version, documentAfterCancel.version + 1, 'Undo restores content under a fresh source version');
		assert.deepEqual(afterUndoEdit.toBytes(), bytesAfterInsertion, 'First undo restores the inserted document exactly');
		assert.equal(editorState.field(sourceState).dirty, true);

		const undoInsertion = historyTransaction(editorState, 'undo');
		assert.ok(undoInsertion, 'Undo of the insertion must be available');
		editorState = undoInsertion.state;
		const afterDoubleUndo = editorState.field(sourceState).projection.document;
		assert.equal(afterDoubleUndo.version, afterUndoEdit.version + 1, 'Restoring original bytes must not reuse a stale version');
		assert.deepEqual(afterDoubleUndo.toBytes(), originalBytes, 'Double undo must restore the exact original bytes');
		assert.equal(afterDoubleUndo.profile.bom, true);
		assert.ok(afterDoubleUndo.read().startsWith(prefix), 'Original mixed-EOL prefix must be intact');
		assert.ok(afterDoubleUndo.read().endsWith(suffix), 'Original mixed-EOL suffix must be intact');
		assert.equal(editorState.field(sourceState).dirty, false);

		const redoInsertion = historyTransaction(editorState, 'redo');
		assert.ok(redoInsertion, 'Redo of the insertion must be available');
		editorState = redoInsertion.state;
		assert.deepEqual(editorState.field(sourceState).projection.document.toBytes(), bytesAfterInsertion);
		const redoEdit = historyTransaction(editorState, 'redo');
		assert.ok(redoEdit, 'Redo of the edit must be available');
		editorState = redoEdit.state;
		assert.deepEqual(editorState.field(sourceState).projection.document.toBytes(), bytesAfterEdit);

		const finalUndoEdit = historyTransaction(editorState, 'undo');
		assert.ok(finalUndoEdit);
		editorState = finalUndoEdit.state;
		const finalUndoInsertion = historyTransaction(editorState, 'undo');
		assert.ok(finalUndoInsertion);
		editorState = finalUndoInsertion.state;
		assert.deepEqual(editorState.field(sourceState).projection.document.toBytes(), originalBytes);
		assert.equal(editorState.field(sourceState).dirty, false);
	} finally {
		await harness.cleanup();
	}
	}
);

test('documents real API limitation: parseTable strictly rejects unsupported syntax while valid drafts round-trip', () => {
	const validDraft = createTable(2, 2);
	const validSource = tableSource(validDraft);
	assert.ok(parseTable(validSource) !== null);

	const unsupportedSpec = '\\begin{center}\n\\begin{tabular}{ll}\n\\hline\n{} & {} \\\\\n\\hline\n\\end{tabular}\n\\end{center}';
	assert.equal(parseTable(unsupportedSpec), null, 'parseTable rejects non-p columns without synthetic heuristics');

	const unescapedStructure = '\\begin{center}\n\\begin{tabular}{p{\\dimexpr0.400000\\linewidth-2\\tabcolsep\\relax}}\n\\hline\n\\textbf{\\unknown{cmd}} \\\\\n\\hline\n\\end{tabular}\n\\end{center}';
	assert.equal(parseTable(unescapedStructure), null, 'parseTable rejects unknown macros in cell content');

	const changedRatio = parseTable(tableSource({ ...validDraft, weights: [1, 2] }));
	assert.ok(changedRatio, 'Changed column weights must still serialize and parse');
	assert.throws(
		() => assertDraftEquivalent(changedRatio, validDraft, 'changed-ratio fixture'),
		/column ratio at index/
	);
});
