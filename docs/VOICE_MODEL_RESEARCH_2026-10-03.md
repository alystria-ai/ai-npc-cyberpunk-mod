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
update 1,200 and update 2,000 while training loss fell. The new teacher-only run
starts from the accepted EMA with a fresh optimizer: LR 1e-5, 250-update warm-up,
EMA 0.999, effective batch 64 and a 2,000-update pilot cap. Further training is
judged from held-out performance and free-running speech, with raw/EMA kept
separate. A completed run can legitimately produce no eligible improvement.

The loader samples uniformly by recording. The final qualified pool contains
1,744 clips across 72 voices: Johnny has 122, Judy 158 and Panam 499. Together
they account for 44.67% of clip draws. Equal sampling by character would replay
singleton recordings roughly 24 times more often, so the first pilot keeps the
existing sampler and adds recording variety. Clip counts do not measure target
frame exposure; actual prepared-cache and training receipts record that separately.

Both sampler and EOS heads remain trainable for that first pilot. A later
controlled comparison could freeze only `flow_net`, matching upstream
`freeze_head`; that option does not freeze EOS. Such a run would need explicit
enforcement in this wrapper, which bypasses the upstream training entry point.

## Current cloud run

The first teacher-improvement run failed during preparation because four
teacher-only `Spec.option` calls omitted their required defaults. It made no
training updates. The correction passed an actual preparation check with three
training clips and every evaluation-panel row; that fixture does not qualify
the full training cache.

The corrected retry is private Kaggle kernel **136850641, version 1**, with
frozen source SHA256
`6168e5903d7c9661a8b5aa291b626c61f62d8108a5c910cf68a551d70c50b0ca`.
It completed successfully. The actual cache gate passed for all 1,744 training
rows. Two Tesla T4 GPUs trained with FP16 activation precision and no nonfinite
gradient attempts. Training stopped at new-run update 1,250 after four validation
checks without the required improvement; the stop reason is `heldout_plateau`.

The speech-tested EMA candidate is update 500. Relative to the accepted
two-step anchor, its primary unseen-scene objective was 0.674% lower, the
original 94-clip objective 0.514% lower and the conditional objective 0.477%
lower. These are modest descriptive loss improvements, not a voice-likeness
score. All 18 candidate probes completed. The EMA check at update 0 and raw/EMA
checks at 500/1,000 completed; 1,500/2,000 were not reached because training plateaued.
The exported FP32 model remains a listening candidate, not a production provider
or an automatic replacement for the accepted student.

Actual receipts live in the ignored
`runtime/kaggle-pocket-teacher-improve-retry-output/teacher-improve-results`;
the source/private-version readback is in
`runtime/kaggle-teacher-improve-retry-monitor`. The failed run, retry source,
input corpus and accepted student remain distinct.

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
- Forced alignment places the supplied text on audio; it does not independently
  verify that text. The original training ledgers retained no free-ASR wording
  evidence. A separate GPU audit is prepared for 2,743 train, 94 development and
  76 protected test recordings. Its disagreements require review and remain
  uncertain rather than automatically becoming subtitle corrections.
- Keep unseen-scene development separate from new utterances in previously seen
  scenes. Preserve the original 94-clip regression panel and report coverage gaps.
- Bind staged audio, manifests, word spans and history ledgers before GPU
  allocation. Use fixed loss diagnostics, not learned loss-weight changes, for
  candidate selection.
- Synchronize distributed stop and I/O decisions; report planned versus reached
  speech checks and explicit candidate availability. Preserve the current model
  when checks reject a candidate.
- Check cloud source size before submission. The first wording-audit request
  returned HTTP 400 with a 1,123,873-byte script; the response message was not
  retained, so the suspected size limit is not a confirmed rejection cause.
  Preserve the attempted payload and unknown outcome; do not repeat its Save.
  A local audit can use the same frozen audio and ASR weights independently.

The local wording pass completed all 2,913 originals. Independent Whisper
processed all 2,144 CTC disagreements, with one token-capped result kept
incomplete. A separate pass processed 205 unused candidates. Exact normalized
caption agreement supported a proposed 1,745-clip, 72-voice training pool.
The consumed-word check withheld one T-Bug clip where the old aligner dropped
the accented vowel in "Ramón". The final pool has 1,744 clips, 42 unseen-scene
development clips and 55 conditional clips.
The original 94 development and 76 test clips remain unchanged, with their
uncertainties recorded separately. These are acoustic wording proxies, not
listening approval; no native caption was automatically corrected.

The teacher-only verifier reconciles actual raw hypotheses and model launches,
native scene/source identities, accepted word content/timings and historical
recording aliases. Precompute records actual resampled PCM and stored latent
tensors, with verification before updates. Its source passed targeted scene,
word-content and retiming regressions; full runtime preparation remains required
for the new training run.

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

## Conditioning experiment and implementation audit

The next comparison uses the accepted teacher and a balanced 1,020-recording
corpus across 73 character identities. Panam contributes 66 recordings, Judy 53,
Johnny 52 and Evelyn 52; original source archives remain intact. These counts
describe selected training recordings, with historical phone/media labels
preserved. Independent wording/alignment/codec checks admitted 171 newly collected
recordings into this mixture. Runtime caches must still be generated from the
final package before any training update.

Three matched experimental arms are being prepared:

1. The official audio prompt from the same recording as the training target.
2. A 50% mixture of independent recordings from the same authenticated voice,
   preserving the original target audio, text and crop.
3. The same mixture with a small learned speaker embedding added to the audio
   conditioning and 50% independent ID dropout.

The internal ID never appears in spoken text. Its key identifies the character,
native voice tag, locale and performer version. Recording context and delivery
constrain donor selection separately. Unknown IDs use reference audio with a
zero ID contribution. The table contains about 74,000 trainable parameters;
this experiment still uses one shared voice model.

An audit of the first prototype found that its actual training runner never
passed the new ID inputs, its checkpoint writer omitted mapping metadata, and
resume could accept a same-shape table with a different identity mapping.
The isolated corrected implementation wires the actual loader, training,
checkpoint, resume, export and public inference paths. A real checkpoint check
also exposed a second load of the same 5.06 GB file; metadata validation now reuses
the loaded payload. The corrected restore/export completed with 5.62 GiB peak
process RAM and 4.80 GiB peak GPU allocation.

The baseline real-model update and subsequent public CPU streaming check pass.
Paired/hybrid execution and audible benefits remain under evaluation. The finite
pilot will compare 500 updates per arm with the same initialization, target draws,
base learning schedule and text/reference probes. Raw and EMA results are kept,
and ID gradients and residual strength are measured. Production models remain
the previously accepted teacher/student until the new results are qualified.

For cloud execution, final resumable checkpoints retain raw and EMA state.
Derived exports can be generated after download, avoiding duplicate multi-GB
files in Kaggle's 20 GB saved-output allocation. See [Kaggle's notebook limits](https://www.kaggle.com/docs/notebooks).
Exact local receipts and candidate source are under
`runtime/voice-data-expansion-20261003/current-parent-audit` and
`speaker-conditioning-experiment/hybrid-v2`.
