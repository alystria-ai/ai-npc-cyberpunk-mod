# Voice model decisions and verification

## Current choice

The accepted six-layer student at update 6,000 remains unchanged. The user
cancelled the additional student-refinement run; Kaggle acknowledged cancellation.
The teacher is a training target and listening reference, not a production voice
provider.

Controlled Johnny comparisons used the same 22-second reference, text, seed,
FP32 precision and temperature 0.3. The user preferred CFG 2 over 1.25/1.5, then
preferred the existing adapted April teacher with **two LSD decoder steps** over
its one-step version and the stock September teacher. The weights remain the
accepted EMA at update 1,200. This sampling improvement is separate from further
weight training. Record the executed sampler count, not merely a config value.

The compatible September teacher was loaded whole and kept as a separate
alternative. Its tokenizer, latent calibration and FP32-equivalent Mimi weights
match; it has documented robustness training. Its stock voice was not the
user's preferred next baseline. A release date alone does not establish voice
likeness after domain adaptation.

## Model and training evidence

Actual exported tensors total 336.07M elements for the teacher and 109.50M for
the student, including the same 20.05M frozen Mimi codec. The backbones have
24/six layers at width 1,024. The provided English checkpoints do not supply a
larger pretrained teacher; changing depth or width would require a separate
architecture/initialization experiment.

The original teacher's development objective worsened 4.38% between its accepted
update 1,200 and update 2,000 while training loss fell. The next proposed run
starts from the accepted EMA with a fresh optimizer: LR 1e-5, 250-update warm-up,
EMA 0.999, effective batch 64 and a 2,000-update pilot cap. Further training is
judged from held-out performance and free-running speech, with raw/EMA kept
separate. A completed run can legitimately produce no eligible improvement.

## Corrected padding interpretation

Raw files contain roughly 300 ms of exact silence at each edge. The actual
2,743 accepted training alignments all have interior word cuts: leading silence
is voice conditioning, and the loader excludes about 13.11 minutes of file
tails. The raw 28-minute zero-sample count did not establish a supervised-silence
bug or explain the generated quiet prefix.

The baseline keeps native decoded WAVs and upstream word cuts, including its
last-word-plus-200-ms tail. The one-second eligibility requirement is a raw
window reserve; the subsequently cropped target can be shorter. New rows must
have a genuine disjoint cut and aligned words covered by their cached frames.

Codec-only 0/40/80-ms experiments retained every native nonzero sample. An 80-ms
right guard protected the final partial frame under floor-duration cache
storage. Omitted tails at smaller guards were extremely quiet; the tests did
not prove missing words or an audible minimum. Left-edge trimming changes
encoder context/phase. Those derivatives remain experiments, not adopted data.

## Development method

- Change one sampling variable at a time; preserve original audio and exact
  weights/reference/config hashes. Use listening for likeness and pacing.
- Authenticate actor, scene, localization, WEM and WAV provenance; verify actual
  wording, clipping, levels, duplicate recordings and historical exclusions.
- Keep unseen-scene development separate from new utterances in previously seen
  scenes. Preserve the original 94-clip regression panel and report coverage gaps.
- Bind staged audio, manifests, word spans and history ledgers before GPU
  allocation. Use fixed loss diagnostics, not learned loss-weight changes, for
  candidate selection.
- Synchronize distributed stop and I/O decisions; report planned versus reached
  speech checks and explicit candidate availability. Preserve the current model
  when checks reject a candidate.

The live-game student benchmark measured first PCM at **135 ms mean** across
five warm calls (127–148 ms), CPU FP32/two threads, zero VRAM and 1.68 GiB peak
RAM. The saved run's quiet prefix gives an ideal-consumer speech-onset estimate
of 826 ms. These exclude Convai, game transport and actual audio-device latency.
Teacher batch-generation times are a separate measurement.

Research basis: [official training recipes](https://github.com/kyutai-labs/pocket-tts/blob/41cbc84af539ea78a804ffca5f9c6edc1a22ce44/training/README.md)
and the [CALM paper](https://arxiv.org/abs/2509.06926). Local evidence lives in
the ignored `runtime/student-stream-livegame-20261003`,
`codec-boundary-check-20261003`, `teacher-sampling-screen-20261003` and
`teacher-next-screen-20261003` folders.
