import { projectionIsCurrent, type SourceDocument, type SourceProjection, type SourceSpan, type SyntaxNode } from '@modutex/document-core';
export interface EquationDraft { readonly latex: string; readonly inline: boolean }
export interface LocatedEquation { readonly draft: EquationDraft; readonly span: SourceSpan; readonly content: SourceSpan }
/** Only closed delimiter math from the current parser grants editing authority. */
export function equationAt(source: SourceDocument, projection: SourceProjection, offset: number): LocatedEquation | null {
	if (!projectionIsCurrent(source, projection) || !Number.isInteger(offset) || offset < 0 || offset >= source.length) return null;
	function visit(nodes: readonly SyntaxNode[]): LocatedEquation | null {
		for (const node of nodes) {
			if (offset < node.span.from || offset >= node.span.to) continue;
			if (node.kind === 'math' && node.content && ['$', '$$', '(', '['].includes(node.name ?? '')) {
				return { draft: { latex: source.read(node.content.from, node.content.to), inline: node.name === '$' || node.name === '(' }, span: node.span, content: node.content };
			}
			const found = visit(node.children); if (found) return found;
		}
		return null;
	}
	return visit(projection.nodes);
}
/** Re-edit without normalizing delimiters, whitespace, comments or line endings. */
export function equationReplacement(source: SourceDocument, located: LocatedEquation, draft: EquationDraft): string {
	const { span, content } = located;
	for (const range of [span, content]) {
		if (range.documentId !== source.documentId || range.version !== source.version || !Number.isInteger(range.from) || !Number.isInteger(range.to) || range.from < 0 || range.to < range.from || range.to > source.length) throw new Error('STALE_EQUATION');
	}
	if (content.from <= span.from || content.to >= span.to) throw new Error('STALE_EQUATION');
	const opening = source.read(span.from, content.from), closing = source.read(content.to, span.to);
	const inline = opening === '$' || opening === '\\(';
	if (!(['$', '$$', '\\(', '\\['].includes(opening)) || closing !== ({ '$': '$', '$$': '$$', '\\(': '\\)', '\\[': '\\]' } as Record<string, string>)[opening] || inline !== located.draft.inline || source.read(content.from, content.to) !== located.draft.latex) throw new Error('STALE_EQUATION');
	equationSource(draft.latex, draft.inline);
	return draft.inline === inline ? opening + draft.latex + closing : equationSource(draft.latex, draft.inline);
}
export interface MatrixDraft { readonly rows: number; readonly columns: number; readonly cells: readonly string[] }
export function matrixSize(value: number): number {
	if (!Number.isInteger(value) || value < 1 || value > 10) throw new RangeError('MATRIX_SIZE');
	return value;
}
export function resizeMatrix(previous: MatrixDraft, rows: number, columns: number): { matrix: MatrixDraft; discarded: boolean } {
	matrixSize(rows); matrixSize(columns); matrixSize(previous.rows); matrixSize(previous.columns);
	if (previous.cells.length !== previous.rows * previous.columns) throw new Error('MATRIX_CELLS');
	let discarded = false;
	for (let row = 0; row < previous.rows; row++) for (let column = 0; column < previous.columns; column++) {
		if ((row >= rows || column >= columns) && previous.cells[row * previous.columns + column]!.trim()) discarded = true;
	}
	return { matrix: { rows, columns, cells: Array.from({ length: rows * columns }, (_, index) => {
		const row = Math.floor(index / columns), column = index % columns;
		return row < previous.rows && column < previous.columns ? previous.cells[row * previous.columns + column]! : '';
	}) }, discarded };
}
/** Cell source cannot introduce another row, column, comment or environment boundary. */
function cellSource(value: string): string {
	if (value.length > 1024 || /[\r\n]/.test(value) || /\\(?:begin|end)\s*\{/.test(value)) throw new Error('MATRIX_CELL');
	let depth = 0;
	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		if (char === '\\') { if (value[index + 1] === '\\') throw new Error('MATRIX_CELL'); index++; }
		else if (char === '{') depth++;
		else if (char === '}' && --depth < 0) throw new Error('MATRIX_CELL');
		else if (char === '&' || char === '%') throw new Error('MATRIX_CELL');
	}
	if (depth !== 0 || value.endsWith('\\')) throw new Error('MATRIX_CELL');
	return value.trim() || '{}';
}
export function matrixSource(matrix: MatrixDraft, brackets: 'parentheses' | 'square' | 'none'): string {
	matrixSize(matrix.rows); matrixSize(matrix.columns);
	if (matrix.cells.length !== matrix.rows * matrix.columns) throw new Error('MATRIX_CELLS');
	if (!['parentheses', 'square', 'none'].includes(brackets)) throw new Error('MATRIX_BRACKETS');
	const rows = Array.from({ length: matrix.rows }, (_, row) => matrix.cells.slice(row * matrix.columns, (row + 1) * matrix.columns).map(cellSource).join(' & '));
	const array = '\\begin{array}{' + 'c'.repeat(matrix.columns) + '}\n' + rows.join(' \\\\\n') + '\n\\end{array}';
	return brackets === 'none' ? array : '\\left' + (brackets === 'square' ? '[' : '(') + array + '\\right' + (brackets === 'square' ? ']' : ')');
}
export function equationSource(value: string, inline: boolean): string {
	if (!value.trim() || value.length > 65536 || value.includes('\u0000')) throw new Error('EQUATION_SOURCE');
	return inline ? '\\(' + value + '\\)' : '\\[\n' + value + '\n\\]';
}
