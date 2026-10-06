import { BROWSER } from 'esm-env';
import type { PDFWorker } from 'pdfjs-dist/legacy/build/pdf.mjs';

export type PdfJsLibrary = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
export type PdfDocumentTask = ReturnType<PdfJsLibrary['getDocument']>;
export type PdfDocumentInitParameters = Exclude<Parameters<PdfJsLibrary['getDocument']>[0], undefined>;
export type PdfDocumentSource = string | URL | ArrayBuffer | Uint8Array | PdfDocumentInitParameters;

const taskDestructions = new WeakMap<PdfDocumentTask, Promise<void>>();

export function normalizePdfDocumentSource(source: PdfDocumentSource): PdfDocumentInitParameters {
	if (typeof source === 'string' || source instanceof URL) return { url: source };
	if (source instanceof ArrayBuffer) return { data: source };
	if (source instanceof Uint8Array) return { data: new Uint8Array(source) };
	return source;
}

/** Uses the installed PDF.js loader for either direct inputs or its typed parameter object. */
export function createPdfLoadingTask(pdfjs: PdfJsLibrary, source: PdfDocumentSource, worker?: PDFWorker): PdfDocumentTask {
	const parameters = normalizePdfDocumentSource(source);
	return pdfjs.getDocument(worker ? { ...parameters, worker } : parameters);
}

/** Idempotent task teardown shared by component cancellation and viewer cleanup paths. */
export function destroyPdfDocumentTask(task: PdfDocumentTask): Promise<void> {
	let destruction = taskDestructions.get(task);
	if (!destruction) {
		destruction = task.destroy();
		taskDestructions.set(task, destruction);
	}
	return destruction;
}

/** Report fire-and-forget teardown failures instead of hiding rejected cleanup promises. */
export function reportPdfDocumentTaskCleanupFailure(error: unknown): void {
	console.error('PDF.js document cleanup failed.', error);
}

function disposePdfWorker(pdfWorker: PDFWorker | null, rawWorker: Worker | null): void {
	let pdfWorkerFailure: unknown;
	let failedToDestroyPdfWorker = false;
	try {
		pdfWorker?.destroy();
	} catch (error) {
		failedToDestroyPdfWorker = true;
		pdfWorkerFailure = error;
	}

	try {
		rawWorker?.terminate();
	} catch (error) {
		if (failedToDestroyPdfWorker) {
			throw new AggregateError([pdfWorkerFailure, error], 'PDF.js worker teardown failed');
		}
		throw error;
	}
	if (failedToDestroyPdfWorker) throw pdfWorkerFailure;
}

let pdfjsLib: PdfJsLibrary | null = null;
let pdfWorker: PDFWorker | null = null;
let rawWorker: Worker | null = null;
let initPromise: Promise<PdfJsLibrary | null> | null = null;
let pdfJsGeneration = 0;

/** the PDF.js library instance; creates the worker on first call, cached afterwards. */
export async function getPdfJs(): Promise<PdfJsLibrary | null> {
	if (!BROWSER) return null;

	if (pdfjsLib && pdfWorker) return pdfjsLib;

	if (initPromise) return initPromise;

	const generation = pdfJsGeneration;
	const initialization = (async () => {
		let createdRawWorker: Worker | null = null;
		let createdPdfWorker: PDFWorker | null = null;
		const disposeCreatedWorker = () => {
			const workerToDispose = createdPdfWorker;
			const rawWorkerToDispose = createdRawWorker;
			createdPdfWorker = null;
			createdRawWorker = null;
			disposePdfWorker(workerToDispose, rawWorkerToDispose);
		};
		try {
			const importedPdfJs = await import('pdfjs-dist/legacy/build/pdf.mjs');
			if (generation !== pdfJsGeneration) return null;

			// import.meta.url so bundlers resolve the worker file correctly
			createdRawWorker = new Worker(new URL('pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url), {
				type: 'module'
			});
			createdPdfWorker = importedPdfJs.PDFWorker.create({ port: createdRawWorker });

			// destroyPdfJs can invalidate an import while it is pending. Never publish an instance
			// created for an older generation, and dispose of any worker allocated by that init.
			if (generation !== pdfJsGeneration) {
				disposeCreatedWorker();
				return null;
			}

			importedPdfJs.GlobalWorkerOptions.workerPort = createdPdfWorker.port;
			pdfjsLib = importedPdfJs;
			pdfWorker = createdPdfWorker;
			rawWorker = createdRawWorker;
			createdPdfWorker = null;
			createdRawWorker = null;
			return pdfjsLib;
		} catch (error) {
			try {
				disposeCreatedWorker();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], 'PDF.js initialization and worker cleanup both failed');
			}
			throw error;
		} finally {
			if (initPromise === initialization) initPromise = null;
		}
	})();

	initPromise = initialization;
	return initialization;
}

/**
 * Open a document on the SHARED worker, without letting it be adopted.
 *
 * Use this rather than pdfjs.getDocument() directly. getDocument() with no `worker` in its source
 * does this (pdf.mjs, getDocument):
 *
 *     if (!worker) {
 *       worker = PDFWorker.create({ port: GlobalWorkerOptions.workerPort });
 *       task._worker = worker;
 *     }
 *
 * which hands our one process-wide worker to the loading task as if the task owned it. Destroying
 * any single document then destroys the worker for every other document: PDFDocumentLoadingTask
 * .destroy() flags the port `_pendingDestroy`, awaits the transport, then terminates the worker and
 * drops it from PDFWorker's port map.
 *
 * Two ways that broke. A load starting inside that await window throws "PDFWorker.create - the
 * worker is being destroyed"; a load starting after it completes gets a worker that has already
 * been terminated and simply never resolves. Guests hit both, because a guest's PDF arrives as a
 * new blob on every host compile - a real document switch each time, so destroy-then-load runs on
 * every compile, and PDFViewerCore.cleanup() does not await the destroy.
 *
 * Passing `worker` takes the branch above out of play: `src.worker instanceof PDFWorker` leaves
 * task._worker null, so no document destroy can reach the worker. It lives until destroyPdfJs().
 */
export async function getPdfDocument(src: PdfDocumentSource): Promise<PdfDocumentTask | null> {
	const generation = pdfJsGeneration;
	const pdfjs = await getPdfJs();
	if (!pdfjs || generation !== pdfJsGeneration || pdfjs !== pdfjsLib || !pdfWorker) return null;
	return createPdfLoadingTask(pdfjs, src, pdfWorker);
}

/** destroys the PDF.js worker; the next getPdfJs() call creates a new one. */
export function destroyPdfJs(): void {
	pdfJsGeneration++;
	const currentPdfJs = pdfjsLib;
	const currentPdfWorker = pdfWorker;
	const currentRawWorker = rawWorker;
	pdfjsLib = null;
	pdfWorker = null;
	rawWorker = null;
	initPromise = null;

	// before pdfjsLib goes: otherwise the reference is lost and workerPort keeps pointing at a
	// terminated port, which the next getDocument() would look up in PDFWorker's port map
	try {
		if (currentPdfJs) currentPdfJs.GlobalWorkerOptions.workerPort = null;
	} finally {
		disposePdfWorker(currentPdfWorker, currentRawWorker);
	}
}
