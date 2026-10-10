import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { TextSelection, NodeSelection, AllSelection } from 'prosemirror-state';
import { SourceDocument, parseSource, type SourceSpan } from '@modutex/document-core';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';
import { createSourceState, sourceState, visualInsertionTransaction, historyTransaction } from '../../src/features/source-editor/state.ts';
import { equationSource, matrixSource } from '../../src/features/math/source.ts';
import { createTable, tableSource } from '../../src/features/tables/source.ts';
import { sourceLimit } from '../../src/features/files/read.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const bytes = (text: string) => new TextEncoder().encode(text);
function sourceSpan(source: SourceDocument, from: number, to = from): SourceSpan { return { documentId: source.documentId, version: source.version, from, to }; }
function domFixture() {
	const dom = new JSDOM('<!doctype html><body><div id="target"></div></body>', { pretendToBeVisual: true });
	const saved = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window','document','navigator','MutationObserver','Node','HTMLElement','getComputedStyle']) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}
	return { target: dom.window.document.getElementById('target'), restore() { dom.window.close(); for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); } } };
}
function textPosition(view: VisualEditor, needle: string) {
	let position = -1;
	view.view.state.doc.forEach((node, offset) => {
		if (node.type.name !== 'source_block') return;
		const index = node.textBetween(0, node.content.size, '', '\ufffc').indexOf(needle);
		if (index >= 0) { assert.equal(position, -1); position = offset + 1 + index; }
	});
	assert.ok(position >= 0, needle); return position;
}

test('real visual text selection maps Unicode/escaped mixed-EOL source and does not use hidden CM selection', () => {
	const fixture = domFixture();
	const text = '\uFEFFleft😀\r\n雪\\%right\nlast\r', original = SourceDocument.open(bytes(text));
	let editor = createSourceState(original);
	editor = editor.update({ selection: { anchor: editor.doc.length } }).state;
	const view = new VisualEditor(fixture.target, 'insert.tex', { source: () => editor.field(sourceState).projection.document,
		apply: () => { throw new Error('Selection capture must not write'); }, history: () => false, readOnly: () => false, rejected: () => assert.fail('Unexpected rejection'), status: () => {} });
	try {
		view.sync(parseSource(original));
		const position = textPosition(view, '雪%right');
		view.view.dispatch(view.view.state.tr.setSelection(TextSelection.create(view.view.state.doc, position, position + 2)));
		const target = view.insertionSelection(); assert.ok(target); assert.equal(target.inlineOnly, false);
		assert.equal(original.read(target.span.from, target.span.to), '雪\\%');
		editor = visualInsertionTransaction(editor, target.span, '$x$').state;
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), bytes(text.replace('雪\\%', '$x$')));
		assert.equal(editor.field(sourceState).dirty, true);
		editor = historyTransaction(editor, 'undo')!.state;
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
		assert.equal(editor.selection.main.anchor, editor.doc.length);
		assert.equal(editor.field(sourceState).dirty, false);
		editor = historyTransaction(editor, 'redo')!.state;
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), bytes(text.replace('雪\\%', '$x$')));
	} finally { view.dispose(); fixture.restore(); }
});

test('genuine heading and formatted PM segments allow inline only; formula-only edges capture empty source spans', () => {
	const fixture = domFixture();
	try {
		for (const text of ['\\section{雪plain}', '\\textbf{雪plain}', 'left \\textit{雪plain} right', '$x$']) {
			const source = SourceDocument.open(bytes(text));
			const view = new VisualEditor(fixture.target, 'insert.tex', { source: () => source, apply: () => { throw new Error('No write'); }, history: () => false, readOnly: () => false, rejected: () => assert.fail('Unexpected rejection'), status: () => {} });
			try {
				view.sync(parseSource(source));
				if (text === '$x$') {
					let atom = -1; view.view.state.doc.descendants((node, offset) => { if (node.type.name === 'math_inline') atom = offset; }); assert.ok(atom >= 0);
					for (const [position, from] of [[atom, 0], [atom + 1, 3]] as const) {
						view.view.dispatch(view.view.state.tr.setSelection(TextSelection.create(view.view.state.doc, position)));
						const selected = view.insertionSelection(); assert.ok(selected); assert.equal(selected.inlineOnly, false);
						assert.deepEqual(selected.span, sourceSpan(source, from));
					}
				} else {
					const position = textPosition(view, '雪plain');
					view.view.dispatch(view.view.state.tr.setSelection(TextSelection.create(view.view.state.doc, position + 1)));
					const selected = view.insertionSelection(); assert.ok(selected); assert.equal(selected.inlineOnly, true);
					const state = createSourceState(source);
					assert.throws(() => visualInsertionTransaction(state, selected.span, equationSource('x', false), selected.inlineOnly), /INSERTION_INLINE_ONLY/);
					const inserted = visualInsertionTransaction(state, selected.span, '\\(x\\)', selected.inlineOnly).state;
					const wanted = text.replace('雪plain', '雪\\(x\\)plain');
					assert.deepEqual(inserted.field(sourceState).projection.document.toBytes(), bytes(wanted));
					assert.deepEqual(historyTransaction(inserted, 'undo')!.state.field(sourceState).projection.document.toBytes(), source.toBytes());
				}
			} finally { view.dispose(); }
		}
	} finally { fixture.restore(); }
});

test('visual insertion rejects atom/all/cross-segment/cross-block selections and stale, foreign, readonly, disposed views', () => {
	const fixture = domFixture();
	const original = SourceDocument.open(bytes('left $x$ middle \\textbf{bold} right\n\\opaque{raw}\ntail'));
	let source = original, readonly = false;
	const view = new VisualEditor(fixture.target, 'insert.tex', { source: () => source, apply: () => { throw new Error('No write'); }, history: () => false, readOnly: () => readonly, rejected: () => assert.fail('Unexpected rejection'), status: () => {} });
	try {
		view.sync(parseSource(original));
		let atom = -1, raw = -1;
		view.view.state.doc.descendants((node, offset) => { if (node.type.name === 'math_inline') atom = offset; if (node.type.name === 'raw_block') raw = offset; });
		assert.ok(atom >= 0); assert.ok(raw >= 0);
		const left = textPosition(view, 'left'), bold = textPosition(view, 'bold'), tail = textPosition(view, 'tail');
		for (const selection of [NodeSelection.create(view.view.state.doc, atom), NodeSelection.create(view.view.state.doc, raw), new AllSelection(view.view.state.doc), TextSelection.create(view.view.state.doc, atom, atom + 1), TextSelection.create(view.view.state.doc, left, bold + 2), TextSelection.create(view.view.state.doc, bold, bold + 6), TextSelection.create(view.view.state.doc, left, tail + 2)]) {
			view.view.dispatch(view.view.state.tr.setSelection(selection)); assert.equal(view.insertionSelection(), null);
		}
		view.view.dispatch(view.view.state.tr.setSelection(TextSelection.create(view.view.state.doc, left + 1)));
		assert.ok(view.insertionSelection());
		readonly = true; view.refresh(); assert.equal(view.insertionSelection(), null); readonly = false; view.refresh();
		source = original.apply({ expectedVersion: original.version, patches: [{ from: 0, to: 0, insert: 'new ' }] }).document;
		view.refresh(); assert.equal(view.insertionSelection(), null);
		source = SourceDocument.open(original.toBytes()); view.refresh(); assert.equal(view.insertionSelection(), null);
		view.dispose(); assert.equal(view.insertionSelection(), null);
		assert.deepEqual(original.toBytes(), bytes('left $x$ middle \\textbf{bold} right\n\\opaque{raw}\ntail'));
	} finally { view.dispose(); fixture.restore(); }
});

test('inline equation source stays on one line while real display/matrix/table insertions add only necessary LF boundaries', () => {
	const blocks = [equationSource('x', false), equationSource(matrixSource({ rows: 1, columns: 1, cells: ['1'] }, 'parentheses'), false), tableSource(createTable(1, 1))];
	for (const insert of ['$x$', '\\(x\\)', ...blocks]) {
		const text = '\uFEFFbefore\r\nintro\r\nleftRIGHT\rtail\n', source = SourceDocument.open(bytes(text));
		const state = createSourceState(source), from = source.read().indexOf('RIGHT');
		const transaction = visualInsertionTransaction(state, sourceSpan(source, from), insert);
		assert.ok(transaction.docChanged);
		const inline = insert === '$x$' || insert === '\\(x\\)';
		const normalized = insert.replaceAll('\n', '\r\n');
		const wanted = text.replace('leftRIGHT', 'left' + (inline ? insert : '\r\n' + normalized + '\r\n') + 'RIGHT');
		assert.deepEqual(transaction.state.field(sourceState).projection.document.toBytes(), bytes(wanted));
		assert.deepEqual(historyTransaction(transaction.state, 'undo')!.state.field(sourceState).projection.document.toBytes(), source.toBytes());
	}
	for (const text of ['plain', 'before\nplain\nafter']) {
		const source = SourceDocument.open(bytes(text)), from = text.indexOf('plain');
		const insert = equationSource('x', false);
		const changed = visualInsertionTransaction(createSourceState(source), sourceSpan(source, from, from + 5), insert).state;
		assert.deepEqual(changed.field(sourceState).projection.document.toBytes(), bytes(text.replace('plain', insert)));
	}
});

test('visual insertion refuses stale/foreign captured spans and CRLF-interior coordinates without history mutation', () => {
	const source = SourceDocument.open(bytes('\uFEFFleft\r\nright')), state = createSourceState(source), captured = sourceSpan(source, 2);
	assert.throws(() => visualInsertionTransaction(createSourceState(SourceDocument.open(source.toBytes())), captured, '$x$'), /STALE_INSERTION/);
	const changed = state.update({ changes: { from: 0, insert: 'new ' } }).state;
	assert.throws(() => visualInsertionTransaction(changed, captured, '$x$'), /STALE_INSERTION/);
	const cr = source.read().indexOf('\r');
	assert.throws(() => visualInsertionTransaction(state, sourceSpan(source, cr + 1), '$x$'), /INSERTION_RANGE/);
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), source.toBytes()); assert.equal(historyTransaction(state, 'undo'), null);
});

test('5 MiB visual tool insertion is atomically rejected by shared UTF-8 filter without selection/dirty/history change', () => {
	const source = SourceDocument.open(new Uint8Array(sourceLimit - 1).fill(0x61)), reasons: (string | undefined)[] = [];
	let state = createSourceState(source, reason => reasons.push(reason));
	state = state.update({ selection: { anchor: 42 } }).state;
	const before = state.field(sourceState), transaction = visualInsertionTransaction(state, sourceSpan(source, 10), '\\(雪\\)');
	assert.equal(transaction.docChanged, false); assert.equal(transaction.state.field(sourceState), before);
	assert.equal(transaction.state.selection.main.anchor, 42); assert.equal(transaction.state.field(sourceState).dirty, false);
	assert.deepEqual(transaction.state.field(sourceState).projection.document.toBytes(), source.toBytes());
	assert.deepEqual(reasons, ['SOURCE_TOO_LARGE']); assert.equal(historyTransaction(transaction.state, 'undo'), null);
});
