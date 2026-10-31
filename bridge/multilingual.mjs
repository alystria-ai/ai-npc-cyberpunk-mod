// Replies follow the player's language, automatically (the Multilingual conversations setting is gone since 2026-10-21), unless the Voice language
// setting (Settings > Voices, `replyLanguage`, 2026-10-23) fixes a language: English is its default, Automatic is the detection described below.
//
// Every turn's text is checked by bridge/reply-language.mjs, once, with no model and no I/O. What that decides:
//   - the reply-language block of the turn's context (textProviderLanguageContext: nothing in an English conversation, so the context is
//     byte-identical to before; the player's language when a message is in another language; English again on a switch back);
//   - the voice of the turn (planTurnVoice, replyVoice): Pocket TTS speaks English only (and the languages whose model and voice pack are installed), so a
//     reply in another language is shown as text rather than handed to a cloud voice; OmniVoice, the Voxtral voice and the Inworld voice speak the languages they list;
//   - on the Convai route, which character answers (wantsTwin): a message that is clearly not English goes to the character's multilingual
//     twin, a full clone of its Convai profile that answers in the player's language (docs/MULTILINGUAL_PROFILES.md); English goes back to
//     the ordinary character. A twin is its own character for Convai memory: its memories are separate, and Forget clears both (the twin
//     shares the original's family). The relationship block (bridge/romance-context.mjs) is added to a twin's turns exactly as to the original's.
// Text providers (Mistral, Local AI, Custom) and add-on speakers have no twins: the context block and the voice plan do the work.
//
// Voices: Pocket TTS speaks English only, unless the optional Pocket model of the reply's language is installed together with that language's voice
// language pack (bridge/pocket-language-models.mjs: French, Italian, German, Spanish, Portuguese, Russian). A turn the cloud voice speaks gets no Natural speech or Expressive emotions instructions (the cloud
// voice would read their tags aloud), OmniVoice is told the reply's language. The Convai voice is only ever the player's own choice: a voice that
// cannot speak a turn (a local one that failed, Pocket in a language other than English, Voxtral or Inworld with no key or in a language it does not list)
// never hands the turn to a cloud voice. That turn is 'none': the reply is shown as written text (owner rule 2026-10-21).
// Pure functions plus one small state holder: no I/O.
import {assessLanguage, detectLanguage, spokenLanguage} from './reply-language.mjs';
import {MOD_LANGUAGES} from './speech-language.mjs';

const plain = value => !!value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const key = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@-]{0,255}$/.test(value);

export const MULTILINGUAL_SUFFIX = '-multilingual';
export const twinProviderKey = providerKey => providerKey + MULTILINGUAL_SUFFIX;
// The ownership marker of a twin is "[CyberpunkConvai profile v2:<providerKey>:multilingual]".
export const twinMarkerKey = providerKey => providerKey + ':multilingual';
// Provider keys of the retired affectionate profiles ("judy-alvarez-romantic" and its twin "judy-alvarez-romantic-multilingual").
// Old files and saved state may still name them; nothing routes to them.
export const RETIRED_PROVIDER_KEY = /-romantic(?:-multilingual)?$/;

/**
 * The usable twins from runtime/multilingual-profiles.json, as {providerKey: twinCharacterId}. A twin is used only
 * when it is verified with the language box off and still clones the profile the mod uses today (its recorded
 * original ID equals the current ordinary ID); anything else stays on its original, listed in `skipped`.
 * Rows of the retired affectionate profiles ("<key>-romantic", which no longer exist as providers) are ignored silently.
 */
export function multilingualTwins(document, {ordinaryIds = {}} = {}) {
  const twins = {}, skipped = [];
  if (document == null) return {twins, skipped};
  if (!plain(document) || document.version !== 1 || !plain(document.characters)) return {twins, skipped: ['invalid-document']};
  const used = new Set(Object.values(ordinaryIds));
  for (const [providerKey, row] of Object.entries(document.characters)) {
    if (RETIRED_PROVIDER_KEY.test(providerKey)) continue;
    const current = Object.hasOwn(ordinaryIds, providerKey) ? ordinaryIds[providerKey] : undefined;
    if (!key(providerKey) || providerKey.endsWith(MULTILINGUAL_SUFFIX) || !plain(row) || !id(row.multilingualCharacterId)
        || row.verified !== true || row.languageBoxOff !== true || current === undefined
        || row.originalCharacterId !== current || used.has(row.multilingualCharacterId)
        || Object.values(twins).includes(row.multilingualCharacterId)) { skipped.push(providerKey); continue; }
    twins[providerKey] = row.multilingualCharacterId;
  }
  return {twins, skipped};
}

// ---- The Reply language setting (Settings, Voices; runtime/settings.json `replyLanguage`) -----------------------------------
/**
 * The choices, in the order of the row: English (the default), Automatic ('auto', the detection below), then the mod's other languages (the
 * interface languages: the ones the multilingual packs, the Pocket language models and the cloud voices speak). mod/manager.lua holds the same list.
 */
export const REPLY_LANGUAGES = Object.freeze(['en', 'auto', ...MOD_LANGUAGES.filter(code => code !== 'en')]);
export const DEFAULT_REPLY_LANGUAGE = 'en';
/**
 * What the saved settings make of it: {setting, fixed}. `setting` is the saved choice (an unknown value reads as English). `fixed` is the
 * language every turn is in, or null when the detection decides. It is a VOICE setting: while Voice playback is off it does nothing and the
 * routing is Automatic, exactly as before the setting existed.
 */
export function replyLanguageFrom(settings) {
  const raw = settings?.replyLanguage;
  const setting = REPLY_LANGUAGES.includes(raw) ? raw : DEFAULT_REPLY_LANGUAGE;
  const voice = settings?.voice !== false;
  return {setting, fixed: voice && setting !== 'auto' ? setting : null};
}

/**
 * The language of the conversation, kept between turns: a fallback for turns without text of their own (a recording, a reaction, one word), and
 * the state of the reply-language detection (Automatic).
 *
 * Automatic is careful (docs/MULTILINGUAL_PROFILES.md, "Reply language"): a text moves the conversation to another language only when
 *   - it is solid evidence (bridge/reply-language.mjs assessLanguage: not a short Latin line, unless the word lists are highly confident AND
 *     the line holds a letter English does not write), and
 *   - it is a long line, or the second solid detection of that language in a row, or it agrees with the prior (the language the player was
 *     heard in before, or the game's own text language: `hint` and `prior`).
 * A short line in Latin letters ("hows biz", "wassup", "yo choom") never moves it.
 * A fixed reply language (`setFixed`, the Reply language setting while Voice playback is on) skips all of it: every turn is in that language.
 */
export class MultilingualConversations {
  constructor() { this.lastLanguage = null; this.pending = null; this.prior = null; this.fixed = null; }
  /** The Reply language setting: a language code, or null for Automatic. Returns true when it changed. */
  setFixed(code) {
    const next = typeof code === 'string' && code && code !== 'auto' ? code : null;
    if (next === this.fixed) return false;
    this.fixed = next; this.pending = null;
    if (next) this.lastLanguage = next;
    return true;
  }
  /** The game's own text language (the menu language), the weakest prior; null when it is not known. */
  setPrior(code) { this.prior = typeof code === 'string' && code ? code : null; }
  /**
   * What a text does to the conversation, without changing anything: {language, detected, commit}.
   *   language: the language this turn is in (the new one when the text moves the conversation, else where it stays; null when nothing is known);
   *   detected: the text had a language of its own (whether or not it was solid);
   *   own:      the turn's language is the text's own (not just where the conversation stays);
   *   commit:   {lastLanguage, pending} to store when the turn is published.
   */
  judge(text, hint = null) {
    const stay = {language: this.lastLanguage ?? hint ?? null, detected: false, own: false, commit: {lastLanguage: this.lastLanguage, pending: this.pending}};
    if (this.fixed) return {...stay, language: this.fixed, own: true, commit: {lastLanguage: this.fixed, pending: null}};
    const found = assessLanguage(text);
    if (!found.language) return stay;
    stay.detected = true;
    const known = this.lastLanguage ?? hint ?? null;
    if (found.language === known) return {...stay, own: true, commit: {lastLanguage: known, pending: null}};
    const expected = hint ?? this.prior;
    const agrees = !!expected && found.language === expected && found.language !== 'en' && found.strength !== 'model' && found.tokens >= 3;
    // A line of three words or more that agrees with the prior (a language the player was heard in, or the game's own) does not have to prove itself twice.
    if (!found.solid && !(agrees && found.short)) return stay;
    const confirmed = found.long || agrees || this.pending?.language === found.language;
    if (!confirmed) return {...stay, commit: {lastLanguage: this.lastLanguage, pending: {language: found.language}}};
    return {language: found.language, detected: true, own: true, commit: {lastLanguage: found.language, pending: null}};
  }
  /** Remember a text of the player (or a reply). Returns true when the conversation's language changed. */
  observe(text, hint = null) {
    const {commit} = this.judge(text, hint);
    const changed = commit.lastLanguage !== this.lastLanguage;
    this.lastLanguage = commit.lastLanguage; this.pending = commit.pending;
    return changed;
  }
  /**
   * A published turn: the player's text decides; the reply counts only when the player's text had no language of its own (a recording, a
   * reaction), so a reply cannot be the second detection of the player's own line.
   */
  observeTurn(playerText, replyText, hint = null) {
    if (this.fixed) return false;
    const mine = this.judge(playerText, hint);
    if (mine.detected) return this.observe(playerText, hint);
    return this.observe(replyText, hint);
  }
  /**
   * The reply-language block for a turn (textProviderLanguageContext). `hint` is a language the player is known to use (the microphone's last
   * recognised language, or the one remembered from an earlier launch): a turn with no text of its own, such as a recording, follows it
   * when the conversation has no language yet.
   */
  contextFor(text, hint = null) {
    if (this.fixed) return textProviderLanguageContext({fixed: this.fixed});
    const {language, own} = this.judge(text, hint);
    return textProviderLanguageContext({text, lastLanguage: this.lastLanguage ?? hint, decided: own ? language : null});
  }
  /** The language a turn is expected in: a fixed choice, else its own text when that is clear enough, else the last exchange's, else English. */
  expected(text) { return this.judge(text).language ?? 'en'; }
  /** The language of one line V types (V's voice, bridge/v-voice.mjs): English unless the line is solidly in another language or a fixed one is chosen. */
  lineLanguage(text) {
    if (this.fixed === 'en') return 'en';
    const own = spokenLanguage(text);
    if (this.fixed) return own === 'en' ? 'en' : this.fixed;
    return own ?? 'en';
  }
  /** Does the Convai route send this turn to the multilingual twin? (wantsTwin) */
  wantsTwin({text, reaction = false, hint = null} = {}) {
    if (this.fixed) return this.fixed !== 'en';
    const held = this.lastLanguage ?? hint;
    if (reaction || typeof text !== 'string' || !text) return !!held && held !== 'en';
    const {language} = this.judge(text, hint);
    return !!language && language !== 'en';
  }
}

/**
 * Which Convai character answers a turn: the multilingual twin (true) or the ordinary character (false). A switch is a different Convai
 * session (a new connection) and a different long-term memory, so it happens only on clear evidence:
 *   - a message clearly in another language goes to the twin;
 *   - a message clearly in English (three words or more) goes to the ordinary character;
 *   - everything else (a recording with no text yet, a reaction, one word, "ok") stays where the conversation is: the twin while it was last in
 *     another language, the ordinary character otherwise. A reaction never starts a twin conversation of its own.
 */
export function wantsTwin({text, reaction = false, lastLanguage = null} = {}) {
  const holds = !!lastLanguage && lastLanguage !== 'en';
  if (reaction || typeof text !== 'string' || !text) return holds;
  const {language, words} = detectLanguage(text);
  if (language && language !== 'en') return true;
  if (language === 'en' && words >= 3) return false;
  return holds;
}

/**
 * The voice for one turn, decided before it is sent.
 *   enabled: the setting; language: the expected language ('en', 'es', ...);
 *   local: {uses, provider, convai, cloud, speaks, pocket} — does the chosen local voice speak this character, and which one ('pocket' | 'omni');
 *          `convai`: the Convai voice may speak this installation's turns (the player chose it, and only then);
 *          `cloud`/`speaks`: the Voxtral voice and the languages its model speaks;
 *          `pocket`: {speaks(language), packMissing(language)} — the PocketTTS models (a model and the voice pack of its language are installed; the model is
 *          there but the pack is not).
 * Returns {engine: 'pocket' | 'omni' | 'convai' | 'none', language, reason}. 'none' is a written reply: no voice speaks the turn. Off, it is exactly
 * the voice used before. A character the chosen voice does not speak (it failed, it has no key, or this character has no clip) is 'none' unless the
 * Convai voice was chosen: a failed voice is never replaced by a cloud voice.
 * While the setting is on, Settings keep the voice on OmniVoice or the cloud voice, so this is a safety net: a turn in
 * another language never reaches Pocket (a fallback or hand-edited setup). A voice that cannot speak the language (Pocket, or Voxtral for a
 * language it does not list) is shown as text, never handed to the Convai voice.
 */
export function planTurnVoice({fixed = false, ...rest} = {}) {
  const plan = planVoice(rest);
  return fixed ? {...plan, fixed: true} : plan;
}
function planVoice({enabled = false, language = 'en', local = {}, textProvider = false} = {}) {
  const chosen = local.uses ? local.provider : local.convai === true ? 'convai' : 'none';
  if (chosen === 'none') return {engine: 'none', language: enabled || textProvider ? (language || 'en') : null, reason: 'local-voice-unavailable', ...(enabled ? {} : textProvider ? {textProvider: true} : {})};
  if (!enabled && !textProvider) return {engine: chosen, language: null, reason: 'multilingual-off'};
  if (!language || language === 'en') return {engine: chosen, language: 'en', reason: 'english', ...(enabled ? {} : {textProvider: true})};
  // The reason a voice that cannot speak this language is kept out of the turn: Pocket is English only (or has no pack for the model it has); the Voxtral voice lists its languages.
  const unsupported = unsupportedReason(local, language);
  // A text provider has no Convai twin and no Convai cloud voice to hand a turn to: OmniVoice speaks another language, and so does the
  // Voxtral voice for the languages it lists; any other voice keeps its place in the plan, so that the finished reply decides (replyVoice):
  // a reply in another language that the voice cannot speak is shown as text.
  if (!enabled) {
    if (local.uses && local.provider === 'omni') return {engine: 'omni', language, reason: 'omni', textProvider: true};
    if (cloudSpeaks(local, language)) return {engine: chosen, language, reason: cloudReason(local), textProvider: true};
    if (pocketSpeaks(local, language)) return {engine: chosen, language, reason: 'pocket-language', textProvider: true};
    return {engine: chosen, language, reason: chosen === 'convai' ? 'cloud-voice' : unsupported, textProvider: true};
  }
  if (local.uses && local.provider === 'omni') return {engine: 'omni', language, reason: 'omni'};
  if (cloudSpeaks(local, language)) return {engine: chosen, language, reason: cloudReason(local)};
  if (pocketSpeaks(local, language)) return {engine: chosen, language, reason: 'pocket-language'};
  // A chosen voice that cannot speak the language (Pocket is English only; the Voxtral voice lists its languages) is not replaced by another one,
  // the Convai voice included: the reply is written. Only a player who chose the Convai voice gets it (and its twin's voice).
  if (local.uses) return {engine: 'none', language, reason: unsupported};
  return {engine: 'convai', language, reason: 'cloud-voice'};
}

/**
 * Does the chosen cloud voice (Voxtral or Inworld) speak `language` for this character? `local.cloud` is 'voxtral' or 'inworld' while that voice is
 * the chosen one and can be asked; `local.speaks(language)` says which languages that voice speaks (Voxtral TTS 3 and the older alias differ,
 * bridge/voxtral-languages.mjs, and Inworld's TTS-2 list is bridge/inworld-languages.mjs). Voxtral's API has no language field: the model speaks the
 * language the text is written in. Inworld's takes a language code, which the voice adds to the request itself (InworldVoice.synthesizeStream).
 */
function cloudSpeaks(local, language) {
  return local?.uses === true && (local.cloud === 'voxtral' || local.cloud === 'inworld') && typeof local.speaks === 'function' && local.speaks(language) === true;
}

/** The plan's reason for a turn the cloud voice speaks: the name of that voice. */
const cloudReason = local => local?.cloud === 'inworld' ? 'inworld' : 'voxtral';

/** Does the local Pocket voice speak `language` for this character: the model of the language and the voice pack it clones from are both installed (and no cloud voice is in the way)? */
function pocketSpeaks(local, language) {
  return local?.uses === true && local.provider === 'pocket' && !local.cloud && typeof local.pocket?.speaks === 'function' && local.pocket.speaks(language) === true;
}

/** Why a voice that cannot speak `language` is kept out of the turn. */
function unsupportedReason(local, language) {
  if (local?.cloud === 'voxtral' || local?.cloud === 'inworld') return 'voice-language-unsupported';
  if (local?.uses === true && local.provider === 'pocket' && typeof local.pocket?.packMissing === 'function' && local.pocket.packMissing(language) === true) return 'pocket-language-pack-missing';
  return 'english-only-voice';
}

/**
 * The voice for a finished reply of a turn planned with planTurnVoice. A written turn ('none') stays written. A turn planned for the Convai voice (the player chose it) stays on Convai. A local
 * turn follows the reply's own language: English keeps the chosen voice; another language needs OmniVoice or the Voxtral voice (for a language
 * it speaks), and a Pocket turn (or a Voxtral turn in a language it does not list) whose reply is not English is shown as text ('none')
 * rather than read by a voice that would garble it.
 */
export function replyVoice({plan, text, local = {}} = {}) {
  if (plan?.engine === 'none') return {engine: 'none', language: plan.language ?? null, reason: plan.reason};
  // No plan is no voice: the Convai voice speaks only a turn that was planned for it (the player chose it).
  if (!plan) return {engine: 'none', language: null, reason: 'local-voice-unavailable'};
  if (plan.engine === 'convai') return {engine: 'convai', language: plan.language ?? null};
  if (plan.reason === 'multilingual-off') return {engine: plan.engine, language: null};
  // Why a reply the chosen voice cannot speak is shown as text.
  const unspoken = (language) => unsupportedReason(local, language);
  // A text provider never changes the chosen voice in an English conversation (a Voxtral player stays on Voxtral, and Pocket still speaks a
  // reply full of the characters' Spanish slang): only a conversation in another language checks the finished reply.
  if (plan.textProvider) {
    const language = (plan.fixed ? null : spokenLanguage(text)) ?? plan.language ?? 'en';
    if (plan.engine === 'omni') return {engine: 'omni', language};
    if (plan.language === 'en') return {engine: plan.engine, language: 'en'};
    if (language === 'en') return {engine: plan.engine, language: 'en'};
    if (cloudSpeaks(local, language)) return {engine: plan.engine, language};
    if (pocketSpeaks(local, language)) return {engine: plan.engine, language};
    return {engine: 'none', language, reason: unspoken(language)};
  }
  const detected = plan.fixed ? null : spokenLanguage(text);
  // An unclear reply (or a short one in Latin letters, which says little) keeps what the turn expected.
  const language = detected ?? plan.language ?? 'en';
  if (local.provider === 'omni') return {engine: 'omni', language};
  if (language === 'en') return {engine: 'pocket', language: 'en'};
  if (cloudSpeaks(local, language)) return {engine: 'pocket', language};
  if (pocketSpeaks(local, language)) return {engine: 'pocket', language};
  return {engine: 'none', language, reason: unspoken(language)};
}

// English names of the languages the detector reports, for the reply-language instruction.
export const LANGUAGE_NAMES = Object.freeze({en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German',
  it: 'Italian', nl: 'Dutch', pl: 'Polish', cs: 'Czech', hu: 'Hungarian', tr: 'Turkish', sv: 'Swedish', ro: 'Romanian', ca: 'Catalan',
  no: 'Norwegian', vi: 'Vietnamese', ja: 'Japanese',
  zh: 'Chinese', ko: 'Korean', ru: 'Russian', uk: 'Ukrainian', el: 'Greek', ar: 'Arabic', he: 'Hebrew', hi: 'Hindi', th: 'Thai'});
const REFERENCE_NOTE = 'Everything else in this context is written in English only as reference notes; it never sets your reply language.';

/**
 * The reply-language block of a turn's dynamic context, last in the context.
 * The twins answer in the player's language on their own, but the mod's dynamic context (relationship, knowledge,
 * Natural speech and Expressive emotions notes) is English, and with it a short message such as "hola, cómo estás" was
 * answered in English in game (2026-10-08). Naming the language of the player's message fixes that. A turn without
 * player text (a reaction, the microphone placeholder) follows the language the conversation was last in.
 */
export function languageContext({text, lastLanguage = null, language = detectLanguage(text).language} = {}) {
  if (language) {
    const name = LANGUAGE_NAMES[language] ?? 'that language';
    return `Language: answer in the language of the player's latest message, which is ${name}. ${REFERENCE_NOTE} `
      + `Keep your own personality, slang and names, and write the whole reply in ${name}.`;
  }
  const previous = lastLanguage && LANGUAGE_NAMES[lastLanguage];
  return `Language: answer in the language the player is using with you${previous ? ` (so far ${previous})` : ''}. ${REFERENCE_NOTE}`;
}

/**
 * The reply-language block on a text provider (Mistral, Local AI, Custom): the same wording as languageContext, but only when it
 * changes something, so an English conversation sends exactly the context it always did.
 *   the player's message is in another language: that language is named;
 *   it is English while the conversation was last in another language: English is named (the switch back);
 *   it has no clear language (a recording, a reaction, one word) and the conversation is in another language: that language is kept;
 *   otherwise nothing.
 */
export function textProviderLanguageContext({text, lastLanguage = null, fixed = null, decided} = {}) {
  // A fixed reply language (Settings > Voices > Reply language): named on every turn, English excepted (an English conversation sends the
  // context it always did).
  if (fixed) return fixed === 'en' ? '' : fixedLanguageContext(fixed);
  // `decided`: the language the conversation's rules settled on for this turn (MultilingualConversations.judge; null: none), which a short line does not move.
  const language = decided !== undefined ? decided : detectLanguage(text).language;
  if (language) {
    if (language === 'en' && (!lastLanguage || lastLanguage === 'en')) return '';
    return languageContext({language, lastLanguage});
  }
  if (!lastLanguage || lastLanguage === 'en') return '';
  return languageContext({language: null, lastLanguage});
}

/** The reply-language block of a fixed reply language: the player's chosen language, whatever they write. */
export function fixedLanguageContext(code) {
  const name = LANGUAGE_NAMES[code] ?? 'that language';
  return `Language: write the whole reply in ${name}, whatever language the player's message is in. ${REFERENCE_NOTE} Keep your own personality, slang and names.`;
}

/**
 * The one-time note for a text provider's reply that the chosen voice cannot speak (Pocket speaks English only, and Voxtral only the languages it lists): `note()` when such a
 * reply is shown as text, `take()` when the next reply is written (it returns the game's notice id once per game session, then nothing).
 */
export class VoiceLanguageNotice {
  constructor() { this.pending = false; this.sent = false; }
  note() { if (!this.sent) this.pending = true; }
  take() {
    if (!this.pending) return undefined;
    this.pending = false; this.sent = true;
    return 'voice-language';
  }
}
