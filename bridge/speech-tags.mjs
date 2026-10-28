// Voice and emotion tags in a reply.
//
// A reply can carry two kinds of tag: [name] (a sound word for a voice engine) and {emotion} (a feeling for the face; bridge/emotion-tags.mjs
// owns that syntax). Neither is ever shown to the player or stored: every text a player or an engine sees is the display text, with both
// removed. The characters are no longer asked to write [sound] tags (the Natural speech setting was removed 2026-10-28), so a [sound] tag
// is only a stray; the cleaning stays so that one never reaches a subtitle, the phone, memory or a voice.
// Pure functions: no I/O, so it can be tested without the bridge.
import {EMOTION_NAMES, replaceEmotionTags, hasEmotionTag, heldFrom} from './emotion-tags.mjs';

export {EMOTION_NAMES};

// The non-verbal tags OmniVoice renders in English (vendor/reference-omnivoice-training/omnivoice/models/omnivoice.py,
// _NONVERBAL_PATTERN). The listening test found them natural; the other tags in the pattern are for other languages.
export const OMNI_TAGS = Object.freeze(['laughter', 'sigh', 'confirmation-en', 'question-en', 'question-ah', 'question-oh',
  'surprise-ah', 'surprise-oh', 'dissatisfaction-hnn']);
// Four more OmniVoice tags are interjections of Chinese and Japanese (wa, yo, ei, yi). They are kept only on
// a turn whose reply language is Chinese or Japanese; on any other turn they are treated like
// an unknown tag: removed from the display text and never voiced.
export const CJK_TAGS = Object.freeze(['surprise-wa', 'surprise-yo', 'question-ei', 'question-yi']);
export const CJK_LANGUAGES = Object.freeze(['zh', 'ja']);
/** The tags OmniVoice may voice for a reply in `language` (ISO 639-1; undefined or 'en' is English). */
export const omniTagsFor = language => CJK_LANGUAGES.includes(language) ? [...OMNI_TAGS, ...CJK_TAGS] : OMNI_TAGS;

// A voice tag is one lowercase word (hyphens allowed) in square brackets. Phoneme syntax such as [B EY1 S] has spaces,
// digits or capitals, so it never matches. Matching is case-insensitive so "[Laughter]" is still cleaned up.
const TAG = /\[([a-z]+(?:-[a-z]+)*)\]/gi;
const TAG_PRESENT = /\[[a-z]+(?:-[a-z]+)*\]/i;
// An emotion tag ("Expressive emotions"; bridge/emotion-tags.mjs owns its syntax) is a feeling word in CURLY braces, optionally
// with a strength: {joy}, {anger:strong}. The two syntaxes cannot collide: brackets are sounds for the voice, braces are
// feelings for the face. Only emotion words count (the names, and the aliases a model might write instead, such as {angry});
// any other braces are ordinary text.
const MARK = '\u0001';
const PUNCTUATION_ONLY = /^[,.;:!?…]+$/;
const CLAUSE_END = /[,.;:!?…]$/;
const DASH_ONLY = /^(?:—|–|--?)$/;

export const hasSpeechTags = text => typeof text === 'string' && (TAG_PRESENT.test(text) || hasEmotionTag(text));
export const hasEmotionTags = hasEmotionTag;

/**
 * Words of a reply with the voice tags and emotion tags that precede each word. Whitespace is normalized to single
 * spaces. `marks` are the emotion tags with `at`, the character offset in `display` of the word each one precedes
 * (a tag with no word after it marks nothing and is dropped).
 */
export function parseTagged(text) {
  const words = [];
  let pending = [], pendingEmotions = [];
  // Emotion tags first: a bracketed emotion word ([surprise]) is a feeling, not a voice sound (bridge/emotion-tags.mjs).
  const felt = replaceEmotionTags(String(text), tag => ` ${MARK}e:${tag.name}:${tag.strength}${MARK} `);
  const marked = felt.replace(TAG, (_, name) => ` ${MARK}v:${name.toLowerCase()}${MARK} `);
  for (const token of marked.split(/\s+/)) {
    if (!token) continue;
    if (token.startsWith(MARK) && token.endsWith(MARK) && token.length > 2) {
      const [kind, name, strength] = token.slice(1, -1).split(':');
      if (kind === 'v') pending.push(name); else pendingEmotions.push({name, strength: strength || 'subtle'});
      continue;
    }
    // Punctuation the model wrote right after a tag. "Sure [laughter]." leaves a stray full stop: it belongs to the
    // word before the tag. When that word already ends a clause ("Well... [sigh].", "No. [laughter]!"), or there is no
    // word before ("[sigh], fine."), the stray mark is dropped; so is a second dash ("Okay — [laughter] — sure."), so
    // Pocket and the subtitles never get "Well....", ", fine", "No.!" or "— —".
    if (pending.length || pendingEmotions.length) {
      const before = words.at(-1)?.text;
      if (PUNCTUATION_ONLY.test(token)) {
        if (before !== undefined && !CLAUSE_END.test(before)) words.at(-1).text += token;
        continue;
      }
      if (DASH_ONLY.test(token) && (before === undefined || DASH_ONLY.test(before))) continue;
    }
    words.push({text: token, before: pending, emotions: pendingEmotions}); pending = []; pendingEmotions = [];
  }
  const marks = [];
  let at = 0;
  for (const word of words) {
    for (const emotion of word.emotions) marks.push({at, ...emotion});
    at += word.text.length + 1;
  }
  // Where each voice tag (a sound) sits, as `at` in the display text; a trailing one is at the end of the text.
  const display = words.map(word => word.text).join(' '), sounds = [];
  at = 0;
  for (const word of words) {
    for (const name of word.before) sounds.push({at, name});
    at += word.text.length + 1;
  }
  for (const name of pending) sounds.push({at: display.length, name});
  return {words, tail: pending, marks, sounds, display};
}

/** The text with every tag removed. Text without a tag is returned untouched (same string, same whitespace). */
export function stripSpeechTags(text) {
  return hasSpeechTags(text) ? parseTagged(text).display : text;
}

/** Streaming text for display: tags removed, and a tag still being written ("[laug") held back until it completes. */
export function displayText(text, complete = true) {
  if (typeof text !== 'string') return text;
  const cut = complete ? -1 : heldFrom(text);
  return stripSpeechTags(cut >= 0 ? text.slice(0, cut).trimEnd() : text);
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
 * A reply as it comes back from the conversation transport: its display text never carries a tag (subtitles, phone chat,
 * memory, history). The voice-tagged original is kept as `speechText` for an engine that renders tags, and the emotion
 * tags as `emotionMarks` (character offsets in the display text).
 */
export function processReply(result) {
  if (typeof result?.text !== 'string' || !hasSpeechTags(result.text)) return result;
  const parsed = parseTagged(result.text), display = parsed.display;
  // A reply that is only a tag has no text to show; leave it whole rather than send an empty reply on.
  if (!display) return result;
  const out = {...result, text: display};
  // The voice-tagged original, for an engine that renders voice tags (emotion tags never reach a voice).
  const voice = [...parsed.words.flatMap(word => word.before), ...parsed.tail];
  if (voice.length) out.speechText = keepSpeechTags(result.text, voice);
  // Where each emotion tag sits in the display text, for Expressive emotions (which drops them when it is off).
  if (parsed.marks.length) out.emotionMarks = parsed.marks;
  return out;
}
