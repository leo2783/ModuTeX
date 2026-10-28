import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {resolve} from 'node:path';
import test from 'node:test';

const script=resolve('scripts/distribution/verify-installer-lifecycle.ps1');
function runFunctions(names, body){
 const bootstrap=`
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$tokens=$null
$errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile($env:MODUTEX_LIFECYCLE_SCRIPT,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Lifecycle script has syntax errors'}
$names=$env:MODUTEX_LIFECYCLE_FUNCTIONS.Split(',')
foreach($name in $names){
 $definition=$ast.Find({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name},$true)
 if($null -eq $definition){throw "Missing function: $name"}
 Invoke-Expression $definition.Extent.Text
}
`;
 return execFileSync('pwsh.exe',['-NoProfile','-NonInteractive','-Command',bootstrap+'\n'+body],{
  encoding:'utf8',windowsHide:true,timeout:15000,
  env:{...process.env,MODUTEX_LIFECYCLE_SCRIPT:script,MODUTEX_LIFECYCLE_FUNCTIONS:names.join(',')}
 }).trim();
}
test('installer preflight refuses a non CI environment before querying installed programs',()=>{
 const output=runFunctions(['Assert-CleanRunner'],`
$env:GITHUB_ACTIONS='false'
function Get-ProductRegistryEntries {throw 'Registry must not be queried outside CI'}
try { Assert-CleanRunner; throw 'Expected refusal' } catch {
 if($_.Exception.Message -notlike '*GitHub-hosted Windows runner*'){throw}
 Write-Output 'refused'
}`);
 assert.equal(output,'refused');
});
test('uninstall inventory ignores unrelated registry records with missing optional properties',()=>{
 const output=runFunctions(['Get-ProductRegistryEntries'],`
function Test-Path {param($LiteralPath) return $LiteralPath -like 'HKCU:*'}
function Get-ChildItem {param($LiteralPath,$ErrorAction) @([pscustomobject]@{PSPath='unrelated';Name='unrelated'},[pscustomobject]@{PSPath='modutex';Name='modutex'})}
function Get-ItemProperty {param($LiteralPath,$ErrorAction)
 if($LiteralPath -eq 'unrelated'){return [pscustomobject]@{UninstallString='unrelated.exe'}}
 return [pscustomobject]@{DisplayName='ModuTeX';UninstallString='"C:\\owned\\uninstall.exe"'}
}
$entries=@(Get-ProductRegistryEntries)
if($entries.Count -ne 1 -or $entries[0].DisplayName -ne 'ModuTeX'){throw 'Wrong registry inventory'}
Write-Output 'one owned entry'
`);
 assert.equal(output,'one owned entry');
});
test('owned path guard rejects siblings and parent traversal including case aliases',()=>{
 const output=runFunctions(['Get-FullPath','Assert-ChildPath'],`
$base=Join-Path ([IO.Path]::GetTempPath()) 'modutex-lifecycle-owned'
Assert-ChildPath (Join-Path $base 'child') $base
foreach($path in @($base,$base+'-sibling', (Join-Path $base '..\\outside'))){
 $rejected=$false
 try{Assert-ChildPath $path $base}catch{$rejected=$true}
 if(-not $rejected){throw "Unsafe path accepted: $path"}
}
Write-Output 'contained'
`);
 assert.equal(output,'contained');
});

test('isolated launch creates Windows known folders under its owned user profile',()=>{
 const output=runFunctions(['Get-FullPath','Assert-ChildPath','Assert-NoReparseAncestors','Assert-Sentinel','New-IsolatedInstalledAppProfile'],`
$script:scratchRoot=Join-Path ([IO.Path]::GetTempPath()) ('modutex-profile-test-'+[guid]::NewGuid().ToString('N'))
$user=Join-Path $script:scratchRoot 'profile\\user'
$script:sentinelPath=Join-Path $user 'Documents\\sentinel.tex'
[IO.Directory]::CreateDirectory((Split-Path -Parent $script:sentinelPath)) | Out-Null
[IO.File]::WriteAllText($script:sentinelPath,'unchanged document')
$script:sentinelSha256=(Get-FileHash -LiteralPath $script:sentinelPath).Hash.ToLowerInvariant()
try {
 [Console]::Error.WriteLine('PROFILE_STAGE create-isolated-profile')
 $null=New-IsolatedInstalledAppProfile
 [Console]::Error.WriteLine('PROFILE_STAGE isolated-profile-created')
 foreach($relative in @('AppData\\Roaming','AppData\\Local')){
  if(-not (Test-Path -LiteralPath (Join-Path $user $relative) -PathType Container)){throw "Missing Windows known folder: $relative"}
 }
 $probe=@'
[Console]::Error.WriteLine('PROFILE_STAGE child-before-add-type')
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class LifecycleFolderProbe { [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid id, uint flags, IntPtr token, out IntPtr path); public static string Read(string key) { Guid id=new Guid(key); IntPtr path; int result=SHGetKnownFolderPath(ref id,0,IntPtr.Zero,out path); try { if(result!=0) throw new Exception("Known folder failed: "+result); return Marshal.PtrToStringUni(path); } finally { Marshal.FreeCoTaskMem(path); } } }'
[Console]::Error.WriteLine('PROFILE_STAGE child-before-known-folder')
[LifecycleFolderProbe]::Read('3EB685DB-65F9-4CF6-A03A-E3EF65729F3D')
[LifecycleFolderProbe]::Read('F1B32785-6FBA-4FCF-9D55-7B8E7F157091')
'@
 $child=[Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
 $child.UseShellExecute=$false
 $child.RedirectStandardOutput=$true
 $child.ArgumentList.Add('-NoProfile')
 $child.ArgumentList.Add('-Command')
 $child.ArgumentList.Add($probe)
 $child.Environment['USERPROFILE']=$user
 $child.Environment['APPDATA']=Join-Path $user 'AppData\\Roaming'
 $child.Environment['LOCALAPPDATA']=Join-Path $user 'AppData\\Local'
 $process=[Diagnostics.Process]::Start($child)
 [Console]::Error.WriteLine('PROFILE_STAGE read-child-output')
 try {
  $resolved=$process.StandardOutput.ReadToEnd()
  if(-not $process.WaitForExit(10000) -or $process.ExitCode -ne 0){throw 'Known folder probe failed'}
  foreach($relative in @('AppData\\Roaming','AppData\\Local')){
   if($resolved.IndexOf((Join-Path $user $relative),[StringComparison]::OrdinalIgnoreCase) -lt 0){throw 'Known folder escaped isolated profile'}
  }
 } finally { if(-not $process.HasExited){$process.Kill()}; $process.Dispose() }
 Assert-Sentinel
 Write-Output 'profile complete'
} finally {
 Assert-ChildPath $script:scratchRoot ([IO.Path]::GetTempPath())
 Remove-Item -LiteralPath $script:scratchRoot -Recurse -Force
}
`);
 assert.equal(output,'profile complete');
});

test('uninstaller runs a verified scratch copy with the unquoted install directory last',()=>{
 const output=runFunctions(['Get-FullPath','Assert-ChildPath','Assert-NoReparseAncestors','Test-PathEquals','New-OwnedUninstallerStartInfo'],`
$script:scratchRoot=Join-Path ([IO.Path]::GetTempPath()) ('modutex-uninstaller-test-'+[guid]::NewGuid().ToString('N'))
$script:installDirectory=Join-Path $script:scratchRoot 'installation with spaces'
$script:ownerToken=[guid]::NewGuid().ToString('N')
[IO.Directory]::CreateDirectory($script:installDirectory) | Out-Null
[IO.File]::WriteAllText((Join-Path $script:scratchRoot '.modutex-installer-lifecycle-owner'),$script:ownerToken)
$original=Join-Path $script:installDirectory 'uninstall.exe'
[IO.File]::WriteAllBytes($original,[byte[]](1,2,3,4))
$expected=(Get-FileHash -LiteralPath $original).Hash
try {
 $start=New-OwnedUninstallerStartInfo -UninstallerPath $original
 Assert-ChildPath $start.FileName $script:scratchRoot
 if(Test-PathEquals $start.FileName $original){throw 'Still running the installation copy'}
 if(Test-PathEquals $start.WorkingDirectory $script:installDirectory){throw 'Working directory locks the installation'}
 if((Get-FileHash -LiteralPath $start.FileName).Hash -ne $expected){throw 'Copied uninstaller changed'}
 if((Get-FileHash -LiteralPath $original).Hash -ne $expected){throw 'Original uninstaller changed'}
 if($start.UseShellExecute -or $start.Arguments -cne ('/S _?='+$script:installDirectory)){throw 'Wrong synchronous NSIS invocation'}
 Write-Output 'owned synchronous invocation'
} finally {
 Assert-ChildPath $script:scratchRoot ([IO.Path]::GetTempPath())
 Remove-Item -LiteralPath $script:scratchRoot -Recurse -Force
}
`);
 assert.equal(output,'owned synchronous invocation');
});

test('startup diagnostics drain both pipes while retaining only bounded failure tails',()=>{
 const output=runFunctions(['New-BoundedProcessStreamCapture','Get-BoundedProcessOutput','Format-IsolatedAppDiagnostics','Assert-InstalledAppStillRunningDuringStartup'],`
$start=[Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
$start.UseShellExecute=$false
$start.RedirectStandardOutput=$true
$start.RedirectStandardError=$true
$start.ArgumentList.Add('-NoProfile')
$start.ArgumentList.Add('-Command')
$start.ArgumentList.Add("[Console]::Out.Write(('x'*262144)+'stdout-tail'); [Console]::Error.Write(('y'*262144)+'panic-tail'); exit 101")
$process=[Diagnostics.Process]::Start($start)
$stdout=New-BoundedProcessStreamCapture -Stream $process.StandardOutput.BaseStream
$stderr=New-BoundedProcessStreamCapture -Stream $process.StandardError.BaseStream
try {
 if(-not $process.WaitForExit(8000)){throw 'Diagnostic reader blocked the failing process'}
 $out=Get-BoundedProcessOutput -Capture $stdout
 $err=Get-BoundedProcessOutput -Capture $stderr
 if($process.ExitCode -ne 101){throw 'Original failure exit code changed'}
 if($out.Length -gt 8192 -or $err.Length -gt 8192){throw 'Unbounded diagnostic output'}
 if(-not $out.EndsWith('stdout-tail') -or -not $err.EndsWith('panic-tail')){throw 'Failure tail was lost'}
 $rejected=$false
 try { Assert-InstalledAppStillRunningDuringStartup -Process $process -StdoutCapture $stdout -StderrCapture $stderr } catch {
  if($_.Exception.Message -notlike '*startup with code 101*panic-tail*'){throw}
  $rejected=$true
 }
 if(-not $rejected){throw 'Early startup failure was accepted'}
 Write-Output 'bounded failure preserved'
} finally { if(-not $process.HasExited){$process.Kill()}; $process.Dispose() }
`);
 assert.equal(output,'bounded failure preserved');
});

test('WebView policy cleanup removes only the unchanged value owned by this run',()=>{
 const output=runFunctions(['Remove-TemporaryWebView2UserDataPolicy'],`
$script:webView2UserDataPolicyPath='HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge\\WebView2\\UserDataFolder'
$script:webView2UserDataPolicyName='modutex-desktop-tauri.exe'
$script:removed=@()
$key=[pscustomobject]@{}
$key | Add-Member ScriptMethod GetValueNames { @('modutex-desktop-tauri.exe','unrelated.exe') }
$key | Add-Member ScriptMethod GetValue { param($name,$fallback,$options) $script:actualValue }
$key | Add-Member ScriptMethod GetValueKind { param($name) $script:actualKind }
function Test-Path { param($LiteralPath) $true }
function Get-Item { param($LiteralPath,$ErrorAction) $key }
function Remove-ItemProperty { param($LiteralPath,$Name,$ErrorAction) $script:removed+=@($Name) }
function Remove-Item { throw 'Existing policy keys must remain' }
foreach($changed in @($true,$false)){
 $script:webView2UserDataPolicyValueCreated=$true
 $script:webView2UserDataPolicyCreatedKeys=@()
 $script:webView2UserDataPolicyValue='owned-profile'
 $script:actualValue=if($changed){'someone-elses-profile'}else{'owned-profile'}
 $script:actualKind=[Microsoft.Win32.RegistryValueKind]::String
 $refused=$false
 try { Remove-TemporaryWebView2UserDataPolicy } catch {
  if($_.Exception.Message -notlike '*Refusing to remove changed*'){throw}
  $refused=$true
 }
 if($refused -ne $changed){throw 'Policy ownership decision was incorrect'}
}
if($script:removed.Count -ne 1 -or $script:removed[0] -cne $script:webView2UserDataPolicyName){throw 'Cleanup touched an unrelated policy'}
Write-Output 'only owned policy removed'
`);
 assert.equal(output,'only owned policy removed');
});
