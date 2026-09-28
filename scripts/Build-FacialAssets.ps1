param(
    [string]$GameDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077',
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
    [string]$WolvenKitPath,
    [string]$DotNetRoot
)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath($ProjectDirectory)
if (-not $WolvenKitPath) { $WolvenKitPath = Join-Path $project 'vendor\wolvenkit-console-9.0.1\WolvenKit.CLI.exe' }
if (-not $DotNetRoot) { $DotNetRoot = Join-Path $project 'vendor\dotnet-runtime-10.0.12' }
if (-not (Test-Path -LiteralPath $WolvenKitPath)) { throw 'WolvenKit CLI is missing. See docs/FACIAL_ANIMATION.md.' }
if (-not (Test-Path -LiteralPath (Join-Path $DotNetRoot 'dotnet.exe'))) { throw 'Local .NET runtime is missing.' }
$output = Join-Path $project 'runtime\facial-rig\package'
# Each build has fresh inputs. A changed game archive cannot silently reuse
# graphs extracted by an older build or accidentally pack unrelated resources.
$work = Join-Path $project ('runtime\facial-rig\build-' + [guid]::NewGuid().ToString('N'))
$resources = Join-Path $work 'archive\convai_facial\cyberpunk_convai\facial'
foreach ($folder in @('original', 'json', 'extended-json', 'roundtrip', 'package')) {
    [IO.Directory]::CreateDirectory((Join-Path $work $folder)) | Out-Null
}
[IO.Directory]::CreateDirectory($resources) | Out-Null
$previousDotNetRoot = $env:DOTNET_ROOT
function Invoke-FacialTool([string]$LogName, [string[]]$Arguments) {
    $log = Join-Path $work $LogName
    & $WolvenKitPath @Arguments *> $log
    if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath $log -Tail 20; throw "WolvenKit failed: $LogName" }
    $errors = Select-String -LiteralPath $log -Pattern '\[\s*\d+: Error'
    if ($errors) { throw "WolvenKit reported an error: $LogName" }
}
Push-Location $project
try {
    $env:DOTNET_ROOT = $DotNetRoot
    $schema = Get-Content -LiteralPath (Join-Path $project 'assets\facial\controls.json') -Raw | ConvertFrom-Json
    $names = ($schema.graphs | ForEach-Object { [regex]::Escape($_) }) -join '|'
    $pattern = '^base\\animations\\facial\\_facial_graphs\\(' + $names + ')\.animgraph$'
    Invoke-FacialTool 'extract.log' @('unbundle', (Join-Path $GameDirectory 'archive\pc\content\basegame_4_gamedata.archive'), '--outpath', (Join-Path $work 'original'), '--regex', $pattern)
    Invoke-FacialTool 'serialize.log' @('convert', 'serialize', (Join-Path $work 'original'), '--outpath', (Join-Path $work 'json'))
    & node (Join-Path $PSScriptRoot 'Build-FacialGraphs.mjs') (Join-Path $work 'json') (Join-Path $work 'extended-json') *> (Join-Path $work 'build.log')
    if ($LASTEXITCODE -ne 0) { throw 'Facial graph extension failed.' }
    Invoke-FacialTool 'deserialize.log' @('convert', 'deserialize', (Join-Path $work 'extended-json'), '--outpath', $resources, '--pattern', '*.animgraph.json')
    Invoke-FacialTool 'roundtrip.log' @('convert', 'serialize', $resources, '--outpath', (Join-Path $work 'roundtrip'))
    & node (Join-Path $PSScriptRoot 'Verify-FacialGraphs.mjs') (Join-Path $work 'roundtrip')
    if ($LASTEXITCODE -ne 0) { throw 'Native graph verification failed.' }
    Invoke-FacialTool 'pack.log' @('pack', (Join-Path $work 'archive\convai_facial'), '--outpath', (Join-Path $work 'package'))
    $archive = Join-Path $work 'package\convai_facial.archive'
    if (-not (Test-Path -LiteralPath $archive)) { throw 'Facial archive was not created.' }
    & node (Join-Path $PSScriptRoot 'Verify-FacialGraphs.mjs') --archive $archive
    if ($LASTEXITCODE -ne 0) { throw 'Facial archive path verification failed.' }
    [IO.Directory]::CreateDirectory($output) | Out-Null
    Copy-Item -LiteralPath $archive -Destination (Join-Path $output 'convai_facial.archive')
    Get-FileHash -LiteralPath (Join-Path $output 'convai_facial.archive') -Algorithm SHA256
} finally {
    $env:DOTNET_ROOT = $previousDotNetRoot
    Pop-Location
}
