import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { EditorState as VisualState, TextSelection } from 'prosemirror-state';
import { SourceDocument, parseSource, type SourceSpan } from '@modutex/document-core';
import { projectVisual, visualPatches, advanceVisual, escapeVisualText } from '../../src/features/visual-editor/schema.ts';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';
import { createSourceState, sourceState, sourcePatchTransaction, historyTransaction } from '../../src/features/source-editor/state.ts';
import { equationAt, type EquationDraft } from '../../src/features/math/source.ts';
import { equationEditTransaction } from '../../src/features/math/editor.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const bytes = (text: string) => new TextEncoder().encode(text);
function atoms(doc: ReturnType<typeof projectVisual>['document']) {
	const result: { node: typeof doc; position: number }[] = [];
	doc.descendants((node, position) => { if (node.type.name.startsWith('math_')) result.push({ node, position }); });
	return result;
}
function textPosition(doc: ReturnType<typeof projectVisual>['document'], needle: string) {
	let found = -1;
	doc.forEach((node, offset) => {
		if (node.type.name !== 'source_block') return;
		const index = node.textBetween(0, node.content.size, '', '\ufffc').indexOf(needle);
		if (index >= 0) { assert.equal(found, -1); found = offset + 1 + index; }
	});
	assert.ok(found >= 0, needle); return found;
}

test('inline dollar and parenthesized math share true paragraphs, heading and known-format marks', () => {
	for (const text of ['left $x$ middle \\(y\\) right', '\\section{left $x$ middle \\(y\\) right}', '\\textbf{left $x$ middle \\(y\\) right}']) {
		const source = SourceDocument.open(bytes(text)), projection = projectVisual(source, parseSource(source));
		assert.equal(projection.document.childCount, 1);
		const block = projection.document.firstChild!;
		assert.equal(block.type.name, 'source_block');
		assert.equal(block.textBetween(0, block.content.size, '', '\ufffc'), 'left \ufffc middle \ufffc right');
		const math = atoms(projection.document); assert.equal(math.length, 2);
		for (const { node } of math) {
			assert.equal(node.type.name, 'math_inline'); assert.equal(node.isInline, true); assert.equal(node.nodeSize, 1);
			assert.equal(source.read(node.attrs.from, node.attrs.to), node.attrs.source);
			if (text.startsWith('\\textbf')) assert.deepEqual(node.marks.map(mark => mark.type.name), ['strong']);
		}
		assert.deepEqual(source.toBytes(), bytes(text));
	}
});

test('escaped dollars are text; unknown environments, unclosed and oversized math remain Raw', () => {
	for (const text of ['cost \\$5', '\\begin{equation}$x$\\end{equation}', '\\begin{unknown}\\(x\\)\\end{unknown}', '$unclosed', '$' + 'x'.repeat(65537) + '$']) {
		const source = SourceDocument.open(bytes(text)), projection = projectVisual(source, parseSource(source));
		assert.equal(atoms(projection.document).length, 0);
		if (!text.startsWith('cost')) assert.ok(projection.document.content.content.some(node => node.type.name === 'raw_block'));
		assert.deepEqual(source.toBytes(), bytes(text));
	}
});

test('consecutive real PM text edits around two atoms preserve local bytes, escapes, reanchors and shared undo/redo', () => {
	const text = '\uFEFF%keep\r\nStart $x^2$ middle \\(y^2\\) end\r\n\\opaque{raw}\n';
	const original = SourceDocument.open(bytes(text));
	let editor = createSourceState(original), source = original, projection = projectVisual(source, parseSource(source)), expected = text;
	for (const [needle, replacement] of [['Start', 'Begin%😀'], ['middle', 'mid&雪'], ['end', 'finish$']] as const) {
		const position = textPosition(projection.document, needle);
		const transaction = VisualState.create({ doc: projection.document }).tr.insertText(replacement, position, position + needle.length);
		const patches = visualPatches(source, projection, transaction);
		assert.equal(patches.length, 1); assert.equal(patches[0]!.expected, needle);
		assert.equal(patches[0]!.insert, escapeVisualText(replacement));
		editor = sourcePatchTransaction(editor, projection, patches).state;
		const current = editor.field(sourceState).projection.document;
		projection = advanceVisual(source, projection, transaction, current); source = current;
		expected = expected.replace(needle, escapeVisualText(replacement));
		assert.deepEqual(source.toBytes(), bytes(expected));
		const reparsed = atoms(projectVisual(source, parseSource(source)).document);
		assert.equal(reparsed.length, 2);
		atoms(projection.document).forEach(({ node }, index) => {
			assert.equal(source.read(node.attrs.from, node.attrs.to), index ? '\\(y^2\\)' : '$x^2$');
			assert.deepEqual(node.attrs, reparsed[index]!.node.attrs);
		});
	}
	while (true) { const undo = historyTransaction(editor, 'undo'); if (!undo) break; editor = undo.state; }
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
	while (true) { const redo = historyTransaction(editor, 'redo'); if (!redo) break; editor = redo.state; }
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), bytes(expected));
});

test('formula-only paragraph accepts repeated typing on both sides without moving source ownership into math', () => {
	const original = SourceDocument.open(bytes('\uFEFF$x$'));
	let source = original, projection = projectVisual(source, parseSource(source)), editor = createSourceState(source);
	for (const [side, insert] of [['before', 'A'], ['before', 'B'], ['after', 'C'], ['after', 'D']] as const) {
		const atom = atoms(projection.document)[0]!;
		const position = atom.position + (side === 'after' ? 1 : 0);
		const transaction = VisualState.create({ doc: projection.document }).tr.insertText(insert, position);
		const patches = visualPatches(source, projection, transaction);
		assert.equal(patches.length, 1); assert.equal(patches[0]!.expected, '');
		editor = sourcePatchTransaction(editor, projection, patches).state;
		const current = editor.field(sourceState).projection.document;
		projection = advanceVisual(source, projection, transaction, current); source = current;
		const relocated = atoms(projection.document)[0]!.node;
		assert.equal(source.read(relocated.attrs.from, relocated.attrs.to), '$x$');
	}
	assert.deepEqual(source.toBytes(), bytes('\uFEFFAB$x$DC'));
	while (true) { const undo = historyTransaction(editor, 'undo'); if (!undo) break; editor = undo.state; }
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
});

test('ordinary deletion, mutation, formatting and cross-atom replacement cannot change source/history', () => {
	const text = '\uFEFFleft $x$ middle \\(y\\) right\r\n';
	const source = SourceDocument.open(bytes(text)), projection = projectVisual(source, parseSource(source));
	const state = VisualState.create({ doc: projection.document }), math = atoms(projection.document), first = math[0]!.position, last = math[1]!.position;
	for (const transaction of [
		state.tr.delete(first, first + 1), state.tr.setNodeAttribute(first, 'latex', 'z'),
		state.tr.setNodeAttribute(first, 'source', '$z$'), state.tr.setNodeAttribute(first, 'inline', false),
		state.tr.insertText('replace', first - 1, last + 2),
		state.tr.addMark(first, first + 1, state.schema.marks.strong!.create())
	]) assert.throws(() => visualPatches(source, projection, transaction), /VISUAL/);
	assert.deepEqual(source.toBytes(), bytes(text));
	assert.equal(historyTransaction(createSourceState(source), 'undo'), null);
});

test('true inline DOM buttons track adjacent edits and dedicated equation edits use exact shared undo; no renderer simulation', { timeout: 5000 }, async () => {
	const dom = new JSDOM('<!doctype html><body><div id="target"></div></body>', { pretendToBeVisual: true });
	const saved = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}
	const original = SourceDocument.open(bytes('\uFEFFleft $x$ middle \\(y\\) right\r\n'));
	let editor = createSourceState(original), readonly = false, rejected = 0;
	const actions: { draft: EquationDraft; span: SourceSpan }[] = [];
	const target = dom.window.document.getElementById('target');
	const view = new VisualEditor(target, 'inline.tex', {
		source: () => editor.field(sourceState).projection.document,
		apply: (identity, patches) => { editor = sourcePatchTransaction(editor, identity, patches).state; return editor.field(sourceState).projection.document; },
		history: () => false, readOnly: () => readonly, rejected: () => rejected++, status: () => {},
		equation: (draft, span) => actions.push({ draft, span })
	});
	try {
		view.sync(parseSource(original));
		assert.equal(target.querySelectorAll('span.visual-math-inline').length, 2);
		assert.equal(target.querySelectorAll('figure.visual-math').length, 0);
		const initialAtoms = atoms(view.view.state.doc);
		view.view.dispatch(view.view.state.tr.setSelection(TextSelection.create(view.view.state.doc, initialAtoms[0]!.position - 1, initialAtoms[1]!.position + 2)));
		assert.equal(view.formatSelection(), null);
		view.view.dispatch(view.view.state.tr.setSelection(TextSelection.create(view.view.state.doc, initialAtoms[0]!.position, initialAtoms[0]!.position + 1)));
		assert.equal(view.formatSelection(), null);
		const plain = textPosition(view.view.state.doc, 'left');
		view.view.dispatch(view.view.state.tr.setSelection(TextSelection.create(view.view.state.doc, plain, plain + 4)));
		assert.equal(original.read(view.formatSelection()!.from, view.formatSelection()!.to), 'left');
		readonly = true; view.refresh(); assert.equal(view.formatSelection(), null); readonly = false; view.refresh();
		const retired = target.querySelectorAll('.visual-math button')[1]!;
		retired.click(); assert.equal(actions.length, 1);
		assert.equal(original.read(actions[0]!.span.from, actions[0]!.span.to), '\\(y\\)');
		view.view.dispatch(view.view.state.tr.insertText('雪', textPosition(view.view.state.doc, 'left')));
		target.querySelectorAll('.visual-math button')[1]!.click();
		assert.equal(actions.length, 2); assert.equal(actions[1]!.span.from, actions[0]!.span.from + 1);
		const current = editor.field(sourceState).projection.document;
		const located = equationAt(current, parseSource(current), actions[1]!.span.from + 2)!;
		assert.ok(located);
		const edit = equationEditTransaction(editor, located, { latex: '\\sqrt{4}+\\alpha', inline: true })!;
		assert.ok(edit); editor = edit.state; view.refresh();
		const stale = target.querySelectorAll('.visual-math button')[1]!;
		assert.equal(stale.disabled, true); stale.click(); assert.equal(actions.length, 2);
		assert.throws(() => equationEditTransaction(editor, located, { latex: 'z', inline: true }), /STALE_EQUATION/);
		view.sync(parseSource(editor.field(sourceState).projection.document));
		const fresh = target.querySelectorAll('.visual-math button')[1]!;
		fresh.click(); assert.equal(actions.length, 3);
		assert.deepEqual(actions[2]!.draft, { latex: '\\sqrt{4}+\\alpha', inline: true });
		assert.equal(editor.field(sourceState).projection.document.read(actions[2]!.span.from, actions[2]!.span.to), '\\(\\sqrt{4}+\\alpha\\)');
		readonly = true; view.refresh(); assert.equal(fresh.disabled, true); fresh.click(); assert.equal(actions.length, 3);
		readonly = false; view.refresh();
		const atom = atoms(view.view.state.doc)[0]!;
		view.view.dispatch(view.view.state.tr.delete(atom.position, atom.position + 1)); assert.equal(rejected, 1);
		while (true) { const undo = historyTransaction(editor, 'undo'); if (!undo) break; editor = undo.state; }
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
		view.sync(parseSource(editor.field(sourceState).projection.document));
		// Coordinate-only updates retain live NodeViews. Detached listeners must
		// be retired; retained buttons must instead read the current source span.
		for (const button of new Set([stale, fresh, retired])) {
			const count: number = actions.length;
			const mounted: boolean = target.contains(button);
			button.click(); assert.equal(actions.length, count + (mounted ? 1 : 0));
			if (mounted) {
				const action = actions.at(-1)!;
				assert.equal(action.span.version, editor.field(sourceState).projection.document.version);
				assert.equal(editor.field(sourceState).projection.document.read(action.span.from, action.span.to), '\\(y\\)');
				assert.equal(action.draft.latex, 'y');
			}
		}
		const finalButton = target.querySelector('.visual-math button')!;
		const beforeDispose = actions.length;
		view.dispose(); view.dispose(); finalButton.click(); stale.click(); fresh.click(); retired.click();
		assert.equal(actions.length, beforeDispose);
		assert.equal(target.children.length, 0);
		await new Promise(resolve => setTimeout(resolve, 30));
	} finally {
		view.dispose(); dom.window.close();
		for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});
