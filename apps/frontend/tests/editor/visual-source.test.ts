import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState as VisualState } from 'prosemirror-state';
import { EditorState } from '@codemirror/state';
import { SourceDocument, parseSource } from '@modutex/document-core';
import { visualSchema, projectVisual, visualPatches, escapeVisualText, advanceVisual } from '../../src/features/visual-editor/schema.ts';
import { createSourceState, sourceState, sourcePatchTransaction, historyTransaction } from '../../src/features/source-editor/state.ts';
const source = (value: string) => SourceDocument.open(new TextEncoder().encode(value));

test('one persistent PM state edits shifted blocks while fresh source anchors remain separate from presentation metadata', () => {
	const originalText = '\uFEFF\\section{One}\r\nBody $x$ \\opaque{keep}\r\n\\section{Two}\nTail';
	const original = source(originalText);
	let editor = createSourceState(original), projection = projectVisual(original, parseSource(original));
	let visual = VisualState.create({ doc: projection.document }), expected = originalText;
	const raw = [...Array(visual.doc.childCount)].map((_, index) => visual.doc.child(index)).find(node => node.type.name === 'raw_block');
	assert.ok(raw);
	for (const [label, local, insert] of [['One', 3, '雪'], ['Two', 1, '😀'], ['Tail', 2, '%'], ['Body', 1, '&']] as const) {
		let position = -1;
		visual.doc.descendants((node, offset) => {
			if (position < 0 && node.isText && node.text!.includes(label)) position = offset + node.text!.indexOf(label) + local;
		});
		assert.ok(position >= 0);
		const before = editor.field(sourceState).projection.document;
		const transaction = visual.tr.insertText(insert, position, position);
		editor = sourcePatchTransaction(editor, projection, visualPatches(before, projection, transaction)).state;
		const next = editor.field(sourceState).projection.document;
		projection = advanceVisual(before, projection, transaction, next);
		visual = visual.apply(transaction);
		expected = expected.replace(label, label.slice(0, local) + escapeVisualText(insert) + label.slice(local));
		assert.deepEqual(next.toBytes(), new TextEncoder().encode(expected));
		assert.equal(projection.viewDocument, visual.doc);
		assert.equal(projection.document.eq(projectVisual(next, parseSource(next)).document), true);
		assert.ok([...Array(visual.doc.childCount)].some((_, index) => visual.doc.child(index) === raw));
	}
	for (let index = 0; index < 4; index++) editor = historyTransaction(editor, 'undo')!.state;
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
});

test('equal-width visual replacement reuses immutable offsets; escaped replacement remaps and preserves exact history', () => {
	const original = source('\uFEFFA雪😀\r\nB\rtail\n');
	let editor = createSourceState(original);
	let projection = projectVisual(original, parseSource(original));
	const originalOffsets = projection.boundaries[0];
	assert.ok(originalOffsets);
	for (const [replacement, expected, reused] of [
		['Z', '\uFEFFZ雪😀\r\nB\rtail\n', true],
		['%', '\uFEFF\\%雪😀\r\nB\rtail\n', false]
	] as const) {
		const before = editor.field(sourceState).projection.document;
		const transaction = VisualState.create({ doc: projection.document }).tr.insertText(replacement, 1, 2);
		const patches = visualPatches(before, projection, transaction);
		editor = sourcePatchTransaction(editor, projection, patches).state;
		const next = editor.field(sourceState).projection.document;
		projection = advanceVisual(before, projection, transaction, next);
		assert.deepEqual(next.toBytes(), new TextEncoder().encode(expected));
		assert.equal(projection.boundaries[0] === originalOffsets, reused);
		const fresh = projectVisual(next, parseSource(next));
		assert.deepEqual(projection.boundaries, fresh.boundaries);
		assert.equal(projection.document.eq(fresh.document), true);
	}
	editor = historyTransaction(editor, 'undo')!.state;
	editor = historyTransaction(editor, 'undo')!.state;
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
});

function blockPosition(document: ReturnType<typeof projectVisual>['document'], role: string) {
	let result = -1;
	document.forEach((node, offset) => { if (node.type.name === 'source_block' && node.attrs.role === role && result < 0) result = offset + 1; });
	assert.ok(result >= 0); return result;
}

test('original schema projects headings, text and closed math; unknown/comments remain source-backed Raw', () => {
	const document = source('\\documentclass{article}\n\\begin{document}\n\\section{Method}\nText \\opaque{keep}%comment\n$x$\n\\end{document}');
	const projected = projectVisual(document, parseSource(document));
	const blocks: string[] = []; projected.document.forEach((node) => { if (node.type.name === 'raw_block') blocks.push(node.attrs.source); });
	assert.ok(blocks.includes('\\opaque{keep}')); assert.ok(blocks.includes('%comment'));
	let math: typeof projected.document | undefined;
	projected.document.descendants(node => { if (node.type.name === 'math_inline') math = node; });
	assert.ok(math); assert.equal(math.attrs.source, '$x$'); assert.equal(math.attrs.latex, 'x');
	assert.equal(projected.document.child(blockPosition(projected.document, 'heading') > 0 ? 1 : 0).type.name, 'source_block');
	const unchanged = VisualState.create({ doc: projected.document }).tr;
	assert.deepEqual(visualPatches(document, projected, unchanged), []);
	assert.deepEqual(document.toBytes(), new TextEncoder().encode(document.read()));
});
test('actual ProseMirror heading edit becomes one local source patch and CodeMirror undo restores exact BOM/mixed EOL', () => {
	const document = source('\uFEFF\\documentclass{article}\r\n%keep\r\n\\begin{document}\r\n\\section{Method}\nBody \\opaque{untouched}\r\n\\end{document}\n');
	const projected = projectVisual(document, parseSource(document));
	const visual = VisualState.create({ doc: projected.document });
	const position = blockPosition(projected.document, 'heading');
	const patches = visualPatches(document, projected, visual.tr.insertText('結果', position, position + 6));
	assert.equal(patches.length, 1); assert.equal(patches[0]!.expected, 'Method');
	let editor = createSourceState(document); editor = sourcePatchTransaction(editor, projected, patches).state;
	assert.equal(editor.field(sourceState).projection.document.read(), document.read().replace('{Method}', '{結果}'));
	editor = historyTransaction(editor, 'undo')!.state;
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), document.toBytes());
});
test('visual edits preserve mixed EOL offsets and escape inserted LaTeX punctuation without rewriting adjacent source', () => {
	const document = source('A\r\nB\rC\n'); const projected = projectVisual(document, parseSource(document));
	const transaction = VisualState.create({ doc: projected.document }).tr.insertText('50% &', 3, 4);
	const patches = visualPatches(document, projected, transaction);
	assert.deepEqual(patches, [{ from: 3, to: 4, expected: 'B', insert: '50\\% \\&' }]);
	assert.equal(sourcePatchTransaction(createSourceState(document), projected, patches).state.field(sourceState).projection.document.read(), 'A\r\n50\\% \\&\rC\n');
	assert.equal(escapeVisualText('a_b#{}$^~\\'), 'a\\_b\\#\\{\\}\\$\\textasciicircum{}\\textasciitilde{}\\textbackslash{}');
});
test('surrogate replacement never splits unchanged source scalar boundaries', () => {
	const document = source('😀done'); const projected = projectVisual(document, parseSource(document));
	const patches = visualPatches(document, projected, VisualState.create({ doc: projected.document }).tr.insertText('😁', 1, 3));
	assert.deepEqual(patches, [{ from: 0, to: 2, expected: '😀', insert: '😁' }]);
	assert.equal(sourcePatchTransaction(createSourceState(document), projected, patches).state.field(sourceState).projection.document.read(), '😁done');
});
test('Raw replacement, block/anchor mutation, stale version and foreign source are rejected', () => {
	const document = source('\\opaque{keep}'); const projected = projectVisual(document, parseSource(document));
	const state = VisualState.create({ doc: projected.document });
	assert.throws(() => visualPatches(document, projected, state.tr.replaceWith(0, projected.document.content.size,
		visualSchema.nodes.source_block!.create({ from: 0, to: 1, editFrom: 0, editTo: 1 }, visualSchema.text('changed')))), /VISUAL_STRUCTURE/);
	assert.throws(() => projectVisual(source('other'), parseSource(document)), /STALE_VISUAL/);
	const newer = document.apply({ expectedVersion: 0, patches: [{ from: 0, to: 0, insert: 'x' }] }).document;
	assert.throws(() => visualPatches(newer, projected, state.tr), /STALE_VISUAL/);
	assert.throws(() => sourcePatchTransaction(createSourceState(newer), projected, []), /STALE_VISUAL/);
});
test('source bridge refuses read-only state, stale expected bytes and CRLF-interior ranges', () => {
	const document = source('a\r\nb'); const identity = { documentId: document.documentId, version: document.version };
	assert.throws(() => sourcePatchTransaction(createSourceState(document, undefined, EditorState.readOnly.of(true)), identity, []), /EDITOR_READ_ONLY/);
	assert.throws(() => sourcePatchTransaction(createSourceState(document), identity, [{ from: 0, to: 1, insert: 'q', expected: 'wrong' }]), /STALE_VISUAL/);
	assert.throws(() => sourcePatchTransaction(createSourceState(document), identity, [{ from: 2, to: 2, insert: 'q', expected: '' }]), /VISUAL_RANGE/);
});

test('continuous visual edits map escaped punctuation, EOL and Unicode without reparsing; shared undo restores all bytes', () => {
	const document = source('\uFEFFstart\r\nkeep'); let editor = createSourceState(document);
	let projected = projectVisual(document, parseSource(document));
	const values = ['start% &😀\nkeep', 'start &😀\nkeep', 'start &😁\nkeep', 'start &😁\nnew\nkeep'];
	for (const value of values) {
		const before = editor.field(sourceState).projection.document;
		const transaction = VisualState.create({ doc: projected.document }).tr.insertText(value, 1, projected.document.firstChild!.nodeSize - 1);
		const patches = visualPatches(before, projected, transaction);
		editor = sourcePatchTransaction(editor, projected, patches).state;
		const next = editor.field(sourceState).projection.document;
		projected = advanceVisual(before, projected, transaction, next);
		assert.equal(projected.document.textContent, value);
		assert.equal(next.read(), escapeVisualText(value).replaceAll('\n', '\r\n'));
		assert.equal(projected.boundaries[0]!.length, value.length + 1);
		assert.equal(projected.boundaries[0]!.at(-1), next.length);
		assert.ok(Object.isFrozen(projected.boundaries)); assert.ok(Object.isFrozen(projected.boundaries[0]));
	}
	for (let index = 0; index < values.length; index++) editor = historyTransaction(editor, 'undo')!.state;
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), document.toBytes());
});
test('multi-block transaction reanchors later heading and Raw without changing unknown source', () => {
	const document = source('\\section{A}\r\n\\section{B}\n\\opaque{keep}'); let editor = createSourceState(document);
	let projected = projectVisual(document, parseSource(document));
	const positions: number[] = [];
	projected.document.forEach((node, offset) => { if (node.attrs.role === 'heading') positions.push(offset + 1); });
	const transaction = VisualState.create({ doc: projected.document }).tr.insertText('Long%', positions[0]!, positions[0]! + 1);
	const second = transaction.mapping.map(positions[1]!);
	transaction.insertText('雪', second, second + 1);
	const patches = visualPatches(document, projected, transaction); assert.equal(patches.length, 2);
	editor = sourcePatchTransaction(editor, projected, patches).state;
	projected = advanceVisual(document, projected, transaction, editor.field(sourceState).projection.document);
	assert.equal(editor.field(sourceState).projection.document.read(), '\\section{Long\\%}\r\n\\section{雪}\n\\opaque{keep}');
	let secondPosition = -1;
	projected.document.forEach((node, offset) => { if (node.type.name === 'source_block' && node.textContent === '雪') secondPosition = offset + 2; });
	const before = editor.field(sourceState).projection.document;
	const continued = VisualState.create({ doc: projected.document }).tr.insertText('!', secondPosition);
	editor = sourcePatchTransaction(editor, projected, visualPatches(before, projected, continued)).state;
	projected = advanceVisual(before, projected, continued, editor.field(sourceState).projection.document);
	assert.equal(editor.field(sourceState).projection.document.read(), '\\section{Long\\%}\r\n\\section{雪!}\n\\opaque{keep}');
	const raw = projected.document.lastChild!;
	assert.equal(before.read(raw.attrs.from - 1, raw.attrs.to - 1), '\\opaque{keep}');
});
test('incremental visual receipt rejects foreign, wrong-version and wrong inserted bytes', () => {
	const document = source('a'); const projected = projectVisual(document, parseSource(document));
	const transaction = VisualState.create({ doc: projected.document }).tr.insertText('%', 2);
	assert.throws(() => advanceVisual(document, projected, transaction, document), /STALE_VISUAL/);
	assert.throws(() => advanceVisual(document, projected, transaction, source('a\\%')), /STALE_VISUAL/);
	const wrong = document.apply({ expectedVersion: 0, patches: [{ from: 1, to: 1, insert: '\\&' }] }).document;
	assert.throws(() => advanceVisual(document, projected, transaction, wrong), /VISUAL_RECEIPT/);
});

test('reopening escaped visual text retains display and exact source mapping in paragraphs and headings', () => {
	const document = source('\\section{50\\% \\& snow}\r\nText \\_ \\{ \\} \\textbackslash{} \\textasciicircum{} \\textasciitilde{}');
	const projected = projectVisual(document, parseSource(document));
	assert.equal(projected.document.child(0).textContent, '50% & snow');
	assert.equal(projected.document.child(1).textContent, '\nText _ { } \\ ^ ~');
	const transaction = VisualState.create({ doc: projected.document }).tr.insertText('', 3, 4);
	const patches = visualPatches(document, projected, transaction);
	assert.equal(patches[0]!.expected, '\\%'); assert.equal(patches[0]!.insert, '');
	const state = sourcePatchTransaction(createSourceState(document), projected, patches).state;
	assert.equal(state.field(sourceState).projection.document.read(), document.read().replace('50\\%', '50'));
});
test('escape-like macros with arguments remain Raw rather than guessed as literal text', () => {
	const document = source('\\%{unknown} \\opaque{keep}');
	const projected = projectVisual(document, parseSource(document));
	assert.equal(projected.document.child(0).type.name, 'raw_block');
	assert.equal(projected.document.child(0).attrs.source, '\\%{unknown}');
});
