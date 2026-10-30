"""Step 3 of the cast sweep: one entry per named individual.

    python scripts/cast-sweep/group.py

Reads staging/cast-sweep/pairs.json and persons.json, merges pairs with the same canonical name, drops names the roster
already has, and writes staging/cast-sweep/people.json (key, name, gender, role, records, ...) plus people-review.txt
listing name collisions (the same first name carried by pairs with different full names, kept apart).
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

base = Path("staging/cast-sweep")
repo = Path(__file__).resolve().parents[2]


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]+", " ", text.lower())).strip()


def slug(text: str) -> str:
    return norm(text).replace(" ", "-")


pairs = json.loads((base / "pairs.json").read_text(encoding="utf-8"))
persons = json.loads((base / "persons.json").read_text(encoding="utf-8"))
roster = json.loads((repo / "characters/roster.json").read_text(encoding="utf-8-sig"))
have_names = {}
for row in roster:
    for text in [row["name"], *row.get("aliases", [])]:
        have_names[norm(text)] = row["key"]
have_records = {re.sub(r"^NCA\.", "", r).replace("Character.", "").lower() for row in roster for r in row.get("records", [])}

groups: dict[str, dict] = {}
for pid, info in persons.items():
    pair = pairs[int(pid)]
    name = info["name"].strip()
    k = norm(name)
    g = groups.setdefault(k, {"name": name, "gender": info["gender"], "guess": bool(info.get("guess")), "role": info.get("role") or "",
                              "display": set(), "full": set(), "records": [], "affiliations": set(), "voiceTags": set()})
    g["display"].add(pair["display"])
    if pair["full"]:
        g["full"].add(pair["full"])
    for rec in pair["records"]:
        if rec["record"] not in [r["record"] for r in g["records"]]:
            g["records"].append(rec)
        if rec["affiliation"]:
            g["affiliations"].add(rec["affiliation"].replace("Factions.", ""))
        if rec["voiceTag"]:
            g["voiceTags"].add(rec["voiceTag"])
    if not g["role"] and info.get("role"):
        g["role"] = info["role"]

people, covered, review = [], [], []
for k, g in sorted(groups.items()):
    in_roster = k in have_names or any(r["record"].lower() in have_records for r in g["records"])
    row = {"key": slug(g["name"]), "name": g["name"], "gender": g["gender"], "genderGuess": g["guess"], "role": g["role"],
           "display": sorted(g["display"]), "full": sorted(g["full"]), "affiliations": sorted(g["affiliations"]),
           "voiceTags": sorted(g["voiceTags"]), "records": [r["record"] for r in g["records"]],
           "packs": sorted({r["pack"] for r in g["records"]}), "files": sorted({r["file"] for r in g["records"]})[:4],
           "templates": sorted({r["template"] for r in g["records"] if r["template"]})[:2]}
    (covered if in_roster else people).append(row)

# Single-word names shared by several people are only kept apart when the pairs had different full names; the keys must be unique.
seen = defaultdict(int)
for row in people:
    seen[row["key"]] += 1
dups = [k for k, n in seen.items() if n > 1]
(base / "people.json").write_text(json.dumps(people, ensure_ascii=False, indent=1), encoding="utf-8")
(base / "covered.json").write_text(json.dumps(covered, ensure_ascii=False, indent=1), encoding="utf-8")
first = defaultdict(list)
for row in people:
    first[norm(row["name"]).split(" ")[0]].append(row["name"])
(base / "people-review.txt").write_text("\n".join(f"{k}: {', '.join(v)}" for k, v in sorted(first.items()) if len(v) > 1), encoding="utf-8")
print(f"canonical names {len(groups)}  already on the roster {len(covered)}  new {len(people)}  duplicate keys {dups}")
print("genders:", {g: sum(1 for p in people if p['gender'] == g) for g in ('MALE', 'FEMALE')}, " guessed:", sum(p['genderGuess'] for p in people))
print("with a body record in a quest file (q/sq/mq prefix):", sum(1 for p in people if any(re.match(r'(q|sq|mq)\d', r) for r in p['records'])))
