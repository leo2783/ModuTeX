import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceDocument, SourceError, mapPosition, remapSpan } from '../src/index.ts';

const encoder = new TextEncoder();
const bytes = (text: string, bom = false) => {
  const body = encoder.encode(text);
  return bom ? Uint8Array.from([0xef, 0xbb, 0xbf, ...body]) : body;
};
const open = (text: string, bom = false) => SourceDocument.open(bytes(text, bom));
const error = (code: SourceError['code']) => (value: unknown) => value instanceof SourceError && value.code === code;
const replace = (document: SourceDocument, from: number, to: number, insert: string) =>
  document.apply({ expectedVersion: document.version, patches: [{ from, to, insert }] });

const corpus = [
  '',
  '% original fixture: comments and whitespace\n\n  ',
  '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n',
  '\\newcommand{\\unrecognized}[2]{#2#1}% keep me\n\\unrecognized{a}{b}\n',
  '\\begin{unknownEnvironment}[ odd = value ]\n{opaque \\macro}% comment\n\\end{unknownEnvironment}',
  '\\verb|% { } \\|\n\\begin{verbatim}\n\\notAnInstruction{}\n\\end{verbatim}',
  '中文與 emoji 😀、e\u0301、\u0000，保留空格。\n',
  '\\begin{tabular}{lr}\nA & B \\\\ \n\\hline\n1 & 2 \\\\ \n\\end{tabular}\n',
  '\\catcode\`\\%=12\n% source is opaque to the byte buffer\n'
];

for (const [fixture, text] of corpus.entries()) {
  for (const eol of ['\n', '\r\n', '\r']) {
    for (const bom of [false, true]) {
      test(`byte-identical fixture ${fixture}, EOL ${JSON.stringify(eol)}, BOM ${bom}`, () => {
        const original = bytes(text.replaceAll('\n', eol), bom);
        const document = SourceDocument.open(original);
        assert.deepEqual(document.toBytes(), original);
        assert.equal(document.profile.bom, bom);
        assert.equal(document.byteLength, original.length);
        assert.equal(document.version, 0);
      });
    }
  }
}

test('mixed EOL and a second U+FEFF remain content, not normalized', () => {
  const original = bytes('\ufeffA\r\nB\nC\rD\r\n', true);
  const document = SourceDocument.open(original);
  assert.equal(document.read(), '\ufeffA\r\nB\nC\rD\r\n');
  assert.deepEqual(document.profile.originalLineEndings, { lf: 1, crlf: 2, cr: 1 });
  assert.equal(document.profile.preferredLineEnding, '\r\n');
  assert.deepEqual(replace(document, 4, 5, '中文').document.toBytes(), bytes('\ufeffA\r\n中文\nC\rD\r\n', true));
});

test('input and returned byte arrays cannot mutate snapshots', () => {
  const input = bytes('original', true);
  const document = SourceDocument.open(input);
  input.fill(0);
  const saved = document.toBytes();
  saved.fill(1);
  assert.deepEqual(document.toBytes(), bytes('original', true));
  assert.equal(document.read(), 'original');
});

test('local edits preserve unknown macros, comments, CRLF and BOM', () => {
  const prefix = '\\begin{opaque} % preserve exact bytes\r\n';
  const suffix = '\r\n\\end{opaque}\r\n';
  const document = open(prefix + 'editable' + suffix, true);
  const update = replace(document, prefix.length, prefix.length + 8, '中文😀');
  assert.deepEqual(update.document.toBytes(), bytes(prefix + '中文😀' + suffix, true));
  assert.equal(document.read(), prefix + 'editable' + suffix);
  assert.equal(update.document.version, 1);
  assert.equal(update.document.pieceCount, 3);
});

test('atomic multi-patch transaction uses original coordinates', () => {
  const document = open('abcdefghij');
  const update = document.apply({
    expectedVersion: 0,
    patches: [{ from: 1, to: 3, insert: '中' }, { from: 7, to: 9, insert: 'XYZ' }]
  });
  assert.equal(update.document.read(), 'a中defgXYZj');
  assert.equal(update.document.version, 1);
  assert.equal(mapPosition(update.change, 10), update.document.length);
  assert.equal(document.read(), 'abcdefghij');
});

test('invalid range, ordering, overlap and duplicate insertion are rejected', () => {
  const document = open('abcdef');
  for (const [from, to] of [[-1, 1], [4, 2], [1, 8], [NaN, 1], [0.5, 2], [0, Infinity]]) {
    assert.throws(() => replace(document, from!, to!, 'X'), error('RANGE'));
  }
  for (const patches of [
    [{ from: 3, to: 4, insert: 'X' }, { from: 1, to: 2, insert: 'Y' }],
    [{ from: 1, to: 4, insert: 'X' }, { from: 3, to: 5, insert: 'Y' }],
    [{ from: 2, to: 2, insert: 'X' }, { from: 2, to: 2, insert: 'Y' }]
  ]) assert.throws(() => document.apply({ expectedVersion: 0, patches }), error('PATCH'));
  assert.equal(document.read(), 'abcdef');
});

test('late validation failures leave every source byte untouched', () => {
  const document = open('abcdef', true);
  assert.throws(() => document.apply({
    expectedVersion: 0,
    patches: [{ from: 0, to: 1, insert: 'X' }, { from: 3, to: 4, insert: 'Y', expected: 'wrong' }]
  }), error('CONTENT'));
  assert.throws(() => document.apply({
    expectedVersion: 0,
    patches: [{ from: 0, to: 1, insert: 'X' }, { from: 3, to: 4, insert: '\ud800' }]
  }), error('ENCODING'));
  assert.deepEqual(document.toBytes(), bytes('abcdef', true));
  assert.equal(document.version, 0);
});

test('Unicode scalar boundaries are respected in source and inserted text', () => {
  const document = open('A😀中B');
  assert.throws(() => replace(document, 2, 2, 'x'), error('RANGE'));
  assert.throws(() => document.read(0, 2), error('RANGE'));
  assert.throws(() => replace(document, 0, 1, '\udc00'), error('ENCODING'));
  assert.equal(replace(document, 1, 3, '𐐀').document.read(), 'A𐐀中B');
  assert.deepEqual(replace(document, 1, 3, '').document.toBytes(), bytes('A中B'));
});

test('invalid UTF-8 is rejected rather than repaired with replacement characters', () => {
  for (const input of [[0xc0, 0xaf], [0xe2, 0x82], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80]]) {
    assert.throws(() => SourceDocument.open(Uint8Array.from(input)), error('ENCODING'));
  }
});

test('unchanged and empty transactions return the original version', () => {
  const document = open('abc');
  assert.equal(replace(document, 1, 2, 'b').document, document);
  assert.equal(replace(document, 1, 1, '').document, document);
  assert.equal(document.apply({ expectedVersion: 0, patches: [] }).document, document);
});

test('stale edits and parse results cannot overwrite a newer version', () => {
  const initial = open('abc');
  const changed = replace(initial, 1, 2, 'X').document;
  assert.throws(() => changed.apply({ expectedVersion: 0, patches: [] }), error('VERSION'));
  assert.equal(changed.acceptCurrent({ documentId: changed.documentId, version: 0, value: 'old parse' }), null);
  assert.equal(changed.acceptCurrent({ documentId: changed.documentId, version: 1, value: 'current parse' }), 'current parse');
  assert.equal(initial.acceptCurrent({ documentId: open('other file').documentId, version: 0, value: 'foreign parse' }), null);
});

test('undo/redo restores exact bytes without rewinding document versions', () => {
  const initial = open('A\r\n😀\r\n', true);
  const changed = replace(initial, 0, 1, 'changed').document;
  const undo = changed.restore(initial, 1);
  assert.equal(undo.version, 2);
  assert.deepEqual(undo.toBytes(), initial.toBytes());
  assert.equal(undo.acceptCurrent({ documentId: undo.documentId, version: 0, value: 'old parse' }), null);
  const redo = undo.restore(changed, 2);
  assert.equal(redo.version, 3);
  assert.deepEqual(redo.toBytes(), changed.toBytes());
  assert.throws(() => redo.restore(open('other file'), 3), error('ORIGIN'));
});

test('span anchors outside a patch move; dirty nodes are invalidated', () => {
  const update = replace(open('abcdef'), 2, 4, 'XYZ');
  const documentId = update.document.documentId;
  assert.deepEqual(remapSpan(update.change, { documentId, from: 0, to: 2, version: 0 }), { documentId, from: 0, to: 2, version: 1 });
  assert.deepEqual(remapSpan(update.change, { documentId, from: 4, to: 6, version: 0 }), { documentId, from: 5, to: 7, version: 1 });
  assert.equal(remapSpan(update.change, { documentId, from: 1, to: 5, version: 0 }), null);
  assert.throws(() => remapSpan(update.change, { documentId, from: 0, to: 2, version: 9 }), error('VERSION'));
  assert.throws(() => remapSpan(update.change, { documentId: 'foreign', from: 0, to: 2, version: 0 }), error('VERSION'));
  assert.throws(() => remapSpan(update.change, { documentId, from: -1, to: 1, version: 0 }), error('RANGE'));
});

test('insertion boundary affinity excludes inserted text from adjacent old nodes', () => {
  const update = replace(open('abcd'), 2, 2, '😀');
  const documentId = update.document.documentId;
  assert.deepEqual(remapSpan(update.change, { documentId, from: 0, to: 2, version: 0 }), { documentId, from: 0, to: 2, version: 1 });
  assert.deepEqual(remapSpan(update.change, { documentId, from: 2, to: 4, version: 0 }), { documentId, from: 4, to: 6, version: 1 });
  assert.deepEqual(remapSpan(update.change, { documentId, from: 2, to: 2, version: 0 }), { documentId, from: 4, to: 4, version: 1 });
  assert.equal(remapSpan(update.change, { documentId, from: 1, to: 3, version: 0 }), null);
  assert.equal(mapPosition(update.change, 2, 'before'), 2);
  assert.equal(mapPosition(update.change, 2, 'after'), 4);
});

test('deterministic edit corpus agrees with an independent string oracle', () => {
  let state = 0x12345678;
  const random = (bound: number) => {
    state ^= state << 13; state ^= state >>> 17; state ^= state << 5;
    return (state >>> 0) % bound;
  };
  let reference = '😀 original 中文\r\n\\unknown{x}% keep\n';
  let document = open(reference, true);
  const inserted = ['', 'a', '中文', '😀', '\r\n', '\\macro{?}'];
  for (let step = 0; step < 500; step++) {
    const boundaries = [0];
    for (const scalar of reference) boundaries.push(boundaries.at(-1)! + scalar.length);
    const a = random(boundaries.length);
    const b = random(boundaries.length);
    const from = boundaries[Math.min(a, b)]!;
    const to = boundaries[Math.max(a, b)]!;
    const text = inserted[random(inserted.length)]!;
    document = replace(document, from, to, text).document;
    reference = reference.slice(0, from) + text + reference.slice(to);
    assert.equal(document.read(), reference, `edit ${step}`);
    assert.deepEqual(document.toBytes(), bytes(reference, true), `edit bytes ${step}`);
  }
});

test('local keystroke encodes only inserted text, not a 5 MB untouched prefix', () => {
  const document = open('a'.repeat(5 * 1024 * 1024));
  const encodedLengths: number[] = [];
  const originalEncode = TextEncoder.prototype.encode;
  TextEncoder.prototype.encode = function (input = '') {
    encodedLengths.push(input.length);
    return originalEncode.call(this, input);
  };
  try {
    const updated = replace(document, document.length - 1, document.length, '中').document;
    assert.deepEqual(encodedLengths, [1]);
    assert.equal(updated.byteLength, document.byteLength + 2);
    assert.equal(updated.read(updated.length - 1), '中');
  } finally {
    TextEncoder.prototype.encode = originalEncode;
  }
});
