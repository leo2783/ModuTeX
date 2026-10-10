import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { SourceDocument, parseSource } from '@modutex/document-core';
import { formatTransaction } from '../../src/features/source-editor/format.ts';
import { createSourceState, historyTransaction, sourceState } from '../../src/features/source-editor/state.ts';

const bytes = (text: string) => new TextEncoder().encode(text);

function selected(text: string, needle: string) {
	const source = SourceDocument.open(bytes(text));
	let state = createSourceState(source);
	const from = state.doc.toString().indexOf(needle);
	assert.ok(from >= 0);
	state = state.update({ selection: { anchor: from, head: from + needle.length } }).state;
	return { source, state };
}

test('nested strong cancellation edits only wrapper boundaries and shares exact undo, redo and repeated toggles', () => {
	const original = '\uFEFFbefore\r\n\\textbf{L\\emph{ab\\underline{😀CDxy}zz}R}\n\\opaque{keep\\%😀}\r';
	const expected = '\uFEFFbefore\r\n\\textbf{L\\emph{ab}}\\emph{\\underline{😀C}}\\textbf{\\emph{\\underline{Dxy}zz}R}\n\\opaque{keep\\%😀}\r';
	let { source, state } = selected(original, '😀C');
	const originalSelection = state.selection;
	const projection = state.field(sourceState).projection;
	const span = { documentId: source.documentId, version: source.version,
		from: projection.toSource(state.selection.main.from), to: projection.toSource(state.selection.main.to) };

	state = formatTransaction(state, parseSource(source), 'strong', span).state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(expected));
	assert.equal(state.doc.sliceString(state.selection.main.from, state.selection.main.to), '😀C');
	assert.equal(state.field(sourceState).undo.length, 1);
	assert.equal(state.field(sourceState).dirty, true);

	state = historyTransaction(state, 'undo')!.state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original));
	assert.equal(state.selection.eq(originalSelection), true);
	assert.equal(state.field(sourceState).dirty, false);
	state = historyTransaction(state, 'redo')!.state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(expected));

	const reapplied = expected.replace('😀C', '\\textbf{😀C}');
	state = formatTransaction(state, parseSource(state.field(sourceState).projection.document), 'strong').state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(reapplied));
	state = formatTransaction(state, parseSource(state.field(sourceState).projection.document), 'strong').state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(expected));
	state = historyTransaction(state, 'undo')!.state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(reapplied));
	state = historyTransaction(state, 'redo')!.state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(expected));
	assert.deepEqual(source.toBytes(), bytes(original));
});

const prefix = '\uFEFFbefore\r\n';
const suffix = '\n\\opaque{neighbor}\r';
const strongEdges = [
	{
		label: 'at the start of a nested text leaf',
		wrapper: '\\textbf{L\\emph{picktail}R}',
		expected: '\\textbf{L}\\emph{pick}\\textbf{\\emph{tail}R}'
	},
	{
		label: 'at the end of a nested text leaf',
		wrapper: '\\textbf{L\\emph{headpick}R}',
		expected: '\\textbf{L\\emph{head}}\\emph{pick}\\textbf{R}'
	},
	{
		label: 'at the start of the chosen wrapper content',
		wrapper: '\\textbf{\\emph{picktail}}',
		expected: '\\emph{pick}\\textbf{\\emph{tail}}'
	},
	{
		label: 'at the end of the chosen wrapper content',
		wrapper: '\\textbf{\\emph{headpick}}',
		expected: '\\textbf{\\emph{head}}\\emph{pick}'
	}
] as const;

for (const { label, wrapper, expected } of strongEdges) {
	test(`strong partial cancellation ${label} preserves nested marks and neighboring bytes`, () => {
		const original = prefix + wrapper + suffix;
		const { source, state } = selected(original, 'pick');
		const changed = formatTransaction(state, parseSource(source), 'strong').state;
		assert.deepEqual(changed.field(sourceState).projection.document.toBytes(), bytes(prefix + expected + suffix));
		assert.equal(changed.doc.sliceString(changed.selection.main.from, changed.selection.main.to), 'pick');
		assert.deepEqual(source.toBytes(), bytes(original));
	});
}

for (const { format, wrapper, expected } of [
	{ format: 'em', wrapper: '\\emph{L\\textbf{abCD}R}', expected: '\\emph{L\\textbf{ab}}\\textbf{CD}\\emph{R}' },
	{ format: 'underline', wrapper: '\\underline{L\\emph{abCD}R}', expected: '\\underline{L\\emph{ab}}\\emph{CD}\\underline{R}' }
] as const) {
	test(`${format} partial cancellation inside a known nested wrapper preserves the nested mark`, () => {
		const original = prefix + wrapper + suffix;
		const { source, state } = selected(original, 'CD');
		const changed = formatTransaction(state, parseSource(source), format).state;
		assert.deepEqual(changed.field(sourceState).projection.document.toBytes(), bytes(prefix + expected + suffix));
		assert.equal(changed.doc.sliceString(changed.selection.main.from, changed.selection.main.to), 'CD');
	});
}

test('nested cancellation rejects unsupported paths, stale parser/span identities and read-only states', () => {
	const original = '\uFEFF\\textbf{L\\emph{picktail}R}';
	const { source, state } = selected(original, 'pick');
	const parsed = parseSource(source);
	const checkpoint = state.field(sourceState);
	const projection = checkpoint.projection;
	const from = projection.toSource(state.selection.main.from), to = projection.toSource(state.selection.main.to);

	assert.throws(() => formatTransaction(state, parsed, 'strong', {
		documentId: source.documentId, version: source.version + 1, from, to
	}), /STALE_FORMAT/);
	const edited = state.update({ changes: { from: 0, insert: 'new ' } }).state;
	assert.throws(() => formatTransaction(edited, parsed, 'strong'), /STALE_FORMAT/);

	const readonly = createSourceState(source, undefined, EditorState.readOnly.of(true));
	assert.throws(() => formatTransaction(readonly, parsed, 'strong'), /EDITOR_READ_ONLY/);

	for (const unsafe of [
		'\uFEFF\\textbf{L\\opaque{keep}\\emph{pick}R}',
		'\uFEFF\\textbf{pick\\emph{keep}}',
		'\uFEFF\\textbf{L\\opaque{pick}R}'
	]) {
		const fixture = selected(unsafe, 'pick');
		const before = fixture.state.field(sourceState);
		assert.throws(() => formatTransaction(fixture.state, parseSource(fixture.source), 'strong'), /FORMAT_RANGE/);
		assert.equal(fixture.state.field(sourceState), before);
		assert.equal(fixture.state.field(sourceState).dirty, false);
		assert.equal(fixture.state.field(sourceState).undo.length, 0);
		assert.deepEqual(fixture.source.toBytes(), bytes(unsafe));
	}

	assert.equal(state.field(sourceState), checkpoint);
	assert.equal(readonly.field(sourceState).undo.length, 0);
	assert.deepEqual(source.toBytes(), bytes(original));
});
