"""Index who speaks which voice line in every scene of the game (docs/CAST_SWEEP.md, "Voice models").

    python scripts/cast-sweep/scene_index.py --work E:/CyberpunkConvai-offload/work/side-voice-models [--limit N]

Lists every `.scene` of the base game and Phantom Liberty gamedata archives (WolvenKit's path dictionary), exports them in batches of 60 (extract, serialize, summarise,
delete the big JSON), and writes <work>/scene-index.json: {scene depot path: {"actors": {actorId: {name, recs, voicetag, entry, spawn}}, "lines": [[speakerActorId, locstringId], ...]}}.
`recs` are the TweakDB character records the actor is spawned or found as (specRecordId of the spawn and find-in-context params, specCharacterRecordId), `voicetag` is the
scene's voicetag id of the actor.  The locstring id is the hex in the voice file name, so a line gives the voice file stem (voice tag + group) and through the actor the record.
It resumes where it stopped (<work>/scene-index.part.json is rewritten after every batch).  Below normal priority, one WolvenKit process at a time.  Reads the game only.
"""
from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from game_files import GameFiles  # noqa: E402

LIST = None


def val(node, *path):
    for step in path:
        if not isinstance(node, dict):
            return None
        node = node.get(step)
    return node


def summarise(root: dict) -> dict:
    actors = {}
    for actor in root.get("actors", []):
        recs = set()
        for node in (val(actor, "spawnDespawnParams", "specRecordId"), val(actor, "findActorInContextParams", "specRecordId"), actor.get("specCharacterRecordId")):
            value = (node or {}).get("$value") if isinstance(node, dict) else None
            if value and value != "0":
                recs.add(value)
        actors[str(val(actor, "actorId", "id"))] = {
            "name": actor.get("actorName"), "recs": sorted(recs), "voicetag": str(val(actor, "voicetagId", "id")),
            "entry": val(actor, "communityParams", "entryName", "$value"), "spawn": val(actor, "spawnSetParams", "entryName", "$value")}
    lines = [[str(val(line, "speaker", "id")), str(val(line, "locstringId", "ruid"))] for line in (val(root, "screenplayStore", "lines") or [])]
    return {"actors": actors, "lines": lines}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work", required=True)
    parser.add_argument("--scene-list", required=True, help="JSON {archive: [depot paths]} written by `WolvenKit.CLI archive --list --regex \\.scene$`")
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    work = Path(args.work)
    work.mkdir(parents=True, exist_ok=True)
    listing = json.loads(Path(args.scene_list).read_text(encoding="utf-8"))
    scenes = sorted({p.replace("/", "\\").lower() for paths in listing.values() for p in paths})
    part = work / "scene-index.part.json"
    index = json.loads(part.read_text(encoding="utf-8")) if part.is_file() else {}
    todo = [s for s in scenes if s not in index][: args.limit]
    print(f"{len(scenes)} scenes, {len(index)} done, {len(todo)} to do", flush=True)
    gf = GameFiles(work / "tmp")
    started = time.monotonic()
    for start in range(0, len(todo), 60):
        batch = todo[start:start + 60]
        result = gf.export(batch)
        for depot in batch:
            root = result.get(depot)
            index[depot] = summarise(root) if root else None
        shutil.rmtree(work / "tmp" / "raw", ignore_errors=True)
        part.write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
        print(f"{len(index)}/{len(scenes)} {time.monotonic() - started:.0f}s", flush=True)
    (work / "scene-index.json").write_text(json.dumps(index, ensure_ascii=False), encoding="utf-8")
    print("missing:", sum(1 for v in index.values() if v is None))
    return 0


if __name__ == "__main__":
    sys.exit(main())
