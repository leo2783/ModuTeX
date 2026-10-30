import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { TextSelection } from 'prosemirror-state';
import { EditorState } from '@codemirror/state';
import { SourceDocument, parseSource } from '../../src/features/document-core/core.ts';
import { projectVisual } from '../../src/features/visual-editor/schema.ts';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';
import { createSourceState, sourceState, sourcePatchTransaction, paragraphInsertionTransaction, historyTransaction } from '../../src/features/source-editor/state.ts';
import { structureTransaction, type TextStructure } from '../../src/features/source-editor/structure.ts';
import { sourceLimit } from '../../src/features/files/read.ts';

const { JSDOM } = createRequire(import.meta.url)('jsdom');
const samples = [
	'繁體中文 日本語 한글',
	'\u{20000}\u{2EBF0}\u{1D11E}',
	String.fromCodePoint(0x1f469, 0x1f3fd, 0x200d, 0x1f4bb, 0x1f1f9, 0x1f1fc, 0xfe0f),
	'e\u0301 a\u0323\u0302 \u0915\u094D\u0937',
	'العربية עברית \u2067RTL\u2069',
	'\u00A0\u200B\u2028\u2029\u3000',
	'\u00A0\u3000',
	'100% & $ # _ { } \\ ^ ~'
];

function mount(text: string) {
	const dom = new JSDOM('<!doctype html><body><div id="editor"></div></body>', { pretendToBeVisual: true });
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
		previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true,
			value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}
	const original = SourceDocument.open(new TextEncoder().encode('\uFEFF' + text));
	let state = createSourceState(original);
	const source = () => state.field(sourceState).projection.document;
	const toolbar = dom.window.document.createElement('div');
	dom.window.document.body.append(toolbar);
	const visual = new VisualEditor(dom.window.document.getElementById('editor'), 'main.tex', {
		source, readOnly: () => false, status: () => {}, locale: () => 'en',
		cellToolbar: element => toolbar.replaceChildren(...(element ? [element] : [])),
		cellCancel: (span, original) => { state = sourcePatchTransaction(state, span, [{ from: span.from, to: span.to, insert: original, expected: source().read(span.from, span.to) }], true).state; },
		rejected: () => assert.fail('valid cell action rejected'),
		apply: (identity, patches) => { state = sourcePatchTransaction(state, identity, patches).state; return source(); },
		history: () => false,
		insertBlock: (kind, span, beforeText) => {
			assert.equal(kind, 'text');
			state = paragraphInsertionTransaction(state, span, beforeText).transaction.state;
		}
	});
	const sync = () => visual.sync(parseSource(source()));
	const select = (index: number, end = false) => {
		let position = 0;
		for (let i = 0; i < index; i++) position += visual.view.state.doc.child(i).nodeSize;
		visual.view.dispatch(visual.view.state.tr.setSelection(TextSelection.create(visual.view.state.doc, position + 1 + (end ? visual.view.state.doc.child(index).content.size : 0))));
	};
	sync();
	return { visual, source, original, sync, select, toolbar,
		get state() { return state; },
		setState(next: typeof state) { state = next; },
		dispose() {
			visual.dispose(); dom.window.close();
			for (const [key, descriptor] of previous) {
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
		}
	};
}

for (const sample of samples) test(`structure capture immediately after Unicode typing retains current text: ${JSON.stringify(sample)}`, () => {
	const fixture = mount('\\begin{document}\r\n\\par\r\n\\end{document}');
	try {
		fixture.select(0);
		fixture.visual.view.dispatch(fixture.visual.view.state.tr.insertText(sample));
		const captured = fixture.visual.textStructureSelection();
		assert.ok(captured);
		const expected = fixture.source().read(captured.span.from, captured.span.to).replace(/^\\par[\r\n]*/, '');
		assert.equal(captured.content, expected, 'current canonical source anchors must be used before the parser acknowledges typing');
		assert.deepEqual(historyTransaction(fixture.state, 'undo')!.state.field(sourceState).projection.document.toBytes(), fixture.original.toBytes());
	} finally { fixture.dispose(); }
});

for (const command of ['section', 'subsection', 'subsubsection', 'begin{abstract}\nA\n\\end{abstract}']) {
	for (const eol of ['\n', '\r\n']) test(`insert above ${command} adds exactly one cell (${JSON.stringify(eol)})`, () => {
		const block = command.startsWith('begin') ? '\\' + command : `\\${command}{標題\u{20000}}`;
		const fixture = mount(`\\begin{document}${eol}${block.replaceAll('\n', eol)}${eol}\\end{document}`);
		try {
			fixture.select(0);
			const count = fixture.visual.view.state.doc.childCount;
			const above = fixture.toolbar.querySelector('[title="Insert above"]') as HTMLButtonElement;
			assert.ok(above); above.click();
			const text = above.parentElement!.querySelector('.cell-menu-btn') as HTMLButtonElement;
			text.click(); fixture.sync();
			assert.equal(fixture.visual.view.state.doc.childCount, count + 1);
			assert.equal(fixture.visual.view.state.doc.firstChild!.textContent, '');
			assert.deepEqual(historyTransaction(fixture.state, 'undo')!.state.field(sourceState).projection.document.toBytes(), fixture.original.toBytes());
		} finally { fixture.dispose(); }
	});
}

for (const eol of ['\n', '\r\n']) test(`abstract syntax padding does not add visual lines (${JSON.stringify(eol)})`, () => {
	const content = '摘要\u{20000}\\\\第二行';
	const source = SourceDocument.open(new TextEncoder().encode(`\\begin{abstract}${eol}${content}${eol}\\end{abstract}`));
	const projection = projectVisual(source, parseSource(source));
	assert.equal(projection.document.childCount, 1);
	assert.equal(projection.document.firstChild!.attrs.role, 'abstract');
	assert.equal(projection.document.firstChild!.textContent, '摘要\u{20000}\n第二行');
});

const structures: TextStructure[] = ['paragraph', 'title', 'abstract', 'section', 'subsection', 'subsubsection'];
function change(fixture: ReturnType<typeof mount>, kind: TextStructure) {
	const selected = fixture.visual.textStructureSelection();
	assert.ok(selected, 'selected cell remains editable across transitions');
	const result = structureTransaction(fixture.state, selected, kind);
	fixture.setState(result.transaction.state);
	fixture.sync();
	assert.equal(fixture.visual.selectChangedCell(result.cell), true, 'focus follows the converted cell');
	return result;
}

for (const eol of ['\n', '\r\n', '\r']) for (const sample of ['', ...samples]) {
	test(`all structure pairs preserve Unicode, neighbors, source history and editability (${JSON.stringify(eol)}, ${JSON.stringify(sample)})`, () => {
		const fixture = mount(`\\documentclass{article}${eol}\\unknown{keep}${eol}\\begin{document}${eol}\\section{Neighbor}${eol}\\par${eol}\\par${eol}tail${eol}\\end{document}`);
		try {
			fixture.select(1);
			if (sample) fixture.visual.view.dispatch(fixture.visual.view.state.tr.insertText(sample));
			const typed = fixture.source().toBytes();
			for (const from of structures) for (const to of structures) {
				change(fixture, from);
				const before = fixture.source().toBytes();
				const result = change(fixture, to);
				assert.equal(fixture.visual.view.state.doc.childCount, 3);
				assert.equal(fixture.visual.view.state.selection.$from.parent.textContent, sample);
				assert.ok(fixture.source().read().includes('\\unknown{keep}' + eol));
				assert.equal(fixture.visual.view.state.doc.firstChild!.textContent, 'Neighbor');
				assert.equal(fixture.visual.view.state.doc.lastChild!.textContent.trim(), 'tail');
				const after = fixture.source().toBytes();
				if (result.transaction.docChanged) {
					const undone = historyTransaction(fixture.state, 'undo')!;
					assert.deepEqual(undone.state.field(sourceState).projection.document.toBytes(), before);
					const redone = historyTransaction(undone.state, 'redo')!;
					assert.deepEqual(redone.state.field(sourceState).projection.document.toBytes(), after);
					fixture.setState(redone.state); fixture.sync();
				}
				// Cancel starts from the new structure, never a wrapper from a prior mode.
				fixture.visual.selectChangedCell({ ...result.cell, version: fixture.source().version });
				const cancel = [...fixture.toolbar.querySelectorAll('button')].find((button: any) => button.textContent === 'Cancel editing') as HTMLButtonElement;
				assert.ok(cancel); cancel.click(); fixture.sync();
				assert.deepEqual(fixture.source().toBytes(), after);
				fixture.select(1, true);
			}
			let undo = historyTransaction(fixture.state, 'undo');
			while (undo) { fixture.setState(undo.state); undo = historyTransaction(fixture.state, 'undo'); }
			assert.deepEqual(fixture.source().toBytes(), fixture.original.toBytes());
			assert.ok(typed.length >= fixture.original.toBytes().length);
		} finally { fixture.dispose(); }
	});
}

test('preamble title converts into the body without orphan maketitle or modifying other metadata', () => {
	const fixture = mount('\\documentclass{article}\r\n\\title{題目\u{20000}}\r\n\\author{作者}\r\n\\date{}\r\n\\begin{document}\r\n\\maketitle\r\n\\section{Neighbor}\r\n\\end{document}');
	try {
		fixture.select(0);
		change(fixture, 'abstract');
		assert.ok(fixture.source().read().includes('\\author{作者}\r\n\\date{}'));
		assert.doesNotMatch(fixture.source().read(), /\\maketitle|\\title\{/);
		assert.ok(fixture.source().read().indexOf('\\begin{abstract}') > fixture.source().read().indexOf('\\begin{document}'));
		assert.equal(fixture.visual.view.state.selection.$from.parent.textContent, '題目\u{20000}');
		assert.deepEqual(historyTransaction(fixture.state, 'undo')!.state.field(sourceState).projection.document.toBytes(), fixture.original.toBytes());
	} finally { fixture.dispose(); }
});

test('structure transactions reject stale/foreign selections and read-only state atomically', () => {
	const fixture = mount('\\par\n文字');
	try {
		fixture.select(0);
		const captured = fixture.visual.textStructureSelection()!;
		fixture.visual.view.dispatch(fixture.visual.view.state.tr.insertText('新'));
		const state = fixture.state;
		assert.throws(() => structureTransaction(state, captured, 'abstract'), /STALE_STRUCTURE/);
		const foreign = createSourceState(SourceDocument.open(fixture.source().toBytes()));
		assert.throws(() => structureTransaction(foreign, fixture.visual.textStructureSelection()!, 'title'), /STALE_STRUCTURE/);
		const locked = createSourceState(fixture.source(), () => assert.fail('unexpected rejection'), EditorState.readOnly.of(true));
		assert.throws(() => structureTransaction(locked, fixture.visual.textStructureSelection()!, 'abstract'), /EDITOR_READ_ONLY/);
		assert.equal(fixture.state, state);
	} finally { fixture.dispose(); }
});

test('empty null/abstract cells accept consecutive edits and stale parser projections cannot revert structure', () => {
	const fixture = mount('\\begin{document}\r\n\\null\r\n\\end{document}');
	try {
		fixture.select(0);
		const stale = parseSource(fixture.source());
		change(fixture, 'abstract');
		assert.equal(fixture.visual.view.state.doc.firstChild!.textContent, '');
		const joined = String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb);
		for (const part of ['\u{20000}', 'e\u0301', joined, 'العربية', '\u00A0\u3000']) {
			fixture.visual.view.dispatch(fixture.visual.view.state.tr.insertText(part));
			change(fixture, 'title'); change(fixture, 'abstract');
		}
		const before = fixture.source().toBytes();
		fixture.visual.sync(stale);
		assert.deepEqual(fixture.source().toBytes(), before);
		assert.equal(fixture.visual.view.state.doc.firstChild!.attrs.role, 'abstract');
		assert.equal(fixture.visual.view.state.doc.firstChild!.textContent, '\u{20000}e\u0301' + joined + 'العربية\u00A0\u3000');
		const repeated = change(fixture, 'abstract');
		assert.equal(repeated.transaction.docChanged, false, 'reselecting the current structure creates no undo entry');
		assert.deepEqual(fixture.source().toBytes(), before);
	} finally { fixture.dispose(); }
});

test('rich inline wrappers, math atoms and explicit blank lines survive structure changes and continued typing', () => {
	const inline = '\\textbf{\\textit{中\u{20000}}}\\(x^2\\)\\\\\\\\第二行';
	const fixture = mount('\\begin{document}\r\n\\section{Neighbor}\r\n\\par' + inline + '\r\n\\opaque{保留}\r\n\\end{document}');
	try {
		fixture.select(1, true);
		let appended = '';
		for (const kind of structures) {
			change(fixture, kind);
			const selected = fixture.visual.view.state.selection.$from.parent;
			assert.equal(selected.type.name, 'source_block');
			assert.equal(selected.textContent, '中\u{20000}\n\n第二行' + appended);
			assert.equal(selected.child(0).marks.length, 2);
			assert.equal(selected.child(1).type.name, 'math_inline');
			assert.equal(selected.child(1).attrs.latex, 'x^2');
			assert.ok(fixture.source().read().includes(inline));
			assert.ok(fixture.source().read().includes('\\opaque{保留}'));
			fixture.visual.view.dispatch(fixture.visual.view.state.tr.insertText('\u{1D11E}'));
			appended += '\u{1D11E}';
		}
		assert.equal(fixture.visual.view.state.doc.childCount, 3);
	} finally { fixture.dispose(); }
});

test('structure growth over the UTF-8 source limit preserves bytes, selection, dirty state and history', () => {
	const source = SourceDocument.open(new Uint8Array(sourceLimit - 8).fill(0x61));
	let rejected = 0;
	const state = createSourceState(source, () => rejected++);
	const span = { documentId: source.documentId, version: source.version, from: 0, to: source.length };
	const before = state.field(sourceState);
	assert.throws(() => structureTransaction(state, { span, contentSpan: span, name: '' }, 'abstract'), /STRUCTURE_REJECTED/);
	assert.equal(rejected, 1);
	assert.equal(state.field(sourceState), before);
	assert.equal(state.selection.main.head, 0);
	assert.equal(before.dirty, false);
	assert.equal(historyTransaction(state, 'undo'), null);
	assert.deepEqual(before.projection.document.toBytes(), source.toBytes());
});
