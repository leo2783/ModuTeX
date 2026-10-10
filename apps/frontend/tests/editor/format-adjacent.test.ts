import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { SourceDocument, parseSource } from '@modutex/document-core';
import { formatTransaction } from '../../src/features/source-editor/format.ts';
import { createSourceState, historyTransaction, sourceState } from '../../src/features/source-editor/state.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

function selectedBetween(text: string, first: string, last: string) {
	const source = SourceDocument.open(bytes(text));
	let state = createSourceState(source);
	const doc = state.doc.toString();
	const from = doc.indexOf(first), end = first === last ? from : doc.indexOf(last, from + first.length);
	assert.ok(from >= 0 && end >= from);
	state = state.update({ selection: { anchor: from, head: end + last.length } }).state;
	return { source, state };
}

test('applies across adjacent plain and formatted leaves, then toggles off with shared exact history', () => {
	const original = '\uFEFFbefore\r\nplain \\emph{marked} tail\n\\opaque{keep\\%😀}\r';
	const expected = '\uFEFFbefore\r\n\\textbf{plain \\emph{marked} tail}\n\\opaque{keep\\%😀}\r';
	let { source, state } = selectedBetween(original, 'plain', 'tail');
	const originalSelection = state.selection;

	state = formatTransaction(state, parseSource(source), 'strong').state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(expected));
	assert.equal(state.doc.sliceString(state.selection.main.from, state.selection.main.to), 'plain \\emph{marked} tail');
	assert.equal(state.field(sourceState).undo.length, 1);

	state = historyTransaction(state, 'undo')!.state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original));
	assert.equal(state.selection.eq(originalSelection), true);
	state = historyTransaction(state, 'redo')!.state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(expected));

	state = formatTransaction(state, parseSource(state.field(sourceState).projection.document), 'strong').state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original));
	state = historyTransaction(state, 'undo')!.state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(expected));
	state = historyTransaction(state, 'redo')!.state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original));
	assert.deepEqual(source.toBytes(), bytes(original));
});

const prefix = '\uFEFFbefore\r\n';
const suffix = '\n\\opaque{neighbor}\r';
const adjacentCancellation = [
	{ format: 'strong', wrapper: '\\textbf{one}\\textbf{two}' },
	{ format: 'em', wrapper: '\\textit{one}\\emph{two}' },
	{ format: 'underline', wrapper: '\\underline{one}\\underline{two}' }
] as const;

for (const { format, wrapper } of adjacentCancellation) {
	test(`${format} cancels adjacent known marks across decoded leaves without rewriting neighbors`, () => {
		const original = prefix + wrapper + suffix, expected = prefix + 'onetwo' + suffix;
		let { source, state } = selectedBetween(original, 'one', 'two');
		state = formatTransaction(state, parseSource(source), format).state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(expected));
		assert.equal(state.field(sourceState).undo.length, 1);
		state = historyTransaction(state, 'undo')!.state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original));
		state = historyTransaction(state, 'redo')!.state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(expected));
		assert.deepEqual(source.toBytes(), bytes(original));
	});
}

const adjacentApplications = [
	{
		format: 'strong',
		wrapper: 'plain \\emph{marked} tail',
		expected: '\\textbf{plain \\emph{marked} tail}',
		first: 'plain',
		last: 'tail'
	},
	{
		format: 'em',
		wrapper: '\\textbf{one} plain \\underline{two}',
		expected: '\\textit{\\textbf{one} plain \\underline{two}}',
		first: 'one',
		last: 'two'
	},
	{
		format: 'underline',
		wrapper: '\\emph{one} plain \\textbf{two}',
		expected: '\\underline{\\emph{one} plain \\textbf{two}}',
		first: 'one',
		last: 'two'
	}
] as const;

for (const { format, wrapper, expected, first, last } of adjacentApplications) {
	test(`${format} applies across known mixed wrappers and plain text with exact BOM/EOL preservation`, () => {
		const original = prefix + wrapper + suffix;
		const { source, state } = selectedBetween(original, first, last);
		const changed = formatTransaction(state, parseSource(source), format).state;
		assert.deepEqual(changed.field(sourceState).projection.document.toBytes(), bytes(prefix + expected + suffix));
		assert.deepEqual(source.toBytes(), bytes(original));
	});
}

test('cancelling adjacent strong wrappers at both selection boundaries preserves other marks', () => {
	const original = prefix + '\\textbf{A\\emph{ab}}\\textbf{\\underline{cd}D}' + suffix;
	const expected = prefix + '\\textbf{A}\\emph{ab}\\underline{cd}\\textbf{D}' + suffix;
	let { source, state } = selectedBetween(original, 'ab', 'cd');
	state = formatTransaction(state, parseSource(source), 'strong').state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(expected));
	assert.equal(state.field(sourceState).undo.length, 1);
	state = historyTransaction(state, 'undo')!.state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original));
	state = historyTransaction(state, 'redo')!.state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(expected));
});

test('nested emph inversion is not mistaken for an active em mark', () => {
	const original = '\uFEFF\\emph{\\emph{word}}';
	const expected = '\uFEFF\\emph{\\emph{\\textit{word}}}';
	const { source, state } = selectedBetween(original, 'word', 'word');
	const changed = formatTransaction(state, parseSource(source), 'em').state;
	assert.deepEqual(changed.field(sourceState).projection.document.toBytes(), bytes(expected));
	assert.deepEqual(source.toBytes(), bytes(original));
});

test('multi-leaf formatting refuses unsafe inline syntax and paragraph or heading crossings atomically', () => {
	const refused = [
		['left \\opaque{unknown} right', 'left', 'right'],
		['left % comment\nright', 'left', 'right'],
		['left $x^2$ right', 'left', 'right'],
		['left \\verb|raw| right', 'left', 'right'],
		['first\n\nsecond', 'first', 'second'],
		['\\section{title}\nbody', 'title', 'body']
	] as const;
	for (const [text, first, last] of refused) {
		const { source, state } = selectedBetween(text, first, last);
		const before = state.field(sourceState);
		assert.throws(() => formatTransaction(state, parseSource(source), 'strong'), /FORMAT_RANGE/, text);
		assert.equal(state.field(sourceState), before);
		assert.equal(state.field(sourceState).dirty, false);
		assert.equal(state.field(sourceState).undo.length, 0);
		assert.deepEqual(source.toBytes(), bytes(text));
	}
});

test('multi-leaf operations retain stale-source and read-only guards', () => {
	const original = '\uFEFFplain \\emph{marked} tail';
	const { source, state } = selectedBetween(original, 'plain', 'tail');
	const parsed = parseSource(source);
	const projection = state.field(sourceState).projection;
	const from = projection.toSource(state.selection.main.from), to = projection.toSource(state.selection.main.to);
	assert.throws(() => formatTransaction(state, parsed, 'strong', {
		documentId: source.documentId, version: source.version + 1, from, to
	}), /STALE_FORMAT/);
	const edited = state.update({ changes: { from: 0, insert: 'new ' } }).state;
	assert.throws(() => formatTransaction(edited, parsed, 'strong'), /STALE_FORMAT/);
	const readonly = createSourceState(source, undefined, EditorState.readOnly.of(true));
	assert.throws(() => formatTransaction(readonly, parsed, 'strong'), /EDITOR_READ_ONLY/);
	assert.deepEqual(source.toBytes(), bytes(original));
});
