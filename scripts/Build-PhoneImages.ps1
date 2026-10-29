param(
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
    # The WolvenKit console and .NET runtime the facial and gesture archives use. A worktree has no vendor folder: point these at the main
    # checkout's (the defaults look under -ProjectDirectory first, then the main checkout's folder named by -VendorDirectory).
    [string]$VendorDirectory,
    [string]$OutputDirectory
)
# Builds convai_phone_images.archive (docs/PHONE_IMAGES.md): every picture of assets/phone-images/images.json as a texture (.xbm, imported from
# the PNG by WolvenKit) plus its own one-part atlas (.inkatlas), packed under cyberpunk_convai\phone_images\. No game files are read or written.
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath($ProjectDirectory)
if (-not $VendorDirectory) { $VendorDirectory = Join-Path $project 'vendor' }
$WolvenKitPath = Join-Path $VendorDirectory 'wolvenkit-console-9.0.1\WolvenKit.CLI.exe'
$DotNetRoot = Join-Path $VendorDirectory 'dotnet-runtime-10.0.12'
if (-not (Test-Path -LiteralPath $WolvenKitPath)) { throw "WolvenKit CLI is missing at $WolvenKitPath. See docs/FACIAL_ANIMATION.md." }
if (-not (Test-Path -LiteralPath (Join-Path $DotNetRoot 'dotnet.exe'))) { throw 'Local .NET runtime is missing.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $project 'runtime\phone-images\package' }
$registryFile = Join-Path $project 'assets\phone-images\images.json'
$registry = Get-Content -LiteralPath $registryFile -Raw | ConvertFrom-Json
$work = Join-Path $project ('runtime\phone-images\build-' + [guid]::NewGuid().ToString('N'))
$folder = Join-Path $work ('archive\convai_phone_images\' + $registry.folder)
$json = Join-Path $work 'atlas-json'
[IO.Directory]::CreateDirectory($folder) | Out-Null
[IO.Directory]::CreateDirectory($json) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $work 'package')) | Out-Null
$previousDotNetRoot = $env:DOTNET_ROOT
function Invoke-PhoneImageTool([string]$LogName, [string[]]$Arguments) {
    $log = Join-Path $work $LogName
    & $WolvenKitPath @Arguments *> $log
    if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath $log -Tail 20; throw "WolvenKit failed: $LogName" }
    if (Select-String -LiteralPath $log -Pattern '\[\s*\d+: Error') { throw "WolvenKit reported an error: $LogName" }
}
try {
    $env:DOTNET_ROOT = $DotNetRoot
    # The PNG is imported next to a copy of itself, named like the key, and the copy is removed before packing.
    foreach ($image in $registry.images) {
        $png = Join-Path $folder ($image.key + '.png')
        Copy-Item -LiteralPath (Join-Path $project ('assets\phone-images\' + $image.png)) -Destination $png
        Add-Type -AssemblyName System.Drawing
        $probe = [System.Drawing.Image]::FromFile($png)
        try {
            if ($probe.Width -ne $image.width -or $probe.Height -ne $image.height) { throw "$($image.png) is $($probe.Width)x$($probe.Height), the registry says $($image.width)x$($image.height)." }
            if ($probe.Width -gt 1024 -or $probe.Height -gt 1024) { throw "$($image.png) is larger than 1024 px." }
        } finally { $probe.Dispose() }
        Invoke-PhoneImageTool ('import-' + $image.key + '.log') @('import', $png)
        Remove-Item -LiteralPath $png
        if (-not (Test-Path -LiteralPath (Join-Path $folder ($image.key + '.xbm')))) { throw "Texture was not written: $($image.key)" }
    }
    & node (Join-Path $PSScriptRoot 'Build-PhoneImageAtlas.mjs') $registryFile $json *> (Join-Path $work 'atlas.log')
    if ($LASTEXITCODE -ne 0) { Get-Content -LiteralPath (Join-Path $work 'atlas.log') -Tail 20; throw 'Atlas JSON failed.' }
    Invoke-PhoneImageTool 'deserialize.log' @('convert', 'deserialize', $json, '--outpath', $folder, '--pattern', '*.inkatlas.json')
    foreach ($image in $registry.images) {
        if (-not (Test-Path -LiteralPath (Join-Path $folder ($image.key + '.inkatlas')))) { throw "Atlas was not written: $($image.key)" }
    }
    Invoke-PhoneImageTool 'pack.log' @('pack', (Join-Path $work 'archive\convai_phone_images'), '--outpath', (Join-Path $work 'package'))
    $archive = Join-Path $work 'package\convai_phone_images.archive'
    if (-not (Test-Path -LiteralPath $archive)) { throw 'Phone images archive was not created.' }
    [IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
    Copy-Item -LiteralPath $archive -Destination (Join-Path $OutputDirectory 'convai_phone_images.archive') -Force
    $final = Join-Path $OutputDirectory 'convai_phone_images.archive'
    Get-FileHash -LiteralPath $final -Algorithm SHA256
    # The depot paths inside the archive, for the log.
    & $WolvenKitPath archive $final -l
} finally {
    $env:DOTNET_ROOT = $previousDotNetRoot
}
