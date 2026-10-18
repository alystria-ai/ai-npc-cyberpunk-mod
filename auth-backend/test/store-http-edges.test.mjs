// Edge paths of the building blocks under the handlers: the Redis REST client, the raw body reader and the settings reader.
// store.test.mjs and token-handler.test.mjs cover their ordinary behaviour.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { ADMIT_SCRIPT } from '../api/_lib/admit.js';
import { DEFAULTS, missingSettings, readConfig, validCap } from '../api/_lib/config.js';
import { readRawBody } from '../api/_lib/http.js';
import { StoreError, createUpstashStore } from '../api/_lib/store.js';

const URL_ = 'https://store.invalid';
const caught = async promise => promise.then(() => assert.fail('expected a rejection'), error => error);
const hang = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));

test('a store failure becomes a StoreError that never holds the network error, the upstream page or the token, and an error reply is cut to 200 characters', async () => {
  const token = 'bearer-token-that-must-not-leak';
  const open = fetchImpl => createUpstashStore({ url: URL_, token, fetchImpl });
  const messageOf = async promise => {
    const error = await caught(promise);
    assert.ok(error instanceof StoreError, String(error));
    return error.message;
  };
  const failedWith = fetchImpl => messageOf(open(fetchImpl).command(['PING']));

  assert.equal(await failedWith(async () => { throw new Error(`connect ECONNREFUSED ${URL_} ${token}`); }), 'store unreachable');
  assert.equal(await failedWith(async () => new Response(`<html>${token}</html>`, { status: 502 })), 'store answered 502 without JSON');
  const long = await failedWith(async () => Response.json({ error: `ERR ${'x'.repeat(500)}` }, { status: 500 }));
  assert.equal(long.length, 200);
  assert.ok(long.startsWith('ERR xxx'));
  assert.equal(await failedWith(async () => Response.json({ error: { code: 1 } }, { status: 500 })), 'store answered 500');
  assert.equal(await failedWith(async () => Response.json({}, { status: 429 })), 'store answered 429');

  assert.equal(await messageOf(open(async () => Response.json([{ result: 1 }, { error: 'ERR bad' }])).pipeline([['GET', 'a'], ['GET', 'b']])), 'ERR bad');
  assert.equal(await messageOf(open(async () => Response.json({ result: 1 })).pipeline([['GET', 'a']])), 'bad pipeline answer');
  assert.deepEqual(await open(async () => Response.json([{ result: 1 }, { result: null }])).pipeline([['GET', 'a'], ['GET', 'b']]), [1, null]);

  const keepAlive = setInterval(() => {}, 10); // an abort timer does not keep node alive by itself
  try {
    const slow = createUpstashStore({ url: URL_, token, fetchImpl: hang, timeoutMs: 20 });
    assert.equal(await messageOf(slow.command(['PING'])), 'store unreachable', 'a store that never answers is unreachable, after its timeout');
  } finally {
    clearInterval(keepAlive);
  }
});

test('a script error that is not NOSCRIPT is not retried, and a script that failed to load is not remembered as loaded', async () => {
  const calls = [];
  let mode = 'eval fails';
  const fetchImpl = async (url, init) => {
    const name = JSON.parse(init.body)[0];
    calls.push(name);
    if (mode === 'eval fails' && name === 'EVAL') return Response.json({ error: 'ERR script boom' }, { status: 500 });
    if (mode === 'evalsha fails' && name === 'EVALSHA') return Response.json({ error: 'ERR Error running script' }, { status: 500 });
    return Response.json({ result: ['ok', 1, ''] });
  };
  const store = createUpstashStore({ url: URL_, token: 't', fetchImpl });
  const run = () => store.evalScript(ADMIT_SCRIPT, ['k'], [1]);

  const first = await caught(run());
  assert.equal(first.message, 'ERR script boom');
  mode = 'fine';
  assert.deepEqual(await run(), ['ok', 1, ''], 'the next try sends the whole script again, since it never loaded');
  mode = 'evalsha fails';
  const second = await caught(run());
  assert.equal(second.message, 'ERR Error running script');
  mode = 'fine';
  await run();
  assert.deepEqual(calls, ['EVAL', 'EVAL', 'EVALSHA', 'EVALSHA'], 'an error from the cached script is passed on, not answered by resending it');
});

test('the raw body reader counts bytes, takes a body of exactly the limit, and copes with parsed, binary, missing and streamed bodies', async () => {
  assert.equal((await readRawBody({ body: 'x'.repeat(4096) })).length, 4096);
  assert.equal(await readRawBody({ body: 'x'.repeat(4097) }), null);
  assert.equal((await readRawBody({ body: '€'.repeat(1365) })).length, 1365, '4095 bytes in 1365 characters');
  assert.equal(await readRawBody({ body: '€'.repeat(1366) }), null, '4098 bytes in 1366 characters');
  assert.equal(await readRawBody({ body: Buffer.alloc(4097) }), null);
  assert.equal(await readRawBody({ body: 'abcd' }, 4), 'abcd');
  assert.equal(await readRawBody({ body: 'abcd' }, 3), null);
  assert.equal(await readRawBody({ body: { a: 1 } }), '{"a":1}', 'a body the platform already parsed is written out again');
  assert.equal(await readRawBody({ body: [1, 2] }), '[1,2]');
  assert.equal(await readRawBody({ body: Buffer.from('café') }), 'café');
  for (const body of [null, undefined]) assert.equal(await readRawBody({ body }), '');

  const bytes = size => Buffer.alloc(size, 97);
  assert.equal((await readRawBody(Readable.from([bytes(2048), bytes(2048)]))).length, 4096);
  assert.equal(await readRawBody(Readable.from([bytes(2048), bytes(2049)])), null);
  assert.equal(await readRawBody(Readable.from([bytes(5000)])), null, 'a single chunk over the limit');
  assert.equal(await readRawBody(Readable.from([])), '', 'a stream with nothing in it is an empty body');
});

test('settings: whole numbers only, clamped into range, junk falls back to the default, and blanks, spellings and pairs behave', () => {
  const read = env => readConfig(env);
  assert.equal(read({ CONVAI_AUTH_INSTALL_PER_HOUR: '0' }).installPerHour, 1, 'zero cannot switch a limit off: it is lifted to the minimum');
  for (const junk of ['-3', '1.5', '1e2', '', '  ', 'ten', '12345678901', '0x10']) {
    assert.equal(read({ CONVAI_AUTH_INSTALL_PER_HOUR: junk }).installPerHour, DEFAULTS.installPerHour, `${JSON.stringify(junk)} gives the default`);
  }
  assert.equal(read({ CONVAI_AUTH_INSTALL_PER_HOUR: ' 7 ' }).installPerHour, 7);
  assert.equal(read({ CONVAI_AUTH_INSTALL_PER_HOUR: '0010' }).installPerHour, 10);
  assert.equal(read({ CONVAI_AUTH_IP_PER_HOUR: '999999999' }).ipPerHour, 1_000_000, 'a huge value is cut to the ceiling');
  assert.deepEqual(['0', '20000', '10000'].map(value => read({ CONVAI_AUTH_DAILY_TURN_CAP: value }).dailyTurnCap), [1, 10_000, 10_000]);
  assert.deepEqual(['5', '300', '99999'].map(value => read({ CONVAI_AUTH_REMINT_MARGIN_SECONDS: value }).remintMarginSeconds), [30, 300, 3000]);

  for (const on of ['1', 'true', 'TRUE', ' yes ', 'On']) assert.equal(read({ CONVAI_AUTH_PAUSED: on }).paused, true, `${JSON.stringify(on)} pauses`);
  for (const off of ['0', 'false', 'no', 'off', '', '   ']) assert.equal(read({ CONVAI_AUTH_PAUSED: off }).paused, false, `${JSON.stringify(off)} does not`);
  assert.deepEqual([...read({ CONVAI_AUTH_BLOCKED_INSTALLS: 'aa, bb\ncc\t dd,,' }).blockedInstalls], ['aa', 'bb', 'cc', 'dd']);
  assert.equal(read({ CONVAI_API_KEY: ' key \n' }).apiKey, 'key', 'values are trimmed');

  const both = read({ UPSTASH_REDIS_REST_URL: 'https://u.invalid', UPSTASH_REDIS_REST_TOKEN: 'ut', KV_REST_API_URL: 'https://k.invalid', KV_REST_API_TOKEN: 'kt' });
  assert.deepEqual([both.storeUrl, both.storeToken], ['https://u.invalid', 'ut'], 'the Upstash pair wins when both pairs are there');
  const blankFirst = read({ UPSTASH_REDIS_REST_URL: '  ', KV_REST_API_URL: 'https://k.invalid', KV_REST_API_TOKEN: 'kt' });
  assert.deepEqual([blankFirst.storeUrl, blankFirst.storeToken], ['https://k.invalid', 'kt'], 'a blank value counts as not set');
  assert.equal(read({ CONVAI_CONNECT_URL: '  ' }).connectUrl, 'https://api.convai.com/user/connect');
  assert.equal(read({ CONVAI_CONNECT_URL: 'https://stand-in.invalid/connect' }).connectUrl, 'https://stand-in.invalid/connect');

  assert.deepEqual(missingSettings(read({})), ['CONVAI_API_KEY', 'CONVAI_AUTH_SIGNING_SECRET', 'UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN']);
  assert.deepEqual(missingSettings(read({ CONVAI_API_KEY: 'k', CONVAI_AUTH_SIGNING_SECRET: 's'.repeat(32), UPSTASH_REDIS_REST_URL: 'https://u.invalid' })),
    ['UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN'], 'an address without its token is not a store');
  assert.deepEqual([validCap('  12 '), validCap('1234567'), validCap(10_000), validCap(10_001), validCap(0), validCap(NaN), validCap(undefined)], [12, null, 10_000, null, null, null, null]);
});

test('a stream that delivers text instead of bytes is held to the same byte limit', {
  todo: 'BUG: http.js:45 adds chunk.length, which counts characters when a stream has an encoding set, so 3000 three-byte characters (9000 bytes) pass a 4096-byte limit',
}, async () => {
  const stream = new Readable({ read() {} });
  stream.setEncoding('utf8');
  stream.push(Buffer.from('€'.repeat(3000)));
  stream.push(null);
  assert.equal(await readRawBody(stream), null);
});
