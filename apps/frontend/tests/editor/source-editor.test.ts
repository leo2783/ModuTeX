import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceDocument } from '@modutex/document-core';
import { createSourceState, sourceState, historyTransaction, savedCheckpoint } from '../../src/features/source-editor/state.ts';
import { sourceLimit } from '../../src/features/files/read.ts';
const bytes = (text: string) => new TextEncoder().encode(text);

test('5 MiB source edits enforce UTF-8 bytes atomically and keep selection, dirty and undo on rejection', () => {
	const input = new Uint8Array(sourceLimit - 1).fill(0x61);
	input.set([0xef, 0xbb, 0xbf]); input.set([13, 10], 3);
	const reasons: (string | undefined)[] = [];
	let state = createSourceState(SourceDocument.open(input), reason => reasons.push(reason));
	state = state.update({ selection: { anchor: 10 } }).state;
	const prior = state.field(sourceState);
	const rejected = state.update({ changes: { from: 10, insert: '雪' } }).state;
	assert.equal(rejected.field(sourceState), prior);
	assert.equal(rejected.selection.main.anchor, 10);
	assert.deepEqual(rejected.field(sourceState).projection.document.toBytes(), input);
	assert.deepEqual(reasons, ['SOURCE_TOO_LARGE']);
	state = state.update({ changes: { from: 10, insert: 'x' } }).state;
	assert.equal(state.field(sourceState).projection.document.byteLength, sourceLimit);
	assert.equal(state.field(sourceState).undo.length, 1);
	state = historyTransaction(state, 'undo')!.state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), input);
	assert.equal(state.field(sourceState).dirty, false);
	assert.throws(() => createSourceState(SourceDocument.open(new Uint8Array(sourceLimit + 1).fill(97))), /SOURCE_TOO_LARGE/);
});

test('real CodeMirror transactions preserve BOM and untouched mixed EOL, undo restores exact bytes', () => {
	const original = bytes('\uFEFFa\r\n雪\nlast\r');
	let state = createSourceState(SourceDocument.open(original));
	assert.equal(state.field(sourceState).projection.document.profile.preferredLineEnding, '\n');
	assert.equal(state.doc.toString(), 'a\n雪\nlast\n');
	state = state.update({ changes: { from: 0, insert: 'X\n' } }).state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes('\uFEFFX\na\r\n雪\nlast\r'));
	const version = state.field(sourceState).projection.document.version;
	state = historyTransaction(state, 'undo')!.state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), original);
	assert.equal(state.field(sourceState).dirty, false);
	assert.ok(state.field(sourceState).projection.document.version > version);
	state = historyTransaction(state, 'redo')!.state;
	assert.equal(state.doc.toString(), 'X\na\n雪\nlast\n');
});
test('boundary corrections compose into the same CodeMirror transaction and undo', () => {
	let state = createSourceState(SourceDocument.open(bytes('a\rX\nb')));
	state = state.update({ changes: { from: 2, to: 3 } }).state;
	assert.equal(state.doc.toString(), 'a\nb');
	assert.equal(state.field(sourceState).projection.document.read(), 'a\r\nb');
	state = historyTransaction(state, 'undo')!.state;
	assert.equal(state.doc.toString(), 'a\nX\nb');
	assert.equal(state.field(sourceState).projection.document.read(), 'a\rX\nb');
});
test('selection and multi-range changes survive undo, and new edits invalidate redo', () => {
	let state = createSourceState(SourceDocument.open(bytes('abc\r\ndef')));
	state = state.update({ selection: { anchor: 2 } }).state;
	state = state.update({ changes: [{ from: 0, to: 1, insert: 'Q' }, { from: 5, to: 6, insert: 'R' }] }).state;
	state = historyTransaction(state, 'undo')!.state;
	assert.equal(state.selection.main.anchor, 2);
	state = state.update({ changes: { from: 0, insert: '!' } }).state;
	assert.equal(historyTransaction(state, 'redo'), null);
});
test('invalid scalar edits are rejected atomically without adding history', () => {
	let rejected = 0;
	const state = createSourceState(SourceDocument.open(bytes('😀')), () => rejected++);
	const next = state.update({ changes: { from: 1, insert: 'X' } }).state;
	assert.equal(next.doc.toString(), '😀');
	assert.equal(next.field(sourceState).undo.length, 0);
	assert.equal(rejected, 1);
});

test('bounded history does not report clean after older unsaved changes leave its window', () => {
	let state = createSourceState(SourceDocument.open(bytes('start')));
	for (let index = 0; index < 205; index++) state = state.update({ changes: { from: 0, insert: 'x' } }).state;
	assert.equal(state.field(sourceState).undo.length, 200);
	for (let index = 0; index < 200; index++) state = historyTransaction(state, 'undo')!.state;
	assert.equal(state.doc.toString(), 'xxxxxstart');
	assert.equal(state.field(sourceState).dirty, true);
});

test('successful save establishes a checkpoint without losing undo history', () => {
	let state = createSourceState(SourceDocument.open(bytes('start')));
	state = state.update({ changes: { from: 0, insert: 'x' } }).state;
	state = state.update({ effects: savedCheckpoint.of(state.field(sourceState).projection.document.version) }).state;
	assert.equal(state.field(sourceState).dirty, false);
	state = historyTransaction(state, 'undo')!.state;
	assert.equal(state.field(sourceState).dirty, true);
	state = historyTransaction(state, 'redo')!.state;
	assert.equal(state.field(sourceState).dirty, false);
	state = state.update({ changes: { from: 0, insert: 'y' } }).state;
	state = state.update({ effects: savedCheckpoint.of(1) }).state;
	assert.equal(state.field(sourceState).dirty, true);
	const version = state.field(sourceState).projection.document.version;
	state = state.update({ changes: { from: 0, insert: 'z' }, effects: savedCheckpoint.of(version) }).state;
	assert.equal(state.field(sourceState).dirty, true);
	assert.equal(state.field(sourceState).projection.document.read(), 'zyxstart');
});
