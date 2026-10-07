"""Runtime-feasible text alignment: the lip-sync model's own phone head + Viterbi over the known phone sequence.

No PocketSphinx at runtime: the stage-1 network (lab_train --aux-phones --save-pt) already produces 100 Hz phone
posteriors (its training-only head, kept here). Given the reply text (CMUdict + espeak OOV lexicon from lab_align),
a left-to-right HMM (phones in order, optional silence between words) is aligned to the posteriors:

  full      whole-utterance Viterbi (Omni per-phrase WAV + phrase text)
  stream    fixed-lag decisions: the label of each frame is decided from the best partial path `--lag` output
            frames later (Pocket / Convai streamed PCM); combine with a --phone-delay model

Writes raw 100 Hz labels (PocketSphinx time base, before lab_train.LAB_SHIFT) to <out>/<key>.npy so lab_eval
(--label-dir) can feed them to phone-input models in place of the PocketSphinx labels.
Cost per second of audio: one 160x40 projection per 10 ms frame plus O(phones) Viterbi updates; no new model.
"""
from __future__ import annotations

import argparse
import json
import random
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import lab_align as la  # noqa: E402
import lab_train as lt  # noqa: E402

LAB = lt.LAB


def lexicon():
    d = {}
    for line in (LAB / 'pack/align.dict').read_text(encoding='utf8').splitlines():
        parts = line.split()
        if parts and '(' not in parts[0]:
            d.setdefault(parts[0], [la.PHONES.index(p) for p in parts[1:] if p in la.PHONES])
    return d


def states_for(words, lex):
    """State list: phone ids; optional-silence flags. Starts and ends with silence."""
    ph, optional = [0], [True]
    for i, w in enumerate(words):
        for p in lex[w]:
            ph.append(p); optional.append(False)
        ph.append(0); optional.append(True)
    return np.array(ph), np.array(optional)


def viterbi(logp, ph, optional, lag=None, stay=np.log(.8), move=np.log(.2)):
    """logp (T, P) log scores; returns state index per frame (full) or fixed-lag decisions (lag frames)."""
    T, S = len(logp), len(ph)
    emit = logp[:, ph]  # (T, S)
    delta = np.full(S, -np.inf); delta[0] = emit[0, 0]
    if optional[0] and S > 1:
        delta[1] = emit[0, 1]
    back = np.zeros((T, S), np.int32)
    decided = np.zeros(T, np.int32)
    for t in range(1, T):
        cand_stay = delta + stay
        cand_move = np.full(S, -np.inf); cand_move[1:] = delta[:-1] + move
        cand_skip = np.full(S, -np.inf)  # skip an optional silence
        cand_skip[2:] = np.where(optional[1:-1], delta[:-2] + move, -np.inf)
        best = np.stack([cand_stay, cand_move, cand_skip])
        arg = best.argmax(0)
        delta = best.max(0) + emit[t]
        back[t] = np.arange(S) - arg  # previous state
        if lag is not None and t >= lag:
            s = int(delta.argmax())
            for k in range(t, t - lag, -1):
                s = back[k, s]
            decided[t - lag] = s
    # Final states: must end in the last (silence) or last phone state.
    end = S - 1 if delta[S - 1] >= delta[S - 2] else S - 2
    path = np.zeros(T, np.int32); path[-1] = end
    for t in range(T - 1, 0, -1):
        path[t - 1] = back[t, path[t]]
    if lag is not None:  # the last `lag` frames are decided at the end of the utterance
        decided[max(0, T - lag):] = path[max(0, T - lag):]
        if T <= lag:
            decided = path
        return decided
    return path


class StreamViterbi:
    """Incremental version of viterbi(): push one frame of log scores, read fixed-lag decisions."""

    def __init__(self, ph, optional, stay=np.log(.8), move=np.log(.2)):
        self.ph, self.opt, self.stay, self.move = ph, optional, stay, move
        self.delta, self.back = None, []

    def push(self, logp_row):
        emit = logp_row[self.ph]
        S = len(self.ph)
        if self.delta is None:
            self.delta = np.full(S, -np.inf); self.delta[0] = emit[0]
            if self.opt[0] and S > 1:
                self.delta[1] = emit[1]
            self.back.append(np.zeros(S, np.int32))
            return
        d = self.delta
        cand_move = np.full(S, -np.inf); cand_move[1:] = d[:-1] + self.move
        cand_skip = np.full(S, -np.inf); cand_skip[2:] = np.where(self.opt[1:-1], d[:-2] + self.move, -np.inf)
        best = np.stack([d + self.stay, cand_move, cand_skip])
        arg = best.argmax(0)
        self.delta = best.max(0) + emit
        self.back.append((np.arange(S) - arg).astype(np.int32))

    def decide(self, frame):
        """State at `frame` on the best partial path ending at the newest frame."""
        s = int(self.delta.argmax())
        for k in range(len(self.back) - 1, frame, -1):
            s = self.back[k][s]
        return s


def self_aligned(net, ck, f, words, lex, log_prior, prior_w, chunk=3, lag=3):
    """Single network, causal: its own phone head (with phone input delayed by ck['phone_delay']) is aligned to the text
    while streaming; decided labels feed its phone input. Returns raw 100 Hz labels (PocketSphinx time base)."""
    import torch
    lm = lt.lm
    R = lm.receptive_field(ck['dilations'])
    D, LA = ck['phone_delay'], ck['lookahead']
    ph, opt = states_for(words, lex)
    vit = StreamViterbi(ph, opt)
    n_out = len(f) - (R - 1)
    lab_raw = np.zeros(n_out + 64, np.int64)  # audio-frame labels, SIL until decided
    decided_upto = -1  # output frames decided
    x_all = (torch.tensor(f[None]) - torch.tensor(ck['mean'])) / torch.tensor(ck['std'])
    for start in range(0, n_out, chunk):
        end = min(n_out, start + chunk)  # output frames [start, end)
        # phone input for input rows of this window: row r (output index t = r) uses label of audio frame t - D,
        # and make_example also reads labels LAB_SHIFT frames later; build it exactly as make_example does.
        rows = np.arange(start - (R - 1), end)  # output-frame index of each input row (negative = silence prefix)
        k_audio = rows + 1 + lt.LAB_SHIFT - D  # frame_time(k) rounds to label index k + 1
        lab_in = np.where((rows >= 0) & (k_audio >= 0), lab_raw[np.clip(k_audio, 0, len(lab_raw) - 1)], 0)
        x = x_all[:, start:end + R - 1]
        with torch.no_grad():
            _, h = net(x, torch.tensor(lab_in[None]), hidden=True)
            logp = torch.log_softmax(net.aux(h)[0].T, -1).numpy()
        for row in logp - prior_w * log_prior:
            vit.push(row)
        newest = end - 1
        while decided_upto < newest - lag:
            decided_upto += 1
            j = decided_upto
            k = j - LA + 1 + lt.LAB_SHIFT  # audio frame (PocketSphinx base) the head's label at output j describes
            if 0 <= k < len(lab_raw):
                lab_raw[k] = ph[vit.decide(j)]
    for j in range(decided_upto + 1, n_out):  # utterance end: flush
        k = j - LA + 1 + lt.LAB_SHIFT
        if 0 <= k < len(lab_raw):
            lab_raw[k] = ph[vit.decide(j)]
    return lab_raw


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--stage1', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--mode', choices=['full', 'stream', 'self'], default='full')
    p.add_argument('--chunk', type=int, default=3)
    p.add_argument('--shard', default='0/1', help='i/n: process every n-th line starting at i')
    p.add_argument('--lag', type=int, default=6)
    p.add_argument('--prior', type=float, default=0.5, help='posterior / prior^w scaling')
    p.add_argument('--sets', default='test-clean')
    p.add_argument('--clone', type=Path, help='clone list json: align the cloned audio instead')
    args = p.parse_args()
    import torch
    torch.set_num_threads(2)
    ck = torch.load(args.stage1, map_location='cpu', weights_only=False)
    net = lt.Net(ck['channels'], ck['dilations'], len(lt.lm.OUTPUTS), ck['n_phones'], aux=True,
                 phone_input=bool(ck.get('phone_input')))
    net.load_state_dict(ck['state']); net.eval()
    receptive = lt.lm.receptive_field(ck['dilations'])
    la_frames = ck['lookahead']
    lex = lexicon()
    pack = lt.Pack(LAB / 'pack')
    split = json.loads((LAB / 'pack/split2.json').read_text())
    if args.clone:
        items = [dict(key=i['key'], audio=np.load(i['audio']).astype(np.float32)) for i in json.loads(args.clone.read_text())]
    else:
        keys = [k for k in dict.fromkeys(split['test']) if k in pack.by_key]
        for w, v in split['charTest'].items():
            keys += v
        items = [dict(key=k, audio=None) for k in dict.fromkeys(keys)]
    # phone prior from training labels
    labels = np.load(LAB / 'pack/phones100.npy', mmap_mode='r')
    prior = np.bincount(np.asarray(labels[::7], np.int64), minlength=len(la.PHONES)).astype(float) + 1
    log_prior = np.log(prior / prior.sum())
    args.out.mkdir(parents=True, exist_ok=True)
    agree, n = [], 0
    si, sn = (int(x) for x in args.shard.split('/'))
    items = items[si::sn]
    for it in items:
        key = it['key']
        text = pack.by_key[key]['text'] if key in pack.by_key else ''
        words = la.words_of(text)
        if not words or any(w not in lex for w in words):
            continue
        if args.mode == 'self' and (args.out / f'{key}.npy').exists():
            n += 1
            continue
        audio = it['audio'] if it['audio'] is not None else pack.line(key)['audio']
        line = dict(audio=audio, y30=np.zeros((int(len(audio) / 16000 * 30) + 2, len(lt.lm.OUTPUTS)), np.float32))
        f, _, _, _ = lt.make_example(line, None, random.Random(0), None, receptive, la_frames, train=False)
        if args.mode == 'self':
            raw_full = self_aligned(net, ck, f, words, lex, log_prior, args.prior, args.chunk, args.lag)
            n_raw = int(np.ceil(len(audio) / 160)) + 1
            raw = raw_full[:n_raw].astype(np.int8)
            np.save(args.out / f'{key}.npy', raw)
            if key in pack.lab_index and it['audio'] is None:
                ref = pack.line(key)['lab']
                m = min(len(ref), len(raw))
                agree.append(float((ref[:m] == raw[:m]).mean()))
            n += 1
            continue
        x = (torch.tensor(f[None]) - torch.tensor(ck['mean'])) / torch.tensor(ck['std'])
        with torch.no_grad():
            _, h = net(x, None, hidden=True)
            logp = torch.log_softmax(net.aux(h)[0].T, -1).numpy()  # (T_out, P), output frame j
        score = logp - args.prior * log_prior
        ph, opt = states_for(words, lex)
        path = viterbi(score, ph, opt, lag=args.lag if args.mode == 'stream' else None)
        out_lab = ph[path]  # label per output frame j = phone at audio frame (j - lookahead) + LAB_SHIFT
        n_raw = int(np.ceil(len(audio) / 160)) + 1
        k = np.arange(n_raw)
        j = np.clip(k - 1 - lt.LAB_SHIFT + la_frames, 0, len(out_lab) - 1)
        raw = out_lab[j].astype(np.int8)
        np.save(args.out / f'{key}.npy', raw)
        if key in pack.lab_index and it['audio'] is None:
            ref = pack.line(key)['lab']
            m = min(len(ref), len(raw))
            agree.append(float((ref[:m] == raw[:m]).mean()))
        n += 1
    print(f'{n} lines aligned ({args.mode}); frame agreement with PocketSphinx labels: '
          f'{np.mean(agree) if agree else float("nan"):.3f}')


if __name__ == '__main__':
    main()
