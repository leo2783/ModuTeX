import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { DRAWIO_SOURCE_LIMIT } from './diagram-security';
import { SVG_BYTE_LIMIT, DiagramSvgError, type DiagramSvgErrorCode, type ValidatedDiagramSvg } from './diagram-svg';

type Operation = 'prepare' | 'normalize' | 'validate';
type Result = { xml: string } | ValidatedDiagramSvg;
interface Task {
	operation: Operation;
	input: string;
	signal?: AbortSignal;
	resolve(result: Result): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
	abort(): void;
	worker?: Worker;
	finished: boolean;
}
const SVG_ERRORS = new Set<DiagramSvgErrorCode>(['INVALID_SVG', 'SVG_TOO_LARGE', 'SVG_TOO_COMPLEX', 'INVALID_VIEWPORT']);
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
	return (
		!!value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).length === keys.length &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}
function bounded(value: unknown, limit: number): value is string {
	return typeof value === 'string' && value.length <= limit && Buffer.byteLength(value, 'utf8') <= limit;
}
/** Single native-owned executor shared by IPC preparation and PDF revalidation. */
export class DiagramCpu {
	private queue: Task[] = [];
	private running = new Set<Task>();
	private terminating = new Set<Promise<number>>();
	private closed = false;
	// Path/deadline are native-only test seams, never obtained from renderer input.
	constructor(
		private readonly artifact = join(__dirname, 'diagram-cpu-worker.js'),
		private readonly deadline = 30_000
	) {}
	prepare(xml: string, signal?: AbortSignal): Promise<{ xml: string }> {
		return this.submit('prepare', xml, signal) as Promise<{ xml: string }>;
	}
	normalize(svg: string, signal?: AbortSignal): Promise<ValidatedDiagramSvg> {
		return this.submit('normalize', svg, signal) as Promise<ValidatedDiagramSvg>;
	}
	validate(svg: string, signal?: AbortSignal): Promise<ValidatedDiagramSvg> {
		return this.submit('validate', svg, signal) as Promise<ValidatedDiagramSvg>;
	}
	private submit(operation: Operation, input: string, signal?: AbortSignal): Promise<Result> {
		if (this.closed || signal?.aborted) return Promise.reject(new Error('RENDER_ABORTED'));
		if (!bounded(input, operation === 'prepare' ? DRAWIO_SOURCE_LIMIT : SVG_BYTE_LIMIT))
			return Promise.reject(new Error('INVALID_REQUEST'));
		if (this.running.size >= 2 && this.queue.length >= 4) return Promise.reject(new Error('REQUEST_ALREADY_RUNNING'));
		return new Promise((resolve, reject) => {
			const task: Task = {
				operation,
				input,
				signal,
				resolve,
				reject,
				finished: false,
				timer: setTimeout(() => this.finish(task, new Error('RENDER_TIMEOUT')), this.deadline),
				abort: () => this.finish(task, new Error('RENDER_ABORTED'))
			};
			signal?.addEventListener('abort', task.abort, { once: true });
			this.queue.push(task);
			this.pump();
		});
	}
	private pump(): void {
		while (!this.closed && this.running.size < 2 && this.queue.length) {
			const task = this.queue.shift()!;
			if (task.finished) continue;
			this.running.add(task);
			try {
				const worker = new Worker(this.artifact, {
					workerData: { operation: task.operation, input: task.input },
					resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 4 }
				});
				task.worker = worker;
				worker.once('error', () => this.finish(task, new Error('RENDER_FAILED')));
				worker.once('exit', () => this.finish(task, new Error('RENDER_FAILED')));
				worker.once('message', (message: unknown) => {
					if (exact(message, ['ok', 'code']) && message.ok === false && typeof message.code === 'string') {
						const error = SVG_ERRORS.has(message.code as DiagramSvgErrorCode)
							? new DiagramSvgError(message.code as DiagramSvgErrorCode)
							: new Error(message.code === 'INVALID_REQUEST' ? 'INVALID_REQUEST' : 'RENDER_FAILED');
						this.finish(task, error);
						return;
					}
					if (!exact(message, ['ok', 'result']) || message.ok !== true) {
						this.finish(task, new Error('RENDER_FAILED'));
						return;
					}
					const result = message.result;
					if (task.operation === 'prepare') {
						if (!exact(result, ['xml']) || !bounded(result.xml, DRAWIO_SOURCE_LIMIT) || !result.xml.length) {
							this.finish(task, new Error('RENDER_FAILED'));
							return;
						}
					} else if (
						!exact(result, ['svg', 'widthPx', 'heightPx']) ||
						!bounded(result.svg, SVG_BYTE_LIMIT) ||
						!result.svg.length ||
						typeof result.widthPx !== 'number' ||
						typeof result.heightPx !== 'number' ||
						!Number.isFinite(result.widthPx) ||
						!Number.isFinite(result.heightPx) ||
						result.widthPx < 1 ||
						result.heightPx < 1 ||
						result.widthPx > 8192 ||
						result.heightPx > 8192 ||
						result.widthPx * result.heightPx > 16_777_216
					) {
						this.finish(task, new Error('RENDER_FAILED'));
						return;
					}
					this.finish(task, undefined, result as unknown as Result);
				});
			} catch {
				this.finish(task, new Error('RENDER_FAILED'));
			}
		}
	}
	private finish(task: Task, error?: Error, result?: Result): void {
		if (task.finished) return;
		task.finished = true;
		clearTimeout(task.timer);
		task.signal?.removeEventListener('abort', task.abort);
		this.queue = this.queue.filter((queued) => queued !== task);
		const complete = () => {
			this.running.delete(task);
			if (error) task.reject(error);
			else task.resolve(result!);
			this.pump();
		};
		if (!task.worker) {
			complete();
			return;
		}
		// Do not free the concurrency slot until the old thread has actually exited.
		const termination = task.worker.terminate();
		this.terminating.add(termination);
		void termination
			.then(complete, () => {
				error = new Error('RENDER_FAILED');
				complete();
			})
			.finally(() => this.terminating.delete(termination));
	}
	async close(): Promise<void> {
		this.closed = true;
		for (const task of [...this.queue, ...this.running]) this.finish(task, new Error('RENDER_ABORTED'));
		await Promise.all([...this.terminating]);
	}
}
export const diagramCpu = new DiagramCpu();
