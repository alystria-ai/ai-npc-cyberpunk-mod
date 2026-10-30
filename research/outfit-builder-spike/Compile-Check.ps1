param(
    [Parameter(Mandatory)][string]$GameDirectory,
    [switch]$WithoutCodeware
)
# Compiles OutfitBuilder.reds alone against a game's own script bundle (an isolated copy in the temp folder, nothing is written to the game folder),
# with or without Codeware's scripts: the same offline check scripts/Compile-Redscript.ps1 does for the shipped files.
$ErrorActionPreference = 'Stop'
$game = [IO.Path]::GetFullPath($GameDirectory).TrimEnd('\')
$run = Join-Path ([IO.Path]::GetTempPath()) ('outfit-builder-check-' + [guid]::NewGuid().ToString('N'))
$scripts = Join-Path $run 'r6\scripts'
$cache = Join-Path $run 'r6\cache'
[IO.Directory]::CreateDirectory($scripts) | Out-Null
[IO.Directory]::CreateDirectory($cache) | Out-Null
Copy-Item -LiteralPath (Join-Path $game 'r6\cache\final.redscripts') -Destination (Join-Path $cache 'final.redscripts')
Get-ChildItem -LiteralPath (Join-Path $game 'r6\scripts') -Force | Where-Object { $_.Name -ine 'CyberpunkConvai' } | Copy-Item -Destination $scripts -Recurse -Force
if (-not $WithoutCodeware) {
    $deps = Join-Path $scripts '__Codeware'
    [IO.Directory]::CreateDirectory($deps) | Out-Null
    Get-ChildItem -LiteralPath (Join-Path $game 'red4ext\plugins\Codeware\Scripts') -File -Filter '*.reds' | Copy-Item -Destination $deps -Force
}
# The other RED4ext plugins' scripts (ArchiveXL, TweakXL...) are found by the game too, and other installed redscript mods can need them.
$extra = Join-Path $scripts '__plugins'
foreach ($plugin in Get-ChildItem -LiteralPath (Join-Path $game 'red4ext\plugins') -Directory) {
    if ($plugin.Name -ieq 'Codeware' -or $plugin.Name -like 'AiNpcCyberpunk*') { continue }
    $from = Join-Path $plugin.FullName 'Scripts'
    if (-not [IO.Directory]::Exists($from)) { continue }
    $to = Join-Path $extra $plugin.Name
    [IO.Directory]::CreateDirectory($to) | Out-Null
    Get-ChildItem -LiteralPath $from -File -Filter '*.reds' | Copy-Item -Destination $to -Force
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'OutfitBuilder.reds') -Destination $scripts
$log = Join-Path $run 'compile.log'
$null | & (Join-Path $game 'engine\tools\scc.exe') '-compile' $scripts '-customCacheDir' $cache *>&1 | Set-Content -LiteralPath $log -Encoding utf8
Write-Output "Compiler exit: $LASTEXITCODE"
# Other installed mods may not compile in this isolated copy (they need what is not here); only errors in OutfitBuilder.reds count.
$all = Get-Content -LiteralPath $log
$own = $all | Where-Object { $_ -match 'OutfitBuilder' -and $_ -match 'ERROR|WARN' }
Write-Output "Errors in the whole copy: $(@($all | Where-Object { $_ -match '\[ERROR' }).Count), in OutfitBuilder.reds: $(@($own).Count)"
$own
$all | Select-Object -Last 2
Remove-Item -LiteralPath $run -Recurse -Force

