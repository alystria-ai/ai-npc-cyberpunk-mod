"""Which side characters (the minor roster rows) can be spawned, per game version.

A record is a body the mod can spawn when the TweakDB of the game has the record and its entityTemplatePath flat. Both ids are looked up
by CRC32 plus name length (the 5 identifying bytes of a TweakDBID), the way scripts/clip-search/cast-expansion/cx_common.py does it, in
tweakdb.bin and tweakdb_ep1.bin of the game 2.5 folder and of the game 2.31 copy. Read only.

    python scripts/cast-sweep/invite-check.py [--out scripts/cast-sweep/side-invite-records.json]

Output: {"games": {...}, "rows": {key: {"record": first record, "v25": "base"|"ep1"|null, "v231": ..., "template25": bool, ...}}}.
A row can be invited when its first record (the one the Companion Manager registers) is there in both versions and no record of it is a child (the
game's isChild flag); scripts/cast-sweep/side-invite.mjs applies that to characters/roster.json.
"""
import argparse
import json
import re
import struct
import zlib
from pathlib import Path

GAMES = {
    "v25": Path("E:/SteamLibrary/steamapps/common/Cyberpunk 2077"),
    "v231": Path("E:/SteamLibrary/Cyberpunk2077-2.31"),
}
FILES = (("base", "tweakdb.bin"), ("ep1", "tweakdb_ep1.bin"))
ROOT = Path(__file__).resolve().parents[2]
# The tweak sources of game 2.5 (the REDmod copies of the game's own database, base and Phantom Liberty): the record flag isChild, which the game's
# IsCharacterChildren() reads and which the mod's talk and companion rules already refuse, resolved through the parent chain.
SOURCES = {"base": GAMES["v25"] / "tools/redmod/tweaks/base", "ep1": GAMES["v25"] / "tools/redmod/tweaks/ep1"}
HEADER = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_.]*)\s*$")
CHILD = re.compile(r"^\s*(?:bool\s+)?isChild\s*=\s*(true|false)", re.M)


def child_flags() -> dict:
    """record name (no 'Character.') -> (parent, own isChild or None)."""
    records = {}
    for root in SOURCES.values():
        for path in root.rglob("*.tweak"):
            text = path.read_text(encoding="utf-8-sig", errors="replace")
            if not re.search(r"^package\s+Character\b", text, re.M):
                continue
            lines, i = text.splitlines(), 0
            while i < len(lines):
                match = HEADER.match(lines[i])
                if match and i + 1 < len(lines) and lines[i + 1].strip() == "{":
                    j = i + 2
                    while j < len(lines) and lines[j] != "}":
                        j += 1
                    flag = CHILD.search("\n".join(lines[i + 2:j]))
                    records[match.group(1)] = (match.group(2).replace("Character.", ""), None if not flag else flag.group(1) == "true")
                    i = j
                i += 1
    return records


def is_child(records: dict, name: str) -> bool:
    for _ in range(40):
        if name not in records:
            return False
        parent, own = records[name]
        if own is not None:
            return own
        name = parent
    return False


def tdb_id(name: str) -> bytes:
    raw = name.encode("ascii")
    return struct.pack("<IB", zlib.crc32(raw) & 0xFFFFFFFF, len(raw))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(ROOT / "scripts/cast-sweep/side-invite-records.json"))
    args = parser.parse_args()
    data = {version: {label: (folder / "r6/cache" / file).read_bytes() for label, file in FILES} for version, folder in GAMES.items()}
    roster = [row for row in json.loads((ROOT / "characters/roster.json").read_text(encoding="utf-8-sig")) if row.get("minor") is True]

    def where(version: str, name: str):
        needle = tdb_id(name)
        for label, _ in FILES:
            if needle in data[version][label]:
                return label
        return None

    flags = child_flags()
    rows = {}
    for row in roster:
        records = [r for r in row["records"] if isinstance(r, str) and r.isascii()]
        entry = {"record": row["records"][0], "records": row["records"],
                 "isChild": any(is_child(flags, r.replace("Character.", "")) for r in row["records"])}
        for version in GAMES:
            found = {record: where(version, record) for record in records}
            entry[version] = found.get(row["records"][0])
            entry[version + "Template"] = where(version, row["records"][0] + ".entityTemplatePath")
            entry[version + "Others"] = {record: label for record, label in found.items() if record != row["records"][0] and label}
        rows[row["key"]] = entry
    out = {"games": {version: str(folder) for version, folder in GAMES.items()}, "rows": rows}
    Path(args.out).write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    both = [k for k, e in rows.items() if e["v25"] and e["v231"] and e["v25Template"] and e["v231Template"]]
    print(json.dumps({"rows": len(rows), "spawnInBoth": len(both),
                      "only25": sum(1 for e in rows.values() if e["v25"] and not e["v231"]),
                      "only231": sum(1 for e in rows.values() if e["v231"] and not e["v25"]),
                      "neither": sum(1 for e in rows.values() if not e["v25"] and not e["v231"]),
                      "isChild": sum(1 for e in rows.values() if e["isChild"]),
                      "recordNoTemplate": sum(1 for e in rows.values() if (e["v25"] and not e["v25Template"]) or (e["v231"] and not e["v231Template"]))}))


if __name__ == "__main__":
    main()
