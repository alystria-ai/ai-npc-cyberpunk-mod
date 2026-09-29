param(
    [string]$GameRoot = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077',
    [string]$OutputRoot = '',
    [switch]$Extract,
    [switch]$IndexOnly,
    [double]$MaxDecodedGiB = 2,
    [double]$MaxCacheGiB = 8
)
$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
if (-not $OutputRoot) { $OutputRoot = Join-Path $projectRoot 'research\cyberpunk\cache\game' }
$arguments = @((Join-Path $PSScriptRoot 'index_game_knowledge.py'), '--project', $projectRoot,
    '--game', $GameRoot, '--output', $OutputRoot,
    '--max-decoded-gib', $MaxDecodedGiB, '--max-cache-gib', $MaxCacheGiB)
if ($Extract) { $arguments += '--extract' }
if ($IndexOnly) { $arguments += '--index-only' }
& python @arguments
if ($LASTEXITCODE -ne 0) { throw "Game knowledge job failed with exit code $LASTEXITCODE. Inspect progress.json and logs in $OutputRoot." }
