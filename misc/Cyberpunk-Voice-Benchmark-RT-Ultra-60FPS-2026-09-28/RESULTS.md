# Johnny Silverhand — voice benchmark results

**September 28, 2026 · Completed tests only**

## Test setup

- **Game:** Cyberpunk 2077, Ray Tracing Ultra, 2560×1440, DLSS Auto, frame generation Off, **60 FPS cap**.
- **Computer:** RTX 4080 Laptop GPU (12,282 MiB VRAM), Intel i9-13980HX (24 cores / 32 threads), 31.63 GiB system RAM, Windows 11, NVIDIA driver 581.29.
- **Laptop profile:** Turbo (user-reported). Standing still with a fixed camera in normal, unpaused gameplay (user-confirmed).
- One voice engine at a time. Same Johnny reference and target sentence for every option. The original target recording is separate from the cloning reference.

## Results

| Voice option | Cold start to full audio | Warm render 1 | Warm render 2 | Audio length | Peak voice VRAM reserved | Peak voice process RAM |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| OmniVoice 32 steps | 17.46 s | 2.69 s | 2.51 s | 6.56 s | 2.16 GiB | 3.35 GiB |
| OmniVoice 16 steps | 12.16 s | 1.39 s | 1.38 s | 6.56 s | 2.16 GiB | 3.35 GiB |
| Chatterbox Nano | 25.76 s | 2.10 s | 2.01 s | 6.34 s | 2.14 GiB | 3.73 GiB |
| Chatterbox Turbo | 25.54 s | 2.83 s | 2.81 s | 4.94 s | 3.07 GiB | 4.70 GiB |
| VoxCPM2 10 steps* | 83.82 s | 44.72 s | 44.38 s | 8.80 s | 3.82 GiB | 16.07 GiB |

**Cold** includes starting a fresh worker, importing libraries, loading the model, preparing the reference and saving the first complete WAV. Model files were already downloaded; Windows file caches were not flushed. There is one cold observation per option.

**Warm** means generating another complete reply with the model already loaded. Convai text generation, network time and game playback are excluded. This is not time to the first streamed audio. Two warm renders are a small sample, not a latency guarantee.

**Memory** is for the voice engine/processes, in addition to the game and OS. VRAM is peak PyTorch reservation, including its reusable pool but excluding driver overhead. RAM is the sampled sum of resident process-tree working sets, including loading; shared pages may be counted more than once. These values are observations, not hardware minima.

### VoxCPM2 configuration

\* **VoxCPM2 uses an experimental reduced-memory setup.** Its main speech transformers and diffusion decoder run on the GPU; audio encoding/decoding, the local feature encoder and text embeddings run on the CPU using four threads. The same original weights are used without quantization or added voice effects. The context cache is reduced to 1,024 tokens, the automatic startup test sentence is disabled, and generation is capped at 128 audio tokens with automatic retries disabled. The 8.8-second line finished normally before that cap.

This configuration completed successfully alongside the game, but its CPU work/transfers have a cost. It is not an unmodified all-GPU VoxCPM2 result. The four smaller options ran together in one fixed-view session; VoxCPM2 ran in a separate confirmed fixed-view session with the same saved graphics settings. Exact matching of the scene/camera across sessions was not independently verified.

## Audio recordings

All samples say the same line:

> My man, Dex DeShawn. How’s that quiet life workin' out for you now, choom?

[Original Johnny game recording — 7.80 seconds](Audio/00-Johnny-original.wav)

| Voice option | Cold recording | Warm recording 1 | Warm recording 2 |
| --- | --- | --- | --- |
| OmniVoice 32 | [Cold](Audio/01-OmniVoice-32-cold.wav) | [Warm 1](Audio/01-OmniVoice-32-warm-1.wav) | [Warm 2](Audio/01-OmniVoice-32-warm-2.wav) |
| OmniVoice 16 | [Cold](Audio/02-OmniVoice-16-cold.wav) | [Warm 1](Audio/02-OmniVoice-16-warm-1.wav) | [Warm 2](Audio/02-OmniVoice-16-warm-2.wav) |
| Chatterbox Nano | [Cold](Audio/03-Chatterbox-Nano-cold.wav) | [Warm 1](Audio/03-Chatterbox-Nano-warm-1.wav) | [Warm 2](Audio/03-Chatterbox-Nano-warm-2.wav) |
| Chatterbox Turbo | [Cold](Audio/04-Chatterbox-Turbo-cold.wav) | [Warm 1](Audio/04-Chatterbox-Turbo-warm-1.wav) | [Warm 2](Audio/04-Chatterbox-Turbo-warm-2.wav) |
| VoxCPM2 10 (reduced memory) | [Cold](Audio/05-VoxCPM2-10-cold.wav) | [Warm 1](Audio/05-VoxCPM2-10-warm-1.wav) | [Warm 2](Audio/05-VoxCPM2-10-warm-2.wav) |

All **15 generated recordings** are included, copied without additional processing. The three recordings within each option happen to be byte-identical; they are retained individually so every measured render is available. The original is stereo; generated samples are mono. No EQ, pitch shifting, gain boost, speed change or mastering was added. Native engine reference preparation remains in place. Listening is needed to judge likeness and naturalness; timings do not measure voice quality.

## Requirements and storage

Published guidance is separate from the measured use above. Other machines were not tested, and the game requires additional memory.

| Engine | Published guidance | Cached weights / decoder |
| --- | --- | ---: |
| OmniVoice 32 / 16 | VoiceStudio recommends a dedicated GPU with at least 6 GB VRAM; Windows CUDA is supported. | 3.03 GiB, shared by both settings |
| Chatterbox Nano | Python 3.11; CUDA or CPU. The inspected official README gives no numeric RAM/VRAM minimum. | 1.81 GiB |
| Chatterbox Turbo | Python 3.11; official examples use CUDA. The inspected official README gives no numeric RAM/VRAM minimum. | 2.78 GiB |
| VoxCPM2 | Official guidance: approximately 8 GB VRAM, Python ≥3.10, PyTorch ≥2.5, CUDA ≥12. Our measured result uses the modified setup described above. | 4.62 GiB |

Sources: [VoiceStudio OmniVoice guide](https://github.com/debpalash/VoiceStudio/blob/main/docs/engines/omnivoice.md), [Chatterbox official source](https://github.com/resemble-ai/chatterbox/blob/5de7a54aa4e5e2baadb0182dde554908b48b85c2/README.md), [VoxCPM2 model card](https://huggingface.co/openbmb/VoxCPM2).

These tests used PyTorch 2.8.0+cu128 for VoiceStudio/VoxCPM2 and 2.6.0+cu124 for Chatterbox. Python environments, reference recordings and training assets require additional disk space. Minimum system RAM was not established.

## What this means for the mod

- **OmniVoice 16 was the fastest warm option:** about 1.38 seconds for this line.
- **Listening decision: OmniVoice 32 is the user's preferred option.** OmniVoice 16 will be the faster choice in Settings. The user disliked the gaps in VoxCPM2's pacing; it is not selected for the mod.
- All voice workers and their child processes exited normally and released their GPU memory. The game stayed running during the completed tests. **Actual game FPS was not measured**; the 60 FPS cap does not prove a constant 60 FPS.
- The selected mod policy keeps one shared OmniVoice model warm for Johnny, Judy and Panam. All other characters keep Convai voices. Both step counts use FP16 on CUDA through PyTorch, without TensorRT; 16/32 denotes generation steps, not floating-point precision.
- These are engine benchmarks. Local cloned speech still needs live mod acceptance; later integration checks under changed game settings are kept separate from these measurements.
