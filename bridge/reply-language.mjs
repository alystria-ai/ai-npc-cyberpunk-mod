// Which language is a piece of conversation text in? (Used on every turn, bridge/multilingual.mjs.)
//
// Cheap and deterministic: no model, no I/O, no network. Signals, in order:
//   1. Script. Letters outside the Latin alphabet name the language directly (kana: Japanese, Hangul: Korean,
//      Han without kana: Chinese, Greek, Arabic, Hebrew, Devanagari, Thai). Cyrillic is Russian or Ukrainian, told apart by their own
//      letters, then their word lists.
//   2. For Latin text, a word lexicon (bridge/language-lexicon.mjs: function words, everyday verbs, question words, greetings for 16
//      languages) with a few strongly marked letters (ñ, ß, ł, ř, ő, ğ, ă, ø, the Vietnamese tone marks ...) and Spanish's ¿ and ¡.
//      A word listed for one language counts fully for it, a word shared by several counts a share of one for each. English also has a
//      vocabulary (bridge/language-english-vocab.mjs) that counts half, so an English line with a word that is also French ("content",
//      "route") is not taken for French.
//   3. When the lexicon cannot call a short line ("Siamo quasi arrivati?" has two words it knows and one it does not), a small
//      character model trained on the same lists: it recognises the spelling of words the lists do not hold. It never calls a language
//      the lexicon and the letters give no hint of unless the line is clearly unlike English.
// English wins every close call: the characters mix Spanish, Japanese and street slang into English ("Ay, chica, let's go",
// "choom", "hermano"), and the answer decides the reply language and the voice. Night City names and slang are neutral (no
// language). A text with too little to go on returns null (unknown), and the caller keeps the conversation's last language.
// The lists are built once when this module loads; a call costs tens of microseconds (scripts/Eval-LanguageDetection.mjs prints the
// time and the precision and recall per language on the labelled lines of bridge/reply-language.cases.mjs).
// Pure functions: no I/O, so it can be tested without the bridge.
import {WORDS, NEUTRAL} from './language-lexicon.mjs';
import {ENGLISH_VOCAB} from './language-english-vocab.mjs';
import {UI_VOCAB} from './language-ui-vocab.mjs';

// Bracketed voice tags ([laughter]), emotion tags ({joy}), the F7 "[Microphone]" placeholder, URLs and anything
// that is not a letter or an apostrophe do not count.
const NOISE = /\[[^\]]*\]|\{[^}]*\}|https?:\/\/\S+/g;

// The Latin range includes Latin Extended Additional (Vietnamese tone marks) and Romanian's comma letters.
const LATIN = 'a-zA-Z\\u00C0-\\u024F\\u1E00-\\u1EFF';
const CYRILLIC = '\\u0400-\\u04FF';
const SCRIPTS = [
  ['kana', /[぀-ヿㇰ-ㇿｦ-ﾟ]/gu],
  ['hangul', /[ᄀ-ᇿ㄰-㆏가-힯]/gu],
  ['han', /[㐀-䶿一-鿿豈-﫿]/gu],
  ['cyrillic', new RegExp(`[${CYRILLIC}]`, 'gu')],
  ['greek', /[Ͱ-Ͽ]/gu],
  ['arabic', /[؀-ۿݐ-ݿ]/gu],
  ['hebrew', /[֐-׿]/gu],
  ['devanagari', /[ऀ-ॿ]/gu],
  ['thai', /[฀-๿]/gu],
  ['latin', new RegExp(`[${LATIN}]`, 'gu')],
];
const MARKED_LETTER = /[À-ÖØ-öø-ɏḀ-ỿ¿¡]/u;
const WORD = new RegExp(`[${LATIN}]+(?:'[${LATIN}]+)?'?`, 'gu');

// ---- The lexicon and the character model, built once -------------------------------------------------------------------
// Languages whose writing elides with an apostrophe ("j'ai", "l'amico", "l'ajuda"): the token splits into a head ("j'") and the word.
const ELIDING = new Set(['fr', 'it', 'ca']);
const CYRILLIC_LANGUAGES = ['ru', 'uk'];
const wordsOf = (language, text) => {
  const out = new Set();
  for (const part of text.toLowerCase().split(/[\s-]+/)) {
    if (!part) continue;
    const pieces = ELIDING.has(language) && part.includes('\'') && !part.endsWith('\'') ? part.split(/(?<=')/) : [part];
    for (const piece of pieces) {
      const word = CYRILLIC_LANGUAGES.includes(language) ? piece.replace(/['’ʼ]/g, '') : piece;
      if ((word.match(/\p{L}/gu) || []).length >= 2 || word.endsWith('\'')) out.add(word);
    }
  }
  return out;
};
const TYPES = {};          // language -> Set of word types (the lexicon and the training text)
const LEXICON = new Map(); // word -> Set of languages
for (const [language, text] of Object.entries(WORDS)) {
  TYPES[language] = wordsOf(language, text);
  for (const word of TYPES[language]) {
    if (NEUTRAL.has(word)) continue;
    if (!LEXICON.has(word)) LEXICON.set(word, new Set());
    LEXICON.get(word).add(language);
  }
}
// English vocabulary: counts for English at half weight, and trains its character model. Not a lexicon entry, so it never dilutes the
// weight of another language's word that happens to be spelled the same.
const VOCAB = new Set(ENGLISH_VOCAB.split(/\s+/).filter(word => word && !NEUTRAL.has(word)));
for (const word of VOCAB) TYPES.en.add(word);
// The interface vocabulary of the languages the mod ships: half weight, shared among the languages that hold the word.
const VLEX = new Map();
for (const [language, text] of Object.entries(UI_VOCAB)) {
  TYPES[language] ??= new Set();
  for (const word of text.split(/s+/)) {
    if (!word || NEUTRAL.has(word)) continue;
    TYPES[language].add(word);
    if (!VLEX.has(word)) VLEX.set(word, new Set());
    VLEX.get(word).add(language);
  }
}
const LATIN_LANGUAGES = Object.keys(TYPES).filter(language => !CYRILLIC_LANGUAGES.includes(language));
const ELISION_HEADS = new Set([...LEXICON.keys()].filter(word => word.endsWith('\'')));

// Interpolated character trigram models (trigram, bigram, unigram) over the word types of each language.
const MODEL = {};
for (const language of Object.keys(TYPES)) {
  const model = MODEL[language] = {n3: new Map(), d3: new Map(), n2: new Map(), d2: new Map(), n1: new Map(), total: 0};
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);
  for (const word of TYPES[language]) {
    if (NEUTRAL.has(word)) continue;
    const padded = '^^' + word + '$';
    for (let i = 2; i < padded.length; i++) {
      const a = padded[i - 2], b = padded[i - 1], c = padded[i];
      bump(model.n3, a + b + c); bump(model.d3, a + b);
      bump(model.n2, b + c); bump(model.d2, b);
      bump(model.n1, c); model.total++;
    }
  }
}
function wordLogLikelihood(model, word) {
  const padded = '^^' + word + '$';
  let sum = 0;
  for (let i = 2; i < padded.length; i++) {
    const a = padded[i - 2], b = padded[i - 1], c = padded[i];
    const d3 = model.d3.get(a + b), d2 = model.d2.get(b);
    const uni = ((model.n1.get(c) ?? 0) + 0.05) / (model.total + 0.05 * 300);
    const bi = d2 ? (model.n2.get(b + c) ?? 0) / d2 : 0;
    const tri = d3 ? (model.n3.get(a + b + c) ?? 0) / d3 : 0;
    const p = d3 ? 0.6 * tri + 0.3 * bi + 0.1 * uni : d2 ? 0.8 * bi + 0.2 * uni : uni;
    sum += Math.log(p);
  }
  return sum;
}

// Letters that point strongly at one language (each word counts once per language).
const MARKED = [
  ['es', /ñ/u], ['de', /ß/u], ['pl', /[łąęśźż]/u], ['cs', /[řěůťďšč]/u], ['hu', /[őű]/u],
  ['tr', /[ğşı]/u], ['pt', /[ãõ]/u], ['fr', /œ/u], ['ro', /[ășțşţ]/u], ['no', /ø/u],
  ['vi', /[ơưđạảấầẩẫậắằẳẵặẹẻẽếềểễệỉịọỏốồổỗộớờởỡợụủứừửữựỳỵỷỹ]/u],
];

/** Letter counts per script for a text, with tags and URLs removed. */
export function scriptCounts(text) {
  const clean = typeof text === 'string' ? text.replace(NOISE, ' ') : '';
  const counts = {};
  for (const [name, pattern] of SCRIPTS) counts[name] = (clean.match(pattern) || []).length;
  return {counts, clean};
}

// "Misty's", "don't", "j'ai", "l'amico": the tokens of a Latin text with their apostrophes handled. Returns {words, englishMarks}.
const ENGLISH_SUFFIX = /^[^']+'(?:s|re|ll|ve|d|m|t)$/;
function tokens(clean) {
  // Short capitals ("CET", "ETA", "LOL", "NPC") are acronyms, no evidence for any language.
  const raw = (clean.replace(/[’`ʼ]/g, '\'').match(WORD) || []).filter(token => token.length > 3 || token !== token.toUpperCase()).map(token => token.toLowerCase());
  const words = [];
  let englishMarks = 0;
  for (const token of raw) {
    if (LEXICON.has(token) || NEUTRAL.has(token)) { words.push(token); continue; }
    const apostrophe = token.indexOf('\'');
    if (apostrophe < 0) { words.push(token); continue; }
    if (ENGLISH_SUFFIX.test(token)) { englishMarks++; words.push(token.slice(0, apostrophe)); continue; }
    const head = token.slice(0, apostrophe + 1), tail = token.slice(apostrophe + 1);
    if (ELISION_HEADS.has(head)) { words.push(head); if (tail) words.push(tail); continue; }
    words.push(token.replace(/'/g, ''));
  }
  return {words, englishMarks};
}

// How sure the lexicon must be. A word listed for one language earns it 1, a shared word a share, an interface-vocabulary word half; so a
// line of three plain French words scores about 3. A language wins on words alone when it has at least STRONG, leads the next language
// by LEAD, and is at least twice as far ahead of English as English's own evidence plus half a word.
const STRONG = 1.3;
const LEAD = 0.6;

function latinLanguage(clean) {
  const {words: all, englishMarks} = tokens(clean);
  // One-letter words do not count: "V" is the player's name, and a, i, o, e, y, w, z are words in several languages. Names and slang are no evidence.
  const words = all.filter(word => (word.length > 1 || word.endsWith('\'')) && !NEUTRAL.has(word));
  if (!words.length) return {language: null, words: 0, strength: null};
  const score = {};
  const add = (language, value) => { score[language] = (score[language] ?? 0) + value; };
  for (const word of words) {
    const hit = LEXICON.get(word);
    if (hit) for (const language of hit) add(language, 1 / hit.size);
    if (VOCAB.has(word)) add('en', 0.5);
    const extra = VLEX.get(word);
    if (extra) for (const language of extra) add(language, 0.5 / extra.size);
    for (const [language, pattern] of MARKED) if (pattern.test(word)) add(language, 1);
  }
  if (englishMarks) add('en', Math.min(englishMarks, 2) * 0.5);
  // Inverted question and exclamation marks are Spanish punctuation, outside any word.
  const inverted = (clean.match(/[¿¡]/gu) || []).length;
  if (inverted) add('es', Math.min(inverted, 2));
  const english = score.en ?? 0;
  const ranked = Object.entries(score).filter(([language]) => language !== 'en').sort((a, b) => b[1] - a[1]);
  const best = ranked[0]?.[0] ?? null, other = ranked[0]?.[1] ?? 0, second = ranked[1]?.[1] ?? 0;
  const count = words.length;
  // One or two words: a single distinctive word decides ("Hola", "Danke", "Merci"), as long as English has nothing.
  if (count <= 2) {
    if (other >= 1 && english === 0 && other - second >= 0.5) return {language: best, words: count, strength: 'lexicon'};
    if (english >= 1 && other < 1) return {language: 'en', words: count, strength: 'lexicon'};
    return {language: null, words: count, strength: null};
  }
  // A clear lexical win: nothing English at all, or well ahead of it.
  if (other >= STRONG && other - second >= LEAD && other - 2 * english >= 0.5) return {language: best, words: count, strength: 'lexicon'};
  if (english >= 1 && english >= other && english >= second * 1.2) return {language: 'en', words: count, strength: 'lexicon'};
  const guess = modelLanguage(words, score, english, other);
  return {language: guess, words: count, strength: guess ? 'model' : null};
}

/**
 * The character model's call for a line the lexicon left open. The lexicon shortlists (every language with a real share of the evidence) and
 * the model chooses among them, if it puts the choice clearly ahead of English; with no shortlist the model must be far ahead of English
 * and of every other language. English is called only when the model is clearly ahead and nothing foreign was heard.
 */
function modelLanguage(words, score, english, other) {
  const sample = words.slice(0, 40);
  const total = {};
  for (const language of LATIN_LANGUAGES) {
    const model = MODEL[language];
    let sum = 0;
    for (const word of sample) sum += wordLogLikelihood(model, word.replace(/'/g, ''));
    total[language] = sum;
  }
  const chars = sample.reduce((sum, word) => sum + word.length, 0);
  const foreign = LATIN_LANGUAGES.filter(language => language !== 'en');
  const byModel = languages => languages.reduce((best, language) => (!best || total[language] > total[best] ? language : best), null);
  const shortlist = other >= 0.3 ? foreign.filter(language => (score[language] ?? 0) >= Math.max(0.3, 0.6 * other)) : [];
  if (english < 0.5) {
    if (shortlist.length) {
      const choice = byModel(shortlist);
      const rivals = shortlist.filter(language => language !== choice);
      const overRival = rivals.length ? total[choice] - Math.max(...rivals.map(language => total[language])) : Infinity;
      if (total[choice] - total.en >= 3 + 0.2 * chars && overRival >= 1) return choice;
    } else if (chars >= 12) {
      const choice = byModel(foreign), rivals = foreign.filter(language => language !== choice);
      if (total[choice] - total.en >= 6 + 0.45 * chars && total[choice] - Math.max(...rivals.map(language => total[language])) >= 1.5) return choice;
    }
  }
  if (!shortlist.length && other < 0.3 && english < 1 && chars >= 6 && total.en - total[byModel(foreign)] >= 2 + 0.3 * chars) return 'en';
  return null;
}

let memoText, memoResult;
/**
 * The language of a text as an ISO 639-1 code ('en', 'es', 'ja', ...) or null when there is too little to tell.
 * `script` names the deciding script ('latin', 'kana', 'cyrillic', ...); `words` is how many words of evidence a Latin line had.
 * One call is remembered: a turn asks about the same text several times.
 */
export function detectLanguage(text) {
  if (text === memoText && memoResult) return memoResult;
  const result = Object.freeze(detect(text));
  memoText = text; memoResult = result;
  return result;
}

function detect(text) {
  const {counts, clean} = scriptCounts(text);
  const letters = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (!letters) return {language: null, script: null};
  const nonLatin = letters - counts.latin;
  // Names and loanwords in Latin letters ("V", "Night City", "Arasaka") are common in other scripts' replies.
  if (nonLatin >= 2 && nonLatin / letters >= 0.3) {
    if (counts.kana) return {language: 'ja', script: 'kana', strength: 'script', letters: nonLatin};
    if (counts.hangul) return {language: 'ko', script: 'hangul', strength: 'script', letters: nonLatin};
    if (counts.han) return {language: 'zh', script: 'han', strength: 'script', letters: nonLatin};
    if (counts.cyrillic) return {language: cyrillicLanguage(clean), script: 'cyrillic', strength: 'script', letters: nonLatin};
    if (counts.greek) return {language: 'el', script: 'greek', strength: 'script', letters: nonLatin};
    if (counts.arabic) return {language: 'ar', script: 'arabic', strength: 'script', letters: nonLatin};
    if (counts.hebrew) return {language: 'he', script: 'hebrew', strength: 'script', letters: nonLatin};
    if (counts.devanagari) return {language: 'hi', script: 'devanagari', strength: 'script', letters: nonLatin};
    if (counts.thai) return {language: 'th', script: 'thai', strength: 'script', letters: nonLatin};
  }
  const {language, words, strength} = latinLanguage(clean);
  // `letters`: the Latin letters of the line. `marked`: a letter outside a-z (an accent, ñ, ß, ı, ¿ ...), which English does not write.
  // `strength`: how the call was made ('lexicon' from the word lists, 'model' from the character model, null for no call).
  return {language, script: 'latin', words, strength, letters: counts.latin, tokens: (clean.match(WORD) || []).length, marked: MARKED_LETTER.test(clean)};
}

// Ukrainian and Russian share the script: the letters і ї є ґ are Ukrainian, ы э ъ ё are Russian; otherwise their word lists decide, then
// their character models. Russian when nothing says otherwise.
function cyrillicLanguage(clean) {
  const lower = clean.toLowerCase();
  if (/[іїєґ]/u.test(lower)) return 'uk';
  if (/[ыэъё]/u.test(lower)) return 'ru';
  const words = (lower.replace(/['’ʼ`]/g, '').match(new RegExp(`[${CYRILLIC}]+`, 'gu')) || []).filter(word => word.length > 1);
  let uk = 0, ru = 0;
  for (const word of words) {
    const hit = LEXICON.get(word), extra = VLEX.get(word);
    if (hit?.has('uk')) uk += 1 / hit.size;
    if (hit?.has('ru')) ru += 1 / hit.size;
    if (extra?.has('uk')) uk += 0.5 / extra.size;
    if (extra?.has('ru')) ru += 0.5 / extra.size;
  }
  if (uk !== ru) return uk > ru ? 'uk' : 'ru';
  let ukModel = 0, ruModel = 0;
  for (const word of words.slice(0, 40)) { ukModel += wordLogLikelihood(MODEL.uk, word); ruModel += wordLogLikelihood(MODEL.ru, word); }
  return ukModel - ruModel > 2 ? 'uk' : 'ru';
}

// ---- The guard for short lines ---------------------------------------------------------------------------------------------
// A line of a few words in Latin letters is weak evidence: "hows biz" was taken for Turkish (2026-10-23). The conversation's language
// (bridge/multilingual.mjs) never moves on such a line unless the detector is highly confident (the word lists made the call, not the
// character model) AND the line holds a letter English does not write (é, ñ, ß, ı, ¿ ...). Other scripts (kana, Hangul, Cyrillic ...) are
// unambiguous at once.
export const SHORT_WORDS = 4, SHORT_LETTERS = 20;
// A long line moves the conversation's language on its own; a shorter one needs a second confident detection in a row.
export const LONG_WORDS = 5, LONG_LETTERS = 24;

/**
 * detectLanguage plus how much the call can be trusted: {language, script, words, short, long, solid}.
 *   short: Latin script with fewer than 4 words or 20 letters;
 *   long:  enough text to stand alone (5 words and 24 letters, or a few letters of another script);
 *   solid: the call may move the conversation's language (not short, or short but highly confident with a non-English letter).
 * `language` is the plain detection; a caller that must be careful reads `solid`.
 */
export function assessLanguage(text) {
  const found = detectLanguage(text);
  const {language, script} = found;
  if (!language) return {...found, short: false, long: false, solid: false};
  if (script !== 'latin') { const letters = found.letters ?? 0; return {...found, short: false, long: letters >= 3, solid: letters >= 2}; }
  const short = found.tokens < SHORT_WORDS || found.letters < SHORT_LETTERS;
  const long = found.tokens >= LONG_WORDS && found.letters >= LONG_LETTERS;
  const solid = short ? (language !== 'en' && found.strength === 'lexicon' && found.marked === true) : true;
  return {...found, short, long, solid};
}

/** The language of a text for a caller that must not be fooled by a short line: null unless the call is solid. */
export const guardedLanguage = text => { const found = assessLanguage(text); return found.solid ? found.language : null; };

/**
 * The language a text is spoken in (a reply, a line V types): English is taken as it is, another language only when the call is solid, so a short
 * English line the detector took for Turkish ("hows biz") keeps the voice the turn was planned with. null: no call.
 */
export const spokenLanguage = text => { const found = assessLanguage(text); return found.language === 'en' ? 'en' : found.solid ? found.language : null; };

/** True only when the text is confidently in a language other than English. */
export const isNonEnglish = text => { const {language} = detectLanguage(text); return !!language && language !== 'en'; };
