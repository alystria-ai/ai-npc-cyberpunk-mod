"""Step 3b of the cast sweep: apply scripts/cast-sweep/decisions.json to staging/cast-sweep/people.json.

    python scripts/cast-sweep/finalize.py

Writes staging/cast-sweep/final-people.json (the people who get a profile) and staging/cast-sweep/dropped.json (who was left out
and why).  Ambiguous single names: a one-word name that is also the first word of another new or roster name is dropped.
"""
from __future__ import annotations

import json
import re
import sys
import unicodedata
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
base = Path("staging/cast-sweep")
people = json.loads((base / "people.json").read_text(encoding="utf-8"))
roster = json.loads((repo / "characters/roster.json").read_text(encoding="utf-8-sig"))
dec = json.loads((repo / "scripts/cast-sweep/decisions.json").read_text(encoding="utf-8"))


def norm(t):
    t = unicodedata.normalize("NFKD", t or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9 ]+", " ", t).split()


by_name = {p["name"]: p for p in people}
dropped = []
excl = {}
for section in ("excludeReal", "excludePlaceholder", "excludeAddon", "dropAsRosterDuplicate"):
    for n in dec[section]["names"]:
        excl[n] = dec[section]["reason"].split(".")[0]
for src, dst in dec["mergeInto"].items():
    if src == "reason":
        continue
    a, b = by_name.get(src), by_name.get(dst)
    if a and b:
        for r in a["records"]:
            if r not in b["records"]:
                b["records"].append(r)
        excl[src] = f"merged into {dst}"
# ambiguous single names
first_words = {}
for p in people:
    t = norm(p["name"])
    if len(t) >= 2:
        first_words.setdefault(t[0], []).append(p["name"])
        first_words.setdefault(t[-1], []).append(p["name"])
for r in roster:
    t = norm(r["name"])
    for w in {t[0], t[-1]}:
        first_words.setdefault(w, []).append(r["name"])
out = []
for p in people:
    if p["name"] in excl:
        dropped.append({"name": p["name"], "records": p["records"][:3], "why": excl[p["name"]]})
        continue
    t = norm(p["name"])
    if len(t) == 1 and t[0] in first_words:
        dropped.append({"name": p["name"], "records": p["records"][:3], "why": "ambiguous single name (also the first or last name of: " + ", ".join(first_words[t[0]][:3]) + ")"})
        continue
    out.append(p)
# a record may belong to one profile only
seen = {}
for p in out:
    p["records"] = [r for r in p["records"] if seen.setdefault(r, p["key"]) == p["key"]]
roster_records = {re.sub(r"^NCA\.", "", r).replace("Character.", "").lower() for row in roster for r in row.get("records", [])}
for p in out:
    p["records"] = [r for r in p["records"] if r.lower() not in roster_records]
(base / "final-people.json").write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
(base / "dropped.json").write_text(json.dumps(dropped, ensure_ascii=False, indent=1), encoding="utf-8")
print(f"people {len(people)}  kept {len(out)}  dropped {len(dropped)}")
from collections import Counter
print(Counter(d["why"].split(" (")[0].split(" into")[0] for d in dropped))
