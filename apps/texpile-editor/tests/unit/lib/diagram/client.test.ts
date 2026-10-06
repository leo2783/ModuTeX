// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Fragment } from 'prosemirror-model';
import {
	applyDiagramRelink,
	convertDiagramToRegularImage,
	diagramOutputPaths,
	diagramIdFromSource,
	preserveRawDiagram,
	readDiagramSource,
	relinkDiagram,
	saveDiagramBundle,
	withDeadline,
	type DiagramFigureAttrs
} from '$lib/diagram/client';
import { parseLatexFile, serializeLatexFile } from '$lib/workspace/latexRoundtrip';

const OLD_ID = '550e8400-e29b-41d4-a716-446655440000';
const NEW_ID = '123e4567-e89b-42d3-a456-426614174000';
const SOURCE = `assets/diagrams/system-flow-${NEW_ID}.mmd`;
const DRAWIO_SOURCE = `assets/diagrams/system-flow-${NEW_ID}.drawio`;
const attrs: DiagramFigureAttrs = {
	src: `assets/diagrams/old-${OLD_ID}.pdf`,
	diagramType: 'mermaid',
	diagramId: OLD_ID,
	diagramSource: `assets/diagrams/old-${OLD_ID}.mmd`,
	caption: 'System overview',
	label: 'fig:system',
	width: '\\linewidth',
	figureTemplate: '\\begin{figure}\n__IMAGE__\n\\end{figure}'
};

const relinkResult = {
	relativePath: SOURCE,
	content: 'flowchart LR\nA-->B\n',
	sha256: 'a'.repeat(64),
	mtimeMs: 1,
	size: new TextEncoder().encode('flowchart LR\nA-->B\n').byteLength
};

const nativeCleanups: Array<() => void> = [];
const installNativeBridge = (bridge: object): (() => void) => {
	const previous = Object.getOwnPropertyDescriptor(window, 'texpileNative');
	Object.defineProperty(window, 'texpileNative', { configurable: true, value: bridge });
	const restore = () => {
		if (previous) Object.defineProperty(window, 'texpileNative', previous);
		else Reflect.deleteProperty(window, 'texpileNative');
		const index = nativeCleanups.indexOf(restore);
		if (index >= 0) nativeCleanups.splice(index, 1);
	};
	nativeCleanups.push(restore);
	return restore;
};

afterEach(() => {
	while (nativeCleanups.length) nativeCleanups.at(-1)?.();
	vi.restoreAllMocks();
});

describe('diagram relink client', () => {
	it('passes only the requested type to the native boundary and accepts a validated relative result', async () => {
		let request: unknown;
		const result = await relinkDiagram('mermaid', {
			diagramRelink: async (value) => {
				request = value;
				return relinkResult;
			}
		});
		expect(request).toEqual({ type: 'mermaid' });
		expect(result).toEqual(relinkResult);
	});

	it('returns cancel unchanged and rejects malformed native results at the renderer boundary', async () => {
		await expect(relinkDiagram('mermaid', { diagramRelink: async () => null })).resolves.toBeNull();
		await expect(
			relinkDiagram('mermaid', { diagramRelink: async () => ({ ...relinkResult, relativePath: 'C:/private/source.mmd' }) })
		).rejects.toThrow('INVALID_RELINK_RESULT');
		await expect(relinkDiagram('mermaid', { diagramRelink: async () => ({ ...relinkResult, content: '', size: 0 }) })).rejects.toThrow(
			'INVALID_RELINK_RESULT'
		);
	});

	it('adopts the selected valid UUID while preserving every ordinary figure field', () => {
		const updated = applyDiagramRelink(attrs, 'mermaid', relinkResult);
		expect(updated).toEqual({
			...attrs,
			src: `assets/diagrams/system-flow-${NEW_ID}.pdf`,
			diagramType: 'mermaid',
			diagramId: NEW_ID,
			diagramSource: SOURCE
		});
		expect(updated.caption).toBe(attrs.caption);
		expect(updated.label).toBe(attrs.label);
		expect(updated.width).toBe(attrs.width);
		expect(updated.figureTemplate).toBe(attrs.figureTemplate);
	});

	it('converts to a regular image without altering src, caption, label, width, or figure template', () => {
		const converted = convertDiagramToRegularImage(attrs);
		expect(converted).toEqual({
			...attrs,
			diagramType: null,
			diagramId: null,
			diagramSource: null
		});
	});

	it('preserves the production figure while relinking or converting it to a regular image', () => {
		const oldSource = `assets/diagrams/old-${OLD_ID}.mmd`;
		const oldPdf = `assets/diagrams/old-${OLD_ID}.pdf`;
		const input = `\\documentclass{article}\n\\begin{document}\n% modutex:diagram {"v":1,"id":"${OLD_ID}","type":"mermaid","source":"${oldSource}"}\n\\begin{figure}[htbp]\n  \\centering\n  \\includegraphics[width=0.75\\linewidth]{${oldPdf}}\n  \\caption{System overview}\n  \\label{fig:system}\n\\end{figure}\n\\end{document}\n`;
		const parsed = parseLatexFile(input);
		const image = parsed.doc.child(0);
		const originalAttrs = image.attrs as DiagramFigureAttrs;

		const relinked = image.type.create(applyDiagramRelink(originalAttrs, 'mermaid', relinkResult), image.content, image.marks);
		const relinkedOutput = serializeLatexFile(parsed, parsed.doc.copy(Fragment.from(relinked)));
		expect(relinkedOutput).toContain(`% modutex:diagram {"v":1,"id":"${NEW_ID}","type":"mermaid","source":"${SOURCE}"}`);
		expect(relinkedOutput).toContain(`\\includegraphics[width=0.75\\linewidth]{assets/diagrams/system-flow-${NEW_ID}.pdf}`);
		expect(relinkedOutput).toContain('\\caption{System overview}');
		expect(relinkedOutput).toContain('\\label{fig:system}');

		const regular = image.type.create(convertDiagramToRegularImage(originalAttrs), image.content, image.marks);
		const regularOutput = serializeLatexFile(parsed, parsed.doc.copy(Fragment.from(regular)));
		expect(regularOutput).not.toContain('% modutex:diagram ');
		expect(regularOutput).toContain(`\\includegraphics[width=0.75\\linewidth]{${oldPdf}}`);
		expect(regularOutput).toContain('\\caption{System overview}');
		expect(regularOutput).toContain('\\label{fig:system}');
	});

	it('preserves Raw LaTeX byte-for-byte and cancel returns the same figure object', () => {
		const raw = '% modutex:diagram {bad}\r\n\\begin{figure}\r\n  unknown % bytes\r\n\\end{figure}';
		expect(preserveRawDiagram(raw)).toBe(raw);
		expect(applyDiagramRelink(attrs, 'mermaid', null)).toBe(attrs);
	});
});

describe('Draw.io renderer client boundary', () => {
	it('derives sidecar paths only from a safe diagram source and matching UUID', () => {
		expect(diagramOutputPaths(DRAWIO_SOURCE)).toEqual({
			svg: `assets/diagrams/system-flow-${NEW_ID}.svg`,
			pdf: `assets/diagrams/system-flow-${NEW_ID}.pdf`
		});
		expect(diagramIdFromSource(DRAWIO_SOURCE, 'drawio')).toBe(NEW_ID);
		expect(() => diagramOutputPaths('C:/private/diagram.drawio')).toThrow('INVALID_DIAGRAM_SOURCE');
		expect(() => diagramIdFromSource(SOURCE, 'drawio')).toThrow('INVALID_DIAGRAM_SOURCE');
	});

	it('fails closed when this renderer has no real read/write native methods', async () => {
		await expect(readDiagramSource(DRAWIO_SOURCE)).rejects.toThrow('DIAGRAM_READ_UNAVAILABLE');
		await expect(saveDiagramBundle(DRAWIO_SOURCE, '<mxfile/>', '<svg/>')).rejects.toThrow('DIAGRAM_WRITE_UNAVAILABLE');
	});

	it('bounds a native wait without converting timeout into success', async () => {
		await expect(withDeadline(new Promise<never>(() => {}), 5, 'RENDER_TIMEOUT')).rejects.toThrow('RENDER_TIMEOUT');
		await expect(withDeadline(Promise.resolve('ok'), 0, 'RENDER_TIMEOUT')).rejects.toThrow('INVALID_TIMEOUT');
	});

	it('announces a workspace file change only after a fully validated publication receipt', async () => {
		const content = '<mxfile/>';
		const contentHash = 'a'.repeat(64);
		const svgHash = 'b'.repeat(64);
		const pdfHash = 'c'.repeat(64);
		const { svg, pdf } = diagramOutputPaths(DRAWIO_SOURCE);
		const bridge = {
			diagramWrite: vi.fn(async () => ({ sha256: contentHash, size: new TextEncoder().encode(content).byteLength })),
			diagramRead: vi.fn(async () => ({
				content,
				mtimeMs: 1,
				sha256: contentHash,
				size: new TextEncoder().encode(content).byteLength
			})),
			diagramRenderPdf: vi.fn(async () => ({
				ok: true as const,
				outputRelPath: pdf,
				svgRelPath: svg,
				sourceSha256: contentHash,
				svgSha256: svgHash,
				pdfSha256: pdfHash
			})),
			diagramCancelPdf: vi.fn(async () => ({ cancelled: false }))
		};
		const restore = installNativeBridge(bridge);
		const changed = vi.fn();
		window.addEventListener('texpile:fs-changed', changed);
		try {
			await expect(saveDiagramBundle(DRAWIO_SOURCE, content, '<svg/>')).resolves.toEqual({
				outputRelPath: pdf,
				svgRelPath: svg,
				sourceSha256: contentHash,
				svgSha256: svgHash,
				pdfSha256: pdfHash
			});
			expect(bridge.diagramRenderPdf).toHaveBeenCalledOnce();
			expect(changed).toHaveBeenCalledOnce();
		} finally {
			window.removeEventListener('texpile:fs-changed', changed);
			restore();
		}
	});

	it('does not announce renderer errors, invalid receipts, aborts, or timeouts', async () => {
		const content = '<mxfile/>';
		const contentHash = 'a'.repeat(64);
		const { svg } = diagramOutputPaths(DRAWIO_SOURCE);
		const changed = vi.fn();
		window.addEventListener('texpile:fs-changed', changed);
		const base = {
			diagramWrite: async () => ({ sha256: contentHash, size: new TextEncoder().encode(content).byteLength }),
			diagramRead: async () => ({
				content,
				mtimeMs: 1,
				sha256: contentHash,
				size: new TextEncoder().encode(content).byteLength
			}),
			diagramCancelPdf: async () => ({ cancelled: true })
		};
		try {
			const failedRender = installNativeBridge({
				...base,
				diagramRenderPdf: async () => ({ ok: false as const, errorCode: 'SVG_REJECTED' })
			});
			await expect(saveDiagramBundle(DRAWIO_SOURCE, content, '<svg/>')).rejects.toThrow('SVG_REJECTED');
			failedRender();
			expect(changed).not.toHaveBeenCalled();

			const invalidReceipt = installNativeBridge({
				...base,
				diagramRenderPdf: async () => ({
					ok: true as const,
					outputRelPath: 'assets/diagrams/other.pdf',
					svgRelPath: svg,
					sourceSha256: contentHash,
					svgSha256: 'b'.repeat(64),
					pdfSha256: 'c'.repeat(64)
				})
			});
			await expect(saveDiagramBundle(DRAWIO_SOURCE, content, '<svg/>')).rejects.toThrow('INVALID_DIAGRAM_PDF_RESULT');
			invalidReceipt();
			expect(changed).not.toHaveBeenCalled();

			const aborted = new AbortController();
			aborted.abort();
			const abortBridge = installNativeBridge({ ...base, diagramRenderPdf: vi.fn() });
			await expect(saveDiagramBundle(DRAWIO_SOURCE, content, '<svg/>', { signal: aborted.signal })).rejects.toThrow('DIAGRAM_ABORTED');
			abortBridge();
			expect(changed).not.toHaveBeenCalled();

			const timedOut = installNativeBridge({
				...base,
				diagramRenderPdf: () => new Promise<never>(() => {})
			});
			await expect(saveDiagramBundle(DRAWIO_SOURCE, content, '<svg/>', { timeoutMs: 5 })).rejects.toThrow('RENDER_TIMEOUT');
			timedOut();
			expect(changed).not.toHaveBeenCalled();
		} finally {
			window.removeEventListener('texpile:fs-changed', changed);
		}
	});
});
