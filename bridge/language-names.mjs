// English names of the languages the mod can name in a prompt: the languages the reply-language detector reports, and the Other languages
// (bridge/other-languages.mjs). Used for the reply-language instruction (bridge/multilingual.mjs) and the subtitle translation request (bridge/subtitle-translation.mjs).
// A module of its own with a light import, so the text provider host does not load the language detector for a name.
import {OTHER_LANGUAGES} from './other-languages.mjs';

export const LANGUAGE_NAMES = Object.freeze({en: 'English', es: 'Spanish', pt: 'Portuguese', fr: 'French', de: 'German',
  it: 'Italian', nl: 'Dutch', pl: 'Polish', cs: 'Czech', hu: 'Hungarian', tr: 'Turkish', sv: 'Swedish', ro: 'Romanian', ca: 'Catalan',
  no: 'Norwegian', vi: 'Vietnamese', ja: 'Japanese',
  zh: 'Chinese', ko: 'Korean', ru: 'Russian', uk: 'Ukrainian', el: 'Greek', ar: 'Arabic', he: 'Hebrew', hi: 'Hindi', th: 'Thai',
  // The Other languages the lists above did not name: the prompt says "Finnish", not "that language".
  ...Object.fromEntries(OTHER_LANGUAGES.map(item => [item.code, item.name]))});
