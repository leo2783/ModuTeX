import type { SourceDocument, SourcePatch, SourceProjection } from '@modutex/document-core';
import type { ParserReply, ParserRequest } from './engine.ts';

export interface ParserTransport {
	postMessage(message: ParserRequest, transfer?: Transferable[]): void;
	onmessage: ((event: MessageEvent<ParserReply>) => void) | null;
	onerror: ((event: ErrorEvent) => unknown) | null;
	terminate(): unknown;
}
/** One in-flight message; bounded patches, latest-only resync under backpressure. */
export class ParserClient {
	private readonly worker: ParserTransport;
	private readonly publish: (projection: SourceProjection) => void;
	private readonly failed: () => void;
	private latest: SourceDocument;
	private queue: ParserRequest[] = [];
	private queuedUnits = 0;
	private reset = true;
	private parse = true;
	private sequence = 0;
	private inFlight = 0;
	private stopped = false;
	private deadline: ReturnType<typeof setTimeout> | undefined;
	private readonly responseTimeoutMs: number;
	constructor(worker: ParserTransport, initial: SourceDocument, publish: (projection: SourceProjection) => void, failed: () => void,
		responseTimeoutMs = 30_000) {
		if (!Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs < 1) throw new Error('INVALID_WORKER_TIMEOUT');
		this.responseTimeoutMs = responseTimeoutMs;
		this.worker = worker; this.latest = initial; this.publish = publish; this.failed = failed;
		worker.onmessage = (event) => this.receive(event.data);
		worker.onerror = () => this.fail();
		this.flush();
	}
	update(previous: SourceDocument, next: SourceDocument, patches: readonly SourcePatch[] | null): void {
		if (this.stopped) return;
		this.latest = next;
		// Parse as soon as the worker has consumed the pending source changes.
		// One in-flight request already provides backpressure; a second debounce
		// needlessly leaves the visible editor waiting after each interaction.
		this.parse = true;
		const units = patches?.reduce((sum, patch) => sum + patch.insert.length, 0) ?? 0;
		if (!patches || patches.length > 256 || this.queue.length >= 64 || this.queuedUnits + units > 5 * 1024 * 1024) {
			this.reset = true; this.queue = []; this.queuedUnits = 0;
		} else if (!this.reset) {
			this.queue.push({ kind: 'patch', seq: ++this.sequence, documentId: next.documentId,
				expectedVersion: previous.version, version: next.version, patches });
			this.queuedUnits += units;
		}
		this.flush();
	}
	private flush(): void {
		if (this.stopped || this.inFlight) return;
		let request: ParserRequest;
		if (this.reset) {
			this.reset = false; this.queue = []; this.queuedUnits = 0;
			request = { kind: 'reset', seq: ++this.sequence, documentId: this.latest.documentId, version: this.latest.version,
				bytes: new Uint8Array(this.latest.toBytes()) };
		} else if (this.queue.length) {
			request = this.queue.shift()!;
			if (request.kind === 'patch') this.queuedUnits -= request.patches.reduce((sum, patch) => sum + patch.insert.length, 0);
		} else if (this.parse) {
			this.parse = false;
			request = { kind: 'parse', seq: ++this.sequence, documentId: this.latest.documentId, version: this.latest.version };
		} else return;
		this.inFlight = request.seq;
		const sequence = request.seq;
		this.deadline = setTimeout(() => {
			if (!this.stopped && this.inFlight === sequence) this.fail();
		}, this.responseTimeoutMs);
		try { this.worker.postMessage(request, request.kind === 'reset' ? [request.bytes.buffer as ArrayBuffer] : []); }
		catch { this.fail(); }
	}
	private receive(reply: ParserReply): void {
		if (this.stopped || reply.seq !== this.inFlight) return;
		clearTimeout(this.deadline); this.deadline = undefined;
		this.inFlight = 0;
		if (reply.kind === 'error') { this.fail(); return; }
		if (reply.kind === 'projection' && reply.projection.documentId === this.latest.documentId && reply.projection.version === this.latest.version) this.publish(reply.projection);
		this.flush();
	}
	private fail(): void {
		if (this.stopped) return;
		this.dispose();
		this.failed();
	}
	dispose(): void {
		if (this.stopped) return;
		this.stopped = true; clearTimeout(this.deadline);
		this.deadline = undefined; this.inFlight = 0;
		this.queue = []; this.queuedUnits = 0;
		this.worker.onmessage = null; this.worker.onerror = null; this.worker.terminate();
	}
}
