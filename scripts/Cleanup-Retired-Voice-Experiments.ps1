param([switch]$ListOnly)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$manifestPath = Join-Path $project 'runtime\cleanup-retired-20261004\manifest.json'
if ((Get-FileHash -LiteralPath $manifestPath -Algorithm SHA256).Hash -ne '3BC2BF4C3167168E7146E471C688875F63BE954250A85FB9BDC9CF9D9F6DDB71') {
    throw 'The reviewed cleanup manifest changed.'
}
$plan = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($plan.workspace_root -ne $project -or $plan.selected_file_count -ne 406) {
    throw 'This retirement manifest belongs to a different project or selection.'
}
$prefix = (Join-Path $project 'runtime').TrimEnd('\') + '\'
foreach ($retained in $plan.protected_files_verified) {
    if (-not (Test-Path -LiteralPath (Join-Path $project $retained) -PathType Leaf)) {
        throw "Protected source archive missing: $retained"
    }
}
foreach ($retained in @(
    'runtime\kaggle-pocket-teacher-improve-retry-output\teacher-improve-results\teacher\export\model.safetensors',
    'runtime\kaggle-pocket-student-transfer-ddb133ba-output\student-transfer-results\distill\export\model.safetensors',
    'runtime\voice-data-expansion-20261004\a-ema500-initialization-v1\export\model.safetensors'
)) {
    if (-not (Test-Path -LiteralPath (Join-Path $project $retained) -PathType Leaf)) {
        throw "Current model dependency missing: $retained"
    }
}
$targets = @()
foreach ($entry in $plan.entries) {
    if (-not (Test-Path -LiteralPath $entry.absolute_path)) { continue }
    $path = (Resolve-Path -LiteralPath $entry.absolute_path).ProviderPath
    if (-not $path.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or
        $path -ne [IO.Path]::GetFullPath((Join-Path $project $entry.relative_path))) {
        throw "Target escapes the verified selection: $path"
    }
    $item = Get-Item -LiteralPath $path -Force
    if ($item.PSIsContainer -or $item.Length -ne $entry.bytes) { throw "Target changed: $path" }
    $ancestor = $item
    while ($ancestor.FullName -ne $project) {
        if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Linked target is excluded: $($ancestor.FullName)"
        }
        $ancestor = if ($ancestor -is [IO.DirectoryInfo]) {$ancestor.Parent} else {$ancestor.Directory}
        if ($null -eq $ancestor) { throw 'Invalid target ancestry.' }
    }
    $targets += $entry
}
$total = [long](($targets | Measure-Object bytes -Sum).Sum)
Write-Host 'Retired experiment files selected for removal:'
foreach ($group in $targets | Group-Object group) {
    $size = ($group.Group | Measure-Object bytes -Sum).Sum
    Write-Host ('{0:N2} GiB  {1} ({2} files)' -f ($size / 1GB), $group.Name, $group.Count)
}
Write-Host ('Total: {0:N2} GiB / {1:N2} GB. Current training inputs, accepted models and original audio remain.' -f ($total / 1GB), ($total / 1e9))
if ($ListOnly -or $targets.Count -eq 0) { return }
$launchPath = Join-Path $project 'runtime\voice-studio.launch.json'
if (Test-Path -LiteralPath $launchPath) {
    $launch = Get-Content -LiteralPath $launchPath -Raw | ConvertFrom-Json
    if ($launch.model -like '*voice-training*merged-checkpoint-100*') {
        if (Get-Process -Id $launch.pid -ErrorAction SilentlyContinue) {
            throw 'The recorded VoiceStudio process is alive. Close it before cleanup.'
        }
    } else {
        $launchPath = $null
    }
}
$answer = Read-Host 'Delete these verified retired files? Type YES to continue'
if ($answer -cne 'YES') { Write-Host 'Nothing deleted.'; return }
if ($launchPath -and (Test-Path -LiteralPath $launchPath)) { Remove-Item -LiteralPath $launchPath }
$log = Join-Path $project 'runtime\cleanup-retired-20261004\manual-result.json'
$done = @()
try {
    foreach ($entry in $targets) {
        Remove-Item -LiteralPath $entry.absolute_path -Force
        $done += $entry.relative_path
    }
} finally {
    @{completed_at_utc=[DateTime]::UtcNow.ToString('o'); deleted_files=$done;
      selected_bytes=$total; free_gib=[math]::Round((Get-PSDrive C).Free / 1GB, 2)} |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $log -Encoding UTF8
}
Write-Host ('Cleanup complete. Free space on C: {0:N2} GiB' -f ((Get-PSDrive C).Free / 1GB))
Write-Host 'Some historical experiment commands now need their models or caches restored before replay.'
