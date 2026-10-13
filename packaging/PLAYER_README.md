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
- **Free option when the daily conversation limit is reached**: choose Mistral as the Conversation provider in Settings > Development (it needs a free Mistral account). Voices keep working through the local voices. The optional Local AI packs (see Local AI below) work without any account.
- **Local AI**: two optional downloads let the characters answer with an AI model that runs on your own graphics card, with no account and no internet connection.
- **Smoother game**: the Runtime download includes a small RED4ext plugin that takes some of the mod's work off the game's script thread. If it cannot load, the mod runs from its scripts as before.

## Requirements

- Cyberpunk 2077 2.31 on Windows 10 or 11 (64-bit)
- Install these from Nexus Mods first: Cyber Engine Tweaks, RED4ext, redscript, Codeware, TweakXL, Audioware and Mod Configuration Menu
- An internet connection while you talk
- About 3 GB of free disk space (about 15 GB more while installing the optional OmniVoice pack, 9 GB once installed)
- Optional Local AI packs: about 5.3 GB for standard and about 1.5 GB for lite (about 11 GB free while installing the standard one)

RED4ext is needed because it starts the voice service with the game and loads the plugin that comes with the Runtime download.

You do not need to install anything else. The voice service, its voices and models are included and start with the game.

## Install

Close the game, then extract each download into your Cyberpunk 2077 folder (the folder that contains `bin`, `archive` and `r6`). Allow folders to merge.

1. **Scripts**: from Nexus Mods, with Vortex or by hand.
2. **Runtime**: from the Releases page of https://github.com/alystria-ai/cyberpunk-convai. Use the same version number as the Scripts. If it comes in several parts, extract every part.
3. **OmniVoice pack (optional)**: a higher-quality voice for NVIDIA graphics cards with at least 8 GB of video memory and a current driver. Download every part from the same release page and extract them all. Then choose an OmniVoice option in Settings > Voices.

4. **Local AI packs (optional)**: let the characters answer with an AI model that runs on your own graphics card, with no account and no internet connection. There are two, and you can install neither, one or both: **Local AI standard** (Gemma 4 E4B, about 5.3 GB, in several parts) for the best replies, and **Local AI lite** (Qwen3.5-2B, about 1.5 GB) for smaller graphics cards. Download every part from the same release page and extract them all. Then choose Local as the Conversation provider in Settings > Development. See "Local AI" below to pick a combination.

Start the game. The first start after installing takes a little longer while the voice service prepares itself. After the standard Local AI pack, the first start also joins the downloaded parts into one file, which takes about a minute; Settings > Development shows "Not installed" until that is done.

If Windows reports an error while extracting, use 7-Zip (https://www.7-zip.org) instead of the built-in extractor.

## Local AI

Convai free tier works out of the box with no setup and gives better quality responses. Local AI is for playing without an account or without the internet. It needs a separate graphics card that supports Vulkan (NVIDIA or AMD), at least 16 GB of system memory (32 GB is better) and about 5 GB more than usual while it runs. The first start after installing takes about a minute while your graphics card prepares the model; Settings > Development shows "Warming up" and then "Ready". The model is unloaded after ten minutes without a conversation.

**Your own model (advanced, optional).** You can add a chat model of your own: put its `.gguf` file in a `custom` folder inside the Local AI folder (`red4ext\plugins\CyberpunkConvai\app\local-ai\`), list it in a small `manifest.custom.json` next to the other manifests, and it appears in the **Local AI model** row marked "(custom)". Auto only uses it if you set `"auto": true`. It must be a GGUF instruct or chat model that llama.cpp supports (Q4_K_M is a good choice), and it needs about its file size plus 1 GB of free graphics memory; one too large for your card is shown as such and never used. If it does not show up, the reason is in `bridge.stderr.log` (in the mod's `data` folder), on lines with `[custom models]`. The full steps and an example are in `docs/LOCAL_AI.md`, "Add your own model".

If your graphics card is short of memory the mod steps down by itself and keeps your voice before it keeps the model: the standard model gives way to the lite model, and if the lite model does not fit either, the text comes from Mistral or Convai, with one notice. Your voice only changes as a last resort. The standard model checks that about 6 GB of video memory is free when it starts; with less, the lite model is used.

Extra video memory each combination needs on top of what the game itself uses. These are estimates from one 12 GB card; the game's own use depends on your settings, and ray tracing and high textures use the most.

| Voice | Text | Extra video memory |
|---|---|---|
| Pocket | Convai or Mistral | none |
| Pocket | Local AI lite | about 1.5 GB |
| Pocket | Local AI standard | about 3 GB |
| OmniVoice | Convai or Mistral | about 2 GB |
| OmniVoice | Local AI lite | about 4 GB |
| OmniVoice | Local AI standard | about 5 GB |

Which combination fits your card. Lower settings means medium textures and no ray tracing; higher settings means high textures or ray tracing.

| Your graphics card | What fits | When it is short |
|---|---|---|
| 6 GB | Pocket with Convai or Mistral. Local AI lite only on lower settings. | The text moves to Mistral or Convai; the voice stays Pocket. |
| 8 GB | Pocket with Local AI lite, or OmniVoice with Convai or Mistral, both on lower settings. | The lite model gives way to Mistral or Convai text; OmniVoice stays if you chose it. |
| 12 GB | OmniVoice with Local AI lite on any settings. Pocket with Local AI standard on lower settings. | Standard becomes lite, lite becomes Mistral or Convai text; the voice stays. |
| 16 GB | OmniVoice with Local AI standard on lower settings, with Local AI lite on higher settings. | Standard becomes lite, lite becomes Mistral or Convai text; the voice stays. |

## Update

Close the game and extract the new Scripts and Runtime (and OmniVoice pack, if you use it) over the old ones. Your conversations, memories and settings are kept.

## Uninstall

Delete these folders from your Cyberpunk 2077 folder:

- `bin\x64\plugins\cyber_engine_tweaks\mods\CyberpunkConvai` (this also deletes your conversations and settings)
- `red4ext\plugins\CyberpunkConvai` (this also removes the OmniVoice and Local AI packs)
- `red4ext\plugins\CyberpunkConvaiNative`
- `r6\scripts\CyberpunkConvai` and `r6\audioware\CyberpunkConvai`
- `archive\pc\mod\convai_facial.archive`, `convai_gestures.archive` and `cyberpunk_convai_ambient_driver_guard.archive`

## Licence

Cyberpunk Convai is released under the Cyberpunk Convai Use License (see `LICENSE.txt`): you may use, modify and share it, including commercially, as long as modified versions that offer AI character conversations keep Convai available as a selectable option. You do not have to use Convai. Bundled components keep their own licences (see `THIRD-PARTY-NOTICES.txt`), and Cyberpunk 2077 and its assets belong to their owners.

## Help

Open Settings > Help > Help and support in game. It shows the service status and can create a report to share when asking for help.

Known issue: if V keeps walking in one direction after you type a message, tap that direction (W, A, S or D) once.
