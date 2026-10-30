# SPDX-License-Identifier: Apache-2.0
function Get-OwnedProcessIds {
    param([Parameter(Mandatory)][int]$OwnedProcessId, [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Processes)
    $byId = @{}
    foreach ($entry in $Processes) { $byId[[int]$entry.ProcessId] = $entry }
    $owned = [System.Collections.Generic.HashSet[int]]::new()
    if (-not $byId.ContainsKey($OwnedProcessId)) { return ,$owned }
    [void]$owned.Add($OwnedProcessId)
    do {
        $added = $false
        foreach ($entry in $Processes) {
            $parentId = [int]$entry.ParentProcessId
            # Windows retains a terminated parent's PID, which can later be reused.
            # A real descendant cannot predate its currently observed parent.
            if ($owned.Contains($parentId) -and $null -ne $entry.CreationDate -and
                $null -ne $byId[$parentId].CreationDate -and
                $entry.CreationDate -ge $byId[$parentId].CreationDate -and
                $owned.Add([int]$entry.ProcessId)) {
                $added = $true
            }
        }
    } while ($added)
    return ,$owned
}

function Get-OwnedProcessSnapshot {
    param([Parameter(Mandatory)][int]$OwnedProcessId)
    $all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 3 -ErrorAction Stop)
    $owned = Get-OwnedProcessIds -OwnedProcessId $OwnedProcessId -Processes $all
    @($all | Where-Object { $owned.Contains([int]$_.ProcessId) } | ForEach-Object {
        $window = Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
        [pscustomobject]@{
            processId = $_.ProcessId
            parentProcessId = $_.ParentProcessId
            executablePath = $_.ExecutablePath
            commandLine = $_.CommandLine
            sessionId = $_.SessionId
            creationDate = $_.CreationDate
            mainWindowTitle = $window.MainWindowTitle
        }
    })
}
