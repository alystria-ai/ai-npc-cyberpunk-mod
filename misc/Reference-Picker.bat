@echo off
rem Choose each character's voice-reference clips by ear. Opens http://127.0.0.1:8765/ in your browser.
cd /d "%~dp0.."
node scripts\Reference-Picker.mjs --open %*
echo.
pause
