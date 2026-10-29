// Character bonds (docs/RELATIONSHIPS_AND_QUESTS.md, bridge/bonds.mjs): the levels, the story part from the journal, romance and Eddies, the shared part with
// its caps and fading hurt, the store and Forget, the prompt line, the record of a turn and the status file for the game. Offline: no game, no provider.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {LEVELS, levelOf, parseBonds, bondable, channelOf, arcPoints, moneyPoints, storyPart, exchangeValue, cappedTalk, fadedHurt, sharedPart,
  BondStore, Bonds, bondLine, inventoryComplete, questState, shippedBondArcs, TALK_POINTS, HURT_POINTS, DAY_CAPS, ROMANCE_POINTS, MAX_POINTS,
  HURT_HALF_LIFE_DAYS} from './bonds.mjs';
import {parseJournalHistory} from './journal-history.mjs';
import {parseInput} from './protocol.mjs';

const DAY = 86400;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

// A journal inventory in the shape the game sends (mod/journal-history.lua), parsed by the real parser.
function journal(rows, {complete = true} = {}) {
  const coverage = {status: complete ? 'complete' : 'partial', ageSeconds: 1, windowSeconds: 30, observed: rows.length, omitted: complete ? 0 : 3, unstable: false};
  return parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, worldToken: 'w1', tracked: {status: 'untracked'},
    coverage: {active: coverage, history: coverage},
    quests: rows.map(([path, state], index) => ({id: String(100 + index), nativeId: path.slice(path.lastIndexOf('/') + 1), nativePath: path, title: 'Quest ' + index,
      state, lane: state === 'active' ? 'active' : 'history', observedAtMs: 1000, objectivesComplete: state !== 'active', objectives: []}))});
}
const PANAM_DONE = [
  ['quests/main_quest/act_01/q104_01_sabotage', 'succeeded'], ['quests/main_quest/act_01/q104_02_av_chase', 'succeeded'],
  ['quests/side_quest/sq004_riders_on_the_storm', 'succeeded'], ['quests/side_quest/sq027_01_basilisk_convoy', 'succeeded'],
  ['quests/side_quest/sq027_02_raffen_shiv_attack', 'failed'],
];

test('ten levels with rising thresholds and titles; points map to a level', () => {
  assert.equal(LEVELS.length, 10);
  for (let index = 1; index < LEVELS.length; index++) assert(LEVELS[index].from > LEVELS[index - 1].from);
  assert.equal(LEVELS[0].from, 0); assert(LEVELS[9].from <= MAX_POINTS);
  assert.equal(levelOf(0).level, 1); assert.equal(levelOf(29).level, 1); assert.equal(levelOf(30).level, 2);
  assert.equal(levelOf(350).title, 'Close friend'); assert.equal(levelOf(MAX_POINTS).title, 'Ride or die'); assert.equal(levelOf(NaN).level, 1);
});

test('the block: only a well-formed one counts, the copy kind only when known; the protocol keeps it on private turns and holocalls', () => {
  assert.equal(parseBonds(undefined), null); assert.equal(parseBonds({version: 2, on: true}), null); assert.equal(parseBonds({version: 1, on: false}), null);
  assert.deepEqual(parseBonds({version: 1, on: true, copy: 'party'}), {on: true, copy: 'party'});
  assert.deepEqual(parseBonds({version: 1, on: true, copy: 'stranger'}), {on: true, copy: null});
  const base = {requestId: '1-1-42ULL', generation: 1, entity: '42ULL', name: 'Judy', bodyType: 'x', profileKey: 'judy-alvarez', text: 'hey', bonds: {version: 1, on: true, copy: 'party'}};
  assert.deepEqual(parseInput(JSON.stringify(base)).bonds, {on: true, copy: 'party'});
  assert.deepEqual(parseInput(JSON.stringify({...base, holocall: {version: 1, contact: 'judy-alvarez', mode: 'audio'}})).bonds, {on: true, copy: 'party'});
  assert.equal(parseInput(JSON.stringify({...base, bonds: undefined})).bonds, undefined, 'no block, no bonds');
  assert.equal(bondable('judy-alvarez'), true); assert.equal(bondable('npc-valentinos-male'), false); assert.equal(bondable('resident-female'), false);
  assert.equal(bondable('addon-skippy-skippy'), false); assert.equal(bondable('custom-my-friend'), true);
  assert.equal(channelOf({bonds: {copy: 'party'}}), 'own'); assert.equal(channelOf({bonds: {copy: null}}), 'story');
  assert.equal(channelOf({holocall: {}, bonds: {copy: null}}), 'holocall');
});

test('the story part: finished quests of the arc (succeeded or failed) from a complete inventory only; romance and money', () => {
  const arcs = shippedBondArcs();
  for (const [key, arc] of Object.entries(arcs.arcs)) {
    assert.equal(Object.values(arc.quests).reduce((a, b) => a + b, 0), 350, `${key}: a whole arc is 350`);
    for (const path of Object.keys(arc.quests)) assert.match(path, /^(?:ep1\/)?quests\//, `${key}: ${path}`);
    assert(arc.active.length > 0, key);
  }
  // Every arc path is a quest the premises file knows (the paths the quest briefings were checked against on a real save).
  const premises = JSON.parse(read('../research/cyberpunk/quest-premises.json')).premises;
  for (const [key, arc] of Object.entries(arcs.arcs)) for (const path of Object.keys(arc.quests)) assert(Object.hasOwn(premises, path), `${key}: ${path} is a known quest`);
  const history = journal(PANAM_DONE);
  assert(inventoryComplete(history));
  assert.equal(questState(history, 'quests/side_quest/sq027_02_raffen_shiv_attack'), 'failed');
  assert.equal(arcPoints('panam-palmer', history), 350);
  assert.equal(arcPoints('panam-palmer', journal(PANAM_DONE.slice(0, 2))), 100);
  assert.equal(arcPoints('panam-palmer', journal([['quests/side_quest/sq027_01_basilisk_convoy', 'active']])), 0, 'an active quest counts nothing');
  assert.equal(arcPoints('panam-palmer', journal(PANAM_DONE, {complete: false})), 0, 'a partial inventory counts nothing');
  assert.equal(arcPoints('panam-palmer', undefined), 0);
  assert.equal(arcPoints('meredith-stout', history), 0, 'no arc, no story points');
  // A row known only by its id (no nativePath) still matches the path's last part.
  const byId = {...history, quests: history.quests.map(({nativePath, ...rest}) => rest)};
  assert.equal(arcPoints('panam-palmer', byId), 350);
  assert.equal(moneyPoints(null), 0);
  assert.equal(moneyPoints({totals: {loanToV: 500, repayByV: 500, giftFromV: 1000}}), 30 + 5);
  assert.equal(moneyPoints({totals: {loanToV: 500, repayByV: 100}}), -15);
  assert.equal(moneyPoints({totals: {giftFromV: 99999}}), 60, 'gifts give at most 60');
  assert.deepEqual(storyPart({profileKey: 'panam-palmer', journalHistory: history, romance: 'partner'}), {points: 350 + ROMANCE_POINTS.partner, arc: 350, romance: 150, money: 0});
  assert.equal(storyPart({profileKey: 'meredith-stout', romance: 'casual'}).points, ROMANCE_POINTS.casual);
});

test('an exchange: points by channel; a threat or insult at the character costs points and gains nothing; jokes and third parties are no threat', () => {
  assert.deepEqual(exchangeValue('own', 'how was your day?'), {talk: TALK_POINTS.own, hurt: 0, threat: null});
  assert.equal(exchangeValue('holocall', 'hey').talk, TALK_POINTS.holocall);
  assert.equal(exchangeValue('story', 'hey').talk, TALK_POINTS.story);
  assert.deepEqual(exchangeValue('own', 'I will kill you'), {talk: 0, hurt: HURT_POINTS.kill, threat: 'kill'});
  assert.equal(exchangeValue('own', 'I will break your legs').hurt, HURT_POINTS.hurt);
  assert.equal(exchangeValue('own', 'fuck you').hurt, HURT_POINTS.insult);
  assert.equal(exchangeValue('own', 'you idiot, haha').hurt, 0, 'a joke');
  assert.equal(exchangeValue('own', 'I am going to kill Adam Smasher').hurt, 0, 'a threat at someone else');
  assert.equal(exchangeValue('own', '[Microphone]').talk, TALK_POINTS.own, 'a recording placeholder is no words');
});

test('the caps: full points for the first exchanges of a game day, then half, then none; a real-day cap; no clock uses the real day', () => {
  const entry = {warm: 0, hurt: 0, day: null, dayCount: 0, realDay: null, realPoints: 0};
  const gained = [];
  for (let index = 0; index < DAY_CAPS.full + DAY_CAPS.half + 3; index++) gained.push(cappedTalk(entry, 4, {gameSeconds: 10 * DAY + index, nowMs: 0}));
  assert.deepEqual(gained.slice(0, DAY_CAPS.full), Array(DAY_CAPS.full).fill(4));
  assert.deepEqual(gained.slice(DAY_CAPS.full, DAY_CAPS.full + DAY_CAPS.half), Array(DAY_CAPS.half).fill(2));
  assert.deepEqual(gained.slice(-3), [0, 0, 0]);
  assert.equal(cappedTalk(entry, 4, {gameSeconds: 11 * DAY, nowMs: 0}), 4, 'a new game day starts again');
  // Skipping game days by waiting cannot pass the real-day cap.
  const farm = {warm: 0, hurt: 0, day: null, dayCount: 0, realDay: null, realPoints: 0};
  let total = 0;
  for (let day = 0; day < 200; day++) total += cappedTalk(farm, 4, {gameSeconds: day * DAY, nowMs: 1000});
  assert.equal(total, DAY_CAPS.real);
  const noClock = {warm: 0, hurt: 0, day: null, dayCount: 0, realDay: null, realPoints: 0};
  for (let index = 0; index < DAY_CAPS.full; index++) assert.equal(cappedTalk(noClock, 4, {gameSeconds: undefined, nowMs: 5}), 4);
  assert.equal(cappedTalk(noClock, 4, {gameSeconds: undefined, nowMs: 5}), 2);
});

test('hurt fades with its half-life by the game clock; warmth never fades; the shared part has its bounds', () => {
  const entry = {warm: 100, hurt: 40, hurtAt: 0};
  assert.equal(fadedHurt(entry, 0), 40);
  assert.equal(Math.round(fadedHurt(entry, HURT_HALF_LIFE_DAYS * DAY)), 20);
  assert.equal(fadedHurt(entry, undefined), 40, 'no clock: nothing fades');
  assert.equal(sharedPart(entry, 0), 60);
  assert.equal(sharedPart(entry, 1000 * DAY), 100, 'warmth stays');
  assert.equal(sharedPart({warm: 0, hurt: 5000, hurtAt: 0}, 0), -300);
});

test('the store: add with caps and hurt, per memory key; load and save; a damaged file starts empty; Forget by key, by scope and all', async () => {
  const files = new Map();
  const store = new BondStore({path: 'bonds.json', now: () => 0, debounceMs: 1, read: async file => files.get(file), write: async (file, text) => { files.set(file, text); },
    timers: {set: fn => { fn(); return 1; }, clear: () => {}}});
  assert.equal(await store.load(), 0);
  store.add('judy-alvarez', {talk: 4}, {gameSeconds: DAY});
  store.add('judy-alvarez@medieval', {talk: 4}, {gameSeconds: DAY});
  store.add('panam-palmer', {hurt: 25}, {gameSeconds: DAY});
  assert.equal(store.add('Not A Key', {talk: 4}), null);
  await store.flush();
  const again = new BondStore({path: 'bonds.json', read: async file => files.get(file)});
  assert.equal(await again.load(), 3);
  assert.equal(again.peek('judy-alvarez').warm, 4);
  assert.equal(again.peek('panam-palmer').hurt, 25); assert.equal(again.peek('panam-palmer').hurtAt, DAY);
  assert.equal(again.forget({profileKeys: ['panam-palmer']}), 1);
  assert.equal(again.forget({all: true, scope: 'medieval'}), 1);
  assert(again.peek('judy-alvarez'), 'the normal memory is not the pack\'s');
  assert.equal(again.forget({all: true}), 1);
  files.set('bad.json', '{not json');
  assert.equal(await new BondStore({path: 'bad.json', read: async file => files.get(file)}).load(), 0);
});

test('the prompt line: what the level means, never a number; a sting while hurt is left', () => {
  const line = bondLine(5);
  assert.match(line, /never say it as a level or a number/);
  assert.match(line, /good friend/);
  assert.doesNotMatch(line, /\b5\b|level 5/);
  assert.match(bondLine(5, 30), /it still stings/);
  assert.doesNotMatch(bondLine(5, 10), /stings/);
  for (const row of LEVELS) assert(bondLine(row.level).length < 320, `level ${row.level} is short`);
});

function turn(extra = {}) {
  return {requestId: 'r' + Math.random(), profileKey: 'panam-palmer', name: 'Panam Palmer', text: 'how are you?', bonds: {on: true, copy: 'party'},
    turnContext: {gameTime: 20 * DAY}, journalHistory: journal(PANAM_DONE.slice(0, 2)), ...extra};
}

test('a turn: the line is decided once per request; no line without the block, for a group, a reaction, Johnny in V\'s head or an ordinary NPC', () => {
  const bonds = new Bonds({store: new BondStore(), now: () => 0});
  const input = turn();
  const line = bonds.contextFor(input);
  assert.match(line, /How close you are to V/);
  assert.match(line, /you like V/, '100 story points: level 3, Friendly');
  assert.equal(bonds.contextFor(input), line, 'the same turn gets the same line');
  for (const extra of [{bonds: undefined}, {group: {index: 1}}, {reaction: {kind: 'battle'}}, {head: {stage: 1}}, {profileKey: 'npc-valentinos-male'}]) {
    assert.equal(bonds.contextFor(turn(extra)), '', JSON.stringify(Object.keys(extra)));
  }
  // A romance the save confirms raises the story part.
  assert.match(bonds.contextFor(turn(), {romance: 'partner'}), /good friend/i, '100 + 150: level 5');
});

test('recording turns: a level change is told to the game once, up and down, with unique ids; the status file holds the levels', async () => {
  const written = [];
  const store = new BondStore();
  const bonds = new Bonds({store, statusPath: 'status.json', now: () => 1_700_000_000_000, write: async (file, text) => { written.push(JSON.parse(text)); }});
  // Panam at 100 story points: level 3 (Friendly, from 80); level 4 starts at 150.
  const first = turn();
  assert.equal(levelOf(100).level, 3);
  assert.equal(bonds.recordTurn(first), null, 'no change: 100 + 4 is still level 3');
  await bonds.statusChain;
  assert.equal(written.length, 1, 'the first turn of a character this session publishes its level');
  assert.equal(written[0].levels['panam-palmer'].level, 3);
  // Talk on until level 4 (150).
  let change = null, turns = 0;
  for (let day = 20; !change && day < 40; day++) for (let index = 0; index < 6 && !change; index++) { change = bonds.recordTurn(turn({turnContext: {gameTime: day * DAY + index}})); turns++; }
  assert(change, 'the level rose');
  assert.equal(change.from, 3); assert.equal(change.to, 4); assert.equal(change.title, 'Friend'); assert.equal(change.name, 'Panam Palmer');
  assert(change.id > 1_700_000_000_000 / 1000, 'ids go on from the session start');
  await bonds.statusChain;
  assert.equal(written.at(-1).changes.at(-1).to, 4);
  // A death threat costs points and the level falls.
  const fall = bonds.recordTurn(turn({text: 'I will kill you', turnContext: {gameTime: 40 * DAY}}));
  assert(fall && fall.to < fall.from && fall.id > change.id, JSON.stringify(fall));
  // A spoken turn's words are the transcript.
  const spoken = bonds.recordTurn(turn({text: '[Microphone]', turnContext: {gameTime: 41 * DAY}}), 'fuck you');
  assert.equal(spoken === null || spoken.to <= fall.to, true);
  assert(store.peek('panam-palmer').hurt > HURT_POINTS.kill);
  // Forget clears the shared part: the next record starts from the story part again.
  bonds.forget({profileKeys: ['panam-palmer']});
  assert.equal(store.peek('panam-palmer'), undefined);
  assert.equal(bonds.recordTurn(turn({bonds: undefined})), null, 'without the block nothing is recorded');
  assert.equal(store.peek('panam-palmer'), undefined);
});

test('the bridge wiring: the line is a world block, the record runs after a published reply on both publish paths, Forget and shutdown reach the store', () => {
  const bridge = read('./convai-bridge.mjs');
  assert.match(bridge, /block\('world', bondNote\(input, prepared, admitted\)\)/);
  assert.equal(bridge.match(/commitExchange\(input\); gearTold\(\); publishEddies\(input, result\); publishBonds\(input, result\);/g)?.length, 2);
  assert.match(bridge, /bonds\.forget\(\{all: scope === 'all'/);
  assert.match(bridge, /await bondStore\.flush\(\)/);
  assert.match(bridge, /resolve\(stateDirectory, 'bonds\.json'\)/);
  assert.match(bridge, /resolve\(runtime, 'bonds-status\.json'\)/);
  const exchange = JSON.parse(read('../packaging/runtime-exchange.json'));
  assert(exchange.exchange.includes('bonds-status.json'), 'the status file is an exchange file, never shipped');
});
