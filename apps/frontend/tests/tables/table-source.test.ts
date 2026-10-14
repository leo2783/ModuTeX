import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceDocument, parseSource } from '@modutex/document-core';
import { createTable, columnPercentages, changeTableAxis, tableSource, parseTable, tableAt } from '../../src/features/tables/source.ts';
import { createSourceState, insertionTarget, rangeInsertionTarget, insertionTransaction, sourceState, historyTransaction } from '../../src/features/source-editor/state.ts';

test('table styles generate base-LaTeX borders, header and normalized widths without optional packages', () => {
	const table = { ...createTable(3, 2), cells: ['Name', 'Value', 'A', '1', 'B', '2'], weights: [2, 1] };
	const percentages = columnPercentages(table);
	assert.ok(Math.abs(percentages[0]! - 200 / 3) < 1e-10);
	assert.ok(Math.abs(percentages.reduce((sum, value) => sum + value, 0) - 100) < 1e-10);
	const source = tableSource(table);
	assert.equal(source.match(/\\hline/g)?.length, 3);
	assert.match(source, /\\textbf\{Name\}/);
	assert.match(source, /0\.533333\\linewidth-2\\tabcolsep/);
	assert.equal(source.includes('usepackage'), false);
	assert.equal(tableSource({ ...table, style: 'horizontal' }).match(/\\hline/g)?.length, 4);
	assert.match(tableSource({ ...table, style: 'full' }), /\{\|p\{/);
	assert.equal(tableSource({ ...table, header: false }).includes('textbf'), false);
});
test('caption placement and literal text escaping do not inject TeX structure', () => {
	const table = { ...createTable(1, 1), cells: ['A & 10% \\end{tabular}'], caption: { position: 'above' as const, text: 'Rate_#1' } };
	const above = tableSource(table);
	assert.ok(above.indexOf('\\caption') < above.indexOf('\\begin{tabular}'));
	assert.match(above, /A \\& 10\\% \\textbackslash\{\}end\\\{tabular\\\}/);
	assert.ok(tableSource({ ...table, caption: { ...table.caption, position: 'below' } }).indexOf('\\caption') > above.indexOf('\\begin{tabular}'));
	assert.equal(tableSource({ ...table, caption: { ...table.caption, position: 'none' } }).includes('caption'), false);
	assert.equal(table.caption.text, 'Rate_#1');
});
test('adjacent row/column edits preserve cell coordinates and report destructive proposals', () => {
	const original = { ...createTable(2, 2), cells: ['a', 'b', 'c', 'd'] };
	const added = changeTableAxis(original, 'column', 'insert', 1).table;
	assert.deepEqual(added.cells, ['a', '', 'b', 'c', '', 'd']);
	const removed = changeTableAxis(added, 'row', 'delete', 0);
	assert.equal(removed.discarded, true);
	assert.deepEqual(removed.table.cells, ['c', '', 'd']);
	assert.deepEqual(original.cells, ['a', 'b', 'c', 'd']);
	assert.throws(() => changeTableAxis(createTable(1, 1), 'row', 'delete', 0));
	assert.throws(() => changeTableAxis(createTable(100, 1), 'row', 'insert', 100));
});
test('invalid table values are rejected before generating source', () => {
	assert.throws(() => createTable(1e9, 1e9)); // Reject before allocating cells.
	for (const changes of [{ width: NaN }, { width: 101 }, { weights: [0, 1, 1] }, { cells: ['a\nb'] }]) assert.throws(() => tableSource({ ...createTable(), ...changes }));
});
test('table insertion uses one actual source transaction and undo restores unrelated BOM and EOL', () => {
	const original = SourceDocument.open(new TextEncoder().encode('\uFEFF% untouched\r\n\\opaque{keep}\n'));
	let state = createSourceState(original);
	const target = insertionTarget(state);
	state = insertionTransaction(state, target, tableSource(createTable(2, 2))).state;
	assert.ok(state.field(sourceState).projection.document.read().endsWith(original.read()));
	const undo = historyTransaction(state, 'undo');
	assert.ok(undo);
	assert.deepEqual(undo.state.field(sourceState).projection.document.toBytes(), original.toBytes());
});

test('generated table round-trip decodes cells, widths, headers and captions without guessing unknown syntax', () => {
	for (const style of ['three-line', 'full', 'horizontal'] as const) for (const position of ['none', 'above', 'below'] as const) {
		const draft = { ...createTable(4, 3), style, weights: [3, 2, 1], cells: ['a & b', '10%', '\\{}_$^~#', '', '雪', 'x', '1', '2', '3', '4', '5', '6'], caption: { position, text: 'Caption_#1' } };
		const source = tableSource(draft), parsed = parseTable(source.replaceAll('\n', '\r\n'));
		assert.ok(parsed, style + '/' + position);
		assert.deepEqual(parsed.cells, draft.cells);
		assert.equal(tableSource(parsed), source);
		assert.equal(parsed.caption.position, position);
	}
	assert.equal(parseTable('\\begin{tabular}{ll}a & b\\\\\\end{tabular}'), null);
	assert.equal(parseTable(tableSource(createTable()).replace('\\hline', '\\toprule')), null);
	assert.equal(parseTable(tableSource(createTable()).replace('\\textbf{{}}', '\\textbf{\\unknown{}}')), null);
});
test('table reread and range replacement preserve surrounding mixed EOL and reject stale span', () => {
	const table = tableSource(createTable(3, 2)).replaceAll('\n', '\r\n');
	const prefix = '% untouched\r\n\\begin{document}\n', suffix = '\r\n\\opaque{keep}\n\\end{document}';
	const original = SourceDocument.open(new TextEncoder().encode('\uFEFF' + prefix + table + suffix));
	let state = createSourceState(original);
	const located = tableAt(original, parseSource(original), prefix.length + 30);
	assert.ok(located);
	const target = rangeInsertionTarget(state, located.span);
	state = insertionTransaction(state, target, tableSource({ ...located.draft, caption: { position: 'below', text: 'Result' } })).state;
	const changed = state.field(sourceState).projection.document;
	assert.ok(changed.read().startsWith(prefix)); assert.ok(changed.read().endsWith(suffix));
	assert.throws(() => rangeInsertionTarget(state, located.span));
	assert.equal(tableAt(changed, parseSource(original), prefix.length + 30), null);
	assert.ok(tableAt(changed, parseSource(changed), prefix.length + 30));
	const undo = historyTransaction(state, 'undo'); assert.ok(undo);
	assert.deepEqual(undo.state.field(sourceState).projection.document.toBytes(), original.toBytes());
});
