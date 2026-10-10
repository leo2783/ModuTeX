import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Compartment, EditorState } from '@codemirror/state';
import { SourceDocument, parseSource } from '@modutex/document-core';
import { sourceOutline } from '../../src/features/source-editor/outline.ts';
import { createSourceState, sourceState, sourceNavigationTransaction, historyTransaction } from '../../src/features/source-editor/state.ts';

test('outline uses current parser spans, preserves hierarchy/order and ignores comments/literal bodies', () => {
	const source = SourceDocument.open(new TextEncoder().encode('\\title{Preamble}\n\\begin{document}\n% \\section{Comment}\n\\section*{First}\r\n\\subsection{Second}\n\\begin{verbatim}\n\\section{Literal}\n\\end{verbatim}\n\\subsubsection{Third}\n\\end{document}'));
	const projection = parseSource(source), entries = sourceOutline(source, projection);
	assert.deepEqual(entries.map(({ label, level }) => ({ label, level })), [{ label: 'First', level: 0 }, { label: 'Second', level: 1 }, { label: 'Third', level: 2 }]);
	for (const entry of entries) { assert.equal(entry.span.version, source.version); assert.match(source.read(entry.span.from, entry.span.to), /^\\(?:sub)*section/); }
	const changed = source.apply({ expectedVersion: source.version, patches: [{ from: 0, to: 0, insert: '% prefix\n' }] }).document;
	assert.throws(() => sourceOutline(changed, projection), /STALE_OUTLINE/);
	assert.throws(() => sourceOutline(SourceDocument.open(source.toBytes()), projection), /STALE_OUTLINE/);
});

test('bounded outline title preview does not split Unicode scalars or interpret HTML', () => {
	const source = SourceDocument.open(new TextEncoder().encode('\\section{' + 'a'.repeat(159) + '😀 <script>literal</script>}\n\\section{<img src=x>}'));
	const entries = sourceOutline(source, parseSource(source));
	assert.equal(entries[0]!.label, 'a'.repeat(159) + '…');
	assert.equal(entries[1]!.label, '<img src=x>');
});

test('real CodeMirror outline navigation preserves bytes/checkpoint/history and rejects stale/readonly spans', () => {
	const source = SourceDocument.open(new TextEncoder().encode('\uFEFF% keep\r\n\\section{One}\ntext\r\\section{Two}\r\n'));
	const entries = sourceOutline(source, parseSource(source)), permission = new Compartment();
	let state = createSourceState(source, undefined, permission.of(EditorState.readOnly.of(false)));
	const originalState = state.field(sourceState);
	state = sourceNavigationTransaction(state, entries[1]!.span).state;
	assert.equal(state.field(sourceState), originalState);
	assert.equal(state.doc.sliceString(state.selection.main.head, state.selection.main.head + 13), '\\section{Two}');
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), source.toBytes());
	assert.equal(historyTransaction(state, 'undo'), null);
	state = state.update({ changes: { from: 0, to: 0, insert: 'new\n' } }).state;
	assert.throws(() => sourceNavigationTransaction(state, entries[1]!.span), /STALE/);
	state = historyTransaction(state, 'undo')!.state;
	const current = state.field(sourceState).projection.document;
	const fresh = sourceOutline(current, parseSource(current))[1]!;
	state = state.update({ effects: permission.reconfigure(EditorState.readOnly.of(true)) }).state;
	assert.throws(() => sourceNavigationTransaction(state, fresh.span), /EDITOR_READ_ONLY/);
});
