# Pocket TTS: plan for the next teacher and student run (October 6, 2026)

Status: **approved by the user (relayed by the coordinator, 2026-10-06).** It includes the user's decision to train a **new teacher**. The plan is one short, well-instrumented run on Kaggle 2×T4: data preparation, then the teacher, then the student. It runs in parallel with the local decoder retrain. The decoder is out of scope: the latent space stays frozen, so the new language model works with any decoder.

## 0. What the evidence says

Re-checked against the run records and the research outputs, not taken from the earlier summaries.

1. **Training never matched runtime conditioning.** The official loader (`vendor/pocket-tts-training/source/training/dataloader/loader.py`) cuts each utterance at a word boundary. The audio before the cut is the voice prompt, capped at `max_voice_prompt_sec` = 5 s, and the rest is the target, so training is a *same-utterance continuation*. The runner never overrides the 5 s cap. Two consequences:
   - 1,463 of the 8,140 full-A training rows (18%) are `aligned_full_utterance_fallback` with `prompt_target_overlap: true`. Their prompt is a window of the target itself, which is a copy shortcut.
   - Runtime instead uses 1–3 *other* whole clips joined with 0.4 s silences, up to 18 s (`scripts/clip-search/common.py`, `scripts/reference-picker/audio.mjs`). That is 3.6× longer than anything seen in training, and cross-utterance. This is the same failure mode that made the OmniVoice LoRA worse with multi-clip prompts.
2. **Fine-tuning has not moved speaker identity.** Panel numbers, ECAPA to the held-out centroid, paired over 51 voices:

   | Comparison | ECAPA change [95% CI] |
   |---|---|
   | Teacher 1,000 vs 24-layer base | +0.010 [−0.006, +0.025] |
   | Student 5,000 vs 6-layer base | +0.031 [+0.013, +0.049] |

   Student 5,000 (0.434) only reaches the 24-layer base (0.434), so its gain is the depth-distillation gap closing. Split by group, the student gained +0.06 over the 6-layer base on voices with ≥100 training clips and **+0.001 on voices with <20**.
3. **The last teacher memorised.** At update 5,000 the train loss was 0.158 against a held-out loss of 0.42. Update 1,000 already meant 7.9 passes over 8,140 clips. The best checkpoint fell exactly at the end of the 1,000-update warm-up (LR 1e-5 constant, EMA 0.999, no speaker balancing). Checkpoints were selected on flow loss, not on anything heard.
4. **Voice-weighted guidance raises identity.** The guidance is `z = z_null + w_t·(z_text − z_null) + w_v·(z_full − z_text)`. Teacher 1,000, single reference, against joint CFG 2:

   | Setting | ECAPA change [95% CI] | PLS change |
   |---|---|---|
   | w_t 1, w_v 2.5 | **+0.042** [+0.025, +0.058] | −7.8 |
   | w_t 1.5, w_v 3 | **+0.035** [+0.023, +0.047] | −1.9 |

   The official depth distillation already bakes joint CFG 2 into the CFG-1 student, so voice-weighted guidance can be baked in the same way at **zero runtime cost**.
   - A local CPU re-check with runtime-style 18 s three-clip references is in §4.3.
5. **The codec caps ECAPA.**

   | Condition | ECAPA, all voices | ECAPA, rare voices |
   |---|---|---|
   | Real lines | 0.697 | 0.679 |
   | Pretrained Mimi round trip (latents decoded with nothing generated) | 0.525 | 0.506 |
   | Decoder A round trip | 0.575 | 0.542 |
   | Student 5,000, 18 s three-clip, pretrained decoder | 0.502 | 0.465 |

   On the pretrained decoder the language model is about 0.02 below perfect latents overall and about 0.04 below on rare voices. Most of the gap to OmniVoice (0.68) is the codec. Expect **modest** ECAPA gains from this run. The decoder retrain matters at least as much.
6. **The user-facing panel is contaminated.** 74 of the 134 panel lines (`likeness-phase1/out/panel.json`) were in the full-A train split, so teacher 1,000 and student 5,000 trained on them (the student for roughly 39 passes). Any comparison against them must use the 60 clean lines or new held-out lines.
7. **Noise level.** With 51 voices × 2 lines, repeated decodes of the same model differ by a paired SE of about 0.005 ECAPA (95% CI ±0.010). Between-voice SD is 0.10. PLS batch-seed noise is about 1.6 points.
8. **Data now available.** The expanded pool so far has 17,237 new clips (22.4 h) over 75 voices, all with subtitle transcripts. With the old 8,140 clips that is about 24k clips, about 31 h and 88 voices before cleaning. Every shown character now has ≥30 clips; most have hundreds (mr-hands 2→748, placide 7→330, mitch 11→465).
   - **Bandwidth artefact:** the new WAVs are 24 kHz while the dataset is 48 kHz, so the pool's own phone flag marks 11,291 of the 17,237 new clips (65%) "band-limited". The flag is a 24 kHz artefact, and nothing filters on it.
   - The merged effect scan (`scripts/phone_detect/effect-exclusions.json`) excludes 1,605 of 15,722 pool clips (10%) and 411 of 8,472 dataset clips. Its rate is plausible.
   - The decoder agent's combined clean set is 21,769 clips: 7,652 original plus 14,117 pool clips (`E:\CyberpunkConvai-offload\work\mimi-dec\v2\pool-train.jsonl`). This run starts from that set.
9. **Pocket's own limits allow 18 s prompts.**
   - The FlowLM has full causal attention with RoPE and no context cap; the sequence is `[bos, voice @ speaker_proj, text, audio]`.
   - The Mimi encoder's transformer context is 250 frames (20 s), so an 18 s reference (225 frames) is encoded whole.
   - `get_state_for_audio_prompt` only truncates (at 30 s) when asked to.
   - Training prompts up to 18 s are therefore within the architecture.

## 1. Goals and success criteria

The goal is a 6-layer student that sounds more like each character with runtime references, at an unchanged runtime cost (CPU, 4 threads, CFG 1, one decode step, temperature 0.3).

Measured with the **pretrained Mimi decoder**, on clean held-out lines, with references built exactly as at runtime, against student 5,000:

| Criterion | Threshold | Basis |
|---|---|---|
| ECAPA, 3 clips (18 s), all voices | **≥ +0.025** (about 0.527 vs 0.502), bootstrap 95% CI above 0 | 5× the paired SE; within reach of the measured guidance effect |
| ECAPA, 3 clips, voices with <150 training clips | ≥ +0.03 | Where the old run gained nothing |
| ECAPA, 1 clip | ≥ +0.015 (no regression at minimum) | 3× SE |
| PLS, 3 clips | ≥ student 5,000 − 2 | Noise about 1.6 |
| Zero-shot voices (§2) | No drop vs the released 6-layer base | Overfitting guard |
| WER (Whisper, final candidate only) | ≤ student 5,000 + 1.5 points | Delivery guard |
| The user's ear | Final call | |

A stretch outcome is 3-clip ECAPA ≥ 0.525, which reaches the pretrained codec's round-trip level. Through the new decoder this should land around 0.55–0.58.

## 2. Data

**Sources (as built).** The run starts from the decoder agent's combined clean set (21,769 clips), which already applies the merged effect exclusions and the decoder holdouts.
- **(a)** Full-A corpus rows (train/dev/test/regression/conditional), 48 kHz, with their verified `transcript` and word timings. Only clips not effect-excluded and not fenced (below) are used.
- **(b)** The expanded pool: the 14,117 clips of `mimi-dec/v2/pool-train.jsonl`, 24 kHz, with subtitle text from each voice's `manifest.json` (`t`).
- **(c)** Lip-sync-corpus extra speakers: **deferred.** They have no joined transcripts yet, and the speaker count already rises to the whole runtime cast.

Everything is resampled to 24 kHz mono, which is what Mimi uses. The pool's `finalize.py` already dropped lines whose source `.wem` was in the dataset, and repeats.

**Cleaning.**
- The merged effect exclusions are already applied (411 dataset clips, 1,605 pool clips, scanned at a plausible rate).
- Acoustically clean holocall- and phone-tagged clips stay. The user heard no difference.
- Pool clips outside 1.5–15 s and shouts were already dropped by `finalize.py`.

**Transcript checks.**
- *Local, rule-based:* drop markup (`<i>`, `[...]`, `{...}`) and normalise quotes and dashes. Drop rows that contain digits (spoken-number rendering would be a guess) or non-Latin text, and rows with fewer than 2 words.
- *Kaggle prepare:* the wav2vec2 CTC model (already in the payload) greedy-decodes each pool clip. Reject rows with a character error rate above 0.35 against the subtitle, or with a speech rate more than 3 SD from the voice's mean.

**Splits and fences.** Each fenced clip is never a training target *and* never a member of a training reference set.
- **T, the test panel:** the existing 134 lines, their runtime single references, alts and multi-clip set members (`likeness-phase1/out/evaluation-sets.json`, `exclude-ids.json`). These are the user-facing lines. They are used only for the final report and listening page, never for selection.
- **D, the dev panel:** 2 new lines per runtime voice from the expanded pool (2.5–9 s, clean, at least 6 words), for every voice with ≥12 clips left (about 70 voices). D reuses T's reference sets where a voice is in T; otherwise it builds sets with the runtime rule (the most typical whole clips by ECAPA, 1 clip / 2 clips ≤10 s / 3 clips ≤18 s). These lines are new extractions, so student 5,000 never saw them, which makes the comparison clean.
- **Z, the zero-shot panel:** voices held out entirely, chosen from non-runtime dataset voices with ≥30 clean clips (kurt-hansen, rosalind-myers, joshua, fingers; 4 voices). Each gets 3 lines and a 3-clip reference. It catches memorisation.
- **Centroids:** ECAPA centroids come from each voice's non-fenced clips, using the same rule as `likeness-phase1/exp-scripts/score.py`. They never include the line being scored or its reference clips.
- Scene fences carry over from the full-A corpus. D and T lines cannot share a scene with a training row of the same voice where the voice has ≥3 scenes.

**Speaker balance.** Weights are `p(voice) ∝ min(clips, 300)`.
- Every voice with ≥300 clips gets the same weight, so Johnny no longer outweighs a 300-clip voice.
- Smaller voices get weight in proportion to their clips, so no clip is seen more than about 8 times in 1,500 updates (the old teacher was already memorising at 8 passes).
- Fully equal weights would show a 20-clip voice's clips about 55 times each: certain memorisation. The trade-off is a decision for the user (§11).
- After the expansion, most formerly rare voices have hundreds of clips, so they are now effectively equal.

**Expected size.** About 20–21k clips and about 26 h after fences and transcript checks, over about 85 voices, against 8,140 clips and 9.8 h before. The corpus builder writes the exact numbers to its receipt before upload.

## 3. Conditioning

**What changes.** Training builds the voice prompt the way runtime does.
- **Cross-utterance multi-clip, 85% of samples.** The prompt is 1, 2 or 3 *other* whole clips of the same voice, joined with 0.4 s of digital silence at 24 kHz and encoded by Mimi as one waveform.
  - Probabilities 0.3 / 0.3 / 0.4; caps of 9 s / 10 s / 18 s (the picker's caps).
  - Never the target, and never a clip from the target's scene when the voice has ≥3 scenes.
  - Clips are drawn from the voice's reference-eligible pool: 1.5–9 s, clean, within ±6 dB of median loudness, drawn uniformly. Typical-only sampling would narrow what the model sees; robustness matters more than matching the picker's typicality rule.
- **Same-utterance prefix, 15% of samples.** This is the official cut (≤5 s, at a word boundary), kept so the released behaviour and short-prompt robustness are not lost. Both VoiceStar and Kyutai's own DSM-TTS mix in or use non-continuation prompts.
  - The full-utterance fallback that let the prompt overlap the target is **dropped**: rows without a valid cut always get a cross reference.
- **The target is the whole clip** (trimmed to the last word + 0.2 s, as the loader does), with its full transcript. No prompt trim on cross references, because runtime uses whole clips.
- **Dropout stays as is:** text dropout 0.2 and voice dropout 0.2, independent. The text-only branch is needed for voice-weighted guidance.

**How (exact and cheap).** The prepare session pre-encodes a **reference bank**: 32 sets per voice for each of k = 1, 2, 3, built with the runtime join. That is about 9k sets and about 26 h of audio, around 150 MB of FP32 latents. The sampler picks a set that excludes the target. Encoding the joined waveform once matches runtime exactly. Concatenating per-clip latents would not, because of the encoder's causal context at each boundary.

**Cost.** The prompt now averages about 11 s (138 frames) instead of about 3 s. The sequence is about 1.7× longer, so expect about 3.3 s per teacher update instead of 2.0. The micro-batch drops from 4 to 2 if memory requires (gradient accumulation keeps the effective batch at 64).

## 4. Teacher

### 4.1 A new teacher (user decision)

The user decided on a new teacher: a distilled student cannot exceed its teacher. The design agrees:
- Teacher 1,000 never saw cross-utterance or long prompts. It handles them by generalisation only (ECAPA 0.444 single → 0.484 with a 3-clip concatenation).
- It trained on 74 of the test lines.

**Evidence of limited headroom, stated briefly.** The last teacher fine-tune did not move ECAPA (+0.010, CI includes 0). On the pretrained decoder, even perfect latents score only 0.525. A new teacher alone may therefore add little identity. The measured lever is voice-weighted guidance, which the student can only inherit from a teacher that is good with long, cross-utterance prompts. Both levers are kept.

**Reported comparison, no silent switch.** Teacher 1,000 is evaluated on D at step 0 for comparison. If the new teacher's best dev ECAPA (3 clips, same guidance) is *below* teacher 1,000, the student is not distilled automatically: the coordinator and user decide. Otherwise the student is distilled from the new teacher.

### 4.2 Recipe

Policy `pocket_crossref_teacher_v1`.

| Setting | Value | Why |
|---|---|---|
| Initialisation | Released `english_2026-04_24l` | Clean (no test-line exposure, no inherited overfit) |
| Learning rate | Peak 1e-5, 150 warm-up updates, cosine to 10% over 2,000 | The old best sat at the end of warm-up; a decay limits late drift |
| Updates | Minimum 500, maximum 2,000, evaluated every 250 | About 9.6 passes on average at 2,000 |
| Early stopping | Stop after 3 evaluations (750 updates) without +0.005 on dev 3-clip ECAPA; also stop if Z ECAPA falls 0.02 below its best | ECAPA instead of flow loss |
| EMA | 0.998, evaluated each time; raw weights evaluated once, at the selected update | 0.999 averages over the whole useful horizon |
| Regularisation | Cross-utterance prompts (target audio no longer pairs with its own prompt), capped speaker sampling, frozen latent calibration (as now), AdamW weight decay 0.1 (official), text/voice dropout 0.2 | No LoRA; it would be new code with no evidence for it in this setting |
| Precision | FP16 on T4 (as before) | |

**Teacher evaluation settings.** Temperature 0.3, one decode step (the student's runtime settings), pretrained decoder. Guidance during evaluation is the candidate distillation guidance (§4.3), not plain CFG 2, because that is what the student inherits.

### 4.3 Guidance strength

The guidance weights are chosen at the selected teacher, on D. The grid is (w_t, w_v) ∈ {(2, 2), (1.5, 2.5), (1.5, 3), (2, 3)}. Pick the highest 3-clip ECAPA with:
- PLS-D components (§6) no worse than (2, 2) by more than 3% on delivery (DTW MCD) or 10% on timbre FD;
- generated length within ±10% of (2, 2), as an end-of-speech sanity check.

This costs about 25 min.

**Local CPU check with runtime-style 18 s three-clip references** (teacher 1,000, 32 voices × 1 line, paired): joint CFG 2 gives ECAPA 0.487; (1.5, 3) gives 0.528, a change of **+0.042** [+0.018, +0.066], n = 23 voices with centroids. The effect holds with long multi-clip prompts and matches the single-reference effect (+0.035). Scripts: scratchpad `vg_check.py` / `vg_score.py`; render conditions temperature 0.3, 2 steps.

## 5. Student

Policy `pocket_voice_guided_distill_v1`.

- **Initialisation:** the released 6-layer `english_2026-09` backbone. Embeddings, the flow head and the end-of-speech head are transferred from the selected teacher and frozen (the official depth distillation and the existing `student_transfer` mechanism). Starting from student 5,000 would be faster but inherits its memorised test lines (a decision for the user, §11).
- **Target:**

  ```
  z_t = z_null + w_t·(z_text − z_null) + w_v·(z_full − z_text)
  ```

  It takes three teacher passes (null, text-only via voice-only dropout, full). The loss is the official masked latent MSE on the backbone output.
  - The text-only branch needs no change to the vendored source: call `build_sequences_with_conditions` with a shallow copy of the arguments (voice dropout 1, text dropout 0).
  - The student sees the same voice prompt as the teacher, from the same cross-reference sampler, with no dropout on its inputs (official).
- **Real-target loss:** none. A flow loss on real latents would pull the student back towards the unguided distribution and undo the baked-in guidance. A speaker-embedding loss would need Mimi decoding inside the training loop. DMOSpeech shows such losses trade naturalness for similarity. Rejected for this run.
- **Learning rate:** peak 5e-5, 200 warm-up updates, cosine to 10% over 3,000. EMA 0.999.
- **Updates:** at most 3,000, evaluated every 500, patience 2, about 1.7 s per update (one extra teacher pass, longer sequences). Kyutai reports similarity rising long after WER parity, but this student starts from a released distillation of the same base, so it adapts quickly. If the last evaluation is still clearly improving, the resume launcher extends it by 1,000 updates.
- **Selection:** dev ECAPA at 3 clips at runtime settings (CFG 1, one step, temperature 0.3, pretrained decoder). Ties within 0.005 go to 1-clip ECAPA, then PLS-D.

## 6. Evaluation at each checkpoint

The evaluation runs inside the Kaggle session, on rank 0, while rank 1 idles; it uses the same generation code as `likeness-phase1/exp-scripts/gen.py`.

| Panel | Size | Conditions | Teacher cost | Student cost |
|---|---|---|---|---|
| D | ≈70 voices × 2 lines | 3 clips (18 s) + 1 clip | ≈5 min (3 branches) | ≈2 min |
| Z | 6–8 voices × 3 lines | 3 clips | ≈0.5 min | ≈0.3 min |

- **Primary metric:** ECAPA cosine (SpeechBrain VoxCeleb ECAPA, the same checkpoint as the study, staged offline) to the held-out centroid, macro over voices. It is reported for all voices, common voices (≥150 clips) and rare voices (<150), with a bootstrap CI against the step-0 render. Centroids and real-clip statistics are computed once in the prepare session.
- **Secondary metric:** PLS-D. These are the three PLS components (timbre FD to the voice's real clips, DTW to the original line, error above 8 kHz), computed with `scripts/pocket_training/likeness.py` and tracked as relative changes against the step-0 renders. D has no OmniVoice renders, so calibrated PLS (base 60 / Omni 90) is computed only on T at the end.
- **Also logged:** generated/original length ratio, end-of-speech failures, mean held-out distillation MSE (student) and held-out flow loss with cross references (teacher), per voice.
- **Decoder:** the pretrained Mimi decoder throughout. It is the training codec, it is constant across checkpoints and it has no holographic artefact. The final listening page adds the retrained decoder if it is ready by then (§10).
- **Anchors at step 0:** the student session also renders student 5,000 and the released 6-layer base on D, so every comparison is on the same lines, seeds and references.
- **Final pass, once, on the selected student:** the T panel at 1 / 2 / 3 clips for all 67 voices, rendered locally on CPU (6 layers, about 15 min). It is scored with the research tools (calibrated PLS and ECAPA), with a separate table for the 60 clean lines. Whisper small.en WER runs on the Kaggle GPU in about 2 min, as the delivery guard.

## 7. Cost and time

| Stage | Where | Time | In parallel with the decoder retrain? |
|---|---|---|---|
| Data build, scan, QC, splits, reference-bank spec, upload (FLAC, about 3 GB) | Local CPU (below-normal priority) | 3–4 h of agent time, mostly I/O | Yes; no GPU |
| Smoke test (100 updates each role, one evaluation each) | Kaggle | ≈0.7 h | Yes |
| Prepare: alignment for new rows, Mimi latents (about 30 h of audio plus the bank), centroids, real-clip statistics; published to the bucket for both sessions | Kaggle | ≈1–1.5 h | Yes |
| Teacher: step-0 evaluation of base and teacher 1,000, ≤2,000 updates at ≈3.3 s, ≤8 evaluations, guidance sweep | Kaggle | ≈2.5–3.5 h (stops early if it plateaus) | Yes |
| Student: step-0 anchors, ≤3,000 updates at ≈1.7 s, ≤6 evaluations, WER guard | Kaggle | ≈2–2.5 h | Yes |
| Final T renders, scoring, listening page | Local CPU | ≈1 h | Yes; OmniVoice columns already exist, so no GPU is needed |

**Total:** about 6.5–8 h of Kaggle GPU (the weekly quota is 30 h; previous teacher sessions held 7 h in reserve for the student). Wall-clock is about one day of runs after the code is ready. Launches, monitoring and selection are done by the agent; the coordinator gets a note at each milestone. Ask about the laptop power profile before the local CPU stages (power-profile note).

## 8. Risks and fallbacks

| Risk | Sign | Fallback |
|---|---|---|
| Cross references cost delivery (continuation gave prosodic continuity) | PLS-D delivery component drops; the user hears flatter lines | The 15% same-utterance mix is already in; selection guard; raise the mix to 30% on resume |
| Guidance over-sharpens timbre or breaks end-of-speech | PLS-D falls, length ratio drifts, metallic sound | Sweep picks the mildest setting that wins; (2, 2) is always a candidate |
| The new teacher is no better | Gate fails | Distil from teacher 1,000 (§4.1) |
| ECAPA rises while the sound worsens (overfitting to the metric) | D up, Z or PLS down | Z stop rule; final T panel and the ear decide |
| Out of memory with 18 s prompts on T4 | First smoke-test step | Micro-batch 2 → 1; trim the k = 3 share |
| Kaggle kernel dies silently (it happened twice to the Mimi-decoder kernels) | Heartbeat stops | Bucket checkpoint at every evaluation, live event log, resume launcher for **both** roles |
| Subtitle/audio mismatches raise WER | WER guard | CTC CER filter; drop the worst voices' new rows |
| Gains are within noise | CI includes 0 | Report honestly; the decoder retrain remains the main lever for identity |

**Logged to the bucket at every evaluation:** all panel metrics with per-voice values and CIs, train loss / distillation MSE, LR, gradient norm, step time and memory, plus 4 fixed spot-listening renders (Johnny, Judy, Panam, Takemura, 3 clips). Three rotating slots per run in `alystria-ai/cyberpunk-pocket-rolling-checkpoints` (teacher about 5 GB, student about 1.7 GB), plus a pinned `selected/` candidate.

**Resume.** Same pattern as `scripts/Pocket-FullATeacher.py resume`: read the previous session's `continuation-collection.json`, carry the lifetime budget and continue from the newest slot. It is added for the student, which has no resume today.

## 9. Code changes

The new code is a self-contained v2 trainer. It imports the official, digest-pinned training modules (`build_models`, `TrainableTTS`, `EMA`, `build_optimizer`, `lr_at`) unmodified. `runner.py` and the full-A policies (`macro_speaker_cfg2_old_dev_v1`, `qualified_macro_student_transfer_v1`) are untouched, so old runs stay reproducible. Every receipt names the new policies `pocket_crossref_teacher_v1` and `pocket_voice_guided_distill_v1`.

| File | Change | Effort |
|---|---|---|
| `scripts/pocket_training/v2_corpus.py` (new, local) | Merge (a)+(b), transcript rules, T/D/Z fences, reference-eligible pools, reference-bank spec (32 sets per voice per k, runtime join, target and scene exclusion handled at sampling), capped speaker weights, 24 kHz FLAC payload, receipt with counts and hours | 4–5 h |
| `scripts/pocket_training/v2_data.py` (new) | Latent cache (each rank encodes a shard: clips, bank, panel references), `CrossRefSampler` (85% cross-utterance bank sets excluding the target and its scene; 15% official same-utterance prefix on aligned rows, never overlapping), deterministic per global sample index for exact resume | 3–4 h |
| `scripts/pocket_training/v2_eval.py` (new) | Batched panel generation with (w_t, w_v) guidance, pretrained decoder, ECAPA centroids (computed in-session), macro ECAPA for all/common/rare/Z, length ratio and end-of-speech failures, guidance sweep, spot renders | 4–5 h |
| `scripts/pocket_training/v2_train.py` (new) | torchrun DDP 2×T4, FP16 + GradScaler, cosine LR, EMA, three-pass voice-guided distillation for the student, ECAPA early stopping and Z stop rule, rolling bucket checkpoints (3 slots, new run path) at every evaluation, log and metrics upload **every 10 min** by a watchdog thread, resume from the newest bucket slot | 5–6 h |
| `scripts/Pocket-V2Run.py` (new launcher) | Upload the private data payload once. prepare / submit / status / logs / resume for the teacher and student roles. Notebooks are written under the gitignored `runtime/pocket-v2/` because they embed the bucket token; they are never staged. Uses the configured Kaggle credential helper | 3–4 h |
| `scripts/pocket_training/test_v2_*.py` | Fences (no fenced clip in any training target or bank set), sampler exclusion and determinism, bank join equals `build_reference`, guided-target algebra | 2–3 h |
| `scripts/reference-picker/research.mjs` (+ test) | Family `pocket-v2` (`ft6-v2__cfg1`, `ft6-v2__multiC`, `ft6-v2__multiB`, plus `__decB*` if the new decoder is ready) | 1 h |

**Total:** about 22–28 h of agent work. A short smoke session (prepare plus about 30 updates and one evaluation) runs before the full teacher.

## 10. Listening deliverable

Standard format, as on the existing page (http://127.0.0.1:8765/): labelled, every column speaking the original line's text, for the 29 shown characters.

- **Columns:** Original | Pocket student 5,000 | **new Pocket student** | OmniVoice 16 | OmniVoice 32, each at 1 / 2 / 3 clips.
- Renders go to `likeness-phase1/out/gen/ft6-v2__{cfg1,multiC,multiB}`, using the same panel, reference sets and seeds as the existing columns. Only the new student needs rendering (CPU).
- Adding the `pocket-v2` family to the allowlist in `scripts/reference-picker/research.mjs` makes the columns appear with their scores (a `summary-table.md` row). This is simple, and the existing server needs no new route.
- Header scores also show the 60-clean-line ECAPA, because student 5,000 trained on the other 74 lines.
- If the retrained decoder is ready, add `ft6-v2__decB*` columns and the matching student 5,000 + new-decoder columns.

## 11. Defaults taken (the user pre-approved the run; each can be revisited)

1. New teacher: yes (user decision).
2. Rare-voice weighting: capped-equal at 300 clips, about 8 passes per clip at most, instead of fully equal.
3. Lip-sync-corpus extra speakers: deferred (no transcripts joined yet).
4. Guidance strength: chosen by the sweep (§4.3) under the PLS-D and length guards.
5. Student initialisation: the released 6-layer model (clean), not student 5,000.
6. Final listening: pretrained-decoder columns first; new-decoder columns added when the retrained decoder is ready.

## Sources

- Kyutai Pocket TTS training code and configs (`loader.py`, `finetune.yaml`, `depth_distill.yaml`): same-utterance prompts capped at 5 s, voice dropout 0.2, CFG 2 baked into the student. https://github.com/kyutai-labs/pocket-tts
- DSM-TTS (Kyutai, 2025): voice conditioning from a 10 s clip outside the target segment. https://arxiv.org/abs/2509.08753
- VoiceStar (2025): mixing continuation and different-utterance prompts. https://arxiv.org/abs/2505.19462
- Koel-TTS (2025): context and target from different utterances; preference alignment and CFG raise similarity on unseen speakers (0.60 → 0.68). https://arxiv.org/abs/2502.05236
- Multi-scale acoustic prompts (2023): more reference utterances give small similarity gains (0.779 → 0.798 from 1 to 20). https://arxiv.org/abs/2309.11977
- DMOSpeech (2024): a speaker-verification loss raises similarity but costs naturalness and WER. https://arxiv.org/abs/2410.11097
- CALM (2025): 24→6-layer distillation with latent CFG. https://arxiv.org/abs/2509.06926
- ZipVoice (2025): distillation costs a little similarity (0.668 → 0.657). https://arxiv.org/abs/2506.13053
- SV2TTS (2018): speaker count matters more than hours for generalisation. https://arxiv.org/abs/1806.04558
- LoRP-TTS (2025): speaker-level overfitting arrives within hundreds of steps. https://arxiv.org/abs/2502.07562
- T5Gemma-TTS report (2026): bootstrap CIs; similarity gaps of about 0.02 at n = 100 are not significant. https://arxiv.org/abs/2604.01760
- Local evidence: `E:\CyberpunkConvai-offload\work\likeness-phase1\out\scores.json`, `scores_per_speaker.json`; teacher history in `runtime/voice-data-expansion-20261005/full-a-live/cp2077-full-a-live-c5e2605bf7a943ce/bucket-meta/`; recipes in `runtime/voice-data-expansion-20261004/a-continuation-launch-v1/final-payload-v2/generated/`.
