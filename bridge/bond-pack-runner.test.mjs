// Story packs running (docs/RELATIONSHIPS_AND_QUESTS.md 7.3, bridge/bond-pack-runner.mjs and bridge/bond-intent.mjs): the start and its gate, the note, V's words as
// choices, the Eddies story link, meetings, timers, endings, the rollback guard, the effects for the game, unknown stage types, and the cost of a turn. Offline.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BondPacks, ROLLBACK_SLACK} from './bond-pack-runner.mjs';
import {screenIntent, intentKind} from './bond-intent.mjs';
import {shippedPacks, validatePack} from './bond-packs.mjs';
import {Bonds, BondStore, parseBonds} from './bonds.mjs';
import {EddiesDecisions, parseEddies} from './eddies.mjs';
import {parseJournalHistory} from './journal-history.mjs';

const DAY = 86400, HOUR = 3600;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const roster = new Set(JSON.parse(read('../characters/roster.json')).map(row => row.key));
const packs = Object.fromEntries(shippedPacks().map(({pack}) => [pack.id, pack]));
// These tests are about the four example packs, so the dice have no other pack of the same character to pick (the quest and hangout packs ship beside them).
const EXAMPLES = ['judy-dinner-dress', 'kerry-new-song', 'panam-sunset-coffee', 'panam-truck-ransom'].map(id => packs[id]);

function journal(rows) {
  const coverage = {status: 'complete', ageSeconds: 1, windowSeconds: 30, observed: rows.length, omitted: 0, unstable: false};
  return parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, worldToken: 'w1', tracked: {status: 'untracked'},
    coverage: {active: coverage, history: coverage},
    quests: rows.map(([path, state], index) => ({id: String(100 + index), nativeId: path.slice(path.lastIndexOf('/') + 1), nativePath: path, title: 'Quest ' + index,
      state, lane: state === 'active' ? 'active' : 'history', observedAtMs: 1000, objectivesComplete: state !== 'active', objectives: []}))});
}
const PANAM_DONE = [['quests/side_quest/sq027_02_raffen_shiv_attack', 'failed']];
const JUDY_DONE = [['quests/side_quest/sq026_04_hiromi', 'succeeded'], ['quests/side_quest/sq030_judy_romance', 'succeeded']];

let counter = 0;
const turn = (profileKey, gameSeconds, extra = {}, bondsBlock = {}) => ({requestId: `r-${++counter}`, profileKey, name: profileKey, text: 'hey', entity: 'e1',
  turnContext: {gameTime: gameSeconds}, bonds: {on: true, copy: 'party', packs: true, eddies: true, invitations: true, ...bondsBlock}, ...extra});
const make = (options = {}) => {
  const lines = [], written = [];
  const runner = new BondPacks({packs: EXAMPLES, characters: roster, random: () => 0, log: line => lines.push(line), write: async (file, text) => { written.push([file, JSON.parse(text)]); },
    path: 'packs.json', effectsPath: 'effects.json', debounceMs: 0, ...options});
  return {runner, lines, written};
};
const noteOf = (runner, input, facts = {level: 6}) => runner.forTurn(input, facts)?.note ?? '';

test('V\'s words as answers: yes, no, an opinion, a compliment, in several languages; a recording placeholder or nothing is no answer', () => {
  assert.equal(intentKind('sure, I\'ll come over', ['yes', 'no']), 'yes');
  assert.equal(intentKind('no way, handle it yourself', ['yes', 'no']), 'no');
  assert.equal(intentKind('sure, but I can\'t tonight', ['yes', 'no']), 'no', 'a refusal anywhere is a refusal');
  assert.equal(intentKind('You look great', ['honest', 'flatter']), 'flatter');
  assert.equal(intentKind('It is a bit much honestly, the colour washes you out', ['honest', 'flatter']), 'honest');
  assert.equal(intentKind('ja klar, ich komme', ['yes', 'no']), 'yes');
  assert.equal(intentKind('nein danke', ['yes', 'no']), 'no');
  assert.equal(intentKind('我来', ['yes', 'no']), 'yes');
  assert.equal(intentKind('不行', ['yes', 'no']), 'no');
  assert.equal(intentKind('hmm', ['yes', 'no']), null);
  assert.equal(intentKind('[Microphone]', ['yes', 'no']), null);
  assert.equal(intentKind('', ['yes', 'no']), null);
  assert.deepEqual(screenIntent(undefined), {yes: false, no: false, honest: false, flatter: false});
  assert.equal(intentKind('yes', ['honest', 'flatter']), 'flatter', 'a bare yes to an opinion question is only polite');
});

test('every tag choice of the shipped packs names a kind; a stage may not offer one kind twice; stage types and pictures are open data', () => {
  for (const pack of Object.values(packs)) {
    assert.deepEqual(validatePack(pack, {characters: roster}).errors, [], pack.id);
    for (const stage of pack.stages) assert(stage.label, `${pack.id} ${stage.id}: a label for the Relationships page`);
  }
  const bad = structuredClone(packs['panam-truck-ransom']);
  bad.stages[0].choices[2].kind = 'yes';
  assert(validatePack(bad, {characters: roster}).errors.some(error => /two choices have the kind yes/.test(error)));
  const open = structuredClone(packs['judy-dinner-dress']);
  open.stages[3].type = 'escort'; open.stages[3].params = {to: 'Afterlife'};
  open.stages[3].image = {file: 'images/judy-dress.png', alt: 'a photo of the dress'};
  const checked = validatePack(open, {characters: roster});
  assert.deepEqual(checked.errors, []);
  assert(checked.warnings.some(warning => /type escort is not played yet/.test(warning)));
  open.stages[3].image = {file: '../secret.png'};
  assert(validatePack(open, {characters: roster}).errors.some(error => /image needs file/.test(error)));
});

test('a pack starts on a private turn of V\'s only when the gate is open, the dice say so, once a game day; the note brings it up', async () => {
  const {runner} = make();
  const t0 = 30 * DAY;
  const base = {journalHistory: journal(PANAM_DONE)};
  // The game's own character, a reaction, a closed gate (bond, busy, Eddies off, a quest of hers active, an unknown journal) start nothing.
  assert.equal(noteOf(runner, turn('panam-palmer', t0, base, {copy: null, packs: undefined}), {level: 6}), '');
  assert.equal(noteOf(runner, turn('panam-palmer', t0, {...base, holocall: undefined, channel: undefined}), {level: 4}), '', 'bond 4 is under the 5 she needs');
  const busy = turn('panam-palmer', t0, base, {busy: true});
  assert.equal(noteOf(runner, busy), '');
  const noEddies = turn('panam-palmer', t0, base, {eddies: undefined});
  assert.equal(noteOf(runner, noEddies), '');
  const active = turn('panam-palmer', t0, {journalHistory: journal([...PANAM_DONE, ['quests/side_quest/sq027_01_basilisk_convoy', 'active']])});
  assert.equal(noteOf(runner, active), '');
  assert.equal(noteOf(runner, turn('panam-palmer', t0, {journalHistory: journal([])})), '', 'her quest is not finished in the journal');
  // Open: the dice (0) pass.
  const open = turn('panam-palmer', t0, base);
  const decision = runner.forTurn(open, {level: 6});
  assert.match(decision.note, /your truck was stolen/);
  assert.match(decision.note, /scav crew took your Mackinaw/);
  assert.equal(runner.forTurn(open, {level: 6}), decision, 'the same turn gets the same decision');
  assert.equal(runner.entries.size, 0, 'nothing is started until the reply is published');
  runner.afterTurn(open, 'hey Panam');
  assert.equal(runner.entries.get('panam-truck-ransom').status, 'active');
  // One active pack per character: the next turn is the stage, not another start.
  assert.match(noteOf(runner, turn('panam-palmer', t0 + 60, base)), /scav crew took your Mackinaw/);
});

test('the dice: the first eligible turn of a game day rolls, a lost roll waits for 2 more eligible turns, 5 rolls a day at most; Phone Chat and a holocall start it, a game-placed character does not', () => {
  let roll = 0.9, rolls = 0;
  const {runner} = make({random: () => { rolls++; return roll; }});
  const base = {journalHistory: journal(JUDY_DONE)};
  const phone = (at, extra = {}) => turn('judy-alvarez', at, {...base, channel: 'phone', id: `p-${at}`, requestId: undefined, ...extra}, {copy: null});
  const say = at => noteOf(runner, phone(at), {level: 6});
  assert.equal(say(10 * DAY), '', 'the dice said no');
  assert.equal(rolls, 1);
  // One lost roll no longer silences the day: the next rolls come after 2 more eligible turns (not on the turn between).
  assert.equal(say(10 * DAY + 100), '');
  assert.equal(rolls, 1, 'one turn later: still the first roll');
  assert.equal(say(10 * DAY + 200), ''); assert.equal(rolls, 2, 'the second eligible turn after a roll rolls again');
  for (let i = 1; i <= 6; i++) say(10 * DAY + 400 + i);
  assert.equal(rolls, 5, 'the fifth roll of the day');
  for (let i = 1; i <= 12; i++) say(10 * DAY + 500 + i);
  assert.equal(rolls, 5, 'never more than 5 rolls a game day, however long the talk');
  roll = 0;
  assert.equal(say(10 * DAY + 900), '', 'the rolls of the day are used, even with the dice for it');
  const next = phone(11 * DAY);
  assert.match(noteOf(runner, next, {level: 6}), /dinner party coming up/, 'the first eligible turn of the next day rolls at once');
  runner.afterTurn(next, 'hi');
  assert.equal(runner.entries.get('judy-dinner-dress').status, 'active');
  const call = make().runner;
  assert.match(noteOf(call, turn('judy-alvarez', 12 * DAY, {...base, holocall: {contact: 'judy-alvarez'}}, {copy: null}), {level: 6}), /dress/);
  // A game-placed Judy (no own copy, no phone, no call): talk only.
  assert.equal(noteOf(make().runner, turn('judy-alvarez', 12 * DAY, base, {copy: null}), {level: 6}), '');
  // A phone message the character starts (an event) never starts a pack.
  assert.equal(noteOf(make().runner, turn('judy-alvarez', 12 * DAY, {...base, channel: 'phone', event: {kind: 'arrived'}}, {copy: null}), {level: 6}), '');
});

test('a fair chance: at 0.5 a long talk with the gate open invites within a few turns, and the rolls and the spacing are saved with the save', () => {
  const rolls = [0.9, 0.9, 0.2];
  const {runner} = make({random: () => rolls.shift() ?? 0.9});
  const base = {journalHistory: journal(JUDY_DONE)};
  const phone = at => turn('judy-alvarez', at, {...base, channel: 'phone', id: `q-${at}`, requestId: undefined}, {copy: null});
  let started = null;
  for (let i = 0; i < 12 && !started; i++) started = runner.forTurn(phone(20 * DAY + i * 60), {level: 6}).pack?.id ?? null;
  assert.equal(started, 'judy-dinner-dress', 'the third roll (turn 5) was the lucky one: the talk is not lost to one bad roll');
  const meta = runner.meta.get('judy-alvarez');
  assert.deepEqual([meta.rolled, meta.rolls], [20, 3]);
});

test('Panam: the ask carries the Eddies story; V\'s loan moves her to repay, the repayments end it, the bond is rewarded, the ending is remembered for 3 days', async () => {
  const awards = [];
  const {runner} = make({bonds: {award: (...args) => { awards.push(args); return true; }, publish() {}}});
  const t0 = 40 * DAY, base = {journalHistory: journal(PANAM_DONE)};
  const start = turn('panam-palmer', t0, base);
  runner.forTurn(start, {level: 6}); runner.afterTurn(start, 'hey');
  // The next in-person turn: the stage, the money facts for Eddies.
  const ask = turn('panam-palmer', t0 + HOUR, {...base, text: 'what happened?'});
  const decision = runner.forTurn(ask, {level: 6});
  assert.deepEqual(decision.story, {tag: 'panam-truck-ransom:ask', ask: {flow: 'loanFromV', amount: 6000, reason: 'the ransom for your stolen truck'}});
  // Eddies: her note asks for 6,000; V's offer to lend 6,000 is proposed with the story tag; a smaller sum is not the story's.
  const eddies = new EddiesDecisions({random: () => 0.99});
  const block = parseEddies({version: 1, on: true, own: true, copy: 'party', balance: 20000, now: 1_800_000_000, row: {seed: 500, met: 1}}, 'panam-palmer');
  const offer = {...ask, requestId: 'o-1', text: 'I will lend you 6000 eddies', eddies: block};
  const decided = eddies.forTurn(offer, {romance: null, bondLevel: 6, story: runner.forTurn(offer, {level: 6}).story});
  assert.equal(decided.proposal.flow, 'loanFromV'); assert.equal(decided.proposal.amount, 6000);
  assert.equal(decided.proposal.story, 'panam-truck-ransom:ask');
  const small = {...ask, requestId: 'o-2', text: 'I will lend you 1000 eddies', eddies: block};
  assert.equal(eddies.forTurn(small, {story: runner.forTurn(small, {level: 6}).story}).proposal.story, undefined);
  // The note of a plain turn names the need.
  const plain = eddies.forTurn({...ask, requestId: 'o-3', text: 'how are you', eddies: block}, {story: decision.story});
  assert.match(plain.note, /You need 6,000 eddies for the ransom for your stolen truck/);
  runner.afterTurn(offer, 'I will lend you 6000 eddies', decided.proposal);
  assert.equal(runner.entries.get('panam-truck-ransom').trail.at(-1).stage, 'ask', 'a money turn waits for the ledger, not for words');
  // The next turn: the ledger row says it was done under this story.
  const done = {version: 1, on: true, own: true, copy: 'party', balance: 14000, now: 1_800_000_100,
    row: {seed: 500, met: 1, totals: {loanFromV: 6000}, last: {flow: 'loanFromV', amount: 6000, result: 'done', at: 1_800_000_050, story: 'panam-truck-ransom:ask'}}};
  const after = turn('panam-palmer', t0 + 2 * HOUR, {...base, eddies: parseEddies(done, 'panam-palmer')});
  const repay = runner.forTurn(after, {level: 6});
  assert.match(repay.note, /V lent you the 6,000/);
  assert.equal(repay.story.repay.due, true);
  const move = new EddiesDecisions({random: () => 0.99}).forTurn(after, {story: repay.story});
  assert.equal(move.proposal.flow, 'repayToV'); assert.equal(move.proposal.amount, 2000); assert.equal(move.proposal.story, 'panam-truck-ransom:repay');
  runner.afterTurn(after, 'hi', move.proposal);
  // Not due again the same day; due again a day later.
  assert.equal(runner.forTurn(turn('panam-palmer', t0 + 3 * HOUR, {...base, eddies: after.eddies}), {level: 6}).story.repay.due, false);
  assert.equal(runner.forTurn(turn('panam-palmer', t0 + 2 * HOUR + DAY, {...base, eddies: after.eddies}), {level: 6}).story.repay.due, true);
  // The debt is clear: the last repayment under this story ends the pack.
  const paid = parseEddies({...done, row: {seed: 500, met: 1, totals: {loanFromV: 6000, repayToV: 6000},
    last: {flow: 'repayToV', amount: 2000, result: 'done', at: 1_800_100_000, story: 'panam-truck-ransom:repay'}}}, 'panam-palmer');
  const finish = turn('panam-palmer', t0 + 3 * DAY, {...base, eddies: paid});
  const final = runner.forTurn(finish, {level: 6});
  assert.match(final.note, /you paid every eddie back/);
  assert.equal(runner.entries.get('panam-truck-ransom').status, 'done');
  assert.deepEqual(awards, [['panam-palmer', 60, t0 + 3 * DAY]]);
  // The ending is remembered for three game days, then gone; a new pack does not start inside the 7-day cooldown.
  assert.match(noteOf(runner, turn('panam-palmer', t0 + 5 * DAY, base)), /you paid every eddie back/);
  assert.equal(noteOf(runner, turn('panam-palmer', t0 + 7 * DAY, base)), '');
});

test('Panam: V offers to help, or refuses, in words; the stage is not answered on the turn that brought it up; the timer sends it to "alone"', () => {
  const t0 = 50 * DAY, base = {journalHistory: journal(PANAM_DONE)};
  const begin = runner => { const start = turn('panam-palmer', t0, base); runner.forTurn(start, {level: 6}); runner.afterTurn(start, 'I will go with you, sure'); };
  // The words on the very turn that started it answer nothing.
  const first = make().runner; begin(first);
  assert.equal(first.entries.get('panam-truck-ransom').trail.at(-1).stage, 'ask');
  const help = make().runner; begin(help);
  const turn2 = turn('panam-palmer', t0 + 600, base); help.forTurn(turn2, {level: 6}); help.afterTurn(turn2, 'let\'s go get your truck back');
  assert.equal(help.entries.get('panam-truck-ransom').trail.at(-1).stage, 'recover');
  assert.match(noteOf(help, turn('panam-palmer', t0 + 700, base)), /junkyard near Rocky Ridge/);
  const refuse = make().runner; begin(refuse);
  const turn3 = turn('panam-palmer', t0 + 600, base); refuse.forTurn(turn3, {level: 6}); refuse.afterTurn(turn3, 'no, sort it out yourself');
  assert.equal(refuse.entries.get('panam-truck-ransom').trail.at(-1).stage, 'alone', 'refusal');
  const silent = make().runner; begin(silent);
  const turn4 = turn('panam-palmer', t0 + 600, base); silent.forTurn(turn4, {level: 6}); silent.afterTurn(turn4, 'hmm');
  assert.equal(silent.entries.get('panam-truck-ransom').trail.at(-1).stage, 'ask');
  // 48 game hours later with no answer: the timer, checked when the next turn's context is built.
  const late = turn('panam-palmer', t0 + 49 * HOUR, base);
  silent.forTurn(late, {level: 6});
  assert.equal(silent.entries.get('panam-truck-ransom').trail.at(-1).stage, 'alone');
});

test('a closing beat is shown once, then the next turn ends the pack; the meeting outcome of an appointment moves a stage that waits on it', () => {
  const awards = [];
  const {runner} = make({bonds: {award: (...args) => { awards.push(args); }, publish() {}}});
  const t0 = 60 * DAY, base = {journalHistory: journal(JUDY_DONE)};
  const start = turn('judy-alvarez', t0, base); runner.forTurn(start, {level: 6}); runner.afterTurn(start, 'hi');
  // Meetings count only while Story packs is on (a turn said so).
  assert.equal(runner.noteMeeting('judy-alvarez', 'stood-up', t0 + HOUR), 'stood-up');
  assert.equal(runner.entries.get('judy-dinner-dress').trail.at(-1).stage, 'rain-check');
  const shown = turn('judy-alvarez', t0 + 2 * HOUR, base);
  assert.match(runner.forTurn(shown, {level: 6}).note, /You missed a hell of a night|could not make it to see the dress/);
  assert.equal(runner.entries.get('judy-dinner-dress').status, 'active', 'shown once first');
  runner.afterTurn(shown, 'sorry about that');
  runner.forTurn(turn('judy-alvarez', t0 + 3 * HOUR, base), {level: 6});
  assert.equal(runner.entries.get('judy-dinner-dress').status, 'done');
  assert.deepEqual(awards, [['judy-alvarez', -5, t0 + 3 * HOUR]]);
  assert.equal(runner.noteMeeting('judy-alvarez', 'met', t0 + 4 * HOUR), null, 'nothing waits on a meeting now');
  const off = make().runner;
  assert.equal(off.noteMeeting('judy-alvarez', 'met', 1), null, 'before any turn with Story packs on: nothing moves');
});

test('Judy: honest or flattering words choose the note, a stage that waits on a meeting ignores yes only when its choices differ', () => {
  const {runner} = make();
  const t0 = 70 * DAY, base = {journalHistory: journal(JUDY_DONE)};
  const start = turn('judy-alvarez', t0, base); runner.forTurn(start, {level: 6}); runner.afterTurn(start, 'hi');
  const yes = turn('judy-alvarez', t0 + 600, base); runner.forTurn(yes, {level: 6}); runner.afterTurn(yes, 'sure, I\'ll come by');
  assert.equal(runner.entries.get('judy-dinner-dress').trail.at(-1).stage, 'dress');
  const shown = turn('judy-alvarez', t0 + 1200, base); runner.forTurn(shown, {level: 6}); runner.afterTurn(shown, 'wow');
  const answer = turn('judy-alvarez', t0 + 1800, base); runner.forTurn(answer, {level: 6}); runner.afterTurn(answer, 'It suits you, but the sleeves are too long and the colour is a bit flat');
  assert.equal(runner.entries.get('judy-dinner-dress').trail.at(-1).stage, 'dinner');
  assert.equal(runner.entries.get('judy-dinner-dress').trail.at(-1).choice, 'honest');
});

test('pack state follows the save: a turn with an earlier clock rewinds the pack to where that clock had it, or forgets it', () => {
  const {runner} = make();
  const t0 = 80 * DAY, base = {journalHistory: journal(PANAM_DONE)};
  const start = turn('panam-palmer', t0, base); runner.forTurn(start, {level: 6}); runner.afterTurn(start, 'hi');
  const second = turn('panam-palmer', t0 + HOUR, base); runner.forTurn(second, {level: 6}); runner.afterTurn(second, 'let\'s go');
  assert.equal(runner.entries.get('panam-truck-ransom').trail.at(-1).stage, 'recover');
  // Loaded an earlier save: the clock is back between the start and the choice.
  runner.rewind(t0 + 600);
  assert.equal(runner.entries.get('panam-truck-ransom').trail.at(-1).stage, 'ask');
  assert.equal(runner.entries.get('panam-truck-ransom').status, 'active');
  // Within the slack nothing is undone.
  runner.rewind(t0 - ROLLBACK_SLACK + 1);
  assert(runner.entries.has('panam-truck-ransom'));
  // Before it began: forgotten, and the effects go with it.
  runner.rewind(t0 - 10 * DAY);
  assert.equal(runner.entries.size, 0);
  assert.deepEqual(runner.effects().blocked, []);
});

test('effects for the game: the personal car is blocked from the ask until it is returned, items once, an outfit for its stage; the file changes only when they do', async () => {
  const {runner, written} = make();
  const t0 = 90 * DAY, base = {journalHistory: journal(PANAM_DONE)};
  const start = turn('panam-palmer', t0, base); runner.forTurn(start, {level: 6}); runner.afterTurn(start, 'hi');
  assert.deepEqual(runner.effects().blocked, [{profileKey: 'panam-palmer', pack: 'panam-truck-ransom', since: t0}]);
  await runner.effectsChain;
  const first = written.filter(([file]) => file === 'effects.json');
  assert.equal(first.length, 1); assert.equal(first[0][1].revision, 1);
  const go = turn('panam-palmer', t0 + 600, base); runner.forTurn(go, {level: 6}); runner.afterTurn(go, 'no');   // alone: the truck is back
  assert.deepEqual(runner.effects().blocked, []);
  assert.equal(runner.effectsRevision, 2);
  // An item and an outfit from a pack of the test's own.
  const custom = structuredClone(packs['judy-dinner-dress']);
  custom.id = 'judy-test-gift';
  custom.stages[0].effects = [{kind: 'giveItem', record: 'Items.Preset_Test', quantity: 2}];
  const mine = make({packs: [custom]}).runner;
  const input = turn('judy-alvarez', t0, {journalHistory: journal(JUDY_DONE)});
  mine.forTurn(input, {level: 6}); mine.afterTurn(input, 'hi');
  assert.deepEqual(mine.effects().items, [{id: 'judy-test-gift:invite:0', kind: 'giveItem', profileKey: 'judy-alvarez', pack: 'judy-test-gift', record: 'Items.Preset_Test', quantity: 2, since: t0}]);
  const dress = make().runner;
  const s = turn('judy-alvarez', t0, {journalHistory: journal(JUDY_DONE)}); dress.forTurn(s, {level: 6}); dress.afterTurn(s, 'hi');
  const y = turn('judy-alvarez', t0 + 600, {journalHistory: journal(JUDY_DONE)}); dress.forTurn(y, {level: 6}); dress.afterTurn(y, 'yes, I\'ll come');
  assert.deepEqual(dress.effects().outfits, [{profileKey: 'judy-alvarez', pack: 'judy-dinner-dress', since: t0 + 600}]);
});

test('the pack pauses while a quest of the character starts, the game is busy or the journal is unknown; it never moves then', () => {
  const {runner} = make();
  const t0 = 100 * DAY, base = {journalHistory: journal(PANAM_DONE)};
  const start = turn('panam-palmer', t0, base); runner.forTurn(start, {level: 6}); runner.afterTurn(start, 'hi');
  const late = t0 + 60 * HOUR;
  assert.equal(noteOf(runner, turn('panam-palmer', late, base, {busy: true})), '');
  assert.equal(noteOf(runner, turn('panam-palmer', late, {journalHistory: undefined})), '');
  assert.equal(noteOf(runner, turn('panam-palmer', late, {journalHistory: journal([...PANAM_DONE, ['quests/side_quest/sq004_riders_on_the_storm', 'active']])})), '');
  assert.equal(runner.entries.get('panam-truck-ransom').trail.at(-1).stage, 'ask', 'the 48 hour timer did not run while paused');
  assert.equal(noteOf(runner, turn('panam-palmer', late, {journalHistory: journal([...PANAM_DONE, ['quests/main_quest/act_01/q115_resurrection', 'active']])})), '', 'the end of the story');
});

test('a stage type this build does not play is skipped and logged once; the arc still ends', () => {
  const odd = structuredClone(packs['panam-truck-ransom']);
  odd.id = 'panam-odd';
  odd.stages[1].type = 'escort';          // recover
  const {runner, lines} = make({packs: [odd]});
  const t0 = 110 * DAY, base = {journalHistory: journal(PANAM_DONE)};
  const start = turn('panam-palmer', t0, base); runner.forTurn(start, {level: 6}); runner.afterTurn(start, 'hi');
  const go = turn('panam-palmer', t0 + 600, base); runner.forTurn(go, {level: 6}); runner.afterTurn(go, 'sure, let\'s go');
  const entry = runner.entries.get('panam-odd');
  assert.equal(entry.trail.find(step => step.stage === 'recover').choice, 'help');
  assert(entry.trail.some(step => step.choice === 'skipped'), 'recover was skipped');
  assert.equal(lines.filter(line => /stage type escort is not played yet/.test(line)).length, 1);
  assert.notEqual(entry.trail.at(-1).stage, 'recover');
});

test('state is saved and read back; a damaged file starts empty; the status lists active and finished packs and the characters V has met', async () => {
  const store = {};
  const first = make({read: async () => { throw Error('none'); }, write: async (file, text) => { store[file] = text; }});
  const t0 = 120 * DAY, base = {journalHistory: journal(PANAM_DONE)};
  const start = turn('panam-palmer', t0, base); first.runner.forTurn(start, {level: 6}); first.runner.afterTurn(start, 'hi');
  await first.runner.flush();
  const again = make({read: async () => store['packs.json'], write: async () => {}}).runner;
  assert.equal(await again.load(), 1);
  assert.equal(again.entries.get('panam-truck-ransom').trail[0].at, t0);
  assert.equal(await make({read: async () => '{nope'}).runner.load(), 0);
  const source = again.source();
  assert.deepEqual(source.active(), {'panam-palmer': {id: 'panam-truck-ransom', title: 'Ransom for the Mackinaw', stage: 'ask'}});
  assert.deepEqual(source.list('panam-palmer'), [{id: 'panam-truck-ransom', title: 'Ransom for the Mackinaw', state: 'active', label: 'Her truck is held for ransom', ending: null}]);
  // The status file of the bonds object carries them, with the Relationships page's rows.
  const writes = [];
  const bonds = new Bonds({store: new BondStore(), statusPath: 's.json', now: () => 1_700_000_000_000, write: async (file, text) => { writes.push(JSON.parse(text)); }});
  bonds.packSource = source;
  const input = {...turn('panam-palmer', t0, base), name: 'Panam Palmer'};
  bonds.recordTurn(input, 'hello');
  await bonds.statusChain;
  const status = writes.at(-1);
  assert.deepEqual(status.packs, source.active());
  assert.equal(status.characters.length, 1);
  assert.equal(status.characters[0].profileKey, 'panam-palmer');
  assert.equal(status.characters[0].level >= 1, true);
  assert.deepEqual(status.characters[0].packs, source.list('panam-palmer'));
  assert.equal(status.characters[0].arcTotal > 0, true);
});

test('Eddies counts the bond: a friend lends more, a stranger less; no bond block changes nothing', async () => {
  const { trustOf } = await import('./eddies.mjs');
  assert.equal(trustOf({copy: 'party', bondLevel: 3}), trustOf({copy: 'party'}));
  assert.equal(Math.round((trustOf({copy: 'party', bondLevel: 7}) - trustOf({copy: 'party', bondLevel: 3})) * 100), 12);
  assert.equal(Math.round((trustOf({copy: 'party', bondLevel: 3}) - trustOf({copy: 'party', bondLevel: 1})) * 100), 10);
});

test('the block carries the pack flags; a group speaker has its own line and only the first records; phone counts as an exchange', () => {
  assert.deepEqual(parseBonds({version: 1, on: true, packs: true, invitations: true, eddies: true, busy: true, copy: 'party'}),
    {on: true, copy: 'party', packs: true, invitations: true, eddies: true, busy: true});
  assert.deepEqual(parseBonds({version: 1, on: true, packs: 'yes'}), {on: true, copy: null});
  const store = new BondStore();
  const bonds = new Bonds({store, now: () => 1_700_000_000_000});
  const second = {...turn('judy-alvarez', DAY), group: {index: 2, total: 2, audience: ['judy-alvarez', 'panam-palmer'], id: 'g', heard: []}};
  assert.match(bonds.contextFor(second), /How close you are to V/);
  bonds.recordTurn(second, 'hey'); assert.equal(store.size, 0, 'the second speaker records nothing');
  bonds.recordTurn({...second, group: {...second.group, index: 1}}, 'hey'); assert.equal(store.size, 1);
  bonds.recordTurn({...turn('judy-alvarez', DAY), channel: 'phone', bonds: {on: true, copy: null}}, 'hey');
  assert.equal(store.peek('judy-alvarez').warm, 4 + 3, 'the first group speaker 4 (an own copy), then a phone message 3');
});

test('what a turn costs: a context with a pack note and one without are both well under a millisecond', () => {
  const {runner} = make();
  const t0 = 130 * DAY, base = {journalHistory: journal(PANAM_DONE)};
  const start = turn('panam-palmer', t0, base); runner.forTurn(start, {level: 6}); runner.afterTurn(start, 'hi');
  const time = fn => { const begin = process.hrtime.bigint(); for (let i = 0; i < 500; i++) fn(i); return Number(process.hrtime.bigint() - begin) / 1e6 / 500; };
  const withNote = time(i => runner.forTurn(turn('panam-palmer', t0 + 10 + i, base), {level: 6}));
  const without = time(i => runner.forTurn(turn('rogue-amendiares', t0 + i, base), {level: 6}));
  assert(withNote < 1, `with a pack note: ${withNote} ms`);
  assert(without < 0.2, `without: ${without} ms`);
});

test('the bridge wiring: the pack note is a volatile block, Eddies gets the story and the bond level, the publish reads V\'s words after the reply, Phone Chat and the meeting greeting reach the packs, the state is flushed', () => {
  const bridge = read('./convai-bridge.mjs');
  assert.match(bridge, /block\('volatile', packTurn\(input, prepared, admitted\)\?\.note \?\? ''\)/);
  assert.match(bridge, /bondLevel: input\.bonds \? bonds\.levelFor\(input, bondFacts\(input, prepared, admitted\)\) : null, story: packTurn\(input, prepared, admitted\)\?\.story \?\? null/);
  assert.equal(bridge.match(/publishBonds\(input, result, publishEddies\(input, result\)\); publishMeeting\(input\);/g)?.length, 2, 'both publish paths');
  assert.match(bridge, /if \(input\.bonds\.packs\) bondPacks\.afterTurn\(input, result\?\.userText, proposal\);/);
  assert.match(bridge, /publishBonds\(prepared\.input, result\); publishPhoneEvent\(options\.input, options\.profileKey\);/);
  assert.match(bridge, /await bondPacks\.flush\(\)/);
  assert.match(read('./protocol.mjs'), /const bonds = value\.bonds === undefined \|\| reaction \|\| head \? null : parseBonds\(value\.bonds\)/);
  assert.match(read('./phone-chat.mjs'), /parseBonds\(state\.request\.bonds\)/);
});
