"""Step 4a (second rule) of the cast sweep: which English voice files are a minor character's own, beyond a name that starts the file stem.

    python scripts/cast-sweep/voice_links.py [--records staging/cast-sweep/records.json] [--out staging/cast-sweep/voice-links.json]
                                             [--stems-out staging/cast-sweep/stems-new.json] [--scenes staging/cast-sweep/scene-speakers.json]

A voice file stem is `<voice tag>_<group>` (`nika_yankovich_sts_ep1_01`, `fredrik_sts_wat_nid_04`, `sasquatch_q110`).  The voice tag selects the voice, so every
file with the same tag is the same voice.  The question is which person a tag belongs to.  A tag counts as a person's own only on evidence:

  voiceTag  the character record names the tag itself (`voiceTag` of the record or its parents, from the game's own tweak sources).  Strongest.
  name      the tag spells the person's full name (first_last, last_first, every word, a one letter slip in the first name).
  record    the tag is exactly the record's own name (`sts_wat_nid_04_fredrik` -> `fredrik`, or a bare record like `Character.Scorpion`) AND a file of that tag
            carries the record's quest group (`fredrik_sts_wat_nid_04`) or, for a bare record, the record name is the tag.
  scene     a cached scene export shows an actor with the person's first record speaking a line of that tag.

and is dropped when
  * the tag is generic (a civilian, gang, police, security or merc voice model, a crowd, a vendor, an ad, V, an organisation voice, a quest label)
    or only a role (barman, bouncer, boss, ripperdoc, assassin, narrator, ...),
  * another roster person (main or minor) has a claim of the same or higher strength on the same tag, or a main character is named by that one word,
  * a cached scene export shows another named person's record speaking a line of that tag.
Only plain `vo` files count (never vo_holocall, vo_helmet, vo_radio).  The result has the shape voices.py reads (`--stems`): {key: [{stem, how, lines, archives}]}.
Nothing in the game folders is written.
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
REPO = HERE.parents[1]
sys.path.insert(0, str(HERE.parents[0] / "clip-search" / "cast-expansion"))
from cx_common import MAIN, SCENE_EVIDENCE, parse_wem, wem_lists  # noqa: E402

TITLES = {"dr", "lt", "cpl", "capt", "captain", "officer", "mayor", "deputy", "prof", "agent", "lieutenant", "detective", "det", "the", "old", "big", "mr", "mrs", "sgt", "reverend"}
# A voice model shared by many ordinary people, a crowd, or something that is not a person.
GENERIC_FIRST = {"civ", "gang", "ncpd", "sec", "merc", "ad", "crowd", "bark", "v", "vendor", "npc", "cyberpsycho", "ow", "vs", "trauma", "arasaka", "militech", "kang", "tyger",
                 "maelstrom", "voodoo", "animals", "valentinos", "sixth", "scavengers", "wraiths", "moxes", "aldecaldos", "barghest", "ma", "std", "cct", "aldecaldo"}
ROLE_WORDS = {"barman", "bartender", "bouncer", "boss", "ripperdoc", "ripdoc", "assassin", "narrator", "paramedic", "receptionist", "guard", "driver", "cop", "officer", "vendor",
              "doctor", "nurse", "soldier", "pilot", "captive", "bard", "merchant", "clerk", "waiter", "gunsmith", "dealer", "seller", "customer", "patient", "ai", "media", "radio",
              "news", "announcer", "gangster", "thug", "goon", "victim", "passerby", "civilian", "citizen", "agent", "prophet", "sergeant", "security", "girl", "boy", "man", "woman",
              "male", "female", "kid", "hologram", "voice", "interface", "default", "test", "scene", "chip", "loading", "screen", "taxi", "shopkeeper", "owner", "worker"}
# The first word of the part of a stem after the voice tag: a quest or street story group, or one of the project's voice set groups.
GROUP_START = re.compile(r"^(?:(?:q|sq|mq)\d{3}[a-z]?|sts|ep1|ma|mws|wat|ow|vs|vset|vsets|quest|default|defaults|chip|little|big|news|n\d+|japantown|kabuki|cct|std|scene|finalboards|inland|coastview)$")
SKIP_STEM = re.compile(r"radio|media|news|tv_|_ad_|loading_screen|infoflash|chip_in|holocall|phone|call|broadcast|segment|helmet|crowd|bark|combat", re.I)


def words_of(text: str) -> list[str]:
    text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower().replace("'", "")
    return [t for t in re.sub(r"[^a-z0-9]+", " ", text).split() if t]


def name_words(name: str) -> tuple[list[str], list[str]]:
    """(words of the name without nicknames in quotes, nickname words)."""
    nick = [w for m in re.findall(r'"([^"]*)"', name) for w in words_of(m)]
    return words_of(re.sub(r'"[^"]*"', " ", name)), nick


def tag_of(stem: str) -> tuple[str, str]:
    """(voice tag, group) of a stem: the group starts at the first word after the first that looks like a quest, street story or voice set group."""
    parts = stem.split("_")
    for i, word in enumerate(parts):
        if i > 0 and GROUP_START.match(word):
            return "_".join(parts[:i]), "_".join(parts[i:])
    return stem, ""


def is_generic(tag: str) -> str | None:
    parts = tag.split("_")
    if parts[0] in GENERIC_FIRST or GROUP_START.match(parts[0]):
        return "generic voice model"
    if any(p in ROLE_WORDS for p in parts):
        return "role tag"
    if re.search(r"\d", tag):
        return "numbered voice model"
    return None


def record_group(record: str) -> tuple[str | None, str]:
    """(group, tail) of a record name: `q110_animals_boss` -> (q110, animals_boss); `sts_wat_nid_04_fredrik` -> (sts_wat_nid_04, fredrik); `Scorpion` -> (None, scorpion)."""
    rec = record.replace("Character.", "").lower()
    match = re.match(r"^((?:q|sq|mq)\d{3})_(.+)$", rec) or re.match(r"^(sts_[a-z0-9]+(?:_[a-z0-9]+)*?_\d\d)_(.+)$", rec) or re.match(r"^((?:ma|mws|wat|nid|cz|pac|cbj|gts)_[a-z0-9_]*?\d\d)_(.+)$", rec)
    if match:
        return match.group(1), match.group(2)
    return None, rec


def slip(a: str, b: str) -> bool:
    """One letter apart (an insertion, deletion or replacement) with the same first letter: `micheal` against `michael`."""
    if a == b or a[:1] != b[:1] or abs(len(a) - len(b)) > 1 or len(a) < 5:
        return False
    if len(a) == len(b):
        diff = [i for i in range(len(a)) if a[i] != b[i]]
        return len(diff) == 1 or (len(diff) == 2 and diff[1] == diff[0] + 1 and a[diff[0]] == b[diff[1]] and a[diff[1]] == b[diff[0]])
    short, long = (a, b) if len(a) < len(b) else (b, a)
    return any(long[:i] + long[i + 1:] == short for i in range(len(long)))


class Index:
    """The plain `vo` stems of the installed voice file listings."""

    def __init__(self):
        self.stems: dict[str, dict] = {}
        self.by_id: dict[str, str] = {}
        for label, lines in wem_lists().items():
            for path in lines:
                parsed = parse_wem(path)
                if not parsed or parsed[0] != "vo":
                    continue
                stem = parsed[1].lower()
                row = self.stems.setdefault(stem, {"lines": set(), "labels": set()})
                row["lines"].add(parsed[3])
                row["labels"].add(label)
                self.by_id.setdefault(parsed[3], stem)

    def matching(self, tag: str, name_like: bool) -> list[str]:
        out = []
        for stem in self.stems:
            if stem == tag or stem.startswith(tag + "_"):
                rest = stem[len(tag) + 1:]
                if name_like or not rest or GROUP_START.match(rest.split("_")[0]):
                    out.append(stem)
        return out


def scene_speakers(cache: Path | None, index: Index) -> dict:
    """tag -> {records: {record: lines}} from the cached scene exports (research/cyberpunk/cache/game/scene-evidence): which records speak the lines of each voice tag."""
    if cache and cache.is_file():
        return json.loads(cache.read_text(encoding="utf-8"))
    best: dict[str, Path] = {}
    for path in SCENE_EVIDENCE.rglob("*.scene.json"):
        parts = path.relative_to(SCENE_EVIDENCE).parts
        sub = list(parts[parts.index("raw") + 1:])
        if len(sub) > 1 and sub[0] in ("base", "ep1") and sub[1] in ("base", "ep1"):
            sub = sub[1:]
        depot = "\\".join(sub)[:-5].lower()
        if depot not in best or path.stat().st_mtime > best[depot].stat().st_mtime:
            best[depot] = path
    result: dict[str, dict] = {}
    for path in best.values():
        root = json.loads(path.read_text("utf-8-sig"))["Data"]["RootChunk"]
        recs: dict[int, set] = {}
        for actor in root.get("actors", []):
            found = set()
            for node in (actor.get("spawnDespawnParams"), actor.get("findActorInContextParams"), actor):
                value = (((node or {}).get("specRecordId") or (node or {}).get("specCharacterRecordId") or {}).get("$value")) if isinstance(node, dict) else None
                if value and value != "0":
                    found.add(value.replace("Character.", "").lower())
            recs[actor["actorId"]["id"]] = found
        for line in ((root.get("screenplayStore") or {}).get("lines")) or []:
            stem = index.by_id.get(str((line.get("locstringId") or {}).get("ruid")))
            if not stem:
                continue
            tag = tag_of(stem)[0]
            for record in recs.get((line.get("speaker") or {}).get("id"), ()):
                row = result.setdefault(tag, {"records": {}})
                row["records"][record] = row["records"].get(record, 0) + 1
    if cache:
        cache.parent.mkdir(parents=True, exist_ok=True)
        cache.write_text(json.dumps(result, ensure_ascii=False, indent=0), encoding="utf-8")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--records", default="staging/cast-sweep/records.json", help="output of inventory.py (record, displayName, voiceTag)")
    parser.add_argument("--out", default="staging/cast-sweep/voice-links.json")
    parser.add_argument("--stems-out", default="staging/cast-sweep/stems-new.json")
    parser.add_argument("--scenes", default="staging/cast-sweep/scene-speakers.json")
    args = parser.parse_args()
    roster = json.loads((REPO / "characters/roster.json").read_text(encoding="utf-8-sig"))
    sweep = json.loads((REPO / "characters/cast-sweep-voices.json").read_text(encoding="utf-8"))["characters"]
    records = {r["record"].lower(): r for r in json.loads(Path(args.records).read_text(encoding="utf-8"))}
    index = Index()
    speakers = scene_speakers(Path(args.scenes), index)
    all_tags = {tag_of(stem)[0] for stem in index.stems}
    by_key = {row["key"]: row for row in roster}
    # every name the game gives a record: the short name on screen (displayName) and the full one
    display_of = {rec: {" ".join(words_of(info[field])) for field in ("display", "full") if info.get(field)} for rec, info in records.items()}
    display_of = {rec: names for rec, names in display_of.items() if names}
    word_displays: dict[str, set] = defaultdict(set)         # a word of a record's own name -> every name a record with that word carries
    for rec, names in display_of.items():
        tail = record_group(rec)[1]
        word_displays[tail] |= names
        for part in tail.split("_"):
            word_displays[part] |= names
    voice_tag_owners: dict[str, dict] = defaultdict(dict)    # an explicit voiceTag of any record -> {record: its names}
    for rec, info in records.items():
        if info.get("voiceTag") and rec in display_of:
            voice_tag_owners[info["voiceTag"].lower()][rec] = display_of[rec]

    def same_person(names: set, shown: str) -> bool:
        """Every name is the person's own, or a word-wise part of it (`jotaro` for `jotaro shobo`, `mausser` for `jack mausser`), or it only adds a job title (`leslie wawuda orbital air ceo`)."""
        return all(n == shown or n in shown.split() or shown.startswith(n + " ") or shown.endswith(" " + n) or n.startswith(shown + " ") for n in names)

    def claims_of(row: dict) -> list[tuple]:
        """(tag, strength, how, detail, group the files must carry or None) for one roster row."""
        out = []
        full, _nick = name_words(row["name"])
        plain = [w for w in full if w not in TITLES]
        for words in (full, plain):
            if len(words) >= 2:
                for tag in ("_".join(words), f"{words[0]}_{words[-1]}", f"{words[-1]}_{words[0]}"):
                    out.append((tag, 3, "name", row["name"], None))
        if len(plain) >= 2:                                               # a slip in the first word (micheal_maldonado)
            for tag in all_tags:
                parts = tag.split("_")
                if len(parts) == len(plain) and parts[1:] == plain[1:] and slip(parts[0], plain[0]):
                    out.append((tag, 3, "name", f"first word spelt {parts[0]} in the files", None))
        for record in row.get("records", []):
            info = records.get(record.replace("Character.", "").lower()) or {}
            if info.get("voiceTag"):
                out.append((info["voiceTag"].lower(), 3, "voiceTag", record, None))
            group, tail = record_group(record)
            tail_tag = "_".join(t for t in tail.split("_") if t)
            if len(tail_tag) >= 4:
                out.append((tail_tag, 2, "record", record, group))
            screen = "_".join(words_of(info.get("display") or ""))      # the short name the game shows for the record, e.g. Taylor, Dorian
            if screen and group and len(screen) >= 4 and screen != tail_tag:
                out.append((screen, 2, "display+group", record, group))
        return out

    held_back: list[dict] = []                               # scene-proven to the person but spoken with a generic voice model: left out on purpose
    live: dict[str, dict[str, list]] = defaultdict(dict)     # tag -> key -> [strength, {how}, [detail]] of the claims that hold
    notes: dict[tuple, str] = {}
    for row in roster:
        key = row["key"]
        shown = " ".join(words_of(row["name"]))
        for tag, strength, how, detail, group in claims_of(row):
            if is_generic(tag):
                notes[(key, tag)] = is_generic(tag)
                continue
            stems = index.matching(tag, how in ("name", "voiceTag"))
            if not stems:
                continue
            if group and not any(re.search(r"(?:^|_)" + re.escape(group) + r"(?:_|$)", tag_of(s)[1]) for s in stems):
                # the quest group is not on a file of the tag: a record's own name still counts when no other named record carries that word
                if how == "record" and len(tag) >= 4 and tag in word_displays and same_person(word_displays[tag], shown):
                    how, detail = "record-unique", detail + " (no other named record has the word)"
                else:
                    notes[(key, tag)] = "the record's quest group is not on any file of the tag"
                    continue
            elif how == "record" and not group:
                detail += " (bare record)"
            row_live = live[tag].setdefault(key, [0, set(), []])
            row_live[0] = max(row_live[0], strength)
            row_live[1].add(how)
            row_live[2].append(detail)
        first = (row.get("records") or [""])[0].replace("Character.", "").lower()
        for tag, info in speakers.items():
            if first and first in info["records"] and is_generic(tag) and not row.get("records", [""])[0] == "":
                held_back.append({"key": key, "tag": tag, "reason": is_generic(tag), "record": first, "lines": info["records"][first]})
            if first and first in info["records"] and not is_generic(tag) and index.matching(tag, False):
                row_live = live[tag].setdefault(key, [0, set(), []])
                row_live[0] = max(row_live[0], 2)
                row_live[1].add("scene")
                row_live[2].append(f"{first} speaks {info['records'][first]} line(s) of it")

    # a person named by one word, or a main character's first name, blocks that word as somebody else's tag
    blockers: dict[str, set] = defaultdict(set)
    for row in roster:
        plain = [w for w in name_words(row["name"])[0] if w not in TITLES]
        if len(plain) == 1 or (plain and not row.get("minor")):
            blockers[plain[0]].add(row["key"])

    accepted: dict[str, dict] = {}
    rejected: list[dict] = []
    stem_tags = {tag_of(s)[0] for s in index.stems}
    for row in roster:
        key = row["key"]
        if not row.get("minor") or (sweep.get(key) or {}).get("clip"):
            continue
        for (k, tag), reason in sorted(notes.items()):
            if k == key and tag in stem_tags:
                rejected.append({"key": key, "tag": tag, "reason": reason})
        best = None
        for tag, owners in sorted(live.items()):
            if key not in owners:
                continue
            strength, hows, details = owners[key]
            hows = sorted(hows)
            rivals = sorted(k for k, (s, *_rest) in owners.items() if k != key and s >= strength)
            blocked = sorted(k for k in blockers.get(tag, ()) if k != key and "voiceTag" not in hows)
            if rivals or blocked:
                rejected.append({"key": key, "tag": tag, "reason": "shared tag", "rivals": rivals + blocked, "how": hows})
                continue
            mine = {r.replace("Character.", "").lower() for r in row.get("records", [])}
            others = {rec: n for rec, n in (speakers.get(tag) or {}).get("records", {}).items() if rec not in mine}
            shown = " ".join(words_of(row["name"]))
            named_others = {rec: n for rec, n in others.items() if display_of.get(rec) and not same_person(display_of[rec], shown)}
            owners = {rec: names for rec, names in voice_tag_owners.get(tag, {}).items() if rec not in mine and not same_person(names, shown)}
            if owners:
                rejected.append({"key": key, "tag": tag, "reason": "another record names it as its voiceTag", "owners": sorted(owners), "how": hows})
                continue
            if named_others:
                rejected.append({"key": key, "tag": tag, "reason": "a scene shows another named record speaking it", "others": named_others, "how": hows})
                continue
            stems = index.matching(tag, bool({"name", "voiceTag"} & set(hows)))
            usable = [s for s in stems if not SKIP_STEM.search(s)]
            if not usable:
                rejected.append({"key": key, "tag": tag, "reason": "only radio, news, call or chip stems", "how": hows})
                continue
            candidate = {"tag": tag, "strength": strength, "how": hows, "detail": details[:3], "stems": usable, "lines": sum(len(index.stems[s]["lines"]) for s in usable)}
            if best is None or (candidate["strength"], candidate["lines"]) > (best["strength"], best["lines"]):
                best = candidate
        if best:
            accepted[key] = best
    stems_out = {key: [{"stem": s, "how": b["how"][0], "lines": len(index.stems[s]["lines"]), "archives": sorted(index.stems[s]["labels"])} for s in b["stems"]] for key, b in accepted.items()}
    Path(args.stems_out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.stems_out).write_text(json.dumps(stems_out, ensure_ascii=False, indent=1), encoding="utf-8")
    Path(args.out).write_text(json.dumps({"accepted": accepted, "rejected": rejected, "heldBack": [h for h in held_back if h["key"] in {r["key"] for r in roster if r.get("minor")}]}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"accepted {len(accepted)}  rejected {len(rejected)}  held back (scene-proven, generic voice model) {len({h['key'] for h in held_back if by_key[h['key']].get('minor')})}")
    for key, b in sorted(accepted.items()):
        print(f"  {key}: tag {b['tag']} {b['how']} {b['lines']} lines {b['detail'][:1]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
