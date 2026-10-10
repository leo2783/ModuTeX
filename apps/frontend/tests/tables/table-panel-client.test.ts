import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { build } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createTable, parseTable, tableSource } from '../../src/features/tables/source.ts';

type DOMWindow = Window & typeof globalThis & { close(): void };
type Locale = 'zh-Hant' | 'en';
type PanelController = {
	setLocale: (locale: Locale) => void;
	setActive: (active: boolean) => void;
	setLocked: (locked: boolean) => void;
};
type ClientModule = {
	mount: (component: unknown, options: { target: HTMLElement; props: Record<string, unknown> }) => unknown;
	unmount: (instance: unknown, options?: { outro?: boolean }) => Promise<void>;
	flushSync: (fn?: () => void) => void;
	tick: () => Promise<void>;
	TablePanelHarness: unknown;
};
type Insertion = { source: string; booktabs: boolean | undefined };

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
let originalConfirmDescriptor: PropertyDescriptor | undefined;
let confirmDescriptorCaptured = false;
let originalMatchMediaDescriptor: PropertyDescriptor | undefined;
let matchMediaDescriptorCaptured = false;

const confirmationMessages: string[] = [];
const confirmationChoices: boolean[] = [];
let unexpectedConfirmationCalls = 0;

function restoreGlobals(): void {
	for (const [key, descriptor] of previousDescriptors) {
		try {
			if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
			else Object.defineProperty(globalThis, key, descriptor);
		} catch {
			// Continue restoring the remaining globals.
		}
	}
	previousDescriptors.clear();
}

function restoreWindowProperty(win: DOMWindow, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor === undefined) Reflect.deleteProperty(win, key);
	else Object.defineProperty(win, key, descriptor);
}

function cleanup(): void {
	if (dom) {
		const win = dom.window;
		if (confirmDescriptorCaptured) {
			try {
				restoreWindowProperty(win, 'confirm', originalConfirmDescriptor);
			} catch {
				// Continue cleanup if a host property cannot be restored.
			}
			confirmDescriptorCaptured = false;
		}
		if (matchMediaDescriptorCaptured) {
			try {
				restoreWindowProperty(win, 'matchMedia', originalMatchMediaDescriptor);
			} catch {
				// Continue cleanup if a host property cannot be restored.
			}
			matchMediaDescriptorCaptured = false;
		}
		try {
			win.close();
		} catch {
			// Still restore globals and remove the isolated build directory.
		}
		dom = null;
	}
	restoreGlobals();
	if (tempDir) {
		fs.rmSync(tempDir, { recursive: true, force: true });
		tempDir = null;
	}
	confirmationMessages.length = 0;
	confirmationChoices.length = 0;
	unexpectedConfirmationCalls = 0;
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
		'HTMLFieldSetElement',
		'HTMLTextAreaElement',
		'HTMLPreElement',
		'HTMLSpanElement',
		'HTMLTableElement',
		'HTMLTableSectionElement',
		'HTMLTableRowElement',
		'HTMLTableCellElement',
		'HTMLLegendElement',
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
	] as const;

	for (const key of explicitDomKeys) {
		previousDescriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		if (key in win) {
			const value = (win as unknown as Record<string, unknown>)[key];
			Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
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

	class JSDOMMediaQueryList extends EventTarget implements MediaQueryList {
		readonly media: string;
		readonly matches = false;
		onchange: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null = null;

		constructor(query: string) {
			super();
			this.media = query;
		}

		addListener(callback: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null): void {
			if (callback) this.addEventListener('change', callback as unknown as EventListener);
		}

		removeListener(callback: ((this: MediaQueryList, event: MediaQueryListEvent) => void) | null): void {
			if (callback) this.removeEventListener('change', callback as unknown as EventListener);
		}
	}

	originalMatchMediaDescriptor = Object.getOwnPropertyDescriptor(win, 'matchMedia');
	matchMediaDescriptorCaptured = true;
	Object.defineProperty(win, 'matchMedia', {
		value: (query: string) => new JSDOMMediaQueryList(query),
		writable: true,
		configurable: true
	});
}

function installConfirmationObserver(win: DOMWindow): void {
	originalConfirmDescriptor = Object.getOwnPropertyDescriptor(win, 'confirm');
	confirmDescriptorCaptured = true;
	Object.defineProperty(win, 'confirm', {
		value: (message?: string): boolean => {
			confirmationMessages.push(message ?? '');
			const choice = confirmationChoices.shift();
			if (choice === undefined) {
				unexpectedConfirmationCalls++;
				throw new Error('No explicit test user response was queued for window.confirm');
			}
			return choice;
		},
		writable: true,
		configurable: true
	});
}

function assertNoConfirmationSince(start: number): void {
	assert.equal(unexpectedConfirmationCalls, 0, 'Every window.confirm call must have an explicit test response');
	assert.deepEqual(confirmationMessages.slice(start), [], 'This operation must not request confirmation');
	assert.equal(confirmationChoices.length, 0, 'No test user response should be left unused');
}

function assertConfirmationSince(start: number, expectedMessage: string): void {
	assert.equal(unexpectedConfirmationCalls, 0, 'Every window.confirm call must have an explicit test response');
	assert.deepEqual(confirmationMessages.slice(start), [expectedMessage]);
	assert.equal(confirmationChoices.length, 0, 'The component must consume the explicit user response');
}

test.after(() => {
	cleanup();
});

test.before(
	async () => {
		confirmationMessages.length = 0;
		confirmationChoices.length = 0;
		unexpectedConfirmationCalls = 0;

		const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'table-panel-client-'));
		tempDir = buildDir;
		const harnessFile = path.join(buildDir, 'TablePanelHarness.svelte');
		const entryFile = path.join(buildDir, 'entry.js');
		const normalizedHarnessFile = harnessFile.replaceAll('\\', '/');

		fs.writeFileSync(
			harnessFile,
			`<script lang="ts">
	import TablePanel from ${JSON.stringify(tablePanelPath)};
	type Locale = 'zh-Hant' | 'en';
	type Controller = {
		setLocale: (locale: Locale) => void;
		setActive: (active: boolean) => void;
		setLocked: (locked: boolean) => void;
	};
	let { initialLocale = 'zh-Hant', onInsert, onClose, onPanelController } = $props<{
		initialLocale?: Locale;
		onInsert: (source: string, booktabs?: boolean) => void;
		onClose: () => void;
		onPanelController: (controller: Controller) => void;
	}>();
	let locale = $state<Locale>(initialLocale);
	let active = $state(true);
	let locked = $state(false);
	onPanelController({
		setLocale: (next: Locale) => { locale = next; },
		setActive: (next: boolean) => { active = next; },
		setLocked: (next: boolean) => { locked = next; }
	});
</script>

<TablePanel {active} {locked} {locale} {onInsert} {onClose} />
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
			cacheDir: path.join(buildDir, '.vite-cache'),
			plugins: [svelte()],
			resolve: { conditions: ['browser', 'default'] },
			build: {
				write: true,
				outDir: buildDir,
				emptyOutDir: false,
				lib: {
					entry: entryFile,
					formats: ['es'],
					fileName: () => 'table-panel-client.mjs'
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
		installConfirmationObserver(dom.window);

		const bundleUrl = pathToFileURL(path.join(buildDir, 'table-panel-client.mjs')).href;
		client = (await import(bundleUrl)) as ClientModule;
	},
	{ timeout: 120_000 }
);

test(
	'TablePanel client serializes table settings, confirms destructive edits, localizes, and disables controls',
	{ timeout: 30_000 },
	async () => {
		assert.ok(dom, 'The JSDOM browser environment must be initialized');
		assert.ok(client, 'The actual Vite-built Svelte client must be loaded');
		const win = dom.window;
		const api = client;
		const container = win.document.getElementById('app');
		assert.ok(container);

		const insertions: Insertion[] = [];
		let closeCalls = 0;
		let controller: PanelController | undefined;
		let mounted: unknown;
		try {
			mounted = api.mount(api.TablePanelHarness, {
				target: container,
				props: {
					initialLocale: 'zh-Hant',
					onInsert: (source: string, booktabs?: boolean) => insertions.push({ source, booktabs }),
					onClose: () => { closeCalls++; },
					onPanelController: (value: PanelController) => { controller = value; }
				}
			});
			api.flushSync();
			await api.tick();
			await api.tick();
			api.flushSync();

			const panelElement = container.querySelector<HTMLElement>('.table-panel');
			assert.ok(panelElement, 'The actual TablePanel client component must render');
			const panel: HTMLElement = panelElement;
			assert.ok(controller, 'The harness must expose reactive panel controls');
			const panelControl = controller;
			let currentLocale: Locale = 'zh-Hant';

			const cellLabel = (row: number, column: number, locale: Locale): string =>
				locale === 'en' ? `Row ${row}, column ${column}` : `第 ${row} 行，第 ${column} 列`;
			function cellControl(row: number, column: number, locale = currentLocale): HTMLInputElement {
				const input = Array.from(panel.querySelectorAll<HTMLInputElement>('tbody td input'))
					.find((candidate) => candidate.getAttribute('aria-label') === cellLabel(row, column, locale));
				assert.ok(input, `Expected row ${row}, column ${column} cell input`);
				return input;
			}
			function assertLocalized(locale: Locale): void {
				const english = locale === 'en';
				assert.equal(panel.getAttribute('aria-label'), english ? 'Insert table' : '插入表格');
				assert.equal(panel.querySelector('.header h2')?.textContent, english ? 'Table' : '表格');
				assert.equal(panel.querySelector('.header button')?.textContent?.trim(), english ? 'Close' : '關閉');
				assert.equal(
					panel.querySelector('.row-tools')?.getAttribute('aria-label'),
					english ? 'Row and column actions for selected cell' : '所選儲存格的行列操作'
				);
				assert.equal(cellControl(1, 1, locale).getAttribute('aria-label'), cellLabel(1, 1, locale));
			}
			async function changeLocale(locale: Locale): Promise<void> {
				currentLocale = locale;
				panelControl.setLocale(locale);
				api.flushSync();
				await api.tick();
				api.flushSync();
				assertLocalized(locale);
			}

			const optionSelects = (): HTMLSelectElement[] =>
				Array.from(panel.querySelectorAll<HTMLSelectElement>('.options select'));
			function selectValue(select: HTMLSelectElement, value: string): void {
				assert.ok(Array.from(select.options).some((option) => option.value === value), `Expected option ${value}`);
				select.value = value;
				select.dispatchEvent(new win.Event('change', { bubbles: true }));
				api.flushSync();
			}
			function captionSelect(): HTMLSelectElement {
				const select = optionSelects().at(-1);
				assert.ok(select, 'The caption position control must be rendered');
				return select;
			}
			function setCaption(value: string): void {
				const input = panel.querySelector<HTMLInputElement>('.caption input');
				assert.ok(input, 'A caption input must be rendered for above/below captions');
				input.value = value;
				input.dispatchEvent(new win.Event('input', { bubbles: true }));
				api.flushSync();
			}
			function insertCurrent(): void {
				const button = panel.querySelector<HTMLButtonElement>('.actions button.primary');
				assert.ok(button, 'The table insert button must be rendered');
				const before = insertions.length;
				button.click();
				api.flushSync();
				assert.equal(insertions.length, before + 1, 'Insert must emit exactly one source');
			}
			function inspectEmission(index: number): { emitted: Insertion; parsed: NonNullable<ReturnType<typeof parseTable>> } {
				const emitted = insertions[index];
				assert.ok(emitted, `Expected emitted table source at index ${index}`);
				const parsed = parseTable(emitted.source);
				assert.ok(parsed, 'The emitted source must be accepted by the table parser');
				assert.equal(tableSource(parsed), emitted.source, 'The real serializer must round-trip parsed emitted source');
				return { emitted, parsed };
			}

			assertLocalized('zh-Hant');
			await changeLocale('en');

			// No caption is serialized by default.
			assert.equal(panel.querySelector('.caption'), null);
			insertCurrent();
			const none = inspectEmission(0);
			assert.equal(none.emitted.source, tableSource(createTable()));
			assert.equal(none.emitted.booktabs, false);
			assert.equal(none.parsed.caption.position, 'none');
			assert.equal(none.parsed.style, 'three-line');
			assert.ok(!none.emitted.source.includes(String.raw`\caption{`));

			// Above and below captions are entered through the actual input event and retain literal text.
			selectValue(captionSelect(), 'above');
			setCaption('Above & title');
			insertCurrent();
			const above = inspectEmission(1);
			assert.equal(above.parsed.caption.position, 'above');
			assert.equal(above.parsed.caption.text, 'Above & title');
			assert.equal(above.emitted.booktabs, false);
			assert.ok(above.emitted.source.includes(String.raw`\caption{Above \& title}`));
			assert.ok(
				above.emitted.source.indexOf(String.raw`\caption{`) <
					above.emitted.source.indexOf(String.raw`\begin{tabular}`)
			);

			selectValue(captionSelect(), 'below');
			setCaption('Below _ caption');
			insertCurrent();
			const below = inspectEmission(2);
			assert.equal(below.parsed.caption.position, 'below');
			assert.equal(below.parsed.caption.text, 'Below _ caption');
			assert.ok(below.emitted.source.includes(String.raw`\caption{Below \_ caption}`));
			assert.ok(
				below.emitted.source.indexOf(String.raw`\caption{`) >
					below.emitted.source.indexOf(String.raw`\end{tabular}`)
			);

			selectValue(captionSelect(), 'none');
			insertCurrent();
			const noCaptionAgain = inspectEmission(3);
			assert.equal(noCaptionAgain.parsed.caption.position, 'none');
			assert.ok(!noCaptionAgain.emitted.source.includes(String.raw`\caption{`));

			// Exercise all supported visual styles through the rendered select controls.
			const styleSelect = (): HTMLSelectElement => {
				const select = optionSelects()[0];
				assert.ok(select, 'The style control must be rendered');
				return select;
			};
			selectValue(styleSelect(), 'full');
			insertCurrent();
			const full = inspectEmission(4);
			assert.equal(full.parsed.style, 'full');
			assert.equal(full.emitted.booktabs, false);
			assert.ok(full.emitted.source.includes(String.raw`\begin{tabular}{|`));

			selectValue(styleSelect(), 'horizontal');
			insertCurrent();
			const horizontal = inspectEmission(5);
			assert.equal(horizontal.parsed.style, 'horizontal');
			assert.equal(horizontal.emitted.booktabs, false);

			selectValue(styleSelect(), 'three-line');
			const rulesSelect = optionSelects().find((select) =>
				Array.from(select.options).some((option) => option.value === 'booktabs')
			);
			assert.ok(rulesSelect, 'The three-line rules control must be rendered');
			selectValue(rulesSelect, 'booktabs');
			insertCurrent();
			const booktabs = inspectEmission(6);
			assert.equal(booktabs.parsed.style, 'three-line');
			assert.equal(booktabs.parsed.rules, 'booktabs');
			assert.equal(booktabs.emitted.booktabs, true);
			assert.ok(booktabs.emitted.source.includes(String.raw`\toprule`));
			assert.ok(booktabs.emitted.source.includes(String.raw`\midrule`));
			assert.ok(booktabs.emitted.source.includes(String.raw`\bottomrule`));

			// A valid width is kept when invalid and out-of-range values are submitted.
			function widthControl(): HTMLInputElement {
				const input = panel.querySelector<HTMLInputElement>('.options input[type="number"]');
				assert.ok(input, 'The table width input must be rendered');
				return input;
			}
			function setWidth(value: string): void {
				const input = widthControl();
				input.value = value;
				input.dispatchEvent(new win.Event('change', { bubbles: true }));
				api.flushSync();
			}
			setWidth('55');
			assert.equal(widthControl().value, '55');
			assert.equal(panel.querySelector('[role="alert"]'), null);
			const widthEmissionIndex = insertions.length;
			insertCurrent();
			const widthEmission = inspectEmission(widthEmissionIndex);
			assert.ok(Math.abs(widthEmission.parsed.width - 55) < 0.01);

			for (const invalid of ['0', '101', 'not-a-number']) {
				setWidth(invalid);
				assert.equal(widthControl().value, '55');
				assert.equal(panel.querySelector('[role="alert"]')?.textContent, 'Enter a width from 1 to 100.');
			}
			setWidth('62');
			assert.equal(widthControl().value, '62');
			assert.equal(panel.querySelector('[role="alert"]'), null, 'A valid width must clear the error');
			setWidth('101');
			assert.equal(widthControl().value, '62', 'An out-of-range width must preserve the last valid value');
			assert.equal(panel.querySelector('[role="alert"]')?.textContent, 'Enter a width from 1 to 100.');

			await changeLocale('zh-Hant');
			assert.equal(panel.querySelector('[role="alert"]')?.textContent, '寬度請輸入 1 到 100。');
			await changeLocale('en');
			assert.equal(panel.querySelector('[role="alert"]')?.textContent, 'Enter a width from 1 to 100.');
			setWidth('62');
			assert.equal(panel.querySelector('[role="alert"]'), null);

			// Fill a real grid, focus a selected cell, and insert rows/columns on both sides of it.
			const initialGrid = [
				['A', 'B', 'C'],
				['D', 'E', 'F'],
				['G', 'H', 'I']
			];
			for (let row = 0; row < initialGrid.length; row++) {
				for (let column = 0; column < initialGrid[row]!.length; column++) {
					const input = cellControl(row + 1, column + 1);
					input.value = initialGrid[row]![column]!;
					input.dispatchEvent(new win.Event('input', { bubbles: true }));
					api.flushSync();
				}
			}
			function assertGrid(expected: string[][]): void {
				const actual = Array.from(panel.querySelectorAll<HTMLTableRowElement>('tbody tr'), (tr) =>
					Array.from(tr.querySelectorAll<HTMLInputElement>('td input'), (input) => input.value)
				);
				assert.deepEqual(actual, expected);
			}
			function actionButton(label: string): HTMLButtonElement {
				const button = Array.from(panel.querySelectorAll<HTMLButtonElement>('.row-tools button'))
					.find((candidate) => candidate.textContent?.trim() === label);
				assert.ok(button, `Expected row/column action: ${label}`);
				return button;
			}
			function focusCell(row: number, column: number): void {
				cellControl(row, column).focus();
				api.flushSync();
			}

			assertGrid(initialGrid);
			const insertionsConfirmationStart = confirmationMessages.length;
			focusCell(2, 2);
			actionButton('Insert row above').click();
			api.flushSync();
			const afterRowAbove = [
				['A', 'B', 'C'],
				['', '', ''],
				['D', 'E', 'F'],
				['G', 'H', 'I']
			];
			assertGrid(afterRowAbove);

			focusCell(3, 2);
			actionButton('Insert row below').click();
			api.flushSync();
			const afterRowBelow = [
				['A', 'B', 'C'],
				['', '', ''],
				['D', 'E', 'F'],
				['', '', ''],
				['G', 'H', 'I']
			];
			assertGrid(afterRowBelow);

			focusCell(3, 2);
			actionButton('Insert column left').click();
			api.flushSync();
			const afterColumnLeft = [
				['A', '', 'B', 'C'],
				['', '', '', ''],
				['D', '', 'E', 'F'],
				['', '', '', ''],
				['G', '', 'H', 'I']
			];
			assertGrid(afterColumnLeft);

			focusCell(3, 3);
			actionButton('Insert column right').click();
			api.flushSync();
			const afterAllInsertions = [
				['A', '', 'B', '', 'C'],
				['', '', '', '', ''],
				['D', '', 'E', '', 'F'],
				['', '', '', '', ''],
				['G', '', 'H', '', 'I']
			];
			assertGrid(afterAllInsertions);
			assertNoConfirmationSince(insertionsConfirmationStart);

			// Declining then accepting a nonempty row deletion must preserve unaffected cells.
			const confirmationMessage = 'Deleting removes the content in this row or column. Continue?';
			focusCell(3, 3);
			const rejectRowStart = confirmationMessages.length;
			confirmationChoices.push(false);
			actionButton('Delete this row').click();
			api.flushSync();
			assertConfirmationSince(rejectRowStart, confirmationMessage);
			assertGrid(afterAllInsertions);

			const acceptRowStart = confirmationMessages.length;
			confirmationChoices.push(true);
			actionButton('Delete this row').click();
			api.flushSync();
			assertConfirmationSince(acceptRowStart, confirmationMessage);
			const afterAcceptedRowDelete = [
				['A', '', 'B', '', 'C'],
				['', '', '', '', ''],
				['', '', '', '', ''],
				['G', '', 'H', '', 'I']
			];
			assertGrid(afterAcceptedRowDelete);
			assert.equal(panel.querySelector('[role="alert"]'), null);

			// The same explicit reject/accept path for a nonempty column retains other column data.
			focusCell(1, 1);
			const rejectColumnStart = confirmationMessages.length;
			confirmationChoices.push(false);
			actionButton('Delete this column').click();
			api.flushSync();
			assertConfirmationSince(rejectColumnStart, confirmationMessage);
			assertGrid(afterAcceptedRowDelete);

			const acceptColumnStart = confirmationMessages.length;
			confirmationChoices.push(true);
			actionButton('Delete this column').click();
			api.flushSync();
			assertConfirmationSince(acceptColumnStart, confirmationMessage);
			const afterAcceptedColumnDelete = [
				['', 'B', '', 'C'],
				['', '', '', ''],
				['', '', '', ''],
				['', 'H', '', 'I']
			];
			assertGrid(afterAcceptedColumnDelete);

			// A disabled fieldset makes every panel control effectively disabled for both prop states.
			function assertDisabledControls(): void {
				const fieldset = panel.querySelector<HTMLFieldSetElement>('fieldset');
				assert.ok(fieldset);
				assert.equal(fieldset.disabled, true);
				const controls = Array.from(fieldset.querySelectorAll<HTMLElement>('button, input, select'));
				assert.ok(controls.length > 0);
				assert.ok(controls.every((control) => control.matches(':disabled')), 'Every fieldset control must be disabled');
				assert.equal(panel.querySelector('.header button')?.matches(':disabled'), false);
			}
			const disabledConfirmationStart = confirmationMessages.length;
			const disabledInsertionCount = insertions.length;
			panelControl.setLocked(true);
			api.flushSync();
			assertDisabledControls();
			actionButton('Insert row above').click();
			(panel.querySelector<HTMLButtonElement>('.actions button.primary'))!.click();
			api.flushSync();
			assertGrid(afterAcceptedColumnDelete);
			assert.equal(insertions.length, disabledInsertionCount);

			panelControl.setLocked(false);
			panelControl.setActive(false);
			api.flushSync();
			assertDisabledControls();
			actionButton('Insert row above').click();
			(panel.querySelector<HTMLButtonElement>('.actions button.primary'))!.click();
			api.flushSync();
			assertGrid(afterAcceptedColumnDelete);
			assert.equal(insertions.length, disabledInsertionCount);
			assertNoConfirmationSince(disabledConfirmationStart);

			assert.deepEqual(confirmationMessages, Array(4).fill(confirmationMessage));
			assert.equal(confirmationChoices.length, 0);
			assert.equal(unexpectedConfirmationCalls, 0);
			assert.equal(closeCalls, 0);
		} finally {
			if (mounted !== undefined) {
				await api.unmount(mounted);
				api.flushSync();
			}
		}

		assert.equal(container.querySelector('.table-panel'), null, 'Unmount must remove the client-rendered panel');
	}
);
