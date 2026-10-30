"""Step 5b of the cast sweep: write the card-writer input, one file per agent.

    python scripts/cast-sweep/agent-batches.py [--parts 6] [--only key1,key2] [--prefix batch]

Each staging/cast-sweep/<prefix>-N.json is a list of {key, name, gender, role, affiliations, display, records, source files,
wiki: {title, infobox, text | mentions}, heard: [up to 5 of the person's own lines, tone only]} for people with no card yet.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "clip-search" / "cast-expansion"))
base = Path("staging/cast-sweep")
ap = argparse.ArgumentParser()
ap.add_argument("--parts", type=int, default=6)
ap.add_argument("--only", default="")
ap.add_argument("--prefix", default="batch")
args = ap.parse_args()
people = json.loads((base / "final-people.json").read_text(encoding="utf-8"))
wiki = json.loads((base / "wiki.json").read_text(encoding="utf-8"))
voices = json.loads((base / "voices.json").read_text(encoding="utf-8")) if (base / "voices.json").exists() else {}
cards = {p.stem for p in (base / "cards").glob("*.json")} | set(done_keys) if False else {p.stem for p in (base / "cards").glob("*.json")}
only = set(args.only.split(",")) if args.only else None
todo = [p for p in people if p["key"] not in cards and p["key"] in wiki and (not only or p["key"] in only)]

heard = {}
if voices:
    from cx_common import Subtitles, parse_wem, wem_lists, words
    subs = Subtitles()
    stems = {v["stem"]: k for k, v in voices.items()}
    want = {}
    for label, lines in wem_lists().items():
        for path in lines:
            parsed = parse_wem(path)
            if parsed and parsed[0] == "vo" and parsed[1].lower() in stems:
                want.setdefault(stems[parsed[1].lower()], {})[parsed[3]] = parsed[2]
    for key, ids in want.items():
        texts = []
        for sid, variant in ids.items():
            t = subs.text(sid, variant)
            if 6 <= words(t) <= 28 and not re.search(r"[\[\]<>*]", t):
                texts.append(t)
        heard[key] = texts[:5]

rows = []
for p in todo:
    w = wiki.get(p["key"], {})
    entry = {"key": p["key"], "name": p["name"], "gender": p["gender"], "genderIsGuess": p["genderGuess"], "role": p["role"],
             "affiliations": p["affiliations"], "displayNames": p["display"], "fullNames": p["full"], "records": p["records"][:4],
             "sourceFiles": [f.split("/")[-1] for f in p["files"][:3]], "pack": "+".join(p["packs"])}
    if w.get("title"):
        entry["wiki"] = {"page": w["title"], "infobox": w["infobox"], "text": w["text"][:1700]}
    elif w.get("mentions"):
        entry["wikiMentions"] = [m["page"] for m in w["mentions"]]
    if p["key"] in heard and heard[p["key"]]:
        entry["heardLines"] = heard[p["key"]]
    rows.append(entry)
size = -(-len(rows) // args.parts)
for i in range(args.parts):
    part = rows[i * size:(i + 1) * size]
    if part:
        (base / f"{args.prefix}-{i + 1}.json").write_text(json.dumps(part, ensure_ascii=False, indent=1), encoding="utf-8")
        print(f"{args.prefix}-{i + 1}.json: {len(part)} people, {sum(1 for r in part if 'wiki' in r)} with a wiki page")
