import { describe, expect, it } from 'vitest';
import { Fragment, type Node } from 'prosemirror-model';
import { diagramPdfPath, parseDiagramBlock, serializeDiagramMarker } from '$lib/diagram/marker';
import { schema } from '$lib/schema/schema';
import { parseLatexFile, serializeLatexFile } from '$lib/workspace/latexRoundtrip';

const ID = '550e8400-e29b-41d4-a716-446655440000';
const SOURCE = `assets/diagrams/system-${ID}.mmd`;
const PDF = `assets/diagrams/system-${ID}.pdf`;
const MARKER = `% modutex:diagram {"v":1,"id":"${ID}","type":"mermaid","source":"${SOURCE}"}`;
const FIGURE = `${MARKER}
\\begin{figure}[htbp]
  \\centering
  \\includegraphics[width=\\linewidth]{${PDF}}
  \\caption{System overview}
  \\label{fig:system}
\\end{figure}`;

function documentOf(body: string): string {
	return `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
}

function imagesOf(source: string): { parsed: ReturnType<typeof parseLatexFile>; images: Node[] } {
	const parsed = parseLatexFile(source);
	const images: Node[] = [];
	parsed.doc.descendants((node) => {
		if (node.type.name === 'image') images.push(node);
		return true;
	});
	return { parsed, images };
}

describe('diagram marker validation', () => {
	it('accepts a valid v1 marker only when the paired figure references its exact PDF', () => {
		const parsed = parseDiagramBlock(FIGURE);
		expect(parsed.kind).toBe('diagram');
		if (parsed.kind !== 'diagram') throw new Error('expected valid diagram');
		expect(parsed.marker).toEqual({ v: 1, id: ID, type: 'mermaid', source: SOURCE });
		expect(parsed.pdfPath).toBe(PDF);
		expect(parsed.raw).toBe(FIGURE);
	});

	it('accepts a matching drawio sidecar and preserves CRLF bytes', () => {
		const drawio = FIGURE.replaceAll('.mmd', '.drawio').replace('"mermaid"', '"drawio"').replaceAll('\n', '\r\n');
		const parsed = parseDiagramBlock(drawio);
		expect(parsed.kind).toBe('diagram');
		expect(parsed.raw).toBe(drawio);
	});

	it.each([
		['bad JSON', MARKER.replace('{"v":1', '{not-json'), 'INVALID_JSON'],
		['unknown field', MARKER.replace('"source":', '"extra":true,"source":'), 'INVALID_JSON'],
		['unknown version', MARKER.replace('"v":1', '"v":2'), 'INVALID_VERSION'],
		['non-UUID id', MARKER.replaceAll(ID, 'not-a-uuid'), 'INVALID_ID'],
		['unknown type', MARKER.replace('"mermaid"', '"plantuml"'), 'INVALID_TYPE'],
		['traversal', MARKER.replace(SOURCE, `assets/diagrams/../system-${ID}.mmd`), 'INVALID_SOURCE'],
		['absolute path', MARKER.replace(SOURCE, `/assets/diagrams/system-${ID}.mmd`), 'INVALID_SOURCE'],
		['Windows path', MARKER.replace(SOURCE, `assets\\\\diagrams\\\\system-${ID}.mmd`), 'INVALID_SOURCE'],
		['uppercase path', MARKER.replace(SOURCE, `assets/diagrams/System-${ID}.mmd`), 'INVALID_SOURCE'],
		['wrong extension', MARKER.replace(SOURCE, `assets/diagrams/system-${ID}.drawio`), 'INVALID_SOURCE'],
		['wrong filename id', MARKER.replace(SOURCE, 'assets/diagrams/system-123e4567-e89b-12d3-a456-426614174000.mmd'), 'INVALID_SOURCE']
	] as const)('rejects %s without repairing it', (_label, marker, reason) => {
		const raw = `${marker}\n\\begin{figure}\n  \\includegraphics{${PDF}}\n\\end{figure}`;
		expect(parseDiagramBlock(raw)).toEqual({ kind: 'raw', reason, raw });
	});

	it.each([
		['mismatched PDF', FIGURE.replace(PDF, 'assets/diagrams/other.pdf')],
		['traversal PDF', FIGURE.replace(PDF, '../system.pdf')],
		['multiple images', FIGURE.replace('  \\caption', `  \\includegraphics{${PDF}}\n  \\caption`)],
		['missing figure', `${MARKER}\nplain text`],
		['mismatched environment', FIGURE.replace('\\end{figure}', '\\end{figure*}')]
	] as const)('rejects %s as a non-diagram block', (_label, raw) => {
		const parsed = parseDiagramBlock(raw);
		expect(parsed.kind).toBe('raw');
	});

	it('ignores a commented-out extra includegraphics when validating the active figure image', () => {
		const raw = FIGURE.replace('  \\includegraphics', `  % \\includegraphics{assets/diagrams/other.pdf}\n  \\includegraphics`);
		expect(parseDiagramBlock(raw).kind).toBe('diagram');
	});

	it('serializes one stable line and rejects unsafe metadata', () => {
		const marker = { v: 1 as const, id: ID, type: 'mermaid' as const, source: SOURCE };
		expect(serializeDiagramMarker(marker)).toBe(MARKER);
		expect(diagramPdfPath(marker)).toBe(PDF);
		expect(() => serializeDiagramMarker({ ...marker, source: '../unsafe.mmd' })).toThrow('Invalid diagram source path');
	});
});

describe('production LaTeX diagram projection', () => {
	it('attaches metadata to exactly the one image inside a validated marker/figure pair', () => {
		const ordinary = FIGURE.replace(MARKER, '% ordinary comment').replaceAll(ID, '123e4567-e89b-12d3-a456-426614174000');
		const source = documentOf(`${FIGURE}\n\n${ordinary}`);
		const { parsed, images } = imagesOf(source);

		expect(images).toHaveLength(2);
		expect(images[0].attrs).toMatchObject({ diagramType: 'mermaid', diagramId: ID, diagramSource: SOURCE });
		expect(images[1].attrs).toMatchObject({ diagramType: null, diagramId: null, diagramSource: null });
		expect(serializeLatexFile(parsed, parsed.doc)).toBe(source);
	});

	it('accepts non-canonical JSON spacing while preserving its untouched marker bytes', () => {
		const spacedMarker = `% modutex:diagram { "source":"${SOURCE}", "type":"mermaid", "id":"${ID}", "v":1 }`;
		const source = documentOf(FIGURE.replace(MARKER, spacedMarker));
		const { parsed, images } = imagesOf(source);
		expect(images[0].attrs).toMatchObject({ diagramType: 'mermaid', diagramId: ID, diagramSource: SOURCE });
		expect(serializeLatexFile(parsed, parsed.doc)).toBe(source);
	});

	it('retains validated metadata through the production worker JSON boundary', () => {
		const source = documentOf(FIGURE);
		const parsed = parseLatexFile(source);
		const rehydrated = schema.nodeFromJSON(parsed.doc.toJSON());
		expect(rehydrated.child(0).attrs).toMatchObject({ diagramType: 'mermaid', diagramId: ID, diagramSource: SOURCE });
		expect(serializeLatexFile(parsed, rehydrated)).toBe(source);
	});

	it.each([
		['invalid JSON', FIGURE.replace(MARKER, '% modutex:diagram {bad-json}')],
		['invalid version', FIGURE.replace('"v":1', '"v":9')],
		['unsafe source', FIGURE.replace(SOURCE, '../unsafe.mmd')],
		['figure mismatch', FIGURE.replace(PDF, 'assets/diagrams/other.pdf')]
	] as const)('preserves %s verbatim as an ordinary figure/raw block', (_label, body) => {
		const source = documentOf(body);
		const { parsed, images } = imagesOf(source);
		expect(images).toHaveLength(1);
		expect(images[0].attrs.diagramType).toBeNull();
		expect(serializeLatexFile(parsed, parsed.doc)).toBe(source);
	});

	it('emits exactly one validated marker when the attached figure is edited', () => {
		const source = documentOf(FIGURE);
		const parsed = parseLatexFile(source);
		const image = parsed.doc.child(0);
		expect(image.type.name).toBe('image');
		expect(image.attrs).toMatchObject({ diagramType: 'mermaid', diagramId: ID, diagramSource: SOURCE });

		const edited = image.type.create({ ...image.attrs }, image.type.schema.text('Updated caption'), image.marks);
		const output = serializeLatexFile(parsed, parsed.doc.copy(Fragment.fromArray([edited])));
		expect(output.match(/^% modutex:diagram /gm) ?? []).toHaveLength(1);
		expect(output).toContain('\\caption{Updated caption}');
		const block = output.slice(output.indexOf(MARKER), output.indexOf('\\end{figure}') + '\\end{figure}'.length);
		expect(parseDiagramBlock(block).kind).toBe('diagram');
	});

	it('never manufactures a marker from corrupted image metadata', () => {
		const source = documentOf(FIGURE);
		const parsed = parseLatexFile(source);
		const image = parsed.doc.child(0);
		const corrupted = image.type.create(
			{ ...image.attrs, diagramSource: '../unsafe.mmd' },
			image.type.schema.text('Edited caption'),
			image.marks
		);
		const output = serializeLatexFile(parsed, parsed.doc.copy(Fragment.fromArray([corrupted])));
		expect(output).not.toContain('% modutex:diagram ');
		expect(output).toContain('\\begin{figure}');
	});
});
