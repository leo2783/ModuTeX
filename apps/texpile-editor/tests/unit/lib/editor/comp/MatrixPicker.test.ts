// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import MathSymbolPanel from '../../../../../src/lib/editor/comp/toolbar/MathSymbolPanel.svelte';

// Exercise MathLive's installed browser build just as production does. Vitest otherwise selects
// MathLive's Node SSR export in jsdom, which has no editable MathfieldElement.
vi.mock('mathlive', async () => import('../../../../../../../node_modules/mathlive/mathlive.min.mjs'));

class TestResizeObserver {
	static instances: TestResizeObserver[] = [];
	private readonly targets = new Set<Element>();

	constructor() {
		TestResizeObserver.instances.push(this);
	}

	observe(target: Element): void {
		this.targets.add(target);
	}

	unobserve(target: Element): void {
		this.targets.delete(target);
	}

	disconnect(): void {
		this.targets.clear();
	}
}

const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(window, 'ResizeObserver');
const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
const fontSetDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scroll');
const mathfieldElementDescriptor = Object.getOwnPropertyDescriptor(window, 'MathfieldElement');
let MathfieldElementClass: typeof import('mathlive').MathfieldElement;
let originalFontsDirectory: string | null | undefined;

let host: HTMLDivElement;
let panel: Record<string, unknown> | null = null;
let close: ReturnType<typeof vi.fn>;

beforeAll(async () => {
	vi.stubGlobal('ResizeObserver', TestResizeObserver);
	Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: TestResizeObserver });
	Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false }) });
	Object.defineProperty(document, 'fonts', { configurable: true, value: { ready: Promise.resolve() } });
	Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: () => {} });
	Object.defineProperty(HTMLElement.prototype, 'scroll', { configurable: true, value: () => {} });
	const mathlive = await import('mathlive');
	expect(mathlive.version.mathlive).toBe('0.110.0');
	MathfieldElementClass = mathlive.MathfieldElement;
	originalFontsDirectory = MathfieldElementClass.fontsDirectory;
	MathfieldElementClass.fontsDirectory = null;
	Object.defineProperty(window, 'MathfieldElement', { configurable: true, writable: true, value: MathfieldElementClass });
	mathlive.initVirtualKeyboardInCurrentBrowsingContext();
});

beforeEach(() => {
	host = document.body.appendChild(document.createElement('div'));
	close = vi.fn();
	panel = mount(MathSymbolPanel, { target: host, props: { groupId: 'matrices', top: 0, left: 0, onClose: close } });
	flushSync();
});

afterEach(async () => {
	if (panel) await unmount(panel);
	panel = null;
	host.remove();
});

afterAll(() => {
	for (const observer of TestResizeObserver.instances) observer.disconnect();
	if (resizeObserverDescriptor) Object.defineProperty(window, 'ResizeObserver', resizeObserverDescriptor);
	else Reflect.deleteProperty(window, 'ResizeObserver');
	if (matchMediaDescriptor) Object.defineProperty(window, 'matchMedia', matchMediaDescriptor);
	else Reflect.deleteProperty(window, 'matchMedia');
	if (fontSetDescriptor) Object.defineProperty(document, 'fonts', fontSetDescriptor);
	else Reflect.deleteProperty(document, 'fonts');
	if (scrollIntoViewDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
	else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
	if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scroll', scrollDescriptor);
	else Reflect.deleteProperty(HTMLElement.prototype, 'scroll');
	if (mathfieldElementDescriptor) Object.defineProperty(window, 'MathfieldElement', mathfieldElementDescriptor);
	else Reflect.deleteProperty(window, 'MathfieldElement');
	if (MathfieldElementClass) MathfieldElementClass.fontsDirectory = originalFontsDirectory;
	vi.unstubAllGlobals();
});

function setInput(input: HTMLInputElement, value: string) {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

describe('MathSymbolPanel matrix picker', () => {
	it('offers all six brackets, defaults to 2×2, and exposes the direct 1×1–10×10 picker', () => {
		expect(host.querySelectorAll('[aria-pressed]').length).toBe(6);
		expect(host.textContent).toContain('2×2');
		expect(host.querySelectorAll('[data-matrix-cell]').length).toBe(100);

		const tenByTen = host.querySelector<HTMLButtonElement>('[data-matrix-cell="9-9"]');
		tenByTen!.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
		flushSync();
		expect(host.textContent).toContain('10×10');
	});

	it('moves the active grid cell with arrow keys without leaving keyboard users stranded', () => {
		const firstCell = host.querySelector<HTMLButtonElement>('[data-matrix-cell="0-0"]');
		firstCell!.focus();
		firstCell!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
		flushSync();
		expect(document.activeElement).toBe(host.querySelector('[data-matrix-cell="1-0"]'));
	});

	it('shows inline validation and prevents invalid custom sizes from invoking insertion', () => {
		const squareSize = host.querySelector<HTMLInputElement>('[aria-label="Square size (N)"]');
		const rows = host.querySelector<HTMLInputElement>('[aria-label="Matrix rows"]');
		const columns = host.querySelector<HTMLInputElement>('[aria-label="Matrix columns"]');
		const insertSquare = () => host.querySelector<HTMLButtonElement>('[data-matrix-insert="square"]')!;
		const insertRectangular = () => host.querySelector<HTMLButtonElement>('[data-matrix-insert="rectangular"]')!;

		for (const invalidSize of ['0', '-1', '11', '1.5', '']) {
			setInput(squareSize!, invalidSize);
			expect(squareSize!.getAttribute('aria-invalid')).toBe('true');
			expect(insertSquare().disabled).toBe(true);
			expect(host.querySelector('#matrix-square-size-error')?.textContent).toContain('1 to 10');
			insertSquare().click();
			expect(close).not.toHaveBeenCalled();
		}

		for (const validSize of ['1', '10']) {
			setInput(squareSize!, validSize);
			expect(squareSize!.getAttribute('aria-invalid')).toBe('false');
			expect(insertSquare().disabled).toBe(false);
			expect(insertSquare().getAttribute('aria-label')).toBe(`Insert ${validSize}×${validSize} matrix`);
		}

		for (const invalidRows of ['0', '-1', '11', '1.5', '']) {
			setInput(rows!, invalidRows);
			expect(rows!.getAttribute('aria-invalid')).toBe('true');
			expect(insertRectangular().disabled).toBe(true);
			expect(host.querySelector('#matrix-size-error')?.textContent).toContain('1 to 10');
			insertRectangular().click();
			expect(close).not.toHaveBeenCalled();
		}

		setInput(rows!, '2');
		for (const invalidColumns of ['0', '-1', '11', '1.5', '']) {
			setInput(columns!, invalidColumns);
			expect(columns!.getAttribute('aria-invalid')).toBe('true');
			expect(insertRectangular().disabled).toBe(true);
			insertRectangular().click();
			expect(close).not.toHaveBeenCalled();
		}

		setInput(rows!, '10');
		setInput(columns!, '10');
		expect(rows!.getAttribute('aria-invalid')).toBe('false');
		expect(columns!.getAttribute('aria-invalid')).toBe('false');
		expect(insertRectangular().disabled).toBe(false);
		expect(insertRectangular().getAttribute('aria-label')).toBe('Insert 10×10 matrix');
		expect(close).not.toHaveBeenCalled();
	});
});
