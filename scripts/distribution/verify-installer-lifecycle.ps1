# SPDX-License-Identifier: Apache-2.0
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateLength(1, 4096)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{64}$')]
  [string]$ExpectedInstallerSha256,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{64}$')]
  [string]$ExpectedExecutableSha256,

  [Parameter(Mandatory = $true)]
  [ValidateLength(1, 64)]
  [string]$PackageVersion,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-fA-F]{40}$')]
  [string]$SourceCommit,

  [Parameter(Mandatory = $true)]
  [ValidateSet('online', 'offline')]
  [string]$Lane,

  [Parameter(Mandatory = $true)]
  [ValidateLength(1, 512)]
  [string]$ReceiptPath,

  [ValidateLength(0, 4096)]
  [string]$PriorInstallerPath = '',

  [ValidateLength(0, 64)]
  [string]$PriorVersion = '',

  [ValidateLength(0, 64)]
  [string]$PriorInstallerSha256 = '',

  [ValidateLength(0, 128)]
  [string]$PriorExecutableName = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:scratchRoot = $null
$script:installDirectory = $null
$script:installationOwned = $false
$script:ownerToken = [guid]::NewGuid().ToString('N')
$script:sentinelPath = $null
$script:sentinelSha256 = $null
$script:webView2UserDataPolicyPath = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2\UserDataFolder'
$script:webView2UserDataPolicyName = 'modutex-desktop-tauri.exe'
$script:webView2UserDataPolicyValue = $null
$script:webView2UserDataPolicyValueCreated = $false
$script:webView2UserDataPolicyCreatedKeys = @()
$script:step = 'preflight'
$exitCode = 0

$receipt = [ordered]@{
  schemaVersion = 1
  status = 'not-run'
  timestampUtc = [DateTime]::UtcNow.ToString('o')
  lane = $Lane
  sourceCommit = $SourceCommit.ToLowerInvariant()
  packageVersion = $PackageVersion
  installer = [ordered]@{
    fileName = [IO.Path]::GetFileName($InstallerPath)
    sha256 = $ExpectedInstallerSha256.ToLowerInvariant()
  }
  executableSha256 = $ExpectedExecutableSha256.ToLowerInvariant()
  scratchRoot = $null
  sentinel = [ordered]@{
    path = 'profile/user/Documents/modutex-lifecycle-sentinel.tex'
    sha256 = $null
  }
  steps = [ordered]@{
    preflight = 'not-run'
    initialInstall = 'not-run'
    installedIdentity = 'not-run'
    appLaunch = 'not-run'
    sameVersionRepair = 'not-run'
    initialUninstall = 'not-run'
    sentinelAfterUninstall = 'not-run'
    priorInstall = 'not-run'
    crossVersionUpgrade = 'not-covered'
    crossVersionRollback = 'not-covered'
    restoreCurrentVersion = 'not-run'
    finalUninstall = 'not-run'
    finalSentinel = 'not-run'
    scratchCleanup = 'not-run'
  }
  priorInstaller = $null
  crossVersion = [ordered]@{
    status = 'not-covered'
    reason = 'No prior installer inputs were supplied'
  }
  appLaunch = $null
  failure = $null
  cleanupFailure = $null
  receiptFailure = $null
}

function Get-FullPath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [IO.Path]::GetFullPath($Path)
}

function Assert-ChildPath {
  param(
    [Parameter(Mandatory = $true)][string]$Child,
    [Parameter(Mandatory = $true)][string]$Parent
  )
  $childPath = Get-FullPath $Child
  $parentPath = Get-FullPath $Parent
  $prefix = $parentPath.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
  if (-not $childPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Path is outside its owned parent: $childPath"
  }
}

function Assert-NoReparseAncestors {
  param([Parameter(Mandatory = $true)][string]$Path)
  $current = Get-FullPath $Path
  while ($current) {
    if (Test-Path -LiteralPath $current) {
      $item = Get-Item -LiteralPath $current -Force
      if ($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) {
        throw "Unexpected reparse point in owned path: $current"
      }
    }
    $parent = [IO.Directory]::GetParent($current)
    if ($null -eq $parent) { break }
    $current = $parent.FullName
  }
}

function Get-InstallerHash {
  param([Parameter(Mandatory = $true)][string]$Path)
  $fullPath = Get-FullPath $Path
  if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) { throw "Installer not found: $fullPath" }
  $item = Get-Item -LiteralPath $fullPath -Force
  if ($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -or $item.Extension -ine '.exe') {
    throw "Installer is not a regular executable file: $fullPath"
  }
  if ($item.Length -le 0 -or $item.Length -gt 1GB) { throw 'Installer size is outside the supported limit' }
  return (Get-FileHash -LiteralPath $fullPath -Algorithm SHA256).Hash.ToLowerInvariant()
}

function ConvertTo-StableVersion {
  param([Parameter(Mandatory = $true)][string]$Value)
  if ($Value.Length -gt 64 -or $Value -notmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}$') {
    throw "Expected a stable three-part version, got '$Value'"
  }
  try {
    return [Version]::Parse($Value)
  } catch {
    throw "Invalid stable version '$Value'"
  }
}

function Get-ProductRegistryEntries {
  $entries = @()
  $roots = @(
    'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
    'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
  )
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root)) { continue }
    foreach ($key in (Get-ChildItem -LiteralPath $root -ErrorAction Stop)) {
      $values = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
      $displayNameProp = $values.PSObject.Properties['DisplayName']
      if ($null -eq $displayNameProp -or [string]$displayNameProp.Value -notmatch '^ModuTeX(?:$|[\s._-])') {
        continue
      }
      $installLocationProp = $values.PSObject.Properties['InstallLocation']
      $uninstallStringProp = $values.PSObject.Properties['UninstallString']
      $entries += [pscustomobject]@{
        DisplayName = [string]$displayNameProp.Value
        InstallLocation = if ($null -ne $installLocationProp) { [string]$installLocationProp.Value } else { '' }
        UninstallString = if ($null -ne $uninstallStringProp) { [string]$uninstallStringProp.Value } else { '' }
        RegistryPath = [string]$key.Name
      }
    }
  }
  return $entries
}

function Get-RegistryUninstaller {
  param([Parameter(Mandatory = $true)]$Entry)
  $command = [string]$Entry.UninstallString
  if ($command -match '^\s*"(?<path>[^"]+\.exe)"') {
    return Get-FullPath $Matches.path
  }
  if ($command -match '^\s*(?<path>.+?\.exe)(?:\s|$)') {
    return Get-FullPath $Matches.path
  }
  throw "Uninstall registry entry has no executable path: $($Entry.RegistryPath)"
}

function Get-ProductShortcuts {
  $paths = @()
  $roots = @(
    [Environment]::GetFolderPath([Environment+SpecialFolder]::Programs),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonPrograms),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory)
  )
  foreach ($root in $roots) {
    if ([string]::IsNullOrWhiteSpace($root) -or -not (Test-Path -LiteralPath $root -PathType Container)) { continue }
    foreach ($item in (Get-ChildItem -LiteralPath $root -Force -ErrorAction Stop)) {
      if ($item.Name -notmatch '^ModuTeX(?:$|[\s._-])') { continue }
      if (-not $item.PSIsContainer -and $item.Extension -ieq '.lnk') {
        $paths += $item.FullName
      } elseif ($item.PSIsContainer) {
        $paths += @(Get-ChildItem -LiteralPath $item.FullName -Filter '*.lnk' -File -Recurse -Force -ErrorAction Stop |
          ForEach-Object { $_.FullName })
      }
    }
  }
  return $paths
}

function Assert-ShortcutsTarget {
  param([Parameter(Mandatory = $true)][string]$ExecutablePath)
  $shortcuts = @(Get-ProductShortcuts)
  if ($shortcuts.Count -eq 0) { return 0 }
  $shell = New-Object -ComObject WScript.Shell
  try {
    foreach ($path in $shortcuts) {
      $shortcut = $shell.CreateShortcut($path)
      try {
        if (-not (Test-PathEquals ([string]$shortcut.TargetPath) $ExecutablePath)) {
          throw "ModuTeX shortcut does not target the installed executable: $path"
        }
      } finally {
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
      }
    }
  } finally {
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
  }
  return $shortcuts.Count
}

function Test-PathEquals {
  param([Parameter(Mandatory = $true)][string]$Left, [Parameter(Mandatory = $true)][string]$Right)
  return [string]::Equals((Get-FullPath $Left), (Get-FullPath $Right), [StringComparison]::OrdinalIgnoreCase)
}

function Assert-CleanRunner {
  if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or
    $env:RUNNER_OS -ne 'Windows' -or [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP)) {
    throw 'Installer lifecycle tests require a GitHub-hosted Windows runner'
  }
  if (-not [Environment]::Is64BitOperatingSystem -or -not [Environment]::Is64BitProcess) {
    throw 'Installer lifecycle tests require a Windows x64 runner'
  }

  $processNames = @('modutex-desktop-tauri', 'modutex', 'modutex-desktop')
  if ($PriorExecutableName) {
    $processNames += [IO.Path]::GetFileNameWithoutExtension($PriorExecutableName)
  }
  foreach ($name in ($processNames | Select-Object -Unique)) {
    $running = @(Get-Process -Name $name -ErrorAction SilentlyContinue)
    if ($running.Count -gt 0) { throw "Refusing to test while a ModuTeX process is running: $name" }
  }
  $entries = @(Get-ProductRegistryEntries)
  if ($entries.Count -gt 0) { throw "Refusing to test with an existing ModuTeX uninstall entry: $($entries[0].RegistryPath)" }
  if (@(Get-ProductShortcuts).Count -gt 0) { throw 'Refusing to test with an existing ModuTeX shortcut' }

  $locations = @()
  $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  $programFiles = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles)
  $programFilesX86 = [Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86)
  foreach ($base in @($localAppData, $programFiles, $programFilesX86)) {
    if ([string]::IsNullOrWhiteSpace($base)) { continue }
    $locations += Join-Path $base 'ModuTeX'
    if ($base -eq $localAppData) { $locations += Join-Path $base 'Programs\ModuTeX' }
  }
  foreach ($location in $locations) {
    if (Test-Path -LiteralPath $location) { throw "Refusing to test with an existing ModuTeX install path: $location" }
  }
}

function New-OwnedScratchRoot {
  $parent = Get-FullPath $env:RUNNER_TEMP
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { throw 'RUNNER_TEMP is unavailable' }
  Assert-NoReparseAncestors $parent
  $root = Join-Path $parent ('modutex-installer-lifecycle-' + [guid]::NewGuid().ToString('N'))
  if (Test-Path -LiteralPath $root) { throw 'Fresh lifecycle scratch directory already exists' }
  New-Item -ItemType Directory -Path $root -ErrorAction Stop | Out-Null
  $script:scratchRoot = Get-FullPath $root
  Assert-ChildPath $script:scratchRoot $parent
  $marker = Join-Path $script:scratchRoot '.modutex-installer-lifecycle-owner'
  [IO.File]::WriteAllText($marker, $script:ownerToken, [Text.Encoding]::ASCII)
  $receipt.scratchRoot = $script:scratchRoot
  return $script:scratchRoot
}

function Remove-OwnedScratchRoot {
  if ($script:installationOwned) { throw 'Refusing to remove scratch while ModuTeX is still installed' }
  $parent = Get-FullPath $env:RUNNER_TEMP
  $resolved = (Resolve-Path -LiteralPath $script:scratchRoot -ErrorAction Stop).Path
  if (-not (Test-PathEquals $resolved $script:scratchRoot)) { throw 'Resolved scratch root changed unexpectedly' }
  Assert-ChildPath $resolved $parent
  Assert-NoReparseAncestors $resolved
  $marker = Join-Path $resolved '.modutex-installer-lifecycle-owner'
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf) -or
    [IO.File]::ReadAllText($marker) -cne $script:ownerToken) {
    throw 'Scratch owner marker does not match this test run'
  }
  $reparsePoints = @(Get-ChildItem -LiteralPath $resolved -Force -Recurse -ErrorAction Stop |
    Where-Object { $_.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) })
  if ($reparsePoints.Count -gt 0) { throw "Unexpected reparse point in scratch root: $($reparsePoints[0].FullName)" }
  Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction Stop
}

function Invoke-NSISInstaller {
  param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Sha256)
  if ((Get-InstallerHash $Path) -ne $Sha256.ToLowerInvariant()) { throw "Installer SHA-256 changed before execution: $Path" }
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = Get-FullPath $Path
  $start.WorkingDirectory = Split-Path -Parent $start.FileName
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  [void]$start.ArgumentList.Add('/S')
  [void]$start.ArgumentList.Add("/D=$script:installDirectory")
  $process = [Diagnostics.Process]::Start($start)
  if ($null -eq $process) { throw "Failed to start installer: $Path" }
  try {
    if (-not $process.WaitForExit(300000)) {
      $process.Kill()
      [void]$process.WaitForExit(10000)
      throw "Installer timed out: $Path"
    }
    if ($process.ExitCode -ne 0) { throw "Installer failed with exit code $($process.ExitCode): $Path" }
  } finally {
    $process.Dispose()
  }
}

function Assert-InstalledIdentity {
  param(
    [Parameter(Mandatory = $true)][string]$Version,
    [Parameter(Mandatory = $true)][string]$ExecutableName,
    [string]$ExecutableSha256 = ''
  )
  $expectedVersion = ConvertTo-StableVersion $Version
  $path = Join-Path $script:installDirectory $ExecutableName
  Assert-ChildPath $path $script:installDirectory
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Installed executable is missing: $ExecutableName" }
  $item = Get-Item -LiteralPath $path -Force
  if ($item.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'Installed executable is an unexpected reparse point' }
  if ([string]$item.VersionInfo.ProductName -notmatch '^ModuTeX(?:$|[\s._-])') {
    throw "Installed executable ProductName mismatch: '$($item.VersionInfo.ProductName)'"
  }
  $versionText = [string]$item.VersionInfo.ProductVersion
  if ($versionText -notmatch '^\d{1,5}\.\d{1,5}\.\d{1,5}(?:\.0)?$') { throw "Invalid installed PE ProductVersion: '$versionText'" }
  $actualVersion = [Version]::Parse($versionText)
  if ($actualVersion.Major -ne $expectedVersion.Major -or $actualVersion.Minor -ne $expectedVersion.Minor -or
    $actualVersion.Build -ne $expectedVersion.Build -or $actualVersion.Revision -notin @(-1, 0)) {
    throw "Installed PE version '$versionText' does not match '$Version'"
  }
  $hash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($ExecutableSha256 -and $hash -ne $ExecutableSha256.ToLowerInvariant()) {
    throw "Installed executable SHA-256 mismatch: expected $ExecutableSha256, got $hash"
  }

  $entries = @(Get-ProductRegistryEntries)
  if ($entries.Count -ne 1) { throw "Expected one ModuTeX uninstall entry for the owned install, found $($entries.Count)" }
  if ($entries[0].InstallLocation -and -not (Test-PathEquals $entries[0].InstallLocation.Trim('"') $script:installDirectory)) {
    throw 'ModuTeX uninstall registry entry does not identify the exact scratch install'
  }
  $uninstaller = Get-RegistryUninstaller $entries[0]
  Assert-ChildPath $uninstaller $script:installDirectory
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'Owned NSIS uninstaller is missing' }
  $shortcutCount = Assert-ShortcutsTarget $path
  return [pscustomobject]@{
    version = $versionText
    executableName = $ExecutableName
    sha256 = $hash
    shortcutCount = $shortcutCount
  }
}

function New-IsolatedInstalledAppProfile {
  $profile = Join-Path $script:scratchRoot 'profile'
  $userProfile = Join-Path $profile 'user'
  $appDataRoot = Join-Path $userProfile 'AppData'
  $roamingAppData = Join-Path $appDataRoot 'Roaming'
  $localAppData = Join-Path $appDataRoot 'Local'
  $temporary = Join-Path $profile 'temp'
  $webViewData = Join-Path $profile 'webview2'

  Assert-ChildPath $userProfile $script:scratchRoot
  if (-not (Test-Path -LiteralPath $userProfile -PathType Container)) { throw 'Preflight user profile is missing' }
  Assert-NoReparseAncestors $userProfile
  foreach ($directory in @($appDataRoot, $roamingAppData, $localAppData, $temporary)) {
    Assert-ChildPath $directory $script:scratchRoot
    if (Test-Path -LiteralPath $directory) { throw "Isolated profile path already exists: $directory" }
    [IO.Directory]::CreateDirectory($directory) | Out-Null
  }
  Assert-ChildPath $webViewData $script:scratchRoot

  return [pscustomobject]@{
    UserProfile = $userProfile
    RoamingAppData = $roamingAppData
    LocalAppData = $localAppData
    Temporary = $temporary
    WebViewData = $webViewData
  }
}

function Get-RegistryValueNames {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return @() }
  return @((Get-Item -LiteralPath $Path -ErrorAction Stop).GetValueNames())
}

function Remove-TemporaryWebView2UserDataPolicy {
  if ($script:webView2UserDataPolicyValueCreated -and
    (Test-Path -LiteralPath $script:webView2UserDataPolicyPath)) {
    $key = Get-Item -LiteralPath $script:webView2UserDataPolicyPath -ErrorAction Stop
    if ($key.GetValueNames() -contains $script:webView2UserDataPolicyName) {
      $value = [string]$key.GetValue(
        $script:webView2UserDataPolicyName,
        $null,
        [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
      )
      if ($key.GetValueKind($script:webView2UserDataPolicyName) -ne [Microsoft.Win32.RegistryValueKind]::String -or
        -not [string]::Equals($value, $script:webView2UserDataPolicyValue, [StringComparison]::Ordinal)) {
        throw "Refusing to remove changed WebView2 UserDataFolder policy at '$script:webView2UserDataPolicyPath'"
      }
      Remove-ItemProperty -LiteralPath $script:webView2UserDataPolicyPath `
        -Name $script:webView2UserDataPolicyName -ErrorAction Stop
    }
  }
  $script:webView2UserDataPolicyValueCreated = $false

  for ($index = $script:webView2UserDataPolicyCreatedKeys.Count - 1; $index -ge 0; $index--) {
    $path = $script:webView2UserDataPolicyCreatedKeys[$index]
    if (-not (Test-Path -LiteralPath $path)) { continue }
    $key = Get-Item -LiteralPath $path -ErrorAction Stop
    if ($key.SubKeyCount -eq 0 -and $key.ValueCount -eq 0) {
      Remove-Item -LiteralPath $path -Force -ErrorAction Stop
    }
  }
  $script:webView2UserDataPolicyCreatedKeys = @()
  $script:webView2UserDataPolicyValue = $null
}

function Set-TemporaryWebView2UserDataPolicy {
  param([Parameter(Mandatory = $true)][string]$ProfilePath)
  if ($script:webView2UserDataPolicyValueCreated -or $script:webView2UserDataPolicyCreatedKeys.Count -gt 0) {
    throw 'A temporary WebView2 UserDataFolder policy is already tracked by this run'
  }
  $profilePath = Get-FullPath $ProfilePath
  Assert-ChildPath $profilePath $script:scratchRoot
  Assert-NoReparseAncestors (Split-Path -Parent $profilePath)
  if (Test-Path -LiteralPath $profilePath) { throw 'WebView2 user-data path must be created by the installed application' }

  $policyValuePaths = @(
    $script:webView2UserDataPolicyPath,
    'HKCU:\SOFTWARE\Policies\Microsoft\Edge\WebView2\UserDataFolder'
  )
  foreach ($path in $policyValuePaths) {
    $names = @(Get-RegistryValueNames $path)
    if ($names -contains '*') { throw "A wildcard WebView2 UserDataFolder policy is present at '$path'" }
    if ($names -contains $script:webView2UserDataPolicyName) {
      throw "An application-scoped WebView2 UserDataFolder policy already exists at '$path'"
    }
  }

  $keyPaths = @(
    'HKLM:\SOFTWARE\Policies\Microsoft\Edge',
    'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2',
    $script:webView2UserDataPolicyPath
  )
  $script:webView2UserDataPolicyCreatedKeys = @($keyPaths | Where-Object { -not (Test-Path -LiteralPath $_) })
  $script:webView2UserDataPolicyValue = $profilePath
  try {
    New-Item -Path $script:webView2UserDataPolicyPath -Force -ErrorAction Stop | Out-Null
    # Mark before writing so a partial registry write is still checked and rolled back.
    $script:webView2UserDataPolicyValueCreated = $true
    New-ItemProperty -LiteralPath $script:webView2UserDataPolicyPath `
      -Name $script:webView2UserDataPolicyName -Value $profilePath -PropertyType String -ErrorAction Stop | Out-Null

    $key = Get-Item -LiteralPath $script:webView2UserDataPolicyPath -ErrorAction Stop
    $actualValue = [string]$key.GetValue(
      $script:webView2UserDataPolicyName,
      $null,
      [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
    )
    if ($key.GetValueKind($script:webView2UserDataPolicyName) -ne [Microsoft.Win32.RegistryValueKind]::String -or
      -not [string]::Equals($actualValue, $profilePath, [StringComparison]::Ordinal)) {
      throw 'Application-scoped WebView2 UserDataFolder policy did not verify as the expected REG_SZ'
    }
  } catch {
    $setupFailure = $_
    try {
      Remove-TemporaryWebView2UserDataPolicy
    } catch {
      throw "WebView2 UserDataFolder policy setup failed ($($setupFailure.Exception.Message)); rollback failed: $($_.Exception.Message)"
    }
    throw $setupFailure
  }
}

function New-BoundedProcessStreamCapture {
  param(
    [Parameter(Mandatory = $true)][IO.Stream]$Stream,
    [ValidateRange(1, 65536)][int]$MaximumCharacters = 8192
  )
  $captureTypeName = 'ModuTeX.InstallerLifecycle.BoundedStreamCapture'
  if (-not ($captureTypeName -as [type])) {
    Add-Type -Language CSharp -ErrorAction Stop -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.Threading.Tasks;

namespace ModuTeX.InstallerLifecycle {
    public sealed class BoundedStreamCapture {
        private readonly object sync = new object();
        private readonly StringBuilder tail = new StringBuilder();
        private readonly int maximumCharacters;
        public Task Completion { get; private set; }

        public BoundedStreamCapture(Stream stream, int maximumCharacters) {
            if (stream == null || !stream.CanRead) throw new ArgumentException("A readable stream is required", "stream");
            if (maximumCharacters < 1 || maximumCharacters > 65536) throw new ArgumentOutOfRangeException("maximumCharacters");
            this.maximumCharacters = maximumCharacters;
            Completion = Task.Run(() => CaptureAsync(stream));
        }

        private async Task CaptureAsync(Stream stream) {
            using (var reader = new StreamReader(stream, Encoding.UTF8, true, 1024, true)) {
                var chunk = new char[1024];
                int count;
                while ((count = await reader.ReadAsync(chunk, 0, chunk.Length).ConfigureAwait(false)) > 0) {
                    lock (sync) {
                        if (count >= maximumCharacters) {
                            tail.Clear();
                            tail.Append(chunk, count - maximumCharacters, maximumCharacters);
                        } else {
                            var excess = tail.Length + count - maximumCharacters;
                            if (excess > 0) tail.Remove(0, excess);
                            tail.Append(chunk, 0, count);
                        }
                    }
                }
            }
        }

        public string GetTail() {
            lock (sync) return tail.ToString();
        }
    }
}
'@
  }
  $captureType = $captureTypeName -as [type]
  if ($null -eq $captureType) { throw 'Bounded process stream capture type was not registered' }
  return $captureType::new($Stream, $MaximumCharacters)
}

function Get-BoundedProcessOutput {
  param(
    [Parameter(Mandatory = $true)]$Capture,
    [ValidateRange(0, 30000)][int]$DrainTimeoutMilliseconds = 5000
  )
  $completed = $false
  $captureFailure = $null
  try {
    $completed = $Capture.Completion.Wait($DrainTimeoutMilliseconds)
  } catch {
    $captureFailure = $_.Exception.GetBaseException().Message
  }
  $tail = [string]$Capture.GetTail()
  if ($captureFailure) {
    return "[output capture failed: $captureFailure]`n$tail"
  }
  if (-not $completed) {
    return "[output stream remained open after ${DrainTimeoutMilliseconds}ms; showing bounded tail]`n$tail"
  }
  return $tail
}

function Format-IsolatedAppDiagnostics {
  param($StdoutCapture, $StderrCapture)
  $stdout = if ($null -eq $StdoutCapture) { '' } else { Get-BoundedProcessOutput -Capture $StdoutCapture }
  $stderr = if ($null -eq $StderrCapture) { '' } else { Get-BoundedProcessOutput -Capture $StderrCapture }
  $stdoutText = if ([string]::IsNullOrWhiteSpace($stdout)) { '<empty>' } else { $stdout.TrimEnd() }
  $stderrText = if ([string]::IsNullOrWhiteSpace($stderr)) { '<empty>' } else { $stderr.TrimEnd() }
  return "Installed process output (stdout tail):`n$stdoutText`nInstalled process output (stderr tail):`n$stderrText"
}

function Assert-InstalledAppStillRunningDuringStartup {
  param(
    [Parameter(Mandatory = $true)][Diagnostics.Process]$Process,
    $StdoutCapture,
    $StderrCapture
  )
  $Process.Refresh()
  if ($Process.HasExited) {
    $diagnostics = Format-IsolatedAppDiagnostics -StdoutCapture $StdoutCapture -StderrCapture $StderrCapture
    throw "Installed ModuTeX exited during startup with code $($Process.ExitCode).`n$diagnostics"
  }
}

function Start-IsolatedInstalledApp {
  $executable = Join-Path $script:installDirectory 'modutex-desktop-tauri.exe'
  $profilePaths = New-IsolatedInstalledAppProfile
  $userProfile = $profilePaths.UserProfile
  $webViewData = $profilePaths.WebViewData
  $appData = $profilePaths.RoamingAppData
  $localAppData = $profilePaths.LocalAppData
  $temporary = $profilePaths.Temporary
  Assert-ChildPath $script:sentinelPath $script:scratchRoot
  Assert-NoReparseAncestors $script:sentinelPath
  Assert-Sentinel

  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $executable
  $start.WorkingDirectory = $script:installDirectory
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Environment['USERPROFILE'] = $userProfile
  $start.Environment['HOME'] = $userProfile
  $start.Environment['APPDATA'] = $appData
  $start.Environment['LOCALAPPDATA'] = $localAppData
  $start.Environment['TEMP'] = $temporary
  $start.Environment['TMP'] = $temporary
  $start.Environment['WEBVIEW2_USER_DATA_FOLDER'] = $webViewData
  $start.Environment['RUST_BACKTRACE'] = '1'
  [void]$start.Environment.Remove('GH_TOKEN')
  [void]$start.Environment.Remove('GITHUB_TOKEN')

  $stdoutCapture = $null
  $stderrCapture = $null
  $process = $null
  $exitMethod = 'close-main-window'
  try {
    Set-TemporaryWebView2UserDataPolicy -ProfilePath $webViewData
    $process = [Diagnostics.Process]::Start($start)
    if ($null -eq $process) { throw 'Failed to start the installed ModuTeX executable' }
    $stdoutCapture = New-BoundedProcessStreamCapture -Stream $process.StandardOutput.BaseStream
    $stderrCapture = New-BoundedProcessStreamCapture -Stream $process.StandardError.BaseStream
    Assert-InstalledAppStillRunningDuringStartup -Process $process `
      -StdoutCapture $stdoutCapture -StderrCapture $stderrCapture
    try {
      $startedExecutable = $process.MainModule.FileName
    } catch {
      Assert-InstalledAppStillRunningDuringStartup -Process $process `
        -StdoutCapture $stdoutCapture -StderrCapture $stderrCapture
      throw
    }
    if (-not (Test-PathEquals $startedExecutable $executable)) {
      throw 'Started process does not belong to the owned installed executable'
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    while ([DateTime]::UtcNow -lt $deadline) {
      Assert-InstalledAppStillRunningDuringStartup -Process $process `
        -StdoutCapture $stdoutCapture -StderrCapture $stderrCapture
      if ($process.MainWindowHandle -ne [IntPtr]::Zero) { break }
      Start-Sleep -Milliseconds 250
    }
    Assert-InstalledAppStillRunningDuringStartup -Process $process `
      -StdoutCapture $stdoutCapture -StderrCapture $stderrCapture
    if ($process.MainWindowHandle -eq [IntPtr]::Zero) {
      $diagnostics = Format-IsolatedAppDiagnostics -StdoutCapture $stdoutCapture -StderrCapture $stderrCapture
      throw "Installed ModuTeX did not create a main window.`n$diagnostics"
    }
    $profileDeadline = [DateTime]::UtcNow.AddSeconds(20)
    while (-not (Test-Path -LiteralPath $webViewData -PathType Container) -and [DateTime]::UtcNow -lt $profileDeadline) {
      Start-Sleep -Milliseconds 250
    }
    if (-not (Test-Path -LiteralPath $webViewData -PathType Container)) {
      $diagnostics = Format-IsolatedAppDiagnostics -StdoutCapture $stdoutCapture -StderrCapture $stderrCapture
      throw "WebView2 did not use the isolated user-data directory.`n$diagnostics"
    }
    Assert-ChildPath $webViewData $script:scratchRoot
    $closeRequested = $process.CloseMainWindow()
    if (-not $process.WaitForExit(15000)) {
      $process.Kill()
      $exitMethod = 'owned-process-handle'
      if (-not $process.WaitForExit(10000)) { throw 'Owned ModuTeX process did not exit after direct termination' }
    }
    $null = Get-BoundedProcessOutput -Capture $stdoutCapture
    $null = Get-BoundedProcessOutput -Capture $stderrCapture
    return [pscustomobject]@{
      processId = $process.Id
      closeMainWindowRequested = $closeRequested
      exitMethod = $exitMethod
      webViewProfile = 'profile/webview2'
      exited = $process.HasExited
    }
  } finally {
    if ($null -ne $process -and -not $process.HasExited) {
      try {
        $process.Kill()
        [void]$process.WaitForExit(10000)
      } catch {}
    }
    if ($null -ne $process) { $process.Dispose() }
    Remove-TemporaryWebView2UserDataPolicy
  }
}

function Assert-Sentinel {
  if (-not (Test-Path -LiteralPath $script:sentinelPath -PathType Leaf)) { throw 'Owned document sentinel is missing' }
  $hash = (Get-FileHash -LiteralPath $script:sentinelPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($hash -ne $script:sentinelSha256) { throw 'Owned document sentinel changed' }
}

function New-OwnedUninstallerStartInfo {
  param([Parameter(Mandatory = $true)][string]$UninstallerPath)
  if ([string]::IsNullOrWhiteSpace($script:scratchRoot) -or [string]::IsNullOrWhiteSpace($script:installDirectory)) {
    throw 'Owned scratch and install directories are required before preparing the uninstaller'
  }
  $sourcePath = Get-FullPath $UninstallerPath
  Assert-ChildPath $sourcePath $script:installDirectory
  Assert-NoReparseAncestors $sourcePath
  if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) { throw 'Owned NSIS uninstaller is missing' }

  $workerPath = Join-Path $script:scratchRoot 'uninstaller-worker.exe'
  Assert-ChildPath $workerPath $script:scratchRoot
  Assert-NoReparseAncestors $script:scratchRoot
  if (Test-Path -LiteralPath $workerPath) { throw 'Owned scratch uninstaller worker already exists' }
  $sourceHash = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash.ToLowerInvariant()
  Copy-Item -LiteralPath $sourcePath -Destination $workerPath -ErrorAction Stop
  Assert-NoReparseAncestors $workerPath
  $workerItem = Get-Item -LiteralPath $workerPath -Force
  if ($workerItem.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) -or $workerItem.Extension -ine '.exe') {
    throw 'Temporary NSIS uninstaller worker is not a regular executable file'
  }
  $workerHash = (Get-FileHash -LiteralPath $workerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($workerHash -ne $sourceHash) { throw 'Temporary NSIS uninstaller worker differs from the owned uninstaller' }

  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $workerPath
  $start.WorkingDirectory = $script:scratchRoot
  $start.UseShellExecute = $false
  $start.CreateNoWindow = $true
  $start.Arguments = "/S _?=$script:installDirectory"
  return $start
}

function Invoke-OwnedUninstaller {
  $entries = @(Get-ProductRegistryEntries)
  $uninstaller = $null
  if ($entries.Count -eq 1) {
    $uninstaller = Get-RegistryUninstaller $entries[0]
  } else {
    $candidates = @(Get-ChildItem -LiteralPath $script:installDirectory -Filter '*.exe' -File -Force -ErrorAction SilentlyContinue |
      Where-Object { $_.Name -match '^(?:uninstall|unins).*\.exe$' })
    $preferred = @($candidates | Where-Object { $_.Name -ieq 'uninstall.exe' })
    if ($preferred.Count -eq 1) {
      $uninstaller = $preferred[0].FullName
    } elseif ($candidates.Count -eq 1) {
      $uninstaller = $candidates[0].FullName
    } else {
      throw 'Cannot identify one uninstaller inside the owned install directory'
    }
  }
  Assert-ChildPath $uninstaller $script:installDirectory
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'Owned uninstaller is missing' }
  $start = New-OwnedUninstallerStartInfo -UninstallerPath $uninstaller
  $workerPath = $start.FileName
  $workerHash = (Get-FileHash -LiteralPath $workerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $process = $null
  try {
    $process = [Diagnostics.Process]::Start($start)
    if ($null -eq $process) { throw 'Failed to start the owned NSIS uninstaller' }
    if (-not $process.WaitForExit(300000)) {
      $process.Kill()
      if (-not $process.WaitForExit(10000)) { throw 'Owned NSIS uninstaller did not exit after direct termination' }
      throw 'Owned NSIS uninstaller timed out'
    }
    if ($process.ExitCode -ne 0) { throw "Owned NSIS uninstaller failed with exit code $($process.ExitCode)" }
  } finally {
    $processExited = $null -eq $process -or $process.HasExited
    if ($null -ne $process) { $process.Dispose() }
    if ($processExited -and (Test-Path -LiteralPath $workerPath -PathType Leaf)) {
      Assert-ChildPath $workerPath $script:scratchRoot
      Assert-NoReparseAncestors $workerPath
      $actualWorkerHash = (Get-FileHash -LiteralPath $workerPath -Algorithm SHA256).Hash.ToLowerInvariant()
      if ($actualWorkerHash -ne $workerHash) { throw 'Temporary NSIS uninstaller worker changed during execution' }
      Remove-Item -LiteralPath $workerPath -Force -ErrorAction Stop
    }
  }
  if (Test-Path -LiteralPath $script:installDirectory) {
    $files = @(Get-ChildItem -LiteralPath $script:installDirectory -File -Recurse -Force -ErrorAction Stop)
    if ($files.Count -gt 0) { throw "Installed files remain after uninstall: $($files[0].FullName)" }
  }
  if (@(Get-ProductRegistryEntries).Count -gt 0) { throw 'ModuTeX uninstall registry entry remains after uninstall' }
  if (@(Get-ProductShortcuts).Count -gt 0) { throw 'ModuTeX shortcut remains after uninstall' }
  Assert-Sentinel
  $script:installationOwned = $false
}

function Cleanup-OwnedInstallation {
  if (-not $script:installationOwned) { return }
  if (-not (Test-Path -LiteralPath $script:installDirectory -PathType Container)) {
    if (@(Get-ProductRegistryEntries).Count -gt 0 -or @(Get-ProductShortcuts).Count -gt 0) {
      throw 'Owned install directory is missing but ModuTeX registry or shortcuts remain'
    }
    $script:installationOwned = $false
    return
  }
  $files = @(Get-ChildItem -LiteralPath $script:installDirectory -File -Recurse -Force -ErrorAction Stop)
  if ($files.Count -eq 0 -and @(Get-ProductRegistryEntries).Count -eq 0 -and @(Get-ProductShortcuts).Count -eq 0) {
    $script:installationOwned = $false
    return
  }
  Invoke-OwnedUninstaller
}

function Write-LifecycleReceipt {
  $workingRoot = Get-FullPath (Get-Location).Path
  $path = if ([IO.Path]::IsPathRooted($ReceiptPath)) { Get-FullPath $ReceiptPath } else { Get-FullPath (Join-Path $workingRoot $ReceiptPath) }
  Assert-ChildPath $path $workingRoot
  $directory = Split-Path -Parent $path
  if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
    New-Item -ItemType Directory -Path $directory -Force -ErrorAction Stop | Out-Null
  }
  $receipt.timestampUtc = [DateTime]::UtcNow.ToString('o')
  ConvertTo-Json -InputObject $receipt -Depth 8 | Set-Content -LiteralPath $path -Encoding utf8
}

try {
  $expectedVersion = ConvertTo-StableVersion $PackageVersion
  if ($SourceCommit -notmatch '^[0-9a-fA-F]{40}$') { throw 'Source commit must be a full 40-character SHA' }
  $currentInstallerHash = Get-InstallerHash $InstallerPath
  if ($currentInstallerHash -ne $ExpectedInstallerSha256.ToLowerInvariant()) { throw 'Installer SHA-256 mismatch' }

  $priorFields = @($PriorInstallerPath, $PriorVersion, $PriorInstallerSha256, $PriorExecutableName)
  $priorCount = @($priorFields | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count
  if ($priorCount -ne 0 -and $priorCount -ne 4) {
    throw 'Prior installer path, version, SHA-256, and executable basename must be supplied together'
  }
  if ($priorCount -eq 4) {
    $priorVersionValue = ConvertTo-StableVersion $PriorVersion
    if ($priorVersionValue -ge $expectedVersion) { throw 'Prior installer version must be older than the package under test' }
    if ($PriorInstallerSha256 -notmatch '^[0-9a-fA-F]{64}$') { throw 'Prior installer SHA-256 is invalid' }
    if ($PriorExecutableName -notmatch '^[A-Za-z0-9][A-Za-z0-9_.-]{0,123}\.exe$') {
      throw 'Prior executable name must be a basename ending in .exe'
    }
    $priorHash = Get-InstallerHash $PriorInstallerPath
    if ($priorHash -ne $PriorInstallerSha256.ToLowerInvariant()) { throw 'Prior installer SHA-256 mismatch' }
    $receipt.priorInstaller = [ordered]@{
      fileName = [IO.Path]::GetFileName($PriorInstallerPath)
      version = $PriorVersion
      sha256 = $priorHash
      executableName = $PriorExecutableName
    }
    $receipt.crossVersion.status = 'pending'
    $receipt.steps.crossVersionUpgrade = 'not-run'
    $receipt.steps.crossVersionRollback = 'not-run'
  }

  Assert-CleanRunner
  $null = New-OwnedScratchRoot
  $script:installDirectory = Join-Path $script:scratchRoot 'installation'
  $profile = Join-Path $script:scratchRoot 'profile'
  $script:sentinelPath = Join-Path $profile 'user\Documents\modutex-lifecycle-sentinel.tex'
  foreach ($directory in @($script:installDirectory, (Join-Path $profile 'user'), (Join-Path $profile 'user\Documents'))) {
    Assert-ChildPath $directory $script:scratchRoot
    if (Test-Path -LiteralPath $directory) { throw 'Fresh owned lifecycle path already exists' }
    [IO.Directory]::CreateDirectory($directory) | Out-Null
  }
  [IO.File]::WriteAllText($script:sentinelPath, "ModuTeX lifecycle document sentinel`n", [Text.Encoding]::UTF8)
  $script:sentinelSha256 = (Get-FileHash -LiteralPath $script:sentinelPath -Algorithm SHA256).Hash.ToLowerInvariant()
  $receipt.sentinel.sha256 = $script:sentinelSha256
  $receipt.steps.preflight = 'passed'

  $script:step = 'initialInstall'
  $script:installationOwned = $true
  Invoke-NSISInstaller -Path $InstallerPath -Sha256 $ExpectedInstallerSha256
  $receipt.steps.initialInstall = 'passed'

  $script:step = 'installedIdentity'
  $currentIdentity = Assert-InstalledIdentity -Version $PackageVersion -ExecutableName 'modutex-desktop-tauri.exe' -ExecutableSha256 $ExpectedExecutableSha256
  $receipt.steps.installedIdentity = 'passed'
  $receipt.installedIdentity = $currentIdentity

  $script:step = 'appLaunch'
  Assert-Sentinel
  $receipt.appLaunch = Start-IsolatedInstalledApp
  $receipt.steps.appLaunch = 'passed'

  $script:step = 'sameVersionRepair'
  Invoke-NSISInstaller -Path $InstallerPath -Sha256 $ExpectedInstallerSha256
  $receipt.sameVersionRepair = Assert-InstalledIdentity -Version $PackageVersion -ExecutableName 'modutex-desktop-tauri.exe' -ExecutableSha256 $ExpectedExecutableSha256
  $receipt.steps.sameVersionRepair = 'passed'

  $script:step = 'initialUninstall'
  Invoke-OwnedUninstaller
  $receipt.steps.initialUninstall = 'passed'
  $receipt.steps.sentinelAfterUninstall = 'passed'

  if ($priorCount -eq 4) {
    $script:step = 'priorInstall'
    $script:installationOwned = $true
    Invoke-NSISInstaller -Path $PriorInstallerPath -Sha256 $PriorInstallerSha256
    $receipt.priorInstalledIdentity = Assert-InstalledIdentity -Version $PriorVersion -ExecutableName $PriorExecutableName
    $receipt.steps.priorInstall = 'passed'

    $script:step = 'crossVersionUpgrade'
    Invoke-NSISInstaller -Path $InstallerPath -Sha256 $ExpectedInstallerSha256
    $receipt.crossVersionUpgrade = Assert-InstalledIdentity -Version $PackageVersion -ExecutableName 'modutex-desktop-tauri.exe' -ExecutableSha256 $ExpectedExecutableSha256
    Assert-Sentinel
    $receipt.steps.crossVersionUpgrade = 'passed'

    $script:step = 'crossVersionRollback'
    Invoke-NSISInstaller -Path $PriorInstallerPath -Sha256 $PriorInstallerSha256
    $receipt.crossVersionRollback = Assert-InstalledIdentity -Version $PriorVersion -ExecutableName $PriorExecutableName
    Assert-Sentinel
    $receipt.steps.crossVersionRollback = 'passed'

    $script:step = 'restoreCurrentVersion'
    Invoke-NSISInstaller -Path $InstallerPath -Sha256 $ExpectedInstallerSha256
    $null = Assert-InstalledIdentity -Version $PackageVersion -ExecutableName 'modutex-desktop-tauri.exe' -ExecutableSha256 $ExpectedExecutableSha256
    $receipt.steps.restoreCurrentVersion = 'passed'

    $script:step = 'finalUninstall'
    Invoke-OwnedUninstaller
    $receipt.steps.finalUninstall = 'passed'
    Assert-Sentinel
    $receipt.steps.finalSentinel = 'passed'
    $receipt.crossVersion.status = 'passed'
    $receipt.crossVersion.reason = $null
  }

  $receipt.status = 'passed'
} catch {
  $exitCode = 1
  $receipt.status = 'failed'
  $receipt.failure = $_.Exception.Message
  if ($receipt.steps.Contains($script:step)) { $receipt.steps[$script:step] = 'failed' }
  if ($receipt.crossVersion.status -eq 'pending') { $receipt.crossVersion.status = 'failed' }
} finally {
  if ($script:installationOwned) {
    try {
      Cleanup-OwnedInstallation
    } catch {
      $exitCode = 1
      $receipt.status = 'failed'
      $receipt.cleanupFailure = $_.Exception.Message
    }
  }
  if (-not $script:installationOwned -and $script:scratchRoot -and
    (Test-Path -LiteralPath $script:scratchRoot -PathType Container)) {
    try {
      Remove-OwnedScratchRoot
      $receipt.steps.scratchCleanup = 'passed'
    } catch {
      $exitCode = 1
      $receipt.status = 'failed'
      $receipt.cleanupFailure = $_.Exception.Message
      $receipt.steps.scratchCleanup = 'failed'
    }
  }
  if ($exitCode -ne 0) { $receipt.status = 'failed' }
  try {
    Write-LifecycleReceipt
  } catch {
    $exitCode = 1
    $receipt.status = 'failed'
    $receipt.receiptFailure = $_.Exception.Message
    [Console]::Error.WriteLine("Failed to write lifecycle receipt: $($_.Exception.Message)")
  }
}

if ($exitCode -ne 0) {
  if ($receipt.failure) { [Console]::Error.WriteLine("Installer lifecycle failed: $($receipt.failure)") }
  if ($receipt.cleanupFailure) { [Console]::Error.WriteLine("Installer lifecycle cleanup failed: $($receipt.cleanupFailure)") }
  exit 1
}

Write-Host "NSIS $Lane lifecycle passed"
exit 0
