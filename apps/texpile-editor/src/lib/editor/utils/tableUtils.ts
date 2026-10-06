import type { Schema } from 'prosemirror-model';
import { generateLabel } from './label';
import { makeTableLayout, type TablePreset } from '$lib/editor/comp/toolbar/table-preset-commands';

/** builds a table node; numbered tables get a table_wrapper with caption and notes. */
export function createTableNode(schema: Schema, rows: number, cols: number, isNumbered = true, preset: TablePreset = 'full-grid') {
	function createEmptyParagraph(schema: Schema) {
		return schema.nodes.paragraph.createAndFill();
	}

	const layout = makeTableLayout(rows, cols, preset);
	const rowsArray = [];
	for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
		const cells = [];
		for (let colIndex = 0; colIndex < cols; colIndex++) {
			const emptyParagraph = createEmptyParagraph(schema);
			const cellType = rowIndex === 0 ? schema.nodes.table_header : schema.nodes.table_cell;
			const cell = cellType.createAndFill(null, emptyParagraph);
			cells.push(cell);
		}
		const row = schema.nodes.table_row.create({ topRules: layout.rowRules[rowIndex] }, cells);
		rowsArray.push(row);
	}
	const table = schema.nodes.table.create(
		{
			env: layout.env,
			tabularxWidth: layout.tabularxWidth,
			colspec: layout.colspec,
			bottomRules: layout.bottomRules
		},
		rowsArray
	);

	if (!isNumbered) {
		return table;
	}

	// placeholder caption text so LaTeX numbers the table
	const captionText = schema.text('Table caption');
	const caption = schema.nodes.table_caption.create(null, captionText);

	const notes = schema.nodes.table_notes.create();

	const tableLabel = generateLabel('table');

	return schema.nodes.table_wrapper.create({ label: tableLabel, showNotes: false }, [caption, table, notes]);
}
