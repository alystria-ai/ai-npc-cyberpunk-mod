"""ECAPA speaker embeddings for every clip key of the combat-flag universe (GPU), reusing existing embeddings where they are
for the very same audio file.

    PYTHONUTF8=1 vendor/reference-voicestudio/.venv/Scripts/python.exe scripts/combat_flags/embed_ecapa.py [--voices a,b] [--device cuda] [--check 150]

Model: speechbrain EncoderClassifier from E:/CyberpunkConvai-offload/work/likeness-phase1/ecapa-src (the VoxCeleb ECAPA-TDNN the likeness
study, scripts/reference-pool/embed.py and scripts/clip-search/score.py all use; 192-d).  Preprocessing = scripts/reference-pool/embed.py
load16: channel mean, scipy resample_poly to 16 kHz, a clip over 6 s is cut to its middle 6 s, batch of one, L2-normalised.

Reuse (only when the stored embedding belongs to the audio file chosen in paths.jsonl, found through the pool-index id -> path):
  1. reference-pool-expanded/ecapa/<voice>.pt   {raw pool id: 192-d}   (embed.py preprocessing, the same as here)
  2. likeness-phase1/out/multiref_emb.pt        {raw dataset id: 192-d} (study: torchaudio resample, no 6 s crop; clips 2-9 s;
     reused only for clips up to 6 s so that no crop difference exists)
Everything else is computed.  Output: <out>/ecapa/<voice>.npz with keys (str array), emb (N x 192 float32, unit norm),
how ('reused:expanded' | 'reused:study' | 'new'), and <out>/ecapa/_reuse_check.json (cosine of a sample of reused vs recomputed).
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np

OUT_DEFAULT = Path(r"E:\CyberpunkConvai-offload\work\combat-flags")
WORK = Path(r"E:\CyberpunkConvai-offload\work")
POOL_INDEX = WORK / "reference-picker" / "pool-index.json"
ECAPA_SRC = WORK / "likeness-phase1" / "ecapa-src"
EXPANDED_STORE = WORK / "reference-pool-expanded" / "ecapa"
STUDY_STORE = WORK / "likeness-phase1" / "out" / "multiref_emb.pt"
MAX_SECONDS = 6.0


def load16(path) -> np.ndarray:                       # identical to scripts/reference-pool/embed.py
    import soundfile as sf
    from math import gcd
    from scipy.signal import resample_poly
    data, rate = sf.read(str(path), dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if rate != 16000:
        g = gcd(rate, 16000)
        mono = resample_poly(mono, 16000 // g, rate // g).astype(np.float32)
    keep = int(MAX_SECONDS * 16000)
    if len(mono) > keep:
        start = (len(mono) - keep) // 2
        mono = mono[start:start + keep]
    return mono


def norm_key(raw_id: str) -> str:
    import re
    return re.sub(r"/(female|male)$", "", raw_id)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=OUT_DEFAULT)
    ap.add_argument("--voices")
    ap.add_argument("--device", default="cuda")
    ap.add_argument("--check", type=int, default=150, help="reused embeddings to recompute for the agreement check")
    ap.add_argument("--redo", action="store_true")
    args = ap.parse_args()
    import torch
    import torch.nn.functional as F
    from speechbrain.inference.speaker import EncoderClassifier
    from speechbrain.utils.fetching import LocalStrategy

    out = args.out / "ecapa"
    out.mkdir(parents=True, exist_ok=True)
    rows = [json.loads(l) for l in open(args.out / "paths.jsonl", encoding="utf-8") if l.strip()]
    rows = [r for r in rows if r.get("audio_path")]
    by_voice = defaultdict(list)
    for r in rows:
        by_voice[r["voice"]].append(r)
    voices = args.voices.split(",") if args.voices else sorted(by_voice)

    # raw pool/dataset id -> the audio path that the existing embedding was computed from
    index = json.loads(POOL_INDEX.read_text(encoding="utf-8"))
    data_root = Path(index["dataRoot"])
    raw_path = {}
    for v in index["voices"].values():
        for c in v["clips"]:
            p = Path(c["p"])
            raw_path[c["id"]] = str(p if p.is_absolute() or ":" in c["p"] else data_root / p)
    expanded = {}
    for f in sorted(EXPANDED_STORE.glob("*.pt")):
        for k, vec in torch.load(f, map_location="cpu", weights_only=False).items():
            expanded[k] = vec.float().numpy()
    study = {k: vec.float().numpy() for k, vec in torch.load(STUDY_STORE, map_location="cpu", weights_only=False).items()}
    print(f"existing embeddings: expanded {len(expanded)}, study {len(study)}", flush=True)

    device = args.device if (args.device != "cuda" or torch.cuda.is_available()) else "cpu"
    model = EncoderClassifier.from_hparams(source=str(ECAPA_SRC), savedir=str(args.out / "ecapa-model"), overrides={"pretrained_path": str(ECAPA_SRC)},
                                           local_strategy=LocalStrategy.COPY, run_opts={"device": device})

    def embed(wave: np.ndarray) -> np.ndarray:
        with torch.inference_mode():
            vec = model.encode_batch(torch.from_numpy(wave)[None].to(device)).reshape(1, -1)
        return F.normalize(vec, dim=-1)[0].cpu().numpy().astype(np.float32)

    def reuse_for(r):
        """(vector, how) when an existing embedding was made from this very audio file, else None."""
        wanted = r["audio_path"]
        for raw in [x["id"] for x in r["pool_rows"]] + [x["id"] for x in r["corpus_rows"]] + [x["id"] for x in r["dataset_rows"]]:
            if raw_path.get(raw) != wanted:
                continue
            if raw in expanded:
                return expanded[raw], "reused:expanded"
            if raw in study and r.get("dur_file", 99) <= MAX_SECONDS:      # longer clips: the study had no middle-6 s crop, so recompute
                return study[raw], "reused:study"
        return None

    reused_samples = []                                  # (row, vector, how) for the agreement check
    total = Counter()
    started = time.time()
    for voice in voices:
        target = out / f"{voice}.npz"
        group = by_voice.get(voice, [])
        if not group:
            continue
        if target.exists() and not args.redo:
            have = set(np.load(target)["keys"].tolist())
            if all(r["key"] in have for r in group):
                total["skipped_voice_keys"] += len(group)
                continue
        keys, vecs, how = [], [], []
        todo = []
        for r in group:
            hit = reuse_for(r)
            if hit:
                vec, h = hit
                n = float(np.linalg.norm(vec))
                keys.append(r["key"]); vecs.append((vec / max(n, 1e-9)).astype(np.float32)); how.append(h)
                reused_samples.append((r, vecs[-1], h))
            else:
                todo.append(r)
        with ThreadPoolExecutor(3) as pool:
            for r, wave in zip(todo, pool.map(lambda r: load16(r["audio_path"]) if True else None, todo)):
                if len(wave) < 1600:
                    wave = np.pad(wave, (0, 1600 - len(wave)))
                keys.append(r["key"]); vecs.append(embed(wave)); how.append("new")
        order = np.argsort(keys)
        np.savez(target, keys=np.array(keys)[order], emb=np.stack(vecs)[order].astype(np.float32), how=np.array(how)[order])
        c = Counter(how)
        total.update(c)
        print(f"[{voice}] {len(keys)} keys: {dict(c)}  ({time.time() - started:.0f} s)", flush=True)

    # agreement of reused embeddings with a fresh computation under the preprocessing above
    random.seed(0)
    check = {}
    for h in ("reused:expanded", "reused:study"):
        pool_ = [x for x in reused_samples if x[2] == h]
        pick = random.sample(pool_, min(args.check, len(pool_)))
        cos = []
        for r, vec, _ in pick:
            fresh = embed(load16(r["audio_path"]))
            cos.append(float(fresh @ vec))
        if cos:
            check[h] = {"n": len(cos), "cos_min": min(cos), "cos_p05": float(np.percentile(cos, 5)), "cos_median": float(np.median(cos)), "cos_mean": float(np.mean(cos))}
    if check:
        (out / "_reuse_check.json").write_text(json.dumps(check, indent=1), encoding="utf-8")
        print("reuse check:", json.dumps(check))
    print(f"done in {time.time() - started:.0f} s; counts {dict(total)}")


if __name__ == "__main__":
    sys.exit(main())
