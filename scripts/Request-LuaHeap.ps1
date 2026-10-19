param(
    [switch]$CountOnly,
    [int]$TimeoutSeconds = 15,
    [string]$ModDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077\bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod'
)
# Asks the running game for one Lua heap report (mod/lua-heap-probe.lua, a development-only file the development install copies)
# and prints it. Developer tool:
#   * the game must be running with the mod installed and a world loaded (the mailbox is read in onUpdate);
#   * it writes runtime\diagnostic-request.txt, the mod's developer mailbox, as "lua-heap:<stamp>" ("lua-heap:count:<stamp>" with
#     -CountOnly). The mod looks at the file about once a second with Developer mode on, every 4 s otherwise;
#   * the full report runs ONE full Lua garbage collection (a single pause, its length is in collectMs) and walks this mod's tables;
#     -CountOnly reads collectgarbage('count') only, with no pause and no walk.
# The report lands in runtime\lua-heap.json (the latest report plus the previous ones, so heaps after a CET reload or a load compare).
# Usage: powershell -File scripts\Request-LuaHeap.ps1 [-CountOnly]
$ErrorActionPreference = 'Stop'
$runtime = Join-Path $ModDirectory 'runtime'
if (-not (Test-Path -LiteralPath $runtime)) { throw "No runtime folder at $runtime" }
if (-not $CountOnly -and -not (Test-Path -LiteralPath (Join-Path $ModDirectory 'lua-heap-probe.lua'))) {
    throw 'lua-heap-probe.lua is not installed in the mod folder: run scripts\Install-DevelopmentMod.ps1 -LuaOnly first.'
}
$stamp = [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
$nonce = if ($CountOnly) { "lua-heap:count:$stamp" } else { "lua-heap:$stamp" }
$request = Join-Path $runtime 'diagnostic-request.txt'
$response = Join-Path $runtime 'diagnostic-response.txt'
$result = Join-Path $runtime 'lua-heap.json'
[IO.File]::WriteAllText($request, $nonce, [Text.UTF8Encoding]::new($false))
Write-Output "Requested $nonce; waiting up to $TimeoutSeconds s for the game to answer."
$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
$answered = $false
while ([DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
    if ((Test-Path -LiteralPath $response) -and ([IO.File]::ReadAllText($response) -eq $nonce)) { $answered = $true; break }
}
if (-not $answered) { throw 'No answer: is the game running with a world loaded and the mod installed?' }
$report = (Get-Content -LiteralPath $result -Raw -Encoding UTF8 | ConvertFrom-Json).latest
if ($report.nonce -ne $nonce) { throw "runtime\lua-heap.json holds another request ($($report.nonce)); the probe may have failed (see runtime\probe.log)." }
function Mb($kb) { if ($null -eq $kb) { return '-' } return ('{0:N1} MB' -f ($kb / 1024)) }
Write-Output ("Whole Lua state (every CET mod): {0} before, {1} after a full collect ({2:N0} ms); garbage {3}" -f `
    (Mb $report.heapBeforeKB), (Mb $report.heapAfterKB), $report.collectMs, (Mb $report.garbageKB))
if ($null -ne $report.modKB) {
    Write-Output ("This mod's tables: about {0}; everything else (other mods, CET, compiled code): {1}; {2:N0} objects in {3:N0} ms{4}" -f `
        (Mb $report.modKB), (Mb $report.otherKB), $report.objects, $report.walkMs, $(if ($report.truncated) { ' (walk cut short)' } else { '' }))
    Write-Output 'Largest fields:'
    foreach ($row in @($report.fields) | Select-Object -First 12) { Write-Output ('  {0,10:N0} KB  {1}' -f $row.kb, $row.name) }
    Write-Output 'Largest single tables:'
    foreach ($row in @($report.tables) | Select-Object -First 8) { Write-Output ('  {0,10:N0} KB  {1} ({2} entries)' -f $row.kb, $row.path, $row.entries) }
}
Write-Output "Seconds since the mod loaded: $($report.secondsSinceLoad). Full report: $result"
