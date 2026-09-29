import {readPcmWav} from './speech-audio.mjs';
import {PHONETIC_TRACKS, phoneticPose} from './phonetic-poses.mjs';
import {validateMouthCues} from './phonetic-lipsync.mjs';

// Conservative speech controls. Head/eye rotation stays with the companion
// gaze controller. Local voices use audio-derived phonetic cues; the envelope
// remains an explicit fallback when the external analyser is unavailable.
export const SPEECH_TRACKS = Object.freeze([
  'jaw_mid_open', 'lips_apart_up', 'lips_apart_dn', 'lips_together_up', 'lips_together_dn',
  'lips_l_funnel', 'lips_r_funnel', 'lips_l_purse', 'lips_r_purse', 'lips_l_stretch', 'lips_r_stretch',
  ...PHONETIC_TRACKS,
]);
const clamp = (value, max = 1) => Math.max(0, Math.min(max, value));
const zero = () => SPEECH_TRACKS.map(() => 0);
const rounded = value => Math.round(value * 10000) / 10000;

function amplitude(wav) {
  const sampleBytes = wav.bits / 8, samples = wav.data.length / wav.align;
  const energies = [];
  for (let frame = 0; frame < Math.ceil(wav.duration * 30); frame++) {
    const first = Math.floor(frame * wav.sampleRate / 30);
    const last = Math.min(samples, Math.floor((frame + 1) * wav.sampleRate / 30));
    let squares = 0;
    for (let sample = first; sample < last; sample++) {
      for (let channel = 0; channel < wav.channels; channel++) {
        const offset = sample * wav.align + channel * sampleBytes;
        const raw = wav.codec === 3 ? wav.data.readFloatLE(offset)
          : wav.data.readIntLE(offset, sampleBytes) / (2 ** (wav.bits - 1));
        const value = Number.isFinite(raw) ? Math.max(-1, Math.min(1, raw)) : 0;
        squares += value * value;
      }
    }
    energies.push(Math.sqrt(squares / Math.max(1, (last - first) * wav.channels)));
  }
  const sorted = energies.filter(x => x > 0.0008).sort((a, b) => a - b);
  const reference = Math.max(0.015, sorted[Math.floor(sorted.length * 0.9)] || 0);
  const floor = Math.max(0.0008, reference * 0.025);
  const envelope = energies.map(x => clamp((x - floor) / (reference - floor)) ** 0.7);
  return envelope.map((value, index) => value === 0 ? 0
    : 0.2 * (envelope[index - 1] || 0) + 0.6 * value + 0.2 * (envelope[index + 1] || 0));
}

function validFaces(result, duration) {
  if (result.facesFormat !== 'arkit61' || result.facesTimebase !== 'audio-seconds'
      || !Array.isArray(result.faces) || result.faces.length < 2 || result.faces.length > 14400) return null;
  let previous = -1;
  for (const frame of result.faces) {
    if (!Number.isFinite(frame?.at) || frame.at < 0 || frame.at > 120 || frame.at <= previous
        || !Array.isArray(frame.values) || frame.values.length !== 61 || !frame.values.every(Number.isFinite)) return null;
    previous = frame.at;
  }
  // Don't stretch a partial or late-starting capture across a complete line.
  if (result.faces[0].at > 0.2 || previous < Math.min(duration * 0.6, duration - 0.2)) return null;
  return result.faces;
}

// SDK 1.7.0 lipsync-helpers/arkitOrder61.js: JawOpen is index 17, not
// standard ARKit-52's index 24. Never infer a mapping from vector length alone.
function mapArkit(v) {
  const a = index => clamp(v[index]);
  const closed = a(18), open = a(17) * (1 - closed);
  return [0.35 * open,
    0.12 * Math.max(open, (a(39) + a(40)) / 2) * (1 - closed),
    0.16 * Math.max(open, (a(37) + a(38)) / 2) * (1 - closed),
    0.20 * closed, 0.20 * closed,
    0.30 * a(19), 0.30 * a(19), 0.28 * a(20), 0.28 * a(20),
    0.20 * a(29), 0.20 * a(30), ...PHONETIC_TRACKS.map(() => 0)];
}

export function buildFacialTimeline(result, owner) {
  if (!result.audio || typeof owner?.requestId !== 'string' || typeof owner.entity !== 'string') return undefined;
  const wav = readPcmWav(Buffer.from(result.audio, 'base64'));
  const envelope = amplitude(wav), source = validFaces(result, wav.duration), frames = [];
  let cues;
  if (!source && result.mouthCuesFormat === 'rhubarb-phonetic-v1') {
    try { cues = validateMouthCues({metadata: {duration: wav.duration}, mouthCues: result.mouthCues}, wav.duration); }
    catch { /* A damaged analyser result cannot take voice playback down. */ }
  }
  const fps = cues ? 60 : 30;
  let index = 0;
  for (let sample = 0; sample / fps < wav.duration; sample++) {
    const at = sample / fps, energyFrame = at * 30, energyIndex = Math.floor(energyFrame);
    const level = (envelope[energyIndex] || 0) * (1 - energyFrame + energyIndex)
      + (envelope[energyIndex + 1] || 0) * (energyFrame - energyIndex);
    let values = zero();
    if (sample > 0 && (level > 0 || cues)) {
      if (source) {
        while (index + 1 < source.length && source[index + 1].at <= at) index++;
        const left = source[index], right = source[index + 1];
        if (at >= left.at && (right || at - left.at < 0.1)) {
          const blend = right ? clamp((at - left.at) / (right.at - left.at)) : 0;
          values = mapArkit(left.values.map((v, i) => v + ((right?.values[i] ?? v) - v) * blend));
        }
      } else if (cues) {
        values = phoneticPose(cues, at, level, SPEECH_TRACKS);
      } else {
        values[0] = 0.35 * level; values[1] = 0.12 * level; values[2] = 0.16 * level;
      }
      // Ease only the first/last 40 ms. The waveform is never changed.
      const edge = clamp(Math.min(at, wav.duration - at) / 0.04);
      values = values.map(v => rounded(v * edge));
    }
    frames.push([at, ...values]);
  }
  frames.push([wav.duration, ...zero()]);
  return {version: 1, requestId: owner.requestId, entity: owner.entity, duration: wav.duration,
    source: source ? 'convai-arkit61' : cues ? 'local-phonetic' : 'audio-envelope',
    articulation: cues ? 'coarticulated-v4' : undefined, tracks: [...SPEECH_TRACKS], frames};
}
