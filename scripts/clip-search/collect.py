"""Gather the per-voice search results into the picker's data file and a results table.

  python scripts/clip-search/collect.py [--omni omni16] [--pocket pocket-<export>] [--runs <dir>]

Writes (never the live configs):
  runtime/autobest-sets.json                      what scripts/Build-AutobestConfigs.mjs and the picker read
  E:/.../clip-search/results/autobest-sets.json   the same file
  E:/.../clip-search/results/results.md           the table
"""
from __future__ import annotations

import argparse
import datetime
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402

KEEP = ("ids", "k", "seconds", "ecapa", "ecapa_se", "ecapa_tgt", "seed_sd", "pls", "pls_parts", "baseline")


def trim(row):
    return {k: row[k] for k in KEEP if row and k in row} if row else None


def voice_entry(result: dict) -> dict:
    picks = result["picks"]
    entry = {name: trim(row) for name, row in picks.items()}
    base = result.get("baselines", {})
    entry["today"] = trim(base.get("today"))
    entry["proposed"] = {name: trim(row) for name, row in base.items() if name.startswith("proposed")}
    chosen = {tuple(row["ids"]) for row in picks.values() if row}
    k_best = {}
    for row in result["finalists"]:
        if row.get("baseline") or row["ids"][0].startswith("live:"):
            continue
        k_best.setdefault(row["k"], []).append(row)
    entry["runnersUp"] = [trim(row) for k in (1, 2, 3) for row in sorted(k_best.get(k, []), key=lambda r: -r["ecapa"])[:3]
                          if tuple(row["ids"]) not in chosen]
    entry["byK"] = {str(k): trim(max(rows, key=lambda r: r["ecapa"])) for k, rows in k_best.items()}
    entry["noise"] = result.get("noise")
    entry["order_check"] = result.get("order_check")
    entry["budget"] = result.get("budget")
    entry["screen"] = result.get("screen")
    entry["holdout"] = {"lines_dev": result["split"]["dev"], "lines_final": result["split"]["final"], "n": len(result["split"]["holdout"])}
    return entry


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--omni", default="omni16")
    parser.add_argument("--pocket")
    parser.add_argument("--runs", type=Path, default=common.WORK / "runs")
    args = parser.parse_args(argv)
    shown = json.loads((common.ROOT / "scripts/reference-picker/shown-voices.json").read_text(encoding="utf-8"))
    data = {"version": 1, "generated": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
            "engines": {}, "voices": {}}
    for engine, tag in (("omni", args.omni), ("pocket", args.pocket)):
        if not tag:
            continue
        folder = args.runs / tag
        data["engines"][engine] = {"tag": tag, "runs": str(folder)}
        for result_file in sorted(folder.glob("*/result.json")):
            result = json.loads(result_file.read_text(encoding="utf-8"))
            if "picks" not in result:
                continue
            data["voices"].setdefault(result["voice"], {})[engine] = voice_entry(result)
    out = [data]
    rows = ["| Voice | Engine | Best set | Clips | Seconds | ECAPA (±SE) | PLS | Today ECAPA | Gain | 10 s set | Single |",
            "|---|---|---|---|---|---|---|---|---|---|---|"]
    for voice in shown:
        for engine in ("omni", "pocket"):
            entry = data["voices"].get(voice, {}).get(engine)
            if not entry or not entry.get("best"):
                rows.append(f"| {voice} | {engine} | not searched | | | | | | | | |")
                continue
            best, today = entry["best"], entry.get("today")
            gain = f"{best['ecapa'] - today['ecapa']:+.3f}" if today else ""
            short, single = entry.get("short"), entry.get("single")
            rows.append(f"| {voice} | {engine} | {', '.join(i.split('/')[-1][:10] for i in best['ids'])} | {best['k']} | {best['seconds']} | "
                        f"{best['ecapa']:.3f} (±{best['ecapa_se']:.3f}) | {best.get('pls', '')} | {today['ecapa'] if today else ''} | {gain} | "
                        f"{short['k']} clip(s) {short['ecapa']:.3f}" + (" | " if True else "") +
                        f"{single['ecapa']:.3f} |" if short and single else " | | |")
    results_dir = common.WORK / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    text = json.dumps(data, indent=1)
    (results_dir / "autobest-sets.json").write_text(text, encoding="utf-8")
    (common.ROOT / "runtime" / "autobest-sets.json").write_text(text, encoding="utf-8")
    (results_dir / "results.md").write_text("\n".join(rows) + "\n", encoding="utf-8")
    print("\n".join(rows))
    print(f"{len(data['voices'])} voices -> runtime/autobest-sets.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
