import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const EXCLUDED_DIRS = new Set(['helpers', 'performance', 'production']);

export async function discoverTests(directory) {
  const root = path.resolve(directory);
  const targetStat = await stat(root);
  if (!targetStat.isDirectory()) {
    throw new Error(`NOT_A_DIRECTORY: ${root}`);
  }

  const results = [];

  async function walk(current) {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) {
          continue;
        }
        await walk(path.join(current, entry.name));
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.test.ts') && entry.name !== '.test.ts') {
          results.push(path.resolve(current, entry.name));
        }
      }
    }
  }

  await walk(root);
  results.sort((a, b) => a.localeCompare(b));
  return results;
}

async function runCli() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const frontendWorkspace = path.resolve(scriptDir, '..');
  const targetDir = process.argv[2]
    ? path.resolve(frontendWorkspace, process.argv[2])
    : path.join(frontendWorkspace, 'tests');

  const testFiles = await discoverTests(targetDir);
  if (testFiles.length === 0) {
    process.stderr.write(`EMPTY_TEST_SUITE: No .test.ts files found in ${targetDir}\n`);
    process.exit(1);
  }

  const args = ['--max-old-space-size=512', '--test', '--test-concurrency=1', ...testFiles];
  // This is an independent test invocation, not a worker of an enclosing suite.
  // Inheriting Node's internal context silently skips the discovered files.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, args, {
    cwd: frontendWorkspace,
    env,
    stdio: 'inherit'
  });

  child.on('error', error => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    if (signal) {
      try { process.kill(process.pid, signal); }
      catch { process.exitCode = 1; }
    } else {
      process.exit(code ?? 1);
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().catch(err => {
    process.stderr.write(`${err.stack || err.message}\n`);
    process.exit(1);
  });
}
