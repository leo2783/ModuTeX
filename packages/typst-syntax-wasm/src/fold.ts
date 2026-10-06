// Which Typst nodes can be folded, and where the fold starts and ends.
//
// A syntax tree does NOT give folding on its own — CodeMirror asks either a `foldService` or the
// `foldNodeProp` attached to node types, and a tree with neither simply has nothing foldable. Since
// this package owns the NodeSet, the prop is the natural place: no service to register, and it
// works for anything holding this parser rather than only inside our editor.
import { foldNodeProp } from '@codemirror/language';
import type { SyntaxNode } from '@lezer/common';

/** fold everything between the delimiters, keeping both on screen */
const insideDelimiters = (node: SyntaxNode) => {
	const first = node.firstChild;
	const last = node.lastChild;
	// a block whose braces are missing (mid-typing) has nothing meaningful to fold
	if (!first || !last || last.from <= first.to) return null;
	return { from: first.to, to: last.from };
};

/**
 * Fold from the end of the heading line to the end of everything it introduces.
 *
 * Typst's tree is flat here: a Heading does not contain the content beneath it the way an HTML
 * section would, so the range has to run to just before the next heading of the same or higher
 * level, which is what a reader means by folding a section.
 */
const headingSection = (node: SyntaxNode, state: { doc: { lineAt: (pos: number) => { to: number } }; doc_length?: number }) => {
	const level = (node.firstChild?.to ?? node.from) - node.from; // "==" marker length = depth
	const lineEnd = state.doc.lineAt(node.to).to;
	let end = lineEnd;
	for (let sib = node.nextSibling; sib; sib = sib.nextSibling) {
		if (sib.name === 'Heading') {
			const sibLevel = (sib.firstChild?.to ?? sib.from) - sib.from;
			if (sibLevel <= level) break;
		}
		end = sib.to;
	}
	return end > lineEnd ? { from: lineEnd, to: end } : null;
};

export const typstFold = foldNodeProp.add({
	// code and content blocks, argument lists, arrays and dictionaries all fold between delimiters
	'CodeBlock ContentBlock Args Params Array Dict Destructuring Parenthesized ImportItems': insideDelimiters,
	// a raw block folds to its first line, the fence staying visible
	Raw: (node) => {
		const first = node.firstChild;
		return first && node.to > first.to ? { from: first.to, to: node.to } : null;
	},
	Heading: headingSection
});
