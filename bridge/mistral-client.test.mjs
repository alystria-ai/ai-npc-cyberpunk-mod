import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {streamChat, sseData, mapFailure, MistralError, failureKind, errorCodeFor, redact, validateKey, MISTRAL_ENDPOINT, MISTRAL_MODELS_ENDPOINT,
  DEFAULT_MODEL} from './mistral-client.mjs';

const KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
const encoder = new TextEncoder();
const body = chunks => new ReadableStream({start(controller) { for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk); controller.close(); }});
const collect = async stream => { const out = []; for await (const data of sseData(stream)) out.push(data); return out; };
const delta = (content, extra = {}) => `data: ${JSON.stringify({id: 'x', object: 'chat.completion.chunk', model: 'mistral-small-latest', choices: [{index: 0, delta: {content}, finish_reason: null}], ...extra})}\n\n`;
const sse = (...events) => ({ok: true, status: 200, headers: new Headers(), body: body(events)});
const fail = (status, error, headers = {}) => ({ok: false, status, headers: new Headers(headers), json: async () => ({object: 'error', code: status, ...error})});

test('the SSE parser handles CRLF, comments, split chunks, multi-line data and UTF-8 cut between chunks', async () => {
  const text = ': keep-alive\r\n\r\ndata: {"a":1}\r\n\r\ndata: line1\r\ndata: line2\r\n\r\n: keep-alive\n\ndata: [DONE]\n\n';
  assert.deepEqual(await collect(body([text])), ['{"a":1}', 'line1\nline2', '[DONE]']);
  // Every possible split point gives the same events, including a CR/LF pair and multi-byte characters.
  const wire = encoder.encode('data: {"t":"Café チ"}\r\n\r\ndata: x\r\n\r\n');
  for (let cut = 1; cut < wire.length; cut++) {
    assert.deepEqual(await collect(body([wire.slice(0, cut), wire.slice(cut)])), ['{"t":"Café チ"}', 'x'], `cut at ${cut}`);
  }
  assert.deepEqual(await collect(body(['data: tail without blank line'])), ['tail without blank line']);
  assert.deepEqual(await collect(body(['data:no-space\n\nevent: ping\ndata: with-event\n\n'])), ['no-space', 'with-event']);
});

test('streamChat joins deltas, accepts structured content, and reports the model that answered', async () => {
  const seen = [];
  let request;
  const result = await streamChat({apiKey: KEY, messages: [{role: 'user', content: 'hi'}], onDelta: piece => seen.push(piece),
    fetchImpl: async (url, init) => {
      request = {url, init, body: JSON.parse(init.body)};
      return sse(`data: ${JSON.stringify({model: 'mistral-small-2506', choices: [{index: 0, delta: {role: 'assistant', content: ''}, finish_reason: null}]})}\n\n`,
        delta('Hello'), delta(', V.'), delta([{type: 'text', text: ' Ready.'}]),
        `data: ${JSON.stringify({model: 'mistral-small-2506', choices: [{index: 0, delta: {content: ''}, finish_reason: 'stop'}], usage: {total_tokens: 12}})}\n\n`, 'data: [DONE]\n\n');
    }});
  assert.equal(result.text, 'Hello, V. Ready.');
  assert.deepEqual(seen, ['Hello', ', V.', ' Ready.']);
  assert.equal(result.model, 'mistral-small-2506');
  assert.equal(result.finishReason, 'stop');
  assert.equal(result.usage.total_tokens, 12);
  assert.equal(request.url, MISTRAL_ENDPOINT);
  assert.equal(request.url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(request.body.model, DEFAULT_MODEL);
  assert.equal(DEFAULT_MODEL, 'mistral-small-latest');
  assert.equal(request.body.stream, true);
  assert.equal(request.init.headers.Authorization, `Bearer ${KEY}`);
  assert.doesNotMatch(JSON.stringify(request.body), new RegExp(KEY));
});

test('shouldStop ends the reply early and returns the text so far', async () => {
  let cancelled = false;
  const stream = new ReadableStream({start(controller) {
    controller.enqueue(encoder.encode(delta('One. ') + delta('Two. ') + delta('Three. ')));
  }, cancel() { cancelled = true; }});
  const result = await streamChat({apiKey: KEY, messages: [], shouldStop: soFar => soFar.includes('Two.'),
    fetchImpl: async () => ({ok: true, status: 200, headers: new Headers(), body: stream})});
  assert.equal(result.text, 'One. Two. ');
  assert.equal(cancelled, true);
});

test('errors map to what a player can act on', () => {
  assert.equal(mapFailure(401, {message: 'Unauthorized'}).kind, 'key');
  assert.equal(mapFailure(403, {}).kind, 'key');
  assert.equal(errorCodeFor(mapFailure(401, {})), 'mistral-key');
  const rate = mapFailure(429, {message: 'Rate limit exceeded'});
  assert.equal(rate.kind, 'limit');
  assert.equal(errorCodeFor(rate), 'mistral-limit');
  assert.equal(mapFailure(404, {message: 'Model not found'}).kind, 'model');
  assert.equal(errorCodeFor(mapFailure(404, {})), 'mistral-model');
  assert.equal(mapFailure(422, {message: 'Invalid model: foo'}).kind, 'model');
  for (const status of [500, 502, 503, 504]) assert.equal(mapFailure(status, {}).kind, 'network', String(status));
  assert.equal(mapFailure(408, {}).kind, 'network');
  assert.equal(errorCodeFor(mapFailure(500, {})), undefined);
  assert.equal(mapFailure(400, {message: 'bad json'}).kind, 'request');
  assert.equal(mapFailure(422, {detail: [{msg: 'field required'}]}).kind, 'request');
  assert.equal(mapFailure(429, {}, {headers: new Headers({'retry-after': '3'})}).retryAfterMs, 3000);
  assert.equal(failureKind(Error('x [mistral:limit]')), 'limit');
  assert.equal(failureKind(Error('Convai usage limit reached')), null);
});

test('a refused key is reported at once; the per-second limit and server faults are retried with backoff', async () => {
  const waits = [];
  const sleepImpl = async ms => { waits.push(ms); };
  let calls = 0;
  await assert.rejects(streamChat({apiKey: KEY, messages: [], sleepImpl, fetchImpl: async () => { calls++; return fail(401, {message: 'Unauthorized'}); }}),
    error => error.kind === 'key');
  assert.equal(calls, 1);

  calls = 0;
  const ok = await streamChat({apiKey: KEY, messages: [], sleepImpl, fetchImpl: async () => {
    calls++;
    return calls === 1 ? fail(429, {message: 'Rate limit exceeded'}, {'retry-after': '2'}) : calls === 2 ? fail(503, {message: 'busy'}) : sse(delta('Fine.'), 'data: [DONE]\n\n');
  }});
  assert.equal(ok.text, 'Fine.');
  assert.equal(ok.attempts, 3);
  assert.deepEqual(waits, [2000, 3500]);

  calls = 0;
  waits.length = 0;
  await assert.rejects(streamChat({apiKey: KEY, messages: [], sleepImpl, fetchImpl: async () => { calls++; return fail(429, {message: 'Rate limit exceeded'}); }}),
    error => error.kind === 'limit');
  assert.equal(calls, 3, 'a persistent limit is retried twice and then reported');
  assert.deepEqual(waits, [1200, 3500]);

  calls = 0;
  await assert.rejects(streamChat({apiKey: KEY, messages: [], sleepImpl, retries: 1, fetchImpl: async () => { calls++; return fail(502, {message: 'down'}); }}),
    error => error.kind === 'network');
  assert.equal(calls, 2);

  calls = 0;
  await assert.rejects(streamChat({apiKey: KEY, messages: [], sleepImpl, fetchImpl: async () => { calls++; return fail(404, {message: 'Model not found'}); }}),
    error => error.kind === 'model');
  assert.equal(calls, 1, 'an unavailable model is not retried');
});

test('an error inside the stream and an empty answer are errors; an empty answer is tried again', async () => {
  await assert.rejects(streamChat({apiKey: KEY, messages: [], retries: 0, fetchImpl: async () =>
    sse(delta('Half a'), `data: ${JSON.stringify({object: 'error', code: 429, message: 'Rate limit exceeded'})}\n\n`)}),
  error => error.kind === 'limit');
  let calls = 0;
  const result = await streamChat({apiKey: KEY, messages: [], sleepImpl: async () => {}, fetchImpl: async () => {
    calls++;
    return calls === 1 ? sse('data: [DONE]\n\n') : sse(delta('Now there is text.'));
  }});
  assert.equal(result.text, 'Now there is text.');
  assert.equal(calls, 2);
});

test('a timeout before the first byte is a network error, and the caller cancelling is an abort, not an error', async () => {
  const hang = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), {name: 'AbortError'}))));
  await assert.rejects(streamChat({apiKey: KEY, messages: [], retries: 0, firstByteMs: 20, fetchImpl: hang}), error => error.kind === 'network');
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(streamChat({apiKey: KEY, messages: [], signal: controller.signal, fetchImpl: hang}), error => error.name === 'AbortError' && !(error instanceof MistralError));
});

test('the key goes to api.mistral.ai or this computer only, and never appears in an error', async () => {
  for (const endpoint of ['https://example.com/v1/chat/completions', 'http://api.mistral.ai/v1/chat/completions', 'https://api.mistral.ai.evil.test/x', 'https://mistral.ai/v1/chat/completions'])
    await assert.rejects(streamChat({apiKey: KEY, messages: [], endpoint, fetchImpl: async () => { throw Error('must not be called'); }}),
      /only ever sent to api\.mistral\.ai/, endpoint);
  const echo = await streamChat({apiKey: KEY, messages: [], retries: 0, fetchImpl: async () => { throw Error(`connect ECONNREFUSED while sending Bearer ${KEY}`); }})
    .catch(error => error);
  assert.equal(echo.kind, 'network');
  assert.doesNotMatch(echo.message, new RegExp(KEY));
  const refused = await streamChat({apiKey: KEY, messages: [], retries: 0, fetchImpl: async () => fail(401, {message: `Invalid key ${KEY}`})}).catch(error => error);
  assert.doesNotMatch(refused.message, new RegExp(KEY));
  assert.equal(redact(`token ${KEY} and ${KEY}`, KEY), 'token [key] and [key]');
  assert.equal(redact(`some other long ${'x'.repeat(40)} value`), 'some other long [key] value');
  await assert.rejects(streamChat({apiKey: '', messages: []}), error => error.kind === 'key');
});

test('key validation lists the models only and distinguishes refused from unreachable', async () => {
  const calls = [];
  const fetchImpl = status => async (url, init) => { calls.push({url, auth: init.headers.Authorization, method: init.method ?? 'GET'}); return {ok: status === 200, status, body: null}; };
  assert.equal(await validateKey(KEY, {fetchImpl: fetchImpl(200)}), 'valid');
  assert.equal(await validateKey(KEY, {fetchImpl: fetchImpl(401)}), 'invalid');
  assert.equal(await validateKey(KEY, {fetchImpl: fetchImpl(429)}), 'unknown');
  assert.equal(await validateKey(KEY, {fetchImpl: fetchImpl(500)}), 'unknown');
  assert.equal(await validateKey(KEY, {fetchImpl: async () => { throw Error('offline'); }}), 'unknown');
  assert.equal(await validateKey(KEY, {endpoint: 'https://example.com/models', fetchImpl: fetchImpl(200)}), 'unknown');
  assert.deepEqual([...new Set(calls.map(call => call.url))], [MISTRAL_MODELS_ENDPOINT]);
  assert.equal(MISTRAL_MODELS_ENDPOINT, 'https://api.mistral.ai/v1/models');
  assert(calls.every(call => call.method === 'GET' && call.auth === `Bearer ${KEY}`));
});

test('against a real local HTTP server: streamed chunks arrive and a 429 body is mapped and retried', async () => {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      requests.push({headers: req.headers, body: JSON.parse(raw)});
      if (requests.length === 1) {
        res.writeHead(429, {'content-type': 'application/json', 'retry-after': '0'});
        res.end(JSON.stringify({object: 'error', message: 'Rate limit exceeded', type: 'rate_limited', code: 429}));
        return;
      }
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.write(delta('Over '));
      setTimeout(() => { res.write(delta('here.')); res.end('data: [DONE]\n\n'); }, 20);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
    const pieces = [];
    const result = await streamChat({apiKey: KEY, endpoint, messages: [{role: 'user', content: 'x'}], onDelta: piece => pieces.push(piece), sleepImpl: async () => {}});
    assert.equal(result.text, 'Over here.');
    assert.deepEqual(pieces, ['Over ', 'here.']);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].headers.authorization, `Bearer ${KEY}`);
    assert.equal(requests[1].body.model, 'mistral-small-latest');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('an allowance of 0 for a model is recognised from the rate-limit headers and is not retried', async () => {
  const zero = mapFailure(429, {message: 'Rate limit exceeded'}, {headers: new Headers({'x-ratelimit-limit-req-minute': '0'})});
  assert.deepEqual([zero.kind, zero.zeroQuota], ['limit', true]);
  assert.equal(mapFailure(429, {}, {headers: new Headers({'x-ratelimit-limit-req-minute': '30'})}).zeroQuota, false);
  assert.equal(mapFailure(401, {}, {headers: new Headers({'x-ratelimit-limit-req-minute': '0'})}).zeroQuota, false);
  let calls = 0;
  await assert.rejects(streamChat({apiKey: KEY, messages: [], sleepImpl: async () => {}, fetchImpl: async () => {
    calls++; return fail(429, {message: 'Rate limit exceeded'}, {'x-ratelimit-limit-req-minute': '0'});
  }}), error => error.kind === 'limit' && error.zeroQuota);
  assert.equal(calls, 1);
});
