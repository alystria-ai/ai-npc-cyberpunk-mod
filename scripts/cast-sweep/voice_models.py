"""Map every side character to the voice the game gives them (docs/CAST_SWEEP.md, "Voice models").

    python scripts/cast-sweep/voice_models.py --index <work>/scene-index.json [--out staging/cast-sweep/voice-models.json]
                                              [--stems-out staging/cast-sweep/stems-models.json] [--links-out staging/cast-sweep/voice-links-models.json]

Proof, in the game's own scene files (scene_index.py, every one of the 7580 scenes): a scene actor is spawned or found as a character record (`specRecordId`), and the lines it
speaks have a voice file (the locstring id is the hex in the file name), whose stem is `<voice tag>_<group>`.  So a record is tied to the voice of its lines.
Two kinds of proof, in this order:
  record     the actor carries the person's record.
  actor-name the person's record has no speaking actor, but an actor of a scene of the record's own quest or street story group (the scene path contains the record's group) is
             named exactly like the record (its tail, e.g. `archibald` for `sts_bls_ina_05_archibald`, or the whole record name), and no other person's record has that name.
For one side character (all the records of its roster row) the voices of those lines give the verdict:
  own        a single named voice tag (`fredrik`, `lizzies_boss`)  -> the character's own clip, cut (voices.py) only from the lines the scenes prove are this person's (when
             other people's records speak the same tag too, that is all it can use)
  model      a single generic voice model (`civ_high_m_07_enus_40`: civilians, gangs, police, security, mercs, shared by many people) -> the archetype voice of that model
  ambiguous  more than one voice -> not guessed
  none       no line at all -> still a guess (the archetype stand-in stays)
A person who already has an own clip keeps it.  Reads the index only.  No game folder is touched.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parents[0] / "clip-search" / "cast-expansion"))
from cx_common import parse_wem, wem_lists  # noqa: E402
from voice_links import is_generic, record_group, tag_of  # noqa: E402

# A generic voice model: <family>_<class>_<m|f>_<number>_<ethnicity>_<age>, the mercs have no class (merc_m_01_enus_30)
MODEL = re.compile(r"^([a-z]+_(?:[a-z0-9]+_)?[mf]_\d+_[a-z]+_\d+)(?:_|$)")
NO_VOICE_STEM = re.compile(r"holocall|radio|media|news|loading_screen|chip_in|broadcast|helmet|_ad_")


def voice_of_stem(stem: str) -> tuple[str, str]:
    """('model', 'civ_high_m_07_enus_40') or ('tag', 'fredrik')."""
    match = MODEL.match(stem)
    if match:
        return "model", match.group(1)
    return "tag", tag_of(stem)[0]


def stem_index() -> dict[str, str]:
    """locstring id (decimal text) -> stem of the plain `vo` file."""
    out: dict[str, str] = {}
    for _label, lines in wem_lists().items():
        for path in lines:
            parsed = parse_wem(path)
            if parsed and parsed[0] == "vo":
                out.setdefault(parsed[3], parsed[1].lower())
    return out


def norm(name: str | None) -> str:
    return re.sub(r"[^a-z0-9]+", "_", (name or "").lower()).strip("_")


def actor_voices(data: dict, stems: dict[str, str]):
    """(actorId -> Counter of (kind, value), actorId -> set of locstring ids) over the lines of one scene."""
    out: dict[str, Counter] = defaultdict(Counter)
    ids: dict[str, set] = defaultdict(set)
    for speaker, ruid in data["lines"]:
        stem = stems.get(ruid)
        if stem and not NO_VOICE_STEM.search(stem) and speaker in data["actors"]:
            out[speaker][voice_of_stem(stem)] += 1
            ids[speaker].add(ruid)
    return out, ids


def collect(index: dict, stems: dict[str, str]):
    """(record voices, record line ids, name voices): record -> Counter, record -> {ids}, normalized actor name -> [(scene, Counter, {ids})]."""
    by_record: dict[str, Counter] = defaultdict(Counter)
    rec_ids: dict[str, set] = defaultdict(set)
    by_name: dict[str, list] = defaultdict(list)
    for scene, data in index.items():
        if not data:
            continue
        voices, ids = actor_voices(data, stems)
        for aid, counter in voices.items():
            actor = data["actors"][aid]
            for record in actor["recs"]:
                low = record.replace("Character.", "").lower()
                by_record[low] += counter
                rec_ids[low] |= ids[aid]
            names = {norm(actor.get(field)) for field in ("name", "entry", "spawn")} - {"", "none"}
            for name in names:
                by_name[name].append((scene.lower().replace("\\", "_"), counter, ids[aid]))
    return by_record, rec_ids, by_name


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--index", required=True)
    parser.add_argument("--out", default="staging/cast-sweep/voice-models.json")
    parser.add_argument("--stems-out", default="staging/cast-sweep/stems-models.json")
    parser.add_argument("--links-out", default="staging/cast-sweep/voice-links-models.json")
    args = parser.parse_args()
    index = json.loads(Path(args.index).read_text(encoding="utf-8"))
    stems = stem_index()
    roster = json.loads((REPO / "characters/roster.json").read_text(encoding="utf-8-sig"))
    sweep = json.loads((REPO / "characters/cast-sweep-voices.json").read_text(encoding="utf-8"))["characters"]
    by_record, rec_ids, by_name = collect(index, stems)
    owners: dict[str, set] = defaultdict(set)               # record, or record tail -> roster rows that have it
    for row in roster:
        for record in row.get("records", []):
            low = record.replace("Character.", "").lower()
            owners[low].add(row["key"])
            owners[record_group(record)[1]].add(row["key"])
    speakers: dict[tuple, set] = defaultdict(set)           # voice -> records that speak it
    for record, counter in by_record.items():
        for voice in counter:
            speakers[voice].add(record)
    stem_files: dict[str, set] = defaultdict(set)           # tag -> stems (for the own clip)
    for stem in set(stems.values()):
        if not MODEL.match(stem):
            stem_files[tag_of(stem)[0]].add(stem)

    result, stems_out, links_out = {}, {}, {}
    for row in roster:
        if not row.get("minor"):
            continue
        key = row["key"]
        mine = [r.replace("Character.", "").lower() for r in row.get("records", [])]
        total: Counter = Counter()
        for record in mine:
            total += by_record.get(record, Counter())
        how, scenes, proven = "record", [], set()
        for record in mine:
            proven |= rec_ids.get(record, set())
        if not total:
            for record in row.get("records", []):
                group, tail = record_group(record)
                full = record.replace("Character.", "").lower()
                for name in {tail, full} - {""}:
                    if len(owners.get(name, ())) != 1 or len(name) < 4:
                        continue                              # another person has a record of that name: the name proves nothing
                    for scene, counter, ids in by_name.get(name, []):
                        if (group and group in scene) or full in scene:       # the scene belongs to the record's own quest or street story, or is named like the record
                            total += counter
                            scenes.append(scene)
                            proven |= ids
            how = "actor-name"
        entry = {"records": row.get("records", []), "how": how if total else None, "voices": [{"kind": k, "voice": v, "lines": n} for (k, v), n in total.most_common()]}
        if scenes:
            entry["scenes"] = sorted(set(scenes))[:5]
        if not total:
            entry["verdict"] = "none"
        elif len(total) > 1:
            entry["verdict"] = "ambiguous"
        else:
            (kind, value), lines = next(iter(total.items()))
            entry["lines"] = lines
            if kind == "model":
                entry["verdict"], entry["model"] = "model", value
            else:
                why = is_generic(value)
                others = sorted(r for r in speakers[(kind, value)] if r not in mine)
                if why == "generic voice model" or why == "numbered voice model":
                    entry["verdict"], entry["why"] = "generic-tag", why
                else:
                    entry["verdict"], entry["tag"] = "own", value
                    if others:                      # other people's records speak this tag too: only the lines the scenes prove to be this person's are used
                        entry["note"] = "shared tag, this person's own lines only"
                        entry["sharedWith"] = others[:6]
                    elif why:
                        entry["note"] = f"{why}, spoken only by this person's record"
        if (sweep.get(key) or {}).get("clip"):
            entry["hasClip"] = True
        elif entry["verdict"] == "own":
            tag = entry["tag"]
            ids = sorted(i for i in proven if stems.get(i) and not MODEL.match(stems[i]) and tag_of(stems[i])[0] == tag)
            by_stem: dict[str, list] = defaultdict(list)
            for i in ids:
                by_stem[stems[i]].append(i)
            stems_out[key] = [{"stem": s, "how": "scene", "lines": len(v), "archives": [], "ids": v} for s, v in sorted(by_stem.items())]
            entry["ids"] = len(ids)
            links_out.setdefault("accepted", {})[key] = {"tag": tag, "how": ["scene" if how == "record" else "scene-actor-name"]}
        result[key] = entry
    for path, value in ((args.out, result), (args.stems_out, stems_out), (args.links_out, links_out)):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=1), encoding="utf-8")
    fresh = {k: e for k, e in result.items() if not e.get("hasClip")}
    print("without a clip:", Counter(e["verdict"] for e in fresh.values()), " by proof:", Counter(e["how"] for e in fresh.values() if e["how"]))
    print("distinct models mapped:", len({e["model"] for e in fresh.values() if e["verdict"] == "model"}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
