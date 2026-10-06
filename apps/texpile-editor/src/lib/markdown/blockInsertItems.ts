// Insert-menu entries for the markdown block handle (the + / drag / delete gutter): only
// constructs mdSchema can hold, only markdown vocabulary. Same BlockInsertItem contract as the
// LaTeX list, so the shared BlockHandle renders either.
import type { Schema, Node as PMNode } from 'prosemirror-model';
import {
	Type,
	Heading1,
	Heading2,
	Heading3,
	List,
	ListOrdered,
	ListChecks,
	Quote,
	Table as TableIcon,
	SquareRadical,
	Code,
	Minus
} from '@lucide/svelte';
import type { BlockInsertItem } from '$lib/editor/extensions/blockInsertItems';
import { m } from '$lib/paraglide/messages';

/** GFM tables need a header row: 1 header + 2 body rows, 2 columns. */
export function mdTableNode(schema: Schema): PMNode {
	const p = () => schema.nodes.paragraph.createAndFill()!;
	const cell = (type: 'table_header' | 'table_cell') => schema.nodes[type].createAndFill(null, p())!;
	const row = (type: 'table_header' | 'table_cell') => schema.nodes.table_row.create(null, [cell(type), cell(type)]);
	return schema.nodes.table.create(null, [row('table_header'), row('table_cell'), row('table_cell')]);
}

const listItem = (schema: Schema, kind: 'bullet' | 'ordered' | 'task') =>
	schema.nodes.list.create(
		{ kind, order: kind === 'ordered' ? 1 : null, checked: kind === 'task' ? false : null, collapsed: false },
		schema.nodes.paragraph.create()
	);

export const MD_BLOCK_INSERT_ITEMS: BlockInsertItem[] = [
	{ label: () => m.blockmenu_text(), icon: Type, make: (s) => s.nodes.paragraph.create(), select: 'in' },
	{ label: () => m.mdtoolbar_heading_n({ n: 1 }), icon: Heading1, make: (s) => s.nodes.heading.create({ level: 1 }), select: 'in' },
	{ label: () => m.mdtoolbar_heading_n({ n: 2 }), icon: Heading2, make: (s) => s.nodes.heading.create({ level: 2 }), select: 'in' },
	{ label: () => m.mdtoolbar_heading_n({ n: 3 }), icon: Heading3, make: (s) => s.nodes.heading.create({ level: 3 }), select: 'in' },
	{ label: () => m.blockmenu_bullet_list(), icon: List, make: (s) => listItem(s, 'bullet'), select: 'in' },
	{ label: () => m.blockmenu_numbered_list(), icon: ListOrdered, make: (s) => listItem(s, 'ordered'), select: 'in' },
	{ label: () => m.mdtoolbar_task_list(), icon: ListChecks, make: (s) => listItem(s, 'task'), select: 'in' },
	{
		label: () => m.blockmenu_quote(),
		icon: Quote,
		make: (s) => s.nodes.blockquote.create(null, s.nodes.paragraph.create()),
		select: 'in'
	},
	{ label: () => m.blockmenu_table(), icon: TableIcon, make: (s) => mdTableNode(s), select: 'node' },
	{ label: () => m.blockmenu_math_block(), icon: SquareRadical, make: (s) => s.nodes.block_math.create({}, s.text(' ')), select: 'node' },
	{
		label: () => m.blockmenu_code_block(),
		icon: Code,
		make: (s) => s.nodes.code_block.createAndFill({ env: 'fence', args: '' }),
		select: 'node'
	},
	{ label: () => m.mdtoolbar_hr(), icon: Minus, make: (s) => s.nodes.horizontal_rule.create(), select: 'node' }
];
