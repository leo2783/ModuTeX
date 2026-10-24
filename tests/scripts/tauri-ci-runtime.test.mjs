// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { waitNativeCdp } from './helpers/wait-native-cdp.mjs';

const windows = process.platform === 'win32';
const run = (file, args, options = {}) => new Promise((accept, reject) => execFile(file, args,
  { windowsHide: true, timeout: 20000, ...options }, (error, stdout, stderr) =>
    error ? reject(Error(`${error}: ${stdout} ${stderr}`)) : accept(stdout)));

test('CDP readiness accepts a live endpoint without generating failure evidence', async () => {
  const server = createServer((_request, response) => response.end('{}'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await waitNativeCdp({ app: { exitCode: null }, port: server.address().port,
      stderr: () => '', launchError: () => undefined, timeoutMs: 500 });
  } finally { server.close(); }
});

test('CDP timeout preserves live owned process evidence and stderr before caller cleanup', { skip: !windows }, async () => {
  const evidence = await mkdtemp(join(tmpdir(), 'modutex-cdp-evidence-'));
  const app = spawn(process.execPath, ['-e', 'console.error("launch-tail");setInterval(()=>{},1000)'],
    { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  app.stderr.on('data', data => { stderr += data; });
  await once(app.stderr, 'data');
  const server = createServer((_request, response) => { response.statusCode = 503; response.end(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await assert.rejects(waitNativeCdp({ app, port: server.address().port, evidence,
      lane: 'timeout-test', stderr: () => stderr, launchError: () => undefined, timeoutMs: 100 }), /CDP endpoint unavailable/);
    const diagnostic = JSON.parse(await readFile(join(evidence, 'timeout-test-startup-e2e.json')));
    assert.equal(app.exitCode, null, 'helper must record before the caller terminates its host');
    assert.match(diagnostic.stderr, /launch-tail/);
    assert.equal(diagnostic.snapshotError, undefined);
    assert(diagnostic.processes.some(p => p.processId === app.pid && p.commandLine.includes('launch-tail')));
    assert(!diagnostic.processes.some(p => p.processId === process.pid));
    assert(diagnostic.processes.every(p => 'sessionId' in p && 'mainWindowTitle' in p));
  } finally {
    server.close();
    app.kill();
    await once(app, 'close');
    await rm(evidence, { recursive: true, force: true });
  }
});

test('bounded MiKTeX runner captures portable logs and descendant tree before terminating a hung command', { skip: !windows }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'modutex-bounded-process-'));
  const portable = join(fixture, 'portable with spaces');
  await mkdir(join(portable, 'miktex/log'), { recursive: true });
  await writeFile(join(portable, 'miktex/log/lualatex.log'), 'x'.repeat(2 * 1048576) + 'internal engine log\n');
  const script = join(fixture, 'hung command.mjs');
  await writeFile(script, `import {spawn} from 'node:child_process';
spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});
console.log('prewarm-output');console.error('prewarm-stderr');setInterval(()=>{},1000);`);
  const command = `
$ErrorActionPreference = 'Stop'
. ./tests/scripts/helpers/ci-bounded-process.ps1
$log = Join-Path $env:MODUTEX_RUNTIME_FIXTURE 'prewarm.log'
$portable = Join-Path $env:MODUTEX_RUNTIME_FIXTURE 'portable with spaces'
try {
 Invoke-CiBoundedProcess -FilePath $env:MODUTEX_RUNTIME_NODE -Arguments @((Join-Path $env:MODUTEX_RUNTIME_FIXTURE 'hung command.mjs')) -LogPath $log -PortableRoot $portable -TimeoutSeconds 1
 throw 'Expected timeout'
} catch {
 if ($_ -notmatch 'exceeded its bounded deadline') { throw }
}
exit 0
`;
  try {
    await run(process.env.MODUTEX_TEST_PWSH ?? 'pwsh.exe', ['-NoProfile', '-Command', command], {
      cwd: resolve(import.meta.dirname, '../..'),
      env: { ...process.env, MODUTEX_RUNTIME_FIXTURE: fixture, MODUTEX_RUNTIME_NODE: process.execPath }
    });
    assert.match(await readFile(join(fixture, 'prewarm.log'), 'utf8'), /prewarm-output/);
    assert.match(await readFile(join(fixture, 'prewarm.log.stderr.log'), 'utf8'), /prewarm-stderr/);
    const engineLog = await readFile(join(fixture, 'portable-internal/miktex/log/lualatex.log'), 'utf8');
    assert.equal(engineLog.length, 1048576, 'portable log snapshot is limited to 1 MiB');
    assert.match(engineLog, /internal engine log/);
    const owned = JSON.parse(await readFile(join(fixture, 'prewarm.log.processes.json'), 'utf8'));
    assert(owned.length >= 2, 'root and its actual descendant are recorded');
    assert.equal(owned.filter(p => /node\.exe$/i.test(p.executablePath ?? '')).length, 2);
    assert(owned.some(p => p.commandLine.includes('hung command.mjs')));
    for (const process of owned) assert.throws(() => globalThis.process.kill(process.processId, 0), /ESRCH/);
  } finally { await rm(fixture, { recursive: true, force: true }); }
});
