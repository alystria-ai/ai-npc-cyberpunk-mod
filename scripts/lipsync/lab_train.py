"""Fast experiment trainer for the game-trained lip-sync model (GPU optional, DataLoader workers).

Same network, features, augmentation and loss as lipsync_model.py (the shipped
recipe), so a run with default options is the baseline. Data comes from the
packed corpus (lab_data.py) through worker processes that share a memmap.
Research options, all off by default:

  --clean             drop combat/shouted and effect-processed lines (lab_clean.py) from training
  --actors a,b        train only on these speakers (per-character fine-tunes, with --init)
  --aux-phones W      training-only phone-classification head on the last hidden layer
                      (frame labels from lab_align.py); dropped at export, zero runtime cost
  --phone-input       ORACLE: aligned phone one-hot as extra input channels (research upper bound only)
  --acc W             acceleration-matching loss
  --out-weight k=m    multiply an output's loss weight (e.g. corner_stretch=2)
  --extra list.json   extra (audio, targets) items, e.g. cloned-voice renders with warped curves
  --distill T.pt      also match a teacher network's outputs (on corpus and --unlabeled audio)
  --channels/--dilations  network size (teachers)

Exports an .npz in the lipsync_model format (export_face_model.py turns it into
face-model.*). Research-only models (--phone-input) also save a .pt.
Outputs are derived from game data: keep them in ignored folders.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import random
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn

import lipsync_model as lm

LAB = Path('E:/CyberpunkConvai-offload/work/lipsync-lab')
N_OUT = len(lm.OUTPUTS)


# ------------------------------------------------------------------ data
class Pack:
    def __init__(self, pack: Path):
        self.dir = pack
        self.index = []
        seen = set()
        for r in json.loads((pack / 'index.json').read_text()):
            if r['key'] in seen:  # the manifest lists some lines twice (one recording used by two scenes)
                continue
            seen.add(r['key']); self.index.append(r)
        self.by_key = {r['key']: r for r in self.index}
        self.audio = None
        self.y = np.load(pack / 'y30.npy', mmap_mode='r')
        labels = pack / 'phones100.npy'
        self.labels = np.load(labels, mmap_mode='r') if labels.exists() else None
        self.lab_index = json.loads((pack / 'phones100.json').read_text()) if (pack / 'phones100.json').exists() else {}

    def line(self, key):
        if self.audio is None:
            self.audio = np.load(self.dir / 'audio.npy', mmap_mode='r')
        r = self.by_key[key]
        out = dict(key=key, actor=r['actor'], audio=np.array(self.audio[r['a']:r['a'] + r['an']], np.float32),
                   y30=np.array(self.y[r['y']:r['y'] + r['yn']], np.float32))
        if self.labels is not None and key in self.lab_index:
            o, n = self.lab_index[key]
            out['lab'] = np.array(self.labels[o:o + n], np.int64)
        # Research: runtime-decided labels (lab_runlabels.py) instead of PocketSphinx, with probability LAB_TRAIN_LABEL_MIX
        alt = os.environ.get('LAB_TRAIN_LABEL_DIR')
        if alt and 'lab' in out and random.random() < float(os.environ.get('LAB_TRAIN_LABEL_MIX', '1')):
            path = Path(alt) / f'{key}.npy'
            if path.exists():
                out['lab'] = np.load(path).astype(np.int64)
        return out


def load_extra(path):
    """Extra items: [{"audio": path.npy (16 kHz f32), "y30": path.npy, "weight": w}]"""
    items = json.loads(Path(path).read_text())
    return [dict(key=i.get('key', i['audio']), audio=np.load(i['audio']).astype(np.float32),
                 y30=np.load(i['y30']).astype(np.float32), weight=float(i.get('weight', 1))) for i in items]


SIL = 0
# PocketSphinx phone times trail the game's curves by ~60 ms (validated: P/B/M frames with JALI contact > .5
# rise from 56 % at 0 ms to 87 % at +60 ms); labels are read 60 ms later so they describe the articulation.
LAB_SHIFT = 6


def speed_labels(lab, n_audio_new):
    """Nearest-neighbour time scaling of 100 Hz labels to the resampled audio length."""
    n_new = max(1, int(round(n_audio_new / lm.HOP)))
    src = np.minimum((np.arange(n_new) * len(lab) / n_new).astype(int), len(lab) - 1)
    return lab[src]


def make_example(line, rng, pyrng, seg, receptive, lookahead, train=True, phone_input=False, n_phones=0, delay=0, jitter=0):
    audio, y30, lab = line['audio'], line['y30'], line.get('lab')
    if train and pyrng.random() < .5:
        factor = pyrng.uniform(.88, 1.12)
        n0 = len(audio)
        audio, y30 = lm.speed(audio, y30, factor)
        if lab is not None:
            lab = speed_labels(lab, len(audio))
    if train:
        audio = lm.augment(audio, rng)
    lead = int(pyrng.uniform(0, .3) * lm.SAMPLE_RATE) if train else 0
    audio = np.concatenate([np.zeros(lead, np.float32), audio, np.zeros(lm.SAMPLE_RATE // 2, np.float32)])
    y30 = np.concatenate([np.zeros((int(round(lead / lm.SAMPLE_RATE * 30)), y30.shape[1]), np.float32), y30])
    f = lm.log_mel(audio)
    y = lm.frame_targets(y30, len(f), lookahead)
    if lab is not None:
        # label at audio time of each feature frame centre (lab index k = time k*10 ms)
        lab_t = np.concatenate([np.full(int(round(lead / lm.HOP)), SIL, np.int64), lab])
        k_audio = np.round(lm.frame_time(np.arange(len(f))) * 100).astype(int) + LAB_SHIFT
        lab_frames = np.where(k_audio < len(lab_t), lab_t[np.minimum(k_audio, len(lab_t) - 1)], SIL)
        k_out = np.arange(len(f)) - lookahead  # output frame t describes audio frame t - lookahead
        lab_out = np.where(k_out >= 0, lab_frames[np.maximum(k_out, 0)], SIL)
    else:
        lab_frames = lab_out = np.full(len(f), -100, np.int64)
    f = np.concatenate([np.full((receptive - 1, lm.N_MELS), lm.SILENCE, np.float32), f])
    lab_src = np.maximum(lab_frames, 0)
    shift = delay + (pyrng.randint(-jitter, jitter) if (train and jitter) else 0)
    if shift > 0:  # phone input known only up to `delay` frames before the newest audio frame (streaming)
        lab_src = np.concatenate([np.full(shift, SIL, np.int64), lab_src[:-shift]])
    elif shift < 0:
        lab_src = np.concatenate([lab_src[-shift:], np.full(-shift, SIL, np.int64)])
    lab_in = np.concatenate([np.full(receptive - 1, SIL, np.int64), lab_src])
    if seg is None:
        return f, y, lab_out, lab_in
    if len(y) > seg:
        s = pyrng.randrange(len(y) - seg)
        return f[s:s + seg + receptive - 1], y[s:s + seg], lab_out[s:s + seg], lab_in[s:s + seg + receptive - 1]
    pad = seg - len(y)
    return (np.concatenate([f, np.full((pad, lm.N_MELS), lm.SILENCE, np.float32)]),
            np.concatenate([y, np.zeros((pad, y.shape[1]), np.float32)]),
            np.concatenate([lab_out, np.full(pad, -100, np.int64)]),
            np.concatenate([lab_in, np.full(pad, SIL, np.int64)]))


class Stream(torch.utils.data.IterableDataset):
    def __init__(self, pack_dir, keys, extra, extra_ratio, seg, receptive, lookahead, batch, seed, unlabeled=None, delay=0, jitter=0):
        self.delay, self.jitter = delay, jitter
        self.pack_dir, self.keys, self.extra, self.extra_ratio = pack_dir, keys, extra, extra_ratio
        self.seg, self.receptive, self.lookahead, self.batch, self.seed = seg, receptive, lookahead, batch, seed
        self.unlabeled = unlabeled or []

    def __iter__(self):
        info = torch.utils.data.get_worker_info()
        wid = info.id if info else 0
        rng, pyrng = np.random.default_rng(self.seed * 1000 + wid), random.Random(self.seed * 1000 + wid)
        pack = Pack(self.pack_dir)
        while True:
            xs, ys, lo, li, src = [], [], [], [], []
            for _ in range(self.batch):
                u = pyrng.random()
                if self.extra and u < self.extra_ratio:
                    line, s = self.extra[pyrng.randrange(len(self.extra))], 1
                elif self.unlabeled and u > 1 - .25:
                    line, s = self.unlabeled[pyrng.randrange(len(self.unlabeled))], 2
                else:
                    line, s = pack.line(self.keys[pyrng.randrange(len(self.keys))]), 0
                f, y, a, b = make_example(line, rng, pyrng, self.seg, self.receptive, self.lookahead, delay=self.delay, jitter=self.jitter)
                xs.append(f); ys.append(y); lo.append(a); li.append(b); src.append(s)
            yield (torch.from_numpy(np.stack(xs)), torch.from_numpy(np.stack(ys)), torch.from_numpy(np.stack(lo)),
                   torch.from_numpy(np.stack(li)), torch.tensor(src))


# ------------------------------------------------------------------ model
class Net(nn.Module):
    """lipsync_model's network plus optional training-only aux head and oracle phone input."""

    def __init__(self, channels, dilations, outputs, n_phones=0, aux=False, phone_input=False):
        super().__init__()
        self.phone_input = phone_input
        extra = n_phones if phone_input else 0
        self.inp = nn.Conv1d(lm.N_MELS + extra, channels, 3)
        self.blocks = nn.ModuleList(Block(channels, d) for d in dilations)
        self.out = nn.Conv1d(channels, outputs, 1)
        self.aux = nn.Conv1d(channels, n_phones, 1) if aux else None
        self.n_phones = n_phones

    def forward(self, x, lab_in=None, hidden=False):
        h = x.transpose(1, 2)
        if self.phone_input:
            h = torch.cat([h, nn.functional.one_hot(lab_in, self.n_phones).float().transpose(1, 2)], 1)
        h = torch.relu(self.inp(h))
        for b in self.blocks:
            h = b(h)
        y = self.out(h).transpose(1, 2)
        return (y, h) if hidden else y


class Block(nn.Module):
    def __init__(self, c, d):
        super().__init__()
        self.d = d
        self.c1 = nn.Conv1d(c, c, 3, dilation=d)
        self.c2 = nn.Conv1d(c, c, 1)

    def forward(self, x):
        return torch.relu(x[:, :, 2 * self.d:] + self.c2(torch.relu(self.c1(x))))


def load_init(net, path):
    old = np.load(path, allow_pickle=False)
    state = net.state_dict()
    for name, value in state.items():
        key = name.replace('blocks.', 'b').replace('.weight', '.w').replace('.bias', '.b')
        if key in old.files:
            src = torch.tensor(old[key])
            if src.shape == value.shape:
                state[name] = src
            elif name == 'inp.weight' and src.shape[1] < value.shape[1]:
                state[name][:, :src.shape[1]] = src
            elif name.startswith('out.'):
                state[name][:src.shape[0]] = src
    net.load_state_dict(state)
    stats = {k: old[k] for k in ('feat_mean', 'feat_std', 'out_scale') if k in old.files}
    return stats


def export_npz(net, out, meta_extra, mean, std, scale, dil, lookahead, channels, qin=None, qout=None):
    arrays = {}
    for k, v in net.state_dict().items():
        if k.startswith('aux.'):
            continue
        arrays[k.replace('blocks.', 'b').replace('.weight', '.w').replace('.bias', '.b')] = v.detach().cpu().numpy().astype(np.float32)
    arrays.update(feat_mean=mean.astype(np.float32), feat_std=std.astype(np.float32), out_scale=scale.astype(np.float32))
    if qin is not None:
        arrays.update(qmap_in=qin, qmap_out=qout)
    meta = dict(version=1, format='cp77-jali-audio2face-v1', lookahead=lookahead, channels=channels,
                dilations=dil, receptive=lm.receptive_field(dil), outputs=[o[0] for o in lm.OUTPUTS],
                runtimeOutputs=lm.RUNTIME_OUTPUTS, sampleRate=lm.SAMPLE_RATE, hop=lm.HOP, window=lm.WINDOW, nfft=lm.N_FFT,
                mels=lm.N_MELS, silence=lm.SILENCE, lab=meta_extra)
    np.savez(out, meta=json.dumps(meta), **arrays)


def predict_lines(net, lines, mean_t, std_t, scale, receptive, lookahead, device, batch=16, delay=0):
    """Whole-utterance predictions (raw, before quantile map) for lines, in output units."""
    net.eval()
    P, Y = [], []
    pyrng = random.Random(0)
    with torch.no_grad():
        for l in lines:
            f, y, _, li = make_example(l, None, pyrng, None, receptive, lookahead, train=False, delay=delay)
            x = (torch.tensor(f[None], device=device) - mean_t) / std_t
            p = net(x, torch.tensor(li[None], device=device))
            P.append(np.clip(p[0].cpu().numpy(), 0, None) * scale)
            Y.append(y)
    net.train()
    return P, Y


def fit_qmap(P, Y, points=65):
    P, Y = np.concatenate(P), np.concatenate(Y)
    q = np.linspace(0, 100, points)
    qin = np.percentile(P, q, axis=0).T.astype(np.float32)
    qout = np.percentile(Y, q, axis=0).T.astype(np.float32)
    for k in range(qin.shape[0]):
        qin[k] = np.maximum.accumulate(qin[k]) + np.arange(points, dtype=np.float32) * 1e-6
        qout[k] = np.maximum.accumulate(qout[k])
    return qin, qout


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--pack', type=Path, default=LAB / 'pack')
    p.add_argument('--split', type=Path, default=LAB / 'pack/split2.json')
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--device', default='cuda' if torch.cuda.is_available() else 'cpu')
    p.add_argument('--workers', type=int, default=10)
    p.add_argument('--threads', type=int, default=4)
    p.add_argument('--epochs', type=int, default=24)
    p.add_argument('--steps', type=int, default=0, help='steps per epoch (default: train hours * 3600 / (4 * batch))')
    p.add_argument('--batch', type=int, default=24)
    p.add_argument('--lr', type=float, default=2e-3)
    p.add_argument('--pct-start', type=float, default=.1)
    p.add_argument('--lookahead', type=int, default=20)
    p.add_argument('--channels', type=int, default=160)
    p.add_argument('--dilations', default='1,2,4,8,16,1')
    p.add_argument('--vel', type=float, default=1.0)
    p.add_argument('--acc', type=float, default=0.0)
    p.add_argument('--var', type=float, default=0.0, help='per-sequence, per-control std matching loss')
    p.add_argument('--peak', type=float, default=0.0, help='MSE frame weight 1 + peak * target')
    p.add_argument('--clean', action='store_true')
    p.add_argument('--actors', default='')
    p.add_argument('--focus', default='', help='oversample these speakers to --focus-ratio of the batches (keeps the rest)')
    p.add_argument('--focus-ratio', type=float, default=.5)
    p.add_argument('--init', type=Path)
    p.add_argument('--keep-stats', action='store_true', help='reuse feature/output normalisation from --init')
    p.add_argument('--aux-phones', type=float, default=0.0)
    p.add_argument('--phone-input', action='store_true')
    p.add_argument('--phone-delay', type=int, default=0, help='phone input lags the audio by this many 10 ms frames')
    p.add_argument('--phone-jitter', type=int, default=0, help='random +-frames offset of phone input in training')
    p.add_argument('--out-weight', action='append', default=[])
    p.add_argument('--extra', type=Path)
    p.add_argument('--extra-ratio', type=float, default=.3)
    p.add_argument('--extra-only', action='store_true')
    p.add_argument('--distill', type=Path, help='teacher .pt (lab_train --save-pt)')
    p.add_argument('--distill-weight', type=float, default=1.0)
    p.add_argument('--unlabeled', type=Path, help='unlabeled audio list for distillation: [{"audio": path.npy}]')
    p.add_argument('--save-pt', action='store_true')
    p.add_argument('--seed', type=int, default=1)
    args = p.parse_args()
    torch.manual_seed(args.seed)
    torch.set_num_threads(args.threads)
    device = torch.device(args.device)
    pack = Pack(args.pack)
    split = json.loads(args.split.read_text())
    held = set(split['test']) | {k for v in split['charTest'].values() for k in v} | set(split['excludeTrain'])
    clean = json.loads((args.pack / 'clean.json').read_text()) if args.clean else {}
    actors = set(a for a in args.actors.split(',') if a)
    keys = [r['key'] for r in pack.index if r['key'] not in held and not (clean.get(r['key'], {}).get('combat') or clean.get(r['key'], {}).get('effect'))
            and (not actors or r['actor'] in actors)]
    n_phones = 0
    if args.aux_phones or args.phone_input:
        phones = json.loads((args.pack / 'phones100.json').read_text())
        n_phones = len(phones['__phones__']) if '__phones__' in phones else 0
        keys = [k for k in keys if k in pack.lab_index] if args.phone_input else keys
    hours = sum(pack.by_key[k]['an'] for k in keys) / lm.SAMPLE_RATE / 3600
    focus = set(a for a in args.focus.split(',') if a)
    sample_keys = keys
    if focus:
        fk = [k for k in keys if pack.by_key[k]['actor'] in focus]
        rest = [k for k in keys if pack.by_key[k]['actor'] not in focus]
        reps = max(1, round(args.focus_ratio / (1 - args.focus_ratio) * len(rest) / max(1, len(fk))))
        sample_keys = rest + fk * reps
        print(f'focus {sorted(focus)}: {len(fk)} lines x{reps}', flush=True)
    extra = load_extra(args.extra) if args.extra else []
    unlabeled = []
    if args.unlabeled:
        for i in json.loads(args.unlabeled.read_text()):
            a = np.load(i['audio']).astype(np.float32)
            unlabeled.append(dict(key=i['audio'], audio=a, y30=np.zeros((int(len(a) / lm.SAMPLE_RATE * 30) + 1, N_OUT), np.float32)))
    print(f'{len(keys)} training lines ({hours:.2f} h), {len(extra)} extra, {len(unlabeled)} unlabeled; device {device}', flush=True)
    dil = [int(d) for d in args.dilations.split(',')]
    receptive = lm.receptive_field(dil)
    net = Net(args.channels, dil, N_OUT, n_phones, aux=args.aux_phones > 0, phone_input=args.phone_input)
    sample = [pack.line(k) for k in keys[::4]]
    if args.init:
        stats = load_init(net, args.init)
    if args.init and args.keep_stats:
        mean, std, scale = stats['feat_mean'], stats['feat_std'], stats['out_scale']
    else:
        feats = np.concatenate([lm.log_mel(l['audio']) for l in sample])
        mean, std = feats.mean(0), feats.std(0) + 1e-3
        ys = np.concatenate([pack.line(k)['y30'] for k in keys])
        scale = np.maximum(np.percentile(ys, 99.5, axis=0), 0.02).astype(np.float32)
    ys = np.concatenate([pack.line(k)['y30'] for k in keys])
    weight = 1 / np.maximum(ys.std(0) / scale, 0.05)
    weight[lm.RUNTIME_OUTPUTS:] *= 0.3
    names = [o[0] for o in lm.OUTPUTS]
    for name in lm.UPPER_OUTPUTS:
        weight[names.index(name)] *= 2
    weight[0] *= 1.5
    weight[1:3] *= 1.5
    for item in args.out_weight:
        k, m = item.split('=')
        weight[names.index(k)] *= float(m)
    weight = torch.tensor(weight / weight.mean(), dtype=torch.float32, device=device)
    net.to(device)
    teacher = None
    if args.distill:
        ck = torch.load(args.distill, map_location=device, weights_only=False)
        teacher = Net(ck['channels'], ck['dilations'], N_OUT).to(device)
        teacher.load_state_dict({k: v for k, v in ck['state'].items() if not k.startswith('aux.')}, strict=False)
        teacher.eval()
        t_mean, t_std, t_scale = (torch.tensor(ck[k], device=device) for k in ('mean', 'std', 'scale'))
        t_receptive = lm.receptive_field(ck['dilations'])
    r_max = max(receptive, t_receptive if teacher is not None else 0)
    opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-4)
    steps = args.steps or max(1, int(hours * 3600 / (4 * args.batch)))
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps * args.epochs, pct_start=args.pct_start)
    data = Stream(args.pack, sample_keys, extra if not args.extra_only else extra, 1.0 if args.extra_only else args.extra_ratio,
                  400, r_max, args.lookahead, args.batch, args.seed, unlabeled, args.phone_delay, args.phone_jitter)
    loader = torch.utils.data.DataLoader(data, batch_size=None, num_workers=args.workers, persistent_workers=args.workers > 0,
                                         prefetch_factor=4 if args.workers else None)
    it = iter(loader)
    mean_t, std_t, scale_t = (torch.tensor(a, device=device) for a in (mean, std, scale))
    began = time.time()
    ce = nn.CrossEntropyLoss(ignore_index=-100)
    for epoch in range(args.epochs):
        losses = []
        for _ in range(steps):
            x, y, lab_out, lab_in, src = (t.to(device, non_blocking=True) for t in next(it))
            xs = (x[:, r_max - receptive:] - mean_t) / std_t
            li = lab_in[:, r_max - receptive:]
            if args.aux_phones:
                pred, hid = net(xs, li, hidden=True)
            else:
                pred = net(xs, li)
            yt = y / scale_t
            labelled = (src != 2).float()[:, None, None]
            diff = (pred - yt).square() * 4 * labelled
            if args.peak:
                diff = diff * (1 + args.peak * yt.clamp(0, 1.5))
            err = (diff * weight).mean()
            dv = (pred[:, 1:] - pred[:, :-1]) - (yt[:, 1:] - yt[:, :-1])
            vel = (dv.square() * 16 * labelled * weight).mean()
            loss = err + args.vel * vel
            if args.var:  # per sequence and control: match the authored curve's temporal spread (anti regression-to-mean)
                loss = loss + args.var * ((pred.clamp(min=0).std(1) - yt.std(1)).square() * 4 * labelled[:, 0] * weight).mean()
            if args.acc:
                da = (pred[:, 2:] - 2 * pred[:, 1:-1] + pred[:, :-2]) - (yt[:, 2:] - 2 * yt[:, 1:-1] + yt[:, :-2])
                loss = loss + args.acc * (da.square() * 64 * labelled * weight).mean()
            if args.aux_phones:
                logits = net.aux(hid).transpose(1, 2)
                loss = loss + args.aux_phones * ce(logits.reshape(-1, n_phones), lab_out.reshape(-1))
            if teacher is not None:
                with torch.no_grad():
                    tx = (x[:, r_max - t_receptive:] - t_mean) / t_std
                    ty = torch.clamp(teacher(tx), min=0) * t_scale / scale_t
                dd = (pred - ty).square() * 4
                loss = loss + args.distill_weight * (dd * weight).mean()
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
            opt.step()
            sched.step()
            losses.append(float(loss.detach()))
        print(f'epoch {epoch + 1}/{args.epochs} train {np.mean(losses):.4f} ({(time.time() - began) / 60:.1f} min)', flush=True)
    net.eval()
    qlines = [pack.line(k) for k in keys[::3]]
    P, Y = predict_lines(net, qlines, mean_t, std_t, scale, receptive, args.lookahead, device, delay=args.phone_delay)
    qin, qout = fit_qmap(P, Y)
    lab = dict(args={k: str(v) for k, v in vars(args).items()}, trainLines=len(keys), trainHours=hours)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    export_npz(net.cpu(), args.out, lab, mean, std, scale, dil, args.lookahead, args.channels, qin, qout)
    if args.save_pt or args.phone_input:
        torch.save(dict(state=net.state_dict(), channels=args.channels, dilations=dil, mean=mean, std=std, scale=scale,
                        qin=qin, qout=qout, lookahead=args.lookahead, n_phones=n_phones, phone_input=args.phone_input, phone_delay=args.phone_delay),
                   args.out.with_suffix('.pt'))
    print(f'exported {args.out} ({(time.time() - began) / 60:.1f} min)', flush=True)


if __name__ == '__main__':
    main()
