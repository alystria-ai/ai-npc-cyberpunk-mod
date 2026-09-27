param(
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
    [string]$KeyFile
)
$ErrorActionPreference = 'Stop'
if (-not $KeyFile) { $KeyFile = Join-Path $ProjectDirectory 'runtime\convai-key.txt' }
$entry = Join-Path ([IO.Path]::GetFullPath($ProjectDirectory)) 'bridge\convai-bridge.mjs'
if (-not (Test-Path -LiteralPath $KeyFile -PathType Leaf)) { throw 'Restore the local Convai key file before starting the conversation bridge.' }
$existing = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) }
if ($existing) { Write-Output 'Conversation bridge is already running.'; return }
$node = (Get-Command node -ErrorAction Stop).Source
$logs = Join-Path $ProjectDirectory 'runtime'
[IO.Directory]::CreateDirectory($logs) | Out-Null
$previousKeyFile = $env:CYBERPUNK_CONVAI_KEY_FILE
try {
    $env:CYBERPUNK_CONVAI_KEY_FILE = [IO.Path]::GetFullPath($KeyFile)
    $worker = Start-Process -FilePath $node -ArgumentList ('"' + $entry + '"') -WorkingDirectory $ProjectDirectory -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logs 'bridge.stdout.log') -RedirectStandardError (Join-Path $logs 'bridge.stderr.log')
    Start-Sleep -Milliseconds 800
    $worker.Refresh()
    if ($worker.HasExited) { throw 'Conversation bridge exited during startup. Check runtime/bridge.stderr.log.' }
    $worker.Id | Set-Content -LiteralPath (Join-Path $logs 'bridge.pid')
    Write-Output "Conversation bridge started (PID $($worker.Id))."
} finally {
    $env:CYBERPUNK_CONVAI_KEY_FILE = $previousKeyFile
}
