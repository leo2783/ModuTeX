// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const quote = value => "'" + value.replaceAll("'", "''") + "'";
const helper = new URL('./helpers/download-workflow-artifact.ps1', import.meta.url);
for (const [name, codes, attempts, passed] of [
  ['success', [0], 1, true],
  ['503 then success', [503, 0], 2, true],
  ['native stderr 503 then success', [503, 0], 2, true],
  ['429 then 502 then success', [429, 502, 0], 3, true],
  ['500 then 504 then success', [500, 504, 0], 3, true],
  ['503 exhaustion', [503, 503, 503, 503], 4, false],
  ['authentication rejection', [401], 1, false],
  ['authorization rejection', [403], 1, false],
  ['missing artifact', [404], 1, false],
  ['unknown error', [1], 1, false]
]) {
  test(`artifact transport: ${name}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'modutex-transport-'));
    try {
      const script = join(directory, 'exercise.ps1');
      await mkdir(join(directory, 'temp'));
      await writeFile(script, `$ErrorActionPreference='Stop'
$env:RUNNER_TEMP=${quote(join(directory, 'temp'))}
$global:attempts=0
$global:destinations=@()
$global:sleeps=@()
$codes=@(${codes.join(',')})
function Start-Sleep { param($Seconds) $global:sleeps+= $Seconds }
function gh {
  $values=@($args)
  if ($values[0] -ne 'run' -or $values[1] -ne 'download' -or $values[2] -ne '123') { throw 'Run identity changed' }
  if ($values[4] -ne 'Exact-Artifact') { throw 'Artifact identity changed' }
  $stage=$values[6]
  if (@(Get-ChildItem -LiteralPath $stage -Force).Count -ne 0) { throw 'Attempt reused partial files' }
  $global:destinations+= $stage
  $code=$codes[$global:attempts]
  $global:attempts++
  'partial' | Set-Content -LiteralPath (Join-Path $stage 'partial.bin')
  if ($code -eq 0) {
    Remove-Item -LiteralPath (Join-Path $stage 'partial.bin')
    New-Item -ItemType Directory -Path (Join-Path $stage '.vite') | Out-Null
    'complete' | Set-Content -LiteralPath (Join-Path $stage '.vite/manifest.json')
    $global:LASTEXITCODE=0
  } else {
    ${name.startsWith('native') ? `& node -e 'console.error("HTTP 503 https://storage.invalid/file?sig=SECRET"); process.exit(1)'
    $global:LASTEXITCODE=$LASTEXITCODE` : `"HTTP $code https://storage.invalid/file?sig=SECRET" | Write-Output`}
    $global:LASTEXITCODE=1
  }
}
$passed=$false
$message=''
try { & ${quote(helper.pathname.replace(/^\/(\w:)/, '$1'))} -RunId '123' -ArtifactName 'Exact-Artifact' -Destination ${quote(join(directory, 'result'))}; $passed=$true }
catch { $message=$_.Exception.Message }
@{passed=$passed; attempts=$global:attempts; sleeps=$global:sleeps; destinations=$global:destinations; message=$message; leftovers=@(Get-ChildItem -LiteralPath $env:RUNNER_TEMP -Force).Count} | ConvertTo-Json -Compress | Set-Content -LiteralPath ${quote(join(directory, 'receipt.json'))}
`);
      const result = spawnSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-File', script],
        {encoding: 'utf8', windowsHide: true, timeout: 15000});
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const receipt = JSON.parse(await readFile(join(directory, 'receipt.json'), 'utf8'));
      assert.equal(receipt.passed, passed, receipt.message);
      assert.equal(receipt.attempts, attempts);
      assert.deepEqual(receipt.sleeps, [5, 15, 30].slice(0, attempts - 1));
      assert.equal(new Set(receipt.destinations).size, attempts);
      assert.equal(receipt.leftovers, 0);
      assert(!`${result.stdout}${result.stderr}${receipt.message}`.includes('SECRET'));
      if (passed) assert.equal((await readFile(join(directory, 'result/.vite/manifest.json'), 'utf8')).trim(), 'complete');
      else await assert.rejects(readFile(join(directory, 'result/partial.bin')));
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  });
}
