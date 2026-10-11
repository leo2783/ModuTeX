import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState as VisualState } from 'prosemirror-state';
import { SourceDocument, parseSource } from '@modutex/document-core';
import { createSourceState, sourceState, historyTransaction } from '../../src/features/source-editor/state.ts';
import { colorTransaction, formatTransaction } from '../../src/features/source-editor/format.ts';
import { projectVisual, prepareVisualEdit } from '../../src/features/visual-editor/schema.ts';
import { codeSource, codeAt, codeEditTransaction } from '../../src/features/code/source.ts';
import { withPackage } from '../../src/features/tables/preamble.ts';
import { equationSource } from '../../src/features/math/source.ts';
import { insertionTransaction, insertionTarget } from '../../src/features/source-editor/state.ts';

test('color plus package is one undo, preserves BOM/CRLF and typing retains color', () => {
 const bytes = new TextEncoder().encode('\ufeff\\documentclass{article}\r\n% untouched\r\n\\begin{document}\r\nAlpha word.\r\n\\end{document}\r\n');
 const original = SourceDocument.open(bytes);
 let state = createSourceState(original);
 const from = original.read().indexOf('word');
 state = state.update({ selection: { anchor: state.doc.toString().indexOf('word'), head: state.doc.toString().indexOf('word') + 4 } }).state;
 state = colorTransaction(state, parseSource(original), 'B42318').state;
 const source = state.field(sourceState).projection.document;
 assert.match(source.read(), /\\usepackage\{xcolor\}\r\n/);
 assert.match(source.read(), /\\textcolor\[HTML\]\{B42318\}\{word\}/);
 const projected = projectVisual(source, parseSource(source));
 const block = projected.document.firstChild!;
 const visual = VisualState.create({ doc: projected.document });
 const position = 1 + block.textContent.indexOf('word') + 2;
 const edit = prepareVisualEdit(source, projected, visual.tr.insertText('X', position));
 assert.ok(edit.patches.some(patch => patch.insert.includes('X')));
 assert.equal(edit.transaction.doc.firstChild!.child(1).marks[0]!.attrs.value, 'B42318');
 const restored = historyTransaction(state, 'undo')!.state.field(sourceState).projection.document;
 assert.deepEqual(restored.toBytes(), bytes);
 assert.throws(() => colorTransaction(createSourceState(original), parseSource(original), 'red;url(x)', { documentId: original.documentId, version: original.version, from, to: from + 4 }));
});

test('verbatim code is literal and unchanged editing keeps bytes; closing marker is rejected', () => {
 const code = 'const html = "<script>";\nconsole.log(1);';
 assert.throws(() => codeSource('bad\\end{verbatim}'));
 const original = SourceDocument.open(new TextEncoder().encode('\ufeff\\documentclass{article}\r\n\\begin{document}\r\n'+codeSource(code).replace(/\n/g, '\r\n')+'\r\n\\end{document}'));
 const state = createSourceState(original);
 const located = codeAt(original, parseSource(original), original.read().indexOf('\\begin{verbatim}'))!;
 assert.equal(located.draft.code, code);
 assert.equal(codeEditTransaction(state, located, { code }), null);
 const changed = codeEditTransaction(state, located, { code: 'let answer = 42;' })!.state;
 assert.match(changed.field(sourceState).projection.document.read(), /let answer = 42;/);
 assert.deepEqual(historyTransaction(changed, 'undo')!.state.field(sourceState).projection.document.toBytes(), original.toBytes());
});

test('multiline math and amsmath share one source history entry', () => {
	assert.throws(() => equationSource('\\frac{\\placeholder{}}{2}', false), /EQUATION_INCOMPLETE/);
 const original = SourceDocument.open(new TextEncoder().encode('\\documentclass{article}\n\\begin{document}\n\n\\end{document}'));
 let state = createSourceState(original);
 state = state.update({ selection: { anchor: state.doc.toString().indexOf('\\end{document}') } }).state;
 const inserted = insertionTransaction(state, insertionTarget(state), '\\[\\begin{aligned}a&=b\\\\c&=d\\end{aligned}\\]');
	state = withPackage(state, inserted, ['amsmath', 'amssymb']).state;
 assert.match(state.doc.toString(), /usepackage\{amsmath\}/);
	assert.match(state.doc.toString(), /usepackage\{amssymb\}/);
 assert.deepEqual(historyTransaction(state, 'undo')!.state.field(sourceState).projection.document.toBytes(), original.toBytes());
});
