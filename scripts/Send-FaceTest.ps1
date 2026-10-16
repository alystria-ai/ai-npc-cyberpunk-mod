param(
    [Parameter(Mandatory = $true, Position = 0)][string]$Command,
    [string]$ModDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077\bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod',
    [int]$TimeoutSeconds = 10,
    [int]$TraceLines = 0
)
# Sends one command to the facial visibility probe (mod/face-test.lua, driven by
# mod/facial-playback.lua) and prints its response. Examples:
#   .\Send-FaceTest.ps1 "face-test judy smile 6 writer"
#   .\Send-FaceTest.ps1 "face-test judy smile 6 direct"
#   .\Send-FaceTest.ps1 "face-test judy sweep 20 writer" -TraceLines 12
#   .\Send-FaceTest.ps1 "face-test judy off"
$ErrorActionPreference = 'Stop'
$runtime = Join-Path $ModDirectory 'runtime'
$request = Join-Path $runtime 'face-test-request.txt'
$response = Join-Path $runtime 'face-test-response.txt'
$log = Join-Path $runtime 'face-test.log'
$nonce = 'ft-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
[IO.File]::WriteAllText($request, "$nonce`n$Command", [Text.UTF8Encoding]::new($false))
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $response) {
        $text = [IO.File]::ReadAllText($response)
        if ($text.StartsWith("$nonce`n")) {
            $body = $text.Substring($nonce.Length + 1)
            try { $body | ConvertFrom-Json | ConvertTo-Json -Depth 8 } catch { $body }
            if ($TraceLines -gt 0) {
                Start-Sleep -Seconds 3
                if (Test-Path -LiteralPath $log) { Get-Content -LiteralPath $log -Tail $TraceLines }
            }
            exit 0
        }
    }
    Start-Sleep -Milliseconds 200
}
Write-Error "No response within $TimeoutSeconds s. Is the game unpaused, the mod reloaded with face-test.lua installed, and a companion nearby?"
