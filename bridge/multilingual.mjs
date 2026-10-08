// "Multilingual conversations" (Settings > Conversations, off by default).
//
// On: every conversation goes to the character's multilingual twin, a full clone of its Convai profile that answers
// in whatever language the player uses (docs/MULTILINGUAL_PROFILES.md). Relationship routing still decides ordinary
// or romantic first; the twin of THAT profile is used (bridge/relationship-routing.mjs). A twin is its own
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

/**
 * The usable twins from runtime/multilingual-profiles.json, as {providerKey: twinCharacterId}. A twin is used only
 * when it is verified with the language box off and still clones the profile the mod uses today (its recorded
 * original ID equals the current ordinary or romantic ID); anything else stays on its original, listed in `skipped`.
 */
export function multilingualTwins(document, {ordinaryIds = {}, variants = {}} = {}) {
  const twins = {}, skipped = [];
  if (document == null) return {twins, skipped};
  if (!plain(document) || document.version !== 1 || !plain(document.characters)) return {twins, skipped: ['invalid-document']};
  const romanticIds = plain(variants?.characters) ? Object.fromEntries(Object.entries(variants.characters)
    .map(([profile, row]) => [profile + '-romantic', row?.romanticCharacterId])) : {};
  const used = new Set([...Object.values(ordinaryIds), ...Object.values(romanticIds)]);
  for (const [providerKey, row] of Object.entries(document.characters)) {
    const current = Object.hasOwn(ordinaryIds, providerKey) ? ordinaryIds[providerKey]
      : Object.hasOwn(romanticIds, providerKey) ? romanticIds[providerKey] : undefined;
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
  constructor() { this.enabled = false; this.lastLanguage = null; }
  update(settings) {
    if (!settings || typeof settings !== 'object') return false;
    const next = settings.multilingualConversations === true, changed = next !== this.enabled;
    this.enabled = next;
    if (!next) this.lastLanguage = null;
    return changed;
  }
  /** Remember a confidently detected language of player text or a reply. Returns true when it changed. */
  observe(text) {
    if (!this.enabled) return false;
    const {language} = detectLanguage(text);
    if (!language || language === this.lastLanguage) return false;
    this.lastLanguage = language;
    return true;
  }
  /** The reply-language block for a turn (languageContext). */
  contextFor(text) { return languageContext({enabled: this.enabled, text, lastLanguage: this.lastLanguage}); }
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
export function planTurnVoice({enabled = false, language = 'en', local = {}} = {}) {
  const chosen = local.uses ? local.provider : 'convai';
  if (!enabled) return {engine: chosen, language: null, reason: 'multilingual-off'};
  if (!language || language === 'en') return {engine: chosen, language: 'en', reason: 'english'};
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
