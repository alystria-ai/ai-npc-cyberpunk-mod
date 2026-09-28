param([string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath($ProjectDirectory)
$entry = Join-Path $projectRoot 'bridge\convai-bridge.mjs'
$workers = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) })
if ($workers.Count -eq 0) { Write-Output 'Conversation bridge is not running.'; return }
if ($workers.Count -ne 1) { throw 'Multiple conversation bridges found. Resolve the duplicate before stopping.' }
$worker = Get-Process -Id $workers[0].ProcessId -ErrorAction Stop
$command = @{action='shutdown'; pid=$worker.Id; nonce=[guid]::NewGuid().ToString()} | ConvertTo-Json -Compress
$target = Join-Path $projectRoot 'runtime\bridge-control.json'
$temporary = $target + '.tmp'
[IO.File]::WriteAllText($temporary, $command, [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporary -Destination $target -Force
if (-not $worker.WaitForExit(55000)) {
    throw 'Shutdown is still waiting for local speech to finish. Do not force-stop a running GPU render; retry after it finishes.'
}
Write-Output 'Conversation bridge stopped and its resident voice worker released.'
