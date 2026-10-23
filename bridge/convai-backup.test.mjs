import {test} from 'node:test';
import assert from 'node:assert/strict';
import {TokenSource, STAGGER_MS, cleanBackupUrl, readAuthSettings, readBackendAddress} from './convai-credential.mjs';
// The two real backends, driven by the same signed requests the bridge sends: the Vercel handlers (fake Redis) and the Cloudflare Worker (in-memory Durable Objects).
import {createWorld as createVercelWorld, mockResponse, SIGNING_SECRET} from '../auth-backend/testkit/harness.mjs';
import {createWorld as createWorkerWorld} from '../auth-backend-cf/testkit/world.mjs';

const INSTALL = '3b241101-e2bb-4255-8caf-4136c566a962';
const VERCEL = 'https://vercel.example.invalid/api/convai/token';
const WORKER = 'https://worker.example.invalid/api/convai/token';
const MINUTE = 60_000;
// The Worker signs with WebCrypto, which answers on a thread pool: let real time pass, not only the microtask queue.
const flush = async () => { for (let round = 0; round < 12; round++) await new Promise(done => setTimeout(done, 3)); };

function fakeTimers() {
  const timers = [];
  let next = 0;
  return {
    timers,
    setTimer(callback, delay) { const id = ++next; timers.push({id, callback, delay, live: true}); return id; },
    clearTimer(id) { const timer = timers.find(row => row.id === id); if (timer) timer.live = false; },
    get live() { return timers.filter(row => row.live); },
    async fire() { const [timer] = this.live; assert.ok(timer, 'a timer was scheduled'); timer.live = false; timer.callback(); await flush(); return timer.delay; },
  };
}

const networkError = code => Object.assign(TypeError('fetch failed'), {cause: Object.assign(Error('x'), {code})});

/**
 * Both backends behind one fetch. `vercel` and `worker` are each 'up' (the real handler answers), 'down' (the request throws a network error
 * with a code), 'hang' (never answers until the request is cancelled) or a function (init) => Response. `calls` records who was asked, in order.
 */
function setup({vercel = 'up', worker = 'up', backup = WORKER, extra = {}} = {}) {
  const vercelWorld = createVercelWorld(), workerWorld = createWorkerWorld();
  const timers = fakeTimers(), logs = [], calls = [];
  const mode = {vercel, worker};
  const handlers = {
    vercel: async init => {
      const response = mockResponse();
      await vercelWorld.handler({method: init.method, headers: {...init.headers, 'x-vercel-forwarded-for': '203.0.113.7'}, body: init.body}, response);
      return new Response(response.text, {status: response.statusCode});
    },
    worker: init => workerWorld.handle(new Request(WORKER, {method: init.method, headers: {...init.headers, 'cf-connecting-ip': '203.0.113.7'}, body: init.body}), workerWorld.env),
  };
  const fetchImpl = async (url, init) => {
    const side = String(url).startsWith('https://vercel') ? 'vercel' : 'worker';
    const record = {side, signal: init.signal, cancelled: false};
    calls.push(record);
    init.signal?.addEventListener('abort', () => { record.cancelled = true; });
    const how = mode[side];
    if (how === 'down') throw networkError(side === 'vercel' ? 'ENOTFOUND' : 'ECONNRESET');
    if (how === 'hang') return new Promise((resolve, reject) => init.signal?.addEventListener('abort', () => reject(Object.assign(Error('aborted'), {name: 'AbortError'}))));
    if (typeof how === 'function') return how(init);
    return handlers[side](init);
  };
  const now = () => vercelWorld.clock.now;
  const tokens = new TokenSource({url: VERCEL, backupUrl: backup, secret: SIGNING_SECRET, installId: INSTALL, version: '0.2', fetchImpl, now,
    setTimer: timers.setTimer, clearTimer: timers.clearTimer, random: () => 0.5, log: message => logs.push(message), ...extra});
  return {tokens, timers, logs, calls, mode, vercelWorld, workerWorld, advance(ms) { vercelWorld.advance(ms); workerWorld.advance(ms); }};
}
const sides = world => world.calls.map(call => call.side);

test('the Vercel backend works: one request, and the Worker is never asked', async () => {
  const world = setup();
  world.tokens.start();
  await flush();
  assert.equal(world.tokens.lastKind, 'ok');
  assert.deepEqual(sides(world), ['vercel']);
  assert.equal(world.workerWorld.convai.state.mints, 0);
  assert.equal(world.timers.live.length, 1, 'no stagger timer is left running');
  assert.equal(world.tokens.snapshot().backup.usingBackup, false);
});

test('Vercel cannot be reached: the Worker is asked at once and its token is used, and the Worker is asked first from then on', async () => {
  const world = setup({vercel: 'down'});
  world.tokens.start();
  await flush();
  assert.equal(world.tokens.lastKind, 'ok');
  assert.ok(world.tokens.current());
  assert.deepEqual(sides(world), ['vercel', 'worker']);
  assert.equal(world.workerWorld.convai.state.mints, 1);
  assert.ok(world.logs.some(line => /worker\.example\.invalid is answering; asked first/.test(line)));
  assert.equal(world.tokens.snapshot().backup.usingBackup, true);

  // the renewal asks the Worker first, and Vercel is not asked at all while the Worker answers
  world.advance(52 * MINUTE);
  await world.timers.fire();
  assert.deepEqual(sides(world), ['vercel', 'worker', 'worker']);
  assert.equal(world.tokens.lastKind, 'ok');
});

test('the remembered backend failing sends the request to the other, and that one is remembered in turn', async () => {
  const world = setup({vercel: 'down'});
  world.tokens.start();
  await flush();
  world.mode.worker = 'down';
  world.mode.vercel = 'up';
  world.advance(52 * MINUTE);
  await world.timers.fire();
  assert.deepEqual(sides(world), ['vercel', 'worker', 'worker', 'vercel']);
  assert.equal(world.tokens.lastKind, 'ok');
  assert.equal(world.tokens.snapshot().backup.usingBackup, false);
  world.advance(52 * MINUTE);
  await world.timers.fire();
  assert.deepEqual(sides(world).slice(4), ['vercel']);
});

test('a backend that stays silent does not cost a full timeout: after the stagger the other is asked as well, the first answer wins and the other request is cancelled', async () => {
  const world = setup({vercel: 'hang'});
  world.tokens.start();
  await flush();
  assert.deepEqual(sides(world), ['vercel']);
  assert.equal(world.timers.live[0].delay, STAGGER_MS);
  assert.equal(world.tokens.lastKind, undefined, 'still waiting');
  await world.timers.fire();
  assert.deepEqual(sides(world), ['vercel', 'worker']);
  assert.equal(world.tokens.lastKind, 'ok');
  assert.equal(world.calls[0].cancelled, true, 'the silent request is cancelled');
  assert.equal(world.calls[1].cancelled, true, 'the signal is also used to end the finished race');
  assert.ok(world.tokens.current());
});

test('both silent: one request each, the first one\'s cause is reported (and the other\'s beside it), and the retry schedule is the ordinary one', async () => {
  const world = setup({vercel: 'down', worker: 'down'});
  world.tokens.start();
  await flush();
  assert.deepEqual(sides(world), ['vercel', 'worker']);
  assert.equal(world.tokens.lastKind, 'unreachable');
  assert.equal(world.tokens.current(), null);
  assert.equal(world.tokens.snapshot().lastCause, 'ENOTFOUND');
  assert.equal(world.tokens.snapshot().backup.lastCause, 'ECONNRESET');
  assert.equal(world.tokens.unavailableError().authCause, 'ENOTFOUND');
  assert.match(world.logs.join('\n'), /could not be reached \(ENOTFOUND; backup: ECONNRESET\); retrying/);
  assert.equal(world.timers.live[0].delay, 5_000);
  // the next scheduled attempt is again one request per backend
  await world.timers.fire();
  assert.deepEqual(sides(world), ['vercel', 'worker', 'vercel', 'worker']);
  assert.equal(world.timers.live[0].delay, 15_000);
});

test('an answer is obeyed, never taken to the other backend: refusals, rate limits, the daily allowance, paused, outdated, stale', async () => {
  for (const [status, body, kind] of [[429, {error: 'daily', resetAt: '2026-10-15T00:00:00.000Z'}, 'daily'], [429, {error: 'rate', retryAfterSeconds: 60}, 'rate'],
    [403, {error: 'refused'}, 'refused'], [426, {error: 'outdated', minClient: '0.3'}, 'outdated'], [503, {error: 'paused'}, 'paused'], [503, {error: 'busy'}, 'busy'],
    [400, {error: 'bad_request'}, 'rejected'], [401, {error: 'unauthorized'}, 'unauthorized']]) {
    const world = setup({vercel: async () => Response.json(body, {status})});
    world.tokens.start();
    await flush();
    assert.equal(world.tokens.lastKind, kind, JSON.stringify(body));
    assert.deepEqual(sides(world), ['vercel'], `${JSON.stringify(body)}: the Worker is not asked`);
  }
});

test('a server error, an empty answer or a block page counts as no answer: the Worker is asked', async () => {
  for (const answer of [() => Response.json({error: 'unavailable'}, {status: 503}), () => Response.json({error: 'convai_unavailable'}, {status: 502}),
    () => new Response('<html>blocked by your provider</html>', {status: 403}), () => new Response('', {status: 502}), () => new Response('not json', {status: 200}),
    () => Response.json({nothing: true}, {status: 200}), () => new Response('Rate limit', {status: 429})]) {
    const world = setup({vercel: async () => answer()});
    world.tokens.start();
    await flush();
    assert.equal(world.tokens.lastKind, 'ok');
    assert.deepEqual(sides(world), ['vercel', 'worker']);
  }
});

test('a refusal from the second backend is obeyed too (and the first one\'s silence is not held against it)', async () => {
  const world = setup({vercel: 'down', worker: async () => Response.json({error: 'daily', resetAt: '2026-10-15T00:00:00.000Z', dailyInteractionLimit: 100}, {status: 429})});
  world.tokens.start();
  await flush();
  assert.equal(world.tokens.lastKind, 'daily');
  assert.throws(() => world.tokens.assertAllowed(), /daily/);
  assert.equal(world.tokens.snapshot().backup.usingBackup, true);
});

test('with a slow first backend that answers before the stagger, the second is never asked', async () => {
  let release;
  const world = setup({vercel: init => new Promise(resolve => { release = () => resolve(world.vercelHandler(init)); })});
  world.vercelHandler = async init => {
    const response = mockResponse();
    await world.vercelWorld.handler({method: init.method, headers: {...init.headers, 'x-vercel-forwarded-for': '203.0.113.7'}, body: init.body}, response);
    return new Response(response.text, {status: response.statusCode});
  };
  world.tokens.start();
  await flush();
  assert.deepEqual(sides(world), ['vercel']);
  release();
  await flush();
  assert.equal(world.tokens.lastKind, 'ok');
  assert.deepEqual(sides(world), ['vercel']);
  assert.equal(world.timers.live.every(timer => timer.delay !== STAGGER_MS), true, 'the stagger timer was cleared');
});

test('the token from either backend is the bridge\'s token: the turn path is unchanged, and a turn waits four seconds at most with both silent', async () => {
  const world = setup({vercel: 'hang', worker: 'hang'});
  world.tokens.start();
  const ready = world.tokens.ready({timeoutMs: 4000});
  await flush();
  const waitTimer = world.timers.timers.find(timer => timer.live && timer.delay === 4000);
  assert.ok(waitTimer, 'ready() waits at most four seconds');
  waitTimer.live = false; waitTimer.callback();
  assert.equal(await ready, false);
  assert.equal(world.tokens.current(), null);
});

test('the Worker\'s answers are readable by the bridge: allowance, limit and server time come through', async () => {
  const world = setup({vercel: 'down'});
  world.tokens.noteTurn(); world.tokens.noteTurn();
  world.tokens.start();
  await flush();
  assert.equal(world.tokens.lastKind, 'ok');
  assert.deepEqual(world.tokens.allowance, {used: 2, limit: 100});
  assert.equal(world.tokens.dailyLimit, 100);
  assert.equal(world.tokens.pending, 0, 'the turns were reported to the backend that answered');
});

test('request budget: an attempt makes at most one request per backend, and a turn-started retry follows the same rule', async () => {
  const world = setup({vercel: 'down', worker: 'down'});
  world.tokens.start();
  await flush();
  assert.equal(world.calls.length, 2);
  world.advance(4_000); // the failure is old enough for a turn to retry at once
  world.tokens.kick();
  await flush();
  assert.equal(world.calls.length, 4);
  assert.equal(world.calls.filter(call => call.side === 'worker').length, 2);
  // three failed attempts started by turns in a row stop the turn retries, whatever the number of backends
  for (let turn = 0; turn < 5; turn++) { world.advance(4_000); world.tokens.kick(); await flush(); }
  assert.ok(world.calls.length <= 2 + 2 * 3 + 0, `${world.calls.length} requests`);
});

test('no backupUrl, or a backupUrl equal to the first, is the single-backend behaviour: exactly one request and no stagger timer', async () => {
  for (const backup of ['', VERCEL, 'http://insecure.example/x', 'not a url']) {
    const world = setup({vercel: 'down', backup});
    world.tokens.start();
    await flush();
    assert.deepEqual(sides(world), ['vercel']);
    assert.equal(world.tokens.snapshot().backup, null);
    assert.equal(world.timers.live.length, 1);
    assert.equal(world.timers.live[0].delay, 5_000);
  }
});

test('cleanBackupUrl keeps https and local addresses that differ from the first, and nothing else', () => {
  assert.equal(cleanBackupUrl(WORKER, VERCEL), WORKER);
  assert.equal(cleanBackupUrl(` ${WORKER} `, VERCEL), WORKER);
  assert.equal(cleanBackupUrl('http://127.0.0.1:8787/api/convai/token', VERCEL), 'http://127.0.0.1:8787/api/convai/token');
  for (const bad of ['', undefined, null, 5, 'http://worker.example/x', 'ftp://worker.example/x', 'https://user:pass@worker.example/x', 'nope', VERCEL]) assert.equal(cleanBackupUrl(bad, VERCEL), '', String(bad));
});

test('backupUrl is read like the first address: the environment, then the state folder\'s file, then the release\'s file', async () => {
  const files = {state: JSON.stringify({url: 'https://state.example/api/convai/token', backupUrl: 'https://state-backup.example/api/convai/token', secret: 's'.repeat(40)}),
    packaged: JSON.stringify({version: 1, enabled: true, url: 'https://package.example/api/convai/token', backupUrl: WORKER, secret: 'p'.repeat(40), fallback: false}),
    same: JSON.stringify({version: 1, enabled: true, url: WORKER, backupUrl: WORKER, secret: 'p'.repeat(40)}),
    bad: JSON.stringify({version: 1, enabled: true, url: VERCEL, backupUrl: 'http://insecure.example/x', secret: 'p'.repeat(40)})};
  const readText = async path => { if (!(path in files)) throw Object.assign(Error('missing'), {code: 'ENOENT'}); return files[path]; };
  assert.equal((await readAuthSettings({env: {}, readText, packagedPath: 'packaged'})).backupUrl, WORKER);
  assert.equal((await readAuthSettings({env: {}, readText, path: 'state', packagedPath: 'packaged'})).backupUrl, 'https://state-backup.example/api/convai/token');
  assert.equal((await readAuthSettings({env: {CYBERPUNK_CONVAI_AUTH_BACKUP_URL: 'https://env-backup.example/api/convai/token'}, readText, path: 'state', packagedPath: 'packaged'})).backupUrl, 'https://env-backup.example/api/convai/token');
  assert.equal((await readAuthSettings({env: {}, readText, packagedPath: 'same'})).backupUrl, '');
  assert.equal((await readAuthSettings({env: {}, readText, packagedPath: 'bad'})).backupUrl, '');
  assert.equal((await readAuthSettings({env: {}, readText, packagedPath: 'packaged', usePackaged: false})).enabled, false);
  // readBackendAddress (the error reports' address) knows the state folder's and the environment's backup, never the package's
  const address = await readBackendAddress({env: {}, readText, path: 'state'});
  assert.equal(address.backupUrl, 'https://state-backup.example/api/convai/token');
  assert.equal((await readBackendAddress({env: {CYBERPUNK_CONVAI_AUTH_BACKUP_URL: WORKER, CYBERPUNK_CONVAI_AUTH_URL: VERCEL, CYBERPUNK_CONVAI_AUTH_SECRET: 's'.repeat(32)}, readText})).backupUrl, WORKER);
});
