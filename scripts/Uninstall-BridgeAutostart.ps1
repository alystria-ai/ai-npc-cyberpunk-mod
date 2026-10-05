param(
    [string]$GameDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077'
)
# Removes only what Install-BridgeAutostart.ps1 created (plus the launcher's
# own log and status file). A running bridge is left alone; it still stops when
# the game exits. While the game runs, the loaded DLL cannot be deleted, so the
# launcher is disabled instead and this script asks to be run again later.
$ErrorActionPreference = 'Stop'
$game = [IO.Path]::GetFullPath($GameDirectory).TrimEnd('\')
if (-not [IO.File]::Exists((Join-Path $game 'bin\x64\Cyberpunk2077.exe'))) { throw 'Game directory is invalid.' }
$target = Join-Path $game 'red4ext\plugins\CyberpunkConvaiLauncher'
if (-not [IO.Directory]::Exists($target)) { Write-Output 'The conversation service launcher is not installed.'; return }
$dll = Join-Path $target 'CyberpunkConvaiLauncher.dll'
$ini = Join-Path $target 'launcher.ini'
try {
    if ([IO.File]::Exists($dll)) { Remove-Item -LiteralPath $dll }
} catch {
    if ([IO.File]::Exists($ini)) {
        $text = [IO.File]::ReadAllText($ini) -replace '(?m)^enabled=.*$', 'enabled=0'
        [IO.File]::WriteAllText($ini, $text, [Text.UnicodeEncoding]::new($false, $true))
    }
    Write-Output 'The game has the launcher loaded. It is disabled for the next launch; close the game and run this script again to remove it.'
    return
}
foreach ($name in @('launcher.ini', 'launcher.log')) {
    $path = Join-Path $target $name
    if ([IO.File]::Exists($path)) { Remove-Item -LiteralPath $path }
}
if (@(Get-ChildItem -LiteralPath $target -Force).Count -eq 0) { Remove-Item -LiteralPath $target }
else { Write-Output "Left other files in $target untouched." }
$status = Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\runtime\bridge-service.json'
$exe = Join-Path $game 'bin\x64\Cyberpunk2077.exe'
$running = @(Get-Process Cyberpunk2077 -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }).Count -gt 0
if ([IO.File]::Exists($status) -and -not $running) { Remove-Item -LiteralPath $status }
Write-Output 'Removed the conversation service launcher. Start the bridge by hand with scripts\Start-ConversationBridge.ps1.'
