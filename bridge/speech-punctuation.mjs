// Punctuation for the player's own lines before they are spoken (V's voice, bridge/v-voice.mjs; typed lines and microphone lines).
//
// Players type "hey whats up" and the speech recogniser may hand back "where are we going" with nothing at the end. A TTS model (Pocket,
// OmniVoice, Voxtral) reads a line with no final mark with a hanging or flat ending, and the quality drops. This puts the missing mark on the
// text that goes to the voice ONLY: the chat history, the model input and the subtitle keep what the player typed.
//
// No model and no I/O: a few anchored regular expressions on a short line, microseconds. Idempotent (a line it has finished comes back
// unchanged). When unsure it does less: a line it cannot read as a question gets a full stop, never a guess at a clause break.
//
//   punctuateForSpeech('hey whats up')               -> 'Hey, whats up?'
//   punctuateForSpeech('where are we going')         -> 'Where are we going?'
//   punctuateForSpeech('we should go, right')        -> 'We should go, right?'
//   punctuateForSpeech('nice one :)')                -> 'Nice one :)'   (an emoticon, an emoji or a link at the end is left alone)
//
// What it does, in order:
//   1. trims the line, and drops a dangling , ; : or dash at its end;
//   2. puts a comma after a leading "hey", "hi", "hello", "yo", "oh", "ok", "okay" or "hmm" when the line goes on (English only);
//   3. makes the first letter a capital, for scripts that have case (Turkish dotted/dotless i included), unless the line starts with a link,
//      an address or a word with a capital inside it ("iPhone");
//   4. adds the final mark when the line ends without . ! ? … (or a closing quote or bracket after one): "?" for a question, else ".".
//      A question is read from the last sentence: a question word (who, what, where ..., and the other languages' own) or a verb-first
//      form with a pronoun ("can you", "are we"), a trailing "right"/"ok"/"yeah" tag, and for Japanese, Korean and Chinese the question
//      particles and words. Full-width marks are used for Japanese and Chinese.
// The 15 languages of the mod (bridge/speech-language.mjs MOD_LANGUAGES) are covered; the language is the turn's (V's plan), the script of
// the line wins for Japanese, Korean, Chinese and Cyrillic, and anything unknown is read as English.

const B = '(?![\\p{L}\\p{N}])';   // a word ends here (\b is ASCII-only)
const rx = (source, flags = 'iu') => new RegExp(source, flags);
const alt = list => list.join('|');
const skipper = words => rx(`^(?:(?:${alt(words)})${B}[\\s,]*)+`);

const TERMINATED = /[.!?…‥。！？．｡؟⁇⁈⁉~〜]$/u;
const CLOSERS = /["'”’»›)\]}」』）】〉》]+$/u;
const TRAILING_WEAK = /[\s,;:，；：、\-–—]+$/u;
const LEADING_OPENERS = /^[\s"'“‘(\[¿¡«]+/u;

// ---- what is left alone at the end of a line ----
const EMOTICON = /^(?:[:;=8][-'^o]?[)(\]\[DPpOo\/\\|*3$@sS>]+|[xX][Dd]+|<\/?3+|\^[_.\-o]*\^|[>T;][_.\-]?[<T;]|[oO][_.]?[oO]|¯\\_\(ツ\)_\/¯)$/u;
const LINK = /^(?:[a-z][a-z0-9+.-]*:\/\/\S+|www\.\S+|[\w.-]+@[\w-]+\.[\w.-]+|[\w-]+(?:\.[\w-]+)*\.(?:com|org|net|io|gg|tv|me|co|dev|app|ru|de|fr|es|it|pl|jp|uk|cz|hu|tr|br)(?:\/\S*)?)$/i;
const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]$/u;

function endsSpecial(line) {
  if (EMOJI.test(line)) return true;
  const token = line.slice(line.lastIndexOf(' ') + 1);
  return EMOTICON.test(token) || LINK.test(token);
}

// ---- English helpers ----
const SUBJECT = new Set(['i', 'you', 'u', 'ya', 'we', 'they', 'he', 'she', 'it', 'that', 'this', 'these', 'those', 'there', 'here', 'anyone', 'anybody',
  'someone', 'somebody', 'everyone', 'everybody', 'nobody', 'one', "y'all"]);
const DETERMINER = new Set(['the', 'a', 'an', 'my', 'your', 'our', 'his', 'her', 'their', 'its', 'any', 'some', 'every', 'no', 'all', 'both', 'each']);
const BE_MODAL = new Set(['is', 'are', 'was', 'were', 'am', 'can', 'could', 'will', 'would', 'should', 'shall', 'may', 'might', 'must', "isn't", 'isnt', "aren't", 'arent',
  "wasn't", "weren't", "can't", 'cant', "couldn't", "won't", 'wont', "wouldn't", "shouldn't", "ain't"]);
const DO_HAVE = new Set(['do', 'does', 'did', 'have', 'has', 'had', "don't", 'dont', "doesn't", 'doesnt', "didn't", 'didnt', "haven't", 'havent', "hasn't", 'hasnt', "hadn't"]);
const DO_IMPERATIVE_OBJECT = new Set(['it', 'that', 'this', 'these', 'those']);
const TAG_BLOCK = new Set(['is', 'are', 'was', 'were', 'am', "it's", "that's", "i'm", 'im', "he's", "she's", 'be', 'been', 'it', 'that', 'this', 'all', 'turn', 'go', 'going', 'make',
  'take', 'hang', 'feel', 'feels', 'felt', 'sounds', 'sound', 'looks', 'look', 'so', 'very', 'just', 'not', 'no', 'said', 'say', 'says', 'on', 'to', 'the', 'a', 'got', 'get', 'do', 'did',
  'done', 'was', 'stay', 'keep', 'kept', 'now', 'then', 'too', 'real', 'really', 'quite']);
const EN_STRONG = rx(`^(?:(?:wh(?:o|om|ose|at|ere|y|ich)|how)(?:'?s|'?re|'?d|'?ll|'?ve|cha)?|sup|wass?up|wazz?up|how come)${B}`);
const EN_NOT_QUESTION = /^(?:what an?|how (?:nice|great|beautiful|cool|lovely|wonderful|awesome|amazing|sweet|cute|dare|sad))(?![\p{L}\p{N}])/iu;
const EN_WHEN = rx(`^when(?:'?s)?${B}`);
const EN_AUX_WORDS = new Set(['is', 'are', 'was', 'were', 'am', 'do', 'does', 'did', 'can', 'could', 'will', 'would', 'should', 'shall', 'have', 'has', 'had']);

const word = value => (value ?? '').replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, '');

function englishAux(words) {
  const first = word(words[0]), second = word(words[1]);
  if (!first || !second) return false;
  if (BE_MODAL.has(first)) return SUBJECT.has(second) || DETERMINER.has(second);
  // "do it", "have that" are orders; "does it", "did that", "do you", "have we" are questions.
  if (DO_HAVE.has(first)) return SUBJECT.has(second) && !((first === 'do' || first === 'have') && DO_IMPERATIVE_OBJECT.has(second));
  return false;
}

// ---- the languages ----
// skip     leading words that are not part of the question ("hey", "ok so", "also")
// strong   an opener that makes the sentence a question
// weak     an opener that is also an ordinary connecting word; a question only in a short line (weakMax words)
// aux      verb-first openers (checked on the sentence after `skip`)
// anywhere a particle that marks a question wherever it stands
// tags     "right?" style tags, counted only after a comma or a dash
const LANGS = {
  en: {
    skip: skipper(['hey', 'hi', 'hello', 'yo', 'oh', 'ah', 'well', 'okay', 'ok', 'so', 'um', 'uh', 'hmm+', 'wait', 'look', 'listen', 'and', 'but', 'alright', 'man', 'dude', 'please']),
    weakMax: 3, tags: ['right', 'ok', 'okay', 'yeah', 'yea', 'huh', 'eh', 'you know'],
  },
  de: {
    skip: skipper(['hey', 'hi', 'hallo', 'na', 'also', 'ok', 'okay', 'ach', 'oh', 'und', 'aber', 'dann', 'sag mal', 'sag', 'ey', 'bitte']),
    strong: rx(`^(?:wer|wen|wem|wessen|was|wo|wohin|woher|wann|warum|wieso|weshalb|weswegen|wozu|wof(?:ü|ue)r|womit|woran|worauf|wovon|wie(?! (?:gesagt|immer))|welch(?:e|er|es|en|em)?)${B}`),
    aux: rx(`^(?:ist|sind|bist|seid|war|waren|hast|hat|habt|haben|kannst|kann|k(?:ö|oe)nnt|k(?:ö|oe)nnen|k(?:ö|oe)nntest|willst|wollt|wollen|sollst|soll|sollen|wirst|wird|werdet|w(?:ü|ue)rdest|w(?:ü|ue)rdet|darfst|darf|gibt|kommst|kommt|gehst|geht|gehen|machst|macht|wei(?:ß|ss)t|siehst|h(?:ö|oe)rst|glaubst|denkst|brauchst|magst|m(?:ö|oe)chtest|bleibst|bleibt|hilfst|hilft)\\s+(?:du|ihr|wir|sie|er|es|ich|man|das|dies|jemand|noch|alles|hier|dort|da|der|die|dein|deine|mein|meine|ein|eine|kein|keine)${B}`),
    tags: ['oder', 'ne', 'nicht wahr', 'ok', 'okay', 'richtig', 'stimmt\'s', 'gell'],
  },
  fr: {
    skip: skipper(['h(?:é|e)', 'hey', 'salut', 'bon', 'alors', 'ok', 'okay', 'et', 'mais', 'dis', 'euh', 'ben', 'bah', 'donc']),
    strong: rx(`^(?:(?:(?:à|a|de|du|avec|pour|par|chez|sur|dans|depuis|sans|vers|jusqu'à|d')\\s*)?(?:qui|quoi|o(?:ù|u(?=\\s+(?:est|sont|vas|va|allons|on)))|pourquoi|comment|combien|quel(?:le)?s?|lequel|laquelle|lesquel(?:le)?s)|est-ce|qu'est(?:-ce)?|qu'as|qu'avez|qu'en|qu'y|[\\p{L}']+-(?:t-)?(?:tu|il|elle|on|ils|elles|je|ce)|(?:pouvez|voulez|avez|[êe]tes|savez|sommes|allons|avons|pouvons|devons|irons|serons)-(?:vous|nous))${B}`),
    weak: rx(`^(?:quand|que|depuis quand)${B}`), weakMax: 4,
    tags: ['hein', "n'est-ce pas", "d'accord", 'ok', 'okay', 'tu vois', 'pas vrai'],
  },
  es: {
    skip: skipper(['oye', 'hey', 'hola', 'bueno', 'pues', 'vale', 'ok', 'okay', 'y', 'pero', 'entonces', 'oh', 'ey', 'a ver', 'dime', 'mira']),
    strong: rx(`^(?:(?:a|de|con|en|para|por|desde|hasta)\\s+)?(?:quién(?:es)?|dónde|cuál(?:es)?|cuánt[oa]s?|cuándo|cómo|qué)${B}`),
    // Typed without accents ("que pasa", "como estas", "donde vamos"): a question only in a short line.
    weak: rx(`^(?:(?:por |para )?que|quien(?:es)?|donde|adonde|cual(?:es)?|cuant[oa]s?|cuando|como)${B}`), weakMax: 4,
    aux: rx(`^(?:puedes|podr[ií]as|podeis|quieres|sabes|crees|piensas|tienes|hay(?!\\s+que))${B}`),
    tags: ['verdad', 'vale', 'cierto', 'eh', 'ok', 'okay', 'de acuerdo'],
  },
  it: {
    skip: skipper(['ehi', 'ei', 'ciao', 'senti', 'allora', 'ok', 'okay', 'e', 'ma', 'dai', 'oh', 'beh', 'bene']),
    strong: rx(`^(?:chi|cosa|che cosa|dove|dov'|perch[eé]|quale|quali|quant[oaie]|com'|cos'|ch'|c'?è|ci sono)${B}`),
    weak: rx(`^(?:che|come|quando)${B}`), weakMax: 4,
    aux: rx(`^(?:puoi|potresti|vuoi|posso|possiamo|hai|sai|c'è)${B}`),
    tags: ['vero', 'eh', 'ok', 'okay', 'giusto', 'capito', "d'accordo"],
  },
  pt: {
    skip: skipper(['ei', 'ol[áa]', 'ent[ãa]o', 'ok', 'okay', 'e', 'mas', 'bom', 'bem', 'diz', 'epa', 'oi', 'hey', 'ent[ãa]o']),
    strong: rx(`^(?:quem|o que|onde|aonde|por qu[êe]|porqu[êe]|qual|quais|quant[oa]s?)${B}`),
    weak: rx(`^(?:que|quando|como|porque)${B}`), weakMax: 4,
    aux: rx(`^(?:pode|podes|podem|consegue|consegues|quer|queres|sabe|sabes|tens)${B}`),
    tags: ['n[ée]', 'certo', 'ok', 'okay', 'hein', 't[áa]', 'verdade'],
  },
  pl: {
    skip: skipper(['hej', 'cze(?:ś|s)(?:ć|c)', 'no', 'wi(?:ę|e)c', 'ok', 'okej', 'a', 'ale', 's(?:ł|l)uchaj', 'ej', 'dobra', 'to']),
    strong: rx(`^(?:kto|kogo|komu|kim|co|czego|czemu|gdzie|dok(?:ą|a)d|sk(?:ą|a)d|dlaczego|po co|jak(?:i|a|ie|ich)|kt(?:ó|o)r(?:y|a|e|zy|ych)|ile|czyj(?:a|e)?|czy)${B}`),
    weak: rx(`^(?:jak|kiedy|jaki|jaka|jakie)${B}`), weakMax: 4,
    tags: ['prawda', 'co', 'ok', 'okej', 'dobrze'],
  },
  ru: {
    skip: skipper(['эй', 'слушай', 'ну', 'так', 'а', 'и', 'но', 'ладно', 'ок', 'окей', 'привет', 'хей', 'короче', 'ты', 'скажи']),
    strong: rx(`^(?:кто|кого|кому|кем|что|чего|чему|где|куда|откуда|почему|зачем|как(?:ой|ая|ое|ие|их|ую)|сколько|чей|чья|чьё|чьи|разве|неужели)${B}`),
    weak: rx(`^(?:как|когда)${B}`), weakMax: 4,
    anywhere: rx(`(?:^|\\s)ли${B}`),
    tags: ['ладно', 'ок', 'окей', 'верно', 'правда', 'хорошо'],
  },
  uk: {
    skip: skipper(['ей', 'слухай', 'ну', 'так', 'а', 'і', 'але', 'гаразд', 'ок', 'привіт', 'хей', 'скажи']),
    strong: rx(`^(?:хто|кого|кому|ким|що|де|куди|звідки|чому|навіщо|як(?:ий|а|е|і|их|у)|скільки|чий|чия|чиє|чиї|невже|чи)${B}`),
    weak: rx(`^(?:як|коли)${B}`), weakMax: 4,
    tags: ['добре', 'га', 'правда', 'ок', 'гаразд'],
  },
  tr: {
    skip: skipper(['hey', 'hadi', 'şey', 'peki', 'ya', 'ok', 'tamam', 'ee', 'e', 'ama', 've']),
    strong: rx(`^(?:ne(?: zaman| kadar)?|nere(?:de|ye|den|si)\\p{L}*|nerde|kim(?:in|i|e)?|neden|ni[çc]in|nas[ıi]l|hangi\\p{L}*|ka[çc])${B}`),
    anywhere: rx(`(?:^|\\s)m[ıiuü](?:s[ıiuü]n|s[ıiuü]n[ıiuü]z|y[ıiuü]m|y[ıiuü]z|yd[ıi]|d[ıi]r)?${B}`),
    tags: ['de[ğg]il mi', 'tamam', 'ok', 'di mi', 'olur mu'],
  },
  cs: {
    skip: skipper(['hej', 'ahoj', 'no', 'tak', 'takže', 'ok', 'a', 'ale', 'poslouchej', 'hele', 'dobře']),
    strong: rx(`^(?:kdo|koho|komu|kým|co|čeho|proč|kde|kam|odkud|jak(?:ý|á|é|í)|kter(?:ý|á|é|í)|kolik|čí|m(?:ů|u)žeš|m(?:ů|u)žete|chceš|chcete|um(?:í|i)š|v(?:í|i)š|zn(?:á|a)š)${B}`),
    weak: rx(`^(?:jak|kdy)${B}`), weakMax: 4,
    tags: ['že', 'ok', 'co', 'viď', 'dobře'],
  },
  hu: {
    skip: skipper(['hé', 'hey', 'szia', 'na', 'hát', 'ok', 'és', 'de', 'figyelj']),
    strong: rx(`^(?:ki|kit|kinek|mit|minek|hol|hova|honnan|miért|hogyan|melyik|milyen|mennyi(?:t)?|kié|vajon|hány)${B}`),
    weak: rx(`^(?:mikor|hogy|mi)${B}`), weakMax: 4,
    tags: ['ugye', 'ok', 'jó', 'igaz', 'oké'],
  },
  ja: {
    anywhere: /(?:何|なに|なん|どこ|いつ|だれ|誰|どう|なぜ|どうして|どれ|どの|いくつ|いくら|どちら|どなた)|(?:か|かい|かな|かね|ですか|ますか)$/u,
    full: true, tags: [],
  },
  ko: {
    anywhere: /(?:뭐|무엇|뭘|어디|언제|누구|누가|왜|어떻게|어떤|얼마|몇|무슨|어느)|(?:까|까요|니까|나요|가요|냐|있니|없니|하니|뭐니|거니)$/u,
    tags: [],
  },
  zh: {
    anywhere: /(?:吗|嗎|什么|什麼|谁|誰|哪(?:里|裡|儿|兒|个|個|些)|怎么|怎麼|怎样|怎樣|为什么|為什麼|为啥|多少|几点|幾點|几个|幾個|是不是|对不对|對不對|好不好|行不行|可不可以|能不能|有没有|有沒有|要不要|会不会|會不會)|呢$/u,
    full: true, tags: [],
  },
};
for (const language of Object.values(LANGS)) {
  const tags = language.tags.map(tag => tag.replace(/'/g, "['’]"));
  language.tail = tags.length ? rx(`[,–—-]\\s*(?:${alt(tags)})\\s*$`) : null;
}

const CYRILLIC = /[Ѐ-ӿ]/u;

/** The language rules to apply to this line: the script settles Japanese, Korean, Chinese and Cyrillic, the hint (V's plan) the rest. */
function languageOf(line, hint) {
  if (/[぀-ヿ]/u.test(line)) return 'ja';
  if (/[가-힯ᄀ-ᇿ]/u.test(line)) return 'ko';
  if (/[㐀-鿿]/u.test(line)) return hint === 'ja' ? 'ja' : 'zh';
  const base = typeof hint === 'string' ? hint.toLowerCase().split(/[-_]/)[0] : 'en';
  if (CYRILLIC.test(line)) {
    if (/[іїєґ]/iu.test(line)) return 'uk';
    if (/[ыэъё]/iu.test(line)) return 'ru';
    return base === 'uk' ? 'uk' : 'ru';
  }
  if (base === 'ru' || base === 'uk' || base === 'ja' || base === 'ko' || base === 'zh') return 'en';
  return Object.hasOwn(LANGS, base) ? base : 'en';
}

function isQuestion(line, lang) {
  const rules = LANGS[lang];
  // The last sentence of the line decides.
  const sentences = line.split(/(?<=[.!?…。！？])\s+/u);
  const last = sentences[sentences.length - 1];
  if (/^[\s"'“‘(\[]*¿/u.test(last)) return true;
  if (rules.anywhere && (lang === 'ja' || lang === 'ko' || lang === 'zh')) return rules.anywhere.test(last);
  const head = last.replace(LEADING_OPENERS, '').toLowerCase().replace(/[’`]/gu, "'");
  const rest = head.replace(rules.skip, '');
  if (!rest) return false;
  if (rules.anywhere?.test(rest)) return true;
  const words = rest.split(/\s+/u);
  if (lang === 'en') {
    if (EN_NOT_QUESTION.test(rest)) return false;
    if (EN_STRONG.test(rest)) return true;
    if (EN_WHEN.test(rest)) return words.length <= 3 || EN_AUX_WORDS.has(word(words[1]));
    if (englishAux(words)) return true;
  } else {
    if (rules.strong?.test(rest)) return true;
    if (rules.weak?.test(rest) && words.length <= (rules.weakMax ?? 3)) return true;
    if (rules.aux?.test(rest)) return true;
  }
  return false;
}

/** A trailing tag ("..., right") turns a statement into a question. */
function hasQuestionTag(line, lang) {
  const rules = LANGS[lang];
  if (rules.tail?.test(line)) return true;
  if (lang !== 'en') return false;
  // Without a comma ("we are going in quietly right"): only with enough words before, and nothing that makes "right" an adjective or a direction.
  const match = /^(.*\S)\s+(right|ok|okay|yeah|yea)$/iu.exec(line);
  if (match) {
    const before = match[1].split(/\s+/u);
    return before.length >= 3 && !TAG_BLOCK.has(word(before[before.length - 1]).toLowerCase()) && !TAG_BLOCK.has(word(before[0]).toLowerCase());
  }
  return /^.*\S\s+(?:huh|eh)$/iu.test(line);
}

const COMMA_WORDS = /^(hey|hi|hello|yo|oh|okay|ok|hmm+)(\s+)(?=\S)/iu;

function capitalise(line, lang) {
  const lead = LEADING_OPENERS.exec(line)?.[0] ?? '';
  const first = line.slice(lead.length);
  const letter = first.codePointAt(0) === undefined ? '' : String.fromCodePoint(first.codePointAt(0));
  if (!letter) return line;
  const token = first.split(/\s/u, 1)[0];
  // A link, an address, a handle or a word with a capital inside ("iPhone", "eBay") keeps its first letter.
  if (LINK.test(token) || /[@#\/\\]|:\/\//u.test(token) || /^\p{Ll}.*\p{Lu}/u.test(token.replace(/[^\p{L}]/gu, ''))) return line;
  const upper = letter.toLocaleUpperCase(lang === 'tr' ? 'tr' : undefined);
  if (upper === letter || Array.from(upper).length !== 1 || letter.toLocaleLowerCase(lang === 'tr' ? 'tr' : undefined) !== letter) return line;
  return lead + upper + first.slice(letter.length);
}

/**
 * The line as it should be handed to the voice. `language` is the turn's language code ('en', 'de', 'pt-br' ...); the script of the line
 * overrides it for Japanese, Korean, Chinese and Cyrillic. Non-strings and lines with no letter or digit come back unchanged.
 */
export function punctuateForSpeech(text, {language} = {}) {
  if (typeof text !== 'string') return text;
  let line = text.trim();
  if (!line || !/[\p{L}\p{N}]/u.test(line)) return line;
  const trimmed = line.replace(TRAILING_WEAK, '');
  if (trimmed) line = trimmed;
  const lang = languageOf(line, language);
  if (lang === 'en') {
    // "hey whats up" -> "hey, whats up" (only for a line with no punctuation inside).
    // A line the player punctuated anywhere ("Hey Judy, how are you") is left as written.
    const match = COMMA_WORDS.exec(line);
    if (match && !/[,;:.!?…]/.test(line)) line = match[1] + ',' + match[2] + line.slice(match[0].length);
  }
  line = capitalise(line, lang);
  if (endsSpecial(line) || TERMINATED.test(line.replace(CLOSERS, ''))) return line;
  const question = isQuestion(line, lang) || hasQuestionTag(line, lang);
  const full = LANGS[lang].full === true;
  return line + (question ? (full ? '？' : '?') : full ? '。' : '.');
}
