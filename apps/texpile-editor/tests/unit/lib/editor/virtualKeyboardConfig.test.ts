// @vitest-environment jsdom
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AppSettings } from '$lib/settings';

// Vitest externalizes `mathlive` through Node's SSR export. Route that specifier to the installed
// package's production browser export so this test exercises the same MathLive implementation.
vi.mock('mathlive', async () => import('../../../../../../node_modules/mathlive/mathlive.min.mjs'));

class TestResizeObserver {
	static instances = 0;
	private readonly targets = new Set<Element>();
	constructor() {
		TestResizeObserver.instances += 1;
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

// jsdom lacks the browser geometry/font/device-query APIs MathLive needs. Supply only those APIs
// before importing MathLive; the keyboard and its initializer remain the real 0.110 implementations.
const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(window, 'ResizeObserver');
const matchMediaDescriptor = Object.getOwnPropertyDescriptor(window, 'matchMedia');
const fontSetDescriptor = Object.getOwnPropertyDescriptor(document, 'fonts');
const scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scroll');
vi.stubGlobal('ResizeObserver', TestResizeObserver);
Object.defineProperty(window, 'ResizeObserver', { configurable: true, value: TestResizeObserver });
Object.defineProperty(window, 'matchMedia', {
	configurable: true,
	value: () => ({ matches: false })
});
Object.defineProperty(document, 'fonts', {
	configurable: true,
	value: { ready: Promise.resolve() }
});
Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
	configurable: true,
	value: () => {}
});
Object.defineProperty(HTMLElement.prototype, 'scroll', {
	configurable: true,
	value: () => {}
});

let resolveSettings: ((settings: Partial<AppSettings>) => void) | undefined;
const pendingSettings = new Promise<Partial<AppSettings>>((resolve) => {
	resolveSettings = resolve;
});
const nativeSettingsDescriptor = Object.getOwnPropertyDescriptor(window, 'texpileNative');
Object.defineProperty(window, 'texpileNative', {
	configurable: true,
	value: { getSettings: () => pendingSettings }
});
// Reproduce MathLive 0.110's existing-null global state. The product initializer must replace this
// with MathLive's real singleton synchronously before awaiting settings hydration.
Object.defineProperty(window, 'mathVirtualKeyboard', { configurable: true, value: null });

const { MathfieldElement, version } = await import('mathlive');
const { configureMathVirtualKeyboard } = await import('$lib/editor/extensions/mathlivebridge/virtualKeyboardConfig');
const { m } = await import('$lib/paraglide/messages');
const originalFontsDirectory = MathfieldElement.fontsDirectory;
let configurePromise: Promise<void> | null = null;
const fields: InstanceType<typeof MathfieldElement>[] = [];

afterAll(async () => {
	resolveSettings?.({ uiLocale: 'en' });
	if (configurePromise) await configurePromise;
	for (const field of fields) field.remove();
	document.getElementById('texpile-math-virtual-keyboard-toggle-style')?.remove();
	if (nativeSettingsDescriptor) {
		Object.defineProperty(window, 'texpileNative', nativeSettingsDescriptor);
	} else {
		Reflect.deleteProperty(window, 'texpileNative');
	}
	if (resizeObserverDescriptor) {
		Object.defineProperty(window, 'ResizeObserver', resizeObserverDescriptor);
	} else {
		Reflect.deleteProperty(window, 'ResizeObserver');
	}
	if (matchMediaDescriptor) {
		Object.defineProperty(window, 'matchMedia', matchMediaDescriptor);
	} else {
		Reflect.deleteProperty(window, 'matchMedia');
	}
	if (fontSetDescriptor) {
		Object.defineProperty(document, 'fonts', fontSetDescriptor);
	} else {
		Reflect.deleteProperty(document, 'fonts');
	}
	if (scrollIntoViewDescriptor) {
		Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
	} else {
		Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
	}
	if (scrollDescriptor) {
		Object.defineProperty(HTMLElement.prototype, 'scroll', scrollDescriptor);
	} else {
		Reflect.deleteProperty(HTMLElement.prototype, 'scroll');
	}
	MathfieldElement.fontsDirectory = originalFontsDirectory;
	vi.unstubAllGlobals();
});

describe('MathLive virtual keyboard configuration lifecycle', () => {
	it('applies the hydrated locale to the real singleton after a mathfield unmount/remount without stealing focus', async () => {
		expect(version.mathlive).toBe('0.110.0');
		expect(window.mathVirtualKeyboard).toBeNull();
		expect(globalThis.ResizeObserver).toBe(TestResizeObserver);
		expect(window.ResizeObserver).toBe(TestResizeObserver);
		MathfieldElement.fontsDirectory = null;

		configurePromise = configureMathVirtualKeyboard();
		expect(TestResizeObserver.instances).toBeGreaterThan(0);
		const keyboard = window.mathVirtualKeyboard;
		expect(keyboard).toBeTruthy();
		expect(keyboard.layouts).toEqual(['default']);

		const firstField = new MathfieldElement();
		fields.push(firstField);
		firstField.mathVirtualKeyboardPolicy = 'manual';
		document.body.append(firstField);
		firstField.focus();
		firstField.remove();
		await new Promise<void>((resolve) => window.queueMicrotask(resolve));

		const currentField = new MathfieldElement();
		fields.push(currentField);
		currentField.mathVirtualKeyboardPolicy = 'manual';
		document.body.append(currentField);
		currentField.focus();
		const hasFocusBeforeConfiguration = currentField.hasFocus();

		expect(resolveSettings).toBeTypeOf('function');
		if (!resolveSettings) throw new Error('MathLive settings hydration did not start.');
		resolveSettings({ uiLocale: 'zh-Hant' });
		await configurePromise;

		expect(window.mathVirtualKeyboard).toBe(keyboard);
		expect(keyboard.layouts).toEqual(expect.arrayContaining(['alphabetic']));
		expect(keyboard.layouts[0]).toMatchObject({ label: m.mathpal_kbd_basic_label() });
		expect(currentField.hasFocus()).toBe(hasFocusBeforeConfiguration);
		expect(currentField.hasFocus()).toBe(true);
		expect(keyboard.visible).toBe(false);

		currentField.remove();
		await new Promise<void>((resolve) => window.queueMicrotask(resolve));
	});
});
