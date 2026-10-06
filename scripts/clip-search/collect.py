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


T_CRIT = {1: 12.71, 2: 4.30, 3: 3.18, 4: 2.78, 5: 2.57, 6: 2.45, 7: 2.36}   # two-sided 95%, by degrees of freedom


def paired(a: list[float], b: list[float]):
    """Paired difference over the fresh lines: (mean diff, t, degrees of freedom)."""
    import statistics
    diffs = [x - y for x, y in zip(a, b)]
    if len(diffs) < 2:
        return None
    sd = statistics.stdev(diffs)
    mean = sum(diffs) / len(diffs)
    return mean, (mean / (sd / len(diffs) ** 0.5) if sd > 0 else float("inf")), len(diffs) - 1


def significance(result: dict) -> dict:
    """Is the chosen set really better than today's reference and than the best other searched set, or a tie?"""
    finalists = result["finalists"]
    best = result["picks"]["best"]
    if not best:
        return {}
    mine = next(r for r in finalists if r["ids"] == best["ids"])
    out = {}
    today = next((r for r in finalists if r.get("baseline") == "today"), None)
    others = [r for r in finalists if r["ids"] != best["ids"] and not r.get("baseline") and not r["ids"][0].startswith("live:")]
    def verdict(stat):
        if stat is None:
            return "n/a"
        mean, t, df = stat
        crit = T_CRIT.get(df, 2.0)
        return "clear" if mean > 0 and t > crit else "tie" if abs(t) <= crit else "behind"
    if today:
        stat = paired(mine["per_line"], today["per_line"])
        out["vs_today"] = {"diff": round(stat[0], 4), "t": round(stat[1], 2), "df": stat[2], "verdict": verdict(stat)} if stat else None
    if others:
        # the strongest rival: the other searched set with the highest mean
        rival = max(others, key=lambda r: r["ecapa"])
        stat = paired(mine["per_line"], rival["per_line"])
        out["vs_best_other"] = {"ids": rival["ids"], "diff": round(stat[0], 4), "t": round(stat[1], 2), "df": stat[2], "verdict": verdict(stat)} if stat else None
        out["tied_sets"] = sum(1 for r in others if (lambda s: s is None or verdict(s) == "tie")(paired(mine["per_line"], r["per_line"])))
    # one word for the table: a winner only if it is clearly ahead of today's reference and not tied with its closest rival
    rival_v = (out.get("vs_best_other") or {}).get("verdict")
    today_v = (out.get("vs_today") or {}).get("verdict")
    out["call"] = ("clear winner" if rival_v in (None, "n/a", "clear") and today_v in (None, "clear") else
                   "beats today, ties with other searched sets" if today_v == "clear" else "tie with today's reference or others")
    return out


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
    entry["significance"] = significance(result)
    # PLS is secondary, but a winner whose PLS is far below today's reference deserves a listen (per-voice PLS is noisy).
    best, today = picks.get("best"), base.get("today")
    entry["flags"] = [f"PLS {best['pls']} vs today's {today['pls']}: listen"] if best and today and "pls" in best and "pls" in today and best["pls"] < today["pls"] - 20 else []
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
    rows = ["| Voice | Engine | Winner (clips, s) | ECAPA ±SE | PLS | Today ECAPA / PLS | Call | 1 clip ECAPA / PLS | 2 clips | 3 clips | 10 s set | Tied sets | Flag |",
            "|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    def cell(row):
        return f"{row['ecapa']:.3f} / {row.get('pls', '')}" if row else ""
    for voice in shown:
        for engine in ("omni", "pocket"):
            entry = data["voices"].get(voice, {}).get(engine)
            if not entry or not entry.get("best"):
                rows.append(f"| {voice} | {engine} | not searched | | | | | | | | | | |")
                continue
            best, today, by_k, sig = entry["best"], entry.get("today"), entry.get("byK", {}), entry.get("significance", {})
            short = entry.get("short")
            rows.append(f"| {voice} | {engine} | {best['k']} ({best['seconds']} s) | {best['ecapa']:.3f} ±{best['ecapa_se']:.3f} | {best.get('pls', '')} | "
                        f"{cell(today)} | {sig.get('call', '')} | {cell(by_k.get('1'))} | {cell(by_k.get('2'))} | {cell(by_k.get('3'))} | "
                        f"{short['k']} clip(s) {short['ecapa']:.3f} | {sig.get('tied_sets', '')} | {'; '.join(entry.get('flags', []))} |")
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
