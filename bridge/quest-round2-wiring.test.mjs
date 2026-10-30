// Round 2 wiring (docs/QUEST_PRIMITIVES.md section 10): the request fields the game adds (the bonds block's reach flag, the quest block), the poller's two clocks and the pilot quest's
// play file with the new keys. Offline.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
// Story packs are not part of 0.4.0 (docs/STORY_PACKS_INACTIVE.md): this test of them runs with the development switch on.
import './story-packs-dev-on.mjs';
import {parseBonds} from './bonds.mjs';
import {parseInput} from './protocol.mjs';
import {createQuestPoller} from './quest-poller.mjs';
import {BondPacks} from './bond-pack-runner.mjs';
import {shippedPacks} from './bond-packs.mjs';
import {parseJournalHistory} from './journal-history.mjs';

const roster = new Set(JSON.parse(readFileSync(new URL('../characters/roster.json', import.meta.url), 'utf8')).map(row => row.key));
const base = {requestId: '1-1-1ULL', generation: 1, entity: '1ULL', name: 'Panam', bodyType: 'female', profileKey: 'panam-palmer', text: 'hey'};

test('the bonds block carries the reach flag (Characters text first) only when it is true', () => {
  assert.equal(parseBonds({version: 1, on: true, reach: true}).reach, true);
  assert.equal(Object.hasOwn(parseBonds({version: 1, on: true}), 'reach'), false);
  assert.equal(Object.hasOwn(parseBonds({version: 1, on: true, reach: 'yes'}), 'reach'), false);
  assert.equal(parseInput(JSON.stringify({...base, bonds: {version: 1, on: true, copy: 'party', packs: true, reach: true}})).bonds.reach, true);
  assert.equal(parseInput(JSON.stringify({...base, bonds: {version: 1, on: true, copy: 'party', packs: true}})).bonds.reach, undefined);
});

test('the quest block rides on an ordinary turn and is dropped from a reaction or a group round', () => {
  const quest = {pack: 'panam-sunset-coffee', cast: 'guard'};
  assert.deepEqual(parseInput(JSON.stringify({...base, quest})).quest, quest);
  assert.equal(parseInput(JSON.stringify({...base, quest: {...quest, cast: 'Guard'}})).quest, undefined);
  assert.equal(parseInput(JSON.stringify({...base, quest: {...quest, extra: 1}})).quest, undefined);
  assert.equal(parseInput(JSON.stringify({...base, quest, reaction: {kind: 'speakup'}})), null, 'a malformed reaction is refused as before');
});

test('the poller: 500 ms for a quest, 10 s while only reach-outs are wanted, no timer for nothing, and the interval follows the want', () => {
  const made = [], cleared = [];
  const state = {active: false};
  const poller = createQuestPoller({link: {active: () => state.active, async poll() {}, async sync() {}},
    setTimer: (fn, ms) => { const timer = {fn, ms, unref() {}}; made.push(timer); return timer; }, clearTimer: timer => cleared.push(timer)});
  assert.equal(poller.arm(), false); assert.equal(made.length, 0);
  state.active = 'reach';
  assert.equal(poller.arm(), true); assert.equal(made.at(-1).ms, 10000); assert.equal(poller.reachArmed, true); assert.equal(poller.armed, false);
  poller.arm(); assert.equal(made.length, 1, 'idempotent');
  state.active = true;
  poller.arm();
  assert.equal(made.at(-1).ms, 500); assert.equal(cleared.length, 1, 'the slow timer was replaced'); assert.equal(poller.armed, true); assert.equal(poller.reachArmed, false);
  state.active = false;
  poller.arm();
  assert.equal(cleared.length, 2); assert.equal(poller.armed, false); assert.equal(poller.reachArmed, false);
  state.active = 'reach'; poller.arm(); poller.stop();
  assert.equal(poller.reachArmed, false);
});

test('the pilot quest\'s play file keeps its shape and gains factsWanted and the reach block', () => {
  const pilot = shippedPacks().map(row => row.pack).find(pack => pack.id === 'panam-sunset-coffee');
  const coverage = {status: 'complete', ageSeconds: 1, windowSeconds: 30, observed: 1, omitted: 0, unstable: false};
  const journalHistory = parseJournalHistory({version: 1, status: 'ready', generation: 1, capturedAtMs: 2000, worldToken: 'w1', tracked: {status: 'untracked'}, coverage: {active: coverage, history: coverage},
    quests: [{id: '100', nativeId: 'q104_02_av_chase', nativePath: 'quests/main_quest/act_01/q104_02_av_chase', title: 'Q', state: 'succeeded', lane: 'history', observedAtMs: 1000, objectivesComplete: true, objectives: []}]});
  const runner = new BondPacks({packs: [pilot], characters: roster, random: () => 0, reach: null, bonds: {award() {}, publish() {}}, exists: () => false});
  const input = {requestId: 'r-1', profileKey: 'panam-palmer', name: 'Panam', text: 'hey', entity: 'e1', turnContext: {gameTime: 30 * 86400}, journalHistory,
    bonds: {on: true, copy: 'party', packs: true, invitations: true}};
  runner.forTurn(input, {level: 3}); runner.afterTurn(input, 'ok');
  const file = runner.playState();
  assert.deepEqual(Object.keys(file).sort(), ['closing', 'commands', 'factsWanted', 'quests', 'reach', 'revision', 'version']);
  assert.deepEqual(file.factsWanted, []);
  assert.deepEqual(file.reach, {enabled: false, items: [], perHour: 1, perDay: 3});
  assert.equal(file.quests[0].stage, 'invite');
  for (const key of ['calls', 'music', 'sfx', 'situation', 'gifts']) assert.equal(Object.hasOwn(file.quests[0], key), false, key);
});
