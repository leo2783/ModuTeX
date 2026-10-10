import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import type { CompileResult } from '@modutex/frontend-contracts' with { 'resolution-mode': 'import' };
import { FrontendFiles } from '../src/frontend-files';
import { FrontendCompiler } from '../src/frontend-compile';
import {
	createManagedCompileService,
	checkedCompilePath,
	MANAGED_COMPILE_TIMEOUT_MS,
	MANAGED_FORMAT_SETUP_TIMEOUT_MS
} from '../src/managed-compile';
import type { CompileInputBarrierPoint, CompileInputLimits } from '../src/frontend-compile-inputs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const data = path.join(repository, '.verification-artifacts', 'frontend-runtime-2026-10-07');
await checkedCompilePath(repository, true);
for (const directory of [path.dirname(data), data]) {
	try { await fs.mkdir(directory); }
	catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
	await checkedCompilePath(directory, true);
}

const MAIN_SOURCE =
	'\\documentclass{article}\n\\begin{document}\n\\input{sections/chapter.tex}\n\\end{document}\n';

interface Harness {
	readonly root: string;
	readonly files: FrontendFiles;
	readonly engine: ReturnType<typeof createManagedCompileService>;
	readonly compiler: FrontendCompiler;
}

type Completion =
	| { readonly kind: 'result'; readonly result: CompileResult }
	| { readonly kind: 'error'; readonly error: unknown };

type Mutation = (sections: string, chapter: string) => Promise<void>;

function observe(promise: Promise<CompileResult>): Promise<Completion> {
	return promise.then(
		(result) => ({ kind: 'result' as const, result }),
		(error) => ({ kind: 'error' as const, error })
	);
}

async function waitForBarrierOrCompletion(
	barrier: Promise<void>,
	completion: Promise<Completion>
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
			timer = setTimeout(() => resolve({ kind: 'timeout' }), MANAGED_COMPILE_TIMEOUT_MS);
		});
		const outcome = await Promise.race([
			barrier.then(() => ({ kind: 'barrier' as const })),
			completion.then((value) => ({ kind: 'completion' as const, value })),
			timeout
		]);
		if (outcome.kind === 'barrier') return;
		if (outcome.kind === 'timeout') throw new Error('Timed out waiting for compile-input barrier');
		if (outcome.value.kind === 'error') {
			throw new Error(`Compile ended before compile-input barrier: ${String(outcome.value.error)}`);
		}
		throw new Error(`Compile ended before compile-input barrier: ${outcome.value.result.status}`);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

async function createHarness(limits?: CompileInputLimits): Promise<Harness> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'modutex-compile-input-lifetime-'));
	const files = new FrontendFiles();
	const engine = createManagedCompileService({
		runtime: { isPackaged: false, appPath: repository, resourcesPath: repository, userData: data },
		authorize: () => files.compileOwner()
	});
	return { root, files, engine, compiler: new FrontendCompiler(engine, () => files, limits) };
}

async function disposeHarness(harness: Harness, pending: readonly Promise<unknown>[] = []): Promise<void> {
	harness.compiler.cancelOwner(1);
	harness.engine.close();
	await Promise.allSettled(pending);
	harness.files.close();
	if (
		path.dirname(harness.root) !== os.tmpdir() ||
		!path.basename(harness.root).startsWith('modutex-compile-input-lifetime-')
	) {
		throw new Error('Unsafe cleanup');
	}
	await fs.rm(harness.root, { recursive: true, force: true });
}

async function runStaleInputCase(mutate: Mutation): Promise<void> {
	let resolveEntered!: () => void;
	let releaseGate: () => void = () => {};
	const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
	let gateEnabled = false;
	let gateVisits = 0;
	const limits: CompileInputLimits = {
		barrier: async (point: CompileInputBarrierPoint) => {
			if (!gateEnabled || point.kind !== 'file' || point.path !== 'sections/chapter.tex' || ++gateVisits !== 2) {
				return;
			}
			const gate = new Promise<void>((resolve) => {
				let released = false;
				const release = () => {
					if (released) return;
					released = true;
					point.signal?.removeEventListener('abort', release);
					resolve();
				};
				releaseGate = release;
				point.signal?.addEventListener('abort', release, { once: true });
				if (point.signal?.aborted) release();
			});
			resolveEntered();
			await gate;
		}
	};
	const harness = await createHarness(limits);
	const pendingResults: Promise<unknown>[] = [];
	let completion: Promise<Completion> | null = null;
	let settled = false;

	try {
		const sections = path.join(harness.root, 'sections');
		const chapter = path.join(sections, 'chapter.tex');
		await fs.mkdir(sections);
		await fs.writeFile(chapter, 'First.\n');
		await fs.writeFile(path.join(harness.root, 'main.tex'), MAIN_SOURCE);
		const workspace = await harness.files.open(harness.root, 'folder');
		const main = await harness.files.read({ workspaceId: workspace.id, path: 'main.tex' });

		const firstRun = await harness.compiler.start({}, 1, {
			workspaceId: workspace.id,
			entryPath: 'main.tex',
			documentId: 'input-lifetime-document',
			documentVersion: 0,
			savedRevision: main.revision,
			engine: 'managed'
		});
		const first = await harness.compiler.result(1, firstRun.runId);
		expect(first.status, first.log).toBe('success');
		if (first.status !== 'success') throw new Error(first.log);
		const previousPdf = await fs.readFile(path.join(harness.root, 'output', 'main.pdf'));
		expect(previousPdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
		expect(Buffer.from(first.pdf)).toEqual(previousPdf);

		gateEnabled = true;
		gateVisits = 0;
		const secondRun = await harness.compiler.start({}, 1, {
			workspaceId: workspace.id,
			entryPath: 'main.tex',
			documentId: 'input-lifetime-document',
			documentVersion: 1,
			savedRevision: main.revision,
			engine: 'managed'
		});
		const pending = harness.compiler.result(1, secondRun.runId);
		// Attach the rejection observer before waiting for the gate.
		completion = observe(pending).then((value) => {
			settled = true;
			return value;
		});
		pendingResults.push(completion);

		await waitForBarrierOrCompletion(entered, completion);
		expect(await fs.readFile(path.join(harness.root, 'output', 'main.pdf'))).toEqual(previousPdf);
		await mutate(sections, chapter);
		releaseGate();

		const outcome = await completion;
		if (outcome.kind === 'error') throw outcome.error;
		expect(outcome.result.status).toBe('failure');
		expect(outcome.result).not.toHaveProperty('pdf');
		expect(await fs.readFile(path.join(harness.root, 'output', 'main.pdf'))).toEqual(previousPdf);

		// The stale result must drain and release the FrontendFiles compilation reservation.
		await harness.files.write({
			workspaceId: workspace.id,
			path: 'reservation-probe.tex',
			bytes: Buffer.from('Reservation released.\n'),
			expectedRevision: null,
			documentId: 'reservation-probe',
			documentVersion: 0
		});
	} finally {
		if (!settled) harness.compiler.cancelOwner(1);
		releaseGate();
		await disposeHarness(harness, pendingResults);
	}
}

describe('real ManagedTectonic compile-input publication gate', () => {
	it('preserves the prior PDF when an included file changes before publication', async () => {
		await runStaleInputCase(async (_sections, chapter) => {
			await fs.writeFile(chapter, 'Other.\n');
		});
	}, MANAGED_FORMAT_SETUP_TIMEOUT_MS + MANAGED_COMPILE_TIMEOUT_MS + 15_000);

	it('preserves the prior PDF when an input file is added before publication', async () => {
		await runStaleInputCase(async (sections) => {
			await fs.writeFile(path.join(sections, 'appendix.tex'), 'Added input.\n');
		});
	}, MANAGED_FORMAT_SETUP_TIMEOUT_MS + MANAGED_COMPILE_TIMEOUT_MS + 15_000);

	it('preserves the prior PDF when an included file is removed before publication', async () => {
		await runStaleInputCase(async (_sections, chapter) => {
			await fs.unlink(chapter);
		});
	}, MANAGED_FORMAT_SETUP_TIMEOUT_MS + MANAGED_COMPILE_TIMEOUT_MS + 15_000);

	it('preserves the prior PDF after same-byte replacement of an included file', async () => {
		await runStaleInputCase(async (sections, chapter) => {
			const replacement = path.join(sections, 'replacement.tex');
			await fs.writeFile(replacement, 'First.\n');
			await fs.unlink(chapter);
			await fs.rename(replacement, chapter);
		});
	}, MANAGED_FORMAT_SETUP_TIMEOUT_MS + MANAGED_COMPILE_TIMEOUT_MS + 15_000);

	it('cancels paused prepublication validation, drains, and allows the next real compile', async () => {
		let resolveEntered!: () => void;
		let releaseGate: () => void = () => {};
		const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
		let gateEnabled = false;
		let gateVisits = 0;
		const harness = await createHarness({
			barrier: async (point) => {
				if (!gateEnabled || point.kind !== 'file' || point.path !== 'sections/chapter.tex' || ++gateVisits !== 2) {
					return;
				}
				const gate = new Promise<void>((resolve) => {
					let released = false;
					const release = () => {
						if (released) return;
						released = true;
						point.signal?.removeEventListener('abort', release);
						resolve();
					};
					releaseGate = release;
					point.signal?.addEventListener('abort', release, { once: true });
					if (point.signal?.aborted) release();
				});
				resolveEntered();
				await gate;
			}
		});
		const pendingResults: Promise<unknown>[] = [];
		let firstCompletion: Promise<Completion> | null = null;
		let settled = false;

		try {
			await fs.mkdir(path.join(harness.root, 'sections'));
			await fs.writeFile(path.join(harness.root, 'sections', 'chapter.tex'), 'First.\n');
			await fs.writeFile(path.join(harness.root, 'main.tex'), MAIN_SOURCE);
			const workspace = await harness.files.open(harness.root, 'folder');
			const main = await harness.files.read({ workspaceId: workspace.id, path: 'main.tex' });

			const firstRun = await harness.compiler.start({}, 1, {
				workspaceId: workspace.id,
				entryPath: 'main.tex',
				documentId: 'cancel-input-document',
				documentVersion: 0,
				savedRevision: main.revision,
				engine: 'managed'
			});
			const first = await harness.compiler.result(1, firstRun.runId);
			expect(first.status, first.log).toBe('success');
			if (first.status !== 'success') throw new Error(first.log);
			const previousPdf = await fs.readFile(path.join(harness.root, 'output', 'main.pdf'));

			gateEnabled = true;
			gateVisits = 0;
			const pausedRun = await harness.compiler.start({}, 1, {
				workspaceId: workspace.id,
				entryPath: 'main.tex',
				documentId: 'cancel-input-document',
				documentVersion: 1,
				savedRevision: main.revision,
				engine: 'managed'
			});
			const pausedPending = harness.compiler.result(1, pausedRun.runId);
			firstCompletion = observe(pausedPending).then((value) => {
				settled = true;
				return value;
			});
			pendingResults.push(firstCompletion);
			await waitForBarrierOrCompletion(entered, firstCompletion);
			expect(await fs.readFile(path.join(harness.root, 'output', 'main.pdf'))).toEqual(previousPdf);

			await expect(harness.files.write({
				workspaceId: workspace.id,
				path: 'main.tex',
				bytes: Buffer.from(MAIN_SOURCE),
				expectedRevision: main.revision,
				documentId: 'cancel-input-document',
				documentVersion: 1
			})).rejects.toThrow('BUSY');

			await harness.compiler.cancel(1, pausedRun.runId);
			const cancelled = await firstCompletion;
			if (cancelled.kind === 'error') throw cancelled.error;
			expect(cancelled.result.status).toBe('cancelled');
			expect(cancelled.result).not.toHaveProperty('pdf');
			expect(await fs.readFile(path.join(harness.root, 'output', 'main.pdf'))).toEqual(previousPdf);

			// cancel() resolves only after the gate, engine cleanup, result drain, and
			// compilation reservation release, so the next genuine compile can start now.
			const nextRun = await harness.compiler.start({}, 1, {
				workspaceId: workspace.id,
				entryPath: 'main.tex',
				documentId: 'cancel-input-document',
				documentVersion: 2,
				savedRevision: main.revision,
				engine: 'managed'
			});
			const nextPending = harness.compiler.result(1, nextRun.runId);
			const nextCompletion = observe(nextPending);
			pendingResults.push(nextCompletion);
			const next = await nextCompletion;
			if (next.kind === 'error') throw next.error;
			expect(next.result.status, next.result.status === 'failure' ? next.result.log : '').toBe('success');
			if (next.result.status !== 'success') throw new Error(next.result.log);
			expect(Buffer.from(next.result.pdf).subarray(0, 5).toString('ascii')).toBe('%PDF-');
		} finally {
			if (!settled) harness.compiler.cancelOwner(1);
			releaseGate();
			await disposeHarness(harness, pendingResults);
		}
	}, MANAGED_FORMAT_SETUP_TIMEOUT_MS + 2 * MANAGED_COMPILE_TIMEOUT_MS + 15_000);

	it('preserves the previous genuine PDF after a real TeX failure and releases the reservation', async () => {
		const harness = await createHarness();
		try {
			const mainPath = path.join(harness.root, 'main.tex');
			await fs.writeFile(mainPath, '\\documentclass{article}\n\\begin{document}Stable.\\end{document}\n');
			const workspace = await harness.files.open(harness.root, 'folder');
			const initial = await harness.files.read({ workspaceId: workspace.id, path: 'main.tex' });
			const firstRun = await harness.compiler.start({}, 1, {
				workspaceId: workspace.id,
				entryPath: 'main.tex',
				documentId: 'previous-pdf-document',
				documentVersion: 0,
				savedRevision: initial.revision,
				engine: 'managed'
			});
			const first = await harness.compiler.result(1, firstRun.runId);
			expect(first.status, first.log).toBe('success');
			if (first.status !== 'success') throw new Error(first.log);
			const previousPdf = await fs.readFile(path.join(harness.root, 'output', 'main.pdf'));
			expect(previousPdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');

			const invalid = await harness.files.write({
				workspaceId: workspace.id,
				path: 'main.tex',
				bytes: Buffer.from('\\documentclass{article}\n\\begin{document}\\undefinedcompileinputcommand\\end{document}\n'),
				expectedRevision: initial.revision,
				documentId: 'previous-pdf-document',
				documentVersion: 1
			});
			const failedRun = await harness.compiler.start({}, 1, {
				workspaceId: workspace.id,
				entryPath: 'main.tex',
				documentId: 'previous-pdf-document',
				documentVersion: 1,
				savedRevision: invalid.revision,
				engine: 'managed'
			});
			const failed = await harness.compiler.result(1, failedRun.runId);
			expect(failed.status).toBe('failure');
			expect(await fs.readFile(path.join(harness.root, 'output', 'main.pdf'))).toEqual(previousPdf);

			await harness.files.write({
				workspaceId: workspace.id,
				path: 'reservation-probe.tex',
				bytes: Buffer.from('Reservation released.\n'),
				expectedRevision: null,
				documentId: 'reservation-probe',
				documentVersion: 0
			});
		} finally {
			await disposeHarness(harness);
		}
	}, MANAGED_FORMAT_SETUP_TIMEOUT_MS + MANAGED_COMPILE_TIMEOUT_MS + 15_000);
});
