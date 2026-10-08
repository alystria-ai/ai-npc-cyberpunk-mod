// Audio-aligned caption cues for one continuous utterance (Pocket, Convai).
//
// A subtitle page must appear when its words are heard and stay until they have
// been said. A character share of a duration estimate cannot do that: TTS pauses
// between sentences, speaks some phrases faster than others, and the total is
// unknown until the stream completes. This uses the same evidence as the
// expression track (bridge/expression-timeline.mjs): the speech-activity curve
// of the rendered mouth timeline, whose silences are the sentence and clause
// boundaries actually spoken. Each cue is one sentence (or half of a very long
// one) of the displayed text, with the audio second its speech begins and,
// when known, ends. The game paginates cues into its own layout budget and
// advances only on the heard playback position, the clock the face already uses.
//
// Captions err late, never early: a page replaced while its words are still
// being said is the defect this exists to prevent. So a boundary is snapped
// only to a silence near where the speaking rate puts it and never inside the
// first part of the preceding sentence. Until the stream is complete, a
// boundary no silence confirms is published only once the analysed audio runs
// well past it (no pause is coming); otherwise its start is null and the game
// keeps the current page. Concatenating every cue's text gives back the input.
import {segmentText, syllables} from './emotion-analysis.mjs';
import {speechActivity, findPauses} from './expression-timeline.mjs';

export const CAPTION_FORMAT = 'caption-cues-v1';
const MAX_CUES = 64, SYLLABLES_PER_SECOND = 4.4, SETTLE_SECONDS = .6;
// A boundary pause: at least this long, and not before this share of the
// preceding sentence's expected length has been spoken.
const BOUNDARY_PAUSE = .14, EARLIEST_SHARE = .45;
const rounded = value => Math.round(value * 1000) / 1000;
const finite = value => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function pauseAfter(segment) {
  const closing = segment.tokens.at(-1);
  if (!closing || closing.word) return .04;
  if (closing.ellipsis) return .45;
  if (closing.terminal) return .3;
  if (closing.comma) return .12;
  return .04;
}

// Sentence starts, so one-word sentences ("Pinky?") keep their own boundary:
// a silence after them must never be taken for the next sentence's start.
function sentenceStarts(text) {
  const out = [];
  for (const match of text.matchAll(/(?:[.!?…]+|\.{2,})["'”’)\]]*\s+(?=\S)/gu)) out.push(match.index + match[0].length);
  return out;
}

// text: displayed reply text (voice/emotion tags already removed).
// face: the continuous mouth timeline (optional). duration: buffered audio seconds.
// complete: audio and text are both final.
export function captionCues(text, {face, duration, complete = false} = {}) {
  if (typeof text !== 'string' || !text.trim() || text.length > 12000 || !finite(duration) || duration < 0) return undefined;
  const segments = segmentText(text, {breaks: sentenceStarts(text)});
  if (!segments.length) return undefined;
  // Bound the published list: merge the shortest neighbours of a very long reply.
  while (segments.length > MAX_CUES) {
    let best = 0;
    for (let i = 1; i < segments.length - 1; i++)
      if (segments[i].end - segments[i].start < segments[best].end - segments[best].start) best = i;
    const a = Math.min(best, segments.length - 2);
    segments.splice(a, 2, {...segments[a], tokens: [...segments[a].tokens, ...segments[a + 1].tokens], end: segments[a + 1].end});
  }
  const n = segments.length;
  const nominal = segments.map(segment => Math.max(.15,
    segment.tokens.filter(token => token.word).reduce((sum, token) => sum + syllables(token.raw), 0) / SYLLABLES_PER_SECOND));
  const gaps = segments.map((segment, index) => index < n - 1 ? pauseAfter(segment) : 0);
  const activity = face && finite(face.duration) && face.duration > 0 ? speechActivity(face) : undefined;
  // Final audio whose mouth timeline is still being analysed is aligned as a stream.
  if (complete && activity && activity.times.at(-1) < duration - .25) complete = false;
  const {onset, offset, pauses, silent} = findPauses(activity);
  // Evidence so far: the last voiced frame of the mouth timeline. Silence at the
  // end of the analysed audio is a pause still in progress, not proof that no
  // pause is coming (without a timeline: the buffered audio).
  const covered = activity ? (silent ? 0 : offset) : duration;
  const voicedEnd = complete ? (activity && offset > onset ? offset : duration) : undefined;
  // Real seconds of speech per nominal second, pauses excluded (a long pause
  // after a short sentence must not make the speaker look slow). Complete
  // audio: voiced span minus its detected silences; then, and while streaming,
  // the boundaries already resolved.
  const speech = nominal.reduce((sum, value) => sum + value, 0);
  const silence = pauses.reduce((sum, pause) => sum + (pause.length >= BOUNDARY_PAUSE ? pause.length : 0), 0);
  const initial = complete ? clamp((voicedEnd - onset - silence) / Math.max(.1, speech), .35, 3) : .9;
  let rate = initial, spoken = 0, measured = 0;
  const starts = [0], ends = new Array(n).fill(null), anchored = [true];
  let unknown = false, used = -1;
  for (let i = 1; i < n; i++) {
    const base = i === 1 ? onset : starts[i - 1];
    if (unknown || base === null) { starts.push(null); anchored.push(false); unknown = true; continue; }
    const talk = nominal[i - 1] * rate, expectedEnd = base + talk;
    const window = complete ? Math.max(.6, .4 * talk) : Math.max(.8, .6 * talk);
    const earliest = base + EARLIEST_SHARE * talk;
    let best, bestScore = -Infinity;
    for (let k = used + 1; k < pauses.length; k++) {
      const pause = pauses[k];
      if (pause.length < BOUNDARY_PAUSE || pause.start < earliest || pause.end <= base) continue;
      if (Math.abs(pause.start - expectedEnd) > window) continue;
      const score = pause.length * 2 - Math.abs(pause.start - expectedEnd) * 1.2 + (gaps[i - 1] >= .3 && pause.length >= .3 ? .2 : 0);
      if (score > bestScore) { best = k; bestScore = score; }
    }
    if (best !== undefined) {
      const pause = pauses[best];
      used = best; starts.push(pause.end); ends[i - 1] = pause.start; anchored.push(true);
      spoken += pause.start - base; measured += nominal[i - 1];
      rate = clamp(spoken / Math.max(.1, measured), .5, 1.8);
      if (complete) rate = (rate * measured + initial * nominal[i - 1]) / (measured + nominal[i - 1]);
      continue;
    }
    // No silence: the expected time stands, once the analysis is far past it.
    const expected = expectedEnd + gaps[i - 1];
    if (!complete && !(covered >= expected + SETTLE_SECONDS)) { starts.push(null); anchored.push(false); unknown = true; continue; }
    starts.push(complete ? Math.min(expected, Math.max(base, voicedEnd - .15)) : expected);
    anchored.push(false);
  }
  const cues = segments.map((segment, i) => {
    const from = i === 0 ? 0 : segment.start, to = i + 1 < n ? segments[i + 1].start : text.length;
    const start = starts[i] === null ? null : rounded(Math.max(0, starts[i]));
    let end = null;
    if (i + 1 < n && starts[i + 1] !== null) end = rounded(Math.max(start ?? 0, ends[i] ?? starts[i + 1]));
    else if (i + 1 === n && complete && start !== null) end = rounded(Math.max(start, Math.min(duration, voicedEnd)));
    return {text: text.slice(from, to), start, finish: end, anchored: anchored[i] === true && start !== null};
  });
  return {version: 1, format: CAPTION_FORMAT, complete: complete === true, cues};
}

// Stable identity for a published cue list: revisions bump only when it changes.
export function cueSignature(captions) {
  return captions ? JSON.stringify([captions.complete, captions.cues.map(cue => [cue.text, cue.start, cue.finish])]) : '';
}
