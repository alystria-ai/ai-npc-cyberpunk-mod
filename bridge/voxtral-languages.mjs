// Which languages the Mistral cloud voice (Voxtral) speaks, and which the Mistral microphone model hears.
//
// Pure data and two small functions, shared by the voice routing (bridge/multilingual.mjs), V's voice (bridge/v-voice.mjs) and the
// voice itself (bridge/voxtral-voice.mjs), so a language list is written once. Facts: docs/MISTRAL.md, "Voxtral 3" (2026-10-21).
//
// Text to speech. The API has no language field: the model speaks the language the text is written in, in the cloned voice (a reference clip
// in English still speaks French; the clip is the voice, not the language).
//  - Voxtral TTS 3 (`voxtral-mini-tts-3-0`, released 2026-10-20): Mistral's languages page (docs.mistral.ai/studio/audio/specs-and-limits/languages, read
//    2026-10-31) lists English (two variants) and 37 other languages: Arabic, Bulgarian, Catalan, Chinese, Croatian, Czech, Danish, Dutch, Filipino, Finnish, French,
//    German, Greek, Hindi, Hungarian, Icelandic, Indonesian, Italian, Japanese, Korean, Latvian, Luxembourgish, Norwegian, Polish, Portuguese, Romanian,
//    Russian, Slovak, Slovenian, Spanish, Swedish, Tamil, Thai, Turkish, Ukrainian, Urdu, Vietnamese. Preset voices exist for 22 of them, the others
//    are spoken by a cloned voice (which is what the mod always sends). Before 2026-10-31 only the 22 that the announcement named were listed here,
//    which kept Czech, Swedish, Thai and the rest as written text.
//  - Voxtral TTS (`voxtral-mini-tts-latest`, the alias of the March 2026 model, "TTS v1"): 9 languages (English, French, Spanish, Portuguese,
//    Italian, Dutch, German, Hindi, Arabic). This is the model asked when the account refuses the v3 id (bridge/voxtral-voice.mjs).
// The codes are the base codes the reply-language detector reports (bridge/reply-language.mjs); Filipino is 'fil'.
export const VOXTRAL_TTS3_LANGUAGES = Object.freeze(['en', 'fr', 'es', 'ca', 'nl', 'de', 'hu', 'it', 'no', 'pl', 'ro', 'ru', 'tr', 'uk',
  'pt', 'ar', 'zh', 'hi', 'ja', 'ko', 'vi', 'el',
  'bg', 'hr', 'cs', 'da', 'fil', 'fi', 'is', 'id', 'lv', 'lb', 'sk', 'sl', 'sv', 'ta', 'th', 'ur']);
export const VOXTRAL_TTS1_LANGUAGES = Object.freeze(['en', 'fr', 'es', 'pt', 'it', 'nl', 'de', 'hi', 'ar']);

export const VOXTRAL_TTS_MODEL = 'voxtral-mini-tts-3-0';
export const VOXTRAL_TTS_FALLBACK_MODEL = 'voxtral-mini-tts-latest';

/** Does the Voxtral voice speak `language` (a base code such as 'fr')? `model` is the model in use (the v3 id unless it was refused). */
export function voxtralSpeaks(language, model = VOXTRAL_TTS_MODEL) {
  if (!language || language === 'en') return true;
  return (model === VOXTRAL_TTS_MODEL ? VOXTRAL_TTS3_LANGUAGES : VOXTRAL_TTS1_LANGUAGES).includes(language);
}

// Speech to text. Voxtral Mini Transcribe 3 (`voxtral-mini-transcribe-3-0`) supports 50 languages but Mistral publishes the full list nowhere:
// the announcement prints the 45-language FLEURS benchmark set, and that is the list used here, without Filipino (its code is not confirmed).
// A language outside it is still asked, without a language hint, and may be understood.
export const VOXTRAL_STT3_LANGUAGES = Object.freeze(['ar', 'bn', 'bg', 'ca', 'zh', 'cs', 'da', 'nl', 'en', 'et', 'fi', 'fr', 'de', 'el', 'gu', 'hi', 'hu',
  'is', 'id', 'it', 'ja', 'kn', 'ko', 'lv', 'lt', 'mk', 'ms', 'ml', 'mr', 'no', 'fa', 'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'es', 'sv', 'te', 'th',
  'tr', 'uk', 'vi']);
// Voxtral Mini Transcribe 2 (`voxtral-mini-latest`), the model asked when the v3 id is refused.
export const VOXTRAL_STT2_LANGUAGES = Object.freeze(['en', 'zh', 'hi', 'es', 'ar', 'fr', 'pt', 'ru', 'de', 'ja', 'ko', 'it', 'nl']);

export const VOXTRAL_STT_MODEL = 'voxtral-mini-transcribe-3-0';
export const VOXTRAL_STT_FALLBACK_MODEL = 'voxtral-mini-latest';

/** Does `model` (a Voxtral transcription model id) list `language`? */
export function voxtralHears(language, model = VOXTRAL_STT_MODEL) {
  if (!language) return false;
  return (model === VOXTRAL_STT_MODEL ? VOXTRAL_STT3_LANGUAGES : VOXTRAL_STT2_LANGUAGES).includes(language);
}

/**
 * Is this refusal the account refusing the MODEL (a v3 id that is unknown, not on the plan, or not yet open to this key), rather than a
 * fault of the request or the key? `attempt` counts the asks already made for this request: a 403 on its own can be a hiccup (the voices ask
 * again once, bridge/voxtral-voice.mjs), so it only counts once it repeats. Never a rate limit, a server fault or a guardrail refusal.
 */
export function modelRefused({status, kind, message = ''} = {}, attempt = 0) {
  if (kind === 'content' || kind === 'limit' || kind === 'network' || kind === 'timeout') return false;
  if (status === 404 || status === 402) return true;
  if (status === 400 || status === 422) return /\bmodel\b|\bplan\b|\bpermission/i.test(String(message));
  return status === 403 && attempt > 0;
}
