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
  assert.match(text, /You are with V in person\./);
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
  assert.match(readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8'), /function M\.carriedWeapon[\s\S]*draw\.handItem[\s\S]*draw\.carriedItem[\s\S]*draw\.nameOf/);
});

// Live 2026-10-26: asked "what weapon do you have?" a companion said none, with the sentence in the block. V asking about weapons gets the sentence worded as the
// answer, in the menu languages too; anything else gets the plain sentence.
test('V asking what she carries gets the weapon worded as the answer, in every menu language', () => {
  const party = [{key: 'judy-alvarez', name: 'Judy', holding: 'holstered', weapon: 'A-22B Chao'}];
  const said = text => turnContext(turn({text, turnContext: scene({party})}));
  for (const text of ['what weapon do you have?', 'Are you armed?', 'what are you packing', '¿Qué arma llevas?', 'Quelle arme tu portes ?', 'Welche Waffe hast du?', 'Che arma hai?',
    'Jaką masz broń?', 'Jakou máš zbraň?', 'Milyen fegyvered van?', 'какое у тебя оружие?', 'яка в тебе зброя?', 'Hangi silahın var?', '你带着什么武器？', 'どんな武器を持ってる？', '무기가 뭐야?', 'Qual arma você carrega?']) {
    assert.match(said(text), /V asks what you are armed with\. The true answer: You carry A-22B Chao \(holstered\)\. Answer from this/, text);
  }
  for (const text of ['How are you?', 'Nice weather today.', 'Let us go to the bar.']) {
    const block = said(text);
    assert.match(block, /You carry A-22B Chao \(holstered\)\./, text);
    assert.ok(!block.includes('V asks what you are armed with'), text);
  }
  // an automatic speak-up has no words of V's to read
  assert.ok(!turnContext(turn({text: 'what weapon do you have?', reaction: {kind: 'speakup'}, turnContext: scene({party})})).includes('V asks what you are armed with'));
  // she carries none: the answer says so too
  assert.match(turnContext(turn({text: 'got a gun?', turnContext: scene({party: [{key: 'judy-alvarez', name: 'Judy', holding: 'empty'}]})})), /The true answer: You carry no weapon\./);
  // the housemate at home sends a row of her own with only the weapon: no activity is claimed
  const home = turnContext(turn({text: 'what weapon do you have?', turnContext: scene({party: [{key: 'judy-alvarez', name: 'Judy', holding: 'holstered', weapon: 'A-22B Chao'}]})}));
  assert.match(home, /You are with V in person\. /);
  assert.ok(!/following V|standing near V/.test(home));
});

test('the game side words no activity for a housemate at home and logs what each companion carries', () => {
  const lua = readFileSync(new URL('../mod/turn-context.lua', import.meta.url), 'utf8');
  assert.match(lua, /if inputs\.visitor ~= true then row\.activity = M\.classify\(inputs\) end/);
  assert.match(lua, /' carry=' \.\. table\.concat\(carrying, ','\)/);
  assert.match(readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8'), /entry\.state=='visiting' and entry\.profileKey and entry\.npc then[\s\S]*pcall\(M\.carriedWeapon,entry\)/);
});
