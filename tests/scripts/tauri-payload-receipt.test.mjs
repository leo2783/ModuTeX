// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const verifier = resolve(process.env.MODUTEX_TEST_PAYLOAD_VERIFIER ?? 'scripts/distribution/verify-installer-payload.ps1');
for (const collision of ['installer', 'source-file']) {
  test(`payload receipt must not delete or replace the ${collision}`, async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'modutex-payload-receipt-'));
    try {
      const installer = join(fixture, 'candidate.exe');
      const source = join(fixture, 'package.json');
      await writeFile(installer, 'fixture-installer'); await writeFile(source, '{"source":true}');
      const receipt = collision === 'installer' ? installer : source;
      const result = await new Promise(accept => execFile(process.env.MODUTEX_TEST_PWSH ?? 'pwsh.exe', [
        '-NoProfile', '-File', verifier, '-InstallerPath', installer,
        '-ExpectedBundledExeSha256', '0'.repeat(64), '-ReceiptPath', receipt,
      ], { cwd: fixture, windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => accept({ code: error?.code ?? 0, output: stdout + stderr })));
      assert.notEqual(result.code, 0);
      assert.doesNotMatch(result.output, /ParserError|CommandNotFoundException/);
      assert.equal(await readFile(installer, 'utf8'), 'fixture-installer');
      assert.equal(await readFile(source, 'utf8'), '{"source":true}');
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });
}
