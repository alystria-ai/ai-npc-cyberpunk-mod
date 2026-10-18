param(
    [string]$Character,
    [ValidateSet('stage', 'status', 'off', 'dismiss', 'where', 'check', 'freeze', 'thaw', 'look', 'unlook')][string]$Action = 'stage',
    [int]$Hold = 60,
    [switch]$NoWait,
    [int]$TimeoutSeconds = 45,
    [string]$ModDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077\bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod'
)
# Development probe (mod/face-test.lua, installed only by the development file list): puts a companion about
# 1.1 m in front of V's camera, facing it, so face captures need no manual framing. Reuses a present copy of the
# character, otherwise creates one through the normal companion spawn path and waits for it. The placement is
# repeated every .1 s for -Hold seconds (default 60, at most 300) and then released.
#   .\Send-FaceStage.ps1 -Character evelyn-parker            # stage (waits until she is in place)
#   .\Send-FaceStage.ps1 -Character panam-palmer -Hold 120
#   .\Send-FaceStage.ps1 -Action status
#   .\Send-FaceStage.ps1 -Action off                         # stop holding
#   .\Send-FaceStage.ps1 -Action dismiss                     # dismiss the copies this probe created, wait until gone
# A capture batch: stage, then Send-FaceTest.ps1 poses + Capture-GameWindow.py, then the next character.
$ErrorActionPreference = 'Stop'
$runtime = Join-Path $ModDirectory 'runtime'
$request = Join-Path $runtime 'face-test-request.txt'
$response = Join-Path $runtime 'face-test-response.txt'

function Send-Command([string]$Command, [int]$Timeout = 10) {
    $nonce = 'fs-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
    [IO.File]::WriteAllText($request, "$nonce`n$Command", [Text.UTF8Encoding]::new($false))
    $deadline = (Get-Date).AddSeconds($Timeout)
    while ((Get-Date) -lt $deadline) {
        if (Test-Path -LiteralPath $response) {
            $text = [IO.File]::ReadAllText($response)
            if ($text.StartsWith("$nonce`n")) { return ($text.Substring($nonce.Length + 1) | ConvertFrom-Json) }
        }
        Start-Sleep -Milliseconds 200
    }
    throw "No response within $Timeout s. Is the game unpaused, the mod reloaded with the face-stage probe installed (face-test.lua), and a world loaded?"
}

switch ($Action) {
    'stage' {
        if (-not $Character) { throw '-Character is required, for example evelyn-parker' }
        $started = Send-Command "face-stage $Character $Hold"
        if (-not $started.ok) { Write-Error ($started.result | Out-String); exit 1 }
        if ($NoWait) { $started | ConvertTo-Json -Depth 6; exit 0 }
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        do {
            Start-Sleep -Milliseconds 1200
            $status = (Send-Command 'face-stage status').result
        } while (($status.state -eq 'spawning' -or $status.state -eq 'clearing') -and (Get-Date) -lt $deadline)
        $status | ConvertTo-Json -Depth 6
        if ($status.state -ne 'staged') { exit 1 }
    }
    'dismiss' {
        $done = (Send-Command 'face-stage dismiss').result
        # Wait until every dismissed copy is really gone, so the next character never stands on the same spot.
        $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
        $left = $done.leaving
        while ($left -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 1200; $left = (Send-Command 'face-stage status').result.leaving }
        $done | Add-Member -NotePropertyName stillThere -NotePropertyValue $left -Force -PassThru | ConvertTo-Json -Depth 6
    }
    default { (Send-Command "face-stage $(if ($Action -eq 'status') { 'status' } else { $Action })").result | ConvertTo-Json -Depth 6 }
}
