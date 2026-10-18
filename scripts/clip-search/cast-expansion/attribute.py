"""Scene-level speaker check for one character's voice files (docs/GAME_VOICE_REFERENCES.md, "Mapping dialogue to the right
character"): a screenplay line has a speaker actor and a locstring id; the locstring id is the hex in the voice-file name.  This
finds, for every scene searched, which actor speaks the lines of the given voice-file prefix, with the actor's name, voicetag id,
community entry and record, and lists the prefix lines no searched scene contains.

A voice tag alone is never identity: accept a line only when the speaking actor is the character (actor name, community entry or
record), and say why in the spec.

Usage:
  python attribute.py --key bryce-mosley --prefix bryce_mosley --token q110 [--token other] [--scene <depot>] [--export]
--token selects scenes referenced by quest phases whose depot path contains the token (resources.jsonl).  Cached exports under
research/cyberpunk/cache/game/scene-evidence are reused; --export exports the missing ones (WolvenKit CLI 9.0.1 through
research/cyberpunk/scripts/extract_scene_evidence.py, batches of up to 32, batch name cx-<key>-<n>).  Writes
staging/cast/<key>/attribution.json.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

from cx_common import GAME, MAIN, NO_WINDOW, SCENE_EVIDENCE, STAGING, parse_wem, prefix_paths, scenes_for_tokens, write_json


def cached_export(depot: str) -> Path | None:
    rel = Path(*depot.split("\\"))
    best = None
    for batch in SCENE_EVIDENCE.iterdir():
        raw = batch / "raw"
        if not raw.is_dir():
            continue
        for candidate in (raw / rel, raw / "base" / rel, raw / "ep1" / rel):
            path = candidate.with_name(candidate.name + ".json")
            if path.is_file() and (best is None or path.stat().st_mtime > best.stat().st_mtime):
                best = path
    return best


def export(key: str, depots: list[str]) -> None:
    script = MAIN / "research/cyberpunk/scripts/extract_scene_evidence.py"
    for n in range(0, len(depots), 32):
        batch = f"cx-{key}-{n // 32 + 1}".lower()[:63]
        args = [sys.executable, str(script), "--project", str(MAIN), "--game", str(GAME), "--batch", batch]
        for depot in depots[n:n + 32]:
            args += ["--depot", depot]
        result = subprocess.run(args, capture_output=True, text=True, cwd=str(script.parent), creationflags=NO_WINDOW, timeout=1800)
        print(f"export {batch}: exit {result.returncode}", result.stdout[-400:], result.stderr[-800:])


def value(node, *path):
    for step in path:
        if not isinstance(node, dict):
            return None
        node = node.get(step)
    return node


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--key", required=True)
    parser.add_argument("--prefix", action="append", required=True)
    parser.add_argument("--token", action="append", default=[])
    parser.add_argument("--scene", action="append", default=[])
    parser.add_argument("--export", action="store_true")
    args = parser.parse_args()
    ids = {}
    for prefix in args.prefix:
        for _, path in prefix_paths(prefix):
            folder, stem, variant, sid = parse_wem(path)
            if folder == "vo":
                ids.setdefault(sid, stem)
    depots = sorted(set(args.scene) | set(scenes_for_tokens(args.token) if args.token else []))
    print(len(ids), "prefix lines;", len(depots), "scenes to search")
    found = {d: cached_export(d) for d in depots}
    missing = [d for d, p in found.items() if not p]
    if missing and args.export:
        export(args.key, missing)
        found.update({d: cached_export(d) for d in missing})
        missing = [d for d, p in found.items() if not p]
    if missing:
        print("not exported:", len(missing), missing[:10])
    scenes, seen = [], set()
    for depot, path in found.items():
        if not path:
            continue
        root = json.loads(path.read_text("utf-8-sig"))["Data"]["RootChunk"]
        actors = {}
        for a in root.get("actors", []):
            actors[a["actorId"]["id"]] = {"actorName": a.get("actorName"), "voicetagId": value(a, "voicetagId", "id"),
                                          "communityEntry": value(a, "communityParams", "entryName", "$value"),
                                          "community": value(a, "communityParams", "reference", "$value"),
                                          "plan": a.get("acquisitionPlan"), "record": value(a, "specCharacterRecordId", "$value")}
        for a in root.get("playerActors", []):
            actors[a["actorId"]["id"]] = {"actorName": a.get("playerName") or "player", "voicetagId": value(a, "voicetagId", "id"), "player": True}
        per_actor = defaultdict(lambda: {"matched": [], "lines": 0})
        for line in value(root, "screenplayStore", "lines") or []:
            speaker = value(line, "speaker", "id")
            ruid = value(line, "locstringId", "ruid")
            row = per_actor[speaker]
            row["lines"] += 1
            if ruid in ids:
                row["matched"].append(ruid)
                seen.add(ruid)
        speakers = []
        for speaker, row in per_actor.items():
            if row["matched"]:
                speakers.append({"actorId": speaker, **actors.get(speaker, {"actorName": "?"}), "matchedLines": len(set(row["matched"])),
                                 "actorLines": row["lines"], "ids": sorted(set(row["matched"]))})
        if speakers:
            scenes.append({"scene": depot, "export": str(path.relative_to(SCENE_EVIDENCE)).replace("\\", "/"), "speakers": speakers})
    unattributed = sorted(set(ids) - seen)
    out = {"key": args.key, "prefixes": args.prefix, "tokens": args.token, "scenesSearched": len(depots) - len(missing),
           "scenesNotExported": missing, "prefixLines": len(ids), "attributedLines": len(seen), "unattributed": unattributed, "scenes": scenes}
    write_json(STAGING / args.key / "attribution.json", out)
    for s in scenes:
        for sp in s["speakers"]:
            print(f"{s['scene'].rsplit(chr(92), 1)[-1]}: actor {sp['actorId']} '{sp['actorName']}' entry={sp.get('communityEntry')} "
                  f"vt={sp.get('voicetagId')} rec={sp.get('record')} matched {sp['matchedLines']}/{sp['actorLines']}")
    print(f"attributed {len(seen)}/{len(ids)}; unattributed {len(unattributed)}")


if __name__ == "__main__":
    main()
