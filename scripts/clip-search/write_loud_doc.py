"""Write docs/CLIP_SEARCH_43_2026-10-14.md from collect_loud.py's report.json and apply_loud43.py's apply-report.json (no audio, CPU only)."""
from __future__ import annotations

import json
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

DOC = Path(__file__).resolve().parents[2] / "docs" / "CLIP_SEARCH_43_2026-10-14.md"


def short_ids(ids):
    return ", ".join(i.split("/", 1)[1] for i in ids)


def f(value, spec=".1f", dash="-"):
    return dash if value is None else format(value, spec)


def mean(values):
    values = [v for v in values if v is not None]
    return statistics.mean(values) if values else None


def main() -> int:
    rep = json.loads((common.WORK / "loud43" / "report.json").read_text(encoding="utf-8"))
    app = json.loads((common.WORK / "loud43" / "apply-report.json").read_text(encoding="utf-8"))
    band = rep["band"]
    voices = list(app["voices"])
    out = []
    w = out.append
    w("# Clip search for the remaining 43 voices, loudness-aware (2026-10-14)")
    w("")
    w("**Status: applied to the runtime assets, not heard by anyone yet.** The OmniVoice references of the 43 voices (short, long and best) are the new loudness-aware picks, "
      "Pocket keeps its current picks, and all four reference sets are gain-matched towards -20 LUFS (ceiling -1 dBTP, a quiet set is never made quieter). The 29 report voices, `8ug8ear` and `jake-estevez` were not touched. "
      "The reference WAVs and the four autobest configs live under `runtime/` (not in git); the originals are in `runtime/backups/clip-search-43-20261014/`. "
      "The bridge reads the configs at start, so it needs a restart to pick them up.")
    w("")
    w("## What was run")
    w("")
    w("The 2026-10-07 search had already covered these 43 voices (Kaggle, likeness only; `docs/REFERENCE_DURATION_SEARCH_2026-10-07.md`), so the TODO line calling the status unclear was stale. "
      "They were searched again with the same method plus a loudness band in the selection score: same held-out split per voice (the cache keys match the earlier runs for all 86 voice-engine pairs), "
      "same combat-cleaned pool and effect exclusions, same duration caps (OmniVoice 10 s and 18 s at 16 steps), same ECAPA likeness on the same fresh lines, at least two whole clips, the shortest set within one standard error. "
      "Scores of sets rendered earlier were reused for the singles race and the growth; the final comparison re-rendered every finalist together with the earlier likeness-only picks, so old and new are compared on identical lines and seeds in one run "
      "(OmniVoice scores move by up to about 0.03 between renders of the same set, so the ECAPA figures here are not comparable with the 2026-10-07 table).")
    w("")
    w("**Pocket was stopped on the user's decision** after 1 of 43 voices and every process it started was killed, so Pocket keeps its current picks. Its gain-matched references come from those picks; "
      "its partial loudness-aware result for `aaron` is in `runs3/pocket-student-v2-s2000-ema-decv2-loud/` and is unused.")
    w("")
    w("**Loudness bonus** (`scripts/clip-search/loudband.py`, added to a set's ECAPA in every selection comparison; integrated LUFS of the reference as built, BS.1770-4):")
    w("")
    w(f"- {band['low']:g} to {band['high']:g} LUFS full bonus (+{band['bonus']:g}); between {band['high']:g} and {band['hot_above']:g} the same bonus (nothing extra for louder); "
      f"quieter than {band['low']:g}: -{band['quiet_slope']:g} per dB; hotter than {band['hot_above']:g}: -{band['hot_slope']:g} per dB.")
    w("- True peak above -3 dBFS: -0.010 per dB (this is the search bonus; the gain stage below uses a -1 dBTP ceiling); peak-to-loudness ratio under 11 dB (squashed or shouted): -0.004 per dB.")
    w("- A clip with clipping, silence or a noise floor above -48 dBFS is never a candidate; the combat, shouted-delivery, effect and media exclusions still apply.")
    w("")
    w("## Findings")
    w("")
    w("- **The game pool is level-matched.** Lines are mixed at about -23.6 LUFS: the median of 42 of the 43 voices lies between -23.4 and -25.1 LUFS, and the 10th to 90th percentile spans only 1 to 2 dB for most. "
      "Few clips sit in the -22 to -16 band (0 to 36 per voice; `jesse` is the exception, all hot at about -17.8). So selection alone moved the Omni sets by only a few tenths of a dB.")
    w("- **The gain stage** (`loud43/apply_loud43.py`): one linear gain towards -20 LUFS integrated, capped so the true peak stays at or below -1 dBTP (the EBU R128 ceiling), no limiter. "
      "Below -20 LUFS the gain is max(0, min(gain to -20, gain to the ceiling)), so a quiet set is never made quieter; a set whose peak is already over -1 dBTP keeps gain 0. "
      "Sets between -20 and -16 LUFS are left alone; sets hotter than -16 LUFS come down to -20 (only `jesse`; `robert-wilson`'s short set at -18.1 is inside the range and stays).")
    w("- **Most sets still end under -20 LUFS** because lines have isolated peaks: raising a set towards -20 pushes its peak past -1 dBTP first. Every such set is listed below.")
    w("")
    sets = {"omni-short": "OmniVoice short (up to 10 s)", "omni-long": "OmniVoice long (up to 18 s)", "pocket": "Pocket (current picks, up to 30 s)"}
    summary = []
    for name in ("omni-short", "omni-long", "omni", "pocket"):
        rows = [app["voices"][v][name] for v in voices]
        before = [r["before"]["lufs"] for r in rows]
        after = [r["gain"]["lufs"] for r in rows]
        under = sum(1 for r in rows if r["gain"]["lufs"] < -20.05)
        inband = sum(1 for r in rows if band["low"] <= r["gain"]["lufs"] <= band["hot_above"])
        lowered = sum(1 for r in rows if r["gain"]["gain_db"] < 0)
        zero = sum(1 for r in rows if r["gain"].get("reason", "") and r["gain"]["reason"].startswith("peak already"))
        summary.append((name, mean(before), mean(after), mean([r["gain"]["gain_db"] for r in rows]), under, inband, lowered, zero))
    w("| Set | Mean LUFS before (live file) | Mean LUFS after | Mean gain | Sets still under -20 LUFS | Sets inside -22 to -16 | Hot sets turned down | Sets left at gain 0 (peak already over -1 dBTP) |")
    w("|---|---:|---:|---:|---:|---:|---:|---:|")
    for name, b, a, g, u, i, lo, z in summary:
        w(f"| {name} | {b:.2f} | {a:.2f} | {g:+.2f} dB | {u} of 43 | {i} of 43 | {lo} | {z} |")
    w("")
    w("(`omni` is the OmniVoice best set, equal to the long or the short one for each voice.)")
    w("")
    for name, title in sets.items():
        w(f"## {title}")
        w("")
        rows = []
        for v in voices:
            a = app["voices"][v][name]
            old = None
            if name != "pocket":
                r = rep["voices"].get(v, {}).get(name)
                old = r["old"] if r else None
                new_ec = (r["ecapa"], r.get("ecapa_se")) if r else (None, None)
            rows.append((v, a, old, new_ec if name != "pocket" else (None, None)))
        changed = sum(1 for v, a, o, n in rows if a["set_changed"])
        w((f"{changed} of 43 voices got a different clip set than the likeness-only pick; the others keep the same clips. " if name != "pocket" else "Clip sets unchanged (current picks); only the level changed. ")
          + "LUFS: before = the file that was live, after = the new gain-matched file. † = still under -20 LUFS, held by the -1 dBTP ceiling; ‡ = gain 0, the peak is already over -1 dBTP; ↓ = a hot set turned down to -20.")
        w("")
        if name != "pocket":
            w("| Voice | Clips now (StringID, in order) | s | ECAPA ±SE | LUFS before → after | Gain | Likeness-only pick it replaces (same final) |")
            w("|---|---|---:|---|---|---|---|")
        else:
            w("| Voice | Clips (StringID, in order) | s | LUFS before → after | Gain |")
            w("|---|---|---:|---|---|")
        for v, a, old, (ec, se) in rows:
            g = a["gain"]
            mark = " ↓" if g["gain_db"] < 0 else ((" ‡" if (g.get("reason") or "").startswith("peak already") else " †") if g["lufs"] < -20.05 else "")
            level = f"{a['before']['lufs']:.1f} → {g['lufs']:.1f}{mark}"
            gain = f"{g['gain_db']:+.1f} dB"
            if name == "pocket":
                w(f"| {v} | {short_ids(a['ids'])} | {a['seconds']:.1f} | {level} | {gain} |")
                continue
            if a["set_changed"] and old:
                old_text = f"**{short_ids(old['ids'])}** ({old['seconds']:.1f} s, ECAPA {f(old['ecapa'], '.3f')}, {f(old.get('lufs'))} LUFS)"
            elif old:
                old_text = "same clips" + (" (other order)" if old["ids"] != a["ids"] else "")
            else:
                old_text = "-"
            se_text = f" ±{se:.3f}" if se is not None else ""
            w(f"| {v} | {short_ids(a['ids'])} | {a['seconds']:.1f} | {f(ec, '.3f')}{se_text} | {level} | {gain} | {old_text} |")
        w("")
    flat = [(v, n, app["voices"][v][n]["gain"]) for v in voices for n in ("omni-short", "omni-long", "pocket")]
    under = sorted([t for t in flat if t[2]["lufs"] < -20.05], key=lambda t: t[2]["lufs"])
    w("## Sets that stay under -20 LUFS")
    w("")
    w(f"{len(under)} of {len(flat)} short, long and Pocket sets end under -20 LUFS (the OmniVoice best set repeats the long or short one). Quietest first. Reason: † = the -1 dBTP ceiling stops the gain; ‡ = the peak is already over the ceiling, so gain 0 (never quieter). Also in `peak_limited` of `E:/CyberpunkConvai-offload/work/clip-search/loud43/apply-report.json`.")
    w("")
    w("| Voice | Set | Raw LUFS | Raw true peak | Gain | Final LUFS | Reason |")
    w("|---|---|---:|---:|---:|---:|---|")
    for v, n, g in under:
        w(f"| {v} | {n} | {g['raw_lufs']:.1f} | {g['raw_tp']:.1f} dBTP | {g['gain_db']:+.1f} dB | {g['lufs']:.1f} | {'‡' if (g.get('reason') or '').startswith('peak already') else '†'} |")
    w("")
    w("A true-peak limiter (or trimming the one loud transient) would let these sets reach -20 LUFS; it was ruled out. Reverting is a copy of the backup folder over `runtime/` (below).")
    w("")
    w("## Listen first")
    w("")
    ranking = []
    for v in voices:
        ch = [n for n in ("omni-short", "omni-long") if app["voices"][v][n]["set_changed"]]
        move = max(abs(app["voices"][v][n]["gain"]["lufs"] - app["voices"][v][n]["before"]["lufs"]) for n in ("omni-short", "omni-long", "pocket"))
        ranking.append((len(ch), move, v, ch))
    ranking.sort(key=lambda t: (-t[0], -t[1]))
    w("Ordered by how many Omni sets changed, then by the biggest level move (before to after, any set):")
    w("")
    for n_changed, move, v, ch in ranking[:12]:
        w(f"- `{v}`: {n_changed} Omni set(s) changed ({', '.join(ch) or 'none'}), level moved up to {move:.1f} dB")
    movers = sorted(ranking, key=lambda t: -t[1])[:6]
    w("")
    w("Biggest level moves overall: " + ", ".join(f"`{v}` ({m:.1f} dB)" for _, m, v, _ in movers) + ". Listen for harshness or shouting in the sets that went up, and for the hot `jesse` sets that were turned down for thin or distant sound.")
    w("")
    w("## Files, revert, re-run")
    w("")
    w("- Code: `scripts/clip-search/loudband.py` (measures and bonus), `search.py --loud` (selection; `--seed-scores`, `--tag`, `--voices remaining43`), `loud_survey.py`, `collect_loud.py`, `write_loud_doc.py`, `loud43/apply_loud43.py` (picks + gain, writes `runtime/`), `loud43/validate_configs.mjs`.")
    w("- Prepared sets (clip ids, schema 2): `scripts/clip-search/loud43/autobest-sets.loud43.json`. `runtime/autobest-sets.json` was updated for the 43 voices' Omni sets. "
      "**Do not re-run `Build-AutobestConfigs.mjs` for these voices without redoing the gain** (it rebuilds raw references); re-run `apply_loud43.py` afterwards (it is idempotent, gain is always computed from the raw reference).")
    w("- Results: `E:/CyberpunkConvai-offload/work/clip-search/runs3/omni16-loud/` (the earlier `omni16`, Pocket and caches are untouched beside it); numbers: `loud43/report.json`, `loud43/apply-report.json`.")
    w("- Backup (originals of the four configs, `autobest-sets.json` and the 172 WAVs): `runtime/backups/clip-search-43-20261014/`. Revert: copy `configs/*` over `runtime/` and `wavs/<set>/<voice>.wav` over `runtime/voice-references/picked/autobest/<set>/`.")
    DOC.write_text("\n".join(out) + "\n", encoding="utf-8")
    print("wrote", DOC)
    return 0


if __name__ == "__main__":
    sys.exit(main())
