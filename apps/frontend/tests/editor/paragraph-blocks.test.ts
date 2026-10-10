import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from 'prosemirror-state';
import { SourceDocument, parseSource } from '@modutex/document-core';
import { projectVisual, visualPatches, advanceVisual } from '../../src/features/visual-editor/schema.ts';
import { createSourceState, sourceState, sourcePatchTransaction, historyTransaction } from '../../src/features/source-editor/state.ts';

for (const marker of ['null', 'par']) test(`${marker} paragraph accepts consecutive visual edits and exact shared undo`, () => {
	const suffix = marker === 'par' ? '\r\n' : '';
	const original = SourceDocument.open(new TextEncoder().encode(`\uFEFF\\documentclass{article}\r\n\\begin{document}\\${marker}${suffix}\\end{document}\n`));
	let editor = createSourceState(original);
	let projection = projectVisual(original, parseSource(original));
	let visual = EditorState.create({ doc: projection.document });
	let position = -1;
	visual.doc.forEach((node, offset) => { if (node.attrs.name === marker) position = offset + 1 + node.content.size; });
	assert.ok(position >= 0);
	assert.equal(visual.doc.resolve(position).parent.type.name, 'source_block');
	for (const value of ['a', '%']) {
		const source = editor.field(sourceState).projection.document;
		const transaction = visual.tr.insertText(value, position);
		const patches = visualPatches(source, projection, transaction);
		editor = sourcePatchTransaction(editor, projection, patches).state;
		projection = advanceVisual(source, projection, transaction, editor.field(sourceState).projection.document);
		visual = visual.apply(transaction);
		position += value.length;
	}
	const edited = editor.field(sourceState).projection.document;
	assert.equal(edited.read(), original.read().replace(`\\${marker}${suffix}`, (marker === 'par' ? '\\par' + suffix : '') + 'a\\%'));
	const reparsed = projectVisual(edited, parseSource(edited));
	assert.equal(reparsed.document.childCount, 1);
	assert.equal(reparsed.document.firstChild?.textContent, (marker === 'par' ? '\n' : '') + 'a%');
	for (let count = 0; count < 2; count++) { const undo = historyTransaction(editor, 'undo'); assert.ok(undo); editor = undo.state; }
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
});

test('paragraph boundaries persist after editing while unknown command arguments stay raw', () => {
	const source = SourceDocument.open(new TextEncoder().encode('\\begin{document}Before\\par After\\null{keep}\\end{document}'));
	const projection = projectVisual(source, parseSource(source));
	assert.equal(projection.document.child(0).textContent, 'Before');
	assert.equal(projection.document.child(1).textContent, ' After');
	assert.equal(projection.document.child(2).type.name, 'raw_block');
	assert.equal(projection.document.child(2).attrs.source, '\\null{keep}');
});
