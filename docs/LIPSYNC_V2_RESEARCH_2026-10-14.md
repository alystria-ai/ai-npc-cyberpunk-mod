# Lip-sync v2 research (2026-10-14)

**Status: offline research only. Nothing live was installed or replaced: `runtime/lipsync-model/face-model.*` and
`face-text.*` are untouched, and so are the bridge, the Lua and the calibrated downstream path. Candidate files sit in
`E:\CyberpunkConvai-offload\work\lipsync-lab\v2\` (game-derived weights, ignored folder). The user decides.**

The question: a better lip-sync model, "especially the variety in shapes and the quality of shapes", with no
degradation anywhere.

## Summary

- **What is live** (checked by SHA-256, not taken from the docs):
  - Candidate A (`candidate-aux-e96-20261007`) is the audio model, stage 1.
  - Stage 2 text conditioning *was* built and is live: the stream net is trained 48 epochs (Pocket / Convai), the phrase net 96 epochs (Omni).
  - Details in "What is live now".
- **Where the shapes fall short.** Measured against the game's own JALI curves on held-out speakers:
  - The overall shape repertoire is close to the game's. On a 32-shape codebook the model uses 25 shapes where the game uses 27, measured by perplexity.
  - The deficit is in specific controls, which reach their peaks too rarely or too weakly:
    - corner stretch, stretch and lower-lip raise (the "ee"/spread family) reach 66–70 % of the game's peak height;
    - purse, 75 %;
    - tongue forward, 72–75 %;
    - F/V lower-lip contact reaches the game's p95 only 57 % as often as the game does.
  - Funnel overshoots (105–125 %).
- **Best candidate found: stage 2 trained on the labels the runtime actually sees.**
  - At runtime, stage 2 is fed phones from the model's own phone head plus the text Viterbi, which agree with PocketSphinx on only about 85 % of frames. It was trained on clean PocketSphinx labels.
  - Fine-tuning the shipped phrase net for 16 epochs (9 min) on runtime-decided labels gives clear gains in Omni phrase mode on held-out speakers, Omni clones and Pocket clones:
    - width r +0.011 to +0.015, purse r +0.014 to +0.019, lower roll r +0.007 to +0.011;
    - F/V recall +0.007 to +0.030, rounding recall +0.015 to +0.020, contact r +0.005 to +0.010.
  - The same CPU cost, the same files, the same format: it is a drop-in.
  - A control fine-tune with the old labels changes nothing, so the gain comes from the labels, not from the extra epochs.
- **No-degradation verdict: the best candidate does NOT pass the hard gate, so it is not recommended for install as is.**
  - The candidate (`v2/candidate-rtlabels-20261014`) has a new phrase net (Omni only), an average of two seeds. Pocket, Convai and the no-text fallback stay byte-identical.
  - One check fails with an interval wholly on the wrong side:
    - on Omni clones, `woman_average` heads over-open (written jaw > .20 where the game keeps the mouth shut) on 8.6 % of shut frames instead of 8.4 %;
    - about 2 extra frames per 1,000 silent frames;
    - reproduced by both seeds, so it is real.
  - A variety measure also moves the wrong way: purse reaches the game's p95 less often (0.77 → 0.70 held-out), even though purse correlation and rounding recall improve.
  - Everything else is a gain or a tie. The user decides whether that trade is acceptable.
  - Seven fixes for the over-opening were tried (Experiments 3–10): penalties, interpolation, a label mix, jaw distillation and a runtime jaw split. Each one either keeps a smaller version of the loss or trades it for a jaw-correlation or contact-recall loss.
- **Rejected**, both measured at 24 epochs against a 24-epoch control (detail below):
  - variance-matching loss: width −0.016, purse −0.018, rounding −0.012;
  - peak-weighted loss: width −0.008, purse −0.013.
  - Both raise closures a little but lose correlation. That is the over-smoothing trade-off the literature warns about.
- **Also found and fixed in the research tooling:** the 2.9e-3 JS/Python phrase-mode mismatch reported on 2026-10-07 was not quantile-map rounding.
  - It was a bug in the Python reference (`lab_textpipe.py`), which re-blended stage 2 into the last 0.2 s of a phrase whose alignment had been given up.
  - The bridge was right. Parity is now within 2.5e-6 in both modes.

(Sections below; numbers are paired against the shipped stack with speaker-cluster bootstrap 95 % intervals.)

## What is live now (verified)

All of the following are checked by file hash against `runtime/lipsync-model/` in the main checkout.

- **`face-model.bin`** is SHA-256 `8c223636…` and equals `candidate-aux-e96-20261007/face-model.bin`.
  - So Candidate A of 2026-10-07 *was* installed. Backup: `E:\CyberpunkConvai-offload\backups\lipsync-face-model-20261007-162230`.
  - It is a 160-channel, 6-block dilated conv net with 200 ms lookahead and 15 mouth outputs plus brows, at about 0.66 M weights.
- **`face-text.bin`** is SHA-256 `4156e4f9…` and equals `text-s48p96/face-text.bin`.
  - Rebuilding it from the research weights reproduces it byte for byte (`lab_textswap.py`): stream net `models/f_s2_stream64_e48.pt`, phrase net `models/f_s2_omni64_e96.pt`, phone head `models/e96_head.pt`.
  - So **stage-2 text conditioning was built and is live**:
    - Pocket and Convai use the stream net;
    - Omni uses the phrase net;
    - with the confidence latch and the fallback to Candidate A described in `LIPSYNC_IMPROVEMENTS_2026-10-07.md`.
- **The TODO item "stage 2 for 96 epochs" is half done.**
  - The phrase net is at 96 epochs.
  - The stream net stayed at 48, because 96 gave no gain and a small Omni-clone regression.
  - This report folds that item in. A longer plain retrain does nothing more: a 16-epoch continuation with the same labels changes every metric by ≤ 0.004.
- **Runtime cost** (JS, `lab_textparity.mjs`, one thread, this machine under background load):
  - audio model 0.015–0.04 s CPU per audio second;
  - with text, +24 % to +40 % on top (it varies with load).

### The shipped stack, measured with the new gate (`v2/gate_shipped.json`)

All three runtime modes:
- **audio** = no text, the fallback;
- **stream** = Pocket and Convai;
- **phrase** = Omni.

Sets:
- held-out speakers (1,024 lines);
- OmniVoice clones of held-out lines (336);
- Pocket clones (251).

| Metric | test audio | test stream | test phrase | Omni clones phrase | Pocket clones stream |
| --- | ---: | ---: | ---: | ---: | ---: |
| Aperture r | 0.843 | 0.849 | 0.857 | 0.775 | 0.749 |
| Aperture error (mm) | 1.08 | 1.06 | 1.03 | 1.29 | 1.38 |
| Width r | 0.535 | 0.558 | 0.597 | 0.611 | 0.594 |
| Protrusion r | 0.715 | 0.734 | 0.765 | 0.729 | 0.696 |
| Contact r | 0.794 | 0.805 | 0.859 | 0.803 | 0.792 |
| Purse r | 0.704 | 0.739 | 0.786 | 0.765 | 0.726 |
| Corner stretch r | 0.717 | 0.741 | 0.786 | 0.770 | 0.710 |
| Lower roll r | 0.789 | 0.801 | 0.866 | 0.845 | 0.814 |
| Contact recall / precision | 0.555 / 0.448 | 0.548 / 0.469 | 0.562 / 0.480 | 0.523 / 0.402 | 0.536 / 0.362 |
| F/V recall | 0.746 | 0.769 | 0.834 | 0.862 | 0.832 |
| Rounding recall / precision | 0.714 / 0.397 | 0.751 / 0.429 | 0.785 / 0.462 | 0.824 / 0.444 | 0.778 / 0.410 |
| Closure events reaching full contact | 0.696 | 0.722 | 0.756 | 0.827 | 0.804 |

## Where shape variety and quality fall short

The new per-control measures run on speaking frames (the game's jaw > .02), against the game's authored curves on the
same held-out lines. `peak` is the timing-tolerant peak attainment: on frames where the game is at or above its own p95
for that control, the model's best value within ±2 frames divided by the game's value. `reach` is how often the
model reaches the game's p95, relative to how often the game does (1.0 = as often). Shipped stack, held-out speakers:

| Control | audio peak (reach) | phrase peak (reach) | Reading |
| --- | --- | --- | --- |
| jaw | 0.92 (0.82) | 0.91 (0.85) | fine |
| lip contact up / down | 0.83 / 0.82 (0.79 / **0.57**) | 0.86 / 0.84 (0.79 / **0.57**) | lower-lip (F/V) contact rarely reaches full strength |
| purse | **0.75** (0.76) | **0.75** (0.77) | rounding peaks too weak |
| funnel | 1.05 (1.14) | 1.06 (1.01) | slight overshoot |
| corner stretch / stretch / lower raise | **0.69 / 0.66 / 0.66** | **0.70 / 0.69 / 0.69** | the "ee"/spread family is the weakest |
| upper raise | 0.73 | 0.82 | text helps |
| upper / lower roll | 0.96 / 0.91 | 0.99 / 0.98 | fine |
| puff, cheek puff | 1.04 / 1.04 | 1.05 / 1.07 | fine |
| tongue tip up / forward | 0.75 / 0.72 | 0.84 / 0.75 | weak, and the tip fires too often (reach 1.5–1.85) |

Shape codebook: k-means with 32 shapes on the game's 15-control mouth vectors. The game uses a perplexity of 26.9
shapes; the model 25.1–25.3. Per-frame shape agreement is 0.35 (audio), 0.38 (stream) and 0.42 (phrase).

So the repertoire is not the problem: the quantile maps already restore each control's value distribution. The
problem is that the model often picks a nearby, weaker shape at the moment of a peak (regression to the conditional
mean), most of all on the spread family, purse and F/V. Text conditioning helps most where the phone identity decides
the shape (F/V, rounding, upper raise). Cloned voices look "more varied" (reach ≥ 1) only because their warped
targets are smoother, not because the model is sharper there.

The "50 controls" question: the runtime model drives 15 symmetric mouth outputs (23 native tracks). Restricted to the
graph's 50 controls, the game's own curves reproduce native mouth geometry almost exactly (inner aperture r 0.994;
`GAME_LIPSYNC_MODEL.md`), so no unused control is needed for mouth shape. The game never uses `lips_apart_*` or
`lips_tighten_*`. The corner pull and smile seen in the game's width p95 belong to the expression layer. Adding
outputs would change the format and the downstream calibration, so it is out of scope for a drop-in.

## The no-degradation gate (`scripts/lipsync/lab_gate.py`)

A candidate is a folder with the same four files the bridge loads. It is run through `lab_textpipe.TextPipeline`,
the line-by-line Python mirror of `bridge/jali-face-text.mjs` (parity within 2.5e-6 after today's fix), in all three
runtime modes, on held-out speakers, Omni clones and Pocket clones. Against the shipped stack it reports:

1. **Every existing metric** (`lipsync_eval.line_metrics`):
   - aperture, width, protrusion, chin, jaw, contact, purse, corner stretch and lower roll correlations;
   - aperture error;
   - contact recall and precision, F/V recall, rounding recall and precision;
   - lag.
   - Each as a paired difference with a speaker-cluster bootstrap 95 % interval.
2. **Shape variety:** per-control std ratio, p95 reach, peak attainment, per-line std ratio, velocity ratio and Wasserstein distance; the shape codebook.
3. **The frozen downstream path, in the units the game receives:**
   - the bridge and Lua limits (jaw .7, contact 1.0, lower roll .8, upper roll .3, puff .45, cheek puff .35, others .5);
   - then `mod/facial-playback.lua`'s `liftJaw`, re-implemented exactly with the per-head constants of the 2026-10-09 screenshot sweep:
     - Judy: no lift, lips part at jaw .06;
     - `woman_average`: q = 2, floor .21, lips part at about .20;
     - `man_average` / `man_big` / `man_fat`: q = 1.5, floor .17, lips part between .12 and .20.
   - Checks:
     - the share of speaking frames whose *written* jaw passes each head's lip-part point (Judy .06, woman_average .20, men .12 / .16 / .20), which must not drop;
     - over-opening: the share of frames the game keeps shut where the written jaw exceeds .20 or .35, which must not rise;
     - the jaw p99;
     - closure events (both contact controls ≥ .8 in the game) whose prediction reaches full contact (≥ .9 within ±2 frames), and the mean closure peak;
     - every control's maximum vs the shipped maximum and the validated limits;
     - informational: the expression-budget inputs the Lua writer derives from the mouth (closure ≥ .85 frames, full rounding).
4. **The verdict:**
   - **strict** = no paired interval reaches below zero on any check;
   - **non-inferior** = no interval wholly below zero, and no mean loss larger than the measured seed noise (±0.002 r, ±0.01 rates).
   - Maximum or limit excess and any lag change always fail.

Other gate items checked outside the script:
- **JS parity:** `lab_textparity.mjs` must be ≤ 1e-5 in stream and phrase modes and for every packet size.
- **CPU:** stage-2-only candidates have the same tensor shapes, so the same FLOPs and the same code path. `lab_textswap.py` refuses any shape, dilation or phone-shift change.
- **Output format:** byte-compatible `face-text.json` and `.bin`. Same tensor order and offsets, same `stage1Sha256`, same phone head, prior, lexicon and alignment settings.

### How the calibration is preserved

- **Untouched:**
  - the retarget (v10);
  - `mapArkit` (Convai ARKit fallback);
  - the Omni `coarticulated-v5` phonetic poses (the Rhubarb fallback path);
  - the native renderer, interpolation and cleanup;
  - the Lua jaw lift and floor;
  - the chin and corner ducks;
  - the contact and jaw limits.
- None of those paths read model weights. A stage-2 candidate changes only the numbers flowing into the same 25 timeline tracks, at the same rate, lead and clamps.
- **The model's ranges stay inside the validated envelope.**
  - Every output passes through a quantile map whose top equals the game's authored maximum, so no control can exceed what the game itself writes. The bridge and Lua clamps apply on top.
  - The gate checks each control's maximum against the shipped one (+.02 tolerance) and the limits.
- **Jaw against the head-type calibration:**
  - The gate measures, after the frozen lift, how often speaking frames clear each head's measured lip-part point. This is the check the 23-character sweep implies.
  - It also measures how often silent frames over-open. A candidate must not lower the first or raise the second.
- **Closures:** contact must still reach full strength (≥ .9; 1.0 closes the lips on Judy's rig at jaw ≤ .2) on the game's closure events at least as often as the shipped stack.
- **What would need a new screenshot check:**
  - Nothing, for a stage-2-only candidate that passes, because no value leaves the validated range and the jaw distribution is unchanged within ±0.002.
  - A new stage 1, new outputs, or any change to the lift and limits would need the 23-head sheet re-captured (`runtime/face-captures/lipsync-check/`).

## Experiments (all small, local 4080 plus CPU evaluation)

Stage 1 (Candidate A) stays frozen in every experiment, so the audio-only fallback is byte-identical and the
`face-text` pairing (`stage1Sha256`) stays valid. Only stage-2 nets were trained (64 channels, dilations 1-2-4-8,
106 k weights, exactly the shipped shape).

### 1. Anti-mush losses: rejected

Omni phrase net, 24 epochs each, paired against a 24-epoch control with the shipped recipe. Held-out speakers, then
Omni clones (`v2/gate_screen1.json`):

| Variant | width r | purse r | corner r | rounding rec | F/V rec | contact r | closures full |
| --- | --- | --- | --- | --- | --- | --- | --- |
| variance matching (`--var 1`, FDD-style per-sequence std) | −0.016* / −0.016* | −0.018* / −0.015* | −0.014* / −0.013* | −0.012* / −0.011* | +0.006* / +0.002 | +0.002* / −0.000 | +0.014* / −0.002 |
| peak-weighted MSE (`--peak 1`) | −0.008* / −0.008* | −0.013* / −0.011* | −0.012* / −0.011* | +0.009* / +0.010 | +0.008* / +0.000 | +0.000 / +0.001 | +0.017* / +0.001 |

`*` = interval excludes 0.

- Both raise closure peaks and a few amplitudes (funnel, puff, tongue +0.03 to +0.06 peak attainment).
- But they lose width, purse and corner correlation and contact precision (−0.010 to −0.016). Shapes get bigger but land less often on the right frame.
- That is exactly the risk the literature flags for distribution-matching losses on a small regressor. They fail the gate outright.

### 2. Train stage 2 on the labels the runtime decides: the gain

- **Why.** At runtime, stage 2 is fed phones from the shipped phone head plus the text Viterbi (`lab_textpipe.Aligner`). On training lines these agree with the PocketSphinx labels it was trained on for only 85.8 % of frames.
- **What.** `lab_runlabels.py` writes, for all 5,113 training lines, the labels exactly as the runtime decides them:
  - phrase mode: full-path decisions;
  - stream mode: fixed lag 3.
  - It took 9 minutes per mode on 8 processes. 23–34 lines lost their alignment, as they would at runtime.
- **Screening** at 24 epochs from scratch, against the 24-epoch control:
  - Runtime labels with no jitter: aperture r +0.002, width +0.010, protrusion +0.013, contact r +0.010, purse +0.018, lower roll +0.014, F/V recall +0.025, rounding recall +0.027. All intervals exclude 0 on held-out speakers, and the gains are similar on Omni clones.
  - The weak spot: Omni-clone closures reaching full contact, −0.025.
  - A 50/50 mix with PocketSphinx labels gives about half the gain.
- **Fine-tuning the shipped nets** (16 epochs, peak LR 5e-4, about 9 minutes each). Paired against the shipped stack on all sets (`v2/gate_ft1.json`). The gain over shipped holds on top of 96 epochs.
  - **Phrase mode (Omni):**

    | | held-out speakers | Omni clones | Pocket clones |
    | --- | --- | --- | --- |
    | width r | +0.011* | +0.012* | +0.015* |
    | protrusion r | +0.011* | +0.010* | +0.013* |
    | purse r | +0.015* | +0.014* | +0.019* |
    | corner r | +0.007* | +0.006* | +0.013* |
    | lower roll r | +0.011* | +0.008* | +0.007* |
    | contact r | +0.008* | +0.010* | +0.005* |
    | F/V recall | +0.030* | +0.014* | +0.007* |
    | rounding recall | +0.020* | +0.020* | +0.015* |
    | rounding precision | +0.009* | +0.007* | +0.006 |
    | aperture error | −0.011 mm* | −0.008 mm* | −0.014 mm* |
    | contact precision | +0.010* | +0.001 | +0.008* |

  - **Stream mode (Pocket, Convai):** +0.002 to +0.005 on width, protrusion, contact, purse, corner and roll.
  - **The losses**, all within seed noise but some with intervals wholly below 0:
    - jaw r −0.0002 (held-out, stream);
    - over-opening on `woman_average` heads at jaw > .20 on shut frames: 8.4 % → 8.7 % (Omni clones, phrase);
    - `man_*` heads past .20: −0.17 points (Pocket clones, stream);
    - contact recall −0.005 (Omni clones, phrase; interval crosses 0).
  - **Control:** the same fine-tune with the old PocketSphinx labels changes every metric by ≤ 0.004. The gain is the labels.
- **Shape variety** barely moves:
  - peak attainment of the spread family +0.01;
  - funnel overshoot −0.01 to −0.03;
  - codebook agreement +0.008 (phrase, held-out).
  - So this improves the *quality* of shapes (the right shape on the right frame) more than their amplitude.

### 3. Over-opening fix: jaw penalty on shut frames: rejected

To remove the small jaw side effect, the fine-tune was repeated with an extra penalty on any jaw opening where the
authored mouth is shut (`--shut 2`), with and without weight averaging (EMA 0.998), for both nets (`v2/gate_ft2.json`,
`v2/gate_soupS.json`).

- It does what it says on silent frames: over-opening drops by 0.2–0.8 points on every head, and lifted heads part
  their lips on 1–2 points more speaking frames.
- But it flattens the jaw: jaw r −0.021 to −0.036, aperture r −0.013 to −0.028, aperture error +0.03 to +0.07 mm,
  contact recall −0.009 to −0.026 on every set, in both modes. The stream version also lifts the lower-roll maximum
  past the shipped one (+0.021). EMA changes nothing. Rejected outright.

### 4. Weight interpolation (shipped ↔ fine-tuned): no better

Interpolating the shipped and fine-tuned weights (50 % and 75 %, quantile map refit; `--soup`, `v2/gate_soupP.json`,
`v2/gate_soupS.json`) scales the gains down roughly linearly but does not remove the small losses. The refit quantile
map turns contact recall into a small significant loss (−0.005 to −0.008) instead. Not better than the full fine-tune.

### 5. Second seed and seed average

A second seed of the phrase fine-tune (`v2/gate_seeds.json`) reproduces the gains within ±0.002 and also reproduces the
one small over-opening finding (below), so that finding is real, not noise. A uniform average of the two seeds'
weights (both start from the shipped net, so they average cleanly) is the best phrase net found: same gains, and its
contact recall difference shrinks to −0.000 / −0.001 / −0.004 (all intervals cross 0).

### 6. Stream net (Pocket, Convai)

The stream fine-tune on runtime stream labels gains only +0.002 to +0.005 (width, protrusion, contact, purse, corner,
lower roll; `v2/gate_soupS.json`). It has two significant but tiny losses: jaw r −0.0002 on held-out speakers, and on
Pocket clones `man_*` heads part their lips at .20 on 0.17 points fewer speaking frames. The 50 % interpolation has three
such losses. The gain is too small to justify any risk, so **the candidate keeps the shipped stream net**: Pocket and
Convai output is byte-identical to today.

### 7. Hinge penalty (only shut-frame jaw above .05 raw): rejected

- For `woman_average`, the frozen lift plus its .21 floor writes jaw > .20 as soon as the raw jaw passes about .063. So a gentler fix only penalises shut-frame jaw above .05 raw (`--shut-hinge .05`), at weights 1 and 0.3 (`v2/gate_hinge.json`).
- **Weight 1:** jaw r −0.006 to −0.014, aperture r −0.005 to −0.008, contact recall −0.014 on Omni clones.
- **Weight 0.3:** jaw r −0.003 / −0.004 on held-out speakers and Pocket clones, both beyond seed noise. It also makes Pocket-clone over-opening worse (+0.5 points) while fixing the Omni-clone one.
- Both are worse than the plain candidate. Any pressure on the jaw near zero costs jaw tracking on this small net.

### 8. 85 % runtime labels, 15 % PocketSphinx labels (two seeds, averaged): closer, still not a pass

- `v2/gate_mix85.json`: the gains are about 90 % of the candidate's. Width +0.009 to +0.014, purse +0.012 to +0.016, F/V recall +0.007 to +0.026, rounding recall +0.015 to +0.018.
- The Omni-clone `woman_average` over-opening shrinks to +0.0016 (CI +0.0002 to +0.0030), but it is still a loss.
- A new one-in-10,000 loss appears: `man_*` over-opening at .35 on held-out speakers, +0.0001.
- Strict and non-inferior verdicts: FAIL.
- The over-opening scales with the share of runtime labels. It is a property of the label change itself, not of noise.

### 9. Keep the shipped jaw (jaw distillation): worse

- Same fine-tune, but the jaw target is the shipped phrase net's own jaw prediction on the same inputs, and the jaw quantile map is copied from the shipped net (`--jaw-teacher`, two seeds averaged, `v2/gate_jawkeep.json`).
- Lip gains are unchanged.
- But the jaw still drifts slightly: jaw r −0.0003, n.s. Over-opening losses appear on three sets: Pocket-clone woman .20 +0.0015, Omni-clone woman .35 +0.0007, held-out man .20 +0.0003.
- Contact recall becomes a loss on held-out speakers, −0.006.
- Rejected. The small net cannot copy the old jaw exactly while its shared hidden layers move.

### 10. What-if: new lips with the exact shipped jaw (two phrase nets at runtime)

- The gate's `name=<dir>|jaw=<dir2>` stack takes every track from the candidate except the jaw tracks, which come from the shipped stack (`v2/gate_jawsplit.json`). This is what a runtime evaluating both phrase nets would produce. It is not a drop-in: +1 stage-2 pass in phrase mode.
- Every jaw check is now exactly shipped (over-opening and lip-part shares ±0.000, jaw r ±0.000), and all lip gains remain.
- But contact recall becomes a loss on held-out speakers (−0.005, CI −0.0125 to −0.0005), with −0.005 on Omni clones (n.s.). The new contact curve was learnt together with the new jaw. Closure detection (< 1 mm aperture) needs both, so mixing them loses some closures.
- Not a pass either, and it would cost CPU.
- Conclusion of Experiments 3–10: the runtime-label gain comes with a small, coupled jaw/contact shift. No variant tried removes it without a larger loss elsewhere.

## Final candidate and gate

**Candidate folder:** `E:\CyberpunkConvai-offload\work\lipsync-lab\v2\candidate-rtlabels-20261014\` (same six files as
`runtime/lipsync-model/`).

- **Files:**
  - `face-model.*`, the lexicon and its notice are byte-identical to the live ones.
  - `face-text.json` is byte-identical.
  - `face-text.bin` differs only in the phrase-net tensors and phrase quantile maps (SHA-256 `0f176fc3…` vs live `4156e4f9…`).
- **Phrase net:** a uniform weight average of two 16-epoch fine-tunes of the shipped 96-epoch Omni net on runtime-decided phrase labels (seeds 1 and 2), with the quantile map refit.
- **Stream net:** shipped.

**Gate result (phrase mode, `v2/gate_seeds.json`, stack `rt_seeds`; audio and stream in `v2/gate_final_audio_stream.json`):**

| Phrase mode (Omni) | held-out speakers | Omni clones | Pocket clones |
| --- | --- | --- | --- |
| aperture r | +0.002* | +0.003* | +0.004* |
| aperture error | −0.012 mm* | −0.008 mm* | −0.016 mm* |
| width r | +0.011* | +0.012* | +0.016* |
| protrusion r | +0.011* | +0.011* | +0.014* |
| jaw / chin r | +0.001 / +0.001* | +0.001* / +0.002* | +0.001 / +0.002* |
| contact r | +0.008* | +0.009* | +0.004* |
| purse r | +0.015* | +0.015* | +0.019* |
| corner stretch r | +0.007* | +0.007* | +0.013* |
| lower roll r | +0.011* | +0.008* | +0.005* |
| contact recall / precision | −0.000 / +0.010* | −0.001 / +0.001 | −0.004 / +0.007 |
| F/V recall | +0.028* | +0.011* | +0.007* |
| rounding recall / precision | +0.018* / +0.008* | +0.021* / +0.008* | +0.015* / +0.006 |
| closures reaching full contact | +0.003 | +0.011 | +0.002 |
| closure peak | +0.004* | +0.003* | +0.005* |
| lip-part share, Judy .06 / woman .20 / man .20 | −0.000 / −0.000 / +0.002 | +0.001 / +0.001 / +0.002* | +0.000 / +0.000 / +0.002* |
| over-opening > .20, Judy / woman / man | −0.000 / +0.000 / +0.000 | +0.000 / **+0.002 (loss)** / +0.000 | −0.000 / +0.003 / +0.001 |
| jaw p99 | 0.485 (shipped 0.486) | 0.471 (0.472) | 0.491 (0.491) |

`*` = interval excludes 0; signs as measured (lower is better for error and over-opening).

- **Strict verdict: FAIL. Non-inferior verdict: FAIL.** The cause is a single check: Omni-clone `woman_average` over-opening at .20, +0.0021 (CI +0.0002 to +0.0034). That is inside the seed-noise margin (0.01) but wholly above 0, and both seeds show it.
  - Every other finding is a tie whose interval touches 0 by ≤ 0.004 (contact recall on clones −0.001 / −0.004), or a gain.
- **Audio and stream modes:** identical by construction (same stage 1, same stream net and maps). The final audio/stream gate run confirms zero difference.
- **Ranges:** no control exceeds the shipped maximum or the validated limits. Jaw max 0.70 / 0.674 / 0.70, contact max 1.0 on every set.
- **Closures:** they reach full contact at least as often as shipped (+0.002 to +0.011, n.s.), and the mean closure peak is higher.
- **Jaw lift:** lip-part shares after the frozen lift are equal or higher for Judy, `woman_average` and `man_*` (.12 / .16 / .20) on all sets. The jaw p99 is unchanged within 0.001.
- **Variety:**
  - Spread family p95 reach improves: stretch and lower raise 0.66 → 0.69 held-out, 0.93 → 0.99 Omni clones. Tongue forward peak 0.75 → 0.77.
  - Codebook agreement 0.418 → 0.426.
  - The other way: purse p95 reach falls (0.77 → 0.70 held-out, 1.05 → 0.96 Omni clones), and jaw p95 reach falls (0.85 → 0.82), while their peak attainment is within 0.01. So the new net places rounding more accurately but fires full purse less often.
- **JS parity:** max |JS − Python| 2.5e-6 in stream and phrase modes, packet-size difference 0 (`lab_textparity.mjs`).
- **CPU:** identical tensor shapes. Measured audio model 0.009 s per audio second, 0.012 s with text (+26 %, the same as shipped). No main-thread work is added: same files, same code path.
- **Screenshot check:** no new one is needed for the calibration. The jaw distribution and maxima are unchanged and no range is exceeded. If the user installs it, a single Omni line on a `woman_average` head (the one flagged check) would be the thing to eyeball.

**Recommendation:** under the gate as written, do not install. If the user accepts a +0.2-point over-opening on one
head type, and fewer full purses, in exchange for clearly better rounding, F/V, width and contact on Omni, the
candidate is ready as a drop-in (steps below).

### Install and rollback (for the user; not executed)

1. Close the game. Back up `runtime/lipsync-model/face-text.json` and `face-text.bin`, for example to `E:\CyberpunkConvai-offload\backups\lipsync-face-text-<date>`.
2. Copy only `face-text.bin` from the candidate folder over `runtime/lipsync-model/face-text.bin`. All other files are identical. Restart the bridge.
3. Rollback: copy the backed-up `face-text.bin` back. Live SHA-256 today: `4156e4f98a20…`.

## Ranked directions (expected gain vs cost)

1. **Make the jaw near zero safe while keeping the runtime-label gain.**
   - Cost: small, ≤ 15 min of compute per try.
   - Gain: turns today's near-pass into a pass, worth +0.01 to +0.03 on Omni shape metrics.
   - The loss sits in a tiny region: shut frames where the raw jaw is .06–.11, which the `woman_average` lift and floor turn into > .20.
   - Already tried and not enough:
     - penalties (Experiments 3 and 7);
     - weight interpolation (Experiment 4);
     - a 15 % label mix (Experiment 8, the loss shrinks to +0.0016);
     - jaw distillation (Experiment 9);
     - a two-net jaw split at runtime, which is not even a drop-in (Experiment 10: contact recall then loses).
   - What is left within a drop-in is a coin flip, a 25–30 % label mix: 13 minutes per try. It likely trades the last bit of over-opening for a third of the gain.
   - Expect diminishing returns. Experiments 3–10 say the shift is coupled to the gain.
2. **Stage 2 from scratch on runtime labels, 96 epochs, phrase and stream.**
   - Cost: about 35–45 min on the local 4080 for both nets, which needs approval. Or a private Kaggle kernel (~1 h with upload).
   - Gain: the 24-epoch screen matched the fine-tune's gains, so expect +0.002 to +0.005 more at best. The jaw side effect may or may not go away.
3. **Stage-1 retrain with a lip-distance / contact-weighted loss (Audio2Face-3D idea) plus runtime-like phone inputs.**
   - Targets the real variety gaps: F/V lower contact reaches p95 only 57 % as often, and the spread family 66–70 % peak.
   - Cost: a full stage-1 run (Candidate A took about 3 h GPU), plus the phone head, plus both stage-2 nets, plus a new 23-head screenshot check, because the audio fallback changes.
   - Best done on private Kaggle kernels: a 1.5 GB private dataset upload and about 4–5 h of GPU.
   - Risk: Experiment 1 showed amplitude losses trading correlation on this net size.
   - Expected gain: uncertain, possibly the largest on variety.
4. **Wider stage 2 (96 channels).** Rejected for the gate: +~15 % CPU on the text path.
5. **Emotion conditioning, VQ, diffusion.** Not worth it: no articulation gain in the literature, or far over the CPU budget.

## Proposed next step

A user decision first, because the drop-in route is close to exhausted:

- **(a) Accept the near-pass candidate.** Omni only: +0.2 points of over-opening on `woman_average` and fewer full purses, in exchange for +0.01 to +0.03 on rounding, F/V, width and contact. Cost: none; copy one file. The gate as written says no.
- **(b) Keep the shipped model and stop here.** The tooling (gate, runtime labels, parity fix) stays for later work.
- **(c) Direction 2** (stage 2 from scratch on runtime labels, ~45 min local GPU, needs approval). A fresh net might settle the jaw differently. Low odds, given Experiments 3–10.
- **(d) Direction 3 on private Kaggle kernels.** Needs approval for the 1.5 GB private dataset upload, about 4–5 h of GPU, and a screenshot session afterwards. The only route aimed at the amplitude ("variety") gaps rather than placement.

## Reproduce

All from `scripts/lipsync` with the lab Python. The `v2/run_*.ps1` scripts hold the exact argument lists.

```
python lab_runlabels.py --mode phrase --procs 8 --out <lab>/v2/rtlab_phrase      # runtime-decided labels
LAB_TRAIN_LABEL_DIR=<lab>/v2/rtlab_phrase LAB_TRAIN_LABEL_MIX=1 \
  python lab_stage2.py --stage1 models/e96_head.pt --init models/f_s2_omni64_e96.pt --lag -20 --jitter 0 \
  --epochs 16 --lr 5e-4 --seed {1,2} --out v2/ft_p_rt[_s2].pt
python lab_stage2.py ... --epochs 0 --init v2/ft_p_rt.pt --soup v2/ft_p_rt_s2.pt --soup-alpha .5 --out v2/ft_p_rt_seeds.pt
python lab_textswap.py runtime/lipsync-model/text-s48p96 v2/candidate --phrase v2/ft_p_rt_seeds.pt
python lab_gate.py --stack shipped=<live> --stack cand=v2/candidate --modes audio,stream,phrase \
  --sets test,clone-omni,clone-pocket --out v2/gate.json
python lab_textpipe.py fixture v2/candidate fx.json && node lab_textparity.mjs v2/candidate fx.json
```

## Literature (read-only scan; no downloads)

- **Over-smoothing is regression to the conditional mean.** The usual fixes need capacity or sampling the CPU budget cannot pay for:
  - CodeTalker (CVPR 2023): a VQ codebook of real motion;
  - DiffPoseTalk, FaceDiffuser, SAiD: diffusion over blendshapes;
  - NVIDIA Audio2Face-3D (arXiv 2508.16401, 2025): a 2-step diffusion network on top of the regression one.
  - On a tiny causal regressor, distribution-style losses trade correlation for amplitude. Experiment 1 confirms this.
- **Audio2Face-3D's regression network** uses:
  - MSE plus velocity terms (we have both);
  - a training-only phoneme head (we have one: Candidate A's aux head);
  - lip-distance and lip-size losses that emphasise small openings.
  - Its output is vertices solved to ARKit weights, so it is not directly reusable. Its licence is reportedly the NVIDIA Open Model License (unconfirmed).
  - The lip-distance idea maps to a contact/aperture-weighted loss in stage 1. It is a candidate for a future stage-1 run, with the same correlation risk.
- **JALI** (SIGGRAPH 2016) and **VisemeNet** (SIGGRAPH 2018): JALI separates jaw and lip action. VisemeNet predicts phoneme groups first, then the rig curves, keeping the phoneme loss in joint training.
  - Our text path is the same idea: phones condition the curves.
  - The new finding here is that the phone input must look like what inference produces. Training on clean forced-alignment labels left about +0.01 to +0.03 on the table.
- **Emotion/intensity conditioning** (EMOTE, EmoVOCA, DEEPTalk): no evidence that it improves articulation. It changes expression, which our separate expression layer already owns.
- **Metrics:** the FDD-style std ratio and LVE-style peak error were adapted into the gate's variety section.
- **Housekeeping:** the scan's WebFetch auto-saved the JALI PDF (2.7 MB) in the Claude session's tool-results folder outside the repo. It can be deleted.
