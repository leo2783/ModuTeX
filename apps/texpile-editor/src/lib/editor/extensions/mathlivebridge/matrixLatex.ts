export type MatrixEnvironment = 'matrix' | 'pmatrix' | 'bmatrix' | 'Bmatrix' | 'vmatrix' | 'Vmatrix';

const MATRIX_ENVIRONMENTS = new Set<MatrixEnvironment>(['matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix']);
const AMSMATH_ENVIRONMENTS = new Set([
	'matrix',
	'pmatrix',
	'bmatrix',
	'Bmatrix',
	'vmatrix',
	'Vmatrix',
	'align',
	'alignat',
	'flalign',
	'gather',
	'multline',
	'aligned',
	'alignedat',
	'gathered',
	'split',
	'cases',
	'subarray',
	'xalignat',
	'xxalignat'
]);

export function validMatrixSize(rows: number | undefined, columns: number | undefined): rows is number {
	return (
		Number.isInteger(rows) &&
		Number.isInteger(columns) &&
		rows !== undefined &&
		columns !== undefined &&
		rows >= 1 &&
		rows <= 20 &&
		columns >= 1 &&
		columns <= 20
	);
}

/** New interactive matrix sizes are intentionally capped at 10; legacy documents still use validMatrixSize. */
export function validInteractiveMatrixSize(rows: number | undefined, columns: number | undefined): rows is number {
	return (
		Number.isInteger(rows) &&
		Number.isInteger(columns) &&
		rows !== undefined &&
		columns !== undefined &&
		rows >= 1 &&
		rows <= 10 &&
		columns >= 1 &&
		columns <= 10
	);
}

/** Whether an editor-authored environment template requires amsmath before it can compile. */
export function requiresAmsmath(latex: string): boolean {
	for (const match of latex.matchAll(/\\begin\{([A-Za-z]+)(\*)?\}/g)) {
		if (AMSMATH_ENVIRONMENTS.has(match[1])) return true;
	}
	return false;
}

/** Creates a rectangular matrix with MathLive placeholders, ready for first-cell focus and Tab navigation. */
export function generateMatrixLatex(rows: number, columns: number, environment: MatrixEnvironment = 'pmatrix'): string {
	if (!validMatrixSize(rows, columns)) throw new RangeError('Matrix size must be between 1 and 20');
	if (!MATRIX_ENVIRONMENTS.has(environment)) throw new Error('Unsupported matrix environment');
	return `\\begin{${environment}}${Array.from({ length: rows }, () => Array.from({ length: columns }, () => '#?').join(' & ')).join('\\\\')}\\end{${environment}}`;
}
