param(
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputDirectory
)
# Builds CyberpunkConvaiVision.exe (native/vision, the "Companions can see" capture helper, docs/COMPANION_VISION.md)
# with the installed MSVC toolset and the Windows SDK's C++/WinRT headers. Static CRT (/MT): no Visual C++
# redistributable is needed. /Brepro makes the output reproducible. Installs nothing.
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath($ProjectDirectory)
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'dist\vision' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
$source = Join-Path $projectRoot 'native\vision\CyberpunkConvaiVision.cpp'
if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'Missing native/vision/CyberpunkConvaiVision.cpp.' }

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw 'Visual Studio (with the C++ x64 tools) is required to build the vision helper.' }
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw 'Visual Studio C++ x64 build tools were not found.' }
$vcvars = Join-Path $vs 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path -LiteralPath $vcvars -PathType Leaf)) { throw 'vcvars64.bat was not found in the Visual Studio installation.' }

[IO.Directory]::CreateDirectory($output) | Out-Null
$objects = Join-Path $output 'obj'
[IO.Directory]::CreateDirectory($objects) | Out-Null
$exe = Join-Path $output 'CyberpunkConvaiVision.exe'
$flags = '/nologo /std:c++17 /EHsc /permissive- /W4 /O2 /GS /guard:cf /MT /Brepro /DUNICODE /D_UNICODE'
$libs = 'windowsapp.lib d3d11.lib dxgi.lib dwmapi.lib windowscodecs.lib ole32.lib oleaut32.lib user32.lib'
$command = "cl $flags /Fo`"$objects\\`" /Fe`"$exe`" `"$source`" /link /SUBSYSTEM:CONSOLE /NXCOMPAT /DYNAMICBASE /guard:cf /Brepro $libs"
$installer = Split-Path -Parent $vswhere
# Merge compiler stderr inside cmd: Windows PowerShell turns native stderr into terminating errors under Stop.
$script = "@echo off`r`nset `"PATH=$installer;%PATH%`"`r`ncall `"$vcvars`" >nul 2>&1 || exit /b 1`r`n$command 2>&1`r`n"
$batch = Join-Path $objects ('build-' + [guid]::NewGuid().ToString('N') + '.cmd')
[IO.File]::WriteAllText($batch, $script, [Text.Encoding]::ASCII)
try {
    $log = & cmd.exe /d /c "`"$batch`""
    if ($LASTEXITCODE -ne 0) { $log | Write-Output; throw 'The vision helper build failed.' }
} finally { Remove-Item -LiteralPath $batch -ErrorAction SilentlyContinue }
$hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
Write-Output "Vision helper built: $exe (SHA-256 $hash)"
