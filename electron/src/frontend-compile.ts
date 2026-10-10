// Integration stays within the AGPL host; no legacy renderer code crosses the seam.
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { CompileIdentity, CompileResult } from '@modutex/frontend-contracts' with { 'resolution-mode': 'import' };
import type { createManagedCompileService } from './managed-compile';
import type { FrontendFiles } from './frontend-files';
import { frontendDiagnostics } from './frontend-diagnostics';
import { captureCompileInputs, type CompileInputLimits } from './frontend-compile-inputs';

type Engine = ReturnType<typeof createManagedCompileService>;
interface Run {
	readonly identity: CompileIdentity;
	result: Promise<CompileResult> | null;
	cancelled: boolean;
	readonly controller: AbortController;
	consuming: boolean;
	drained: boolean;
	readonly drainedPromise: Promise<void>;
	readonly resolveDrained: () => void;
}
/** One bounded run/result per owner; a cancelled run is replaceable only after draining. */
export class FrontendCompiler {
	private readonly runs = new Map<number, Run>();
	constructor(
		private readonly engine: Engine,
		private readonly files: (owner: number) => FrontendFiles,
		private readonly inputLimits?: CompileInputLimits
	) {}

	async start(event: unknown, owner: number, payload: unknown): Promise<CompileIdentity> {
		const request = (await import('@modutex/frontend-contracts')).parseCompileRequest(payload);
		if (request.engine !== 'managed') throw new Error('ENGINE_UNAVAILABLE');
		const previous = this.runs.get(owner);
		if (previous && (!previous.cancelled || !previous.drained)) throw new Error('BUSY');
		let resolveDrained!: () => void;
		const drainedPromise = new Promise<void>((resolve) => { resolveDrained = resolve; });
		const active: Run = { identity: Object.freeze({ runId: randomUUID(), workspaceId: request.workspaceId,
			entryPath: request.entryPath, documentId: request.documentId, documentVersion: request.documentVersion,
			savedRevision: request.savedRevision }), result: null, cancelled: false, consuming: false,
			controller: new AbortController(), drained: false, drainedPromise, resolveDrained };
		this.runs.set(owner, active);
		let releaseCompilation: (() => void) | undefined;
		const drain = () => {
			if (active.drained) return;
			const release = releaseCompilation;
			releaseCompilation = undefined;
			try { release?.(); }
			finally {
				active.drained = true;
				active.resolveDrained();
			}
		};
		try {
			const files = this.files(owner);
			releaseCompilation = files.reserveCompilation(request.workspaceId);
			const ref = { workspaceId: request.workspaceId, path: request.entryPath };
			const inputAuthority = files.compileOwner();
			const inputLimits: CompileInputLimits = {
				...(this.inputLimits ?? {}),
				signal: active.controller.signal
			};
			const initial = await files.read(ref);
			if (initial.revision !== request.savedRevision) throw new Error('FILE_CONFLICT');
			if (this.runs.get(owner) !== active || active.cancelled) throw new Error('STALE_WORKSPACE');
			const inputManifest = await captureCompileInputs(inputAuthority, inputLimits);
			const selectedInput = inputManifest.entries.find((entry) => entry.path === request.entryPath);
			if (!selectedInput || selectedInput.hash !== request.savedRevision) throw new Error('FILE_CONFLICT');
			const confirmed = await files.read(ref);
			if (confirmed.revision !== request.savedRevision) throw new Error('FILE_CONFLICT');
			if (this.runs.get(owner) !== active || active.cancelled) throw new Error('STALE_WORKSPACE');
			const result = (async (): Promise<CompileResult> => {
				try {
					const validateBeforePublish = async () => {
						if (active.cancelled || active.controller.signal.aborted || this.runs.get(owner) !== active) {
							throw new Error('CANCELLED');
						}
						await inputManifest.assertCurrent(inputAuthority, inputLimits);
						if (active.cancelled || active.controller.signal.aborted || this.runs.get(owner) !== active) {
							throw new Error('CANCELLED');
						}
					};
					const outcome = await this.engine.run(
						event,
						owner,
						{ engine: 'tectonic', mainFile: request.entryPath },
						validateBeforePublish
					);
					if (active.cancelled || active.controller.signal.aborted) {
						return { status: 'cancelled', identity: active.identity, log: outcome.stdout, diagnostics: [] };
					}
					if (!outcome.ok) {
						const diagnostics = frontendDiagnostics(outcome.stdout, request.entryPath);
						return { status: outcome.error === 'CANCELLED' ? 'cancelled' : 'failure',
						identity: active.identity, log: outcome.stdout, diagnostics: diagnostics.length ? diagnostics : [{ severity: 'error',
							message: outcome.error === 'TIMEOUT' ? '編譯逾時。請檢查文件內容後再試。' : '編譯失敗。請檢查 TeX 記錄。',
							path: request.entryPath, line: null, column: null }] };
					}
					const current = await files.read(ref);
					if (current.revision !== request.savedRevision || this.runs.get(owner) !== active) throw new Error('FILE_CONFLICT');
					const stem = path.basename(request.entryPath, path.extname(request.entryPath));
					const pdf = await files.read({ workspaceId: request.workspaceId, path: 'output/' + stem + '.pdf' });
					if (active.cancelled || active.controller.signal.aborted || this.runs.get(owner) !== active) {
						return { status: 'cancelled', identity: active.identity, log: '', diagnostics: [] };
					}
					// Recheck after the immutable PDF capture before exposing its bytes.
					await inputManifest.assertCurrent(inputAuthority, inputLimits);
					if (active.cancelled || active.controller.signal.aborted || this.runs.get(owner) !== active) {
						return { status: 'cancelled', identity: active.identity, log: '', diagnostics: [] };
					}
					return { status: 'success', identity: active.identity, pdf: pdf.bytes, log: outcome.stdout, diagnostics: [] };
				} catch {
					const cancelled = active.cancelled || active.controller.signal.aborted;
					return { status: cancelled ? 'cancelled' : 'failure', identity: active.identity, log: '', diagnostics: cancelled ? [] : [
						{ severity: 'error', message: '編譯輸入已變更，本次結果未載入。請重新編譯。', path: request.entryPath, line: null, column: null }
					] };
				}
				finally { drain(); }
			})();
			active.result = result;
			// An owner can close without consuming its result. Preserve result()'s
			// rejection behavior while ensuring a detached run cannot be unhandled.
			void result.catch(() => {});
			return active.identity;
		} catch (error) {
			drain();
			if (this.runs.get(owner) === active) this.runs.delete(owner);
			throw error;
		}
	}

	async result(owner: number, id: unknown): Promise<CompileResult> {
		const active = this.runs.get(owner);
		if (!active || active.identity.runId !== id || !active.result) throw new Error('STALE_WORKSPACE');
		if (active.consuming) throw new Error('BUSY');
		active.consuming = true;
		try { return await active.result; }
		finally {
			// Cancellation/restart may have replaced this run while result() waited.
			if (this.runs.get(owner) === active) this.runs.delete(owner);
		}
	}
	async cancel(owner: number, id: unknown): Promise<void> {
		const active = this.runs.get(owner);
		if (!active || active.identity.runId !== id) throw new Error('STALE_WORKSPACE');
		active.cancelled = true;
		active.controller.abort();
		this.engine.cancelOwner(owner);
		// The managed run settles only after engine cleanup; drain also waits for
		// PDF capture and releases the FrontendFiles compilation reservation.
		await active.drainedPromise;
	}
	cancelOwner(owner: number): void {
		const active = this.runs.get(owner);
		if (active) {
			active.cancelled = true;
			active.controller.abort();
		}
		this.engine.cancelOwner(owner);
		this.runs.delete(owner);
	}
}
