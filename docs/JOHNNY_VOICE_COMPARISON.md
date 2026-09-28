# Johnny Silverhand: original recording and five generated options

September 28, 2026. All five options received the same original Johnny line.
The listening pack contains his extracted game recording followed by the first
timed take from each option. Listening approval is pending.

**Follow-up:** [cold and warm timing with RT Ultra, Turbo and a fixed 60 FPS view](VOICE_RT60_COLD_WARM.md). All five options completed and released their GPU memory. The fifth result uses an experimental reduced-memory VoxCPM2 runtime and a new sample; it is distinct from this original all-GPU listening pack. The original recordings and measurements below remain unchanged.

## Listen

Private local files: `runtime/voice-comparison/johnny-original-line/listening/`.

| File | Contents | Duration |
| --- | --- | ---: |
| `00-original.wav` | Original game recording, unchanged after extraction | 7.80 s |
| `01-omnivoice-32.wav` | Generated: OmniVoice, 32 steps | 6.56 s |
| `02-omnivoice-16.wav` | Generated: OmniVoice, 16 steps | 6.56 s |
| `03-chatterbox-nano.wav` | Generated: Chatterbox Nano | 6.34 s |
| `04-chatterbox-turbo.wav` | Generated: Chatterbox Turbo | 4.94 s |
| `05-voxcpm2-10.wav` | Generated: VoxCPM2, 10 steps | 7.36 s |

The target is game subtitle ID `3743548582201815040`. The cloning reference is
a **different** Johnny recording, `3475057498618839040` (8.34 seconds). Both came
from hash-verified installed English dialogue. The old metadata contained
Windows-1252/UTF-8 mojibake; a lossless conversion repaired the reference and
target transcripts before generation. Earlier receipts are preserved.

No EQ, pitch, speed, gain, denoising or mastering was added. Engine reference
preparation and stock watermarks remain. OmniVoice and Chatterbox output 24 kHz
mono; VoxCPM2 outputs 48 kHz mono; the original remains 48 kHz stereo. All six
files are PCM16 WAVs, finite and non-silent, with zero full-scale samples.
Checksums were verified after copying. These checks do not establish likeness.

## Measured latency and memory

Windows 11, Intel Core i9-13980HX, RTX 4080 Laptop GPU (12,282 MiB VRAM),
31.63 GiB installed system RAM. Cyberpunk remained running. One speech engine
occupied the GPU at a time; game load was not held constant. These are useful
local observations, not a controlled GPU benchmark or a general latency promise.

One warmup preceded two recorded runs per option. All synthesis used CUDA.
Times below end when the complete waveform is ready; they exclude Convai, HTTP
transport, WAV file writing and native game playback. OmniVoice reuses cached
reference state; Chatterbox's reference encoding precedes its timed renders.
VoxCPM2 timings include its adapter's per-call reference handling. Streaming
time to first sound was not measured.

| Option | Warm renders | Audio lengths | GPU allocation peak | GPU reservation peak | Warm RAM peak | RAM peak including loading |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| OmniVoice 32 | 2.35–2.44 s | 6.56 s | 2.02 GiB | 2.17 GiB | 2.18 GiB | 3.03 GiB |
| OmniVoice 16 | 1.20–1.47 s | 6.56 s | 2.02 GiB | 2.17 GiB | 2.18 GiB | 3.03 GiB |
| Chatterbox Nano | 3.96 s in both runs | 6.34 s | 2.08 GiB | 2.14 GiB | 1.93 GiB | 3.70 GiB |
| Chatterbox Turbo | 5.07–5.51 s | 4.94 s | 2.98 GiB | 3.07 GiB | 1.94 GiB | 4.67 GiB |
| VoxCPM2 10 | 30.38–35.41 s | 7.36–8.64 s | Not captured; 5.31 GiB retained after rendering | Not captured | 11.51 GiB | 16.14 GiB |

GPU allocation is the engine's own PyTorch allocation, excluding driver and
game memory. Reservation is the allocator's reusable pool, not an additional
amount to add to allocation. VoxCPM2's sidecar reports current allocation only;
its value must not be presented as a measured peak. The earlier OmniVoice Judy
reference test reserved 4.23 GiB, so this cached-reference run's smaller number
is not a hardware minimum.

RAM is summed process-tree resident working set, sampled every 200 ms. Shared
library pages can be counted more than once. Windows private committed-memory
peaks were 6.58 GiB for OmniVoice, 7.60 GiB for Nano, 9.51 GiB for Turbo and
26.69 GiB for VoxCPM2; that is not all simultaneously resident physical RAM.
Game, OS and other applications need additional RAM and VRAM.

Loading is separate: OmniVoice took 16.44 s, Nano 13.33 s and Turbo 16.48 s.
Nano/Turbo then prepared the reference in 3.46/3.30 s. Their first generations
took 4.70/8.33 s. OmniVoice's first 32-step generation took 3.63 s. VoxCPM2's
first call took 66.14 s including lazy loading and its first render; its model
load was not timed separately. These are cached-download startup measurements,
not installation times. A live provider should prepare these before chat.

## System requirements and disk footprint

Published guidance and measured usage serve different purposes. No lower-end
hardware was tested here, and no hard minimum system RAM is established.

| Options | Published requirements or guidance | Cached weights and decoder |
| --- | --- | ---: |
| OmniVoice 32 and 16 | VoiceStudio recommends a dedicated GPU with at least 6 GB VRAM. CUDA is supported on Windows; other backends also exist. | 3.03 GiB, shared by both settings |
| Chatterbox Nano | Official source uses Python 3.11 and supports CUDA or CPU; the inspected README gives no numeric RAM/VRAM floor. | 1.81 GiB |
| Chatterbox Turbo | Official source uses Python 3.11 and demonstrates CUDA; the inspected README gives no numeric RAM/VRAM floor. | 2.78 GiB |
| VoxCPM2 | Model card lists approximately 8 GB VRAM, Python >=3.10, PyTorch >=2.5 and CUDA >=12. | 4.62 GiB |

Sources: [VoiceStudio OmniVoice guide](https://github.com/debpalash/VoiceStudio/blob/main/docs/engines/omnivoice.md),
[official Chatterbox source](https://github.com/resemble-ai/chatterbox/blob/5de7a54aa4e5e2baadb0182dde554908b48b85c2/README.md),
[VoxCPM2 model card](https://huggingface.co/openbmb/VoxCPM2).
Sizes are logical weight-file sizes per engine, including the required decoder;
shared cache blobs may be deduplicated. Python environments, references,
training data and experimental checkpoints are additional.

These runs used Torch 2.8.0+cu128 for VoiceStudio and VoxCPM2, and 2.6.0+cu124
for Chatterbox. Nano/Turbo used four host CPU workers; OmniVoice/VoxCPM2 used
24. Optional Torch compilation was disabled; ordinary CUDA stayed enabled.
Host-worker count is not the minimum CPU requirement.

## Provenance and reproduction

OmniVoice and VoxCPM2 use the actual adapters from the user-shared VoiceStudio
repository, revision `08a1592e3cb9b4c36beef5fa3185ec2313bb1fea`. The model authors
are k2-fsa and OpenBMB respectively. Chatterbox uses Resemble's source revision
`5de7a54aa4e5e2baadb0182dde554908b48b85c2` directly.

The benchmark is `scripts/Benchmark-VoiceListening.py`. Use VoiceStudio's
interpreter for `omnivoice` and `voxcpm2`, or the Chatterbox environment for
`chatterbox-nano` and `chatterbox-turbo`, one engine at a time:

```powershell
& .\vendor\reference-voicestudio\.venv\Scripts\python.exe scripts/Benchmark-VoiceListening.py --engine omnivoice --label johnny-original-line --original-line 3743548582201815040
```

An existing engine report blocks overwriting; choose a fresh label for a new
comparison. The same seed was used for each in-process take. VoiceStudio's
VoxCPM2 adapter does not forward the seed, so its two takes differ. The listening
pack always uses timed run 1, never a take chosen after quality scoring.

Per-engine reports retain model revisions, checksums, settings, warmups and both
timed takes. The pack's `report.json` records the copy checks and summary;
`quality-report.json` contains local Whisper/WavLM diagnostics. ASR can respell
names and contractions, and speaker similarity does not measure naturalness.
No automatic score establishes the winning voice.

The local ASR check produced the sentence in all six clips, with spelling or
pronunciation ambiguities around Dex DeShawn, workin' and choom. It transcribed
the name as "Dexter Sean" in OmniVoice 32/Nano and "Dexter Shone" in Turbo;
those differences require listening rather than silently changing or selecting
another take. The original recording was also transcribed as "working".

OmniVoice remains the leading latency candidate for live dialogue on this
machine. Voice quality still needs the user's comparison of these recordings.
The benchmark does not change the production Kokoro provider or validate
in-game cloned voice playback.
