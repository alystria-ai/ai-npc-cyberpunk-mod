"""Quality of the Omni precision variants rendered by Measure-OmniPrecision.mjs, with the likeness research tooling.

    python scripts/Score-OmniPrecision.py [--work DIR] [--baseline fp16-s16-graph] label [label ...]

Reads (never writes) the research tooling and caches under E:/CyberpunkConvai-offload/work/likeness-phase1:
  * ECAPA speaker similarity to the centroid of the voice's real clips (score.py: S.clip_metrics(...)['ecapa']['cent']);
    the clips are the two panel lines (quality/<label>/) and the two listening lines (audio/<label>/);
  * PLS (perceptual.py + np_score.py logic, no WER): per-line MCD to the real line, high-band error and MFCC Frechet
    distance to the voice's real clips, anchored base Pocket = 60 and OmniVoice 32 = 90 on the SAME voices and lines.
Results go to <work>/scores.json; the embedding/feature cache is <work>/score-cache.pt (the research caches stay as they are).
Noise: a standard error across clips; deltas against --baseline are paired (same voice, line and seed), so they are much
tighter than the unpaired standard errors.
"""
import argparse, json, math, sys
from collections import defaultdict
from pathlib import Path

LIKENESS = Path('E:/CyberpunkConvai-offload/work/likeness-phase1')
sys.path.insert(0, str(LIKENESS / 'exp-scripts'))
parser = argparse.ArgumentParser()
parser.add_argument('labels', nargs='+')
parser.add_argument('--work', default='E:/CyberpunkConvai-offload/work/omni-precision')
parser.add_argument('--baseline', default='fp16-s16-graph')
parser.add_argument('--no-pls', action='store_true')
args = parser.parse_args()
sys.argv = sys.argv[:1]

import numpy as np
import torch
from common import *  # noqa: F401,F403
import score as S
import perceptual as P

work = Path(args.work)
CACHE = work / 'score-cache.pt'
mine = torch.load(CACHE, weights_only=False) if CACHE.exists() else {'emb': {}, 'perc': {}}
S.cache.update(mine['emb'])
for name in ('perc_cache.pt', 'np_perc_cache.pt'):          # research caches, read only
    if (OUT / name).exists():
        P.cache.update(torch.load(OUT / name, weights_only=False))
P.cache.update(mine['perc'])

panel = json.loads((OUT / 'panel.json').read_text())
omni_refs = json.loads((ROOT / 'runtime/local-voices.json').read_text(encoding='utf-8-sig'))['voices']


def clips(label):
    """(speaker, kind, line, path) for every scored clip of one variant."""
    out = []
    records = json.loads((work / 'quality' / label / 'records.json').read_text())['records']
    for r in records:
        out.append((r['speaker'], 'panel', r['line'], work / 'quality' / label / r['file']))
    for path in sorted((work / 'audio' / label).glob('*__*.wav')):
        speaker, kind = path.stem.split('__')
        out.append((speaker, 'text-' + kind, 0, path))
    return out


def ecapa(speaker, path):
    emb = S.emb_file(path)
    names, matrix = S.CENT['ecapa']
    return float(matrix[names.index(speaker)] @ emb['ecapa'])


def macro(values):
    by = defaultdict(list)
    for speaker, v in values:
        by[speaker].append(v)
    return float(np.mean([np.mean(v) for v in by.values()]))


def se(values):
    values = np.asarray(values, float)
    return float(values.std(ddof=1) / math.sqrt(len(values))) if len(values) > 1 else float('nan')


scores = {}
for label in args.labels:
    rows = clips(label)
    scores[label] = {'rows': [{'speaker': s, 'kind': k, 'line': l, 'ecapa': ecapa(s, p)} for s, k, l, p in rows]}
    values = [(r['speaker'], r['ecapa']) for r in scores[label]['rows']]
    scores[label]['ecapa'] = {'macro': macro(values), 'se': se([v for _, v in values]), 'n': len(values),
                              'panelMacro': macro([(r['speaker'], r['ecapa']) for r in scores[label]['rows'] if r['kind'] == 'panel']),
                              'textMacro': macro([(r['speaker'], r['ecapa']) for r in scores[label]['rows'] if r['kind'] != 'panel'])}
    print(label, scores[label]['ecapa'], flush=True)
mine['emb'] = dict(S.cache)

base = scores.get(args.baseline)
if base:
    key = lambda r: (r['speaker'], r['kind'], r['line'])
    reference = {key(r): r['ecapa'] for r in base['rows']}
    for label, entry in scores.items():
        delta = [r['ecapa'] - reference[key(r)] for r in entry['rows'] if key(r) in reference]
        from scipy import stats as _st
        half = float(_st.t.ppf(.975, len(delta) - 1) * se(delta)) if len(delta) > 1 else float('nan')
        entry['ecapaDeltaVsBaseline'] = {'mean': float(np.mean(delta)), 'se': se(delta), 'ci95': [float(np.mean(delta)) - half, float(np.mean(delta)) + half],
                                         'n': len(delta), 'sameWithinNoise': bool(abs(np.mean(delta)) <= half)}
        # Objective waveform difference to the baseline render of the same voice/line/seed: mean absolute log-mel
        # difference in dB (80 mel bands to 12 kHz, 24 kHz audio, trimmed to the shorter render) and the length ratio.
        paths = {key(r): w for r, w in zip(entry['rows'], [c[3] for c in clips(label)])}
        base_paths = {key(r): w for r, w in zip(base['rows'], [c[3] for c in clips(args.baseline)])}
        dists, lens = [], []
        for k, path in paths.items():
            if k not in base_paths:
                continue
            a, b = load_audio(str(path), 24000), load_audio(str(base_paths[k]), 24000)
            n = min(len(a), len(b)); lens.append(len(a) / len(b))
            with torch.no_grad():
                ma = (P.MEL(a[:n].to(P.dev)) + 1e-6).log10().mul(10); mb = (P.MEL(b[:n].to(P.dev)) + 1e-6).log10().mul(10)
            dists.append(float((ma - mb).abs().mean()))
        entry['melDistVsBaselineDb'] = {'mean': float(np.mean(dists)), 'se': se(dists), 'n': len(dists), 'lengthRatioMean': float(np.mean(lens))}

# ---- PLS (secondary) ----------------------------------------------------------------------------------
if not args.no_pls:
    refs = P.voice_refs(panel)
    voices = sorted({s for e in scores.values() for s, *_ in [(r['speaker'],) for r in e['rows']]})
    real_stats = {}
    for spk in voices:
        fs = [P.features(c['path'], 0.0, None, c['id']) for c in refs.get(spk, [])[:10]]
        mel = torch.cat([f['mel_act'].float() for f in fs]).numpy()
        mf = torch.cat([f['mfcc'][:, 1:].float() for f in fs]).numpy()
        real_stats[spk] = {'ltas': mel.mean(0), 'mfcc': mf}

    def per_line(folder, record_list):
        out = {}
        for r in record_list:
            spk, li = r['speaker'], r['line']
            tgt = panel[spk]['targets'][li]
            g = P.features(folder / r['file'])
            o = P.features(tgt['path'], tgt['start'], tgt['duration'], 'tgt:' + tgt['id'])
            lk = ('line', str(folder / r['file']), tgt['id'])
            if lk not in P.cache:
                P.cache[lk] = P.line_metrics(g, o)
            out[(spk, li)] = {'mcd': P.cache[lk]['mcd'], 'mfcc': g['mfcc'][:, 1:].float().numpy(),
                              'hi': float(np.abs(g['mel_act'].float().numpy().mean(0) - real_stats[spk]['ltas'])[P.HIGH_BINS:].mean())}
        return out

    def aggregate(lines):
        by = defaultdict(list)
        for (spk, _), m in lines.items():
            by[spk].append(m)
        return {'mcd': float(np.mean([np.mean([x['mcd'] for x in v]) for v in by.values()])),
                'ltas_hi_err': float(np.mean([np.mean([x['hi'] for x in v]) for v in by.values()])),
                'fd_mfcc': float(np.median([P.frechet(np.concatenate([x['mfcc'] for x in v]), real_stats[s]['mfcc']) for s, v in by.items()]))}

    wanted = {(r['speaker'], r['line']) for e in scores.values() for r in e['rows'] if r['kind'] == 'panel'}
    def anchor(name):
        folder = OUT / 'gen' / name
        records = [r for r in json.loads((folder / 'records.json').read_text())['records'] if (r['speaker'], r['line']) in wanted]
        return aggregate(per_line(folder, records))
    lo, hi = anchor('base6-2609__cfg1'), anchor('omni__s32_g2')
    scores['_anchors'] = {'base6-2609__cfg1': lo, 'omni__s32_g2': hi, 'omni__s16_g2 (research, same lines)': anchor('omni__s16_g2')}
    for label in args.labels:
        folder = work / 'quality' / label
        records = json.loads((folder / 'records.json').read_text())['records']
        agg = aggregate(per_line(folder, records))
        parts = [60 + 30 * (lo[k] - agg[k]) / (lo[k] - hi[k]) for k in ('fd_mfcc', 'mcd', 'ltas_hi_err')]
        scores[label]['pls'] = {**agg, 'PLS': round(sum(parts) / 3, 1), 'parts': [round(x, 1) for x in parts]}
        print(label, 'PLS', scores[label]['pls']['PLS'], scores[label]['pls']['parts'], flush=True)
    mine['perc'] = {k: v for k, v in P.cache.items()}

torch.save(mine, CACHE)
(work / 'scores.json').write_text(json.dumps(scores, indent=1, default=float))
print('wrote', work / 'scores.json')
