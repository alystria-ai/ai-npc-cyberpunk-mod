param([int]$WaitSeconds = 900)
$ErrorActionPreference = 'Stop'
$taskRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$taskPlan = Join-Path $PSScriptRoot 'floor-first-continuation-plan.json'
$oldControllers = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'python.exe' -and $_.CommandLine -match 'collection[\\/]run_plan\.py' -and
    $_.CommandLine -match 'floor-first-continuation-plan\.json'
})
if ($oldControllers.Count -ne 1) { throw 'Expected one exact owned old collection controller' }
$controllerInfo = $oldControllers[0]
$controller = Get-Process -Id $controllerInfo.ProcessId
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnedCollectionHandoff {
 [DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);
 [DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);
}
'@
$suspended = $false
$retired = $false
try {
    if ([OwnedCollectionHandoff]::NtSuspendProcess($controller.Handle) -ne 0) { throw 'Could not suspend owned controller' }
    $suspended = $true
    # Only the coordinator is suspended. Its current decode child keeps running.
    $children = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($controller.Id)")
    if ($children.Count -gt 1) { throw 'Unexpected child tree; resume without changing ownership' }
    $workerInfo = if ($children.Count) { $children[0] } else { $null }
    $manifestPath = $null
    if ($workerInfo) {
        $expectedWorker = Join-Path $PSScriptRoot 'decode_batch_bulk.py'
        if ($workerInfo.Name -ne 'python.exe' -or -not $workerInfo.CommandLine.Contains($expectedWorker)) {
            throw 'Direct child is not the exact owned decode worker'
        }
        $match = [regex]::Match($workerInfo.CommandLine, '--manifest "([^"]+)"')
        if (-not $match.Success) { throw 'Cannot resolve explicit current batch manifest' }
        $manifestPath = [IO.Path]::GetFullPath($match.Groups[1].Value)
        if (-not $manifestPath.StartsWith((Join-Path $taskRoot 'runtime/voice-data-expansion-20261004'), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Current manifest escapes the source workspace'
        }
        $worker = Get-Process -Id $workerInfo.ProcessId -ErrorAction SilentlyContinue
        @{ phase='draining-current-batch'; controllerPid=$controller.Id; workerPid=$workerInfo.ProcessId; manifest=$manifestPath } | ConvertTo-Json -Compress
        $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
        while ($worker -and -not $worker.HasExited) {
            if ([DateTime]::UtcNow -gt $deadline) { throw 'Drain deadline reached; original controller will resume' }
            [void]$worker.WaitForExit(1000)
        }
    }
    if (-not $manifestPath) {
        $last = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'floor-first-continuation.log') |
            ForEach-Object { try { $_ | ConvertFrom-Json } catch {} } |
            Where-Object phase -eq 'batch-complete' | Select-Object -Last 1
        if (-not $last) { throw 'No child and no completed boundary evidence' }
        $plan = Get-Content -LiteralPath $taskPlan -Raw | ConvertFrom-Json
        foreach ($entry in $plan.batches) {
            $candidatePath = Join-Path $taskRoot $entry.path
            if ((Get-Content -LiteralPath $candidatePath -Raw | ConvertFrom-Json).batch -eq $last.batch) { $manifestPath=$candidatePath; break }
        }
    }
    if (-not $manifestPath) { throw 'No exact completed manifest resolved' }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $receiptPath = Join-Path $PSScriptRoot ('receipts/' + $manifest.batch + '.json')
    $receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    if ($receipt.manifestSha256 -ne (Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash.ToLower() -or
        (@($receipt.completed).Count + @($receipt.errors).Count) -ne @($manifest.candidates).Count) {
        throw 'Batch is not fully accounted for; original controller will resume'
    }
    # The child is gone and its complete receipt is verified. Retire only the
    # suspended coordinator, preventing it from launching a duplicate next job.
    $controller.Kill()
    [void]$controller.WaitForExit(10000)
    $retired = $true
    $handoff = @{ phase='clean-boundary-retired'; oldControllerPid=$controller.Id; completedBatch=$manifest.batch;
        receiptPath=$receiptPath; receiptSha256=(Get-FileHash -LiteralPath $receiptPath -Algorithm SHA256).Hash.ToLower();
        nextWorkerSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'decode_batch_next.py') -Algorithm SHA256).Hash.ToLower();
        nextRunnerSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'run_plan_next.py') -Algorithm SHA256).Hash.ToLower() }
    $handoff | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'controller-handoff.json') -Encoding utf8
    $handoff | ConvertTo-Json -Compress
} finally {
    if ($suspended -and -not $retired -and -not $controller.HasExited) {
        [void][OwnedCollectionHandoff]::NtResumeProcess($controller.Handle)
    }
}
