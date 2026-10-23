// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const script = path.resolve('scripts/distribution/generate-updater-manifest.mjs');
function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'modutex-updater-manifest-'));
  t.after(() => {
    assert.equal(path.dirname(directory), tmpdir());
    assert.match(path.basename(directory), /^modutex-updater-manifest-/);
    rmSync(directory, { recursive: true, force: true });
  });
  const signature = path.join(directory, 'installer.exe.sig');
  const output = path.join(directory, 'latest.json');
  writeFileSync(signature, 'signed-fixture\n');
  const args = ['--version', '0.3.0', '--tag', 'v0.3.0', '--repo', 'leo2783/ModuTeX', '--installer-name', 'ModuTeX_0.3.0_x64-setup.exe', '--signature-file', signature, '--output', output];
  return { directory, signature, output, args };
}
function invoke(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 5000, windowsHide: true });
}

test('updater manifest binds version, final asset URL and detached signature', t => {
  const f = fixture(t);
  execFileSync(process.execPath, [script, ...f.args], { windowsHide: true });
  const manifest = JSON.parse(readFileSync(f.output, 'utf8'));
  assert.equal(manifest.version, '0.3.0');
  assert.equal(manifest.platforms['windows-x86_64'].signature, 'signed-fixture');
  assert.equal(manifest.platforms['windows-x86_64'].url, 'https://github.com/leo2783/ModuTeX/releases/download/v0.3.0/ModuTeX_0.3.0_x64-setup.exe');
  assert(Number.isFinite(Date.parse(manifest.pub_date)));
});

test('unknown, duplicate, missing and hostile arguments fail without producing a manifest', t => {
  const f = fixture(t);
  for (const tail of [['--unrecognized', 'x'], ['--version', '0.4.0'], ['--notes']]) {
    assert.notEqual(invoke([...f.args, ...tail]).status, 0);
  }
  for (const [flag, value] of [['--version', '0.3.0-beta.1'], ['--tag', 'v9.9.9'], ['--repo', 'bad/../repo'], ['--installer-name', '../outside.exe'], ['--pub-date', 'not-a-date']]) {
    const args = [...f.args];
    const index = args.indexOf(flag);
    if (index < 0) args.push(flag, value); else args[index + 1] = value;
    assert.notEqual(invoke(args).status, 0, flag);
  }
});

test('signature and existing output cannot be overwritten including Windows case aliases', t => {
  const f = fixture(t);
  const args = [...f.args];
  const sentinel = 'existing-user-file';
  writeFileSync(f.output, sentinel);
  assert.notEqual(invoke(args).status, 0);
  assert.equal(readFileSync(f.output, 'utf8'), sentinel);
  for (const output of [f.signature, ...(process.platform === 'win32' ? [f.signature.toUpperCase()] : [])]) {
    args[args.indexOf('--output') + 1] = output;
    assert.notEqual(invoke(args).status, 0);
    assert.equal(readFileSync(f.signature, 'utf8'), 'signed-fixture\n');
  }
});

test('oversized signature and long malformed version reject within finite resources', t => {
  const f = fixture(t);
  writeFileSync(f.signature, 'x'.repeat(16385));
  assert.notEqual(invoke(f.args).status, 0);
  writeFileSync(f.signature, 'signature');
  const args = [...f.args];
  args[1] = '9'.repeat(6000) + '.0.bad';
  const result = invoke(args);
  assert.notEqual(result.status, 0);
  assert.equal(result.error, undefined, 'must reject before the execution deadline');
});
