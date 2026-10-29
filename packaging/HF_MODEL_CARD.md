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

**The mod itself (the full install and the update) downloads from [Nexus Mods](https://www.nexusmods.com/cyberpunk2077/mods/35436?tab=files) only.** This page holds the optional packs. The files are sorted into folders, and the file names stay the same from version to version, so links to them never change. The file list shows when each file was last updated.

| Folder | What is in it |
|---|---|
| [`local-ai/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/local-ai) | The Local AI packs, standard and lite. In [`local-ai/vision/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/local-ai/vision) the vision files of their models. |
| [`mature/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/mature) | The Mature packs, lite and standard (adults only). In [`mature/vision/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/mature/vision) the vision files of their models. |
| [`mic/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/mic) | The microphone packs, European and Asian languages. |
| [`voice/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/voice) | The OmniVoice pack, and in [`voice/amd/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/voice/amd) the AMD packs for OmniVoice on Radeon cards. |
| [`updates/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/updates) (game 2.31 in [`updates/game-2.31/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/updates/game-2.31)) | The old Runtime update zips of the releases up to 0.3.3. Not needed any more: the update and the full install on Nexus Mods replace them. They stay here for old links. |
| [`multilingual/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/multilingual) | The multilingual packs and the PocketTTS models. |

## Which files do I need?

**First get the mod from [Nexus Mods](https://www.nexusmods.com/cyberpunk2077/mods/35436?tab=files):** the main file for game 2.5, or the optional file for the older game 2.31. It holds the mod and the Runtime, so it is all you need. Everything below is optional and the same for both games.

| File | Size | What it is | Need it? |
|---|---|---|---|
| `updates/` (folder) | 1.6 MB for the newest | The old Runtime update zips (up to 0.3.3). **No longer needed**: the update on Nexus Mods brings the code, and a Runtime older than 0.3.3 takes the full install. Kept here for old links. | No |
| `local-ai/LocalAI-Standard-Gemma-4-E4B.zip` | 5.3 GB | Local AI, standard: Gemma 4 E4B. Free and offline. Uses about 3.1 GB of video memory and needs about 6 GB free to start. Needs the Runtime of version 0.2.7 or newer. | Optional |
| `local-ai/LocalAI-Lite-Bonsai-2-4B.zip` | 1.3 GB | Local AI, lite: Bonsai 2 4B. For smaller graphics cards, about 1.8 GB of video memory. Needs the Runtime of version 0.2.7 or newer. | Optional |
| `local-ai/vision/Vision-Gemma-4-E4B-projector.zip` | 0.56 GB | The vision file of **Local AI standard** (Gemma 4 E4B). With it the model sees the pictures that Settings > Conversations > Companions can see sends, and without it the model answers from your words only. It loads only while that setting is on and then takes about 0.8 GB more video memory. Extract it like a pack, after the pack. | Optional |
| `local-ai/vision/Vision-Bonsai-2-4B-projector.zip` | 0.37 GB | The vision file of **Local AI lite** (Bonsai 2 4B), for the same setting. It loads only while Companions can see is on and then takes about 0.4 GB more video memory. | Optional |
| `voice/OmniPack-OmniVoice-0.6B.zip` | 5.3 GB | OmniVoice: higher-quality local voices, 2 to 4 GB of video memory. Works with any text option. | Optional |
| `voice/amd/OmniAMD-<card family>-PyTorch-2.14-ROCm-10.1.zip` | 1.0 to 1.5 GB each | OmniVoice on an AMD Radeon card (RX 6000, 7000 and 9000, experimental): AMD's ROCm PyTorch for one card family (`gfx1201` is the RX 9070 and 9070 XT, `gfx1200` the RX 9060, `gfx1100` the RX 7900, `gfx1101` the RX 7800 and 7700, `gfx1102` the RX 7600, `gfx1030` the RX 6800 and 6900, `gfx1031` the RX 6700). **You do not download these yourself.** The game does it: with the OmniVoice pack installed, Settings > Voices > OmniVoice for AMD > Set up OmniVoice for AMD picks the zip for your card, downloads it, unpacks it and tests it. The files are AMD's own, unchanged. | Optional, automatic |
| `server/OmniVoice-Server.zip` | 4.8 GB | New in 0.3.3: the OmniVoice server for Remote OmniVoice. It renders the OmniVoice voices on another PC or a second graphics card (Windows and an NVIDIA card, no game needed there), so the game PC loads no OmniVoice. Set it up in Settings > Voices > Custom voices; the steps are in the zip's README. | Optional |
| `mature/Mature-Lite-Qwen3.5-4B.zip` | 2.8 GB | **18+.** An uncensored Local AI model (Qwen3.5 4B fine-tune). Needs the Runtime of version 0.2.7 or newer. | Optional |
| `mature/Mature-Standard-Gemma-4-E4B.zip` | 5.5 GB | **18+.** An uncensored Local AI model (Gemma 4 E4B fine-tune). Needs the Runtime of version 0.2.7 or newer. | Optional |
| `mature/vision/Vision-Gemma-4-E4B-projector.zip` | 0.56 GB | The vision file of **Mature standard**. It is the same file as `local-ai/vision/Vision-Gemma-4-E4B-projector.zip`, so you need only one of the two copies. It loads only while Companions can see is on and then takes about 0.8 GB more video memory. | Optional |
| `mature/vision/Vision-Qwen3.5-4B-projector.zip` | 0.68 GB | The vision file of **Mature lite** (Qwen3.5 4B). It loads only while Companions can see is on and then takes about 0.7 GB more video memory. | Optional |
| `mic/MicPack-European-Parakeet-TDT-0.6B-v3.zip` | about 0.67 GB | Microphone in Russian, Ukrainian, Polish, Czech, Hungarian, German, French, Spanish, Italian and Portuguese, for Local AI and Custom endpoints (NVIDIA Parakeet TDT 0.6B v3, int8). Runs on the processor. | Optional |
| `mic/MicPack-Asian-SenseVoice-Small-234M.zip` | about 0.24 GB | Microphone in Mandarin Chinese, Japanese and Korean for Local AI and Custom endpoints (SenseVoice Small, int8). Runs on the processor. | Optional |
| `multilingual/` (folder) | about 150-220 MB per file | Multilingual packs (10 languages: the characters speak in the game's own dub voice when they reply in that language, with OmniVoice or the Mistral voice) and PocketTTS models (French, Italian, German, Spanish, Portuguese, for the Pocket voice). Get only your language; see the folder's README. | Optional |

**You can skip every optional pack.** The mod works without them with Google Gemini (cloud, your own free key) or the Convai free tier (cloud, the default, nothing to set up), both at no cost to your frame rate. Local AI can also use a model server you already run (KoboldCpp, LM Studio, Ollama or any OpenAI-compatible one) with no pack; the steps are on the Nexus Mods page. The packs only add local options that run on your own graphics card.

The Local AI and Mature packs hold the models only. The engine that runs them (llama.cpp) is part of the Runtime, so they need **the Runtime that came with version 0.2.7 or newer**. If your Runtime is older, install the full install from Nexus Mods first.

**Pictures (Companions can see) with Local AI need a vision file.** It is a small separate zip in the `vision` folder next to the pack: [`local-ai/vision/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/local-ai/vision) for Local AI standard and lite, [`mature/vision/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/mature/vision) for Mature lite and standard. Get the one for the model you use and extract it into the Cyberpunk 2077 folder like a pack (it writes one file into the Local AI folder's `models` folder, beside the model). If you turn Companions can see on and the file is missing, the game tells you once where to get it, and the model keeps answering from your words. The setting is off by default, and the file is read only while it is on.

Text and voice are separate choices. Pick one text option (Convai, Google Gemini, Local AI, or Mature) and one voice option (the built-in voices, OmniVoice, or a cloud voice). Any combination works. Several text packs can be installed at once: only one model loads at a time, and you switch in Settings.

## Install

1. Install the mod from [Nexus Mods](https://www.nexusmods.com/cyberpunk2077/mods/35436?tab=files) first, then close the game.
2. Extract the pack zip **into your Cyberpunk 2077 folder** (the one with `bin`, `archive` and `r6`), allowing folders to merge. Every zip already starts with the right folders (`bin`, `r6`, `archive` or `red4ext`). Extract the mod before the OmniVoice pack.
   - Don't extract into a new folder named after the zip (Windows' "Extract All" and 7-Zip's "Extract to *name*" do that by default). If it happens anyway with an optional pack, the mod moves the pack files into place by itself at the next start.
   - Vortex: For the Local AI and Mature packs Vortex shows "You Have Reached The Fallback Installer": choose "Yes, Install To Staging Anyway" and every file lands correctly. Two of them at once give "unresolved file conflicts" (they share identical licence and embedding model files): pick either one to load after the other, it makes no difference. The OmniVoice pack holds DLLs and Vortex can't install it: extract it by hand. The warning sign in the Version column and "external changes" at deploy are harmless.
   - Mod Organizer 2: the multilingual packs and PocketTTS models go INTO the mod's folder.
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
