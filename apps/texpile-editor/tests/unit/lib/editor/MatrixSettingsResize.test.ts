// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '../../../../src/lib/schema/schema';
import { answerConfirm, confirmDialog, dismissConfirm } from '../../../../src/lib/modals/confirm.svelte';
import MathSettings from '../../../../src/lib/editor/extensions/mathlivebridge/MathSettings.svelte';
import { generateMatrixLatex } from '../../../../src/lib/editor/extensions/mathlivebridge/matrixLatex';

vi.mock('../../../../src/lib/editor/extensions/mathlivebridge/virtualKeyboardConfig', () => ({
	configureMathVirtualKeyboard: vi.fn(async () => undefined)
}));

class TestResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

let host: HTMLDivElement;
let editorHost: HTMLDivElement;
let settings: Record<string, unknown> | null = null;
let view: EditorView;
const resizeObserverDescriptor = Object.getOwnPropertyDescriptor(window, 'ResizeObserver');

beforeEach(() => {
	Object.defineProperty(window, 'ResizeObserver', { value: TestResizeObserver, configurable: true });
	host = document.body.appendChild(document.createElement('div'));
	editorHost = document.body.appendChild(document.createElement('div'));
	const latex = '\\begin{pmatrix}a & b\\\\c & d\\end{pmatrix}';
	const block = schema.nodes.block_math.create(null, schema.text(latex));
	view = new EditorView(editorHost, { state: EditorState.create({ schema, doc: schema.nodes.doc.create(null, block) }) });
	settings = mount(MathSettings, { target: host, props: { node: block, view, getPos: () => 0 } });
	flushSync();
	const trigger = host.querySelector<HTMLButtonElement>('[aria-label]');
	trigger!.click();
	flushSync();
});

afterEach(async () => {
	dismissConfirm();
	if (settings) await unmount(settings);
	settings = null;
	view.destroy();
	host.remove();
	editorHost.remove();
	if (resizeObserverDescriptor) {
		Object.defineProperty(window, 'ResizeObserver', resizeObserverDescriptor);
	} else {
		Reflect.deleteProperty(window, 'ResizeObserver');
	}
});

function setInput(input: HTMLInputElement, value: string) {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

async function settleResize() {
	await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
	flushSync();
}

describe('MathSettings matrix resize', () => {
	it('leaves imported matrices over 10×10 untouched until the user chooses a supported resize', async () => {
		if (settings) await unmount(settings);
		const largeLatex = generateMatrixLatex(11, 11, 'pmatrix');
		const largeNode = schema.nodes.block_math.create(null, schema.text(largeLatex));
		view.updateState(EditorState.create({ schema, doc: schema.nodes.doc.create(null, largeNode) }));
		settings = mount(MathSettings, { target: host, props: { node: largeNode, view, getPos: () => 0 } });
		flushSync();
		document.querySelector<HTMLButtonElement>('.math-settings-btn button')!.click();
		flushSync();

		const rows = document.querySelector<HTMLInputElement>('[aria-label="Matrix rows"]')!;
		const columns = document.querySelector<HTMLInputElement>('[aria-label="Matrix columns"]')!;
		const resize = document.querySelector<HTMLButtonElement>('[aria-label="Resize matrix"]')!;
		expect(rows.value).toBe('11');
		expect(columns.value).toBe('11');
		expect(rows.max).toBe('10');
		expect(columns.max).toBe('10');
		expect(resize.disabled).toBe(true);
		expect(view.state.doc.firstChild?.textContent).toBe(largeLatex);

		setInput(rows, '10');
		setInput(columns, '10');
		expect(resize.disabled).toBe(false);
		expect(view.state.doc.firstChild?.textContent).toBe(largeLatex);
	});

	it('uses the live ProseMirror document, preserves data on cancel, and applies confirmed shrinkage', async () => {
		const rows = document.querySelector<HTMLInputElement>('[aria-label="Matrix rows"]');
		const columns = document.querySelector<HTMLInputElement>('[aria-label="Matrix columns"]');
		const resize = document.querySelector<HTMLButtonElement>('[aria-label="Resize matrix"]');
		expect(rows).not.toBeNull();
		expect(columns).not.toBeNull();
		setInput(rows!, '1');
		setInput(columns!, '1');

		resize!.click();
		await Promise.resolve();
		expect(confirmDialog.state?.message).toContain('remove non-empty cells');
		answerConfirm(false);
		await settleResize();
		expect(view.state.doc.firstChild?.textContent).toBe('\\begin{pmatrix}a & b\\\\c & d\\end{pmatrix}');

		resize!.click();
		await Promise.resolve();
		answerConfirm(true);
		await settleResize();
		expect(view.state.doc.firstChild?.textContent).toBe('\\begin{pmatrix}a\\end{pmatrix}');
	});

	it('does not apply the confirmed snapshot after the live matrix changes', async () => {
		const rows = document.querySelector<HTMLInputElement>('[aria-label="Matrix rows"]');
		const columns = document.querySelector<HTMLInputElement>('[aria-label="Matrix columns"]');
		const resize = document.querySelector<HTMLButtonElement>('[aria-label="Resize matrix"]');
		const updatedLatex = '\\begin{pmatrix}edited & b\\\\c & d\\end{pmatrix}';
		setInput(rows!, '1');
		setInput(columns!, '1');

		resize!.click();
		await Promise.resolve();
		expect(confirmDialog.state?.message).toContain('remove non-empty cells');

		const liveNode = view.state.doc.firstChild!;
		view.dispatch(view.state.tr.replaceWith(0, liveNode.nodeSize, liveNode.type.create(liveNode.attrs, schema.text(updatedLatex))));
		answerConfirm(true);
		await settleResize();

		expect(view.state.doc.firstChild?.textContent).toBe(updatedLatex);
	});

	it('does not resize a newly created target with identical content and attributes', async () => {
		const rows = document.querySelector<HTMLInputElement>('[aria-label="Matrix rows"]');
		const columns = document.querySelector<HTMLInputElement>('[aria-label="Matrix columns"]');
		const resize = document.querySelector<HTMLButtonElement>('[aria-label="Resize matrix"]');
		setInput(rows!, '1');
		setInput(columns!, '1');
		resize!.click();
		await Promise.resolve();
		expect(confirmDialog.state?.message).toContain('remove non-empty cells');

		const originalNode = view.state.doc.firstChild!;
		const replacementNode = originalNode.type.create(originalNode.attrs, originalNode.content);
		expect(replacementNode).not.toBe(originalNode);
		view.dispatch(view.state.tr.replaceWith(0, originalNode.nodeSize, replacementNode));
		expect(view.state.doc.firstChild).toBe(replacementNode);
		const dispatch = vi.spyOn(view, 'dispatch');

		answerConfirm(true);
		await settleResize();

		expect(view.state.doc.firstChild).toBe(replacementNode);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('does not resize the prior target after the ProseMirror document is replaced', async () => {
		const rows = document.querySelector<HTMLInputElement>('[aria-label="Matrix rows"]');
		const columns = document.querySelector<HTMLInputElement>('[aria-label="Matrix columns"]');
		const resize = document.querySelector<HTMLButtonElement>('[aria-label="Resize matrix"]');
		setInput(rows!, '1');
		setInput(columns!, '1');
		resize!.click();
		await Promise.resolve();
		expect(confirmDialog.state?.message).toContain('remove non-empty cells');

		const previousNode = view.state.doc.firstChild!;
		const replacementNode = schema.nodes.block_math.create(previousNode.attrs, schema.text(previousNode.textContent));
		const replacementDoc = schema.nodes.doc.create(null, replacementNode);
		view.updateState(EditorState.create({ schema, doc: replacementDoc }));
		const activeDoc = view.state.doc;
		const dispatch = vi.spyOn(view, 'dispatch');

		answerConfirm(true);
		await settleResize();

		expect(view.state.doc).toBe(activeDoc);
		expect(view.state.doc.firstChild).toBe(replacementNode);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('does not resize across a replacement document that reuses the original ProseMirror node', async () => {
		const rows = document.querySelector<HTMLInputElement>('[aria-label="Matrix rows"]');
		const columns = document.querySelector<HTMLInputElement>('[aria-label="Matrix columns"]');
		const resize = document.querySelector<HTMLButtonElement>('[aria-label="Resize matrix"]');
		setInput(rows!, '1');
		setInput(columns!, '1');
		resize!.click();
		await Promise.resolve();
		expect(confirmDialog.state?.message).toContain('remove non-empty cells');

		const originalNode = view.state.doc.firstChild!;
		const replacementDoc = schema.nodes.doc.create(null, originalNode);
		view.updateState(EditorState.create({ schema, doc: replacementDoc }));
		const activeDoc = view.state.doc;
		expect(activeDoc.firstChild).toBe(originalNode);
		const dispatch = vi.spyOn(view, 'dispatch');

		answerConfirm(true);
		await settleResize();

		expect(view.state.doc).toBe(activeDoc);
		expect(view.state.doc.firstChild).toBe(originalNode);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('invalidates a pending confirmation after an unrelated document edit', async () => {
		const rows = document.querySelector<HTMLInputElement>('[aria-label="Matrix rows"]');
		const columns = document.querySelector<HTMLInputElement>('[aria-label="Matrix columns"]');
		const resize = document.querySelector<HTMLButtonElement>('[aria-label="Resize matrix"]');
		setInput(rows!, '1');
		setInput(columns!, '1');
		resize!.click();
		await Promise.resolve();
		expect(confirmDialog.state?.message).toContain('remove non-empty cells');

		const originalDoc = view.state.doc;
		const originalNode = view.state.doc.firstChild!;
		const unrelatedParagraph = schema.nodes.paragraph.create(null, schema.text('unrelated edit'));
		view.dispatch(view.state.tr.insert(view.state.doc.content.size, unrelatedParagraph));
		const editedDoc = view.state.doc;
		expect(editedDoc).not.toBe(originalDoc);
		expect(editedDoc.firstChild).toBe(originalNode);
		const dispatch = vi.spyOn(view, 'dispatch');

		answerConfirm(true);
		await settleResize();

		expect(view.state.doc).toBe(editedDoc);
		expect(view.state.doc.firstChild).toBe(originalNode);
		expect(view.state.doc.lastChild?.textContent).toBe('unrelated edit');
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('does not dispatch after the settings component is unmounted during confirmation', async () => {
		const rows = document.querySelector<HTMLInputElement>('[aria-label="Matrix rows"]');
		const columns = document.querySelector<HTMLInputElement>('[aria-label="Matrix columns"]');
		const resize = document.querySelector<HTMLButtonElement>('[aria-label="Resize matrix"]');
		setInput(rows!, '1');
		setInput(columns!, '1');
		resize!.click();
		await Promise.resolve();
		expect(confirmDialog.state?.message).toContain('remove non-empty cells');

		const originalNode = view.state.doc.firstChild!;
		const dispatch = vi.spyOn(view, 'dispatch');
		await unmount(settings!);
		settings = null;
		answerConfirm(true);
		await settleResize();

		expect(view.state.doc.firstChild).toBe(originalNode);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it('does not dispatch after the editor view is destroyed during confirmation', async () => {
		const rows = document.querySelector<HTMLInputElement>('[aria-label="Matrix rows"]');
		const columns = document.querySelector<HTMLInputElement>('[aria-label="Matrix columns"]');
		const resize = document.querySelector<HTMLButtonElement>('[aria-label="Resize matrix"]');
		setInput(rows!, '1');
		setInput(columns!, '1');
		resize!.click();
		await Promise.resolve();
		expect(confirmDialog.state?.message).toContain('remove non-empty cells');

		const originalNode = view.state.doc.firstChild!;
		const dispatch = vi.spyOn(view, 'dispatch');
		view.destroy();
		answerConfirm(true);
		await settleResize();

		expect(view.state.doc.firstChild).toBe(originalNode);
		expect(dispatch).not.toHaveBeenCalled();
	});
});
