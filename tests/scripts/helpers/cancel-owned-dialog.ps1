param(
    [Parameter(Mandatory=$true)][ValidateRange(1,2147483647)][int]$OwnedProcessId,
    [ValidateRange(1,30)][int]$TimeoutSeconds = 20,
    [ValidateSet('modutex-desktop-tauri','modutex-mcp-rust-review')][string]$ExpectedProcessName = 'modutex-desktop-tauri'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$owned = Get-Process -Id $OwnedProcessId -ErrorAction Stop
if ($owned.ProcessName -ne $ExpectedProcessName) { throw 'UNEXPECTED_TEST_PROCESS' }
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$processCondition = [System.Windows.Automation.PropertyCondition]::new(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty, $OwnedProcessId)
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while ([DateTime]::UtcNow -lt $deadline) {
    if (-not (Get-Process -Id $OwnedProcessId -ErrorAction SilentlyContinue)) { break }
    $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
        [System.Windows.Automation.TreeScope]::Children, $processCondition)
    foreach ($window in $windows) {
        $elements = $window.FindAll([System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition)
        $hasPrompt = $false
        foreach ($element in $elements) {
            if ($element.Current.Name -match '編輯內容尚未儲存至磁碟|Edits are not saved to disk') {
                $hasPrompt = $true
                break
            }
        }
        if (-not $hasPrompt) { continue }
        foreach ($element in $elements) {
            if ($element.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
                $element.Current.Name -match '^(取消|Cancel)(\s*\([A-Z]\))?$') {
                $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
                $pattern.Invoke()
                @{processId=$OwnedProcessId;cancelPosted=$true;driver='Windows UI Automation'} | ConvertTo-Json -Compress
                exit 0
            }
        }
    }
    Start-Sleep -Milliseconds 100
}
@{processId=$OwnedProcessId;cancelPosted=$false} | ConvertTo-Json -Compress
exit 1
