"""Objective lip-sync evaluation against Cyberpunk's own JALI lipsync curves.

Ground truth: runtime/lipsync-corpus (see extract_game_lipsync.py). Candidates:
  pocket  - production Pocket path: PocketSphinx allphone phones -> calibrated
            shapes -> PocketFacialStream (ideal phone availability) -> Lua easing
  omni    - production Omni path: Rhubarb phonetic cues -> buildFacialTimeline -> Lua easing
  model   - the game-trained audio model (lipsync_model.py), if weights exist
Metrics are reported in native track space (shared controls) and in native
mouth geometry (reconstructed Sermo solver on Judy's rig, bone origins).
Development-only; reads game-derived data under runtime/ and writes a report there.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
sys.path.insert(0, str(HERE))
from native_mouth import NativeMouth, FEATURES  # noqa: E402

RHUBARB = PROJECT / 'vendor/rhubarb-1.14.0/Rhubarb-Lip-Sync-1.14.0-Windows'
FLAGS = (subprocess.CREATE_NO_WINDOW | 0x00004000) if os.name == 'nt' else 0
SHARED = {  # metric name -> (ground-truth controls averaged, candidate controls averaged)
    'jaw': (['jaw_mid_open'], ['jaw_mid_open']),
    'together': (['lips_together_up', 'lips_together_dn'], ['lips_together_up', 'lips_together_dn']),
    'purse': (['lips_l_purse'], ['lips_l_purse', 'lips_r_purse']),
    'funnel': (['lips_l_funnel'], ['lips_l_funnel', 'lips_r_funnel']),
    'cornerStretch': (['lips_l_corner_stretch'], ['lips_l_corner_stretch', 'lips_r_corner_stretch']),
    'lowerRaise': (['lips_l_lower_raise'], ['lips_l_lower_raise', 'lips_r_lower_raise']),
    'suckDn': (['lips_suck_dn'], ['lips_suck_dn']),
}
GRAPH_CONTROLS = json.loads((PROJECT / 'assets/facial/controls.json').read_text(encoding='utf8'))['tracks']


def track_names():
    rig = PROJECT / 'runtime/facial-native-audit-20260930/json/h0_001_wa_c__judy_skeleton.rig.json'
    return [x['$value'] for x in json.loads(rig.read_text(encoding='utf-8-sig'))['Data']['RootChunk']['trackNames']]


NAMES = track_names()
LPS = {n[:-len('LipsyncPoseOutput')]: i for i, n in enumerate(NAMES) if n.endswith('LipsyncPoseOutput')}
MOUTH = [c for c in LPS if c.startswith(('jaw_', 'lips_', 'cheek_', 'tongue_'))]


def lua_ease(frames, tracks):
    """facial-playback.lua local-phonetic-smooth-v1, sampled at 60 Hz audio time."""
    out = np.array(frames, dtype=np.float64)
    contact = np.array([t in ('lips_together_up', 'lips_together_dn', 'tongue_mid_tip_up', 'lips_suck_dn') for t in tracks])
    pose = np.zeros(len(tracks))
    last = None
    for row in out:
        elapsed = 1 / 60 if last is None else max(0.0, row[0] - last)
        value = row[1:]
        seconds = np.where(contact & (value > pose), .018, .035)
        pose = pose + (value - pose) * (1 - np.exp(-elapsed / seconds))
        row[1:] = pose
        last = row[0]
    return out


def sample(frames, times):
    frames = np.asarray(frames)
    return np.stack([np.interp(times, frames[:, 0], frames[:, k]) for k in range(1, frames.shape[1])], axis=1)


def sphinx_phones(audio16):
    sys.path.insert(0, str(PROJECT / 'vendor/phone-analysis-python'))
    from pocketsphinx import Decoder
    global _DECODER
    if '_DECODER' not in globals():
        _DECODER = Decoder(hmm=str(RHUBARB / 'res/sphinx/acoustic-model'), allphone=str(RHUBARB / 'res/sphinx/en-us-phone.lm.bin'),
                           lm=None, dict=None, allphone_ci=True, lw=.8, dither=False, cmn='live', remove_noise=False,
                           samprate=16000, frate=100, beam=1e-20, pbeam=1e-20, loglevel='FATAL')
        globals()['_CMN0'] = _DECODER.get_cmn()
    d = _DECODER
    d.set_cmn(_CMN0)
    d.start_utt()
    pcm = np.clip(np.rint(audio16 * 32767), -32768, 32767).astype('<i2').tobytes()
    for at in range(0, len(pcm), 2560):  # 80 ms packets, like the worker
        d.process_raw(pcm[at:at + 2560], False, False)
    d.end_utt()
    if d.hyp() is None:
        return []
    return [dict(phone=s.word, startFrame=s.start_frame, endFrame=s.end_frame) for s in d.seg()]


def rhubarb_cues(pcm24, folder):
    wav, out = folder / 'r.wav', folder / 'r.json'
    sf.write(wav, pcm24, 24000, subtype='PCM_16')
    subprocess.run([str(RHUBARB / 'rhubarb.exe'), '--quiet', '--threads', '2', '-r', 'phonetic', '-f', 'json',
                    '--extendedShapes', 'GHX', '-o', str(out), str(wav)], check=True, creationflags=FLAGS)
    return json.loads(out.read_text())['mouthCues']


def to_weights(row, tracks):
    return {t: float(v) for t, v in zip(tracks, row) if v > 1e-5}


def geometry(mouth, rows, tracks, limit=None):
    out = []
    for row in rows:
        weights = to_weights(row, tracks)
        if limit is not None:
            weights = {k: v for k, v in weights.items() if k in limit}
        out.append(mouth.features({k: min(v, 1.0) for k, v in weights.items()}))
    return np.array(out)


def pearson(a, b):
    if a.std() < 1e-9 or b.std() < 1e-9:
        return float('nan')
    return float(np.corrcoef(a, b)[0, 1])


def best_lag(a, b, rate=30, span=6):
    scores = {}
    for lag in range(-span, span + 1):
        x, y = (a[lag:], b[:len(b) - lag]) if lag >= 0 else (a[:lag], b[-lag:])
        scores[lag] = pearson(x, y)
    lag = max(scores, key=lambda k: -1 if np.isnan(scores[k]) else scores[k])
    # Pairs (gt[t+lag], cand[t]). Report positive milliseconds when the candidate is LATE.
    return -lag * 1000 / rate


def line_metrics(gt_rows, cand_rows, cand_tracks, gt_geo, cand_geo):
    m = {}
    for name, (g, c) in SHARED.items():
        gv = np.mean([gt_rows[:, LPS[t]] for t in g], axis=0)
        cv = np.mean([cand_rows[:, cand_tracks.index(t)] if t in cand_tracks else np.zeros(len(cand_rows)) for t in c], axis=0)
        m[name] = dict(r=pearson(gv, cv), mae=float(np.mean(np.abs(gv - cv))), gtMean=float(gv.mean()), candMean=float(cv.mean()))
    for k, f in enumerate(FEATURES):
        m['geo_' + f] = dict(r=pearson(gt_geo[:, k], cand_geo[:, k]), mae=float(np.mean(np.abs(gt_geo[:, k] - cand_geo[:, k]))),
                             gtMean=float(gt_geo[:, k].mean()), candMean=float(cand_geo[:, k].mean()))
    # Lip contact during speech: inner aperture within 1 mm of the closed neutral.
    speaking = gt_rows[:, LPS['jaw_mid_open']] > 0.02
    target = (gt_geo[:, 0] < 1.0) & speaking
    hit = cand_geo[:, 0] < 1.0
    m['closure'] = dict(gtFrames=int(target.sum()), recall=float((hit & target).sum() / max(1, target.sum())),
                        falseOpenMm=float(np.mean(cand_geo[target, 0])) if target.any() else float('nan'),
                        precision=float((hit & target).sum() / max(1, (hit & speaking).sum())))
    m['lagMs'] = best_lag(gt_geo[:, 0], cand_geo[:, 0])
    # Event recall in track space: F/V (lower lip to upper teeth: lower contact
    # without upper contact) and lip rounding (purse), as the game authors them.
    def col(rows, tracks, name):
        return rows[:, tracks.index(name)] if name in tracks else np.zeros(len(rows))
    g_up, g_dn = gt_rows[:, LPS['lips_together_up']], gt_rows[:, LPS['lips_together_dn']]
    c_up, c_dn = col(cand_rows, cand_tracks, 'lips_together_up'), col(cand_rows, cand_tracks, 'lips_together_dn')
    fv = (g_dn > .5) & (g_up < .2)
    m['fv'] = dict(gtFrames=int(fv.sum()), recall=float(((c_dn > .35) & (c_dn - c_up > .2))[fv].mean()) if fv.any() else float('nan'))
    g_round = gt_rows[:, LPS['lips_l_purse']] > .15
    c_round = np.maximum(col(cand_rows, cand_tracks, 'lips_l_purse'), col(cand_rows, cand_tracks, 'lips_l_funnel')) > .1
    m['rounding'] = dict(gtFrames=int(g_round.sum()), recall=float(c_round[g_round].mean()) if g_round.any() else float('nan'),
                         precision=float(g_round[c_round].mean()) if c_round.any() else float('nan'))
    return m


def aggregate(per_line):
    keys = per_line[0].keys()
    out = {}
    for k in keys:
        if isinstance(per_line[0][k], dict):
            out[k] = {}
            for f in per_line[0][k]:
                vals = np.array([p[k][f] for p in per_line], dtype=float)
                out[k][f] = float(np.nanmean(vals)) if f != 'gtFrames' else int(np.nansum(vals))
        else:
            vals = np.array([p[k] for p in per_line], dtype=float)
            out[k] = float(np.nanmedian(vals))
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, default=PROJECT / 'runtime/lipsync-corpus2')
    parser.add_argument('--split', type=Path, help='JSON with {"test": [keys]}')
    parser.add_argument('--limit', type=int, default=120)
    parser.add_argument('--model', type=Path, help='trained model .npz for the model candidate')
    parser.add_argument('--candidates', default='pocket,omni,model')
    parser.add_argument('--out', type=Path, default=PROJECT / 'runtime/lipsync-eval-report.json')
    args = parser.parse_args()
    manifest = [json.loads(l) for l in (args.corpus / 'manifest.jsonl').read_text(encoding='utf8').splitlines() if l.strip()]
    keys = json.loads(args.split.read_text())['test'] if args.split else [m['key'] for m in manifest]
    keys = keys[:args.limit]
    wanted = set(args.candidates.split(','))
    model = None
    if 'model' in wanted and args.model:
        from lipsync_model import NumpyModel
        model = NumpyModel.load(args.model)
    mouth = NativeMouth('judy')
    jobs, cache = [], {}
    tmp = Path(tempfile.mkdtemp(prefix='lipeval-', dir=PROJECT / 'runtime'))
    for key in keys:
        data = np.load(args.corpus / 'lines' / f'{key}.npz')
        audio16 = data['audio16k'].astype(np.float64)
        pcm24 = resample_poly(audio16, 3, 2).astype(np.float32)
        (tmp / f'{key}.f32').write_bytes(pcm24.astype('<f4').tobytes())
        job = dict(key=key, pcm24=str(tmp / f'{key}.f32'))
        if 'pocket' in wanted:
            job['phones'] = sphinx_phones(audio16)
        if 'omni' in wanted:
            job['cues'] = rhubarb_cues(pcm24, tmp)
        jobs.append(job)
        cache[key] = data
    rendered = {}
    if wanted & {'pocket', 'omni'}:
        (tmp / 'jobs.jsonl').write_text('\n'.join(json.dumps(j) for j in jobs), encoding='utf8')
        subprocess.run(['node', str(HERE / 'render_baselines.mjs'), str(tmp / 'jobs.jsonl'), str(tmp / 'out.jsonl')],
                       check=True, creationflags=FLAGS)
        for line in (tmp / 'out.jsonl').read_text(encoding='utf8').splitlines():
            r = json.loads(line)
            rendered[r['key']] = r
    results = {c: [] for c in ['pocket', 'omni', 'model', 'jaliGraphOnly'] if c in wanted or c == 'jaliGraphOnly'}
    for key in keys:
        data = cache[key]
        gt = data['tracks']
        times = np.arange(len(gt)) / 30
        gt_geo = geometry(mouth, gt[:, [LPS[c] for c in MOUTH]], MOUTH)
        graph_geo = geometry(mouth, gt[:, [LPS[c] for c in MOUTH]], MOUTH, limit=set(GRAPH_CONTROLS))
        mouth_rows = gt
        results['jaliGraphOnly'].append(line_metrics(mouth_rows, gt[:, [LPS[c] for c in MOUTH]], MOUTH, gt_geo, graph_geo))
        for cand in ('pocket', 'omni'):
            if cand in wanted and cand in rendered.get(key, {}):
                r = rendered[key][cand]
                rows = sample(lua_ease(r['frames'], r['tracks']), times)
                results[cand].append(line_metrics(gt, rows, r['tracks'], gt_geo, geometry(mouth, rows, r['tracks'])))
        if model is not None:
            tracks, frames = model.timeline(data['audio16k'])
            rows = sample(frames, times)
            results['model'].append(line_metrics(gt, rows, tracks, gt_geo, geometry(mouth, rows, tracks)))
    report = {'lines': len(keys), 'seconds': float(sum(len(cache[k]['tracks']) / 30 for k in keys)),
              'candidates': {k: aggregate(v) for k, v in results.items() if v}}
    args.out.write_text(json.dumps(report, indent=1), encoding='utf8')
    for cand, agg in report['candidates'].items():
        print(f'== {cand}')
        for k, v in agg.items():
            print(f'  {k:20s}', {a: round(b, 3) if isinstance(b, float) else b for a, b in v.items()} if isinstance(v, dict) else round(v, 1))
    for f in tmp.iterdir():
        f.unlink()
    tmp.rmdir()


if __name__ == '__main__':
    main()
