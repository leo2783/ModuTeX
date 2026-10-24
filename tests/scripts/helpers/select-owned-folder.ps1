param(
    [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$OwnedProcessId,
    [Parameter(Mandatory=$true)][string]$FolderPath,
    [string]$ExpectedExecutablePath,
    [ValidateRange(1,30)][int]$TimeoutSeconds = 30
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$owned = Get-Process -Id $OwnedProcessId -ErrorAction Stop
if ($ExpectedExecutablePath) {
    $expected = (Resolve-Path -LiteralPath $ExpectedExecutablePath).Path
    if (-not [StringComparer]::OrdinalIgnoreCase.Equals($owned.Path, $expected)) { throw 'UNEXPECTED_TEST_EXECUTABLE' }
} elseif ($owned.ProcessName -ne 'modutex-desktop-tauri') { throw 'UNEXPECTED_TEST_PROCESS' }
$folder = (Resolve-Path -LiteralPath $FolderPath).Path
if (-not (Test-Path -LiteralPath $folder -PathType Container)) { throw 'EXPECTED_TEST_FOLDER' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OwnedDialogWindow {
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    public static bool BelongsTo(IntPtr window, uint process) {
        for (int depth = 0; window != IntPtr.Zero && depth < 16; depth++) {
            uint current; GetWindowThreadProcessId(window, out current);
            if (current == process) return true;
            window = GetWindow(window, 4);
        }
        return false;
    }
}
'@
$processCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $OwnedProcessId)
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$observed = @()
while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Get-Process -Id $OwnedProcessId -ErrorAction SilentlyContinue)) { break }
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($window in $windows) {
        if ($window.Current.ProcessId -ne $OwnedProcessId -and
            -not [OwnedDialogWindow]::BelongsTo([IntPtr]::new($window.Current.NativeWindowHandle), [uint32]$OwnedProcessId)) { continue }
        $observed += [pscustomobject]@{id=$window.Current.AutomationId;type=$window.Current.ClassName}
        $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition)
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
throw "OWNED_FOLDER_DIALOG_NOT_FOUND controls=$controls"
