// Error reports with a second backend (the Cloudflare Worker, auth-backend-cf/): a report the first server does not answer goes to the second.
// The Worker side is the real Worker code over in-memory Durable Objects; the first server is a stand-in that is down, errors or answers.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readQueue, recordErrorEvent} from './error-events.mjs';
import {ErrorReporter, reportTarget} from './error-reports.mjs';
import {SIGNING_SECRET} from '../auth-backend/testkit/harness.mjs';
import {createWorld as createWorkerWorld, asAdmin} from '../auth-backend-cf/testkit/world.mjs';

const INSTALL = '3f2a9c1e-7b44-4d0e-9a52-0c1d2e3f4a5b';
const START = Date.UTC(2026, 9, 14, 10, 0, 0); // the Worker world's clock starts here too
const MAIN = 'https://main.example.invalid/api/errors/report';
const BACKUP = 'https://worker.example.invalid/api/errors/report';
const event = (message, kind = 'turn-failed') => ({kind, message, frame: 'realtime-client.mjs:120 connect'});

async function folders() {
  const base = await mkdtemp(join(tmpdir(), 'error-reports-backup-'));
  const game = join(base, 'game'), modRoot = join(game, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', 'AiNpcCyberpunkMod');
  const runtime = join(modRoot, 'runtime'), state = join(base, 'state'), project = join(base, 'app');
  for (const folder of [runtime, state, project]) await mkdir(folder, {recursive: true});
  await writeFile(join(state, 'convai-install.json'), JSON.stringify({version: 1, installId: INSTALL}));
  await writeFile(join(runtime, 'settings.json'), JSON.stringify({errorReportsNoticed: true}));
  return {base, game, modRoot, runtime, state, project, cleanup: () => rm(base, {recursive: true, force: true})};
}

/** The reporter wired to a main server behaving as `main` ('down', 'hang' is not needed here, or a function (init) => Response) and the real Worker. */
function setup(f, {main = 'down', target = {url: MAIN, backupUrl: BACKUP, secret: SIGNING_SECRET}} = {}) {
  // No separate report secret on the Worker: the one signing secret signs reports, as the target's secret says.
  const worker = createWorkerWorld({ERROR_REPORT_SECRET: ''});
  const calls = [];
  const behaviour = {main};
  const fetchImpl = async (url, init) => {
    const side = String(url).startsWith('https://main') ? 'main' : 'worker';
    calls.push({side, url: String(url)});
    if (side === 'main') {
      if (behaviour.main === 'down') throw Object.assign(TypeError('fetch failed'), {cause: Object.assign(Error('x'), {code: 'ENOTFOUND'})});
      return behaviour.main(init);
    }
    return worker.handle(new Request(url, {method: init.method, headers: {...init.headers, 'cf-connecting-ip': '203.0.113.9'}, body: init.body}), worker.env);
  };
  const clock = {now: START};
  const logs = [];
  const reporter = new ErrorReporter({game: f.game, runtime: f.runtime, modRoot: f.modRoot, stateDirectory: f.state, project: f.project, env: {},
    fetchImpl, now: () => clock.now, graphics: () => [{name: 'Fake GPU 9000', memoryMiB: 8192}], names: ['PlantedPlayerName'], target, log: line => logs.push(line),
    setTimer: () => null, clearTimer: () => {}, setRepeat: () => null, clearRepeat: () => {}});
  return {reporter, worker, calls, behaviour, clock, logs,
    sides: () => calls.map(call => call.side),
    async stored() { return (await worker.call('/api/admin/errors', {headers: asAdmin})).json; }};
}
const answer = (status, body) => async () => Response.json(body, {status});

test('the first server cannot be reached: the report goes to the Worker in the same flush, nothing counts as a failure, and the Worker is asked first next time', async () => {
  const f = await folders();
  try {
    const world = setup(f);
    await recordErrorEvent(f.state, event('first fault'), {now: START});
    await world.reporter.flush();
    assert.deepEqual(world.sides(), ['main', 'worker']);
    assert.equal(world.reporter.failures, 0);
    assert.equal(world.reporter.stopped, null);
    assert.equal((await readQueue(f.state, {now: START})).length, 0, 'sent, so removed from the queue');
    const listing = await world.stored();
    assert.equal(listing.total, 1);
    assert.equal(listing.signatures[0].kind, 'turn-failed');
    assert.equal(listing.signatures[0].stored, 1);
    assert.ok(world.logs.some(line => /backup backend answers; reports go there first/.test(line)));

    await recordErrorEvent(f.state, event('second, different fault', 'bridge-exception'), {now: START});
    await world.reporter.flush();
    assert.deepEqual(world.sides().slice(2), ['worker'], 'the Worker answered last, so it is asked first');
    assert.equal((await world.stored()).total, 2);

  } finally { await f.cleanup(); }
});

test('a server error, a block page or an empty answer from the first server also goes to the Worker', async () => {
  for (const main of [answer(503, {error: 'unavailable'}), answer(502, {error: 'convai_unavailable'}), async () => new Response('<html>blocked</html>', {status: 403}),
    async () => new Response('', {status: 404}), async () => new Response('', {status: 502}), async () => new Response('Slow down', {status: 429})]) {
    const f = await folders();
    try {
      const world = setup(f, {main});
      await recordErrorEvent(f.state, event('a fault'), {now: START});
      await world.reporter.flush();
      assert.deepEqual(world.sides(), ['main', 'worker']);
      assert.equal(world.reporter.stopped, null);
      assert.equal((await world.stored()).total, 1);
    } finally { await f.cleanup(); }
  }
});

test('an answer from the first server is obeyed: a refusal, a rate limit or a missing endpoint is not taken to the Worker', async () => {
  for (const [main, stopped] of [[answer(429, {error: 'rate', retryAfterSeconds: 60}), 'rate'], [answer(404, {error: 'not_found'}), 'not-found'],
    [answer(401, {error: 'unauthorized'}), 'unauthorized']]) {
    const f = await folders();
    try {
      const world = setup(f, {main});
      await recordErrorEvent(f.state, event('a fault'), {now: START});
      await world.reporter.flush();
      assert.deepEqual(world.sides(), ['main']);
      assert.equal(world.reporter.stopped, stopped);
      assert.equal((await world.stored()).total, 0);
    } finally { await f.cleanup(); }
  }
  // a bad request is dropped, not retried elsewhere
  const f = await folders();
  try {
    const world = setup(f, {main: answer(400, {error: 'bad_request'})});
    await recordErrorEvent(f.state, event('a fault'), {now: START});
    await world.reporter.flush();
    assert.deepEqual(world.sides(), ['main']);
    assert.equal((await readQueue(f.state, {now: START})).length, 0);
  } finally { await f.cleanup(); }
});

test('both servers failing is one failure: the report stays queued, a retry waits 15 minutes, and three such flushes stop the session', async () => {
  const f = await folders();
  try {
    const world = setup(f);
    world.reporter.fetchImpl = async () => { throw new TypeError('fetch failed'); };
    await recordErrorEvent(f.state, event('a fault'), {now: START});
    await world.reporter.flush();
    assert.equal(world.reporter.failures, 1);
    assert.equal(world.reporter.stopped, null);
    assert.equal((await readQueue(f.state, {now: START})).length, 1);
    await world.reporter.flush();
    assert.equal(world.reporter.failures, 1, 'not before the 15 minutes are over');
    for (let round = 0; round < 2; round++) { world.clock.now += 16 * 60_000; await world.reporter.flush(); }
    assert.equal(world.reporter.failures, 3);
    assert.equal(world.reporter.stopped, 'unreachable');
  } finally { await f.cleanup(); }
});

test('with no backup in the target a failure is the old behaviour: one request, one failure', async () => {
  const f = await folders();
  try {
    const world = setup(f, {target: {url: MAIN, secret: SIGNING_SECRET}});
    await recordErrorEvent(f.state, event('a fault'), {now: START});
    await world.reporter.flush();
    assert.deepEqual(world.sides(), ['main']);
    assert.equal(world.reporter.failures, 1);
  } finally { await f.cleanup(); }
});

test('the Worker takes the same signed report (same secret) and a clock that is off is corrected against it', async () => {
  const f = await folders();
  try {
    const world = setup(f);
    world.clock.now = START + 10 * 60_000; // the bridge's clock runs ahead of the server's by ten minutes
    await recordErrorEvent(f.state, event('a fault'), {now: world.clock.now});
    await world.reporter.flush();
    // main is down, the Worker answers 401 stale with its time: the reporter takes the offset and signs again
    assert.equal(world.reporter.stopped, null);
    assert.equal((await readQueue(f.state, {now: world.clock.now})).length, 0);
    assert.equal((await world.stored()).total, 1);
  } finally { await f.cleanup(); }
});

test('reportTarget: backupUrl from the release\'s error-reports.json, or from the data folder\'s sign-in file; an explicit address has no backup', async () => {
  const f = await folders();
  try {
    await mkdir(join(f.project, 'defaults'), {recursive: true});
    await writeFile(join(f.project, 'defaults', 'error-reports.json'), JSON.stringify({version: 1, url: 'https://shipped.example/anything', backupUrl: 'https://worker.example.invalid/whatever', secret: SIGNING_SECRET}));
    assert.deepEqual(await reportTarget({env: {}, stateDirectory: f.state, project: f.project}),
      {url: 'https://shipped.example/api/errors/report', secret: SIGNING_SECRET, backupUrl: BACKUP});
    // an http, damaged or identical backup is dropped
    for (const backupUrl of ['http://worker.example/x', 'nope', 'https://shipped.example/other', 5]) {
      await writeFile(join(f.project, 'defaults', 'error-reports.json'), JSON.stringify({version: 1, url: 'https://shipped.example/anything', backupUrl, secret: SIGNING_SECRET}));
      assert.deepEqual(await reportTarget({env: {}, stateDirectory: f.state, project: f.project}), {url: 'https://shipped.example/api/errors/report', secret: SIGNING_SECRET}, String(backupUrl));
    }
    // the data folder's sign-in file wins, with its own backup
    await writeFile(join(f.state, 'convai-auth.json'), JSON.stringify({enabled: false, url: 'https://dev.example/api/convai/token', backupUrl: 'https://dev-worker.example/api/convai/token', secret: SIGNING_SECRET}));
    assert.deepEqual(await reportTarget({env: {}, stateDirectory: f.state, project: f.project}),
      {url: 'https://dev.example/api/errors/report', secret: SIGNING_SECRET, backupUrl: 'https://dev-worker.example/api/errors/report'});
    const explicit = await reportTarget({env: {CYBERPUNK_CONVAI_ERRORS_URL: 'https://other.example/e'}, stateDirectory: f.state, project: f.project});
    assert.equal(explicit.url, 'https://other.example/e');
    assert.equal(explicit.backupUrl, undefined);
  } finally { await f.cleanup(); }
});
