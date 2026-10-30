"""Step 1 of the cast sweep (2026-10-30): every Character record in the installed game that has a display name.

    python scripts/cast-sweep/inventory.py [--out staging/cast-sweep/records.json]

Reads (never writes) the installed REDmod tweak sources (base game and Phantom Liberty, `package Character` files) and the
repo's localisation index (research/cyberpunk/cache/game/localization/index/lookup.sqlite3, a copy of the game's English
tables).  For each record it resolves `displayName` and `fullDisplayName` through the parent chain, then looks the LocKey
up.  Writes one JSON list: record, parent, display, full, affiliation, template, voiceTag, source file, inherited flags.

Nothing here touches the running game; the files are only read.
"""
from __future__ import annotations

import argparse
import json
import re
import sqlite3
import sys
from pathlib import Path

GAME = Path("E:/SteamLibrary/steamapps/common/Cyberpunk 2077")
MAIN = Path(r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod")
LOOKUP = MAIN / "research/cyberpunk/cache/game/localization/index/lookup.sqlite3"
ROOTS = {"base": GAME / "tools/redmod/tweaks/base", "ep1": GAME / "tools/redmod/tweaks/ep1"}

HEADER = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_.]*)\s*$")
FIELD = {
    "display": re.compile(r'^\s*(?:\w+\s+)?displayName\s*=\s*"([^"]*)"', re.M),
    "full": re.compile(r'^\s*(?:\w+\s+)?fullDisplayName\s*=\s*"([^"]*)"', re.M),
    "template": re.compile(r'^\s*entityTemplatePath\s*=\s*"([^"]*)"', re.M),
    "affiliation": re.compile(r'^\s*(?:fk<\s*Affiliation\s*>\s*)?affiliation\s*=\s*"([^"]*)"', re.M),
    "voiceTag": re.compile(r'^\s*(?:CName\s+)?voiceTag\s*=\s*"([^"]*)"', re.M),
}


def parse_file(path: Path):
    text = path.read_text(encoding="utf-8-sig", errors="replace")
    if not re.search(r"^package\s+Character\b", text, re.M):
        return []
    lines = text.splitlines()
    out, i = [], 0
    while i < len(lines):
        m = HEADER.match(lines[i])
        if m and i + 1 < len(lines) and lines[i + 1].strip() == "{":
            j = i + 2
            while j < len(lines) and lines[j] != "}":
                j += 1
            body = "\n".join(lines[i + 2:j])
            row = {"record": m.group(1), "parent": m.group(2).replace("Character.", "")}
            for key, pattern in FIELD.items():
                found = pattern.search(body)
                row[key] = found.group(1) if found else None
            out.append(row)
            i = j
        i += 1
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="staging/cast-sweep/records.json")
    args = ap.parse_args()
    records: dict[str, dict] = {}
    for label, root in ROOTS.items():
        for path in sorted(root.rglob("*.tweak")):
            for row in parse_file(path):
                row["pack"] = label
                row["file"] = str(path.relative_to(root)).replace("\\", "/")
                # A record declared again in Phantom Liberty extends the base one; keep fields the later one sets.
                if row["record"] in records:
                    old = records[row["record"]]
                    for key in ("display", "full", "template", "affiliation", "voiceTag"):
                        row[key] = row[key] or old.get(key)
                records[row["record"]] = row

    def inherited(name: str, key: str, seen=None):
        seen = seen if seen is not None else set()
        row = records.get(name)
        if not row or name in seen:
            return None
        seen.add(name)
        if row.get(key):
            return row[key]
        return inherited(row["parent"], key, seen)

    db = sqlite3.connect(f"file:{LOOKUP.as_posix()}?mode=ro", uri=True)

    def loc(key):
        if not key:
            return None
        m = re.fullmatch(r"LocKey#(\d+)", key)
        if not m:
            return None
        for male, female in db.execute("select male,female from entries where domain='onscreen.primaryKey' and entry_id=?", (m.group(1),)):
            text = (female or male or "").strip()
            if text:
                return text
        return None

    result = []
    for name, row in records.items():
        entry = {k: row[k] for k in ("record", "parent", "pack", "file", "template", "affiliation", "voiceTag")}
        for key in ("display", "full"):
            own = bool(row.get(key))
            value = row.get(key) or inherited(row["parent"], key)
            entry[key + "Key"] = value
            entry[key] = loc(value)
            entry[key + "Own"] = own
        for key in ("template", "affiliation", "voiceTag"):
            if not entry[key]:
                entry[key] = inherited(row["parent"], key)
        result.append(entry)
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=0), encoding="utf-8")
    named = [r for r in result if r["display"]]
    print(f"records: {len(result)}  with a resolved display name: {len(named)}  own display: {sum(1 for r in named if r['displayOwn'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
