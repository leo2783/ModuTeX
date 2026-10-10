import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import type { FileEvent, FileWatchFailure } from '@modutex/frontend-contracts';
import { desktopFiles } from '../../src/features/files/desktop.ts';

const workspaceId = '123e4567-e89b-42d3-a456-426614174000';

async function writeFixtureFiles(directory: string, prefix: string, count: number): Promise<void> {
	for (let start = 0; start < count; start += 32) {
		await Promise.all(Array.from({ length: Math.min(32, count - start) }, (_, offset) =>
			writeFile(join(directory, `${prefix}-${start + offset}.tex`), 'x')));
	}
}

function deferred<T = void>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

async function withTimeout<T>(promise: Promise<T>, milliseconds = 8000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error('Timed out waiting for watch harness')), milliseconds);
			})
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function waitFor<T>(read: () => T | undefined, milliseconds = 8000): Promise<T> {
	const deadline = Date.now() + milliseconds;
	while (Date.now() < deadline) {
		const value = read();
		if (value !== undefined) return value;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error('Timed out waiting for public DesktopPort watch result');
}

test('public DesktopPort watch lifetime uses the real host filesystem', { timeout: 45000 }, async (t) => {
	const server = await createServer({
		root: fileURLToPath(new URL('../..', import.meta.url)),
		server: { middlewareMode: true, hmr: false, ws: false },
		logLevel: 'error'
	});
	const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
	const directory = await mkdtemp(join(tmpdir(), 'modutex-desktop-watch-'));
	const root = join(directory, 'workspace');
	await mkdir(root);
	const { FrontendFiles } = await server.ssrLoadModule(
		fileURLToPath(new URL('../../../../electron/src/frontend-files.ts', import.meta.url))
	);
	const { FrontendWatch } = await server.ssrLoadModule(
		fileURLToPath(new URL('../../../../electron/src/frontend-watch.ts', import.meta.url))
	);
	const files = new FrontendFiles();
	const activeWatches = new Map<string, InstanceType<typeof FrontendWatch>>();
	const eventListeners = new Set<(value: unknown) => void>();
	const errorListeners = new Set<(value: unknown) => void>();
	const events: FileEvent[] = [];
	const failures: FileWatchFailure[] = [];
	const stoppedIds: string[] = [];
	let startCount = 0;
	let emittedCount = 0;
	let distortEventId = false;
	let distortWorkspaceId = false;
	let distortFailure = false;
	let startBarrier: { entered: () => void; reply: Promise<void> } | null = null;

	const pushFailure = (subscriptionId: string, failure: unknown) => {
		for (const listener of errorListeners) listener({ subscriptionId, error: failure });
	};
	const stopAllNativeWatches = (failure?: FileWatchFailure) => {
		for (const [subscriptionId, watcher] of [...activeWatches]) {
			activeWatches.delete(subscriptionId);
			watcher.stop();
			if (failure) pushFailure(subscriptionId, failure);
		}
	};
	const native = {
		openWorkspace: async () => {
			stopAllNativeWatches('STALE_WORKSPACE');
			return files.open(root, 'folder');
		},
		listRecent: async () => [],
		openRecent: async () => files.open(root, 'folder'),
		removeRecent: async () => {},
		listFiles: async (id: string) => files.list(id),
		readFile: async (ref: unknown) => files.read(ref),
		writeFile: async (request: unknown) => files.write(request),
		saveAs: async () => null,
		startCompile: async () => null,
		compileResult: async () => null,
		cancelCompile: async () => {},
		closeWorkspace: async (id: string) => {
			stopAllNativeWatches();
			files.close(id);
		},
		startWatch: async (id: string, subscriptionId: string) => {
			startCount++;
			const owner = files.compileOwner();
			const assertWorkspace = files.saveAsOwner(id);
			let watcher!: InstanceType<typeof FrontendWatch>;
			watcher = new FrontendWatch({
				root: owner.root,
				workspaceId: id,
				assertCurrent() {
					assertWorkspace();
					owner.assertCurrent();
					if (activeWatches.get(subscriptionId) !== watcher) throw new Error('STALE_WORKSPACE');
				},
				emit(event: FileEvent) {
					if (activeWatches.get(subscriptionId) !== watcher) return;
					emittedCount++;
					const payload = distortWorkspaceId ? { ...event, workspaceId: 'another-workspace' } : event;
					const envelopeId = distortEventId ? `${subscriptionId}-wrong` : subscriptionId;
					for (const listener of eventListeners) listener({ subscriptionId: envelopeId, event: payload });
				},
				onError(failure: FileWatchFailure) {
					if (activeWatches.get(subscriptionId) !== watcher) return;
					activeWatches.delete(subscriptionId);
					pushFailure(subscriptionId, distortFailure ? 'NOT_A_FILE_WATCH_FAILURE' : failure);
				}
			});
			activeWatches.set(subscriptionId, watcher);
			try {
				await watcher.start();
				if (startBarrier) {
					const barrier = startBarrier;
					barrier.entered();
					await barrier.reply;
				}
			} catch (error) {
				if (activeWatches.get(subscriptionId) === watcher) activeWatches.delete(subscriptionId);
				watcher.stop();
				throw error;
			}
		},
		stopWatch: async (subscriptionId: string) => {
			stoppedIds.push(subscriptionId);
			const watcher = activeWatches.get(subscriptionId);
			if (watcher) {
				activeWatches.delete(subscriptionId);
				watcher.stop();
			}
		},
		onWatchEvent: (listener: (value: unknown) => void) => {
			eventListeners.add(listener);
			return () => eventListeners.delete(listener);
		},
		onWatchError: (listener: (value: unknown) => void) => {
			errorListeners.add(listener);
			return () => errorListeners.delete(listener);
		}
	};

	try {
		Object.defineProperty(globalThis, 'window', {
			configurable: true,
			writable: true,
			value: { modutexFiles: native }
		});
		let owner = await files.open(root, 'folder');

		await t.test('abort before start does not register or start a native watch', async () => {
			const beforeStarts = startCount;
			const beforeEventListeners = eventListeners.size;
			const beforeErrorListeners = errorListeners.size;
			const controller = new AbortController();
			controller.abort();
			const port = desktopFiles(controller.signal)!;
			await assert.rejects(port.watchFiles(owner.id, () => {}), /STALE_WORKSPACE/);
			assert.equal(startCount, beforeStarts);
			assert.equal(eventListeners.size, beforeEventListeners);
			assert.equal(errorListeners.size, beforeErrorListeners);
		});

		await t.test('late start reply after abort stops the exact subscription', async () => {
			const entered = deferred();
			const reply = deferred();
			startBarrier = { entered: () => entered.resolve(), reply: reply.promise };
			const controller = new AbortController();
			const port = desktopFiles(controller.signal)!;
			const pending = port.watchFiles(owner.id, (event) => events.push(event));
			const observed = pending.then(
				() => ({ ok: true as const }),
				(error: unknown) => ({ ok: false as const, error })
			);
			try {
				await withTimeout(entered.promise);
				assert.equal(activeWatches.size, 1);
				controller.abort();
				await waitFor(() => activeWatches.size === 0 ? true : undefined);
				await writeFile(join(root, 'after-abort.tex'), 'late filesystem change');
				reply.resolve();
				const result = await withTimeout(observed);
				assert.equal(result.ok, false);
				if (!result.ok) assert.match(String(result.error), /STALE_WORKSPACE/);
				await new Promise((resolve) => setTimeout(resolve, 120));
				assert.equal(events.some((event) => event.path === 'after-abort.tex'), false);
				assert.equal(activeWatches.size, 0);
				assert.equal(eventListeners.size, 0);
				assert.equal(errorListeners.size, 0);
			} finally {
				controller.abort();
				reply.resolve();
				await withTimeout(observed);
				startBarrier = null;
			}
		});

		await t.test('validates real event envelopes and unsubscribe prevents later delivery', async () => {
			const port = desktopFiles()!;
			const forwarded: FileEvent[] = [];
			const unsubscribe = await port.watchFiles(owner.id, (event) => forwarded.push(event));
			try {
				const baseline = emittedCount;
				distortEventId = true;
				await writeFile(join(root, 'wrong-id.tex'), 'real filesystem event');
				await waitFor(() => emittedCount > baseline ? true : undefined);
				assert.equal(forwarded.length, 0);

				const secondBaseline = emittedCount;
				distortEventId = false;
				distortWorkspaceId = true;
				await writeFile(join(root, 'wrong-owner.tex'), 'another real filesystem event');
				await waitFor(() => emittedCount > secondBaseline ? true : undefined);
				assert.equal(forwarded.length, 0);

				distortWorkspaceId = false;
				await writeFile(join(root, 'valid.tex'), 'valid bytes');
				await waitFor(() => forwarded.find((event) => event.path === 'valid.tex'));
				assert.equal(forwarded.find((event) => event.path === 'valid.tex')?.workspaceId, owner.id);
				const countAtUnsubscribe = forwarded.length;
				unsubscribe();
				await waitFor(() => activeWatches.size === 0 ? true : undefined);
				await writeFile(join(root, 'after-unsubscribe.tex'), 'must not be forwarded');
				await new Promise((resolve) => setTimeout(resolve, 150));
				assert.equal(forwarded.length, countAtUnsubscribe);
				assert.equal(activeWatches.size, 0);
			} finally {
				distortEventId = false;
				distortWorkspaceId = false;
				unsubscribe();
			}
		});

		await t.test('close and reopen stop old host watches and report stale ownership once', async () => {
			const port = desktopFiles()!;
			const staleFailures: FileWatchFailure[] = [];
			const unsubscribe = await port.watchFiles(owner.id, () => {}, (failure) => staleFailures.push(failure));
			const reopened = await port.openWorkspace('folder');
			assert.ok(reopened);
			await waitFor(() => staleFailures.includes('STALE_WORKSPACE') ? true : undefined);
			assert.equal(activeWatches.size, 0);
			assert.equal(staleFailures.filter((failure) => failure === 'STALE_WORKSPACE').length, 1);

			const nextFailures: FileWatchFailure[] = [];
			const nextUnsubscribe = await port.watchFiles(reopened!.id, () => {}, (failure) => nextFailures.push(failure));
			await port.closeWorkspace(reopened!.id);
			assert.equal(activeWatches.size, 0);
			await writeFile(join(root, 'after-close.tex'), 'must not be delivered');
			await new Promise((resolve) => setTimeout(resolve, 150));
			assert.deepEqual(nextFailures, []);
			unsubscribe();
			nextUnsubscribe();
			// The following subtest must get current authority, not this closed ID.
			owner = await files.open(root, 'folder');
		});

		await t.test('forwards one typed runtime overflow error and refuses forged error codes', async () => {
			const port = desktopFiles()!;
			const reported: FileWatchFailure[] = [];
			const pendingFiles = join(directory, 'staged-many');
			await mkdir(pendingFiles);
			await writeFixtureFiles(pendingFiles, 'entry', 2049);
			const unsubscribe = await port.watchFiles(owner.id, (event) => events.push(event),
				(failure) => reported.push(failure));
			try {
				await rm(join(root, 'many'), { recursive: true, force: true });
				await import('node:fs/promises').then(({ rename }) => rename(pendingFiles, join(root, 'many')));
				await waitFor(() => reported.includes('TREE_TOO_LARGE') ? true : undefined);
				assert.equal(reported.filter((failure) => failure === 'TREE_TOO_LARGE').length, 1);
				assert.equal(activeWatches.size, 0);
				const delivered = events.length;
				await writeFile(join(root, 'many', 'after-error.tex'), 'must not be delivered');
				await new Promise((resolve) => setTimeout(resolve, 150));
				assert.equal(events.length, delivered);
			} finally {
				unsubscribe();
				distortFailure = false;
				if (activeWatches.size) stopAllNativeWatches();
			}

			await rm(join(root, 'many'), { recursive: true, force: true });
			const forgedReported: FileWatchFailure[] = [];
			distortFailure = true;
			const forgedUnsubscribe = await port.watchFiles(owner.id, () => {}, (failure) => forgedReported.push(failure));
			try {
				await mkdir(pendingFiles);
				await writeFixtureFiles(pendingFiles, 'forged', 2049);
				await import('node:fs/promises').then(({ rename }) => rename(pendingFiles, join(root, 'many')));
				await waitFor(() => activeWatches.size === 0 ? true : undefined);
				assert.deepEqual(forgedReported, []);
			} finally {
				forgedUnsubscribe();
				distortFailure = false;
				await rm(join(root, 'many'), { recursive: true, force: true });
			}
		});
	} finally {
		startBarrier = null;
		stopAllNativeWatches();
		files.close();
		await server.close();
		if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
		else Reflect.deleteProperty(globalThis, 'window');
		if (dirname(directory) !== tmpdir() || !basename(directory).startsWith('modutex-desktop-watch-')) {
			throw new Error('Unsafe cleanup');
		}
		await rm(directory, { recursive: true, force: true });
	}
});
