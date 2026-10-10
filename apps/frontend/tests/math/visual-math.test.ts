import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { EditorState as VisualState } from 'prosemirror-state';
import { SourceDocument, parseSource, type SourceSpan } from '@modutex/document-core';
import { visualSchema, projectVisual, visualPatches, advanceVisual } from '../../src/features/visual-editor/schema.ts';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';
import { createSourceState, sourceState, sourcePatchTransaction, historyTransaction } from '../../src/features/source-editor/state.ts';
import { equationAt, equationReplacement, equationSource, matrixSource, type EquationDraft } from '../../src/features/math/source.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const bytes = (text: string) => new TextEncoder().encode(text);
function mathNodes(document: ReturnType<typeof projectVisual>['document']) {
	const result: { node: typeof document; position: number }[] = [];
	document.descendants((node, position) => { if (node.type.name === 'math_inline' || node.type.name === 'math_block') result.push({ node, position }); });
	return result;
}

for (const [opening, closing, inline] of [['$', '$', true], ['$$', '$$', false], ['\\(', '\\)', true], ['\\[', '\\]', false]] as const) {
	test(`genuine parser projects ${opening} math as a source-backed atom without changing BOM/mixed EOL bytes`, () => {
		const latex = '\\frac{1}{2}+\\alpha';
		const text = '\uFEFFBefore😀\r\n' + opening + latex + closing + '\n\\opaque{keep}\r';
		const source = SourceDocument.open(bytes(text));
		const projection = projectVisual(source, parseSource(source));
		const math = mathNodes(projection.document).map(({ node }) => node);
		assert.equal(math.length, 1);
		assert.equal(math[0]!.type.name, inline ? 'math_inline' : 'math_block');
		assert.equal(math[0]!.isAtom, true);
		assert.equal(math[0]!.attrs.source, opening + latex + closing);
		assert.equal(math[0]!.attrs.latex, latex);
		assert.equal(math[0]!.attrs.inline, inline);
		assert.equal(source.read(math[0]!.attrs.from, math[0]!.attrs.to), opening + latex + closing);
		assert.deepEqual(visualPatches(source, projection, VisualState.create({ doc: projection.document }).tr), []);
		assert.deepEqual(source.toBytes(), bytes(text));
	});
}

test('unsupported equation environments stay Raw and ordinary ProseMirror transactions cannot alter math atoms', () => {
	const source = SourceDocument.open(bytes('$x^2$\n\\begin{equation}y^2\\end{equation}\n\\begin{unknown}$z$\\end{unknown}'));
	const projection = projectVisual(source, parseSource(source));
	const state = VisualState.create({ doc: projection.document });
	const raw: string[] = [];
	let offset = -1;
	projection.document.descendants((node, position) => { if (node.type.name === 'raw_block') raw.push(node.attrs.source); if (node.type.name === 'math_inline') offset = position; });
	assert.ok(raw.includes('\\begin{equation}y^2\\end{equation}'));
	assert.ok(raw.includes('\\begin{unknown}$z$\\end{unknown}'));
	assert.ok(offset >= 0);
	for (const transaction of [state.tr.delete(offset, offset + 1), state.tr.setNodeAttribute(offset, 'latex', 'modified'), state.tr.setNodeAttribute(offset, 'source', '$modified$'), state.tr.setNodeAttribute(offset, 'inline', false)]) {
		assert.throws(() => visualPatches(source, projection, transaction), /VISUAL/);
	}
	assert.equal(visualSchema.nodes.math_block!.spec.atom, true);
	assert.deepEqual(source.toBytes(), bytes('$x^2$\n\\begin{equation}y^2\\end{equation}\n\\begin{unknown}$z$\\end{unknown}'));
});

test('closed math permits exactly 65536 UTF-16 units and leaves oversized content Raw without altering bytes', () => {
	for (const length of [65536, 65537]) {
		// Two UTF-16 units per astral scalar: this boundary is not a UTF-8 byte budget.
		const latex = '😀'.repeat(32768) + (length === 65537 ? 'x' : '');
		assert.equal(latex.length, length);
		const original = bytes('\uFEFF% keep\r\n$' + latex + '$\n');
		const source = SourceDocument.open(original);
		const projection = projectVisual(source, parseSource(source));
		const math = mathNodes(projection.document).map(({ node }) => node);
		const raw = projection.document.content.content.filter((node) => node.type.name === 'raw_block');
		assert.equal(math.length, length === 65536 ? 1 : 0);
		if (length === 65536) assert.equal(math[0]!.attrs.latex, latex);
		else assert.ok(raw.some((node) => node.attrs.source === '$' + latex + '$'));
		assert.deepEqual(visualPatches(source, projection, VisualState.create({ doc: projection.document }).tr), []);
		assert.deepEqual(source.toBytes(), original);
	}
});

test('real text edits before math reanchor the atom and preserve its bytes with exact shared undo', () => {
	const source = SourceDocument.open(bytes('\uFEFF\\section{A}\r\n$\\sqrt{4}$\n\\opaque{keep}'));
	const projection = projectVisual(source, parseSource(source));
	const state = VisualState.create({ doc: projection.document });
	const transaction = state.tr.insertText('雪', 2);
	const patches = visualPatches(source, projection, transaction);
	let editor = sourcePatchTransaction(createSourceState(source), projection, patches).state;
	const current = editor.field(sourceState).projection.document;
	const next = advanceVisual(source, projection, transaction, current);
	const oldMath = mathNodes(projection.document)[0]!.node;
	const newMath = mathNodes(next.document)[0]!.node;
	assert.equal(newMath.attrs.from, oldMath.attrs.from + 1);
	assert.equal(newMath.attrs.to, oldMath.attrs.to + 1);
	assert.equal(newMath.attrs.source, oldMath.attrs.source);
	assert.equal(current.read(newMath.attrs.from, newMath.attrs.to), '$\\sqrt{4}$');
	assert.deepEqual(current.toBytes(), bytes('\uFEFF\\section{A雪}\r\n$\\sqrt{4}$\n\\opaque{keep}'));
	editor = historyTransaction(editor, 'undo')!.state;
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), source.toBytes());
});

test('equation replacement and matrix insertion keep their projections through shared undo and redo', () => {
	const originalText = 'Before $ \\frac{1}{2} $\n\\opaque{keep}';
	const original = SourceDocument.open(bytes(originalText));
	let editor = createSourceState(original);
	const before = editor.field(sourceState).projection.document;
	const located = equationAt(before, parseSource(before), originalText.indexOf('$'));
	assert.ok(located);
	assert.deepEqual(located.draft, { latex: ' \\frac{1}{2} ', inline: true });

	const editedDraft: EquationDraft = { latex: ' \\frac{3}{4} ', inline: true };
	const replacement = equationReplacement(before, located, editedDraft);
	assert.equal(replacement, '$ \\frac{3}{4} $');
	const equationAfterText = originalText.slice(0, located.span.from) + replacement + originalText.slice(located.span.to);
	editor = editor.update({ changes: { from: located.span.from, to: located.span.to, insert: replacement } }).state;
	const afterEquation = editor.field(sourceState).projection.document;
	assert.deepEqual(afterEquation.toBytes(), bytes(equationAfterText));
	const equationNodes = mathNodes(projectVisual(afterEquation, parseSource(afterEquation)).document);
	const editedNode = equationNodes.find(({ node }) => node.attrs.source === replacement);
	assert.ok(editedNode);
	assert.equal(editedNode.node.attrs.latex, editedDraft.latex);

	const matrixLatex = matrixSource(
		{ rows: 2, columns: 2, cells: ['a', 'b', 'c', 'd'] },
		'square'
	);
	const matrixBlock = equationSource(matrixLatex, false);
	const matrixInsertion = '\n' + matrixBlock;
	const matrixAfterText = equationAfterText + matrixInsertion;
	editor = editor.update({ changes: { from: afterEquation.length, insert: matrixInsertion } }).state;
	const afterMatrix = editor.field(sourceState).projection.document;
	assert.deepEqual(afterMatrix.toBytes(), bytes(matrixAfterText));
	const projectedMath = mathNodes(projectVisual(afterMatrix, parseSource(afterMatrix)).document);
	assert.equal(projectedMath.length, 2);
	const matrixNode = projectedMath.find(({ node }) => node.attrs.source === matrixBlock);
	assert.ok(matrixNode);
	assert.equal(matrixNode.node.type.name, 'math_block');
	assert.equal(matrixNode.node.attrs.inline, false);

	const undoMatrix = historyTransaction(editor, 'undo');
	assert.ok(undoMatrix, 'Matrix insertion must be an undoable source edit');
	editor = undoMatrix.state;
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), afterEquation.toBytes());

	const undoEquation = historyTransaction(editor, 'undo');
	assert.ok(undoEquation, 'Equation replacement must be an undoable source edit');
	editor = undoEquation.state;
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());

	const redoEquation = historyTransaction(editor, 'redo');
	assert.ok(redoEquation);
	editor = redoEquation.state;
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), afterEquation.toBytes());

	const redoMatrix = historyTransaction(editor, 'redo');
	assert.ok(redoMatrix);
	assert.deepEqual(redoMatrix.state.field(sourceState).projection.document.toBytes(), bytes(matrixAfterText));
});

test('actual visual math buttons bind current spans, reject read-only/stale authority and retire listeners (not MathLive rendering acceptance)', { timeout: 5000 }, async () => {
	const dom = new JSDOM('<!doctype html><body><div id="target"></div></body>', { pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}
	const original = SourceDocument.open(bytes('\uFEFF\\section{A}\r\n$\\frac{1}{2}$\n\\opaque{keep}'));
	let editor = createSourceState(original), readonly = false, rejected = 0;
	const actions: { draft: EquationDraft; span: SourceSpan }[] = [];
	const target = dom.window.document.getElementById('target');
	const view = new VisualEditor(target, 'math.tex', {
		source: () => editor.field(sourceState).projection.document,
		apply: (identity, patches) => { editor = sourcePatchTransaction(editor, identity, patches).state; return editor.field(sourceState).projection.document; },
		history: (direction) => { const transaction = historyTransaction(editor, direction); if (!transaction) return false; editor = transaction.state; view.refresh(); return true; },
		readOnly: () => readonly, rejected: () => rejected++, status: () => {}, equation: (draft, span) => actions.push({ draft, span })
	});
	try {
		view.sync(parseSource(original));
		assert.equal(target.querySelectorAll('.visual-math').length, 1);
		const retired = target.querySelector('.visual-math button');
		assert.ok(retired); assert.equal(retired.disabled, false); assert.match(retired.textContent, /編輯公式/);
		retired.click(); assert.equal(actions.length, 1);
		assert.deepEqual(actions[0]!.draft, { latex: '\\frac{1}{2}', inline: true });
		assert.equal(original.read(actions[0]!.span.from, actions[0]!.span.to), '$\\frac{1}{2}$');
		assert.equal(actions[0]!.span.documentId, original.documentId);
		assert.equal(actions[0]!.span.version, original.version);
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
		view.view.dispatch(view.view.state.tr.insertText('雪', 2));
		const relocated = target.querySelector('.visual-math button');
		assert.ok(relocated);
		if (relocated !== retired) { retired.click(); assert.equal(actions.length, 1); }
		relocated.click(); assert.equal(actions.length, 2);
		assert.equal(actions[1]!.span.from, actions[0]!.span.from + 1);
		assert.equal(actions[1]!.span.version, editor.field(sourceState).projection.document.version);
		readonly = true; view.refresh(); assert.equal(relocated.disabled, true);
		relocated.click(); assert.equal(actions.length, 2);
		readonly = false; view.refresh();
		let position = -1;
		view.view.state.doc.descendants((node, offset) => { if (node.type.name === 'math_inline') position = offset; });
		view.view.dispatch(view.view.state.tr.setNodeAttribute(position, 'latex', 'illegal'));
		assert.equal(rejected, 1); assert.equal(actions.length, 2);
		editor = editor.update({ changes: { from: 0, insert: 'external ' } }).state;
		view.refresh(); assert.equal(relocated.disabled, true); relocated.click(); assert.equal(actions.length, 2);
		view.sync(parseSource(editor.field(sourceState).projection.document));
		const updated = target.querySelector('.visual-math button');
		assert.ok(updated); assert.equal(updated.disabled, false);
		if (updated !== relocated) { relocated.click(); assert.equal(actions.length, 2); }
		updated.click(); assert.equal(actions.length, 3);
		assert.equal(actions[2]!.span.version, editor.field(sourceState).projection.document.version);
		view.dispose(); view.dispose(); retired.click(); relocated.click(); updated.click();
		assert.equal(actions.length, 3); assert.equal(target.children.length, 0);
		// Only settle native queued work. No fake Range, canvas, MathLive or geometry APIs.
		await new Promise((resolve) => setTimeout(resolve, 30));
	} finally {
		view.dispose(); dom.window.close();
		for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});
