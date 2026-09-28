# Character speech comparison on the game laptop

September 28, 2026. These are generated-audio and timing checks, not listening acceptance or in-game playback acceptance.

**Listening update:** the user rejected Chatterbox's voice quality after the Johnny/Judy/Panam comparison and said OmniVoice sounds better. VoiceStudio/OmniVoice is the leading option. Keep Chatterbox measurements as evidence, but do not promote that route. Every OmniVoice sample here came from the user-shared VoiceStudio repository's local backend.

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

## VoxCPM2: first familiar-character comparison

The user preferred base OmniVoice over the Judy fine-tuning pilot. On the same
running-game setup, the next samples use VoiceStudio's actual VoxCPM2 adapter,
package 2.0.3 and model revision `32279effe8c19989596f05d353d1447f51d9e915`.
This run calls the repository's adapter and isolated worker directly; it does
not use the HTTP route or imply native game playback. See [setup and scope](VOICE_ENGINE_COMPARISON.md#additional-engines-in-the-user-shared-repository).

The same original character references were used, with a longer common line:
“Hey V, slow down a second. We have been running all over Night City, and you
still have not told me what is on your mind.” Settings were 10 inference steps,
guidance 2.0, native 48 kHz, bfloat16 CUDA and no optional Torch compilation.
No EQ, pitch/speed changes, gain, denoising or mastering was added. The upstream
adapter trims edge silence in references and long silent tails in output.

| Character | Audio duration | Time to completed waveform | Full-scale saturated samples |
| --- | ---: | ---: | ---: |
| Johnny | 10.24 s | 162.29 s, including cold imports/model load/warmup | 0 |
| Judy | 5.92 s | 24.85 s | 0 |
| Panam | 8.32 s | 37.28 s | 0 |

The worker reported 5,431 MiB allocated after rendering; this is retained model
memory, not a peak measurement. The worker was shut down after the batch and GPU
use returned to roughly 4,652 MiB with the game still open. Warm timings include
reference preparation and all generation. They are currently too high to claim
a useful live-dialogue latency improvement. No same-seed comparison is claimed:
VoiceStudio's VoxCPM2 adapter does not forward a seed.

Samples, exact reference hashes and the completed report are retained under
`runtime/voice-comparison/voxcpm2-10steps-first-review`. Listening preference is
pending; base OmniVoice remains the reference. Do not adopt VoxCPM2 based on
sample rate, a successful WAV render or an automatic similarity score.

Local Whisper transcribed all intended words in Judy and Panam. In Johnny it
joined “over Night City” into “overnight city”; that may be a transcription error
and needs listening. WavLM similarity against eight separate original recordings
per character was 0.9213 for Johnny, 0.8851 for Judy and 0.9180 for Panam. These
are diagnostic values, not evidence that VoxCPM2 beats OmniVoice. All three PCM
headers, durations and SHA256 hashes were independently read back successfully.
The evaluation worker also exited; no candidate inference process remains.
