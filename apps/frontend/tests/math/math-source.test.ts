import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceDocument } from '@modutex/document-core';
import { matrixSize, resizeMatrix, matrixSource, equationSource } from '../../src/features/math/source.ts';
import { createSourceState, sourceState, insertionTarget, insertionTransaction, historyTransaction } from '../../src/features/source-editor/state.ts';

test('matrix dimensions enforce integer 1–10 for square and rectangular matrices', () => {
	for (const value of [0, 11, -1, 1.5, NaN, Infinity]) assert.throws(() => matrixSize(value), /MATRIX_SIZE/);
	for (const value of [1, 10]) assert.equal(matrixSize(value), value);
	assert.throws(() => matrixSource({ rows: 2, columns: 2, cells: ['1'] }, 'none'), /MATRIX_CELLS/);
});
test('resize preserves row/column positions, identifies lost nonempty cells without modifying draft', () => {
	const original = { rows: 2, columns: 3, cells: ['1', '', '3', '4', '5', '6'] };
	const enlarged = resizeMatrix(original, 3, 4);
	assert.deepEqual(enlarged.matrix.cells, ['1', '', '3', '', '4', '5', '6', '', '', '', '', '']);
	assert.equal(enlarged.discarded, false);
	const smaller = resizeMatrix(original, 1, 2); assert.equal(smaller.discarded, true);
	assert.deepEqual(smaller.matrix.cells, ['1', '']); assert.deepEqual(original.cells, ['1', '', '3', '4', '5', '6']);
});
test('matrix emits base-LaTeX array with actual row separators, blanks and escaped cell punctuation', () => {
	assert.equal(matrixSource({ rows: 2, columns: 2, cells: ['1', '', '\\frac{1}{2}', '\\%'] }, 'parentheses'),
		'\\left(\\begin{array}{cc}\n1 & {} \\\\\n\\frac{1}{2} & \\%\n\\end{array}\\right)');
	for (const cell of ['a & b', 'a%comment', 'a\\\\b', '{', '}', '\\begin{array}{c}', 'a\nb', 'a\\'])
		assert.throws(() => matrixSource({ rows: 1, columns: 1, cells: [cell] }, 'none'), /MATRIX_CELL/);
});
test('equation wrapper supports inline/display, requires source and does not add preamble packages', () => {
	assert.equal(equationSource('x^2', true), '\\(x^2\\)');
	assert.equal(equationSource('x^2', false), '\\[\nx^2\n\\]');
	for (const value of ['', ' ', '\u0000', 'x'.repeat(65537)]) assert.throws(() => equationSource(value, false), /EQUATION_SOURCE/);
});
test('tool insertion uses actual CodeMirror undo, preserves unrelated BOM/EOL and rejects stale/foreign targets', () => {
	const original = new TextEncoder().encode('\uFEFF%keep\r\nbody\r\n\\opaque{unchanged}\n');
	let state = createSourceState(SourceDocument.open(original));
	state = state.update({ selection: { anchor: 6, head: 10 } }).state;
	const target = insertionTarget(state);
	state = insertionTransaction(state, target, equationSource('x^2', false)).state;
	assert.equal(state.field(sourceState).projection.document.read(), '%keep\r\n\\[\r\nx^2\r\n\\]\r\n\\opaque{unchanged}\n');
	assert.throws(() => insertionTransaction(state, target, 'wrong'), /STALE_INSERTION/);
	assert.throws(() => insertionTransaction(state, { ...insertionTarget(state), documentId: 'other' }, 'wrong'), /STALE_INSERTION/);
	state = historyTransaction(state, 'undo')!.state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), original);
	assert.equal(state.selection.main.from, 6); assert.equal(state.selection.main.to, 10);
});
