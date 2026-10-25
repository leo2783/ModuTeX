import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const frontendRoot = fileURLToPath(new URL('..', import.meta.url));
const vite = await createServer({
	configFile: false,
	root: frontendRoot,
	server: { middlewareMode: true },
	appType: 'custom'
});
const { createTauriFilesAdapter } = await vite.ssrLoadModule('/src/features/files/tauri-files.ts');
after(async () => vite.close());

function transport(handler) {
	const calls = [];
	const listeners = new Map();
	const registrations = [];
	return {
		calls,
		registrations,
		async invoke(name, args = {}) {
			calls.push({ name, args });
			return handler(name, args);
		},
		async listen(name, listener) {
			const group = listeners.get(name) ?? new Set();
			group.add(listener);
			listeners.set(name, group);
			registrations.push({ name, listener });
			return () => group.delete(listener);
		},
		emit(name, payload) {
			for (const listener of listeners.get(name) ?? []) listener(payload);
		}
	};
}

const recentId = '123e4567-e89b-42d3-a456-426614174000';
const workspace = { id: 'ws-1', label: 'Thesis', entryPath: 'main.tex' };

function readerFor(bytes) {
	const wire = transport((name) => {
		assert.equal(name, 'frontend_read_file');
		return { workspaceId: 'ws-1', path: 'main.tex', bytes, revision: 'rev-1', documentId: null, documentVersion: null };
	});
	return createTauriFilesAdapter(undefined, wire);
}

test('routes DesktopPort file and recent operations through strict contract validators', async () => {
	const wire = transport((name, args) => {
		switch (name) {
			case 'frontend_list_recent':
				return [{ id: recentId, label: 'Thesis', entryPath: 'main.tex', openedAt: 1 }];
			case 'frontend_open_workspace':
			case 'frontend_open_recent':
				return workspace;
			case 'frontend_list_files':
				return [{ path: 'main.tex', kind: 'file' }];
			case 'frontend_read_file':
				return { workspaceId: 'ws-1', path: 'main.tex', bytes: [0, 255], revision: 'rev-1', documentId: null, documentVersion: null };
			case 'frontend_write_file':
				return {
					workspaceId: args.request.workspaceId,
					path: args.request.path,
					revision: 'rev-2',
					documentId: args.request.documentId,
					documentVersion: args.request.documentVersion
				};
			case 'frontend_save_as':
			case 'frontend_remove_recent':
			case 'frontend_close_workspace':
				return null;
			default:
				throw new Error(`unexpected command ${name}`);
		}
	});
	const files = createTauriFilesAdapter(undefined, wire);
	assert.equal((await files.listRecent()).length, 1);
	assert.deepEqual(await files.openWorkspace('folder'), workspace);
	assert.deepEqual(await files.openRecent(recentId), workspace);
	await files.removeRecent(recentId);
	assert.deepEqual(await files.listFiles('ws-1'), [{ path: 'main.tex', kind: 'file' }]);
	assert.deepEqual((await files.readFile({ workspaceId: 'ws-1', path: 'main.tex' })).bytes, new Uint8Array([0, 255]));
	const write = {
		workspaceId: 'ws-1',
		path: 'main.tex',
		bytes: new Uint8Array([104, 105]),
		expectedRevision: null,
		documentId: 'doc_1',
		documentVersion: 0
	};
	assert.equal((await files.writeFile(write)).revision, 'rev-2');
	assert.deepEqual(wire.calls.find((call) => call.name === 'frontend_write_file').args.request.bytes, [104, 105]);
	assert.equal(
		await files.saveAs({ workspaceId: null, bytes: new Uint8Array([1]), documentId: 'doc_1', documentVersion: 0 }),
		null
	);
	await files.closeWorkspace('ws-1');
});

test('accepts a maximum-size dense JSON byte payload', async () => {
	const maximum = 5 * 1024 * 1024;
	const receipt = await readerFor(new Array(maximum).fill(0xa5)).readFile({
		workspaceId: 'ws-1',
		path: 'main.tex'
	});
	assert.equal(receipt.bytes.length, maximum);
	assert.equal(receipt.bytes[0], 0xa5);
	assert.equal(receipt.bytes[maximum - 1], 0xa5);
});

test('rejects malformed JSON byte arrays without invoking accessors or allocating over the limit', async () => {
	const read = (bytes) => readerFor(bytes).readFile({ workspaceId: 'ws-1', path: 'main.tex' });

	let getterCalls = 0;
	const indexAccessor = [1];
	Object.defineProperty(indexAccessor, '0', {
		configurable: true,
		enumerable: true,
		get() {
			getterCalls++;
			return 1;
		}
	});
	await assert.rejects(read(indexAccessor));
	assert.equal(getterCalls, 0);

	const hiddenAccessor = [1];
	Object.defineProperty(hiddenAccessor, 'extra', {
		get() {
			getterCalls++;
			return true;
		}
	});
	await assert.rejects(read(hiddenAccessor));
	assert.equal(getterCalls, 0);

	const hiddenExtra = [1];
	Object.defineProperty(hiddenExtra, 'extra', { value: true });
	await assert.rejects(read(hiddenExtra));
	const symbolExtra = [1];
	Object.defineProperty(symbolExtra, Symbol('extra'), { value: true });
	await assert.rejects(read(symbolExtra));
	await assert.rejects(read(new Array(1)));
	await assert.rejects(read([256]));

	const maximum = 5 * 1024 * 1024;
	const oversizedReader = readerFor(new Array(maximum + 1));
	const NativeUint8Array = globalThis.Uint8Array;
	let allocations = 0;
	globalThis.Uint8Array = new Proxy(NativeUint8Array, {
		construct(target, args, newTarget) {
			allocations++;
			return Reflect.construct(target, args, newTarget);
		}
	});
	try {
		await assert.rejects(
			oversizedReader.readFile({ workspaceId: 'ws-1', path: 'main.tex' }),
			/bytes: invalid byte array/
		);
	} finally {
		globalThis.Uint8Array = NativeUint8Array;
	}
	assert.equal(allocations, 0);
});

test('takes PDF bytes only through the raw one-shot routes', async () => {
	const identity = {
		runId: 'run-1',
		workspaceId: 'ws-1',
		entryPath: 'main.tex',
		documentId: 'doc_1',
		documentVersion: 0,
		savedRevision: 'rev-1'
	};
	const pdf = new Uint8Array([37, 80, 68, 70, 45, 49]);
	const wire = transport((name) => {
		switch (name) {
			case 'frontend_read_file':
				return { workspaceId: 'ws-1', path: 'paper.pdf', revision: 'rev-1', documentId: null, documentVersion: null, binaryToken: 'read-token' };
			case 'frontend_take_file_pdf':
			case 'frontend_take_compile_pdf':
				return pdf;
			case 'frontend_start_compile':
				return identity;
			case 'frontend_compile_result':
				return {
					status: 'success',
					identity,
					log: '',
					diagnostics: [],
					pdfToken: 'compile-token'
				};
			default:
				throw new Error(`unexpected command ${name}`);
		}
	});
	const files = createTauriFilesAdapter(undefined, wire);
	assert.deepEqual(
		(await files.readFile({ workspaceId: 'ws-1', path: 'paper.pdf' })).bytes,
		pdf
	);
	const handle = await files.compile({
		workspaceId: 'ws-1',
		entryPath: 'main.tex',
		documentId: 'doc_1',
		documentVersion: 0,
		savedRevision: 'rev-1',
		engine: 'managed'
	});
	assert.deepEqual((await handle.finished).status, 'success');
	assert.deepEqual(
		wire.calls.filter((call) => call.name === 'frontend_take_file_pdf' || call.name === 'frontend_take_compile_pdf')
			.map((call) => call.args.token),
		['read-token', 'compile-token']
	);
});

test('watch generation and abort discard late events and serialize stop after start', async () => {
	const controller = new AbortController();
	const wire = transport(() => null);
	const files = createTauriFilesAdapter(controller.signal, wire);
	const received = [];
	await files.watchFiles('ws-1', (event) => received.push(event));
	const start = wire.calls.find((call) => call.name === 'frontend_watch_start').args;
	const lateListener = wire.registrations.find((entry) => entry.name === 'frontend://files/event').listener;
	const event = {
		subscriptionId: start.subscriptionId,
		generation: start.generation,
		event: { workspaceId: 'ws-1', path: 'main.tex', kind: 'changed' }
	};
	wire.emit('frontend://files/event', event);
	assert.equal(received.length, 1);
	controller.abort();
	await files.closeWorkspace('ws-1');
	lateListener(event);
	assert.equal(received.length, 1);
	assert.equal(wire.calls.filter((call) => call.name === 'frontend_watch_stop').length, 1);
	assert.equal(wire.calls.at(-1).name, 'frontend_close_workspace');
});

test('periodic resync stays separate from failures and rejects stale or disposed subscriptions', async () => {
	const controller = new AbortController();
	const wire = transport(() => null);
	const files = createTauriFilesAdapter(controller.signal, wire);
	const resyncs = [], failures = [], events = [];
	const stop = await files.watchFiles('ws-1', event => events.push(event), failure => failures.push(failure), reason => resyncs.push(reason));
	const start = wire.calls.find(call => call.name === 'frontend_watch_start').args;
	const message = { subscriptionId: start.subscriptionId, generation: start.generation, reason: 'PERIODIC_RECONCILE_DUE' };
	wire.emit('frontend://files/resync', message);
	assert.deepEqual(resyncs, ['PERIODIC_RECONCILE_DUE']);
	assert.deepEqual(failures, []);
	assert.deepEqual(events, []);
	for (const invalid of [
		{ ...message, subscriptionId: 'foreign' },
		{ ...message, generation: start.generation + 1 },
		{ ...message, reason: 'UNKNOWN' },
		{ ...message, extra: true }
	]) wire.emit('frontend://files/resync', invalid);
	assert.equal(resyncs.length, 1);
	const late = wire.registrations.find(item => item.name === 'frontend://files/resync').listener;
	stop();
	late(message);
	assert.equal(resyncs.length, 1);
	controller.abort();
	await files.closeWorkspace('ws-1');
	late(message);
	assert.equal(resyncs.length, 1);
});

test('compile cancellation is idempotent and preserves the cancelled result identity', async () => {
	let finishResult;
	const pendingResult = new Promise((resolve) => {
		finishResult = resolve;
	});
	const identity = {
		runId: 'run-1',
		workspaceId: 'ws-1',
		entryPath: 'main.tex',
		documentId: 'doc_1',
		documentVersion: 0,
		savedRevision: 'rev-1'
	};
	const wire = transport((name) => {
		if (name === 'frontend_start_compile') return identity;
		if (name === 'frontend_compile_result') return pendingResult;
		if (name === 'frontend_cancel_compile') return null;
		throw new Error(`unexpected command ${name}`);
	});
	const files = createTauriFilesAdapter(undefined, wire);
	const handle = await files.compile({
		workspaceId: 'ws-1',
		entryPath: 'main.tex',
		documentId: 'doc_1',
		documentVersion: 0,
		savedRevision: 'rev-1',
		engine: 'managed'
	});
	await Promise.all([handle.cancel(), handle.cancel()]);
	assert.equal(wire.calls.filter((call) => call.name === 'frontend_cancel_compile').length, 1);
	finishResult({ status: 'cancelled', identity, log: '', diagnostics: [] });
	assert.equal((await handle.finished).status, 'cancelled');
});
