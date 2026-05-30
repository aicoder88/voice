#Requires -Version 5.1
<#
.SYNOPSIS
    Downloads whisper.cpp Windows binaries and a GGML quantized model for local
    transcription. Idempotent: re-running skips already-present files.

.DESCRIPTION
    Pulls a release from ggml-org/whisper.cpp and a model from HuggingFace.
    Extracts binaries to .\bin and the model to .\models, both relative to the
    repo root.

.PARAMETER Variant
    Which prebuilt to fetch. "cuda" requires NVIDIA driver supporting CUDA 12.x.
    "cpu" works on anything. Default: cuda.

.PARAMETER Model
    GGML model basename to download from HuggingFace. Default:
    ggml-small-q5_1.bin (multilingual, ~190 MB).

.PARAMETER WhisperVersion
    Release tag on ggml-org/whisper.cpp. Default: v1.8.4.
#>
[CmdletBinding()]
param(
    [ValidateSet("cuda", "cpu")]
    [string]$Variant = "cuda",
    [string]$Model = "ggml-small-q5_1.bin",
    [string]$WhisperVersion = "v1.8.4"
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$BinDir = Join-Path $RepoRoot "bin"
$ModelsDir = Join-Path $RepoRoot "models"

New-Item -ItemType Directory -Force -Path $BinDir, $ModelsDir | Out-Null

function Get-RemoteFile {
    param([string]$Url, [string]$Destination)
    if (Test-Path $Destination) {
        Write-Host "[setup] already have $(Split-Path -Leaf $Destination), skipping download"
        return
    }
    Write-Host "[setup] downloading $Url"
    Write-Host "[setup]   -> $Destination"
    & curl.exe -L --fail --progress-bar -o $Destination $Url
    if ($LASTEXITCODE -ne 0) { throw "curl failed for $Url" }
}

# 1. Whisper binaries
$asset = if ($Variant -eq "cuda") {
    "whisper-cublas-12.4.0-bin-x64.zip"
} else {
    "whisper-bin-x64.zip"
}
$binZip = Join-Path $env:TEMP $asset
$binUrl = "https://github.com/ggml-org/whisper.cpp/releases/download/$WhisperVersion/$asset"

Get-RemoteFile -Url $binUrl -Destination $binZip

$cliPath = Join-Path $BinDir "whisper-cli.exe"
if (-not (Test-Path $cliPath)) {
    Write-Host "[setup] extracting $asset -> $BinDir"
    Expand-Archive -Path $binZip -DestinationPath $BinDir -Force
    # The CUDA archive nests everything under a Release\ subdir; flatten it so
    # WHISPER_BIN resolves cleanly. The plain CPU archive is already flat — the
    # Test-Path guard makes this a no-op there.
    $nested = Join-Path $BinDir "Release"
    if (Test-Path $nested) {
        Move-Item (Join-Path $nested "*") $BinDir -Force
        Remove-Item $nested -Recurse -Force
    }
} else {
    Write-Host "[setup] bin/whisper-cli.exe already present, skipping extract"
}

# 2. Model weights
$modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$Model"
$modelPath = Join-Path $ModelsDir $Model
Get-RemoteFile -Url $modelUrl -Destination $modelPath

# 3. Sanity check
$exists = @(
    "whisper-cli.exe",
    "whisper-server.exe"
) | ForEach-Object {
    $p = Join-Path $BinDir $_
    [pscustomobject]@{ File = $_; Present = (Test-Path $p) }
}

Write-Host ""
Write-Host "[setup] done."
$exists | Format-Table -AutoSize
Write-Host "model:  $modelPath ($([math]::Round((Get-Item $modelPath).Length/1MB, 1)) MB)"
Write-Host ""
Write-Host "Next: ensure your .env has:"
Write-Host "  STT_PROVIDER=whisper-local"
Write-Host "  WHISPER_BIN=$cliPath"
Write-Host "  WHISPER_MODEL=$modelPath"
