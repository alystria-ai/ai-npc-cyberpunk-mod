param(
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
    [string]$OutputDirectory,
    # A RED4ext.SDK checkout at the commit pinned in native/core/CMakeLists.txt. Without it CMake
    # fetches that commit itself (FetchContent, needs git and network).
    [string]$SdkDirectory = $env:CYBERPUNK_CONVAI_RED4EXT_SDK,
    [ValidateSet('Release', 'RelWithDebInfo', 'Debug')]
    [string]$Configuration = 'Release',
    # Skip the headless tests (they run by default).
    [switch]$NoTests
)
# Builds CyberpunkConvaiNative.dll (the RED4ext plugin in native/core) with CMake and the
# installed Visual Studio 2022 C++ toolset, then runs the headless tests. Static CRT and /Brepro,
# as for the launcher plugin. Installs nothing.
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath($ProjectDirectory)
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $projectRoot 'dist\native-core' }
$output = [IO.Path]::GetFullPath($OutputDirectory)
$source = Join-Path $projectRoot 'native\core'
$build = Join-Path $output 'build'
if (-not (Test-Path -LiteralPath (Join-Path $source 'CMakeLists.txt') -PathType Leaf)) { throw 'Missing native/core/CMakeLists.txt.' }

$cmake = (Get-Command cmake -ErrorAction SilentlyContinue).Source
if (-not $cmake) {
    $candidate = Join-Path $env:ProgramFiles 'CMake\bin\cmake.exe'
    if (Test-Path -LiteralPath $candidate) { $cmake = $candidate } else { throw 'CMake 3.21 or newer is required.' }
}
$ctest = Join-Path (Split-Path -Parent $cmake) 'ctest.exe'

$configure = @('-S', $source, '-B', $build, '-G', 'Visual Studio 17 2022', '-A', 'x64')
if ($SdkDirectory) {
    $sdk = [IO.Path]::GetFullPath($SdkDirectory)
    if (-not (Test-Path -LiteralPath (Join-Path $sdk 'include\RED4ext\RED4ext.hpp'))) { throw "Not a RED4ext.SDK checkout: $sdk" }
    $pinned = (Select-String -LiteralPath (Join-Path $source 'CMakeLists.txt') -Pattern 'RED4EXT_SDK_COMMIT "([0-9a-f]{40})"').Matches[0].Groups[1].Value
    $head = (& git -C $sdk rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or $head -ne $pinned) { throw "RED4ext.SDK at $sdk is at '$head', expected the pinned $pinned." }
    $configure += "-DRED4EXT_SDK_DIR=$sdk"
}

function Invoke-Step([string]$exe, [string[]]$arguments, [string]$what) {
    # Merge stderr inside cmd: Windows PowerShell turns native stderr into terminating errors.
    $quoted = ($arguments | ForEach-Object { if ($_ -match '\s') { '"' + $_ + '"' } else { $_ } }) -join ' '
    $log = & cmd.exe /d /c "`"$exe`" $quoted 2>&1"
    if ($LASTEXITCODE -ne 0) { $log | ForEach-Object { Write-Host $_ }; throw "$what failed." }
    return $log
}

[IO.Directory]::CreateDirectory($output) | Out-Null
Invoke-Step $cmake $configure 'CMake configure' | Out-Null
Invoke-Step $cmake @('--build', $build, '--config', $Configuration, '--parallel') 'Build' | Out-Null

$dll = Join-Path $build "$Configuration\CyberpunkConvaiNative.dll"
if (-not (Test-Path -LiteralPath $dll)) { throw "Build produced no DLL at $dll." }
Copy-Item -LiteralPath $dll -Destination (Join-Path $output 'CyberpunkConvaiNative.dll') -Force
$hash = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash.ToLowerInvariant()

if (-not $NoTests) {
    $testLog = Invoke-Step $ctest @('--test-dir', $build, '-C', $Configuration, '--output-on-failure') 'Native tests'
    $testLog | Select-Object -Last 3 | Write-Output
}
Write-Output "Native core built: $(Join-Path $output 'CyberpunkConvaiNative.dll') (SHA-256 $hash)"
