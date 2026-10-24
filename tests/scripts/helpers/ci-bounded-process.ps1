# SPDX-License-Identifier: Apache-2.0
. (Join-Path $PSScriptRoot 'owned-process-diagnostics.ps1')

function Save-CiPortableLogs {
    param([string]$PortableRoot, [string]$LogDirectory)
    if (-not (Test-Path -LiteralPath $PortableRoot -PathType Container)) { return }
    $destination = Join-Path $LogDirectory 'portable-internal'
    foreach ($file in @(Get-ChildItem -LiteralPath $PortableRoot -Filter '*.log' -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 100)) {
        $target = Join-Path $destination ([System.IO.Path]::GetRelativePath($PortableRoot, $file.FullName))
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        try {
            $stream = [System.IO.File]::Open($file.FullName, 'Open', 'Read', 'ReadWrite')
            try {
                $snapshotLength = $stream.Length
                $remaining = [Math]::Min($snapshotLength, 1048576)
                [void]$stream.Seek($snapshotLength - $remaining, 'Begin')
                $output = [System.IO.File]::Create($target)
                try {
                    $buffer = [byte[]]::new(8192)
                    while ($remaining -gt 0) {
                        $read = $stream.Read($buffer, 0, [int][Math]::Min($remaining, $buffer.Length))
                        if ($read -eq 0) { break }
                        $output.Write($buffer, 0, $read)
                        $remaining -= $read
                    }
                } finally { $output.Dispose() }
            } finally { $stream.Dispose() }
        } catch { Write-Warning "Could not collect MiKTeX log $($file.FullName): $_" }
    }
}

function Invoke-CiBoundedProcess {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @(),
        [Parameter(Mandatory)][string]$LogPath,
        [Parameter(Mandatory)][string]$PortableRoot,
        [ValidateRange(1, 600)][int]$TimeoutSeconds = 180
    )
    # Leave time for owned-process evidence and portable logs before the 15-minute step limit.
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    if ($script:CiProcessDeadline -and $script:CiProcessDeadline -lt $deadline) { $deadline = $script:CiProcessDeadline }
    if ([DateTime]::UtcNow -ge $deadline) { throw 'MiKTeX provisioning time budget exhausted' }
    $info = [System.Diagnostics.ProcessStartInfo]::new($FilePath)
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($argument in $Arguments) { $info.ArgumentList.Add($argument) }
    $child = [System.Diagnostics.Process]::new()
    $child.StartInfo = $info
    $stdout = [System.IO.File]::Create($LogPath)
    $stderr = [System.IO.File]::Create("$LogPath.stderr.log")
    $started = $false
    try {
        [void]$child.Start()
        $started = $true
        $outCopy = $child.StandardOutput.BaseStream.CopyToAsync($stdout)
        $errCopy = $child.StandardError.BaseStream.CopyToAsync($stderr)
        while (-not $child.WaitForExit(250)) {
            if ([DateTime]::UtcNow -ge $deadline) {
                try {
                    try {
                        ConvertTo-Json -InputObject @(Get-OwnedProcessSnapshot -OwnedProcessId $child.Id) -Depth 4 |
                            Set-Content -LiteralPath "$LogPath.processes.json" -Encoding utf8
                    } catch { Write-Warning "Could not collect owned process snapshot: $_" }
                    Save-CiPortableLogs -PortableRoot $PortableRoot -LogDirectory (Split-Path -Parent $LogPath)
                } finally {
                    # Kill only the process we started and its descendants, after collecting evidence.
                    if (-not $child.HasExited) { $child.Kill($true) }
                    [void]$child.WaitForExit(5000)
                }
                [void]$outCopy.Wait(5000)
                [void]$errCopy.Wait(5000)
                throw "MiKTeX command exceeded its bounded deadline: $FilePath (see $LogPath)"
            }
        }
        if (-not $outCopy.Wait(5000) -or -not $errCopy.Wait(5000)) {
            throw "MiKTeX command output did not close: $FilePath"
        }
        if ($child.ExitCode -ne 0) {
            Save-CiPortableLogs -PortableRoot $PortableRoot -LogDirectory (Split-Path -Parent $LogPath)
            throw "MiKTeX command failed with exit code $($child.ExitCode): $FilePath (see $LogPath)"
        }
    } finally {
        if ($started) {
            try {
                if (-not $child.HasExited) { $child.Kill($true) }
                [void]$child.WaitForExit(5000)
            } catch { Write-Warning "Could not reap owned MiKTeX process $($child.Id): $_" }
        }
        $stdout.Dispose()
        $stderr.Dispose()
        $child.Dispose()
    }
    Get-Content -LiteralPath $LogPath
    Get-Content -LiteralPath "$LogPath.stderr.log"
}
