// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';

test('actual Windows EXE metadata matches the selected Tauri product and version', async () => {
  const configPath = resolve(process.env.MODUTEX_TEST_PACKAGE_CONFIG ?? 'apps/desktop-tauri/tauri.conf.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const executable = resolve(process.env.MODUTEX_TEST_PACKAGE_EXE ?? 'apps/desktop-tauri/target/release/modutex-desktop-tauri.exe');
  assert.match(config.version, /^\d+\.\d+\.\d+$/);
  const command = '$v=(Get-Item -LiteralPath $env:MODUTEX_METADATA_EXE -ErrorAction Stop).VersionInfo; [ordered]@{productName=$v.ProductName;productVersion=$v.ProductVersion;fileVersion=$v.FileVersion;major=$v.FileMajorPart;minor=$v.FileMinorPart;patch=$v.FileBuildPart;revision=$v.FilePrivatePart} | ConvertTo-Json -Compress';
  const output = await new Promise((accept, reject) => execFile(
    process.env.MODUTEX_TEST_PWSH ?? 'pwsh.exe', ['-NoProfile', '-Command', command],
    { windowsHide: true, timeout: 15000, env: { ...process.env, MODUTEX_METADATA_EXE: executable } },
    (error, stdout, stderr) => error ? reject(new Error(`${error.message}: ${stderr}`)) : accept(stdout),
  ));
  const metadata = JSON.parse(output);
  assert.equal(metadata.productName, config.productName, 'ProductName must identify the selected project');
  assert.equal(metadata.productVersion, config.version, 'ProductVersion must match the release source');
  assert.deepEqual([metadata.major, metadata.minor, metadata.patch, metadata.revision], [...config.version.split('.').map(Number), 0], 'numeric PE file version must match the release source');
  assert.match(metadata.fileVersion, /^\d+\.\d+\.\d+(?:\.0)?$/);
});
