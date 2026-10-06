// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSettings } from '$lib/settings';
import { PaneLayout } from '$lib/workspace/paneLayout.svelte';

vi.mock('$lib/runtime', () => ({ browser: true }));

const SETTINGS_KEY = 'texpile:settings';
const PDF_FRACTION_KEY = 'texpile:pdfPaneFraction';
const ORIGINAL_INNER_WIDTH = window.innerWidth;

function keydown(key: string): KeyboardEvent {
	return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
}

function writesFor(spy: ReturnType<typeof vi.spyOn>, key: string) {
	return spy.mock.calls.filter(([writtenKey]) => writtenKey === key);
}

describe('PaneLayout keyboard boundaries', () => {
	beforeEach(async () => {
		await loadSettings();
		localStorage.clear();
		Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		Object.defineProperty(window, 'innerWidth', { configurable: true, value: ORIGINAL_INNER_WIDTH });
	});

	it('sends the sidebar to its collapsed/min and clamped/max boundaries with one settings commit each', () => {
		const layout = new PaneLayout();
		layout.sidebarOpen = true;
		layout.sidebarWidth = 384;
		const setItem = vi.spyOn(Storage.prototype, 'setItem');

		const home = keydown('Home');
		layout.resizeSidebarByKey(home);
		expect(home.defaultPrevented).toBe(true);
		expect(layout.sidebarOpen).toBe(false);
		expect(layout.sidebarWidth).toBe(384);
		expect(writesFor(setItem, SETTINGS_KEY)).toHaveLength(1);
		expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).sidebarOpen).toBe(false);

		setItem.mockClear();
		const end = keydown('End');
		layout.resizeSidebarByKey(end);
		expect(end.defaultPrevented).toBe(true);
		expect(layout.sidebarOpen).toBe(true);
		expect(layout.sidebarWidth).toBe(600);
		expect(writesFor(setItem, SETTINGS_KEY)).toHaveLength(1);
		expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toMatchObject({ sidebarOpen: true, sidebarWidth: 600 });

		setItem.mockClear();
		layout.resizeSidebarByKey(keydown('ArrowLeft'));
		expect(layout.sidebarWidth).toBe(584);
		expect(writesFor(setItem, SETTINGS_KEY)).toHaveLength(1);
	});

	it('uses exact PDF min/max clamps, persists each settled width once, and preserves arrow nudges', () => {
		const layout = new PaneLayout();
		layout.sidebarOpen = true;
		layout.sidebarWidth = 256;
		layout.pdfPaneOpen = true;
		layout.pdfPaneWidth = 420;
		const setItem = vi.spyOn(Storage.prototype, 'setItem');

		const home = keydown('Home');
		layout.resizePdfByKey(home);
		expect(home.defaultPrevented).toBe(true);
		expect(layout.pdfPaneWidth).toBe(280);
		expect(writesFor(setItem, PDF_FRACTION_KEY)).toHaveLength(1);
		expect(localStorage.getItem(PDF_FRACTION_KEY)).toBe(String(280 / window.innerWidth));

		setItem.mockClear();
		const maxWidth = layout.clampPdf(Number.POSITIVE_INFINITY);
		const end = keydown('End');
		layout.resizePdfByKey(end);
		expect(end.defaultPrevented).toBe(true);
		expect(layout.pdfPaneWidth).toBe(maxWidth);
		expect(writesFor(setItem, PDF_FRACTION_KEY)).toHaveLength(1);
		expect(localStorage.getItem(PDF_FRACTION_KEY)).toBe(String(maxWidth / window.innerWidth));

		setItem.mockClear();
		layout.resizePdfByKey(keydown('ArrowRight'));
		expect(layout.pdfPaneWidth).toBe(maxWidth - 16);
		expect(writesFor(setItem, PDF_FRACTION_KEY)).toHaveLength(1);
	});

	it('opens a closed PDF rail at the actual max on End and leaves the closed min unchanged on Home', () => {
		const layout = new PaneLayout();
		layout.sidebarOpen = false;
		layout.pdfPaneOpen = false;
		const setItem = vi.spyOn(Storage.prototype, 'setItem');

		const home = keydown('Home');
		layout.resizePdfByKey(home);
		expect(home.defaultPrevented).toBe(true);
		expect(layout.pdfPaneOpen).toBe(false);
		expect(setItem).not.toHaveBeenCalled();

		const maxWidth = layout.clampPdf(Number.POSITIVE_INFINITY);
		const end = keydown('End');
		layout.resizePdfByKey(end);
		expect(end.defaultPrevented).toBe(true);
		expect(layout.pdfPaneOpen).toBe(true);
		expect(layout.pdfPaneWidth).toBe(maxWidth);
		expect(writesFor(setItem, SETTINGS_KEY)).toHaveLength(1);
		expect(writesFor(setItem, PDF_FRACTION_KEY)).toHaveLength(1);
		expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!).pdfPaneOpen).toBe(true);
	});
});
