import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceDocument } from '@modutex/document-core';
import { createSourceState, sourceState, paragraphInsertionTransaction, historyTransaction } from '../../src/features/source-editor/state.ts';

for (const eol of ['\n', '\r\n']) for (const beforeText of [false, true]) {
	for (const position of ['start', 'middle', 'end', 'replace'] as const) test(`paragraph ${position} ${JSON.stringify(eol)} beforeText=${beforeText} uses local marker and exact undo`, () => {
		const text = `\\par${eol}left \\opaque{\\par} right${eol}\\par${eol}tail`;
		const original = SourceDocument.open(new TextEncoder().encode('\uFEFF' + text));
		const state = createSourceState(original);
		const from = position === 'start' ? 0 : position === 'end' ? original.length : text.indexOf('right');
		const to = position === 'replace' ? from + 5 : from;
		// Guard the production helper against accidentally materializing the whole source.
		const read = SourceDocument.prototype.read;
		let result: ReturnType<typeof paragraphInsertionTransaction>;
		SourceDocument.prototype.read = function(start?: number, end?: number) {
			assert.notEqual(start, undefined, 'insertion must only read bounded source spans');
			assert.notEqual(end, undefined);
			return read.call(this, start, end);
		};
		try { result = paragraphInsertionTransaction(state, { documentId: original.documentId, version: 0, from, to }, beforeText); }
		finally { SourceDocument.prototype.read = read; }
		const edited = result.transaction.state.field(sourceState).projection.document;
		assert.equal(edited.read(result.paragraph.from, result.paragraph.from + 4), '\\par');
		assert.equal(result.paragraph.version, 1);
		assert.ok(result.paragraph.from >= from);
		assert.ok(result.paragraph.from < from + 2 + (beforeText ? 12 : 6));
		assert.equal(edited.read(0, from), text.slice(0, from));
		assert.ok(edited.read().endsWith(text.slice(to)));
		const undo = historyTransaction(result.transaction.state, 'undo')!;
		assert.deepEqual(undo.state.field(sourceState).projection.document.toBytes(), original.toBytes());
		const redo = historyTransaction(undo.state, 'redo')!;
		assert.deepEqual(redo.state.field(sourceState).projection.document.toBytes(), edited.toBytes());
	});
}
