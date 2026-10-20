// SPDX-License-Identifier: Apache-2.0
// Policy tests stub only the Windows signature-provider boundary; no signing claim.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

const verifier = resolve(process.env.MODUTEX_TEST_SIGNATURE_VERIFIER ?? 'scripts/distribution/verify-authenticode-signature.ps1');
const sample = resolve(process.env.MODUTEX_TEST_SIGNATURE_SAMPLE ?? 'apps/desktop-tauri/target/release/modutex-desktop-tauri.exe');
const pwsh = process.env.MODUTEX_TEST_PWSH ?? 'pwsh.exe';
async function verify({ status = 'Valid', actual = 'CN=Expected Publisher', expected = actual, timestamp = true, requireTimestamp = true, version } = {}) {
  const command = `
function Get-AuthenticodeSignature {
 param([string]$LiteralPath)
 $f = $env:MODUTEX_SIGNATURE_FIXTURE | ConvertFrom-Json
 [pscustomobject]@{Status=$f.status;StatusMessage='test provider';SignerCertificate=[pscustomobject]@{Subject=$f.actual};TimeStamperCertificate=$(if($f.timestamp){[pscustomobject]@{Subject='CN=Test timestamp'}}else{$null})}
}
$arguments=@{FilePath=$env:MODUTEX_SIGNATURE_SAMPLE;ExpectedSubject=$env:MODUTEX_SIGNATURE_EXPECTED}
if($env:MODUTEX_SIGNATURE_REQUIRE_TIMESTAMP -eq '1'){$arguments.RequireTimestamp=$true}
if($env:MODUTEX_SIGNATURE_VERSION){$arguments.CheckPeMetadata=$true;$arguments.ExpectedProductName='ModuTeX';$arguments.ExpectedProductVersion=$env:MODUTEX_SIGNATURE_VERSION}
& $env:MODUTEX_SIGNATURE_VERIFIER @arguments
`;
  const result = await new Promise(accept => execFile(pwsh, ['-NoProfile', '-Command', command], {
    windowsHide: true, timeout: 15000,
    env: { ...process.env, MODUTEX_SIGNATURE_VERIFIER: verifier, MODUTEX_SIGNATURE_SAMPLE: sample,
      MODUTEX_SIGNATURE_FIXTURE: JSON.stringify({ status, actual, timestamp }), MODUTEX_SIGNATURE_EXPECTED: expected,
      MODUTEX_SIGNATURE_REQUIRE_TIMESTAMP: requireTimestamp ? '1' : '0', MODUTEX_SIGNATURE_VERSION: version ?? '' },
  }, (error, stdout, stderr) => accept({ code: error?.code ?? 0, output: stdout + stderr })));
  assert.doesNotMatch(result.output, /ParserError|CommandNotFoundException/, 'a broken verifier must not count as a policy rejection');
  return result;
}

test('valid provider result still rejects an unexpected publisher', async () => {
  const result = await verify({ actual: 'CN=Other Publisher', expected: 'CN=Expected Publisher' });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /subject mismatch/i);
});
test('publisher text is literal and does not grant wildcard matching', async () => {
  const result = await verify({ expected: '*' });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /subject mismatch/i);
});
test('empty or whitespace expected publisher fails closed', async () => {
  for (const expected of ['', '   ']) {
    const result = await verify({ expected });
    assert.notEqual(result.code, 0, 'release signature verification requires an explicit publisher');
    assert.match(result.output, /ExpectedSubject|publisher/i);
  }
});
test('invalid trust result cannot be accepted with the expected publisher', async () => {
  const result = await verify({ status: 'NotTrusted' });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /NotTrusted/);
});
test('required timestamp cannot be replaced with a valid signing certificate', async () => {
  const result = await verify({ timestamp: false });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /TimeStamper certificate is missing/i);
});
test('real PE version cannot be accepted by a shorter version prefix', async () => {
  const result = await verify({ version: '0.2' });
  assert.notEqual(result.code, 0);
  assert.match(result.output, /ProductVersion mismatch/i);
});
test('the strict policy accepts the expected identity and current PE version', async () => {
  const result = await verify({ version: '0.2.1' });
  assert.equal(result.code, 0, result.output);
});
