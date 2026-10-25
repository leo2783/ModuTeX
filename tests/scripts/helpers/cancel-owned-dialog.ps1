param(
    [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$OwnedProcessId,
    [ValidateRange(1,30)][int]$TimeoutSeconds = 20,
    [ValidateSet('modutex-desktop-tauri','modutex-mcp-rust-review')][string]$ExpectedProcessName = 'modutex-desktop-tauri'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$owned = Get-Process -Id $OwnedProcessId -ErrorAction Stop
if ($owned.ProcessName -ne $ExpectedProcessName) { throw 'UNEXPECTED_TEST_PROCESS' }
. (Join-Path $PSScriptRoot 'owned-native-popups.ps1')
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$dirtyPrompts = @(
    '編輯內容尚未儲存至磁碟。要捨棄變更並切換文件嗎？',
    'Edits are not saved to disk. Discard changes and switch documents?'
)
$uiaDiagnostics = @{}
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$topLevelWindows = @()
$nativePopups = @{}
while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Get-Process -Id $OwnedProcessId -ErrorAction SilentlyContinue)) { break }
    $ownedWindows = @([OwnedNativePopupWindows]::EnumerateOwnedTopLevel([uint32]$OwnedProcessId, $false))
    $topLevelWindows = @($ownedWindows | ForEach-Object {
        [pscustomobject]@{processId=$_.ProcessId;class=$_.ClassName;title=$_.Title}
    })
    $windows = @([OwnedNativePopupWindows]::Enumerate([uint32]$OwnedProcessId))
    foreach ($popup in $windows) {
        $nativeHandle = $popup.Handle.ToInt64().ToString()
        $children = @([OwnedNativePopupWindows]::EnumerateChildren($popup.Handle) | ForEach-Object {
            [pscustomobject]@{handle=$_.Handle;processId=$_.ProcessId;controlId=$_.ControlId;class=$_.ClassName;text=$_.Text}
        })
        $nativePopups[$nativeHandle] = [pscustomobject]@{
            handle=$popup.Handle;processId=$popup.ProcessId;class=$popup.ClassName;title=$popup.Title;children=$children
        }

        $snapshot = $nativePopups[$nativeHandle]
        $prompt = @($snapshot.children | Where-Object {
            $_.class -eq 'Static' -and $_.processId -eq $OwnedProcessId -and $_.text -cin $dirtyPrompts
        } | Select-Object -First 1)
        $cancel = @($snapshot.children | Where-Object {
            $_.class -eq 'Button' -and $_.controlId -eq 2 -and $_.text -match '^(取消|Cancel(?:\s*\([A-Z]\))?)$'
        } | Select-Object -First 1)
        $cancelDetail = ''
        if ($prompt.Count -eq 1 -and $cancel.Count -eq 1 -and
            [OwnedNativePopupWindows]::TryClickOwnedCancel(
            $snapshot.handle, [uint32]$OwnedProcessId, $cancel[0].handle, [ref]$cancelDetail)) {
            @{
                processId=$OwnedProcessId
                cancelPosted=$true
                driver='Win32 verified owned popup'
                popupClass=$snapshot.class
                prompt=$prompt[0].text
                cancelControlId=2
                cancelButton=$cancelDetail
            } | ConvertTo-Json -Compress
            exit 0
        }

        # Modern Windows TaskDialog exposes its message through UIA rather than WM_GETTEXT.
        # Scope every query to the verified native dialog, never the WebView or desktop tree.
        if ($popup.ProcessId -ne $OwnedProcessId -or $popup.ClassName -ne '#32770' -or
            $popup.Title -cne 'ModuTeX' -or
            -not @($children | Where-Object { $_.class -eq 'DirectUIHWND' -and $_.processId -eq $OwnedProcessId }).Count -or
            -not @($children | Where-Object { $_.class -eq 'SysLink' -and $_.processId -eq $OwnedProcessId }).Count) { continue }
        try {
            $dialog = [System.Windows.Automation.AutomationElement]::FromHandle($popup.Handle)
            if ($dialog.Current.ProcessId -ne $OwnedProcessId) { throw 'TASK_DIALOG_UIA_PROCESS_MISMATCH' }
            $messageNames = [System.Windows.Automation.OrCondition]::new(
                [System.Windows.Automation.PropertyCondition]::new(
                    [System.Windows.Automation.AutomationElement]::NameProperty, $dirtyPrompts[0]),
                [System.Windows.Automation.PropertyCondition]::new(
                    [System.Windows.Automation.AutomationElement]::NameProperty, $dirtyPrompts[1]))
            $messageCondition = [System.Windows.Automation.AndCondition]::new(
                $messageNames,
                [System.Windows.Automation.PropertyCondition]::new(
                    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $OwnedProcessId))
            $message = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $messageCondition)
            if ($null -eq $message) {
                $uiaDiagnostics[$nativeHandle] = 'Exact dirty replacement prompt not found in verified TaskDialog'
                continue
            }
            $exactPrompt = $message.Current.Name
            if ($exactPrompt -cnotin $dirtyPrompts) { throw 'TASK_DIALOG_PROMPT_CHANGED' }
            $nativeCancel = @($children | Where-Object {
                $_.processId -eq $OwnedProcessId -and $_.controlId -in @(0, 2) -and
                $_.class -eq 'Button' -and $_.text -cin @('取消', 'Cancel')
            })
            if ($nativeCancel.Count -ne 1) { throw 'TASK_DIALOG_CANCEL_NATIVE_CHILD_MISMATCH' }
            # UIA exposes the message but may omit TaskDialog buttons; use its verified native child.
            if ($message.Current.Name -cne $exactPrompt) { throw 'TASK_DIALOG_PROMPT_CHANGED' }
            $taskCancelDetail = ''
            if (-not [OwnedNativePopupWindows]::TryClickOwnedTaskDialogCancel(
                $popup.Handle, [uint32]$OwnedProcessId, $nativeCancel[0].handle, [ref]$taskCancelDetail)) {
                throw "TASK_DIALOG_CANCEL_REJECTED: $taskCancelDetail"
            }
            @{
                processId=$OwnedProcessId;cancelPosted=$true
                driver='UIA exact prompt and Win32 verified owned TaskDialog cancel'
                popupClass=$popup.ClassName;prompt=$exactPrompt
                cancelControlId=$nativeCancel[0].controlId;cancelButton=$nativeCancel[0].text
            } | ConvertTo-Json -Compress
            exit 0
        } catch {
            $uiaDiagnostics[$nativeHandle] = $_.Exception.ToString()
        }
    }
    Start-Sleep -Milliseconds 100
}
$diagnostics = [pscustomobject]@{
    taskDialogUia=$uiaDiagnostics
    topLevelWindows=$topLevelWindows
    nativePopups=@($nativePopups.Values | ForEach-Object {
        [pscustomobject]@{
            processId=$_.processId;class=$_.class;title=$_.title
            children=@($_.children | ForEach-Object {
                [pscustomobject]@{processId=$_.processId;controlId=$_.controlId;class=$_.class;text=$_.text}
            })
        }
    })
}
$diagnosticJson = $diagnostics | ConvertTo-Json -Compress -Depth 6
[Console]::Error.WriteLine("OWNED_CANCEL_NATIVE_WINDOWS $diagnosticJson")
[Console]::Error.Flush()
@{
    processId=$OwnedProcessId
    cancelPosted=$false
    diagnostics=$diagnostics
} | ConvertTo-Json -Compress -Depth 6
exit 1
