param([string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$vendorDirectory = Join-Path ([IO.Path]::GetFullPath($ProjectDirectory)) 'vendor'
$archivePath = Join-Path $vendorDirectory 'Rhubarb-Lip-Sync-1.14.0-Windows.zip'
$destination = Join-Path $vendorDirectory 'rhubarb-1.14.0'
$executable = Join-Path $destination 'Rhubarb-Lip-Sync-1.14.0-Windows\rhubarb.exe'
[IO.Directory]::CreateDirectory($vendorDirectory) | Out-Null
if (-not (Test-Path -LiteralPath $archivePath)) {
    Invoke-WebRequest -Uri 'https://github.com/DanielSWolf/rhubarb-lip-sync/releases/download/v1.14.0/Rhubarb-Lip-Sync-1.14.0-Windows.zip' -OutFile $archivePath
}
# Hash of the official release archive downloaded and verified locally on
# September 29, 2026; this is a project pin, not a signed upstream digest.
$expected = '62FA416A8D5E382A3828EE4BEF358CE520D0B4CABDEAEA75A7AC266D098D1FE3'
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $expected) {
    throw 'The Rhubarb archive does not match the pinned release. Kept it for inspection.'
}
if (-not (Test-Path -LiteralPath $executable)) {
    Expand-Archive -LiteralPath $archivePath -DestinationPath $destination
}
if (-not (Test-Path -LiteralPath (Join-Path (Split-Path -Parent $executable) 'LICENSE.md'))) {
    throw 'The analyser license and dependency notices must accompany the executable.'
}
& $executable --version
if ($LASTEXITCODE -ne 0) { throw 'Rhubarb did not start.' }
