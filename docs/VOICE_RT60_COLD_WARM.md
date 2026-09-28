# Cold and warm voice timing with RT Ultra at 60 FPS

September 28, 2026. The four smaller options completed at 09:14:06–09:16:04 UTC.
A separate reduced-memory VoxCPM2 run completed at 09:32:28–09:35:30 UTC after
a fresh fixed-view confirmation. Matching the exact earlier scene and camera
was not independently verified. Earlier moving-view runs are superseded.

## Conditions

- Same laptop: RTX 4080 Laptop, 12,282 MiB VRAM, i9-13980HX and 31.63 GiB RAM.
- Saved game settings verified before every engine and after the batch: Ray
  Tracing Ultra, 2560×1440, DLSS Auto, frame generation off, FPS limiter enabled
  at 60. The settings did not change during the run.
- The user confirmed a fixed player position and camera in unpaused gameplay,
  with the laptop performance profile set to Turbo. Neither view nor focus was
  controlled by automation; the performance profile was user-reported.
- The exact same Johnny line, separate reference recording, transcript,
  pinned models, CPU-worker counts and synthesis settings as the original
  [listening comparison](JOHNNY_VOICE_COMPARISON.md).
- One fresh process per option, including separate processes for OmniVoice 32
  and 16. Each produced its first WAV and two warm replies, then exited before
  the next model loaded. There were no simultaneous speech engines.

## Results

| Option | Cold: process launch to first WAV | Warm: two complete-waveform renders | Audio duration | Peak engine VRAM reservation | Peak resident process-tree RAM |
| --- | ---: | ---: | ---: | ---: | ---: |
| OmniVoice 32 steps | **17.46 s** | **2.51–2.69 s** | 6.56 s | 2.16 GiB | 3.35 GiB |
| OmniVoice 16 steps | **12.16 s** | **1.38–1.39 s** | 6.56 s | 2.16 GiB | 3.35 GiB |
| Chatterbox Nano | **25.76 s** | **2.01–2.10 s** | 6.34 s | 2.14 GiB | 3.73 GiB |
| Chatterbox Turbo | **25.54 s** | **2.81–2.83 s** | 4.94 s | 3.07 GiB | 4.70 GiB |
| VoxCPM2 10, experimental reduced-memory runtime | **83.82 s** | **44.38–44.72 s** | 8.80 s | 3.82 GiB | 16.07 GiB |

Cold time is measured by the parent from worker launch until it receives the
flushed receipt for the first saved WAV. It includes Python/library startup,
model loading, reference preparation, first inference and file output. Model
weights and prepared references were already downloaded; OS file caches were
not flushed. This is **model/worker cold**, not first installation or a cold
Windows boot. There is one cold observation per option, not a latency guarantee.

Warm times measure only the generation call and its adapter work. Convai text
generation, HTTP transport and game playback are excluded. Two runs are a small
sample. The observed difference between OmniVoice's two cold starts includes
different model-load time and cache conditions, not only inference steps.

### Cold-time components

| Option | Model load | Explicit reference preparation | First generation |
| --- | ---: | ---: | ---: |
| OmniVoice 32 | 11.19 s | Cached adapter reference handling | 3.51 s |
| OmniVoice 16 | 7.95 s | Cached adapter reference handling | 1.88 s |
| Nano | 8.25 s | 2.43 s | 2.71 s |
| Turbo | 11.80 s | 1.60 s | 3.23 s |

These components do not sum to the complete cold measurement: framework imports,
worker startup, WAV conversion/writing and receipt delivery are additional.
Keeping a CPU worker or weights resident in system RAM could change this path;
that configuration has not been measured and must not inherit these numbers.

## Reduced-memory VoxCPM2

The successful fifth result uses the same pinned VoxCPM2 weights and original
Johnny reference through VoiceStudio, with a process-local experimental wrapper:

- Main speech transformers and diffusion decoder execute on CUDA. The audio
  codec, local feature encoder and text embeddings remain on CPU, using four
  host threads. No weights are quantized and no voice effects are added.
- Context cache reduced from 8,192 to 1,024 tokens; this short reference/text
  and generated reply fit inside that limit. Generation is capped at 128 audio
  tokens with automatic bad-case retries disabled. All three takes ended
  normally at 8.8 seconds, before the cap, and are byte-identical.
- `optimize=False` removes the automatic startup test sentence. Compilation was
  already disabled on Windows. Torch seed 1042 is set before each request.
- PyTorch allocation is limited to at most 4,300 MiB and checked against current
  whole-card headroom. This is an allocator budget, not a guarantee that driver,
  other-library or game allocations cannot exhaust the GPU.

The model loaded in 17.50 seconds after the sidecar's imports. Peak allocated
memory was 3,795.66 MiB, peak reservation 3,914 MiB, and retained allocation after
generation 3,760.88 MiB. Whole-card sampled memory peaked at 11,006 MiB. The
process-tree resident RAM peak was 16,451 MiB; private commit peaked at 27,086
MiB and is not the same as physical RAM. The parent reports 24 host threads;
the actual model sidecar uses four.

This modified placement has a CPU/transfer cost and is **not the unmodified
all-GPU VoxCPM2 measurement**. It demonstrates a completed run alongside the
game, not a production-ready low-latency solution or proof of the earlier
crash's cause. Voice quality still requires listening to the new sample.

## Memory release and game state

All four workers and their child processes exited normally. Whole-card GPU
usage returned to approximately 6,732–6,767 MiB after each option, with the game
still running. The voice models are no longer resident after this batch.
The later VoxCPM2 worker also exited normally with no owned processes left;
whole-card memory returned to 6,824 MiB. The game was present throughout both
sets of passive GPU samples and was responding afterward. Actual game FPS was
not recorded, so a constant 60 FPS is not claimed.

The VRAM column is the engine's peak PyTorch reservation during the recorded
renders, excluding driver overhead and the game. RAM includes imports/model
loading and sums process-tree working sets every 200 ms; shared pages can be
counted more than once. These values are observations, not hardware minima.

All twelve WAVs (one cold plus two warm per option) passed checksum, duration,
sample-rate, non-silence and clipping checks. Each was byte-identical to its
option in the previous Johnny listening pack. Timing changed; audio did not.

## VoxCPM2 and the interrupted runs

VoxCPM2 did not finish startup during the two preceding live attempts. The user
reported gameplay dropping to about 10 FPS while it was warming up. A snapshot
showed 11,525 MiB of whole-card GPU memory used and 100% GPU utilization.

The game exited near forced termination of the heavy worker in both attempts.
Both crash reports say `Gpu Crash for unknown reasons!`; the specific cause
was not established. This is not proof of an out-of-memory exception or proof
that a normal completed VoxCPM2 render necessarily crashes the game. The second
worker was initially allowed to finish gracefully, but its startup continued
to contend with gameplay, so it was terminated to restore availability.

After relaunching, the user approved testing the four smaller options and
recording VoxCPM2 as incomplete. It was excluded from the fixed-view batch and
is omitted by default from the live benchmark runner. Its earlier 30–35-second
warm result under a different game load remains a separate experiment.
The user subsequently requested inclusion of VoxCPM2. The bounded loading probe
and complete reduced-memory run above address that request without replacing
the interrupted all-GPU results with fabricated timings.

## Reproduction and evidence

`scripts/Benchmark-VoiceGameSession.py` launches hidden workers, samples whole
GPU load, records first-WAV wall time, verifies the graphics settings and checks
process cleanup. Use a new label to preserve existing results:

```powershell
& .\vendor\reference-voicestudio\.venv\Scripts\python.exe scripts/Benchmark-VoiceGameSession.py --label fresh-fixed-view --fixed-view-confirmed
```

The user must first confirm the fixed view and applied settings. Writing a
`stop-request.json` file in the run directory requests cancellation between
GPU operations and prevents the next engine starting. Cancellation cannot
preempt an already-running native initialization or generation operation.
The reduced-memory sidecar additionally checks the flag at CPU-module boundaries
inside generation, allowing cancellation between speech-generation steps.

For the experimental fifth option, add `--engines voxcpm2 --voxcpm-bounded` and
use another unique label. `scripts/VoxCPM2-BoundedWorker.py` applies the scoped
changes; vendor sources and cached weight files remain unchanged.

- `runtime/voice-comparison/johnny-rt60-fixed/run-context.json`: cold timings,
  settings snapshots, before/after GPU readings and process cleanup.
- `runtime/voice-comparison/johnny-rt60-fixed/summary.json`: measured summary
  and verification results.
- `runtime/voice-comparison/johnny-rt60-fixed/gpu-telemetry.jsonl`: whole-card
  samples every two seconds, with engine phases and game-process presence.
- Per-engine WAVs and reports under the same directory; the separate 16-step
  process is under `johnny-rt60-fixed-16/omnivoice/`.
- `runtime/voice-comparison/johnny-rt60-vox-bounded/`: completed fifth run,
  settings, timing and cleanup receipts, GPU telemetry, summary, three identical
  48 kHz WAVs, and `voxcpm2/bounded-memory.json` with actual module placement
  and memory readings. The separate load-only probe released allocation and
  reservation to zero before that process exited.
- `runtime/voice-comparison/johnny-rt-ultra-turbo-60fps/resource-incident.json`:
  crash report extracts and the interrupted VoxCPM2 experiment's limits.

## Implication for the mod

OmniVoice 16 was the fastest warm option in this run. Restarting the full speech
worker for every message would incur the measured cold delay. Before choosing
an idle VRAM policy, measure a persistent CPU worker with cached weights and
GPU release/reload separately. A shared engine can serve multiple character
references; these memory figures are not multiplied by the companion count.
Production remains on Kokoro and this benchmark changes no game speech settings.
