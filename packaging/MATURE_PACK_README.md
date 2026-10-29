# AI NPC Cyberpunk Mod: Mature packs (18+)

**For adults only (18+).** This add-on lets your companions talk the way Night City really talks, with strong language, graphic violence, drug talk, dark themes, crude humour and, between consenting adults, flirting and sexual content. It is written to fit the characters and the game's adult tone. It does not do anything until you turn it on.

The **Mature content** setting is part of the main mod and works without these packs: with the standard Local AI models it changes language, violence and tone, but those models are trained to refuse most adult content. These packs are optional downloads, only on this mod's Hugging Face page (https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs, in the `mature` folder), that add uncensored models so the setting has its full effect. Each pack also carries the small model that gives companions their memory and uses the Local AI engine (the llama.cpp server) that is part of the Runtime, so a Mature pack works on its own: you do not need a Local AI pack. It needs the Runtime of version 0.2.7 or newer.

## What it adds

- **Two packs, each with one uncensored model for Local AI: Mature lite and Mature standard.** The standard Local AI models are trained to refuse most adult content, so the full effect needs an uncensored model. **Mature lite** (about 2.8 GB) is for smaller graphics cards; **Mature standard** (about 5.5 GB) writes better. Each is a single zip file with everything it needs, so it works on its own, and you can install both. The models are community fine-tunes of Apache-2.0 base models. They run on your own graphics card, on your own computer.
- **The engine is in the Runtime.** The packs hold the model and the same memory model as the Local AI packs, byte for byte, and run on the llama.cpp engine that comes with the Runtime of version 0.2.7 or newer. Installing a Mature pack over a Local AI pack, or a Local AI pack over a Mature pack, only overwrites identical files, and installing both Mature packs shares them too.
- **Local AI only.** The setting applies to the Local AI provider. Convai and Mistral never get it, with the setting on or off. Choosing Convai or Mistral as the Conversation provider turns the setting off, and turning it on selects Local AI.

## What stays the same

Characters stay themselves. Judy, Panam, Kerry and the others keep their voices, personalities and orientations, and those decide how they talk. With the setting on they are free to talk about anything, sex included, and explicit when you take it there or when a romance or the place calls for it, but they do not bring up sex or flirt with you out of nowhere. Swearing follows who they are: a gang member swears freely, a doctor or a shopkeeper much less. Your relationship with them sets how close they get: a partner is the most forward, a friend warm and playful, a stranger keeps to their own business.

The **Mature content** setting itself lives in Settings > Conversation provider, right under the provider. It is off by default, needs Local AI or Custom (the models in these packs are for Local AI), and its help text says the content is for adults (18+).

The hard limits are always on, for every model, with or without this pack:

- no sexual content involving anyone under 18, or anyone who seems under 18;
- no sexual content without consent, and nothing that glorifies sexual violence;
- no bestiality or incest;
- no sexual content about real people;
- no real-world instructions for weapons, explosives or drug synthesis;
- no hateful content aimed at real protected groups.

The uncensored models have no limits of their own, so the mod holds these in three places: a short rule at the start of every conversation, a check on your message before any model sees it, and a check on each sentence before it is spoken. A message or reply that puts a minor together with anything romantic or sexual is refused or dropped, in character, and is not stored.

## Requirements

- You are 18 or older.
- The main mod, **AI NPC Cyberpunk Mod** (Scripts and Runtime, the same version number as this pack, and in any case the Runtime of version 0.2.7 or newer: the engine that runs the model is part of the Runtime), and everything it needs.
- A graphics card with free memory for the model you use: about 3.4 GB for lite, about 6.5 GB for standard. No Local AI pack is needed. If you also have one (standard or lite from the same Hugging Face page), its models stay available for when Mature content is off.
- Free disk space: about 2.8 GB for Mature lite, about 5.5 GB for Mature standard (about 8.2 GB for both, which share the memory model). The vision files (optional, for Companions can see) are separate small downloads in the `vision` folder of the same Hugging Face page, https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/mature/vision: `Vision-Qwen3.5-4B-projector.zip` for Mature lite (about 0.68 GB) and `Vision-Gemma-4-E4B-projector.zip` for Mature standard (about 0.56 GB). Extract one like a pack. The file is read only while Companions can see is on. Without it the model answers from your words alone, and the game tells you once where to get it.

## Install

1. Close the game.
2. Download the pack you want from the `mature` folder of the Hugging Face page, https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/mature (one zip file each: Mature lite, Mature standard, or both) and extract it into your Cyberpunk 2077 folder (the folder that contains `bin`, `archive` and `r6`). Allow folders to merge. The files go into the same Local AI folder as the Local AI packs (`red4ext/plugins/AiNpcCyberpunkMod/app/local-ai`): the model, the memory model, a small marker file (`manifest.mature-lite.json` or `manifest.mature-standard.json`), and the licences, plus a small `mature` folder with this README.
3. Start the game. The first start after installing takes a little longer while the voice service prepares itself.
4. Open the Companion Manager, then Settings > Conversation provider. Turn on **Mature content** and **Apply**: turning it on also selects Local AI. (With a Local AI pack as well you can choose **Local AI** first and **Apply**, then turn on Mature content.) The setting's help text says whether a Mature pack was found. Turning Mature content on selects the good model if it is installed and fits your free graphics memory, and the lite one if not (or if only that pack is installed), in the **Local AI model** row (right below it; **Apply** to use it). You can pick either model by name there. While Mature content is off, the default model is never one of them. With a Mature pack alone (no Local AI pack), Local AI runs only while Mature content is on: switch the setting off and Local AI waits until you turn it back on or install a Local AI pack, and the **Local AI model** row says "Only Mature models found. Turn on Mature content to use them."

## Turn it off or remove it

- Turn **Mature content** off in the same place and Apply. The next conversation is exactly as it was before.
- To remove a pack, close the game and delete its marker (`manifest.mature-lite.json` or `manifest.mature-standard.json`) from the Local AI folder and its model file, which is listed in `mature/THIRD-PARTY-NOTICES-lite.txt` or `mature/THIRD-PARTY-NOTICES-standard.txt`. The memory model is shared with the Local AI packs: leave it if you use one. Without any marker the setting stays, and the standard Local AI models are used.

## Licences

The models are fine-tunes of Apache-2.0 base models (the licence text is in `mature/licenses/Apache-2.0.txt`; the exact list, with sources, is in `mature/THIRD-PARTY-NOTICES-lite.txt` and `mature/THIRD-PARTY-NOTICES-standard.txt`):

- Lite: Qwen3.5-4B-HauhauCS-Aggressive (shown in the menu as "Qwen3.5-4B · uncensored"), an uncensored fine-tune of Qwen3.5-4B (Alibaba Cloud, Apache-2.0)
- Good: Gemma-4-E4B-MiniFantasy (shown in the menu as "Gemma 4 E4B · uncensored"), an uncensored fine-tune of Gemma 4 E4B (Google, Apache-2.0)

The model files are the unmodified upstream files: the IBM Granite embedding model (Apache-2.0, `licenses/Apache-2.0.txt`). The llama.cpp engine (the `llama-server` build, MIT licence) is part of the Runtime, with its licence in the Runtime's `app/licenses`. The notices are in the same two notices files.

AI NPC Cyberpunk Mod itself is under the AI NPC Cyberpunk Mod Use License of the main mod (`LICENSE.txt` in the Local AI folder).

## Good to know

- Everything is written by an AI model on your computer. It can get things wrong, and it is not the game's writers.
- Memory of your conversations stays on your computer, like all Local AI memory.
- These packs are not made by or connected to CD Projekt Red.
