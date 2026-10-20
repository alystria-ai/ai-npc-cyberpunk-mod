// "Multilingual conversations" (Settings > Conversations, off by default).
//
// On: every conversation goes to the character's multilingual twin, a full clone of its Convai profile that answers
// in whatever language the player uses (docs/MULTILINGUAL_PROFILES.md). The relationship block (bridge/romance-context.mjs)
// is added to the twin's turns exactly as to the original's (bridge/relationship-routing.mjs). A twin is its own
// character for memory: its memories are separate, and Forget clears both (the twin shares the original's family).
//
// Voices: Pocket TTS speaks only English, so turning the setting on moves Companion voices to OmniVoice (the optional
// pack) or the Convai cloud voice (mod/manager.lua); the twins have Azure multilingual cloud voices. The voice of each
// turn is still planned here as a safety net: a turn the cloud voice speaks gets no Natural speech or Expressive
// emotions instructions (the cloud voice would read their tags aloud), OmniVoice is told the reply's language, and a
// reply in another language never reaches Pocket.
// Pure functions plus one small state holder: no I/O.
import {detectLanguage} from './reply-language.mjs';

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

/** The setting, plus the language the conversation was last in (a fallback for turns without player text). */
export class MultilingualConversations {
  // `textProvider`: a text provider (Mistral, Local AI, Custom) answers the turns. The twins stay off there (`enabled` is false), but the
  // reply language, the language note and the voice plan still follow the player's language (languageContext, planTurnVoice).
  constructor() { this.enabled = false; this.textProvider = false; this.lastLanguage = null; }
  /** True while turns are language aware: the Convai twins are on, or a text provider answers. */
  get aware() { return this.enabled || this.textProvider; }
  update(settings) {
    if (!settings || typeof settings !== 'object') return false;
    const next = settings.multilingualConversations === true, changed = next !== this.enabled;
    this.enabled = next;
    if (!this.aware) this.lastLanguage = null;
    return changed;
  }
  /** The provider answering turns is a text provider (or not). Returns true when that changed. */
  setTextProvider(active) {
    const next = active === true, changed = next !== this.textProvider;
    this.textProvider = next;
    if (!this.aware) this.lastLanguage = null;
    return changed;
  }
  /** Remember a confidently detected language of player text or a reply. Returns true when it changed. */
  observe(text) {
    if (!this.aware) return false;
    const {language} = detectLanguage(text);
    if (!language || language === this.lastLanguage) return false;
    this.lastLanguage = language;
    return true;
  }
  /**
   * The reply-language block for a turn (languageContext). `hint` is a language the player is known to use (the microphone's last
   * recognised language, or the one remembered from an earlier launch): a turn with no text of its own, such as a recording, follows it
   * when the conversation has no language yet. Only used on a text provider.
   */
  contextFor(text, hint = null) {
    if (this.enabled) return languageContext({enabled: true, text, lastLanguage: this.lastLanguage});
    return this.textProvider ? textProviderLanguageContext({text, lastLanguage: this.lastLanguage ?? hint}) : '';
  }
  /** The language a turn is expected in: its own text when that is clear, else the last exchange's, else English. */
  expected(text) {
    const {language} = detectLanguage(text);
    return language ?? this.lastLanguage ?? 'en';
  }
}

/**
 * The voice for one turn, decided before it is sent.
 *   enabled: the setting; language: the expected language ('en', 'es', ...);
 *   local: {uses, provider} — does the chosen local voice speak this character, and which one ('pocket' | 'omni').
 * Returns {engine: 'pocket' | 'omni' | 'convai', language, reason}. Off, it is exactly the voice used before.
 * While the setting is on, Settings keep the voice on OmniVoice or the cloud voice, so this is a safety net: a turn in
 * another language never reaches Pocket (a fallback or hand-edited setup), and goes to the cloud voice instead.
 */
export function planTurnVoice({enabled = false, language = 'en', local = {}, textProvider = false} = {}) {
  const chosen = local.uses ? local.provider : 'convai';
  if (!enabled && !textProvider) return {engine: chosen, language: null, reason: 'multilingual-off'};
  if (!language || language === 'en') return {engine: chosen, language: 'en', reason: 'english'};
  // A text provider has no Convai twin and no Convai cloud voice to hand a turn to: OmniVoice speaks another language, and an English-only
  // voice keeps its place in the plan, so that the finished reply decides (replyVoice): a reply in another language is shown as text.
  if (!enabled) return local.uses && local.provider === 'omni' ? {engine: 'omni', language, reason: 'omni'}
    : {engine: chosen, language, reason: chosen === 'convai' ? 'cloud-voice' : 'english-only-voice'};
  if (local.uses && local.provider === 'omni') return {engine: 'omni', language, reason: 'omni'};
  return {engine: 'convai', language, reason: local.uses ? 'english-only-voice' : 'cloud-voice'};
}

/**
 * The voice for a finished reply of a turn planned with planTurnVoice. A cloud-voice turn stays on Convai. A local
 * turn follows the reply's own language: English keeps the chosen voice; another language needs OmniVoice, and a
 * Pocket turn whose reply is not English is shown as text ('none') rather than read by an English-only voice.
 */
export function replyVoice({plan, text, local = {}} = {}) {
  if (!plan || plan.engine === 'convai') return {engine: 'convai', language: plan?.language ?? null};
  if (plan.reason === 'multilingual-off') return {engine: plan.engine, language: null};
  const detected = detectLanguage(text).language;
  // An unclear reply keeps what the turn expected.
  const language = detected ?? plan.language ?? 'en';
  if (local.provider === 'omni') return {engine: 'omni', language};
  if (language === 'en') return {engine: 'pocket', language: 'en'};
  return {engine: 'none', language, reason: 'english-only-voice'};
}

// English names of the languages the detector reports, for the reply-language instruction.
export const LANGUAGE_NAMES = Object.freeze({en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German',
  it: 'Italian', nl: 'Dutch', pl: 'Polish', cs: 'Czech', hu: 'Hungarian', tr: 'Turkish', sv: 'Swedish', ja: 'Japanese',
  zh: 'Chinese', ko: 'Korean', ru: 'Russian', uk: 'Ukrainian', el: 'Greek', ar: 'Arabic', he: 'Hebrew', hi: 'Hindi', th: 'Thai'});
const REFERENCE_NOTE = 'Everything else in this context is written in English only as reference notes; it never sets your reply language.';

/**
 * The reply-language block of a turn's dynamic context, last in the context (Multilingual conversations on only).
 * The twins answer in the player's language on their own, but the mod's dynamic context (relationship, knowledge,
 * Natural speech and Expressive emotions notes) is English, and with it a short message such as "hola, cómo estás" was
 * answered in English in game (2026-10-08). Naming the language of the player's message fixes that. A turn without
 * player text (a reaction, the microphone placeholder) follows the language the conversation was last in.
 */
export function languageContext({enabled = false, text, lastLanguage = null} = {}) {
  if (!enabled) return '';
  const language = detectLanguage(text).language;
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
export function textProviderLanguageContext({text, lastLanguage = null} = {}) {
  const language = detectLanguage(text).language;
  if (language) {
    if (language === 'en' && (!lastLanguage || lastLanguage === 'en')) return '';
    return languageContext({enabled: true, text, lastLanguage});
  }
  if (!lastLanguage || lastLanguage === 'en') return '';
  return languageContext({enabled: true, text, lastLanguage});
}

/**
 * The one-time note for a text provider's reply that the chosen voice cannot speak (Pocket and Voxtral speak English only): `note()` when such a
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
