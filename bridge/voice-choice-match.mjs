// Which dialogue choice did the player SAY? (Settings > Gameplay > Speak dialogue choices, docs/VOICE_CHOICES.md)
//
// A pure function: the recogniser's transcript and the captions of the choice list on screen go in, a verdict comes out. No model, no network, no
// state; one call is a few thousand string operations, microseconds on a list of at most a dozen captions. It runs in the bridge when the transcript
// arrives, so the whole path from the end of the player's sentence to the key press has no language-model call in it.
//
//   matchChoice(transcript, captions) -> {status, index?, score, runnerUp, reason}
//     status 'pick'       exactly one choice was meant: `index` is its position (0-based) in `captions`
//     status 'ambiguous'  two or more choices fit equally well (or the position named does not exist): nothing is picked
//     status 'none'       nothing fits (chatter, noise, a line that is not on the list): nothing is picked
//   `reason` is a short code for the log ('exact', 'number', 'ordinal', 'words', 'tie', 'weak', 'out-of-range', 'empty').
//
// A wrong pick is much worse than no pick, so the rules lean to refusing. Three ways to say a choice, tried in this order:
//   1. a position: "option two", "the second one", "number 3", "the last one", "zwei", "la tercera" (the table below holds the numbers of the
//      languages the game ships in; the words around them are free to vary, but nothing else may be in the sentence)
//   2. the words of the caption: all of it, a part of it, or its most telling words. Words weigh more the fewer of the visible captions
//      contain them (two captions that both say "job" tell nothing apart with it), function words weigh little, and a word is also
//      met by a near spelling (a recogniser's slip).
//   3. nothing else. A sentence of chatter that shares only "the" and "you" with a caption is not a choice.
// The score of a choice is how much of what was SAID it explains (precision, weighted), with a smaller share for how much of the CAPTION was said
// (recall), so "no" picks the caption "No." over "No, wait, I changed my mind." but "tell me about the job" still picks "Tell me about the job
// you mentioned." A pick needs a real score and a clear lead over the next choice.

export const THRESHOLDS = Object.freeze({
  accept: 0.6,        // the best choice must explain at least this much of what was said
  lead: 0.18,         // ... and lead the next choice by at least this much
  minEvidence: 1.0,   // ... and at least this much word weight must have been matched (a lone "the" is not evidence)
});

// ---------------------------------------------------------------------------------------------------------------------------------------
// Normalising

const stripMarks = text => text.normalize('NFKD').replace(/\p{M}+/gu, '');

/** Lowercase, no accents, no quotes or brackets, one space between words. Letters and digits of every script stay. */
export function normalize(text) {
  return stripMarks(String(text ?? '').toLowerCase())
    .replace(/[‘’ʼ`´]/g, "'")
    // French and Italian elision (l'option, d'Arasaka, dell'altro) is two words; English contractions (i'm, can't) stay one.
    .replace(/(^|[^\p{L}])(l|d|j|m|t|s|n|c|qu|jusqu|lorsqu|puisqu|all|dell|nell|sull|quest|un)'(?=\p{L})/gu, '$1$2 ')
    // English clitics ("who's", "I'm", "you'll", "we've", "I'd", "they're") drop their ending: "who's" is "who", "I'm" is "I".
    .replace(/(\p{L})'(s|m|ll|ve|d|re)(?![\p{L}])/gu, '$1')
    .replace(/['"“”„«»]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// "[Persuade] I know a guy." matches as "I know a guy."; "[Leave]" has nothing else and matches as "leave". HTML-ish game markup goes.
export function captionText(caption) {
  let text = String(caption ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  const stripped = text.replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  if (/[\p{L}\p{N}]/u.test(stripped)) return stripped;
  return text.replace(/[\[\]()]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Scripts written without spaces between words: every character pair is a token.
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

export function tokens(text) {
  const normal = normalize(text);
  if (!normal) return [];
  const out = [];
  for (const word of normal.split(' ')) {
    if (!UNSPACED.test(word)) { out.push(word); continue; }
    const chars = [...word];
    if (chars.length <= 2) { out.push(word); continue; }
    for (let at = 0; at + 1 < chars.length; at++) out.push(chars[at] + chars[at + 1]);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Function words: they weigh little (they are in every sentence). Short lists for the languages the game ships in; a language without a list
// still works, because a word that every visible caption contains weighs nothing anyway.

export const STOP = new Set(`
a an the and or but so to of in on at for with by from as is are was were be been am do does did i me my mine we us our you your he she it its they them
this that these those there here not if then than too very just also about into out up down over can could will would shall should may might
have has had get got let lets im ill ive id youre dont cant wont its thats whats i'm i'll i've i'd you're don't can't won't it's that's what's
der die das den dem des ein eine einen einem einer und oder aber ich du er sie es wir ihr mich mir dich dir ist sind war bin bist nicht kein keine zu zum zur von mit auf
le la les un une des du de et ou mais je tu il elle nous vous ils elles me te se ce cet cette ces est sont suis es pas ne qui que en dans sur pour par avec au aux
el los las unos unas y o pero yo tu usted nosotros ellos ellas me te se lo le es son soy eres no que de en por para con del al
il lo gli uno una e o ma io tu lui lei noi voi loro mi ti si che di del della in per con
o os as um uma e ou mas eu tu ele ela nos vos eles elas me te se que de em por para com do da
i w z na do od po za u o a oraz lub ale ja ty on ona my wy oni mnie ci sie nie to jest sa
и в во не на я ты он она мы вы они мне тебе это что как но а или с со у к по за из от до
`.split(/\s+/).filter(Boolean).map(word => normalize(word)));

const stopWeight = 0.12;

// ---------------------------------------------------------------------------------------------------------------------------------------
// Positions. Digits and number words of the languages the game ships in, ordinals, "last" and "first".

const NUMBER_WORDS = {
  1: 'one won uno una un eins ein eine erste erster erstes first primero primera primer premier premiere prima primo primeiro primeira pierwszy pierwsza pierwsze pierwszą один одна одно первый первая первое первую raz 一 いち 하나 일 jedna jeden první',
  2: 'two too to deux due dos dois duas zwei zweite zweiter zweites second segundo segunda secundo seconda secondo deuxieme deuxième seconde dwa dwie drugi druga drugie drugą два две второй вторая второе вторую 二 に 둘 이 dva dvě druhý',
  3: 'three tree trois tre tres drei dritte dritter drittes third tercero tercera troisieme troisième terzo terza terceiro terceira trzy trzeci trzecia trzecie trzecią три третий третья третье третью 三 さん 셋 삼 tři třetí',
  4: 'four for quatre quattro cuatro quatro vier vierte vierter viertes fourth cuarto cuarta quatrieme quatrième quarto quarta czwarty czwarta czwarte czwartą cztery четыре четвертый четвёртый четвертая четвёртая 四 よん し 넷 사 čtyři čtvrtý',
  5: 'five cinq cinque cinco fünf funf fünfte fuenf fuenfte fifth quinto quinta cinquieme cinquième piąty piata piąta piąte pięć piec пять пятый пятая 五 ご 다섯 오 pět pátý',
  6: 'six sei seis sechs sechste sixth sexto sexta sixieme sixième sesto szósty szosty sześć szesc шесть шестой шестая 六 ろく 여섯 육 šest šestý',
  7: 'seven sept sette siete sete sieben siebte seventh septième septieme settimo sétimo setimo siódmy siodmy siedem семь седьмой седьмая 七 なな しち 일곱 칠 sedm sedmý',
  8: 'eight huit otto ocho oito acht achte eighth huitieme huitième ottavo octavo oitavo ósmy osmy osiem восемь восьмой 八 はち 여덟 팔 osm osmý',
  9: 'nine neuf nove nueve neun neunte ninth neuvième neuvieme nono noveno nono dziewiąty dziewiaty dziewięć dziewiec девять девятый 九 きゅう く 아홉 구 devět devátý',
  10: 'ten dix dieci diez dez zehn zehnte tenth dixième dixieme decimo décimo dziesiąty dziesiaty dziesięć dziesiec десять десятый 十 じゅう 열 십 deset desátý',
};
const POSITION = new Map();
for (const [value, list] of Object.entries(NUMBER_WORDS)) for (const word of list.split(/\s+/)) {
  const key = normalize(word) || word;
  // Two languages can spell the same word differently ("sei": Italian six; "una": Spanish one): the first reading kept stays, the lists above never overlap on purpose.
  if (!POSITION.has(key)) POSITION.set(key, Number(value));
}
const LAST_WORDS = new Set('last final bottom lowest letzte letzter letztes dernier derniere dernière ultimo ultima último última ostatni ostatnia ostatnie последний последняя последнее 最後'.split(' ').map(word => normalize(word) || word));
const MIDDLE_WORDS = new Set('middle center centre mittlere mitte milieu medio central centrale środkowy srodkowy средний'.split(' ').map(word => normalize(word) || word));
const FIRST_WORDS = new Set('top highest uppermost oberste oberster premier première haut arriba primero superior pierwszy górny gorny верхний первый'.split(' ').map(word => normalize(word) || word));
// A recogniser writes these homophones for a number word, so they count as one only beside a command word ("option to", "number for").
const HOMOPHONE = new Set(['to', 'too', 'for', 'won', 'tree']);

// Words that only say "choose": they may surround a position and carry no meaning of their own.
const COMMAND = new Set(`
option options number numbers choice choices answer answers one ones pick picks select choose take go with number no nr num numero número numéro opcion opción opção opcao
option wahl wähle wahle nummer antwort die der das den dem ersten zweiten dritten vierten fünften the a an please now okay ok um uh er hmm
choix réponse reponse numéro prends prendre je vais choisis choisir la le les l mon ma celle celui ce cette
opción elijo escojo la el lo una un el numero número respuesta quiero
opzione numero risposta scelgo la il lo
opção número resposta escolho a o
opcja numer odpowiedź odpowiedz wybieram opcję opcje wariant
вариант номер ответ выбираю первый
選択 番号 선택 번호 第 的 个 個 번
nummer wähle ich nehme nimm
i'll ill i'd id i'm im take go let's lets want would like pick choose select said say
`.split(/\s+/).filter(Boolean).map(word => normalize(word) || word));
// Words that, with a position, make it "the Nth one": ordinals count as the position itself, so these are only the glue.
const GLUE = new Set(['one', 'ones', 'option', 'choice', 'answer', 'number', 'numero', 'nummer', 'opcion', 'opcja', 'wariant', 'вариант', 'номер', 'ответ', 'the', 'a', 'please']);

/**
 * The position the player named, if the sentence is ONLY a position ("option two", "the third one", "last", "3 please"): {index} (0-based, `last` for the
 * last one), {out: true} for a position beyond the list, or null when the sentence is something else.
 */
export function namedPosition(transcript, count) {
  const words = tokens(transcript);
  if (!words.length || words.length > 6) return null;
  let value = null, last = false, middle = false, command = false, bareOne = false;
  const taken = () => value !== null || last || middle;
  for (let at = 0; at < words.length; at++) {
    const word = words[at];
    const digits = /^\d{1,2}$/.test(word) ? Number(word) : null;
    if (digits !== null) { if (taken()) return null; value = digits; continue; }
    if (LAST_WORDS.has(word)) { if (taken()) return null; last = true; continue; }
    if (MIDDLE_WORDS.has(word)) { if (taken()) return null; middle = true; continue; }
    if (FIRST_WORDS.has(word) && !POSITION.has(word)) { if (taken()) return null; value = 1; continue; }
    // "the third one": "one" is the noun there, a number only when nothing else names the position.
    if (word === 'one' || word === 'ones') { command = true; bareOne = true; continue; }
    if (POSITION.has(word)) {
      // "to", "for", "too" and the like count as numbers only after a command word ("option to"), never alone ("to").
      if (HOMOPHONE.has(word) && !(command && words.slice(0, at).some(other => COMMAND.has(other)))) return null;
      if (taken()) return null;
      value = POSITION.get(word);
      continue;
    }
    if (COMMAND.has(word) || GLUE.has(word)) { command = true; continue; }
    return null;
  }
  if (value === null && !last && !middle && bareOne) value = 1;
  if (last) return {index: count - 1, kind: 'last'};
  if (middle) return count % 2 === 1 ? {index: (count - 1) / 2, kind: 'middle'} : {out: true, value: 0};
  if (value === null) return null;
  if (value < 1 || value > count) return {out: true, value};
  return {index: value - 1, kind: 'number'};
}

// ---------------------------------------------------------------------------------------------------------------------------------------
// Words

// Fewer edits are allowed in short words: "were"/"where" (1 of 5) is a slip, "go"/"no" (1 of 2) is another word.
function editLimit(a, b) {
  const size = Math.min([...a].length, [...b].length);
  return size >= 9 ? 2 : size >= 5 ? 1 : 0;
}

function editDistance(a, b, limit) {
  if (a === b) return 0;
  const x = [...a], y = [...b];
  if (Math.abs(x.length - y.length) > limit) return limit + 1;
  let previous = Array.from({length: y.length + 1}, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    const row = [i];
    let low = row[0];
    for (let j = 1; j <= y.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      if (row[j] < low) low = row[j];
    }
    if (low > limit) return limit + 1;
    previous = row;
  }
  return previous[y.length];
}

// How well a said word is found among a caption's words: 1 exact, 0.85 a near spelling (a recogniser slip, a plural), 0.8 a shared long beginning
// ("mention"/"mentioned"), 0 none.
function wordMatch(word, caption) {
  let best = 0;
  for (const other of caption) {
    if (other === word) return 1;
    const limit = editLimit(word, other);
    if (limit > 0 && editDistance(word, other, limit) <= limit) best = Math.max(best, 0.85);
    else if (word.length >= 5 && other.length >= 5 && (other.startsWith(word) || word.startsWith(other)) && Math.min(word.length, other.length) >= 0.7 * Math.max(word.length, other.length)) best = Math.max(best, 0.8);
  }
  return best;
}

// Words that turn a sentence round: "I'm not bleeding" is not "I'm bleeding". A caption and a sentence must agree on having one.
const NEGATION = new Set(`not no never nothing nobody none dont cant wont isnt arent wasnt werent didnt doesnt wouldnt couldnt shouldnt havent hasnt hadnt aint cannot
 nicht kein keine keiner nie niemals nichts ne pas jamais rien nunca nada ni nie nigdy nic не нет никогда ничего`.split(/\s+/).filter(Boolean).map(word => normalize(word) || word));

// Sounds and padding of speech that are never part of a choice (kept when a caption does contain them).
const FILLER = new Set('um uh er erm hmm hm mm ah oh eh well so anyway actually basically like okay ok yeah please thanks'.split(' '));

// A question is not the statement that shares its words ("what is the job" / "Let's do the job now"): the question words must agree too.
const QUESTION = new Set('what who whom whose where when why how which wer wie was wo wann warum wieso welche qui que quoi ou quand pourquoi comment quel quelle quien como cuando donde por qué que cual chi cosa dove quando perche come quale kto co gdzie kiedy dlaczego jak jaki кто что где когда почему как какой'.split(' ').map(word => normalize(word) || word));

// A few spoken ways to say yes or no, so "yeah" meets the caption "Yes." (English only; every other language matches on its own words).
const SAME = new Map([
  ['yeah', 'yes'], ['yep', 'yes'], ['yup', 'yes'], ['sure', 'yes'], ['okay', 'yes'], ['ok', 'yes'], ['alright', 'yes'],
  ['nope', 'no'], ['nah', 'no'],
]);

// ---------------------------------------------------------------------------------------------------------------------------------------

/**
 * @param transcript what the recogniser wrote
 * @param captions   the visible choices' texts, in the order the game lists them (an entry can be empty/false: that choice is never picked)
 * @param options    {accept, lead, minEvidence} to override THRESHOLDS (the tests tune them)
 */
export function matchChoice(transcript, captions, options = {}) {
  const limits = {...THRESHOLDS, ...options};
  const list = Array.isArray(captions) ? captions : [];
  const count = list.length;
  const said = tokens(transcript);
  if (!said.length || count === 0) return {status: 'none', score: 0, runnerUp: 0, reason: 'empty'};
  const texts = list.map(caption => captionText(caption));
  const words = texts.map(text => tokens(text));
  const usable = words.map(set => set.length > 0);
  const sentence = normalize(transcript);

  // 1. An exact reading of a caption is always that caption (a choice that is literally "Two." beats the position two).
  const exact = [];
  texts.forEach((text, index) => { if (usable[index] && normalize(text) === sentence) exact.push(index); });
  if (exact.length === 1) return {status: 'pick', index: exact[0], score: 1, runnerUp: 0, reason: 'exact'};
  if (exact.length > 1) return {status: 'ambiguous', score: 1, runnerUp: 1, reason: 'tie'};

  // 2. A position.
  const position = namedPosition(transcript, count);
  if (position) {
    if (position.out) return {status: 'ambiguous', score: 0, runnerUp: 0, reason: 'out-of-range'};
    if (!usable[position.index]) return {status: 'none', score: 0, runnerUp: 0, reason: 'empty'};
    return {status: 'pick', index: position.index, score: 1, runnerUp: 0, reason: position.kind === 'last' ? 'ordinal' : 'number'};
  }

  // 3. The words. A function word weighs stopWeight of a content word; a word every caption shares cannot tell them apart, and the lead
  // rule below turns that into 'ambiguous' instead of a pick.
  const unique = [...new Set(said.filter(word => !FILLER.has(word) || words.some(set => set.includes(word))).map(word => SAME.get(word) && !words.some(set => set.includes(word)) ? SAME.get(word) : word))];
  const saidAsks = unique.some(word => QUESTION.has(word));
  const saidNegated = unique.some(word => NEGATION.has(word));
  const scores = words.map((set, index) => {
    if (!usable[index]) return {score: 0, evidence: 0};
    let matched = 0, total = 0, evidence = 0;
    for (const word of unique) {
      const weight = STOP.has(word) ? stopWeight : 1;
      total += weight;
      const found = wordMatch(word, set);
      if (found > 0) { matched += weight * found; evidence += weight * found; }
    }
    // Weighted precision: how much of what was said this caption explains. Words every caption shares count at their full weight here (they ARE
    // said and ARE in the caption); only the lead over the other captions separates the choices.
    const precision = total > 0 ? matched / total : 0;
    // Recall: how much of the caption (content words, weighted) was said.
    let captionTotal = 0, captionHit = 0;
    for (const word of new Set(set)) {
      const weight = STOP.has(word) ? stopWeight : 1;
      captionTotal += weight;
      if (wordMatch(word, unique) > 0 || unique.some(said => SAME.get(word) === said)) captionHit += weight;
    }
    const recall = captionTotal > 0 ? captionHit / captionTotal : 0;
    // The sentence and the caption must agree on a negation; a mismatch is a different meaning with the same words.
    const flipped = saidNegated !== set.some(word => NEGATION.has(word)) || (saidAsks && !set.some(word => QUESTION.has(word)));
    // Precision decides; recall breaks ties between captions that explain the words equally ("no" / "No." / "No, wait ...").
    return {score: (precision * 0.8 + recall * 0.2) * (flipped ? 0.4 : 1), evidence, precision, recall};
  });
  const order = scores.map((entry, index) => ({index, ...entry})).sort((a, b) => b.score - a.score || b.recall - a.recall);
  const best = order[0], second = order[1];
  const runnerUp = second ? second.score : 0;
  const result = {score: Number(best.score.toFixed(3)), runnerUp: Number(runnerUp.toFixed(3))};
  if (best.score < limits.accept || best.evidence < limits.minEvidence) return {status: 'none', ...result, reason: 'weak'};
  if (best.score - runnerUp < limits.lead) return {status: 'ambiguous', ...result, reason: 'tie'};
  return {status: 'pick', index: best.index, ...result, reason: 'words'};
}
