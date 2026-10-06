// Markdown (markdown-it tokens) -> ProseMirror, targeting the SAME schema as the LaTeX
// importer. Max-fidelity contract mirrors latex-parser/converter.ts: every construct the walker
// understands becomes a rich node; anything else survives as a raw block/chip sliced verbatim
// from the source, so an unknown token type can never crash a file open or lose bytes.
//
// Verbatim capture is far simpler than the LaTeX side: block tokens carry map = [startLine,
// endLineExclusive), so orig slices come straight off a line-offset table. One markdown list of
// N items becomes N flat-list nodes sharing one group (same model as itemize), so substitution
// stays all-or-nothing and an item edit regenerates the whole list.
import type { Token } from 'markdown-it';
import { el, txtNodes, collapseTextNodes, type PMNode, type PMMark, realMarks } from './builders';
import { createMarkdownEngine } from './engine';

interface Cap {
	source: string;
	lineStarts: number[];
	seq: number;
	prevEnd: number;
	group: number;
}

function buildLineStarts(source: string): number[] {
	const starts = [0];
	for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
	return starts;
}

function offsetOfLine(cap: Cap, line: number): number {
	return line < cap.lineStarts.length ? cap.lineStarts[line] : cap.source.length;
}

/** byte just past the construct's last line, excluding that line's own trailing newline (the
 *  newline is inter-block gap and belongs to the next block's `pre`). */
function sliceEnd(cap: Cap, endLine: number): number {
	const end = offsetOfLine(cap, endLine);
	return end > 0 && cap.source[end - 1] === '\n' ? end - 1 : end;
}

/** index of the token closing the construct opened at `i`; `i` itself for self-closed tokens. */
function constructEnd(tokens: Token[], i: number): number {
	if (tokens[i].nesting !== 1) return i;
	let depth = 0;
	for (let k = i; k < tokens.length; k++) {
		depth += tokens[k].nesting;
		if (depth === 0) return k;
	}
	return tokens.length - 1; // unbalanced stream: consume to the end rather than loop
}

function withMarks(node: PMNode, marks: PMMark[]): PMNode {
	return marks.length > 0 ? node.mark(realMarks(marks)) : node;
}

/** attrGet returns string | number | null; normalize to a string ('' when absent). */
function attrStr(tok: Token, name: string): string {
	const v = tok.attrGet(name);
	return v == null ? '' : String(v);
}

/**
 * A link/image destination as the AUTHOR wrote it.
 *
 * markdown-it percent-encodes every destination it parses (normalizeLink), which is right for a
 * renderer emitting `<img src>` and wrong for us twice over: the src is a path we look up ON DISK,
 * so `images/图片.png` arriving as `images/%E5%9B%BE%E7%89%87.png` finds no file and the image
 * never loads; and it is a value we write BACK to the .md, so editing the block around it rewrote
 * the author's filename into escapes.
 *
 * decodeURI, not decodeURIComponent: it leaves the reserved set (`?#&=+`) alone, so a query string
 * or a `#gh-dark-mode-only` fragment survives intact - the same characters mdurl excludes from the
 * encode this undoes. A destination holding a literal `%` (`100%.png`) is not valid escaping and
 * throws; that one was never encoded, so the raw string is already what the author wrote.
 */
function dest(tok: Token, name: string): string {
	const raw = attrStr(tok, name);
	try {
		return decodeURI(raw);
	} catch {
		return raw;
	}
}

/** reconstruct the literal markdown of an image token, for the mixed-content inline chip. */
function imageMarkdown(tok: Token): string {
	const title = attrStr(tok, 'title');
	return `![${tok.content}](${dest(tok, 'src')}${title ? ` "${title}"` : ''})`;
}

/** `![alt](src "title")` alone in a paragraph: a block figure. title becomes the caption. */
function imageBlock(tok: Token): PMNode {
	const title = attrStr(tok, 'title');
	return el(
		'image',
		{
			src: dest(tok, 'src'),
			alt: tok.content || null,
			numbered: false,
			showCaption: !!title
		},
		title ? txtNodes(title) : null
	);
}

const MARK_TOKENS: Record<string, string> = {
	strong: 'strong',
	em: 'em',
	s: 's'
};

function convertInline(children: Token[], marks: PMMark[]): PMNode[] {
	const out: PMNode[] = [];
	for (let i = 0; i < children.length; i++) {
		const tok = children[i];
		const open = tok.type.endsWith('_open') ? tok.type.slice(0, -5) : null;
		const close = tok.type.endsWith('_close') ? tok.type.slice(0, -6) : null;
		if (open && (MARK_TOKENS[open] || open === 'link')) {
			const mark: PMMark =
				open === 'link'
					? {
							type: 'link',
							attrs: {
								href: dest(tok, 'href'),
								title: attrStr(tok, 'title') || null,
								bare: tok.markup === 'autolink'
							}
						}
					: { type: MARK_TOKENS[open] };
			const end = constructEnd(children, i);
			out.push(...convertInline(children.slice(i + 1, end), [...marks, mark]));
			i = end;
			continue;
		}
		if (close) continue; // balanced by the recursion above; stray closes are noise

		switch (tok.type) {
			case 'text':
				out.push(...txtNodes(tok.content, marks));
				break;
			case 'softbreak':
				out.push(...txtNodes(' ', marks)); // a source line-wrap is semantically a space
				break;
			case 'hardbreak':
				out.push(el('hard_break', { lineBreak: true }));
				break;
			case 'code_inline':
				out.push(...txtNodes(tok.content, [...marks, { type: 'code' }]));
				break;
			case 'math_inline':
				out.push(withMarks(el('inline_math', null, txtNodes(tok.content)), marks));
				break;
			case 'html_inline':
				// chip per tag (not per element): the prose between <span> and </span> stays
				// editable text instead of getting swallowed into one opaque chip
				out.push(withMarks(el('inline_latex', { lang: 'html' }, txtNodes(tok.content)), marks));
				break;
			case 'image':
				// image mixed into a text line: no block figure can sit here, keep it literal
				out.push(withMarks(el('inline_latex', { lang: 'markdown' }, txtNodes(imageMarkdown(tok))), marks));
				break;
			default:
				// unknown inline token: keep its content as a literal chip rather than dropping it
				if (tok.content) out.push(withMarks(el('inline_latex', { lang: 'markdown' }, txtNodes(tok.content)), marks));
		}
	}
	return collapseTextNodes(out);
}

function paragraphContent(inline: Token | undefined): PMNode[] {
	return inline?.children ? convertInline(inline.children, []) : [];
}

/** GFM task marker on the item's first paragraph: strip it and lift into kind/checked attrs. */
function detectTask(blocks: PMNode[]): { blocks: PMNode[]; checked: boolean | null } {
	const first = blocks[0];
	if (!first || first.type.name !== 'paragraph' || first.childCount === 0) return { blocks, checked: null };
	const lead = first.child(0);
	if (!lead.isText || !lead.text) return { blocks, checked: null };
	const m = /^\[([ xX])\] /.exec(lead.text);
	if (!m) return { blocks, checked: null };
	const rest = lead.text.slice(m[0].length);
	const kids: PMNode[] = [];
	if (rest) kids.push(lead.type.schema.text(rest, lead.marks));
	for (let i = 1; i < first.childCount; i++) kids.push(first.child(i));
	const para = el('paragraph', { ...first.attrs }, kids);
	return { blocks: [para, ...blocks.slice(1)], checked: m[1] !== ' ' };
}

function listItems(tokens: Token[], i: number, j: number): PMNode[] {
	const open = tokens[i];
	const kind = open.type === 'ordered_list_open' ? 'ordered' : 'bullet';
	const start = kind === 'ordered' ? Number(open.attrGet('start') ?? 1) : null;
	const items: PMNode[] = [];
	let k = i + 1;
	while (k < j) {
		if (tokens[k].type !== 'list_item_open') {
			k++;
			continue;
		}
		const e = constructEnd(tokens, k);
		const inner = convertTokens(tokens, k + 1, e);
		const { blocks, checked } = detectTask(inner.length > 0 ? inner : [el('paragraph')]);
		items.push(
			el(
				'list',
				{
					kind: checked != null ? 'task' : kind,
					// flat-list only reads `order` on the first node of an ordered run (CSS counter-set)
					order: kind === 'ordered' ? (items.length === 0 ? (start ?? 1) : 1) : null,
					checked,
					collapsed: false,
					preBody: null
				},
				blocks
			)
		);
		k = e + 1;
	}
	if (items.length === 0) items.push(el('list', { kind, order: null, checked: null, collapsed: false, preBody: null }, [el('paragraph')]));
	return items;
}

function tableNode(tokens: Token[], i: number, j: number): PMNode {
	const rows: PMNode[] = [];
	const aligns: string[] = [];
	let inHead = false;
	let cells: PMNode[] = [];
	for (let k = i + 1; k < j; k++) {
		const tok = tokens[k];
		switch (tok.type) {
			case 'thead_open':
				inHead = true;
				break;
			case 'thead_close':
				inHead = false;
				break;
			case 'tr_open':
				cells = [];
				break;
			case 'tr_close':
				rows.push(el('table_row', { topRules: '' }, cells));
				break;
			case 'th_open':
			case 'td_open': {
				const e = constructEnd(tokens, k);
				const inline = tokens.slice(k + 1, e).find((t) => t.type === 'inline');
				const style = attrStr(tok, 'style');
				if (inHead) {
					const align = style.includes('right') ? '---:' : style.includes('center') ? ':--:' : style.includes('left') ? ':---' : '---';
					aligns.push(align);
				}
				cells.push(el(inHead ? 'table_header' : 'table_cell', null, [el('paragraph', null, paragraphContent(inline))]));
				k = e;
				break;
			}
		}
	}
	// the delimiter row isn't tokenized; rebuild it from cell alignment so regeneration keeps it
	return el('table', { env: null, colspec: aligns.join('|') || null }, rows);
}

function fenceNode(tok: Token): PMNode {
	const info = (tok.info ?? '').trim();
	const content = tok.content.replace(/\n$/, '');
	return el('code_block', { lang: info || 'Markdown', env: tok.type === 'fence' ? 'fence' : 'indented', args: info }, txtNodes(content));
}

/** one construct starting at tokens[i] (ending at j inclusive) -> block nodes. */
function convertConstruct(tokens: Token[], i: number, j: number, cap: Cap | null): PMNode[] {
	const tok = tokens[i];
	switch (tok.type) {
		case 'paragraph_open': {
			const inline = tokens[i + 1]?.type === 'inline' ? tokens[i + 1] : undefined;
			// a paragraph that IS one image becomes a block figure
			if (inline?.children?.length === 1 && inline.children[0].type === 'image') return [imageBlock(inline.children[0])];
			return [el('paragraph', { indent: 'auto' }, paragraphContent(inline))];
		}
		case 'heading_open': {
			const inline = tokens[i + 1]?.type === 'inline' ? tokens[i + 1] : undefined;
			return [el('heading', { level: Number(tok.tag.slice(1)) || 1, numbered: true }, paragraphContent(inline))];
		}
		case 'blockquote_open':
			return [el('blockquote', null, ensureBlocks(convertTokens(tokens, i + 1, j)))];
		case 'bullet_list_open':
		case 'ordered_list_open':
			return listItems(tokens, i, j);
		case 'table_open':
			return [tableNode(tokens, i, j)];
		case 'fence':
		case 'code_block':
			return [fenceNode(tok)];
		case 'hr':
			return [el('horizontal_rule')];
		case 'html_block':
			return [el('raw_latex', { lang: 'html' }, txtNodes(tok.content.replace(/\n$/, '')))];
		case 'math_block':
			return [el('block_math', { label: null, numbered: false, environment: null, lineLabels: [] }, txtNodes(tok.content.trim()))];
		default: {
			// unknown block construct: preserve its exact source lines as a raw markdown block
			if (cap && tok.map) {
				const min = offsetOfLine(cap, tok.map[0]);
				const end = sliceEnd(cap, tok.map[1]);
				if (end > min) return [el('raw_latex', { lang: 'markdown' }, txtNodes(cap.source.slice(min, end)))];
			}
			return tok.content ? [el('raw_latex', { lang: 'markdown' }, txtNodes(tok.content.replace(/\n$/, '')))] : [];
		}
	}
}

function ensureBlocks(blocks: PMNode[]): PMNode[] {
	return blocks.length > 0 ? blocks : [el('paragraph')];
}

/** nested walker (blockquote bodies, list items): no orig stamping below the top level. */
function convertTokens(tokens: Token[], from: number, to: number): PMNode[] {
	const out: PMNode[] = [];
	let i = from;
	while (i < to) {
		const j = constructEnd(tokens, i);
		out.push(...convertConstruct(tokens, i, Math.min(j, to), null));
		i = j + 1;
	}
	return out;
}

/** Recreate `node` with an `orig` attr; types that don't declare it pass through unchanged. */
function withOrig(node: PMNode, orig: Record<string, unknown>): PMNode {
	if (!node.type.spec.attrs || !('orig' in node.type.spec.attrs)) return node;
	return node.type.create({ ...node.attrs, orig }, node.content, node.marks);
}

export interface MarkdownParseResult {
	doc: PMNode;
}

export function markdownToProseMirror(source: string): MarkdownParseResult {
	const md = createMarkdownEngine();
	const tokens = md.parse(source, {}) as Token[];
	const cap: Cap = { source, lineStarts: buildLineStarts(source), seq: 0, prevEnd: 0, group: 0 };

	const result: PMNode[] = [];
	let i = 0;
	while (i < tokens.length) {
		const j = constructEnd(tokens, i);
		const blocks = convertConstruct(tokens, i, j, cap);
		const map = tokens[i].map;
		// stamp-and-push, the LaTeX converter's pushBlocks contract: every block gets a seq;
		// only a trustworthy span gets the slice. multi-block constructs (a list) share it
		// under a group id so substitution is all-or-nothing.
		const min = map ? offsetOfLine(cap, map[0]) : NaN;
		const end = map ? sliceEnd(cap, map[1]) : NaN;
		const spanOk = map != null && Number.isFinite(min) && min >= cap.prevEnd && end <= source.length && min < end;
		const slice = spanOk ? source.slice(min, end) : null;
		const pre = spanOk ? source.slice(cap.prevEnd, min) : null;
		const group = spanOk && blocks.length > 1 ? cap.group++ : null;
		for (let b = 0; b < blocks.length; b++) {
			const seq = cap.seq++;
			if (slice == null) {
				result.push(withOrig(blocks[b], { seq }));
				continue;
			}
			const orig: Record<string, unknown> = { latex: slice, pre: b === 0 ? pre : '', seq, norm: null, start: min };
			if (group != null) {
				orig.group = group;
				orig.groupIndex = b;
				orig.groupSize = blocks.length;
			}
			result.push(withOrig(blocks[b], orig));
		}
		if (spanOk) cap.prevEnd = Math.max(cap.prevEnd, end);
		i = j + 1;
	}

	// trailing bytes past the last block (usually just "\n") belong to no node; stash them on
	// the doc so a pristine save reproduces the file's exact tail. an EMPTY tail is stashed
	// too: it protects a missing final newline from being "fixed" on a no-edit save
	let docAttrs: Record<string, unknown> | null = null;
	if (result.length > 0) {
		docAttrs = { docTail: { text: source.slice(cap.prevEnd), afterSeq: cap.seq - 1 } };
	}
	return { doc: el('doc', docAttrs, ensureBlocks(result)) };
}
