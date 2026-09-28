# Local cloned voices for Cyberpunk: engine decision

Assessed 2026-09-28 against the upstream revisions below. This document records the source/API research; subsequent local generation and timing results are in [VOICE_BENCHMARKS.md](VOICE_BENCHMARKS.md). A small Chatterbox package wheel was inspected to verify its published API.

## Recommendation

**Current listening decision: VoxCPM2 is preferred for quality; latency remains unresolved.** The user rejected Chatterbox, preferred base OmniVoice over its Judy training pilot, and then preferred the VoxCPM2 samples. Both OmniVoice and VoxCPM2 were rendered through actual code from the user-shared VoiceStudio repository. Their underlying models come from k2-fsa and OpenBMB respectively. Keep OmniVoice as the faster comparison. Qwen remains an untested fallback: only its source was cloned, with no environment or weights installed.

**Practical live-chat recommendation after the resource check: base OmniVoice at
32 steps**, with a resident model and cached references. The user highlighted
OmniVoice as a promising choice after seeing the warm 2.77-second result for
6.96 seconds of speech. Preserve VoxCPM2 as the preferred likeness comparison.
The 16-step mode is faster but needs listening review; full-service and actual
game latency still need measurement before calling the runtime ready.

The initial bounded test order was OmniVoice, Turbo, then Nano for latency. That comparison is complete; do not continue tuning the rejected Chatterbox variants. Qwen's 0.6B Base is the smaller option; assess the 1.7B Base memory budget when prioritizing voice similarity. Keep Flash and xVASynth out of the initial installation queue: Flash adds dependency/backend work; xVASynth's verified catalog does not cover the original three companions. These are workload choices, not a universal quality ranking.

## Comparison

| Engine | Character profile and output | Practical fit for this Windows laptop | Main unresolved point |
|---|---|---|---|
| **xVASynth v3 / xVAPitch** | Author-provided game voice models; local HTTP; complete WAV plus editor/phoneme data | Packaged Windows app exists. Current public source retains Python 3.9 / old PyTorch requirements. Resident checkpoint switching must be measured. | Catalog coverage and automatic line quality; current Ada GPU compatibility of the chosen binary |
| **Chatterbox Turbo** | English clone from reference longer than 5 seconds; reusable `Conditionals`; complete waveform | Direct PyTorch CUDA path, published package available. Upstream's documented test platform is Debian/Python 3.11, so Windows remains a local qualification step. | Actual voice match and warm render time during gameplay |
| **Chatterbox Nano** | Same API/decoder family, smaller 110M language backbone | Promising lower-memory option; upstream claims 3x realtime on 8 CPU cores. Requires current source, not the published 0.1.7 wheel. | CPU claim is not a measurement on this laptop; smaller backbone may affect these voices |
| **Chatterbox Flash** | English reference conditioning; 0.5B block-diffusion model; public Python call returns complete waveform | PyTorch SDPA/CUDA backend is available without FlashInfer. Own environment advisable because of documented Torch version conflicts. | Published low-latency result uses a separate H100/FlashInfer streaming setup |
| **Qwen3-TTS 12Hz 0.6B Base** | Reference plus exact transcript; reusable prompt; complete waveform | CUDA/bfloat16 loader; use **Base**, not CustomVoice. Initial test can avoid optional custom FlashAttention builds. | Official Python wrapper does not expose the advertised first-packet streaming path |
| **OmniVoice** | Reference plus transcript; reusable/saveable prompt; 24 kHz complete waveform | Already supported by the prepared VoiceStudio backend; FP16 CUDA, optional faster kernels. Keep ASR unloaded by supplying transcripts. | Gameplay memory headroom, voice match, and noncommercial weights license |

Sources: [xVASynth author page](https://www.nexusmods.com/cyberpunk2077/mods/2162), [Turbo/Nano README](https://github.com/resemble-ai/chatterbox/blob/5de7a54aa4e5e2baadb0182dde554908b48b85c2/README.md), [Flash README](https://github.com/resemble-ai/chatterbox-flash/blob/74e05baa8ce574bf2cc571702391a21f1b0d48c5/README.md), [Qwen API](https://github.com/QwenLM/Qwen3-TTS/blob/022e286b98fbec7e1e916cb940cdf532cd9f488e/qwen_tts/inference/qwen3_tts_model.py), [OmniVoice README](https://github.com/k2-fsa/OmniVoice/blob/08be0b4ccbac3e13e374e86fbfead4b4cac343e2/README.md).

### Memory: plausible candidates, unverified peak residency

At the initial survey, the hardware was an RTX 4080 Laptop GPU with 12,282 MiB total and 7,344 MiB free, plus approximately 32 GB RAM. No local runtime measurements existed then. Subsequent measurements are in [VOICE_BENCHMARKS.md](VOICE_BENCHMARKS.md); do not substitute download sizes or this old free-memory snapshot for current runtime use. Keep **one TTS engine resident**, serialize synthesis, and cache character prompts rather than loading one model per companion.

For download planning only, the selected checkpoint files total approximately: Turbo **2.78 GiB**, Nano **1.81 GiB**, Flash **2.98 GiB**, Qwen **2.34 GiB**, OmniVoice **3.03 GiB**. These include the relevant decoder/tokenizer and voice encoder where applicable; Turbo/Nano exclude the unused alternate `s3gen.safetensors`. These are file sizes, **not VRAM requirements**. Runtime dtype, activation/cache allocations, temporary loading copies, CUDA graphs, and game memory use determine fit. Nano's shared speech decoder is why its complete artifacts are much larger than “110M” suggests.

Official artifact trees: [Turbo](https://huggingface.co/ResembleAI/chatterbox-turbo/tree/749d1c1a46eb10492095d68fbcf55691ccf137cd), [Nano](https://huggingface.co/ResembleAI/chatterbox-nano/tree/71ccd1d0081b430592cea481f4307e764e07bc64), [Flash](https://huggingface.co/ResembleAI/chatterbox-flash/tree/4385507288b8197e6dab8b4e6b1603328d549d9d), [Qwen](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base/tree/5d83992436eae1d760afd27aff78a71d676296fc), [OmniVoice](https://huggingface.co/k2-fsa/OmniVoice/tree/c5fdb5ccb189668d56333f77ba2629f4cd7535f4).

## xVASynth: useful convenience, incomplete fit

The author's Cyberpunk page lists v3 voices for male V, Johnny, Judy, Panam, Kerry and River, plus older models for other named characters. It does not list **8ug8ear, Ana or Blue Moon**. Targeted searches did not establish an author-supported pack for them; this does not prove no community pack exists. The author explicitly distinguishes variable voice quality. A game-specific label does not prove better synthesis or require less listening evaluation. Its advertised `.lip/.fuz` plugin supports Bethesda games, not Cyberpunk. [Author catalog and plugins](https://www.nexusmods.com/cyberpunk2077/mods/2162)

The source HTTP server listens on port 8008. Relevant requests are:

- `POST /loadModel`: `model` (checkpoint path **without** `.pt`), `modelType`, `instance_index`, `pluginsContext` (JSON encoded **string**), optional `base_lang`/`model_speakers`.
- `POST /synthesize`: `modelType`, `sequence`, `outfile`, `pace`, `vocoder`, `pluginsContext`, `instance_index`, `device`, `base_lang`, `base_emb`, `useSR`, `useCleanup`; optional pitch/duration/energy/style controls.
- `POST /getG2P`: `text`, `base_lang`.

Load values from the selected voice's metadata. In this revision, xVAPitch expects `base_emb` to be a string even when using the loaded default; omission can reach a `None` membership check. `/synthesizeSimple` also forwards optional values to the same implementation, so it is not automatically a safer minimal contract. Responses are text/editor data; audio is written to `outfile`, not returned as WAV bytes. [Server contract](https://github.com/DanRuta/xVA-Synth/blob/9c563ae5065f802cbbe39d5ce94745f2383f22a1/server.py#L235)

xVAPitch exports predicted durations, phoneme text, pitch and energy, potentially useful for a future facial adapter. Conversion into Cyberpunk animation controls and correct playback timing remain separate work. Its raw inference already peak-normalizes to PCM16 at 22,050 Hz. `useSR=false` and `useCleanup=false` avoid the additional neural resampling/cleanup stages; they do not remove that normalization. [Inference implementation](https://github.com/DanRuta/xVA-Synth/blob/9c563ae5065f802cbbe39d5ce94745f2383f22a1/python/xvapitch/model.py#L605)

## Exact standalone integration seams

All calls below require a persistent Python worker around the library. They are not existing HTTP routes supplied by this mod or VoiceStudio. Use separate environments: Qwen, Chatterbox and VoiceStudio have differing dependency pins.

### Chatterbox Turbo / Nano

`ChatterboxTurboTTS.from_pretrained(device="cuda", nano=False)` loads Turbo; `nano=True` selects Nano in the pinned source. Call `prepare_conditionals(reference, norm_loudness=False)` once for each clean reference, save/cache its `Conditionals`, then select that prompt and call `generate(text)` under a single synthesis lock. Passing `audio_prompt_path` on every call re-encodes the reference. The model holds one mutable `conds` field, so simultaneous character requests must not swap it mid-generation. Keep the default output watermark; no extra EQ, pitch shift or mastering is needed. The supplied reference must be **longer than 5 seconds**. [Implementation](https://github.com/resemble-ai/chatterbox/blob/5de7a54aa4e5e2baadb0182dde554908b48b85c2/src/chatterbox/tts_turbo.py#L70)

**Published-package trap:** PyPI `chatterbox-tts==0.1.7` has `from_pretrained(device)` and no Nano code. Its inspected wheel SHA256 is `83782500e3ad4e7c919132e9d7eb8755f29f57c5bde5ec48c655ca23a4eb113c`. For that release, omit `nano=False` even for Turbo. Pin the source revision below if using Nano. [Release metadata](https://pypi.org/pypi/chatterbox-tts/0.1.7/json)

### Qwen3-TTS 0.6B Base

Load `Qwen3TTSModel.from_pretrained("Qwen/Qwen3-TTS-12Hz-0.6B-Base", device_map="cuda:0", dtype=torch.bfloat16)`. Build `create_voice_clone_prompt(ref_audio=reference, ref_text=transcript, x_vector_only_mode=False)` once. Call `generate_voice_clone(text=text, language="English", voice_clone_prompt=prompt)`; it returns `(waveforms, sample_rate)`. Speaker-vector-only mode avoids the transcript but discards richer reference conditioning. The method explicitly documents that `non_streaming_mode=False` does **not** expose actual streaming generation. [Exact API](https://github.com/QwenLM/Qwen3-TTS/blob/022e286b98fbec7e1e916cb940cdf532cd9f488e/qwen_tts/inference/qwen3_tts_model.py#L356)

### OmniVoice / Flash

OmniVoice: `OmniVoice.from_pretrained("k2-fsa/OmniVoice", device_map="cuda:0", dtype=torch.float16)`, then `create_voice_clone_prompt(ref_audio=reference, ref_text=transcript)`. Prompt objects have `save`/`load`; `generate(text=text, voice_clone_prompt=prompt, num_step=32)` returns waveform arrays at 24 kHz. Try 16 steps only as an explicit speed/quality comparison. [API and prompt persistence](https://github.com/k2-fsa/OmniVoice/blob/08be0b4ccbac3e13e374e86fbfead4b4cac343e2/README.md#L143)

Flash: `ChatterboxFlashTTS.from_pretrained("ResembleAI/chatterbox-flash", device="cuda")`, `prepare_conditionals(reference)`, then `generate(text, backend="torch")`. This route uses PyTorch SDPA; optional FlashInfer can be evaluated later. Despite the paper's streaming system, this public wrapper computes speech tokens and decodes the completed waveform before returning. [Implementation](https://github.com/resemble-ai/chatterbox-flash/blob/74e05baa8ce574bf2cc571702391a21f1b0d48c5/chatterbox_flash/tts.py#L229)

## Timing evidence and acceptance

Flash reports **118 ms first packet / RTF 0.107** for its default efficiency configuration at concurrency 1, using H100 GPUs and FlashInfer. Its more aggressive settings trade quality for speed. These results neither describe the public whole-waveform wrapper nor this Windows laptop. [Paper, implementation and Table 3](https://arxiv.org/html/2605.30748v1#S3.SS3)

OmniVoice's current benchmark gives batch-1 RTF **0.0899 baseline**, **0.0430 FlashInfer**, **0.0367 with CUDA graphs**, measured on an H100 with 32 steps and a Chinese voice-cloning dataset. This is a useful reason to test the baseline; it is not local performance evidence. [Benchmark conditions](https://github.com/k2-fsa/OmniVoice/blob/08be0b4ccbac3e13e374e86fbfead4b4cac343e2/README.md#L371)

For the current game path, audible delay includes Convai text completion, queue wait, **whole-WAV render**, atomic slot publication, and native playback start. A first network packet or a library's RTF is not that delay. Record cold load separately; then test the same three clean 6–10 second references and held-out short lines with the game running. Record warm request-to-WAV, peak GPU memory, native playback acknowledgement, failures, and the user's voice-match/naturalness preference. Keep model loading and reference encoding out of subsequent turns. Stop after a candidate meets the listening and latency requirements; do not install the whole table.

## Distribution constraints

Chatterbox Turbo/Nano/Flash declare MIT licenses; Qwen's code and 0.6B Base model declare Apache-2.0. OmniVoice code is Apache-2.0 but its **pretrained model is CC-BY-NC**, explicitly stated in its model card. xVASynth source is GPL-3.0, while its Nexus downloads have separate redistribution/asset-use permissions. Keep those downloaded packs and game reference recordings out of a redistributable mod package unless their applicable permissions allow inclusion. [Chatterbox](https://github.com/resemble-ai/chatterbox/blob/5de7a54aa4e5e2baadb0182dde554908b48b85c2/LICENSE), [Flash](https://huggingface.co/ResembleAI/chatterbox-flash/tree/4385507288b8197e6dab8b4e6b1603328d549d9d), [Qwen model](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base/tree/5d83992436eae1d760afd27aff78a71d676296fc), [OmniVoice model license](https://huggingface.co/k2-fsa/OmniVoice/blob/c5fdb5ccb189668d56333f77ba2629f4cd7535f4/README.md#L781), [xVASynth source](https://github.com/DanRuta/xVA-Synth/tree/9c563ae5065f802cbbe39d5ce94745f2383f22a1), [pack permissions](https://www.nexusmods.com/cyberpunk2077/mods/2162).

## Pinned code revisions

| Project | Revision |
|---|---|
| xVASynth | `9c563ae5065f802cbbe39d5ce94745f2383f22a1` |
| Chatterbox Turbo/Nano | `5de7a54aa4e5e2baadb0182dde554908b48b85c2` |
| Chatterbox Flash | `74e05baa8ce574bf2cc571702391a21f1b0d48c5` |
| Qwen3-TTS | `022e286b98fbec7e1e916cb940cdf532cd9f488e` |
| OmniVoice | `08be0b4ccbac3e13e374e86fbfead4b4cac343e2` |
| VoiceStudio, existing baseline | `08a1592e3cb9b4c36beef5fa3185ec2313bb1fea` |

See [VOICESTUDIO_RESEARCH.md](VOICESTUDIO_RESEARCH.md) for the already-inspected Convai text-only switch, VoiceStudio HTTP fields, raw-audio settings, and native WAV constraints.

## Additional engines in the user-shared repository

After the Judy LoRA pilot, the user preferred base OmniVoice and asked to try
other options already included in VoiceStudio. The adapter is set aside; lower
training loss did not establish better audible quality. See [training evidence](VOICE_TRAINING.md).

VoiceStudio's [engine catalog](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/docs/engines/README.md)
also includes VoxCPM2, IndexTTS 2.5, CosyVoice 3, GPT-SoVITS and MOSS-TTS engines.
Their presence is not evidence that they sound better for these characters.

- **VoxCPM2 is the next listening candidate.** Its actual VoiceStudio adapter
  supports cloning with the reference recording plus its exact transcript;
  the native output is 48 kHz. A higher sample rate alone does not establish
  better likeness. [Model card](https://huggingface.co/openbmb/VoxCPM2),
  [VoiceStudio adapter](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/engines/voxcpm2_subprocess/main.py).
- **IndexTTS 2.5 is another candidate**, with separate reference-voice and emotion
  controls. It needs its own environment and has not been installed or measured
  here. [VoiceStudio guide](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/docs/engines/indextts.md).

The VoxCPM2 comparison uses package 2.0.3 in `vendor/voxcpm2-runtime`, Torch
2.8.0+cu128 and its matching torchaudio, and model revision
`32279effe8c19989596f05d353d1447f51d9e915`. The external environment's import and
CUDA probes passed before writing VoiceStudio's completion marker. Its full
dependency receipt is retained there; this is not the app-managed Torch 2.11
installation recipe. OmniVoice's environment and weights are unchanged.

`scripts/Compare-VoiceStudioEngine.py` calls the real VoiceStudio engine adapter
and its isolated worker directly. This avoids the HTTP application's unrelated
OmniVoice startup preload, which would consume GPU memory during this comparison.
It does not replace the engine implementation or claim HTTP/native game playback
acceptance. The adapter retains reference edge trimming and output-silence
trimming; no mastering, EQ, pitch changes, denoising or volume adjustment is added.
Its VoxCPM2 adapter does not forward a fixed seed, so this is not a same-seed
comparison with OmniVoice. Optional Torch compilation is disabled on Windows.

The private model receipt is `runtime/voxcpm2-model.json`; listening WAVs and
per-character receipts are under `runtime/voice-comparison`. Run with VoiceStudio's
interpreter:

```powershell
& .\vendor\reference-voicestudio\.venv\Scripts\python.exe scripts/Compare-VoiceStudioEngine.py --label first-review
```

Use a new label for another run. The worker is released after the batch; this
comparison does not change the production speech provider or restart the game.

The subsequent [Johnny original-line comparison](JOHNNY_VOICE_COMPARISON.md)
contains an original recording plus OmniVoice 32/16, Chatterbox Nano/Turbo and
VoxCPM2 10-step takes. It records published system guidance separately from
actual GPU allocation and process-tree RAM, and preserves both warmed timings.
