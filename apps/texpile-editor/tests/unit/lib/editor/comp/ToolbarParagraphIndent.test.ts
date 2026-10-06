// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '$lib/schema/schema';
import { editorViewStore, rawEditorActiveStore } from '$lib/stores/editorStore';
import Toolbar from '../../../../../src/lib/editor/comp/toolbar/Toolbar.svelte';

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

class TestMathfieldElement extends HTMLElement {}

let host: HTMLDivElement;
let editorHost: HTMLDivElement;
let toolbar: Record<string, unknown> | null = null;
let view: EditorView | null = null;

beforeEach(() => {
	vi.stubGlobal('ResizeObserver', TestResizeObserver);
	Object.defineProperty(window, 'MathfieldElement', { value: TestMathfieldElement, configurable: true });
	host = document.body.appendChild(document.createElement('div'));
	editorHost = document.body.appendChild(document.createElement('div'));
	const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('Paragraph text stays unchanged')));
	view = new EditorView(editorHost, { state: EditorState.create({ schema, doc }) });
	editorViewStore.set(view);
	rawEditorActiveStore.set(false);
	toolbar = mount(Toolbar, { target: host, props: { minimal: true } });
	flushSync();
});

afterEach(async () => {
	if (toolbar) await unmount(toolbar);
	// Toolbar's focus guard schedules a zero-delay check. Let the real component finish it while
	// the MathfieldElement browser API is still available before removing test globals.
	await new Promise((resolve) => setTimeout(resolve, 0));
	toolbar = null;
	view?.destroy();
	view = null;
	editorViewStore.set(null);
	host.remove();
	editorHost.remove();
	vi.unstubAllGlobals();
});

describe('Toolbar paragraph indent', () => {
	it('routes direct menu selection through the live editor store without editing paragraph text', () => {
		const trigger = host.querySelector<HTMLButtonElement>('[aria-label="Paragraph indent"]');
		expect(trigger).not.toBeNull();
		trigger!.click();
		flushSync();

		const indent = [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find(
			(button) => button.textContent?.trim() === 'Indent'
		);
		expect(indent).toBeTruthy();
		indent!.click();
		flushSync();

		expect(view?.state.doc.firstChild?.attrs.indent).toBe('indent');
		expect(view?.state.doc.textContent).toBe('Paragraph text stays unchanged');
	});
});
