// Fresh facts (docs/FRESH_FACTS.md): what changed or what V asks about, said as plain facts at both ends of a text provider's prompt, with the history lines that say the old
// fact left out. Live 2026-10-27 (game 2.31, Local AI lite): V stripped, the game read it, the prompt said so, and Alex still answered "in that suit"; V asked "am i drunk" with
// Flesh and Chrome at stage 3 and Claire answered "Not drunk, just wired".
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseInput} from './protocol.mjs';
import {conversationContext, conversationContextBlocks} from './quest-context.mjs';
import {gearFresh, gearSeen} from './player-gear.mjs';
import {GearMemory, gearMemory} from './gear-memory.mjs';
import {sceneryMemory} from './scenery-memory.mjs';
import {dynamicInfo} from './dynamic-info.mjs';
import {PersonaBook, buildMessages, joinBlocks, worldBlocksInCacheOrder, freshParts} from './mistral-prompt.mjs';
import {defaultProfile} from './prompt-profiles.mjs';
import {freshBlock, headLine, tailLine, staleTest, nameWords, wordPattern} from './fresh-facts.mjs';

dynamicInfo.update({dynamicInfo: {mods: true}});
const clothes = rows => rows.map(([slot, name]) => ({slot, name}));
const suited = () => ({version: 1, status: 'ready', clothing: clothes([['face', "Johnny's aviators"], ['outfit', "Aguilar's suit"]]),
  weapons: [{slot: 'hand', name: 'Malorian Arms 3516'}], cyberware: [{slot: 'eyes', name: 'Kiroshi Optics'}]});
const naked = () => ({...suited(), clothing: clothes([['face', "Johnny's aviators"]]), nudity: 'nude'});
const bare = () => ({...suited(), clothing: undefined, nudity: 'nude'});
const topless = () => ({...suited(), clothing: clothes([['legs', "Johnny's pants"], ['feet', "Johnny's shoes"]]), nudity: 'topless'});
let serial = 0;
const SNAPSHOT = {version: 1, status: 'ready', hour: 22, minute: 10, district: 'Watson', gender: 'female'};
const turn = (gear, extra = {}) => {
  const entity = extra.entity ?? '21ULL';
  return parseInput(JSON.stringify({requestId: `${300 + ++serial}-1-${entity}`, generation: 1, entity, profileKey: 'alex', name: 'Alex', bodyType: 'WomanAverage',
    text: 'What am I wearing?', gear, turnContext: SNAPSHOT, ...extra}));
};
const partsOf = blocks => {
  const world = worldBlocksInCacheOrder(blocks.filter(item => item.tier === 'world'));
  return {...Object.fromEntries(['now', 'notes', 'volatile'].map(tier => [tier, joinBlocks(blocks.filter(item => item.tier === tier).map(item => item.text))])),
    world: joinBlocks(world.map(item => item.text)), worldBlocks: world.filter(item => item.text).map(item => ({key: item.key, text: item.text})), ...freshParts(blocks)};
};
const persona = new PersonaBook([]).persona('alex', 'Alex');
const HISTORY = [{v: 'How is the night?', r: 'Quiet. I will take quiet.'}, {v: 'What am I wearing?', r: "That's Aguilar's suit, right? You're standing there in it like it's armor."}];
const messagesOf = (input, {history = HISTORY, profile, reaction = false} = {}) => {
  const blocks = conversationContextBlocks(input);
  return buildMessages({persona, history, context: joinBlocks(blocks.map(item => item.text)), contextParts: partsOf(blocks), text: input.text, reaction, ...(profile ? {profile} : {})});
};
const freshOf = input => conversationContextBlocks(input).find(block => block.tier === 'fresh');

test.beforeEach(() => { gearMemory.clear(); sceneryMemory.clear(); });

test('the live sequence: the suit was told, V is now naked: both ends of the prompt say it, the suit line of the history is not sent', () => {
  const first = turn(suited());
  assert.equal(freshOf(first).text, '', 'the first turn of a conversation has nothing to compare with');
  gearSeen(first, gearMemory);
  const second = turn(naked(), {text: 'What am I wearing now?'});
  const block = freshOf(second);
  assert.equal(block.facts, "V is completely naked, only Johnny's aviators on. V is not wearing Aguilar's suit anymore.");
  assert.equal(block.text, `TRUE RIGHT NOW: ${block.facts}`, 'Convai\'s joined context carries the labelled form');
  assert.match(conversationContext(second), /TRUE RIGHT NOW: V is completely naked/);
  const messages = messagesOf(second);
  assert.ok(messages[0].content.trimEnd().endsWith(`TRUE RIGHT NOW: ${block.facts}`), 'the end of the system message');
  const last = messages.at(-1).content;
  assert.ok(last.includes(`${tailLine(block.facts)}\n\nV says: What am I wearing now?`), 'right before V\'s words');
  assert.deepEqual(messages.slice(1, -1).map(row => row.role), ['user', 'assistant'], 'the exchange that says the suit is not sent');
  assert.doesNotMatch(messages.slice(1, -1).map(row => row.content).join(' '), /suit|armor/);
  assert.ok(HISTORY.some(turn => /suit/.test(turn.r)), 'the character\'s memory is untouched');
  assert.doesNotMatch(partsOf(conversationContextBlocks(second)).volatile, /TRUE RIGHT NOW|RIGHT NOW, TRUE/, 'not twice in the volatile notes');
});

test('nothing at all on, topless, dressed in other things, and the facts-only rule', () => {
  gearSeen(turn(suited()), gearMemory);
  assert.equal(freshOf(turn(bare())).facts, "V is completely naked. V is not wearing Johnny's aviators or Aguilar's suit anymore.");
  gearMemory.clear(); gearSeen(turn(suited()), gearMemory);
  assert.equal(freshOf(turn(topless())).facts, "V is topless, with Johnny's pants and Johnny's shoes on. V is not wearing Johnny's aviators or Aguilar's suit anymore.");
  gearMemory.clear(); gearSeen(turn(naked()), gearMemory);
  assert.equal(freshOf(turn(suited())).facts, "V is wearing Johnny's aviators and Aguilar's suit.");
  for (const gear of [naked(), bare(), topless()]) {
    gearMemory.clear(); gearSeen(turn(suited()), gearMemory);
    assert.doesNotMatch(freshOf(turn(gear)).facts, /\b(?:don't|do not|never|must|should|react)\b/i, 'facts only: no instruction on how to react');
  }
});

test('the stale-reply pattern: the removed names and the clothing words that are not worn now', () => {
  gearSeen(turn(suited()), gearMemory);
  const {drop} = freshOf(turn(naked()));
  const stale = staleTest(drop);
  for (const reply of ["That's Aguilar's suit, right?", 'Nice jacket.', 'a dark shirt', 'your outfit', 'Suits you.']) assert.ok(stale(reply), reply);
  for (const reply of ['Quiet. I will take quiet.', 'Those aviators suit nobody.'].slice(0, 1)) assert.ok(!stale(reply), reply);
  assert.ok(!stale('Nice aviators.'), 'a worn item is not stale');
  // Dressed in a jacket now: a reply about the jacket is still true.
  gearMemory.clear(); gearSeen(turn({...suited(), clothing: clothes([['outerTorso', 'Samurai jacket']])}), gearMemory);
  const shirt = freshOf(turn({...suited(), clothing: clothes([['outerTorso', 'Samurai jacket'], ['innerTorso', 'Black shirt']])}));
  assert.equal(shirt.facts, 'V is wearing Samurai jacket and Black shirt.');
  assert.ok(!staleTest(shirt.drop)('Nice jacket.'));
});

test('a turn later (nothing changed) while V is bare: asked about clothes or themself, the fact and the drop come again; other talk gets none', () => {
  const first = turn(suited());
  gearSeen(first, gearMemory);
  const second = turn(naked());
  gearSeen(second, gearMemory);
  const history = [...HISTORY, {v: 'I took it all off, what am I wearing now?', r: "You're still standing there in that suit, the one that's seen too many fights."}];
  const asked = turn(naked(), {text: 'what am i wearing?'});
  assert.equal(freshOf(asked).facts, "V is completely naked, only Johnny's aviators on.");
  const messages = messagesOf(asked, {history});
  assert.deepEqual(messages.slice(1, -1).map(row => row.role), ['user', 'assistant'], 'both suit exchanges are left out');
  assert.ok(messages.at(-1).content.includes('[RIGHT NOW, TRUE: V is completely naked'));
  assert.equal(freshOf(turn(naked(), {text: 'how do i look?'})).facts, "V is completely naked, only Johnny's aviators on.");
  const chat = turn(naked(), {text: 'Tell me about your day.'});
  assert.equal(freshOf(chat).text, '');
  assert.equal(messagesOf(chat, {history}).length, 2 + history.length * 2, 'no fresh: the history is sent as it is');
  assert.doesNotMatch(messagesOf(chat, {history})[0].content, /TRUE RIGHT NOW/);
  // Dressed and asked about clothes, nothing changed: the gear line says it, nothing is added.
  gearMemory.clear(); gearSeen(turn(suited()), gearMemory);
  assert.equal(freshOf(turn(suited(), {text: 'what am i wearing?'})).text, '');
});

test('the weapon in hand, the equipped weapons and the cyberware, stated the same way', () => {
  gearSeen(turn(suited()), gearMemory);
  assert.equal(freshOf(turn({...suited(), weapons: []})).facts, 'V holds no weapon now. V is not holding Malorian Arms 3516 anymore.');
  gearSeen(turn({...suited(), weapons: []}), gearMemory);
  assert.equal(freshOf(turn({...suited(), weapons: [{slot: 'hand', name: 'Erebus'}]})).facts, 'V now holds Erebus.');
  gearSeen(turn({...suited(), weapons: [{slot: 'hand', name: 'Erebus'}]}), gearMemory);
  assert.equal(freshOf(turn({...suited(), weapons: [{slot: 'hand', name: 'Erebus'}, {slot: 'slot1', name: 'Kyubi'}]})).facts, "V's equipped weapons are now Kyubi.");
  gearSeen(turn({...suited(), weapons: [{slot: 'hand', name: 'Erebus'}, {slot: 'slot1', name: 'Kyubi'}]}), gearMemory);
  const cyber = freshOf(turn({...suited(), weapons: [{slot: 'hand', name: 'Erebus'}, {slot: 'slot1', name: 'Kyubi'}], cyberware: [{slot: 'eyes', name: 'Kiroshi Optics'}, {slot: 'arms', name: 'Gorilla Arms'}]}));
  assert.equal(cyber.facts, "V's cyberware is now Kiroshi Optics and Gorilla Arms.");
  assert.equal(cyber.drop, '', 'only clothes drop history lines');
});

test('a stranger is told what a stranger sees; a reaction, no gear and a gear switch that is off add nothing', () => {
  const vendor = {profileKey: 'npc-food-vendor', entity: '31ULL', name: 'Vendor'};
  gearSeen(turn(suited(), vendor), gearMemory, {visible: true});
  assert.equal(freshOf(turn(naked(), vendor)).facts, "V is completely naked, only Johnny's aviators on. V is not wearing Aguilar's suit anymore.");
  gearSeen(turn(suited()), gearMemory);
  assert.equal(freshOf({...turn(naked()), reaction: {kind: 'battle'}}).text, '');
  assert.equal(freshOf(turn(undefined)).text, '');
  dynamicInfo.update({dynamicInfo: {mods: true, gear: false}});
  try { assert.equal(freshOf(turn(naked())).text, ''); } finally { dynamicInfo.update({dynamicInfo: {mods: true, gear: true}}); }
  assert.equal(gearFresh(turn(naked()), null).text, '');
  assert.equal(freshOf({...turn(naked()), reaction: {kind: 'battle'}}).drop, '');
  const reaction = messagesOf({...turn(naked()), reaction: {kind: 'battle'}}, {reaction: true});
  assert.doesNotMatch(JSON.stringify(reaction), /TRUE RIGHT NOW|RIGHT NOW, TRUE/);
});

const drinking = (text, drinks = 3, extra = {}) => turn(undefined, {profileKey: 'claire-russell', name: 'Claire Russell', entity: '41ULL', text,
  turnContext: {...SNAPSHOT, mods: {fleshAndChrome: {drinks}}, facRead: `installed=yes read=ok state=breath0,energy0,drinks${drinks},smoke0`}, ...extra});

test('drinks: "am i drunk" is a question about themself; stage 3 is told as drunk, in plain words, at both ends', () => {
  const input = drinking('am i drunk?');
  const block = freshOf(input);
  assert.equal(block.facts, 'V is drunk: slurring, unsteady on their feet, reeking of booze.');
  const messages = messagesOf(input, {history: [{v: 'Another round', r: 'Coming up.'}]});
  assert.ok(messages[0].content.trimEnd().endsWith('TRUE RIGHT NOW: V is drunk: slurring, unsteady on their feet, reeking of booze.'));
  assert.ok(messages.at(-1).content.includes('[RIGHT NOW, TRUE: V is drunk: slurring, unsteady on their feet, reeking of booze.]\n\nV says: am i drunk?'));
  assert.equal(messages.length, 4, 'the history is sent as it is');
  assert.equal(freshOf(drinking('do i seem drunk?', 2)).facts, 'V is tipsy: loose, a little loud, smelling of booze.');
  assert.equal(freshOf(drinking('am i sober?')).facts, block.facts);
  assert.doesNotMatch(block.facts, /\b(?:don't|do not|never|must|should)\b/i);
});

test('drinks: not asked, no fresh line (the Background line says it once, as before); nothing wrong, nothing said', () => {
  assert.equal(freshOf(drinking('Another round, please.')).text, '');
  assert.equal(freshOf(drinking('am i drunk?', 1)).facts, 'V has had a drink or two.');
  assert.equal(freshOf(turn(undefined, {profileKey: 'claire-russell', name: 'Claire Russell', text: 'am i drunk?', turnContext: {...SNAPSHOT, mods: {fleshAndChrome: {smoke: 1}}}})).facts, 'V has just had a cigarette.');
  assert.equal(freshOf(turn(undefined, {profileKey: 'claire-russell', name: 'Claire Russell', text: 'am i drunk?', turnContext: SNAPSHOT})).text, '');
});

test('a profile that puts the turn\'s notes after V\'s line gets the fresh line last before the closing', () => {
  gearSeen(turn(suited()), gearMemory);
  const input = turn(naked(), {text: 'What am I wearing now?'});
  const profile = defaultProfile('local-standard');
  assert.equal(profile.layout.volatile, 'after');
  const last = messagesOf(input, {profile}).at(-1).content;
  assert.ok(last.indexOf('V says: What am I wearing now?') < last.indexOf('[RIGHT NOW, TRUE:'));
  assert.ok(last.indexOf('[RIGHT NOW, TRUE:') < last.indexOf('(Reply as'));
});

test('no fresh facts: the prompt has none of it, byte for byte what it was', () => {
  const input = turn(suited());
  const blocks = conversationContextBlocks(input);
  assert.deepEqual(freshParts(blocks), {});
  const plain = buildMessages({persona, history: HISTORY, context: 'x', contextParts: partsOf(blocks), text: 'hi'});
  assert.doesNotMatch(JSON.stringify(plain), /TRUE RIGHT NOW|RIGHT NOW, TRUE/);
  assert.equal(plain.length, 2 + HISTORY.length * 2 - 0, 'every exchange is sent');
});

test('fresh-facts helpers', () => {
  assert.deepEqual(freshBlock([]), {tier: 'fresh', text: '', facts: '', drop: ''});
  assert.deepEqual(freshBlock([null, {text: ''}]), {tier: 'fresh', text: '', facts: '', drop: ''});
  const joined = freshBlock([{text: 'A.', drop: '\\bfoo'}, null, {text: 'B.', drop: '\\bbar'}]);
  assert.equal(joined.facts, 'A. B.');
  assert.equal(joined.drop, '\\bfoo|\\bbar');
  assert.equal(headLine('A.'), 'TRUE RIGHT NOW: A.');
  assert.equal(tailLine('A.'), '[RIGHT NOW, TRUE: A.]');
  assert.equal(staleTest(''), null);
  assert.equal(staleTest('(('), null, 'a broken pattern is no pattern');
  assert.equal(staleTest('x'.repeat(5000)), null);
  assert.deepEqual(nameWords(["Aguilar's suit", 'Replica of Johnny\'s Samurai jacket'], ['Samurai jacket']), ['aguilar', 'suit', 'johnny']);
  assert.equal(wordPattern([]), '');
  assert.equal(wordPattern(['a.b']), '\\b(?:a\\.b)');
  assert.deepEqual(freshParts([{tier: 'fresh', text: '', facts: ''}]), {});
});

test('the memory class is the one the bridge uses: a fresh line is never told twice for one change', () => {
  const memory = new GearMemory();
  const a = turn(suited());
  gearSeen(a, memory);
  const b = turn(naked());
  assert.ok(gearFresh(b, memory).text);
  assert.ok(gearFresh(b, memory).text, 'the several builds of one turn agree');
  gearSeen(b, memory);
  assert.equal(gearFresh(turn(naked(), {text: 'Tell me a story'}), memory).text, '');
});
