import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectFrontendBoundaries } from './frontend-boundaries.mjs';
import { digest, inside, inventoryFrontend } from './frontend-artifacts.mjs';
import { collectAssetProvenance } from './frontend-asset-origins.mjs';

const HASH = /^[0-9a-f]{64}$/;
const EVIDENCE_LIMIT = 64 * 1024 * 1024;
const styleExtensions = new Set(['.css', '.pcss', '.scss', '.sass', '.less', '.styl', '.stylus']);
const oldDocumentFindings = new Set([
  'missing-bundled-document-inventory', 'bundled-document-inventory-invalid',
  'bundled-document-path-invalid', 'missing-bundled-document-source',
  'bundled-document-not-file', 'bundled-document-output-unverified'
]);
const portable = value => value.split(path.sep).join('/');
const plainRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function safePath(root, value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 ||
    value.startsWith('/') || /^[A-Za-z]:/.test(value) || value.includes('\\') ||
    /[\x00-\x1f\x7f]/.test(value) || value.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error(`FRONTEND_BUILD_EVIDENCE_PATH_INVALID: ${field}`);
  }
  const candidate = path.resolve(root, value);
  if (!inside(root, candidate)) throw new Error(`FRONTEND_BUILD_EVIDENCE_PATH_OUTSIDE_REPOSITORY: ${field}`);
  return candidate;
}

async function readRootFile(root, relative, field, maximum = Infinity) {
  const candidate = safePath(root, relative, field);
  const actual = await realpath(candidate);
  if (!inside(root, actual) || portable(path.relative(root, actual)) !== relative) {
    throw new Error(`FRONTEND_BUILD_EVIDENCE_PATH_NOT_CANONICAL: ${field}`);
  }
  const info = await stat(actual);
  if (!info.isFile() || info.size > maximum) throw new Error(`FRONTEND_BUILD_EVIDENCE_FILE_INVALID: ${field}`);
  return { bytes: await readFile(actual), size: info.size };
}

function queryOf(id) {
  const at = id.indexOf('?');
  return new URLSearchParams(at < 0 ? '' : id.slice(at + 1).split('#', 1)[0]);
}

function styleModuleId(id) {
  return queryOf(id).get('type') === 'style' ||
    styleExtensions.has(path.extname(id.split('?', 1)[0]).toLowerCase());
}

function generatedCoreWasm(value) {
  return typeof value === 'string' &&
    value.startsWith('apps/frontend/src/features/document-core/generated/') &&
    value.toLowerCase().endsWith('.wasm');
}

function cargoLockedVersion(text) {
  for (const block of text.split(/^\[\[package\]\]\s*$/m).slice(1)) {
    if (!/^name = "wasm-bindgen"$/m.test(block)) continue;
    if (!/^source = "registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index"$/m.test(block) ||
      !/^checksum = "[\da-f]{64}"$/m.test(block)) return null;
    return block.match(/^version = "([^"]+)"$/m)?.[1] ?? null;
  }
  return null;
}

async function verifyNpmCompiler(root, item, role, name, pinField, frontend, frontendBytes, lock, lockHash) {
  if (!plainRecord(item) || item.kind !== 'npm' || item.role !== role || item.name !== name ||
    typeof item.version !== 'string' || item.packagePath?.split('/').includes('node_modules') !== true ||
    path.posix.basename(item.packagePath) !== 'package.json' ||
    item.lockPath !== 'package-lock.json' || item.lockSha256 !== lockHash ||
    item.lockKey !== path.posix.dirname(item.packagePath) ||
    !item.lockKey.split('/').includes('node_modules')) {
    throw new Error(`FRONTEND_BUILD_EVIDENCE_COMPILER_IDENTITY_INVALID: ${role}`);
  }
  const source = await readRootFile(root, item.packagePath, `${role}.source`);
  if (!HASH.test(item.packageSha256 ?? '') || digest(source.bytes) !== item.packageSha256) {
    throw new Error(`FRONTEND_BUILD_EVIDENCE_COMPILER_SOURCE_STALE: ${role}`);
  }
  const manifest = JSON.parse(source.bytes);
  const locked = lock.packages?.[item.lockKey];
  if (manifest.name !== name || manifest.version !== item.version || !locked ||
    locked.version !== item.version || (locked.name !== undefined && locked.name !== name)) {
    throw new Error(`FRONTEND_BUILD_EVIDENCE_COMPILER_LOCK_STALE: ${role}`);
  }
  const pin = pinField?.split('.').reduce((value, key) => value?.[key], frontend);
  if (item.pinField !== pinField || item.pinPath !== (pinField ? 'apps/frontend/package.json' : null) ||
    item.pinSha256 !== (pinField ? digest(frontendBytes) : null) ||
    (pinField && pin !== item.version)) {
    throw new Error(`FRONTEND_BUILD_EVIDENCE_COMPILER_PIN_STALE: ${role}`);
  }
  return manifest;
}

async function verifyCompilers(root, records, rustWasmActive) {
  if (!Array.isArray(records) || records.length > 8) throw new Error('FRONTEND_BUILD_EVIDENCE_COMPILERS_INVALID');
  const byRole = new Map();
  for (const item of records) {
    if (!plainRecord(item) || typeof item.role !== 'string' || byRole.has(item.role)) {
      throw new Error('FRONTEND_BUILD_EVIDENCE_COMPILER_ROLE_INVALID');
    }
    byRole.set(item.role, item);
  }
  const frontendFile = await readRootFile(root, 'apps/frontend/package.json', 'frontend manifest');
  const lockFile = await readRootFile(root, 'package-lock.json', 'npm lock');
  const frontend = JSON.parse(frontendFile.bytes);
  const lock = JSON.parse(lockFile.bytes);
  const lockHash = digest(lockFile.bytes);
  const vite = await verifyNpmCompiler(root, byRole.get('vite'), 'vite', 'vite',
    'devDependencies.vite', frontend, frontendFile.bytes, lock, lockHash);
  const dependencies = { ...(vite.dependencies ?? {}), ...(vite.optionalDependencies ?? {}) };
  const bundler = dependencies.rolldown ? 'rolldown' : dependencies.rollup ? 'rollup' : 'vite';
  const expected = [
    ['bundler', bundler, bundler === 'vite' ? 'devDependencies.vite' : null],
    ['svelte-plugin', '@sveltejs/vite-plugin-svelte', 'devDependencies.@sveltejs/vite-plugin-svelte'],
    ['svelte', 'svelte', 'dependencies.svelte']
  ];
  for (const [role, name, pin] of expected) {
    await verifyNpmCompiler(root, byRole.get(role), role, name, pin, frontend, frontendFile.bytes, lock, lockHash);
  }
  const rust = byRole.get('rust-wasm');
  if (Boolean(rust) !== rustWasmActive || byRole.size !== 4 + Number(rustWasmActive)) {
    throw new Error('FRONTEND_BUILD_EVIDENCE_COMPILER_SET_STALE');
  }
  const summaries = records.map(item => ({
    role: item.role, name: item.name, version: item.version,
    packageSha256: item.packageSha256 ?? null, pinSha256: item.pinSha256 ?? null,
    lockSha256: item.lockSha256 ?? null
  }));
  if (rustWasmActive) {
    if (!plainRecord(rust) || rust.kind !== 'cargo-pin' || rust.name !== 'wasm-bindgen' ||
      rust.pinPath !== 'crates/document-core/Cargo.toml' || rust.lockPath?.split('/').includes('..') ||
      !['crates/document-core/Cargo.lock', 'apps/desktop-tauri/Cargo.lock', 'Cargo.lock'].includes(rust.lockPath)) {
      throw new Error('FRONTEND_BUILD_EVIDENCE_WASM_COMPILER_INVALID');
    }
    const pinFile = await readRootFile(root, rust.pinPath, 'wasm compiler pin');
    const pin = pinFile.bytes.toString('utf8').match(/^\s*wasm-bindgen\s*=\s*\{\s*version\s*=\s*"(=[^"]+)"[^}]*\}/m);
    const cargoLock = await readRootFile(root, rust.lockPath, 'wasm compiler lock');
    if (!pin || rust.pin !== pin[1] || rust.version !== pin[1].slice(1) ||
      rust.pinSha256 !== digest(pinFile.bytes) || rust.lockSha256 !== digest(cargoLock.bytes) ||
      cargoLockedVersion(cargoLock.bytes.toString('utf8')) !== rust.version) {
      throw new Error('FRONTEND_BUILD_EVIDENCE_WASM_COMPILER_STALE');
    }
  }
  return summaries;
}

async function verifyFrontendBuildEvidence(rootDirectory, inventory) {
  const failed = (kind, reason) => ({
    verified: false, findings: [{ kind, reason }], outputs: new Map(),
    rawDocuments: [], warnings: [], compilerSummary: [], moduleCount: 0
  });
  let root, scope, evidenceFile;
  try {
    root = await realpath(rootDirectory);
    scope = inventory.scope;
    const dist = await realpath(safePath(root, scope, 'scope'));
    if (!inside(root, dist) || portable(path.relative(root, dist)) !== scope) throw new Error('DIST_PATH_INVALID');
    evidenceFile = await readRootFile(root, `${scope}/frontend-build-evidence.json`, 'build evidence', EVIDENCE_LIMIT);
  } catch (error) {
    return failed(error.code === 'ENOENT' ? 'frontend-build-evidence-missing' : 'frontend-build-evidence-invalid', error.message);
  }
  try {
    const evidencePath = `${scope}/frontend-build-evidence.json`;
    const evidenceArtifact = inventory.artifacts.find(item => item.path === evidencePath);
    if (!evidenceArtifact || evidenceArtifact.sha256 !== digest(evidenceFile.bytes) ||
      evidenceArtifact.bytes !== evidenceFile.size) throw new Error('EVIDENCE_ARTIFACT_HASH_MISMATCH');
    const evidence = JSON.parse(evidenceFile.bytes);
    if (!plainRecord(evidence) || evidence.schemaVersion !== 1 || !Array.isArray(evidence.outputs) ||
      evidence.outputs.length === 0 || evidence.outputs.length > 10000) throw new Error('EVIDENCE_SCHEMA_INVALID');
    const artifactRows = new Map(inventory.artifacts.map(item => [item.path, item]));
    const inputs = new Map();
    const input = async (relative, expected) => {
      if (typeof relative !== 'string' || !HASH.test(expected ?? '')) throw new Error('INPUT_IDENTITY_INVALID');
      let found = inputs.get(relative);
      if (!found) {
        const file = await readRootFile(root, relative, 'module input');
        found = { sha256: digest(file.bytes), bytes: file.size };
        inputs.set(relative, found);
      }
      if (found.sha256 !== expected) throw new Error(`INPUT_HASH_MISMATCH: ${relative}`);
      return found;
    };
    const outputs = new Map();
    const warnings = [];
    let moduleCount = 0;
    for (const item of evidence.outputs) {
      if (!plainRecord(item) || !['chunk', 'css', 'asset'].includes(item.kind) ||
        !HASH.test(item.sha256 ?? '') || !Array.isArray(item.modules)) throw new Error('OUTPUT_RECORD_INVALID');
      const rootPath = `${scope}/${item.path}`;
      safePath(root, rootPath, 'output');
      if (outputs.has(rootPath)) throw new Error(`OUTPUT_DUPLICATED: ${rootPath}`);
      const outputFile = await readRootFile(root, rootPath, 'output');
      const artifact = artifactRows.get(rootPath);
      if (!artifact || artifact.sha256 !== item.sha256 || artifact.bytes !== outputFile.size ||
        digest(outputFile.bytes) !== item.sha256) throw new Error(`OUTPUT_HASH_MISMATCH: ${rootPath}`);
      if (item.sourceFile !== undefined) {
        if (!plainRecord(item.sourceFile) || !HASH.test(item.sourceFile.sha256 ?? '')) throw new Error('ASSET_SOURCE_INVALID');
        await input(item.sourceFile.path, item.sourceFile.sha256);
      }
      const seen = new Set();
      for (const module of item.modules) {
        if (!plainRecord(module) || typeof module.id !== 'string' || module.id.length > 32767 ||
          typeof module.raw !== 'boolean' || typeof module.style !== 'boolean' ||
          typeof module.wasm !== 'boolean' || typeof module.virtual !== 'boolean' ||
          (module.codeSha256 !== null && !HASH.test(module.codeSha256 ?? '')) ||
          (module.renderedLength !== null && (!Number.isSafeInteger(module.renderedLength) || module.renderedLength < 0))) {
          throw new Error('MODULE_RECORD_INVALID');
        }
        if (seen.has(module.id)) throw new Error(`MODULE_DUPLICATED: ${rootPath}`);
        seen.add(module.id);
        const sourcePath = module.sourcePath;
        if (sourcePath === null) {
          if (module.sourceSha256 !== null) throw new Error('MODULE_INPUT_INVALID');
        } else {
          if (typeof sourcePath !== 'string' || !HASH.test(module.sourceSha256 ?? '') ||
            (module.id !== sourcePath && !module.id.startsWith(`${sourcePath}?`))) throw new Error('MODULE_INPUT_INVALID');
          await input(sourcePath, module.sourceSha256);
        }
        const virtual = sourcePath === null && module.id.startsWith('\0');
        const wasm = typeof sourcePath === 'string' && sourcePath.toLowerCase().endsWith('.wasm');
        if (module.raw !== queryOf(module.id).has('raw') || module.style !== styleModuleId(module.id) ||
          module.wasm !== wasm || module.virtual !== virtual) throw new Error('MODULE_FLAGS_INVALID');
        if (module.codeSha256 === null) warnings.push({ kind: 'frontend-build-transform-unverified', output: rootPath, id: module.id });
        moduleCount++;
        if (moduleCount > 100000) throw new Error('MODULE_LIMIT_EXCEEDED');
      }
      if ((item.kind === 'chunk' || item.kind === 'css') && item.modules.length === 0) {
        warnings.push({ kind: item.kind === 'css' ? 'frontend-build-css-graph-unavailable' : 'frontend-build-module-graph-empty', path: rootPath });
      }
      outputs.set(rootPath, { ...item, rootPath });
    }
    const rustWasmActive = [...outputs.values()].some(output =>
      output.modules.some(module => generatedCoreWasm(module.sourcePath)) ||
      generatedCoreWasm(output.sourceFile?.path)
    );
    const compilerSummary = await verifyCompilers(root, evidence.compilers, rustWasmActive);
    const documents = new Map();
    for (const output of outputs.values()) {
      for (const module of output.modules) {
        if (!module.raw) continue;
        if (!module.sourcePath || !module.codeSha256) {
          warnings.push({ kind: 'frontend-build-raw-document-unverified', output: output.rootPath, id: module.id });
          continue;
        }
        const source = inputs.get(module.sourcePath);
        const document = documents.get(module.sourcePath) ?? {
          path: module.sourcePath, bytes: source.bytes, sha256: source.sha256, moduleEvidence: []
        };
        document.moduleEvidence.push({
          outputPath: output.rootPath, outputSha256: output.sha256,
          moduleId: module.id, codeSha256: module.codeSha256
        });
        documents.set(module.sourcePath, document);
      }
    }
    return {
      verified: true, findings: [], outputs, rawDocuments: [...documents.values()],
      warnings, compilerSummary, moduleCount
    };
  } catch (error) {
    return failed('frontend-build-evidence-invalid', error.message);
  }
}

export async function consumeFrontendBuildEvidence(root, artifacts) {
  artifacts.unresolved = artifacts.unresolved.filter(item => !oldDocumentFindings.has(item.kind));
  artifacts.bundledDocuments = [];
  const evidence = await verifyFrontendBuildEvidence(root, artifacts);
  if (!evidence.verified) {
    artifacts.unresolved.push(...evidence.findings);
    return { verified: false, findings: evidence.findings, outputs: 0, modules: 0 };
  }
  artifacts.bundledDocuments = evidence.rawDocuments;
  const sourceRows = new Map(artifacts.sources.map(item => [item.path, item]));
  const resolved = artifacts.resolved ?? [];
  const remaining = [];
  for (const finding of artifacts.unresolved) {
    const output = typeof finding.map === 'string' && finding.map.endsWith('.map')
      ? evidence.outputs.get(finding.map.slice(0, -4))
      : null;
    let proof = null;
    if (finding.kind === 'source-content-unverified') {
      const module = output?.modules.find(item =>
        item.sourcePath === finding.source && item.codeSha256 &&
        item.codeSha256 !== item.sourceSha256
      );
      if (module) proof = {
        kind: 'verified-generated-transform', sourcePath: module.sourcePath,
        sourceSha256: module.sourceSha256, moduleId: module.id,
        codeSha256: module.codeSha256, outputPath: output.rootPath,
        outputSha256: output.sha256, compilers: evidence.compilerSummary
      };
    } else if (finding.kind === 'non-file-map-source') {
      const module = output?.modules.find(item =>
        item.virtual && item.id === finding.source && item.codeSha256
      );
      if (module) proof = {
        kind: 'verified-virtual-module', moduleId: module.id,
        codeSha256: module.codeSha256, outputPath: output.rootPath,
        outputSha256: output.sha256, compilers: evidence.compilerSummary
      };
    }
    if (proof) resolved.push({ finding, evidence: proof });
    else remaining.push(finding);
  }
  const unresolvedSources = new Set(remaining
    .filter(item => item.kind === 'source-content-unverified').map(item => item.source));
  const pending = [];
  for (const finding of remaining) {
    const output = evidence.outputs.get(finding.path);
    let proof = null;
    if (finding.kind === 'asset-origin-review-required' &&
      path.posix.extname(finding.path).toLowerCase() === '.css' && output?.kind === 'css') {
      const complete = output.modules.length > 0 && output.modules.every(module => {
        const source = module.sourcePath && sourceRows.get(module.sourcePath);
        return module.style && module.codeSha256 && source &&
          source.sha256 === module.sourceSha256 && source.package !== null &&
          !unresolvedSources.has(module.sourcePath);
      });
      if (complete) proof = {
        kind: 'verified-css-module-graph', outputPath: output.rootPath,
        outputSha256: output.sha256,
        modules: output.modules.map(item => ({ id: item.id, sourcePath: item.sourcePath, sourceSha256: item.sourceSha256 })),
        compilers: evidence.compilerSummary
      };
    } else if (finding.kind === 'asset-origin-review-required' &&
      path.posix.extname(finding.path).toLowerCase() === '.wasm' && output?.kind === 'asset' &&
      output.sourceFile && output.sha256 === output.sourceFile.sha256) {
      const source = sourceRows.get(output.sourceFile.path);
      const traced = generatedCoreWasm(output.sourceFile.path)
        ? evidence.compilerSummary.some(item => item.role === 'rust-wasm')
        : source?.sha256 === output.sourceFile.sha256 && source.package !== null;
      if (traced) proof = {
        kind: 'verified-wasm-byte-trace', outputPath: output.rootPath,
        outputSha256: output.sha256, sourcePath: output.sourceFile.path,
        sourceSha256: output.sourceFile.sha256, compilers: evidence.compilerSummary
      };
    } else if (finding.kind === 'script-without-source-map' && output?.kind === 'chunk') {
      const complete = output.modules.length > 0 && output.modules.every(module => {
        if (!module.codeSha256) return false;
        if (!module.sourcePath) return module.virtual;
        const source = sourceRows.get(module.sourcePath);
        return source?.sha256 === module.sourceSha256 && source.package !== null &&
          !unresolvedSources.has(module.sourcePath);
      });
      if (complete) proof = {
        kind: 'verified-script-module-graph', outputPath: output.rootPath,
        outputSha256: output.sha256, modules: output.modules.length,
        compilers: evidence.compilerSummary
      };
    }
    if (proof) resolved.push({ finding, evidence: proof });
    else pending.push(finding);
  }
  artifacts.unresolved = [...pending, ...evidence.warnings];
  artifacts.resolved = resolved;
  return {
    verified: true, findings: evidence.warnings,
    outputs: evidence.outputs.size, modules: evidence.moduleCount
  };
}

function reconcileAssetFindings(artifacts, assets) {
  const outputs = new Map(artifacts.artifacts.map(item => [item.path, item]));
  const worker = assets.pdfWorker;
  const workerOutput = worker && outputs.get(worker.emittedPath);
  const workerVerified = Boolean(
    worker &&
    worker.byteMatch === true &&
    worker.licenseNoticeHeaderPresent === true &&
    worker.sha256 === worker.installedSha256 &&
    workerOutput?.sha256 === worker.sha256
  );
  const resolved = [];

  artifacts.unresolved = artifacts.unresolved.filter(finding => {
    let evidence = null;
    if (
      workerVerified &&
      finding.kind === 'script-without-source-map' &&
      finding.path === worker.emittedPath
    ) {
      evidence = {
        kind: 'pdf-worker-byte-match',
        emittedPath: worker.emittedPath,
        installedSourcePath: worker.installedSourcePath,
        sha256: worker.sha256
      };
    } else if (
      workerVerified &&
      finding.kind === 'source-content-unverified' &&
      finding.map === `${worker.emittedPath}.map` &&
      finding.source === worker.installedSourcePath
    ) {
      evidence = {
        kind: 'pdf-worker-byte-match',
        emittedPath: worker.emittedPath,
        installedSourcePath: worker.installedSourcePath,
        sha256: worker.sha256
      };
    } else if (finding.kind === 'asset-origin-review-required') {
      const font = (assets.fonts ?? []).find(item =>
        item.sourceType === 'emitted-file' &&
        item.byteMatch === true &&
        item.emittedPath === finding.path &&
        outputs.get(item.emittedPath)?.sha256 === item.sha256
      );
      if (font) {
        evidence = {
          kind: 'font-byte-match',
          emittedPath: font.emittedPath,
          originalFilename: font.originalFilename,
          sha256: font.sha256
        };
      }
    }
    if (!evidence) return true;
    resolved.push({ finding, evidence });
    return false;
  });
  artifacts.resolved = resolved;
}

export async function verifyFrontendOrigin(root) {
  const boundaries = await inspectFrontendBoundaries(root);
  const dist = 'apps/frontend/dist-tauri';
  const assets = await collectAssetProvenance(root, dist);
  const artifacts = await inventoryFrontend(root, dist);
  reconcileAssetFindings(artifacts, assets);
  const buildEvidence = await consumeFrontendBuildEvidence(root, artifacts);
  const blockers = [
    ...boundaries.findings,
    ...artifacts.unresolved,
    ...assets.unresolved,
    ...artifacts.packages
      .filter(item => /\bAGPL\b/i.test(item.declaredLicense ?? ''))
      .map(item => ({ kind: 'agpl-bundled-package', path: item.path }))
  ];
  return {
    schemaVersion: 1,
    verdict: blockers.length === 0 ? 'evidence-only' : 'findings-present',
    blockers,
    boundaries,
    artifacts,
    assets,
    buildEvidence
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await verifyFrontendOrigin(process.cwd());
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.blockers.length === 0 ? 0 : 1;
  } catch (error) {
    process.stderr.write(`Frontend origin verification failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
