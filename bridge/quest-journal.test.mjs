// The journal block of the play file (bridge/quest-journal.mjs, docs/REAL_QUESTS.md): the real quest the game shows for each story pack, its objective per stage,
// the waypoint place, the outcome of an ending, the rollback of a load, and the texts every shipped pack carries for it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {BondPacks} from './bond-pack-runner.mjs';
import {QuestLink} from './quest-link.mjs';
import {shippedPacks, validatePack, PACK_LIMITS} from './bond-packs.mjs';
import {parseJournalHistory} from './journal-history.mjs';
import {journalBlock, outcomeOf, resolvePlace, stagePlaceKey, namedPlaceFor, FINISHED_KEEP, NAMED_PLACE_WORDS} from './quest-journal.mjs';
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
  assert.equal(row.place, undefined, 'a stage with no place has no waypoint');
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
