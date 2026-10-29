import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceDocument, parseSource, type SourceSpan } from '../../src/features/document-core/core.ts';
import { createSourceState, sourceState, historyTransaction, metadataClearTransaction } from '../../src/features/source-editor/state.ts';
import { projectVisual } from '../../src/features/visual-editor/schema.ts';
import { cellMoveTransaction } from '../../src/features/source-editor/cell-move.ts';

for (const eol of ['\n', '\r\n']) for (const command of ['section', 'subsection', 'subsubsection']) {
	test(`moving ${command} preserves cell count, heading wrappers and exact undo (${JSON.stringify(eol)})`, () => {
		const source = SourceDocument.open(new TextEncoder().encode('\ufeff' + ['\\begin{document}', 'First', `\\${command}{\\textbf{我葳 English}}`, '\\par Last', '\\end{document}'].join(eol)));
		const state = createSourceState(source), projected = projectVisual(source, parseSource(source)).document;
		const cells: SourceSpan[] = [];
		projected.forEach(node => cells.push({ documentId: source.documentId, version: source.version, from: node.attrs.from, to: node.attrs.to }));
		for (const [index, boundary] of [[1, 0], [1, 3], [0, 2], [2, 1]]) {
			const changed = cellMoveTransaction(state, cells, index!, boundary!)!.state;
			const next = changed.field(sourceState).projection.document;
			const document = projectVisual(next, parseSource(next)).document;
			assert.equal(document.childCount, projected.childCount);
			const headings: string[] = []; document.forEach(node => { if (node.attrs.role === 'heading') headings.push(node.textContent); });
			assert.deepEqual(headings, ['我葳 English']);
			assert.deepEqual(historyTransaction(changed, 'undo')!.state.field(sourceState).projection.document.toBytes(), source.toBytes());
		}
	});
}

test('arbitrary notebook moves retain each paragraph, unknown syntax and exact-byte undo', () => {
	const source = SourceDocument.open(new TextEncoder().encode('\uFEFF\\documentclass{article}\r\n\\begin{document}\r\nFirst\r\n\\par Second\n\\[x^2\\]\r\n\\unknown{keep}\n\\par Third\r\n\\end{document}\r\n'));
	let state = createSourceState(source);
	const doc = projectVisual(source, parseSource(source)).document;
	const cells: SourceSpan[] = []; doc.forEach(node => cells.push({ documentId: source.documentId, version: source.version, from: node.attrs.from, to: node.attrs.to }));
	const transaction = cellMoveTransaction(state, cells, 0, cells.length)!; state = state.update(transaction).state;
	const next = state.field(sourceState).projection.document;
	const nextDoc = projectVisual(next, parseSource(next)).document;
	assert.equal(nextDoc.childCount, doc.childCount);
	assert.match(next.read(), /\\unknown\{keep\}/);
	assert.ok(next.read().indexOf('Second') < next.read().indexOf('First'));
	assert.equal(nextDoc.lastChild!.textContent.trim(), 'First');
	assert.throws(() => cellMoveTransaction(state, cells, 1, 0), /STALE/);
	state = state.update(historyTransaction(state, 'undo')!).state;
	assert.deepEqual(state.field(sourceState).projection.document.toBytes(), source.toBytes());
});

test('unchanged drop boundaries do not enter shared history', () => {
	const source = SourceDocument.open(new TextEncoder().encode('\\begin{document}A\\par B\\end{document}'));
	const state = createSourceState(source), doc = projectVisual(source, parseSource(source)).document;
	const cells: SourceSpan[] = []; doc.forEach(node => cells.push({ documentId: source.documentId, version: source.version, from: node.attrs.from, to: node.attrs.to }));
	assert.equal(cellMoveTransaction(state, cells, 0, 0), null);
	assert.equal(cellMoveTransaction(state, cells, 0, 1), null);
});

for (const eol of ['\n', '\r\n']) {
 test(`moving a partial-derivative matrix preserves title metadata and every body cell (${JSON.stringify(eol)})`, () => {
  const preamble = ['\\documentclass{article}', '\\usepackage{amsmath}', '\\title{A title}', '\\author{\\(\\frac{\\partial x}{\\partial x}\\)}', '\\date{}', '\\begin{document}', '\\maketitle', ''].join(eol);
  const matrix = '\\[\\begin{pmatrix}2 & \\frac{\\partial^2 f}{\\partial x^2} & 52\\\\ 2 & 5 & 6666\\\\ 5 & 8 & 88\\end{pmatrix}\\]';
  const text = preamble + ['First paragraph.', matrix, '\\par Last paragraph.', '\\end{document}', ''].join(eol);
  const source = SourceDocument.open(new TextEncoder().encode(text));
  const state = createSourceState(source), projection = projectVisual(source, parseSource(source)).document;
  const cells: SourceSpan[] = [];
  projection.forEach(node => cells.push({documentId:source.documentId,version:source.version,from:node.attrs.from,to:node.attrs.to}));
  const index = cells.findIndex(span => source.read(span.from, span.to) === matrix);
  assert(index >= 0);
  const changed = cellMoveTransaction(state, cells, index, cells.length)!.state;
  const updated = changed.field(sourceState).projection.document.read();
  assert.equal(updated.slice(0, preamble.length), preamble);
  assert.equal(updated.split(matrix).length - 1, 1);
  assert(updated.includes('First paragraph.'));
  assert(updated.indexOf(matrix) > updated.indexOf('Last paragraph.'));
  assert.deepEqual(historyTransaction(changed, 'undo')!.state.field(sourceState).projection.document.toBytes(), source.toBytes());
 });
}

test('moving a body formula across title metadata cannot move the document envelope', () => {
 const text = '\\documentclass{article}\n\\title{Keep title}\n\\author{}\n\\date{}\n\\begin{document}\n\\maketitle\nFirst.\n\\[\\frac{\\partial f}{\\partial x}\\]\n\\end{document}\n';
 const source = SourceDocument.open(new TextEncoder().encode(text));
 const state = createSourceState(source), projected = projectVisual(source, parseSource(source)).document;
 const cells: SourceSpan[] = [];
 projected.forEach(node => cells.push({documentId:source.documentId,version:source.version,from:node.attrs.from,to:node.attrs.to}));
 const index = cells.findIndex(span => source.read(span.from, span.to).includes('\\frac'));
 assert(index >= 0);
 let transaction;
 try { transaction = cellMoveTransaction(state, cells, index, 0); }
 catch (error) { assert.match(String(error), /CELL|METADATA|BODY/); }
 if (!transaction) { assert.deepEqual(state.field(sourceState).projection.document.toBytes(), source.toBytes()); return; }
 const updated = transaction.state.field(sourceState).projection.document.read();
 assert.equal(updated.slice(0, updated.indexOf('\\maketitle') + 10), text.slice(0, text.indexOf('\\maketitle') + 10));
 assert(updated.indexOf('\\frac') > updated.indexOf('\\begin{document}'));
 assert(updated.includes('\\date{}'));
});

for (const date of ['', 'A chosen date']) {
 test(`clearing date metadata retains its explicit directive (${JSON.stringify(date)})`, () => {
  const text = '\\documentclass{article}\r\n\\title{Keep}\\author{}\\date{' + date + '}\r\n\\begin{document}\\maketitle Body.\\end{document}';
  const source = SourceDocument.open(new TextEncoder().encode('\ufeff' + text)), state = createSourceState(source);
  const node = parseSource(source).nodes.find(node => node.name === 'date'); assert(node);
  const cleared = metadataClearTransaction(state, node.span);
  assert.equal(cleared.value, date);
  if (!date) { assert.equal(cleared.transaction, null); assert.deepEqual(state.field(sourceState).projection.document.toBytes(), source.toBytes()); return; }
  assert(cleared.transaction);
  const next = cleared.transaction.state;
  assert.equal(next.field(sourceState).projection.document.read(), text.replace('\\date{' + date + '}', '\\date{}'));
  assert.deepEqual(historyTransaction(next, 'undo')!.state.field(sourceState).projection.document.toBytes(), source.toBytes());
  assert.throws(() => metadataClearTransaction(next, node.span), /STALE/);
 });
}
