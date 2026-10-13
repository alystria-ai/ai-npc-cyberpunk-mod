// Expressive emotions for the Inworld cloud voice (docs/CLOUD_VOICE_INWORLD.md, "Emotion").
//
// The character writes feelings inline as {joy}, {anger:strong} ... (docs/EMOTION_TAGS.md). The bridge removes the tags from every text an
// engine sees and keeps only where each one sits: marks {at, name, strength}, `at` an offset in the display text of the word the
// tag precedes. Inworld's `inworld-tts-2` takes the same idea as steering: a bracketed instruction in plain English before the words
// it applies to, in force until the next one or [reset]. Both are "a tag stays in force until the next one", so the mapping is
// one to one: each mark becomes one instruction in front of its word.
//
// The instructions follow Inworld's own guidance: English, lower case, no punctuation, one clear instruction per tag, a fuller
// phrase rather than a bare word, and no opposing directions in a row. Nothing else of the text changes.
import {textEmotion} from './text-emotion.mjs';

/** The instruction for each feeling, a subtle one (the default) and a strong one ({anger:strong}). `calm` is a reset. */
export const STEERING = Object.freeze({
  joy: Object.freeze({subtle: 'say with warm amusement', strong: 'say with delighted excitement'}),
  warm: Object.freeze({subtle: 'say warmly and gently', strong: 'say tenderly with deep affection in a soft voice'}),
  interest: Object.freeze({subtle: 'sound curious and engaged', strong: 'sound intensely curious and fascinated'}),
  surprise: Object.freeze({subtle: 'sound surprised', strong: 'sound shocked and astonished'}),
  sadness: Object.freeze({subtle: 'say sadly in a quiet low voice', strong: 'slow and hushed with every word weighted by grief'}),
  fear: Object.freeze({subtle: 'sound worried and tense', strong: 'sound frightened with a shaky breathless voice'}),
  anger: Object.freeze({subtle: 'say with controlled irritation', strong: 'speak as if barely holding back rage forcing every word through gritted teeth'}),
  disgust: Object.freeze({subtle: 'say with scorn and disgust', strong: 'say with open revulsion and contempt'}),
  calm: null,
});

/** The bracketed instruction for a mark, '[reset]' for a calm one, or null for a feeling that is not known. */
export function instructionFor(mark) {
  const name = typeof mark?.name === 'string' ? mark.name : '';
  if (!Object.hasOwn(STEERING, name)) return null;
  const entry = STEERING[name];
  if (!entry) return '[reset]';
  return `[${mark.strength === 'strong' ? entry.strong : entry.subtle}]`;
}

/**
 * Text that Inworld would read as markup is made plain: any square bracket (a leftover voice tag would be taken for an instruction
 * or a sound) and angle brackets (SSML). The display text has no tags in it, so this only changes text a character wrote oddly.
 */
export const plainText = text => String(text ?? '').replace(/[[\]<>]/g, ' ').replace(/\s{2,}/g, ' ').trim();

// Non-verbal sounds. Inworld's inworld-tts-2 renders six bracketed sounds as audio events, not as words (steering page and
// prompting guide, read 2026-10-13): [laugh] [sigh] [clear throat] [breathe] [cough] [yawn]. They do not change the delivery.
// Natural speech writes sounds as our own tags (OmniVoice's list, bridge/natural-speech.mjs, or Inworld's own names when this
// voice speaks): the ones with a match map one to one; a tag with no match (the question and surprise sounds, the displeased
// grunt, the Chinese and Japanese interjections) is not spoken at all.
export const SOUNDS = Object.freeze({laugh: '[laugh]', laughter: '[laugh]', sigh: '[sigh]', breathe: '[breathe]', cough: '[cough]',
  yawn: '[yawn]', 'clear-throat': '[clear throat]'});
/** Inworld's bracketed sound for one of our tag names, or null when there is no match. */
export const soundFor = name => typeof name === 'string' && Object.hasOwn(SOUNDS, name.toLowerCase()) ? SOUNDS[name.toLowerCase()] : null;
// More than this in one request is a runaway (the same limit as OmniVoice's tags).
export const MAX_SOUNDS = 2;

// What the reply's own words say, when the model wrote no feeling tags: the small lexicon the face already uses
// (bridge/text-emotion.mjs; no request, no model, well under a millisecond). Only a clear lexicon feeling counts, never the tone or
// resting-warmth guesses, and a weak one is spoken plainly.
const FALLBACK_NAME = Object.freeze({Joy: 'joy', Trust: 'warm', Interest: 'interest', Surprise: 'surprise', Sadness: 'sadness', Fear: 'fear',
  Anger: 'anger', Disgust: 'disgust'});
/** One mark at the start of `text` for the feeling its words clearly carry, or [] when none does. */
export function fallbackMarks(text) {
  const found = textEmotion(plainText(text));
  const name = found && FALLBACK_NAME[found.emotion];
  return name ? [{at: 0, name, strength: found.scale >= 3 ? 'strong' : 'subtle', source: 'text'}] : [];
}

/**
 * `text` with an instruction in front of each marked word and the sounds in place.
 *   marks:  [{at, name, strength}] in the display text of the whole reply
 *   from:   where `text` starts inside that reply (0 for a whole reply or its first part; the tail of a reply that was voiced in two
 *           parts starts later). The feeling in force at that point is applied at the start, because a new request has no memory.
 *   sounds: [{at, name}] the non-verbal tags the character wrote, `at` an offset in the same display text (a trailing sound is at
 *           the text's end); `soundsFrom` is where `text` starts for them (default `from`)
 * Returns {text, tags, sounds}: the steered text, how many instructions and how many sounds were put in. Without usable marks or
 * sounds the text is returned as is (cleaned of markup), with both 0.
 */
export function steerText(text, marks, {from = 0, sounds, soundsFrom = from} = {}) {
  // Markup is replaced one character for one, so the offsets of the marks stay true.
  const source = String(text ?? '').replace(/[[\]<>]/g, ' ');
  const sorted = Array.isArray(marks) ? marks.filter(mark => mark && Number.isFinite(mark.at) && typeof mark.name === 'string').sort((a, b) => a.at - b.at) : [];
  const local = [];
  let carried = null;
  for (const mark of sorted) {
    const at = mark.at - from;
    if (at <= 0) carried = mark; else if (at < source.length) local.push({...mark, at});
  }
  if (carried && !(local[0]?.at === 0)) local.unshift({...carried, at: 0});
  const events = [];
  let active = false, tags = 0, last = null;
  for (const mark of local) {
    const instruction = instructionFor(mark);
    if (!instruction) continue;
    // A calm mark with nothing in force changes nothing; the same instruction twice in a row is said once.
    if (instruction === '[reset]' && !active) continue;
    if (instruction === last) continue;
    events.push({at: mark.at, order: 0, tag: instruction});
    active = instruction !== '[reset]'; last = instruction; tags++;
  }
  let count = 0, previous = null;
  for (const sound of Array.isArray(sounds) ? [...sounds].sort((a, b) => a.at - b.at) : []) {
    const at = Number.isFinite(sound?.at) ? sound.at - soundsFrom : -1, tag = soundFor(sound?.name);
    if (!tag || at < 0 || at > source.length || tag === previous || count >= MAX_SOUNDS) continue;
    events.push({at, order: 1, tag}); previous = tag; count++;
  }
  if (!events.length) return {text: plainText(source), tags: 0, sounds: 0};
  events.sort((a, b) => a.at - b.at || a.order - b.order);
  let out = '', cursor = 0;
  for (const event of events) {
    const before = source.slice(cursor, event.at);
    // A trailing sound sits after the last word, which has no space of its own after it.
    out += before + (event.at >= source.length && before && !/\s$/.test(before) ? ' ' : '') + event.tag + ' ';
    cursor = event.at;
  }
  out += source.slice(cursor);
  return {text: out.replace(/\s{2,}/g, ' ').trim(), tags, sounds: count};
}
