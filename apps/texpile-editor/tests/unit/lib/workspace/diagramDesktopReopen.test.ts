import { describe, expect, it } from 'vitest';
import type { Node } from 'prosemirror-model';
import { parseLatexFile, serializeLatexFile } from '../../../../src/lib/workspace/latexRoundtrip';

const ID = '08edc584-1ecd-42cc-b0a5-420e6f734c2e';
const SOURCE = `assets/diagrams/diagram-${ID}.drawio`;
const PDF = `assets/diagrams/diagram-${ID}.pdf`;
const MARKER = `% modutex:diagram {"v":1,"id":"${ID}","type":"drawio","source":"${SOURCE}"}`;

// Portable copy of the preserved desktop artifact's relevant TeX shape. It intentionally uses
// a normal table followed by the editor's same-line figure output; it never opens that artifact.
const DOCUMENT = String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
Draw.io desktop verification.

\begin{table}[h]
\centering
\caption{Table capti}\vspace{2mm}
\label{texpile-table-4ca0de48fb29}
\begin{tabular}{cc}
\texttt{\underline{222}} & 555 \\
666 & 7777 \\
\end{tabular}

\end{table}

${MARKER}
\begin{figure}[h]\centering \includegraphics[width=0.75\linewidth]{${PDF}} \caption{Desktop flow verification}\end{figure}
\end{document}
`;

function imagesOf(source: string): { parsed: ReturnType<typeof parseLatexFile>; images: Node[] } {
	const parsed = parseLatexFile(source);
	const images: Node[] = [];
	parsed.doc.descendants((node) => {
		if (node.type.name === 'image') images.push(node);
		return true;
	});
	return { parsed, images };
}

describe('Draw.io desktop artifact reopen', () => {
	it('restores diagram identity and preserves the untouched TeX bytes', () => {
		const { parsed, images } = imagesOf(DOCUMENT);

		expect(images).toHaveLength(1);
		expect(images[0].attrs).toMatchObject({
			src: PDF,
			diagramType: 'drawio',
			diagramId: ID,
			diagramSource: SOURCE
		});
		expect(serializeLatexFile(parsed, parsed.doc)).toBe(DOCUMENT);
	});

	it.each([
		['invalid marker', DOCUMENT.replace(MARKER, MARKER.replace('"v":1', '"v":2'))],
		['mismatched PDF path', DOCUMENT.replace(PDF, `assets/diagrams/other-${ID}.pdf`)]
	] as const)('keeps an ordinary figure for %s without changing its source bytes', (_label, source) => {
		const { parsed, images } = imagesOf(source);

		expect(images).toHaveLength(1);
		expect(images[0].attrs).toMatchObject({ diagramType: null, diagramId: null, diagramSource: null });
		expect(serializeLatexFile(parsed, parsed.doc)).toBe(source);
	});
});
