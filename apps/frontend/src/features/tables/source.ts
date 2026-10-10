import { projectionIsCurrent, type SourceDocument, type SourceProjection, type SourceSpan } from '@modutex/document-core';
export interface TableDraft {
	readonly rows: number; readonly columns: number; readonly cells: readonly string[];
	readonly weights: readonly number[]; readonly width: number; readonly header: boolean;
	readonly style: 'three-line' | 'full' | 'horizontal';
	readonly rules?: 'hline' | 'booktabs';
	readonly caption: { readonly position: 'none' | 'above' | 'below'; readonly text: string };
}
export function createTable(rows = 3, columns = 3): TableDraft {
	if (!Number.isInteger(rows) || rows < 1 || rows > 100 || !Number.isInteger(columns) || columns < 1 || columns > 20) throw new Error('TABLE_SIZE');
	const draft: TableDraft = { rows, columns, cells: Array(rows * columns).fill(''), weights: Array(columns).fill(1),
		width: 80, header: true, style: 'three-line', caption: { position: 'none', text: '' } };
	validate(draft); return draft;
}
function validate(table: TableDraft): void {
	if (!Number.isInteger(table.rows) || table.rows < 1 || table.rows > 100 || !Number.isInteger(table.columns) || table.columns < 1 || table.columns > 20 ||
		table.cells.length !== table.rows * table.columns || table.weights.length !== table.columns ||
		table.weights.some((value) => !Number.isFinite(value) || value <= 0 || value > 1000) ||
		!Number.isFinite(table.width) || table.width < 1 || table.width > 100 ||
		!['three-line', 'full', 'horizontal'].includes(table.style) || table.rules !== undefined && !['hline', 'booktabs'].includes(table.rules) || table.rules === 'booktabs' && table.style !== 'three-line' || !['none', 'above', 'below'].includes(table.caption.position) ||
		table.cells.some((value) => typeof value !== 'string' || value.length > 2048 || /[\r\n\u0000]/.test(value)) ||
		typeof table.caption.text !== 'string' || table.caption.text.length > 2048 || /[\r\n\u0000]/.test(table.caption.text)) throw new Error('TABLE_DRAFT');
}
export function columnPercentages(table: TableDraft): readonly number[] {
	validate(table); const sum = table.weights.reduce((total, value) => total + value, 0);
	return table.weights.map((value) => value / sum * 100);
}
/** Cell/caption fields are literal text, never a channel for structural TeX. */
function text(value: string): string {
	const escapes: Record<string, string> = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '%': '\\%', '&': '\\&',
		'#': '\\#', '$': '\\$', '_': '\\_', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}' };
	return value.replace(/[\\{}%&#$_^~]/g, (char) => escapes[char]!);
}
/** Base tabular; booktabs rules require an explicit package confirmation by the caller. */
export function tableSource(table: TableDraft): string {
	validate(table);
	const widths = columnPercentages(table);
	const ruleShare = table.style === 'full' ? `-${((table.columns + 1) / table.columns).toFixed(6)}\\arrayrulewidth` : '';
	const columns = widths.map((percent) => `p{\\dimexpr${(percent * table.width / 10000).toFixed(6)}\\linewidth-2\\tabcolsep${ruleShare}\\relax}`);
	const spec = table.style === 'full' ? '|' + columns.join('|') + '|' : columns.join('');
	const booktabs = table.rules === 'booktabs';
	const lines = ['\\begin{tabular}{' + spec + '}', booktabs ? '\\toprule' : '\\hline'];
	for (let row = 0; row < table.rows; row++) {
		lines.push(table.cells.slice(row * table.columns, (row + 1) * table.columns).map((cell) => {
			const content = text(cell) || '{}'; return table.header && row === 0 ? '\\textbf{' + content + '}' : content;
		}).join(' & ') + ' \\\\');
		if (booktabs) {
			if (row === table.rows - 1) lines.push('\\bottomrule');
			else if (table.header && row === 0) lines.push('\\midrule');
		} else if (table.style !== 'three-line' || row === table.rows - 1 || table.header && row === 0) lines.push('\\hline');
	}
	lines.push('\\end{tabular}');
	if (table.caption.position === 'none') return '\\begin{center}\n' + lines.join('\n') + '\n\\end{center}';
	const caption = '\\caption{' + text(table.caption.text) + '}';
	return ['\\begin{table}[htbp]', '\\centering', ...(table.caption.position === 'above' ? [caption] : []), ...lines,
		...(table.caption.position === 'below' ? [caption] : []), '\\end{table}'].join('\n');
}
/** Returns a proposal; callers confirm discarded nonempty cells before accepting it. */
export function changeTableAxis(previous: TableDraft, axis: 'row' | 'column', action: 'insert' | 'delete', index: number): { table: TableDraft; discarded: boolean } {
	validate(previous);
	const length = axis === 'row' ? previous.rows : previous.columns;
	if (!['row', 'column'].includes(axis) || !['insert', 'delete'].includes(action) || !Number.isInteger(index) || index < 0 || index > length || action === 'delete' && (index === length || length === 1)) throw new Error('TABLE_AXIS');
	const rows = previous.rows + (axis === 'row' ? action === 'insert' ? 1 : -1 : 0);
	const columns = previous.columns + (axis === 'column' ? action === 'insert' ? 1 : -1 : 0);
	let discarded = false;
	if (action === 'delete') previous.cells.forEach((cell, offset) => {
		if ((axis === 'row' ? Math.floor(offset / previous.columns) : offset % previous.columns) === index && cell.trim()) discarded = true;
	});
	const cells = Array.from({ length: rows * columns }, (_, offset) => {
		let row = Math.floor(offset / columns), column = offset % columns;
		const current = axis === 'row' ? row : column;
		if (action === 'insert' && current === index) return '';
		const adjustment = action === 'insert' ? current > index ? -1 : 0 : current >= index ? 1 : 0;
		if (axis === 'row') row += adjustment; else column += adjustment;
		return previous.cells[row * previous.columns + column]!;
	});
	const weights = [...previous.weights];
	if (axis === 'column') { if (action === 'insert') weights.splice(index, 0, 1); else weights.splice(index, 1); }
	const table = { ...previous, rows, columns, cells, weights };
	validate(table); return { table, discarded };
}

/** Decode only literal escapes emitted here; never interpret arbitrary TeX. */
function literal(source: string): string | null {
	if (source === '{}') return '';
	const tokens: readonly [string, string][] = [['\\textbackslash{}', '\\'], ['\\textasciicircum{}', '^'], ['\\textasciitilde{}', '~'],
		...['{', '}', '%', '&', '#', '$', '_'].map((char) => ['\\' + char, char] as [string, string])];
	let result = '';
	for (let offset = 0; offset < source.length;) {
		if (source[offset] !== '\\') {
			if ('{}%&#$_^~'.includes(source[offset]!)) return null;
			result += source[offset++]; continue;
		}
		const token = tokens.find(([encoded]) => source.startsWith(encoded, offset));
		if (!token) return null;
		result += token[1]; offset += token[0].length;
	}
	return result;
}
/** Conservative round-trip subset: exact emitted grammar, EOL differences allowed. */
export function parseTable(value: string): TableDraft | null {
	if (value.length > 512 * 1024) return null;
	const source = value.replace(/\r\n|\r/g, '\n'), lines = source.split('\n');
	if (lines.length > 208) return null;
	try {
		let position: TableDraft['caption']['position'] = 'none', caption = '';
		if (lines[0] === '\\begin{center}' && lines.at(-1) === '\\end{center}') { lines.shift(); lines.pop(); }
		else if (lines[0] === '\\begin{table}[htbp]' && lines[1] === '\\centering' && lines.at(-1) === '\\end{table}') {
			lines.splice(0, 2); lines.pop();
			const at = lines[0]?.startsWith('\\caption{') ? 0 : lines.at(-1)?.startsWith('\\caption{') ? lines.length - 1 : -1;
			if (at < 0 || !lines[at]!.endsWith('}')) return null;
			const decoded = literal(lines[at]!.slice(9, -1)); if (decoded === null) return null;
			position = at === 0 ? 'above' : 'below'; caption = decoded; lines.splice(at, 1);
		} else return null;
		const opening = lines.shift();
		if (!opening?.startsWith('\\begin{tabular}{') || !opening.endsWith('}') || lines.pop() !== '\\end{tabular}') return null;
		const spec = opening.slice(16, -1), full = spec.startsWith('|');
		const parts = full ? spec.slice(1, -1).split('|') : spec.match(/p\{[^}]+\}/g) ?? [];
		if (!parts.length || parts.length > 20 || (full ? '|' + parts.join('|') + '|' : parts.join('')) !== spec) return null;
		const fractions = parts.map((part) => /^p\{\\dimexpr(\d+\.\d{6})\\linewidth-2\\tabcolsep(?:-\d+\.\d{6}\\arrayrulewidth)?\\relax\}$/.exec(part)?.[1]);
		if (fractions.some((fraction) => fraction === undefined)) return null;
		const weights = fractions.map((fraction) => Number(fraction)), total = weights.reduce((sum, fraction) => sum + fraction, 0);
		const booktabs = lines.at(0) === '\\toprule';
		const rowLines = lines.filter((line) => booktabs ? !['\\toprule', '\\midrule', '\\bottomrule'].includes(line) : line !== '\\hline');
		if (!rowLines.length || rowLines.length > 100 || rowLines.some((line) => !line.endsWith(' \\\\'))) return null;
		const encoded = rowLines.map((line) => line.slice(0, -3).split(' & '));
		if (encoded.some((row) => row.length !== parts.length)) return null;
		const header = encoded[0]!.every((cell) => cell.startsWith('\\textbf{') && cell.endsWith('}'));
		const cells = encoded.flatMap((row, index) => row.map((cell) => literal(header && index === 0 ? cell.slice(8, -1) : cell)));
		if (cells.some((cell) => cell === null)) return null;
		const base = { rows: rowLines.length, columns: parts.length, cells: cells as string[], weights, width: total * 100,
			header, caption: { position, text: caption } };
		for (const style of (full ? ['full'] : ['three-line', 'horizontal']) as TableDraft['style'][]) {
			const draft = { ...base, style, ...(booktabs ? { rules: 'booktabs' as const } : {}) };
			// Final equality rejects comments, unknown macros, altered rules and unsupported specs.
			if (tableSource(draft) === source) return draft;
		}
	} catch { /* Unsupported input is preserved as Raw by callers. */ }
	return null;
}
export function tableAt(source: SourceDocument, projection: SourceProjection, offset: number): { draft: TableDraft; span: SourceSpan } | null {
	if (!projectionIsCurrent(source, projection)) return null;
	const nodes = [...projection.nodes];
	while (nodes.length) {
		const node = nodes.pop()!;
		if (offset < node.span.from || offset > node.span.to) continue;
		if ((node.kind === 'environment' || node.kind === 'raw') && node.content !== null && ['center', 'table'].includes(node.name)) {
			const draft = parseTable(source.read(node.span.from, node.span.to));
			if (draft) return { draft, span: node.span };
		}
		nodes.push(...node.children);
	}
	return null;
}
