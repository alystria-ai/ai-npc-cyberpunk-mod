# Cyberpunk Convai

Talk to Cyberpunk 2077 characters by voice or text, with companions who answer in their own voices.

## Requirements

- Cyberpunk 2077 2.31 on Windows 10 or 11 (64-bit)
- Install these from Nexus Mods first: Cyber Engine Tweaks, RED4ext, redscript, Codeware, TweakXL, Audioware and Mod Configuration Menu
- An internet connection while you talk
- About 3 GB of free disk space (about 15 GB more while installing the optional OmniVoice pack, 9 GB once installed)

You do not need to install anything else. The voice service, its voices and models are included and start with the game.

## Install

Close the game, then extract each download into your Cyberpunk 2077 folder (the folder that contains `bin`, `archive` and `r6`). Allow folders to merge.

1. **Scripts**: from Nexus Mods, with Vortex or by hand.
2. **Runtime**: from https://github.com/alystria-ai/cyberpunk-convai-releases/releases. Use the same version number as the Scripts. If it comes in several parts, extract every part.
3. **OmniVoice pack (optional)**: a higher-quality voice for NVIDIA graphics cards with at least 8 GB of video memory and a current driver. Download every part from the same release page and extract them all. Then choose an OmniVoice option in Settings > Voices.

Start the game. The first start after installing takes a little longer while the voice service prepares itself.

If Windows reports an error while extracting, use 7-Zip (https://www.7-zip.org) instead of the built-in extractor.

## Update

Close the game and extract the new Scripts and Runtime (and OmniVoice pack, if you use it) over the old ones. Your conversations, memories and settings are kept.

## Uninstall

Delete these folders from your Cyberpunk 2077 folder:

- `bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai` (this also deletes your conversations and settings)
- `red4ext\plugins\CyberpunkConvai`
- `r6\scripts\CyberpunkConvai` and `r6\audioware\CyberpunkConvai`
- `archive\pc\mod\convai_facial.archive`, `convai_gestures.archive` and `cyberpunk_convai_ambient_driver_guard.archive`

## Help

Open Settings > Help > Help and support in game. It shows the service status and can create a report to share when asking for help.
