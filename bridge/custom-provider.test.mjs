// The custom (OpenAI-compatible) provider on the wire and in the host (docs/CUSTOM_PROVIDER.md): the chat client with provider 'custom', the route and a
// whole turn, against the loopback mock (bridge/openai-mock-server.mjs). No real network, no real key.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {streamChat, mapFailure, errorCodeFor, failureKind, MistralError, newAdaptation, redact, rejectedParameters, warmConnection} from './mistral-client.mjs';
import {TextProviderHost, customRoute, mistralRoute} from './text-provider-host.mjs';
import {CustomEndpoint, parseEndpointUrl} from './custom-endpoint.mjs';
import {MistralProvider} from './mistral-key.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {MatureContent} from './mature-content.mjs';
import {MOCK_REPLY, startOpenAiMock} from './openai-mock-server.mjs';

const KEY = 'test' + 'x'.repeat(28);
const roster = [...JSON.parse(await readFile(new URL('../characters/roster.json', import.meta.url), 'utf8')),
  ...JSON.parse(await readFile(new URL('../characters/archetype-roster.json', import.meta.url), 'utf8'))];

const messages = [{role: 'system', content: 'You are a test.'}, {role: 'user', content: 'Hi.'}];
const quick = {firstByteMs: 400, retryFirstByteMs: 400, totalMs: 1500, retries: 1, backoffMs: [5]};
// What a caller of streamChat passes for the saved endpoint of a mock.
const via = (mock, extra = {}) => ({provider: 'custom', endpoint: mock.url + '/chat/completions', trustedOrigin: mock.origin, model: 'test-model', messages, ...extra});

test('a streamed reply: pieces as they arrive, the saved model, the key as a Bearer token only to the endpoint', async () => {
  const mock = await startOpenAiMock();
  try {
    mock.behave(() => ({sse: ['Hello', ', V.', ' Ready.'], model: 'served-model', usage: {total_tokens: 9}}));
    const seen = [];
    const result = await streamChat({...via(mock), apiKey: KEY, onDelta: piece => seen.push(piece), maxTokens: 123, temperature: 0.4});
    assert.equal(result.text, 'Hello, V. Ready.');
    assert.deepEqual(seen, ['Hello', ', V.', ' Ready.']);
    assert.equal(result.model, 'served-model');
    assert.equal(result.finishReason, 'stop');
    assert.equal(result.usage.total_tokens, 9);
    const [{headers, body, url}] = mock.requests;
    assert.equal(url, '/v1/chat/completions');
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(headers.accept, 'text/event-stream');
    assert.deepEqual([body.model, body.stream, body.max_tokens, body.temperature], ['test-model', true, 123, 0.4]);
    assert.deepEqual(Object.keys(headers).filter(name => /referer|x-title/i.test(name)), [], 'no OpenRouter headers unless the caller names them');
    assert.doesNotMatch(JSON.stringify(body), new RegExp(KEY));
  } finally { await mock.close(); }
});

test('no key saved (a server on this computer): the request has no Authorization header', async () => {
  const mock = await startOpenAiMock();
  try {
    for (const apiKey of [undefined, null, '']) {
      mock.requests.length = 0;
      assert.equal((await streamChat({...via(mock), apiKey})).text, MOCK_REPLY);
      assert.equal(mock.requests[0].headers.authorization, undefined);
    }
    // Mistral and the local AI still need their key: the same call without one is refused before any request.
    await assert.rejects(streamChat({...via(mock), provider: 'mistral', apiKey: undefined, endpoint: mock.url + '/chat/completions'}), error => error.kind === 'key');
    assert.equal(mock.requests.length, 1, 'no request was made for the refused ones');
    // A key of the wrong length is refused for the custom provider too (a real key is never that short).
    await assert.rejects(streamChat({...via(mock), apiKey: 'short'}), error => error.kind === 'key');
  } finally { await mock.close(); }
});

test('OpenRouter\'s two optional headers go only where the caller names them, and the key only to the saved origin', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push({url, init}); return {ok: true, status: 200, headers: new Headers({'content-type': 'text/event-stream'}),
    body: new ReadableStream({start(controller) { controller.enqueue(new TextEncoder().encode('data: {"choices":[{"index":0,"delta":{"content":"Hi."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')); controller.close(); }})}; };
  const endpoint = new CustomEndpoint({path: null});
  await endpoint.setUrl(parseEndpointUrl('https://openrouter.ai/api/v1')); await endpoint.setModel('a/b:free'); await endpoint.setKey(KEY);
  await streamChat({provider: 'custom', apiKey: endpoint.key, model: endpoint.model, endpoint: endpoint.chatUrl, trustedOrigin: endpoint.origin, headers: endpoint.extraHeaders, messages, fetchImpl});
  assert.equal(sent[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(sent[0].init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(sent[0].init.headers['X-Title'], 'AI NPC Cyberpunk Mod');
  assert.match(sent[0].init.headers['HTTP-Referer'], /^https:\/\//);
  assert.equal(sent[0].init.redirect, 'error', 'a redirect would take the key to another host');
  // Another host: no such headers.
  const other = new CustomEndpoint({path: null});
  await other.setUrl(parseEndpointUrl('https://nano-gpt.com/api/v1')); await other.setModel('x');
  await streamChat({provider: 'custom', apiKey: KEY, model: 'x', endpoint: other.chatUrl, trustedOrigin: other.origin, headers: other.extraHeaders, messages, fetchImpl});
  assert.equal(sent[1].init.headers['X-Title'], undefined);
  assert.equal(sent[1].init.headers['HTTP-Referer'], undefined);
  // The key is never sent to an address outside the saved origin, nor to a custom request that names none.
  await assert.rejects(streamChat({provider: 'custom', apiKey: KEY, model: 'x', endpoint: 'https://evil.example/v1/chat/completions', trustedOrigin: other.origin, messages, fetchImpl}),
    /only ever sent to the saved endpoint/);
  await assert.rejects(streamChat({provider: 'custom', apiKey: KEY, model: 'x', endpoint: 'https://evil.example/v1/chat/completions', messages, fetchImpl}), /only ever sent to/);
  assert.equal(sent.length, 2, 'neither refused request was sent');
  // Mistral's own refusal text is unchanged.
  await assert.rejects(streamChat({provider: 'mistral', apiKey: KEY, endpoint: 'https://evil.example/v1/chat/completions', messages, fetchImpl}), /The Mistral key is only ever sent to api\.mistral\.ai/);
});

test('a redirect is an error: the key is not carried to another host', async () => {
  const away = await startOpenAiMock(), here = await startOpenAiMock();
  try {
    here.behave(() => ({redirect: away.url + '/chat/completions'}));
    await assert.rejects(streamChat({...via(here), apiKey: KEY, ...quick}), error => error.kind === 'network' && error.redirect === true && /redirect/.test(error.message) && !error.message.includes(KEY));
    assert.equal(away.requests.length, 0);
  } finally { await here.close(); await away.close(); }
});

test('a server that does not stream: its one JSON answer is the reply; and one that refuses "stream" is asked again without it, for good', async () => {
  const mock = await startOpenAiMock();
  try {
    mock.behave(() => ({json: mock.completion('A whole answer, V.', 'plain-model')}));
    const seen = [];
    const result = await streamChat({...via(mock), apiKey: KEY, onDelta: piece => seen.push(piece)});
    assert.equal(result.text, 'A whole answer, V.');
    assert.deepEqual(seen, ['A whole answer, V.']);
    assert.equal(result.model, 'plain-model');
    assert.equal(result.finishReason, 'stop');
    // A JSON body with an error inside is an error, not an empty reply.
    mock.behave(() => ({json: {error: {code: 402, message: 'Insufficient credits'}}}));
    await assert.rejects(streamChat({...via(mock), apiKey: KEY, retries: 0}), error => error.kind === 'credits');
    mock.behave(() => ({json: {choices: [{message: {content: '   '}}]}}));
    await assert.rejects(streamChat({...via(mock), apiKey: KEY, retries: 0}), error => error.kind === 'empty');

    // The server refuses stream: true. The request is sent again with stream: false and the choice is remembered.
    mock.requests.length = 0;
    mock.behave(request => request.body.stream === true
      ? {status: 400, body: {error: {message: "Unsupported value: 'stream' does not support true with this model."}}}
      : {json: mock.completion('Not streamed.')});
    const adapt = newAdaptation();
    assert.equal((await streamChat({...via(mock), apiKey: KEY, adapt})).text, 'Not streamed.');
    assert.deepEqual(mock.requests.map(request => request.body.stream), [true, false]);
    assert.equal(mock.requests[1].headers.accept, 'application/json');
    mock.requests.length = 0;
    assert.equal((await streamChat({...via(mock), apiKey: KEY, adapt})).text, 'Not streamed.');
    assert.deepEqual(mock.requests.map(request => request.body.stream), [false], 'the next request does not ask again');
  } finally { await mock.close(); }
});

test('a server that refuses an optional field: the same request is sent once more without it, and the next ones never send it', async () => {
  const mock = await startOpenAiMock();
  try {
    const refuse = (field, message) => request => field in request.body ? {status: 400, body: {error: {message}}} : null;
    // Named by the server.
    mock.behave(refuse('temperature', "Unsupported value: 'temperature' does not support 0.8 with this model. Only the default (1) value is supported."));
    let adapt = newAdaptation();
    let result = await streamChat({...via(mock), apiKey: KEY, adapt, temperature: 0.8});
    assert.equal(result.text, MOCK_REPLY);
    assert.equal(result.attempts, 2);
    assert.deepEqual(mock.requests.map(request => 'temperature' in request.body), [true, false]);
    assert.equal(mock.requests[1].body.max_tokens, 300, 'only the refused field went');
    mock.requests.length = 0;
    await streamChat({...via(mock), apiKey: KEY, adapt, temperature: 0.8});
    assert.deepEqual(mock.requests.map(request => 'temperature' in request.body), [false], 'remembered for the session');

    // OpenAI's newer models: max_tokens is sent as max_completion_tokens.
    mock.requests.length = 0;
    mock.behave(refuse('max_tokens', "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."));
    adapt = newAdaptation();
    await streamChat({...via(mock), apiKey: KEY, adapt, maxTokens: 77});
    assert.deepEqual(mock.requests.map(request => [request.body.max_tokens, request.body.max_completion_tokens]), [[77, undefined], [undefined, 77]]);

    // The response_format of the fact extraction, and stream_options.
    for (const field of ['response_format', 'stream_options']) {
      mock.requests.length = 0;
      mock.behave(refuse(field, `Unknown parameter: '${field}'.`));
      adapt = newAdaptation();
      result = await streamChat({...via(mock), apiKey: KEY, adapt, extraBody: {[field]: field === 'stream_options' ? {include_usage: true} : {type: 'json_object'}}});
      assert.equal(result.attempts, 2, field);
      assert.deepEqual(mock.requests.map(request => field in request.body), [true, false], field);
    }

    // Unsupported, but not named: every optional field goes.
    mock.requests.length = 0;
    mock.behave(request => 'response_format' in request.body || 'temperature' in request.body ? {status: 422, body: {detail: 'Extra inputs are not permitted: unsupported parameter in request body'}} : null);
    adapt = newAdaptation();
    await streamChat({...via(mock), apiKey: KEY, adapt, extraBody: {response_format: {type: 'json_object'}}});
    assert.deepEqual(mock.requests.map(request => ['temperature' in request.body, 'response_format' in request.body]), [[true, true], [false, false]]);

    // Only one more try: a refusal that keeps coming is an error, after exactly two requests.
    mock.requests.length = 0;
    mock.behave(() => ({status: 400, body: {error: {message: "Unsupported parameter: 'temperature'"}}}));
    await assert.rejects(streamChat({...via(mock), apiKey: KEY, adapt: newAdaptation(), retries: 3, ...quick, retries: 3}), error => error.kind === 'request');
    assert.equal(mock.requests.length, 2);

    // A refused model is not a refused field, and a plain 400 is neither: no second request.
    for (const [plan, kind] of [[{status: 400, body: {error: {message: 'The model `nope` does not exist or you do not have access to it.'}}}, 'model'],
      [{status: 400, body: {error: {message: 'messages: Input should be a valid list'}}}, 'request']]) {
      mock.requests.length = 0;
      mock.behave(() => plan);
      await assert.rejects(streamChat({...via(mock), apiKey: KEY, adapt: newAdaptation(), ...quick}), error => error.kind === kind, kind);
      assert.equal(mock.requests.length, 1, kind);
    }
  } finally { await mock.close(); }
});

test('a server that refuses one field at a time: each refusal that teaches something is asked again, so the first turn (and Test connection) works', async () => {
  const mock = await startOpenAiMock();
  try {
    // OpenAI's reasoning models name one refused field per answer: max_tokens first, then temperature.
    mock.behave(request => 'max_tokens' in request.body ? {status: 400, body: {error: {message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."}}}
      : 'temperature' in request.body ? {status: 400, body: {error: {message: "Unsupported value: 'temperature' does not support 0.8 with this model. Only the default (1) value is supported."}}} : null);
    const adapt = newAdaptation();
    const result = await streamChat({...via(mock), apiKey: KEY, adapt, temperature: 0.8, maxTokens: 50, retries: 0});
    assert.equal(result.text, MOCK_REPLY);
    assert.equal(result.attempts, 3);
    assert.deepEqual(mock.requests.map(({body}) => [body.max_tokens, body.max_completion_tokens, body.temperature]), [[50, undefined, 0.8], [undefined, 50, 0.8], [undefined, 50, undefined]]);
    assert.deepEqual([adapt.swapped, [...adapt.dropped]], [true, ['temperature']], 'the rename of max_tokens dropped nothing else (the fact extraction keeps response_format)');
    mock.requests.length = 0;
    await streamChat({...via(mock), apiKey: KEY, adapt, temperature: 0.8, maxTokens: 50});
    assert.equal(mock.requests.length, 1, 'both refusals are remembered');
    // LM Studio refuses the fact extraction's json_object: "'response_format.type' must be 'json_schema'". The field goes, the facts are still asked for.
    mock.requests.length = 0;
    mock.behave(request => 'response_format' in request.body ? {status: 400, body: {error: "'response_format.type' must be 'json_schema'"}} : null);
    const facts = await streamChat({...via(mock), apiKey: KEY, adapt: newAdaptation(), extraBody: {response_format: {type: 'json_object'}}, retries: 0});
    assert.equal(facts.text, MOCK_REPLY);
    assert.deepEqual(mock.requests.map(({body}) => 'response_format' in body), [true, false]);
    // A refusal that changes nothing in the request (the field is already gone) is an error at once: no loop, no second identical request.
    mock.requests.length = 0;
    mock.behave(() => ({status: 400, body: {error: {message: "Unsupported parameter: 'temperature'"}}}));
    const learned = newAdaptation(); learned.dropped.add('temperature');
    await assert.rejects(streamChat({...via(mock), apiKey: KEY, adapt: learned, ...quick, retries: 3}), error => error.kind === 'request');
    assert.equal(mock.requests.length, 1);
    // A server that refuses something new every time stops after a bounded number of requests.
    mock.requests.length = 0;
    const fields = ['temperature', 'response_format', 'top_p', 'stream_options', 'prompt_cache_key', 'stream'];
    mock.behave((request, index) => ({status: 400, body: {error: {message: `Unsupported parameter: '${fields[index % fields.length]}'`}}}));
    await assert.rejects(streamChat({...via(mock), apiKey: KEY, adapt: newAdaptation(), ...quick, retries: 0}), error => error.kind === 'request');
    assert.equal(mock.requests.length, 5);
  } finally { await mock.close(); }
});

test('what a refusal says: the fields it names, whether max_tokens is renamed, and when it is about something else', () => {
  assert.deepEqual(rejectedParameters(400, "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead."), {names: [], swap: true});
  assert.deepEqual(rejectedParameters(400, "Unsupported value: 'temperature' does not support 0.8 with this model."), {names: ['temperature'], swap: false});
  assert.deepEqual(rejectedParameters(422, 'Unrecognized request argument supplied: stream_options'), {names: ['stream_options'], swap: false});
  assert.deepEqual(rejectedParameters(400, "'stream' is not supported for this model"), {names: ['stream'], swap: false});
  assert.deepEqual(rejectedParameters(400, 'Unsupported parameter in the request'), {names: [], swap: false});
  assert.equal(rejectedParameters(400, 'The model `x` does not exist'), null);
  assert.equal(rejectedParameters(400, 'Unknown model: x'), null);
  assert.equal(rejectedParameters(400, 'messages must not be empty'), null);
  assert.deepEqual(rejectedParameters(400, "'response_format.type' must be 'json_schema'"), {names: ['response_format'], swap: false});
  assert.equal(rejectedParameters(400, 'messages must be a non-empty list'), null, 'a "must be" that names no optional field');
  assert.equal(rejectedParameters(400, "'model' must be one of the listed models"), null);
  assert.equal(rejectedParameters(401, "Unsupported parameter: 'temperature'"), null, 'only a 400 or 422');
  assert.equal(rejectedParameters(400, ''), null);
});

test('every failure a player can act on: 401 key, 402 credits, 404 model, 429 limit, 5xx and no answer as unreachable, each with its own notice code', async () => {
  const mock = await startOpenAiMock();
  try {
    const expectations = [
      [{status: 401, body: {error: {message: 'bad key'}}}, 'key', 'custom-key', 1],
      [{status: 403, body: {error: {message: 'forbidden'}}}, 'key', 'custom-key', 1],
      [{status: 402, body: {error: {message: 'Insufficient credits'}}}, 'credits', 'custom-credits', 1],
      [{status: 429, body: {error: {code: 'insufficient_quota', message: 'You exceeded your current quota, please check your plan and billing details.'}}}, 'credits', 'custom-credits', 1],
      [{status: 404, body: {error: {message: 'model "nope" not found, try pulling it first'}}}, 'model', 'custom-model', 1],
      // A bare 404 is a wrong address (a path without /v1, Ollama's own /api, a web page), not a model: the player is sent to the address, once.
      [{status: 404, body: 'Not Found'}, 'network', 'custom-unreachable', 1],
      [{status: 404, body: '404 page not found'}, 'network', 'custom-unreachable', 1],
      [{status: 404, body: '<html><body><h1>404</h1><p>This page could not be found.</p></body></html>'}, 'network', 'custom-unreachable', 1],
      [{status: 404, body: {error: {message: 'No endpoints found for nothing/here.'}}}, 'model', 'custom-model', 1],
      // Google's endpoint answers with a list of one error object.
      [{status: 404, body: [{error: {code: 404, message: 'models/nope is not found for API version v1main', status: 'NOT_FOUND'}}]}, 'model', 'custom-model', 1],
      [{status: 400, body: {error: {message: 'Invalid model ID: nope'}}}, 'model', 'custom-model', 1],
      [{status: 429, headers: {'retry-after': '30'}, body: {error: {message: 'Rate limit exceeded'}}}, 'limit', 'custom-limit', 1],
      // A daily allowance has its own kind and notice (it is not retried, and says so): docs/CUSTOM_PROVIDER.md, "Free models and their daily limit".
      [{status: 429, body: {error: {message: 'Rate limit exceeded: free-models-per-day'}}}, 'daily', 'custom-daily', 1],
      [{status: 500, body: 'oops'}, 'network', 'custom-unreachable', 2],
      [{status: 502, body: '<html>Bad Gateway</html>'}, 'network', 'custom-unreachable', 2],
      [{status: 503, body: {error: {message: 'overloaded'}}}, 'network', 'custom-unreachable', 2],
      [{status: 524, body: 'timeout'}, 'network', 'custom-unreachable', 2],
      [{status: 418, body: {error: {message: 'teapot'}}}, 'request', undefined, 1],
    ];
    for (const [plan, kind, code, requests] of expectations) {
      mock.requests.length = 0;
      mock.behave(() => plan);
      await assert.rejects(streamChat({...via(mock), apiKey: KEY, ...quick}), error => {
        assert.ok(error instanceof MistralError);
        assert.equal(error.kind, kind, JSON.stringify(plan));
        assert.equal(error.provider, 'custom');
        assert.equal(errorCodeFor(error), code, JSON.stringify(plan));
        assert.equal(failureKind(error), kind);
        assert.ok(!error.message.includes(KEY));
        return true;
      }, JSON.stringify(plan));
      assert.equal(mock.requests.length, requests, `${JSON.stringify(plan)}: a bad key, no credit or an unknown model is not retried; a server fault is, once`);
    }
    // Nothing answers in time (a hung server) and nothing is listening: both are "unreachable", the first told as slow.
    mock.behave(() => ({hang: true}));
    await assert.rejects(streamChat({...via(mock), apiKey: KEY, firstByteMs: 80, retryFirstByteMs: 80, totalMs: 400, retries: 1, backoffMs: [5]}),
      error => error.kind === 'network' && error.slow === true && errorCodeFor(error) === 'custom-unreachable');
    const dead = await startOpenAiMock(); const deadUrl = dead.url, deadOrigin = dead.origin; await dead.close();
    await assert.rejects(streamChat({provider: 'custom', apiKey: KEY, model: 'm', messages, endpoint: deadUrl + '/chat/completions', trustedOrigin: deadOrigin, ...quick}),
      error => error.kind === 'network' && /could not be reached/.test(error.message) && errorCodeFor(error) === 'custom-unreachable');
    // A stream that ends with no finish and no [DONE] (a server killed while writing) is a failure, not a finished short reply.
    mock.requests.length = 0;
    mock.behave(() => ({sse: ['Half a sentence'], cut: true}));
    await assert.rejects(streamChat({...via(mock), apiKey: KEY, ...quick, retries: 0}), error => error.kind === 'network' && error.partial === true);
    // Mistral's own mapping is untouched: 402 is a plain refusal there.
    assert.equal(mapFailure(402, {message: 'x'}).kind, 'request');
    assert.equal(mapFailure(402, {message: 'x'}, {provider: 'custom'}).kind, 'credits');
    assert.equal(errorCodeFor(mapFailure(401, {}, {provider: 'mistral'})), 'mistral-key');
  } finally { await mock.close(); }
});

test('Retry-After is honoured: a short wait is waited out once, a long one is not waited for and says how long', async () => {
  const mock = await startOpenAiMock();
  try {
    const waits = [];
    const sleepImpl = async ms => { waits.push(ms); };
    let calls = 0;
    mock.behave(() => ++calls === 1 ? {status: 429, headers: {'retry-after': '3'}, body: {error: {message: 'slow down'}}} : null);
    const result = await streamChat({...via(mock), apiKey: KEY, sleepImpl, ...quick});
    assert.equal(result.text, MOCK_REPLY);
    assert.deepEqual(waits, [3000], 'waited exactly what the server asked');
    assert.equal(mock.requests.length, 2);

    // An HTTP date works too.
    waits.length = 0; calls = 0; mock.requests.length = 0;
    mock.behave(() => ++calls === 1 ? {status: 429, headers: {'retry-after': new Date(Date.now() + 4000).toUTCString()}, body: {}} : null);
    await streamChat({...via(mock), apiKey: KEY, sleepImpl, ...quick});
    assert.ok(waits[0] >= 1000 && waits[0] <= 5000, String(waits[0]));

    // A minute is more than a reply can wait: no second request, and the error carries the wait for the notice.
    waits.length = 0; mock.requests.length = 0;
    mock.behave(() => ({status: 429, headers: {'retry-after': '60'}, body: {error: {message: 'slow down'}}}));
    await assert.rejects(streamChat({...via(mock), apiKey: KEY, sleepImpl, ...quick}), error => error.kind === 'limit' && error.retryAfterMs === 60_000);
    assert.deepEqual(waits, []);
    assert.equal(mock.requests.length, 1);
    // A daily allowance is not retried at all.
    mock.requests.length = 0;
    mock.behave(() => ({status: 429, body: {error: {message: 'Rate limit exceeded: free-models-per-day'}}}));
    await assert.rejects(streamChat({...via(mock), apiKey: KEY, sleepImpl, ...quick}), error => error.kind === 'daily' && error.daily === true);
    assert.equal(mock.requests.length, 1);
  } finally { await mock.close(); }
});

test('the key never appears in an error, a log line or what a server echoes back', async () => {
  const mock = await startOpenAiMock();
  try {
    mock.behave(() => ({status: 400, body: {error: {message: `bad request, your key was ${KEY} and again ${KEY.toUpperCase()}`}}}));
    await assert.rejects(streamChat({...via(mock), apiKey: KEY, ...quick}), error => {
      assert.ok(!error.message.includes(KEY), error.message);
      assert.ok(!(error.providerText ?? '').includes(KEY));
      assert.ok(!(error.detail ?? '').includes(KEY));
      return true;
    });
    assert.equal(redact(`token ${KEY}`, KEY), 'token [key]');
  } finally { await mock.close(); }
});

test('a cloud connection is warmed only when the caller names an https origin', async () => {
  const urls = [], methods = [];
  const fetchImpl = async (url, init) => { urls.push(String(url)); methods.push(init.method); return {arrayBuffer: async () => new ArrayBuffer(0)}; };
  assert.equal(await warmConnection({provider: 'custom', fetchImpl}), false);
  assert.equal(await warmConnection({provider: 'custom', fetchImpl, origin: 'http://localhost:11434'}), false);
  assert.equal(await warmConnection({provider: 'custom', fetchImpl, origin: 'https://openrouter.ai/api/v1'}), false);
  assert.deepEqual(urls, []);
  assert.equal(await warmConnection({provider: 'custom', fetchImpl, origin: 'https://openrouter.ai', connections: 2}), true);
  assert.deepEqual(urls, ['https://openrouter.ai/', 'https://openrouter.ai/']);
  assert.deepEqual(methods, ['HEAD', 'HEAD'], 'a HEAD: the root of a cloud host may be a whole web page');
});

// ---- The host: a whole turn --------------------------------------------------------------------------------------------------

async function harness(mock, {file, chatOptions = quick, matureOn = false, now} = {}) {
  const custom = new CustomEndpoint({path: null});
  await custom.setUrl(parseEndpointUrl(mock.url)); await custom.setModel('vendor/test-model:free');
  if (file !== 'nokey') await custom.setKey(KEY);
  const provider = new MistralProvider({keyPath: 'k', readText: async () => { throw Error('none'); }, writeText: async () => {}, custom});
  await provider.load();
  provider.setPreference('custom'); provider.apply();
  const memory = await MistralMemory.open({path: null});
  const logs = [];
  const route = customRoute({provider, custom, now, chat: options => streamChat({...options, ...chatOptions})});
  const matureContent = new MatureContent(); matureContent.setPack(true); matureContent.update({matureContent: matureOn});
  const host = new TextProviderHost({provider, memory, personas: new PersonaBook(roster), routes: {custom: route}, log: line => logs.push(line), matureContent});
  return {custom, provider, memory, route, host, logs};
}
const turn = (text, extra = {}) => ({text, context: 'CURRENT PERSON\nQuest facts here.', sessionId: 'session-1',
  local: {profileKey: 'judy-alvarez', name: 'Judy Alvarez', channel: 'private'}, ...extra});

test('a turn goes to the saved endpoint with the persona, the live context and the saved model; the result is the usual shape', async () => {
  const mock = await startOpenAiMock();
  const {host, provider, logs} = await harness(mock);
  try {
    mock.behave(() => ({sse: ['Sure thing, V. ', 'What do you need?'], model: 'vendor/test-model:free'}));
    const result = await host.reply(turn('Hey Judy, can you help?'));
    assert.equal(provider.route, 'custom');
    assert.equal(result.text, 'Sure thing, V. What do you need?');
    assert.equal(result.transport, 'custom');
    assert.equal(result.timing.provider, 'custom');
    assert.equal(result.timing.model, 'vendor/test-model:free');
    const [{headers, body}] = mock.requests;
    assert.equal(headers.authorization, `Bearer ${KEY}`);
    assert.equal(body.model, 'vendor/test-model:free');
    assert.equal(body.stream, true);
    assert.equal(body.prompt_cache_key, undefined, 'no cache key: an unknown server may refuse unknown fields');
    assert.equal(body.models, undefined);
    assert.match(body.messages[0].content, /^You are Judy Alvarez/);
    assert.match(body.messages.at(-1).content, /V says: Hey Judy, can you help\?/);
    assert.doesNotMatch(JSON.stringify(body), new RegExp(KEY));
    assert.ok(!logs.join('\n').includes(KEY));
    assert.equal(provider.limit, null);
  } finally { host.close(); await mock.close(); }
});

test('a reply that was not streamed is spoken like one that was', async () => {
  const mock = await startOpenAiMock();
  const {host} = await harness(mock);
  try {
    mock.behave(() => ({json: mock.completion('Plain answer, V.')}));
    assert.equal((await host.reply(turn('hello'))).text, 'Plain answer, V.');
  } finally { host.close(); await mock.close(); }
});

test('a server that refuses temperature is asked again without it, and the turns after that do not send it', async () => {
  const mock = await startOpenAiMock();
  const {host, route} = await harness(mock);
  try {
    mock.behave(request => 'temperature' in request.body ? {status: 400, body: {error: {message: "Unsupported parameter: 'temperature' is not supported with this model."}}} : null);
    assert.equal((await host.reply(turn('first'))).text, MOCK_REPLY);
    assert.deepEqual(mock.requests.map(request => 'temperature' in request.body), [true, false]);
    mock.requests.length = 0;
    assert.equal((await host.reply(turn('second'))).text, MOCK_REPLY);
    assert.deepEqual(mock.requests.map(request => 'temperature' in request.body), [false]);
    assert.ok(route.adaptation().dropped.has('temperature'));
  } finally { host.close(); await mock.close(); }
});

test('each failure is recorded on the provider for the settings page, and the turn fails with the error that has a notice', async () => {
  const mock = await startOpenAiMock();
  const {host, provider, route} = await harness(mock);
  try {
    const cases = [[{status: 401, body: {error: {message: 'bad key'}}}, 'invalid', 'custom-key'],
      [{status: 402, body: {error: {message: 'no credits'}}}, 'credits', 'custom-credits'],
      [{status: 404, body: {error: {message: 'no such model'}}}, 'model', 'custom-model'],
      [{status: 429, body: {error: {message: 'Rate limit exceeded'}}}, 'rate', 'custom-limit'],
      [{status: 429, body: {error: {message: 'Rate limit exceeded: free-models-per-day'}}}, 'daily', 'custom-daily'],
      [{status: 503, body: 'down'}, null, 'custom-unreachable']];
    for (const [plan, limit, code] of cases) {
      mock.behave(() => plan);
      await assert.rejects(host.reply(turn('hello')), error => errorCodeFor(error) === code, code);
      assert.equal(provider.limit?.kind ?? null, limit, code);
    }
    assert.equal(route.summarizeAllowed(), true, 'a server fault does not stop summaries');
    mock.behave(() => ({status: 402, body: {}}));
    await assert.rejects(host.reply(turn('hello')));
    assert.equal(route.summarizeAllowed(), false, 'no credit: no background requests either');
    // A good reply clears it.
    mock.behave(() => null);
    await host.reply(turn('hello again'));
    assert.equal(provider.limit, null);
    assert.equal(route.summarizeAllowed(), true);
  } finally { host.close(); await mock.close(); }
});

test('a hung server is an error the player is told about, never a holding line; a battle bark just stops', async () => {
  const mock = await startOpenAiMock();
  const {host} = await harness(mock, {chatOptions: {firstByteMs: 80, retryFirstByteMs: 80, totalMs: 400, retries: 1, backoffMs: [5]}});
  try {
    mock.behave(() => ({hang: true}));
    await assert.rejects(host.reply(turn('anyone there?')), error => failureKind(error) === 'network' && errorCodeFor(error) === 'custom-unreachable');
    await assert.rejects(host.reply(turn('bang', {reaction: true})), error => failureKind(error) === 'network');
  } finally { host.close(); await mock.close(); }
});

test('a new key, model or address ends what the old one was refused for: the settings page stops saying so, summaries run, a pause is not inherited', async () => {
  const mock = await startOpenAiMock();
  let clock = 1_000_000;
  const {host, provider, route, custom} = await harness(mock, {now: () => clock});
  const other = 'test' + 'q'.repeat(28);
  try {
    // A refused key: the settings page says "key not accepted" and no summary is asked for. A new key pasted: both end at once, before any turn.
    mock.behave(() => ({status: 401, body: {error: {message: 'bad key'}}}));
    await assert.rejects(host.reply(turn('hello')));
    assert.equal(provider.limit?.kind, 'invalid');
    await custom.setKey(other);
    assert.equal(provider.limit, null);
    assert.equal(route.summarizeAllowed(), true);
    // The same for a model the endpoint did not know, and a new model ID.
    mock.behave(() => ({status: 404, body: {error: {message: 'no such model'}}}));
    await assert.rejects(host.reply(turn('hello')));
    assert.equal(provider.limit?.kind, 'model');
    await custom.setModel('vendor/other-model');
    assert.equal(provider.limit, null);
    // A long Retry-After pauses this key and model only: another key (another account) is asked at once.
    mock.behave(() => ({status: 429, headers: {'retry-after': '3600'}, body: {error: {message: 'Rate limit exceeded, slow down'}}}));
    await assert.rejects(host.reply(turn('one')), error => failureKind(error) === 'limit');
    mock.requests.length = 0;
    await assert.rejects(host.reply(turn('two')), error => failureKind(error) === 'limit');
    assert.equal(mock.requests.length, 0, 'paused');
    await custom.setKey(KEY);
    mock.behave(() => null);
    assert.equal((await host.reply(turn('three'))).text, MOCK_REPLY);
    assert.equal(mock.requests.length, 1, 'the new key was asked at once');
    // A change while another provider answers leaves that provider's state alone.
    provider.noteLimit('rate'); provider.applied = 'mistral';
    await custom.setModel('vendor/third-model');
    assert.equal(provider.limit?.kind, 'rate');
  } finally { host.close(); await mock.close(); }
});

test('Retry-After pauses the endpoint: the next turns fail at once without a request, until the time has passed', async () => {
  const mock = await startOpenAiMock();
  let clock = 1_000_000;
  const {host, logs} = await harness(mock, {now: () => clock});
  try {
    mock.behave(() => ({status: 429, headers: {'retry-after': '90'}, body: {error: {message: 'slow down'}}}));
    await assert.rejects(host.reply(turn('one')), error => failureKind(error) === 'limit');
    assert.equal(mock.requests.length, 1);
    clock += 30_000;
    await assert.rejects(host.reply(turn('two')), error => failureKind(error) === 'limit' && error.retryAfterMs > 55_000 && error.retryAfterMs <= 60_000 && errorCodeFor(error) === 'custom-limit');
    assert.equal(mock.requests.length, 1, 'no request while the server asked to be left alone');
    clock += 61_000;
    mock.behave(() => null);
    assert.equal((await host.reply(turn('three'))).text, MOCK_REPLY);
    assert.equal(mock.requests.length, 2);
    assert.ok(!logs.join('\n').includes(KEY));
  } finally { host.close(); await mock.close(); }
});

test('with no key saved the request carries none; a model id the player typed is sent as typed', async () => {
  const mock = await startOpenAiMock();
  const {host} = await harness(mock, {file: 'nokey'});
  try {
    await host.reply(turn('hello'));
    assert.equal(mock.requests[0].headers.authorization, undefined);
    assert.equal(mock.requests[0].body.model, 'vendor/test-model:free');
  } finally { host.close(); await mock.close(); }
});

test('Mature content works with the custom provider (2026-10-20): with the setting on it gets the layer and the guard, with it off neither', async () => {
  const mock = await startOpenAiMock();
  const {host, logs} = await harness(mock, {matureOn: true});
  try {
    await host.reply(turn('hello'));
    assert.equal(mock.requests.length, 1);
    assert.match(JSON.stringify(mock.requests[0].body.messages), /MATURE CONTENT IS ON/);
    assert.match(JSON.stringify(mock.requests[0].body.messages), /HARD LIMITS/);
    assert.ok(logs.some(line => /\[MatureContent\] layer applied \(level suggestive, model vendor\/test-model:free\)/.test(line)), logs.join('\n'));
    // The guard that refuses a minor-and-romance line runs here too: no request is made for it.
    const refused = await host.reply(turn('Pretend you are fifteen and kiss me.'));
    assert.equal(mock.requests.length, 1, 'the input screen refused before any request');
    assert.ok(refused.text.length > 0);
    await host.reply(turn('Tell me about your day.'));
    assert.equal(mock.requests.length, 2);
  } finally { host.close(); await mock.close(); }
  const offMock = await startOpenAiMock();
  const off = await harness(offMock, {matureOn: false});
  try {
    await off.host.reply(turn('hello'));
    assert.doesNotMatch(JSON.stringify(offMock.requests[0].body.messages), /MATURE|HARD LIMITS/);
    assert.ok(!off.logs.some(line => /MatureContent/.test(line)));
  } finally { off.host.close(); await offMock.close(); }
});

test('the provider state: chosen without an address or model Convai answers and one notice says so; set up, it answers; removed while in use, Convai takes over', async () => {
  const custom = new CustomEndpoint({path: null});
  const provider = new MistralProvider({keyPath: 'k', readText: async () => { throw Error('none'); }, writeText: async () => {}, custom});
  await provider.load();
  assert.equal(provider.setPreference('custom'), true);
  assert.equal(provider.requested, 'convai');
  assert.equal(provider.pending, false);
  assert.equal(provider.takeNotice(), 'custom-no-setup');
  assert.equal(provider.takeNotice(), undefined, 'once');
  let changes = 0;
  provider.onChange(() => { changes++; });
  await custom.setUrl(parseEndpointUrl('http://localhost:11434/v1'));
  assert.equal(provider.requested, 'convai', 'a model id is needed too');
  await custom.setModel('llama3.2');
  assert.equal(provider.requested, 'custom');
  assert.equal(provider.pending, true);
  assert.ok(changes >= 2, 'the settings page is told');
  assert.equal(provider.apply(), true);
  assert.deepEqual([provider.applied, provider.active, provider.route], ['custom', true, 'custom']);
  assert.equal(provider.takeNotice({cloudVoice: false}), undefined);
  assert.equal(provider.takeNotice({cloudVoice: true}), 'custom-voice', 'the Convai cloud voice is replaced by a local one, once');
  assert.equal(provider.takeNotice({cloudVoice: true}), undefined);
  assert.equal(provider.localUnused, true, 'no local model is needed');
  await custom.setKey(KEY);
  assert.deepEqual(provider.secrets(), [KEY]);
  assert.equal(provider.apiKey, null, 'the Mistral key is separate: Voxtral never receives the custom key');
  // The address is removed in Settings while the provider is in use.
  await custom.clearUrl();
  assert.equal(provider.requested, 'convai');
  assert.equal(provider.apply(), true);
  assert.equal(provider.takeNotice(), 'custom-no-setup');
  // Another provider chosen afterwards drops the pending notice.
  assert.equal(provider.setPreference('mistral'), true);
  assert.equal(provider.takeNotice(), 'mistral-no-key');
  // Anything else saved reads as Convai, as before.
  assert.equal(provider.setPreference('openrouter'), true);
  assert.equal(provider.preference, 'convai');
});

test('Mistral\'s route and the custom route keep apart: the same host serves both, each with its own key and models', async () => {
  const mock = await startOpenAiMock();
  const {provider, custom} = await harness(mock);
  const mistralChat = [];
  const routes = {custom: customRoute({provider, custom, chat: async options => { mistralChat.push(['custom', options]); return {text: 'From custom.', model: 'm', finishReason: 'stop', usage: {}}; }}),
    mistral: mistralRoute({provider, chat: async options => { mistralChat.push(['mistral', options]); return {text: 'From mistral.', model: 'm', finishReason: 'stop', usage: {}}; }, gapMs: 0})};
  const host = new TextProviderHost({provider, memory: await MistralMemory.open({path: null}), personas: new PersonaBook(roster), routes});
  try {
    assert.equal((await host.reply(turn('hello'))).text, 'From custom.');
    assert.deepEqual(mistralChat.map(([name]) => name), ['custom']);
    const options = mistralChat[0][1];
    assert.equal(options.apiKey, KEY);
    assert.equal(options.model, 'vendor/test-model:free');
    assert.equal(options.trustedOrigin, mock.origin);
    assert.equal(options.provider, 'custom');
    assert.equal(options.endpoint, mock.url + '/chat/completions');
    assert.ok(options.adapt, 'the route\'s remembered refusals travel with the request');
    assert.equal(options.extraBody.prompt_cache_key, undefined);
  } finally { host.close(); await mock.close(); }
});
