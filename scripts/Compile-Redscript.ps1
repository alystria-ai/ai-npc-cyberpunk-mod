param(
    [string]$GameDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077',
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
    # The game version the scripts are compiled for (2.5 uses packaging/game-variants/2.5/ over the project's files, docs/GAME_VERSIONS.md).
    [ValidateSet('2.31', '2.5')]
    [string]$GameVersion = '2.5'
)

$ErrorActionPreference = 'Stop'
$game = [IO.Path]::GetFullPath($GameDirectory).TrimEnd('\')
$project = [IO.Path]::GetFullPath($ProjectDirectory).TrimEnd('\')
Import-Module (Join-Path $PSScriptRoot 'DevelopmentFiles.psm1') -Force
if (-not [IO.File]::Exists((Join-Path $game 'engine\tools\scc.exe'))) { throw 'Redscript compiler was not found.' }

# Compile an isolated copy so a running game never sees partially installed scripts.
$run = Join-Path $project ('vendor\compiler-check-' + [guid]::NewGuid().ToString('N'))
$scripts = Join-Path $run 'r6\scripts'
$cache = Join-Path $run 'r6\cache'
$log = Join-Path $run 'compile.log'
[IO.Directory]::CreateDirectory($scripts) | Out-Null
[IO.Directory]::CreateDirectory($cache) | Out-Null
Copy-Item -LiteralPath (Join-Path $game 'r6\cache\final.redscripts') -Destination (Join-Path $cache 'final.redscripts')

$gameScripts = Join-Path $game 'r6\scripts'
Get-ChildItem -LiteralPath $gameScripts -Force |
    Where-Object { $_.Name -ine 'CyberpunkConvai' } |
    Copy-Item -Destination $scripts -Recurse -Force
# Compile exactly the owned native files that the installer ships, excluding
# retired experiments even if they remain in source or an older installation.
Copy-DevelopmentNativeStage -ProjectDirectory $project -ScriptsDirectory $scripts -Game $GameVersion

$deps = Join-Path $scripts '__CyberpunkConvaiCompilerDependencies'
[IO.Directory]::CreateDirectory($deps) | Out-Null
foreach ($plugin in @('Codeware')) {
    $pluginScripts = Join-Path $game "red4ext\plugins\$plugin\Scripts"
    if (-not [IO.Directory]::Exists($pluginScripts)) { throw "$plugin scripts are missing." }
    Get-ChildItem -LiteralPath $pluginScripts -File -Filter '*.reds' |
        Copy-Item -Destination $deps -Force
}

# The game finds the scripts of every other RED4ext plugin too (TweakXL, ArchiveXL, ...); another installed redscript mod can need them
# (Dark Future calls TweakXL's TweakDBManager), and without them it fails to compile here although the game compiles it.
$pluginsRoot = Join-Path $game 'red4ext\plugins'
if ([IO.Directory]::Exists($pluginsRoot)) {
    foreach ($pluginFolder in Get-ChildItem -LiteralPath $pluginsRoot -Directory) {
        if ($pluginFolder.Name -ieq 'Codeware' -or $pluginFolder.Name -like 'AiNpcCyberpunkMod*') { continue }
        $extra = Join-Path $pluginFolder.FullName 'Scripts'
        if (-not [IO.Directory]::Exists($extra)) { continue }
        $target = Join-Path $deps $pluginFolder.Name
        [IO.Directory]::CreateDirectory($target) | Out-Null
        Get-ChildItem -LiteralPath $extra -File -Filter '*.reds' | Copy-Item -Destination $target -Force
    }
}

# Standard input is closed so the compiler can never wait for a key press after an error.
$null | & (Join-Path $game 'engine\tools\scc.exe') '-compile' $scripts '-customCacheDir' $cache *>&1 |
    Set-Content -LiteralPath $log -Encoding utf8
$result = $LASTEXITCODE
Write-Output "Compiler exit: $result"
Write-Output "Compiler log: $log"
Select-String -LiteralPath $log -Pattern 'CyberpunkConvai|\[ERROR|Compilation complete|compilation has failed' |
    Select-Object -Last 100 | ForEach-Object { Write-Output $_.Line }
if ($result -ne 0) { exit $result }
