import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { foldable, foldEffect, foldedRanges, unfoldEffect, foldCode, unfoldAll } from '@codemirror/language';
import { SourceDocument, parseSource } from '@modutex/document-core';
import { createSourceState, sourceState, historyTransaction } from '../../src/features/source-editor/state.ts';
import { foldProjection, foldIndex, sourceFolding } from '../../src/features/source-editor/folding.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const source = (text: string) => SourceDocument.open(new TextEncoder().encode(text));
const publish = (state: EditorState) => state.update({ effects: foldProjection.of(parseSource(state.field(sourceState).projection.document)) }).state;
const rangeAt = (state: EditorState, text: string) => { const line = state.doc.lineAt(state.doc.toString().indexOf(text)); return foldable(state, line.from, line.to); };

test('real folding service respects heading hierarchy and matched environment delimiters with mixed EOL', () => {
	const original = source('\uFEFF\\begin{document}\r\n\\section{One}\nfirst\r\\subsection{Child}\r\nchild\n\\section*{Two}\nlast\n\\end{document}');
	const state = publish(createSourceState(original, undefined, sourceFolding()));
	const one = rangeAt(state, '\\section{One}')!, child = rangeAt(state, '\\subsection{Child}')!, two = rangeAt(state, '\\section*{Two}')!;
	assert.equal(state.doc.sliceString(one.from, one.to), '\nfirst\n\\subsection{Child}\nchild');
	assert.equal(state.doc.sliceString(child.from, child.to), '\nchild');
	assert.equal(state.doc.sliceString(two.from, two.to), '\nlast');
	const document = rangeAt(state, '\\begin{document}')!;
	assert.ok(state.doc.sliceString(document.from, document.to).includes('\\section*{Two}'));
	assert.ok(!state.doc.sliceString(document.from, document.to).includes('\\end{document}'));
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), original.toBytes());
});
test('comments, literal bodies, unmatched syntax and surrogate prefixes cannot invent fold ranges', () => {
	const original = source('% \\section{Comment}\n\\begin{verbatim}\n\\section{Literal}\n\\end{verbatim}\n\\x{ab😀}\n\\begin{broken}\nvalue');
	const state = publish(createSourceState(original, undefined, sourceFolding()));
	assert.equal(rangeAt(state, '% \\section'), null);
	assert.equal(rangeAt(state, '\\section{Literal}'), null);
	assert.equal(rangeAt(state, '\\x{'), null);
	assert.equal(rangeAt(state, '\\begin{broken}'), null);
	assert.ok(rangeAt(state, '\\begin{verbatim}'));
});
test('source changes invalidate fold index; late and foreign projections cannot override fresh ranges', () => {
	const original = source('\\section{One}\ntext\n\\section{Two}\nother'); const old = parseSource(original);
	let state = publish(createSourceState(original, undefined, sourceFolding()));
	state = state.update({ changes: { from: 0, to: 0, insert: '% new\n' } }).state;
	assert.equal(state.field(foldIndex), null);
	state = state.update({ effects: foldProjection.of(old) }).state; assert.equal(state.field(foldIndex), null);
	state = publish(state); const fresh = state.field(foldIndex);
	state = state.update({ effects: foldProjection.of(old) }).state; assert.equal(state.field(foldIndex), fresh);
	state = state.update({ effects: foldProjection.of(parseSource(source(original.read()))) }).state; assert.equal(state.field(foldIndex), fresh);
	state = state.update({ effects: foldProjection.of(null) }).state; assert.equal(state.field(foldIndex), null);
});
test('actual CodeMirror fold/unfold effects do not change bytes, checkpoint or shared undo', () => {
	const original = source('\uFEFF\\section{One}\r\ntext\r\\section{Two}\nother');
	let state = publish(createSourceState(original, undefined, [sourceFolding(), EditorState.readOnly.of(true)]));
	const initial = state.field(sourceState), range = rangeAt(state, '\\section{One}')!;
	state = state.update({ effects: foldEffect.of(range) }).state; assert.equal(foldedRanges(state).size, 1);
	assert.equal(state.field(sourceState), initial); assert.equal(historyTransaction(state, 'undo'), null);
	state = state.update({ effects: unfoldEffect.of(range) }).state; assert.equal(foldedRanges(state).size, 0);
	assert.equal(state.field(sourceState), initial); assert.deepEqual(initial.projection.document.toBytes(), original.toBytes());
	state = createSourceState(original, undefined, sourceFolding());
	state = state.update({ changes: { from: state.doc.length, insert: '\nnew' } }).state; state = publish(state);
	state = state.update({ effects: foldEffect.of(rangeAt(state, '\\section{One}')!) }).state;
	state = historyTransaction(state, 'undo')!.state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), original.toBytes());
});
test('real EditorView folds through public commands and retired placeholders cannot operate after destroy', () => {
	const dom = new JSDOM('<!doctype html><body><div id="target"></div></body>', { pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}
	let view: EditorView | null = null;
	try {
		const original = source('\\section{One}\nfirst\nsecond\n');
		view = new EditorView({ parent: dom.window.document.getElementById('target'), state: publish(createSourceState(original, undefined, sourceFolding())) });
		assert.equal(foldCode(view), true); assert.equal(foldedRanges(view.state).size, 1);
		const retired = view.dom.querySelector<HTMLButtonElement>('button.cm-foldPlaceholder')!; assert.ok(retired);
		retired.click(); assert.equal(foldedRanges(view.state).size, 0);
		assert.equal(foldCode(view), true); assert.equal(unfoldAll(view), true);
		assert.deepEqual(view.state.field(sourceState).projection.document.toBytes(), original.toBytes());
		assert.equal(foldCode(view), true);
		const held = view.dom.querySelector<HTMLButtonElement>('button.cm-foldPlaceholder')!; assert.ok(held);
		const beforeDestroy = view.state;
		view.destroy(); view.destroy(); assert.doesNotThrow(() => retired.click()); assert.doesNotThrow(() => held.click());
		assert.equal(view.state, beforeDestroy);
	} finally {
		view?.destroy(); dom.window.close();
		for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});
