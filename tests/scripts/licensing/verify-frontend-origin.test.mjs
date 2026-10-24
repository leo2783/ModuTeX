import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { consumeFrontendBuildEvidence } from '../../../scripts/licensing/verify-frontend-origin.mjs';
import { digest, inventoryFrontend } from '../../../scripts/licensing/frontend-artifacts.mjs';

async function fixture({ evidence = true, mapContent } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modutex-build-evidence-'));
  const dist = path.join(root, 'apps/frontend/dist-tauri');
  const sourcePath = 'node_modules/example/NOTICE.txt';
  const source = 'Example license text\n';
  const code = 'export default "Example license text";\n';
  const frontend = {
    dependencies: { svelte: '3.0.0' },
    devDependencies: { vite: '1.0.0', '@sveltejs/vite-plugin-svelte': '2.0.0' }
  };
  const packages = [
    { role: 'vite', name: 'vite', version: '1.0.0', pinField: 'devDependencies.vite', dependencies: { rollup: '4.0.0' } },
    { role: 'bundler', name: 'rollup', version: '4.0.0', pinField: null },
    { role: 'svelte-plugin', name: '@sveltejs/vite-plugin-svelte', version: '2.0.0',
      pinField: 'devDependencies.@sveltejs/vite-plugin-svelte' },
    { role: 'svelte', name: 'svelte', version: '3.0.0', pinField: 'dependencies.svelte' }
  ];
  await mkdir(dist, { recursive: true });
  await mkdir(path.join(root, 'docs/licensing'), { recursive: true });
  await mkdir(path.join(root, 'docs/retired'), { recursive: true });
  await mkdir(path.dirname(path.join(root, sourcePath)), { recursive: true });
  await writeFile(path.join(root, sourcePath), source);
  await writeFile(path.join(root, 'node_modules/example/package.json'),
    JSON.stringify({ name: 'example', version: '1.2.3', license: 'MIT' }));
  await writeFile(path.join(root, 'node_modules/example/LICENSE'), 'MIT terms\n');
  await writeFile(path.join(root, 'docs/retired/NOTICE.txt'), 'Not shipped\n');
  await writeFile(path.join(root, 'docs/licensing/frontend-origin.json'), JSON.stringify({
    bundledDocuments: { files: ['docs/retired/NOTICE.txt'] }
  }));
  const frontendBytes = Buffer.from(JSON.stringify(frontend));
  await mkdir(path.join(root, 'apps/frontend'), { recursive: true });
  await writeFile(path.join(root, 'apps/frontend/package.json'), frontendBytes);
  const lock = { lockfileVersion: 3, packages: {} };
  for (const item of packages) {
    const packagePath = path.join(root, 'node_modules', item.name, 'package.json');
    await mkdir(path.dirname(packagePath), { recursive: true });
    const manifest = { name: item.name, version: item.version, ...(item.dependencies ? { dependencies: item.dependencies } : {}) };
    await writeFile(packagePath, JSON.stringify(manifest));
    lock.packages[`node_modules/${item.name}`] = { name: item.name, version: item.version };
  }
  const lockBytes = Buffer.from(JSON.stringify(lock));
  await writeFile(path.join(root, 'package-lock.json'), lockBytes);
  const compilers = [];
  for (const item of packages) {
    const packagePath = `node_modules/${item.name}/package.json`;
    compilers.push({
      kind: 'npm', role: item.role, name: item.name, version: item.version,
      packagePath, packageSha256: digest(await readFile(path.join(root, packagePath))),
      pinPath: item.pinField ? 'apps/frontend/package.json' : null, pinField: item.pinField,
      pinSha256: item.pinField ? digest(frontendBytes) : null,
      lockPath: 'package-lock.json', lockKey: path.posix.dirname(packagePath),
      lockSha256: digest(lockBytes)
    });
  }
  await writeFile(path.join(dist, 'index.js'), code);
  await writeFile(path.join(dist, 'index.js.map'), JSON.stringify({
    version: 3,
    sources: ['../../../node_modules/example/NOTICE.txt?raw'],
    sourcesContent: [mapContent ?? source]
  }));
  if (evidence) {
    await writeFile(path.join(dist, 'frontend-build-evidence.json'), JSON.stringify({
      schemaVersion: 1,
      compilers,
      outputs: [{
        path: 'index.js',
        kind: 'chunk',
        sha256: digest(Buffer.from(code)),
        modules: [{
          id: `${sourcePath}?raw`, sourcePath, sourceSha256: digest(Buffer.from(source)),
          codeSha256: digest(Buffer.from(code)), renderedLength: code.length,
          raw: true, style: false, wasm: false, virtual: false
        }]
      }]
    }));
  }
  return { root, dist, sourcePath, code, source };
}

async function inventory(root) {
  return inventoryFrontend(root, 'apps/frontend/dist-tauri');
}

test('missing build evidence remains a finding', async () => {
  const { root } = await fixture({ evidence: false });
  try {
    const artifacts = await inventory(root);
    const result = await consumeFrontendBuildEvidence(root, artifacts);
    assert.equal(result.verified, false);
    assert.ok(artifacts.unresolved.some(item => item.kind === 'frontend-build-evidence-missing'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('changed input source invalidates evidence and preserves the source-content finding', async () => {
  const { root, sourcePath } = await fixture();
  try {
    await writeFile(path.join(root, sourcePath), 'Altered license text\n');
    const artifacts = await inventory(root);
    const result = await consumeFrontendBuildEvidence(root, artifacts);
    assert.equal(result.verified, false);
    assert.ok(artifacts.unresolved.some(item => item.kind === 'frontend-build-evidence-invalid'));
    assert.ok(artifacts.unresolved.some(item => item.kind === 'source-content-unverified'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('changed output bytes invalidate the recorded output hash', async () => {
  const { root, dist } = await fixture();
  try {
    await writeFile(path.join(dist, 'index.js'), 'export default "tampered";\n');
    const artifacts = await inventory(root);
    const result = await consumeFrontendBuildEvidence(root, artifacts);
    assert.equal(result.verified, false);
    assert.ok(artifacts.unresolved.some(item => item.kind === 'frontend-build-evidence-invalid'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stale compiler source and stale npm lock invalidate evidence', async () => {
  for (const changed of ['compiler', 'lock']) {
    const { root } = await fixture();
    try {
      if (changed === 'compiler') {
        await appendFile(path.join(root, 'node_modules/vite/package.json'), ' ');
      } else {
        const lockPath = path.join(root, 'package-lock.json');
        const lock = JSON.parse(await readFile(lockPath, 'utf8'));
        lock.unrelatedChange = true;
        await writeFile(lockPath, JSON.stringify(lock));
      }
      const artifacts = await inventory(root);
      const result = await consumeFrontendBuildEvidence(root, artifacts);
      assert.equal(result.verified, false, changed);
      assert.ok(artifacts.unresolved.some(item => item.kind === 'frontend-build-evidence-invalid'), changed);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test('only graph-traced raw documents ship; retired manifest entries are excluded', async () => {
  const { root, sourcePath } = await fixture();
  try {
    const artifacts = await inventory(root);
    const result = await consumeFrontendBuildEvidence(root, artifacts);
    assert.equal(result.verified, true);
    assert.deepEqual(artifacts.bundledDocuments.map(item => item.path), [sourcePath]);
    assert.ok(!artifacts.bundledDocuments.some(item => item.path.includes('retired')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('source-content mismatch resolves only with a verified generated transform for that output', async () => {
  const { root, sourcePath } = await fixture({ mapContent: 'transformed map content\n' });
  try {
    const artifacts = await inventory(root);
    assert.ok(artifacts.unresolved.some(item => item.kind === 'source-content-unverified'));
    const result = await consumeFrontendBuildEvidence(root, artifacts);
    assert.equal(result.verified, true);
    assert.ok(!artifacts.unresolved.some(item => item.kind === 'source-content-unverified'));
    assert.ok(artifacts.resolved.some(item =>
      item.finding.kind === 'source-content-unverified' &&
      item.finding.source === sourcePath &&
      item.evidence.kind === 'verified-generated-transform'
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('verified CSS module graph does not require a nonexistent CSS source map', async () => {
  const { root, dist } = await fixture();
  try {
    const sourcePath = 'node_modules/example/style.css';
    const source = '.example { color: red; }\n';
    const output = '.example{color:red}';
    await writeFile(path.join(root, sourcePath), source);
    await writeFile(path.join(dist, 'style.css'), output);
    const mapPath = path.join(dist, 'index.js.map');
    const map = JSON.parse(await readFile(mapPath, 'utf8'));
    map.sources.push('../../../' + sourcePath);
    map.sourcesContent.push(source);
    await writeFile(mapPath, JSON.stringify(map));
    const evidencePath = path.join(dist, 'frontend-build-evidence.json');
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    evidence.outputs.push({path:'style.css',kind:'css',sha256:digest(Buffer.from(output)),modules:[{
      id:sourcePath,sourcePath,sourceSha256:digest(Buffer.from(source)),codeSha256:digest(Buffer.from('')),
      renderedLength:null,raw:false,style:true,wasm:false,virtual:false
    }]});
    await writeFile(evidencePath, JSON.stringify(evidence));
    const artifacts = await inventory(root);
    assert(artifacts.unresolved.some(item=>item.path==='apps/frontend/dist-tauri/style.css'));
    const result = await consumeFrontendBuildEvidence(root, artifacts);
    assert.equal(result.verified,true);
    assert(!artifacts.unresolved.some(item=>item.path==='apps/frontend/dist-tauri/style.css'));
    await writeFile(path.join(dist,'style.css'),output+'body{display:none}');
    const altered = await inventory(root);
    assert.equal((await consumeFrontendBuildEvidence(root,altered)).verified,false);
  } finally { await rm(root,{recursive:true,force:true}); }
});
