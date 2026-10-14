import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceDocument } from '@modutex/document-core';
import { ParserClient, type ParserTransport } from '../../src/features/parser/client.ts';
import { ParserEngine, type ParserRequest } from '../../src/features/parser/engine.ts';

test('parser schedules the latest projection immediately after real engine patch acknowledgements', () => {
	const requests: ParserRequest[] = [];
	const engine = new ParserEngine();
	const published: number[] = [];
	let terminated = false;
	const transport: ParserTransport = {
		onmessage: null, onerror: null,
		postMessage(request) { requests.push(request); },
		terminate() { terminated = true; }
	};
	const original = SourceDocument.open(new TextEncoder().encode('Alpha'));
	const client = new ParserClient(transport, original, projection => published.push(projection.version), () => assert.fail('engine failed'));
	const acknowledge = () => {
		const request = requests.shift();
		assert.ok(request);
		transport.onmessage?.({ data: engine.handle(request) } as MessageEvent);
		return request.kind;
	};
	try {
		assert.equal(acknowledge(), 'reset');
		assert.equal(acknowledge(), 'parse');
		assert.deepEqual(published, [0]);
		const firstPatch = [{ from: original.length, to: original.length, insert: ' one' }];
		const first = original.apply({ expectedVersion: original.version, patches: firstPatch }).document;
		client.update(original, first, firstPatch);
		const secondPatch = [{ from: first.length, to: first.length, insert: ' two' }];
		const second = first.apply({ expectedVersion: first.version, patches: secondPatch }).document;
		client.update(first, second, secondPatch);
		assert.equal(requests.length, 1, 'one in-flight patch, without starting parallel parse work');
		assert.equal(acknowledge(), 'patch');
		assert.equal(acknowledge(), 'patch');
		assert.equal(requests[0]?.kind, 'parse', 'no timer or extra event turn required');
		assert.equal(acknowledge(), 'parse');
		assert.deepEqual(published, [0, second.version]);
		assert.equal(requests.length, 0);
	} finally { client.dispose(); }
	assert.equal(terminated, true);
});
