[CmdletBinding(SupportsShouldProcess)]
param(
    # (Defaults to the folder above this script. It is set below, not here: Windows PowerShell 5.1 leaves $PSScriptRoot empty in a parameter default of a script with CmdletBinding.)
    [string]$ProjectDirectory,
    # The WolvenKit console and .NET runtime the facial and gesture archives use. A worktree has no vendor folder: point these at the main
    # checkout's (the defaults look under -ProjectDirectory first, then the main checkout's folder named by -VendorDirectory).
    [string]$VendorDirectory,
    [string]$OutputDirectory,
    # -Packs: build the pictures of story packs (docs/PHONE_IMAGES.md, "Pictures of story packs") into convai_pack_images.archive instead of the two proof cards.
    # The packs are the ones the release plan ships, or -Pack <id> (more than one allowed), or -AllPacks for every pack file in -PackFolder (default characters\bond-packs).
    # Every picture is checked first (it exists, is a PNG of the size the pack states, 1024 px or less, 2 MB or less). -WhatIf checks and prints the plan and builds nothing.
    [switch]$Packs,
    [string]$PackFolder,
    [string[]]$Pack,
    [switch]$AllPacks
)
# Builds convai_phone_images.archive (docs/PHONE_IMAGES.md): every picture of assets/phone-images/images.json as a texture (.xbm, imported from
# the PNG by WolvenKit) plus its own one-part atlas (.inkatlas), packed under cyberpunk_convai\phone_images\. No game files are read or written.
# With -Packs the pictures are those of story packs (scripts/Build-PackImages.mjs makes and checks the list) and the archive is convai_pack_images.archive.
$ErrorActionPreference = 'Stop'
if (-not $ProjectDirectory) { $ProjectDirectory = Split-Path -Parent $PSScriptRoot }
$project = [IO.Path]::GetFullPath($ProjectDirectory)
if (-not $VendorDirectory) { $VendorDirectory = Join-Path $project 'vendor' }
$WolvenKitPath = Join-Path $VendorDirectory 'wolvenkit-console-9.0.1\WolvenKit.CLI.exe'
$DotNetRoot = Join-Path $VendorDirectory 'dotnet-runtime-10.0.12'
$toolProblem = $null
if (-not (Test-Path -LiteralPath $WolvenKitPath)) { $toolProblem = "WolvenKit CLI is missing at $WolvenKitPath. See docs/FACIAL_ANIMATION.md, and pass -VendorDirectory <checkout>\vendor when this is a worktree." }
elseif (-not (Test-Path -LiteralPath (Join-Path $DotNetRoot 'dotnet.exe'))) { $toolProblem = "The local .NET runtime is missing at $DotNetRoot. See docs/FACIAL_ANIMATION.md, and pass -VendorDirectory <checkout>\vendor when this is a worktree." }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $project 'runtime\phone-images\package' }
$archiveName = 'convai_phone_images'
$manifestFile = $null
if ($Packs) {
    # The list of pictures: made and checked by node, which needs neither WolvenKit nor the game. A problem stops here, with every problem printed.
    $archiveName = 'convai_pack_images'
    $manifestFile = Join-Path ([IO.Path]::GetTempPath()) ('pack-images-' + [guid]::NewGuid().ToString('N') + '.json')
    $arguments = @((Join-Path $PSScriptRoot 'Build-PackImages.mjs'), '--out', $manifestFile)
    if ($PackFolder) { $arguments += @('--pack-folder', $PackFolder) }
    foreach ($id in $Pack) { $arguments += @('--pack', $id) }
    if ($AllPacks) { $arguments += '--all' }
    & node @arguments
    if ($LASTEXITCODE -ne 0) { throw 'The pictures of the story packs are not ready (see the problems above). Nothing was built.' }
    $registryFile = $manifestFile
} else {
    $registryFile = Join-Path $project 'assets\phone-images\images.json'
}
$registry = Get-Content -LiteralPath $registryFile -Raw | ConvertFrom-Json
if ($Packs -and @($registry.images).Count -eq 0) {
    if ($manifestFile) { Remove-Item -LiteralPath $manifestFile -Force -ErrorAction SilentlyContinue -WhatIf:$false }
    Write-Host 'No story pack names a picture: there is nothing to build.'
    return
}
if ($WhatIfPreference) {
    # A dry run: the plan, and whether the tools are there. Nothing is copied, imported or packed.
    Write-Host "What if: build $archiveName.archive from $(@($registry.images).Count) picture(s) into $OutputDirectory"
    foreach ($image in $registry.images) {
        Write-Host ("  {0}: {1}x{2}  {3}\{4}.xbm  {3}\{4}.inkatlas  (part {4})" -f $(if ($image.pack) { "$($image.pack) $($image.imageKey)" } else { $image.key }), $image.width, $image.height, $registry.folder, $image.key)
    }
    if ($toolProblem) { Write-Host "What if: the build would stop here: $toolProblem" } else { Write-Host "What if: WolvenKit and the .NET runtime are in place ($VendorDirectory)." }
    if ($manifestFile) { Remove-Item -LiteralPath $manifestFile -Force -ErrorAction SilentlyContinue -WhatIf:$false }
    return
}
if ($toolProblem) { if ($manifestFile) { Remove-Item -LiteralPath $manifestFile -Force -ErrorAction SilentlyContinue -WhatIf:$false }; throw $toolProblem }
$work = Join-Path $project ('runtime\phone-images\build-' + [guid]::NewGuid().ToString('N'))
$folder = Join-Path $work ('archive\' + $archiveName + '\' + $registry.folder)
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
        # The proof cards name a file under assets\phone-images; a pack picture names its own full path (checked by Build-PackImages.mjs).
        $source = if ([IO.Path]::IsPathRooted($image.png)) { $image.png } else { Join-Path $project ('assets\phone-images\' + $image.png) }
        Copy-Item -LiteralPath $source -Destination $png
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
    Invoke-PhoneImageTool 'pack.log' @('pack', (Join-Path $work ('archive\' + $archiveName)), '--outpath', (Join-Path $work 'package'))
    $archive = Join-Path $work ('package\' + $archiveName + '.archive')
    if (-not (Test-Path -LiteralPath $archive)) { throw "The archive $archiveName.archive was not created." }
    [IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
    Copy-Item -LiteralPath $archive -Destination (Join-Path $OutputDirectory ($archiveName + '.archive')) -Force
    $final = Join-Path $OutputDirectory ($archiveName + '.archive')
    Get-FileHash -LiteralPath $final -Algorithm SHA256
    # The depot paths inside the archive, for the log.
    & $WolvenKitPath archive $final -l
} finally {
    $env:DOTNET_ROOT = $previousDotNetRoot
    if ($manifestFile) { Remove-Item -LiteralPath $manifestFile -Force -ErrorAction SilentlyContinue -WhatIf:$false }
}
