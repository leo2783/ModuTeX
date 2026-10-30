// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
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

test('owned process traversal rejects stale parent PIDs reused by a newer host', { skip: !windows }, async () => {
  const output = await run(process.env.MODUTEX_TEST_PWSH ?? 'pwsh.exe', ['-NoProfile', '-Command', `
. ./tests/scripts/helpers/owned-process-diagnostics.ps1
function Entry($id, $parent, $seconds) {
  [pscustomobject]@{ProcessId=$id;ParentProcessId=$parent;CreationDate=([datetime]'2026-01-01').AddSeconds($seconds)}
}
# The unrelated older runner still names PID 100 as its historical parent.
$entries=@((Entry 300 200 30),(Entry 900 800 1),(Entry 200 100 20),(Entry 800 100 2),(Entry 100 50 10))
$ids=Get-OwnedProcessIds -OwnedProcessId 100 -Processes $entries
ConvertTo-Json -InputObject @($ids | Sort-Object) -Compress
$missing=Get-OwnedProcessIds -OwnedProcessId 50 -Processes $entries
if($missing.Count -ne 0){throw 'Absent root must not claim descendants'}
`], { cwd: resolve(import.meta.dirname, '../..') });
  assert.deepEqual(JSON.parse(output), [100, 200, 300]);
});

for (const mode of ['transient', 'permanent', 'repeated', 'deadline', 'mirror-deadline']) {
  test(`MiKTeX download resumes only transient transfers within the original budget: ${mode}`, { skip: !windows }, async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'modutex-download-resume-'));
    await writeFile(join(fixture, 'transfer.mjs'), `
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
const [folder,mode]=process.argv.slice(2), counter=join(folder,'attempts.txt');
const count=Number(await readFile(counter,'utf8').catch(()=>0))+1;
await writeFile(counter,String(count));
const partial=join(folder,'partial-package');
if(count===1) await writeFile(partial,'retained-partial');
if(mode==='transient'&&count===2) {
 if(await readFile(partial,'utf8')!=='retained-partial') throw Error('Partial download lost');
 console.log('resumed-success');
} else {
 console.error(mode==='permanent'?'archive checksum mismatch':'Timeout was reached; code="28"');
 if(mode.endsWith('deadline')) await new Promise(resolve=>setTimeout(resolve,5000));
 process.exitCode=1;
}
`);
    const command = `
$ErrorActionPreference='Stop'
. ./tests/scripts/helpers/ci-bounded-process.ps1
$seconds=if($env:MODUTEX_TRANSFER_MODE -eq 'deadline'){1}else{10}
$script:CiProcessDeadline=[DateTime]::UtcNow.AddSeconds($seconds)
$originalDeadline=$script:CiProcessDeadline
$transferSeconds=if($env:MODUTEX_TRANSFER_MODE -eq 'mirror-deadline'){1}else{10}
try {
 Invoke-CiResumableDownload -FilePath $env:MODUTEX_RUNTIME_NODE -Arguments @((Join-Path $env:MODUTEX_RUNTIME_FIXTURE 'transfer.mjs'),$env:MODUTEX_RUNTIME_FIXTURE,$env:MODUTEX_TRANSFER_MODE) -LogPath (Join-Path $env:MODUTEX_RUNTIME_FIXTURE 'download.log') -PortableRoot $env:MODUTEX_RUNTIME_FIXTURE -TimeoutSeconds $transferSeconds
} finally { if($script:CiProcessDeadline -ne $originalDeadline) { throw 'Provisioning deadline was changed' } }
`;
    try {
      const execute = () => run(process.env.MODUTEX_TEST_PWSH ?? 'pwsh.exe', ['-NoProfile', '-Command', command], {
        cwd: resolve(import.meta.dirname, '../..'),
        env: { ...process.env, MODUTEX_RUNTIME_FIXTURE: fixture, MODUTEX_RUNTIME_NODE: process.execPath, MODUTEX_TRANSFER_MODE: mode }
      });
      if (mode === 'transient') {
        assert.match(await execute(), /resumed-success/);
        assert.match(await readFile(join(fixture, 'download.log.attempt-1.stderr.log'), 'utf8'), /code="28"/);
      } else {
        await assert.rejects(execute(), mode.endsWith('deadline') ? /bounded deadline|budget exhausted/ : /MiKTeX command failed/);
      }
      assert.equal(Number(await readFile(join(fixture, 'attempts.txt'), 'utf8')), ['transient', 'repeated'].includes(mode) ? 2 : 1,
        'permanent errors and exhausted deadlines must never be retried');
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });
}

test('CDP readiness accepts a live owned loopback endpoint without generating failure evidence', { skip: !windows }, async () => {
  const evidence = await mkdtemp(join(tmpdir(), 'modutex-cdp-ready-'));
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const script = `require('node:http').createServer((_request,response)=>response.end(JSON.stringify({Browser:'WebView2 fixture',webSocketDebuggerUrl:'ws://127.0.0.1:${port}/devtools/browser/test'}))).listen(${port},'127.0.0.1',()=>console.log('ready'));`;
  const app = spawn(process.execPath, ['-e', script, '--', `--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  app.stderr.on('data', data => { stderr += data; });
  try {
    await waitNativeCdp({ app, port, evidence, lane: 'ready-test',
      stderr: () => stderr, launchError: () => undefined, timeoutMs: 5000 });
    assert.deepEqual(await readdir(evidence), [], 'successful ownership validation creates no failure receipt');
  } finally {
    app.kill();
    await once(app, 'close');
    await rm(evidence, { recursive: true, force: true });
  }
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
