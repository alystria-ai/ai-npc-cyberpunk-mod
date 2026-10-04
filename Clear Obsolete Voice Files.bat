@echo off
rem User-launched cleanup only. Exact reviewed targets; no new backups.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\Clear-ObsoleteHandoffFiles.ps1"
if errorlevel 1 (
  echo Cleanup stopped or some targets could not be removed. See runtime\handoff-cleanup-result-20261005.json if created.
) else (
  echo Cleanup finished. See runtime\handoff-cleanup-result-20261005.json.
)
pause
