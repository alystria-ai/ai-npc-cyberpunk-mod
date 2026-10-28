// Why a Phone Chat message failed: the reason codes, the one log line, the state file the support report carries, and the first message
// of a text provider (Mistral, Local AI, the custom endpoint), which has no conversation session and used to be called "invalid".
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {PhoneChat} from './phone-chat.mjs';
import {PHONE_CODES, describePhoneFailure, phoneFailureLine, phoneFailureRecord, PhoneFailureLog, PHONE_NOT_A_FAULT, PHONE_STAGES} from './phone-failure.mjs';
import {TextProviderHost, mistralRoute} from './text-provider-host.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {MistralError} from './mistral-client.mjs';
import {TurnLimitError} from './shared-key-guard.mjs';

const MISTRAL_KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
const SECRET_WORDS = 'my secret plan for the heist at midnight';

// ---- reasons -----------------------------------------------------------------------------------------------------------------

const coded = (message, code) => Object.assign(Error(message), {code});
const CAUSES = [
  ['Phone knowledge: WORLD_UNAVAILABLE', 'route-world-unavailable', coded('Phone knowledge: WORLD_UNAVAILABLE', 'WORLD_UNAVAILABLE')],
  ['Player phone knowledge: REQUEST_NOT_PREPARED', 'route-request-not-prepared', coded('Player phone knowledge: REQUEST_NOT_PREPARED', 'REQUEST_NOT_PREPARED')],
  ['Player phone knowledge: MEMORY_ROUTE_CHANGED', 'route-memory-route-changed', coded('Player phone knowledge: MEMORY_ROUTE_CHANGED', 'MEMORY_ROUTE_CHANGED')],
  ['Player phone knowledge: WORLD_CHANGED', 'route-world-changed', coded('Player phone knowledge: WORLD_CHANGED', 'WORLD_CHANGED')],
  ['Invalid reply', 'invalid-reply', Error('Invalid reply')],
  ['Phone world changed', 'world-changed', Error('Phone world changed')],
  ['Phone memory binding changed', 'memory-route-changed', Error('Phone memory binding changed')],
  ['Invalid player memory route', 'memory-route-changed', Error('Invalid player memory route')],
  ['Phone contact is not supported', 'contact-unsupported', coded('Phone contact is not supported', 'CONTACT_UNSUPPORTED')],
  ['The character connection is still releasing. Please try again.', 'connection-busy', Error('The character connection is still releasing. Please try again.')],
  ['daily cap', 'daily-limit', new TurnLimitError('daily')],
  ['Convai concurrency', 'convai-busy', Error('HTTP 429: Concurrency limit reached')],
  ['Convai interactions', 'convai-quota', Error('Session ended [convai-quota:interaction]')],
  ['Convai memory users', 'convai-speaker-limit', Error('HTTP 429: LTM speaker limit reached')],
  ['Convai identity', 'convai-memory-needed', Error('Missing end_user_id. end_user_id is required when the character has Long Term Memory enabled.')],
  ['Convai key', 'convai-key-rejected', Error('{"detail": "Invalid API key"}')],
  ['Mistral key', 'mistral-key', new MistralError('key', 'did not accept the key', {provider: 'mistral'})],
  ['Mistral limit', 'mistral-limit', new MistralError('limit', 'rate limit', {provider: 'mistral'})],
  ['Local AI cannot start', 'local-unavailable', Error('Local AI could not start [local:unavailable]')],
  ['Local AI answered nothing', 'local-empty', new MistralError('empty', 'answered with no text', {provider: 'local'})],
  ['custom unreachable', 'custom-network', new MistralError('network', 'did not answer', {provider: 'custom'})],
  ['a stale conversation session', 'session-rejected', Error('Conversation session belongs to another user or scope')],
  ['hidden browser gone', 'browser', Error('Target page, context or browser has been closed')],
  ['no network', 'network', Error('fetch failed ECONNRESET')],
  ['timeout', 'timeout', Object.assign(Error('The operation was aborted due to timeout'), {name: 'TimeoutError'})],
  ['cancelled', 'cancelled', Object.assign(Error('Conversation cancelled'), {name: 'AbortError'})],
  ['anything else', 'unknown', Error('something nobody planned for')]];

for (const [name, reason, error] of CAUSES) {
  test(`a failed phone message names its cause: ${name} -> ${reason}`, () => {
    assert.equal(describePhoneFailure(error, 'provider').reason, reason);
  });
}

test('the stage is one of the named steps, and an unknown stage is read as the provider step; the detail is one clipped line', () => {
  for (const stage of PHONE_STAGES) assert.equal(describePhoneFailure(Error('x'), stage).stage, stage);
  assert.equal(describePhoneFailure(Error('x'), 'somewhere').stage, 'provider');
  const detail = describePhoneFailure(Error('first line\nsecond line\t' + 'x'.repeat(500)), 'route').detail;
  assert.ok(detail.length <= 160 && !/[\n\t]/.test(detail), detail);
  assert.equal(describePhoneFailure(undefined, 'route').reason, 'unknown');
});

test('the log line carries the reason, step, contact and provider, and the support record carries no detail text', () => {
  const line = phoneFailureLine({contact: 'judy', provider: 'local', stage: 'provider', reason: 'local-empty', detail: 'answered with no text'});
  assert.equal(line, 'Phone chat message failed: reason=local-empty stage=provider contact=judy provider=local detail="answered with no text"');
  assert.doesNotMatch(phoneFailureLine({contact: 'judy', stage: 'route', reason: 'unknown', detail: ''}), /detail=/);
  const record = phoneFailureRecord({previous: null, failure: {reason: 'local-empty', stage: 'provider', detail: 'answered with no text'}, provider: 'local', now: 5});
  assert.deepEqual(record, {version: 1, updated: 5, last: {at: 5, reason: 'local-empty', stage: 'provider', provider: 'local'}, count: 1, reasons: {'local-empty': 1}});
  assert.doesNotMatch(JSON.stringify(record), /answered with no text/);
  const next = phoneFailureRecord({previous: record, failure: {reason: 'timeout', stage: 'provider'}, provider: 'convai', now: 9});
  assert.equal(next.count, 2);
  assert.deepEqual(next.reasons, {'local-empty': 1, timeout: 1});
  assert.equal(next.last.reason, 'timeout');
  // A damaged previous record starts the count again instead of throwing.
  assert.equal(phoneFailureRecord({previous: {count: 'x', reasons: []}, failure: {reason: 'a', stage: 'route'}, now: 1}).count, 1);
});

// ---- the recorder ------------------------------------------------------------------------------------------------------------

test('PhoneFailureLog writes one line, queues the state file in order, reports faults but not the game moving on, and never throws', async () => {
  const lines = [], written = [], reported = [];
  const log = new PhoneFailureLog({log: line => lines.push(line), read: async () => ({version: 1, count: 4, reasons: {timeout: 4}}),
    write: async record => { await new Promise(done => setTimeout(done, 1)); written.push(record); }, report: info => reported.push(info.reason),
    provider: () => 'mistral', now: () => 77});
  log.note({contact: 'judy', stage: 'provider', reason: 'mistral-key', detail: 'did not accept the key', error: Error('x')});
  log.note({contact: 'judy', stage: 'route', reason: 'world-changed', detail: 'Phone world changed', error: Error('y')});
  await log.chain;
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Phone chat message failed: reason=mistral-key stage=provider contact=judy provider=mistral/);
  assert.deepEqual(reported, ['mistral-key'], 'a world change while sending is not an automatic report');
  assert.deepEqual(written.map(record => record.count), [5, 6], 'the count carries over from the file and the writes keep their order');
  assert.equal(written[1].last.reason, 'world-changed');
  assert.ok(PHONE_NOT_A_FAULT.has('cancelled'));
  const broken = new PhoneFailureLog({log: () => { throw Error('log'); }, read: async () => { throw Error('read'); }, write: async () => { throw Error('write'); },
    report: () => { throw Error('report'); }, provider: () => { throw Error('provider'); }});
  await broken.note({contact: 'judy', stage: 'route', reason: 'unknown', detail: ''});
});

// ---- PhoneChat: the failure is reported with its step and the player's text is unchanged -----------------------------------------

const now = 100000;
const binding = () => ({version: 1, status: 'available', authoritative: true, confidence: 'native-live', localUserId: 'user-1',
  campaignId: 'a'.repeat(32), branchId: 'b'.repeat(32), branchEpoch: 1, ledgerSequence: 10, generation: 1, activationId: 'c'.repeat(32)});
const request = (id = 'world-1-1', contact = 'judy', text = SECRET_WORDS) => ({version: 2, world: 'world-1', updated: now, active: true,
  saveIdentity: binding(), request: {id, contact, text, saveIdentity: binding()}});
function fixture(reply, options = {}) {
  const output = [], failures = [], calls = [], saved = [];
  const chat = new PhoneChat({contacts: [{contact: 'judy', key: 'judy-alvarez'}], ids: {'judy-alvarez': 'judy-id'}, now: () => now,
    reply: args => { calls.push(args); return reply(args); }, publish: async value => output.push(value),
    saveSessions: async value => saved.push(value), onFailure: info => failures.push(info), ...options});
  return {chat, output, failures, calls, saved};
}
async function send(chat, value) { await chat.accept(value); await chat.active?.work; }

test('a message that failed says the same short thing to the player, and the failure carries step, reason and contact but not the text', async () => {
  const {chat, output, failures} = fixture(async () => { throw new MistralError('key', 'did not accept the key', {provider: 'mistral'}); });
  await send(chat, request());
  const error = output.find(row => row.state === 'error');
  assert.equal(error.error, 'Message could not be delivered. Please try again.');
  assert.equal(failures.length, 1);
  assert.equal(failures[0].stage, 'provider');
  assert.equal(failures[0].reason, 'mistral-key');
  assert.equal(failures[0].contact, 'judy');
  assert.equal(failures[0].profileKey, 'judy-alvarez');
  assert.ok(!JSON.stringify({...failures[0], error: undefined}).includes(SECRET_WORDS));
});

test('each step of the send names itself: the route, an invalid reply, and the provider', async () => {
  const route = fixture(async () => ({text: 'x', sessionID: 'session'}), {contextFor: async () => { throw coded('Player phone knowledge: WORLD_UNAVAILABLE', 'WORLD_UNAVAILABLE'); }});
  await send(route.chat, request());
  assert.deepEqual([route.failures[0].stage, route.failures[0].reason], ['route', 'route-world-unavailable']);
  assert.equal(route.calls.length, 0, 'the provider is never asked when the route is not ready');
  for (const result of [{text: '', sessionID: 'session'}, {text: '  ', sessionID: 'session'}, {text: 'x'.repeat(6001), sessionID: 'session'},
    {text: 'hello', sessionID: 'x'.repeat(300)}, {text: 'hello', sessionID: 7}, null]) {
    const invalid = fixture(async () => result);
    await send(invalid.chat, request());
    assert.deepEqual([invalid.failures[0]?.stage, invalid.failures[0]?.reason], ['reply', 'invalid-reply'], JSON.stringify(result)?.slice(0, 40));
    assert.equal(invalid.output.at(-1).state, 'error');
  }
  const provider = fixture(async () => { throw Error('HTTP 429: Concurrency limit reached'); });
  await send(provider.chat, request());
  assert.deepEqual([provider.failures[0].stage, provider.failures[0].reason], ['provider', 'convai-busy']);
});

test('a contact the phone does not support is named in the failure record as well as shown to the player', async () => {
  const {chat, output, failures} = fixture(async () => ({text: 'x', sessionID: 'session'}));
  await send(chat, request('world-1-1', 'nobody'));
  assert.equal(output.at(-1).error, 'Conversation is unavailable for this contact.');
  assert.deepEqual([failures[0].stage, failures[0].reason, failures[0].contact], ['route', 'contact-unsupported', 'nobody']);
});

test('a message that was replaced by a newer one, or closed, is not a failure', async () => {
  let release; const gate = new Promise(done => { release = done; });
  const {chat, failures} = fixture(async () => { await gate; throw Error('late'); });
  await chat.accept(request('world-1-1'));
  const first = chat.active.work;
  chat.close();
  release();
  await first;
  assert.equal(failures.length, 0);
});

test('a failure hook that throws, or none at all, never changes the message the player sees', async () => {
  for (const onFailure of [() => { throw Error('hook'); }, undefined]) {
    const {chat, output} = fixture(async () => { throw Error('boom'); }, {onFailure});
    await send(chat, request());
    assert.equal(output.at(-1).error, 'Message could not be delivered. Please try again.');
  }
});

test('the shared key\'s daily limit still carries its code for the phone\'s own wording', async () => {
  const {chat, output, failures} = fixture(async () => { throw new TurnLimitError('daily'); }, {failureCode: () => 'daily-limit'});
  await send(chat, request());
  assert.equal(output.at(-1).errorCode, 'daily-limit');
  assert.equal(failures[0].reason, 'daily-limit');
  assert.equal(failures[0].errorCode, 'daily-limit');
});

// ---- the first message of a text provider ---------------------------------------------------------------------------------------

test('a reply with no conversation session ("-1" or none) is delivered and remembers no session', async () => {
  for (const sessionID of ['-1', undefined, null]) {
    const {chat, output, failures, saved} = fixture(async () => ({text: 'Hey V.', ...(sessionID === undefined ? {} : {sessionID})}));
    await send(chat, request());
    assert.deepEqual(output.map(row => row.state), ['sending', 'reply'], String(sessionID));
    assert.equal(output.at(-1).text, 'Hey V.');
    assert.equal(failures.length, 0);
    assert.equal(saved.length, 0);
    assert.equal(chat.transientSessions.size, 0, 'nothing to continue next time');
  }
});

test('a reply with a real session is still remembered and passed to the next message', async () => {
  const {chat, calls, output} = fixture(async ({sessionId}) => ({text: 'Hey V.', sessionID: sessionId === '-1' ? 'session-9' : sessionId}));
  await send(chat, request('world-1-1'));
  await send(chat, request('world-1-2'));
  assert.deepEqual(calls.map(call => call.sessionId), ['-1', 'session-9']);
  assert.equal(output.filter(row => row.state === 'reply').length, 2);
});

// A real text provider: the host hands back the session id it was given, which for a first message is "-1".
async function textHost() {
  const requests = [];
  const server = createServer((incoming, response) => {
    let raw = '';
    incoming.on('data', chunk => { raw += chunk; });
    incoming.on('end', () => {
      requests.push(JSON.parse(raw));
      response.writeHead(200, {'content-type': 'text/event-stream'});
      response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: 'Hey V, I read you. Meet me at the Afterlife.'}}]})}\n\n`);
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${MISTRAL_KEY}\n`, writeText: async () => {}});
  await provider.load();
  provider.setPreference('mistral'); provider.apply();
  const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
    ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
  const memory = await MistralMemory.open({path: null});
  const route = mistralRoute({provider, endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, gapMs: 0, cacheScope: 'scope1'});
  const host = new TextProviderHost({provider, memory, personas: new PersonaBook(roster), routes: {mistral: route}});
  return {host, requests, close: async () => { host.close(); await new Promise(done => { server.closeAllConnections?.(); server.close(done); }); }};
}

test('a phone message answered by Mistral, Local AI or the custom endpoint reaches the player on the very first message', async () => {
  const {host, requests, close} = await textHost();
  try {
    const bridgeReply = async options => host.reply({characterId: options.characterId, sessionId: options.sessionId, context: options.context,
      text: options.input.text, ttsEnabled: false, local: {profileKey: options.profileKey, name: 'Judy Alvarez', channel: 'phone'}}, {signal: options.signal});
    const {chat, output, failures} = fixture(bridgeReply);
    await send(chat, request('world-1-1', 'judy', 'Where are you tonight?'));
    assert.deepEqual(failures.map(row => row.reason), []);
    assert.deepEqual(output.map(row => row.state), ['sending', 'reply']);
    assert.match(output.at(-1).text, /Afterlife/);
    assert.equal(requests.length, 1);
    // The second message works the same way.
    await send(chat, request('world-1-2', 'judy', 'And tomorrow?'));
    assert.deepEqual(output.map(row => row.state), ['sending', 'reply', 'sending', 'reply']);
  } finally { await close(); }
});

test('the bridge wires the failure log into the phone chat, writes the state file and reports through the automatic error reports', async () => {
  const source = await readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(source, /import \{PhoneFailureLog, PHONE_CODES\} from '\.\/phone-failure\.mjs'/);
  assert.match(source, /failureCode: error => \{[^\n]*PHONE_CODES\.has\(code\)/, 'the phone passes the codes it has a status for');
  for (const code of ['daily-limit', 'quota-shared', 'quota-own', 'key-rejected', 'key-memory-needed']) assert.ok(PHONE_CODES.has(code), code);
  const lua = await readFile(new URL('../mod/phone-chat.lua', import.meta.url), 'utf8');
  for (const code of PHONE_CODES) if (code !== 'daily-limit') assert.ok(lua.includes(`['${code}'] =`), `${code} has a phone status line`);
  assert.match(source, /const phoneFailures = new PhoneFailureLog\(\{[\s\S]*?\}\);\s*const phone = new PhoneChat\(\{\s*onFailure: info => phoneFailures\.note\(info\),/);
  assert.match(source, /resolve\(runtime, 'phone-failure-state\.json'\)/);
  assert.match(source, /errorEvents\.turnFailed\(error, \{provider: provider \?\? 'convai', errorCode\}\)/);
  assert.doesNotMatch(source.match(/const phoneFailures = new PhoneFailureLog[\s\S]*?\}\);/)[0], /\.text\b|input\.text|\.message\b/, 'no message text reaches the log or the record');
});

// ---- the support report ------------------------------------------------------------------------------------------------------

test('the support report carries the last phone-chat failure reason, its step and provider, and none of the message text', async () => {
  const {collectReport} = await import('./support-report.mjs');
  const {plantedInstall} = await import('./support-report-fixture.mjs');
  const {join} = await import('node:path');
  const f = await plantedInstall();
  try {
    const stamp = Date.now();
    const make = () => collectReport({game: f.game, runtime: f.runtime, stateDirectory: f.state, project: f.project,
      request: {id: 'r-phone', issuedAt: stamp}, secrets: [], graphics: async () => [], now: () => stamp});
    assert.equal((await make()).summary.bridge.status['phone-failure-state.json']?.state, 'absent', 'no failure yet, nothing claimed');
    const record = phoneFailureRecord({previous: null, failure: {reason: 'local-empty', stage: 'provider', detail: SECRET_WORDS}, provider: 'local', now: stamp});
    await f.put(join(f.runtime, 'phone-failure-state.json'), JSON.stringify(record));
    const {summary, entries} = await make();
    const row = summary.bridge.status['phone-failure-state.json'].value;
    assert.equal(row.last.reason, 'local-empty');
    assert.equal(row.last.stage, 'provider');
    assert.equal(row.last.provider, 'local');
    assert.equal(row.count, 1);
    assert.ok(!JSON.stringify([summary, entries.map(entry => entry.data)]).includes(SECRET_WORDS));
  } finally { await f.cleanup(); }
});
