import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {MistralHost, attachMistral} from './mistral-host.mjs';
import {TextProviderHost, attachTextProvider, groqRoute, localRoute, mistralRoute, GROQ_MODELS, isLocalUnavailable, CLOUD_CHAT_LIMITS, HOLDING_LINES} from './text-provider-host.mjs';
import {MistralMemory, MEMORY_LIMITS} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {GroqKey, parseGroqKey} from './groq-key.mjs';
import {PersonaBook, buildMessages, systemHead, parseFacts, factMessages, joinBlocks, FACT_SCHEMA, LIMITS, CONTEXT_PREFIX} from './mistral-prompt.mjs';
import {errorCodeFor, failureKind, MistralError, DEFAULT_MODELS} from './mistral-client.mjs';

const MISTRAL_KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
const GROQ_KEY = 'gsk_' + 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNb';
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);

async function fakeServer(script) {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      const body = JSON.parse(raw);
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
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); })};
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

async function harness(script, {preference = 'mistral', groqKey = null, mistralKey = MISTRAL_KEY, host: hostOptions = {}, groqScript, chatDefaults} = {}) {
  const server = await fakeServer(script);
  const groqServer = groqScript ? await fakeServer(groqScript) : null;
  const groq = groqKey ? await new GroqKey({keyPath: 'g.txt', readText: async () => `api-key=${groqKey}\n`, writeText: async () => {}}).load() : new GroqKey({keyPath: 'g.txt'});
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => mistralKey ? `api-key=${mistralKey}\n` : '', writeText: async () => {}, groq});
  await provider.load();
  provider.setPreference(preference); provider.apply();
  const memory = await MistralMemory.open({path: null});
  const logs = [];
  const mistral = mistralRoute({provider, endpoint: server.endpoint, gapMs: 0, cacheScope: 'scope1', ...(chatDefaults ? {chatDefaults} : {})});
  const routes = {mistral, ...(groqServer ? {groq: groqRoute({provider, endpoint: groqServer.endpoint})} : {})};
  const host = new TextProviderHost({provider, memory, personas: book, routes, log: line => logs.push(line), ...hostOptions});
  const close = async () => { host.close(); await server.close(); await groqServer?.close(); };
  return {server, groqServer, provider, memory, host, logs, close, groq};
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

// ---- Groq ------------------------------------------------------------------------------------------------------------------

test('Groq: qwen first with reasoning off, no prompt_cache_key, and the Groq key goes only to the Groq route', async () => {
  const {groqServer, server, host, close, provider} = await harness(() => 'from mistral', {preference: 'groq', groqKey: GROQ_KEY, groqScript: () => 'Sure thing, V.'});
  try {
    assert.equal(provider.route, 'groq');
    const result = await host.reply(turn('hi'));
    assert.equal(result.text, 'Sure thing, V.');
    assert.equal(result.transport, 'groq');
    const {body, headers} = groqServer.requests[0];
    assert.equal(headers.authorization, `Bearer ${GROQ_KEY}`);
    assert.equal(body.model, 'qwen/qwen3.8-27b');
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.prompt_cache_key, undefined);
    assert.equal(body.max_tokens, 200);
    assert.equal(server.requests.length, 0);
    assert.deepEqual(GROQ_MODELS.map(model => model.id), ['qwen/qwen3.8-27b', 'openai/gpt-oss-20b']);
    assert.equal(GROQ_MODELS[1].body.reasoning_effort, 'low');
  } finally { await close(); }
});

test('Groq at its limit: the same turn goes to Mistral when a Mistral key exists, and Groq is left alone for a while', async () => {
  const {groqServer, server, host, close, provider} = await harness(() => 'From Mistral, V.', {preference: 'groq', groqKey: GROQ_KEY,
    groqScript: () => ({status: 429, message: 'Rate limit reached for model on tokens per day (TPD): Limit 200000', headers: {'retry-after': '0'}})});
  try {
    const result = await host.reply(turn('hi'));
    assert.equal(result.text, 'From Mistral, V.');
    assert.equal(result.transport, 'mistral');
    assert.equal(groqServer.requests.length, 1, 'a daily limit is not retried');
    assert.equal(server.requests.length, 1);
    assert.equal(provider.groqLimit.kind, 'daily');
    assert.equal(provider.requested, 'mistral');
    assert.equal(provider.pending, true);
    assert.equal(server.requests[0].headers.authorization, `Bearer ${MISTRAL_KEY}`);
    assert.doesNotMatch(JSON.stringify(server.requests), new RegExp(GROQ_KEY));
    assert.doesNotMatch(JSON.stringify(groqServer.requests.map(request => request.body)), new RegExp(MISTRAL_KEY));
  } finally { await close(); }
});

test('Groq at its limit with no Mistral key: the turn fails with a groq-limit code and Convai is requested next', async () => {
  const {host, close, provider} = await harness(() => 'x', {preference: 'groq', groqKey: GROQ_KEY, mistralKey: null,
    groqScript: () => ({status: 429, message: 'Rate limit reached for model on tokens per minute (TPM)', headers: {'retry-after': '30'}})});
  try {
    const error = await host.reply(turn('hi')).catch(caught => caught);
    assert.equal(errorCodeFor(error), 'groq-limit');
    assert.equal(provider.groqLimit.kind, 'rate');
    assert.equal(provider.requested, 'convai');
    assert.doesNotMatch(error.message, new RegExp(GROQ_KEY));
  } finally { await close(); }
});

test('Groq key and model failures are remembered (invalid until the key changes) and fall through to Mistral', async () => {
  const bad = await harness(() => 'ok from mistral', {preference: 'groq', groqKey: GROQ_KEY, groqScript: () => ({status: 401, message: `Invalid API Key ${GROQ_KEY}`})});
  try {
    assert.equal((await bad.host.reply(turn('hi'))).text, 'ok from mistral');
    assert.equal(bad.provider.groqLimit.kind, 'invalid');
    assert.equal(bad.provider.requested, 'mistral');
    bad.provider.groq.key = GROQ_KEY; // a saved key ends the block
    await bad.provider.groq.save(GROQ_KEY);
    assert.equal(bad.provider.groqLimit, null);
    assert.equal(bad.provider.requested, 'groq');
  } finally { await bad.close(); }
});

test('Groq preference without a Groq key requests Convai and says so once; the Groq key shape is checked', async () => {
  const {provider, close} = await harness(() => 'x', {preference: 'groq', groqKey: null});
  try {
    assert.equal(provider.requested, 'convai');
    assert.equal(provider.takeNotice(), 'groq-no-key');
    assert.equal(provider.takeNotice(), undefined);
    assert.equal(parseGroqKey(`api-key=${GROQ_KEY}`), GROQ_KEY);
    assert.equal(parseGroqKey(MISTRAL_KEY), null);
    assert.equal(parseGroqKey('gsk_short'), null);
    assert(provider.secrets().every(secret => secret !== GROQ_KEY));
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
    const started = Date.now();
    const [one, two] = await Promise.all([host.reply(turn('one')), host.reply(turn('two'))]);
    assert(Date.now() - started < 900, 'no one-second pacing on the local route');
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

test('local: a server that cannot start fails the turn once, asks for Convai and queues the single notice', async () => {
  const fail = () => { const error = new Error('The local AI is not available [local:unavailable]'); error.reason = 'low-memory'; throw error; };
  const {host, provider, close} = await localHarness(() => 'x', {ensure: async () => fail()});
  try {
    const error = await host.reply(turn('hi')).catch(caught => caught);
    assert(isLocalUnavailable(error));
    assert.equal(provider.localBroken, 'low-memory');
    assert.equal(provider.requested, 'convai');
    assert.equal(provider.pending, true);
    provider.apply();
    assert.equal(provider.takeNotice(), 'local-fallback');
    assert.equal(provider.takeNotice(), undefined);
    provider.noteLocalFailure('low-memory'); // the same failure again says nothing more
    assert.equal(provider.takeNotice(), undefined);
    // Choosing the provider again tries again.
    provider.setPreference('convai'); provider.setPreference('local');
    assert.equal(provider.requested, 'local');
  } finally { await close(); }
});

test('local: summaries and fact extraction wait for the gate (no combat, nothing speaking) and the server is never started for them', async () => {
  let open = false;
  const summaryRequests = () => llama.requests.filter(request => /private memory/.test(request.body.messages[0].content));
  const {llama, host, close, calls} = await localHarness(body => /private memory/.test(body.messages[0].content) ? 'I told V my plans.' : 'Fine.',
    {gate: () => open, idleRetryMs: 25});
  try {
    for (let i = 0; i < MEMORY_LIMITS.turns + MEMORY_LIMITS.batch; i++) await host.reply(turn(`question ${i}`));
    await new Promise(done => setTimeout(done, 120));
    assert.equal(summaryRequests().length, 0, 'gate closed: no summary');
    open = true;
    await new Promise(done => setTimeout(done, 200));
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
    await new Promise(done => setTimeout(done, 20));
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

test('errors name their provider, and only a refused Mistral or Groq key becomes a game code', () => {
  const groq = new MistralError('limit', 'rate limited', {provider: 'groq'});
  assert.match(groq.message, /^Groq .*\[groq:limit\]$/);
  assert.equal(failureKind(groq), 'limit');
  assert.equal(errorCodeFor(groq), 'groq-limit');
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
    await new Promise(done => setTimeout(done, 150));
    assert(seen.includes(2), 'the summary asked the scheduler for a background slot');
    assert.equal(seen.filter(priority => priority === 0).length, MEMORY_LIMITS.turns + MEMORY_LIMITS.batch);
    assert(noted.length >= seen.length, 'the headers of every answer reach the scheduler');
    host.close();
  } finally { await server.close(); }
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

test('the cloud routes give up on a silent request after 6 s, ask once more with 8 s, and cut a stream that goes quiet after 8 s', () => {
  assert.deepEqual({...CLOUD_CHAT_LIMITS}, {firstByteMs: 6000, retryFirstByteMs: 8000, stallMs: 8000, retries: 1, backoffMs: [300]});
  assert.ok(CLOUD_CHAT_LIMITS.firstByteMs + CLOUD_CHAT_LIMITS.backoffMs[0] + CLOUD_CHAT_LIMITS.retryFirstByteMs < 15000, 'the worst case before the holding line');
});

test('a request that never answers is asked again at once and the reply arrives; the failed ask is in the timing and the log', async () => {
  const {server, host, logs, close} = await harness((_body, count) => count === 1 ? {hang: true} : 'Sure thing, V. Come on in and sit down.', {chatDefaults: QUICK});
  try {
    const started = performance.now();
    const result = await host.reply(turn('hello'));
    assert.equal(result.text, 'Sure thing, V. Come on in and sit down.');
    assert.equal(server.requests.length, 2); assert.equal(result.timing.attempts, 2);
    assert.equal(result.timing.llmFailed.length, 1); assert.equal(result.timing.llmFailed[0].kind, 'network');
    assert.ok(performance.now() - started < 1500, 'not the 25 s the hung request used to take');
    assert.ok(logs.some(line => /attempt 1 failed after \d+ ms \(network, no answer in time\); asking again/.test(line)), logs.join('|'));
  } finally { await close(); }
});

test('a service that stays silent gives a short line in the character\'s voice, not an error, and the line is not remembered', async () => {
  const {host, memory, close} = await harness(() => ({hang: true}), {chatDefaults: QUICK});
  try {
    const result = await host.reply(turn('hello there'));
    assert.ok(HOLDING_LINES.includes(result.text), result.text);
    assert.equal(result.timing.holdingLine, true); assert.equal(result.timing.attempts, 2);
    assert.equal(result.timing.llmFailed.length, 2);
    assert.deepEqual(memory.recall({profileKey: 'judy-alvarez', channel: 'private'}).turns, [], 'the holding line answers nothing: it is not recorded as a talk');
    const again = await host.reply(turn('hello again'));
    assert.notEqual(again.text, result.text, 'the lines take turns');
  } finally { await close(); }
});

test('a holding line goes through a stream like any reply, so the voice and the subtitles speak it', async () => {
  const {ReplyStream} = await import('./reply-stream.mjs');
  const {host, close} = await harness(() => ({hang: true}), {chatDefaults: QUICK});
  try {
    const stream = new ReplyStream({name: 'Judy Alvarez'});
    const result = await host.reply(turn('hello'), {stream});
    assert.equal(await stream.finished, result.text); assert.ok(HOLDING_LINES.includes(stream.text));
  } finally { await close(); }
});

test('a refused key, a limit and a battle bark are not turned into a holding line', async () => {
  const refused = await harness(() => ({status: 401, message: 'bad key'}), {chatDefaults: QUICK});
  try { await assert.rejects(refused.host.reply(turn('hello')), error => failureKind(error) === 'key'); } finally { await refused.close(); }
  const quiet = await harness(() => ({hang: true}), {chatDefaults: QUICK});
  try { await assert.rejects(quiet.host.reply(turn('hello', {reaction: {phase: 'start'}})), error => failureKind(error) === 'network'); } finally { await quiet.close(); }
});

test('a server fault is a holding line too, after its retry', async () => {
  const {server, host, close} = await harness(() => ({status: 503, message: 'overloaded'}), {chatDefaults: QUICK});
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
  const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${MISTRAL_KEY}\n`, writeText: async () => {}, groq: new GroqKey({keyPath: 'g.txt'})});
  await provider.load(); provider.setPreference('mistral'); provider.apply();
  const memory = await MistralMemory.open({path: null}), logs = [];
  const host = new TextProviderHost({provider, memory, personas: book, log: line => logs.push(line),
    routes: {mistral: mistralRoute({provider, endpoint: server.endpoint, gapMs: 0, chatDefaults: {...QUICK, retries: 0}})}});
  try {
    const stream = new ReplyStream({name: 'Judy Alvarez'});
    const result = await host.reply(turn('hello'), {stream});
    assert.equal(stream.head, first); assert.equal(result.text, first);
    assert.equal(result.timing.streamedHead, true); assert.equal(result.timing.replyCutShort, 'network');
    assert.equal(stream.tail, '', 'no tail to voice');
    assert.equal(memory.recall({profileKey: 'judy-alvarez', channel: 'private'}).turns.at(-1).r, first);
    assert.ok(logs.some(line => line.includes('that sentence is the reply')), logs.join('|'));
  } finally { host.close(); server.http.closeAllConnections?.(); await new Promise(done => server.http.close(done)); }
});
