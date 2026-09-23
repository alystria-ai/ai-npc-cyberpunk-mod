param(
    [string]$GameDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077'
)

$ErrorActionPreference = 'Stop'
$path = Join-Path $GameDirectory 'bin\x64\plugins\cyber_engine_tweaks\bindings.json'
if (-not (Test-Path -LiteralPath $path)) { throw "CET bindings not found: $path" }
$bindings = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json -AsHashtable
if (-not $bindings.Contains('CyberpunkConvai')) { $bindings['CyberpunkConvai'] = [ordered]@{} }

$desired = [ordered]@{
    cyberpunk_convai_manager    = ([long]0x74 -shl 48) # F5
    cyberpunk_convai_text       = ([long]0x75 -shl 48) # F6
    cyberpunk_convai_phone_join = ([long]0x76 -shl 48) # F7
    cyberpunk_convai_phone_leave = ([long]0x77 -shl 48) # F8
}

foreach ($mod in $bindings.Keys) {
    if ($mod -eq 'CyberpunkConvai') { continue }
    foreach ($entry in $bindings[$mod].GetEnumerator()) {
        if ([long]$entry.Value -in $desired.Values) {
            throw "F5-F8 conflicts with existing binding $mod.$($entry.Key)"
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
Write-Output "Configured F5 manager, F6 text, F7 phone join, F8 phone dismiss. Backup: $backup"
