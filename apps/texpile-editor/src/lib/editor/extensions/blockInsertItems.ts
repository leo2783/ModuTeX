// items for the block-handle + menu. keep make() free of UI prompts so any caller can run them.
import type { Schema, Node as PMNode } from 'prosemirror-model';
import { NodeSelection, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { Component } from 'svelte';
import {
	Type,
	Heading1,
	Heading2,
	Heading3,
	List,
	ListOrdered,
	Quote,
	Table as TableIcon,
	SquareRadical,
	Code,
	FileCode2,
	FileText
} from '@lucide/svelte';
import { createTableNode } from '$lib/editor/utils/tableUtils';
import { m } from '$lib/paraglide/messages';

export type BlockInsertItem = {
	/** called at render time: this table is module-level, and the locale isn't known yet at module eval. */
	label: () => string;
	icon: Component;
	make: (schema: Schema) => PMNode | null;
	/** 'in' = drop the cursor inside the new block; 'node' = NodeSelection it (atoms / CM blocks). */
	select: 'in' | 'node';
};

export type BlockCommandGroup = 'text' | 'math' | 'table' | 'media' | 'diagram' | 'raw';

export interface BlockCommandContext {
	state: EditorState;
	dispatch: (transaction: Transaction) => void;
	targetPos: number;
	placement: 'after' | 'replace';
	/** Async commands (for example a diagram dialog) must stop without dispatching when this aborts. */
	abortSignal?: AbortSignal;
	/** Opens the editor-owned canvas; the callback must preserve this target and cancellation boundary. */
	requestDiagram?: (type: 'mermaid' | 'drawio', context: BlockCommandContext) => void | Promise<void>;
}

export type BlockCommandPlacement = BlockCommandContext['placement'];

type DiagramRequester = NonNullable<BlockCommandContext['requestDiagram']>;
type RegisteredDiagramRequester = (type: 'mermaid' | 'drawio', context: BlockCommandContext) => void;
const diagramRequesters = new WeakMap<EditorView, RegisteredDiagramRequester>();

/** Bind the one editor-owned diagram panel opener to its live ProseMirror view. */
export function registerDiagramRequester(view: EditorView, requester: RegisteredDiagramRequester): () => void {
	diagramRequesters.set(view, requester);
	return () => {
		if (diagramRequesters.get(view) === requester) diagramRequesters.delete(view);
	};
}

/** Resolve a requester only for the same connected editor view and document snapshot. */
export function diagramRequesterFor(view: EditorView): DiagramRequester | undefined {
	const registered = diagramRequesters.get(view);
	if (!registered) return undefined;
	return (type, context) => {
		if (
			view.isDestroyed ||
			!view.dom.isConnected ||
			context.abortSignal?.aborted ||
			context.state.doc !== view.state.doc ||
			diagramRequesters.get(view) !== registered
		) {
			return;
		}
		return registered(type, context);
	};
}

/** Existing figure nodeviews can reopen a diagram through the same editor-owned panel path. */
export function requestDiagramForView(
	view: EditorView,
	type: 'mermaid' | 'drawio',
	targetPos: number,
	placement: BlockCommandPlacement = 'replace',
	expectedNode?: PMNode
): boolean {
	const requester = diagramRequesterFor(view);
	if (!requester || view.isDestroyed || !view.dom.isConnected || !Number.isSafeInteger(targetPos) || targetPos < 0) return false;
	const target = view.state.doc.nodeAt(targetPos);
	if (!target || (expectedNode && target !== expectedNode)) return false;
	const state = view.state;
	const context = createBlockCommandContext(
		state,
		(transaction) => {
			if (!view.isDestroyed && view.dom.isConnected && view.state.doc === state.doc) view.dispatch(transaction);
		},
		targetPos,
		placement,
		undefined,
		requester
	);
	void requester(type, context);
	return true;
}

export interface BlockCommand extends BlockInsertItem {
	id: string;
	labelKey: string;
	keywords: string[];
	group: BlockCommandGroup;
	isAvailable(ctx: BlockCommandContext): boolean;
	run(ctx: BlockCommandContext): void | Promise<void>;
}

interface BlockCommandSpec extends BlockInsertItem {
	id: string;
	labelKey: string;
	keywords: string[];
	group: BlockCommandGroup;
}

function insertCreatedBlock(ctx: BlockCommandContext, node: PMNode, select: BlockInsertItem['select']): void {
	if (ctx.abortSignal?.aborted) return;
	const target = ctx.state.doc.nodeAt(ctx.targetPos);
	if (!target) return;
	let at = ctx.targetPos;
	let tr = ctx.state.tr;
	if (ctx.placement === 'replace') {
		const $target = ctx.state.doc.resolve(ctx.targetPos);
		if (!$target.parent.canReplaceWith($target.index(), $target.index() + 1, node.type)) return;
		tr = tr.replaceWith(ctx.targetPos, ctx.targetPos + target.nodeSize, node);
	} else {
		at += target.nodeSize;
		let $at = ctx.state.doc.resolve(at);
		while ($at.depth > 0 && !$at.parent.canReplaceWith($at.index(), $at.index(), node.type)) {
			at = $at.after();
			$at = ctx.state.doc.resolve(at);
		}
		tr = tr.insert(at, node);
	}
	const selection = select === 'node' ? NodeSelection.create(tr.doc, at) : TextSelection.near(tr.doc.resolve(at + 1));
	ctx.dispatch(tr.setSelection(selection).scrollIntoView());
}

function blockCommand(spec: BlockCommandSpec): BlockCommand {
	return {
		...spec,
		isAvailable: (ctx) => !ctx.abortSignal?.aborted && spec.make(ctx.state.schema) !== null,
		run: (ctx) => {
			const node = spec.make(ctx.state.schema);
			if (node) insertCreatedBlock(ctx, node, spec.select);
		}
	};
}

/** Runs a registry command for either entry point, without allowing cancelled work to mutate the document. */
export async function executeBlockCommand(command: BlockCommand, ctx: BlockCommandContext): Promise<boolean> {
	if (ctx.abortSignal?.aborted || !command.isAvailable(ctx)) return false;
	await command.run(ctx);
	return !ctx.abortSignal?.aborted;
}

/** Both renderer entry points use this to invoke the same command with their explicit placement. */
export function createBlockCommandContext(
	state: EditorState,
	dispatch: BlockCommandContext['dispatch'],
	targetPos: number,
	placement: BlockCommandPlacement,
	abortSignal?: AbortSignal,
	requestDiagram?: BlockCommandContext['requestDiagram']
): BlockCommandContext {
	return { state, dispatch, targetPos, placement, abortSignal, requestDiagram };
}

export function isBlockCommand(item: BlockInsertItem): item is BlockCommand {
	return 'run' in item && typeof item.run === 'function' && 'isAvailable' in item && typeof item.isAvailable === 'function';
}

export function filterBlockCommands(commands: readonly BlockCommand[], query: string): BlockCommand[] {
	const needle = query.trim().toLocaleLowerCase();
	if (!needle) return [...commands];
	return commands.filter((command) =>
		[command.label(), command.id, ...command.keywords].some((value) => value.toLocaleLowerCase().includes(needle))
	);
}

export const BLOCK_COMMANDS: BlockCommand[] = [
	{
		id: 'drawio-diagram',
		labelKey: 'blockmenu_drawio_diagram',
		keywords: ['diagram', 'drawio', 'draw.io', 'graph', 'flowchart'],
		group: 'diagram',
		label: () => m.blockmenu_drawio_diagram(),
		icon: FileText,
		make: () => null,
		select: 'node',
		isAvailable: (ctx) => !!ctx.requestDiagram && !ctx.abortSignal?.aborted,
		run: (ctx) => ctx.requestDiagram?.('drawio', ctx)
	},
	blockCommand({
		id: 'paragraph',
		labelKey: 'blockmenu_text',
		keywords: ['text', 'paragraph', 'body'],
		group: 'text',
		label: () => m.blockmenu_text(),
		icon: Type,
		make: (s) => s.nodes.paragraph.create(),
		select: 'in'
	}),
	blockCommand({
		id: 'heading-1',
		labelKey: 'blockmenu_heading_1',
		keywords: ['heading', 'section', 'h1'],
		group: 'text',
		label: () => m.blockmenu_heading_1(),
		icon: Heading1,
		make: (s) => s.nodes.heading.create({ level: 1 }),
		select: 'in'
	}),
	blockCommand({
		id: 'heading-2',
		labelKey: 'blockmenu_heading_2',
		keywords: ['heading', 'subsection', 'h2'],
		group: 'text',
		label: () => m.blockmenu_heading_2(),
		icon: Heading2,
		make: (s) => s.nodes.heading.create({ level: 2 }),
		select: 'in'
	}),
	blockCommand({
		id: 'heading-3',
		labelKey: 'blockmenu_heading_3',
		keywords: ['heading', 'subsubsection', 'h3'],
		group: 'text',
		label: () => m.blockmenu_heading_3(),
		icon: Heading3,
		make: (s) => s.nodes.heading.create({ level: 3 }),
		select: 'in'
	}),
	blockCommand({
		id: 'bullet-list',
		labelKey: 'blockmenu_bullet_list',
		keywords: ['list', 'bullet', 'itemize'],
		group: 'text',
		label: () => m.blockmenu_bullet_list(),
		icon: List,
		make: (s) => s.nodes.list.create({ kind: 'bullet', order: null, checked: null, collapsed: false }, s.nodes.paragraph.create()),
		select: 'in'
	}),
	blockCommand({
		id: 'numbered-list',
		labelKey: 'blockmenu_numbered_list',
		keywords: ['list', 'numbered', 'enumerate'],
		group: 'text',
		label: () => m.blockmenu_numbered_list(),
		icon: ListOrdered,
		make: (s) => s.nodes.list.create({ kind: 'ordered', order: 1, checked: null, collapsed: false }, s.nodes.paragraph.create()),
		select: 'in'
	}),
	blockCommand({
		id: 'quote',
		labelKey: 'blockmenu_quote',
		keywords: ['quote', 'blockquote'],
		group: 'text',
		label: () => m.blockmenu_quote(),
		icon: Quote,
		make: (s) => s.nodes.blockquote?.create(null, s.nodes.paragraph.create()) ?? null,
		select: 'in'
	}),
	blockCommand({
		id: 'abstract',
		labelKey: 'blockmenu_abstract',
		keywords: ['abstract', 'summary'],
		group: 'text',
		label: () => m.blockmenu_abstract(),
		icon: FileText,
		// default to the env source form: standard LaTeX shape, accepts multi-paragraph content
		make: (s) => s.nodes.abstract?.create({ sourceForm: 'env' }, s.nodes.paragraph.create()) ?? null,
		select: 'in'
	}),
	blockCommand({
		id: 'table',
		labelKey: 'blockmenu_table',
		keywords: ['table', 'tabular', 'grid'],
		group: 'table',
		label: () => m.blockmenu_table(),
		icon: TableIcon,
		make: (s) => createTableNode(s, 2, 2, true),
		select: 'node'
	}),
	blockCommand({
		id: 'math-block',
		labelKey: 'blockmenu_math_block',
		keywords: ['math', 'equation', 'formula'],
		group: 'math',
		label: () => m.blockmenu_math_block(),
		icon: SquareRadical,
		make: (s) => s.nodes.block_math.create({}, s.text(' ')),
		select: 'node'
	}),
	blockCommand({
		id: 'code-block',
		labelKey: 'blockmenu_code_block',
		keywords: ['code', 'listing', 'verbatim'],
		group: 'raw',
		label: () => m.blockmenu_code_block(),
		icon: Code,
		make: (s) => s.nodes.code_block.createAndFill(),
		select: 'node'
	}),
	blockCommand({
		id: 'raw-latex',
		labelKey: 'blockmenu_raw_latex',
		keywords: ['raw', 'latex', 'source'],
		group: 'raw',
		label: () => m.blockmenu_raw_latex(),
		icon: FileCode2,
		make: (s) => s.nodes.raw_latex.createAndFill(),
		select: 'node'
	})
];

/** Compatibility name for the existing block handle; the values are the unified registry. */
export const BLOCK_INSERT_ITEMS: BlockInsertItem[] = BLOCK_COMMANDS;
