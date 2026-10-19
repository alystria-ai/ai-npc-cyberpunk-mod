import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {LlamaEmbedder, buildEmbedArgs, clipText, normalize} from './local-embed.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/fake-llama-server.mjs', import.meta.url));
const isAlive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exited = child => (child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit'));
const norm = vector => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

function harness(t, {env = {}, withEmbed = true, ...options} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'local-embed-test-'));
  const write = name => { const path = join(directory, name); writeFileSync(path, name); return path; };
  const pack = {installed: true, missing: [], root: directory, server: write('llama-server.exe'), tiers: {standard: null, lite: null},
    embed: withEmbed ? {file: write('embed.gguf'), dim: 8, id: 'fake-embed'} : null, dev: false};
  const tmpDir = join(directory, 'tmp');
  mkdirSync(tmpDir);
  const calls = [];
  const spawnImpl = (command, args, spawnOptions) => { const child = spawn(command, args, spawnOptions); calls.push({args, child}); return child; };
  const embedder = new LlamaEmbedder({pack, command: process.execPath, argsPrefix: [FAKE], spawnImpl, startupMs: 180_000,
    processOptions: {env, tmpDir, pollMs: 20}, ...options});
  t.after(async () => {
    await embedder.close();
    for (const {child} of calls) if (child.exitCode === null) child.kill();
    rmSync(directory, {recursive: true, force: true});
  });
  return {embedder, pack, calls, tmpDir};
}

test('buildEmbedArgs: CPU only, one thread, key in a file', () => {
  const args = buildEmbedArgs({model: 'E.gguf', port: 5000, keyFile: 'K', threads: 1});
  assert.deepEqual(args.slice(0, 15), ['-m', 'E.gguf', '--embedding', '--device', 'none', '-ngl', '0', '-t', '1', '-tb', '1', '-c', '2048', '-b', '2048']);
  assert.ok(args.includes('--no-webui'));
  assert.equal(args[args.indexOf('--api-key-file') + 1], 'K');
  assert.ok(!args.includes('--api-key'));
});

test('available() follows the embedding model file; id and dim come from the pack', t => {
  const {embedder, pack} = harness(t);
  assert.equal(embedder.available(), true);
  assert.equal(embedder.id, 'fake-embed');
  assert.equal(embedder.dim, 8);
  const missing = new LlamaEmbedder({pack, exists: path => path !== pack.embed.file});
  assert.equal(missing.available(), false);
  const serverMissing = new LlamaEmbedder({pack, exists: path => path !== pack.server});
  assert.equal(serverMissing.available(), false);
  const none = harness(t, {withEmbed: false}).embedder;
  assert.equal(none.available(), false);
  assert.equal(none.id, null);
});

test('embed returns L2-normalised Float32Array vectors in input order and starts the CPU server on demand', async t => {
  const {embedder, calls, tmpDir} = harness(t);
  assert.equal(calls.length, 0);
  const vectors = await embedder.embed(['hello world', 'second text', 'hello world']);
  assert.equal(calls.length, 1);
  assert.equal(vectors.length, 3);
  for (const vector of vectors) {
    assert.ok(vector instanceof Float32Array);
    assert.equal(vector.length, 8);
    assert.ok(Math.abs(norm(vector) - 1) < 1e-5);
  }
  assert.deepEqual([...vectors[0]], [...vectors[2]]);
  assert.notDeepEqual([...vectors[0]], [...vectors[1]]);
  // CPU, one thread, key file (not the command line); the key folder is gone once healthy.
  const args = calls[0].args.join(' ');
  assert.match(args, /--embedding --device none -ngl 0 -t 1 -tb 1/);
  assert.match(args, /--api-key-file/);
  assert.deepEqual(readdirSync(tmpDir), []);
  assert.deepEqual(await embedder.embed([]), []);
  // The second call reuses the running server.
  await embedder.embed('one string is fine too');
  assert.equal(calls.length, 1);
});

test('long texts are cut and big batches are split', async t => {
  const bodies = [];
  const {embedder} = harness(t, {fetchImpl: (url, init) => { if (init?.body) bodies.push(JSON.parse(init.body)); return fetch(url, init); }});
  assert.equal(clipText('x'.repeat(2000)).length, 1500);
  assert.equal(clipText('short'), 'short');
  assert.equal(clipText('a'.repeat(1499) + '😀b').length, 1499, 'no half emoji');
  await embedder.embed(['y'.repeat(5000)]);
  assert.equal(bodies[0].input[0].length, 1500);
  assert.equal(bodies[0].model, 'e');
  const many = await embedder.embed(Array.from({length: 70}, (_, index) => 'memory ' + index));
  assert.equal(many.length, 70);
  assert.deepEqual(bodies.slice(1).map(body => body.input.length), [32, 32, 6]);
});

test('concurrent calls during start share one process', async t => {
  const {embedder, calls} = harness(t, {env: {FAKE_LLAMA_DELAY_MS: '200'}});
  const results = await Promise.all([embedder.embed(['a']), embedder.embed(['b']), embedder.embed(['c'])]);
  assert.equal(calls.length, 1);
  assert.equal(results.length, 3);
});

test('the server exits idleMs after the last use and restarts on the next call', async t => {
  const timers = [];
  const setTimer = (fn, ms) => { const timer = {fn, ms, cleared: false, fired: false, unref() {}}; timers.push(timer); return timer; };
  const clearTimer = timer => { if (timer) timer.cleared = true; };
  const live = () => timers.filter(timer => timer.ms === 4321 && !timer.cleared && !timer.fired);
  const {embedder, calls} = harness(t, {idleMs: 4321, setTimer, clearTimer});
  await embedder.embed(['hello']);
  assert.equal(live().length, 1);
  const first = calls[0].child;
  assert.equal(isAlive(first.pid), true);
  const timer = live()[0];
  timer.fired = true; timer.fn();
  await exited(first);
  assert.equal(isAlive(first.pid), false);
  const vectors = await embedder.embed(['hello again']);
  assert.equal(calls.length, 2);
  assert.equal(vectors.length, 1);
  assert.equal(live().length, 1);
  // An embed that starts while the timer is pending clears it (not stopped mid-request).
  const pending = live()[0];
  const running = embedder.embed(['x']);
  assert.equal(pending.cleared, true);
  await running;
});

test('close() ends the server, is idempotent, and a later embed starts a new one', async t => {
  const {embedder, calls, tmpDir} = harness(t);
  await embedder.embed(['hello']);
  const child = calls[0].child;
  await embedder.close();
  assert.equal(isAlive(child.pid), false);
  await embedder.close();
  assert.deepEqual(readdirSync(tmpDir), []);
  await embedder.embed(['hello']);
  assert.equal(calls.length, 2);
  embedder.killSync();
  await exited(calls[1].child);
  assert.equal(isAlive(calls[1].child.pid), false);
});

test('failures carry the [local:embed] marker and never the key', async t => {
  const missing = harness(t, {withEmbed: false}).embedder;
  await assert.rejects(missing.embed(['x']), error => /^\[local:embed\]/.test(error.message));

  const never = harness(t, {startupMs: 300, env: {FAKE_LLAMA_NEVER_HEALTHY: '1', FAKE_LLAMA_PRINT_KEY: '1'}});
  await assert.rejects(never.embedder.embed(['x']), error => {
    assert.match(error.message, /^\[local:embed\]/);
    assert.ok(!/[0-9a-f]{64}/.test(error.message));
    return true;
  });
  assert.deepEqual(readdirSync(never.tmpDir), []);

  const exits = harness(t, {env: {FAKE_LLAMA_EXIT_AT_START: '4'}});
  await assert.rejects(exits.embedder.embed(['x']), error => /^\[local:embed\]/.test(error.message));

  // A wrong vector size is refused (the store needs a fixed dimension).
  const wrong = harness(t);
  wrong.pack.embed.dim = 384;
  await assert.rejects(wrong.embedder.embed(['x']), error => /\[local:embed\].*unexpected embedding size 8/.test(error.message));

  // A crash after a request: the next call starts a new server.
  const crash = harness(t, {env: {FAKE_LLAMA_CRASH_AFTER: '1'}});
  await crash.embedder.embed(['one']);
  await exited(crash.calls[0].child);
  await new Promise(resolve => setTimeout(resolve, 20));
  await crash.embedder.embed(['two']);
  assert.equal(crash.calls.length, 2);

  // An aborted call rejects with the abort, not an embed error.
  const controller = new AbortController();
  const slow = harness(t, {env: {FAKE_LLAMA_DELAY_MS: '500'}});
  const pending = slow.embedder.embed(['x'], {signal: controller.signal});
  controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
});

test('normalize handles zero vectors', () => {
  assert.deepEqual([...normalize([0, 0, 0])], [0, 0, 0]);
  const unit = normalize([3, 4]);
  assert.ok(Math.abs(unit[0] - 0.6) < 1e-6 && Math.abs(unit[1] - 0.8) < 1e-6);
});

test('buildEmbedArgs turns the fit pass off (every parameter is given; the pass only loads the model twice)', () => {
  const args = buildEmbedArgs({model: 'E.gguf', port: 5000, keyFile: 'K', threads: 1});
  assert.equal(args[args.indexOf('-fit') + 1], 'off');
});

test('ready() is false until the server runs; warm() starts it in the background without a query', async t => {
  const {embedder, calls} = harness(t);
  assert.equal(embedder.ready(), false);
  const warming = embedder.warm();
  assert.equal(embedder.ready(), false, 'starting is not ready');
  assert.equal(await warming, true);
  assert.equal(embedder.ready(), true);
  assert.equal(calls.length, 1);
  assert.equal(await embedder.warm(), true, 'a running server is not started again');
  assert.equal(calls.length, 1);
  assert.equal((await embedder.embed(['hello']))[0].length, 8);
  assert.equal(calls.length, 1, 'the query used the warmed server');
});

test('warm() does not retry a failed start for retryMs, and never throws', async t => {
  let now = 0;
  const {embedder, calls} = harness(t, {startupMs: 200, retryMs: 60_000, now: () => now, env: {FAKE_LLAMA_NEVER_HEALTHY: '1'}});
  assert.equal(await embedder.warm(), false);
  assert.equal(embedder.ready(), false);
  assert.equal(calls.length, 1);
  now = 59_000;
  assert.equal(await embedder.warm(), false);
  assert.equal(calls.length, 1, 'inside retryMs nothing is spawned');
  now = 61_000;
  assert.equal(await embedder.warm(), false);
  assert.equal(calls.length, 2, 'after retryMs one more start is tried');
});

test('warm() does nothing without the embedding model', async t => {
  const {embedder, calls} = harness(t, {withEmbed: false});
  assert.equal(await embedder.warm(), false);
  assert.equal(calls.length, 0);
});
