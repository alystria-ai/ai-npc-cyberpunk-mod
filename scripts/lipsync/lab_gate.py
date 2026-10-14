"""No-degradation gate for lip-sync candidates: every existing metric, shape variety, and the frozen downstream path.

A "stack" is a folder holding face-model.{json,bin} (audio model, stage 1) and optionally face-text.{json,bin} plus
face-lexicon.txt.gz (text stage 2), i.e. exactly the files the bridge loads. Each stack is run in the runtime's own
modes through lab_textpipe.TextPipeline (the line-by-line mirror of bridge/jali-face-text.mjs):

  audio   - no text: what every route plays when the text path is off, unknown or lost (Candidate A behaviour);
  stream  - Pocket / Convai: fixed-lag streaming alignment (identical for any packet size, see lab_textparity.mjs);
  phrase  - Omni: whole-phrase alignment.

Sets: test (1,024 held-out-speaker game lines), clone-omni / clone-pocket (cloned held-out lines with time-warped game
curves, lab_clone.py), char:<name> (per-character held-out scenes).

Per set and mode it reports, for every stack against the first (the shipped stack):
  1. the lab_eval metrics (lipsync_eval.line_metrics: Judy-rig geometry, track r, contact / F/V / rounding recall and
     precision), paired differences with speaker-cluster bootstrap 95 % intervals;
  2. shape variety per control on speaking frames vs the game's authored curves: std ratio, p95 reach (how often the
     prediction reaches the game's p95, 1.0 = as often as the game), timing-tolerant peak attainment, per-line std
     ratio, velocity ratio, Wasserstein distance; plus a 32-shape codebook (k-means on the game's 15-control mouth
     shapes): occupancy perplexity and per-frame shape agreement;
  3. the frozen downstream path, in the units the game receives: JALI_LIMITS clamps (bridge/jali-face.mjs and
     mod/facial-playback.lua), then the per-head jaw lift and floor of mod/facial-playback.lua (liftJaw):
       - fraction of speaking frames whose written jaw passes each head type's measured lip-part point
         (Judy .06; woman_average .20; man_average / man_big / man_fat .12, .16 and .20);
       - over-opening: written jaw above .20 / .35 on frames the game keeps the mouth shut, and the jaw p99 / max;
       - closures: share of the game's lip-closure events (both contact controls >= .8) where the prediction reaches
         full contact (min of the two >= .9 within +-2 frames), and its mean peak;
       - per-control maximum and p99.9 vs the shipped stack and the validated limits;
       - the expression-budget inputs (closure / rounding) the Lua writer derives from the mouth (informational).
  4. a verdict: PASS only if no existing metric and no downstream check is worse with a paired interval crossing
     into a loss (strict), and no control exceeds the shipped maximum or a limit.

  python lab_gate.py --stack shipped=<dir> --stack cand=<dir> --sets test,clone-omni,clone-pocket --out gate.json
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from multiprocessing import Pool
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import lab_eval as ev  # noqa: E402

LAB = ev.LAB
CLONE = {'clone-omni': LAB / 'clone/omni/test.json', 'clone-pocket': LAB / 'clone/pocket/test.json'}
N_RT = 15
OUT_NAMES = ['jaw', 'together_up', 'together_dn', 'purse', 'funnel', 'corner_stretch', 'stretch', 'lower_raise',
             'upper_raise', 'suck_up', 'suck_dn', 'puff', 'cheek_puff', 'tongue_tip_up', 'tongue_fwd']
# mod/facial-playback.lua jawLiftByGraph (frozen calibration, 2026-10-09) and the lip-part points measured in game.
JAW_LIMIT = .7
HEADS = {'judy': (None, [.06]), 'woman_average': ((2.0, .21), [.20]), 'man': ((1.5, .17), [.12, .16, .20])}
LIMITS = {'jaw': .7, 'together_up': 1, 'together_dn': 1, 'suck_dn': .8, 'suck_up': .3, 'puff': .45, 'cheek_puff': .35}
HIGHER_BETTER = {m for m, _, _ in ev.SCALARS} - {'aperture_mae', 'lag_ms'}
_G = {}


def lift_jaw(v, lift):
    """mod/facial-playback.lua liftJaw, vectorised."""
    if lift is None:
        return v
    q, floor = lift
    rest = 1 - v / JAW_LIMIT
    lifted = np.where(rest > 0, JAW_LIMIT * (1 - np.clip(rest, 0, None) ** q), JAW_LIMIT)
    x = np.clip((v - .02) / .05, 0, 1)
    fl = floor * x * x * (3 - 2 * x)
    return np.where(v - .02 > 0, np.maximum(lifted, fl), lifted)


class CachedPipeline:
    """TextPipeline with stage 1 memoised per audio (stacks that share face-model.bin share the work)."""

    def __init__(self, directory):
        import lab_textpipe
        if str(directory).endswith('.npz'):  # audio-only research model (lab_train export): every mode = audio
            from lipsync_model import NumpyModel
            self.npz, self.has_text = NumpyModel.load(directory), False
            return
        self.npz = None
        self.pipe = lab_textpipe.TextPipeline(Path(directory))
        self.sha = hashlib.sha256((Path(directory) / 'face-model.bin').read_bytes()).hexdigest()
        self.has_text = (Path(directory) / 'face-text.json').exists()
        original = self.pipe.stage1
        cache = _G.setdefault('s1cache', {})

        def stage1(audio):
            key = (self.sha, len(audio), float(audio[::997].sum()))
            if key not in cache:
                cache.clear()  # one line at a time
                cache[key] = original(audio)
            return cache[key]
        self.pipe.stage1 = stage1

    def timeline(self, audio, text, mode):
        if self.npz is not None:
            return self.npz.timeline(audio)
        if mode == 'audio' or not self.has_text:
            return self.pipe.timeline(audio, '', 'stream')
        return self.pipe.timeline(audio, text, mode)


class JawSplitPipeline:
    """Research what-if `name=<dir>|jaw=<dir2>`: every track from <dir> except the jaw output's tracks, which come
    from <dir2> (a runtime that would evaluate two phrase nets). Not a drop-in; costs a second stage-2 pass."""

    def __init__(self, spec):
        import lipsync_model as lm
        main, jaw = spec.split('|jaw=')
        self.a, self.b = CachedPipeline(main), CachedPipeline(jaw)
        self.has_text = self.a.has_text
        self.jaw_controls = lm.OUTPUTS[0][1]

    def timeline(self, audio, text, mode):
        tracks, frames, *rest = self.a.timeline(audio, text, mode)
        tracks_b, frames_b, *_ = self.b.timeline(audio, text, mode)
        frames = frames.copy()
        for c in self.jaw_controls:
            frames[:, tracks.index(c) + 1] = frames_b[:, tracks_b.index(c) + 1]
        return (tracks, frames, *rest)


def _init(stacks, modes):
    import lipsync_eval as le
    from native_mouth import NativeMouth
    ev._G['le'] = le
    ev._G['mouth'] = NativeMouth('judy')
    _G['stacks'] = {name: (JawSplitPipeline(d) if '|jaw=' in str(d) else CachedPipeline(d)) for name, d in stacks}
    _G['modes'] = modes
    _G['texts'] = ev._load_texts()


def to15(rows, tracks):
    """Native track rows -> the 15 symmetric outputs (mean of the tracks each output drives)."""
    import lipsync_model as lm
    out = np.zeros((len(rows), N_RT), np.float32)
    for k, (_, controls) in enumerate(lm.OUTPUTS[:N_RT]):
        out[:, k] = np.mean([rows[:, tracks.index(c)] for c in controls], axis=0)
    return out


def gt15(gt):
    import lipsync_model as lm
    le = ev._G['le']
    return np.stack([np.mean([gt[:, le.LPS[c]] for c in controls], axis=0) for _, controls in lm.OUTPUTS[:N_RT]], 1).astype(np.float32)


def _job(job):
    le, mouth = ev._G['le'], ev._G['mouth']
    kind, key, src = job
    if kind == 'corpus':
        d = np.load(ev.CORPUS / 'lines' / f'{key}.npz')
        audio, gt = d['audio16k'].astype(np.float32), d['tracks']
        gt_geo = ev.gt_geometry(key, gt)
    else:
        audio, gt = np.load(src['audio']).astype(np.float32), np.load(src['tracks'])
        gt_geo = ev.gt_geometry('clone-' + Path(src['tracks']).parent.name + '-' + Path(src['tracks']).stem, gt)
    times = np.arange(len(gt)) / 30
    text = _G['texts'].get(key, '')
    out = {'gt': gt15(gt).astype(np.float16), 'res': {}}
    for name, pipe in _G['stacks'].items():
        for mode in _G['modes']:
            r = pipe.timeline(audio, text, mode)
            tracks, frames = r[0], r[1]
            info = r[2] if len(r) > 2 else {}
            rows = le.sample(frames, times)
            m = le.line_metrics(gt, rows, tracks, gt_geo, le.geometry(mouth, rows, tracks))
            f60 = to15(np.asarray(frames)[:, 1:], tracks)
            out['res'][(name, mode)] = dict(flat=ev.flatten(m), pred=to15(rows, tracks).astype(np.float16),
                                            max60=f60.max(0), active=bool(info.get('active', False)),
                                            lost=bool(info.get('lost', False)))
    return key, out


# ------------------------------------------------------------------ statistics
def boot_mean(values, clusters, reps=2000, seed=0):
    return ev.boot(values, clusters, reps=reps, seed=seed)


def tolerant_max(x, k=2):
    pad = np.concatenate([np.full(k, -np.inf), x, np.full(k, -np.inf)])
    return np.max(np.stack([pad[i:i + len(x)] for i in range(2 * k + 1)]), 0)


def kmeans(X, k=32, iters=40, seed=0):
    rng = np.random.default_rng(seed)
    C = X[rng.choice(len(X), k, replace=False)]
    for _ in range(iters):
        a = ((X[:, None, :] - C[None]) ** 2).sum(-1).argmin(1)
        for j in range(k):
            if (a == j).any():
                C[j] = X[a == j].mean(0)
    return C


def assign(X, C):
    out = np.empty(len(X), np.int64)
    for s in range(0, len(X), 20000):
        out[s:s + 20000] = ((X[s:s + 20000, None, :] - C[None]) ** 2).sum(-1).argmin(1)
    return out


def perplexity(a, k):
    p = np.bincount(a, minlength=k) / len(a)
    p = p[p > 0]
    return float(np.exp(-(p * np.log(p)).sum()))


def variety(gts, preds, codebook):
    """Pooled shape-variety statistics on speaking frames (game jaw > .02)."""
    G = np.concatenate(gts).astype(np.float32)
    P = np.concatenate(preds).astype(np.float32)
    speak = G[:, 0] > .02
    res = {'perControl': {}}
    for k, name in enumerate(OUT_NAMES):
        g, p = G[speak, k], P[speak, k]
        if g.std() < 1e-4:
            continue
        p95 = np.percentile(g, 95)
        peaks = []
        for gl, pl in zip(gts, preds):
            gl, pl = gl[:, k].astype(np.float32), pl[:, k].astype(np.float32)
            sp = gl > -1
            thr = gl >= p95
            if thr.any():
                peaks.append((tolerant_max(pl)[thr].sum(), gl[thr].sum()))
        line_ratio = [pl[:, k].astype(np.float32)[gl[:, 0] > .02].std() / gl[:, k].astype(np.float32)[gl[:, 0] > .02].std()
                      for gl, pl in zip(gts, preds)
                      if (gl[:, 0] > .02).sum() > 10 and gl[:, k].astype(np.float32)[gl[:, 0] > .02].std() > .01]
        vel_p = np.concatenate([np.abs(np.diff(pl[:, k].astype(np.float32))) for pl in preds]).mean()
        vel_g = np.concatenate([np.abs(np.diff(gl[:, k].astype(np.float32))) for gl in gts]).mean()
        qs = np.linspace(.5, 99.5, 100)
        res['perControl'][name] = dict(
            stdRatio=float(p.std() / g.std()), p95Reach=float((p >= p95).mean() / .05), gtP95=float(p95),
            peakAttain=float(sum(a for a, _ in peaks) / max(1e-9, sum(b for _, b in peaks))),
            lineStdRatio=float(np.median(line_ratio)) if line_ratio else float('nan'),
            velRatio=float(vel_p / max(vel_g, 1e-9)),
            w1=float(np.mean(np.abs(np.percentile(p, qs) - np.percentile(g, qs))) / g.std()))
    sd = G[speak].std(0) + 1e-3
    ag, ap = assign(G[speak] / sd, codebook), assign(P[speak] / sd, codebook)
    res['codebook'] = dict(k=len(codebook), gtPerplexity=perplexity(ag, len(codebook)), predPerplexity=perplexity(ap, len(codebook)),
                           agreement=float((ag == ap).mean()))
    return res


def downstream_line(g, p):
    """Per-line downstream values (frozen Lua path). g, p: (T, 15) at 30 Hz."""
    g, p = g.astype(np.float32), p.astype(np.float32)
    speak = g[:, 0] > .02
    shut = g[:, 0] <= .02
    jaw = np.clip(p[:, 0], 0, LIMITS['jaw'])
    v = {}
    for head, (lift, thrs) in HEADS.items():
        lj = lift_jaw(jaw, lift)
        for t in thrs:
            v[f'open_{head}_{t:.2f}'] = float((lj[speak] > t).mean()) if speak.sum() >= 5 else float('nan')
        v[f'overopen20_{head}'] = float((lj[shut] > .20).mean()) if shut.sum() >= 5 else float('nan')
        v[f'overopen35_{head}'] = float((lj[shut] > .35).mean()) if shut.sum() >= 5 else float('nan')
    gc = np.minimum(g[:, 1], g[:, 2]) >= .8
    pc = tolerant_max(np.minimum(np.clip(p[:, 1], 0, 1), np.clip(p[:, 2], 0, 1)))
    if gc.any():
        edges = np.flatnonzero(np.diff(np.concatenate([[0], gc.astype(int), [0]])))
        peaks = [pc[a:b].max() for a, b in zip(edges[::2], edges[1::2])]
        v['closureFull'] = float(np.mean(np.array(peaks) >= .9))
        v['closurePeak'] = float(np.mean(peaks))
    else:
        v['closureFull'] = v['closurePeak'] = float('nan')
    return v


LOWER_BETTER_DOWN = ('overopen',)


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--stack', action='append', required=True, help='name=dir; the first is the reference (shipped)')
    p.add_argument('--modes', default='audio,stream,phrase')
    p.add_argument('--sets', default='test,clone-omni,clone-pocket')
    p.add_argument('--limit', type=int, default=0)
    p.add_argument('--procs', type=int, default=12)
    p.add_argument('--out', type=Path, required=True)
    args = p.parse_args()
    stacks = [tuple(s.split('=', 1)) for s in args.stack]
    modes = args.modes.split(',')
    split = json.loads((LAB / 'pack/split2.json').read_text())
    index = {}
    for r in json.loads((LAB / 'pack/index.json').read_text()):
        index.setdefault(r['key'], r)
    sets = {}
    for s in args.sets.split(','):
        if s == 'test':
            sets[s] = [('corpus', k, None) for k in dict.fromkeys(split['test']) if k in index]
        elif s.startswith('char:'):
            sets[s] = [('corpus', k, None) for k in dict.fromkeys(split['charTest'][s[5:]])]
        elif s in CLONE:
            sets[s] = [('clone', i['key'], i) for i in json.loads(CLONE[s].read_text())]
        if args.limit:
            sets[s] = sets[s][::max(1, len(sets[s]) // args.limit)][:args.limit]
    jobs = [j for v in sets.values() for j in v]
    with Pool(args.procs, initializer=_init, initargs=(stacks, modes)) as pool:
        results = {}
        for (kind, key, src), (_, out) in zip(jobs, pool.imap(_job, jobs, chunksize=2)):
            results[(kind, key, src['audio'] if src else '')] = out
    ref = stacks[0][0]
    report = {'stacks': dict(stacks), 'modes': modes, 'sets': {}}
    # one codebook from the game's own held-out shapes (test set when present, else the first set)
    first = next(iter(sets.values()))
    G_all = np.concatenate([results[(k, key, s['audio'] if s else '')]['gt'] for k, key, s in first]).astype(np.float32)
    G_sp = G_all[G_all[:, 0] > .02]
    codebook = kmeans(G_sp / (G_sp.std(0) + 1e-3), 32)
    verdict = {name: [] for name, _ in stacks[1:]}
    for s, items in sets.items():
        rows = [results[(k, key, src['audio'] if src else '')] for k, key, src in items]
        keys = [key for _, key, _ in items]
        clusters = [index[k]['actor'] for k in keys] if s.startswith('test') else (
            [index[k]['scene'] for k in keys] if s.startswith('char:') else [k.rsplit('_', 1)[0] for k in keys])
        entry = {'lines': len(rows), 'clusters': len(set(clusters)), 'modes': {}}
        gts = [r['gt'] for r in rows]
        for mode in modes:
            me = {'metrics': {}, 'variety': {}, 'downstream': {}, 'max': {}, 'text': {}}
            down = {name: [downstream_line(r['gt'], r['res'][(name, mode)]['pred']) for r in rows] for name, _ in stacks}
            for name, _ in stacks:
                res = [r['res'][(name, mode)] for r in rows]
                me['text'][name] = dict(active=float(np.mean([x['active'] for x in res])), lost=float(np.mean([x['lost'] for x in res])))
                mm = {}
                for metric, _, _ in ev.SCALARS:
                    vals = np.array([x['flat'][metric] for x in res])
                    est, lo, hi = ev.boot(vals, clusters, stat=np.nanmedian if metric == 'lag_ms' else np.nanmean)
                    d = {'mean': est, 'ci': [lo, hi]}
                    if name != ref and metric != 'lag_ms':
                        refv = np.array([r['res'][(ref, mode)]['flat'][metric] for r in rows])
                        de, dlo, dhi = ev.boot(vals - refv, clusters)
                        d['diff'] = {'mean': de, 'ci': [dlo, dhi]}
                        worse = (dhi > 0) if metric == 'aperture_mae' else (dlo < 0)
                        if worse and abs(de) + abs(dlo if metric != 'aperture_mae' else dhi) > 1e-9:
                            verdict[name].append(dict(set=s, mode=mode, check=metric, diff=de, ci=[dlo, dhi]))
                    elif name != ref and metric == 'lag_ms' and est != me['metrics'][ref]['lag_ms']['mean']:
                        verdict[name].append(dict(set=s, mode=mode, check='lag_ms', diff=est - me['metrics'][ref]['lag_ms']['mean']))
                    mm[metric] = d
                me['metrics'][name] = mm
                me['variety'][name] = variety(gts, [x['pred'] for x in res], codebook)
                dd = {}
                for check in down[name][0]:
                    vals = np.array([x[check] for x in down[name]])
                    est, lo, hi = ev.boot(vals, clusters)
                    d = {'mean': est, 'ci': [lo, hi]}
                    if name != ref:
                        refv = np.array([x[check] for x in down[ref]])
                        de, dlo, dhi = ev.boot(vals - refv, clusters)
                        d['diff'] = {'mean': de, 'ci': [dlo, dhi]}
                        worse = (dhi > 0) if check.startswith(LOWER_BETTER_DOWN) else (dlo < 0)
                        if worse and abs(de) + abs(dlo) + abs(dhi) > 1e-9:
                            verdict[name].append(dict(set=s, mode=mode, check=check, diff=de, ci=[dlo, dhi]))
                    dd[check] = d
                P = np.concatenate([x['pred'] for x in res]).astype(np.float32)
                mx = np.max([x['max60'] for x in res], 0)
                spk = np.concatenate(gts).astype(np.float32)[:, 0] > .02
                dd['jawP99'] = {'mean': float(np.percentile(P[:, 0], 99))}
                dd['budgetClosureFrames'] = {'mean': float((np.maximum(P[spk, 1], P[spk, 2]) >= .85).mean())}
                dd['budgetRoundingFull'] = {'mean': float((P[spk, 4] / .32 + P[spk, 3] / .28 >= 1).mean())}
                me['max'][name] = {n: dict(max=float(mx[k]), p999=float(np.percentile(P[:, k], 99.9))) for k, n in enumerate(OUT_NAMES)}
                me['downstream'][name] = dd
            for name, _ in stacks[1:]:
                for n in OUT_NAMES:
                    c, b = me['max'][name][n], me['max'][ref][n]
                    if c['max'] > b['max'] + .02 or c['max'] > LIMITS.get(n, .5) + 1e-6:
                        verdict[name].append(dict(set=s, mode=mode, check=f'max:{n}', diff=c['max'] - b['max']))
            entry['modes'][mode] = me
        report['sets'][s] = entry
    report['verdict'] = {name: dict(passed=not v, failures=v) for name, v in verdict.items()}
    report['classified'] = classify(report)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=1, default=float), encoding='utf8')
    print_report(report)


MARGIN = {'r': .002, 'rate': .01, 'mae': .01}  # run-to-run seed noise measured on 2026-10-07 (same recipe, 2nd seed)


def classify(report):
    """Re-derive the verdict from a report: every paired comparison is
    'loss' (whole interval below 0), 'possible-loss' (mean below 0, interval crosses 0), 'uncertain' (mean >= 0,
    interval crosses 0) or fine. STRICT pass = no loss, no possible-loss and no uncertain; NON-INFERIOR pass = no loss
    and no mean loss larger than the seed-noise margin. Lower-is-better checks (aperture_mae, over-opening) are flipped."""
    stacks = list(report['stacks'])
    out = {}
    for name in stacks[1:]:
        rows = []
        for s, entry in report['sets'].items():
            for mode, me in entry['modes'].items():
                for group in ('metrics', 'downstream'):
                    for check, d in me[group][name].items():
                        if 'diff' not in d:
                            continue
                        lower = check == 'aperture_mae' or check.startswith(LOWER_BETTER_DOWN)
                        m, lo, hi = d['diff']['mean'], d['diff']['ci'][0], d['diff']['ci'][1]
                        if lower:
                            m, lo, hi = -m, -hi, -lo
                        if lo >= 0:
                            continue
                        kind = 'loss' if hi < 0 else ('possible-loss' if m < 0 else 'uncertain')
                        margin = MARGIN['mae'] if check == 'aperture_mae' else (MARGIN['r'] if check.endswith('_r') else MARGIN['rate'])
                        rows.append(dict(set=s, mode=mode, check=check, kind=kind, diff=round(m, 4), ci=[round(lo, 4), round(hi, 4)],
                                         beyondMargin=bool(m < -margin)))
        for f in report.get('verdict', {}).get(name, {}).get('failures', []):
            if f['check'].startswith('max:') or f['check'] == 'lag_ms':
                rows.append(dict(f, kind='loss', beyondMargin=True))
        strict = not rows
        noninf = not any(r['kind'] == 'loss' or r['beyondMargin'] for r in rows)
        out[name] = dict(strict=strict, nonInferior=noninf, findings=rows)
    return out


def print_report(report, focus=None):
    stacks = list(report['stacks'])
    ref = stacks[0]
    for s, entry in report['sets'].items():
        for mode, me in entry['modes'].items():
            print(f"\n== {s} / {mode}: {entry['lines']} lines, {entry['clusters']} clusters; text active "
                  + ', '.join(f"{n} {me['text'][n]['active']:.2f} (lost {me['text'][n]['lost']:.2f})" for n in stacks))
            print(f"{'metric':22s}" + ''.join(f'{n:>34s}' for n in stacks))
            for metric in me['metrics'][ref]:
                cells = []
                for n in stacks:
                    d = me['metrics'][n][metric]
                    cells.append(f"{d['mean']:.3f} ({d['diff']['mean']:+.3f} [{d['diff']['ci'][0]:+.3f},{d['diff']['ci'][1]:+.3f}])"
                                 if 'diff' in d else f"{d['mean']:.3f}")
                print(f'{metric:22s}' + ''.join(f'{c:>34s}' for c in cells))
            for check in me['downstream'][ref]:
                cells = []
                for n in stacks:
                    d = me['downstream'][n][check]
                    cells.append(f"{d['mean']:.3f} ({d['diff']['mean']:+.3f} [{d['diff']['ci'][0]:+.3f},{d['diff']['ci'][1]:+.3f}])"
                                 if 'diff' in d else f"{d['mean']:.3f}")
                print(f'{check:22s}' + ''.join(f'{c:>34s}' for c in cells))
            print('variety (stdRatio / p95Reach / peakAttain / lineStd / vel):')
            for ctl in me['variety'][ref]['perControl']:
                cells = []
                for n in stacks:
                    v = me['variety'][n]['perControl'][ctl]
                    cells.append(f"{v['stdRatio']:.2f}/{v['p95Reach']:.2f}/{v['peakAttain']:.2f}/{v['lineStdRatio']:.2f}/{v['velRatio']:.2f}")
                print(f'  {ctl:20s}' + ''.join(f'{c:>34s}' for c in cells))
            print('  codebook perplexity (game {:.1f}): '.format(me['variety'][ref]['codebook']['gtPerplexity'])
                  + ', '.join(f"{n} {me['variety'][n]['codebook']['predPerplexity']:.1f} agree {me['variety'][n]['codebook']['agreement']:.3f}" for n in stacks))
    for name, v in classify(report).items():
        print(f"\nVERDICT {name}: strict {'PASS' if v['strict'] else 'FAIL'}, non-inferior {'PASS' if v['nonInferior'] else 'FAIL'}")
        for f in sorted(v['findings'], key=lambda f: ['loss', 'possible-loss', 'uncertain'].index(f['kind'])):
            if f['kind'] != 'uncertain':
                print('   ', f)
        print(f"    + {sum(f['kind'] == 'uncertain' for f in v['findings'])} checks with a gain or tie whose interval still touches below 0")


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == '--print':
        print_report(json.loads(Path(sys.argv[2]).read_text()))
    else:
        main()
