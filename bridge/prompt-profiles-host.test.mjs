import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {TextProviderHost, localRoute, customRoute, mistralRoute, samplingBody, LOCAL_STOP_STRINGS} from './text-provider-host.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {PersonaBook, buildMessages, LIMITS} from './mistral-prompt.mjs';
import {MatureContent} from './mature-content.mjs';
import {PromptProfiles} from './prompt-profile-store.mjs';
import {BASE_PROFILE, defaultProfile, customProfileId, profileSignature} from './prompt-profiles.mjs';

// The host chooses a prompt profile per turn (route, loaded tier, Mature setting, Custom endpoint), builds the prompt from it and sends its sampling; a change the player saved
// is in effect on the next turn; a host with no profiles (an add-on's) sends the shipped prompt and the request it always sent.
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const book = new PersonaBook(roster);
const KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';

async function fakeServer(script = () => 'Sure thing, V.', refuse = () => null) {
  const requests = [];
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', chunk => { raw += chunk; });
    request.on('end', () => {
      requests.push(JSON.parse(raw));
      const refusal = refuse(requests.at(-1));
      if (refusal) { response.writeHead(400, {'content-type': 'application/json'}); response.end(JSON.stringify({error: {message: refusal}})); return; }
      response.writeHead(200, {'content-type': 'text/event-stream'});
      for (const piece of String(script(requests.at(-1))).match(/.{1,12}/gs) ?? []) response.write(`data: ${JSON.stringify({choices: [{index: 0, delta: {content: piece}}]})}\n\n`);
      response.end(`data: ${JSON.stringify({choices: [{delta: {}, finish_reason: 'stop'}]})}\n\ndata: [DONE]\n\n`);
    });
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return {requests, endpoint: `http://127.0.0.1:${server.address().port}/v1/chat/completions`, origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done); })};
}
const turn = (text, extra = {}) => ({text, context: 'CURRENT PERSON\nQuest facts here.', sessionId: 's1', local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'},
  contextParts: {now: 'Right now (from the game, this turn only): You are with V in person, at the Clouds.', notes: 'Use {joy} tags.', world: 'Quest: Heist.', volatile: 'Your call whether to ask V anything.'}, ...extra});
const keyed = async (preference, custom = null) => {
  const provider = new MistralProvider({keyPath: 'k.txt', custom, readText: async () => (preference === 'mistral' ? `api-key=${KEY}\n` : ''), writeText: async () => {}});
  await provider.load(); provider.setPreference(preference); provider.apply();
  return provider;
};
const setup = async (kind, {tier = 'standard', mature = false, profileOptions = {}, hostOptions = {}, origin = null, model = 'qwen3-8b', refuse} = {}) => {
  const llama = await fakeServer(undefined, refuse);
  const customEndpoint = kind === 'custom' ? {ready: true, local: true, origin: origin ?? llama.origin, chatUrl: llama.endpoint, model, key: undefined} : null;
  const provider = await keyed(kind, customEndpoint);
  const matureContent = new MatureContent(); matureContent.update({matureContent: mature});
  const profiles = new PromptProfiles(profileOptions);
  let route;
  if (kind === 'mistral') route = mistralRoute({provider, endpoint: llama.endpoint, gapMs: 0, cacheScope: 's'});
  else if (kind === 'local') {
    const server = {status: () => ({state: 'ready', tier, model: 'Test model'}), touch() {}, prewarm: async () => {},
      ensure: async () => ({endpoint: llama.endpoint, apiKey: 'session-key-abcdef123456', model: 'Test model', tier})};
    route = localRoute({server, provider});
  } else {
    route = customRoute({provider, custom: customEndpoint});
  }
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: book, routes: {[kind]: route}, matureContent, promptProfiles: profiles, log: () => {}, ...hostOptions});
  return {llama, host, profiles, route, close: async () => { host.close(); await llama.close(); }};
};
const systemOf = body => body.messages[0].content;

test('Mistral: a turn with no player change sends the base prompt and the request it always sent (no top_p, repeat_penalty or stop)', async () => {
  const t = await setup('mistral');
  try {
    await t.host.reply(turn('hello'));
    const body = t.llama.requests[0];
    assert.equal(body.temperature, defaultProfile('mistral').sampling.temperature);
    assert.equal(body.max_tokens, LIMITS.maxTokens);
    for (const field of ['top_p', 'repeat_penalty', 'stop']) assert.equal(field in body, false, field);
    assert(systemOf(body).includes('OUTPUT RULES (they outrank everything above about format)'));
  } finally { await t.close(); }
});

test('Mistral: a change the player saves is in the very next turn (rules, closing, sampling) and reset brings the default back', async () => {
  const t = await setup('mistral');
  try {
    await t.host.reply(turn('first'));
    const saved = await t.profiles.set('mistral', {rules: [{id: 'short', text: 'Be short, {name}.'}], closing: {text: 'Now answer.'}, sampling: {temperature: 0.2, topP: 0.8, maxTokens: 123}, stop: ['\nV says:']});
    assert.equal(saved.ok, true);
    await t.host.reply(turn('second'));
    const body = t.llama.requests[1];
    assert.equal(body.temperature, 0.2); assert.equal(body.top_p, 0.8); assert.equal(body.max_tokens, 123); assert.deepEqual(body.stop, ['\nV says:']);
    assert(systemOf(body).includes('OUTPUT RULES (they outrank everything above about format)\n1. Be short, Judy Alvarez.'));
    assert(body.messages.at(-1).content.endsWith('(Now answer.)'));
    await t.profiles.reset('mistral');
    await t.host.reply(turn('third'));
    assert.equal(t.llama.requests[2].temperature, defaultProfile('mistral').sampling.temperature);
    assert.equal('top_p' in t.llama.requests[2], false);
    assert.equal(systemOf(t.llama.requests[2]), systemOf(t.llama.requests[0]), 'reset: the default prompt again, byte for byte');
  } finally { await t.close(); }
});

test('Local AI: the loaded model\'s tier picks the profile, the Mature setting picks the Mature one, and our own server gets the profile\'s sampling and stop strings after the end-of-turn ones', async () => {
  for (const [tier, mature, id] of [['lite', false, 'local-lite'], ['standard', false, 'local-standard'], ['lite', true, 'mature-lite'], ['standard', true, 'mature-standard']]) {
    const logs = [];
    const t = await setup('local', {tier, mature, hostOptions: {log: line => logs.push(line)}});
    try {
      await t.profiles.set(id, {sampling: {repeatPenalty: 1.1, topP: 0.9}, stop: ['\nV:'], closing: {text: `Marked for ${id}.`}});
      await t.host.reply(turn('hello'));
      const body = t.llama.requests[0];
      assert.equal(body.repeat_penalty, 1.1, id); assert.equal(body.top_p, 0.9);
      assert.deepEqual(body.stop, [...LOCAL_STOP_STRINGS, '\nV:']);
      assert(body.messages.at(-1).content.includes(`Marked for ${id}.`), id);
      assert(logs.some(line => line.startsWith(`[PromptProfile] turn uses ${id} `)), logs.join('\n'));
      // A different profile's change does not reach this one.
      assert.equal(t.profiles.getOverride(id === 'local-lite' ? 'local-standard' : 'local-lite'), null);
    } finally { await t.close(); }
  }
});

test('Local AI: with no change the request is the profile own: our end-of-turn strings only; Standard sends no repeat_penalty or top_p, Lite its shipped repeat penalty', async () => {
  const lite = await setup('local', {tier: 'lite'});
  try {
    await lite.host.reply(turn('hello'));
    assert.equal(lite.llama.requests[0].repeat_penalty, defaultProfile('local-lite').sampling.repeatPenalty);
    assert.equal(lite.llama.requests[0].temperature, defaultProfile('local-lite').sampling.temperature);
  } finally { await lite.close(); }
  const t = await setup('local', {tier: 'standard'});
  try {
    await t.host.reply(turn('hello'));
    const body = t.llama.requests[0];
    assert.deepEqual(body.stop, [...LOCAL_STOP_STRINGS]);
    assert.equal('repeat_penalty' in body, false); assert.equal('top_p' in body, false);
    assert.equal(body.temperature, defaultProfile('local-standard').sampling.temperature);
  } finally { await t.close(); }
});

test('Mature: the profile of a Mature turn never carries the Mature layer in its text; the layer and the guard come from the code', async () => {
  const t = await setup('local', {tier: 'lite', mature: true});
  try {
    await t.profiles.set('mature-lite', {rules: [{id: 'only', text: 'Speak.'}], examples: [], closing: {text: '', talk: ''}});
    await t.host.reply(turn('hello'));
    const body = t.llama.requests[0];
    assert.match(systemOf(body), /MATURE CONTENT IS ON/);
    assert(body.messages.at(-1).content.includes('V says: hello'));
  } finally { await t.close(); }
});

test('Custom: the profile is the endpoint and model\'s own, starting from the model family; sampling reaches the endpoint; another model is another profile', async () => {
  const t = await setup('custom', {model: 'qwen3-8b'});
  try {
    const id = customProfileId(t.llama.origin, 'qwen3-8b');
    assert.deepEqual(t.profiles.list({route: 'custom', custom: {origin: t.llama.origin, model: 'qwen3-8b'}}).filter(row => row.active).map(row => row.id), [id]);
    await t.host.reply(turn('hello'));
    const plain = t.llama.requests[0];
    assert.equal('repeat_penalty' in plain, false); assert.equal('stop' in plain, false);
    assert.equal(plain.temperature, defaultProfile(id, {family: 'qwen'}).sampling.temperature);
    const profiles = new PromptProfiles({active: () => ({route: 'custom', custom: {origin: t.llama.origin, model: 'qwen3-8b'}})});
    await profiles.set(id, {sampling: {temperature: 0.3, repeatPenalty: 1.05}});
    t.host.promptProfiles = profiles;
    await t.host.reply(turn('again'));
    const tuned = t.llama.requests.at(-1);
    assert.equal(tuned.temperature, 0.3); assert.equal(tuned.repeat_penalty, 1.05);
    assert.equal('stop' in tuned, false, 'a custom endpoint gets a stop string only when the player set one');
  } finally { await t.close(); }
});

test('a host without profiles (an add-on host) and a route without one (Convai) send the shipped prompt', async () => {
  const t = await setup('mistral', {hostOptions: {promptProfiles: null}});
  try {
    await t.host.reply(turn('hello'));
    const body = t.llama.requests[0];
    assert.equal(body.temperature, LIMITS.temperature);
    const expected = buildMessages({persona: book.persona('judy-alvarez', 'Judy Alvarez'), memory: '', history: [], contextParts: turn('x').contextParts, remembered: [], text: 'hello', limits: LIMITS});
    assert.equal(systemOf(body), expected[0].content);
  } finally { await t.close(); }
});

test('samplingBody: only what the profile sets; the end-of-turn strings of our own server are kept in front of the profile\'s', () => {
  assert.deepEqual(samplingBody({temperature: 0.65, topP: null, repeatPenalty: null, maxTokens: 600, stop: []}, {external: false}), {});
  assert.deepEqual(samplingBody({topP: 0.9, repeatPenalty: 1.1, stop: ['\nV:']}, {external: false}), {top_p: 0.9, repeat_penalty: 1.1, stop: [...LOCAL_STOP_STRINGS, '\nV:']});
  assert.deepEqual(samplingBody({stop: ['\nV:']}, {external: true}), {stop: ['\nV:']});
  assert.deepEqual(samplingBody({stop: ['\nV:']}, {}), {stop: ['\nV:']});
});

test('the prompt a profile builds is stable between two turns of one character: the system message differs only in what the context changes (the cache prefix holds)', async () => {
  const t = await setup('local', {tier: 'lite'});
  try {
    await t.host.reply(turn('hello'));
    await t.host.reply(turn('what are you doing'));
    const [a, b] = t.llama.requests.map(systemOf);
    assert.equal(a, b);
    assert(profileSignature(defaultProfile('local-lite')) && defaultProfile('local-lite') !== BASE_PROFILE);
  } finally { await t.close(); }
});

// ---- More samplers: Top K, Min P, the two penalties and the advanced parameters (bridge/sampler-extras.mjs) ----------------------------------------------------

const MORE = {topK: 20, minP: 0.05, presencePenalty: 0.3, frequencyPenalty: 0.2, extra: {typical_p: 0.9, dry_multiplier: 0.8, mirostat: 2, samplers: ['top_k', 'min_p']}};
// A Custom profile exists for the endpoint and model the player configured now.
const onCustom = t => { const profiles = new PromptProfiles({active: () => ({route: 'custom', custom: {origin: t.llama.origin, model: 'qwen3-8b'}})}); t.host.promptProfiles = profiles; return profiles; };
const asFields = {top_k: 20, min_p: 0.05, presence_penalty: 0.3, frequency_penalty: 0.2, typical_p: 0.9, dry_multiplier: 0.8, mirostat: 2, samplers: ['top_k', 'min_p']};

test('samplingBody: Top K, Min P, the penalties and the advanced parameters; a box wins over the same key, a refused key is never sent, Mistral gets only the two penalties', () => {
  assert.deepEqual(samplingBody(MORE, {external: true}, 'local'), asFields);
  assert.deepEqual(samplingBody(MORE, {external: true}, 'custom'), asFields);
  assert.deepEqual(samplingBody(MORE, {external: true}, 'mistral'), {presence_penalty: 0.3, frequency_penalty: 0.2}, 'Mistral refuses unknown fields: no Top K, Min P or extra keys');
  // A file edited by hand can hold a key the form refuses: it never reaches the request, and a box decides over the same key.
  const sneaky = {topP: 0.8, extra: {top_p: 0.1, model: 'other', stream: false, max_tokens: 1, cache_prompt: false, mirostat: 1}};
  assert.deepEqual(samplingBody(sneaky, {external: true}, 'local'), {top_p: 0.8, mirostat: 1});
  assert.deepEqual(samplingBody({extra: null}, {}, 'custom'), {});
});

test('Local AI: Top K, Min P and the advanced parameters reach our llama-server with the reply, and the host\'s own fields are untouched', async () => {
  const t = await setup('local', {tier: 'standard'});
  try {
    assert.equal((await t.profiles.set('local-standard', {sampling: MORE})).ok, true);
    await t.host.reply(turn('hello'));
    const body = t.llama.requests[0];
    for (const [name, value] of Object.entries(asFields)) assert.deepEqual(body[name], value, name);
    assert.equal(body.temperature, defaultProfile('local-standard').sampling.temperature);
    assert.deepEqual(body.stop, [...LOCAL_STOP_STRINGS]);
    assert.equal(body.stream, true);
    assert.equal(body.return_progress, true);
    assert.equal(body.chat_template_kwargs.enable_thinking, false);
  } finally { await t.close(); }
});

test('Custom: the same fields are in the request body; Off and reset take them out again', async () => {
  const t = await setup('custom');
  try {
    const id = customProfileId(t.llama.origin, 'qwen3-8b');
    const profiles = onCustom(t);
    assert.equal((await profiles.set(id, {sampling: MORE})).ok, true);
    await t.host.reply(turn('hello'));
    for (const [name, value] of Object.entries(asFields)) assert.deepEqual(t.llama.requests[0][name], value, name);
    assert.equal((await profiles.set(id, {sampling: {topK: 'off', minP: 'off', extra: null}})).ok, true);
    await t.host.reply(turn('again'));
    for (const name of ['top_k', 'min_p', 'typical_p', 'dry_multiplier', 'mirostat', 'samplers']) assert.equal(name in t.llama.requests[1], false, name);
    assert.equal(t.llama.requests[1].presence_penalty, 0.3, 'the penalties stay until they are switched off');
    await profiles.reset(id);
    await t.host.reply(turn('third'));
    for (const name of ['top_k', 'min_p', 'presence_penalty', 'frequency_penalty', 'typical_p']) assert.equal(name in t.llama.requests[2], false, name);
  } finally { await t.close(); }
});

test('Mistral: the profile refuses Top K, Min P and the advanced parameters, and a turn never sends them', async () => {
  const t = await setup('mistral');
  try {
    for (const sampling of [{topK: 20}, {minP: 0.1}, {extra: {mirostat: 2}}]) {
      const result = await t.profiles.set('mistral', {sampling});
      assert.equal(result.ok, false);
      assert.equal(result.errors[0].code, 'not-for-mistral');
    }
    assert.equal((await t.profiles.set('mistral', {sampling: {presencePenalty: 0.4, frequencyPenalty: 0.1}})).ok, true);
    await t.host.reply(turn('hello'));
    const body = t.llama.requests[0];
    assert.equal(body.presence_penalty, 0.4); assert.equal(body.frequency_penalty, 0.1);
    for (const name of ['top_k', 'min_p', 'mirostat', 'typical_p']) assert.equal(name in body, false, name);
  } finally { await t.close(); }
});

test('Custom: a server that refuses an advanced key loses it, the turn still answers, and the refusal is logged once and remembered', async () => {
  const logs = [];
  const refuse = body => ('mirostat' in body ? "Unsupported parameter: 'mirostat'" : 'dry_multiplier' in body ? 'dry_multiplier: Extra inputs are not permitted' : null);
  const t = await setup('custom', {refuse, hostOptions: {log: line => logs.push(line)}});
  try {
    const id = customProfileId(t.llama.origin, 'qwen3-8b');
    const profiles = onCustom(t);
    assert.equal((await profiles.set(id, {sampling: {topK: 30, extra: {mirostat: 2, dry_multiplier: 0.8, typical_p: 0.9}}})).ok, true);
    const first = await t.host.reply(turn('hello'));
    assert.match(String(first.text ?? first.reply ?? JSON.stringify(first)), /Sure thing/);
    assert.equal(t.llama.requests.length, 3, 'one request per refused key, then the answer');
    const last = t.llama.requests.at(-1);
    assert.equal('mirostat' in last, false); assert.equal('dry_multiplier' in last, false);
    assert.equal(last.typical_p, 0.9); assert.equal(last.top_k, 30, 'what the server accepts stays');
    assert.equal(logs.filter(line => /refused mirostat/.test(line)).length, 1, logs.join('\n'));
    await t.host.reply(turn('second'));
    assert.equal(t.llama.requests.length, 4, 'learned: the next turn is one request');
    assert.equal(logs.filter(line => /left out from now on/.test(line)).length, 2, 'once per learned key (mirostat, dry_multiplier)');
  } finally { await t.close(); }
});

test('Custom: a server that refuses with no field named drops the sampling fields and advanced keys it was sent, and answers', async () => {
  const refuse = body => ('typical_p' in body || 'top_k' in body ? 'Extra inputs are not permitted' : null);
  const t = await setup('custom', {refuse});
  try {
    const id = customProfileId(t.llama.origin, 'qwen3-8b');
    const profiles = onCustom(t);
    await profiles.set(id, {sampling: {topK: 30, extra: {typical_p: 0.9}}});
    const reply = await t.host.reply(turn('hello'));
    assert.match(JSON.stringify(reply), /Sure thing/);
    const last = t.llama.requests.at(-1);
    assert.equal('typical_p' in last, false); assert.equal('top_k' in last, false);
  } finally { await t.close(); }
});
