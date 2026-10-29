// Paying an NPC (bridge/quest-pay.mjs, docs/QUEST_PRIMITIVES.md 10.2): the stage's note for the cast member, V's words read for an amount, yes or no, the command data, and the
// request's quest block. Offline.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {payNote, readPay, payData, parseQuestBlock} from './quest-pay.mjs';
import {parseInput} from './protocol.mjs';

const spec = {id: 'toll', to: 'guard', amount: 100, min: 60, reason: 'toll'};

test('the note says what is asked and the least it takes, in the second person, without a semicolon or a dash', () => {
  const note = payNote(spec);
  assert.match(note, /You want eddies from V to let V through/);
  assert.match(note, /100 eddies/); assert.match(note, /60 eddies at the very least/);
  assert(note.length <= 500, String(note.length));
  assert(!note.includes(';') && !/[–—]|--/.test(note));
  assert.match(payNote({...spec, min: undefined}), /you do not take less/);
  assert.match(payNote({...spec, reason: 'bribe'}), /look the other way/);
  assert.match(payNote({...spec, reason: 'tab'}), /the tab V owes/);
  assert.equal(payNote(null), ''); assert.equal(payNote({id: 'x', to: 'y'}), ''); assert.equal(payNote({...spec, amount: 0}), '');
  assert.match(payNote({...spec, min: 500}), /you do not take less/, 'a min above the amount is no haggle');
});

test('V\'s words: a named sum, a plain yes (the asking price), no, and nothing', () => {
  assert.deepEqual(readPay('Fine, here is 100 eddies', spec), {kind: 'offer', amount: 100});
  assert.deepEqual(readPay('how about 80', spec), {kind: 'offer', amount: 80});
  assert.deepEqual(readPay('take 70 eddies, that is all I have', spec), {kind: 'offer', amount: 70});
  assert.deepEqual(readPay('deal, 100', spec), {kind: 'offer', amount: 100});
  assert.deepEqual(readPay('yeah ok', spec), {kind: 'offer', amount: 100}, 'an unspoken amount is the asking price when V says yes');
  assert.deepEqual(readPay('sure', spec), {kind: 'offer', amount: 100});
  assert.deepEqual(readPay('no way', spec), {kind: 'declined'});
  assert.deepEqual(readPay('I won\'t pay that', spec), {kind: 'declined'});
  assert.deepEqual(readPay('no, 50', spec), {kind: 'declined'});
  assert.equal(readPay('hmm what', spec), null);
  assert.equal(readPay('', spec), null); assert.equal(readPay(undefined, spec), null); assert.equal(readPay('sure', null), null);
});

test('V\'s words in another language use the money reader of Eddies', () => {
  assert.deepEqual(readPay('Ich gebe dir 100', spec), {kind: 'offer', amount: 100});
  assert.deepEqual(readPay('nein danke', spec), {kind: 'declined'});
  assert.deepEqual(readPay('vale, 100 eurodólares', spec), {kind: 'offer', amount: 100});
});

test('the command data is flat: an amount, or a refusal as amount 0 with declined', () => {
  assert.deepEqual(payData({kind: 'offer', amount: 80}), {amount: 80});
  assert.deepEqual(payData({kind: 'declined'}), {amount: 0, declined: true});
  assert.equal(payData(null), null); assert.equal(payData({kind: 'other'}), null);
});

test('the quest block: exactly {pack, cast}, strict ids, anything odd is dropped', () => {
  assert.deepEqual(parseQuestBlock({pack: 'panam-sunset-coffee', cast: 'guard'}), {pack: 'panam-sunset-coffee', cast: 'guard'});
  for (const bad of [null, undefined, 'x', [], {}, {pack: 'panam-sunset-coffee'}, {pack: 'panam-sunset-coffee', cast: 'guard', extra: 1}, {pack: 'Panam', cast: 'guard'}, {pack: 'ab', cast: 'guard'},
    {pack: 'panam-sunset-coffee', cast: 'Guard'}, {pack: 'panam-sunset-coffee', cast: 7}, {pack: '../etc/passwd', cast: 'guard'}, {pack: 'panam-sunset-coffee', cast: 'x'.repeat(40)}]) {
    assert.equal(parseQuestBlock(bad), null, JSON.stringify(bad));
  }
});

test('the request parser carries the quest block on an ordinary private turn and drops it on a reaction, a group round or when it is odd', () => {
  const base = {requestId: '1-1-1ULL', generation: 1, entity: '1ULL', name: 'Guard', bodyType: 'male', profileKey: 'npc-fixer-male', text: 'here is 100'};
  const request = extra => parseInput(JSON.stringify({...base, requestId: '1-1-1ULL', ...extra}));
  assert.deepEqual(request({quest: {pack: 'panam-sunset-coffee', cast: 'guard'}}).quest, {pack: 'panam-sunset-coffee', cast: 'guard'});
  assert.equal(request({quest: {pack: 'panam-sunset-coffee', cast: 'guard', more: true}}).quest, undefined);
  assert.equal(request({quest: 'guard'}).quest, undefined);
  assert.equal(request({}).quest, undefined);
  assert.equal(request({quest: {pack: 'panam-sunset-coffee', cast: 'guard'}}).text, 'here is 100', 'the turn itself stands');
});
