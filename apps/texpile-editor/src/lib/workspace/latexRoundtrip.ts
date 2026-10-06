// the .tex file IS the document: opening splits preamble/body and parses only the body;
// saving regenerates only the body and splices it back under the untouched preamble
import * as LatexParser from '$lib/latex-parser';
import { parseDiagramBlock, type DiagramMarkerV1 } from '$lib/diagram/marker';
import { serializeToLatexDetailed, serializeNode } from '$lib/serializer/latexSerializer';
import { fillOrigNorms } from '$lib/serializer/blockAssembly';
import { Fragment, type Node } from 'prosemirror-model';

// the importer runs in max-fidelity mode: unrecognized constructs are preserved as raw/inline LaTeX

const BEGIN = '\\begin{document}';
const END = '\\end{document}';
const DIAGRAM_MARKER_LINE = /^% modutex:diagram [^\r\n]*(?:\r?\n|$)/gm;

interface DiagramPlacement {
	markerStart: number;
	markerText: string;
	start: number;
	end: number;
	pdfPath: string;
	marker: DiagramMarkerV1;
}

/** Find only a marker whose next non-whitespace construct is one complete matching figure. */
function diagramPlacements(body: string): DiagramPlacement[] {
	const placements: DiagramPlacement[] = [];
	for (const markerLine of body.matchAll(DIAGRAM_MARKER_LINE)) {
		const markerStart = markerLine.index;
		const afterMarker = markerStart + markerLine[0].length;
		const rest = body.slice(afterMarker);
		const begin = /^(\s*)\\begin\{(figure\*?)\}/.exec(rest);
		if (!begin) continue;
		const figureStart = afterMarker + begin[1].length;
		const endToken = `\\end{${begin[2]}}`;
		const endStart = body.indexOf(endToken, figureStart + begin[0].length);
		if (endStart < 0) continue;
		const end = endStart + endToken.length;
		const parsed = parseDiagramBlock(body.slice(markerStart, end));
		if (parsed.kind === 'diagram') {
			placements.push({
				markerStart,
				markerText: markerLine[0].replace(/\r?\n$/, ''),
				start: figureStart,
				end,
				pdfPath: parsed.pdfPath,
				marker: parsed.marker
			});
		}
	}
	return placements;
}

/**
 * Collapse a validated marker raw node into its following image. The combined `orig` slice owns
 * marker + figure as one unit, so an edit regenerates one marker instead of duplicating it.
 */
function attachDiagramMetadata(doc: Node, body: string): Node {
	const placements = diagramPlacements(body);
	if (placements.length === 0) return doc;
	const consumed = new Set<DiagramPlacement>();
	const children: Node[] = [];
	const seqMap = new Map<number, number>();
	let removed = 0;

	for (let index = 0; index < doc.childCount; index++) {
		const child = doc.child(index);
		const childOrig = child.attrs.orig as { latex?: unknown; pre?: unknown; start?: unknown; seq?: unknown; norm?: unknown } | null;
		const childStart = Number(childOrig?.start);
		const placement =
			child.type.name === 'image'
				? placements.find(
						(item) =>
							!consumed.has(item) &&
							item.pdfPath === String(child.attrs.src ?? '') &&
							Number.isFinite(childStart) &&
							childStart >= item.start &&
							childStart < item.end
					)
				: undefined;

		if (placement && children.length > 0) {
			const markerNode = children.at(-1)!;
			const markerOrig = markerNode.attrs.orig as { latex?: unknown; pre?: unknown; start?: unknown; seq?: unknown; norm?: unknown } | null;
			if (
				markerNode.type.name === 'raw_latex' &&
				markerNode.textContent.trim() === placement.markerText &&
				typeof markerOrig?.start === 'number' &&
				typeof markerOrig?.latex === 'string' &&
				markerOrig.start <= placement.markerStart &&
				markerOrig.start + markerOrig.latex.length > placement.markerStart &&
				typeof childOrig?.latex === 'string'
			) {
				children.pop();
				removed++;
				consumed.add(placement);
				const combinedOrig = {
					...childOrig,
					latex: markerOrig.latex + (typeof childOrig.pre === 'string' ? childOrig.pre : '') + childOrig.latex,
					pre: typeof markerOrig.pre === 'string' ? markerOrig.pre : '',
					start: markerOrig.start,
					seq: markerOrig.seq,
					norm: null
				};
				const attached = child.type.create(
					{
						...child.attrs,
						orig: combinedOrig,
						diagramType: placement.marker.type,
						diagramId: placement.marker.id,
						diagramSource: placement.marker.source
					},
					child.content,
					child.marks
				);
				if (typeof markerOrig.seq === 'number') seqMap.set(markerOrig.seq, index - removed);
				if (typeof childOrig.seq === 'number') seqMap.set(childOrig.seq, index - removed);
				children.push(attached);
				continue;
			}
		}

		if (typeof childOrig?.seq === 'number') seqMap.set(childOrig.seq, index - removed);
		children.push(child);
	}

	if (removed === 0) return doc;
	const renumbered = children.map((child, index) => {
		const orig = child.attrs.orig as { seq?: unknown } | null;
		if (!orig || typeof orig.seq !== 'number' || orig.seq === index) return child;
		return child.type.create({ ...child.attrs, orig: { ...orig, seq: index } }, child.content, child.marks);
	});
	const tail = doc.attrs.docTail as { afterSeq?: unknown } | null;
	const afterSeq = typeof tail?.afterSeq === 'number' ? seqMap.get(tail.afterSeq) : undefined;
	return doc.type.create(
		{ ...doc.attrs, docTail: tail && afterSeq !== undefined ? { ...tail, afterSeq } : tail },
		Fragment.fromArray(renumbered),
		doc.marks
	);
}

/** true if the character at idx is commented out (an unescaped % precedes it on its line). */
function isCommented(text: string, idx: number): boolean {
	for (let i = idx - 1; i >= 0 && text[i] !== '\n'; i--) {
		if (text[i] === '%' && (i === 0 || text[i - 1] !== '\\')) return true;
	}
	return false;
}

/** indexOf, skipping occurrences that sit inside a LaTeX comment. */
function uncommentedIndexOf(text: string, marker: string, last = false): number {
	let found = -1;
	for (let from = text.indexOf(marker); from >= 0; from = text.indexOf(marker, from + 1)) {
		if (isCommented(text, from)) continue;
		if (!last) return from;
		found = from;
	}
	return found;
}

export interface ParsedLatexFile {
	/** Everything up to and including \begin{document} (preserved verbatim on save). */
	preamble: string;
	/** \end{document} and anything after it (preserved verbatim on save). */
	postamble: string;
	/** Editor document (a ProseMirror Node) parsed from the document body. */
	doc: Node;
	/** Whether the source actually had a \begin{document}...\end{document} wrapper. */
	hadDocumentEnv: boolean;
	/** Non-fatal notes (e.g. raw LaTeX that could not be converted). */
	warnings: string[];
}

/** counts raw_latex / inline_latex nodes (constructs the parser couldn't model). */
function countRaw(doc: Node): number {
	let n = 0;
	doc.descendants((node) => {
		if (node.type.name === 'raw_latex' || node.type.name === 'inline_latex') n++;
		return true;
	});
	return n;
}

/**
 * Parses a .tex file's text into a preserved preamble + an editor document. projectMacros is
 * macro-defining text from the main file's include chain (workspace/project.ts), scanned for
 * \newcommand signatures only, never written back.
 */
export type ParsePhase = 'parsing' | 'building' | 'finalizing';

export function parseLatexFile(latex: string, projectMacros = '', onPhase?: (phase: ParsePhase) => void): ParsedLatexFile {
	onPhase?.('parsing');
	// a \begin{document} that only appears inside a comment must not count as the real
	// wrapper, or the file gets mis-split and corrupted on save
	const bi = uncommentedIndexOf(latex, BEGIN);
	const ei = uncommentedIndexOf(latex, END, true);

	let preamble: string;
	let body: string;
	let postamble: string;
	let hadDocumentEnv: boolean;

	if (bi >= 0 && ei > bi) {
		preamble = latex.slice(0, bi + BEGIN.length);
		body = latex.slice(bi + BEGIN.length, ei);
		postamble = latex.slice(ei);
		hadDocumentEnv = true;
	} else {
		// fragment with no document environment: the whole thing is the body,
		// synthesize a minimal wrapper so it stays a valid standalone file. The synthesized
		// postamble also carries the original EOF shape through the existing worker/docMeta
		// boundary; it is never emitted for a fragment.
		preamble = `\\documentclass{article}\n${BEGIN}`;
		body = latex;
		postamble = latex.endsWith('\n') ? `${END}\n` : END;
		hadDocumentEnv = false;
	}

	// the parser only sees the body, so pass the preamble plus any cross-file
	// project macros for \newcommand signature scanning
	const scanPreamble = projectMacros ? `${projectMacros}\n${preamble}` : preamble;
	const { doc: parserDoc } = LatexParser.latexToProseMirror(body, { preamble: scanPreamble, onPhase });
	onPhase?.('finalizing');
	// complete the verbatim stamps: untouched blocks then round-trip byte-for-byte
	const doc = fillOrigNorms(attachDiagramMetadata(parserDoc, body), serializeNode);

	// dev-only tripwire: a doc that violates the content model renders fine but freezes the editor
	// on the first structural edit (PM throws mid-dispatch). production still opens the file, degraded.
	if (import.meta.env.DEV) {
		try {
			doc.check();
		} catch (e) {
			console.error('[latexRoundtrip] parsed doc violates the schema content model:', e);
		}
	}

	const rawCount = countRaw(doc);
	const warnings: string[] = [];
	if (rawCount > 0) {
		warnings.push(
			`${rawCount} LaTeX construct${rawCount > 1 ? 's' : ''} could not be converted and ${rawCount > 1 ? 'are' : 'is'} preserved as raw LaTeX.`
		);
	}

	return { preamble, postamble, doc, hadDocumentEnv, warnings };
}

/** file offset where the body (what orig.start counts from) begins: after the preamble for a
 *  real document, 0 for a fragment whose "preamble" is synthesized and not in the file. */
export const bodyOffsetOf = (p: Pick<ParsedLatexFile, 'preamble' | 'hadDocumentEnv'>): number => (p.hadDocumentEnv ? p.preamble.length : 0);

/**
 * Serializes back to .tex, preserving the preamble and regenerating only the body.
 * A protected edge (verbatim original gap bytes) already carries the true separator, so no
 * padding is added; an unprotected edge gets the conventional single \n.
 */
export function serializeLatexFile(parsed: Pick<ParsedLatexFile, 'preamble' | 'postamble' | 'hadDocumentEnv'>, doc: Node): string {
	const { text: body, leadProtected, tailProtected } = serializeToLatexDetailed(doc);
	// fragment file: body IS the entire file, no synthesized wrapper written back. a protected
	// tail reproduces the original bytes through EOF, including a missing trailing newline.
	if (parsed.hadDocumentEnv === false) {
		if (tailProtected) return body;
		return parsed.postamble.endsWith('\n') ? body + '\n' : body;
	}
	// The postamble owns the original EOF bytes, independently of body edge padding.
	const tail = parsed.postamble;
	const leadSep = leadProtected ? '' : '\n';
	const tailSep = tailProtected ? '' : '\n';
	return `${parsed.preamble}${leadSep}${body}${tailSep}${tail}`;
}

/** minimal skeleton for a brand-new .tex, no template system. */
export function createStarterLatex(): string {
	return '\\documentclass{article}\n\n\\begin{document}\n\n\\end{document}\n';
}
