// Original renderer adapter. Only this module knows the narrow preload API.
import { parseWorkspaceInfo, parseFileEntries, parseFileEvent, parseReadReceipt, parseWriteReceipt, parseSaveAsReceipt, parseCompileIdentity, parseCompileResult, recentDocumentId } from '@modutex/frontend-contracts';
import type { DesktopPort, FileEvent, FileRef, FileWatchFailure, WriteRequest, SaveAsRequest, CompileRequest } from '@modutex/frontend-contracts';
import { recentDocuments } from './recent.ts';

interface NativeFiles {
	openWorkspace(kind: 'file' | 'folder'): Promise<unknown>;
	listRecent(): Promise<unknown>;
	openRecent(id: string): Promise<unknown>;
	removeRecent(id: string): Promise<unknown>;
	listFiles(id: string): Promise<unknown>;
	readFile(file: FileRef): Promise<unknown>;
	writeFile(request: WriteRequest): Promise<unknown>;
	saveAs(request: SaveAsRequest): Promise<unknown>;
	startCompile(request: CompileRequest): Promise<unknown>;
	compileResult(id: string): Promise<unknown>;
	cancelCompile(id: string): Promise<unknown>;
	closeWorkspace(id: string): Promise<unknown>;
	startWatch(workspaceId: string, subscriptionId: string): Promise<unknown>;
	stopWatch(subscriptionId: string): Promise<unknown>;
	onWatchEvent(listener: (value: unknown) => void): () => void;
	onWatchError(listener: (value: unknown) => void): () => void;
}
export type FileDesktopPort = Pick<DesktopPort, 'openWorkspace' | 'listRecent' | 'openRecent' | 'removeRecent' | 'listFiles' | 'readFile' | 'writeFile' | 'saveAs' | 'watchFiles' | 'compile' | 'closeWorkspace'>;

let watchSequence = 0;
const watchFailureCodes: ReadonlySet<string> = new Set([
	'TREE_TOO_DEEP', 'TREE_TOO_LARGE', 'STALE_WORKSPACE', 'LINK_NOT_ALLOWED', 'FILE_OPERATION_FAILED'
]);

function nextWatchId(): string {
	watchSequence = watchSequence >= Number.MAX_SAFE_INTEGER ? 1 : watchSequence + 1;
	return `watch-${Date.now().toString(36)}-${watchSequence.toString(36)}`;
}

/** Read only the exact data envelope sent by the main-process watch bridge. */
function watchMessage(
	value: unknown,
	subscriptionId: string,
	field: 'event' | 'error'
): { readonly valid: false } | { readonly valid: true; readonly payload: unknown } {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return { valid: false };
	try {
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Reflect.ownKeys(value);
		const id = descriptors.subscriptionId;
		const payload = descriptors[field];
		if (keys.length !== 2 || !id || !('value' in id) || !payload || !('value' in payload) ||
			id.value !== subscriptionId) return { valid: false };
		return { valid: true, payload: payload.value };
	} catch {
		return { valid: false };
	}
}

function fileWatchFailure(value: unknown): FileWatchFailure | null {
	return typeof value === 'string' && watchFailureCodes.has(value) ? value as FileWatchFailure : null;
}

export function desktopFiles(signal?: AbortSignal): FileDesktopPort | null {
	const native = (window as Window & { modutexFiles?: NativeFiles }).modutexFiles;
	if (!native) return null;
	const assertActive = () => { if (signal?.aborted) throw new Error('STALE_WORKSPACE'); };
	interface LocalWatch {
		readonly workspaceId: string;
		readonly subscriptionId: string;
		active: boolean;
		disposed: boolean;
		startRequested: boolean;
		failure: FileWatchFailure | null;
		suppressFailure: boolean;
		removeEvent: () => void;
		removeError: () => void;
		abort?: () => void;
		stopping: Promise<void> | null;
	}
	const watches = new Set<LocalWatch>();
	const disposeWatch = (watch: LocalWatch, suppressFailure = true): Promise<void> => {
		if (suppressFailure) watch.suppressFailure = true;
		if (watch.disposed) return watch.stopping ?? Promise.resolve();
		watch.disposed = true;
		watch.active = false;
		watches.delete(watch);
		watch.removeEvent();
		watch.removeError();
		if (watch.abort) signal?.removeEventListener('abort', watch.abort);
		watch.stopping = watch.startRequested
			? Promise.resolve().then(() => native.stopWatch(watch.subscriptionId)).then(() => {}, () => {})
			: Promise.resolve();
		return watch.stopping;
	};
	const stopWorkspaceWatches = async (workspaceId: string): Promise<void> => {
		await Promise.all([...watches].filter((watch) => watch.workspaceId === workspaceId)
			.map((watch) => disposeWatch(watch)));
	};
	const stopAllWatches = async (): Promise<void> => {
		await Promise.all([...watches].map((watch) => disposeWatch(watch)));
	};
	return {
		async listRecent() { assertActive(); const result = await native.listRecent(); assertActive(); return recentDocuments(result); },
		async removeRecent(id) { assertActive(); await native.removeRecent(recentDocumentId(id)); assertActive(); },
		async openRecent(id) {
			assertActive(); const workspace = parseWorkspaceInfo(await native.openRecent(recentDocumentId(id)));
			if (!workspace) throw new Error('RECENT_NOT_FOUND');
			await stopAllWatches();
			if (signal?.aborted) { await native.closeWorkspace(workspace.id); assertActive(); }
			return workspace;
		},
		async openWorkspace(kind) {
			assertActive();
			const result = await native.openWorkspace(kind);
			const workspace = result === null ? null : parseWorkspaceInfo(result);
			if (signal?.aborted) {
				if (workspace) { await stopAllWatches(); await native.closeWorkspace(workspace.id); }
				assertActive();
			}
			if (workspace) await stopAllWatches();
			if (signal?.aborted) {
				if (workspace) await native.closeWorkspace(workspace.id);
				assertActive();
			}
			return workspace;
		},
		async listFiles(id) { assertActive(); const result = await native.listFiles(id); assertActive(); return parseFileEntries(result, 4096); },
		async readFile(file) {
			assertActive();
			const maximum = file.path.toLowerCase().endsWith('.pdf') ? 32 * 1024 * 1024 : 5 * 1024 * 1024;
			const result = await native.readFile(file); assertActive();
			return parseReadReceipt(result, file, maximum);
		},
		async writeFile(request) { assertActive(); const result = await native.writeFile(request); assertActive(); return parseWriteReceipt(result, request); },
		async saveAs(request) {
			assertActive();
			const result = parseSaveAsReceipt(await native.saveAs(request), request);
			if (result) await stopAllWatches();
			if (signal?.aborted) { if (result) await native.closeWorkspace(result.workspace.id); assertActive(); }
			return result;
		},
		async watchFiles(workspaceId, listener, onError) {
			assertActive();
			const watch: LocalWatch = {
				workspaceId,
				subscriptionId: nextWatchId(),
				active: true,
				disposed: false,
				startRequested: false,
				failure: null,
				suppressFailure: false,
				removeEvent: () => {},
				removeError: () => {},
				stopping: null
			};
			watches.add(watch);
			try {
				const removeEvent = native.onWatchEvent((value) => {
					if (!watch.active || signal?.aborted) return;
					const message = watchMessage(value, watch.subscriptionId, 'event');
					if (!message.valid) return;
					let event: FileEvent;
					try { event = parseFileEvent(message.payload, workspaceId); }
					catch { return; }
					listener(event);
				});
				watch.removeEvent = removeEvent;
				if (watch.disposed) removeEvent();
				const removeError = native.onWatchError((value) => {
					if (!watch.active || watch.failure) return;
					const message = watchMessage(value, watch.subscriptionId, 'error');
					if (!message.valid) return;
					const failure = fileWatchFailure(message.payload);
					if (!failure) return;
					watch.failure = failure;
					void disposeWatch(watch, false).then(() => {
						if (watch.suppressFailure || watch.failure !== failure) return;
						try { onError?.(failure); }
						catch { /* the watch and its native resources are already closed */ }
					});
				});
				watch.removeError = removeError;
				if (watch.disposed) removeError();
				watch.abort = () => { void disposeWatch(watch); };
				signal?.addEventListener('abort', watch.abort, { once: true });
				assertActive();
				if (!watch.active) throw new Error('STALE_WORKSPACE');
				watch.startRequested = true;
				await native.startWatch(workspaceId, watch.subscriptionId);
				if (watch.failure) throw new Error(watch.failure);
				assertActive();
				if (!watch.active) throw new Error('STALE_WORKSPACE');
				return () => { void disposeWatch(watch); };
			} catch (error) {
				await disposeWatch(watch, watch.failure === null);
				throw error;
			}
		},
		async compile(request) {
			assertActive();
			const { engine: _engine, ...expected } = request;
			const identity = parseCompileIdentity(await native.startCompile(request), expected);
			let settled = false;
			let cancellation: Promise<void> | null = null;
			const requestCancellation = (): Promise<void> => {
				if (settled) return Promise.resolve();
				if (!cancellation) {
					const pending = Promise.resolve().then(async () => {
						if (!settled) await native.cancelCompile(identity.runId);
					});
					cancellation = pending;
					void pending.catch(() => {
						if (cancellation === pending) cancellation = null;
					});
				}
				return cancellation;
			};
			const cancelOnAbort = () => { void requestCancellation().catch(() => {}); };
			const finished = native.compileResult(identity.runId).then((result) => parseCompileResult(result, identity,
				{ maxPdfBytes: 32 * 1024 * 1024, maxLogCharacters: 256 * 1024, maxDiagnostics: 256 })).then(
				(result) => { assertActive(); return result; },
				(error: unknown) => { assertActive(); throw error; });
			void finished.then(() => { settled = true; }, () => { settled = true; });
			// Attach immediately: callers may abandon a view before awaiting its completion.
			void finished.catch(() => {});
			if (signal?.aborted) { await requestCancellation(); assertActive(); }
			signal?.addEventListener('abort', cancelOnAbort, { once: true });
			void finished.finally(() => signal?.removeEventListener('abort', cancelOnAbort)).catch(() => {});
			return { identity, finished, async cancel() { await requestCancellation(); } };
		},
		async closeWorkspace(id) { await stopWorkspaceWatches(id); await native.closeWorkspace(id); }
	};
}
