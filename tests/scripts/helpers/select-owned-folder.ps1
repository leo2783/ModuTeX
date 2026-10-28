param(
    [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$OwnedProcessId,
    [Parameter(Mandatory=$true)][string]$FolderPath,
    [string]$ExpectedExecutablePath,
    [ValidateRange(1,30)][int]$TimeoutSeconds = 30
)
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('OWNED_FOLDER_STAGE validate-process')
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$owned = Get-Process -Id $OwnedProcessId -ErrorAction Stop
if ($ExpectedExecutablePath) {
    $expected = (Resolve-Path -LiteralPath $ExpectedExecutablePath).Path
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($owned.Path, $expected)) { throw 'UNEXPECTED_TEST_EXECUTABLE' }
} elseif ($owned.ProcessName -ne 'modutex-desktop-tauri') { throw 'UNEXPECTED_TEST_PROCESS' }
$folder = (Resolve-Path -LiteralPath $FolderPath).Path
if (-not (Test-Path -LiteralPath $folder -PathType Container)) { throw 'EXPECTED_TEST_FOLDER' }
[Console]::Error.WriteLine('OWNED_FOLDER_STAGE load-native-popups')
. (Join-Path $PSScriptRoot 'owned-native-popups.ps1')
[Console]::Error.WriteLine('OWNED_FOLDER_STAGE poll-owned-windows')
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$observed = @()
$nativeWindows = @{}
$uiaLoaded = $false
while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Get-Process -Id $OwnedProcessId -ErrorAction SilentlyContinue)) { break }
    $windows = @([OwnedNativePopupWindows]::Enumerate([uint32]$OwnedProcessId))
    foreach ($popup in $windows) {
        $nativeHandle = $popup.Handle.ToInt64().ToString()
        if (-not $nativeWindows.ContainsKey($nativeHandle)) {
            $nativeChildren = @([OwnedNativePopupWindows]::EnumerateChildren($popup.Handle) | ForEach-Object {
                [pscustomobject]@{processId=$_.ProcessId;controlId=$_.ControlId;class=$_.ClassName;text=$_.Text}
            })
            $nativeWindows[$nativeHandle] = [pscustomobject]@{
                processId=$popup.ProcessId;class=$popup.ClassName;title=$popup.Title;children=$nativeChildren
            }
        }
        if ($popup.ClassName -eq '#32770' -and $popup.ProcessId -eq $OwnedProcessId) {
            $nativeSelectionDetail = ''
            if ([OwnedNativePopupWindows]::TrySelectFolder(
                $popup.Handle, [uint32]$OwnedProcessId, $folder, [ref]$nativeSelectionDetail)) {
                @{
                    processId=$OwnedProcessId
                    selected=$folder
                    driver='Win32 GetDlgItem/WM_SETTEXT/BM_CLICK'
                    popupClass=$popup.ClassName
                    editControlId=1152
                    selectButtonId=1
                } | ConvertTo-Json -Compress
                exit 0
            }
            $observed += [pscustomobject]@{id='native-fallback';type=$nativeSelectionDetail}
            # Native controls can appear after the popup becomes visible. Poll again without entering UIA.
            continue
        }
        $nativeSnapshot = $nativeWindows[$nativeHandle] | ConvertTo-Json -Compress -Depth 6
        [Console]::Error.WriteLine("OWNED_FOLDER_WIN32_CHILDREN $nativeSnapshot")
        [Console]::Error.Flush()
        try {
            if (-not $uiaLoaded) {
                [Console]::Error.WriteLine('OWNED_FOLDER_STAGE load-uia-fallback')
                Add-Type -AssemblyName UIAutomationClient
                Add-Type -AssemblyName UIAutomationTypes
                $uiaLoaded = $true
            }
            $window = [System.Windows.Automation.AutomationElement]::FromHandle($popup.Handle)
            if ($null -eq $window) { continue }
            $observed += [pscustomobject]@{id=$window.Current.AutomationId;type=$popup.ClassName;processId=$popup.ProcessId}
            $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
                [System.Windows.Automation.Condition]::TrueCondition)
        } catch {
            continue
        }
        $entry = $null
        $select = $null
        foreach ($element in $elements) {
            if ($element.Current.ControlType -in @([System.Windows.Automation.ControlType]::Edit,
                [System.Windows.Automation.ControlType]::Button, [System.Windows.Automation.ControlType]::ComboBox)) {
                $observed += [pscustomobject]@{id=$element.Current.AutomationId;type=$element.Current.ControlType.ProgrammaticName;name=$element.Current.Name}
            }
            if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and
                ($element.Current.AutomationId -in @('1148', '1152', 'FileNameTextBox') -or
                 $element.Current.Name -match '^(資料夾|Folder|檔案名稱|File name)[:：]?$')) { $entry = $element }
            if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::ComboBox -and
                $element.Current.AutomationId -eq '1148') {
                $editCondition = [System.Windows.Automation.PropertyCondition]::new(
                    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
                    [System.Windows.Automation.ControlType]::Edit)
                $entry = $element.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCondition)
            }
            if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
                ($element.Current.AutomationId -eq '1' -or
                 $element.Current.Name -match '^(選取資料夾|選擇資料夾|Select Folder|Select folder|Choose folder)$')) { $select = $element }
        }
        if ($null -eq $entry -or $null -eq $select) { continue }
        $value = $entry.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
        $value.SetValue($folder)
        $invoke = $select.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
        $invoke.Invoke()
        @{processId=$OwnedProcessId;selected=$folder;driver='Windows UI Automation'} | ConvertTo-Json -Compress
        exit 0
    }
    Start-Sleep -Milliseconds 100
}
$controls = @($observed | Sort-Object id,type -Unique) | ConvertTo-Json -Compress
$native = @($nativeWindows.Values) | ConvertTo-Json -Compress -Depth 6
throw "OWNED_FOLDER_DIALOG_NOT_FOUND uia=$controls native=$native"
