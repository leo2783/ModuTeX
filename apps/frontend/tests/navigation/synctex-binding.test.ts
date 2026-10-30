// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import '../helpers/document-core-wasm.mjs';

const modulePath = path.resolve(process.env.MODUTEX_SYNCTEX_MODULE ??
  path.join(import.meta.dirname, '../../src/features/compile/synctex.ts'));
const { BoundSynctexIndex, sameCompileIdentity } = await import(pathToFileURL(modulePath).href);
const identity = Object.freeze({ runId: 'run-1', workspaceId: 'workspace-1', entryPath: 'main.tex',
  documentId: 'document-1', documentVersion: 7, savedRevision: 'revision-1' });
const fixture = new TextEncoder().encode([
  'SyncTeX Version:1', 'Input:17:main.tex', 'Input:18:chapters/章節.tex', 'Output:pdf',
  'Magnification:1000', 'Unit:1', 'X Offset:0', 'Y Offset:0', 'Content:', '{1',
  '[17,7:655360,1310720:1310720,655360,65536',
  'h17,7,4:655360,1310720:655360,327680,65536', ']', '}1', '{2',
  '[18,9:655360,1310720:1310720,655360,65536',
  'h18,9,2:655360,1310720:655360,327680,65536', ']', '}2',
  'Postamble:', 'Count:30', '!17', 'Post scriptum:', '!24', ''
].join('\n'));

test('real WASM binding preserves entry and included-source coordinates across suspend/resume', () => {
  for (const bytes of [fixture.slice(), new Uint8Array(gzipSync(fixture))]) {
    const index = new BoundSynctexIndex(identity, bytes);
    try {
      const entry = index.forwardSearch(7);
      assert.equal(entry.page, 1);
      const included = index.forwardSearch(9, null, 'chapters/章節.tex');
      assert.equal(included.page, 2);
      assert.deepEqual(index.inverseSearch(2, included.x, included.y),
        { path: 'chapters/章節.tex', line: 9, column: 2 });
      index.suspend();
      assert.equal(index.isReady, false);
      assert.throws(() => index.forwardSearch(7), /SYNC_TEX_INACTIVE/);
      assert.ok(bytes.some(value => value !== 0));
      index.resume();
      assert.deepEqual(index.forwardSearch(9, null, 'chapters/章節.tex'), included);
    } finally { index.dispose(); }
    assert.equal(bytes.some(value => value !== 0), false, 'dispose clears retained artifact bytes');
    assert.throws(() => index.resume(), /SYNC_TEX_UNAVAILABLE/);
    index.dispose();
  }
});

test('every compile identity field prevents a stale PDF from matching', () => {
  assert.equal(sameCompileIdentity(identity, { ...identity }), true);
  assert.equal(sameCompileIdentity(null, identity), false);
  for (const key of Object.keys(identity) as (keyof typeof identity)[]) {
    const changed = { ...identity, [key]: key === 'documentVersion' ? 8 : `${identity[key]}-other` };
    assert.equal(sameCompileIdentity(identity, changed), false, key);
  }
  const mutable = { ...identity, runId: String(identity.runId) };
  const index = new BoundSynctexIndex(mutable, fixture.slice());
  try {
    mutable.runId = 'later-run';
    assert.equal(index.identity.runId, identity.runId);
    assert.equal(Object.isFrozen(index.identity), true);
  } finally { index.dispose(); }
});

test('binding rejects unsafe paths and malformed coordinates before WASM navigation', () => {
  const index = new BoundSynctexIndex(identity, fixture.slice());
  try {
    for (const value of ['../main.tex', '/main.tex', 'C:/main.tex', 'chapters\\章節.tex'])
      assert.throws(() => index.forwardSearch(7, null, value), /INVALID_INPUT/);
    for (const value of [NaN, Infinity, -1, 0, 1.5, 0x1_0000_0000])
      assert.throws(() => index.forwardSearch(value), /INVALID_INPUT/);
    assert.throws(() => index.inverseSearch(1, Infinity, 1), /INVALID_INPUT/);
    assert.throws(() => index.inverseSearch(1, 1, 1e13), /INVALID_INPUT/);
  } finally { index.dispose(); }
  const invalid = new TextEncoder().encode('invalid artifact');
  assert.throws(() => new BoundSynctexIndex(identity, invalid));
  assert.equal(invalid.some(value => value !== 0), false);
});
