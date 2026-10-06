"""Statistics and spot-check lists for the combat flags -> E:/CyberpunkConvai-offload/work/combat-flags/report/ (stats.md, spot-check.md).

    vendor/reference-voicestudio/.venv/Scripts/python.exe scripts/combat_flags/report.py
"""
from __future__ import annotations

import collections
import json
import random
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import source_signal as ss  # noqa: E402

ROOT = Path(__file__).resolve().parents[2]
WORK = Path("E:/CyberpunkConvai-offload/work/combat-flags")
OUT = WORK / "report"
FLAGS = ROOT / "scripts/phone_detect/combat-flags.json"
SHOWN = json.loads((ROOT / "scripts/reference-picker/shown-voices.json").read_text(encoding="utf-8"))
SPOT = ["adam-smasher", "johnny-silverhand", "panam-palmer", "judy-alvarez", "jackie-welles", "takemura", "river-ward"]


def jsonl(path):
    with Path(path).open(encoding="utf-8") as stream:
        return [json.loads(line) for line in stream if line.strip()]


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    flags = json.loads(FLAGS.read_text(encoding="utf-8"))
    clips = flags["clips"]
    paths = {r["key"]: r for r in jsonl(WORK / "paths.jsonl")}
    dur = {r["key"]: r["dur_s"] for r in jsonl(WORK / "acoustic-features.jsonl")}
    by_sid, _ = ss.load_by_sid()
    corpus = json.loads(Path("E:/CyberpunkConvai-offload/work/pocket-v2/payload/corpus.json").read_text(encoding="utf-8"))
    roles = corpus["roles"]
    train_ids = {r["id"] for r in corpus["rows"] if r["id"] not in roles}

    def canon(i):
        import re
        k = re.sub(r"/(female|male)$", "", i)
        if k in clips:
            return k
        m = re.match(r"([^/]+)/(\d+)", i)
        return f"{m[1]}/{m[2]}" if m else k

    lines = ["# Combat / shouted-delivery flags: statistics", ""]
    s = flags["summary"]
    lines += [f"{s['flagged']} of {s['keys']} clips flagged ({100 * s['flagged'] / s['keys']:.1f}%) over {s['voices']} voices.", "",
              "## How the flagged clips were decided", "", "| decided by | clips |", "|---|---:|"]
    for k, n in s["by_how"].items():
        if not k.startswith(("unflagged", "inherited-unflagged")):
            lines.append(f"| {k} | {n} |")
    lines += ["", "Source tiers of all clips: " + ", ".join(f"{k} {n}" for k, n in s["by_source_tier"].items()), ""]
    # per voice (the user's 29)
    lines += ["## Per voice: the 29 shown voices", "", "| voice | clips | flagged | share | flagged by game data | by acoustics | seconds flagged | training clips | training flagged | share |", "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    pv = s["per_voice"]
    train_total = collections.Counter(); train_flag = collections.Counter()
    for i in train_ids:
        v = i.split("/")[0]; train_total[v] += 1
        if clips.get(canon(i), {}).get("combat"):
            train_flag[v] += 1
    others = sorted(set(pv) - set(SHOWN))
    for v in SHOWN:
        if v not in pv:
            continue
        e = pv[v]; by = e["by"]
        src = by.get("source", 0) + by.get("source+acoustic", 0) + by.get("inherited", 0)
        ac = by.get("acoustic", 0)
        lines.append(f"| {v}{'' if v in SHOWN else ' (other)'} | {e['clips']} | {e['flagged']} | {100 * e['share']:.1f}% | {by.get('source', 0)} (+{by.get('source+acoustic', 0)} with acoustics) | {ac} | {e['seconds_flagged']:.0f} s | {train_total[v]} | {train_flag[v]} | {100 * train_flag[v] / max(1, train_total[v]):.1f}% |")
    oc = sum(pv[v]["clips"] for v in others); of = sum(pv[v]["flagged"] for v in others)
    ot = sum(train_total[v] for v in others); otf = sum(train_flag[v] for v in others)
    lines.append(f"| the other {len(others)} voices | {oc} | {of} | {100 * of / max(1, oc):.1f}% | | | {sum(pv[v]['seconds_flagged'] for v in others):.0f} s | {ot} | {otf} | {100 * otf / max(1, ot):.1f}% |")
    lines.append(f"| ALL | {s['keys']} | {s['flagged']} | {100 * s['flagged'] / s['keys']:.1f}% | | | {sum(e['seconds_flagged'] for e in pv.values()):.0f} s | {sum(train_total.values())} | {sum(train_flag.values())} | {100 * sum(train_flag.values()) / max(1, sum(train_total.values())):.1f}% |")
    # duration
    bins = [(0, 1.5), (1.5, 2.5), (2.5, 4), (4, 6.5), (6.5, 9), (9, 99)]
    lines += ["", "## Duration versus flag (all clips)", "", "| duration | clips | flagged | share flagged | flagged by game data only |", "|---|---:|---:|---:|---:|"]
    for lo, hi in bins:
        ks = [k for k in clips if lo <= dur[k] < hi]
        f = [k for k in ks if clips[k]["combat"]]
        src = [k for k in f if clips[k].get("how") in ("source", None) and clips[k]["tier"] == "strong"]
        lines.append(f"| {lo}-{hi} s | {len(ks)} | {len(f)} | {100 * len(f) / max(1, len(ks)):.1f}% | {len(src)} |")
    ad = [k for k in clips if k.startswith("adam-smasher/") and k.split("/")[1] in
          "1653087655475433472 1776711517152501760 1876330591075450880 1876331655187152896 1995324830177058816 1995048870861103104 1995076448980328448 1792270501449261056 1792271201864474624 1792275223900020748 1792275223900020764".split()]
    lines += ["", f"Adam Smasher's 11 hand-picked clips last {min(dur[k] for k in ad):.1f}-{max(dur[k] for k in ad):.1f} s (median {np.median([dur[k] for k in ad]):.1f} s); flagged: {sum(clips[k]['combat'] for k in ad)} of {len(ad)}.", ""]
    (OUT / "stats.md").write_text("\n".join(lines), encoding="utf-8")

    # spot check
    rng = random.Random(20261007)
    sp = ["# Spot check: flagged and unflagged examples", "", "Scene is the game's scene file for the line; the reason is the first reason recorded.", ""]
    for v in SPOT:
        ks = [k for k in clips if k.startswith(v + "/") and "holocall" not in k]
        flagged = [k for k in ks if clips[k]["combat"]]
        normal = [k for k in ks if not clips[k]["combat"]]
        sp += [f"## {v}", "", f"{len(flagged)} of {len(ks)} flagged ({100 * len(flagged) / max(1, len(ks)):.1f}%).", "", "### Flagged", "", "| text | s | decided by | scene or bark | reason |", "|---|---:|---|---|---|"]
        by_how = collections.defaultdict(list)
        for k in flagged:
            by_how[clips[k].get("how")].append(k)
        pick = []
        for how, n in (("source", 4), ("source+acoustic", 2), ("acoustic", 3)):
            rng.shuffle(by_how[how]); pick += by_how[how][:n]
        def scene_of(k):
            rows = by_sid.get(paths[k]["string_id"], [])
            return ss.scene_stem(rows[0]["scene"]) if rows else "(no scene)"
        for k in pick:
            c = clips[k]
            sp.append(f"| {paths[k]['text'][:70]} | {dur[k]:.1f} | {c.get('how')} | {scene_of(k)} | {(c['reasons'] or [''])[0][:90]} |")
        sp += ["", "### Not flagged", "", "| text | s | source tier | scene |", "|---|---:|---|---|"]
        for k in rng.sample(normal, min(8, len(normal))):
            sp.append(f"| {paths[k]['text'][:70]} | {dur[k]:.1f} | {clips[k]['tier']} | {scene_of(k)} |")
        sp.append("")
    (OUT / "spot-check.md").write_text("\n".join(sp), encoding="utf-8")
    print((OUT / "stats.md").read_text(encoding="utf-8"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
