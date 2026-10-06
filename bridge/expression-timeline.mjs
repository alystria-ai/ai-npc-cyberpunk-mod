// Aligns an emotion plan (bridge/emotion-analysis.mjs) to REAL audio time and
// emits an expression track: emotion-family weights over the audio clock.
//
// The face must change when each phrase is heard, not when its text arrived or
// where it sits in the string. Alignment evidence, most direct first:
//   1. phrase boundaries the caller already knows (Omni renders one phrase per
//      audio file: its own audio starts at 0, so each phrase is one timeline);
//   2. pauses in the speech-activity curve of the rendered mouth timeline (the
//      jaw/lip-aperture rows of the game-trained model or the provider's own
//      poses): a sentence boundary in TTS output is a real silence of 0.2-0.5 s,
//      so the k-th text boundary is snapped to the best matching pause near its
//      expected position;
//   3. a spoken-duration estimate from syllables and punctuation, rescaled to
//      the audio duration seen so far (or the final duration once complete).
// That is a cheap forced alignment of text to audio with no recognizer. The
// track starts each change LEAD seconds ahead of the spoken word (the face
// anticipates) and blends over BLEND seconds, then holds through the phrase.
import {FAMILIES} from './emotion-analysis.mjs';

export const TRACK_FORMAT = 'emotion-mix-v1';
export const LEAD_SECONDS = .2, BLEND_SECONDS = .3;
const MIN_PAUSE = .16, SENTENCE_PAUSE = .3, ACTIVE = .035, MIN_SEGMENT = .22, MAX_KEYS = 160;
const rounded = value => Math.round(value * 1000) / 1000;
const vector = weights => FAMILIES.map(family => rounded(Math.max(0, Math.min(1, weights?.[family] || 0))));

// Speech activity per frame from a mouth timeline's own rows (jaw + lip aperture).
export function speechActivity(face) {
  const tracks = face?.tracks, frames = face?.frames;
  if (!Array.isArray(tracks) || !Array.isArray(frames) || frames.length < 2) return undefined;
  const indices = ['jaw_mid_open', 'lips_apart_up', 'lips_apart_dn'].map(name => tracks.indexOf(name) + 1).filter(index => index > 0);
  if (!indices.length) return undefined;
  const times = new Array(frames.length), values = new Array(frames.length);
  frames.forEach((row, at) => { times[at] = row[0]; values[at] = indices.reduce((sum, index) => sum + (row[index] || 0), 0); });
  return {times, values};
}

// Voiced span and the silences inside it. Leading/trailing silence is not a pause.
export function findPauses(activity, {minLength = MIN_PAUSE, threshold = ACTIVE} = {}) {
  if (!activity) return {onset: 0, offset: 0, pauses: []};
  const {times, values} = activity;
  let first = values.findIndex(value => value >= threshold), last = -1;
  for (let i = values.length - 1; i >= 0; i--) if (values[i] >= threshold) { last = i; break; }
  if (first < 0) return {onset: 0, offset: times.at(-1) ?? 0, pauses: [], silent: true};
  const pauses = [];
  let start = -1;
  for (let i = first; i <= last; i++) {
    if (values[i] < threshold) { if (start < 0) start = i; }
    else if (start >= 0) {
      const from = times[start], to = times[i];
      if (to - from >= minLength) pauses.push({start: from, end: to, length: to - from, middle: (from + to) / 2});
      start = -1;
    }
  }
  return {onset: times[first], offset: times[last], pauses};
}

// Start time (audio seconds) of every segment.
export function alignSegments(segments, {duration, complete = true, activity, forced} = {}) {
  const n = segments.length;
  if (!n) return {starts: [], resolved: []};
  if (forced?.length === n) return {starts: [...forced], resolved: forced.map(() => true)};
  const {onset, offset, pauses} = findPauses(activity);
  const cumulative = [0];
  for (let i = 0; i < n; i++) cumulative.push(cumulative[i] + Math.max(.15, segments[i].seconds) + (i < n - 1 ? segments[i].pauseAfter : 0));
  const total = cumulative[n];
  const starts = new Array(n), resolved = new Array(n).fill(false), unused = [...pauses];
  starts[0] = Math.min(onset, Math.max(0, duration - MIN_SEGMENT)); resolved[0] = true;
  const end = complete ? Math.max(offset || duration, starts[0] + MIN_SEGMENT) : undefined;
  let previous = 0;
  for (let i = 1; i < n; i++) {
    const baseTime = starts[previous];
    let rate;
    if (complete) rate = Math.max(.3, Math.min(3, (end - baseTime) / Math.max(.1, total - cumulative[previous])));
    else {
      // Rate measured so far from resolved boundaries, else the nominal rate.
      rate = previous > 0 && cumulative[previous] > 0 ? (baseTime - starts[0]) / cumulative[previous] : 1;
      rate = Math.max(.6, Math.min(1.7, rate || 1));
    }
    const expected = baseTime + (cumulative[i] - cumulative[previous]) * rate;
    // Before the audio is complete the rate is only a guess (real speech is often
    // slower than the nominal rate), so the search window is wider.
    const window = complete ? Math.max(.6, .3 * (expected - baseTime)) : Math.max(1.5, 1.0 * (expected - baseTime));
    let best, bestScore = -Infinity, earliest;
    for (const pause of unused) {
      if (pause.end <= baseTime + MIN_SEGMENT || Math.abs(pause.middle - expected) > window) continue;
      const score = pause.length * 2 - Math.abs(pause.middle - expected) * 1.2;
      if (score > bestScore) { best = pause; bestScore = score; }
      if (pause.length >= SENTENCE_PAUSE && (!earliest || pause.start < earliest.start)) earliest = pause;
    }
    // Boundaries are ordered: when the speaker is slower than the nominal rate the
    // next sentence-grade silence (not a later, better-scoring one) is this boundary.
    if (!complete && earliest) best = earliest;
    if (best) { starts[i] = best.end; resolved[i] = true; unused.splice(unused.indexOf(best), 1); previous = i; }
    else starts[i] = expected;
    if (starts[i] < starts[i - 1] + MIN_SEGMENT) starts[i] = starts[i - 1] + MIN_SEGMENT;
  }
  return {starts, resolved};
}

// keys: [[t, ...8 family weights]]. Each change begins LEAD before the phrase's
// audio start, blends over BLEND, then holds. `decay` returns to baseline at the end.
export function buildTrack(plan, starts, {duration, decay = false, resolved = []} = {}) {
  const segments = plan.segments, keys = [];
  const push = (t, weights) => {
    const time = Math.max(0, rounded(t));
    if (keys.length && time <= keys.at(-1)[0]) return;
    keys.push([time, ...vector(weights)]);
  };
  segments.forEach((segment, i) => {
    if (i === 0) { push(0, segment.weights); return; }
    const begin = starts[i] - LEAD_SECONDS, previous = segments[i - 1].weights;
    // Hold the previous phrase's weights up to the start of the change.
    push(Math.max(begin, (keys.at(-1)?.[0] ?? 0) + .02), previous);
    push(begin + BLEND_SECONDS, segment.weights);
  });
  if (decay && segments.length) {
    const closing = Math.max((keys.at(-1)?.[0] ?? 0) + .05, (duration ?? 0) - .05);
    push(closing, segments.at(-1).weights);
    push(closing + .3, plan.baseline);
  }
  while (keys.length > MAX_KEYS) keys.splice(1, 1);
  const spans = segments.map((segment, i) => ({
    start: rounded(starts[i]), end: rounded(i + 1 < segments.length ? starts[i + 1] : Math.max(starts[i], duration ?? starts[i])),
    from: segment.start, to: segment.end, dominant: segment.dominant, mixed: segment.mixed, tags: segment.tags,
    top: Object.entries(segment.weights).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([family, weight]) => [family, rounded(weight)]),
    anchored: resolved[i] === true}));
  return {version: 1, format: TRACK_FORMAT, families: [...FAMILIES], keys, segments: spans};
}

// Attach an expression track to an assembled mouth timeline (any route). Never
// throws: a failure leaves the face as it was and the reply-level cue in effect.
export function attachExpressionTrack(face, plan, {complete, decay} = {}) {
  try {
    if (!face || !plan?.segments?.length || !(face.duration > 0)) return face;
    const finished = complete ?? face.complete ?? true;
    const activity = speechActivity(face);
    const {starts, resolved} = alignSegments(plan.segments, {duration: face.duration, complete: finished, activity});
    const track = buildTrack(plan, starts, {duration: face.duration, decay: decay ?? finished, resolved});
    return {...face, expressionTrack: track};
  } catch { return face; }
}

// Weights at audio time t: smoothstep between keys (Lua mirrors this exactly).
export function sampleTrack(track, t) {
  const keys = track?.keys;
  if (!Array.isArray(keys) || !keys.length) return undefined;
  if (t <= keys[0][0]) return keys[0].slice(1);
  if (t >= keys.at(-1)[0]) return keys.at(-1).slice(1);
  let i = 0;
  while (i + 1 < keys.length && keys[i + 1][0] <= t) i++;
  const a = keys[i], b = keys[i + 1], f = Math.max(0, Math.min(1, (t - a[0]) / (b[0] - a[0]))), s = f * f * (3 - 2 * f);
  return a.slice(1).map((value, k) => value + (b[k + 1] - value) * s);
}
