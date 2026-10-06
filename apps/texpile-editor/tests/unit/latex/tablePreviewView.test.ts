// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { history, redo, undo } from 'prosemirror-history';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { columnResizing, columnResizingPluginKey } from 'prosemirror-tables';
import type { Node as PMNode } from 'prosemirror-model';
import { latexToProseMirror } from '$lib/latex-parser/converter';
import { schema } from '$lib/schema/schema';
import { serializeToLatex } from '$lib/serializer/latexSerializer';
import {
	setTableBottomRule,
	setTableColumnWidth,
	setTableRowRule,
	setTableVerticalLines
} from '$lib/editor/comp/toolbar/table-preset-commands';
import { createTableResizeGuardPlugin, persistNativeTableResize, TablePreviewView } from '$lib/editor/extensions/table/tablePreviewView';

const views: EditorView[] = [];

afterEach(() => {
	for (const view of views.splice(0)) view.destroy();
	document.body.replaceChildren();
});

function parse(source: string): PMNode {
	return latexToProseMirror(source, {}).doc;
}

function findTable(doc: PMNode): { node: PMNode; pos: number } {
	let found: { node: PMNode; pos: number } | null = null;
	doc.descendants((node, pos) => {
		if (!found && node.type.name === 'table') found = { node, pos };
	});
	if (!found) throw new Error('Expected the LaTeX parser to produce a table node');
	return found;
}

function createEditor(source: string): EditorView {
	const host = document.body.appendChild(document.createElement('div'));
	const doc = parse(source);
	const view = new EditorView(host, {
		state: EditorState.create({
			schema,
			doc,
			plugins: [createTableResizeGuardPlugin(), columnResizing({ View: TablePreviewView }), history()]
		})
	});
	views.push(view);
	return view;
}

const flushMutationObserver = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('LaTeX table visual preview', () => {
	it('renders persisted column widths and rules in the real ProseMirror TableView DOM', async () => {
		const view = createEditor(String.raw`\begin{tabular}{|p{0.4\linewidth}|c|}
\hline
a & b \\
c & d \\
\hline
\end{tabular}`);
		await flushMutationObserver();

		const table = view.dom.querySelector<HTMLTableElement>('table[data-table-preview="true"]');
		expect(table).not.toBeNull();
		expect(table?.querySelectorAll('col').item(0)?.style.width).toBe('40cqw');
		const firstCell = table?.querySelector('tbody tr:first-child td');
		expect(firstCell?.getAttribute('data-table-preview-top')).toBe('solid');
		expect(firstCell?.getAttribute('data-table-preview-left')).toBe('true');
		expect(firstCell?.getAttribute('data-table-preview-right')).toBe('true');

		const initial = findTable(view.state.doc);
		expect(setTableColumnWidth(view, initial, 0, 50)).toBe(true);
		expect(view.dom.querySelectorAll<HTMLTableColElement>('table col').item(0)?.style.width).toBe('50cqw');
		expect(serializeToLatex(view.state.doc)).toContain('p{0.5\\linewidth}');
		expect(undo(view.state, (transaction) => view.dispatch(transaction))).toBe(true);
		expect(view.dom.querySelectorAll<HTMLTableColElement>('table col').item(0)?.style.width).toBe('40cqw');
		expect(serializeToLatex(view.state.doc)).toContain('p{0.4\\linewidth}');
		expect(redo(view.state, (transaction) => view.dispatch(transaction))).toBe(true);
		expect(view.dom.querySelectorAll<HTMLTableColElement>('table col').item(0)?.style.width).toBe('50cqw');
		const reopened = parse(serializeToLatex(view.state.doc));
		expect(findTable(reopened).node.attrs.colspec).toContain('p{0.5\\linewidth}');
		let current = findTable(view.state.doc);

		expect(setTableRowRule(view, current, 0, '\\toprule')).toBe(true);
		current = findTable(view.state.doc);
		expect(view.dom.querySelector('tbody tr:first-child td')?.getAttribute('data-table-preview-top')).toBe('heavy');
		expect(setTableBottomRule(view, current, '\\bottomrule')).toBe(true);
		expect(view.dom.querySelector('tbody tr:last-child td')?.getAttribute('data-table-preview-bottom')).toBe('heavy');
		current = findTable(view.state.doc);
		expect(setTableVerticalLines(view, current, false)).toBe(true);
		expect(view.dom.querySelector('tbody tr:first-child td')?.hasAttribute('data-table-preview-left')).toBe(false);
	});

	it('does not preview opaque or merged source and leaves ordinary cell transactions alone', async () => {
		const opaqueView = createEditor(String.raw`\begin{tabular}{>{\bfseries}c}
a \\
\end{tabular}`);
		await flushMutationObserver();
		expect(opaqueView.dom.querySelector('table[data-table-preview="true"]')).toBeNull();
		const opaqueCell = opaqueView.dom.querySelector('td');
		expect(opaqueCell?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(true);

		const mergedView = createEditor(String.raw`\begin{tabular}{cc}
\multicolumn{2}{c}{merged} \\
\end{tabular}`);
		await flushMutationObserver();
		expect(mergedView.dom.querySelector('table[data-table-preview="true"]')).toBeNull();

		const normalView = createEditor(String.raw`\begin{tabular}{cc}
a & b \\
\end{tabular}`);
		const table = findTable(normalView.state.doc);
		const cell = table.node.child(0).child(0);
		const cellPos = table.pos + 2;
		const transaction = normalView.state.tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, colwidth: [88] });
		expect(persistNativeTableResize(transaction, normalView)).toBe('ignored');
		normalView.dispatch(transaction);
		expect(findTable(normalView.state.doc).node.attrs.colspec).toBe(table.node.attrs.colspec);
	});

	it('does not consume a click when the hovered resize handle belongs to opaque source', async () => {
		const view = createEditor(String.raw`\begin{tabular}{>{\bfseries}c}
a \\
\end{tabular}`);
		await flushMutationObserver();
		const { pos } = findTable(view.state.doc);
		const cellPosition = pos + 2;
		view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: cellPosition }));
		const guard = createTableResizeGuardPlugin();
		const handler = guard.props.handleDOMEvents?.mousedown;
		expect(handler).toBeTypeOf('function');
		const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0, clientX: 1, clientY: 1 });
		handler?.call(guard, view, event);
		expect(event.defaultPrevented).toBe(false);
		expect(columnResizingPluginKey.getState(view.state)?.activeHandle).toBe(-1);
	});
});
