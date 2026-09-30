param(
    [string]$GameDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077',
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
    [switch]$LuaOnly
)

$ErrorActionPreference = 'Stop'
$game = [IO.Path]::GetFullPath($GameDirectory).TrimEnd('\')
$project = [IO.Path]::GetFullPath($ProjectDirectory).TrimEnd('\')
if (-not [IO.File]::Exists((Join-Path $game 'bin\x64\Cyberpunk2077.exe'))) { throw 'Game directory is invalid.' }
if (-not $LuaOnly -and (Get-Process Cyberpunk2077 -ErrorAction SilentlyContinue)) { throw 'Close the game before installing native scripts, or use -LuaOnly for a CET reload.' }

Import-Module (Join-Path $PSScriptRoot 'DevelopmentFiles.psm1') -Force
$manifest = Get-DevelopmentManifest $project
$targets = @(Get-DevelopmentFiles -ProjectDirectory $project -GameDirectory $game -LuaOnly:$LuaOnly)
foreach ($item in $targets) {
    if (-not [IO.File]::Exists($item.From)) { throw "Missing source: $($item.From)" }
}
$backupRoot = Join-Path $project ('backups\development-install-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N'))
$receipt = [ordered]@{ version = 1; game = $game; luaOnly = [bool]$LuaOnly; complete = $false; files = @(); quarantined = @() }
[IO.Directory]::CreateDirectory($backupRoot) | Out-Null
$receiptPath = Join-Path $backupRoot 'manifest.json'
function Save-InstallReceipt { $receipt | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $receiptPath -Encoding utf8 }
Save-InstallReceipt
if (-not $LuaOnly) {
    foreach ($relative in $manifest.retiredNative) {
        $retired = Resolve-DevelopmentPath $game $relative
        if ([IO.File]::Exists($retired)) {
            $saved = Resolve-DevelopmentPath $backupRoot $relative
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($saved)) | Out-Null
            $receipt.quarantined += @{ path = $relative; sha256 = (Get-FileHash -LiteralPath $retired -Algorithm SHA256).Hash }
            Save-InstallReceipt
            Move-Item -LiteralPath $retired -Destination $saved
        }
    }
}
foreach ($item in $targets) {
    $previous = $null
    if ([IO.File]::Exists($item.To)) {
        $previous = (Get-FileHash -LiteralPath $item.To -Algorithm SHA256).Hash
        $saved = Resolve-DevelopmentPath $backupRoot $item.Relative
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($saved)) | Out-Null
        [IO.File]::Copy($item.To, $saved, $false)
    }
    $expected = (Get-FileHash -LiteralPath $item.From -Algorithm SHA256).Hash
    $receipt.files += @{ path = $item.Relative; previousSha256 = $previous; installedSha256 = $expected }
    Save-InstallReceipt
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.To)) | Out-Null
    $temporary = $item.To + '.convai-install-' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::Copy($item.From, $temporary, $false)
        if ((Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash -ne $expected) { throw "Staged copy verification failed: $($item.To)" }
        Move-Item -LiteralPath $temporary -Destination $item.To -Force
        if ((Get-FileHash -LiteralPath $item.To -Algorithm SHA256).Hash -ne $expected) { throw "Copy verification failed: $($item.To)" }
    } finally {
        if ([IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary }
    }
}
[IO.Directory]::CreateDirectory((Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\runtime')) | Out-Null
$receipt.complete = $true
Save-InstallReceipt
if ($LuaOnly) { Write-Output 'Lua adapter and catalogs installed and hash verified. Native files were not changed or validated. Use CET Reload All Mods to activate.' }
else { Write-Output 'Development adapter installed and hash verified; retired native component quarantined if present.' }
Write-Output "Rollback receipt: $receiptPath"
