param(
    [ValidateSet('start', 'stop', 'status', 'check', 'recover')]
    [string]$Action = 'start',
    [string]$AppDirectory = $PSScriptRoot,
    [string]$DevelopmentProjectDirectory,
    [string]$GameDirectory,
    [string]$StateDirectory
)
$ErrorActionPreference = 'Stop'
$appRoot = [IO.Path]::GetFullPath($AppDirectory)
if ($DevelopmentProjectDirectory) {
    $projectRoot = [IO.Path]::GetFullPath($DevelopmentProjectDirectory)
    if (-not $GameDirectory) { throw 'Development mode needs an explicit game directory.' }
    $node = (Get-Command node -ErrorAction Stop).Source
    $entry = Join-Path $PSScriptRoot 'Runtime-Service.mjs'
    $stateRoot = if ($StateDirectory) { [IO.Path]::GetFullPath($StateDirectory) } else { Join-Path $projectRoot 'runtime' }
    $arguments = @($entry, $Action, '--development-project', $projectRoot, '--game', [IO.Path]::GetFullPath($GameDirectory), '--state', $stateRoot)
} else {
    if ($GameDirectory -or $StateDirectory) { throw 'Packaged runtime paths are discovered from the installation.' }
    $manifestPath = Join-Path $appRoot 'runtime-manifest.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw 'The runtime manifest is missing. This is not a built runtime package.' }
    if ((Get-Item -LiteralPath $manifestPath).Length -gt 4MB) { throw 'The runtime manifest exceeded its supported size.' }
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    $nodeRelative = $manifest.executables.node.path
    if ($manifest.schema -ne 1 -or $nodeRelative -isnot [string] -or -not $nodeRelative -or
        $nodeRelative -match '[\\:\x00-\x1f\x7f]' -or $nodeRelative.StartsWith('/') -or
        @($nodeRelative.Split('/') | Where-Object { $_ -in @('', '.', '..') }).Count -ne 0) { throw 'The packaged Node path is invalid.' }
    $node = [IO.Path]::GetFullPath((Join-Path $appRoot $nodeRelative))
    $appPrefix = $appRoot.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $node.StartsWith($appPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'The packaged Node path escaped the app directory.' }
    $launchFiles = @($nodeRelative, 'bootstrap/Runtime-Service.mjs', 'bootstrap/runtime-layout.mjs', 'bootstrap/runtime-bootstrap.mjs')
    foreach ($relativePath in $launchFiles) {
        $cursor = $appRoot
        foreach ($part in $relativePath.Split('/')) {
            $cursor = Join-Path $cursor $part
            if (((Get-Item -LiteralPath $cursor).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'A launch file uses an unsupported reparse point inside the package.' }
        }
        $records = @($manifest.files | Where-Object { $_.path -eq $relativePath })
        if ($records.Count -ne 1 -or $records[0].sha256 -notmatch '^[a-f0-9]{64}$' -or
            (Get-Item -LiteralPath $cursor).Length -ne $records[0].bytes -or
            (Get-FileHash -LiteralPath $cursor -Algorithm SHA256).Hash.ToLowerInvariant() -ne $records[0].sha256) { throw 'A packaged runtime launch file failed verification.' }
    }
    $entry = Join-Path $appRoot 'bootstrap\Runtime-Service.mjs'
    $stateRoot = Join-Path (Split-Path -Parent $appRoot) 'data'
    $arguments = @($entry, $Action, '--app', $appRoot)
}
if (-not (Test-Path -LiteralPath $entry -PathType Leaf)) { throw 'The runtime service bootstrap is missing.' }
[IO.Directory]::CreateDirectory((Join-Path $stateRoot 'logs')) | Out-Null
$launchId = [guid]::NewGuid().ToString('N')
$stdout = Join-Path $stateRoot ('logs\bootstrap-' + $launchId + '.stdout.log')
$stderr = Join-Path $stateRoot ('logs\bootstrap-' + $launchId + '.stderr.log')
$quotedArguments = @($arguments | ForEach-Object {
    if ($_ -match '["\x00-\x1f]') { throw 'A runtime launch argument contains an invalid character.' }
    # Windows consumes backslashes before a closing quote in pairs. Preserve
    # directory arguments ending in a separator rather than escaping that quote
    # and accidentally joining the following command options into this value.
    '"' + ($_ -replace '(\\+)$', '$1$1') + '"'
}) -join ' '
$previousNodeOptions = $env:NODE_OPTIONS
$previousNodePath = $env:NODE_PATH
try {
    $env:NODE_OPTIONS = $null
    $env:NODE_PATH = $null
    $worker = Start-Process -FilePath $node -ArgumentList $quotedArguments -WorkingDirectory $appRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
} finally {
    $env:NODE_OPTIONS = $previousNodeOptions
    $env:NODE_PATH = $previousNodePath
}
# Keep the process handle open before a fast check/status command can exit.
# Windows PowerShell may otherwise lose its exit code after WaitForExit.
$null = $worker.Handle
if ($Action -ne 'start') {
    if (-not $worker.WaitForExit(60000)) { Write-Output 'The service command is still completing; inspect its private bootstrap log.'; return }
    $worker.Refresh()
    if ($worker.ExitCode -ne 0) { throw 'The service command could not complete. Inspect its private bootstrap error log.' }
    [IO.File]::ReadAllText($stdout).Trim() | Write-Output
    return
}
$statusPath = Join-Path $stateRoot 'service-status.json'
$deadline = [DateTime]::UtcNow.AddSeconds(45)
do {
    $worker.Refresh()
    $status = $null
    if (Test-Path -LiteralPath $statusPath -PathType Leaf) {
        try { $status = [IO.File]::ReadAllText($statusPath) | ConvertFrom-Json } catch {}
    }
    $currentStatus = $status.supervisorPid -eq $worker.Id
    if ($currentStatus -and $status.state -eq 'ready') { Write-Output 'Conversation runtime is ready.'; return }
    if ($worker.HasExited) {
        if ($worker.ExitCode -eq 0) {
            try {
                $result = [IO.File]::ReadAllText($stdout) | ConvertFrom-Json
                if ($result.existing -eq $true) { Write-Output ('Conversation runtime already has an owner; status: ' + $result.state); return }
            } catch {}
        }
        if ($currentStatus -and $status.state -eq 'setup-required') { Write-Output 'Conversation runtime needs local Convai credentials and a character profile mapping in data/.'; return }
        if ($currentStatus -and $status.state -eq 'game-not-running') { Write-Output 'Launch Cyberpunk before starting its conversation runtime.'; return }
        throw 'Conversation runtime exited during startup. Inspect its private bootstrap error log.'
    }
    Start-Sleep -Milliseconds 200
} while ([DateTime]::UtcNow -lt $deadline)
Write-Output 'Conversation runtime is still preparing. Use the status command to check it.'
