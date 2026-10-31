"""Step 4c of the cast sweep: write the clips voices.py picked into characters/cast-sweep-voices.json (docs/CAST_SWEEP.md, "Own voices by voice tag").

    python scripts/cast-sweep/apply_own_voices.py --voices voices.json --links voice-links.json [--check]

For each key in voices.json the character gets `clip` ({stem, id, seconds}, the same shape as the first 27) and `link` ({tag, how}: the voice tag that
was proven to be the person's and the kinds of evidence, see scripts/cast-sweep/voice_links.py).  The `fallback` archetype stays as the stand-in.  A key that
already has a clip is left alone.  --check writes nothing and fails when a key of the files is not in the roster or already has another clip.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--voices", required=True)
    parser.add_argument("--links", required=True)
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    target = REPO / "characters/cast-sweep-voices.json"
    data = json.loads(target.read_text(encoding="utf-8"))
    voices = json.loads(Path(args.voices).read_text(encoding="utf-8"))
    links = json.loads(Path(args.links).read_text(encoding="utf-8"))["accepted"]
    problems, added = [], []
    for key, voice in sorted(voices.items()):
        row = data["characters"].get(key)
        if row is None:
            problems.append(f"{key}: not a cast sweep character")
        elif row.get("clip"):
            problems.append(f"{key}: already has a clip")
        elif key not in links:
            problems.append(f"{key}: no accepted voice tag in the links file")
        else:
            row["clip"] = {"stem": voice["stem"], "id": voice["id"], "seconds": voice["seconds"]}
            row["link"] = {"tag": links[key]["tag"], "how": links[key]["how"]}
            added.append(key)
    for problem in problems:
        print("PROBLEM", problem)
    if problems or args.check:
        return 1 if problems else 0
    target.write_bytes((json.dumps(data, ensure_ascii=False, indent=2) + "\n").replace("\n", "\r\n").encode("utf-8"))      # the file's own layout: two spaces, CRLF
    print("added:", ",".join(added))
    return 0


if __name__ == "__main__":
    sys.exit(main())
