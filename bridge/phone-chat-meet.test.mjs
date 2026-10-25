// Phone chat and immersive invitations: the meet offer, the tag in her reply, and the events the character starts (bridge/meet-requests.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PhoneChat, phoneRecentConversationContext} from './phone-chat.mjs';
import {PhoneFailureLog} from './phone-failure.mjs';

const now = 100000;
const binding = () => ({version: 1, status: 'available', authoritative: true, confidence: 'native-live', localUserId: 'user-1', campaignId: 'a'.repeat(32),
  branchId: 'b'.repeat(32), branchEpoch: 1, ledgerSequence: 10, generation: 1, activationId: 'c'.repeat(32)});
const state = request => {
  const saveIdentity = binding();
  return {version: 2, world: 'world-1', updated: now, active: true, saveIdentity, request: {id: 'world-1-1', contact: 'judy', saveIdentity, text: 'Hey Judy!', ...request}};
};
function fixture(reply, options = {}) {
  const output = [], calls = [];
  const chat = new PhoneChat({contacts: [{contact: 'judy', key: 'judy-alvarez'}], ids: {'judy-alvarez': 'judy-id'}, now: () => now, ...options,
    reply: args => { calls.push(args); return reply(args); }, publish: async value => output.push(value)});
  return {chat, calls, output};
}
async function finish(chat, value) { await chat.accept(value); await chat.active?.work; }
const replies = output => output.filter(row => row.state === 'reply');

const TOKEN = 'meet-0123456789abcdef';
const offer = (extra = {}) => ({version: 1, token: TOKEN, kinds: ['here'], here: {place: "Lizzie's Bar, Kabuki, Watson"}, etaMinutes: 5, waitMinutes: 5, cancel: false, ...extra});
const waypointOffer = (extra = {}) => offer({kinds: ['here', 'waypoint'], waypoint: {place: 'about 1.4 km north-east of Kabuki'}, ...extra});
const answer = text => async () => ({text, sessionID: 'session'});

test('an offer round trip: the instruction goes to the provider, the tag comes off, the action goes to the game', async () => {
  const {chat, calls, output} = fixture(answer('[meet-here] On my way. I know Lizzie\'s.'));
  await finish(chat, state({text: 'come meet me', meetOffer: offer()}));
  assert.equal(calls.length, 1);
  assert.match(calls[0].text, /\[meet-here\]/);
  assert.match(calls[0].text, /Lizzie's Bar, Kabuki, Watson/);
  assert.match(calls[0].text, /V messages: come meet me$/, 'V\'s line is last and unlabelled by the instruction');
  assert.match(calls[0].input.meetInstruction, /in about 5 minutes/);
  assert.equal(calls[0].input.text, 'come meet me', 'the provider and the memory see V\'s typed line');
  assert.equal(Object.hasOwn(calls[0].input, 'meetOffer'), false, 'the offer itself stays out of the request');
  const [reply] = replies(output);
  assert.equal(reply.text, "On my way. I know Lizzie's.");
  assert.deepEqual(reply.action, {kind: 'meet-here', token: TOKEN});
  assert.deepEqual(Object.keys(reply).sort(), ['action', 'binding', 'contact', 'id', 'state', 'text', 'world']);
});

test('a waypoint request gets a waypoint action when V named it; a here answer stays here', async () => {
  const waypoint = fixture(answer('[meet-waypoint] Sure, heading to the marker.'));
  await finish(waypoint.chat, state({text: 'come to the waypoint', meetOffer: waypointOffer()}));
  assert.deepEqual(replies(waypoint.output)[0].action, {kind: 'meet-waypoint', token: TOKEN});
  assert.match(waypoint.calls[0].text, /\[meet-waypoint\]/);
  assert.equal(replies(waypoint.output)[0].text, 'Sure, heading to the marker.');
  // She tags the waypoint but V never named it: here.
  const downgraded = fixture(answer('[meet-waypoint] On my way.'));
  await finish(downgraded.chat, state({text: 'come over to my place', meetOffer: waypointOffer()}));
  assert.deepEqual(replies(downgraded.output)[0].action, {kind: 'meet-here', token: TOKEN});
});

test('the tag survives only in the voice-tagged original: it is still read, and the text is clean', async () => {
  const {chat, output} = fixture(async () => ({text: 'On my way.', speechText: '[meet-here] On my way.', sessionID: 'session'}));
  await finish(chat, state({text: 'come over', meetOffer: offer()}));
  assert.equal(replies(output)[0].text, 'On my way.');
  assert.deepEqual(replies(output)[0].action, {kind: 'meet-here', token: TOKEN});
});

test('a trailing tag works; a spaced "[meet waypoint]" works; the stray tag in the middle is cut and chooses nothing', async () => {
  const trailing = fixture(answer('Be right there. [Meet-Here]'));
  await finish(trailing.chat, state({text: 'come over', meetOffer: offer()}));
  assert.equal(replies(trailing.output)[0].text, 'Be right there.');
  assert.equal(replies(trailing.output)[0].action.kind, 'meet-here');
  const spaced = fixture(answer('[meet waypoint] Heading to the pin.'));
  await finish(spaced.chat, state({text: 'meet me at the pin', meetOffer: waypointOffer()}));
  assert.equal(replies(spaced.output)[0].action.kind, 'meet-waypoint');
  const stray = fixture(answer('I could [meet-here] if you asked properly.'));
  await finish(stray.chat, state({text: 'come over', meetOffer: offer()}));
  assert.equal(replies(stray.output)[0].text, 'I could if you asked properly.');
  assert.equal(Object.hasOwn(replies(stray.output)[0], 'action'), false);
});

test('without an offer the tag is cut and nothing happens; the message is the ordinary one', async () => {
  const {chat, calls, output} = fixture(answer('[meet-here] Sure, come by.'));
  await finish(chat, state({text: 'come over'}));
  assert.equal(replies(output)[0].text, 'Sure, come by.');
  assert.equal(Object.hasOwn(replies(output)[0], 'action'), false);
  assert.equal(Object.hasOwn(calls[0].input, 'meetInstruction'), false);
});

test('V\'s words must pass the screen: no instruction for small talk, and a tag then gives no action', async () => {
  const {chat, calls, output} = fixture(answer('[meet-here] Sure.'));
  await finish(chat, state({text: 'how was your day?', meetOffer: offer()}));
  assert.doesNotMatch(calls[0].text, /\[meet-here\]|meet/i);
  assert.equal(Object.hasOwn(calls[0].input, 'meetInstruction'), false);
  assert.equal(replies(output)[0].text, 'Sure.');
  assert.equal(Object.hasOwn(replies(output)[0], 'action'), false);
});

test('a token, kind or offer the game did not make gives no action, and the text still goes out', async () => {
  // Cancel not offered.
  const noCancel = fixture(answer('[cancel-meet] Fine.'));
  await finish(noCancel.chat, state({text: 'never mind', meetOffer: offer()}));
  assert.equal(replies(noCancel.output)[0].text, 'Fine.');
  assert.equal(Object.hasOwn(replies(noCancel.output)[0], 'action'), false);
  // Unavailable.
  const busy = fixture(answer('[meet-here] Coming!'));
  await finish(busy.chat, state({text: 'come over', meetOffer: {version: 1, unavailable: 'combat'}}));
  assert.match(busy.calls[0].text, /in a fight/);
  assert.equal(replies(busy.output)[0].text, 'Coming!');
  assert.equal(Object.hasOwn(replies(busy.output)[0], 'action'), false);
  // The token on the action is always the offer's.
  const ok = fixture(answer('[meet-here] Coming!'));
  await finish(ok.chat, state({text: 'come over', meetOffer: offer({token: 'meet-' + 'f'.repeat(32)})}));
  assert.equal(replies(ok.output)[0].action.token, 'meet-' + 'f'.repeat(32));
});

test('a pending meeting is cancelled by "never mind" through the unavailable offer', async () => {
  const {chat, calls, output} = fixture(answer('[cancel-meet] All right, I will stay put.'));
  await finish(chat, state({text: 'never mind, stay home', meetOffer: {version: 1, unavailable: 'pending', place: 'Pacifica', cancel: true, token: TOKEN}}));
  assert.match(calls[0].text, /\[cancel-meet\]/);
  assert.deepEqual(replies(output)[0].action, {kind: 'cancel-meet', token: TOKEN});
  assert.equal(replies(output)[0].text, 'All right, I will stay put.');
});

test('a malformed offer never rejects the message', async () => {
  for (const meetOffer of [{version: 1, token: 'bad', kinds: ['here']}, 'x', [], {version: 1, unavailable: 'nap'}, {...offer(), etaMinutes: 4}]) {
    const {chat, calls, output} = fixture(answer('[meet-here] Hello.'));
    await finish(chat, state({text: 'come over', meetOffer}));
    assert.equal(calls.length, 1);
    assert.equal(replies(output)[0].text, 'Hello.');
    assert.equal(Object.hasOwn(replies(output)[0], 'action'), false);
  }
});

test('a reply that is only a tag is an invalid reply, like an empty one', async () => {
  const {chat, output} = fixture(answer('[meet-here]'));
  await finish(chat, state({text: 'come over', meetOffer: offer()}));
  assert.equal(replies(output).length, 0);
  assert.equal(output.at(-1).state, 'error');
});

test('the ordinary message is unchanged: the same provider text, no action, no extra fields', async () => {
  const {chat, calls, output} = fixture(answer('Hi V.'));
  await finish(chat, state({text: 'Hey Judy!'}));
  assert.equal(calls[0].text, calls[0].context ? calls[0].context + '\n\nV messages: Hey Judy!' : 'Hey Judy!');
  assert.equal(Object.keys(calls[0].input).some(key => ['meetInstruction', 'meetOffer', 'event'].includes(key)), false);
  assert.deepEqual(replies(output)[0], {world: 'world-1', binding: replies(output)[0].binding, id: 'world-1-1', contact: 'judy', state: 'reply', text: 'Hi V.'});
});

// ---- events the character starts ---------------------------------------------------------------------------------------------------------------------

const event = (kind, extra = {}) => ({version: 1, kind, place: 'Pacifica, Coastview', minutes: 5, car: false, ...extra});

test('an event request has no text of V\'s, is accepted, and the model is told the trigger instead', async () => {
  const {chat, calls, output} = fixture(answer('I am here. Where are you?'));
  await finish(chat, state({text: '', event: event('arrived', {minutes: 0})}));
  assert.equal(calls.length, 1);
  assert.match(calls[0].input.text, /^This is an automatic game event, not something V said\./);
  assert.match(calls[0].input.text, /just arrived/);
  assert.equal(calls[0].input.event.kind, 'arrived');
  assert.match(calls[0].text, /just arrived/);
  assert.doesNotMatch(calls[0].text, /V messages:/, 'the trigger is never labelled as V\'s words');
  assert.equal(replies(output)[0].text, 'I am here. Where are you?');
  assert.equal(Object.hasOwn(replies(output)[0], 'action'), false);
});

test('an event turn reaches the provider with the recent conversation as given', async () => {
  const recent = {version: 1, source: 'local-phone-chat', profileKey: 'judy-alvarez', contact: 'judy', world: 'world-1', binding: 'x', historyScope: 'phone-local-player:v1',
    memoryReset: {version: 1, globalEpoch: 0, characterEpoch: 0}, rows: [{sent: true, text: 'come meet me'}, {sent: false, text: 'on my way'}]};
  const {chat, calls} = fixture(answer('Here.'));
  const value = state({text: '', event: event('arrived'), recentConversation: recent, memoryReset: recent.memoryReset});
  value.request.recentConversation.binding = 'session:1';
  value.request.saveIdentity = {version: 1, status: 'unavailable', generation: 1};
  value.saveIdentity = {version: 1, status: 'unavailable', generation: 1};
  await finish(chat, value);
  assert.equal(calls.length, 1);
  const recentContext = phoneRecentConversationContext(calls[0].input);
  assert.match(recentContext, /come meet me/);
  assert.match(recentContext, /on my way/);
  assert.match(calls[0].context, /This is an automatic reaction\. Do not ask V a question/, 'she does not ask V for anything in an automatic text');
});

test('an event that is malformed with empty text is no request; an event with typed text is a typed message', async () => {
  const none = fixture(answer('x'));
  await finish(none.chat, state({text: '', event: event('left')}));
  assert.equal(none.calls.length, 0);
  const typed = fixture(answer('Hi.'));
  await finish(typed.chat, state({text: 'hello', event: event('arrived')}));
  assert.equal(typed.calls[0].input.text, 'hello');
  assert.equal(Object.hasOwn(typed.calls[0].input, 'event'), false);
});

test('an event turn is never given an offer, and its reply tags are cut without an action', async () => {
  const {chat, calls, output} = fixture(answer('[meet-here] Where were you?'));
  await finish(chat, state({text: '', event: event('stood-up'), meetOffer: offer()}));
  assert.equal(Object.hasOwn(calls[0].input, 'meetInstruction'), false);
  assert.equal(replies(output)[0].text, 'Where were you?');
  assert.equal(Object.hasOwn(replies(output)[0], 'action'), false);
});

test('a provider failure on an event publishes the error and is noted as an event, once, with no retry', async () => {
  const noted = [];
  const {chat, calls, output} = fixture(async () => { throw Error('provider down'); }, {onFailure: info => noted.push(info)});
  await finish(chat, state({text: '', event: event('stood-up')}));
  assert.equal(calls.length, 1, 'no retry');
  assert.equal(output.at(-1).state, 'error');
  assert.equal(noted.length, 1);
  assert.equal(noted[0].event, 'stood-up');
  // A typed message's failure carries no event.
  const typed = []; const second = fixture(async () => { throw Error('provider down'); }, {onFailure: info => typed.push(info)});
  await finish(second.chat, state({text: 'hello'}));
  assert.equal(typed[0].event, undefined);
});

test('the failure log keeps only a line for an event: no automatic report, no count', async () => {
  const lines = [], reports = [], writes = [];
  const log = new PhoneFailureLog({log: line => lines.push(line), report: info => reports.push(info), write: async record => writes.push(record), provider: () => 'mistral'});
  await log.note({contact: 'judy', stage: 'provider', reason: 'timeout', detail: 'x', event: 'arrived'});
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^Phone chat arrived event failed: reason=timeout/);
  assert.equal(reports.length, 0);
  assert.equal(writes.length, 0);
  await log.note({contact: 'judy', stage: 'provider', reason: 'timeout', detail: 'x'});
  assert.match(lines[1], /^Phone chat message failed/);
  assert.equal(reports.length, 1);
  assert.equal(writes.length, 1);
});
