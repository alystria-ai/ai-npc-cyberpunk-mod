// Which languages the Inworld cloud voice speaks, and the tag the speech request carries for them (docs/INWORLD.md, "Languages").
//
// Pure data and two small functions, shared by the voice routing (bridge/multilingual.mjs) and the voice itself (bridge/inworld-voice.mjs).
// Facts (docs.inworld.ai/tts/capabilities/multilingual and the Synthesize Speech reference, read 2026-10-31):
//  - Realtime TTS-2 and TTS-2 Flash (`inworld-tts-2-flash`, the model the mod asks) share one language list: 15 Tier 1 languages (the most
//    evaluated) and 79 Tier 2 languages (fully supported), listed below. Tier 3 (376 languages) is best effort, unevaluated and has no text
//    normalisation, so it is not listed: a reply in a Tier 3 language stays written text.
//  - The speech request takes a `language` field, a BCP-47 tag. A short code resolves to its default locale ('es' is 'es-ES'). Left out, the
//    model detects the language from the text and uses the voice's original prompt. An unknown code is a 400.
//  - A voice cloned in English speaks the other languages without another clone ("a voice gives its best speaker similarity in the language it
//    was cloned in", but no separate clone per language is required), so the mod keeps its one English-cloned voice per character.
// The codes are the base codes the reply-language detector reports (bridge/reply-language.mjs).
export const INWORLD_TIER1_LANGUAGES = Object.freeze(['ar', 'zh', 'nl', 'en', 'fr', 'de', 'he', 'hi', 'it', 'ja', 'ko', 'pl', 'pt', 'ru', 'es']);
export const INWORLD_TIER2_LANGUAGES = Object.freeze(['af', 'sq', 'am', 'hy', 'as', 'az', 'eu', 'be', 'bn', 'bg', 'my', 'yue', 'ca', 'ceb', 'hr', 'cs',
  'da', 'ydd', 'arz', 'et', 'fil', 'fi', 'gl', 'gbm', 'ka', 'el', 'gu', 'afb', 'ht', 'acw', 'hu', 'is', 'id', 'jv', 'kn', 'kk', 'kok', 'lo', 'lv', 'ayl',
  'lt', 'lb', 'mk', 'mai', 'mg', 'ms', 'ml', 'mr', 'mn', 'ars', 'ne', 'uzn', 'nb', 'nn', 'or', 'acx', 'ps', 'fa', 'pms', 'pa', 'ro', 'sr', 'sd', 'si',
  'sk', 'sl', 'sw', 'sv', 'ta', 'te', 'th', 'aeb', 'tr', 'uk', 'ur', 'uz', 'vi', 'vro', 'cy']);
export const INWORLD_LANGUAGES = Object.freeze([...INWORLD_TIER1_LANGUAGES, ...INWORLD_TIER2_LANGUAGES]);

// The mod's code for a language where Inworld writes it differently: the detector's 'no' (Norwegian) is Bokmal ('nb') for Inworld.
const INWORLD_CODE = Object.freeze({no: 'nb'});
const SUPPORTED = new Set(INWORLD_LANGUAGES);

/** The code Inworld knows `language` (a base code such as 'ru') by, or null when it is not one of the languages listed above. */
export function inworldCode(language) {
  if (typeof language !== 'string' || !language) return null;
  const code = INWORLD_CODE[language] ?? language;
  return SUPPORTED.has(code) ? code : null;
}

/** Does the Inworld voice speak `language`? English always (as the Voxtral voice does), and an empty language is English. */
export function inworldSpeaks(language) {
  if (!language || language === 'en') return true;
  return inworldCode(language) !== null;
}

/**
 * The `language` the speech request carries for a reply in `language`: the code of a non-English language Inworld lists, else null (English and
 * anything unlisted send no field, exactly as before: the model detects the language from the text).
 */
export function inworldRequestLanguage(language) {
  if (!language || language === 'en') return null;
  return inworldCode(language);
}
