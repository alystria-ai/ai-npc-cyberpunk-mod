param(
    [Parameter(Mandatory = $true)][string]$Character,
    [string]$File,
    [string]$Text,
    [string]$Audio,
    [ValidateSet('', 'pocket', 'voxtral', 'inworld')][string]$Engine = '',
    [int]$TimeoutSeconds = 15,
    [string]$ModDirectory = 'E:\SteamLibrary\steamapps\common\Cyberpunk 2077\bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod'
)
# Development only (mod/face-test.lua `speak-line`, installed only by the development file list; Developer mode must be on in the game's
# settings): a companion standing near V speaks an EXACT prepared line through the real reply pipeline, with the language model skipped.
# Voice, lip sync, facial expression and gestures are those of a normal reply; the lip sync is analysed from the audio that plays.
#
# The line is a JSON file {text, audio?, engine?} (bridge/scripted-line.mjs):
#   text    the exact line; tags of the reply pipeline move the face: {joy} {warm} {interest} {surprise} {sadness} {fear} {anger}
#           {disgust} {calm}, {anger:strong} for an outburst; they apply to the words after them. Voice sounds in square brackets
#           ([laugh] [sigh] [breathe]) are voiced by Inworld only.
#   audio   absolute path to a prepared WAV: THAT audio plays (any rate, mixed to mono and resampled to 24 kHz when needed).
#   engine  pocket | voxtral | inworld: synthesize the text live through that voice (ignored when audio is given); with neither the
#           voice chosen in Settings speaks it.
#
#   .\Send-ScriptedLine.ps1 -Character jackie -File C:\...\demo-video\lines\jackie-welcome-inworld.json
#   .\Send-ScriptedLine.ps1 -Character jackie -Text '{joy}Hello V.' -Audio C:\...\takes\jackie-welcome-voxtral.wav
#   .\Send-ScriptedLine.ps1 -Character jackie -Text '{joy}Hello V.' -Engine voxtral
# With -Text the JSON is written next to the request (runtime\scripted-line.json). Stage the character first with Send-FaceStage.ps1.
$ErrorActionPreference = 'Stop'
$runtime = Join-Path $ModDirectory 'runtime'
$request = Join-Path $runtime 'face-test-request.txt'
$response = Join-Path $runtime 'face-test-response.txt'

if (-not $File) {
    if (-not $Text) { throw 'Give -File (a line JSON) or -Text (with -Audio or -Engine).' }
    $line = [ordered]@{ text = $Text }
    if ($Audio) { $line.audio = (Resolve-Path -LiteralPath $Audio).Path }
    if ($Engine) { $line.engine = $Engine }
    $File = Join-Path $runtime 'scripted-line.json'
    [IO.File]::WriteAllText($File, ($line | ConvertTo-Json -Compress), [Text.UTF8Encoding]::new($false))
} else {
    $File = (Resolve-Path -LiteralPath $File).Path
}

$nonce = 'sl-' + [DateTime]::UtcNow.ToString('yyyyMMddHHmmssfff')
[IO.File]::WriteAllText($request, "$nonce`nspeak-line $Character `"$File`"", [Text.UTF8Encoding]::new($false))
$deadline = (Get-Date).AddSeconds($TimeoutSeconds)
while ((Get-Date) -lt $deadline) {
    if (Test-Path -LiteralPath $response) {
        $text = [IO.File]::ReadAllText($response)
        if ($text.StartsWith("$nonce`n")) {
            $reply = $text.Substring($nonce.Length + 1) | ConvertFrom-Json
            $reply | ConvertTo-Json -Depth 6
            if (-not $reply.ok) { exit 1 }
            exit 0
        }
    }
    Start-Sleep -Milliseconds 200
}
throw "No response within $TimeoutSeconds s. Is the game unpaused, Developer mode on, the mod reloaded with face-test.lua installed, and the character nearby?"
