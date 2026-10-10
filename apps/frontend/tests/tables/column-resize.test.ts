import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ColumnDrag, resizeColumns } from '../../src/features/tables/column-resize.ts';
import { createTable, columnPercentages, tableSource, parseTable } from '../../src/features/tables/source.ts';

test('adjacent width exchange preserves pair total, other columns and valid generator weights', () => {
	const weights = [2, 3, 5];
	assert.deepEqual(resizeColumns(weights, 0, 0.1), [3, 2, 5]);
	assert.deepEqual(weights, [2, 3, 5]);
	assert.deepEqual(resizeColumns(weights, 0, -100), [0.25, 4.75, 5]);
	assert.deepEqual(resizeColumns([1000, 1000], 0, 100), [1000, 1000]);
	assert.deepEqual(resizeColumns([0.01, 1000], 0, 0), [0.01, 1000]);
	for (const args of [[[], 0, 0], [[1], 0, 0], [[1, 2], -1, 0], [[1, NaN], 0, 0], [[1, 2], 0, Infinity]] as const) {
		assert.throws(() => resizeColumns(args[0], args[1], args[2]), /COLUMN_RESIZE/);
	}
});

test('single pointer ownership, baseline movement, cancellation and reentry have no cumulative drift', () => {
	const drag = new ColumnDrag();
	assert.equal(drag.begin(1, 100, 1000, 0, [2, 3, 5]), true);
	assert.equal(drag.begin(2, 900, 1000, 1, [2, 3, 5]), false);
	assert.equal(drag.move(2, 900), null);
	assert.deepEqual(drag.move(1, 200), [3, 2, 5]);
	assert.deepEqual(drag.move(1, 200), [3, 2, 5]);
	assert.deepEqual(drag.move(1, 100), [2, 3, 5]);
	assert.equal(drag.end(2), false);
	assert.equal(drag.end(1), true);
	assert.equal(drag.move(1, 200), null);
	assert.equal(drag.begin(3, 0, 360, 0, [1, 1]), true);
	drag.cancel(); drag.cancel(); assert.equal(drag.move(3, 100), null);
	assert.equal(drag.begin(4, 0, 0, 0, [1, 1]), false);
	assert.equal(drag.begin(4, 0, 360, 0, [1, 1]), true);
	assert.equal(drag.end(4), true);
});

test('resized weights generate reeditable table source without changing cells or caption', () => {
	const original = { ...createTable(2, 3), weights: [2, 3, 5], cells: ['雪', 'x', '', 'a', 'b', 'c'], caption: { position: 'above' as const, text: 'Widths' } };
	const resized = { ...original, weights: resizeColumns(original.weights, 1, 0.1) };
	const reread = parseTable(tableSource(resized));
	assert.ok(reread);
	assert.deepEqual(reread.cells, original.cells);
	assert.deepEqual(reread.caption, original.caption);
	assert.deepEqual(columnPercentages(reread).map(value => Math.round(value)), [20, 40, 40]);
});
