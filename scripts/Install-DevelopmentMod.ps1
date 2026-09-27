param(
    [string]$GameDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077',
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
$game = [IO.Path]::GetFullPath($GameDirectory).TrimEnd('\')
$project = [IO.Path]::GetFullPath($ProjectDirectory).TrimEnd('\')
if (-not [IO.File]::Exists((Join-Path $game 'bin\x64\Cyberpunk2077.exe'))) { throw 'Game directory is invalid.' }
if ((Get-Process Cyberpunk2077 -ErrorAction SilentlyContinue)) { throw 'Close the game before installing the development mod.' }

$targets = @(
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
foreach ($item in $targets) {
    if (-not [IO.File]::Exists($item.From)) { throw "Missing source: $($item.From)" }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.To)) | Out-Null
    [IO.File]::Copy($item.From, $item.To, $true)
    if ((Get-FileHash -LiteralPath $item.From -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $item.To -Algorithm SHA256).Hash) {
        throw "Copy verification failed: $($item.To)"
    }
}
[IO.Directory]::CreateDirectory((Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\runtime')) | Out-Null
Write-Output 'Development adapter installed and hash verified.'
