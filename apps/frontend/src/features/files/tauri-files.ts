// SPDX-License-Identifier: Apache-2.0
// The only Tauri transport for DesktopPort file operations. The production
// entry is gated by Tauri's official runtime detector; it never probes a
// renderer-provided invoke global.
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
	parseCompileConfig,
	parseCompileConfigUpdate,
	parseCompileIdentity,
	parseCompileRequest,
	parseCompileResult,
	parseFileEntries,
	parseFileEvent,
	parseReadReceipt,
	parseRecentDocuments,
	parseSaveAsReceipt,
	parseSaveAsRequest,
	parseWriteReceipt,
	parseWriteRequest,
	parseWorkspaceInfo,
	recentDocumentId
} from '@modutex/frontend-contracts';
import type {
	CompileIdentity,
	CompileRequest,
	DesktopPort,
	FileEvent,
	FileRef,
	FileWatchFailure,
	FileWatchResyncReason,
	SaveAsRequest,
	WriteRequest
} from '@modutex/frontend-contracts';

type FileDesktopPort = Pick<
	DesktopPort,
	| 'openWorkspace'
	| 'listRecent'
	| 'openRecent'
	| 'removeRecent'
	| 'listFiles'
	| 'readFile'
	| 'writeFile'
	| 'saveAs'
	| 'watchFiles'
	| 'compile'
	| 'takeCompileSynctex'
	| 'getCompileConfig'
	| 'updateCompileConfig'
	| 'closeWorkspace'
>;

/** Internal injection seam used to exercise the real adapter without a host. */
export interface TauriFilesTransport {
	invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
	listen(event: string, listener: (payload: unknown) => void): Promise<() => void>;
}

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_PDF_BYTES = 32 * 1024 * 1024;
const MAX_LOG_CHARACTERS = 256 * 1024;
const MAX_DIAGNOSTICS = 256;

const command = {
	openWorkspace: 'frontend_open_workspace',
	listRecent: 'frontend_list_recent',
	openRecent: 'frontend_open_recent',
	removeRecent: 'frontend_remove_recent',
	listFiles: 'frontend_list_files',
	readFile: 'frontend_read_file',
	takeFilePdf: 'frontend_take_file_pdf',
	writeFile: 'frontend_write_file',
	saveAs: 'frontend_save_as',
	watchStart: 'frontend_watch_start',
	watchStop: 'frontend_watch_stop',
	startCompile: 'frontend_start_compile',
	compileResult: 'frontend_compile_result',
	takeCompilePdf: 'frontend_take_compile_pdf',
	takeCompileSynctex: 'frontend_take_compile_synctex',
	cancelCompile: 'frontend_cancel_compile',
	closeWorkspace: 'frontend_close_workspace',
	getCompileConfig: 'frontend_get_compile_config',
	updateCompileConfig: 'frontend_update_compile_config'
} as const;

const fileEventName = 'frontend://files/event';
const fileErrorName = 'frontend://files/error';
const fileResyncName = 'frontend://files/resync';
const watchFailures: ReadonlySet<string> = new Set([
	'TREE_TOO_DEEP',
	'TREE_TOO_LARGE',
	'STALE_WORKSPACE',
	'LINK_NOT_ALLOWED',
	'FILE_OPERATION_FAILED'
]);
const watchResyncReasons: ReadonlySet<string> = new Set(['PERIODIC_RECONCILE_DUE']);

function sameCompileIdentity(left: CompileIdentity, right: CompileIdentity): boolean {
	return left.runId === right.runId &&
		left.workspaceId === right.workspaceId &&
		left.entryPath === right.entryPath &&
		left.documentId === right.documentId &&
		left.documentVersion === right.documentVersion &&
		left.savedRevision === right.savedRevision;
}

function isSynctexUnavailable(value: unknown): boolean {
	return value === 'SyncTeX artifact unavailable' ||
		value instanceof Error && value.message === 'SyncTeX artifact unavailable';
}

function exactRecord(value: unknown, fields: readonly string[], field: string): Record<string, unknown> {
	try {
		if (
			typeof value !== 'object' ||
			value === null ||
			Array.isArray(value) ||
			![Object.prototype, null].includes(Object.getPrototypeOf(value))
		) {
			throw new Error();
		}
		const descriptors = Object.getOwnPropertyDescriptors(value);
		const keys = Reflect.ownKeys(value);
		if (
			keys.length !== fields.length ||
			keys.some((key) => typeof key !== 'string' || !fields.includes(key)) ||
			fields.some((key) => !descriptors[key] || !('value' in descriptors[key]!))
		) {
			throw new Error();
		}
		return value as Record<string, unknown>;
	} catch {
		throw new Error(`${field}: expected exact data fields`);
	}
}

function jsonBytes(value: unknown, maximum: number, field: string): Uint8Array {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
		throw new Error(`${field}: invalid byte array`);
	}
	const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
	const length = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
	if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maximum) {
		throw new Error(`${field}: invalid byte array`);
	}

	// Reflect.ownKeys includes non-enumerable properties and symbols.
	const keys = Reflect.ownKeys(value);
	if (keys.length !== length + 1) throw new Error(`${field}: sparse or augmented array`);
	let hasLength = false;
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i];
		if (key === 'length') {
			hasLength = true;
			continue;
		}
		if (typeof key !== 'string') throw new Error(`${field}: sparse or augmented array`);
		const index = Number(key);
		if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) {
			throw new Error(`${field}: sparse or augmented array`);
		}
	}
	if (!hasLength) throw new Error(`${field}: sparse or augmented array`);

	const bytes = new Uint8Array(length);
	for (let i = 0; i < length; i++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
		if (!descriptor || !('value' in descriptor)) throw new Error(`${field}: sparse or augmented array`);
		const byte: unknown = descriptor.value;
		if (typeof byte !== 'number' || !Number.isInteger(byte) || byte < 0 || byte > 255) {
			throw new Error(`${field}: invalid byte`);
		}
		bytes[i] = byte;
	}
	return bytes;
}

function opaqueToken(value: unknown, field: string): string {
	if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
		throw new Error(`${field}: invalid host token`);
	}
	return value;
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const nativeByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const nativeBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const nativeByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')!.get!;
const nativeTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const nativeArrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const nativeSet = Uint8Array.prototype.set;

function toOwnedUint8Array(value: unknown, maximum: number, field: string): Uint8Array {
	if (typeof value !== 'object' || value === null) {
		throw new Error(`${field}: invalid binary response`);
	}
	let source: Uint8Array;
	if (ArrayBuffer.isView(value)) {
		let tag: string | undefined;
		let length: number;
		let buffer: ArrayBuffer;
		let offset: number;
		try {
			tag = nativeTag.call(value);
			length = nativeByteLength.call(value);
			buffer = nativeBuffer.call(value) as ArrayBuffer;
			nativeArrayBufferLength.call(buffer);
			offset = nativeByteOffset.call(value);
		} catch {
			throw new Error(`${field}: invalid binary response`);
		}
		if (tag !== 'Uint8Array') {
			throw new Error(`${field}: invalid binary response`);
		}
		if (length > maximum) {
			throw new Error(`${field}: byte limit exceeded`);
		}
		source = new Uint8Array(buffer, offset, length);
	} else {
		let length: number;
		try {
			length = nativeArrayBufferLength.call(value);
		} catch {
			throw new Error(`${field}: invalid binary response`);
		}
		if (length > maximum) {
			throw new Error(`${field}: byte limit exceeded`);
		}
		source = new Uint8Array(value as ArrayBuffer, 0, length);
	}

	const owned = new Uint8Array(source.length);
	nativeSet.call(owned, source);
	return owned;
}

function writeLimit(path: string): number {
	return path.toLowerCase().endsWith('.pdf') ? MAX_PDF_BYTES : MAX_SOURCE_BYTES;
}

function writeWire(request: WriteRequest): Record<string, unknown> {
	return { ...request, bytes: Array.from(request.bytes) };
}

function saveAsWire(request: SaveAsRequest): Record<string, unknown> {
	return {
		workspaceId: request.workspaceId,
		bytes: Array.from(request.bytes),
		documentId: request.documentId,
		documentVersion: request.documentVersion,
		...(request.images === undefined
			? {}
			: { images: request.images.map((image) => ({ path: image.path, bytes: Array.from(image.bytes) })) })
	};
}

let watchSequence = 0;

function nextWatchIdentity(): { readonly subscriptionId: string; readonly generation: number } {
	watchSequence = watchSequence >= Number.MAX_SAFE_INTEGER ? 1 : watchSequence + 1;
	return {
		subscriptionId: `watch-${Date.now().toString(36)}-${watchSequence.toString(36)}`,
		generation: watchSequence
	};
}

/** Constructed only by the official Tauri entry, or by adapter tests. */
export function createTauriFilesAdapter(
	signal: AbortSignal | undefined,
	transport: TauriFilesTransport
): FileDesktopPort {
	const assertActive = () => {
		if (signal?.aborted) throw new Error('STALE_WORKSPACE');
	};
	const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
		assertActive();
		const result = await transport.invoke(name, args);
		assertActive();
		return result;
	};

	interface LocalWatch {
		readonly workspaceId: string;
		readonly subscriptionId: string;
		readonly generation: number;
		active: boolean;
		disposed: boolean;
		startRequested: boolean;
		failure: FileWatchFailure | null;
		suppressFailure: boolean;
		removeEvent: () => void;
		removeError: () => void;
		removeResync: () => void;
		abort?: () => void;
		starting: Promise<void> | null;
		stopping: Promise<void> | null;
	}

	const watches = new Set<LocalWatch>();
	const compileSynctexBindings = new Map<string, CompileIdentity>();
	const disposeWatch = (watch: LocalWatch, suppressFailure = true): Promise<void> => {
		if (suppressFailure) watch.suppressFailure = true;
		if (watch.disposed) return watch.stopping ?? Promise.resolve();
		watch.disposed = true;
		watch.active = false;
		const remove = (unlisten: () => void) => {
			try {
				unlisten();
			} catch {
				// Local listeners are already inactive.
			}
		};
		remove(watch.removeEvent);
		remove(watch.removeError);
		remove(watch.removeResync);
		if (watch.abort) signal?.removeEventListener('abort', watch.abort);
		const args = {
			workspaceId: watch.workspaceId,
			subscriptionId: watch.subscriptionId,
			generation: watch.generation
		};
		watch.stopping = (async () => {
			if (watch.starting) {
				try {
					await watch.starting;
				} catch {
					// Stop is still requested after a partially completed start.
				}
			}
			if (watch.startRequested) {
				try {
					await transport.invoke(command.watchStop, args);
				} catch {
					// Closing a stale subscription is best-effort; it cannot reactivate this watch.
				}
			}
		})().finally(() => watches.delete(watch));
		return watch.stopping;
	};
	const stopWorkspaceWatches = async (workspaceId: string): Promise<void> => {
		await Promise.all([...watches].filter((watch) => watch.workspaceId === workspaceId).map((watch) => disposeWatch(watch)));
	};
	const stopAllWatches = async (): Promise<void> => {
		await Promise.all([...watches].map((watch) => disposeWatch(watch)));
	};

	const readCompileResult = async (value: unknown, expected: CompileIdentity) => {
		const statusDescriptor =
			typeof value === 'object' && value !== null ? Object.getOwnPropertyDescriptor(value, 'status') : undefined;
		if (!statusDescriptor || !('value' in statusDescriptor)) throw new Error('status: expected a data field');
		const status = statusDescriptor.value;
		if (status === 'failure' || status === 'cancelled') {
			const metadata = exactRecord(value, ['status', 'identity', 'log', 'diagnostics'], 'compile result');
			return parseCompileResult(metadata, expected, {
				maxPdfBytes: MAX_PDF_BYTES,
				maxLogCharacters: MAX_LOG_CHARACTERS,
				maxDiagnostics: MAX_DIAGNOSTICS
			});
		}
		if (status !== 'success') throw new Error('status: unknown compile status');
		const metadata = exactRecord(value, ['status', 'identity', 'log', 'diagnostics', 'pdfToken'], 'compile result');
		const resultIdentity = parseCompileIdentity(metadata.identity, {
			workspaceId: expected.workspaceId,
			entryPath: expected.entryPath,
			documentId: expected.documentId,
			documentVersion: expected.documentVersion,
			savedRevision: expected.savedRevision
		});
		if (resultIdentity.runId !== expected.runId) throw new Error('identity: result is for another run');
		const token = opaqueToken(metadata.pdfToken, 'pdfToken');
		assertActive();
		const rawPdf = await call(command.takeCompilePdf, { token });
		assertActive();
		const pdf = toOwnedUint8Array(rawPdf, MAX_PDF_BYTES, 'pdf');
		assertActive();
		return parseCompileResult(
			{
				status: 'success',
				identity: metadata.identity,
				log: metadata.log,
				diagnostics: metadata.diagnostics,
				pdf
			},
			expected,
			{
				maxPdfBytes: MAX_PDF_BYTES,
				maxLogCharacters: MAX_LOG_CHARACTERS,
				maxDiagnostics: MAX_DIAGNOSTICS
			}
		);
	};

	return {
		async openWorkspace(kind) {
			assertActive();
			const result = await transport.invoke(command.openWorkspace, { kind });
			const workspace = result === null ? null : parseWorkspaceInfo(result);
			if (signal?.aborted) {
				if (workspace) {
					await stopAllWatches();
					await transport.invoke(command.closeWorkspace, { workspaceId: workspace.id });
				}
				assertActive();
			}
			if (workspace) await stopAllWatches();
			if (signal?.aborted) {
				if (workspace) await transport.invoke(command.closeWorkspace, { workspaceId: workspace.id });
				assertActive();
			}
			return workspace;
		},
		async listRecent() {
			return parseRecentDocuments(await call(command.listRecent));
		},
		async openRecent(id) {
			assertActive();
			const workspace = parseWorkspaceInfo(
				await transport.invoke(command.openRecent, { id: recentDocumentId(id) })
			);
			if (!workspace) throw new Error('RECENT_NOT_FOUND');
			await stopAllWatches();
			if (signal?.aborted) {
				await transport.invoke(command.closeWorkspace, { workspaceId: workspace.id });
				assertActive();
			}
			return workspace;
		},
		async removeRecent(id) {
			await call(command.removeRecent, { id: recentDocumentId(id) });
		},
		async listFiles(id) {
			return parseFileEntries(await call(command.listFiles, { workspaceId: id }), 4096);
		},
		async readFile(file: FileRef) {
			assertActive();
			const pdf = file.path.toLowerCase().endsWith('.pdf');
			const maximum = pdf ? MAX_PDF_BYTES : MAX_SOURCE_BYTES;
			const ref = { workspaceId: file.workspaceId, path: file.path };
			const result = await transport.invoke(command.readFile, { file: ref });
			assertActive();
			if (!pdf) {
				const input = exactRecord(result, ['workspaceId', 'path', 'bytes', 'revision'], 'read receipt');
				return parseReadReceipt(
					{ ...input, bytes: jsonBytes(input.bytes, maximum, 'bytes') },
					file,
					maximum
				);
			}
			const input = exactRecord(result, ['workspaceId', 'path', 'revision', 'binaryToken'], 'PDF read metadata');
			const receipt = parseReadReceipt(
				{
					workspaceId: input.workspaceId,
					path: input.path,
					revision: input.revision,
					bytes: new Uint8Array(0)
				},
				file,
				maximum
			);
			const token = opaqueToken(input.binaryToken, 'binaryToken');
			assertActive();
			const rawBytes = await call(command.takeFilePdf, { token });
			assertActive();
			const bytes = toOwnedUint8Array(rawBytes, maximum, 'bytes');
			assertActive();
			return parseReadReceipt({ ...receipt, bytes }, file, maximum);
		},
		async writeFile(request) {
			const parsed = parseWriteRequest(request, writeLimit(request.path));
			const receipt = await call(command.writeFile, { request: writeWire(parsed) });
			return parseWriteReceipt(receipt, parsed);
		},
		async saveAs(request) {
			assertActive();
			const parsed = parseSaveAsRequest(request, MAX_SOURCE_BYTES);
			const result = parseSaveAsReceipt(
				await transport.invoke(command.saveAs, { request: saveAsWire(parsed) }),
				parsed
			);
			if (result) await stopAllWatches();
			if (signal?.aborted) {
				if (result) await transport.invoke(command.closeWorkspace, { workspaceId: result.workspace.id });
				assertActive();
			}
			return result;
		},
		async watchFiles(workspaceId, listener, onError, onResync) {
			assertActive();
			const identity = nextWatchIdentity();
			const watch: LocalWatch = {
				workspaceId,
				...identity,
				active: true,
				disposed: false,
				startRequested: false,
				failure: null,
				suppressFailure: false,
				removeEvent: () => {},
				removeError: () => {},
				removeResync: () => {},
				starting: null,
				stopping: null
			};
			const args = {
				workspaceId,
				subscriptionId: watch.subscriptionId,
				generation: watch.generation
			};
			watches.add(watch);
			try {
				watch.abort = () => {
					void disposeWatch(watch);
				};
				signal?.addEventListener('abort', watch.abort, { once: true });
				const removeEvent = await transport.listen(fileEventName, (value) => {
					if (!watch.active || signal?.aborted) return;
					try {
						const message = exactRecord(value, ['subscriptionId', 'generation', 'event'], 'watch event');
						if (message.subscriptionId !== watch.subscriptionId || message.generation !== watch.generation) return;
						const event: FileEvent = parseFileEvent(message.event, workspaceId);
						listener(event);
					} catch {
						// Ignore malformed, stale, or cross-workspace events.
					}
				});
				watch.removeEvent = removeEvent;
				if (watch.disposed) removeEvent();
				assertActive();
				const removeError = await transport.listen(fileErrorName, (value) => {
					if (!watch.active || watch.failure) return;
					try {
						const message = exactRecord(value, ['subscriptionId', 'generation', 'failure'], 'watch error');
						if (message.subscriptionId !== watch.subscriptionId || message.generation !== watch.generation) return;
						if (typeof message.failure !== 'string' || !watchFailures.has(message.failure)) return;
						const failure = message.failure as FileWatchFailure;
						watch.failure = failure;
						void disposeWatch(watch, false).then(() => {
							if (watch.suppressFailure || signal?.aborted) return;
							try {
								onError?.(failure);
							} catch {
								// The native and local subscriptions are already closed.
							}
						});
					} catch {
						// Ignore malformed or stale watch errors.
					}
				});
				watch.removeError = removeError;
				if (watch.disposed) removeError();
				const removeResync = await transport.listen(fileResyncName, (value) => {
					if (!watch.active || signal?.aborted || watch.failure) return;
					try {
						const message = exactRecord(
							value,
							['subscriptionId', 'generation', 'reason'],
							'watch resync'
						);
						if (
							message.subscriptionId !== watch.subscriptionId ||
							message.generation !== watch.generation ||
							typeof message.reason !== 'string' ||
							!watchResyncReasons.has(message.reason)
						) {
							return;
						}
						onResync?.(message.reason as FileWatchResyncReason);
					} catch {
						// Ignore malformed, stale, or callback-failing resync notifications.
					}
				});
				watch.removeResync = removeResync;
				if (watch.disposed) removeResync();
				assertActive();
				if (!watch.active) throw new Error('STALE_WORKSPACE');
				watch.startRequested = true;
				watch.starting = Promise.resolve()
					.then(() => transport.invoke(command.watchStart, args))
					.then(() => {});
				await watch.starting;
				if (watch.failure) throw new Error(watch.failure);
				assertActive();
				if (!watch.active) throw new Error('STALE_WORKSPACE');
				return () => {
					void disposeWatch(watch);
				};
			} catch (error) {
				await disposeWatch(watch, watch.failure === null);
				throw error;
			}
		},
		async compile(request: CompileRequest) {
			assertActive();
			const parsed = parseCompileRequest(request);
			const { engine: _engine, ...expected } = parsed;
			const identity = parseCompileIdentity(await transport.invoke(command.startCompile, { request: parsed }), expected);
			let settled = false;
			let cancellation: Promise<void> | null = null;
			const requestCancellation = (): Promise<void> => {
				if (settled) return Promise.resolve();
				if (!cancellation) {
					const pending = Promise.resolve().then(async () => {
						if (!settled) await transport.invoke(command.cancelCompile, { runId: identity.runId });
					});
					cancellation = pending;
					void pending.catch(() => {
						if (cancellation === pending) cancellation = null;
					});
				}
				return cancellation;
			};
			const finished = transport
				.invoke(command.compileResult, { runId: identity.runId })
				.then((result) => {
					assertActive();
					return readCompileResult(result, identity);
				})
				.then(
					(result) => {
						assertActive();
					if (result.status === 'success') {
						compileSynctexBindings.set(result.identity.runId, result.identity);
						while (compileSynctexBindings.size > 128) {
							compileSynctexBindings.delete(compileSynctexBindings.keys().next().value!);
						}
					}
						return result;
					},
					(error: unknown) => {
						assertActive();
						throw error;
					}
				);
			void finished.then(
				() => {
					settled = true;
				},
				() => {
					settled = true;
				}
			);
			void finished.catch(() => {});
			if (signal?.aborted) {
				await requestCancellation();
				assertActive();
			}
			const cancelOnAbort = () => {
				void requestCancellation().catch(() => {});
			};
			signal?.addEventListener('abort', cancelOnAbort, { once: true });
			void finished.finally(() => signal?.removeEventListener('abort', cancelOnAbort)).catch(() => {});
			return { identity, finished, async cancel() { await requestCancellation(); } };
		},
		async takeCompileSynctex(expected) {
			assertActive();
			const bound = compileSynctexBindings.get(expected.runId);
			if (!bound) throw new Error('STALE_WORKSPACE');
			const parsed = parseCompileIdentity(expected, {
				workspaceId: bound.workspaceId,
				entryPath: bound.entryPath,
				documentId: bound.documentId,
				documentVersion: bound.documentVersion,
				savedRevision: bound.savedRevision
			});
			if (!sameCompileIdentity(parsed, bound)) throw new Error('STALE_WORKSPACE');

			// The host artifact is one-shot. Reserve this local binding before awaiting IPC.
			compileSynctexBindings.delete(bound.runId);
			let raw: unknown;
			try {
				raw = await call(command.takeCompileSynctex, { runId: bound.runId });
			} catch (error) {
				assertActive();
				if (isSynctexUnavailable(error)) return null;
				throw error;
			}
			assertActive();
			return toOwnedUint8Array(raw, MAX_PDF_BYTES, 'synctex');
		},
		async getCompileConfig(workspaceId) {
			const result = await call(command.getCompileConfig, { workspaceId });
			return parseCompileConfig(result, workspaceId);
		},
		async updateCompileConfig(request) {
			const parsed = parseCompileConfigUpdate(request);
			const result = await call(command.updateCompileConfig, { request: parsed });
			return parseCompileConfig(result, parsed.workspaceId);
		},
		async closeWorkspace(id) {
			await stopWorkspaceWatches(id);
			await transport.invoke(command.closeWorkspace, { workspaceId: id });
			for (const [runId, identity] of compileSynctexBindings) {
				if (identity.workspaceId === id) compileSynctexBindings.delete(runId);
			}
		}
	};
}

export function tauriDesktopFiles(signal?: AbortSignal): FileDesktopPort | null {
	if (typeof window === 'undefined' || !isTauri()) return null;
	return createTauriFilesAdapter(signal, {
		invoke: (name, args) => invoke<unknown>(name, args),
		listen: async (event, listener) => {
			const unlisten = await listen<unknown>(event, (message) => listener(message.payload));
			return unlisten;
		}
	});
}
