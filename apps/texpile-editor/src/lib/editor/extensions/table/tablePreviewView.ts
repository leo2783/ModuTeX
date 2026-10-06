import type { Node as PMNode } from 'prosemirror-model';
import { closeHistory } from 'prosemirror-history';
import { Plugin, type Transaction } from 'prosemirror-state';
import { ReplaceAroundStep } from 'prosemirror-transform';
import { columnResizingPluginKey, TableMap, TableView, updateColumnsOnResize } from 'prosemirror-tables';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { generateColspec, parseColspec, type ColspecModel } from '$lib/latex-parser/colspec';

const PREVIEW_CELL_ATTRIBUTES = [
	'data-table-preview-top',
	'data-table-preview-bottom',
	'data-table-preview-left',
	'data-table-preview-right'
] as const;

type PreviewRule = 'solid' | 'heavy' | 'dashed' | 'double';
type ResizeResult = 'ignored' | 'applied' | 'rejected';

interface TableAtPosition {
	pos: number;
	node: PMNode;
	map: TableMap;
}

interface NativeResize {
	table: TableAtPosition;
	column: number;
	width: number;
}

const refreshAfterRejectedResize = new WeakSet<EditorView>();
const previewViews = new WeakMap<EditorView, Set<TablePreviewView>>();

/** A ProseMirror TableView that previews only layout attrs the LaTeX renderer understands. */
export class TablePreviewView extends TableView {
	private readonly editorView?: EditorView;

	constructor(node: PMNode, defaultCellMinWidth: number, editorView?: EditorView) {
		super(node, defaultCellMinWidth);
		this.editorView = editorView;
		if (editorView) {
			const instances = previewViews.get(editorView) ?? new Set<TablePreviewView>();
			instances.add(this);
			previewViews.set(editorView, instances);
		}
		this.renderPreview(node);
	}

	update(node: PMNode): boolean {
		if (!super.update(node)) return false;
		this.renderPreview(node);
		return true;
	}

	destroy(): void {
		if (!this.editorView) return;
		const instances = previewViews.get(this.editorView);
		instances?.delete(this);
		if (instances?.size === 0) previewViews.delete(this.editorView);
	}

	refreshFromPersistedAttrs(): void {
		updateColumnsOnResize(this.node, this.colgroup, this.table, this.defaultCellMinWidth);
		this.renderPreview(this.node);
	}

	private renderPreview(node: PMNode): void {
		const model = getSafePreviewModel(node);
		if (!model) {
			setAttributeIfChanged(this.table, 'data-table-preview', null);
			setStyleIfChanged(this.table, 'width', '');
			setStyleIfChanged(this.table, 'min-width', '');
			for (const column of Array.from(this.colgroup.children) as HTMLTableColElement[]) setStyleIfChanged(column, 'width', '');
			return;
		}

		setAttributeIfChanged(this.table, 'data-table-preview', 'true');
		setStyleIfChanged(this.table, 'width', model.tableWidth || 'auto');
		setStyleIfChanged(this.table, 'min-width', '');
		const columns = Array.from(this.colgroup.children) as HTMLTableColElement[];
		for (const [index, column] of columns.entries()) {
			setStyleIfChanged(column, 'width', cssWidthForColumn(model.columns[index]?.width) ?? '');
		}
	}
}

/** Restore the native temporary colgroup preview after an unsafe resize is discarded. */
export function refreshRejectedTableResize(view: EditorView): void {
	if (!refreshAfterRejectedResize.has(view)) return;
	if (columnResizingPluginKey.getState(view.state)?.dragging) return;
	refreshAfterRejectedResize.delete(view);
	for (const preview of previewViews.get(view) ?? []) preview.refreshFromPersistedAttrs();
}

/** Convert only the native column-resize cell-attr transaction into a persistent TeX colspec. */
export function persistNativeTableResize(transaction: Transaction, view: EditorView): ResizeResult {
	const resizeState = columnResizingPluginKey.getState(view.state);
	if (
		!transaction.docChanged ||
		!resizeState?.dragging ||
		transaction.before !== view.state.doc ||
		transaction.getMeta('collabRemotePatch')
	)
		return 'ignored';
	const resized = readNativeResize(transaction);
	if (!resized) return 'ignored';

	const active = resolveTableAtPosition(transaction.before, resizeState.activeHandle);
	if (!active || active.pos !== resized.table.pos) return rejectResize(view);
	const handleOffset = resizeState.activeHandle - (active.pos + 1);
	let handleCell: { left: number; right: number; top: number; bottom: number };
	try {
		handleCell = active.map.findCell(handleOffset);
	} catch {
		return rejectResize(view);
	}
	if (handleCell.right - handleCell.left !== 1 || handleCell.bottom - handleCell.top !== 1 || resized.column !== handleCell.left) {
		return rejectResize(view);
	}

	const model = getSafePreviewModel(resized.table.node);
	const measuredWidth = measureColumnWidth(view, resizeState.activeHandle, resized.column);
	const lineWidth = measuredWidthForLine(view, resizeState.activeHandle);
	if (!model || !measuredWidth || !lineWidth || Math.round(measuredWidth) !== resized.width) return rejectResize(view);
	const percent = Math.round((resized.width / lineWidth) * 100);
	if (!Number.isInteger(percent) || percent < 1 || percent > 100) return rejectResize(view);

	const nextModel: ColspecModel = {
		columns: model.columns.map((entry, index) =>
			index === resized.column ? { align: 'p', width: `${Number((percent / 100).toFixed(3))}\\linewidth` } : entry
		),
		rules: model.rules
	};
	const colspec = generateColspec(nextModel);
	if (colspec === resized.table.node.attrs.colspec) return rejectResize(view);

	const finalTable = transaction.doc.nodeAt(resized.table.pos);
	if (!finalTable || finalTable.type.name !== 'table' || !allRowsHaveWidth(finalTable, resized.column, resized.width))
		return rejectResize(view);

	closeHistory(transaction);
	transaction.setNodeMarkup(resized.table.pos, undefined, {
		...finalTable.attrs,
		colspec
	});
	const updatedTable = transaction.doc.nodeAt(resized.table.pos);
	if (!updatedTable) return rejectResize(view);
	const cells: Array<{ pos: number; node: PMNode }> = [];
	updatedTable.descendants((node, offset) => {
		if ((node.type.name === 'table_cell' || node.type.name === 'table_header') && node.attrs.colwidth !== null) {
			cells.push({ pos: resized.table.pos + 1 + offset, node });
		}
	});
	for (const cell of cells) transaction.setNodeMarkup(cell.pos, undefined, { ...cell.node.attrs, colwidth: null });
	return 'applied';
}

/** Disable native handles for unsupported tables without consuming ordinary cell clicks. */
export function createTableResizeGuardPlugin(): Plugin {
	return new Plugin({
		props: {
			decorations(state) {
				return createTablePreviewDecorations(state.doc);
			},
			handleDOMEvents: {
				mousedown(view) {
					if (!view.editable) return false;
					const state = columnResizingPluginKey.getState(view.state);
					if (!state || state.activeHandle < 0) return false;
					const active = resolveTableAtPosition(view.state.doc, state.activeHandle);
					if (!active || !getSafePreviewModel(active.node)) {
						view.dispatch(view.state.tr.setMeta(columnResizingPluginKey, { setHandle: -1 }));
					}
					return false;
				}
			}
		},
		view(view) {
			return {
				destroy() {
					previewViews.delete(view);
					refreshAfterRejectedResize.delete(view);
				}
			};
		}
	});
}

function createTablePreviewDecorations(doc: PMNode): DecorationSet {
	const decorations: Decoration[] = [];
	doc.descendants((table, tablePos) => {
		if (table.type.name !== 'table') return true;
		const model = getSafePreviewModel(table);
		if (!model) return false;

		let rowPos = tablePos + 1;
		for (let rowIndex = 0; rowIndex < table.childCount; rowIndex++) {
			const row = table.child(rowIndex);
			const top = previewRule(String(row.attrs.topRules ?? ''));
			const bottom = rowIndex === table.childCount - 1 ? previewRule(String(table.attrs.bottomRules ?? '')) : null;
			row.forEach((cell, cellOffset, columnIndex) => {
				const attrs: Record<string, string> = {};
				if (top) attrs[PREVIEW_CELL_ATTRIBUTES[0]] = top;
				if (bottom) attrs[PREVIEW_CELL_ATTRIBUTES[1]] = bottom;
				if (model.rules[columnIndex]) attrs[PREVIEW_CELL_ATTRIBUTES[2]] = 'true';
				if (model.rules[columnIndex + 1]) attrs[PREVIEW_CELL_ATTRIBUTES[3]] = 'true';
				if (Object.keys(attrs).length > 0) {
					const cellPos = rowPos + 1 + cellOffset;
					decorations.push(Decoration.node(cellPos, cellPos + cell.nodeSize, attrs));
				}
			});
			rowPos += row.nodeSize;
		}
		return false;
	});
	return DecorationSet.create(doc, decorations);
}

function rejectResize(view: EditorView): ResizeResult {
	refreshAfterRejectedResize.add(view);
	return 'rejected';
}

function setAttributeIfChanged(element: Element, name: string, value: string | null): void {
	if (value === null) {
		if (element.hasAttribute(name)) element.removeAttribute(name);
	} else if (element.getAttribute(name) !== value) {
		element.setAttribute(name, value);
	}
}

function setStyleIfChanged(element: HTMLElement | HTMLTableColElement, name: string, value: string): void {
	if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
}

function resolveTableAtPosition(doc: PMNode, pos: number): TableAtPosition | null {
	if (!Number.isInteger(pos) || pos < 0 || pos > doc.content.size) return null;
	const $pos = doc.resolve(pos);
	for (let depth = $pos.depth; depth > 0; depth--) {
		const node = $pos.node(depth);
		if (node.type.name === 'table') {
			try {
				return { pos: $pos.before(depth), node, map: TableMap.get(node) };
			} catch {
				return null;
			}
		}
	}
	return null;
}

interface SafePreviewModel extends ColspecModel {
	tableWidth: string;
}

function getSafePreviewModel(table: PMNode): SafePreviewModel | null {
	if (table.type.name !== 'table' || !['tabular', 'tabular*', 'tabularx', 'longtable'].includes(String(table.attrs.env ?? ''))) return null;
	let map: TableMap;
	try {
		map = TableMap.get(table);
	} catch {
		return null;
	}
	if (map.width < 1 || hasUnsupportedCellContent(table)) return null;
	const model = parseColspec(String(table.attrs.colspec ?? ''));
	if (!model || model.columns.length !== map.width || model.columns.some((column) => column.align === 'C')) return null;
	if (model.columns.some((column) => column.align === 'X') && table.attrs.env !== 'tabularx') return null;
	const tableWidth = cssWidthForTable(table);
	if (tableWidth === null) return null;
	if (!model.columns.every((column) => column.width === undefined || cssWidthForColumn(column.width) !== null)) return null;
	for (let rowIndex = 0; rowIndex < table.childCount; rowIndex++) {
		if (previewRule(String(table.child(rowIndex).attrs.topRules ?? '')) === undefined) return null;
	}
	if (previewRule(String(table.attrs.bottomRules ?? '')) === undefined) return null;
	return { ...model, tableWidth };
}

function hasUnsupportedCellContent(table: PMNode): boolean {
	let unsupported = false;
	table.descendants((node) => {
		if (node.type.name === 'table_cell' || node.type.name === 'table_header') {
			if (Number(node.attrs.colspan ?? 1) !== 1 || Number(node.attrs.rowspan ?? 1) !== 1) unsupported = true;
		}
		if (node.type.name === 'raw_latex' || node.type.name === 'inline_latex') unsupported = true;
		return !unsupported;
	});
	return unsupported;
}

function cssWidthForTable(table: PMNode): string | null {
	const env = String(table.attrs.env ?? '');
	const raw = table.attrs.tabularxWidth;
	if (raw == null) return env === 'tabular' || env === 'longtable' ? '' : null;
	const value = String(raw).trim();
	const ratio = value.match(/^(\d+(?:\.\d+)?|\.\d+)\\linewidth$/);
	if (ratio) {
		const number = Number(ratio[1]);
		return Number.isFinite(number) && number > 0 ? `${number * 100}%` : null;
	}
	if (value === '\\linewidth') return '100%';
	const length = value.match(/^(\d+(?:\.\d+)?|\.\d+)(cm|mm|in|pt|bp|px)$/);
	if (!length) return null;
	const number = Number(length[1]);
	if (!Number.isFinite(number) || number <= 0) return null;
	if (length[2] === 'pt') return `${(number * 72) / 72.27}pt`;
	return `${number}${length[2]}`;
}

function cssWidthForColumn(width: string | undefined): string | null {
	if (width === undefined) return '';
	const value = width.trim();
	const ratio = value.match(/^(\d+(?:\.\d+)?|\.\d+)\\linewidth$/);
	if (ratio) {
		const number = Number(ratio[1]);
		return Number.isFinite(number) && number > 0 ? `${number * 100}cqw` : null;
	}
	if (value === '\\linewidth') return '100cqw';
	const length = value.match(/^(\d+(?:\.\d+)?|\.\d+)(cm|mm|in|pt|bp|px)$/);
	if (!length) return null;
	const number = Number(length[1]);
	if (!Number.isFinite(number) || number <= 0) return null;
	if (length[2] === 'pt') return `${(number * 72) / 72.27}pt`;
	return `${number}${length[2]}`;
}

function previewRule(rule: string): PreviewRule | null | undefined {
	const normalized = rule.trim();
	if (!normalized) return null;
	if (normalized === '\\hline') return 'solid';
	if (normalized === '\\toprule' || normalized === '\\bottomrule') return 'heavy';
	if (normalized === '\\midrule') return 'solid';
	if (normalized === '\\hdashline') return 'dashed';
	if (normalized === '\\hline\n\\hline') return 'double';
	return undefined;
}

function readNativeResize(transaction: Transaction): NativeResize | null {
	let working = transaction.before;
	let tablePosition: number | null = null;
	let column: number | null = null;
	let width: number | null = null;
	let changeCount = 0;
	for (const step of transaction.steps) {
		if (
			!(step instanceof ReplaceAroundStep) ||
			Reflect.get(step, 'structure') !== true ||
			step.slice.openStart !== 0 ||
			step.slice.openEnd !== 0 ||
			step.slice.content.childCount !== 1 ||
			step.insert !== 1 ||
			step.from !== step.gapFrom - 1 ||
			step.to !== step.gapTo + 1
		)
			return null;
		const oldCell = working.nodeAt(step.from);
		const applied = step.apply(working);
		if (applied.failed || !applied.doc) return null;
		const newCell = applied.doc.nodeAt(step.from);
		if (
			!oldCell ||
			!newCell ||
			(oldCell.type.name !== 'table_cell' && oldCell.type.name !== 'table_header') ||
			oldCell.type !== newCell.type
		)
			return null;
		if (
			!oldCell.content.eq(newCell.content) ||
			oldCell.marks.length !== newCell.marks.length ||
			oldCell.marks.some((mark, index) => !mark.eq(newCell.marks[index])) ||
			oldCell.nodeSize !== newCell.nodeSize
		)
			return null;
		for (const key of new Set([...Object.keys(oldCell.attrs), ...Object.keys(newCell.attrs)])) {
			if (key !== 'colwidth' && oldCell.attrs[key] !== newCell.attrs[key]) return null;
		}
		const oldWidths = Array.isArray(oldCell.attrs.colwidth) ? oldCell.attrs.colwidth : [];
		const newWidths = Array.isArray(newCell.attrs.colwidth) ? newCell.attrs.colwidth : [];
		if (newWidths.length !== 1 || !Number.isInteger(newWidths[0]) || newWidths[0] <= 0) return null;
		if (oldWidths.length === newWidths.length && oldWidths[0] === newWidths[0]) return null;
		const table = resolveTableAtPosition(working, step.from);
		if (!table) return null;
		const cellOffset = step.from - (table.pos + 1);
		let rect: { left: number; right: number; top: number; bottom: number };
		try {
			rect = table.map.findCell(cellOffset);
		} catch {
			return null;
		}
		if (rect.right - rect.left !== 1 || rect.bottom - rect.top !== 1) return null;
		if (
			(tablePosition !== null && tablePosition !== table.pos) ||
			(column !== null && column !== rect.left) ||
			(width !== null && width !== newWidths[0])
		)
			return null;
		tablePosition = table.pos;
		column = rect.left;
		width = newWidths[0];
		changeCount++;
		working = applied.doc;
	}
	if (changeCount === 0 || tablePosition === null || column === null || width === null) return null;
	const table = resolveTableAtPosition(working, tablePosition + 1);
	return table ? { table, column, width } : null;
}

function allRowsHaveWidth(table: PMNode, column: number, width: number): boolean {
	for (let rowIndex = 0; rowIndex < table.childCount; rowIndex++) {
		const cell = table.child(rowIndex).maybeChild(column);
		if (!cell || !Array.isArray(cell.attrs.colwidth) || cell.attrs.colwidth.length !== 1 || cell.attrs.colwidth[0] !== width) return false;
	}
	return table.childCount > 0;
}

function measureColumnWidth(view: EditorView, cellPosition: number, columnIndex: number): number {
	const dom = view.nodeDOM(cellPosition);
	if (!(dom instanceof HTMLElement)) return 0;
	const table = dom.closest('table');
	const column = table?.querySelectorAll('col').item(columnIndex);
	return column instanceof HTMLTableColElement ? column.getBoundingClientRect().width : 0;
}

function measuredWidthForLine(view: EditorView, cellPosition: number): number {
	const dom = view.nodeDOM(cellPosition);
	if (!(dom instanceof HTMLElement)) return 0;
	const container = dom.closest('table')?.closest('.table-wrapper-content');
	return container instanceof HTMLElement ? container.clientWidth : 0;
}
