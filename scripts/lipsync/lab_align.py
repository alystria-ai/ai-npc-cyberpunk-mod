"""Phone-level forced alignment of corpus lines (text known) -> 100 Hz phone labels.

Two steps, two Python environments (both already in vendor/):
  g2p    (reference-voicestudio env: phonemizer + espeak-ng) pronunciations for words missing
         from CMUdict, espeak IPA mapped to ARPAbet -> <pack>/oov.dict
  align  (pocket-tts env + vendor/phone-analysis-python PocketSphinx 5, Rhubarb's en-us acoustic
         model and CMUdict) two-pass sub-word alignment of each line's subtitle text
         -> <pack>/phones100.npy (int8 labels, one per 10 ms) + phones100.json {key: [offset, n]}
Lines with foreign-language markup (<kiroshi>, <mothertongue>), digits or failed alignment get no
labels (the trainer ignores them). Label 0 is silence/noise.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
LAB = Path('E:/CyberpunkConvai-offload/work/lipsync-lab')
SPHINX = ROOT / 'vendor/rhubarb-1.14.0/Rhubarb-Lip-Sync-1.14.0-Windows/res/sphinx'
PHONES = ['SIL', 'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'B', 'CH', 'D', 'DH', 'EH', 'ER', 'EY', 'F', 'G', 'HH', 'IH', 'IY',
          'JH', 'K', 'L', 'M', 'N', 'NG', 'OW', 'OY', 'P', 'R', 'S', 'SH', 'T', 'TH', 'UH', 'UW', 'V', 'W', 'Y', 'Z', 'ZH']
IPA = {'i': 'IY', 'ɪ': 'IH', 'ᵻ': 'IH', 'e': 'EY', 'eɪ': 'EY', 'ɛ': 'EH', 'æ': 'AE', 'a': 'AA', 'ɑ': 'AA', 'ɒ': 'AA', 'ɔ': 'AO',
       'o': 'OW', 'oʊ': 'OW', 'əʊ': 'OW', 'ʊ': 'UH', 'u': 'UW', 'ʌ': 'AH', 'ə': 'AH', 'ɐ': 'AH', 'ɚ': 'ER', 'ɝ': 'ER', 'ɜ': 'ER',
       'aɪ': 'AY', 'aʊ': 'AW', 'ɔɪ': 'OY', 'p': 'P', 'b': 'B', 't': 'T', 'd': 'D', 'k': 'K', 'g': 'G', 'ɡ': 'G', 'f': 'F', 'v': 'V',
       'θ': 'TH', 'ð': 'DH', 's': 'S', 'z': 'Z', 'ʃ': 'SH', 'ʒ': 'ZH', 'h': 'HH', 'tʃ': 'CH', 'dʒ': 'JH', 'm': 'M', 'n': 'N',
       'ŋ': 'NG', 'l': 'L', 'ɹ': 'R', 'r': 'R', 'w': 'W', 'j': 'Y', 'ɾ': 'T', 'ʔ': 'T', 'x': 'HH', 'ç': 'HH', 'ɬ': 'L', 'ʎ': 'L',
       'ɲ': 'N', 'β': 'B', 'ɣ': 'G', 'y': 'UW', 'ø': 'ER', 'œ': 'ER', 'ɯ': 'UW', 'ɨ': 'IH'}


def words_of(text):
    """Spoken words, or None when the line is not plain English text."""
    if re.search(r'[<>0-9\[\]]', text) or not text.strip():
        return None
    text = text.replace('’', "'").replace('—', ' ').replace('–', ' ').replace('-', ' ')
    words = [w.lower().strip("'") for w in re.findall(r"[A-Za-z][A-Za-z']*", text)]
    return [w for w in words if w] or None


def ipa_to_arpa(phones: str):
    out = []
    for tok in phones.split():
        if tok == '_':
            continue
        tok = tok.replace('ː', '').replace('ˈ', '').replace('ˌ', '').replace('̩', '').replace('̃', '')
        rhotic = tok.endswith('ɹ') and len(tok) > 1
        if rhotic:
            tok = tok[:-1]
        if tok in IPA:
            out.append(IPA[tok])
        else:  # unknown multi-char token: map character by character
            for ch in tok:
                if ch in IPA:
                    out.append(IPA[ch])
        if rhotic:
            out.append('R')
    return out


def cmudict():
    d = {}
    for line in (SPHINX / 'cmudict-en-us.dict').read_text(encoding='utf8').splitlines():
        parts = line.split()
        if parts:
            d.setdefault(parts[0].split('(')[0], ' '.join(parts[1:]))
    return d


def g2p(pack: Path):
    import os
    import espeakng_loader
    from phonemizer.backend.espeak.wrapper import EspeakWrapper
    EspeakWrapper.set_library(espeakng_loader.get_library_path())
    os.environ['ESPEAK_DATA_PATH'] = espeakng_loader.get_data_path()
    from phonemizer.backend import EspeakBackend
    from phonemizer.separator import Separator
    d = cmudict()
    index = json.loads((pack / 'index.json').read_text())
    oov = sorted({w for r in index for w in (words_of(r['text']) or []) if w not in d})
    backend = EspeakBackend('en-us', preserve_punctuation=False, with_stress=False)
    ipa = backend.phonemize(oov, separator=Separator(phone=' ', word=' _ '), strip=True)
    lines = []
    for w, p in zip(oov, ipa):
        arpa = ipa_to_arpa(p)
        if arpa:
            lines.append(f"{w} {' '.join(arpa)}")
    (pack / 'oov.dict').write_text('\n'.join(lines) + '\n', encoding='utf8')
    print(f'{len(oov)} OOV words, {len(lines)} pronunciations')


def align(pack: Path, limit=0, procs=12):
    from multiprocessing import Pool
    index, seen = [], set()
    for r in json.loads((pack / 'index.json').read_text()):
        if r['key'] not in seen:
            seen.add(r['key']); index.append(r)
    if limit:
        index = index[:limit]
    jobs = [(r['key'], r['a'], r['an'], r['text']) for r in index]
    with Pool(procs, initializer=_init_align, initargs=(str(pack),)) as pool:
        results = pool.map(_align_one, jobs, chunksize=8)
    labels, table, fails = [], {}, 0
    offset = 0
    for key, lab in results:
        if lab is None:
            fails += 1
            continue
        table[key] = [offset, len(lab)]
        labels.append(lab); offset += len(lab)
    table['__phones__'] = PHONES
    np.save(pack / 'phones100.npy', np.concatenate(labels).astype(np.int8))
    (pack / 'phones100.json').write_text(json.dumps(table), encoding='utf8')
    print(f'aligned {len(table) - 1} lines, {fails} without labels')


_A = {}


def _init_align(pack):
    sys.path.insert(0, str(ROOT / 'vendor/phone-analysis-python'))
    from pocketsphinx import Decoder
    pack = Path(pack)
    combined = pack / 'align.dict'
    if not combined.exists():
        raise SystemExit('run the parent first')
    _A['decoder'] = Decoder(hmm=str(SPHINX / 'acoustic-model'), dict=str(combined), lm=None, samprate=16000,
                            frate=100, loglevel='FATAL', beam=1e-60, wbeam=1e-40, pbeam=1e-60)
    _A['audio'] = np.load(pack / 'audio.npy', mmap_mode='r')
    _A['dict'] = {l.split()[0] for l in combined.read_text(encoding='utf8').splitlines() if l.strip()}


def _align_one(job):
    key, a, n, text = job
    words = words_of(text)
    if not words or any(w not in _A['dict'] for w in words):
        return key, None
    d = _A['decoder']
    audio = np.array(_A['audio'][a:a + n])
    pcm = np.clip(np.rint(audio * 32767), -32768, 32767).astype('<i2').tobytes()
    try:
        d.set_align_text(' '.join(words))
        d.start_utt(); d.process_raw(pcm, full_utt=True); d.end_utt()
        d.set_alignment()
        d.start_utt(); d.process_raw(pcm, full_utt=True); d.end_utt()
        alignment = d.get_alignment()
        lab = np.zeros(int(np.ceil(n / 160)) + 1, np.int8)
        got = 0
        for word in alignment:
            for phone in word:
                name = phone.name.upper()
                if name in PHONES:
                    lab[phone.start:phone.start + phone.duration] = PHONES.index(name); got += 1
        return key, (lab if got else None)
    except Exception:
        return key, None


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('step', choices=['g2p', 'align'])
    p.add_argument('--pack', type=Path, default=LAB / 'pack')
    p.add_argument('--limit', type=int, default=0)
    p.add_argument('--procs', type=int, default=12)
    args = p.parse_args()
    if args.step == 'g2p':
        g2p(args.pack)
    else:
        lines = (SPHINX / 'cmudict-en-us.dict').read_text(encoding='utf8').splitlines()
        lines += (args.pack / 'oov.dict').read_text(encoding='utf8').splitlines()
        (args.pack / 'align.dict').write_text('\n'.join(l for l in lines if l.strip()) + '\n', encoding='utf8')
        align(args.pack, args.limit, args.procs)


if __name__ == '__main__':
    main()
