param(
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
    [string]$KeyFile,
    [switch]$Apply,
    [string[]]$Only
)

$ErrorActionPreference = 'Stop'
# One provisioning implementation owns request fields, backups and readback.
# Plan by default; -Apply performs writes. See docs/CHARACTER_API.md.
$entry = Join-Path ([IO.Path]::GetFullPath($ProjectDirectory)) 'scripts\Provision-Characters.mjs'
$arguments = @($entry)
if ($Apply) { $arguments += '--apply' }
if ($Only) { $arguments += @('--only', ($Only -join ',')) }
$previousKeyFile = $env:CYBERPUNK_CONVAI_KEY_FILE
try {
    if ($KeyFile) { $env:CYBERPUNK_CONVAI_KEY_FILE = [IO.Path]::GetFullPath($KeyFile) }
    & node @arguments
    if ($LASTEXITCODE -ne 0) { throw "Character provisioning failed (exit $LASTEXITCODE)." }
} finally {
    $env:CYBERPUNK_CONVAI_KEY_FILE = $previousKeyFile
}
