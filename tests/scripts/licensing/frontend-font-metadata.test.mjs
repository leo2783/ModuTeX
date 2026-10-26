import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '../../..');

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const normalizeEol = str => str.replace(/\r\n/g, '\n').trim();

// Expected 20 installed MathLive KaTeX font basenames and reserved font names
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

test('every installed font file binds byte-for-byte to metadata with matching SHA256 and exact count', async () => {
  const metadataPath = path.join(root, 'docs/licensing/frontend-font-metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));

  assert.equal(metadata.schemaVersion, 1, 'schemaVersion must be 1');
  assert.equal(
    metadata.verdict,
    'embedded-declarations-only-not-independent-clearance',
    'verdict must record embedded-declarations-only-not-independent-clearance'
  );
  assert.equal(
    metadata.method,
    'fontTools TTFont actual WOFF2 name table, IDs 0/13/14',
    'method must document fontTools TTFont actual WOFF2 extraction'
  );

  const installedFontDir = path.join(root, 'node_modules/mathlive/fonts');
  const dirEntries = await readdir(installedFontDir);
  const installedWoff2Files = dirEntries.filter(name => name.endsWith('.woff2')).sort();

  assert.equal(
    installedWoff2Files.length,
    20,
    'Filesystem node_modules/mathlive/fonts must contain exactly 20 .woff2 files'
  );
  assert.equal(
    metadata.fonts.length,
    20,
    'Metadata fonts array must contain exactly 20 entries'
  );

  // Check unique paths and unique hashes in metadata
  const seenPaths = new Set();
  const seenHashes = new Set();
  const metadataByBasename = new Map();

  for (const entry of metadata.fonts) {
    assert.ok(entry.path, 'Metadata entry must have a path property');
    assert.ok(!seenPaths.has(entry.path), `Duplicate font path found in metadata: ${entry.path}`);
    seenPaths.add(entry.path);

    assert.ok(entry.sha256, 'Metadata entry must have a sha256 property');
    assert.ok(!seenHashes.has(entry.sha256), `Duplicate SHA256 found in metadata: ${entry.sha256}`);
    seenHashes.add(entry.sha256);

    const base = path.basename(entry.path);
    metadataByBasename.set(base, entry);
  }

  // Cross-verify every installed file against metadata record
  for (const filename of installedWoff2Files) {
    const fullPath = path.join(installedFontDir, filename);
    const fileStat = await stat(fullPath);
    assert.ok(fileStat.isFile(), `Font file ${filename} must be regular file`);
    assert.ok(fileStat.size > 0, `Font file ${filename} must not be empty`);

    const bytes = await readFile(fullPath);
    const computedHash = digest(bytes);

    const record = metadataByBasename.get(filename);
    assert.ok(record, `Missing metadata record for installed font: ${filename}`);

    const expectedRelativePath = `node_modules/mathlive/fonts/${filename}`;
    assert.equal(
      record.path,
      expectedRelativePath,
      `Metadata path for ${filename} must match relative repo path`
    );
    assert.equal(
      computedHash,
      record.sha256,
      `Calculated disk SHA256 for ${filename} must match metadata sha256`
    );
  }

  // Ensure all 20 expected filenames are accounted for
  for (const expected of EXPECTED_FONTS) {
    assert.ok(
      metadataByBasename.has(expected.basename),
      `Expected font ${expected.basename} missing from metadata`
    );
  }
});

test('mandatory name table declarations (IDs 0, 13, 14) are non-empty and well-formed in every font entry', async () => {
  const metadataPath = path.join(root, 'docs/licensing/frontend-font-metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));

  for (const entry of metadata.fonts) {
    const base = path.basename(entry.path);
    assert.ok(entry.names, `names object missing in ${base}`);

    // name 0: Copyright notice
    const name0 = entry.names['0'];
    assert.ok(Array.isArray(name0) && name0.length > 0, `name ID 0 must be non-empty array in ${base}`);
    assert.ok(
      name0.some(val => val.includes('Khan Academy') || val.includes('Design Science')),
      `name ID 0 must contain copyright holders in ${base}`
    );

    // name 13: License description with Reserved Font Name and SIL OFL 1.1 declaration
    const name13 = entry.names['13'];
    assert.ok(Array.isArray(name13) && name13.length > 0, `name ID 13 must be non-empty array in ${base}`);
    assert.ok(
      name13.some(val => val.includes('SIL Open Font License, Version 1.1') && val.includes('Reserved Font Name')),
      `name ID 13 must mention SIL Open Font License, Version 1.1 and Reserved Font Name in ${base}`
    );

    // name 14: License info URL - must require actual expected OFL source URL
    const name14 = entry.names['14'];
    assert.ok(Array.isArray(name14) && name14.length > 0, `name ID 14 must be non-empty array in ${base}`);
    assert.ok(
      name14.every(val => val === 'http://scripts.sil.org/OFL'),
      `name ID 14 in ${base} must match exact expected OFL source URL 'http://scripts.sil.org/OFL'`
    );
  }
});

test('THIRD_PARTY_NOTICES.md preserves exact shipped font notice sections and full official OFL text', async () => {
  const metadataPath = path.join(root, 'docs/licensing/frontend-font-metadata.json');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));

  const noticesPath = path.join(root, 'apps/frontend/THIRD_PARTY_NOTICES.md');
  const noticesContent = await readFile(noticesPath, 'utf8');
  const normalizedNotices = normalizeEol(noticesContent);

  const officialOflPath = path.join(root, 'LICENSES/OFL-1.1.txt');
  const officialOflContent = await readFile(officialOflPath, 'utf8');
  const normalizedOfl = normalizeEol(officialOflContent);

  // Exact anchored section header check
  assert.ok(
    /^### MathLive bundled KaTeX fonts$/m.test(noticesContent),
    'THIRD_PARTY_NOTICES.md must contain exact anchored header: ### MathLive bundled KaTeX fonts'
  );

  // Distinguish fonts from code-only MIT notice
  assert.ok(
    noticesContent.includes("they are not covered by MathLive's code-only MIT notice or by a project Apache license"),
    'THIRD_PARTY_NOTICES.md must distinguish font licenses from code-only MIT notice'
  );

  // Reference to metadata JSON
  assert.ok(
    noticesContent.includes('docs/licensing/frontend-font-metadata.json'),
    'THIRD_PARTY_NOTICES.md must reference docs/licensing/frontend-font-metadata.json'
  );

  // Verify all unique name13 declarations from metadata appear in THIRD_PARTY_NOTICES.md
  const uniqueName13 = new Set();
  for (const font of metadata.fonts) {
    for (const decl of font.names['13']) {
      uniqueName13.add(decl);
    }
  }

  // Exactly 12 distinct name13 declarations exist across the 20 font files
  assert.equal(
    uniqueName13.size,
    12,
    'There must be exactly 12 distinct name 13 declarations across the 20 font files in metadata'
  );

  for (const decl of uniqueName13) {
    const normalizedDecl = normalizeEol(decl);
    assert.ok(
      normalizedNotices.includes(normalizedDecl),
      `Notice file must contain embedded name 13 declaration:\n${decl}`
    );
  }

  // Full unabridged text of LICENSES/OFL-1.1.txt must be preserved
  assert.ok(
    normalizedNotices.includes(normalizedOfl),
    'THIRD_PARTY_NOTICES.md must include the complete unabridged text of LICENSES/OFL-1.1.txt'
  );
});
