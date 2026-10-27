// Live 2026-10-27 (game 2.31, Local AI + Pocket): V put Aguilar's suit in the Wardrobe Outfit slot and asked Alex what V wears ("Aguilar's, right?"), took it off, stripped, and
// asked again: "You're wearing nothing but that suit". The game read the change (nudity=nude reached the bridge), but the earlier answer sat in the history right above V's
// words and outweighed the gear line far above it. A turn now also says, in its own notes, what changed since the character last saw V and that it replaces what was true.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseInput} from './protocol.mjs';
import {conversationContext, conversationContextBlocks} from './quest-context.mjs';
import {gearContext, gearDiagnostic, gearChange, gearSeen, gearFacts} from './player-gear.mjs';
import {GearMemory, gearMemory} from './gear-memory.mjs';
import {PersonaBook, buildMessages, joinBlocks, worldBlocksInCacheOrder} from './mistral-prompt.mjs';

const clothes = (...rows) => rows.map(([slot, name]) => ({slot, name}));
const suited = () => ({version: 1, status: 'ready', clothing: clothes(['face', "Johnny's aviators"], ['outfit', "Aguilar's suit"]),
  weapons: [{slot: 'hand', name: 'Malorian Arms 3516'}], cyberware: [{slot: 'eyes', name: 'Kiroshi Optics'}]});
const naked = () => ({version: 1, status: 'ready', clothing: clothes(['face', "Johnny's aviators"]),
  weapons: [{slot: 'hand', name: 'Malorian Arms 3516'}], cyberware: [{slot: 'eyes', name: 'Kiroshi Optics'}], nudity: 'nude'});
const bare = () => ({version: 1, status: 'ready', cyberware: [{slot: 'eyes', name: 'Kiroshi Optics'}], nudity: 'nude'});
let serial = 0;
const turn = (gear, extra = {}) => {
  const entity = extra.entity ?? '11ULL';
  return parseInput(JSON.stringify({requestId: `${100 + ++serial}-1-${entity}`, generation: 1, entity, profileKey: 'alex', name: 'Alex',
    bodyType: 'WomanAverage', text: 'What am I wearing?', gear, ...extra}));
};
const volatileOf = input => conversationContextBlocks(input).filter(block => block.tier === 'volatile').map(block => block.text);
const note = input => volatileOf(input).find(text => text?.startsWith('Changed since you last saw V')) ?? '';

test.beforeEach(() => gearMemory.clear());

test('the live sequence: suit worn, answered, then nude: the next turn states the new fact and what it replaces, and the suit is not current', () => {
  const first = turn(suited());
  assert.equal(note(first), '', 'the first turn of a conversation has nothing to compare with');
  assert.match(gearContext(first), /outfit: Aguilar's suit/);
  gearSeen(first, gearMemory);   // the reply was published

  const second = turn(naked());
  const text = note(second);
  assert.match(text, /^Changed since you last saw V, and true right now \(this replaces anything said or described earlier in this talk about it\): /);
  assert.match(text, /right now V is wearing face: Johnny's aviators, everywhere else: nothing on; earlier V wore face: Johnny's aviators, outfit: Aguilar's suit\./);
  assert.doesNotMatch(text, /weapon|cyberware/, 'only what changed is told');
  assert.doesNotMatch(gearContext(second).split('weapon in hand')[0], /Aguilar/, 'the gear line no longer lists the suit');
  assert.match(gearContext(second), /everywhere else: nothing on/);
  assert.equal(gearDiagnostic(second, {memory: gearMemory}), `Player gear: 4 items, ${gearContext(second).length} chars nudity=nude changed=wearing`);
  // Nothing restricts how she reacts: the note is a statement of facts.
  assert.doesNotMatch(text, /\b(?:don't|do not|never|must not)\b/i);
});

test('nothing at all on: said as "nothing at all", with the earlier outfit named', () => {
  gearSeen(turn(suited()), gearMemory);
  const text = note(turn(bare()));
  assert.match(text, /right now V is wearing nothing at all; earlier V wore face: Johnny's aviators, outfit: Aguilar's suit\./);
});

test("the note reaches the last user message of a text provider, right before V's words, with the old answer still in the history", () => {
  gearSeen(turn(suited()), gearMemory);
  const input = turn(naked());
  const blocks = conversationContextBlocks(input);
  const world = worldBlocksInCacheOrder(blocks.filter(item => item.tier === 'world'));
  const parts = {...Object.fromEntries(['now', 'notes', 'volatile'].map(tier => [tier, joinBlocks(blocks.filter(item => item.tier === tier).map(item => item.text))])),
    world: joinBlocks(world.map(item => item.text)), worldBlocks: world.filter(item => item.text).map(item => ({key: item.key, text: item.text}))};
  const persona = new PersonaBook([]).persona('alex', 'Alex');
  const messages = buildMessages({persona, history: [{v: 'What am I wearing?', r: "You're wearing that suit... Aguilar's, right?"}],
    context: joinBlocks(blocks.map(item => item.text)), contextParts: parts, text: 'And now?'});
  const last = messages.at(-1).content;
  assert.equal(messages.at(-1).role, 'user');
  assert.match(last, /Changed since you last saw V[^]*nothing on[^]*earlier V wore[^]*Aguilar's suit/);
  assert.ok(last.indexOf('Changed since you last saw V') < last.indexOf('V says: And now?'));
  // The system message states the new fact (gear line) and has no suit as current.
  assert.doesNotMatch(messages[0].content.split("V's current gear")[1]?.split('weapon in hand')[0] ?? '', /Aguilar/);
  // The history is untouched: the model sees its old answer, and below it the correction.
  assert.ok(messages.some(row => row.role === 'assistant' && /that suit/.test(row.content)));
});

test('the same turn built again and again says the same thing; only a published reply moves the memory', () => {
  gearSeen(turn(suited()), gearMemory);
  const second = turn(naked());
  const text = note(second);
  assert.ok(text);
  for (let i = 0; i < 4; i++) assert.equal(note(second), text, 'a prepared reply, the look-ahead, the turn and its log line agree');
  // The reply never reached the player (no commit): the retry, with a new turn id, still says what changed.
  assert.equal(note(turn(naked())), text);
  gearSeen(second, gearMemory);
  assert.equal(note(turn(naked())), '', 'told once: the next turn with the same gear has no note');
  assert.equal(note(turn(naked(), {text: 'What am I wearing now?'})), '');
});

test('putting the outfit back on is a change too, and the weapon in hand and the cyberware are covered the same way', () => {
  gearSeen(turn(naked()), gearMemory);
  const dressed = turn(suited());
  assert.match(note(dressed), /right now V is wearing face: Johnny's aviators, outfit: Aguilar's suit; earlier V wore face: Johnny's aviators, everywhere else: nothing on\./);
  gearSeen(dressed, gearMemory);
  const holstered = turn({...suited(), weapons: []});
  assert.match(note(holstered), /V's weapon in hand has changed: right now V holds no weapon; earlier V held Malorian Arms 3516\./);
  assert.doesNotMatch(note(holstered), /clothes/);
  gearSeen(holstered, gearMemory);
  const drawn = turn({...suited(), weapons: [{slot: 'hand', name: 'Erebus'}]});
  assert.match(note(drawn), /right now V holds Erebus; earlier V held none\./);
  gearSeen(drawn, gearMemory);
  const swapped = turn({...suited(), weapons: [{slot: 'hand', name: 'Erebus'}], cyberware: [{slot: 'eyes', name: 'Kiroshi Optics'}, {slot: 'arms', name: 'Gorilla Arms'}]});
  assert.match(note(swapped), /V's cyberware has changed: right now eyes: Kiroshi Optics, arms: Gorilla Arms; earlier eyes: Kiroshi Optics\./);
});

test('the order of the equipped weapons is not a change', () => {
  const a = {...suited(), weapons: [{slot: 'slot1', name: 'Erebus'}, {slot: 'slot2', name: 'Kyubi'}]};
  const b = {...suited(), weapons: [{slot: 'slot1', name: 'Kyubi'}, {slot: 'slot2', name: 'Erebus'}]};
  gearSeen(turn(a), gearMemory);
  assert.equal(note(turn(b)), '');
});

test('each conversation has its own memory; a stranger is compared on what a stranger sees', () => {
  gearSeen(turn(suited()), gearMemory);
  assert.equal(note(turn(naked(), {profileKey: 'judy-alvarez', entity: '12ULL'})), '', 'Judy has not seen V before');
  const vendor = {profileKey: 'npc-food-vendor', entity: '13ULL'};
  gearSeen(turn(suited(), vendor), gearMemory, {visible: true});
  const text = note(turn({...naked(), cyberware: [{slot: 'eyes', name: 'Other Optics'}]}, vendor));
  assert.match(text, /V's clothes have changed/);
  assert.doesNotMatch(text, /cyberware/, 'a stranger cannot see the implants');
});

test("no gear, an automatic reaction and a snapshot that is not ready add nothing and change nothing", () => {
  gearSeen(turn(suited()), gearMemory);
  assert.equal(note(turn(undefined)), '');
  assert.equal(gearFacts({reaction: {kind: 'battle'}, gear: naked()}), null);
  assert.equal(note({...turn(naked()), reaction: {kind: 'battle'}}), '');
  assert.equal(gearChange(turn(naked()), null).text, '');
  gearSeen(turn(undefined), gearMemory);   // a turn with no gear never rewrites what the character last saw
  assert.match(note(turn(naked())), /Aguilar's suit/);
  gearSeen(turn({version: 1, status: 'unavailable'}), gearMemory);
  assert.match(note(turn(naked())), /Aguilar's suit/);
});

test('the note is part of the plain conversation context too (Convai gets the joined blocks)', () => {
  gearSeen(turn(suited()), gearMemory);
  assert.match(conversationContext(turn(naked())), /Changed since you last saw V, and true right now/);
  assert.doesNotMatch(conversationContext(turn(suited())), /Changed since you last saw V/);
});

test('GearMemory: first sight is silent, order is ignored, the least recently used conversation goes first, clear forgets', () => {
  const memory = new GearMemory({limit: 2});
  const facts = items => ({wearing: items, hand: [], carried: [], cyberware: []});
  assert.deepEqual(memory.changes('a', facts(['x'])), []);
  memory.commit('a', facts(['x', 'y']));
  assert.deepEqual(memory.changes('a', facts(['y', 'x'])), []);
  assert.deepEqual(memory.changes('a', facts(['x'])), [{key: 'wearing', now: ['x'], before: ['x', 'y']}]);
  memory.commit('b', facts([])); memory.commit('c', facts([]));
  assert.deepEqual(memory.changes('a', facts(['z'])), [], 'a was the least recently used and is forgotten');
  memory.clear();
  assert.deepEqual(memory.changes('b', facts(['q'])), []);
});

test('the bridge tells the memory only when a reply is published, clears it with the other conversation memory, and logs what changed', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal([...bridge.matchAll(/commitExchange\(input\); gearTold\(\);/g)].length, 2, 'both publish paths');
  assert.match(bridge, /const gearTold = \(\) => \{ try \{ if \(!input\.reaction && !voice && dynamicInfo\.on\('gear'\)\) gearSeen\(input, gearMemory/);
  assert.equal([...bridge.matchAll(/sceneryMemory\.clear\(\); gearMemory\.clear\(\);/g)].length, 4);
  assert.match(bridge, /gearDiagnostic\(input, \{memory: gearMemory, visible: isAmbientProfile\(input\.profileKey\)\}\)/);
  assert.ok(bridge.indexOf('[PlayerGear]') < bridge.indexOf('commitExchange(input); gearTold();'), 'the log line compares against the memory before the commit');
});

test('the Lua reader shares a read only inside a very short window, so a turn after a change sees it', () => {
  const lua = readFileSync(new URL('../mod/player-gear.lua', import.meta.url), 'utf8');
  assert.match(lua, /M\.MAX_AGE, M\.MAX_NAME = 2, 60/);
});
