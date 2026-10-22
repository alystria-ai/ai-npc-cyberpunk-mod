// The logging and report machinery must not cost FPS, latency or stability: logs are size-capped, a lasting failure logs once per cause, and a
// failing write (full disk, locked file) never reaches the caller. Temp folders only.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appendFileSync, closeSync, openSync, statSync, writeSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {causeOf, repeatLimiter} from './repeat-log.mjs';
import {capLogFile} from './log-cap.mjs';
import {DEFAULT_TIMINGS} from './bridge-supervisor.mjs';
import {ErrorReporter} from './error-reports.mjs';
import {QUEUE_MAX, queueDirectory, readQueue, recordErrorEvent, sentPath} from './error-events.mjs';
import {createWorld} from './supervisor-world.mjs';

const folder = async () => mkdtemp(join(tmpdir(), 'logging-limits-'));

// ------------------------------------------------------------------ one line per cause

test('a poll that keeps failing logs once, then once a minute with the count, and a different cause logs at once', () => {
  const lines = [];
  let at = 1_000_000;
  const log = repeatLimiter({write: line => lines.push(line), now: () => at});
  for (let tick = 0; tick < 2000; tick++) { log('[Bridge] Settings poll:', new Error('EBUSY: resource busy or locked, rename \'a-1.tmp\'')); at += 150; }
  assert.equal(lines.length, 5, '300 s of a failure every 150 ms is a line per minute, not 2000 lines');
  assert.equal(lines[0], '[Bridge] Settings poll: EBUSY: resource busy or locked, rename \'a-1.tmp\'');
  assert.match(lines[1], /\(399 more of the same were not logged\)$/);
  log('[Bridge] Settings poll:', new Error('EPERM: operation not permitted'));
  log('[Bridge] Phone poll:', new Error('EBUSY: resource busy or locked, rename \'a-1.tmp\''));
  assert.equal(lines.length, 7, 'another message and another poll each log at once');
});

test('the same fault with other numbers, ids and temp names is one cause; the table cannot grow without bound; a failing sink never throws', () => {
  assert.equal(causeOf('open \'x-3f2a9c1e-7b44-4d0e-9a52-0c1d2e3f4a5b.tmp\' failed at 120'), causeOf('open \'x-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.tmp\' failed at 7'));
  const lines = [];
  const log = repeatLimiter({write: line => lines.push(line), maxCauses: 4, now: () => 0});
  for (let index = 0; index < 100; index++) log('x', `distinct cause number ${'abcdefghij'[index % 10].repeat(index % 7 + 1)}${'zyxwvutsrq'[index % 10]}`);
  assert.ok(lines.length >= 10, 'new causes are written');
  assert.doesNotThrow(() => repeatLimiter({write: () => { throw new Error('stderr is gone'); }})('a', 'b'));
  assert.doesNotThrow(() => repeatLimiter({write: () => {}})('a', null));
});

test('every poll of the bridge logs through the limiter; none writes a line per tick', async () => {
  const bridge = await readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /const pollLog = repeatLimiter\(\{write: line => console\.error\(line\)\}\)/);
  for (const label of ['Microphone poll', 'Preparation poll', 'Look-ahead poll', 'Settings poll', 'Phone poll', 'Knowledge poll', 'Memory control', 'Support report', 'Setup check', 'Paid tier', 'Character editor', 'Input poll']) {
    assert.match(bridge, new RegExp(`pollLog\\('\\[CyberpunkConvai\\] ${label}:', error\\)`), label);
    // (the one start-up run of the setup check logs once, with its own message)
    if (label !== 'Setup check') assert.doesNotMatch(bridge, new RegExp(`console\\.error\\('\\[CyberpunkConvai\\] ${label}:'`), `${label} still logs every failure`);
  }
});

// ------------------------------------------------------------------ size caps

test('a log over its cap is cut back to its last whole lines in place; under the cap nothing changes; a writer that appends carries on', async () => {
  const dir = await folder();
  try {
    const path = join(dir, 'bridge.stderr.log');
    const lines = Array.from({length: 400}, (_, index) => `line ${String(index).padStart(4, '0')} ${'x'.repeat(40)}`);
    await writeFile(path, `${lines.join('\n')}\n`);
    const before = statSync(path).size;
    assert.equal(capLogFile(path, {maxBytes: before + 1, keepBytes: 1000}), false);
    assert.equal(statSync(path).size, before);
    // The bridge holds the file open for appending, as the supervisor opened it for the child.
    const writer = openSync(path, 'a');
    assert.equal(capLogFile(path, {maxBytes: 5000, keepBytes: 1000}), true);
    writeSync(writer, 'after the cut\n');
    closeSync(writer);
    const text = await readFile(path, 'utf8');
    assert.ok(text.length <= 1100, `${text.length} bytes kept`);
    assert.ok(text.startsWith('line 03'), 'it starts at a whole line near the end');
    assert.ok(text.includes('line 0399') && text.endsWith('after the cut\n'));
    assert.equal(capLogFile(join(dir, 'missing.log'), {maxBytes: 10}), false, 'a file that is not there is not an error');
    assert.equal(capLogFile(dir, {maxBytes: 10}), false, 'a folder in its place is not an error');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('the supervisor cuts the bridge\'s stdout and stderr logs and its own log back during a session, and keeps serving', async t => {
  const w = await createWorld(t);
  w.supervise({timings: {logCheckMs: 1000, bridgeLogMaxBytes: 4000, bridgeLogKeepBytes: 1500, logLimitBytes: 3000}});
  await w.untilSpawned(1);
  await w.untilStatus(status => status.state === 'ready', 'the bridge did not become ready');
  const stderrPath = join(w.state, 'bridge.stderr.log');
  const big = Array.from({length: 200}, (_, index) => `${index} ${'y'.repeat(60)}\n`).join('');
  appendFileSync(stderrPath, big); appendFileSync(w.stdoutPath, big); appendFileSync(w.logPath, big);
  w.advance(2000);
  await w.until(async () => [statSync(stderrPath).size, statSync(w.stdoutPath).size, statSync(w.logPath).size], sizes => sizes[0] <= 1600 && sizes[1] <= 1600 && sizes[2] <= 2000, 'the logs were not cut back');
  assert.match(await readFile(stderrPath, 'utf8'), /^\d+ y{60}\n/, 'a whole line starts the kept part');
  assert.equal((await w.status()).state, 'ready');
});

test('the caps are the documented ones, and a status file that cannot be written is said once, not every five seconds', async t => {
  assert.equal(DEFAULT_TIMINGS.bridgeLogMaxBytes, 6_000_000);
  assert.equal(DEFAULT_TIMINGS.bridgeLogKeepBytes, 3_000_000);
  assert.equal(DEFAULT_TIMINGS.logCheckMs, 300_000);
  const w = await createWorld(t);
  w.supervise();
  await w.untilStatus(status => status.state === 'ready', 'the bridge did not become ready');
  // A folder where the status file goes: every replacement fails, the way a locked file does.
  await rm(w.statusPath, {force: true});
  await mkdir(w.statusPath, {recursive: true});
  for (let beat = 0; beat < 5; beat++) { w.advance(6000); await w.supervisor.writeStatus().catch(() => {}); }
  const said = (await w.logText()).split('\n').filter(line => /could not be published/.test(line));
  assert.equal(said.length, 1, said.join('\n'));
});

// ------------------------------------------------------------------ the report queue

test('a half-written queue file is removed once an hour old, a fresh one is left, and the queue stays bounded', async () => {
  const dir = await folder();
  try {
    const queue = queueDirectory(dir);
    await mkdir(queue, {recursive: true});
    const old = join(queue, 'abcdefabcdefabcd.json.123.456.tmp'), fresh = join(queue, '0123456789abcdef.json.123.789.tmp');
    await writeFile(old, '{'); await writeFile(fresh, '{');
    const longAgo = new Date(Date.now() - 3 * 3600_000);
    await utimes(old, longAgo, longAgo);
    await readQueue(dir);
    assert.deepEqual((await readdir(queue)).sort(), ['0123456789abcdef.json.123.789.tmp']);
    for (let index = 0; index < 40; index++) await recordErrorEvent(dir, {kind: 'turn-failed', message: `distinct failure ${'abcdefghijklmnopqrstuvwxyz'[index % 26]}${'qrstuvwxyz'[index % 10]}${index % 3 ? 'm' : 'n'} x${'ab'.repeat(index)}`});
    assert.ok((await readdir(queue)).filter(name => name.endsWith('.json')).length <= QUEUE_MAX, 'the waiting reports stay bounded by QUEUE_MAX');
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('a full disk or a locked state file never reaches the caller of the reporter, leaves no temp file and does not make it retry in a loop', async () => {
  const dir = await folder();
  try {
    const state = join(dir, 'state'), runtime = join(dir, 'runtime');
    await mkdir(runtime, {recursive: true});
    // sent.json is a folder: every save of it fails the way a locked file does.
    await mkdir(sentPath(state), {recursive: true});
    let fetches = 0;
    const reporter = new ErrorReporter({game: dir, runtime, modRoot: dir, stateDirectory: state, project: dir, env: {}, now: () => Date.UTC(2026, 9, 20, 10), graphics: () => [],
      fetchImpl: async () => { fetches++; return new Response('{}', {status: 503}); }, target: {url: 'https://backend.invalid/api/errors/report', secret: 's'.repeat(24)},
      setTimer: () => null, clearTimer: () => {}, setRepeat: () => null, clearRepeat: () => {}});
    await recordErrorEvent(state, {kind: 'turn-failed', message: 'convai: timed out', frame: 'a.mjs:1 run'}, {now: Date.UTC(2026, 9, 20, 10)});
    await assert.doesNotReject(reporter.flush());
    await assert.doesNotReject(reporter.look({flush: true}));
    assert.ok(fetches <= 1, 'a failed send waits 15 minutes: nothing is retried at once');
    assert.deepEqual((await readdir(join(state, 'error-reports'))).filter(name => name.endsWith('.tmp')), []);
    reporter.close();
  } finally { await rm(dir, {recursive: true, force: true}); }
});

test('after the game cut probe.log back, the old sessions\' Lua errors in what is left are not reported again; this session\'s are', async () => {
  const {luaErrorsIn} = await import('./error-reports.mjs');
  const lines = ['2026-10-01T10:00:00Z Thing failed: init.lua:150: attempt to index a nil value', '2026-10-20T09:59:30Z Thing failed: init.lua:151: attempt to call a nil value',
    '2026-10-20T10:05:00Z Thing failed: init.lua:152: attempt to compare number with nil', 'no stamp: other.lua:3: attempt to index a nil value'];
  const since = Date.UTC(2026, 9, 20, 10, 0, 0) - 60_000;
  assert.equal(luaErrorsIn(lines, {since: 0}).length, 4);
  assert.deepEqual(luaErrorsIn(lines, {since}).map(item => item.frame), ['init.lua:151', 'init.lua:152', 'other.lua:3']);
});

test('the OmniVoice worker starts with only the pydub "no ffmpeg" warning silenced, so it no longer fills the report logs', async () => {
  const source = await readFile(new URL('./resident-voice.mjs', import.meta.url), 'utf8');
  assert.match(source, /PYTHONWARNINGS: 'ignore::RuntimeWarning:pydub\.utils'/);
});

test('the latency record is written at most one running and one waiting write at a time', async () => {
  const bridge = await readFile(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /metricsNext \?\?= metricsWriting\.catch\(\(\) => \{\}\)\.then\(\(\) => \{\s*metricsNext = null;/);
  assert.match(bridge, /metricsWriting = metricsNext;\s*return metricsNext;/);
});
