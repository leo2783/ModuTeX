// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { schema } from '$lib/schema/schema';
import { createTableNode } from '$lib/editor/utils/tableUtils';
import {
	publishTableSelection,
	selectedTableWrapperPosition,
	subscribeTableSelection
} from '$lib/editor/extensions/table/tableSelectionContext';

function createDoc() {
	const table = createTableNode(schema, 2, 2, true, 'three-line');
	const outside = schema.nodes.paragraph.create(null, schema.text('outside'));
	const doc = schema.nodes.doc.create(null, [table, outside]);
	let cellPos = -1;
	let outsidePos = -1;
	doc.descendants((node, pos) => {
		if (node.type.name === 'table_header' && cellPos === -1) cellPos = pos;
		if (node.type.name === 'paragraph' && node.textContent === 'outside') outsidePos = pos;
	});
	return { doc, cellPos, outsidePos, tablePos: 0 };
}

describe('selection-aware table tools', () => {
	it('identifies only a selection contained in one table wrapper', () => {
		const { doc, cellPos, outsidePos, tablePos } = createDoc();
		const inside = EditorState.create({ schema, doc, selection: TextSelection.create(doc, cellPos + 2) });
		const outside = EditorState.create({ schema, doc, selection: TextSelection.create(doc, outsidePos + 2) });
		const wholeWrapper = EditorState.create({ schema, doc, selection: NodeSelection.create(doc, tablePos) });

		expect(selectedTableWrapperPosition(inside)).toBe(tablePos);
		expect(selectedTableWrapperPosition(outside)).toBeNull();
		expect(selectedTableWrapperPosition(wholeWrapper)).toBe(tablePos);
	});

	it('opens and closes the panel from editor selection transactions, not focus events', () => {
		const { doc, cellPos, outsidePos, tablePos } = createDoc();
		const host = document.body.appendChild(document.createElement('div'));
		const view = new EditorView(host, {
			state: EditorState.create({ schema, doc, selection: TextSelection.create(doc, outsidePos + 2) })
		});
		const states: boolean[] = [];
		const unsubscribe = subscribeTableSelection(
			view,
			() => tablePos,
			(selected) => states.push(selected)
		);

		try {
			expect(states).toEqual([]);
			view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, cellPos + 2)));
			publishTableSelection(view);
			expect(states).toEqual([true]);
			view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, outsidePos + 2)));
			publishTableSelection(view);
			expect(states).toEqual([true, false]);
		} finally {
			unsubscribe();
			view.destroy();
			host.remove();
		}
	});
});
