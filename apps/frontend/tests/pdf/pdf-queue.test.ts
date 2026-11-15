import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { PdfRenderQueue } from '../../src/features/pdf/render-queue.ts';
import { twoPages } from '../helpers/pdf-jsdom-harness.ts';
const deferred = <T = void>() => { let resolve!: (value: T | PromiseLike<T>) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; };

test('pause revokes old publication and pending work; resume waits for canvas release', async () => {
	const first = deferred(); const resumed = deferred(); const completed = deferred();
	const seen: number[] = []; const published: number[] = []; let active = 0; let peak = 0;
	const queue = new PdfRenderQueue<number>(async (page, current) => {
		seen.push(page); peak = Math.max(peak, ++active);
		await (page === 1 ? first.promise : resumed.promise);
		if (current()) published.push(page);
		--active; if (page === 4) completed.resolve();
	}, () => {}, () => assert.fail('revoked render cannot report failure'));
	queue.request(1); queue.request(2); queue.pause(); queue.request(3); queue.request(4);
	assert.deepEqual(seen, [1]);
	first.resolve(); await first.promise; await Promise.resolve();
	assert.deepEqual(seen, [1, 4]);
	resumed.resolve(); await completed.promise;
	assert.equal(peak, 1); assert.deepEqual(published, [4]);
	queue.dispose(); queue.pause(); queue.request(5); assert.deepEqual(seen, [1, 4]);
});

test('canvas queue serializes ownership and coalesces rapid page requests to latest', async () => {
	const first = deferred(); const last = deferred(); const completed = deferred();
	const seen: number[] = []; const published: number[] = []; let active = 0; let peak = 0; let cancelled = 0;
	const queue = new PdfRenderQueue<number>(async (page, current) => {
		seen.push(page); peak = Math.max(peak, ++active);
		await (page === 1 ? first.promise : last.promise);
		if (current()) published.push(page);
		--active; if (page === 4) completed.resolve();
	}, () => ++cancelled, () => assert.fail('unexpected failure'));
	queue.request(1); queue.request(2); queue.request(3); queue.request(4);
	assert.deepEqual(seen, [1]); assert.equal(cancelled, 3);
	first.resolve(); await first.promise; await Promise.resolve();
	assert.deepEqual(seen, [1, 4]); last.resolve(); await completed.promise;
	assert.equal(peak, 1); assert.deepEqual(published, [4]); queue.dispose();
});
test('dispose cancels current work, discards pending page and forbids late publication', async () => {
	const waiting = deferred(); const finished = deferred(); const seen: number[] = []; let published = false;
	const queue = new PdfRenderQueue<number>(async (page, current) => {
		seen.push(page); await waiting.promise; published = current(); finished.resolve();
	}, () => {}, () => assert.fail('disposed work cannot report failure'));
	queue.request(1); queue.request(2); queue.dispose(); queue.request(3); waiting.resolve(); await finished.promise;
	assert.deepEqual(seen, [1]); assert.equal(published, false);
});
test('current render failure is reported once and later requests remain usable', async () => {
	const done = deferred(); let failures = 0;
	const queue = new PdfRenderQueue<number>(async (page) => { if (page === 1) throw new Error('render failure'); done.resolve(); }, () => {}, () => ++failures);
	queue.request(1); await Promise.resolve(); await Promise.resolve(); assert.equal(failures, 1);
	queue.request(2); await done.promise; queue.dispose();
});

type Surface = { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D };
type CanvasFactory = {
	create(width: number, height: number): Surface;
	destroy(value: unknown): void;
};

test('real PDF.js work stays serialized through pause, resume, disposal and task destruction', { timeout: 10000 }, async () => {
	const loading = getDocument({ data: twoPages(), useSystemFonts: true });
	let destroyPromise: Promise<void> | undefined;
	const destroyLoading = () => (destroyPromise ??= loading.destroy());
	let queue: PdfRenderQueue<number> | undefined;
	let factory: CanvasFactory | undefined;
	let surface: Surface | undefined;
	let activeRender: RenderTask | undefined;

	const paused = Array.from({ length: 3 }, () => deferred<() => void>());
	const finished = Array.from({ length: 3 }, () => deferred<void>());
	const pageTwoRendered = deferred<void>();
	const attempts: number[] = [];
	const published: number[] = [];
	const operatorLists: Array<{ page: number; count: number; args: unknown[] }> = [];
	let activeDraws = 0;
	let peakDraws = 0;
	let failures = 0;

	try {
		const pdf = await loading.promise;
		assert.equal(pdf.numPages, 2);
		factory = pdf.canvasFactory as CanvasFactory;
		surface = factory.create(100, 100);

		queue = new PdfRenderQueue<number>(async (number, current) => {
			const slot = attempts.length;
			const pausedAttempt = paused[slot];
			const finishedAttempt = finished[slot];
			assert.ok(pausedAttempt && finishedAttempt, 'Only the three planned real render attempts may start');
			attempts.push(number);
			peakDraws = Math.max(peakDraws, ++activeDraws);
			let page: PDFPageProxy | undefined;
			let renderTask: RenderTask | undefined;
			try {
				page = await pdf.getPage(number);
				const operators = await page.getOperatorList();
				assert.ok(operators.fnArray.length > 0);
				assert.ok(operators.argsArray.length > 0);
				operatorLists.push({ page: number, count: operators.fnArray.length, args: operators.argsArray });

				const viewport = page.getViewport({ scale: 1 });
				renderTask = page.render({
					canvas: surface!.canvas,
					canvasContext: surface!.context,
					viewport
				});
				activeRender = renderTask;
				let held = false;
				renderTask.onContinue = (continueRendering: () => void) => {
					if (!held) {
						held = true;
						pausedAttempt.resolve(continueRendering);
					} else continueRendering();
				};

				await renderTask.promise;
				if (current()) {
					published.push(number);
					if (slot === 1) pageTwoRendered.resolve(undefined);
				}
			} finally {
				if (activeRender === renderTask) activeRender = undefined;
				try { page?.cleanup(); }
				finally {
					--activeDraws;
					finishedAttempt.resolve(undefined);
				}
			}
		}, () => activeRender?.cancel(), () => { ++failures; });

		queue.request(1);
		await paused[0]!.promise;
		queue.request(2);
		queue.pause();
		queue.request(2);
		const continuePageTwo = await paused[1]!.promise;
		continuePageTwo();
		await pageTwoRendered.promise;

		queue.request(1);
		await paused[2]!.promise;
		queue.dispose();
		await destroyLoading();
		await finished[2]!.promise;

		assert.deepEqual(attempts, [1, 2, 1]);
		assert.deepEqual(published, [2]);
		assert.equal(peakDraws, 1);
		assert.equal(failures, 0);
		const firstPage = operatorLists.find(({ page }) => page === 1);
		const secondPage = operatorLists.find(({ page }) => page === 2);
		assert.ok(firstPage && firstPage.count > 0);
		assert.ok(secondPage && secondPage.count > 0);
		assert.notDeepEqual(firstPage.args, secondPage.args);
	} finally {
		queue?.dispose();
		try {
			await destroyLoading();
			await Promise.all(finished.slice(0, attempts.length).map(({ promise }) => promise));
		} finally {
			if (factory && surface) factory.destroy(surface);
		}
	}
});
