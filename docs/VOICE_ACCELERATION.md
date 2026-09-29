# Voice latency and memory, September 29

## Installed decision

Retain the base OmniVoice model, **FP16, 32 steps by default**, 16 optional.
The hidden worker now replays the original PyTorch forward through a bounded
CUDA graph. No TensorRT, quantization, new weights or audio processing is used
by the installed route. One model serves Johnny, Judy and Panam.

The first test below preceded the final stream-lifetime correction. The second
test validates the final implementation. All comparisons use the same sentence,
reference, seed and step count within a pair. This is a small engineering check,
not a statistical benchmark across arbitrary dialogue.

## Current-machine evidence

RTX 4080 Laptop, 12,282 MiB VRAM, driver 581.29, PyTorch 2.8.0+cu128.
Cyberpunk remained running. The user selected Balanced and a fixed gameplay
view for these comparisons. These are **not** the earlier RT Ultra / Turbo /
60 FPS experiment; game settings have since changed.

Test sentence: “Keep your eyes open, V. We can talk while we walk.”

| 32-step voice | Original before / after | First graph, setup included | Reused graph |
| --- | ---: | ---: | ---: |
| Judy | 1.764 / 1.940 s | 1.289 s | 1.028 s |
| Johnny | 1.751 / 1.743 s | 1.268 s | 1.016 s |
| Panam | 1.862 / 2.654 s | 1.357 s | 1.016 s |

The matching 16-step test gave 0.511–0.519 s on reused graphs; new-shape
capture gave 0.806–0.938 s. New dialogue usually needs a new shape, so the
reused-graph column must not be presented as guaranteed first-reply latency.
The 16-step new-shape advantage was small or absent in the follow-up test.

All six voice/step combinations produced byte-identical PCM WAVs with and
without replay, including originals generated again after restoring forward.
Voice switching and bounded fallback also preserved each baseline WAV.
Evidence: `runtime/voice-replay-20260929-121623/`.

### Final memory-lifetime check

Initial testing exposed about 8.125 MiB retained per newly created CUDA stream.
PyTorch documents cuBLAS workspaces per stream/handle. The installed adapter
therefore owns **one stream for its entire lifetime**, even when replacing
sentence graphs. It also captures the sampler's existing float32 logits cast.

Twelve alternating voice/quality renders replaced the single graph repeatedly.
Returning to the same shape had **0 MiB growth in live allocation**. The peak
PyTorch reservation was **2,166 MiB (2.12 GiB)**. Retained graph allocations were
roughly 19–20 MiB; additional reservation was up to 44 MiB. The voice plus game
and desktop used roughly 5.3–5.5 GiB in `nvidia-smi` samples. These definitions
are different: PyTorch reservation is not whole-device use, and on this Windows
setup `mem_get_info` did not agree with the whole-device `nvidia-smi` reading.

All twelve WAVs matched the corresponding eager baseline. Final 32-step renders
including shape replacement took 1.285–1.438 s; 16-step took 0.877–0.915 s.
Evidence: `runtime/voice-replay-20260929-122047/`.

### Earlier live power-profile observation

Before the user switched Silent to Balanced, two native first-speech estimates
were 12.72 and 10.34 s. After switching, two were 5.05 and 3.82 s with unchanged
FP16/32 code. Texts differed, so this is an observation, not an isolated power
benchmark. One Silent-mode phrase gap was 5.61 s. A later Balanced second phrase
was ready before its first phrase ended, but its native receipt was overwritten;
zero-gap playback is not claimed. Saved evidence:
`runtime/latency-investigation-20260929/live-before-after-power-profile.json`.

### Live replies after installing replay

Two user-triggered Judy replies at 32 steps measured approximately **3.64 s and
3.95 s from bridge receipt to first native audio**. The breakdown was:

| Stage | Reply 1 | Reply 2 |
| --- | ---: | ---: |
| Convai reply collection | 1.351 s | 0.951 s |
| First phrase local synthesis, new graph included | 1.375 s | 1.694 s |
| CPU phonetic analysis | 0.751 s | 1.096 s |
| First playable audio duration | 2.04 s | 7.40 s |

These are different live texts, not a controlled before/after comparison.
The first reply's next phrase needed 2.413 s to become ready after the first;
with only 2.04 s of initial audio this can leave a short gap. Its native gap
receipt was overwritten, so that gap is not claimed as measured playback.
The second reply had one phrase. Native facial diagnostics confirmed the v2
timeline and cleanup; the user then reported an occasional upper-lip defect,
tracked in `LIPSYNC_REFINEMENT.md`.

After the 7.40-second reply, PyTorch reported 1,981.86 MiB live allocation and
2,284 MiB reserved/peak. Evidence copies are
`runtime/latency-investigation-20260929/graph-live-*.json`.

The later visually accepted v4 Judy reply began at approximately **4.108 s**:
1.400 s Convai collection, 1.520 s local synthesis and 0.923 s lip analysis.
Its audio lasted 4.44 s and the native face reset normally. This also shows
that further reductions in first-reply delay must consider collection and
CPU lip analysis, not only the GPU model. Receipt copies use the
`v4-accepted-` prefix in the same evidence folder.

## Ownership, limits and rollback

- One graph, up to 640 combined reference/text/audio tokens; larger inputs use
  the original forward. No length padding or truncation changes generation.
- Retained allocation **and reservation** are checked against a 512 MiB
  additional-memory budget. Capture requires that budget plus a 1 GiB free
  margin, and rechecks the margin afterward. This is a fallback policy, not a
  guarantee against memory allocated concurrently by another application.
- Every token and mask buffer is refreshed. Same-length inputs must never
  inherit another speaker's reference mask. Single-worker serialization also
  owns the output buffer until the sampler consumes it.
- Low-memory capture is attempted once per render; another render can retry.
  Unsupported capture operators disable replay and use the original forward.
  An unhealthy CUDA context can still fail synthesis and use text fallback.
- The denoiser never reuses past keys/values; its unused KV-cache output is
  disabled while this adapter owns forward, then restored on close.
- Set `CYBERPUNK_CONVAI_CUDA_GRAPH=0` before starting the bridge to opt out.
  This needs only a bridge restart, never a game restart. Runtime state and
  per-turn latency receipts distinguish `cuda-graph` from `eager` fallback.

## Lessons from the supplied VoiceBench material

Eight related Downloads files were moved with SHA-256 verification to
`ref mods/voicebench-2026-09-29/`; `move-receipt.json` records their original paths.
The reference source was inspected, not installed as our implementation.

| Clue | Application here |
| --- | --- |
| CUDA graph replay removes repeated launch overhead | Applied to the original forward and its existing logits cast |
| Reuse buffers and bound shape ownership | One graph and one stream; explicit reserved-memory limit |
| Reference preparation belongs outside timed repeated calls | Already cached by the pinned VoiceStudio adapter; all three voices warm at startup |
| Avoid intermediate GPU copies | Embeddings already execute inside our graph; only current tokens/masks are copied |
| Free replaced model weights | No duplicate engine/transformer is loaded in this PyTorch path |
| Separate first capture from repeated inference | Both are reported; different sentences often recapture |
| FP8 may reduce GEMM work and weight storage | Tested separately below; not enabled in production |

His precision report measures an RTX 5090 with TensorRT 11.2.1.2, no concurrent
game, one synthetic cloning reference, and exact-text warming before timed
repeats. Shared-memory FP16 → FP8 changes clone median 316.5 → 270.5 ms and
reported device-wide used memory 5,600 → 5,036 MiB. Those are not per-model
memory figures or predictions for this laptop. The report explicitly leaves
human-clone likeness/naturalness unaccepted. TensorRT FP16 itself also changed
tokens/audio relative to the original PyTorch route.

## FP8 feasibility on this laptop

The user confirmed Balanced and a fixed gameplay view again. The production
bridge shut down gracefully, one experiment worker ran, then the normal FP16
service was restored. Cyberpunk remained running. No package, model or native
game changes were needed. Evidence: `runtime/voice-fp8-20260929-123855/`.

An independently authored candidate quantized 196 transformer linear layers
to E4M3 FP8 weights and activations using PyTorch 2.8's native `scaled_mm` on
Ada. Six utterances covering all three existing voice references calibrated
per-tensor activation maxima, with 10% headroom. Evaluation used separate text.
Attention, normalization, residuals, embeddings, output head and codec retained
their existing precision. Both routes used the same 32 steps and CUDA replay.
This is **not TensorRT** and does not reproduce its fusion or compiler behavior.

| Voice | FP16 warm | FP8 warm | Saved |
| --- | ---: | ---: | ---: |
| Judy | 1,047 ms | 978 ms | 68 ms / 6.5% |
| Johnny | 1,056 ms | 943 ms | 113 ms / 10.7% |
| Panam | 1,039 ms | 997 ms | 42 ms / 4.0% |

Each row has one measured repeated render, not a statistical latency estimate.
FP8's first captures took 1.63–1.90 s. The FP16 first renders also included
reference preparation, while FP8 reused those references; comparing those
first rows directly would overstate any FP8 advantage.

Live PyTorch allocation fell by approximately **395 MiB**, from about 1,972–1,974
to 1,577–1,579 MiB. Peak reservation was **2,124 MiB for the measured FP16 stage**
and **2,166 MiB for FP8**, with the FP8 peak counter reset after conversion.
Replacing weights inside an existing process can leave fragmented allocator
blocks; this is not a fresh-process FP8 memory measurement. It therefore does
not establish a reduction in the total VRAM occupied by the service.

All six FP8 test WAVs were finite, had no clipped samples, and each repeated
render matched its FP8 first render. All three differed from the FP16 output;
voice likeness, naturalness and transcription accuracy remain unqualified.
The six evaluation WAV pairs and calibration WAVs are retained in the evidence
folder without audio processing. No new datasets or character training were made.

**Decision:** keep FP16 replay as the default. This candidate gives a small
warm improvement but has not established lower reserved VRAM, better new-text
latency or acceptable voice quality. The result does not rule out a separately
fused TensorRT implementation; the coworker's 5090 results cannot stand in for
testing one on this laptop.

## Sources

- [PyTorch 2.8 CUDA graphs and cuBLAS workspace lifetime](https://docs.pytorch.org/docs/2.8/notes/cuda.html).
- [NVIDIA TensorRT compatibility and engine portability](https://docs.nvidia.com/deeplearning/tensorrt/latest/getting-started/support-matrix.html).
- [NVIDIA Ada FP8 hardware requirements](https://nvidia.github.io/TransformerEngine/support_matrix.html).
- Local supplied `tensorrt-report.md` and `precision-report.md` in the reference folder.
