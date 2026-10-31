"""Prove that the language clips rebuild from a dub archive exactly, the way the bridge builds them (one process per voice, below normal priority).

    <Runtime python> -I scripts/voice-extract/prove_language.py --lang de --game <folder with archive/pc/content/lang_de_voice.archive (and ep1)> --pack <voices/multilingual folder> [--sample 20 | --all] [--batch]
            [--vgmstream <vgmstream-cli.exe>] [--out <folder>] [--report report.json]

Run it with the Python of the installed Runtime: that is the Python a player's PC builds with.  For every chosen voice the builder (`bridge/voice_clip_build.py build-language`) writes the
clip into a scratch folder, and the file is compared with the clip of the installed pack (same bytes) and with the SHA-256 in characters/voice-language-clips/<lang>.json.  The sample keeps both
V voices, archetypes, named characters and the voices that have a loudness stage (a gain), so every kind is proved.  `--batch` builds all chosen voices in one process (the whole language in
about a minute); the default is one process per voice, which also gives the cost a player sees: seconds and peak memory.  Nothing in the game or the pack is written.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
BUILDER = REPO / "bridge" / "voice_clip_build.py"


def choose(voices: dict, count: int | None, seed: int) -> list[str]:
    keys = sorted(voices)
    if count is None or count >= len(keys):
        return keys
    rng = random.Random(seed)
    picked = [k for k in keys if voices[k]["kind"] == "v-voice"]
    groups = {"picked": [k for k in keys if voices[k]["kind"] == "picked"], "archetypes": [k for k in keys if voices[k]["kind"] == "archetypes"],
              "gain": [k for k in keys if voices[k].get("gain")]}
    for name, share in (("gain", 0.25), ("picked", 0.35), ("archetypes", 0.4)):
        pool = [k for k in groups[name] if k not in picked]
        picked += rng.sample(pool, min(len(pool), max(1, round(count * share))))
    return sorted(set(picked))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lang", required=True)
    ap.add_argument("--game", required=True)
    ap.add_argument("--pack", required=True)
    ap.add_argument("--vgmstream", required=True)
    ap.add_argument("--sample", type=int, default=20)
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--batch", action="store_true")
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--out", default=None)
    ap.add_argument("--report")
    args = ap.parse_args()
    lang = args.lang
    manifest_path = REPO / "characters" / "voice-language-clips" / f"{lang}.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    voices = manifest["voices"]
    keys = choose(voices, None if args.all else args.sample, args.seed)
    out = Path(args.out) if args.out else Path(sys.argv[0]).resolve().parent / ".." / ".." / ".prove-language-tmp" / lang
    out = out.resolve()
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    results, times, memory = {}, [], []
    started = time.time()
    batches = [keys] if args.batch else [[k] for k in keys]
    for batch in batches:
        began = time.time()
        command = [sys.executable, "-I", str(BUILDER), "build-language", "--manifest", str(manifest_path), "--key", ",".join(batch), "--game", args.game, "--vgmstream", args.vgmstream,
                   "--out", str(out)]
        done = subprocess.run(command, capture_output=True, text=True, creationflags=0x08000000 | 0x00004000)
        wall = time.time() - began
        info = {}
        if done.returncode == 0:
            try:
                info = json.loads(done.stdout.strip().splitlines()[-1])
            except Exception:
                info = {}
        for key in batch:
            target = out / voices[key]["file"]
            row = {"kind": voices[key]["kind"], "gain": bool(voices[key].get("gain")), "exit": done.returncode}
            if done.returncode == 0 and target.is_file():
                data = target.read_bytes()
                shipped = (Path(args.pack) / lang / voices[key]["file"]).read_bytes()
                row.update(sameAsPack=data == shipped, sameAsManifest=hashlib.sha256(data).hexdigest() == voices[key]["sha256"])
                if not args.batch:
                    row.update(seconds=round(wall, 2), peakMb=info.get("peakMb"))
                    times.append(wall)
                    if info.get("peakMb"):
                        memory.append(info["peakMb"])
            else:
                row.update(sameAsPack=False, sameAsManifest=False, error=(done.stderr or "").strip().splitlines()[-1:] or ["no file"])
            results[key] = row
    exact = sum(1 for r in results.values() if r["sameAsPack"] and r["sameAsManifest"])
    summary = {"lang": lang, "python": sys.version.split()[0], "mode": "batch" if args.batch else "one process per voice", "voices": len(results), "identical": exact,
               "byKind": {kind: [sum(1 for r in results.values() if r["kind"] == kind and r["sameAsPack"] and r["sameAsManifest"]), sum(1 for r in results.values() if r["kind"] == kind)]
                          for kind in ("picked", "archetypes", "v-voice")},
               "withGain": [sum(1 for r in results.values() if r["gain"] and r["sameAsPack"]), sum(1 for r in results.values() if r["gain"])],
               "seconds": round(time.time() - started, 1)}
    if times:
        summary["perVoiceSeconds"] = {"median": round(statistics.median(times), 2), "max": round(max(times), 2)}
    if memory:
        summary["peakMb"] = {"median": round(statistics.median(memory), 1), "max": round(max(memory), 1)}
    print(json.dumps(summary))
    for key, row in results.items():
        if not (row["sameAsPack"] and row["sameAsManifest"]):
            print("DIFFERS", key, row)
    if args.report:
        Path(args.report).write_text(json.dumps({"summary": summary, "voices": results}, indent=1), encoding="utf-8")
    shutil.rmtree(out, ignore_errors=True)
    return 0 if exact == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
