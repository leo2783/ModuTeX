import { Fragment, Schema, type Node as VisualNode } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';
import { parseTable } from '../tables/source.ts';
import { mapPosition, projectionIsCurrent, type SourceDocument, type SourceProjection, type SyntaxNode, type SourcePatch, type SourceChange } from '@modutex/document-core';

const anchors = { from: {}, to: {}, editFrom: {}, editTo: {}, role: { default: 'paragraph' }, name: { default: '' }, level: { default: 2 } };
const visualFormatMarks: Record<string, string> = { textbf: 'strong', textit: 'em', emph: 'em', underline: 'underline' };
const visualMarkCommands: Record<string, string> = { strong: 'textbf', em: 'textit', underline: 'underline' };
const visualMarkOrder = ['strong', 'em', 'underline'] as const;
/** Original bounded source projection. No application schema or converter imported. */
export const visualSchema = new Schema({ nodes: {
	doc: { content: 'block*' },
	text: { group: 'inline' },
	source_block: { group: 'block', content: 'inline*', marks: 'strong em underline', attrs: anchors,
		toDOM(node) {
			const tag = node.attrs.role === 'heading' ? 'h' + Math.max(1, Math.min(6, Number(node.attrs.level) || 2)) : 'p';
			return [tag, { class: 'source-block', 'data-source-role': node.attrs.role }, 0];
		} },
	table_block: { group: 'block', atom: true, selectable: true, attrs: { ...anchors, source: {} },
		toDOM(node) { return ['pre', { contenteditable: 'false' }, String(node.attrs.source)]; } },
	math_block: { group: 'block', atom: true, selectable: true, attrs: { ...anchors, source: {}, latex: {}, inline: {} },
		toDOM(node) { return ['pre', { class: 'visual-math-source', contenteditable: 'false' }, String(node.attrs.source)]; } },
	math_inline: { group: 'inline', inline: true, atom: true, selectable: true, attrs: { ...anchors, source: {}, latex: {}, inline: { default: true } },
		toDOM(node) { return ['span', { class: 'visual-math-inline-source', contenteditable: 'false' }, String(node.attrs.source)]; } },
	raw_block: { group: 'block', atom: true, selectable: true, attrs: { ...anchors, source: {} },
		toDOM(node) { return ['pre', { class: 'raw-latex', contenteditable: 'false', 'aria-label': 'Raw LaTeX' }, String(node.attrs.source)]; } }
}, marks: {
	strong: { toDOM: () => ['strong', 0] },
	em: { toDOM: () => ['em', 0] },
	underline: { toDOM: () => ['u', 0] }
} });

interface InlineSegment {
	readonly from: number; readonly to: number; readonly editFrom: number; readonly editTo: number;
	readonly boundaries: readonly number[]; readonly marks: readonly string[];
	readonly wrapped: boolean; readonly wrappers: readonly InlineWrapper[];
	readonly atom?: boolean;
}
interface InlineWrapper { readonly open: string; readonly close: string; readonly safe: boolean }

export interface VisualProjection {
	readonly documentId: string; readonly version: number; readonly document: VisualNode;
	/** Presentation snapshot: source-coordinate changes never invalidate unchanged DOM nodes. */
	readonly viewDocument?: VisualNode;
	/** Relative source offset at every visual UTF-16 boundary; formatted blocks use segments, Raw has neither. */
	readonly boundaries: readonly (readonly number[] | null)[];
	readonly segments?: readonly (readonly InlineSegment[] | null)[];
}
const normalized = (value: string) => value.replace(/\r\n|\r/g, '\n');
function sourceWrapper(source: SourceDocument, node: SyntaxNode): InlineWrapper {
	const open = source.read(node.span.from, node.content!.from), close = source.read(node.content!.to, node.span.to);
	return Object.freeze({ open, close, safe: Object.hasOwn(visualFormatMarks, node.name) && open === `\\${node.name}{` && close === '}' });
}
function canonicalWrappers(marks: readonly string[]): readonly InlineWrapper[] {
	return Object.freeze(visualMarkOrder.filter(mark => marks.includes(mark)).map(mark => Object.freeze({
		open: `\\${visualMarkCommands[mark]}{`, close: '}', safe: true
	})));
}
function sameMarkSet(left: readonly string[], right: readonly string[]): boolean {
	const a = new Set(left), b = new Set(right);
	return a.size === b.size && [...a].every(mark => b.has(mark));
}
function literalBoundaries(value: string): readonly number[] {
	const result = [0];
	for (let index = 0; index < value.length; index++) {
		if (value[index] === '\r' && value[index + 1] === '\n') index++;
		result.push(index + 1);
	}
	return Object.freeze(result);
}
const decodedEscapes: Record<string, string> = { '\\%': '%', '\\&': '&', '\\$': '$', '\\#': '#', '\\_': '_', '\\{': '{', '\\}': '}',
	'\\textbackslash{}': '\\', '\\textasciicircum{}': '^', '\\textasciitilde{}': '~' };
function decodePlain(source: SourceDocument, nodes: readonly SyntaxNode[], from: number, to: number): { text: string; boundaries: readonly number[] } | null {
	let text = '', cursor = from; const boundaries = [0];
	for (const node of nodes) {
		if (node.span.from !== cursor) return null;
		const original = source.read(node.span.from, node.span.to);
		if (node.kind === 'text') {
			text += normalized(original);
			for (const offset of literalBoundaries(original).slice(1)) boundaries.push(cursor - from + offset);
		} else if (node.kind === 'raw' && Object.hasOwn(decodedEscapes, original)) {
			text += decodedEscapes[original]!; boundaries.push(node.span.to - from);
		} else return null;
		cursor = node.span.to;
	}
	return cursor === to ? { text, boundaries: Object.freeze(boundaries) } : null;
}
/** Known inline wrappers only. Unknown content makes its enclosing group Raw, never guessed. */
function decodeInline(source: SourceDocument, nodes: readonly SyntaxNode[]): { content: Fragment; segments: readonly InlineSegment[] } | null {
	const children: VisualNode[] = [], segments: InlineSegment[] = []; let offset = 0;
	const walk = (nodes: readonly SyntaxNode[], marks: readonly string[], wrappers: readonly InlineWrapper[], wrapped = false): boolean => {
		let plain: SyntaxNode[] = [];
		const flush = () => {
			if (!plain.length) return true;
			const from = plain[0]!.span.from, to = plain.at(-1)!.span.to;
			const decoded = decodePlain(source, plain, from, to); if (!decoded) return false;
			if (decoded.text) children.push(visualSchema.text(decoded.text, marks.map((name) => visualSchema.marks[name]!.create())));
			segments.push(Object.freeze({ from: offset, to: offset + decoded.text.length, editFrom: from, editTo: to,
				boundaries: decoded.boundaries, marks: Object.freeze([...marks]), wrapped, wrappers: Object.freeze([...wrappers]) }));
			offset += decoded.text.length; plain = []; return true;
		};
		for (const node of nodes) {
			if (node.kind === 'text' || node.kind === 'raw' && Object.hasOwn(decodedEscapes, source.read(node.span.from, node.span.to))) { plain.push(node); continue; }
			if (!flush()) return false;
			if (node.kind === 'math' && node.content && node.content.to - node.content.from <= 65536 && ['$', '('].includes(node.name)) {
				// Empty text boundaries permit genuine typing before/after a formula,
				// including paragraphs containing only a single inline atom.
				segments.push(Object.freeze({ from: offset, to: offset, editFrom: node.span.from, editTo: node.span.from,
					boundaries: Object.freeze([0]), marks: Object.freeze([...marks]), wrapped: true, wrappers: Object.freeze([...wrappers]) }));
				children.push(visualSchema.nodes.math_inline!.create({ from: node.span.from, to: node.span.to, editFrom: node.content.from, editTo: node.content.to,
					source: source.read(node.span.from, node.span.to), latex: source.read(node.content.from, node.content.to), inline: true }, undefined, marks.map((name) => visualSchema.marks[name]!.create())));
				segments.push(Object.freeze({ from: offset, to: offset + 1, editFrom: node.span.from, editTo: node.span.to,
					boundaries: Object.freeze([0, node.span.to - node.span.from]), marks: Object.freeze([...marks]), wrapped,
					wrappers: Object.freeze([...wrappers]), atom: true }));
				offset++;
				segments.push(Object.freeze({ from: offset, to: offset, editFrom: node.span.to, editTo: node.span.to,
					boundaries: Object.freeze([0]), marks: Object.freeze([...marks]), wrapped: true, wrappers: Object.freeze([...wrappers]) }));
				continue;
			}
			if (node.kind !== 'format' || !node.content) return false;
			const name = visualFormatMarks[node.name];
			if (!name) return false;
			const nested = node.name === 'emph' && marks.includes('em') ? marks.filter((mark) => mark !== 'em') : [...new Set([...marks, name])];
			const nestedWrappers = Object.freeze([...wrappers, sourceWrapper(source, node)]);
			if (!walk(node.children, nested, nestedWrappers, true)) return false;
			if (!node.children.length) segments.push(Object.freeze({ from: offset, to: offset, editFrom: node.content.from, editTo: node.content.to,
				boundaries: Object.freeze([0]), marks: Object.freeze(nested), wrapped: true, wrappers: nestedWrappers }));
		}
		return flush();
	};
	return walk(nodes, [], []) ? { content: Fragment.from(children), segments: Object.freeze(segments) } : null;
}
export function projectVisual(source: SourceDocument, parsed: SourceProjection): VisualProjection {
	if (!projectionIsCurrent(source, parsed)) throw new Error('STALE_VISUAL');
	const blocks: VisualNode[] = [];
	const boundaries: (readonly number[] | null)[] = [];
	const segments: (readonly InlineSegment[] | null)[] = [];
	const add = (node: SyntaxNode) => {
		if (node.kind === 'environment' && node.name === 'document') { for (const child of node.children) add(child); return; }
		const content = node.kind === 'text' ? node.span : node.content;
		const attrs = { from: node.span.from, to: node.span.to, editFrom: content?.from ?? node.span.from,
			editTo: content?.to ?? node.span.to, role: node.kind === 'heading' ? 'heading' : node.kind === 'format' ? 'format' : 'paragraph', name: node.name,
			level: ({ title: 1, section: 2, subsection: 3, subsubsection: 4 } as Record<string, number>)[node.name.replace(/\*$/, '')] ?? 2 };
		if (node.kind === 'math' && node.content && node.content.to - node.content.from <= 65536 && ['$', '$$', '(', '['].includes(node.name)) {
			boundaries.push(null); segments.push(null);
			blocks.push(visualSchema.nodes.math_block!.create({ ...attrs, source: source.read(node.span.from, node.span.to), latex: source.read(node.content.from, node.content.to), inline: node.name === '$' || node.name === '(' })); return;
		}
		if (['center', 'table'].includes(node.name) && ['environment', 'raw'].includes(node.kind)) {
			const value = source.read(node.span.from, node.span.to);
			if (parseTable(value)) { boundaries.push(null); segments.push(null); blocks.push(visualSchema.nodes.table_block!.create({ ...attrs, source: value })); return; }
		}
		if (content && node.kind === 'format') {
			const inline = decodeInline(source, [node]);
			if (inline) {
				boundaries.push(null); segments.push(inline.segments);
				blocks.push(visualSchema.nodes.source_block!.create(attrs, inline.content));
			} else {
				boundaries.push(null); segments.push(null);
				blocks.push(visualSchema.nodes.raw_block!.create({ ...attrs, source: source.read(node.span.from, node.span.to) }));
			}
			return;
		}
		if (content && node.kind === 'heading' && node.children.some((child) => child.kind === 'format' || child.kind === 'math')) {
			const inline = decodeInline(source, node.children);
			if (inline) { boundaries.push(null); segments.push(inline.segments); blocks.push(visualSchema.nodes.source_block!.create(attrs, inline.content)); return; }
		}
		if (node.kind === 'raw' && node.content === null && ['null', 'par'].includes(node.name) && source.read(node.span.from, node.span.to) === '\\' + node.name) {
			boundaries.push(Object.freeze([0]));
			segments.push(null);
			blocks.push(visualSchema.nodes.source_block!.create({ ...attrs, editFrom: node.name === 'par' ? node.span.to : node.span.from, editTo: node.span.to }));
			return;
		}
		const plain = content && ['text', 'heading'].includes(node.kind) ? decodePlain(source, node.kind === 'text' ? [node] : node.children, content.from, content.to) : null;
		if (plain) {
			segments.push(null);
			boundaries.push(plain.boundaries);
			blocks.push(visualSchema.nodes.source_block!.create(attrs, plain.text ? visualSchema.text(plain.text) : undefined));
		} else { boundaries.push(null); segments.push(null); blocks.push(visualSchema.nodes.raw_block!.create({ ...attrs, source: source.read(node.span.from, node.span.to) })); }
	};
	const body = parsed.nodes.find((node) => node.kind === 'environment' && node.name === 'document');
	let plainNodes: SyntaxNode[] = [];
	let paragraphMarker: SyntaxNode | null = null;
	const flush = () => {
		if (!plainNodes.length) { if (paragraphMarker) add(paragraphMarker); paragraphMarker = null; return; }
		const from = plainNodes[0]!.span.from, to = plainNodes.at(-1)!.span.to;
		if (!paragraphMarker && plainNodes.every(node => node.kind === 'text') && !source.read(from, to).trim()) { plainNodes = []; return; }
		const attrs = { from: paragraphMarker?.span.from ?? from, to, editFrom: from, editTo: to, name: paragraphMarker ? 'par' : '' };
		paragraphMarker = null;
		if (plainNodes.some((node) => node.kind === 'format' || node.kind === 'math')) {
			const inline = decodeInline(source, plainNodes)!;
			blocks.push(visualSchema.nodes.source_block!.create(attrs, inline.content));
			boundaries.push(null); segments.push(inline.segments); plainNodes = []; return;
		}
		const plain = decodePlain(source, plainNodes, from, to)!;
		blocks.push(visualSchema.nodes.source_block!.create(attrs, plain.text ? visualSchema.text(plain.text) : undefined));
		boundaries.push(plain.boundaries); segments.push(null); plainNodes = [];
	};
	for (const node of body ? body.children : parsed.nodes) {
		if (node.kind === 'raw' && node.name === 'par' && node.content === null && source.read(node.span.from, node.span.to) === '\\par') { flush(); paragraphMarker = node; continue; }
		if (node.kind === 'text' || (node.kind === 'raw' && Object.hasOwn(decodedEscapes, source.read(node.span.from, node.span.to))) || (node.kind === 'format' || node.kind === 'math' && ['$', '('].includes(node.name)) && decodeInline(source, [node])) plainNodes.push(node);
		else { flush(); add(node); }
	}
	flush();
	if (!blocks.length) {
		const from = body?.content ? body.content.from : 0;
		const to = body?.content ? body.content.to : source.length;
		boundaries.push(Object.freeze([0]));
		segments.push(null);
		blocks.push(visualSchema.nodes.source_block!.create({
			from, to, editFrom: from, editTo: to,
			role: 'paragraph', name: '', level: 2
		}));
	}
	return { documentId: source.documentId, version: source.version, document: visualSchema.nodes.doc!.create(null, blocks), boundaries: Object.freeze(boundaries), segments: Object.freeze(segments) };
}
const escaped: Record<string, string> = { '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '%': '\\%', '&': '\\&', '#': '\\#', '_': '\\_', '^': '\\textasciicircum{}', '~': '\\textasciitilde{}' };
export function escapeVisualText(value: string): string { return normalized(value).replace(/[\\{}$%&#_^~]/g, (character) => escaped[character]!); }
function encodedBoundaries(value: string, lineEnding: string): readonly number[] {
	const result = [0]; let offset = 0;
	for (let index = 0; index < value.length; index++) {
		const character = value[index]!;
		if (/[\uD800-\uDBFF]/.test(character) && index + 1 < value.length && /[\uDC00-\uDFFF]/.test(value[index + 1]!)) {
			result.push(offset + 1); offset += 2; index++; result.push(offset);
		} else {
			offset += character === '\n' ? lineEnding.length : escapeVisualText(character).length;
			result.push(offset);
		}
	}
	return Object.freeze(result);
}
function scalarBoundary(value: string, position: number): boolean {
	return !(position > 0 && position < value.length && /[\uD800-\uDBFF]/.test(value[position - 1]!) && /[\uDC00-\uDFFF]/.test(value[position]!));
}
function plainSegment(projection: VisualProjection, index: number, block: VisualNode): InlineSegment | null {
	if (block.type.name !== 'source_block') return null;
	const boundaries = projection.boundaries[index];
	if (!boundaries) return null;
	const value = block.textBetween(0, block.content.size, '', '\ufffc');
	const anchored = projection.document.child(index);
	const editFrom = anchored.attrs.editFrom, editTo = anchored.attrs.editTo;
	if (boundaries.length !== value.length + 1 || boundaries[0] !== 0 || typeof editFrom !== 'number' ||
		typeof editTo !== 'number' || boundaries.at(-1) !== editTo - editFrom) return null;
	return Object.freeze({ from: 0, to: value.length, editFrom, editTo, boundaries,
		marks: Object.freeze([]), wrapped: false, wrappers: Object.freeze([]) });
}
function segmentsForBlock(projection: VisualProjection, index: number, block: VisualNode): readonly InlineSegment[] | null {
	const existing = projection.segments?.[index];
	if (existing !== null && existing !== undefined) return existing;
	const plain = plainSegment(projection, index, block);
	return plain ? Object.freeze([plain]) : null;
}
export type VisualCaretSide = 'right' | 'left' | 'atom';
export interface VisualCaretAnchor {
	readonly segment: number; readonly from: number; readonly marks: readonly string[]; readonly safeToSplit: boolean;
}
/** Map a collapsed visual caret through the same literal segments used by text edits. */
export function visualCaretAnchor(
	projection: VisualProjection, index: number, block: VisualNode, offset: number,
	side: VisualCaretSide, contextMarks: readonly string[]
): VisualCaretAnchor | null {
	const segments = segmentsForBlock(projection, index, block);
	if (!segments) return null;
	const value = block.textBetween(0, block.content.size, '', '\ufffc');
	if (!Number.isInteger(offset) || offset < 0 || offset > value.length || !scalarBoundary(value, offset)) return null;
	let candidates = segments.map((segment, ordinal) => ({ segment, ordinal })).filter(({ segment }) =>
		!segment.atom && segment.from <= offset && segment.to >= offset &&
		segment.boundaries[offset - segment.from] !== undefined);
	if (!candidates.length) return null;
	const contextual = candidates.filter(({ segment }) => sameMarkSet(segment.marks, contextMarks));
	if (contextual.length) candidates = contextual;
	if (side === 'right') {
		const right = candidates.filter(({ segment }) => segment.to > offset);
		if (right.length) candidates = right;
	} else if (side === 'left') {
		const left = candidates.filter(({ segment }) => segment.from < offset);
		if (left.length) candidates = left;
	} else {
		const empty = candidates.filter(({ segment }) => segment.from === offset && segment.to === offset);
		if (empty.length) candidates = empty;
	}
	const { segment, ordinal } = candidates[0]!;
	return Object.freeze({ segment: ordinal, from: segment.editFrom + segment.boundaries[offset - segment.from]!,
		marks: segment.marks, safeToSplit: segment.wrappers.every(wrapper => wrapper.safe) });
}
/** Text edits only: preserve every untouched range; structural/Raw edits await explicit commands. */
interface MarkedInsertion {
	readonly textFrom: number; readonly textTo: number; readonly boundaries: readonly number[];
	readonly marks: readonly string[]; readonly wrappers: readonly InlineWrapper[];
}
interface BlockEdit {
	readonly index: number; readonly segment?: number; readonly from: number; readonly to: number; readonly insert: string;
	readonly patch: SourcePatch; readonly markedInsertion?: MarkedInsertion;
}
export interface PreparedVisualEdit {
	readonly source: SourceDocument; readonly projection: VisualProjection; readonly transaction: Transaction;
	readonly before: VisualNode; readonly document: VisualNode;
	readonly edits: readonly BlockEdit[]; readonly patches: readonly SourcePatch[];
}
function insertedMarkNames(fragment: Fragment, expected: string): readonly string[] | null {
	let value = '', marks: readonly string[] | null = null, valid = true;
	fragment.forEach(node => {
		if (!node.isText) { valid = false; return; }
		value += node.text ?? '';
		const names = node.marks.map(mark => mark.type.name);
		if (names.some(name => !Object.hasOwn(visualMarkCommands, name)) || marks && !sameMarkSet(marks, names)) valid = false;
		if (marks === null) marks = names;
	});
	if (!valid || value !== expected || marks === null) return null;
	return Object.freeze(visualMarkOrder.filter(mark => marks!.includes(mark)));
}
function markedTextInsertion(
	source: SourceDocument, projection: VisualProjection, transaction: Transaction, index: number, before: VisualNode,
	oldStart: number, from: number, oldTo: number, newTo: number, inserted: string,
	segments: readonly InlineSegment[], actual: readonly { readonly from: number; readonly to: number }[]
): BlockEdit {
	if (from !== oldTo || !inserted || inserted.includes('\n') || actual.length !== 1) throw new Error('VISUAL_INLINE_BOUNDARY');
	const fragment = transaction.doc.child(index).content.cut(from, newTo);
	const marks = insertedMarkNames(fragment, inserted);
	if (!marks) throw new Error('VISUAL_INLINE_MARKS');
	const expected = before.content.cut(0, from).append(fragment).append(before.content.cut(oldTo));
	if (!expected.eq(transaction.doc.child(index).content)) throw new Error('VISUAL_STRUCTURE');
	const oldCaret = transaction.before.resolve(oldStart + from);
	const side: VisualCaretSide = oldCaret.nodeAfter?.isAtom ? 'atom' : oldCaret.nodeAfter?.isText ? 'right'
		: oldCaret.nodeBefore?.isText ? 'left' : 'atom';
	const anchor = visualCaretAnchor(projection, index, before, from, side, oldCaret.marks().map(mark => mark.type.name));
	if (!anchor || anchor.segment >= segments.length) throw new Error('VISUAL_INLINE_BOUNDARY');
	const segment = segments[anchor.segment]!, local = from - segment.from;
	if (local < 0 || local >= segment.boundaries.length || sameMarkSet(segment.marks, marks) ||
		!segment.wrappers.every(wrapper => wrapper.safe)) throw new Error('VISUAL_INLINE_BOUNDARY');
	const sourcePoint = segment.editFrom + segment.boundaries[local]!;
	if (sourcePoint !== anchor.from || !Number.isSafeInteger(sourcePoint) || sourcePoint < 0 || sourcePoint > source.length) {
		throw new Error('VISUAL_MAPPING');
	}
	if (!transaction.selection.empty || transaction.selection.from !== transaction.mapping.map(oldStart + from, 1)) {
		throw new Error('VISUAL_INLINE_BOUNDARY');
	}

	const encoded = escapeVisualText(inserted).replaceAll('\n', source.profile.preferredLineEnding);
	const wrappers = canonicalWrappers(marks);
	const closeExisting = [...segment.wrappers].reverse().map(wrapper => wrapper.close).join('');
	const openExisting = segment.wrappers.map(wrapper => wrapper.open).join('');
	const openInserted = wrappers.map(wrapper => wrapper.open).join('');
	const closeInserted = [...wrappers].reverse().map(wrapper => wrapper.close).join('');
	const textFrom = closeExisting.length + openInserted.length, textTo = textFrom + encoded.length;
	const replacement = closeExisting + openInserted + encoded + closeInserted + openExisting;
	return {
		index, segment: anchor.segment, from, to: oldTo, insert: inserted,
		patch: { from: sourcePoint, to: sourcePoint, expected: source.read(sourcePoint, sourcePoint), insert: replacement },
		markedInsertion: { textFrom, textTo, boundaries: encodedBoundaries(inserted, source.profile.preferredLineEnding), marks, wrappers }
	};
}
function blockEdits(source: SourceDocument, projection: VisualProjection, transaction: Transaction): readonly BlockEdit[] {
	if (source.documentId !== projection.documentId || source.version !== projection.version ||
		!transaction.before.eq(projection.document) && !transaction.before.eq(projection.viewDocument ?? projection.document)) throw new Error('STALE_VISUAL');
	if (!transaction.docChanged) return [];
	if (transaction.doc.childCount !== projection.document.childCount) throw new Error('VISUAL_STRUCTURE');
	const edits: BlockEdit[] = [];
	// Keep the actual edit coordinates: a textual diff can move a deletion across
	// repeated text and consequently across a TeX wrapper boundary.
	const ranges: { from: number; to: number }[] = [];
	const localRanges = new Map<number, { start: number; ranges: { from: number; to: number }[] }>();
	// A length-changing transaction made only of mapped, text-block-local steps
	// already identifies the blocks to inspect. Mark-only, structural, and
	// cross-block transactions keep the conservative full scan below.
	let sparseLengthEdit = transaction.steps.length > 0 &&
		transaction.doc.content.size !== transaction.before.content.size;
	transaction.steps.forEach((step, ordinal) => {
		let hasRange = false;
		step.getMap().forEach((from, to) => {
			hasRange = true;
			for (let previous = ordinal - 1; previous >= 0; previous--) {
				const inverse = transaction.mapping.maps[previous]!.invert();
				from = inverse.map(from, -1); to = inverse.map(to, 1);
			}
			const range = { from, to };
			ranges.push(range);
			if (!sparseLengthEdit) return;
			const start = transaction.before.resolve(from), end = transaction.before.resolve(to);
			if (start.depth !== 1 || end.depth !== 1 || start.index(0) !== end.index(0) ||
				start.parent.type.name !== 'source_block' || end.parent.type.name !== 'source_block') {
				sparseLengthEdit = false;
				return;
			}
			const index = start.index(0), blockStart = start.before(1) + 1;
			if (end.before(1) + 1 !== blockStart) {
				sparseLengthEdit = false;
				return;
			}
			const group = localRanges.get(index);
			if (group) {
				if (group.start !== blockStart) {
					sparseLengthEdit = false;
					return;
				}
				group.ranges.push(range);
			} else localRanges.set(index, { start: blockStart, ranges: [range] });
		});
		if (!hasRange) sparseLengthEdit = false;
	});
	if (!localRanges.size) sparseLengthEdit = false;
	const sparseIndices = sparseLengthEdit ? [...localRanges.keys()].sort((left, right) => left - right) : null;
	const processBlock = (index: number, oldStart: number, newStart: number, before: VisualNode, after: VisualNode,
		actual: readonly { from: number; to: number }[]) => {
		const anchoredBefore = projection.document.child(index);
		if (before.eq(after)) return;
		if (before.type !== after.type || JSON.stringify(before.attrs) !== JSON.stringify(after.attrs) || before.type.name !== 'source_block') throw new Error('VISUAL_STRUCTURE');
		// Inline atoms occupy one PM position even though textContent omits them.
		const oldText = before.textBetween(0, before.content.size, '', '\ufffc'), nextText = after.textBetween(0, after.content.size, '', '\ufffc');
		let from = 0, oldTo = oldText.length, newTo = nextText.length;
		while (from < oldTo && from < newTo && oldText[from] === nextText[from]) from++;
		while (oldTo > from && newTo > from && oldText[oldTo - 1] === nextText[newTo - 1]) { oldTo--; newTo--; }
		if (actual.length) {
			from = Math.min(...actual.map((range) => range.from)) - oldStart;
			oldTo = Math.max(...actual.map((range) => range.to)) - oldStart;
			const newFrom = transaction.mapping.map(oldStart + from, -1) - newStart;
			newTo = transaction.mapping.map(oldStart + oldTo, 1) - newStart;
			if (newFrom !== from || oldText.slice(0, from) !== nextText.slice(0, from) || oldText.slice(oldTo) !== nextText.slice(newTo)) throw new Error('VISUAL_MAPPING');
		}
		while (from > 0 && (!scalarBoundary(oldText, from) || !scalarBoundary(nextText, from))) from--;
		while (!scalarBoundary(oldText, oldTo)) oldTo++;
		while (!scalarBoundary(nextText, newTo)) newTo++;
		const inserted = nextText.slice(from, newTo);
		if (inserted.includes('\r')) throw new Error('VISUAL_TEXT_EOL');
		const inline = projection.segments?.[index];
		if (inline) {
			if (inline.some((segment) => segment.atom && from < segment.to && oldTo > segment.from)) throw new Error('VISUAL_INLINE_ATOM');
			const segmentIndex = inline.findIndex((segment) => {
				if (segment.atom) return false;
				if (segment.from > from || segment.to < oldTo) return false;
				const insertion = inserted ? Fragment.from(visualSchema.text(inserted, segment.marks.map((name) => visualSchema.marks[name]!.create()))) : Fragment.empty;
				return before.content.cut(0, from).append(insertion).append(before.content.cut(oldTo)).eq(after.content);
			});
			if (segmentIndex < 0 && from === oldTo) {
				edits.push(markedTextInsertion(source, projection, transaction, index, before, oldStart,
					from, oldTo, newTo, inserted, inline, actual));
				return;
			}
			if (segmentIndex < 0) {
				const origin = inline.findIndex((segment) => {
					if (segment.atom) return false;
					if (segment.from > from || segment.to < from) return false;
					const insertion = inserted ? Fragment.from(visualSchema.text(inserted, segment.marks.map((name) => visualSchema.marks[name]!.create()))) : Fragment.empty;
					return before.content.cut(0, from).append(insertion).append(before.content.cut(oldTo)).eq(after.content);
				});
				if (origin < 0) throw new Error('VISUAL_INLINE_BOUNDARY');
				let covered = 0;
				for (let ordinal = 0; ordinal < inline.length; ordinal++) {
					const segment = inline[ordinal]!, startVisual = Math.max(from, segment.from), endVisual = Math.min(oldTo, segment.to);
					if (segment.atom) continue;
					const text = ordinal === origin ? inserted : '';
					if (endVisual < startVisual || endVisual === startVisual && !text) continue;
					covered += endVisual - startVisual;
					const start = segment.editFrom + segment.boundaries[startVisual - segment.from]!, end = segment.editFrom + segment.boundaries[endVisual - segment.from]!;
					edits.push({ index, segment: ordinal, from: startVisual, to: endVisual, insert: text,
						patch: { from: start, to: end, expected: source.read(start, end), insert: escapeVisualText(text).replaceAll('\n', source.profile.preferredLineEnding) } });
				}
				if (covered !== oldTo - from) throw new Error('VISUAL_INLINE_BOUNDARY');
				return;
			}
			const segment = inline[segmentIndex]!, start = segment.editFrom + segment.boundaries[from - segment.from]!, end = segment.editFrom + segment.boundaries[oldTo - segment.from]!;
			edits.push({ index, segment: segmentIndex, from, to: oldTo, insert: inserted,
				patch: { from: start, to: end, expected: source.read(start, end), insert: escapeVisualText(inserted).replaceAll('\n', source.profile.preferredLineEnding) } });
			return;
		}
		const expectedContent = before.content.cut(0, from).append(inserted ? Fragment.from(visualSchema.text(inserted)) : Fragment.empty).append(before.content.cut(oldTo));
		if (!expectedContent.eq(after.content)) {
			const fallback = plainSegment(projection, index, before);
			if (!fallback) throw new Error('VISUAL_STRUCTURE');
			edits.push(markedTextInsertion(source, projection, transaction, index, before, oldStart,
				from, oldTo, newTo, inserted, [fallback], actual));
			return;
		}
		const boundaries = projection.boundaries[index];
		const isInitialEmpty = oldText.length === 0 && boundaries?.length === 1 && boundaries[0] === 0;
		if (!boundaries || (!isInitialEmpty && (boundaries.length !== oldText.length + 1 || boundaries.at(-1) !== anchoredBefore.attrs.editTo - anchoredBefore.attrs.editFrom))) throw new Error('VISUAL_MAPPING');
		const start = anchoredBefore.attrs.editFrom + (isInitialEmpty ? 0 : boundaries[from]!);
		const end = anchoredBefore.attrs.editFrom + (isInitialEmpty ? (anchoredBefore.attrs.editTo - anchoredBefore.attrs.editFrom) : boundaries[oldTo]!);
		edits.push({ index, from, to: oldTo, insert: inserted,
			patch: { from: start, to: end, expected: source.read(start, end), insert: escapeVisualText(inserted).replaceAll('\n', source.profile.preferredLineEnding) } });
	};
	if (sparseIndices) {
		for (const index of sparseIndices) {
			const group = localRanges.get(index)!;
			const before = transaction.before.child(index), after = transaction.doc.child(index);
			// The PM node boundary is outside text-block edits; mapping it gives
			// the current content start without walking preceding siblings.
			const newStart = transaction.mapping.map(group.start - 1, 1) + 1;
			processBlock(index, group.start, newStart, before, after, group.ranges);
		}
	} else {
		// Conservative scans still visit each block, but route each mapped range
		// once instead of filtering the full range list for every block.
		const orderedRanges = ranges.slice().sort((left, right) => left.from - right.from || left.to - right.to);
		let rangeCursor = 0;
		let beforeOffset = 0, afterOffset = 0;
		for (let index = 0; index < projection.document.childCount; index++) {
			const before = transaction.before.child(index), after = transaction.doc.child(index);
			const oldStart = beforeOffset + 1, oldEnd = oldStart + before.content.size;
			while (rangeCursor < orderedRanges.length && orderedRanges[rangeCursor]!.from < oldStart) rangeCursor++;
			const actual: { from: number; to: number }[] = [];
			while (rangeCursor < orderedRanges.length && orderedRanges[rangeCursor]!.from <= oldEnd) {
				const range = orderedRanges[rangeCursor++]!;
				if (range.to <= oldEnd) actual.push(range);
			}
			processBlock(index, oldStart, afterOffset + 1, before, after, actual);
			beforeOffset += before.nodeSize;
			afterOffset += after.nodeSize;
		}
	}
	return edits;
}
export function visualPatches(source: SourceDocument, projection: VisualProjection, transaction: Transaction): readonly SourcePatch[] {
	return prepareVisualEdit(source, projection, transaction).patches;
}
/** One immutable, identity-bound edit analysis shared by patching and canonical advancement. */
export function prepareVisualEdit(source: SourceDocument, projection: VisualProjection, transaction: Transaction): PreparedVisualEdit {
	const edits = Object.freeze([...blockEdits(source, projection, transaction)]);
	return Object.freeze({ source, projection, transaction, before: transaction.before, document: transaction.doc,
		edits, patches: Object.freeze(edits.map((edit) => edit.patch)) });
}
/** Reanchor the existing visual transaction after its authoritative source receipt, without parsing. */
function editBoundaries(offsets: readonly number[], from: number, to: number, insert: string, lineEnding: string): readonly number[] {
	const replacement = [offsets[from]!];
	let cursor = offsets[from]!;
	for (const character of insert) {
		if (character.length === 2) { replacement.push(cursor + 1); cursor += 2; replacement.push(cursor); }
		else { cursor += character === '\n' ? lineEnding.length : escapeVisualText(character).length; replacement.push(cursor); }
	}
	// Equal-width replacements with identical UTF-16/source geometry reuse immutable maps.
	// Avoid copying a million offsets for each ordinary character replacement.
	if (replacement.length === to - from + 1 && replacement.every((offset, index) => offset === offsets[from + index])) return offsets;
	const result = offsets.slice(0, from);
	for (const offset of replacement) result.push(offset);
	const shift = cursor - offsets[to]!;
	for (let index = to + 1; index < offsets.length; index++) result.push(offsets[index]! + shift);
	return Object.freeze(result);
}

export function advanceVisual(
	source: SourceDocument, projection: VisualProjection, transaction: Transaction, next: SourceDocument, prepared?: PreparedVisualEdit
): VisualProjection {
	if (prepared && (prepared.source !== source || prepared.projection !== projection || prepared.transaction !== transaction ||
		prepared.before !== transaction.before || prepared.document !== transaction.doc)) throw new Error('STALE_VISUAL');
	const edits = prepared?.edits ?? blockEdits(source, projection, transaction);
	const patches = prepared?.patches ?? edits.map((edit) => edit.patch);
	const changed = patches.some((patch) => patch.insert !== patch.expected);
	if (next.documentId !== source.documentId || next.version !== source.version + (changed ? 1 : 0)) throw new Error('STALE_VISUAL');
	const change: SourceChange = { documentId: source.documentId, beforeVersion: source.version, afterVersion: next.version,
		oldLength: source.length, newLength: next.length, patches };
	let delta = 0;
	for (const patch of patches) {
		if (next.read(patch.from + delta, patch.from + delta + patch.insert.length) !== patch.insert) throw new Error('VISUAL_RECEIPT');
		delta += patch.insert.length - (patch.to - patch.from);
	}
	if (next.length !== source.length + delta) throw new Error('VISUAL_RECEIPT');
	const blocks: VisualNode[] = [], boundaries: (readonly number[] | null)[] = [], segments: (readonly InlineSegment[] | null)[] = [];
	const byIndex = new Map<number, BlockEdit[]>();
	let firstEditedIndex = transaction.doc.childCount;
	for (const edit of edits) {
		const group = byIndex.get(edit.index);
		if (group) group.push(edit); else byIndex.set(edit.index, [edit]);
		firstEditedIndex = Math.min(firstEditedIndex, edit.index);
	}
	// Earlier canonical nodes and their relative maps cannot move; retain them rather than
	// recalculating their source anchors for a length-changing edit later in the document.
	for (let index = 0; index < firstEditedIndex; index++) {
		blocks.push(projection.document.child(index));
		boundaries.push(projection.boundaries[index] ?? null);
		segments.push(projection.segments?.[index] ?? null);
	}
	for (let index = firstEditedIndex; index < transaction.doc.childCount; index++) {
		const node = transaction.doc.child(index), group = byIndex.get(index) ?? [], edit = group[0];
		const anchoredBefore = projection.document.child(index), displayedBefore = transaction.before.child(index);
		const attrs = { ...node.attrs,
			from: mapPosition(change, anchoredBefore.attrs.from, edit ? 'before' : 'after'),
			to: mapPosition(change, anchoredBefore.attrs.to, edit ? 'after' : 'before'),
			editFrom: mapPosition(change, anchoredBefore.attrs.editFrom, edit ? 'before' : 'after'),
			editTo: mapPosition(change, anchoredBefore.attrs.editTo, edit ? 'after' : 'before') };
		const atomAnchors = new Map<VisualNode, VisualNode>();
		displayedBefore.content.forEach((child, _offset, ordinal) => {
			if (child.type.name === 'math_inline') atomAnchors.set(child, anchoredBefore.child(ordinal));
		});
		const children: VisualNode[] = [];
		let contentChanged = false;
		node.content.forEach((child) => {
			if (child.type.name !== 'math_inline') { children.push(child); return; }
			const anchored = atomAnchors.get(child);
			if (!anchored) throw new Error('VISUAL_INLINE_ATOM');
			const childAttrs = { ...child.attrs,
				from: mapPosition(change, anchored.attrs.from, 'after'), to: mapPosition(change, anchored.attrs.to, 'before'),
				editFrom: mapPosition(change, anchored.attrs.editFrom, 'after'), editTo: mapPosition(change, anchored.attrs.editTo, 'before') };
			const changed = (['from', 'to', 'editFrom', 'editTo'] as const).some(name => childAttrs[name] !== child.attrs[name]);
			contentChanged ||= changed;
			children.push(changed ? child.type.create(childAttrs, child.content, child.marks) : child);
		});
		const anchorsChanged = (['from', 'to', 'editFrom', 'editTo'] as const).some(name => attrs[name] !== node.attrs[name]);
		blocks.push(anchorsChanged || contentChanged ? node.type.create(attrs, Fragment.from(children), node.marks) : node);
		const projectedInline = projection.segments?.[index] ?? null;
		const marked = group.find(item => item.markedInsertion);
		const fallback = marked && !projectedInline ? plainSegment(projection, index, projection.document.child(index)) : null;
		const inline = projectedInline ?? (fallback ? [fallback] : null);
		const bySegment = new Map(group.filter((item) => item.segment !== undefined).map((item) => [item.segment, item]));
		let visualShift = 0;
		if (inline) {
			const nextSegments: InlineSegment[] = [];
			for (let ordinal = 0; ordinal < inline.length; ordinal++) {
				const segment = inline[ordinal]!;
				if (marked?.segment === ordinal && marked.markedInsertion) {
					const local = marked.from - segment.from, length = segment.to - segment.from;
					if (local < 0 || local >= segment.boundaries.length ||
						segment.editFrom + segment.boundaries[local]! !== marked.patch.from) throw new Error('VISUAL_MAPPING');
					const base = segment.from + visualShift;
					const sourceBefore = mapPosition(change, marked.patch.from, 'before');
					const sourceAfter = mapPosition(change, marked.patch.from, 'after');
					if (local > 0) nextSegments.push(Object.freeze({
						...segment, from: base, to: base + local,
						editFrom: mapPosition(change, segment.editFrom, 'after'), editTo: sourceBefore,
						boundaries: Object.freeze(segment.boundaries.slice(0, local + 1))
					}));
					nextSegments.push(Object.freeze({
						from: base + local, to: base + local + marked.insert.length,
						editFrom: sourceBefore + marked.markedInsertion.textFrom,
						editTo: sourceBefore + marked.markedInsertion.textTo,
						boundaries: marked.markedInsertion.boundaries, marks: marked.markedInsertion.marks,
						wrapped: marked.markedInsertion.wrappers.length > 0, wrappers: marked.markedInsertion.wrappers
					}));
					if (local < length) {
						const first = segment.boundaries[local]!;
						nextSegments.push(Object.freeze({
							...segment, from: base + local + marked.insert.length, to: base + length + marked.insert.length,
							editFrom: sourceAfter, editTo: mapPosition(change, segment.editTo, 'after'),
							boundaries: Object.freeze(segment.boundaries.slice(local).map(offset => offset - first))
						}));
					}
					visualShift += marked.insert.length;
					continue;
				}
				const edit = bySegment.get(ordinal), edited = Boolean(edit);
				let offsets = segment.boundaries;
				if (edited && edit) {
					const from = edit.from - segment.from, to = edit.to - segment.from;
					offsets = editBoundaries(offsets, from, to, edit.insert, source.profile.preferredLineEnding);
				}
				const visualDelta = edit && edit.segment !== undefined ? edit.insert.length - (edit.to - edit.from) : 0;
				const next = Object.freeze({ ...segment, from: segment.from + visualShift,
					to: segment.to + visualShift + visualDelta,
					editFrom: mapPosition(change, segment.editFrom, edited ? 'before' : 'after'),
					editTo: mapPosition(change, segment.editTo, edited || segment.editFrom === segment.editTo ? 'after' : 'before'), boundaries: offsets });
				visualShift += visualDelta;
				nextSegments.push(next);
			}
			const visible = nextSegments.filter(segment => segment.from !== segment.to || segment.wrapped);
			if (!visible.length && nextSegments.length) visible.push(nextSegments[0]!);
			segments.push(Object.freeze(visible));
		} else segments.push(null);
		const old = projection.boundaries[index];
		if (marked) { boundaries.push(null); continue; }
		if (!edit || !old) { boundaries.push(old ?? null); continue; }
		boundaries.push(editBoundaries(old, edit.from, edit.to, edit.insert, source.profile.preferredLineEnding));
	}
	return { documentId: next.documentId, version: next.version, document: visualSchema.nodes.doc!.create(null, blocks),
		viewDocument: transaction.doc, boundaries: Object.freeze(boundaries), segments: Object.freeze(segments) };
}
