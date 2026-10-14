// Text-conditioned mouth for the game-trained facial model (scripts/lipsync/lab_textpipe.py is the reference).
//
// The audio model (stage 1, jali-face-model.mjs) also drives a small phone head. The reply text, turned into
// phones with a pronunciation table, is aligned to those posteriors by a left-to-right Viterbi; a small second
// network (stage 2) sees stage 1's hidden layer plus the aligned phone of each 10 ms row and predicts the mouth.
//   stream mode (Pocket, Convai): row j is decided after row j + lag; stage 2 row i uses the phone of row i - lag,
//     so every output row is ready as soon as stage 1's row is (no added latency) and streamed output is identical
//     to whole-utterance output.
//   phrase mode (Omni): every row is decided from the whole phrase's best path; rows are released at finish.
// The mouth blends from stage 2 back to stage 1 (at most 1/blendRows per row) wherever the text gives no phone:
// no text, voice tags ([laughter]), words missing from the table, text that arrives late, alignment confidence
// that drops (latched for the rest of the utterance) or a worker that falls behind real time.
// Weights are game-derived (runtime/lipsync-model, ignored); the table is CMUdict (BSD-2-Clause) plus game words.
import {gunzipSync} from 'node:zlib';
import {layer, conv, extend} from './jali-face-model.mjs';
import {VisemeOverlay, VISEME_CONFIG} from './face-visemes.mjs';

export const FACE_TEXT_FORMAT = 'cp77-jali-text-v1';
export const PHONES = Object.freeze(['SIL', 'AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'B', 'CH', 'D', 'DH', 'EH', 'ER', 'EY', 'F',
  'G', 'HH', 'IH', 'IY', 'JH', 'K', 'L', 'M', 'N', 'NG', 'OW', 'OY', 'P', 'R', 'S', 'SH', 'T', 'TH', 'UH', 'UW', 'V', 'W',
  'Y', 'Z', 'ZH']);
export const GARBAGE = null;
const PHONE_KIND = 0, SILENCE = 1, GARBAGE_KIND = 2, TAIL = 3;

// ------------------------------------------------------------------ text (mirrors lab_textpipe.normalize_text)
const ONES = 'zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen'.split(' ');
const TENS = 'zero ten twenty thirty forty fifty sixty seventy eighty ninety'.split(' ');
function sayInt(n) {
  if (n < 20) return [ONES[n]];
  if (n < 100) return [TENS[Math.floor(n / 10)], ...(n % 10 ? [ONES[n % 10]] : [])];
  if (n < 1000) return [ONES[Math.floor(n / 100)], 'hundred', ...(n % 100 ? sayInt(n % 100) : [])];
  for (const [size, name] of [[1e9, 'billion'], [1e6, 'million'], [1000, 'thousand']])
    if (n >= size) return [...sayInt(Math.floor(n / size)), name, ...(n % size ? sayInt(n % size) : [])];
  return [];
}
function sayNumber(text, year = true) {
  const [whole, frac = ''] = text.split('.', 2), n = whole ? Number(whole) : 0;
  let words;
  if (year && !frac && whole.length === 4 && n >= 1100 && n <= 2999 && n % 100 !== 0 && n % 1000 >= 10) {
    const hi = Math.floor(n / 100), lo = n % 100;
    words = [...sayInt(hi), ...(lo < 10 ? ['oh', ...sayInt(lo)] : sayInt(lo))];
  } else if (whole.length > 12) words = [...whole].map(c => ONES[Number(c)]);
  else words = sayInt(n);
  if (frac) words.push('point', ...[...frac.slice(0, 6)].map(c => ONES[Number(c)]));
  return words;
}
const MARK = '\u0001';
// Same tag syntax as natural-speech.mjs: [voice-tag] is a sound OmniVoice renders, {emotion} is for the face only.
const EMOTION_TAG = /\{[a-z]+(?::[a-z]+)?\}/gi, VOICE_TAG = /\[[a-z]+(?:-[a-z]+)*\]/gi, MARKUP = /<[^>]*>/g;
const MONEY = /\$\s*(\d[\d,]*(?:\.\d+)?)/g, NUMBER = /\d[\d,]*(?:\.\d+)?/g, WORD = /[a-zà-ɏ][a-zà-ɏ']*/g;

// Spoken tokens: lowercase words, or GARBAGE (null) for a voice tag or a token with letters outside the table's
// alphabet. Consecutive garbage merges. `complete: false` drops a trailing word that may still be growing.
export function normalizeText(text, {complete = true} = {}) {
  let t = String(text ?? '');
  if (!complete && !/[\s.,;:!?…"')\]}-]$/.test(t)) t = t.replace(/\S+$/, '');
  t = t.replace(EMOTION_TAG, ' ').replace(VOICE_TAG, ` ${MARK} `).replace(/\[[^\]]*\]/g, ` ${MARK} `).replace(MARKUP, ' ').replace(/[‘’]/g, "'");
  t = t.replace(MONEY, (_, n) => ` ${n} dollars `).replace(/(\d)\s*%/g, '$1 percent');
  t = t.replace(NUMBER, m => ` ${sayNumber(m.replace(/,/g, ''), !m.includes(',')).join(' ')} `).replace(/[-–—/_]/g, ' ').toLowerCase();
  const out = [];
  for (const token of t.split(/\s+/)) {
    if (!token) continue;
    if (token === MARK) { out.push(GARBAGE); continue; }
    const words = (token.match(WORD) || []).map(w => w.replace(/^'+|'+$/g, '')).filter(Boolean);
    if (!words.length && /\p{L}/u.test(token)) out.push(GARBAGE);
    out.push(...words);
  }
  return out.filter((tok, i) => !(tok === GARBAGE && out[i - 1] === GARBAGE));
}

export function parseLexicon(gz) {
  const lexicon = new Map();
  for (const line of gunzipSync(gz).toString('utf8').split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2 || lexicon.has(parts[0])) continue;
    const ids = parts.slice(1).map(p => PHONES.indexOf(p));
    if (ids.every(id => id >= 0)) lexicon.set(parts[0], Uint8Array.from(ids));
  }
  return lexicon;
}

// HMM states for tokens. `incremental` (growing Convai text) never rewrites earlier states, so a longer text
// only appends; the whole-text layout (Pocket, Omni, the Python reference) lets a garbage state replace the
// silence after the previous word.
export function buildStates(tokens, lexicon, {incremental = false} = {}) {
  const seq = [];
  for (const tok of tokens) {
    const t = tok !== GARBAGE && lexicon.has(tok) ? tok : GARBAGE;
    if (t === GARBAGE && seq.at(-1) === GARBAGE) continue;
    seq.push(t);
  }
  const phones = [0], kinds = [SILENCE];
  for (const t of seq) {
    if (t === GARBAGE) {
      if (!incremental && kinds.at(-1) === SILENCE && kinds.length > 1) { phones.pop(); kinds.pop(); }
      phones.push(0); kinds.push(GARBAGE_KIND); continue;
    }
    for (const p of lexicon.get(t)) { phones.push(p); kinds.push(PHONE_KIND); }
    phones.push(0); kinds.push(SILENCE);
  }
  return {phones, kinds, words: seq.length};
}

// ------------------------------------------------------------------ alignment (mirrors lab_textpipe.Aligner)
export class TextAligner {
  constructor({phones, kinds}, config, {lag = null, keep = Infinity} = {}) {
    Object.assign(this, {config, lag, keep});
    this.phones = [...phones]; this.kinds = [...kinds];
    this.stay = Math.log(config.stay); this.move = Math.log(1 - config.stay);
    this.delta = null; this.back = []; this.backBase = 0; this.rows = []; this.rowBase = 0;
    this.labels = []; this.codes = []; this.margins = []; this.gaps = []; this.gapSum = 0; this.lost = false; this.reason = undefined;
  }
  get size() { return this.phones.length; }
  // Append states (growing text). Existing hypotheses keep their scores; the tail (if any) stays last.
  append(phones, kinds) {
    if (!phones.length) return;
    const tail = this.kinds.at(-1) === TAIL ? this.size - 1 : this.size;
    this.phones.splice(tail, 0, ...phones); this.kinds.splice(tail, 0, ...kinds);
    if (this.delta) {
      const n = phones.length, grown = new Float64Array(this.size).fill(-Infinity);
      grown.set(this.delta.subarray(0, tail)); grown.set(this.delta.subarray(tail), tail + n); this.delta = grown;
      this.back = this.back.map(prev => {
        const next = new Int32Array(this.size);
        for (let s = 0; s < this.size; s++) {
          const old = s < tail ? s : s >= tail + n ? s - n : -1;
          next[s] = old < 0 ? s : (prev[old] >= tail ? prev[old] + n : prev[old]);
        }
        return next;
      });
    }
  }
  addTail() { if (this.kinds.at(-1) !== TAIL) this.append([0], [TAIL]); }
  emit(row) {
    let top = -Infinity;
    for (let p = 0; p < row.length; p++) if (row[p] > top) top = row[p];
    const e = new Float64Array(this.size), {garbagePenalty, tailPenalty} = this.config;
    for (let s = 0; s < this.size; s++) {
      const kind = this.kinds[s];
      e[s] = kind === GARBAGE_KIND ? top - garbagePenalty : kind === TAIL ? top - tailPenalty : row[this.phones[s]];
    }
    return e;
  }
  optional(s) { const kind = this.kinds[s]; return kind === SILENCE || kind === GARBAGE_KIND; }
  push(row) {
    const e = this.emit(row), S = this.size, prev = new Int32Array(S);
    if (this.delta === null) {
      this.delta = new Float64Array(S).fill(-Infinity);
      for (let s = 0; s < S; s++) { this.delta[s] = e[s]; prev[s] = s; if (!this.optional(s)) break; }
      for (let s = 0; s < S; s++) prev[s] = s;
    } else {
      const d = this.delta, next = new Float64Array(S);
      for (let s = 0; s < S; s++) {
        let best = d[s] + this.stay, from = s;
        if (s >= 1) { const c = d[s - 1] + this.move; if (c > best) { best = c; from = s - 1; } }
        if (s >= 2 && this.optional(s - 1)) { const c = d[s - 2] + this.move; if (c > best) { best = c; from = s - 2; } }
        if (s >= 3 && this.optional(s - 2) && this.optional(s - 1)) { const c = d[s - 3] + this.move; if (c > best) { best = c; from = s - 3; } }
        next[s] = best + e[s]; prev[s] = from;
      }
      this.delta = next;
    }
    this.back.push(prev); this.rows.push(row);
    const t = this.backBase + this.back.length - 1;
    if (this.lag !== null && t >= this.lag) {
      let s = 0;
      for (let k = 1; k < S; k++) if (this.delta[k] > this.delta[s]) s = k;
      for (let k = t; k > t - this.lag; k--) s = this.back[k - this.backBase][s];
      this.decide(t - this.lag, s);
    }
    // Streaming keeps only what the fixed-lag traceback can still reach.
    while (this.back.length > this.keep) { this.back.shift(); this.backBase++; }
  }
  decide(j, s) {
    const row = this.rows[j - this.rowBase], kind = this.kinds[s];
    const label = kind === PHONE_KIND || kind === SILENCE ? this.phones[s] : 0;
    let covered = (kind === PHONE_KIND || kind === SILENCE) && !this.lost;
    // How far the audio's own best phone is above the aligned one, in nats (0 = they agree); 99 when no phone was aligned.
    let margin = 99;
    if (covered) {
      let top = -Infinity;
      for (let p = 0; p < row.length; p++) if (row[p] > top) top = row[p];
      const gap = top - row[label], {confidenceWindow, confidenceMinRows, confidenceThreshold} = this.config;
      margin = gap;
      this.gaps.push(gap); this.gapSum += gap;
      if (this.gaps.length > confidenceWindow) this.gapSum -= this.gaps[this.gaps.length - 1 - confidenceWindow];
      const count = Math.min(this.gaps.length, confidenceWindow);
      if (this.gaps.length >= confidenceMinRows && this.gapSum / count > confidenceThreshold) { this.lose('confidence'); covered = false; }
    }
    // 1 covered, 0 not covered (garbage / tail), 2 not covered because the alignment was given up.
    this.labels.push(label); this.codes.push(covered ? 1 : this.lost ? 2 : 0); this.margins.push(margin);
    if (this.keep !== Infinity) while (this.rows.length > this.keep + 2) { this.rows.shift(); this.rowBase++; }
  }
  lose(reason) { if (!this.lost) { this.lost = true; this.reason = reason; } }
  decision(j) { return j < this.labels.length ? [this.labels[j], this.codes[j]] : null; }
  finish() {
    if (this.delta === null) return;
    const S = this.size;
    let s = -1;
    for (let k = S - 1; k >= 0; k--) {
      if (s < 0 || this.delta[k] >= this.delta[s]) s = k;
      if (this.kinds[k] === PHONE_KIND) break;
    }
    const T = this.backBase + this.back.length, path = new Int32Array(T);
    path[T - 1] = s;
    for (let k = T - 1; k > this.backBase; k--) { s = this.back[k - this.backBase][s]; path[k - 1] = s; }
    for (let j = this.labels.length; j < T; j++) this.decide(j, path[j]);
  }
}

// ------------------------------------------------------------------ model
function tensorsOf(meta, buffer) {
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength), tensors = {};
  for (const {name, offset, shape} of meta.tensors) {
    const count = shape.reduce((a, b) => a * b, 1);
    if (typeof name !== 'string' || !Number.isInteger(offset) || offset < 0 || offset % 4 || offset + count * 4 > bytes.byteLength)
      throw Error('Invalid facial text tensor');
    tensors[name] = {data: new Float32Array(bytes, offset, count), shape};
    if (!tensors[name].data.every(Number.isFinite)) throw Error('Non-finite facial text weight');
  }
  return tensors;
}

class Stage2Net {
  constructor(t, prefix, {channels, dilations}, inputWidth, outputs) {
    const get = name => { if (!t[prefix + name]) throw Error(`Facial text model lacks ${prefix + name}`); return t[prefix + name]; };
    this.input = layer(get('inp.w'), get('inp.b'));
    this.blocks = dilations.map((dilation, b) => ({dilation, c1: layer(get(`b${b}.c1.w`), get(`b${b}.c1.b`)), c2: layer(get(`b${b}.c2.w`), get(`b${b}.c2.b`))}));
    this.output = layer(get('out.w'), get('out.b'));
    if (this.input.inp !== inputWidth || this.input.out !== channels || this.output.out !== outputs) throw Error('Facial text model shape mismatch');
    this.qin = get('qmap_in').data; this.qout = get('qmap_out').data; this.qpoints = get('qmap_in').shape[1];
    this.channels = channels; this.receptive = 3 + dilations.reduce((sum, d) => sum + 2 * d, 0);
  }
  createState() { return {input: {data: new Float32Array(0), rows: 0}, blocks: this.blocks.map(() => ({data: new Float32Array(0), rows: 0}))}; }
  // Same incremental scheme as FaceModel.step; returns raw (pre-scale) output rows.
  step(state, rows, count) {
    const C = this.channels, W = this.input.inp;
    let {joined, total} = extend(state.input, rows, count, W, 2);
    let h = new Float32Array(Math.max(0, total - 2) * C), length = conv(joined, total, this.input, 1, h, true);
    for (let b = 0; b < this.blocks.length && length > 0; b++) {
      const {dilation, c1, c2} = this.blocks[b], shift = 2 * dilation;
      ({joined, total} = extend(state.blocks[b], h, length, C, shift));
      const T = Math.max(0, total - shift), inner = new Float32Array(T * C), next = new Float32Array(T * C);
      conv(joined, total, c1, dilation, inner, true); conv(inner, T, c2, 1, next, false);
      for (let t = 0; t < T; t++) {
        const res = (t + shift) * C, row = t * C;
        for (let o = 0; o < C; o++) { const v = joined[res + o] + next[row + o]; next[row + o] = v > 0 ? v : 0; }
      }
      h = next; length = T;
    }
    const out = new Float32Array(Math.max(0, length) * this.output.out);
    conv(h, length, this.output, 1, out, true);
    return {out, length};
  }
  remap(output, value) {
    const n = this.qpoints, base = output * n, qin = this.qin, qout = this.qout;
    if (value <= qin[base]) return qout[base];
    if (value >= qin[base + n - 1]) return qout[base + n - 1];
    let low = 0, high = n - 1;
    while (high - low > 1) { const mid = (low + high) >> 1; if (qin[base + mid] <= value) low = mid; else high = mid; }
    const a = qin[base + low], b = qin[base + high];
    return qout[base + low] + (qout[base + high] - qout[base + low]) * (value - a) / (b - a);
  }
}

export function parseFaceText(meta, buffer, lexiconGz, model) {
  if (!meta || meta.format !== FACE_TEXT_FORMAT || meta.version !== 1 || !Array.isArray(meta.tensors)
      || String(meta.phones) !== String(PHONES) || !meta.nets?.stream || !meta.nets?.phrase || meta.lookahead !== model.lookahead)
    throw Error('Unsupported facial text model');
  return new FaceText(meta, tensorsOf(meta, buffer), parseLexicon(lexiconGz), model);
}

export class FaceText {
  constructor(meta, t, lexicon, model) {
    Object.assign(this, {meta, lexicon, model});
    this.config = meta;
    const C1 = model.channels, P = PHONES.length;
    this.head = layer(t['head.w'], t['head.b']);
    if (this.head.inp !== C1 || this.head.out !== P) throw Error('Facial text head shape mismatch');
    this.logPrior = t.log_prior.data;
    this.nets = {stream: new Stage2Net(t, meta.nets.stream.prefix, meta.nets.stream, C1 + P, model.outputs),
      phrase: new Stage2Net(t, meta.nets.phrase.prefix, meta.nets.phrase, C1 + P, model.outputs)};
    // Stage 1's hidden row for an all-silence receptive field: the stage-2 left context before the first row.
    const state = model.createState();
    model.step(state, Float32Array.from(model.silence), 1);
    this.silentHidden = Float32Array.from(state.hidden.subarray(0, C1));
  }
  session(options) { return new TextSession(this, options); }
}

export class TextSession {
  constructor(faceText, {mode = 'stream', text = '', complete = true, visemes = false, now = () => performance.now()} = {}) {
    if (!['stream', 'phrase'].includes(mode)) throw Error('Unknown facial text mode');
    Object.assign(this, {faceText, mode, now});
    const {model, config} = faceText;
    this.net = faceText.nets[mode]; this.spec = config.nets[mode];
    this.C1 = model.channels; this.P = PHONES.length; this.outputs = model.outputs; this.M = config.mouthOutputs;
    this.scores = []; this.hidden = []; this.stage1 = []; this.rows = 0; this.emitted = 0;
    this.weight = 0; this.step = 1 / config.blendRows; this.tokens = []; this.computeMs = 0; this.stopped = false;
    this.aligner = null; this.state2 = null; this.warmUntil = 0; this.lostReason = undefined;
    // Text-derived shapes added to the mouth rows (bridge/face-visemes.mjs); off unless asked for.
    this.overlay = visemes ? new VisemeOverlay({phones: PHONES, outputs: this.outputs, config: typeof visemes === 'object' ? {...VISEME_CONFIG, ...visemes} : VISEME_CONFIG}) : null;
    this.setText(text, complete);
  }
  get active() { return this.aligner !== null; }
  get lost() { return Boolean(this.lostReason || this.aligner?.lost); }
  get reason() { return this.lostReason || this.aligner?.reason; }
  lose(reason) { if (!this.lostReason) this.lostReason = reason; this.aligner?.lose(reason); }
  // Reply text so far. Whole-text routes call this once; Convai calls it as the text grows. A text that no longer
  // extends what was aligned (revised mid-stream) ends text conditioning for this utterance.
  setText(text, complete = true) {
    if (this.lost || this.closedText) return;
    const tokens = normalizeText(text, {complete});
    if (tokens.length < this.tokens.length || this.tokens.some((tok, i) => tokens[i] !== tok)) { this.lose('text-revised'); return; }
    const lexicon = this.faceText.lexicon, incremental = !complete || this.incremental;
    if (!this.aligner) {
      const states = buildStates(tokens, lexicon, {incremental});
      if (!states.kinds.includes(PHONE_KIND)) { if (complete) this.closedText = true; return; }
      this.tokens = tokens; this.incremental = incremental;
      if (states.phones.length > this.faceText.config.maxStates) { this.lose('text-too-long'); return; }
      const lag = this.spec.decide === 'lag' ? this.spec.lag : null;
      this.aligner = new TextAligner(states, this.faceText.config, {lag, keep: lag === null ? Infinity : lag + 1});
      if (!complete) this.aligner.addTail();
      // Text after audio started (Convai): catch the alignment up, and give stage 2 a fresh left context.
      for (const row of this.scores) this.aligner.push(row);
      if (this.rows) this.warmUntil = this.rows + this.net.receptive - 1;
    } else if (tokens.length > this.tokens.length) {
      const before = buildStates(this.tokens, lexicon, {incremental: true}), after = buildStates(tokens, lexicon, {incremental: true});
      if (after.phones.length > this.faceText.config.maxStates) { this.lose('text-too-long'); return; }
      this.aligner.append(after.phones.slice(before.phones.length), after.kinds.slice(before.kinds.length));
      this.tokens = tokens;
    }
    if (complete) this.closedText = true;
  }
  // Stage-1 hidden rows and outputs for `count` new rows -> output rows to emit (stream: same count; phrase: at final).
  process(hiddenRows, outputRows, count, final = false) {
    const started = this.now(), {C1, P, outputs} = this, head = this.faceText.head;
    const logits = new Float32Array(count * P);
    conv(hiddenRows, count, head, 1, logits, false);
    for (let r = 0; r < count; r++) {
      let top = -Infinity;
      for (let p = 0; p < P; p++) top = Math.max(top, logits[r * P + p]);
      let sum = 0;
      for (let p = 0; p < P; p++) sum += Math.exp(logits[r * P + p] - top);
      const lse = Math.log(sum), score = new Float32Array(P);
      for (let p = 0; p < P; p++) score[p] = Math.fround(Math.fround(logits[r * P + p] - top) - lse) - this.faceText.config.priorWeight * this.faceText.logPrior[p];
      if (!this.aligner && this.scores.length < 12000) this.scores.push(score); // Convai text that arrives late
      if (this.mode === 'phrase') { this.hidden.push(hiddenRows.slice(r * C1, (r + 1) * C1)); this.stage1.push(outputRows.slice(r * outputs, (r + 1) * outputs)); }
      this.aligner?.push(score);
    }
    let out;
    if (this.mode === 'stream') out = this.blendRows(hiddenRows, outputRows, count, this.rows);
    else if (final) {
      this.aligner?.finish();
      const total = this.hidden.length, hidden = new Float32Array(total * C1), stage1 = new Float32Array(total * outputs);
      this.hidden.forEach((row, r) => hidden.set(row, r * C1)); this.stage1.forEach((row, r) => stage1.set(row, r * outputs));
      out = this.blendRows(hidden, stage1, total, 0);
    } else out = new Float32Array(0);
    this.rows += count;
    if (this.overlay) {
      const before = this.overlay.total, incoming = out;
      try { out = this.overlay.run(incoming, this.aligner, {final}); }
      catch {
        // Held rows go out unchanged; this call's own rows too, unless the pass had already taken them in.
        const held = this.overlay.release(), taken = this.overlay.total !== before;
        out = taken ? held : Float32Array.from([...held, ...incoming]);
        this.overlay = null; this.overlayFailed = true;
      }
    }
    this.computeMs += this.now() - started;
    return out;
  }
  // Rows the shapes pass still holds back, unchanged, when the text path ends early (the caller then goes on with stage 1 alone).
  releaseHeld() { const rows = this.overlay?.release(); this.overlay = null; return rows ?? new Float32Array(0); }
  // Stage 2 over rows [first, first + count) and the blend with stage 1.
  blendRows(hiddenRows, outputRows, count, first) {
    const {C1, P, outputs, M, net} = this, shift = this.spec.shift, scale = this.faceText.model.scale;
    const out = Float32Array.from(outputRows.subarray(0, count * outputs));
    // No text yet, or the alignment was given up and the mouth is fully back on stage 1: skip stage 2.
    if ((!this.aligner && this.weight === 0) || this.stopped) return out;
    if (!this.state2) {
      this.state2 = net.createState();
      const prefix = new Float32Array((net.receptive - 1) * (C1 + P));
      for (let r = 0; r < net.receptive - 1; r++) { prefix.set(this.faceText.silentHidden, r * (C1 + P)); prefix[r * (C1 + P) + C1] = 1; }
      net.step(this.state2, prefix, net.receptive - 1);
    }
    const input = new Float32Array(count * (C1 + P)), covered = new Uint8Array(count), given = new Uint8Array(count);
    for (let r = 0; r < count; r++) {
      const i = first + r, j = i - shift, decision = j >= 0 ? this.aligner?.decision(j) : undefined;
      // Before the first decided row (stream) or after the last (phrase): silence, covered unless already given up.
      const [label, cov] = decision ?? (this.aligner && (j < 0 || this.mode === 'phrase') ? [0, this.aligner.lost ? 2 : 1] : [0, 0]);
      input.set(hiddenRows.subarray(r * C1, (r + 1) * C1), r * (C1 + P)); input[r * (C1 + P) + C1 + label] = 1;
      covered[r] = cov === 1 && this.aligner && i >= this.warmUntil ? 1 : 0; given[r] = cov === 2 ? 1 : 0;
    }
    const {out: raw, length} = net.step(this.state2, input, count);
    if (length !== count) throw Error('Facial text stage-2 row mismatch');
    for (let r = 0; r < count; r++) {
      const target = covered[r];
      this.weight = target > this.weight ? Math.min(target, this.weight + this.step) : Math.max(target, this.weight - this.step);
      const w = this.weight;
      if (w === 0) { if (given[r]) this.stopped = true; continue; }
      for (let o = 0; o < M; o++) {
        const y2 = net.remap(o, raw[r * outputs + o] * scale[o]);
        out[r * outputs + o] = w * y2 + (1 - w) * outputRows[r * outputs + o];
      }
    }
    return out;
  }
  info() {
    return {active: this.active, mode: this.mode, lost: this.lost, reason: this.reason, rows: this.rows,
      computeMs: Math.round(this.computeMs * 10) / 10,
      ...(this.overlay ? {visemes: this.overlay.stats()} : this.overlayFailed ? {visemes: 'failed'} : {})};
  }
}
