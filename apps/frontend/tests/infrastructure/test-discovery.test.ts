import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { discoverTests } from '../../scripts/run-tests.mjs';

const execute = promisify(execFile);
const runner = fileURLToPath(new URL('../../scripts/run-tests.mjs', import.meta.url));

test('CLI rejects empty suites and propagates genuine nested test outcomes', { timeout: 15_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'test-disc-cli-'));
  try {
    await assert.rejects(execute(process.execPath, [runner, root], { timeout: 5_000 }), error => {
      assert.equal((error as { code?: number }).code, 1);
      assert.match((error as { stderr: string }).stderr, /EMPTY_TEST_SUITE/);
      return true;
    });
    await mkdir(path.join(root, 'nested'));
    const fixture = path.join(root, 'nested', 'outcome.test.ts');
    await writeFile(fixture, "import test from 'node:test';\ntest('intentional nested failure', () => { throw new Error('fixture failure'); });\n");
    await assert.rejects(execute(process.execPath, [runner, root], { timeout: 5_000 }), error => {
      assert.equal((error as { code?: number }).code, 1);
      assert.match((error as { stdout: string }).stdout, /intentional nested failure/);
      return true;
    });
    await writeFile(fixture, "import test from 'node:test';\nimport { access } from 'node:fs/promises';\ntest('nested filesystem behavior', () => access(import.meta.filename));\n");
    const result = await execute(process.execPath, [runner, root], { timeout: 5_000 });
    assert.match(result.stdout, /nested filesystem behavior/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('discoverTests finds root and nested .test.ts files in deterministic sorted order', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'test-disc-'));
  try {
    await mkdir(path.join(tempRoot, 'feature-z'), { recursive: true });
    await mkdir(path.join(tempRoot, 'feature-a/nested'), { recursive: true });

    const fileRoot = path.join(tempRoot, 'root.test.ts');
    const fileZ = path.join(tempRoot, 'feature-z/sample-z.test.ts');
    const fileA = path.join(tempRoot, 'feature-a/sample-a.test.ts');
    const fileNested = path.join(tempRoot, 'feature-a/nested/deep.test.ts');

    await writeFile(fileRoot, '// test\n');
    await writeFile(fileZ, '// test\n');
    await writeFile(fileA, '// test\n');
    await writeFile(fileNested, '// test\n');

    const discovered = await discoverTests(tempRoot);
    const expected = [fileA, fileNested, fileZ, fileRoot].map(p => path.resolve(p)).sort((a, b) => a.localeCompare(b));

    assert.deepEqual(discovered, expected);
    assert.equal(discovered.length, 4);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('discoverTests excludes helpers, performance, and production scopes', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'test-disc-'));
  try {
    await mkdir(path.join(tempRoot, 'helpers/sub'), { recursive: true });
    await mkdir(path.join(tempRoot, 'performance'), { recursive: true });
    await mkdir(path.join(tempRoot, 'production'), { recursive: true });
    await mkdir(path.join(tempRoot, 'editor'), { recursive: true });

    const validTest = path.join(tempRoot, 'editor/view.test.ts');
    const helperTest = path.join(tempRoot, 'helpers/mock.test.ts');
    const helperSubTest = path.join(tempRoot, 'helpers/sub/deep.test.ts');
    const perfTest = path.join(tempRoot, 'performance/bench.test.ts');
    const prodTest = path.join(tempRoot, 'production/bundle.test.ts');

    await writeFile(validTest, '// test\n');
    await writeFile(helperTest, '// test\n');
    await writeFile(helperSubTest, '// test\n');
    await writeFile(perfTest, '// test\n');
    await writeFile(prodTest, '// test\n');

    const discovered = await discoverTests(tempRoot);
    assert.deepEqual(discovered, [path.resolve(validTest)]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('discoverTests excludes lookalikes and non-.test.ts files', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'test-disc-'));
  try {
    const validTest = path.join(tempRoot, 'valid.test.ts');
    const notTest = path.join(tempRoot, 'normal.ts');
    const jsTest = path.join(tempRoot, 'legacy.test.js');
    const mjsTest = path.join(tempRoot, 'module.test.mjs');
    const bakTest = path.join(tempRoot, 'backup.test.ts.bak');
    const dotTest = path.join(tempRoot, '.test.ts');
    const textFile = path.join(tempRoot, 'notes.txt');

    await writeFile(validTest, '// test\n');
    await writeFile(notTest, '// ts\n');
    await writeFile(jsTest, '// js\n');
    await writeFile(mjsTest, '// mjs\n');
    await writeFile(bakTest, '// bak\n');
    await writeFile(dotTest, '// dot\n');
    await writeFile(textFile, 'content\n');

    const discovered = await discoverTests(tempRoot);
    assert.deepEqual(discovered, [path.resolve(validTest)]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('discoverTests excludes symlink directory recursion', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'test-disc-'));
  try {
    const targetDir = path.join(tempRoot, 'real-feature');
    await mkdir(targetDir, { recursive: true });
    const realFile = path.join(targetDir, 'real.test.ts');
    await writeFile(realFile, '// test\n');

    const linkPath = path.join(tempRoot, 'link-feature');
    try {
      await symlink('real-feature', linkPath, 'dir');
    } catch {
      await symlink(targetDir, linkPath, 'junction');
    }

    const discovered = await discoverTests(tempRoot);
    // Only the real directory test file should be discovered, link-feature must not be recursed
    assert.deepEqual(discovered, [path.resolve(realFile)]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('discoverTests fails when directory is absent', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'test-disc-'));
  const nonExistentPath = path.join(tempRoot, 'absent');
  try {
  await assert.rejects(
    async () => {
      await discoverTests(nonExistentPath);
    },
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as NodeJS.ErrnoException).code, 'ENOENT');
      return true;
    }
  );
  } finally { await rm(tempRoot, { recursive: true, force: true }); }
});

test('discoverTests fails when target path is a file rather than a directory', async () => {
  const tempRoot = await mkdtemp(path.join(tmpdir(), 'test-disc-'));
  try {
    const filePath = path.join(tempRoot, 'not-a-dir.txt');
    await writeFile(filePath, 'data\n');

    await assert.rejects(
      async () => {
        await discoverTests(filePath);
      },
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.ok((err as Error).message.includes('NOT_A_DIRECTORY'));
        return true;
      }
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
