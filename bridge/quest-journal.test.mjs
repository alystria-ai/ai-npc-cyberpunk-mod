// The journal block of the play file (bridge/quest-journal.mjs, docs/REAL_QUESTS.md): the real quest the game shows for each story pack, its objective per stage,
// the waypoint place, the outcome of an ending, the rollback of a load, and the texts every shipped pack carries for it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BondPacks} from './bond-pack-runner.mjs';
import {QuestLink} from './quest-link.mjs';
import {shippedPacks, validatePack, PACK_LIMITS} from './bond-packs.mjs';
import {parseJournalHistory} from './journal-history.mjs';
import {journalBlock, outcomeOf, resolvePlace, stagePlaceKey, namedPlaceFor, pinPlace, FINISHED_KEEP, NAMED_PLACE_WORDS} from './quest-journal.mjs';
import {NAMED_PLACES} from './named-places-data.mjs';

const DAY = 86400;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const roster = new Set(JSON.parse(read('../characters/roster.json')).map(row => row.key));
const packs = shippedPacks().map(row => row.pack);
const pilot = packs.find(pack => pack.id === 'panam-sunset-coffee');

function history() {
  const coverage = {status: 'complete', ageSeconds: 1, windowSeconds: 30, observed: 1, omitted: 0, unstable: false};
  return parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, worldToken: 'w1', tracked: {status: 'untracked'}, coverage: {active: coverage, history: coverage},
    quests: [{id: '100', nativeId: 'q104_02_av_chase', nativePath: 'quests/main_quest/act_01/q104_02_av_chase', title: 'Q', state: 'succeeded', lane: 'history', observedAtMs: 1000,
      objectivesComplete: true, objectives: []}]});
}

function make() {
  const awards = [];
  const runner = new BondPacks({packs: [pilot], characters: roster, random: () => 0, reach: null, debounceMs: 0, exists: () => false, write: async () => {},
    bonds: {award: (key, points) => awards.push([key, points]), publish() {}}});
  const events = {session: 's1', seq: 0, list: []};
  const written = [];
  const link = new QuestLink({packs: runner, readEvents: async () => JSON.stringify({version: 1, session: events.session, seq: events.seq, events: events.list}),
    writePlay: async text => { written.push(JSON.parse(text)); }});
  const game = async (name, at) => {
    const quest = runner.playState().quests[0];
    events.seq += 1;
    events.list.push({seq: events.seq, pack: 'panam-sunset-coffee', serial: quest?.serial, name, at});
    await link.poll();
    await link.sync();
  };
  const start = (t0 = 30 * DAY) => {
    const input = {requestId: 'r-1', profileKey: 'panam-palmer', name: 'Panam', text: 'hey', entity: 'e1', turnContext: {gameTime: t0}, journalHistory: history(),
      bonds: {on: true, copy: 'party', packs: true, invitations: true}};
    runner.forTurn(input, {level: 3}); runner.afterTurn(input, 'ok');
  };
  return {runner, awards, link, written, game, start, journal: () => runner.playState().journal};
}

test('a started pack is one active quest: title, journal text, the first objective and the meeting place', () => {
  const a = make();
  assert.deepEqual(a.journal(), [], 'nothing before the pack starts');
  a.start(30 * DAY);
  const [row] = a.journal();
  assert.equal(row.pack, 'panam-sunset-coffee');
  assert.equal(row.kind, 'quest');
  assert.equal(row.character, 'panam-palmer');
  assert.equal(row.title, 'Coffee at the Sunset');
  assert.equal(row.description, pilot.description);
  assert.equal(row.objective, 'Meet Panam at the Sunset Motel');
  assert.equal(row.state, 'active');
  assert.equal(row.serial, 1);
  assert.equal(row.since, 30 * DAY);
  // The Sunset Motel has no measured position yet: the place is named, with no waypoint position (the game may find a captured one).
  assert.equal(row.place.id, 'sunset');
  assert.equal(row.place.name, 'the Sunset Motel forecourt in Rocky Ridge');
  assert.equal(row.place.x, undefined);
  assert.equal(row.place.anchor, 'stage');
  assert.equal(row.place.fallback.anchor, 'landmark', 'and a fallback rides along, so the quest has a pin from the start');
  assert.ok(Number.isFinite(row.place.fallback.x) && Number.isFinite(row.place.fallback.y) && Number.isFinite(row.place.fallback.z));
});

test('each stage moves the objective and the waypoint place, and the play file revision follows', async () => {
  const t0 = 30 * DAY;
  const a = make();
  a.start(t0);
  await a.link.sync();
  const first = a.written.at(-1).revision;
  await a.game('place:sunset:arrived', t0 + 600);
  let [row] = a.journal();
  assert.equal(row.objective, 'Walk around Rocky Ridge with Panam');
  assert.equal(row.place.id, 'lookout');
  assert.equal(row.serial, 2);
  assert.equal(row.since, t0 + 600);
  assert.ok(a.written.at(-1).revision > first, 'the play file was written again');
  assert.deepEqual(a.written.at(-1).journal, a.journal());
  await a.game('together:tour:done', t0 + 1900);
  [row] = a.journal();
  assert.equal(row.objective, 'Watch the sunrise with Panam');
  assert.ok(row.place && Number.isFinite(row.place.x), 'a stage with no place still has a pin: the last place with a position, else the first place, else a landmark');
  assert.equal(row.place.anchor, 'landmark', 'Panam\'s places have no position yet, so the character\'s landmark');
});

test('an ending files the quest as succeeded or failed with its closing sentence, and the story finishing it first removes it', async () => {
  const t0 = 30 * DAY;
  const warm = make();
  warm.start(t0);
  await warm.game('place:sunset:arrived', t0 + 600);
  await warm.game('together:tour:done', t0 + 1900);
  await warm.game('gap:g1:open', t0 + 2000);
  await warm.game('gap:g1:shared', t0 + 2100);
  await warm.game('place:sunset:left', t0 + 3000);
  let [row] = warm.journal();
  assert.equal(row.state, 'succeeded');
  assert.equal(row.endedAt, t0 + 3000);
  assert.ok(row.description.startsWith(pilot.description));
  assert.ok(row.description.endsWith(pilot.endings['sunrise-shared'].memory.slice(-20)));
  assert.equal(row.objective, 'Finish the coffee with Panam', 'the last objective played');
  assert.equal(row.place, undefined);

  // No time limit (owner decision 1 Nov 2026): a game week and a game month later the coffee is still an open quest, whatever the game clock says.
  const open = make();
  open.start(t0);
  await open.game('stage:timeout', t0 + 30 * DAY);
  assert.equal(open.journal()[0].state, 'active', 'no timer ends it, and even a stray stage:timeout event moves nothing');
  assert.deepEqual(open.awards, [], 'no penalty for time');
  assert.equal(open.runner.playState().quests[0].timeoutAt, undefined, 'the play file carries no timeout');
  // V abandons it (the journal or the probe sends quest:abandon): it leaves the journal with no bond change.
  await open.game('quest:abandon', t0 + 40 * DAY);
  assert.deepEqual(open.journal(), [], 'abandoned: no row any more');
  assert.deepEqual(open.awards, [], 'no bond change');

  const entry = state => ({status: 'done', trail: [{stage: 'invite', at: 1}, {stage: state.stage, at: 2, ending: true, ...(state.choice ? {choice: state.choice} : {})}]});
  assert.equal(outcomeOf(pilot, entry({stage: 'left'})), 'succeeded');
  assert.equal(outcomeOf({...pilot, endings: {...pilot.endings, sour: {memory: 'x', bond: -5}}}, entry({stage: 'sour'})), 'failed', 'an ending that costs bond points is a failure');
  assert.equal(outcomeOf(pilot, entry({stage: 'left', choice: 'unfinished'})), 'abandoned');
  assert.equal(outcomeOf({...pilot, endings: {...pilot.endings, 'stood-up': {memory: 'x', bond: 0}}}, entry({stage: 'stood-up'})), 'failed');
  assert.equal(outcomeOf({...pilot, endings: {...pilot.endings, left: {...pilot.endings.left, outcome: 'failed'}}}, entry({stage: 'left'})), 'failed', 'the ending\'s own outcome decides');
  assert.equal(outcomeOf(pilot, {status: 'active', trail: [{stage: 'invite', at: 1}]}), null);
  const abandoned = journalBlock({packs: new Map([[pilot.id, pilot]]), entries: new Map([[pilot.id, entry({stage: 'left', choice: 'unfinished'})]])});
  assert.deepEqual(abandoned, [], 'a pack the story finished first is not shown');
});

test('a load of an earlier save rewinds the quest in the journal, and before its start it is gone: no ghost entry', async () => {
  const t0 = 30 * DAY;
  const a = make();
  a.start(t0);
  await a.game('place:sunset:arrived', t0 + 600);
  await a.game('together:tour:done', t0 + 1900);
  assert.equal(a.journal()[0].objective, 'Watch the sunrise with Panam');
  a.runner.rewind(t0 + 700);
  assert.equal(a.journal()[0].objective, 'Walk around Rocky Ridge with Panam');
  a.runner.rewind(t0 - 500);
  assert.deepEqual(a.journal(), []);
});

test('places: a pin first, then a place, a drive, a cast; a pack position, else the named place the name points at', () => {
  assert.equal(stagePlaceKey([{p: 'party'}, {p: 'place', at: 'b'}, {p: 'pin', at: 'a'}]), 'a');
  assert.equal(stagePlaceKey([{p: 'together', id: 't'}, {p: 'place', at: 'b'}]), 'b');
  assert.equal(stagePlaceKey([{p: 'ride', to: 'c', checkpoints: ['d']}]), 'c');
  assert.equal(stagePlaceKey([{p: 'squad', id: 's', at: 'e'}]), 'e');
  assert.equal(stagePlaceKey([{p: 'party'}]), null);
  assert.equal(stagePlaceKey(null), null);
  const own = {places: {spot: {name: 'a roof', radius: 9, x: 1, y: 2, z: 3, district: 'Watson'}}};
  assert.deepEqual(resolvePlace(own, 'spot'), {id: 'spot', name: 'a roof', radius: 9, district: 'Watson', x: 1, y: 2, z: 3});
  assert.equal(resolvePlace(own, 'missing'), null);
  const jackie = packs.find(pack => pack.id === 'jackie-drink');
  const door = resolvePlace(jackie, 'door');
  const afterlife = NAMED_PLACES.find(place => place.id === 'afterlife');
  assert.deepEqual([door.x, door.y, door.z, door.named], [afterlife.x, afterlife.y, afterlife.z, 'afterlife']);
  assert.equal(namedPlaceFor("Viktor's clinic behind the Esoterica in Little China").id, 'victors-clinic', 'the more specific place wins');
  assert.equal(namedPlaceFor('the clouds over the badlands'), null, 'Clouds the club is matched by its capital');
  assert.equal(namedPlaceFor('the bar inside Lizzie\'s Bar').id, 'lizzies-bar');
  // A named place measured in the game (bridge/named-places.mjs captures) gives its position too.
  const measured = NAMED_PLACES.map(place => place.id === 'sunset-motel' ? {...place, x: 10, y: 20, z: 30} : place);
  assert.deepEqual(['x', 'y', 'z'].map(key => resolvePlace(pilot, 'sunset', {named: measured})[key]), [10, 20, 30]);
  for (const [id] of NAMED_PLACE_WORDS) assert.ok(NAMED_PLACES.some(place => place.id === id), `${id} is a named place`);
});

test('active quests come first, newest first, and only the newest finished ones are kept', () => {
  const map = new Map(), entries = new Map();
  for (let i = 0; i < FINISHED_KEEP + 3; i++) {
    const id = `pilot-${i}`;
    map.set(id, {...pilot, id});
    entries.set(id, {status: 'done', trail: [{stage: 'invite', at: i}, {stage: 'left', at: 100 + i, ending: true}]});
  }
  map.set('pilot-live', {...pilot, id: 'pilot-live'});
  entries.set('pilot-live', {status: 'active', trail: [{stage: 'invite', at: 5}]});
  const rows = journalBlock({packs: map, entries});
  assert.equal(rows.length, 1 + FINISHED_KEEP);
  assert.equal(rows[0].pack, 'pilot-live');
  assert.equal(rows[1].pack, `pilot-${FINISHED_KEEP + 2}`);
  assert.ok(rows.slice(1).every(row => row.state === 'succeeded'));
});

test('every shipped pack has its journal text and an objective on every stage, in plain words, and its block builds', () => {
  for (const pack of packs) {
    const result = validatePack(pack, {characters: roster});
    assert.ok(result.ok, `${pack.id}: ${result.errors?.[0]}`);
    assert.ok(typeof pack.description === 'string' && pack.description.length <= PACK_LIMITS.description, `${pack.id} description`);
    for (const text of [pack.description, ...pack.stages.map(stage => stage.objective)]) {
      assert.ok(typeof text === 'string' && text.trim(), `${pack.id}: a text is missing`);
      assert.ok(!/[–—;]|--/.test(text), `${pack.id}: no dashes or semicolons in "${text}"`);
    }
    for (const stage of pack.stages) assert.ok(stage.objective.length <= PACK_LIMITS.objective, `${pack.id}/${stage.id} objective`);
    const entries = new Map([[pack.id, {status: 'active', trail: [{stage: pack.stages.at(-1).id, at: 10}]}]]);
    const [row] = journalBlock({packs: new Map([[pack.id, pack]]), entries});
    assert.equal(row.objective, pack.stages.at(-1).objective);
  }
  const bad = validatePack({...pilot, description: ''}, {characters: roster});
  assert.ok(bad.errors.some(error => error.startsWith('description')));
  const badStage = validatePack({...pilot, stages: pilot.stages.map((stage, i) => i ? stage : {...stage, objective: 'x'.repeat(81)})}, {characters: roster});
  assert.ok(badStage.errors.some(error => error.includes('objective must be')));
  const badEnding = validatePack({...pilot, endings: {...pilot.endings, left: {...pilot.endings.left, outcome: 'maybe'}}}, {characters: roster});
  assert.ok(badEnding.errors.some(error => error.includes('outcome must be')));
});

// ---- every started quest has a map pin (owner decision 1 Nov 2026) ----------------------------------------------------------------------------------------------

const LIST = [
  {id: 'afterlife', phrase: 'the Afterlife, a merc bar', x: -1455, y: 1010, z: 17, radius: 25},
  {id: 'lizzies-bar', phrase: "Lizzie's Bar, a club in Kabuki", x: -1184, y: 1568, z: 16, radius: 35},
  {id: 'judys-apartment', phrase: "Judy's apartment in Kabuki", x: -896, y: 1856, z: 48, radius: 35},
  {id: 'sunset-motel', phrase: 'the Sunset Motel', x: null, y: null, z: null, radius: 25},
  {id: 'victors-clinic', phrase: "Viktor's clinic", x: null, y: null, z: null, radius: 12},
];
const stageOf = pack => ({...pack.stages[0]});

test('the pin chain: the stage\'s own place with a position, else an earlier stage\'s, else the first place, else a named place in the words, else the character\'s landmark, else the Afterlife', () => {
  const base = {id: 'pin-test', character: 'judy-alvarez', title: 'Pin test', places: {a: {name: 'The first place', radius: 10, x: 1, y: 2, z: 3}, b: {name: 'The second place', radius: 10, x: 4, y: 5, z: 6}, c: {name: 'The Sunset Motel forecourt', radius: 10}},
    stages: [{id: 's1', objective: 'Go'}]};
  const stage = base.stages[0];
  // 1. the stage's own place with a position
  let pin = pinPlace(base, stage, [{p: 'pin', at: 'b'}], [], {named: LIST});
  assert.deepEqual([pin.id, pin.x, pin.anchor], ['b', 4, 'stage']);
  // 2. no place of its own: the last place an earlier stage had (newest first), so the pin stays where it was and moves only when a stage names a new place
  pin = pinPlace(base, stage, [], [[{p: 'pin', at: 'b'}], [{p: 'pin', at: 'a'}]], {named: LIST});
  assert.deepEqual([pin.id, pin.anchor], ['b', 'earlier']);
  // 3. nothing earlier: the quest's first place
  pin = pinPlace(base, stage, [], [], {named: LIST});
  assert.deepEqual([pin.id, pin.anchor], ['a', 'first']);
  // 4. no place with a position: a named place its words point at
  const words = {...base, places: {}, title: "Dinner at Lizzie's"};
  pin = pinPlace(words, stage, [], [], {named: LIST});
  assert.deepEqual([pin.id, pin.anchor, pin.x], ['lizzies-bar', 'named', -1184]);
  // ... and the stage's own words come before the rest of the pack's
  const mixed = {...words, title: "Dinner at Lizzie's", stages: [{id: 's1', objective: "Go to Judy's flat"}]};
  assert.equal(pinPlace(mixed, mixed.stages[0], [], [], {named: LIST}).id, 'judys-apartment');
  // 5. no words: the character's landmark, then the Afterlife
  const bare = {...base, places: {}, title: 'Plain', character: 'judy-alvarez'};
  assert.deepEqual([pinPlace(bare, stage, [], [], {named: LIST}).id, pinPlace(bare, stage, [], [], {named: LIST}).anchor], ['judys-apartment', 'landmark']);
  assert.equal(pinPlace({...bare, character: 'panam-palmer'}, stage, [], [], {named: LIST}).id, 'afterlife');
  assert.equal(pinPlace({...bare, character: 'viktor-vektor'}, stage, [], [], {named: LIST}).id, 'afterlife', 'a landmark with no position is skipped');
  // A stage place with no position keeps its own id (the game may have measured it) and carries the fallback.
  pin = pinPlace(base, stage, [{p: 'pin', at: 'c'}], [], {named: LIST});
  assert.equal(pin.id, 'c'); assert.equal(pin.x, undefined);
  assert.deepEqual([pin.fallback.id, pin.fallback.anchor], ['a', 'first']);
  // Only an empty position list gives no pin.
  assert.equal(pinPlace(bare, stage, [], [], {named: []}), null);
});

test('every stage of every shipped pack has a pin: its own position, or a fallback position from the chain', () => {
  let ownPosition = 0, fallback = 0;
  for (const pack of packs) {
    for (const stage of pack.stages) {
      const pin = pinPlace(pack, stage, stage.do ?? [], []);
      assert.ok(pin, `${pack.id}/${stage.id}: a pin`);
      const spot = Number.isFinite(pin.x) ? pin : pin.fallback;
      assert.ok(spot && Number.isFinite(spot.x) && Number.isFinite(spot.y) && Number.isFinite(spot.z), `${pack.id}/${stage.id}: a position`);
      if (Number.isFinite(pin.x)) ownPosition += 1; else fallback += 1;
    }
  }
  assert.ok(ownPosition > 20 && fallback > 100, `${ownPosition} own, ${fallback} fallback`);
});

test('the owner\'s live case: Judy\'s dinner names no place, and a started quest of hers has a pin at Lizzie\'s from its first stage, moving with the stages', () => {
  const dress = packs.find(pack => pack.id === 'judy-dinner-dress');
  assert.equal(dress.places, undefined, 'the pack names no place of its own');
  const entry = {status: 'active', trail: [{stage: 'invite', at: 5}], presented: true};
  const block = () => journalBlock({packs: new Map([[dress.id, dress]]), entries: new Map([[dress.id, entry]])});
  const [first] = block();
  assert.equal(first.state, 'active');
  assert.equal(first.place.id, 'lizzies-bar', 'the dinner is at Lizzie\'s, named in the pack\'s words');
  assert.equal(first.place.anchor, 'named');
  assert.ok(Number.isFinite(first.place.x) && Number.isFinite(first.place.y) && Number.isFinite(first.place.z));
  entry.trail.push({stage: 'dress', at: 6});
  assert.equal(block()[0].place.id, 'lizzies-bar', 'a later stage with no place keeps it');
  // A quest that has finished has no pin.
  const done = {status: 'done', trail: [{stage: 'invite', at: 5}, {stage: 'together', at: 9, ending: true}]};
  assert.equal(journalBlock({packs: new Map([[dress.id, dress]]), entries: new Map([[dress.id, done]])})[0].place, undefined);
});
