"""Step 6: the before -> after table of the expanded pool (candidate clips and seconds per voice).

    python scripts/reference-pool/report.py [--out report.md]

Compares the picker's pool index before the expansion (pool-index.pre-expansion.json, a copy made before the first
rebuild) with the current one.  Prints a markdown table, the 29 priority voices first, then the others, and flags the
voices that still have few usable clips (fewer than FEW_CLIPS candidates, or fewer than FEW_SECONDS in total).  The
"usable" columns count clips of 2-9 s, which is what "Try different clips" draws from.
"""
from __future__ import annotations

import argparse
import json
import sys

from common import *  # noqa

PRIORITY = read_json(ROOT / "scripts/reference-picker/shown-voices.json")
FEW_CLIPS, FEW_SECONDS = 40, 200


def stats(index, voice):
    every = index["voices"].get(voice, {}).get("clips", [])
    clips = [c for c in every if not c.get("fx")]          # effect-heavy clips are not candidates
    usable = [c for c in clips if 2 <= c["d"] <= 9]
    return {"n": len(clips), "s": sum(c["d"] for c in clips), "u": len(usable),
            "new": sum(1 for c in clips if c.get("s") == "expanded"), "fx": len(every) - len(clips), "typ": sum(1 for c in clips if c.get("ty") is not None)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out")
    args = parser.parse_args()
    before = read_json(POOL_INDEX.with_name("pool-index.pre-expansion.json"))
    after = read_json(POOL_INDEX)
    voices = [v for v in PRIORITY if v in after["voices"]] + sorted(v for v, d in after["voices"].items() if d["live"] and v not in PRIORITY)
    lines = ["| Voice | Clips before | Clips after | Seconds before | Seconds after | New | 2-9 s clips (before -> after) | Effect-flagged (excluded) | Note |",
             "|---|---:|---:|---:|---:|---:|---:|---:|---|"]
    total = {"b": 0, "a": 0, "bs": 0, "as": 0}
    few = []
    for voice in voices:
        b, a = stats(before, voice), stats(after, voice)
        note = ""
        if a["n"] < FEW_CLIPS or a["s"] < FEW_SECONDS:
            note = "few clips"
            few.append(voice)
        if voice in PRIORITY and voice == "adam-smasher":
            note = (note + "; " if note else "") + "processed character voice"
        lines.append(f"| {voice}{' *' if voice in PRIORITY else ''} | {b['n']} | {a['n']} | {b['s']:.0f} | {a['s']:.0f} | {a['new']} | {b['u']} -> {a['u']} | {a['fx']} | {note} |")
        total["b"] += b["n"]; total["a"] += a["n"]; total["bs"] += b["s"]; total["as"] += a["s"]
    lines.append(f"| **Total** | {total['b']} | {total['a']} | {total['bs']:.0f} | {total['as']:.0f} | {total['a'] - total['b']} | | | |")
    text = "\n".join(lines) + f"\n\n(* = one of the 29 priority voices; few clips = under {FEW_CLIPS} candidates or under {FEW_SECONDS} s)\nStill few: {', '.join(few) or 'none'}\n"
    print(text)
    if args.out:
        Path(args.out).write_text(text, encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
