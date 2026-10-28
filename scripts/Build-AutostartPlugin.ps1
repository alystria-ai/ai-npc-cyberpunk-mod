param(
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputDirectory,
    # Also build the console-free stand-in host used by bridge/autostart-plugin.test.mjs.
    [switch]$TestHost
)
# Builds the RED4ext launcher DLL with the installed MSVC toolset. Static CRT
# (/MT) keeps the DLL free of a Visual C++ redistributable dependency. /Brepro makes the
# output reproducible: the same source and toolset give a byte-identical DLL.
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath($ProjectDirectory)
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'dist\autostart' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
$source = Join-Path $projectRoot 'native\autostart\CyberpunkConvaiLauncher.c'
$hostSource = Join-Path $projectRoot 'native\autostart\test-host.c'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Missing native/autostart/CyberpunkConvaiLauncher.c.' }

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw 'Visual Studio (with the C++ x64 tools) is required to build the launcher.' }
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual Studio C++ x64 build tools were not found.' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars -PathType Leaf)) { throw 'vcvars64.bat was not found in the Visual Studio installation.' }

[IO.Directory]::CreateDirectory($output) | Out-Null
$objects = Join-Path $output 'obj'
[IO.Directory]::CreateDirectory($objects) | Out-Null
$dll = Join-Path $output 'CyberpunkConvaiLauncher.dll'
$common = '/nologo /std:c11 /W4 /WX /O2 /GS /guard:cf /MT /Brepro'
# The Runtime base's marker plugin: the same source with CONVAI_BASE_MARKER, a RED4ext plugin that does nothing (see Main in the source).
$baseDll = Join-Path $output 'CyberpunkConvaiBase.dll'
$baseObjects = Join-Path $output 'obj-base'
[IO.Directory]::CreateDirectory($baseObjects) | Out-Null
$commands = @(
    "cl $common /LD /Fo`"$objects\\`" /Fe`"$dll`" `"$source`" /link /DLL /NXCOMPAT /DYNAMICBASE /guard:cf /Brepro kernel32.lib",
    "cl $common /DCONVAI_BASE_MARKER /LD /Fo`"$baseObjects\\`" /Fe`"$baseDll`" `"$source`" /link /DLL /NXCOMPAT /DYNAMICBASE /guard:cf /Brepro kernel32.lib"
)
if ($TestHost) {
    $hostExe = Join-Path $output 'test-host.exe'
    $commands += "cl $common /Fo`"$objects\\`" /Fe`"$hostExe`" `"$hostSource`" /link /SUBSYSTEM:WINDOWS kernel32.lib shell32.lib"
}
$installer = Split-Path -Parent $vswhere
foreach ($command in $commands) {
    # Merge compiler stderr inside cmd: Windows PowerShell turns native stderr
    # into terminating errors under ErrorActionPreference Stop.
    $script = "@echo off`r`nset `"PATH=$installer;%PATH%`"`r`ncall `"$vcvars`" >nul 2>&1 || exit /b 1`r`n$command 2>&1`r`n"
    $batch = Join-Path $objects ('build-' + [guid]::NewGuid().ToString('N') + '.cmd')
    [IO.File]::WriteAllText($batch, $script, [Text.Encoding]::ASCII)
    try {
        $log = & cmd.exe /d /c "`"$batch`""
        if ($LASTEXITCODE -ne 0) { $log | Write-Output; throw 'The launcher build failed.' }
    } finally { Remove-Item -LiteralPath $batch -ErrorAction SilentlyContinue }
}
$hash = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "Launcher built: $dll (SHA-256 $hash)"
