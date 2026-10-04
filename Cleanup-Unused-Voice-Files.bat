@echo off
setlocal
title Cyberpunk Mod - unused data cleanup
if exist "%~dp0runtime\cleanup-retired-20261004\manifest.json" (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Cleanup-Retired-Voice-Experiments.ps1"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Cleanup-Unused-Voice-Files.ps1"
)
echo.
pause
