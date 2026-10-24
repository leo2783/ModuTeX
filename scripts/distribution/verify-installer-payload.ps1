[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedBundledExeSha256,

  [Parameter(Mandatory = $false)]
  [string]$ExpectedProductName,

  [Parameter(Mandatory = $false)]
  [string]$ExpectedProductVersion,

  [Parameter(Mandatory = $false)]
  [string]$ExpectedTectonicSha256,

  [Parameter(Mandatory = $false)]
  [string]$OurSignerSubject,

  [Parameter(Mandatory = $false)]
  [string]$ReceiptPath,

  [Parameter(Mandatory = $false)]
  [string]$ExpectedExecutableName = 'modutex-desktop-tauri.exe'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $InstallerPath -PathType Leaf)) {
  Write-Error "Installer path not found: $InstallerPath"
  exit 1
}

if ($ExpectedExecutableName) {
  if ($ExpectedExecutableName -notmatch '^[a-zA-Z0-9._-]+\.exe$') {
    Write-Error "Invalid ExpectedExecutableName: '$ExpectedExecutableName'. Must be a strict basename ending with .exe without directory separators or wildcards."
    exit 1
  }
} else {
  $ExpectedExecutableName = 'modutex-desktop-tauri.exe'
}

$existingOwnReceipt = $null
if ($ReceiptPath) {
  if ($ReceiptPath -notmatch '(?i)\.json$') {
    Write-Error "ReceiptPath must have .json extension: $ReceiptPath"
    exit 1
  }

  $canonicalReceipt = [System.IO.Path]::GetFullPath($ReceiptPath)
  if (Test-Path -LiteralPath $canonicalReceipt -PathType Container) {
    Write-Error "ReceiptPath cannot be a directory: $ReceiptPath"
    exit 1
  }

  $canonicalCwd = [System.IO.Path]::GetFullPath((Get-Location).Path).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
  if (-not $canonicalReceipt.StartsWith($canonicalCwd, [System.StringComparison]::OrdinalIgnoreCase)) {
    Write-Error "ReceiptPath must be contained within current working directory: $ReceiptPath"
    exit 1
  }

  $canonicalInstaller = [System.IO.Path]::GetFullPath($InstallerPath)
  if ($canonicalReceipt -eq $canonicalInstaller) {
    Write-Error "ReceiptPath collides with InstallerPath: $ReceiptPath"
    exit 1
  }

  $receiptLeaf = [System.IO.Path]::GetFileName($canonicalReceipt)
  $protectedFiles = @('package.json', 'package-lock.json', 'Cargo.toml', 'Cargo.lock', 'tauri.conf.json', 'tauri.offline.conf.json')
  if ($protectedFiles -contains $receiptLeaf) {
    Write-Error "ReceiptPath cannot target protected project file: $receiptLeaf"
    exit 1
  }

  $checkDir = [System.IO.Path]::GetDirectoryName($canonicalReceipt)
  while ($checkDir -and (Test-Path -LiteralPath $checkDir)) {
    $item = Get-Item -LiteralPath $checkDir -Force
    if ($item.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)) {
      Write-Error "ReceiptPath directory contains reparse point: $checkDir"
      exit 1
    }
    $parent = Split-Path -Parent $checkDir
    if ($parent -eq $checkDir) { break }
    $checkDir = $parent
  }

  if (Test-Path -LiteralPath $canonicalReceipt -PathType Leaf) {
    $existingItem = Get-Item -LiteralPath $canonicalReceipt -Force
    if ($existingItem.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)) {
      Write-Error "ReceiptPath is an unexpected reparse point: $ReceiptPath"
      exit 1
    }
    $isOwnReceipt = $false
    try {
      $parsed = Get-Content -LiteralPath $canonicalReceipt -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
      if ($parsed.bundledExeSha256 -and $parsed.installerPath) {
        $isOwnReceipt = $true
      }
    } catch {}
    if (-not $isOwnReceipt) {
      Write-Error "ReceiptPath points to an existing file that is not a ModuTeX payload receipt: $ReceiptPath"
      exit 1
    }
    $existingOwnReceipt = $canonicalReceipt
  }
}

$sevenZip = Get-Command 7z -ErrorAction SilentlyContinue
if (-not $sevenZip) {
  Write-Error '7z command is required for NSIS payload extraction but was not found'
  exit 1
}

$tempExtract = Join-Path $env:TEMP ('nsis-payload-' + [guid]::NewGuid().ToString('n'))
New-Item -ItemType Directory -Force -Path $tempExtract | Out-Null

$receiptData = $null
$verificationSucceeded = $false
try {
  & 7z x -y -o"$tempExtract" $InstallerPath | Out-Null
  if ($LASTEXITCODE -ne 0) {
    throw "7z extraction failed for $InstallerPath with exit code $LASTEXITCODE"
  }

  $extractRoot = Get-Item -LiteralPath $tempExtract -Force
  if ($extractRoot.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)) {
    throw "Extraction root directory is an unexpected reparse point: $tempExtract"
  }
  $reparseInside = @(Get-ChildItem -LiteralPath $tempExtract -Recurse -Force | Where-Object { $_.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint) })
  if ($reparseInside.Count -gt 0) {
    throw "Reparse point detected in extracted payload: $($reparseInside[0].FullName)"
  }

  $matchingExes = @(Get-ChildItem -LiteralPath $tempExtract -Filter $ExpectedExecutableName -Recurse | Where-Object { -not $_.PSIsContainer })
  if ($matchingExes.Count -ne 1) {
    throw "Expected exactly one $ExpectedExecutableName in payload, found $($matchingExes.Count)"
  }
  $extractedExe = $matchingExes[0].FullName
  $extractedHash = (Get-FileHash -LiteralPath $extractedExe -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($extractedHash -ne $ExpectedBundledExeSha256.ToLowerInvariant()) {
    throw "Extracted EXE hash ($extractedHash) does not match expected bundled EXE hash ($ExpectedBundledExeSha256)"
  }

  $ver = (Get-Item -LiteralPath $extractedExe).VersionInfo
  if ($ExpectedProductName -and ($ver.ProductName -ne $ExpectedProductName)) {
    throw "Extracted EXE ProductName mismatch: got '$($ver.ProductName)', expected '$ExpectedProductName'"
  }
  if ($ExpectedProductVersion) {
    $prodVer = $ver.ProductVersion.Trim()
    if ($prodVer -ne $ExpectedProductVersion -and $prodVer -ne "$ExpectedProductVersion.0") {
      throw "Extracted EXE ProductVersion mismatch: got '$prodVer', expected '$ExpectedProductVersion'"
    }
  }

  $tectonicRel = 'vendor/tectonic/windows-x64/tectonic.exe'
  $tectonicFull = Join-Path $tempExtract $tectonicRel
  if (-not (Test-Path -LiteralPath $tectonicFull -PathType Leaf)) {
    throw "Bundled third-party binary missing from payload: $tectonicRel"
  }
  if ($ExpectedTectonicSha256) {
    $actualTectonicHash = (Get-FileHash -LiteralPath $tectonicFull -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualTectonicHash -ne $ExpectedTectonicSha256.ToLowerInvariant()) {
      throw "Bundled Tectonic hash ($actualTectonicHash) does not match expected upstream hash ($ExpectedTectonicSha256)"
    }
  }
  if ($OurSignerSubject) {
    $tectonicSig = Get-AuthenticodeSignature -LiteralPath $tectonicFull
    if ($tectonicSig.Status -eq 'Valid' -and $tectonicSig.SignerCertificate.Subject -eq $OurSignerSubject) {
      throw "Bundled third-party Tectonic was improperly signed using ModuTeX key ($OurSignerSubject)"
    }
  }

  $requiredFiles = @(
    'vendor/tectonic/windows-x64/tectonic.exe',
    'vendor/tectonic/VERSION',
    'vendor/notices/TECTONIC-LICENSE.txt',
    'vendor/notices/TECTONIC-NOTICE.md',
    'LICENSE',
    'NOTICE',
    'apps/frontend/LICENSE',
    'apps/frontend/NOTICE',
    'apps/frontend/THIRD_PARTY_NOTICES.md',
    'packages/frontend-contracts/LICENSE'
  )
  foreach ($rel in $requiredFiles) {
    $full = Join-Path $tempExtract $rel
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) {
      throw "Required payload file missing: $rel"
    }
    if ((Get-Item -LiteralPath $full).Length -le 0) {
      throw "Required payload file is empty: $rel"
    }
  }

  if ($ReceiptPath) {
    $canonicalExtract = [System.IO.Path]::GetFullPath($tempExtract).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $allPayloadItems = @(Get-ChildItem -LiteralPath $tempExtract -Recurse -File)
    $filesList = [System.Collections.Generic.List[PSObject]]::new()
    $seenPaths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $thirdPartySigs = [System.Collections.Generic.List[PSObject]]::new()

    foreach ($item in $allPayloadItems) {
      $itemFull = [System.IO.Path]::GetFullPath($item.FullName)
      if (-not $itemFull.StartsWith($canonicalExtract, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Payload file path traversal detected: $itemFull outside $canonicalExtract"
      }
      if ($item.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)) {
        throw "Unexpected reparse point file in payload: $itemFull"
      }

      $relPath = [System.IO.Path]::GetRelativePath($tempExtract, $item.FullName).Replace('\', '/')
      if (-not $seenPaths.Add($relPath)) {
        throw "Duplicate payload file path detected: $relPath"
      }

      $itemSha = (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
      $role = if ($item.Name -eq $ExpectedExecutableName) {
        'main-executable'
      } elseif ($relPath -match '^vendor/tectonic/windows-x64/.*\.exe$') {
        'bundled-tectonic-executable'
      } elseif ($relPath -match '^vendor/tectonic/') {
        'bundled-tectonic-asset'
      } elseif ($item.Name -match '(?i)uninstall\.exe') {
        'other-executable'
      } elseif ($relPath -match '(?i)webview2|microsoftedge') {
        'bundled-webview2-installer'
      } elseif ($relPath -match 'LICENSE|NOTICE') {
        'license-notice'
      } elseif ($item.Extension -eq '.exe') {
        'other-executable'
      } else {
        'payload-asset'
      }

      $filesList.Add([ordered]@{
        path = $relPath
        sha256 = $itemSha
        sizeBytes = $item.Length
        role = $role
      })

      if ($item.Extension -eq '.exe' -and $item.Name -ne $ExpectedExecutableName) {
        $sig = Get-AuthenticodeSignature -LiteralPath $item.FullName
        $statusStr = $sig.Status.ToString()
        $subjStr = if ($sig.SignerCertificate) { $sig.SignerCertificate.Subject } else { 'none' }
        if ($OurSignerSubject -and $statusStr -eq 'Valid' -and $subjStr -eq $OurSignerSubject) {
          throw "Third-party executable $relPath was signed with our certificate: $OurSignerSubject"
        }

        if ($relPath -match '(?i)webview2|microsoftedge' -and $item.Extension -eq '.exe') {
          if ($statusStr -ne 'Valid') {
            throw "Bundled WebView2 executable $relPath does not have Valid Authenticode status: $statusStr"
          }
          if ($subjStr -notmatch 'Microsoft') {
            throw "Bundled WebView2 executable $relPath is not signed by Microsoft: $subjStr"
          }
          if (-not $sig.TimeStamperCertificate) {
            throw "Bundled WebView2 executable $relPath is missing a valid timestamp signature"
          }
        }

        $sigObj = [ordered]@{
          path = $relPath
          status = $statusStr
          subject = $subjStr
        }
        if ($sig.TimeStamperCertificate) {
          $sigObj['timestampSigner'] = $sig.TimeStamperCertificate.Subject
        }
        $thirdPartySigs.Add($sigObj)
      }
    }

    $installerFull = (Resolve-Path -LiteralPath $InstallerPath).Path
    $curDir = (Get-Location).Path
    $installerRel = try {
      [System.IO.Path]::GetRelativePath($curDir, $installerFull).Replace('\', '/')
    } catch {
      $installerFull.Replace('\', '/')
    }
    $installerSha = (Get-FileHash -LiteralPath $InstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()

    $receiptData = [ordered]@{
      installerPath = $installerRel
      installerSha256 = $installerSha
      bundledExeSha256 = $extractedHash
      files = $filesList
      thirdPartySignatures = $thirdPartySigs
    }
  }
  $verificationSucceeded = $true
  Write-Host "NSIS installer payload verified successfully: $InstallerPath"
}
catch {
  Write-Error $_.Exception.Message
  if ($existingOwnReceipt -and (Test-Path -LiteralPath $existingOwnReceipt)) {
    Remove-Item -LiteralPath $existingOwnReceipt -Force
  }
  exit 1
}
finally {
  if (Test-Path -LiteralPath $tempExtract) {
    $canonicalTemp = [System.IO.Path]::GetFullPath($env:TEMP).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $canonicalExtract = [System.IO.Path]::GetFullPath($tempExtract)
    if (-not $canonicalExtract.StartsWith($canonicalTemp, [System.StringComparison]::OrdinalIgnoreCase)) {
      Write-Error "Extraction directory $canonicalExtract is not contained under TEMP $canonicalTemp"
      exit 1
    }
    $extractItem = Get-Item -LiteralPath $canonicalExtract -Force
    if ($extractItem.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)) {
      Write-Error "Extraction directory $canonicalExtract is an unexpected reparse point"
      exit 1
    }
    $reparseInside = @(Get-ChildItem -LiteralPath $canonicalExtract -Recurse -Force | Where-Object { $_.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint) })
    if ($reparseInside.Count -gt 0) {
      Write-Error "Unexpected reparse point found in extraction directory $canonicalExtract"
      exit 1
    }
    Remove-Item -LiteralPath $canonicalExtract -Recurse -Force
  }
}

if ($verificationSucceeded -and $ReceiptPath -and $receiptData) {
  $canonicalReceipt = [System.IO.Path]::GetFullPath($ReceiptPath)
  $receiptDir = [System.IO.Path]::GetDirectoryName($canonicalReceipt)
  if ($receiptDir -and -not (Test-Path -LiteralPath $receiptDir)) {
    New-Item -ItemType Directory -Force -Path $receiptDir | Out-Null
  }
  $tempReceipt = $canonicalReceipt + '.' + [guid]::NewGuid().ToString('n') + '.tmp'
  try {
    $jsonContent = $receiptData | ConvertTo-Json -Depth 6
    Set-Content -LiteralPath $tempReceipt -Value $jsonContent -Encoding utf8
    Move-Item -LiteralPath $tempReceipt -Destination $canonicalReceipt -Force
    Write-Host "Wrote payload verification receipt: $ReceiptPath"
  }
  catch {
    if (Test-Path -LiteralPath $tempReceipt) { Remove-Item -LiteralPath $tempReceipt -Force }
    Write-Error "Failed to write payload verification receipt: $($_.Exception.Message)"
    exit 1
  }
}

exit 0
