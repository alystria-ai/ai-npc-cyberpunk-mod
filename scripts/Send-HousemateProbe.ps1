param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Words,
    [string]$ModDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077\bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod',
    [int]$TimeoutSeconds = 10
)
# Sends one housemates development command to the running game and prints the answer (docs/HOUSEMATES.md, "Live test, step by step").
#   .\scripts\Send-HousemateProbe.ps1 help
#   .\scripts\Send-HousemateProbe.ps1 where
#   .\scripts\Send-HousemateProbe.ps1 record couch corpo-couch-3
#   .\scripts\Send-HousemateProbe.ps1 stay judy-alvarez corpo
# It is the gesture probe (scripts/Send-GestureProbe.ps1) with the word "housemate" in front. Developer mode on; the game running and not paused.
# teleport, own and qualify change the game: use them on a throwaway COPY of a save only.
$ErrorActionPreference = 'Stop'
$probe = Join-Path $PSScriptRoot 'Send-GestureProbe.ps1'
& $probe -Command ('housemate ' + ($Words -join ' ')) -ModDirectory $ModDirectory -TimeoutSeconds $TimeoutSeconds
