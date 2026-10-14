import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceDocument, parseSource, type SourceSpan } from '@modutex/document-core';
import { createSourceState, sourceState, historyTransaction } from '../../src/features/source-editor/state.ts';
import { projectVisual } from '../../src/features/visual-editor/schema.ts';
import { cellMoveTransaction } from '../../src/features/source-editor/cell-move.ts';

test('arbitrary notebook moves retain each paragraph, unknown syntax and exact-byte undo', () => {
	const source = SourceDocument.open(new TextEncoder().encode('\uFEFF\\documentclass{article}\r\n\\begin{document}\r\nFirst\r\n\\par Second\n\\[x^2\\]\r\n\\unknown{keep}\n\\par Third\r\n\\end{document}\r\n'));
	let state = createSourceState(source);
	const doc = projectVisual(source, parseSource(source)).document;
	const cells: SourceSpan[] = []; doc.forEach(node => cells.push({ documentId: source.documentId, version: source.version, from: node.attrs.from, to: node.attrs.to }));
	const transaction = cellMoveTransaction(state, cells, 0, cells.length)!; state = state.update(transaction).state;
	const next = state.field(sourceState).projection.document;
	const nextDoc = projectVisual(next, parseSource(next)).document;
	assert.equal(nextDoc.childCount, doc.childCount);
	assert.match(next.read(), /\\unknown\{keep\}/);
	assert.ok(next.read().indexOf('Second') < next.read().indexOf('First'));
	assert.equal(nextDoc.lastChild!.textContent.trim(), 'First');
	assert.throws(() => cellMoveTransaction(state, cells, 1, 0), /STALE/);
	state = state.update(historyTransaction(state, 'undo')!).state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), source.toBytes());
});

test('unchanged drop boundaries do not enter shared history', () => {
	const source = SourceDocument.open(new TextEncoder().encode('\\begin{document}A\\par B\\end{document}'));
	const state = createSourceState(source), doc = projectVisual(source, parseSource(source)).document;
	const cells: SourceSpan[] = []; doc.forEach(node => cells.push({ documentId: source.documentId, version: source.version, from: node.attrs.from, to: node.attrs.to }));
	assert.equal(cellMoveTransaction(state, cells, 0, 0), null);
	assert.equal(cellMoveTransaction(state, cells, 0, 1), null);
});
