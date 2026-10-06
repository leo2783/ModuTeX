import { describe, expect, it } from 'vitest';
import {
	generateMatrixLatex,
	validMatrixSize,
	validInteractiveMatrixSize,
	type MatrixEnvironment
} from '../../../../src/lib/editor/extensions/mathlivebridge/matrixLatex';
import { parseMatrixLatex, resizeMatrixLatex } from '../../../../src/lib/editor/extensions/mathlivebridge/matrixResize';

const environments: MatrixEnvironment[] = ['matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix'];

describe('interactive matrix dimensions', () => {
	it('accepts integer sizes from 1 through 10 while leaving legacy 1–20 support intact', () => {
		for (const size of [1, 10]) {
			expect(validInteractiveMatrixSize(size, size)).toBe(true);
		}
		for (const invalid of [undefined, 0, -1, 11, 1.5, Number('text')]) {
			expect(validInteractiveMatrixSize(invalid, 1)).toBe(false);
			expect(validInteractiveMatrixSize(1, invalid)).toBe(false);
		}
		expect(validMatrixSize(20, 20)).toBe(true);
		expect(parseMatrixLatex(generateMatrixLatex(20, 20))?.rows).toHaveLength(20);
	});
});

describe('matrix dimensions', () => {
	it('generates each supported environment at the 1, 10, and 20 boundaries', () => {
		for (const environment of environments) {
			for (const [rows, columns] of [
				[1, 1],
				[10, 10],
				[20, 20]
			]) {
				const latex = generateMatrixLatex(rows, columns, environment);
				const parsed = parseMatrixLatex(latex);
				expect(parsed?.environment).toBe(environment);
				expect(parsed?.rows).toHaveLength(rows);
				expect(parsed?.rows.every((row) => row.length === columns)).toBe(true);
				expect(parsed?.rows[0][0]).toBe('#?');
			}
		}
	});

	it('rejects 0, 21, fractional, and non-numeric dimensions before generating LaTex', () => {
		expect(validMatrixSize(0, 1)).toBe(false);
		expect(validMatrixSize(1, 21)).toBe(false);
		expect(validMatrixSize(1.5, 1)).toBe(false);
		expect(validMatrixSize(Number('text'), 1)).toBe(false);
		expect(() => generateMatrixLatex(0, 1)).toThrow(RangeError);
		expect(() => generateMatrixLatex(1, 21)).toThrow(RangeError);
	});
});

describe('matrix resizing', () => {
	it('keeps the upper-left data while growing a matrix', () => {
		const result = resizeMatrixLatex('\\begin{pmatrix}a & b\\\\c & d\\end{pmatrix}', 3, 3);
		expect(result).toEqual({
			latex: '\\begin{pmatrix}a & b & #?\\\\c & d & #?\\\\#? & #? & #?\\end{pmatrix}',
			droppedNonEmpty: false
		});
	});

	it('keeps existing blank cells instead of replacing them with new placeholders', () => {
		const result = resizeMatrixLatex('\\begin{pmatrix}a & \\\\ & d\\end{pmatrix}', 3, 3);
		expect(result?.latex).toBe('\\begin{pmatrix}a &  & #?\\\\ & d & #?\\\\#? & #? & #?\\end{pmatrix}');
	});

	it('flags only removed non-empty cells and leaves placeholder-only shrinkage safe', () => {
		expect(resizeMatrixLatex('\\begin{pmatrix}a & #?\\\\\\placeholder{} & d\\end{pmatrix}', 1, 1)?.droppedNonEmpty).toBe(true);
		expect(resizeMatrixLatex('\\begin{pmatrix}#? & #?\\\\\\placeholder{} & #?\\end{pmatrix}', 1, 1)?.droppedNonEmpty).toBe(false);
	});

	it('preserves escaped separators and nested environments while resizing', () => {
		const source = '\\begin{bmatrix}a\\&b & \\begin{smallmatrix}c & d\\end{smallmatrix}\\\\e & f\\end{bmatrix}';
		const result = resizeMatrixLatex(source, 1, 2);
		expect(result).toEqual({
			latex: '\\begin{bmatrix}a\\&b & \\begin{smallmatrix}c & d\\end{smallmatrix}\\end{bmatrix}',
			droppedNonEmpty: true
		});
	});

	it('does not rewrite malformed or unsupported math', () => {
		expect(parseMatrixLatex('x + y')).toBeNull();
		expect(parseMatrixLatex('\\begin{array}a\\end{array}')).toBeNull();
		expect(resizeMatrixLatex('\\begin{pmatrix}a & b', 2, 2)).toBeNull();
	});
});
