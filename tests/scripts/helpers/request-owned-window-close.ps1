param(
  [Parameter(Mandatory = $true)][int]$OwnedProcessId,
  [Parameter(Mandatory = $true)][string]$ExpectedExecutable
)
$ErrorActionPreference = 'Stop'
$process = Get-Process -Id $OwnedProcessId -ErrorAction Stop
$expected = [IO.Path]::GetFullPath($ExpectedExecutable)
if (-not [string]::Equals($process.Path, $expected, [StringComparison]::OrdinalIgnoreCase)) {
  throw 'Window close target does not match the test executable'
}
$process.Refresh()
if ($process.MainWindowHandle -eq [IntPtr]::Zero) { throw 'Owned test process has no main window' }
if (-not $process.CloseMainWindow()) { throw 'Owned window refused the close request' }
Write-Output 'Owned native window close requested'
