"""Step 3: ECAPA speaker embeddings (CPU) for the new clips and for pool clips that have none yet.

    vendor/reference-voicestudio/.venv/Scripts/python.exe scripts/reference-pool/embed.py [--voices a,b | --priority] [--old]

Typicality in the picker is the cosine of a clip's ECAPA embedding to its voice's centroid, as a percentile within the
voice (see scripts/reference-picker/build-index.py).  The study's embeddings (likeness-phase1/out/multiref_emb.pt) only
cover 2-9 s training clips, so the new clips (and, with --old, the rest of the existing pool) are embedded here with the
same model and stored per voice in WORK/ecapa/<voice>.pt as {clip id: 192-d unit vector}.  Clips longer than 6 s are
embedded from their middle 6 s.  CPU only, below-normal priority (the game is running); several processes can work on
different voices at once (--voices).
"""
from __future__ import annotations

import argparse
import ctypes
import json
import sys
import time

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

from common import *  # noqa

PRIORITY = read_json(ROOT / "scripts/reference-picker/shown-voices.json")
STORE = WORK / "ecapa"
MAX_SECONDS = 6.0


def load16(path) -> "np.ndarray":
    data, rate = sf.read(str(path), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if rate != 16000:
        from math import gcd
        g = gcd(rate, 16000)
        mono = resample_poly(mono, 16000 // g, rate // g).astype(np.float32)
    keep = int(MAX_SECONDS * 16000)
    if len(mono) > keep:
        start = (len(mono) - keep) // 2
        mono = mono[start:start + keep]
    return mono


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--voices")
    parser.add_argument("--priority", action="store_true")
    parser.add_argument("--old", action="store_true", help="also embed existing pool clips that have no embedding yet")
    parser.add_argument("--threads", type=int, default=4)
    args = parser.parse_args()
    if sys.platform == "win32":
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x00004000)
    import torch
    import torch.nn.functional as F
    torch.set_num_threads(args.threads)
    from speechbrain.inference.speaker import EncoderClassifier
    from speechbrain.utils.fetching import LocalStrategy

    ecapa_dir = LIKENESS.parent / "ecapa-src"
    model = EncoderClassifier.from_hparams(source=str(ecapa_dir), savedir=str(LIKENESS.parent / "ecapa"), overrides={"pretrained_path": str(ecapa_dir)},
                                           local_strategy=LocalStrategy.COPY, run_opts={"device": "cpu"})
    study = set(torch.load(LIKENESS / "multiref_emb.pt", map_location="cpu", weights_only=False))
    catalog = read_json(SRC / "catalog.json")
    voices = args.voices.split(",") if args.voices else [v for v in PRIORITY if v in catalog] if args.priority else [v for v in PRIORITY if v in catalog] + [v for v in catalog if v not in PRIORITY]
    index = read_json(POOL_INDEX) if args.old else None
    STORE.mkdir(parents=True, exist_ok=True)
    started, count = time.time(), 0

    for voice in voices:
        target = STORE / f"{voice}.pt"
        store = torch.load(target, weights_only=False) if target.exists() else {}
        todo = []
        manifest = WORK / voice / "clips.jsonl"
        if manifest.exists():
            for line in manifest.read_text(encoding="utf-8").splitlines():
                row = json.loads(line) if line.strip() else {}
                key = f"{voice}/{row.get('id')}"
                if row.get("sid") and key not in store and (WORK / voice / f"{row['id']}.wav").exists():
                    todo.append((key, WORK / voice / f"{row['id']}.wav"))
        if index and voice in index["voices"]:
            for clip in index["voices"][voice]["clips"]:
                if clip["id"] not in store and clip["id"] not in study:
                    todo.append((clip["id"], Path(index["dataRoot"]) / clip["p"]))
        print(f"[{voice}] {len(todo)} to embed", flush=True)
        last_save = time.time()
        for key, path in todo:
            if not path.exists():
                continue
            wave = torch.from_numpy(load16(path))
            with torch.inference_mode():
                vector = model.encode_batch(wave[None]).reshape(1, -1)
            store[key] = F.normalize(vector, dim=-1)[0].cpu()
            count += 1
            if time.time() - last_save > 120:
                torch.save(store, target)
                last_save = time.time()
                print(f"  {voice}: {len(store)} embedded, {count / (time.time() - started):.1f}/s", flush=True)
        if store:
            torch.save(store, target)
    print(f"done: {count} embeddings in {time.time() - started:.0f} s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
