import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, rename, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {QuestMemoryLedger} from './quest-memory.mjs';

const bridge = fileURLToPath(new URL('./convai-bridge.mjs', import.meta.url));
const prefix = 'cyberpunk-bridge-startup-';
async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}
async function atomicJson(path, value) {
  const pending = `${path}.test-write`;
  await writeFile(pending, JSON.stringify(value)); await rename(pending, path);
}
async function until(read, accepts, label, log, timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accepts(last)) return last;
    await sleep(75);
  }
  assert.fail(`${label}; last=${JSON.stringify(last)}\n${log()}`);
}

// Imports and the real event loop run normally. These traps make an accidental
// provider/browser/voice-worker startup fail locally before creating traffic,
// child processes or GPU work. Their log is itself an assertion below.
const sideEffectGuard = `
import {appendFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import child from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
const forbidden = kind => function() {
  appendFileSync(process.env.CYBERPUNK_TEST_SIDE_EFFECTS, kind + '\\n');
  throw Error('Forbidden side effect in isolated bridge test: ' + kind);
};
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) child[method] = forbidden(method);
http.request = forbidden('http.request'); http.get = forbidden('http.get');
https.request = forbidden('https.request'); https.get = forbidden('https.get');
net.Socket.prototype.connect = forbidden('socket.connect');
net.Server.prototype.listen = forbidden('server.listen');
tls.connect = forbidden('tls.connect'); dgram.createSocket = forbidden('dgram.createSocket');
globalThis.fetch = forbidden('fetch'); globalThis.WebSocket = forbidden('WebSocket');
syncBuiltinESMExports();
`;

test('real bridge starts anonymously in isolated storage, rejects stale worlds and shuts down without a ledger lock',
  {timeout: 40000}, async () => {
    const folder = await mkdtemp(join(tmpdir(), prefix));
    const state = join(folder, 'state'), game = join(folder, 'game');
    const runtime = join(game, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', 'CyberpunkConvai', 'runtime');
    const control = join(state, 'bridge-control.json'), ledgerPath = join(state, 'quest-memory.json');
    const sideEffects = join(folder, 'forbidden-side-effects.log'), guardFile = join(folder, 'guard.mjs');
    let child, closed = null, output = '', errors = '';
    const log = () => `exit=${JSON.stringify(closed)}\nstdout=${output}\nstderr=${errors}`;
    try {
      await mkdir(state, {recursive: true}); await mkdir(runtime, {recursive: true});
      await Promise.all([
        writeFile(join(state, 'convai-key.txt'), 'api-key=isolated-test-key-not-a-real-credential\n'),
        writeFile(join(state, 'characters.json'), '{}'),
        writeFile(join(state, 'local-voices.json'), '{}'),
        writeFile(join(state, 'knowledge-policy.json'), JSON.stringify({version: 1, enabled: false})),
        writeFile(join(runtime, 'settings.json'), JSON.stringify({voiceProvider: 'convai'})),
        writeFile(guardFile, sideEffectGuard),
      ]);
      const env = {...process.env, CYBERPUNK_CONVAI_STATE: state, CYBERPUNK_CONVAI_GAME: game,
        CYBERPUNK_CONVAI_KEY_FILE: join(state, 'convai-key.txt'), CYBERPUNK_TEST_SIDE_EFFECTS: sideEffects};
      delete env.NODE_OPTIONS; delete env.NODE_PATH;
      child = spawn(process.execPath, ['--import', pathToFileURL(guardFile).href, bridge], {
        cwd: folder, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', data => { output = (output + data).slice(-12000); });
      child.stderr.on('data', data => { errors = (errors + data).slice(-12000); });
      child.on('error', error => { errors += error.message; });
      child.once('close', (code, signal) => { closed = {code, signal}; });
      const bridgeStatus = join(runtime, 'bridge-status.json'), knowledgeStatus = join(runtime, 'knowledge-status.json');
      await until(() => readJson(bridgeStatus), value => value?.state === 'waiting', 'bridge did not reach waiting', log);
      const initial = await until(() => readJson(knowledgeStatus), value => value?.version === 1,
        'knowledge status was not published', log);
      assert.equal(initial.bound, false); assert.equal(initial.identifiedMemory, false); assert.equal(initial.currentWorld, false);
      assert.equal(closed, null, log());
      const lock = await readJson(`${ledgerPath}.lock`);
      assert.equal(lock?.pid, child.pid, 'the isolated bridge owns its isolated ledger lock');
      const voice = await until(() => readJson(join(runtime, 'local-voice-state.json')),
        value => value?.provider === 'convai', 'Convai-only settings were not applied', log);
      assert.equal(voice.configured, false); assert.equal(voice.bridgePid, child.pid);

      const sessionFile = join(runtime, 'world-session.json');
      async function publishSession(value, expected) {
        const writtenAt = Date.now();
        await atomicJson(sessionFile, {version: 1, updated: writtenAt, ...value});
        const status = await until(() => readJson(knowledgeStatus), result => result?.updated >= writtenAt
          && result.currentWorld === expected, `world heartbeat was not ${expected ? 'accepted' : 'invalidated'}`, log);
        assert.equal(status.bound, false); assert.equal(status.identifiedMemory, false);
        return status;
      }
      // Local lifecycle tokens can support current dynamic context without
      // claiming persistent identity. No chat requests or character IDs exist.
      await publishSession({token: 'test-local-world-1', generation: 1, ready: true}, true);
      let binding = await readJson(join(runtime, 'knowledge-binding.json'));
      assert.equal(binding?.status, 'unavailable'); assert.equal(binding?.identity?.authoritative, false);
      await publishSession({token: 'test-local-world-1', generation: 1, ready: true, updated: Date.now() - 7000}, false);
      await publishSession({token: 'test-local-world-2', generation: 2, ready: true}, true);
      await publishSession({token: 'test-local-world-2', generation: 2, ready: false}, false);
      assert.equal(closed, null, log());

      // Target only this child; never signal or enumerate the user's game or
      // existing voice/bridge processes.
      await atomicJson(control, {action: 'shutdown', pid: child.pid});
      await until(async () => closed, value => value !== null, 'shutdown control did not end the bridge', log, 10000);
      assert.deepEqual(closed, {code: 0, signal: null}, log());
      assert.equal((await readJson(bridgeStatus))?.state, 'stopped');
      binding = await readJson(join(runtime, 'knowledge-binding.json'));
      assert.equal(binding?.reason, 'closed');
      await assert.rejects(readFile(`${ledgerPath}.lock`), {code: 'ENOENT'});
      const reopened = await QuestMemoryLedger.load({path: ledgerPath});
      try {
        assert.equal(reopened.identity, null, 'anonymous heartbeats did not create a bound save identity');
        assert.equal(reopened.status().bound, false);
        assert.equal(reopened.status().branches, 0);
        assert.equal(reopened.status().episodes, 0);
        assert.deepEqual(reopened.status().outbox, {});
      } finally { await reopened.close(); }
      await assert.rejects(readFile(`${ledgerPath}.lock`), {code: 'ENOENT'});
      const forbidden = await readFile(sideEffects, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
      assert.equal(forbidden, '', `bridge attempted an external side effect: ${forbidden}`);
      assert.doesNotMatch(errors, /poll:|Forbidden side effect|Unhandled|uncaught|TypeError|ReferenceError/, log());
      assert.match(output, /Convai conversation bridge ready/);
    } finally {
      if (child && closed === null) {
        await atomicJson(control, {action: 'shutdown', pid: child.pid}).catch(() => {});
        const deadline = Date.now() + 3000;
        while (closed === null && Date.now() < deadline) await sleep(50);
        if (closed === null) {
          child.kill();
          await until(async () => closed, value => value !== null, 'owned test child did not exit', log, 3000);
        }
      }
      // Resolve and verify the exact disposable root before recursive cleanup.
      const resolved = await realpath(folder);
      assert.equal(dirname(resolved).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(resolved).startsWith(prefix));
      await rm(resolved, {recursive: true, force: true});
    }
  });
