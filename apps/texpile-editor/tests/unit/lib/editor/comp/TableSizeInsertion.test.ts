// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView as ProseMirrorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState as CodeMirrorState } from '@codemirror/state';
import { EditorView as CodeMirrorView } from '@codemirror/view';
import { editorViewStore, sourceCmView } from '$lib/stores/editorStore';
import { schema } from '$lib/schema/schema';
import ToolbarTable from '$lib/editor/comp/toolbar/ToolbarTable.svelte';
import SourceTableDropdown from '$lib/editor/comp/toolbar/SourceTableDropdown.svelte';

let host: HTMLDivElement;
let editorHost: HTMLDivElement;
let app: Record<string, unknown> | null = null;
let visualView: ProseMirrorView | null = null;
let sourceView: CodeMirrorView | null = null;

beforeEach(() => {
	host = document.body.appendChild(document.createElement('div'));
	editorHost = document.body.appendChild(document.createElement('div'));
});

afterEach(async () => {
	if (app) await unmount(app);
	app = null;
	visualView?.destroy();
	visualView = null;
	sourceView?.destroy();
	sourceView = null;
	editorViewStore.set(null);
	sourceCmView.set(null);
	for (const element of [...document.body.children]) element.remove();
});

function setNumber(input: HTMLInputElement, value: string) {
	input.value = value;
	input.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

function openForm(): HTMLFormElement {
	host.querySelector<HTMLButtonElement>('button[aria-label]')!.click();
	flushSync();
	const form = document.body.querySelector<HTMLFormElement>('form');
	if (!form) throw new Error('Table size form did not open');
	return form;
}

function numberInputs(form: HTMLFormElement): [HTMLInputElement, HTMLInputElement] {
	const inputs = form.querySelectorAll<HTMLInputElement>('input[type="number"]');
	if (inputs.length !== 2) throw new Error(`Expected two table dimension inputs, got ${inputs.length}`);
	return [inputs[0], inputs[1]];
}

function mountVisual() {
	const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create());
	visualView = new ProseMirrorView(editorHost, {
		state: EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1) })
	});
	editorViewStore.set(visualView);
	app = mount(ToolbarTable, { target: host });
	flushSync();
}

function mountSource() {
	sourceView = new CodeMirrorView({ parent: editorHost, state: CodeMirrorState.create({ doc: '' }) });
	sourceCmView.set(sourceView);
	app = mount(SourceTableDropdown, { target: host });
	flushSync();
}

function expectVisualTableSize(rowCount: number, columnCount: number) {
	let table: PMNode | null = null;
	visualView?.state.doc.descendants((node) => {
		if (node.type.name === 'table') table = node;
	});
	expect(table, `manual table insertion did not create a table: ${JSON.stringify(visualView?.state.doc.toJSON())}`).toBeTruthy();
	expect(table?.childCount).toBe(rowCount);
	expect(table?.child(0).childCount).toBe(columnCount);
}

function expectSourceTableSize(rowCount: number, columnCount: number) {
	const source = sourceView!.state.doc.toString();
	const colspec = source.match(/\\begin\{tabular\}\{([^}]*)\}/)?.[1];
	expect(colspec).toHaveLength(columnCount);
	const bodyRows = source.split('\n').filter((line) => line.includes('&'));
	expect(bodyRows).toHaveLength(rowCount);
	for (const row of bodyRows) expect(row.match(/&/g)).toHaveLength(columnCount - 1);
}

describe('manual table size insertion', () => {
	it('inserts the entered visual dimensions with the explicit button', () => {
		mountVisual();
		const form = openForm();
		const [rows, columns] = numberInputs(form);
		setNumber(rows, '3');
		setNumber(columns, '4');
		form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
		flushSync();
		expectVisualTableSize(3, 4);
	});

	it('submits valid visual dimensions from the keyboard form path', () => {
		mountVisual();
		const form = openForm();
		const [rows, columns] = numberInputs(form);
		setNumber(rows, '4');
		setNumber(columns, '3');
		rows.focus();
		rows.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		form.requestSubmit();
		flushSync();
		expectVisualTableSize(4, 3);
	});

	it.each([
		['', '2'],
		['2.5', '2'],
		['11', '2']
	])('does not insert an invalid visual dimension (%p, %p)', (rowValue, columnValue) => {
		mountVisual();
		const original = visualView!.state.doc;
		const form = openForm();
		const [rows, columns] = numberInputs(form);
		setNumber(rows, rowValue);
		setNumber(columns, columnValue);
		form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
		flushSync();
		expect(visualView!.state.doc).toBe(original);
	});

	it('keeps the visual grid insert independent of incomplete numeric edits', () => {
		mountVisual();
		const form = openForm();
		const [rows] = numberInputs(form);
		setNumber(rows, '');
		const gridButtons = form.querySelectorAll<HTMLButtonElement>('button.h-6.w-6');
		expect(gridButtons).toHaveLength(100);
		gridButtons[(3 - 1) * 10 + (4 - 1)].click();
		flushSync();
		expectVisualTableSize(3, 4);
	});

	it('inserts the entered source dimensions through Enter submission', () => {
		mountSource();
		const form = openForm();
		const [rows, columns] = numberInputs(form);
		setNumber(rows, '4');
		setNumber(columns, '3');
		rows.focus();
		rows.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
		form.requestSubmit();
		flushSync();
		expectSourceTableSize(4, 3);
	});

	it.each([
		['', '2'],
		['2.5', '2'],
		['2', '11']
	])('does not insert an invalid source dimension (%p, %p)', (rowValue, columnValue) => {
		mountSource();
		const form = openForm();
		const [rows, columns] = numberInputs(form);
		setNumber(rows, rowValue);
		setNumber(columns, columnValue);
		form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click();
		flushSync();
		expect(sourceView!.state.doc.toString()).toBe('');
	});

	it('keeps the source grid insert independent of incomplete numeric edits', () => {
		mountSource();
		const form = openForm();
		const [rows] = numberInputs(form);
		setNumber(rows, '');
		const gridButtons = form.querySelectorAll<HTMLButtonElement>('button.h-6.w-6');
		expect(gridButtons).toHaveLength(100);
		gridButtons[(3 - 1) * 10 + (4 - 1)].click();
		flushSync();
		expectSourceTableSize(3, 4);
	});
});
