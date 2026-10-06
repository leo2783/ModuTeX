// Deterministic ProseMirror -> Markdown serializer: the latexSerializer's sibling dialect.
// String-returning handlers per node type over the shared Ctx contract; doc assembly (verbatim
// orig substitution + per-block memo) delegated to blockAssembly. prosemirror-markdown's
// serializer can't drive prosemirror-flat-list (it walks nested list NODES; flat-list is one
// node per item), so list/emphasis logic lives here; escaping follows prosemirror-markdown's
// rules. Convention: every block handler ends with its own separation ('\n\n', lists '\n'
// mid-run), so plain concatenation of parts is a valid document.
import type { Node, Mark } from 'prosemirror-model';
import { createBlockAssembly, type DocSerializeResult } from '$lib/serializer/blockAssembly';
import type { Ctx } from '$lib/serializer/types';

/** backslash-escape markdown structure chars; `_` stays literal intraword (prosemirror-markdown's
 * rule: an underscore between word chars can't open emphasis). */
export function escMd(str: string, startOfLine = false, inTableCell = false): string {
	let out = str.replace(/[`*\\~[\]_<]/g, (m, i: number) => {
		if (m === '_' && i > 0 && i + 1 < str.length && /\w/.test(str[i - 1]) && /\w/.test(str[i + 1])) return m;
		return '\\' + m;
	});
	if (startOfLine) {
		out = out
			.replace(/^[#\-+>]/, '\\$&')
			.replace(/^(\s*\d+)\./, '$1\\.')
			.replace(/^(\s*)=+\s*$/, '$1\\=');
	}
	if (inTableCell) out = out.replace(/\|/g, '\\|');
	return out;
}

/** inline code with a backtick fence longer than any run inside, padded when the ends collide. */
function codeSpan(text: string): string {
	const runs = text.match(/`+/g);
	const fence = '`'.repeat(runs ? Math.max(...runs.map((r) => r.length)) + 1 : 1);
	const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
	return fence + pad + text + pad + fence;
}

/** `<href>` needs no space/`<>`; angle-wrap other awkward destinations. */
function linkDest(href: string): string {
	return /[\s()]/.test(href) ? `<${href}>` : href;
}

interface MarkDelims {
	open: string;
	close: string;
	/** emphasis family: delimiters can't touch whitespace, boundary ws moves outside. */
	expel?: boolean;
}

const MARK_DELIMS: Record<string, (attrs: Record<string, unknown>) => MarkDelims> = {
	link: (a) => {
		const title = a.title ? ` "${String(a.title).replace(/"/g, '\\"')}"` : '';
		return { open: '[', close: `](${linkDest(String(a.href ?? ''))}${title})` };
	},
	strong: () => ({ open: '**', close: '**', expel: true }),
	em: () => ({ open: '*', close: '*', expel: true }),
	s: () => ({ open: '~~', close: '~~', expel: true }),
	u: () => ({ open: '<u>', close: '</u>' }),
	sup: () => ({ open: '<sup>', close: '</sup>' }),
	sub: () => ({ open: '<sub>', close: '</sub>' }),
	textcolor: (a) => ({ open: `<span style="color: ${String(a.color ?? 'black')}">`, close: '</span>' }),
	highlight: () => ({ open: '<mark>', close: '</mark>' })
};

// canonical nesting order (outermost first); code is innermost and handled inside run content
const MARK_ORDER = ['link', 'strong', 'em', 's', 'u', 'sup', 'sub', 'textcolor', 'highlight'];

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

/** a bare autolink whose visible text IS the href renders as <href>. */
function bareLinkRun(node: Node): string | null {
	const link = node.marks.find((m) => m.type.name === 'link');
	if (!link?.attrs?.bare) return null;
	const href = String(link.attrs.href ?? '');
	return node.isText && node.text === href ? `<${href}>` : null;
}

function buildRuns(parent: Node, startOfLine: boolean, inTableCell: boolean): InlineRun[] {
	const runs: InlineRun[] = [];
	let atLineStart = startOfLine;
	parent.forEach((node) => {
		if (node.isText) {
			const bare = bareLinkRun(node);
			if (bare != null) {
				runs.push({ content: bare, marks: [], isText: false });
			} else if (node.marks.some((m) => m.type.name === 'code')) {
				runs.push({ content: codeSpan(node.text ?? ''), marks: orderedMarks(node.marks), isText: false });
			} else {
				runs.push({ content: escMd(node.text ?? '', atLineStart, inTableCell), marks: orderedMarks(node.marks), isText: true });
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
			case 'inline_math':
				runs.push({ content: `$${node.textContent}$`, marks: orderedMarks(node.marks), isText: false });
				break;
			case 'inline_latex':
				runs.push({ content: node.textContent, marks: orderedMarks(node.marks), isText: false });
				break;
			case 'citation':
				// pandoc-style passthrough; only reachable by pasting from a .tex doc
				runs.push({ content: node.textContent ? `[@${node.textContent}]` : '', marks: [], isText: false });
				break;
			case 'ref':
				runs.push({ content: node.textContent, marks: [], isText: false });
				break;
			case 'image':
				runs.push({ content: imageMarkdown(node), marks: [], isText: false });
				break;
			default:
				runs.push({ content: node.isLeaf ? '' : renderInline(node, false, inTableCell), marks: orderedMarks(node.marks), isText: false });
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
 *  of emphasis delimiters (`** bold**` never parses back as strong). */
export function renderInline(parent: Node, startOfLine = true, inTableCell = false): string {
	const runs = buildRuns(parent, startOfLine, inTableCell);
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

function imageMarkdown(node: Node): string {
	const alt = String(node.attrs.alt ?? '').replace(/([[\]\\])/g, '\\$1');
	const caption = node.attrs.showCaption !== false ? renderInline(node, false).trim() : '';
	const title = caption ? ` "${caption.replace(/"/g, '\\"')}"` : '';
	return `![${alt}](${linkDest(String(node.attrs.src ?? ''))}${title})`;
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
function renderBlocks(parent: Node, inTableCell = false): string {
	let out = '';
	parent.forEach((child, _offset, i) => {
		out += serializeMdNode(child, { parent, index: i, isLastChild: i === parent.childCount - 1, inTableCell });
	});
	return out.replace(/\n+$/, '');
}

function isEmptyParagraph(node: Node): boolean {
	if (node.type.name !== 'paragraph') return false;
	let empty = true;
	node.forEach((c) => {
		if (c.isText ? c.text?.trim() : c.type.name !== 'hard_break') empty = false;
	});
	return empty;
}

function tableRows(node: Node): { header: string[] | null; body: string[][]; cols: number } {
	const rows: { cells: string[]; isHeader: boolean }[] = [];
	node.forEach((row) => {
		if (row.type.name !== 'table_row') return;
		const cells: string[] = [];
		let isHeader = row.childCount > 0;
		row.forEach((cell) => {
			if (cell.type.name !== 'table_header') isHeader = false;
			const parts: string[] = [];
			cell.forEach((p) => parts.push(renderInline(p, false, true)));
			cells.push(parts.join(' ').trim());
			// a colspan'd cell still occupies its extra columns in the pipe grid
			for (let s = 1; s < Number(cell.attrs.colspan ?? 1); s++) cells.push('');
		});
		rows.push({ cells, isHeader });
	});
	const cols = Math.max(1, ...rows.map((r) => r.cells.length));
	const header = rows.length > 0 && rows[0].isHeader ? rows[0].cells : null;
	const body = (header ? rows.slice(1) : rows).map((r) => r.cells);
	return { header, body, cols };
}

function pipeTable(node: Node): string {
	const { header, body, cols } = tableRows(node);
	const pad = (cells: string[]) => {
		const c = [...cells];
		while (c.length < cols) c.push('');
		return `| ${c.join(' | ')} |`;
	};
	// alignment survives in colspec (parse-time delimiter row); default plain dashes
	const spec = typeof node.attrs.colspec === 'string' && node.attrs.colspec ? node.attrs.colspec.split('|') : [];
	const delims: string[] = [];
	for (let i = 0; i < cols; i++) delims.push(spec[i] || '---');
	const lines = [pad(header ?? Array(cols).fill('')), `| ${delims.join(' | ')} |`, ...body.map(pad)];
	return lines.join('\n') + '\n\n';
}

type NodeHandler = (node: Node, ctx: Ctx) => string;

const NODES: Record<string, NodeHandler> = {
	paragraph(node, ctx) {
		if (isEmptyParagraph(node)) return ''; // blank lines are semantic no-ops, as on the LaTeX side
		return renderInline(node, true, ctx.inTableCell) + '\n\n';
	},

	heading(node) {
		if (node.childCount === 0) return '';
		const level = Math.min(6, Math.max(1, Number(node.attrs.level ?? 1)));
		return `${'#'.repeat(level)} ${renderInline(node, false)}\n\n`;
	},

	blockquote(node) {
		const inner = renderBlocks(node);
		return (
			inner
				.split('\n')
				.map((l) => (l ? '> ' + l : '>'))
				.join('\n') + '\n\n'
		);
	},

	horizontal_rule: () => '---\n\n',

	code_block(node) {
		const info = String(node.attrs.args ?? '').trim();
		const content = node.textContent;
		const runs = content.match(/`{3,}/g);
		const fence = '`'.repeat(runs ? Math.max(3, ...runs.map((r) => r.length)) + 1 : 3);
		return `${fence}${info}\n${content}\n${fence}\n\n`;
	},

	// raw source blocks (html in a markdown doc, latex via cross-dialect paste): verbatim
	raw_latex: (node) => (node.textContent ? node.textContent + '\n\n' : ''),

	block_math: (node) => `$$\n${node.textContent.trim()}\n$$\n\n`,

	image: (node) => imageMarkdown(node) + '\n\n',

	includedoc: (node) => `\\${String(node.attrs.command ?? 'input')}{${String(node.attrs.path ?? '')}}\n\n`,

	abstract: (node) => renderBlocks(node) + '\n\n',
	environment: (node) => renderBlocks(node) + '\n\n',

	list(node, ctx) {
		const kind = String(node.attrs.kind ?? 'bullet');
		const marker =
			kind === 'ordered' ? `${Number(node.attrs.order ?? 1)}. ` : kind === 'task' ? `- [${node.attrs.checked ? 'x' : ' '}] ` : '- ';
		// continuation lines align under the content: after '1. ' for ordered, after '- ' otherwise
		const indent = ' '.repeat(kind === 'ordered' ? marker.length : 2);
		const body = indentAfterFirstLine(renderBlocks(node) || '', indent);
		const next = nextSibling(ctx);
		const nextSame = next?.type.name === 'list' && next.attrs.kind === kind;
		return marker + body + (nextSame ? '\n' : '\n\n');
	},

	table: (node) => pipeTable(node),

	table_wrapper(node) {
		let table = '';
		let caption = '';
		let notes = '';
		node.forEach((child) => {
			if (child.type.name === 'table') table = pipeTable(child);
			else if (child.type.name === 'table_caption') caption = renderInline(child, false).trim();
			else if (child.type.name === 'table_notes') notes = renderInline(child, false).trim();
		});
		let out = table.replace(/\n+$/, '\n');
		if (caption) out += `\n*${caption}*\n`;
		if (notes && node.attrs.showNotes) out += `\n${notes}\n`;
		return out + '\n';
	}
};

/** Serialize one node to Markdown. Unknown types preserve their content rather than dropping it. */
export function serializeMdNode(node: Node, ctx: Ctx): string {
	const handler = NODES[node.type.name];
	if (handler) return handler(node, ctx);
	if (node.isText) return escMd(node.text ?? '');
	if (node.isInline) {
		// inline strays (should have come through renderInline) degrade to leafText/plain text
		const leafText = node.type.spec.leafText;
		return leafText ? leafText(node) : node.textContent;
	}
	const inner = renderBlocks(node, ctx.inTableCell);
	return inner ? inner + '\n\n' : '';
}

const assembly = createBlockAssembly((node, ctx) => serializeMdNode(node, ctx));

export function serializeToMarkdown(doc: Node): string {
	return assembly.serializeDocChildrenDetailed(doc).text;
}

export function serializeToMarkdownDetailed(doc: Node): DocSerializeResult {
	return assembly.serializeDocChildrenDetailed(doc);
}
