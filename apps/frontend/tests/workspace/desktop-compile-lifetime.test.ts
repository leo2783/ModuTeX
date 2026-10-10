import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import type { CompileHandle, CompileIdentity, CompileRequest, CompileResult, FileRef, ReadReceipt, WorkspaceInfo, WriteReceipt, WriteRequest } from '@modutex/frontend-contracts';
import { desktopFiles } from '../../src/features/files/desktop.ts';

const repository = fileURLToPath(new URL('../../../../', import.meta.url));
const artifacts = join(repository, '.verification-artifacts', 'frontend-runtime-2026-10-07');
const owner = 1;

interface HostFiles {
	open(path: string, kind: 'file' | 'folder'): Promise<WorkspaceInfo>;
	read(file: FileRef): Promise<ReadReceipt>;
	write(request: WriteRequest): Promise<WriteReceipt>;
	close(id?: string): void;
	compileOwner(): unknown;
}
interface ManagedEngine { close(): void; }
interface HostCompiler {
	start(event: unknown, owner: number, payload: unknown): Promise<CompileIdentity>;
	result(owner: number, id: unknown): Promise<CompileResult>;
	cancel(owner: number, id: unknown): Promise<void>;
	cancelOwner(owner: number): void;
}
interface HostModules {
	FrontendFiles: new () => HostFiles;
	FrontendCompiler: new (engine: ManagedEngine, files: (owner: number) => HostFiles) => HostCompiler;
	createManagedCompileService(options: {
		runtime: { isPackaged: false; appPath: string; resourcesPath: string; userData: string };
		authorize: () => unknown;
	}): ManagedEngine;
	checkedCompilePath(path: string, create: boolean): Promise<void>;
	MANAGED_FORMAT_SETUP_TIMEOUT_MS: number;
}
interface CompileBridge {
	startCompile(request: CompileRequest): Promise<CompileIdentity>;
	compileResult(id: string): Promise<CompileResult>;
	cancelCompile(id: string): Promise<void>;
	closeWorkspace(id: string): Promise<void>;
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

function observeAbortLifetime(signal: AbortSignal): { additions(): number; removals(): number } {
	let additions = 0;
	let removals = 0;
	const originalAdd = signal.addEventListener.bind(signal);
	const original = signal.removeEventListener.bind(signal);
	Object.defineProperty(signal, 'addEventListener', {
		configurable: true,
		value: (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) => {
			if (type === 'abort') additions++;
			if (listener !== null) originalAdd(type, listener, options);
		}
	});
	Object.defineProperty(signal, 'removeEventListener', {
		configurable: true,
		value: (type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) => {
			if (type === 'abort') removals++;
			if (listener !== null) original(type, listener, options);
		}
	});
	return { additions: () => additions, removals: () => removals };
}

function rendererPort(signal: AbortSignal, native: CompileBridge) {
	Object.defineProperty(globalThis, 'window', { configurable: true, value: { modutexFiles: native } });
	const port = desktopFiles(signal);
	if (!port) throw new Error('Expected the renderer desktop port');
	return port;
}

async function savedRequest(
	files: HostFiles,
	path: string,
	source = '\\documentclass{article}\n\\begin{document}Compile lifetime.\\end{document}\n'
): Promise<CompileRequest> {
	await writeFile(path, source);
	const workspace = await files.open(path, 'file');
	const entryPath = workspace.entryPath;
	assert.ok(entryPath);
	const read = await files.read({ workspaceId: workspace.id, path: entryPath });
	return {
		workspaceId: workspace.id,
		entryPath,
		documentId: 'compile-lifetime-document',
		documentVersion: 0,
		savedRevision: read.revision,
		engine: 'managed'
	};
}

async function nextTurn(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(() => resolve()));
}

test('renderer compile lifetime revokes late results from the real host', { timeout: 660_000 }, async (t) => {
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	let server: Awaited<ReturnType<typeof createServer>> | undefined;
	let files: HostFiles | undefined;
	let engine: ManagedEngine | undefined;
	let compiler: HostCompiler | undefined;
	let directory: string | undefined;
	let ownerCancelled = false;

	try {
		const vite = await createServer({
			root: fileURLToPath(new URL('../..', import.meta.url)),
			server: { middlewareMode: true, hmr: false, ws: false },
			logLevel: 'error'
		});
		server = vite;
		const fileModule = await vite.ssrLoadModule(fileURLToPath(new URL('../../../../electron/src/frontend-files.ts', import.meta.url))) as unknown as Pick<HostModules, 'FrontendFiles'>;
		const compilerModule = await vite.ssrLoadModule(fileURLToPath(new URL('../../../../electron/src/frontend-compile.ts', import.meta.url))) as unknown as Pick<HostModules, 'FrontendCompiler'>;
		const managedModule = await vite.ssrLoadModule(fileURLToPath(new URL('../../../../electron/src/managed-compile.ts', import.meta.url))) as unknown as Pick<HostModules, 'createManagedCompileService' | 'checkedCompilePath' | 'MANAGED_FORMAT_SETUP_TIMEOUT_MS'>;

		await managedModule.checkedCompilePath(repository, true);
		for (const path of [dirname(artifacts), artifacts]) {
			try { await mkdir(path); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
			await managedModule.checkedCompilePath(path, true);
		}

		directory = await mkdtemp(join(tmpdir(), 'modutex-compile-lifetime-'));
		const hostFiles = new fileModule.FrontendFiles();
		files = hostFiles;
		const hostEngine = managedModule.createManagedCompileService({
			runtime: { isPackaged: false, appPath: repository, resourcesPath: repository, userData: artifacts },
			authorize: () => hostFiles.compileOwner()
		});
		engine = hostEngine;
		const hostCompiler = new compilerModule.FrontendCompiler(hostEngine, () => hostFiles);
		compiler = hostCompiler;
		const request = await savedRequest(hostFiles, join(directory, 'main.tex'));
		const compileTimeout = managedModule.MANAGED_FORMAT_SETUP_TIMEOUT_MS + 15_000;
		const loopingSource = '\\documentclass{article}\n\\begin{document}\\loop\\iftrue\\repeat\\end{document}\n';
		let cancellationRequest: CompileRequest | undefined;

		await t.test('an aborted view does not receive a genuine result delayed in delivery', { timeout: compileTimeout }, async () => {
			const controller = new AbortController();
			const lifetime = observeAbortLifetime(controller.signal);
			const resultStarted = deferred<void>();
			const releaseDelivery = deferred<void>();
			const cancelStarted = deferred<void>();
			let hostResult: Promise<CompileResult> | undefined;
			let cancelCalls = 0;
			let nativeCancellation: Promise<void> | undefined;
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => unhandled.push(reason);
			process.on('unhandledRejection', onUnhandled);
			const native: CompileBridge = {
				startCompile: (payload) => hostCompiler.start({}, owner, payload),
				compileResult: (id) => {
					// This is the actual host result; only its delivery to the adapter is held.
					hostResult = hostCompiler.result(owner, id);
					resultStarted.resolve(undefined);
					return hostResult.then(async (result) => {
						await releaseDelivery.promise;
						return result;
					});
				},
				cancelCompile: (id) => {
					cancelCalls++;
					const cancellation = hostCompiler.cancel(owner, id);
					nativeCancellation = cancellation;
					cancelStarted.resolve(undefined);
					return cancellation;
				},
				closeWorkspace: async (id) => { hostFiles.close(id); }
			};
			const port = rendererPort(controller.signal, native);
			let finished: Promise<CompileResult> | undefined;
			try {
				const handle: CompileHandle = await port.compile(request);
				finished = handle.finished;
				await resultStarted.promise;
				const actualResult = hostResult;
				assert.ok(actualResult);
				const genuine = await actualResult;
				if (genuine.status !== 'success') throw new Error(`Expected a genuine PDF, got ${genuine.status}: ${genuine.log}`);
				assert.deepEqual(genuine.identity, handle.identity);
				const pdf = Buffer.from(genuine.pdf);
				assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
				assert.deepEqual(await readFile(join(directory!, 'output', 'main.pdf')), pdf);

				controller.abort();
				await cancelStarted.promise;
				const cancellation = nativeCancellation;
				assert.ok(cancellation);
				await assert.rejects(cancellation, /STALE_WORKSPACE/);
				releaseDelivery.resolve(undefined);
				await assert.rejects(handle.finished, /STALE_WORKSPACE/);
				await nextTurn();
				await handle.cancel();
				assert.equal(cancelCalls, 1);
				assert.equal(lifetime.additions(), 1);
				assert.equal(lifetime.removals(), 1);
				assert.deepEqual(unhandled, []);
			} finally {
				releaseDelivery.resolve(undefined);
				if (!controller.signal.aborted) controller.abort();
				await finished?.catch(() => undefined);
				process.off('unhandledRejection', onUnhandled);
			}
		});

		await t.test('a closed host owner can reject a late start identity without an unhandled result rejection', { timeout: compileTimeout }, async () => {
			const controller = new AbortController();
			const lifetime = observeAbortLifetime(controller.signal);
			const startReturned = deferred<CompileIdentity>();
			const releaseStart = deferred<void>();
			const resultStarted = deferred<void>();
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => unhandled.push(reason);
			let hostResult: Promise<CompileResult> | undefined;
			let cancelCalls = 0;
			process.on('unhandledRejection', onUnhandled);
			const native: CompileBridge = {
				startCompile: async (payload) => {
					const identity = await hostCompiler.start({}, owner, payload);
					startReturned.resolve(identity);
					await releaseStart.promise;
					return identity;
				},
				compileResult: (id) => {
					hostResult = hostCompiler.result(owner, id);
					resultStarted.resolve(undefined);
					return hostResult;
				},
				cancelCompile: (id) => {
					cancelCalls++;
					return hostCompiler.cancel(owner, id);
				},
				closeWorkspace: async (id) => { hostFiles.close(id); }
			};
			const port = rendererPort(controller.signal, native);
			let pending: Promise<CompileHandle> | undefined;
			try {
				pending = port.compile(request);
				const identity = await startReturned.promise;
				assert.equal(identity.workspaceId, request.workspaceId);
				// Model the host owner closing after start, but before its real identity is delivered.
				await hostCompiler.cancel(owner, identity.runId);
				hostCompiler.cancelOwner(owner);
				ownerCancelled = true;
				controller.abort();
				releaseStart.resolve(undefined);
				await resultStarted.promise;
				const compile = pending;
				assert.ok(compile);
				await assert.rejects(compile, /STALE_WORKSPACE/);
				const rejectedHostResult = hostResult;
				assert.ok(rejectedHostResult);
				await assert.rejects(rejectedHostResult, /STALE_WORKSPACE/);
				await nextTurn();
				assert.equal(cancelCalls, 1);
				assert.equal(lifetime.additions(), 0);
				assert.equal(lifetime.removals(), 0);
				assert.deepEqual(unhandled, []);
			} finally {
				releaseStart.resolve(undefined);
				if (!controller.signal.aborted) controller.abort();
				await pending?.catch(() => undefined);
				process.off('unhandledRejection', onUnhandled);
			}
		});

		await t.test('an abort during start allocation cancels the real host run and releases its file reservation', { timeout: compileTimeout }, async () => {
			ownerCancelled = false;
			const request = await savedRequest(hostFiles, join(directory!, 'cancel-start.tex'), loopingSource);
			cancellationRequest = request;
			const controller = new AbortController();
			const lifetime = observeAbortLifetime(controller.signal);
			const startReturned = deferred<CompileIdentity>();
			const releaseStart = deferred<void>();
			const resultStarted = deferred<void>();
			const cancelStarted = deferred<void>();
			const unhandled: unknown[] = [];
			const onUnhandled = (reason: unknown) => unhandled.push(reason);
			let hostResult: Promise<CompileResult> | undefined;
			let cancelCalls = 0;
			process.on('unhandledRejection', onUnhandled);
			const native: CompileBridge = {
				startCompile: async (payload) => {
					const identity = await hostCompiler.start({}, owner, payload);
					startReturned.resolve(identity);
					await releaseStart.promise;
					return identity;
				},
				compileResult: (id) => {
					const result = hostCompiler.result(owner, id);
					hostResult = result;
					resultStarted.resolve(undefined);
					return result;
				},
				cancelCompile: (id) => {
					cancelCalls++;
					const cancellation = hostCompiler.cancel(owner, id);
					cancelStarted.resolve(undefined);
					return cancellation;
				},
				closeWorkspace: async (id) => { hostFiles.close(id); }
			};
			const port = rendererPort(controller.signal, native);
			let pending: Promise<CompileHandle> | undefined;
			try {
				pending = port.compile(request);
				void pending.catch(() => {});
				const identity = await startReturned.promise;
				assert.equal(identity.workspaceId, request.workspaceId);

				// No abort listener exists while the real start identity is withheld.
				controller.abort();
				releaseStart.resolve(undefined);
				await resultStarted.promise;
				await cancelStarted.promise;
				const compile = pending;
				assert.ok(compile);
				await assert.rejects(compile, /STALE_WORKSPACE/);
				const actualResult = hostResult;
				assert.ok(actualResult);
				const cancelled = await actualResult;
				assert.equal(cancelled.status, 'cancelled');
				assert.deepEqual(cancelled.identity, identity);
				await nextTurn();

				assert.equal(cancelCalls, 1);
				assert.equal(lifetime.additions(), 0);
				assert.equal(lifetime.removals(), 0);
				assert.deepEqual(unhandled, []);

				const ref = { workspaceId: request.workspaceId, path: request.entryPath };
				const current = await hostFiles.read(ref);
				const receipt = await hostFiles.write({
					...ref,
					bytes: current.bytes,
					expectedRevision: current.revision,
					documentId: request.documentId,
					documentVersion: request.documentVersion
				});
				assert.equal(receipt.revision, current.revision);
			} finally {
				releaseStart.resolve(undefined);
				if (!controller.signal.aborted) controller.abort();
				await pending?.catch(() => undefined);
				await hostResult?.catch(() => undefined);
				process.off('unhandledRejection', onUnhandled);
			}
		});

		await t.test('concurrent cancel calls share one pending host cancellation', { timeout: compileTimeout }, async () => {
			ownerCancelled = false;
			const request = cancellationRequest;
			assert.ok(request);
			const controller = new AbortController();
			const lifetime = observeAbortLifetime(controller.signal);
			const resultStarted = deferred<void>();
			const cancellationDeliveryReached = deferred<void>();
			const releaseCancellationDelivery = deferred<void>();
			const releaseResultDelivery = deferred<void>();
			let hostResult: Promise<CompileResult> | undefined;
			let cancelCalls = 0;
			const native: CompileBridge = {
				startCompile: (payload) => hostCompiler.start({}, owner, payload),
				compileResult: (id) => {
					const result = hostCompiler.result(owner, id);
					hostResult = result;
					resultStarted.resolve(undefined);
					return result.then(async (value) => {
						await releaseResultDelivery.promise;
						return value;
					});
				},
				cancelCompile: (id) => {
					cancelCalls++;
					return hostCompiler.cancel(owner, id).then(async () => {
						cancellationDeliveryReached.resolve(undefined);
						await releaseCancellationDelivery.promise;
					});
				},
				closeWorkspace: async (id) => { hostFiles.close(id); }
			};
			const port = rendererPort(controller.signal, native);
			let handle: CompileHandle | undefined;
			let finished: Promise<CompileResult> | undefined;
			try {
				handle = await port.compile(request);
				finished = handle.finished;
				await resultStarted.promise;
				const firstCancel = handle.cancel();
				await cancellationDeliveryReached.promise;
				const actualResult = hostResult;
				assert.ok(actualResult);
				const cancelled = await actualResult;
				assert.equal(cancelled.status, 'cancelled');
				assert.deepEqual(cancelled.identity, handle.identity);

				// Both delivery barriers hold the adapter's first cancellation pending.
				const secondCancel = handle.cancel();
				await nextTurn();
				assert.equal(cancelCalls, 1);

				releaseCancellationDelivery.resolve(undefined);
				await Promise.all([firstCancel, secondCancel]);
				releaseResultDelivery.resolve(undefined);
				const delivered = await finished;
				assert.equal(delivered.status, 'cancelled');
				assert.deepEqual(delivered.identity, handle.identity);

				await handle.cancel();
				assert.equal(cancelCalls, 1);
				assert.equal(lifetime.additions(), 1);
				assert.equal(lifetime.removals(), 1);

				const ref = { workspaceId: request.workspaceId, path: request.entryPath };
				const current = await hostFiles.read(ref);
				const receipt = await hostFiles.write({
					...ref,
					bytes: current.bytes,
					expectedRevision: current.revision,
					documentId: request.documentId,
					documentVersion: request.documentVersion
				});
				assert.equal(receipt.revision, current.revision);
			} finally {
				releaseCancellationDelivery.resolve(undefined);
				releaseResultDelivery.resolve(undefined);
				if (!controller.signal.aborted) controller.abort();
				await handle?.cancel().catch(() => undefined);
				await finished?.catch(() => undefined);
			}
		});

		await t.test('a rejected cancellation can be retried, while settled results ignore late cancellation', { timeout: compileTimeout }, async () => {
			ownerCancelled = false;
			const request = await savedRequest(hostFiles, join(directory!, 'delayed-result.tex'));
			const controller = new AbortController();
			const lifetime = observeAbortLifetime(controller.signal);
			const resultStarted = deferred<void>();
			const releaseDelivery = deferred<void>();
			let hostResult: Promise<CompileResult> | undefined;
			let cancelCalls = 0;
			const native: CompileBridge = {
				startCompile: (payload) => hostCompiler.start({}, owner, payload),
				compileResult: (id) => {
					const result = hostCompiler.result(owner, id);
					hostResult = result;
					resultStarted.resolve(undefined);
					return result.then(async (value) => {
						await releaseDelivery.promise;
						return value;
					});
				},
				cancelCompile: (id) => {
					cancelCalls++;
					return hostCompiler.cancel(owner, id);
				},
				closeWorkspace: async (id) => { hostFiles.close(id); }
			};
			const port = rendererPort(controller.signal, native);
			let handle: CompileHandle | undefined;
			let finished: Promise<CompileResult> | undefined;
			try {
				handle = await port.compile(request);
				finished = handle.finished;
				await resultStarted.promise;
				const actualResult = hostResult;
				assert.ok(actualResult);
				const genuine = await actualResult;
				if (genuine.status !== 'success') throw new Error(`Expected a genuine PDF, got ${genuine.status}: ${genuine.log}`);
				assert.deepEqual(genuine.identity, handle.identity);
				const pdf = Buffer.from(genuine.pdf);
				assert.equal(pdf.subarray(0, 5).toString('ascii'), '%PDF-');
				assert.deepEqual(await readFile(join(directory!, 'output', 'delayed-result.pdf')), pdf);

				// The host consumed the genuine result, while renderer delivery remains held.
				await assert.rejects(handle.cancel(), /STALE_WORKSPACE/);
				assert.equal(cancelCalls, 1);
				await assert.rejects(handle.cancel(), /STALE_WORKSPACE/);
				assert.equal(cancelCalls, 2);

				releaseDelivery.resolve(undefined);
				const delivered = await finished;
				if (delivered.status !== 'success') throw new Error(`Expected delivered success, got ${delivered.status}`);
				assert.deepEqual(delivered.identity, handle.identity);
				assert.deepEqual(Buffer.from(delivered.pdf), pdf);

				await handle.cancel();
				assert.equal(cancelCalls, 2);
				assert.equal(lifetime.additions(), 1);
				assert.equal(lifetime.removals(), 1);
			} finally {
				releaseDelivery.resolve(undefined);
				if (!controller.signal.aborted) controller.abort();
				await handle?.cancel().catch(() => undefined);
				await finished?.catch(() => undefined);
			}
		});
	} finally {
		if (compiler && !ownerCancelled) compiler.cancelOwner(owner);
		engine?.close();
		files?.close();
		if (server) await server.close();
		if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
		else Reflect.deleteProperty(globalThis, 'window');
		if (directory) {
			if (dirname(directory) !== tmpdir() || !basename(directory).startsWith('modutex-compile-lifetime-')) throw new Error('Unsafe cleanup');
			await rm(directory, { recursive: true, force: true });
		}
	}
});
