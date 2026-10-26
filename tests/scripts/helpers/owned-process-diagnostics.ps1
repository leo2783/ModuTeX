# SPDX-License-Identifier: Apache-2.0
function Get-OwnedProcessSnapshot {
    param([Parameter(Mandatory)][int]$OwnedProcessId)
    $all = @(Get-CimInstance Win32_Process -OperationTimeoutSec 3 -ErrorAction Stop)
    $owned = [System.Collections.Generic.HashSet[int]]::new()
    [void]$owned.Add($OwnedProcessId)
    do {
        $added = $false
        foreach ($entry in $all) {
            if ($owned.Contains([int]$entry.ParentProcessId) -and $owned.Add([int]$entry.ProcessId)) {
                $added = $true
            }
        }
    } while ($added)
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
