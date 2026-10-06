"""Step 1: catalogue every English voice line of every voice with a runtime reference.

    python scripts/reference-pool/catalog.py

Reads (never writes): the voice archives' file listings, the localized subtitle tables (as extracted by WolvenKit into
WORK/_work/textjson), the training dataset manifests, the held-out evaluation sets and the picker's pool index.
Writes WORK/_work/catalog.json:

    {voice: {"tags": [...], "sceneLimited": bool, "entries": [{wem, dir, stem, hex, sid, fm, text, ...}]}}

How a voice line finds its character: the archive names a line <actor tag>_<scene>_<f|m>_<hex>.wem and the hex is the
subtitle string ID (the same ID the training dataset uses as the clip id).  The actor tags of a voice are learned from
the clips the dataset and the live references already attribute to it (those came from scene screenplay speakers), so
the new lines are exactly the other lines of the same voice-actor tag.  A few voices only have a generic crowd model tag
(civ_*, gang_*, ...) that many characters share; for those only the same scene stems are accepted ("sceneLimited").
"""
from __future__ import annotations

import collections
import json
import re
import sys

from common import *  # noqa

# Tags that belong to somebody else although they start with a voice's tag.
NOT_THIS_VOICE = {"bob": ["bob_sulberger"]}
# Lines whose file name says they are processed or are not speech to a person: kept in the catalogue, flagged.
EFFECT_NAME = re.compile(r"radio|media|growl|scream|shout|pain|death|combat|battle|attack|cyberpsycho|ad_[0-9]|_ad_|advert|commercial|jingle|tv_|news", re.I)


def listing(name: str, archive: Path) -> list[str]:
    cache = SRC / f"{name}.txt"
    if not cache.exists():
        raw = SRC / f"{name}-listing.raw"
        wolven(["archive", archive / "lang_en_voice.archive", "-l"], raw)
        lines = [l.strip() for l in raw.read_text(encoding="utf-8-sig", errors="replace").splitlines()]
        cache.write_text("\n".join(l for l in lines if l.endswith(".wem")), encoding="utf8")
    return cache.read_text(encoding="utf8").splitlines()


def subtitles() -> dict[str, list[str]]:
    cache = SRC / "subtitles.json"
    if cache.exists():
        return read_json(cache)
    table: dict[str, list[str]] = {}
    for path in sorted((SRC / "textjson").rglob("*.json")):
        try:
            root = json.loads(path.read_text(encoding="utf-8"))["Data"]["RootChunk"]
            entries = root["root"]["Data"]["entries"]
        except (KeyError, TypeError, ValueError):
            continue
        if not entries or "stringId" not in entries[0]:
            continue                                        # onscreens table: other schema
        for entry in entries:
            sid = str(entry["stringId"])
            female, male = entry.get("femaleVariant") or "", entry.get("maleVariant") or ""
            table.setdefault(sid, [female, male])
    write_json(cache, table)
    return table


def main() -> int:
    wems = []
    for name, archive in ARCHIVES.items():
        for line in listing(name, archive):
            match = WEM_RE.match(line.strip())
            if match:
                stem = match["stem"]
                wems.append({"wem": line.strip(), "archive": name, "vo": match["vo"], "stem": stem, "tag": tag_of(stem), "fm": match["fm"],
                             "hex": match["hex"], "sid": str(int(match["hex"], 16)), "rest": match["rest"].strip()})
    by_hex = collections.defaultdict(list)
    for wem in wems:
        by_hex[wem["hex"]].append(wem)
    text = subtitles()
    print(f"{len(wems)} voice files, {len(text)} subtitle entries", file=sys.stderr)

    index = read_json(POOL_INDEX)
    voices = sorted(key for key, voice in index["voices"].items() if voice["live"])
    evaluation = read_json(LIKENESS / "evaluation-sets.json")
    held = {i.split("/")[1] for i in evaluation["evaluation_lines"]["ids"]}
    heldout_voice = collections.defaultdict(set)
    for i in evaluation["evaluation_lines"]["ids"]:
        heldout_voice[i.split("/")[0]].add(i.split("/")[1])

    # Dataset ids per voice (all splits) and which of them are dev/test (never offered as new candidates).
    ids = collections.defaultdict(set)
    dev_test = set()
    train_wem_sha = collections.defaultdict(set)
    for split in ("train", "dev", "test", "teacher_conditional", "teacher_regression"):
        for line in (DATASET / f"{split}.jsonl").read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            voice, sid = row["id"].split("/")[:2]
            ids[voice].add(sid)
            if split in ("dev", "test"):
                dev_test.add((voice, sid))
            if split == "train" and row.get("source_wem_sha256"):
                train_wem_sha[voice].add(row["source_wem_sha256"])
    pocket = read_json(ROOT / "runtime/pocket-voices.json")["voices"]
    omni = read_json(ROOT / "runtime/local-voices.json")["voices"]

    def live_sid(voice):
        out = set()
        for table in (pocket, omni):
            receipt = table.get(voice, {}).get("sourceReceipt")
            if receipt and (ROOT / receipt).is_file():
                out.add(str(read_json(ROOT / receipt)["stringId"]))
        return out

    catalog = {}
    for voice in voices:
        seen_sids = ids.get(voice, set()) | live_sid(voice)
        tags = collections.Counter()
        stems = set()
        for sid in seen_sids:
            for wem in by_hex.get(f"{int(sid):016x}", [])[:1]:
                tags[wem["tag"]] += 1
                stems.add(wem["stem"])
        limited = bool(tags) and all(GENERIC_TAG.match(tag) for tag in tags)
        entries = []
        if tags:
            for wem in wems:
                tag = wem["tag"]
                if limited:
                    ok = wem["stem"] in stems
                else:
                    ok = any(tag == mine or tag.startswith(mine + "_") for mine in tags)
                    ok = ok and not any(tag.startswith(bad) for mine in tags for bad in NOT_THIS_VOICE.get(mine, []))
                if not ok:
                    continue
                subtitle = text.get(wem["sid"])
                chosen = ""
                if subtitle:
                    chosen = subtitle[0] if wem["fm"] == "f" else subtitle[1]
                    chosen = chosen or subtitle[0] or subtitle[1]
                entries.append({**wem, "text": chosen.strip(), "heldOut": wem["sid"] in held,
                                "devTest": (voice, wem["sid"]) in dev_test, "inDataset": wem["sid"] in ids.get(voice, set()),
                                "effectName": bool(EFFECT_NAME.search(wem["stem"])) or wem["vo"] in ("vo_helmet", "vo_rewinded")})
        catalog[voice] = {"tags": sorted(tags), "sceneLimited": limited, "datasetIds": len(ids.get(voice, set())), "trainWemSha": sorted(train_wem_sha.get(voice, [])),
                          "heldOutIds": sorted(heldout_voice.get(voice, [])), "entries": entries}
    write_json(SRC / "catalog.json", catalog)
    for voice, item in catalog.items():
        entries = item["entries"]
        print(f"{voice:22} tags={','.join(item['tags'])[:50]:50} limited={int(item['sceneLimited'])} files={len(entries):5} "
              f"text={sum(1 for e in entries if e['text']):5} dataset={item['datasetIds']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
