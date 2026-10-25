import {test} from 'node:test';
import assert from 'node:assert/strict';
import {plainCallOff, screenMeet, meetAction, parseMeetOffer} from './meet-requests.mjs';
import {callOffRecord, publishCallOff} from './call-off.mjs';
import {PhoneChat} from './phone-chat.mjs';

// Live 2026-10-25 (Claire Russell): a meeting stood, V said it was off in plain words, she came anyway. The words, the phone turn and the talk turn.
test('the words of the failed live test are a plain call-off, and a loose refusal is not one for a third person', () => {
  for (const text of ['actually no dont come', 'never mind, cancel that', 'Never mind', 'forget it', "don't come", 'abgesagt, komm nicht', 'annule tout', 'отбой', 'キャンセルして', 'cancel that']) {
    assert.equal(plainCallOff(text), true, text);
  }
  for (const text of ['no thanks', 'I never mind waiting', 'not anymore', 'hello there', 'actually no sorry', 'come and meet me, never mind the rain', 'what do you think', '']) {
    assert.equal(plainCallOff(text), false, text);
  }
  assert.equal(screenMeet('actually no sorry').sure, true, 'the person V arranged it with still takes the loose words');
});

const TOKEN = 'meet-0123456789abcdef';
test('the phone turn with the invited person: the screen, the pending offer and the words give the cancel action', () => {
  const offer = parseMeetOffer({version: 1, unavailable: 'pending', place: 'Corpo Plaza', cancel: true, token: TOKEN});
  for (const text of ['actually no dont come', 'never mind, cancel that']) {
    assert.deepEqual(meetAction(null, offer, screenMeet(text)), {kind: 'cancel-meet', token: TOKEN}, text);
  }
});

test('the real phone turn: a pending offer and "never mind, cancel that" publish a cancel action although she answers in words only', async () => {
  const output = [];
  const saveIdentity = {version: 1, status: 'available', authoritative: true, confidence: 'native-live', localUserId: 'user-1', campaignId: 'a'.repeat(32),
    branchId: 'b'.repeat(32), branchEpoch: 1, ledgerSequence: 10, generation: 1, activationId: 'c'.repeat(32)};
  const chat = new PhoneChat({contacts: [{contact: 'marianne', key: 'claire-russell'}], ids: {'claire-russell': 'claire-id'}, now: () => 100000,
    reply: async () => ({text: "Copy that. I'll just head back to what I was doing then.", sessionID: 'session'}), publish: async value => output.push(value)});
  await chat.accept({version: 2, world: 'world-1', updated: 100000, active: true, saveIdentity, request: {id: 'world-1-1', contact: 'marianne', saveIdentity,
    text: 'never mind, cancel that', meetOffer: {version: 1, unavailable: 'pending', place: 'Corpo Plaza', cancel: true, token: TOKEN}}});
  await chat.active?.work;
  assert.deepEqual(output.find(row => row.state === 'reply').action, {kind: 'cancel-meet', token: TOKEN});
});

test('a talk or voice turn with another character writes the call-off record, and only a turn of V\'s own words', () => {
  const record = callOffRecord({requestId: 'r-1', text: 'never mind, cancel that'}, undefined, 5000);
  assert.deepEqual(record, {version: 1, id: 'r-1', updated: 5000, text: 'never mind, cancel that'});
  assert.equal(callOffRecord({requestId: 'r-2', text: '[microphone]'}, 'forget it, she should stay home', 1).text, 'forget it, she should stay home', 'a spoken line is read from what was recognised');
  assert.equal(callOffRecord({requestId: 'r-3', text: 'how are you'}, undefined, 1), null);
  assert.equal(callOffRecord({requestId: 'r-4', text: 'never mind', reaction: {kind: 'loot'}}, undefined, 1), null);
  assert.equal(callOffRecord({requestId: 'r-5', text: 'never mind', holocall: {}}, undefined, 1), null);
  assert.equal(callOffRecord({requestId: 'r-6', text: 'x '.repeat(200) + 'never mind'}, undefined, 1), null);
});

test('publishing writes one file for a call-off and nothing otherwise, and a failing write never throws', async () => {
  const writes = [];
  publishCallOff('/run', async (path, text) => writes.push([path, JSON.parse(text)]), {requestId: 'r-7', text: 'never mind, cancel that'});
  publishCallOff('/run', async (path, text) => writes.push([path, text]), {requestId: 'r-8', text: 'nice weather'});
  publishCallOff('/run', () => { throw Error('disk'); }, {requestId: 'r-9', text: 'never mind, cancel that'});
  publishCallOff('/run', async () => { throw Error('disk'); }, {requestId: 'r-10', text: 'never mind, cancel that'});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes.length, 1);
  assert.match(writes[0][0], /call-off\.json$/);
  assert.equal(writes[0][1].id, 'r-7');
});
