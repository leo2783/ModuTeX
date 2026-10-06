import type { Node as PMNode } from 'prosemirror-model';
import { closeHistory } from 'prosemirror-history';
import { addColumn, addRow, CellSelection, selectedRect } from 'prosemirror-tables';
import type { Selection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { get } from 'svelte/store';
import { parseColspec, generateColspec } from '$lib/latex-parser/colspec';
import type { ColspecModel } from '$lib/latex-parser/colspec';
import { isReadOnly } from '$lib/stores/permissionStore';
import type { Dialect } from '$lib/editor/dialect';

export type TablePreset = 'booktabs' | 'three-line' | 'full-grid' | 'horizontal-lines' | 'arydshln';

/** Table-size fields accept only complete integer dimensions; incomplete edits stay uncommitted. */
export function isTableDimension(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 10;
}

export interface TableLayout {
	env: string;
	tabularxWidth: string | null;
	colspec: string;
	rowRules: string[];
	bottomRules: string;
}

const HLINE = '\\hline';
const DASHED_HLINE = '\\hdashline';

export function makeTableLayout(rows: number, cols: number, preset: TablePreset): TableLayout {
	const vertical = preset === 'full-grid';
	const colspec = `${vertical ? '|' : ''}${'c'
		.repeat(cols)
		.split('')
		.join(vertical ? '|' : '')}${vertical ? '|' : ''}`;
	let rowRules: string[];
	let bottomRules: string;
	switch (preset) {
		case 'booktabs':
			rowRules = Array.from({ length: rows }, (_, index) => (index === 0 ? '\\toprule' : index === 1 ? '\\midrule' : ''));
			bottomRules = '\\bottomrule';
			break;
		case 'three-line':
			rowRules = Array.from({ length: rows }, (_, index) => (index === 0 || index === 1 ? HLINE : ''));
			// Keep the promised three equal-weight rules even for a one-row/header-only table.
			bottomRules = rows === 1 ? `${HLINE}\n${HLINE}` : HLINE;
			break;
		case 'full-grid':
		case 'horizontal-lines':
			rowRules = Array.from({ length: rows }, () => HLINE);
			bottomRules = HLINE;
			break;
		case 'arydshln':
			rowRules = Array.from({ length: rows }, () => DASHED_HLINE);
			bottomRules = DASHED_HLINE;
			break;
	}
	return { env: 'tabular', tabularxWidth: null, colspec, rowRules, bottomRules };
}

export function hasMergedCells(table: PMNode): boolean {
	let merged = false;
	table.descendants((node) => {
		if (node.type.name === 'table_cell' || node.type.name === 'table_header') {
			if (Number(node.attrs.colspan ?? 1) > 1 || Number(node.attrs.rowspan ?? 1) > 1) merged = true;
		}
		return !merged;
	});
	return merged;
}

/** Infer the legacy visual serializer layout without changing its appearance. */
export function faithfulLayout(table: PMNode): TableLayout | null {
	const env = typeof table.attrs.env === 'string' ? table.attrs.env : null;
	const colspec = typeof table.attrs.colspec === 'string' ? table.attrs.colspec : null;
	if (env && colspec !== null) {
		const model = parseColspec(colspec);
		if (!model || model.columns.length !== tableWidth(table)) return null;
		return {
			env,
			tabularxWidth: typeof table.attrs.tabularxWidth === 'string' ? table.attrs.tabularxWidth : null,
			colspec,
			rowRules: rowsOf(table).map((row) => String(row.attrs.topRules ?? '')),
			bottomRules: String(table.attrs.bottomRules ?? '')
		};
	}

	const cols = tableWidth(table);
	if (cols < 1) return null;
	const hasHeaderColumn = table.childCount > 1 && table.child(1).childCount > 0 && table.child(1).child(0).type.name === 'table_header';
	const columns = hasHeaderColumn ? `l${'X'.repeat(Math.max(0, cols - 1))}` : 'X'.repeat(cols);
	const colModel = parseColspec(`|${columns.split('').join('|')}|`);
	if (!colModel) return null;
	return {
		env: 'tabularx',
		tabularxWidth: '0.8\\textwidth',
		colspec: generateColspec(colModel),
		rowRules: rowsOf(table).map(() => HLINE),
		bottomRules: HLINE
	};
}

export function supportsTablePreset(table: PMNode): boolean {
	return !hasMergedCells(table) && !containsRawLatex(table) && faithfulLayout(table) !== null && detectTablePreset(table) !== null;
}

/** Keep custom cell macros in source mode rather than rewriting their unknown table semantics. */
function containsRawLatex(table: PMNode): boolean {
	let hasRawLatex = false;
	table.descendants((node) => {
		if (node.type.name === 'raw_latex' || node.type.name === 'inline_latex') hasRawLatex = true;
		return !hasRawLatex;
	});
	return hasRawLatex;
}

export function supportsTableStructure(table: PMNode, dialect: Dialect = 'latex', action?: TableStructureAction): boolean {
	if (dialect === 'markdown' || dialect === 'typst') {
		if (!supportsNativeTableStructure(table)) return false;
		if (dialect === 'typst' && action?.startsWith('column-')) {
			const width = tableWidth(table);
			// The exact insertion index depends on the cell selection. Enable the action only when
			// every possible insertion point can preserve the source track/alignment expressions.
			return Array.from({ length: width + 1 }, (_, index) => insertedTypstColumnAttrs(table, index)).every(Boolean);
		}
		return true;
	}
	const layout = faithfulLayout(table);
	if (!layout || (hasMergedCells(table) && (table.attrs.env == null || table.attrs.colspec == null))) return false;
	const model = parseColspec(layout.colspec);
	return !!model && model.columns.length === tableWidth(table);
}

function supportsNativeTableStructure(table: PMNode): boolean {
	return table.type.name === 'table' && table.childCount > 0 && tableWidth(table) > 0;
}

export function supportsTableColumnWidth(table: PMNode): boolean {
	if (table.type.name !== 'table' || hasMergedCells(table)) return false;
	const layout = faithfulLayout(table);
	const model = layout && parseColspec(layout.colspec);
	return !!model && model.columns.length === tableWidth(table);
}

/** Context-menu capability check for the table at the current selection. */
export function canChangeSelectedTableStructure(view: EditorView, dialect: Dialect, action: TableStructureAction): boolean {
	const selected = selectedTable(view.state);
	return !!selected && supportsTableStructure(selected.table, dialect, action);
}

export function createTablePresetAttrs(table: PMNode, preset: TablePreset): TableLayout | null {
	if (!supportsTablePreset(table)) return null;
	const current = faithfulLayout(table);
	if (!current) return null;
	const model = parseColspec(current.colspec);
	if (!model || model.columns.length !== tableWidth(table)) return null;
	const layout = makeTableLayout(table.childCount, model.columns.length, preset);
	const rules = parseColspec(layout.colspec);
	if (!rules) return null;
	return {
		...current,
		colspec: generateColspec({ ...model, rules: Array.from({ length: model.columns.length + 1 }, () => preset === 'full-grid') }),
		rowRules: layout.rowRules,
		bottomRules: layout.bottomRules
	};
}

export function applyTablePreset(view: EditorView, tablePos: number, expectedNode: PMNode, preset: TablePreset): boolean {
	if (!canEdit(view)) return false;
	const table = view.state.doc.nodeAt(tablePos);
	if (!table || table !== expectedNode || table.type.name !== 'table') return false;
	const layout = createTablePresetAttrs(table, preset);
	if (!layout) return false;
	const tr = view.state.tr.setNodeMarkup(tablePos, undefined, {
		...table.attrs,
		env: layout.env,
		tabularxWidth: layout.tabularxWidth,
		colspec: layout.colspec,
		bottomRules: layout.bottomRules
	});
	setRowRules(tr, tablePos, layout.rowRules);
	view.dispatch(tr);
	return true;
}

export function detectTablePreset(table: PMNode): TablePreset | null {
	const layout = faithfulLayout(table);
	const model = layout && parseColspec(layout.colspec);
	if (!layout || !model) return null;
	const allVertical = model.rules.every(Boolean);
	const noVertical = model.rules.every((rule) => !rule);
	// A partially ruled column specification is custom, not a no-vertical-lines preset.
	if (!allVertical && !noVertical) return null;
	const rowRules = layout.rowRules;
	if (allVertical && rowRules.every((rule) => rule === HLINE) && layout.bottomRules === HLINE) return 'full-grid';
	if (allVertical) return null;
	if (
		rowRules[0] === '\\toprule' &&
		layout.bottomRules === '\\bottomrule' &&
		(rowRules.length < 2 || rowRules[1] === '\\midrule') &&
		rowRules.slice(2).every((rule) => !rule)
	)
		return 'booktabs';
	if (
		rowRules[0] === HLINE &&
		(rowRules.length < 2 || rowRules[1] === HLINE) &&
		rowRules.slice(2).every((rule) => !rule) &&
		(layout.bottomRules === HLINE || (rowRules.length === 1 && layout.bottomRules === `${HLINE}\n${HLINE}`))
	)
		return 'three-line';
	if (rowRules.every((rule) => rule === DASHED_HLINE) && layout.bottomRules === DASHED_HLINE) return 'arydshln';
	if (rowRules.every((rule) => rule === HLINE) && layout.bottomRules === HLINE) return 'horizontal-lines';
	return null;
}

export type TableStructureAction = 'row-before' | 'row-after' | 'column-before' | 'column-after';

export interface TableNodeTarget {
	pos: number;
	node: PMNode;
}

/** Immutable receipt captured before showing an asynchronous destructive confirmation. */
export interface TableEditReceipt extends TableNodeTarget {
	doc: PMNode;
	selection: Selection;
}

export type TableCaptionPlacement = 'none' | 'above' | 'below';

/** Add, move, or remove the optional caption in one history event. A non-empty caption requires
 * an explicit confirmation option and an unchanged document/selection receipt. */
export function setTableCaption(
	view: EditorView,
	target: TableEditReceipt,
	placement: TableCaptionPlacement,
	options: { allowNonEmptyRemoval?: boolean } = {}
): boolean {
	if (!canEdit(view) || target.node.type.name !== 'table_wrapper') return false;
	const { state } = view;
	const wrapper = state.doc.nodeAt(target.pos);
	if (wrapper !== target.node || wrapper.type.name !== 'table_wrapper') return false;

	let caption: PMNode | null = null;
	let captionPos: number | null = null;
	let tablePos: number | null = null;
	wrapper.forEach((child, offset) => {
		if (child.type.name === 'table_caption') {
			caption = child;
			captionPos = target.pos + 1 + offset;
		}
		if (child.type.name === 'table' && tablePos === null) tablePos = target.pos + 1 + offset;
	});
	if (tablePos === null) return false;
	let tr = closeHistory(state.tr);
	let changedContent = false;
	let attrs = wrapper.attrs;

	if (placement === 'none') {
		if (!caption || captionPos === null) return false;
		const nonEmpty = !!caption.textContent.trim() || !!caption.attrs.captionOpt;
		if (nonEmpty) {
			if (!options.allowNonEmptyRemoval || target.doc !== state.doc || !target.selection.eq(state.selection)) return false;
		}
		tr = tr.delete(captionPos, captionPos + caption.nodeSize);
		changedContent = true;
	} else if (!caption) {
		const captionType = wrapper.type.schema.nodes.table_caption;
		if (!captionType) return false;
		const emptyCaption = captionType.createAndFill();
		if (!emptyCaption) return false;
		tr = tr.insert(tablePos, emptyCaption);
		changedContent = true;
	}

	if (placement !== 'none' && wrapper.attrs.captionPlacement !== placement) attrs = { ...wrapper.attrs, captionPlacement: placement };
	if (!changedContent && attrs === wrapper.attrs) return false;
	if (attrs !== wrapper.attrs) tr.setNodeMarkup(target.pos, undefined, attrs);
	view.dispatch(tr);
	return true;
}

export function setTableRowRule(view: EditorView, target: TableNodeTarget, rowIndex: number, rule: string): boolean {
	const table = currentTable(view, target);
	if (!table || !Number.isInteger(rowIndex) || rowIndex < 0 || rowIndex >= table.childCount) return false;
	let rowPos: number | null = null;
	table.forEach((_row, offset, index) => {
		if (index === rowIndex) rowPos = target.pos + 1 + offset;
	});
	if (rowPos === null) return false;
	const row = view.state.doc.nodeAt(rowPos);
	if (!row || String(row.attrs.topRules ?? '') === rule) return false;
	view.dispatch(closeHistory(view.state.tr).setNodeMarkup(rowPos, undefined, { ...row.attrs, topRules: rule }));
	return true;
}

export function setTableBottomRule(view: EditorView, target: TableNodeTarget, rule: string): boolean {
	const table = currentTable(view, target);
	if (!table || String(table.attrs.bottomRules ?? '') === rule) return false;
	view.dispatch(closeHistory(view.state.tr).setNodeMarkup(target.pos, undefined, { ...table.attrs, bottomRules: rule }));
	return true;
}

/** Set or clear every vertical separator only when the full column specification is understood. */
export function setTableVerticalLines(view: EditorView, target: TableNodeTarget, on: boolean): boolean {
	const table = currentTable(view, target);
	if (!table || hasMergedCells(table)) return false;
	const layout = faithfulLayout(table);
	const model = layout && parseColspec(layout.colspec);
	if (!layout || !model || model.columns.length !== tableWidth(table)) return false;
	if (model.rules.every((rule) => rule === on)) return false;
	return updateTableColspec(view, target, table, layout, {
		...model,
		rules: model.rules.map(() => on)
	});
}

/** Width is stored in the compilable TeX colspec, not in a CSS-only cell width. */
export function setTableColumnWidth(view: EditorView, target: TableNodeTarget, columnIndex: number, percent: number): boolean {
	const table = currentTable(view, target);
	if (
		!table ||
		hasMergedCells(table) ||
		!Number.isInteger(columnIndex) ||
		columnIndex < 0 ||
		!Number.isInteger(percent) ||
		percent < 1 ||
		percent > 100
	)
		return false;
	const layout = faithfulLayout(table);
	const model = layout && parseColspec(layout.colspec);
	if (!layout || !model || model.columns.length !== tableWidth(table) || columnIndex >= model.columns.length) return false;
	const ratio = Number((percent / 100).toFixed(3));
	const width = `${ratio}\\linewidth`;
	const nextColumns = model.columns.map((column, index) => (index === columnIndex ? { align: 'p' as const, width } : column));
	if (
		nextColumns[columnIndex].align === model.columns[columnIndex].align &&
		nextColumns[columnIndex].width === model.columns[columnIndex].width
	)
		return false;
	return updateTableColspec(view, target, table, layout, { ...model, columns: nextColumns });
}

function updateTableColspec(view: EditorView, target: TableNodeTarget, table: PMNode, layout: TableLayout, model: ColspecModel): boolean {
	const colspec = generateColspec(model);
	if (colspec === table.attrs.colspec && table.attrs.env === layout.env && table.attrs.tabularxWidth === layout.tabularxWidth) return false;
	view.dispatch(
		closeHistory(view.state.tr).setNodeMarkup(target.pos, undefined, {
			...table.attrs,
			env: layout.env,
			tabularxWidth: layout.tabularxWidth,
			colspec
		})
	);
	return true;
}

function currentTable(view: EditorView, target: TableNodeTarget): PMNode | null {
	if (!canEdit(view) || target.node.type.name !== 'table' || view.state.doc.nodeAt(target.pos) !== target.node) return null;
	return target.node;
}

/** Keep ProseMirror's structural edit and all TeX layout attrs in the same undoable transaction. */
export function changeTableStructure(
	view: EditorView,
	action: TableStructureAction,
	target?: { pos: number; node: PMNode },
	dialect: Dialect = 'latex'
): boolean {
	if (!canEdit(view)) return false;
	const state = view.state;
	const context = target
		? state.doc.nodeAt(target.pos) === target.node && target.node.type.name === 'table'
			? { tablePos: target.pos, table: target.node }
			: null
		: selectedTable(state);
	if (!context) return false;
	const { tablePos, table } = context;
	const nativeDialect = dialect === 'markdown' || dialect === 'typst';
	const oldLayout = dialect === 'latex' ? faithfulLayout(table) : null;
	if (!supportsTableStructure(table, dialect) || (dialect === 'latex' && !oldLayout)) return false;
	const colModel = oldLayout ? parseColspec(oldLayout.colspec) : null;
	if (dialect === 'latex' && (!colModel || colModel.columns.length !== tableWidth(table))) return false;

	let rectState = state;
	if (target) {
		const current = selectedTable(state);
		if (!current || current.tablePos !== tablePos) {
			const firstCellPos = tablePos + 2;
			try {
				rectState = state.apply(state.tr.setSelection(CellSelection.create(state.doc, firstCellPos)));
			} catch {
				return false;
			}
		}
	}
	const rect = selectedRect(rectState);
	if (rect.table !== table) return false;
	const insertionIndex =
		action === 'column-before' ? rect.left : action === 'column-after' ? rect.right : action === 'row-before' ? rect.top : rect.bottom;
	const tr = action.startsWith('column-') ? addColumn(state.tr, rect, insertionIndex) : addRow(state.tr, rect, insertionIndex);
	const updatedTable = tr.doc.nodeAt(tablePos);
	if (!updatedTable || updatedTable.type.name !== 'table') return false;
	if (nativeDialect) {
		if (action.startsWith('row-') && hasHeaderRow(table)) normalizeInsertedHeaderRow(tr, tablePos, insertionIndex);
		if (dialect === 'typst' && action.startsWith('column-')) {
			const attrs = insertedTypstColumnAttrs(table, insertionIndex);
			if (!attrs) return false;
			tr.setNodeMarkup(tablePos, undefined, { ...updatedTable.attrs, ...attrs });
		}
		view.dispatch(tr);
		return true;
	}
	if (!oldLayout || !colModel) return false;

	let nextColspec = oldLayout.colspec;
	let nextRowRules = rowsOf(updatedTable).map((row) => String(row.attrs.topRules ?? ''));
	let nextBottom = oldLayout.bottomRules;
	if (action.startsWith('column-')) {
		const columns = [...colModel.columns];
		const copyIndex = Math.max(0, Math.min(insertionIndex === columns.length ? columns.length - 1 : insertionIndex, columns.length - 1));
		if (copyIndex < 0) return false;
		columns.splice(insertionIndex, 0, { ...columns[copyIndex] });
		const rules = [...colModel.rules];
		const copiedRule = rules[Math.min(insertionIndex, rules.length - 1)] ?? false;
		rules.splice(insertionIndex, 0, copiedRule);
		nextColspec = generateColspec({ columns, rules });
	} else {
		normalizeInsertedHeaderRow(tr, tablePos, insertionIndex);
		const preset = detectTablePreset(table);
		if (preset) {
			const style = makeTableLayout(updatedTable.childCount, colModel.columns.length, preset);
			nextRowRules = style.rowRules;
			nextBottom = style.bottomRules;
		}
	}

	tr.setNodeMarkup(tablePos, undefined, {
		...updatedTable.attrs,
		env: oldLayout.env,
		tabularxWidth: oldLayout.tabularxWidth,
		colspec: nextColspec,
		bottomRules: nextBottom
	});
	setRowRules(tr, tablePos, nextRowRules);
	view.dispatch(tr);
	return true;
}

function setRowRules(tr: Parameters<EditorView['dispatch']>[0], tablePos: number, rules: string[]): void {
	const table = tr.doc.nodeAt(tablePos);
	if (!table || table.type.name !== 'table') return;
	let index = 0;
	table.forEach((row, offset) => {
		const rule = rules[index] ?? '';
		if (String(row.attrs.topRules ?? '') !== rule) {
			tr.setNodeMarkup(tablePos + 1 + offset, undefined, { ...row.attrs, topRules: rule });
		}
		index++;
	});
}

function normalizeInsertedHeaderRow(tr: Parameters<EditorView['dispatch']>[0], tablePos: number, insertedRow: number): void {
	const table = tr.doc.nodeAt(tablePos);
	if (!table || table.type.name !== 'table' || !table.childCount) return;
	let rowIndex = 0;
	table.forEach((row, rowOffset) => {
		let cellOffset = 0;
		row.forEach((cell) => {
			const displacedHeader = insertedRow === 0 && rowIndex > 0 && cell.type.name === 'table_header';
			const isInsertedBody = rowIndex === insertedRow && rowIndex > 0;
			const targetType = rowIndex === 0 ? 'table_header' : displacedHeader || isInsertedBody ? 'table_cell' : cell.type.name;
			if ((cell.type.name === 'table_header' || cell.type.name === 'table_cell') && cell.type.name !== targetType) {
				const type = tr.doc.type.schema.nodes[targetType];
				if (type) tr.setNodeMarkup(tablePos + 2 + rowOffset + cellOffset, type, cell.attrs);
			}
			cellOffset += cell.nodeSize;
		});
		rowIndex++;
	});
}

function hasHeaderRow(table: PMNode): boolean {
	if (!table.childCount || !table.child(0).childCount) return false;
	let allHeader = true;
	table.child(0).forEach((cell) => {
		if (cell.type.name !== 'table_header') allHeader = false;
	});
	return allHeader;
}

/** Keep Typst track sizing/alignment in step with a new physical column.
 * Scalar alignment applies uniformly and stays verbatim. Unknown or stale expressions fail
 * closed because the serializer intentionally drops stale tuples rather than misaligning cells. */
function insertedTypstColumnAttrs(table: PMNode, insertionIndex: number): Record<string, string | null> | null {
	const width = tableWidth(table);
	const columns = insertTypstTupleItem(table.attrs.colspec, width, insertionIndex, 'column');
	if (!columns) return null;
	let align: string | null = typeof table.attrs.typAlign === 'string' ? table.attrs.typAlign : null;
	if (align) {
		const trimmed = align.trim();
		if (trimmed.startsWith('(') || trimmed.startsWith('[')) {
			const updated = insertTypstTupleItem(trimmed, width, insertionIndex, 'align');
			if (!updated) return null;
			align = updated;
		}
	}
	return { colspec: columns, typAlign: align };
}

function insertTypstTupleItem(value: unknown, width: number, insertionIndex: number, kind: 'column' | 'align'): string | null {
	const raw = typeof value === 'string' ? value.trim() : '';
	if (kind === 'column' && raw === '') return String(width + 1);
	if (kind === 'column' && /^\d+$/.test(raw) && Number(raw) === width) return String(width + 1);

	const open = raw[0];
	const close = open === '(' ? ')' : open === '[' ? ']' : '';
	if (!close || !raw.endsWith(close) || /[()[\]{}"']/.test(raw.slice(1, -1))) return null;
	const items = raw
		.slice(1, -1)
		.split(',')
		.map((item) => item.trim());
	if (items.length !== width || items.some((item) => !isSafeTypstTupleItem(item, kind))) return null;
	const copyIndex = Math.max(0, Math.min(insertionIndex === width ? width - 1 : insertionIndex, width - 1));
	if (copyIndex < 0) return null;
	items.splice(insertionIndex, 0, items[copyIndex]);
	return `${open}${items.join(', ')}${close}`;
}

function isSafeTypstTupleItem(item: string, kind: 'column' | 'align'): boolean {
	if (kind === 'align') return /^(left|center|right|start|end|top|bottom|horizon)$/.test(item);
	return item === 'auto' || /^(?:\d+(?:\.\d+)?|\.\d+)(?:fr|cm|mm|pt|in|em)$/.test(item);
}

function tableWidth(table: PMNode): number {
	let width = 0;
	if (table.childCount) table.child(0).forEach((cell) => (width += Number(cell.attrs.colspan ?? 1)));
	return width;
}

function rowsOf(table: PMNode): PMNode[] {
	const rows: PMNode[] = [];
	table.forEach((row) => rows.push(row));
	return rows;
}

function selectedTable(state: EditorView['state']): { tablePos: number; table: PMNode } | null {
	const $pos = state.selection.$head;
	for (let depth = $pos.depth; depth >= 0; depth--) {
		const node = $pos.node(depth);
		if (node.type.name === 'table') return { tablePos: $pos.before(depth), table: node };
	}
	return null;
}

function canEdit(view: EditorView): boolean {
	return view.dom.isConnected && view.editable && !get(isReadOnly);
}
