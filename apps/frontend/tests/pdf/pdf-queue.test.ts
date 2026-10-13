import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PdfRenderQueue } from '../../src/features/pdf/render-queue.ts';
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };

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
