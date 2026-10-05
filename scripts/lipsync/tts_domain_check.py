"""Domain check on the mod's own TTS output (no ground truth exists for it).

Compares mouth-geometry statistics during speech for: the game's JALI curves on
held-out game lines (reference behaviour), the trained model on those lines,
and the model vs. the previous local paths on retained Pocket/Omni/Convai
WAVs. Similar speech-time statistics on TTS audio indicate the model transfers
to cloned voices instead of collapsing or over-articulating.
"""
from __future__ import annotations

import argparse
import json
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
from native_mouth import NativeMouth  # noqa: E402
from lipsync_eval import LPS, MOUTH, geometry, sphinx_phones, rhubarb_cues, lua_ease, sample, FLAGS  # noqa: E402
from lipsync_model import NumpyModel  # noqa: E402

TTS = {
    'omni-judy': 'runtime/omni-lipsync-20261001/reply.wav',
    'omni-johnny': 'runtime/voice-replay-20260929-122047/johnny-silverhand-32-eager.wav',
    'omni-panam': 'runtime/voice-replay-20260929-122047/panam-palmer-32-eager.wav',
    'pocket-dex-prefix': 'runtime/verification/pocket-lips-stream-20261003/prefix-2.4.wav',
    'convai-judy': 'runtime/lip-replay-source-20261001/reply.wav',
    'omni-judy-30s': 'runtime/lipsync-eval/input.wav',
}


def speech_mask(audio16, frames):
    hop = 16000 // 30
    rms = np.array([np.sqrt(np.mean(audio16[i * hop:(i + 1) * hop] ** 2)) if i * hop < len(audio16) else 0 for i in range(frames)])
    return rms > max(0.01, 0.08 * np.percentile(rms, 95))


def stats(geo, mask):
    g = geo[mask]
    return {'closedFrac': round(float((g[:, 0] < 1).mean()), 3),
            'aperture25_50_75': [round(float(x), 2) for x in np.percentile(g[:, 0], [25, 50, 75])],
            'widthP5_P95': [round(float(x), 2) for x in np.percentile(g[:, 2], [5, 95])],
            'protrP5_P95': [round(float(x), 2) for x in np.percentile(g[:, 3], [5, 95])],
            'apertureStepMmPerFrame': round(float(np.mean(np.abs(np.diff(g[:, 0])))), 3)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--corpus', type=Path, default=PROJECT / 'runtime/lipsync-corpus2')
    parser.add_argument('--split', type=Path, default=PROJECT / 'runtime/lipsync-corpus2/split.json')
    parser.add_argument('--out', type=Path, default=PROJECT / 'runtime/lipsync-tts-domain.json')
    args = parser.parse_args()
    model, mouth, report = NumpyModel.load(args.model), NativeMouth('judy'), {}
    # Reference: game lines (held-out speakers), JALI vs model.
    keys = json.loads(args.split.read_text())['test'][:60]
    ref_geo, mod_geo, masks = [], [], []
    for key in keys:
        d = np.load(args.corpus / 'lines' / f'{key}.npz')
        gt, t = d['tracks'], np.arange(len(d['tracks'])) / 30
        ref_geo.append(geometry(mouth, gt[:, [LPS[c] for c in MOUTH]], MOUTH))
        tracks, frames = model.timeline(d['audio16k'])
        mod_geo.append(geometry(mouth, sample(frames, t), tracks))
        masks.append(speech_mask(d['audio16k'], len(gt)))
    mask = np.concatenate(masks)
    report['game-jali'] = stats(np.concatenate(ref_geo), mask)
    report['game-model'] = stats(np.concatenate(mod_geo), mask)
    tmp = Path(tempfile.mkdtemp(prefix='ttsdomain-', dir=PROJECT / 'runtime'))
    for name, rel in TTS.items():
        path = PROJECT / rel
        if not path.exists():
            continue
        audio, rate = sf.read(path, dtype='float32', always_2d=True)
        audio = audio.mean(1)
        a16 = resample_poly(audio, 16000, rate).astype(np.float32)
        a24 = resample_poly(audio, 24000, rate).astype(np.float32)
        n = int(len(a16) / 16000 * 30)
        t, m = np.arange(n) / 30, speech_mask(a16, n)
        tracks, frames = model.timeline(a16)
        entry = {'seconds': round(len(a16) / 16000, 2), 'model': stats(geometry(mouth, sample(frames, t), tracks), m)}
        (tmp / 'p.f32').write_bytes(a24.astype('<f4').tobytes())
        job = dict(key=name, pcm24=str(tmp / 'p.f32'), phones=sphinx_phones(a16.astype(np.float64)), cues=rhubarb_cues(a24, tmp))
        (tmp / 'j.jsonl').write_text(json.dumps(job), encoding='utf8')
        subprocess.run(['node', str(HERE / 'render_baselines.mjs'), str(tmp / 'j.jsonl'), str(tmp / 'o.jsonl')], check=True, creationflags=FLAGS)
        out = json.loads((tmp / 'o.jsonl').read_text(encoding='utf8').splitlines()[0])
        for cand in ('pocket', 'omni'):
            rows = sample(lua_ease(out[cand]['frames'], out[cand]['tracks']), t)
            entry['previous-' + cand] = stats(geometry(mouth, rows, out[cand]['tracks']), m)
        report[name] = entry
    for f in tmp.iterdir():
        f.unlink()
    tmp.rmdir()
    args.out.write_text(json.dumps(report, indent=1), encoding='utf8')
    print(json.dumps(report, indent=1))


if __name__ == '__main__':
    main()
