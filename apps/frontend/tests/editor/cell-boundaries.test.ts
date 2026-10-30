import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceDocument, parseSource } from '../../src/features/document-core/core.ts';
import { projectVisual } from '../../src/features/visual-editor/schema.ts';
import { CELL_BEGIN, CELL_END } from '../../src/features/visual-editor/cell-boundaries.ts';
import { cellMoveTransaction } from '../../src/features/source-editor/cell-move.ts';
import { createSourceState, historyTransaction, sourceState } from '../../src/features/source-editor/state.ts';

for (const eol of ['\n', '\r\n']) {
	test(`explicit cell boundaries retain unrelated cells through movement and exact undo (${JSON.stringify(eol)})`, () => {
		const source = SourceDocument.open(new TextEncoder().encode('\ufeff' + ['\\begin{document}', 'First', CELL_BEGIN, '\\section{Heading}', '\\par Body', CELL_END, '\\end{document}'].join(eol)));
		const projection = projectVisual(source, parseSource(source));
		const group = projection.cellBounds!.find(Boolean)!;
		assert.equal(group.last - group.first, 1);
		const cells = [{ documentId: source.documentId, version: source.version, from: projection.document.firstChild!.attrs.from, to: projection.document.firstChild!.attrs.to }, { documentId: source.documentId, version: source.version, from: group.from, to: group.to }];
		const state = createSourceState(source), moved = cellMoveTransaction(state, cells, 0, 2)!.state;
		const next = moved.field(sourceState).projection.document;
		assert.match(next.read(), /\\par\s+First/, 'text moved after a cell ending in body text retains its paragraph fence');
		const reloaded = projectVisual(next, parseSource(next));
		assert.equal(reloaded.document.childCount, 3);
		assert.equal(reloaded.document.lastChild!.textContent, 'First');
		assert.deepEqual(historyTransaction(moved, 'undo')!.state.field(sourceState).projection.document.toBytes(), source.toBytes());
	});
}

test('unbalanced or nested marker comments remain visible source instead of silently grouping content', () => {
	for (const text of [`${CELL_BEGIN}\n\\section{Heading}`, `${CELL_END}\n\\section{Heading}`, `${CELL_BEGIN}\n${CELL_BEGIN}\n\\section{Heading}\n${CELL_END}\n${CELL_END}`]) {
		const source = SourceDocument.open(new TextEncoder().encode(`\\begin{document}\n${text}\n\\end{document}`));
		const projection = projectVisual(source, parseSource(source));
		assert.equal(projection.cellBounds!.some(Boolean), false);
		assert.ok(projection.document.content.content.some(node => node.type.name === 'raw_block' && node.attrs.source.includes('ModuTeX cell')));
	}
});
