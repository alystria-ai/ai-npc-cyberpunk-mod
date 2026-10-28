// The screen of V's money words in the languages other than English (bridge/eddies.mjs screenWords; docs/EDDIES.md "Languages").
//
// No model and no I/O: per language a data file (bridge/eddies-languages/<code>.mjs) holds the words as regular-expression sources, and this engine
// compiles them once (lazily, the first time a line needs that language) and reads one line with them: which language the line is in
// (bridge/reply-language.mjs, tens of microseconds, remembered for the turn), then the clause patterns for reclaim, repay, lend, borrow and give, the
// sum in that language's digits and number words, and the refusals (negation, condition, past and future). A line that is not about money costs two
// regular-expression tests. English stays in eddies.mjs and is always tried first, because the characters and the players mix it into every language.
//
// Data file shape (see bridge/eddies-languages/es.mjs, the worked example):
//   language: 'es'
//   money:    regex source, money NOUNS and slang (eddies, euros, cash, debt, loan; never the verbs lend/borrow/owe themselves)
//   moneyPhrases: regex source, verb phrases that only money fits even with no noun or sum ("pay me back", "lo que me debes"); optional
//   unit:     regex source, what may follow a sum as its currency (eddies, euros, slang); the currency signs are built in
//   after:    regex source, words that may follow a bare sum ("para", "por favor"); the end of the clause and punctuation always count
//   notMoney: regex source, words that make a number after a money verb something else ("5 minutos", "3 veces")
//   but:      regex source, words that split a line into clauses ("pero", "y luego")
//   until:    regex source, "until tomorrow" phrases ("bis morgen", "hasta mañana", "до завтра"): cut out before the future/past test, so "lend me 500 until tomorrow" is still an ask; optional
//   joke:     regex source, "joking" words; a clause after one is no ask ("it was a joke, lend me 500"); optional
//   numbers:  {words: {'doscientos': 200, 'quatre vingt': 80 ...}, scales: {'cien': 100, 'mil': 1000}, skip: ['y'], compound, unitOnly, tail}
//   intents:  [[intent, source], ...] in this order: reclaim, repay, lend (do you need money), borrow, lend (I offer), give
//   negation, hypothetical, later: regex sources, tested on the whole clause
// Sources are matched case-insensitively, with the u flag. Latin and Cyrillic text is folded (accents, ё, ł, ß ...) so a pattern with accents
// also matches the line typed without them; `\b` in a source means a word edge for any letter (JavaScript's own is ASCII only). Japanese, Korean and
// Chinese are not folded and not split into words.
import {assessLanguage} from './reply-language.mjs';
import cs from './eddies-languages/cs.mjs';
import de from './eddies-languages/de.mjs';
import es from './eddies-languages/es.mjs';
import fr from './eddies-languages/fr.mjs';
import hu from './eddies-languages/hu.mjs';
import it from './eddies-languages/it.mjs';
import ja from './eddies-languages/ja.mjs';
import ko from './eddies-languages/ko.mjs';
import pl from './eddies-languages/pl.mjs';
import pt from './eddies-languages/pt.mjs';
import ru from './eddies-languages/ru.mjs';
import tr from './eddies-languages/tr.mjs';
import uk from './eddies-languages/uk.mjs';
import zh from './eddies-languages/zh.mjs';

/** The data files, by language code (the codes the language detector uses; Chinese covers both scripts of the game's two Chinese menus). */
export const DATA = Object.freeze({cs, de, es, fr, hu, it, ja, ko, pl, pt, ru, tr, uk, zh});
export const LANGUAGES = Object.freeze(Object.keys(DATA).filter(code => DATA[code].intents?.length));
const CJK = new Set(['ja', 'ko', 'zh']);

const FOLD_MAP = {ł: 'l', đ: 'd', ø: 'o', ı: 'i', ß: 'ss', œ: 'oe', æ: 'ae'};
const foldWord = text => text.normalize('NFD').replace(/\p{M}/gu, '').replace(/[łđøıßœæ]/gu, c => FOLD_MAP[c]);
const prepare = (text, language) => {
  const lower = text.normalize('NFKC').toLowerCase();
  return CJK.has(language) ? lower : foldWord(lower);
};
// Sources are folded like the text, but not lower-cased (\p{L}, \d ... are case-sensitive escapes); the i flag does the case.
const prepareSource = (source, language) => CJK.has(language) ? source.normalize('NFKC') : foldWord(source.normalize('NFKC'));
// A word edge written \b: after a letter or digit it can only be a word end, after ( | : or a space (or at the start) only a word start, so those become one
// short lookaround each. After ) ] ? * + } it can be either, and gets the full alternation. (The alternation everywhere made every pattern twenty times
// larger, and the first run of each 30 to 90 ms a language.)
const ANY_EDGE = String.raw`(?:(?<=[\p{L}\p{N}_])(?![\p{L}\p{N}_])|(?<![\p{L}\p{N}_])(?=[\p{L}\p{N}_]))`;
const START_EDGE = String.raw`(?<![\p{L}\p{N}_])`, END_EDGE = String.raw`(?![\p{L}\p{N}_])`;
const edges = source => source.replace(/\\b/g, (_, at) => {
  const before = source[at - 1];
  if (at === 0 || '(|: '.includes(before)) return START_EDGE;
  return /[\p{L}\p{N}]/u.test(before) ? END_EDGE : ANY_EDGE;
});
const compile = (source, language, flags = 'iu') => new RegExp(edges(prepareSource(source, language)), flags);

const SIGN = String.raw`(?:€\$|e\$|\$|€)`;
const GROUPED = /^\d{1,3}(?:[.,'   ]\d{3})+$/;
const NUMBER = String.raw`(?:\d{1,3}(?:[.,'   ]\d{3})+|\d+(?:[.,]\d+)?)`;
// Words that, right before a number word, make it no sum: "a few thousand", "unos mil", "ein paar tausend", "несколько тысяч", "几百".
const VAGUE = /(?:few|couple|several|some|unos|unas|algunos|algunas|pocos|ein paar|einige|mehrere|quelques|plusieurs|alcuni|alcune|qualche|alguns|algumas|varios|kilka|kilku|pare|kilkaset|несколько|пара|кілька|декілька|několik|nekolik|pár|par|néhány|nehany|birkaç|birkac|几|幾|数|數|若干|몇|수)\s*$/iu;

const rulesCache = new Map();
function rulesOf(language) {
  if (rulesCache.has(language)) return rulesCache.get(language);
  const data = DATA[language], cjk = CJK.has(language);
  const words = new Map(), scales = new Map();
  for (const [word, value] of Object.entries(data.numbers?.words ?? {})) words.set(prepare(word, language).replace(/[-\s]+/g, ' '), value);
  for (const [word, value] of Object.entries(data.numbers?.scales ?? {})) scales.set(prepare(word, language).replace(/[-\s]+/g, ' '), value);
  const skip = new Set((data.numbers?.skip ?? []).map(word => prepare(word, language)));
  const unit = data.unit ? compile(String.raw`^\s*(?:${data.unit}|${SIGN})` + (cjk ? '' : String.raw`(?![\p{L}])`), language) : null;
  // A digit run may be followed by k or a scale word of 100 or more ("5k", "2 mil", "3 тысячи", "5 соток", "2万").
  const suffixWords = [...scales].filter(([, value]) => value >= 100).map(([word]) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const suffix = prepareSource(String.raw`(?:k|к${suffixWords.length ? '|' + suffixWords.join('|') : ''})`, language);
  const digits = new RegExp(String.raw`(${SIGN}\s?)?(${NUMBER})(?:\s?(${suffix})${cjk ? '' : String.raw`(?![\p{L}])`})?`, 'giu');
  const edged = source => cjk ? source : String.raw`(?<![\p{L}\p{N}])(?:${source})(?![\p{L}\p{N}])`;
  // A refusal word starts at a word start ("aldim" is not inside "kaldim").
  const refusal = source => compile((cjk ? '' : String.raw`(?<![\p{L}\p{N}])`) + `(?:${source})`, language);
  const rules = {
    language, cjk, words, scales, skip, unit, digits,
    compound: !!data.numbers?.compound, unitOnly: data.numbers?.unitOnly !== false, tail: !!data.numbers?.tail,
    money: compile((cjk ? '' : String.raw`(?<![\p{L}\p{N}])`) + `(?:${data.money}${data.moneyPhrases ? '|' + data.moneyPhrases : ''})`, language),
    after: data.after ? compile(String.raw`^\s*(?:${data.after})`, language) : null,
    notMoney: data.notMoney ? compile(String.raw`^\s*(?:${data.notMoney})`, language) : null,
    // Clauses end at ! ? ; and a full stop or comma that is not inside a number (1.000, 1,5k), and at the language's "but"s.
    split: new RegExp(String.raw`[!?;。！？；、，]+|\.(?!\d)|,(?!\d)|(?<!\d),` + (data.but ? '|' + compile(edged(data.but), language).source : ''), 'giu'),
    intents: data.intents.map(([name, source]) => [name, compile(source, language)]),
    negation: refusal(data.negation), hypothetical: refusal(data.hypothetical), later: refusal(data.later),
    joke: data.joke ? compile(data.joke, language) : null,
    until: data.until ? compile(data.until, language, 'giu') : null,
  };
  rulesCache.set(language, rules);
  return rules;
}

// A run of number words, evaluated: additive units and tens, multiplicative scales (hundred, thousand). In Chinese, Japanese and Korean 十 百 千 build a
// section and 万 (10000) multiplies everything before it ("二千万", "三万五千").
function evaluate(parts, rules) {
  let total = 0, section = 0, pending = 0, last = 0, lastScale = 0;
  for (const part of parts) {
    if (part.scale) {
      const scale = part.scale;
      if (rules.cjk && scale >= 10000) { total = ((total + section + pending) || 1) * scale; section = 0; }
      else if (!rules.cjk && scale >= 1000) { total += ((section + pending) || 1) * scale; section = 0; }
      else section += (pending || 1) * scale;
      pending = 0; last = 0; lastScale = scale;
    } else { pending += part.value; last = part.value; }
  }
  // Chinese "三千五" is 3500, "一万二" 12000.
  if (rules.tail && last >= 1 && last <= 9 && lastScale >= 100 && parts.length >= 3 && parts[parts.length - 2].scale && pending === last) {
    return total + section + pending * (lastScale / 10);
  }
  return total + section + pending;
}

// The runs of number words in a clause. Spaced languages tokenise (longest phrase first, compounds segmented); Chinese, Japanese and Korean scan their
// numeral characters, and Arabic digits next to them ("1만 5천", "2万5千"), with at most one space inside a run.
function wordedRuns(clause, rules) {
  const runs = [];
  if (rules.cjk) {
    const known = [...new Set([...rules.words.keys(), ...rules.scales.keys()])].sort((a, b) => b.length - a.length);
    let index = 0;
    while (index < clause.length) {
      const parts = [];
      let at = index, digitsSeen = false;
      for (;;) {
        const space = clause[at] === ' ' && parts.length ? 1 : 0;
        const digit = /^\d+(?:\.\d+)?/.exec(clause.slice(at + space));
        if (digit) { parts.push({value: Number(digit[0])}); at += space + digit[0].length; digitsSeen = true; continue; }
        const hit = known.find(word => clause.startsWith(word, at + space));
        if (!hit) break;
        parts.push(rules.scales.has(hit) ? {scale: rules.scales.get(hit)} : {value: rules.words.get(hit)});
        at += space + hit.length;
      }
      const scaled = parts.some(part => part.scale);
      // Korean particles look like numerals (달만, 이번): a run inside a longer Hangul word is no sum.
      const inWord = rules.language === 'ko' && index > 0 && /[가-힯]/.test(clause[index - 1]) && !/^d/.test(clause.slice(index));
      if (parts.length && !inWord && (scaled || !digitsSeen)) {
        const value = evaluate(parts, rules);
        if (Number.isInteger(value)) runs.push({start: index, end: at, value, scaled});
        index = at;
      } else index++;
    }
    return runs;
  }
  const tokens = [...clause.matchAll(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu)].map(match => ({text: match[0], start: match.index, end: match.index + match[0].length}));
  const known = (i, n) => {
    if (tokens[i + n - 1] === undefined) return null;
    const key = tokens.slice(i, i + n).map(t => t.text).join(' ');
    if (rules.words.has(key)) return {parts: [{value: rules.words.get(key)}], length: n};
    if (rules.scales.has(key)) return {parts: [{scale: rules.scales.get(key)}], length: n};
    return null;
  };
  const segment = text => {                       // compound words ("zweihundertfünfzig"): every piece must be a known word
    const parts = [];
    for (let at = 0; at < text.length;) {
      let hit = null;
      for (let end = text.length; end > at; end--) {
        const piece = text.slice(at, end);
        if (rules.words.has(piece) && !/^\d/.test(piece)) hit = {parts: [{value: rules.words.get(piece)}], end};
        else if (rules.scales.has(piece)) hit = {parts: [{scale: rules.scales.get(piece)}], end};
        else if (rules.skip.has(piece) && at > 0 && end < text.length) hit = {parts: [], end};
        if (hit) break;
      }
      if (!hit) return null;
      parts.push(...hit.parts); at = hit.end;
    }
    return parts.length ? parts : null;
  };
  for (let i = 0; i < tokens.length;) {
    const parts = [];
    let j = i;
    const startAt = tokens[i].start;
    let endAt = tokens[i].end;
    while (j < tokens.length) {
      let step = null;
      for (let n = 4; n >= 1 && !step; n--) step = known(j, n);
      if (!step && rules.compound && tokens[j].text.length >= 4) {
        const pieces = segment(tokens[j].text);
        if (pieces) step = {parts: pieces, length: 1};
      }
      if (!step) {
        // a connector word between numbers ("ciento y cinco"): allowed only when a number follows
        if (parts.length && rules.skip.has(tokens[j].text) && j + 1 < tokens.length) {
          let next = null;
          for (let n = 4; n >= 1 && !next; n--) next = known(j + 1, n);
          if (!next && rules.compound && tokens[j + 1].text.length >= 4) next = segment(tokens[j + 1].text) ? {} : null;
          if (next) { j++; continue; }
        }
        break;
      }
      parts.push(...step.parts);
      endAt = tokens[j + step.length - 1].end;
      j += step.length;
    }
    if (parts.length && !VAGUE.test(clause.slice(0, startAt))) {
      runs.push({start: startAt, end: endAt, value: evaluate(parts, rules), scaled: parts.some(part => part.scale)});
    }
    i = Math.max(j, i + 1);
  }
  return runs;
}

/**
 * The first whole sum of eddies in a clause of this language, or null. Digits (1,000 / 1.000 / 1 000, 5k, 2 mil, 2万, €$500, 500€) count with a sign,
 * a scale word, a currency word after them or the clause end; number words count with a scale (hundred, thousand) or a currency word after them.
 * `debt`: a sum after a debt verb ("te debo 500") needs no currency, only two digits or more and nothing that says it is not money.
 */
export function parseAmountIn(language, text, {debt = false} = {}) {
  const rules = rulesOf(language), clause = prepare(text, language);
  const runs = wordedRuns(clause, rules);
  const found = [];
  for (const match of clause.matchAll(rules.digits)) {
    const [whole, sign, raw, scale] = match;
    if (rules.cjk && runs.some(run => match.index >= run.start && match.index < run.end)) continue;       // part of "1만 5천": the run has it
    const after = clause.slice(match.index + whole.length);
    if (rules.notMoney?.test(after) && !sign) continue;
    let value;
    if (GROUPED.test(raw)) value = Number(raw.replace(/\D/g, ''));
    else if (/^\d+$/.test(raw)) value = Number(raw);
    else if (scale && /^\d+[.,]\d+$/.test(raw)) value = Number(raw.replace(',', '.'));
    else continue;
    if (scale) value *= scale === 'k' || scale === 'к' ? 1000 : rules.scales.get(scale) ?? 1;
    const ok = sign || scale || rules.unit?.test(after) || /^\s*(?:$|[.,!?;:)])/.test(after) || rules.after?.test(after)
      || (debt && (/\d{2,}/.test(raw)));
    if (ok && Number.isSafeInteger(value) && value >= 1) found.push({at: match.index, value});
  }
  for (const run of runs) {
    const after = clause.slice(run.end);
    const unitFollows = !!rules.unit?.test(after);
    const atEnd = debt || rules.after?.test(after) || /^\s*(?:$|[.,!?;:)])/.test(after);
    // A bare number word at the end of the clause after a money verb ("te puedo dejar trescientos") is a sum from 20 up, like a bare digit run.
    const bare = rules.unitOnly && !rules.cjk && atEnd && run.value >= 20;
    if (!(run.scaled || bare || (rules.unitOnly && unitFollows)) || run.value < 1) continue;
    if (!unitFollows && !atEnd) continue;
    if (rules.notMoney?.test(after)) continue;
    found.push({at: run.start, value: run.value});
  }
  found.sort((a, b) => a.at - b.at);
  return found.length ? found[0].value : null;
}

const DEBT = new Set(['repay', 'reclaim']);

// String.split on a regular expression compiles a second, sticky copy of it for every language (35 ms the first time); a global exec loop does not.
function splitClauses(text, pattern) {
  const clauses = [];
  let from = 0;
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[0] === '') { pattern.lastIndex++; continue; }
    clauses.push(text.slice(from, match.index));
    from = match.index + match[0].length;
  }
  clauses.push(text.slice(from));
  pattern.lastIndex = 0;
  return clauses.filter(clause => clause.trim());
}

/**
 * V's line read in one language: {about, intent, amount, clause, refused} like screenWords, or null when this language's grammar finds nothing (no money
 * intent, no refusal). `line` is the raw line. Every clause with an intent is a candidate; a refused clause (negation, condition, past or future) is
 * skipped, except that a condition or a time word stops the reading there ("if I lent you 500, would you pay me back" is no ask). The sum is the
 * clause's own, else a filler clause after it ("Remboursez-moi, s'il vous plait, 200 euros"), else the clause before ("3万円、貸して"); for a debt
 * ("Hier, 500 Eddies, die ich dir schulde") the clause next to it may be a give. The first clause with a sum wins ("lend me 800, I will pay you back").
 */
export function screenIn(language, line) {
  const rules = rulesOf(language), text = prepare(line, language);
  const clauses = splitClauses(text, rules.split);
  const intentOf = clause => rules.intents.some(([, pattern]) => pattern.test(clause));
  const candidates = [];
  let refusal = null;
  for (const [index, clause] of clauses.entries()) {
    let stop = false;
    for (const [intent, pattern] of rules.intents) {
      const match = pattern.exec(clause);
      if (!match) continue;
      const debt = DEBT.has(intent);
      // Filler clauses after, the clause before; for a debt ("co ti dluzim") also a give or borrow clause next to it, which holds the sum.
      const neighbours = [];
      for (let i = index + 1; i <= index + 2 && i < clauses.length && (debt || !intentOf(clauses[i])); i++) neighbours.push(clauses[i]);
      const before = index > 0 && (debt || !intentOf(clauses[index - 1])) ? clauses[index - 1] : '';
      if (before) neighbours.push(before);
      let amount = parseAmountIn(language, clause.slice(match.index), {debt}) ?? parseAmountIn(language, clause, {debt});
      if (amount === null) for (const near of neighbours) { amount = parseAmountIn(language, near); if (amount !== null) break; }
      if (amount === null && !rules.money.test(clause) && !neighbours.some(near => rules.money.test(near))) continue;
      // A joke or a time in the clause before ("it was a joke, lend me 500", "when I have money, I will pay you back") takes the ask back; a condition there
      // may just as well be a polite offer ("se ti serve qualcosa, ti presto 100 euro"), so a condition refuses only in the clause's own words.
      const previous = index > 0 && !intentOf(clauses[index - 1]) ? clauses[index - 1] : '';
      // "until tomorrow" / "bis morgen" in an ask is no postponement: the time word is cut out before the time test.
      const timed = rules.until ? clause.replace(rules.until, ' ') : clause;
      if (rules.hypothetical.test(clause) || rules.later.test(timed) || (previous && (rules.joke?.test(previous) || rules.later.test(previous)))) {
        refusal ??= {about: true, intent: null, amount: null, refused: intent};
        stop = true;
      } else if (rules.negation.test(clause)) refusal ??= {about: true, intent: null, amount: null, refused: intent};
      else candidates.push({about: true, intent, amount, clause: clause.trim(), debt});
      break;
    }
    if (stop) break;
  }
  const chosen = candidates.find(candidate => candidate.amount !== null) ?? candidates[0];
  if (chosen) { const {debt, ...read} = chosen; void debt; return read; }
  return refusal;
}

// Warming. A grammar's regular expressions are compiled by V8 the first time they run (about 30 ms a language, half a second for all), and again for a
// line with letters outside Latin-1. That must never land in a turn: the first turn with the setting on only starts the warm-up, one language per
// timer tick, and a language reads lines only once it is warm (until then the line is English-only). warmLanguagesNow is for tests and tools.
const warm = new Set();
let warming = false;
// Lines that make every path of a grammar run: clause split, intents, the refusal tests, digit and word sums (V8 compiles a regular expression again for
// split, matchAll and a wider string, so priming one pattern at a time is not enough).
const PRIMES = ['hola, me prestas 500 eddies? mañana 1.000 k; te debo dos mil', 'ñ ж 長 ő 500 eddies. 2万 , 3 mil и пять сотен 借我', 'borrow lend 200, pay back 5k €$300'];
// The jobs that warm one language: build its rules, then run the lines through it one at a time (a job is 10 to 100 ms).
function primeJobs(language) {
  return [() => {
    rulesOf(language);
    return [...PRIMES.flatMap(text => [1, 2, 3].map(() => () => { screenIn(language, text); parseAmountIn(language, text); })), () => { warm.add(language); }];
  }];
}
function run(queue, job) { const more = job(); if (Array.isArray(more)) queue.unshift(...more); }
export function warmLanguages() {
  if (warming) return;
  warming = true;
  const queue = LANGUAGES.flatMap(primeJobs);
  const step = () => {
    run(queue, queue.shift());
    if (queue.length) setTimeout(step, 0).unref?.();
  };
  setTimeout(step, 0).unref?.();
}
/** Whether a line has a money word of any warm language (the gate in screenWords: no digit and no money word, no grammar runs). */
export function mentionsMoneyAnywhere(line) {
  if (warm.size === 0) return false;
  const lower = line.normalize('NFKC').toLowerCase(), folded = foldWord(lower);
  for (const language of warm) if (rulesOf(language).money.test(CJK.has(language) ? lower : folded)) return true;
  return false;
}
export function warmLanguagesNow() {
  warming = true;
  for (const language of LANGUAGES) if (!warm.has(language)) for (const queue = primeJobs(language); queue.length;) run(queue, queue.shift());
}

/**
 * The line read in the languages it could be in: the detected one first, then the others (the detector is wrong on mixed lines: "Allez, pay me back
 * les 150 eddies" is French with English in it). Returns the first reading that has an intent, else the first refusal, else null. English is read by
 * eddies.mjs itself. Only languages whose script the line holds are tried.
 */
// The languages the detector mixes up with each other: a solid call for one of them still lets its relatives read the line.
const RELATIVES = {es: ['pt', 'it', 'fr'], pt: ['es', 'it', 'fr'], it: ['es', 'pt', 'fr'], fr: ['it', 'es', 'pt'], cs: ['pl'], pl: ['cs'], ru: ['uk'], uk: ['ru']};

export function screenForeign(line) {
  if (!warming) warmLanguages();
  if (warm.size === 0) return null;
  const found = assessLanguage(line);
  const detected = found.language;
  if (found.solid && detected === 'en') return null;       // a line the detector is sure is English is English (read by eddies.mjs): no grammar of another language
  const text = line.normalize('NFKC');
  const scripts = {cyrillic: /[Ѐ-ӿ]/.test(text), kana: /[぀-ヿ]/.test(text), hangul: /[ᄀ-ᇿ㄰-㆏가-힯]/.test(text), han: /[㐀-鿿]/.test(text)};
  const possible = LANGUAGES.filter(code => warm.has(code)).filter(code => {
    if (code === 'ru' || code === 'uk') return scripts.cyrillic;
    if (code === 'ja') return scripts.kana || scripts.han && !scripts.hangul;
    if (code === 'ko') return scripts.hangul;
    if (code === 'zh') return scripts.han && !scripts.kana && !scripts.hangul;
    return !scripts.cyrillic || /[a-z]/i.test(text);
  });
  // A solid call for another language than English decides (with its relatives): a line the detector knows is Polish is not read with the Spanish grammar
  // ("Ten miecz kosztuje 2k"). English, and a call that is not solid, try every language whose script is there, the detected one first.
  const solid = found.solid && detected && detected !== 'en' && possible.includes(detected);
  const order = solid ? [detected, ...(RELATIVES[detected] ?? []).filter(code => possible.includes(code))]
    : detected && possible.includes(detected) ? [detected, ...possible.filter(code => code !== detected)] : possible;
  let refusal = null;
  for (const language of order) {
    const read = screenIn(language, line);
    if (read?.intent) {
      // Close relatives share words and read numbers differently ("dos mil" is 2000 in Spanish, a Portuguese reading finds only "mil"): when they agree on
      // the intent, the fuller reading, the larger sum, wins.
      let best = {...read, language};
      for (const other of order.slice(order.indexOf(language) + 1)) {
        const again = screenIn(other, line);
        if (again?.intent === best.intent && (again.amount ?? 0) > (best.amount ?? 0)) best = {...best, amount: again.amount};
      }
      return best;
    }
    if (read && !refusal) refusal = {...read, language};
    // The detected language refused (a condition, a negation): its relatives do not get to read the same words as an ask.
    if (read && solid && language === detected) break;
  }
  return refusal;
}
