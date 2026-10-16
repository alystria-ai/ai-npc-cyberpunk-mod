param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Command,
    [string]$ModDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077\bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod',
    [int]$TimeoutSeconds = 10,
    [int]$TraceLines = 0
)
# Sends one command to the Stage 0 gesture probe (mod/gesture-probe.lua) and
# prints its response. The game must be running with the probe installed and
# at least one companion in the party; the probe polls every 0.25 s of play.
$ErrorActionPreference = 'Stop'
$runtime = Join-Path $ModDirectory 'runtime'
$request = Join-Path $runtime 'gesture-probe-request.txt'
$response = Join-Path $runtime 'gesture-probe-response.txt'
$log = Join-Path $runtime 'gesture-probe.log'
$nonce = 'gp-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
[IO.File]::WriteAllText($request, "$nonce`n$Command", [Text.UTF8Encoding]::new($false))
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $response) {
        $text = [IO.File]::ReadAllText($response)
        if ($text.StartsWith("$nonce`n")) {
            $body = $text.Substring($nonce.Length + 1)
            try { $body | ConvertFrom-Json | ConvertTo-Json -Depth 8 } catch { $body }
            if ($TraceLines -gt 0 -and (Test-Path -LiteralPath $log)) { Get-Content -LiteralPath $log -Tail $TraceLines }
            exit 0
        }
    }
    Start-Sleep -Milliseconds 200
}
Write-Error "No probe response within $TimeoutSeconds s. Is the game unpaused, with the probe installed and a companion spawned?"
