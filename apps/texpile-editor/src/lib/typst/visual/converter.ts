// Typst source -> ProseMirror, over the CST from our own wasm build of typst-syntax
// (packages/typst-syntax-wasm). Max-fidelity contract mirrors the LaTeX and Markdown importers:
// every construct the walker understands becomes a rich node; anything else survives as a raw
// block/chip sliced verbatim from the source, so an unknown node kind can never crash a file
// open or lose bytes. Code mode (#let, #show, #import, function calls...) is deliberately ALL
// raw islands in this phase — the visual editor edits markup structure, source mode edits code.
//
// Verbatim capture is the simplest of the three dialects: the CST carries exact UTF-16 offsets
// on every node, so orig slices come straight off the tree. Typst's tree is flat at the markup
// level (paragraph boundaries are explicit Parbreak nodes, a Hash is a SIBLING of the code
// expression it introduces), so block grouping is synthesized here.
import type { SyntaxNode, Tree } from '@lezer/common';
import { TypstParser } from 'texpile-typst-syntax-wasm';
import { el, txtNodes, collapseTextNodes, realMarks, type PMNode, type PMMark } from './builders';
import { typstMathToLatex } from './mathTranslate';

// one parser for the module: Source::replace reparses incrementally against the previous text,
// and the converter has no per-document state of its own
let parser: TypstParser | null = null;
function parseTree(source: string): Tree {
	if (!parser) parser = new TypstParser();
	return parser.parse(source);
}

function children(node: SyntaxNode): SyntaxNode[] {
	const out: SyntaxNode[] = [];
	for (let c = node.firstChild; c; c = c.nextSibling) out.push(c);
	return out;
}

function childOf(node: SyntaxNode, name: string): SyntaxNode | null {
	for (let c = node.firstChild; c; c = c.nextSibling) if (c.name === name) return c;
	return null;
}

// code expressions that are statements: they configure the document or bind names, are
// virtually always written on their own line, and always become their own raw block
const STATEMENT_KINDS = new Set([
	'ModuleImport',
	'ModuleInclude',
	'LetBinding',
	'SetRule',
	'ShowRule',
	'Conditional',
	'ForLoop',
	'WhileLoop',
	'Contextual',
	'CodeBlock'
]);

// shorthands become the character the reader sees; the reverse direction needs no mapping
// because the character itself is valid Typst text
const SHORTHANDS: Record<string, string> = {
	'--': '\u2013',
	'---': '\u2014',
	'...': '\u2026',
	'~': '\u00a0',
	'-?': '\u00ad'
};

/** `\*` reveals `*`; `\u{263A}` reveals the code point. Unknown forms stay verbatim. */
function unescape(slice: string): string {
	const u = /^\\u\{([0-9a-fA-F]+)\}$/.exec(slice);
	if (u) {
		try {
			return String.fromCodePoint(parseInt(u[1], 16));
		} catch {
			return slice;
		}
	}
	return slice.length >= 2 && slice[0] === '\\' ? slice.slice(1) : slice;
}

function withMarks(node: PMNode, marks: PMMark[]): PMNode {
	return marks.length > 0 ? node.mark(realMarks(marks)) : node;
}

/** an inline raw-source chip; the escape hatch every unknown inline construct falls into. */
function chip(text: string, marks: PMMark[]): PMNode[] {
	return text ? [withMarks(el('inline_latex', { lang: 'typst' }, txtNodes(text)), marks)] : [];
}

function rawBlock(text: string): PMNode {
	return el('raw_latex', { lang: 'typst' }, txtNodes(text));
}

/** the source between an Equation's dollar delimiters, exactly as written. */
function equationInner(eq: SyntaxNode, src: string): string {
	const ds = children(eq).filter((c) => c.name === 'Dollar');
	if (ds.length >= 2) return src.slice(ds[0].to, ds[ds.length - 1].from);
	return src.slice(eq.from, eq.to).replace(/^\$|\$$/g, '');
}

/** typst string literal -> its value; only the escapes a URL plausibly contains. */
function unquote(str: string): string {
	const inner = str.startsWith('"') && str.endsWith('"') && str.length >= 2 ? str.slice(1, -1) : str;
	return inner.replace(/\\(["\\])/g, '$1');
}

/** `#link("...")[...]` and nothing fancier; any other shape stays a chip. */
function linkParts(call: SyntaxNode, src: string): { href: string; markup: SyntaxNode } | null {
	if (call.name !== 'FuncCall') return null;
	const ident = call.firstChild;
	if (!ident || ident.name !== 'Ident' || src.slice(ident.from, ident.to) !== 'link') return null;
	const args = ident.nextSibling;
	if (!args || args.name !== 'Args') return null;
	const real = children(args).filter((k) => !['LeftParen', 'RightParen', 'Comma', 'Space'].includes(k.name));
	if (real.length !== 2 || real[0].name !== 'Str' || real[1].name !== 'ContentBlock') return null;
	const markup = childOf(real[1], 'Markup');
	if (!markup) return null;
	return { href: unquote(src.slice(real[0].from, real[0].to)), markup };
}

/** typst named colors that CSS can also render - the mark's DOM styling uses the value directly.
 *  `eastern` exists in typst but not CSS, so it stays a chip. */
const COLOR_IDENTS = new Set([
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

const CALL_PUNCT = ['LeftParen', 'RightParen', 'Comma', 'Space'];

/** `rgb("#hex")` or a shared named color -> its CSS-compatible value; anything else null. */
function colorValue(node: SyntaxNode, src: string): string | null {
	if (node.name === 'Ident') {
		const v = src.slice(node.from, node.to);
		return COLOR_IDENTS.has(v) ? v : null;
	}
	if (node.name === 'FuncCall') {
		const id = node.firstChild;
		if (!id || id.name !== 'Ident' || src.slice(id.from, id.to) !== 'rgb') return null;
		const args = id.nextSibling;
		if (!args || args.name !== 'Args') return null;
		const real = children(args).filter((k) => !CALL_PUNCT.includes(k.name));
		if (real.length !== 1 || real[0].name !== 'Str') return null;
		const v = unquote(src.slice(real[0].from, real[0].to)).toLowerCase();
		return /^#[0-9a-f]{3,8}$/.test(v) ? v : null;
	}
	return null;
}

/** the color of a `fill: <color>` named argument, or null for any other named arg. */
function fillColor(named: SyntaxNode, src: string): string | null {
	const kids = children(named).filter((k) => k.name !== 'Colon' && k.name !== 'Space');
	if (kids.length !== 2 || kids[0].name !== 'Ident' || src.slice(kids[0].from, kids[0].to) !== 'fill') return null;
	return colorValue(kids[1], src);
}

const MARK_FUNCS: Record<string, 'u' | 'sup' | 'sub'> = { underline: 'u', super: 'sup', sub: 'sub' };

/** `#underline[..] / #super[..] / #sub[..] / #highlight[..] / #highlight(fill: c)[..] /
 *  #text(fill: c)[..]` -> a mark over the inline content. Any other shape (extra arguments,
 *  unshared color) stays a chip, the same rule links follow. */
function markCallParts(call: SyntaxNode, src: string): { mark: PMMark; markup: SyntaxNode } | null {
	if (call.name !== 'FuncCall') return null;
	const ident = call.firstChild;
	if (!ident || ident.name !== 'Ident') return null;
	const name = src.slice(ident.from, ident.to);
	const args = ident.nextSibling;
	if (!args || args.name !== 'Args') return null;
	const real = children(args).filter((k) => !CALL_PUNCT.includes(k.name));
	const contentMarkup = (n: SyntaxNode | undefined) => (n && n.name === 'ContentBlock' ? childOf(n, 'Markup') : null);

	const plain = MARK_FUNCS[name];
	if (plain) {
		if (real.length !== 1) return null;
		const markup = contentMarkup(real[0]);
		return markup ? { mark: { type: plain }, markup } : null;
	}
	if (name === 'highlight') {
		if (real.length === 1) {
			const markup = contentMarkup(real[0]);
			return markup ? { mark: { type: 'highlight', attrs: { color: 'yellow' } }, markup } : null;
		}
		if (real.length === 2 && real[0].name === 'Named') {
			const color = fillColor(real[0], src);
			const markup = contentMarkup(real[1]);
			return color && markup ? { mark: { type: 'highlight', attrs: { color } }, markup } : null;
		}
		return null;
	}
	if (name === 'text' && real.length === 2 && real[0].name === 'Named') {
		const color = fillColor(real[0], src);
		const markup = contentMarkup(real[1]);
		return color && markup ? { mark: { type: 'textcolor', attrs: { color } }, markup } : null;
	}
	return null;
}

/** inline CST nodes -> inline PM nodes. Pairs each Hash with the expression following it. */
function convertInline(nodes: SyntaxNode[], src: string, marks: PMMark[]): PMNode[] {
	const out: PMNode[] = [];
	for (let i = 0; i < nodes.length; i++) {
		const k = nodes[i];
		const slice = src.slice(k.from, k.to);
		switch (k.name) {
			case 'Text':
				out.push(...txtNodes(slice, marks));
				break;
			case 'Space':
			case 'Parbreak': // only reachable in odd nests; a wrap is semantically a space
				out.push(...txtNodes(' ', marks));
				break;
			case 'Strong':
			case 'Emph': {
				const markup = childOf(k, 'Markup');
				if (markup) {
					out.push(...convertInline(children(markup), src, [...marks, { type: k.name === 'Strong' ? 'strong' : 'em' }]));
				} else {
					out.push(...chip(slice, marks));
				}
				break;
			}
			case 'Raw': {
				const delims = children(k).filter((c) => c.name === 'RawDelim');
				if (delims.length < 2 || delims[0].to - delims[0].from >= 3) {
					// unterminated, or a block fence stuck mid-line: keep it literal
					out.push(...chip(slice, marks));
				} else {
					out.push(...txtNodes(src.slice(delims[0].to, delims[delims.length - 1].from), [...marks, { type: 'code' }]));
				}
				break;
			}
			case 'Linebreak':
				out.push(el('hard_break', { lineBreak: true }));
				// the newline ending the broken line is part of the break, not a leading space
				// on the continuation
				if (nodes[i + 1]?.name === 'Space') i++;
				break;
			case 'Escape':
				out.push(...txtNodes(unescape(slice), marks));
				break;
			case 'SmartQuote':
				out.push(...txtNodes(slice, marks));
				break;
			case 'Shorthand':
				out.push(...txtNodes(SHORTHANDS[slice] ?? slice, marks));
				break;
			case 'Hash': {
				const next = nodes[i + 1];
				if (!next) {
					out.push(...chip('#', marks));
					break;
				}
				const link = linkParts(next, src);
				const markCall = link ? null : markCallParts(next, src);
				if (link) {
					const linkMark: PMMark = { type: 'link', attrs: { href: link.href, title: null, bare: false } };
					out.push(...convertInline(children(link.markup), src, [...marks, linkMark]));
				} else if (markCall) {
					out.push(...convertInline(children(markCall.markup), src, [...marks, markCall.mark]));
				} else {
					out.push(...chip(src.slice(k.from, next.to), marks));
				}
				i++;
				break;
			}
			case 'Equation': {
				// fully-translatable equations become MathLive-editable math nodes carrying their
				// original typst; anything the translator can't prove stays a raw chip
				const latex = typstMathToLatex(k, src);
				if (latex != null) {
					out.push(withMarks(el('inline_math', { typst: equationInner(k, src), latexOrig: latex }, txtNodes(latex)), marks));
				} else {
					out.push(...chip(slice, marks));
				}
				break;
			}
			case 'Ref': {
				// a bare @target becomes the ref/citation atom; a supplement (`@fig[Figure]`) stays
				// a chip - the atom's serializer has no slot for it
				const refKids = children(k);
				if (refKids.length === 1 && refKids[0].name === 'RefMarker') {
					out.push(withMarks(el('typ_ref', { target: slice.slice(1) }), marks));
				} else {
					out.push(...chip(slice, marks));
				}
				break;
			}
			// labels, equations, comments and anything unforeseen: verbatim chips
			default:
				out.push(...chip(slice, marks));
		}
	}
	return collapseTextNodes(out);
}

/** one source construct -> its PM blocks, with the span the slice is cut from. */
interface Seg {
	blocks: PMNode[];
	from: number;
	to: number;
}

function ensureBlocks(blocks: PMNode[]): PMNode[] {
	return blocks.length > 0 ? blocks : [el('paragraph')];
}

/** true when nothing but whitespace remains before the paragraph ends. */
function restOnlySpace(kids: SyntaxNode[], j: number): boolean {
	for (; j < kids.length; j++) {
		if (kids[j].name === 'Parbreak') return true;
		if (kids[j].name !== 'Space') return false;
	}
	return true;
}

function headingSeg(k: SyntaxNode, src: string): Seg {
	const marker = childOf(k, 'HeadingMarker');
	const level = Math.min(6, Math.max(1, marker ? marker.to - marker.from : 1));
	const markup = childOf(k, 'Markup');
	const content = markup ? convertInline(children(markup), src, []) : [];
	return { blocks: [el('heading', { level, numbered: true }, content)], from: k.from, to: k.to };
}

/** consecutive same-kind items separated by plain whitespace form ONE list. */
function listSeg(kids: SyntaxNode[], i: number, src: string): { seg: Seg; next: number } {
	const kindName = kids[i].name;
	const items: SyntaxNode[] = [kids[i]];
	let j = i + 1;
	while (j < kids.length) {
		if (kids[j].name === kindName) {
			items.push(kids[j]);
			j++;
		} else if (kids[j].name === 'Space' && kids[j + 1]?.name === kindName) {
			j++;
		} else {
			break;
		}
	}
	const kind = kindName === 'ListItem' ? 'bullet' : 'ordered';
	// an explicit "3." enum marker sets the run's start; "+" auto-numbers from 1
	const firstMarker = childOf(items[0], 'EnumMarker');
	const startMatch = firstMarker ? /^(\d+)[.)]/.exec(src.slice(firstMarker.from, firstMarker.to)) : null;
	const start = startMatch ? Number(startMatch[1]) : 1;
	const blocks = items.map((item, idx) => {
		const markup = childOf(item, 'Markup');
		const inner = markup ? convertMarkup(children(markup), src).flatMap((s) => s.blocks) : [];
		return el(
			'list',
			{
				kind,
				// flat-list only reads `order` on the first node of an ordered run (CSS counter-set)
				order: kind === 'ordered' ? (idx === 0 ? start : 1) : null,
				checked: null,
				collapsed: false,
				preBody: null
			},
			ensureBlocks(inner)
		);
	});
	return { seg: { blocks, from: items[0].from, to: items[items.length - 1].to }, next: j };
}

/** consecutive `/ term: description` items form ONE run, mirroring listSeg. */
function termSeg(kids: SyntaxNode[], i: number, src: string): { seg: Seg; next: number } {
	const items: SyntaxNode[] = [kids[i]];
	let j = i + 1;
	while (j < kids.length) {
		if (kids[j].name === 'TermItem') {
			items.push(kids[j]);
			j++;
		} else if (kids[j].name === 'Space' && kids[j + 1]?.name === 'TermItem') {
			j++;
		} else {
			break;
		}
	}
	const blocks = items.map((item) => {
		const markups = children(item).filter((c) => c.name === 'Markup');
		const title = el('term_title', null, markups[0] ? convertInline(children(markups[0]), src, []) : []);
		const desc = markups[1] ? convertMarkup(children(markups[1]), src).flatMap((s) => s.blocks) : [];
		return el('term_item', null, [title, ...ensureBlocks(desc)]);
	});
	return { seg: { blocks, from: items[0].from, to: items[items.length - 1].to }, next: j };
}

/**
 * The block walker: children of a Markup node -> block segments. Runs at the top level (where
 * the caller stamps orig) and inside list items (where it doesn't).
 */
function convertMarkup(kids: SyntaxNode[], src: string): Seg[] {
	const segs: Seg[] = [];
	let buf: SyntaxNode[] = [];

	const flushPara = () => {
		while (buf.length > 0 && buf[buf.length - 1].name === 'Space') buf.pop();
		if (buf.length === 0) return;
		const content = convertInline(buf, src, []);
		if (content.length > 0) {
			segs.push({
				blocks: [el('paragraph', { indent: 'auto' }, content)],
				from: buf[0].from,
				to: buf[buf.length - 1].to
			});
		}
		buf = [];
	};

	for (let i = 0; i < kids.length; i++) {
		const k = kids[i];
		switch (k.name) {
			case 'Parbreak':
				flushPara();
				break;
			case 'Space':
				if (buf.length > 0) buf.push(k); // leading whitespace is inter-block gap, not content
				break;
			case 'Heading':
				flushPara();
				segs.push(headingSeg(k, src));
				break;
			case 'ListItem':
			case 'EnumItem': {
				flushPara();
				const { seg, next } = listSeg(kids, i, src);
				segs.push(seg);
				i = next - 1;
				break;
			}
			case 'TermItem': {
				flushPara();
				const { seg, next } = termSeg(kids, i, src);
				segs.push(seg);
				i = next - 1;
				break;
			}
			case 'Raw': {
				const delim = k.firstChild;
				const isFence = delim != null && delim.name === 'RawDelim' && delim.to - delim.from >= 3;
				if (isFence && buf.length === 0) {
					const lang = childOf(k, 'RawLang');
					const last = k.lastChild;
					const innerFrom = (lang ?? delim).to;
					const innerTo = last && last.name === 'RawDelim' && last !== delim ? last.from : k.to;
					const content = src.slice(innerFrom, innerTo).replace(/^\n/, '').replace(/\n$/, '');
					const info = lang ? src.slice(lang.from, lang.to) : '';
					segs.push({
						blocks: [el('code_block', { lang: info || 'Typst', env: 'fence', args: info }, txtNodes(content))],
						from: k.from,
						to: k.to
					});
				} else {
					buf.push(k);
				}
				break;
			}
			case 'Hash': {
				const next = kids[i + 1];
				if (next && STATEMENT_KINDS.has(next.name)) {
					flushPara();
					segs.push({ blocks: [includeOrRaw(k, next, src)], from: k.from, to: next.to });
					i++;
				} else if (next && buf.length === 0) {
					const fig = figureSeg(kids, i, src) ?? tableSeg(kids, i, src) ?? quoteSeg(kids, i, src);
					if (fig) {
						segs.push(fig.seg);
						i = fig.next - 1;
					} else if (restOnlySpace(kids, i + 2) && src.slice(next.from, next.to) === 'line(length: 100%)') {
						// the canonical full-width divider, byte-exact; any other #line stays raw
						segs.push({ blocks: [el('horizontal_rule')], from: k.from, to: next.to });
						i++;
					} else if (restOnlySpace(kids, i + 2) && !linkParts(next, src) && !markCallParts(next, src)) {
						// a call standing alone in its paragraph (#lorem, unmodeled #figure): raw block.
						// links and mark calls are inline content even alone - a fully-underlined
						// paragraph serializes as a lone #underline[..] and must parse back as prose
						segs.push({ blocks: [rawBlock(src.slice(k.from, next.to))], from: k.from, to: next.to });
						i++;
					} else {
						buf.push(k);
					}
				} else {
					buf.push(k);
				}
				break;
			}
			case 'LineComment':
			case 'BlockComment':
				if (buf.length === 0) {
					segs.push({ blocks: [rawBlock(src.slice(k.from, k.to))], from: k.from, to: k.to });
				} else {
					buf.push(k);
				}
				break;
			case 'Equation': {
				// an optional trailing <label> belongs to the equation (typst attaches it to the
				// preceding block); it becomes the node's label attr so @refs can point at it
				let j = i + 1;
				while (kids[j]?.name === 'Space') j++;
				const labelNode = kids[j]?.name === 'Label' ? kids[j] : null;
				const after = labelNode ? j + 1 : i + 1;
				if (buf.length === 0 && restOnlySpace(kids, after)) {
					const latex = typstMathToLatex(k, src);
					const to = (labelNode ?? k).to;
					if (latex != null) {
						segs.push({
							blocks: [
								el(
									'block_math',
									{
										label: labelNode ? src.slice(labelNode.from + 1, labelNode.to - 1) : null,
										numbered: false,
										environment: null,
										lineLabels: [],
										typst: equationInner(k, src).trim(),
										latexOrig: latex
									},
									txtNodes(latex)
								)
							],
							from: k.from,
							to
						});
					} else {
						// untranslatable: the label rides inside the raw island, still byte-exact
						segs.push({ blocks: [rawBlock(src.slice(k.from, to))], from: k.from, to });
					}
					i = after - 1;
				} else {
					buf.push(k);
				}
				break;
			}
			default:
				buf.push(k);
		}
	}
	flushPara();
	return segs;
}

/** `image("path")` or `image("path", <anything>)`: the path plus the extra args verbatim, so
 *  width:/height:/fit: survive round trips untouched. Any other shape is not an image call. */
function imageCallParts(call: SyntaxNode, src: string): { src: string; options: string | null } | null {
	if (call.name !== 'FuncCall') return null;
	const ident = call.firstChild;
	if (!ident || ident.name !== 'Ident' || src.slice(ident.from, ident.to) !== 'image') return null;
	const args = ident.nextSibling;
	if (!args || args.name !== 'Args' || args.firstChild?.name !== 'LeftParen') return null;
	const kids = children(args);
	const rparen = kids[kids.length - 1];
	if (rparen.name !== 'RightParen') return null;
	const real = kids.filter((c) => !['LeftParen', 'RightParen', 'Space'].includes(c.name));
	if (real.length === 0 || real[0].name !== 'Str') return null;
	const path = unquote(src.slice(real[0].from, real[0].to));
	if (real.length === 1) return { src: path, options: null };
	if (real[1].name !== 'Comma') return null;
	const options = src.slice(real[1].to, rparen.from).trim();
	return { src: path, options: options || null };
}

interface FigureParts {
	img: { src: string; options: string | null };
	captionMarkup: SyntaxNode | null;
	isFigure: boolean;
}

/** `#figure(image(...), caption: [...])` (caption optional) or a bare `#image(...)`; anything
 *  richer — placement, scope, kind, a table body — stays raw. */
function figureParts(call: SyntaxNode, src: string): FigureParts | null {
	const bare = imageCallParts(call, src);
	if (bare) return { img: bare, captionMarkup: null, isFigure: false };
	if (call.name !== 'FuncCall') return null;
	const ident = call.firstChild;
	if (!ident || ident.name !== 'Ident' || src.slice(ident.from, ident.to) !== 'figure') return null;
	const args = ident.nextSibling;
	if (!args || args.name !== 'Args' || args.firstChild?.name !== 'LeftParen') return null;
	const real = children(args).filter((c) => !['LeftParen', 'RightParen', 'Comma', 'Space'].includes(c.name));
	if (real.length < 1 || real.length > 2) return null;
	const img = imageCallParts(real[0], src);
	if (!img) return null;
	let captionMarkup: SyntaxNode | null = null;
	if (real.length === 2) {
		const named = real[1];
		const nIdent = named.firstChild;
		if (named.name !== 'Named' || !nIdent || src.slice(nIdent.from, nIdent.to) !== 'caption') return null;
		const cb = childOf(named, 'ContentBlock');
		if (!cb) return null; // caption: "string" and friends: raw
		captionMarkup = childOf(cb, 'Markup');
	}
	return { img, captionMarkup, isFigure: true };
}

/** `#figure(table(...), caption: [...])`: the table-figure sibling of figureParts. */
function tableFigureParts(call: SyntaxNode, src: string): { table: TableParts; captionMarkup: SyntaxNode | null } | null {
	if (call.name !== 'FuncCall') return null;
	const ident = call.firstChild;
	if (!ident || ident.name !== 'Ident' || src.slice(ident.from, ident.to) !== 'figure') return null;
	const args = ident.nextSibling;
	if (!args || args.name !== 'Args' || args.firstChild?.name !== 'LeftParen') return null;
	const real = children(args).filter((c) => !ARG_PUNCT.includes(c.name));
	if (real.length < 1 || real.length > 2) return null;
	const table = tableParts(real[0], src);
	if (!table) return null;
	let captionMarkup: SyntaxNode | null = null;
	if (real.length === 2) {
		const named = real[1];
		const nIdent = named.firstChild;
		if (named.name !== 'Named' || !nIdent || src.slice(nIdent.from, nIdent.to) !== 'caption') return null;
		const cb = childOf(named, 'ContentBlock');
		if (!cb) return null;
		captionMarkup = childOf(cb, 'Markup');
	}
	return { table, captionMarkup };
}

/**
 * A `#figure(image(...))` / `#image(...)` / `#figure(table(...))` standing alone in its
 * paragraph, with an optional trailing `<label>`, becomes a real node. Null when the shape is
 * richer than the serializer can re-emit — the caller falls back to a raw block.
 */
function figureSeg(kids: SyntaxNode[], i: number, src: string): { seg: Seg; next: number } | null {
	const hash = kids[i];
	const call = kids[i + 1];
	const parts = figureParts(call, src);
	const tParts = parts ? null : tableFigureParts(call, src);
	if (!parts && !tParts) return null;
	let j = i + 2;
	if (kids[j]?.name === 'Space' && kids[j + 1]?.name === 'Label') j++;
	let labelNode: SyntaxNode | null = null;
	if (kids[j]?.name === 'Label') {
		labelNode = kids[j];
		j++;
	}
	if (!restOnlySpace(kids, j)) return null;
	const label = labelNode ? src.slice(labelNode.from + 1, labelNode.to - 1) : null;
	let node: PMNode;
	if (parts) {
		const caption = parts.captionMarkup ? convertInline(children(parts.captionMarkup), src, []) : [];
		node = el(
			'image',
			{
				src: parts.img.src,
				options: parts.img.options,
				label,
				numbered: parts.isFigure,
				showCaption: caption.length > 0
			},
			caption
		);
	} else {
		const table = buildTableNode(tParts!.table);
		if (!table) return null;
		const caption = tParts!.captionMarkup ? convertInline(children(tParts!.captionMarkup), src, []) : [];
		node = el('table_wrapper', { label, showNotes: false }, [el('table_caption', null, caption), table]);
	}
	const to = (labelNode ?? call).to;
	return { seg: { blocks: [node], from: hash.from, to }, next: j };
}

const ARG_PUNCT = ['LeftParen', 'RightParen', 'Comma', 'Space'];

/** a `[content]` argument -> one table cell; anything else is not a cell. */
function contentBlockCell(cb: SyntaxNode, src: string, headerCell: boolean): PMNode | null {
	if (cb.name !== 'ContentBlock') return null;
	const markup = childOf(cb, 'Markup');
	const blocks = markup ? convertMarkup(children(markup), src).flatMap((s) => s.blocks) : [];
	return el(headerCell ? 'table_header' : 'table_cell', null, ensureBlocks(blocks));
}

/** `columns: 3` or `columns: (auto, 1fr, ...)` -> how many columns the cell stream wraps at. */
function columnCount(value: SyntaxNode, src: string): number | null {
	if (value.name === 'Int') {
		const n = parseInt(src.slice(value.from, value.to), 10);
		return Number.isFinite(n) && n > 0 && n <= 100 ? n : null;
	}
	if (value.name === 'Array') {
		const elems = children(value).filter((c) => !ARG_PUNCT.includes(c.name));
		return elems.length > 0 ? elems.length : null;
	}
	return null;
}

interface TableParts {
	/** the columns: value, verbatim, so track sizes (auto, 1fr, 2cm) survive round trips */
	colspec: string;
	/** the align: value, verbatim, when the source had one */
	align: string | null;
	header: PMNode[] | null;
	rows: PMNode[][];
}

/**
 * The simple-grid subset: `#table(columns: ..., [cell], [cell], ...)`, optionally with an
 * `align:` right after and one leading `table.header(...)`. Any other argument — stroke:,
 * fill:, gutter:, spanned cells, spreads — means the call stays a raw island the serializer
 * can't damage.
 */
function tableParts(call: SyntaxNode, src: string): TableParts | null {
	if (call.name !== 'FuncCall') return null;
	const ident = call.firstChild;
	if (!ident || ident.name !== 'Ident' || src.slice(ident.from, ident.to) !== 'table') return null;
	const args = ident.nextSibling;
	if (!args || args.name !== 'Args' || args.firstChild?.name !== 'LeftParen') return null;
	const real = children(args).filter((c) => !ARG_PUNCT.includes(c.name));
	const colArg = real[0];
	if (!colArg || colArg.name !== 'Named') return null;
	const cIdent = colArg.firstChild;
	if (!cIdent || cIdent.name !== 'Ident' || src.slice(cIdent.from, cIdent.to) !== 'columns') return null;
	const value = children(colArg).find((c) => !['Ident', 'Colon', 'Space'].includes(c.name));
	if (!value) return null;
	const cols = columnCount(value, src);
	if (cols == null) return null;

	let idx = 1;
	let align: string | null = null;
	const maybeAlign = real[1];
	if (maybeAlign?.name === 'Named') {
		const aIdent = maybeAlign.firstChild;
		if (!aIdent || aIdent.name !== 'Ident' || src.slice(aIdent.from, aIdent.to) !== 'align') return null;
		const aValue = children(maybeAlign).find((c) => !['Ident', 'Colon', 'Space'].includes(c.name));
		if (!aValue || !['Array', 'Ident', 'FieldAccess'].includes(aValue.name)) return null;
		align = src.slice(aValue.from, aValue.to);
		idx = 2;
	}

	let header: PMNode[] | null = null;
	const h = real[idx];
	if (h?.name === 'FuncCall' && h.firstChild?.name === 'FieldAccess' && src.slice(h.firstChild.from, h.firstChild.to) === 'table.header') {
		const hArgs = h.firstChild.nextSibling;
		if (!hArgs || hArgs.name !== 'Args') return null;
		header = [];
		for (const cell of children(hArgs).filter((c) => !ARG_PUNCT.includes(c.name))) {
			const n = contentBlockCell(cell, src, true);
			if (!n) return null;
			header.push(n);
		}
		if (header.length > cols) return null;
		while (header.length < cols) header.push(el('table_header', null, [el('paragraph')]));
		idx++;
	}

	const flat: PMNode[] = [];
	for (; idx < real.length; idx++) {
		const n = contentBlockCell(real[idx], src, false);
		if (!n) return null;
		flat.push(n);
	}
	if (flat.length === 0 && !header) return null;
	const rows: PMNode[][] = [];
	for (let r = 0; r < flat.length; r += cols) rows.push(flat.slice(r, r + cols));
	// pad the last row so the grid stays rectangular (PM tables need it; typst tolerates it)
	const last = rows[rows.length - 1];
	if (last) while (last.length < cols) last.push(el('table_cell', null, [el('paragraph')]));
	return { colspec: src.slice(value.from, value.to), align, header, rows };
}

function buildTableNode(t: TableParts): PMNode | null {
	const rowNodes: PMNode[] = [];
	if (t.header) rowNodes.push(el('table_row', { topRules: '' }, t.header));
	for (const r of t.rows) rowNodes.push(el('table_row', { topRules: '' }, r));
	if (rowNodes.length === 0) return null;
	return el('table', { env: null, colspec: t.colspec, typAlign: t.align }, rowNodes);
}

/** a `#table(...)` standing alone in its paragraph becomes a real, editable table node. */
function tableSeg(kids: SyntaxNode[], i: number, src: string): { seg: Seg; next: number } | null {
	const hash = kids[i];
	const call = kids[i + 1];
	if (!call || !restOnlySpace(kids, i + 2)) return null;
	const t = tableParts(call, src);
	if (!t) return null;
	const node = buildTableNode(t);
	if (!node) return null;
	return { seg: { blocks: [node], from: hash.from, to: call.to }, next: i + 2 };
}

/** `#quote(block: true)[...]` standing alone becomes a blockquote; any other quote stays raw. */
function quoteSeg(kids: SyntaxNode[], i: number, src: string): { seg: Seg; next: number } | null {
	const hash = kids[i];
	const call = kids[i + 1];
	if (!call || !restOnlySpace(kids, i + 2)) return null;
	if (call.name !== 'FuncCall') return null;
	const ident = call.firstChild;
	if (!ident || ident.name !== 'Ident' || src.slice(ident.from, ident.to) !== 'quote') return null;
	const args = ident.nextSibling;
	if (!args || args.name !== 'Args') return null;
	const real = children(args).filter((c) => !ARG_PUNCT.includes(c.name));
	if (real.length !== 2 || real[0].name !== 'Named' || real[1].name !== 'ContentBlock') return null;
	const nIdent = real[0].firstChild;
	if (!nIdent || nIdent.name !== 'Ident' || src.slice(nIdent.from, nIdent.to) !== 'block') return null;
	const bool = children(real[0]).find((c) => c.name === 'Bool');
	if (!bool || src.slice(bool.from, bool.to) !== 'true') return null;
	const markup = childOf(real[1], 'Markup');
	const blocks = markup ? convertMarkup(children(markup), src).flatMap((s) => s.blocks) : [];
	return { seg: { blocks: [el('blockquote', null, ensureBlocks(blocks))], from: hash.from, to: call.to }, next: i + 2 };
}

/**
 * `#include "chapter.typ"` and nothing fancier becomes a navigable chip; any other include form
 * (expressions, missing extension, import-like paths) stays a raw block. The path keeps its
 * extension because Typst requires it — the chip's opener defaults to .typ only as a fallback.
 */
function includeOrRaw(hash: SyntaxNode, stmt: SyntaxNode, src: string): PMNode {
	if (stmt.name === 'ModuleInclude') {
		const real = children(stmt).filter((c) => !['Include', 'Space'].includes(c.name));
		if (real.length === 1 && real[0].name === 'Str') {
			const path = unquote(src.slice(real[0].from, real[0].to));
			if (/\.typ$/i.test(path)) return el('includedoc', { path, command: 'typst' });
		}
	}
	return rawBlock(src.slice(hash.from, stmt.to));
}

/** Recreate `node` with an `orig` attr; types that don't declare it pass through unchanged. */
function withOrig(node: PMNode, orig: Record<string, unknown>): PMNode {
	if (!node.type.spec.attrs || !('orig' in node.type.spec.attrs)) return node;
	return node.type.create({ ...node.attrs, orig }, node.content, node.marks);
}

export interface TypstParseResult {
	doc: PMNode;
}

export function typstToProseMirror(source: string): TypstParseResult {
	const kids = children(parseTree(source).topNode);
	const segs = convertMarkup(kids, source);

	// stamp-and-push, the shared pushBlocks contract: every block gets a seq; multi-block
	// constructs (a list run) share a group so verbatim substitution is all-or-nothing
	const result: PMNode[] = [];
	let seq = 0;
	let prevEnd = 0;
	let group = 0;
	for (const s of segs) {
		if (s.blocks.length === 0) continue;
		const spanOk = s.from >= prevEnd && s.to <= source.length && s.from < s.to;
		const slice = spanOk ? source.slice(s.from, s.to) : null;
		const pre = spanOk ? source.slice(prevEnd, s.from) : null;
		const g = spanOk && s.blocks.length > 1 ? group++ : null;
		for (let b = 0; b < s.blocks.length; b++) {
			const sq = seq++;
			if (slice == null) {
				result.push(withOrig(s.blocks[b], { seq: sq }));
				continue;
			}
			const orig: Record<string, unknown> = { latex: slice, pre: b === 0 ? pre : '', seq: sq, norm: null, start: s.from };
			if (g != null) {
				orig.group = g;
				orig.groupIndex = b;
				orig.groupSize = s.blocks.length;
			}
			result.push(withOrig(s.blocks[b], orig));
		}
		if (spanOk) prevEnd = Math.max(prevEnd, s.to);
	}

	// an empty or whitespace-only file still needs one paragraph (doc content is block+); its
	// bytes ride along as the paragraph's protected leading gap, so even "\r\n" round-trips
	if (result.length === 0) {
		const orig = { latex: '', pre: source, seq: 0, norm: null, start: source.length };
		return { doc: el('doc', { docTail: { text: '', afterSeq: 0 } }, [withOrig(el('paragraph', { indent: 'auto' }), orig)]) };
	}

	// trailing bytes past the last block belong to no node; stash them so a pristine save
	// reproduces the file's exact tail (an EMPTY tail protects a missing final newline too)
	return { doc: el('doc', { docTail: { text: source.slice(prevEnd), afterSeq: seq - 1 } }, result) };
}
