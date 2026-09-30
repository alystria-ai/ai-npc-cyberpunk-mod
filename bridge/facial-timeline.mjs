import {readPcmWav} from './speech-audio.mjs';
import {PHONETIC_TRACKS, phoneticPose} from './phonetic-poses.mjs';
import {validateMouthCues} from './phonetic-lipsync.mjs';

// Conservative speech controls. Head/eye rotation stays with the companion
// gaze controller. Local voices use audio-derived phonetic cues; the envelope
// remains an explicit fallback when the external analyser is unavailable.
export const SPEECH_TRACKS = Object.freeze([
  'jaw_mid_open', 'lips_apart_up', 'lips_apart_dn', 'lips_together_up', 'lips_together_dn',
  'lips_l_funnel', 'lips_r_funnel', 'lips_l_purse', 'lips_r_purse', 'lips_l_stretch', 'lips_r_stretch',
  ...PHONETIC_TRACKS, 'lips_suck_up',
]);
const clamp = (value, max = 1) => Math.max(0, Math.min(max, value));
const zero = () => SPEECH_TRACKS.map(() => 0);
const rounded = value => Math.round(value * 10000) / 10000;

function amplitude(wav, segment) {
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
    : 0.2 * (envelope[index - 1] ?? (segment && !segment.first ? value : 0)) + 0.6 * value
      + 0.2 * (envelope[index + 1] ?? (segment && !segment.last ? value : 0)));
}

function speechSegment(value, duration) {
  if (value === undefined) return undefined;
  if (!value || value.version !== 1 || !Number.isInteger(value.index) || value.index < 1 || value.index > 128
      || !Number.isFinite(value.startSeconds) || value.startSeconds < 0 || value.startSeconds + duration > 120.0001
      || value.first !== (value.index === 1) || typeof value.last !== 'boolean'
      || (value.first ? value.startSeconds !== 0 : value.startSeconds <= 0)) throw Error('Invalid facial segment boundary');
  return {version: 1, index: value.index, startSeconds: value.startSeconds, first: value.first, last: value.last};
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

function sourceSpacing(source) {
  if (!source || source.length < 2) return undefined;
  const intervals = source.slice(1).map((frame, index) => frame.at - source[index].at).sort((a, b) => a - b);
  return intervals[Math.floor(intervals.length / 2)];
}

function facialFps(source) {
  if (!source || source.length < 3) return 30;
  // The SDK request is a preference, not proof of the delivered cadence.
  // Use actual indexed timestamps; one interpolated file-boundary frame must
  // not halve/double that rate. Preserve the provider's 60Hz poses, while
  // keeping sparse-feed interpolation and the native 7202-frame/120s budget.
  return Math.max(30, Math.min(60, Math.round(1 / sourceSpacing(source))));
}

// SDK 1.7.0 lipsync-helpers/arkitOrder61.js: JawOpen is index 17, not
// standard ARKit-52's index 24. Never infer a mapping from vector length alone.
// The captured Convai jaw range drove only ~0.71 degrees of typical native jaw
// rotation on Judy/Johnny. A fixed k10 shoulder expands those small/mid poses:
// zero remains zero, and identical source poses stay identical across replies
// and prefixes. The .40 ceiling is unchanged. CPU replay's peak remained below
// the previously accepted .348 jaw probe; the user accepted this opening range.
// Upper lift now has a separately rendered .06 cap and an aperture budget;
// contact uses its separately rendered native range rather than a jaw limit.
// See docs/NATIVE_FACIAL_RETARGET_CALIBRATION.md for calibration and limits.
const opening = (value, lift) => value + lift * value * (1 - value);
const shapeResponse = (value, drive) => drive * value / (1 + (drive - 1) * value);
function mapArkit(v) {
  const a = index => clamp(v[index]);
  const closed = a(18), seal = 1 - closed, jaw = a(17), open = jaw * seal;
  const upperLeft = shapeResponse(a(39), 2), upperRight = shapeResponse(a(40), 2);
  const lowerLeft = shapeResponse(a(37), 2), lowerRight = shapeResponse(a(38), 2);
  // Lip-together poses scale a jaw-dependent corrective in this rig. The
  // rendered .35 probe still left a gap; .85 produced contact at the same jaw.
  // Upper raisers are separately bounded by the rendered .06 pair. Reduce the
  // aggregate upper-aperture contribution as that separate lift takes over.
  const contact = .85 * shapeResponse(closed, 12);
  const upperBudget = 1 - (2 / 3) * Math.max(upperLeft, upperRight);
  const lowerBudget = 1 - (2 / 3) * Math.max(lowerLeft, lowerRight);
  // ARKit MouthStretch describes the mouth corner. Judy's native "stretch"
  // primarily shapes the inner/lower lip; corner_stretch moves the actual
  // corner. The steady-jaw in-game comparison visibly resolved .23 corner /
  // .14 inner stretch, and .32 funnel / .28 purse. Fixed shoulders make the
  // provider's small/mid lip signals readable within those tested endpoints.
  // Zero remains neutral; pose strength never depends on another frame/reply.
  // MouthRollLower keeps its source-driven inward lip pose.
  const articulation = {lips_l_corner_stretch: .23 * shapeResponse(a(29), 3),
    lips_r_corner_stretch: .23 * shapeResponse(a(30), 3),
    lips_l_upper_raise: .06 * upperLeft * seal, lips_r_upper_raise: .06 * upperRight * seal,
    // Despite their native names, hierarchy replay and the directional probe
    // show these controls pull the respective lower lip DOWN and BACK.
    // Preserve independent LowerDown signals, with less aggregate aperture.
    lips_l_lower_raise: .12 * lowerLeft * seal, lips_r_lower_raise: .12 * lowerRight * seal,
    lips_suck_dn: .20 * a(31)};
  return [0.40 * (10 * jaw / (1 + 9 * jaw)) * seal,
    0.12 * opening(Math.max(open, (a(39) + a(40)) / 2), .20) * seal * upperBudget,
    0.16 * opening(Math.max(open, (a(37) + a(38)) / 2), .12) * seal * lowerBudget,
    contact, contact,
    .32 * shapeResponse(a(19), 4), .32 * shapeResponse(a(19), 4),
    .28 * shapeResponse(a(20), 4), .28 * shapeResponse(a(20), 4),
    .14 * a(29), .14 * a(30), ...PHONETIC_TRACKS.map(track => articulation[track] ?? 0),
    // ARKit MouthRollUpper retracts the upper lip independently of jaw/lift.
    // Both .03/.06 and the .06 + contact combination were rendered on Judy.
    .06 * shapeResponse(a(32), 5)];
}

function renderTimeline({owner, duration, segment, source, cues, envelope = [], first, last, sampleRate}) {
  const frames = [];
  // Provider articulation includes quiet closures and anticipatory shapes.
  // Per-file RMS normalization cannot distinguish these from rest: gating it
  // erased whole 33ms poses and made a file cut change the same mouth shape.
  // Trust valid ARKit timing/neutral poses; retain energy for local fallback.
  // A held provider pose may remain during its silent audio until the source
  // changes, expires below, or the utterance ends. Do not invent neutral poses.
  const fps = cues ? 60 : facialFps(source);
  let index = 0;
  const poseAt = at => {
    // An intermediate segment ends inside one spoken utterance. Clamp the
    // envelope to the last real sample instead of inventing an empty next
    // analysis frame, which would itself close the jaw at every file edge.
    const energyAt = segment && !last ? Math.min(at, Math.max(0, duration - 1 / sampleRate)) : at;
    const energyFrame = energyAt * 30, energyIndex = Math.floor(energyFrame);
    const level = (envelope[energyIndex] || 0) * (1 - energyFrame + energyIndex)
      + (envelope[energyIndex + 1] ?? (segment && !last ? envelope[energyIndex] || 0 : 0)) * (energyFrame - energyIndex);
    let values = zero();
    if (source || level > 0 || cues) {
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
      // Only actual utterance boundaries ease to/from neutral. Ordinary
      // replies and v1 phrase timelines retain their original edge behavior.
      // No audio samples or gaze channels are changed by these pose flags.
      const edge = clamp(Math.min(first ? at / .04 : 1, last ? (duration - at) / .04 : 1));
      values = values.map(v => rounded(v * edge));
    }
    return values;
  };
  for (let sample = 0; sample / fps < duration; sample++) {
    const at = sample / fps;
    frames.push([at, ...poseAt(at)]);
  }
  frames.push([duration, ...poseAt(duration)]);
  return {version: 1, requestId: owner.requestId, entity: owner.entity, duration,
    source: source ? 'convai-arkit61' : cues ? 'local-phonetic' : 'audio-envelope',
    articulation: source ? 'arkit61-native-v9' : cues ? 'coarticulated-v4' : undefined,
    ...(segment ? {segment} : {}), tracks: [...SPEECH_TRACKS], frames};
}

export function buildFacialTimeline(result, owner) {
  if (!result.audio || typeof owner?.requestId !== 'string' || typeof owner.entity !== 'string') return undefined;
  const wav = readPcmWav(Buffer.from(result.audio, 'base64'));
  const segment = speechSegment(result.speechSegment, wav.duration);
  const first = segment ? segment.first : true, last = segment ? segment.last : true;
  const source = validFaces(result, wav.duration);
  let cues;
  if (!source && result.mouthCuesFormat === 'rhubarb-phonetic-v1') {
    try { cues = validateMouthCues({metadata: {duration: wav.duration}, mouthCues: result.mouthCues}, wav.duration); }
    catch { /* A damaged analyser result cannot take voice playback down. */ }
  }
  return renderTimeline({owner, duration: wav.duration, sampleRate: wav.sampleRate, segment, source, cues,
    first, last, envelope: source ? [] : amplitude(wav, segment)});
}

// Continuous PCM playback owns one global audio clock. Build only its received
// prefix from indexed provider poses; no synthetic WAV or inferred phonemes are
// needed. Missing facial coverage never prevents the separate audio publisher.
export function buildProviderFacialTimeline(result, owner) {
  if (!result || typeof owner?.requestId !== 'string' || typeof owner.entity !== 'string'
      || !Number.isSafeInteger(owner.generation) || owner.generation < 0 || owner.generation > 2147483647
      || !Number.isFinite(result.duration) || result.duration <= 0 || result.duration > 120
      || typeof result.complete !== 'boolean') return undefined;
  const source = validFaces(result, result.duration);
  if (!source || source[0].at !== 0) return undefined;
  // A normal sampled timeline can end up to one frame before its PCM cursor.
  // Longer missing tails are incomplete, rather than permission to animate a
  // large neutral/frozen suffix. Ahead-delivered data is valid and not truncated
  // in the caller; retain one bracketing future pose for this prefix's endpoint.
  const tolerance = Math.min(.1, sourceSpacing(source) ?? 1 / 30);
  if (source.at(-1).at + tolerance + 1e-7 < result.duration) return undefined;
  const right = source.findIndex(frame => frame.at >= result.duration);
  const window = right >= 0 ? source.slice(0, right + 1) : source;
  const line = renderTimeline({owner, duration: result.duration, source: window,
    first: true, last: result.complete});
  // A growing timeline crosses repeated game polls; preserve the same load/
  // request generation that the Lua owner uses to reject stale facial data.
  return {...line, generation: owner.generation, continuous: true, complete: result.complete};
}
