param(
 [Parameter(Mandatory=$true)][ValidatePattern('^g[0-7]-[a-z0-9-]+$')][string]$Task,
 [Parameter(Mandatory=$true)][ValidateRange(1,3)][int]$Lane,
 [ValidateSet('gemini-3.8-flash-medium','gemini-3.8-flash-high','gemini-4-argon-medium','gemini-4-argon-high','claude-sonnet-5-5-high','claude-opus-5-5-high')][string]$Model='gemini-3.8-flash-medium'
)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$taskDir=Join-Path $taskRoot '.verification-artifacts/tauri'
$taskLock=Join-Path $taskDir "agy-$Lane.lock"
$taskHandle=[IO.File]::Open($taskLock,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try {
 $taskSpec=Get-Content -LiteralPath (Join-Path $taskDir "tasks/$Task.json") -Raw | ConvertFrom-Json
 if($taskSpec.provider -ne 'agy' -or $taskSpec.lane -ne $Lane){throw 'INVALID_TASK_LANE'}
 foreach($taskSource in $taskSpec.sourceHashes.psobject.Properties){
  if((Get-FileHash -LiteralPath (Join-Path $taskRoot $taskSource.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $taskSource.Value){throw 'STALE_SOURCE'}
 }
 $taskPacket=[IO.File]::ReadAllText((Join-Path $taskDir "tasks/$Task.txt"))
 $taskInfo=[Diagnostics.ProcessStartInfo]::new()
 $taskInfo.FileName='C:\Users\qet63\AppData\Local\agy\bin\agy.exe'
 $taskInfo.WorkingDirectory=$taskRoot
 $taskInfo.UseShellExecute=$false
 $taskInfo.CreateNoWindow=$true
 $taskInfo.RedirectStandardInput=$true
 $taskInfo.RedirectStandardOutput=$true
 $taskInfo.RedirectStandardError=$true
 foreach($taskArgument in @('--project','84c8d769-768c-42b2-91de-f1e564374084','--model',$Model,'--mode','plan','--sandbox','--input-format','text','--output-format','json','--print-timeout','15m','-p','Complete the bounded read-only task and literal source packet supplied on standard input. Return the requested JSON only. No tools, shell or writes.')) { $taskInfo.ArgumentList.Add($taskArgument) }
 $taskProcess=[Diagnostics.Process]::new()
 $taskProcess.StartInfo=$taskInfo
 $taskOut=[IO.File]::Create((Join-Path $taskDir "$Task.stdout.json"))
 $taskErr=[IO.File]::Create((Join-Path $taskDir "$Task.stderr.log"))
 try {
  if(-not $taskProcess.Start()){throw 'AGY_START_FAILED'}
  [IO.File]::WriteAllText((Join-Path $taskDir "$Task.handle.json"),(@{task=$Task;provider='agy';lane=$Lane;model=$Model;pid=$taskProcess.Id;startedUtc=[DateTime]::UtcNow.ToString('o');status='running'}|ConvertTo-Json))
  $taskCopyOut=$taskProcess.StandardOutput.BaseStream.CopyToAsync($taskOut)
  $taskCopyErr=$taskProcess.StandardError.BaseStream.CopyToAsync($taskErr)
  $taskProcess.StandardInput.Write($taskPacket)
  $taskProcess.StandardInput.Close()
  $taskProcess.WaitForExit()
  $taskCopyOut.GetAwaiter().GetResult()
  $taskCopyErr.GetAwaiter().GetResult()
  $taskExit=$taskProcess.ExitCode
 } finally {$taskOut.Dispose();$taskErr.Dispose();$taskProcess.Dispose()}
 [IO.File]::WriteAllText((Join-Path $taskDir "$Task.exit.json"),(@{task=$Task;exitCode=$taskExit;finishedUtc=[DateTime]::UtcNow.ToString('o')}|ConvertTo-Json))
 exit $taskExit
} finally {$taskHandle.Dispose();[IO.File]::Delete($taskLock)}
