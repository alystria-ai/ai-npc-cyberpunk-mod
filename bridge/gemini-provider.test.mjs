// The Google Gemini conversation provider (bridge/gemini-provider.mjs, docs/GEMINI.md): the Custom provider's client on a second endpoint with its own saved key. Against the loopback
// mock (bridge/openai-mock-server.mjs): no real network, no real key.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {streamChat, errorCodeFor, errorExtrasFor, failureKind, googleQuota, nextPacificMidnight, MistralError} from './mistral-client.mjs';
import {TextProviderHost, customRoute} from './text-provider-host.mjs';
import {CustomEndpoint, parseEndpointUrl, PRESETS} from './custom-endpoint.mjs';
import {MistralProvider, PROVIDERS} from './mistral-key.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {MatureContent, MATURE_PROVIDERS} from './mature-content.mjs';
import {customProfileId, profileIdFor} from './prompt-profiles.mjs';
import {GEMINI_ENDPOINT, GEMINI_MODEL, GEMINI_FILE, activeEndpoint, isCustomRoute, migrateEarlierSetups, openGeminiEndpoint} from './gemini-provider.mjs';
import {startOpenAiMock} from './openai-mock-server.mjs';

const KEY = 'AQ.' + 'Ab8RN6KjXy_ZqW3-e'.repeat(3).slice(0, 50);
const MISTRAL_KEY = 'mk' + 'a1B2c3D4e5'.repeat(3);
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];
const quick = {firstByteMs: 400, retryFirstByteMs: 400, totalMs: 1500, retries: 1, backoffMs: [5]};

const none = async () => { throw Error('none'); };
const setUpGemini = async (gemini, key = KEY) => { await gemini.setUrl(parseEndpointUrl(GEMINI_ENDPOINT)); await gemini.setModel(GEMINI_MODEL); if (key) await gemini.setKey(key); };

test('the fixed endpoint and model are the free plan\'s, and the provider is one of the saved choices', () => {
  assert.equal(GEMINI_ENDPOINT, 'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.equal(GEMINI_MODEL, 'gemini-flash-lite-latest');
  assert.equal(PRESETS.gemini.endpoint, GEMINI_ENDPOINT);
  assert.deepEqual(PROVIDERS, ['convai', 'mistral', 'local', 'custom', 'gemini']);
  assert.equal(GEMINI_FILE, 'player-gemini-endpoint.txt');
  assert.deepEqual(['custom', 'gemini', 'mistral', 'local', 'convai'].map(isCustomRoute), [true, true, false, false, false]);
});

test('Gemini is requested only with a key, falls back to Convai with one notice otherwise, and switches at the idle boundary', async () => {
  const custom = new CustomEndpoint({path: null}), gemini = new CustomEndpoint({path: null});
  const provider = await new MistralProvider({keyPath: 'k', readText: none, writeText: async () => {}, custom, gemini}).load();
  // Chosen with no key: Convai answers, the reason is named, and the notice comes once with the next reply.
  assert.equal(provider.setPreference('gemini'), true);
  assert.equal(provider.requested, 'convai');
  assert.equal(provider.fallbackReason, 'gemini-no-key');
  provider.apply();
  assert.equal(provider.takeNotice(), 'gemini-no-key');
  assert.equal(provider.takeNotice(), undefined, 'once');
  // The key arrives (Add): the provider is requested, but turns keep their provider until the idle boundary.
  await setUpGemini(gemini);
  assert.equal(provider.requested, 'gemini');
  assert.equal(provider.pending, true);
  assert.equal(provider.route, 'convai');
  assert.equal(provider.apply(), true);
  assert.deepEqual([provider.route, provider.active, provider.pending, provider.fallbackReason], ['gemini', true, false, null]);
  assert.equal(provider.takeNotice({cloudVoice: false}), undefined);
  assert.equal(provider.takeNotice({cloudVoice: true}), 'gemini-voice', 'the Convai cloud voice is replaced by a local one, said once');
  assert.equal(provider.takeNotice({cloudVoice: true}), undefined);
  // The key is removed while Gemini answers: the setting falls back to Convai at the next boundary, and the player is told why.
  await gemini.clearKey();
  assert.equal(provider.requested, 'convai');
  provider.apply();
  assert.equal(provider.takeNotice(), 'gemini-no-key');
  assert.ok(provider.secrets().every(secret => secret !== KEY));
  await gemini.setKey(KEY);
  assert.ok(provider.secrets().includes(KEY), 'a Gemini key is scrubbed from reports');
});

test('the Custom provider and Gemini keep their own endpoints at the same time; the turns use the one applied', async () => {
  const custom = new CustomEndpoint({path: null}), gemini = new CustomEndpoint({path: null});
  await custom.setUrl(parseEndpointUrl('https://openrouter.ai/api/v1')); await custom.setModel('vendor/model:free'); await custom.setKey('or-key-' + 'x'.repeat(20));
  await setUpGemini(gemini);
  const provider = await new MistralProvider({keyPath: 'k', readText: none, writeText: async () => {}, custom, gemini}).load();
  const turn = activeEndpoint({provider, custom, gemini});
  provider.setPreference('custom'); provider.apply();
  assert.deepEqual([turn.host, turn.model, turn.ready], ['openrouter.ai', 'vendor/model:free', true]);
  provider.setPreference('gemini');
  assert.equal(turn.host, 'openrouter.ai', 'a choice made during a conversation changes nothing until the boundary');
  provider.apply();
  assert.deepEqual([turn.host, turn.model, turn.key, turn.chatUrl], ['generativelanguage.googleapis.com', GEMINI_MODEL, KEY, `${GEMINI_ENDPOINT}/chat/completions`]);
  assert.equal(custom.host, 'openrouter.ai', 'the Custom settings were not touched');
  provider.setPreference('custom'); provider.apply();
  assert.equal(turn.host, 'openrouter.ai');
});

test('the saved file: endpoint, model and key in player-gemini-endpoint.txt, the key bound to Google\'s address, read again after a restart', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gemini-'));
  try {
    const first = await openGeminiEndpoint(directory);
    await setUpGemini(first);
    const text = await readFile(join(directory, GEMINI_FILE), 'utf8');
    assert.match(text, /endpoint=https:\/\/generativelanguage\.googleapis\.com\/v1beta\/openai\n/);
    assert.match(text, /model=gemini-flash-lite-latest\n/);
    assert.ok(text.includes(`api-key=${KEY}\n`) && text.includes('key-origin=https://generativelanguage.googleapis.com'));
    const second = await openGeminiEndpoint(directory);
    assert.deepEqual([second.ready, second.key, second.preset], [true, KEY, 'gemini']);
    // A key edited in beside another address is forgotten, never sent there.
    await writeFile(join(directory, GEMINI_FILE), text.replace('generativelanguage.googleapis.com', 'example.com'));
    const third = await openGeminiEndpoint(directory);
    assert.equal(third.key, null);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('Mature content never goes to Gemini: no entry, no layer, the profile is the generic Custom one', async () => {
  assert.equal(MATURE_PROVIDERS.gemini, false);
  const setting = new MatureContent(); setting.setPack(true); setting.update({matureContent: true});
  assert.equal(setting.forTurn('gemini', GEMINI_MODEL, {}), null);
  assert.equal(profileIdFor({route: 'gemini', custom: {origin: 'https://generativelanguage.googleapis.com', model: GEMINI_MODEL}}),
    customProfileId('https://generativelanguage.googleapis.com', GEMINI_MODEL));
  assert.match(customProfileId('https://generativelanguage.googleapis.com', GEMINI_MODEL), /^custom-generativelanguage-googleapis-com-gemini-flash-lite-latest$/);
  const gemini = new CustomEndpoint({path: null});
  const route = customRoute({provider: {noteSuccess() {}, noteLimit() {}}, custom: gemini, name: 'gemini'});
  assert.deepEqual([route.name, route.provider], ['gemini', 'custom'], 'the Custom client, a route of its own');
  assert.equal(customRoute({provider: {}, custom: gemini}).name, 'custom');
});

async function harness(mock, {matureOn = false} = {}) {
  const custom = new CustomEndpoint({path: null}), gemini = new CustomEndpoint({path: null});
  // The mock stands in for Google: the same endpoint object, its address moved to the loopback server.
  await gemini.setUrl(parseEndpointUrl(mock.url)); await gemini.setModel(GEMINI_MODEL); await gemini.setKey(KEY);
  const provider = await new MistralProvider({keyPath: 'k', readText: none, writeText: async () => {}, custom, gemini}).load();
  provider.setPreference('gemini'); provider.apply();
  const memory = await MistralMemory.open({path: null});
  const logs = [];
  const route = customRoute({provider, custom: gemini, name: 'gemini', chat: options => streamChat({...options, ...quick}), busyBackoffMs: [5, 10]});
  const matureContent = new MatureContent(); matureContent.setPack(true); matureContent.update({matureContent: matureOn});
  const host = new TextProviderHost({provider, memory, personas: new PersonaBook(roster), routes: {gemini: route}, log: line => logs.push(line), matureContent});
  return {gemini, provider, route, host, logs};
}
const turn = (text, extra = {}) => ({text, context: 'CURRENT PERSON\nQuest facts here.', sessionId: 'session-1',
  local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}, ...extra});

test('a whole turn on the gemini route: the saved model, the key as a Bearer token to the endpoint only, and a picture goes as an image_url part', async () => {
  const mock = await startOpenAiMock();
  const {host, provider} = await harness(mock);
  try {
    mock.behave(() => ({sse: ['Sure, V. ', 'Go on.'], model: GEMINI_MODEL}));
    const picture = [{mime: 'image/jpeg', base64: Buffer.from('a street').toString('base64')}];
    const result = await host.reply(turn('What do you see?', {visionImages: picture}));
    assert.equal(provider.route, 'gemini');
    assert.equal(result.text, 'Sure, V. Go on.');
    assert.equal(result.transport, 'gemini');
    const [{headers, body}] = mock.requests;
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(body.model, GEMINI_MODEL);
    assert.equal(body.stream, true);
    const last = body.messages.at(-1);
    assert.deepEqual(last.content.map(part => part.type), ['image_url', 'text']);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(KEY.replace(/[.]/g, '\\.')), 'the key is in the header only');
    assert.equal(provider.limit, null);
  } finally { host.close(); await mock.close(); }
});

test('Mature content on beside Gemini adds no Mature layer to the prompt', async () => {
  const mock = await startOpenAiMock();
  const {host, logs} = await harness(mock, {matureOn: true});
  try {
    mock.behave(() => ({sse: ['Fine.']}));
    await host.reply(turn('Hello.'));
    const system = mock.requests[0].body.messages[0].content;
    assert.doesNotMatch(system, /MATURE|Mature content|adult/i);
    assert.ok(logs.every(line => !/layer applied/i.test(line) || /NOT applied/.test(line)), logs.join('\n'));
  } finally { host.close(); await mock.close(); }
});

test('a 400 API_KEY_INVALID is a key the endpoint did not accept: the provider records "invalid" and the turn fails with the key code', async () => {
  const mock = await startOpenAiMock();
  const {host, provider} = await harness(mock);
  try {
    mock.behave(() => ({status: 400, body: [{error: {code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT',
      details: [{'@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com'}]}}]}));
    const error = await host.reply(turn('Hello.')).catch(caught => caught);
    assert.equal(error.kind, 'key');
    assert.equal(provider.limit?.kind, 'invalid');
    assert.equal(provider.route, 'gemini', 'the provider stays Gemini: nothing is handed to another one');
  } finally { host.close(); await mock.close(); }
});

test('Google answers a key of the newer AQ. format it does not know with a 400 "Invalid Auth key.": a key it did not accept', async () => {
  const mock = await startOpenAiMock();
  const {host, provider} = await harness(mock);
  try {
    mock.behave(() => ({status: 400, body: [{error: {code: 400, message: 'Invalid Auth key.', status: 'INVALID_ARGUMENT'}}]}));
    const error = await host.reply(turn('Hello.')).catch(caught => caught);
    assert.equal(error.kind, 'key');
    assert.equal(provider.limit?.kind, 'invalid');
  } finally { host.close(); await mock.close(); }
});

// Google's real answers (ai.google.dev/gemini-api/docs/api-errors, /rate-limits): the OpenAI-compatible endpoint answers an error as a list of one object.
const quotaBody = (quotaId, retryDelay, message = 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.') =>
  [{error: {code: 429, message, status: 'RESOURCE_EXHAUSTED', details: [
    {'@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId, quotaDimensions: {model: 'gemini-flash-lite', location: 'global'}, quotaValue: '20'}]},
    {'@type': 'type.googleapis.com/google.rpc.Help', links: [{description: 'Learn more about Gemini API quotas', url: 'https://ai.google.dev/gemini-api/docs/rate-limits'}]},
    {'@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay}]}}];

test('Gemini has its own notice for each answer Google gives, and none of them is the Custom wording', async () => {
  const mock = await startOpenAiMock();
  const {host, provider, gemini} = await harness(mock);
  try {
    const cases = [
      // [what Google answered, kind, notice code, provider limit, requests]
      [{status: 400, body: [{error: {code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT', details: [{'@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID'}]}}]}, 'key', 'gemini-key', 'invalid', 1],
      [{status: 403, body: [{error: {code: 403, message: 'Your API key was reported as leaked. Please use another API key.', status: 'PERMISSION_DENIED'}}]}, 'key', 'gemini-key', 'invalid', 1],
      [{status: 401, body: [{error: {code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED'}}]}, 'key', 'gemini-key', 'invalid', 1],
      // The daily allowance: "exceeded your current quota" is not about credit here, and a wait of seconds would not help (no retry).
      [{status: 429, body: quotaBody('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '37s')}, 'daily', 'gemini-daily', 'daily', 1],
      // A per-minute limit that clears within the wait the client allows is waited out once (the second request answers 429 again).
      [{status: 429, body: quotaBody('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '1s')}, 'limit', 'gemini-limit', 'rate', 2],
      [{status: 429, body: quotaBody('GenerateContentInputTokensPerModelPerMinute-FreeTier', '45s')}, 'limit', 'gemini-limit', 'rate', 1],
      [{status: 400, body: [{error: {code: 400, message: 'User location is not supported for the API use.', status: 'FAILED_PRECONDITION'}}]}, 'region', 'gemini-region', 'region', 1],
      [{status: 400, body: [{error: {code: 400, message: 'Gemini API free tier is not available in your country. Please enable billing on your project in Google AI Studio.', status: 'FAILED_PRECONDITION'}}]}, 'region', 'gemini-region', 'region', 1],
      [{status: 503, body: [{error: {code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE'}}]}, 'network', 'gemini-server', null, 3],   // busy: the first request and two retries (bridge/hedged-request.mjs)
      [{status: 500, body: [{error: {code: 500, message: 'An internal error has occurred.', status: 'INTERNAL'}}]}, 'network', 'gemini-server', null, 3],
      [{status: 504, body: [{error: {code: 504, message: 'The request timed out.', status: 'DEADLINE_EXCEEDED'}}]}, 'network', 'gemini-server', null, 2],
      [{status: 404, body: [{error: {code: 404, message: 'models/gemini-old is not found for API version v1beta', status: 'NOT_FOUND'}}]}, 'model', 'gemini-model', 'model', 1],
    ];
    let turns = 0;
    for (const [plan, kind, code, limit, requests] of cases) {
      mock.requests.length = 0;
      provider.noteLimit(null);
      // A wait Google asked for pauses the route for that key: each case is asked with a key of its own.
      await gemini.setKey(KEY + (turns++));
      mock.behave(() => plan);
      const error = await host.reply(turn('Hello.')).catch(caught => caught);
      const label = JSON.stringify(plan).slice(0, 140);
      assert.ok(error instanceof MistralError, label);
      assert.equal(error.kind, kind, label);
      assert.equal(failureKind(error), kind, label);
      assert.equal(errorCodeFor(error), code, label);
      assert.equal(provider.limit?.kind ?? null, limit, label);
      assert.equal(mock.requests.length, requests, label);
      assert.ok(!/custom/i.test(code));
    }
    // The daily allowance comes back at midnight on the Pacific clock: the reply can say when, on this computer's clock.
    mock.behave(() => ({status: 429, body: quotaBody('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '37s')}));
    const daily = await host.reply(turn('Hello.')).catch(caught => caught);
    assert.match(errorExtrasFor(daily).errorResetTime ?? '', /^\d\d:\d\d$/);
    // No connection at all: the server is gone.
    const dead = await startOpenAiMock(); const deadHarness = await harness(dead); await dead.close();
    const gone = await deadHarness.host.reply(turn('Hello.')).catch(caught => caught);
    assert.equal(errorCodeFor(gone), 'gemini-unreachable');
    deadHarness.host.close();
  } finally { host.close(); await mock.close(); }
});

test('a Custom route keeps the Custom wording for the same answers (the Gemini tag is added by the gemini route only)', async () => {
  const mock = await startOpenAiMock();
  const custom = new CustomEndpoint({path: null});
  await custom.setUrl(parseEndpointUrl(mock.url)); await custom.setModel('m'); await custom.setKey(KEY);
  const provider = await new MistralProvider({keyPath: 'k', readText: none, writeText: async () => {}, custom}).load();
  provider.setPreference('custom'); provider.apply();
  const route = customRoute({provider, custom, chat: options => streamChat({...options, ...quick})});
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: new PersonaBook(roster), routes: {custom: route}, log: () => {}});
  try {
    for (const [plan, code] of [
      [{status: 400, body: [{error: {code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT'}}]}, 'custom-key'],
      [{status: 429, body: quotaBody('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '37s')}, 'custom-daily'],
      [{status: 503, body: 'down'}, 'custom-unreachable']]) {
      mock.behave(() => plan);
      assert.equal(errorCodeFor(await host.reply(turn('Hello.')).catch(caught => caught)), code);
    }
  } finally { host.close(); await mock.close(); }
});

test('Google quota answers: the per-day and per-minute quotas, the wait Google names, and the next midnight on the Pacific clock', () => {
  assert.deepEqual(googleQuota(quotaBody('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '37s')[0]), {daily: true, retryMs: 37000});
  assert.deepEqual(googleQuota(quotaBody('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '21.5s')[0]), {daily: false, retryMs: 21500});
  assert.deepEqual(googleQuota({error: {status: 'RESOURCE_EXHAUSTED', message: 'Resource has been exhausted (e.g. check quota).'}}, 'resource has been exhausted (e.g. check quota).'), {daily: false, busy: true}, 'a 429 that names no quota is Google being busy');
  assert.deepEqual(googleQuota({error: {status: 'RESOURCE_EXHAUSTED', message: 'You exceeded your current quota, please check your plan and billing details.'}}, 'you exceeded your current quota, please check your plan and billing details.'), {daily: false}, 'a quota without detail stays the limit');
  assert.deepEqual(googleQuota({error: {message: 'Please retry in 12.5s'}}, 'quota exceeded for metric: generativelanguage.googleapis.com/x. please retry in 12.5s.'), {daily: false, retryMs: 12500});
  assert.equal(googleQuota({error: {message: 'Rate limit exceeded: free-models-per-day'}}, 'rate limit exceeded: free-models-per-day'), null, 'not Google: OpenRouter keeps its own handling');
  // Midnight in Los Angeles: 07:00 UTC in winter (PST), 07:00 UTC in summer is 00:00 PDT. Always within the next 24 hours and on a whole minute.
  const winter = Date.UTC(2026, 0, 15, 12, 0, 0), summer = Date.UTC(2026, 6, 15, 12, 0, 0);
  assert.equal(nextPacificMidnight(winter), Date.UTC(2026, 0, 16, 8, 0, 0));
  assert.equal(nextPacificMidnight(summer), Date.UTC(2026, 6, 16, 7, 0, 0));
  const now = Date.now(), at = nextPacificMidnight(now);
  assert.ok(at > now && at - now <= 24 * 3600_000 + 1000);
});

test('earlier setups: a Gemini preset saved on the Custom page moves to the Gemini provider, and a saved Mistral key fills the Mistral preset', async () => {
  // A test build saved the Gemini plan on the Custom page.
  let custom = new CustomEndpoint({path: null}), gemini = new CustomEndpoint({path: null});
  await setUpGemini(custom);
  assert.equal(custom.preset, 'gemini');
  assert.deepEqual(await migrateEarlierSetups({custom, gemini, mistralKey: null}), ['gemini-preset-to-provider']);
  assert.deepEqual([custom.address, custom.model, custom.key], [null, null, null]);
  assert.deepEqual([gemini.preset, gemini.key], ['gemini', KEY]);
  assert.deepEqual(await migrateEarlierSetups({custom, gemini, mistralKey: null}), [], 'idempotent');
  // A Gemini provider that already has a key is never overwritten.
  custom = new CustomEndpoint({path: null}); gemini = new CustomEndpoint({path: null});
  await setUpGemini(custom, 'other-key-' + 'z'.repeat(20)); await setUpGemini(gemini);
  assert.deepEqual(await migrateEarlierSetups({custom, gemini, mistralKey: null}), []);
  assert.equal(gemini.key, KEY);
  // A saved Mistral key with nothing in the Custom provider fills the Mistral preset (the key bound to Mistral's address)...
  custom = new CustomEndpoint({path: null}); gemini = new CustomEndpoint({path: null});
  assert.deepEqual(await migrateEarlierSetups({custom, gemini, mistralKey: MISTRAL_KEY}), ['mistral-key-to-preset']);
  assert.deepEqual([custom.host, custom.model, custom.key, custom.preset], ['api.mistral.ai', 'ministral-8b-latest', MISTRAL_KEY, 'mistral']);
  assert.equal(custom.keyOrigin, 'https://api.mistral.ai');
  // ...and never replaces what the player set up for Custom.
  custom = new CustomEndpoint({path: null});
  await custom.setUrl(parseEndpointUrl('https://openrouter.ai/api/v1')); await custom.setModel('vendor/model:free');
  assert.deepEqual(await migrateEarlierSetups({custom, gemini: new CustomEndpoint({path: null}), mistralKey: MISTRAL_KEY}), []);
  assert.equal(custom.host, 'openrouter.ai');
});

test('a player who chose Mistral before it left the list keeps it: the provider stays requested with its key, and Gemini does not touch it', async () => {
  const custom = new CustomEndpoint({path: null}), gemini = new CustomEndpoint({path: null});
  const provider = await new MistralProvider({keyPath: 'k', readText: async () => `api-key=${MISTRAL_KEY}\n`, writeText: async () => {}, custom, gemini}).load();
  provider.setPreference('mistral');
  assert.equal(provider.requested, 'mistral');
  provider.apply();
  assert.deepEqual([provider.route, provider.apiKey], ['mistral', MISTRAL_KEY]);
  assert.equal(provider.fallbackReason, null);
});
