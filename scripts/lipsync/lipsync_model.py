"""Audio -> native Cyberpunk mouth controls, learned from the game's own JALI lipsync.

Input: 16 kHz mono speech. Features: 80-band log-mel, 25 ms window, 10 ms hop.
Network: dilated 1-D convolutions without padding ("valid"), applied to
features left-padded with digital silence. Output frame t describes audio
frame t - LOOKAHEAD, so a stream emits poses LOOKAHEAD frames behind its audio,
and any window of a long stream can be recomputed exactly from its left context.
Outputs are symmetric JALI controls in LipsyncPoseOutput units (the units the
mod's ConvaiFace feature adds to); left/right pairs are mirrored at runtime.

Training needs PyTorch (CPU is fine); NumpyModel and bridge/jali-face-model.mjs
need no ML runtime. Trained weights are derived from game data: keep them local
(runtime/), never commit or redistribute them.
"""
from __future__ import annotations

import argparse
import json
import random
import time
from pathlib import Path

import numpy as np

SAMPLE_RATE, HOP, WINDOW, N_FFT, N_MELS = 16000, 160, 400, 512, 80
FRAME_RATE = SAMPLE_RATE // HOP
SILENCE = -10.0  # log10 floor of digital silence
OUTPUTS = [  # (output name, native controls it drives)
    ('jaw', ['jaw_mid_open']),
    ('together_up', ['lips_together_up']),
    ('together_dn', ['lips_together_dn']),
    ('purse', ['lips_l_purse', 'lips_r_purse']),
    ('funnel', ['lips_l_funnel', 'lips_r_funnel']),
    ('corner_stretch', ['lips_l_corner_stretch', 'lips_r_corner_stretch']),
    ('stretch', ['lips_l_stretch', 'lips_r_stretch']),
    ('lower_raise', ['lips_l_lower_raise', 'lips_r_lower_raise']),
    ('upper_raise', ['lips_l_upper_raise', 'lips_r_upper_raise']),
    ('suck_up', ['lips_suck_up']),
    ('suck_dn', ['lips_suck_dn']),
    ('puff', ['lips_puff_up', 'lips_puff_dn']),
    ('cheek_puff', ['cheek_l_puff', 'cheek_r_puff']),
    ('tongue_tip_up', ['tongue_mid_tip_up']),
    ('tongue_fwd', ['tongue_mid_fwd']),
    # Research-only below: not driven in game (expression or not in the 50-control graph).
    ('corner_up', ['lips_l_corner_up', 'lips_r_corner_up']),
    ('corner_dn', ['lips_l_corner_dn', 'lips_r_corner_dn']),
    ('pull', ['lips_l_pull', 'lips_r_pull']),
    ('chin_raise', ['lips_chin_raise']),
    ('tongue_base_up', ['tongue_mid_base_up']),
    ('tongue_lift', ['tongue_mid_lift']),
    # Upper face that follows the voice (emphasis brow flashes, frowning focus).
    # Not mouth controls: the runtime hands them to the expression layer.
    ('brows_raise', ['eye_l_brows_raise_in', 'eye_r_brows_raise_in', 'eye_l_brows_raise_out', 'eye_r_brows_raise_out']),
    ('brows_lower', ['eye_l_brows_lower', 'eye_r_brows_lower']),
]
UPPER_OUTPUTS = ['brows_raise', 'brows_lower']
RUNTIME_OUTPUTS = 15
# Same bounds as bridge/jali-face.mjs JALI_LIMITS and mod/facial-playback.lua.
LIMITS = {'jaw_mid_open': .7, 'lips_together_up': 1, 'lips_together_dn': 1, 'lips_suck_dn': .8, 'lips_suck_up': .3,
          'lips_puff_up': .45, 'lips_puff_dn': .45, 'cheek_l_puff': .35, 'cheek_r_puff': .35}


def mel_filterbank():
    def hz_to_mel(f): return 2595 * np.log10(1 + f / 700)
    def mel_to_hz(m): return 700 * (10 ** (m / 2595) - 1)
    hz = mel_to_hz(np.linspace(hz_to_mel(40), hz_to_mel(7600), N_MELS + 2))
    bins = np.fft.rfftfreq(N_FFT, 1 / SAMPLE_RATE)
    fb = np.zeros((N_MELS, len(bins)))
    for i in range(N_MELS):
        lo, mid, hi = hz[i], hz[i + 1], hz[i + 2]
        fb[i] = np.clip(np.minimum((bins - lo) / (mid - lo), (hi - bins) / (hi - mid)), 0, None)
    fb *= (2 / (hz[2:] - hz[:-2]))[:, None]
    return fb.astype(np.float32)


MEL_FB = mel_filterbank()
WIN = np.hanning(WINDOW + 2)[1:-1].astype(np.float32)


def log_mel(audio: np.ndarray) -> np.ndarray:
    """Non-centred frames: frame k covers samples [k*HOP, k*HOP+WINDOW). Shape (frames, N_MELS)."""
    audio = np.asarray(audio, dtype=np.float32)
    frames = 0 if len(audio) < WINDOW else (len(audio) - WINDOW) // HOP + 1
    if frames == 0:
        return np.zeros((0, N_MELS), np.float32)
    idx = np.arange(frames)[:, None] * HOP + np.arange(WINDOW)[None, :]
    spec = np.abs(np.fft.rfft(audio[idx] * WIN, n=N_FFT)) ** 2
    return np.log10(np.maximum(spec @ MEL_FB.T, 1e-10)).astype(np.float32)


def frame_time(k):
    """Centre of feature frame k, seconds."""
    return (np.asarray(k) * HOP + WINDOW / 2) / SAMPLE_RATE


def receptive_field(dilations):
    return 3 + sum(2 * d for d in dilations)


# ---------------------------------------------------------------- inference
class NumpyModel:
    """Pure-NumPy forward pass of the exported network."""

    def __init__(self, params: dict, meta: dict):
        self.p, self.meta = params, meta
        self.lookahead = int(meta['lookahead'])
        self.dilations = meta['dilations']
        self.receptive = receptive_field(self.dilations)

    @classmethod
    def load(cls, path):
        data = np.load(path, allow_pickle=False)
        meta = json.loads(str(data['meta']))
        return cls({k: data[k].astype(np.float32) for k in data.files if k != 'meta'}, meta)

    @staticmethod
    def _conv(x, w, b, dilation):
        k = w.shape[2]
        T = x.shape[0] - (k - 1) * dilation
        out = np.empty((T, w.shape[0]), np.float32)
        out[:] = b
        for j in range(k):
            out += x[j * dilation: j * dilation + T] @ w[:, :, j].T
        return out

    def forward(self, feats: np.ndarray) -> np.ndarray:
        """feats (T, N_MELS) raw log-mel from utterance start; returns (T, outputs)."""
        p = self.p
        x = np.concatenate([np.full((self.receptive - 1, N_MELS), SILENCE, np.float32), feats])
        x = (x - p['feat_mean']) / p['feat_std']
        h = np.maximum(self._conv(x, p['inp.w'], p['inp.b'], 1), 0)
        for i, d in enumerate(self.dilations):
            inner = np.maximum(self._conv(h, p[f'b{i}.c1.w'], p[f'b{i}.c1.b'], d), 0)
            h = np.maximum(h[2 * d:] + inner @ p[f'b{i}.c2.w'][:, :, 0].T + p[f'b{i}.c2.b'], 0)
        y = np.clip(h @ p['out.w'][:, :, 0].T + p['out.b'], 0, None) * p['out_scale']
        if 'qmap_in' in p:  # per-output monotone map restoring the game's value distribution
            y = np.stack([np.interp(y[:, k], p['qmap_in'][k], p['qmap_out'][k]) for k in range(y.shape[1])], 1)
        return y.astype(np.float32)

    def predict(self, audio16k: np.ndarray):
        """Whole utterance. Returns (times seconds, outputs) aligned to audio time."""
        feats = log_mel(np.concatenate([audio16k, np.zeros(self.lookahead * HOP, np.float32)]))
        y = self.forward(feats)[self.lookahead:]
        return frame_time(np.arange(len(y))), y

    def timeline(self, audio16k: np.ndarray, rate: int = 60):
        """Native-control timeline: (track names, frames [[t, values...]]) at `rate` Hz."""
        times, y = self.predict(audio16k)
        duration = len(audio16k) / SAMPLE_RATE
        t = np.append(np.arange(0, duration, 1 / rate), duration)
        tracks, cols = [], []
        for k, (_, controls) in enumerate(OUTPUTS[:RUNTIME_OUTPUTS]):
            values = np.interp(t, times, y[:, k])
            for c in controls:
                tracks.append(c)
                cols.append(np.clip(values, 0, LIMITS.get(c, .5)))
        edge = np.clip(np.minimum(t / .04, (duration - t) / .04), 0, 1)
        return tracks, np.column_stack([t] + [c * edge for c in cols])


# ----------------------------------------------------------------- training
def build_torch(channels, dilations, outputs):
    import torch
    import torch.nn as nn

    class Block(nn.Module):
        def __init__(self, c, d):
            super().__init__()
            self.d = d
            self.c1 = nn.Conv1d(c, c, 3, dilation=d)
            self.c2 = nn.Conv1d(c, c, 1)

        def forward(self, x):
            return torch.relu(x[:, :, 2 * self.d:] + self.c2(torch.relu(self.c1(x))))

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            self.inp = nn.Conv1d(N_MELS, channels, 3)
            self.blocks = nn.ModuleList(Block(channels, d) for d in dilations)
            self.out = nn.Conv1d(channels, outputs, 1)

        def forward(self, x):  # x (B, T + receptive - 1, N_MELS) normalised, left context included
            h = torch.relu(self.inp(x.transpose(1, 2)))
            for b in self.blocks:
                h = b(h)
            return self.out(h).transpose(1, 2)

    return Net()


def load_corpus(corpus: Path, names: list[str], manifest: str = 'manifest.jsonl'):
    lps = {n[:-len('LipsyncPoseOutput')]: i for i, n in enumerate(names) if n.endswith('LipsyncPoseOutput')}
    cols = [[lps[c] for c in controls] for _, controls in OUTPUTS]
    lines = []
    for row in (corpus / manifest).read_text(encoding='utf8').splitlines():
        if not row.strip():
            continue
        m = json.loads(row)
        path = corpus / 'lines' / f"{m['key']}.npz"
        if not path.exists():
            continue
        d = np.load(path)
        tr = d['tracks']
        y = np.stack([tr[:, c].mean(axis=1) for c in cols], 1).astype(np.float32)
        if y[:, 0].max() < 0.05:  # no authored jaw motion: placeholder/grunt
            continue
        lines.append(dict(key=m['key'], actor=m['actor'], audio=d['audio16k'].astype(np.float32), y30=y))
    return lines


HELD_OUT = {'kerry', 'takemura', 'rogue', 'mitch'}
KEEP_IN_TRAIN = {'judy', 'johnny', 'panam', 'jackie', 'v', 'river', 'evelyn', 'regina_reggie_jones'}


def split_lines(lines, seed=3):
    actors = sorted({l['actor'] for l in lines})
    others = [a for a in actors if a not in HELD_OUT and a not in KEEP_IN_TRAIN]
    random.Random(seed).shuffle(others)
    held = HELD_OUT | set(others[:max(1, len(others) // 8)])
    return [l for l in lines if l['actor'] not in held], [l for l in lines if l['actor'] in held]


def augment(audio, rng):
    from scipy.signal import lfilter, butter, sosfilt
    x = audio * 10 ** (rng.uniform(-14, 6) / 20)
    if rng.random() < .5:  # spectral tilt
        a = rng.uniform(-.6, .6)
        x = lfilter([1, -a], [1], x) / (1 + abs(a)) * 1.5
    if rng.random() < .3:  # band limit
        x = sosfilt(butter(6, rng.uniform(3800, 7500), fs=SAMPLE_RATE, output='sos'), x)
    if rng.random() < .5:
        x = x + rng.normal(0, 10 ** (rng.uniform(-85, -45) / 20), size=x.shape)
    return np.asarray(x, np.float32)


def speed(audio, y30, factor):
    from scipy.signal import resample_poly
    up, down = int(round(100 / factor)), 100
    a = resample_poly(audio, up, down).astype(np.float32)
    t_new = np.arange(int(len(y30) * up / down)) / 30
    y = np.stack([np.interp(t_new * down / up, np.arange(len(y30)) / 30, y30[:, k]) for k in range(y30.shape[1])], 1)
    return a, y.astype(np.float32)


def frame_targets(y30, frames, lookahead):
    """Targets for output frames 0..frames-1 (output t describes audio frame t - lookahead)."""
    t = frame_time(np.arange(frames) - lookahead)
    src = np.arange(len(y30)) / 30
    y = np.stack([np.interp(t, src, y30[:, k], left=0, right=0) for k in range(y30.shape[1])], 1)
    return y.astype(np.float32)


def example(line, rng, pyrng, seg, receptive, lookahead, train=True):
    audio, y30 = line['audio'], line['y30']
    if train and pyrng.random() < .5:
        audio, y30 = speed(audio, y30, pyrng.uniform(.88, 1.12))
    if train:
        audio = augment(audio, rng)
    lead = int(pyrng.uniform(0, .3) * SAMPLE_RATE) if train else 0
    audio = np.concatenate([np.zeros(lead, np.float32), audio, np.zeros(SAMPLE_RATE // 2, np.float32)])
    y30 = np.concatenate([np.zeros((int(round(lead / SAMPLE_RATE * 30)), y30.shape[1]), np.float32), y30])
    f = log_mel(audio)
    y = frame_targets(y30, len(f), lookahead)
    f = np.concatenate([np.full((receptive - 1, N_MELS), SILENCE, np.float32), f])  # left context
    if seg is None:
        return f, y
    if len(y) > seg:
        s = pyrng.randrange(len(y) - seg)
        return f[s:s + seg + receptive - 1], y[s:s + seg]
    pad = seg - len(y)
    return (np.concatenate([f, np.full((pad, N_MELS), SILENCE, np.float32)]),
            np.concatenate([y, np.zeros((pad, y.shape[1]), np.float32)]))


def train(args):
    import torch
    torch.set_num_threads(args.threads)
    names = json.loads((Path(args.corpus) / 'track-names.json').read_text())
    lines = load_corpus(Path(args.corpus), names, args.manifest)
    if args.split:  # the exact held-out lines that evaluation uses (make_split.py)
        held = set(json.loads(Path(args.split).read_text())['test'])
        train_lines, test_lines = [l for l in lines if l['key'] not in held], [l for l in lines if l['key'] in held]
    else:
        train_lines, test_lines = split_lines(lines)
    hours = sum(len(l['audio']) for l in train_lines) / SAMPLE_RATE / 3600
    print(f'{len(lines)} lines; train {len(train_lines)} test {len(test_lines)}; {hours:.2f} h train', flush=True)
    feats = np.concatenate([log_mel(l['audio']) for l in train_lines[::4]])
    mean, std = feats.mean(0), feats.std(0) + 1e-3
    ys = np.concatenate([l['y30'] for l in train_lines])
    scale = np.maximum(np.percentile(ys, 99.5, axis=0), 0.02).astype(np.float32)
    weight = 1 / np.maximum(ys.std(0) / scale, 0.05)
    weight[RUNTIME_OUTPUTS:] *= 0.3
    for name in UPPER_OUTPUTS:
        weight[[o[0] for o in OUTPUTS].index(name)] *= 2
    weight[0] *= 1.5
    weight[1:3] *= 1.5
    weight = torch.tensor(weight / weight.mean(), dtype=torch.float32)
    dil = [int(d) for d in args.dilations.split(',')]
    receptive = receptive_field(dil)
    net = build_torch(args.channels, dil, len(OUTPUTS))
    if args.init:  # warm start from an exported model; new outputs start fresh
        old = np.load(args.init, allow_pickle=False)
        state = net.state_dict()
        for name, value in state.items():
            key = name.replace('blocks.', 'b').replace('.weight', '.w').replace('.bias', '.b')
            if key in old.files:
                source = torch.tensor(old[key])
                if source.shape == value.shape: state[name] = source
                elif name.startswith('out.'): state[name][:source.shape[0]] = source
        net.load_state_dict(state)
    opt = torch.optim.AdamW(net.parameters(), lr=args.lr, weight_decay=1e-4)
    rng, pyrng = np.random.default_rng(1), random.Random(1)
    mean_t, std_t, scale_t = torch.tensor(mean), torch.tensor(std), torch.tensor(scale)
    steps = max(1, int(hours * 3600 / (4 * args.batch)))
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=args.lr, total_steps=steps * args.epochs, pct_start=.1)
    seg, best, began = 400, float('inf'), time.time()
    for epoch in range(args.epochs):
        net.train()
        losses = []
        for _ in range(steps):
            batch = [example(train_lines[pyrng.randrange(len(train_lines))], rng, pyrng, seg, receptive, args.lookahead)
                     for _ in range(args.batch)]
            x = (torch.tensor(np.stack([b[0] for b in batch])) - mean_t) / std_t
            y = torch.tensor(np.stack([b[1] for b in batch])) / scale_t
            pred = net(x)
            diff = pred - y
            if args.loss == 'mse':
                # Conditional mean: sparse events (contact, rounding, roll) keep
                # a graded response instead of collapsing to the zero median;
                # the exported quantile map restores their full range.
                diff = diff.square() * 4
            elif args.contact_quantile != .5:
                # Pinball loss on the sparse lip-contact tracks: under-predicting
                # a bilabial closure costs more than a slight false contact.
                q = args.contact_quantile
                contact = torch.maximum(q * -diff[..., 1:3], (1 - q) * diff[..., 1:3]) * 2
                diff = torch.cat([diff[..., :1].abs(), contact, diff[..., 3:].abs()], -1)
            else:
                diff = diff.abs()
            err = (diff * weight).mean()
            dv = (pred[:, 1:] - pred[:, :-1]) - (y[:, 1:] - y[:, :-1])
            vel = ((dv.square() * 16 if args.loss == 'mse' else dv.abs()) * weight).mean()
            loss = err + args.vel * vel
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0)
            opt.step()
            sched.step()
            losses.append(float(loss.detach()))
        val = evaluate_torch(net, test_lines[::max(1, len(test_lines) // 200)], mean_t, std_t, scale_t, receptive,
                             args.lookahead, weight, args.loss)
        print(f'epoch {epoch + 1}/{args.epochs} train {np.mean(losses):.4f} val {val["loss"]:.4f} r '
              + ' '.join(f'{OUTPUTS[k][0]}={val["r"][k]:.2f}' for k in range(8))
              + f' ({(time.time() - began) / 60:.1f} min)', flush=True)
        if val['loss'] < best:
            best = val['loss']
            best_state = {k: v.detach().clone() for k, v in net.state_dict().items()}
            export(net, args, mean, std, scale, dil)
    print('best val', best)
    net.load_state_dict(best_state)
    qin, qout = fit_quantile_map(net, train_lines[::3], mean_t, std_t, scale_t, receptive, args.lookahead)
    export(net, args, mean, std, scale, dil, qin, qout)
    print('exported with quantile map', flush=True)


def fit_quantile_map(net, lines, mean_t, std_t, scale_t, receptive, lookahead, points=65):
    """Monotone per-output map from predicted to authored value quantiles (training lines)."""
    import torch
    net.eval()
    P, Y = [], []
    pyrng = random.Random(0)
    with torch.no_grad():
        for l in lines:
            f, y = example(l, None, pyrng, None, receptive, lookahead, train=False)
            P.append(np.clip(net((torch.tensor(f[None]) - mean_t) / std_t)[0].numpy(), 0, None) * scale_t.numpy())
            Y.append(y)
    P, Y = np.concatenate(P), np.concatenate(Y)
    q = np.linspace(0, 100, points)
    qin = np.percentile(P, q, axis=0).T.astype(np.float32)
    qout = np.percentile(Y, q, axis=0).T.astype(np.float32)
    for k in range(qin.shape[0]):  # strictly increasing inputs for interpolation
        qin[k] = np.maximum.accumulate(qin[k]) + np.arange(points, dtype=np.float32) * 1e-6
        qout[k] = np.maximum.accumulate(qout[k])
    return qin, qout


def evaluate_torch(net, lines, mean_t, std_t, scale_t, receptive, lookahead, weight, loss='l1'):
    import torch
    net.eval()
    errs, P, Y = [], [], []
    pyrng = random.Random(0)
    with torch.no_grad():
        for l in lines:
            f, y = example(l, None, pyrng, None, receptive, lookahead, train=False)
            pred = (net((torch.tensor(f[None]) - mean_t) / std_t)[0]).numpy()
            yt = y / scale_t.numpy()
            errs.append(((np.square(pred - yt) * 4 if loss == 'mse' else np.abs(pred - yt)) * weight.numpy()).mean())
            P.append(pred); Y.append(yt)
    P, Y = np.concatenate(P), np.concatenate(Y)
    r = [float(np.corrcoef(P[:, k], Y[:, k])[0, 1]) if Y[:, k].std() > 0 else float('nan') for k in range(Y.shape[1])]
    net.train()
    return dict(loss=float(np.mean(errs)), r=r)


def export(net, args, mean, std, scale, dil, qin=None, qout=None):
    out = {}
    for k, v in net.state_dict().items():
        out[k.replace('blocks.', 'b').replace('.weight', '.w').replace('.bias', '.b')] = v.detach().numpy().astype(np.float32)
    out.update(feat_mean=mean.astype(np.float32), feat_std=std.astype(np.float32), out_scale=scale)
    if qin is not None:
        out.update(qmap_in=qin, qmap_out=qout)
    meta = dict(version=1, format='cp77-jali-audio2face-v1', lookahead=args.lookahead, channels=args.channels,
                dilations=dil, receptive=receptive_field(dil), outputs=[o[0] for o in OUTPUTS],
                runtimeOutputs=RUNTIME_OUTPUTS, sampleRate=SAMPLE_RATE, hop=HOP, window=WINDOW, nfft=N_FFT,
                mels=N_MELS, silence=SILENCE)
    np.savez(args.out, meta=json.dumps(meta), **out)


def main():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', default=str(root / 'runtime/lipsync-corpus2'))
    parser.add_argument('--out', default=str(root / 'runtime/lipsync-model/model.npz'))
    parser.add_argument('--lookahead', type=int, default=20)
    parser.add_argument('--channels', type=int, default=160)
    parser.add_argument('--dilations', default='1,2,4,8,16,1')
    parser.add_argument('--epochs', type=int, default=30)
    parser.add_argument('--batch', type=int, default=24)
    parser.add_argument('--lr', type=float, default=2e-3)
    parser.add_argument('--vel', type=float, default=1.0)
    parser.add_argument('--threads', type=int, default=10)
    parser.add_argument('--contact-quantile', type=float, default=.5)
    parser.add_argument('--manifest', default='manifest.jsonl')
    parser.add_argument('--loss', choices=['l1', 'mse'], default='mse')
    parser.add_argument('--split', help='split.json from make_split.py')
    parser.add_argument('--init', help='warm-start weights (.npz from a previous run)')
    args = parser.parse_args()
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    train(args)


if __name__ == '__main__':
    main()
