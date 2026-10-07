"""Cloned-voice training/test data: re-speak corpus lines with our cloning engines, warp the game curves onto them.

  select   choose lines (clean, aligned, 1.2-8 s) for train / test / per-character sets and a same-speaker
           reference line (different scene when possible) for each
  omni     render with OmniVoice on CUDA (production settings: 16 steps, guidance 2, no denoise/postprocess)
           [reference-voicestudio env]
  pocket   render with the Pocket student export on CPU [pocket-tts env]
  warp     PocketSphinx-align the clone with the same text, map clone time -> original time through matched
           word and phone boundaries, resample the original's full track set onto the clone's clock
           (clone-only pauses > 120 ms relax to rest), and cross-check the map against DTW on MFCCs
           [pocket-tts env]
Outputs (game-derived, keep local) go to E:/CyberpunkConvai-offload/work/lipsync-lab/clone/<engine>/.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
LAB = Path('E:/CyberpunkConvai-offload/work/lipsync-lab')
CORPUS = ROOT / 'runtime/lipsync-corpus2'


def select(args):
    from lab_align import words_of
    index, seen = [], set()
    for r in json.loads((LAB / 'pack/index.json').read_text()):
        if r['key'] not in seen:
            seen.add(r['key']); index.append(r)
    split = json.loads((LAB / 'pack/split2.json').read_text())
    clean = json.loads((LAB / 'pack/clean.json').read_text())
    labels = json.loads((LAB / 'pack/phones100.json').read_text())
    ok = [r for r in index if r['key'] in labels and not clean[r['key']]['combat'] and not clean[r['key']]['effect']
          and words_of(r['text']) and 1.2 <= r['an'] / 16000 <= 8]
    test = set(split['test'])
    char = {k: w for w, v in split['charTest'].items() for k in v}
    held = test | set(char) | set(split['excludeTrain'])
    rng = random.Random(7)
    by_actor = {}
    for r in ok:
        by_actor.setdefault(r['actor'], []).append(r)
    def ref_for(r, pool_keys):
        cands = [c for c in by_actor[r['actor']] if c['key'] != r['key'] and c['key'] in pool_keys and 2 <= c['an'] / 16000 <= 8]
        other = [c for c in cands if c['scene'] != r['scene']]
        return rng.choice(other or cands) if cands else None
    sets = {'train': [], 'test': [], 'char': []}
    train_pool = {r['key'] for r in ok if r['key'] not in held}
    test_pool = {r['key'] for r in ok if r['key'] in test}
    char_pool = {r['key'] for r in ok if r['key'] in char}
    rows = list(ok)
    rng.shuffle(rows)
    for r in rows:
        if r['key'] in train_pool and len(sets['train']) < args.train:
            name, pool = 'train', train_pool  # references from training lines only
        elif r['key'] in test_pool and len(sets['test']) < args.test:
            name, pool = 'test', test_pool  # held-out speakers: references from their own held-out lines
        elif r['key'] in char_pool:
            name, pool = 'char', char_pool
        else:
            continue
        ref = ref_for(r, pool)
        if ref is None:
            continue
        sets[name].append(dict(key=r['key'], actor=r['actor'], text=r['text'], ref=ref['key'], refText=ref['text']))
    out = LAB / 'clone/selection.json'
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(sets, indent=0), encoding='utf8')
    print({k: len(v) for k, v in sets.items()})


def _audio(pack_audio, index, key):
    r = index[key]
    return np.array(pack_audio[r['a']:r['a'] + r['an']], np.float32)


def omni(args):
    import os
    os.environ.setdefault('HF_HOME', str(ROOT / 'vendor/voice-models'))
    os.environ.setdefault('HF_HUB_OFFLINE', '1')
    os.environ.setdefault('TORCH_COMPILE_DISABLE', '1')
    import torch
    sys.path.insert(0, str(ROOT / 'vendor/reference-voicestudio'))
    from omnivoice import OmniVoice
    from scipy.signal import resample_poly
    sel = json.loads((LAB / 'clone/selection.json').read_text())
    index = {}
    for r in json.loads((LAB / 'pack/index.json').read_text()):
        index.setdefault(r['key'], r)
    audio = np.load(LAB / 'pack/audio.npy', mmap_mode='r')
    model = OmniVoice.from_pretrained('k2-fsa/OmniVoice', device_map='cuda', dtype=torch.float16)
    out = LAB / 'clone/omni'
    out.mkdir(parents=True, exist_ok=True)
    items = [i for name in args.sets.split(',') for i in sel[name]]
    began, done = time.time(), 0
    for i in items:
        path = out / f"{i['key']}.npy"
        if path.exists():
            continue
        ref = torch.tensor(_audio(audio, index, i['ref']))[None]
        torch.manual_seed(hash(i['key']) % 100000)
        with torch.inference_mode():
            wav = model.generate(text=i['text'], language='English', ref_audio=(ref, 16000), ref_text=i['refText'],
                                 num_step=16, guidance_scale=2.0, denoise=False, postprocess_output=False)
        w = wav[0] if isinstance(wav, list) else wav
        w = np.asarray(w.detach().float().cpu() if hasattr(w, 'detach') else w).reshape(-1)
        sr = getattr(model, 'sampling_rate', None) or 24000
        a16 = resample_poly(w, 16000, sr).astype(np.float32) if sr != 16000 else w.astype(np.float32)
        np.save(path, a16)
        done += 1
        if done % 50 == 0:
            print(f'{done}/{len(items)} ({(time.time() - began) / 60:.1f} min)', flush=True)
    print(f'rendered {done} in {(time.time() - began) / 60:.1f} min')


POCKET_EXPORT = Path('E:/CyberpunkConvai-offload/work/pocket-v2/exports/student-v2-s2000-ema-decv2')
_P = {}


def _pinit(threads):
    import copy
    import tempfile
    import torch
    import yaml
    sys.path.insert(0, str(ROOT / 'vendor/pocket-tts-training/source'))
    from pocket_tts import TTSModel
    torch.set_num_threads(threads)
    torch.set_num_interop_threads(1)
    config = yaml.safe_load((POCKET_EXPORT / 'inference.yaml').read_text(encoding='utf-8-sig'))
    config = copy.deepcopy(config)  # same relocation as bridge/pocket_voice_runtime.inspect_student_export
    config['weights_path'] = str(POCKET_EXPORT / 'model.safetensors')
    config['weights_path_without_voice_cloning'] = None
    config['flow_lm']['weights_path'] = None
    config['mimi']['weights_path'] = None
    config['flow_lm']['lookup_table']['tokenizer_path'] = str(POCKET_EXPORT / 'tokenizer.json')
    tmp = Path(tempfile.mkdtemp(prefix='pocket-lab-', dir=str(LAB)))
    (tmp / 'inference.yaml').write_text(yaml.safe_dump(config, sort_keys=False), encoding='utf-8')
    # production sampling (runtime/pocket-voices.json, pocket-voice-worker.py)
    _P['model'] = TTSModel.load_model(config=tmp / 'inference.yaml', temp=0.3, sampler_decode_steps=1,
                                      eos_threshold=-1.0, noise_clamp=None)
    _P['tmp'] = tmp
    _P['audio'] = np.load(LAB / 'pack/audio.npy', mmap_mode='r')
    _P['index'] = {}
    for r in json.loads((LAB / 'pack/index.json').read_text()):
        _P['index'].setdefault(r['key'], r)


def _pocket_one(item):
    import soundfile as sf
    import torch
    from scipy.signal import resample_poly
    out = LAB / 'clone/pocket' / f"{item['key']}.npy"
    if out.exists():
        return item['key'], 'exists'
    try:
        ref = _audio(_P['audio'], _P['index'], item['ref'])
        wav = _P['tmp'] / f"ref-{item['ref']}.wav"
        sf.write(wav, resample_poly(ref, 3, 2), 24000, subtype='PCM_16')
        model = _P['model']
        torch.manual_seed(hash(item['key']) % 100000)
        # no inference_mode: generation runs on a producer thread, as in pocket-voice-worker.py
        state = model.get_state_for_audio_prompt(str(wav), truncate=False)
        chunks = [np.asarray(c.detach().float().cpu() if hasattr(c, 'detach') else c).reshape(-1)
                  for c in model.generate_audio_stream(state, item['text'], frames_after_eos=1, copy_state=True)]
        wav.unlink()
        a = np.concatenate(chunks)
        np.save(out, resample_poly(a, 2, 3).astype(np.float32))
        return item['key'], 'ok'
    except Exception as e:  # noqa: BLE001
        return item['key'], repr(e)[:200]


def pocket(args):
    from multiprocessing import Pool
    sel = json.loads((LAB / 'clone/selection.json').read_text())
    (LAB / 'clone/pocket').mkdir(parents=True, exist_ok=True)
    items = [i for name in args.sets.split(',') for i in sel[name][:args.per_set]]
    began = time.time()
    with Pool(args.procs, initializer=_pinit, initargs=(args.threads,)) as pool:
        for n, (key, status) in enumerate(pool.imap_unordered(_pocket_one, items), 1):
            if status not in ('ok', 'exists'):
                print(key, status, flush=True)
            if n % 25 == 0:
                print(f'{n}/{len(items)} ({(time.time() - began) / 60:.1f} min)', flush=True)


# ----------------------------------------------------------------- warping
_W = {}


def _winit():
    sys.path.insert(0, str(ROOT / 'vendor/phone-analysis-python'))
    from pocketsphinx import Decoder
    import lab_align as la
    _W['la'] = la
    _W['dec'] = Decoder(hmm=str(la.SPHINX / 'acoustic-model'), dict=str(LAB / 'pack/align.dict'), lm=None, samprate=16000,
                        frate=100, loglevel='FATAL', beam=1e-60, wbeam=1e-40, pbeam=1e-60)


def _segments(audio, words):
    """[(word, start_frame, end_frame, [(phone, start, end), ...])] from two-pass PocketSphinx alignment."""
    d = _W['dec']
    pcm = np.clip(np.rint(audio * 32767), -32768, 32767).astype('<i2').tobytes()
    d.set_align_text(' '.join(words))
    d.start_utt(); d.process_raw(pcm, full_utt=True); d.end_utt()
    d.set_alignment()
    d.start_utt(); d.process_raw(pcm, full_utt=True); d.end_utt()
    out = []
    for w in d.get_alignment():
        phones = [(p.name.upper(), p.start, p.start + p.duration) for p in w]
        out.append((w.name, w.start, w.start + w.duration, phones))
    return out


def _anchor_pairs(sa, sb):
    """Matched (time_a, time_b) boundary pairs in 10 ms frames; phone boundaries where words match exactly."""
    wa = [s for s in sa if s[0] not in ('<sil>', 'sil', '<s>', '</s>', '(null)')]
    wb = [s for s in sb if s[0] not in ('<sil>', 'sil', '<s>', '</s>', '(null)')]
    if [w[0].split('(')[0] for w in wa] != [w[0].split('(')[0] for w in wb]:
        return None
    pairs = []
    for a, b in zip(wa, wb):
        pairs += [(a[1], b[1])]
        pa, pb = [p for p in a[3] if p[0] != 'SIL'], [p for p in b[3] if p[0] != 'SIL']
        if [p[0] for p in pa] == [p[0] for p in pb]:
            pairs += [(x[1], y[1]) for x, y in zip(pa[1:], pb[1:])]
        pairs += [(a[2], b[2])]
    pairs = sorted(set(pairs), key=lambda p: p[1])
    mono = [pairs[0]]
    for p in pairs[1:]:
        if p[0] >= mono[-1][0] and p[1] > mono[-1][1]:
            mono.append(p)
    return mono, wa, wb


def _mfcc(audio):
    import lipsync_model as lm
    from scipy.fft import dct
    m = lm.log_mel(audio)
    c = dct(m, type=2, axis=1, norm='ortho')[:, 1:14]
    return (c - c.mean(0)) / (c.std(0) + 1e-6)


def _dtw_path(a, b):
    from scipy.spatial.distance import cdist
    cost = cdist(a, b)
    n, m = cost.shape
    acc = np.full((n + 1, m + 1), np.inf); acc[0, 0] = 0
    for i in range(1, n + 1):
        row = cost[i - 1]
        for j in range(1, m + 1):
            acc[i, j] = row[j - 1] + min(acc[i - 1, j], acc[i, j - 1], acc[i - 1, j - 1])
    i, j, path = n, m, []
    while i > 0 and j > 0:
        path.append((i - 1, j - 1))
        k = np.argmin([acc[i - 1, j - 1], acc[i - 1, j], acc[i, j - 1]])
        i, j = (i - 1, j - 1) if k == 0 else ((i - 1, j) if k == 1 else (i, j - 1))
    return path[::-1]


def _warp_one(job):
    key, text, clone_path, out_dir = job
    try:
        la = _W['la']
        words = la.words_of(text)
        d = np.load(CORPUS / 'lines' / f'{key}.npz')
        orig, tracks = d['audio16k'].astype(np.float32), d['tracks']
        clone = np.load(clone_path).astype(np.float32)
        if len(clone) < 0.4 * 16000 or len(clone) > 3.0 * len(orig) + 32000:
            return key, dict(error='length')
        sa, sb = _segments(orig, words), _segments(clone, words)
        got = _anchor_pairs(sa, sb)
        if got is None:
            return key, dict(error='words')
        pairs, wa, wb = got
        ta = np.array([p[0] for p in pairs], float) / 100   # original seconds
        tb = np.array([p[1] for p in pairs], float) / 100   # clone seconds
        dur_b = len(clone) / 16000
        t30 = np.arange(int(dur_b * 30)) / 30
        src = np.interp(t30, tb, ta)  # clone time -> original time (flat extrapolation)
        # Before the first word / after the last: shift rigidly (keeps lead-in/out articulation).
        src = np.where(t30 < tb[0], ta[0] - (tb[0] - t30), src)
        src = np.where(t30 > tb[-1], ta[-1] + (t30 - tb[-1]), src)
        ot = np.arange(len(tracks)) / 30
        warped = np.stack([np.interp(src, ot, tracks[:, k], left=0, right=0) for k in range(tracks.shape[1])], 1)
        # Clone-only pauses (gap between consecutive clone words > 120 ms where the original's gap is < 60 ms): rest.
        rest = np.ones(len(t30))
        for (a0, a1), (b0, b1) in zip(zip(wa, wa[1:]), zip(wb, wb[1:])):
            gap_b, gap_a = (b1[1] - b0[2]) / 100, (a1[1] - a0[2]) / 100
            if gap_b > .12 and gap_a < .06:
                s, e = b0[2] / 100 + .06, b1[1] / 100 - .06
                rest = np.minimum(rest, np.clip(np.maximum((t30 - e) / .06, (s - t30) / .06), 0, 1))
        mouth = np.array([n.endswith('LipsyncPoseOutput') for n in _names()])
        warped[:, mouth] = warped[:, mouth] * rest[:, None]
        # DTW cross-check (acoustic only): median |DTW-mapped original time - phone-boundary map| at clone frames.
        path = _dtw_path(_mfcc(orig), _mfcc(clone))
        pb = np.array([p[1] for p in path]); pa = np.array([p[0] for p in path])
        import lipsync_model as lm
        tb_f, ta_f = lm.frame_time(pb), lm.frame_time(pa)
        speech = (tb_f >= tb[0]) & (tb_f <= tb[-1])
        mapped = np.interp(tb_f[speech], tb, ta)
        dtw_err = float(np.median(np.abs(mapped - ta_f[speech]))) * 1000 if speech.any() else float('nan')
        np.save(Path(out_dir) / f'{key}.tracks.npy', warped.astype(np.float32))
        # PocketSphinx phone labels of the clone itself (what a runtime aligner would see), 100 Hz
        lab = np.zeros(int(np.ceil(len(clone) / 160)) + 1, np.int8)
        for w in sb:
            for ph, s0, s1 in w[3]:
                if ph in la.PHONES:
                    lab[s0:s1] = la.PHONES.index(ph)
        np.save(Path(out_dir) / f'{key}.lab.npy', lab)
        return key, dict(dtwMedianMs=dtw_err, anchors=len(pairs), cloneSec=dur_b, origSec=len(orig) / 16000,
                         restFrac=float((rest < 1).mean()))
    except Exception as e:  # noqa: BLE001
        return key, dict(error=repr(e)[:200])


_NAMES = []


def _names():
    if not _NAMES:
        _NAMES.extend(json.loads((CORPUS / 'track-names.json').read_text()))
    return _NAMES


def warp(args):
    from multiprocessing import Pool
    sel = json.loads((LAB / 'clone/selection.json').read_text())
    folder = LAB / 'clone' / args.engine
    jobs = [(i['key'], i['text'], str(folder / f"{i['key']}.npy"), str(folder)) for name in sel for i in sel[name]
            if (folder / f"{i['key']}.npy").exists()]
    with Pool(args.procs, initializer=_winit) as pool:
        res = dict(pool.map(_warp_one, jobs, chunksize=4))
    (folder / 'warp.json').write_text(json.dumps(res, indent=0), encoding='utf8')
    good = {k: v for k, v in res.items() if 'error' not in v}
    errs = [v['error'] for v in res.values() if 'error' in v]
    dt = np.array([v['dtwMedianMs'] for v in good.values()])
    print(f'{len(good)} warped, {len(errs)} failed ({ {e: errs.count(e) for e in set(errs) if len(e) < 20} })')
    print(f'DTW vs phone-map median |dt| per line: median {np.nanmedian(dt):.0f} ms, p90 {np.nanpercentile(dt, 90):.0f} ms')
    ratio = np.array([v['cloneSec'] / v['origSec'] for v in good.values()])
    print(f'clone/original duration: median {np.median(ratio):.2f}, p10 {np.percentile(ratio, 10):.2f}, p90 {np.percentile(ratio, 90):.2f}')
    # Lists for training (lab_train --extra) and evaluation (lab_eval clone:<list>).
    import lipsync_model as lm
    names = _names()
    lps = {n[:-len('LipsyncPoseOutput')]: i for i, n in enumerate(names) if n.endswith('LipsyncPoseOutput')}
    cols = [[lps[c] for c in controls] for _, controls in lm.OUTPUTS]
    for name in sel:
        items = []
        for i in sel[name]:
            if i['key'] not in good or good[i['key']]['dtwMedianMs'] > args.max_dtw:
                continue
            tr = np.load(folder / f"{i['key']}.tracks.npy")
            y = np.stack([tr[:, c].mean(axis=1) for c in cols], 1).astype(np.float32)
            np.save(folder / f"{i['key']}.y30.npy", y)
            items.append(dict(key=i['key'], audio=str(folder / f"{i['key']}.npy"), tracks=str(folder / f"{i['key']}.tracks.npy"),
                              y30=str(folder / f"{i['key']}.y30.npy"), lab=str(folder / f"{i['key']}.lab.npy")))
        (folder / f'{name}.json').write_text(json.dumps(items, indent=0), encoding='utf8')
        print(name, len(items), 'items')


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('step', choices=['select', 'omni', 'pocket', 'warp'])
    p.add_argument('--train', type=int, default=2000)
    p.add_argument('--test', type=int, default=400)
    p.add_argument('--sets', default='test,char,train')
    p.add_argument('--engine', default='omni')
    p.add_argument('--procs', type=int, default=12)
    p.add_argument('--max-dtw', type=float, default=80)
    p.add_argument('--per-set', type=int, default=100000)
    p.add_argument('--threads', type=int, default=4)
    args = p.parse_args()
    {'select': select, 'omni': omni, 'pocket': pocket, 'warp': warp}[args.step](args)


if __name__ == '__main__':
    main()
