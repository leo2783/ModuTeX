import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { TextSelection, NodeSelection } from 'prosemirror-state';
import { createRequire } from 'node:module';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';
import { SourceDocument, parseSource } from '@modutex/document-core';
import { formatTransaction } from '../../src/features/source-editor/format.ts';
import { createSourceState, sourceState, historyTransaction } from '../../src/features/source-editor/state.ts';
const bytes = (text: string) => new TextEncoder().encode(text);
const formats = [['strong', 'textbf'], ['em', 'textit'], ['underline', 'underline']] as const;
const { JSDOM } = createRequire(import.meta.url)('jsdom');
function selected(text: string, needle: string, collapsed = false) {
	const source = SourceDocument.open(bytes(text));
	let state = createSourceState(source);
	const from = state.doc.toString().indexOf(needle);
	assert.ok(from >= 0);
	state = state.update({ selection: { anchor: from, head: collapsed ? from : from + needle.length } }).state;
	return { source, state };
}

for (const [format, command] of formats) {
	test(`${format} applies to genuine plain Unicode text and shares exact BOM/mixed-EOL undo and redo`, () => {
		const original = '\uFEFFbefore😀\r\n雪 body\nlast\r';
		let { source, state } = selected(original, '雪 body');
		const selection = state.selection;
		state = formatTransaction(state, parseSource(source), format).state;
		const changed = state.field(sourceState).projection.document;
		assert.deepEqual(changed.toBytes(), bytes(original.replace('雪 body', '\\' + command + '{雪 body}')));
		assert.equal(changed.documentId, source.documentId);
		assert.equal(state.field(sourceState).dirty, true);
		assert.equal(state.field(sourceState).undo.length, 1);
		state = historyTransaction(state, 'undo')!.state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original));
		assert.equal(state.selection.eq(selection), true);
		assert.equal(state.field(sourceState).dirty, false);
		state = historyTransaction(state, 'redo')!.state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), changed.toBytes());
		assert.deepEqual(source.toBytes(), bytes(original));
	});
	test(`${format} collapsed plain-text position inserts an empty wrapper and places the genuine CodeMirror cursor inside`, () => {
		const original = '\uFEFF😀 before\r\nbody\nlast\r';
		let { source, state } = selected(original, 'body', true);
		const beforeCursor = state.selection.main.from;
		state = formatTransaction(state, parseSource(source), format).state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original.replace('body', '\\' + command + '{}body')));
		assert.equal(state.selection.main.empty, true);
		assert.equal(state.selection.main.head, beforeCursor + command.length + 2);
		state = state.update({ changes: { from: state.selection.main.head, insert: '雪' } }).state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original.replace('body', '\\' + command + '{雪}body')));
		state = historyTransaction(state, 'undo')!.state;
		state = historyTransaction(state, 'undo')!.state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original));
		assert.equal(state.selection.main.head, beforeCursor);
	});
}

for (const [format, command] of [['strong', 'textbf'], ['em', 'textit'], ['em', 'emph'], ['underline', 'underline']] as const) {
	for (const selection of ['wrapper', 'content'] as const) {
		test(`${format} cancels the complete known ${command} ${selection} without touching neighboring bytes`, () => {
			const wrapper = '\\' + command + '{雪😀}';
			const original = '\uFEFFbefore\r\n' + wrapper + '\nlast\r';
			let { source, state } = selected(original, selection === 'wrapper' ? wrapper : '雪😀');
			state = formatTransaction(state, parseSource(source), format).state;
			assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original.replace(wrapper, '雪😀')));
			assert.equal(state.field(sourceState).undo.length, 1);
			state = historyTransaction(state, 'undo')!.state;
			assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original));
		});
	}
}

for (const [format, command] of formats) {
	for (const [innerFormat, innerCommand] of formats) {
		if (format === innerFormat) continue;
		test(`${format} nests the complete ${innerFormat} wrapper using actual parser identity and shared history`, () => {
			const inner = '\\' + innerCommand + '{body}';
			const original = '\uFEFFbefore\r\n' + inner + '\nlast\r';
			let { source, state } = selected(original, inner);
			state = formatTransaction(state, parseSource(source), format).state;
			assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original.replace(inner, '\\' + command + '{' + inner + '}')));
			state = historyTransaction(state, 'undo')!.state;
			assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original));
		});
	}
}

test('format commands reject old/foreign parser identities and genuine read-only state without changing source/history', () => {
	const { source, state } = selected('body', 'body');
	const parsed = parseSource(source);
	const next = state.update({ changes: { from: 0, insert: 'new ' } }).state;
	assert.throws(() => formatTransaction(next, parsed, 'strong'), /STALE_FORMAT/);
	assert.throws(() => formatTransaction(state, parseSource(SourceDocument.open(source.toBytes())), 'strong'), /STALE_FORMAT/);
	const readonly = createSourceState(source, undefined, EditorState.readOnly.of(true));
	assert.throws(() => formatTransaction(readonly, parsed, 'strong'), /EDITOR_READ_ONLY/);
	assert.equal(state.field(sourceState).undo.length, 0);
	assert.equal(readonly.field(sourceState).undo.length, 0);
	assert.deepEqual(source.toBytes(), bytes('body'));
});

test('boundary-only format apply and cancel preserve genuine mixed EOL inside the selected text', () => {
	for (const [format, command] of formats) {
		const body = '雪\r\n😀\nlast\r';
		const original = '\uFEFFprefix ' + body + ' suffix';
		let { source, state } = selected(original, body.replace(/\r\n|\r/g, '\n'));
		state = formatTransaction(state, parseSource(source), format).state;
		const applied = state.field(sourceState).projection.document;
		assert.deepEqual(applied.toBytes(), bytes(original.replace(body, '\\' + command + '{' + body + '}')));
		// The returned selection remains the complete inner content in editor LF coordinates.
		state = formatTransaction(state, parseSource(applied), format).state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original));
		assert.equal(state.field(sourceState).undo.length, 2);
		state = historyTransaction(state, 'undo')!.state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), applied.toBytes());
		state = historyTransaction(state, 'undo')!.state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original));
		assert.equal(state.field(sourceState).dirty, false);
	}
});

test('unknown, comments, literal, math and partial commands are rejected atomically', () => {
	for (const [text, needle] of [
		['\\opaque{needle}', 'needle'], ['% needle\r\nbody', 'needle'],
		['\\verb|needle|', 'needle'], ['\\begin{verbatim}\nneedle\n\\end{verbatim}', 'needle'],
		['$needle$', 'needle'], ['\\[needle\\]', 'needle'],
		['\\begin{array}{cc}needle & b\\\\c & d\\end{array}', 'needle'],
		['\\textbf{needle}', 'textbf'],
		['\\textbf{unclosed', 'unclosed']
	] as const) {
		const { source, state } = selected(text, needle);
		const checkpoint = state.field(sourceState);
		for (const [format] of formats) assert.throws(() => formatTransaction(state, parseSource(source), format), /FORMAT_RANGE/, text);
		assert.equal(state.field(sourceState), checkpoint);
		assert.equal(state.field(sourceState).dirty, false);
		assert.equal(state.field(sourceState).undo.length, 0);
		assert.deepEqual(source.toBytes(), bytes(text));
	}
});

test('partial text selections across known wrappers preserve surrounding marks and exact shared history', () => {
	const cases = [
		{ text: '\\textbf{needle} tail', needle: 'dle} ta',
			expected: (command: string) => '\\textbf{nee}\\' + command + '{\\textbf{dle} ta}il' },
		{ text: 'first \\textbf{needle} tail', needle: 'first \\textbf{need',
			expected: (command: string) => '\\' + command + '{first \\textbf{need}}\\textbf{le} tail' },
		{ text: '\\textbf{one} \\emph{two}', needle: 'one} \\emph{two',
			expected: (command: string) => '\\' + command + '{\\textbf{one} \\emph{two}}' }
	];
	for (const fixture of cases) for (const [format, command] of formats) {
		const prefix = '\uFEFFbefore\r\n', suffix = '\n\\opaque{keep}\r';
		const original = prefix + fixture.text + suffix;
		let { source, state } = selected(original, fixture.needle);
		const originalSelection = state.selection;
		state = formatTransaction(state, parseSource(source), format).state;
		const expected = bytes(prefix + fixture.expected(command) + suffix);
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), expected);
		assert.equal(state.field(sourceState).undo.length, 1);
		state = historyTransaction(state, 'undo')!.state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), bytes(original));
		assert.equal(state.selection.eq(originalSelection), true);
		state = historyTransaction(state, 'redo')!.state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(), expected);
		assert.deepEqual(source.toBytes(), bytes(original));
	}
});

function visualDom() {
	const dom = new JSDOM('<!doctype html><body><div id="target"></div></body>', { pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}
	return { dom, target: dom.window.document.getElementById('target'), restore() {
		dom.window.close();
		for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	} };
}

test('genuine ProseMirror selections bridge to source formatting, parser reproject and exact shared CodeMirror undo', { timeout: 5000 }, () => {
	const fixture = visualDom();
	try {
		for (const [format, command] of formats) {
			const original = '\uFEFF\\section{A}\r\nplain雪 body\n\\opaque{keep}\r';
			const source = SourceDocument.open(bytes(original));
			let editor = createSourceState(source);
			const view = new VisualEditor(fixture.target, 'format.tex', {
				source: () => editor.field(sourceState).projection.document,
				apply: () => { throw new Error('A selection-only bridge must not mutate source'); },
				history: () => false, readOnly: () => false, rejected: () => assert.fail('Unexpected visual rejection'), status: () => {}
			});
			try {
				view.sync(parseSource(source));
				let position = -1;
				view.view.state.doc.forEach((node, offset) => { if (node.type.name === 'source_block' && node.textContent.includes('plain雪')) position = offset + 1 + node.textContent.indexOf('plain雪'); });
				assert.ok(position >= 0);
				view.view.dispatch(view.view.state.tr.setSelection(TextSelection.create(view.view.state.doc, position, position + 'plain雪'.length)));
				const span = view.formatSelection();
				assert.ok(span); assert.equal(source.read(span.from, span.to), 'plain雪');
				assert.equal(span.documentId, source.documentId); assert.equal(span.version, source.version);
				editor = formatTransaction(editor, parseSource(source), format, span).state;
				const changed = editor.field(sourceState).projection.document;
				assert.deepEqual(changed.toBytes(), bytes(original.replace('plain雪', '\\' + command + '{plain雪}')));
				view.sync(parseSource(changed));
				const selector = format === 'strong' ? 'strong' : format === 'em' ? 'em' : 'u';
				assert.equal(fixture.target.querySelector(selector)?.textContent, 'plain雪');
				editor = historyTransaction(editor, 'undo')!.state;
				view.sync(parseSource(editor.field(sourceState).projection.document));
				assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), bytes(original));
				assert.equal(editor.field(sourceState).dirty, false);
			} finally { view.dispose(); }
		}
	} finally { fixture.restore(); }
});

test('visual format mapping refuses Raw/math atoms, cross-block selection, stale/foreign source, read-only and disposed views', { timeout: 5000 }, () => {
	const fixture = visualDom();
	const original = SourceDocument.open(bytes('\uFEFFplain\r\n$math$\n\\opaque{keep}\rtail'));
	let source = original, readonly = false;
	const view = new VisualEditor(fixture.target, 'format.tex', { source: () => source,
		apply: () => { throw new Error('Mapping must not change source'); }, history: () => false,
		readOnly: () => readonly, rejected: () => assert.fail('Unexpected visual rejection'), status: () => {} });
	try {
		view.sync(parseSource(original));
		let plain = -1, tail = -1;
		const atoms: number[] = [];
		view.view.state.doc.forEach((node, offset) => { if (node.type.name === 'source_block' && node.textContent.includes('plain')) plain = offset + 1 + node.textContent.indexOf('plain'); if (node.type.name === 'source_block' && node.textContent.includes('tail')) tail = offset + 1 + node.textContent.indexOf('tail'); });
		view.view.state.doc.descendants((node, offset) => { if (['raw_block', 'math_block', 'math_inline'].includes(node.type.name)) atoms.push(offset); });
		assert.ok(plain >= 0); assert.ok(atoms.length >= 2);
		for (const position of atoms) {
			view.view.dispatch(view.view.state.tr.setSelection(NodeSelection.create(view.view.state.doc, position)));
			assert.equal(view.formatSelection(), null);
		}
		assert.ok(tail >= 0);
		view.view.dispatch(view.view.state.tr.setSelection(TextSelection.create(view.view.state.doc, plain, tail + 2)));
		assert.equal(view.formatSelection(), null);
		view.view.dispatch(view.view.state.tr.setSelection(TextSelection.create(view.view.state.doc, plain, plain + 2)));
		const span = view.formatSelection(); assert.ok(span);
		readonly = true; view.refresh(); assert.equal(view.formatSelection(), null);
		readonly = false; view.refresh();
		source = original.apply({ expectedVersion: original.version, patches: [{ from: 0, to: 0, insert: 'new ' }] }).document;
		view.refresh(); assert.equal(view.formatSelection(), null);
		assert.throws(() => formatTransaction(createSourceState(source), parseSource(source), 'strong', span), /STALE_FORMAT/);
		source = SourceDocument.open(original.toBytes());
		view.refresh(); assert.equal(view.formatSelection(), null);
		assert.throws(() => formatTransaction(createSourceState(source), parseSource(source), 'strong', span), /STALE_FORMAT/);
		view.dispose(); assert.equal(view.formatSelection(), null);
		assert.deepEqual(original.toBytes(), bytes('\uFEFFplain\r\n$math$\n\\opaque{keep}\rtail'));
	} finally { view.dispose(); fixture.restore(); }
});
