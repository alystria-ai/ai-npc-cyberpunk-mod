"""Two side measurements, same settings as render.py.

1. The shipped English student (read from the installed models/pocket folder, loaded by pocket-tts 4.0.0, whose audio is bit-identical to 3.3.0)
   speaking the three English pack-check sentences, 5 passes: a speed and memory baseline taken on the same machine in the same session.
2. Swapping language models in one process (fr -> de -> it -> unload -> fr): resident memory after every load and unload, and what is left after the
   working set is trimmed (the call a worker could make after an unload).

usage: python -X utf8 -I baseline_swap.py --student <installed models/pocket> --models <dir> --ref <wav> --scratch <dir> --out <json>
"""
import argparse
import ctypes
import gc
import json
import os
import re
import statistics
import time
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--student", type=Path, required=True)
p.add_argument("--models", type=Path, required=True)
p.add_argument("--ref", type=Path, required=True)
p.add_argument("--scratch", type=Path, required=True)
p.add_argument("--out", type=Path, required=True)
a = p.parse_args()
for k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
    os.environ[k] = "4"
os.environ.update(CUDA_VISIBLE_DEVICES="-1", HF_HUB_OFFLINE="1", PYTHONDONTWRITEBYTECODE="1", TOKENIZERS_PARALLELISM="false")
import psutil
import torch

torch.set_num_threads(4)
torch.set_num_interop_threads(1)
from pocket_tts import TTSModel

proc = psutil.Process()


def rss():
    return round(proc.memory_info().rss / 1e6)


def trim():
    handle = ctypes.windll.kernel32.GetCurrentProcess()
    ctypes.windll.psapi.EmptyWorkingSet(handle)


def load(config):
    return TTSModel.load_model(config=config, temp=0.3, sampler_decode_steps=1, eos_threshold=-1.0, noise_clamp=None)


out = {"rssImportedMB": rss()}
# 1. shipped student
text = (a.student / "inference.yaml").read_text(encoding="utf-8")
text = re.sub(r"^weights_path: .*$", "weights_path: " + (a.student / "model.safetensors").as_posix(), text, count=1, flags=re.M)
text = re.sub(r"tokenizer_path: \S+", "tokenizer_path: " + (a.student / "tokenizer.json").as_posix(), text, count=1)
a.scratch.mkdir(parents=True, exist_ok=True)
(a.scratch / "student.yaml").write_text(text, encoding="utf-8")
t = time.perf_counter()
model = load(a.scratch / "student.yaml")
out["student"] = {"loadS": time.perf_counter() - t, "rssLoadedMB": rss(), "paramsM": sum(x.numel() for x in model.parameters()) / 1e6}
with torch.no_grad():
    t = time.perf_counter()
    state = model.get_state_for_audio_prompt(a.ref, truncate=False)
    out["student"]["refPrepMs"] = (time.perf_counter() - t) * 1000
SENT = ["Hello, it's been a long time.", "Night City is quiet tonight, let's go for a drink.", "Where do you want to go first?"]


def synth(m, st, s, seed):
    torch.manual_seed(seed)
    t0 = time.perf_counter()
    first, n = None, 0
    with torch.no_grad():
        for chunk in m.generate_audio_stream(st, s, frames_after_eos=1, copy_state=True):
            if first is None:
                first = (time.perf_counter() - t0) * 1000
            n += chunk.numel()
    wall = time.perf_counter() - t0
    return first, wall, n / 24000


synth(model, state, SENT[0], 1)
runs = []
for rep in range(5):
    for i, s in enumerate(SENT):
        first, wall, audio = synth(model, state, s, 100 * rep + i)
        runs.append({"ttfaMs": first, "rtf": wall / audio, "audioS": audio})
out["student"].update({"ttfaMsMedian": statistics.median(r["ttfaMs"] for r in runs), "rtfMedian": statistics.median(r["rtf"] for r in runs),
                       "rssAfterUseMB": rss(), "runs": runs})
print("student", json.dumps({k: v for k, v in out["student"].items() if k != "runs"}), flush=True)
del model, state
gc.collect()
trim()
out["student"]["rssAfterUnloadTrimmedMB"] = rss()

# 2. swapping
swaps = []
for lang in ["french", "german", "italian", "french"]:
    gc.collect()
    trim()
    before = rss()
    t = time.perf_counter()
    m = load(a.models / lang / "inference.yaml")
    load_s = time.perf_counter() - t
    loaded = rss()
    with torch.no_grad():
        st = m.get_state_for_audio_prompt(a.ref, truncate=False)
    synth(m, st, SENT[1], 5)
    used = rss()
    del m, st
    gc.collect()
    plain = rss()
    trim()
    swaps.append({"lang": lang, "rssBeforeLoadMB": before, "loadS": load_s, "rssLoadedMB": loaded, "rssAfterUseMB": used, "rssAfterDelMB": plain,
                  "rssAfterDelTrimmedMB": rss()})
    print(json.dumps(swaps[-1]), flush=True)
out["swaps"] = swaps
a.out.write_text(json.dumps(out, indent=1), encoding="utf-8")
