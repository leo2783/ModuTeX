// Original ModuTeX implementation. License pending provenance review.
import { SourceError } from './utf8.ts';

export interface SourcePatch {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
  readonly expected?: string;
}

export interface SourceSpan {
  readonly documentId: string;
  readonly from: number;
  readonly to: number;
  readonly version: number;
}

export interface SourceChange {
  readonly documentId: string;
  readonly beforeVersion: number;
  readonly afterVersion: number;
  readonly oldLength: number;
  readonly newLength: number;
  readonly patches: readonly SourcePatch[];
}

export function mapPosition(change: SourceChange, position: number, bias: 'before' | 'after' = 'after'): number {
  if (!Number.isSafeInteger(position) || position < 0 || position > change.oldLength) {
    throw new SourceError('RANGE', 'Position outside previous source');
  }
  let delta = 0;
  for (const patch of change.patches) {
    if (position < patch.from) break;
    if (position === patch.from) {
      return patch.from + delta + (bias === 'after' ? patch.insert.length : 0);
    }
    if (position < patch.to) {
      return patch.from + delta + (bias === 'after' ? patch.insert.length : 0);
    }
    delta += patch.insert.length - (patch.to - patch.from);
  }
  return position + delta;
}

// Untouched nodes retain anchors; changed nodes must be parsed again.
export function remapSpan(change: SourceChange, span: SourceSpan): SourceSpan | null {
  if (span.documentId !== change.documentId || span.version !== change.beforeVersion) {
    throw new SourceError('VERSION', 'Span belongs to another source version');
  }
  if (!Number.isSafeInteger(span.from) || !Number.isSafeInteger(span.to) ||
      span.from < 0 || span.to < span.from || span.to > change.oldLength) {
    throw new SourceError('RANGE', 'Invalid span');
  }
  for (const patch of change.patches) {
    const touches = patch.from === patch.to
      ? patch.from > span.from && patch.from < span.to
      : patch.from < span.to && patch.to > span.from;
    if (touches) return null;
  }
  return Object.freeze({
    documentId: span.documentId,
    from: mapPosition(change, span.from, 'after'),
    to: mapPosition(change, span.to, span.from === span.to ? 'after' : 'before'),
    version: change.afterVersion
  });
}
