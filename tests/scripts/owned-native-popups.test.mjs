import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

const helper = resolve('tests/scripts/helpers/owned-native-popups.ps1');
const run = (command, env = {}) => new Promise(accept => execFile('pwsh.exe', ['-NoProfile', '-Command', command],
	{ windowsHide: true, timeout: 35000, env: { ...process.env, ...env } },
	(error, stdout, stderr) => accept({ code: error?.code ?? 0, stdout, stderr })));

test('owned popup interop is prepared once and loads in a fresh process without runtime C# compilation', async () => {
	const fixture = await mkdtemp(join(tmpdir(), 'modutex-popup-assembly-'));
	try {
		const assembly = join(fixture, 'owned-popups.dll');
		const built = await run('& $env:POPUP_HELPER -OutputAssembly $env:POPUP_OUTPUT', { POPUP_HELPER: helper, POPUP_OUTPUT: assembly, MODUTEX_TEST_NATIVE_POPUPS_ASSEMBLY: '' });
		assert.equal(built.code, 0, built.stderr);
		assert.ok((await stat(assembly)).size > 0, 'preparation must produce an actual assembly');
		const loaded = await run(`
$ErrorActionPreference='Stop'
function Add-Type {
 param([string]$Path)
 if(-not $Path) { throw 'RUNTIME_COMPILATION_FORBIDDEN' }
 Microsoft.PowerShell.Utility\\Add-Type -Path $Path
}
. $env:POPUP_HELPER
[OwnedNativePopupWindows].Assembly.Location
`, { POPUP_HELPER: helper, MODUTEX_TEST_NATIVE_POPUPS_ASSEMBLY: assembly });
		assert.equal(loaded.code, 0, loaded.stderr);
		assert.equal(loaded.stdout.trim().toLowerCase(), assembly.toLowerCase());
		const missing = await run('$ErrorActionPreference="Stop"; . $env:POPUP_HELPER', { POPUP_HELPER: helper, MODUTEX_TEST_NATIVE_POPUPS_ASSEMBLY: join(fixture, 'missing.dll') });
		assert.notEqual(missing.code, 0, 'missing prepared assemblies must fail instead of falling back to runtime compilation');
	} finally { await rm(fixture, { recursive: true, force: true }); }
});

test('verified Win32 folder selection does not require UI Automation and still rejects the wrong executable', async () => {
	const fixture = await mkdtemp(join(tmpdir(), 'modutex-popup-picker-'));
	try {
		await writeFile(join(fixture, 'select-owned-folder.ps1'), await readFile(resolve('tests/scripts/helpers/select-owned-folder.ps1')));
		// A deterministic native-control boundary: no user windows are opened or operated.
		await writeFile(join(fixture, 'owned-native-popups.ps1'), `
class OwnedNativePopupWindows {
 static [object[]] Enumerate([uint32]$owner) {
  return @([pscustomobject]@{Handle=[IntPtr]1;ProcessId=$owner;ClassName='#32770';Title='Fixture'})
 }
 static [object[]] EnumerateChildren([IntPtr]$handle) { return @() }
 static [bool] TrySelectFolder([IntPtr]$handle,[uint32]$owner,[string]$folder,[ref]$detail) {
  if($owner -ne [Environment]::ProcessId -or -not [IO.Directory]::Exists($folder)) { throw 'FIXTURE_OWNERSHIP' }
  $detail.Value='Select Folder'; return $true
 }
}
`);
		const command = `
$ErrorActionPreference='Stop'
function Add-Type { param([string]$AssemblyName) throw 'UI_AUTOMATION_UNAVAILABLE' }
& (Join-Path $env:POPUP_FIXTURE 'select-owned-folder.ps1') -OwnedProcessId $PID -ExpectedExecutablePath (Get-Process -Id $PID).Path -FolderPath $env:POPUP_FIXTURE
`;
		const selected = await run(command, { POPUP_FIXTURE: fixture });
		assert.equal(selected.code, 0, selected.stderr);
		const receipt = JSON.parse(selected.stdout);
		assert.equal(receipt.selected, fixture);
		assert.equal(receipt.driver, 'Win32 GetDlgItem/WM_SETTEXT/BM_CLICK');
		const rejected = await run(command.replace('(Get-Process -Id $PID).Path', '$env:WRONG_EXECUTABLE'), { POPUP_FIXTURE: fixture, WRONG_EXECUTABLE: process.execPath });
		assert.notEqual(rejected.code, 0);
		assert.match(rejected.stderr, /UNEXPECTED_TEST_EXECUTABLE/);
	} finally { await rm(fixture, { recursive: true, force: true }); }
});
