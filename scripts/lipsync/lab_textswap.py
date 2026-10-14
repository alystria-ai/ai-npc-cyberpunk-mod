"""Build a drop-in candidate folder: the shipped face-model and face-text, with one or both stage-2 nets replaced.

  python lab_textswap.py <shipped-dir> <out-dir> [--stream s2.pt] [--phrase s2.pt]

Everything else is copied byte for byte (face-model.*, phone head, phone prior, alignment settings, confidence
threshold, lexicon and its notice), so the bridge loads the folder exactly like the shipped one. A replaced net must
have the same tensor names and shapes (same channels and dilations, so the same CPU cost) and the same phone shift;
the script refuses anything else. Output stays under an ignored folder (weights are game-derived).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

import numpy as np
import torch


def safe_qmap(qin, qout, gap=1e-3):
    """Parity-safe quantile map: the knots of a run of tied predictions (inputs spaced 1e-6, e.g. the clipped zeros)
    are merged into one step of width `gap`, so float rounding (JS vs NumPy, ~1e-7) can no longer be magnified by a
    slope of ~3,000. Only predictions in (0, gap) change, by at most the plateau's output range (about .001-.003)."""
    qin, qout = np.asarray(qin, np.float64).copy(), np.asarray(qout, np.float64).copy()
    for k in range(qin.shape[0]):
        x = qin[k]
        i = 0
        while i < len(x) - 1:
            j = i
            while j + 1 < len(x) and x[j + 1] - x[j] < 1e-4:
                j += 1
            if j > i:  # tied run i..j: spread its knots over [x_i, x_i + width], keeping every output value
                width = gap if j + 1 >= len(x) else min(gap, (x[j + 1] - x[i]) / 2)
                x[i:j + 1] = x[i] + np.linspace(0, width, j - i + 1)
            i = j + 1
        qin[k] = x
    return qin.astype(np.float32), qout.astype(np.float32)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('shipped', type=Path)
    p.add_argument('out', type=Path)
    p.add_argument('--stream', type=Path)
    p.add_argument('--phrase', type=Path)
    p.add_argument('--safe-qmap', default='', help='comma list of nets (stream,phrase) whose quantile maps get safe_qmap')
    args = p.parse_args()
    meta = json.loads((args.shipped / 'face-text.json').read_text(encoding='utf8'))
    raw = (args.shipped / 'face-text.bin').read_bytes()
    tensors = {t['name']: np.frombuffer(raw, '<f4', count=int(np.prod(t['shape'])), offset=t['offset']).reshape(t['shape']).copy()
               for t in meta['tensors']}
    for mode, path in (('stream', args.stream), ('phrase', args.phrase)):
        if path is None:
            continue
        net = meta['nets'][mode]
        prefix = net['prefix']
        ck = torch.load(path, map_location='cpu', weights_only=False)
        if ck['channels'] != net['channels'] or list(ck['dilations']) != list(net['dilations']):
            raise SystemExit(f'{mode}: architecture differs from the shipped net')
        if ck['delay'] - meta['lookahead'] != net['shift']:
            raise SystemExit(f'{mode}: phone shift {ck["delay"] - meta["lookahead"]} != shipped {net["shift"]}')
        new = {prefix + k.replace('blocks.', 'b').replace('.weight', '.w').replace('.bias', '.b'): v.numpy() for k, v in ck['state'].items()}
        new[prefix + 'qmap_in'], new[prefix + 'qmap_out'] = ck['qin'], ck['qout']
        for name, value in new.items():
            if name not in tensors or tuple(tensors[name].shape) != tuple(value.shape):
                raise SystemExit(f'{mode}: tensor {name} missing or reshaped')
            tensors[name] = np.asarray(value, np.float32)
    for mode in [m for m in args.safe_qmap.split(',') if m]:
        prefix = meta['nets'][mode]['prefix']
        tensors[prefix + 'qmap_in'], tensors[prefix + 'qmap_out'] = safe_qmap(tensors[prefix + 'qmap_in'], tensors[prefix + 'qmap_out'])
    args.out.mkdir(parents=True, exist_ok=True)
    for name in ('face-model.json', 'face-model.bin', meta['lexicon'], 'face-lexicon-NOTICE.txt'):
        if (args.shipped / name).exists():
            shutil.copyfile(args.shipped / name, args.out / name)
    blob, table, offset = [], [], 0
    for t in meta['tensors']:  # same order and offsets as the shipped file
        b = np.ascontiguousarray(tensors[t['name']], '<f4').tobytes()
        table.append(dict(name=t['name'], offset=offset, shape=t['shape'])); blob.append(b); offset += len(b)
    assert [t['offset'] for t in table] == [t['offset'] for t in meta['tensors']]
    meta['tensors'] = table
    sha = hashlib.sha256((args.out / 'face-model.bin').read_bytes()).hexdigest()
    assert sha == meta['stage1Sha256'], 'face-model.bin does not match the face-text pairing'
    (args.out / 'face-text.bin').write_bytes(b''.join(blob))
    (args.out / 'face-text.json').write_text(json.dumps(meta, indent=1), encoding='utf8')
    print(f'{args.out}: stream={args.stream or "shipped"} phrase={args.phrase or "shipped"}')


if __name__ == '__main__':
    main()
