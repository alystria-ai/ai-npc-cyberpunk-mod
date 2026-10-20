// Companion actions on every text provider (docs/MISTRAL.md, "Companion actions"): Mistral, the local AI and the custom provider all decide an action
// through bridge/text-actions.mjs (a one-word decision request, a GAME ACTIONS note in the reply prompt, the same message to the game that the
// Convai client sends), and a plain request ("drive me") is still honoured when the decision failed or said none. Offline: the custom provider runs
// against the loopback mock, the others against fake chat functions. No game, no Convai, no real network.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {explicitRequest, screenWords} from './text-action-words.mjs';
import {actionMenu, splitActions} from './text-actions.mjs';
import {TextProviderHost, customRoute, localRoute, mistralRoute} from './text-provider-host.mjs';
import {CustomEndpoint, parseEndpointUrl} from './custom-endpoint.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {streamChat} from './mistral-client.mjs';
import {startOpenAiMock} from './openai-mock-server.mjs';

const KEY = 'test' + 'x'.repeat(28);
const TOKEN = 'drive-0123456789abcdefghij';
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);
const quick = {firstByteMs: 600, retryFirstByteMs: 600, totalMs: 2500, retries: 1, backoffMs: [5]};
const ride = (extra = {}) => ({version: 1, token: TOKEN, source: 'private-text', expiresAt: 99999, carName: 'Quadra Type-66', destinationName: 'Afterlife', ...extra});
const noRide = (extra = {}) => ({version: 1, token: TOKEN, source: 'private-text', expiresAt: 99999, drive: false, ...extra});
const turn = (text, extra = {}) => ({text, context: 'CURRENT PERSON', sessionId: 'session-1',
  contextParts: {now: 'Right now: you are with V in person.', notes: '', world: 'Quest: Heist.', volatile: 'Whether you ask V anything is your own call.'},
  local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}, ...extra});
const settle = () => new Promise(done => setTimeout(done, 10));
const isDecision = body => /^You read one message from V/.test(body?.messages?.[0]?.content ?? '');

// ---- The plain-request safety net --------------------------------------------------------------------------------------------

test('plain requests for a ride, an attack or to come along are read as the action, in the usual phrasings', () => {
  const rows = [
    ['drive me', 'DRIVE'], ['Drive for me.', 'DRIVE'], ['Judy, drive me to the waypoint', 'DRIVE'], ['can you drive me there?', 'DRIVE'],
    ['could you please take the wheel', 'DRIVE'], ['take me to the marker', 'DRIVE'], ['Hey, give me a ride!', 'DRIVE'], ['I need you to drive us', 'DRIVE'],
    ['attack him', 'FIGHT'], ['Take him out.', 'FIGHT'], ['kill that guy', 'FIGHT'], ['go after them', 'FIGHT'], ['Attack!', 'FIGHT'], ['please shoot the target', 'FIGHT'],
    ['follow me', 'FOLLOW'], ['Come with me.', 'FOLLOW'], ['come along', 'FOLLOW'], ['can you come with me for a while?', 'FOLLOW'], ['tag along', 'FOLLOW'],
  ];
  for (const [line, code] of rows) assert.equal(explicitRequest(line), code, line);
});

test('questions about the character, conditions, refusals, memories and look-alikes are never read as a request', () => {
  const rows = [
    'do you know how to drive?', 'did you ever drive a Quadra?', 'what is it like to attack a convoy', 'would you ever follow me', 'remember when you drove me home',
    "don't drive me anywhere", 'if you drive me there I will pay you', 'I wish you would take the wheel someday', 'attack of the clones is a bad movie', 'my driver quit and I miss the drive',
    'how do I drive this thing', 'I used to fight in the pits', 'she told him to follow the money', 'I will follow you later', 'you can go',
    'go home', "we're done here", 'I will drive myself', 'do not attack him', 'maybe come with me tomorrow', 'why would I follow you', 'never follow me',
  ];
  for (const line of rows) assert.equal(explicitRequest(line), null, line);
  // Two different actions in one line: nothing is guessed. Nothing offered: nothing.
  assert.equal(explicitRequest('drive me there. attack him.'), null);
  assert.equal(explicitRequest('drive me', {codes: ['FIGHT']}), null);
  assert.equal(explicitRequest('drive me', {codes: []}), null);
  assert.equal(explicitRequest('x '.repeat(200) + 'drive me'), null);
});

test('every plain request passes the keyword screen (the safety net only ever runs on lines the screen let through)', () => {
  for (const line of ['drive me', 'Drive for me.', 'take the wheel', 'take me to the waypoint', 'give me a ride', 'be my driver', 'attack him', 'take him out', 'go after them',
    'shoot the target', 'kill that guy', 'Attack!', 'follow me', 'come with me', 'come along', 'tag along', 'join me', 'travel with us', 'walk with me']) {
    const code = explicitRequest(line);
    assert.ok(code, line);
    assert.ok(screenWords(line, {codes: [code]}).includes(code), `${line} -> ${code}`);
  }
});

test('the menu only offers a plain request that the game offered this turn, and never a leave', () => {
  const driveOnly = actionMenu(ride());
  assert.deepEqual(driveOnly.explicit('drive me'), {code: 'DRIVE', argument: ''});
  assert.equal(driveOnly.explicit('attack him'), null, 'an attack the game did not offer');
  assert.equal(driveOnly.explicit('follow me'), null);
  const leaving = actionMenu(noRide({leave: {members: [{name: 'Judy Alvarez', self: true}]}}));
  for (const line of ['you can go', 'go home', 'get lost', 'leave', 'we are done']) assert.equal(leaving.explicit(line), null, line);
  assert.equal(actionMenu(noRide({tactic: {targetName: 'Gonk', hostile: true, distance: 10, kinds: ['fight']}})).explicit('kill him').code, 'FIGHT');
});

test('a code a text model writes anyway is still cut out, and nothing here changes how it is cut', () => {
  assert.equal(splitActions('[DRIVE] Sure, hop in.').text, 'Sure, hop in.');
});

// ---- The custom provider, a whole turn --------------------------------------------------------------------------------------

async function customHarness(mock, {local = true, noThinking = false} = {}) {
  const custom = new CustomEndpoint({path: null});
  await custom.setUrl(parseEndpointUrl(mock.url)); await custom.setModel('vendor/test-model');
  await custom.setKey(KEY);
  if (!local) Object.defineProperty(custom, 'local', {get: () => false});
  if (noThinking) Object.defineProperty(custom, 'noThinking', {get: () => ({reasoning_effort: 'none'})});
  const provider = new MistralProvider({keyPath: 'k', readText: async () => { throw Error('none'); }, writeText: async () => {}, custom});
  await provider.load(); provider.setPreference('custom'); provider.apply();
  const delivered = [], logs = [];
  const route = customRoute({provider, custom, chat: options => streamChat({...options, ...quick})});
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: book, routes: {custom: route},
    log: line => logs.push(line), deliverAction: async message => { delivered.push(message); return true; }});
  return {host, delivered, logs, route};
}
const answer = (decide, reply = 'Sure thing, V.') => request => ({sse: [isDecision(request.body) ? decide(request.body.messages.at(-1).content) : reply]});

test('custom provider: the decision asks one word, the reply is told about it, the game gets the drive message and no code is spoken', async () => {
  for (const local of [true, false]) {
    const mock = await startOpenAiMock();
    const {host, delivered} = await customHarness(mock, {local});
    try {
      mock.behave(answer(() => 'DRIVE', 'Hop in, V. [DRIVE] I will take us there.'));
      const result = await host.reply(turn('could you drive for me, Judy?', {companionAction: ride()}));
      await settle();
      assert.deepEqual(delivered, [{version: 1, token: TOKEN}], `local ${local}`);
      assert.equal(result.text, 'Hop in, V. I will take us there.');
      const decision = mock.requests.find(request => isDecision(request.body)), reply = mock.requests.find(request => !isDecision(request.body));
      assert.equal(decision.body.max_tokens, 12);
      assert.match(reply.body.messages.at(-1).content, /GAME ACTIONS: V is asking you to drive them in their car "Quadra Type-66" to the map destination "Afterlife"/);
    } finally { host.close(); await mock.close(); }
  }
});

test('custom provider: ordinary talk sends no decision, a question about driving is decided as none, and nothing starts', async () => {
  const mock = await startOpenAiMock();
  const {host, delivered} = await customHarness(mock);
  try {
    mock.behave(answer(() => 'NONE', 'Fine.'));
    await host.reply(turn('how was your day, Judy?', {companionAction: ride()}));
    await host.reply(turn('do you know how to drive?', {companionAction: ride()}));
    await settle();
    assert.deepEqual(delivered, []);
    assert.equal(mock.requests.filter(request => isDecision(request.body)).length, 1, 'only the line about driving reached the decision');
  } finally { host.close(); await mock.close(); }
});

test('custom provider: the model says none to "drive me there", and the plain request still starts the ride; a look-alike does not', async () => {
  const mock = await startOpenAiMock();
  const {host, delivered, logs} = await customHarness(mock);
  try {
    mock.behave(answer(() => 'NONE', 'On it, V.'));
    await host.reply(turn('drive me to the waypoint', {companionAction: ride()}));
    await settle();
    assert.deepEqual(delivered, [{version: 1, token: TOKEN}]);
    assert.ok(logs.some(line => /action DRIVE: answered none or unclear, V's words ask for it plainly/.test(line)), logs.join('|'));
    delivered.length = 0;
    await host.reply(turn('my father used to drive me to school', {companionAction: ride()}));
    await host.reply(turn('I will not drive me anywhere', {companionAction: ride()}));
    await settle();
    assert.deepEqual(delivered, []);
  } finally { host.close(); await mock.close(); }
});

test('custom provider: a decision request that fails (the server errors on it) does not lose a plain request, and does not fail the reply', async () => {
  const mock = await startOpenAiMock();
  const {host, delivered, logs} = await customHarness(mock);
  try {
    mock.behave(request => isDecision(request.body) ? {status: 500, body: {error: {message: 'boom'}}} : {sse: ['Right behind you, V.']});
    const result = await host.reply(turn('follow me', {companionAction: noRide({follow: {name: 'Judy Alvarez'}})}));
    await settle();
    assert.equal(result.text, 'Right behind you, V.');
    assert.deepEqual(delivered, [{version: 1, token: TOKEN, follow: true}]);
    assert.ok(logs.some(line => /action decision failed/.test(line)));
    delivered.length = 0;
    const second = await host.reply(turn('would you maybe consider coming along sometime', {companionAction: noRide({follow: {name: 'Judy Alvarez'}})}));
    await settle();
    assert.equal(second.text, 'Right behind you, V.');
    assert.deepEqual(delivered, [], 'an unclear line is not guessed');
  } finally { host.close(); await mock.close(); }
});

test('custom provider: an unclear answer or one for an action that was not offered never delivers, whatever the line says', async () => {
  for (const said of ['Judy go home', 'you can go now', 'get lost']) {
    const mock = await startOpenAiMock();
    const {host, delivered} = await customHarness(mock);
    try {
      mock.behave(answer(() => 'NONE', 'Fine.'));
      await host.reply(turn(said, {companionAction: noRide({leave: {members: [{name: 'Judy Alvarez', self: true}]}})}));
      await settle();
      assert.deepEqual(delivered, [], said);
    } finally { host.close(); await mock.close(); }
  }
});

test('custom provider: a model that thinks first is asked the decision again with no-thinking fields, so the first request of a session is not lost', async () => {
  const mock = await startOpenAiMock();
  const {host, delivered, route} = await customHarness(mock, {noThinking: true});
  try {
    let decisions = 0;
    mock.behave(request => {
      if (!isDecision(request.body)) return {sse: ['Sure, V.']};
      decisions++;
      return 'reasoning_effort' in request.body ? {sse: ['FOLLOW']}
        : {sse: [{reasoning: 'Let me think...'}], finish: 'length', usage: {completion_tokens: 12, completion_tokens_details: {reasoning_tokens: 12}}};
    });
    await host.reply(turn('walk along with me, would you', {companionAction: noRide({follow: {name: 'Judy Alvarez'}})}));
    await settle();
    assert.equal(decisions, 2, 'asked once, then again with the fields that ask for no thinking');
    assert.deepEqual(delivered, [{version: 1, token: TOKEN, follow: true}]);
    const sizes = mock.requests.filter(request => isDecision(request.body)).map(request => request.body.max_tokens);
    assert.deepEqual(sizes, [12, 12], 'no larger room for a one-word answer');
    assert.equal(route.adaptation().thinks, true, 'the next requests carry the no-thinking fields from the start');
  } finally { host.close(); await mock.close(); }
});

// ---- Mistral and the local AI go through the same host ----------------------------------------------------------------------

async function fakeChatHost(route, name) {
  const delivered = [], seen = [];
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${KEY}\n`, writeText: async () => {}});
  await provider.load(); provider.setPreference(name === 'local' ? 'local' : 'mistral'); provider.apply();
  const chat = route.chat;
  route.chat = async options => {
    seen.push(options.messages);
    const reply = isDecision({messages: options.messages}) ? 'NONE' : 'Sure, V.';
    options.onDelta?.(reply);
    return {text: reply, model: 'm', finishReason: 'stop', usage: {}, attempts: 1, failed: [], trace: {}};
  };
  void chat;
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: book, routes: {[name]: route},
    log: () => {}, deliverAction: async message => { delivered.push(message); return true; }});
  return {host, delivered, seen};
}

test('Mistral: a decision that says none still honours a plain request, and Local AI (one request at a time) does the same', async () => {
  const provider = {apiKey: KEY, noteSuccess() {}, noteLimit() {}, limit: null};
  const mistral = await fakeChatHost(mistralRoute({provider, gapMs: 0}), 'mistral');
  try {
    await mistral.host.reply(turn('take the wheel', {companionAction: ride()}));
    await settle();
    assert.deepEqual(mistral.delivered, [{version: 1, token: TOKEN}]);
    assert.ok(mistral.seen.some(messages => isDecision({messages})), 'the decision was asked');
  } finally { mistral.host.close(); }
  const server = {ensure: async () => ({apiKey: KEY, endpoint: 'http://127.0.0.1:1/v1/chat/completions', model: 'm', requestModel: 'm', trustedOrigin: 'http://127.0.0.1:1', contextSize: 0}),
    status: () => ({state: 'ready', model: 'm'}), begin: () => () => {}, touch() {}, preempt: () => false, noteSlot() {}};
  const local = await fakeChatHost(localRoute({server, provider: {noteLocalFailure() {}}}), 'local');
  try {
    assert.equal(local.host.routes.local.parallel, false);
    await local.host.reply(turn('attack him', {companionAction: noRide({tactic: {targetName: 'Gonk', hostile: true, distance: 9, kinds: ['fight']}})}));
    await settle();
    assert.deepEqual(local.delivered, [{version: 1, token: TOKEN, tactic: 'fight'}]);
  } finally { local.host.close(); }
});
