// SPDX-License-Identifier: Apache-2.0
// The narrow Tauri binding for native WorkspaceFiles operations.
import { invoke, isTauri } from '@tauri-apps/api/core';
import { parseFileEntries, relativePath } from '@modutex/frontend-contracts';
import type { FileEntry } from '@modutex/frontend-contracts';

const commands = {
	tree: 'frontend_workspace_files_tree',
	scan: 'frontend_workspace_files_scan',
	search: 'frontend_workspace_files_search',
	cancel: 'frontend_workspace_files_cancel',
	stat: 'frontend_workspace_files_stat',
	createFile: 'frontend_workspace_files_create_file',
	createDirectory: 'frontend_workspace_files_create_directory',
	move: 'frontend_workspace_files_move',
	rename: 'frontend_workspace_files_rename',
	copy: 'frontend_workspace_files_copy',
	recycle: 'frontend_workspace_files_recycle',
	delete: 'frontend_workspace_files_delete',
	undoDelete: 'frontend_workspace_files_undo_delete',
	reveal: 'frontend_workspace_files_reveal'
} as const;

const MAX_TREE_ENTRIES = 4096;
const MAX_SCAN_DEPTH = 64;
const MAX_SEARCH_RESULTS = 256;
const MAX_TEXT_LENGTH = 32767;
const MAX_CREATE_FILE_BYTES = 5 * 1024 * 1024;

export type WorkspaceFileAction =
	| 'stat'
	| 'scan'
	| 'search'
	| 'move'
	| 'rename'
	| 'copy'
	| 'recycle'
	| 'delete'
	| 'reveal';

export interface WorkspaceFileStat {
	readonly path: string;
	readonly kind: 'file' | 'directory';
	readonly sizeBytes: number;
}

export interface WorkspaceFileSearchHit {
	readonly path: string;
	readonly line: number;
	readonly preview: string;
}

export interface WorkspaceFileSearchResult {
	readonly hits: readonly WorkspaceFileSearchHit[];
	readonly truncated: boolean;
}

export interface WorkspaceFileDeleteReceipt {
	readonly token: string;
	readonly expiresInMs: number;
}

export interface WorkspaceFilesTask<T> {
	readonly operationId: string;
	readonly result: Promise<T>;
	cancel(): Promise<void>;
}

export interface WorkspaceFilesPort {
	startTree(workspaceId: string): WorkspaceFilesTask<readonly FileEntry[]>;
	startScan(
		workspaceId: string,
		directory: string,
		maxDepth: number,
		maxEntries: number
	): WorkspaceFilesTask<readonly FileEntry[]>;
	startSearch(
		workspaceId: string,
		directory: string | null,
		query: string,
		maxResults: number
	): WorkspaceFilesTask<WorkspaceFileSearchResult>;
	stat(workspaceId: string, path: string): Promise<WorkspaceFileStat>;
	createFile(workspaceId: string, path: string, bytes: Uint8Array): Promise<WorkspaceFileStat>;
	createDirectory(workspaceId: string, path: string): Promise<WorkspaceFileStat>;
	move(workspaceId: string, source: string, destination: string): Promise<WorkspaceFileStat>;
	rename(workspaceId: string, source: string, destination: string): Promise<WorkspaceFileStat>;
	startCopy(workspaceId: string, source: string, destination: string): WorkspaceFilesTask<WorkspaceFileStat>;
	recycle(workspaceId: string, path: string): Promise<void>;
	delete(workspaceId: string, path: string): Promise<WorkspaceFileDeleteReceipt>;
	undoDelete(workspaceId: string, token: string): Promise<void>;
	reveal(workspaceId: string, path: string): Promise<void>;
}

/** Injection seam for adapter tests; production uses Tauri's official invoke. */
export interface WorkspaceFilesTransport {
	invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

let operationSequence = 0;

function nextOperationId(): string {
	operationSequence = operationSequence >= Number.MAX_SAFE_INTEGER ? 1 : operationSequence + 1;
	return `workspace-files-${Date.now().toString(36)}-${operationSequence.toString(36)}`;
}

function identifier(value: unknown, field: string): string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > 128 ||
		!/^[A-Za-z0-9_-]+$/.test(value)
	) {
		throw new Error(`${field}: invalid identifier`);
	}
	return value;
}

function checkedPath(value: unknown): string {
	return relativePath(value);
}

function boundedInteger(value: number, field: string, minimum: number, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${field}: expected a bounded integer`);
	}
	return value;
}

function exactRecord(value: unknown, fields: readonly string[], field: string): Record<string, unknown> {
	let descriptors: PropertyDescriptorMap;
	let keys: (string | symbol)[];
	try {
		if (
			typeof value !== 'object' ||
			value === null ||
			Array.isArray(value) ||
			![Object.prototype, null].includes(Object.getPrototypeOf(value))
		) {
			throw new Error();
		}
		descriptors = Object.getOwnPropertyDescriptors(value);
		keys = Reflect.ownKeys(value);
	} catch {
		throw new Error(`${field}: expected a plain record`);
	}
	if (
		keys.length !== fields.length ||
		keys.some((key) => typeof key !== 'string' || !fields.includes(key)) ||
		fields.some((key) => !descriptors[key] || !('value' in descriptors[key]!))
	) {
		throw new Error(`${field}: expected exact data fields`);
	}
	const output: Record<string, unknown> = Object.create(null);
	for (const key of fields) output[key] = descriptors[key]!.value;
	return output;
}

function denseArray(value: unknown, maximum: number, field: string): unknown[] {
	let length: number;
	let keys: (string | symbol)[];
	try {
		if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new Error();
		length = value.length;
		keys = Reflect.ownKeys(value);
	} catch {
		throw new Error(`${field}: invalid array length/type`);
	}
	if (!Number.isSafeInteger(length) || length < 0 || length > maximum) {
		throw new Error(`${field}: invalid array length/type`);
	}
	if (keys.length !== length + 1) throw new Error(`${field}: sparse or augmented array`);
	const output: unknown[] = [];
	for (let index = 0; index < length; index++) {
		if (!Object.prototype.hasOwnProperty.call(value, index)) {
			throw new Error(`${field}: missing data element`);
		}
		output.push(value[index]);
	}
	return output;
}

function expectNull(value: unknown, field: string): void {
	if (value !== null) throw new Error(`${field}: expected null`);
}

function entries(value: unknown): readonly FileEntry[] {
	return parseFileEntries(value, MAX_TREE_ENTRIES);
}

function stat(value: unknown, expectedPath: string): WorkspaceFileStat {
	const input = exactRecord(value, ['path', 'kind', 'sizeBytes'], 'file stat');
	const path = checkedPath(input.path);
	if (path !== expectedPath) throw new Error('path: receipt is for another file');
	if (input.kind !== 'file' && input.kind !== 'directory') throw new Error('kind: unknown file kind');
	if (
		typeof input.sizeBytes !== 'number' ||
		!Number.isSafeInteger(input.sizeBytes) ||
		input.sizeBytes < 0
	) {
		throw new Error('sizeBytes: expected a JavaScript-safe integer');
	}
	return Object.freeze({ path, kind: input.kind, sizeBytes: input.sizeBytes });
}

function searchResult(value: unknown): WorkspaceFileSearchResult {
	const input = exactRecord(value, ['hits', 'truncated'], 'search result');
	if (typeof input.truncated !== 'boolean') throw new Error('truncated: expected a boolean');
	const hits = denseArray(input.hits, MAX_SEARCH_RESULTS, 'hits').map((item) => {
		const hit = exactRecord(item, ['path', 'line', 'preview'], 'search hit');
		const path = checkedPath(hit.path);
		if (typeof hit.line !== 'number' || !Number.isSafeInteger(hit.line) || hit.line < 1) {
			throw new Error('line: expected a positive JavaScript-safe integer');
		}
		if (typeof hit.preview !== 'string' || hit.preview.length > 4096) {
			throw new Error('preview: invalid text');
		}
		return Object.freeze({ path, line: hit.line, preview: hit.preview });
	});
	return Object.freeze({ hits: Object.freeze(hits), truncated: input.truncated });
}

function deleteReceipt(value: unknown): WorkspaceFileDeleteReceipt {
	const input = exactRecord(value, ['token', 'expiresInMs'], 'delete receipt');
	const token = identifier(input.token, 'token');
	if (
		typeof input.expiresInMs !== 'number' ||
		!Number.isSafeInteger(input.expiresInMs) ||
		input.expiresInMs < 0
	) {
		throw new Error('expiresInMs: expected a bounded integer');
	}
	return Object.freeze({ token, expiresInMs: input.expiresInMs });
}

export function workspaceFilesScopeMatches(
	currentWorkspaceId: string | null,
	currentGeneration: number,
	expectedWorkspaceId: string,
	expectedGeneration: number,
	signal?: AbortSignal
): boolean {
	return (
		!signal?.aborted &&
		currentWorkspaceId === expectedWorkspaceId &&
		currentGeneration === expectedGeneration
	);
}

export function isWorkspaceFilesCapabilityUnavailable(value: unknown): boolean {
	const message = value instanceof Error ? value.message : String(value);
	return /(?:\bcommand\b.{0,80}(?:unknown|unrecognized|unregistered|not found|not registered|not allowed|not permitted|denied))|(?:(?:unknown|unrecognized|unregistered|not found|not registered|not allowed|not permitted|denied).{0,80}\bcommand\b)|(?:\b(?:permission|capability|acl)\b.{0,80}(?:denied|not allowed|not permitted|unavailable|unknown))/i.test(
		message
	);
}

export function createTauriWorkspaceFilesAdapter(
	signal: AbortSignal | undefined,
	transport: WorkspaceFilesTransport
): WorkspaceFilesPort {
	const assertActive = () => {
		if (signal?.aborted) throw new Error('STALE_WORKSPACE');
	};

	const call = async (name: string, args: Record<string, unknown> = {}): Promise<unknown> => {
		assertActive();
		const result = await transport.invoke(name, args);
		assertActive();
		return result;
	};

	const startTask = <T>(
		name: string,
		workspaceId: string,
		fields: Record<string, unknown>,
		parse: (value: unknown) => T
	): WorkspaceFilesTask<T> => {
		const owner = identifier(workspaceId, 'workspaceId');
		const operationId = nextOperationId();
		const args = { request: { workspaceId: owner, ...fields, operationId } };
		let settled = false;
		let cancellation: Promise<void> | null = null;
		const result = call(name, args)
			.then(parse)
			.finally(() => {
				settled = true;
			});
		void result.catch(() => {});

		return {
			operationId,
			result,
			cancel() {
				if (settled) return Promise.resolve();
				if (!cancellation) {
					const pending = Promise.resolve()
						.then(() =>
							transport.invoke(commands.cancel, {
								request: { workspaceId: owner, operationId }
							})
						)
						.then((value) => expectNull(value, 'cancel'));
					cancellation = pending;
					void pending.catch(() => {
						if (cancellation === pending) cancellation = null;
					});
				}
				return cancellation;
			}
		};
	};

	return {
		startTree(workspaceId) {
			return startTask(commands.tree, workspaceId, {}, entries);
		},
		startScan(workspaceId, directory, maxDepth, maxEntries) {
			return startTask(
				commands.scan,
				workspaceId,
				{
					directory: checkedPath(directory),
					maxDepth: boundedInteger(maxDepth, 'maxDepth', 0, MAX_SCAN_DEPTH),
					maxEntries: boundedInteger(maxEntries, 'maxEntries', 1, MAX_TREE_ENTRIES)
				},
				entries
			);
		},
		startSearch(workspaceId, directory, query, maxResults) {
			if (typeof query !== 'string' || query.length === 0 || query.length > MAX_TEXT_LENGTH) {
				throw new Error('query: invalid text length/type');
			}
			return startTask(
				commands.search,
				workspaceId,
				{
					directory: directory === null ? null : checkedPath(directory),
					query,
					maxResults: boundedInteger(maxResults, 'maxResults', 1, MAX_SEARCH_RESULTS)
				},
				searchResult
			);
		},
		async stat(workspaceId, path) {
			const owner = identifier(workspaceId, 'workspaceId');
			const checked = checkedPath(path);
			return stat(
				await call(commands.stat, { request: { workspaceId: owner, path: checked } }),
				checked
			);
		},
		async createFile(workspaceId, path, bytes) {
			const owner = identifier(workspaceId, 'workspaceId');
			const checked = checkedPath(path);
			if (!(bytes instanceof Uint8Array)) throw new Error('bytes: expected Uint8Array');
			if (bytes.byteLength > MAX_CREATE_FILE_BYTES) throw new Error('bytes: byte limit exceeded');
			const copy = new Uint8Array(bytes);
			return stat(
				await call(commands.createFile, {
					request: { workspaceId: owner, path: checked, bytes: Array.from(copy) }
				}),
				checked
			);
		},
		async createDirectory(workspaceId, path) {
			const owner = identifier(workspaceId, 'workspaceId');
			const checked = checkedPath(path);
			return stat(
				await call(commands.createDirectory, {
					request: { workspaceId: owner, path: checked }
				}),
				checked
			);
		},
		async move(workspaceId, source, destination) {
			const owner = identifier(workspaceId, 'workspaceId');
			const from = checkedPath(source);
			const to = checkedPath(destination);
			return stat(
				await call(commands.move, {
					request: { workspaceId: owner, source: from, destination: to }
				}),
				to
			);
		},
		async rename(workspaceId, source, destination) {
			const owner = identifier(workspaceId, 'workspaceId');
			const from = checkedPath(source);
			const to = checkedPath(destination);
			return stat(
				await call(commands.rename, {
					request: { workspaceId: owner, source: from, destination: to }
				}),
				to
			);
		},
		startCopy(workspaceId, source, destination) {
			const to = checkedPath(destination);
			return startTask(
				commands.copy,
				workspaceId,
				{ source: checkedPath(source), destination: to },
				(value) => stat(value, to)
			);
		},
		async recycle(workspaceId, path) {
			const owner = identifier(workspaceId, 'workspaceId');
			expectNull(
				await call(commands.recycle, {
					request: { workspaceId: owner, path: checkedPath(path) }
				}),
				'recycle'
			);
		},
		async delete(workspaceId, path) {
			const owner = identifier(workspaceId, 'workspaceId');
			return deleteReceipt(
				await call(commands.delete, {
					request: { workspaceId: owner, path: checkedPath(path) }
				})
			);
		},
		async undoDelete(workspaceId, token) {
			expectNull(
				await call(commands.undoDelete, {
					workspaceId: identifier(workspaceId, 'workspaceId'),
					token: identifier(token, 'token')
				}),
				'undoDelete'
			);
		},
		async reveal(workspaceId, path) {
			const owner = identifier(workspaceId, 'workspaceId');
			expectNull(
				await call(commands.reveal, {
					request: { workspaceId: owner, path: checkedPath(path) }
				}),
				'reveal'
			);
		}
	};
}

export function tauriWorkspaceFiles(signal?: AbortSignal): WorkspaceFilesPort | null {
	if (typeof window === 'undefined' || !isTauri()) return null;
	return createTauriWorkspaceFilesAdapter(signal, {
		invoke: (name, args) => invoke<unknown>(name, args)
	});
}
