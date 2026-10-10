import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { SourceDocument, parseSource, type SourceProjection } from '@modutex/document-core';
import { ParserClient, type ParserTransport } from '../../src/features/parser/client.ts';
import type { ParserReply, ParserRequest } from '../../src/features/parser/engine.ts';
const createWorker = () => new Worker(new URL('.././helpers/parser-worker.ts', import.meta.url));
const bytes = (text: string) => new TextEncoder().encode(text);
function ask(worker: Worker, request: ParserRequest): Promise<ParserReply> {
	return new Promise((resolve, reject) => { worker.once('message', resolve); worker.once('error', reject); worker.postMessage(request); });
}

test('real parser worker accepts 5 MiB, applies a bounded patch, and keeps current source after oversized reset', { timeout: 30_000 }, async () => {
	const worker = createWorker();
	try {
		const input = new Uint8Array(5 * 1024 * 1024).fill(97);
		input.set([0xef, 0xbb, 0xbf]); input.set([13, 10], 3);
		const original = SourceDocument.open(input);
		assert.equal((await ask(worker, { kind: 'reset', seq: 1, documentId: original.documentId, version: 0, bytes: input })).kind, 'ack');
		const patches = [{ from: 20, to: 21, insert: 'z' }];
		const next = original.apply({ expectedVersion: 0, patches }).document;
		assert.equal((await ask(worker, { kind: 'patch', seq: 2, documentId: original.documentId, expectedVersion: 0, version: 1, patches })).kind, 'ack');
		const result = await ask(worker, { kind: 'parse', seq: 3, documentId: original.documentId, version: 1 });
		assert.equal(result.kind, 'projection');
		if (result.kind === 'projection') assert.deepEqual(result.projection, parseSource(next));
		assert.equal((await ask(worker, { kind: 'reset', seq: 4, documentId: 'too-large', version: 0, bytes: new Uint8Array(input.length + 1) })).kind, 'error');
		const retained = await ask(worker, { kind: 'parse', seq: 5, documentId: original.documentId, version: 1 });
		assert.deepEqual(retained.kind === 'projection' ? retained.projection : null, result.kind === 'projection' ? result.projection : undefined);
	} finally { await worker.terminate(); }
});

test('a real worker applies local source patches and returns correctly bound spans', async () => {
	const worker = createWorker();
	try {
		const original = SourceDocument.open(bytes('\uFEFF%keep\r\n\\section{Old}\n'));
		assert.equal((await ask(worker, { kind: 'reset', seq: 1, documentId: original.documentId, version: 0, bytes: original.toBytes() })).kind, 'ack');
		const patches = [{ from: 0, to: 0, insert: 'new\r\n' }];
		const next = original.apply({ expectedVersion: 0, patches }).document;
		assert.equal((await ask(worker, { kind: 'patch', seq: 2, documentId: original.documentId, expectedVersion: 0, version: 1, patches })).kind, 'ack');
		const result = await ask(worker, { kind: 'parse', seq: 3, documentId: original.documentId, version: 1 });
		assert.equal(result.kind, 'projection');
		if (result.kind === 'projection') assert.deepEqual(result.projection, parseSource(next));
		assert.equal((await ask(worker, { kind: 'patch', seq: 4, documentId: original.documentId, expectedVersion: 0, version: 1, patches })).kind, 'error');
		const unchanged = await ask(worker, { kind: 'parse', seq: 5, documentId: original.documentId, version: 1 });
		if (unchanged.kind === 'projection') assert.deepEqual(unchanged.projection, parseSource(next));
	} finally { await worker.terminate(); }
});

test('real worker backpressure resyncs only the latest snapshot and teardown releases the thread', async () => {
	const worker = createWorker();
	let resets = 0;
	const transport: ParserTransport = {
		onmessage: null, onerror: null,
		postMessage(request, transfer) { if (request.kind === 'reset') resets++; worker.postMessage(request, transfer as ArrayBuffer[]); },
		terminate() { return worker.terminate(); }
	};
	worker.on('message', (data: ParserReply) => transport.onmessage?.({ data } as MessageEvent<ParserReply>));
	worker.on('error', (error) => transport.onerror?.(error as unknown as ErrorEvent));
	let source = SourceDocument.open(bytes('\\section{A}\n' + 'body '.repeat(20000)));
	let resolveProjection!: (projection: SourceProjection) => void;
	let rejectProjection!: (error: Error) => void;
	const finished = new Promise<SourceProjection>((resolve, reject) => { resolveProjection = resolve; rejectProjection = reject; });
	const client = new ParserClient(transport, source, resolveProjection, () => rejectProjection(new Error('Worker failed')));
	try {
		for (let index = 0; index < 80; index++) {
			const previous = source;
			const patches = [{ from: 0, to: 0, insert: 'x' }];
			source = source.apply({ expectedVersion: source.version, patches }).document;
			client.update(previous, source, patches);
		}
		const result = await finished;
		assert.equal(result.documentId, source.documentId);
		assert.equal(result.version, 80);
		assert.deepEqual(result, parseSource(source));
		assert.equal(resets, 2);
	} finally {
		client.dispose();
		await worker.terminate();
	}
	assert.equal(transport.onmessage, null);
	assert.equal(transport.onerror, null);
});

test('a genuinely stalled parser thread times out once, releases handlers and ignores late replies', { timeout: 10_000 }, async () => {
	const worker = new Worker(new URL('.././helpers/parser-worker.ts', import.meta.url), { workerData: { stallAfterFirstReply: true } });
	await once(worker, 'online');
	let sent = 0, terminated = 0, failures = 0, projections = 0;
	const exited = once(worker, 'exit');
	let failed!: () => void;
	const failure = new Promise<void>((resolve) => { failed = resolve; });
	const transport: ParserTransport = {
		onmessage: null, onerror: null,
		postMessage(request, transfer) { sent++; worker.postMessage(request, transfer as ArrayBuffer[]); },
		terminate() { terminated++; return worker.terminate(); }
	};
	worker.on('message', (data: ParserReply) => transport.onmessage?.({ data } as MessageEvent<ParserReply>));
	worker.on('error', (error) => transport.onerror?.(error as unknown as ErrorEvent));
	const original = SourceDocument.open(bytes('\uFEFFbody\r\n'));
	const client = new ParserClient(transport, original, () => projections++, () => { failures++; failed(); }, 1000);
	const lateReply = transport.onmessage!;
	try {
		await failure;
		await exited;
		assert.equal(sent, 2); // Genuine reset ack followed by a blocked parse.
		assert.equal(failures, 1);
		assert.equal(terminated, 1);
		assert.equal(transport.onmessage, null);
		assert.equal(transport.onerror, null);
		const patches = [{ from: 0, to: 0, insert: 'new\r\n' }];
		const next = original.apply({ expectedVersion: 0, patches }).document;
		client.update(original, next, patches);
		lateReply({ data: { kind: 'projection', seq: 2, projection: parseSource(original) } } as MessageEvent<ParserReply>);
		client.dispose(); client.dispose();
		assert.equal(sent, 2);
		assert.equal(projections, 0);
		assert.equal(failures, 1);
		assert.equal(terminated, 1);
		assert.deepEqual(original.toBytes(), bytes('\uFEFFbody\r\n'));
		const replacement = createWorker();
		const replacementTransport: ParserTransport = {
			onmessage: null, onerror: null,
			postMessage(request, transfer) { replacement.postMessage(request, transfer as ArrayBuffer[]); },
			terminate() { return replacement.terminate(); }
		};
		replacement.on('message', (data: ParserReply) => replacementTransport.onmessage?.({ data } as MessageEvent<ParserReply>));
		replacement.on('error', (error) => replacementTransport.onerror?.(error as unknown as ErrorEvent));
		let recovered!: (projection: SourceProjection) => void, recoveryError!: (error: Error) => void;
		const recovery = new Promise<SourceProjection>((resolve, reject) => { recovered = resolve; recoveryError = reject; });
		const renewed = new ParserClient(replacementTransport, next, recovered, () => recoveryError(new Error('Recovery failed')), 1500);
		try {
			assert.deepEqual(await recovery, parseSource(next));
			lateReply({ data: { kind: 'projection', seq: 2, projection: parseSource(original) } } as MessageEvent<ParserReply>);
			assert.equal(projections, 0);
			assert.equal(failures, 1);
		} finally { renewed.dispose(); await replacement.terminate(); }
	} finally { client.dispose(); await worker.terminate(); }
});
