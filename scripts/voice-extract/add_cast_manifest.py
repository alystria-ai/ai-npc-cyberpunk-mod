"""Add the cast sweep characters that recover_manifest.py --cast-sweep reproduced to characters/voice-clips-manifest.json, without touching any other entry.

    python scripts/voice-extract/add_cast_manifest.py --cast m_cast.json [--check]

`m_cast.json` is the output of `recover_manifest.py --cast-sweep` (every cast sweep character that has a `clip` in characters/cast-sweep-voices.json), or of
`recover_manifest.py --keys model-...` for the archetype style voices of generic voice models (scripts/cast-sweep/build_model_voices.py, keys `model-<model>`).  A character that is
already in the manifest must come out the same (the script stops otherwise), a new one must be exact (largest difference 0).  The file keeps its layout: one voice
per line, sorted by key, the same text merge_manifest.py writes.  --check writes nothing and fails when the manifest would change.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
NL = chr(10)


def render(voices: dict) -> str:
    head = json.dumps({"version": 1, "rate": 24000, "gapSamples": 9600}, separators=(",", ":"))[:-1] + ',"voices":{'
    body = [f'"{key}":' + json.dumps(row, separators=(",", ":")) for key, row in sorted(voices.items())]
    return head + NL + ("," + NL).join(body) + NL + "}}" + NL


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cast", required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    target = REPO / "characters/voice-clips-manifest.json"
    raw = target.read_bytes().decode("utf-8")
    manifest = json.loads(raw)
    sweep = json.loads((REPO / "characters/cast-sweep-voices.json").read_text(encoding="utf-8"))["characters"]
    cast = json.loads(Path(args.cast).read_text(encoding="utf-8"))["voices"]
    voices = manifest["voices"]
    added = []
    for key in sorted(cast):
        if not sweep.get(key, {}).get("clip") and not key.startswith("model-"):
            print(f"PROBLEM {key}: has no clip in cast-sweep-voices.json and is not a model voice")
            return 1
        if key in voices:
            if voices[key] != cast[key]:
                print(f"PROBLEM {key}: the manifest entry differs from the recovered one")
                return 1
            continue
        spec = cast[key]["omni-short"]
        if spec["maxDiff"] != 0 or spec["differing"] != 0:
            print(f"PROBLEM {key}: not exact (largest difference {spec['maxDiff']}, {spec['differing']} samples)")
            return 1
        voices[key] = cast[key]
        added.append(key)
    text = render(voices)
    if text.replace(NL, "\r\n") == raw:
        text = text.replace(NL, "\r\n")
    elif "\r\n" in raw:
        text = text.replace(NL, "\r\n")
    changed = text != raw
    print(f"{len(added)} added: {','.join(added)}" if added else "nothing to add")
    if args.check:
        return 1 if changed else 0
    if changed:
        target.write_bytes(text.encode("utf-8"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
