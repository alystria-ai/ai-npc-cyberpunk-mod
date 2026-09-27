param(
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
    [string]$KeyFile
)

$ErrorActionPreference = 'Stop'
if (-not $KeyFile) { $KeyFile = Join-Path $ProjectDirectory 'runtime\convai-key.txt' }
$line = (Get-Content -LiteralPath $KeyFile -Raw).Trim()
if ($line -notmatch '^api-key\s*=\s*(\S+)\s*$') { throw 'Expected one api-key=... line in the local key file.' }
$headers = @{ 'CONVAI-API-KEY' = $Matches[1] }
$roster = Get-Content -LiteralPath (Join-Path $ProjectDirectory 'characters\roster.json') -Raw | ConvertFrom-Json -AsHashtable
$runtime = Join-Path $ProjectDirectory 'runtime'
[IO.Directory]::CreateDirectory($runtime) | Out-Null
$mappingPath = Join-Path $runtime 'characters.json'
$verifiedPath = Join-Path $runtime 'characters-verified.json'
$mapping = if (Test-Path -LiteralPath $mappingPath) {
    Get-Content -LiteralPath $mappingPath -Raw | ConvertFrom-Json -AsHashtable
} else { @{} }
$verified = if (Test-Path -LiteralPath $verifiedPath) {
    Get-Content -LiteralPath $verifiedPath -Raw | ConvertFrom-Json -AsHashtable
} else { @{} }

function Get-ProfileHash([hashtable]$Character) {
    $payload = $Character | ConvertTo-Json -Depth 8 -Compress
    $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToHexString($sha.ComputeHash($bytes)) }
    finally { $sha.Dispose() }
}

function Invoke-Convai([string]$Endpoint, [hashtable]$Body) {
    $response = $null
    for ($attempt = 0; $attempt -lt 7; $attempt++) {
        try {
            $response = Invoke-RestMethod -Uri ('https://api.convai.com' + $Endpoint) -Method Post `
                -Headers $headers -ContentType 'application/json' -Body ($Body | ConvertTo-Json -Depth 8 -Compress)
            break
        } catch {
            if ($_.ErrorDetails.Message -notmatch 'request limit per minute' -or $attempt -ge 6) { throw }
            Write-Host 'Convai rate limit reached; retrying shortly.'
            Start-Sleep -Seconds 15
        }
    }
    if ($response -is [string]) { return $response | ConvertFrom-Json -AsHashtable }
    return $response
}

foreach ($character in $roster) {
    $key = $character.key
    $id = $mapping[$key]
    $hash = Get-ProfileHash $character
    if ($id -and $verified[$key] -eq $hash) {
        Write-Output "Already verified ${key}: $id"
        continue
    }
    if (-not $id) {
        $created = Invoke-Convai '/character/create' @{
            charName = $character.name
            voiceType = $character.voice
            backstory = $character.backstory
            model_group_name = $character.model
        }
        $id = $created.charID
        if (-not $id) { throw "Character create did not return an ID for $key." }
        $mapping[$key] = $id
        $mapping | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $mappingPath -Encoding utf8
        Write-Output "Created ${key}: $id"
    } else {
        Write-Output "Using existing ${key}: $id"
    }

    $updated = Invoke-Convai '/character/update' @{
        charID = $id
        charName = $character.name
        voiceType = $character.voice
        backstory = $character.backstory
        model_group_name = $character.model
    }
    if ($updated.STATUS -ne 'SUCCESS') { throw "Character update failed for $key." }
    $actual = Invoke-Convai '/character/get' @{ charID = $id }
    if ($actual.character_id -ne $id -or $actual.character_name -ne $character.name -or $actual.voice_type -ne $character.voice) {
        throw "Character readback did not match for $key."
    }
    $verified[$key] = $hash
    $verified | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $verifiedPath -Encoding utf8
    Write-Output "Verified ${key}: name and Kokoro voice"
}

Write-Output "Provisioned character IDs saved to $mappingPath"
