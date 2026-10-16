param(
    [string]$GameDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077'
)

$ErrorActionPreference = 'Stop'
if (Get-Process Cyberpunk2077 -ErrorAction SilentlyContinue) {
    throw 'Close Cyberpunk before changing CET keybindings.'
}
$path = Join-Path $GameDirectory 'bin\x64\plugins\cyber_engine_tweaks\bindings.json'
if (-not (Test-Path -LiteralPath $path)) { throw "CET bindings not found: $path" }
$bindings = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable
if (-not $bindings.Contains('AiNpcCyberpunkMod')) { $bindings['AiNpcCyberpunkMod'] = [ordered]@{} }

$desired = [ordered]@{
    cyberpunk_convai_manager    = ([long]0x73 -shl 48) # F4; F5 is vanilla QuickSave
    cyberpunk_convai_text       = ([long]0x75 -shl 48) # F6
    cyberpunk_convai_voice      = ([long]0x76 -shl 48) # F7
    cyberpunk_convai_group_text = ([long]0x77 -shl 48) # F8
    cyberpunk_convai_group_voice = ([long]0x79 -shl 48) # F10
}
$pending = [ordered]@{}
foreach ($entry in $desired.GetEnumerator()) {
    # Running the setup again must not replace a user's chosen key, including
    # the locally accepted F4 manager shortcut.
    if (-not $bindings['AiNpcCyberpunkMod'].Contains($entry.Key) -or
        [long]$bindings['AiNpcCyberpunkMod'][$entry.Key] -eq 0) { $pending[$entry.Key] = $entry.Value }
}
if ($pending.Count -eq 0) { Write-Output 'All companion shortcuts are already assigned; existing choices preserved.'; return }

foreach ($mod in $bindings.Keys) {
    foreach ($entry in $bindings[$mod].GetEnumerator()) {
        if ([long]$entry.Value -ne 0 -and [long]$entry.Value -in $pending.Values) {
            throw "A proposed companion shortcut conflicts with existing binding $mod.$($entry.Key). Existing bindings were preserved."
        }
    }
}

$backup = "$path.pre-convai-$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
Copy-Item -LiteralPath $path -Destination $backup
foreach ($entry in $pending.GetEnumerator()) {
    $bindings['AiNpcCyberpunkMod'][$entry.Key] = $entry.Value
}
$json = $bindings | ConvertTo-Json -Depth 8
$temporary = $path + '.convai-bindings.tmp'
try {
    [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $path -Force
} finally { if ([IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary } }
Write-Output "Assigned $($pending.Count) missing shortcuts (defaults: F4 manager, F6 text, F7 voice, F8 group text, F10 group voice). Existing choices preserved. Phone invite/dismiss use J/L. Backup: $backup"
