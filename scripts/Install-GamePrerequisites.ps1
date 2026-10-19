param(
    [string]$GameDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077',
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$game = [IO.Path]::GetFullPath($GameDirectory).TrimEnd('\')
$project = [IO.Path]::GetFullPath($ProjectDirectory).TrimEnd('\')
$exe = Join-Path $game 'bin\x64\Cyberpunk2077.exe'
if (-not [IO.File]::Exists($exe)) { throw "Cyberpunk2077.exe not found at $exe" }
if ((Get-Process Cyberpunk2077 -ErrorAction SilentlyContinue)) { throw 'Close Cyberpunk 2077 before installing prerequisites.' }

$packages = @(
    @{ Name = 'RED4ext 1.30.0'; Path = (Join-Path $project 'vendor\downloads\red4ext-1.30.0.zip') },
    @{ Name = 'redscript 0.5.31'; Path = (Join-Path $project 'vendor\downloads\redscript-v0.5.31-windows.zip') },
    @{ Name = 'Codeware 1.20.5'; Path = (Join-Path $project 'vendor\downloads\Codeware-1.20.5.zip') },
    @{ Name = 'CET 1.37.1'; Path = (Join-Path $project 'ref mods\CET 1.37.1 - Scripting fixes-107-1-37-1-1759193708.zip') },
    @{ Name = 'Native Settings UI 1.96'; Path = (Join-Path $project 'ref mods\Native Settings UI 1.96-3518-1-96-1704576025.zip') }
)
foreach ($package in $packages) {
    if (-not [IO.File]::Exists($package.Path)) { throw "Missing $($package.Name): $($package.Path)" }
}

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupRoot = Join-Path $project "backups\game-setup-$stamp"
$manifest = [ordered]@{
    game = $game
    created = (Get-Date).ToString('o')
    files = @()
}
$planned = @{}
$gamePrefix = $game + '\'

foreach ($package in $packages) {
    $zip = [IO.Compression.ZipFile]::OpenRead($package.Path)
    try {
        foreach ($entry in $zip.Entries) {
            if ($entry.FullName.EndsWith('/')) { continue }
            $relative = $entry.FullName.Replace('/', '\')
            if ($relative -match '(^|\\)\.\.(\\|$)' -or $relative.StartsWith('\')) { throw "Unsafe archive path: $relative" }
            $target = [IO.Path]::GetFullPath((Join-Path $game $relative))
            if (-not $target.StartsWith($gamePrefix, [StringComparison]::OrdinalIgnoreCase)) { throw "Archive path escapes game: $relative" }
            if ($planned.ContainsKey($target)) { throw "Multiple packages write $relative" }
            $planned[$target] = $true

            # Preserve personal settings even when the packaged default differs.
            if ($relative -ieq 'bin\x64\global.ini' -and [IO.File]::Exists($target)) { continue }

            $source = $entry.Open()
            try {
                $buffer = [IO.MemoryStream]::new()
                $source.CopyTo($buffer)
                $bytes = $buffer.ToArray()
            } finally {
                $source.Dispose()
            }
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '') }
            finally { $sha.Dispose() }
            $previousHash = $null
            if ([IO.File]::Exists($target)) {
                $previousHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
                if ($previousHash -eq $hash) { continue }
                $backup = Join-Path $backupRoot $relative
                [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($backup)) | Out-Null
                [IO.File]::Copy($target, $backup, $false)
            }
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
            [IO.File]::WriteAllBytes($target, $bytes)
            $installedHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash
            if ($installedHash -ne $hash) { throw "Verification failed for $relative" }
            $manifest.files += [ordered]@{
                path = $relative
                source = $package.Name
                previousSha256 = $previousHash
                installedSha256 = $hash
            }
        }
    } finally {
        $zip.Dispose()
    }
}

[IO.Directory]::CreateDirectory($backupRoot) | Out-Null
$manifestPath = Join-Path $backupRoot 'manifest.json'
$manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding utf8
Write-Output "Installed and verified $($manifest.files.Count) files. Rollback manifest: $manifestPath"
