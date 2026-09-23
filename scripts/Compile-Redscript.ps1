param(
    [string]$GameDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077',
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$game = [IO.Path]::GetFullPath($GameDirectory).TrimEnd('\')
$project = [IO.Path]::GetFullPath($ProjectDirectory).TrimEnd('\')
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
    Copy-Item -Destination $scripts -Recurse -Force
$own = Join-Path $project 'r6\scripts\CyberpunkConvai'
if (-not [IO.Directory]::Exists($own)) { throw 'Project redscript sources are missing.' }
$ownStage = Join-Path $scripts 'CyberpunkConvai'
[IO.Directory]::CreateDirectory($ownStage) | Out-Null
Get-ChildItem -LiteralPath $own -File -Filter '*.reds' |
    Copy-Item -Destination $ownStage -Force

$deps = Join-Path $scripts '__CyberpunkConvaiCompilerDependencies'
[IO.Directory]::CreateDirectory($deps) | Out-Null
foreach ($plugin in @('Codeware', 'TweakXL')) {
    $pluginScripts = Join-Path $game "red4ext\plugins\$plugin\Scripts"
    if (-not [IO.Directory]::Exists($pluginScripts)) { throw "$plugin scripts are missing." }
    Get-ChildItem -LiteralPath $pluginScripts -File -Filter '*.reds' |
        Copy-Item -Destination $deps -Force
}

& (Join-Path $game 'engine\tools\scc.exe') '-compile' $scripts '-customCacheDir' $cache *>&1 |
    Set-Content -LiteralPath $log -Encoding utf8
$result = $LASTEXITCODE
Write-Output "Compiler exit: $result"
Write-Output "Compiler log: $log"
Select-String -LiteralPath $log -Pattern 'CyberpunkConvai|\[ERROR|Compilation complete|compilation has failed' |
    Select-Object -Last 100 | ForEach-Object { Write-Output $_.Line }
if ($result -ne 0) { exit $result }
