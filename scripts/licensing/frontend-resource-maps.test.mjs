import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inventoryFrontend } from './frontend-artifacts.mjs';

const portable = value => value.split(path.sep).join('/');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function createBaseTree() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'resource-maps-root-'));
  const dist = path.join(root, 'apps/frontend/dist');
  await mkdir(dist, { recursive: true });
  await mkdir(path.join(dist, 'assets'), { recursive: true });
  await mkdir(path.join(root, 'node_modules/test-pkg'), { recursive: true });
  await mkdir(path.join(root, 'packages/document-core/src'), { recursive: true });

  await writeFile(
    path.join(root, 'node_modules/test-pkg/package.json'),
    JSON.stringify({ name: 'test-pkg', version: '1.0.0', license: 'MIT' }),
    'utf8'
  );
  await writeFile(
    path.join(root, 'node_modules/test-pkg/LICENSE'),
    'MIT License\n',
    'utf8'
  );

  return { root, dist };
}

// 1. Valid resource trace (e.g. worker / asset script)
test('valid worker / url module resource trace resolves emitted asset with matching hash', async () => {
  const { root, dist } = await createBaseTree();
  try {
    const assetBytes = Buffer.from('worker-thread-byte-content-123');
    const assetRelPath = 'apps/frontend/dist/assets/worker.js';
    await writeFile(path.join(dist, 'assets/worker.js'), assetBytes);

    const sourcePath = path.join(root, 'packages/document-core/src/worker.ts');
    await writeFile(sourcePath, assetBytes);

    const wrapperExport = 'export default "__VITE_ASSET__worker123__";';
    const scriptCode = `const workerUrl = "/assets/worker.js";\nexport default workerUrl;\n`;
    await writeFile(path.join(dist, 'entry.js'), scriptCode, 'utf8');

    // From apps/frontend/dist/entry.js.map, relative to root is 3 levels up: ../../../packages/...
    await writeFile(
      path.join(dist, 'entry.js.map'),
      JSON.stringify({
        version: 3,
        sources: ['../../../packages/document-core/src/worker.ts?url'],
        sourcesContent: [wrapperExport]
      }),
      'utf8'
    );

    const result = await inventoryFrontend(root);
    assert.equal(result.verdict, 'inventory-only-not-license-clearance');

    const mappedSource = result.sources.find(s => s.path === 'packages/document-core/src/worker.ts');
    assert.ok(mappedSource, 'Mapped source must be recorded');
    assert.ok(mappedSource.generatedResources, 'generatedResources must be populated');
    assert.equal(mappedSource.generatedResources.length, 1);

    const res = mappedSource.generatedResources[0];
    assert.equal(res.kind, 'vite-url-module');
    assert.equal(res.emitted, assetRelPath);
    assert.equal(res.resourceSha256, digest(assetBytes));
    assert.equal(res.wrapperSha256, digest(Buffer.from(wrapperExport)));
    assert.ok(!result.unresolved.some(u => u.kind === 'url-resource-unverified'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 2. Resource bytes mismatch
test('resource bytes mismatch leaves url-resource-unverified', async () => {
  const { root, dist } = await createBaseTree();
  try {
    const sourceBytes = Buffer.from('expected-source-bytes');
    const differentEmittedBytes = Buffer.from('corrupted-or-different-emitted-bytes');
    await writeFile(path.join(dist, 'assets/res.png'), differentEmittedBytes);

    const sourcePath = path.join(root, 'packages/document-core/src/res.png');
    await writeFile(sourcePath, sourceBytes);

    const wrapperExport = 'export default "__VITE_ASSET__res123__";';
    const scriptCode = `const url = "/assets/res.png";\n`;
    await writeFile(path.join(dist, 'entry.js'), scriptCode, 'utf8');

    await writeFile(
      path.join(dist, 'entry.js.map'),
      JSON.stringify({
        version: 3,
        sources: ['../../../packages/document-core/src/res.png?url'],
        sourcesContent: [wrapperExport]
      }),
      'utf8'
    );

    const result = await inventoryFrontend(root);
    const unverifiedFinding = result.unresolved.find(
      u => u.kind === 'url-resource-unverified' && u.source === 'packages/document-core/src/res.png'
    );
    assert.ok(unverifiedFinding, 'Mismatch between source and emitted bytes must be unverified');
    const mappedSource = result.sources.find(s => s.path === 'packages/document-core/src/res.png');
    assert.equal(mappedSource?.generatedResources, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 3. Absent script reference
test('absent script reference to emitted asset leaves url-resource-unverified', async () => {
  const { root, dist } = await createBaseTree();
  try {
    const assetBytes = Buffer.from('orphan-asset-bytes');
    await writeFile(path.join(dist, 'assets/orphan.png'), assetBytes);

    const sourcePath = path.join(root, 'packages/document-core/src/orphan.png');
    await writeFile(sourcePath, assetBytes);

    const wrapperExport = 'export default "__VITE_ASSET__orphan123__";';
    // Script code does not mention any matching URL string
    const scriptCode = `const unrelated = "hello world";\n`;
    await writeFile(path.join(dist, 'entry.js'), scriptCode, 'utf8');

    await writeFile(
      path.join(dist, 'entry.js.map'),
      JSON.stringify({
        version: 3,
        sources: ['../../../packages/document-core/src/orphan.png?url'],
        sourcesContent: [wrapperExport]
      }),
      'utf8'
    );

    const result = await inventoryFrontend(root);
    const unverifiedFinding = result.unresolved.find(
      u => u.kind === 'url-resource-unverified' && u.source === 'packages/document-core/src/orphan.png'
    );
    assert.ok(unverifiedFinding, 'Script without reference to asset URL must leave it unverified');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 4. Escaped URL / forbidden path syntax rejected
test('escaped URL, query string, backslash or external protocol in script leaves url-resource-unverified', async () => {
  const { root, dist } = await createBaseTree();
  try {
    const assetBytes = Buffer.from('security-asset-bytes');
    await writeFile(path.join(dist, 'assets/secure.png'), assetBytes);

    const sourcePath = path.join(root, 'packages/document-core/src/secure.png');
    await writeFile(sourcePath, assetBytes);

    const wrapperExport = 'export default "__VITE_ASSET__secure123__";';
    // Script only contains invalid/escaped/external URL forms
    const scriptCode = `
const u1 = "https://external-cdn.com/assets/secure.png";
const u2 = "//cdn.com/assets/secure.png";
const u3 = "/assets/secure.png?v=123";
const u4 = "/assets/secure.png#hash";
const u5 = "..\\\\..\\\\outside.png";
`;
    await writeFile(path.join(dist, 'entry.js'), scriptCode, 'utf8');

    await writeFile(
      path.join(dist, 'entry.js.map'),
      JSON.stringify({
        version: 3,
        sources: ['../../../packages/document-core/src/secure.png?url'],
        sourcesContent: [wrapperExport]
      }),
      'utf8'
    );

    const result = await inventoryFrontend(root);
    const unverifiedFinding = result.unresolved.find(
      u => u.kind === 'url-resource-unverified' && u.source === 'packages/document-core/src/secure.png'
    );
    assert.ok(unverifiedFinding, 'Escaped or non-contained URLs must not match and leave resource unverified');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 5. Unrecognized Vite wrapper syntax rejected
test('unrecognized Vite wrapper export string format leaves url-resource-unverified', async () => {
  const { root, dist } = await createBaseTree();
  try {
    const assetBytes = Buffer.from('unrecognized-wrapper-bytes');
    await writeFile(path.join(dist, 'assets/item.png'), assetBytes);

    const sourcePath = path.join(root, 'packages/document-core/src/item.png');
    await writeFile(sourcePath, assetBytes);

    // Non-standard wrapper not matching /^export default ["']__VITE_ASSET__[A-Za-z\d_$]+__["'];?\s*$/
    const invalidWrapperExport = 'export const itemUrl = "/assets/item.png";';
    const scriptCode = `const u = "/assets/item.png";\n`;
    await writeFile(path.join(dist, 'entry.js'), scriptCode, 'utf8');

    await writeFile(
      path.join(dist, 'entry.js.map'),
      JSON.stringify({
        version: 3,
        sources: ['../../../packages/document-core/src/item.png?url'],
        sourcesContent: [invalidWrapperExport]
      }),
      'utf8'
    );

    const result = await inventoryFrontend(root);
    const unverifiedFinding = result.unresolved.find(
      u => u.kind === 'url-resource-unverified' && u.source === 'packages/document-core/src/item.png'
    );
    assert.ok(unverifiedFinding, 'Unrecognized wrapper format must not be parsed and remain unverified');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 6. Equivalent normalized URL positive (the dedup fix)
test('resourceTrace deduplicates equivalent normalized URL spellings resolving to the same emitted file', async () => {
  const { root, dist } = await createBaseTree();
  try {
    const assetBytes = Buffer.from('dedup-logo-content-bytes');
    const assetRelPath = 'apps/frontend/dist/assets/logo.png';
    await writeFile(path.join(dist, 'assets/logo.png'), assetBytes);

    const sourcePath = path.join(root, 'packages/document-core/src/logo.png');
    await writeFile(sourcePath, assetBytes);

    const wrapperExport = 'export default "__VITE_ASSET__logo123__";';
    // Script contains root-relative, relative with ./, and plain relative spellings pointing to identical emitted file
    const scriptCode = `
const u1 = "/assets/logo.png";
const u2 = "./assets/logo.png";
const u3 = "assets/logo.png";
export const logo = u1;
`;
    await writeFile(path.join(dist, 'entry.js'), scriptCode, 'utf8');

    await writeFile(
      path.join(dist, 'entry.js.map'),
      JSON.stringify({
        version: 3,
        sources: ['../../../packages/document-core/src/logo.png?url'],
        sourcesContent: [wrapperExport]
      }),
      'utf8'
    );

    const result = await inventoryFrontend(root);
    assert.equal(result.verdict, 'inventory-only-not-license-clearance');

    const mappedSource = result.sources.find(s => s.path === 'packages/document-core/src/logo.png');
    assert.ok(mappedSource, 'Mapped source must be collected');
    assert.ok(mappedSource.generatedResources, 'generatedResources must be populated');
    assert.equal(mappedSource.generatedResources.length, 1);

    const res = mappedSource.generatedResources[0];
    assert.equal(res.kind, 'vite-url-module');
    assert.equal(res.emitted, assetRelPath);
    assert.equal(res.resourceSha256, digest(assetBytes));
    assert.equal(res.wrapperSha256, digest(Buffer.from(wrapperExport)));
    assert.ok(!result.unresolved.some(u => u.kind === 'url-resource-unverified'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 7. Actual two-emitted-file ambiguity negative
test('resourceTrace leaves ambiguous different real emitted files with identical bytes as unverified', async () => {
  const { root, dist } = await createBaseTree();
  try {
    const assetBytes = Buffer.from('identical-bytes-in-two-distinct-files');
    // Two genuinely distinct emitted files
    await writeFile(path.join(dist, 'assets/theme-light.png'), assetBytes);
    await writeFile(path.join(dist, 'assets/theme-dark.png'), assetBytes);

    const sourcePath = path.join(root, 'packages/document-core/src/theme.png');
    await writeFile(sourcePath, assetBytes);

    const wrapperExport = 'export default "__VITE_ASSET__theme123__";';
    const scriptCode = `
const u1 = "/assets/theme-light.png";
const u2 = "/assets/theme-dark.png";
export const theme = u1;
`;
    await writeFile(path.join(dist, 'entry.js'), scriptCode, 'utf8');

    await writeFile(
      path.join(dist, 'entry.js.map'),
      JSON.stringify({
        version: 3,
        sources: ['../../../packages/document-core/src/theme.png?url'],
        sourcesContent: [wrapperExport]
      }),
      'utf8'
    );

    const result = await inventoryFrontend(root);
    // Because matched.size === 2, resourceTrace returns null
    const unverifiedFinding = result.unresolved.find(
      u => u.kind === 'url-resource-unverified' && u.source === 'packages/document-core/src/theme.png'
    );
    assert.ok(unverifiedFinding, 'Ambiguous match across distinct emitted files must remain unverified');

    const mappedSource = result.sources.find(s => s.path === 'packages/document-core/src/theme.png');
    assert.ok(mappedSource, 'Source still recorded');
    assert.equal(mappedSource.generatedResources, undefined, 'generatedResources must not be attached');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
