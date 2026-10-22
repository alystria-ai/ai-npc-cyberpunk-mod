# Convai text → VoiceStudio cloned speech → native Cyberpunk audio

Research date: 2026-09-28. VoiceStudio checkout: `vendor/reference-voicestudio`, commit **08a1592e3cb9b4c36beef5fa3185ec2313bb1fea** (2026-09-27), package version 0.5.6. This is a shallow reference checkout. No dependencies, models, engine, game changes, or synthesis were run during this assessment. GPU use was subsequently authorized by the user; this assessment remained read-only. The APIs below were checked in source, not exercised against an installed VoiceStudio service.

## Recommended first implementation

Preserve the existing companion/session lifecycle and native speech adapter. Obtain text from Convai with TTS disabled, generate one WAV through VoiceStudio using the character's saved clone profile, validate it, then atomically publish it to the existing native WAV slot.

Benchmark **OmniVoice on CUDA** and **PocketTTS on CPU** with the same three extracted references and held-out lines. OmniVoice is the supported GPU candidate whose declared 6 GB floor fits the current approximate free memory; PocketTTS is the supported latency candidate that leaves the game GPU available. Select on the user's listening comparison and measured game-running latency. Neither engine has been locally qualified here.

Passive hardware snapshot: Intel i9-13980HX (24 cores / 32 logical processors), 33,959,800,832 bytes physical RAM; NVIDIA RTX 4080 Laptop GPU, 12,282 MiB total / 4,654 MiB used / 7,344 MiB free at inspection. Free GPU memory changes with game state. A model's nominal floor is not a promise of sufficient remaining memory during gameplay.

## 1. Convai text-only support is already installed

The workspace pins `@convai/web-sdk` **1.7.0**. Its installed declarations and implementation support:

```js
new ConvaiClient({
  // Existing key, character, session and transport fields remain.
  ttsEnabled: false,
  startWithAudioOn: false,
  enableLipsync: false,
  respondModes: { contextUpdate: 'silent' }
});
```

`ttsEnabled:false` becomes `default_tts_enabled:false` in the connection request. `client.toggleTts(false)` also exists, but configuring it at connection creation prevents initial unwanted TTS. STT is separate: explicit microphone mode can still use `toggleStt(true)` and the existing push-to-talk lifecycle. Do not activate the microphone when warming a character.

Evidence in the installed package:

- `node_modules/@convai/web-sdk/dist/core/types.d.ts:444–457`: microphone default and TTS option.
- `dist/core/ConvaiClient.js:476–479,1190–1201`: initial TTS/STT fields and runtime toggles.
- `dist/core/MessageHandler.js:153–166,220–257`: `bot-llm-started`, accumulated `bot-llm-text`, then `bot-llm-stopped` sets `isStreaming:false` and ends thinking.
- `dist/core/ConvaiClient.js:244–245,303–304`: thinking state and explicit `llmNoResponse` event.

Change `bridge/realtime-client.mjs` collection to wait for a **new finalized text message belonging to this turn**, with observed turn progress, instead of remote audio chunks, blendshape completion and 450 ms of silence. Handle `llmNoResponse` explicitly. No worklet, decoder primer, remote AudioContext or blendshape capture is needed in this mode. `startWithAudioOn:false` alone does not disable generated speech.

`bridge/convai-client.mjs` already supports REST text-only replies with `voiceResponse=False`. Keep its scoped sessions separate from realtime sessions. A VoiceStudio error must not trigger a second Convai request: retain the already-generated text and retry only synthesis or show its caption.

## 2. Exact VoiceStudio profile and generation contract

### Save each voice once

`POST /profiles`, multipart form:

| Field | Value |
|---|---|
| `name` | Character name |
| `kind` | `clone` |
| `ref_audio` | Clean local reference audio upload |
| `ref_text` | Exact words in that recording |
| `language` | `English` for the English game recording |
| `instruct` | Empty initially; avoid redesigning the source voice |

Returns a profile record containing `id` (currently an eight-character UUID prefix), `ref_audio_path`, `ref_text`, `language`, etc. `GET /profiles` and `GET /profiles/{id}` inspect saved profiles. `PUT /profiles/{id}` edits metadata; `PUT /profiles/{id}/audio` replaces the reference. Do not persist generated IDs as if they are portable across independent VoiceStudio data directories.

Source: [profile routes](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/api/routers/profiles.py#L90-L248).

Provide the transcript at creation: a blank transcript triggers best-effort local ASR, and a missing/mismatched transcript can add latency or contaminate the spoken line. For OmniVoice, the project recommends a clear 3–10 second passage; keep words and the exact crop paired. Choose isolated dialogue with the intended voice, without radio filters, overlap or music when the extracted assets offer it. Eight instances of one character should share one voice profile, not eight model copies. These are reference-conditioned profiles, not per-character model training.

Source: [OmniVoice reference guidance](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/docs/engines/omnivoice.md#L51-L90).

### Generate the native WAV

`POST /generate`, multipart form:

```text
text=<final Convai reply>
profile_id=<saved VoiceStudio profile id>
engine=omnivoice             # or pockettts for comparison
language=English
speed=1
effect_preset=raw
denoise=false
postprocess_output=false
max_chunk_chars=0
crossfade_ms=0
stream=false
```

For short dialogue, this disables application effect chains and long-text crossfading. Omit `duration` and style instructions. Sampling settings such as `num_step` should initially stay at the engine defaults; reducing quality steps is a later measured tradeoff.

**Response is WAV bytes (`audio/wav`), not JSON.** Read the body as binary. Headers carry `X-Audio-Id`, `X-Audio-Path`, `X-Audio-Duration`, `X-Gen-Time` and `X-Seed`. The saved artifact is also available at `/audio/{X-Audio-Path}`, but the bridge does not need a second download. Inspect the real WAV header for rate/duration and trust it over rounded metadata.

Sources: [request fields](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/api/routers/generation.py#L1558-L1595), [binary response](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/api/routers/generation.py#L2579-L2626).

`effect_preset=raw` skips mastering, the effect chain and peak normalization. Default `broadcast` adds processing. `denoise=false` also avoids OmniVoice's denoise conditioning token; `postprocess_output=false` avoids its output silence/fade/padding pass. Engines can ignore unsupported knobs. Reference preparation and model decoding remain engine-specific. The finalizer still invokes the configured provenance watermark path, and PCM saving clamps out-of-range samples before 16-bit encoding. Thus raw is not a claim of bit-perfect model output or the original actor's recording. Preserve configured provenance behavior.

Sources: [raw DSP bypass](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/api/routers/generation.py#L399-L440), [finalization](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/api/routers/generation.py#L1302-L1344), [WAV encoding](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/services/audio_io.py#L117-L217).

## 3. Streaming limits that affect latency

| API | What really streams in this commit | Fit for this mod |
|---|---|---|
| `/generate`, `stream=false` | Whole synthesis completes before WAV body transfer | Best first integration; preserves existing native utterance lifecycle |
| `/generate`, `stream=true` | NDJSON `start`, `chunk` (`seq`, base64 PCM16 `pcm`), `done` (`audio_path`, duration, timing); text chunks render one at a time | Raw DSP option exists, but a short single chunk still completes before any audio arrives |
| `/ws/tts` | One whole sentence is synthesized, then emitted as `start` metadata + PCM16 byte chunks; persistent socket accepts later requests | Defaults to mastering/normalization; no raw field; cannot expose engine token streaming |
| `/v1/audio/speech` | Full generation and encoding precede the optional chunked/SSE transfer | Convenient binary API, but not lower first-audio latency and no raw effect-preset field |

Sources: [NDJSON delivery](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/api/routers/generation.py#L2291-L2446), [WebSocket render and delivery](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/api/routers/tts_stream.py#L150-L185), [WebSocket chunks](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/api/routers/tts_stream.py#L377-L445), [compatible API final buffering](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/api/routers/openai_compat.py#L761-L798).

The native mod played a completed file from a fixed Audioware slot (written when this was researched; since 2026-10-22 each phrase is fed as PCM to the continuous browser renderer instead). Using a streaming HTTP API alone cannot change that. Sentence-at-a-time native playback would require explicit queue ownership, slot lifetimes, subtitle timing and group completion changes. First remove the Convai TTS wait and measure full-WAV local synthesis; only add sentence playback if the remaining gap warrants that work.

## 4. Supported engine choices on this Windows host

| Engine | Actual support / footprint evidence | Assessment |
|---|---|---|
| `omnivoice` / `omnivoice-subprocess` | Native CUDA cloning, 24 kHz. Declared 6 GB VRAM floor; default checkpoint about 2.4 GiB download. Subprocess variant uses the same Python environment with crash isolation. | First GPU quality comparison; one resident engine / one worker. Runtime memory must be measured alongside the game. |
| `pockettts` | Native Windows adapter, CPU-only, 100M parameters, 24 kHz mono, six languages. Pinned PocketTTS 2.1.0; separate CPU Python environment supported. Reference-state LRU holds 8 entries; model cached per language. | First latency comparison. Supports the party's 8 distinct voices without one model per voice. Similarity/prosody need listening. |
| `moss-tts-nano` | Managed Windows CUDA/CPU clone adapter, 100M parameters; 48 kHz stereo is downmixed to mono. Reviewed source pin, separate environment. No reliable measured VRAM figure found. | Lower-footprint GPU candidate if the first pair underperforms; own docs acknowledge lower quality than large engines. Style/speed controls ignored. |
| `cosyvoice` | Native CUDA/CPU cloning via reviewed managed CosyVoice 3 install, separate Python 3.10; about 5.4 GB weights. No verified Windows runtime peak or short-line latency found. | Supported additional comparison, but a larger setup with C++ build requirements. Do not equate download size to VRAM. |
| `voxcpm2` | Native CUDA adapter, 48 kHz cloning; upstream quotes ~8 GB VRAM and RTF ~0.30 on RTX4090. | Quality comparison only if enough game-running headroom; exceeds the inspected free-memory snapshot. |
| `omnivoice-gguf` | Supported quantized native adapter; project claims Q8 ~945 MB / Q4 ~659 MB. Fresh process per generation. Source Windows executable is a zero-byte placeholder; Windows build does not explicitly enable CUDA. | Requires a real verified binary and execution-device check. Not a ready warm CUDA path from this clone. |
| Qwen3-TTS 0.6B | No native Windows/CUDA registry entry. Current Qwen entry is Apple-only MLX 1.7B VoiceDesign; MLX cloning support is only confirmed for CSM. | Would require a new adapter. Not a supported configuration here. |
| Chatterbox Turbo | No native Windows/CUDA registry entry. Only a non-Turbo Chatterbox MLX catalog entry. | Would require a new adapter. Not a supported configuration here. |

Sources: [registry and lazy engines](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/services/tts_backend.py#L3024-L3136), [OmniVoice floor](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/services/tts_backend.py#L1405-L1427), [Pocket adapter](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/engines/pockettts/__init__.py#L1-L39), [Pocket cache and generation](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/engines/pockettts/main.py#L224-L283), [MOSS](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/docs/engines/moss-tts-nano.md), [CosyVoice](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/docs/engines/cosyvoice.md), [GGUF](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/docs/engines/omnivoice-gguf.md), [MLX restrictions](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/services/tts_backend.py#L2361-L2415), [VoxCPM upstream](https://github.com/OpenBMB/VoxCPM#model-overview).

Upstream PocketTTS advertises about 200 ms first chunk and 6× realtime on a MacBook Air M4. VoiceStudio's adapter calls `generate_audio`, not `generate_audio_stream`, so that first-chunk number does not describe this integration. The VoiceStudio benchmark table currently contains **no verified rows**, and an old Pocket documentation comment refers to a latency harness absent from this checkout. Treat its speed claims as leads for measurement. [Pocket upstream](https://github.com/kyutai-labs/pocket-tts#main-takeaways), [VoiceStudio benchmark status](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/docs/benchmarks.md#L29-L37).

## 5. Headless Windows setup and lifecycle

There is no supported core-only Python extra in this checkout. Electron's managed installer copies the runtime sources and runs **`uv sync --frozen --no-dev`** against the full project lock. This skips developer dependencies, not Gradio/ASR dependencies declared in the main project. Its readiness probe imports FastAPI, Uvicorn, OmniVoice, faster-whisper, sentencepiece, torch, torchaudio and torchvision. Hand-picking a smaller set would be a custom packaging effort, not reuse of the supported installer.

Sources: [managed runtime](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/electron/src/main/runtime-project.ts#L18-L46), [frozen install](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/electron/src/main/runtime-project.ts#L498-L538), [project dependencies](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/pyproject.toml#L36-L88).

A prepared source venv can run without building Bun/Electron:

```text
.venv/Scripts/python.exe -m uvicorn main:app --app-dir backend --host 127.0.0.1 --port 3900
```

Run hidden with source checkout as working directory, explicit `OMNIVOICE_DATA_DIR`, and `OMNIVOICE_TTS_BACKEND` pinned to the chosen engine. Use `OMNIVOICE_GPU_WORKERS=1` and retain single-engine residency. Windows startup already disables torch compilation; do not assume Linux FlashInfer/compile timings apply. Launch the prepared interpreter directly so normal game startup does not resync dependencies. Keep the process supervised and logs bounded. Check `/health`, `/system/info` and the selected `/engines/tts` row before generation. An engine health ping is not proof its model has loaded or rendered a clone.

Source: [actual Electron spawn arguments and Windows environment](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/electron/src/main/backend.ts#L287-L357).

Optional supported engine setup uses `POST /engines/sidecar/{engine_id}/install`; poll `GET /engines/sidecar/{engine_id}/install/status`. `require_desktop` means loopback origin, so these routes work for a local headless service. Pocket requires its normal model-access and license acceptance flow; the constructor enforces that. Do not silently substitute a stock voice if a clone is unavailable. OmniVoice is in the core runtime; its checkpoint still needs installing. Supplied transcripts and the default-off `OMNIVOICE_PRELOAD_TTS_ASR` avoid unnecessary ASR model residency.

Sources: [sidecar routes](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/api/routers/engines.py#L447-L518), [loopback gate](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/api/dependencies.py#L238-L248), [optional package pins](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/services/sidecar_install.py#L446-L481), [ASR preload](https://github.com/debpalash/VoiceStudio/blob/08a1592e3cb9b4c36beef5fa3185ec2313bb1fea/backend/services/model_manager.py#L1977-L1984).

## 6. Bridge changes and acceptance evidence

Proposed mapping, stored separately from Convai credentials:

```json
{
  "8ug8ear": {
    "voiceStudioProfileId": "<returned id>",
    "engine": "omnivoice",
    "language": "English",
    "referenceSha256": "<reference content hash>"
  }
}
```

Implementation boundaries:

1. `bridge/realtime-client.mjs`: text-only collection and explicit no-response handling; preserve manual STT and warmed sessions.
2. A separate VoiceStudio client: bounded request queue, abort signal, WAV response validation, explicit profile mapping and useful error classification. Only one active synthesis plus at most one valid preparation should be admitted initially.
3. `bridge/convai-bridge.mjs`: synthesize the completed reply before publication; include voice profile/reference revision and engine/settings in prepared-audio cache identity. Recheck request/generation/entity/listeners before writing slots and before publication.
4. `bridge/group-prefetch.mjs`: preserve fresh-session-only speculative Convai rules. Local TTS of an already-valid reply is memory-independent, but cancelled audio must never publish. HTTP abort alone is not proof server compute stopped; retain a bounded queue and ignore obsolete results.
5. `bridge/speech-audio.mjs`: reuse existing complete-WAV validation and atomic native storage. It accepts 8–96 kHz PCM and float WAVs, so 24 kHz Pocket/OmniVoice does not require an artificial 48 kHz upsample.
6. `mod/speech.lua` and the native adapter: preserve native cursor-driven completion/subtitles. Convai blendshape/caption timing will no longer describe the new waveform; do not reuse it or claim new lip-sync.

On companion spawn, keep Convai connections ready as already implemented, and ensure the chosen TTS model is loaded once. A deliberate local warm render can fill reference caches before the first conversation, but it must not send dialogue to Convai or play audio. Avoid switching engines per character in production: default single-engine residency will evict the preceding model. Profiles change the conditioning, not the resident engine.

Measure separately: Convai connection, first/final text, TTS queue, TTS first byte, complete WAV, store/publication, and actual native playback cursor. For each engine record cold first use, warm same voice, warm alternate voice, all eight party voices, and a game-running three-person exchange. Record RAM/VRAM peaks, frame impact, exact reference hashes, engine/model revision and settings.

Use held-out dialogue to compare identity, accent, intelligibility and delivery against the source references. Numeric clipping/noise/latency checks do not establish likeness or pleasant sound. Keep the existing native slot path until a measured remaining latency problem justifies streaming changes.
