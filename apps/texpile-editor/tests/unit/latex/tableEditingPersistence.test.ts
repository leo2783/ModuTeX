// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { history, redo, undo } from 'prosemirror-history';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type { Node as PMNode } from 'prosemirror-model';
import { latexToProseMirror } from '$lib/latex-parser/converter';
import { schema } from '$lib/schema/schema';
import { serializeToLatex } from '$lib/serializer/latexSerializer';
import { createTableNode } from '$lib/editor/utils/tableUtils';
import {
	applyTablePreset,
	isTableDimension,
	setTableBottomRule,
	setTableCaption,
	setTableColumnWidth,
	setTableRowRule,
	setTableVerticalLines,
	supportsTableColumnWidth,
	supportsTablePreset,
	type TableEditReceipt,
	type TableNodeTarget
} from '$lib/editor/comp/toolbar/table-preset-commands';

const parse = (source: string): PMNode => latexToProseMirror(source, {}).doc;

function findTable(doc: PMNode): { node: PMNode; pos: number } {
	const found: Array<{ node: PMNode; pos: number }> = [];
	doc.descendants((node, pos) => {
		if (node.type.name === 'table' && found.length === 0) found.push({ node, pos });
	});
	const table = found[0];
	if (!table) throw new Error('Expected the real LaTeX parser to produce a table node');
	return table;
}

function findNode(doc: PMNode, typeName: string): { node: PMNode; pos: number } {
	const found: Array<{ node: PMNode; pos: number }> = [];
	doc.descendants((node, pos) => {
		if (node.type.name === typeName && found.length === 0) found.push({ node, pos });
	});
	const result = found[0];
	if (!result) throw new Error(`Expected the real LaTeX parser to produce a ${typeName} node`);
	return result;
}

function hasNode(doc: PMNode, typeName: string): boolean {
	let found = false;
	doc.descendants((node) => {
		if (node.type.name === typeName) found = true;
	});
	return found;
}

function mountEditor(doc: PMNode): EditorView {
	const host = document.body.appendChild(document.createElement('div'));
	return new EditorView(host, {
		state: EditorState.create({ schema, doc, plugins: [history()] })
	});
}

function runHistoryCommand(view: EditorView, command: typeof undo): boolean {
	return command(view.state, (tr) => view.dispatch(tr));
}

function rowRules(table: PMNode): string[] {
	const rules: string[] = [];
	table.forEach((row) => rules.push(String(row.attrs.topRules ?? '')));
	return rules;
}

function tableTarget(view: EditorView): TableNodeTarget {
	return findTable(view.state.doc);
}

function captionReceipt(view: EditorView): TableEditReceipt {
	return { ...findNode(view.state.doc, 'table_wrapper'), doc: view.state.doc, selection: view.state.selection };
}

function tableCellTextPositions(doc: PMNode): number[] {
	const positions: number[] = [];
	doc.descendants((node, pos) => {
		if (node.type.name === 'table_cell' || node.type.name === 'table_header') positions.push(pos + 2);
	});
	return positions;
}

describe('LaTeX table persistence through parser, ProseMirror history, and serializer', () => {
	it('persists caption position/removal and restores the short caption in one undo', () => {
		const source = String.raw`\begin{table}[t]
\caption[Short title]{A visible caption}
\label{tab:persistence}
\begin{tabular}{cc}
a & b \\
c & d \\
\end{tabular}
\end{table}`;
		const doc = parse(source);
		doc.check();
		const view = mountEditor(doc);
		try {
			const before = serializeToLatex(view.state.doc);
			const originalCaption = findNode(view.state.doc, 'table_caption').node;
			expect(originalCaption.attrs.captionOpt).toBe('Short title');
			expect(findNode(view.state.doc, 'table_wrapper').node.attrs.captionPlacement).toBe('above');

			expect(setTableCaption(view, captionReceipt(view), 'below')).toBe(true);
			const belowLatex = serializeToLatex(view.state.doc);
			let wrapper = findNode(view.state.doc, 'table_wrapper').node;
			expect(wrapper.attrs.captionPlacement).toBe('below');
			expect(findNode(view.state.doc, 'table_caption').node.attrs.captionOpt).toBe('Short title');
			expect(belowLatex.indexOf('\\caption[Short title]') > belowLatex.indexOf('\\end{tabular}')).toBe(true);
			let reopened = parse(belowLatex);
			reopened.check();
			expect(findNode(reopened, 'table_wrapper').node.attrs.captionPlacement).toBe('below');
			expect(findNode(reopened, 'table_caption').node.attrs.captionOpt).toBe('Short title');

			expect(runHistoryCommand(view, undo)).toBe(true);
			expect(serializeToLatex(view.state.doc)).toBe(before);
			expect(findNode(view.state.doc, 'table_wrapper').node.attrs.captionPlacement).toBe('above');
			expect(runHistoryCommand(view, redo)).toBe(true);
			expect(serializeToLatex(view.state.doc)).toBe(belowLatex);

			const beforeRemoval = view.state.doc;
			expect(setTableCaption(view, captionReceipt(view), 'none')).toBe(false);
			expect(view.state.doc).toBe(beforeRemoval);
			expect(serializeToLatex(view.state.doc)).toBe(belowLatex);

			expect(setTableCaption(view, captionReceipt(view), 'none', { allowNonEmptyRemoval: true })).toBe(true);
			const noCaptionLatex = serializeToLatex(view.state.doc);
			expect(findNode(view.state.doc, 'table_wrapper').node.childCount).toBe(1);
			expect(noCaptionLatex).not.toContain('\\caption');
			reopened = parse(noCaptionLatex);
			reopened.check();
			expect(hasNode(reopened, 'table_caption')).toBe(false);

			expect(runHistoryCommand(view, undo)).toBe(true);
			wrapper = findNode(view.state.doc, 'table_wrapper').node;
			expect(wrapper.attrs.captionPlacement).toBe('below');
			expect(findNode(view.state.doc, 'table_caption').node.attrs.captionOpt).toBe('Short title');
			expect(serializeToLatex(view.state.doc)).toBe(belowLatex);
		} finally {
			view.destroy();
		}
	});

	it('rejects destructive caption receipts after the document changes outside the table', () => {
		const doc = parse(String.raw`Text before.

\begin{table}
\caption{Keep this caption}
\begin{tabular}{cc}
a & b \\
c & d \\
\end{tabular}
\end{table}

Trailing text.`);
		const view = mountEditor(doc);
		try {
			const receipt = captionReceipt(view);
			let trailingPos = -1;
			view.state.doc.descendants((node, pos) => {
				if (node.type.name === 'paragraph' && node.textContent === 'Trailing text.') trailingPos = pos + node.nodeSize - 1;
			});
			expect(trailingPos).toBeGreaterThanOrEqual(0);
			view.dispatch(view.state.tr.insertText('!', trailingPos));
			expect(view.state.doc).not.toBe(receipt.doc);
			expect(findNode(view.state.doc, 'table_wrapper').node).toBe(receipt.node);
			expect(receipt.selection.eq(view.state.selection)).toBe(true);
			const before = serializeToLatex(view.state.doc);
			expect(setTableCaption(view, receipt, 'none', { allowNonEmptyRemoval: true })).toBe(false);
			expect(serializeToLatex(view.state.doc)).toBe(before);
		} finally {
			view.destroy();
		}
	});

	it('rejects a destructive caption receipt after the selection changes', () => {
		const doc = parse(String.raw`\begin{table}
\caption{Do not clear stale state}
\begin{tabular}{cc}
a & b \\
c & d \\
\end{tabular}
\end{table}`);
		const view = mountEditor(doc);
		try {
			const receipt = captionReceipt(view);
			const positions = tableCellTextPositions(view.state.doc);
			expect(positions.length).toBeGreaterThan(1);
			const differentPos = positions.find((pos) => !TextSelection.create(view.state.doc, pos).eq(receipt.selection));
			expect(differentPos).toBeDefined();
			view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, differentPos!)));
			const before = serializeToLatex(view.state.doc);
			expect(setTableCaption(view, receipt, 'none', { allowNonEmptyRemoval: true })).toBe(false);
			expect(serializeToLatex(view.state.doc)).toBe(before);
			expect(findNode(view.state.doc, 'table_caption').node.textContent).toBe('Do not clear stale state');
		} finally {
			view.destroy();
		}
	});

	it('writes rule presets to real TeX, reparses them, and undoes/redoes as one edit', () => {
		const source = String.raw`\begin{tabular}{cc}
\hline
head-a & head-b \\
\hline
body-a & body-b \\
\hline
last-a & last-b \\
\hline
\end{tabular}`;
		const doc = parse(source);
		doc.check();
		const view = mountEditor(doc);
		try {
			const { node: originalTable, pos } = findTable(view.state.doc);
			const originalLatex = serializeToLatex(view.state.doc);
			expect(supportsTablePreset(originalTable)).toBe(true);

			expect(applyTablePreset(view, pos, originalTable, 'three-line')).toBe(true);
			const current = findTable(view.state.doc).node;
			expect(rowRules(current)).toEqual(['\\hline', '\\hline', '']);
			expect(current.attrs.bottomRules).toBe('\\hline');
			const serialized = serializeToLatex(view.state.doc);
			expect(serialized.match(/\\hline/g)).toHaveLength(3);
			const reparsed = findTable(parse(serialized)).node;
			expect(rowRules(reparsed)).toEqual(['\\hline', '\\hline', '']);
			expect(reparsed.attrs.bottomRules).toBe('\\hline');

			expect(runHistoryCommand(view, undo)).toBe(true);
			expect(serializeToLatex(view.state.doc)).toBe(originalLatex);
			expect(runHistoryCommand(view, redo)).toBe(true);
			expect(serializeToLatex(view.state.doc)).toBe(serialized);
		} finally {
			view.destroy();
		}
	});

	it('writes column widths as TeX and preserves them through serialize, reopen, and history', () => {
		const source = String.raw`\begin{tabular}{cc}
a & b \\
c & d \\
\end{tabular}`;
		const doc = parse(source);
		const view = mountEditor(doc);
		try {
			const before = serializeToLatex(view.state.doc);
			expect(supportsTableColumnWidth(findTable(view.state.doc).node)).toBe(true);
			expect(setTableColumnWidth(view, tableTarget(view), 0, 0)).toBe(false);
			expect(setTableColumnWidth(view, tableTarget(view), 0, 101)).toBe(false);
			expect(setTableColumnWidth(view, tableTarget(view), 0, 40.5)).toBe(false);
			expect(setTableColumnWidth(view, tableTarget(view), -1, 40)).toBe(false);
			expect(serializeToLatex(view.state.doc)).toBe(before);

			expect(setTableColumnWidth(view, tableTarget(view), 0, 40)).toBe(true);
			let serialized = serializeToLatex(view.state.doc);
			expect(serialized).toContain(String.raw`\begin{tabular}{p{0.4\linewidth}c}`);
			const reopened = parse(serialized);
			reopened.check();
			expect(findTable(reopened).node.attrs.colspec).toBe(String.raw`p{0.4\linewidth}c`);

			expect(runHistoryCommand(view, undo)).toBe(true);
			expect(serializeToLatex(view.state.doc)).toBe(before);
			expect(runHistoryCommand(view, redo)).toBe(true);
			serialized = serializeToLatex(view.state.doc);
			expect(findTable(parse(serialized)).node.attrs.colspec).toBe(String.raw`p{0.4\linewidth}c`);
		} finally {
			view.destroy();
		}
	});

	it('adds/removes horizontal and vertical rules as serializable, undoable table edits', () => {
		const source = String.raw`\begin{tabular}{cc}
a & b \\
c & d \\
\end{tabular}`;
		const doc = parse(source);
		const view = mountEditor(doc);
		try {
			const before = serializeToLatex(view.state.doc);
			expect(setTableRowRule(view, tableTarget(view), 0, '\\hline')).toBe(true);
			const withTopRule = serializeToLatex(view.state.doc);
			expect(withTopRule).toContain('\\hline');
			expect(findTable(parse(withTopRule)).node.child(0).attrs.topRules).toBe('\\hline');
			expect(runHistoryCommand(view, undo)).toBe(true);
			expect(serializeToLatex(view.state.doc)).toBe(before);
			expect(runHistoryCommand(view, redo)).toBe(true);
			expect(serializeToLatex(view.state.doc)).toBe(withTopRule);

			expect(setTableBottomRule(view, tableTarget(view), '\\hline')).toBe(true);
			const withBottomRule = serializeToLatex(view.state.doc);
			expect(withBottomRule.match(/\\hline/g)).toHaveLength(2);
			expect(findTable(parse(withBottomRule)).node.attrs.bottomRules).toBe('\\hline');
			expect(runHistoryCommand(view, undo)).toBe(true);
			expect(serializeToLatex(view.state.doc)).toBe(withTopRule);
			expect(runHistoryCommand(view, redo)).toBe(true);

			expect(setTableVerticalLines(view, tableTarget(view), true)).toBe(true);
			const withVerticalRules = serializeToLatex(view.state.doc);
			expect(withVerticalRules).toContain('\\begin{tabular}{|c|c|}');
			let reopened = parse(withVerticalRules);
			reopened.check();
			expect(findTable(reopened).node.attrs.colspec).toBe('|c|c|');
			expect(findTable(reopened).node.attrs.bottomRules).toBe('\\hline');
			expect(runHistoryCommand(view, undo)).toBe(true);
			expect(serializeToLatex(view.state.doc)).toBe(withBottomRule);
			expect(runHistoryCommand(view, redo)).toBe(true);

			expect(setTableRowRule(view, tableTarget(view), 0, '')).toBe(true);
			expect(setTableBottomRule(view, tableTarget(view), '')).toBe(true);
			expect(setTableVerticalLines(view, tableTarget(view), false)).toBe(true);
			const cleared = serializeToLatex(view.state.doc);
			expect(cleared).not.toContain('\\hline');
			expect(cleared).toContain('\\begin{tabular}{cc}');
			reopened = parse(cleared);
			expect(findTable(reopened).node.attrs.colspec).toBe('cc');
			expect(rowRules(findTable(reopened).node)).toEqual(['', '']);
			expect(findTable(reopened).node.attrs.bottomRules).toBe('');
		} finally {
			view.destroy();
		}
	});

	it.each([
		[
			'custom column instructions',
			String.raw`\begin{tabular}{>{\raggedright\arraybackslash}p{3cm}|c}
a & b \\
c & d \\
\end{tabular}`
		],
		[
			'custom partial vertical and row rules',
			String.raw`\begin{tabular}{c|c}
\specialrule{1pt}{0pt}{2pt}
a & b \\
\cmidrule(lr){1-2}
c & d \\
\specialrule{0.5pt}{0pt}{0pt}
\end{tabular}`
		]
	])('refuses a preset rewrite of %s without changing its parsed source', (_description, source) => {
		const doc = parse(source);
		doc.check();
		const { node: table, pos } = findTable(doc);
		const view = mountEditor(doc);
		try {
			const beforeDoc = view.state.doc;
			const beforeLatex = serializeToLatex(beforeDoc);
			expect(supportsTablePreset(table)).toBe(false);
			expect(applyTablePreset(view, pos, table, 'full-grid')).toBe(false);
			if (_description === 'custom column instructions') {
				expect(supportsTableColumnWidth(table)).toBe(false);
				expect(setTableColumnWidth(view, tableTarget(view), 0, 40)).toBe(false);
				expect(setTableVerticalLines(view, tableTarget(view), true)).toBe(false);
			}
			expect(view.state.doc).toBe(beforeDoc);
			expect(serializeToLatex(view.state.doc)).toBe(beforeLatex);
		} finally {
			view.destroy();
		}
	});

	it('limits a known partial-vertical switch to the requested colspec while retaining custom horizontal rules', () => {
		const doc = parse(String.raw`\begin{tabular}{c|c}
\specialrule{1pt}{0pt}{2pt}
a & b \\
\cmidrule(lr){1-2}
c & d \\
\specialrule{0.5pt}{0pt}{0pt}
\end{tabular}`);
		const view = mountEditor(doc);
		try {
			const initial = findTable(view.state.doc).node;
			const initialRowRules = rowRules(initial);
			const initialBottomRule = initial.attrs.bottomRules;
			expect(setTableVerticalLines(view, tableTarget(view), true)).toBe(true);
			const serialized = serializeToLatex(view.state.doc);
			expect(serialized).toContain('\\begin{tabular}{|c|c|}');
			const reopened = findTable(parse(serialized)).node;
			expect(reopened.attrs.colspec).toBe('|c|c|');
			expect(rowRules(reopened)).toEqual(initialRowRules);
			expect(reopened.attrs.bottomRules).toBe(initialBottomRule);
		} finally {
			view.destroy();
		}
	});

	it('keeps an unmodelled table environment opaque instead of creating editable table structure', () => {
		const source = String.raw`\begin{table}[t]
\centering
\begin{tabulary}{\linewidth}{Lr}
left & right \\
\end{tabulary}
\end{table}`;
		const doc = parse(source);
		doc.check();
		expect(doc.childCount).toBe(1);
		expect(doc.firstChild?.type.name).toBe('raw_latex');
		expect(doc.firstChild?.textContent).toBe(source);
		expect(serializeToLatex(doc)).toBe(source);
	});

	it('enforces the supported dimension bounds and declines preset changes on parsed merged cells', () => {
		expect(isTableDimension(1)).toBe(true);
		expect(isTableDimension(10)).toBe(true);
		expect(isTableDimension(0)).toBe(false);
		expect(isTableDimension(11)).toBe(false);
		expect(isTableDimension(2.5)).toBe(false);
		expect(isTableDimension('10')).toBe(false);
		const maximumTable = createTableNode(schema, 10, 10, false, 'three-line');
		expect(maximumTable.childCount).toBe(10);
		expect(maximumTable.firstChild?.childCount).toBe(10);

		const mergedDoc = parse(String.raw`\begin{tabular}{cc}
\hline
\multicolumn{2}{c}{wide cell} \\
\hline
a & b \\
\hline
\end{tabular}`);
		const { node: merged, pos } = findTable(mergedDoc);
		let hasMerge = false;
		merged.descendants((node) => {
			if ((node.type.name === 'table_cell' || node.type.name === 'table_header') && Number(node.attrs.colspan ?? 1) > 1) {
				hasMerge = true;
			}
		});
		expect(hasMerge).toBe(true);
		const view = mountEditor(mergedDoc);
		try {
			const before = serializeToLatex(view.state.doc);
			expect(supportsTablePreset(merged)).toBe(false);
			expect(supportsTableColumnWidth(merged)).toBe(false);
			expect(applyTablePreset(view, pos, merged, 'full-grid')).toBe(false);
			expect(setTableColumnWidth(view, tableTarget(view), 0, 40)).toBe(false);
			expect(setTableVerticalLines(view, tableTarget(view), true)).toBe(false);
			expect(serializeToLatex(view.state.doc)).toBe(before);
		} finally {
			view.destroy();
		}
	});
});
