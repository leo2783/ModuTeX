import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { TextSelection } from 'prosemirror-state';
import { SourceDocument, parseSource } from '@modutex/document-core';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';
import { projectVisual } from '../../src/features/visual-editor/schema.ts';
import { createSourceState, historyTransaction, sourcePatchTransaction, sourceState } from '../../src/features/source-editor/state.ts';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const bytes = (value: string) => new TextEncoder().encode(value);

function makeHarness(sourceText: string) {
	const dom = new JSDOM('<!doctype html><body><div id="target"></div></body>', { pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'KeyboardEvent', 'getComputedStyle']) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true,
			value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}
	const original = SourceDocument.open(bytes(sourceText));
	let editor = createSourceState(original), readonly = false, rejected = 0, applyCalls = 0, staleNextApply = false;
	const target = dom.window.document.getElementById('target') as HTMLElement;
	let visual!: VisualEditor;
	visual = new VisualEditor(target, 'stored-marks.tex', {
		source: () => editor.field(sourceState).projection.document,
		apply: (identity, patches) => {
			applyCalls++;
			if (staleNextApply) {
				staleNextApply = false;
				editor = editor.update({ changes: { from: 0, insert: 'remote ' } }).state;
			}
			editor = sourcePatchTransaction(editor, identity, patches).state;
			return editor.field(sourceState).projection.document;
		},
		history: direction => {
			const transaction = historyTransaction(editor, direction);
			if (!transaction) return false;
			editor = transaction.state;
			visual.sync(parseSource(editor.field(sourceState).projection.document));
			return true;
		},
		readOnly: () => readonly, rejected: () => rejected++, status: () => {},
		format: format => { visual.toggleFormat(format); }
	});
	visual.sync(parseSource(original));
	return {
		dom, target, visual,
		source: () => editor.field(sourceState).projection.document,
		state: () => editor,
		rejected: () => rejected,
		applyCalls: () => applyCalls,
		setReadonly(value: boolean) { readonly = value; visual.refresh(); },
		staleOnNextApply() { staleNextApply = true; },
		dispose() {
			visual.dispose();
			dom.window.close();
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
	};
}

function selectCaret(view: VisualEditor, text: string, offset: number): void {
	let position = -1;
	view.view.state.doc.forEach((node, start) => {
		if (position < 0 && node.type.name === 'source_block' && node.textContent.includes(text)) {
			position = start + 1 + node.textContent.indexOf(text) + offset;
		}
	});
	assert.ok(position >= 0, `could not find visual text ${text}`);
	view.view.dispatch(view.view.state.tr.setSelection(TextSelection.create(view.view.state.doc, position)));
}

function selectEmptyBlock(view: VisualEditor): void {
	let position = -1;
	view.view.state.doc.forEach((node, start) => {
		if (position < 0 && node.type.name === 'source_block' && node.content.size === 0) position = start + 1;
	});
	assert.ok(position >= 0, 'could not find an empty visual block');
	view.view.dispatch(view.view.state.tr.setSelection(TextSelection.create(view.view.state.doc, position)));
}

function marksAtCaret(view: VisualEditor): string[] | null {
	return view.view.state.storedMarks === null ? null : view.view.state.storedMarks.map(mark => mark.type.name);
}

function assertTextMarks(view: VisualEditor, text: string, expected: readonly string[]): void {
	let found = false;
	view.view.state.doc.descendants(node => {
		if (!node.isText || !node.text?.includes(text)) return;
		found = true;
		assert.deepEqual(node.marks.map(mark => mark.type.name), expected);
	});
	assert.ok(found, `could not find inserted text ${text}`);
}

function historyKey(view: VisualEditor, key: 'z' | 'y'): void {
	view.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }));
}

function countSerializationsDuring(source: SourceDocument, operation: () => void): number {
	const prototype = Object.getPrototypeOf(source);
	assert.ok(prototype);
	const descriptor = Object.getOwnPropertyDescriptor(prototype, 'toBytes');
	assert.ok(descriptor && typeof descriptor.value === 'function');
	const original = descriptor.value as SourceDocument['toBytes'];
	let tracking = false, calls = 0;
	const instrumented: SourceDocument['toBytes'] = function (this: SourceDocument, ...args: Parameters<SourceDocument['toBytes']>) {
		if (tracking) calls++;
		return original.apply(this, args);
	};
	Object.defineProperty(prototype, 'toBytes', { ...descriptor, value: instrumented });
	try {
		tracking = true;
		operation();
	} finally {
		tracking = false;
		Object.defineProperty(prototype, 'toBytes', descriptor);
	}
	return calls;
}

test('collapsed marks type incrementally, preserve parser receipts, and share source undo/redo', () => {
	const originalText = '\uFEFF% keep\r\nstartend\n% tail\r';
	const h = makeHarness(originalText);
	try {
		selectCaret(h.visual, 'startend', 5);
		const unchanged = h.source(), unchangedVisual = h.visual.view.state.doc;
		h.visual.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true }));
		assert.deepEqual(marksAtCaret(h.visual), ['strong']);
		assert.strictEqual(h.source(), unchanged);
		assert.strictEqual(h.visual.view.state.doc, unchangedVisual);
		assert.equal(h.state().field(sourceState).dirty, false);

		const calls = countSerializationsDuring(h.source(), () => {
			h.visual.view.dispatch(h.visual.view.state.tr.insertText('A'));
		});
		assert.equal(calls, 0);
		const afterFirst = originalText.replace('startend', 'start\\textbf{A}end');
		assert.deepEqual(h.source().toBytes(), bytes(afterFirst));
		assertTextMarks(h.visual, 'A', ['strong']);
		const firstReceiptState = h.visual.view.state;
		h.visual.sync(parseSource(h.source()));
		assert.strictEqual(h.visual.view.state, firstReceiptState);

		h.visual.view.dispatch(h.visual.view.state.tr.insertText('😀%&_'));
		const afterSecond = originalText.replace('startend', 'start\\textbf{A😀\\%\\&\\_}end');
		assert.deepEqual(h.source().toBytes(), bytes(afterSecond));
		assertTextMarks(h.visual, 'A😀%&_', ['strong']);
		const secondReceiptState = h.visual.view.state;
		h.visual.sync(parseSource(h.source()));
		assert.strictEqual(h.visual.view.state, secondReceiptState);

		assert.equal(h.visual.toggleFormat('strong'), true);
		assert.deepEqual(marksAtCaret(h.visual), []);
		h.visual.view.dispatch(h.visual.view.state.tr.insertText('B'));
		const expected = originalText.replace('startend', 'start\\textbf{A😀\\%\\&\\_}Bend');
		assert.deepEqual(h.source().toBytes(), bytes(expected));
		assertTextMarks(h.visual, 'B', []);
		assert.equal(h.state().field(sourceState).dirty, true);

		historyKey(h.visual, 'z');
		assert.deepEqual(h.source().toBytes(), bytes(afterSecond));
		historyKey(h.visual, 'z');
		assert.deepEqual(h.source().toBytes(), bytes(afterFirst));
		historyKey(h.visual, 'z');
		assert.deepEqual(h.source().toBytes(), bytes(originalText));
		assert.equal(h.state().field(sourceState).dirty, false);
		historyKey(h.visual, 'y');
		assert.deepEqual(h.source().toBytes(), bytes(afterFirst));
		historyKey(h.visual, 'y');
		assert.deepEqual(h.source().toBytes(), bytes(afterSecond));
		historyKey(h.visual, 'y');
		assert.deepEqual(h.source().toBytes(), bytes(expected));
		assert.equal(h.state().field(sourceState).dirty, true);
		assert.equal(h.rejected(), 0);
	} finally { h.dispose(); }
});

test('nested textbf/underline, empty wrappers and inline math retain complete decodeInline ancestry', () => {
	const originalText = '\uFEFFprefix \\textbf{A\\underline{BC}$x$\\textit{}D} after\r\n';
	const original = SourceDocument.open(bytes(originalText));
	const projection = projectVisual(original, parseSource(original));
	const inline = (projection.segments ?? []).flatMap(group => group ?? []);
	assert.ok(inline.length > 0);
	for (const segment of inline) {
		assert.ok(Array.isArray(segment.wrappers));
		assert.ok(segment.wrappers.every(wrapper => typeof wrapper.open === 'string' && typeof wrapper.close === 'string' && typeof wrapper.safe === 'boolean'));
	}
	assert.ok(inline.some(segment => segment.atom && segment.wrappers.some(wrapper => wrapper.open === '\\textbf{')));
	assert.ok(inline.some(segment => segment.from === segment.to && segment.wrapped && segment.wrappers.some(wrapper => wrapper.open === '\\textbf{')));
	assert.ok(inline.some(segment => segment.marks.includes('underline') && segment.wrappers.some(wrapper => wrapper.open === '\\underline{')));

	const h = makeHarness(originalText);
	try {
		selectCaret(h.visual, 'BC', 1);
		assert.equal(h.visual.toggleFormat('underline'), true);
		assert.deepEqual(marksAtCaret(h.visual), ['strong']);
		h.visual.view.dispatch(h.visual.view.state.tr.insertText('Q'));
		const once = originalText.replace(
			'\\textbf{A\\underline{BC}$x$\\textit{}D}',
			'\\textbf{A\\underline{B}}\\textbf{Q}\\textbf{\\underline{C}$x$\\textit{}D}'
		);
		assert.deepEqual(h.source().toBytes(), bytes(once));
		assertTextMarks(h.visual, 'B', ['strong', 'underline']);
		assertTextMarks(h.visual, 'Q', ['strong']);
		assertTextMarks(h.visual, 'C', ['strong', 'underline']);
		assert.ok(h.target.querySelector('.source-block strong u'));
		const receiptState = h.visual.view.state;
		h.visual.sync(parseSource(h.source()));
		assert.strictEqual(h.visual.view.state, receiptState);

		h.visual.view.dispatch(h.visual.view.state.tr.insertText('R'));
		const expected = once.replace('\\textbf{Q}', '\\textbf{QR}');
		assert.deepEqual(h.source().toBytes(), bytes(expected));
		assertTextMarks(h.visual, 'QR', ['strong']);
		assert.equal(h.rejected(), 0);
	} finally { h.dispose(); }

	const emptyText = '\uFEFF\\textbf{\\underline{}}';
	const empty = makeHarness(emptyText);
	try {
		selectEmptyBlock(empty.visual);
		assert.equal(empty.visual.toggleFormat('underline'), true);
		empty.visual.view.dispatch(empty.visual.view.state.tr.insertText('Z'));
		assert.deepEqual(empty.source().toBytes(), bytes('\uFEFF\\textbf{\\underline{}}\\textbf{Z}\\textbf{\\underline{}}'));
		assertTextMarks(empty.visual, 'Z', ['strong']);
		assert.equal(empty.rejected(), 0);
	} finally { empty.dispose(); }
});

test('collapsed marks split at heading boundaries and escape astral text without changing surrounding bytes', () => {
	const originalText = '\uFEFF\\section{head}\r\n\\textbf{edge}\r';
	const h = makeHarness(originalText);
	try {
		selectCaret(h.visual, 'head', 0);
		assert.equal(h.visual.toggleFormat('strong'), true);
		h.visual.view.dispatch(h.visual.view.state.tr.insertText('😀%_'));
		const first = '\uFEFF\\section{\\textbf{😀\\%\\_}head}\r\n\\textbf{edge}\r';
		assert.deepEqual(h.source().toBytes(), bytes(first));
		assertTextMarks(h.visual, '😀%_', ['strong']);
		const typedState = h.visual.view.state;
		h.visual.sync(parseSource(h.source()));
		assert.strictEqual(h.visual.view.state, typedState);

		assert.equal(h.visual.toggleFormat('strong'), true);
		h.visual.view.dispatch(h.visual.view.state.tr.insertText('!'));
		const second = '\uFEFF\\section{\\textbf{😀\\%\\_}!head}\r\n\\textbf{edge}\r';
		assert.deepEqual(h.source().toBytes(), bytes(second));
		assertTextMarks(h.visual, '!', []);

		selectCaret(h.visual, 'head', 4);
		assert.equal(h.visual.toggleFormat('em'), true);
		h.visual.view.dispatch(h.visual.view.state.tr.insertText('?'));
		const expected = '\uFEFF\\section{\\textbf{😀\\%\\_}!head\\textit{?}}\r\n\\textbf{edge}\r';
		assert.deepEqual(h.source().toBytes(), bytes(expected));
		assertTextMarks(h.visual, '?', ['em']);
		assert.ok(h.target.querySelector('h2 strong'));
		assert.equal(h.rejected(), 0);
	} finally { h.dispose(); }
});

test('stored marks clear or reject on readonly/stale authority and cannot outlive disposal', () => {
	const originalText = '\uFEFFplain';
	const h = makeHarness(originalText);
	try {
		selectCaret(h.visual, 'plain', 2);
		assert.equal(h.visual.toggleFormat('strong'), true);
		assert.deepEqual(marksAtCaret(h.visual), ['strong']);
		const originalVisualDoc = h.visual.view.state.doc;
		h.setReadonly(true);
		assert.equal(marksAtCaret(h.visual), null);
		assert.equal(h.visual.toggleFormat('em'), false);
		h.visual.view.dispatch(h.visual.view.state.tr.insertText('blocked'));
		assert.strictEqual(h.visual.view.state.doc, originalVisualDoc);
		assert.deepEqual(h.source().toBytes(), bytes(originalText));
		assert.equal(h.rejected(), 1);

		h.setReadonly(false);
		assert.equal(h.visual.toggleFormat('strong'), true);
		const beforeStale = h.visual.view.state.doc;
		h.staleOnNextApply();
		h.visual.view.dispatch(h.visual.view.state.tr.insertText('stale'));
		assert.strictEqual(h.visual.view.state.doc, beforeStale);
		assert.ok(h.source().read().includes('remote plain'));
		assert.ok(!h.source().read().includes('stale'));
		assert.equal(h.rejected(), 2);
		assert.equal(marksAtCaret(h.visual), null);

		h.visual.sync(parseSource(h.source()));
		selectCaret(h.visual, 'plain', 2);
		assert.equal(h.visual.toggleFormat('em'), true);
		const beforeDispose = h.source().toBytes();
		h.visual.dispose();
		assert.equal(h.visual.toggleFormat('strong'), false);
		assert.deepEqual(h.source().toBytes(), beforeDispose);
		assert.equal(h.target.children.length, 0);
		h.visual.sync(parseSource(h.source()));
		assert.equal(h.target.children.length, 0);
	} finally { h.dispose(); }
});

test('a malformed visual transaction is rejected before source commit and preserves shared undo history', () => {
	const h = makeHarness('\uFEFFplain');
	try {
		selectCaret(h.visual, 'plain', 5);
		h.visual.view.dispatch(h.visual.view.state.tr.insertText('!'));
		const sourceBefore = h.source(), sourceStateBefore = h.state(), visualStateBefore = h.visual.view.state;
		const historyBefore = sourceStateBefore.field(sourceState).undo.length;
		const applyCallsBefore = h.applyCalls();
		assert.ok(historyBefore > 0);

		let blockPosition = -1;
		visualStateBefore.doc.forEach((node, position) => {
			if (node.type.name === 'source_block') blockPosition = position;
		});
		assert.ok(blockPosition >= 0);
		const malformed = visualStateBefore.tr.setNodeAttribute(blockPosition, 'name', 'forged');
		assert.equal(malformed.docChanged, true);
		h.visual.view.dispatch(malformed);

		assert.strictEqual(h.source(), sourceBefore);
		assert.strictEqual(h.state(), sourceStateBefore);
		assert.strictEqual(h.visual.view.state, visualStateBefore);
		assert.equal(h.state().field(sourceState).undo.length, historyBefore);
		assert.equal(h.applyCalls(), applyCallsBefore);
		assert.ok(historyTransaction(h.state(), 'undo'));
		assert.equal(h.rejected(), 1);
	} finally { h.dispose(); }
});
