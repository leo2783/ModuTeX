// LaTeX for the Source editor's table inserter. Plain tabular, not the tabularx the Visual editor
// falls back to: source-mode users are writing their own LaTeX, and tabularx would silently need a
// \usepackage they never asked for. ${n} are CodeMirror snippet tab stops.
import { makeTableLayout, type TablePreset } from './table-preset-commands';

export interface TableOptions {
	rows: number;
	cols: number;
	/** wrap in a table float with \centering, \caption and \label */
	float: boolean;
	/** New picker path. The first row is always the header. */
	preset?: TablePreset;
	/** @deprecated compatibility for callers using the original two-switch picker. */
	rules?: boolean;
	/** @deprecated compatibility for callers using the original two-switch picker. */
	header?: boolean;
}

/** a row of empty cells; the first gets the cursor's first tab stop */
function bodyRows(rows: number, cols: number, rules: boolean, header: boolean, indent: string): string[] {
	const out: string[] = [];
	for (let r = 0; r < rows; r++) {
		const cells = Array.from({ length: cols }, () => ' ').join('&');
		out.push(`${indent}${cells}\\\\`);
		if (rules && header && r === 0) out.push(`${indent}\\hline`);
	}
	return out;
}

export function tableLatex({ rows, cols, float, rules, header }: TableOptions): string {
	return buildLegacyLatex(rows, cols, float, rules ?? true, header ?? true);
}

export function tablePresetLatex({
	rows,
	cols,
	float,
	preset
}: Pick<TableOptions, 'rows' | 'cols' | 'float' | 'preset'> & { preset: TablePreset }): string {
	const indent = float ? '\t\t' : '\t';
	const layout = makeTableLayout(rows, cols, preset);
	const lines: string[] = [];

	lines.push(`${float ? '\t' : ''}\\begin{tabular}{${layout.colspec}}`);
	for (let row = 0; row < rows; row++) {
		if (layout.rowRules[row]) lines.push(`${indent}${layout.rowRules[row]}`);
		const cells = Array.from({ length: cols }, () => ' ').join('&');
		lines.push(`${indent}${cells}\\\\`);
	}
	if (layout.bottomRules) lines.push(`${indent}${layout.bottomRules}`);
	lines.push(`${float ? '\t' : ''}\\end{tabular}`);

	if (!float) return lines.join('\n');

	return [
		'\\begin{table}[htbp]',
		'\t\\centering',
		...lines,
		'\t\\caption{${1:Caption}}',
		'\t\\label{tab:${2:label}}',
		'\\end{table}',
		'${0}'
	].join('\n');
}

function buildLegacyLatex(rows: number, cols: number, float: boolean, rules: boolean, header: boolean): string {
	const indent = float ? '\t\t' : '\t';
	const colspec = 'c'.repeat(cols);
	const lines: string[] = [];

	lines.push(`${float ? '\t' : ''}\\begin{tabular}{${colspec}}`);
	if (rules) lines.push(`${indent}\\hline`);
	lines.push(...bodyRows(rows, cols, rules, header, indent));
	if (rules) lines.push(`${indent}\\hline`);
	lines.push(`${float ? '\t' : ''}\\end{tabular}`);
	if (!float) return lines.join('\n');
	return [
		'\\begin{table}[htbp]',
		'\t\\centering',
		...lines,
		'\t\\caption{${1:Caption}}',
		'\t\\label{tab:${2:label}}',
		'\\end{table}',
		'${0}'
	].join('\n');
}
