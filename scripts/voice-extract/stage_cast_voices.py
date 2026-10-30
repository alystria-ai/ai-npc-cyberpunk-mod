"""Stage the voice rows of the 27 cast sweep characters that have a game line of their own, so they speak with their own voice (docs/VOICE_EXTRACTION.md).

    python scripts/voice-extract/stage_cast_voices.py [--apply]

Each of the 27 has ONE game line (characters/cast-sweep-voices.json `clip`), used for the OmniVoice short and long clips and for Pocket.  The clip is the file
characters/voice-clips-manifest.json describes (the player's PC builds it from the game files, bridge/voice_clip_build.py), so the row's hash is the manifest's.
This script writes, per key, staging/cast/<key>/voice-rows.json (the three config rows: reference, hash, the game's subtitle as the words, pick note) and copies the
finished clip to runtime/voice-references/picked/autobest/<kind>/<key>.wav (the developer store the packaging build checks).  It changes no config:
`node scripts/clip-search/cast-expansion/merge_rows.mjs --keys ...` puts the rows into the three live configurations (backup first, the bridge's own loaders check them).

The words come from the game's English subtitles (research/cyberpunk/cache/game/localization/index/lookup.sqlite3, read only); they are written only to the staged rows
and the live configurations, which are not in git.  Without --apply nothing is written.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
MAIN = Path(r"C:/Users/akshi/Desktop/Code Palace/Cyberpunk Mod")
LOOKUP = MAIN / "research/cyberpunk/cache/game/localization/index/lookup.sqlite3"
CAST_WAVS = Path(r"E:/CyberpunkConvai-offload/work/cast-sweep")
KINDS = ("omni-short", "omni-long", "pocket")
RATE = 24000


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    manifest = json.loads((REPO / "characters/voice-clips-manifest.json").read_text(encoding="utf-8-sig"))["voices"]
    sweep = json.loads((REPO / "characters/cast-sweep-voices.json").read_text(encoding="utf-8"))["characters"]
    keys = sorted(key for key, row in sweep.items() if row.get("clip"))
    db = sqlite3.connect("file:" + LOOKUP.as_posix() + "?mode=ro", uri=True)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")
    problems = []
    staged = []
    for key in keys:
        clip = sweep[key]["clip"]
        voice = manifest.get(key)
        if not voice or not all(voice.get(kind) for kind in KINDS):
            problems.append(f"{key}: not complete in characters/voice-clips-manifest.json")
            continue
        short = voice["omni-short"]
        wem = short["lines"][0]["path"]
        if len(short["lines"]) != 1 or not wem.endswith(".wem") or f"_{int(clip['id']):x}.wem" not in wem:
            problems.append(f"{key}: the manifest line does not match the cast sweep line id")
            continue
        variant = wem.rsplit("_", 2)[-2]
        row = db.execute("select female,male from entries where domain='subtitle.stringId' and entry_id=?", (str(clip["id"]),)).fetchone()
        female, male = ((row[0] or "").strip(), (row[1] or "").strip()) if row else ("", "")
        words = (male or female) if variant == "m" else (female or male)
        if not words:
            problems.append(f"{key}: no subtitle for line {clip['id']}")
            continue
        source = CAST_WAVS / f"{key}.wav"
        if not source.is_file():
            problems.append(f"{key}: {source} is missing")
            continue
        rows = {}
        for kind in KINDS:
            spec = voice[kind]
            if "sameAs" in spec:
                spec = voice[spec["sameAs"]]
            if sha256_file(source) != spec["sha256"]:
                problems.append(f"{key}: {source} does not match the manifest hash")
                break
            seconds = round(spec["samples"] / RATE, 2)
            rows[kind] = {
                "reference": f"runtime/voice-references/picked/autobest/{kind}/{key}.wav",
                "sha256": spec["sha256"],
                "transcript": words,
                "transcriptSha256": hashlib.sha256(words.encode("utf-8")).hexdigest(),
                "status": "ready",
                "pick": {
                    "clips": [f"{key}/{clip['id']}"],
                    "seconds": seconds,
                    "keptAt": now,
                    "note": "cast sweep (docs/CAST_SWEEP.md): the character's one clean game line, the same for the OmniVoice short and long sets and Pocket; "
                            "built on the player's PC from the game files (docs/VOICE_EXTRACTION.md); no EQ, denoise or gain",
                },
            }
        else:
            staged.append((key, source, rows))
    print(f"{len(keys)} characters with a line of their own, {len(staged)} staged, {len(problems)} problems")
    for problem in problems:
        print("PROBLEM", problem)
    if problems:
        return 1
    if not args.apply:
        print("dry run: nothing written")
        return 0
    for key, source, rows in staged:
        for kind, row in rows.items():
            target = REPO / row["reference"]
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                if sha256_file(target) != row["sha256"]:
                    print(f"PROBLEM {target} exists with other bytes", file=sys.stderr)
                    return 1
            else:
                shutil.copyfile(source, target)
        out = REPO / "staging/cast" / key / "voice-rows.json"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps({"key": key, "rules": "cast sweep", "rows": rows}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("staged:", ",".join(key for key, _, _ in staged))
    return 0


if __name__ == "__main__":
    sys.exit(main())
