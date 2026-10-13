import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { EditorState as VisualState } from 'prosemirror-state';
import { SourceDocument, parseSource } from '@modutex/document-core';
import { projectVisual, visualPatches, advanceVisual, visualSchema, escapeVisualText } from '../../src/features/visual-editor/schema.ts';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';
import { createSourceState, sourceState, sourcePatchTransaction, historyTransaction } from '../../src/features/source-editor/state.ts';
const source = (text: string) => SourceDocument.open(new TextEncoder().encode(text));
const { JSDOM } = createRequire(import.meta.url)('jsdom');

test('known nested formatting stays inline; unknown macros/comments remain intact Raw', () => {
	const original = source('Before \\textbf{bold \\textit{both}} and \\underline{under}.');
	const projection = projectVisual(original, parseSource(original));
	assert.equal(projection.document.childCount, 1); assert.equal(projection.document.firstChild!.textContent, 'Before bold both and under.');
	const texts: { text: string; marks: string[] }[] = [];
	projection.document.firstChild!.forEach((node) => texts.push({ text: node.textContent, marks: node.marks.map((mark) => mark.type.name) }));
	assert.deepEqual(texts, [{ text: 'Before ', marks: [] }, { text: 'bold ', marks: ['strong'] }, { text: 'both', marks: ['strong', 'em'] }, { text: ' and ', marks: [] }, { text: 'under', marks: ['underline'] }, { text: '.', marks: [] }]);
	const unknown = source('Keep \\textbf{A \\opaque{B}}% comment\nTail');
	const raw: string[] = []; projectVisual(unknown, parseSource(unknown)).document.forEach((node) => { if (node.type.name === 'raw_block') raw.push(node.attrs.source); });
	assert.deepEqual(raw, ['\\textbf{A \\opaque{B}}', '% comment']);
});
test('inline heading and nested emphasis preserve their semantics without introducing blocks', () => {
	const original = source('\\section{Title \\textbf{bold}}\n\\emph{outer \\emph{upright} italic}');
	const projection = projectVisual(original, parseSource(original));
	assert.equal(projection.document.firstChild!.attrs.role, 'heading');
	assert.equal(projection.document.firstChild!.textContent, 'Title bold');
	assert.equal(projection.document.firstChild!.lastChild!.marks[0]!.type.name, 'strong');
	const paragraph = projection.document.lastChild!, values: { text: string; marks: string[] }[] = [];
	paragraph.forEach((node) => values.push({ text: node.textContent, marks: node.marks.map((mark) => mark.type.name) }));
	assert.deepEqual(values, [{ text: '\n', marks: [] }, { text: 'outer ', marks: ['em'] }, { text: 'upright', marks: [] }, { text: ' italic', marks: ['em'] }]);
});
test('continuous inline edits preserve wrappers, mixed EOL, surrounding bytes and exact shared undo', () => {
	const original = source('\uFEFF% keep\r\nBefore \\textbf{bold\\%\r\ntext} after \\textit{italic}.');
	let editor = createSourceState(original), projection = projectVisual(original, parseSource(original));
	const beforeBytes = original.toBytes();
	for (const [needle, inserted] of [['bold', 'bold &😀'], ['text', 'next'], ['italic', '斜體%'], ['Before', '前言']] as const) {
		let position = -1;
		projection.document.forEach((node, offset) => { const found = node.textContent.indexOf(needle); if (found >= 0 && node.type.name === 'source_block') position = offset + 1 + found; });
		assert.ok(position >= 0);
		const originalSource = editor.field(sourceState).projection.document;
		const transaction = VisualState.create({ doc: projection.document }).tr.insertText(inserted, position, position + needle.length);
		const patches = visualPatches(originalSource, projection, transaction);
		assert.equal(patches.length, 1); assert.equal(patches[0]!.expected, originalSource.read(patches[0]!.from, patches[0]!.to));
		editor = sourcePatchTransaction(editor, projection, patches).state;
		const next = editor.field(sourceState).projection.document;
		assert.equal(next.read(), needle === 'text' ? originalSource.read().replace('\r\ntext}', '\r\n' + escapeVisualText(inserted) + '}') : originalSource.read().replace(needle, escapeVisualText(inserted)));
		projection = advanceVisual(originalSource, projection, transaction, next);
		const fresh = projectVisual(next, parseSource(next));
		assert.ok(projection.document.eq(fresh.document));
		assert.deepEqual(projection.segments, fresh.segments);
	}
	assert.equal(editor.field(sourceState).projection.document.read(), '% keep\r\n前言 \\textbf{bold \\&😀\\%\r\nnext} after \\textit{斜體\\%}.');
	assert.equal(editor.field(sourceState).projection.document.profile.bom, true);
	for (let i = 0; i < 4; i++) editor = historyTransaction(editor, 'undo')!.state;
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), beforeBytes);
});
test('ordinary transactions cannot silently change marks', () => {
	const original = source('plain \\textbf{bold} tail'); const projection = projectVisual(original, parseSource(original));
	const state = VisualState.create({ doc: projection.document });
	assert.throws(() => visualPatches(original, projection, state.tr.addMark(1, 4, visualSchema.marks.em!.create())), /VISUAL_INLINE_BOUNDARY/);
	assert.deepEqual(original.toBytes(), new TextEncoder().encode(original.read()));
});
test('cross-inline deletion/replacement commits separated patches without deleting TeX wrappers', () => {
	for (const replacement of ['', '新%😀']) {
		const original = source('\uFEFFplain \\textbf{bold} tail \\textit{end}\r\n\\opaque{keep}% comment');
		let editor = createSourceState(original), projection = projectVisual(original, parseSource(original));
		const transaction = VisualState.create({ doc: projection.document }).tr.insertText(replacement, 3, 13);
		const patches = visualPatches(original, projection, transaction);
		assert.equal(patches.length, 3);
		assert.deepEqual(patches.map((patch) => patch.expected), ['ain ', 'bold', ' t']);
		editor = sourcePatchTransaction(editor, projection, patches).state;
		const next = editor.field(sourceState).projection.document;
		assert.equal(next.read(), 'pl' + escapeVisualText(replacement) + '\\textbf{}ail \\textit{end}\r\n\\opaque{keep}% comment');
		projection = advanceVisual(original, projection, transaction, next);
		const fresh = projectVisual(next, parseSource(next));
		assert.ok(projection.document.eq(fresh.document)); assert.deepEqual(projection.segments, fresh.segments);
		editor = historyTransaction(editor, 'undo')!.state; assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
	}
});
test('cross-format replacement inherits selected start style and later nested regions remain editable', () => {
	const original = source('A \\textbf{bold \\textit{both}} Z');
	let editor = createSourceState(original), projection = projectVisual(original, parseSource(original));
	const transaction = VisualState.create({ doc: projection.document }).tr.insertText('Q&', 4, 12);
	const patches = visualPatches(original, projection, transaction);
	editor = sourcePatchTransaction(editor, projection, patches).state;
	const next = editor.field(sourceState).projection.document;
	assert.equal(next.read(), 'A \\textbf{bQ\\&\\textit{}} Z');
	projection = advanceVisual(original, projection, transaction, next);
	assert.ok(projection.document.eq(projectVisual(next, parseSource(next)).document));
	const later = VisualState.create({ doc: projection.document }).tr.insertText('tail', projection.document.firstChild!.nodeSize - 1);
	const latePatches = visualPatches(next, projection, later);
	editor = sourcePatchTransaction(editor, projection, latePatches).state;
	assert.equal(editor.field(sourceState).projection.document.read(), 'A \\textbf{bQ\\&\\textit{}} Ztail');
	editor = historyTransaction(editor, 'undo')!.state; editor = historyTransaction(editor, 'undo')!.state;
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
});
test('multiple transaction steps use original coordinates and stale source receipts are refused', () => {
	const original = source('plain \\textbf{bold} tail');
	const projection = projectVisual(original, parseSource(original));
	const transaction = VisualState.create({ doc: projection.document }).tr.insertText('X', 2).insertText('Q', 4, 14);
	const patches = visualPatches(original, projection, transaction);
	let editor = createSourceState(original);
	editor = sourcePatchTransaction(editor, projection, patches).state;
	const next = editor.field(sourceState).projection.document;
	assert.equal(next.read(), 'pXlQ\\textbf{}ail');
	assert.ok(advanceVisual(original, projection, transaction, next).document.eq(projectVisual(next, parseSource(next)).document));
	assert.throws(() => visualPatches(next, projection, transaction), /STALE_VISUAL/);
	assert.throws(() => sourcePatchTransaction(editor, projection, patches), /STALE/);
	editor = historyTransaction(editor, 'undo')!.state;
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
});
test('empty formatted runs remain safely mapped and source-span shifts leave later styles editable', () => {
	const original = source('X \\textbf{bold} Y \\textit{end}');
	let editor = createSourceState(original), projection = projectVisual(original, parseSource(original));
	for (const [from, to, text] of [[3, 7, ''], [3, 3, '😀%'], [9, 12, '新末尾']] as const) {
		const before = editor.field(sourceState).projection.document;
		const transaction = VisualState.create({ doc: projection.document }).tr.insertText(text, from, to);
		const patches = visualPatches(before, projection, transaction); editor = sourcePatchTransaction(editor, projection, patches).state;
		const next = editor.field(sourceState).projection.document;
		projection = advanceVisual(before, projection, transaction, next);
		assert.ok(projection.document.eq(projectVisual(next, parseSource(next)).document));
	}
	// A collapsed unmarked cursor uses the left visible run; the invisible empty wrapper stays intact.
	assert.equal(editor.field(sourceState).projection.document.read(), 'X 😀\\%\\textbf{} Y \\textit{新末尾}');
	for (let i = 0; i < 3; i++) editor = historyTransaction(editor, 'undo')!.state;
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
});
test('real EditorView renders inline marks, commits local typing and revokes stale writes', () => {
	const dom = new JSDOM('<!doctype html><body><div id="target"></div></body>', { pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}
	const original = source('Before \\textbf{bold} and \\textit{italic}.'), target = dom.window.document.getElementById('target');
	let editor = createSourceState(original), rejected = 0, readonly = false;
	const view = new VisualEditor(target, 'main.tex', {
		source: () => editor.field(sourceState).projection.document,
		apply: (identity, patches) => { editor = sourcePatchTransaction(editor, identity, patches).state; return editor.field(sourceState).projection.document; },
		history: (direction) => { const transaction = historyTransaction(editor, direction); if (!transaction) return false; editor = transaction.state; return true; },
		readOnly: () => readonly, rejected: () => rejected++, status: () => {}
	});
	try {
		view.sync(parseSource(original));
		assert.equal(target.querySelectorAll('p').length, 1); assert.equal(target.querySelector('strong').textContent, 'bold'); assert.equal(target.querySelector('em').textContent, 'italic');
		view.view.dispatch(view.view.state.tr.insertText('new', 8, 12));
		assert.equal(editor.field(sourceState).projection.document.read(), 'Before \\textbf{new} and \\textit{italic}.');
		assert.equal(target.querySelector('strong').textContent, 'new');
		readonly = true; view.refresh(); const frozen = editor;
		view.view.dispatch(view.view.state.tr.insertText('NO', 8, 11)); assert.equal(editor, frozen); assert.equal(rejected, 1);
		view.dispose(); view.dispose(); assert.equal(target.children.length, 0);
	} finally {
		view.dispose(); dom.window.close();
		for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});
