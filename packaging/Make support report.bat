@echo off
setlocal
chcp 65001 >nul
title AI NPC Cyberpunk Mod - support report
rem Makes a support report with the game closed. Double-click this file, then send the zip it shows you.
rem It uses the Node that comes with the mod; nothing needs to be installed and the game does not need to run.
set "NODE_OPTIONS="
set "NODE_PATH="
set "NODE=%~dp0app\node\node.exe"
set "TOOL=%~dp0app\bridge\make-support-report.mjs"
if not exist "%NODE%" goto missing
if not exist "%TOOL%" goto missing
"%NODE%" "%TOOL%" %*
goto done
:missing
echo Could not find app\node\node.exe or app\bridge\make-support-report.mjs next to this file.
echo Extract the whole Runtime package into your Cyberpunk 2077 folder again, then double-click this file in red4ext\plugins\AiNpcCyberpunkMod.
:done
echo.
pause
