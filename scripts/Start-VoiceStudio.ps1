param(
    [string]$ProjectDirectory = (Split-Path -Parent $PSScriptRoot),
    [int]$Port = 3900,
    [string]$ModelDirectory = ''
)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath($ProjectDirectory)
$source = Join-Path $project 'vendor\reference-voicestudio'
$python = Join-Path $source '.venv\Scripts\python.exe'
$backend = Join-Path $source 'backend'
$runtime = Join-Path $project 'runtime'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Prepare the pinned VoiceStudio environment before starting the service.' }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid local service port.' }
$checkpoint = 'k2-fsa/OmniVoice'
if ($ModelDirectory) {
    $checkpoint = [IO.Path]::GetFullPath($ModelDirectory)
    if (-not (Test-Path -LiteralPath (Join-Path $checkpoint 'config.json') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $checkpoint 'model.safetensors') -PathType Leaf) -or
        -not (Test-Path -LiteralPath (Join-Path $checkpoint 'audio_tokenizer') -PathType Container)) {
        throw 'Expected a complete local OmniVoice model directory, including its audio tokenizer.'
    }
}
$owned = Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.Contains($backend) -and $_.CommandLine.Contains('uvicorn')
}
if ($owned) {
    if ($ModelDirectory) { throw 'Stop the existing project VoiceStudio service before starting a different model for comparison.' }
    Write-Output 'The project VoiceStudio service is already running; inspect its launch receipt for the loaded model.'
    return
}
if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) {
    throw "Port $Port is already in use. Choose another local port and update the speech configuration."
}
[IO.Directory]::CreateDirectory($runtime) | Out-Null
$variables = @{
    OMNIVOICE_DATA_DIR = (Join-Path $runtime 'voice-studio-data')
    HF_HOME = (Join-Path $project 'vendor\voice-models')
    OMNIVOICE_PRELOAD_TTS_ASR = '0'
    OMNIVOICE_GPU_WORKERS = '1'
    OMNIVOICE_ASR_BACKEND = 'pytorch-whisper'
    OMNIVOICE_BIND_HOST = '127.0.0.1'
    OMNIVOICE_PORT = [string]$Port
    OMNIVOICE_MODEL = $checkpoint
    PYTHONUTF8 = '1'
}
$previous = @{}
try {
    foreach ($name in $variables.Keys) {
        $previous[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $variables[$name], 'Process')
    }
    $arguments = '-m uvicorn main:app --app-dir "' + $backend + '" --host 127.0.0.1 --port ' + $Port
    $worker = Start-Process -FilePath $python -ArgumentList $arguments -WorkingDirectory $source -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'voice-studio.stdout.log') -RedirectStandardError (Join-Path $runtime 'voice-studio.stderr.log')
    $worker.Id | Set-Content -LiteralPath (Join-Path $runtime 'voice-studio.pid')
    @{pid=$worker.Id; model=$checkpoint; port=$Port; startedAt=[DateTime]::UtcNow.ToString('o')} |
        ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'voice-studio.launch.json') -Encoding UTF8
    Write-Output "Project VoiceStudio service started (PID $($worker.Id)); readiness still needs checking."
} finally {
    foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
}
