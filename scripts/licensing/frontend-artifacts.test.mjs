import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inventoryFrontend } from './frontend-artifacts.mjs';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modutex-origin-'));
  const dist = path.join(root, 'apps/frontend/dist');
  await mkdir(dist, { recursive: true });
  await mkdir(path.join(root, 'node_modules/example'), { recursive: true });
  await writeFile(path.join(root, 'node_modules/example/package.json'), JSON.stringify({ name: 'example', version: '1.2.3', license: 'MIT' }));
  await writeFile(path.join(root, 'node_modules/example/LICENSE'), 'Original copyright\r\nMIT terms\r\n');
  await writeFile(path.join(root, 'node_modules/example/index.js'), 'export const value = 1;\n');
  await writeFile(path.join(dist, 'index.js'), 'const value = 1;\n');
  await writeFile(path.join(dist, 'index.js.map'), JSON.stringify({ version: 3, sources: ['../../../node_modules/example/index.js'],
    sourcesContent: ['export const value = 1;\n'] }));
  return { root, dist };
}

test('real files, exact license text and content hashes; untraced worker and CSS remain unresolved', async () => {
  const { root, dist } = await fixture();
  try {
    await writeFile(path.join(dist, 'pdf.worker.mjs'), 'worker();');
    await writeFile(path.join(dist, 'app.css'), 'body{}');
    const result = await inventoryFrontend(root);
    assert.equal(result.verdict, 'inventory-only-not-license-clearance');
    assert.equal(result.packages[0].version, '1.2.3');
    const license = result.packages[0].documents[0];
    assert.equal(license.text, 'Original copyright\r\nMIT terms\r\n');
    assert.equal(license.sha256, createHash('sha256').update(license.text).digest('hex'));
    assert.equal(result.sources.length, 1);
    assert.deepEqual(result.unresolved.map(item => item.kind).sort(), ['asset-origin-review-required', 'script-without-source-map']);
    assert.deepEqual(await inventoryFrontend(root), result);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('stale and missing mapped source are visible, not successful provenance', async () => {
  const { root, dist } = await fixture();
  try {
    await writeFile(path.join(dist, 'index.js.map'), JSON.stringify({ version: 3,
      sources: ['../../../node_modules/example/index.js', '../../../missing.js'], sourcesContent: ['stale', 'missing'] }));
    const result = await inventoryFrontend(root);
    assert.deepEqual(result.unresolved.map(item => item.kind), ['source-content-unverified', 'missing-map-source']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('source map cannot escape repository scope', async () => {
  const { root, dist } = await fixture();
  try {
    await writeFile(path.join(dist, 'index.js.map'), JSON.stringify({ version: 3, sources: ['../../../../outside.js'] }));
    await assert.rejects(inventoryFrontend(root), /SOURCE_OUTSIDE_REPOSITORY/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
