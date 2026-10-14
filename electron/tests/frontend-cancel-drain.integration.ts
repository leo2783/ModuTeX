import { afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { FrontendFiles } from '../src/frontend-files';
import { FrontendCompiler } from '../src/frontend-compile';
import { createManagedCompileService, checkedCompilePath, MANAGED_FORMAT_SETUP_TIMEOUT_MS } from '../src/managed-compile';

type ManagedEngine = ReturnType<typeof createManagedCompileService>;
type ManagedOutcome = Awaited<ReturnType<ManagedEngine['run']>>;
type FrontendResult = Awaited<ReturnType<FrontendCompiler['result']>>;

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>((complete) => { resolve = complete; });
	return { promise, resolve };
}

function within<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
	});
	return Promise.race([promise, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

const repository = fileURLToPath(new URL('../../', import.meta.url));
const data = path.join(repository, '.verification-artifacts', 'frontend-runtime-2026-10-07');
await checkedCompilePath(repository, true);
for (const directory of [path.dirname(data), data]) {
	try { await fs.mkdir(directory); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
	await checkedCompilePath(directory, true);
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modutex-frontend-cancel-drain-'));

afterAll(async () => {
	if (path.dirname(root) !== os.tmpdir() || !path.basename(root).startsWith('modutex-frontend-cancel-drain-')) {
		throw new Error('Unsafe cleanup');
	}
	await fs.rm(root, { recursive: true, force: true });
});

describe('frontend compile cancellation draining', () => {
	it('waits for real engine cleanup and reservation release before restart; owner close remains safe', async () => {
		const files = new FrontendFiles();
		const managed = createManagedCompileService({
			runtime: { isPackaged: false, appPath: repository, resourcesPath: repository, userData: data },
			authorize: () => files.compileOwner()
		});
		const runEntered = Array.from({ length: 3 }, () => deferred<void>());
		const runSettled = Array.from({ length: 3 }, () => deferred<ManagedOutcome>());
		const returnGates = Array.from({ length: 3 }, () => deferred<void>());
		const cancellationForwarded = deferred<void>();
		let runCount = 0;
		let cancelCount = 0;

		// This forwards every call and every outcome to the genuine ManagedCompile
		// service. The gates delay only handoff to FrontendCompiler after the real
		// service has completed its own child-process and staging cleanup.
		const forwardingEngine: ManagedEngine = {
			...managed,
			run: async (...args: Parameters<ManagedEngine['run']>) => {
				const index = runCount++;
				const actual = managed.run(...args);
				if (index < runEntered.length) runEntered[index]!.resolve(undefined);
				const outcome = await actual;
				if (index < runSettled.length) runSettled[index]!.resolve(outcome);
				if (index === 0 || index === 2) await returnGates[index]!.promise;
				return outcome;
			},
			cancelOwner: (owner) => {
				managed.cancelOwner(owner);
				if (cancelCount++ === 0) cancellationForwarded.resolve(undefined);
			}
		};
		const compiler = new FrontendCompiler(forwardingEngine, () => files);
		let currentRunId: string | undefined;
		let pendingCancel: Promise<void> | undefined;
		const observedResults: Promise<FrontendResult>[] = [];
		let closeResult: Promise<FrontendResult> | undefined;

		const assertWriteBusy = async (entryPath: string): Promise<void> => {
			const peer = new FrontendFiles();
			try {
				const workspace = await peer.open(root, 'folder');
				const read = await peer.read({ workspaceId: workspace.id, path: entryPath });
				await expect(peer.write({
					workspaceId: workspace.id, path: entryPath, bytes: read.bytes, expectedRevision: read.revision,
					documentId: 'cancel-drain-peer', documentVersion: 1
				})).rejects.toThrow('BUSY');
			} finally {
				peer.close();
			}
		};

		try {
			const endless = '\\documentclass{article}\n\\begin{document}\\loop\\iftrue\\repeat\\end{document}\n';
			await fs.writeFile(path.join(root, 'main.tex'), endless);
			await fs.writeFile(path.join(root, 'restart.tex'),
				'\\documentclass{article}\n\\begin{document}Restarted.\\end{document}\n');
			await fs.writeFile(path.join(root, 'owner-close.tex'), endless);
			const workspace = await files.open(root, 'folder');
			const compileRequest = async (entryPath: string, documentId: string) => {
				const read = await files.read({ workspaceId: workspace.id, path: entryPath });
				return {
					workspaceId: workspace.id, entryPath, documentId, documentVersion: 0,
					savedRevision: read.revision, engine: 'managed' as const
				};
			};

			const first = await within(compiler.start({}, 1, await compileRequest('main.tex', 'cancel-drain-first')),
				15_000, 'first start');
			currentRunId = first.runId;
			await within(runEntered[0]!.promise, 15_000, 'first managed run entry');
			await expect(compiler.result(2, first.runId)).rejects.toThrow('STALE_WORKSPACE');
			await expect(compiler.cancel(1, 'wrong-run-id')).rejects.toThrow('STALE_WORKSPACE');

			let realRunFinished = false;
			void runSettled[0]!.promise.then(() => { realRunFinished = true; });
			await Promise.resolve();
			expect(realRunFinished).toBe(false);

			pendingCancel = compiler.cancel(1, first.runId);
			let cancellationFinished = false;
			void pendingCancel.then(
				() => { cancellationFinished = true; },
				() => { cancellationFinished = true; }
			);
			await within(cancellationForwarded.promise, 15_000, 'forwarded cancellation');
			await Promise.resolve();
			expect(cancellationFinished).toBe(false);

			const stopped = await within(runSettled[0]!.promise, 30_000, 'real managed cancellation');
			if (stopped.ok) throw new Error('The nonterminating TeX run unexpectedly succeeded');
			expect(stopped.error).toBe('CANCELLED');
			// The engine has finished and cleaned its staging resources, but the
			// forwarding barrier keeps the frontend handoff and reservation pending.
			expect(cancellationFinished).toBe(false);
			await assertWriteBusy('main.tex');

			returnGates[0]!.resolve(undefined);
			await within(pendingCancel, 15_000, 'cancellation drain');

			// No result consumer is needed to retire a drained cancelled run.
			const restarted = await within(
				compiler.start({}, 1, await compileRequest('restart.tex', 'cancel-drain-restart')),
				15_000, 'immediate restart'
			);
			currentRunId = restarted.runId;
			await expect(compiler.result(1, first.runId)).rejects.toThrow('STALE_WORKSPACE');
			const restartedPromise = compiler.result(1, restarted.runId);
			observedResults.push(restartedPromise);
			const result = await within(restartedPromise, MANAGED_FORMAT_SETUP_TIMEOUT_MS + 15_000, 'real Tectonic PDF');
			currentRunId = undefined;
			expect(result.status, result.log).toBe('success');
			if (result.status !== 'success') throw new Error(result.log);
			expect(Buffer.from(result.pdf).subarray(0, 5).toString()).toBe('%PDF-');
			expect(Buffer.from(result.pdf)).toEqual(await fs.readFile(path.join(root, 'output', 'restart.pdf')));

			const ownerClose = await within(
				compiler.start({}, 1, await compileRequest('owner-close.tex', 'cancel-drain-owner-close')),
				15_000, 'owner-close start'
			);
			currentRunId = ownerClose.runId;
			closeResult = compiler.result(1, ownerClose.runId);
			observedResults.push(closeResult);
			let closeResultFinished = false;
			void closeResult.then(
				() => { closeResultFinished = true; },
				() => { closeResultFinished = true; }
			);
			await within(runEntered[2]!.promise, 15_000, 'owner-close managed run entry');
			compiler.cancelOwner(1);
			const ownerStopped = await within(runSettled[2]!.promise, 30_000, 'owner-close engine cleanup');
			if (ownerStopped.ok) throw new Error('The owner-close TeX run unexpectedly succeeded');
			expect(ownerStopped.error).toBe('CANCELLED');
			expect(closeResultFinished).toBe(false);
			await assertWriteBusy('owner-close.tex');

			files.close();
			returnGates[2]!.resolve(undefined);
			const closedResult = await within(closeResult, 15_000, 'owner-close result drain');
			expect(closedResult.status).toBe('cancelled');
			currentRunId = undefined;
		} finally {
			returnGates[0]!.resolve(undefined);
			returnGates[2]!.resolve(undefined);
			if (pendingCancel) {
				try { await within(pendingCancel, 30_000, 'cancel cleanup'); } catch { /* best-effort cleanup */ }
			}
			if (currentRunId) {
				try {
					await within(compiler.cancel(1, currentRunId), 30_000, 'active-run cleanup');
				} catch { /* it may already have been retired by owner close */ }
			}
			compiler.cancelOwner(1);
			for (const result of observedResults) {
				try { await within(result, 30_000, 'result cleanup'); } catch { /* preserve the test failure */ }
			}
			for (let index = 0; index < runCount && index < runSettled.length; index++) {
				try { await within(runSettled[index]!.promise, 30_000, 'engine cleanup'); } catch { /* preserve the test failure */ }
			}
			managed.close();
			files.close();
		}
	}, MANAGED_FORMAT_SETUP_TIMEOUT_MS + 60_000);
});
