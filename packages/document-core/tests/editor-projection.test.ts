import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceDocument, EditorProjection } from '../src/index.ts';
const open = (text: string) => EditorProjection.open(SourceDocument.open(new TextEncoder().encode(text)));
const normalize = (text: string) => text.replace(/\r\n|\r/g, '\n');

for (const fixture of ['', 'a\nb\n', 'a\r\nb\r\n', 'a\rb\r', '\uFEFFa\r\n雪\n😀\rfinal', '\r\n\r\n', 'a\r\nb\nc\rd']) {
	test('editor projection preserves original bytes: ' + JSON.stringify(fixture), () => {
		const initial = open(fixture);
		assert.equal(initial.text, normalize(fixture.replace(/^\uFEFF/, '')));
		assert.deepEqual(initial.projection.document.toBytes(), new TextEncoder().encode(fixture));
		assert.equal(initial.projection.length, initial.text.length);
		assert.equal(initial.projection.toSource(initial.text.length), initial.projection.document.length);
	});
}

test('CRLF positions map the full newline atom, without changing unrelated EOL', () => {
	const initial = open('a\r\nb\nc\rd').projection;
	assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7].map((at) => initial.toSource(at)), [0, 1, 3, 4, 5, 6, 7, 8]);
	const changed = initial.apply([{ from: 2, to: 3, insert: 'B' }], 0);
	assert.equal(changed.document.read(), 'a\r\nB\nc\rd');
	const removed = changed.apply([{ from: 1, to: 2, insert: '' }], 1);
	assert.equal(removed.document.read(), 'aB\nc\rd');
});

test('new line breaks follow the original preferred EOL while old mixed breaks survive', () => {
	const initial = open('a\r\nb\r\nc\nd').projection;
	const changed = initial.apply([{ from: 2, to: 2, insert: 'new\nline\n' }], 0);
	assert.equal(changed.document.read(), 'a\r\nnew\r\nline\r\nb\r\nc\nd');
	assert.equal(changed.toSource(changed.length), changed.document.length);
});

test('multi-range changes use old coordinates and preserve remaining newline positions', () => {
	const initial = open('a\r\nb\r\nc\r\nd').projection;
	const changed = initial.apply([{ from: 0, to: 1, insert: 'AA' }, { from: 4, to: 5, insert: 'C\nC' }], 0);
	assert.equal(changed.document.read(), 'AA\r\nb\r\nC\r\nC\r\nd');
	const next = changed.apply([{ from: changed.length - 1, to: changed.length, insert: 'D' }], 1);
	assert.equal(next.document.read(), 'AA\r\nb\r\nC\r\nC\r\nD');
});

test('undo restores exact mixed newline bytes, redo restores edited bytes, versions stay monotonic', () => {
	const initial = open('\uFEFFa\r\nb\nc\rd').projection;
	const edited = initial.apply([{ from: 1, to: 6, insert: '\nnew\n' }], 0);
	const undo = edited.restore(initial);
	assert.deepEqual(undo.document.toBytes(), initial.document.toBytes());
	assert.equal(undo.document.version, 2);
	const redo = undo.restore(edited);
	assert.deepEqual(redo.document.toBytes(), edited.document.toBytes());
	assert.equal(redo.document.version, 3);
	assert.equal(redo.toSource(redo.length), redo.document.length);
});

test('invalid, stale and Unicode-splitting edits fail without changing the projection', () => {
	const initial = open('😀\r\ntext').projection;
	const original = initial.document.toBytes();
	assert.throws(() => initial.apply([{ from: 1, to: 1, insert: 'x' }], 0));
	assert.throws(() => initial.apply([{ from: 0, to: 0, insert: '\r\n' }], 0));
	assert.throws(() => initial.apply([{ from: 0, to: 0, insert: 'x' }], 2));
	assert.throws(() => initial.apply([{ from: 0, to: 2, insert: 'x' }, { from: 1, to: 2, insert: 'y' }], 0));
	assert.throws(() => initial.toSource(-1));
	assert.throws(() => initial.restore(open('other').projection));
	assert.deepEqual(initial.document.toBytes(), original);
});

test('deterministic incremental edits agree with an independent normalized-text oracle', () => {
	let projection = open('a\r\nb\nc\rd\r\n').projection;
	let oracle = normalize(projection.document.read());
	for (let index = 0; index < 150; index++) {
		const from = (index * 17) % (oracle.length + 1);
		const to = Math.min(oracle.length, from + index % 3);
		const insert = ['x', '\n', 'A\nB', ''][index % 4]!;
		projection = projection.apply([{ from, to, insert }], projection.document.version);
		oracle = oracle.slice(0, from) + insert + oracle.slice(to);
		for (const correction of [...projection.editorCorrections].reverse()) {
			oracle = oracle.slice(0, correction.from) + correction.insert + oracle.slice(correction.to);
		}
		assert.equal(normalize(projection.document.read()), oracle);
		assert.equal(projection.length, oracle.length);
		assert.equal(projection.toSource(oracle.length), projection.document.length);
	}
});

test('deleting between standalone CR and LF preserves bytes and reports the editor newline merge', () => {
	const initial = open('\n\nA\rX\nZ').projection;
	const changed = initial.apply([{ from: 4, to: 5, insert: '' }], 0);
	assert.equal(changed.document.read(), '\n\nA\r\nZ');
	assert.deepEqual(changed.editorCorrections, [{ from: 4, to: 5, insert: '' }]);
	assert.equal(changed.length, normalize(changed.document.read()).length);
	assert.equal(changed.toSource(changed.length), changed.document.length);
	assert.deepEqual(changed.restore(initial).document.toBytes(), initial.document.toBytes());
});

test('inserting preferred LF after an existing CR corrects only the newly joined atom', () => {
	const initial = open('\n\nA\rZ').projection;
	const changed = initial.apply([{ from: 4, to: 4, insert: '\n' }], 0);
	assert.equal(changed.document.read(), '\n\nA\r\nZ');
	assert.deepEqual(changed.editorCorrections, [{ from: 4, to: 5, insert: '' }]);
	assert.equal(changed.length, normalize(changed.document.read()).length);
});

test('inserting preferred CR before LF preserves the original LF and updates coordinates', () => {
	const initial = open('\r\rA\nZ').projection;
	const changed = initial.apply([{ from: 3, to: 3, insert: '\n' }], 0);
	assert.equal(changed.document.read(), '\r\rA\r\nZ');
	assert.deepEqual(changed.editorCorrections, [{ from: 4, to: 5, insert: '' }]);
	assert.equal(changed.length, normalize(changed.document.read()).length);
});
