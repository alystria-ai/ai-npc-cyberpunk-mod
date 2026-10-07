"""Gather the per-voice duration-search results into the picker's data file, the aggregate curves and the results table.

  python scripts/clip-search/collect.py [--runs <dir>] [--omni omni16] [--omni32 omni32] [--pocket pocket-<export>]

Writes (never the live configs):
  runtime/autobest-sets.json                      schema v2: what scripts/Build-AutobestConfigs.mjs and the picker read
  E:/.../clip-search/results/autobest-sets.json   the same file
  E:/.../clip-search/results/results.md           per-voice table, aggregate curves

Schema v2 (no clip counts): voices[key].omni = {short, long, best, today, curve, verify32}, voices[key].pocket = {best, today,
curve, unconstrained}; every set is {ids, seconds, ecapa, ecapa_se, ecapa_tgt, pls, latency_ms (Omni)}.
"""
from __future__ import annotations

import argparse
import datetime
import json
import math
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

KEEP = ("ids", "seconds", "ecapa", "ecapa_se", "ecapa_tgt", "pls", "pls_parts", "latency_ms")
GRID_OMNI = [2, 4, 6, 8, 10, 12, 14, 16, 18]
GRID_POCKET = [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 35, 40]


def trim(row):
    return {k: row[k] for k in KEEP if k in row} if row else None


def step_value(curve, seconds):
    """ECAPA of the longest curve point not beyond `seconds` (None if the path does not start that low or stops earlier)."""
    points = [p for p in curve if p["seconds"] <= seconds + 1e-9]
    return points[-1]["ecapa"] if points else None


def reaches(curve, seconds):
    return bool(curve) and curve[-1]["seconds"] >= seconds - 1e-9


def aggregate(curves, grid, reference=18):
    """Per grid duration: voices that reach it, mean ECAPA, and the mean paired change vs the same voice at `reference` s."""
    rows = []
    for g in grid:
        values, deltas = [], []
        for curve in curves:
            if not curve or not reaches(curve, g):
                continue
            v = step_value(curve, g)
            if v is None:
                continue
            values.append(v)
            base = step_value(curve, reference) if reaches(curve, reference) else None
            if base is not None:
                deltas.append(v - base)
        se = (statistics.stdev(deltas) / math.sqrt(len(deltas))) if len(deltas) > 1 else None
        rows.append({"seconds": g, "voices": len(values), "ecapa": round(statistics.mean(values), 4) if values else None,
                     "delta_vs_ref": round(statistics.mean(deltas), 4) if deltas else None, "reference_seconds": reference, "delta_se": round(se, 4) if se is not None else None})
    return rows


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--runs", type=Path, default=common.WORK / "runs3")
    parser.add_argument("--omni", default="omni16")
    parser.add_argument("--omni32", default="omni32")
    parser.add_argument("--pocket", default="pocket-student-v2-s2000-ema-decv2")
    args = parser.parse_args(argv)
    shown = json.loads((common.ROOT / "scripts/reference-picker/shown-voices.json").read_text(encoding="utf-8"))
    data = {"version": 2, "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "engines": {"omni": {"tag": args.omni}, "pocket": {"tag": args.pocket}}, "voices": {}}
    for voice in shown:
        row = {}
        omni_file = args.runs / args.omni / voice / "result.json"
        if omni_file.is_file():
            r = json.loads(omni_file.read_text(encoding="utf-8"))
            if "picks" in r:
                entry = {name: trim(p) for name, p in r["picks"].items()}
                entry["today"] = trim(r.get("today"))
                entry["curve"] = [trim(p) for p in r["curve"]]
                entry["noise"], entry["budget"] = r.get("noise"), r.get("budget")
                v32 = args.runs / args.omni32 / voice / "verify.json"
                if v32.is_file():
                    v = json.loads(v32.read_text(encoding="utf-8"))
                    entry["verify32"] = {k: trim(x) for k, x in v.items() if x}
                row["omni"] = entry
        pocket_file = args.runs / args.pocket / voice / "result.json"
        if pocket_file.is_file():
            r = json.loads(pocket_file.read_text(encoding="utf-8"))
            if "picks" in r:
                entry = {name: trim(p) for name, p in r["picks"].items()}
                entry["today"] = trim(r.get("today"))
                entry["curve"] = [trim(p) for p in r["curve"]]
                entry["noise"], entry["budget"] = r.get("noise"), r.get("budget")
                row["pocket"] = entry
        if row:
            data["voices"][voice] = row
    omni_curves = [v["omni"]["curve"] for v in data["voices"].values() if "omni" in v]
    pocket_curves = [v["pocket"]["curve"] for v in data["voices"].values() if "pocket" in v]
    data["curves"] = {"omni": aggregate(omni_curves, GRID_OMNI, reference=10), "pocket": aggregate(pocket_curves, GRID_POCKET, reference=18)}

    def fmt(p, key="ecapa"):
        return f"{p[key]:.3f}" if p else ""

    lines = ["## OmniVoice 16 steps (32-step check in brackets)", "",
             "| Voice | Short s | ECAPA | +latency 16/32 | Long s | ECAPA | +latency 16/32 | Best | Today s / ECAPA |", "|---|---|---|---|---|---|---|---|---|"]
    for voice in shown:
        o = data["voices"].get(voice, {}).get("omni")
        if not o:
            lines.append(f"| {voice} | not searched | | | | | | | |")
            continue
        v32 = o.get("verify32", {})

        def cell(name):
            p = o[name]
            lat = p.get("latency_ms", {})
            c32 = f" ({v32[name]['ecapa']:.3f})" if name in v32 else ""
            return f"{p['seconds']:.1f} | {p['ecapa']:.3f}{c32} | +{lat.get('16', 0) / 1000:.2f}/+{lat.get('32', 0) / 1000:.2f} s"
        today = o.get("today")
        best_name = "long" if o["best"]["ids"] == o["long"]["ids"] and o["best"]["ids"] != o["short"]["ids"] else "short"
        lines.append(f"| {voice} | {cell('short')} | {cell('long')} | {best_name} | {today['seconds']:.1f} / {today['ecapa']:.3f} |" if today else
                     f"| {voice} | {cell('short')} | {cell('long')} | {best_name} | |")
    lines += ["", "## Pocket (new student + decoder v2)", "",
              "| Voice | Best s | ECAPA ±SE | Today s / ECAPA | Beyond 30 s (research) |", "|---|---|---|---|---|"]
    for voice in shown:
        p = data["voices"].get(voice, {}).get("pocket")
        if not p:
            lines.append(f"| {voice} | not searched | | | |")
            continue
        today, best, beyond = p.get("today"), p["best"], p.get("unconstrained")
        lines.append(f"| {voice} | {best['seconds']:.1f} | {best['ecapa']:.3f} ±{best['ecapa_se']:.3f} | "
                     f"{(str(round(today['seconds'], 1)) + ' / ' + format(today['ecapa'], '.3f')) if today else ''} | "
                     f"{(str(round(beyond['seconds'], 1)) + ' s ' + format(beyond['ecapa'], '.3f')) if beyond else ''} |")
    for engine, grid_rows in data["curves"].items():
        lines += ["", f"## Aggregate ECAPA vs reference duration: {engine}", "", f"| Seconds | Voices reaching it | Mean ECAPA | Change vs {grid_rows[0]['reference_seconds']} s, same voices (±SE) |", "|---|---|---|---|"]
        for g in grid_rows:
            lines.append(f"| {g['seconds']} | {g['voices']} | {g['ecapa'] if g['ecapa'] is not None else ''} | "
                         f"{('%+.4f' % g['delta_vs_ref']) + (' ±%.4f' % g['delta_se'] if g['delta_se'] is not None else '') if g['delta_vs_ref'] is not None else ''} |")
    results_dir = common.WORK / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=1)
    (results_dir / "autobest-sets.json").write_text(text, encoding="utf-8")
    (common.ROOT / "runtime" / "autobest-sets.json").write_text(text, encoding="utf-8")
    (results_dir / "results.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    print(f"{len(data['voices'])} voices -> runtime/autobest-sets.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
