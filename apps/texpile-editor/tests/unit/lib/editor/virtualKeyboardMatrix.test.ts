import { describe, expect, it } from 'vitest';
import type { VirtualKeyboardKeycap } from 'mathlive';
import {
	texpileKeyboardLayouts,
	virtualMatrixLatexForPreset,
	VIRTUAL_MATRIX_REQUEST_EVENT
} from '$lib/editor/extensions/mathlivebridge/virtualKeyboardConfig';
import { generateMatrixLatex } from '$lib/editor/extensions/mathlivebridge/matrixLatex';

describe('MathLive virtual-keyboard matrix commands', () => {
	it('maps only the finite numeric matrix presets to the existing templates', () => {
		expect(virtualMatrixLatexForPreset(1)).toBe(generateMatrixLatex(2, 2, 'pmatrix'));
		expect(virtualMatrixLatexForPreset(2)).toBe(generateMatrixLatex(2, 2, 'bmatrix'));
		expect(virtualMatrixLatexForPreset(3)).toBe(generateMatrixLatex(2, 2, 'vmatrix'));
		expect(virtualMatrixLatexForPreset(4)).toBe(generateMatrixLatex(2, 2, 'matrix'));
		expect(virtualMatrixLatexForPreset(5)).toBe(generateMatrixLatex(3, 1, 'pmatrix'));
		expect(virtualMatrixLatexForPreset(6)).toBe(generateMatrixLatex(3, 1, 'bmatrix'));
		for (const invalid of [0, 7, 1.5, -1, '1', null, {}, undefined]) {
			expect(virtualMatrixLatexForPreset(invalid)).toBeNull();
		}
	});

	it('routes both matrix keycaps and long-press variants through MathLive dispatchEvent tuples', () => {
		const layout = texpileKeyboardLayouts()[2];
		if (typeof layout === 'string') throw new Error('The algebra layout is missing');
		const algebra = layout as { rows: (string | Partial<VirtualKeyboardKeycap>)[][] };
		const [squareItem, vectorItem] = algebra.rows[0];
		if (typeof squareItem === 'string' || typeof vectorItem === 'string') throw new Error('The matrix keycaps are missing');
		const square = squareItem as Partial<VirtualKeyboardKeycap>;
		const vector = vectorItem as Partial<VirtualKeyboardKeycap>;
		expect(square.command).toEqual(['dispatchEvent', VIRTUAL_MATRIX_REQUEST_EVENT, 1]);
		expect((square.variants as Partial<VirtualKeyboardKeycap>[]).map((variant) => variant.command)).toEqual([
			['dispatchEvent', VIRTUAL_MATRIX_REQUEST_EVENT, 2],
			['dispatchEvent', VIRTUAL_MATRIX_REQUEST_EVENT, 3],
			['dispatchEvent', VIRTUAL_MATRIX_REQUEST_EVENT, 4]
		]);
		expect(vector.command).toEqual(['dispatchEvent', VIRTUAL_MATRIX_REQUEST_EVENT, 5]);
		expect((vector.variants as Partial<VirtualKeyboardKeycap>[]).map((variant) => variant.command)).toEqual([
			['dispatchEvent', VIRTUAL_MATRIX_REQUEST_EVENT, 6]
		]);
	});
});
