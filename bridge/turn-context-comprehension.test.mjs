import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseInput} from './protocol.mjs';
import {turnContext, moneyNote, MONEY_NOTE} from './turn-context.mjs';
import {conversationContext} from './quest-context.mjs';

// A player report (2026-10-25): "I gave you eddies to do a task" was answered "I'm not going to give you eddies", and characters did not know what they were
// doing, who they stood next to or what they held. The prompt must state who pays whom, and the companion's own doing, company and hand.
const scene = (extra = {}) => ({version: 1, status: 'ready', hour: 14, minute: 0, district: 'Watson', area: 'Kabuki', gender: 'female', lifepath: 'streetkid',
  party: [{key: 'judy-alvarez', name: 'Judy', activity: 'standing', holding: 'weapon'}, {key: 'panam-palmer', name: 'Panam'}], ...extra});
const turn = (extra = {}) => parseInput(JSON.stringify({requestId: '100-1-11ULL', generation: 1, entity: '11ULL', profileKey: 'judy-alvarez', name: 'Judy',
  bodyType: 'WomanAverage', text: 'I gave you 500 eddies to do the job.', turnContext: scene(), ...extra}));

test('a turn where V speaks of eddies says V pays the character and what V gave is received', () => {
  for (const text of ['I gave you 500 eddies to do the job.', 'Here, I paid you already.', 'take the cash for it', 'that is €$ 300 for you'.replace('€$', '$')]) {
    const context = conversationContext(turn({text}));
    assert.ok(context.includes(MONEY_NOTE), text);
  }
  assert.match(MONEY_NOTE, /V is the one paying you/);
  assert.match(MONEY_NOTE, /gave or paid you eddies, you have them now/);
});

test('the money note stays out of turns that are not about money, and out of automatic reactions', () => {
  assert.equal(moneyNote({text: 'What now?'}), '');
  assert.equal(moneyNote({text: 'Where did the cashier go?'}), '');
  assert.equal(moneyNote({text: 'I gave you eddies', reaction: {kind: 'loot'}}), '');
  assert.ok(!conversationContext(turn({text: 'So what now?'})).includes('Money:'));
});

test('a stranger and a phone contact get the money note too', () => {
  assert.ok(conversationContext(turn({profileKey: 'archetype-vendor', text: 'I paid you 50 eddies'})).includes(MONEY_NOTE));
  assert.ok(conversationContext(turn({channel: 'phone', text: 'I sent you eddies for the job'})).includes(MONEY_NOTE));
});

test('a companion in person is told what she is doing, who is with V and what is in her hand', () => {
  const text = turnContext(turn());
  assert.match(text, /You are with V in person, standing near V\./);
  assert.match(text, /You have a weapon drawn in your hand\./);
  assert.match(text, /Also with V: Panam\./);
  const held = (holding, weapon) => turnContext(turn({turnContext: scene({party: [{key: 'judy-alvarez', name: 'Judy', holding, weapon}]})}));
  assert.match(held('empty'), /You carry no weapon\./);
  assert.match(held('weapon', 'Satara'), /You are holding Satara\./);
  assert.match(held('holstered', 'Satara'), /You carry Satara \(holstered\)\./);
  assert.match(held('holstered'), /You carry a weapon \(holstered\)\./);
  assert.ok(!/You are holding|You carry/.test(held('sword', 'Satara')));
  assert.match(held('holstered', 'Sa<b>tara</b>'), /You carry Satara \(holstered\)\./);
});

test('the game side reads the hand once per turn and passes it on', () => {
  const lua = readFileSync(new URL('../mod/turn-context.lua', import.meta.url), 'utf8');
  assert.match(lua, /inputs\.holding == 'weapon' or inputs\.holding == 'holstered' or inputs\.holding == 'empty'/);
  assert.match(readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8'), /function M\.carriedWeapon[\s\S]*draw\.handItem[\s\S]*draw\.primaryItem[\s\S]*draw\.nameOf/);
});
