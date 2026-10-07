"""Fit the phone-posterior head onto a FROZEN exported audio model (the installed face-model).

lab_train drops the training-only phone head at export. The text path needs it at runtime, and it must sit on
exactly the shipped stage-1 weights, so this refits only the 1x1 head (160 -> 40 phones, cross-entropy on the
PocketSphinx labels, same label timing as lab_train) on the frozen network and writes a lab_train-style .pt that
lab_stage2 / lab_textalign / lab_textpipe accept as --stage1.

  python lab_auxhead.py <model.npz> <out.pt> [--epochs 3]
"""
from __future__ import annotations

import argparse
import json
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

import lab_train as lt

lm = lt.lm


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('model', type=Path)
    p.add_argument('out', type=Path)
    p.add_argument('--pack', type=Path, default=lt.LAB / 'pack')
    p.add_argument('--split', type=Path, default=lt.LAB / 'pack/split2.json')
    p.add_argument('--epochs', type=int, default=3)
    p.add_argument('--batch', type=int, default=24)
    p.add_argument('--lr', type=float, default=3e-3)
    p.add_argument('--workers', type=int, default=6)
    args = p.parse_args()
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    data = np.load(args.model, allow_pickle=False)
    meta = json.loads(str(data['meta']))
    phones = json.loads((args.pack / 'phones100.json').read_text())['__phones__']
    net = lt.Net(meta['channels'], meta['dilations'], len(lm.OUTPUTS), len(phones), aux=True)
    lt.load_init(net, args.model)
    for name, param in net.named_parameters():
        param.requires_grad_(name.startswith('aux.'))
    net.to(device)
    pack = lt.Pack(args.pack)
    split = json.loads(args.split.read_text())
    held = set(split['test']) | {k for v in split['charTest'].values() for k in v} | set(split['excludeTrain'])
    keys = [r['key'] for r in pack.index if r['key'] not in held and r['key'] in pack.lab_index]
    hours = sum(pack.by_key[k]['an'] for k in keys) / 16000 / 3600
    receptive = lm.receptive_field(meta['dilations'])
    steps = max(1, int(hours * 3600 / (4 * args.batch)))
    opt = torch.optim.AdamW(net.aux.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps * args.epochs, pct_start=.1)
    stream = lt.Stream(args.pack, keys, [], 0, 400, receptive, meta['lookahead'], args.batch, 3)
    it = iter(torch.utils.data.DataLoader(stream, batch_size=None, num_workers=args.workers, persistent_workers=True, prefetch_factor=4))
    mean_t, std_t = torch.tensor(data['feat_mean'], device=device), torch.tensor(data['feat_std'], device=device)
    ce = nn.CrossEntropyLoss(ignore_index=-100)
    net.eval()  # no dropout/batchnorm anyway; frozen trunk
    began = time.time()
    for epoch in range(args.epochs):
        losses, hits, total = [], 0, 0
        for _ in range(steps):
            x, _, lab_out, _, _ = (t.to(device, non_blocking=True) for t in next(it))
            with torch.no_grad():
                _, h = net((x - mean_t) / std_t, None, hidden=True)
            logits = net.aux(h).transpose(1, 2)
            loss = ce(logits.reshape(-1, len(phones)), lab_out.reshape(-1))
            opt.zero_grad(); loss.backward(); opt.step(); sched.step()
            losses.append(float(loss))
            valid = lab_out >= 0
            hits += int((logits.argmax(-1)[valid] == lab_out[valid]).sum()); total += int(valid.sum())
        print(f'epoch {epoch + 1}/{args.epochs} ce {np.mean(losses):.3f} frame acc {hits / max(1, total):.3f} '
              f'({(time.time() - began) / 60:.1f} min)', flush=True)
    state = {k: v.detach().cpu() for k, v in net.state_dict().items()}
    torch.save(dict(state=state, channels=meta['channels'], dilations=meta['dilations'], mean=data['feat_mean'],
                    std=data['feat_std'], scale=data['out_scale'], qin=data['qmap_in'], qout=data['qmap_out'],
                    lookahead=meta['lookahead'], n_phones=len(phones), phone_input=False, phone_delay=0,
                    source=str(args.model)), args.out)
    print(f'saved {args.out}')


if __name__ == '__main__':
    main()
