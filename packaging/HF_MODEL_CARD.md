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

**Current version: 0.2.9.** The files are sorted into folders, and the file names stay the same from version to version, so links to them never change. The file list shows when each file was last updated.

| Folder | What is in it |
|---|---|
| top of the repository | The two files everyone needs: the Scripts and the Runtime. |
| [`local-ai/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/local-ai) | The Local AI packs, standard and lite. |
| [`mature/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/mature) | The Mature packs, lite and standard (adults only). |
| [`mic/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/mic) | The microphone packs, European and Asian languages. |
| [`voice/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/voice) | The OmniVoice pack. |
| [`updates/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/updates) | The Runtime updates: small zips that bring a Runtime you already have up to date. |
| [`multilingual/`](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/multilingual) | The voice language packs and the PocketTTS models. |

## Which files do I need?

| File | Size | What it is | Need it? |
|---|---|---|---|
| `Scripts.zip` | 3 MB | The mod itself, the in-game part. Also on Nexus Mods. | **Yes** |
| `Runtime.zip` | 1.1 GB | The background service: voices, lip sync, speech recognition, memory, the Local AI engine, and (new in 0.2.8) the decoder that lets V's voice follow a V voice-over mod. | **Yes** |
| `updates/` (folder) | 16 MB for the newest | The Runtime updates: small zips that bring a Runtime you already have up to date, instead of downloading the full Runtime. Every step is kept, one zip per release, named `Runtime-Update-<from version>-to-<to version>.zip`. Apply the update zips from the [updates folder](https://huggingface.co/alystria-ai/ai-npc-cyberpunk-mod-packs/tree/main/updates) one by one, starting from your version, each extracted over your Runtime (choose Replace if Windows asks). Files a version no longer needs are removed by the mod at the next start. | Optional: only if you have a Runtime installed |
| `local-ai/LocalAI-Standard.zip` | 5.3 GB | Local AI, standard: Gemma 4 E4B. Free and offline. Uses about 3.1 GB of video memory and needs about 6 GB free to start. Needs the Runtime of version 0.2.7 or newer. | Optional |
| `local-ai/LocalAI-Lite.zip` | 1.3 GB | Local AI, lite: Bonsai 2 4B. For smaller graphics cards, about 1.8 GB of video memory. Needs the Runtime of version 0.2.7 or newer. | Optional |
| `voice/OmniPack.zip` | 5.3 GB | OmniVoice: higher-quality local voices, 2 to 4 GB of video memory. Works with any text option. | Optional |
| `mature/Mature-Lite.zip` | 2.8 GB | **18+.** An uncensored Local AI model (Qwen3.5 4B fine-tune). Needs the Runtime of version 0.2.7 or newer. | Optional |
| `mature/Mature-Standard.zip` | 5.5 GB | **18+.** An uncensored Local AI model (Gemma 4 E4B fine-tune). Needs the Runtime of version 0.2.7 or newer. | Optional |
| `mic/MicPack-European.zip` | about 0.67 GB | Microphone in Russian, Ukrainian, Polish, Czech, Hungarian, German, French, Spanish, Italian and Portuguese, for Local AI and Custom endpoints (NVIDIA Parakeet TDT 0.6B v3, int8). Runs on the processor. | Optional |
| `mic/MicPack-Asian.zip` | about 0.24 GB | Microphone in Mandarin Chinese, Japanese and Korean for Local AI and Custom endpoints (SenseVoice Small, int8). Runs on the processor. | Optional |
| `multilingual/` (folder) | about 150-220 MB per file | Voice language packs (10 languages: the characters speak in the game's own dub voice when they reply in that language, with OmniVoice or the Mistral voice) and PocketTTS models (French, Italian, German, Spanish, Portuguese, for the Pocket voice). Get only your language; see the folder's README. | Optional |

**You can skip every optional pack.** The mod works without them with Mistral (cloud, your own free key) or the Convai free tier (cloud, the default, nothing to set up), both at no cost to your frame rate. Local AI can also use a model server you already run (KoboldCpp, LM Studio, Ollama or any OpenAI-compatible one) with no pack; the steps are on the Nexus Mods page. The packs only add local options that run on your own graphics card.

The Local AI and Mature packs hold the models only. The engine that runs them (llama.cpp) is part of the Runtime, so they need **the Runtime that came with version 0.2.7 or newer**. If your Runtime is older, update it first (the update zips in the `updates/` folder).

Text and voice are separate choices. Pick one text option (Convai, Mistral, Local AI, or Mature) and one voice option (the built-in voices, OmniVoice, or a cloud voice). Any combination works. Several text packs can be installed at once: only one model loads at a time, and you switch in Settings.

## Install

1. Close the game.
2. Extract each zip **into your Cyberpunk 2077 folder** (the one with `bin`, `archive` and `r6`), allowing folders to merge. Every zip already starts with the right folders (`bin`, `r6`, `archive` or `red4ext`). Use the same version of the Scripts and the Runtime, and extract the Runtime before the OmniVoice pack.
   - Don't extract into a new folder named after the zip (Windows' "Extract All" and 7-Zip's "Extract to *name*" do that by default). If it happens anyway with an optional pack, the mod moves the pack files into place by itself at the next start. The Scripts and Runtime are not moved: extract them again into the game folder.
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
