# Pocket v2 run: results (October 6, 2026)

Plan: `docs/POCKET_NEXT_RUN_PLAN.md`. Code: `scripts/pocket_training/v2_*.py`, launcher `scripts/Pocket-V2Run.py`, page `scripts/reference-picker/build-pocket-v2-page.py`. Two Kaggle 2×T4 sessions used about 2.2 GPU hours in total.

## Outcome

- **New Pocket student:** `E:\CyberpunkConvai-offload\work\pocket-v2\exports\student-v2-s2000-ema-decv2`.
  - It is the 6-layer student, EMA weights at update 2,000, run `pocket-v2-student-11320cda`, with decoder v2 (`mimi-dec\decoders\decoder-v2-phase-anchored-step9590.safetensors`) applied.
  - The same student with the pretrained decoder is in `...\exports\student-v2-s2000-ema`.
  - It uses the same runtime layout and settings: CPU, CFG 1, one step, temperature 0.3. **Not installed**; switching the runtime is the user's call.
- It distils the **released 24-layer model** with **voice-weighted guidance (w_text 1.5, w_voice 3) baked in**. It was trained on **runtime-style references**: 1–3 other whole clips of the same voice, 0.4 s gaps, up to 18 s, never the target. Data was the expanded clean set: 21k clips, 26 h, 83 voices.
- **Speaker identity is clearly up, and delivery did not regress.** D panel (65 voices × 2 new held-out lines, pretrained decoder, runtime settings), paired 95% CIs over voices:

  | | Stock Pocket base | Student 5,000 (current) | **New student** | New − 5,000 |
  |---|---|---|---|---|
  | ECAPA, 3 clips (18 s) | 0.395 | 0.427 | **0.469** | **+0.043 [+0.027, +0.059]** |
  | ECAPA, 1 clip | 0.336 | 0.387 | **0.429** | +0.042 [+0.025, +0.059] |
  | ECAPA, rare voices (<150 clips), 3 clips | 0.404 | 0.429 | 0.487 | +0.058 |
  | ECAPA, 4 never-trained voices (Z) | 0.493 | 0.531 | 0.567 | +0.036 [−0.006, +0.078] |
  | Delivery: DTW MCD to the original line, lower is better (3 clips) | 417 | 396 | **384** | −12 [−21, −4] |

  This meets every success criterion in the plan: ≥ +0.025 on 3 clips, ≥ +0.03 on rare voices, no 1-clip regression, delivery no worse. The guided teacher scored 0.477, so the student nearly reaches it.
- **The teacher fine-tune did not help** (user's option A, not used). A new 24-layer teacher trained with the same conditioning and data stopped at 500 updates on the zero-shot rule. Against its own starting point, paired:
  - ECAPA moved within noise: update 250 +0.005 [−0.010, +0.019]; update 500 −0.004.
  - Delivery got worse: MCD +28, speech about 9% faster.
  - Never-trained voices dropped: −0.024 at update 250, −0.040 at update 500, all 4 voices.

  This repeats the October 5 finding that the teacher fine-tune was flat against its base. The user chose option B: distil from the released 24-layer model.

## What drove the gain

1. **Voice-weighted guidance**, baked into a CFG-1 student at zero runtime cost. It was measured three times:
   - teacher 1,000, single reference: +0.035–0.042;
   - teacher 1,000, 18 s three-clip, local CPU check: +0.042 [+0.018, +0.066];
   - new teacher, sweep: joint CFG 2 0.438 vs (1.5, 3) 0.489 on D.
2. **Training conditioning that matches runtime.** The old corpus used ≤5 s same-utterance prompts, and 18% of its rows had a prompt that overlapped the target.
3. **More data per voice.** The expanded pool took Mr. Hands 2→748 clips, Placide 7→330, Mitch 11→465. Rare-voice ECAPA rose the most (+0.058).

## T panel (the user-facing lines; 29 shown characters)

Shown on the page, the 29 characters × 2 lines. ECAPA is the macro over the 24 of them that have a held-out centroid (adam-smasher, lina-malina, mitch-anderson, ozob-bozo and placide have none); PLS is over all 29, calibrated with stock Pocket 1 clip = 60 and OmniVoice 32 1 clip = 90.

| Column | 1 clip | 2 clips (10 s) | 3 clips (18 s) |
|---|---|---|---|
| Original line | — | — | ECAPA 0.702 / PLS 106.2 |
| Pocket base (stock) | 0.425 / 60.0 | 0.455 / 68.0 | 0.475 / 71.1 |
| **New student + decoder v2** | **0.514 / 99.3** | **0.568 / 110.3** | **0.590 / 111.6** |
| OmniVoice 16 steps | 0.618 / 85.2 | 0.672 / 103.9 | 0.691 / 103.7 |
| OmniVoice 32 steps | 0.607 / 90.0 | 0.660 / 105.1 | 0.689 / 108.8 |
| *New student, pretrained decoder (not on the page)* | 0.493 / 74.5 | 0.553 / 86.0 | 0.564 / 82.4 |
| *Student 5,000, pretrained decoder (not on the page)* | 0.472 / 69.5 | 0.503 / 82.9 | 0.520 / 88.2 |

All 51 T voices with a centroid, per-line ECAPA, paired against student 5,000 with the same references:

| | 1 clip | 2 clips | 3 clips |
|---|---|---|---|
| New student, pretrained decoder | +0.038 [+0.016, +0.060] | +0.046 [+0.030, +0.062] | **+0.050 [+0.035, +0.065]** (0.552 vs 0.502) |
| New student, decoder v2 | +0.059 [+0.037, +0.082] | +0.056 [+0.040, +0.071] | +0.065 [+0.049, +0.080] |
| Clean lines only (56 lines student 5,000 never trained on), pretrained decoder | +0.034 [+0.001, +0.068] | +0.056 [+0.031, +0.082] | +0.055 [+0.031, +0.079] |

Reading it:
- **Speaker identity rose by about 0.05 ECAPA.** On the pretrained decoder the new student (0.552 on all T voices) now exceeds the old "perfect latents" codec round trip (0.525). Decoder v2 adds another 0.01–0.02.
- **The gap to OmniVoice narrowed** from about 0.17 to about 0.10 ECAPA (3 clips, page voices: 0.590 vs 0.69).
- **PLS with decoder v2 (110–112 at 2–3 clips) is above OmniVoice 16 (about 104)**, driven by timbre and delivery components. That is texture, not identity; the ear decides.
- On the pretrained decoder, the new student's 3-clip PLS (82.4) is below student 5,000's (88.2). Student 5,000 trained on 55% of these lines, which flatters PLS's same-line delivery and timbre terms. On the clean D lines the new student's delivery MCD is better (384 vs 396). Its 1- and 2-clip PLS are higher than student 5,000's.
- Scores: `E:\CyberpunkConvai-offload\work\likeness-phase1\out\np_scores_v2.json` and `np_per_speaker_v2.json`. Renders: `out\gen\ft6-v2__*` and `out\gen\base6-2609__multiC|multiB`. WER was not computed (user decision).

## Listening page

- Data: `E:\CyberpunkConvai-offload\work\pocket-v2\page\index.html` (audio under `page\audio\`), built by `scripts/reference-picker/build-pocket-v2-page.py`.
- Served read-only at **http://127.0.0.1:8765/pocket-v2/** after the next picker start (route `scripts/reference-picker/pocket-v2-page.mjs`; the server was not restarted).
- Columns, as the user specified: Original | Pocket base (stock) | new Pocket student + decoder v2 | OmniVoice 16 | OmniVoice 32, each at 1 clip / 2 clips (10 s) / 3 clips (18 s). Both held-out lines for each of the 29 characters, all speaking the original text. ECAPA then PLS under each header; per-line ECAPA under each player.

## Notes and caveats

- **Clean comparisons.** The new student never trained on any T-panel line, reference or multi-clip member, nor on any D or Z line. Student 5,000 trained on 74 of the 134 T lines, which is why it is compared on D (new lines) above and is not on the page.
- **Data quirk in this run.**
  - Gender and holocall variants of one subtitle id shared one pool file in the payload: 2,569 pairs, 127 of them with a one-word text difference (her/him).
  - Impact: about 0.6% one-word mismatches and some duplicate audio.
  - Fixed in the builder (`d180a84`); the run was not repeated.
- **Transcript QC.** CTC character-error filter at 0.6: 194 of 14,068 pool clips rejected. The 0.35 threshold first planned would have dropped accented speakers such as Placide, whose subtitles are correct.
- **Kaggle dataset create failed silently.** It was acknowledged but stayed inaccessible (403) for two attempts: `cp2077-pocket-v2-data-e416611a` and `-e5031193`. The payload was served from the private bucket instead (`data/pocket-v2-e416611a/`). Nothing was deleted.
- **Bucket contents.**
  - `runs/pocket-v2-teacher-ea82928c/`: 2 slots of 5 GB, the selected teacher, the latent cache, logs.
  - `runs/pocket-v2-student-11320cda/`: slots of about 1.4 GB, `selected/student-ema.safetensors`, logs.
  - `data/pocket-v2-e416611a/`: 3.4 GB.
  - Prune the teacher slots when no longer needed.
- **Open decision:** whether to switch the runtime Pocket voice to the new student + decoder v2, after listening.
