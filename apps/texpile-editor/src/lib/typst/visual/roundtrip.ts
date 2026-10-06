// the .typ file IS the document, same fidelity model as latexRoundtrip and the markdown side.
// Typst has no preamble/frontmatter split: code-mode preludes (#import/#set/#show) are ordinary
// top-level raw blocks, preserved verbatim by the orig machinery like every other block. The
// ParsedLatexFile shape is reused wholesale so the buffer/worker/view plumbing needs no parallel
// types: preamble = '', postamble = '', hadDocumentEnv = false.
import { typstToProseMirror } from './converter';
import { serializeToTypstDetailed, serializeTypNode } from './serializer';
import { fillOrigNorms } from '$lib/serializer/blockAssembly';
import type { Node } from 'prosemirror-model';
import type { ParsedLatexFile, ParsePhase } from '$lib/workspace/latexRoundtrip';

export function parseTypstFile(source: string, _projectMacros = '', onPhase?: (phase: ParsePhase) => void): ParsedLatexFile {
	onPhase?.('parsing');
	const { doc: parsedDoc } = typstToProseMirror(source);
	onPhase?.('finalizing');
	const doc = fillOrigNorms(parsedDoc, serializeTypNode);

	if (import.meta.env.DEV) {
		try {
			doc.check();
		} catch (e) {
			console.error('[typstRoundtrip] parsed doc violates the schema content model:', e);
		}
	}

	return { preamble: '', postamble: '', doc, hadDocumentEnv: false, warnings: [] };
}

/** Serializes back to .typ (a protected tail reproduces the exact original trailing bytes,
 *  including a missing final newline). */
export function serializeTypstFile(_parsed: Pick<ParsedLatexFile, 'preamble' | 'postamble' | 'hadDocumentEnv'>, doc: Node): string {
	const { text: body, tailProtected } = serializeToTypstDetailed(doc);
	return body + (tailProtected ? '' : '\n');
}
