import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {MistralHost, attachMistral} from './mistral-host.mjs';
import {TextProviderHost, attachTextProvider, localRoute, mistralRoute, isLocalUnavailable, CLOUD_CHAT_LIMITS, HOLDING_LINES} from './text-provider-host.mjs';
import {MistralMemory, MEMORY_LIMITS} from './mistral-memory.mjs';
import {MemoryStore} from './memory-store.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {PersonaBook, buildMessages, systemHead, parseFacts, factMessages, joinBlocks, FACT_SCHEMA, LIMITS, CONTEXT_PREFIX} from './mistral-prompt.mjs';
import {errorCodeFor, failureKind, MistralError, DEFAULT_MODELS} from './mistral-client.mjs';
import {fakeClock} from './fixtures/fake-clock.mjs';

const MISTRAL_KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);

// A thing that has to happen is waited for until it does (the ceiling is reached only by a hung test), never for a pause of a guessed length.
const eventually = async (check, label, ceilingMs = 60_000) => {
  for (const until = Date.now() + ceilingMs; ;) {
    if (check()) return;
    if (Date.now() > until) throw new Error(`gave up waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 2));
  }
};
const within = (promise, label, ceilingMs = 60_000) => new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`gave up waiting for ${label}`)), ceilingMs);
  promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});
const watch = promise => { const state = {done: false}; promise.then(() => { state.done = true; }, () => { state.done = true; }); return state; };

async function fakeServer(script) {
  const requests = [], malformed = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      let body;
      try { body = JSON.parse(raw); } catch {
        // A request the sender cut off (it gave up and closed the connection) has no body to read: that is the sender's own timeout, not a fault. A request that
        // arrived whole and is not JSON is a fault of the sender: it is kept, and `close` reports it, instead of throwing out of a socket handler.
        if (request.complete && !request.destroyed) malformed.push({method: request.method, url: request.url, length: raw.length, headers: request.headers});
        try { if (!response.destroyed && !response.writableEnded) response.writeHead(400).end(); } catch { /* the connection is gone */ }
        return;
      }
      requests.push({headers: request.headers, body, url: request.url});
      const answer = script(body, requests.length);
      if (answer?.hang) return;                                  // never answers (a connection the network dropped)
      if (typeof answer === 'object' && answer.status) {
        response.writeHead(answer.status, {'content-type': 'application/json', ...answer.headers});
        response.end(JSON.stringify({error: {code: answer.status, message: answer.message ?? 'failed'}}));
        return;
      }
      response.writeHead(200, {'content-type': 'text/event-stream'});
      for (const piece of String(answer).match(/.{1,12}/gs) ?? []) response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: piece}}]})}\n\n`);
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {requests, endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`,
    close: async () => {
      await new Promise(done => { server.closeAllConnections?.(); server.close(done); });
      if (malformed.length) throw new Error(`the fake server was sent ${malformed.length} request(s) whose body was not JSON: ${JSON.stringify(malformed[0])}`);
    }};
}

const turn = (text, extra = {}) => ({text, context: 'CURRENT PERSON\nQuest facts here.', sessionId: 'session-1',
  local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}, ...extra});
const parts = (extra = {}) => ({now: 'Right now (from the game, this turn only): It is night, about 11 PM.', notes: 'Use {joy} tags for feelings.',
  world: 'Quest: Heist.\n\nV wears a jacket.', volatile: 'Whether you ask V anything is your own call.', ...extra});

// ---- Prompt layout v2 ------------------------------------------------------------------------------------------------------

test('layout v2: persona and rules, then format notes, world, summary and the right-now block, then the turns, then the volatile notes', () => {
  const persona = book.persona('judy-alvarez');
  const history = [{v: 'my name is Kestrel', r: 'Nice to meet you, Kestrel.'}];
  const messages = buildMessages({persona, memory: 'I fixed a rig for V.', history, contextParts: parts(),
    remembered: [{text: 'V told me about a brother in the Badlands.'}], text: 'What is my name?'});
  const system = messages[0].content;
  const at = text => system.indexOf(text);
  assert(at('You are Judy Alvarez') === 0);
  assert(at('OUTPUT RULES') < at('FORMAT NOTES FOR EVERY REPLY'));
  assert(at('FORMAT NOTES FOR EVERY REPLY') < at('WORLD AND QUEST CONTEXT'));
  assert(at('WORLD AND QUEST CONTEXT') < at('WHAT YOU REMEMBER OF V FROM EARLIER TALKS'));
  assert(at('WHAT YOU REMEMBER OF V FROM EARLIER TALKS') < at('RIGHT NOW'));
  assert(system.trimEnd().endsWith('It is night, about 11 PM.'), 'the right-now block is the last thing before the turns');
  assert(system.includes(CONTEXT_PREFIX) && system.includes('Quest: Heist.'));
  assert.deepEqual(messages.slice(1, 3).map(message => message.content), ['my name is Kestrel', 'Nice to meet you, Kestrel.'], 'recent turns are verbatim');
  const last = messages.at(-1).content;
  assert(last.indexOf('Whether you ask V anything') < last.indexOf('THINGS YOU REMEMBER ABOUT V'));
  assert(last.indexOf('THINGS YOU REMEMBER ABOUT V') < last.indexOf('V says: What is my name?'));
  assert(last.includes('- V told me about a brother in the Badlands.'));
  assert.doesNotMatch(last, /Quest: Heist|about 11 PM/, 'world and clock are not repeated in the last message');
});

test('layout v2: everything before the turns is byte-identical when only the volatile notes, the retrieved memories or the history change', () => {
  const persona = book.persona('judy-alvarez');
  const a = buildMessages({persona, memory: 's', history: [], contextParts: parts(), text: 'one'});
  const b = buildMessages({persona, memory: 's', history: [{v: 'one', r: 'two'}], contextParts: parts({volatile: 'Another speaks after you.'}),
    remembered: [{text: 'x remembered fact'}], text: 'three'});
  assert.equal(a[0].content, b[0].content);
  const c = buildMessages({persona, memory: 's', history: [], contextParts: parts({now: 'Right now: it is morning.'}), text: 'one'});
  assert.notEqual(a[0].content, c[0].content);
  assert.equal(a[0].content.slice(0, systemHead({persona}).length), systemHead({persona}), 'the persona prefix is the prewarm text');
});

test('without contextParts the old layout is kept: the whole context in the last user message', () => {
  const persona = book.persona('panam-palmer');
  const messages = buildMessages({persona, memory: 'a memory', context: 'CTX BLOCK', text: 'hi'});
  assert.match(messages.at(-1).content, /^\[LIVE CONTEXT/);
  assert(messages.at(-1).content.includes('CTX BLOCK'));
  assert.doesNotMatch(messages[0].content, /WORLD AND QUEST CONTEXT/);
  assert.match(messages[0].content, /WHAT YOU REMEMBER OF V[^\n]*\na memory[\s\S]*OUTPUT RULES/);
});

test('retrieved memories are bounded and the joined blocks drop empties and repeats', () => {
  const persona = book.persona('judy-alvarez');
  const many = Array.from({length: 30}, (_, i) => ({text: `fact number ${i} ${'x'.repeat(200)}`}));
  const last = buildMessages({persona, contextParts: parts(), remembered: many, text: 'hi'}).at(-1).content;
  assert((last.match(/^- fact number/gm) ?? []).length <= Math.ceil(LIMITS.remembered / 200));
  assert.equal(joinBlocks(['a', '', 'a', ' b ', undefined, 'b']), 'a\n\nb');
});

test('facts: the request carries what is known, and the answer is parsed defensively', () => {
  const messages = factMessages({name: 'Judy', turns: [{v: 'I hate Arasaka', r: 'Me too.'}], known: [{id: 'm1', text: 'V likes noodles.'}]});
  assert.match(messages[1].content, /m1: V likes noodles\./);
  assert.match(messages[1].content, /V: I hate Arasaka\nJudy: Me too\./);
  assert.equal(FACT_SCHEMA.properties.facts.maxItems, 3);
  const known = [{id: 'm1', text: 'x'}];
  const facts = parseFacts('```json\n{"facts":[{"text":"V told me they hate Arasaka.","kind":"preference","importance":2,"replaces":"m1"},'
    + '{"text":"V told me they hate Arasaka.","kind":"fact"},{"text":"short","kind":"fact"},{"text":"V promised to bring me a drink.","kind":"bogus","replaces":"nope"}]}\n```', {known});
  assert.equal(facts.length, 2);
  assert.deepEqual(facts[0], {text: 'V told me they hate Arasaka.', kind: 'preference', importance: 1, replaces: 'm1'});
  assert.equal(facts[1].kind, 'fact'); assert.equal(facts[1].replaces, undefined);
  assert.deepEqual(parseFacts('not json at all'), []);
  assert.deepEqual(parseFacts('{"facts":[]}'), []);
  assert.equal(parseFacts(JSON.stringify(Array.from({length: 9}, (_, i) => `fact sentence number ${i} here`))).length, 3);
});

// ---- Mistral: cache key, model order ---------------------------------------------------------------------------------------

async function harness(script, {preference = 'mistral', mistralKey = MISTRAL_KEY, host: hostOptions = {}, chatDefaults} = {}) {
  const server = await fakeServer(script);
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => mistralKey ? `api-key=${mistralKey}
` : '', writeText: async () => {}});
  await provider.load();
  provider.setPreference(preference); provider.apply();
  const memory = await MistralMemory.open({path: null});
  const logs = [];
  const mistral = mistralRoute({provider, endpoint: server.endpoint, gapMs: 0, cacheScope: 'scope1', ...(chatDefaults ? {chatDefaults} : {})});
  const routes = {mistral};
  const host = new TextProviderHost({provider, memory, personas: book, routes, log: line => logs.push(line), ...hostOptions});
  const close = async () => { host.close(); await server.close(); };
  return {server, provider, memory, host, logs, close};
}

test('Mistral requests carry a stable prompt_cache_key per character, never the key, and the first model is ministral-8b', async () => {
  const {server, host, close} = await harness(() => 'Sure thing, V.');
  try {
    await host.reply(turn('one'));
    await host.reply(turn('two'));
    await host.reply(turn('hello', {local: {profileKey: 'panam-palmer', name: 'Panam Palmer', channel: 'private'}}));
    const keys = server.requests.map(request => request.body.prompt_cache_key);
    assert.equal(keys[0], keys[1]);
    assert.notEqual(keys[0], keys[2]);
    assert.match(keys[0], /^cyberpunk-convai:scope1:judy-alvarez$/);
    assert.equal(server.requests[0].body.model, 'ministral-8b-latest');
    assert.equal(DEFAULT_MODELS[0], 'ministral-8b-latest');
    assert.doesNotMatch(JSON.stringify(server.requests.map(request => request.body)), new RegExp(MISTRAL_KEY));
  } finally { await close(); }
});

test('with contextParts the request uses layout v2 and the memory store\'s retrieved facts', async () => {
  const retrievals = [];
  const memory = await MistralMemory.open({path: null});
  memory.retrieve = async query => { retrievals.push(query); return [{id: 'r1', text: 'V told me their name is Kestrel.'}]; };
  const {server, host, close} = await harness(() => 'Hello, Kestrel.', {host: {}});
  host.memory = memory;
  try {
    await host.reply(turn('who am I?', {contextParts: parts()}));
    const messages = server.requests[0].body.messages;
    assert.match(messages[0].content, /WORLD AND QUEST CONTEXT[\s\S]*Quest: Heist/);
    assert.match(messages.at(-1).content, /- V told me their name is Kestrel\./);
    assert.equal(retrievals[0].query, 'who am I?');
    assert.equal(retrievals[0].profileKey, 'judy-alvarez');
    // A reaction retrieves nothing.
    await host.reply(turn('The player entered combat.', {contextParts: parts(), reaction: true}));
    assert.equal(retrievals.length, 1);
  } finally { await close(); }
});

test('a remark with a word limit asks for few tokens and is cut at a sentence end; a reaction or reply without one is untouched', async () => {
  const long = 'Nine misses. Recalibrating the user, not the gun. Also my feelings are hurt badly today, choom.';
  const {server, host, close} = await harness(() => long);
  try {
    const limited = await host.reply(turn('Game event: nine misses.', {contextParts: parts(), reaction: {kind: 'addon', maxWords: 8}}));
    assert.equal(limited.text, 'Nine misses. Recalibrating the user, not the gun.');
    assert.ok(server.requests[0].body.max_tokens <= 70, 'a small token limit for a remark');
    const bark = await host.reply(turn('The player entered combat.', {contextParts: parts(), reaction: {phase: 'start'}}));
    assert.equal(bark.text, long, 'a reaction without a word limit is not cut');
    assert.equal(server.requests[1].body.max_tokens, LIMITS.maxTokens);
    const talk = await host.reply(turn('hello'));
    assert.equal(talk.text, long);
  } finally { await close(); }
});

// ---- A removed provider ----------------------------------------------------------------------------------------------------

test('a saved conversation provider of groq (removed 2026-10-14) is the default: Convai answers, nothing is sent to a Groq host, no notice', async () => {
  const {provider, server, close} = await harness(() => 'from mistral', {preference: 'groq'});
  try {
    assert.equal(provider.preference, 'convai');
    assert.equal(provider.route, 'convai');
    assert.equal(provider.active, false);
    assert.equal(provider.takeNotice(), undefined);
    assert.equal(server.requests.length, 0);
    assert.equal('groqRoute' in await import('./text-provider-host.mjs'), false, 'there is no Groq route');
  } finally { await close(); }
});

// ---- Local -----------------------------------------------------------------------------------------------------------------

function localHarness(script, {gate, idleRetryMs, ensure} = {}) {
  return (async () => {
    const llama = await fakeServer(script);
    const calls = {ensure: 0, prewarm: [], touch: 0};
    const server = {
      status: () => ({state: 'ready'}),
      ensure: ensure ?? (async () => { calls.ensure++; return {endpoint: llama.endpoint, apiKey: 'session-key-abcdef123456', model: 'qwen-test', tier: 'standard'}; }),
      touch: () => { calls.touch++; },
      prewarm: async messages => { calls.prewarm.push(messages); },
    };
    const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => '', writeText: async () => {}});
    await provider.load();
    provider.setPreference('local'); provider.apply();
    const memory = await MistralMemory.open({path: null});
    const host = new TextProviderHost({provider, memory, personas: book, routes: {local: localRoute({server, provider})}, gate, idleRetryMs});
    return {llama, calls, provider, memory, host, server, close: async () => { host.close(); await llama.close(); }};
  })();
}

test('local: a turn goes to the supervised server with its session key, unpaced, and comes back cleaned like any reply', async () => {
  const {llama, host, provider, close, calls} = await localHarness(() => 'Sure thing, V. What do you need?');
  try {
    assert.equal(provider.active, true); assert.equal(provider.route, 'local');
    const [one, two] = await Promise.all([host.reply(turn('one')), host.reply(turn('two'))]);
    // A paced route takes the next start slot for every request (#slot in bridge/text-provider-host.mjs); this one takes none.
    assert.equal(host.routes.local.nextSlot, 0, 'no one-second pacing on the local route');
    assert.equal(one.transport, 'local'); assert.equal(one.timing.provider, 'local');
    assert.equal(one.text, 'Sure thing, V. What do you need?');
    assert.equal(llama.requests[0].headers.authorization, 'Bearer session-key-abcdef123456');
    assert.equal(llama.requests[0].body.prompt_cache_key, undefined);
    assert.equal(llama.requests[0].body.model, 'local');
    assert.equal(llama.requests.length, 2);
    assert(calls.touch >= 2, 'the idle timer is told about every request');
    assert(two.text);
  } finally { await close(); }
});

test('local: a server that cannot start fails the turn with its own reason; Local AI stays the provider, no notice is queued and nothing moves to Convai', async () => {
  const fail = () => { const error = new Error('The local AI is not available [local:unavailable]'); error.reason = 'low-memory'; throw error; };
  const {host, provider, close} = await localHarness(() => 'x', {ensure: async () => fail()});
  try {
    const error = await host.reply(turn('hi')).catch(caught => caught);
    assert(isLocalUnavailable(error));
    assert.equal(provider.localBroken, 'low-memory');
    assert.equal(provider.requested, 'local');
    assert.equal(provider.pending, false);
    assert.equal(provider.apply(), false);
    assert.equal(provider.takeNotice(), undefined);
    provider.noteLocalFailure('low-memory'); // the same failure again says nothing more
    assert.equal(provider.takeNotice(), undefined);
    // The next turn asks the server to start again (it fails again here) and the provider is still Local AI.
    const again = await host.reply(turn('hi again')).catch(caught => caught);
    assert(isLocalUnavailable(again));
    assert.equal(provider.route, 'local');
    // Choosing the provider again clears the record.
    provider.setPreference('convai'); provider.setPreference('local');
    assert.equal(provider.localBroken, null);
    assert.equal(provider.requested, 'local');
  } finally { await close(); }
});

// A failed Local AI is started again by the next turn that needs it (localRoute retryFailed): at most once every LOCAL_RETRY_MS, only for the reasons a new start
// can cure (not 'not-installed' or 'mature-off', which the install and the Mature setting cure), never for background work.
function retryServer(state) {
  const calls = {reset: 0, ensure: 0};
  const server = {calls, state,
    status: () => server.state,
    reset() { calls.reset++; server.state = {state: 'stopped'}; },
    ensure: async () => { calls.ensure++; return {endpoint: 'http://127.0.0.1:9/v1/chat/completions', apiKey: 'session-key-abcdef123456', model: 'qwen-test'}; },
    touch() {}};
  return server;
}

test('local: a turn after a failed start (low memory, start failed, crashed) resets the server once, then waits ten seconds before it does so again', async () => {
  for (const reason of ['low-memory', 'start-failed', 'crashed']) {
    const server = retryServer({state: 'failed', reason});
    let clock = 50_000;
    const logs = [];
    const route = localRoute({server, provider: {noteLocalFailure() {}}, now: () => clock, log: line => logs.push(line)});
    (await route.connect(undefined, {})).release();
    assert.equal(server.calls.reset, 1, reason);
    assert.equal(server.calls.ensure, 1, `${reason}: the ensure that follows starts the model`);
    assert.equal(logs.filter(line => line.includes(reason)).length, 1, reason);
    // It failed again straight away: a turn within the ten seconds does not reset again.
    server.state = {state: 'failed', reason};
    clock += 9_999;
    (await route.connect(undefined, {})).release();
    assert.equal(server.calls.reset, 1, `${reason}: not twice within ten seconds`);
    server.state = {state: 'failed', reason};
    clock += 1;
    (await route.connect(undefined, {})).release();
    assert.equal(server.calls.reset, 2, `${reason}: ten seconds later it is tried again`);
    // A server that is not failed is left alone, and so is a prepare of a failed one before the ten seconds are over.
    server.state = {state: 'ready'};
    clock += 60_000;
    (await route.connect(undefined, {})).release();
    assert.equal(server.calls.reset, 2);
    server.state = {state: 'failed', reason};
    clock += 10_000;
    assert.equal(await route.prepare(), true);
    assert.equal(server.calls.reset, 3, `${reason}: prepare (the start of a turn) retries too`);
  }
});

test('local: not-installed and mature-off failures are never reset by a turn, and background work never starts or resets the server', async () => {
  for (const reason of ['not-installed', 'mature-off', 'no-gpu']) {
    const server = retryServer({state: 'failed', reason});
    const route = localRoute({server, provider: {noteLocalFailure() {}}, now: () => 1_000_000});
    (await route.connect(undefined, {})).release();
    await route.prepare();
    assert.equal(server.calls.reset, 0, reason);
  }
  const server = retryServer({state: 'failed', reason: 'low-memory'});
  const route = localRoute({server, provider: {noteLocalFailure() {}}, now: () => 1_000_000});
  await assert.rejects(route.connect(undefined, {background: true}), /not loaded/);
  assert.equal(server.calls.reset, 0, 'a summary never starts the server');
  assert.equal(server.calls.ensure, 0);
});

test('local: the route never falls back and has no hook that tells the provider a cloud provider answered', () => {
  const route = localRoute({server: retryServer({state: 'ready'}), provider: {noteLocalFailure() {}}});
  assert.equal(route.fallsBack(new Error('x')), false);
  assert.equal(route.fallsBack(Object.assign(new Error('The local AI is not available [local:unavailable]'), {reason: 'low-memory'})), false);
  assert.equal(route.fellBack, undefined);
});

test('local: summaries and fact extraction wait for the gate (no combat, nothing speaking) and the server is never started for them', async () => {
  let open = false, asked = 0;
  const summaryRequests = () => llama.requests.filter(request => /private memory/.test(request.body.messages[0].content));
  const {llama, host, close, calls, memory} = await localHarness(body => /private memory/.test(body.messages[0].content) ? 'I told V my plans.' : 'Fine.',
    {gate: () => { asked++; return open; }, idleRetryMs: 25});
  try {
    for (let i = 0; i < MEMORY_LIMITS.turns + MEMORY_LIMITS.batch; i++) await host.reply(turn(`question ${i}`));
    // The summary is due now. The host asks the gate again every idleRetryMs: it has been asked, and refused, three times before anything is checked.
    const askedBefore = asked;
    await eventually(() => asked >= askedBefore + 3 || summaryRequests().length > 0, 'the gate to be asked three more times');
    assert.equal(summaryRequests().length, 0, 'gate closed: no summary');
    open = true;
    await eventually(() => memory.recall({profileKey: 'judy-alvarez', channel: 'private'}).summary === 'I told V my plans.', 'the summary to be kept');
    assert.equal(summaryRequests().length, 1, 'gate open: the summary runs');
    const ensuresBefore = calls.ensure;
    // An unloaded server is not started for background work.
    host.routes.local.connect = async (signal, {background} = {}) => { if (background) throw new MistralError('network', 'is not loaded right now', {provider: 'local'}); return {apiKey: 'session-key-abcdef123456', endpoint: llama.endpoint}; };
    await assert.rejects(host.routes.local.connect(undefined, {background: true}), /not loaded/);
    assert.equal(calls.ensure, ensuresBefore);
  } finally { await close(); }
});

test('local: prewarm sends the persona prefix with one token to the server, and warm on an attached host triggers it', async () => {
  const {host, provider, calls, close} = await localHarness(() => 'x');
  try {
    await host.prewarm(turn('hi'));
    assert.equal(calls.prewarm.length, 1);
    assert.equal(calls.prewarm[0][0].content, systemHead({persona: book.persona('judy-alvarez')}));
    const original = {reply: async () => ({text: 'convai'}), prepare: async () => ({}), warm: async () => ({connectionMs: 5}), readiness: async () => ({}),
      lateEmotion: async () => ({}), refreshIdle: async () => true, voiceChannel: () => ({kind: 'convai'})};
    attachTextProvider(original, {provider, mistral: host, speech: {available: () => true, voiceChannel: ({reply}) => ({kind: 'local-voice', reply})}});
    assert.deepEqual(await original.warm({local: {profileKey: 'panam-palmer', name: 'Panam Palmer'}}), {connectionMs: 0, provider: 'local'});
    await eventually(() => calls.prewarm.length >= 2, 'the warm-up to prewarm the server');
    assert.equal(calls.prewarm.length, 2);
    assert.equal(original.voiceChannel().kind, 'local-voice');
    await assert.rejects(original.prepare({}), /not available with the local AI/);
    // Convai is back: nothing is prewarmed and the extra fields never reach the original methods.
    provider.setPreference('convai'); provider.apply();
    const seen = [];
    original.warm = async config => seen.push(config);
    attachTextProvider(original, {provider, mistral: host});
    await original.warm({local: {}, contextParts: {}, keep: 1});
    assert.deepEqual(seen, [{keep: 1}]);
  } finally { await close(); }
});

test('the Mistral host keeps its original export and a Mistral turn still works through the shared host', async () => {
  const server = await fakeServer(() => 'Fine, V.');
  try {
    const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${MISTRAL_KEY}`, writeText: async () => {}});
    await provider.load(); provider.setPreference('mistral'); provider.apply();
    const host = new MistralHost({provider, memory: await MistralMemory.open({path: null}), personas: book, endpoint: server.endpoint, gapMs: 0});
    assert(host instanceof TextProviderHost);
    assert.equal(attachMistral, attachTextProvider);
    assert.equal((await host.reply(turn('hi'))).text, 'Fine, V.');
  } finally { await server.close(); }
});

test('errors name their provider, and only a refused Mistral key becomes a game code', () => {
  const limited = new MistralError('limit', 'rate limited', {provider: 'mistral'});
  assert.match(limited.message, /^Mistral .*\[mistral:limit\]$/);
  assert.equal(failureKind(limited), 'limit');
  assert.equal(errorCodeFor(limited), 'mistral-limit');
  const local = new MistralError('network', 'could not be reached', {provider: 'local'});
  assert.match(local.message, /^The local AI .*\[local:network\]$/);
  // A failed local turn (no answer, a refused prompt, a server that went away) has its own code; one that could not start does not.
  assert.equal(errorCodeFor(local), 'local-failed');
  assert.equal(errorCodeFor(new Error('The local AI is not available [local:unavailable]')), undefined);
  assert.equal(errorCodeFor(new MistralError('key', 'x')), 'mistral-key');
});

test('the shared Mistral scheduler paces every Mistral request: replies as text priority, summaries and facts as background', async () => {
  const seen = [], noted = [];
  const scheduler = {schedule: (task, options) => { seen.push(options.priority); return task(); }, noteHeaders: headers => noted.push(headers)};
  const server = await fakeServer(body => /private memory/.test(body.messages[0].content) ? 'I told V my plans.' : 'Fine.');
  try {
    const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${MISTRAL_KEY}`, writeText: async () => {}});
    await provider.load(); provider.setPreference('mistral'); provider.apply();
    const route = mistralRoute({provider, endpoint: server.endpoint, gapMs: 5000, scheduler});
    const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: book, routes: {mistral: route}, idleRetryMs: 10});
    for (let i = 0; i < MEMORY_LIMITS.turns + MEMORY_LIMITS.batch; i++) await host.reply(turn(`question ${i}`));
    await eventually(() => noted.length > MEMORY_LIMITS.turns + MEMORY_LIMITS.batch, 'the summary request to be answered');
    assert(seen.includes(2), 'the summary asked the scheduler for a background slot');
    assert.equal(seen.filter(priority => priority === 0).length, MEMORY_LIMITS.turns + MEMORY_LIMITS.batch);
    assert(noted.length >= seen.length, 'the headers of every answer reach the scheduler');
    host.close();
  } finally { await server.close(); }
});

// ---- Fact extraction follows the chat route: never on Convai (its own long-term memory), unchanged on Mistral

async function extractionHarness(preference, answer) {
  const logs = [];
  const server = await fakeServer(answer);
  const embedder = {id: 'fake', dim: 4, available: () => true, ready: () => true, async embed(texts) { return texts.map(() => new Float32Array([1, 0, 0, 0])); }};
  const memory = await MemoryStore.open({embedder, gate: () => true, log: line => logs.push(line)});
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${MISTRAL_KEY}`, writeText: async () => {}});
  await provider.load(); provider.setPreference(preference); provider.apply();
  const route = mistralRoute({provider, endpoint: server.endpoint, gapMs: 0});
  const host = new TextProviderHost({provider, memory, personas: book, routes: {mistral: route}, log: line => logs.push(line)});
  const factRequests = () => server.requests.filter(request => request.body.response_format);
  const exchanges = count => { for (let i = 0; i < count; i++) memory.record({profileKey: 'judy-alvarez', v: `question ${i}`, r: `answer ${i}`}); };
  return {server, memory, provider, host, logs, factRequests, exchanges, close: async () => { host.close(); await server.close(); }};
}
const FACTS = () => JSON.stringify({facts: [{text: 'V likes cheap whiskey', kind: 'preference', importance: 0.6}]});

test('Convai route: fact extraction is never scheduled (no request, no retry, no log line), and runs once a text provider answers', async () => {
  const {memory, provider, logs, factRequests, exchanges, close} = await extractionHarness('convai', FACTS);
  try {
    assert.equal(provider.active, false);
    exchanges(7);                                   // exchanges left over from a chat on another provider
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(factRequests().length, 0);
    assert.deepEqual(logs, []);
    // The player switches to Mistral: the host re-plans on the provider change and the waiting exchanges are extracted.
    provider.setPreference('mistral'); provider.apply();
    await eventually(() => factRequests().length === 1, 'the extraction to run on Mistral');
    await eventually(() => memory.listRecords('judy-alvarez').length === 1, 'the fact to be kept');
    assert.deepEqual(logs.filter(line => /failed|retrying/.test(line)), []);
  } finally { await close(); }
});

test('Mistral route: fact extraction is unchanged (it runs after six exchanges and keeps the fact)', async () => {
  const {memory, logs, factRequests, exchanges, close} = await extractionHarness('mistral', FACTS);
  try {
    exchanges(6);
    await eventually(() => factRequests().length === 1, 'the extraction request');
    assert.equal(factRequests()[0].body.response_format.type, 'json_object');
    await eventually(() => memory.listRecords('judy-alvarez').length === 1, 'the fact to be kept');
    assert.deepEqual(logs, []);
  } finally { await close(); }
});

// ---- Streaming the first sentence to the voice (docs/LATENCY_2026-10-12.md) ----------------------------------------------------

test('a stream is handed its first sentence before the reply is finished, and the finished reply keeps it', async () => {
  const {ReplyStream} = await import('./reply-stream.mjs');
  const {host, close} = await harness(() => 'Hey V, good to see you here again. What can I do for you tonight? Pull up a chair.');
  try {
    const stream = new ReplyStream({name: 'Judy Alvarez'});
    let headWhen = null;
    stream.onChange(() => { if (headWhen === null) headWhen = stream.complete ? 'after' : 'before'; });
    const result = await host.reply(turn('hello'), {stream});
    assert.equal(headWhen, 'before', 'the head appeared while the reply was still streaming');
    assert.equal(stream.head, 'Hey V, good to see you here again.');
    assert.equal(stream.complete, true);
    assert.equal(stream.text, result.text);
    assert.equal(stream.tail, 'What can I do for you tonight? Pull up a chair.');
    assert.equal(result.timing.streamedHead, true);
  } finally { await close(); }
});

test('a reply that breaks character after its first sentence is cut back to that sentence and not asked for again', async () => {
  const {ReplyStream} = await import('./reply-stream.mjs');
  const {server, host, close} = await harness(() => 'Hey V, good to see you here again. As an AI language model I cannot really help you.');
  try {
    const stream = new ReplyStream({name: 'Judy Alvarez'});
    const result = await host.reply(turn('hello'), {stream});
    assert.equal(server.requests.length, 1, 'no second attempt once a sentence was spoken');
    assert.equal(result.text, 'Hey V, good to see you here again.');
    assert.equal(stream.tail, '');
  } finally { await close(); }
});

test('a short reply, or a failure, leaves the stream without a head and the reply is built as before', async () => {
  const {ReplyStream} = await import('./reply-stream.mjs');
  const short = await harness(() => 'Sure thing, V.');
  try {
    const stream = new ReplyStream({name: 'Judy Alvarez'});
    const result = await short.host.reply(turn('hello'), {stream});
    assert.equal(stream.head, null);
    assert.equal(await stream.headReady, null);
    assert.equal(stream.text, 'Sure thing, V.');
    assert.equal(result.text, 'Sure thing, V.');
  } finally { await short.close(); }
  const failing = await harness(() => ({status: 401, message: 'bad key'}));
  try {
    const stream = new ReplyStream({name: 'Judy Alvarez'});
    await assert.rejects(failing.host.reply(turn('hello'), {stream}));
    assert.equal(await stream.headReady, null);
    assert.equal(stream.complete, true);
    await assert.rejects(stream.finished);
  } finally { await failing.close(); }
});

test('a turn without a stream still marks its stages on the turn clock', async () => {
  const {TurnClock, withClock} = await import('./turn-clock.mjs');
  const {host, close} = await harness(() => 'Hey V, good to see you here again. What can I do for you tonight?');
  try {
    const clock = new TurnClock({origin: 0});
    await withClock(clock, () => host.reply(turn('hello')));
    for (const name of ['recalled', 'promptBuilt', 'llmSent', 'firstToken', 'firstSentence', 'fullText', 'replyReturned']) assert.ok(clock.has(name), name);
    assert.ok(clock.at('firstToken') <= clock.at('fullText'));
  } finally { await close(); }
});

test('warm on an attached host asks the host to open its local voice page', async () => {
  const {host, provider, close} = await harness(() => 'x');
  try {
    let prewarmed = 0;
    const original = {reply: async () => ({}), prepare: async () => ({}), warm: async () => ({}), readiness: async () => ({}), lateEmotion: async () => ({}),
      refreshIdle: async () => true, voiceChannel: () => ({}), prewarmLocal: async () => { prewarmed++; }};
    attachTextProvider(original, {provider, mistral: host});
    await original.warm({local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez'}});
    assert.equal(prewarmed, 1);
  } finally { await close(); }
});

test('the text of each typed turn (not a reaction, not while Convai answers) is told to onPlayerText for the microphone\'s language', async () => {
  const {host, provider, close} = await harness(() => 'x');
  try {
    const heard = [];
    const original = {reply: async () => ({text: 'convai'}), prepare: async () => ({}), warm: async () => ({}), readiness: async () => ({}), lateEmotion: async () => ({}),
      refreshIdle: async () => true, voiceChannel: () => ({})};
    attachTextProvider(original, {provider, mistral: host, onPlayerText: text => { heard.push(text); if (text === 'boom') throw Error('an observer fault'); }});
    await original.reply(turn('Привет, как дела?'));
    await original.reply({...turn('The player is near the Afterlife.'), reaction: {kind: 'battle'}});
    await original.reply(turn('boom'));
    assert.deepEqual(heard, ['Привет, как дела?', 'boom'], 'a reaction says nothing about the player, and a faulty observer never breaks the turn');
    provider.setPreference('convai'); provider.apply();
    await original.reply(turn('while Convai answers'));
    assert.equal(heard.length, 2);
  } finally { await close(); }
});

test('facts: the character\'s own passing claims about what it was doing are never kept as memories', () => {
  const raw = JSON.stringify({facts: [
    {text: 'I mentioned tweaking old dolls and Clouds leftovers.', kind: 'event', importance: 0.5, replaces: null},
    {text: 'I was just finishing up some hardware checks in the basement.', kind: 'fact', importance: 0.5, replaces: null},
    {text: 'V told me their sister Mika loves old vinyl.', kind: 'fact', importance: 0.7, replaces: null},
    {text: 'I promised V a ride to the Badlands.', kind: 'promise', importance: 0.8, replaces: null}]});
  assert.deepEqual(parseFacts(raw).map(fact => fact.text), ['V told me their sister Mika loves old vinyl.', 'I promised V a ride to the Badlands.']);
  const [system] = factMessages({name: 'Judy', turns: [{v: 'hi', r: 'Hey.'}]});
  assert.match(system.content, /never record my own activity claims/);
});

// ---- a request that hangs: cut early, asked again, then a line in the character's voice instead of silence ---------------------------

const QUICK = {firstByteMs: 80, retryFirstByteMs: 120, stallMs: 150, retries: 1, backoffMs: [5]};
// These limits run on a manual clock (bridge/fixtures/fake-clock.mjs): a request is cut when the test moves the clock to its limit, never because the machine was slow,
// so an ask that must be answered cannot be cut by a busy machine and an ask that must be cut does not depend on one.
const quickOn = clock => ({...QUICK, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer});
// Cuts every request the fake server leaves unanswered, the way its first-byte limit would: the clock moves only once the request has reached the server
// (its timer is armed by then), and the reply is waited for to the end.
async function cutHangs(server, clock, reply) {
  const state = watch(reply);
  for (let seen = server.requests.length; ;) {
    await eventually(() => server.requests.length > seen || state.done, 'a request to reach the server');
    if (state.done) return;
    seen = server.requests.length;
    await clock.advance(QUICK.retryFirstByteMs);
  }
}

test('the cloud routes give up on a silent request after 6 s, ask once more with 8 s, and cut a stream that goes quiet after 8 s', () => {
  assert.deepEqual({...CLOUD_CHAT_LIMITS}, {firstByteMs: 6000, retryFirstByteMs: 8000, stallMs: 8000, retries: 1, backoffMs: [300]});
  assert.ok(CLOUD_CHAT_LIMITS.firstByteMs + CLOUD_CHAT_LIMITS.backoffMs[0] + CLOUD_CHAT_LIMITS.retryFirstByteMs < 15000, 'the worst case before the holding line');
});

test('a request that never answers is asked again at once and the reply arrives; the failed ask is in the timing and the log', async () => {
  const clock = fakeClock();
  const {server, host, logs, close} = await harness((_body, count) => count === 1 ? {hang: true} : 'Sure thing, V. Come on in and sit down.', {chatDefaults: quickOn(clock)});
  try {
    const reply = host.reply(turn('hello'));
    const [result] = await Promise.all([reply, cutHangs(server, clock, reply)]);
    assert.equal(result.text, 'Sure thing, V. Come on in and sit down.');
    assert.equal(server.requests.length, 2); assert.equal(result.timing.attempts, 2);
    assert.equal(result.timing.llmFailed.length, 1); assert.equal(result.timing.llmFailed[0].kind, 'network');
    assert.equal(result.timing.llmFailed[0].ms, QUICK.firstByteMs, 'the hung ask was cut at its own short limit, not the 25 s it used to take');
    assert.ok(logs.some(line => /attempt 1 failed after \d+ ms \(network, no answer in time\); asking again/.test(line)), logs.join('|'));
  } finally { await close(); }
});

test('a service that stays silent gives a short line in the character\'s voice, not an error, and the line is not remembered', async () => {
  const clock = fakeClock();
  const {server, host, memory, close} = await harness(() => ({hang: true}), {chatDefaults: quickOn(clock)});
  try {
    const reply = host.reply(turn('hello there'));
    const [result] = await Promise.all([reply, cutHangs(server, clock, reply)]);
    assert.ok(HOLDING_LINES.includes(result.text), result.text);
    assert.equal(result.timing.holdingLine, true); assert.equal(result.timing.attempts, 2);
    assert.equal(result.timing.llmFailed.length, 2);
    assert.deepEqual(memory.recall({profileKey: 'judy-alvarez', channel: 'private'}).turns, [], 'the holding line answers nothing: it is not recorded as a talk');
    const second = host.reply(turn('hello again'));
    const [again] = await Promise.all([second, cutHangs(server, clock, second)]);
    assert.notEqual(again.text, result.text, 'the lines take turns');
  } finally { await close(); }
});

test('a holding line goes through a stream like any reply, so the voice and the subtitles speak it', async () => {
  const {ReplyStream} = await import('./reply-stream.mjs');
  const clock = fakeClock();
  const {server, host, close} = await harness(() => ({hang: true}), {chatDefaults: quickOn(clock)});
  try {
    const stream = new ReplyStream({name: 'Judy Alvarez'});
    const reply = host.reply(turn('hello'), {stream});
    const [result] = await Promise.all([reply, cutHangs(server, clock, reply)]);
    assert.equal(await stream.finished, result.text); assert.ok(HOLDING_LINES.includes(stream.text));
  } finally { await close(); }
});

test('a refused key, a limit and a battle bark are not turned into a holding line', async () => {
  const clock = fakeClock();
  const refused = await harness(() => ({status: 401, message: 'bad key'}), {chatDefaults: quickOn(clock)});
  try { await assert.rejects(refused.host.reply(turn('hello')), error => failureKind(error) === 'key'); } finally { await refused.close(); }
  const quiet = await harness(() => ({hang: true}), {chatDefaults: quickOn(clock)});
  try {
    const bark = quiet.host.reply(turn('hello', {reaction: {phase: 'start'}}));
    const [error] = await Promise.all([bark.catch(caught => caught), cutHangs(quiet.server, clock, bark)]);
    assert.ok(error instanceof Error, 'a battle bark that gets no answer is an error, not a line');
    assert.equal(failureKind(error), 'network');
  } finally { await quiet.close(); }
});

test('a server fault is a holding line too, after its retry', async () => {
  const {server, host, close} = await harness(() => ({status: 503, message: 'overloaded'}), {chatDefaults: quickOn(fakeClock())});
  try {
    const result = await host.reply(turn('hello'));
    assert.ok(HOLDING_LINES.includes(result.text)); assert.equal(server.requests.length, 2);
  } finally { await close(); }
});

test('a stream that goes quiet after the first sentence ends with that sentence as the whole reply, which is remembered', async () => {
  const {ReplyStream} = await import('./reply-stream.mjs');
  const first = 'Hey V, good to see you here again, come in and sit.';
  const server = await new Promise(done => {
    const requests = [];
    const http = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        requests.push(1);
        response.writeHead(200, {'content-type': 'text/event-stream'});
        response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: `${first} What can`}}]})}\n\n`);   // then silence
      });
    });
    http.listen(0, '127.0.0.1', () => done({http, requests, endpoint: `http://127.0.0.1:${http.address().port}/v1/chat/completions`}));
  });
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${MISTRAL_KEY}\n`, writeText: async () => {}});
  await provider.load(); provider.setPreference('mistral'); provider.apply();
  const memory = await MistralMemory.open({path: null}), logs = [], clock = fakeClock();
  const host = new TextProviderHost({provider, memory, personas: book, log: line => logs.push(line),
    routes: {mistral: mistralRoute({provider, endpoint: server.endpoint, gapMs: 0, chatDefaults: {...quickOn(clock), retries: 0}})}});
  try {
    const stream = new ReplyStream({name: 'Judy Alvarez'});
    const reply = host.reply(turn('hello'), {stream});
    // The stall limit is armed when the first piece of the reply arrives: the silence lasts as long as the clock is left alone.
    const early = watch(reply);
    await within(stream.headReady, 'the first sentence');
    await clock.advance(QUICK.stallMs - 1);
    assert.equal(early.done, false, 'the quiet stream is still waited for inside stallMs');
    await clock.advance(1);
    const result = await within(reply, 'the quiet stream to be cut');
    assert.equal(stream.head, first); assert.equal(result.text, first);
    assert.equal(result.timing.streamedHead, true); assert.equal(result.timing.replyCutShort, 'network');
    assert.equal(stream.tail, '', 'no tail to voice');
    assert.equal(memory.recall({profileKey: 'judy-alvarez', channel: 'private'}).turns.at(-1).r, first);
    assert.ok(logs.some(line => line.includes('that sentence is the reply')), logs.join('|'));
  } finally { host.close(); server.http.closeAllConnections?.(); await new Promise(done => server.http.close(done)); }
});

// ---- An add-on speaker never says V's words (live 2026-10-16: the cab said "Thanks, Del." after V's "thanks del") -----------------------

test('an add-on host cuts V\'s own line off the front of a reply, in the voice\'s stream and in the finished text', async () => {
  const {ReplyStream} = await import('./reply-stream.mjs');
  const echo = 'Thanks, Del. A short drive is still a drive, and I will make it smooth. Nine hundred metres is nothing to me.';
  const {host, close} = await harness(() => echo, {host: {stripPlayerEcho: true}});
  try {
    const stream = new ReplyStream({name: 'Judy Alvarez'});
    const heads = [];
    stream.onChange(() => { if (stream.head !== null) heads.push(stream.head); });
    const result = await host.reply(turn('thanks del'), {stream});
    assert.equal(result.text, 'A short drive is still a drive, and I will make it smooth. Nine hundred metres is nothing to me.');
    assert.equal(stream.head, 'A short drive is still a drive, and I will make it smooth.', 'the voice started on the answer, never on V\'s words');
    assert(!heads.some(head => /thanks/i.test(head)));
    assert.doesNotMatch(stream.text, /Thanks, Del/);
  } finally { await close(); }
});

test('without the option a host still cuts a short echo of V\'s words off the front (rule 4) and a stock closing question (rule 5), and leaves every other opening as the model wrote it', async () => {
  // The add-on option above cuts V's whole line and V's script labels; the echo opener (a first sentence of up to five words that is V's own words) is cut for every speaker.
  const echo = await harness(() => 'Thanks, Del. A short drive is still a drive, and I will make it smooth.');
  try {
    const result = await echo.host.reply(turn('thanks del'));
    assert.equal(result.text, 'A short drive is still a drive, and I will make it smooth.');
  } finally { await echo.close(); }
  const plain = await harness(() => 'Hey yourself. A short drive is still a drive, and I will make it smooth.');
  try {
    const result = await plain.host.reply(turn('hey'));
    assert.match(result.text, /^Hey yourself\. A short drive/, 'a greeting answered in kind is not the fault');
  } finally { await plain.close(); }
  const stock = await harness(() => 'I am fine, the work is the work. What is on your mind?');
  try {
    const result = await stock.host.reply(turn('how are you?'));
    assert.equal(result.text, 'I am fine, the work is the work.', 'a generic closing question is dropped when the reply has words of its own');
  } finally { await stock.close(); }
});

test('an add-on host keeps only its own lines when the model writes V\'s side of the talk as a script', async () => {
  const {host, close} = await harness(() => 'V: Thanks, Del.\nJudy Alvarez: A short drive is still a drive, and I will make it smooth.\nV: Really?', {host: {stripPlayerEcho: true}});
  try {
    const result = await host.reply(turn('thanks del'));
    assert.equal(result.text, 'A short drive is still a drive, and I will make it smooth.');
  } finally { await close(); }
});

test('an add-on host shows the model its own earlier replies without V\'s words at their start', async () => {
  const {server, host, memory, close} = await harness(() => 'The route is optimal.', {host: {stripPlayerEcho: true}});
  try {
    memory.record({profileKey: 'judy-alvarez', v: 'thanks del', r: 'Thanks, Del. A short drive is still a drive.'});
    await host.reply(turn('yes'));
    const sent = server.requests.at(-1).body.messages.filter(message => message.role === 'assistant').map(message => message.content);
    assert(!sent.some(content => /^Thanks, Del/.test(content)));
  } finally { await close(); }
});

// ---- An add-on speaker asked about its own remark does not say the remark again (live 2026-10-16, the district line in the cab) -------------

const DISTRICT_LINE = 'Ah, Arroyo. Where the factories hum and the air tastes of oil.';

test('an add-on host holds a reply that starts like its own recent remark away from the voice, and writes it again in new words', async () => {
  const {ReplyStream} = await import('./reply-stream.mjs');
  const {server, host, logs, close} = await harness((body, count) => count === 1 ? DISTRICT_LINE : 'Awful is a strong word, V. I only notice the smog when the windows are down.',
    {host: {stripPlayerEcho: true, spokenLines: () => [DISTRICT_LINE]}});
  try {
    const stream = new ReplyStream({name: 'Judy Alvarez'});
    const heads = [];
    stream.onChange(() => { if (stream.head !== null) heads.push(stream.head); });
    const result = await host.reply(turn('tat must be awful'), {stream});
    assert.equal(server.requests.length, 2, 'asked once more');
    assert.equal(result.text, 'Awful is a strong word, V. I only notice the smog when the windows are down.');
    assert(!heads.some(head => /arroyo/i.test(head)), `the voice never started on the repeat: ${heads.join('|')}`);
    assert(logs.some(line => line.includes('reply repeated a line; asking once more')), logs.join('|'));
  } finally { await close(); }
});

// ---- A repeated line is not worth a second turn (2026-10-20 report: a slow local turn had its text complete at 38.5 s and its voice at 74.8 s: it was asked twice) ----------------------

test('a reply that repeats a line next to words of its own loses the repeated sentence; nothing is asked again', async () => {
  const {server, host, logs, close} = await harness(() => `${DISTRICT_LINE} I only notice the smog when the windows are down.`, {host: {stripPlayerEcho: true, spokenLines: () => [DISTRICT_LINE]}});
  try {
    const result = await host.reply(turn('tat must be awful'));
    assert.equal(server.requests.length, 1, 'no second request');
    assert.equal(result.text, 'I only notice the smog when the windows are down.');
    assert(logs.some(line => line.includes('left the repeated sentence out')), logs.join('|'));
    assert(!logs.some(line => line.includes('asking once more')));
  } finally { await close(); }
});

test('a reply that is wholly a repeated line is kept when the first attempt was already slow, and asked once more when it was quick', async () => {
  let clock = 0;
  const slow = await harness((body, count) => { if (count === 1) clock += 38_500; return DISTRICT_LINE; },
    {host: {stripPlayerEcho: true, spokenLines: () => [DISTRICT_LINE], now: () => clock}});
  try {
    const result = await slow.host.reply(turn('tat must be awful'));
    assert.equal(slow.server.requests.length, 1, 'the slow turn is not doubled');
    assert.equal(result.text, DISTRICT_LINE, 'the first reply stands');
    assert(slow.logs.some(line => /reply repeated a line, but the first attempt took 39 s: keeping it/.test(line)), slow.logs.join('|'));
  } finally { await slow.close(); }
  let quickClock = 0;
  const quick = await harness((body, count) => { quickClock += 2_000; return count === 1 ? DISTRICT_LINE : 'Awful is a strong word, V.'; },
    {host: {stripPlayerEcho: true, spokenLines: () => [DISTRICT_LINE], now: () => quickClock}});
  try {
    const result = await quick.host.reply(turn('tat must be awful'));
    assert.equal(quick.server.requests.length, 2, 'a quick turn is still asked again');
    assert.equal(result.text, 'Awful is a strong word, V.');
  } finally { await quick.close(); }
});

test('a repeated line is kept, not asked again, when the local model is one stall from stepping down', async () => {
  const {server, host, logs, close} = await harness(() => DISTRICT_LINE, {host: {stripPlayerEcho: true, spokenLines: () => [DISTRICT_LINE]}});
  host.routes.mistral.stepDownNear = () => true;
  try {
    assert.equal((await host.reply(turn('tat must be awful'))).text, DISTRICT_LINE);
    assert.equal(server.requests.length, 1);
    assert(logs.some(line => /about to step down: keeping it/.test(line)), logs.join('|'));
  } finally { await close(); }
});

test('a reply that breaks character is still asked again, however slow the first attempt was', async () => {
  let clock = 0;
  const {server, host, close} = await harness((body, count) => { if (count === 1) clock += 38_500; return count === 1 ? 'As an AI language model, I cannot say.' : 'Awful is a strong word, V.'; }, {host: {now: () => clock}});
  try {
    assert.equal((await host.reply(turn('tat must be awful'))).text, 'Awful is a strong word, V.');
    assert.equal(server.requests.length, 2);
  } finally { await close(); }
});

test('without spokenLines the same host does not know the remark, so it cannot catch the repeat (the cause of the live repeat)', async () => {
  const {host, close} = await harness(() => DISTRICT_LINE, {host: {stripPlayerEcho: true}});
  try { assert.equal((await host.reply(turn('tat must be awful'))).text, DISTRICT_LINE); } finally { await close(); }
});

test('a reply that merely opens like a recent line for a word or two is shown as soon as it moves on', async () => {
  const {ReplyStream} = await import('./reply-stream.mjs');
  const {host, close} = await harness(() => 'Ah, Arroyo. It is not so bad once you are used to the smell, V.', {host: {stripPlayerEcho: true, spokenLines: () => [DISTRICT_LINE]}});
  try {
    const stream = new ReplyStream({name: 'Judy Alvarez'});
    const result = await host.reply(turn('is it bad'), {stream});
    assert.equal(result.text, 'Ah, Arroyo. It is not so bad once you are used to the smell, V.');
    assert.match(stream.text ?? '', /^Ah, Arroyo. It is not so bad/, 'shown as written once it moved on');
  } finally { await close(); }
});

test('a server the player runs is asked for no thinking from its very first request (its adaptation starts as one that thinks, kept per address and model); our own llama-server gets neither the fields nor an adaptation', async () => {
  const lease = extra => ({apiKey: 'no-key-needed', endpoint: 'http://127.0.0.1:1234/v1/chat/completions', model: 'LM Studio', requestModel: 'laptop-ai', trustedOrigin: 'http://127.0.0.1:1234', ...extra});
  const serverFor = connection => ({ensure: async () => connection, status: () => ({state: 'ready'}), begin: () => () => {}, touch() {}});
  const route = localRoute({server: serverFor(lease({external: true}))});
  const first = await route.connect(undefined, {});
  assert.equal(first.adapt.thinks, true, 'the fields go with the first request');
  assert.deepEqual(first.noThinking, {reasoning_effort: 'none', chat_template_kwargs: {enable_thinking: false}, think: false});
  assert.equal((await route.connect(undefined, {})).adapt, first.adapt, 'one adaptation per address and model: a refusal learned once is kept');
  const own = await localRoute({server: serverFor(lease({external: false}))}).connect(undefined, {});
  assert.deepEqual([own.adapt, own.noThinking], [undefined, undefined], 'the packaged models never think');
});
