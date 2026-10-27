@echo off
setlocal
title Graphics cards
rem Lists the NVIDIA graphics cards of this PC with the number to put after GPU= in "Start OmniVoice server.cmd".
rem (The same order as Task Manager > Performance.)
echo Your NVIDIA graphics cards (the number before the colon is the one for GPU=):
echo.
nvidia-smi -L
if errorlevel 1 (
  echo.
  echo The list could not be read. The NVIDIA driver is not installed, or this PC has no NVIDIA card.
  echo The server needs an NVIDIA card.
)
echo.
pause
