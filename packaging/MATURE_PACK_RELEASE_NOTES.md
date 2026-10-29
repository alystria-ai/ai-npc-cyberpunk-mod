# Hugging Face page text: AI NPC Cyberpunk Mod: Mature packs (18+)

Where it goes: only as optional files on this project's Hugging Face page (https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs, in its `mature` folder), beside the Local AI packs in `local-ai`. There are two packs, Mature lite (`mature/Mature-Lite-Qwen3.5-4B.zip`) and Mature standard (`mature/Mature-Standard-Gemma-4-E4B.zip`), each one zip with no parts (each holds the memory model too and runs on the Runtime's engine, so it works alone; it needs the Runtime of version 0.2.7 or newer), uploaded either by the release workflow's opt-in `mature` job (Actions > Release > Run workflow, tick `mature`; it builds each pack from the private bucket's mirror in its own job, uploads it to the `mature` folder without a version in the name (the version goes in the commit message), and never runs on a tag push) or by hand (`python packaging/upload-packs.py --version <version> --pack mature-lite --packages <folder>`). Never on Nexus Mods and not on the GitHub release.

## Short description

Optional 18+ models for AI NPC Cyberpunk Mod, in two packs (Mature lite and Mature standard). Each works alone: it includes the memory model and uses the Local AI engine of the Runtime (version 0.2.7 or newer), so no Local AI pack is needed. They replace the Local AI models' built-in refusals with uncensored models, so that the main mod's **Mature content** setting has its full effect: companions can swear, talk about violence, drugs and dark themes, and flirt or be intimate with V, in character and in the game's adult tone. Hard limits always stay on (nothing involving minors, nothing without consent, nothing about real people, no real-world harm instructions, no hate).

## Description

**For adults only (18+).**

The main mod has a **Mature content** setting (Settings > Conversation provider, under the provider). It is off by default, applies to Local AI only, and its help text says it is for adults (18+). With the standard Local AI models it already changes language, violence and tone, but those models are trained to refuse most adult content. These packs are optional downloads that add uncensored models, so the setting has its full effect.

**What it adds**

- Two packs, each one zip with one uncensored model for **Local AI**: **Mature lite** (about 2.8 GB) and **Mature standard** (about 5.5 GB), running on your own graphics card. Each includes the memory model, the same file as in the Local AI packs, and runs on the llama.cpp engine of the Runtime (version 0.2.7 or newer), so it works without a Local AI pack. Install either one, or both.
- With Mature content on: strong language, graphic violence, drug and cyberware-abuse talk, dark and morally grey themes, crude humour, and flirting, romance and sexual content between consenting adults.

**What does not change**

- Characters stay themselves: their voices, personalities and orientations decide how they flirt and talk about sex, not whether they do. They are direct and explicit; your relationship with them sets the tone (a partner is the most forward).
- The **hard limits are always on**, on every model, with or without these packs: no sexual content involving minors or anyone who seems under 18, none without consent, no bestiality or incest, nothing sexual about real people, no real-world instructions for weapons, explosives or drug synthesis, no hateful content about real protected groups. The mod holds them in a rule at the start of every conversation, in a check on your messages before any model sees them, and in a check on every reply sentence before it is spoken.
- It applies to **Local AI only**. Convai and Mistral never get it: choosing either turns the setting off.

**Requirements**

- You are 18 or older.
- AI NPC Cyberpunk Mod (the main mod, Scripts and Runtime, same version) and its requirements.
- A graphics card with free memory for the model (about 3.4 GB for lite, about 6.5 GB for standard). No Local AI pack is needed; with one installed too, its models stay available while Mature content is off.
- Free disk space: about 2.8 GB for Mature lite, about 5.5 GB for Mature standard (about 8.3 GB for both). The vision files (optional, for Companions can see) are separate small zips in the `vision` folder next to the packs, `mature/vision/` on the same page: `Vision-Qwen3.5-4B-projector.zip` for Mature lite (about 0.68 GB) and `Vision-Gemma-4-E4B-projector.zip` for Mature standard (about 0.56 GB). They are read only while Companions can see is on.

**Install**

1. Close the game.
2. Extract the zip into your Cyberpunk 2077 folder, allowing folders to merge.
3. Start the game, open the Companion Manager, then Settings > Conversation provider.
4. Turn on Mature content and Apply (this also selects Local AI).

To turn it off, switch the setting off. With a Mature pack alone, Local AI then waits until Mature content is on again (or a Local AI pack is installed). To remove a pack, delete its marker (`manifest.mature-lite.json` or `manifest.mature-standard.json`) from the Local AI folder (and the model file listed in `mature/THIRD-PARTY-NOTICES-lite.txt` or `-standard.txt`); the memory model is shared with the Local AI packs, so leave it if you use one. The setting stays, and the standard models are used.

**Credits and licences**

The models are community fine-tunes of Apache-2.0 base models: Qwen3.5-4B-HauhauCS-Aggressive (lite; Qwen3.5, Alibaba Cloud) and Gemma-4-E4B-MiniFantasy (good; Gemma 4 E4B, Google). The memory model is the unmodified IBM Granite embedding model (Apache-2.0). The llama.cpp engine (MIT) is part of the Runtime. Licence texts are in the pack. Not made by or connected to CD Projekt Red.

**AI disclosure**

All conversation text is generated by an AI model running on your computer.
