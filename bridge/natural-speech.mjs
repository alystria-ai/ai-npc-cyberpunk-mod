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

// A voice tag is one lowercase word (hyphens allowed) in square brackets. Phoneme syntax such as [B EY1 S] has spaces,
// digits or capitals, so it never matches. Matching is case-insensitive so "[Laughter]" is still cleaned up.
const TAG = /\[([a-z]+(?:-[a-z]+)*)\]/gi;
const TAG_PRESENT = /\[[a-z]+(?:-[a-z]+)*\]/i;
// An emotion tag ("Expressive emotions", bridge/expressive-emotions.mjs) is one of a small fixed set in CURLY braces,
// optionally with a strength: {joy}, {anger:strong}. The two syntaxes cannot collide: brackets are sounds for the
// voice, braces are feelings for the face. Only the known names count; any other braces are ordinary text.
export const EMOTION_NAMES = Object.freeze(['joy', 'warm', 'interest', 'surprise', 'sadness', 'fear', 'anger', 'disgust', 'calm']);
const EMOTION = new RegExp(`\\{(${EMOTION_NAMES.join('|')})(?::(strong|subtle))?\\}`, 'gi');
const EMOTION_PRESENT = new RegExp(EMOTION.source, 'i');
const MARK = '\u0001';
const PUNCTUATION_ONLY = /^[,.;:!?…]+$/;
const CLAUSE_END = /[,.;:!?…]$/;
const DASH_ONLY = /^(?:—|–|--?)$/;

export const hasSpeechTags = text => typeof text === 'string' && (TAG_PRESENT.test(text) || EMOTION_PRESENT.test(text));
export const hasEmotionTags = text => typeof text === 'string' && EMOTION_PRESENT.test(text);

/**
 * Words of a reply with the voice tags and emotion tags that precede each word. Whitespace is normalized to single
 * spaces. `marks` are the emotion tags with `at`, the character offset in `display` of the word each one precedes
 * (a tag with no word after it marks nothing and is dropped).
 */
export function parseTagged(text) {
  const words = [];
  let pending = [], pendingEmotions = [];
  const marked = String(text)
    .replace(TAG, (_, name) => ` ${MARK}v:${name.toLowerCase()}${MARK} `)
    .replace(EMOTION, (_, name, strength) => ` ${MARK}e:${name.toLowerCase()}:${strength ? strength.toLowerCase() : ''}${MARK} `);
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
  return {words, tail: pending, marks, display: words.map(word => word.text).join(' ')};
}

/** The text with every tag removed. Text without a tag is returned untouched (same string, same whitespace). */
export function stripSpeechTags(text) {
  return hasSpeechTags(text) ? parseTagged(text).display : text;
}

/** Streaming text for display: tags removed, and a tag still being written ("[laug") held back until it completes. */
export function displayText(text, complete = true) {
  if (typeof text !== 'string') return text;
  const held = complete ? text : text.replace(/\s*[\[{][a-z:-]*$/i, '');
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
// How often and where was measured against the real characters (scripts/Probe-NaturalSpeech.mjs, 20 varied prompts each,
// one Convai session per character). A text that only asks for rarity does not control the rate: with OmniVoice's tag
// list the model answered Judy with a device in 85-95% of replies whatever the wording (about half of them as the
// first word), and Johnny in 45-60%; with the first Pocket wording ("rarely, when in doubt speak plainly") it
// suppressed even the pauses an ordinary reply has (5% against 15% with no instructions). So the FREQUENCY is decided
// by the bridge, which offers the devices on only some turns (OFFER_RATE, below); the model still decides whether
// and which one fits.
const CHOOSE_SHORT = 'Choose by who you are: a fluent, confident speaker rarely pauses like this, a hesitant, warm or '
  + 'emotional one more. When in doubt, use none.';
const WHERE = 'Put it where the feeling lands (after a joke, where you trail off, in the middle of a sentence) and vary '
  + 'where; do not make it a habit to open a reply with one, only do that when the reply itself is the reaction.';

const OMNI_TEXT = 'Natural speech is on, and this reply is a moment where ONE human touch may fit. Your voice engine is '
  + 'OmniVoice, which can voice a few non-verbal sounds written as tags: [laughter], [sigh], [confirmation-en] (a short '
  + 'sound of agreement), [question-en] (a short questioning sound), [surprise-ah] and [surprise-oh] (short sounds of '
  + 'surprise), and [dissatisfaction-hnn] (a displeased grunt). In plain words it can also voice a pause written as "..." '
  + 'or " — ", and a spoken hesitation such as "hm", "uh" or "I mean" if that is how you would really talk. Use at most '
  + 'one in this reply, only if this exact moment and this character would really produce it; if not, use none. Never '
  + 'the same device as in your previous replies, and never on a predictable pattern. ' + WHERE + ' ' + CHOOSE
  + ' Write a tag exactly as shown, in square brackets, as its own word. A tag is a voice sound, not a stage direction: '
  + 'never use asterisks, parentheses or any other bracketed text, and never spell a laugh out as "haha" or "heh". Tags '
  + 'are removed from the subtitles. Keep the same length and content you would give otherwise.';

const POCKET_TEXT = 'Natural speech is on, and this reply is a moment where ONE natural pause may fit. Your voice engine is '
  + 'Pocket TTS, which cannot voice laughs, sighs or other sounds and would read any bracketed tag or spelled-out sound '
  + 'aloud as a word. So never write tags such as [laughter] or [sigh], and no "heh", "haha", "hmm" or "uh". The only '
  + 'device you have is ordinary punctuation: a dash ("—") or an ellipsis ("...") where a real person with your '
  + 'personality would break off a thought, pause to find the words, or trail off; your voice turns it into a real pause. '
  + 'Use at most one in this reply, only if it truly fits this moment and this character; if not, speak plainly. Never '
  + 'the same device as in your previous replies, never on a predictable pattern, and in the middle of a thought where a '
  + 'person would really pause, not as a habit at the start. ' + CHOOSE_SHORT + ' Keep the same length and content you '
  + 'would give otherwise.';

// The share of turns on which the devices are offered, by how expressive the character is (bridge/emotion-analysis.mjs
// traitFor). This is the chance on a turn that is allowed to offer at all: the turn right after an offered one never
// offers, so the share of offered turns comes out lower (about 37% warm, 33% neutral, 26% dry, 13% cold). The model uses
// an offer in about 90% of cases with OmniVoice's tags and about half with Pocket's punctuation. The first tuning
// (.36/.30/.22/.08, October 8) was too quiet: a player chatting for six lines heard nothing.
export const OFFER_RATE = Object.freeze({warm: .6, neutral: .5, dry: .35, cold: .15});
// A warm or neutral character is offered the devices at least once in any PITY_TURNS spoken turns, so a short chat
// always shows the effect (a dry or cold character stays rare on purpose).
export const PITY_TURNS = 4;
const PITY_TRAITS = Object.freeze(['warm', 'neutral']);
const VOICED_SOUNDS = Object.freeze(OMNI_TAGS);

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
  constructor() { this.enabled = false; this.last = new Map(); this.decisions = new Map(); this.offerState = new Map(); }
  update(settings) {
    if (!settings || typeof settings !== 'object') return false;
    const next = settings.naturalSpeech === true;
    const changed = next !== this.enabled;
    this.enabled = next;
    if (!next) { this.last.clear(); this.decisions.clear(); this.offerState.clear(); }
    return changed;
  }
  /**
   * The context block for one turn. `engine` is the voice that will speak it ('omni', 'pocket' or 'convai'); text-only
   * turns (phone chat, silent playback) and automatic reactions get none. The devices are OFFERED on a share of turns
   * (OFFER_RATE[trait]); see `offers` for what blocks an offer. The decision is made once per `turn` (the request id),
   * so a rebuilt context agrees with the one already sent. `random` is injectable for tests.
   */
  contextFor({engine, sessionId, spoken = true, turn, trait = 'neutral', random = Math.random} = {}) {
    if (!this.enabled || !spoken || (engine !== 'omni' && engine !== 'pocket')) return '';
    if (!this.offers(turn, trait, sessionId, random).offered) return '';
    return naturalSpeechContext({engine, recent: this.last.get(sessionId) ?? []});
  }
  /**
   * Whether this turn is one where the devices are offered, as {offered, reason}. The reason is 'rate' (the dice),
   * 'pity' (a warm or neutral character is due), or, when not offered, 'rate' or 'after-device'.
   * Only an OFFERED turn blocks the next offer (never two in a row), or a voiced sound tag in the last reply. The
   * pauses and fillers an ordinary reply has on its own do not block anything. The pity counter forces an offer on the
   * PITY_TURNS-th spoken turn without one (it outranks the sound-tag block, not the offered-turn block, which cannot
   * coincide with it).
   */
  offers(turn, trait, sessionId, random = Math.random) {
    if (turn !== undefined && this.decisions.has(turn)) return this.decisions.get(turn);
    const state = this.offerState.get(sessionId) ?? {offeredLast: false, tagLast: false, since: 0};
    const pity = PITY_TRAITS.includes(trait) && state.since >= PITY_TURNS - 1;
    let decision;
    if (state.offeredLast) decision = {offered: false, reason: 'after-device'};
    else if (pity) decision = {offered: true, reason: 'pity'};
    else if (state.tagLast) decision = {offered: false, reason: 'after-device'};
    else decision = random() < (OFFER_RATE[trait] ?? OFFER_RATE.neutral) ? {offered: true, reason: 'rate'} : {offered: false, reason: 'rate'};
    if (typeof sessionId === 'string' && sessionId) {
      this.offerState.delete(sessionId);
      this.offerState.set(sessionId, {...state, offeredLast: decision.offered, since: decision.offered ? 0 : state.since + 1});
      while (this.offerState.size > 64) this.offerState.delete(this.offerState.keys().next().value);
    }
    if (turn !== undefined) {
      this.decisions.set(turn, decision);
      while (this.decisions.size > 64) this.decisions.delete(this.decisions.keys().next().value);
    }
    return decision;
  }
  /** The reason the devices were or were not offered on a turn already decided ('rate', 'pity', 'after-device'). */
  reasonFor(turn) { return turn === undefined ? undefined : this.decisions.get(turn)?.reason; }
  /** Remembers the devices of a finished reply for its conversation (bounded). */
  record(sessionId, raw) {
    if (!this.enabled || typeof sessionId !== 'string' || !sessionId) return;
    const devices = devicesUsed(raw);
    this.last.delete(sessionId);
    this.last.set(sessionId, devices);
    while (this.last.size > 64) this.last.delete(this.last.keys().next().value);
    // A voiced sound tag blocks the next offer (no sound tag twice in a row).
    const tagLast = devices.some(id => VOICED_SOUNDS.includes(id));
    const state = this.offerState.get(sessionId);
    if (state) state.tagLast = tagLast;
    else if (tagLast) this.offerState.set(sessionId, {offeredLast: false, tagLast, since: 0});
  }
  /**
   * A reply as it comes back from Convai: its display text never carries a tag (subtitles, phone chat, memory,
   * history). The voice-tagged original is kept as `speechText` for an engine that renders tags, and the emotion
   * tags as `emotionMarks` (character offsets in the display text).
   */
  process(result) {
    if (typeof result?.text !== 'string') return result;
    this.record(result.sessionID, result.text);
    // While the setting is on, the devices the reply used travel with it (for the per-turn log line only).
    if (this.enabled) result = {...result, naturalDevices: devicesUsed(result.text)};
    if (!hasSpeechTags(result.text)) return result;
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
}
