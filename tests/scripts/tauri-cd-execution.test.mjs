// SPDX-License-Identifier: Apache-2.0
// Executes shipped workflow blocks with isolated process-boundary fixtures.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { load } from 'js-yaml';

const workflowPath = resolve(process.env.MODUTEX_TEST_CD_WORKFLOW ?? '.github/workflows/tauri-release.yml');
const workflow = load(await readFile(workflowPath, 'utf8'));
const quote = s => `'${s.replaceAll("'", "''")}'`;
function block(job, name) {
  const value = workflow.jobs[job].steps.find(s => s.name === name)?.run;
  assert(value, 'test must use the actual workflow step');
  return value.replaceAll('${{ needs.validate-release-target.outputs.release_version }}', '0.2.1')
    .replaceAll('${{ steps.signpath_status.outputs.configured }}', 'false')
    .replaceAll('${{ vars.SIGNPATH_EXPECTED_PUBLISHER }}', 'CN=Expected Publisher');
}
async function execute(fixture, source, prelude, environment = {}) {
  const script = join(fixture, 'exercise.ps1');
  await writeFile(script, `$ErrorActionPreference='Stop'\n$global:LASTEXITCODE=0\n${prelude}\ntry {\n${source}\n[IO.File]::WriteAllText('result.json','{"accepted":true}')\n} catch {\n[IO.File]::WriteAllText('result.json',(@{accepted=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress))\n}\n`);
  await new Promise((ok, fail) => execFile(process.env.MODUTEX_TEST_PWSH ?? 'pwsh.exe', ['-NoProfile', '-File', script],
    { cwd: fixture, windowsHide: true, timeout: 15000, env: { ...process.env, TAG: 'v0.2.1',
      PACKAGE_VERSION: '0.2.1', SIGNPATH_CONFIGURED: 'false',
      EXPECTED_TESTED_EXE_SHA: createHash('sha256').update('original').digest('hex'),
      GITHUB_OUTPUT: join(fixture, 'github-output.txt'), ...environment } },
    (e, out, err) => e ? fail(new Error(`${e.message}: ${out} ${err}`)) : ok()));
  return JSON.parse(await readFile(join(fixture, 'result.json'), 'utf8'));
}

for (const state of ['unsigned-no-publisher', 'unsigned-with-publisher', 'signed-with-publisher', 'signed-no-publisher']) {
  test(`actual CD bundle preserves child PowerShell parameter binding: ${state}`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'modutex-cd-payload-binding-'));
    try {
      const exe = join(fixture, 'apps/desktop-tauri/target/x86_64-pc-windows-msvc/release/modutex-desktop-tauri.exe');
      const installer = join(fixture, 'apps/desktop-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/ModuTeX_0.2.1_x64-setup.exe');
      const engine = join(fixture, 'vendor/tectonic/windows-x64/tectonic.exe');
      const verifier = join(fixture, 'scripts/distribution/verify-installer-payload.ps1');
      for (const filename of [exe, installer, engine, verifier]) {
        await mkdir(resolve(filename, '..'), { recursive: true });
        await writeFile(filename, 'original');
      }
      // Execute the shipped parameter declarations in a real child pwsh process.
      // Only the expensive archive/Authenticode provider body is replaced.
      const declarations = (await readFile(resolve('scripts/distribution/verify-installer-payload.ps1'), 'utf8'))
        .split('Set-StrictMode -Version Latest')[0];
      await writeFile(verifier, declarations + `
$ErrorActionPreference='Stop'
if($ExpectedBundledExeSha256 -ne $env:EXPECTED_TESTED_EXE_SHA -or $ExpectedTectonicSha256 -ne $env:EXPECTED_TESTED_EXE_SHA){throw 'Payload identity arguments changed'}
if($ExpectedProductName -ne 'ModuTeX' -or $ExpectedProductVersion -ne '0.2.1'){throw 'Product metadata arguments changed'}
if($ReceiptPath -ne '.verification-artifacts/tauri/payload-receipt-release.json'){throw 'Receipt argument was lost'}
@{signerBound=$PSBoundParameters.ContainsKey('OurSignerSubject');signer=$OurSignerSubject} | ConvertTo-Json -Compress | Set-Content -LiteralPath 'payload-binding.json'
exit 0
`);
      const signed = state.startsWith('signed-');
      const publisher = state.endsWith('no-publisher') ? '' : 'CN=ModuTeX Publisher, O=Fixture Organization';
      const result = await execute(fixture,
        block('release-build-and-sign', 'Stage 2 - Bundle NSIS installer preserving target executable'), `
function npx {
 param([Parameter(ValueFromRemainingArguments=$true)][string[]]$TaskArgs)
 [IO.File]::WriteAllText(${quote(installer)},'fresh-installer')
 $global:LASTEXITCODE=0
}
`, {
          SIGNPATH_CONFIGURED: signed ? 'true' : 'false', EXPECTED_PUBLISHER: publisher,
          EXPECTED_SIGNED_EXE_SHA: signed ? createHash('sha256').update('original').digest('hex') : ''
        });
      if (state === 'signed-no-publisher') {
        assert.equal(result.accepted, false);
        assert.match(result.error, /signed publisher is missing/);
        await assert.rejects(readFile(join(fixture, 'payload-binding.json')), { code: 'ENOENT' });
        return;
      }
      assert.equal(result.accepted, true, JSON.stringify(result));
      const binding = JSON.parse(await readFile(join(fixture, 'payload-binding.json'), 'utf8'));
      assert.equal(binding.signerBound, signed, 'unsigned verification must omit the optional signer argument');
      assert.equal(binding.signer, signed ? publisher : '');
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });
}

for (const fault of ['unchanged', 'modified-executable', 'bundle-failed', 'payload-rejected']) {
  test(`actual CD bundle block: ${fault}`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'modutex-cd-bundle-'));
    try {
      const exe = join(fixture, 'apps/desktop-tauri/target/x86_64-pc-windows-msvc/release/modutex-desktop-tauri.exe');
      const installer = join(fixture, 'apps/desktop-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/ModuTeX_0.2.1_x64-setup.exe');
      const engine = join(fixture, 'vendor/tectonic/windows-x64/tectonic.exe');
      for (const path of [exe, installer, engine]) { await mkdir(resolve(path, '..'), { recursive: true }); await writeFile(path, 'original'); }
      const prelude = `
function npx {
 param([Parameter(ValueFromRemainingArguments=$true)][string[]]$TaskArgs)
 if (($TaskArgs -join ' ') -notmatch '^(?:--no-install )?tauri bundle .*--no-binary-patching') {throw 'CD invoked a build rather than bundle'}
 ${fault === 'modified-executable' ? `[IO.File]::WriteAllText(${quote(exe)},'changed')` : ''}
 [IO.File]::WriteAllText(${quote(installer)},'fresh-installer')
 $global:LASTEXITCODE=${fault === 'bundle-failed' ? 37 : 0}
}
function pwsh {
 param([Parameter(ValueFromRemainingArguments=$true)][object[]]$TaskArgs)
 [IO.File]::WriteAllText('payload-called','yes')
 $global:LASTEXITCODE=${fault === 'payload-rejected' ? 19 : 0}
}
`;
      const result = await execute(fixture, block('release-build-and-sign', 'Stage 2 - Bundle NSIS installer preserving target executable'), prelude);
      assert.equal(result.accepted, fault === 'unchanged', JSON.stringify(result));
      if (fault === 'modified-executable') assert.match(result.error, /modified during bundle|re-compiled/i);
      if (fault === 'bundle-failed') assert.match(result.error, /exit code 37/);
      if (fault === 'payload-rejected') assert.match(result.error, /verification failed/i);
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });
}

for (const state of ['verified-signed', 'missing-signed-output', 'wrong-signed-output', 'invalid-signpath-status']) {
  test(`actual CD bundle validates verified signing output: ${state}`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'modutex-cd-signed-bundle-'));
    try {
      const exe = join(fixture, 'apps/desktop-tauri/target/x86_64-pc-windows-msvc/release/modutex-desktop-tauri.exe');
      const installer = join(fixture, 'apps/desktop-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/ModuTeX_0.2.1_x64-setup.exe');
      const engine = join(fixture, 'vendor/tectonic/windows-x64/tectonic.exe');
      for (const filename of [exe, installer, engine]) {
        await mkdir(resolve(filename, '..'), { recursive: true });
        await writeFile(filename, filename === exe ? 'verified-signed-boundary-fixture' : 'fixture');
      }
      const prelude = `
function npx {
 param([Parameter(ValueFromRemainingArguments=$true)][string[]]$TaskArgs)
 [IO.File]::WriteAllText(${quote(join(fixture, 'bundle-called'))},'yes')
 [IO.File]::WriteAllText(${quote(installer)},'fresh-installer')
 $global:LASTEXITCODE=0
}
function pwsh {
 param([Parameter(ValueFromRemainingArguments=$true)][object[]]$TaskArgs)
 $global:LASTEXITCODE=0
}
`;
      const signedDigest = createHash('sha256').update('verified-signed-boundary-fixture').digest('hex');
      const result = await execute(fixture,
        block('release-build-and-sign', 'Stage 2 - Bundle NSIS installer preserving target executable'),
        prelude, {
          SIGNPATH_CONFIGURED: state === 'invalid-signpath-status' ? '' : 'true',
          EXPECTED_PUBLISHER: 'CN=Expected Publisher',
          EXPECTED_SIGNED_EXE_SHA: state === 'missing-signed-output' ? '' :
            state === 'wrong-signed-output' ? '0'.repeat(64) : signedDigest
        });
      assert.equal(result.accepted, state === 'verified-signed', JSON.stringify(result));
      const bundled = await readFile(join(fixture, 'bundle-called'), 'utf8')
        .catch(error => { if (error.code === 'ENOENT') return null; throw error; });
      assert.equal(bundled !== null, state === 'verified-signed', 'invalid identity must stop before bundling');
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });
}

for (const state of ['published', 'lookup-failed', 'draft']) {
  test(`actual CD release block: ${state}`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'modutex-cd-release-'));
    try {
      await mkdir(join(fixture, 'dist-release')); await writeFile(join(fixture, 'dist-release/artifact.exe'), 'fixture');
      const prelude = `
function gh {
 param([Parameter(ValueFromRemainingArguments=$true)][string[]]$TaskArgs)
 if ($TaskArgs[1] -eq 'view') {
  $global:LASTEXITCODE=${state === 'lookup-failed' ? 1 : 0}
  ${state === 'lookup-failed' ? "'HTTP 503 service unavailable'" : `'${JSON.stringify({ isDraft: state === 'draft', tagName: 'v0.2.1' })}'`}
 } else {
  [IO.File]::WriteAllText('release-write',($TaskArgs -join ' '));$global:LASTEXITCODE=0
 }
}
`;
      const result = await execute(fixture, block('stage-draft-release', 'Create or update draft GitHub release'), prelude);
      assert.equal(result.accepted, state === 'draft', JSON.stringify(result));
      const written = await readFile(join(fixture, 'release-write'), 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      assert.equal(written !== null, state === 'draft', 'published releases and failed lookups must not mutate assets');
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });
}
