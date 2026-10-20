# SPDX-License-Identifier: Apache-2.0
<#
.SYNOPSIS
Validate Windows trust, an exact publisher, required timestamp and PE metadata.
.EXAMPLE
pwsh -File scripts/distribution/verify-authenticode-signature.ps1 -FilePath ./ModuTeX.exe -ExpectedSubject '<full certificate subject>' -RequireTimestamp -CheckPeMetadata -ExpectedProductName ModuTeX -ExpectedProductVersion 0.2.1
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$FilePath,

  [Parameter(Mandatory = $false)]
  [string]$ExpectedSubject,

  [switch]$RequireTimestamp,

  [switch]$CheckPeMetadata,

  [Parameter(Mandatory = $false)]
  [string]$ExpectedProductName,

  [Parameter(Mandatory = $false)]
  [string]$ExpectedProductVersion
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $FilePath -PathType Leaf)) {
  Write-Error "File not found for signature verification: $FilePath"
  exit 1
}

if ([string]::IsNullOrWhiteSpace($ExpectedSubject)) {
  Write-Error "ExpectedSubject must be a non-empty publisher subject"
  exit 1
}

$sig = Get-AuthenticodeSignature -LiteralPath $FilePath
if ($sig.Status -ne 'Valid') {
  Write-Error "Authenticode signature status for $FilePath is $($sig.Status): $($sig.StatusMessage)"
  exit 1
}

Write-Host "Authenticode signature status: Valid"
Write-Host "Signer Subject: $($sig.SignerCertificate.Subject)"

 $actualSubject = $sig.SignerCertificate.Subject.Trim()
 $expected = $ExpectedSubject.Trim()
if (-not [string]::Equals($actualSubject, $expected, [System.StringComparison]::OrdinalIgnoreCase)) {
  Write-Error "Signer certificate subject mismatch on $FilePath.`nExpected: '$expected'`nActual:   '$actualSubject'"
  exit 1
}
Write-Host "Signer certificate subject verified: $actualSubject"

if ($RequireTimestamp) {
  if (-not $sig.TimeStamperCertificate) {
    Write-Error "TimeStamper certificate is missing on $FilePath"
    exit 1
  }
  Write-Host "Timestamp certificate verified: $($sig.TimeStamperCertificate.Subject)"
}

if ($CheckPeMetadata) {
  if ([string]::IsNullOrWhiteSpace($ExpectedProductName)) {
    Write-Error "ExpectedProductName is required when PE metadata checking is enabled"
    exit 1
  }
  if ([string]::IsNullOrWhiteSpace($ExpectedProductVersion)) {
    Write-Error "ExpectedProductVersion is required when PE metadata checking is enabled"
    exit 1
  }

  $item = Get-Item -LiteralPath $FilePath
  $v = $item.VersionInfo
  $actualProductName = ([string]$v.ProductName).Trim()
  $expectedProductName = $ExpectedProductName.Trim()
  if (-not [string]::Equals($actualProductName, $expectedProductName, [System.StringComparison]::Ordinal)) {
    Write-Error "PE ProductName mismatch on ${FilePath}: got '$actualProductName', expected '$expectedProductName'"
    exit 1
  }

  $peProductVer = ([string]$v.ProductVersion).Trim()
  $expectedProductVersion = $ExpectedProductVersion.Trim()
  try {
    $peVersion = [System.Version]::Parse($peProductVer)
    $expectedVersion = [System.Version]::Parse($expectedProductVersion)
  } catch {
    Write-Error "PE ProductVersion mismatch on ${FilePath}: got '$peProductVer', expected '$expectedProductVersion'"
    exit 1
  }

  $peResourceNumericVersion = @(
    $peVersion.Major
    $peVersion.Minor
    [Math]::Max(0, $peVersion.Build)
    [Math]::Max(0, $peVersion.Revision)
  ) -join '.'
  $expectedNumericVersion = @(
    $expectedVersion.Major
    $expectedVersion.Minor
    [Math]::Max(0, $expectedVersion.Build)
    [Math]::Max(0, $expectedVersion.Revision)
  ) -join '.'
  $peFixedNumericVersion = @(
    $v.ProductMajorPart
    $v.ProductMinorPart
    $v.ProductBuildPart
    $v.ProductPrivatePart
  ) -join '.'
  if ($peResourceNumericVersion -ne $expectedNumericVersion -or $peFixedNumericVersion -ne $expectedNumericVersion) {
    Write-Error "PE ProductVersion mismatch on ${FilePath}: got '$peProductVer' (numeric '$peFixedNumericVersion'), expected '$expectedProductVersion'"
    exit 1
  }
  Write-Host "PE metadata verified: ProductName=$($v.ProductName), ProductVersion=$($v.ProductVersion)"
}

exit 0
