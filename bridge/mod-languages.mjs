// The mod's interface languages (mod/locales) as the base language codes the recognisers and the reply language use. A module of its own, with no imports, so the
// small language modules (bridge/other-languages.mjs, bridge/subtitle-translation.mjs) and the text provider host that uses them load none of the language detector.
export const MOD_LANGUAGES = Object.freeze(['en', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'ru', 'uk', 'tr', 'cs', 'hu', 'ja', 'ko', 'zh']);
