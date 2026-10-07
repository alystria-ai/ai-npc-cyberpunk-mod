"""Runtime-budget text conditioning: a small stage-2 network on top of the (frozen) audio model.

Stage 1 is a normal audio model trained with the phone head (lab_train --aux-phones --save-pt, e.g. the
candidate). At runtime it already runs; its phone head gives posteriors that lab_textalign's fixed-lag Viterbi
aligns to the reply text. Stage 2 sees stage 1's last hidden layer plus the aligned phones and predicts the
same controls. Phones are fed with delay D = lookahead + lag (default 23 frames), i.e. exactly what a stream
knows: labels decided `lag` output frames after stage 1 produced them. Training uses PocketSphinx labels with
+-2 frame jitter. Cost: stage 1 + a 64-channel stack (about +15 % of the current network).
"""
from __future__ import annotations

import argparse
import json
import random
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

import lab_train as lt

lm = lt.lm


class Stage2(nn.Module):
    def __init__(self, c_in, n_phones, channels, dilations, outputs):
        super().__init__()
        self.n_phones = n_phones
        self.inp = nn.Conv1d(c_in + n_phones, channels, 3)
        self.blocks = nn.ModuleList(lt.Block(channels, d) for d in dilations)
        self.out = nn.Conv1d(channels, outputs, 1)

    def forward(self, h1, lab):
        x = torch.cat([h1, nn.functional.one_hot(lab, self.n_phones).float().transpose(1, 2)], 1)
        h = torch.relu(self.inp(x))
        for b in self.blocks:
            h = b(h)
        return self.out(h).transpose(1, 2)


def load_stage1(path, device):
    ck = torch.load(path, map_location=device, weights_only=False)
    net = lt.Net(ck['channels'], ck['dilations'], len(lm.OUTPUTS), ck['n_phones'], aux=True)
    net.load_state_dict(ck['state'])
    net.to(device).eval()
    for p in net.parameters():
        p.requires_grad_(False)
    return net, ck


class Pipeline:
    """Inference: audio + raw 100 Hz labels -> (times, outputs) like NumpyModel.predict (after the quantile map)."""

    def __init__(self, path):
        self.ck = torch.load(path, map_location='cpu', weights_only=False)
        self.s1, self.ck1 = load_stage1(self.ck['stage1'], 'cpu')
        c = self.ck
        self.s2 = Stage2(self.ck1['channels'], self.ck1['n_phones'], c['channels'], c['dilations'], len(lm.OUTPUTS))
        self.s2.load_state_dict(c['state']); self.s2.eval()
        self.r1 = lm.receptive_field(self.ck1['dilations']); self.r2 = lm.receptive_field(c['dilations'])
        self.lookahead = self.ck1['lookahead']

    def predict(self, audio16k, lab):
        line = dict(audio=audio16k.astype(np.float32), y30=np.zeros((int(len(audio16k) / 16000 * 30) + 2, len(lm.OUTPUTS)), np.float32))
        if lab is not None:
            line['lab'] = lab
        f, _, _, li = lt.make_example(line, None, random.Random(0), None, self.r1 + self.r2 - 1, self.lookahead, train=False,
                                      delay=self.ck['delay'])
        x = (torch.tensor(f[None]) - torch.tensor(self.ck1['mean'])) / torch.tensor(self.ck1['std'])
        with torch.no_grad():
            _, h1 = self.s1(x, None, hidden=True)
            y = np.clip(self.s2(h1, torch.tensor(li[None, self.r1 - 1:]))[0].numpy(), 0, None) * self.ck1['scale']
        y = np.stack([np.interp(y[:, k], self.ck['qin'][k], self.ck['qout'][k]) for k in range(y.shape[1])], 1)
        y = y[self.lookahead:]
        return lm.frame_time(np.arange(len(y))), y


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--stage1', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--pack', type=Path, default=lt.LAB / 'pack')
    p.add_argument('--split', type=Path, default=lt.LAB / 'pack/split2.json')
    p.add_argument('--channels', type=int, default=64)
    p.add_argument('--dilations', default='1,2,4,8')
    p.add_argument('--lag', type=int, default=3)
    p.add_argument('--jitter', type=int, default=2)
    p.add_argument('--epochs', type=int, default=16)
    p.add_argument('--batch', type=int, default=24)
    p.add_argument('--lr', type=float, default=2e-3)
    p.add_argument('--workers', type=int, default=6)
    p.add_argument('--clean', action='store_true')
    args = p.parse_args()
    device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
    s1, ck1 = load_stage1(args.stage1, device)
    pack = lt.Pack(args.pack)
    split = json.loads(args.split.read_text())
    held = set(split['test']) | {k for v in split['charTest'].values() for k in v} | set(split['excludeTrain'])
    clean = json.loads((args.pack / 'clean.json').read_text()) if args.clean else {}
    keys = [r['key'] for r in pack.index if r['key'] not in held and r['key'] in pack.lab_index
            and not (clean.get(r['key'], {}).get('combat') or clean.get(r['key'], {}).get('effect'))]
    hours = sum(pack.by_key[k]['an'] for k in keys) / 16000 / 3600
    dil = [int(d) for d in args.dilations.split(',')]
    r1, r2 = lm.receptive_field(ck1['dilations']), lm.receptive_field(dil)
    delay = ck1['lookahead'] + args.lag
    net = Stage2(ck1['channels'], ck1['n_phones'], args.channels, dil, len(lm.OUTPUTS)).to(device)
    print(f'{len(keys)} lines ({hours:.2f} h); stage-2 {sum(p.numel() for p in net.parameters())} weights, phone delay {delay}', flush=True)
    mean_t, std_t, scale_t = (torch.tensor(ck1[k], device=device) for k in ('mean', 'std', 'scale'))
    ys = np.concatenate([pack.line(k)['y30'] for k in keys[::2]])
    weight = 1 / np.maximum(ys.std(0) / ck1['scale'], 0.05)
    weight[lm.RUNTIME_OUTPUTS:] *= 0.3
    weight[0] *= 1.5; weight[1:3] *= 1.5
    weight = torch.tensor(weight / weight.mean(), dtype=torch.float32, device=device)
    steps = max(1, int(hours * 3600 / (4 * args.batch)))
    opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps * args.epochs, pct_start=.1)
    data = lt.Stream(args.pack, keys, [], 0, 400, r1 + r2 - 1, ck1['lookahead'], args.batch, 1, None, delay, args.jitter)
    it = iter(torch.utils.data.DataLoader(data, batch_size=None, num_workers=args.workers, persistent_workers=True, prefetch_factor=4))
    began = time.time()
    for epoch in range(args.epochs):
        losses = []
        for _ in range(steps):
            x, y, _, lab_in, _ = (t.to(device, non_blocking=True) for t in next(it))
            with torch.no_grad():
                _, h1 = s1((x - mean_t) / std_t, None, hidden=True)
            pred = net(h1, lab_in[:, r1 - 1:])
            yt = y / scale_t
            err = ((pred - yt).square() * 4 * weight).mean()
            dv = (pred[:, 1:] - pred[:, :-1]) - (yt[:, 1:] - yt[:, :-1])
            loss = err + (dv.square() * 16 * weight).mean()
            opt.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
            opt.step(); sched.step()
            losses.append(float(loss.detach()))
        print(f'epoch {epoch + 1}/{args.epochs} train {np.mean(losses):.4f} ({(time.time() - began) / 60:.1f} min)', flush=True)
    net.eval()
    P, Y = [], []
    with torch.no_grad():
        for k in keys[::3]:
            line = pack.line(k)
            f, yy, _, li = lt.make_example(line, None, random.Random(0), None, r1 + r2 - 1, ck1['lookahead'], train=False, delay=delay)
            x = (torch.tensor(f[None], device=device) - mean_t) / std_t
            _, h1 = s1(x, None, hidden=True)
            P.append(np.clip(net(h1, torch.tensor(li[None, r1 - 1:], device=device))[0].cpu().numpy(), 0, None) * ck1['scale'])
            Y.append(yy)
    qin, qout = lt.fit_qmap(P, Y)
    torch.save(dict(kind='stage2', stage1=str(args.stage1), state={k: v.cpu() for k, v in net.state_dict().items()},
                    channels=args.channels, dilations=dil, delay=delay, lag=args.lag, qin=qin, qout=qout), args.out)
    print(f'saved {args.out} ({(time.time() - began) / 60:.1f} min)', flush=True)


if __name__ == '__main__':
    main()
