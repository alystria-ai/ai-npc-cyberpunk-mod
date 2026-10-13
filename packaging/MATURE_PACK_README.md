# Cyberpunk Convai: Mature pack (18+)

**For adults only (18+).** This add-on lets your companions talk the way Night City really talks, with strong language, graphic violence, drug talk, dark themes, crude humour and, between consenting adults, flirting and sexual content. It is written to fit the characters and the game's adult tone. It does nothing until you turn it on.

This is a separate download from the main mod. The main mod has no Mature content setting at all until this pack is installed.

## What it adds

- **A "Mature content" setting** in Settings > Development, right under Conversation provider. It is off by default. Turning it on shows a one-line confirmation that the content is for adults (18+).
- **Uncensored models for Local AI.** The standard Local AI models are trained to refuse most adult content, so the full effect needs the uncensored models in this pack. They are community fine-tunes of Apache-2.0 base models. The models run on your own graphics card, on your own computer.
- **Local AI only.** The setting applies to the Local AI provider. Convai, Mistral and Groq never get it, with the setting on or off. If your conversations are not using Local AI at the moment, the setting says so and does nothing.

## What stays the same

Characters stay themselves. Judy, Panam, Kerry and the others keep their personalities, boundaries and orientations, and they can say no, tease or change the subject as they naturally would. Romance follows the relationship your save has with them: without it, a character is not your lover.

The hard limits are always on, for every model in this pack:

- no sexual content involving anyone under 18, or anyone who seems under 18;
- no sexual content without consent, and nothing that glorifies sexual violence;
- no bestiality or incest;
- no sexual content about real people;
- no real-world instructions for weapons, explosives or drug synthesis;
- no hateful content aimed at real protected groups.

The uncensored models have no limits of their own, so the mod holds these in two places: a short rule at the start of every conversation, and a check on each sentence before it is spoken. A sentence that puts a minor and something sexual together is dropped.

## Requirements

- You are 18 or older.
- The main mod, **Cyberpunk Convai** (Scripts and Runtime, the same version number as this pack), and everything it needs.
- A **Local AI pack** (standard or lite) from the main mod's release page, and a graphics card with free memory for it. Local AI must be working before you add this pack.
- Free disk space for the models: about PLACEHOLDER GB.

## Install

1. Close the game.
2. Download every part of this pack and extract each one into your Cyberpunk 2077 folder (the folder that contains `bin`, `archive` and `r6`). Allow folders to merge. The files go into the same Local AI folder as the Local AI packs (`red4ext/plugins/CyberpunkConvai/app/local-ai`), plus a small `mature` folder with this README and the licences.
3. Start the game. The first start after installing takes a little longer while the voice service prepares itself.
4. Open the Companion Manager, then Settings > Development. Choose **Local** in Conversation provider and **Apply**, then turn on **Mature content** and **Apply** again. The setting only appears once this pack is installed and the game has seen it.

## Turn it off or remove it

- Turn **Mature content** off in the same place and Apply. The next conversation is exactly as it was before.
- To remove the pack, close the game and delete `manifest.mature.json` from the Local AI folder and the pack's model files listed in `mature/THIRD-PARTY-NOTICES.txt`. Without `manifest.mature.json` the setting disappears and stays off, even if it was on.

## Licences

The models are fine-tunes of Apache-2.0 base models (the licence text is in `mature/licenses/Apache-2.0.txt`; the exact list, with sources, is in `mature/THIRD-PARTY-NOTICES.txt`):

- PLACEHOLDER: uncensored fine-tune of Qwen3.5 (Alibaba Cloud, Apache-2.0)
- PLACEHOLDER: uncensored fine-tune of Gemma 4 E4B (Google, Apache-2.0)

Cyberpunk Convai itself is under the Cyberpunk Convai Use License of the main mod.

## Good to know

- Everything is written by an AI model on your computer. It can get things wrong, and it is not the game's writers.
- Memory of your conversations stays on your computer, like all Local AI memory.
- This pack is not made by or connected to CD Projekt Red.
