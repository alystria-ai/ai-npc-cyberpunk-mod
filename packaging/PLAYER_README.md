# Cyberpunk Convai

Talk to Cyberpunk 2077 characters by voice or text, with companions who answer in their own voices.

## What's new in 0.2

- **Alt Cunningham** joins the cast as a companion you can talk to, with her own voice and look.
- **Many more people to talk to**: ordinary NPCs, vendors and faction members talk through character profiles of their own kind, with several voices each, and shopkeepers you return to remember you. The party has no size limit; only characters the mod spawns join it, and named story characters in the world are left alone.
- **Companions sit with you** on couches, benches, chairs and bar stools, and you can look around freely while seated.
- **Body gestures** are rebuilt: calmer, timed to the phrase, with no repeats and no pointing, and every companion has talking gestures and idles.
- **Faces and lip sync**: whole-face emotions, a neutral resting face and a smoother mouth for the local voices.
- **Voices**: Natural speech and Expressive emotions are improved, a Lip sync delay setting helps with Bluetooth audio, and a slow OmniVoice start no longer drops you to the Pocket voice.
- **Conversation**: characters can continue from the game's own dialogue, speak in the first person, remember what you did together and ask you questions. Each character shows the settings in effect for them in the Companion Manager.
- **Talking by voice**: your words show as V's subtitle while you speak, and a recording with no speech says so instead of waiting.
- **Aware of your gear**: companions know what V is wearing and carrying, and mention it only when it matters or you ask.
- **Phone chat**: the first reply arrives in a second or two when you wait a moment after opening a chat.
- **Fewer notices**: you only see when a companion has joined or when something fails.
- **Free option when the daily conversation limit is reached**: choose Mistral as the Conversation provider in Settings > Development (it needs a free Mistral account). Voices keep working through the local voices. A fully local option is coming.

## Requirements

- Cyberpunk 2077 2.31 on Windows 10 or 11 (64-bit)
- Install these from Nexus Mods first: Cyber Engine Tweaks, RED4ext, redscript, Codeware, TweakXL, Audioware and Mod Configuration Menu
- An internet connection while you talk
- About 3 GB of free disk space (about 15 GB more while installing the optional OmniVoice pack, 9 GB once installed)

You do not need to install anything else. The voice service, its voices and models are included and start with the game.

## Install

Close the game, then extract each download into your Cyberpunk 2077 folder (the folder that contains `bin`, `archive` and `r6`). Allow folders to merge.

1. **Scripts**: from Nexus Mods, with Vortex or by hand.
2. **Runtime**: from the Releases page of https://github.com/alystria-ai/cyberpunk-convai. Use the same version number as the Scripts. If it comes in several parts, extract every part.
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

## Licence

Cyberpunk Convai is released under the Cyberpunk Convai Use License (see `LICENSE.txt`): you may use, modify and share it, including commercially, as long as modified versions that offer AI character conversations keep Convai available as a selectable option. You do not have to use Convai. Bundled components keep their own licences (see `THIRD-PARTY-NOTICES.txt`), and Cyberpunk 2077 and its assets belong to their owners.

## Help

Open Settings > Help > Help and support in game. It shows the service status and can create a report to share when asking for help.

Known issue: if V keeps walking in one direction after you type a message, tap that direction (W, A, S or D) once.
