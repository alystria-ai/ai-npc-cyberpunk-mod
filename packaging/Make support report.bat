@echo off
rem Delayed expansion stays off even where the registry turns it on, so a "!" in the game folder's path is kept as it is.
setlocal EnableExtensions DisableDelayedExpansion
chcp 65001 >nul
title AI NPC Cyberpunk Mod - support report
rem Makes a support report with the game closed. Double-click this file, then send the zip it shows you.
rem It uses the Node that comes with the mod; nothing needs to be installed and the game does not need to run.
rem Exit code: 0 when the report was made, else 1 (also when the bundled Node or the report code is missing).
set "NODE_OPTIONS="
set "NODE_PATH="
set "NODE=%~dp0app\node\node.exe"
set "TOOL=%~dp0app\bridge\make-support-report.mjs"
set "CODE=1"
if not exist "%NODE%" goto missing
if not exist "%TOOL%" goto missing
"%NODE%" "%TOOL%" %*
set "CODE=%ERRORLEVEL%"
goto done
:missing
echo Could not find app\node\node.exe or app\bridge\make-support-report.mjs next to this file.
echo Extract the whole Runtime package into your Cyberpunk 2077 folder again, then double-click this file in red4ext\plugins\AiNpcCyberpunkMod.
:done
echo.
pause
exit /b %CODE%
