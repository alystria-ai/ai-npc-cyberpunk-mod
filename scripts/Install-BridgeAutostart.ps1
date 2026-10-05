param(
    [string]$GameDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077',
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
    [string]$NodePath,
    [string]$StateDirectory
)
# Makes the conversation service start with the game and stop when it exits.
# It writes exactly two files, both inside the game folder:
#   red4ext\plugins\CyberpunkConvaiLauncher\CyberpunkConvaiLauncher.dll
#   red4ext\plugins\CyberpunkConvaiLauncher\launcher.ini
# No scheduled task, service, registry Run key or startup-folder entry is
# created; RED4ext loads the plugin with the game, whichever launcher started it.
# Undo with scripts\Uninstall-BridgeAutostart.ps1.
$ErrorActionPreference = 'Stop'
$game = [IO.Path]::GetFullPath($GameDirectory).TrimEnd('\')
$project = [IO.Path]::GetFullPath($ProjectDirectory).TrimEnd('\')
if (-not [IO.File]::Exists((Join-Path $game 'bin\x64\Cyberpunk2077.exe'))) { throw 'Game directory is invalid.' }
if (-not [IO.File]::Exists((Join-Path $game 'red4ext\RED4ext.dll'))) { throw 'RED4ext is not installed in this game directory.' }
if (-not [IO.File]::Exists((Join-Path $game 'bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai\init.lua'))) {
    throw 'Install the CyberpunkConvai CET mod first (scripts\Install-DevelopmentMod.ps1).'
}
if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
$node = [IO.Path]::GetFullPath($NodePath)
if (-not [IO.File]::Exists($node)) { throw 'Node.js was not found. Pass -NodePath.' }
$supervisor = Join-Path $project 'scripts\Supervise-ConversationBridge.mjs'
if (-not [IO.File]::Exists($supervisor)) { throw 'Missing scripts\Supervise-ConversationBridge.mjs.' }

$dll = Join-Path $project 'dist\autostart\CyberpunkConvaiLauncher.dll'
$source = Join-Path $project 'native\autostart\CyberpunkConvaiLauncher.c'
if (-not [IO.File]::Exists($dll) -or (Get-Item -LiteralPath $dll).LastWriteTimeUtc -lt (Get-Item -LiteralPath $source).LastWriteTimeUtc) {
    & (Join-Path $PSScriptRoot 'Build-AutostartPlugin.ps1') -ProjectDirectory $project | Write-Output
}

# One value per argument: the launcher quotes each one itself, so paths with
# spaces need no escaping. The development launch rebuilds the voice client.
$arguments = @($supervisor, '--project', $project, '--build-voice-client')
if ($StateDirectory) { $arguments += @('--state', [IO.Path]::GetFullPath($StateDirectory)) }
foreach ($value in @($node, $project) + $arguments) {
    if ($value -match '[\r\n"]') { throw 'A launcher path contains an unsupported character.' }
}
$lines = @(
    '; Cyberpunk Convai launcher, written by scripts\Install-BridgeAutostart.ps1.',
    '; Set enabled=0 to stop starting the conversation service with the game.',
    '[launch]', 'enabled=1', "program=$node"
)
for ($index = 0; $index -lt $arguments.Count; $index++) { $lines += "arg$($index + 1)=$($arguments[$index])" }
$lines += "working_directory=$project"

$target = Join-Path $game 'red4ext\plugins\CyberpunkConvaiLauncher'
[IO.Directory]::CreateDirectory($target) | Out-Null
$destination = Join-Path $target 'CyberpunkConvaiLauncher.dll'
$expected = (Get-FileHash -LiteralPath $dll -Algorithm SHA256).Hash
if (-not [IO.File]::Exists($destination) -or (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $expected) {
    $temporary = $destination + '.' + [guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::Copy($dll, $temporary, $false)
        try { Move-Item -LiteralPath $temporary -Destination $destination -Force }
        catch { throw 'The launcher is loaded by the running game. Close the game, then run this script again.' }
    } finally {
        if ([IO.File]::Exists($temporary)) { Remove-Item -LiteralPath $temporary }
    }
    if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $expected) { throw 'Launcher copy verification failed.' }
}
# GetPrivateProfileString reads Unicode only from UTF-16LE files with a BOM.
[IO.File]::WriteAllText((Join-Path $target 'launcher.ini'), (($lines -join "`r`n") + "`r`n"), [Text.UnicodeEncoding]::new($false, $true))

Write-Output "Installed the conversation service launcher in $target"
Write-Output 'It takes effect the next time the game starts. Logs: launcher.log there, and runtime\bridge-service.log in the project.'
$exe = Join-Path $game 'bin\x64\Cyberpunk2077.exe'
if (@(Get-Process Cyberpunk2077 -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $exe }).Count) {
    Write-Output 'The game is running now: this session is unchanged; keep using the bridge you started for it.'
}
