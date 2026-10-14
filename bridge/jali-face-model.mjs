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
export function layer({data, shape: [out, inp, k]}, bias) {
  const weights = new Float32Array(out * inp * k);
  for (let o = 0; o < out; o++) for (let i = 0; i < inp; i++) for (let j = 0; j < k; j++)
    weights[(j * out + o) * inp + i] = data[(o * inp + i) * k + j];
  return {weights, bias: bias.data, out, inp, k};
}

// Valid convolution: rows of `input` (row-major, layer.inp wide) -> T rows. This is the hot loop of the model
// (stage 1 is about 0.66 M multiply-accumulates per 10 ms row). Layers whose width is a multiple of 8 run in a small
// WebAssembly SIMD kernel (below); every other layer, and any engine without it, uses the scalar loop. The scalar
// loop is also faster than it was: two output channels x four rows share each load (6 loads per 8 multiply-adds, was
// 5 per 4) and the sums are accumulated in the same order, so its results are bit-identical to the old loop.
export function conv(input, rows, layer, dilation, output, relu) {
  if (layer.out % 8 === 0 && simdConv) {
    const T = simdConv(input, rows, layer, dilation, output, relu);
    if (T >= 0) return T;
  }
  return scalarConv(input, rows, layer, dilation, output, relu);
}

export function scalarConv(input, rows, {weights, bias, out, inp, k}, dilation, output, relu) {
  const T = Math.max(0, rows - (k - 1) * dilation), whole = T - (T & 3), pairs = out - (out & 1);
  let o = 0;
  for (; o < pairs; o += 2) {
    const ba = bias[o], bb = bias[o + 1];
    let t = 0;
    for (; t < whole; t += 4) {
      let a0 = ba, a1 = ba, a2 = ba, a3 = ba, b0 = bb, b1 = bb, b2 = bb, b3 = bb;
      for (let j = 0; j < k; j++) {
        const w = (j * out + o) * inp, w2 = w + inp, x0 = (t + j * dilation) * inp, x1 = x0 + inp, x2 = x1 + inp, x3 = x2 + inp;
        for (let i = 0; i < inp; i++) {
          const va = weights[w + i], vb = weights[w2 + i], y0 = input[x0 + i], y1 = input[x1 + i], y2 = input[x2 + i], y3 = input[x3 + i];
          a0 += y0 * va; a1 += y1 * va; a2 += y2 * va; a3 += y3 * va; b0 += y0 * vb; b1 += y1 * vb; b2 += y2 * vb; b3 += y3 * vb;
        }
      }
      let at = t * out + o;
      output[at] = relu && a0 < 0 ? 0 : a0; output[at + 1] = relu && b0 < 0 ? 0 : b0; at += out;
      output[at] = relu && a1 < 0 ? 0 : a1; output[at + 1] = relu && b1 < 0 ? 0 : b1; at += out;
      output[at] = relu && a2 < 0 ? 0 : a2; output[at + 1] = relu && b2 < 0 ? 0 : b2; at += out;
      output[at] = relu && a3 < 0 ? 0 : a3; output[at + 1] = relu && b3 < 0 ? 0 : b3;
    }
    for (; t < T; t++) {
      let a = ba, c = bb;
      for (let j = 0; j < k; j++) {
        const w = (j * out + o) * inp, w2 = w + inp, x = (t + j * dilation) * inp;
        for (let i = 0; i < inp; i++) { const y = input[x + i]; a += y * weights[w + i]; c += y * weights[w2 + i]; }
      }
      output[t * out + o] = relu && a < 0 ? 0 : a; output[t * out + o + 1] = relu && c < 0 ? 0 : c;
    }
  }
  for (; o < out; o++) { // odd last channel
    for (let t = 0; t < T; t++) {
      let sum = bias[o];
      for (let j = 0; j < k; j++) {
        const w = (j * out + o) * inp, x = (t + j * dilation) * inp;
        for (let i = 0; i < inp; i++) sum += input[x + i] * weights[w + i];
      }
      output[t * out + o] = relu && sum < 0 ? 0 : sum;
    }
  }
  return T;
}

// WebAssembly SIMD convolution. The module is assembled here from named opcodes (no binary blob, no build step, no
// dependency). One call, `tile`, computes 4 output rows x 8 output channels: the 8 accumulators are two f32x4 vectors
// per row, started from the bias, then for each tap j and input channel i one weight pair (8 contiguous channels) is
// multiplied by the broadcast input value of each of the four rows, and the result is clamped at `floor` (0 for ReLU,
// -Infinity for none). Weights are copied once per layer into wasm memory transposed to [k][inp][out]; the input is
// copied in and the output out per call. Single precision sums differ from the scalar loop by float32 rounding only
// (about 1e-5 on the final face frames). Measured on the 160-channel model: about 5.5 GMAC/s against 0.6 for the old
// scalar loop. CYBERPUNK_CONVAI_FACE_WASM=off keeps the scalar loop.
const wasmUleb = n => { const bytes = []; do { let b = n & 127; n >>>= 7; if (n) b |= 128; bytes.push(b); } while (n); return bytes; };
const wasmSection = (id, body) => [id, ...wasmUleb(body.length), ...body];
const wasmText = text => [...wasmUleb(text.length), ...Array.from(text, c => c.charCodeAt(0))];
function wasmTileModule() {
  const I32 = 0x7f, F32 = 0x7d, V128 = 0x7b;
  const op = {block: 2, loop: 3, end: 0x0b, br: 0x0c, brIf: 0x0d, get: 0x20, set: 0x21, tee: 0x22,
    i32: 0x41, f32load: 0x2a, lt: 0x49, ge: 0x4f, add: 0x6a, mul: 0x6c, shl: 0x74, empty: 0x40};
  const simd = {load: 0x00, store: 0x0b, splat: 0x13, add: 0xe4, mul: 0xe6, max: 0xe9}; // 0xfd-prefixed
  const lane = code => [0xfd, ...wasmUleb(code)];
  const get = n => [op.get, ...wasmUleb(n)], set = n => [op.set, ...wasmUleb(n)];
  const vload = offset => [...lane(simd.load), 0, ...wasmUleb(offset)], vstore = offset => [...lane(simd.store), 0, ...wasmUleb(offset)];
  // Parameters (byte addresses and counts), then locals: five i32 and eleven v128 (two weights, one broadcast, eight sums).
  const X = 0, W = 1, B = 2, OUT = 3, K = 4, INP = 5, TAP = 6, OUTB = 7, FLOOR = 8; // params
  const J = 9, I = 10, XQ = 11, WQ = 12, ROWB = 13, WA = 14, XV = 16, ACC = 17;      // locals
  const code = [];
  const emit = (...parts) => code.push(...parts.flat());
  emit(get(B), vload(0), set(ACC), get(B), vload(16), set(ACC + 1));
  for (let r = 1; r < 4; r++) emit(get(ACC), set(ACC + 2 * r), get(ACC + 1), set(ACC + 2 * r + 1));
  emit(get(INP), [op.i32, 2, op.shl], set(ROWB), get(W), set(WQ));
  emit([op.block, op.empty, op.loop, op.empty], get(J), get(K), [op.ge, op.brIf, 1]);                // for j < k
  emit(get(X), get(J), get(TAP), [op.mul, op.add], set(XQ), [op.i32, 0], set(I));
  emit([op.loop, op.empty], get(WQ), vload(0), set(WA), get(WQ), vload(16), set(WA + 1));            //   for i < inp
  for (let r = 0; r < 4; r++) {
    emit(get(XQ), r ? [...get(ROWB), op.i32, r, op.mul, op.add] : [], [op.f32load, 2, 0], lane(simd.splat), set(XV));
    for (let v = 0; v < 2; v++) emit(get(ACC + 2 * r + v), get(WA + v), get(XV), lane(simd.mul), lane(simd.add), set(ACC + 2 * r + v));
  }
  emit(get(XQ), [op.i32, 4, op.add], set(XQ), get(WQ), get(OUTB), [op.add], set(WQ));
  emit(get(I), [op.i32, 1, op.add, op.tee], wasmUleb(I), get(INP), [op.lt, op.brIf, 0, op.end]);
  emit(get(J), [op.i32, 1, op.add], set(J), [op.br, 0, op.end, op.end]);
  emit(get(FLOOR), lane(simd.splat), set(XV));
  for (let r = 0; r < 4; r++) for (let v = 0; v < 2; v++)
    emit(get(OUT), r ? [...get(OUTB), op.i32, r, op.mul, op.add] : [], get(ACC + 2 * r + v), get(XV), lane(simd.max), vstore(16 * v));
  emit([op.end]);
  const body = [...wasmUleb(2), ...wasmUleb(5), I32, ...wasmUleb(11), V128, ...code];
  const params = [I32, I32, I32, I32, I32, I32, I32, I32, F32];
  return new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0,
    ...wasmSection(1, [1, 0x60, ...wasmUleb(params.length), ...params, 0]),   // type: (i32 x8, f32) -> ()
    ...wasmSection(2, [1, ...wasmText('e'), ...wasmText('m'), 2, 0, 1]),      // import memory e.m (min 1 page)
    ...wasmSection(3, [1, 0]), ...wasmSection(7, [1, ...wasmText('tile'), 0, 0]),
    ...wasmSection(10, [1, ...wasmUleb(body.length), ...body])]);
}

const WASM_LIMIT = 192 * 1024 * 1024; // cap on linear memory; beyond it a call falls back to the scalar loop
const simdConv = (() => {
  if (process.env.CYBERPUNK_CONVAI_FACE_WASM === 'off') return null;
  let memory, tile;
  try {
    const bytes = wasmTileModule();
    if (!WebAssembly.validate(bytes)) return null;
    memory = new WebAssembly.Memory({initial: 64});
    ({tile} = new WebAssembly.Instance(new WebAssembly.Module(bytes), {e: {m: memory}}).exports);
  } catch { return null; }
  let top = 0;
  const placed = new WeakMap();
  const reserve = end => {
    if (end > WASM_LIMIT) return false;
    const pages = Math.ceil(end / 65536) - memory.buffer.byteLength / 65536;
    if (pages > 0) memory.grow(pages);
    return true;
  };
  // Layer weights [k][out][inp] -> [k][inp][out] in wasm memory, once per layer object.
  const place = layer => {
    let at = placed.get(layer);
    if (at) return at;
    const {weights, bias, out, inp, k} = layer, w = top, b = w + k * inp * out * 4, end = b + out * 4;
    if (!reserve(end)) return null;
    const dst = new Float32Array(memory.buffer, w, k * inp * out);
    for (let j = 0; j < k; j++) for (let o = 0; o < out; o++) for (let i = 0; i < inp; i++) dst[(j * inp + i) * out + o] = weights[(j * out + o) * inp + i];
    new Float32Array(memory.buffer, b, out).set(bias);
    top = end; placed.set(layer, at = {w, b});
    return at;
  };
  // Returns T, or -1 when this call must use the scalar loop.
  return (input, rows, layer, dilation, output, relu) => {
    const {out, inp, k} = layer, T = Math.max(0, rows - (k - 1) * dilation);
    if (T === 0) return 0;
    try {
      const at = place(layer);
      if (!at) return -1;
      // Rows are computed four at a time; the last block reads (and writes) up to three scratch rows past T.
      const padded = (T + 3) & ~3, rowBytes = inp * 4, outBytes = out * 4;
      const x = (top + 15) & ~15, y = (x + (padded + (k - 1) * dilation) * rowBytes + 15) & ~15;
      if (!reserve(y + padded * outBytes)) return -1;
      new Float32Array(memory.buffer, x, rows * inp).set(input.subarray(0, rows * inp));
      const floor = relu ? 0 : -Infinity;
      for (let t = 0; t < padded; t += 4) for (let o = 0; o < out; o += 8)
        tile(x + t * rowBytes, at.w + o * 4, at.b + o * 4, y + (t * out + o) * 4, k, inp, dilation * rowBytes, outBytes, floor);
      output.set(new Float32Array(memory.buffer, y, T * out));
      return T;
    } catch { return -1; }
  };
})();

// Join a layer's retained input tail with new rows; keep the new tail.
export function extend(state, rows, count, width, keep) {
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
    // Optional voice-synchronous upper face: [[outputIndex, 'brows_raise'|'brows_lower'], ...]
    this.upper = Array.isArray(meta.upper) ? meta.upper.filter(([index, name]) => Number.isInteger(index)
      && ['brows_raise', 'brows_lower'].includes(name)) : [];
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
    if (this.input.inp !== this.mels || [...this.controls, ...this.upper].some(([index]) => !(index >= 0 && index < this.outputs)))
      throw Error('Facial model shape mismatch');
    this.receptive = 3 + meta.dilations.reduce((sum, d) => sum + 2 * d, 0);
    this.silence = Float32Array.from(this.mean, (mean, i) => (meta.silence - mean) / this.std[i]);
    const n = this.nfft, bits = Math.log2(n);
    this.cos = new Float64Array(n / 2); this.sin = new Float64Array(n / 2); this.rev = new Uint32Array(n);
    for (let i = 0; i < n / 2; i++) { this.cos[i] = Math.cos(2 * Math.PI * i / n); this.sin[i] = -Math.sin(2 * Math.PI * i / n); }
    for (let i = 0; i < n; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); this.rev[i] = r; }
    this.re = new Float64Array(n); this.im = new Float64Array(n); this.power = new Float64Array(this.bins);
    // Each mel filter is a narrow triangle: sum only its non-zero bins (identical result, the skipped terms are +0).
    this.melFrom = new Uint16Array(this.mels); this.melTo = new Uint16Array(this.mels);
    for (let m = 0; m < this.mels; m++) {
      let from = 0, to = this.bins;
      while (from < to && this.fb[m * this.bins + from] === 0) from++;
      while (to > from && this.fb[m * this.bins + to - 1] === 0) to--;
      this.melFrom[m] = from; this.melTo[m] = to;
    }
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
      let sum = 0; const row = m * bins, to = this.melTo[m];
      for (let k = this.melFrom[m]; k < to; k++) sum += fb[row + k] * power[k];
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
    // Last hidden layer of the newest rows: the text path (jali-face-text.mjs) reads it.
    state.hidden = h; state.hiddenRows = Math.max(0, length);
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
  constructor({lookahead, outputs, controls, upper = []}) {
    Object.assign(this, {lookahead, outputs, controls: controls.map(([index]) => index)});
    const raise = upper.find(([, name]) => name === 'brows_raise'), lower = upper.find(([, name]) => name === 'brows_lower');
    this.upper = raise && lower ? [raise[0], lower[0]] : null;
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
  sample(seconds, indices = this.controls) {
    const frame = (seconds * 16000 - 200) / 160 + this.lookahead;
    const left = Math.max(this.lookahead, Math.min(this.ready - 1, Math.floor(frame)));
    const right = Math.min(this.ready - 1, left + 1), mix = Math.max(0, Math.min(1, frame - left));
    return indices.map(index => {
      const a = this.values[left * this.outputs + index] || 0, b = this.values[right * this.outputs + index] || 0;
      return a + (b - a) * mix;
    });
  }
  // [brow raise, brow lower] in native units, or null when the model has none.
  sampleUpper(seconds) {
    return this.upper ? this.sample(seconds, this.upper).map(value => Math.max(0, Math.min(1, value))) : null;
  }
}

// Streaming analysis for one utterance. push() accepts PCM at its own rate and
// returns the newly predicted rows; finish() resolves the lookahead tail.
export class FaceModelStream extends FaceModelFrames {
  // text: optional TextSession (jali-face-text.mjs). Its rows replace the mouth outputs; it never delays a row in
  // stream mode. Any text-path failure leaves this stream on the audio-only rows.
  constructor(model, sampleRate, {text} = {}) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw Error('Invalid facial model audio rate');
    super(model);
    Object.assign(this, {model, sampleRate});
    this.resampler = new Resampler(sampleRate, 16000);
    this.audio = new Float32Array(16000 * 4); this.samples = 0;
    this.featureRows = 0;
    this.state = model.createState(); this.closing = false;
    this.text = text || null; this.textFailed = undefined; this.pending = [];
  }
  // Real-time guard: a stream whose packets wait too long in the worker queue, or whose text path costs too much,
  // continues on the audio model alone (the mouth eases back over blendRows rows).
  // Phrase mode (Omni) is not real time: the whole phrase WAV is already rendered and is pushed in 1 s slices at once, so
  // slice N always waits for slices 1..N-1 in the worker queue (about .2 s of work each) and the lag guard fired on every
  // phrase over about 1.5 s ("lost: behind" on all three phrases of a reply, October 9). Its rows are released at finish
  // and speech starts only after the analysis, so neither check protects anything there: it is skipped.
  guard(sentAt) {
    if (!this.text || this.text.mode === 'phrase') return;
    const lag = Number.isFinite(sentAt) ? performance.timeOrigin + performance.now() - sentAt : 0, audio = this.samples / 16000;
    if (lag > 250) this.text.lose('behind');
    else if (audio >= 2 && this.text.computeMs > audio * 1000 * .4) this.text.lose('budget');
  }
  setText(text, complete) { try { this.text?.setText(text, complete); } catch { this.dropText('text'); } }
  dropText(reason) { this.textFailed = reason; this.text = null; }
  growAudio(needed) {
    if (this.audio.length >= needed) return;
    const next = new Float32Array(Math.max(needed, this.audio.length * 2)); next.set(this.audio); this.audio = next;
  }
  push(pcm, {sentAt} = {}) {
    if (this.finished || this.closing) throw Error('Facial model stream already finished');
    this.guard(sentAt);
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
    let rows = new Float32Array(0), count = 0;
    if (available > this.featureRows) {
      const fresh = new Float32Array((available - this.featureRows) * model.mels);
      for (let row = this.featureRows; row < available; row++)
        model.melFrame(this.audio, row * 160, fresh, (row - this.featureRows) * model.mels);
      count = available - this.featureRows;
      rows = model.step(this.state, fresh, count);
      this.featureRows = available;
    }
    if (this.text) {
      // Phrase mode releases rows at finish; keep the audio-only rows so a failure can still deliver them.
      if (this.text.mode === 'phrase' && count) this.pending.push(rows);
      try {
        if (count && this.state.hiddenRows !== count) throw Error('Facial model hidden rows');
        const audioRows = rows;
        rows = this.text.process(count ? this.state.hidden : new Float32Array(0), audioRows, count, Boolean(final));
        if (final) this.pending = [];
      } catch {
        // Rows the shapes pass was holding back (a few rows at most) go out first so the timeline keeps its clock.
        const held = this.text?.releaseHeld?.();
        this.dropText('error');
        if (held?.length && !this.pending.length) { const joined = new Float32Array(held.length + rows.length); joined.set(held); joined.set(rows, held.length); rows = joined; }
        if (this.pending.length) {
          rows = new Float32Array(this.pending.reduce((n, part) => n + part.length, 0));
          let at = 0; for (const part of this.pending) { rows.set(part, at); at += part.length; }
          this.pending = [];
        }
      }
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
      const start = first - this.base;
      if (first >= 0 && start >= 0 && start + this.taps <= joined.length) { // interior: every tap is in range
        for (let j = 0; j < this.taps; j++) sum += joined[start + j] * this.table[row + j];
      } else for (let j = 0; j < this.taps; j++) {
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
