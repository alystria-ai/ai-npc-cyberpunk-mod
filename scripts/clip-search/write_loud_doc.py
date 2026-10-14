"""Write docs/CLIP_SEARCH_43_2026-10-14.md from E:/.../clip-search/loud43/report.json (made by collect_loud.py).  No audio, CPU only."""
from __future__ import annotations

import json
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

REPORT = common.WORK / "loud43" / "report.json"
DOC = Path(__file__).resolve().parents[2] / "docs" / "CLIP_SEARCH_43_2026-10-14.md"
TITLES = {"omni-short": "OmniVoice short (up to 10 s)", "omni-long": "OmniVoice long (up to 18 s)", "pocket": "Pocket (new student + decoder v2, up to 27 s)"}


def short_ids(ids):
    return ", ".join(i.split("/")[-1] for i in ids)


def f(value, spec=".1f", dash="-"):
    return dash if value is None else format(value, spec)


def mean(values):
    values = [v for v in values if v is not None]
    return statistics.mean(values) if values else None


def main() -> int:
    data = json.loads(REPORT.read_text(encoding="utf-8"))
    band = data["band"]
    lines = []
    out = lines.append
    out("# Clip search for the remaining 43 voices, loudness-aware (2026-10-14)")
    out("")
    out("Prepared on branch `clip-search-43`. **Nothing here is applied**: no live asset, no config under `runtime/`, none of the 29 report voices and neither hand-extracted set "
        "(`8ug8ear`, `jake-estevez`) was touched. Nobody has listened to these references yet.")
    out("")
    out("## What was run")
    out("")
    out("The 2026-10-07 search had already covered these 43 voices (Kaggle, likeness only; `docs/REFERENCE_DURATION_SEARCH_2026-10-07.md`, "
        "the TODO line saying the status was unclear was stale). They were searched again with the same method and a loudness band added to the selection score. "
        "Same held-out split per voice (the cache keys match the earlier runs for all 86 voice-engine pairs), same combat-cleaned pool and effect exclusions, "
        "same duration caps (OmniVoice 10 s and 18 s, 16 steps; Pocket up to 27 s, early stop), same ECAPA likeness scoring on the same fresh lines, "
        "same rule of at least two whole clips and the shortest set within one standard error. Scores of sets rendered earlier were reused for the singles race and the growth; the final comparison "
        "re-rendered every finalist and the earlier likeness-only picks together, so old and new are compared on identical lines and seeds in one run.")
    out("")
    out("**Loudness bonus** (`scripts/clip-search/loudband.py`; added to the ECAPA of a set in every selection comparison). Measured on the reference exactly as it is built "
        "(whole clips, 0.4 s gaps, 24 kHz mono, no gain), integrated LUFS (BS.1770-4, helper from the V voice work):")
    out("")
    out(f"- {band['low']:g} to {band['high']:g} LUFS: full bonus (+{band['bonus']:g} ECAPA). Between {band['high']:g} and {band['hot_above']:g} LUFS the bonus stays the same (no extra for louder).")
    out(f"- Quieter than {band['low']:g}: minus {band['quiet_slope']:g} per dB. Hotter than {band['hot_above']:g}: minus {band['hot_slope']:g} per dB.")
    out(f"- True peak above {band['peak_ceiling']:g} dBFS: minus 0.010 per dB. Peak-to-loudness ratio under 11 dB (squashed or shouted sound): minus 0.004 per dB.")
    out("- A clip with clipped samples, silence or a noise floor above -48 dBFS is never a candidate; the existing combat, shouted-delivery, effect and media exclusions still apply.")
    out("- Inside the band the bonus is flat, so the better likeness wins there. The bonus is a nudge of about two paired standard errors from the pool's usual level to the band, not an override.")
    out("")
    out("## The finding that matters most: the game pool is level-matched")
    out("")
    out("The pool's lines are mixed at about -23.6 LUFS (the median of every one of the 43 voices lies between -23.4 and -25.1 LUFS; 10th to 90th percentile spans only 1 to 2 dB for most voices). "
        "Only a small share of clips sits in the -22 to -16 band, and those are the louder (often more emphatic) lines. So selection alone can move a set about 1 to 3 dB at most; "
        "to put a set at -20 LUFS it needs a linear gain (the `gain_to_-20` column; the 29 voices' live references and today's single references are around -20 LUFS, "
        "so the new sets are quieter than what is live unless a gain is applied). The method deliberately applies no gain, and none was applied here.")
    out("")
    voices = data["voices"]
    for folder, title in TITLES.items():
        rows = [(v, r[folder]) for v, r in voices.items() if folder in r]
        if not rows:
            continue
        old_lufs = [e["old"]["lufs"] for _, e in rows if e.get("old") and e["old"].get("lufs") is not None]
        new_lufs = [e["lufs"] for _, e in rows if e.get("lufs") is not None]
        in_band_new = sum(1 for _, e in rows if e.get("lufs") is not None and band["low"] <= e["lufs"] <= band["hot_above"])
        in_band_old = sum(1 for _, e in rows if e.get("old") and e["old"].get("lufs") is not None and band["low"] <= e["old"]["lufs"] <= band["hot_above"])
        changed = [v for v, e in rows if e["changed"]]
        out(f"## {title}")
        out("")
        out(f"{len(rows)} voices. Mean loudness: likeness-only pick {f(mean(old_lufs), '.2f')} LUFS, loudness-aware pick {f(mean(new_lufs), '.2f')} LUFS "
            f"(gain {f(mean(new_lufs) - mean(old_lufs) if old_lufs and new_lufs else None, '+.2f')} dB). In the band ({band['low']:g} to {band['hot_above']:g}): "
            f"{in_band_old} before, {in_band_new} now. Different clip set from the likeness-only pick: {len(changed)} voices. "
            f"Mean ECAPA (same final lines): likeness-only {f(mean([e['old']['ecapa'] for _, e in rows if e.get('old')]), '.3f')}, "
            f"loudness-aware {f(mean([e['ecapa'] for _, e in rows]), '.3f')}.")
        out("")
        out("| Voice | Clips (StringID, in order) | s | ECAPA ±SE | LUFS | True peak | Gain to -20 LUFS | Likeness-only pick (same final): s, ECAPA, LUFS |")
        out("|---|---|---:|---|---:|---:|---|---|")
        for voice, e in rows:
            gain = e.get("gain_to_-20") or {}
            gain_text = "-" if not gain else f"{gain['gain_db']:+.1f} dB" + (" (peak-limited)" if gain.get("peak_limited") else "")
            old = e.get("old")
            if not old:
                old_text = "-"
            elif not e["changed"]:
                old_text = "same set" + (", other order" if e.get("order_only") else "") + f" ({f(old['ecapa'], '.3f')})"
            else:
                old_text = f"**differs**: {short_ids(old['ids'])}; {old['seconds']:.1f} s, {f(old['ecapa'], '.3f')}, {f(old.get('lufs'))}"
            se = f" ±{e['ecapa_se']:.3f}" if e.get("ecapa_se") is not None else ""
            out(f"| {voice} | {short_ids(e['ids'])} | {e['seconds']:.1f} | {e['ecapa']:.3f}{se} | {f(e.get('lufs'))} | {f(e.get('tp'))} | {gain_text} | {old_text} |")
        out("")
    if data.get("skipped"):
        out("## Skipped")
        out("")
        for voice, reason in data["skipped"].items():
            out(f"- {voice}: {reason}")
        out("")
    out("## Files")
    out("")
    out("- Prepared sets (clip ids only, schema 2, the format `scripts/Build-AutobestConfigs.mjs --sets` reads): `scripts/clip-search/loud43/autobest-sets.loud43.json`.")
    out("- Built references (the clip-search recipe, mono 24 kHz, 16-bit, no gain): `E:/CyberpunkConvai-offload/work/clip-search/loud43/refs/<omni-short|omni-long|pocket>/<voice>.wav`, hashes in `refs/hashes.json`.")
    out("- Raw results: `E:/CyberpunkConvai-offload/work/clip-search/runs3/omni16-loud/` and `.../pocket-student-v2-s2000-ema-decv2-loud/` (the earlier likeness-only runs are untouched beside them); every number above: `loud43/report.json`.")
    out("- Code: `scripts/clip-search/loudband.py` (measures and bonus), `search.py --loud` (selection), `collect_loud.py`, `write_loud_doc.py`, `loud_survey.py`.")
    out("- To apply (not done): back up the three autobest configs, then `node scripts/Build-AutobestConfigs.mjs --sets scripts/clip-search/loud43/autobest-sets.loud43.json --only <voices>`, and upload the references. Use `--only` so the 29 report voices and the hand-extracted sets are not rebuilt.")
    DOC.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("wrote", DOC)
    return 0


if __name__ == "__main__":
    sys.exit(main())
