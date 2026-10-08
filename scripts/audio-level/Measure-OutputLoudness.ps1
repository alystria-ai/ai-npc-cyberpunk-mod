<#
Development measurement: what the player actually hears.

  -Sessions          list every application audio session on the default
                     output device (process, Windows per-app volume, mute, peak)
  -Seconds N         record N seconds of the output mix (WASAPI loopback) to
                     -Output (WAV, float32) plus a per-application peak CSV,
                     then print loudness of each speech segment (ffmpeg ebur128)
                     labelled by which process was sounding.

Read-only: it never changes a volume, device or game setting.
#>
param(
  [switch]$Sessions,
  [double]$Seconds = 0,
  [string]$Output = (Join-Path $PSScriptRoot '..\..\runtime\audio-level\loopback.wav')
)
$ErrorActionPreference = 'Stop'
if (-not ('CyberpunkConvaiAudio.Loopback' -as [type])) {
  Add-Type -Path (Join-Path $PSScriptRoot 'LoopbackMeter.cs')
}
if ($Sessions) {
  [CyberpunkConvaiAudio.Loopback]::Sessions() | Format-Table Pid, Process, State, Volume, Mute, Peak -AutoSize
}
if ($Seconds -gt 0) {
  $dir = Split-Path -Parent $Output
  New-Item -ItemType Directory -Force $dir | Out-Null
  $csv = [IO.Path]::ChangeExtension($Output, '.sessions.csv')
  Write-Host "Recording $Seconds s of the output mix to $Output"
  $info = [CyberpunkConvaiAudio.Loopback]::Record($Output, $csv, $Seconds)
  Write-Host "Recorded: $info"
  node (Join-Path $PSScriptRoot 'analyze-loopback.mjs') $Output $csv
}
