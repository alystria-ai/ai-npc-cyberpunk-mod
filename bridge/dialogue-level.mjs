// Dialogue level matching. Cyberpunk's own voice-over files are mastered near
// -23.6 LUFS (measured from extracted lines) and the game's Wwise dialogue mix
// then plays them louder than unity playback does. Generated speech arrives at
// a similar file level (-22 to -26 LUFS), so unity playback through the browser
// sounds quieter than vanilla dialogue. This module holds the one
// calibrated makeup gain every voice uses (the renderer applies it as sample gain behind its limiter), and the offline WAV helpers
// (gain plus a lookahead peak limiter, so boosting never clips) kept for scripts and tests.

// Calibrated against a loopback recording of vanilla dialogue (see
// docs/DIALOGUE_LEVEL.md). Applied to every spoken reply unless the player
// turns "Match game dialogue level" off, which restores unity playback.
export const DIALOGUE_MAKEUP_DB = 6;
export const MAX_MAKEUP_DB = 12;
// Output ceiling for the limiter, in dBFS. Peaks above it are reduced.
export const LIMITER_CEILING_DB = -1;

const finite = value => typeof value === 'number' && Number.isFinite(value);

export function makeupDb(value) {
  return finite(value) ? Math.max(0, Math.min(MAX_MAKEUP_DB, value)) : DIALOGUE_MAKEUP_DB;
}

// The bridge's current choice, from runtime/dialogue-level.json:
//   {"enabled": false}            unity playback, exactly the previous path
//   {"enabled": true, "makeupDb": 7.5}   a calibrated level (0..12 dB)
// A missing or unreadable file keeps the calibrated default. One process-wide
// value: every speaker of a group and every provider uses the same level.
let state = {enabled: true, makeupDb: DIALOGUE_MAKEUP_DB};
export function updateDialogueLevel(raw) {
  let value; try { value = raw ? JSON.parse(raw) : undefined; } catch { return false; }
  const next = value && typeof value === 'object'
    ? {enabled: value.enabled !== false, makeupDb: makeupDb(value.makeupDb)}
    : {enabled: true, makeupDb: DIALOGUE_MAKEUP_DB};
  const changed = next.enabled !== state.enabled || next.makeupDb !== state.makeupDb;
  state = next; return changed;
}
export const dialogueLevel = () => ({...state});
export const dbToGain = db => Math.pow(10, db / 20);

// Settings > Voices > Voice volume (runtime/settings.json "voiceVolume", a percent): the player's own trim on top of the dialogue
// level, for every spoken voice (companions, NPCs, add-ons) and V's voice for typed lines. 100 is unity and the default; below it
// is plain attenuation; above it is gain behind the same peak limiter (Web Audio compressor in the browser, the look-ahead limiter
// in the offline WAV helper), so 200% (+6.02 dB) never clips. It rides in the same makeup field, so nothing else changes: no per-frame
// work, no buffering, no timing change (the limiter's fixed look-ahead is already compensated), and the next phrase or poll uses it.
export const VOICE_VOLUME = Object.freeze({min: 50, max: 200, step: 5, default: 100});
export const voiceVolumeDbOf = percent => 20 * Math.log10(percent / 100);
// The total (dialogue level plus voice volume) the renderers accept, in dB: -6.02 (50% with matching off) to +18.02 (the most
// makeup the file allows plus 200%).
export const MIN_TOTAL_DB = voiceVolumeDbOf(VOICE_VOLUME.min);
export const MAX_TOTAL_DB = MAX_MAKEUP_DB + voiceVolumeDbOf(VOICE_VOLUME.max);

/** The percent a settings value means: a finite number clamped to 50..200 and rounded; anything else is 100. */
export function voiceVolumePercent(value) {
  if (!finite(value)) return VOICE_VOLUME.default;
  return Math.max(VOICE_VOLUME.min, Math.min(VOICE_VOLUME.max, Math.round(value)));
}
let voiceVolume = VOICE_VOLUME.default;
/** Reads the setting from the parsed runtime/settings.json (undefined keeps the current value). Returns whether it changed. */
export function updateVoiceVolume(settings) {
  if (!settings || typeof settings !== 'object') return false;
  const next = voiceVolumePercent(settings.voiceVolume);
  const changed = next !== voiceVolume; voiceVolume = next; return changed;
}
export const voiceVolumePercentNow = () => voiceVolume;
/** The voice volume as dB: 0 at 100%. V's voice uses this alone (it has no dialogue-level makeup). */
export const voiceVolumeDb = () => voiceVolume === VOICE_VOLUME.default ? 0 : voiceVolumeDbOf(voiceVolume);
// The makeup actually applied: the dialogue level (0 when the player turned matching off) plus the voice volume.
export const activeMakeupDb = () => (state.enabled ? state.makeupDb : 0) + voiceVolumeDb();

// ITU-R BS.1770-4 K-weighting at any sample rate (libebur128 coefficients).
export function kWeighting(samples, rate) {
  const out = new Float64Array(samples.length);
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / rate);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const sb = [(Vh + Vb * K / Q + K * K) / a0, 2 * (K * K - Vh) / a0, (Vh - Vb * K / Q + K * K) / a0];
  const sa = [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  f0 = 38.13547087602444; Q = 0.5003270373238773; K = Math.tan(Math.PI * f0 / rate);
  a0 = 1 + K / Q + K * K;
  const ha = [2 * (K * K - 1) / a0, (1 - K / Q + K * K) / a0];
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, z1 = 0, z2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = sb[0] * x + sb[1] * x1 + sb[2] * x2 - sa[0] * y1 - sa[1] * y2;
    // High-pass numerator (1, -2, 1) over the shelf output history.
    const z = y - 2 * y1 + y2 - ha[0] * z1 - ha[1] * z2;
    x2 = x1; x1 = x; y2 = y1; y1 = y; z2 = z1; z1 = z;
    out[i] = z;
  }
  return out;
}

// Gated integrated loudness of K-weighted channels (LUFS). Mono counts once.
export function integratedLoudness(weighted, rate) {
  const block = Math.round(rate * 0.4), step = Math.round(rate * 0.1), length = weighted[0]?.length || 0;
  const powers = [];
  for (let start = 0; start + block <= length; start += step) {
    let sum = 0;
    for (const channel of weighted) {
      let s = 0; for (let i = start; i < start + block; i++) s += channel[i] * channel[i];
      sum += s / block;
    }
    powers.push(sum);
  }
  const loud = p => -0.691 + 10 * Math.log10(p);
  const absolute = powers.filter(p => p > 0 && loud(p) > -70);
  if (!absolute.length) return -Infinity;
  const mean = values => values.reduce((a, b) => a + b, 0) / values.length;
  const relative = loud(mean(absolute)) - 10;
  const gated = absolute.filter(p => loud(p) > relative);
  return gated.length ? loud(mean(gated)) : -Infinity;
}

// Gain followed by a 5 ms lookahead peak limiter (instant attack inside the
// lookahead window, 80 ms release). Output length and timing are unchanged:
// the lookahead is compensated, so lip-sync timelines stay aligned.
export function applyGainLimited(samples, rate, gainDb, ceilingDb = LIMITER_CEILING_DB) {
  const gain = dbToGain(gainDb), ceiling = dbToGain(ceilingDb);
  const n = samples.length, out = new Float32Array(n);
  const look = Math.max(1, Math.round(rate * 0.005));
  const release = Math.exp(-1 / (rate * 0.08));
  // Required gain at each sample, then a backward-looking minimum over the
  // lookahead so reduction starts before the peak arrives.
  const need = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const peak = Math.abs(samples[i] * gain);
    need[i] = peak > ceiling ? ceiling / peak : 1;
  }
  let current = 1;
  const window = [];
  for (let i = 0; i < n; i++) {
    // Minimum of need[i .. i+look] (monotonic deque).
    const ahead = i + look < n ? i + look : n - 1;
    if (i === 0) for (let j = 0; j <= ahead; j++) push(j); else if (i + look < n) push(i + look);
    while (window[0] < i) window.shift();
    const target = need[window[0]];
    current = target < current ? target : target + (current - target) * release;
    out[i] = samples[i] * gain * current;
    if (Math.abs(out[i]) > ceiling) out[i] = Math.sign(out[i]) * ceiling;
  }
  return out;
  function push(j) { while (window.length && need[window[window.length - 1]] >= need[j]) window.pop(); window.push(j); }
}

// PCM16/24/32 or float32 mono/stereo WAV in, PCM16 WAV out with the dialogue
// level applied. `info` is readPcmWav's result for the same bytes.
export function levelWav(info, gainDb) {
  const {channels, sampleRate, bits, codec, data, align} = info;
  const frames = data.length / align;
  const planes = Array.from({length: channels}, () => new Float32Array(frames));
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) {
    const at = f * align + c * bits / 8;
    planes[c][f] = codec === 3 ? data.readFloatLE(at) : bits === 16 ? data.readInt16LE(at) / 32768
      : bits === 24 ? data.readIntLE(at, 3) / 8388608 : data.readInt32LE(at) / 2147483648;
  }
  // Stereo is limited on the louder channel so the image is not shifted.
  const levelled = channels === 1 ? [applyGainLimited(planes[0], sampleRate, gainDb)] : linkedStereo(planes, sampleRate, gainDb);
  const out = Buffer.alloc(44 + frames * channels * 2);
  out.write('RIFF'); out.writeUInt32LE(out.length - 8, 4); out.write('WAVEfmt ', 8);
  out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24); out.writeUInt32LE(sampleRate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32); out.writeUInt16LE(16, 34); out.write('data', 36);
  out.writeUInt32LE(frames * channels * 2, 40);
  for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) {
    const v = Math.max(-1, Math.min(1, levelled[c][f]));
    out.writeInt16LE(Math.round(v < 0 ? v * 32768 : v * 32767), 44 + (f * channels + c) * 2);
  }
  return out;
}

function linkedStereo(planes, rate, gainDb) {
  const louder = new Float32Array(planes[0].length);
  for (let i = 0; i < louder.length; i++) louder[i] = Math.max(Math.abs(planes[0][i]), Math.abs(planes[1][i]));
  const limited = applyGainLimited(louder, rate, gainDb), gain = dbToGain(gainDb);
  return planes.map(plane => plane.map((v, i) => louder[i] ? v * gain * (limited[i] / (louder[i] * gain)) : 0));
}
