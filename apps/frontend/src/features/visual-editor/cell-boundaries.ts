import type { SourceDocument, SyntaxNode } from '../document-core/core.ts';

// Ordinary TeX comments persist user cell boundaries without affecting typesetting.
export const CELL_BEGIN = '% ModuTeX cell begin';
export const CELL_END = '% ModuTeX cell end';
export interface CellBoundary { readonly first: number; readonly last: number; readonly from: number; readonly to: number }

/** Only balanced, non-nested top-level marker pairs are authoritative. */
export function explicitCellRanges(source: SourceDocument, nodes: readonly SyntaxNode[]) {
	const ranges: { from: number; to: number; contentFrom: number; contentTo: number }[] = [];
	let opening: SyntaxNode | null = null, nested = false;
	for (const node of nodes) {
		if (node.kind !== 'comment') continue;
		const text = source.read(node.span.from, node.span.to);
		if (text === CELL_BEGIN) {
			if (opening) nested = true; else { opening = node; nested = false; }
		} else if (text === CELL_END && opening) {
			if (!nested) ranges.push({ from: opening.span.from, to: node.span.to, contentFrom: opening.span.to, contentTo: node.span.from });
			opening = null; nested = false;
		}
	}
	return ranges;
}
