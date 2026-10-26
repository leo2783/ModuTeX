param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Configure', 'Cleanup')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
$port = 9222
$appName = 'modutex-desktop-tauri.exe'
$browserArguments = "--remote-debugging-port=$port --remote-debugging-address=127.0.0.1"
$policyRoot = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2'
$argumentsPolicy = Join-Path $policyRoot 'AdditionalBrowserArguments'
$userDataPolicy = Join-Path $policyRoot 'UserDataFolder'

function Test-GitHubHostedWindowsRunner {
    return $env:GITHUB_ACTIONS -eq 'true' -and
        $env:RUNNER_ENVIRONMENT -eq 'github-hosted' -and
        $env:RUNNER_OS -eq 'Windows' -and
        $env:GITHUB_JOB -in @('native-e2e', 'release-build-and-sign') -and
        -not [string]::IsNullOrWhiteSpace($env:RUNNER_TEMP) -and
        -not [string]::IsNullOrWhiteSpace($env:GITHUB_WORKSPACE)
}

function Get-PolicyValueNames([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return @() }
    return @((Get-Item -LiteralPath $Path).GetValueNames())
}

function Remove-ExactPolicyValue([string]$Path, [string]$Name, [string]$ExpectedValue) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $key = Get-Item -LiteralPath $Path
    if ($key.GetValueNames() -notcontains $Name) { return }
    $value = [string]$key.GetValue($Name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    if ($key.GetValueKind($Name) -ne [Microsoft.Win32.RegistryValueKind]::String -or
        -not [string]::Equals($value, $ExpectedValue, [System.StringComparison]::Ordinal)) {
        throw "Refusing to remove changed WebView2 policy value '$Name' at '$Path'"
    }
    Remove-ItemProperty -LiteralPath $Path -Name $Name -ErrorAction Stop
}

function Get-IsolatedUserDataPath {
    $runnerTemp = [System.IO.Path]::GetFullPath($env:RUNNER_TEMP)
    $jobName = [System.Text.RegularExpressions.Regex]::Replace([string]$env:GITHUB_JOB, '[^A-Za-z0-9._-]', '_')
    $leaf = "modutex-webview2-cdp-$($env:GITHUB_RUN_ID)-$($env:GITHUB_RUN_ATTEMPT)-$jobName"
    $path = [System.IO.Path]::GetFullPath((Join-Path $runnerTemp $leaf))
    $runnerPrefix = $runnerTemp.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $path.StartsWith($runnerPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'The WebView2 profile directory must be below RUNNER_TEMP'
    }
    return $path
}

function Assert-PolicyScopeIsAvailable {
    foreach ($root in @('HKLM:', 'HKCU:')) {
        foreach ($leaf in @('AdditionalBrowserArguments', 'UserDataFolder')) {
            $path = Join-Path (Join-Path $root 'SOFTWARE\Policies\Microsoft\Edge\WebView2') $leaf
            if ((Get-PolicyValueNames $path) -contains '*') {
                throw "A wildcard WebView2 $leaf policy is present at '$path'; refusing broad CDP configuration"
            }
        }
    }
    foreach ($path in @($argumentsPolicy, $userDataPolicy)) {
        if ((Get-PolicyValueNames $path) -contains $appName) {
            throw "An application-scoped WebView2 policy already exists at '$path'; refusing to overwrite it"
        }
    }
}

function Assert-CdpPortIsFree {
    $existing = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($existing.Count -gt 0) {
        throw "WebView2 CDP loopback port $port is already in use"
    }
    $probe = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse('127.0.0.1'), $port)
    $started = $false
    try {
        $probe.Start()
        $started = $true
    } catch {
        throw "WebView2 CDP loopback port $port cannot be reserved: $($_.Exception.Message)"
    } finally {
        if ($started) { $probe.Stop() }
    }
}

function Configure-CdpPolicy {
    if ($env:MODUTEX_TEST_CDP_PORT -ne [string]$port) {
        throw "Native E2E must use the fixed WebView2 CDP port $port"
    }
    if ([string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ID) -or
        [string]::IsNullOrWhiteSpace($env:GITHUB_RUN_ATTEMPT) -or
        [string]::IsNullOrWhiteSpace($env:GITHUB_JOB)) {
        throw 'GitHub run identity is unavailable for the isolated WebView2 profile'
    }
    $profilePath = Get-IsolatedUserDataPath
    if (Test-Path -LiteralPath $profilePath) {
        throw "The isolated WebView2 profile path already exists: $profilePath"
    }
    if ([string]::IsNullOrWhiteSpace($env:GITHUB_ENV) -or -not (Test-Path -LiteralPath $env:GITHUB_ENV -PathType Leaf)) {
        throw 'GitHub Actions environment file is unavailable for policy cleanup tracking'
    }
    Assert-PolicyScopeIsAvailable
    Assert-CdpPortIsFree

    $applicationProcesses = @(Get-CimInstance -ClassName Win32_Process -Filter "Name = '$appName'" -ErrorAction Stop)
    if ($applicationProcesses.Count -gt 0) {
        throw 'A ModuTeX native E2E process was already running before policy setup'
    }

    $createdArgumentsPolicy = $false
    $createdUserDataPolicy = $false
    try {
        New-Item -Path $policyRoot -Force -ErrorAction Stop | Out-Null
        New-Item -Path $argumentsPolicy -Force -ErrorAction Stop | Out-Null
        New-Item -Path $userDataPolicy -Force -ErrorAction Stop | Out-Null
        New-ItemProperty -LiteralPath $argumentsPolicy -Name $appName -Value $browserArguments -PropertyType String -ErrorAction Stop | Out-Null
        $createdArgumentsPolicy = $true
        New-ItemProperty -LiteralPath $userDataPolicy -Name $appName -Value $profilePath -PropertyType String -ErrorAction Stop | Out-Null
        $createdUserDataPolicy = $true

        $argumentsKey = Get-Item -LiteralPath $argumentsPolicy
        $userDataKey = Get-Item -LiteralPath $userDataPolicy
        if (-not [string]::Equals([string]$argumentsKey.GetValue($appName), $browserArguments, [System.StringComparison]::Ordinal) -or
            $argumentsKey.GetValueKind($appName) -ne [Microsoft.Win32.RegistryValueKind]::String) {
            throw 'Application-scoped WebView2 CDP arguments did not verify as REG_SZ'
        }
        if (-not [string]::Equals([string]$userDataKey.GetValue($appName), $profilePath, [System.StringComparison]::Ordinal) -or
            $userDataKey.GetValueKind($appName) -ne [Microsoft.Win32.RegistryValueKind]::String) {
            throw 'Application-scoped WebView2 user data folder did not verify as REG_SZ'
        }
        Add-Content -LiteralPath $env:GITHUB_ENV -Value 'MODUTEX_WEBVIEW2_CDP_POLICY_CONFIGURED=1' -Encoding utf8
    } catch {
        $configureFailure = $_
        $rollbackFailures = [System.Collections.Generic.List[string]]::new()
        if ($createdArgumentsPolicy) {
            try { Remove-ExactPolicyValue -Path $argumentsPolicy -Name $appName -ExpectedValue $browserArguments }
            catch { $rollbackFailures.Add($_.Exception.Message) }
        }
        if ($createdUserDataPolicy) {
            try { Remove-ExactPolicyValue -Path $userDataPolicy -Name $appName -ExpectedValue $profilePath }
            catch { $rollbackFailures.Add($_.Exception.Message) }
        }
        if ($rollbackFailures.Count -gt 0) {
            throw "WebView2 policy setup failed ($($configureFailure.Exception.Message)); rollback failed: $($rollbackFailures -join '; ')"
        }
        throw $configureFailure
    }
    Write-Host "Configured WebView2 CDP policy only for $appName on 127.0.0.1:$port"
    Write-Host "WebView2 controls in this lane share the isolated profile: $profilePath"
}

function Stop-ExactProcessTree([int]$ProcessId, [string]$ExpectedName, [string]$ExpectedExePath, [string]$ProfilePath) {
    $current = Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $current -or $current.Name -ne $ExpectedName) { return }
    if (-not [string]::IsNullOrEmpty($ExpectedExePath) -and
        -not [string]::Equals([string]$current.ExecutablePath, $ExpectedExePath, [System.StringComparison]::OrdinalIgnoreCase)) { return }
    if (-not [string]::IsNullOrEmpty($ProfilePath) -and
        ([string]::IsNullOrEmpty([string]$current.CommandLine) -or
            $current.CommandLine.IndexOf($ProfilePath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0)) { return }
    & taskkill.exe /PID ([string]$ProcessId) /T /F | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Warning "taskkill returned $LASTEXITCODE for owned process $ProcessId" }
}

function Stop-ProfileProcesses([string]$ProfilePath) {
    $workspace = [System.IO.Path]::GetFullPath($env:GITHUB_WORKSPACE)
    $expectedExe = [System.IO.Path]::GetFullPath((Join-Path $workspace 'apps\desktop-tauri\target\release\modutex-desktop-tauri.exe'))
    $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    $ownedHosts = @($processes | Where-Object {
        $_.Name -eq $appName -and [string]::Equals([string]$_.ExecutablePath, $expectedExe, [System.StringComparison]::OrdinalIgnoreCase)
    })
    foreach ($process in $ownedHosts) {
        Stop-ExactProcessTree -ProcessId ([int]$process.ProcessId) -ExpectedName $appName -ExpectedExePath $expectedExe -ProfilePath ''
    }

    $webViewProcesses = @($processes | Where-Object {
        $_.Name -eq 'msedgewebview2.exe' -and
        -not [string]::IsNullOrEmpty([string]$_.CommandLine) -and
        $_.CommandLine.IndexOf($ProfilePath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    foreach ($process in $webViewProcesses) {
        Stop-ExactProcessTree -ProcessId ([int]$process.ProcessId) -ExpectedName 'msedgewebview2.exe' -ExpectedExePath '' -ProfilePath $ProfilePath
    }

    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 200
        $remaining = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | Where-Object {
            ($_.Name -eq $appName -and [string]::Equals([string]$_.ExecutablePath, $expectedExe, [System.StringComparison]::OrdinalIgnoreCase)) -or
            ($_.Name -eq 'msedgewebview2.exe' -and -not [string]::IsNullOrEmpty([string]$_.CommandLine) -and
                $_.CommandLine.IndexOf($ProfilePath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0)
        })
    } while ($remaining.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)
    if ($remaining.Count -gt 0) {
        throw "Owned ModuTeX/WebView2 processes did not stop before cleanup: $($remaining.ProcessId -join ', ')"
    }
}

function Assert-CdpPortIsFreeAfterCleanup {
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) {
        throw "TCP port $port remains in use after stopping the owned WebView2 processes"
    }
}

if (-not (Test-GitHubHostedWindowsRunner)) {
    if ($Action -eq 'Cleanup') {
        Write-Host 'Skipping WebView2 policy cleanup outside a GitHub-hosted Windows runner'
        return
    }
    throw 'Temporary WebView2 registry policy is restricted to GitHub-hosted Windows runners'
}

$isolatedProfile = Get-IsolatedUserDataPath
if ($Action -eq 'Configure') {
    Configure-CdpPolicy
    return
}
if ($env:MODUTEX_WEBVIEW2_CDP_POLICY_CONFIGURED -ne '1') {
    Write-Host 'No WebView2 CDP policy values were created by this job; leaving existing runner settings untouched'
    return
}

$cleanupFailures = [System.Collections.Generic.List[string]]::new()
if ($env:MODUTEX_WEBVIEW2_CDP_POLICY_CONFIGURED -eq '1') {
    try { Stop-ProfileProcesses -ProfilePath $isolatedProfile }
    catch { $cleanupFailures.Add($_.Exception.Message) }
}
try { Remove-ExactPolicyValue -Path $argumentsPolicy -Name $appName -ExpectedValue $browserArguments }
catch { $cleanupFailures.Add($_.Exception.Message) }
try { Remove-ExactPolicyValue -Path $userDataPolicy -Name $appName -ExpectedValue $isolatedProfile }
catch { $cleanupFailures.Add($_.Exception.Message) }
if ($cleanupFailures.Count -gt 0) {
    throw "WebView2 CDP cleanup did not complete: $($cleanupFailures -join '; ')"
}

if ($env:MODUTEX_WEBVIEW2_CDP_POLICY_CONFIGURED -eq '1') {
    Assert-CdpPortIsFreeAfterCleanup
}
if ($env:MODUTEX_WEBVIEW2_CDP_POLICY_CONFIGURED -eq '1' -and (Test-Path -LiteralPath $isolatedProfile)) {
    $profileItem = Get-Item -LiteralPath $isolatedProfile -Force
    if (($profileItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'Refusing to recursively remove a reparse point at the isolated WebView2 profile path'
    }
    Remove-Item -LiteralPath $isolatedProfile -Recurse -Force -ErrorAction Stop
}
Write-Host "Removed only the temporary $appName WebView2 policy values and isolated profile"
