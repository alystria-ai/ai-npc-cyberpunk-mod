param(
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
    [string]$KeyFile,
    [string]$StateDirectory
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath($ProjectDirectory)
if (-not $StateDirectory) {
    if ($env:CYBERPUNK_CONVAI_STATE) { $StateDirectory = $env:CYBERPUNK_CONVAI_STATE }
    else { $StateDirectory = Join-Path $projectRoot 'runtime' }
}
$stateRoot = [IO.Path]::GetFullPath($StateDirectory)
if (-not $KeyFile) { $KeyFile = Join-Path $stateRoot 'convai-key.txt' }
$entry = Join-Path $projectRoot 'bridge\convai-bridge.mjs'
if (-not (Test-Path -LiteralPath $KeyFile -PathType Leaf)) { throw 'Restore the local Convai key file before starting the conversation bridge.' }
$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) }
if ($existing) { Write-Output 'Conversation bridge is already running.'; return }
$node = (Get-Command node -ErrorAction Stop).Source
$builder = Join-Path $projectRoot 'scripts\Build-VoiceClient.mjs'
if (-not (Test-Path -LiteralPath $builder -PathType Leaf)) { throw 'Missing voice-client build helper. Restore scripts/Build-VoiceClient.mjs.' }
# Tests of the source cannot qualify an old browser bundle. Always build before
# starting the worker; a failed build leaves its old bundle unused.
& $node $builder --project $projectRoot
if ($LASTEXITCODE -ne 0) { throw 'Voice client build failed. The conversation bridge was not started.' }
# Another launcher may have completed while the browser client was building.
$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) }
if ($existing) { Write-Output 'Conversation bridge is already running.'; return }
$logs = $stateRoot
[IO.Directory]::CreateDirectory($logs) | Out-Null
$previousKeyFile = $env:CYBERPUNK_CONVAI_KEY_FILE
$previousState = $env:CYBERPUNK_CONVAI_STATE
try {
    $env:CYBERPUNK_CONVAI_KEY_FILE = [IO.Path]::GetFullPath($KeyFile)
    $env:CYBERPUNK_CONVAI_STATE = $stateRoot
    $worker = Start-Process -FilePath $node -ArgumentList ('"' + $entry + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'bridge.stdout.log') -RedirectStandardError (Join-Path $logs 'bridge.stderr.log')
    Start-Sleep -Milliseconds 800
    $worker.Refresh()
    if ($worker.HasExited) { throw 'Conversation bridge exited during startup. Check runtime/bridge.stderr.log.' }
    $worker.Id | Set-Content -LiteralPath (Join-Path $logs 'bridge.pid')
    Write-Output "Conversation bridge started (PID $($worker.Id))."
} finally {
    $env:CYBERPUNK_CONVAI_KEY_FILE = $previousKeyFile
    $env:CYBERPUNK_CONVAI_STATE = $previousState
}
