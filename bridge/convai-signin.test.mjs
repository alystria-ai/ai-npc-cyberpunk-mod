// Sign in with Convai (bridge/convai-signin.mjs). Convai's login page and its decrypt route are mocked: no request leaves this computer.
// The "browser" here is a plain fetch to the loopback listener, doing what Convai's page does after a sign-in.
import {test} from 'node:test';
import {request as httpRequest} from 'node:http';
import assert from 'node:assert/strict';
import {CONVAI_SIGNIN, SignInError, callbackSource, exchangeSignIn, foreignHost, listenLoopback, rawQuery, startConvaiSignIn} from './convai-signin.mjs';

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
    const call = httpRequest({host: '127.0.0.1', port, path, method: 'GET', headers: {Host: host, ...headers}, timeout: 60000}, response => {
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

// What Convai's page does after a sign-in: send the browser to the loopback address. The browser names the page it came from (Referer).
const CONVAI_PAGE = 'https://login.convai.com/';
const convaiRedirects = (port, query, {host = 'localhost', headers = {Referer: CONVAI_PAGE}} = {}) => get(port, `/control?${query}`, `${host}:${port}`, headers);

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

test('requests with another Host or another path are refused, a second /control is refused, and the first good one wins', async () => {
  const {session, calls, port} = begin();
  try {
    const value = await port();
    assert.equal((await convaiRedirects(value, `api_key=${KEY_BLOB}`, {host: 'evil.example'})).status, 403, 'DNS rebinding');
    assert.equal((await get(value, '/other')).status, 404);
    assert.equal(calls.length, 0, 'nothing was sent to Convai for a bad request');
    assert.equal((await convaiRedirects(value, `api_key=${KEY_BLOB}`)).status, 303);
    assert.equal((await convaiRedirects(value, 'api_key=U2FsdGVkX1+second/attempt==')).status, 404, 'one sign-in only');
    assert.equal(await session.key, KEY);
    assert.deepEqual(calls, [{data: KEY_BLOB}]);
  } finally { session.cancel(); }
});

test('a navigation to the callback with no usable value ends the sign-in at once with the "did not finish" page, so the game does not wait five minutes', async () => {
  for (const query of ['api_key=', 'api_key=has%20space%20and<tags>', 'user_info=', 'other=1']) {
    const {session, calls, port} = begin();
    const value = await port();
    const answer = await convaiRedirects(value, query);
    assert.equal(answer.status, 400, query);
    assert.match(answer.text, /did not finish/);
    await assert.rejects(session.key, error => error instanceof SignInError && error.code === 'bad-answer', query);
    assert.equal(calls.length, 0, 'nothing was sent to Convai');
  }
  // A request that cannot be the player's browser navigating (an image, a fetch, another Host) does not end it: any page could cancel a sign-in that way.
  const {session, port} = begin();
  try {
    const value = await port();
    assert.equal((await get(value, '/control?api_key=', `localhost:${value}`, {'Sec-Fetch-Mode': 'no-cors', 'Sec-Fetch-Dest': 'image'})).status, 403);
    assert.equal((await convaiRedirects(value, 'api_key=x', {host: 'evil.example'})).status, 403);
    assert.equal((await convaiRedirects(value, `api_key=${KEY_BLOB}`)).status, 303);
    assert.equal(await session.key, KEY);
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
    const first = await get(value, path, host, {'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'cross-site', Referer: CONVAI_PAGE});
    assert.equal(first.status, 303);
    assert.equal(await session.key, KEY);
    const done = await get(value, '/done', host, {'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'same-origin'});
    assert.match(done.text, /Signed in/);
  } finally { session.cancel(); }
});

test('callbackSource: Convai’s own pages, any other site, or no usable Referer (none, or the loopback address itself)', () => {
  assert.equal(callbackSource({referer: 'https://login.convai.com/'}), 'convai');
  assert.equal(callbackSource({referer: 'https://login.convai.com/?ue=true&port=5000'}), 'convai');
  assert.equal(callbackSource({referer: 'https://convai.com/'}), 'convai');
  for (const other of ['https://evil.example/', 'http://login.convai.com/', 'https://login.convai.com.evil.example/', 'https://evilconvai.com/', 'null', 'not a url'])
    assert.equal(callbackSource({referer: other}), 'foreign', other);
  for (const unknown of [undefined, '', 'http://localhost:5000/control?api_key=x', 'http://127.0.0.1:5000/', 'http://[::1]:5000/control'])
    assert.equal(callbackSource({referer: unknown}), 'unknown', String(unknown));
  assert.equal(foreignHost({referer: 'https://accounts.example.net/signin?x=1#y'}), 'accounts.example.net', 'the host only');
  assert.equal(foreignHost({referer: 'https://login.convai.com/'}), null);
  assert.equal(foreignHost({}), null);
});

const NAVIGATION = {'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'cross-site'};
const CLICK = {'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-Site': 'same-origin'};
/** The callback from a browser that is not Convai's page: the answer is a redirect to a clean confirmation address, which is then fetched. */
async function heldCallback(value, host, query, headers) {
  const first = await get(value, `/control?${query}`, host, {...NAVIGATION, ...headers});
  assert.equal(first.status, 303, 'not taken at once');
  assert.match(first.headers.location, /^\/confirm-page\?state=[0-9a-f]{32}$/, 'a clean address: the encrypted values do not stay in the address bar');
  const page = await get(value, first.headers.location, host, NAVIGATION);
  return {first, page, state: /\/confirm\?state=([0-9a-f]{32})/.exec(page.text)?.[1]};
}

test('a web page cannot make the mod save its key: a callback from another site, or with no usable Referer, is held until the player confirms', async () => {
  const {session, calls, port} = begin();
  try {
    const value = await port();
    const host = `localhost:${value}`, attack = 'U2FsdGVkX1+attacker/blob==';
    // Another site names itself: the player is asked, and told which site it was. Nothing is saved or sent to Convai.
    const foreign = await heldCallback(value, host, `api_key=${attack}`, {Referer: 'https://evil.example/path?secret=1'});
    assert.equal(foreign.page.status, 200);
    assert.match(foreign.page.text, /Confirm sign-in/);
    assert.match(foreign.page.text, /another website \(evil\.example\)/);
    assert.ok(!foreign.page.text.includes('secret=1') && !foreign.page.text.includes(attack), 'neither the path nor the encrypted value is shown');
    // The loopback address as Referer (a browser that spoofs it as the target) and no Referer at all: the same page without a site.
    const loop = await heldCallback(value, host, `api_key=${attack}`, {Referer: `http://localhost:${value}/control`});
    assert.match(loop.page.text, /did not say where this came from/);
    const hidden = await heldCallback(value, host, `api_key=${attack}`, {});
    assert.match(hidden.page.text, /Confirm sign-in/);
    assert.ok(!hidden.page.text.includes(attack), 'the encrypted value is not echoed');
    assert.equal(calls.length, 0, 'nothing was sent to Convai');
    assert.ok(foreign.state && loop.state && hidden.state && new Set([foreign.state, loop.state, hidden.state]).size === 3, 'each page has its own one-time state');
    // The attacker's page cannot read the confirmation page, so it cannot confirm: a guessed or missing state, or a confirm that is not a same-origin click, fails with a page that says so.
    for (const [path, headers] of [[`/confirm?state=${'0'.repeat(32)}`, CLICK], ['/confirm', CLICK], [`/confirm?state=${hidden.state}`, {'Sec-Fetch-Site': 'cross-site'}]]) {
      const refused = await get(value, path, host, headers);
      assert.equal(refused.status, 403, path);
      assert.match(refused.text, /did not finish/);
    }
    assert.equal((await get(value, `/confirm-page?state=${'1'.repeat(32)}`, host, NAVIGATION)).status, 404);
    assert.equal(calls.length, 0);
    // The real sign-in from Convai's page still works, while the held ones wait, and wins: the held ones can no longer be confirmed.
    assert.equal((await convaiRedirects(value, `api_key=${KEY_BLOB}`)).status, 303);
    assert.equal(await session.key, KEY);
    assert.deepEqual(calls, [{data: KEY_BLOB}]);
    assert.equal((await get(value, `/confirm?state=${hidden.state}`, host, CLICK)).status, 404, 'one sign-in only');
  } finally { session.cancel(); }
});

test('a callback from another site or with no Referer still signs in, after the player confirms on the page the listener shows', async () => {
  for (const headers of [{}, {Referer: 'https://accounts.example.net/'}, {Referer: 'http://127.0.0.1:1/'}]) {
    const {session, calls, port} = begin();
    const value = await port(), host = `localhost:${value}`;
    const held = await heldCallback(value, host, `api_key=${KEY_BLOB}`, headers);
    assert.equal(calls.length, 0, 'held: nothing sent yet');
    const confirmed = await get(value, `/confirm?state=${held.state}`, host, CLICK);
    assert.equal(confirmed.status, 303);
    assert.equal(confirmed.headers.location, '/done');
    assert.equal(await session.key, KEY);
    assert.deepEqual(calls, [{data: KEY_BLOB}]);
    assert.match((await get(value, '/done', host)).text, /Signed in/);
  }
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
