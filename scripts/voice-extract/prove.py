"""Build voices from a game folder with the builder as the Runtime runs it (one process per character) and compare them with the shipped clips.

    <Runtime python> scripts/voice-extract/prove.py --game <game folder> --vgmstream <vgmstream-cli.exe> --out <folder> --keys a,b,c [--repeat 2] [--report report.json]

For every key and kind: the file is rebuilt from the game's English voice archive, then compared with the shipped clip of the configuration (SHA-256 of the file, number of
samples, largest absolute sample difference, number of samples that differ, correlation).  The time of each process and its peak working set (reported by the builder) are
recorded; `--repeat 2` runs every character twice, the second run is the warm one.  The game folder is only read.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import wave
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parents[2]
MAIN = Path(os.environ.get("CX_MAIN", r"C:\Users\akshi\Desktop\Code Palace\Cyberpunk Mod"))
CONFIGS = {"omni-short": "local-voices.autobest-short.json", "omni-long": "local-voices.autobest-long.json", "pocket": "pocket-voices.autobest.json"}


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as handle:
        return np.frombuffer(handle.readframes(handle.getnframes()), dtype="<i2")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--game", required=True)
    parser.add_argument("--vgmstream", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--keys", required=True)
    parser.add_argument("--manifest", default=str(REPO / "characters/voice-clips-manifest.json"))
    parser.add_argument("--repeat", type=int, default=1)
    parser.add_argument("--report")
    args = parser.parse_args()
    configs = {kind: json.loads((MAIN / "runtime" / file).read_text(encoding="utf-8-sig"))["voices"] for kind, file in CONFIGS.items()}
    rows = []
    for key in args.keys.split(","):
        for run in range(args.repeat):
            out = Path(args.out) / f"run{run + 1}"
            started = time.perf_counter()
            done = subprocess.run([sys.executable, str(REPO / "bridge/voice_clip_build.py"), "build", "--manifest", args.manifest, "--key", key, "--game", args.game,
                                   "--vgmstream", args.vgmstream, "--out", str(out)], capture_output=True, text=True)
            seconds = time.perf_counter() - started
            if done.returncode:
                rows.append({"key": key, "run": run + 1, "error": done.stderr.strip()[-200:]})
                print(key, "FAILED", done.stderr.strip()[-120:], flush=True)
                continue
            info = json.loads(done.stdout)
            for kind in CONFIGS:
                entry = configs[kind].get(key)
                if not entry:
                    continue
                shipped_file = MAIN / entry["reference"]
                built_file = out / kind / f"{key}.wav"
                a, b = read_wav(built_file), read_wav(shipped_file)
                same_length = len(a) == len(b)
                diff = np.abs(a.astype(np.int32) - b.astype(np.int32)) if same_length else None
                corr = float(np.corrcoef(a.astype(np.float64), b.astype(np.float64))[0, 1]) if same_length and a.any() else None
                rows.append({"key": key, "kind": kind, "run": run + 1, "seconds": round(seconds, 2), "peakMb": info["peakMb"], "samples": int(len(a)), "shippedSamples": int(len(b)),
                             "sameBytes": hashlib.sha256(built_file.read_bytes()).hexdigest() == hashlib.sha256(shipped_file.read_bytes()).hexdigest(),
                             "maxAbsDiff": int(diff.max()) if diff is not None else None, "differing": int((diff > 0).sum()) if diff is not None else None, "correlation": corr})
            print(f"{key} run {run + 1}: {seconds:.2f} s, peak {info['peakMb']} MB, " + ", ".join(f"{r['kind']} {'identical' if r['sameBytes'] else 'differs ' + str(r['maxAbsDiff'])}" for r in rows if r.get("key") == key and r.get("run") == run + 1 and "kind" in r), flush=True)
    if args.report:
        Path(args.report).write_text(json.dumps(rows, indent=1) + "\n", encoding="utf-8")
    identical = sum(1 for r in rows if r.get("sameBytes"))
    total = sum(1 for r in rows if "kind" in r)
    print(f"{identical} of {total} clips are byte for byte the shipped clip")
    return 0


if __name__ == "__main__":
    sys.exit(main())
