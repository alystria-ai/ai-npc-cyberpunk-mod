// Test-only synthetic facial model with the production tensor layout.
// Real weights are game-derived and never part of the repository or tests.
import {FACE_MODEL_FORMAT} from './jali-face-model.mjs';

const OUTPUT_CONTROLS = [['jaw_mid_open'], ['lips_together_up'], ['lips_together_dn'], ['lips_l_purse', 'lips_r_purse'],
  ['lips_l_funnel', 'lips_r_funnel'], ['lips_l_corner_stretch', 'lips_r_corner_stretch'], ['lips_l_stretch', 'lips_r_stretch'],
  ['lips_l_lower_raise', 'lips_r_lower_raise'], ['lips_l_upper_raise', 'lips_r_upper_raise'], ['lips_suck_up'], ['lips_suck_dn'],
  ['lips_puff_up', 'lips_puff_dn'], ['cheek_l_puff', 'cheek_r_puff'], ['tongue_mid_tip_up'], ['tongue_mid_fwd']];
export function syntheticModel({channels = 6, dilations = [1, 2], lookahead = 3, seed = 7, quantiles, upper = false} = {}) {
  let state = seed;
  const random = () => ((state = (state * 1103515245 + 12345) % 2147483648) / 2147483648) - .5;
  const mels = 80, outputs = 17, tensors = [], parts = [];
  let offset = 0;
  const add = (name, shape, fill) => {
    const count = shape.reduce((a, b) => a * b, 1), data = new Float32Array(count);
    for (let i = 0; i < count; i++) data[i] = fill(i);
    tensors.push({name, offset, shape}); parts.push(Buffer.from(data.buffer)); offset += count * 4;
  };
  add('inp.w', [channels, mels, 3], () => random() * .3); add('inp.b', [channels], () => random() * .2);
  dilations.forEach((_, b) => {
    add(`b${b}.c1.w`, [channels, channels, 3], () => random() * .5); add(`b${b}.c1.b`, [channels], () => random() * .1);
    add(`b${b}.c2.w`, [channels, channels, 1], () => random() * .5); add(`b${b}.c2.b`, [channels], () => random() * .1);
  });
  add('out.w', [outputs, channels, 1], () => random()); add('out.b', [outputs], () => .05 + random() * .1);
  add('feat_mean', [mels], () => -4); add('feat_std', [mels], () => 2); add('out_scale', [outputs], i => .1 + i * .01);
  add('mel_fb', [mels, 257], i => ((i % 257) >= Math.floor(i / 257) * 3 && (i % 257) < Math.floor(i / 257) * 3 + 4) ? .5 : 0);
  add('window', [400], i => Math.sin(Math.PI * (i + 1) / 401) ** 2);
  if (quantiles) { // [inputs, outputs] applied to every output
    add('qmap_in', [outputs, quantiles[0].length], i => quantiles[0][i % quantiles[0].length]);
    add('qmap_out', [outputs, quantiles[1].length], i => quantiles[1][i % quantiles[1].length]);
  }
  const controls = OUTPUT_CONTROLS.flatMap((names, index) => names.map(name => [index, name]));
  const meta = {version: 1, format: FACE_MODEL_FORMAT, lookahead, channels, dilations, sampleRate: 16000, hop: 160,
    window: 400, nfft: 512, mels, silence: -10, tensors, controls,
    ...(upper ? {upper: [[15, 'brows_raise'], [16, 'brows_lower']]} : {})};
  return {meta, buffer: Buffer.concat(parts)};
}
export const speechLike = (seconds, rate) => Float32Array.from({length: Math.round(seconds * rate)}, (_, i) => {
  const t = i / rate, syllable = Math.max(0, Math.sin(2 * Math.PI * 3.1 * t));
  return .3 * syllable * (Math.sin(2 * Math.PI * 180 * t) + .5 * Math.sin(2 * Math.PI * 900 * t) + .2 * Math.sin(2 * Math.PI * 2500 * t));
});
