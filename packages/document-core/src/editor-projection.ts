// Original lossless editor coordinate mapping; no renderer or legacy dependency.
import { SourceDocument } from './source.ts';
import { SourceError } from './utf8.ts';
import type { SourcePatch } from './changes.ts';

export interface EditorPatch {
	readonly from: number;
	readonly to: number;
	/** Editor text uses LF; source insertion uses the document's preferred EOL. */
	readonly insert: string;
}

/** CodeMirror normalizes line breaks; this mapping preserves untouched disk bytes. */
export class EditorProjection {
	readonly document: SourceDocument;
	readonly length: number;
	/** Apply after the requested editor changes, to reflect newly joined CR/LF atoms. */
	readonly editorCorrections: readonly EditorPatch[];
	readonly #crlf: readonly number[];

	private constructor(document: SourceDocument, crlf: readonly number[], corrections: readonly EditorPatch[] = []) {
		this.document = document;
		this.#crlf = Object.freeze([...crlf]);
		this.length = document.length - crlf.length;
		this.editorCorrections = Object.freeze(corrections.map((patch) => Object.freeze({ ...patch })));
		Object.freeze(this);
	}

	static open(document: SourceDocument): { readonly projection: EditorProjection; readonly text: string } {
		const original = document.read();
		const crlf: number[] = [];
		for (let index = 0; index < original.length; index++) {
			if (original[index] === '\r' && original[index + 1] === '\n') {
				crlf.push(index - crlf.length);
				index++;
			}
		}
		return Object.freeze({ projection: new EditorProjection(document, crlf), text: original.replace(/\r\n|\r/g, '\n') });
	}

	toSource(position: number): number {
		if (!Number.isSafeInteger(position) || position < 0 || position > this.length) throw new SourceError('RANGE', 'Invalid editor position');
		let low = 0;
		let high = this.#crlf.length;
		while (low < high) {
			const middle = (low + high) >>> 1;
			if (this.#crlf[middle]! < position) low = middle + 1;
			else high = middle;
		}
		return position + low;
	}

	apply(patches: readonly EditorPatch[], expectedVersion: number): EditorProjection {
		const sourcePatches: SourcePatch[] = patches.map((patch) => {
			if (typeof patch.insert !== 'string' || patch.insert.includes('\r')) throw new SourceError('PATCH', 'Editor insertion must use LF');
			return { from: this.toSource(patch.from), to: this.toSource(patch.to),
				insert: patch.insert.replaceAll('\n', this.document.profile.preferredLineEnding) };
		});
		// Atomic source validation also rejects overlap, stale versions and split surrogate pairs.
		const next = this.document.apply({ expectedVersion, patches: sourcePatches }).document;
		if (next === this.document) return new EditorProjection(next, this.#crlf);
		const crlf: number[] = [];
		let cursor = 0;
		let delta = 0;
		for (const patch of patches) {
			while (cursor < this.#crlf.length && this.#crlf[cursor]! < patch.from) crlf.push(this.#crlf[cursor++]! + delta);
			while (cursor < this.#crlf.length && this.#crlf[cursor]! < patch.to) cursor++;
			if (this.document.profile.preferredLineEnding === '\r\n') {
				for (let index = 0; index < patch.insert.length; index++) {
					if (patch.insert[index] === '\n') crlf.push(patch.from + delta + index);
				}
			}
			delta += patch.insert.length - (patch.to - patch.from);
		}
		while (cursor < this.#crlf.length) crlf.push(this.#crlf[cursor++]! + delta);
		// Only patch boundaries can join two previously distinct newline atoms.
		// Inspect two local code units, not the complete document on every keystroke.
		const joined = new Map<number, number>();
		let sourceDelta = 0;
		let editorDelta = 0;
		const inspect = (sourceBoundary: number, editorBoundary: number) => {
			if (sourceBoundary <= 0 || sourceBoundary >= next.length) return;
			try {
				if (next.read(sourceBoundary - 1, sourceBoundary + 1) === '\r\n') joined.set(sourceBoundary, editorBoundary);
			} catch (error) {
				// A boundary beside a surrogate is not a newline; other failures are real.
				if (!(error instanceof SourceError) || error.code !== 'RANGE') throw error;
			}
		};
		for (let index = 0; index < patches.length; index++) {
			const patch = patches[index]!;
			const sourcePatch = sourcePatches[index]!;
			const sourceFrom = sourcePatch.from + sourceDelta;
			const editorFrom = patch.from + editorDelta;
			inspect(sourceFrom, editorFrom);
			inspect(sourceFrom + sourcePatch.insert.length, editorFrom + patch.insert.length);
			sourceDelta += sourcePatch.insert.length - (sourcePatch.to - sourcePatch.from);
			editorDelta += patch.insert.length - (patch.to - patch.from);
		}
		const removed = [...new Set(joined.values())].sort((a, b) => a - b);
		if (!removed.length) return new EditorProjection(next, crlf);
		const shifted = (position: number) => position - removed.filter((at) => at < position).length;
		const adjusted = [...crlf.map(shifted), ...removed.map((at) => shifted(at - 1))].sort((a, b) => a - b);
		return new EditorProjection(next, adjusted, removed.map((from) => ({ from, to: from + 1, insert: '' })));
	}

	/** Restore both bytes and coordinates; version increases even when undo restores old text. */
	restore(snapshot: EditorProjection): EditorProjection {
		return new EditorProjection(this.document.restore(snapshot.document, this.document.version), snapshot.#crlf);
	}
}
