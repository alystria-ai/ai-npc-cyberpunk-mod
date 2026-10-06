param(
    [string]$GameDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077',
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
    [string]$WorkRoot = 'E:\CyberpunkConvai-offload\work\gesture-assets',
    [string]$CatalogPath,
    [string]$WolvenKitPath,
    [string]$DotNetRoot
)
# Builds convai_gestures.archive (device entity + multi-rig gesture workspot)
# and regenerates mod/gesture-catalog.lua (or -CatalogPath). See docs/COMPANION_GESTURES.md.
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath($ProjectDirectory)
if (-not $CatalogPath) { $CatalogPath = Join-Path $project 'mod\gesture-catalog.lua' }
if (-not $WolvenKitPath) { $WolvenKitPath = Join-Path $project 'vendor\wolvenkit-console-9.0.1\WolvenKit.CLI.exe' }
if (-not $DotNetRoot) { $DotNetRoot = Join-Path $project 'vendor\dotnet-runtime-10.0.12' }
if (-not (Test-Path -LiteralPath $WolvenKitPath)) { throw 'WolvenKit CLI is missing.' }
if (-not (Test-Path -LiteralPath (Join-Path $DotNetRoot 'dotnet.exe'))) { throw 'Local .NET runtime is missing.' }
$source = Get-Content -LiteralPath (Join-Path $project 'assets\gestures\gestures.json') -Raw | ConvertFrom-Json
# Fresh inputs every build: a patched game archive must never reuse old extracts.
$work = Join-Path $WorkRoot ('build-' + [guid]::NewGuid().ToString('N'))
$pack = Join-Path $work 'archive\convai_gestures'
$resources = Join-Path $pack 'cyberpunk_convai\gestures'
foreach ($folder in @('original', 'json', 'generated', 'roundtrip', 'package')) {
    [IO.Directory]::CreateDirectory((Join-Path $work $folder)) | Out-Null
}
[IO.Directory]::CreateDirectory($resources) | Out-Null
$previousDotNetRoot = $env:DOTNET_ROOT
function Invoke-GestureTool([string]$LogName, [string[]]$Arguments) {
    $log = Join-Path $work $LogName
    & $WolvenKitPath @Arguments *> $log
    if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath $log -Tail 20; throw "WolvenKit failed: $LogName" }
    if (Select-String -LiteralPath $log -Pattern '\[\s*\d+: Error') { Get-Content -LiteralPath $log -Tail 20; throw "WolvenKit reported an error: $LogName" }
}
function Escape([string]$Depot) { [regex]::Escape($Depot) }
Push-Location $project
try {
    $env:DOTNET_ROOT = $DotNetRoot
    $content = Join-Path $GameDirectory 'archive\pc\content'
    $ep1 = Join-Path $GameDirectory 'archive\pc\ep1'
    # Archive listing for existence checks (paths only).
    $listing = Join-Path $work 'listing.txt'
    $archives = @((Join-Path $content 'basegame_4_animation.archive'), (Join-Path $content 'memoryresident_1_general.archive'),
        (Join-Path $content 'basegame_1_engine.archive'), (Join-Path $content 'basegame_4_appearance.archive'),
        (Join-Path $content 'basegame_4_gamedata.archive'), (Join-Path $content 'basegame_3_nightcity.archive'))
    if (Test-Path -LiteralPath (Join-Path $ep1 'ep1_1_nightcity.archive')) { $archives += Join-Path $ep1 'ep1_1_nightcity.archive' }
    $paths = foreach ($archive in $archives) { & $WolvenKitPath archive $archive --list -v Quiet 2>$null }
    $paths | Set-Content -LiteralPath $listing -Encoding utf8
    # Gesture animsets (clip sources), the template workspot and entity shapes.
    $animsets = @($source.families.PSObject.Properties | ForEach-Object { $_.Value.animsets.PSObject.Properties | ForEach-Object { $_.Value } } |
        Where-Object { $_ -notmatch '_transitions\.anims$' } | Sort-Object -Unique)
    $animRegex = '^(' + (($animsets | ForEach-Object { Escape $_ }) -join '|') + ')$'
    Invoke-GestureTool 'extract-animsets.log' @('unbundle', (Join-Path $content 'basegame_4_animation.archive'), '--outpath', (Join-Path $work 'original'), '--regex', $animRegex)
    # The EP1 copy of a workspot overrides the base one when Phantom Liberty is installed.
    $templateArchive = if (Test-Path -LiteralPath (Join-Path $ep1 'ep1_1_nightcity.archive')) { Join-Path $ep1 'ep1_1_nightcity.archive' } else { Join-Path $content 'memoryresident_1_general.archive' }
    Invoke-GestureTool 'extract-template.log' @('unbundle', $templateArchive, '--outpath', (Join-Path $work 'original'), '--regex', ('^' + (Escape $source.template) + '$'))
    Invoke-GestureTool 'extract-trunk.log' @('unbundle', (Join-Path $content 'basegame_4_appearance.archive'), '--outpath', (Join-Path $work 'original'), '--regex', 'vehicle_trunk_disposal_workspots\.ent$')
    Invoke-GestureTool 'extract-dummy.log' @('unbundle', (Join-Path $content 'basegame_3_nightcity.archive'), '--outpath', (Join-Path $work 'original'), '--regex', 'sq029_ent_interaction_dummy\.ent$')
    Invoke-GestureTool 'serialize.log' @('convert', 'serialize', (Join-Path $work 'original'), '--outpath', (Join-Path $work 'json'))
    & node (Join-Path $PSScriptRoot 'Build-GestureAssets.mjs') --inputs (Join-Path $work 'json') --out (Join-Path $work 'generated') --listing $listing --catalog $CatalogPath
    if ($LASTEXITCODE -ne 0) { throw 'Gesture resource generation failed.' }
    Invoke-GestureTool 'deserialize.log' @('convert', 'deserialize', (Join-Path $work 'generated'), '--outpath', $resources)
    Invoke-GestureTool 'roundtrip.log' @('convert', 'serialize', $resources, '--outpath', (Join-Path $work 'roundtrip'))
    & node (Join-Path $PSScriptRoot 'Verify-GestureAssets.mjs') --roundtrip (Join-Path $work 'roundtrip') --generated (Join-Path $work 'generated')
    if ($LASTEXITCODE -ne 0) { throw 'Gesture resource round-trip verification failed.' }
    Invoke-GestureTool 'pack.log' @('pack', $pack, '--outpath', (Join-Path $work 'package'))
    $archive = Join-Path $work 'package\convai_gestures.archive'
    if (-not (Test-Path -LiteralPath $archive)) { throw 'Gesture archive was not created.' }
    $packed = & $WolvenKitPath archive $archive --list -v Quiet 2>$null
    $expected = @($source.device) + @($source.families.PSObject.Properties | ForEach-Object { $_.Value.workspot })
    foreach ($depot in $expected) {
        if (-not ($packed | Where-Object { $_.Trim() -ieq $depot })) { throw "Packed archive is missing $depot" }
    }
    $output = Join-Path $WorkRoot 'package'
    [IO.Directory]::CreateDirectory($output) | Out-Null
    Copy-Item -LiteralPath $archive -Destination (Join-Path $output 'convai_gestures.archive') -Force
    Get-FileHash -LiteralPath (Join-Path $output 'convai_gestures.archive') -Algorithm SHA256
    Write-Output "Build folder: $work"
} finally {
    $env:DOTNET_ROOT = $previousDotNetRoot
    Pop-Location
}
