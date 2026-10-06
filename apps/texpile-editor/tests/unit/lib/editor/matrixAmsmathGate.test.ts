import { describe, expect, it } from 'vitest';
import { generateMatrixLatex, requiresAmsmath, validInteractiveMatrixSize } from '$lib/editor/extensions/mathlivebridge/matrixLatex';

describe('interactive matrix amsmath requirements', () => {
	it.each(['matrix', 'pmatrix', 'bmatrix', 'Bmatrix', 'vmatrix', 'Vmatrix'])('requires amsmath for %s', (environment) => {
		expect(requiresAmsmath(`\\begin{${environment}}a\\end{${environment}}`)).toBe(true);
	});

	it.each(['align', 'align*', 'cases', 'aligned', 'split', 'multline'])('recognizes the amsmath %s environment', (environment) => {
		expect(requiresAmsmath(`\\begin{${environment}}a\\end{${environment}}`)).toBe(true);
	});

	it('does not gate ordinary math or mathtools-only environments as amsmath', () => {
		expect(requiresAmsmath('\\frac{a}{b}')).toBe(false);
		expect(requiresAmsmath('\\begin{equation}x\\end{equation}')).toBe(false);
		expect(requiresAmsmath('\\begin{dcases}a\\end{dcases}')).toBe(false);
	});

	it('keeps the interactive 1..10 limit while preserving the legacy matrix generator range', () => {
		expect(validInteractiveMatrixSize(1, 1)).toBe(true);
		expect(validInteractiveMatrixSize(10, 10)).toBe(true);
		expect(validInteractiveMatrixSize(11, 10)).toBe(false);
		expect(requiresAmsmath(generateMatrixLatex(10, 10))).toBe(true);
	});
});
