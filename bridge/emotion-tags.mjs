// Inline emotion tags ("Expressive emotions", Settings > Voices): the one place that knows their syntax.
//
//   {joy}  {warm}  {interest}  {surprise}  {sadness}  {fear}  {anger}  {disgust}  {calm}        a feeling, for the face
//   {anger:strong}                                                                              a real outburst
//
// The character writes a tag right before the words it applies to; the face holds that feeling until the next tag.
// Curly braces are feelings for the face, square brackets ([laughter]) are sounds for OmniVoice: the two syntaxes cannot
// collide (bridge/speech-tags.mjs strips both). Tags are removed from every text a player or an engine sees; what
// stays behind is a list of marks, each with the character offset of the word it precedes in the CLEAN text:
//   tags:  [{at, name, strength: 'subtle'|'strong', intensity: 1|2}]       (the shape bridge/emotion-selector.mjs already takes)
//   spans: [{start, end, emotion, intensity}]   the clean text cut at the tags; a stretch before the first tag has
//          emotion null (nothing was said about it, the text-based picker fills it); {calm} is the explicit resting face.
//
// This module is pure (no I/O, no imports): the grammar, a streaming parser that survives a tag split across chunks, and
// the per-turn instructions. bridge/speech-tags.mjs uses the grammar for its combined pass over both kinds of tag, and a
// test keeps `parseEmotionText` and that pass identical on the same text.

export const EMOTION_NAMES = Object.freeze(['joy', 'warm', 'interest', 'surprise', 'sadness', 'fear', 'anger', 'disgust', 'calm']);

// What a model writes when it forgets the exact word. Anything listed here is still removed from the display text and
// still moves the face; a brace word that is not an emotion ("{choomba}") is ordinary text and stays.
const ALIASES = Object.freeze({
  happy: 'joy', happiness: 'joy', joyful: 'joy', amused: 'joy', amusement: 'joy', excited: 'joy', excitement: 'joy', delighted: 'joy',
  pleased: 'joy', glad: 'joy', proud: 'joy', playful: 'joy', laugh: 'joy', laughing: 'joy', smile: 'joy', smiling: 'joy', relieved: 'joy',
  trust: 'warm', warmth: 'warm', affection: 'warm', affectionate: 'warm', caring: 'warm', kind: 'warm', tender: 'warm', fond: 'warm',
  friendly: 'warm', gentle: 'warm', love: 'warm', flirty: 'warm', flirt: 'warm', flirting: 'warm', soft: 'warm',
  curious: 'interest', curiosity: 'interest', intrigued: 'interest', anticipation: 'interest', alert: 'interest', attentive: 'interest',
  surprised: 'surprise', shock: 'surprise', shocked: 'surprise', startled: 'surprise', astonished: 'surprise', amazed: 'surprise',
  sad: 'sadness', sorrow: 'sadness', grief: 'sadness', grieving: 'sadness', hurt: 'sadness', melancholy: 'sadness', regret: 'sadness',
  lonely: 'sadness', tired: 'sadness', weary: 'sadness',
  afraid: 'fear', scared: 'fear', worried: 'fear', worry: 'fear', anxious: 'fear', nervous: 'fear', concerned: 'fear', tense: 'fear',
  uneasy: 'fear', alarmed: 'fear', frightened: 'fear', terrified: 'fear', panic: 'fear', panicked: 'fear',
  angry: 'anger', mad: 'anger', annoyed: 'anger', irritated: 'anger', frustrated: 'anger', furious: 'anger', rage: 'anger', bitter: 'anger',
  hostile: 'anger', irritation: 'anger',
  disgusted: 'disgust', contempt: 'disgust', scorn: 'disgust', disdain: 'disgust', sarcasm: 'disgust', sarcastic: 'disgust', mocking: 'disgust',
  revulsion: 'disgust', distaste: 'disgust',
  neutral: 'calm', rest: 'calm', flat: 'calm', plain: 'calm', steady: 'calm', composed: 'calm', none: 'calm', normal: 'calm', default: 'calm',
});
const STRONG = new Set(['strong', 'high', 'intense', 'max', 'big', '2', '3']);
const KNOWN = [...EMOTION_NAMES, ...Object.keys(ALIASES)];
const squash = word => String(word).toLowerCase().replace(/[\s_-]+/g, '');

/** A tag's word and optional strength as `{name, strength}` (name one of EMOTION_NAMES), or null when it is not an emotion. */
export function normaliseEmotion(word, qualifier) {
  const key = squash(word);
  const name = EMOTION_NAMES.includes(key) ? key : ALIASES[key];
  if (!name) return null;
  return {name, strength: STRONG.has(squash(qualifier ?? '')) ? 'strong' : 'subtle'};
}

// The tag is written in curly braces. A model that confuses it with the square-bracket voice sounds ([surprise] instead of
// {surprise}) is understood too: a bracketed EMOTION word is a feeling, never a voice sound (the sound tags all differ: [sigh],
// [laughter], [surprise-ah]), so it moves the face instead of being dropped.
const BODY = String.raw`\s*([A-Za-z][A-Za-z _-]{0,23}?)\s*(?::\s*([A-Za-z0-9]{1,8}))?\s*`;
const SOURCE = String.raw`\{${BODY}\}|\[${BODY}\]`;
/** Replaces every emotion tag (known names and aliases only) with `replacer({name, strength}, matchedText)`. */
export const replaceEmotionTags = (text, replacer) => String(text).replace(new RegExp(SOURCE, 'g'),
  (match, word, qualifier, bracketWord, bracketQualifier) => {
    const tag = normaliseEmotion(word ?? bracketWord, qualifier ?? bracketQualifier);
    return tag ? replacer(tag, match) : match;
  });
/** Does the text contain at least one emotion tag? */
export function hasEmotionTag(text) {
  if (typeof text !== 'string' || !/[{[]/.test(text)) return false;
  for (const match of text.matchAll(new RegExp(SOURCE, 'g'))) if (normaliseEmotion(match[1] ?? match[3], match[2] ?? match[4])) return true;
  return false;
}

/**
 * Where a still-unfinished tag starts at the end of a growing text, or -1 when the end holds nothing back. "Well {sad" and
 * "Well [laug" are held until the next chunk completes them; "I {think" cannot become a tag and is released at once.
 */
export function heldFrom(text) {
  const open = Math.max(text.lastIndexOf('{'), text.lastIndexOf('['));
  if (open < 0 || text.length - open > 40) return -1;
  const tail = text.slice(open);
  if (tail[0] === '[') return /^\[[A-Za-z-]*$/.test(tail) ? open : -1;
  const match = /^\{\s*([A-Za-z _-]*?)\s*(?::\s*([A-Za-z0-9]*)\s*)?$/.exec(tail);
  if (!match) return -1;
  const key = squash(match[1]);
  return key === '' || KNOWN.some(word => word.startsWith(key)) ? open : -1;
}

const MARK = '\u0001';
const PUNCTUATION_ONLY = /^[,.;:!?…]+$/;
const CLAUSE_END = /[,.;:!?…]$/;
const DASH_ONLY = /^(?:—|–|--?)$/;

/**
 * The tags of a (growing) reply and the clean text. `final: false` holds back a tag still being written, so a chunk boundary
 * can fall anywhere inside one; `final: true` (the default) drops a dangling fragment such as "{ang". Whitespace is normalised
 * to single spaces; punctuation the model put right after a tag ("Sure {joy}.") belongs to the word before it. Square-bracket
 * voice tags are not touched (bridge/speech-tags.mjs owns them). A tag with no word after it marks nothing.
 */
export function parseEmotionText(raw, {final = true} = {}) {
  const whole = String(raw ?? '').replaceAll(MARK, '');
  const cut = heldFrom(whole);
  // A dangling "[laug" is left to the voice-tag code; only an unfinished brace tag is held or dropped here.
  const hold = cut >= 0 && whole[cut] === '{' ? cut : whole.length;
  const source = whole.slice(0, hold);
  const marked = replaceEmotionTags(source, tag => ` ${MARK}${tag.name}:${tag.strength}${MARK} `);
  const words = [];
  let pending = [];
  for (const token of marked.split(/\s+/)) {
    if (!token) continue;
    if (token.length > 2 && token.startsWith(MARK) && token.endsWith(MARK)) {
      const [name, strength] = token.slice(1, -1).split(':');
      pending.push({name, strength});
      continue;
    }
    if (pending.length) {
      const before = words.at(-1)?.text;
      if (PUNCTUATION_ONLY.test(token)) {
        if (before !== undefined && !CLAUSE_END.test(before)) words.at(-1).text += token;
        continue;
      }
      if (DASH_ONLY.test(token) && (before === undefined || DASH_ONLY.test(before))) continue;
    }
    words.push({text: token, tags: pending}); pending = [];
  }
  const tags = [];
  let at = 0;
  for (const word of words) {
    for (const tag of word.tags) tags.push({at, name: tag.name, strength: tag.strength, intensity: tag.strength === 'strong' ? 2 : 1});
    at += word.text.length + 1;
  }
  const text = words.map(word => word.text).join(' ');
  return {text, tags, spans: emotionSpans(tags, text.length), held: whole.slice(hold), complete: final};
}

/** The clean text cut at the tags (see the top of the file). Two tags before the same word: the later one wins. */
export function emotionSpans(tags, length) {
  if (!Array.isArray(tags) || !(length > 0)) return [];
  const byOffset = new Map();
  for (const tag of tags) {
    if (tag && Number.isInteger(tag.at) && tag.at >= 0 && tag.at < length && EMOTION_NAMES.includes(tag.name)) byOffset.set(tag.at, tag);
  }
  const marks = [...byOffset.values()].sort((a, b) => a.at - b.at);
  const spans = [];
  if (!marks.length || marks[0].at > 0) spans.push({start: 0, end: marks[0]?.at ?? length, emotion: null, intensity: 0});
  marks.forEach((tag, index) => spans.push({start: tag.at, end: marks[index + 1]?.at ?? length, emotion: tag.name,
    intensity: tag.strength === 'strong' || tag.intensity === 2 ? 2 : 1}));
  return spans.filter(span => span.end > span.start);
}

/**
 * Feed the reply as it streams in. `push(chunk)` returns the state after the chunk: `text` (clean text so far, only ever
 * extended), `added` (what this chunk added to it), `tags` and `spans` found so far. `end()` finishes the reply. For any split
 * of a text into chunks, the state after the last chunk equals `parseEmotionText(whole)`.
 */
export class EmotionTagStream {
  constructor() { this.raw = ''; this.shown = ''; }
  push(chunk) { this.raw += String(chunk ?? ''); return this.#state(false); }
  end() { return this.#state(true); }
  #state(final) {
    const parsed = parseEmotionText(this.raw, {final});
    const extended = parsed.text.startsWith(this.shown);
    const added = extended ? parsed.text.slice(this.shown.length) : '';
    this.shown = extended ? parsed.text : this.shown;
    return {text: parsed.text, added, tags: parsed.tags, spans: parsed.spans, held: parsed.held, complete: final};
  }
}

// ---- The per-turn instructions --------------------------------------------------------------------------------------

/**
 * The block for the turns on which a local voice speaks and Expressive emotions is on (bridge/expressive-emotions.mjs gates
 * it; with a Convai voice nothing is sent, because Convai would read the braces aloud). Measured against real Convai
 * characters in docs/EMOTION_TAGS.md.
 */
export const EMOTION_TAG_BLOCK = [
  'Facial emotions are on. Your face is animated from emotion tags you write inline, in curly braces, right before the words',
  'they apply to: {joy} (amused, delighted, proud, playful), {warm} (affection, care, comfort, gentle teasing, flirting),',
  '{interest} (really intrigued, listening hard), {surprise}, {sadness} (grief, regret, weariness), {fear} (worry, alarm),',
  '{anger} (annoyance, irritation, rage, a defensive bite), {disgust} (revulsion, scorn; not mere dryness), {calm} (a flat,',
  'plain, businesslike face). Most lines are neither {disgust} nor {interest}. A tag stays in force until the next one, so it',
  'covers every sentence after it. Begin the reply with ONE tag for the feeling that runs through most of it, and add a second',
  'only where a later sentence clearly turns (a punchline, a softening, a flash of anger): one or two tags, three at most, and',
  'never a short reaction followed by {calm} for the rest ("Scared?" said in annoyance is all {anger}). Be true to who',
  'you are: if you are guarded, dry or controlled, show less. Use :strong (for example {anger:strong}) only for a real outburst.',
  'Example: "{sadness}I am sorry, V. I really am. {warm}But you are not doing this alone." The tags are for the face only: never',
  'mention a feeling because of them, use curly braces for nothing else (square brackets are a different thing), and keep the',
  'same length and content you would give otherwise.',
].join(' ');

/** The block for one turn. `trait` (warm, neutral, dry, cold) is accepted for a later per-character line. */
export function emotionTagsContext({trait: _trait} = {}) { return EMOTION_TAG_BLOCK; }
