param(
    [string]$GameDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077',
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = 'Stop'
if (Get-Process Cyberpunk2077 -ErrorAction SilentlyContinue) {
    throw 'Close Cyberpunk before changing CET keybindings.'
}
$path = Join-Path $GameDirectory 'bin\x64\plugins\cyber_engine_tweaks\bindings.json'
if (-not (Test-Path -LiteralPath $path)) { throw "CET bindings not found: $path" }
$bindings = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
if (-not $bindings.CyberpunkConvai) { throw 'CyberpunkConvai hotkeys are not registered yet.' }
$backupDirectory = Join-Path $ProjectDirectory 'backups\keybindings'
[IO.Directory]::CreateDirectory($backupDirectory) | Out-Null
$backup = Join-Path $backupDirectory ('bindings-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
Copy-Item -LiteralPath $path -Destination $backup

# CET stores a keyboard binding as device marker 0x10000000000000 plus the
# Windows virtual key in bits 40-47. F5=0x74 and F6=0x75.
$bindings.CyberpunkConvai.cyberpunk_convai_manager = [long]4631142976192512
$bindings.CyberpunkConvai.cyberpunk_convai_text = [long]4632242487820288
$json = $bindings | ConvertTo-Json -Depth 20
$temporary = "$path.tmp"
[IO.File]::WriteAllText($temporary, $json + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporary -Destination $path -Force
$check = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
if ($check.CyberpunkConvai.cyberpunk_convai_manager -ne 4631142976192512 -or
    $check.CyberpunkConvai.cyberpunk_convai_text -ne 4632242487820288) {
    throw 'CET keybinding verification failed.'
}
Write-Output "F5 manager and F6 text chat configured. Backup: $backup"
