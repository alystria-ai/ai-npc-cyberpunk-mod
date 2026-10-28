import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import {EDDIES_CAP, FLOWS, parseEddies, financeOf, debts, purse, roundDown, trustOf, lendLimit, parseAmount, screenWords, ledgerLine, decideWords,
  decideInitiative, EddiesDecisions, romanceOf} from './eddies.mjs';
import {FINANCES} from './eddies-finances.mjs';
import {warmLanguagesNow} from './eddies-languages.mjs';
warmLanguagesNow();   // the bridge warms the grammars in the background; a test reads at once
import {moneyNote, MONEY_NOTE} from './turn-context.mjs';
import {parseInput} from './protocol.mjs';
import {RELATIONSHIP_PROFILES} from './relationship-routing.mjs';

// Eddies with characters (docs/EDDIES.md), the bridge half: the money data, the screen of V's words, the decisions, the notes and the proposal.
// The game half (the ledger, the pop-up, the transfer) is bridge/eddies-lua.test.mjs.
const NOW = 1_800_000_000, DAY = 86400;
const row = (extra = {}) => ({seed: 500, met: NOW - 10 * DAY, flow: 0, flowAt: 0, asked: 0, recent: [],
  totals: Object.fromEntries(FLOWS.map(flow => [flow, 0])), ...extra});
const block = (extra = {}) => ({version: 1, on: true, own: true, copy: 'party', balance: 5000, now: NOW, ...extra});
const turn = (text, extra = {}, profileKey = 'judy-alvarez') => ({requestId: 'r-' + Math.random().toString(36).slice(2), entity: '123', profileKey, name: 'Judy', text,
  eddies: parseEddies(block(extra), profileKey)});

test('every roster character and every ordinary NPC group has money data, each row well formed', () => {
  const profiles = readdirSync(new URL('../characters/profile-text/', import.meta.url)).map(file => file.replace(/\.[^.]+$/, ''));
  assert.ok(profiles.length > 100);
  for (const key of profiles) assert.ok(financeOf(key), key);
  const archetypes = JSON.parse(readFileSync(new URL('../characters/archetypes.json', import.meta.url), 'utf8'));
  for (const base of new Set(archetypes.archetypes.map(entry => entry.base))) assert.ok(financeOf(`npc-${base}-male`) && financeOf(`npc-${base}-female`), base);
  for (const [key, value] of Object.entries(FINANCES)) {
    assert.ok(['broke', 'tight', 'modest', 'comfortable', 'wealthy', 'rich'].includes(value.tier), key);
    assert.ok(Number.isSafeInteger(value.cash) && value.cash >= 0, key);
    assert.ok(value.generosity >= 0 && value.generosity <= 1, key);
    assert.ok(['never', 'rarely', 'sometimes'].includes(value.asks), key);
    assert.ok(['always', 'usually', 'late', 'rarely'].includes(value.repays), key);
    assert.ok(typeof value.style === 'string' && value.style.length > 20 && value.style.length < 260 && !value.style.includes(';'), key);
    assert.ok(Array.isArray(value.needs) && (value.asks === 'never' || value.needs.length > 0), key);
  }
  // Lore: an engram and a character with no body have no wallet; Hanako is far richer than Jackie.
  assert.equal(financeOf('johnny-silverhand').cash, 0);
  assert.equal(financeOf('alt-cunningham').cash, 0);
  assert.ok(financeOf('hanako-arasaka').cash > 100 * financeOf('jackie-welles').cash);
  assert.equal(financeOf('not-a-character'), null);
});

test('the game block: only a well-formed block counts, the balance only for one of V\'s own copies, decides only for a named character', () => {
  assert.equal(parseEddies(null, 'judy-alvarez'), null);
  assert.equal(parseEddies({version: 2, on: true, now: NOW}, 'judy-alvarez'), null);
  assert.equal(parseEddies({version: 1, on: false, now: NOW}, 'judy-alvarez'), null);
  const own = parseEddies(block(), 'judy-alvarez');
  assert.deepEqual([own.own, own.copy, own.balance, own.decides], [true, 'party', 5000, true]);
  const placed = parseEddies(block({own: false, copy: undefined, balance: undefined}), 'judy-alvarez');
  assert.deepEqual([placed.own, placed.balance, placed.decides], [false, undefined, true]);
  // A copy kind the game does not have, or a balance that is not a whole number: not an own copy.
  assert.equal(parseEddies(block({copy: 'stranger'}), 'judy-alvarez').own, false);
  assert.equal(parseEddies(block({balance: 12.5}), 'judy-alvarez').own, false);
  assert.equal(parseEddies(block(), 'npc-tyger-claws-male').decides, false);
  assert.equal(parseEddies(block(), 'my-own-character').decides, false);
});

test('the protocol keeps the block on a private turn only', () => {
  const base = {requestId: '1-1-42ULL', generation: 1, entity: '42ULL', name: 'Judy', bodyType: 'x', profileKey: 'judy-alvarez', text: 'lend me 50 eddies', eddies: block()};
  const parsed = parseInput(JSON.stringify(base));
  assert.equal(parsed?.eddies?.own, true, 'a private turn keeps it');
  const call = parseInput(JSON.stringify({...base, holocall: {version: 1, contact: 'judy-alvarez', mode: 'audio'}}));
  assert.ok(call?.holocall && call.eddies === undefined, 'a holocall never carries it');
  assert.equal(parseInput(JSON.stringify({...base, eddies: {version: 9}}))?.eddies, undefined, 'a malformed block is dropped, the turn stands');
});

test('the words-only money note stays out of a named character\'s turn while the eddies note decides', () => {
  assert.equal(moneyNote({text: 'I gave you 500 eddies'}), MONEY_NOTE);
  assert.equal(moneyNote({text: 'I gave you 500 eddies', eddies: parseEddies(block(), 'judy-alvarez')}), '');
  // An ordinary NPC keeps it (V pays, words only).
  assert.equal(moneyNote({text: 'here are 50 eddies', eddies: parseEddies(block(), 'npc-street-resident-female')}), MONEY_NOTE);
});

test('amounts: digits, thousands, k and grand, worded sums; never a fraction or a sum with no money in it', () => {
  const cases = {'500 eddies': 500, '1,000 eddies': 1000, '1.000 eddies': 1000, '5k': 5000, '2.5k eddies': 2500, '2 grand': 2000, '€$300': 300, '300€$': 300,
    'five hundred eddies': 500, 'a grand': 1000, 'twenty eddies': 20, 'a hundred eddies': 100};
  for (const [text, value] of Object.entries(cases)) assert.equal(parseAmount(text), value, text);
  for (const text of ['0.5 eddies', 'a few eddies', 'five minutes', 'some eddies', 'eddies']) assert.equal(parseAmount(text), null, text);
});

test('the screen reads what V means, and refuses negations, conditions, the past and the future', () => {
  const reads = {
    'can you lend me 500 eddies?': ['borrow', 500], 'Lend me a grand, choom': ['borrow', 1000], 'I need 2k for a ripperdoc': ['borrow', 2000],
    'Spot me 200?': ['borrow', 200], "can't you lend me 50 eddies?": ['borrow', 50], 'could you spare 50 eddies': ['borrow', 50],
    'Wanna lend me some cash?': ['borrow', null], 'let me borrow five hundred eddies': ['borrow', 500], 'can you lend me 1,000 eddies?': ['borrow', 1000],
    "I'll lend you 1000 eddies": ['lend', 1000], 'I can lend you some eddies': ['lend', null], 'Do you want to borrow some money?': ['lend', null],
    'do you need money?': ['lend', null], 'here, take 300 eddies': ['give', 300], "Thanks for the help, here's 200 eddies": ['give', 200],
    'Take this, 1,000 eddies': ['give', 1000], "I'm paying you 300 eddies for the ride": ['give', 300], 'I will give you 100 eddies': ['give', 100],
    "Here's the 500 I owe you": ['repay', 500], 'Thanks, choom, I owe you 300 eddies': ['repay', 300],
    'pay me back': ['reclaim', null], 'you owe me 200 eddies': ['reclaim', 200], 'pay me back the 300': ['reclaim', 300],
  };
  for (const [text, [intent, amount]] of Object.entries(reads)) {
    const screen = screenWords(text);
    assert.equal(screen.intent, intent, text);
    assert.equal(screen.amount, amount, text);
  }
  const nothing = ["I won't lend you anything", 'if I lent you 500 would you pay me back', "I'll pay you back tomorrow", 'I paid you yesterday',
    "here's the thing about money", 'I owe you one', 'you owe me an explanation', 'Lend me a hand', 'can I borrow your car?', 'give me 5 minutes',
    'what do you think about money?', 'hey, how are you?', "I'm broke"];
  for (const text of nothing) assert.equal(screenWords(text).intent, null, text);
  assert.equal(screenWords('hey, how are you?').about, false);
  assert.equal(screenWords('what do you think about money?').about, true);
  // Other languages are read by bridge/eddies-languages.mjs (per-language sets: eddies-languages.test.mjs): about money, and the same decisions.
  for (const text of ['Kannst du mir 500 Eddies leihen?', 'Tu peux me prêter de l\'argent ?', 'Можешь одолжить мне денег?', 'お金を貸してくれる？']) {
    assert.equal(screenWords(text).about, true, text);
  }
  const foreign = {'Kannst du mir 500 Eddies leihen?': ['borrow', 500], 'Prestame doscientos eddies, hermano': ['borrow', 200], 'Tiens, 300 eddies pour la course': ['give', 300],
    'Ecco i 500 eddies che ti dovevo': ['repay', 500], 'Ты мне должен 200 эдди': ['reclaim', 200], '500エディ貸してくれない？': ['borrow', 500], '借我两百块': ['borrow', 200],
    '내가 천 에디 빌려줄게': ['lend', 1000]};
  for (const [text, [intent, amount]] of Object.entries(foreign)) {
    const screen = screenWords(text);
    assert.deepEqual([screen.intent, screen.amount], [intent, amount], text);
  }
  for (const text of ['Ich leihe dir nichts', 'Si te presto 500 eddies, ¿me pagas?', 'Je te rembourserai demain', 'Mi devi una spiegazione, non soldi.', '金を貸すつもりはない']) {
    assert.equal(screenWords(text).intent, null, text);
  }
});

test('means: the data\'s cash varied by the seed, plus what V gave and minus what the character paid out, fading back', () => {
  const finance = financeOf('judy-alvarez');
  assert.equal(purse(finance, row({seed: 500}), NOW), finance.cash);
  assert.ok(purse(finance, row({seed: 0}), NOW) < finance.cash && purse(finance, row({seed: 999}), NOW) > finance.cash);
  assert.equal(purse(finance, row({flow: 1000, flowAt: NOW}), NOW), finance.cash + 1000);
  assert.equal(purse(finance, row({flow: 1000, flowAt: NOW - 7 * DAY}), NOW), finance.cash + 500);
  assert.equal(purse(financeOf('johnny-silverhand'), row(), NOW), 0);
  assert.equal(roundDown(1349), 1300);
  assert.equal(roundDown(87), 80);
  assert.equal(roundDown(23456), 23000);
});

test('trust follows how V stands with the character in the game and with money', () => {
  const plain = trustOf({});
  assert.ok(trustOf({copy: 'housemate'}) > trustOf({copy: 'party'}) && trustOf({copy: 'party'}) > trustOf({copy: 'visitor'}) && trustOf({copy: 'visitor'}) > plain);
  assert.ok(trustOf({copy: 'party', romance: 'partner'}) > trustOf({copy: 'party', romance: 'casual'}));
  assert.ok(trustOf({copy: 'party', familiarity: 30}) > trustOf({copy: 'party'}));
  const owes = row({totals: {...row().totals, loanToV: 1000}});
  assert.ok(trustOf({copy: 'party', row: owes}) < trustOf({copy: 'party'}));
  const repaid = row({totals: {...row().totals, loanToV: 1000, repayByV: 1000}});
  assert.ok(trustOf({copy: 'party', row: repaid}) > trustOf({copy: 'party'}));
  // The romance reading of a turn's relationship selection.
  assert.equal(romanceOf({status: 'ready', profileKey: 'judy-alvarez', style: 'romantic'}, RELATIONSHIP_PROFILES), 'partner');
  assert.equal(romanceOf({status: 'ready', profileKey: 'meredith-stout', style: 'ordinary', saveRelationship: {status: 'confirmed'}}, RELATIONSHIP_PROFILES), 'casual');
  assert.equal(romanceOf({status: 'ready', profileKey: 'jackie-welles', style: 'ordinary'}, RELATIONSHIP_PROFILES), null);
  assert.equal(romanceOf(null, RELATIONSHIP_PROFILES), null);
});

test('a loan to V: within the limit it is a yes, above it a smaller offer, and no wallet, a debt or no trust is a no', () => {
  const judy = {finance: financeOf('judy-alvarez'), row: row(), now: NOW, balance: 5000, trust: trustOf({copy: 'party'})};
  const yes = decideWords(screenWords('lend me 200 eddies'), judy);
  assert.deepEqual([yes.flow, yes.amount, yes.origin], ['loanToV', 200, 'offered']);
  const less = decideWords(screenWords('lend me 5000 eddies'), judy);
  assert.equal(less.flow, 'loanToV');
  assert.ok(less.amount < 5000 && less.amount === lendLimit(judy.finance, judy.row, NOW, judy.trust).cap);
  assert.match(less.say, /more than you can spare/);
  assert.equal(decideWords(screenWords('lend me 90000 eddies'), judy).flow, undefined);
  const johnny = decideWords(screenWords('lend me 50 eddies'), {...judy, finance: financeOf('johnny-silverhand')});
  assert.equal(johnny.flow, undefined);
  assert.match(johnny.say, /no money of your own/);
  const debtor = decideWords(screenWords('lend me 50 eddies'), {...judy, row: row({totals: {...row().totals, loanToV: 2000}})});
  assert.equal(debtor.flow, undefined);
  assert.match(debtor.say, /V still owes you 2,000 eddies/);
  // No sum named: a modest one the character picks.
  const some = decideWords(screenWords('can you lend me some cash?'), judy);
  assert.equal(some.flow, 'loanToV');
  assert.ok(some.amount >= 100 && some.amount <= lendLimit(judy.finance, judy.row, NOW, judy.trust).cap);
});

test('V gives, lends and pays back only what V has; the character pays back only what they owe', () => {
  const judy = {finance: financeOf('judy-alvarez'), row: row(), now: NOW, balance: 500, trust: 0.5};
  assert.deepEqual(['giftFromV', 300], (({flow, amount}) => [flow, amount])(decideWords(screenWords('here, take 300 eddies'), judy)));
  assert.deepEqual(['loanFromV', 400], (({flow, amount}) => [flow, amount])(decideWords(screenWords('I can lend you 400 eddies'), judy)));
  assert.equal(decideWords(screenWords('here, take 3000 eddies'), judy).flow, undefined, 'more than V has');
  assert.equal(decideWords(screenWords('I can lend you some eddies'), judy).flow, undefined, 'no sum named');
  // A rich character who never needs money turns a gift down.
  assert.equal(decideWords(screenWords('here, take 300 eddies'), {...judy, finance: financeOf('hanako-arasaka')}).flow, undefined);
  // Paying back: only up to the debt.
  assert.equal(decideWords(screenWords("here's the 500 I owe you"), judy).flow, undefined, 'V owes nothing');
  const owing = {...judy, row: row({totals: {...row().totals, loanToV: 300}})};
  assert.deepEqual(['repayByV', 300], (({flow, amount}) => [flow, amount])(decideWords(screenWords("here's the 500 I owe you"), owing)));
  // Asking for one's money back: the character pays what they can.
  const owed = {...judy, row: row({totals: {...row().totals, loanFromV: 400}})};
  const back = decideWords(screenWords('pay me back'), owed);
  assert.deepEqual([back.flow, back.amount], ['repayToV', 400]);
  assert.equal(decideWords(screenWords('pay me back'), judy).flow, undefined, 'the character owes V nothing');
});

test('the character\'s own move: pays back when they can, asks for a loan rarely, with a cooldown, never while V owes them', () => {
  const finance = financeOf('jackie-welles'), trust = 0.7;
  const ask = decideInitiative({finance, row: row(), now: NOW, balance: 10000, trust, random: () => 0});
  assert.deepEqual([ask.flow, ask.origin], ['loanFromV', 'asked']);
  assert.ok(finance.needs.some(need => ask.say.includes(need)));
  assert.equal(decideInitiative({finance, row: row(), now: NOW, balance: 10000, trust, random: () => 0.99}), null, 'the dice said no');
  assert.equal(decideInitiative({finance, row: row({asked: NOW - DAY}), now: NOW, balance: 10000, trust, random: () => 0}), null, 'asked a day ago');
  assert.equal(decideInitiative({finance, row: row(), now: NOW, balance: 10000, trust: 0.3, random: () => 0}), null, 'not trusted enough');
  assert.equal(decideInitiative({finance, row: row({totals: {...row().totals, loanToV: 100}}), now: NOW, balance: 10000, trust, random: () => 0}), null, 'V owes them');
  assert.equal(decideInitiative({finance: financeOf('hanako-arasaka'), row: row(), now: NOW, balance: 10000, trust, random: () => 0}), null, 'never asks');
  const pays = decideInitiative({finance: financeOf('judy-alvarez'), row: row({totals: {...row().totals, loanFromV: 500}, last: {flow: 'loanFromV', amount: 500, result: 'done', at: NOW - 2 * DAY}}),
    now: NOW, balance: 10000, trust, random: () => 0});
  assert.deepEqual([pays.flow, pays.amount], ['repayToV', 500]);
});

test('the ledger line says what is owed and what last happened', () => {
  assert.equal(ledgerLine(null, NOW), '');
  assert.equal(ledgerLine(row(), NOW), '');
  const line = ledgerLine(row({totals: {...row().totals, loanToV: 1000, repayByV: 400}, last: {flow: 'repayByV', amount: 400, result: 'done', at: NOW - 2 * DAY}}), NOW);
  assert.match(line, /V owes you 600 eddies\./);
  assert.match(line, /V paid you back 400 eddies \(2 days ago\)/);
  assert.match(ledgerLine(row({last: {flow: 'giftFromV', amount: 50, result: 'declined', at: NOW}}), NOW), /Nothing is owed between you and V\. .*changed their mind/);
});

test('one decision per turn: ordinary talk pays nothing, a turn about money gets one note and at most one proposal', () => {
  const decisions = new EddiesDecisions({random: () => 0.99});
  assert.equal(decisions.forTurn(turn('hey, how are you?')), null, 'ordinary talk: no note');
  const borrow = turn('can you lend me 300 eddies?');
  const decided = decisions.forTurn(borrow);
  assert.match(decided.note, /^Eddies \(game-verified, this turn\):/);
  assert.match(decided.note, /You agree to lend V 300 eddies/);
  assert.match(decided.note, /never say money moved when you refused/);
  assert.deepEqual([decided.proposal.flow, decided.proposal.amount, decided.proposal.requestId, decided.proposal.profileKey], ['loanToV', 300, borrow.requestId, 'judy-alvarez']);
  // The same turn again (or as another object with the same request id): the same decision.
  assert.equal(decisions.forTurn({...borrow}), decided);
  assert.equal(decisions.finish(borrow, 'whatever the transcript says'), decided.proposal, 'a typed turn keeps its decision');
  // A turn with a debt open carries the ledger even when it is not about money, without the means line.
  const owing = turn('hey', {row: row({totals: {...row().totals, loanToV: 300}})});
  const reminded = decisions.forTurn(owing);
  assert.match(reminded.note, /V owes you 300 eddies/);
  assert.doesNotMatch(reminded.note, /Your money:/);
  assert.equal(reminded.proposal, null);
});

test('a spoken turn: a short standing note now, V\'s words decide when the transcript arrives', () => {
  const decisions = new EddiesDecisions({random: () => 0});
  const spoken = turn('[Microphone]');
  const decided = decisions.forTurn(spoken);
  assert.match(decided.note, /If V asks to borrow eddies: the most you would lend V right now is/);
  assert.doesNotMatch(decided.note, /Your money:/, 'no means line on every spoken turn');
  assert.match(decided.note, /Eddies change hands the moment you agree in your reply, so agree only to what you really mean to do, and never say money moved when you refused/);
  assert.doesNotMatch(decided.note, /pop-up|confirm/i, 'no pop-up: the money moves when the character agrees');
  assert.equal(decided.proposal, null, 'no initiative on a spoken turn, even when the dice say so');
  const proposal = decisions.finish(spoken, 'could you lend me 200 eddies?');
  assert.deepEqual([proposal.flow, proposal.amount], ['loanToV', 200]);
  assert.equal(decisions.finish(turn('[Microphone]'), 'nice weather'), null, 'not about money: nothing');
});

test('a character the game placed only talks about money, and an ordinary NPC keeps its group\'s way with it', () => {
  const decisions = new EddiesDecisions({random: () => 0});
  const placed = decisions.forTurn(turn('can you lend me 300 eddies?', {own: false, copy: undefined, balance: undefined}));
  assert.match(placed.note, /No eddies can change hands in this conversation/);
  assert.equal(placed.proposal, null);
  assert.equal(decisions.forTurn(turn('hey', {own: false, copy: undefined, balance: undefined})), null);
  const npc = decisions.forTurn(turn('lend me 20 eddies', {}, 'npc-street-resident-male'));
  assert.match(npc.note, /^How you handle money:/);
  assert.equal(npc.proposal, null);
  // Not for a reaction, a group round or a character with no money data.
  assert.equal(decisions.forTurn({...turn('lend me 20 eddies'), reaction: {kind: 'battle'}}), null);
  assert.equal(decisions.forTurn({...turn('lend me 20 eddies'), group: {members: []}}), null);
  assert.equal(decisions.forTurn(turn('lend me 20 eddies', {}, 'my-own-character')), null);
});

test('the character asks for a loan once per session at most, and V\'s money talk always comes first', () => {
  const decisions = new EddiesDecisions({random: () => 0});
  const first = decisions.forTurn(turn('nice day', {row: row()}, 'jackie-welles'));
  assert.equal(first.proposal.flow, 'loanFromV');
  assert.equal(first.proposal.origin, 'asked');
  assert.equal(decisions.forTurn(turn('nice day', {row: row()}, 'jackie-welles')), null, 'once per session');
  const busy = new EddiesDecisions({random: () => 0});
  assert.equal(busy.forTurn(turn('what do you think about money?', {row: row()}, 'jackie-welles')).proposal, null, 'V talks of money: the standing note, no ask');
});

test('every proposal stays within the cap and the six flows, whatever V says', () => {
  const decisions = new EddiesDecisions({random: () => 0.5});
  for (const text of ['lend me 999999 eddies', 'here, take 500000 eddies', 'I can lend you 250000 eddies', 'lend me 100000 eddies']) {
    const decided = decisions.forTurn(turn(text, {balance: 10_000_000}, 'hanako-arasaka'));
    const proposal = decided?.proposal;
    if (proposal) assert.ok(FLOWS.includes(proposal.flow) && proposal.amount >= 1 && proposal.amount <= EDDIES_CAP, text);
  }
});
