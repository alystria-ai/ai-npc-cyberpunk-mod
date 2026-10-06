"""Stamp the combat flags onto an existing picker pool index (pool-index.json) in place: "cb": {s: score, w: [reasons]} on every flagged clip.

    python scripts/combat_flags/stamp_index.py [--index E:/CyberpunkConvai-offload/work/reference-picker/pool-index.json] [--flags scripts/phone_detect/combat-flags.json]

build-index.py does the same when the index is rebuilt; this tool is for the index that already exists (a rebuild also re-reads the live
configs and the proposals, which changes more than the flag).  The previous file is kept once as pool-index.pre-combat.json.  Re-running
replaces the flags (clips that are no longer flagged lose "cb").
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INDEX = Path("E:/CyberpunkConvai-offload/work/reference-picker/pool-index.json")
FLAGS = ROOT / "scripts/phone_detect/combat-flags.json"


def combat_flag(flags: dict, clip_id: str):
    key = re.sub(r"/(female|male)$", "", clip_id)
    if key in flags:
        return flags[key]
    match = re.match(r"([^/]+)/(\d+)", clip_id)
    return flags.get(f"{match[1]}/{match[2]}") if match else None


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--index", type=Path, default=INDEX)
    parser.add_argument("--flags", type=Path, default=FLAGS)
    args = parser.parse_args()
    flags = json.loads(args.flags.read_text(encoding="utf-8"))["clips"]
    index = json.loads(args.index.read_text(encoding="utf-8"))
    backup = args.index.with_name("pool-index.pre-combat.json")
    if not backup.exists():
        shutil.copy2(args.index, backup)
    flagged = total = 0
    for voice in index["voices"].values():
        for clip in voice["clips"]:
            total += 1
            flag = combat_flag(flags, clip["id"])
            if flag and flag.get("combat"):
                clip["cb"] = {"s": flag["score"], "w": flag["reasons"]}
                flagged += 1
            else:
                clip.pop("cb", None)
    index["sources"]["clipsCombatFlagged"] = flagged
    temporary = args.index.with_name(args.index.name + ".tmp")
    temporary.write_text(json.dumps(index, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(args.index)
    print(json.dumps({"clips": total, "flagged": flagged, "index": str(args.index)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
