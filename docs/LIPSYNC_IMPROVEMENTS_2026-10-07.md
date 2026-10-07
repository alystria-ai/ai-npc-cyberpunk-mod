# Lip-sync model improvements (2026-10-07)

**Status: offline research done. One drop-in candidate is ready to install (needs the user's approval). A larger
text-conditioned upgrade is measured and costed, and needs bridge work. Nothing live was changed: `face-model.*`
and the bridge are untouched.**

## Recommendation

1. **Install Candidate A** (`runtime/lipsync-model/candidate-aux-e96-20261007/face-model.{json,bin}`).
   - Same network, format and CPU cost as the shipped model.
   - Trained from scratch on all corpus lines for 96 epochs, with a training-only phone-classification head that is dropped at export.
   - Better than the shipped model on held-out speakers and on cloned voices on every correlation and precision metric. Paired 95 % intervals exclude zero.
   - JS parity holds: max |JS − NumPy| is 5e-6 over streamed 80 ms packets.
2. **Next round: text conditioning (stage 2).** By far the biggest gain found. It costs about +20 % CPU and needs bridge changes (see below).
   - Streaming (Pocket, Convai), on top of the stage-1 model:
     - contact r +0.03, purse +0.07, width +0.05;
     - rounding recall +0.06, F/V recall +0.04.
   - Omni, whole phrase:
     - contact r +0.09, purse +0.10, width +0.08;
     - F/V recall +0.10, rounding recall +0.08.
3. **Don't pursue** these; each gave no gain or one inside noise:
   - per-character fine-tunes;
   - training on cloned-voice audio;
   - distillation from a bigger teacher;
   - an acceleration loss;
   - a 260 ms lookahead.
4. "ee" width is not a model weakness: see the audit.

## Results table

All results below are on the **held-out-speaker set** (`split.json` test). It holds 1,024 lines with authored jaw
motion, from 31 speakers never trained on. Mean, with the 95 % cluster-bootstrap interval of the paired difference vs
the shipped model. Clusters are speakers. Run-to-run noise (same recipe, second seed) is ±0.002–0.005 on
correlations and ±0.01 on recall/precision.

| Metric | Shipped `final` | **Candidate A** (96 ep) | paired Δ [95 % CI] |
| --- | ---: | ---: | --- |
| Inner aperture r | 0.823 | **0.843** | +0.020 [+0.014, +0.025] |
| Aperture error (mm) | 1.18 | **1.08** | −0.097 [−0.117, −0.075] |
| Mouth width r | 0.499 | **0.535** | +0.036 [+0.020, +0.049] |
| Lip protrusion r | 0.673 | **0.715** | +0.042 [+0.032, +0.049] |
| Chin drop r | 0.857 | **0.868** | +0.011 [+0.006, +0.015] |
| Lip contact control r | 0.750 | **0.794** | +0.043 [+0.034, +0.054] |
| Purse r | 0.638 | **0.704** | +0.066 [+0.053, +0.075] |
| Corner stretch r | 0.667 | **0.717** | +0.050 [+0.038, +0.064] |
| Lower roll r | 0.762 | **0.789** | +0.026 [+0.017, +0.042] |
| Contact recall | 0.547 | 0.555 | +0.008 [−0.010, +0.030] |
| Contact precision | 0.394 | **0.448** | +0.055 [+0.045, +0.065] |
| F/V recall | 0.709 | **0.746** | +0.038 [+0.020, +0.057] |
| Rounding recall | 0.671 | **0.714** | +0.043 [+0.016, +0.057] |
| Rounding precision | 0.350 | **0.397** | +0.043 [+0.032, +0.051] |
| Lag (ms) | 0 | 0 | |

The clean (833 lines) and flagged (combat/effect, 191 lines) held-out subsets show the same gains. Flagged lines:
contact r +0.032, purse +0.071, F/V +0.069, contact recall +0.040.

**On cloned voices** (OmniVoice: 336 held-out-speaker lines; Pocket student v2: 251 lines; game curves time-warped
onto the clone), shipped → Candidate A:

| Metric | OmniVoice clones | Pocket clones |
| --- | --- | --- |
| Aperture r | 0.741 → 0.761 | 0.707 → 0.739 |
| Width r | 0.508 → 0.551 | 0.524 → 0.566 |
| Contact r | 0.718 → 0.770 | 0.736 → 0.782 |
| Purse r | 0.620 → 0.691 | 0.613 → 0.686 |
| F/V recall | 0.773 → 0.807 | 0.779 → 0.815 |
| Rounding recall | 0.707 → 0.766 | 0.686 → 0.747 |
| Contact recall | 0.551 → 0.529 (−0.022) | 0.572 → 0.554 (−0.018) |
| Contact precision | 0.339 → 0.384 | 0.328 → 0.362 |

All paired intervals exclude zero.
- On clones, the candidate closes the lips slightly less often (recall −0.02) but much more precisely (precision +0.035 to +0.045). This is worth watching in the in-game m/b/p check.
- Per character, Johnny and Panam improve (purse +0.08, rounding recall +0.06 to +0.10). Judy is flat, but the shipped model was trained on those Judy lines, so that comparison favours it (see the audit).

**Where the gain comes from**, all paired on held-out speakers:
- From-scratch training on the corpus-2 split alone vs the shipped warm-start: +0.007 to +0.024.
- Plus the training-only phone head: +0.006 to +0.03 (rounding recall +0.03).
- Plus training 48 epochs instead of 24: aperture +0.007, width +0.015, contact r +0.014, purse +0.022, rounding recall +0.016.
- Plus 96 epochs instead of 48: +0.003 to +0.009, and precision +0.014 to +0.03. It is levelling off.

**Stage 2 (text) numbers** are on top of the 24-epoch Candidate A, on the 833 clean held-out lines:

| Metric | 24-ep A | + stage 2 streaming | + stage 2 Omni phrase |
| --- | ---: | ---: | ---: |
| Aperture r | 0.833 | 0.843 | 0.853 |
| Width r | 0.524 | 0.571 | 0.602 |
| Contact r | 0.781 | 0.813 | 0.870 |
| Purse r | 0.674 | 0.739 | 0.776 |
| Corner stretch r | 0.699 | 0.747 | 0.782 |
| F/V recall | 0.753 | 0.790 | 0.855 |
| Rounding recall | 0.689 | 0.746 | 0.769 |
| Contact precision | 0.418 | 0.437 | 0.458 |

On the clones the gains are similar:
- Omni phrase: contact r +0.060, purse +0.091, width +0.078, F/V +0.086.
- Pocket streaming: contact r +0.023, purse +0.062, width +0.049, rounding +0.059.

Stage 2 should be retrained on whichever stage-1 model ships; it takes 6 minutes.

## Audit of the prior state (low-trust check)

- **The shipped model's held-out numbers are slightly optimistic.**
  - `final.npz` was fine-tuned from `mse20`, which was trained on the corpus-1 split.
  - That split's random held-out speakers differ from corpus 2's. 17 of the 31 "held-out" corpus-2 speakers (about 173 of their test lines) were in corpus-1 training.
  - A fresh from-scratch model on the corpus-2 split alone (no leak) already matches or beats `final`.
  - All comparisons here use models trained only on the corpus-2 split.
- **`final` saw the per-character held-out lines.** Judy, Johnny and Panam were all in its training set, so its per-character numbers are not comparable; it looks better on Judy for that reason.
- **The "ee width" weakness is mostly a measurement artifact.**
  - The game's width p95 of +7.4 mm comes from `lips_*_corner_up` (smile, p95 0.27) and `lips_*_pull`. Those are expression controls, not among the 15 runtime mouth outputs.
  - Limited to the runtime controls, the game reaches width p95 +1.3 mm and the shipped model +1.5 mm.
  - So the gap belongs to the expression layer (mood smile), not the lip-sync network.
  - The width correlation still improves with the changes above.
- Smaller issues:
  - The corpus manifest lists 87 lines twice (one recording used by two scenes), which double-weighted them; the new trainer de-duplicates.
  - `split.json` includes some lines with no authored jaw motion, which the trainer filtered but the old eval kept. The new eval uses only lines with authored motion.

## Data preparation

- **Pack:** `lab_data.py` packs 6,908 unique lines (7.6 h) into one memmap.
  - It attaches the subtitle text: the decimal stringId equals the line hex, and 99 % of lines have text.
  - It writes `split2.json`, which has:
    - the **unchanged** held-out-speaker test set;
    - per-character held-out sets chosen by whole scenes, about 25 % of each character's lines: Judy 88 lines from 4 scenes, Johnny 38 from 10, Panam 109 from 3;
    - `excludeTrain`: 135 training lines whose text equals a held-out line's text (repeated barks), so nothing leaks.
- **Cleaning** (`lab_clean.py`): uses the voice pipeline's lists `combat-flags.json` and `effect-exclusions.json`, joined by stringId.
  - For generic NPCs, which those lists don't cover, it falls back to the game's scene metadata (`combat_flags/source_signal.py`): strong or moderate tier means combat; broadcast/radio/loudspeaker/cyberspace expression means effect. Phone and holocall alone are kept, as in the voice pipeline.
  - **1,668 of 6,908 lines are flagged (24 %)**: 1,393 combat or shouted, 359 effect-processed.
  - In the held-out test set, 191 of 1,024 are flagged.
  - Cleaning alone *hurt* slightly. The clean model (4.6 h) is worse than the all-data model (5.6 h), even on clean test lines: width −0.010, purse −0.011, contact recall −0.021, F/V −0.016, rounding −0.020. On flagged lines it is worse still: contact r −0.05.
  - **User decision:** for lip sync, keep shouted and processed lines when the authored curves are valid; for voice, exclude them.
  - The candidates use all data. Clean and flagged test subsets are still reported separately.
- **Phone alignment** (`lab_align.py`): PocketSphinx 5 forced alignment with CMUdict, plus espeak pronunciations for 980 words not in CMUdict (slang, names). Both tools were already in `vendor/`.
  - 6,452 lines got labels. The rest are foreign-language markup, digits, or failed alignments.
  - **Validation against the game's own curves:** 87 % of P/B/M frames have JALI lip contact > 0.5, against 6 % of other speech frames. 87 % of F/V frames show the F/V shape.
  - This holds once the labels are read 60 ms later: the curves lead the acoustic phones by about 60 ms, and the trainer applies that shift.

## Evaluation method

`lab_eval.py` computes exactly `lipsync_eval.line_metrics` per line for every model:
- Judy-rig geometry proxies, track correlations, contact / F/V / rounding recall and precision, and lag.

It then reports means with **cluster-bootstrap 95 % intervals**, with clusters being speakers for the held-out set and scenes for the per-character sets. Each model is also **paired** against a reference model.

Sets:
- `test` (1,024 lines), split into `test-clean` (833) and `test-flagged` (191);
- per-character held-out scenes;
- cloned held-out lines.

All of it runs on 32 threads in about 3–5 minutes per set of models.

## Experiments

Training ran on the 4080 with 6–9 DataLoader workers (`lab_train.py`, same recipe as `lipsync_model.py`). One 24-epoch run takes **about 6 minutes**. Kaggle was not used: a T4 kernel has 4 CPU cores, the data loader is the bottleneck, and the 1.5 GB dataset upload adds more. Kaggle would have been slower per run.

### 1. Per-character fine-tunes (Judy, Johnny, Panam) — no reliable gain

The base is the shared model with the phone head, trained clean, with the characters' held-out scenes excluded. Three variants:
- **ctrl:** 8 more epochs on all data, low LR (a control for "more steps");
- **only:** 8 epochs on that character's lines only;
- **focus:** half the batches from that character.

Paired differences vs the base, on the character's held-out clean scenes:

| | Judy (84 lines) | Johnny (34) | Panam (78) |
| --- | --- | --- | --- |
| ctrl | all within ±0.01 | contact r −0.016, else ±0.01 | all within ±0.01 |
| only | purse −0.024, width −0.014 | **aperture −0.057, purse −0.059, corner −0.070**; contact recall +0.15 but precision −0.19 | contact r +0.023, contact recall −0.057 |
| focus | contact r +0.013, roll +0.011 (≈ noise) | rounding recall +0.08, corner −0.046, aperture −0.009 | contact r +0.020, roll +0.014 |

- Fine-tuning on one character's lines only (10–25 minutes of audio) overfits.
- The 50 % focus mix trades metrics against each other with no consistent gain.
- JALI is one procedural system driven by text and audio, so a character adds little that a per-game model hasn't already learned.
- **Per-game models are the right default.**

### 2. Text conditioning — the big gain

The text is known at runtime: per phrase for Pocket and Omni, and for Convai.

| Variant (clean training, 833 clean held-out lines, vs the phone-head model) | contact r | purse r | corner r | width r | F/V rec | round rec |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Audio-derived phone head only (training-time, no runtime cost) vs plain baseline | +0.009 | +0.015 | +0.011 | +0.012 | +0.015 | +0.030 |
| Phone input, PocketSphinx whole-utterance alignment ("oracle") | +0.103 | +0.144 | +0.129 | +0.104 | +0.149 | +0.148 |
| Same, ±30 ms label jitter in training | +0.107 | +0.151 | +0.132 | +0.115 | +0.152 | +0.154 |
| Phone input delayed 200 ms (streaming), PocketSphinx labels | +0.063 | +0.104 | +0.088 | +0.081 | +0.056 | +0.099 |
| Own phone head + text Viterbi, whole phrase (no PocketSphinx), 2 full nets | +0.091 | +0.131 | +0.118 | +0.104 | +0.103 | +0.116 |
| Own phone head + streaming fixed-lag Viterbi, 200 ms delayed input, 2 full nets | +0.056 | +0.092 | +0.076 | +0.075 | +0.046 | +0.072 |
| **Stage 2 (64 ch) on 24-ep Candidate A, streaming** (all data) | +0.032 | +0.065 | +0.048 | +0.047 | +0.038 | +0.057 |
| **Stage 2 (64 ch) on 24-ep Candidate A, Omni whole phrase** (all data) | +0.089 | +0.102 | +0.083 | +0.078 | +0.102 | +0.080 |
| Single net feeding its own phone guesses back (streaming) | −0.18 | −0.19 | −0.18 | −0.13 | −0.51 | −0.53 |

- **Phone head as a training aid:** the multi-task head regularises the network towards phonetic distinctions. It is free at runtime, so Candidate A includes it. A weight of 0.1 was no better than 0.03.
- **Self-alignment:** the 24-epoch Candidate A's own phone head plus a left-to-right HMM over the text's phones (CMUdict plus the espeak OOV lexicon) agrees with PocketSphinx on 84 % of frames in whole-phrase mode and 83.5 % in fixed-lag streaming mode (3 frames). No PocketSphinx or other new dependency is needed at runtime.
- **Single network:** feeding a phone-input network its own head's labels collapses, with 37 % label agreement and a feedback loop. The audio-only network must produce the posteriors.
- **Stage 2** is a 64-channel, 4-block network (106 k weights). Its inputs are the 24-epoch Candidate A's last hidden layer and the aligned phones.
  - In streaming, phones are fed 230 ms late, exactly what a stream knows. So it adds **no latency** and keeps streaming-identical output.
  - Measured cost: +19 % for stage 2 and +1 % for the phone head, against the stage-1 network on one CPU thread. The Viterbi is negligible.
  - The shipped model measured 0.25–0.32 s CPU per second of audio under load, so this gives about **0.30–0.38**, at the edge of the ≤ 0.35 budget. A 48-channel stage 2 (about +11 %) is the safer setting, and should be measured before shipping.
- **Caveat:** on cloned audio the warped targets come from the same PocketSphinx alignment family, so clone-set text gains may be somewhat flattered. The held-out *game* audio results (authored curves, independent of our aligner) are the honest ones, and they show the same size of gain.

### 3. Cloned-voice domain training — no gain

- **Rendering:** OmniVoice (production settings: 16 steps, guidance 2, CUDA) and the Pocket student v2 export (CPU, production sampling: temp 0.3, 1 decode step). Each line is cloned from a different line of the same speaker, so held-out speakers use only held-out references.
  - Omni: 2,570 lines in 102 minutes.
  - Pocket: 770 lines in 16 minutes.
- **Warping** (`lab_clone.py warp`): PocketSphinx aligns the clone with the same text. Clone time is mapped to original time through matched word and phone boundaries, and the original's full track set is resampled onto the clone clock. Clone-only pauses over 120 ms relax to rest.
- **Validation:** an independent DTW on MFCCs between original and clone agrees with the phone-boundary map within **16 ms median (p90 51 ms) for Omni** and **20 ms (p90 78 ms) for Pocket**. Lines over 80 ms were dropped. Omni clones run at 0.96× the original duration (p10 0.66, p90 1.33); Pocket at 0.79×.
- **Result:** the 1,901 warped training clones were mixed in at 30 % of batches (candidate C).
  - On Omni clones: aperture r +0.006, contact r +0.014, F/V +0.03.
  - On Pocket clones: ±0.005.
  - On game audio: −0.002.
  - That is within or just above noise, so it was not adopted.
- **Domain shift is real but generic:** every model loses about 0.08–0.1 in aperture r on clones, partly from the warp. Better models gain on clones as much as on game audio. The cloned test sets are kept for future evaluation.

### 4. Other ideas

- **Bigger teacher plus distillation:**
  - The teacher (384 channels, 9 blocks, 1.43 s receptive field, about 8× the compute) is itself only a little better: aperture +0.006, purse +0.027, protrusion +0.015, contact precision +0.04 but recall −0.04.
  - The distilled student (with clone audio as unlabeled data) is within ±0.005 of the 24-epoch Candidate A.
  - Capacity is not the bottleneck; information (phonetics) is.
- **Acceleration loss:** −0.005 to −0.011. Rejected.
- **260 ms lookahead:** contact r +0.009 and roll +0.011, but width −0.007 and rounding −0.017. No net gain, and it costs latency. Rejected.
- **Seed noise:** a second seed of the clean baseline differs by ≤ 0.005 on correlations and about 0.01 on recall/precision.
- **Training length** matters more than any architecture or loss tweak: 24 → 48 epochs gains +0.007 to +0.022; 48 → 96 gains +0.003 to +0.009, plus precision. The 96-epoch run takes 14 minutes on the 4080.
- **Second seed of Candidate A (24 ep):** within ±0.002 on correlations.

## Compute used

- About 35 training runs of 6–15 minutes each on the local 4080, plus evaluation on CPU. Two OmniVoice rendering hours on the GPU. 16 minutes of Pocket on CPU.
- The laptop was on Balanced; no single job exceeded 1 hour of full CPU.
- Lesson: more than about 4 parallel training jobs exhausted the Windows commit limit and crashed runs. Use at most 3.
- No Kaggle quota used.

## Install Candidate A (needs the user's approval)

1. Back up `runtime/lipsync-model/face-model.json` and `face-model.bin`.
2. Copy `runtime/lipsync-model/candidate-aux-e96-20261007/face-model.json` and `face-model.bin` over them.
3. Restart the bridge. The model is only loaded at bridge start; no Lua, archive or game change is needed.
4. Roll back by restoring the two files, or with `CYBERPUNK_CONVAI_FACE_MODEL=off`.

Checks already done:
- `lab_parity.py`: max |JS − NumPy| 5e-6 over 8 held-out lines streamed in 80 ms packets, so output is streaming-identical;
- JS 0.07–0.09 s CPU per second of audio on this machine, the same network and cost as shipped. The shipped model measured 0.12 under the same background load.
- The NumPy source is `runtime/lipsync-model/candidate-aux-e96-20261007.npz`.

In-game checks: the same as the earlier lip-sync plan (m/b/p closure, f/v, "oo" rounding, rest between phrases, on Pocket, Omni and Convai).

## Text conditioning: what shipping needs

**Done the same evening:** see the addendum at the end ("the text path is built into the runtime").

1. **JS:**
   - keep the phone head (`aux.w/b`) in the export, so it is no longer dropped;
   - a stage-2 network in `jali-face-model.mjs` (the same conv code), and a phone-lexicon module (CMUdict as a compact table, about 1 MB gzipped);
   - an incremental fixed-lag Viterbi, about 60 lines, ported from `lab_textalign.StreamViterbi`;
   - output stays streaming-identical, because phone decisions are final once made.
2. **Text plumbing:**
   - pass each phrase's text to the face worker: Pocket and Omni already know it per phrase, and Convai streams the transcript.
   - For a phrase whose words are all missing from the lexicon, fall back to Candidate A. A letter-to-sound fallback is an option.
3. **Omni:** use whole-phrase Viterbi plus the delay-0 stage 2 (`s2_omni`). **Pocket and Convai:** use streaming lag 3 plus the 230 ms-delayed stage 2 (`s2_stream`).
4. Measure JS CPU under game load with a 64- and 48-channel stage 2. Write a parity test as for Candidate A.

Research weights are in `runtime/lipsync-model/research-text-20261007/`: `candA_all_aux.pt`, `s2_stream.pt`, `s2_omni.pt`. These are PyTorch files; export to the JS format is still to be written.

## What to add to the lip-sync service proposal

(For `Downloads/devslot handoff 2026-10-07 lipsync service/`. Not edited here.)

- **Per-game models by default.**
  - One model trained on all of a game's authored facial data is the right default.
  - Per-character fine-tunes showed no reliable gain on held-out scenes (±0.01, and single-character tuning overfits). They can still be offered as an option if the customer wants them.
  - We handle the training and the inference either way.
- **Send the text.** The single largest improvement is using the dialogue text.
  - Aligned against the audio by the model itself (no extra aligner service), it gives about +0.03 to +0.07 (streaming) and +0.08 to +0.10 (whole line) in lip-contact, rounding and F/V correlation.
  - The API should accept the line or phrase text with the audio; audio-only remains the fallback.
- **Data preparation step:**
  - "The agent cleans the data: for lip sync, keep shouted and processed lines when the authored curves are valid; for voice, exclude them."
  - Report the share flagged; here it was 24 %.
  - Join transcripts to lines, de-duplicate shared recordings, and hold out by speaker and scene so nothing leaks.
- **Training-only phonetic supervision** improves the small runtime model at no inference cost. If the customer's data has transcripts, we use them for training even when inference is audio-only.
- **Evaluate on the customer's TTS or cloned voices,** not only their recorded VO. We render clones of held-out lines and warp the authored curves onto them; the DTW check agreed within 16–20 ms median. Expect about 0.1 lower aperture correlation on synthetic voices for any model.
- **Small is enough:** an 8× bigger network gained ≤ 0.03. The 2.7 MB CPU model is the product; the text path adds about 20 % CPU.

## Reproduce

```bash
cd scripts/lipsync
PY=../../vendor/reference-voicestudio/.venv/Scripts/python.exe   # CUDA torch (training, OmniVoice, espeak g2p)
PP=../../vendor/pocket-tts-env/Scripts/python.exe                # PocketSphinx, Pocket, evaluation
$PP lab_data.py                       # pack + split2.json (E:/CyberpunkConvai-offload/work/lipsync-lab/pack)
$PP lab_clean.py                      # clean.json (combat / effect flags)
$PY lab_align.py g2p && $PP lab_align.py align   # phone labels
$PY lab_train.py --out <lab>/models/candA_e96.npz --aux-phones 0.03 --epochs 96            # Candidate A
$PY lab_train.py --out <lab>/models/candA_all_aux.npz --aux-phones 0.03 --save-pt          # 24-ep stage 1 for stage 2
$PP lab_eval.py --model final=../../runtime/lipsync-model/final.npz --model candA=<...>.npz \
    --sets test,test-clean,test-flagged,char:judy,char:johnny,char:panam --out <report.json>
$PP lab_parity.py <...>.npz ../../runtime/lipsync-model/<new-folder>                        # export + JS parity
$PY lab_stage2.py --stage1 <candA>.pt --out <lab>/models/s2_stream.pt --lag 3              # text stage 2
$PP lab_textalign.py --stage1 <candA>.pt --out <labels> --mode stream --lag 3              # self-alignment
$PP lab_eval.py --model candA=<...>.npz --model s2=<s2_stream.pt> --label-dir <labels> --sets test-clean
$PP lab_clone.py select; $PY lab_clone.py omni; $PP lab_clone.py pocket --per-set 300; $PP lab_clone.py warp --engine omni
```

All corpus, audio, clones, labels and weights stay in ignored folders: `runtime/` and `E:/CyberpunkConvai-offload/work/lipsync-lab/`.


## Addendum: the text path is built into the runtime (2026-10-07, evening)

The user approved:
- **Candidate A is installed.** The coordinator copied it over `face-model.*`; the backup is `E:\CyberpunkConvai-offload\backups\lipsync-face-model-20261007-162230`.
- **The text stage was built on top of it.**

What was built:
- **Stage 1 = the installed Candidate A, unchanged.**
  - Its phone head was refit on the frozen network (`lab_auxhead.py`): a 1×1 layer over 40 phones, 80 % frame accuracy against the PocketSphinx labels. This way the head sits on exactly the shipped weights.
  - `face-text.json` records the SHA-256 of the `face-model.bin` it belongs to. The worker refuses a mismatched pair.
- **Stage 2:** two 64-channel nets, 4 blocks (dilations 1, 2, 4, 8), 106 k weights each, trained 48 epochs on stage 1's hidden layer.
  - stream: the phone input is decided 3 rows late (Pocket, Convai);
  - phrase: the whole phrase is aligned first (Omni).
  - 48 channels was measured and was clearly worse: Omni contact r +0.027 vs +0.051, purse +0.011 vs +0.025.
  - 48 epochs beat 16: phrase purse +0.05, contact +0.012; stream +0.002 to +0.012.
- **Pronunciation table** (`face-lexicon.txt.gz`, 0.86 MB): CMUdict from Rhubarb's PocketSphinx resources (BSD-2-Clause; notice in `face-lexicon-NOTICE.txt`), plus 6,553 game-vocabulary words (choom, preem, Kiroshi …) from the game's 98 k subtitles.
  - The game words' pronunciations were generated with espeak-ng, which is GPL-3. The output of a GPL program is generally not covered by it, but if the user wants zero doubt, drop those lines. Words not in the table fall back to the audio model, which is the garbage path below.
- **Reply text normalisation:**
  - `{emotion}` tags are dropped.
  - `[voice tags]` and any other `[...]` become a garbage state: the mouth follows the audio model there.
  - Numbers become words: 2077 → "twenty seventy seven", 2,077 → "two thousand seventy seven", $300 → "three hundred dollars", 5% → "five percent".
  - Letters outside the table's alphabet become garbage.
- **Python reference and JS:** the reference is `scripts/lipsync/lab_textpipe.py`. `bridge/jali-face-text.mjs` mirrors it line by line.
  - `scripts/lipsync/lab_textparity.mjs` checks them against each other.
  - Normalisation and alignment labels are identical.
  - Output rows: max |JS − Python| is 2e-6 in stream mode. In phrase mode it is ≤ 3e-3 on 0.26 % of values: float rounding magnified by near-vertical steps in the quantile maps, with labels identical.
  - Streamed output is identical for 80 ms, 333-sample and whole-utterance packets.

### Final results vs Candidate A

Held-out speakers, 1,024 lines, paired 95 % CI. The phrase column uses the Omni whole-phrase mode.

| Metric | Candidate A | + text, streaming (Pocket / Convai) | + text, phrase (Omni) |
| --- | ---: | ---: | ---: |
| Aperture r | 0.843 | 0.849 (+0.005 [+0.005, +0.006]) | 0.856 (+0.013 [+0.009, +0.015]) |
| Aperture error (mm) | 1.08 | 1.06 (−0.023) | 1.04 (−0.046) |
| Width r | 0.535 | 0.558 (+0.023 [+0.019, +0.027]) | 0.591 (+0.056 [+0.048, +0.062]) |
| Protrusion r | 0.715 | 0.734 (+0.019) | 0.760 (+0.045) |
| Contact control r | 0.794 | 0.805 (+0.012 [+0.008, +0.018]) | 0.856 (+0.063 [+0.048, +0.077]) |
| Purse r | 0.704 | 0.739 (+0.035 [+0.028, +0.040]) | 0.782 (+0.078 [+0.068, +0.088]) |
| Corner stretch r | 0.717 | 0.741 (+0.024) | 0.783 (+0.066) |
| Lower roll r | 0.789 | 0.801 (+0.012) | 0.858 (+0.069) |
| Contact recall / precision | 0.555 / 0.448 | 0.548 / 0.469 (−0.007 / +0.021) | 0.566 / 0.477 (+0.011 / +0.028) |
| F/V recall | 0.746 | 0.769 (+0.022 [+0.011, +0.031]) | 0.823 (+0.077 [+0.055, +0.100]) |
| Rounding recall / precision | 0.714 / 0.397 | 0.751 / 0.429 (+0.037 / +0.025) | 0.779 / 0.459 (+0.065 / +0.050) |
| Lag | 0 ms | 0 ms | 0 ms |

Across the other test sets:
- **Per character:**
  - Judy, streaming: purse +0.052, rounding recall +0.10.
  - Judy, phrase: contact +0.10, purse +0.11, F/V +0.18.
  - Johnny and Panam: similar gains.
- **Clones:**
  - OmniVoice clones, phrase mode: contact +0.033, purse +0.067, rounding +0.058.
  - Pocket clones, streaming: purse +0.041, corner +0.032, rounding +0.031.
- **Flagged combat/effect lines:** the same pattern.
- **The one consistent cost:** streaming lip-contact *recall* is −0.007 to −0.026 (fewer, more precise closures; precision up to +0.02). This is worth watching in game on m/b/p.
- **How often the text path drops out:** the text path is active on 97 % of held-out lines (the rest have no alignable words). The confidence latch gave up on 1.5–2 % of lines with the right text. On mismatched text it gives up on 82 %; the threshold was set at the 99th percentile of right-text windows.

**CPU** (single thread, the bridge's `FaceModelStream`, 80 ms packets):
- **With 30 busy threads on this machine:** the audio model alone takes 0.122 s per audio second; with text, 0.151 s, i.e. +24 %. Without the synthetic load the overhead was +16–18 %.
- **Estimate in game:** the shipped model measured 0.25–0.32 s per second inside the game with Pocket training running. Scaled by +20 %, that gives about **0.30–0.38 s**, at or slightly over the 0.35 budget in the worst case.
- **Safety net:** the worker drops the text path for a stream whose packets wait more than 250 ms in its queue, or whose text work exceeds 40 % of real time. The mouth then eases back to the audio model; the face never waits for text.

### How the routes use it

- **Omni:** `synthesizeOmniPhrase` passes the phrase text as voiced (tags included) to `analyseWav`. The worker aligns the whole phrase, then releases the rows.
- **Pocket:** `PocketFacialStream` starts the model with the whole reply text (`result.text`). The rows stream with no added latency.
- **Convai continuous:** the session starts with the snapshot text so far (`textComplete: false`). Each later snapshot calls `setText`.
  - Text alignment starts when the first whole word is known, catching up on the audio already heard. Stage 2 then warms up for 330 ms before it takes over.
  - The text still to come is a penalised tail state.
  - A text that no longer extends what was aligned gives up for that reply.
- **Fallback to Candidate A,** with a 60 ms blend each way:
  - no text, or no alignable word;
  - voice tags and unknown words (for their frames);
  - low alignment confidence (latched for the rest of the reply);
  - the real-time guard;
  - any text-path error;
  - a face-text built for another face-model;
  - `CYBERPUNK_CONVAI_FACE_TEXT=off`.
- **Streaming vs whole utterance:** identical in stream mode. Two exceptions:
  - the real-time guard depends on timing;
  - Convai text that arrives after the audio starts.
  Omni's phrase mode is by design a whole-phrase analysis.

### Install

- **Already in place:** `runtime/lipsync-model/` holds `face-text.json`, `face-text.bin`, `face-lexicon.txt.gz` and `face-lexicon-NOTICE.txt`. They were built against the installed Candidate A.
- **To activate:** restart the bridge so it loads the new JavaScript. No Lua, archive or game restart is needed.
- **To roll back:** set `CYBERPUNK_CONVAI_FACE_TEXT=off`, or delete the `face-text.*` files. The mouth then uses Candidate A alone.
- **Release packaging:** `bridge/jali-face-text.mjs` is listed as a worker-only file in `packaging/runtime-layout.mjs` and `release-plan.json`. The weights and lexicon go with the other lip-sync weights at release.

### What to check in game

- **Omni (biggest change):**
  - m/b/p closures land on the word;
  - "oo"/"w" rounding;
  - F/V lower-lip tuck;
  - "ee" stretch;
  - a `[laughter]` or `[sigh]` phrase keeps an audio-driven mouth during the sound.
- **Pocket:** the same, plus that closures are not missing compared with yesterday (streaming contact recall is slightly lower).
- **Convai:** a long reply whose text streams in. The mouth should not jump when text conditioning takes over, about 0.3 s after the first words.
- **Performance:** the Omni timing receipt carries `lipText` (`active`, `lost`, `reason`). If `reason` is often `budget` or `behind`, the CPU is short; set `CYBERPUNK_CONVAI_FACE_TEXT=off`.

### Not done

- No Kaggle runs: no further training was needed. The 48-channel and 48-epoch variants had already finished locally before the user switched to Silent.
- A stage 2 trained for 96 epochs may add a little more; the 16 → 48 epoch step gained up to +0.05 on phrase purse.
