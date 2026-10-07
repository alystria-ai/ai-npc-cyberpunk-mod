// Which language is a piece of conversation text in? ("Multilingual conversations", bridge/multilingual.mjs.)
//
// Cheap and deterministic: no model, no I/O. Two signals, in order:
//   1. Script. Letters outside the Latin alphabet name the language directly (kana: Japanese, Hangul: Korean,
//      Han without kana: Chinese, Cyrillic: Russian, or Ukrainian when its own letters appear, and so on).
//   2. For Latin text, common function words ("the", "and", "que", "und", ...) plus a few strongly marked letters
//      (ñ, ß, ł, ř, ő, ğ, ...) and a short list of greetings and thanks, so a one-word "Hola" still counts.
// English wins every close call: the characters already mix Spanish, Japanese and street slang into English
// ("Ay, chica, let's go", "choom", "hermano"), and the answer only decides which voice speaks a reply. A text with
// too little to go on returns null (unknown), and the caller keeps its previous expectation.
// Pure functions: no I/O, so it can be tested without the bridge.

// Bracketed voice tags ([laughter]), emotion tags ({joy}), the F7 "[Microphone]" placeholder, URLs and anything
// that is not a letter or an apostrophe do not count.
const NOISE = /\[[^\]]*\]|\{[^}]*\}|https?:\/\/\S+/g;

const SCRIPTS = [
  ['kana', /[぀-ヿㇰ-ㇿｦ-ﾟ]/gu],
  ['hangul', /[ᄀ-ᇿ㄰-㆏가-힯]/gu],
  ['han', /[㐀-䶿一-鿿豈-﫿]/gu],
  ['cyrillic', /[Ѐ-ӿ]/gu],
  ['greek', /[Ͱ-Ͽ]/gu],
  ['arabic', /[؀-ۿݐ-ݿ]/gu],
  ['hebrew', /[֐-׿]/gu],
  ['devanagari', /[ऀ-ॿ]/gu],
  ['thai', /[฀-๿]/gu],
  ['latin', /[a-zÀ-ɏ]/giu],
];

// Function words, lowercase. Only words that are common in one language and rare in English text are listed for
// the other languages, so an English sentence with a Spanish nickname still scores as English.
const WORDS = {
  en: 'the a an and or but is are was were be been am i you he she it we they me my your our their this that these those what which who why how where when there here have has had do does did not no yes to of in on at for with from about just can will would could should get got let\'s it\'s i\'m don\'t you\'re that\'s okay so if then than some any all like know think',
  es: 'el la los las un una unos unas y o pero es son era fue estoy estás está estamos están ser soy eres que qué de del en con por para como cómo dónde cuando cuándo por qué porque muy también pues sí no hay mi mis tu tus su sus nos les le lo me te se esto eso esta este ese esa al bien gracias hola sabes quiero puedo tengo tienes vamos ahora aquí allí nada algo todo nunca siempre mucho más ya tú hacer puedes oye vale claro quieren quieres vienes creo dime hasta luego mañana noche tiempo gente cosa cosas mejor entonces sin sobre entre otro otra bueno',
  pt: 'o a os as um uma e ou mas é são era foi estou está estamos estão ser sou que de do da dos das em no na nos nas com por para como onde quando porque muito também sim não há meu minha seu sua você vocês isso isto esse essa ao bem obrigado obrigada olá tenho tem vamos agora aqui nada algo tudo nunca sempre mais já fazer pode posso quer quero acho diga até amanhã noite tempo gente coisa coisas melhor então sem sobre entre outro outra bom né vai hoje',
  fr: 'le la les un une des et ou mais est sont était été je tu il elle nous vous ils elles que qui quoi de du en dans avec pour par comme où quand pourquoi parce très aussi oui non pas ne mon ma mes ton ta tes son sa ses ce cette ces au aux bien merci bonjour suis es sommes êtes avoir ai as avons c\'est j\'ai rien quelque toujours jamais vraiment faire peux veux dois ici maintenant ça tout tous soir demain nuit temps gens chose choses mieux alors sans sur entre autre peut salut va',
  de: 'der die das den dem des ein eine einen einem und oder aber ist sind war waren bin bist sein ich du er sie es wir ihr nicht kein keine ja nein zu von mit für auf aus bei nach wie was wer wo wann warum weil sehr auch noch schon nur mein meine dein deine sich dass hier jetzt danke hallo habe hast haben gut nichts etwas immer heute morgen vielleicht wirklich machen machst kann kannst willst muss dort gibt geht mal doch mehr abend nacht zeit leute sache besser dann ohne über zwischen andere',
  it: 'il lo la i gli le un uno una e o ma è sono era erano essere sei siamo che di del della dei delle in con per come dove quando perché molto anche sì no non mio mia tuo tua suo sua questo questa quello quella al alla bene grazie ciao ho hai abbiamo cosa niente qualcosa tutto sempre mai più già fare fai puoi posso vuoi voglio penso dimmi fino domani notte stasera tempo gente cose meglio allora senza sopra tra altro altra buono',
  nl: 'de het een en of maar is zijn was waren ik jij je hij zij wij jullie niet geen ja nee te van met voor op uit bij naar hoe wat wie waar wanneer waarom omdat heel ook nog al mijn jouw dat dit hier nu dank hallo heb hebt hebben goed',
  pl: 'i w z na nie to jest są był była się że do od po za co jak gdzie kiedy dlaczego bo bardzo też tak mój moja twój twoja jego jej ten ta to tu teraz dziękuję cześć mam masz jestem jesteś',
  cs: 'a v ve z na ne to je jsou byl byla se že do od po za co jak kde kdy proč protože velmi také ano můj moje tvůj tvoje jeho její ten ta tady teď děkuji ahoj mám máš jsem jsi ale nebo jsme jste není už jen když něco nic všechno tohle tím víš vím nevím můžeme chci musíme dobře díky',
  hu: 'a az egy és vagy de nem igen is van vannak volt én te ő mi ti ők hogy mit ki hol mikor miért mert nagyon még már csak az ez itt most köszönöm szia vagyok vagy tudom tudod akarsz akarok lehet kell nincs jó rendben köszi mondani talán velem veled neked nekem ezt azt',
  tr: 've veya ama bir bu şu o ben sen biz siz onlar değil evet hayır için ile gibi ne nasıl nerede neden çünkü çok da de mi mı mu mü benim senin var yok burada şimdi teşekkürler merhaba',
  sv: 'och eller men är var jag du han hon vi ni de inte ja nej att av med för på från hur vad vem var när varför för mycket också min mitt din ditt det den här nu tack hej',
};
const LEXICON = new Map();
for (const [language, words] of Object.entries(WORDS)) {
  for (const word of words.split(' ')) {
    if (!LEXICON.has(word)) LEXICON.set(word, new Set());
    LEXICON.get(word).add(language);
  }
}
// Letters that point strongly at one language (each occurrence counts once per word).
const MARKED = [
  ['es', /ñ/u], ['de', /ß/u], ['pl', /[łąęśźżń]/u], ['cs', /[řěůťďšč]/u], ['hu', /[őű]/u],
  ['tr', /[ğşı]/u], ['pt', /[ãõ]/u], ['fr', /[œæ]/u],
];

/** Letter counts per script for a text, with tags and URLs removed. */
export function scriptCounts(text) {
  const clean = typeof text === 'string' ? text.replace(NOISE, ' ') : '';
  const counts = {};
  for (const [name, pattern] of SCRIPTS) counts[name] = (clean.match(pattern) || []).length;
  return {counts, clean};
}

function latinLanguage(clean) {
  // One-letter words do not count: "V" is the player's name, and a, i, o, e, y, w, z are words in several languages.
  const words = (clean.toLowerCase().replace(/[’`]/g, '\'').match(/[a-zÀ-ɏ]+(?:'[a-z]+)?/gu) || [])
    .filter(word => word.length > 1);
  if (!words.length) return {language: null, words: 0};
  const score = {};
  for (const word of words) {
    for (const language of LEXICON.get(word) ?? []) score[language] = (score[language] ?? 0) + 1 / LEXICON.get(word).size;
    for (const [language, pattern] of MARKED) if (pattern.test(word)) score[language] = (score[language] ?? 0) + 1;
  }
  // Inverted question and exclamation marks are Spanish punctuation, outside any word.
  const inverted = (clean.match(/[¿¡]/gu) || []).length;
  if (inverted) score.es = (score.es ?? 0) + inverted;
  const english = score.en ?? 0;
  let best = null;
  for (const [language, value] of Object.entries(score)) if (language !== 'en' && (!best || value > score[best])) best = language;
  const other = best ? score[best] : 0;
  // One or two words: a single distinctive word decides ("Hola", "Danke", "Merci"), as long as English has nothing.
  if (words.length <= 2) {
    if (other >= 1 && english === 0) return {language: best, words: words.length};
    if (english >= 1 && other < 1) return {language: 'en', words: words.length};
    return {language: null, words: words.length};
  }
  if (other >= 2 && other > english * 1.5 + 0.5) return {language: best, words: words.length};
  if (english >= 1 && english >= other) return {language: 'en', words: words.length};
  return {language: null, words: words.length};
}

/**
 * The language of a text as an ISO 639-1 code ('en', 'es', 'ja', ...) or null when there is too little to tell.
 * `script` names the deciding script ('latin', 'kana', 'cyrillic', ...).
 */
export function detectLanguage(text) {
  const {counts, clean} = scriptCounts(text);
  const letters = Object.values(counts).reduce((sum, value) => sum + value, 0);
  if (!letters) return {language: null, script: null};
  const nonLatin = letters - counts.latin;
  // Names and loanwords in Latin letters ("V", "Night City", "Arasaka") are common in other scripts' replies.
  if (nonLatin >= 2 && nonLatin / letters >= 0.3) {
    if (counts.kana) return {language: 'ja', script: 'kana'};
    if (counts.hangul) return {language: 'ko', script: 'hangul'};
    if (counts.han) return {language: 'zh', script: 'han'};
    if (counts.cyrillic) return {language: /[іїєґ]/iu.test(clean) ? 'uk' : 'ru', script: 'cyrillic'};
    if (counts.greek) return {language: 'el', script: 'greek'};
    if (counts.arabic) return {language: 'ar', script: 'arabic'};
    if (counts.hebrew) return {language: 'he', script: 'hebrew'};
    if (counts.devanagari) return {language: 'hi', script: 'devanagari'};
    if (counts.thai) return {language: 'th', script: 'thai'};
  }
  const {language} = latinLanguage(clean);
  return {language, script: 'latin'};
}

/** True only when the text is confidently in a language other than English. */
export const isNonEnglish = text => { const {language} = detectLanguage(text); return !!language && language !== 'en'; };
