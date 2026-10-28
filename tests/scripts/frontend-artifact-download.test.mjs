import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import yaml from 'js-yaml';

const quote=value=>"'"+value.replaceAll("'","''")+"'";
const producer=yaml.load(await readFile(new URL('../../.github/workflows/tauri-frontend.yml',import.meta.url),'utf8'));
const upload=producer.jobs['frontend-build'].steps.find(step=>step.name==='Upload Tauri frontend assets and required notices');
const notices=upload.with.path.trim().split(/\r?\n/).map(path=>path.trim()).filter(path=>path!=='apps/frontend/dist-tauri');
test('frontend artifact notices exist in the actual source checkout',async()=>{
  assert.equal(upload.with['include-hidden-files'],true,'Built .vite metadata must be uploaded');
  for(const path of notices){
    const bytes=await readFile(new URL(`../../${path}`,import.meta.url));
    assert(bytes.length>0,`${path} must contain the source notice`);
  }
});
const consumers=[];
for(const workflow of (await readdir(new URL('../../.github/workflows/',import.meta.url))).filter(name=>name.endsWith('.yml'))){
  const document=yaml.load(await readFile(new URL(`../../.github/workflows/${workflow}`,import.meta.url),'utf8'));
  for(const [job,definition] of Object.entries(document.jobs??{})){
    if(definition.steps?.some(step=>typeof step.run==='string'&&step.run.includes('download-workflow-artifact.ps1')&&step.env?.FRONTEND_ARTIFACT_NAME)) consumers.push([workflow,job]);
  }
}
assert(consumers.length>0,'Frontend artifact consumers must be discovered from the real workflow graph');
for(const [workflow,job] of consumers){
  test(`${workflow} ${job} stages frontend artifacts without overwriting checkout licenses`,async()=>{
    const document=yaml.load(await readFile(new URL(`../../.github/workflows/${workflow}`,import.meta.url),'utf8'));
    const target=document.jobs[job];
    assert(target,`Missing real job ${job}`);
    const step=target.steps.find(step=>typeof step.run==='string'&&step.run.includes('download-workflow-artifact.ps1')&&step.env?.FRONTEND_ARTIFACT_NAME);
    assert(step,'The real download step must be present');
    const directory=await mkdtemp(join(tmpdir(),'modutex-artifact-download-'));
    const checkout=join(directory,'checkout'), runner=join(directory,'runner');
    try{
      await mkdir(join(checkout,'apps/frontend'),{recursive:true});await mkdir(runner);
      await mkdir(join(checkout,'tests/scripts/helpers'),{recursive:true});
      await writeFile(join(checkout,'tests/scripts/helpers/download-workflow-artifact.ps1'),await readFile(new URL('./helpers/download-workflow-artifact.ps1',import.meta.url)));
      await writeFile(join(checkout,'LICENSE'),'Original checkout license\n');
      for(const file of notices.filter(file=>file!=='LICENSE')){
        await mkdir(dirname(join(checkout,file)),{recursive:true});
        await writeFile(join(checkout,file),await readFile(new URL(`../../${file}`,import.meta.url)));
      }
      const script=join(directory,'exercise.ps1');
      await writeFile(script,`$ErrorActionPreference='Stop'
$env:RUNNER_TEMP=${quote(runner)}
$env:GITHUB_RUN_ID='123456789'
$env:GITHUB_RUN_ATTEMPT='1'
$env:FRONTEND_ARTIFACT_NAME='ModuTeX-Tauri-Frontend-123456789-1'
Set-Location -LiteralPath ${quote(checkout)}
function gh {
  $values=@($args)
  if ($values[0] -ne 'run' -or $values[1] -ne 'download' -or $values[2] -ne $env:GITHUB_RUN_ID) { throw 'Unexpected download identity' }
  $nameIndex=[Array]::IndexOf($values,'--name')
  if ($nameIndex -lt 0 -or $values[$nameIndex+1] -ne $env:FRONTEND_ARTIFACT_NAME) { throw 'Unexpected artifact identity' }
  $dirIndex=[Array]::IndexOf($values,'--dir')
  if ($dirIndex -lt 0) { throw 'Download directory missing' }
  $destination=$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($values[$dirIndex+1])
  if ($destination -eq (Get-Location).Path) { throw 'gh refuses extraction over an existing LICENSE' }
  if (Test-Path -LiteralPath $destination) {
    if (@(Get-ChildItem -LiteralPath $destination -Force).Count -ne 0) { throw 'Artifact staging is not empty' }
  }
  $dist=Join-Path $destination 'apps/frontend/dist-tauri'
  New-Item -ItemType Directory -Path $dist -Force | Out-Null
  'Real staged frontend' | Set-Content -LiteralPath (Join-Path $dist 'index.html')
  New-Item -ItemType Directory -Path (Join-Path $dist '.vite') | Out-Null
  '{"entry":"index.html"}' | Set-Content -LiteralPath (Join-Path $dist '.vite/manifest.json')
  foreach($notice in @(${notices.map(quote).join(',')})){
    $target=Join-Path $destination $notice
    New-Item -ItemType Directory -Path (Split-Path -Parent $target) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path (Get-Location).Path $notice) -Destination $target
  }
  $global:LASTEXITCODE=0
}
${step.run}
if (-not (Test-Path -LiteralPath 'apps/frontend/dist-tauri/index.html' -PathType Leaf)) { throw 'Built frontend was not restored' }
`);
      const result=spawnSync('pwsh.exe',['-NoProfile','-NonInteractive','-File',script],{encoding:'utf8',windowsHide:true,timeout:15000});
      assert.equal(result.status,0,result.stderr||result.stdout);
      assert.equal(await readFile(join(checkout,'LICENSE'),'utf8'),'Original checkout license\n');
      assert.equal((await readFile(join(checkout,'apps/frontend/dist-tauri/index.html'),'utf8')).trim(),'Real staged frontend');
      assert.deepEqual(JSON.parse(await readFile(join(checkout,'apps/frontend/dist-tauri/.vite/manifest.json'),'utf8')),{entry:'index.html'});
    }finally{
      assert.equal(resolve(directory).startsWith(resolve(tmpdir())),true);
      await rm(directory,{recursive:true,force:true,maxRetries:3});
    }
  });
}
