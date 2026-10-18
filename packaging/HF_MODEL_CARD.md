---
license: other
license_name: mixed
license_link: LICENSE
pretty_name: AI NPC Cyberpunk Mod packs
tags:
  - cyberpunk-2077
  - game-mod
  - gguf
  - llama.cpp
  - text-to-speech
---

# AI NPC Cyberpunk Mod: download packs

Downloads for **AI NPC Cyberpunk Mod**, a Cyberpunk 2077 mod that lets you talk to the game's characters by voice or text. They answer in their own voices, with lip sync, emotions and gestures. Companions walk with you, sit with you, ride along, fight beside you and pick up when you call.

**Mod page:** [Nexus Mods](https://www.nexusmods.com/cyberpunk2077/mods/35436), with the full description, requirements and support.

Every file sits in the version folder (`0.2.1/`) with its `SHA256SUMS-*.txt` checksum.

## Which files do I need?

| File | Size | What it is | Need it? |
|---|---|---|---|
| `AI-NPC-Cyberpunk-Mod-Scripts-0.2.1.zip` | 2 MB | The mod itself, the in-game part. Also on Nexus Mods. | **Yes** |
| `AI-NPC-Cyberpunk-Mod-Runtime-0.2.1.zip` | 1.0 GB | The background service: voices, lip sync, speech recognition, memory. | **Yes** |
| `AI-NPC-Cyberpunk-Mod-LocalAI-Standard-0.2.1.zip` | 5.3 GB | Local AI, standard: Gemma 4 E4B. Free and offline, about 3.1 GB of video memory (6 GB free recommended). | Optional |
| `AI-NPC-Cyberpunk-Mod-LocalAI-Lite-0.2.1.zip` | 1.4 GB | Local AI, lite: Bonsai 2 4B. For smaller graphics cards, about 1.8 GB of video memory. | Optional |
| `AI-NPC-Cyberpunk-Mod-OmniPack-0.2.1.zip` | 6.6 GB | OmniVoice: higher-quality local voices, 2 to 4 GB of video memory. Works with any text option. | Optional |
| `AI-NPC-Cyberpunk-Mod-Mature-Lite-0.2.1.zip` | 2.9 GB | **18+.** An uncensored Local AI model (Qwen3.5 4B fine-tune). | Optional |
| `AI-NPC-Cyberpunk-Mod-Mature-Standard-0.2.1.zip` | 5.5 GB | **18+.** An uncensored Local AI model (Gemma 4 E4B fine-tune). | Optional |

**You can skip every optional pack.** The mod works out of the box with the Convai free tier (cloud, no cost to your frame rate) or Mistral (cloud, your own free key). The packs only add local options that run on your own graphics card.

Text and voice are separate choices. Pick one text option (Convai, Mistral, Local AI, or Mature) and one voice option (the built-in voices, OmniVoice, or a cloud voice). Any combination works. Several text packs can be installed at once: only one model loads at a time, and you switch in Settings.

## Install

1. Close the game.
2. Extract each zip **into your Cyberpunk 2077 folder** (the one with `bin`, `archive` and `r6`), allowing folders to merge. Every zip already starts with the right folders (`red4ext\...` or `bin\...`).
   - Don't extract into a new folder named after the zip (Windows' "Extract All" and 7-Zip's "Extract to *name*" do that by default). If it happens anyway, the mod moves the pack files into place by itself at the next start.
3. Start the game. Open the Companion Manager, then Settings > Conversation provider to pick Local AI and a model, or Voice to pick OmniVoice.

Requirements, controls and troubleshooting are on the [Nexus Mods page](https://www.nexusmods.com/cyberpunk2077/mods/35436).

## Mature packs (18+)

For adults only. The main mod has a **Mature content** setting, off by default, for Local AI only. The standard models refuse most adult content. These packs add uncensored models, so the setting has its full effect: strong language, graphic violence, dark themes, and romance and sexual content between consenting adults.

The **hard limits are always on**, on every model: nothing involving minors, nothing without consent, nothing sexual about real people, no real-world weapon or drug instructions, no hate. The mod checks them on your messages before any model sees them, and on every reply before it is spoken.

Each Mature pack works on its own: it includes the Local AI engine, so you need no Local AI pack beside it. Turn on **Mature content** in Settings > Conversation provider to use it. With the setting off, a Mature-only install leaves Local AI off and the cloud provider answers.

## Credits and licences

Every model file is the unmodified upstream file, pinned by revision and SHA-256. Each pack carries its licence texts and a third-party notice.

| Component | Source | Licence |
|---|---|---|
| llama.cpp `llama-server` b11560 (Vulkan) | ggml-org/llama.cpp | MIT |
| Gemma 4 E4B QAT q4_0 (Local AI standard) | google/gemma-4-E4B-it-qat-q4_0-gguf | Apache-2.0 |
| Bonsai 2 4B Q2_0 (Local AI lite) | prism-ml/Ternary-Bonsai-2-4B-gguf (PrismML) | Apache-2.0 |
| granite-embedding-107m-multilingual Q8_0 (memory) | lmstudio-community/granite-embedding-107m-multilingual-GGUF (IBM) | Apache-2.0 |
| Qwen3.5-4B Uncensored HauhauCS Aggressive (Mature lite) | HauhauCS/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive | Apache-2.0 |
| Gemma4-E4B-MiniFantasy-V1 (Mature standard) | Nubinu/Gemma4-E4B-MiniFantasy-V1-GGUF | Apache-2.0 |
| OmniVoice model | k2-fsa/OmniVoice | code Apache-2.0; weights CC-BY-NC (non-commercial) |
| OmniVoice audio tokenizer | k2-fsa/OmniVoice | Boson Higgs Audio 2 Community License |
| VoiceStudio adapter (OmniPack) | debpalash/VoiceStudio | AGPL-3.0-only |
| Kyutai Pocket TTS (Runtime) | kyutai-labs/pocket-tts | MIT |

The mod's own code is under the AI NPC Cyberpunk Mod Use License 1.1. The full list of third-party components and their licence texts is in `THIRD-PARTY-NOTICES.txt` inside each package.

Cyberpunk 2077 is a trademark of CD Projekt S.A. This mod is not made by or connected to CD Projekt Red.

**AI disclosure:** conversation text and voices are generated by AI models.
