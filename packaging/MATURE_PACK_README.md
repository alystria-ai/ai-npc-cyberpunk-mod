# Cyberpunk Convai: Mature packs (18+)

**For adults only (18+).** This add-on lets your companions talk the way Night City really talks, with strong language, graphic violence, drug talk, dark themes, crude humour and, between consenting adults, flirting and sexual content. It is written to fit the characters and the game's adult tone. It does not do anything until you turn it on.

The **Mature content** setting is part of the main mod and works without these packs: with the standard Local AI models it changes language, violence and tone, but those models are trained to refuse most adult content. These packs are optional downloads, only on this mod's Hugging Face page (https://huggingface.co/akshitireddy/cyberpunk-convai-packs), that add uncensored models so the setting has its full effect.

## What it adds

- **Two packs, each with one uncensored model for Local AI: Mature lite and Mature standard.** The standard Local AI models are trained to refuse most adult content, so the full effect needs an uncensored model. **Mature lite** (about 2.7 GB) is for smaller graphics cards; **Mature standard** (about 5.3 GB) writes better. Each is a single zip file and works on its own, and you can install both. The models are community fine-tunes of Apache-2.0 base models. They run on your own graphics card, on your own computer.
- **Local AI only.** The setting applies to the Local AI provider. Convai and Mistral never get it, with the setting on or off. Choosing Convai or Mistral as the Conversation provider turns the setting off, and turning it on selects Local AI.

## What stays the same

Characters stay themselves. Judy, Panam, Kerry and the others keep their voices, personalities and orientations, and those decide how they flirt and talk about sex, not whether they do. With the setting on, they are direct and explicit: they say what they want and what they would do, in plain words. Your relationship with them sets the tone: a partner is the most forward, a friend warm and playful, a stranger or rival bolder and rougher.

The **Mature content** setting itself lives in Settings > Conversation provider, right under the provider. It is off by default, applies to Local AI only, and its help text says the content is for adults (18+).

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
- The main mod, **Cyberpunk Convai** (Scripts and Runtime, the same version number as this pack), and everything it needs.
- A **Local AI pack** (standard or lite) from the same Hugging Face page, and a graphics card with free memory for it. Local AI must be working before you add a Mature pack.
- Free disk space for the model: about 2.7 GB for Mature lite, about 5.3 GB for Mature standard (about 8 GB for both). You need free graphics memory for the one you use: about 3.4 GB for lite, about 6.5 GB for good.

## Install

1. Close the game.
2. Download the pack you want from the Hugging Face page (one zip file each: Mature lite, Mature standard, or both) and extract it into your Cyberpunk 2077 folder (the folder that contains `bin`, `archive` and `r6`). Allow folders to merge. The files go into the same Local AI folder as the Local AI packs (`red4ext/plugins/CyberpunkConvai/app/local-ai`): the model and a small marker file (`manifest.mature-lite.json` or `manifest.mature-standard.json`), plus a small `mature` folder with this README and the licences.
3. Start the game. The first start after installing takes a little longer while the voice service prepares itself.
4. Open the Companion Manager, then Settings > Conversation provider. Choose **Local** in Conversation provider and **Apply**, then turn on **Mature content** and **Apply** again. The setting's help text says whether a Mature pack was found. Turning Mature content on selects the good model if it is installed and fits your free graphics memory, and the lite one if not (or if only that pack is installed), in the **Local AI model** row (right below it; **Apply** to use it). You can pick either model by name there. While Mature content is off, the default model is never one of them.

## Turn it off or remove it

- Turn **Mature content** off in the same place and Apply. The next conversation is exactly as it was before.
- To remove a pack, close the game and delete its marker (`manifest.mature-lite.json` or `manifest.mature-standard.json`) from the Local AI folder and its model file, which is listed in `mature/THIRD-PARTY-NOTICES-lite.txt` or `mature/THIRD-PARTY-NOTICES-standard.txt`. Without any marker the setting stays, and the standard Local AI models are used.

## Licences

The models are fine-tunes of Apache-2.0 base models (the licence text is in `mature/licenses/Apache-2.0.txt`; the exact list, with sources, is in `mature/THIRD-PARTY-NOTICES-lite.txt` and `mature/THIRD-PARTY-NOTICES-standard.txt`):

- Lite: Qwen3.5-4B-HauhauCS-Aggressive (shown in the menu as "Qwen3.5-4B · uncensored"), an uncensored fine-tune of Qwen3.5-4B (Alibaba Cloud, Apache-2.0)
- Good: Gemma-4-E4B-MiniFantasy (shown in the menu as "Gemma 4 E4B · uncensored"), an uncensored fine-tune of Gemma 4 E4B (Google, Apache-2.0)

Cyberpunk Convai itself is under the Cyberpunk Convai Use License of the main mod.

## Good to know

- Everything is written by an AI model on your computer. It can get things wrong, and it is not the game's writers.
- Memory of your conversations stays on your computer, like all Local AI memory.
- These packs are not made by or connected to CD Projekt Red.
