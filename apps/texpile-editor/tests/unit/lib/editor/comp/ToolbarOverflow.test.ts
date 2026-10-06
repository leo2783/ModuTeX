// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { EditorSelection, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { sourceCmView } from '$lib/stores/editorStore';
import { m } from '$lib/paraglide/messages';
import SourceToolbar from '$lib/editor/comp/toolbar/SourceToolbar.svelte';

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
const originalScrollWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth');

let host: HTMLDivElement;
let editorHost: HTMLDivElement;
let toolbar: Record<string, unknown> | null = null;
let view: EditorView | null = null;

async function waitForToolbarFit(): Promise<void> {
	for (let frame = 0; frame < 8; frame += 1) {
		await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
	}
	flushSync();
}

beforeEach(() => {
	vi.stubGlobal('ResizeObserver', TestResizeObserver);
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get() {
			return this.classList.contains('toolbar-fit') ? 80 : 0;
		}
	});
	Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
		configurable: true,
		get() {
			return this.classList.contains('toolbar-fit') ? 200 : 0;
		}
	});

	host = document.body.appendChild(document.createElement('div'));
	editorHost = document.body.appendChild(document.createElement('div'));
	view = new EditorView({
		state: EditorState.create({ doc: 'selected', selection: EditorSelection.range(0, 8) }),
		parent: editorHost
	});
	sourceCmView.set(view);
	toolbar = mount(SourceToolbar, { target: host });
	flushSync();
});

afterEach(async () => {
	if (toolbar) await unmount(toolbar);
	view?.destroy();
	view = null;
	sourceCmView.set(null);
	host.remove();
	editorHost.remove();
	if (originalClientWidth) {
		Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
	} else {
		Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
	}
	if (originalScrollWidth) {
		Object.defineProperty(HTMLElement.prototype, 'scrollWidth', originalScrollWidth);
	} else {
		Reflect.deleteProperty(HTMLElement.prototype, 'scrollWidth');
	}
	toolbar = null;
	vi.unstubAllGlobals();
});

describe('source toolbar overflow rendering', () => {
	it('keeps inline controls, exposes collapsed controls, preserves editor focus, and runs the real quote command', async () => {
		await waitForToolbarFit();

		const inlineBold = host.querySelector<HTMLButtonElement>(`button[aria-label="${m.srctoolbar_bold_aria()}"]`);
		const menuButton = host.querySelector<HTMLButtonElement>(`button[aria-label="${m.toolbar_more_actions_aria()}"]`);
		expect(inlineBold).not.toBeNull();
		expect(inlineBold!.querySelector('svg')).not.toBeNull();
		expect(menuButton).not.toBeNull();
		expect(host.querySelector(`button[aria-label="${m.srctoolbar_quote_block_aria()}"]`)).toBeNull();

		view!.focus();
		const menuMouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
		menuButton!.dispatchEvent(menuMouseDown);
		expect(menuMouseDown.defaultPrevented).toBe(true);
		menuButton!.click();
		flushSync();
		expect(menuButton!.getAttribute('aria-expanded')).toBe('true');
		expect(document.activeElement).toBe(view!.contentDOM);
		const quoteButton = host.querySelector<HTMLButtonElement>(`button[aria-label="${m.srctoolbar_quote_block_aria()}"]`);
		expect(quoteButton).not.toBeNull();
		expect(quoteButton!.querySelector('svg')).not.toBeNull();
		const overflowLabels = Array.from(host.querySelectorAll('button[aria-label]'), (button) => button.getAttribute('aria-label'));
		expect(overflowLabels).toContain(m.tbar_insert_table_aria());
		expect(overflowLabels).toContain(m.tbar_math_symbols());

		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		flushSync();
		expect(menuButton!.getAttribute('aria-expanded')).toBe('false');
		expect(host.querySelector(`button[aria-label="${m.srctoolbar_quote_block_aria()}"]`)).toBeNull();
		expect(document.activeElement).toBe(view!.contentDOM);

		menuButton!.click();
		flushSync();
		host.querySelector<HTMLButtonElement>(`button[aria-label="${m.srctoolbar_quote_block_aria()}"]`)!.click();
		flushSync();

		expect(view!.state.doc.toString()).toBe('\\begin{quote}\nselected\n\\end{quote}');
		expect(document.activeElement).toBe(view!.contentDOM);
	});
});
