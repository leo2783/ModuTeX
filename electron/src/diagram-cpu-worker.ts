// Dedicated CPU entry: no workspace paths, filesystem or network operations.
// Worker threads are not an OS security sandbox; authority stays in the main host.
import { parentPort, workerData } from 'node:worker_threads';
import { prepareDrawioVectorSource } from './drawio-vector-source';
import { sanitizeDrawioLightSVG, sanitizeValidatedSVG } from './diagram-svg';

try {
	if (!parentPort || !workerData || typeof workerData.input !== 'string') throw new Error('INVALID_REQUEST');
	const result =
		workerData.operation === 'prepare'
			? prepareDrawioVectorSource(workerData.input)
			: workerData.operation === 'normalize'
				? sanitizeDrawioLightSVG(workerData.input)
				: workerData.operation === 'validate'
					? sanitizeValidatedSVG(workerData.input)
					: (() => {
							throw new Error('INVALID_REQUEST');
						})();
	parentPort.postMessage({ ok: true, result });
} catch (error) {
	parentPort?.postMessage({ ok: false, code: error instanceof Error ? error.message : 'RENDER_FAILED' });
}
