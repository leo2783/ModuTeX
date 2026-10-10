import { SourceDocument, parseSource, type SourcePatch, type SourceProjection } from '@modutex/document-core';

export type ParserRequest =
	| { readonly kind: 'reset'; readonly seq: number; readonly documentId: string; readonly version: number; readonly bytes: Uint8Array }
	| { readonly kind: 'patch'; readonly seq: number; readonly documentId: string; readonly expectedVersion: number; readonly version: number; readonly patches: readonly SourcePatch[] }
	| { readonly kind: 'parse'; readonly seq: number; readonly documentId: string; readonly version: number };
export type ParserReply =
	| { readonly kind: 'ack'; readonly seq: number }
	| { readonly kind: 'projection'; readonly seq: number; readonly projection: SourceProjection }
	| { readonly kind: 'error'; readonly seq: number };

/** Executes only inside a worker; source bytes are owned here after initialization. */
export class ParserEngine {
	private source: SourceDocument | null = null;
	private documentId = '';
	private version = -1;
	handle(request: ParserRequest): ParserReply {
		try {
			if (!Number.isSafeInteger(request.seq) || request.seq < 1 || typeof request.documentId !== 'string' ||
				!request.documentId || request.documentId.length > 128 || !Number.isSafeInteger(request.version) || request.version < 0) throw new Error('REQUEST');
			if (request.kind === 'reset') {
				if (!(request.bytes instanceof Uint8Array) || !(request.bytes.buffer instanceof ArrayBuffer) || request.bytes.byteLength > 5 * 1024 * 1024 ||
					(request.documentId === this.documentId && request.version < this.version)) throw new Error('REQUEST');
				const next = SourceDocument.open(request.bytes);
				this.source = next; this.documentId = request.documentId; this.version = request.version;
			} else {
				if (!this.source || request.documentId !== this.documentId) throw new Error('STALE');
				if (request.kind === 'patch') {
					if (request.expectedVersion !== this.version || !Array.isArray(request.patches) || request.patches.length > 256) throw new Error('STALE');
					let inserted = 0;
					for (const patch of request.patches) {
						if (typeof patch.insert !== 'string') throw new Error('REQUEST');
						inserted += patch.insert.length;
					}
					if (inserted > 5 * 1024 * 1024) throw new Error('LIMIT');
					const next = this.source.apply({ expectedVersion: this.source.version, patches: request.patches }).document;
					if (next.byteLength > 5 * 1024 * 1024 || request.version !== this.version + (next === this.source ? 0 : 1)) throw new Error('VERSION');
					this.source = next; this.version = request.version;
				} else if (request.kind === 'parse') {
					if (request.version !== this.version) throw new Error('STALE');
					const source = this.source;
					return { kind: 'projection', seq: request.seq, projection: parseSource({ documentId: this.documentId,
						version: this.version, read: () => source.read() }) };
				} else throw new Error('REQUEST');
			}
			return { kind: 'ack', seq: request.seq };
		} catch { return { kind: 'error', seq: request?.seq ?? 0 }; }
	}
}
