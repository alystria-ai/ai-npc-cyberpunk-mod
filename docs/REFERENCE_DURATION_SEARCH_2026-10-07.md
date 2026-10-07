# Reference length search, 2026-10-07

The measure is the total length of a voice reference in seconds, not the number of clips. For each of the 29 report characters, a search chose
whole clips (joined with 0.4 s gaps, no processing) for OmniVoice (short, up to 10 s; long, up to 18 s) and for the new Pocket student with
decoder v2 (any length up to the bridge's 30 s reference limit, explored to 40 s on probe voices). ECAPA speaker similarity is the primary
score, PLS secondary, no WER. A reference has at least two whole clips unless a voice has no feasible multi-clip set.

## Method

- **Pool and targets.** The combat-cleaned pool (`cb` flags), effect exclusions (`fx`), no media-processed clips. Per voice, real clips are held out: the ECAPA
  target for a generated line is the leave-one-out centroid of the other held-out clips, so no reference clip is part of its own target. Two held-out
  lines drive the search, four (OmniVoice) or six (Pocket) fresh lines judge the finalists. Adam Smasher uses only the 11 clips the user chose and scores
  on his two page lines (overfitting allowed).
- **Search.** Free prescreen (loudness, own ECAPA vs the centroid, wildcards), singles raced on one line then two, then greedy forward selection under a
  duration cap with a beam of two (the clip that adds the most ECAPA, and the most per second, are tried; candidates raced on one line, the best on
  the second). OmniVoice caps: 10 s and 18 s. Pocket cap: 27 s (40 s on 8 probe voices: Adam, Carol, Claire, Alex, Dexter, Judy, Johnny, Songbird), early stop
  after two steps past the best. Final: path prefixes (the ECAPA-vs-duration curve), beam states and clip-order variants on fresh lines with two seeds;
  per budget the best mean wins, but the shortest set within one paired standard error is chosen.
- **Scale.** OmniVoice 16 steps ran on Kaggle T4 notebooks (29 voices, about 4 to 7 min per voice, 32-step check of the winners). Pocket ran on 14 local CPU voices
  and 15 Kaggle CPU voices. Scores are identical in definition (same ECAPA model, targets and lines); a Kaggle smoke test matched the local ECAPA (0.7327 vs 0.7327 for Pocket;
  OmniVoice means within 0.01). The direct OmniVoice renderer used on Kaggle is bit-identical to the VoiceStudio backend call (same ECAPA, waveform correlation 1.0).
- **Latency.** Added first-audio latency of an OmniVoice reference is about 42 ms per second at 16 steps and about 95 ms per second at 32 steps (local GPU measurement; a T4
  renders about 0.25 s per audio second). Pocket has no per-turn cost for a longer reference.

## Results

## OmniVoice 16 steps (32-step check in brackets)

| Voice | Short s | ECAPA | +latency 16/32 | Long s | ECAPA | +latency 16/32 | Best | Today s / ECAPA |
|---|---|---|---|---|---|---|---|---|
| adam-smasher | 7.9 | 0.762 (0.730) | +0.33/+0.75 s | 17.1 | 0.798 (0.807) | +0.72/+1.62 s | long | 5.6 / 0.726 |
| alex | 8.0 | 0.719 (0.722) | +0.34/+0.76 s | 11.6 | 0.797 (0.764) | +0.49/+1.10 s | long | 6.0 / 0.702 |
| carol-emeka | 9.4 | 0.697 (0.698) | +0.40/+0.90 s | 9.4 | 0.697 (0.698) | +0.40/+0.90 s | short | 7.0 / 0.674 |
| claire-russell | 8.7 | 0.776 (0.786) | +0.37/+0.83 s | 13.2 | 0.799 (0.785) | +0.56/+1.25 s | long | 4.1 / 0.657 |
| dexter-deshawn | 9.9 | 0.817 (0.818) | +0.42/+0.94 s | 9.9 | 0.817 (0.818) | +0.42/+0.94 s | short | 6.6 / 0.750 |
| elizabeth-peralez | 9.4 | 0.674 (0.688) | +0.39/+0.89 s | 10.8 | 0.716 (0.733) | +0.45/+1.02 s | short | 4.8 / 0.557 |
| evelyn-parker | 9.3 | 0.715 (0.685) | +0.39/+0.88 s | 9.3 | 0.715 (0.685) | +0.39/+0.88 s | short | 6.5 / 0.610 |
| hanako-arasaka | 9.4 | 0.776 (0.775) | +0.40/+0.90 s | 9.4 | 0.776 (0.775) | +0.40/+0.90 s | short | 4.8 / 0.671 |
| jackie-welles | 9.1 | 0.725 (0.727) | +0.38/+0.86 s | 9.1 | 0.725 (0.727) | +0.38/+0.86 s | short | 6.5 / 0.614 |
| johnny-silverhand | 9.2 | 0.658 (0.657) | +0.38/+0.87 s | 9.2 | 0.658 (0.657) | +0.38/+0.87 s | short | 8.3 / 0.634 |
| judy-alvarez | 7.8 | 0.610 (0.643) | +0.33/+0.74 s | 13.4 | 0.632 (0.660) | +0.56/+1.27 s | long | 8.1 / 0.602 |
| panam-palmer | 5.8 | 0.638 (0.644) | +0.24/+0.55 s | 11.8 | 0.652 (0.662) | +0.50/+1.12 s | short | 8.9 / 0.518 |
| kerry-eurodyne | 6.9 | 0.617 (0.639) | +0.29/+0.66 s | 15.7 | 0.652 (0.633) | +0.66/+1.49 s | long | 5.9 / 0.552 |
| lina-malina | 6.9 | 0.694 (0.710) | +0.29/+0.66 s | 11.8 | 0.723 (0.730) | +0.49/+1.12 s | long | 6.0 / 0.663 |
| lizzy-wizzy | 8.9 | 0.650 (0.627) | +0.37/+0.84 s | 12.6 | 0.679 (0.660) | +0.53/+1.20 s | long | 6.1 / 0.586 |
| mama-welles | 6.7 | 0.703 (0.656) | +0.28/+0.64 s | 17.2 | 0.764 (0.761) | +0.72/+1.63 s | long | 4.5 / 0.604 |
| meredith-stout | 9.1 | 0.644 (0.656) | +0.38/+0.87 s | 9.1 | 0.644 (0.656) | +0.38/+0.87 s | short | 6.1 / 0.586 |
| mitch-anderson | 9.4 | 0.716 (0.705) | +0.40/+0.90 s | 15.8 | 0.753 (0.703) | +0.66/+1.50 s | long | 6.9 / 0.562 |
| mr-hands | 6.2 | 0.727 (0.745) | +0.26/+0.59 s | 15.3 | 0.761 (0.754) | +0.64/+1.45 s | long | 4.2 / 0.636 |
| ozob-bozo | 8.0 | 0.749 (0.748) | +0.34/+0.76 s | 8.0 | 0.749 (0.748) | +0.34/+0.76 s | short | 6.5 / 0.545 |
| padre-ibarra | 6.9 | 0.680 (0.665) | +0.29/+0.66 s | 13.1 | 0.712 (0.731) | +0.55/+1.25 s | long | 6.1 / 0.592 |
| pepe-najarro | 9.3 | 0.701 (0.727) | +0.39/+0.88 s | 9.3 | 0.701 (0.727) | +0.39/+0.88 s | short | 4.9 / 0.629 |
| placide | 9.7 | 0.754 (0.738) | +0.41/+0.92 s | 14.9 | 0.769 (0.753) | +0.62/+1.41 s | long | 5.1 / 0.630 |
| river-ward | 8.6 | 0.690 (0.703) | +0.36/+0.81 s | 17.7 | 0.734 (0.710) | +0.74/+1.68 s | long | 4.2 / 0.590 |
| rogue-amendiares | 9.7 | 0.736 (0.761) | +0.41/+0.92 s | 17.2 | 0.766 (0.776) | +0.72/+1.63 s | long | 5.8 / 0.691 |
| solomon-reed | 9.4 | 0.801 (0.788) | +0.39/+0.89 s | 10.7 | 0.837 (0.806) | +0.45/+1.02 s | long | 5.5 / 0.645 |
| songbird | 9.4 | 0.630 (0.636) | +0.40/+0.90 s | 12.7 | 0.664 (0.657) | +0.53/+1.21 s | long | 5.3 / 0.546 |
| takemura | 6.0 | 0.714 (0.715) | +0.25/+0.57 s | 16.5 | 0.762 (0.749) | +0.69/+1.57 s | long | 8.3 / 0.657 |
| viktor-vektor | 8.7 | 0.773 (0.772) | +0.36/+0.82 s | 14.2 | 0.766 (0.755) | +0.60/+1.35 s | short | 6.5 / 0.591 |

## Pocket (new student + decoder v2)

| Voice | Best s | ECAPA ±SE | Today s / ECAPA | Beyond 30 s (research) |
|---|---|---|---|---|
| adam-smasher | 10.6 | 0.682 ±0.043 | 5.6 / 0.520 |  |
| alex | 16.6 | 0.682 ±0.022 | 6.0 / 0.558 |  |
| carol-emeka | 19.7 | 0.582 ±0.034 | 7.0 / 0.474 |  |
| claire-russell | 10.7 | 0.575 ±0.046 | 4.1 / 0.487 | 34.9 s 0.593 |
| dexter-deshawn | 13.1 | 0.744 ±0.022 | 6.6 / 0.613 |  |
| elizabeth-peralez | 13.7 | 0.667 ±0.028 | 4.8 / 0.468 |  |
| evelyn-parker | 10.7 | 0.469 ±0.029 | 6.5 / 0.371 |  |
| hanako-arasaka | 16.9 | 0.665 ±0.019 | 4.8 / 0.506 |  |
| jackie-welles | 7.4 | 0.599 ±0.027 | 6.5 / 0.601 |  |
| johnny-silverhand | 19.6 | 0.588 ±0.020 | 22.3 / 0.503 |  |
| judy-alvarez | 12.7 | 0.629 ±0.021 | 8.1 / 0.540 | 31.0 s 0.661 |
| panam-palmer | 14.2 | 0.567 ±0.036 | 8.9 / 0.398 |  |
| kerry-eurodyne | 11.9 | 0.620 ±0.019 | 5.9 / 0.374 |  |
| lina-malina | 16.4 | 0.642 ±0.019 | 6.0 / 0.558 |  |
| lizzy-wizzy | 8.4 | 0.550 ±0.029 | 6.1 / 0.457 |  |
| mama-welles | 13.9 | 0.668 ±0.025 | 4.5 / 0.540 |  |
| meredith-stout | 15.8 | 0.568 ±0.010 | 6.1 / 0.484 |  |
| mitch-anderson | 17.3 | 0.584 ±0.020 | 6.9 / 0.317 |  |
| mr-hands | 22.1 | 0.743 ±0.018 | 4.2 / 0.584 |  |
| ozob-bozo | 18.0 | 0.671 ±0.025 | 6.5 / 0.411 |  |
| padre-ibarra | 26.1 | 0.671 ±0.020 | 6.1 / 0.535 |  |
| pepe-najarro | 12.0 | 0.580 ±0.037 | 4.9 / 0.470 |  |
| placide | 13.3 | 0.673 ±0.010 | 5.1 / 0.589 |  |
| river-ward | 14.5 | 0.617 ±0.017 | 4.2 / 0.515 |  |
| rogue-amendiares | 17.9 | 0.681 ±0.029 | 5.8 / 0.527 |  |
| solomon-reed | 14.8 | 0.770 ±0.017 | 5.5 / 0.608 |  |
| songbird | 12.7 | 0.634 ±0.029 | 5.3 / 0.482 |  |
| takemura | 14.0 | 0.702 ±0.018 | 8.3 / 0.625 |  |
| viktor-vektor | 25.0 | 0.701 ±0.016 | 6.5 / 0.572 |  |

## Aggregate ECAPA vs reference duration: omni

| Seconds | Voices reaching it | Mean ECAPA | Change vs 10 s, same voices (±SE) |
|---|---|---|---|
| 2 | 0 |  |  |
| 4 | 4 | 0.6754 | -0.0139 ±0.0116 |
| 6 | 12 | 0.6934 | -0.0085 ±0.0038 |
| 8 | 24 | 0.6768 | -0.0031 ±0.0019 |
| 10 | 29 | 0.6777 | +0.0000 ±0.0000 |
| 12 | 29 | 0.6925 | +0.0148 ±0.0050 |
| 14 | 27 | 0.705 | +0.0317 ±0.0061 |
| 16 | 20 | 0.7119 | +0.0358 ±0.0083 |
| 18 | 0 |  |  |

## Aggregate ECAPA vs reference duration: pocket

| Seconds | Voices reaching it | Mean ECAPA | Change vs 18 s, same voices (±SE) |
|---|---|---|---|
| 3 | 3 | 0.5392 | -0.0589 ±0.0243 |
| 6 | 14 | 0.5658 | -0.0453 ±0.0084 |
| 9 | 29 | 0.5808 | -0.0381 ±0.0056 |
| 12 | 29 | 0.6011 | -0.0180 ±0.0055 |
| 15 | 28 | 0.6116 | -0.0072 ±0.0038 |
| 18 | 26 | 0.627 | +0.0000 ±0.0000 |
| 21 | 26 | 0.6284 | +0.0014 ±0.0041 |
| 24 | 22 | 0.6357 | -0.0024 ±0.0048 |
| 27 | 8 | 0.616 | -0.0133 ±0.0075 |
| 30 | 8 | 0.6124 | -0.0169 ±0.0066 |
| 35 | 8 | 0.6065 | -0.0229 ±0.0162 |
| 40 | 0 |  |  |


### Report page (Voice report v3, served at `/`)

ECAPA is cosine to the centroid of each character's held-out real clips, macro over the 29 characters. PLS uses the October 5 study's fixed scale (stock Pocket one clip = 60,
OmniVoice 32 one clip = 90); the new student follows each original line's delivery closely, which PLS rewards.

| Column | ECAPA | PLS |
|---|---|---|
| Original lines | 0.698 | - |
| Pocket base (stock), best-length reference | 0.521 | 70.5 |
| New student + decoder v2, best-length reference | 0.630 | 100.7 |
| OmniVoice 16, short (up to 10 s) | 0.699 | 86.9 |
| OmniVoice 16, long (up to 18 s) | 0.720 | 90.9 |
| OmniVoice 32, short | 0.715 | 90.7 |
| OmniVoice 32, long | 0.730 | 95.0 |

## Findings

- **OmniVoice.** Median short reference 8.9 s, median long 12.6 s; 9 voices end with the same set for both (the long search found nothing longer within noise). Gain over today's single reference on the held-out lines: short +0.087, long +0.110 ECAPA on average.
  The curve has not flattened by 16 s (change vs 10 s on the same voices: +0.015 at 12 s, +0.032 at 14 s, +0.036 at 16 s), so the long set is usually worth its latency (about +0.5 s at 16 steps for a 12 s reference). 32 steps changed ECAPA by -0.005 on the long sets (no gain).
- **Pocket (new student + decoder v2).** The per-voice best length has a median of 14.2 s (range 7.4 to 26.1 s); gain over today's single reference +0.132.
  The aggregate curve (same voices, change relative to 18 s) rises to about 15 s (-0.038 at 9 s, -0.018 at 12 s, -0.007 at 15 s), is flat from 18 to 24 s (+0.001, -0.002; within noise) and falls beyond that:
  -0.013 at 27 s, -0.017 at 30 s, -0.023 at 35 s (8 probe voices). So going past 18 s does not help and past about 27 s hurts. Voices whose best is over 18 s: padre-ibarra 26.1 s, viktor-vektor 25.0 s, mr-hands 22.1 s, carol-emeka 19.7 s, johnny-silverhand 19.6 s, ozob-bozo 18.0 s; for most of them that is within noise of a shorter set.
- **Retrain on longer references?** Not clearly worth a dedicated run. The student's curve flattens at its training length (18 s) and declines past about 27 s, so longer references are unused capacity, but the head room is small: OmniVoice, which does use long references, gains roughly 0.005 ECAPA per second between 10 and 16 s (before it flattens), and a Pocket student that matched that between 18 and 30 s would gain on the order of +0.01 to +0.02, comparable to the noise of a per-voice comparison and capped by the bridge's 30 s limit. Recommendation: do not start a retrain for this alone. If a student run happens anyway (for example on the no-combat corpus), sample references up to 30 s in its prompt mix and re-run this search with `--export <new export>` to see whether the 18 to 30 s part of the curve lifts.

## Files

- Per-voice results: `E:/CyberpunkConvai-offload/work/clip-search/runs3/<tag>/<voice>/result.json` (tags `omni16`, `omni32` verify only, `pocket-student-v2-s2000-ema-decv2`); caches `scores-<split key>.json`; plans in `plans/` and `plans-omni/`.
- Picker data: `runtime/autobest-sets.json` (schema v2); proposed configs `runtime/pocket-voices.autobest.json`, `runtime/local-voices.autobest.json`, `.autobest-short.json`, `.autobest-long.json` (never live).
- Report: `E:/CyberpunkConvai-offload/work/voice-report-v3/index.html`, served at `/` by the reference picker.
- Code: `scripts/clip-search/` (`search.py`, `collect.py`, `build_page.py`, `make_portable.py`, `render.py`, `score.py`, `common.py`); `scripts/Build-AutobestConfigs.mjs`.
- Re-run: `python scripts/clip-search/search.py --engine pocket --export <dir>` (or `--engine omni`), then `collect.py`, `node scripts/Build-AutobestConfigs.mjs`, `build_page.py render` and `build`. Remote runs: `make_portable.py`.

## Caveats

- The new student was trained on most clips of the pool (only the research panel lines and a few dev lines were excluded), so absolute Pocket ECAPA runs high; the ranking of sets is what matters.
- Viktor's local Pocket run chose 25.0 s (ECAPA 0.701); a Kaggle repeat chose 15.0 s (0.707): a tie, as many comparisons are. Per-voice Pocket lengths are noisy; the aggregate curve is the reliable part.
- Selection is by the held-out centroid, not by ear; the user's listening decides. The live configs are not changed.

## Jackie Welles with hand-set constraints (2026-10-07, local run)

**User verdict (2026-10-07): the overnight best-length set was fine; the constrained variant is dropped from the report and is not to be mentioned in the devslot handoff.** The record below is kept for reference only.

The user asked for a re-search of Jackie's references where every candidate clip must have a loudness of at most +2 dB on the picker's relative scale, be longer than 6 s on its own, and contain few sentence breaks. The rule used: transcript stops (runs of `.`, `!`, `?` or an ellipsis that end a word, a run counted once) at most 2 per clip (a hard cap; clips with 3 or more stops are dropped). Existing filters still apply (combat-cleaned, effect exclusions, at least two clips, same held-out centroid and lines as the overnight run). The rule leaves 65 of Jackie's 833 candidate clips (750 are at most +2 dB; 127 of those are longer than 6 s; 65 of those have at most 2 stops). Code: `search.py --constraint jackie-constrained --compare-with <overnight run>`; results in `E:/CyberpunkConvai-offload/work/clip-search/runs-constrained/`.

**A short OmniVoice set (up to 10 s, at least two clips) is impossible under this rule:** two clips longer than 6 s need at least 12.4 s with the gap. It was not relaxed; the report row says "not possible under the rule". At most two such clips also fit the 18 s long set.

Fresh-line ECAPA (cosine to the held-out centroid, mean over the same fresh lines and seeds, ± standard error over lines), constrained set against the overnight set re-rendered in the same run (a paired comparison) and against today's single clip:

| Engine | Constrained set | Overnight set (same run) | Today's clip | Constrained minus overnight | Constrained minus today |
|---|---|---|---|---|---|
| OmniVoice 16, long | 12.6 s clips, 2 clips: 0.699 ± 0.013 | 8.7 s: 0.707 ± 0.013 (0.725 ± 0.021 in the overnight run itself) | 0.627 ± 0.030 | -0.007 ± 0.015 (t = -0.5): a tie | +0.073 ± 0.018 (t = 4.1) |
| OmniVoice 32 (check) | 0.704 ± 0.019 | 0.727 ± 0.013 | 0.616 to 0.638 | not significant | |
| Pocket new student + decoder v2 | 23.2 s clips, 3 clips: 0.642 ± 0.026 | 7.0 s, 2 clips: 0.599 ± 0.027 | 0.601 ± 0.025 | +0.043 ± 0.017 (t = 2.5 on 6 lines, just short of the 5% level) | +0.041 ± 0.008 (t = 5.1) |

(OmniVoice sampling varies by about 0.02 between runs of the same set, so only the paired same-run comparison counts.) The chosen sets have fewer stops per second of clip (0.32 vs 0.46 per second for OmniVoice, 0.26 vs 0.43 for Pocket).

**Conclusion.** For OmniVoice the constraints did not help: the constrained long set ties the overnight set, and costs about +0.2 s more reference latency at 16 steps (13 s of reference against 9 s). For Pocket they probably help (+0.043 ECAPA, a borderline result on six lines, from a 23 s three-clip reference, which is inside the range where the Pocket curve is flat), so the row is worth a listen. The report keeps the overnight row and adds a labelled variant row for A/B listening ("Jackie Welles (constrained: <= +2 dB, clips > 6 s, few stops)"); header averages are unchanged.

**Proposal for other voices.** Do not apply this rule to OmniVoice voices on the strength of this one result. For Pocket, a looser form is worth testing on a few voices with long pools (loudness at most +2 dB and at most 2 stops per clip, no 6 s minimum, since the minimum made short sets impossible), and the user's ear on the Jackie variant row decides whether to proceed. If the user prefers the constrained Jackie by ear, mention the rule in the devslot handoff as "prefer clips at or below the voice's median loudness (+2 dB), long, and with few sentence breaks".
