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
type Locale = 'zh-Hant' | 'en';
type PanelKind = 'equation' | 'matrix';
type EquationDraft = { readonly latex: string; readonly inline: boolean };
type MatrixDraft = { readonly rows: number; readonly columns: number; readonly cells: readonly string[] };
type PanelController = {
	setActive: (active: boolean) => void;
	setKind: (kind: PanelKind) => void;
	setSessionKey: (key: string) => void;
	setInitialDraft: (draft: EquationDraft | null) => void;
	setLocale: (locale: Locale) => void;
	setShowSource: (showSource: boolean) => void;
};
type ClientModule = {
	mount: (component: unknown, options: { target: HTMLElement; props: Record<string, unknown> }) => unknown;
	unmount: (instance: unknown, options?: { outro?: boolean }) => Promise<void>;
	flushSync: (fn?: () => void) => void;
	tick: () => Promise<void>;
	MathPanelHarness: unknown;
	LifecycleMathPanelHarness: unknown;
	equationSource: (value: string, inline: boolean) => string;
	matrixSource: (matrix: MatrixDraft, brackets: 'parentheses' | 'square' | 'none') => string;
};

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom') as {
	JSDOM: new (html?: string, options?: { url?: string }) => { window: DOMWindow };
};
const frontendRoot = fileURLToPath(new URL('../../', import.meta.url));
const mathPanelPath = fileURLToPath(new URL('../../src/features/math/MathPanel.svelte', import.meta.url)).replaceAll('\\', '/');
const mathSourcePath = fileURLToPath(new URL('../../src/features/math/source.ts', import.meta.url)).replaceAll('\\', '/');

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

function restoreWindowProperty(win: DOMWindow, key: string, descriptor: PropertyDescriptor | undefined): void {
	if (descriptor === undefined) {
		Reflect.deleteProperty(win, key);
	} else {
		Object.defineProperty(win, key, descriptor);
	}
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
			// Ignore close errors while still restoring globals and temporary files.
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

function assertLocalizedLabels(panel: HTMLElement, locale: Locale): void {
	const english = locale === 'en';
	assert.equal(panel.getAttribute('aria-label'), english ? 'Insert matrix' : '插入矩陣');
	assert.equal(panel.querySelector('.panel-header h2')?.textContent, english ? 'Matrix' : '矩陣');
	assert.equal(panel.querySelector('.panel-header button')?.textContent?.trim(), english ? 'Close' : '關閉');
	assert.deepEqual(
		Array.from(panel.querySelectorAll('.dimensions > label'), (label) => {
			const caption = label.cloneNode(true) as HTMLElement;
			caption.querySelectorAll('input, select').forEach((control) => control.remove());
			return caption.textContent?.trim();
		}),
		english ? ['n×n', 'Rows', 'Columns', 'Brackets'] : ['n×n', '行', '列', '括號']
	);

	const bracketSelect = panel.querySelector<HTMLSelectElement>('.dimensions select');
	assert.ok(bracketSelect);
	assert.deepEqual(
		Array.from(bracketSelect.options, (option) => option.textContent?.trim()),
		english ? ['Parentheses', 'Square brackets', 'None'] : ['圓括號', '方括號', '無括號']
	);
	assert.equal(panel.querySelector('.inline-option')?.textContent?.trim(), english ? 'Inline equation' : '行內公式');
	assert.equal(
		panel.querySelector<HTMLInputElement>('.matrix-grid input')?.getAttribute('aria-label'),
		english ? 'Row 1, column 1' : '第 1 行，第 1 列'
	);
	assert.equal(
		panel.querySelector('.panel-actions button:not(.primary)')?.textContent?.trim(),
		english ? 'Cancel' : '取消'
	);
	assert.equal(panel.querySelector('.panel-actions button.primary')?.textContent?.trim(), english ? 'Insert' : '插入');
}

function assertDimensionError(panel: HTMLElement, locale: Locale): void {
	const error = panel.querySelector('[role="alert"]');
	assert.ok(error);
	assert.equal(
		error.textContent,
		locale === 'en'
			? 'Enter a whole number from 1 to 10 for rows and columns.'
			: '行列數請輸入 1 到 10 的整數。'
	);
}

function assertNoConfirmationSince(start: number): void {
	assert.equal(unexpectedConfirmationCalls, 0, 'Every window.confirm call must have an explicit test response');
	assert.deepEqual(confirmationMessages.slice(start), [], 'This resize must not request confirmation');
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
		const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-panel-client-'));
		tempDir = buildDir;
		const harnessFile = path.join(buildDir, 'MathPanelHarness.svelte');
		const lifecycleHarnessFile = path.join(buildDir, 'LifecycleMathPanelHarness.svelte');
		const entryFile = path.join(buildDir, 'entry.js');
		const normalizedHarnessFile = harnessFile.replaceAll('\\', '/');
		const normalizedLifecycleHarnessFile = lifecycleHarnessFile.replaceAll('\\', '/');

		fs.writeFileSync(
			harnessFile,
			`<script lang="ts">
	import MathPanel from ${JSON.stringify(mathPanelPath)};
	type Locale = 'zh-Hant' | 'en';
	let {
		initialLocale = 'zh-Hant',
		onInsert,
		onClose,
		onLocaleController
	} = $props<{
		initialLocale?: Locale;
		onInsert: (source: string) => void;
		onClose: () => void;
		onLocaleController: (setLocale: (nextLocale: Locale) => void) => void;
	}>();
	let locale = $state<Locale>(initialLocale);
	onLocaleController((nextLocale) => { locale = nextLocale; });
</script>

<MathPanel kind="matrix" active={true} {onInsert} {onClose} {locale} />
`
		);
		fs.writeFileSync(
			lifecycleHarnessFile,
			`<script lang="ts">
	import MathPanel from ${JSON.stringify(mathPanelPath)};
	type Locale = 'zh-Hant' | 'en';
	type Kind = 'equation' | 'matrix';
	type Draft = { readonly latex: string; readonly inline: boolean };
	type Controller = {
		setActive: (active: boolean) => void;
		setKind: (kind: Kind) => void;
		setSessionKey: (key: string) => void;
		setInitialDraft: (draft: Draft | null) => void;
		setLocale: (locale: Locale) => void;
		setShowSource: (showSource: boolean) => void;
	};
	let {
		initialKind = 'equation',
		initialActive = true,
		initialSessionKey = 'insert',
		initialDraft: initialEquationDraft = null,
		initialLocale = 'zh-Hant',
		initialShowSource = true,
		initialEditing = false,
		onInsert,
		onClose,
		onEquation,
		onController
	} = $props<{
		initialKind?: Kind;
		initialActive?: boolean;
		initialSessionKey?: string;
		initialDraft?: Draft | null;
		initialLocale?: Locale;
		initialShowSource?: boolean;
		initialEditing?: boolean;
		onInsert: (source: string) => void;
		onClose: () => void;
		onEquation?: (draft: Draft) => void;
		onController: (controller: Controller) => void;
	}>();
	let kind = $state<Kind>(initialKind);
	let active = $state(initialActive);
	let sessionKey = $state(initialSessionKey);
	let draft = $state<Draft | null>(initialEquationDraft);
	let locale = $state<Locale>(initialLocale);
	let showSource = $state(initialShowSource);
	onController({
		setActive: (next) => { active = next; },
		setKind: (next) => { kind = next; },
		setSessionKey: (next) => { sessionKey = next; },
		setInitialDraft: (next) => { draft = next; },
		setLocale: (next) => { locale = next; },
		setShowSource: (next) => { showSource = next; }
	});
	function closePanel() { active = false; onClose(); }
</script>

<MathPanel {kind} {active} {sessionKey} initialDraft={draft} {locale}
	showSource={showSource} editing={initialEditing} {onEquation}
	onInsert={onInsert} onClose={closePanel} />
`
		);
		fs.writeFileSync(
			entryFile,
			`import { mount, unmount, flushSync, tick } from 'svelte';
import MathPanelHarness from ${JSON.stringify(normalizedHarnessFile)};
import LifecycleMathPanelHarness from ${JSON.stringify(normalizedLifecycleHarnessFile)};
import { equationSource, matrixSource } from ${JSON.stringify(mathSourcePath)};
export { mount, unmount, flushSync, tick, MathPanelHarness, LifecycleMathPanelHarness, equationSource, matrixSource };
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
					fileName: () => 'math-panel-client.mjs'
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

		const bundleUrl = pathToFileURL(path.join(buildDir, 'math-panel-client.mjs')).href;
		client = (await import(bundleUrl)) as ClientModule;
	},
	{ timeout: 120_000 }
);

test(
	'MathPanel client matrix controls validate, confirm real resizes, localize, and insert serialized LaTeX',
	{ timeout: 30_000 },
	async () => {
		assert.ok(dom, 'The JSDOM browser environment must be initialized');
		assert.ok(client, 'The actual Vite-built Svelte client must be loaded');
		const win = dom.window;
		const api = client;
		const container = win.document.getElementById('app');
		assert.ok(container);

		const insertions: string[] = [];
		let closeCalls = 0;
		let updateLocale: ((nextLocale: Locale) => void) | undefined;
		let mounted: unknown;
		try {
			mounted = api.mount(api.MathPanelHarness, {
				target: container,
				props: {
					initialLocale: 'zh-Hant',
					onInsert: (source: string) => {
						insertions.push(source);
					},
					onClose: () => {
						closeCalls++;
					},
					onLocaleController: (setLocale: (nextLocale: Locale) => void) => {
						updateLocale = setLocale;
					}
				}
			});
			api.flushSync();
			await api.tick();
			await api.tick();
			api.flushSync();

			const panel = container.querySelector<HTMLElement>('.math-panel');
			assert.ok(panel, 'The actual MathPanel client component must render');
			const numericInputs = () => Array.from(panel.querySelectorAll<HTMLInputElement>('.dimensions input[type="number"]'));
			const cellInputs = () => Array.from(panel.querySelectorAll<HTMLInputElement>('.matrix-grid input'));
			const cellValues = () => cellInputs().map((input) => input.value);
			const setNumber = (index: number, value: string) => {
				const input = numericInputs()[index];
				assert.ok(input, `Expected numeric dimension input ${index}`);
				input.value = value;
				input.dispatchEvent(new win.Event('change', { bubbles: true }));
				api.flushSync();
			};
			const setCell = (index: number, value: string) => {
				const input = cellInputs()[index];
				assert.ok(input, `Expected matrix cell input ${index}`);
				input.value = value;
				input.dispatchEvent(new win.Event('input', { bubbles: true }));
				api.flushSync();
			};
			const assertDimensions = (rows: number, columns: number, cellCount: number) => {
				const [square, rowInput, columnInput] = numericInputs();
				assert.ok(square);
				assert.ok(rowInput);
				assert.ok(columnInput);
				assert.deepEqual(
					[square.value, rowInput.value, columnInput.value],
					[rows === columns ? String(rows) : '', String(rows), String(columns)]
				);
				assert.equal(cellInputs().length, cellCount);
			};

			assertLocalizedLabels(panel, 'zh-Hant');
			assertDimensions(3, 3, 9);
			assert.deepEqual(confirmationMessages, []);

			// Exercise the n×n control at both valid boundaries with empty cells.
			const emptyResizeStart = confirmationMessages.length;
			setNumber(0, '1');
			assertDimensions(1, 1, 1);
			setNumber(0, '10');
			assertDimensions(10, 10, 100);
			assert.equal(cellInputs()[99]?.getAttribute('aria-label'), '第 10 行，第 10 列');

			// Rectangular dimensions are edited through the real row and column inputs.
			setNumber(1, '2');
			assertDimensions(2, 10, 20);
			setNumber(2, '3');
			assertDimensions(2, 3, 6);
			assertNoConfirmationSince(emptyResizeStart);

			for (const invalidValue of ['0', '11', '1.5']) {
				const start = confirmationMessages.length;
				setNumber(1, invalidValue);
				assertNoConfirmationSince(start);
				assertDimensions(2, 3, 6);
				assertDimensionError(panel, 'zh-Hant');
			}

			assert.ok(updateLocale, 'The client harness must expose a reactive locale prop controller');
			const setLocale = updateLocale;
			setLocale('en');
			await api.tick();
			api.flushSync();
			assertLocalizedLabels(panel, 'en');
			assertDimensionError(panel, 'en');

			for (const invalidValue of ['0', '11', '1.5']) {
				const start = confirmationMessages.length;
				setNumber(1, invalidValue);
				assertNoConfirmationSince(start);
				assertDimensions(2, 3, 6);
				assertDimensionError(panel, 'en');
			}

			setLocale('zh-Hant');
			await api.tick();
			api.flushSync();
			assertLocalizedLabels(panel, 'zh-Hant');
			assertDimensionError(panel, 'zh-Hant');
			setLocale('en');
			await api.tick();
			api.flushSync();
			assertLocalizedLabels(panel, 'en');
			assertDimensionError(panel, 'en');

			const validResizeStart = confirmationMessages.length;
			setNumber(1, '2');
			assertNoConfirmationSince(validResizeStart);
			assert.equal(panel.querySelector('[role="alert"]'), null, 'A valid resize must clear the dimension error');

			const originalCells = [
				String.raw`\alpha`,
				'x_1',
				'discard-a',
				'b',
				String.raw`\frac{1}{2}`,
				'discard-b'
			];
			for (const [index, value] of originalCells.entries()) setCell(index, value);
			assert.deepEqual(cellValues(), originalCells);

			// A rejected shrink must leave the displayed dimensions and every cell unchanged.
			const beforeReject = confirmationMessages.length;
			confirmationChoices.push(false);
			setNumber(1, '1');
			assertConfirmationSince(
				beforeReject,
				'Shrinking the matrix deletes content outside the new size. Continue?'
			);
			assertDimensions(2, 3, 6);
			assert.deepEqual(cellValues(), originalCells);

			// Accepting a column shrink drops only the two cells outside the new rectangle.
			const beforeAccept = confirmationMessages.length;
			confirmationChoices.push(true);
			setNumber(2, '2');
			assertConfirmationSince(
				beforeAccept,
				'Shrinking the matrix deletes content outside the new size. Continue?'
			);
			assertDimensions(2, 2, 4);
			assert.deepEqual(cellValues(), [originalCells[0], originalCells[1], originalCells[3], originalCells[4]]);
			assert.equal(panel.querySelector('[role="alert"]'), null);

			const bracketSelect = panel.querySelector<HTMLSelectElement>('.dimensions select');
			assert.ok(bracketSelect);
			bracketSelect.value = 'square';
			bracketSelect.dispatchEvent(new win.Event('change', { bubbles: true }));
			api.flushSync();
			assert.equal(bracketSelect.value, 'square');

			const inlineCheckbox = panel.querySelector<HTMLInputElement>('.inline-option input');
			assert.ok(inlineCheckbox);
			assert.equal(inlineCheckbox.checked, false);
			inlineCheckbox.click();
			api.flushSync();
			assert.equal(inlineCheckbox.checked, true);

			const insertButton = panel.querySelector<HTMLButtonElement>('.panel-actions button.primary');
			assert.ok(insertButton);
			const beforeInsert = confirmationMessages.length;
			insertButton.click();
			api.flushSync();

			assertNoConfirmationSince(beforeInsert);
			assert.deepEqual(insertions, [
				String.raw`\(\left[\begin{array}{cc}
\alpha & x_1 \\
b & \frac{1}{2}
\end{array}\right]\)`
			]);
			assert.equal(closeCalls, 0);
			assert.equal(panel.querySelector('[role="alert"]'), null);
		} finally {
			if (mounted !== undefined) {
				await api.unmount(mounted);
				api.flushSync();
			}
		}

		assert.equal(container.querySelector('.math-panel'), null, 'Unmount must remove the client-rendered panel');
	}
);

test(
	'MathPanel applies the current equation draft and honors source visibility',
	{ timeout: 30_000 },
	async () => {
		assert.ok(dom, 'The JSDOM browser environment must be initialized');
		assert.ok(client, 'The actual Vite-built Svelte client must be loaded');
		const win = dom.window;
		const api = client;
		const container = win.document.getElementById('app');
		assert.ok(container);

		const insertions: string[] = [];
		const applications: EquationDraft[] = [];
		let parent: PanelController | undefined;
		let mounted: unknown;
		try {
			mounted = api.mount(api.LifecycleMathPanelHarness, {
				target: container,
				props: {
					initialKind: 'equation',
					initialActive: false,
					initialSessionKey: 'equation:apply',
					initialDraft: { latex: String.raw`\alpha`, inline: true },
					initialLocale: 'en',
					initialShowSource: false,
					initialEditing: true,
					onInsert: (source: string) => { insertions.push(source); },
					onEquation: (draft: EquationDraft) => { applications.push(draft); },
					onClose: () => {},
					onController: (controller: PanelController) => { parent = controller; }
				}
			});
			api.flushSync();
			await api.tick();
			api.flushSync();

			const panel = container.querySelector<HTMLElement>('.math-panel');
			assert.ok(panel);
			assert.ok(parent);
			const controls = parent;
			const settle = async () => {
				api.flushSync();
				await api.tick();
				await api.tick();
				api.flushSync();
			};
			const formula = () => panel.querySelector<HTMLTextAreaElement>('.formula textarea');

			// Keep MathLive out of this visibility assertion: the inactive panel has
			// not instantiated it, so this checks the actual showSource branch alone.
			assert.equal(formula(), null);
			controls.setShowSource(true);
			await settle();
			assert.ok(formula());
			controls.setShowSource(false);
			await settle();
			assert.equal(formula(), null);

			controls.setShowSource(true);
			controls.setActive(true);
			await settle();
			assert.equal(formula()?.value, String.raw`\alpha`);
			const apply = panel.querySelector<HTMLButtonElement>('.panel-actions button.primary');
			assert.ok(apply);
			assert.equal(apply.textContent?.trim(), 'Apply');

			const input = formula();
			assert.ok(input);
			input.value = String.raw`\frac{3}{4}`;
			input.dispatchEvent(new win.Event('input', { bubbles: true }));
			api.flushSync();

			const inline = panel.querySelector<HTMLInputElement>('.inline-option input');
			assert.ok(inline);
			assert.equal(inline.checked, true);
			inline.click();
			api.flushSync();
			assert.equal(inline.checked, false);

			apply.click();
			api.flushSync();
			assert.deepEqual(applications, [{ latex: String.raw`\frac{3}{4}`, inline: false }]);
			assert.deepEqual(insertions, [], 'Equation editing must publish a draft, not an insertion');
			assert.equal(panel.querySelector('[role="alert"]'), null);
		} finally {
			if (mounted !== undefined) {
				const unmounting = api.unmount(mounted);
				api.flushSync();
				await unmounting;
			}
		}

		assert.equal(container.querySelector('.math-panel'), null, 'Unmount must remove the client-rendered panel');
	}
);

test(
	'MathPanel preserves same-pair drafts while inactive and initializes only on kind or session changes',
	{ timeout: 30_000 },
	async () => {
		assert.ok(dom, 'The JSDOM browser environment must be initialized');
		assert.ok(client, 'The actual Vite-built Svelte client must be loaded');
		const win = dom.window;
		const api = client;
		const container = win.document.getElementById('app');
		assert.ok(container);

		const insertions: string[] = [];
		let closeCalls = 0;
		let parent: PanelController | undefined;
		let mounted: unknown;
		try {
			mounted = api.mount(api.LifecycleMathPanelHarness, {
				target: container,
				props: {
					initialKind: 'equation',
					initialActive: true,
					initialSessionKey: 'insert',
					initialDraft: { latex: String.raw`\alpha`, inline: true },
					initialLocale: 'zh-Hant',
					onInsert: (source: string) => { insertions.push(source); },
					onClose: () => { closeCalls++; },
					onController: (controller: PanelController) => { parent = controller; }
				}
			});
			api.flushSync();
			await api.tick();
			await api.tick();
			api.flushSync();

			const panel = container.querySelector<HTMLElement>('.math-panel');
			assert.ok(panel);
			assert.ok(parent);
			const controls = parent;
			const formula = () => panel.querySelector<HTMLTextAreaElement>('.formula textarea');
			const inline = () => panel.querySelector<HTMLInputElement>('.inline-option input');
			const primary = () => panel.querySelector<HTMLButtonElement>('.panel-actions button.primary');
			const numbers = () => Array.from(panel.querySelectorAll<HTMLInputElement>('.dimensions input[type="number"]'));
			const cells = () => Array.from(panel.querySelectorAll<HTMLInputElement>('.matrix-grid input'));
			const settle = async () => {
				api.flushSync();
				await api.tick();
				await api.tick();
				api.flushSync();
			};
			const setFormula = (value: string) => {
				const input = formula();
				assert.ok(input);
				input.value = value;
				input.dispatchEvent(new win.Event('input', { bubbles: true }));
				api.flushSync();
			};
			const setNumber = (index: number, value: string) => {
				const input = numbers()[index];
				assert.ok(input);
				input.value = value;
				input.dispatchEvent(new win.Event('change', { bubbles: true }));
				api.flushSync();
			};
			const setCell = (index: number, value: string) => {
				const input = cells()[index];
				assert.ok(input);
				input.value = value;
				input.dispatchEvent(new win.Event('input', { bubbles: true }));
				api.flushSync();
			};

			assert.equal(formula()?.value, String.raw`\alpha`);
			assert.equal(inline()?.checked, true);
			setFormula(String.raw`\beta`);
			inline()?.click();
			api.flushSync();
			assert.equal(inline()?.checked, false);

			// Same-pair parent updates and locale changes do not overwrite edits.
			controls.setInitialDraft({ latex: 'parent-only equation draft', inline: true });
			controls.setLocale('en');
			await settle();
			assert.equal(formula()?.value, String.raw`\beta`);
			assert.equal(inline()?.checked, false);

			// Inactive controls cannot edit or publish, but their same-session draft is retained.
			controls.setActive(false);
			await settle();
			const inactiveFormula = formula();
			assert.ok(inactiveFormula);
			inactiveFormula.value = 'inactive edit';
			inactiveFormula.dispatchEvent(new win.Event('input', { bubbles: true }));
			api.flushSync();
			assert.equal(formula()?.value, String.raw`\beta`);
			const beforeInactiveInsert = insertions.length;
			primary()?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
			api.flushSync();
			assert.equal(insertions.length, beforeInactiveInsert);

			controls.setActive(true);
			await settle();
			assert.equal(formula()?.value, String.raw`\beta`);
			assert.equal(inline()?.checked, false);
			primary()?.click();
			api.flushSync();
			assert.deepEqual(insertions, [api.equationSource(String.raw`\beta`, false)]);

			// A changed key reloads an equation draft; switching kind starts a clean matrix and ignores it.
			controls.setSessionKey('equation:second');
			controls.setInitialDraft({ latex: String.raw`\gamma`, inline: true });
			await settle();
			assert.equal(formula()?.value, String.raw`\gamma`);
			assert.equal(inline()?.checked, true);
			controls.setKind('matrix');
			await settle();
			assert.equal(cells().length, 9);
			assert.deepEqual(cells().map((input) => input.value), Array(9).fill(''));
			assert.equal(inline()?.checked, false);

			setNumber(1, '0');
			assert.ok(panel.querySelector('[role="alert"]'));
			controls.setInitialDraft({ latex: 'not a matrix draft', inline: true });
			controls.setSessionKey('matrix:second');
			await settle();
			assert.equal(numbers()[1]?.value, '3');
			assert.equal(numbers()[2]?.value, '3');
			assert.deepEqual(cells().map((input) => input.value), Array(9).fill(''));
			assert.equal(inline()?.checked, false);
			assert.equal(panel.querySelector('[role="alert"]'), null);

			setNumber(1, '2');
			setNumber(2, '3');
			const matrixCells = [String.raw`\alpha`, 'x_1', '', ' spaced ', String.raw`\frac{1}{2}`, ''];
			for (const [index, value] of matrixCells.entries()) setCell(index, value);
			const brackets = panel.querySelector<HTMLSelectElement>('.dimensions select');
			assert.ok(brackets);
			brackets.value = 'square';
			brackets.dispatchEvent(new win.Event('change', { bubbles: true }));
			inline()?.click();
			api.flushSync();
			controls.setLocale('zh-Hant');
			await settle();
			assert.deepEqual(cells().map((input) => input.value), matrixCells);
			assert.equal(brackets.value, 'square');
			assert.equal(inline()?.checked, true);

			const expectedMatrix = api.equationSource(
				api.matrixSource({ rows: 2, columns: 3, cells: matrixCells }, 'square'),
				true
			);
			// Parent close makes the panel inactive. Reopening the same pair must retain the draft.
			panel.querySelector<HTMLButtonElement>('.panel-actions button:not(.primary)')?.click();
			api.flushSync();
			assert.equal(closeCalls, 1);
			assert.deepEqual(cells().map((input) => input.value), matrixCells);
			const beforeCancelledInsert = insertions.length;
			primary()?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
			api.flushSync();
			assert.equal(insertions.length, beforeCancelledInsert, 'Cancel must not publish matrix source');
			controls.setActive(true);
			await settle();
			assert.deepEqual(cells().map((input) => input.value), matrixCells);
			assert.equal(numbers()[1]?.value, '2');
			assert.equal(numbers()[2]?.value, '3');
			assert.equal(brackets.value, 'square');
			assert.equal(inline()?.checked, true);
			primary()?.click();
			api.flushSync();
			assert.deepEqual(insertions, [
				api.equationSource(String.raw`\beta`, false),
				expectedMatrix
			], 'The live insert handler must publish the actual matrix serializer output');

			controls.setSessionKey('matrix:third');
			await settle();
			assert.equal(numbers()[1]?.value, '3');
			assert.equal(numbers()[2]?.value, '3');
			assert.deepEqual(cells().map((input) => input.value), Array(9).fill(''));
			assert.equal(inline()?.checked, false);
			assert.equal(brackets.value, 'parentheses');

			controls.setKind('equation');
			controls.setInitialDraft({ latex: 'source equation', inline: false });
			await settle();
			assert.equal(formula()?.value, 'source equation');
			assert.equal(inline()?.checked, false);
			primary()?.click();
			api.flushSync();
			assert.deepEqual(insertions.at(-1), api.equationSource('source equation', false));
		} finally {
			if (mounted !== undefined) {
				const unmounting = api.unmount(mounted);
				api.flushSync();
				await unmounting;
			}
		}

		assert.equal(container.querySelector('.math-panel'), null, 'Unmount must remove the client-rendered panel');
	}
);

test(
	'MathPanel cancels pending focus after deactivation and unmount',
	{ timeout: 30_000 },
	async () => {
		assert.ok(dom, 'The JSDOM browser environment must be initialized');
		assert.ok(client, 'The actual Vite-built Svelte client must be loaded');
		const win = dom.window;
		const api = client;
		const container = win.document.getElementById('app');
		assert.ok(container);
		const sentinel = win.document.createElement('input');
		win.document.body.append(sentinel);
		sentinel.focus();

		let parent: PanelController | undefined;
		let mounted: unknown;
		try {
			mounted = api.mount(api.LifecycleMathPanelHarness, {
				target: container,
				props: {
					initialKind: 'equation',
					initialActive: true,
					initialSessionKey: 'focus-session',
					onInsert: () => {},
					onClose: () => {},
					onController: (controller: PanelController) => { parent = controller; }
				}
			});
			api.flushSync();
			assert.ok(parent);
			parent.setActive(false);
			api.flushSync();
			sentinel.focus();
			await api.tick();
			await api.tick();
			api.flushSync();
			assert.equal(win.document.activeElement, sentinel, 'A focus tick must not run after deactivation');

			parent.setActive(true);
			api.flushSync();
			sentinel.focus();
			const unmounting = api.unmount(mounted);
			mounted = undefined;
			api.flushSync();
			await api.tick();
			await api.tick();
			await unmounting;
			assert.equal(win.document.activeElement, sentinel, 'A pending focus tick must not run after unmount');
		} finally {
			if (mounted !== undefined) {
				const unmounting = api.unmount(mounted);
				api.flushSync();
				await unmounting;
			}
			sentinel.remove();
		}
	}
);
