import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { parseTable, columnPercentages, type TableDraft } from '../../src/features/tables/source.ts';

type DOMWindow = Window & typeof globalThis & { close(): void };
type ClientModule = {
	mount: (component: unknown, options: { target: HTMLElement; props: Record<string, unknown> }) => unknown;
	unmount: (instance: unknown, options?: { outro?: boolean }) => Promise<void>;
	flushSync: (fn?: () => void) => void;
	tick: () => Promise<void>;
	TablePointerHarness: unknown;
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
		'HTMLMediaElement'
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

	// Deterministic pointer capture shim for JSDOM platform limitation
	const elementCaptures = new Map<Element, Set<number>>();
	const elementProto = (win as unknown as { Element: { prototype: Element } }).Element.prototype;

	elementProto.setPointerCapture = function (pointerId: number): void {
		let set = elementCaptures.get(this);
		if (!set) {
			set = new Set<number>();
			elementCaptures.set(this, set);
		}
		set.add(pointerId);
	};

	elementProto.hasPointerCapture = function (pointerId: number): boolean {
		const set = elementCaptures.get(this);
		return set ? set.has(pointerId) : false;
	};

	elementProto.releasePointerCapture = function (pointerId: number): void {
		const set = elementCaptures.get(this);
		if (set && set.has(pointerId)) {
			set.delete(pointerId);
			if (set.size === 0) elementCaptures.delete(this);
			// Dispatch lostpointercapture event per W3C Pointer Events spec
			this.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('lostpointercapture', {
				bubbles: true,
				pointerId
			} as unknown as EventInit));
		}
	};

	// Deterministic geometry for widthTrack in JSDOM (360px standard width)
	const htmlElementProto = (win as unknown as { HTMLElement: { prototype: HTMLElement } }).HTMLElement.prototype;
	htmlElementProto.getBoundingClientRect = function (): DOMRect {
		const isTrack = this.classList.contains('width-track');
		return {
			x: 0,
			y: 0,
			width: isTrack ? 360 : 32,
			height: 36,
			top: 0,
			right: isTrack ? 360 : 32,
			bottom: 36,
			left: 0,
			toJSON: () => ({})
		} as DOMRect;
	};

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

function assertClose(actual: number, expected: number, msg?: string): void {
	assert.ok(Math.abs(actual - expected) <= 1e-12, `${msg ?? ''}: expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`);
}

test.after(() => {
	cleanup();
});

test.before(
	async () => {
		const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'table-pointer-client-'));
		tempDir = buildDir;
		const harnessFile = path.join(buildDir, 'TablePointerHarness.svelte');
		const entryFile = path.join(buildDir, 'entry.js');
		const normalizedHarnessFile = harnessFile.replaceAll('\\', '/');

		fs.writeFileSync(
			harnessFile,
			`<script lang="ts">
	import TablePanel from ${JSON.stringify(tablePanelPath)};
	import type { TableDraft } from ${JSON.stringify(fileURLToPath(new URL('../../src/features/tables/source.ts', import.meta.url)).replaceAll('\\', '/'))};
	let {
		initialDraft = null,
		initialSessionKey = 'insert',
		initialActive = true,
		initialLocked = false,
		onInsert,
		onClose,
		onController
	} = $props<{
		initialDraft?: TableDraft | null;
		initialSessionKey?: string;
		initialActive?: boolean;
		initialLocked?: boolean;
		onInsert: (source: string, booktabs?: boolean) => void;
		onClose: () => void;
		onController: (controller: {
			setActive: (active: boolean) => void;
			setLocked: (locked: boolean) => void;
			setSession: (key: string, draft: TableDraft | null) => void;
		}) => void;
	}>();
	let draft = $state<TableDraft | null>(initialDraft);
	let sessionKey = $state<string>(initialSessionKey);
	let active = $state<boolean>(initialActive);
	let locked = $state<boolean>(initialLocked);
	onController({
		setActive: (nextActive: boolean) => { active = nextActive; },
		setLocked: (nextLocked: boolean) => { locked = nextLocked; },
		setSession: (key: string, nextDraft: TableDraft | null) => {
			draft = nextDraft;
			sessionKey = key;
		}
	});
</script>

<TablePanel
	{active}
	{locked}
	initialDraft={draft}
	{sessionKey}
	{onInsert}
	{onClose}
/>
`
		);
		fs.writeFileSync(
			entryFile,
			`import { mount, unmount, flushSync, tick } from 'svelte';
import TablePointerHarness from ${JSON.stringify(normalizedHarnessFile)};
export { mount, unmount, flushSync, tick, TablePointerHarness };
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
					fileName: () => 'table-pointer-client.mjs'
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

		const bundleUrl = pathToFileURL(path.join(buildDir, 'table-pointer-client.mjs')).href;
		client = (await import(bundleUrl)) as ClientModule;
	},
	{ timeout: 120_000 }
);

test(
	'TablePanel client pointer drag, second-pointer isolation, capture cancellation, keyboard resize, unmount cleanup, and emitted source verification',
	{ timeout: 30_000 },
	async () => {
		assert.ok(dom, 'JSDOM environment must be initialized');
		assert.ok(client, 'Actual Vite-built Svelte client must be loaded');
		const win = dom.window;
		const api = client;
		const container = win.document.getElementById('app');
		assert.ok(container);

		const emittedSources: string[] = [];
		let controller: {
			setActive: (active: boolean) => void;
			setLocked: (locked: boolean) => void;
			setSession: (key: string, draft: TableDraft | null) => void;
		} | undefined;

		const threeColDraft: TableDraft = {
			rows: 2,
			columns: 3,
			cells: ['A', 'B', 'C', '1', '2', '3'],
			weights: [2, 3, 5],
			width: 100,
			style: 'three-line',
			rules: 'hline',
			header: true,
			caption: { position: 'none', text: '' }
		};

		let mounted: unknown;
		try {
			mounted = api.mount(api.TablePointerHarness, {
				target: container,
				props: {
					initialDraft: threeColDraft,
					initialSessionKey: 'drag-session-1',
					onInsert: (source: string) => {
						emittedSources.push(source);
					},
					onClose: () => {},
					onController: (ctrl: NonNullable<typeof controller>) => {
						controller = ctrl;
					}
				}
			});
			api.flushSync();
			await api.tick();
			await api.tick();
			api.flushSync();

			const panel = container.querySelector<HTMLElement>('.table-panel');
			assert.ok(panel, 'TablePanel must be mounted');
			assert.ok(controller, 'Controller must be available');

			const boundaryButtons = () => Array.from(panel.querySelectorAll<HTMLButtonElement>('.width-track .column-boundary'));
			const weightInputs = () => Array.from(panel.querySelectorAll<HTMLInputElement>('.widths input[type="number"]'));
			const getWeights = () => weightInputs().map((input) => input.valueAsNumber);

			assert.equal(boundaryButtons().length, 2, 'A 3-column table has 2 boundary handles');
			assert.deepEqual(getWeights(), [2, 3, 5]);

			const btn0 = boundaryButtons()[0]!;

			// 1. Single pointer gesture: pointer 1 begins at x=100
			// Width track = 360. Boundary 0 pair = 2 + 3 = 5. Total = 10.
			btn0.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointerdown', {
				pointerId: 1,
				clientX: 100,
				button: 0,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			assert.ok(btn0.hasPointerCapture(1), 'Pointer 1 must be captured on button 0');

			// Move pointer 1 by +36px: share = 36 / 360 = 0.1 of total(10) => +1.0 on weight[0], -1.0 on weight[1]
			btn0.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointermove', {
				pointerId: 1,
				clientX: 136,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			let currentWeights = getWeights();
			assertClose(currentWeights[0]!, 3.0, 'weight 0');
			assertClose(currentWeights[1]!, 2.0, 'weight 1');
			assertClose(currentWeights[2]!, 5.0, 'weight 2');
			assertClose(currentWeights[0]! + currentWeights[1]!, 5.0, 'pair total');

			// 2. Second pointer conflict: pointer 2 attempts to down/move
			const btn1 = boundaryButtons()[1]!;
			btn1.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointerdown', {
				pointerId: 2,
				clientX: 200,
				button: 0,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			assert.equal(btn1.hasPointerCapture(2), false, 'Second pointer must be rejected and not captured');

			btn1.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointermove', {
				pointerId: 2,
				clientX: 250,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			currentWeights = getWeights();
			assertClose(currentWeights[0]!, 3.0);
			assertClose(currentWeights[1]!, 2.0);
			assertClose(currentWeights[2]!, 5.0);

			// Pointer 2 up must not break pointer 1 ownership
			btn1.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointerup', {
				pointerId: 2,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			assert.ok(btn0.hasPointerCapture(1), 'Pointer 1 capture must remain active after pointer 2 up');

			// Complete pointer 1 gesture cleanly
			btn0.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointerup', {
				pointerId: 1,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			assert.equal(btn0.hasPointerCapture(1), false, 'Pointer 1 capture must be released on pointerup');

			// Subsequent new gesture works properly
			btn0.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointerdown', {
				pointerId: 3,
				clientX: 136,
				button: 0,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			assert.ok(btn0.hasPointerCapture(3), 'Subsequent pointer 3 must be captured');

			// 3. Window blur cancels active pointer capture
			win.dispatchEvent(new win.Event('blur'));
			api.flushSync();
			assert.equal(btn0.hasPointerCapture(3), false, 'Window blur must cancel drag and release pointer capture');

			// Late pointer 3 move after blur cancellation must not mutate weights
			btn0.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointermove', {
				pointerId: 3,
				clientX: 180,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			currentWeights = getWeights();
			assertClose(currentWeights[0]!, 3.0);
			assertClose(currentWeights[1]!, 2.0);
			assertClose(currentWeights[2]!, 5.0);

			// 4. Pointercancel cancels active drag
			btn0.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointerdown', {
				pointerId: 4,
				clientX: 136,
				button: 0,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			assert.ok(btn0.hasPointerCapture(4), 'Pointer 4 must be captured');

			btn0.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointercancel', {
				pointerId: 4,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			assert.equal(btn0.hasPointerCapture(4), false, 'pointercancel must release pointer capture and cancel drag');

			// Late move after pointercancel is ignored
			btn0.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointermove', {
				pointerId: 4,
				clientX: 180,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			currentWeights = getWeights();
			assertClose(currentWeights[0]!, 3.0);
			assertClose(currentWeights[1]!, 2.0);

			// 5. External lostpointercapture recovery: releasing capture externally recovers state
			btn0.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointerdown', {
				pointerId: 5,
				clientX: 136,
				button: 0,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			assert.ok(btn0.hasPointerCapture(5), 'Pointer 5 must be captured');

			// External release triggers lostpointercapture
			btn0.releasePointerCapture(5);
			api.flushSync();
			assert.equal(btn0.hasPointerCapture(5), false, 'Pointer 5 capture released');

			// Subsequent gesture after lostpointercapture works without getting stuck
			btn0.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointerdown', {
				pointerId: 6,
				clientX: 136,
				button: 0,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			assert.ok(btn0.hasPointerCapture(6), 'Subsequent pointer 6 must be captured successfully');

			// Clean up pointer 6 via normal up
			btn0.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointerup', {
				pointerId: 6,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();

			// 6. Locked cancels drag and late move cannot mutate
			btn0.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointerdown', {
				pointerId: 7,
				clientX: 136,
				button: 0,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			assert.ok(btn0.hasPointerCapture(7), 'Pointer 7 must be captured');

			controller.setLocked(true);
			await api.tick();
			api.flushSync();
			assert.equal(btn0.hasPointerCapture(7), false, 'Setting locked=true must cancel drag and release capture');

			btn0.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointermove', {
				pointerId: 7,
				clientX: 180,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			currentWeights = getWeights();
			assertClose(currentWeights[0]!, 3.0);
			assertClose(currentWeights[1]!, 2.0);

			// Unlock
			controller.setLocked(false);
			await api.tick();
			api.flushSync();

			// 7. Inactive cancels drag
			btn0.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointerdown', {
				pointerId: 8,
				clientX: 136,
				button: 0,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			assert.ok(btn0.hasPointerCapture(8), 'Pointer 8 must be captured');

			controller.setActive(false);
			await api.tick();
			api.flushSync();
			assert.equal(btn0.hasPointerCapture(8), false, 'Setting active=false must cancel drag and release capture');

			controller.setActive(true);
			await api.tick();
			api.flushSync();

			// 8. New sessionKey cancels drag and late move cannot mutate new draft
			btn0.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointerdown', {
				pointerId: 9,
				clientX: 136,
				button: 0,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			assert.ok(btn0.hasPointerCapture(9), 'Pointer 9 must be captured before session switch');

			const newDraft: TableDraft = {
				rows: 1,
				columns: 2,
				cells: ['X', 'Y'],
				weights: [1, 1],
				width: 100,
				style: 'three-line',
				rules: 'hline',
				header: true,
				caption: { position: 'none', text: '' }
			};
			controller.setSession('drag-session-2', newDraft);
			await api.tick();
			api.flushSync();
			assert.equal(btn0.hasPointerCapture(9), false, 'New sessionKey must cancel drag and release capture');
			currentWeights = getWeights();
			assertClose(currentWeights[0]!, 1.0);
			assertClose(currentWeights[1]!, 1.0);

			// Late move from old pointer 9 must NOT mutate the new draft!
			btn0.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointermove', {
				pointerId: 9,
				clientX: 200,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			currentWeights = getWeights();
			assertClose(currentWeights[0]!, 1.0);
			assertClose(currentWeights[1]!, 1.0);

			// 9. Keyboard resize on boundary button with ArrowLeft/ArrowRight and Shift
			const newBtn0 = boundaryButtons()[0]!;
			assert.ok(newBtn0, 'Boundary button for 2-column draft must exist');
			currentWeights = getWeights();
			assertClose(currentWeights[0]!, 1.0);
			assertClose(currentWeights[1]!, 1.0);

			// ArrowRight without modifier: step = +0.01 * 2 = +0.02
			newBtn0.dispatchEvent(new (win as unknown as { KeyboardEvent: typeof Event }).KeyboardEvent('keydown', {
				key: 'ArrowRight',
				shiftKey: false,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			currentWeights = getWeights();
			assertClose(currentWeights[0]!, 1.02, 'ArrowRight weight 0');
			assertClose(currentWeights[1]!, 0.98, 'ArrowRight weight 1');
			assertClose(currentWeights[0]! + currentWeights[1]!, 2.0, 'ArrowRight pair total');

			// Shift+ArrowRight: step = +0.05 * 2 = +0.10
			newBtn0.dispatchEvent(new (win as unknown as { KeyboardEvent: typeof Event }).KeyboardEvent('keydown', {
				key: 'ArrowRight',
				shiftKey: true,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			currentWeights = getWeights();
			assertClose(currentWeights[0]!, 1.12, 'Shift+ArrowRight weight 0');
			assertClose(currentWeights[1]!, 0.88, 'Shift+ArrowRight weight 1');
			assertClose(currentWeights[0]! + currentWeights[1]!, 2.0, 'Shift+ArrowRight pair total');

			// ArrowLeft without modifier: step = -0.01 * 2 = -0.02
			newBtn0.dispatchEvent(new (win as unknown as { KeyboardEvent: typeof Event }).KeyboardEvent('keydown', {
				key: 'ArrowLeft',
				shiftKey: false,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			currentWeights = getWeights();
			assertClose(currentWeights[0]!, 1.10, 'ArrowLeft weight 0');
			assertClose(currentWeights[1]!, 0.90, 'ArrowLeft weight 1');
			assertClose(currentWeights[0]! + currentWeights[1]!, 2.0, 'ArrowLeft pair total');

			// Ignored keys: capture pre-event state exactly, verify no mutation
			const preIgnoredWeights = getWeights();
			for (const ignoredEvent of [
				{ key: 'ArrowRight', isComposing: true },
				{ key: 'ArrowRight', ctrlKey: true },
				{ key: 'ArrowRight', altKey: true },
				{ key: 'ArrowRight', metaKey: true },
				{ key: 'Space' },
				{ key: 'Enter' }
			]) {
				newBtn0.dispatchEvent(new (win as unknown as { KeyboardEvent: typeof Event }).KeyboardEvent('keydown', {
					...ignoredEvent,
					bubbles: true
				} as unknown as EventInit));
				api.flushSync();
				const postIgnoredWeights = getWeights();
				assert.deepEqual(postIgnoredWeights, preIgnoredWeights, `Ignored key ${JSON.stringify(ignoredEvent)} must not change weights`);
			}

			// 10. Bounded limits: repeatedly pressing Shift+ArrowRight cannot violate minimum floor
			for (let i = 0; i < 30; i++) {
				newBtn0.dispatchEvent(new (win as unknown as { KeyboardEvent: typeof Event }).KeyboardEvent('keydown', {
					key: 'ArrowRight',
					shiftKey: true,
					bubbles: true
				} as unknown as EventInit));
				api.flushSync();
			}
			const boundedWeights = getWeights();
			assertClose(boundedWeights[0]! + boundedWeights[1]!, 2.0, 'Pair total must stay conserved at boundary');
			assert.ok(boundedWeights[1]! >= 2 * 0.05, 'Right column cannot fall below pair * 0.05 floor');

			// 11. Verify emitted table source reflects normalized column shares via parseTable
			const insertBtn = panel.querySelector<HTMLButtonElement>('.actions button.primary');
			assert.ok(insertBtn);
			insertBtn.click();
			api.flushSync();

			assert.equal(emittedSources.length, 1, 'Emitted source must be recorded');
			const parsed = parseTable(emittedSources[0]!);
			assert.ok(parsed, 'Emitted LaTeX source must parse via actual parseTable');

			// Compare normalized column shares: parsed.weights divided by its sum versus columnPercentages / 100
			const expectedNormalized = columnPercentages({
				rows: 1,
				columns: 2,
				cells: ['X', 'Y'],
				weights: boundedWeights,
				width: 100,
				style: 'three-line',
				header: true,
				caption: { position: 'none', text: '' }
			}).map((p) => p / 100);

			const parsedSum = parsed.weights.reduce((s, w) => s + w, 0);
			const parsedNormalized = parsed.weights.map((w) => w / parsedSum);

			// Serializer uses six-decimal fraction formatting (.toFixed(6)), so compare within 1e-5
			for (let i = 0; i < parsedNormalized.length; i++) {
				assert.ok(
					Math.abs(parsedNormalized[i]! - expectedNormalized[i]!) <= 1e-5,
					`Column share ${i}: expected ~${expectedNormalized[i]}, got ${parsedNormalized[i]}`
				);
			}

			// 12. Real unmount DURING active capture: retain old button, assert release capture and late move isolation
			const activeBtn = boundaryButtons()[0]!;
			activeBtn.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointerdown', {
				pointerId: 99,
				clientX: 100,
				button: 0,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			assert.ok(activeBtn.hasPointerCapture(99), 'Pointer 99 must be captured before unmount');

			// Unmount while capture is active
			await api.unmount(mounted);
			mounted = undefined;
			api.flushSync();

			// Component onDestroy must have executed cancelDrag() which released capture on activeBtn
			assert.equal(activeBtn.hasPointerCapture(99), false, 'Component unmount must release pointer capture');

			// Late move on retained old button cannot publish or throw
			const publicationsBeforeLateMove = emittedSources.length;
			activeBtn.dispatchEvent(new (win as unknown as { PointerEvent: typeof Event }).PointerEvent('pointermove', {
				pointerId: 99,
				clientX: 150,
				bubbles: true
			} as unknown as EventInit));
			api.flushSync();
			assert.equal(emittedSources.length, publicationsBeforeLateMove, 'Detached late move must not publish table source');
		} finally {
			if (mounted !== undefined) {
				await api.unmount(mounted);
				api.flushSync();
			}
		}

		assert.equal(container.querySelector('.table-panel'), null, 'Unmount must clean up TablePanel from DOM');
	}
);
