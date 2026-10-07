// "Multilingual conversations" (Settings > Conversations, off by default).
//
// On: every conversation goes to the character's multilingual twin, a full clone of its Convai profile that answers
// in whatever language the player uses (docs/MULTILINGUAL_PROFILES.md). Relationship routing still decides ordinary
// or romantic first; the twin of THAT profile is used (bridge/relationship-routing.mjs). A twin is its own
// character for memory: its memories are separate, and Forget clears both (the twin shares the original's family).
//
// The voice is decided per turn, because Pocket TTS speaks English only:
//   - before the send, from the player's message (or, without one, the language of the last exchange): an English
//     turn keeps the chosen voice; a turn expected in another language uses OmniVoice when it can (the selected
//     voice is Omni, or the optional Omni pack is installed and its worker is ready), else the Convai cloud voice
//     (the twins have Azure multilingual voices). That choice also decides whether Natural speech and Expressive
//     emotions instructions are sent: only a local voice gets them, so the cloud voice never reads a tag aloud;
//   - after the reply, from its own text: a local turn whose reply is not English moves to OmniVoice, or is shown
//     as text when no Omni can speak it; an English reply keeps the chosen voice. A cloud-voice turn is already
//     being spoken by Convai, whatever language came back.
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
  /** The language a turn is expected in: its own text when that is clear, else the last exchange's, else English. */
  expected(text) {
    const {language} = detectLanguage(text);
    return language ?? this.lastLanguage ?? 'en';
  }
}

/**
 * The voice for one turn, decided before it is sent.
 *   enabled: the setting; language: the expected language ('en', 'es', ...);
 *   local: {uses, provider} — does the chosen local voice speak this character, and which one ('pocket' | 'omni');
 *   omni: {usable, ready} — can an OmniVoice worker speak this character, and is it loaded now.
 * Returns {engine: 'pocket' | 'omni' | 'convai', language, reason}. Off, it is exactly the voice used before.
 */
export function planTurnVoice({enabled = false, language = 'en', local = {}, omni = {}} = {}) {
  const chosen = local.uses ? local.provider : 'convai';
  if (!enabled) return {engine: chosen, language: null, reason: 'multilingual-off'};
  if (!language || language === 'en') return {engine: chosen, language: 'en', reason: 'english'};
  if (!local.uses) return {engine: 'convai', language, reason: 'cloud-voice'};
  if (local.provider === 'omni') return {engine: 'omni', language, reason: 'omni-selected'};
  if (omni.usable && omni.ready) return {engine: 'omni', language, reason: 'omni-pack'};
  return {engine: 'convai', language, reason: omni.usable ? 'omni-loading' : 'no-omni'};
}

/**
 * The voice for a finished reply of a turn planned with planTurnVoice. A cloud-voice turn stays on Convai. A local
 * turn follows the reply's own language: English keeps the chosen voice, another language needs OmniVoice
 * ('none' when no Omni can speak it now: the reply is shown as text).
 */
export function replyVoice({plan, text, local = {}, omni = {}} = {}) {
  if (!plan || plan.engine === 'convai') return {engine: 'convai', language: plan?.language ?? null};
  if (plan.reason === 'multilingual-off') return {engine: plan.engine, language: null};
  const detected = detectLanguage(text).language;
  // An unclear reply keeps what the turn expected.
  const language = detected ?? plan.language ?? 'en';
  if (language === 'en') return {engine: local.provider === 'omni' ? 'omni' : 'pocket', language: 'en'};
  if (local.provider === 'omni') return {engine: 'omni', language};
  if (omni.usable && omni.ready) return {engine: 'omni', language};
  return {engine: 'none', language, reason: omni.usable ? 'omni-loading' : 'no-omni'};
}
