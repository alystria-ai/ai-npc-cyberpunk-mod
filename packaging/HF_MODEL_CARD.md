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

**Current version: 0.3.4.** The files are sorted into folders, and the file names stay the same from version to version, so links to them never change. The file list shows when each file was last updated.

| Folder | What is in it |
|---|---|
| top of the repository | The two files for **game version 2.5** (the current game): the **full install** (`AI-NPC-LLM-Companions.zip`, everything in one zip, for a new install) and the **update** (`AI-NPC-LLM-Companions-Update.zip`, for an install that already has the Runtime). |
| [`game-2.31/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/game-2.31) | The same two files for the **older game version 2.31** (`game-2.31/AI-NPC-LLM-Companions.zip` and `game-2.31/AI-NPC-LLM-Companions-Update.zip`). Only for players who stay on 2.31. |
| [`runtime/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/runtime) | The Runtime alone (`runtime/Runtime.zip`, and `game-2.31/runtime/Runtime.zip` for 2.31). Not for new installs: the full install already holds it. Kept for old two-mod setups and as an input of the builder. |
| [`local-ai/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/local-ai) | The Local AI packs, standard and lite. |
| [`mature/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/mature) | The Mature packs, lite and standard (adults only). |
| [`mic/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/mic) | The microphone packs, European and Asian languages. |
| [`voice/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/voice) | The OmniVoice pack, and in [`voice/amd/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/voice/amd) the AMD packs for OmniVoice on Radeon cards. |
| [`updates/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/updates) | The old Runtime update zips of the releases up to 0.3.3. Not needed any more: the update and the full install replace them. They stay here for old links. |
| [`multilingual/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/multilingual) | The multilingual packs and the PocketTTS models. |

## Which files do I need?

The mod comes in two builds, one for game version 2.5 (the current game, and the normal download) and one for the older game version 2.31. Take the files made for your game. Most players need the files at the top of the repository. The files for 2.31 are in `game-2.31/`. To play 2.31 on Steam, right-click the game in your Library, then Properties, Game Versions & Betas, and pick `2_31_old`. Everything else below is the same for both games.

**New install: take the full install, one zip.** It holds the mod and the Runtime, so there is nothing else to download. **Installed by hand with the Runtime 0.3.3 or newer: you can take the update**, a small zip you extract into the game folder. If the game says the Runtime is too old (an install older than 0.3.3), take the full install instead of any steps. **Using Vortex or Mod Organizer 2: always the full install**, as one mod, and update that mod with each new full install. Never the update.

| File | Size | What it is | Need it? |
|---|---|---|---|
| `AI-NPC-LLM-Companions.zip` | 1.1 GB | **The full install** for game 2.5: the mod and the Runtime in one zip. The Runtime is the background service (voices, lip sync, speech recognition, memory, the Local AI engine, the decoder that lets V's voice follow a V voice-over mod), and the mod is the in-game part and all of its code. Also on Nexus Mods. | **Yes** for a new install (game 2.5) |
| `game-2.31/AI-NPC-LLM-Companions.zip` | 1.1 GB | The full install for the older game 2.31. Also on Nexus Mods, as the optional file for game 2.31. | **Yes** for a new install (game 2.31, instead of the one above) |
| `AI-NPC-LLM-Companions-Update.zip` | 8 MB | **The update** for game 2.5: the mod and all of its code, for a manual install (extracted into the game folder) that already has the Runtime of version 0.3.3 or newer. Not for Vortex or Mod Organizer 2. Also on Nexus Mods (named `AI-NPC-LLM-Companions-Update-<from>-to-<version>`, where `<from>` is the oldest Runtime it runs on, or `any`). An older install takes the full install. | Get it at every update |
| `game-2.31/AI-NPC-LLM-Companions-Update.zip` | 8 MB | The update for the older game 2.31. Also on Nexus Mods, as an optional file. | Get it at every update (game 2.31) |
| `runtime/Runtime.zip` | 1.1 GB | The Runtime alone, without the mod. Not for new installs: the full install holds it. Kept for old two-mod setups (Vortex or Mod Organizer 2 with a Scripts mod and a Runtime mod) that still update their Runtime. | No |
| `game-2.31/runtime/Runtime.zip` | 1.1 GB | The same for the older game 2.31. | No |
| `updates/` (folder) | 1.6 MB for the newest | The old Runtime update zips (up to 0.3.3). **No longer needed**: the update brings the code, and a Runtime older than 0.3.3 takes the full install. Kept here for old links. | No |
| `local-ai/LocalAI-Standard-Gemma-4-E4B.zip` | 5.3 GB | Local AI, standard: Gemma 4 E4B. Free and offline. Uses about 3.1 GB of video memory and needs about 6 GB free to start. Needs the Runtime of version 0.2.7 or newer. | Optional |
| `local-ai/LocalAI-Lite-Bonsai-2-4B.zip` | 1.3 GB | Local AI, lite: Bonsai 2 4B. For smaller graphics cards, about 1.8 GB of video memory. Needs the Runtime of version 0.2.7 or newer. | Optional |
| `voice/OmniPack-OmniVoice-0.6B.zip` | 5.3 GB | OmniVoice: higher-quality local voices, 2 to 4 GB of video memory. Works with any text option. | Optional |
| `voice/amd/OmniAMD-<card family>-PyTorch-2.14-ROCm-10.1.zip` | 1.0 to 1.5 GB each | OmniVoice on an AMD Radeon card (RX 6000, 7000 and 9000, experimental): AMD's ROCm PyTorch for one card family (`gfx1201` is the RX 9070 and 9070 XT, `gfx1200` the RX 9060, `gfx1100` the RX 7900, `gfx1101` the RX 7800 and 7700, `gfx1102` the RX 7600, `gfx1030` the RX 6800 and 6900, `gfx1031` the RX 6700). **You do not download these yourself.** The game does it: with the OmniVoice pack installed, Settings > Voices > OmniVoice for AMD > Set up OmniVoice for AMD picks the zip for your card, downloads it, unpacks it and tests it. The files are AMD's own, unchanged. | Optional, automatic |
| `server/OmniVoice-Server.zip` | 4.8 GB | New in 0.3.3: the OmniVoice server for Remote OmniVoice. It renders the OmniVoice voices on another PC or a second graphics card (Windows and an NVIDIA card, no game needed there), so the game PC loads no OmniVoice. Set it up in Settings > Voices > Custom voices; the steps are in the zip's README. | Optional |
| `mature/Mature-Lite-Qwen3.5-4B.zip` | 2.8 GB | **18+.** An uncensored Local AI model (Qwen3.5 4B fine-tune). Needs the Runtime of version 0.2.7 or newer. | Optional |
| `mature/Mature-Standard-Gemma-4-E4B.zip` | 5.5 GB | **18+.** An uncensored Local AI model (Gemma 4 E4B fine-tune). Needs the Runtime of version 0.2.7 or newer. | Optional |
| `mic/MicPack-European-Parakeet-TDT-0.6B-v3.zip` | about 0.67 GB | Microphone in Russian, Ukrainian, Polish, Czech, Hungarian, German, French, Spanish, Italian and Portuguese, for Local AI and Custom endpoints (NVIDIA Parakeet TDT 0.6B v3, int8). Runs on the processor. | Optional |
| `mic/MicPack-Asian-SenseVoice-Small-234M.zip` | about 0.24 GB | Microphone in Mandarin Chinese, Japanese and Korean for Local AI and Custom endpoints (SenseVoice Small, int8). Runs on the processor. | Optional |
| `multilingual/` (folder) | about 150-220 MB per file | Multilingual packs (10 languages: the characters speak in the game's own dub voice when they reply in that language, with OmniVoice or the Mistral voice) and PocketTTS models (French, Italian, German, Spanish, Portuguese, for the Pocket voice). Get only your language; see the folder's README. | Optional |

**You can skip every optional pack.** The mod works without them with Mistral (cloud, your own free key) or the Convai free tier (cloud, the default, nothing to set up), both at no cost to your frame rate. Local AI can also use a model server you already run (KoboldCpp, LM Studio, Ollama or any OpenAI-compatible one) with no pack; the steps are on the Nexus Mods page. The packs only add local options that run on your own graphics card.

The Local AI and Mature packs hold the models only. The engine that runs them (llama.cpp) is part of the Runtime, so they need **the Runtime that came with version 0.2.7 or newer**. If your Runtime is older, install the full install zip first.

Text and voice are separate choices. Pick one text option (Convai, Mistral, Local AI, or Mature) and one voice option (the built-in voices, OmniVoice, or a cloud voice). Any combination works. Several text packs can be installed at once: only one model loads at a time, and you switch in Settings.

## Install

1. Close the game.
2. Extract the zip **into your Cyberpunk 2077 folder** (the one with `bin`, `archive` and `r6`), allowing folders to merge. Every zip already starts with the right folders (`bin`, `r6`, `archive` or `red4ext`). A new install takes the full install (`AI-NPC-LLM-Companions.zip`) and nothing else. An install made by hand that already has the Runtime can take the update (`AI-NPC-LLM-Companions-Update.zip`) at every update, and the full install again when Settings > Help says the Runtime is too old. Extract the full install before the OmniVoice pack.
   - Don't extract into a new folder named after the zip (Windows' "Extract All" and 7-Zip's "Extract to *name*" do that by default). If it happens anyway with an optional pack, the mod moves the pack files into place by itself at the next start. The full install and the update are not moved: extract them again into the game folder.
   - Vortex: drop the full install onto the Mods page as one mod, then click Deploy. It holds the Runtime too, so it is the only mod you need. Never the update zip. Coming from 0.3.3 or older with a Scripts mod and a Runtime mod: remove both old mods first. For the Local AI and Mature packs Vortex shows "You Have Reached The Fallback Installer": choose "Yes, Install To Staging Anyway" and every file lands correctly. Two of them at once give "unresolved file conflicts" (they share identical licence and embedding model files): pick either one to load after the other, it makes no difference. The OmniVoice pack holds DLLs and Vortex can't install it: extract it by hand. The warning sign in the Version column and "external changes" at deploy are harmless. To update, drop the newer full install and choose "Replace the existing mod" (about 1.1 GB, one click).
   - Mod Organizer 2: the full install is one mod, and a newer full install updates it (choose Merge if asked, so packs inside its folder stay). Coming from 0.3.3 or older with a Scripts mod and a Runtime mod: remove both old mods first. The multilingual packs and PocketTTS models go INTO that mod's folder.
   - The update needs a Runtime of at least the version Settings > Help names (a newer one is fine), for the same game. Settings > Help shows both.
3. Start the game. Open the Companion Manager, then Settings > Conversation provider to pick Local AI and a model, or Settings > Voices to pick OmniVoice.

The Runtime runs its conversation page in an installed Chromium browser: Microsoft Edge, which comes with Windows, is enough, and Google Chrome, Brave, Vivaldi, Opera and other Chromium browsers work too (Firefox does not).

Requirements, controls and troubleshooting are on the [Nexus Mods page](https://www.nexusmods.com/cyberpunk2077/mods/35436).

## Mature packs (18+)

For adults only. The main mod has a **Mature content** setting, off by default, for Local AI and Custom. The standard models refuse most adult content. These packs add uncensored models for Local AI, so the setting has its full effect: strong language, graphic violence, dark themes, and romance and sexual content between consenting adults.

The **hard limits are always on**, on every model: nothing involving minors, nothing without consent, nothing sexual about real people, no real-world weapon or drug instructions, no hate. The mod checks them on your messages before any model sees them, and on every reply before it is spoken.

Each Mature pack works on its own: you need no Local AI pack beside it. It runs on the Local AI engine in the Runtime (version 0.2.7 or newer). Turn on **Mature content** in Settings > Conversation provider to use it. With the setting off, a Mature-only install leaves Local AI off and the cloud provider answers.

## Credits and licences

Every model file in the optional packs is the unmodified upstream file, pinned by revision and SHA-256, with one exception: in the OmniVoice pack the language model (`model.safetensors`) is the upstream file with its weights rounded from float32 to float16, the precision the voice engine loads it in. The pack's notice names the change and both hashes. The OmniVoice audio tokenizer and the other model files are unmodified. Each pack carries its licence texts and a third-party notice.

| Component | Source | Licence |
|---|---|---|
| llama.cpp `llama-server` b11782 (Vulkan), in the Runtime | ggml-org/llama.cpp | MIT |
| Gemma 4 E4B QAT q4_0 (Local AI standard) | google/gemma-4-E4B-it-qat-q4_0-gguf | Apache-2.0 |
| Bonsai 2 4B Q2_0 (Local AI lite) | prism-ml/Ternary-Bonsai-2-4B-gguf (PrismML) | Apache-2.0 |
| granite-embedding-107m-multilingual Q8_0 (memory) | lmstudio-community/granite-embedding-107m-multilingual-GGUF (IBM) | Apache-2.0 |
| Qwen3.5-4B Uncensored HauhauCS Aggressive (Mature lite) | HauhauCS/Qwen3.5-4B-Uncensored-HauhauCS-Aggressive | Apache-2.0 |
| Gemma4-E4B-MiniFantasy-V1 (Mature standard) | Nubinu/Gemma4-E4B-MiniFantasy-V1-GGUF | Apache-2.0 |
| OmniVoice model (language model rounded to float16) | k2-fsa/OmniVoice | code Apache-2.0; weights CC-BY-NC (non-commercial) |
| OmniVoice audio tokenizer | k2-fsa/OmniVoice | Boson Higgs Audio 2 Community License |
| VoiceStudio adapter (OmniPack) | debpalash/VoiceStudio | AGPL-3.0-only |
| Kyutai Pocket TTS (Runtime; the voice model is adapted from Kyutai's weights) | kyutai-labs/pocket-tts | code MIT; weights CC-BY-4.0 |
| NVIDIA Parakeet TDT 0.6B v3, int8 ONNX by sherpa-onnx (Microphone, European languages) | nvidia/parakeet-tdt-0.6b-v3 | CC-BY-4.0 (attribution: NVIDIA; converted and quantised by k2-fsa sherpa-onnx) |
| SenseVoice Small, int8 ONNX by sherpa-onnx (Microphone, Asian languages) | FunAudioLLM/SenseVoice, modelscope/FunASR | FunASR Model Open Source License 1.1 (attribution: keep the model name and source) |

The mod's own code is under the AI NPC Cyberpunk Mod Use License 1.1. The full list of third-party components and their licence texts is in `THIRD-PARTY-NOTICES.txt` inside each package.

Cyberpunk 2077 is a trademark of CD Projekt S.A. This mod is not made by or connected to CD Projekt Red.

**AI disclosure:** conversation text and voices are generated by AI models.
