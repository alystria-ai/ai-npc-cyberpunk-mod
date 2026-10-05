param([switch]$ListOnly)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'TODO.md'))) {
    throw 'Run only from the Cyberpunk Mod checkout containing the handoff.'
}
# Exact retired targets reviewed on October 5. No wildcard model/data deletion.
# Keep accepted Pocket teacher/student, A initializer, final corpus/payload,
# original cast recordings, current Omni/Pocket environments and all credentials.
$targets = @(
    'runtime\voice-data-expansion-20261005\observable-probes\cp2077-observable-27a5d69c20d84be6\downloaded\probe-results\export-step000001\model.safetensors',
    'runtime\voice-data-expansion-20261005\observable-probes\cp2077-observable-d6bb6c067ab640d9\remote-downloads\runs\probe-d6bb6c067ab640d9\step-000001\export\model.safetensors',
    'runtime\kaggle-pocket-cast-data\pocket-cast-data.zip',
    'runtime\voice-data-expansion-20261004\a-ema500-cloud-input-v1\a-initialization-ce80dd67-8e134a28\payload\a-initialization-1e80dc66f0df.zip',
    'vendor\voxcpm2-runtime',
    'vendor\chatterbox-env',
    'vendor\voice-models\hub\models--openbmb--VoxCPM2',
    'vendor\voice-models\hub\models--ResembleAI--chatterbox-nano',
    'vendor\voice-models\hub\models--ResembleAI--chatterbox-turbo',
    'runtime\voice-comparison\johnny-rt60-vox-bounded\voxcpm2\bounded-model-view',
    'runtime\voice-comparison\vox-bounded-load-probe\bounded-model-view',
    'backups',
    'runtime\install-backups',
    'runtime\research-profile-backups',
    'runtime\loot-probe-install-20260930-000942',
    'runtime\movement-install-20261005-215042',
    'runtime\ui-language-diagnostics.before.lua',
    'runtime\follow-cycle-actuator-before-220531.lua',
    'runtime\blue-moon-probe-before.lua'
)
$resolved = foreach ($relative in $targets) {
    $absolute = [IO.Path]::GetFullPath((Join-Path $projectRoot $relative))
    if (-not $absolute.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Cleanup path escaped checkout: $relative"
    }
    # Reject a junction/symlink in any target ancestor before recursive removal.
    $cursor = $absolute
    while ($cursor -ne $projectRoot) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Cleanup target traverses a reparse point: $relative"
            }
        }
        $cursor = Split-Path -Parent $cursor
    }
    [pscustomobject]@{ Relative = $relative; Absolute = $absolute; Exists = (Test-Path -LiteralPath $absolute) }
}
if ($ListOnly) { $resolved | Select-Object Relative,Exists; return }
$active = Get-CimInstance Win32_Process | Where-Object {
    $_.Name -match '^(python|node)\.exe$' -and $_.CommandLine -and
    ($_.CommandLine.Contains((Join-Path $projectRoot 'bridge\resident-voice-worker.py')) -or
     $_.CommandLine.Contains((Join-Path $projectRoot 'bridge\convai-bridge.mjs')))
}
if ($active) { throw 'Stop the mod reply/voice service before cleanup.' }
$records = @()
foreach ($target in $resolved) {
    if (-not $target.Exists) { continue }
    try {
        if ((Get-Item -LiteralPath $target.Absolute -Force).PSIsContainer) {
            $linkedDirectory = Get-ChildItem -LiteralPath $target.Absolute -Directory -Recurse -Force |
                Where-Object { ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 } |
                Select-Object -First 1
            if ($linkedDirectory) { throw 'Refusing recursive cleanup containing a linked directory.' }
        }
        Remove-Item -LiteralPath $target.Absolute -Recurse -Force -ErrorAction Stop
        $records += [pscustomobject]@{path=$target.Relative;result='removed'}
    } catch {
        $records += [pscustomobject]@{path=$target.Relative;result='failed';error=$_.Exception.Message}
    }
}
$receipt = Join-Path $projectRoot 'runtime\handoff-cleanup-result-20261005.json'
[pscustomobject]@{completedAtUtc=[DateTime]::UtcNow.ToString('o');backupsCreated=$false;targets=$records} |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $receipt -Encoding UTF8
if ($records | Where-Object result -eq 'failed') { exit 1 }
