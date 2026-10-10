import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { ColumnDrag, resizeColumns } from '../../src/features/tables/column-resize.ts';
import { createTable, parseTable, tableSource, type TableDraft } from '../../src/features/tables/source.ts';

type BrowserWindow = Window & typeof globalThis & { close(): void };
type Locale = 'zh-Hant' | 'en';
type ClientModule = {
	mount: (component: unknown, options: { target: HTMLElement; props: Record<string, unknown> }) => unknown;
	unmount: (instance: unknown) => Promise<void>;
	flushSync: (fn?: () => void) => void;
	tick: () => Promise<void>;
	TablePanelHarness: unknown;
};
type HarnessProps = {
	active: boolean;
	locked?: boolean;
	initialDraft?: TableDraft | null;
	sessionKey?: string;
	editing?: boolean;
	locale?: Locale;
	onInsert: (source: string, booktabs?: boolean) => void;
	onClose: () => void;
};
type HarnessController = { setProps: (next: Partial<HarnessProps>) => void };
type CaptureProbe = { captured: Set<number>; setCalls: number[]; releases: number[] };

const { JSDOM } = createRequire(import.meta.url)('jsdom') as {
	JSDOM: new (html: string, options?: { url?: string; pretendToBeVisual?: boolean }) => {
		window: BrowserWindow;
	};
};
const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const tablePanelPath = fileURLToPath(new URL('../../src/features/tables/TablePanel.svelte', import.meta.url)).replaceAll('\\', '/');
const sourcePath = fileURLToPath(new URL('../../src/features/tables/source.ts', import.meta.url)).replaceAll('\\', '/');

let tempDir: string | null = null;
let dom: { window: BrowserWindow } | null = null;
let client: ClientModule | null = null;
const previousGlobals = new Map<string, PropertyDescriptor | undefined>();
const captureProbes = new WeakMap<HTMLButtonElement, CaptureProbe>();

async function boundedWait<T>(label: string, promise: Promise<T>, timeoutMs = 5_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
	});
	try {
		return await Promise.race([promise, timeout]);
	} catch (error) {
		// Drain the real build/import before restoring globals or removing its files.
		try { await promise; } catch {}
		throw error;
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

function installBrowserGlobals(win: BrowserWindow): void {
	const keys = [
		'window', 'document', 'navigator', 'location', 'MutationObserver', 'Node', 'Element', 'HTMLElement',
		'HTMLButtonElement', 'HTMLInputElement', 'HTMLMediaElement', 'HTMLSelectElement', 'HTMLTableElement', 'Text', 'Comment',
		'Document', 'DocumentFragment', 'EventTarget', 'Event', 'CustomEvent', 'MouseEvent', 'KeyboardEvent',
		'FocusEvent', 'HTMLDivElement', 'HTMLFieldSetElement', 'HTMLHeadingElement', 'HTMLLabelElement',
		'HTMLOptionElement', 'HTMLParagraphElement', 'HTMLTableSectionElement', 'HTMLTableRowElement',
		'HTMLTableCellElement', 'HTMLTableColElement', 'getComputedStyle', 'requestAnimationFrame',
		'cancelAnimationFrame'
	];
	const values = win as unknown as Record<string, unknown>;
	for (const key of keys) {
		previousGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		const value = key === 'getComputedStyle' ? win.getComputedStyle.bind(win) : values[key];
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
}

function restoreBrowserGlobals(): void {
	for (const [key, descriptor] of previousGlobals) {
		try {
			if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
			else Object.defineProperty(globalThis, key, descriptor);
		} catch {
			// Restore the remaining globals even if a host property cannot be changed.
		}
	}
	previousGlobals.clear();
}

test.before(
	async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'table-session-race-'));
		tempDir = directory;
		dom = new JSDOM('<!doctype html><html><body></body></html>', {
			url: 'https://modutex.test',
			pretendToBeVisual: true
		});
		installBrowserGlobals(dom.window);

		const harnessFile = path.join(directory, 'TablePanelHarness.svelte');
		const entryFile = path.join(directory, 'entry.js');
		const normalizedHarnessFile = harnessFile.replaceAll('\\', '/');
		fs.writeFileSync(
			harnessFile,
			`<script lang="ts">
	import TablePanel from ${JSON.stringify(tablePanelPath)};
	import type { TableDraft } from ${JSON.stringify(sourcePath)};
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
`
		);
		fs.writeFileSync(
			entryFile,
			[
				`import { mount, unmount, flushSync, tick } from 'svelte';`,
				`import TablePanelHarness from ${JSON.stringify(normalizedHarnessFile)};`,
				'export { mount, unmount, flushSync, tick, TablePanelHarness };'
			].join('\n')
		);

		const bundleFile = path.join(directory, 'table-panel-client.mjs');
		await boundedWait(
			'Vite TablePanel client build',
			build({
				root: frontendRoot,
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
					rollupOptions: { external: [] }
				},
				resolve: { dedupe: ['svelte'], conditions: ['browser', 'default'] },
				logLevel: 'silent'
			}),
			120_000
		);
		if (!fs.existsSync(bundleFile)) throw new Error('Vite build did not emit the TablePanel client bundle');
		client = (await boundedWait('Vite TablePanel client import', import(pathToFileURL(bundleFile).href), 30_000)) as ClientModule;
	},
	{ timeout: 120_000 }
);

after(async () => {
	restoreBrowserGlobals();
	try {
		dom?.window.close();
	} finally {
		dom = null;
		if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
		client = null;
	}
});

async function createHarness(props: HarnessProps) {
	assert.ok(dom);
	assert.ok(client);
	const win = dom.window;
	const api = client;
	const container = win.document.createElement('div');
	win.document.body.appendChild(container);
	let controller: HarnessController | null = null;
	let mounted: unknown;
	mounted = api.mount(api.TablePanelHarness, {
		target: container,
		props: {
			...props,
			onController: (value: HarnessController) => {
				controller = value;
			}
		}
	});
	api.flushSync();
	await boundedWait('initial TablePanel render', api.tick());
	api.flushSync();
	await boundedWait('initial TablePanel effects', api.tick());
	api.flushSync();
	assert.ok(controller);

	let cleaned = false;
	return {
		container,
		flushSync: api.flushSync,
		setProps(next: Partial<HarnessProps>) {
			const current = controller;
			if (!current) throw new Error('TablePanel controller is unavailable');
			current.setProps(next);
			api.flushSync();
		},
		async settle() {
			await boundedWait('TablePanel Svelte update', api.tick());
			api.flushSync();
		},
		async cleanup() {
			if (cleaned) return;
			cleaned = true;
			const current = mounted;
			mounted = undefined;
			try {
				if (current !== undefined) {
					const completion = api.unmount(current);
					api.flushSync();
					await completion;
				}
			} finally {
				api.flushSync();
				container.remove();
			}
		}
	};
}

function pointerEvent(win: BrowserWindow, type: string, pointerId: number, clientX: number): Event {
	const event = new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX });
	Object.defineProperty(event, 'pointerId', { value: pointerId });
	return event;
}

function installPointerCaptureShim(button: HTMLButtonElement, win: BrowserWindow): CaptureProbe {
	const existing = captureProbes.get(button);
	if (existing) return existing;
	const probe: CaptureProbe = { captured: new Set(), setCalls: [], releases: [] };
	captureProbes.set(button, probe);
	// JSDOM has no native pointer-capture implementation. This shim records ownership and
	// dispatches the corresponding loss event so the mounted component's real handlers run.
	Object.defineProperty(button, 'setPointerCapture', {
		configurable: true,
		value(pointerId: number) {
			probe.setCalls.push(pointerId);
			probe.captured.add(pointerId);
		}
	});
	Object.defineProperty(button, 'hasPointerCapture', {
		configurable: true,
		value(pointerId: number) {
			return probe.captured.has(pointerId);
		}
	});
	Object.defineProperty(button, 'releasePointerCapture', {
		configurable: true,
		value(pointerId: number) {
			if (!probe.captured.delete(pointerId)) return;
			probe.releases.push(pointerId);
			button.dispatchEvent(pointerEvent(win, 'lostpointercapture', pointerId, 0));
		}
	});
	return probe;
}

/*
 * JSDOM has no layout. This deterministic track-width shim only lets the real mounted
 * pointer handlers receive a nonzero width; it is not browser acceptance or validation
 * of actual layout, hit testing, pointer capture, or drag geometry.
 */
function installTrackGeometry(panel: HTMLElement, width: number): void {
	const track = panel.querySelector<HTMLDivElement>('.width-track');
	assert.ok(track);
	Object.defineProperty(track, 'getBoundingClientRect', {
		configurable: true,
		value: () =>
			({
				x: 0,
				y: 0,
				left: 0,
				top: 0,
				right: width,
				bottom: 36,
				width,
				height: 36,
				toJSON: () => ({})
			}) as DOMRect
	});
}

function weightsIn(panel: HTMLElement): number[] {
	return Array.from(panel.querySelectorAll<HTMLInputElement>('.widths input'), (input) => input.valueAsNumber);
}

function cellsIn(panel: HTMLElement): string[] {
	return Array.from(panel.querySelectorAll<HTMLInputElement>('tbody td input'), (input) => input.value);
}

function assertAdjacentPairPreserved(before: readonly number[], after: readonly number[], boundary: number): void {
	assert.ok(after[boundary]! > 0, 'the left resized column must remain positive');
	assert.ok(after[boundary + 1]! > 0, 'the right resized column must remain positive');
	assert.equal(after[boundary]! + after[boundary + 1]!, before[boundary]! + before[boundary + 1]!, 'the adjacent pair total must stay unchanged');
	for (let index = 0; index < before.length; index++) {
		if (index !== boundary && index !== boundary + 1) assert.equal(after[index], before[index], `column ${index} outside the pair must not change`);
	}
}

test('ColumnDrag rejects a competing pointer and preserves tiny positive column widths', () => {
	const tinyPair = [1, Number.MIN_VALUE] as const;
	const pairTotal = tinyPair[0] + tinyPair[1];
	const resized = resizeColumns(tinyPair, 0, 100);
	assert.ok(resized[0]! > 0);
	assert.ok(resized[1]! > 0);
	assert.equal(resized[0]! + resized[1]!, pairTotal);

	const drag = new ColumnDrag();
	assert.equal(drag.begin(41, 0, 100, 0, tinyPair), true);
	assert.equal(drag.begin(42, 0, 100, 0, tinyPair), false, 'a second pointer must not replace the owned drag');
	assert.equal(drag.move(42, 100), null, 'the non-owning pointer cannot resize');
	const moved = drag.move(41, 100);
	assert.ok(moved);
	assert.ok(moved[0]! > 0);
	assert.ok(moved[1]! > 0);
	assert.equal(moved[0]! + moved[1]!, pairTotal);
	drag.cancel();
	assert.equal(drag.move(41, 200), null, 'a cancelled drag cannot produce a stale write');
});

test(
	'mounted TablePanel switches sessions atomically, preserves locale focus, and cancels stale pointer writes',
	{ timeout: 180_000 },
	async () => {
		assert.ok(dom);
		assert.ok(client);
		const win = dom.window;
		const api = client;
		const firstDraft: TableDraft = {
			...createTable(2, 2),
			cells: ['old-a', 'old-b', 'old-c', 'old-d'],
			weights: [2, 1],
			width: 90,
			style: 'full',
			rules: 'hline',
			caption: { position: 'above', text: 'Old session' }
		};
		const secondDraft: TableDraft = {
			...createTable(2, 3),
			cells: ['new-a', 'new-b', 'new-c', 'new-d', 'new-e', 'new-f'],
			weights: [1, 2, 3],
			width: 75,
			style: 'horizontal',
			caption: { position: 'below', text: 'Second session' }
		};
		const booktabsDraft: TableDraft = {
			...createTable(2, 3),
			cells: ['book-a', 'book-b', 'book-c', 'book-d', 'book-e', 'book-f'],
			weights: [4, 5, 6],
			style: 'three-line',
			rules: 'booktabs',
			caption: { position: 'above', text: 'Third session' }
		};
		const insertions: Array<{ source: string; booktabs?: boolean }> = [];
		const harness = await createHarness({
			active: true,
			locked: false,
			initialDraft: firstDraft,
			sessionKey: 'session-a',
			editing: false,
			locale: 'zh-Hant',
			onInsert: (source, booktabs) => {
				insertions.push({ source, ...(booktabs === undefined ? {} : { booktabs }) });
			},
			onClose: () => {}
		});

		try {
			const panel = harness.container.querySelector<HTMLElement>('.table-panel');
			assert.ok(panel);
			assert.deepEqual(cellsIn(panel), firstDraft.cells);
			assert.equal(panel.getAttribute('aria-label'), '插入表格');

			const firstInput = panel.querySelector<HTMLInputElement>('tbody td input');
			assert.ok(firstInput);
			firstInput.value = 'unapplied from old session';
			firstInput.dispatchEvent(new win.Event('input', { bubbles: true }));
			harness.flushSync();

			// Both session identity and its draft change in one parent update.
			harness.setProps({ initialDraft: secondDraft, sessionKey: 'session-b' });
			await harness.settle();
			assert.deepEqual(cellsIn(panel), secondDraft.cells, 'the new session must load its matching draft, not the previous local edit');
			assert.equal(panel.querySelectorAll('tbody td input').length, 6);

			const secondInputs = Array.from(panel.querySelectorAll<HTMLInputElement>('tbody td input'));
			const focusedInput = secondInputs[4]!;
			focusedInput.value = 'local second-session edit';
			focusedInput.dispatchEvent(new win.Event('input', { bubbles: true }));
			harness.flushSync();
			focusedInput.focus();
			const staleParentDraft: TableDraft = {
				...secondDraft,
				cells: secondDraft.cells.map((cell, index) => index === 4 ? 'stale parent value' : cell)
			};
			harness.setProps({ initialDraft: staleParentDraft });
			await harness.settle();
			assert.equal(cellsIn(panel)[4], 'local second-session edit', 'a same-session parent refresh must not replace the local draft');

			harness.setProps({ locale: 'en' });
			await harness.settle();
			assert.equal(panel.getAttribute('aria-label'), 'Insert table');
			assert.equal(panel.querySelector('h2')?.textContent?.trim(), 'Table');
			assert.equal(win.document.activeElement, focusedInput, 'changing locale must preserve the focused cell');
			assert.equal(cellsIn(panel)[4], 'local second-session edit');
			harness.setProps({ locale: 'zh-Hant' });
			await harness.settle();
			assert.equal(win.document.activeElement, focusedInput, 'switching locale back must preserve focus too');
			assert.equal(cellsIn(panel)[4], 'local second-session edit');

			const keyboardBoundary = panel.querySelector<HTMLButtonElement>('.column-boundary');
			assert.ok(keyboardBoundary);
			const sendKey = (key: string, init: KeyboardEventInit = {}, composing = false) => {
				const event = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
				if (composing) Object.defineProperty(event, 'isComposing', { configurable: true, value: true });
				keyboardBoundary.dispatchEvent(event);
				harness.flushSync();
				return event;
			};
			const beforeArrow = weightsIn(panel);
			const arrow = sendKey('ArrowRight');
			const afterArrow = weightsIn(panel);
			assert.equal(arrow.defaultPrevented, true);
			assertAdjacentPairPreserved(beforeArrow, afterArrow, 0);
			assert.notDeepEqual(afterArrow, beforeArrow, 'an unmodified arrow key must resize the adjacent pair');

			for (const modifier of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
				const beforeIgnored = weightsIn(panel);
				const ignored = sendKey('ArrowLeft', modifier);
				assert.equal(ignored.defaultPrevented, false);
				assert.deepEqual(weightsIn(panel), beforeIgnored, 'unsupported modifiers must not resize columns');
			}
			const beforeComposition = weightsIn(panel);
			const composing = sendKey('ArrowLeft', {}, true);
			assert.equal(composing.isComposing, true);
			assert.equal(composing.defaultPrevented, false);
			assert.deepEqual(weightsIn(panel), beforeComposition, 'composition keystrokes must not resize columns');

			// Shift is the documented larger keyboard step; other modifiers above are ignored.
			const beforeShift = weightsIn(panel);
			const shiftArrow = sendKey('ArrowLeft', { shiftKey: true });
			const afterShift = weightsIn(panel);
			assert.equal(shiftArrow.defaultPrevented, true);
			assertAdjacentPairPreserved(beforeShift, afterShift, 0);
			assert.notDeepEqual(afterShift, beforeShift);

			const insertButton = panel.querySelector<HTMLButtonElement>('.actions button.primary');
			assert.ok(insertButton);
			insertButton.click();
			harness.flushSync();
			assert.equal(insertions.length, 1);
			assert.equal(insertions[0]!.booktabs, false);
			const parsedSecond = parseTable(insertions[0]!.source);
			assert.ok(parsedSecond, 'the mounted component must use the real table serializer');
			assert.deepEqual(parsedSecond.cells, ['new-a', 'new-b', 'new-c', 'new-d', 'local second-session edit', 'new-f']);
			// With two rows, horizontal and three-line hline source are identical.
			// Verify the selected control and exact serializer round-trip below.
			assert.equal(panel.querySelector<HTMLSelectElement>('.options select')?.value, 'horizontal');
			assert.equal(parsedSecond.caption.position, 'below');
			assert.equal(parsedSecond.caption.text, 'Second session');
			assert.equal(insertions[0]!.source, tableSource(parsedSecond));

			installTrackGeometry(panel, 300);
			const boundaries = Array.from(panel.querySelectorAll<HTMLButtonElement>('.column-boundary'));
			assert.equal(boundaries.length, 2);
			const [leftBoundary, rightBoundary] = boundaries;
			assert.ok(leftBoundary);
			assert.ok(rightBoundary);
			const leftProbe = installPointerCaptureShim(leftBoundary, win);
			const rightProbe = installPointerCaptureShim(rightBoundary, win);
			const beforePointer = weightsIn(panel);
			const primaryDown = pointerEvent(win, 'pointerdown', 101, 50);
			leftBoundary.dispatchEvent(primaryDown);
			harness.flushSync();
			assert.equal(primaryDown.defaultPrevented, true);
			assert.ok(leftProbe.captured.has(101));

			rightBoundary.dispatchEvent(pointerEvent(win, 'pointerdown', 202, 150));
			harness.flushSync();
			assert.deepEqual(rightProbe.setCalls, [], 'a second pointer must not acquire capture or steal the active drag');
			rightBoundary.dispatchEvent(pointerEvent(win, 'pointermove', 202, 250));
			harness.flushSync();
			assert.deepEqual(weightsIn(panel), beforePointer, 'movement from the non-owning pointer must not write weights');

			leftBoundary.dispatchEvent(pointerEvent(win, 'pointermove', 101, 80));
			harness.flushSync();
			const afterPointer = weightsIn(panel);
			assertAdjacentPairPreserved(beforePointer, afterPointer, 0);
			assert.notDeepEqual(afterPointer, beforePointer, 'the owning pointer must still resize the pair');
			rightBoundary.dispatchEvent(pointerEvent(win, 'pointerup', 202, 250));
			leftBoundary.dispatchEvent(pointerEvent(win, 'pointerup', 101, 80));
			harness.flushSync();
			assert.ok(leftProbe.releases.includes(101), 'ending the owning pointer must release its capture');
			assert.equal(leftProbe.captured.has(101), false);

			const beginOwnedPointer = (pointerId: number) => {
				installTrackGeometry(panel, 300);
				const button = panel.querySelector<HTMLButtonElement>('.column-boundary');
				assert.ok(button);
				const probe = installPointerCaptureShim(button, win);
				button.dispatchEvent(pointerEvent(win, 'pointerdown', pointerId, 50));
				harness.flushSync();
				assert.ok(probe.captured.has(pointerId), 'the active drag must own pointer capture');
				return { button, probe, pointerId };
			};
			const assertCancelledWithoutWrite = (owned: ReturnType<typeof beginOwnedPointer>, current: readonly number[]) => {
				assert.ok(owned.probe.releases.includes(owned.pointerId), 'cancelling the drag must release its owned capture');
				assert.equal(owned.probe.captured.has(owned.pointerId), false);
				owned.button.dispatchEvent(pointerEvent(win, 'pointermove', owned.pointerId, 500));
				harness.flushSync();
				assert.deepEqual(weightsIn(panel), current, 'a stale pointer move must not write after cancellation');
			};

			const lockDrag = beginOwnedPointer(303);
			harness.setProps({ locked: true });
			await harness.settle();
			const afterLock = weightsIn(panel);
			assertCancelledWithoutWrite(lockDrag, afterLock);
			harness.setProps({ locked: false });
			await harness.settle();

			const inactiveDrag = beginOwnedPointer(304);
			harness.setProps({ active: false });
			await harness.settle();
			const afterDeactivation = weightsIn(panel);
			assertCancelledWithoutWrite(inactiveDrag, afterDeactivation);

			harness.setProps({ active: true });
			await harness.settle();
			const sessionDrag = beginOwnedPointer(305);
			harness.setProps({
				active: true,
				locked: false,
				initialDraft: booktabsDraft,
				sessionKey: 'session-c'
			});
			await harness.settle();
			assert.deepEqual(cellsIn(panel), booktabsDraft.cells, 'a new session must replace the previous session draft');
			assert.deepEqual(weightsIn(panel), booktabsDraft.weights);
			assertCancelledWithoutWrite(sessionDrag, booktabsDraft.weights);

			const thirdInsertButton = panel.querySelector<HTMLButtonElement>('.actions button.primary');
			assert.ok(thirdInsertButton);
			thirdInsertButton.click();
			harness.flushSync();
			assert.equal(insertions.length, 2);
			assert.equal(insertions[1]!.booktabs, true);
			const parsedThird = parseTable(insertions[1]!.source);
			assert.ok(parsedThird);
			assert.deepEqual(parsedThird.cells, booktabsDraft.cells);
			assert.equal(parsedThird.style, 'three-line');
			assert.equal(parsedThird.rules, 'booktabs');
			assert.equal(parsedThird.caption.position, 'above');
			assert.equal(parsedThird.caption.text, 'Third session');
			assert.equal(insertions[1]!.source, tableSource(parsedThird));

			const unmountDrag = beginOwnedPointer(306);
			const detachedWeightInputs = Array.from(panel.querySelectorAll<HTMLInputElement>('.widths input'));
			const weightsBeforeUnmount = detachedWeightInputs.map((input) => input.value);
			await harness.cleanup();
			assert.ok(unmountDrag.probe.releases.includes(306), 'unmount must release the owned pointer capture');
			assert.equal(unmountDrag.probe.captured.has(306), false);
			unmountDrag.button.dispatchEvent(pointerEvent(win, 'pointermove', 306, 500));
			api.flushSync();
			assert.deepEqual(detachedWeightInputs.map((input) => input.value), weightsBeforeUnmount, 'a stale event after unmount must not write draft weights');
		} finally {
			await harness.cleanup();
		}
	}
);
