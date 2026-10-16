param(
    [string]$Id = 'daily-limit',
    [string]$ModDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077\bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod'
)
# Shows one in-game notice on demand, without any Convai (or other provider) use. Developer only:
#   * the game must be running with the mod installed, a world loaded, and Developer mode ON in the mod's settings (with it off the mod
#     reads the request and drops it);
#   * it writes runtime\diagnostic-request.txt, the mod's existing developer mailbox, as "notice:<id>:<stamp>". The mod looks at that file
#     about once a second in Developer mode (every 4 s otherwise, as it already did), so the notice appears within a second or two.
# Known ids: daily-limit (the Convai free tier daily limit notice: the text a real limit-reached turn shows, same repeat rules).
# Usage: powershell -File scripts\Show-DevNotice.ps1            (daily-limit)
$ErrorActionPreference = 'Stop'
if ($Id -notmatch '^[A-Za-z0-9-]+$') { throw 'The notice id may hold letters, digits and hyphens only.' }
$request = Join-Path $ModDirectory 'runtime\diagnostic-request.txt'
if (-not (Test-Path -LiteralPath (Split-Path -Parent $request))) { throw "No runtime folder at $(Split-Path -Parent $request)" }
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
[IO.File]::WriteAllText($request, "notice:${Id}:$stamp", [Text.UTF8Encoding]::new($false))
Write-Output "Requested notice '$Id' ($stamp). It shows within about two seconds; Developer mode must be on."
