// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const nsis = process.env.MODUTEX_TEST_MAKENSIS;
const run = (file, args, options = {}) => new Promise(accept => execFile(file, args,
  { windowsHide: true, timeout: 20000, ...options }, (error, stdout, stderr) => accept({ error, stdout, stderr })));
const exists = path => access(path).then(() => true, () => false);
const config = JSON.parse(await readFile('apps/desktop-tauri/tauri.conf.json', 'utf8'));
const hook = resolve('apps/desktop-tauri', config.bundle.windows.nsis.installerHooks);

test('both installer configurations retain the reviewed uninstall hook', async () => {
  const offline = JSON.parse(await readFile('apps/desktop-tauri/tauri.offline.conf.json', 'utf8'));
  assert.equal(config.bundle.windows.nsis.installerHooks, 'windows/installer-hooks.nsh');
  assert.equal(offline.bundle.windows.nsis.installerHooks ?? config.bundle.windows.nsis.installerHooks,
    'windows/installer-hooks.nsh');
  assert.match(await readFile(hook, 'utf8'), /NSIS_HOOK_PREUNINSTALL/);
});

test('real NSIS rejects locked leftovers and retries transient executable locks before removing metadata',
  { skip: !nsis }, async () => {
    const fixture = await mkdtemp(join(tmpdir(), 'modutex-nsis-lock-'));
    try {
      for (const mode of ['original', 'transient', 'permanent']) {
        const folder = join(fixture, mode);
        const install = join(folder, 'installation with spaces');
        await mkdir(install, { recursive: true });
        const installer = join(folder, 'installer.exe');
        const source = join(folder, 'installer.nsi');
        await writeFile(source, `
Unicode true
RequestExecutionLevel user
SilentInstall silent
SilentUnInstall silent
OutFile "${installer}"
InstallDir "${install}"
!define MAINBINARYNAME "modutex-desktop-tauri"
!define PRODUCTNAME "ModuTeX fixture"
!macro CheckIfAppIsRunning path name
!macroend
${mode === 'original' ? '' : `!include "${hook}"`}
Section
 SetOutPath "$INSTDIR"
 FileOpen $0 "$INSTDIR\\modutex-desktop-tauri.exe" w
 FileWrite $0 "fixture executable"
 FileClose $0
 FileOpen $0 "$INSTDIR\\uninstall-metadata" w
 FileClose $0
 WriteUninstaller "$INSTDIR\\uninstall.exe"
SectionEnd
Section Uninstall
 ${mode === 'original' ? '' : '!insertmacro NSIS_HOOK_PREUNINSTALL'}
 Delete "$INSTDIR\\modutex-desktop-tauri.exe"
 Delete "$INSTDIR\\uninstall-metadata"
 Delete "$INSTDIR\\uninstall.exe"
SectionEnd
`);
        const compiled = await run(nsis, ['/V2', source]);
        assert.equal(compiled.error, null, compiled.stdout + compiled.stderr);
        assert.equal((await run(installer, ['/S', `/D=${install}`])).error, null);
        const executable = join(install, 'modutex-desktop-tauri.exe');
        const worker = join(folder, 'uninstaller-worker.exe');
        await copyFile(join(install, 'uninstall.exe'), worker);
        const locker = spawn('pwsh.exe', ['-NoProfile', '-Command', `
$stream=[IO.File]::Open($env:MODUTEX_LOCK_FILE,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::ReadWrite)
try { [Console]::WriteLine('locked'); Start-Sleep -Milliseconds ${mode === 'transient' ? 1500 : 15000} } finally { $stream.Dispose() }
`], { windowsHide: true, env: { ...process.env, MODUTEX_LOCK_FILE: executable }, stdio: ['ignore', 'pipe', 'pipe'] });
        try {
          const [ready] = await once(locker.stdout, 'data', { signal: AbortSignal.timeout(5000) });
          assert.match(String(ready), /locked/);
          const started = Date.now();
          // _?= must be the final, unquoted NSIS argument, including spaces.
          const result = await run('pwsh.exe', ['-NoProfile', '-Command', `
$start=[Diagnostics.ProcessStartInfo]::new()
$start.FileName=$env:MODUTEX_UNINSTALL_WORKER
$start.UseShellExecute=$false
$start.WorkingDirectory=[IO.Path]::GetDirectoryName($start.FileName)
$start.Arguments='/S _?='+$env:MODUTEX_UNINSTALL_DIRECTORY
$process=[Diagnostics.Process]::Start($start)
try { if(-not $process.WaitForExit(15000)){$process.Kill();throw 'Fixture uninstaller timed out'}; exit $process.ExitCode } finally { $process.Dispose() }
`], { env: { ...process.env, MODUTEX_UNINSTALL_WORKER: worker, MODUTEX_UNINSTALL_DIRECTORY: install } });
          if (mode === 'original') {
            assert.equal(result.error, null, 'stock NSIS Delete can report success while leaving a locked EXE');
            assert.equal(await exists(executable), true);
            assert.equal(await exists(join(install, 'uninstall-metadata')), false);
          } else if (mode === 'transient') {
            assert.equal(result.error, null, result.stdout + result.stderr);
            assert.equal(await exists(executable), false);
            assert.equal(await exists(join(install, 'uninstall-metadata')), false);
          } else {
            assert.equal(result.error?.code, 1, result.stdout + result.stderr);
            assert.equal(await exists(executable), true);
            assert.equal(await exists(join(install, 'uninstall-metadata')), true, 'failed uninstall retains recovery metadata');
            assert(Date.now() - started < 14000, 'lock retry remains bounded');
          }
        } finally {
          if (locker.exitCode === null) { locker.kill(); await once(locker, 'close'); }
        }
      }
    } finally { await rm(fixture, { recursive: true, force: true }); }
  });
