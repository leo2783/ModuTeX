import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { collectAssetProvenance } from '../../../scripts/licensing/frontend-asset-origins.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../../..');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizeEol = str => str.replace(/\r\n/g, '\n').trim();

// Expected 20 MathLive bundled KaTeX font basenames and reserved font names
const EXPECTED_FONTS = [
  { basename: 'KaTeX_AMS-Regular.woff2', rfn: 'KaTeX_AMS' },
  { basename: 'KaTeX_Caligraphic-Bold.woff2', rfn: 'KaTeX_Caligraphic' },
  { basename: 'KaTeX_Caligraphic-Regular.woff2', rfn: 'KaTeX_Caligraphic' },
  { basename: 'KaTeX_Fraktur-Bold.woff2', rfn: 'KaTeX_Fraktur' },
  { basename: 'KaTeX_Fraktur-Regular.woff2', rfn: 'KaTeX_Fraktur' },
  { basename: 'KaTeX_Main-Bold.woff2', rfn: 'KaTeX_Main' },
  { basename: 'KaTeX_Main-BoldItalic.woff2', rfn: 'KaTeX_Main' },
  { basename: 'KaTeX_Main-Italic.woff2', rfn: 'KaTeX_Main' },
  { basename: 'KaTeX_Main-Regular.woff2', rfn: 'KaTeX_Main' },
  { basename: 'KaTeX_Math-BoldItalic.woff2', rfn: 'KaTeX_Math' },
  { basename: 'KaTeX_Math-Italic.woff2', rfn: 'KaTeX_Math' },
  { basename: 'KaTeX_SansSerif-Bold.woff2', rfn: 'KaTeX_SansSerif' },
  { basename: 'KaTeX_SansSerif-Italic.woff2', rfn: 'KaTeX_SansSerif' },
  { basename: 'KaTeX_SansSerif-Regular.woff2', rfn: 'KaTeX_SansSerif' },
  { basename: 'KaTeX_Script-Regular.woff2', rfn: 'KaTeX_Script' },
  { basename: 'KaTeX_Size1-Regular.woff2', rfn: 'KaTeX_Size1' },
  { basename: 'KaTeX_Size2-Regular.woff2', rfn: 'KaTeX_Size2' },
  { basename: 'KaTeX_Size3-Regular.woff2', rfn: 'KaTeX_Size3' },
  { basename: 'KaTeX_Size4-Regular.woff2', rfn: 'KaTeX_Size4' },
  { basename: 'KaTeX_Typewriter-Regular.woff2', rfn: 'KaTeX_Typewriter' }
];

test('installed fonts and metadata JSON match SHA256 and exactly 20 entries with unique paths', async () => {
  const metadataPath = path.join(root, 'docs/licensing/frontend-font-metadata.json');
  const metadataContent = await readFile(metadataPath, 'utf8');
  const metadata = JSON.parse(metadataContent);

  assert.equal(metadata.schemaVersion, 1, 'metadata schemaVersion must be 1');
  assert.equal(metadata.verdict, 'embedded-declarations-only-not-independent-clearance');
  assert.equal(metadata.fonts.length, 20, 'metadata must contain exactly 20 font entries');

  const uniquePaths = new Set(metadata.fonts.map(f => f.path));
  assert.equal(uniquePaths.size, 20, 'All 20 metadata entries must have unique paths');

  const uniqueSha256s = new Set(metadata.fonts.map(f => f.sha256));
  assert.equal(uniqueSha256s.size, 20, 'All 20 metadata entries must have distinct SHA256 digests');

  for (const entry of metadata.fonts) {
    const fullFontPath = path.join(root, entry.path);
    const fontBytes = await readFile(fullFontPath);
    const calculatedSha = digest(fontBytes);

    assert.equal(
      calculatedSha,
      entry.sha256,
      `Actual disk SHA256 for ${entry.path} must match metadata sha256`
    );
    assert.ok(fontBytes.length > 0, `Font binary ${entry.path} must not be empty`);

    // Verify name table IDs 0, 13, 14 exist in metadata
    assert.ok(entry.names['0']?.length > 0, `Missing name ID 0 for ${entry.path}`);
    assert.ok(entry.names['13']?.length > 0, `Missing name ID 13 for ${entry.path}`);
    assert.ok(entry.names['14']?.length > 0, `Missing name ID 14 for ${entry.path}`);
  }

  // Ensure all 20 expected filenames are represented
  for (const expected of EXPECTED_FONTS) {
    const found = metadata.fonts.find(f => path.basename(f.path) === expected.basename);
    assert.ok(found, `Expected font ${expected.basename} not found in metadata`);
  }
});

test('embedded name13 declarations and official OFL-1.1 text are faithfully documented in THIRD_PARTY_NOTICES.md', async () => {
  const metadataPath = path.join(root, 'docs/licensing/frontend-font-metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));

  const noticesPath = path.join(root, 'apps/frontend/THIRD_PARTY_NOTICES.md');
  const noticesContent = await readFile(noticesPath, 'utf8');

  const officialOflPath = path.join(root, 'LICENSES/OFL-1.1.txt');
  const officialOflContent = await readFile(officialOflPath, 'utf8');

  // Verify font section header using exact anchored line
  assert.ok(
    /^### MathLive bundled KaTeX fonts$/m.test(noticesContent),
    'THIRD_PARTY_NOTICES.md must contain exact anchored header: ### MathLive bundled KaTeX fonts'
  );

  // MathLive package MIT notice must not be mistaken for font license
  assert.ok(
    noticesContent.includes("they are not covered by MathLive's code-only MIT notice or by a project Apache license"),
    'THIRD_PARTY_NOTICES.md must distinguish font license from code-only MIT notice'
  );

  // Compare every embedded name ID 13 declaration to notices content
  const distinctName13Declarations = new Set();
  for (const font of metadata.fonts) {
    for (const decl of font.names['13']) {
      distinctName13Declarations.add(decl);
    }
  }

  // Twelve distinct embedded declarations are represented among the 20 files.
  assert.equal(distinctName13Declarations.size, 12);
  for (const decl of distinctName13Declarations) {
    const normalizedDecl = normalizeEol(decl);
    assert.ok(
      normalizeEol(noticesContent).includes(normalizedDecl),
      `Notice file must contain embedded declaration:\n${decl}`
    );
  }

  // Compare full official OFL-1.1 text to notice content
  assert.ok(
    normalizeEol(noticesContent).includes(normalizeEol(officialOflContent)),
    'THIRD_PARTY_NOTICES.md must contain the full, unabridged text of LICENSES/OFL-1.1.txt'
  );
});

test('existing asset origins collector validates byte identity of emitted fonts against installed MathLive fonts in production distribution', async () => {
  // Production distribution is strictly required; absence must fail closed rather than early return
  const distPath = path.join(root, 'apps/frontend/dist-tauri');
  const distStat = await stat(distPath);
  assert.ok(distStat.isDirectory(), 'Production distribution directory apps/frontend/dist-tauri must exist');

  const provenance = await collectAssetProvenance(root);
  assert.equal(provenance.verdict, 'asset-evidence-only-not-license-clearance');

  // Provenance must inspect all 20 fonts
  assert.equal(provenance.fonts.length, 20, 'Provenance must inspect exactly 20 fonts');

  // Every matched font must have byteMatch: true against installed MathLive source
  for (const fontRecord of provenance.fonts) {
    assert.equal(fontRecord.package, 'mathlive');
    assert.equal(fontRecord.byteMatch, true, `Emitted font ${fontRecord.originalFilename} must byte-match installed source`);
    assert.equal(
      fontRecord.licenseStatus,
      'hash-and-notice-evidence-verified',
      'Actual font hashes, embedded declarations and complete OFL notices must agree'
    );
  }

  // Emitted notice file in production dist is strictly required
  const emittedNoticePath = path.join(distPath, 'THIRD_PARTY_NOTICES.md');
  const emittedNoticeStat = await stat(emittedNoticePath);
  assert.ok(emittedNoticeStat.isFile(), 'Production distribution file apps/frontend/dist-tauri/THIRD_PARTY_NOTICES.md must exist');

  const srcNotice = await readFile(path.join(root, 'apps/frontend/THIRD_PARTY_NOTICES.md'), 'utf8');
  const emittedNotice = await readFile(emittedNoticePath, 'utf8');
  assert.equal(
    normalizeEol(emittedNotice),
    normalizeEol(srcNotice),
    'Emitted THIRD_PARTY_NOTICES.md in dist must match apps/frontend/THIRD_PARTY_NOTICES.md exactly'
  );
});

test('isolated filesystem fixture with modified installed font bytes produces tampered-or-unknown-font and missing-emitted-font in real collector', async () => {
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'modutex-font-fixture-'));
  try {
    const dist = path.join(fixtureRoot, 'apps/frontend/dist-tauri');
    const distAssets = path.join(dist, 'assets');
    await mkdir(distAssets, { recursive: true });

    // 1. Setup real installed mathlive font files from the actual repository
    const mathliveDir = path.join(fixtureRoot, 'node_modules/mathlive');
    const mathliveFontsDir = path.join(mathliveDir, 'fonts');
    await mkdir(mathliveFontsDir, { recursive: true });
    await writeFile(path.join(mathliveDir, 'package.json'), JSON.stringify({
      name: 'mathlive',
      version: '0.110.0',
      license: 'MIT'
    }));

    // Setup dummy pdfjs-dist and prosemirror-view so collector does not fail on unrelated dependencies
    const pdfjsDir = path.join(fixtureRoot, 'node_modules/pdfjs-dist/build');
    await mkdir(pdfjsDir, { recursive: true });
    await writeFile(path.join(fixtureRoot, 'node_modules/pdfjs-dist/package.json'), JSON.stringify({
      name: 'pdfjs-dist',
      version: '6.2.108',
      license: 'Apache-2.0'
    }));
    const workerContent = `/**
 * @licstart The following is the entire license notice for the
 * JavaScript code in this page
 * Copyright 2024 Mozilla Foundation
 * Licensed under the Apache License, Version 2.0 (the "License");
 * @licend
 */
export function pdfWorker() { return "worker"; }
`;
    await writeFile(path.join(pdfjsDir, 'pdf.worker.mjs'), workerContent);
    await writeFile(path.join(distAssets, 'pdf.worker-CLesOks4.mjs'), workerContent);

    const pmDir = path.join(fixtureRoot, 'node_modules/prosemirror-view/style');
    await mkdir(pmDir, { recursive: true });
    await writeFile(path.join(fixtureRoot, 'node_modules/prosemirror-view/package.json'), JSON.stringify({
      name: 'prosemirror-view',
      version: '1.41.9',
      license: 'MIT'
    }));
    await writeFile(path.join(pmDir, 'prosemirror.css'), '.ProseMirror { word-wrap: break-word; }');

    // Read actual installed font bytes from real disk for all 20 fonts
    const installedFontBytesMap = new Map();
    for (const expected of EXPECTED_FONTS) {
      const actualPath = path.join(root, 'node_modules/mathlive/fonts', expected.basename);
      const realBytes = await readFile(actualPath);
      installedFontBytesMap.set(expected.basename, realBytes);
      // Write actual font bytes into fixture installed fonts dir
      await writeFile(path.join(mathliveFontsDir, expected.basename), realBytes);
    }

    // Emit 19 fonts to distAssets, and 1 inline base64 in CSS, but tamper one font file copy
    const tamperedFontName = 'KaTeX_AMS-Regular.woff2';
    let cssContent = '';

    for (const expected of EXPECTED_FONTS) {
      const origBytes = installedFontBytesMap.get(expected.basename);
      if (expected.basename === 'KaTeX_Size3-Regular.woff2') {
        const b64 = origBytes.toString('base64');
        cssContent += `@font-face{font-family:KaTeX_Size3;src:url(data:font/woff2;base64,${b64})format("woff2")}`;
      } else if (expected.basename === tamperedFontName) {
        // Tamper this emitted font copy by altering bytes
        const tamperedBytes = Buffer.from(origBytes);
        tamperedBytes[0] ^= 0xff; // Invert first byte to tamper
        const emittedFilename = `${expected.basename.replace(/\.woff2$/, '')}-HASH1234.woff2`;
        await writeFile(path.join(distAssets, emittedFilename), tamperedBytes);
        cssContent += `@font-face{font-family:KaTeX_AMS;src:url(./${emittedFilename})format("woff2")}`;
      } else {
        const emittedFilename = `${expected.basename.replace(/\.woff2$/, '')}-HASH1234.woff2`;
        await writeFile(path.join(distAssets, emittedFilename), origBytes);
        cssContent += `@font-face{font-family:${expected.rfn};src:url(./${emittedFilename})format("woff2")}`;
      }
    }
    cssContent += ':root{--ML__static-fonts:true}';
    await writeFile(path.join(distAssets, 'mathlive-fonts.css'), cssContent);

    // Run the actual production collector API on the fixture
    const result = await collectAssetProvenance(fixtureRoot);

    // Verify collector observed tampered-or-unknown-font
    const tamperedFinding = result.unresolved.find(u => u.kind === 'tampered-or-unknown-font');
    assert.ok(tamperedFinding, 'Collector must flag tampered-or-unknown-font for modified font file copy');

    // Verify collector observed missing-emitted-font for the font whose valid bytes were not emitted
    const missingFinding = result.unresolved.find(
      u => u.kind === 'missing-emitted-font' && u.originalFilename === tamperedFontName
    );
    assert.ok(missingFinding, `Collector must flag missing-emitted-font for ${tamperedFontName}`);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
