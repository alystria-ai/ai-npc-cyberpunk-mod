param(
    [Parameter(Mandatory = $true, Position = 0)][ValidateSet('place', 'relic', 'feats', 'media')][string]$Feature,
    [Parameter(Mandatory = $true, Position = 1)][string]$Action,
    [string]$ModDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077\bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod',
    [int]$TimeoutSeconds = 10
)
# Runs one Johnny in your head probe (mod/johnny-probe.lua, docs/JOHNNY_IN_YOUR_HEAD.md "Live check owed") and prints its report.
# Developer only:
#   * the game must be running with the mod installed, a world loaded and unpaused, and Developer mode ON in the mod's settings (with it
#     off the mod reads the request and drops it);
#   * it writes runtime\diagnostic-request.txt, the mod's existing developer mailbox, as "johnny-probe:<feature>:<action>:<stamp>". The
#     mod looks at that file about once a second in Developer mode, and writes runtime\johnny-probe.json with the same request text.
# It never sends input to the game. Features and actions:
#   place    read | note:<place key>         (what the district sample reads now; queue one test arrival at that place)
#   relic    start | status | stop | snapshot
#   feats    start | status | stop
#   media    read | car | pocket | stations | tv | ring | production   (Music and TV, mod/media-probe.lua: the raw value of every candidate read; not about Johnny)
# Usage: powershell -File scripts\Send-JohnnyProbe.ps1 place read
$ErrorActionPreference = 'Stop'
if ($Action -notmatch '^[A-Za-z0-9_:-]+$') { throw 'The action may hold letters, digits, hyphens, underscores and colons only.' }
$runtime = Join-Path $ModDirectory 'runtime'
if (-not (Test-Path -LiteralPath $runtime)) { throw "No runtime folder at $runtime" }
$request = Join-Path $runtime 'diagnostic-request.txt'
$response = Join-Path $runtime 'johnny-probe.json'
$nonce = "johnny-probe:${Feature}:${Action}:" + [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
[IO.File]::WriteAllText($request, $nonce, [Text.UTF8Encoding]::new($false))
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $response) {
        $text = [IO.File]::ReadAllText($response)
        try { $body = $text | ConvertFrom-Json } catch { $body = $null }
        if ($body -and $body.nonce -eq $nonce) {
            $body | ConvertTo-Json -Depth 10
            exit 0
        }
    }
    Start-Sleep -Milliseconds 250
}
Write-Error "No probe response within $TimeoutSeconds s. Is a world loaded and unpaused, with Developer mode on?"
