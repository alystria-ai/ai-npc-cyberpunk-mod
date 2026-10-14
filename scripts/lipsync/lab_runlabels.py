"""Phone labels for TRAINING lines exactly as the runtime decides them (own phone head + text Viterbi).

Stage 2 was trained on PocketSphinx labels (+-2 frame jitter) but at runtime it sees the labels of the shipped
phone head + lab_textpipe.Aligner (about 84 % frame agreement with PocketSphinx). This writes, per training line,
the runtime's decided labels in the pack's 100 Hz label convention (<out>/<key>.npy, int8), so lab_stage2 can train
on what it will actually see (lab_train.Pack reads them when LAB_TRAIN_LABEL_DIR is set).

  python lab_runlabels.py <stack-dir> <out-dir> --mode stream|phrase [--procs 10]
Lines without alignable text are skipped (the runtime never runs stage 2 on them).
"""
from __future__ import annotations

import argparse
import json
import sys
from multiprocessing import Pool
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
LAB = Path('E:/CyberpunkConvai-offload/work/lipsync-lab')
LAB_SHIFT = 6
_G = {}


def _init(stack, mode, out):
    import lab_textpipe as tp
    import lab_train as lt
    _G.update(pipe=tp.TextPipeline(Path(stack)), tp=tp, pack=lt.Pack(LAB / 'pack'), mode=mode, out=Path(out))


def _job(key):
    tp, pipe, pack, mode = _G['tp'], _G['pipe'], _G['pack'], _G['mode']
    path = _G['out'] / f'{key}.npy'
    if path.exists():
        return key, 'cached'
    text = pack.by_key[key].get('text') or ''
    tokens = tp.normalize_text(text) if text else []
    phones, kinds = tp.build_states(tokens, pipe.lex)
    if not any(k == 0 for k in kinds):
        return key, 'no-text'
    audio = pack.line(key)['audio']
    h1, _, _ = pipe.stage1(audio)
    pt, cfg = pipe.pt, pipe.mt
    net = cfg['nets'][mode]
    logits = h1 @ pt['head.w'][:, :, 0].T + pt['head.b']
    logits = logits - logits.max(1, keepdims=True)
    logp = logits - np.log(np.exp(logits).sum(1, keepdims=True))
    score = (logp - cfg['priorWeight'] * pt['log_prior']).astype(np.float32)
    al = tp.Aligner(phones, kinds, cfg, lag=net['lag'] if net['decide'] == 'lag' else None)
    for j in range(len(h1)):
        al.push(score[j])
    al.finish()
    decided = np.array([d[0] for d in al.decided], np.int64)
    la = pipe.la
    n_raw = int(np.ceil(len(audio) / 160)) + 1
    j = np.clip(np.arange(n_raw) - 1 - LAB_SHIFT + la, 0, len(decided) - 1)
    np.save(path, decided[j].astype(np.int8))
    return key, 'lost' if al.lost else 'ok'


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('stack', type=Path)
    p.add_argument('out', type=Path)
    p.add_argument('--mode', choices=['stream', 'phrase'], required=True)
    p.add_argument('--procs', type=int, default=10)
    p.add_argument('--limit', type=int, default=0)
    args = p.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    import lab_train as lt
    pack = lt.Pack(LAB / 'pack')
    split = json.loads((LAB / 'pack/split2.json').read_text())
    held = set(split['test']) | {k for v in split['charTest'].values() for k in v} | set(split['excludeTrain'])
    keys = [r['key'] for r in pack.index if r['key'] not in held and r['key'] in pack.lab_index]
    if args.limit:
        keys = keys[::max(1, len(keys) // args.limit)][:args.limit]
    counts = {}
    with Pool(args.procs, initializer=_init, initargs=(str(args.stack), args.mode, str(args.out))) as pool:
        for _, status in pool.imap_unordered(_job, keys, chunksize=8):
            counts[status] = counts.get(status, 0) + 1
    # agreement with PocketSphinx labels on a sample
    agree = []
    for k in keys[::max(1, len(keys) // 200)]:
        f = args.out / f'{k}.npy'
        if f.exists():
            a, b = np.load(f), pack.line(k)['lab']
            m = min(len(a), len(b))
            agree.append(float((a[:m] == b[:m]).mean()))
    print(f'{len(keys)} training lines: {counts}; agreement with PocketSphinx (sample) {np.mean(agree):.3f}')


if __name__ == '__main__':
    main()
