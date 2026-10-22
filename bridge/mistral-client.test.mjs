import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {streamChat, sseData, mapFailure, MistralError, failureKind, errorCodeFor, redact, validateKey, MISTRAL_ENDPOINT, MISTRAL_MODELS_ENDPOINT,
  DEFAULT_MODEL, retryable, warmConnection, KEEP_ALIVE_MS} from './mistral-client.mjs';
import {fakeClock} from './fixtures/fake-clock.mjs';

const KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
const encoder = new TextEncoder();
const body = chunks => new ReadableStream({start(controller) { for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk); controller.close(); }});
const collect = async stream => { const out = []; for await (const data of sseData(stream)) out.push(data); return out; };
const delta = (content, extra = {}) => `data: ${JSON.stringify({id: 'x', object: 'chat.completion.chunk', model: 'mistral-small-latest', choices: [{index: 0, delta: {content}, finish_reason: null}], ...extra})}\n\n`;
const sse = (...events) => ({ok: true, status: 200, headers: new Headers(), body: body(events)});
const fail = (status, error, headers = {}) => ({ok: false, status, headers: new Headers(headers), json: async () => ({object: 'error', code: status, ...error})});

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
const onClock = clock => ({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer});

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
  assert.equal(DEFAULT_MODEL, 'ministral-8b-latest');
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

test('an empty answer of a custom server records how the server ended it (end reason, tokens counted), for the error report', async () => {
  const finish = JSON.stringify({id: 'x', object: 'chat.completion.chunk', model: 'm', choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 900, completion_tokens: 0}});
  await assert.rejects(streamChat({apiKey: KEY, messages: [], retries: 0, provider: 'custom', endpoint: 'http://127.0.0.1:1234/v1/chat/completions', trustedOrigin: 'http://127.0.0.1:1234',
    fetchImpl: async () => sse(`data: ${finish}\n\n`, 'data: [DONE]\n\n')}),
  error => error.kind === 'empty' && error.trace.finishReason === 'stop' && error.trace.completionTokens === 0 && error.trace.pieces === 0);
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
    assert.equal(requests[1].body.model, DEFAULT_MODEL);
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

// ---- The local server (same client, one more label and one more allowed host) -------------------------------------------------

test('a key goes only to its own provider host or to loopback; errors name the provider and never hold the key', async () => {
  const messages = [{role: 'user', content: 'hi'}];
  await assert.rejects(streamChat({apiKey: KEY, messages, endpoint: 'https://api.example.com/v1/chat/completions'}), /Mistral key is only ever sent to api\.mistral\.ai/);
  await assert.rejects(streamChat({apiKey: KEY, messages, provider: 'local', endpoint: 'https://example.com/v1/chat/completions'}), /only ever sent/);
  // Groq was removed on 2026-10-14: it is no provider, so its host is refused like any other.
  await assert.rejects(streamChat({apiKey: KEY, messages, endpoint: 'https://api.groq.com/openai/v1/chat/completions'}), /Mistral key is only ever sent to api\.mistral\.ai/);
  const requests = [];
  const fetchImpl = async (url, init) => { requests.push({url, headers: init.headers, body: JSON.parse(init.body)}); return fail(401, {message: `Invalid API Key ${KEY}`}); };
  const error = await streamChat({apiKey: KEY, messages, fetchImpl, retries: 0, extraBody: {reasoning_effort: 'none'}}).catch(caught => caught);
  assert.equal(requests[0].url, 'https://api.mistral.ai/v1/chat/completions');
  assert.equal(requests[0].body.reasoning_effort, 'none');
  assert.match(error.message, /^Mistral .*\[mistral:key\]$/);
  assert.equal(errorCodeFor(error), 'mistral-key');
  assert.doesNotMatch(error.message, new RegExp(KEY));
  assert.equal(await validateKey(KEY, {fetchImpl: async url => { assert.match(url, /^https:\/\/api\.mistral\.ai\//); return {ok: false, status: 401}; }}), 'invalid');
});

test('a daily limit is not retried, and a short per-second one is', () => {
  const headers = value => new Headers(value === undefined ? {} : {'retry-after': String(value)});
  const daily = mapFailure(429, {error: {message: 'Rate limit reached for model on tokens per day (TPD): Limit 200000'}}, {headers: headers(), provider: 'mistral'});
  assert.equal(daily.daily, true); assert.equal(retryable(daily), false);
  const quick = mapFailure(429, {error: {message: 'Rate limit reached'}}, {headers: headers(1), provider: 'mistral'});
  assert.equal(retryable(quick), true);
  const mistral = mapFailure(429, {message: 'Requests rate limit exceeded'}, {headers: headers(), provider: 'mistral'});
  assert.equal(retryable(mistral), true);
});

// ---- hung requests: the first ask is cut early and asked again; a stream that goes quiet is cut ---------------------------------------

const hangs = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), {name: 'AbortError'}))));

test('a hung first ask is cut at firstByteMs and the retry has its own limit; the attempts that failed are listed and reported', async () => {
  // Every limit runs on a manual clock (bridge/fixtures/fake-clock.mjs): an ask is cut when the test moves the clock to its limit, never because the machine was slow.
  const clock = fakeClock();
  let calls = 0;
  const retries = [];
  const pending = streamChat({apiKey: KEY, messages: [], firstByteMs: 60, retryFirstByteMs: 500, retries: 1, backoffMs: [5], sleepImpl: async () => {}, ...onClock(clock),
    onRetry: info => retries.push(info), fetchImpl: async (url, init) => { calls++; return calls === 1 ? hangs(url, init) : sse(delta('Here.')); }});
  await eventually(() => calls === 1, 'the first ask to be sent');
  await clock.advance(59);
  assert.equal(calls, 1, 'the hung ask is still waited for inside its limit');
  await clock.advance(1);
  assert.equal(calls, 2, 'the hung ask was cut at its own short limit (60 ms) and asked again, not left to the default');
  const result = await within(pending, 'the retry to answer');
  assert.equal(result.text, 'Here.'); assert.equal(result.attempts, 2);
  assert.equal(result.failed.length, 1); assert.equal(result.failed[0].kind, 'network'); assert.equal(result.failed[0].ms, 60);
  assert.equal(retries.length, 1); assert.equal(retries[0].attempt, 1); assert.equal(retries[0].error.slow, true); assert.equal(retries[0].waitMs, 5);
  // The retry limit is its own: a retry slower than firstByteMs but inside retryFirstByteMs still answers.
  calls = 0;
  const slowRetry = streamChat({apiKey: KEY, messages: [], firstByteMs: 40, retryFirstByteMs: 400, retries: 1, backoffMs: [1], sleepImpl: async () => {}, ...onClock(clock),
    fetchImpl: (url, init) => {
      calls++;
      if (calls === 1) return hangs(url, init);
      // Like a real request, it fails when it is aborted; its answer comes 150 ms (clock time) after it was sent.
      return new Promise((resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), {name: 'AbortError'})));
        clock.sleep(150).then(() => resolve(sse(delta('Late but fine.'))));
      });
    }});
  await eventually(() => calls === 1, 'the first ask to be sent');
  await clock.advance(40);
  assert.equal(calls, 2);
  await clock.advance(150);
  assert.equal((await within(slowRetry, 'the slow retry to answer')).text, 'Late but fine.');
});

test('every ask hanging ends with a slow network error that lists each attempt', async () => {
  const error = await streamChat({apiKey: KEY, messages: [], firstByteMs: 30, retryFirstByteMs: 30, retries: 1, backoffMs: [1], sleepImpl: async () => {}, fetchImpl: hangs}).catch(e => e);
  assert.equal(error.kind, 'network'); assert.equal(error.slow, true); assert.equal(error.failed.length, 2);
  assert.equal(failureKind(error), 'network');
  const unreachable = await streamChat({apiKey: KEY, messages: [], retries: 0, fetchImpl: async () => { throw Error('connect ECONNREFUSED'); }}).catch(e => e);
  assert.equal(unreachable.slow, false, 'no network at all is not "the service was slow"');
  const fault = await streamChat({apiKey: KEY, messages: [], retries: 0, fetchImpl: async () => fail(503, {message: 'overloaded'})}).catch(e => e);
  assert.equal(fault.kind, 'network'); assert.equal(fault.slow, true);
  const refused = await streamChat({apiKey: KEY, messages: [], retries: 0, fetchImpl: async () => fail(401, {message: 'no'})}).catch(e => e);
  assert.equal(refused.slow, false);
});

test('a stream that starts and then goes quiet is cut after stallMs, not after the whole-request limit', async () => {
  // Like a real response body, it errors when the request is aborted.
  const quietAfterFirst = init => ({ok: true, status: 200, headers: new Headers(), body: new ReadableStream({start(controller) {
    controller.enqueue(encoder.encode(delta('Hey V, come in.')));
    init.signal.addEventListener('abort', () => controller.error(Object.assign(Error('aborted'), {name: 'AbortError'})));
  }})});
  // The limits run on a manual clock: the silence lasts exactly as long as the test lets the clock run.
  const clock = fakeClock();
  let gotFirst = false;
  const pending = streamChat({apiKey: KEY, messages: [], retries: 0, firstByteMs: 2000, stallMs: 60, totalMs: 5000, ...onClock(clock),
    onDelta: () => { gotFirst = true; }, fetchImpl: async (url, init) => quietAfterFirst(init)}).catch(e => e);
  const outcome = watch(pending);
  await eventually(() => gotFirst, 'the first piece of the reply');
  await clock.advance(59);
  assert.equal(outcome.done, false, 'the silence is waited for inside stallMs');
  await clock.advance(1);
  assert.equal(outcome.done, true, 'cut after stallMs (60 ms), long before the first-byte (2 s) or whole-request (5 s) limit');
  const error = await pending;
  assert.equal(error.kind, 'network'); assert.equal(error.slow, true); assert.match(error.message, /went quiet/);
  // With stallMs off the old behaviour stays: only the first-byte and total limits apply.
  const steady = await streamChat({apiKey: KEY, messages: [], retries: 0, fetchImpl: async () => sse(delta('A'), delta('B'), 'data: [DONE]\n\n')});
  assert.equal(steady.text, 'AB'); assert.deepEqual(steady.failed, []);
});

// ---- Connection reuse (docs/LATENCY_2026-10-13.md section 4.5) ----------------------------------------------------------------

/** A local server that counts the sockets it is given. `finish(res)` decides how the body ends after the last event. */
async function socketServer(finish) {
  const state = {sockets: 0, closed: 0, requests: 0};
  const server = createServer((req, res) => {
    state.requests++;
    req.resume();
    req.on('end', () => {
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.write(delta('Over '));
      setTimeout(() => { res.write(delta('here.') + 'data: [DONE]\n\n'); finish(res); }, 10);
    });
  });
  server.on('connection', socket => { state.sockets++; socket.on('close', () => { state.closed++; }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  state.endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  state.stop = async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); };
  return state;
}
const ask = (endpoint, extra = {}) => streamChat({apiKey: KEY, endpoint, messages: [{role: 'user', content: 'x'}], retries: 0, ...extra});

test('the body is read to its end after [DONE], so the next turn reuses the socket', async () => {
  // The end of the body arrives a little after [DONE], as a chunked response's last chunk does when it is a separate packet.
  const server = await socketServer(res => setTimeout(() => res.end(), 30));
  // The drain limit runs on a manual clock that never moves, so a stalled event loop cannot give up on the end of the body before it arrives.
  const clock = fakeClock();
  try {
    for (let turn = 1; turn <= 3; turn++) {
      // A pause like the one between two real turns: a request sent in the same tick as the previous one's end can be given a new connection.
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal((await ask(server.endpoint, onClock(clock))).text, 'Over here.', `turn ${turn}`);
    }
    assert.equal(server.requests, 3);
    assert.equal(server.sockets, 1, 'three turns, one connection');
    assert.equal(server.closed, 0);
  } finally { await server.stop(); }
});

test('a body that never ends after [DONE] does not hold the turn: it is cut after the drain limit and the connection is closed', async () => {
  const server = await socketServer(() => { /* the response is never ended */ });
  try {
    // The drain limit (250 ms) runs on a manual clock; the whole-request limit (70 s) is on it too and stays out of reach.
    const clock = fakeClock(), pieces = [];
    const pending = ask(server.endpoint, {...onClock(clock), onDelta: piece => pieces.push(piece)});
    await eventually(() => pieces.join('') === 'Over here.', 'the whole reply'); // [DONE] comes in the same write as the last piece
    await clock.settle();
    await clock.advance(5000);
    const result = await within(pending, 'the turn to be cut at the drain limit');
    assert.equal(result.text, 'Over here.');
    // The cut body closes its connection; the next turn opens a new one.
    await eventually(() => server.closed === 1, 'the connection of the cut body to close');
    assert.equal(server.closed, 1);
    assert.equal((await ask(server.endpoint)).text, 'Over here.');
    // A spare connection may be opened under load, so the count is not pinned: the first one is gone (closed above) and this turn was answered.
    assert.ok(server.sockets >= 2, `sockets: ${server.sockets}`);
  } finally { await server.stop(); }
});

test('the caller cancelling a turn that is still streaming aborts the request and closes its connection', async () => {
  const server = await socketServer(() => { /* never ended */ });
  try {
    const controller = new AbortController();
    const pending = ask(server.endpoint, {signal: controller.signal, onDelta: () => controller.abort()});
    await assert.rejects(pending, error => error.name === 'AbortError' && !(error instanceof MistralError));
    await eventually(() => server.closed >= 1, 'the cancelled request to close its connection');
    assert.equal(server.closed, 1);
  } finally { await server.stop(); }
});

test('sseData drains only after [DONE]: a body that ends is read to the end, one that does not is cancelled, an early stop cancels at once', async () => {
  const stream = (events, {end = true} = {}) => {
    const state = {cancelled: false};
    const readable = new ReadableStream({start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(event));
      if (end) controller.close();
    }, cancel() { state.cancelled = true; }});
    return {readable, state};
  };
  const consume = async (readable, options, stopAt) => { for await (const data of sseData(readable, options)) if (data === stopAt) break; };
  // [DONE], then a body that ends: read to its end, not cancelled.
  let s = stream(['data: a\n\n', 'data: [DONE]\n\n']);
  await consume(s.readable, {drainMs: 100}, '[DONE]');
  assert.equal(s.state.cancelled, false);
  // [DONE], then a body that never ends: cancelled after the limit (on a manual clock), and not before it.
  s = stream(['data: [DONE]\n\n'], {end: false});
  const clock = fakeClock();
  const draining = watch(consume(s.readable, {drainMs: 40, setTimer: clock.setTimer, clearTimer: clock.clearTimer}, '[DONE]'));
  await clock.advance(39);
  assert.equal(draining.done, false, 'the end of the body is still waited for inside the limit');
  assert.equal(s.state.cancelled, false);
  await clock.advance(1);
  assert.equal(draining.done, true, 'cut at the drain limit');
  assert.equal(s.state.cancelled, true);
  // drainMs 0 (the default): cancelled at once.
  s = stream(['data: [DONE]\n\n'], {end: false});
  await consume(s.readable, {}, '[DONE]');
  assert.equal(s.state.cancelled, true);
  // Stopped on an ordinary event (the reply cap): cancelled, never waited for.
  s = stream(['data: a\n\n', 'data: b\n\n', 'data: [DONE]\n\n'], {end: false});
  await consume(s.readable, {drainMs: 5000}, 'a');
  assert.equal(s.state.cancelled, true);
  // The turn itself: an error event in the stream does not drain.
  s = stream([`data: ${JSON.stringify({object: 'error', code: 500, message: 'boom'})}\n\n`], {end: false});
  await assert.rejects(streamChat({apiKey: KEY, messages: [], retries: 0, fetchImpl: async () => ({ok: true, status: 200, headers: new Headers(), body: s.readable})}), error => error.kind === 'network');
  assert.equal(s.state.cancelled, true);
});

test('the cloud routes get a keep-alive dispatcher, the local ones keep the default client', async () => {
  const seen = [];
  const fake = async (url, init) => { seen.push({url, dispatcher: init.dispatcher}); return sse(delta('Hi.'), 'data: [DONE]\n\n'); };
  await streamChat({apiKey: KEY, messages: [], fetchImpl: fake});
  await streamChat({apiKey: KEY, messages: [], endpoint: 'http://127.0.0.1:9/v1/chat/completions', fetchImpl: fake});
  const [mistral, local] = seen;
  assert.equal(typeof mistral.dispatcher?.dispatch, 'function');
  assert.equal(local.dispatcher, undefined);
  assert.equal(KEEP_ALIVE_MS, 60000);
});

test('warmConnection can open several connections side by side, and counts as warm if any answered', async () => {
  let live = 0, peak = 0;
  const fake = async () => { live++; peak = Math.max(peak, live); await new Promise(done => setTimeout(done, 20)); live--; return {status: 404, arrayBuffer: async () => new ArrayBuffer(100)}; };
  assert.equal(await warmConnection({provider: 'mistral', fetchImpl: fake, connections: 2}), true);
  assert.equal(peak, 2, 'the two requests are in flight together, so the pool keeps two connections');
  let calls = 0;
  const half = async () => { if (++calls === 1) throw Error('offline'); return {status: 404, arrayBuffer: async () => new ArrayBuffer(1)}; };
  assert.equal(await warmConnection({provider: 'mistral', fetchImpl: half, connections: 2}), true);
  assert.equal(await warmConnection({provider: 'mistral', fetchImpl: async () => { throw Error('offline'); }, connections: 2}), false);
});

test('warmConnection sends one unauthenticated GET to the provider host, and never throws', async () => {
  const calls = [];
  const fake = async (url, init) => { calls.push({url, init}); return {status: 404, arrayBuffer: async () => new ArrayBuffer(100)}; };
  assert.equal(await warmConnection({provider: 'mistral', fetchImpl: fake}), true);
  assert.equal(await warmConnection({provider: 'groq', fetchImpl: fake}), false, 'Groq is no provider any more');
  assert.deepEqual(calls.map(call => call.url), ['https://api.mistral.ai/']);
  for (const {init} of calls) {
    assert.equal(init.method, 'GET');
    assert.equal(JSON.stringify(init.headers ?? {}).toLowerCase().includes('authorization'), false);
    assert.equal(init.body, undefined);
  }
  assert.equal(await warmConnection({provider: 'local', fetchImpl: fake}), false);
  assert.equal(calls.length, 1);
  assert.equal(await warmConnection({provider: 'mistral', fetchImpl: async () => { throw Error('offline'); }}), false);
  assert.equal(await warmConnection({provider: 'mistral', fetchImpl: async () => ({arrayBuffer: async () => { throw Error('cut'); }})}), true);
  // A host that never answers is given up on at the limit.
  const hang = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Error('aborted'))));
  const began = performance.now();
  const keepAlive = setInterval(() => {}, 1000); // the timeout timer alone does not hold the event loop
  try { assert.equal(await warmConnection({provider: 'mistral', fetchImpl: hang, timeoutMs: 30}), false); } finally { clearInterval(keepAlive); }
  // 30 ms was asked for; the default it must not fall back to is 5 s, so a bound of half of that is far from both and a loaded machine cannot reach it.
  assert(performance.now() - began < 2500, `took ${Math.round(performance.now() - began)} ms`);
});
