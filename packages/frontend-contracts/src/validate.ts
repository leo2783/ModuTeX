// Original ModuTeX implementation. License pending provenance review.
import type {
	CompileIdentity,
	CompileRequest,
	CompileResult,
	Diagnostic,
	FileEntry,
	FileEvent,
	FileRef,
	ReadReceipt,
	WorkspaceInfo,
	WriteReceipt,
	WriteRequest
} from './types.ts';
import type { SaveAsRequest, SaveAsReceipt } from './types.ts';
import type { RecentDocument } from './types.ts';

export class ContractError extends Error {
	readonly field: string;
	constructor(field: string, reason: string) {
		super(field + ': ' + reason);
		this.name = 'ContractError';
		this.field = field;
	}
}

function record(value: unknown, fields: readonly string[], field = 'payload'): Record<string, unknown> {
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		![Object.prototype, null].includes(Object.getPrototypeOf(value))
	) {
		throw new ContractError(field, 'Expected a plain record');
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const keys = Reflect.ownKeys(value);
	if (
		keys.length !== fields.length ||
		keys.some((key) => typeof key !== 'string' || !fields.includes(key)) ||
		fields.some((key) => !descriptors[key] || !('value' in descriptors[key]!))
	) {
		throw new ContractError(field, 'Expected exact data fields, without accessors or extra keys');
	}
	return value as Record<string, unknown>;
}

function text(value: unknown, field: string, maximum = 32767, allowEmpty = false): string {
	if (typeof value !== 'string' || value.length > maximum || (!allowEmpty && value.length === 0)) {
		throw new ContractError(field, 'Invalid text length/type');
	}
	return value;
}

function id(value: unknown, field: string): string {
	const result = text(value, field, 128);
	if (!/^[A-Za-z0-9_-]+$/.test(result)) throw new ContractError(field, 'Invalid opaque identifier');
	return result;
}

function revision(value: unknown): string {
	const result = text(value, 'revision', 256);
	if (!/^[A-Za-z0-9:_-]+$/.test(result)) throw new ContractError('revision', 'Invalid disk revision');
	return result;
}

function integer(value: unknown, field: string, minimum: number): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
		throw new ContractError(field, 'Expected a bounded integer');
	}
	return value;
}

export function relativePath(value: unknown): string {
	const path = text(value, 'path');
	if (/[\\\\:\x00-\x1f\x7f]/.test(path) || path.startsWith('/')) {
		throw new ContractError('path', 'Only workspace-relative filesystem paths are accepted');
	}
	for (const part of path.split('/')) {
		if (!part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part)) {
			throw new ContractError('path', 'Unsafe or ambiguous path segment');
		}
	}
	return path;
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const nativeByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!.get!;
const nativeBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')!.get!;
const nativeTag = Object.getOwnPropertyDescriptor(typedArrayPrototype, Symbol.toStringTag)!.get!;
const nativeArrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!;
const nativeSet = Uint8Array.prototype.set;

function copyBytes(value: unknown, maximum: number, field: string): Uint8Array {
	integer(maximum, field + '.limit', 1);
	if (!ArrayBuffer.isView(value) || nativeTag.call(value) !== 'Uint8Array') {
		throw new ContractError(field, 'Expected a byte array within the caller-specified limit');
	}
	try {
		const length: number = nativeByteLength.call(value);
		// Reject shared backing storage; no getters/iterators from the payload run.
		nativeArrayBufferLength.call(nativeBuffer.call(value));
		if (length > maximum) throw new ContractError(field, 'Byte limit exceeded');
		const output = new Uint8Array(length);
		nativeSet.call(output, value as Uint8Array);
		return output;
	} catch (error) {
		if (error instanceof ContractError) throw error;
		throw new ContractError(field, 'Unavailable or shared byte storage');
	}
}

function dataArray(value: unknown, maximum: number, field: string): unknown[] {
	integer(maximum, field + '.limit', 1);
	if (!Array.isArray(value) || value.length > maximum) throw new ContractError(field, 'Invalid array length/type');
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (Reflect.ownKeys(value).length !== value.length + 1) throw new ContractError(field, 'Sparse or augmented array');
	const output: unknown[] = [];
	for (let i = 0; i < value.length; i++) {
		const descriptor = descriptors[String(i)];
		if (!descriptor || !('value' in descriptor)) throw new ContractError(field, 'Missing data element or accessor');
		output.push(descriptor.value);
	}
	return output;
}

export function recentDocumentId(value: unknown): string {
	const result = text(value, 'recent.id', 36);
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result)) throw new ContractError('recent.id', 'Invalid recent-document identifier');
	return result;
}

export function parseRecentDocuments(value: unknown): readonly RecentDocument[] {
	if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) throw new ContractError('recent', 'Expected a plain data array');
	const ids = new Set<string>();
	const entries = dataArray(value, 20, 'recent').map((value) => {
		const input = record(value, ['id', 'label', 'entryPath', 'openedAt'], 'recent.entry');
		const id = recentDocumentId(input.id);
		if (ids.has(id)) throw new ContractError('recent.id', 'Duplicate identifier');
		ids.add(id);
		const label = text(input.label, 'recent.label', 4096);
		if (/[\x00-\x1f\x7f\/\\]/.test(label)) throw new ContractError('recent.label', 'Expected a display name, not a path');
		let entryPath: string | null = null;
		if (input.entryPath !== null) {
			entryPath = relativePath(text(input.entryPath, 'recent.entryPath', 4096));
			if (entryPath.includes('/') || !entryPath.toLowerCase().endsWith('.tex')) throw new ContractError('recent.entryPath', 'Expected a single TeX filename');
		}
		return Object.freeze({ id, label, entryPath, openedAt: integer(input.openedAt, 'recent.openedAt', 0) });
	});
	return Object.freeze(entries);
}

export function parseWorkspaceInfo(value: unknown): WorkspaceInfo | null {
	if (value === null) return null;
	const input = record(value, ['id', 'label', 'entryPath']);
	return Object.freeze({
		id: id(input.id, 'workspaceId'),
		label: text(input.label, 'label'),
		entryPath: input.entryPath === null ? null : relativePath(input.entryPath)
	});
}

export function parseFileEntries(value: unknown, maximum: number): readonly FileEntry[] {
	const seen = new Set<string>();
	const entries = dataArray(value, maximum, 'files').map((item) => {
		const input = record(item, ['path', 'kind'], 'file');
		const path = relativePath(input.path);
		if (input.kind !== 'file' && input.kind !== 'directory') throw new ContractError('kind', 'Unknown file kind');
		if (seen.has(path)) throw new ContractError('path', 'Duplicate file entry');
		seen.add(path);
		return Object.freeze({ path, kind: input.kind });
	});
	return Object.freeze(entries);
}

export function parseFileEvent(value: unknown, workspaceId: string): FileEvent {
	const input = record(value, ['workspaceId', 'path', 'kind']);
	const ref = file(input);
	if (ref.workspaceId !== workspaceId) throw new ContractError('workspaceId', 'Event is from another workspace');
	if (input.kind !== 'changed' && input.kind !== 'removed') throw new ContractError('kind', 'Unknown file event');
	return Object.freeze({ ...ref, kind: input.kind });
}

function file(value: Record<string, unknown>): FileRef {
	return { workspaceId: id(value.workspaceId, 'workspaceId'), path: relativePath(value.path) };
}

function matchFile(actual: FileRef, expected: FileRef): void {
	if (actual.workspaceId !== expected.workspaceId || actual.path !== expected.path) {
		throw new ContractError('file', 'Receipt is for another file/workspace');
	}
}

export function parseReadReceipt(value: unknown, expected: FileRef, maxFileBytes: number): ReadReceipt {
	const input = record(value, ['workspaceId', 'path', 'bytes', 'revision']);
	const ref = file(input);
	matchFile(ref, expected);
	return Object.freeze({ ...ref, bytes: copyBytes(input.bytes, maxFileBytes, 'bytes'), revision: revision(input.revision) });
}

export function parseWriteRequest(value: unknown, maxFileBytes: number): WriteRequest {
	const input = record(value, ['workspaceId', 'path', 'bytes', 'expectedRevision', 'documentId', 'documentVersion']);
	return Object.freeze({
		...file(input),
		bytes: copyBytes(input.bytes, maxFileBytes, 'bytes'),
		expectedRevision: input.expectedRevision === null ? null : revision(input.expectedRevision),
		documentId: id(input.documentId, 'documentId'),
		documentVersion: integer(input.documentVersion, 'documentVersion', 0)
	});
}

export function parseWriteReceipt(value: unknown, expected: WriteRequest): WriteReceipt {
	const input = record(value, ['workspaceId', 'path', 'revision', 'documentId', 'documentVersion']);
	const ref = file(input);
	matchFile(ref, expected);
	const documentId = id(input.documentId, 'documentId');
	const documentVersion = integer(input.documentVersion, 'documentVersion', 0);
	if (documentId !== expected.documentId || documentVersion !== expected.documentVersion) {
		throw new ContractError('documentVersion', 'Receipt is for another document snapshot');
	}
	return Object.freeze({ ...ref, revision: revision(input.revision), documentId, documentVersion });
}

export function parseSaveAsRequest(value: unknown, maximum: number): SaveAsRequest {
	const input = record(value, ['workspaceId', 'bytes', 'documentId', 'documentVersion']);
	return Object.freeze({ workspaceId: input.workspaceId === null ? null : id(input.workspaceId, 'workspaceId'),
		bytes: copyBytes(input.bytes, maximum, 'bytes'), documentId: id(input.documentId, 'documentId'),
		documentVersion: integer(input.documentVersion, 'documentVersion', 0) });
}
export function parseSaveAsReceipt(value: unknown, expected: SaveAsRequest): SaveAsReceipt | null {
	if (value === null) return null;
	const input = record(value, ['workspace', 'write']);
	const workspace = parseWorkspaceInfo(input.workspace);
	if (!workspace || !workspace.entryPath) throw new ContractError('workspace', 'Missing saved entry');
	const write = parseWriteReceipt(input.write, { workspaceId: workspace.id, path: workspace.entryPath,
		bytes: expected.bytes, expectedRevision: null, documentId: expected.documentId, documentVersion: expected.documentVersion });
	return Object.freeze({ workspace, write });
}

export function parseCompileRequest(value: unknown): CompileRequest {
	const input = record(value, ['workspaceId', 'entryPath', 'documentId', 'documentVersion', 'savedRevision', 'engine']);
	if (input.engine !== 'managed' && input.engine !== 'system') throw new ContractError('engine', 'Unknown engine');
	return Object.freeze({
		workspaceId: id(input.workspaceId, 'workspaceId'),
		entryPath: relativePath(input.entryPath),
		documentId: id(input.documentId, 'documentId'),
		documentVersion: integer(input.documentVersion, 'documentVersion', 0),
		savedRevision: revision(input.savedRevision),
		engine: input.engine
	});
}

const identityFields = ['runId', 'workspaceId', 'entryPath', 'documentId', 'documentVersion', 'savedRevision'] as const;
function identity(value: unknown, expected: CompileIdentity): CompileIdentity {
	const input = record(value, identityFields, 'identity');
	const result: CompileIdentity = {
		runId: id(input.runId, 'runId'),
		workspaceId: id(input.workspaceId, 'workspaceId'),
		entryPath: relativePath(input.entryPath),
		documentId: id(input.documentId, 'documentId'),
		documentVersion: integer(input.documentVersion, 'documentVersion', 0),
		savedRevision: revision(input.savedRevision)
	};
	if (identityFields.some((field) => result[field] !== expected[field])) {
		throw new ContractError('identity', 'Result is for another compilation or saved snapshot');
	}
	return Object.freeze(result);
}

export function parseCompileIdentity(value: unknown, expected: Omit<CompileIdentity, 'runId'>): CompileIdentity {
	const input = record(value, identityFields, 'identity');
	return identity(input, { ...expected, runId: id(input.runId, 'runId') });
}

function diagnostic(value: unknown): Diagnostic {
	const input = record(value, ['severity', 'message', 'path', 'line', 'column'], 'diagnostic');
	if (input.severity !== 'error' && input.severity !== 'warning' && input.severity !== 'info')
		throw new ContractError('severity', 'Unknown severity');
	const path = input.path === null ? null : relativePath(input.path);
	const line = input.line === null ? null : integer(input.line, 'line', 1);
	const column = input.column === null ? null : integer(input.column, 'column', 1);
	if ((line !== null && path === null) || (column !== null && line === null)) {
		throw new ContractError('location', 'Incomplete diagnostic location');
	}
	return Object.freeze({
		severity: input.severity as Diagnostic['severity'],
		message: text(input.message, 'message'),
		path,
		line,
		column
	});
}

export interface CompileLimits {
	readonly maxPdfBytes: number;
	readonly maxLogCharacters: number;
	readonly maxDiagnostics: number;
}

export function parseCompileResult(value: unknown, expected: CompileIdentity, limits: CompileLimits): CompileResult {
	integer(limits.maxLogCharacters, 'log.limit', 1);
	integer(limits.maxDiagnostics, 'diagnostics.limit', 1);
	integer(limits.maxPdfBytes, 'pdf.limit', 1);
	if (typeof value !== 'object' || value === null) throw new ContractError('payload', 'Expected a record');
	const statusDescriptor = Object.getOwnPropertyDescriptor(value, 'status');
	if (!statusDescriptor || !('value' in statusDescriptor)) throw new ContractError('status', 'Expected a data field');
	const status = statusDescriptor.value;
	if (status !== 'success' && status !== 'failure' && status !== 'cancelled') throw new ContractError('status', 'Unknown compile status');
	const input = record(
		value,
		status === 'success' ? ['status', 'identity', 'pdf', 'log', 'diagnostics'] : ['status', 'identity', 'log', 'diagnostics']
	);
	const result = {
		identity: identity(input.identity, expected),
		log: text(input.log, 'log', limits.maxLogCharacters, true),
		diagnostics: Object.freeze(dataArray(input.diagnostics, limits.maxDiagnostics, 'diagnostics').map(diagnostic))
	};
	if (status !== 'success') return Object.freeze({ ...result, status });
	const pdf = copyBytes(input.pdf, limits.maxPdfBytes, 'pdf');
	if (pdf.length < 5 || ![0x25, 0x50, 0x44, 0x46, 0x2d].every((byte, i) => pdf[i] === byte)) {
		throw new ContractError('pdf', 'Missing PDF header');
	}
	return Object.freeze({ ...result, status, pdf });
}
