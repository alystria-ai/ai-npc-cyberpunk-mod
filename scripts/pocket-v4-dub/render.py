"""Render the pack-check sentences with one Pocket v4 language model, the way bridge/pocket-voice-worker.py runs it, and time them.

usage: python -X utf8 -I render.py --lang french --pack fr --models <dir> --packs <voices/multilingual> --check <deliverables/voice-packs>
                                   --out <dir> [--threads 4]
For each character: (a) clone from the pack's dub clip, (b) clone from the English clip (check/<pack>/check/ref/<key>.en-ref.wav, the clip the
OmniVoice pack check used as its baseline). Three sentences each from check/<pack>/check/results.json ("sentences"). One process per language,
one render at a time. Settings are the worker's: temperature 0.3, one decode step, eos_threshold -1.0, no noise clamp, frames_after_eos=1,
copy_state=True, get_state_for_audio_prompt(path, truncate=False), torch threads 4, interop 1.
Writes <out>/<lang>/{<key>.<a|b>.s<n>.wav, <key>.<a|b>.wav (the three joined with 0.3 s gaps), records.json}.
"""
import argparse
import gc
import json
import os
import time
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("--lang", required=True)
p.add_argument("--pack", required=True)
p.add_argument("--models", type=Path, required=True)
p.add_argument("--packs", type=Path, required=True)
p.add_argument("--check", type=Path, required=True)
p.add_argument("--out", type=Path, required=True)
p.add_argument("--threads", type=int, default=4)
p.add_argument("--keys", default="panam-palmer,judy-alvarez,jackie-welles,resident-female,v-male")
a = p.parse_args()
for k in ("OMP_NUM_THREADS", "MKL_NUM_THREADS", "OPENBLAS_NUM_THREADS"):
    os.environ[k] = str(a.threads)
os.environ.update(CUDA_VISIBLE_DEVICES="-1", HF_HUB_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1", PYTHONDONTWRITEBYTECODE="1", TOKENIZERS_PARALLELISM="false")

import numpy as np
import psutil
import soundfile as sf
import torch

torch.set_num_threads(a.threads)
torch.set_num_interop_threads(1)
from pocket_tts import TTSModel

proc = psutil.Process()


def rss():
    return proc.memory_info().rss / 1e6


sentences = json.loads((a.check / a.pack / "check" / "results.json").read_text(encoding="utf-8"))["sentences"]
manifest = json.loads((a.packs / a.pack / "manifest.json").read_text(encoding="utf-8-sig"))["voices"]
out = a.out / a.lang
out.mkdir(parents=True, exist_ok=True)
rss_start = rss()
t = time.perf_counter()
model = TTSModel.load_model(config=a.models / a.lang / "inference.yaml", temp=0.3, sampler_decode_steps=1, eos_threshold=-1.0, noise_clamp=None)
load_s = time.perf_counter() - t
assert model.has_voice_cloning and model.sample_rate == 24000
rss_loaded = rss()
params = sum(x.numel() for x in model.parameters())
print(f"{a.lang}: loaded in {load_s:.1f}s, {params / 1e6:.1f}M params, rss {rss_start:.0f} -> {rss_loaded:.0f} MB", flush=True)


def prep(path):
    t0 = time.perf_counter()
    with torch.no_grad():
        state = model.get_state_for_audio_prompt(Path(path), truncate=False)
    return state, (time.perf_counter() - t0) * 1000


def synth(state, text, seed):
    torch.manual_seed(seed)
    t0 = time.perf_counter()
    cpu0 = time.process_time()
    first, chunks = None, []
    with torch.no_grad():
        for chunk in model.generate_audio_stream(state, text, frames_after_eos=1, copy_state=True):
            if first is None:
                first = (time.perf_counter() - t0) * 1000
            chunks.append(chunk.detach().numpy().reshape(-1).astype("<f4", copy=True))
    wall = time.perf_counter() - t0
    pcm = np.concatenate(chunks) if chunks else np.zeros(0, dtype="<f4")
    audio = len(pcm) / 24000
    return pcm, {"ttfaMs": first, "wallS": wall, "audioS": audio, "rtf": wall / audio if audio else None,
                 "cores": (time.process_time() - cpu0) / wall}


# Warm-up: one render that is discarded (first-call allocations), from the first character's dub clip.
first_key = a.keys.split(",")[0]
state, _ = prep(a.packs / a.pack / manifest[first_key]["file"])
synth(state, sentences[0], 1)
records = []
peak = rss()
for key in a.keys.split(","):
    refs = {"a": a.packs / a.pack / manifest[key]["file"], "b": a.check / a.pack / "check" / "ref" / f"{key}.en-ref.wav"}
    for cond in ("a", "b"):
        state, prep_ms = prep(refs[cond])
        pieces = []
        for n, sentence in enumerate(sentences, 1):
            pcm, s = synth(state, sentence, 1000 + n)
            sf.write(str(out / f"{key}.{cond}.s{n}.wav"), pcm, 24000, subtype="PCM_16")
            pieces += [pcm, np.zeros(int(24000 * 0.3), dtype="<f4")]
            peak = max(peak, rss())
            records.append({"lang": a.lang, "key": key, "cond": cond, "n": n, "text": sentence, "refPrepMs": prep_ms, **s})
            print(f"{a.lang} {key} {cond} s{n}: {s['audioS']:.2f}s audio ttfa {s['ttfaMs']:.0f} ms rtf {s['rtf']:.2f} cores {s['cores']:.1f}", flush=True)
        sf.write(str(out / f"{key}.{cond}.wav"), np.concatenate(pieces[:-1]), 24000, subtype="PCM_16")
rss_used = rss()
del model, state
gc.collect()
rss_after = rss()
summary = {"lang": a.lang, "threads": a.threads, "loadS": load_s, "paramsM": params / 1e6, "rssStartMB": rss_start, "rssLoadedMB": rss_loaded,
           "rssPeakMB": peak, "rssAfterUseMB": rss_used, "rssAfterUnloadMB": rss_after,
           "peakWorkingSetMB": getattr(proc.memory_info(), "peak_wset", 0) / 1e6}
(out / "records.json").write_text(json.dumps({"summary": summary, "records": records}, indent=1, ensure_ascii=False), encoding="utf-8")
print("SUMMARY", json.dumps(summary), flush=True)
