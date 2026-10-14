import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { collectAssetProvenance } from './frontend-asset-origins.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const realRepoRoot = path.resolve(__dirname, '../..');

const FONT_NAMES = [
  'KaTeX_AMS-Regular.woff2',
  'KaTeX_Caligraphic-Bold.woff2',
  'KaTeX_Caligraphic-Regular.woff2',
  'KaTeX_Fraktur-Bold.woff2',
  'KaTeX_Fraktur-Regular.woff2',
  'KaTeX_Main-Bold.woff2',
  'KaTeX_Main-BoldItalic.woff2',
  'KaTeX_Main-Italic.woff2',
  'KaTeX_Main-Regular.woff2',
  'KaTeX_Math-BoldItalic.woff2',
  'KaTeX_Math-Italic.woff2',
  'KaTeX_SansSerif-Bold.woff2',
  'KaTeX_SansSerif-Italic.woff2',
  'KaTeX_SansSerif-Regular.woff2',
  'KaTeX_Script-Regular.woff2',
  'KaTeX_Size1-Regular.woff2',
  'KaTeX_Size2-Regular.woff2',
  'KaTeX_Size3-Regular.woff2',
  'KaTeX_Size4-Regular.woff2',
  'KaTeX_Typewriter-Regular.woff2'
];

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'modutex-asset-fixture-'));
  const dist = path.join(root, 'apps/frontend/dist');
  const distAssets = path.join(dist, 'assets');
  await mkdir(distAssets, { recursive: true });

  // 1. pdfjs-dist
  const pdfjsDir = path.join(root, 'node_modules/pdfjs-dist');
  await mkdir(path.join(pdfjsDir, 'build'), { recursive: true });
  await writeFile(path.join(pdfjsDir, 'package.json'), JSON.stringify({
    name: 'pdfjs-dist',
    version: '6.2.108',
    license: 'Apache-2.0'
  }));
  const workerContent = `/**
 * @licstart The following is the entire license notice for the
 * JavaScript code in this page
 *
 * Copyright 2024 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * @licend
 */
export function pdfWorker() { return "worker"; }
`;
  const prebuiltWorkerPath = path.join(pdfjsDir, 'build/pdf.worker.mjs');
  await writeFile(prebuiltWorkerPath, workerContent);

  // 2. mathlive
  const mathliveDir = path.join(root, 'node_modules/mathlive');
  const mathliveFontsDir = path.join(mathliveDir, 'fonts');
  await mkdir(mathliveFontsDir, { recursive: true });
  await writeFile(path.join(mathliveDir, 'package.json'), JSON.stringify({
    name: 'mathlive',
    version: '0.110.0',
    license: 'MIT'
  }));
  await writeFile(path.join(mathliveDir, 'mathlive-fonts.css'), '/* mathlive-fonts.css */');

  const realMathliveFontsDir = path.join(realRepoRoot, 'node_modules/mathlive/fonts');
  const fontBuffers = new Map();
  for (const name of FONT_NAMES) {
    const bytes = await readFile(path.join(realMathliveFontsDir, name));
    fontBuffers.set(name, bytes);
    await writeFile(path.join(mathliveFontsDir, name), bytes);
  }

  // 3. prosemirror-view
  const pmDir = path.join(root, 'node_modules/prosemirror-view');
  await mkdir(path.join(pmDir, 'style'), { recursive: true });
  await writeFile(path.join(pmDir, 'package.json'), JSON.stringify({
    name: 'prosemirror-view',
    version: '1.41.9',
    license: 'MIT'
  }));
  await writeFile(path.join(pmDir, 'style/prosemirror.css'), '.ProseMirror { word-wrap: break-word; }');

  // 4. Emitted dist artifacts
  // Worker: byte-identical copy
  const emittedWorkerPath = path.join(distAssets, 'pdf.worker-CLesOks4.mjs');
  await writeFile(emittedWorkerPath, workerContent);

  // MathLive fonts: 19 emitted files + 1 inline base64 (Size3)
  const emittedFontPaths = new Map();
  let cssFontRules = '';

  for (const name of FONT_NAMES) {
    if (name === 'KaTeX_Size3-Regular.woff2') {
      const b64 = fontBuffers.get(name).toString('base64');
      cssFontRules += `@font-face{font-family:KaTeX_Size3;src:url(data:font/woff2;base64,${b64})format("woff2")}`;
    } else {
      const base = name.replace(/\.woff2$/, '');
      const emittedFilename = `${base}-H1234567.woff2`;
      const emittedPath = path.join(distAssets, emittedFilename);
      emittedFontPaths.set(name, emittedPath);
      await writeFile(emittedPath, fontBuffers.get(name));
      cssFontRules += `@font-face{font-family:${base.split('-')[0]};src:url(./${emittedFilename})format("woff2")}`;
    }
  }
  cssFontRules += ':root{--ML__static-fonts:true}';

  const mathliveCssPath = path.join(distAssets, 'mathlive-fonts-Bk27eonZ.css');
  await writeFile(mathliveCssPath, cssFontRules);

  const pmCssPath = path.join(distAssets, 'SourceView-ByzV39G-.css');
  await writeFile(pmCssPath, '.ProseMirror{position:relative;word-wrap:break-word}');

  // 5. Licensing evidence files
  const metaSrc = await readFile(path.join(realRepoRoot, 'docs/licensing/frontend-font-metadata.json'), 'utf8');
  await mkdir(path.join(root, 'docs/licensing'), { recursive: true });
  await writeFile(path.join(root, 'docs/licensing/frontend-font-metadata.json'), metaSrc);

  const oflSrc = await readFile(path.join(realRepoRoot, 'LICENSES/OFL-1.1.txt'), 'utf8');
  await mkdir(path.join(root, 'LICENSES'), { recursive: true });
  await writeFile(path.join(root, 'LICENSES/OFL-1.1.txt'), oflSrc);

  const installedOflPath = path.join(mathliveDir, 'OFL.txt');
  await writeFile(installedOflPath, oflSrc);

  const noticeSrc = await readFile(path.join(realRepoRoot, 'apps/frontend/THIRD_PARTY_NOTICES.md'), 'utf8');
  await mkdir(path.join(root, 'apps/frontend'), { recursive: true });
  await writeFile(path.join(root, 'apps/frontend/THIRD_PARTY_NOTICES.md'), noticeSrc);
  await writeFile(path.join(dist, 'THIRD_PARTY_NOTICES.md'), noticeSrc);

  return {
    root,
    dist,
    distAssets,
    emittedWorkerPath,
    workerContent,
    fontBuffers,
    emittedFontPaths,
    mathliveCssPath,
    pmCssPath,
    mathliveDir,
    mathliveFontsDir,
    installedOflPath,
    metaSrc,
    oflSrc,
    noticeSrc
  };
}

test('installed package junction outside repository is rejected before reading its sources', async () => {
  const { root } = await createFixture();
  const outside = await mkdtemp(path.join(os.tmpdir(), 'modutex-outside-package-'));
  try {
    await writeFile(path.join(outside, 'package.json'), JSON.stringify({ name: 'pdfjs-dist', version: '6.2.108' }));
    const installed = path.join(root, 'node_modules/pdfjs-dist');
    await rename(installed, installed + '.original');
    await symlink(outside, installed, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(() => collectAssetProvenance(root), /SOURCE_OUTSIDE_REPOSITORY/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('jointly truncated repo and installed font licenses with adjusted notices fail canonical hash and are rejected', async () => {
  const { root, installedOflPath, oflSrc } = await createFixture();
  try {
    const repoLicensePath = path.join(root, 'LICENSES/OFL-1.1.txt');
    const srcNoticesPath = path.join(root, 'apps/frontend/THIRD_PARTY_NOTICES.md');
    const distNoticesPath = path.join(root, 'apps/frontend/dist/THIRD_PARTY_NOTICES.md');

    const truncated = oflSrc.slice(0, 300);
    await writeFile(repoLicensePath, truncated);
    await writeFile(installedOflPath, truncated);

    const fullNotices = (await readFile(srcNoticesPath, 'utf8')).replace(/\r\n/g, '\n');
    const sourceBody = oflSrc.replace(/\r\n/g, '\n').trim();
    assert.ok(fullNotices.includes(sourceBody), 'fixture must contain the original body before replacing it');
    const adjustedNotices = fullNotices.replace(sourceBody, truncated.replace(/\r\n/g, '\n').trim());
    await writeFile(srcNoticesPath, adjustedNotices);
    await writeFile(distNoticesPath, adjustedNotices);

    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    const mismatch = result.unresolved.find(u => u.kind === 'tampered-or-mismatched-font-license-text');
    assert.ok(mismatch, 'Jointly truncated license copies must fail canonical OFL hash verification');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('jointly appended terms to repo and installed font licenses with adjusted notices fail canonical hash and are rejected', async () => {
  const { root, installedOflPath, oflSrc } = await createFixture();
  try {
    const repoLicensePath = path.join(root, 'LICENSES/OFL-1.1.txt');
    const srcNoticesPath = path.join(root, 'apps/frontend/THIRD_PARTY_NOTICES.md');
    const distNoticesPath = path.join(root, 'apps/frontend/dist/THIRD_PARTY_NOTICES.md');

    const appended = oflSrc + '\n\nADDITIONAL NON-STANDARD RESTRICTION: COMMERCIAL REDISTRIBUTION FORBIDDEN.\n';
    await writeFile(repoLicensePath, appended);
    await writeFile(installedOflPath, appended);

    const fullNotices = (await readFile(srcNoticesPath, 'utf8')).replace(/\r\n/g, '\n');
    const sourceBody = oflSrc.replace(/\r\n/g, '\n').trim();
    assert.ok(fullNotices.includes(sourceBody), 'fixture must contain the original body before replacing it');
    const adjustedNotices = fullNotices.replace(sourceBody, appended.replace(/\r\n/g, '\n').trim());
    await writeFile(srcNoticesPath, adjustedNotices);
    await writeFile(distNoticesPath, adjustedNotices);

    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    const mismatch = result.unresolved.find(u => u.kind === 'tampered-or-mismatched-font-license-text');
    assert.ok(mismatch, 'Jointly appended license terms must fail canonical OFL hash verification');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('jointly replaced MIT text under OFL.txt with adjusted notices fails canonical hash and is rejected', async () => {
  const { root, installedOflPath, oflSrc } = await createFixture();
  try {
    const repoLicensePath = path.join(root, 'LICENSES/OFL-1.1.txt');
    const srcNoticesPath = path.join(root, 'apps/frontend/THIRD_PARTY_NOTICES.md');
    const distNoticesPath = path.join(root, 'apps/frontend/dist/THIRD_PARTY_NOTICES.md');

    const mitText = 'Copyright (c) Arno Gourdol. Permission is hereby granted, free of charge (MIT)...';
    await writeFile(repoLicensePath, mitText);
    await writeFile(installedOflPath, mitText);

    const fullNotices = (await readFile(srcNoticesPath, 'utf8')).replace(/\r\n/g, '\n');
    const sourceBody = oflSrc.replace(/\r\n/g, '\n').trim();
    assert.ok(fullNotices.includes(sourceBody), 'fixture must contain the original body before replacing it');
    const adjustedNotices = fullNotices.replace(sourceBody, mitText);
    await writeFile(srcNoticesPath, adjustedNotices);
    await writeFile(distNoticesPath, adjustedNotices);

    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    const mismatch = result.unresolved.find(u => u.kind === 'tampered-or-mismatched-font-license-text');
    assert.ok(mismatch, 'MIT text placed under OFL.txt must fail canonical OFL hash verification');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('legitimate canonical OFL body passes with allowed CRLF and LF newline normalization across copies', async () => {
  const { root, installedOflPath, oflSrc } = await createFixture();
  try {
    const repoLicensePath = path.join(root, 'LICENSES/OFL-1.1.txt');
    const crlfOfl = oflSrc.replace(/\r?\n/g, '\r\n') + '\r\n';
    const lfOfl = '  \n' + oflSrc.replace(/\r\n/g, '\n') + '\n  ';

    await writeFile(repoLicensePath, crlfOfl);
    await writeFile(installedOflPath, lfOfl);

    const result = await collectAssetProvenance(root);
    assert.equal(result.verdict, 'asset-evidence-only-not-license-clearance');
    assert.ok(result.fontEmbeddedDeclarations);
    assert.equal(result.fontEmbeddedDeclarations.auditedFontCount, 20);
    assert.equal(result.fontEmbeddedDeclarations.oflTextIncludedInSourceNotice, true);
    assert.equal(result.fontEmbeddedDeclarations.oflTextIncludedInEmittedNotice, true);
    assert.equal(result.fontEmbeddedDeclarations.installedLicenseAgreesWithRepoLicense, true);
    assert.ok(!result.unresolved.some(u => u.kind === 'tampered-or-mismatched-font-license-text'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('legitimate fixture passes full evidence collection without clearance overclaims', async () => {
  const { root, fontBuffers } = await createFixture();
  try {
    const result = await collectAssetProvenance(root);
    assert.equal(result.verdict, 'asset-evidence-only-not-license-clearance');
    assert.equal(result.unresolved.length, 0);

    // PDF Worker verification
    assert.ok(result.pdfWorker);
    assert.equal(result.pdfWorker.byteMatch, true);
    assert.equal(result.pdfWorker.licenseNoticeHeaderPresent, true);
    assert.equal(result.pdfWorker.package, 'pdfjs-dist');
    assert.equal(result.pdfWorker.version, '6.2.108');

    // 20 MathLive fonts verification
    assert.equal(result.fonts.length, 20);
    assert.ok(result.fonts.every(f => f.byteMatch === true));
    assert.ok(result.fonts.every(f => f.licenseStatus === 'license-document-present'));
    assert.ok(result.fonts.every(f => f.version === '0.110.0'));

    const fileFonts = result.fonts.filter(f => f.sourceType === 'emitted-file');
    const inlineFonts = result.fonts.filter(f => f.sourceType === 'css-inline-base64');
    assert.equal(fileFonts.length, 19);
    assert.equal(inlineFonts.length, 1);
    assert.equal(inlineFonts[0].originalFilename, 'KaTeX_Size3-Regular.woff2');
    assert.equal(inlineFonts[0].bytes, fontBuffers.get('KaTeX_Size3-Regular.woff2').length);

    // CSS sources identification
    assert.ok(result.cssSources.length >= 2);
    const pmSource = result.cssSources.find(c => c.identifiedSource === 'prosemirror-view');
    assert.ok(pmSource);
    assert.equal(pmSource.byteMatch, false);
    assert.equal(pmSource.byteMatchNotice, 'transformed-by-build-pipeline-bytes-not-identical-to-source');

    const mlSource = result.cssSources.find(c => c.identifiedSource === 'mathlive');
    assert.ok(mlSource);
    assert.equal(mlSource.byteMatch, false);
    assert.equal(mlSource.byteMatchNotice, 'transformed-by-build-pipeline-bytes-not-identical-to-source');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tampered PDF worker bytes are reported as unresolved evidence mismatch', async () => {
  const { root, emittedWorkerPath, workerContent } = await createFixture();
  try {
    // Tamper the emitted worker by modifying content
    await writeFile(emittedWorkerPath, workerContent + '\n// tampered bytes');
    const result = await collectAssetProvenance(root);

    assert.equal(result.pdfWorker, null);
    const mismatch = result.unresolved.find(u => u.kind === 'tampered-or-mismatched-pdf-worker');
    assert.ok(mismatch);
    assert.notEqual(mismatch.emittedSha256, mismatch.installedSha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tampered font file and tampered inline base64 font are flagged as unresolved', async () => {
  const { root, emittedFontPaths, mathliveCssPath, fontBuffers } = await createFixture();
  try {
    // 1. Tamper an emitted font file
    const amsPath = emittedFontPaths.get('KaTeX_AMS-Regular.woff2');
    await writeFile(amsPath, Buffer.from('corrupted-font-content'));

    // 2. Tamper the inline base64 font in the CSS file
    const currentCss = (await readFile(mathliveCssPath)).toString('utf8');
    const validB64 = fontBuffers.get('KaTeX_Size3-Regular.woff2').toString('base64');
    const tamperedB64 = Buffer.from('corrupted-inline-bytes').toString('base64');
    await writeFile(mathliveCssPath, currentCss.replace(validB64, tamperedB64));

    const result = await collectAssetProvenance(root);

    assert.ok(result.unresolved.some(u => u.kind === 'tampered-or-unknown-font'));
    assert.ok(result.unresolved.some(u => u.kind === 'tampered-or-unknown-inline-font'));
    assert.ok(result.unresolved.some(u => u.kind === 'missing-emitted-font' && u.originalFilename === 'KaTeX_AMS-Regular.woff2'));
    assert.ok(result.unresolved.some(u => u.kind === 'missing-emitted-font' && u.originalFilename === 'KaTeX_Size3-Regular.woff2'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing emitted worker and deleted font files are detected and reported', async () => {
  const { root, emittedWorkerPath, emittedFontPaths } = await createFixture();
  try {
    await rm(emittedWorkerPath);
    const caligPath = emittedFontPaths.get('KaTeX_Caligraphic-Bold.woff2');
    await rm(caligPath);

    const result = await collectAssetProvenance(root);

    assert.ok(result.unresolved.some(u => u.kind === 'missing-emitted-pdf-worker'));
    assert.ok(result.unresolved.some(u => u.kind === 'missing-emitted-font-file'));
    assert.ok(result.unresolved.some(u => u.kind === 'missing-emitted-font' && u.originalFilename === 'KaTeX_Caligraphic-Bold.woff2'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('path traversal in CSS URL and external dist path are rejected', async () => {
  const { root, distAssets } = await createFixture();
  try {
    // Malicious CSS pointing outside the repository
    const maliciousCss = path.join(distAssets, 'malicious.css');
    await writeFile(maliciousCss, '@font-face{font-family:Hack;src:url("../../../../../outside.woff2")}');

    await assert.rejects(
      collectAssetProvenance(root),
      /SOURCE_OUTSIDE_REPOSITORY/
    );

    // Dist outside repository
    await assert.rejects(
      collectAssetProvenance(root, '../../outside-dist'),
      /DIST_OUTSIDE_REPOSITORY/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('symlink containment rejects outside links and artifact symlinks', async () => {
  const { root, distAssets } = await createFixture();
  try {
    const outsideTarget = path.join(os.tmpdir(), 'outside-symlink-target.woff2');
    await writeFile(outsideTarget, 'outside-font');

    const linkPath = path.join(distAssets, 'symlink-font.woff2');
    let symlinkCreated = false;
    try {
      await symlink(outsideTarget, linkPath);
      symlinkCreated = true;
    } catch (err) {
      // Windows without Developer Mode / SeCreateSymbolicLinkPrivilege may fail with EPERM/ENOTSUP
      if (err.code !== 'EPERM' && err.code !== 'ENOTSUP') throw err;
    }

    if (symlinkCreated) {
      await assert.rejects(
        collectAssetProvenance(root),
        /SYMLINK_OUTSIDE_REPOSITORY|SYMLINK_ARTIFACT/
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bundled embedded declarations evidence is verified when metadata and full OFL notices are present in source and emitted notices', async () => {
  const { root } = await createFixture();
  try {
    // 1. Copy real font metadata JSON into fixture
    const metaSrc = await readFile(path.join(realRepoRoot, 'docs/licensing/frontend-font-metadata.json'), 'utf8');
    await mkdir(path.join(root, 'docs/licensing'), { recursive: true });
    await writeFile(path.join(root, 'docs/licensing/frontend-font-metadata.json'), metaSrc);

    // 2. Copy official OFL license file
    const oflSrc = await readFile(path.join(realRepoRoot, 'LICENSES/OFL-1.1.txt'), 'utf8');
    await mkdir(path.join(root, 'LICENSES'), { recursive: true });
    await writeFile(path.join(root, 'LICENSES/OFL-1.1.txt'), oflSrc);

    // 3. Copy source and emitted THIRD_PARTY_NOTICES.md
    const noticeSrc = await readFile(path.join(realRepoRoot, 'apps/frontend/THIRD_PARTY_NOTICES.md'), 'utf8');
    await mkdir(path.join(root, 'apps/frontend'), { recursive: true });
    await writeFile(path.join(root, 'apps/frontend/THIRD_PARTY_NOTICES.md'), noticeSrc);
    await writeFile(path.join(root, 'apps/frontend/dist/THIRD_PARTY_NOTICES.md'), noticeSrc);

    const result = await collectAssetProvenance(root);
    assert.equal(result.verdict, 'asset-evidence-only-not-license-clearance');
    assert.ok(result.fontEmbeddedDeclarations, 'fontEmbeddedDeclarations must be populated when evidence files match');
    assert.equal(result.fontEmbeddedDeclarations.auditedFontCount, 20);
    assert.equal(result.fontEmbeddedDeclarations.distinctName13Declarations, 12);
    assert.equal(result.fontEmbeddedDeclarations.oflTextIncludedInSourceNotice, true);
    assert.equal(result.fontEmbeddedDeclarations.oflTextIncludedInEmittedNotice, true);

    assert.ok(result.fonts.every(f => f.licenseStatus === 'license-document-present'));
    assert.ok(!result.unresolved.some(u => u.kind.startsWith('font-')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tampered font metadata hash or entry count is detected and reported as unresolved evidence', async () => {
  const { root } = await createFixture();
  try {
    const metaSrc = JSON.parse(await readFile(path.join(realRepoRoot, 'docs/licensing/frontend-font-metadata.json'), 'utf8'));
    // Tamper a hash in metadata
    metaSrc.fonts[0].sha256 = '0000000000000000000000000000000000000000000000000000000000000000';

    await mkdir(path.join(root, 'docs/licensing'), { recursive: true });
    await writeFile(path.join(root, 'docs/licensing/frontend-font-metadata.json'), JSON.stringify(metaSrc));

    const oflSrc = await readFile(path.join(realRepoRoot, 'LICENSES/OFL-1.1.txt'), 'utf8');
    await mkdir(path.join(root, 'LICENSES'), { recursive: true });
    await writeFile(path.join(root, 'LICENSES/OFL-1.1.txt'), oflSrc);

    const noticeSrc = await readFile(path.join(realRepoRoot, 'apps/frontend/THIRD_PARTY_NOTICES.md'), 'utf8');
    await mkdir(path.join(root, 'apps/frontend'), { recursive: true });
    await writeFile(path.join(root, 'apps/frontend/THIRD_PARTY_NOTICES.md'), noticeSrc);
    await writeFile(path.join(root, 'apps/frontend/dist/THIRD_PARTY_NOTICES.md'), noticeSrc);

    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    const hashMismatch = result.unresolved.find(u => u.kind === 'font-metadata-hash-mismatch');
    assert.ok(hashMismatch, 'Tampered metadata hash must trigger font-metadata-hash-mismatch');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('absent or incomplete OFL text in emitted notices is flagged as unresolved font-notices-missing-ofl-text', async () => {
  const { root } = await createFixture();
  try {
    const metaSrc = await readFile(path.join(realRepoRoot, 'docs/licensing/frontend-font-metadata.json'), 'utf8');
    await mkdir(path.join(root, 'docs/licensing'), { recursive: true });
    await writeFile(path.join(root, 'docs/licensing/frontend-font-metadata.json'), metaSrc);

    const oflSrc = await readFile(path.join(realRepoRoot, 'LICENSES/OFL-1.1.txt'), 'utf8');
    await mkdir(path.join(root, 'LICENSES'), { recursive: true });
    await writeFile(path.join(root, 'LICENSES/OFL-1.1.txt'), oflSrc);

    const noticeSrc = await readFile(path.join(realRepoRoot, 'apps/frontend/THIRD_PARTY_NOTICES.md'), 'utf8');
    await mkdir(path.join(root, 'apps/frontend'), { recursive: true });
    await writeFile(path.join(root, 'apps/frontend/THIRD_PARTY_NOTICES.md'), noticeSrc);
    // Emitted notice omits the OFL text
    await writeFile(path.join(root, 'apps/frontend/dist/THIRD_PARTY_NOTICES.md'), '# Third-party notices\nIncomplete\n');

    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    const missingOfl = result.unresolved.find(u => u.kind === 'font-notices-missing-ofl-text');
    assert.ok(missingOfl, 'Notice omitting OFL text must be flagged as font-notices-missing-ofl-text');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing docs/licensing/frontend-font-metadata.json file is detected and fail-closed unresolved', async () => {
  const { root } = await createFixture();
  try {
    await rm(path.join(root, 'docs/licensing/frontend-font-metadata.json'));
    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(result.unresolved.some(u => u.kind === 'missing-font-metadata'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing LICENSES/OFL-1.1.txt file is detected and fail-closed unresolved', async () => {
  const { root } = await createFixture();
  try {
    await rm(path.join(root, 'LICENSES/OFL-1.1.txt'));
    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(result.unresolved.some(u => u.kind === 'missing-ofl-license-file'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing source or emitted THIRD_PARTY_NOTICES.md is detected and fail-closed unresolved', async () => {
  const { root } = await createFixture();
  try {
    await rm(path.join(root, 'apps/frontend/dist/THIRD_PARTY_NOTICES.md'));
    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(result.unresolved.some(u => u.kind === 'missing-emitted-notices-file'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('missing installed mathlive font is detected by bidirectional equality check', async () => {
  const { root, emittedFontPaths } = await createFixture();
  try {
    const missingName = 'KaTeX_Caligraphic-Bold.woff2';
    await rm(path.join(root, 'node_modules/mathlive/fonts', missingName));
    const emittedPath = emittedFontPaths.get(missingName);
    if (emittedPath) await rm(emittedPath);

    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(result.unresolved.some(u => u.kind === 'font-metadata-hash-mismatch'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('duplicate font path in metadata.fonts is rejected without Map overwrite and flagged as unresolved', async () => {
  const { root } = await createFixture();
  try {
    const metaPath = path.join(root, 'docs/licensing/frontend-font-metadata.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    meta.fonts[1].path = meta.fonts[0].path;
    await writeFile(metaPath, JSON.stringify(meta));

    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(result.unresolved.some(u => u.kind === 'font-metadata-corrupted' || u.kind === 'font-metadata-duplicate-path'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('duplicate font hash in metadata.fonts is rejected and flagged as unresolved', async () => {
  const { root } = await createFixture();
  try {
    const metaPath = path.join(root, 'docs/licensing/frontend-font-metadata.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    meta.fonts[1].sha256 = meta.fonts[0].sha256;
    await writeFile(metaPath, JSON.stringify(meta));

    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(result.unresolved.some(u => u.kind === 'font-metadata-corrupted'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extra font entry in metadata.fonts (21 entries) is detected as invalid entry count', async () => {
  const { root } = await createFixture();
  try {
    const metaPath = path.join(root, 'docs/licensing/frontend-font-metadata.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));
    const extraEntry = JSON.parse(JSON.stringify(meta.fonts[0]));
    extraEntry.path = 'node_modules/mathlive/fonts/KaTeX_Extra-Regular.woff2';
    extraEntry.sha256 = '1111111111111111111111111111111111111111111111111111111111111111';
    meta.fonts.push(extraEntry);
    await writeFile(metaPath, JSON.stringify(meta));

    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(result.unresolved.some(u => u.kind === 'font-metadata-entry-count-invalid' && u.count === 21));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extra installed font in mathlive/fonts directory causes bidirectional equality check to fail', async () => {
  const { root, fontBuffers } = await createFixture();
  try {
    const extraFontPath = path.join(root, 'node_modules/mathlive/fonts/KaTeX_Extra-Regular.woff2');
    await writeFile(extraFontPath, Buffer.from('extra-font-data-for-mathlive'));

    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(result.unresolved.some(u => u.kind === 'font-metadata-hash-mismatch'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('empty OFL license file (0 bytes) fails closed and does not pass substring check', async () => {
  const { root } = await createFixture();
  try {
    await writeFile(path.join(root, 'LICENSES/OFL-1.1.txt'), '');
    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(result.unresolved.some(u => u.kind === 'font-notices-missing-ofl-text'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('whitespace-only OFL text fails closed and is flagged as font-notices-missing-ofl-text', async () => {
  const { root } = await createFixture();
  try {
    await writeFile(path.join(root, 'LICENSES/OFL-1.1.txt'), '   \n\t  \r\n');
    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(result.unresolved.some(u => u.kind === 'font-notices-missing-ofl-text'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('empty metadata file (0 bytes) is flagged as font-metadata-corrupted', async () => {
  const { root } = await createFixture();
  try {
    await writeFile(path.join(root, 'docs/licensing/frontend-font-metadata.json'), '');
    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(result.unresolved.some(u => u.kind === 'font-metadata-corrupted'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('empty metadata object {} with missing fonts property is flagged as font-metadata-entry-count-invalid', async () => {
  const { root } = await createFixture();
  try {
    await writeFile(path.join(root, 'docs/licensing/frontend-font-metadata.json'), '{}');
    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(result.unresolved.some(u => u.kind === 'font-metadata-entry-count-invalid'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('empty path, sha256, names.13 array, or declaration string in metadata is flagged as font-metadata-corrupted', async () => {
  const { root } = await createFixture();
  try {
    const metaPath = path.join(root, 'docs/licensing/frontend-font-metadata.json');
    const validMeta = JSON.parse(await readFile(metaPath, 'utf8'));

    // 1. Empty path string
    const metaEmptyPath = JSON.parse(JSON.stringify(validMeta));
    metaEmptyPath.fonts[0].path = '';
    await writeFile(metaPath, JSON.stringify(metaEmptyPath));
    let result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(result.unresolved.some(u => u.kind === 'font-metadata-corrupted'));

    // 2. Empty sha256 string
    const metaEmptySha = JSON.parse(JSON.stringify(validMeta));
    metaEmptySha.fonts[0].sha256 = '';
    await writeFile(metaPath, JSON.stringify(metaEmptySha));
    result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(result.unresolved.some(u => u.kind === 'font-metadata-corrupted'));

    // 3. Empty names.13 array
    const metaEmptyName13 = JSON.parse(JSON.stringify(validMeta));
    metaEmptyName13.fonts[0].names['13'] = [];
    await writeFile(metaPath, JSON.stringify(metaEmptyName13));
    result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(result.unresolved.some(u => u.kind === 'font-metadata-corrupted'));

    // 4. Empty string inside names.13 array
    const metaEmptyDeclString = JSON.parse(JSON.stringify(validMeta));
    metaEmptyDeclString.fonts[0].names['13'] = [''];
    await writeFile(metaPath, JSON.stringify(metaEmptyDeclString));
    result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(result.unresolved.some(u => u.kind === 'font-metadata-corrupted'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('non-object or null metadata JSON is flagged as font-metadata-corrupted', async () => {
  const { root } = await createFixture();
  try {
    const metaPath = path.join(root, 'docs/licensing/frontend-font-metadata.json');

    for (const invalidJson of ['null', '123', 'true', '"a-string"']) {
      await writeFile(metaPath, invalidJson);
      const result = await collectAssetProvenance(root);
      assert.equal(result.fontEmbeddedDeclarations, null, `Must be null for ${invalidJson}`);
      assert.ok(
        result.unresolved.some(u => u.kind === 'font-metadata-corrupted'),
        `Must report font-metadata-corrupted for ${invalidJson}`
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('null or non-string path, sha256, names, or name13 declaration in metadata is flagged as font-metadata-corrupted', async () => {
  const { root } = await createFixture();
  try {
    const metaPath = path.join(root, 'docs/licensing/frontend-font-metadata.json');
    const validMeta = JSON.parse(await readFile(metaPath, 'utf8'));

    const badVariants = [
      m => { m.fonts[0].path = 123; },
      m => { m.fonts[0].path = null; },
      m => { m.fonts[0].sha256 = null; },
      m => { m.fonts[0].sha256 = 12345; },
      m => { m.fonts[0].names = null; },
      m => { m.fonts[0].names = 'not-an-object'; },
      m => { m.fonts[0].names['13'] = null; },
      m => { m.fonts[0].names['13'] = 'not-an-array'; },
      m => { m.fonts[0].names['13'] = [null]; },
      m => { m.fonts[0].names['13'] = [1234]; },
      m => { m.fonts[0].names['13'] = [{ text: 'decl' }]; }
    ];

    for (const mutate of badVariants) {
      const copy = JSON.parse(JSON.stringify(validMeta));
      mutate(copy);
      await writeFile(metaPath, JSON.stringify(copy));
      const result = await collectAssetProvenance(root);
      assert.equal(result.fontEmbeddedDeclarations, null);
      assert.ok(
        result.unresolved.some(u => u.kind === 'font-metadata-corrupted'),
        'Must report font-metadata-corrupted on invalid non-string or null'
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tampered installed font license text does not match repo license and is flagged as tampered-or-mismatched-font-license-text', async () => {
  const { root, installedOflPath, oflSrc } = await createFixture();
  try {
    const tampered = oflSrc.replace('SIL OPEN FONT LICENSE Version 1.1', 'TAMPERED MODIFIED FONT LICENSE Version 1.1');
    await writeFile(installedOflPath, tampered);
    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    const mismatch = result.unresolved.find(u => u.kind === 'tampered-or-mismatched-font-license-text');
    assert.ok(mismatch, 'Tampered installed license text must trigger tampered-or-mismatched-font-license-text');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('truncated installed font license text fails complete agreement and is flagged as tampered-or-mismatched-font-license-text', async () => {
  const { root, installedOflPath, oflSrc } = await createFixture();
  try {
    const truncated = oflSrc.slice(0, 300);
    await writeFile(installedOflPath, truncated);
    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    const mismatch = result.unresolved.find(u => u.kind === 'tampered-or-mismatched-font-license-text');
    assert.ok(mismatch, 'Truncated installed license text must trigger tampered-or-mismatched-font-license-text');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('extra content appended to installed font license text fails agreement and is flagged as tampered-or-mismatched-font-license-text', async () => {
  const { root, installedOflPath, oflSrc } = await createFixture();
  try {
    const extraContent = oflSrc + '\n\nADDITIONAL NON-STANDARD RESTRICTION: CANNOT BE REDISTRIBUTED COMMERCIALLY.\n';
    await writeFile(installedOflPath, extraContent);
    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    const mismatch = result.unresolved.find(u => u.kind === 'tampered-or-mismatched-font-license-text');
    assert.ok(mismatch, 'Extra content in installed license must trigger tampered-or-mismatched-font-license-text');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('absent installed font license resource fails closed and reports missing evidence without legal verdict', async () => {
  const { root, installedOflPath } = await createFixture();
  try {
    await rm(installedOflPath);
    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.equal(result.verdict, 'asset-evidence-only-not-license-clearance');
    assert.ok(
      result.unresolved.some(u => u.kind === 'missing-installed-font-license-resource' && u.package === 'mathlive'),
      'Must report missing-installed-font-license-resource naming missing evidence'
    );
    assert.ok(result.fonts.every(f => f.licenseStatus === 'license-document-missing'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('containment rejects installed font license resource symlink or junction pointing outside repository', async () => {
  const { root, installedOflPath, mathliveDir, oflSrc } = await createFixture();
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'modutex-outside-license-'));
  try {
    const outsideLicense = path.join(outsideDir, 'OUTSIDE_OFL.txt');
    await writeFile(outsideLicense, oflSrc);
    await rm(installedOflPath);
    let linked = false;
    try {
      await symlink(outsideLicense, installedOflPath, 'file');
      linked = true;
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'ENOTSUP') throw err;
    }

    if (!linked) {
      // On Windows unprivileged symlink failure, use actual supported junction for parent-directory escape
      const outsideFontsDir = path.join(outsideDir, 'fonts');
      await mkdir(outsideFontsDir, { recursive: true });
      await writeFile(path.join(outsideFontsDir, 'OFL.txt'), oflSrc);
      const fontsDir = path.join(mathliveDir, 'fonts');
      await rename(fontsDir, fontsDir + '.original');
      try {
        await symlink(outsideFontsDir, fontsDir, process.platform === 'win32' ? 'junction' : 'dir');
        linked = true;
      } catch (err) {
        if (err.code !== 'EPERM' && err.code !== 'ENOTSUP') throw err;
      }
    }

    if (!linked) {
      assert.fail('Unsupported coverage: neither symlink nor junction could be created');
    }

    await assert.rejects(
      () => collectAssetProvenance(root),
      /SOURCE_OUTSIDE_REPOSITORY/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test('LICENSE.txt containing package MIT text is never accepted as trusted OFL resource', async () => {
  const { root, installedOflPath, mathliveDir } = await createFixture();
  try {
    // Remove the valid OFL license file so only package-level LICENSE.txt (MIT) exists
    await rm(installedOflPath);
    await writeFile(path.join(mathliveDir, 'LICENSE.txt'), 'Copyright (c) Arno Gourdol. Permission is hereby granted (MIT)...');

    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(
      result.unresolved.some(u => u.kind === 'missing-installed-font-license-resource' && u.package === 'mathlive'),
      'Package MIT LICENSE.txt must never satisfy OFL resource requirement'
    );
    assert.ok(result.fonts.every(f => f.licenseStatus === 'license-document-missing'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('README mentioning OFL is never accepted as trusted OFL resource', async () => {
  const { root, installedOflPath, mathliveDir } = await createFixture();
  try {
    await rm(installedOflPath);
    await writeFile(path.join(mathliveDir, 'README.md'), '# MathLive\nThis package uses KaTeX fonts under SIL Open Font License 1.1.\n');

    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    assert.ok(
      result.unresolved.some(u => u.kind === 'missing-installed-font-license-resource' && u.package === 'mathlive'),
      'README.md mentioning OFL must never count as contained font license document'
    );
    assert.ok(result.fonts.every(f => f.licenseStatus === 'license-document-missing'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('arbitrary matching snippets in installed license fail complete agreement and are flagged as tampered-or-mismatched-font-license-text', async () => {
  const { root, installedOflPath } = await createFixture();
  try {
    // Snippet containing OFL markers but incomplete text
    const snippet = 'SIL OPEN FONT LICENSE Version 1.1\nPREAMBLE\nPERMISSION & CONDITIONS\nTERMINATION\n';
    await writeFile(installedOflPath, snippet);

    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    const mismatch = result.unresolved.find(u => u.kind === 'tampered-or-mismatched-font-license-text');
    assert.ok(mismatch, 'Snippet matching only keywords must not pass full license text agreement');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('empty installed font license file fails complete agreement and is flagged as tampered-or-mismatched-font-license-text', async () => {
  const { root, installedOflPath } = await createFixture();
  try {
    await writeFile(installedOflPath, '');

    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    const mismatch = result.unresolved.find(u => u.kind === 'tampered-or-mismatched-font-license-text');
    assert.ok(mismatch, 'Empty installed license file must trigger tampered-or-mismatched-font-license-text');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('tampered repo OFL license file fails agreement with installed license and is flagged as tampered-or-mismatched-font-license-text', async () => {
  const { root, oflSrc } = await createFixture();
  try {
    const repoLicensePath = path.join(root, 'LICENSES/OFL-1.1.txt');
    await writeFile(repoLicensePath, oflSrc + '\n// tampered repo-level license text\n');

    const result = await collectAssetProvenance(root);
    assert.equal(result.fontEmbeddedDeclarations, null);
    const mismatch = result.unresolved.find(u => u.kind === 'tampered-or-mismatched-font-license-text');
    assert.ok(mismatch, 'Tampered repo license file must trigger tampered-or-mismatched-font-license-text');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bounded inputs reject empty, whitespace, non-string rootDirectory and distDirectory', async () => {
  const { root } = await createFixture();
  try {
    await assert.rejects(() => collectAssetProvenance(''), TypeError);
    await assert.rejects(() => collectAssetProvenance('   '), TypeError);
    await assert.rejects(() => collectAssetProvenance(null), TypeError);
    await assert.rejects(() => collectAssetProvenance(undefined), TypeError);
    await assert.rejects(() => collectAssetProvenance(12345), TypeError);

    await assert.rejects(() => collectAssetProvenance(root, ''), TypeError);
    await assert.rejects(() => collectAssetProvenance(root, '   '), TypeError);
    await assert.rejects(() => collectAssetProvenance(root, null), TypeError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('containment rejects font metadata path symlink or junction escaping outside repository', async () => {
  const { root, mathliveDir } = await createFixture();
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), 'modutex-outside-font-'));
  try {
    const outsideFont = path.join(outsideDir, 'outside-font.woff2');
    await writeFile(outsideFont, Buffer.from('outside-font-bytes'));

    const metaPath = path.join(root, 'docs/licensing/frontend-font-metadata.json');
    const meta = JSON.parse(await readFile(metaPath, 'utf8'));

    const targetFont = path.join(root, meta.fonts[0].path);
    await rm(targetFont);
    let linked = false;
    try {
      await symlink(outsideFont, targetFont, 'file');
      linked = true;
    } catch (err) {
      if (err.code !== 'EPERM' && err.code !== 'ENOTSUP') throw err;
    }

    if (!linked) {
      const outsideFontsFolder = path.join(outsideDir, 'fonts');
      await mkdir(outsideFontsFolder, { recursive: true });
      await writeFile(path.join(outsideFontsFolder, 'KaTeX_AMS-Regular.woff2'), Buffer.from('outside-font-bytes'));
      const fontsDir = path.join(mathliveDir, 'fonts');
      await rename(fontsDir, fontsDir + '.original');
      try {
        await symlink(outsideFontsFolder, fontsDir, process.platform === 'win32' ? 'junction' : 'dir');
        linked = true;
      } catch (err) {
        if (err.code !== 'EPERM' && err.code !== 'ENOTSUP') throw err;
      }
    }

    if (!linked) {
      assert.fail('Unsupported coverage: neither symlink nor junction could be created');
    }

    await assert.rejects(
      () => collectAssetProvenance(root),
      /SOURCE_OUTSIDE_REPOSITORY/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});
