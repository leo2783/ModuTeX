// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { Schema, type Node as PMNode } from 'prosemirror-model';
import { EditorView } from 'prosemirror-view';
import imageNodeView from '../../../../src/lib/editor/extensions/image/plugin/imageNodeView';
import type { ImagePluginSettings } from '../../../../src/lib/editor/extensions/image/types';

const dimensionMock = vi.hoisted(() => ({
	load: undefined as ((src: string) => Promise<{ width: number; height: number; completed: boolean }>) | undefined
}));

vi.mock('../../../../src/lib/editor/extensions/image/plugin/resize/getImageDimensions', () => ({
	default: (src: string) => dimensionMock.load?.(src) ?? Promise.resolve({ width: 320, height: 180, completed: true })
}));

const UUID = '47668571-ff29-4d1e-bc7c-4fa9749b01ac';
const SOURCE = `assets/diagrams/flow-${UUID}.drawio`;
const PDF = SOURCE.replace(/\.drawio$/, '.pdf');
const SVG = SOURCE.replace(/\.drawio$/, '.svg');

const schema = new Schema({
	nodes: {
		doc: { content: 'image*', toDOM: () => ['div', 0] },
		text: { group: 'inline' },
		image: {
			inline: true,
			group: 'inline',
			atom: true,
			attrs: {
				src: { default: null },
				alt: { default: null },
				width: { default: null },
				height: { default: null },
				maxWidth: { default: null },
				diagramType: { default: null },
				diagramId: { default: null },
				diagramSource: { default: null }
			},
			toDOM: (node) => ['img', { src: node.attrs.src }]
		}
	}
});

const makeNode = (attrs: Record<string, unknown> = {}): PMNode => schema.nodes.image.create({ src: PDF, alt: 'Flow', ...attrs });

const makeSettings = (downloadImage: (path: string) => Promise<string>, enableResize = false): ImagePluginSettings =>
	({
		downloadImage,
		uploadFile: vi.fn(async () => ''),
		deleteSrc: vi.fn(async () => undefined),
		hasTitle: false,
		extraAttributes: {},
		createOverlay: vi.fn(() => undefined),
		updateOverlay: vi.fn(),
		defaultTitle: '',
		defaultAlt: '',
		enableResize,
		isBlock: false,
		resizeCallback: vi.fn(() => () => undefined),
		imageMargin: 0,
		minSize: 20,
		maxSize: 960,
		scaleImage: false,
		createState: vi.fn(),
		createDecorations: vi.fn(),
		findPlaceholder: vi.fn()
	}) as unknown as ImagePluginSettings;

const deferred = <T>() => {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => (resolve = done));
	return { promise, resolve };
};

const editorViews: Array<{ view: EditorView; host: HTMLDivElement }> = [];
const mountEditor = (node: PMNode, settings: ImagePluginSettings) => {
	const host = document.createElement('div');
	document.body.appendChild(host);
	const view = new EditorView(host, {
		state: EditorState.create({ schema, doc: schema.nodes.doc.create(null, [node]) }),
		nodeViews: {
			image: (currentNode, currentView, getPos) => imageNodeView(settings)(currentNode, currentView, getPos)
		}
	});
	editorViews.push({ view, host });
	return {
		view,
		host,
		image: view.dom.querySelector('img')!,
		replaceNode(next: PMNode) {
			view.dispatch(view.state.tr.replaceWith(0, 1, next));
		}
	};
};

const destroyEditor = (mounted: ReturnType<typeof mountEditor>) => {
	const index = editorViews.findIndex(({ view }) => view === mounted.view);
	if (index >= 0) editorViews.splice(index, 1);
	mounted.view.destroy();
	mounted.host.remove();
};

beforeEach(() => {
	dimensionMock.load = undefined;
});

afterEach(() => {
	for (const { view, host } of editorViews.splice(0)) {
		view.destroy();
		host.remove();
	}
	document.body.replaceChildren();
});

describe('Draw.io SVG image preview', () => {
	it('uses only a safe, metadata-paired SVG and leaves ordinary or mismatched PDF images unchanged', async () => {
		const cases = [
			{ name: 'valid marker', attrs: { diagramType: 'drawio', diagramId: UUID, diagramSource: SOURCE }, expected: SVG },
			{ name: 'missing marker', attrs: {}, expected: PDF },
			{
				name: 'unsafe source path',
				attrs: { diagramType: 'drawio', diagramId: UUID, diagramSource: `assets/diagrams/../flow-${UUID}.drawio` },
				expected: PDF
			},
			{
				name: 'source and id mismatch',
				attrs: { diagramType: 'drawio', diagramId: '00000000-0000-4000-8000-000000000001', diagramSource: SOURCE },
				expected: PDF
			},
			{
				name: 'PDF source mismatch',
				attrs: { src: 'assets/diagrams/other.pdf', diagramType: 'drawio', diagramId: UUID, diagramSource: SOURCE },
				expected: 'assets/diagrams/other.pdf'
			}
		];

		for (const testCase of cases) {
			const downloadImage = vi.fn(async (path: string) => `/workspace/${path}`);
			const mounted = mountEditor(makeNode(testCase.attrs), makeSettings(downloadImage));
			await vi.waitFor(() => expect(downloadImage).toHaveBeenCalledWith(testCase.expected));
			await vi.waitFor(() => expect(mounted.image.getAttribute('src')).toContain(`/workspace/${testCase.expected}`));
			expect(mounted.view.dom.querySelector('.imagePluginRoot')?.getAttribute('imageplugin-src')).toBe(
				typeof testCase.attrs.src === 'string' ? testCase.attrs.src : PDF
			);
			destroyEditor(mounted);
		}
	});

	it('re-resolves metadata-only changes and refreshes a published SVG while resize-only changes keep the current preview', async () => {
		const downloadImage = vi.fn(async (path: string) => `/workspace/${path}`);
		const mounted = mountEditor(makeNode(), makeSettings(downloadImage));
		await vi.waitFor(() => expect(mounted.image.getAttribute('src')).toBe(`/workspace/${PDF}`));

		const markedNode = makeNode({ diagramType: 'drawio', diagramId: UUID, diagramSource: SOURCE });
		mounted.replaceNode(markedNode);
		await vi.waitFor(() => expect(downloadImage).toHaveBeenLastCalledWith(SVG));
		await vi.waitFor(() => expect(mounted.image.getAttribute('src')).toBe(`/workspace/${SVG}?__diagram_preview=1`));
		expect(markedNode.attrs.src).toBe(PDF);

		const resizedNode = markedNode.type.create({ ...markedNode.attrs, width: 480 });
		mounted.replaceNode(resizedNode);
		expect(downloadImage).toHaveBeenCalledTimes(2);

		const publishedNode = resizedNode.type.create({ ...resizedNode.attrs });
		expect(publishedNode.eq(resizedNode)).toBe(true);
		const beforeEqualReplacement = downloadImage.mock.calls.length;
		mounted.replaceNode(publishedNode);
		await Promise.resolve();
		const afterEqualReplacement = downloadImage.mock.calls.length;
		window.dispatchEvent(new Event('texpile:fs-changed'));
		await vi.waitFor(() => expect(downloadImage).toHaveBeenCalledTimes(afterEqualReplacement + 1));
		await vi.waitFor(() => expect(mounted.image.getAttribute('src')).not.toBe(`/workspace/${SVG}?__diagram_preview=1`));
		expect(downloadImage.mock.calls.length).toBeGreaterThan(beforeEqualReplacement);
		expect(mounted.view.dom.querySelector('.imagePluginRoot')?.getAttribute('imageplugin-src')).toBe(PDF);
	});

	it('reports a missing SVG preview without falling back to or changing the PDF figure source', async () => {
		const downloadImage = vi.fn(async (path: string) => `/workspace/${path}`);
		const mounted = mountEditor(makeNode({ diagramType: 'drawio', diagramId: UUID, diagramSource: SOURCE }), makeSettings(downloadImage));
		await vi.waitFor(() => expect(mounted.image.getAttribute('src')).toBe(`/workspace/${SVG}?__diagram_preview=1`));
		mounted.image.dispatchEvent(new Event('error'));
		expect(mounted.image.title).toBe(`Diagram SVG preview unavailable: ${SVG}`);
		expect(mounted.view.dom.querySelector('.imagePluginRoot')?.getAttribute('imageplugin-src')).toBe(PDF);
		expect(downloadImage).toHaveBeenCalledWith(SVG);
	});

	it('does not let a superseded source resolver replace the current SVG', async () => {
		const oldSource = `assets/diagrams/old-${UUID}.drawio`;
		const oldPdf = oldSource.replace(/\.drawio$/, '.pdf');
		const nextId = '00000000-0000-4000-8000-000000000002';
		const nextSource = `assets/diagrams/new-${nextId}.drawio`;
		const nextPdf = nextSource.replace(/\.drawio$/, '.pdf');
		const oldResolution = deferred<string>();
		const nextResolution = deferred<string>();
		const downloadImage = vi.fn((path: string) =>
			path === oldSource.replace(/\.drawio$/, '.svg') ? oldResolution.promise : nextResolution.promise
		);
		const mounted = mountEditor(
			makeNode({ src: oldPdf, diagramType: 'drawio', diagramId: UUID, diagramSource: oldSource }),
			makeSettings(downloadImage)
		);
		await vi.waitFor(() => expect(downloadImage).toHaveBeenCalledTimes(1));

		mounted.replaceNode(makeNode({ src: nextPdf, diagramType: 'drawio', diagramId: nextId, diagramSource: nextSource }));
		await vi.waitFor(() => expect(downloadImage).toHaveBeenCalledTimes(2));
		nextResolution.resolve(`/workspace/${nextSource.replace(/\.drawio$/, '.svg')}`);
		await vi.waitFor(() =>
			expect(mounted.image.getAttribute('src')).toBe(`/workspace/${nextSource.replace(/\.drawio$/, '.svg')}?__diagram_preview=1`)
		);
		oldResolution.resolve(`/workspace/${oldSource.replace(/\.drawio$/, '.svg')}`);
		await Promise.resolve();
		expect(mounted.image.getAttribute('src')).toBe(`/workspace/${nextSource.replace(/\.drawio$/, '.svg')}?__diagram_preview=1`);
	});

	it('ignores stale or destroyed dimensions and resolver results', async () => {
		const firstDimensions = deferred<{ width: number; height: number; completed: boolean }>();
		const secondDimensions = deferred<{ width: number; height: number; completed: boolean }>();
		const dimensionLoads = [firstDimensions, secondDimensions];
		dimensionMock.load = vi.fn(() => dimensionLoads.shift()!.promise);
		const attrs = { diagramType: 'drawio', diagramId: UUID, diagramSource: SOURCE };
		const mounted = mountEditor(
			makeNode(attrs),
			makeSettings(async (path) => `/workspace/${path}`, true)
		);
		await vi.waitFor(() => expect(dimensionMock.load).toHaveBeenCalledTimes(1));

		mounted.replaceNode(makeNode(attrs));
		window.dispatchEvent(new Event('texpile:fs-changed'));
		await vi.waitFor(() => expect(dimensionMock.load).toHaveBeenCalledTimes(2));
		secondDimensions.resolve({ width: 640, height: 360, completed: true });
		await vi.waitFor(() => expect(mounted.image.getAttribute('src')).toBe(`/workspace/${SVG}?__diagram_preview=2`));
		firstDimensions.resolve({ width: 10, height: 10, completed: true });
		await Promise.resolve();
		expect(mounted.image.getAttribute('src')).toBe(`/workspace/${SVG}?__diagram_preview=2`);

		const lateResolver = deferred<string>();
		let resolverStarted = false;
		const destroyed = mountEditor(
			makeNode(attrs),
			makeSettings(() => {
				resolverStarted = true;
				return lateResolver.promise;
			})
		);
		await vi.waitFor(() => expect(resolverStarted).toBe(true));
		destroyed.view.destroy();
		destroyed.host.remove();
		editorViews.splice(
			editorViews.findIndex(({ view }) => view === destroyed.view),
			1
		);
		lateResolver.resolve(`/workspace/${SVG}`);
		await Promise.resolve();
		expect(destroyed.image.getAttribute('src')).toBeNull();

		const lateDimensions = deferred<{ width: number; height: number; completed: boolean }>();
		dimensionMock.load = vi.fn(() => lateDimensions.promise);
		const destroyedDuringMeasure = mountEditor(
			makeNode(attrs),
			makeSettings(async (path) => `/workspace/${path}`, true)
		);
		await vi.waitFor(() => expect(dimensionMock.load).toHaveBeenCalledTimes(1));
		destroyedDuringMeasure.view.destroy();
		destroyedDuringMeasure.host.remove();
		editorViews.splice(
			editorViews.findIndex(({ view }) => view === destroyedDuringMeasure.view),
			1
		);
		lateDimensions.resolve({ width: 320, height: 180, completed: true });
		await Promise.resolve();
		expect(destroyedDuringMeasure.image.getAttribute('src')).toBeNull();
	});
});
