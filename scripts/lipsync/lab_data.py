"""Pack the lip-sync corpus for fast experiments, and write the extended split.

Packs every usable corpus line (same filter as lipsync_model.load_corpus) into
one float32 memmap of 16 kHz audio plus a targets array, so DataLoader workers
share it instead of copying 1.5 GB per process. Also attaches the subtitle text
(decimal stringId = the line's hex id) used for forced alignment and cloning.

Split (split2.json) keeps the original held-out-speaker test set unchanged
(`test`, from split.json) and adds per-character held-out sets (`charTest`) for
Judy, Johnny and Panam, chosen by whole scenes (~25 % of each character's
lines). Any training line whose normalised text equals a held-out line's text
is dropped from training too (`excludeTrain`), so repeated barks cannot leak.

Everything written here is derived from game assets: keep it in ignored folders.
"""
from __future__ import annotations

import argparse
import json
import random
import re
from collections import defaultdict
from pathlib import Path

import numpy as np

import lipsync_model as lm

ROOT = Path(__file__).resolve().parents[2]
LAB = Path('E:/CyberpunkConvai-offload/work/lipsync-lab')
SUBTITLES = Path('E:/CyberpunkConvai-offload/work/reference-pool-expanded/_work/subtitles.json')
CHARACTERS = ['judy', 'johnny', 'panam']


def norm_text(text):
    return re.sub(r'[^a-z0-9 ]+', '', text.lower().replace('-', ' ')).strip()


def pack(corpus: Path, out: Path):
    names = json.loads((corpus / 'track-names.json').read_text())
    lps = {n[:-len('LipsyncPoseOutput')]: i for i, n in enumerate(names) if n.endswith('LipsyncPoseOutput')}
    cols = [[lps[c] for c in controls] for _, controls in lm.OUTPUTS]
    subs = json.loads(SUBTITLES.read_text(encoding='utf8')) if SUBTITLES.exists() else {}
    out.mkdir(parents=True, exist_ok=True)
    index, audio_parts, y_parts, a_off, y_off = [], [], [], 0, 0
    for row in (corpus / 'manifest.jsonl').read_text(encoding='utf8').splitlines():
        if not row.strip():
            continue
        m = json.loads(row)
        path = corpus / 'lines' / f"{m['key']}.npz"
        if not path.exists():
            continue
        d = np.load(path)
        tr = d['tracks']
        y = np.stack([tr[:, c].mean(axis=1) for c in cols], 1).astype(np.float32)
        if y[:, 0].max() < 0.05:
            continue
        audio = d['audio16k'].astype(np.float32)
        variants = subs.get(str(int(m['hex'], 16)), ['', ''])
        male = '_m_' in m['wem'].rsplit('\\', 1)[-1] or m['anim'].startswith('m_')
        text = (variants[1] if male and len(variants) > 1 and variants[1] else variants[0]) or ''
        scene = m['anims'].split('\\')[-2]
        index.append(dict(key=m['key'], actor=m['actor'], scene=scene, text=text, a=a_off, an=len(audio),
                          y=y_off, yn=len(y)))
        audio_parts.append(audio); y_parts.append(y)
        a_off += len(audio); y_off += len(y)
    audio = np.concatenate(audio_parts)
    mm = np.lib.format.open_memmap(out / 'audio.npy', mode='w+', dtype=np.float32, shape=audio.shape)
    mm[:] = audio; mm.flush()
    np.save(out / 'y30.npy', np.concatenate(y_parts))
    (out / 'index.json').write_text(json.dumps(index), encoding='utf8')
    print(f'packed {len(index)} lines, {a_off / 16000 / 3600:.2f} h, {sum(1 for i in index if i["text"])} with text')
    return index


def make_split(index, corpus: Path, out: Path, frac=.25, seed=11):
    test = json.loads((corpus / 'split.json').read_text())['test']
    test_set = set(test)
    char_test = {}
    rng = random.Random(seed)
    for who in CHARACTERS:
        rows = [r for r in index if r['actor'] == who]
        scenes = defaultdict(list)
        for r in rows:
            scenes[r['scene']].append(r['key'])
        order = sorted(scenes)
        rng.shuffle(order)
        chosen, total = [], 0
        for s in order:  # whole scenes until ~frac of the character's lines
            if total >= frac * len(rows):
                break
            if len(scenes[s]) > .45 * len(rows):
                continue
            chosen.append(s); total += len(scenes[s])
        char_test[who] = sorted(k for s in chosen for k in scenes[s])
    held_texts = {norm_text(r['text']) for r in index if r['text'] and (r['key'] in test_set or any(r['key'] in v for v in char_test.values()))}
    held_keys = test_set | {k for v in char_test.values() for k in v}
    exclude = sorted(r['key'] for r in index if r['key'] not in held_keys and r['text'] and norm_text(r['text']) in held_texts
                     and len(norm_text(r['text'])) > 0)
    split = dict(test=test, heldActors=json.loads((corpus / 'split.json').read_text())['heldActors'],
                 charTest=char_test, excludeTrain=exclude,
                 charScenes={w: sorted({r['scene'] for r in index if r['key'] in set(v)}) for w, v in char_test.items()})
    out.write_text(json.dumps(split, indent=1), encoding='utf8')
    for w, v in char_test.items():
        n = sum(1 for r in index if r['actor'] == w)
        print(f'{w}: {len(v)} held-out of {n} lines, scenes {split["charScenes"][w]}')
    print(f'{len(exclude)} training lines dropped for sharing text with a held-out line')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, default=ROOT / 'runtime/lipsync-corpus2')
    parser.add_argument('--out', type=Path, default=LAB / 'pack')
    parser.add_argument('--split-only', action='store_true')
    args = parser.parse_args()
    index = json.loads((args.out / 'index.json').read_text()) if args.split_only else pack(args.corpus, args.out)
    make_split(index, args.corpus, args.out / 'split2.json')


if __name__ == '__main__':
    main()
