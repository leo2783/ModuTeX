import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inventoryFrontend } from '../../../scripts/licensing/frontend-artifacts.mjs';

const portable = value => value.split(path.sep).join('/');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

async function createBaseTree() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'package-containment-root-'));
  const dist = path.join(root, 'apps/frontend/dist');
  await mkdir(dist, { recursive: true });
  return { root, dist };
}

test('internal regular package.json and license evidence are accepted with valid hashes', async () => {
  const { root, dist } = await createBaseTree();
  try {
    const pkgDir = path.join(root, 'node_modules/internal-pkg');
    await mkdir(pkgDir, { recursive: true });

    const manifestContent = JSON.stringify({ name: 'internal-pkg', version: '1.0.0', license: 'MIT' }, null, 2);
    const licenseContent = 'MIT License\nCopyright (c) 2026 ModuTex\n';
    const sourceContent = 'export const msg = "ok";\n';

    await writeFile(path.join(pkgDir, 'package.json'), manifestContent, 'utf8');
    await writeFile(path.join(pkgDir, 'LICENSE'), licenseContent, 'utf8');
    await writeFile(path.join(pkgDir, 'index.js'), sourceContent, 'utf8');

    await writeFile(path.join(dist, 'index.js'), 'const msg = "ok";\n', 'utf8');
    await writeFile(
      path.join(dist, 'index.js.map'),
      JSON.stringify({
        version: 3,
        sources: ['../../../node_modules/internal-pkg/index.js'],
        sourcesContent: [sourceContent]
      }),
      'utf8'
    );

    const result = await inventoryFrontend(root);
    assert.equal(result.verdict, 'inventory-only-not-license-clearance');
    assert.equal(result.packages.length, 1);

    const pkg = result.packages[0];
    assert.equal(pkg.name, 'internal-pkg');
    assert.equal(pkg.version, '1.0.0');
    assert.equal(pkg.declaredLicense, 'MIT');
    assert.equal(pkg.manifestSha256, digest(Buffer.from(manifestContent)));
    assert.equal(pkg.documents.length, 1);
    assert.equal(pkg.documents[0].path, 'node_modules/internal-pkg/LICENSE');
    assert.equal(pkg.documents[0].text, licenseContent);
    assert.equal(pkg.documents[0].sha256, digest(Buffer.from(licenseContent)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('directory named LICENSE is ignored from documents and reported as missing-license-documents', async () => {
  const { root, dist } = await createBaseTree();
  try {
    const pkgDir = path.join(root, 'node_modules/dir-as-license');
    await mkdir(pkgDir, { recursive: true });

    const manifestContent = JSON.stringify({ name: 'dir-as-license', version: '1.0.0', license: 'MIT' });
    const sourceContent = 'export const test = true;\n';

    await writeFile(path.join(pkgDir, 'package.json'), manifestContent, 'utf8');
    await writeFile(path.join(pkgDir, 'index.js'), sourceContent, 'utf8');

    // Create a subdirectory named LICENSE (not a file or symlink)
    const fakeLicenseDir = path.join(pkgDir, 'LICENSE');
    await mkdir(fakeLicenseDir, { recursive: true });
    await writeFile(path.join(fakeLicenseDir, 'nested.txt'), 'nested content\n', 'utf8');

    await writeFile(path.join(dist, 'index.js'), 'const test = true;\n', 'utf8');
    await writeFile(
      path.join(dist, 'index.js.map'),
      JSON.stringify({
        version: 3,
        sources: ['../../../node_modules/dir-as-license/index.js'],
        sourcesContent: [sourceContent]
      }),
      'utf8'
    );

    const result = await inventoryFrontend(root);
    assert.equal(result.verdict, 'inventory-only-not-license-clearance');
    assert.equal(result.packages.length, 1);

    const pkg = result.packages[0];
    assert.equal(pkg.name, 'dir-as-license');
    // Directory is not collected into documents
    assert.deepEqual(pkg.documents, []);

    // Accurately assert missing-license-documents unresolved finding
    const missingFinding = result.unresolved.find(
      u => u.kind === 'missing-license-documents' && u.path === 'node_modules/dir-as-license'
    );
    assert.ok(missingFinding, 'Must report missing-license-documents for package whose LICENSE is a directory');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('license-file link escaping repository is rejected with PACKAGE_FILE_OUTSIDE_REPOSITORY', async () => {
  const { root, dist } = await createBaseTree();
  const externalDir = await mkdtemp(path.join(os.tmpdir(), 'package-containment-ext-license-'));
  try {
    const externalSub = path.join(externalDir, 'sub');
    await mkdir(externalSub, { recursive: true });
    await writeFile(
      path.join(externalSub, 'LICENSE'),
      'External proprietary license\n',
      'utf8'
    );

    const pkgDir = path.join(root, 'node_modules/escaped-license-pkg');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'escaped-license-pkg', version: '1.0.0' }),
      'utf8'
    );
    const sourceContent = 'export const testLicense = true;\n';
    await writeFile(path.join(pkgDir, 'index.js'), sourceContent, 'utf8');

    // Create a link named LICENSE that escapes root:
    // First attempt file symlink directly to externalSub/LICENSE.
    // On Windows unprivileged environments where file symlink fails,
    // fallback to directory junction named LICENSE pointing to externalSub.
    // In both cases, entry.isSymbolicLink() is true, and realpath(LICENSE) resolves
    // outside repository, causing readContained to reject with PACKAGE_FILE_OUTSIDE_REPOSITORY.
    const licenseLink = path.join(pkgDir, 'LICENSE');
    try {
      await symlink(path.join(externalSub, 'LICENSE'), licenseLink, 'file');
    } catch {
      await symlink(externalSub, licenseLink, 'junction');
    }

    await writeFile(path.join(dist, 'index.js'), 'const testLicense = true;\n', 'utf8');
    await writeFile(
      path.join(dist, 'index.js.map'),
      JSON.stringify({
        version: 3,
        sources: ['../../../node_modules/escaped-license-pkg/index.js'],
        sourcesContent: [sourceContent]
      }),
      'utf8'
    );

    await assert.rejects(
      async () => {
        await inventoryFrontend(root);
      },
      error => {
        assert.ok(error instanceof Error, 'Expected an Error');
        assert.match(
          error.message,
          /^PACKAGE_FILE_OUTSIDE_REPOSITORY: node_modules\/escaped-license-pkg\/LICENSE$/,
          `Expected PACKAGE_FILE_OUTSIDE_REPOSITORY: node_modules/escaped-license-pkg/LICENSE, got: ${error.message}`
        );
        return true;
      }
    );
  } finally {
    // Delete root first so junction is cleanly removed without deleting external target
    await rm(root, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});

test('manifest path symlink or directory junction escaping repository is rejected with PACKAGE_FILE_OUTSIDE_REPOSITORY', async () => {
  const { root, dist } = await createBaseTree();
  const externalDir = await mkdtemp(path.join(os.tmpdir(), 'package-containment-ext-pkg-'));
  try {
    await writeFile(
      path.join(externalDir, 'package.json'),
      JSON.stringify({ name: 'escaped-pkg', version: '9.9.9' }),
      'utf8'
    );

    // Keep mapped source internal under pkgDir/index.js
    const pkgDir = path.join(root, 'node_modules/escaped-pkg');
    await mkdir(pkgDir, { recursive: true });
    const sourceContent = 'export const val = 123;\n';
    await writeFile(path.join(pkgDir, 'index.js'), sourceContent, 'utf8');

    // Create manifest link named package.json in pkgDir that escapes repository.
    // Try genuine file symlink first. If Windows unprivileged environment lacks SeCreateSymbolicLinkPrivilege,
    // fallback to directory junction named package.json pointing to externalDir.
    // In readContained:
    //   const actual = await realpath(manifestPath);
    //   if (!inside(root, actual)) throw new Error(`PACKAGE_FILE_OUTSIDE_REPOSITORY: ${relative(file)}`);
    //   if (!(await stat(actual)).isFile()) throw new Error(`PACKAGE_FILE_NOT_FILE: ${relative(file)}`);
    // Since realpath check occurs BEFORE isFile(), a junction named package.json genuinely triggers
    // PACKAGE_FILE_OUTSIDE_REPOSITORY without moving mapped source outside repository!
    const packageJsonLink = path.join(pkgDir, 'package.json');
    let usedJunctionFallback = false;
    try {
      await symlink(path.join(externalDir, 'package.json'), packageJsonLink, 'file');
    } catch {
      await symlink(externalDir, packageJsonLink, 'junction');
      usedJunctionFallback = true;
    }

    await writeFile(path.join(dist, 'index.js'), 'const val = 123;\n', 'utf8');
    await writeFile(
      path.join(dist, 'index.js.map'),
      JSON.stringify({
        version: 3,
        sources: ['../../../node_modules/escaped-pkg/index.js'],
        sourcesContent: [sourceContent]
      }),
      'utf8'
    );

    await assert.rejects(
      async () => {
        await inventoryFrontend(root);
      },
      error => {
        assert.ok(error instanceof Error, 'Expected an Error');
        assert.match(
          error.message,
          /^PACKAGE_FILE_OUTSIDE_REPOSITORY: node_modules\/escaped-pkg\/package\.json$/,
          `Expected PACKAGE_FILE_OUTSIDE_REPOSITORY error, got: ${error.message}`
        );
        return true;
      }
    );
  } finally {
    // Delete root first so junction is cleanly removed without deleting external target
    await rm(root, { recursive: true, force: true });
    await rm(externalDir, { recursive: true, force: true });
  }
});
