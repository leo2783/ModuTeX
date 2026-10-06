import { type MatrixEnvironment, validMatrixSize } from './matrixLatex';

export interface ParsedMatrixLatex {
	environment: MatrixEnvironment;
	rows: string[][];
	leading: string;
	trailing: string;
}

export interface ResizedMatrixLatex {
	latex: string;
	droppedNonEmpty: boolean;
}

const MATRIX_SOURCE = /^(\s*)\\begin\{(matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix)\}([\s\S]*)\\end\{\2\}(\s*)$/;
const ENVIRONMENT_TOKEN = /^\\(begin|end)\{[^{}]+\}/;

function splitCells(body: string): string[][] | null {
	const rows: string[][] = [[]];
	let cell = '';
	let braceDepth = 0;
	let environmentDepth = 0;

	const commitCell = () => {
		rows[rows.length - 1].push(cell.trim());
		cell = '';
	};

	for (let index = 0; index < body.length;) {
		const rest = body.slice(index);
		if (body[index] === '\\') {
			const environment = ENVIRONMENT_TOKEN.exec(rest);
			if (environment) {
				environmentDepth += environment[1] === 'begin' ? 1 : -1;
				if (environmentDepth < 0) return null;
				cell += environment[0];
				index += environment[0].length;
				continue;
			}

			if (body[index + 1] === '\\' && braceDepth === 0 && environmentDepth === 0) {
				commitCell();
				rows.push([]);
				index += 2;
				// Row-spacing options belong to the separator rather than either retained cell.
				if (body[index] === '[') {
					const optionEnd = body.indexOf(']', index + 1);
					if (optionEnd !== -1) index = optionEnd + 1;
				}
				continue;
			}

			cell += body[index];
			if (index + 1 < body.length) {
				cell += body[index + 1];
				index += 2;
			} else {
				index++;
			}
			continue;
		}

		if (body[index] === '{') braceDepth++;
		if (body[index] === '}') braceDepth--;
		if (braceDepth < 0) return null;

		if (body[index] === '&' && braceDepth === 0 && environmentDepth === 0) {
			commitCell();
			index++;
			continue;
		}

		cell += body[index];
		index++;
	}

	if (braceDepth !== 0 || environmentDepth !== 0) return null;
	commitCell();
	return rows;
}

/** Parses only the six supported matrix environments; malformed/other math stays untouched. */
export function parseMatrixLatex(latex: string): ParsedMatrixLatex | null {
	const match = MATRIX_SOURCE.exec(latex);
	if (!match) return null;
	const rows = splitCells(match[3]);
	if (!rows?.length || rows.some((row) => row.length === 0)) return null;
	return {
		environment: match[2] as MatrixEnvironment,
		rows,
		leading: match[1],
		trailing: match[4]
	};
}

function isEmptyCell(cell: string): boolean {
	const value = cell.trim();
	return value === '' || value === '#?' || value === '\\placeholder{}';
}

/**
 * Retains the upper-left rectangle. Callers must ask for confirmation when `droppedNonEmpty` is
 * true; malformed input returns null so the original math is never rewritten opportunistically.
 */
export function resizeMatrixLatex(latex: string, targetRows: number, targetColumns: number): ResizedMatrixLatex | null {
	if (!validMatrixSize(targetRows, targetColumns)) throw new RangeError('Matrix size must be between 1 and 20');
	const parsed = parseMatrixLatex(latex);
	if (!parsed) return null;

	let droppedNonEmpty = false;
	for (let row = 0; row < parsed.rows.length; row++) {
		for (let column = 0; column < parsed.rows[row].length; column++) {
			if ((row >= targetRows || column >= targetColumns) && !isEmptyCell(parsed.rows[row][column])) droppedNonEmpty = true;
		}
	}

	const resizedRows = Array.from({ length: targetRows }, (_, row) =>
		Array.from({ length: targetColumns }, (_, column) => parsed.rows[row]?.[column] ?? '#?')
	);
	const body = resizedRows.map((row) => row.join(' & ')).join('\\\\');
	return {
		latex: `${parsed.leading}\\begin{${parsed.environment}}${body}\\end{${parsed.environment}}${parsed.trailing}`,
		droppedNonEmpty
	};
}
