# SPDX-License-Identifier: Apache-2.0
param(
    [Parameter(Mandatory)][ValidatePattern('^\d+$')][string]$RunId,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$ArtifactName,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$Destination
)

$ErrorActionPreference = 'Stop'
$destinationPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Destination)
$temporaryRoot = [IO.Path]::GetFullPath($env:RUNNER_TEMP)
$delays = @(5, 15, 30)
for ($attempt = 0; $attempt -le $delays.Count; $attempt++) {
    # Each attempt extracts into a new directory so partial downloads cannot be reused.
    $staging = Join-Path $temporaryRoot ('modutex-artifact-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $staging -ErrorAction Stop | Out-Null
    try {
        $output = (& gh run download $RunId --name $ArtifactName --dir $staging 2>&1 | Out-String)
        $downloadExitCode = $LASTEXITCODE
        if ($downloadExitCode -eq 0) {
            New-Item -ItemType Directory -Path $destinationPath -Force -ErrorAction Stop | Out-Null
            Get-ChildItem -LiteralPath $staging -Force |
                Copy-Item -Destination $destinationPath -Recurse -Force -ErrorAction Stop
            Write-Host "Downloaded artifact from run $RunId on attempt $($attempt + 1)"
            return
        }
        $transient = [regex]::Match($output, '\bHTTP\s+(429|500|502|503|504)\b')
        if (-not $transient.Success -or $attempt -eq $delays.Count) {
            # gh errors can contain signed storage URLs. Report only the status and exit code.
            throw "Artifact download failed for run $RunId after $($attempt + 1) attempt(s), exit $downloadExitCode, HTTP $($transient.Groups[1].Value)"
        }
        Write-Warning "Artifact transport returned HTTP $($transient.Groups[1].Value), retrying in $($delays[$attempt]) seconds"
    } finally {
        $resolvedStaging = [IO.Path]::GetFullPath($staging)
        if ([IO.Path]::GetDirectoryName($resolvedStaging) -ne $temporaryRoot -or
            -not [IO.Path]::GetFileName($resolvedStaging).StartsWith('modutex-artifact-')) {
            throw 'Artifact staging cleanup escaped the temporary root'
        }
        Remove-Item -LiteralPath $resolvedStaging -Recurse -Force -ErrorAction Stop
    }
    Start-Sleep -Seconds $delays[$attempt]
}
