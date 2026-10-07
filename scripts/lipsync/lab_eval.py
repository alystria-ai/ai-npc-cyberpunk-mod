"""Paired evaluation of lip-sync candidates with uncertainty (lipsync_eval metrics, many lines, parallel).

Per line it computes exactly lipsync_eval.line_metrics (Judy-rig geometry proxies,
track correlations, contact / F/V / rounding recall-precision, lag) for every
model, then reports per-set means with cluster-bootstrap 95 % intervals and the
paired difference of each model against the reference (first) model. Clusters
are speakers for the held-out-speaker set and scenes for per-character sets, so
the intervals reflect how results vary across speakers/scenes, not only lines.

Sets: test (held-out speakers, split.json), test-clean / test-flagged (combat,
shouted or effect lines, lab_clean.py), char:<name> (per-character held-out
scenes, split2.json), and clone:<list.json> (cloned-voice renders with
time-warped game curves, lab_clone.py).

  python lab_eval.py --model base=a.npz --model new=b.npz --sets test,char:judy --out report.json
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from multiprocessing import Pool
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
PROJECT = HERE.parents[1]
LAB = Path('E:/CyberpunkConvai-offload/work/lipsync-lab')
CORPUS = PROJECT / 'runtime/lipsync-corpus2'

SCALARS = [('aperture_r', 'geo_innerAperture', 'r'), ('aperture_mae', 'geo_innerAperture', 'mae'),
           ('width_r', 'geo_width', 'r'), ('protrusion_r', 'geo_protrusion', 'r'), ('chin_r', 'geo_chinDrop', 'r'),
           ('jaw_r', 'jaw', 'r'), ('contact_r', 'together', 'r'), ('purse_r', 'purse', 'r'),
           ('corner_stretch_r', 'cornerStretch', 'r'), ('lower_roll_r', 'suckDn', 'r'),
           ('contact_recall', 'closure', 'recall'), ('contact_precision', 'closure', 'precision'),
           ('fv_recall', 'fv', 'recall'), ('rounding_recall', 'rounding', 'recall'),
           ('rounding_precision', 'rounding', 'precision'), ('lag_ms', 'lagMs', None)]

_G = {}


def _init(models):
    import lipsync_eval as le
    from native_mouth import NativeMouth
    _G['le'] = le
    _G['mouth'] = NativeMouth('judy')
    _G['models'] = {name: load_model(path) for name, path in models}


class TextPipeModel:
    """textpipe:<dir>:<stream|phrase>[:threshold] - the runtime text path (lab_textpipe.py) with the line's own text."""

    def __init__(self, spec):
        import lab_textpipe
        rest = spec[len('textpipe:'):]
        directory, _, self.mode = rest.rpartition(':')
        self.pipe = lab_textpipe.TextPipeline(Path(directory))

    def timeline(self, audio16k, text):
        tracks, frames, info = self.pipe.timeline(audio16k.astype(np.float32), text, self.mode)
        _G.setdefault('textinfo', []).append(info)
        return tracks, frames


def load_model(path):
    from lipsync_model import NumpyModel
    if str(path).startswith('textpipe:'):
        return TextPipeModel(str(path))
    path = Path(path)
    if path.suffix == '.pt':
        return TorchModel(path)
    return NumpyModel.load(path)


class TorchModel:
    """Research models with oracle phone input: same timeline() as NumpyModel, labels passed in."""

    def __init__(self, path):
        import torch
        import lab_train as lt
        ck = torch.load(path, map_location='cpu', weights_only=False)
        self.ck, self.lt, self.torch = ck, lt, torch
        self.pipe = None
        if ck.get('kind') == 'stage2':
            import lab_stage2
            self.pipe = lab_stage2.Pipeline(path)
            self.lookahead = self.pipe.lookahead
            return
        self.net = lt.Net(ck['channels'], ck['dilations'], len(lt.lm.OUTPUTS), ck['n_phones'], aux=False, phone_input=ck['phone_input'])
        self.net.load_state_dict({k: v for k, v in ck['state'].items() if not k.startswith('aux.')}, strict=False)
        self.net.eval()
        self.lookahead = ck['lookahead']
        self.receptive = self.lt.lm.receptive_field(ck['dilations'])

    def timeline(self, audio16k, lab=None):
        lm, torch = self.lt.lm, self.torch
        if self.pipe is not None:
            times, y = self.pipe.predict(audio16k, lab)
            return self._tracks(audio16k, times, y)
        line = dict(audio=audio16k.astype(np.float32), y30=np.zeros((int(len(audio16k) / 16000 * 30) + 2, len(lm.OUTPUTS)), np.float32))
        if lab is not None:
            line['lab'] = lab
        import random
        f, _, _, li = self.lt.make_example(line, None, random.Random(0), None, self.receptive, self.lookahead, train=False,
                                          delay=self.ck.get('phone_delay', 0))
        f = f[:self.receptive - 1 + (len(f) - self.receptive + 1)]
        x = (torch.tensor(f[None]) - torch.tensor(self.ck['mean'])) / torch.tensor(self.ck['std'])
        with torch.no_grad():
            y = np.clip(self.net(x, torch.tensor(li[None]))[0].numpy(), 0, None) * self.ck['scale']
        y = np.stack([np.interp(y[:, k], self.ck['qin'][k], self.ck['qout'][k]) for k in range(y.shape[1])], 1)
        # make_example padded 0.5 s of silence after the audio; drop lookahead rows like NumpyModel.predict
        y = y[self.lookahead:]
        times = lm.frame_time(np.arange(len(y)))
        return self._tracks(audio16k, times, y)

    def _tracks(self, audio16k, times, y):
        lm = self.lt.lm
        duration = len(audio16k) / lm.SAMPLE_RATE
        t = np.append(np.arange(0, duration, 1 / 60), duration)
        tracks, cols = [], []
        for k, (_, controls) in enumerate(lm.OUTPUTS[:lm.RUNTIME_OUTPUTS]):
            values = np.interp(t, times, y[:, k])
            for c in controls:
                tracks.append(c)
                cols.append(np.clip(values, 0, lm.LIMITS.get(c, .5)))
        edge = np.clip(np.minimum(t / .04, (duration - t) / .04), 0, 1)
        return tracks, np.column_stack([t] + [c * edge for c in cols])


def gt_geometry(key, gt):
    le, mouth = _G['le'], _G['mouth']
    cache = LAB / 'geo-cache' / f'{key}.npy'
    if cache.exists():
        g = np.load(cache)
        if len(g) == len(gt):
            return g
    g = le.geometry(mouth, gt[:, [le.LPS[c] for c in le.MOUTH]], le.MOUTH)
    cache.parent.mkdir(parents=True, exist_ok=True)
    np.save(cache, g)
    return g


def _job(job):
    le, mouth = _G['le'], _G['mouth']
    kind, key, src = job
    if kind == 'corpus':
        d = np.load(CORPUS / 'lines' / f'{key}.npz')
        audio, gt = d['audio16k'].astype(np.float32), d['tracks']
        gt_geo = gt_geometry(key, gt)
        lab = None
        if src and os.environ.get('LAB_LABEL_DIR'):
            path = Path(os.environ['LAB_LABEL_DIR']) / f'{key}.npy'
            lab = np.load(path).astype(np.int64) if path.exists() else None
        elif src:
            pack_lab = _G.setdefault('lab', _load_labels())
            lab = pack_lab.get(key)
    else:  # cloned render: audio .npy, warped full tracks .npy
        audio, gt = np.load(src['audio']).astype(np.float32), np.load(src['tracks'])
        gt_geo = gt_geometry('clone-' + Path(src['tracks']).parent.name + '-' + Path(src['tracks']).stem, gt)
        lab = np.load(src['lab']).astype(np.int64) if src.get('lab') and Path(src['lab']).exists() else None
        if os.environ.get('LAB_LABEL_DIR'):
            path = Path(os.environ['LAB_LABEL_DIR']) / f'{key}.npy'
            lab = np.load(path).astype(np.int64) if path.exists() else None
    times = np.arange(len(gt)) / 30
    out = {}
    text = _G.setdefault('texts', _load_texts()).get(key, '')
    infos = {}
    for name, model in _G['models'].items():
        if isinstance(model, TextPipeModel):
            tracks, frames = model.timeline(audio, text)
            infos[name] = _G['textinfo'][-1]
        else:
            tracks, frames = model.timeline(audio, lab) if isinstance(model, TorchModel) else model.timeline(audio)
        rows = le.sample(frames, times)
        out[name] = le.line_metrics(gt, rows, tracks, gt_geo, le.geometry(mouth, rows, tracks))
        if name in infos:
            out[name]['textInfo'] = infos[name]
    return key, out


def _load_texts():
    texts = {}
    for r in json.loads((LAB / 'pack/index.json').read_text()):
        texts.setdefault(r['key'], r['text'])
    return texts


def _load_labels():
    pack = LAB / 'pack'
    if not (pack / 'phones100.npy').exists():
        return {}
    labels = np.load(pack / 'phones100.npy', mmap_mode='r')
    index = json.loads((pack / 'phones100.json').read_text())
    return {k: np.array(labels[v[0]:v[0] + v[1]]) for k, v in index.items() if k != '__phones__'}


def flatten(m):
    out = {}
    for name, key, field in SCALARS:
        v = m[key] if field is None else m[key][field]
        out[name] = float(v) if v is not None else float('nan')
    return out


def boot(values, clusters, reps=2000, seed=0, stat=np.nanmean):
    values, clusters = np.asarray(values, float), np.asarray(clusters)
    uniq = np.unique(clusters)
    groups = [np.where(clusters == c)[0] for c in uniq]
    rng = np.random.default_rng(seed)
    est = stat(values)
    samples = []
    for _ in range(reps):
        pick = np.concatenate([groups[i] for i in rng.integers(0, len(groups), len(groups))])
        samples.append(stat(values[pick]))
    lo, hi = np.nanpercentile(samples, [2.5, 97.5])
    return float(est), float(lo), float(hi)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--model', action='append', required=True, help='name=path (.npz, or .pt for oracle phone-input research models)')
    p.add_argument('--sets', default='test')
    p.add_argument('--limit', type=int, default=0)
    p.add_argument('--procs', type=int, default=14)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--labels', action='store_true', help='pass oracle phone labels to .pt models')
    p.add_argument('--label-dir', type=Path, help='use <dir>/<key>.npy labels (lab_textalign.py) instead of PocketSphinx labels')
    args = p.parse_args()
    models = [tuple(m.split('=', 1)) for m in args.model]
    if args.label_dir:
        os.environ['LAB_LABEL_DIR'] = str(args.label_dir)  # inherited by the worker processes
        args.labels = True
    split = json.loads((LAB / 'pack/split2.json').read_text())
    clean = json.loads((LAB / 'pack/clean.json').read_text())
    index = {}
    for r in json.loads((LAB / 'pack/index.json').read_text()):
        index.setdefault(r['key'], r)
    flagged = {k for k, v in clean.items() if v['combat'] or v['effect']}
    sets = {}
    for s in args.sets.split(','):
        if s in ('test', 'test-clean', 'test-flagged'):
            keys = [k for k in dict.fromkeys(split['test']) if k in index]  # lines with authored jaw motion
            keys = keys if s == 'test' else [k for k in keys if (k in flagged) == (s == 'test-flagged')]
            sets[s] = [('corpus', k, args.labels) for k in keys]
        elif s.startswith('char:'):
            who = s.split(':')[1].replace('-clean', '')
            keys = list(dict.fromkeys(split['charTest'][who]))
            if s.endswith('-clean'):
                keys = [k for k in keys if k not in flagged]
            sets[s] = [('corpus', k, args.labels) for k in keys]
        elif s.startswith('clone:'):
            items = json.loads(Path(s.split(':', 1)[1]).read_text())
            sets[s] = [('clone', i['key'], i) for i in items]
        if args.limit:
            sets[s] = sets[s][:args.limit]
    jobs = sorted({(k, key, json.dumps(src) if isinstance(src, dict) else src) for v in sets.values() for k, key, src in v})
    jobs = [(k, key, json.loads(src) if isinstance(src, str) else src) for k, key, src in jobs]
    with Pool(args.procs, initializer=_init, initargs=(models,)) as pool:
        results = {}
        for (kind, key, src), (_, out) in zip(jobs, pool.imap(_job, jobs, chunksize=4)):
            results[(kind, key, src['audio'] if isinstance(src, dict) else '')] = out  # clone keys repeat across engines
    report = {'models': dict(models), 'sets': {}}
    ref = models[0][0]
    for s, items in sets.items():
        rows = [(key, results[(kind, key, src['audio'] if isinstance(src, dict) else '')]) for kind, key, src in items]
        if s.startswith('test'):
            clusters = [index[k]['actor'] for k, _ in rows]
        elif s.startswith('char:'):
            clusters = [index[k]['scene'] for k, _ in rows]
        else:
            clusters = [k.rsplit('_', 1)[0] for k, _ in rows]
        flat = {name: [flatten(r[name]) for _, r in rows] for name, _ in models}
        entry = {'lines': len(rows), 'clusters': len(set(clusters)), 'models': {}, 'perLine': {name: flat[name] for name, _ in models}}
        for name, _ in models:
            infos = [r[name]['textInfo'] for _, r in rows if 'textInfo' in r[name]]
            if infos:
                entry.setdefault('text', {})[name] = dict(active=float(np.mean([i['active'] for i in infos])),
                    lost=float(np.mean([bool(i.get('lost')) for i in infos])),
                    meanWeight=float(np.mean([i.get('meanWeight', 0) for i in infos])))
        for name, _ in models:
            entry['models'][name] = {}
            for metric, _, _ in SCALARS:
                vals = [f[metric] for f in flat[name]]
                stat = np.nanmedian if metric == 'lag_ms' else np.nanmean
                est, lo, hi = boot(vals, clusters, stat=stat)
                d = {'mean': est, 'ci': [lo, hi]}
                if name != ref and metric != 'lag_ms':
                    diff = np.array(vals) - np.array([f[metric] for f in flat[ref]])
                    de, dlo, dhi = boot(diff, clusters)
                    d['diff'] = {'mean': de, 'ci': [dlo, dhi]}
                entry['models'][name][metric] = d
        report['sets'][s] = entry
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=1), encoding='utf8')
    print_report(report)


def print_report(report, metrics=None):
    metrics = metrics or [m for m, _, _ in SCALARS]
    for s, entry in report['sets'].items():
        names = list(entry['models'])
        print(f"\n== {s}: {entry['lines']} lines, {entry['clusters']} clusters")
        if entry.get('text'):
            print('   text path:', {k: {a: round(b, 3) for a, b in v.items()} for k, v in entry['text'].items()})
        print(f"{'metric':20s}" + ''.join(f'{n:>30s}' for n in names))
        for m in metrics:
            cells = []
            for n in names:
                d = entry['models'][n][m]
                if 'diff' in d:
                    cells.append(f"{d['mean']:.3f} ({d['diff']['mean']:+.3f} [{d['diff']['ci'][0]:+.3f},{d['diff']['ci'][1]:+.3f}])")
                else:
                    cells.append(f"{d['mean']:.3f} [{d['ci'][0]:.2f},{d['ci'][1]:.2f}]")
            print(f'{m:20s}' + ''.join(f'{c:>30s}' for c in cells))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--print':
        print_report(json.loads(Path(sys.argv[2]).read_text()))
    else:
        main()
