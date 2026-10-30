"""Merge the person-check outputs (staging/cast-sweep/person-check-out-*.json) and report gaps.

    python scripts/cast-sweep/person-check-merge.py

Writes staging/cast-sweep/persons.json: {pair id: {name, gender, guess, role}} for the pairs judged to be named individuals.
Prints which input ids have no verdict (to be re-run).
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

base = Path("staging/cast-sweep")
wanted = []
for part in (1, 2):
    for line in (base / f"person-check-in-{part}.txt").read_text(encoding="utf-8").splitlines():
        wanted.append(int(line.split(" | ")[0]))
got = {}
for path in sorted(base.glob("person-check-out-*.json")):
    for row in json.loads(path.read_text(encoding="utf-8")):
        got[row["id"]] = row
missing = [i for i in wanted if i not in got]
persons = {str(i): {k: row.get(k) for k in ("name", "gender", "guess", "role")} for i, row in got.items() if row.get("person")}
(base / "persons.json").write_text(json.dumps(persons, ensure_ascii=False, indent=0), encoding="utf-8")
print(f"inputs {len(wanted)}  verdicts {len(got)}  persons {len(persons)}  missing {len(missing)}")
if missing:
    print("missing ids:", missing[:5], "...", missing[-5:])
    todo = base / "person-check-in-rest.txt"
    allin = {}
    for part in (1, 2):
        for line in (base / f"person-check-in-{part}.txt").read_text(encoding="utf-8").splitlines():
            allin[int(line.split(" | ")[0])] = line
    todo.write_text("\n".join(allin[i] for i in missing), encoding="utf-8")
    print("wrote", todo)
