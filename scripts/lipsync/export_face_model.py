"""Export a trained lipsync_model .npz to the bridge runtime format (JSON meta + float32 blob).

Writes face-model.json and face-model.bin next to the chosen output path
(default runtime/lipsync-model/). Both are game-derived: keep them local.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

import lipsync_model as lm


def main():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('model', type=Path)
    parser.add_argument('--out', type=Path, default=root / 'runtime/lipsync-model')
    args = parser.parse_args()
    data = np.load(args.model, allow_pickle=False)
    meta = json.loads(str(data['meta']))
    tensors = {k: data[k].astype('<f4') for k in data.files if k != 'meta'}
    tensors['mel_fb'] = lm.MEL_FB.astype('<f4')
    tensors['window'] = lm.WIN.astype('<f4')
    blob, table, offset = [], [], 0
    for name, value in tensors.items():
        raw = np.ascontiguousarray(value).tobytes()
        table.append(dict(name=name, offset=offset, shape=list(value.shape)))
        blob.append(raw)
        offset += len(raw)
    controls = [[k, c] for k, (_, names) in enumerate(lm.OUTPUTS[:meta['runtimeOutputs']]) for c in names]
    meta.update(tensors=table, controls=controls)
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / 'face-model.bin').write_bytes(b''.join(blob))
    (args.out / 'face-model.json').write_text(json.dumps(meta, indent=1), encoding='utf8')
    print(f'{offset / 1e6:.2f} MB, {len(controls)} native controls, lookahead {meta["lookahead"]} frames')


if __name__ == '__main__':
    main()
