import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceDocument, parseSource } from '../../src/features/document-core/core.ts';
import { colorTransaction, formatTransaction } from '../../src/features/source-editor/format.ts';
import { createSourceState, historyTransaction, sourceState } from '../../src/features/source-editor/state.ts';

const original = '\uFEFF\\documentclass{article}\r\n\\usepackage{xcolor}\n\\begin{document}\r\n\\begin{abstract}\r\n\\textcolor[HTML]{FF0000}{\\textbf{\\underline{混合 Mixed}}}\r\n\\end{abstract}\n\\par Outside text\r\n\\end{document}\n';
function selected(text = original, needle = '混合 Mixed') {
 const source = SourceDocument.open(new TextEncoder().encode(text));
 let state = createSourceState(source);
 const at = state.doc.toString().indexOf(needle); assert.ok(at >= 0);
 state = state.update({ selection: { anchor: at, head: at + needle.length } }).state;
 return state;
}
for (const [format, expected] of [['strong', original.replace('\\textbf{\\underline{混合 Mixed}}', '\\underline{混合 Mixed}')], ['underline', original.replace('\\underline{混合 Mixed}', '混合 Mixed')]] as const) {
 test(`abstract ${format} cancellation preserves delimiters, BOM, mixed EOL and exact shared history`, () => {
  let state = selected();
  state = formatTransaction(state, parseSource(state.field(sourceState).projection.document), format).state;
  assert.deepEqual(state.field(sourceState).projection.document.toBytes(), new TextEncoder().encode(expected));
  state = historyTransaction(state, 'undo')!.state;
  assert.deepEqual(state.field(sourceState).projection.document.toBytes(), new TextEncoder().encode(original));
  state = historyTransaction(state, 'redo')!.state;
  assert.deepEqual(state.field(sourceState).projection.document.toBytes(), new TextEncoder().encode(expected));
 });
}
test('abstract color changes operate on decoded text without replacing the environment', () => {
 const state = selected(), source = state.field(sourceState).projection.document;
 const next = colorTransaction(state, parseSource(source), 'B42318').state;
 assert.deepEqual(next.field(sourceState).projection.document.toBytes(), new TextEncoder().encode(original.replace('混合 Mixed', '\\textcolor[HTML]{B42318}{混合 Mixed}')));
 assert.deepEqual(historyTransaction(next, 'undo')!.state.field(sourceState).projection.document.toBytes(), new TextEncoder().encode(original));
});
test('abstract support retains opaque-command and cross-environment selection guards', () => {
 const opaque = original.replace('混合 Mixed', '\\opaque{混合 Mixed}');
 let state = selected(opaque);
 assert.throws(() => formatTransaction(state, parseSource(state.field(sourceState).projection.document), 'strong'));
 state = selected();
 const at = state.selection.main.from, end = state.doc.toString().indexOf('Outside text') + 'Outside text'.length;
 state = state.update({ selection: { anchor: at, head: end } }).state;
 assert.throws(() => colorTransaction(state, parseSource(state.field(sourceState).projection.document), 'B42318'));
});
