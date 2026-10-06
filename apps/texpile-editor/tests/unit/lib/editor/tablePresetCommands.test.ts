// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '$lib/schema/schema';
import type { Node as PMNode } from 'prosemirror-model';
import { createTableNode } from '$lib/editor/utils/tableUtils';
import {
	applyTablePreset,
	changeTableStructure,
	createTablePresetAttrs,
	detectTablePreset,
	faithfulLayout,
	isTableDimension,
	makeTableLayout,
	supportsTablePreset,
	type TableStructureAction
} from '$lib/editor/comp/toolbar/table-preset-commands';

function filledTable(): PMNode {
	const template = createTableNode(schema, 2, 2, false, 'three-line');
	const content = [
		['header-left', 'header-right'],
		['body-left', 'body-right']
	];
	const rows = content.map((cells, rowIndex) => {
		const cellType = rowIndex === 0 ? schema.nodes.table_header : schema.nodes.table_cell;
		const row = template.child(rowIndex);
		return schema.nodes.table_row.create(
			row.attrs,
			cells.map((text) => cellType.createAndFill(null, schema.nodes.paragraph.create(null, schema.text(text))))
		);
	});
	return schema.nodes.table.create(template.attrs, rows);
}

function mountTable(table: PMNode, selectedCellIndex = 0) {
	const doc = schema.nodes.doc.create(null, table);
	const cellPositions: number[] = [];
	doc.descendants((node, pos) => {
		if (node.type.name === 'table_header' || node.type.name === 'table_cell') cellPositions.push(pos);
	});
	const view = new EditorView(document.body.appendChild(document.createElement('div')), {
		state: EditorState.create({ schema, doc, selection: TextSelection.create(doc, cellPositions[selectedCellIndex] + 2) })
	});
	return { view, cellPositions };
}

function tableRows(table: PMNode): string[][] {
	const rows: string[][] = [];
	table.forEach((row) => {
		const values: string[] = [];
		row.forEach((cell) => values.push(cell.textContent));
		rows.push(values);
	});
	return rows;
}

describe('table preset commands', () => {
	it.each([1, 2, 10])('accepts table dimension %i', (value) => {
		expect(isTableDimension(value)).toBe(true);
	});

	it.each([undefined, null, Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, 11, '2'])(
		'rejects incomplete or out-of-range table dimension %p',
		(value) => {
			expect(isTableDimension(value)).toBe(false);
		}
	);

	it('keeps booktabs and equal-weight hline three-line styles distinct', () => {
		expect(makeTableLayout(3, 2, 'booktabs')).toMatchObject({
			colspec: 'cc',
			rowRules: ['\\toprule', '\\midrule', ''],
			bottomRules: '\\bottomrule'
		});
		expect(makeTableLayout(3, 2, 'three-line')).toMatchObject({
			rowRules: ['\\hline', '\\hline', ''],
			bottomRules: '\\hline'
		});
		expect(makeTableLayout(1, 2, 'three-line').bottomRules.split('\n')).toEqual(['\\hline', '\\hline']);
		expect(makeTableLayout(3, 2, 'full-grid').colspec).toBe('|c|c|');
		expect(makeTableLayout(3, 2, 'horizontal-lines').colspec).toBe('cc');
		expect(makeTableLayout(3, 2, 'horizontal-lines').rowRules).toEqual(['\\hline', '\\hline', '\\hline']);
		expect(makeTableLayout(3, 2, 'arydshln')).toMatchObject({
			rowRules: ['\\hdashline', '\\hdashline', '\\hdashline'],
			bottomRules: '\\hdashline'
		});
	});

	it('applies real arydshln commands without changing table content', () => {
		const { view } = mountTable(filledTable());
		try {
			const originalText = view.state.doc.textContent;
			const table = view.state.doc.firstChild!;
			expect(applyTablePreset(view, 0, table, 'arydshln')).toBe(true);
			const updated = view.state.doc.firstChild!;
			expect(updated.child(0).attrs.topRules).toBe('\\hdashline');
			expect(updated.child(1).attrs.topRules).toBe('\\hdashline');
			expect(updated.attrs.bottomRules).toBe('\\hdashline');
			expect(view.state.doc.textContent).toBe(originalText);
		} finally {
			view.destroy();
		}
	});

	it('creates faithful tabular attrs with the first row represented as header cells', () => {
		const table = createTableNode(schema, 2, 2, false, 'three-line');
		expect(table.attrs).toMatchObject({ env: 'tabular', colspec: 'cc', bottomRules: '\\hline' });
		expect(table.child(0).child(0).type.name).toBe('table_header');
		expect(table.child(1).child(0).type.name).toBe('table_cell');
	});

	it('applies one faithful preset transaction without changing table contents', () => {
		const { view } = mountTable(filledTable());
		const dispatch = vi.spyOn(view, 'dispatch');
		try {
			const originalText = view.state.doc.textContent;
			const table = view.state.doc.firstChild!;
			expect(applyTablePreset(view, 0, table, 'full-grid')).toBe(true);
			expect(dispatch).toHaveBeenCalledTimes(1);
			expect(view.state.doc.textContent).toBe(originalText);
			expect(view.state.doc.firstChild?.attrs.colspec).toBe('|c|c|');
			expect(view.state.doc.firstChild?.child(0).attrs.topRules).toBe('\\hline');
			expect(view.state.doc.firstChild?.child(1).attrs.topRules).toBe('\\hline');
			expect(view.state.doc.firstChild?.attrs.bottomRules).toBe('\\hline');
		} finally {
			dispatch.mockRestore();
			view.destroy();
		}
	});

	const structureCases: Array<{
		action: TableStructureAction;
		selectedCell: number;
		rows: string[][];
		colspec: string;
	}> = [
		{
			action: 'column-before',
			selectedCell: 0,
			rows: [
				['', 'header-left', 'header-right'],
				['', 'body-left', 'body-right']
			],
			colspec: 'ccc'
		},
		{
			action: 'column-after',
			selectedCell: 3,
			rows: [
				['header-left', 'header-right', ''],
				['body-left', 'body-right', '']
			],
			colspec: 'ccc'
		},
		{
			action: 'row-before',
			selectedCell: 0,
			rows: [
				['', ''],
				['header-left', 'header-right'],
				['body-left', 'body-right']
			],
			colspec: 'cc'
		},
		{
			action: 'row-after',
			selectedCell: 3,
			rows: [
				['header-left', 'header-right'],
				['body-left', 'body-right'],
				['', '']
			],
			colspec: 'cc'
		}
	];

	it.each(structureCases)(
		'$action uses the selectedRect boundary and preserves every cell in one transaction',
		({ action, selectedCell, rows, colspec }) => {
			const { view } = mountTable(filledTable(), selectedCell);
			const dispatch = vi.spyOn(view, 'dispatch');
			try {
				const oldText = view.state.doc.textContent;
				expect(changeTableStructure(view, action)).toBe(true);
				expect(dispatch).toHaveBeenCalledTimes(1);
				const updated = view.state.doc.firstChild!;
				expect(updated.attrs.colspec).toBe(colspec);
				expect(tableRows(updated)).toEqual(rows);
				expect(updated.textContent).toBe(oldText);
				expect(updated.child(0).child(0).type.name).toBe('table_header');
				expect(updated.child(1).child(0).type.name).toBe('table_cell');
			} finally {
				dispatch.mockRestore();
				view.destroy();
			}
		}
	);

	it('preserves parsed column alignment and width when it adds a column', () => {
		const { view } = mountTable(createTableNode(schema, 2, 2, false));
		try {
			const current = view.state.doc.firstChild!;
			view.dispatch(view.state.tr.setNodeMarkup(0, undefined, { ...current.attrs, colspec: '|p{3cm}|r|', env: 'tabular' }));
			expect(changeTableStructure(view, 'column-after')).toBe(true);
			expect(view.state.doc.firstChild?.attrs.colspec).toBe('|p{3cm}|r|r|');
		} finally {
			view.destroy();
		}
	});

	it('fails closed for merged cells and unknown raw column specifications', () => {
		const cell = schema.nodes.table_cell.create({ colspan: 2 }, schema.nodes.paragraph.create());
		const row = schema.nodes.table_row.create(null, [cell]);
		const merged = schema.nodes.table.create({ env: 'tabular', colspec: 'cc' }, [row]);
		expect(supportsTablePreset(merged)).toBe(false);
		const unknown = schema.nodes.table.create({ env: 'tabular', colspec: '>{\\raggedright}c' }, [
			schema.nodes.table_row.create(null, [schema.nodes.table_cell.createAndFill(), schema.nodes.table_cell.createAndFill()])
		]);
		expect(faithfulLayout(unknown)).toBeNull();
		expect(createTablePresetAttrs(unknown, 'full-grid')).toBeNull();
	});

	it('does not offer preset replacement for custom parsed row rules', () => {
		const template = filledTable();
		const custom = template.type.create({ ...template.attrs, bottomRules: '\\specialrule{1pt}{0pt}{2pt}' }, template.content);
		expect(faithfulLayout(custom)).not.toBeNull();
		expect(supportsTablePreset(custom)).toBe(false);
		expect(createTablePresetAttrs(custom, 'horizontal-lines')).toBeNull();
	});

	it('does not classify booktabs with custom rules after the midrule as a preset', () => {
		const template = filledTable();
		const rows = [
			template.child(0).type.create({ ...template.child(0).attrs, topRules: '\\toprule' }, template.child(0).content),
			template.child(1).type.create({ ...template.child(1).attrs, topRules: '\\midrule' }, template.child(1).content),
			template.child(1).type.create({ ...template.child(1).attrs, topRules: '\\cmidrule(lr){1-2}' }, template.child(1).content)
		];
		const custom = template.type.create({ ...template.attrs, bottomRules: '\\bottomrule' }, rows);
		const { view } = mountTable(custom);
		try {
			expect(detectTablePreset(custom)).toBeNull();
			expect(supportsTablePreset(custom)).toBe(false);
			expect(applyTablePreset(view, 0, custom, 'horizontal-lines')).toBe(false);
			expect(view.state.doc.firstChild).toBe(custom);
		} finally {
			view.destroy();
		}
	});

	it('does not classify partial vertical rules as a horizontal-line preset', () => {
		const template = filledTable();
		const custom = template.type.create({ ...template.attrs, colspec: 'c|c' }, template.content);
		expect(detectTablePreset(custom)).toBeNull();
		expect(supportsTablePreset(custom)).toBe(false);
		expect(createTablePresetAttrs(custom, 'full-grid')).toBeNull();
	});

	it('keeps custom row rules and bottom rule when inserting a row', () => {
		const template = filledTable();
		const row = (index: number, topRules: string) =>
			template.child(index % 2).type.create(
				{ ...template.child(index % 2).attrs, topRules },
				[0, 1].map((column) => {
					const cellType = index === 0 ? schema.nodes.table_header : schema.nodes.table_cell;
					return cellType.createAndFill(null, schema.nodes.paragraph.create(null, schema.text(`row-${index}-col-${column}`)));
				})
			);
		const custom = schema.nodes.table.create({ ...template.attrs, colspec: 'c|c', bottomRules: '\\specialrule{1pt}{0pt}{2pt}' }, [
			row(0, '\\toprule'),
			row(1, '\\cmidrule(lr){1-2}'),
			row(2, '\\specialrule{0.5pt}{0pt}{0pt}')
		]);
		const { view } = mountTable(custom, 2);
		try {
			expect(detectTablePreset(custom)).toBeNull();
			expect(changeTableStructure(view, 'row-after')).toBe(true);
			const updated = view.state.doc.firstChild!;
			expect(updated.childCount).toBe(4);
			expect(updated.child(0).attrs.topRules).toBe('\\toprule');
			expect(updated.child(1).attrs.topRules).toBe('\\cmidrule(lr){1-2}');
			expect(updated.child(3).attrs.topRules).toBe('\\specialrule{0.5pt}{0pt}{0pt}');
			expect(updated.attrs.bottomRules).toBe('\\specialrule{1pt}{0pt}{2pt}');
		} finally {
			view.destroy();
		}
	});
});
