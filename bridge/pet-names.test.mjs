import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PET_NAME_GAP, petNamesIn, petNameAllowed, lastPetName, petNameNote, limitPetNames, headHasPetName, rememberReply} from './pet-names.mjs';

// Judy Alvarez in the owner's live talk of 2026-10-31 (Convai, six replies): "babe" or "handsome" in five of them.
const LIVE = [
  'I do, babe. Got a tabby named Biscuits. He is a little menace, but he is my favorite little menace.',
  "Better now that I'm with you, handsome. Though I'm still fighting that one stubborn drop of lake water in my ear.",
  "They're good people, V. Basically, we look out for the ones the city usually just chews up and spits out.",
  "Degrading? Depends on who's running the show. There's a big difference between choosing your work and being owned by some suit, babe.",
  "Some of them are, yeah. But it's about who has the power. We're about taking the control back, V.",
  "Three hundred? Sure thing, babe. Consider it a loan, though I'm not charging you any corporate interest.",
  "Don't mention it, handsome. Just try not to spend it all on one fancy piece of chrome, okay?",
];

test('a pet name said to V is found; an adjective is not one', () => {
  assert.deepEqual(petNamesIn(LIVE[0]), ['babe']);
  assert.deepEqual(petNamesIn(LIVE[1]), ['handsome']);
  assert.deepEqual(petNamesIn(LIVE[2]), []);
  assert.deepEqual(petNamesIn('Hey handsome, what is up? Babe. Thanks, love.'), ['handsome', 'babe', 'love']);
  assert.deepEqual(petNamesIn('You look handsome today, V. What a handsome devil you are.'), []);
  assert.deepEqual(petNamesIn('I love this song. The baby cried all night. Honey badgers are fierce.'), []);
  assert.deepEqual(petNamesIn('Oh, babes, no.'), ['babe']);
  assert.deepEqual(petNamesIn('[laugh] Hey, sweetheart.'), ['sweetheart']);
  assert.deepEqual(petNamesIn(''), []);
  assert.deepEqual(petNamesIn(null), []);
});

test('the live talk breaks the rule: a pet name in 5 of 7 replies; the rule allows one in six', () => {
  assert.equal(LIVE.filter(reply => petNamesIn(reply).length).length, 5);
  assert.equal(PET_NAME_GAP, 6);
  assert.equal(petNameAllowed([]), true, 'nothing said yet: one may be said');
  assert.equal(petNameAllowed(LIVE.slice(0, 1)), false);
  assert.equal(petNameAllowed(['I do, babe.', 'a b c', 'a b c', 'a b c', 'a b c']), false, 'four replies later still not');
  assert.equal(petNameAllowed(['I do, babe.', 'a b c', 'a b c', 'a b c', 'a b c', 'a b c']), true, 'five replies without one: allowed again');
  assert.equal(lastPetName(LIVE), 'handsome');
  assert.equal(lastPetName(['no', 'Sure, babe.', 'no']), 'babe');
  assert.equal(lastPetName([]), '');
});

test('the note: none at all lately, or only the names to leave out, or nothing when none was used', () => {
  assert.equal(petNameNote([]), '');
  assert.equal(petNameNote(['Nothing here.', 'Nor here, V.']), '');
  assert.match(petNameNote(LIVE), /lately, so this reply has no pet name for V at all/);
  assert.match(petNameNote(LIVE), /"babe" or "handsome"/);
  const old = ['Fine, babe.', 'one two three', 'one two three', 'one two three', 'one two three', 'one two three'];
  assert.match(petNameNote(old), /If you call V a pet name this reply, use only one, and not "babe"/);
  for (const note of [petNameNote(LIVE), petNameNote(old)]) assert.doesNotMatch(note, /[;]|—|–|--/, 'plain words for a model: no dashes or semicolons');
});

test('the reply loses a pet name that came too soon, and keeps the rest of it', () => {
  const after = limitPetNames("Don't mention it, handsome. Just try not to spend it all, okay?", LIVE.slice(0, 5));
  assert.deepEqual(after, {reply: "Don't mention it. Just try not to spend it all, okay?", removed: 1});
  assert.equal(limitPetNames("Hey handsome, what's up with the chrome today?", ['x, babe.'])?.reply, "Hey, what's up with the chrome today?");
  assert.equal(limitPetNames("Handsome, what's up with the chrome today?", ['x, babe.'])?.reply, "What's up with the chrome today?");
  assert.equal(limitPetNames('Babe. That is a lot of eddies to spend on one thing.', ['x, babe.'])?.reply, 'That is a lot of eddies to spend on one thing.');
  assert.equal(limitPetNames('Sure thing, babe, I can do that.', ['x, babe.'])?.reply, 'Sure thing, I can do that.');
  assert.equal(limitPetNames('You look handsome today, V.', ['x, babe.']), null, 'an adjective is not touched');
  assert.equal(limitPetNames('Fine, babe.', ['x, babe.']), null, 'too little would be left: the reply stands');
  assert.equal(limitPetNames('No pet name in this one at all, V.', LIVE), null);
});

test('after enough replies one is allowed, but only one, and never the one she used last', () => {
  const quiet = ['I do, babe.', 'one two three', 'one two three', 'one two three', 'one two three', 'one two three'];
  assert.equal(limitPetNames('Sure thing, handsome. Consider it a loan.', quiet), null, 'a different one after the gap: kept');
  assert.equal(limitPetNames('Sure thing, babe. Consider it a loan.', quiet)?.reply, 'Sure thing. Consider it a loan.', 'the same as last time: out');
  assert.equal(limitPetNames('Sure thing, handsome. Consider it a loan, babe.', quiet)?.reply, 'Sure thing, handsome. Consider it a loan.', 'two in one reply: the second goes');
  assert.equal(limitPetNames('Sure thing, babe. Consider it a loan, handsome.', [])?.reply, 'Sure thing, babe. Consider it a loan.', 'with no history the first stays');
});

test('simulated talk: over 60 replies that always begin with a pet name, at most one in six is left and none repeats in a row', () => {
  const names = ['handsome', 'babe', 'sweetheart', 'honey'];
  const said = [];
  for (let at = 0; at < 60; at++) {
    const raw = `Sure thing, ${names[at % names.length]}. I can do that for you today.`;
    const lean = limitPetNames(raw, said);
    said.push(lean ? lean.reply : raw);
  }
  const used = said.map(reply => petNamesIn(reply));
  const indexes = used.flatMap((list, index) => list.length ? [index] : []);
  assert.ok(indexes.length >= 8 && indexes.length <= 12, `about one in six: ${indexes.length}`);
  for (let at = 1; at < indexes.length; at++) assert.ok(indexes[at] - indexes[at - 1] >= PET_NAME_GAP, `gap ${indexes[at] - indexes[at - 1]}`);
  for (let at = 1; at < indexes.length; at++) assert.notEqual(used[indexes[at]][0], used[indexes[at - 1]][0], 'never the same one twice in a row');
  assert.ok(used.every(list => list.length <= 1));
});

test('the voice does not begin with a head that has a pet name the rule would take out', () => {
  assert.equal(headHasPetName("Don't mention it, handsome.", LIVE), true);
  assert.equal(headHasPetName("Don't mention it, V.", LIVE), false);
  assert.equal(headHasPetName("Don't mention it, handsome.", []), false, 'the first one is allowed');
});

test('the memory keeps twelve replies by character', () => {
  const memory = new Map();
  for (let at = 0; at < 15; at++) rememberReply(memory, 'judy-alvarez', `reply ${at}`);
  assert.equal(memory.get('judy-alvarez').length, 12);
  assert.equal(memory.get('judy-alvarez')[0], 'reply 3');
  assert.deepEqual(rememberReply(memory, 'panam-palmer', '  '), []);
  assert.deepEqual(rememberReply(memory, 7, 'x'), []);
  assert.deepEqual(rememberReply(null, 'a', 'x'), []);
});
