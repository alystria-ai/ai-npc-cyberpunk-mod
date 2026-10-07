"""Export a candidate lip-sync model and check the bridge's JavaScript inference against NumPy.

  python lab_parity.py <model.npz> <out-dir> [--lines 6]

1. export_face_model.py-format files (face-model.json/.bin) into <out-dir> (a NEW folder; never the live
   runtime/lipsync-model/face-model.*),
2. streams held-out corpus lines through bridge/jali-face-model.mjs FaceModelStream in 80 ms packets
   (exactly the bridge's streaming path) and compares every row with lipsync_model.NumpyModel,
3. times the JS model on 30 s of speech (single thread, this machine's current load) -> CPU seconds per second.
Writes <out-dir>/parity.json. Game-derived weights: keep <out-dir> under runtime/ (ignored).
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import lipsync_model as lm  # noqa: E402

JS = r"""
import {readFileSync, writeFileSync} from 'node:fs';
import {parseFaceModel, FaceModelStream} from '%BRIDGE%';
const [dir, jobsPath, outPath] = process.argv.slice(2);
const meta = JSON.parse(readFileSync(dir + '/face-model.json', 'utf8'));
const model = parseFaceModel(meta, readFileSync(dir + '/face-model.bin'));
const jobs = JSON.parse(readFileSync(jobsPath, 'utf8')), out = {};
for (const job of jobs) {
  const buf = readFileSync(job.audio), audio = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const stream = new FaceModelStream(model, 16000), rows = [];
  for (let at = 0; at < audio.length; at += 1280) rows.push(...stream.push(audio.slice(at, at + 1280)));
  rows.push(...stream.finish());
  out[job.key] = rows;
}
const bench = new Float32Array(16000 * 30);
const src = Object.values(jobs).map(j => { const b = readFileSync(j.audio); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); });
for (let i = 0, k = 0; i < bench.length; k++) { const a = src[k % src.length]; bench.set(a.subarray(0, Math.min(a.length, bench.length - i)), i); i += a.length; }
const started = process.hrtime.bigint();
const s = new FaceModelStream(model, 16000);
for (let at = 0; at < bench.length; at += 1280) s.push(bench.slice(at, at + 1280));
s.finish();
const seconds = Number(process.hrtime.bigint() - started) / 1e9;
writeFileSync(outPath, JSON.stringify({rows: out, outputs: model.outputs, lookahead: model.lookahead, benchSeconds: seconds, benchAudio: 30}));
"""


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('model', type=Path)
    p.add_argument('out', type=Path)
    p.add_argument('--lines', type=int, default=6)
    args = p.parse_args()
    live = (ROOT / 'runtime/lipsync-model').resolve()
    if args.out.resolve() == live:
        raise SystemExit('refusing to overwrite the live runtime/lipsync-model/face-model.*')
    subprocess.run([sys.executable, str(HERE / 'export_face_model.py'), str(args.model), '--out', str(args.out)], check=True, cwd=HERE)
    model = lm.NumpyModel.load(args.model)
    split = json.loads((ROOT / 'runtime/lipsync-corpus2/split.json').read_text())
    work = args.out / 'parity-work'
    work.mkdir(exist_ok=True)
    jobs, refs = [], {}
    for key in split['test'][:args.lines]:
        a = np.load(ROOT / 'runtime/lipsync-corpus2/lines' / f'{key}.npz')['audio16k'].astype(np.float32)
        (work / f'{key}.f32').write_bytes(a.astype('<f4').tobytes())
        jobs.append(dict(key=key, audio=str(work / f'{key}.f32')))
        refs[key] = model.predict(a)[1]
    (work / 'jobs.json').write_text(json.dumps(jobs))
    script = work / 'parity.mjs'
    script.write_text(JS.replace('%BRIDGE%', (ROOT / 'bridge/jali-face-model.mjs').as_uri()), encoding='utf8')
    subprocess.run(['node', str(script), str(args.out), str(work / 'jobs.json'), str(work / 'js.json')], check=True)
    js = json.loads((work / 'js.json').read_text())
    worst = 0.0
    for key, ref in refs.items():
        rows = np.array(js['rows'][key], np.float32).reshape(-1, js['outputs'])[js['lookahead']:]
        n = min(len(rows), len(ref))
        worst = max(worst, float(np.abs(rows[:n] - ref[:n]).max()))
    report = dict(model=str(args.model), lines=len(refs), maxAbsDiff=worst,
                  jsCpuSecondsPerAudioSecond=js['benchSeconds'] / js['benchAudio'])
    (args.out / 'parity.json').write_text(json.dumps(report, indent=1))
    for f in work.iterdir():
        f.unlink()
    work.rmdir()
    print(json.dumps(report, indent=1))
    if worst > 1e-3:
        raise SystemExit('JS/NumPy parity FAILED')


if __name__ == '__main__':
    main()
