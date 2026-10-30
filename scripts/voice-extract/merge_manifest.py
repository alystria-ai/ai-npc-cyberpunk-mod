"""Merge the shards recover_manifest.py wrote into characters/voice-clips-manifest.json and a coverage report.

    python scripts/voice-extract/merge_manifest.py --shards <folder with m_*.json and r_*.json> [--cast m_cast.json r_cast.json] [--extra m.json ...]
                                                   [--out characters/voice-clips-manifest.json] [--coverage research/voice-extract/coverage.json]

A clip is listed as `exact` when the build from the game files equals the shipped clip sample for sample (maxDiff 0).  The clips of the same voice that are built from the
same lines in the same way share one entry (`sameAs`).  Voices that cannot be rebuilt are listed in the coverage report with the reason and are not in the manifest.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NL = chr(10)
KINDS = ("omni-short", "omni-long", "pocket")


def same_recipe(a: dict, b: dict) -> bool:
    return all(a.get(field) == b.get(field) for field in ("writer", "gainDb", "samples", "sha256", "lines"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--shards", required=True)
    parser.add_argument("--extra", nargs="*", default=[], help="more manifest files (m_cast.json) to merge, each with its report beside it as r_<same>.json")
    parser.add_argument("--out", default=str(REPO / "characters/voice-clips-manifest.json"))
    parser.add_argument("--coverage", default=str(REPO / "research/voice-extract/coverage.json"))
    args = parser.parse_args()

    manifests = sorted(glob.glob(os.path.join(args.shards, "m_[0-9]*.json"))) + list(args.extra)
    voices: dict = {}
    for path in manifests:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        for key, kinds in data["voices"].items():
            voices.setdefault(key, {}).update(kinds)
    failed = []
    for path in sorted(glob.glob(os.path.join(args.shards, "r_[0-9]*.json"))) + [str(Path(p).with_name("r_" + Path(p).name[2:])) for p in args.extra]:
        if os.path.exists(path):
            failed += json.loads(Path(path).read_text(encoding="utf-8")).get("failed", [])
    # a failure that a later retry fixed is not a failure
    failed = [row for row in failed if row.get("kind") == "all" or row["kind"] not in voices.get(row["key"], {})]

    out: dict = {}
    for key in sorted(voices):
        row = {}
        for kind in KINDS:
            spec = voices[key].get(kind)
            if spec is None:
                continue
            spec = {k: v for k, v in spec.items() if k not in ("differing",)} | {"differing": spec.get("differing", 0)}
            earlier = next((other for other in KINDS if other in row and "sameAs" not in row[other] and same_recipe(row[other], spec)), None)
            row[kind] = {"sameAs": earlier} if earlier else spec
        out[key] = row

    exact = near = 0
    for kinds in voices.values():
        for spec in kinds.values():
            if spec["maxDiff"] == 0:
                exact += 1
            else:
                near += 1
    total_failed = len(failed)
    summary = {
        "voices": len(out), "clips": exact + near + total_failed, "exact": exact, "withinOneStep": sum(1 for kinds in voices.values() for s in kinds.values() if s["maxDiff"] == 1),
        "largerDifference": sum(1 for kinds in voices.values() for s in kinds.values() if s["maxDiff"] > 1), "notReproducible": total_failed,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    lines = [json.dumps({"version": 1, "rate": 24000, "gapSamples": 9600}, separators=(",", ":"))[:-1] + ',"voices":{']
    body = [f'"{key}":' + json.dumps(row, separators=(",", ":")) for key, row in out.items()]
    Path(args.out).write_text(lines[0] + NL + ("," + NL).join(body) + NL + "}}" + NL, encoding="utf-8")
    Path(args.coverage).parent.mkdir(parents=True, exist_ok=True)
    notes = [{"key": row["key"], "kind": row["kind"], "reason": row.get("reason")} for row in failed]
    inexact = sorted({f"{key}/{kind}" for key, kinds in voices.items() for kind, s in kinds.items() if s["maxDiff"] > 0})
    Path(args.coverage).write_text(json.dumps({"summary": summary, "notReproducible": notes, "notExact": inexact}, indent=1) + NL, encoding="utf-8")
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
