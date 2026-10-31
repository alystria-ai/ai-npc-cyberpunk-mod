"""Point the fallback voice of every side character the scenes tie to a generic voice model at the archetype voice of that model.

    python scripts/cast-sweep/apply_voice_models.py --models voice-models.json [--check] [--report report.json]

`voice-models.json` is the output of voice_models.py.  For each person with verdict `model` and no clip of their own, `fallback` in characters/cast-sweep-voices.json becomes
the archetype voice whose `voiceset` (characters/archetype-voices.json) is that model, which is either one of the archetypes that already ship or a `model-<model>` voice
built by build_model_voices.py (characters/model-voices.json), and `voiceModel` records the proof: {model, how, lines}.  A person whose model has no ready archetype voice,
or whose gender differs from the model's, keeps the old fallback and is listed in the report as not applied.  --check writes nothing and fails when the file would change.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--models", required=True)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--report")
    args = parser.parse_args()
    target = REPO / "characters/cast-sweep-voices.json"
    raw = target.read_bytes().decode("utf-8")
    data = json.loads(raw)
    verdicts = json.loads(Path(args.models).read_text(encoding="utf-8"))
    receipt = json.loads((REPO / "characters/archetype-voices.json").read_text(encoding="utf-8-sig"))["voices"]
    by_model = {entry["voiceset"]: key for key, entry in receipt.items() if entry.get("status") == "ready" and entry.get("voiceset")}
    roster = {row["key"]: row for row in json.loads((REPO / "characters/roster.json").read_text(encoding="utf-8-sig"))}
    applied, skipped = {}, {}
    for key, verdict in verdicts.items():
        row = data["characters"].get(key)
        if row is None or verdict.get("hasClip") or row.get("clip") or verdict["verdict"] != "model":
            continue
        model = verdict["model"]
        archetype = by_model.get(model)
        gender = (roster[key].get("gender") or "").upper()
        if archetype is None:
            skipped[key] = f"no ready archetype voice for {model}"
        elif gender in ("MALE", "FEMALE") and gender != ("MALE" if "_m_" in model else "FEMALE"):
            skipped[key] = f"the model {model} is {'male' if '_m_' in model else 'female'} and the roster says {gender.lower()}"
        else:
            row["fallback"] = archetype
            row["voiceModel"] = {"model": model, "how": verdict["how"], "lines": verdict["lines"]}
            applied[key] = archetype
    text = (json.dumps(data, ensure_ascii=False, indent=2) + "\n").replace("\n", "\r\n" if "\r\n" in raw else "\n")
    print(f"{len(applied)} people point at the archetype voice of their model, {len(skipped)} not applied")
    for key, why in skipped.items():
        print("  not applied", key, why)
    if args.report:
        Path(args.report).write_text(json.dumps({"applied": applied, "skipped": skipped}, indent=1), encoding="utf-8")
    if args.check:
        return 1 if text != raw else 0
    if text != raw:
        target.write_bytes(text.encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
