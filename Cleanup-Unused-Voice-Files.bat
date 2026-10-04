@echo off
setlocal
title Cyberpunk Mod - unused data cleanup
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Cleanup-Unused-Voice-Files.ps1"
echo.
pause
