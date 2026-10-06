// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '$lib/schema/schema';
import { typSchema } from '$lib/typst/visual/schema';
import { editorViewStore } from '$lib/stores/editorStore';
import TextColorDropdown from '../../../../../src/lib/editor/comp/toolbar/TextColorDropdown.svelte';
import type { TextColorPackageRequester } from '$lib/workspace/text-color-package-context';

let host: HTMLDivElement;
let editorHost: HTMLDivElement;
let app: Record<string, unknown> | null = null;
let view: EditorView | null = null;

function chooseButton(label: string): HTMLButtonElement {
	const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
	if (!button) throw new Error(`Missing text-color option: ${label}`);
	return button;
}

async function flushPromises() {
	await Promise.resolve();
	await Promise.resolve();
	flushSync();
}

beforeEach(() => {
	host = document.body.appendChild(document.createElement('div'));
	editorHost = document.body.appendChild(document.createElement('div'));
	const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('select this')));
	view = new EditorView(editorHost, {
		state: EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1, 12) })
	});
	editorViewStore.set(view);
});

afterEach(async () => {
	if (app) await unmount(app);
	app = null;
	view?.destroy();
	view = null;
	editorViewStore.set(null);
	host?.remove();
	editorHost?.remove();
	vi.restoreAllMocks();
});

describe('TextColorDropdown', () => {
	it('keeps the selected text range while the portal opens and applies the textcolor mark', async () => {
		const requester: TextColorPackageRequester = {
			ensureXcolor: vi.fn(async (_signal, targetIsCurrent) => (targetIsCurrent() ? { isCurrent: targetIsCurrent } : null))
		};
		app = mount(TextColorDropdown, { target: host, props: { packageRequester: requester } });
		flushSync();

		host.querySelector<HTMLButtonElement>('[aria-label="Text color"]')!.click();
		flushSync();
		const red = chooseButton('Red');
		red.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
		red.click();
		await flushPromises();

		expect(requester.ensureXcolor).toHaveBeenCalledOnce();
		expect(view?.state.selection.from).toBe(1);
		expect(view?.state.selection.to).toBe(12);
		const text = view?.state.doc.firstChild?.firstChild;
		expect(text?.text).toBe('select this');
		expect(text?.marks.find((mark) => mark.type.name === 'textcolor')?.attrs.color).toBe('red');
	});

	it('removes the selected color without requesting a package', async () => {
		const original = view!.state.doc;
		const marked = original.type.create(
			null,
			original.firstChild!.type.create(null, schema.text('select this', [schema.marks.textcolor.create({ color: 'blue' })]))
		);
		view!.updateState(EditorState.create({ schema, doc: marked, selection: TextSelection.create(marked, 1, 12) }));
		const requester: TextColorPackageRequester = { ensureXcolor: vi.fn(async () => null) };
		app = mount(TextColorDropdown, { target: host, props: { activeTextColor: 'blue', packageRequester: requester } });
		flushSync();

		host.querySelector<HTMLButtonElement>('[aria-label="Text color"]')!.click();
		flushSync();
		chooseButton('Default').click();
		await flushPromises();

		expect(requester.ensureXcolor).not.toHaveBeenCalled();
		expect(view?.state.doc.firstChild?.firstChild?.marks.some((mark) => mark.type.name === 'textcolor')).toBe(false);
	});

	it('keeps Typst text colors independent of the LaTeX xcolor prompt', async () => {
		view?.destroy();
		const doc = typSchema.nodes.doc.create(null, typSchema.nodes.paragraph.create(null, typSchema.text('select this')));
		view = new EditorView(editorHost, {
			state: EditorState.create({ schema: typSchema, doc, selection: TextSelection.create(doc, 1, 12) })
		});
		editorViewStore.set(view);
		const requester: TextColorPackageRequester = { ensureXcolor: vi.fn(async () => null) };
		app = mount(TextColorDropdown, { target: host, props: { markSchema: typSchema, packageRequester: requester } });
		flushSync();

		host.querySelector<HTMLButtonElement>('[aria-label="Text color"]')!.click();
		flushSync();
		chooseButton('Red').click();
		await flushPromises();

		expect(requester.ensureXcolor).not.toHaveBeenCalled();
		expect(view.state.doc.firstChild?.firstChild?.marks.find((mark) => mark.type.name === 'textcolor')?.attrs.color).toBe('red');
	});
});
