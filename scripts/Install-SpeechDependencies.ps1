param(
    [string]$GameDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077',
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot)
)
$ErrorActionPreference = 'Stop'
if (Get-Process Cyberpunk2077 -ErrorAction SilentlyContinue) { throw 'Close Cyberpunk before installing native speech dependencies.' }
$gameRoot = [IO.Path]::GetFullPath($GameDirectory).TrimEnd('\')
$projectRoot = [IO.Path]::GetFullPath($ProjectDirectory).TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $gameRoot 'bin\x64\Cyberpunk2077.exe'))) { throw 'Invalid game directory.' }
$backup = Join-Path $projectRoot ('backups\speech-dependencies-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
# Only official release files, staged and compiled before this installer runs.
foreach ($package in @('audioware-package', 'tweakxl-package')) {
    $stage = Join-Path $projectRoot ('vendor\' + $package)
    if (-not (Test-Path -LiteralPath $stage -PathType Container)) { throw "Missing staged package: $package" }
    foreach ($file in (Get-ChildItem -LiteralPath $stage -Recurse -File)) {
        $relative = [IO.Path]::GetRelativePath($stage, $file.FullName)
        $target = [IO.Path]::GetFullPath((Join-Path $gameRoot $relative))
        if (-not $target.StartsWith($gameRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Package path escaped the game directory.' }
        if (Test-Path -LiteralPath $target -PathType Leaf) {
            $saved = Join-Path $backup $relative
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($saved)) | Out-Null
            Copy-Item -LiteralPath $target -Destination $saved
        }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $target -Force
        if ((Get-FileHash -LiteralPath $target).Hash -ne (Get-FileHash -LiteralPath $file.FullName).Hash) { throw "Hash mismatch: $relative" }
    }
}
& node (Join-Path $projectRoot 'scripts\Prepare-SpeechAudio.mjs') $gameRoot
if ($LASTEXITCODE -ne 0) { throw 'Speech audio bank preparation failed.' }
Write-Output 'Audioware 1.9.9 and TweakXL 1.11.4 installed with verified copies; prior files backed up.'
