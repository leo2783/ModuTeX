// Deterministic ProseMirror -> Typst serializer: third sibling of latexSerializer and the
// markdown serializer. String-returning handlers per node type over the shared Ctx contract;
// doc assembly (verbatim orig substitution + per-block memo) delegated to blockAssembly.
// Convention: every block handler ends with its own separation ('\n\n', lists '\n' mid-run),
// so plain concatenation of parts is a valid document.
import type { Node, Mark } from 'prosemirror-model';
import { createBlockAssembly, type DocSerializeResult } from '$lib/serializer/blockAssembly';
import type { Ctx } from '$lib/serializer/types';
import { latexToTypst } from './latexToTypst';

/** a math node's typst: the stored original while the LaTeX is untouched, else MathLive's own
 *  LaTeX->typst serializer, else the stored original (an edit is dropped only if conversion
 *  fails, which try/catch makes near-impossible), else the raw latex as a last resort. */
function mathTypstOf(node: Node): string {
	const latex = node.textContent;
	const typst = typeof node.attrs.typst === 'string' ? node.attrs.typst : null;
	if (typst != null && latex === node.attrs.latexOrig) return typst;
	return latexToTypst(latex) ?? typst ?? latex;
}

/**
 * Backslash-escape Typst markup structure. `_` stays literal intraword (Typst emphasis only
 * opens at word boundaries, so snake_case is safe); `@` only starts a ref before a word char;
 * `//` would start a comment, so the first slash of a pair is escaped.
 */
export function escTypst(str: string, startOfLine = false): string {
	let out = '';
	for (let i = 0; i < str.length; i++) {
		const ch = str[i];
		if ('\\#$`*[]<~'.includes(ch)) {
			out += '\\' + ch;
			continue;
		}
		if (ch === '_') {
			const intraword = i > 0 && i + 1 < str.length && /\w/.test(str[i - 1]) && /\w/.test(str[i + 1]);
			out += intraword ? ch : '\\_';
			continue;
		}
		if (ch === '@' && /[\p{L}\p{N}_]/u.test(str[i + 1] ?? '')) {
			out += '\\@';
			continue;
		}
		if (ch === '/' && str[i + 1] === '/') {
			out += '\\/';
			continue;
		}
		out += ch;
	}
	if (startOfLine) {
		// list/term/heading markers and "1." enum markers only bind at line start
		out = out.replace(/^[-+/=]/, '\\$&').replace(/^(\d+)\./, '$1\\.');
	}
	return out;
}

/** inline raw with a backtick fence longer than any run inside, padded when the ends collide. */
function codeSpan(text: string): string {
	const runs = text.match(/`+/g);
	const fence = '`'.repeat(runs ? Math.max(...runs.map((r) => r.length)) + 1 : 1);
	const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
	return fence + pad + text + pad + fence;
}

/** typst string literal for a link target; JSON escaping is a compatible subset. */
function typStr(value: string): string {
	return JSON.stringify(value);
}

interface MarkDelims {
	open: string;
	close: string;
	/** emphasis family: delimiters can't touch whitespace, boundary ws moves outside. */
	expel?: boolean;
}

// typst named colors (shared with the converter's accept list); cyan/magenta are CSS-only names
// the dropdowns can produce, mapped to their rgb forms
const TYP_COLOR_IDENTS = new Set([
	'black',
	'gray',
	'silver',
	'white',
	'navy',
	'blue',
	'aqua',
	'teal',
	'purple',
	'fuchsia',
	'maroon',
	'red',
	'orange',
	'yellow',
	'olive',
	'green',
	'lime'
]);
const CSS_ONLY_COLORS: Record<string, string> = { cyan: '#00ffff', magenta: '#ff00ff' };

/** a mark's CSS color -> a typst color expression, or null when unrepresentable. */
function typColor(css: string): string | null {
	const v = css.trim().toLowerCase();
	if (TYP_COLOR_IDENTS.has(v)) return v;
	const hex = CSS_ONLY_COLORS[v] ?? (/^#[0-9a-f]{3,8}$/.test(v) ? v : null);
	return hex ? `rgb(${JSON.stringify(hex)})` : null;
}

const MARK_DELIMS: Record<string, (attrs: Record<string, unknown>) => MarkDelims> = {
	link: (a) => ({ open: `#link(${typStr(String(a.href ?? ''))})[`, close: ']' }),
	strong: () => ({ open: '*', close: '*', expel: true }),
	em: () => ({ open: '_', close: '_', expel: true }),
	u: () => ({ open: '#underline[', close: ']' }),
	sup: () => ({ open: '#super[', close: ']' }),
	sub: () => ({ open: '#sub[', close: ']' }),
	// an unrepresentable color (a pasted CSS value typst has no name for) drops the wrapper but
	// keeps the content - the color was never expressible in the file
	highlight: (a) => {
		const c = String(a.color ?? 'yellow')
			.trim()
			.toLowerCase();
		if (c === 'yellow') return { open: '#highlight[', close: ']' };
		const t = typColor(c);
		return t ? { open: `#highlight(fill: ${t})[`, close: ']' } : { open: '', close: '' };
	},
	textcolor: (a) => {
		const t = typColor(String(a.color ?? ''));
		return t ? { open: `#text(fill: ${t})[`, close: ']' } : { open: '', close: '' };
	}
};

// canonical nesting order (outermost first); code is innermost and handled inside run content
const MARK_ORDER = ['textcolor', 'highlight', 'u', 'sup', 'sub', 'link', 'strong', 'em'];

function orderedMarks(marks: readonly Mark[]): Mark[] {
	return marks
		.filter((m) => m.type.name !== 'code')
		.sort((a, b) => {
			const ia = MARK_ORDER.indexOf(a.type.name);
			const ib = MARK_ORDER.indexOf(b.type.name);
			return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
		});
}

interface InlineRun {
	content: string;
	marks: Mark[];
	/** plain prose (whitespace expelling applies); false for chips and breaks */
	isText: boolean;
}

function buildRuns(parent: Node, startOfLine: boolean): InlineRun[] {
	const runs: InlineRun[] = [];
	let atLineStart = startOfLine;
	parent.forEach((node) => {
		if (node.isText) {
			if (node.marks.some((m) => m.type.name === 'code')) {
				runs.push({ content: codeSpan(node.text ?? ''), marks: orderedMarks(node.marks), isText: false });
			} else {
				runs.push({ content: escTypst(node.text ?? '', atLineStart), marks: orderedMarks(node.marks), isText: true });
			}
			atLineStart = false;
			return;
		}
		switch (node.type.name) {
			case 'hard_break':
				if (node.attrs?.lineBreak === false) return; // legacy no-op break
				runs.push({ content: '\\\n', marks: [], isText: false });
				atLineStart = true;
				return;
			case 'inline_latex':
				runs.push({ content: node.textContent, marks: orderedMarks(node.marks), isText: false });
				break;
			case 'typ_ref':
				runs.push({ content: `@${String(node.attrs.target ?? '')}`, marks: orderedMarks(node.marks), isText: false });
				break;
			case 'inline_math':
				runs.push({ content: `$${mathTypstOf(node)}$`, marks: orderedMarks(node.marks), isText: false });
				break;
			default:
				runs.push({ content: node.isLeaf ? '' : renderInline(node, false), marks: orderedMarks(node.marks), isText: false });
		}
		atLineStart = false;
	});
	return runs.filter((r) => r.content !== '');
}

function commonPrefixLen(a: Mark[], b: Mark[]): number {
	let n = 0;
	while (n < a.length && n < b.length && a[n].eq(b[n])) n++;
	return n;
}

/** minimal open/close mark transitions over same-mark runs, expelling boundary whitespace out
 *  of emphasis delimiters (`* bold*` never parses back as strong). */
export function renderInline(parent: Node, startOfLine = true): string {
	const runs = buildRuns(parent, startOfLine);
	let out = '';
	let active: Mark[] = [];

	const emitCloses = (closing: Mark[]) => {
		let stolen = '';
		if (closing.some((m) => MARK_DELIMS[m.type.name]?.(m.attrs).expel)) {
			const ws = out.match(/(\s+)$/);
			if (ws && ws[1].length < out.length) {
				out = out.slice(0, -ws[1].length);
				stolen = ws[1];
			}
		}
		for (const m of closing) {
			const d = MARK_DELIMS[m.type.name];
			if (d) out += d(m.attrs).close;
		}
		out += stolen;
	};

	for (const run of runs) {
		const keep = commonPrefixLen(active, run.marks);
		emitCloses(active.slice(keep).reverse());
		const opening = run.marks.slice(keep);
		let content = run.content;
		if (run.isText && opening.some((m) => MARK_DELIMS[m.type.name]?.(m.attrs).expel)) {
			const lead = content.match(/^\s+/);
			if (lead && lead[0].length < content.length) {
				out += lead[0];
				content = content.slice(lead[0].length);
			}
		}
		for (const m of opening) {
			const d = MARK_DELIMS[m.type.name];
			if (d) out += d(m.attrs).open;
		}
		out += content;
		active = run.marks;
	}
	emitCloses([...active].reverse());
	return out;
}

function indentAfterFirstLine(text: string, indent: string): string {
	return text
		.split('\n')
		.map((l, i) => (i === 0 || l === '' ? l : indent + l))
		.join('\n');
}

function nextSibling(ctx: Ctx): Node | null {
	return ctx.parent && ctx.index < ctx.parent.childCount - 1 ? ctx.parent.child(ctx.index + 1) : null;
}

/** children serialized and concatenated (handlers carry their own separators), tail trimmed. */
function renderBlocks(parent: Node): string {
	let out = '';
	parent.forEach((child, _offset, i) => {
		out += serializeTypNode(child, { parent, index: i, isLastChild: i === parent.childCount - 1, inTableCell: false });
	});
	return out.replace(/\n+$/, '');
}

/** the `table(...)` call itself, extra-indented by `indent`; '' when the table has no rows.
 *  Shared by the bare-table handler (indent '') and the figure wrapper (indent '  '). */
function tableBody(node: Node, indent: string): string {
	const rows: { cells: Node[]; isHeader: boolean }[] = [];
	node.forEach((row) => {
		if (row.type.name !== 'table_row') return;
		const cells: Node[] = [];
		let isHeader = row.childCount > 0;
		row.forEach((cell) => {
			if (cell.type.name !== 'table_header') isHeader = false;
			cells.push(cell);
		});
		rows.push({ cells, isHeader });
	});
	if (rows.length === 0) return '';
	const cols = Math.max(1, ...rows.map((r) => r.cells.length));
	const cellText = (cell: Node) =>
		// single-paragraph cells render inline; anything richer keeps its block layout in the [..]
		cell.childCount === 1 && cell.child(0).type.name === 'paragraph' ? renderInline(cell.child(0), false) : renderBlocks(cell);
	const rowLine = (r: { cells: Node[] }) => `  ${r.cells.map((c) => `[${cellText(c)}]`).join(', ')},`;
	const lines = [`  columns: ${colspecFor(node.attrs.colspec, cols)},`];
	// verbatim align:, under the same staleness rule as colspec - a per-column list that no
	// longer matches the real column count is dropped rather than silently mis-aligned
	const align = typeof node.attrs.typAlign === 'string' ? node.attrs.typAlign.trim() : '';
	if (align) {
		const perColumn = align.startsWith('(') && align.endsWith(')') && !/[()]/.test(align.slice(1, -1));
		const count = perColumn
			? align
					.slice(1, -1)
					.split(',')
					.filter((s) => s.trim()).length
			: cols;
		if (count === cols) lines.push(`  align: ${align},`);
	}
	const headerRow = rows[0]?.isHeader ? rows[0] : null;
	if (headerRow) lines.push(`  table.header(${headerRow.cells.map((c) => `[${cellText(c)}]`).join(', ')}),`);
	for (const r of headerRow ? rows.slice(1) : rows) lines.push(rowLine(r));
	return `table(\n${lines.map((l) => indent + l).join('\n')}\n${indent})`;
}

/** The verbatim columns: value, but ONLY while it still matches the table's real column count —
 *  a context-menu column add/delete outdates it, and a wrong count silently reflows every cell
 *  in the compiled document. The fallback is the plain count (all-auto tracks). */
function colspecFor(colspec: unknown, cols: number): string {
	const spec = typeof colspec === 'string' ? colspec.trim() : '';
	if (/^\d+$/.test(spec) && Number(spec) === cols) return spec;
	if (spec.startsWith('(') && spec.endsWith(')') && !/[()]/.test(spec.slice(1, -1))) {
		if (
			spec
				.slice(1, -1)
				.split(',')
				.filter((s) => s.trim()).length === cols
		)
			return spec;
	}
	return String(cols);
}

function isEmptyParagraph(node: Node): boolean {
	if (node.type.name !== 'paragraph') return false;
	let empty = true;
	node.forEach((c) => {
		if (c.isText ? c.text?.trim() : c.type.name !== 'hard_break') empty = false;
	});
	return empty;
}

type NodeHandler = (node: Node, ctx: Ctx) => string;

const NODES: Record<string, NodeHandler> = {
	paragraph(node) {
		if (isEmptyParagraph(node)) return ''; // blank lines are semantic no-ops, as in both siblings
		return renderInline(node, true) + '\n\n';
	},

	heading(node) {
		if (node.childCount === 0) return '';
		const level = Math.min(6, Math.max(1, Number(node.attrs.level ?? 1)));
		return `${'='.repeat(level)} ${renderInline(node, false)}\n\n`;
	},

	code_block(node) {
		const info = String(node.attrs.args ?? '').trim();
		const content = node.textContent;
		const runs = content.match(/`{3,}/g);
		const fence = '`'.repeat(runs ? Math.max(3, ...runs.map((r) => r.length)) + 1 : 3);
		return `${fence}${info}\n${content}\n${fence}\n\n`;
	},

	// raw source islands (code mode, math, terms, comments): verbatim
	raw_latex: (node) => (node.textContent ? node.textContent + '\n\n' : ''),

	includedoc: (node) => `#include ${typStr(String(node.attrs.path ?? ''))}\n\n`,

	image(node) {
		// `options` is the verbatim extra-args slice (width: 70%, fit: "cover", ...); re-emitted
		// untouched so a resize/crop written in source survives the visual editor
		const rawOpts = typeof node.attrs.options === 'string' ? node.attrs.options.trim() : '';
		let optsStr = rawOpts;
		// a drag-resize leaves snapped pixel width/maxWidth attrs (never set by the converter);
		// translate them to a percent of the text column, replacing any width: already carried.
		// wysiwym by design - the editor column stands in for the page width
		const w = Number(node.attrs.width);
		const max = Number(node.attrs.maxWidth);
		if (Number.isFinite(w) && Number.isFinite(max) && w > 0 && max > 0) {
			const pct = Math.min(100, Math.max(1, Math.round((w / max) * 100)));
			const rest = rawOpts
				.split(',')
				.map((s) => s.trim())
				.filter((s) => s && !/^width:/.test(s));
			optsStr = [`width: ${pct}%`, ...rest].join(', ');
		}
		const opts = optsStr ? `, ${optsStr}` : '';
		const img = `image(${typStr(String(node.attrs.src ?? ''))}${opts})`;
		const caption = node.attrs.showCaption !== false ? renderInline(node, false).trim() : '';
		const label = node.attrs.label ? ` <${String(node.attrs.label)}>` : '';
		// a bare #image is one the source never wrapped in a figure; keep it bare
		if (node.attrs.numbered === false && !caption && !label) return `#${img}\n\n`;
		return `#figure(${img}${caption ? `, caption: [${caption}]` : ''})${label}\n\n`;
	},

	table(node) {
		const body = tableBody(node, '');
		return body ? `#${body}\n\n` : '';
	},

	// #figure(table(...), caption: [...]) <label> — the typst way to caption a table
	table_wrapper(node) {
		let table: Node | null = null;
		let captionNode: Node | null = null;
		node.forEach((c) => {
			if (c.type.name === 'table') table = c;
			else if (c.type.name === 'table_caption') captionNode = c;
		});
		if (!table) return '';
		const body = tableBody(table, '  ');
		if (!body) return '';
		const cap = captionNode as Node | null;
		const caption = cap && cap.childCount > 0 ? renderInline(cap, false).trim() : '';
		const label = node.attrs.label ? ` <${String(node.attrs.label)}>` : '';
		return `#figure(\n  ${body}${caption ? `,\n  caption: [${caption}]` : ''},\n)${label}\n\n`;
	},

	block_math(node) {
		const inner = mathTypstOf(node).trim();
		if (!inner) return '';
		// the label rides after the closing dollar, where typst attaches it to the equation
		const label = node.attrs.label ? ` <${String(node.attrs.label)}>` : '';
		return `$ ${inner} $${label}\n\n`;
	},

	blockquote(node) {
		const inner = renderBlocks(node);
		if (!inner) return '';
		return `#quote(block: true)[\n  ${indentAfterFirstLine(inner, '  ')}\n]\n\n`;
	},

	horizontal_rule() {
		return '#line(length: 100%)\n\n';
	},

	term_item(node, ctx) {
		let title: Node | null = null;
		const rest: string[] = [];
		node.forEach((child, _offset, i) => {
			if (i === 0 && child.type.name === 'term_title') {
				title = child;
				return;
			}
			rest.push(serializeTypNode(child, { parent: node, index: i, isLastChild: i === node.childCount - 1, inTableCell: false }));
		});
		const desc = rest.join('').replace(/\n+$/, '');
		const line = `/ ${title ? renderInline(title, false) : ''}: ${indentAfterFirstLine(desc, '  ')}`;
		const next = nextSibling(ctx);
		return line + (next?.type.name === 'term_item' ? '\n' : '\n\n');
	},

	list(node, ctx) {
		const kind = String(node.attrs.kind ?? 'bullet');
		// '+' auto-numbers; only a run starting off the natural count needs its explicit "N."
		// marker back (order is 1 on every non-first node of a run, by the importer's contract)
		const order = Number(node.attrs.order ?? 1);
		const marker = kind === 'ordered' ? (order !== 1 ? `${order}. ` : '+ ') : '- ';
		// continuation lines must sit past the marker to stay inside the item
		const body = indentAfterFirstLine(renderBlocks(node) || '', ' '.repeat(marker.length));
		const next = nextSibling(ctx);
		const nextSame = next?.type.name === 'list' && next.attrs.kind === kind;
		return marker + body + (nextSame ? '\n' : '\n\n');
	}
};

/** Serialize one node to Typst. Unknown types preserve their content rather than dropping it. */
export function serializeTypNode(node: Node, ctx: Ctx): string {
	const handler = NODES[node.type.name];
	if (handler) return handler(node, ctx);
	if (node.isText) return escTypst(node.text ?? '');
	if (node.isInline) {
		// inline strays (should have come through renderInline) degrade to leafText/plain text
		const leafText = node.type.spec.leafText;
		return leafText ? leafText(node) : node.textContent;
	}
	const inner = renderBlocks(node);
	return inner ? inner + '\n\n' : '';
}

const assembly = createBlockAssembly((node, ctx) => serializeTypNode(node, ctx));

export function serializeToTypst(doc: Node): string {
	return assembly.serializeDocChildrenDetailed(doc).text;
}

export function serializeToTypstDetailed(doc: Node): DocSerializeResult {
	return assembly.serializeDocChildrenDetailed(doc);
}
