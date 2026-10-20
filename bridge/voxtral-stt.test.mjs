// Mistral transcription for other languages (bridge/voxtral-stt.mjs). A fake fetch and a fake scheduler: no network, and the key is built at run
// time (never a literal), so nothing here can leak or trip a secret scanner.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {VoxtralStt, VoxtralSttError, wavFromPcm16, mapSttStatus, VOXTRAL_STT_MODEL, VOXTRAL_STT_FALLBACK_MODEL, redact} from './voxtral-stt.mjs';

const key = () => randomBytes(18).toString('hex');
const pcm = seconds => Buffer.alloc(Math.round(seconds * 32000), 1);
const json = (body, init = {}) => new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}, ...init});
const scheduler = () => ({calls: 0, pauses: [], schedule(task) { this.calls++; return Promise.resolve().then(task); }, noteHeaders() {}, pause(ms) { this.pauses.push(ms); }});

function make({answers, apiKey = key(), ...options} = {}) {
  const requests = [], logs = [];
  const queue = [...answers];
  let current = apiKey;
  const clock = {now: 1_000_000};
  const stt = new VoxtralStt({getKey: () => current, onLog: line => logs.push(line), scheduler: scheduler(), clock: () => clock.now,
    fetchImpl: async (url, init) => {
      const form = init.body;
      requests.push({url, method: init.method, auth: init.headers.authorization, model: form.get('model'), language: form.get('language'), file: form.get('file')});
      const next = queue.shift();
      if (typeof next === 'function') return next();
      return next;
    },
    limits: {retryWaitMs: 1}, ...options});
  return {stt, requests, logs, clock, setKey: value => { current = value; }, apiKey};
}

test('a WAV file wraps 16 kHz mono samples: 44-byte header, sizes and rate', () => {
  const wav = wavFromPcm16(pcm(0.5));
  assert.equal(wav.length, 44 + 16000);
  assert.equal(wav.toString('latin1', 0, 4), 'RIFF'); assert.equal(wav.toString('latin1', 8, 16), 'WAVEfmt ');
  assert.equal(wav.readUInt32LE(24), 16000); assert.equal(wav.readUInt16LE(22), 1); assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 16000); assert.equal(wav.readUInt32LE(4), 36 + 16000);
});

test('one request: the model, the file, the bearer key, no language unless one is given; the answer names the language', async () => {
  const f = make({answers: [json({text: '  Привет,\n  как дела?  ', language: 'ru'})]});
  const result = await f.stt.transcribe(pcm(2));
  assert.equal(result.text, 'Привет, как дела?'); assert.equal(result.language, 'ru');
  assert.equal(f.requests.length, 1);
  const [request] = f.requests;
  assert.equal(request.url, 'https://api.mistral.ai/v1/audio/transcriptions'); assert.equal(request.method, 'POST');
  assert.equal(request.auth, 'Bearer ' + f.apiKey); assert.equal(request.model, VOXTRAL_STT_MODEL); assert.equal(request.language, null);
  assert.equal(VOXTRAL_STT_MODEL, 'voxtral-mini-transcribe-3-0', 'Transcribe 3 is asked by name: the -latest alias still points to Transcribe 2');
  assert.equal(VOXTRAL_STT_FALLBACK_MODEL, 'voxtral-mini-latest');
  assert.equal(request.file.size, 44 + 64000); assert.equal(request.file.type, 'audio/wav');
  const hinted = make({answers: [json({text: 'hola', language: 'es'})]});
  await hinted.stt.transcribe(pcm(1), {language: 'es'});
  assert.equal(hinted.requests[0].language, 'es');
  assert.ok(f.logs.every(line => !line.includes(f.apiKey)), 'the key is never logged');
});

test('no key: nothing is sent', async () => {
  const f = make({answers: [], apiKey: null});
  assert.equal(f.stt.ready, false); assert.equal(f.stt.unavailableReason, 'no-key');
  await assert.rejects(f.stt.transcribe(pcm(1)), error => error instanceof VoxtralSttError && error.kind === 'no-key');
  assert.equal(f.requests.length, 0);
});

test('empty audio, too much audio and an answer without text are refused', async () => {
  const f = make({answers: [json({language: 'ru'})]});
  await assert.rejects(f.stt.transcribe(Buffer.alloc(0)), error => error.kind === 'empty');
  await assert.rejects(f.stt.transcribe(Buffer.alloc(4_000_000)), error => error.kind === 'request');
  await assert.rejects(f.stt.transcribe(pcm(1)), error => error.kind === 'request' && /without text/.test(error.message));
});

test('a 5xx or a network error is asked again once at once; the second answer is used', async () => {
  const f = make({answers: [new Response('oops', {status: 502}), json({text: 'ok', language: 'de'})]});
  const result = await f.stt.transcribe(pcm(1));
  assert.equal(result.text, 'ok'); assert.equal(f.requests.length, 2);
  const g = make({answers: [() => { throw TypeError('fetch failed'); }, json({text: 'again', language: 'fr'})]});
  assert.equal((await g.stt.transcribe(pcm(1))).text, 'again');
  const h = make({answers: [new Response('', {status: 500}), new Response('', {status: 500})]});
  await assert.rejects(h.stt.transcribe(pcm(1)), error => error.kind === 'network' && error.status === 500);
  assert.equal(h.requests.length, 2, 'only one extra try');
  assert.equal(h.stt.ready, true, 'a server fault is not a cool-down');
});

test('401: the key is refused, no second try, and the transcriber cools down until a different key is saved', async () => {
  const f = make({answers: [new Response('{"message":"Unauthorized"}', {status: 401}), json({text: 'fine', language: 'ru'})]});
  await assert.rejects(f.stt.transcribe(pcm(1)), error => error.kind === 'key' && error.status === 401);
  assert.equal(f.requests.length, 1);
  assert.equal(f.stt.ready, false); assert.equal(f.stt.unavailableReason, 'key');
  await assert.rejects(f.stt.transcribe(pcm(1)), error => error.kind === 'key');
  assert.equal(f.requests.length, 1, 'cooling down: no request is made');
  f.setKey(key());
  assert.equal(f.stt.ready, true, 'a new key is tried at once');
  assert.equal((await f.stt.transcribe(pcm(1))).text, 'fine');
});

test('403 twice (not in the plan) and an allowance of 0 put the transcriber into a long cool-down that ends by itself', async () => {
  const f = make({answers: [new Response('forbidden', {status: 403}), new Response('forbidden', {status: 403}), new Response('forbidden', {status: 403})]});
  await assert.rejects(f.stt.transcribe(pcm(1)), error => error.kind === 'plan' && error.status === 403);
  assert.equal(f.requests.length, 3, 'a 403 can be a hiccup: asked once more; a repeated one can be the plan refusing v3: the older model once');
  assert.deepEqual(f.requests.map(request => request.model), [VOXTRAL_STT_MODEL, VOXTRAL_STT_MODEL, VOXTRAL_STT_FALLBACK_MODEL]);
  assert.equal(f.stt.model, VOXTRAL_STT_MODEL, 'the older model refused too: nothing changed');
  assert.equal(f.stt.unavailableReason, 'plan');
  f.clock.now += 599_000; assert.equal(f.stt.ready, false);
  f.clock.now += 2_000; assert.equal(f.stt.ready, true);
  const noAllowance = () => new Response('limit', {status: 429, headers: {'x-ratelimit-limit-req-minute': '0'}});
  const zero = make({answers: [noAllowance(), noAllowance()]});
  await assert.rejects(zero.stt.transcribe(pcm(1)), error => error.kind === 'plan');
  assert.equal(zero.requests.length, 2, 'an allowance of 0 is not asked again: v3 once, the older model once');
  assert.equal(zero.stt.unavailableReason, 'plan');
});

test('429: every Mistral start pauses for the Retry-After, and the transcriber cools down for it', async () => {
  const f = make({answers: [new Response('slow down', {status: 429, headers: {'retry-after': '7'}})]});
  await assert.rejects(f.stt.transcribe(pcm(1)), error => error.kind === 'limit' && error.retryAfterMs === 7000);
  assert.deepEqual(f.stt.scheduler.pauses, [7000]);
  assert.equal(f.stt.unavailableReason, 'limit');
  f.clock.now += 6_000; assert.equal(f.stt.ready, false);
  f.clock.now += 2_000; assert.equal(f.stt.ready, true);
});

test('a request that gets no answer in time fails as a timeout; cancelling throws the cancellation, not a Mistral error', async t => {
  // A real request keeps the event loop alive; the fake one that never answers does not.
  const keepAlive = setInterval(() => {}, 20); t.after(() => clearInterval(keepAlive));
  const f = make({answers: [() => new Promise((_, reject) => setTimeout(() => reject(Error('aborted')), 50))], limits: {requestMs: 1000, budgetMs: 1500, retryWaitMs: 1}});
  // Replace the fetch with one that honours the abort signal.
  f.stt.fetchImpl = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true}));
  f.stt.limits = Object.freeze({...f.stt.limits, requestMs: 20, budgetMs: 30, retryWaitMs: 1});
  await assert.rejects(f.stt.transcribe(pcm(1)), error => error instanceof VoxtralSttError && error.kind === 'timeout');
  const controller = new AbortController();
  const g = make({answers: []});
  g.stt.fetchImpl = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), {once: true}));
  const pending = g.stt.transcribe(pcm(1), {signal: controller.signal});
  setTimeout(() => controller.abort(Object.assign(Error('cancelled'), {code: 'cancelled'})), 10);
  await assert.rejects(pending, error => !(error instanceof VoxtralSttError));
  assert.equal(g.stt.ready, true, 'a cancelled recording cools nothing down');
});

test('status mapping and redaction never expose a key', () => {
  const secret = key();
  assert.equal(mapSttStatus(401, '', {apiKey: secret}).kind, 'key');
  assert.equal(mapSttStatus(403, '', {}).kind, 'plan');
  assert.equal(mapSttStatus(400, 'bad file', {}).kind, 'request');
  assert.equal(mapSttStatus(503, '', {}).kind, 'network');
  const echoed = mapSttStatus(400, 'the key ' + secret + ' is no good', {apiKey: secret});
  assert.ok(!echoed.message.includes(secret));
  assert.equal(redact('a ' + secret + ' b', secret), 'a [key] b');
  assert.equal(redact('x' + 'y'.repeat(30), null), '[key]');
});

test('Transcribe 3 refused (404, an unknown model, or an allowance of 0): the older model answers the same recording, the log says so once, and v3 is tried again later', async () => {
  for (const refusal of [() => new Response('{"message":"Not found"}', {status: 404}), () => new Response('{"message":"Invalid model: voxtral-mini-transcribe-3-0"}', {status: 400}),
    () => new Response('limit', {status: 429, headers: {'x-ratelimit-limit-req-minute': '0'}})]) {
    const f = make({answers: [refusal, () => json({text: 'hola', language: 'es'}), () => json({text: 'otra vez', language: 'es'}), refusal, () => json({text: 'de nuevo', language: 'es'})]});
    assert.equal((await f.stt.transcribe(pcm(1), {language: 'pl'})).text, 'hola');
    assert.deepEqual(f.requests.map(request => request.model), [VOXTRAL_STT_MODEL, VOXTRAL_STT_FALLBACK_MODEL]);
    assert.equal(f.requests[0].language, 'pl', 'Polish is on the Transcribe 3 list: hinted');
    assert.equal(f.requests[1].language, null, 'the older model does not list Polish: asked without a hint');
    assert.equal(f.stt.model, VOXTRAL_STT_FALLBACK_MODEL); assert.equal(f.stt.ready, true, 'a refused model is not a refused key: no cool-down');
    assert.equal(f.logs.filter(line => /was refused for this key/.test(line)).length, 1);
    await f.stt.transcribe(pcm(1));
    assert.equal(f.requests.length, 3, 'the next recording goes straight to the older model'); assert.equal(f.requests[2].model, VOXTRAL_STT_FALLBACK_MODEL);
    f.clock.now += 600_001;
    assert.equal(f.stt.model, VOXTRAL_STT_MODEL);
    await f.stt.transcribe(pcm(1));
    assert.deepEqual(f.requests.slice(3).map(request => request.model), [VOXTRAL_STT_MODEL, VOXTRAL_STT_FALLBACK_MODEL], 'v3 is tried again after ten minutes; refused again, the older model answers');
    assert.equal(f.logs.filter(line => /was refused for this key/.test(line)).length, 1, 'the log line is not repeated');
  }
});

test('a rate limit, a server fault, a timeout and a 401 are not a refused model: the v3 id stays and the older model is not asked', async () => {
  for (const [answer, kind] of [[new Response('slow', {status: 429, headers: {'retry-after': '30'}}), 'limit'], [new Response('key', {status: 401}), 'key']]) {
    const f = make({answers: [answer]});
    await assert.rejects(f.stt.transcribe(pcm(1)), error => error.kind === kind);
    assert.equal(f.requests.length, 1, kind); assert.equal(f.stt.model, VOXTRAL_STT_MODEL);
  }
  const hiccup = make({answers: [new Response('oops', {status: 502}), json({text: 'ok', language: 'de'})]});
  await hiccup.stt.transcribe(pcm(1));
  assert.deepEqual(hiccup.requests.map(request => request.model), [VOXTRAL_STT_MODEL, VOXTRAL_STT_MODEL]);
  assert.equal(hiccup.stt.model, VOXTRAL_STT_MODEL);
});

test('a transcriber made with a model of its own keeps it and never falls back', async () => {
  const f = make({answers: [new Response('{"message":"Not found"}', {status: 404})], model: 'custom-model'});
  await assert.rejects(f.stt.transcribe(pcm(1)), error => error.kind === 'request');
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].model, 'custom-model');
});
