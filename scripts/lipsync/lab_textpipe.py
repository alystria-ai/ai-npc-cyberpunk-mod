"""Reference implementation of the runtime text path, mirrored line by line by bridge/jali-face-text.mjs.

Pipeline per utterance (all in 10 ms output rows of the installed audio model, "stage 1"):
  1. stage 1 (face-model.*) -> hidden layer h1 and its outputs y1 (unchanged Candidate A behaviour);
  2. phone head (face-text: head.w/b) on h1 -> log posteriors; score = logp - priorWeight * logPrior;
  3. the reply text -> states (normalize_text + lexicon): optional silence between words, one state per phone,
     an optional "garbage" state for [voice tags] and words missing from the lexicon;
  4. Viterbi over the rows: stream mode decides row j after row j + lag (fixed lag), the last rows at finish from
     the final path; phrase mode (Omni) decides every row from the final path;
  5. stage 2 (a small conv stack) on [h1, one-hot(phone decided for row i - shift)];
  6. mouth outputs (first 15) = w * stage 2 + (1 - w) * stage 1, w following the row's "covered" flag at most
     1/blendRows per row; garbage rows, low alignment confidence (latched) or no text give w -> 0.
Stream mode is causal (row i needs only rows <= i), so streamed and whole-utterance output are identical.

  python lab_textpipe.py fixture <model-dir> <out.json>    # parity fixture for bridge tests
  python lab_textpipe.py calibrate <model-dir>              # confidence threshold from right vs wrong text
"""
from __future__ import annotations

import gzip
import json
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import lipsync_model as lm  # noqa: E402

PHONES = ['SIL', 'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'B', 'CH', 'D', 'DH', 'EH', 'ER', 'EY', 'F', 'G', 'HH', 'IH', 'IY',
          'JH', 'K', 'L', 'M', 'N', 'NG', 'OW', 'OY', 'P', 'R', 'S', 'SH', 'T', 'TH', 'UH', 'UW', 'V', 'W', 'Y', 'Z', 'ZH']
GARBAGE = None  # token marker
ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split()
TENS = 'zero ten twenty thirty forty fifty sixty seventy eighty ninety'.split()


# ------------------------------------------------------------------ text
def say_int(n: int) -> list[str]:
    if n < 20:
        return [ONES[n]]
    if n < 100:
        return [TENS[n // 10]] + ([ONES[n % 10]] if n % 10 else [])
    if n < 1000:
        return [ONES[n // 100], 'hundred'] + (say_int(n % 100) if n % 100 else [])
    for size, name in ((10 ** 9, 'billion'), (10 ** 6, 'million'), (1000, 'thousand')):
        if n >= size:
            return say_int(n // size) + [name] + (say_int(n % size) if n % size else [])
    return []


def say_number(text: str, year: bool = True) -> list[str]:
    whole, _, frac = text.partition('.')
    n = int(whole) if whole else 0
    if year and not frac and len(whole) == 4 and 1100 <= n <= 2999 and n % 100 != 0 and n % 1000 >= 10:
        hi, lo = divmod(n, 100)  # years: 2077 -> twenty seventy seven, 1905 -> nineteen oh five
        words = say_int(hi) + (['oh'] + say_int(lo) if lo < 10 else say_int(lo))
    elif len(whole) > 12:
        words = [ONES[int(c)] for c in whole]
    else:
        words = say_int(n)
    if frac:
        words += ['point'] + [ONES[int(c)] for c in frac[:6]]
    return words


EMOTION_TAG = re.compile(r'\{[a-z]+(?::[a-z]+)?\}', re.I)
VOICE_TAG = re.compile(r'\[[a-z]+(?:-[a-z]+)*\]', re.I)
MARKUP = re.compile(r'<[^>]*>')
MONEY = re.compile(r'\$\s*(\d[\d,]*(?:\.\d+)?)')
NUMBER = re.compile(r'\d[\d,]*(?:\.\d+)?')
WORD = re.compile(r"[a-z\u00e0-\u024f][a-z\u00e0-\u024f']*")
MARK = '\u0001'


def normalize_text(text: str) -> list:
    """Spoken tokens: lowercase words, or GARBAGE (None) for a voice tag / unpronounceable token. Consecutive garbage merges."""
    t = EMOTION_TAG.sub(' ', str(text))
    t = VOICE_TAG.sub(f' {MARK} ', t)
    t = re.sub(r'\[[^\]]*\]', f' {MARK} ', t)  # other bracketed markup (e.g. phoneme syntax): not alignable
    t = MARKUP.sub(' ', t)
    t = t.replace('\u2019', "'").replace('\u2018', "'")
    t = MONEY.sub(lambda m: f' {m.group(1)} dollars ', t)
    t = re.sub(r'(\d)\s*%', r'\1 percent', t)
    t = NUMBER.sub(lambda m: ' ' + ' '.join(say_number(m.group(0).replace(',', ''), ',' not in m.group(0))) + ' ', t)
    t = re.sub(r'[-\u2013\u2014/_]', ' ', t).lower()
    out = []
    for token in t.split():
        if token == MARK:
            out.append(GARBAGE)
            continue
        words = [w.strip("'") for w in WORD.findall(token)]
        words = [w for w in words if w]
        if not words and re.search(r'[^\W\d_]', token):  # letters outside the supported alphabet
            out.append(GARBAGE)
        out.extend(words)
    merged = []
    for tok in out:
        if tok is GARBAGE and merged and merged[-1] is GARBAGE:
            continue
        merged.append(tok)
    return merged


def load_lexicon(path: Path) -> dict:
    lex = {}
    with gzip.open(path, 'rt', encoding='utf8') as f:
        for line in f:
            parts = line.split()
            if len(parts) >= 2 and parts[0] not in lex:
                lex[parts[0]] = [PHONES.index(p) for p in parts[1:]]
    return lex


# State kinds: 0 phone, 1 silence (optional), 2 garbage (optional), 3 tail garbage
def build_states(tokens, lex):
    """(phone ids, kinds) for the HMM. Words missing from the lexicon become garbage."""
    seq = [t if (t is GARBAGE or t in lex) else GARBAGE for t in tokens]
    merged = []
    for t in seq:
        if t is GARBAGE and merged and merged[-1] is GARBAGE:
            continue
        merged.append(t)
    phones, kinds = [0], [1]
    for i, t in enumerate(merged):
        if t is GARBAGE:
            if kinds[-1] == 1 and len(kinds) > 1:  # the garbage state replaces the silence after a word
                phones.pop(); kinds.pop()
            phones.append(0); kinds.append(2)
            continue
        for p in lex[t]:
            phones.append(p); kinds.append(0)
        phones.append(0); kinds.append(1)
    return np.array(phones, np.int64), np.array(kinds, np.int64)


# ------------------------------------------------------------------ alignment
class Aligner:
    """Left-to-right Viterbi. Transitions: stay, next, or skip one/two optional states. Emissions from score rows."""

    def __init__(self, phones, kinds, cfg, lag=None):
        self.ph, self.kind = phones, kinds
        self.cfg, self.lag = cfg, lag
        self.stay, self.move = np.log(cfg['stay']), np.log(1 - cfg['stay'])
        self.delta = None
        self.back = []          # per pushed row: previous state per state (int32)
        self.decided = []       # per row: (label, covered)
        self.gaps = []
        self.rows = []
        self.lost = False
        self.worst = float('-inf')  # largest windowed mean gap seen (calibration)

    def emit(self, row):
        top = row.max()
        e = row[self.ph].astype(np.float64)
        e[self.kind == 2] = top - self.cfg['garbagePenalty']
        e[self.kind == 3] = top - self.cfg['tailPenalty']
        return e

    def start_mask(self):
        S = len(self.ph)
        m = np.zeros(S, bool)
        for s in range(S):
            m[s] = True
            if self.kind[s] not in (1, 2):
                break
        return m

    def push(self, row):
        e = self.emit(row)
        S = len(self.ph)
        if self.delta is None:
            self.delta = np.where(self.start_mask(), e, -np.inf)
            self.back.append(np.arange(S, dtype=np.int32))
        else:
            d = self.delta
            best = d + self.stay
            prev = np.arange(S, dtype=np.int32)
            opt = (self.kind == 1) | (self.kind == 2)
            cand = np.full(S, -np.inf); cand[1:] = d[:-1] + self.move
            take = cand > best
            best = np.where(take, cand, best); prev = np.where(take, np.arange(S) - 1, prev)
            cand = np.full(S, -np.inf); cand[2:] = np.where(opt[1:-1], d[:-2] + self.move, -np.inf)
            take = cand > best
            best = np.where(take, cand, best); prev = np.where(take, np.arange(S) - 2, prev)
            cand = np.full(S, -np.inf); cand[3:] = np.where(opt[1:-2] & opt[2:-1], d[:-3] + self.move, -np.inf)
            take = cand > best
            best = np.where(take, cand, best); prev = np.where(take, np.arange(S) - 3, prev)
            self.delta = best + e
            self.back.append(prev.astype(np.int32))
        self.rows.append(row)
        t = len(self.back) - 1
        if self.lag is not None and t >= self.lag:
            s = int(np.argmax(self.delta))
            for k in range(t, t - self.lag, -1):
                s = int(self.back[k][s])
            self._decide(t - self.lag, s)

    def _decide(self, j, s):
        row = self.rows[j]
        kind = int(self.kind[s])
        label = int(self.ph[s]) if kind in (0, 1) else 0
        covered = kind in (0, 1) and not self.lost
        if kind in (0, 1) and not self.lost:
            self.gaps.append(float(row.max() - row[label]))
            c = self.cfg
            window = self.gaps[-c['confidenceWindow']:]
            if len(self.gaps) >= c['confidenceMinRows']:
                mean = float(np.mean(window))
                self.worst = max(self.worst, mean)
                if mean > c['confidenceThreshold']:
                    self.lost = True
                    covered = False
        self.decided.append((label, covered))

    def finish(self):
        """Decide the remaining rows from the best path that ends in an allowed final state."""
        if self.delta is None:
            return
        S = len(self.ph)
        end_ok = np.zeros(S, bool)
        for s in range(S - 1, -1, -1):
            end_ok[s] = True
            if self.kind[s] not in (1, 2, 3):
                break
        d = np.where(end_ok, self.delta, -np.inf)
        s = int(np.argmax(d))
        T = len(self.back)
        path = [0] * T
        path[T - 1] = s
        for k in range(T - 1, 0, -1):
            s = int(self.back[k][s]); path[k - 1] = s
        for j in range(len(self.decided), T):
            self._decide(j, path[j])


# ------------------------------------------------------------------ networks
def conv(x, w, b, dilation):
    k = w.shape[2]
    T = x.shape[0] - (k - 1) * dilation
    out = np.empty((max(0, T), w.shape[0]), np.float32)
    out[:] = b
    for j in range(k):
        out += x[j * dilation: j * dilation + T] @ w[:, :, j].T
    return out


def stack(x, p, prefix, dilations):
    h = np.maximum(conv(x, p[prefix + 'inp.w'], p[prefix + 'inp.b'], 1), 0)
    for i, d in enumerate(dilations):
        inner = np.maximum(conv(h, p[f'{prefix}b{i}.c1.w'], p[f'{prefix}b{i}.c1.b'], d), 0)
        h = np.maximum(h[2 * d:] + inner @ p[f'{prefix}b{i}.c2.w'][:, :, 0].T + p[f'{prefix}b{i}.c2.b'], 0)
    return h


def qmap(y, qin, qout):
    return np.stack([np.interp(y[:, k], qin[k], qout[k]) for k in range(y.shape[1])], 1)


def load_blob(directory: Path, name: str):
    meta = json.loads((directory / f'{name}.json').read_text(encoding='utf8'))
    raw = (directory / f'{name}.bin').read_bytes()
    tensors = {t['name']: np.frombuffer(raw, '<f4', count=int(np.prod(t['shape'])), offset=t['offset']).reshape(t['shape'])
               for t in meta['tensors']}
    return meta, tensors


class TextPipeline:
    def __init__(self, directory: Path):
        self.dir = Path(directory)
        self.m1, self.p1 = load_blob(self.dir, 'face-model')
        self.mt, self.pt = load_blob(self.dir, 'face-text')
        self.lex = load_lexicon(self.dir / self.mt['lexicon'])
        self.r1 = lm.receptive_field(self.m1['dilations'])
        self.la = self.m1['lookahead']

    def stage1(self, audio16k):
        p = self.p1
        feats = lm.log_mel(np.concatenate([audio16k.astype(np.float32), np.zeros(self.la * 160 + 400, np.float32)]))
        x = np.concatenate([np.full((self.r1, lm.N_MELS), lm.SILENCE, np.float32), feats])  # one extra silence row -> h_sil
        x = (x - p['feat_mean']) / p['feat_std']
        h = stack(x, p, '', self.m1['dilations'])
        y = np.clip(h @ p['out.w'][:, :, 0].T + p['out.b'], 0, None) * p['out_scale']
        y = qmap(y, p['qmap_in'], p['qmap_out'])
        return h[1:], y[1:], h[0]

    def run(self, audio16k, text, mode='stream'):
        """Returns (rows (N, outputs) exactly like the bridge's FaceModelStream, info)."""
        h1, y1, h_sil = self.stage1(audio16k)
        N = len(h1)
        cfg = self.mt
        net = cfg['nets'][mode]
        tokens = normalize_text(text) if text else []
        phones, kinds = build_states(tokens, self.lex)
        active = any(k == 0 for k in kinds)
        info = dict(rows=N, active=active, tokens=len(tokens))
        if not active:
            return y1, info
        pt = self.pt
        logits = h1 @ pt['head.w'][:, :, 0].T + pt['head.b']
        logits = logits - logits.max(1, keepdims=True)
        logp = logits - np.log(np.exp(logits).sum(1, keepdims=True))
        score = (logp - cfg['priorWeight'] * pt['log_prior']).astype(np.float32)
        al = Aligner(phones, kinds, cfg, lag=net['lag'] if net['decide'] == 'lag' else None)
        for j in range(N):
            al.push(score[j])
        al.finish()
        shift = net['shift']
        P = len(PHONES)
        r2 = lm.receptive_field(net['dilations'])
        rows = np.zeros((r2 - 1 + N, h1.shape[1] + P), np.float32)
        rows[:r2 - 1, :h1.shape[1]] = h_sil
        rows[:r2 - 1, h1.shape[1]] = 1
        covered = np.ones(N, bool)
        for i in range(N):
            j = i - shift
            # Before the first / after the last decided row: silence, covered unless the alignment was given up
            # (bridge/jali-face-text.mjs blendRows does the same; (0, True) here re-blended stage 2 into the last
            # `-shift` rows of a phrase whose alignment had been lost, a 2.9e-3 JS/Python mismatch).
            label, cov = al.decided[j] if 0 <= j < N else (0, j < 0 or not al.lost)
            rows[r2 - 1 + i, :h1.shape[1]] = h1[i]
            rows[r2 - 1 + i, h1.shape[1] + label] = 1
            covered[i] = cov
        pre = net['prefix']
        h2 = stack(rows, pt, pre, net['dilations'])
        y2 = np.clip(h2 @ pt[pre + 'out.w'][:, :, 0].T + pt[pre + 'out.b'], 0, None) * self.p1['out_scale']
        y2 = qmap(y2, pt[pre + 'qmap_in'], pt[pre + 'qmap_out'])
        out = y1.copy()
        w, step, M = 0.0, 1.0 / cfg['blendRows'], cfg['mouthOutputs']
        ws = np.zeros(N, np.float32)
        for i in range(N):
            target = 1.0 if covered[i] else 0.0
            w = min(target, w + step) if target > w else max(target, w - step)
            ws[i] = w
            out[i, :M] = w * y2[i, :M] + (1 - w) * y1[i, :M]
        info.update(lost=al.lost, coveredFraction=float(covered.mean()), meanWeight=float(ws.mean()),
                    meanGap=float(np.mean(al.gaps)) if al.gaps else float('nan'), worstWindow=al.worst)
        return out.astype(np.float32), info

    def timeline(self, audio16k, text, mode='stream', rate=60):
        rows, info = self.run(audio16k, text, mode)
        y = rows[self.la:]
        times = lm.frame_time(np.arange(len(y)))
        duration = len(audio16k) / lm.SAMPLE_RATE
        t = np.append(np.arange(0, duration, 1 / rate), duration)
        tracks, cols = [], []
        for k, (_, controls) in enumerate(lm.OUTPUTS[:lm.RUNTIME_OUTPUTS]):
            values = np.interp(t, times, y[:, k])
            for c in controls:
                tracks.append(c)
                cols.append(np.clip(values, 0, lm.LIMITS.get(c, .5)))
        edge = np.clip(np.minimum(t / .04, (duration - t) / .04), 0, 1)
        return tracks, np.column_stack([t] + [c * edge for c in cols]), info


# ------------------------------------------------------------------ CLI
def _corpus_lines(n, offset=0):
    root = HERE.parents[1]
    lab = Path('E:/CyberpunkConvai-offload/work/lipsync-lab/pack')
    index = {}
    for r in json.loads((lab / 'index.json').read_text()):
        index.setdefault(r['key'], r)
    split = json.loads((root / 'runtime/lipsync-corpus2/split.json').read_text())
    keys = [k for k in split['test'] if k in index and index[k]['text'] and '<' not in index[k]['text']][offset:offset + n]
    return [(k, index[k]['text'], np.load(root / 'runtime/lipsync-corpus2/lines' / f'{k}.npz')['audio16k'].astype(np.float32))
            for k in keys]


def main():
    cmd, directory = sys.argv[1], Path(sys.argv[2])
    pipe = TextPipeline(directory)
    if cmd == 'fixture':
        cases = []
        texts = ['Hey, choom - got 2,077 eddies? [laughter] {joy} Yeah.', "It's 5.5% of $300.", 'Señor, no way!', '',
                 'Preem work, Vince... I mean V.', 'Zxqwv blorp hello']
        norm = [dict(text=t, tokens=[x if x is not None else None for x in normalize_text(t)],
                     states=[list(map(int, a)) for a in build_states(normalize_text(t), pipe.lex)]) for t in texts]
        for key, text, audio in _corpus_lines(3):
            for mode in ('stream', 'phrase'):
                rows, info = pipe.run(audio, text, mode)
                cases.append(dict(key=key, text=text, mode=mode, audio=audio.tolist(), rows=rows.reshape(-1).tolist(),
                                  outputs=rows.shape[1], info=info))
        rows, info = pipe.run(cases[0]['audio'] and np.array(cases[0]['audio'], np.float32), '', 'stream')
        cases.append(dict(key='no-text', text='', mode='stream', audio=cases[0]['audio'], rows=rows.reshape(-1).tolist(),
                          outputs=rows.shape[1], info=info))
        Path(sys.argv[3]).write_text(json.dumps(dict(normalize=norm, cases=cases)), encoding='utf8')
        print(f'{len(cases)} cases, {len(norm)} normalization vectors')
    elif cmd == 'calibrate':
        lines = _corpus_lines(160, 200)
        rng = np.random.default_rng(0)
        right, wrong = [], []
        cfg = pipe.mt
        for i, (key, text, audio) in enumerate(lines):
            other = lines[(i + 1 + rng.integers(len(lines) - 1)) % len(lines)][1]
            for t, sink in ((text, right), (other, wrong)):
                saved = cfg['confidenceThreshold']
                cfg['confidenceThreshold'] = 1e9  # measure, don't latch
                _, info = pipe.run(audio, t, 'stream')
                cfg['confidenceThreshold'] = saved
                sink.append(info['worstWindow'] if np.isfinite(info['worstWindow']) else info['meanGap'])
        right, wrong = np.array(right), np.array(wrong)
        for q in (90, 95, 98, 99):
            thr = np.nanpercentile(right, q)
            print(f'threshold p{q} of right-text gaps = {thr:.2f}: wrong text caught {np.mean(wrong > thr):.2f}')
        print('right gap median', np.nanmedian(right), 'wrong gap median', np.nanmedian(wrong))


if __name__ == '__main__':
    main()
