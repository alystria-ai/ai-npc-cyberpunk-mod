// The "Other language" choice of Settings > Voices (runtime/settings.json `replyLanguage: 'other'` + `replyLanguageOther: <code>`), 2026-10-31.
//
// The Voice language row lists the game's own languages (the mod's interface languages: bridge/multilingual.mjs REPLY_LANGUAGES). A player whose language
// is not among them (a Finnish player, 2026-11-01) picks Other language and then one of the languages below. The language is used for the prompt's
// language instruction (the characters write in it) and for the voice request (OmniVoice is told the language, the Voxtral voice speaks the language of
// the text and picks its reference by the code), and for the microphone's language hint. Only a voice that can speak it does: see `otherLanguageVoice`.
//
// The list is every common language that is not already a Voice language row: Czech, Hungarian and Ukrainian are on that row, so they are not here.
// Names are English (each goes through ui.t in the game, mod/manager-ui.lua REPLY_LANGUAGE_NAMES). Codes are the base codes the rest of the bridge uses.
import {voxtralSpeaks} from './voxtral-languages.mjs';
import {MOD_LANGUAGES} from './speech-language.mjs';

export const OTHER_LANGUAGES = Object.freeze([
  Object.freeze({code: 'fi', name: 'Finnish'}), Object.freeze({code: 'sv', name: 'Swedish'}), Object.freeze({code: 'no', name: 'Norwegian'}),
  Object.freeze({code: 'da', name: 'Danish'}), Object.freeze({code: 'nl', name: 'Dutch'}), Object.freeze({code: 'el', name: 'Greek'}),
  Object.freeze({code: 'ro', name: 'Romanian'}), Object.freeze({code: 'bg', name: 'Bulgarian'}), Object.freeze({code: 'hr', name: 'Croatian'}),
  Object.freeze({code: 'sr', name: 'Serbian'}), Object.freeze({code: 'sk', name: 'Slovak'}), Object.freeze({code: 'sl', name: 'Slovenian'}),
  Object.freeze({code: 'et', name: 'Estonian'}), Object.freeze({code: 'lv', name: 'Latvian'}), Object.freeze({code: 'lt', name: 'Lithuanian'}),
  Object.freeze({code: 'hi', name: 'Hindi'}), Object.freeze({code: 'id', name: 'Indonesian'}), Object.freeze({code: 'vi', name: 'Vietnamese'}),
  Object.freeze({code: 'he', name: 'Hebrew'}),
]);
/** The codes, in the order of the row. mod/manager.lua `otherLanguages` holds the same list (a test compares them). */
export const OTHER_LANGUAGE_CODES = Object.freeze(OTHER_LANGUAGES.map(item => item.code));
export const DEFAULT_OTHER_LANGUAGE = 'fi';
const NAME_OF = new Map(OTHER_LANGUAGES.map(item => [item.code, item.name]));

/** The English name of an Other language code ('fi' -> 'Finnish'), or null for a code that is not in the list. */
export const otherLanguageName = code => NAME_OF.get(code) ?? null;
/** Is `code` one of the Other languages (not a language of the Voice language row)? */
export const isOtherLanguage = code => NAME_OF.has(code);
/** A language the Voice language row does not offer by itself: an Other language, or any other base code that is not a mod language. */
export const isExtraLanguage = code => typeof code === 'string' && code !== '' && code !== 'auto' && !MOD_LANGUAGES.includes(code);

/** The saved `replyLanguageOther` as a code: the list's own codes only, anything else reads as the default. */
export const otherLanguageFrom = value => (typeof value === 'string' && NAME_OF.has(value)) ? value : DEFAULT_OTHER_LANGUAGE;

/**
 * Which voices can speak an Other language, and why the rest cannot.
 *   OmniVoice: told the reply's language by its code; the model covers far more languages than this list (it is the voice that speaks every language).
 *   Voxtral:   the languages Voxtral TTS 3 lists (bridge/voxtral-languages.mjs); Serbian, Estonian, Lithuanian and Hebrew are not among them.
 *   Inworld:   the language list of bridge/inworld-languages.mjs (asked through `speaks`).
 *   Pocket:    English only, plus the installed PocketTTS models of the game's own languages, none of which is an Other language. Never.
 * `local` is the localChoice of bridge/multilingual.mjs planTurnVoice ({uses, provider, cloud, speaks, pocket}). Returns {ok, why}: `why` is one of
 * 'pocket' (English only), 'language' (the cloud voice does not list it) or 'none' (no voice at all).
 */
export function otherLanguageVoice(local, code) {
  if (!local?.uses) return {ok: false, why: 'none'};
  if (local.provider === 'omni') return {ok: true, why: null};
  if ((local.cloud === 'voxtral' || local.cloud === 'inworld')) {
    const speaks = typeof local.speaks === 'function' ? local.speaks(code) === true : (local.cloud === 'voxtral' && voxtralSpeaks(code));
    return speaks ? {ok: true, why: null} : {ok: false, why: 'language'};
  }
  if (local.provider === 'pocket') return {ok: false, why: 'pocket'};
  return {ok: false, why: 'none'};
}

/**
 * The text providers that can write an Other language. Mistral, Google Gemini and the custom endpoint are cloud models that write every language in the list. Local AI
 * is allowed (its model decides how well; the row's help says so). Convai answers through its own characters and its own voice, which cannot be told a language that
 * is not among the game's: the Other language is not applied with it.
 */
export const OTHER_LANGUAGE_PROVIDERS = Object.freeze(['mistral', 'gemini', 'custom', 'local']);
export const textProviderWritesOther = route => OTHER_LANGUAGE_PROVIDERS.includes(route);

/** The one-line reason Pocket refuses an Other language, with the language's name, for the reply's audioError and the log. */
export const pocketRefusal = code => `Pocket speaks English only, so the reply in ${otherLanguageName(code) ?? 'this language'} is shown as text. Choose the Voxtral voice or OmniVoice to hear it.`;
