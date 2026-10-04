param([switch]$ListOnly)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$prefix = $project.TrimEnd('\') + '\'

# Only six independently verified, regenerable data copies and retired compiler
# caches are eligible. Current training data, models, source audio and logs stay.
$relative = @(
    'runtime\voice-data-expansion-20261003\training-plan\corrected-mount-v1\real-fixture\from-zip\data',
    'runtime\voice-data-expansion-20261003\training-plan\corrected-mount-v1\real-fixture\from-extracted\data',
    'runtime\voice-data-expansion-20261003\training-plan\corrected-mount-v1\real-fixture-final-v1\from-zip\data',
    'runtime\voice-data-expansion-20261003\training-plan\corrected-mount-v1\real-fixture-final-v1\from-extracted\data',
    'runtime\voice-data-expansion-20261003\training-plan\compact-input-v1\full-corpus-stage\payload\data\audio',
    'runtime\voice-data-expansion-20261003\training-plan\compact-input-v1\full-corpus-stage\payload\data\new-audio'
)
$vendor = Join-Path $project 'vendor'
$compilerRunning = @(Get-Process -Name 'scc','redscript' -ErrorAction SilentlyContinue).Count -gt 0
if (-not $compilerRunning) {
    foreach ($parent in @($vendor, (Join-Path $vendor 'unused-compiler-checks'))) {
        if (Test-Path -LiteralPath $parent) {
            foreach ($dir in Get-ChildItem -LiteralPath $parent -Directory) {
                if ($dir.Name -match '^compiler-check-[a-f0-9]{32}$') {
                    $relative += (Join-Path $dir.FullName 'r6\cache').Substring($prefix.Length)
                }
            }
        }
    }
}
$targets = @()
foreach ($rel in $relative) {
    $candidate = Join-Path $project $rel
    if (-not (Test-Path -LiteralPath $candidate)) { continue }
    $resolved = (Resolve-Path -LiteralPath $candidate).ProviderPath
    if (-not $resolved.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Cleanup target escapes this project: $resolved"
    }
    $ancestor = Get-Item -LiteralPath $resolved -Force
    while ($ancestor.FullName -ne $project) {
        if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Linked directory is excluded: $($ancestor.FullName)"
        }
        $ancestor = $ancestor.Parent
        if ($null -eq $ancestor) { throw 'Invalid cleanup ancestry' }
    }
    $children = @(Get-ChildItem -LiteralPath $resolved -Recurse -Force)
    if ($children | Where-Object {($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0}) {
        throw "Linked member is excluded: $resolved"
    }
    $bytes = ($children | Where-Object {-not $_.PSIsContainer} | Measure-Object Length -Sum).Sum
    $targets += [PSCustomObject]@{Path=$resolved; Bytes=[long]$bytes}
}
Write-Host 'Verified temporary data and retired compiler caches:'
foreach ($target in $targets) {
    Write-Host ('{0:N2} GiB  {1}' -f ($target.Bytes / 1GB), $target.Path.Substring($prefix.Length))
}
$total = [long](($targets | Measure-Object Bytes -Sum).Sum)
Write-Host ('Estimated space to reclaim: {0:N2} GiB' -f ($total / 1GB))
if ($ListOnly -or $targets.Count -eq 0) { return }

# Confirm retained source archives before removing old generated data copies.
$descriptorPath = Join-Path $project 'runtime\voice-data-expansion-20261003\training-plan\corrected-mount-v1\descriptors.json'
$descriptors = Get-Content -LiteralPath $descriptorPath -Raw | ConvertFrom-Json
foreach ($prop in $descriptors.PSObject.Properties) {
    $archive = $prop.Value.local_archive
    if (-not (Test-Path -LiteralPath $archive -PathType Leaf)) { throw "Retained archive missing: $archive" }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower() -ne $prop.Value.archive_sha256) {
        throw "Retained archive differs: $archive"
    }
}
$processes = @(Get-CimInstance Win32_Process | Where-Object {$_.ProcessId -ne $PID})
foreach ($target in $targets) {
    if ($processes | Where-Object {$_.CommandLine -and $_.CommandLine.IndexOf($target.Path, [StringComparison]::OrdinalIgnoreCase) -ge 0}) {
        throw "A running process uses this target: $($target.Path)"
    }
}
$answer = Read-Host 'Delete only the folders listed above? Type YES to continue'
if ($answer -cne 'YES') { Write-Host 'Nothing deleted.'; return }
$log = Join-Path $project ('runtime\manual-cleanup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')
$targets | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $log -Encoding UTF8
foreach ($target in $targets) {
    Remove-Item -LiteralPath $target.Path -Recurse -Force
}
Write-Host ('Cleanup complete. Removed {0:N2} GiB of temporary files.' -f ($total / 1GB))
Write-Host ('Free space on C: {0:N2} GiB' -f ((Get-PSDrive C).Free / 1GB))
Write-Host "Cleanup record: $log"
