// Eddies between V and the characters (docs/EDDIES.md): Settings > Gameplay > Eddies with characters, off by default.
//
// The bridge half. Pure functions plus one small class; no file of its own is read, no request is made. The game sends, with a private turn to a
// named character while the setting is on, an `eddies` block (mod/eddies.lua): whether the character is one of V's own copies (party, invited visitor,
// housemate), V's balance, the clock and the character's ledger row (the game owns the ledger, runtime/eddies-ledger.json). From that and the
// character's money data (bridge/eddies-finances.mjs) the bridge decides what the character does about money this turn and tells the character in
// one volatile note, on every provider. When the decision is a transfer, the bridge writes a proposal after the reply is published
// (runtime/eddies-offer.json); the game moves the eddies at once, when the reply is over and V is free. The model decides nothing: the bridge's reading
// of V's words makes the proposal, and the game checks it again (V's balance, the cap, the debt) before it moves anything.
//
// Cost: ordinary talk pays nothing. A typed line is screened by a few regular expressions (well under a millisecond); only a line about money, a
// character with an open debt, or a rare initiative roll gets a note. A spoken line's words are not known when its context is made, so an own copy's
// spoken turn carries one short "standing" note (what the character would lend), and the words are screened when the transcript arrives.
import {FINANCES} from './eddies-finances.mjs';
import {MIC_PLACEHOLDER} from './call-meet.mjs';
import {screenForeign, warmFor, mentionsMoneyAnywhere} from './eddies-languages.mjs';

/** The most eddies one transfer can move, whatever the balances (mod/eddies.lua holds the same number). */
export const EDDIES_CAP = 100000;
/** The six ways eddies move. toV: the character pays V. */
export const FLOWS = Object.freeze(['loanToV', 'loanFromV', 'repayByV', 'repayToV', 'giftFromV', 'giftToV']);
export const TO_V = Object.freeze(new Set(['loanToV', 'repayToV', 'giftToV']));
export const COPY_KINDS = Object.freeze(['party', 'visitor', 'housemate']);
const RESULTS = new Set(['done', 'declined', 'missed', 'failed']);
const DAY = 86400;
/** What a character received from V (or paid out) fades back to their usual means with this half-life (mod/eddies.lua uses the same). */
export const FLOW_HALF_LIFE_DAYS = 7;
/** A character asks V for money at most once in this many days, and at most once per bridge session. */
export const ASK_COOLDOWN_DAYS = 3;
const ASK_CHANCE = Object.freeze({never: 0, rarely: 0.04, sometimes: 0.08});
const REPAY_CHANCE = 0.3;

const whole = (value, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= min && value <= max;
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The game's block

function parseRow(value) {
  if (!plain(value)) return null;
  const totals = {};
  for (const flow of FLOWS) totals[flow] = whole(value.totals?.[flow], 0, 1e9) ? value.totals[flow] : 0;
  const row = {seed: whole(value.seed, 0, 999) ? value.seed : 500, met: whole(value.met, 0) ? value.met : 0,
    flow: Number.isFinite(value.flow) && Math.abs(value.flow) <= 1e9 ? value.flow : 0, flowAt: whole(value.flowAt, 0) ? value.flowAt : 0, totals,
    asked: whole(value.asked, 0) ? value.asked : 0, recent: []};
  if (plain(value.last) && FLOWS.includes(value.last.flow) && whole(value.last.amount, 1, EDDIES_CAP) && RESULTS.has(value.last.result) && whole(value.last.at, 0)) {
    row.last = {flow: value.last.flow, amount: value.last.amount, result: value.last.result, at: value.last.at,
      ...(value.last.origin === 'asked' || value.last.origin === 'offered' ? {origin: value.last.origin} : {})};
  }
  return row;
}

/**
 * The `eddies` block of a request (mod/eddies.lua P.block), or null. {on: true, own, copy, balance, now, row, decides}: `own` only for one of V's own copies,
 * which alone carries V's balance; `row` is the character's ledger row (absent before they first dealt with V); `decides`: a named character with money
 * data, whose money talk the eddies note owns (bridge/turn-context.mjs moneyNote then stays out of it). An ordinary NPC never decides.
 */
export function parseEddies(value, profileKey) {
  if (!plain(value) || value.version !== 1 || value.on !== true || !whole(value.now, 1)) return null;
  const own = value.own === true && COPY_KINDS.includes(value.copy) && whole(value.balance, 0, 1e10);
  const decides = !isArchetype(profileKey) && financeOf(profileKey) !== null;
  return {on: true, own, ...(own ? {copy: value.copy, balance: value.balance} : {}), now: value.now, row: parseRow(value.row), decides};
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Money data

/** The money data of a profile: a named character's own row, an ordinary NPC's archetype row (npc-<base>-<gender>), or null. */
export function financeOf(profileKey) {
  if (typeof profileKey !== 'string') return null;
  if (Object.hasOwn(FINANCES, profileKey)) return FINANCES[profileKey];
  const base = /^npc-(.+)-(?:male|female)$/.exec(profileKey)?.[1];
  return base && Object.hasOwn(FINANCES, 'npc-' + base) ? FINANCES['npc-' + base] : null;
}
export const isArchetype = profileKey => typeof profileKey === 'string' && profileKey.startsWith('npc-');

/** What V owes the character and what the character owes V, from the ledger row. */
export function debts(row) {
  const t = row?.totals ?? {};
  return {vOwes: Math.max(0, (t.loanToV ?? 0) - (t.repayByV ?? 0)), owesV: Math.max(0, (t.loanFromV ?? 0) - (t.repayToV ?? 0))};
}

/** The flow (eddies received from V minus paid out) faded to `now`: half of it is gone after FLOW_HALF_LIFE_DAYS. */
export function fadedFlow(row, now) {
  if (!row || !row.flow) return 0;
  const days = Math.max(0, (now - (row.flowAt || now)) / DAY);
  return row.flow * Math.pow(0.5, days / FLOW_HALF_LIFE_DAYS);
}

/** The eddies the character can lay hands on now: their usual means (the data's cash, varied by the row's seed) plus the faded flow. */
export function purse(finance, row, now) {
  if (!finance || finance.cash <= 0) return 0;
  const baseline = finance.cash * (0.8 + ((row?.seed ?? 500) % 1000) / 1000 * 0.4);
  return Math.max(0, Math.round(baseline + fadedFlow(row, now)));
}

/** A round sum at or below `value` (10s under 100, 50s under 1000, 100s under 10000, 1000s above). */
export function roundDown(value) {
  if (!(value > 0)) return 0;
  const step = value < 100 ? 10 : value < 1000 ? 50 : value < 10000 ? 100 : 1000;
  return Math.floor(value / step) * step;
}

/**
 * How far the character trusts V with money, 0 to 1: their standing with V in the game (one of V's own copies, how: party, visitor, housemate; a
 * relationship the save confirms or the player turned on, bridge/relationship-routing.mjs), how long they have known V (`familiarity`, days since their
 * ledger row was made), and V's record with money (paid back before, owes now, said no when they asked).
 */
export function trustOf({copy = null, romance = null, familiarity = 0, row = null} = {}) {
  let trust = 0.3;
  trust += copy === 'housemate' ? 0.2 : copy === 'party' ? 0.15 : copy === 'visitor' ? 0.1 : 0;
  trust += romance === 'partner' ? 0.3 : romance === 'casual' ? 0.1 : 0;
  trust += Math.min(0.15, Math.max(0, familiarity) * 0.005);
  const {vOwes} = debts(row);
  if ((row?.totals?.repayByV ?? 0) > 0) trust += 0.1;
  if (vOwes > 0) trust -= 0.15;
  if (row?.last?.result === 'declined' && row.last.origin === 'asked') trust -= 0.05;
  return clamp(Math.round(trust * 100) / 100, 0, 1);
}

/** The most the character would lend V now, and why it is 0 when it is: 'nowallet', 'debt', 'broke' or 'trust'. */
export function lendLimit(finance, row, now, trust) {
  if (!finance || finance.cash <= 0) return {cap: 0, why: 'nowallet'};
  const have = purse(finance, row, now), {vOwes} = debts(row);
  if (vOwes > Math.max(200, have * 0.3)) return {cap: 0, why: 'debt'};
  const cap = Math.min(EDDIES_CAP, roundDown(have * 0.6 * clamp(finance.generosity * (0.5 + trust), 0, 1)));
  if (cap > 0) return {cap, why: null};
  return {cap: 0, why: have < 100 ? 'broke' : 'trust'};
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The screen of V's words

// Money words in the 15 menu languages: a line with none of them (and no amount after a money verb) is never about eddies. The intent grammar below is
// English for now (docs/EDDIES.md "Languages"); a line in another language that is about money gets the standing note, never a decision.
const MONEY_WORDS = new RegExp(String.raw`(?:^|[^\p{L}])(?:eddies|eddie|eds|eurodollars?|euro ?dollars?|creds?|credits?|cash|money|bucks|scratch|`
  + String.raw`lend|loan|borrow|repay|owe|owes|owed|debt|pay (?:me|you) back|pay up|`
  + String.raw`geld|kohle|leih|schuld|argent|fric|thune|pr[eê]t|pr[eê]te|dette|dinero|pasta|plata|pr[eé]sta|deuda|soldi|presta|debito|dinheiro|grana|empr[eé]st|d[ií]vida|`
  + String.raw`pieni[aą]dz|kas[aęy]|fors|po[zż]ycz|d[lł]ug|деньг|бабк|бабл|эдди|одолж|займ|долг|гроші|грош|едді|позич|борг|para(?![\p{L}])|bor[cç]|[oö]d[uü]n[cç]|`
  + String.raw`pen[ií]z|pen[eě]z|prachy|p[uů]j[cč]|dluh|p[eé]nz|l[oó]v[eé]|k[oö]lcs[oö]n|ad[oó]ss)|`
  + String.raw`[€$]\s?\d|\d\s?(?:€\$|e\$)|エディ|お金|借|貸|返|에디|돈|빌려|갚|钱|欧元|借|还`, 'iu');

const NUMBER_WORDS = {a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, couple: 2, few: 3};
const MONEY_UNIT = String.raw`(?:eddies|eddie|eds|ed|eurodollars?|euro ?dollars?|creds?|credits?|bucks|€\$|e\$|\$)`;
const DIGITS = new RegExp(String.raw`(?:(?:€\$|e\$|\$)\s?(\d[\d,.]*)\s?(k|grand)?|(\d[\d,.]*)\s?(k|grand)?(?:\s?${MONEY_UNIT}(?![\p{L}])|(?=\s*(?:$|[.,!?;:)]|\s(?:to|for|now|please|back|more|till|until|of|so|and|then|right)\b))))`, 'iu');
const WORDED = new RegExp(String.raw`\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|couple|few)`
  + String.raw`(?:\s+of)?\s+(hundred|thousand|grand|k)?\s*${MONEY_UNIT}?`, 'i');

/** One whole amount of eddies in a clause (digits, 5k, 2 grand, €$500, "five hundred eddies", "a grand"), or null. */
export function parseAmount(clause) {
  const digits = DIGITS.exec(clause);
  if (digits) {
    const raw = digits[1] ?? digits[3], unit = (digits[2] ?? digits[4] ?? '').toLowerCase();
    // A bare digit under 10 with no currency word or sign is a count ("take 5", "I need 2 more bullets"), not a sum.
    if (!unit && /^\d{1,9}$/.test(raw) && Number(raw) < 10 && !/[\p{L}€$]/u.test(digits[0].replace(raw, ''))) return null;
    // 1,000 and 1.000 are thousands; a decimal part (0.5, 2.55) is not a sum of eddies, except before k (2.5k).
    let value;
    if (/^\d{1,3}(?:[,.]\d{3})+$/.test(raw)) value = Number(raw.replace(/[,.]/g, ''));
    else if (/^\d+$/.test(raw)) value = Number(raw);
    else if (unit && /^\d+[.,]\d+$/.test(raw)) value = Number(raw.replace(',', '.'));
    else return null;
    value *= unit === 'k' || unit === 'grand' ? 1000 : 1;
    return Number.isSafeInteger(value) && value >= 1 ? value : null;
  }
  const worded = WORDED.exec(clause);
  if (!worded) return null;
  const count = NUMBER_WORDS[worded[1].toLowerCase()], scale = (worded[2] ?? '').toLowerCase();
  const unitNamed = new RegExp(MONEY_UNIT + '\\s*$', 'i').test(worded[0].trim());
  if (!scale && !unitNamed) return null;                     // "a few" alone is no sum
  if (!scale && ['a', 'an', 'couple', 'few'].includes(worded[1].toLowerCase())) return null;  // "a few eddies": no sum named
  const value = count * (scale === 'hundred' ? 100 : scale === 'thousand' || scale === 'grand' || scale === 'k' ? 1000 : 1);
  return value >= 1 ? value : null;
}

// What V means, English. Each pattern is checked on one clause of V's line (split at . ! ? ; , and "but"), lower case, curly apostrophes made straight.
const INTENTS = [
  // V wants the character to pay back what they owe.
  ['reclaim', /\b(?:pay me back|paying me back|give me (?:back )?my (?:money|eddies|cash|eds)|my (?:money|eddies|cash|eds) back|you owe me|what you owe me|return my (?:money|eddies|cash|eds)|when (?:are|will) you (?:gonna |going to )?pay me|settle (?:up )?your debt|time to pay up|pay up)\b/],
  // V pays back what V owes.
  ['repay', /\b(?:pay(?:ing)? you back|paying back|repay(?:ing)?(?! me)|here'?s (?:your|the) (?:money|eddies|cash|eds) back|(?:what|the (?:money|eddies|cash) ) ?i owe you|i owe you|my debt|settle (?:up|my debt|what i owe)|square (?:things )?up|we'?re square|back what i owe)\b/],
  // V offers a loan by asking whether the character needs one ("do you need money?"): before 'borrow', whose "borrow some" it contains.
  ['lend', /\b(?:(?:do|would|did) you (?:want|need|wanna|like) (?:to borrow|a loan|some (?:money|cash|eddies|eds))|you need (?:a loan|some (?:money|cash|eddies)|money|cash|eddies))\b/],
  // V asks the character to lend (or give) V money.
  ['borrow', /\b(?:lend me(?! (?:a hand|your ear|a sec))|loan me|(?:can|could|may|let) (?:i|me) borrow|borrow (?:some|a few|a bit|a little|\d|€|\$|a hundred|a grand|money|eddies|cash)|spot me|front me|float me|advance me|(?:can|could|would|will) you (?:give|spare|lend|loan|send|wire|transfer) me|spare (?:me )?(?:some|a few|any|\d)|i need (?:some |a few |a bit of |a little |a loan|\d|€|\$)|i'?m (?:broke|short on (?:cash|eddies|money))|help me out with|give me (?:some |a few |\d|€|\$|a hundred|a grand)|need a loan|got any (?:money|eddies|cash|eds) (?:to spare|for me))/],
  // More ways to ask, as players type them (the live test of 2026-10-28 missed "give me a thousand eddies", "can I get 200 eddies", "need 300 eddies",
  // "would you mind lending me 300", "spot 200 eddies", "hook me up with 500"). A worded hundred or thousand needs a money word (bullets are not eddies).
  ['borrow', /\b(?:give me (?:(?:a|an|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty) (?:hundred|thousand) (?:eddies|eds|eurodollars?|creds?|credits?|bucks)|(?:a|one|two|three|four|five|six|seven|eight|nine|ten) grand)|gimm(?:e|ie) (?:me )?(?:some |a few |\d|€|\$|a (?:hundred|thousand|grand))|(?:can|could|may) i (?:get|have|take) (?=.*(?:eddies|eddie|\beds\b|money|cash|creds?|credits?|bucks|\bgrand\b|€\$|e\$|\$\s?\d|\d\s?k\b))|(?:can|could|would|will) you (?:hook me up|throw me|toss me|slide me|drop me|hand me|set me up with|bless me)|(?:lend|loan)ing me(?! (?:a hand|your ear|a sec))|spot (?:\d|€|\$|a (?:hundred|thousand|grand))|hit me (?:up )?with (?:\d|€|\$|some (?:money|cash|eddies))|i'?m (?:short|out) of (?:cash|money|eddies))/],
  ['borrow', /(?:^\s*|\bi (?:really |just |still |kinda )?|\bi'?m (?:gonna |going to )?)need (?:some |a few |a bit of |a little |a loan|\d|€|\$|(?:a|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty) (?:hundred|thousand) (?:eddies|eds|eurodollars?|creds?|credits?|bucks)|(?:a|one|two|three|four|five|six|seven|eight|nine|ten) grand)/],
  ['borrow', /(?:^\s*|\b(?:do |did )?(?:you|u|ya) )(?:got|have)\s+(?:any |some |a few |a bit of )?[^.]{0,40}?(?:to spare|for me|i (?:could|can) borrow|you (?:could|can) (?:spare|lend|give))/],
  // V offers to lend the character money.
  ['lend', /\b(?:i(?:'ll| will| can| could|'m going to| am going to| want to|'d like to)? (?:lend|lent|loan|float|front) you|let me (?:lend|loan|front|float) you|(?:lend|loan)(?:ing)? you|borrow (?:it |them |some |this |that )?from me|take a loan from me|you can borrow)\b/],
  // V gives the character money (a gift, a tip, a payment for something).
  ['give', /\b(?:(?:here'?s|here is|here are) (?=\d|€|\$|some |a (?:few|hundred|grand|couple)|(?:a|one|two|three|four|five|six|seven|eight|nine|ten|twenty|fifty) (?:hundred|thousand|grand)|(?:the|your|my|this|these) (?:money|eddies|cash|eds|creds))|here,? take|take (?:this|these|it|them|the|some|\d|€|\$)|have (?:this|these|some)|i(?:'ll| will| can|'m going to| am going to| want to|'d like to)? (?:give|send|transfer|wire|pay|tip) you|(?:giving|sending|transferring|wiring|tipping|paying) you|a gift|keep the change|it'?s on me|my treat|for your trouble)/],
];
// What makes a clause about money for the English intents: a sum, a money noun, or a phrase that only money fits ("I owe you one" is thanks, "pay me back" is not).
const CASH = /\b(?:eddies|eddie|eds|eurodollars?|euro ?dollars?|creds?|credits?|cash|money|bucks|scratch|loan|debt)\b|pay (?:me|you) back|repay|[€$]/;
const NEGATION = /\b(?:don'?t|do not|not|never|no way|won'?t|cannot|can'?t|couldn'?t|wouldn'?t|didn'?t|shouldn'?t|without|nobody|no one)\b/;
// A negative question still asks ("can't you lend me 50?"): these openings are not negations.
const NEGATIVE_ASK = /\b(?:can'?t|couldn'?t|won'?t|wouldn'?t) you\b/g;
const HYPOTHETICAL = /\b(?:if|would you ever|what if|imagine|suppose|hypothetically|pretend|joking|kidding)\b/;
// "mind if I borrow 200" asks: the "if" is politeness, not a condition.
const MIND_IF = /\b(?:do you |would you )?mind if i\b/g;
// "I'll", "I promise" ... right before "pay you back": a promise, not a payment.
const PROMISE = /\b(?:i'?ll|i will|i'd|i would|i promise|i swear|gonna|going to|i can|i could)\s+(?:(?:definitely|totally|surely|easily|also|then|for sure|really)\s+)?$/;
const LATER = /\b(?:tomorrow|later|next (?:week|month|time)|someday|some day|one day|soon|when i (?:get|can|have)|after (?:the|this|that) (?:job|gig)|yesterday|already|last (?:week|time|night))\b/;

/**
 * V's words, read: {about, intent, amount, clause}. `about`: the line is about money at all (any language); `intent`: reclaim, repay, borrow, lend, give or
 * null. English is read here, the other menu languages by bridge/eddies-languages.mjs (docs/EDDIES.md "Languages"); English goes first because the
 * characters and the players mix it into every language. A refusal ("I won't lend you anything", "if I lent you...") has `refused`, never an intent.
 */
export function screenWords(text) {
  if (typeof text !== 'string') return {about: false, intent: null, amount: null};
  const line = text.slice(0, 600).replace(/[‘’ʼ]/g, "'");
  const english = screenEnglish(line);
  if (english.intent) return english;
  if (!/\d/.test(line.normalize('NFKC')) && !english.about && !mentionsMoneyAnywhere(line)) return english;
  const foreign = screenForeign(line);
  if (foreign?.intent) return foreign;
  if (english.refused) return english;
  return foreign ? {...foreign, about: true} : english;
}

function screenEnglish(line) {
  const about = MONEY_WORDS.test(line);
  if (!about && !/\d/.test(line) && !/\b(?:hundred|thousand|grand)\b/i.test(line)) return {about: false, intent: null, amount: null};
  // Clauses end at . ! ? ; "but", "and then" and a comma that is not inside a number (1,000 stays one sum).
  const clauses = line.toLowerCase().replace(MIND_IF, 'can i').split(/[!?;]+|\.(?!\d)|,(?!\d{3}\b)|\bbut\b|\band then\b/);
  const intentOf = clause => INTENTS.some(([, pattern]) => pattern.test(clause));
  const asksFor = clause => INTENTS.some(([name, pattern]) => name === 'borrow' && pattern.test(clause));
  for (const [index, clause] of clauses.entries()) {
    for (const [intent, pattern] of INTENTS) {
      const match = pattern.exec(clause);
      if (!match) continue;
      // "give me 200 and I'll pay you back": a promise next to an ask is the ask, not a payback.
      if (intent === 'repay' && PROMISE.test(clause.slice(0, match.index)) && asksFor(clause)) continue;
      const before = clause.slice(0, match.index + match[0].length).replace(NEGATIVE_ASK, ' ');
      // The sum may follow in the next clause when that clause asks for nothing of its own ("Take this, 1,000 eddies").
      const next = clauses[index + 1] ?? '', tail = next && !intentOf(next) ? next : '';
      // A debt is money already, so a bare number there is a sum ("here's the 500 I owe you"); elsewhere a bare number may be minutes or bullets.
      const debt = intent === 'repay' || intent === 'reclaim';
      const bare = debt ? /(?:^|\s)(\d{1,3}(?:,\d{3})+|\d{2,6})(?=\s|$)/.exec(clause)?.[1] : undefined;
      const amount = parseAmount(clause.slice(match.index)) ?? parseAmount(clause) ?? (tail ? parseAmount(tail) : null)
        ?? (bare ? Number(bare.replace(/,/g, '')) : null);
      // A money intent needs money in its own clause (or that next one): a money word or a sum ("here's the thing about money" is no gift).
      if (amount === null && !CASH.test(clause) && !(tail && CASH.test(tail))) continue;
      if (NEGATION.test(before) || HYPOTHETICAL.test(before) || LATER.test(clause)) return {about: true, intent: null, amount: null, refused: intent};
      return {about: true, intent, amount, clause: clause.trim()};
    }
  }
  return {about, intent: null, amount: null};
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The character's note and the game's proposal

const TIER = Object.freeze({broke: 'broke', tight: 'short of money', modest: 'getting by', comfortable: 'comfortable', wealthy: 'well off', rich: 'rich'});
const sum = n => `${Math.round(n).toLocaleString('en-US')} eddies`;
const daysAgo = (at, now) => {
  const days = Math.floor(Math.max(0, now - at) / DAY);
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
};
const LAST_TEXT = Object.freeze({
  loanToV: {done: 'you lent V {n}', declined: 'V turned down the {n} you offered to lend', missed: 'the {n} you meant to lend V never changed hands', failed: 'the {n} you meant to lend V never changed hands'},
  loanFromV: {done: 'V lent you {n}', declined: 'V said no when you asked to borrow {n}', missed: 'the {n} loan from V never went through', failed: 'the {n} loan from V never went through'},
  repayByV: {done: 'V paid you back {n}', declined: 'V decided not to pay you back {n} after all', missed: 'V\'s {n} payback never went through', failed: 'V\'s {n} payback never went through'},
  repayToV: {done: 'you paid V back {n}', declined: 'V would not take the {n} you tried to pay back', missed: 'your {n} payback to V never went through', failed: 'your {n} payback to V never went through'},
  giftFromV: {done: 'V gave you {n}', declined: 'V changed their mind about giving you {n}', missed: 'the {n} V meant to give you never arrived', failed: 'the {n} V meant to give you never arrived'},
  giftToV: {done: 'you gave V {n}', declined: 'V turned down the {n} you offered', missed: 'the {n} you meant to give V never changed hands', failed: 'the {n} you meant to give V never changed hands'},
});

/** One sentence of what is owed between the character and V, and what last happened with money between them; '' when nothing ever did. */
export function ledgerLine(row, now) {
  if (!row) return '';
  const {vOwes, owesV} = debts(row), parts = [];
  if (vOwes) parts.push(`V owes you ${sum(vOwes)}.`);
  if (owesV) parts.push(`You owe V ${sum(owesV)}.`);
  if (row.last) {
    const text = LAST_TEXT[row.last.flow][row.last.result].replace('{n}', sum(row.last.amount));
    parts.push(`Last time money came up: ${text} (${daysAgo(row.last.at, now)}).`);
  }
  if (!parts.length) return '';
  if (!vOwes && !owesV) parts.unshift('Nothing is owed between you and V.');
  return 'Between you and V: ' + parts.join(' ');
}

const meansLine = (finance, have) => `Your money: you are ${TIER[finance.tier] ?? 'getting by'}, with about ${sum(have)} you could lay hands on. ${finance.style}`;
const RULE = 'Eddies change hands the moment you agree in your reply, so agree only to what you really mean to do, and never say money moved when you refused. '
  + 'Never invent a different sum than the one stated here.';
const TALK_RULE = 'No eddies can change hands in this conversation. If money comes up, talk about it in character, but never say you handed over or received any.';

function standingLine(limit) {
  const lend = limit.cap > 0 ? `the most you would lend V right now is ${sum(limit.cap)}; if V asks for more, offer that much or say no`
    : limit.why === 'nowallet' ? 'you have no money of your own to lend' : limit.why === 'debt' ? 'you will not lend V more until V pays back what V owes you'
      : limit.why === 'broke' ? 'you cannot spare any eddies right now' : 'you do not trust V with your money yet';
  return `If V asks to borrow eddies: ${lend}. If V offers you eddies or pays you back, react in your own way.`;
}

const proud = finance => (finance.tier === 'wealthy' || finance.tier === 'rich') && finance.asks === 'never';

/**
 * What the character does about V's words (`screen`, from screenWords) with V's own copy. Returns {say, flow, amount, origin} or null when the words ask
 * for nothing the character can act on. `say` is the decision told to the character; `flow`/`amount` the proposal (absent when nothing moves).
 */
export function decideWords(screen, {finance, row, now, balance, trust}) {
  const {vOwes, owesV} = debts(row), have = purse(finance, row, now), asked = screen.amount;
  switch (screen.intent) {
    case 'borrow': {
      const limit = lendLimit(finance, row, now, trust);
      if (limit.cap <= 0) {
        const why = {nowallet: 'You have no money of your own to lend: say so in your own way.',
          debt: `V still owes you ${sum(vOwes)}: you will not lend more until V pays you back. Say so in your own way.`,
          broke: 'You cannot spare any eddies: you are short yourself. Refuse in your own way, without a lecture.',
          trust: 'You do not trust V with your money yet. Refuse in your own way.'}[limit.why];
        return {say: `V asks to borrow ${asked ? sum(asked) : 'some eddies'}. ${why}`};
      }
      const want = asked ?? roundDown(Math.min(limit.cap, Math.max(100, have * 0.1)));
      if (want <= limit.cap) return {say: `V asks to borrow ${asked ? sum(asked) : 'some eddies'}. You agree to lend V ${sum(want)}. Say yes in your own way.`, flow: 'loanToV', amount: want, origin: 'offered'};
      if (limit.cap >= Math.max(50, want * 0.25)) {
        return {say: `V asks to borrow ${sum(want)}. That is more than you can spare: you offer to lend V ${sum(limit.cap)} instead. Say so in your own way.`, flow: 'loanToV', amount: limit.cap, origin: 'offered'};
      }
      return {say: `V asks to borrow ${sum(want)}. That is far more than you can spare. Refuse in your own way.`};
    }
    case 'lend':
    case 'give': {
      const flow = screen.intent === 'lend' ? 'loanFromV' : 'giftFromV', verb = screen.intent === 'lend' ? 'lend' : 'give';
      if (!asked) return {say: `V offers to ${verb} you eddies but has not said how much. You may ask how much, or turn it down. Nothing changes hands until V names a sum.`};
      if (finance.cash <= 0) return {say: `V offers to ${verb} you ${sum(asked)}, but you have no wallet to put it in. Say so in your own way.`};
      if (asked > balance) return {say: `V offers to ${verb} you ${sum(asked)}, but V does not have that much on them. Do not accept money V does not have.`};
      if (asked > EDDIES_CAP) return {say: `V offers to ${verb} you ${sum(asked)}: no one hands over that much at once. Say so in your own way.`};
      if (proud(finance)) return {say: `V offers to ${verb} you ${sum(asked)}. You do not need V's money: turn it down in your own way.`};
      return {say: `V offers to ${verb} you ${sum(asked)}. You accept in your own way.`, flow, amount: asked, origin: 'offered'};
    }
    case 'repay': {
      if (!vOwes) return {say: 'V talks of paying you back, but V owes you nothing. Say so in your own way.'};
      const amount = Math.min(asked ?? vOwes, vOwes);
      if (amount > balance) return {say: `V wants to pay you back ${sum(amount)} but does not have that much on them. Say it can wait.`};
      return {say: `V is paying back ${sum(amount)} of the ${sum(vOwes)} V owes you. Accept it in your own way.`, flow: 'repayByV', amount, origin: 'offered'};
    }
    case 'reclaim': {
      if (!owesV) return {say: 'V asks for money back, but you owe V nothing. Say so in your own way.'};
      const lastLoan = row?.last?.flow === 'loanFromV' && row.last.result === 'done' ? row.last.at : 0;
      const fresh = lastLoan && now - lastLoan < DAY;
      if (fresh && (finance.repays === 'late' || finance.repays === 'rarely')) return {say: `V asks for the ${sum(owesV)} you owe back already. You ask V for a little more time, in your own way.`};
      let can = Math.min(owesV, have * 0.8);
      if (finance.repays === 'rarely') can *= 0.5;
      can = can >= owesV ? owesV : roundDown(can);
      if (can >= Math.max(10, owesV * 0.2)) {
        return {say: can === owesV ? `V asks for the ${sum(owesV)} you owe. You pay it all back now, in your own way.`
          : `V asks for the ${sum(owesV)} you owe. You can pay back ${sum(can)} of it now and say when the rest comes.`, flow: 'repayToV', amount: can, origin: 'offered'};
      }
      return {say: `V asks for the ${sum(owesV)} you owe. You do not have it right now: say so and promise it, in your own way.`};
    }
    default: return null;
  }
}

/** The character's own move about money this turn, when the dice say so: pay V back what they owe, or ask V to lend them money. Or null. */
export function decideInitiative({finance, row, now, balance, trust, random = Math.random}) {
  const {vOwes, owesV} = debts(row), have = purse(finance, row, now);
  if (owesV > 0) {
    const since = row?.last?.at ?? 0;
    if (now - since < DAY || !['always', 'usually'].includes(finance.repays) || have < owesV * 0.5) return null;
    if (random() >= REPAY_CHANCE) return null;
    const amount = Math.min(owesV, roundDown(have * 0.8) || owesV);
    return {say: `You have the eddies to pay V back ${amount === owesV ? 'the' : sum(amount) + ' of the'} ${sum(owesV)} you owe. Do it in this reply, briefly and in your own way.`,
      flow: 'repayToV', amount, origin: 'asked'};
  }
  const chance = ASK_CHANCE[finance.asks] ?? 0;
  if (!chance || !finance.needs?.length || vOwes > 0 || trust < 0.5) return null;
  if (row?.asked && now - row.asked < ASK_COOLDOWN_DAYS * DAY) return null;
  if (random() >= chance) return null;
  const amount = roundDown(clamp(finance.cash * 0.3, 100, 5000));
  if (!amount || balance < amount * 2) return null;
  const need = finance.needs[Math.floor(random() * finance.needs.length) % finance.needs.length];
  return {say: `You need ${sum(amount)} for ${need}. Bring it up yourself in this reply, briefly and in your own way, and ask V to lend it to you. Nothing moves unless V agrees in their own words.`,
    flow: 'loanFromV', amount, origin: 'asked'};
}

const typedWords = text => typeof text === 'string' && text.trim() !== '' && text.trim() !== MIC_PLACEHOLDER;

/**
 * The money decisions of the session: one turn's decision is made once (the first time its context is built) and kept with the turn; a character asks or
 * pays back on their own at most once per session. `random`: the dice (tests pass their own).
 */
export class EddiesDecisions {
  constructor({random = Math.random, log = () => {}} = {}) {
    this.random = random; this.log = log;
    // By request id (the same turn may reach the context builder as more than one object): the last 64 turns.
    this.turns = new Map();
    this.initiative = new Set();
  }

  #key(input) { return typeof input?.requestId === 'string' && input.requestId ? input.requestId : null; }

  /**
   * The decision of one turn: {note, proposal, trace}, or null when the feature is not in this turn. `facts`: {romance: 'partner'|'casual'|null,
   * familiarity: exchanges remembered}. Not for a group round, a reaction, a call or a phone chat.
   */
  forTurn(input, facts = {}) {
    if (!input || typeof input !== 'object') return null;
    const key = this.#key(input);
    if (key && this.turns.has(key)) return this.turns.get(key);
    const decision = this.#decide(input, facts);
    if (key) {
      this.turns.set(key, decision);
      if (this.turns.size > 64) this.turns.delete(this.turns.keys().next().value);
    }
    return decision;
  }

  #decide(input, facts) {
    const block = input.eddies;
    if (!block?.on || input.reaction || input.group || input.holocall || input.head) return null;
    const finance = financeOf(input.profileKey);
    if (!finance) return null;
    const {now, row} = block, typed = typedWords(input.text);
    if (typed) warmFor(input.text);   // the player's language warms up in small background slices, never inside a turn (bridge/eddies-languages.mjs)
    const screen = typed ? screenWords(input.text) : null;
    const ambient = isArchetype(input.profileKey);
    // An ordinary NPC, or a character the game placed: talk only. The NPC keeps the old money note (turn-context.mjs moneyNote: V pays, words only) and gets
    // its group's way with money; a named character the game placed is told plainly that nothing can move.
    if (ambient) return screen?.about ? {note: `How you handle money: ${finance.style}`, proposal: null, trace: 'talk:ambient'} : null;
    if (!block.own) {
      const ledger = ledgerLine(row, now);
      if (!screen?.about && !debts(row).vOwes && !debts(row).owesV) return null;
      return {note: ['Eddies:', meansLine(finance, purse(finance, row, now)), ledger, screen?.about ? TALK_RULE : ''].filter(Boolean).join(' '), proposal: null, trace: 'talk'};
    }
    // How long the character has known V in this mod (days since their first money-aware turn), unless the caller knows better.
    const familiarity = Number.isFinite(facts.familiarity) ? facts.familiarity : row?.met ? Math.floor(Math.max(0, now - row.met) / DAY) : 0;
    const trust = trustOf({copy: block.copy, romance: facts.romance ?? null, familiarity, row});
    const context = {finance, row, now, balance: block.balance, trust};
    const have = purse(finance, row, now), ledger = ledgerLine(row, now);
    const parts = ['Eddies (game-verified, this turn):', meansLine(finance, have), ledger];
    let move = null, trace;
    if (screen?.intent) {
      move = decideWords(screen, context);
      trace = `words:${screen.intent}${screen.amount ? ':' + screen.amount : ''}`;
    } else if (screen?.about) {
      parts.push(standingLine(lendLimit(finance, row, now, trust)));
      // The words were not read as a clear ask with a sum, so nothing will move: do not agree to money V has not put a sum on.
      parts.push('V has not named a sum you can act on: if V seems to want money, ask how much, and do not agree to an amount V has not said.');
      trace = screen.refused ? `about:refused-${screen.refused}` : 'about';
    } else if (!typed) {
      // A spoken line: its words are known only after the reply (finish below), so the character knows its limits now, in short (no means line: most
      // spoken turns are not about money, and this note rides on every one of them).
      parts.splice(1, 1);
      parts.push(standingLine(lendLimit(finance, row, now, trust)));
      trace = 'unheard';
    }
    // The character's own move (pay V back, ask for a loan) only on a typed line that is not about money: a spoken line's words are not known yet, and the
    // reply must not ask V for money while answering V's own request.
    if (!move && typed && !screen?.about && !this.initiative.has(input.profileKey)) {
      move = decideInitiative({...context, random: this.random});
      if (move) { this.initiative.add(input.profileKey); trace = (trace ? trace + '+' : '') + `initiative:${move.flow}`; }
    }
    if (move) parts.push(move.say);
    // Nothing about money this turn and nothing between them: no note at all (ordinary talk pays nothing).
    if (!move && !screen?.about && typed && !ledger) return null;
    if (!move && typed && !screen?.about) parts.splice(1, 1);   // only the ledger: the means line is for turns about money
    parts.push(RULE);
    const proposal = move?.flow && whole(move.amount, 1, EDDIES_CAP) ? this.#proposal(input, move) : null;
    this.log(`profile=${input.profileKey} own=${block.copy} trust=${trust} ${trace ?? 'ledger'}${proposal ? ` propose=${proposal.flow}:${proposal.amount}` : ''}`);
    return {note: parts.filter(Boolean).join(' '), proposal, trace: trace ?? 'ledger', spoken: !typed, context};
  }

  #proposal(input, move) {
    return {version: 1, id: 'ed-' + Math.floor(this.random() * 1e12).toString(36) + Date.now().toString(36), requestId: input.requestId, entity: input.entity,
      profileKey: input.profileKey, name: typeof input.name === 'string' ? input.name.slice(0, 80) : '', flow: move.flow, amount: move.amount, origin: move.origin};
  }

  /**
   * The proposal to publish once the reply is out, or null. A spoken turn's words (the transcript, `userText`) are screened now: what V asked decides,
   * over the character's own initiative.
   */
  finish(input, userText) {
    const key = this.#key(input);
    const decision = key ? this.turns.get(key) : null;
    if (!decision?.context) return decision?.proposal ?? null;
    if (decision.spoken && typedWords(userText)) {
      const screen = screenWords(userText);
      if (screen.intent) {
        const move = decideWords(screen, decision.context);
        this.log(`profile=${input.profileKey} heard=${screen.intent}${screen.amount ? ':' + screen.amount : ''}${move?.flow ? ` propose=${move.flow}:${move.amount}` : ''}`);
        if (move?.flow && whole(move.amount, 1, EDDIES_CAP)) return this.#proposal(input, move);
        return null;
      }
    }
    return decision.proposal;
  }
}

/** A provider's romance reading of a turn's relationship selection (bridge/relationship-routing.mjs): 'partner', 'casual' or null. */
export function romanceOf(selection, profiles) {
  if (selection?.status !== 'ready' || !profiles || !Object.hasOwn(profiles, selection.profileKey)) return null;
  const rule = profiles[selection.profileKey], confirmed = selection.saveRelationship?.status === 'confirmed';
  if (rule.kind === 'casual-intimacy') return confirmed ? 'casual' : null;
  return selection.style === 'romantic' || confirmed ? 'partner' : null;
}
