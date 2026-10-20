// "Natural speech" (Settings > Voices, off by default).
//
// The bridge never inserts a filler or a tag. When the setting is on, each spoken turn's dynamic context lists the
// expressive devices that the CURRENT voice engine can render, and the character decides, from its own personality,
// whether any fits. Everything else in this file keeps those devices where they belong:
//   - tags are written as [name] words; only OmniVoice renders them, so they are removed from the display text
//     (subtitles, phone chat, memory, history) and from the text of every engine that cannot render them;
//   - a short note of what the previous reply already used is added, so the model does not repeat a device.
// Pure functions plus one small state holder: no I/O, so it can be tested without the bridge.
import {talkLine} from './natural-speech-talk.mjs';
import {EMOTION_NAMES, replaceEmotionTags, hasEmotionTag, heldFrom} from './emotion-tags.mjs';

export {EMOTION_NAMES};

// The non-verbal tags OmniVoice renders in English (vendor/reference-omnivoice-training/omnivoice/models/omnivoice.py,
// _NONVERBAL_PATTERN). The listening test found them natural; the other tags in the pattern are for other languages.
export const OMNI_TAGS = Object.freeze(['laughter', 'sigh', 'confirmation-en', 'question-en', 'question-ah', 'question-oh',
  'surprise-ah', 'surprise-oh', 'dissatisfaction-hnn']);
// Four more OmniVoice tags are interjections of Chinese and Japanese (wa, yo, ei, yi). They are offered, and voiced, only on
// a turn whose reply language is Chinese or Japanese (Multilingual conversations); on any other turn they are treated like
// an unknown tag: removed from the display text and never voiced.
export const CJK_TAGS = Object.freeze(['surprise-wa', 'surprise-yo', 'question-ei', 'question-yi']);
export const CJK_LANGUAGES = Object.freeze(['zh', 'ja']);
/** The tags OmniVoice may voice for a reply in `language` (ISO 639-1; undefined or 'en' is English). */
export const omniTagsFor = language => CJK_LANGUAGES.includes(language) ? [...OMNI_TAGS, ...CJK_TAGS] : OMNI_TAGS;
// More than this in one reply is a runaway; the rest are not voiced (they never reach the display text anyway).
export const MAX_VOICED_TAGS = 2;

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

/** True when a voice tag sits INSIDE a word ("Wel[sigh]l"): letters directly on both sides. A tag is always its own word. */
export const splitsWord = text => typeof text === 'string' && /\p{L}\[[a-z]+(?:-[a-z]+)*\]\p{L}/iu.test(text);

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
  + 'your personality would actually do when talking, even if your sample dialogue contains no such sounds. '
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
const WHERE = 'Put it where a real person would make that sound, and vary where from reply to reply: sometimes before a '
  + 'sentence, sometimes right after one ends, and quite often in the middle of a sentence at a natural break (after a '
  + 'comma, between two clauses, before "but" or "and"), for example "I told him no, [laughter] and he still showed up." '
  + 'Do not always put it between two sentences. Never split a tight phrase, such as between an adjective and its noun, '
  + 'inside a name, or between a verb and its object. Put it where the feeling lands; do not make it a habit to open a reply '
  + 'with one, only do that when the reply itself is the reaction. Vary what you reach for as well: not every touch is a '
  + 'trailing "..."; a sound, a dash, a hesitation or a plain reply are all natural, and never more than one "..." in a reply.';

// The OmniVoice block, built from parts so the per-character line and the Chinese/Japanese sounds can be added on the
// turns they apply to (and only those): tags, [CJK tags], pauses, [how this character talks], the rules.
// Where a sound goes is decided per offered turn by the dice, like the rate: asked only to "vary where", the model put every
// sound between two sentences (0 of 17 in the middle of a sentence, docs/NATURAL_SPEECH_BLOCK_V3.md). The model still
// decides whether a sound fits and which; if the chosen spot does not suit the reply it takes the nearest that does.
export const PLACES = Object.freeze({
  mid: 'in the middle of a sentence, at a natural break (after a comma, between two clauses, before "but" or "and")',
  between: 'between two sentences, right after one ends',
  end: 'right after the last sentence of the reply',
  start: 'before the first sentence of the reply, as a reaction',
});
const PLACE_WEIGHTS = Object.freeze({mid: .4, between: .35, end: .15, start: .1});
const pickPlace = random => {
  let roll = random(), last = 'mid';
  for (const [place, weight] of Object.entries(PLACE_WEIGHTS)) { last = place; if ((roll -= weight) < 0) return place; }
  return last;
};
const placeText = place => PLACES[place] ? `For this reply, if you use a sound, place it exactly here: ${PLACES[place]}. Write the sentence so the sound sits there naturally.` : '';
const OMNI_TAGS_TEXT = 'Natural speech is on, and this reply is a moment where ONE human touch may fit. Your voice engine is '
  + 'OmniVoice, which can voice a few non-verbal sounds written as tags: [laughter], [sigh], [confirmation-en] (a short '
  + 'sound of agreement), [question-en] (a short questioning sound), [question-ah] and [question-oh] (a short, rising "ah?" '
  + 'or "oh?" of doubt or curiosity), [surprise-ah] and [surprise-oh] (short sounds of surprise), and [dissatisfaction-hnn] '
  + '(a displeased grunt).';
const CJK_TAGS_TEXT = 'Because this reply is in Chinese or Japanese you also have [surprise-wa] (a "wa!" of surprise, like 哇 or わあ), '
  + '[surprise-yo] (a "yo!" of surprise, like 哟), [question-ei] (an "ei?" of puzzlement, like 诶 or えっ) and [question-yi] '
  + '(a "yi?" of puzzlement, like 咦). They are as natural in this language as the others, so reach for one of them when the '
  + 'moment is a surprise or a puzzled question.';
const OMNI_PAUSES_TEXT = 'In plain words it can also voice a pause written as "..." or " — ", and a spoken hesitation such as '
  + '"hm", "uh" or "I mean" if that is how you would really talk.';
const OMNI_RULES_TEXT = 'Use at most one in this reply, only if this exact moment and your personality would really produce it; '
  + 'if not, use none. Never the same device as in your previous replies, and never on a predictable pattern. ' + WHERE + ' '
  + CHOOSE + ' Write a tag exactly as shown, in square brackets, as its own word. A tag is a voice sound, not a stage '
  + 'direction: never use asterisks, parentheses or any other bracketed text, and never spell a laugh out as "haha" or "heh". '
  + 'Tags are removed from the subtitles. Keep the same length and content you would give otherwise.';

const POCKET_TEXT = 'Natural speech is on, and this reply is a moment where ONE natural pause may fit. Your voice engine is '
  + 'Pocket TTS, which cannot voice laughs, sighs or other sounds and would read any bracketed tag or spelled-out sound '
  + 'aloud as a word. So never write tags such as [laughter] or [sigh], and no "heh", "haha", "hmm" or "uh". The only '
  + 'device you have is ordinary punctuation: a dash ("—") or an ellipsis ("...") where a real person with your '
  + 'personality would break off a thought, pause to find the words, or trail off; your voice turns it into a real pause. '
  + 'Use at most one in this reply, only if it truly fits this moment and your personality; if not, speak plainly. Never '
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
// A few characters sit away from what their trait alone gives (measured with scripts/Probe-NaturalSpeech.mjs, 40 lines each).
// An entry here replaces the trait's rate for that profile only; the pity counter still follows the trait.
export const OFFER_RATE_BY_PROFILE = Object.freeze({'judy-alvarez': .5, 'panam-palmer': .35, 'johnny-silverhand': .42});
const offerRate = (trait, profile) => OFFER_RATE_BY_PROFILE[profile] ?? OFFER_RATE[trait] ?? OFFER_RATE.neutral;
const PITY_TRAITS = Object.freeze(['warm', 'neutral']);
const VOICED_SOUNDS = Object.freeze([...OMNI_TAGS, ...CJK_TAGS, 'cough', 'yawn', 'clear-throat']);

/**
 * The per-turn block for the current voice engine ('omni' or 'pocket'); '' for any other engine.
 * `profile`/`name`/`trait` add the character's own "how they talk" line (OmniVoice only); `language` adds the Chinese and
 * Japanese sounds for a reply in one of those languages. Without them the text is the plain English block.
 */
export function naturalSpeechContext({engine, recent = [], profile, name, trait, language, place} = {}) {
  const cjk = engine === 'omni' && CJK_LANGUAGES.includes(language);
  const base = engine === 'omni'
    ? [OMNI_TAGS_TEXT, cjk ? CJK_TAGS_TEXT : '', OMNI_PAUSES_TEXT, talkLine({profile, name, trait}), OMNI_RULES_TEXT, placeText(place)].filter(Boolean).join(' ')
    : engine === 'pocket' ? POCKET_TEXT : '';
  if (!base) return '';
  const offered = engine === 'omni' ? [...omniTagsFor(cjk ? language : undefined), 'ellipsis', 'dash', 'filler']
    : ['ellipsis', 'dash'];
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
  contextFor({engine, sessionId, spoken = true, turn, trait = 'neutral', profile, name, language, random = Math.random} = {}) {
    if (!this.enabled || !spoken || (engine !== 'omni' && engine !== 'pocket')) return '';
    const decision = this.offers(turn, trait, sessionId, random, profile);
    if (!decision.offered) return '';
    return naturalSpeechContext({engine, recent: this.last.get(sessionId) ?? [], profile, name, trait, language, place: decision.place});
  }
  /**
   * Whether this turn is one where the devices are offered, as {offered, reason}. The reason is 'rate' (the dice),
   * 'pity' (a warm or neutral character is due), or, when not offered, 'rate' or 'after-device'.
   * Only an OFFERED turn blocks the next offer (never two in a row), or a voiced sound tag in the last reply. The
   * pauses and fillers an ordinary reply has on its own do not block anything. The pity counter forces an offer on the
   * PITY_TURNS-th spoken turn without one (it outranks the sound-tag block, not the offered-turn block, which cannot
   * coincide with it).
   */
  offers(turn, trait, sessionId, random = Math.random, profile) {
    if (turn !== undefined && this.decisions.has(turn)) return this.decisions.get(turn);
    const state = this.offerState.get(sessionId) ?? {offeredLast: false, tagLast: false, since: 0};
    const pity = PITY_TRAITS.includes(trait) && state.since >= PITY_TURNS - 1;
    let decision;
    if (state.offeredLast) decision = {offered: false, reason: 'after-device'};
    else if (pity) decision = {offered: true, reason: 'pity'};
    else if (state.tagLast) decision = {offered: false, reason: 'after-device'};
    else decision = random() < offerRate(trait, profile) ? {offered: true, reason: 'rate'} : {offered: false, reason: 'rate'};
    if (decision.offered) decision = {...decision, place: pickPlace(random)};
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
    // Where each sound sits, for a voice that renders sounds in the text it is given.
    // Only while Natural speech is on, like the OmniVoice tags.
    if (this.enabled && parsed.sounds.length) out.voiceMarks = parsed.sounds;
    return out;
  }
}
