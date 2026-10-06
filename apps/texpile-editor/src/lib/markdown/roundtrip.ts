// the .md file IS the document, same fidelity model as latexRoundtrip: opening splits YAML
// frontmatter (preserved verbatim, the markdown "preamble") from the body and parses only the
// body; saving regenerates only the body and splices it back. The ParsedLatexFile shape is
// reused wholesale so the buffer/worker/view plumbing needs no parallel types: preamble =
// frontmatter, postamble = '', hadDocumentEnv = had frontmatter.
import { markdownToProseMirror } from './converter';
import { serializeToMarkdownDetailed, serializeMdNode } from './serializer';
import { fillOrigNorms } from '$lib/serializer/blockAssembly';
import type { Node } from 'prosemirror-model';
import type { ParsedLatexFile, ParsePhase } from '$lib/workspace/latexRoundtrip';

// closing --- kept in the preamble WITHOUT its trailing newline (mirrors \begin{document}), so
// the body's leading gap lands in the first block's `pre` and pristine saves stay byte-exact
const FRONTMATTER_RE = /^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?=\r?\n|$)/;

export function parseMarkdownFile(markdown: string, _projectMacros = '', onPhase?: (phase: ParsePhase) => void): ParsedLatexFile {
	onPhase?.('parsing');
	const m = FRONTMATTER_RE.exec(markdown);
	const preamble = m ? m[0] : '';
	const body = m ? markdown.slice(preamble.length) : markdown;
	const { doc: parsedDoc } = markdownToProseMirror(body);
	onPhase?.('finalizing');
	const doc = fillOrigNorms(parsedDoc, serializeMdNode);

	if (import.meta.env.DEV) {
		try {
			doc.check();
		} catch (e) {
			console.error('[markdownRoundtrip] parsed doc violates the schema content model:', e);
		}
	}

	return { preamble, postamble: '', doc, hadDocumentEnv: !!m, warnings: [] };
}

/** Serializes back to .md, preserving the frontmatter and regenerating only the body. */
export function serializeMarkdownFile(parsed: Pick<ParsedLatexFile, 'preamble' | 'postamble' | 'hadDocumentEnv'>, doc: Node): string {
	const { text: body, leadProtected, tailProtected } = serializeToMarkdownDetailed(doc);
	const tail = tailProtected ? '' : '\n';
	// no frontmatter: the body IS the file (a protected tail reproduces the exact original
	// trailing bytes, including a missing final newline)
	if (!parsed.hadDocumentEnv) return body + tail;
	if (!body) return parsed.preamble + '\n'; // frontmatter-only file: don't grow blank lines per save
	const leadSep = leadProtected ? '' : '\n\n';
	return `${parsed.preamble}${leadSep}${body}${tail}`;
}
