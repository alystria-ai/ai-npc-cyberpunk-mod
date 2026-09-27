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
if (-not $bindings.Contains('CyberpunkConvai')) { $bindings['CyberpunkConvai'] = [ordered]@{} }

$desired = [ordered]@{
    cyberpunk_convai_manager    = ([long]0x74 -shl 48) # F5
    cyberpunk_convai_text       = ([long]0x75 -shl 48) # F6
}

foreach ($mod in $bindings.Keys) {
    if ($mod -eq 'CyberpunkConvai') { continue }
    foreach ($entry in $bindings[$mod].GetEnumerator()) {
        if ([long]$entry.Value -in $desired.Values) {
            throw "F5-F6 conflicts with existing binding $mod.$($entry.Key)"
        }
    }
}

$backup = "$path.pre-convai-$(Get-Date -Format 'yyyyMMdd-HHmmss').bak"
Copy-Item -LiteralPath $path -Destination $backup
foreach ($entry in $desired.GetEnumerator()) {
    $bindings['CyberpunkConvai'][$entry.Key] = $entry.Value
}
$json = $bindings | ConvertTo-Json -Depth 8
Set-Content -LiteralPath $path -Value $json -Encoding utf8
Write-Output "Configured F5 manager and F6 text. Phone join and dismiss use the native [+] and [-] controls. Backup: $backup"
