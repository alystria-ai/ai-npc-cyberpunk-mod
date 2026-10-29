// Consecutive turns of one character share the start of their prompt (docs/LOCAL_AI.md, "Judy's prompt was read again on every turn"), with the quest additions on.
//
// A model that continues a prompt only from a saved checkpoint (the lite and Mature models: Bonsai, Qwen) reuses the whole system message of the last turn and nothing of a prompt that
// differs inside it. The game sends the bond block and the gear with V's own turns, and a reaction (a companion speaking up, a fight line) with neither: before the fix the system message
// of a reaction lacked both blocks, and every change from a talk to a reaction (and back) made the model read the whole prompt again (measured 2026-10-30, Bonsai 2 4B, 3,100 tokens new
// and 0 cached on all five turns of talk, speak-up, talk, speak-up, talk).
//
// The blocks here are the real ones: the context blocks of bridge/quest-context.mjs and the bond line of bridge/bonds.mjs, laid out the way bridge/convai-bridge.mjs `contextPartsOf` does
// (the 'world' blocks in cache order, the other tiers joined), built into messages by bridge/mistral-prompt.mjs. No server is started.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PersonaBook, buildMessages, joinBlocks, worldBlocksInCacheOrder} from './mistral-prompt.mjs';
import {conversationContextBlocks} from './quest-context.mjs';
import {gearMemory} from './gear-memory.mjs';
import {Bonds, BondStore} from './bonds.mjs';

const roster = JSON.parse(readFileSync(new URL('../characters/roster.json', import.meta.url), 'utf8'));
const book = new PersonaBook(roster);
const GEAR = {version: 1, status: 'ready', clothing: [{slot: 'outerTorso', name: 'Leather Jacket'}, {slot: 'legs', name: 'Cargo Pants'}], weapons: [{slot: 'hand', name: 'Kyubi'}]};
const BONDS = {on: true, copy: 'party', packs: true, reach: true};

let sequence = 0;
const talk = (text, extra = {}) => ({requestId: `${1000 + ++sequence}-${sequence}-10ULL`, generation: sequence, entity: '10ULL', profileKey: 'panam-palmer', name: 'Panam', bodyType: 'WomanAverage',
  text, gear: GEAR, bonds: BONDS, turnContext: {version: 1, status: 'ready', hour: 9, minute: 5 + sequence, gameTime: 100000 + 90 * sequence, weather: 'clear', district: 'Watson',
    party: [{key: 'panam-palmer', name: 'Panam', activity: 'standing'}]}, ...extra});
// The game sends neither the bond block nor the gear with a reaction.
const speakUp = () => {
  const {gear, bonds, ...rest} = talk('Speak up on your own.');
  return {...rest, reaction: {kind: 'speakup', event: 'calm', facts: {}, expiresAt: 4e12}};
};

const flat = messages => messages.map(message => `<${message.role}>\n${message.content}`).join('\n');
const common = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };

/** The messages of a turn: the real context blocks plus the bond line, laid out as the bridge does for a text provider. */
function messagesOf(bonds, input, {history = [], tone = null} = {}) {
  const line = input.bonds ? bonds.contextFor(input, {romance: tone, tone}) : input.reaction ? bonds.repeatFor(input) : '';
  const blocks = [...conversationContextBlocks(input), {tier: 'world', text: line}];
  const world = worldBlocksInCacheOrder(blocks.filter(item => item.tier === 'world'));
  const parts = {...Object.fromEntries(['now', 'notes', 'volatile', 'closing'].map(tier => [tier, joinBlocks(blocks.filter(item => item.tier === tier).map(item => item.text))])),
    world: joinBlocks(world.map(item => item.text)), worldBlocks: world.filter(item => item.text).map(item => ({key: item.key, text: item.text}))};
  return buildMessages({persona: book.persona(input.profileKey), history, contextParts: parts, text: input.text, reaction: Boolean(input.reaction)});
}

test('two consecutive talks with a character share the whole system message and most of the prompt, with the bond block on', () => {
  gearMemory.clear();
  const bonds = new Bonds({store: new BondStore(), now: () => 0});
  const first = messagesOf(bonds, talk('Hey, how are you holding up?'));
  const second = messagesOf(bonds, talk('What do you think of the Afterlife?'), {history: [{v: 'Hey, how are you holding up?', r: 'Fine, V.'}]});
  assert.match(first[0].content, /How close you are to V/, 'the bond line is in the system message');
  assert.equal(second[0].content, first[0].content, 'the system message is byte for byte the same');
  const a = flat(first), b = flat(second);
  assert(common(a, b) >= first[0].content.length, 'the shared start is at least the system message');
  assert(common(a, b) / b.length > 0.8, `most of the second prompt is shared (${(100 * common(a, b) / b.length).toFixed(0)}%)`);
});

test('a reaction after a talk, and a talk after a reaction, keep the same system message (the bond line and the gear are repeated)', () => {
  gearMemory.clear();
  const bonds = new Bonds({store: new BondStore(), now: () => 0});
  const first = messagesOf(bonds, talk('Hey, how are you holding up?'));
  const reaction = messagesOf(bonds, speakUp());
  assert.match(reaction[0].content, /How close you are to V/, 'the reaction has the character\'s bond line');
  assert.match(reaction[0].content, /Leather Jacket/, 'and the gear of the last talk');
  assert.equal(reaction[0].content, first[0].content);
  const third = messagesOf(bonds, talk('Where are we going?'), {history: [{v: 'Hey, how are you holding up?', r: 'Fine, V.'}]});
  assert.equal(third[0].content, first[0].content);
  assert(common(flat(first), flat(reaction)) >= first[0].content.length);
});

test('before any talk a reaction has no bond line and no gear, as before; the setting off, or Forget, ends the repeat', () => {
  gearMemory.clear();
  const bonds = new Bonds({store: new BondStore(), now: () => 0});
  const cold = messagesOf(bonds, speakUp());
  assert.doesNotMatch(cold[0].content, /How close you are to V|Leather Jacket/);
  messagesOf(bonds, talk('Hi.'));
  assert.match(messagesOf(bonds, speakUp())[0].content, /Leather Jacket/);
  gearMemory.clear();
  assert.doesNotMatch(messagesOf(bonds, speakUp())[0].content, /Leather Jacket/, 'a new world forgets the gear');
  bonds.forget({all: true});
  assert.doesNotMatch(messagesOf(bonds, speakUp())[0].content, /How close you are to V/, 'Forget forgets the line');
});

test('new gear on the next talk replaces the one a reaction repeats; Johnny in V\'s head never gets either', () => {
  gearMemory.clear();
  const bonds = new Bonds({store: new BondStore(), now: () => 0});
  messagesOf(bonds, talk('Hi.'));
  const changed = {...GEAR, clothing: [{slot: 'outerTorso', name: 'Samurai Jacket'}]};
  messagesOf(bonds, talk('Hi again.', {gear: changed}));
  const reaction = messagesOf(bonds, speakUp())[0].content;
  assert.match(reaction, /Samurai Jacket/);
  assert.doesNotMatch(reaction, /Leather Jacket/);
  const head = {...speakUp(), profileKey: 'johnny-silverhand', head: {version: 1, stage: 'wary', milestones: []}};
  assert.doesNotMatch(messagesOf(bonds, head)[0].content, /Samurai Jacket|How close you are to V/);
});

test('a bond level that does not change leaves the line, and so the prompt, alone from turn to turn; a romance tone is as stable as the level', () => {
  gearMemory.clear();
  const bonds = new Bonds({store: new BondStore(), now: () => 0});
  const lines = [0, 1, 2, 3].map(i => messagesOf(bonds, talk(`Turn ${i}`), {tone: 'partner'})[0].content);
  for (const line of lines) assert.equal(line, lines[0]);
  assert.match(lines[0], /You and V are a couple/);
});

// The wiring in the bridge script (a script, not a module: its source is read).
const bridgeSource = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
test('the bridge wires it: a reaction repeats the bond line, a talk without the block forgets it, the tone follows the romantic delivery only, and the reminder is a closing note', () => {
  assert.match(bridgeSource, /if \(input\.bonds\) return bonds\.contextFor\(input, bondFacts\(input, prepared, admitted\)\);\n\s+if \(input\.reaction\) return bonds\.repeatFor\(input\);\n\s+if \(!input\.head\) bonds\.dropLine\(input\);/);
  assert.match(bridgeSource, /tone: selection\?\.style === 'romantic' \? romance : null/);
  assert.match(bridgeSource, /block\('closing', input\.bonds \? romanceReminder\(bondFacts\(input, prepared, admitted\)\.tone\) : ''\)/);
  assert.match(bridgeSource, /block\('world', bondNote\(input, prepared, admitted\)\)/);
});

test('the closing note sits right after the words of V and before the closing rules, only on a talk, and never moves the system message', () => {
  gearMemory.clear();
  const persona = book.persona('panam-palmer');
  const parts = {now: '', notes: '', world: 'W', volatile: '', closing: 'Tone with V this reply: partner.'};
  const talkLast = buildMessages({persona, contextParts: parts, text: 'Hello there'}).at(-1).content;
  assert.match(talkLast, /V says: Hello there\n\nTone with V this reply: partner\.\n\n\(Reply as /);
  const plain = buildMessages({persona, contextParts: {...parts, closing: ''}, text: 'Hello there'});
  assert.doesNotMatch(plain.at(-1).content, /Tone with V/);
  assert.equal(buildMessages({persona, contextParts: parts, text: 'Hello there'})[0].content, plain[0].content, 'the system message is the same with and without the note');
  assert.doesNotMatch(buildMessages({persona, contextParts: parts, text: 'A fight', reaction: true}).at(-1).content, /Tone with V/, 'a reaction has no note');
});
