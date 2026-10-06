// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '$lib/schema/schema';
import { editorViewStore } from '$lib/stores/editorStore';
import { menuUpdatePlugin } from '$lib/editor/extensions/toolbarlistenerplugin';
import TextFormattingControls from '../../../../../src/lib/editor/comp/toolbar/TextFormattingControls.svelte';

let host: HTMLDivElement;
let editorHost: HTMLDivElement;
let controls: Record<string, unknown> | null = null;
let view: EditorView | null = null;

function createView(
	doc = schema.nodes.doc.create(null, [
		schema.nodes.paragraph.create(null, schema.text('First paragraph')),
		schema.nodes.paragraph.create(null, schema.text('Second paragraph'))
	])
): EditorView {
	return new EditorView(editorHost, {
		state: EditorState.create({
			doc,
			selection: TextSelection.create(doc, 1, doc.content.size - 1),
			plugins: [menuUpdatePlugin()]
		})
	});
}

function select(label: string): HTMLSelectElement {
	return [...host.querySelectorAll('select')].find((element) => element.getAttribute('aria-label') === label)!;
}

beforeEach(() => {
	host = document.body.appendChild(document.createElement('div'));
	editorHost = document.body.appendChild(document.createElement('div'));
	view = createView();
	editorViewStore.set(view);
	controls = mount(TextFormattingControls, { target: host });
	flushSync();
});

afterEach(async () => {
	if (controls) await unmount(controls);
	controls = null;
	view?.destroy();
	view = null;
	editorViewStore.set(null);
	host.remove();
	editorHost.remove();
});

describe('TextFormattingControls', () => {
	it('offers the finite size and paragraph alignment choices with accessible native controls', () => {
		const size = select('Text size');
		const alignment = select('Paragraph alignment');
		expect(size.disabled).toBe(false);
		expect(alignment.disabled).toBe(false);
		expect(size.tabIndex).toBe(0);
		expect([...size.options].map((option) => option.value)).toEqual([
			'',
			'tiny',
			'scriptsize',
			'footnotesize',
			'small',
			'normalsize',
			'large',
			'Large',
			'LARGE',
			'huge',
			'Huge'
		]);
		expect([...alignment.options].map((option) => option.value)).toEqual(['auto', 'left', 'center', 'right']);
		expect(host.querySelector('[role="group"]')?.getAttribute('aria-label')).toBe('Text formatting');
	});

	it('captures before the native control opens and applies formatting through the guarded commands', () => {
		const size = select('Text size');
		size.focus();
		size.value = 'small';
		size.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		for (let index = 0; index < 2; index++) {
			expect(
				view!.state.doc.child(index).firstChild!.marks.some((mark) => mark.type.name === 'font_size' && mark.attrs.size === 'small')
			).toBe(true);
		}

		const alignment = select('Paragraph alignment');
		alignment.focus();
		alignment.value = 'center';
		alignment.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(view!.state.doc.child(0).attrs.alignment).toBe('center');
		expect(view!.state.doc.child(1).attrs.alignment).toBe('center');
	});

	it('rejects a receipt made stale while the selection control is open', () => {
		const size = select('Text size');
		size.focus();
		view!.dispatch(view!.state.tr.setSelection(TextSelection.create(view!.state.doc, 2)));
		editorViewStore.set(view);
		flushSync();
		size.value = 'large';
		size.dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();
		expect(host.querySelector('[role="status"]')?.textContent).toContain('The selection changed');
		expect(view!.state.doc.textContent).toBe('First paragraphSecond paragraph');
		expect(view!.state.doc.child(0).firstChild!.marks.some((mark) => mark.type.name === 'font_size')).toBe(false);
	});

	it('disables formatting for tables, lists, and read-only editor state', () => {
		const assertDisabled = (doc: EditorState['doc'], selection: EditorState['selection']) => {
			view!.updateState(EditorState.create({ doc, selection, plugins: [menuUpdatePlugin()] }));
			editorViewStore.set(view);
			flushSync();
			expect(select('Text size').disabled).toBe(true);
			expect(select('Paragraph alignment').disabled).toBe(true);
		};

		const table = schema.nodes.table.create(null, schema.nodes.table_row.create(null, [schema.nodes.table_cell.createAndFill()!]));
		const tableDoc = schema.nodes.doc.create(null, table);
		assertDisabled(tableDoc, NodeSelection.create(tableDoc, 0));

		for (const kind of ['raw_latex', 'block_math']) {
			const block = schema.nodes[kind].create(null, schema.text('source'));
			const doc = schema.nodes.doc.create(null, block);
			assertDisabled(doc, NodeSelection.create(doc, 0));
		}

		const list = schema.nodes.list.create({ kind: 'bullet' }, schema.nodes.paragraph.create(null, schema.text('List text')));
		const listDoc = schema.nodes.doc.create(null, list);
		assertDisabled(listDoc, TextSelection.create(listDoc, 2));

		const paragraph = schema.nodes.paragraph.create(null, schema.text('Plain'));
		const heading = schema.nodes.heading.create({ level: 2 }, schema.text('Heading'));
		const mixedDoc = schema.nodes.doc.create(null, [paragraph, heading]);
		assertDisabled(mixedDoc, TextSelection.create(mixedDoc, 1, paragraph.nodeSize + heading.nodeSize - 1));

		view!.setProps({ editable: () => false });
		view!.updateState(
			EditorState.create({ doc: schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('Read only'))) })
		);
		editorViewStore.set(view);
		flushSync();
		expect(select('Text size').disabled).toBe(true);
	});
});
