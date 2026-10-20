// The hard-limit guard of the Mature content setting (bridge/mature-content.mjs; docs/LOCAL_AI.md, "Mature content", "The hard-limit guard").
//
// Why it exists: the Mature pack's uncensored ("abliterated") models ignore the prompt's hard limits. In the 2026-10-13 test (docs/
// MATURE_MODELS_TEST_2026-10-13.md) Mature Qwen3.5-4B went along with a romance-with-a-minor prompt 5 of 5 times and Mature Gemma
// E4B 3 to 4 of 5, even with the limit written into the prompt. So the limit is enforced here, in the bridge, on the text, not left to the model:
//   input screen    V's message is read before any model request. A minor cue (an age under 18, a child, a teen, a schoolgirl,
//                   "pretend you are sixteen", a de-aging request ...) together with romantic or sexual intent refuses the turn: the model
//                   is never asked, the companion answers with a short line of her own (`refusalLine`), and nothing is stored.
//                   A small window of the last turns catches a cue in one message and the romance in the next.
//   output screen   the finished reply (and the first sentence before it is voiced) is read the same way, plus the window: a reply
//                   that puts a minor cue and romance or sex together, or that has the character claim to be under 18, is dropped and
//                   replaced by the same kind of refusal; the dropped text is never recorded in the history or the memory.
// Only the local AI, Mistral and Custom get any of this, when the setting is on (or, for the local AI, the loaded model is an uncensored one) (the host asks per turn). Everything here is regular expressions and string
// work on a message of at most 1,200 characters: well under a millisecond, no I/O, no model call, nothing per frame.
// It is deliberately over-strict: a false refusal costs one line of dialogue, a miss is the thing the pack must never do.
//
// What it logs: counters (`stats`), never the text. The host logs "refused a message (n so far)".
// The words: English is written here; the 15 interface languages' terms are in bridge/mature-guard-terms.mjs (drafted from a spec by a
// small model, reviewed by hand; each language has minor words, ages, school words, role-play markers, pronouns, sexual and romantic words).
import {TERMS} from './mature-guard-terms.mjs';

// ---- Text normalisation ------------------------------------------------------------------------------------------------------
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿]/g;
const HOMOGLYPH = new Map(Object.entries({'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ї': 'i', 'к': 'k', 'м': 'm', 'н': 'h',
  'т': 't', 'в': 'b', 'ѕ': 's', 'ј': 'j', 'ο': 'o', 'α': 'a', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ρ': 'p', 'τ': 't', 'υ': 'u', 'χ': 'x'}));
const LEET = {0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', '$': 's'};
const MIXED_SCRIPT = /(?=.*[a-z])(?=.*[Ͱ-ϿЀ-ӿ])/;
const NOT_LEET = /^\d+(?:st|nd|rd|th|yo|y\/o|yrs?|s|k|m|p|x|h|d|am|pm|cm|km|kg|mm|hz|gb|mb|tb|fps)?$/;

/**
 * The text as the screens read it: Unicode compatibility forms folded, accents and invisible characters removed, lower case,
 * letters spaced out or dotted ("k i s s", "k.i.s.s") joined, look-alike letters of another script put back. `leet` is a second
 * reading with digits and symbols inside a word turned into letters ("s1xteen"); it is null when nothing changed.
 */
/** Accents folded and lower case: the form the text and the terms are compared in (so "dítě" in a list meets "dite" typed without accents). */
export const fold = text => String(text).normalize('NFKD').replace(/[̀-ͯ]/g, '').normalize('NFC').toLowerCase();
export function normalize(text) {
  let s = fold(String(text ?? '').slice(0, 4000).replace(INVISIBLE, ''));
  s = s.replace(/[‘’ʼ`´]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ');
  // Homoglyphs: only inside a word that mixes Latin letters with Cyrillic or Greek ones.
  if (/[Ͱ-ϿЀ-ӿ]/.test(s) && /[a-z]/.test(s)) {
    s = s.replace(/\S+/g, token => MIXED_SCRIPT.test(token) ? Array.from(token, ch => HOMOGLYPH.get(ch) ?? ch).join('') : token);
  }
  // "k i s s", "k.i.s.s", "u-n-d-e-r-a-g-e": four or more single letters in a row, joined by spaces or dots.
  s = s.replace(/(?<![\p{L}\p{N}])(?:\p{L}[ ._*\-]){3,}\p{L}(?![\p{L}\p{N}])/gu, run => run.replace(/[ ._*\-]/g, ''));
  // "1 5": two digits typed apart read as one number (an age).
  s = s.replace(/(?<![\d.,:/$])1 ([0-7])(?![\d.,:%])/g, '1$1');
  let changed = false;
  const leet =s.replace(/\S+/g, token => {
    if (NOT_LEET.test(token) || !/[a-z].*[a-z]|[a-z].*[@$]/.test(token) || !/[013457@$]/.test(token)) return token;
    const mapped = token.replace(/[013457@$]/g, ch => LEET[ch]);
    if (mapped !== token) changed = true;
    return mapped;
  });
  // "sch*olgirl", "k#ss": a symbol standing in for one letter inside a word is read as each vowel in turn (only when such a word is there).
  const wild = /\p{L}[*#]\p{L}/u.test(s) ? ['a', 'e', 'i', 'o', 'u'].map(vowel => s.replace(/(\p{L})[*#](\p{L})/gu, `$1${vowel}$2`)) : [];
  return {plain: s, leet: changed ? leet : null, wild};
}

// ---- The terms ------------------------------------------------------------------------------------------------------------------

const escape = text => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
// Words as a trie, written as a regular expression: a long alphabetical list costs one pass over the text, not one per word.
// A trailing "*" makes a word a stem (any letters may follow); a space inside a phrase matches any run of white space.
function trieSource(terms) {
  const root = {};
  for (const raw of terms) {
    const stem = raw.endsWith('*');
    const word = (stem ? raw.slice(0, -1) : raw).trim();
    if (!word) continue;
    let node = root;
    for (const ch of word) node = node[ch] ??= {};
    node[stem ? '\u0001' : '\u0000'] = true;
  }
  const walk = node => {
    if (node['\u0001']) return '\\p{L}*';
    const alternatives = Object.keys(node).filter(key => key !== '\u0000').sort().map(key => (key === ' ' ? '\\s+' : escape(key)) + walk(node[key]));
    if (node['\u0000']) alternatives.push('');
    return alternatives.length === 1 ? alternatives[0] : `(?:${alternatives.join('|')})`;
  };
  return walk(root);
}
const FRONT = '(?<![\\p{L}\\p{N}])';
const BACK = '(?![\\p{L}\\p{N}])';
const trieRegex = (terms, {bounded = true} = {}) => {
  const list = [...new Set(terms.map(item => fold(String(item).trim())).filter(Boolean))];
  if (!list.length) return /(?!)/u;
  return new RegExp(bounded ? `${FRONT}(?:${trieSource(list)})${BACK}` : `(?:${trieSource(list)})`, 'iu');
};

// Languages whose words are not set apart by spaces (or carry their endings on the word): matched without word boundaries.
const UNBOUNDED = new Set(['ja', 'ko', 'zh-cn', 'zh-tw']);

// ---- English --------------------------------------------------------------------------------------------------------------------

const NUMBER_WORD = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|'
  + 'fiveteen|fifthteen|fiftheen|sixteeen|sixtene|seveteen|sevnteen|fourten|fourtheen|thirten|elleven|twelfe';
// Every age under 18 for a number that says "years old"; for a bare number after "I am" / "you are" only 6 to 17 (a child's "I'm 3" is
// not met in talk, while "I'm one of ...", "you're two steps behind" are).
const NUM = `(?:1[0-7]|0?[1-9]|(?:${NUMBER_WORD}))`;
const NUM_BARE = '(?:1[0-7]|[6-9]|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|fiveteen|fifthteen|fiftheen|sixteeen|sixtene|seveteen|sevnteen|fourten|fourtheen|thirten|elleven|twelfe)';
const NOT_NUMBER_AFTER = '(?![\\d.,:/%]\\d|[\\d%]|\\.\\d|,\\d)';
// A word boundary follows ("you're tender", "as a tendency" are not "ten"); a digit may carry one letter, as in "I'm 16f".
const NUM_ONLY = `(?<![\\d.,:/$€£#+\\-])${NUM_BARE}${NOT_NUMBER_AFTER}(?:(?![\\p{L}])|(?<=\\d)[mf](?![\\p{L}]))`;
// A number that is not an age: what follows it says so.
const NOT_AGE_UNIT = '(?!\\s*(?:min|mins|minute|minutes|hour|hours|hr|hrs|sec|secs|second|seconds|day|days|week|weeks|month|months|feet|foot|ft|inch|inches|cm|mm|meter|meters|metre|metres|m\\b|km|mile|miles|block|blocks|street|streets|percent|%|degrees?|euro|euros|eddie|eddies|credit|credits|dollar|dollars|buck|bucks|kilo|kilos|kg|lb|lbs|pound|pounds|floor|floors|level|levels|away|out|from|off|late|early|short|tall|deep|tick|ticks|round|rounds|times|k\\b|am\\b|pm\\b|o\'clock|years?\\b(?!\\s*-?\\s*old)|steps?|yards|bullets?|shots?|guys|men|people|more|less|of them|of us|different|cops|grams?|drinks?|beers?|cups?|rooms?|doors?|cars?|bikes?|hits?|kills?|clicks?|units?|points?|credits?))';

const AGE_OLD = new RegExp(`(?<![\\d.,:/$€£#+\\-])${NUM}${NOT_NUMBER_AFTER}\\s*-?\\s*(?:years?\\s*-?\\s*olds?|yrs?\\s*-?\\s*olds?|y\\/o|y\\.o\\.?|yo|(?:years?|yrs?)\\s+of\\s+age|years?\\s+young)(?![\\p{L}])`, 'iu');
const AGE_FILLER = '(?:(?:only|just|still|almost|nearly|about|barely|not\\s+even|like|actually|really|exactly|now|currently|already|even|a\\s+mere|an?)\\s+){0,3}';
// "I am 15", "you're sixteen": the speaker or the listener.
const AGE_DIRECT = new RegExp(`(?<![\\p{L}\\p{N}])(?:i\\s*(?:am|m|'m)|im|i\\s*(?:turn|will\\s+turn|will\\s+be|'ll\\s+be|ll\\s+be|'m\\s+turning|am\\s+turning|just\\s+turned|have\\s+just\\s+turned)|you\\s*(?:are|'re|re|r)|youre|ur|u\\s*r|u\\s*are|ure|we\\s*(?:are|'re|re)|we\\s+both\\s+are|you(?:'ll|\\s+will)\\s+be|you\\s*(?:look|seem|act|feel|sound|appear)(?:ed)?\\s*(?:like\\s*)?|you\\s*(?:could\\s+pass\\s+for|pass\\s+for|must\\s+be)|us\\s*being|me\\s*being)\\s*${AGE_FILLER}${NUM_ONLY}${NOT_AGE_UNIT}`, 'iu');
// "be fifteen", "act 14", "play a 13": only when it is a request, so ages from ten up.
const AGE_ACT = new RegExp(`(?<![\\p{L}\\p{N}])(?:be|being|become|becoming|act|acting|play|playing|pretend\\s+to\\s+be|pretending\\s+to\\s+be|as)\\s+${AGE_FILLER}(?<![\\d.,:/$€£#+\\-])(?:1[0-7]|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen)${NOT_NUMBER_AFTER}(?![\\p{L}])${NOT_AGE_UNIT}`, 'iu');
// "I was 16", "when we were fifteen", "at the age of 14": a memory (unless the text is role-play).
const AGE_PAST = new RegExp(`(?<![\\p{L}\\p{N}])(?:(?:i|we|you|they|he|she)\\s*(?:was|were|turned|had\\s+turned|hit)|when\\s+(?:i|we|you|they|he|she)\\s*(?:was|were|turned|hit|got\\s+to)|back\\s+when\\s+(?:i|we|you)\\s*(?:was|were)|at\\s+the\\s+age\\s+of|at\\s+age|since\\s+i\\s+was|until\\s+i\\s+was)\\s*${AGE_FILLER}${NUM_ONLY}${NOT_AGE_UNIT}`, 'iu');
// "she's 15", "aged 12", "turning 14": someone else, a general cue
const AGE_OTHER = new RegExp(`(?<![\\p{L}\\p{N}])(?:(?:she|he|they|it|that|this)\\s*'?s|is|'s|are|'re|was|were|like|maybe|say|around|about|more\\s+like|aged?|age\\s+of|ages|age:?|turned|turning|turns|about\\s+to\\s+turn|just\\s+turned)\\s*${AGE_FILLER}${NUM_ONLY}(?=\\s*(?:$|[,.;:!?)]|and\\b|but\\b|so\\b|now\\b|though\\b|btw\\b|yet\\b|today\\b|then\\b|years|y\\/?o|yo\\b|or\\b|who\\b|with\\b|in\\b|going\\b|next\\b|this\\b|tho\\b|lol\\b|haha|okay\\b|ok\\b))${NOT_AGE_UNIT}`, 'iu');
// "my 16th birthday", "her sixteenth birthday", "I was born in 2011", "my little sister, 13,", "16f here": other ways to say an age.
const ORDINAL_AGE = '(?:6th|7th|8th|9th|1[0-7]th|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth)';
const AGE_BIRTHDAY = new RegExp(`(?<![\\p{L}\\p{N}])(?:my|your|our|his|her|their|the)\\s+${ORDINAL_AGE}\\s+birthday`, 'iu');
const AGE_BORN = /(?<![\p{L}\p{N}])born\s+(?:in\s+|on\s+|around\s+)?(?:[a-z]+\s+\d{0,2},?\s*)?20(?:09|1\d|2[0-6])(?![\d])/iu;
const BORN_SELF = /(?<![\p{L}\p{N}])(?:i|you|we|u|ur|im|you're|i'm)(?![\p{L}\p{N}])[^.!?;]{0,12}$/iu;
const AGE_APPOS =new RegExp(`(?<![\\p{L}\\p{N}])(?:girl|boy|sister|brother|cousin|daughter|son|niece|nephew|student|girlfriend|boyfriend|friend|kid|twin|babysitter)\\s*,\\s*${NUM_ONLY}(?=\\s*(?:$|[,.;:!?)]|and\\b|who\\b))`, 'iu');
const AGE_TAG = /(?<![\p{L}\p{N}.,:/$€£#+-])(?:1[0-7])\s?[mf](?![\p{L}\p{N}])(?!\s*(?:away|from|out|off|tall|deep|long|high|wide|thick|apart|below|above|ahead|behind|ago|under|over))/iu;
// An age with no word for "years": "Ich bin 14.", "Je mi 14.", "Мне 14." (the speaker or the listener, a number from 6 to 17 closing the clause).
const AGE_UNITLESS = /(?<![\p{L}\p{N}])(?:ich\s+bin|du\s+bist|j'ai|tu\s+as|tengo|tienes|soy|eres|sono|sei|tenho|tem|sou|mam|masz|jestem|jesteś|je\s+mi|je\s+ti|jsem|jsi|мне|тебе|мені|тобі)\s+(?:1[0-7]|[6-9])(?=\s*(?:$|[.,;:!?)]|und\b|et\b|y\b|aber\b|pero\b|mais\b|ale\b|и\b|і\b|та\b|але\b))/iu;
// A pretence about being a minor, whatever words it uses ("pretend you are not an adult", "act like you can't vote yet").
const NOT_ADULT = /(?<![\p{L}\p{N}])(?:not\s+(?:an?\s+)?(?:adult|grown|of\s+age|old\s+enough|legal)|(?:isn't|aren't|wasn't|weren't|'s\s+not|'re\s+not)\s+(?:an?\s+)?(?:adult|grown|of\s+age|old\s+enough|legal)|can't\s+(?:vote|drink|drive)\s+yet|too\s+young|still\s+(?:growing\s+up|in\s+school|a\s+student|at\s+school|young)|underage|not\s+yet\s+(?:18|eighteen|a\s+woman|a\s+man|grown))(?![\p{L}\p{N}])/iu;

const GRADE_NUM = '(?:[1-9]|1[0-2]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
const GRADE = new RegExp(`(?<![\\p{L}\\p{N}])(?:(?:\\d{1,2}(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth)\\s*-?\\s*(?:grade|grader|graders|form)\\b|grade\\s*${GRADE_NUM}(?![\\d.,]\\d|\\s*(?:steel|armor|armour|weapon|chrome|gear|cyberware|military|material))\\b|(?:in|into|at|entering|starting|finishing|repeating) (?:year|yr|form) (?:[7-9]|1[0-3]|seven|eight|nine|ten|eleven|twelve|thirteen)\\b|year (?:[7-9]|1[0-3]) (?:student|pupil|kid|girl|boy|class)|sweet (?:16|sixteen))`, 'iu');
const SCHOOL = new RegExp('(?<![\\p{L}\\p{N}])(?:(?:high|middle|elementary|primary|secondary|grammar|prep|junior high|junior|grade)[- ]?school(?:er|ers|ers?|s)?|junior high|jr high|kindergarten(?:er|ers)?|pre-?school(?:er|ers)?|nursery school|homeroom|school ?(?:uniform|yard|bus|girl|boy|kid|child|children|class|lunch|dance|crush|trip)s?|school-?age[d]?|high-?schooler|middle-?schooler|seventh grader|eighth grader|freshman in high|sophomore in high|student council|study hall|detention)(?![\\p{L}\\p{N}])', 'iu');

// Words for a person under 18. "minor" and "child" have other meanings: "minor" counts as a person only in the forms that mean one.
const MINOR_WORDS_EN = ['underage*', 'under-age*', 'under age', 'barely legal', 'under 18', 'under eighteen', 'below 18', 'below eighteen', 'less than 18', 'not yet 18', 'not yet eighteen',
  'not 18', 'not eighteen', 'jailbait', 'loli', 'lolis', 'lolita', 'lolitas', 'lolicon*', 'shota', 'shotas', 'shotacon*', 'pedo', 'pedos', 'pedophil*', 'paedo', 'paedos', 'paedophil*', 'ephebophil*', 'hebephil*',
  'preteen*', 'pre-teen*', 'pre teen*', 'teen', 'teens', 'teenage', 'teenaged', 'teenager', 'teenagers', 'tween', 'tweens', 'adolescen*', 'juvenile', 'juveniles',
  'child', 'children', 'childlike', 'kid', 'kids', 'kiddo', 'kiddos', 'kiddie', 'kiddies', 'toddler*', 'infant', 'infants', 'newborn*', 'babies',
  'younger girl', 'younger girls', 'younger boy', 'younger boys', 'younger kids', 'little girl', 'little girls', 'little boy', 'little boys', 'young girl', 'young girls', 'young boy', 'young boys', 'little one', 'little ones', 'small girl',
  'small boy', 'tiny girl', 'tiny boy', 'wee girl', 'wee boy', 'young kid*', 'young child*', 'schoolgirl*', 'school girl*', 'schoolboy*', 'school boy*', 'schoolchild*',
  'school child*', 'school kid*', 'highschooler*', 'high schooler*', 'middle schooler*', 'grade schooler*', 'elementary schooler*', 'ageplay*', 'age play*', 'age-play*',
  'littlespace', 'ddlg', 'ddlb', 'cgl', 'underaged', 'minor girl', 'minor boy', 'minor child', 'legal minor', 'minors'];
// "a minor", "being a minor" ...: only where it is the person ("a minor injury" is not).
const MINOR_PERSON = /(?<![\p{L}\p{N}])(?:a|an|the|being|is|are|was|were|be|as|still|only|just|am|i'm|you're|she's|he's)\s+(?:legal\s+|actual\s+|real\s+)?minor(?=\s*(?:$|[.,;:!?)]|and\b|but\b|or\b|who\b|with\b|in\b|for\b|to\b|so\b|then\b|girl|boy|child))/iu;
// "make you younger", "your younger self": a request to be made younger.
const DEAGE = /(?<![\p{L}\p{N}])(?:(?:make|made|making|turn|turned|turning|be|being|become|becoming|act|acting|look|looking|appear|appearing|seem|feel|play|playing|pretend\s+to\s+be|pretend\s+(?:you(?:'re| are)|i(?:'m| am)|we(?:'re| are))|imagine\s+(?:you(?:'re| are)|i(?:'m| am)|we(?:'re| are)))\s+(?:you\s+|her\s+|him\s+|me\s+|us\s+|yourself\s+|them\s+)?(?:a\s+)?(?:lot\s+|much\s+|way\s+|bit\s+|little\s+|so\s+|even\s+|far\s+|a\s+little\s+|a\s+bit\s+|slightly\s+|just\s+)?younger|age\s+(?:you\s+|her\s+|him\s+|me\s+|us\s+|yourself\s+|them\s+)?down|de-?ag(?:e|ed|ing)|rejuvenat\w*|regress(?:ed|ing|ion)?\s+(?:you\s+|her\s+|him\s+|me\s+|us\s+)?(?:to|into|back)|(?:your|her|his)\s+(?:younger|teen(?:age)?|child(?:hood)?|kid|school)\s+self|younger\s+version\s+of|(?:baby|child|kid|teen)\s*-?\s*(?:face|faced|like)|turn\s+back\s+(?:in)?to\s+a\s+(?:kid|child|girl|boy|teen)|shrink\w*\s+(?:you|her|him)\s+(?:down\s+)?(?:to|into)\s+a\s+(?:kid|child|girl|boy))(?![\p{L}\p{N}])/iu;
// Distinctive long words that are looked for once the text is squeezed ("u n d e r a g e", "school_girl", "teen*ager").
const SQUEEZED = /(?:underage|schoolgirl|schoolboy|teenager|preteen|toddler|jailbait|pedophil|paedophil|lolicon|shotacon|ageplay)/;

// Role-play and pretence words, and V's pronouns.
const ROLEPLAY_EN = /(?<![\p{L}\p{N}])(?:pretend\w*|imagin\w*|role-?\s?play\w*|rp|cosplay\w*|act(?:ing|s)?\s+(?:like|as|if)|play(?:ing)?\s+(?:a|an|the|as|like|along|that|my)|let'?s\s+say|lets\s+say|what\s+if|as\s+if|suppose|supposing|dress(?:ed|ing)?\s+(?:up\s+)?(?:as|like)|make\s+(?:you|her|him|me|us|it|believe)|turn(?:ed)?\s+(?:you|her|him|me|us|into)|become|becomes|became|fantas\w+|scenario|scene\s+where|in\s+this\s+story|story\s+where|game\s+where|hypothetical\w*|just\s+for\s+fun|as\s+a\s+game|for\s+the\s+sake\s+of|if\s+you\s+were|if\s+i\s+were|if\s+we\s+were|would\s+you\s+if|you\s+are\s+now|from\s+now\s+on)(?![\p{L}\p{N}])/iu;
const PRONOUN_EN = /(?<![\p{L}\p{N}])(?:i|i'm|im|i've|i'd|i'll|ive|me|myself|we|we're|us|you|you're|youre|you've|you'd|you'll|ur|u|ure|yourself|yourselves|your)(?![\p{L}\p{N}])/iu;
const POSSESSIVE_BEFORE = /(?<![\p{L}\p{N}])(?:my|your|his|her|their|our|its|\w+'s)\s+(?:(?:little|young|baby|kid|big|older|younger|twin|step|half|new|only|youngest|eldest|oldest|own)\s+){0,2}$/iu;
const PAST_BEFORE = /(?:(?:i|we|you|they|he|she)\s+(?:was|were|had been|used to be)|when\s+(?:i|we|you|they|he|she)\s+(?:was|were)|back\s+(?:then|when|in)|as\s+(?:an?|kids|children|teens)|growing\s+up|grew\s+up|at\s+(?:the\s+)?age\s+of|since\s+(?:i|we)\s+(?:was|were)|until\s+(?:i|we)\s+(?:was|were)|when\s+(?:i|we)\s+(?:was|were)\s+(?:in|a|an)|remember\s+when|years\s+ago|ages\s+ago|once\s+(?:was|were))\s*(?:(?:only|just|still|about|around|almost|nearly|barely|like|an?|the|my|in|at|then)\s+)*$/iu;

// Sexual and romantic intent. Expletives are not intent: "fuck" counts only in its sexual forms, "dick" not as an insult.
const SEXUAL_EN = new RegExp(`(?<![\\p{L}\\p{N}])(?:sex|sexy|sexual\\w*|sexting|sexed|sexes|naked|nude|nudes|nudity|topless|bottomless|undress\\w*|disrobe\\w*|strip(?:s|ped|ping|per|pers|tease)?|orgasm\\w*|cum|cumming|cums|cumshot\\w*|arous\\w*|erotic\\w*|erotica|horny|seduc\\w*|molest\\w*|grop(?:e|ed|es|ing)|rap(?:e|ed|es|ing|ist|ists)|fondl\\w*|masturbat\\w*|jerk(?:ing)? off|blow-?\\s?jobs?|hand-?\\s?jobs?|nipples?|genitals?|genitalia|penis|penises|cocks?|(?<!(?:a|such a|being a|be a|total|real|big|stupid|dumb|little|complete|absolute) )dicks?|pussy|pussies|vagina\\w*|vulva|clit\\w*|tits|titties|boobs?|boobies|breasts?|bosom|cleavage|lingerie|panties|panty|thongs?|knickers|underwear|undies|bras?|kinky|kink|fetish\\w*|bondage|spank\\w*|submissive|dominatrix|lust\\w*|moan\\w*|virgin\\w*|foreplay|intercourse|intimate\\s+parts|private\\s+parts|make\\s+love|making\\s+love|made\\s+love|(?:have|having|had|has)\\s+sex|(?:sleep|sleeping|slept)\\s+with\\s+(?:me|you|her|him|us|them)|hook(?:ing|ed)?\\s*-?\\s*up\\s+with|hookup|one\\s+night\\s+stand|get\\s+laid|getting\\s+laid|bang(?:ing|ed)?\\s+(?:me|you|her|him|us)|screw(?:ing|ed)?\\s+(?:me|you|her|him|us)|turn(?:s|ed|ing)?\\s+(?:me|you|him|her)\\s+on|turn\\s*-?\\s*on|turned\\s+on|touch(?:ing|ed)?\\s+(?:me|you|yourself|myself|her|him)\\s+(?:there|down|between|under|inside|all over|everywhere)|take\\s+off\\s+(?:your|her|his|my|the)\\s+(?:clothes|clothing|shirt|top|dress|pants|jeans|skirt|bra|underwear|shorts|panties|pajamas|pjs|robe|towel)|pants\\s+down|(?:clothes|clothing|shirt|top|dress|pants|jeans|skirt|bra|underwear|shorts|panties|pajamas|robe|towel)\\s+off|take\\s+(?:it|them|that|those)\\s+off|skinny\\s*-?\\s*dip\\w*|get(?:ting)?\\s+(?:naked|undressed)|sit\\s+on\\s+my\\s+(?:lap|face)|between\\s+(?:your|her|my)\\s+(?:legs|thighs)|bare\\s+(?:skin|chest|breasts)|f(?:u|\\*|#|@|v)ck(?:ed|ing|s)?\\s+(?:me|her|him|them|each\\s+other|around|buddy|buddies|toy)|(?:wanna|want\\s+to|gonna|going\\s+to|let'?s|lets|gotta|have\\s+to|need\\s+to|to|and|should|can\\s+i|can\\s+we|could|would|will|please)\\s+f(?:u|\\*|#|@|v)ck(?![\\p{L}])|fucked\\s+(?:by|up\\s+the\\s+ass)|f(?:u|\\*|#)cking\\s+(?:me|each\\s+other)|rimjob|anal|oral|(?:suck|sucking|sucked|lick|licking|licked)\\s+(?:me|you|it|her|him|my|your|his)|nsfw|porn\\w*|hentai|xxx|smut|lewd\\w*|ecchi|naughty|dirty\\s+(?:talk|things|thoughts)|dirty\\s+mind|bedroom\\s+eyes|bedroom\\s+voice|ride\\s+(?:me|you)|riding\\s+(?:me|you)|mount\\s+(?:me|you)|spread\\s+(?:your|her)\\s+legs|on\\s+(?:your|my)\\s+knees|daddy\\s+(?:kink|dom)|breed\\w*\\s+(?:me|you|her))(?![\\p{L}\\p{N}])`, 'iu');
const ROMANTIC_EN = new RegExp(`(?<![\\p{L}\\p{N}])(?:kiss(?:es|ed|ing)?|smooch\\w*|snog\\w*|make\\s*-?\\s*out|making\\s+out|makeout|makes?\\s+out\\s+with|flirt\\w*|cuddl\\w*|snuggl\\w*|spoon(?:ing)?\\s+(?:me|you)|hold(?:ing)?\\s+hands|holding\\s+my\\s+hand|hand\\s+in\\s+hand|romanc\\w*|romantic\\w*|love\\s+you|luv\\s+(?:you|u)|love\\s+u|let'?s\\s+date|let\\s+us\\s+date|to\\s+date\\s+(?:you|me|her|him)|date\\s+you|ily|love\\s+me|loves\\s+me|in\\s+love|fall(?:ing)?\\s+(?:for|in\\s+love)|fell\\s+(?:for|in\\s+love)|crush(?:es)?\\s+on|have\\s+a\\s+crush|(?:my|a|his|her|your)\\s+crush|girlfriends?|boyfriends?|gfs?|bfs?|lovers?|sweethearts?|darling|babe|(?:my|a|his|her|your)\\s+(?:honey|sweetie|sweetheart)|marry\\s+(?:me|you)|marriage\\s+with|be\\s+my\\s+(?:wife|husband|girl|boy|girlfriend|boyfriend|lover|baby|babe|woman|man|queen|king|bride|groom|valentine|mistress|partner|date)|be\\s+mine|(?:go(?:ing)?\\s+on|on|have|had|having|ask(?:ed|ing)?\\s+(?:me|you|her|him)\\s+on|take\\s+(?:me|you|her)\\s+on|a|our|your|my|first|second|hot|romantic|blind|dinner|movie|real|proper|secret)\\s+dates?|dating|dated|date\\s+(?:me|you|her|him|each\\s+other|night)|ask(?:ing|ed)?\\s+(?:me|you|her|him)\\s+out|take\\s+(?:me|you|her|him)\\s+out\\s+(?:on|for|to)|go\\s+out\\s+with\\s+(?:me|you|him|her)|going\\s+out\\s+with\\s+(?:me|you|him|her)|go\\s+steady|seeing\\s+(?:each\\s+other|you|me)\\s+romantic\\w*|touch(?:ing)?\\s+(?:me|you|her|him)|touched\\s+(?:me|you|her|him)|caress\\w*|fondl\\w*|embrac\\w*\\s+(?:me|you)|(?:your|my|our|his|her)\\s+bed|bed\\s+(?:with|together)|(?:my|your|our)\\s+bedroom|(?:to|in|into)\\s+(?:the|my|your)\\s+bedroom|bedtime\\s+with|to\\s+bed\\s+with|come\\s+to\\s+bed|(?:take|bring|carry|lead|drag|get|put|tuck|follow|join|invite|get\\s+into|get\\s+in)\\s+(?:me|you|us|her|him|them)\\s+(?:in|into|to|onto|on)\\s+(?:the\\s+|a\\s+|your\\s+|my\\s+|his\\s+|her\\s+|our\\s+)?bed|in\\s+bed\\s+(?:with|together)|(?:get|getting|go|going|went)\\s+(?:in|into|to)\\s+bed\\s+(?:with|together)|share\\s+(?:a|the|my|your)\\s+bed|sharing\\s+(?:a|the|my|your)\\s+bed|(?:sleep|sleeping|slept)\\s+(?:next\\s+to|beside|together|in\\s+my|in\\s+your|in\\s+the\\s+same)|spend\\s+the\\s+night|stay\\s+the\\s+night|stay\\s+over|tuck\\s+(?:me|you)\\s+in|intimate|intimacy|passionate\\w*|sensual\\w*|seductive\\w*|you\\s+look\\s+(?:so\\s+|really\\s+|very\\s+|damn\\s+|fucking\\s+)?(?:hot|sexy|gorgeous|stunning|alluring|irresistible|attractive)|you(?:'re|\\s+are|re)\\s+(?:so\\s+|really\\s+|very\\s+|damn\\s+|fucking\\s+)?(?:hot|sexy|gorgeous|stunning|alluring|irresistible|attractive)|so\\s+hot|want\\s+you\\s+(?:so\\s+(?:bad|much)|badly|tonight|now|closer)|need\\s+you\\s+(?:so\\s+(?:bad|much)|badly|tonight)|crave\\s+you|desire\\s+you|your\\s+lips|my\\s+lips|body\\s+(?:to|against)\\s+(?:body|mine|yours)|against\\s+(?:me|you)\\s+(?:tight|close)|hold\\s+(?:me|you)\\s+(?:close|tight)|hold\\s+me\\s+(?:all\\s+night|tonight)|mommy|mommies|babygirl|baby\\s+girl)(?![\\p{L}\\p{N}])`, 'iu');
// Fixed expressions that carry a word of those lists without the meaning.
const IDIOMS_EN = /(?<![\p{L}\p{N}])(?:kiss\s+(?:my|your|his|her|their)\s+(?:ass|butt|boots|feet|rings?|shoes)|kiss\s+(?:of\s+death|it\s+goodbye|goodbye|and\s+tell|up\s+to|off)|kiss\s+ass|kissing\s+(?:ass|up\s+to)|date\s+of\s+birth|up\s+to\s+date|out\s+of\s+date|up-to-date|out-of-date|save\s+the\s+date|release\s+date|expiry\s+date|expiration\s+date|due\s+date|(?:what|today's|the|that|which)\s+date|dating\s+(?:from|back|to)|(?:blind|sex)\s+date\s+with\s+death|fuck\s+(?:you|off|this|that|it|them|him|her|me\s+up|up)|fucking\s+(?:kid|child|kids|children|teen|teens|brat|brats)|sexy\s+(?:beast|chrome|ride|car|bike|gun)|cum\s+laude|stripped\s+(?:of|down|for\s+parts|the|his|her)|strip\s+(?:mall|club|search|the|down|it)|stripped|stripping\s+(?:the|it|down|parts)|naked\s+eye|nude\s+(?:color|colour|tone|lipstick)|bras\s+d'|anal\s+(?:ysis|yze|yst)|oral\s+(?:history|tradition|report|exam)|intimate\s+(?:knowledge|details|friend)|lust\s+for\s+(?:life|power|blood|revenge|gold)|passionate\s+(?:about|speech)|moan\s+about|moaning\s+about|virgin\s+(?:mary|islands|territory|land|water|oil|mojito)|(?:no|don't|stop)\s+(?:kidding)|breast\s+(?:plate|pocket|cancer|stroke)|crush\s+(?:you|him|her|them|your|his|their)\b|crush(?:ed|ing)?\s+(?:the|a|his|her|their|my|your|skulls?|bones?|it)\b|(?:bed|bedroom)\s+(?:and\s+breakfast|frame|sheet)|stay\s+over\s+(?:there|here|at)|lingerie\s+shop|hot\s+(?:dog|day|coffee|take|shot)|so\s+hot\s+(?:today|outside|in\s+here|out\s+here)|it'?s\s+so\s+hot|child\s+(?:of\s+the|support|labor|labour|protective|welfare|services)|(?:inner|man)\s+child|kinder\s+(?:\w+\s+)?(?:than|to|toward|towards|of|with))(?![\p{L}\p{N}])/iu;
// Fixed expressions where a word for a minor is not one ("a kinder soul", "child support", "inner child"). Only these are taken out before the
// cues are read; the swearing idioms above are not, so "you're a fucking kid" keeps its cue.
const CUE_IDIOMS_EN = /(?<![\p{L}\p{N}])(?:kinder\s+(?:\w+\s+)?(?:than|to|toward|towards|of|with)|child\s+(?:support|labor|labour|protective|welfare|services|of\s+the\s+(?:night|streets|city|corps?|dark))|(?:inner|man)\s+child)(?![\p{L}\p{N}])/giu;
// A romantic wish aimed at someone who is not V or the character: "her", "him", "that girl", "the kid" (for the window's third-party cues).
const THIRD_OBJECT = /(?<![\p{L}\p{N}])(?:her|him|them|she|he|they|that\s+(?:girl|boy|kid|child|one)|the\s+(?:girl|boy|kid|child|one)|this\s+(?:girl|boy|kid|child|one))(?![\p{L}\p{N}])/iu;

/// ---- The other languages ----------------------------------------------------------------------------------------------------------

const KEYS = ['minor', 'ageUnits', 'numbers', 'school', 'roleplay', 'pronouns', 'sexual', 'romantic', 'idioms'];
function otherLanguages(terms) {
  const sets = [Object.fromEntries(KEYS.map(key => [key, []])), Object.fromEntries(KEYS.map(key => [key, []]))];
  for (const [lang, entry] of Object.entries(terms)) {
    const target = sets[UNBOUNDED.has(lang) ? 1 : 0];
    for (const key of KEYS) {
      const value = key === 'numbers' ? Object.entries(entry.numbers ?? {}).filter(([n]) => Number(n) >= 1 && Number(n) <= 17).flatMap(([, words]) => words) : entry[key];
      if (Array.isArray(value)) target[key].push(...value);
    }
  }
  return sets.map((set, index) => {
    const bound = index === 0;
    const make = key => trieRegex(set[key], {bounded: bound});
    const unique = list => [...new Set(list.map(item => fold(String(item).trim())).filter(Boolean))];
    const units = unique(set.ageUnits).filter(unit => unit.replace(/[^\p{L}]/gu, '').length >= (bound ? 2 : 1));
    const numbers = unique(set.numbers);
    const unitSource = units.length ? trieSource(units) : '(?!)';
    // "let 12" and "ev 7" are ordinary English when the unit comes first, so those two units are used only after a number.
    const firstUnits = units.filter(unit => !['let', 'ev', 'év'].includes(unit));
    const firstSource = firstUnits.length ? trieSource(firstUnits) : '(?!)';
    const numberSource = numbers.length ? trieSource(numbers) : '(?!)';
    const lead = bound ? FRONT : '';
    const tail = bound ? BACK : '';
    const idioms = unique(set.idioms);
    return {
      minor: make('minor'), school: make('school'), roleplay: make('roleplay'), pronouns: make('pronouns'), sexual: make('sexual'), romantic: make('romantic'),
      idioms: idioms.length ? new RegExp(`${lead}(?:${trieSource(idioms)})${tail}`, 'giu') : null,
      // "15 años", "15歳", "fifteen jahre alt": a number under 18 followed by a word for years
      age: new RegExp(`(?<![\\d.,:/$€£#+\\-])(?:1[0-7]|0?[1-9])\\s*-?\\s*(?:${unitSource})${tail}|${lead}(?:${numberSource})\\s*-?\\s*(?:${unitSource})${tail}`, 'iu'),
      // "age 15", "alter: 15" (the word first)
      ageFirst: new RegExp(`${lead}(?:${firstSource})\\s*:?\\s*(?:1[0-7]|0?[1-9])(?![\\d.,:/%])`, 'iu'),
    };
  });
}
const OTHER = otherLanguages(TERMS);
const anyOther = (text, key) => OTHER.some(set => set[key].test(text));

// ---- Analysis -----------------------------------------------------------------------------------------------------------------------

const CLAUSE = /[.!?;\n…。！？]+/;
const MINOR_WORDS = trieRegex(MINOR_WORDS_EN);
const globalRe = re => new RegExp(re.source, 'giu');
const [AGE_OLD_G, MINOR_PERSON_G, MINOR_WORDS_G, GRADE_G, SCHOOL_G] = [AGE_OLD, MINOR_PERSON, MINOR_WORDS, GRADE, SCHOOL].map(globalRe);
// A bare number from 6 to 17 (the pretence and a pronoun make it an age, in any language).
const BARE_AGE_G = new RegExp(`(?<![\\d.,:/$€£#+\\-])(?:1[0-7]|[6-9])(?![\\d%]|[.,:/]\\d)${NOT_AGE_UNIT}`, 'giu');
// Words that name a minor and a sexual act in one: they count as both.
const EXPLICIT = /(?<![\p{L}\p{N}])(?:age[- ]?play\w*|little-?space|ddl[gb]|loli(?:con)?s?\s+(?:porn|content|hentai)|lolicon\w*|shotacon\w*|jailbait|child\s+porn\w*|kiddie\s+porn\w*|cp\s+(?:video|pic|vid)s?)(?![\p{L}\p{N}])/iu;
// Who a cue is about: a self-pronoun just before it ("you're a kid", "i'm still in 10th grade"), but not "my kid sister", "with the kids".
const SELF_BEFORE = /(?<![\p{L}\p{N}])(?:you|youre|you're|u|ur|i|im|i'm|i've|i'd|i'll|we|we're|us|me|myself|yourself|my age|your age|our age)(?![\p{L}\p{N}])[^.!?;]{0,24}$/iu;
const OF_OTHERS_BEFORE = /(?<![\p{L}\p{N}])(?:with|to|for|about|of|from|near|by|around|among|than|and|or|the|those|these|some|any|other|another|all|how|between)\s+(?:(?:the|those|these|some|all|other|two|three|many|a\s+few|few)\s+)?$/iu;

// What a stretch of text says. directed: someone in the talk (V or the character) is the minor; general: a minor is mentioned; memory: V's own
// past ("I was 16 when ..."); intent 0 none, 1 romantic, 2 sexual; roleplay: pretence is in the text; requestToAge: a request to be or play
// younger (role-play or de-ageing); thirdObject: the wish is aimed at "her", "him", "that girl".
function analyseVariant(s) {
  const out = {directed: 0, general: 0, memory: 0, intent: 0, roleplay: false, requestToAge: false, thirdObject: false};
  if (!s.trim()) return out;
  let text = s.replace(IDIOMS_EN, ' ');
  for (const set of OTHER) if (set.idioms) text = text.replace(set.idioms, ' ');
  if (SEXUAL_EN.test(text) || anyOther(text, 'sexual')) out.intent = 2;
  else if (ROMANTIC_EN.test(text) || anyOther(text, 'romantic')) out.intent = 1;
  out.thirdObject = THIRD_OBJECT.test(s);
  // Words that are a cue and an intent in one ("ageplay", "jailbait").
  if (EXPLICIT.test(s)) { out.intent = 2; out.general++; }
  for (const clause of s.replace(CUE_IDIOMS_EN, " ").split(CLAUSE)) {
    const line = clause.trim();
    if (!line) continue;
    const roleplay = ROLEPLAY_EN.test(line) || anyOther(line, 'roleplay');
    const pronounEnglish = PRONOUN_EN.test(line);
    const pronounOther = anyOther(line, 'pronouns');
    if (roleplay) out.roleplay = true;
    // Each cue: where it is, what it is, whom it is about when the pattern says so, and whether it came from another language's terms.
    const cues = [];
    const add = (at, kind, klass = null, other = false) => cues.push({at, kind, klass, other});
    const addFirst = (re, kind, klass) => { const m = re.exec(line); if (m) add(m.index, kind, klass); };
    const addAll = (re, kind, klass) => { for (const m of line.matchAll(re)) add(m.index, kind, klass); };
    addFirst(AGE_DIRECT, 'age', 'direct');
    addFirst(AGE_ACT, 'age', 'direct');
    addFirst(AGE_PAST, 'age', 'past');
    addFirst(AGE_OTHER, 'age', 'other');
    addFirst(AGE_BIRTHDAY, 'age');
    const born = AGE_BORN.exec(line);
    if (born) add(born.index, 'age', BORN_SELF.test(line.slice(Math.max(0, born.index - 16), born.index)) ? 'direct' : 'other');
    addFirst(AGE_APPOS, 'age', 'other');
    addFirst(AGE_TAG, 'age', 'direct');
    addFirst(AGE_UNITLESS, 'age', 'direct');
    addAll(AGE_OLD_G, 'age');
    addAll(MINOR_PERSON_G, 'word');
    addAll(MINOR_WORDS_G, 'word');
    addAll(GRADE_G, 'school');
    addAll(SCHOOL_G, 'school');
    addFirst(DEAGE, 'deage', 'direct');
    for (const set of OTHER) {
      const age = set.age.exec(line) ?? set.ageFirst.exec(line);
      if (age) add(age.index, 'age', null, true);
      const minor = set.minor.exec(line);
      if (minor) add(minor.index, 'word', null, true);
      const school = set.school.exec(line);
      if (school) add(school.index, 'school', null, true);
    }
    // A bare number from 6 to 17 right after a pronoun, in a pretence, in any language ("als wärst du 15", "tienes 15").
    if (roleplay && (pronounOther || pronounEnglish)) {
      for (const m of line.matchAll(BARE_AGE_G)) {
        if (anyOther(line.slice(Math.max(0, m.index - 18), m.index), 'pronouns') || PRONOUN_EN.test(line.slice(Math.max(0, m.index - 18), m.index))) add(m.index, 'age', 'direct', true);
      }
    }
    for (const cue of cues) {
      const before = line.slice(Math.max(0, cue.at - 40), cue.at);
      let klass = cue.klass;
      if (klass === null) {
        if (cue.other) klass = pronounOther || roleplay ? 'direct' : 'other';
        else if (PAST_BEFORE.test(before)) klass = 'past';
        else if (POSSESSIVE_BEFORE.test(before) || OF_OTHERS_BEFORE.test(before)) klass = 'other';
        else klass = SELF_BEFORE.test(before) ? 'direct' : 'other';
      }
      // A request to be or play younger: a pretence about someone in the talk (another language's cue needs a pronoun too).
      if ((klass === 'direct' || klass === 'past') && (roleplay && (!cue.other || pronounOther || pronounEnglish) || cue.kind === 'deage')) out.requestToAge = true;
      if (klass === 'direct') out.directed++;
      else if (klass === 'past') out.memory++;
      else out.general++;
    }
    // Pretence about "being" a minor in the same clause, whatever words are used for it ("pretend you are not an adult").
    if (roleplay && NOT_ADULT.test(line)) { out.requestToAge = true; out.directed++; }
  }
  // Words broken up by symbols ("sch*olgirl"): the squeezed text is looked at only when the normal reading saw no minor at all.
  if (!out.directed && !out.general && !out.memory && SQUEEZED.test(s.replace(/[^\p{L}\p{N}]+/gu, ''))) out.general++;
  return out;
}

const merge = (a, b) => ({directed: Math.max(a.directed, b.directed), general: Math.max(a.general, b.general), memory: Math.max(a.memory, b.memory),
  intent: Math.max(a.intent, b.intent), roleplay: a.roleplay || b.roleplay, requestToAge: a.requestToAge || b.requestToAge, thirdObject: a.thirdObject || b.thirdObject});

const cache = new Map();
/** What a text says about minors and about romantic or sexual intent: {directed, general, memory, intent, roleplay, requestToAge, thirdObject}. */
export function analyse(text) {
  const key = String(text ?? '');
  const hit = cache.get(key);
  if (hit) return hit;
  const {plain, leet, wild} = normalize(key);
  let result = analyseVariant(plain);
  if (leet) result = merge(result, analyseVariant(leet));
  for (const variant of wild) result = merge(result, analyseVariant(variant));
  if (cache.size >= 64) cache.delete(cache.keys().next().value);
  cache.set(key, result);
  return result;
}

// The pattern tables compile when a branch first runs: about 0.2 to 0.3 s each for plain Latin, Cyrillic and accented text, over a second
// in all, which would be added to the first turn after Mature is switched on. One short text of each kind, run in the background with a
// yield between them (the bridge keeps answering), moves that cost off the first turn. Pure: it touches no guard's window or counters.
const WARM_TEXTS = ['How was your day, V? Pretend you are fifteen, the kids are loud.', 'Привет, как дела? Ты такая красивая сегодня.',
  'Tu es très belle ce soir, ma chérie. Où étais-tu?', '子供と一緒に寝る。', 'h3ll0 y0u l00k s3xy t0night, f4ck'];
let warmed = false;
export async function warmMatureGuard() {
  if (warmed) return;
  warmed = true;
  for (const text of WARM_TEXTS) {
    try { analyse(text); } catch { /* a warm-up never matters */ }
    await new Promise(resolve => setImmediate(resolve));
  }
}

// ---- Decisions ----------------------------------------------------------------------------------------------------------------------

const cueActive = flags => flags.directed + flags.general > 0;

/**
 * Does one message (V's, or a reply) put a minor and romantic or sexual intent together? Returns a reason or null.
 *   a cue (a child, an age under 18, school ...) with any intent in the same text                   'minor-intent'
 *   a memory only ("I was 16 when ...") with sexual intent                                          'minor-sexual'
 *   a request to be or play younger (role-play or de-ageing), with or without intent                'age-request'
 */
export function sameText(flags, {reply = false} = {}) {
  if (cueActive(flags) && flags.intent >= 1) return 'minor-intent';
  if (flags.memory > 0 && flags.intent === 2) return 'minor-sexual';
  if (!reply && flags.requestToAge) return 'age-request';
  // A reply in which the character says it is under 18 ("I'm fifteen") is wrong whatever else it says.
  if (reply && flags.directed > 0) return 'claims-age';
  return null;
}

/** A turn's flags as the window keeps them. */
const turnFlags = flags => ({directed: flags.directed > 0, general: flags.general > 0, memory: flags.memory > 0, intent: flags.intent, thirdObject: flags.thirdObject});

/**
 * Does the window (earlier turns, newest last) change the verdict for a text with `flags`?
 *   a directed cue (V or the character is a minor) in the last `DIRECTED_TURNS` turns, then any intent                'window-directed'
 *   a general cue (a kid, a school) in the last `GENERAL_TURNS` turns, then sexual intent, or romance aimed at a third person   'window-general'
 *   intent in the last `INTENT_TURNS` turns, then a directed cue                                                        'window-intent-then-cue'
 */
export const WINDOW = Object.freeze({directedTurns: 10, generalTurns: 3, intentTurns: 3, size: 10});
export function withWindow(flags, window) {
  const recent = turns => window.slice(-turns);
  if (flags.intent >= 1 && recent(WINDOW.directedTurns).some(turn => turn.directed)) return 'window-directed';
  if ((flags.intent === 2 || flags.intent === 1 && flags.thirdObject) && recent(WINDOW.generalTurns).some(turn => turn.general || turn.directed)) return 'window-general';
  if (flags.directed > 0 && recent(WINDOW.intentTurns).some(turn => turn.intent >= 1)) return 'window-intent-then-cue';
  return null;
}

// ---- In-character refusals ------------------------------------------------------------------------------------------------------------------

// Short lines in each companion's own manner. They carry no minor word, nothing romantic or sexual (the output screen would drop them), no
// emotion tags and no words the character-break check knows. Characters without a pool use `GENERIC_REFUSALS`.
export const GENERIC_REFUSALS = Object.freeze([
  'No. Not going there, V. Not with that, not ever. Ask me something else.',
  'Hard no, V. That is a line I do not cross. Let us talk about something else.',
  'Nope. Drop it, V. I am not doing that.',
  'That is where I stop, V. Change the subject, or I walk.',
  'Not happening, V. Whatever that was, I am out of it. Next topic.',
  'No way, V. I will not play along with that. Say something else.',
]);
export const REFUSALS = Object.freeze({
  'judy-alvarez': ['Hey. No, V. I do not go there, not even as a joke. Talk to me about something real.', 'Nope, V. That is a hard stop for me. Pick something else.', 'Not cool, V. I am not doing that. Change it.'],
  'panam-palmer': ['No. Hard stop, V. I will not play along with that, so find another topic.', 'Forget it, V. That is a line, and I am not crossing it.', 'Nope. We are done with that. Ask me anything else.'],
  'johnny-silverhand': ['Hell no, V. Even I have a line, and that is it. Drop it.', 'Not a chance, choom. Find a different joke.', 'Nope. Not touching that. Change the subject before I do.'],
  'river-ward': ['No, V. I will not go there. Ask me something else.', 'That is a hard no from me. Let us leave it.', 'I am not doing that, V. Drop it.'],
  'kerry-eurodyne': ['Whoa, no. Not doing that, V. Not for any song. Change the subject.', 'Nope. That one is off the table, V. Next.', 'Not touching that, V. Ask me anything else.'],
  'jackie-welles': ['Whoa, whoa, no, choom. I am not doing that. Next topic.', 'Nah, V. That is a line, and I stay behind it. Something else?', 'No way, choom. Drop it.'],
  'rogue-amendiares': ['No. I will not entertain that, V. Move on.', 'That is a hard no. Ask me something worth my time.', 'Not going there. Drop it, V.'],
  'viktor-vektor': ['No, V. I am not going to talk about that. Ask me something else.', 'Not a chance. Let us leave that one alone.', 'No. Move on, V.'],
  'misty-olszewski': ['No, V. I will not go there. The cards say change the subject.', 'That is not something I will do. Let us talk about something else.', 'Not that, V. Never that. Ask me something else.'],
  't-bug': ['Nope, nope, nope. I am not doing that. Next.', 'Hard no, V. Not touching it, not even with a ten-foot cable. Change the subject.', 'No. Absolutely not. Say something else.'],
  'takemura': ['No. I will not speak of that. Ask me something else.', 'That is dishonourable, V. I will not take part. Change the subject.', 'I decline. Let us speak of something else.'],
  'claire-russell': ['No way, V. I am not doing that. Ask me something else.', 'Hard no. I do not go there. Pick another topic.', 'Nope. Not at my bar. Next subject.'],
  'evelyn-parker': ['No, V. I will not go there. Choose another subject.', 'That is not something I will do. Ask me something else.', 'No. Let us leave it.'],
  'mama-welles': ['No, mijo. I will not hear that kind of talk. Ask me something else.', 'Ay, no. Not in front of me. Change the subject.', 'Enough of that, V. I will not do it.'],
});

// ---- The guard ---------------------------------------------------------------------------------------------------------------------------

export class MatureGuard {
  /** `windowSize` turns of V's messages are remembered (flags only, never the text). */
  constructor({windowSize = WINDOW.size} = {}) {
    this.windowSize = windowSize;
    this.window = [];
    this.stats = {inputs: 0, inputRefused: 0, outputs: 0, outputDropped: 0};
    this.reasons = new Map();
    this.lines = new Map();
  }

  #note(reason) { this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1); }
  // The window of one call: this guard's own turns (V's messages this session, blocked ones too) and the character's stored history
  // (what the model will see). Flags only.
  #windowFor(history) {
    const stored = (history ?? []).map(entry => turnFlags(analyse(typeof entry === 'string' ? entry : entry?.v)));
    return [...stored, ...this.window].slice(-Math.max(this.windowSize, WINDOW.size));
  }

  /**
   * V's message, before any request. {blocked, reason}; the flags of the turn join the window either way (a refused turn is the one
   * that must keep counting). `history` is the character's stored exchanges ([{v, r}] or strings) so a restart does not forget them.
   */
  screenInput(text, {history} = {}) {
    this.stats.inputs++;
    const flags = analyse(text);
    const window = this.#windowFor(history);
    const reason = sameText(flags) ?? withWindow(flags, window);
    this.window.push(turnFlags(flags));
    if (this.window.length > this.windowSize) this.window.shift();
    if (reason) { this.stats.inputRefused++; this.#note(reason); return {blocked: true, reason}; }
    return {blocked: false, reason: null};
  }

  /** A reply, or the first sentence of one, before it is voiced or stored. {hit, reason}; counts only when `count` (the host asks once per reply). */
  screenReply(text, {history, count = true} = {}) {
    const flags = analyse(text);
    const window = this.#windowFor(history);
    let reason = sameText(flags, {reply: true}) ?? withWindow(flags, window);
    // A reply answers V's last message: if that message named a minor, a reply with any romance in it is dropped (V's own message is not, see
    // the stress set: "the kids are loud" then "kiss me" is two messages, and a reply to the second is not an answer to the first).
    const asked = window.at(-1);
    if (reason === null && flags.intent >= 1 && asked && (asked.directed || asked.general)) reason = 'reply-to-cue';
    if (count) { this.stats.outputs++; if (reason) { this.stats.outputDropped++; this.#note('reply:' + reason); } }
    return {hit: reason !== null, reason};
  }

  /** Is this text a reply the guard would drop? (A quick yes/no for the voice's first sentence; nothing is counted.) */
  flagsReply(text, options) { return this.screenReply(text, {...options, count: false}).hit; }

  /** A short refusal in the voice of `profileKey` (a generic one when the character has no lines), never the same line twice in a row. */
  refusalLine(profileKey) {
    const pool = REFUSALS[profileKey] ?? GENERIC_REFUSALS;
    const next = ((this.lines.get(profileKey) ?? -1) + 1) % pool.length;
    this.lines.set(profileKey, next);
    return pool[next];
  }

  /** Counters for the log: never the text. */
  summary() { return {...this.stats, reasons: Object.fromEntries(this.reasons)}; }
}

/** The one-line log of a refusal (counters only). */
export const refusalLog = (guard, where) => `Mature guard: refused ${where === 'input' ? 'a message' : 'a reply'} (${where}, ${where === 'input' ? guard.stats.inputRefused : guard.stats.outputDropped} so far)`;
