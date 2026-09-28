param(
    [string]$GameDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077',
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
    [switch]$LuaOnly
)

$ErrorActionPreference = 'Stop'
$game = [IO.Path]::GetFullPath($GameDirectory).TrimEnd('\')
$project = [IO.Path]::GetFullPath($ProjectDirectory).TrimEnd('\')
if (-not [IO.File]::Exists((Join-Path $game 'bin\x64\Cyberpunk2077.exe'))) { throw 'Game directory is invalid.' }
if (-not $LuaOnly -and (Get-Process Cyberpunk2077 -ErrorAction SilentlyContinue)) { throw 'Close the game before installing native scripts, or use -LuaOnly for a CET reload.' }

$targets = @(
    @{ From = (Join-Path $project 'mod\companion-appearance.lua'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\companion-appearance.lua') },
    @{ From = (Join-Path $project 'mod\companion-behavior.lua'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\companion-behavior.lua') },
    @{ From = (Join-Path $project 'mod\companion-placement.lua'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\companion-placement.lua') },
    @{ From = (Join-Path $project 'mod\mcm.lua'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\mcm.lua') },
    @{ From = (Join-Path $project 'mod\mcm-entry.lua'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\mcm-entry.lua') },
    @{ From = (Join-Path $project 'mod\manager-party.lua'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\manager-party.lua') },
    @{ From = (Join-Path $project 'mod\manager.lua'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\manager.lua') },
    @{ From = (Join-Path $project 'characters\manager-characters.json'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\manager-characters.json') },
    @{ From = (Join-Path $project 'mod\character-catalog.lua'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\character-catalog.lua') },
    @{ From = (Join-Path $project 'mod\group-chat.lua'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\group-chat.lua') },
    @{ From = (Join-Path $project 'characters\roster.json'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\conversation-characters.json') },
    @{ From = (Join-Path $project 'mod\microphone.lua'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\microphone.lua') },
    @{ From = (Join-Path $project 'mod\speech.lua'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\speech.lua') },
    @{ From = (Join-Path $project 'r6\scripts\CyberpunkConvai\Speech.reds'); To = (Join-Path $game 'r6\scripts\CyberpunkConvai\Speech.reds') },
    @{ From = (Join-Path $project 'mod\composer-input.lua'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\composer-input.lua') },
    @{ From = (Join-Path $project 'mod\subtitles.lua'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\subtitles.lua') },
    @{ From = (Join-Path $project 'mod\phone-input.lua'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\phone-input.lua') },
    @{ From = (Join-Path $project 'characters\phone-contacts.json'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\phone-contacts.json') },
    @{ From = (Join-Path $project 'mod\init.lua'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\init.lua') },
    @{ From = (Join-Path $project 'mod\diagnostics.lua'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\diagnostics.lua') },
    @{ From = (Join-Path $project 'mod\companions.lua'); To = (Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\companions.lua') },
    @{ From = (Join-Path $project 'r6\scripts\CyberpunkConvai\Composer.reds'); To = (Join-Path $game 'r6\scripts\CyberpunkConvai\Composer.reds') },
    @{ From = (Join-Path $project 'r6\scripts\CyberpunkConvai\Engagement.reds'); To = (Join-Path $game 'r6\scripts\CyberpunkConvai\Engagement.reds') },
    @{ From = (Join-Path $project 'r6\scripts\CyberpunkConvai\Manager.reds'); To = (Join-Path $game 'r6\scripts\CyberpunkConvai\Manager.reds') },
    @{ From = (Join-Path $project 'r6\scripts\CyberpunkConvai\PhoneContacts.reds'); To = (Join-Path $game 'r6\scripts\CyberpunkConvai\PhoneContacts.reds') }
)
if ($LuaOnly) {
    $targets = @($targets | Where-Object { $_.From.EndsWith('.lua') -or $_.From.EndsWith('.json') })
}
foreach ($item in $targets) {
    if (-not [IO.File]::Exists($item.From)) { throw "Missing source: $($item.From)" }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.To)) | Out-Null
    [IO.File]::Copy($item.From, $item.To, $true)
    if ((Get-FileHash -LiteralPath $item.From -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $item.To -Algorithm SHA256).Hash) {
        throw "Copy verification failed: $($item.To)"
    }
}
[IO.Directory]::CreateDirectory((Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\runtime')) | Out-Null
if ($LuaOnly) { Write-Output 'Lua adapter and catalogs installed and hash verified. Use CET Reload All Mods to activate.' }
else { Write-Output 'Development adapter installed and hash verified.' }
