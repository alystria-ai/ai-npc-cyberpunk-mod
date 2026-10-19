// Failure and fallback paths of the text routes (bridge/text-provider-host.mjs) that text-provider-host.test.mjs does not pin: the turn
// handed from the local AI to Mistral exactly once per failure, a start that failed, a cancelled turn that must not fall back, a reply
// that already reached the voice, the provider's limit notes, observers that throw, a key saved while a turn is running, a summary that
// failed, a speculative turn whose words were not confirmed, and the text a player can see never holding a key or a provider body.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {TextProviderHost, attachTextProvider, localRoute, mistralRoute, isLocalUnavailable, HOLDING_LINES} from './text-provider-host.mjs';
import {MistralMemory, MEMORY_LIMITS} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {ReplyStream} from './reply-stream.mjs';
import {errorCodeFor, failureKind, MistralError} from './mistral-client.mjs';

const KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
const OTHER_KEY = 'Zy9xW8vU7tS6rQ5pO4nM3lK2jI1hG0fE';
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);
const QUICK = {firstByteMs: 400, retryFirstByteMs: 400, stallMs: 400, retries: 1, backoffMs: [5]};
const wait = ms => new Promise(done => setTimeout(done, ms));

// A fake provider over a local http server. The script answers (body, count): a string is streamed as the reply; {status, message, headers}
// is an error; {hang: true} never answers; {delayMs, ...} waits first; {stream, end} writes raw event text (end: false leaves it open).
async function fakeServer(script) {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      requests.push({headers: request.headers, body: JSON.parse(raw)});
      const answer = script(requests.at(-1).body, requests.length);
      const respond = () => {
        if (answer?.hang) return;
        if (answer?.stream !== undefined) {
          response.writeHead(200, {'content-type': 'text/event-stream'});
          response.write(answer.stream);
          if (answer.end !== false) response.end();
          return;
        }
        if (typeof answer === 'object' && answer.status) {
          response.writeHead(answer.status, {'content-type': 'application/json', ...answer.headers});
          response.end(JSON.stringify({error: {code: answer.status, message: answer.message ?? 'failed'}}));
          return;
        }
        response.writeHead(200, {'content-type': 'text/event-stream'});
        for (const piece of String(answer).match(/.{1,12}/gs) ?? []) response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: piece}}]})}\n\n`);
        response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`);
      };
      if (answer?.delayMs) setTimeout(respond, answer.delayMs); else respond();
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {requests, endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); })};
}

const turn = (text, extra = {}) => ({text, context: 'CURRENT PERSON\nQuest facts here.', sessionId: 'session-1',
  local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}, ...extra});
const READY_LINE = 'Sure thing, V. Come on in and sit down.';
// A character that says a line again is asked once more (bridge/text-provider-host.mjs), so replies that must each cost one request differ.
const LINES = ['Sure thing, V. Come on in and sit down.', 'Nothing much, V. Just fixing a rig in the back.', 'Careful with that one, V. It bites when it is cold.',
  'Not tonight, V. The street is too loud for talking.', 'Fine by me, V. Pull the door shut behind you.', 'Later, V. I still have a delivery to finish.'];
const nextLine = (_body, count) => LINES[(count - 1) % LINES.length];

async function makeProvider({key = KEY, preference = 'local', apply = true} = {}) {
  const store = {text: key ? `api-key=${key}\n` : ''};
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => store.text, writeText: async (path, text) => { store.text = text; }, removeFile: async () => { store.text = ''; }});
  await provider.load();
  provider.setPreference(preference);
  if (apply) provider.apply();
  return provider;
}

// The local AI with a Mistral key saved: the local route first, Mistral behind it. The local server is a stub whose address is a fake llama-server.
async function both({local, mistral, key = KEY, ensure, withMistralRoute = true} = {}) {
  const llama = await fakeServer(local), cloud = await fakeServer(mistral ?? nextLine);
  const calls = {ensure: 0, lost: 0, keyRefused: 0, prewarm: 0};
  const server = {status: () => ({state: 'ready'}), touch() {}, prewarm: async () => { calls.prewarm++; },
    externalLost: () => { calls.lost++; }, externalKeyRefused: () => { calls.keyRefused++; },
    ensure: async (...args) => { calls.ensure++; return ensure ? ensure(...args) : {endpoint: llama.endpoint, apiKey: 'session-key-abcdef123456', model: 'qwen-test'}; }};
  const provider = await makeProvider({key});
  const memory = await MistralMemory.open({path: null}), logs = [];
  const localSide = localRoute({server, provider});
  localSide.chatDefaults = {retries: 1, backoffMs: [5], firstByteMs: 2000, totalMs: 5000};
  const routes = {local: localSide, ...(withMistralRoute ? {mistral: mistralRoute({provider, endpoint: cloud.endpoint, gapMs: 0, chatDefaults: QUICK})} : {})};
  const host = new TextProviderHost({provider, memory, personas: book, routes, log: line => logs.push(line)});
  return {llama, cloud, calls, server, provider, memory, logs, host, close: async () => { host.close(); await llama.close(); await cloud.close(); }};
}

async function cloudOnly(script, {key = KEY, route = {}, hostOptions = {}} = {}) {
  const cloud = await fakeServer(script);
  const provider = await makeProvider({key, preference: 'mistral'});
  const memory = await MistralMemory.open({path: null}), logs = [];
  const mistral = mistralRoute({provider, endpoint: cloud.endpoint, gapMs: 0, chatDefaults: QUICK, ...route});
  const host = new TextProviderHost({provider, memory, personas: book, routes: {mistral}, log: line => logs.push(line), idleRetryMs: 10, ...hostOptions});
  return {cloud, provider, memory, logs, host, mistral, close: async () => { host.close(); await cloud.close(); }};
}

// ---- the local AI hands a failed turn to Mistral, once ---------------------------------------------------------------------------------

test('a local turn that fails is handed to Mistral once; each failed turn costs the local server its own retry and Mistral one request, never a storm', async () => {
  const {llama, cloud, calls, provider, host, logs, close} = await both({local: () => ({status: 503, message: 'overloaded'})});
  try {
    const first = await host.reply(turn('hello'));
    assert.equal(first.transport, 'mistral');
    assert.equal(first.text, LINES[0]);
    assert.equal(llama.requests.length, 2, 'the local server was asked, and once more');
    assert.equal(cloud.requests.length, 1, 'Mistral answered the turn once');
    assert.equal(calls.lost, 1, 'a server that did not answer is looked at again before the next turn');
    assert.equal(provider.localBroken, null, 'one bad turn is not a failed start');
    assert.equal(provider.applied, 'local', 'the local AI stays the provider');
    assert.equal(provider.takeNotice(), 'local-turn-fallback');
    assert.equal(provider.takeNotice(), undefined, 'one notice per fallback');
    assert.equal(logs.filter(line => /could not answer .*using Mistral/.test(line)).length, 1);
    const second = await host.reply(turn('hello again'));
    assert.equal(second.transport, 'mistral');
    assert.equal(llama.requests.length, 4); assert.equal(cloud.requests.length, 2);
  } finally { await close(); }
});

test('a local AI that cannot start answers the turn through Mistral, remembers the failure once, and is not started again after the switch', async () => {
  const unavailable = () => Object.assign(new Error('The local AI is not available [local:unavailable]'), {reason: 'low-memory'});
  const {cloud, calls, provider, host, close} = await both({local: () => 'never asked', ensure: async () => { throw unavailable(); }});
  try {
    const result = await host.reply(turn('hello'));
    assert.equal(result.transport, 'mistral');
    assert.equal(calls.ensure, 1);
    assert.equal(provider.localBroken, 'low-memory');
    assert.equal(provider.requested, 'mistral');
    assert.equal(provider.localTurnNoticePending, false, 'a start that failed has its own notice, not the per-turn one');
    assert.equal(provider.apply(), true);
    assert.equal(provider.takeNotice(), 'local-fallback');
    assert.equal(provider.takeNotice(), undefined);
    await host.reply(turn('and again'));
    assert.equal(calls.ensure, 1, 'with Mistral as the provider the local server is not asked to start for every turn');
    assert.equal(cloud.requests.length, 2);
  } finally { await close(); }
});

test('with no Mistral key a failed local turn is an error the game can name (local-failed): no holding line, nothing remembered, the server looked at again', async () => {
  const {llama, calls, host, memory, close} = await both({local: () => ({status: 503, message: 'overloaded'}), key: null, withMistralRoute: false});
  try {
    const error = await host.reply(turn('hello')).catch(caught => caught);
    assert.ok(error instanceof MistralError);
    assert.equal(failureKind(error), 'network');
    assert.equal(errorCodeFor(error), 'local-failed');
    assert.ok(!HOLDING_LINES.includes(error.message));
    assert.equal(llama.requests.length, 2);
    assert.equal(calls.lost, 1);
    assert.deepEqual(memory.recall({profileKey: 'judy-alvarez', channel: 'private'}).turns, []);
  } finally { await close(); }
});

test('a turn the player cancels is never handed on: no second route, no failure note, the voice\'s stream is failed', async () => {
  const {cloud, calls, provider, host, close} = await both({local: () => ({hang: true})});
  try {
    const controller = new AbortController();
    const stream = new ReplyStream({name: 'Judy Alvarez'});
    const pending = host.reply(turn('hello'), {signal: controller.signal, stream});
    await wait(40);
    controller.abort();
    const error = await pending.catch(caught => caught);
    assert.equal(error.name, 'AbortError');
    assert.ok(!(error instanceof MistralError));
    assert.equal(cloud.requests.length, 0, 'Mistral is not asked for a turn that was cancelled');
    assert.equal(calls.lost, 0, 'a cancelled request says nothing about the server');
    assert.equal(provider.limit, null);
    assert.equal(provider.takeNotice(), undefined);
    assert.equal(stream.complete, true);
    await assert.rejects(stream.finished);
  } finally { await close(); }
});

test('once the first sentence reached the voice, a local server that dies is not replaced by Mistral: two different replies would be spoken', async () => {
  const half = `data: ${JSON.stringify({choices: [{index: 0, delta: {content: 'Hey V, good to see you here again. What can'}}]})}\n\n`;
  const {cloud, host, memory, close} = await both({local: () => ({stream: half})});
  try {
    const stream = new ReplyStream({name: 'Judy Alvarez'});
    const error = await host.reply(turn('hello'), {stream}).catch(caught => caught);
    assert.equal(failureKind(error), 'network');
    assert.equal(stream.head, 'Hey V, good to see you here again.', 'the voice already had this sentence');
    assert.equal(cloud.requests.length, 0);
    assert.deepEqual(memory.recall({profileKey: 'judy-alvarez', channel: 'private'}).turns, []);
    assert.equal(stream.complete, true);
  } finally { await close(); }
});

test('a local server whose first look could not tell about its key is named once when a turn is refused, and the cloud answers that turn', async () => {
  const {calls, cloud, host, close} = await both({local: () => ({status: 401, message: 'Unauthorized'})});
  try {
    const result = await host.reply(turn('hello'));
    assert.equal(result.transport, 'mistral');
    assert.equal(calls.keyRefused, 1);
    assert.equal(calls.lost, 0, 'a refused key is not a server that went away');
    assert.equal(cloud.requests.length, 1);
  } finally { await close(); }
});

test('a start that fails while a warm-up runs is noticed (the provider is marked), never thrown, and a warm-up through the attached host cannot reject', async () => {
  const {host, provider, logs, calls, close} = await both({local: () => 'x'});
  try {
    host.routes.local.prewarm = async () => { throw Object.assign(new Error('The local AI is not available [local:unavailable]'), {reason: 'no-gpu'}); };
    await host.prewarm(turn('hi'));
    assert.equal(provider.localBroken, 'no-gpu');
    assert.ok(logs.some(line => line.startsWith('prewarm failed')), logs.join('|'));
    const original = {reply: async () => ({}), prepare: async () => ({}), warm: async () => ({}), readiness: async () => ({}), lateEmotion: async () => ({}),
      refreshIdle: async () => true, voiceChannel: () => ({})};
    attachTextProvider(original, {provider, mistral: host});
    provider.localBroken = null; provider.preference = 'local';
    assert.deepEqual(await original.warm({local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez'}}), {connectionMs: 0, provider: 'local'});
    await wait(20);
    assert.equal(provider.localBroken, 'no-gpu', 'the failed warm-up was recorded without anyone awaiting it');
    // Without a profile in the warm-up the server is only asked to be ready, and a failure there is recorded too.
    host.routes.local.connect = async () => { throw Object.assign(new Error('The local AI is not available [local:unavailable]'), {reason: 'start-failed'}); };
    provider.localBroken = null;
    await host.prewarm({});
    assert.equal(provider.localBroken, 'start-failed');
    assert.equal(calls.ensure, 0);
  } finally { await close(); }
});

// ---- Mistral: limits, observers, keys, summaries ---------------------------------------------------------------------------------------

test('what Mistral refused is noted on the provider (a bad key, a limit, a missing model), stops summaries while the key is bad, and the next good reply clears it', async () => {
  let mode = {status: 401, message: 'Unauthorized'};
  const {host, provider, mistral, close} = await cloudOnly((body, count) => typeof mode === 'function' ? mode(body, count) : mode);
  try {
    await assert.rejects(host.reply(turn('one')), error => failureKind(error) === 'key');
    assert.equal(provider.limit.kind, 'invalid');
    assert.equal(mistral.summarizeAllowed(), false, 'no background request while the key is refused');
    mode = nextLine;
    await host.reply(turn('two'));
    assert.equal(provider.limit, null);
    assert.equal(mistral.summarizeAllowed(), true);
    mode = {status: 429, message: 'Rate limit reached: tokens per day (TPD)'};
    await assert.rejects(host.reply(turn('three')), error => failureKind(error) === 'limit');
    assert.equal(provider.limit.kind, 'rate');
    mode = () => 'Fine by me, V. Pull the door shut behind you.';
    await host.reply(turn('four'));
    assert.equal(provider.limit, null);
    mode = {status: 404, message: 'Model not found'};
    await assert.rejects(host.reply(turn('five')), error => failureKind(error) === 'model');
    assert.equal(provider.limit.kind, 'model');
  } finally { await close(); }
});

test('an observer of the route that throws (onSuccess, onFailure) changes neither a reply nor the error the player gets', async () => {
  const seen = [];
  const {host, close} = await cloudOnly((_body, count) => count === 1 ? READY_LINE : {status: 401, message: 'Unauthorized'},
    {route: {onSuccess: () => { seen.push('success'); throw Error('observer fault'); }, onFailure: () => { seen.push('failure'); throw Error('observer fault'); }}});
  try {
    assert.equal((await host.reply(turn('one'))).text, READY_LINE);
    const error = await host.reply(turn('two')).catch(caught => caught);
    assert.equal(failureKind(error), 'key');
    assert.deepEqual(seen, ['success', 'failure']);
  } finally { await close(); }
});

test('the error a player can see, and every log line, hold neither the key nor what the provider wrote in its body', async () => {
  const body = `Invalid key ${KEY} for account private-details-4411 <html>gateway</html>`;
  const {host, logs, close} = await cloudOnly(() => ({status: 401, message: body}));
  try {
    const error = await host.reply(turn('hello')).catch(caught => caught);
    assert.equal(failureKind(error), 'key');
    assert.match(error.message, /^Mistral did not accept the API key \[mistral:key\]$/);
    assert.doesNotMatch(`${error.message}\n${logs.join('\n')}`, new RegExp(`${KEY}|private-details|gateway`));
  } finally { await close(); }
  const server = await cloudOnly(() => ({status: 500, message: body}), {key: KEY});
  try {
    const result = await server.host.reply(turn('hello'));
    assert.ok(HOLDING_LINES.includes(result.text), 'a server fault is a holding line, not the provider\'s words');
    assert.doesNotMatch(`${JSON.stringify(result)}\n${server.logs.join('\n')}`, new RegExp(`${KEY}|private-details|gateway`));
  } finally { await server.close(); }
});

test('a key saved while a turn is running applies from the next turn: every request of the running turn, its retry included, carries the old key', async () => {
  const {cloud, host, provider, logs, close} = await cloudOnly((_body, count) => count === 1 ? {status: 503, message: 'busy', delayMs: 80} : nextLine(_body, count));
  try {
    const running = host.reply(turn('one'));
    while (!cloud.requests.length) await wait(5);
    await provider.save(OTHER_KEY);
    assert.equal((await running).text, LINES[1]);
    assert.equal(cloud.requests.length, 2, 'the busy answer was asked again');
    assert.deepEqual(cloud.requests.map(request => request.headers.authorization), [`Bearer ${KEY}`, `Bearer ${KEY}`]);
    await host.reply(turn('two'));
    assert.equal(cloud.requests.at(-1).headers.authorization, `Bearer ${OTHER_KEY}`);
    assert.doesNotMatch(logs.join('\n'), new RegExp(`${KEY}|${OTHER_KEY}`));
  } finally { await close(); }
});

test('a model that answers nothing is asked twice by the client and then fails as an empty answer: no third ask from the character retry, nothing remembered', async () => {
  const empty = `data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`;
  const {cloud, host, memory, close} = await cloudOnly(() => ({stream: empty}));
  try {
    const error = await host.reply(turn('hello')).catch(caught => caught);
    assert.equal(failureKind(error), 'empty');
    assert.equal(cloud.requests.length, 2);
    assert.deepEqual(memory.recall({profileKey: 'judy-alvarez', channel: 'private'}).turns, []);
    assert.equal(errorCodeFor(error), undefined);
  } finally { await close(); }
});

test('a summary that fails leaves the host able to try again: nothing stays marked busy, the exchanges wait, and the next try folds them in', async () => {
  let summaryOk = false;
  const isSummary = body => /private memory/.test(body.messages[0].content);
  const {host, memory, cloud, close} = await cloudOnly(body => isSummary(body) ? (summaryOk ? 'I told V my plans.' : {status: 500, message: 'down'}) : 'Fine.');
  try {
    for (let i = 0; i < MEMORY_LIMITS.turns + MEMORY_LIMITS.batch; i++) await host.reply(turn(`question ${i}`));
    await wait(150);
    assert.ok(cloud.requests.filter(request => isSummary(request.body)).length >= 1, 'a summary was asked for');
    assert.equal(host.summaries.size, 0, 'the character is not left marked as being summarised');
    assert.ok(memory.pendingSummary('judy-alvarez'), 'the exchanges are still waiting for a summary');
    assert.equal(memory.recall({profileKey: 'judy-alvarez', channel: 'private'}).summary, '');
    summaryOk = true;
    await host.reply(turn('one more'));
    await wait(150);
    assert.equal(memory.recall({profileKey: 'judy-alvarez', channel: 'private'}).summary, 'I told V my plans.');
    assert.equal(host.summaries.size, 0);
  } finally { await close(); }
});

// ---- a speculative turn whose words were not confirmed -----------------------------------------------------------------------------------

test('a turn started on live words is remembered only once the words are confirmed; words that are not confirmed leave no trace and end the turn with that error', async () => {
  const {host, memory, close} = await cloudOnly(() => READY_LINE);
  try {
    let confirm;
    const confirmed = new Promise(done => { confirm = done; });
    const running = host.reply(turn('hello there'), {confirmed});
    await wait(80);
    assert.deepEqual(memory.recall({profileKey: 'judy-alvarez', channel: 'private'}).turns, [], 'the reply is written but not remembered while the words are unconfirmed');
    confirm();
    assert.equal((await running).text, READY_LINE);
    assert.equal(memory.recall({profileKey: 'judy-alvarez', channel: 'private'}).turns.length, 1);
    const differs = Object.assign(new Error('the final words differ'), {name: 'SpeculationMismatch'});
    const rejected = Promise.reject(differs);
    rejected.catch(() => {});
    const error = await host.reply(turn('hello there again'), {confirmed: rejected}).catch(caught => caught);
    assert.equal(error, differs);
    assert.equal(memory.recall({profileKey: 'judy-alvarez', channel: 'private'}).turns.length, 1, 'still only the confirmed exchange');
  } finally { await close(); }
});

// ---- early failures and the voice's stream --------------------------------------------------------------------------------------------

test('a turn the host refuses at the door (no character, no words) is an error naming the provider, and nothing is sent', async () => {
  const {cloud, host, close} = await cloudOnly(() => READY_LINE);
  try {
    for (const config of [{text: 'hi', context: ''}, turn('   '), turn(''), {...turn('hi'), local: {profileKey: 7}}, null]) {
      const error = await host.reply(config).catch(caught => caught);
      assert.ok(error instanceof MistralError, JSON.stringify(config));
      assert.equal(failureKind(error), 'request');
    }
    assert.equal(cloud.requests.length, 0);
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(host.reply(turn('hi'), {signal: aborted.signal}), error => error.name === 'AbortError');
    assert.equal(cloud.requests.length, 0);
  } finally { await close(); }
});

test('a failure before the model is asked (no route for the provider, memory that cannot answer) fails the voice\'s stream too, so the voice does not wait for it', async () => {
  const {cloud, host, memory, close} = await cloudOnly(() => READY_LINE);
  try {
    const noRoute = new ReplyStream({name: 'Judy Alvarez'});
    host.provider.applied = 'local';   // the provider names a route this host does not have
    await assert.rejects(host.reply(turn('hello'), {stream: noRoute}));
    assert.equal(noRoute.complete, true, 'no route: the stream is failed, not left open');
    host.provider.applied = 'mistral';
    memory.recall = () => { throw Error('memory file unreadable'); };
    const broken = new ReplyStream({name: 'Judy Alvarez'});
    await assert.rejects(host.reply(turn('hello'), {stream: broken}));
    assert.equal(broken.complete, true, 'memory fault: the stream is failed, not left open');
    assert.equal(cloud.requests.length, 0);
  } finally { await close(); }
});

test('isLocalUnavailable reads the marker of a start that failed and nothing else', () => {
  assert.equal(isLocalUnavailable(Error('The local AI is not available [local:unavailable]')), true);
  for (const other of [Error('The local AI went quiet [local:network]'), new MistralError('network', 'x', {provider: 'local'}), null, undefined, 'a string', {message: 7}])
    assert.equal(isLocalUnavailable(other), false, String(other));
});
