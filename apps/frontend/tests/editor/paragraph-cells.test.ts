import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceDocument, parseSource } from '../../src/features/document-core/core.ts';
import { projectVisual } from '../../src/features/visual-editor/schema.ts';
import { createSourceState, sourceState, paragraphInsertionTransaction, historyTransaction } from '../../src/features/source-editor/state.ts';

test('paragraph source whitespace never becomes visual blank lines and repeated insertions add one cell', () => {
	for (const eol of ['\n','\r\n'] as const) {
		const original = SourceDocument.open(new TextEncoder().encode('\ufeff\\begin{document}' + eol + '\\par\\textbf{Text}' + '\\\\'.repeat(8) + eol + '\\end{document}'));
		let state = createSourceState(original);
		for (let index = 0; index < 4; index++) {
			const source = state.field(sourceState).projection.document;
			const projection = projectVisual(source,parseSource(source));
			const last = projection.document.lastChild!;
			const from = index === 2 ? last.attrs.from : last.attrs.to;
			const result = paragraphInsertionTransaction(state,{documentId:source.documentId,version:source.version,from,to:from},false);
			state = result.transaction.state;
			const next = state.field(sourceState).projection.document;
			const updated = projectVisual(next,parseSource(next));
			assert.equal(updated.document.childCount,projection.document.childCount + 1);
			const inserted = updated.document.content.content.find(node => node.attrs.from === result.paragraph.from)!;
			assert(inserted); assert.equal(inserted.textContent,'');
			assert.equal(inserted.attrs.editFrom,inserted.attrs.editTo);
			assert(next.read().includes('\\textbf{Text}' + '\\\\'.repeat(8)), 'existing deliberate blank lines must remain unchanged');
		}
		for (let index = 0; index < 4; index++) state = historyTransaction(state,'undo')!.state;
		assert.deepEqual(state.field(sourceState).projection.document.toBytes(),original.toBytes());
	}
});

test('empty paragraphs with any source separator whitespace project to one empty cell each', () => {
	const source = SourceDocument.open(new TextEncoder().encode('\\begin{document}\n\\par\n\n\t\n\\par\r\n\r\n\\end{document}'));
	const projection = projectVisual(source,parseSource(source));
	assert.equal(projection.document.childCount,2);
	projection.document.forEach(node => assert.equal(node.textContent,''));
});
