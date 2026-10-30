"""Export the runtime text path (bridge/jali-face-text.mjs) next to an installed face-model.

  python lab_textexport.py <stage1-head.pt> <stream-stage2.pt> <phrase-stage2.pt> <face-model-dir> <out-dir> [--threshold X]

Writes <out-dir>/face-text.json + face-text.bin (phone head, phone prior, both stage-2 nets with their quantile maps,
alignment settings, the SHA-256 of the face-model.bin it was trained on) and face-lexicon.txt, plain text (CMUdict from
Rhubarb's PocketSphinx resources, BSD-2-Clause, plus game-vocabulary pronunciations). Copies face-model.* as well so
the folder is self-contained. Weights are game-derived: keep <out-dir> under runtime/ (ignored).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
from pathlib import Path

import numpy as np
import torch

import lab_align as la
import lab_textpipe as tp

LAB = Path('E:/CyberpunkConvai-offload/work/lipsync-lab')
DEFAULTS = dict(stay=.8, priorWeight=.5, garbagePenalty=2.0, tailPenalty=4.0, confidenceWindow=100, confidenceMinRows=50,
                confidenceThreshold=1.8, blendRows=6, mouthOutputs=15, maxStates=4000)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('head', type=Path); p.add_argument('stream', type=Path); p.add_argument('phrase', type=Path)
    p.add_argument('model_dir', type=Path); p.add_argument('out', type=Path)
    p.add_argument('--threshold', type=float, default=DEFAULTS['confidenceThreshold'])
    p.add_argument('--extra-lexicon', type=Path, default=LAB / 'pack/game-vocab.dict')
    args = p.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    for name in ('face-model.json', 'face-model.bin'):
        if (args.model_dir / name).resolve() != (args.out / name).resolve():
            shutil.copyfile(args.model_dir / name, args.out / name)
    head = torch.load(args.head, map_location='cpu', weights_only=False)
    tensors = {'head.w': head['state']['aux.weight'].numpy(), 'head.b': head['state']['aux.bias'].numpy()}
    labels = np.load(LAB / 'pack/phones100.npy', mmap_mode='r')
    prior = np.bincount(np.asarray(labels[::7], np.int64), minlength=len(tp.PHONES)).astype(np.float64) + 1
    tensors['log_prior'] = np.log(prior / prior.sum()).astype(np.float32)
    nets = {}
    for mode, path, prefix in (('stream', args.stream, 's2s.'), ('phrase', args.phrase, 's2p.')):
        ck = torch.load(path, map_location='cpu', weights_only=False)
        for k, v in ck['state'].items():
            tensors[prefix + k.replace('blocks.', 'b').replace('.weight', '.w').replace('.bias', '.b')] = v.numpy()
        tensors[prefix + 'qmap_in'], tensors[prefix + 'qmap_out'] = ck['qin'], ck['qout']
        shift = ck['delay'] - head['lookahead']
        nets[mode] = dict(prefix=prefix, channels=ck['channels'], dilations=ck['dilations'], shift=shift,
                          lag=max(0, shift), decide='lag' if shift > 0 else 'full')
    blob, table, offset = [], [], 0
    for name, value in tensors.items():
        raw = np.ascontiguousarray(value, '<f4').tobytes()
        table.append(dict(name=name, offset=offset, shape=list(value.shape))); blob.append(raw); offset += len(raw)
    stage1 = hashlib.sha256((args.out / 'face-model.bin').read_bytes()).hexdigest()
    meta = dict(format='cp77-jali-text-v1', version=1, stage1Sha256=stage1, phones=tp.PHONES, lexicon='face-lexicon.txt',
                lookahead=head['lookahead'], nets=nets, tensors=table, **{**DEFAULTS, 'confidenceThreshold': args.threshold})
    (args.out / 'face-text.bin').write_bytes(b''.join(blob))
    (args.out / 'face-text.json').write_text(json.dumps(meta, indent=1), encoding='utf8')
    lex = {}
    for line in (la.SPHINX / 'cmudict-en-us.dict').read_text(encoding='utf8').splitlines():
        parts = line.split()
        if parts and '(' not in parts[0] and all(x in tp.PHONES for x in parts[1:]) and len(parts) > 1:
            lex.setdefault(parts[0], parts[1:])
    extra = 0
    if args.extra_lexicon.exists():
        for line in args.extra_lexicon.read_text(encoding='utf8').splitlines():
            parts = line.split()
            if len(parts) > 1 and parts[0] not in lex and all(x in tp.PHONES for x in parts[1:]):
                lex[parts[0]] = parts[1:]; extra += 1
    text = ''.join(f"{w} {' '.join(ph)}\n" for w, ph in sorted(lex.items()))
    # Plain text: the main file holds no archive (packaging/lib/package-guards.mjs). The release build also takes a gzip from the model bucket and unpacks it.
    (args.out / 'face-lexicon.txt').write_text(text, encoding='utf8', newline='\n')
    notice = ('face-lexicon.txt: CMU Pronouncing Dictionary as distributed with CMU Sphinx / Rhubarb Lip Sync '
              '(Copyright (c) 1993-2015 Carnegie Mellon University, BSD-2-Clause; see vendor/rhubarb-1.14.0 LICENSE.md), '
              f'plus {extra} game-vocabulary pronunciations generated with espeak-ng.\n')
    (args.out / 'face-lexicon-NOTICE.txt').write_text(notice, encoding='utf8')
    print(f'face-text: {offset / 1e6:.2f} MB, nets {nets}; lexicon {len(lex)} words ({extra} game vocabulary)')


if __name__ == '__main__':
    main()
