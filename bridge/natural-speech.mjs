// "Natural speech" (Settings > Voices, off by default).
//
// The bridge never inserts a filler or a tag. When the setting is on, each spoken turn's dynamic context lists the
// expressive devices that the CURRENT voice engine can render, and the character decides, from its own personality,
// whether any fits. Everything else in this file keeps those devices where they belong:
//   - tags are written as [name] words; only OmniVoice renders them, so they are removed from the display text
//     (subtitles, phone chat, memory, history) and from the text of every engine that cannot render them;
//   - a short note of what the previous reply already used is added, so the model does not repeat a device.
// Pure functions plus one small state holder: no I/O, so it can be tested without the bridge.

// The non-verbal tags OmniVoice renders in English (vendor/reference-omnivoice-training/omnivoice/models/omnivoice.py,
// _NONVERBAL_PATTERN). The listening test found them natural; the other tags in the pattern are for other languages.
export const OMNI_TAGS = Object.freeze(['laughter', 'sigh', 'confirmation-en', 'question-en',
  'surprise-ah', 'surprise-oh', 'dissatisfaction-hnn']);
// More than this in one reply is a runaway; the rest are not voiced (they never reach the display text anyway).
export const MAX_VOICED_TAGS = 2;

// A tag is one lowercase word (hyphens allowed) in square brackets. Phoneme syntax such as [B EY1 S] has spaces,
// digits or capitals, so it never matches. Matching is case-insensitive so "[Laughter]" is still cleaned up.
const TAG = /\[([a-z]+(?:-[a-z]+)*)\]/gi;
const TAG_PRESENT = /\[[a-z]+(?:-[a-z]+)*\]/i;
const MARK = '\u0001';
const PUNCTUATION_ONLY = /^[,.;:!?…]+$/;

export const hasSpeechTags = text => typeof text === 'string' && TAG_PRESENT.test(text);

/** Words of a reply with the tags that precede each word. Whitespace is normalized to single spaces. */
export function parseTagged(text) {
  const words = [];
  let pending = [];
  for (const token of String(text).replace(TAG, (_, name) => ` ${MARK}${name.toLowerCase()}${MARK} `).split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith(MARK) && token.endsWith(MARK) && token.length > 2) { pending.push(token.slice(1, -1)); continue; }
    // "[sigh]." leaves a stray full stop: it belongs to the word before the tag.
    if (pending.length && words.length && PUNCTUATION_ONLY.test(token)) { words.at(-1).text += token; continue; }
    words.push({text: token, before: pending}); pending = [];
  }
  return {words, tail: pending, display: words.map(word => word.text).join(' ')};
}

/** The text with every tag removed. Text without a tag is returned untouched (same string, same whitespace). */
export function stripSpeechTags(text) {
  return hasSpeechTags(text) ? parseTagged(text).display : text;
}

/** Streaming text for display: tags removed, and a tag still being written ("[laug") held back until it completes. */
export function displayText(text, complete = true) {
  if (typeof text !== 'string') return text;
  const held = complete ? text : text.replace(/\s*\[[a-z-]*$/i, '');
  return stripSpeechTags(held);
}

/** The text with only the tags in `allowed` kept (the rest removed). For an engine's own last line of defence. */
export function keepSpeechTags(text, allowed = []) {
  if (!hasSpeechTags(text)) return text;
  const tokens = parseTagged(text);
  const keep = name => allowed.includes(name);
  const parts = [];
  for (const word of tokens.words) {
    for (const tag of word.before) if (keep(tag)) parts.push(`[${tag}]`);
    parts.push(word.text);
  }
  for (const tag of tokens.tail) if (keep(tag)) parts.push(`[${tag}]`);
  return parts.join(' ');
}

/**
 * The text of each display phrase as the engine should voice it: the same words, with the allowed tags put back
 * where the model wrote them (a tag belongs to the word after it; a trailing one to the last phrase).
 * `phrases` are the display phrases (the tag-free text, already split); returns undefined when there is nothing to
 * put back or the words do not line up, in which case the display phrases are voiced as they are.
 */
export function speechPhrases(phrases, raw, allowed = OMNI_TAGS, limit = MAX_VOICED_TAGS) {
  if (!Array.isArray(phrases) || !phrases.length || !hasSpeechTags(raw)) return undefined;
  const tokens = parseTagged(raw);
  if (tokens.display !== phrases.join(' ')) return undefined;
  let voiced = 0, previous = null, index = 0, any = false;
  const tags = list => {
    const out = [];
    for (const tag of list) {
      // Unsupported tags, adjacent repeats and runaway counts are dropped, never voiced.
      if (!allowed.includes(tag) || tag === previous || voiced >= limit) continue;
      out.push(`[${tag}]`); previous = tag; voiced++; any = true;
    }
    return out;
  };
  const result = phrases.map((phrase, position) => {
    const parts = [];
    for (let count = phrase.split(' ').length; count > 0; count--) {
      const word = tokens.words[index++];
      parts.push(...tags(word.before), word.text);
      previous = null;
    }
    if (position === phrases.length - 1) parts.push(...tags(tokens.tail));
    return parts.join(' ');
  });
  return any ? result : undefined;
}

// ---- What a reply used, so the next one can avoid repeating it ----------------------------------------------

const FILLER = /(?:^|[\s.,;:!?—-])(?:h+m+|m+h*m+|u+h+|u+m+|erm?|i mean)(?=$|[\s.,;:!?—…-])/i;

/** The devices a reply used: tag names, 'ellipsis', 'dash', 'filler'. */
export function devicesUsed(raw) {
  if (typeof raw !== 'string') return [];
  const found = new Set();
  for (const match of raw.matchAll(TAG)) found.add(match[1].toLowerCase());
  if (/\.{3}|…/.test(raw)) found.add('ellipsis');
  if (/—|–|\s--\s/.test(raw)) found.add('dash');
  if (FILLER.test(raw.replace(TAG, ' '))) found.add('filler');
  return [...found];
}

const DEVICE_NAMES = {
  ellipsis: 'an ellipsis ("...")', dash: 'a dash ("—")',
  filler: 'a spoken filler ("hm", "uh", "I mean")',
};
const deviceName = id => DEVICE_NAMES[id] ?? `[${id}]`;

// ---- The dynamic context ---------------------------------------------------------------------------------------

const CHOOSE = 'Choose by who you are. From your own profile and sample dialogue, work out what a realistic human with '
  + 'this personality would actually do when talking, even if your sample dialogue contains no such sounds. '
  + 'A fluent, confident speaker rarely hesitates; a cold, controlled or formal person rarely laughs or sighs; '
  + 'a nervous, warm or thoughtful person may hesitate, trail off or laugh more. When in doubt, use nothing.';
const SPARING = 'These are optional seasoning, never a requirement: most replies should use none. Use one only when this '
  + 'exact moment and this character would really produce it, rarely, and never on a predictable pattern: not in '
  + 'every reply, not at the start or at any fixed position, and never the same device as in your previous replies.';

const OMNI_TEXT = 'Natural speech is on. Your voice engine is OmniVoice, which can voice a few non-verbal sounds written '
  + 'as tags: [laughter], [sigh], [confirmation-en] (a short sound of agreement), [question-en] (a short questioning '
  + 'sound), [surprise-ah] and [surprise-oh] (short sounds of surprise), and [dissatisfaction-hnn] (a displeased grunt). '
  + 'In plain words it can also '
  + 'voice a pause written as "..." or " — ", and a spoken hesitation such as "hm", "uh" or "I mean" if that is how you '
  + 'would really talk. ' + SPARING + ' ' + CHOOSE + ' Write a tag exactly as shown, in square brackets, as its own '
  + 'word. A tag is a voice sound, not a stage direction: never use asterisks, parentheses or any other bracketed text, '
  + 'and never spell a laugh out as "haha" or "heh". Tags are removed from the subtitles. Keep the same length and '
  + 'content you would give otherwise.';

const POCKET_TEXT = 'Natural speech is on. Your voice engine is Pocket TTS, which cannot voice laughs, sighs or other '
  + 'sounds and would read any bracketed tag or spelled-out sound aloud as a word. So never write tags such as '
  + '[laughter] or [sigh], and no "heh", "haha", "hmm" or "uh". The only devices you have are ordinary punctuation: a '
  + 'dash ("—") or an ellipsis ("...") where a real person with your personality would break off a thought or trail '
  + 'off. Use them rarely, only when the moment fits, never on a predictable pattern, not in every reply and never '
  + 'in the same place as in your previous replies. A fluent, confident speaker rarely does this; a hesitant, '
  + 'thoughtful or emotional one more. When in doubt, speak plainly. Keep the same length and content you would '
  + 'give otherwise.';

/** The per-turn block for the current voice engine ('omni' or 'pocket'); '' for any other engine. */
export function naturalSpeechContext({engine, recent = []} = {}) {
  const base = engine === 'omni' ? OMNI_TEXT : engine === 'pocket' ? POCKET_TEXT : '';
  if (!base) return '';
  const offered = engine === 'omni' ? [...OMNI_TAGS, 'ellipsis', 'dash', 'filler'] : ['ellipsis', 'dash'];
  const used = recent.filter(id => offered.includes(id));
  return used.length
    ? `${base} Your previous reply already used ${used.map(deviceName).join(', ')}: do not use ${used.length > 1 ? 'those' : 'it'} in this reply.`
    : base;
}

/**
 * The setting plus a little per-conversation memory. `enabled` follows runtime/settings.json (a missing or
 * unreadable file leaves it as it was). `process` is applied to every reply that leaves the Convai transport.
 */
export class NaturalSpeech {
  constructor() { this.enabled = false; this.last = new Map(); }
  update(settings) {
    if (!settings || typeof settings !== 'object') return false;
    const next = settings.naturalSpeech === true;
    const changed = next !== this.enabled;
    this.enabled = next;
    if (!next) this.last.clear();
    return changed;
  }
  /**
   * The context block for one turn. `engine` is the voice that will speak it ('omni', 'pocket' or 'convai'); text-only
   * turns (phone chat, silent playback) and automatic reactions get none.
   */
  contextFor({engine, sessionId, spoken = true} = {}) {
    if (!this.enabled || !spoken) return '';
    return naturalSpeechContext({engine, recent: this.last.get(sessionId) ?? []});
  }
  /** Remembers the devices of a finished reply for its conversation (bounded). */
  record(sessionId, raw) {
    if (!this.enabled || typeof sessionId !== 'string' || !sessionId) return;
    this.last.delete(sessionId);
    this.last.set(sessionId, devicesUsed(raw));
    while (this.last.size > 64) this.last.delete(this.last.keys().next().value);
  }
  /**
   * A reply as it comes back from Convai: its display text never carries a tag (subtitles, phone chat, memory,
   * history). The tagged original is kept as `speechText` for an engine that renders tags.
   */
  process(result) {
    if (typeof result?.text !== 'string') return result;
    this.record(result.sessionID, result.text);
    if (!hasSpeechTags(result.text)) return result;
    const display = parseTagged(result.text).display;
    // A reply that is only a tag has no text to show; leave it whole rather than send an empty reply on.
    return display ? {...result, text: display, speechText: result.text} : result;
  }
}
