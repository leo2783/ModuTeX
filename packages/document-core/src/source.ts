// Original ModuTeX implementation. License pending provenance review.
import { byteBoundary, profile, segment, SourceError } from './utf8.ts';
import type { Segment, SourceProfile } from './utf8.ts';
import type { SourceChange, SourcePatch } from './changes.ts';

interface Piece { readonly source: Segment; readonly from: number; readonly to: number }

export interface SourceTransaction {
  readonly expectedVersion: number;
  readonly patches: readonly SourcePatch[];
}

export interface SourceUpdate {
  readonly document: SourceDocument;
  readonly change: SourceChange;
}

function append(target: Piece[], piece: Piece): void {
  if (piece.from === piece.to) return;
  const previous = target.at(-1);
  if (previous?.source === piece.source && previous.to === piece.from) {
    target[target.length - 1] = { source: piece.source, from: previous.from, to: piece.to };
  } else target.push(piece);
}

export class SourceDocument {
  readonly documentId: string;
  readonly version: number;
  readonly length: number;
  readonly byteLength: number;
  readonly profile: SourceProfile;
  readonly #pieces: readonly Piece[];
  readonly #origin: string;

  private constructor(pieces: readonly Piece[], sourceProfile: SourceProfile, version: number, origin: string) {
    this.#pieces = pieces;
    this.#origin = origin;
    this.documentId = origin;
    this.profile = sourceProfile;
    this.version = version;
    this.length = pieces.reduce((total, piece) => total + piece.to - piece.from, 0);
    this.byteLength = pieces.reduce((total, piece) =>
      total + byteBoundary(piece.source, piece.to) - byteBoundary(piece.source, piece.from), sourceProfile.bom ? 3 : 0);
    Object.freeze(this);
  }

  static open(input: Uint8Array): SourceDocument {
    // Own the bytes: callers may mutate/transfer their IPC input after opening.
    const bytes = new Uint8Array(input);
    const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const body = bom ? bytes.subarray(3) : bytes;
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body);
    } catch {
      throw new SourceError('ENCODING', 'Source is not valid UTF-8; no conversion performed');
    }
    const source = segment(text, body);
    return new SourceDocument(text.length ? [{ source, from: 0, to: text.length }] : [],
      profile(text, bom), 0, crypto.randomUUID());
  }

  get pieceCount(): number { return this.#pieces.length; }

  #range(from: number, to: number): void {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from || to > this.length) {
      throw new SourceError('RANGE', 'Range outside source');
    }
  }

  #boundary(position: number): void {
    let cursor = 0;
    for (const piece of this.#pieces) {
      const end = cursor + piece.to - piece.from;
      if (position <= end) {
        byteBoundary(piece.source, piece.from + position - cursor);
        return;
      }
      cursor = end;
    }
  }

  #slice(from: number, to: number): Piece[] {
    const result: Piece[] = [];
    let cursor = 0;
    for (const piece of this.#pieces) {
      const end = cursor + piece.to - piece.from;
      if (cursor >= to) break;
      if (end > from) {
        append(result, {
          source: piece.source,
          from: piece.from + Math.max(0, from - cursor),
          to: piece.from + Math.min(end, to) - cursor
        });
      }
      cursor = end;
    }
    return result;
  }

  read(from = 0, to = this.length): string {
    this.#range(from, to);
    this.#boundary(from);
    this.#boundary(to);
    return this.#slice(from, to).map(piece => piece.source.text.slice(piece.from, piece.to)).join('');
  }

  // Saving/compiling is explicit. Keystrokes never call this serializer.
  toBytes(): Uint8Array {
    const output = new Uint8Array(this.byteLength);
    let cursor = 0;
    if (this.profile.bom) { output.set([0xef, 0xbb, 0xbf]); cursor = 3; }
    for (const piece of this.#pieces) {
      const from = byteBoundary(piece.source, piece.from);
      const to = byteBoundary(piece.source, piece.to);
      output.set(piece.source.bytes.subarray(from, to), cursor);
      cursor += to - from;
    }
    return output;
  }

  #expectVersion(version: number): void {
    if (version !== this.version) throw new SourceError('VERSION', 'Transaction source version is stale');
  }

  apply(transaction: SourceTransaction): SourceUpdate {
    this.#expectVersion(transaction.expectedVersion);
    const active: SourcePatch[] = [];
    let previousFrom = -1;
    let previousTo = -1;
    // Validate the whole transaction before producing a new immutable snapshot.
    for (const candidate of transaction.patches) {
      this.#range(candidate.from, candidate.to);
      this.#boundary(candidate.from);
      this.#boundary(candidate.to);
      if (candidate.from <= previousFrom || candidate.from < previousTo) {
        throw new SourceError('PATCH', 'Patches must be ordered, non-overlapping, and unambiguous');
      }
      previousFrom = candidate.from;
      previousTo = candidate.to;
      if (typeof candidate.insert !== 'string') throw new SourceError('PATCH', 'Insertion must be text');
      const existing = this.read(candidate.from, candidate.to);
      if (candidate.expected !== undefined && candidate.expected !== existing) {
        throw new SourceError('CONTENT', 'Patch expected content does not match');
      }
      if (existing !== candidate.insert) active.push(Object.freeze({ ...candidate }));
    }
    if (!active.length) return this.#update(this, []);
    const pieces: Piece[] = [];
    let cursor = 0;
    for (const patch of active) {
      for (const piece of this.#slice(cursor, patch.from)) append(pieces, piece);
      if (patch.insert.length) {
        const source = segment(patch.insert);
        append(pieces, { source, from: 0, to: source.text.length });
      }
      cursor = patch.to;
    }
    for (const piece of this.#slice(cursor, this.length)) append(pieces, piece);
    const document = new SourceDocument(pieces, this.profile, this.#nextVersion(), this.#origin);
    return this.#update(document, active);
  }

  #nextVersion(): number {
    if (this.version === Number.MAX_SAFE_INTEGER) throw new SourceError('VERSION', 'Version exhausted');
    return this.version + 1;
  }

  #update(document: SourceDocument, patches: SourcePatch[]): SourceUpdate {
    const change: SourceChange = Object.freeze({
      documentId: this.documentId,
      beforeVersion: this.version, afterVersion: document.version,
      oldLength: this.length, newLength: document.length,
      patches: Object.freeze(patches)
    });
    return Object.freeze({ document, change });
  }

  // Undo/redo restores shared pieces but advances the current version, so an
  // old worker result cannot become current merely because undo was performed.
  restore(snapshot: SourceDocument, expectedVersion: number): SourceDocument {
    this.#expectVersion(expectedVersion);
    if (snapshot.#origin !== this.#origin) throw new SourceError('ORIGIN', 'Snapshot is from another source');
    return new SourceDocument(snapshot.#pieces, this.profile, this.#nextVersion(), this.#origin);
  }

  acceptCurrent<T>(result: { readonly documentId: string; readonly version: number; readonly value: T }): T | null {
    return result.documentId === this.documentId && result.version === this.version ? result.value : null;
  }
}
