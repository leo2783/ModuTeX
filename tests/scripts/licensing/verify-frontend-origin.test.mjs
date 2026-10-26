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

async function readEvidence(root) {
  return JSON.parse(await readFile(path.join(root, 'apps/frontend/dist-tauri/frontend-build-evidence.json'), 'utf8'));
}

async function writeEvidence(root, evidence) {
  await writeFile(path.join(root, 'apps/frontend/dist-tauri/frontend-build-evidence.json'), JSON.stringify(evidence));
}

function graphModule(id, sourcePath, source, code, flags = {}) {
  return {
    id,
    sourcePath,
    sourceSha256: sourcePath === null ? null : digest(Buffer.from(source)),
    codeSha256: code === null ? null : digest(Buffer.from(code)),
    renderedLength: null,
    raw: false,
    style: false,
    wasm: false,
    virtual: sourcePath === null && id.startsWith('\0'),
    ...flags
  };
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

test('Rolldown facade evidence fills an otherwise empty no-map script graph', async () => {
  const { root, dist } = await fixture();
  try {
    const sourcePath = 'node_modules/example/facade.js';
    const source = 'export default 1;\n';
    const output = 'export default 1;\n';
    await writeFile(path.join(root, sourcePath), source);
    await mkdir(path.join(dist, 'assets'), { recursive: true });
    await writeFile(path.join(dist, 'assets/facade.js'), output);

    const evidence = await readEvidence(root);
    evidence.outputs.push({
      path: 'assets/facade.js',
      kind: 'chunk',
      sha256: digest(Buffer.from(output)),
      modules: [graphModule(sourcePath, sourcePath, source, source)],
      facadeModuleId: sourcePath
    });
    await writeEvidence(root, evidence);

    const artifacts = await inventory(root);
    assert.ok(artifacts.unresolved.some(item =>
      item.kind === 'script-without-source-map' && item.path === 'apps/frontend/dist-tauri/assets/facade.js'
    ));
    const result = await consumeFrontendBuildEvidence(root, artifacts);
    assert.equal(result.verified, true);
    assert.ok(!artifacts.unresolved.some(item =>
      item.kind === 'script-without-source-map' && item.path === 'apps/frontend/dist-tauri/assets/facade.js'
    ));
    assert.ok(artifacts.resolved.some(item =>
      item.finding.path === 'apps/frontend/dist-tauri/assets/facade.js' &&
      item.evidence.kind === 'verified-script-module-graph'
    ));

    evidence.outputs.at(-1).facadeModuleId = 'node_modules/example/NOTICE.txt';
    await writeEvidence(root, evidence);
    const stale = await inventory(root);
    assert.equal((await consumeFrontendBuildEvidence(root, stale)).verified, false);
    assert.ok(stale.unresolved.some(item => item.kind === 'frontend-build-evidence-invalid'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('compiler virtual modules require captured transformed code to resolve no-map scripts', async () => {
  const { root, dist } = await fixture();
  try {
    const output = '/* compiler runtime chunk */\n';
    const runtimeCode = 'function __runtime() { return 1; }\n';
    await mkdir(path.join(dist, 'assets'), { recursive: true });
    await writeFile(path.join(dist, 'assets/runtime.js'), output);
    const evidence = await readEvidence(root);
    const runtime = graphModule('\0rolldown/runtime.js', null, null, runtimeCode, { renderedLength: 154 });
    evidence.outputs.push({
      path: 'assets/runtime.js',
      kind: 'chunk',
      sha256: digest(Buffer.from(output)),
      modules: [runtime]
    });
    await writeEvidence(root, evidence);

    const artifacts = await inventory(root);
    assert.equal((await consumeFrontendBuildEvidence(root, artifacts)).verified, true);
    assert.ok(!artifacts.unresolved.some(item =>
      item.kind === 'script-without-source-map' && item.path === 'apps/frontend/dist-tauri/assets/runtime.js'
    ));

    runtime.codeSha256 = null;
    await writeEvidence(root, evidence);
    const missingTransform = await inventory(root);
    assert.equal((await consumeFrontendBuildEvidence(root, missingTransform)).verified, true);
    assert.ok(missingTransform.unresolved.some(item =>
      item.kind === 'frontend-build-transform-unverified' && item.id === '\0rolldown/runtime.js'
    ));
    assert.ok(missingTransform.unresolved.some(item =>
      item.kind === 'script-without-source-map' && item.path === 'apps/frontend/dist-tauri/assets/runtime.js'
    ));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Vite URL resources resolve only through compiler graph and exact emitted-byte evidence', async () => {
  const { root, dist } = await fixture();
  try {
    const sourcePath = 'node_modules/pdfjs-dist/build/pdf.worker.mjs';
    const source = Buffer.from('/* @licstart PDF.js license @licend */\nworker();\n');
    const sourceText = source.toString('utf8');
    const output = 'export default "./assets/pdf.worker-test.mjs";\n';
    const emittedPath = 'apps/frontend/dist-tauri/assets/pdf.worker-test.mjs';
    const map = {
      version: 3,
      sources: ['../../../' + sourcePath + '?url'],
      sourcesContent: ['export default "__VITE_ASSET__worker__";\n']
    };
    await mkdir(path.dirname(path.join(root, sourcePath)), { recursive: true });
    await writeFile(path.join(root, 'node_modules/pdfjs-dist/package.json'), JSON.stringify({
      name: 'pdfjs-dist', version: '6.2.108', license: 'Apache-2.0'
    }));
    await writeFile(path.join(root, 'node_modules/pdfjs-dist/LICENSE'), 'Apache license terms\n');
    await writeFile(path.join(root, sourcePath), source);
    await mkdir(path.join(dist, 'assets'), { recursive: true });
    await writeFile(path.join(dist, 'index.js'), output);
    await writeFile(path.join(dist, 'index.js.map'), JSON.stringify(map));
    await writeFile(path.join(root, emittedPath), source);

    const evidence = await readEvidence(root);
    const script = evidence.outputs.find(item => item.path === 'index.js');
    script.sha256 = digest(Buffer.from(output));
    script.modules = [graphModule(`${sourcePath}?url`, sourcePath, sourceText, output)];
    evidence.outputs.push({
      path: 'assets/pdf.worker-test.mjs',
      kind: 'asset',
      sha256: digest(source),
      modules: [],
      sourceFile: { path: sourcePath, sha256: digest(source) }
    });
    await writeEvidence(root, evidence);

    const pdfWorker = {
      emittedPath,
      installedSourcePath: sourcePath,
      package: 'pdfjs-dist',
      version: '6.2.108',
      declaredLicense: 'Apache-2.0',
      sha256: digest(source),
      installedSha256: digest(source),
      bytes: source.length,
      byteMatch: true,
      licenseNoticeHeaderPresent: true
    };
    const artifacts = await inventory(root);
    assert.ok(artifacts.unresolved.some(item =>
      item.kind === 'url-resource-unverified' && item.source === sourcePath
    ));
    const result = await consumeFrontendBuildEvidence(root, artifacts, { pdfWorker });
    assert.equal(result.verified, true);
    assert.ok(!artifacts.unresolved.some(item =>
      item.kind === 'url-resource-unverified' && item.source === sourcePath
    ));
    assert.ok(artifacts.resolved.some(item =>
      item.finding.kind === 'url-resource-unverified' &&
      item.evidence.kind === 'verified-url-resource-byte-trace' &&
      item.evidence.resourcePath === emittedPath
    ));

    const unmatched = await inventory(root);
    await consumeFrontendBuildEvidence(root, unmatched, {
      pdfWorker: { ...pdfWorker, byteMatch: false }
    });
    assert.ok(unmatched.unresolved.some(item =>
      item.kind === 'url-resource-unverified' && item.source === sourcePath
    ));

    await writeFile(path.join(root, emittedPath), 'tampered worker bytes');
    const tampered = await inventory(root);
    assert.equal((await consumeFrontendBuildEvidence(root, tampered, { pdfWorker })).verified, false);
    assert.ok(tampered.unresolved.some(item => item.kind === 'frontend-build-evidence-invalid'));
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
    const evidencePath = path.join(dist, 'frontend-build-evidence.json');
    const evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
    evidence.outputs.push({
      path: 'style.css',
      kind: 'css',
      sha256: digest(Buffer.from(output)),
      modules: [graphModule(sourcePath, sourcePath, source, '', { style: true })]
    });
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
