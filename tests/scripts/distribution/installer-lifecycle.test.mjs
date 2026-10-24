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
