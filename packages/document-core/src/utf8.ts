// Original ModuTeX implementation. License pending provenance review.
export type LineEnding = '\n' | '\r\n' | '\r';

export interface SourceProfile {
  readonly encoding: 'utf-8';
  readonly bom: boolean;
  readonly preferredLineEnding: LineEnding;
  readonly originalLineEndings: Readonly<{ lf: number; crlf: number; cr: number }>;
}

export class SourceError extends Error {
  readonly code: 'ENCODING' | 'RANGE' | 'VERSION' | 'PATCH' | 'CONTENT' | 'ORIGIN';

  constructor(code: SourceError['code'], message: string) {
    super(message);
    this.name = 'SourceError';
    this.code = code;
  }
}

export interface Segment {
  readonly text: string;
  readonly bytes: Uint8Array;
  readonly offsets: Uint32Array;
}

const splitSurrogate = 0xffffffff;

// Build once per original/input segment; patches index boundaries without
// re-encoding the untouched prefix of a large document.
export function segment(text: string, bytes?: Uint8Array): Segment {
  const offsets = new Uint32Array(text.length + 1);
  let byteOffset = 0;
  for (let position = 0; position < text.length; position++) {
    const unit = text.charCodeAt(position);
    offsets[position] = byteOffset;
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = text.charCodeAt(position + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) {
        throw new SourceError('ENCODING', 'Unpaired high surrogate');
      }
      offsets[++position] = splitSurrogate;
      byteOffset += 4;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new SourceError('ENCODING', 'Unpaired low surrogate');
    } else {
      byteOffset += unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
    }
  }
  offsets[text.length] = byteOffset;
  return { text, bytes: bytes ?? new TextEncoder().encode(text), offsets };
}

export function byteBoundary(source: Segment, position: number): number {
  const offset = source.offsets[position];
  if (offset === undefined || offset === splitSurrogate) {
    throw new SourceError('RANGE', 'Position splits a Unicode scalar value');
  }
  return offset;
}

export function profile(text: string, bom: boolean): SourceProfile {
  const counts = { lf: 0, crlf: 0, cr: 0 };
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r') {
      if (text[i + 1] === '\n') { counts.crlf++; i++; }
      else counts.cr++;
    } else if (text[i] === '\n') counts.lf++;
  }
  const preferredLineEnding: LineEnding =
    counts.crlf > counts.lf && counts.crlf >= counts.cr ? '\r\n' :
    counts.cr > counts.lf && counts.cr > counts.crlf ? '\r' : '\n';
  return Object.freeze({
    encoding: 'utf-8', bom, preferredLineEnding,
    originalLineEndings: Object.freeze(counts)
  });
}
