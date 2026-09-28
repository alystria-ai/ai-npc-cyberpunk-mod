# Character speech comparison on the game laptop

September 28, 2026. These are generated-audio and timing checks, not listening acceptance or in-game playback acceptance.

## Conditions

- Cyberpunk remained open on the same RTX 4080 Laptop GPU (12,282 MiB total). One speech engine was resident at a time.
- Ana and Blue Moon used the same hash-verified dialogue references from the installed game. See [reference extraction](GAME_VOICE_REFERENCES.md).
- Held-out text: “Hey V, good to see you. Where are we headed next?”
- Native engine output, speed 1; no added EQ, gain, pitch change, denoising, mastering or postprocessing. Stock provenance watermarks remain enabled. Chatterbox reference loudness normalization was explicitly disabled.
- Two renders per character. The table uses the second render, with model loading and reference encoding outside the timed Chatterbox generation call. VoiceStudio timing includes its HTTP request and complete WAV response.
- These are **whole-WAV generation times**, excluding Convai and native playback. They are not time to first streaming packet. The short outputs have different durations (about 2.8–3.6 seconds); duration alone does not establish that every word is correct.

## Initial measurements

| Engine/configuration | Ana | Blue Moon | Notes |
| --- | ---: | ---: | --- |
| OmniVoice, 32 steps, VoiceStudio | 7.40 s | 8.15 s | First cold request: 63.14 s including loading and watermark initialization |
| OmniVoice, 16 steps, VoiceStudio | 4.06 s | 4.45 s | Same references, warmed service |
| Chatterbox Turbo, default CPU workers | 5.58 s | 6.16 s | 3,092 MiB peak allocated / 3,248 MiB reserved for the measured runs |
| Chatterbox Nano, four CPU workers | 2.05 s | 2.17 s | 2,153 MiB peak allocated / 2,328 MiB reserved |

The first Chatterbox model load took 23.13 seconds and first reference encoding took 49.16 seconds; the next reference took 0.59 seconds. These must happen during service/profile preparation, not on the player's first spoken turn. Saved conditioning prompts are about 165 KB per character in this test.

A repeat with four CPU workers, instead of PyTorch's default 24 on this machine, did not materially reduce Turbo's delay (Blue Moon: 6.13 seconds). The output samples remained identical for the fixed seeds. Do not claim a performance improvement from that setting. Nano was added because Turbo's measured delay remained high; its smaller model reduced the first comparison's latency and memory use.

The user requested recognizable voices, so a later Nano listening set used Johnny, Judy and Panam. These took **4.49, 4.36 and 4.29 seconds**, respectively, after reference preparation. Gameplay continued and GPU load was not held constant. The 2.05-second result is therefore not a latency guarantee or a controlled ranking across all scenes. Preserve the raw per-run receipts and measure again in the final persistent service.

Matching OmniVoice 32-step samples for those three characters took **10.29, 7.37 and 7.26 seconds** from the already-loaded service, including its reference preparation, watermark and WAV response. These familiar-character sets are in `chatterbox-nano-threads4-familiar/` and `omnivoice-familiar/`. All 26 generated WAVs passed the independent non-silence/format/clipping check. Original references accompany the listening comparison; user preference is pending. Benchmark workers were stopped afterward to return their GPU memory to the game.

All first twelve WAVs were independently checked: mono, 24 kHz, PCM16, non-silent, and zero full-scale clipped samples. No inference should be drawn about voice likeness from these numeric checks. VoiceStudio raw mode bypasses its mastering and loudness normalization, but retains its stock provenance watermark.

## Reproducibility and evidence

- `scripts/Benchmark-VoiceStudio.mjs`: explicit 32/16 step count, saved local profile IDs, unchanged reference checksums, serialized complete-WAV requests.
- `scripts/Benchmark-Chatterbox.py`: pinned code/model revisions, exact reference checksums, saved character prompts, fixed seeds, CUDA measurements; optional explicit CPU worker count for a targeted performance comparison.
- `runtime/voice-comparison/<configuration>/report.json` and WAVs: private local results, excluded from Git.
- `runtime/voice-comparison/wav-audit.json`: independent PCM measurements and file hashes.
- `runtime/chatterbox-environment.txt`: exact installed Python package versions for this run.
- [Engine survey and pinned sources](VOICE_ENGINE_COMPARISON.md).

Production still uses Convai/Kokoro. Do not activate the local provider until a voice has passed listening review and the chosen service is warm. A local provider failure preserves the written reply; it does not substitute another character's voice. The new audio requires its own speech/facial alignment; Convai's old audio timings are deliberately discarded.
