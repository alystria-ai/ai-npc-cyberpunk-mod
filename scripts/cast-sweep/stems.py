"""Step 4a of the cast sweep: which English voice-file stems belong to which person (by name, never by voice tag alone).

    python scripts/cast-sweep/stems.py [--people staging/cast-sweep/people.json] [--out staging/cast-sweep/stems.json]

Uses the installed voice-file listings (runtime/voice-cast-inventory-20261001/{base,ep1}-wem-paths.txt, from lang_en_voice.archive).
Only the plain `vo` folder is used: `vo_holocall`, `vo_helmet` and `vo_radio` copies are processed (phone or radio) deliveries.

A stem `<actor>_<scene...>` is the person's when
  * a full name (`first_last`, or `last_first`) starts the stem, or
  * the person has a single-word name (or only a surname that is distinctive) and the stem starts with it AND carries a
    quest tag (q###, sq###, mq###, sts_...) that one of the person's records also carries.
The result lists, per person, the stems with the number of distinct lines and how the stem was matched ("name" or "quest").
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parents[0] / "clip-search" / "cast-expansion"))
from cx_common import parse_wem, wem_lists  # noqa: E402

TITLES = {"dr", "lt", "cpl", "capt", "captain", "officer", "mayor", "deputy", "prof", "reverend", "agent", "lieutenant", "detective", "det", "the", "old", "big", "mr"}


def tokens(name: str) -> list[str]:
    name = re.sub(r'"[^"]*"', " ", name)           # nicknames in quotes are separate
    name = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().lower()
    return [t for t in re.sub(r"[^a-z0-9 ]+", " ", name).split() if t]


def quest_tags(text: str) -> set[str]:
    text = re.sub(r"[^a-z0-9]+", "_", text.lower())
    return set(re.findall(r"(?:^|_)((?:q|sq|mq)\d{3})(?=_|$)", text))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--people", default="staging/cast-sweep/people.json")
    ap.add_argument("--out", default="staging/cast-sweep/stems.json")
    args = ap.parse_args()
    people = json.loads(Path(args.people).read_text(encoding="utf-8"))
    by_stem: dict[str, dict] = {}
    for label, lines in wem_lists().items():
        for path in lines:
            parsed = parse_wem(path)
            if not parsed or parsed[0] != "vo":
                continue
            stem = parsed[1].lower()
            row = by_stem.setdefault(stem, {"lines": set(), "labels": set()})
            row["lines"].add(parsed[3])
            row["labels"].add(label)
    first_index: dict[str, list[str]] = defaultdict(list)
    for stem in by_stem:
        first_index[stem.split("_")[0]].append(stem)
    out, matched = {}, 0
    for person in people:
        toks = [t for t in tokens(person["name"]) if t not in TITLES]
        if not toks:
            continue
        found: dict[str, str] = {}
        if len(toks) >= 2:
            for a, b in ((toks[0], toks[-1]), (toks[-1], toks[0])):
                pref = f"{a}_{b}"
                for stem in first_index.get(a, []):
                    if stem == pref or stem.startswith(pref + "_"):
                        found[stem] = "name"
        else:
            # single word: the stem starts with it and shares a quest tag with a record of the person
            rec_tags = set()
            for record in person["records"] + person.get("files", []):
                rec_tags |= quest_tags(record)
            for stem in first_index.get(toks[0], []):
                if stem == toks[0] and False:
                    continue
                if quest_tags(stem) & rec_tags:
                    found[stem] = "quest"
        # a surname-only stem for a person whose records name the surname is not accepted (too many shared surnames)
        if found:
            matched += 1
            out[person["key"]] = [{"stem": s, "how": h, "lines": len(by_stem[s]["lines"]), "archives": sorted(by_stem[s]["labels"])} for s, h in sorted(found.items())]
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"people {len(people)}  with at least one stem {matched}  ({sum(1 for v in out.values() if any(x['how']=='name' for x in v))} by name, "
          f"{sum(1 for v in out.values() if all(x['how']=='quest' for x in v))} by quest tag only)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
