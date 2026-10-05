// Audio -> native mouth controls learned from Cyberpunk's own JALI dialogue
// lipsync (scripts/lipsync/). Pure JavaScript, no native dependencies. It never
// changes playback samples: callers pass a copy of the PCM and receive native
// LipsyncPoseOutput weights (the units the ConvaiFace feature adds to).
//
// The network uses unpadded ("valid") dilated convolutions over log-mel
// features that are left-padded with digital silence, so any window of a long
// stream is recomputed exactly from its receptive-field context. Output frame
// t describes audio frame t - lookahead (10 ms frames).
//
// Weights are derived from game data: they stay in the ignored runtime/ folder
// and are rebuilt locally (docs/GAME_LIPSYNC_MODEL.md).

export const FACE_MODEL_FORMAT = 'cp77-jali-audio2face-v1';

export function parseFaceModel(meta, buffer) {
  if (!meta || meta.format !== FACE_MODEL_FORMAT || meta.version !== 1 || meta.sampleRate !== 16000
      || meta.hop !== 160 || meta.window !== 400 || meta.nfft !== 512 || !Number.isInteger(meta.mels)
      || !Number.isInteger(meta.lookahead) || meta.lookahead < 0 || meta.lookahead > 50
      || !Array.isArray(meta.tensors) || !Array.isArray(meta.dilations) || !Array.isArray(meta.controls)
      || !meta.controls.length || meta.controls.length > 32)
    throw Error('Unsupported facial model');
  const bytes = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
  const tensors = {};
  for (const {name, offset, shape} of meta.tensors) {
    const count = shape.reduce((a, b) => a * b, 1);
    if (typeof name !== 'string' || !Number.isInteger(offset) || offset < 0 || offset % 4 || offset + count * 4 > bytes.byteLength)
      throw Error('Invalid facial model tensor');
    tensors[name] = {data: new Float32Array(bytes, offset, count), shape};
    if (!tensors[name].data.every(Number.isFinite)) throw Error('Non-finite facial model weight');
  }
  return new FaceModel(meta, tensors);
}

// Conv weights (Cout, Cin, k) -> [k][Cout][Cin] for contiguous dot products.
function layer({data, shape: [out, inp, k]}, bias) {
  const weights = new Float32Array(out * inp * k);
  for (let o = 0; o < out; o++) for (let i = 0; i < inp; i++) for (let j = 0; j < k; j++)
    weights[(j * out + o) * inp + i] = data[(o * inp + i) * k + j];
  return {weights, bias: bias.data, out, inp, k};
}

// Valid convolution: rows of `input` (row-major, layer.inp wide) -> T rows.
// Four output rows share each weight load; this is the hot loop of the model.
function conv(input, rows, {weights, bias, out, inp, k}, dilation, output, relu) {
  const T = Math.max(0, rows - (k - 1) * dilation), whole = T - (T & 3);
  for (let o = 0; o < out; o++) {
    const b = bias[o];
    let t = 0;
    for (; t < whole; t += 4) {
      let s0 = b, s1 = b, s2 = b, s3 = b;
      for (let j = 0; j < k; j++) {
        const w = (j * out + o) * inp, x0 = (t + j * dilation) * inp, x1 = x0 + inp, x2 = x1 + inp, x3 = x2 + inp;
        for (let i = 0; i < inp; i++) {
          const v = weights[w + i];
          s0 += input[x0 + i] * v; s1 += input[x1 + i] * v; s2 += input[x2 + i] * v; s3 += input[x3 + i] * v;
        }
      }
      output[t * out + o] = relu && s0 < 0 ? 0 : s0; output[(t + 1) * out + o] = relu && s1 < 0 ? 0 : s1;
      output[(t + 2) * out + o] = relu && s2 < 0 ? 0 : s2; output[(t + 3) * out + o] = relu && s3 < 0 ? 0 : s3;
    }
    for (; t < T; t++) {
      let sum = b;
      for (let j = 0; j < k; j++) {
        const w = (j * out + o) * inp, x = (t + j * dilation) * inp;
        for (let i = 0; i < inp; i++) sum += input[x + i] * weights[w + i];
      }
      output[t * out + o] = relu && sum < 0 ? 0 : sum;
    }
  }
  return T;
}

// Join a layer's retained input tail with new rows; keep the new tail.
function extend(state, rows, count, width, keep) {
  const total = state.rows + count, joined = new Float32Array(total * width);
  joined.set(state.data.subarray(0, state.rows * width)); joined.set(rows.subarray(0, count * width), state.rows * width);
  const kept = Math.min(keep, total);
  state.data = joined.slice((total - kept) * width, total * width); state.rows = kept;
  return {joined, total};
}

export class FaceModel {
  constructor(meta, t) {
    Object.assign(this, {meta, lookahead: meta.lookahead, mels: meta.mels, hop: meta.hop, window: meta.window, nfft: meta.nfft});
    this.controls = meta.controls; // [[outputIndex, nativeControl], ...]
    this.mean = t.feat_mean.data; this.std = t.feat_std.data; this.scale = t.out_scale.data;
    this.fb = t.mel_fb.data; this.win = t.window.data; this.bins = this.nfft / 2 + 1;
    this.input = layer(t['inp.w'], t['inp.b']);
    this.blocks = meta.dilations.map((dilation, b) => ({dilation,
      c1: layer(t[`b${b}.c1.w`], t[`b${b}.c1.b`]), c2: layer(t[`b${b}.c2.w`], t[`b${b}.c2.b`])}));
    this.output = layer(t['out.w'], t['out.b']);
    this.channels = this.input.out; this.outputs = this.output.out;
    // Optional per-output monotone map (predicted -> authored value quantiles).
    if (t.qmap_in || t.qmap_out) {
      const [outputs, points] = t.qmap_in?.shape || [];
      if (outputs !== this.output.out || !(points >= 2) || String(t.qmap_out?.shape) !== String(t.qmap_in.shape))
        throw Error('Invalid facial model quantile map');
      this.qin = t.qmap_in.data; this.qout = t.qmap_out.data; this.qpoints = points;
    }
    if (this.input.inp !== this.mels || this.controls.some(([index]) => !(index >= 0 && index < this.outputs)))
      throw Error('Facial model shape mismatch');
    this.receptive = 3 + meta.dilations.reduce((sum, d) => sum + 2 * d, 0);
    this.silence = Float32Array.from(this.mean, (mean, i) => (meta.silence - mean) / this.std[i]);
    const n = this.nfft, bits = Math.log2(n);
    this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2); this.rev = new Uint32Array(n);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = -Math.sin(2 * Math.PI * i / n); }
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.re = new Float64Array(n); this.im = new Float64Array(n); this.power = new Float64Array(this.bins);
  }

  // Normalised log-mel row for 16 kHz samples [start, start + window).
  melFrame(audio, start, target, offset) {
    const {re, im, rev, nfft: n, win, window, power, bins, fb, mels} = this;
    re.fill(0); im.fill(0);
    for (let i = 0; i < window; i++) re[rev[i]] = audio[start + i] * win[i];
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let s = 0; s < n; s += size) for (let k = 0; k < half; k++) {
        const c = this.cos[k * step], si = this.sin[k * step], a = s + k, b = a + half;
        const tr = re[b] * c - im[b] * si, ti = re[b] * si + im[b] * c;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
      }
    }
    for (let k = 0; k < bins; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    for (let m = 0; m < mels; m++) {
      let sum = 0; const row = m * bins;
      for (let k = 0; k < bins; k++) sum += fb[row + k] * power[k];
      target[offset + m] = (Math.log10(Math.max(sum, 1e-10)) - this.mean[m]) / this.std[m];
    }
  }

  // Incremental network state: each layer keeps only the input rows its
  // dilated kernel still needs. Starts after the silence prefix used in training.
  createState() {
    const state = {input: {data: new Float32Array(0), rows: 0},
      blocks: this.blocks.map(() => ({data: new Float32Array(0), rows: 0}))};
    const silence = new Float32Array((this.receptive - 1) * this.mels);
    for (let r = 0; r < this.receptive - 1; r++) silence.set(this.silence, r * this.mels);
    this.step(state, silence, this.receptive - 1);
    return state;
  }

  // Normalised feature rows (count x mels) -> output rows, one per new input row
  // once the receptive field is primed.
  step(state, rows, count) {
    const C = this.channels;
    let {joined, total} = extend(state.input, rows, count, this.mels, 2);
    let h = new Float32Array(Math.max(0, total - 2) * C);
    let length = conv(joined, total, this.input, 1, h, true);
    for (let b = 0; b < this.blocks.length && length > 0; b++) {
      const {dilation, c1, c2} = this.blocks[b], shift = 2 * dilation;
      ({joined, total} = extend(state.blocks[b], h, length, C, shift));
      const T = Math.max(0, total - shift), inner = new Float32Array(T * C), next = new Float32Array(T * C);
      conv(joined, total, c1, dilation, inner, true);
      conv(inner, T, c2, 1, next, false);
      for (let t = 0; t < T; t++) {
        const res = (t + shift) * C, row = t * C;
        for (let o = 0; o < C; o++) { const v = joined[res + o] + next[row + o]; next[row + o] = v > 0 ? v : 0; }
      }
      h = next; length = T;
    }
    const outputs = new Float32Array(Math.max(0, length) * this.outputs);
    conv(h, length, this.output, 1, outputs, true);
    for (let r = 0; r < length; r++) for (let o = 0; o < this.outputs; o++) {
      const at = r * this.outputs + o;
      outputs[at] = this.qin ? this.remap(o, outputs[at] * this.scale[o]) : outputs[at] * this.scale[o];
    }
    return outputs;
  }

  // np.interp over the output's quantile table (clamped at both ends).
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

// Predicted native weights for one utterance, on its original audio clock.
// Output row r describes audio frame r - lookahead (centre (f*160+200)/16000 s).
// A worker-thread mirror receives rows through append() without the network.
export class FaceModelFrames {
  constructor({lookahead, outputs, controls}) {
    Object.assign(this, {lookahead, outputs, controls: controls.map(([index]) => index)});
    this.values = new Float32Array(400 * outputs); this.ready = 0; this.finished = false; this.duration = 0;
  }
  append(rows, {finished = false, duration = 0} = {}) {
    if (this.finished || rows.length % this.outputs) throw Error('Invalid facial model rows');
    const needed = (this.ready * this.outputs) + rows.length;
    if (this.values.length < needed) {
      const next = new Float32Array(Math.max(needed, this.values.length * 2)); next.set(this.values); this.values = next;
    }
    this.values.set(rows, this.ready * this.outputs); this.ready += rows.length / this.outputs;
    if (finished) { this.finished = true; this.duration = duration; }
  }
  // Seconds of original audio whose pose is known.
  coveredSeconds() {
    if (this.finished) return this.duration;
    const frames = this.ready - this.lookahead;
    return frames <= 0 ? 0 : ((frames - 1) * 160 + 200) / 16000;
  }
  // Native weights (model control order) at audio time `seconds`, linear between 10 ms frames.
  sample(seconds) {
    const frame = (seconds * 16000 - 200) / 160 + this.lookahead;
    const left = Math.max(this.lookahead, Math.min(this.ready - 1, Math.floor(frame)));
    const right = Math.min(this.ready - 1, left + 1), mix = Math.max(0, Math.min(1, frame - left));
    return this.controls.map(index => {
      const a = this.values[left * this.outputs + index] || 0, b = this.values[right * this.outputs + index] || 0;
      return a + (b - a) * mix;
    });
  }
}

// Streaming analysis for one utterance. push() accepts PCM at its own rate and
// returns the newly predicted rows; finish() resolves the lookahead tail.
export class FaceModelStream extends FaceModelFrames {
  constructor(model, sampleRate) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw Error('Invalid facial model audio rate');
    super(model);
    Object.assign(this, {model, sampleRate});
    this.resampler = new Resampler(sampleRate, 16000);
    this.audio = new Float32Array(16000 * 4); this.samples = 0;
    this.featureRows = 0;
    this.state = model.createState(); this.closing = false;
  }
  growAudio(needed) {
    if (this.audio.length >= needed) return;
    const next = new Float32Array(Math.max(needed, this.audio.length * 2)); next.set(this.audio); this.audio = next;
  }
  push(pcm) {
    if (this.finished || this.closing) throw Error('Facial model stream already finished');
    if (!(pcm instanceof Float32Array)) throw Error('Facial model expects Float32 PCM');
    const converted = this.resampler.push(pcm);
    this.growAudio(this.samples + converted.length);
    this.audio.set(converted, this.samples); this.samples += converted.length;
    return this.analyse();
  }
  finish() {
    if (this.finished || this.closing) return new Float32Array(0);
    const tail = this.resampler.flush(), duration = this.resampler.total / this.sampleRate;
    // Digital silence after the end lets the last lookahead frames resolve.
    const padding = this.model.lookahead * 160 + 400;
    this.growAudio(this.samples + tail.length + padding);
    this.audio.set(tail, this.samples); this.audio.fill(0, this.samples + tail.length, this.samples + tail.length + padding);
    this.samples += tail.length + padding; this.closing = true;
    return this.analyse({finished: true, duration});
  }
  analyse(final) {
    const {model} = this, available = this.samples < 400 ? 0 : Math.floor((this.samples - 400) / 160) + 1;
    let rows = new Float32Array(0);
    if (available > this.featureRows) {
      const fresh = new Float32Array((available - this.featureRows) * model.mels);
      for (let row = this.featureRows; row < available; row++)
        model.melFrame(this.audio, row * 160, fresh, (row - this.featureRows) * model.mels);
      rows = model.step(this.state, fresh, available - this.featureRows);
      this.featureRows = available;
    }
    this.append(rows, final);
    return rows;
  }
}

// Windowed-sinc resampler with carried state (any rate -> 16 kHz analysis).
export class Resampler {
  constructor(from, to) {
    Object.assign(this, {from, to, ratio: from / to});
    const down = Math.min(1, to / from);
    this.cutoff = down * .92; this.half = Math.ceil(12 / down);
    this.buffer = new Float32Array(0); this.base = 0; this.next = 0; this.total = 0;
    // Precomputed kernel for 1024 fractional phases: taps j = 0..2*half-1 at
    // input index floor(position) - half + 1 + j.
    this.phases = 1024; this.taps = 2 * this.half;
    this.table = new Float32Array((this.phases + 1) * this.taps);
    for (let p = 0; p <= this.phases; p++) for (let j = 0; j < this.taps; j++)
      this.table[p * this.taps + j] = this.kernel(p / this.phases + this.half - 1 - j);
  }
  kernel(x) {
    if (Math.abs(x) >= this.half) return 0;
    const y = Math.PI * x * this.cutoff, sinc = y === 0 ? 1 : Math.sin(y) / y;
    return this.cutoff * sinc * (.42 + .5 * Math.cos(Math.PI * x / this.half) + .08 * Math.cos(2 * Math.PI * x / this.half));
  }
  render(joined, limit) {
    const out = [];
    for (;;) {
      const position = this.next * this.ratio;
      if (limit !== undefined ? position >= limit : position + this.half >= this.base + joined.length) break;
      const whole = Math.floor(position), row = Math.round((position - whole) * this.phases) * this.taps;
      const first = whole - this.half + 1;
      let sum = 0;
      for (let j = 0; j < this.taps; j++) {
        const i = first + j, at = i - this.base;
        if (i >= 0 && at >= 0 && at < joined.length) sum += joined[at] * this.table[row + j];
      }
      out.push(sum); this.next++;
    }
    return Float32Array.from(out);
  }
  push(pcm) {
    this.total += pcm.length;
    if (this.from === this.to) { this.next += pcm.length; return Float32Array.from(pcm); }
    const joined = new Float32Array(this.buffer.length + pcm.length);
    joined.set(this.buffer); joined.set(pcm, this.buffer.length);
    const out = this.render(joined);
    const keep = Math.max(this.base, Math.floor(this.next * this.ratio - this.half) - 1);
    this.buffer = joined.slice(keep - this.base); this.base = keep;
    return out;
  }
  flush() {
    if (this.from === this.to) return new Float32Array(0);
    return this.render(this.buffer, this.total);
  }
}
