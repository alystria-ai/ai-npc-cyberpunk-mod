// A crowd profile (resident-female, npc-street-resident-male...) is a template that every stranger of that kind shares. Everything the bridge remembers about a talk
// has to be kept per person (the actor's entity), never per profile (live 2026-10-27: the owner felt two female pedestrians "shared" one history).
// The history, the Convai session and the "already told" flags are keyed by the person since the ambient route existed (bridge/conversation-knowledge.mjs); these tests
// hold that, and the two states that were still kept per profile: the carried mood (bridge/emotion-selector.mjs) and the in-game lines a stranger heard (bridge/game-dialogue.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {isAmbientProfile, personKey} from './protocol.mjs';
import {EmotionSelection} from './emotion-selector.mjs';
import {MemoryStore} from './memory-store.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {KnowledgeRouter} from './conversation-knowledge.mjs';
import {selectGameDialogue} from './game-dialogue.mjs';
import {SceneryMemory} from './scenery-memory.mjs';

const bridgeSource = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');

test('personKey: the profile for a named character, profile and entity for a generic person', () => {
  assert.equal(personKey({profileKey: 'judy-alvarez', entity: '11ULL'}), 'judy-alvarez');
  assert.equal(personKey({profileKey: 'resident-female', entity: '10009597ULL'}), 'resident-female|10009597ULL');
  assert.equal(personKey({profileKey: 'resident-female', entity: '11146316ULL'}), 'resident-female|11146316ULL');
  assert.equal(personKey({profileKey: 'npc-street-resident-male', entity: '5ULL'}), 'npc-street-resident-male|5ULL');
  // No usable entity: the profile, as before (parseInput never lets an ambient turn through without one).
  assert.equal(personKey({profileKey: 'resident-male'}), 'resident-male');
  assert.equal(personKey({profileKey: 'resident-male', entity: 'not-an-id'}), 'resident-male');
  assert.equal(personKey(undefined), undefined);
  for (const key of ['resident-male', 'resident-female', 'npc-corpo-male']) assert.equal(isAmbientProfile(key), true);
});

// ---- The stores: two people on one template ------------------------------------------------------------------------------------

for (const [label, open] of [['the memory store', () => MemoryStore.open({})], ['the Mistral memory', () => MistralMemory.open({path: null})]]) {
  test(`${label}: two strangers with one profile keep their own turns, the same stranger keeps its own, and the oldest strangers are dropped`, async () => {
    const memory = await open();
    const person = entity => ({profileKey: 'resident-female', channel: 'private', ambientKey: `route:${entity}`});
    memory.record({...person('10009597ULL'), v: 'how do I look?', r: 'Up all night.'});
    assert.equal(memory.recall(person('11146316ULL')).turns.length, 0, 'a new stranger starts fresh');
    memory.record({...person('11146316ULL'), v: 'nice weather', r: 'If you say so.'});
    assert.deepEqual(memory.recall(person('10009597ULL')).turns.map(turn => turn.v), ['how do I look?']);
    assert.deepEqual(memory.recall(person('11146316ULL')).turns.map(turn => turn.v), ['nice weather']);
    // The bare profile holds nothing: nothing is kept under the template itself.
    assert.equal(memory.recall({profileKey: 'resident-female', channel: 'private'}).turns.length, 0);
    // Bounded: past the cap the least recently used stranger goes, the recent ones stay.
    const cap = memory.limits.ambient;
    assert.ok(cap > 0 && cap <= 256, 'the cap is a small number');
    for (let i = 0; i < cap + 5; i++) memory.record({...person(`${i}ULL`), v: 'a', r: 'b'});
    assert.equal(memory.recall(person('0ULL')).turns.length, 0, 'the oldest stranger was dropped');
    assert.equal(memory.recall(person(`${cap + 4}ULL`)).turns.length, 1, 'the newest stays');
    assert.equal(memory.recall(person('10009597ULL')).turns.length, 0);
  });
}

// ---- The route: two entities on one profile get two session keys ----------------------------------------------------------------

test('the knowledge route gives each stranger of one profile its own session key, and the same stranger the same key', () => {
  const router = new KnowledgeRouter({service: {project: async () => ({knowledgeContext: '', memoryReason: 'x'}), saveIdentity: null, isCurrent: () => false}, now: () => 1_800_000_000_000});
  const world = {worldToken: 'lua-world-1', generation: 1};
  const key = entity => router.configFor('resident-female', 'private', {entity, ...world})?.sessionKey;
  assert.ok(key('10009597ULL'));
  assert.notEqual(key('10009597ULL'), key('11146316ULL'));
  assert.equal(key('10009597ULL'), key('10009597ULL'));
  assert.equal(router.configFor('resident-female', 'private', world), null, 'no entity, no route');
});

// ---- The carried mood --------------------------------------------------------------------------------------------------------

test('the carried mood belongs to the person: one stranger\'s sadness is not carried into the next stranger of the same profile', () => {
  const now = 1_000_000;
  const selection = new EmotionSelection({now: () => now});
  const first = {profileKey: 'resident-female', entity: '10009597ULL'}, second = {profileKey: 'resident-female', entity: '11146316ULL'};
  const plan = selection.plan({player: 'Do you miss anyone?', reply: 'Every day. It still hurts.', profile: first.profileKey, who: personKey(first)});
  assert.equal(plan.summary.family, 'sadness');
  selection.remember(personKey(first), plan);
  assert.equal(selection.previous(personKey(first)).family, 'sadness', 'the same stranger carries its mood');
  assert.equal(selection.previous(personKey(second)), undefined, 'the next stranger starts calm');
  // The planner of a growing stream reads the same key.
  const calm = selection.planner({player: 'Hi', profile: second.profileKey, who: personKey(second)})('Meet me at nine.');
  assert.ok(!(calm.evidence ?? []).some(item => String(item).startsWith('previous:')), 'no carried mood in the second stranger\'s plan: ' + JSON.stringify(calm.evidence));
  const same = selection.planner({player: 'Hi', profile: first.profileKey, who: personKey(first)})('Meet me at nine.');
  assert.ok((same.evidence ?? []).some(item => String(item).startsWith('previous:')), 'the first stranger still carries it: ' + JSON.stringify(same.evidence));
  // Without `who` a caller keeps the old per-profile key.
  selection.remember('judy-alvarez', selection.plan({player: 'Miss her?', reply: 'Every day. It still hurts.', profile: 'judy-alvarez'}));
  assert.equal(selection.previous('judy-alvarez').family, 'sadness');
});

test('the bridge keys the carried mood by person on every call and hands the log line its entity', () => {
  assert.doesNotMatch(bridgeSource, /emotionSelection\.remember\(input\.profileKey/);
  assert.equal((bridgeSource.match(/emotionSelection\.remember\(personKey\(input\), plan\)/g) ?? []).length, 3);
  assert.match(bridgeSource, /emotionSelection\.plan\(\{player, reply: result\.text, profile: input\.profileKey, who: personKey\(input\)/);
  assert.match(bridgeSource, /emotionSelection\.planner\(\{player, profile: input\.profileKey, who: personKey\(input\)/);
  assert.match(bridgeSource, /ambientKey: route\?\.sessionKey \?\? `\$\{input\.profileKey\}:\$\{input\.entity \?\? ''\}`, entity: input\.entity/);
});

// ---- The in-game lines a stranger heard --------------------------------------------------------------------------------------

test('an archetype stranger hears only what its own body said in the game, never what another body of the same archetype said', () => {
  let serial = 0;
  const line = (age, fields) => ({id: `c-${++serial}`, age, kind: 'line', channel: 'scene', speaker: 'npc', ...fields});
  const lines = [line(40, {entity: '79ULL', profileKey: 'npc-street-resident-male', name: 'Pedestrian', text: 'Spare some eddies?'}),
    line(38, {speaker: 'v', text: 'No.'})];
  const turn = (entity, extra = {}) => ({requestId: `100-1-${entity}`, generation: 1, entity, profileKey: 'npc-street-resident-male', name: 'Pedestrian', bodyType: 'x',
    text: 'Hey', gameDialogue: {version: 1, status: 'ready', lines}, ...extra});
  assert.deepEqual(selectGameDialogue(turn('80ULL')).map(row => row.text), [], 'a second pedestrian of the same archetype heard nothing');
  assert.deepEqual(selectGameDialogue(turn('79ULL')).map(row => row.text), ['Spare some eddies?', 'No.'], 'the body that said it still hears it');
  // A named character in the same scene is still matched by its profile.
  const named = [line(30, {entity: '11ULL', profileKey: 'judy-alvarez', name: 'Judy', text: 'Took you long enough.'})];
  assert.deepEqual(selectGameDialogue(turn('11ULL', {profileKey: 'judy-alvarez', gameDialogue: {version: 1, status: 'ready', lines: named}})).map(row => row.text), ['Took you long enough.']);
});

// ---- "Already told" -------------------------------------------------------------------------------------------------------------

test('what a conversation was already told is kept per person: a new stranger is told again', () => {
  const memory = new SceneryMemory({now: () => 1_000});
  const decide = (entity, id) => memory.decide({key: `talk|resident-female|${entity}`, id, weather: 'rain', part: 'night', text: 'hi'});
  assert.equal(decide('10009597ULL', 'a-1').time, true);
  assert.equal(decide('10009597ULL', 'a-2').time, false, 'the same stranger was told');
  assert.equal(decide('11146316ULL', 'b-1').time, true, 'the next stranger is told');
  assert.match(readFileSync(new URL('./turn-context.mjs', import.meta.url), 'utf8'), /key: `\$\{input\.channel === 'phone' \? 'phone' : 'talk'\}\|\$\{input\.profileKey\}\|\$\{input\.entity \?\? ''\}`/);
});
