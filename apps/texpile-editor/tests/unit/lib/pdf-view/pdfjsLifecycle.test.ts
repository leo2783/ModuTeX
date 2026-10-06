import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createCanvas } from '@napi-rs/canvas';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EventBus } from '$lib/pdf-view/pdf-viewer/EventBus';
import { PDFViewerCore } from '$lib/pdf-view/pdf-viewer/PDFViewerCore';
import { runAfterCurrentPdfViewerLoad } from '$lib/pdf-view/pdf-viewer/load-lifecycle';
import { createPdfLoadingTask, destroyPdfDocumentTask, type PdfDocumentTask } from '$lib/pdf-view/pdf-viewer/pdfjs-singleton';

const fixture = new Uint8Array(readFileSync(new URL('../../../fixtures/pdf/lifecycle-red-square.pdf', import.meta.url)));
const liveTasks = new Set<PdfDocumentTask>();
let dom: JSDOM;

async function openFixture() {
	const task = createPdfLoadingTask(pdfjs, fixture);
	liveTasks.add(task);
	return { task, document: await task.promise };
}

beforeAll(() => {
	dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
	globalThis.window = dom.window as unknown as Window & typeof globalThis;
	globalThis.document = dom.window.document;
	globalThis.AbortController = dom.window.AbortController;
});

afterEach(async () => {
	await Promise.all([...liveTasks].map((task) => destroyPdfDocumentTask(task)));
	liveTasks.clear();
});

afterAll(() => {
	dom.window.close();
});

function createViewer() {
	const container = document.createElement('div');
	container.style.height = '720px';
	document.body.appendChild(container);
	const viewer = new PDFViewerCore({ container, eventBus: new EventBus() });
	// The viewer lifecycle test is about real PDF.js document adoption/teardown. Painting is covered
	// separately below with PDF.js's real render task and a native canvas, not a fabricated proxy.
	Object.defineProperty(viewer, 'processRenderingQueue', { value: () => {} });
	return viewer;
}

describe('PDF.js 6.2 lifecycle through production consumers', () => {
	it('loads the checked-in PDF bytes and rasterizes its red vector mark', async () => {
		const { task, document: pdfDocument } = await openFixture();
		const page = await pdfDocument.getPage(1);
		const canvas = createCanvas(72, 72);
		// PDF.js declares the browser canvas contract. The native Node canvas implements its render
		// operations, but its type uses a native Canvas instead of the DOM HTMLCanvasElement property.
		const canvasContext = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;

		await page.render({ canvas: null, canvasContext, viewport: page.getViewport({ scale: 1 }) }).promise;

		const redPixel = canvasContext.getImageData(36, 36, 1, 1).data;
		expect(redPixel[0]).toBeGreaterThan(200);
		expect(redPixel[1]).toBeLessThan(30);
		expect(redPixel[2]).toBeLessThan(30);
		await destroyPdfDocumentTask(task);
		expect(task.destroyed).toBe(true);
	});

	it('replaces and unmounts documents via PDFViewerCore loading-task ownership', async () => {
		const viewer = createViewer();
		const first = await openFixture();
		const second = await openFixture();

		expect(await viewer.setDocument(first.document)).toBe(true);
		expect(viewer.pagesCount).toBe(1);
		expect(await viewer.setDocument(second.document)).toBe(true);
		expect(first.task.destroyed).toBe(true);
		expect(viewer.pagesCount).toBe(1);

		viewer.destroy();
		expect(second.task.destroyed).toBe(true);
		expect(viewer.viewer.isConnected).toBe(false);
	});

	it('does not adopt a stale document when a newer load or unmount wins', async () => {
		const viewer = createViewer();
		const stale = await openFixture();
		const current = await openFixture();

		const staleAdoption = viewer.setDocument(stale.document);
		const currentAdoption = viewer.setDocument(current.document);
		expect(await staleAdoption).toBe(false);
		expect(await currentAdoption).toBe(true);
		expect(viewer.pagesCount).toBe(1);
		expect(stale.task.destroyed).toBe(false);

		await destroyPdfDocumentTask(stale.task);
		expect(stale.task.destroyed).toBe(true);
		viewer.destroy();
		expect(current.task.destroyed).toBe(true);

		const unmountedViewer = createViewer();
		const pending = await openFixture();
		const adoption = unmountedViewer.setDocument(pending.document);
		unmountedViewer.destroy();
		expect(await adoption).toBe(false);
		await destroyPdfDocumentTask(pending.task);
		expect(pending.task.destroyed).toBe(true);
	});

	it('shares one real loading-task destruction promise across cleanup owners', async () => {
		const { task } = await openFixture();
		const firstDestruction = destroyPdfDocumentTask(task);
		const secondDestruction = destroyPdfDocumentTask(task);

		expect(secondDestruction).toBe(firstDestruction);
		await firstDestruction;
		expect(task.destroyed).toBe(true);
	});

	it('does not create a worker when destroy invalidates an in-flight singleton import', async () => {
		vi.resetModules();
		vi.doMock('esm-env', () => ({ BROWSER: true }));
		const workerConstructor = vi.fn(() => {
			throw new Error('stale PDF.js init must not construct a worker');
		});
		vi.stubGlobal('Worker', workerConstructor);

		try {
			const singleton = await import('$lib/pdf-view/pdf-viewer/pdfjs-singleton');
			const pendingInitialization = singleton.getPdfJs();
			singleton.destroyPdfJs();

			await expect(pendingInitialization).resolves.toBeNull();
			expect(workerConstructor).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
			vi.doUnmock('esm-env');
			vi.resetModules();
		}
	});

	it('does not construct a detached viewer after its lazy modules resolve', async () => {
		let resolveModules!: (modules: { core: 'loaded' }) => void;
		const modules = new Promise<{ core: 'loaded' }>((resolve) => {
			resolveModules = resolve;
		});
		let generation = 4;
		let componentAlive = true;
		let containerConnected = true;
		const setupViewer = vi.fn(() => {
			throw new Error('stale PDF viewer setup must not run');
		});
		const setup = runAfterCurrentPdfViewerLoad(
			() => modules,
			() => componentAlive && containerConnected && generation === 4,
			setupViewer
		);

		generation++;
		componentAlive = false;
		containerConnected = false;
		resolveModules({ core: 'loaded' });

		expect(await setup).toBe(false);
		expect(setupViewer).not.toHaveBeenCalled();
	});
});
