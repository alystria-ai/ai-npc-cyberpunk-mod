"""Write the person-check input for the Haiku agents: one line per uncovered pair, split in N files.

    python scripts/cast-sweep/person-check-input.py [--parts 2]

Line format: id | display | full | affiliation | sample record names (max 3) | number of records
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("--pairs", default="staging/cast-sweep/pairs.json")
ap.add_argument("--parts", type=int, default=2)
args = ap.parse_args()
pairs = json.loads(Path(args.pairs).read_text(encoding="utf-8"))
todo = [(i, p) for i, p in enumerate(pairs) if not p["covered"]]
size = -(-len(todo) // args.parts)
for part in range(args.parts):
    lines = []
    for i, p in todo[part * size:(part + 1) * size]:
        recs = p["records"]
        aff = next((r["affiliation"] for r in recs if r["affiliation"]), "") or ""
        names = ",".join(r["record"] for r in recs[:3])
        lines.append(f"{i} | {p['display']} | {p['full']} | {aff.replace('Factions.', '')} | {names} | {len(recs)}")
    path = Path(f"staging/cast-sweep/person-check-in-{part + 1}.txt")
    path.write_text("\n".join(lines), encoding="utf-8")
    print(path, len(lines))
