// Failure paths of the chat client (bridge/mistral-client.mjs) that mistral-client.test.mjs does not pin: a stream that ends mid-reply, an
// error object or a finish reason of "error" inside the stream, a 200 that is not a stream, error bodies that are not JSON, retry-after
// values that are huge or nonsense, a cancel during the backoff, observers that throw, and the key never reaching an error text.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {streamChat, mapFailure, MistralError, failureKind, errorCodeFor, validateKey, retryable} from './mistral-client.mjs';

const KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
const encoder = new TextEncoder();
const body = chunks => new ReadableStream({start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); }});
const delta = (content, extra = {}) => `data: ${JSON.stringify({model: 'ministral-8b-latest', choices: [{index: 0, delta: {content}, finish_reason: null}], ...extra})}\n\n`;
const finish = reason => `data: ${JSON.stringify({choices: [{index: 0, delta: {}, finish_reason: reason}]})}\n\n`;
const sse = (...events) => ({ok: true, status: 200, headers: new Headers(), body: body(events)});
const fail = (status, error, headers = {}) => ({ok: false, status, headers: new Headers(headers), json: async () => ({object: 'error', code: status, ...error})});
const LOCAL = 'http://127.0.0.1:9/v1/chat/completions';
const instantly = async () => {};

// ---- a stream that ends before the reply is finished -----------------------------------------------------------------------------

test('a local stream that ends with neither [DONE] nor a finish reason is a cut reply: with text it is never asked again, without text it is', async () => {
  // A server the player runs can die while it writes; its closed stream looks like a finished one (bridge/mistral-client.mjs, once()).
  let calls = 0;
  const cutWithText = await streamChat({apiKey: KEY, provider: 'local', endpoint: LOCAL, messages: [], retries: 2, sleepImpl: instantly,
    fetchImpl: async () => { calls++; return sse(delta('Hey V, I was about to')); }}).catch(error => error);
  assert.equal(cutWithText.kind, 'network');
  assert.equal(cutWithText.partial, true, 'some of the reply was already handed on');
  assert.match(cutWithText.message, /went quiet before the reply was finished/);
  assert.equal(calls, 1, 'a retry would say the first words twice');
  assert.equal(retryable(cutWithText), false);

  calls = 0;
  const cutEmpty = await streamChat({apiKey: KEY, provider: 'local', endpoint: LOCAL, messages: [], retries: 1, sleepImpl: instantly,
    fetchImpl: async () => { calls++; return calls === 1 ? sse() : sse(delta('Here now.'), finish('stop')); }});
  assert.equal(cutEmpty.text, 'Here now.');
  assert.equal(calls, 2, 'nothing was said yet: a second ask is safe');
});

test('the cloud accepts a stream that simply closes after some text (it ends the reply there); a finish reason or [DONE] is not needed', async () => {
  const result = await streamChat({apiKey: KEY, messages: [], retries: 0, fetchImpl: async () => sse(delta('Hey V.'), delta(' Come in.'))});
  assert.equal(result.text, 'Hey V. Come in.');
  assert.equal(result.finishReason, undefined);
  assert.deepEqual(result.failed, []);
});

test('a finish reason of "error" after some text is a network error, and the words already shown are not asked for again when the retries are used up', async () => {
  const seen = [];
  const error = await streamChat({apiKey: KEY, messages: [], retries: 0, onDelta: piece => seen.push(piece),
    fetchImpl: async () => sse(delta('Hey V'), finish('error'))}).catch(caught => caught);
  assert.equal(error.kind, 'network');
  assert.match(error.message, /stopped the reply with an error/);
  assert.deepEqual(seen, ['Hey V']);
  assert.equal(error.failed.length, 1);
  assert.equal(errorCodeFor(error), undefined, 'a server fault has no game notice of its own');
});

test('a connection that resets in the middle of the stream is a retried network error, and the error text never holds the key', async () => {
  let calls = 0;
  const reset = () => ({ok: true, status: 200, headers: new Headers(), body: new ReadableStream({start(controller) {
    controller.enqueue(encoder.encode(': keep-alive\n\n'));
    controller.error(Object.assign(new TypeError('terminated'), {cause: Error(`read ECONNRESET with Bearer ${KEY}`)}));
  }})});
  const result = await streamChat({apiKey: KEY, messages: [], retries: 1, sleepImpl: instantly,
    fetchImpl: async () => { calls++; return calls === 1 ? reset() : sse(delta('Back again.'), finish('stop')); }});
  assert.equal(result.text, 'Back again.');
  assert.equal(result.attempts, 2);
  assert.equal(result.failed[0].kind, 'network');
  const dead = await streamChat({apiKey: KEY, messages: [], retries: 0, fetchImpl: async () => ({ok: true, status: 200, headers: new Headers(),
    body: new ReadableStream({start(controller) { controller.error(Error(`socket hang up (${KEY})`)); }})})}).catch(caught => caught);
  assert.equal(dead.kind, 'network');
  assert.doesNotMatch(dead.message, new RegExp(KEY));
  assert.match(dead.message, /\[key\]/, 'what the socket said is kept, with the key scrubbed');
});

// ---- an error inside the stream -----------------------------------------------------------------------------------------------------

test('an error object inside the stream is mapped by its code; a code that is not a number is a server fault; its text never holds the key', async () => {
  const inStream = payload => streamChat({apiKey: KEY, messages: [], retries: 0, fetchImpl: async () => sse(`data: ${JSON.stringify(payload)}\n\n`)}).catch(caught => caught);
  assert.equal((await inStream({error: {code: 401, message: 'Unauthorized'}})).kind, 'key');
  assert.equal((await inStream({object: 'error', code: 429, message: 'Rate limit exceeded'})).kind, 'limit');
  const odd = await inStream({error: {code: 'upstream_failure', message: 'the backend fell over'}});
  assert.equal(odd.kind, 'network', 'no usable status: treated as a server fault (502)');
  assert.equal(odd.slow, true);
  const echoing = await inStream({error: {code: 401, message: `Invalid key ${KEY}`}});
  assert.equal(echoing.kind, 'key');
  assert.doesNotMatch(echoing.message, new RegExp(KEY));
  assert.equal((await inStream({error: 'plain string error'})).kind, 'network');
});

test('malformed events are skipped, including a last event that was cut in the middle of its JSON', async () => {
  const result = await streamChat({apiKey: KEY, messages: [], retries: 0, fetchImpl: async () =>
    sse(delta('Fine'), 'data: {this is not json}\n\n', 'data: \n\n', delta(' now.'), finish('stop'), 'data: {"choices":[{"delta":{"content":"cut o')});
  assert.equal(result.text, 'Fine now.');
  assert.equal(result.finishReason, 'stop');
});

// ---- a 200 that is not a stream, and error bodies that are not JSON -------------------------------------------------------------------

test('a 200 with no body is a network error, and a 200 whose body is plain JSON is an empty answer that does not show the body', async () => {
  const noBody = await streamChat({apiKey: KEY, messages: [], retries: 0, fetchImpl: async () => ({ok: true, status: 200, headers: new Headers(), body: null})}).catch(error => error);
  assert.equal(noBody.kind, 'network');
  assert.match(noBody.message, /sent no reply stream/);
  const plain = await streamChat({apiKey: KEY, messages: [], retries: 0, fetchImpl: async () =>
    sse('{"error":"the upstream said something private about account 4411"}')}).catch(error => error);
  assert.equal(plain.kind, 'empty');
  assert.doesNotMatch(plain.message, /private|4411/, 'the raw provider body is never part of the error');
  assert.equal(failureKind(plain), 'empty');
  assert.equal(errorCodeFor(plain), undefined);
});

test('an error response that is not JSON (a gateway page, an empty body) is described by its status only', async () => {
  const page = status => ({ok: false, status, headers: new Headers({'content-type': 'text/html'}), json: async () => { throw new SyntaxError('Unexpected token <'); }});
  for (const [status, kind] of [[502, 'network'], [504, 'network'], [529, 'network'], [401, 'key'], [429, 'limit'], [418, 'request']]) {
    const error = await streamChat({apiKey: KEY, messages: [], retries: 0, fetchImpl: async () => page(status)}).catch(caught => caught);
    assert.equal(error.kind, kind, String(status));
    assert.equal(error.status, status);
    assert.doesNotMatch(error.message, /<html|Unexpected token/i);
  }
  const bad = await streamChat({apiKey: KEY, messages: [], retries: 0, fetchImpl: async () => page(502)}).catch(caught => caught);
  assert.match(bad.message, /HTTP 502/);
  assert.equal(bad.slow, true, 'a gateway fault is a slow network error: the character may say a holding line');
});

test('what a provider writes in its error is cut to 200 characters, scrubbed of keys and of anything shaped like one', () => {
  const long = mapFailure(400, {error: {message: `bad request ${'word '.repeat(200)}${KEY}`}});
  assert.ok(long.message.length < 260, `${long.message.length} characters`);
  assert.doesNotMatch(long.message, new RegExp(KEY));
  assert.equal(long.kind, 'request');
  const shaped = mapFailure(500, {error: {message: `upstream token ${'Q'.repeat(40)} was rejected`}});
  assert.doesNotMatch(shaped.message, /Q{28}/);
  assert.equal(mapFailure(422, {detail: [{msg: 'field required', loc: ['body', 'messages']}]}).kind, 'request', 'a validation list is no model error');
  assert.equal(mapFailure(400, {message: 'Invalid model: ministral-9000'}).kind, 'model');
  assert.equal(mapFailure(408, {}).slow, true);
  assert.equal(mapFailure(529, {}).kind, 'network');
});

// ---- limits and waiting ------------------------------------------------------------------------------------------------------------------

test('a daily limit and a zero allowance are asked once; a per-second limit waits the server\'s retry-after, at most 8 s however long the header says', async () => {
  let calls = 0;
  const daily = await streamChat({apiKey: KEY, messages: [], sleepImpl: instantly,
    fetchImpl: async () => { calls++; return fail(429, {message: 'Rate limit reached: 200000 tokens per day (TPD)'}); }}).catch(error => error);
  assert.equal(daily.kind, 'limit'); assert.equal(daily.daily, true);
  assert.equal(calls, 1, 'waiting a few seconds cannot clear a daily allowance');

  const waits = [];
  calls = 0;
  const ok = await streamChat({apiKey: KEY, messages: [], sleepImpl: async ms => { waits.push(ms); },
    fetchImpl: async () => { calls++; return calls < 3 ? fail(429, {message: 'Rate limit exceeded'}, {'retry-after': '3600'}) : sse(delta('Finally.'), finish('stop')); }});
  assert.equal(ok.text, 'Finally.');
  assert.deepEqual(waits, [8000, 8000], 'one hour in the header is cut to 60 s, and the wait to 8 s');
  assert.equal(mapFailure(429, {}, {headers: new Headers({'retry-after': '3600'})}).retryAfterMs, 60_000);
  for (const value of ['-5', 'soon', 'Wed, 21 Oct 2026 07:28:00 GMT']) {
    assert.equal(mapFailure(429, {}, {headers: new Headers({'retry-after': value})}).retryAfterMs, undefined, JSON.stringify(value));
  }
});

test('every attempt answering with nothing ends as an empty-answer error that lists each attempt; a key shorter than 8 characters never leaves the computer', async () => {
  let calls = 0;
  const error = await streamChat({apiKey: KEY, messages: [], retries: 2, sleepImpl: instantly, fetchImpl: async () => { calls++; return sse(finish('stop')); }}).catch(caught => caught);
  assert.equal(error.kind, 'empty');
  assert.equal(calls, 3);
  assert.equal(error.failed.length, 3);
  assert.match(error.message, /\[mistral:empty\]$/);
  let sent = 0;
  for (const apiKey of ['short', '1234567', undefined, null, 12345678]) {
    const refused = await streamChat({apiKey, messages: [], fetchImpl: async () => { sent++; return sse(delta('x')); }}).catch(caught => caught);
    assert.equal(refused.kind, 'key', String(apiKey));
  }
  assert.equal(sent, 0);
  assert.equal((await streamChat({apiKey: '12345678', messages: [], retries: 0, fetchImpl: async () => sse(delta('ok'))})).text, 'ok', 'eight characters is the shortest key sent');
});

test('cancelling while the client waits to ask again ends the turn as an abort at once, not as the provider\'s error and not after the wait', async () => {
  const controller = new AbortController();
  const began = performance.now();
  // The cancel comes while the client is waiting to ask again: onRetry runs just before the wait begins, and the next turn of the loop is after it began.
  const error = await streamChat({apiKey: KEY, messages: [], retries: 2, backoffMs: [5000], signal: controller.signal, onRetry: () => { setImmediate(() => controller.abort()); },
    fetchImpl: async () => fail(503, {message: 'overloaded'})}).catch(caught => caught);
  assert.equal(error.name, 'AbortError');
  assert.ok(!(error instanceof MistralError));
  // The wait was 5 s: ending in under half of that, from a cancel that came as it began, is the wait being cut rather than served.
  assert.ok(performance.now() - began < 2500, 'not the 5 s backoff');
  // Already cancelled before the first ask: nothing is sent.
  let sent = 0;
  const early = await streamChat({apiKey: KEY, messages: [], signal: AbortSignal.abort(), fetchImpl: async () => { sent++; return sse(delta('x')); }}).catch(caught => caught);
  assert.equal(early.name, 'AbortError');
  assert.equal(sent, 0);
});

test('an observer that throws (onHeaders, onRetry, onDelta is the caller\'s own) never fails or changes the reply', async () => {
  let calls = 0;
  const result = await streamChat({apiKey: KEY, messages: [], retries: 1, sleepImpl: instantly,
    onHeaders: () => { throw Error('scheduler fault'); }, onRetry: () => { throw Error('log fault'); },
    fetchImpl: async () => { calls++; return calls === 1 ? fail(503, {message: 'busy'}) : sse(delta('Still fine.'), finish('stop')); }});
  assert.equal(result.text, 'Still fine.');
  assert.equal(result.attempts, 2);
});

test('the key check treats a host that never answers, a refusal of the check itself and a body that cannot be closed as what they are', async () => {
  const hang = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(Error('aborted'), {name: 'AbortError'}))));
  const began = performance.now();
  const keepAlive = setInterval(() => {}, 1000);   // the timeout's own timer does not hold the event loop
  try { assert.equal(await validateKey(KEY, {fetchImpl: hang, timeoutMs: 30}), 'unknown', 'a silent host says nothing about the key'); } finally { clearInterval(keepAlive); }
  // 30 ms was asked for; the default it must not fall back to is 10 s, so half of that is far from both and a loaded machine cannot reach it.
  assert.ok(performance.now() - began < 5000, 'not the default 10 s');
  assert.equal(await validateKey(KEY, {fetchImpl: async () => ({ok: true, status: 200, body: {cancel: async () => { throw Error('already closed'); }}})}), 'valid');
  assert.equal(await validateKey(KEY, {fetchImpl: async () => ({ok: false, status: 403, body: null})}), 'invalid');
  assert.equal(await validateKey(KEY, {fetchImpl: async () => ({ok: false, status: 503, body: null})}), 'unknown', 'a server fault is not a verdict on the key');
});
