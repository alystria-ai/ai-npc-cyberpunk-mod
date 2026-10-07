"""Turn a hand-constrained single-voice run into a labelled variant row for the Voice report v3 (the overnight row is kept).

  python scripts/clip-search/make_variant.py --voice jackie-welles --runs E:/.../clip-search/runs-constrained --name constrained \
      --label "Jackie (constrained: <= +2 dB, clips > 6 s, few stops)"

Writes E:/.../clip-search/variants/<voice>--<name>.json (schema v2 sets of the variant plus label and note); build_page.py renders
one extra row per file right after the voice's own row.  Header averages are not affected by variants.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import common  # noqa: E402
from collect import trim  # noqa: E402

VARIANTS = common.WORK / "variants"


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--voice", required=True)
    parser.add_argument("--runs", type=Path, required=True)
    parser.add_argument("--name", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--omni-tag", default="omni16")
    parser.add_argument("--pocket-tag", default="pocket-student-v2-s2000-ema-decv2")
    args = parser.parse_args(argv)
    sets: dict = {}
    notes = []
    omni = json.loads((args.runs / args.omni_tag / args.voice / "result.json").read_text(encoding="utf-8"))
    entry = {name: trim(p) for name, p in omni["picks"].items()}
    entry["today"] = trim(omni.get("today"))
    entry["curve"] = [trim(p) for p in omni["curve"]]
    verify = args.runs / "omni32" / args.voice / "verify.json"
    if verify.is_file():
        entry["verify32"] = {k: trim(x) for k, x in json.loads(verify.read_text(encoding="utf-8")).items() if x}
    sets["omni"] = entry
    for name in omni.get("infeasible", []):
        notes.append(f"OmniVoice {name} set: not possible under this rule (two clips longer than 6 s do not fit {10 if name == 'short' else 18} s)")
    pocket = json.loads((args.runs / args.pocket_tag / args.voice / "result.json").read_text(encoding="utf-8"))
    entry = {name: trim(p) for name, p in pocket["picks"].items()}
    entry["today"] = trim(pocket.get("today"))
    entry["curve"] = [trim(p) for p in pocket["curve"]]
    sets["pocket"] = entry
    VARIANTS.mkdir(parents=True, exist_ok=True)
    out = VARIANTS / f"{args.voice}--{args.name}.json"
    rule = (omni.get("constraint") or {}).get("label", "")
    out.write_text(json.dumps({"base": args.voice, "key": f"{args.voice}--{args.name}", "label": args.label, "rule": rule,
                               "notes": notes, "sets": sets}, indent=1), encoding="utf-8")
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
