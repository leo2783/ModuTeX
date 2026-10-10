import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { TextSelection } from 'prosemirror-state';
import { SourceDocument, parseSource } from '@modutex/document-core';
import { formatTransaction, formatShortcut } from '../../src/features/source-editor/format.ts';
import { createSourceState, sourceState, historyTransaction } from '../../src/features/source-editor/state.ts';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const bytes = (text: string) => new TextEncoder().encode(text);
const formats = [['strong', 'textbf'], ['em', 'textit'], ['em', 'emph'], ['underline', 'underline']] as const;

function selected(text: string, needle: string) {
	const source = SourceDocument.open(bytes(text));
	let state = createSourceState(source);
	const from = state.doc.toString().lastIndexOf(needle);
	assert.ok(from >= 0);
	state = state.update({ selection: { anchor: from, head: from + needle.length } }).state;
	return { source, state };
}

test('genuine KeyboardEvents accept only exact Ctrl/Cmd B/I/U and refuse composition, repeat or competing modifiers', () => {
	const dom = new JSDOM('<!doctype html><body></body>');
	try {
		for (const [key, format] of [['b', 'strong'], ['i', 'em'], ['u', 'underline']] as const) {
			assert.equal(formatShortcut(new dom.window.KeyboardEvent('keydown', { key, ctrlKey: true })), format);
			assert.equal(formatShortcut(new dom.window.KeyboardEvent('keydown', { key: key.toUpperCase(), metaKey: true })), format);
			for (const options of [{}, { ctrlKey: true, metaKey: true }, { ctrlKey: true, shiftKey: true }, { metaKey: true, altKey: true },
				{ ctrlKey: true, repeat: true }, { ctrlKey: true, isComposing: true }, { ctrlKey: true, keyCode: 229 }]) {
				assert.equal(formatShortcut(new dom.window.KeyboardEvent('keydown', { key, ...options })), null);
			}
			const prevented = new dom.window.KeyboardEvent('keydown', { key, ctrlKey: true, cancelable: true });
			prevented.preventDefault(); assert.equal(formatShortcut(prevented), null);
		}
		assert.equal(formatShortcut(new dom.window.KeyboardEvent('keydown', { key: 'b', ctrlKey: true, shiftKey: true })), null);
		for (const key of ['a', 's', 'Enter', 'Process']) assert.equal(formatShortcut(new dom.window.KeyboardEvent('keydown', { key, ctrlKey: true })), null);
	} finally { dom.window.close(); }
});

for (const [format, command] of formats) {
	for (const [label, chosen, replacement] of [
		['middle', 'cd', '\\' + command + '{ab}cd\\' + command + '{ef}'],
		['leading', 'ab', 'ab\\' + command + '{cdef}'],
		['trailing', 'ef', '\\' + command + '{abcd}ef'],
		['whole', 'abcdef', 'abcdef']
	] as const) {
		test(`${command} cancels ${label} selection with exact source selection and shared undo/redo`, () => {
			const wrapper = '\\' + command + '{abcdef}';
			const original = '\uFEFF😀before\r\n' + wrapper + '\nlast\r';
			let { source, state } = selected(original, chosen);
			const selection = state.selection;
			state = formatTransaction(state, parseSource(source), format).state;
			const changed = state.field(sourceState).projection.document;
			assert.deepEqual(changed.toBytes(), bytes(original.replace(wrapper, replacement)));
			assert.equal(state.doc.sliceString(state.selection.main.from, state.selection.main.to), chosen);
			assert.equal(state.field(sourceState).dirty, true);
			assert.equal(state.field(sourceState).undo.length, 1);
			state = historyTransaction(state, 'undo')!.state;
			assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original));
			assert.equal(state.selection.eq(selection), true);
			assert.equal(state.field(sourceState).dirty, false);
			state = historyTransaction(state, 'redo')!.state;
			assert.deepEqual(state.field(sourceState).projection.document.toBytes(), changed.toBytes());
			assert.equal(state.doc.sliceString(state.selection.main.from, state.selection.main.to), chosen);
			assert.deepEqual(source.toBytes(), bytes(original));
		});
	}
	test(`${command} partial cancellation preserves Unicode scalars and mixed EOL inside and outside wrapper`, () => {
		const left = 'ab\r\n', chosen = '雪😀\nlast', right = '\ref';
		const wrapper = '\\' + command + '{' + left + chosen + right + '}';
		const original = '\uFEFFprefix\n' + wrapper + '\r\n\\opaque{keep}\r';
		let { source, state } = selected(original, chosen);
		state = formatTransaction(state, parseSource(source), format).state;
		const expected = '\\' + command + '{' + left + '}' + chosen + '\\' + command + '{' + right + '}';
		const changed = state.field(sourceState).projection.document;
		assert.deepEqual(changed.toBytes(), bytes(original.replace(wrapper, expected)));
		assert.equal(state.doc.sliceString(state.selection.main.from, state.selection.main.to), chosen);
		state = historyTransaction(state, 'undo')!.state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original));
		state = historyTransaction(state, 'redo')!.state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), changed.toBytes());
	});
}

test('same-kind partial cancellation refuses wrappers containing format, unknown, math, comments or literal syntax', () => {
	for (const [format, command] of formats) for (const content of [
		'ab\\emph{nested}cd', 'ab\\opaque{unknown}cd', 'ab$x^2$cd',
		'ab% comment\ncd', 'ab\\verb|literal|cd', 'ab\\begin{array}{c}x\\end{array}cd'
	]) {
		const original = '\uFEFFprefix\r\n\\' + command + '{' + content + '}\nlast\r';
		const { source, state } = selected(original, 'ab');
		const checkpoint = state.field(sourceState);
		assert.throws(() => formatTransaction(state, parseSource(source), format), /FORMAT_RANGE/, original);
		assert.equal(state.field(sourceState), checkpoint);
		assert.equal(state.field(sourceState).dirty, false);
		assert.equal(state.field(sourceState).undo.length, 0);
		assert.deepEqual(source.toBytes(), bytes(original));
	}
});

test('genuine visual selection bridges partial cancellation and reprojects into separated marks without fake geometry', { timeout: 5000 }, () => {
	const dom = new JSDOM('<!doctype html><body><div id="target"></div></body>', { pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}
	const original = '\uFEFFbefore\r\n\\textbf{abcdef}\nlast\r';
	const source = SourceDocument.open(bytes(original));
	let editor = createSourceState(source);
	const target = dom.window.document.getElementById('target');
	const view = new VisualEditor(target, 'partial.tex', { source: () => editor.field(sourceState).projection.document,
		apply: () => { throw new Error('A selection bridge must not mutate source'); }, history: () => false,
		readOnly: () => false, rejected: () => assert.fail('Unexpected visual rejection'), status: () => {} });
	try {
		view.sync(parseSource(source));
		let position = -1;
		view.view.state.doc.forEach((node, offset) => { if (node.type.name === 'source_block' && node.textContent.includes('abcdef')) position = offset + 1 + node.textContent.indexOf('cd'); });
		assert.ok(position >= 0);
		view.view.dispatch(view.view.state.tr.setSelection(TextSelection.create(view.view.state.doc, position, position + 2)));
		const span = view.formatSelection(); assert.ok(span);
		assert.equal(source.read(span.from, span.to), 'cd');
		editor = formatTransaction(editor, parseSource(source), 'strong', span).state;
		const changed = editor.field(sourceState).projection.document;
		assert.deepEqual(changed.toBytes(), bytes(original.replace('\\textbf{abcdef}', '\\textbf{ab}cd\\textbf{ef}')));
		view.sync(parseSource(changed));
		assert.deepEqual([...target.querySelectorAll('strong')].map((node) => node.textContent), ['ab', 'ef']);
		assert.ok(target.textContent.includes('cd'));
		editor = historyTransaction(editor, 'undo')!.state;
		view.sync(parseSource(editor.field(sourceState).projection.document));
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), bytes(original));
		assert.deepEqual([...target.querySelectorAll('strong')].map((node) => node.textContent), ['abcdef']);
	} finally {
		view.dispose(); dom.window.close();
		for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});
