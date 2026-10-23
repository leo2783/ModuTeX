// SPDX-License-Identifier: Apache-2.0
import { relativePath } from '@modutex/frontend-contracts';
import type { CompileIdentity } from '@modutex/frontend-contracts';
import { SynctexIndex } from '../document-core/core.ts';

const MAX_SYNCTEX_BYTES = 32 * 1024 * 1024;
const MAX_U32 = 0xffff_ffff;
const MAX_COORDINATE = 1_000_000_000_000;

export interface SynctexPdfLocation {
	readonly page: number;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly depth: number;
}

export interface SynctexSourceLocation {
	readonly path: string;
	readonly line: number;
	readonly column: number | null;
}

export interface SynctexPdfNavigation {
	readonly identity: CompileIdentity;
	readonly sequence: number;
	readonly location: SynctexPdfLocation;
}

export interface SynctexPdfPoint {
	readonly identity: CompileIdentity;
	readonly page: number;
	readonly x: number;
	readonly y: number;
}

export function sameCompileIdentity(
	left: CompileIdentity | null | undefined,
	right: CompileIdentity | null | undefined
): boolean {
	return !!left && !!right &&
		left.runId === right.runId &&
		left.workspaceId === right.workspaceId &&
		left.entryPath === right.entryPath &&
		left.documentId === right.documentId &&
		left.documentVersion === right.documentVersion &&
		left.savedRevision === right.savedRevision;
}

function jsonRecord(
	value: unknown,
	required: readonly string[],
	optional: readonly string[] = []
): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype) {
		throw new Error('SYNC_TEX_INVALID');
	}
	const keys = Reflect.ownKeys(value);
	const allowed = [...required, ...optional];
	if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) ||
		required.some((key) => !Object.hasOwn(value, key))) {
		throw new Error('SYNC_TEX_INVALID');
	}
	return value as Record<string, unknown>;
}

function positiveU32(value: unknown): number {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_U32) {
		throw new Error('SYNC_TEX_INVALID');
	}
	return value;
}

function coordinate(value: unknown): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > MAX_COORDINATE) {
		throw new Error('SYNC_TEX_INVALID');
	}
	return value;
}

function workspaceRelativePath(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	if (value.startsWith('/') || /^[A-Za-z]:/.test(value)) return null;
	try {
		return relativePath(value);
	} catch {
		return null;
	}
}

/** Owns one bounded WASM index and its bytes so it can be rebuilt after view teardown. */
export class BoundSynctexIndex {
	readonly identity: CompileIdentity;
	private bytes: Uint8Array | null;
	private index: SynctexIndex | null = null;

	constructor(identity: CompileIdentity, bytes: Uint8Array) {
		if (!(bytes instanceof Uint8Array) || !(bytes.buffer instanceof ArrayBuffer) ||
			bytes.byteLength > MAX_SYNCTEX_BYTES) {
			throw new Error('SYNC_TEX_INVALID');
		}
		this.identity = Object.freeze({
			runId: identity.runId,
			workspaceId: identity.workspaceId,
			entryPath: identity.entryPath,
			documentId: identity.documentId,
			documentVersion: identity.documentVersion,
			savedRevision: identity.savedRevision
		});
		this.bytes = bytes;
		try {
			this.index = SynctexIndex.parse(bytes);
		} catch (error) {
			this.bytes = null;
			bytes.fill(0);
			throw error;
		}
	}

	get isReady(): boolean {
		return this.index !== null;
	}

	resume(): void {
		if (this.index) return;
		if (!this.bytes) throw new Error('SYNC_TEX_UNAVAILABLE');
		this.index = SynctexIndex.parse(this.bytes);
	}

	suspend(): void {
		const index = this.index;
		this.index = null;
		index?.free();
	}

	dispose(): void {
		this.suspend();
		this.bytes?.fill(0);
		this.bytes = null;
	}

	forwardSearch(line: number, pageHint: number | null = null, sourcePath: string = this.identity.entryPath): SynctexPdfLocation | null {
		if (!Number.isSafeInteger(line) || line < 1 || line > MAX_U32 ||
			(pageHint !== null && (!Number.isSafeInteger(pageHint) || pageHint < 1 || pageHint > MAX_U32))) {
			throw new Error('INVALID_INPUT');
		}
		const path = workspaceRelativePath(sourcePath);
		if (!path) throw new Error('INVALID_INPUT');
		const index = this.requireIndex();
		const value: unknown = JSON.parse(index.forwardSearch(path, line, pageHint));
		if (value === null) return null;
		const input = jsonRecord(value, ['page', 'x', 'y', 'width', 'height', 'depth']);
		const width = coordinate(input.width);
		const height = coordinate(input.height);
		const depth = coordinate(input.depth);
		if (width < 0 || height < 0 || depth < 0) throw new Error('SYNC_TEX_INVALID');
		return Object.freeze({
			page: positiveU32(input.page),
			x: coordinate(input.x),
			y: coordinate(input.y),
			width,
			height,
			depth
		});
	}

	inverseSearch(page: number, x: number, y: number): SynctexSourceLocation | null {
		if (!Number.isSafeInteger(page) || page < 1 || page > MAX_U32 ||
			!Number.isFinite(x) || !Number.isFinite(y) ||
			Math.abs(x) > MAX_COORDINATE || Math.abs(y) > MAX_COORDINATE) {
			throw new Error('INVALID_INPUT');
		}
		const index = this.requireIndex();
		const value: unknown = JSON.parse(index.inverseSearch(page, x, y));
		if (value === null) return null;
		const input = jsonRecord(value, ['path', 'line'], ['column']);
		const path = workspaceRelativePath(input.path);
		if (!path) throw new Error('SYNC_TEX_INVALID');
		let column: number | null = null;
		if (Object.hasOwn(input, 'column') && input.column !== null) column = positiveU32(input.column);
		return Object.freeze({ path, line: positiveU32(input.line), column });
	}

	private requireIndex(): SynctexIndex {
		if (!this.index) throw new Error('SYNC_TEX_INACTIVE');
		return this.index;
	}
}
