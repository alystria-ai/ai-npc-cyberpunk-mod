"""Write the held-out-speaker test split used by training and evaluation.

Uses the same speaker split as lipsync_model.split_lines, so evaluation lines
come only from speakers the model never saw during training.
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import lipsync_model as lm


def main():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, default=root / 'runtime/lipsync-corpus2')
    parser.add_argument('--manifest', default='manifest.jsonl')
    parser.add_argument('--out', type=Path)
    args = parser.parse_args()
    rows = [json.loads(l) for l in (args.corpus / args.manifest).read_text(encoding='utf8').splitlines() if l.strip()]
    train, test = lm.split_lines([dict(key=r['key'], actor=r['actor']) for r in rows])
    random.Random(5).shuffle(test)
    out = args.out or args.corpus / 'split.json'
    out.write_text(json.dumps({'test': [l['key'] for l in test], 'heldActors': sorted({l['actor'] for l in test})}), encoding='utf8')
    print(f'{len(train)} train / {len(test)} test lines; held-out speakers: {len({l["actor"] for l in test})}')


if __name__ == '__main__':
    main()
