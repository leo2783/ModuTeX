import type { MatrixDraft } from './source.ts';

// Reused from the project owner's original 0.1.0 matrixResize.ts,
// explicitly authorized by the owner on 2026-10-11. No legacy UI imports.
export type MatrixEnvironment = 'matrix' | 'pmatrix' | 'bmatrix' | 'Bmatrix' | 'vmatrix' | 'Vmatrix';

export interface ParsedMatrixLatex {
	environment: MatrixEnvironment;
	rows: string[][];
	leading: string;
	trailing: string;
}

const MATRIX_SOURCE = /^(\s*)\\begin\{(matrix|pmatrix|bmatrix|Bmatrix|vmatrix|Vmatrix)\}([\s\S]*)\\end\{\2\}(\s*)$/;
const ENVIRONMENT_TOKEN = /^\\(begin|end)\{[^{}]+\}/;

function splitCells(body: string): string[][] | null {
	const rows: string[][] = [[]];
	let cell = '';
	let braceDepth = 0;
	let environmentDepth = 0;

	const commitCell = () => {
		rows[rows.length - 1]!.push(cell.trim());
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
	const rows = splitCells(match[3]!);
	if (!rows?.length || rows.some((row) => row.length === 0)) return null;
	return {
		environment: match[2] as MatrixEnvironment,
		rows,
		leading: match[1]!,
		trailing: match[4]!
	};
}


export type MatrixBrackets = 'parentheses' | 'square' | 'none' | 'curly' | 'bars' | 'double-bars';
export interface EditableMatrix { readonly matrix: MatrixDraft; readonly brackets: MatrixBrackets }
/** Recognize the base-LaTeX serializer and the owner's original matrix environments. */
export function editableMatrix(latex: string): EditableMatrix | null {
  let source = latex.trim();
  let environment = 'matrix';
  for (const [opening, closing, name] of [
    ['\\left(', '\\right)', 'pmatrix'], ['\\left[', '\\right]', 'bmatrix'],
    ['\\left\\{', '\\right\\}', 'Bmatrix'], ['\\left|', '\\right|', 'vmatrix'],
    ['\\left\\Vert', '\\right\\Vert', 'Vmatrix']
  ] as const) {
    if (!source.startsWith(opening)) continue;
    if (!source.endsWith(closing)) return null;
    source = source.slice(opening.length, -closing.length); environment = name; break;
  }
  const array = /^\\begin\{array\}\{(c{1,10})\}([\s\S]*)\\end\{array\}$/.exec(source);
  if (array) source = '\\begin{' + environment + '}' + array[2] + '\\end{' + environment + '}';
  const parsed = parseMatrixLatex(source);
  if (!parsed) return null;
  const rows = parsed.rows.length, columns = parsed.rows[0]?.length ?? 0;
  if (rows < 1 || rows > 10 || columns < 1 || columns > 10 || parsed.rows.some(row => row.length !== columns) || array && array[1]!.length !== columns) return null;
  return {
    matrix: { rows, columns, cells: parsed.rows.flat().map(cell => cell === '{}' || cell === '#?' || cell === '\\placeholder{}' ? '' : cell) },
    brackets: ({ matrix: 'none', pmatrix: 'parentheses', bmatrix: 'square', Bmatrix: 'curly', vmatrix: 'bars', Vmatrix: 'double-bars' } as const)[parsed.environment]
  };
}
