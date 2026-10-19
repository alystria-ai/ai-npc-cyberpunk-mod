# AI NPC Cyberpunk Mod

Talk to Cyberpunk 2077 characters by voice or text, with companions who answer in their own voices.

## What's new in 0.2

- **Three ways to talk, all free**: fully local on your own PC with Local AI (no account, no internet, no limit), Mistral with a free account (about 5,000 turns a day), or the Convai free tier (no setup, the default, 100 turns a day). Choose in Settings > Conversation provider.
- **Holocalls**: call a character from the phone's Chat tab and they pick up live on screen.
- **Voxtral voices**: the same free Mistral account gives every character their own voice made in the cloud, so nothing runs on your PC. The default Pocket TTS voices still run on your processor with no setup.
- **V speaks too**: lines you type are heard in V's own voice before the reply (Settings > Voices). Pick V's voice engine there: Pocket (default, runs on your processor) or Voxtral (cloud).
- **Voice volume**: one slider from 50 to 200 percent for every mod voice.
- **Hold to talk**: hold the talk-by-voice button while you speak and let go, or tap to start and tap again to send. Your words show as V's subtitle while you speak.
- **Companions see Night City**: with Convai, companions can talk about what is around you. The picture of the game window is taken only while someone you can talk to is near and is never saved.
- **Sign in with Convai** connects your own Convai account in a few clicks.
- **Alt Cunningham** joins the cast as a companion you can talk to, with her own voice and look.
- **Many more people to talk to**: ordinary NPCs, vendors and faction members talk through character profiles of their own kind, with several voices each, and shopkeepers you return to remember you. The party has no size limit; only characters the mod spawns join it. The game's own story characters, such as Judy or Jackie, answer where they stand in their own voice, and their face follows what they say, once you turn it on (Settings > Conversations > Talk to story characters, off by default; reload your save after switching it); nothing else about them changes.
- **Companions sit with you** on couches, benches, chairs and bar stools, and you can look around freely while seated.
- **Body and face**: calmer talking gestures timed to the phrase, varied idles with props (a cigarette, a cup, a pair of shades) that ease in and out, whole-face emotions and a smoother mouth.
- **Conversation**: characters can continue from the game's own dialogue, speak in the first person, remember what you did together, ask you questions and know what V is wearing and carrying.
- **Phone chat**: the first reply arrives in a second or two when you wait a moment after opening a chat.
- **Fewer notices**: you only see when a companion has joined or when something fails.
- **Smoother game**: the Runtime download includes a small RED4ext plugin that takes some of the mod's work off the game's script thread. If it cannot load, the mod runs from its scripts as before.

## Requirements

- Cyberpunk 2077 2.31 on Windows 10 or 11 (64-bit)
- Install these from Nexus Mods first: Cyber Engine Tweaks, RED4ext, redscript, Codeware, TweakXL, Audioware and Mod Configuration Menu
- An internet connection while you talk with Convai, Mistral or the Voxtral voice (Local AI with a local voice needs none)
- About 3 GB of free disk space (about 15 GB more while installing the optional OmniVoice pack, 9 GB once installed)
- Optional Local AI packs: about 5.3 GB for standard and about 1.4 GB for lite (about 11 GB free while installing the standard one, which counts the downloaded zip)

RED4ext is needed because it starts the voice service with the game and loads the plugin that comes with the Runtime download.

You do not need to install anything else. The voice service, its voices and models are included and start with the game.

## Install

Close the game, then extract each download into your Cyberpunk 2077 folder (the folder that contains `bin`, `archive` and `r6`). Allow folders to merge.

1. **Scripts**: from Nexus Mods, with Vortex or by hand.
2. **Runtime**: https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/0.2.1/AI-NPC-Cyberpunk-Mod-Runtime-0.2.1.zip (the mod's Hugging Face page, 0.2.1 folder). Use the same version number as the Scripts.

The optional packs are on the same Hugging Face page, https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs, in a folder per version. Each pack is one zip file, so there is nothing to join, and each works on its own. Use the same version number as the Scripts and Runtime.

3. **OmniVoice pack (optional)**: a higher-quality voice for NVIDIA graphics cards with at least 8 GB of video memory and a current driver. Download https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/0.2.1/AI-NPC-Cyberpunk-Mod-OmniPack-0.2.1.zip and extract it. Then choose an OmniVoice option in Settings > Voices.

4. **Local AI packs (optional)**: let the characters answer with an AI model that runs on your own graphics card, with no account and no internet connection. There are two, and you can install neither, one or both: **Local AI standard** (Gemma 4 E4B, about 5.3 GB, needs about 6 GB of free video memory) for the best replies, and **Local AI lite** (Bonsai 2 4B, about 1.4 GB, needs about 2 GB of free video memory) for smaller graphics cards. Download https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/0.2.1/AI-NPC-Cyberpunk-Mod-LocalAI-Standard-0.2.1.zip and https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/blob/main/0.2.1/AI-NPC-Cyberpunk-Mod-LocalAI-Lite-0.2.1.zip (one or both) and extract each. Each pack includes the engine and the memory model it needs, so one alone is enough. Then choose Local as the Conversation provider in Settings > Conversation provider. See "Local AI" below to pick a combination.

Start the game. The first start after installing takes a little longer while the voice service prepares itself.

If Windows reports an error while extracting, use 7-Zip (https://www.7-zip.org) instead of the built-in extractor.

## Local AI

Convai free tier works out of the box with no setup and gives better quality responses. Local AI is for playing without an account or without the internet. It needs a separate graphics card that supports Vulkan (NVIDIA or AMD), at least 16 GB of system memory (32 GB is better) and about 5 GB more than usual while it runs. The first start after installing takes about a minute while your graphics card prepares the model; the Local AI model row in Settings > Conversation provider shows "Warming up" and then "Ready". The model is unloaded after ten minutes without a conversation.

**Your own model (advanced, optional).** You can add a chat model of your own: put its `.gguf` file in a `custom` folder inside the Local AI folder (`red4ext\plugins\AiNpcCyberpunkMod\app\local-ai\`), list it in a small `manifest.custom.json` next to the other manifests, and it appears in the **Local AI model** row marked "(custom)". It is listed with the others from the smallest model to the largest and takes part in the default choice by its size. It must be a GGUF instruct or chat model that llama.cpp supports (Q4_K_M is a good choice), and it needs about its file size plus 1 GB of free graphics memory; one too large for your card is shown as such and never used. If it does not show up, the reason is in `bridge.stderr.log` (in `%LOCALAPPDATA%\AiNpcCyberpunkMod\data`; paste that into the Explorer address bar), on lines with `[custom models]`. The full steps and an example are in `docs/LOCAL_AI.md`, "Add your own model".

If your graphics card is short of memory the mod steps down by itself and keeps your voice before it keeps the model: the standard model gives way to the lite model, and if the lite model does not fit either, the text comes from Mistral or Convai, with one notice. Your voice only changes as a last resort. The standard model checks that about 6 GB of video memory is free when it starts; with less, the lite model is used.

## Choosing a setup

Every voice sounds like the character, Pocket and Voxtral included, so pick by what matters to you:

- **Least effect on your frames:** go all cloud. Convai or Mistral for the text, Voxtral or Convai's voice for the speech. Nothing runs on your PC. The default (Convai with the Pocket voice) is nearly as light.
- **Fastest replies:** Mistral for the text with Pocket for the voice. Pocket starts speaking in a fraction of a second.
- **Fully local, best replies:** Local AI standard, with Pocket for the voice (or OmniVoice on an NVIDIA graphics card).
- **Fully local, lightweight:** Local AI lite with Pocket.
- **Extra expression:** OmniVoice can laugh and sigh, and Natural speech adds pauses and hesitations. OmniVoice is the heaviest voice and starts speaking a little later.

Set Windows power mode to Balanced or Performance and plug a laptop in: it is the biggest single factor for reply speed.

Extra video memory each setup uses on top of the game's own:

| Voice | Text | Extra video memory |
|---|---|---|
| Voxtral | Convai or Mistral | none |
| Pocket | Convai or Mistral | none |
| Pocket | Local AI lite | about 1.8 GB |
| Pocket | Local AI standard | about 3 GB |
| OmniVoice | Convai or Mistral | about 2 GB |
| OmniVoice | Local AI lite | about 4 GB |
| OmniVoice | Local AI standard | about 5 GB |

## Your own characters

With Mistral or Local AI as the Conversation provider, you can give a person who has no profile in the mod (a character spawned by another mod, such as a Night City Allies follower) a name, a bio, a way of speaking and memories. Face the character, open Settings > Edit characters > Open, and choose **New character** in the page that opens in your browser. **Use the character I'm facing** fills in how the game recognises them (their record name or the name the game shows); you can also type those in. Add a gender and a bio, and Save. From the next talk key press they answer as the person you wrote. An optional voice clip (10 to 18 seconds of clean speech in a WAV file, with the words typed out) gives them a voice of their own from the next time the game starts; until then, and without a clip, they speak with a generic voice of their gender. With Convai they talk as an ordinary person, and the game says so once. Characters, clips and what they remember stay on your PC, in `%LOCALAPPDATA%\AiNpcCyberpunkMod\data`.

## Update

Close the game and extract the new Scripts and Runtime (and any optional packs you use) over the old ones. Your conversations, memories and settings are kept.

## Uninstall

Delete these folders from your Cyberpunk 2077 folder:

- `bin\x64\plugins\cyber_engine_tweaks\mods\AiNpcCyberpunkMod` (this also deletes your conversations and settings)
- `red4ext\plugins\AiNpcCyberpunkMod` (this also removes the OmniVoice and Local AI packs)
- `red4ext\plugins\AiNpcCyberpunkModNative`
- `r6\scripts\CyberpunkConvai` and `r6\audioware\CyberpunkConvai` (the scripts and speech files; internal names)
- `archive\pc\mod\convai_facial.archive`, `convai_gestures.archive` and `cyberpunk_convai_ambient_driver_guard.archive`

## Licence

AI NPC Cyberpunk Mod is released under the AI NPC Cyberpunk Mod Use License (see `LICENSE.txt`): you may use, modify and share it, including commercially, as long as modified versions that offer AI character conversations keep Convai available as a selectable option. You do not have to use Convai. Bundled components keep their own licences (see `THIRD-PARTY-NOTICES.txt`), and Cyberpunk 2077 and its assets belong to their owners.

## Help

Open Settings > Help > Help and support in game. It shows the service status and can create a report to share when asking for help.

Known issue: if V keeps walking in one direction after you type a message, tap that direction (W, A, S or D) once.
