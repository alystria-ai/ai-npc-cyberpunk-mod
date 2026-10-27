@echo off
setlocal
title OmniVoice server

rem ============================================================================================
rem   OmniVoice server for the AI NPC Cyberpunk Mod
rem
rem   This PC renders the OmniVoice voices; the PC with the game asks it. Change the values
rem   below with Notepad, save this file, then double-click it. A window opens and stays open
rem   while the server runs. Close the window to stop the server.
rem ============================================================================================

rem   WHO MAY USE THE SERVER
rem     127.0.0.1   only this PC (the safe choice; right when the game is on this same PC)
rem     0.0.0.0     every PC on your home network (use this when the game is on another PC)
rem   There is no password. Only use 0.0.0.0 on a network you trust.
set LISTEN=127.0.0.1

rem   PORT: the door number. Leave it as it is unless another program already uses it.
set PORT=8765

rem   GRAPHICS CARD: 0 is the first card, 1 the second, and so on. To see your cards and their
rem   numbers, double-click "Show graphics cards.cmd". Pick the card that is not busy with a game.
set GPU=0

rem   VOICE QUALITY when the game does not say (it normally does, with its own setting):
rem     16 = fast      32 = best
set QUALITY=16

rem   WHERE THE SERVER FILES ARE
rem     Leave this empty when this folder holds the folders "app" and "voices" (the full server).
rem     If the mod is installed on THIS PC and you only want its OmniVoice on another graphics
rem     card, write the mod's folder here, for example
rem       set MOD_FOLDER=C:\Games\Cyberpunk 2077\red4ext\plugins\AiNpcCyberpunkMod
set MOD_FOLDER=

rem ============================================================================================
rem   Nothing below needs to change.
rem ============================================================================================
if "%MOD_FOLDER%"=="" (set "ROOT=%~dp0.") else (set "ROOT=%MOD_FOLDER%")
if not exist "%ROOT%\app\node\node.exe" goto missing
"%ROOT%\app\node\node.exe" "%ROOT%\app\bridge\omni-server-main.mjs" --root "%ROOT%" --data "%~dp0server-data" --listen %LISTEN% --port %PORT% --gpu %GPU% --quality %QUALITY%
echo.
echo The server stopped. If it did not stop because you closed it, read the message above.
pause
exit /b

:missing
echo.
echo The server files were not found in "%ROOT%".
echo This folder needs the folders "app" and "voices" next to this file, or MOD_FOLDER above
echo must name the mod's folder (the one that holds "app"). See README.txt.
echo.
pause
