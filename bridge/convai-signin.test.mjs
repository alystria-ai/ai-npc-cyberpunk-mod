// Sign in with Convai (bridge/convai-signin.mjs). Convai's login page and its decrypt route are mocked: no request leaves this computer.
// The "browser" here is a plain fetch to the loopback listener, doing what Convai's page does after a sign-in.
import {test} from 'node:test';
import {request as httpRequest} from 'node:http';
import assert from 'node:assert/strict';
import {CONVAI_SIGNIN, SignInError, exchangeSignIn, listenLoopback, rawQuery, startConvaiSignIn} from './convai-signin.mjs';

const KEY = '0123456789abcdef0123456789abcdef';
// Convai's values are CryptoJS base64 ("U2FsdGVkX1..."), with '+', '/' and '=' in them.
const KEY_BLOB = 'U2FsdGVkX1+abc/DEF+ghi==';
const ACCOUNT_BLOB = 'U2FsdGVkX1/account+blob/xyz=';

/** A decrypt route: {blob: answer}, answer being {status, json} or {status, text}. Records every body it was sent. */
function fakeDecrypt(answers) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    assert.equal(url, CONVAI_SIGNIN.decryptUrl, 'only the decrypt route is called');
    assert.equal(init.method, 'POST');
    const body = JSON.parse(init.body);
    calls.push(body);
    const answer = answers[decodeURIComponent(body.data)]; // Convai's route decodes the value once itself
    if (!answer) return new Response('{"error":"bad"}', {status: 500});
    if (answer instanceof Error) throw answer;
    return new Response(answer.text ?? JSON.stringify(answer.json), {status: answer.status ?? 200});
  };
  return {fetchImpl, calls};
}

// The module unrefs its timers and listeners (they must never keep the service alive); these hold the test process open instead.
// (The 15 s wait for the browser's /done page stays unreferenced.)
const heldTimers = {setTimer: (fn, ms) => { const id = setTimeout(fn, ms); if (ms >= 10_000) id.unref(); return {id}; },
  clearTimer: timer => clearTimeout(timer.id)};

/** Starts a sign-in whose "browser" only records the address it was asked to open. */
function begin({answers = {[KEY_BLOB]: {json: {decryptedData: KEY}}}, ...options} = {}) {
  const opened = [];
  const {fetchImpl, calls} = fakeDecrypt(answers);
  const session = startConvaiSignIn({fetchImpl, openBrowser: async url => { opened.push(url); }, ...heldTimers, ...options});
  const port = async () => { await session.opened; return Number(new URL(opened[0]).searchParams.get('port')); };
  return {session, opened, calls, port};
}

// A GET to the loopback listener with a chosen Host header, as a browser sends it. Resolves {status, headers, text}.
function get(port, path, host = `localhost:${port}`, headers = {}) {
  return new Promise((resolve, reject) => {
    const call = httpRequest({host: '127.0.0.1', port, path, method: 'GET', headers: {Host: host, ...headers}, timeout: 2000}, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({status: response.statusCode, headers: response.headers, text}));
    });
    call.on('timeout', () => call.destroy(Error('timeout')));
    call.on('error', reject);
    call.end();
  });
}

// What Convai's page does after a sign-in: send the browser to the loopback address.
const convaiRedirects = (port, query, {host = 'localhost'} = {}) => get(port, `/control?${query}`, `${host}:${port}`);

const refused = async port => { try { await get(port, '/done'); return false; } catch { return true; } };

test('Convai’s login page is opened with ue=true and the loopback port, and the listener is on loopback only', async () => {
  const {session, opened, port} = begin();
  try {
    const value = await port();
    const url = new URL(opened[0]);
    assert.equal(url.origin + url.pathname, 'https://login.convai.com/');
    assert.equal(url.searchParams.get('ue'), 'true');
    assert.ok(value > 0 && value < 65536);
  } finally { session.cancel(); }
});

test('the encrypted key from Convai’s page is decrypted unchanged (a "+" stays a "+"), saved, and the listener closes', async () => {
  const {session, calls, port} = begin();
  const value = await port();
  const first = await convaiRedirects(value, `api_key=${KEY_BLOB}&user_info=${encodeURIComponent(ACCOUNT_BLOB)}`);
  assert.equal(first.status, 303);
  assert.equal(first.headers.location, '/done', 'the encrypted values leave the address bar at once');
  assert.equal(await session.key, KEY);
  assert.deepEqual(calls, [{data: KEY_BLOB}], 'only the key value was needed');
  const done = await get(value, '/done');
  const page = done.text;
  assert.equal(done.status, 200);
  assert.match(page, /Signed in/);
  assert.ok(!page.includes(KEY) && !page.includes(KEY_BLOB), 'the page shows neither the key nor its encrypted value');
  assert.equal(done.headers['cache-control'], 'no-store');
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(await refused(value), 'the listener is closed after the sign-in');
});

test('when the key value cannot be decrypted, the account value (which carries apiKey) is used', async () => {
  const {session, calls, port} = begin({answers: {[ACCOUNT_BLOB]: {json: {decryptedData: JSON.stringify({email: 'a@example.com', apiKey: KEY})}}}});
  const value = await port();
  await convaiRedirects(value, `api_key=${KEY_BLOB}&user_info=${encodeURIComponent(ACCOUNT_BLOB)}`);
  assert.equal(await session.key, KEY);
  assert.deepEqual(calls.map(call => call.data), [KEY_BLOB, encodeURIComponent(ACCOUNT_BLOB)], 'raw values, decoded only by Convai');
});

test('an answer without a plausible key fails the sign-in, and /done says so', async () => {
  const {session, port} = begin({answers: {[KEY_BLOB]: {json: {decryptedData: 'not a key'}}}});
  const value = await port();
  await convaiRedirects(value, `api_key=${KEY_BLOB}`);
  await assert.rejects(session.key, error => error instanceof SignInError && error.code === 'bad-answer');
  const done = await get(value, '/done', `127.0.0.1:${value}`).catch(() => null);
  if (done) assert.match(done.text, /did not finish/);
});

test('the sign-in ends after its time, and on cancel; the listener closes both times', async () => {
  const late = begin({config: {...CONVAI_SIGNIN, timeoutMs: 40}});
  const latePort = await late.port();
  await assert.rejects(late.session.key, error => error.code === 'timeout');
  assert.ok(await refused(latePort));
  const cancelled = begin();
  const cancelledPort = await cancelled.port();
  cancelled.session.cancel();
  await assert.rejects(cancelled.session.key, error => error.code === 'cancelled');
  assert.ok(await refused(cancelledPort));
});

test('requests with another Host, another path, a missing value or a second /control are refused; the first good one wins', async () => {
  const {session, calls, port} = begin();
  try {
    const value = await port();
    assert.equal((await convaiRedirects(value, `api_key=${KEY_BLOB}`, {host: 'evil.example'})).status, 403, 'DNS rebinding');
    assert.equal((await get(value, '/other')).status, 404);
    assert.equal((await convaiRedirects(value, 'api_key=')).status, 400);
    assert.equal((await convaiRedirects(value, 'api_key=has%20space%20and<tags>')).status, 400);
    assert.equal(calls.length, 0, 'nothing was sent to Convai for a bad request');
    assert.equal((await convaiRedirects(value, `api_key=${KEY_BLOB}`)).status, 303);
    assert.equal((await convaiRedirects(value, 'api_key=U2FsdGVkX1+second/attempt==')).status, 404, 'one sign-in only');
    assert.equal(await session.key, KEY);
    assert.deepEqual(calls, [{data: KEY_BLOB}]);
  } finally { session.cancel(); }
});

test('only a browser navigation is answered: an image, a frame or a fetch another page makes cannot hand over its own values', async () => {
  const {session, calls, port} = begin();
  try {
    const value = await port();
    const path = `/control?api_key=${KEY_BLOB}`, host = `localhost:${value}`;
    // How a web page open in the player's browser would look for the port and slip in its own Convai account's values.
    for (const headers of [{'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image'}, {'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'iframe'},
      {'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty'}, {'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'script'}, {'Sec-Fetch-Dest': 'image'},
      {'Sec-Fetch-Mode': 'no-cors'}]) {
      assert.equal((await get(value, path, host, headers)).status, 403, JSON.stringify(headers));
    }
    assert.equal(calls.length, 0, 'nothing was sent to Convai');
    // Convai's page sending the browser here: a top-level navigation.
    const first = await get(value, path, host, {'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'cross-site'});
    assert.equal(first.status, 303);
    assert.equal(await session.key, KEY);
    const done = await get(value, '/done', host, {'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'same-origin'});
    assert.match(done.text, /Signed in/);
  } finally { session.cancel(); }
});

test('a browser that cannot be opened fails at once and closes the listener', async () => {
  let address = null;
  const session = startConvaiSignIn({fetchImpl: async () => { throw Error('never'); },
    openBrowser: async url => { address = url; throw Error('no browser'); }});
  await assert.rejects(session.opened, error => error.code === 'open-failed');
  await assert.rejects(session.key, error => error.code === 'open-failed');
  assert.ok(await refused(Number(new URL(address).searchParams.get('port'))));
});

test('a listener that cannot start fails as listen-failed; a port whose ::1 side is taken is never used', async () => {
  const session = startConvaiSignIn({listen: async () => { throw Error('no port'); }, openBrowser: async () => { throw Error('never'); }});
  await assert.rejects(session.opened, error => error.code === 'listen-failed');
  // Fake servers: the first ::1 bind is taken, the second is free.
  const binds = [];
  let v6Attempts = 0;
  const create = () => {
    const handlers = {};
    let port = null;
    return {once: (name, fn) => { handlers[name] = fn; }, off: () => {}, close: () => { binds.push(['close', port]); },
      address: () => ({port}),
      listen: (wanted, host, done) => {
        port = wanted || 40000 + binds.length;
        binds.push([host, port]);
        if (host === '::1' && ++v6Attempts === 1) { const error = Object.assign(Error('taken'), {code: 'EADDRINUSE'}); handlers.error(error); return; }
        done();
      }};
  };
  const bound = await listenLoopback(() => {}, {create});
  assert.equal(bound.servers.length, 2);
  assert.ok(binds.some(([what]) => what === 'close'), 'the port with a taken ::1 side was given back');
  assert.equal(binds.filter(([host]) => host === '::1').length, 2);
});

test('exchangeSignIn: Convai’s errors map to reasons, and the decrypt address must be on convai.com', async () => {
  const route = answer => async () => answer instanceof Error ? Promise.reject(answer) : new Response('{}', {status: answer});
  await assert.rejects(exchangeSignIn({apiKey: KEY_BLOB, fetchImpl: route(503)}), error => error.code === 'unavailable');
  await assert.rejects(exchangeSignIn({apiKey: KEY_BLOB, fetchImpl: route(400)}), error => error.code === 'refused');
  await assert.rejects(exchangeSignIn({apiKey: KEY_BLOB, fetchImpl: route(Error('offline'))}), error => error.code === 'unreachable');
  let called = false;
  await assert.rejects(exchangeSignIn({apiKey: KEY_BLOB, config: {...CONVAI_SIGNIN, decryptUrl: 'https://evil.example/api/decrypt'},
    fetchImpl: async () => { called = true; return new Response('{}'); }}), error => error.code === 'refused');
  assert.equal(called, false, 'an encrypted value never goes to another host');
  // A plain-text or JSON-string answer is read as the key too.
  assert.equal(await exchangeSignIn({apiKey: KEY_BLOB, fetchImpl: async () => new Response(KEY)}), KEY);
  assert.equal(await exchangeSignIn({apiKey: KEY_BLOB, fetchImpl: async () => new Response(JSON.stringify({decryptedData: `"${KEY}"`}))}), KEY);
});

test('rawQuery keeps values exactly as sent', () => {
  assert.deepEqual(rawQuery('/control?api_key=a+b/c==&user_info=x%2By&api_key=second', ['api_key', 'user_info']),
    {api_key: 'a+b/c==', user_info: 'x%2By'});
  assert.deepEqual(rawQuery('/control', ['api_key']), {});
});
