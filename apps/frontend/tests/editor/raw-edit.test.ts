import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { SourceDocument, parseSource, type SourceSpan } from '@modutex/document-core';
import { VisualEditor } from '../../src/features/visual-editor/view.ts';
import { rawEditTransaction } from '../../src/features/source-editor/raw.ts';
import { createSourceState, sourceState, sourcePatchTransaction, historyTransaction } from '../../src/features/source-editor/state.ts';
const { JSDOM } = createRequire(import.meta.url)('jsdom');
const bytes = (text: string) => new TextEncoder().encode(text);
function span(source: SourceDocument, expected: string): SourceSpan {
	const from = source.read(0, source.length).indexOf(expected);
	assert.ok(from >= 0);
	return { documentId: source.documentId, version: source.version, from, to: from + expected.length };
}
test('explicit Raw replacement and deletion preserve surrounding BOM/mixed EOL and share exact CM undo/redo', () => {
	const expected = '\\opaque{keep}', originalText = '\uFEFFplain\r\n' + expected + '\rtail\n';
	for (const replacement of ['\\unknown{雪%😀}', '']) {
		const original = SourceDocument.open(bytes(originalText));
		let editor = createSourceState(original);
		const captured = span(original, expected);
		assert.equal(rawEditTransaction(editor, captured, expected, expected), null);
		assert.equal(editor.field(sourceState).dirty, false);
		assert.equal(historyTransaction(editor, 'undo'), null);
		const transaction = rawEditTransaction(editor, captured, expected, replacement);
		assert.ok(transaction); editor = transaction.state;
		const changed = originalText.replace(expected, replacement);
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), bytes(changed));
		assert.equal(editor.field(sourceState).dirty, true);
		const undo = historyTransaction(editor, 'undo'); assert.ok(undo); editor = undo.state;
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
		assert.equal(editor.field(sourceState).dirty, false);
		const redo = historyTransaction(editor, 'redo'); assert.ok(redo); editor = redo.state;
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), bytes(changed));
	}
});
test('Raw textarea LF normalization of unchanged CRLF source is a no-op without dirty/history', () => {
	const expected = '\\opaque{first\r\nsecond}', original = SourceDocument.open(bytes('\uFEFFbefore\r\n' + expected + '\rafter\n'));
	const editor = createSourceState(original), captured = span(original, expected);
	assert.equal(rawEditTransaction(editor, captured, expected, expected.replaceAll('\r\n', '\n')), null);
	assert.equal(editor.field(sourceState).dirty, false);
	assert.equal(historyTransaction(editor, 'undo'), null);
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
});
test('Raw edit rejects stale/foreign authority, tampered expected and NUL without changing source/history', () => {
	const original = SourceDocument.open(bytes('\uFEFFleft\r\n\\opaque{keep}\ntail'));
	const editor = createSourceState(original), expected = '\\opaque{keep}', captured = span(original, expected);
	assert.throws(() => rawEditTransaction(editor, captured, 'tampered', 'x'), /STALE_RAW/);
	assert.throws(() => rawEditTransaction(editor, captured, expected, '\0'), /RAW_SOURCE/);
	const foreign = createSourceState(SourceDocument.open(original.toBytes()));
	assert.throws(() => rawEditTransaction(foreign, captured, expected, 'x'), /STALE_INSERTION/);
	const changed = sourcePatchTransaction(editor, original, [{ from: 1, to: 1, expected: '', insert: 'new ' }]).state;
	assert.throws(() => rawEditTransaction(changed, captured, expected, 'x'), /STALE_INSERTION/);
	assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
	assert.equal(editor.field(sourceState).dirty, false);
	assert.equal(historyTransaction(editor, 'undo'), null);
});
test('real Raw DOM exposes literal source, reanchors button spans and revokes read-only/stale/destroyed authority', { timeout: 5000 }, () => {
	const dom = new JSDOM('<!doctype html><body><div id="target"></div></body>', { pretendToBeVisual: true });
	const saved = new Map<string, PropertyDescriptor | undefined>();
	for (const key of ['window', 'document', 'navigator', 'MutationObserver', 'Node', 'HTMLElement', 'getComputedStyle']) {
		saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'getComputedStyle' ? dom.window.getComputedStyle.bind(dom.window) : dom.window[key] });
	}
	const expected = '\\opaque{<img src=x onerror="globalThis.rawExecuted=true"><script>globalThis.rawExecuted=true</script>}';
	const original = SourceDocument.open(bytes('\uFEFFplain\r\n' + expected + '\rtail\n'));
	let editor = createSourceState(original), readonly = false, rejected = 0;
	const actions: { source: string; span: SourceSpan }[] = [];
	const target = dom.window.document.getElementById('target');
	const view = new VisualEditor(target, 'raw.tex', {
		source: () => editor.field(sourceState).projection.document,
		apply: (identity, patches) => { editor = sourcePatchTransaction(editor, identity, patches).state; return editor.field(sourceState).projection.document; },
		history: () => false, readOnly: () => readonly, rejected: () => rejected++, status: () => {},
		raw: (source, span) => actions.push({ source, span })
	});
	try {
		view.sync(parseSource(original));
		const code = target.querySelector('pre.raw-latex'); assert.ok(code); assert.equal(code.textContent, expected);
		assert.equal(target.querySelectorAll('img,script').length, 0);
		const initial = target.querySelector('.visual-raw button'); assert.ok(initial); initial.click();
		assert.equal(actions.length, 1); assert.equal(actions[0]!.source, expected);
		assert.equal(original.read(actions[0]!.span.from, actions[0]!.span.to), expected);
		readonly = true; view.refresh(); assert.equal(initial.disabled, true); initial.click(); assert.equal(actions.length, 1);
		readonly = false; view.refresh();
		let position = -1;
		view.view.state.doc.forEach((node, offset) => { if (node.type.name === 'source_block' && node.textContent.includes('plain')) position = offset + 1; });
		assert.ok(position >= 0); view.view.dispatch(view.view.state.tr.insertText('雪', position));
		const relocated = target.querySelector('.visual-raw button'); assert.ok(relocated); relocated.click();
		assert.equal(actions.length, 2); assert.equal(actions[1]!.span.from, actions[0]!.span.from + 1);
		const edit = rawEditTransaction(editor, actions[1]!.span, expected, '\\other{edited}'); assert.ok(edit); editor = edit.state;
		view.refresh(); assert.equal(relocated.disabled, true); relocated.click(); assert.equal(actions.length, 2);
		assert.throws(() => rawEditTransaction(editor, actions[1]!.span, expected, 'late'), /STALE_INSERTION/);
		view.sync(parseSource(editor.field(sourceState).projection.document));
		const fresh = target.querySelector('.visual-raw button'); assert.ok(fresh); fresh.click(); assert.equal(actions.length, 3);
		assert.equal(actions[2]!.source, '\\other{edited}');
		const undo = historyTransaction(editor, 'undo'); assert.ok(undo); editor = undo.state;
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), bytes('\uFEFF雪plain\r\n' + expected + '\rtail\n'));
		const restore = historyTransaction(editor, 'undo'); assert.ok(restore); editor = restore.state;
		assert.deepEqual(editor.field(sourceState).projection.document.toBytes(), original.toBytes());
		view.dispose(); initial.click(); relocated.click(); fresh.click(); assert.equal(actions.length, 3);
		assert.equal(rejected, 0); assert.equal(target.children.length, 0);
	} finally {
		view.dispose(); dom.window.close();
		for (const [key, descriptor] of saved) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
	}
});
