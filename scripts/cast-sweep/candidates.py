"""Step 2 of the cast sweep: group the inventory's records by display name and drop what the roster already covers.

    python scripts/cast-sweep/candidates.py [--records staging/cast-sweep/records.json] [--out staging/cast-sweep/pairs.json]

A "pair" is one (display name, full display name) combination with every record that carries it.  A pair is covered when a
roster profile already names one of its records (characters/roster.json `records`, the NCA clone prefix ignored) or has the
same full name, name or alias.  The remaining pairs go to the person check (is this a named individual or a role label?).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import OrderedDict
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]


def norm(text: str) -> str:
    text = re.sub(r"[^a-z0-9 ]+", " ", (text or "").lower().replace("é", "e").replace("ó", "o"))
    return re.sub(r"\s+", " ", text).strip()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--records", default="staging/cast-sweep/records.json")
    ap.add_argument("--out", default="staging/cast-sweep/pairs.json")
    args = ap.parse_args()
    records = json.loads(Path(args.records).read_text(encoding="utf-8"))
    roster = json.loads((REPO / "characters/roster.json").read_text(encoding="utf-8-sig"))
    covered_records = {re.sub(r"^NCA\.", "", r).replace("Character.", "").lower() for row in roster for r in row.get("records", [])}
    covered_names = set()
    for row in roster:
        for text in [row.get("name", ""), *row.get("aliases", [])]:
            covered_names.add(norm(text))
    pairs: "OrderedDict[tuple, dict]" = OrderedDict()
    for rec in records:
        if not rec["display"]:
            continue
        key = (rec["display"], rec["full"] or "")
        entry = pairs.setdefault(key, {"display": rec["display"], "full": rec["full"] or "", "records": [], "covered": False})
        entry["records"].append({k: rec[k] for k in ("record", "parent", "pack", "file", "affiliation", "template", "voiceTag", "displayOwn")})
        if rec["record"].lower() in covered_records:
            entry["covered"] = True
    out = []
    for entry in pairs.values():
        if norm(entry["full"]) in covered_names or (not entry["full"] and norm(entry["display"]) in covered_names and any(
                norm(r["record"]) in {norm(x) for x in covered_records} for r in entry["records"])):
            entry["covered"] = True
        out.append(entry)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False), encoding="utf-8")
    print(f"pairs: {len(out)}  covered by the roster: {sum(1 for e in out if e['covered'])}  to check: {sum(1 for e in out if not e['covered'])}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
