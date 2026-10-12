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

/**
 * `text` with an instruction in front of each marked word.
 *   marks: [{at, name, strength}] in the display text of the whole reply
 *   from:  where `text` starts inside that reply (0 for a whole reply or its first part; the tail of a reply that was voiced in two
 *          parts starts later). The feeling in force at that point is applied at the start, because a new request has no memory.
 * Returns {text, tags}: the steered text and how many instructions were put in. Without usable marks the text is returned as is
 * (cleaned of markup), with tags 0.
 */
export function steerText(text, marks, {from = 0} = {}) {
  // Markup is replaced one character for one, so the offsets of the marks stay true.
  const source = String(text ?? '').replace(/[[\]<>]/g, ' ');
  if (!Array.isArray(marks) || !marks.length) return {text: plainText(source), tags: 0};
  const sorted = marks.filter(mark => mark && Number.isFinite(mark.at) && typeof mark.name === 'string').sort((a, b) => a.at - b.at);
  const local = [];
  let carried = null;
  for (const mark of sorted) {
    const at = mark.at - from;
    if (at <= 0) carried = mark; else if (at < source.length) local.push({...mark, at});
  }
  if (carried && !(local[0]?.at === 0)) local.unshift({...carried, at: 0});
  let out = '', cursor = 0, active = false, tags = 0, last = null;
  for (const mark of local) {
    const instruction = instructionFor(mark);
    if (!instruction) continue;
    // A calm mark with nothing in force changes nothing; the same instruction twice in a row is said once.
    if (instruction === '[reset]' && !active) continue;
    if (instruction === last) continue;
    out += source.slice(cursor, mark.at) + instruction + ' ';
    cursor = mark.at; active = instruction !== '[reset]'; last = instruction; tags++;
  }
  out += source.slice(cursor);
  return tags ? {text: out.replace(/\s{2,}/g, ' ').trim(), tags} : {text: plainText(source), tags: 0};
}
