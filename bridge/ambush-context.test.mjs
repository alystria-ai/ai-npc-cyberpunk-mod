// Revenge ambushes: the strict parser, the trigger and the pipeline of a squad member's taunt (bridge/ambush-context.mjs). Pure.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseInput, archetypeContext, isAmbientProfile} from './protocol.mjs';
import {parseAmbushReaction, ambushTrigger, AMBUSH_GROUPS, AMBUSH_WORDS} from './ambush-context.mjs';
import {parseSpeakUpReaction} from './speakup-context.mjs';
import {battleTrigger, battleContext, reactionLeaseProblem} from './battle-context.mjs';
import {conversationContextBlocks} from './quest-context.mjs';
import {describeTurnContext} from './turn-context.mjs';
import {reputationApplies} from './reputation.mjs';

const NOW = 4_000_000_000_000;
const good = {kind: 'ambush', event: 'taunt', group: 'maelstrom', count: 4, toll: 'many', expiresAt: NOW};
let serial = 500;
function request(profileKey = 'npc-maelstrom-male', extra = {}, reaction = good) {
  const generation = ++serial, entity = `${2000 + serial}ULL`;
  return {requestId: `${NOW}-${generation}-${entity}`, generation, entity, name: 'Maelstrom ganger', bodyType: 'ManBig', profileKey, text: 'An ambush begins.',
    archetype: {base: 'maelstrom', category: 'gang', title: 'Maelstrom ganger', district: 'Watson'}, reaction, ...extra};
}
const parse = raw => parseInput(JSON.stringify(raw));
const words = text => text.trim().split(/\s+/).length;

test('the gang list is the eleven gang bases of the archetype catalog', async () => {
  const {readFile} = await import('node:fs/promises');
  const catalog = JSON.parse(await readFile(new URL('../characters/archetypes.json', import.meta.url), 'utf8'));
  for (const group of AMBUSH_GROUPS) assert.equal(catalog.bases[group]?.category, 'gang', group);
  assert.equal(AMBUSH_GROUPS.length, 11);
  assert.equal(AMBUSH_WORDS, 12);
});

test('parseAmbushReaction: a squad taunt of the gang\'s own ordinary NPC, small ints, few or many, a positive expiry', () => {
  assert.deepEqual(parseAmbushReaction(good, 'npc-maelstrom-male'), {...good, maxWords: 12});
  assert.deepEqual(parseAmbushReaction({...good, group: 'tyger-claws', count: 1, toll: 'few', extra: 'x'}, 'npc-tyger-claws-female'),
    {kind: 'ambush', event: 'taunt', group: 'tyger-claws', count: 1, toll: 'few', expiresAt: NOW, maxWords: 12}, 'unknown keys are dropped');
  for (const group of AMBUSH_GROUPS) {
    for (const sex of ['male', 'female']) assert.ok(parseAmbushReaction({...good, group}, `npc-${group}-${sex}`), `${group} ${sex}`);
  }
  assert.ok(parseAmbushReaction({...good, count: 8}, 'npc-maelstrom-male'));
  // The archetype facts, when sent, agree with the group.
  assert.ok(parseAmbushReaction(good, 'npc-maelstrom-male', {base: 'maelstrom', title: 'Maelstrom ganger'}));
  assert.ok(parseAmbushReaction(good, 'npc-maelstrom-male', null));
  assert.equal(parseAmbushReaction(good, 'npc-maelstrom-male', {base: 'valentinos'}), null);
  assert.equal(parseAmbushReaction(good, 'npc-maelstrom-male', 'maelstrom'), null);
});

test('parseAmbushReaction: every other shape is refused', () => {
  for (const bad of [undefined, null, 'ambush', 5, [], {...good, kind: 'speakup'}, {...good, kind: 'battle'}, {...good, kind: undefined}, {...good, event: 'start'}, {...good, event: 'Taunt'},
    {...good, event: undefined}, {...good, group: 'ncpd'}, {...good, group: 'Maelstrom'}, {...good, group: 'arasaka'}, {...good, group: undefined}, {...good, group: ['maelstrom']},
    {...good, count: 0}, {...good, count: 9}, {...good, count: -1}, {...good, count: 2.5}, {...good, count: '4'}, {...good, count: NaN}, {...good, count: Infinity}, {...good, count: undefined},
    {...good, toll: 'some'}, {...good, toll: 'Many'}, {...good, toll: 12}, {...good, toll: undefined},
    {...good, expiresAt: 0}, {...good, expiresAt: -1}, {...good, expiresAt: 1.5}, {...good, expiresAt: '5'}, {...good, expiresAt: Infinity}, {...good, expiresAt: NaN},
    {...good, expiresAt: 2 ** 60}, {...good, expiresAt: undefined}]) {
    assert.equal(parseAmbushReaction(bad, 'npc-maelstrom-male'), null, JSON.stringify(bad));
  }
  // The speaker: an ordinary NPC whose gang is the group, and nothing else.
  for (const key of ['npc-valentinos-male', 'npc-maelstrom', 'npc-maelstrom-', 'npc-maelstrom-robot', 'npc-maelstrom-male-2', 'npc-maelstromx-male', 'npc-ripperdoc-female', 'resident-male', 'resident-female',
    'judy-alvarez', 'maelstrom-male', 'NPC-maelstrom-male', 'npc_maelstrom_male', '', 'x'.repeat(81), undefined, null, 5, {}]) {
    assert.equal(parseAmbushReaction(good, key), null, String(key));
  }
  assert.equal(parseAmbushReaction({...good, group: 'tyger-claws'}, 'npc-maelstrom-male'), null, 'a squad of another gang');
  assert.equal(parseAmbushReaction({...good, group: 'mox'}, 'npc-tyger-claws-male'), null);
});

test('ambushTrigger: the moment, the gang by its plain name, no number of kills, at most twelve words, a statement, only the spoken line', () => {
  const names = {maelstrom: 'Maelstrom', 'tyger-claws': 'Tyger Claws', valentinos: 'Valentinos', 'sixth-street': '6th Street', animals: 'Animals', 'voodoo-boys': 'Voodoo Boys',
    scavengers: 'Scavengers', wraiths: 'Wraiths', mox: 'Mox', aldecaldos: 'Aldecaldos', barghest: 'Barghest'};
  for (const group of AMBUSH_GROUPS) {
    const trigger = ambushTrigger(parse(request(`npc-${group}-female`, {archetype: {base: group}}, {...good, group})));
    assert.ok(trigger.includes(names[group]), group);
    assert.doesNotMatch(trigger, /sixth-street|tyger-claws|voodoo-boys/, 'plain names, not keys');
  }
  const many = ambushTrigger(parse(request()));
  assert.match(many, /not spoken by V/); assert.match(many, /one of 4 members of Maelstrom/); assert.match(many, /killing/); assert.match(many, /furious/);
  assert.match(many, /ONE short threat or taunt/); assert.match(many, /no more than 12 words/); assert.match(many, /voice and attitude/);
  assert.match(many, /Never state or guess how many of your people V has killed/);
  assert.match(many, /Do not invent names, places, past events, weapons or injuries/);
  assert.match(many, /A statement, not a question/); assert.match(many, /without narration, stage directions or actions/);
  assert.doesNotMatch(many, /\?/, 'the trigger does not ask anything itself');
  assert.doesNotMatch(many, /\b(kills|killed)\b[^.]*\d|\d[^.]*\b(kills|killed)\b/, 'no count of kills');
  const few = ambushTrigger(parse(request('npc-maelstrom-male', {}, {...good, toll: 'few', count: 1})));
  assert.match(few, /small squad of Maelstrom/); assert.match(few, /some of your people/); assert.doesNotMatch(few, /furious/);
  assert.equal(words('Come here, V!'), 3);
  for (const bad of [undefined, {}, {reaction: {kind: 'speakup', event: 'calm'}}, {reaction: {...good, event: 'x'}}, {reaction: {...good, group: 'ncpd'}}, {reaction: {...good, toll: 'lots'}},
    {reaction: {...good, count: 0}}, {reaction: {...good, count: 99}}]) assert.throws(() => ambushTrigger(bad), /Invalid ambush trigger/);
});

test('parseInput: a full ambush request keeps its reaction and the archetype facts; a misplaced or malformed reaction refuses the whole turn', () => {
  const input = parse(request());
  assert.deepEqual(input.reaction, {...good, maxWords: 12});
  assert.equal(input.archetype.base, 'maelstrom'); assert.equal(input.profileKey, 'npc-maelstrom-male');
  assert.equal(input.group, undefined); assert.equal(input.battle, undefined); assert.equal(input.loot, undefined); assert.equal(input.head, undefined);
  assert.ok(parse(request('npc-voodoo-boys-female', {archetype: undefined}, {...good, group: 'voodoo-boys'})), 'the archetype field is optional here');
  const refused = {
    'a bad event': request('npc-maelstrom-male', {}, {...good, event: 'start'}),
    'a bad group': request('npc-maelstrom-male', {}, {...good, group: 'ncpd'}),
    'another gang\'s speaker': request('npc-valentinos-male'),
    'a named character': request('judy-alvarez'),
    'a resident': request('resident-male'),
    'an archetype of another base': request('npc-maelstrom-male', {archetype: {base: 'valentinos', title: 'Valentinos ganger'}}),
    'no expiry': request('npc-maelstrom-male', {}, {...good, expiresAt: undefined}),
    'a group round': request('npc-maelstrom-male', {group: {id: 'g', index: 1, total: 2, audience: ['npc-maelstrom-male', 'npc-maelstrom-female'], heard: []}}),
    'a battle field': request('npc-maelstrom-male', {battle: {version: 1, status: 'none'}}),
    'a loot field': request('npc-maelstrom-male', {loot: {version: 1, batch: 'loot-1', status: 'ready', items: []}}),
    'a head field': request('npc-maelstrom-male', {head: {version: 1, stage: 'friends', milestones: []}}),
    'a holocall field': request('npc-maelstrom-male', {holocall: {version: 1, contact: 'Judy', mode: 'audio'}}),
    'an add-on speaker': request('npc-maelstrom-male', {addon: {version: 1, id: 'skippy', speaker: 'skippy', event: 'hello', facts: {}}}),
  };
  for (const [what, raw] of Object.entries(refused)) assert.equal(parse(raw), null, what);
});

test('battleTrigger and battleContext: the ambush trigger is the taunt\'s, and no combat block is added', () => {
  const input = parse(request());
  assert.equal(battleTrigger(input), ambushTrigger(input));
  assert.equal(battleContext(input), '');
  assert.equal(battleContext({...input, battle: {version: 1, status: 'fighting', encounter: 'battle-1', ageSeconds: 3, durationSeconds: 3, opponents: [{name: 'V', count: 1}], witnesses: []}}), '');
  assert.throws(() => battleTrigger({...input, reaction: {...input.reaction, group: 'ncpd'}}), /Invalid ambush trigger/);
});

test('the pipeline treats it as an automatic reaction: no V text in the block, no right-now block, no reputation, the lease works', () => {
  const input = parse(request('npc-maelstrom-male', {turnContext: {version: 1, status: 'ready', hour: 2, minute: 10, district: 'Watson', weather: 'rain'}}));
  // The person's own block still comes from the archetype facts: an ordinary NPC with a reaction keeps it.
  assert.equal(isAmbientProfile(input.profileKey), true);
  const person = archetypeContext(input);
  assert.match(person, /^CURRENT PERSON/); assert.match(person, /unnamed Maelstrom ganger/); assert.match(person, /Watson/);
  // No right-now block for an automatic reaction other than a speak-up; no combat block.
  assert.equal(describeTurnContext(input, {ambient: true}).reason, 'automatic reaction');
  const blocks = conversationContextBlocks(input);
  assert.ok(Array.isArray(blocks));
  assert.ok(!blocks.some(block => /Verified combat observations|No recent combat/.test(block.text ?? '')));
  // Street reputation never applies to a turn with a reaction.
  assert.equal(reputationApplies(input), false);
  // The reaction lease and its deadline are the generic ones.
  const lease = {requestId: input.requestId, valid: true, updated: NOW - 1000};
  assert.equal(reactionLeaseProblem(input, lease, NOW - 500), null);
  assert.match(reactionLeaseProblem(input, lease, NOW + 60000), /not refreshed|deadline/);
  assert.match(reactionLeaseProblem(input, {...lease, valid: false}, NOW - 500), /withdrawn/);
  assert.match(reactionLeaseProblem(input, {...lease, requestId: 'x'}, NOW - 500), /another request/);
});

test('a companion\'s speak-up still refuses an ordinary NPC', () => {
  const speak = {kind: 'speakup', event: 'calm', facts: {}, expiresAt: NOW};
  for (const key of ['npc-maelstrom-male', 'npc-maelstrom-female', 'resident-male']) assert.equal(parseSpeakUpReaction(speak, key), null, key);
  assert.equal(parse(request('npc-maelstrom-male', {}, speak)), null);
});
