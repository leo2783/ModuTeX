import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFPageProxy, RenderTask } from 'pdfjs-dist';
import { PdfRenderQueue } from '../../src/features/pdf/render-queue.ts';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

/** Original two-page vector fixture; offsets calculated from actual ASCII bytes. */
function twoPages(): Uint8Array {
	const commands = ['0 0 0 rg 10 10 20 20 re f', '0 0 0 rg 60 60 20 20 re f'];
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 5 0 R >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << >> /Contents 6 0 R >>',
		...commands.map((value) => `<< /Length ${value.length} >>\nstream\n${value}\nendstream`)
	];
	let value = '%PDF-1.7\n'; const offsets = [0];
	for (const [index, object] of objects.entries()) { offsets.push(value.length); value += `${index + 1} 0 obj\n${object}\nendobj\n`; }
	const xref = value.length;
	value += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
	value += offsets.slice(1).map((offset) => String(offset).padStart(10, '0') + ' 00000 n \n').join('');
	value += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return new TextEncoder().encode(value);
}

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
