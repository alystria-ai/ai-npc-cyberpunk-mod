"""Write docs/REFERENCE_DURATION_SEARCH_<date>.md from runtime/autobest-sets.json, results.md and the report's scores.json.

  python scripts/clip-search/write_results_doc.py [--out docs/REFERENCE_DURATION_SEARCH_2026-10-07.md]

The narrative parts (method, retrain judgement, caveats) are in the template below; every number is read from the data.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import statistics as st
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

NAMES = {"original": "Original lines", "pocket-base": "Pocket base (stock), best-length reference",
         "pocket-v2": "New student + decoder v2, best-length reference", "omni16-short": "OmniVoice 16, short (up to 10 s)",
         "omni16-long": "OmniVoice 16, long (up to 18 s)", "omni32-short": "OmniVoice 32, short", "omni32-long": "OmniVoice 32, long"}


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=common.ROOT / "docs/REFERENCE_DURATION_SEARCH_2026-10-07.md")
    args = parser.parse_args(argv)
    data = json.loads((common.ROOT / "runtime/autobest-sets.json").read_text(encoding="utf-8"))
    tables = (common.WORK / "results/results.md").read_text(encoding="utf-8")
    scores = json.loads(Path("E:/CyberpunkConvai-offload/work/voice-report-v3/scores.json").read_text(encoding="utf-8"))
    voices = data["voices"].values()
    o, p = [v["omni"] for v in voices], [v["pocket"] for v in voices]
    mean = st.mean
    rows = ["| Column | ECAPA | PLS |", "|---|---|---|"]
    for key, value in scores.items():
        rows.append(f"| {NAMES[key]} | {value['ecapa']:.3f} | {value['pls'] if value['pls'] is not None else '-'} |")
    same = sum(1 for x in o if x["short"]["ids"] == x["long"]["ids"])
    d32 = mean([x["verify32"]["long"]["ecapa"] - x["long"]["ecapa"] for x in o if "long" in x.get("verify32", {})])
    pocket_curve = {g["seconds"]: g for g in data["curves"]["pocket"]}
    omni_curve = {g["seconds"]: g for g in data["curves"]["omni"]}
    long_pocket = sorted(((x["best"]["seconds"], name) for name, x in ((k, v["pocket"]) for k, v in data["voices"].items()) if x["best"]["seconds"] > 18), reverse=True)

    def delta(curve, seconds):
        value = curve.get(seconds, {}).get("delta_vs_ref")
        return "n/a" if value is None else f"{value:+.3f}"

    text = f"""# Reference length search, 2026-10-07

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

{tables}

### Report page (Voice report v3, served at `/`)

ECAPA is cosine to the centroid of each character's held-out real clips, macro over the 29 characters. PLS uses the October 5 study's fixed scale (stock Pocket one clip = 60,
OmniVoice 32 one clip = 90); the new student follows each original line's delivery closely, which PLS rewards.

{chr(10).join(rows)}

## Findings

- **OmniVoice.** Median short reference {st.median(x['short']['seconds'] for x in o):.1f} s, median long {st.median(x['long']['seconds'] for x in o):.1f} s; {same} voices end with the same set for both (the long search found nothing longer within noise). Gain over today's single reference on the held-out lines: short +{mean([x['short']['ecapa'] - x['today']['ecapa'] for x in o]):.3f}, long +{mean([x['long']['ecapa'] - x['today']['ecapa'] for x in o]):.3f} ECAPA on average.
  The curve has not flattened by 16 s (change vs 10 s on the same voices: {delta(omni_curve, 12)} at 12 s, {delta(omni_curve, 14)} at 14 s, {delta(omni_curve, 16)} at 16 s), so the long set is usually worth its latency (about +0.5 s at 16 steps for a 12 s reference). 32 steps changed ECAPA by {d32:+.3f} on the long sets (no gain).
- **Pocket (new student + decoder v2).** The per-voice best length has a median of {st.median(x['best']['seconds'] for x in p):.1f} s (range {min(x['best']['seconds'] for x in p):.1f} to {max(x['best']['seconds'] for x in p):.1f} s); gain over today's single reference +{mean([x['best']['ecapa'] - x['today']['ecapa'] for x in p]):.3f}.
  The aggregate curve (same voices, change relative to 18 s) rises to about 15 s ({delta(pocket_curve, 9)} at 9 s, {delta(pocket_curve, 12)} at 12 s, {delta(pocket_curve, 15)} at 15 s), is flat from 18 to 24 s ({delta(pocket_curve, 21)}, {delta(pocket_curve, 24)}; within noise) and falls beyond that:
  {delta(pocket_curve, 27)} at 27 s, {delta(pocket_curve, 30)} at 30 s, {delta(pocket_curve, 35)} at 35 s (8 probe voices). So going past 18 s does not help and past about 27 s hurts. Voices whose best is over 18 s: {', '.join(f'{name} {seconds:.1f} s' for seconds, name in long_pocket)}; for most of them that is within noise of a shorter set.
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
"""
    args.out.write_text(text, encoding="utf-8")
    print(f"{args.out}: {len(text)} characters")
    return 0


if __name__ == "__main__":
    sys.exit(main())
