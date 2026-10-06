// Format-neutral doc assembly: verbatim `orig` substitution over top-level blocks, shared by the
// LaTeX and Markdown serializers. Knows nothing about either syntax — it deals in opaque source
// slices (orig.latex), parse-time normal forms (orig.norm), seq chains and inter-block gaps.
import { Fragment } from 'prosemirror-model';
import type { Node } from 'prosemirror-model';
import type { Ctx } from './types';

/**
 * Fills orig.norm on top-level blocks: the block's deterministic serialization at parse time.
 * The serializer re-emits the original orig.latex slice only while the block still serializes
 * to exactly norm, so any edit falls back to regeneration. A block that fails to serialize
 * keeps norm null and always regenerates.
 */
export function fillOrigNorms(doc: Node, serializeNode: (node: Node, ctx: Ctx) => string): Node {
	let changed = false;
	const kids: Node[] = [];
	for (let i = 0; i < doc.childCount; i++) {
		const child = doc.child(i);
		const orig = (child.attrs as { orig?: { latex?: unknown; norm?: unknown } | null }).orig;
		if (orig && typeof orig.latex === 'string' && orig.norm == null) {
			try {
				const norm = serializeNode(child, {
					parent: doc,
					index: i,
					isLastChild: i === doc.childCount - 1,
					inTableCell: false
				});
				kids.push(child.type.create({ ...child.attrs, orig: { ...orig, norm } }, child.content, child.marks));
				changed = true;
				continue;
			} catch {
				// leave norm unset, the safe direction: this block always regenerates
			}
		}
		kids.push(child);
	}
	return changed ? doc.copy(Fragment.fromArray(kids)) : doc;
}

// verbatim source preservation: the `orig` attr the importer stamps on top-level blocks
// (see ORIG_BLOCKS in schema.ts). `latex` is historically named; it holds the original source
// slice in whichever dialect the file is.
interface OrigAttr {
	latex?: string | null;
	norm?: string | null;
	pre?: string | null;
	seq?: number | null;
	group?: number | null;
	groupIndex?: number | null;
	groupSize?: number | null;
	/** Body-relative source offset of the block's slice. not read here; positional consumers only. */
	start?: number | null;
}

function origOf(node: Node): OrigAttr | null {
	const o = (node.attrs as { orig?: unknown }).orig;
	return o && typeof o === 'object' ? (o as OrigAttr) : null;
}

/**
 * How many children starting at `i` may be emitted verbatim: 1 for a plain block whose current
 * serialization still equals its parse-time `norm`; the whole group for a multi-block source
 * unit (one itemize is N list nodes), but only when EVERY member is present, in pristine order
 * and unchanged, so a deleted/edited item can never be resurrected. 0 means regenerate.
 */
function verbatimRun(doc: Node, parts: string[], i: number): number {
	const orig = origOf(doc.child(i));
	if (!orig || typeof orig.latex !== 'string' || typeof orig.norm !== 'string') return 0;
	if (orig.group == null) return parts[i] === orig.norm ? 1 : 0;
	const size = orig.groupSize;
	if (orig.groupIndex !== 0 || typeof size !== 'number' || size < 1 || i + size > doc.childCount) return 0;
	for (let k = 0; k < size; k++) {
		const o = origOf(doc.child(i + k));
		if (!o || o.group !== orig.group || o.groupIndex !== k || typeof o.norm !== 'string' || parts[i + k] !== o.norm) return 0;
	}
	return size;
}

interface DocTail {
	text?: string | null;
	afterSeq?: number | null;
}

function docTailOf(doc: Node): DocTail | null {
	const t = (doc.attrs as { docTail?: unknown }).docTail;
	return t && typeof t === 'object' ? (t as DocTail) : null;
}

export interface DocSerializeResult {
	text: string;
	/** True iff the leading bytes are the body's verbatim original leading gap; the caller
	 *  (the roundtrip glue) must NOT prepend its own separator then, or it duplicates. */
	leadProtected: boolean;
	/** Same, for the trailing edge. */
	tailProtected: boolean;
}

function neighborKey(sib: Node | null): string {
	if (!sib) return '';
	return sib.type.name === 'list' ? `list:${String(sib.attrs.kind ?? '')}` : sib.type.name;
}

/**
 * Builds the doc-children serializer for one dialect. Each dialect gets its OWN memo cache: the
 * cache is keyed by node identity, and the same node object must never resolve to another
 * dialect's cached text.
 *
 * Assembly semantics: a block still serializing to its parse-time norm re-emits its source
 * slice; pristine neighbours (consecutive seq) re-join on their original inter-block source
 * (`pre`); every verbatim/regenerated boundary gets a hard blank line so paragraphs can't merge
 * on re-parse. with no orig attrs this equals plain concatenation. also reproduces the body's
 * leading/trailing gaps (they belong to no node) and does the final trim, ONLY at edges that
 * aren't verbatim-protected.
 */
export function createBlockAssembly(serializeNode: (node: Node, ctx: Ctx) => string) {
	// per-block memo. PM nodes are immutable and structurally shared across transactions, so an
	// untouched top-level block keeps its object identity keystroke to keystroke: serializing the
	// whole doc becomes O(edited blocks), not O(doc). a block's output depends only on itself plus
	// the neighbour facts handlers read via prevSibling/nextSibling (heading adjacency for
	// paragraph, type+kind for list coalescing) — captured in `key`. if a handler ever reads more
	// of Ctx at the top level, widen the key.
	const blockCache = new WeakMap<Node, { key: string; text: string }>();

	function serializeTopBlock(doc: Node, i: number, n: number): string {
		const node = doc.child(i);
		const key = neighborKey(i > 0 ? doc.child(i - 1) : null) + '>' + neighborKey(i < n - 1 ? doc.child(i + 1) : null);
		const hit = blockCache.get(node);
		if (hit && hit.key === key) return hit.text;
		const text = serializeNode(node, { parent: doc, index: i, isLastChild: i === n - 1, inTableCell: false });
		blockCache.set(node, { key, text });
		return text;
	}

	function serializeDocChildrenDetailed(doc: Node): DocSerializeResult {
		const n = doc.childCount;
		const parts: string[] = [];
		for (let i = 0; i < n; i++) {
			parts.push(serializeTopBlock(doc, i, n));
		}
		let out = '';
		// seq of the last verbatim-emitted child; null once anything regenerated lands in between.
		// blocks serializing to '' (empty paragraphs) don't break the chain, so pristine neighbours
		// separated by a since-emptied paragraph still re-join on their original whitespace.
		let prevSeq: number | null = null;
		let leadProtected = false;
		let i = 0;
		while (i < n) {
			const run = verbatimRun(doc, parts, i);
			if (run > 0) {
				const orig = origOf(doc.child(i))!;
				const contiguous = prevSeq != null && orig.seq === prevSeq + 1;
				if (out === '') {
					// if the doc's first emission truly starts at pristine block 0, its `pre` IS the
					// body's original leading gap; reproduce it before the generic trim can strip it.
					if (orig.seq === 0 && typeof orig.pre === 'string') {
						out = orig.pre + orig.latex!;
						leadProtected = true;
					} else {
						out = orig.latex!;
					}
				} else if (contiguous && typeof orig.pre === 'string') {
					out += orig.pre + orig.latex;
				} else {
					// hard boundary after regenerated output: exactly one blank line (a guaranteed
					// parbreak; without it a verbatim paragraph could merge into its neighbour).
					let end = out.length;
					while (end > 0 && out[end - 1] === '\n') end--;
					out = out.slice(0, end) + '\n\n' + orig.latex;
				}
				const lastSeq = origOf(doc.child(i + run - 1))?.seq;
				prevSeq = typeof lastSeq === 'number' ? lastSeq : null;
				i += run;
			} else {
				if (parts[i] !== '') {
					out += prevSeq != null ? '\n\n' + parts[i].replace(/^\n+/, '') : parts[i];
					prevSeq = null;
				}
				i++;
			}
		}

		// the trailing gap after the ORIGINAL last block belongs to no node; reproduce it iff the
		// doc's actual last emission is still, unbroken, that same pristine block (seq match).
		let tailProtected = false;
		const docTail = docTailOf(doc);
		if (docTail && typeof docTail.text === 'string' && typeof docTail.afterSeq === 'number' && prevSeq === docTail.afterSeq) {
			out += docTail.text;
			tailProtected = true;
		}

		// trim ONLY unprotected edges (identical to a blanket .trim() when no orig/docTail data
		// exists: editor-created docs, direct converter callers).
		if (!leadProtected) out = out.replace(/^\s+/, '');
		if (!tailProtected) out = out.replace(/\s+$/, '');
		return { text: out, leadProtected, tailProtected };
	}

	return { serializeDocChildrenDetailed };
}
