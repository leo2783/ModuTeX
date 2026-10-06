// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { typstToProseMirror } from '$lib/typst/visual/converter';
import { typSchema } from '$lib/typst/visual/schema';
import { serializeToTypst } from '$lib/typst/visual/serializer';
import { changeTableStructure, supportsTableStructure } from '$lib/editor/comp/toolbar/table-preset-commands';
import { mdSchema } from '$lib/markdown/schema';
import { mdTableNode } from '$lib/markdown/blockInsertItems';
import { serializeToMarkdown } from '$lib/markdown/serializer';
import type { Node as PMNode } from 'prosemirror-model';

function mountTable(doc: PMNode, schema = typSchema, selectedCell = 0) {
	const cellPositions: number[] = [];
	doc.descendants((node, pos) => {
		if (node.type.name === 'table_header' || node.type.name === 'table_cell') cellPositions.push(pos);
	});
	const host = document.body.appendChild(document.createElement('div'));
	const view = new EditorView(host, {
		state: EditorState.create({
			schema,
			doc,
			selection: TextSelection.create(doc, cellPositions[selectedCell] + 2)
		})
	});
	return { view, host };
}

function typstTable(source: string): { doc: PMNode; table: PMNode } {
	const doc = typstToProseMirror(source).doc;
	const table = doc.firstChild;
	if (!table || table.type.name !== 'table') throw new Error('Expected a parsed Typst table');
	return { doc, table };
}

function width(table: PMNode): number {
	let columns = 0;
	table.child(0).forEach((cell) => (columns += Number(cell.attrs.colspan ?? 1)));
	return columns;
}

describe('Typst table structure edits', () => {
	it('adds rows without replacing Typst track sizing or writing TeX layout attributes', () => {
		const { doc, table } = typstTable('#table(columns: (auto, 1fr), align: (left, right), table.header([A], [B]), [C], [D])');
		const { view, host } = mountTable(doc);
		try {
			expect(supportsTableStructure(table, 'typst')).toBe(true);
			expect(changeTableStructure(view, 'row-after', undefined, 'typst')).toBe(true);

			const updated = view.state.doc.firstChild!;
			expect(updated.childCount).toBe(3);
			expect(updated.attrs).toEqual(table.attrs);
			expect(updated.attrs).toMatchObject({ env: null, colspec: '(auto, 1fr)', typAlign: '(left, right)' });
			expect(serializeToTypst(view.state.doc)).toContain('columns: (auto, 1fr),');
			expect(serializeToTypst(view.state.doc)).toContain('align: (left, right),');
		} finally {
			view.destroy();
			host.remove();
		}
	});

	it('adds columns to merged Typst cells and carries forward native track sizing/alignment', () => {
		const { table: parsed } = typstTable('#table(columns: (auto, 1fr), align: (left, right), [A], [B], [C], [D])');
		const firstRow = parsed.child(0);
		const leftCell = firstRow.child(0);
		const mergedCell = leftCell.type.create({ ...leftCell.attrs, colspan: 2 }, leftCell.content);
		const mergedRow = firstRow.type.create(firstRow.attrs, [mergedCell]);
		const mergedTable = parsed.type.create(parsed.attrs, [mergedRow, parsed.child(1)]);
		const doc = typSchema.nodes.doc.create(null, [mergedTable]);
		const { view, host } = mountTable(doc);
		try {
			expect(mergedTable.attrs.env).toBeNull();
			expect(supportsTableStructure(mergedTable, 'typst')).toBe(true);
			expect(changeTableStructure(view, 'column-after', undefined, 'typst')).toBe(true);

			const updated = view.state.doc.firstChild!;
			expect(width(updated)).toBe(3);
			expect(updated.attrs).toMatchObject({
				env: null,
				colspec: '(auto, 1fr, 1fr)',
				typAlign: '(left, right, right)'
			});
			const serialized = serializeToTypst(view.state.doc);
			expect(serialized).toContain('columns: (auto, 1fr, 1fr),');
			expect(serialized).toContain('align: (left, right, right),');
		} finally {
			view.destroy();
			host.remove();
		}
	});

	it('refuses a Typst column edit when its custom track expression cannot be copied safely', () => {
		const { doc } = typstTable('#table(columns: (auto, 1fr), [A], [B])');
		const original = doc.firstChild!;
		const custom = original.type.create({ ...original.attrs, colspec: '(auto, calc(1fr))' }, original.content);
		const { view, host } = mountTable(typSchema.nodes.doc.create(null, [custom]));
		try {
			expect(changeTableStructure(view, 'column-after', undefined, 'typst')).toBe(false);
			expect(view.state.doc.firstChild).toBe(custom);
		} finally {
			view.destroy();
			host.remove();
		}
	});

	it('does not turn a Typst table without a header into a header when inserting a row', () => {
		const { doc, table } = typstTable('#table(columns: 2, [A], [B])');
		const { view, host } = mountTable(doc);
		try {
			expect(changeTableStructure(view, 'row-before', undefined, 'typst')).toBe(true);
			const updated = view.state.doc.firstChild!;
			expect(updated.child(0).child(0).type.name).toBe('table_cell');
			expect(updated.attrs).toEqual(table.attrs);
			expect(serializeToTypst(view.state.doc)).not.toContain('table.header(');
		} finally {
			view.destroy();
			host.remove();
		}
	});

	it('keeps native Markdown table attrs through row and column edits', () => {
		const table = mdTableNode(mdSchema);
		const doc = mdSchema.nodes.doc.create(null, [table]);
		const { view, host } = mountTable(doc, mdSchema);
		try {
			expect(changeTableStructure(view, 'row-after', undefined, 'markdown')).toBe(true);
			expect(changeTableStructure(view, 'column-after', undefined, 'markdown')).toBe(true);

			const updated = view.state.doc.firstChild!;
			expect(updated.attrs).toEqual(table.attrs);
			expect(updated.attrs).toMatchObject({ env: null, colspec: null, tabularxWidth: null, bottomRules: '' });
			expect(updated.childCount).toBe(4);
			expect(width(updated)).toBe(3);
			expect(serializeToMarkdown(view.state.doc)).toContain('|  |  |  |');
		} finally {
			view.destroy();
			host.remove();
		}
	});
});
