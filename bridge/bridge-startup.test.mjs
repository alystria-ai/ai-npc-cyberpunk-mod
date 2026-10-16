import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {PlayerMemory} from './player-memory.mjs';
import {atomicFile} from './guarded-file.mjs';

const bridge = fileURLToPath(new URL('./convai-bridge.mjs', import.meta.url));
const prefix = 'cyberpunk-bridge-startup-';
async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}
async function atomicJson(path, value) {
  return atomicFile(path, JSON.stringify(value));
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

test('real bridge retains one player ID across world changes without provider, browser or archive activity',
  {timeout: 60000}, async () => {
    const folder = await mkdtemp(join(tmpdir(), prefix));
    const state = join(folder, 'state'), game = join(folder, 'game');
    const runtime = join(game, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', 'AiNpcCyberpunkMod', 'runtime');
    const control = join(state, 'bridge-control.json'), memoryPath = join(state, 'player-memory.json');
    const sideEffects = join(folder, 'forbidden-side-effects.log'), guardFile = join(folder, 'guard.mjs');
    let child, closed = null, output = '', errors = '';
    const log = () => `exit=${JSON.stringify(closed)}\nstdout=${output}\nstderr=${errors}`;
    try {
      await mkdir(state, {recursive: true}); await mkdir(runtime, {recursive: true});
      await Promise.all([
        writeFile(join(state, 'convai-key.txt'), 'api-key=isolated-test-key-not-a-real-credential\n'),
        writeFile(join(state, 'characters.json'), '{}'),
        writeFile(join(state, 'local-voices.json'), '{}'),
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
      // Cold imports and durable fixture writes contend with the full test
      // runner. Give startup a bounded budget, while failing an exited child
      // immediately; later protocol transitions retain their shorter deadline.
      await until(() => {
        assert.equal(closed, null, `bridge exited during startup\n${log()}`);
        return readJson(bridgeStatus);
      }, value => value?.state === 'waiting', 'bridge did not reach waiting', log, 30000);
      const initial = await until(() => readJson(knowledgeStatus), value => value?.version === 1,
        'knowledge status was not published', log);
      assert.equal(initial.bound, true); assert.equal(initial.identifiedMemory, true); assert.equal(initial.currentWorld, false);
      assert.equal(initial.memoryMode, 'natural-conversations'); assert.equal(initial.providerIdLimit, 1);
      assert.equal(closed, null, log());
      const lock = await readJson(`${memoryPath}.lock`);
      assert.equal(lock?.pid, child.pid, 'the isolated bridge owns its isolated player-memory lock');
      const identity = await readJson(`${memoryPath}.identity`);
      assert.match(identity?.endUserId ?? '', /^[0-9a-f-]{36}$/);
      const voice = await until(() => readJson(join(runtime, 'local-voice-state.json')),
        value => value?.provider === 'convai', 'Convai-only settings were not applied', log);
      assert.equal(voice.configured, false); assert.equal(voice.bridgePid, child.pid);

      const sessionFile = join(runtime, 'world-session.json');
      async function publishSession(value, expected) {
        const writtenAt = Date.now();
        await atomicJson(sessionFile, {version: 1, updated: writtenAt, ...value});
        const status = await until(() => readJson(knowledgeStatus), result => result?.updated >= writtenAt
          && result.currentWorld === expected, `world heartbeat was not ${expected ? 'accepted' : 'invalidated'}`, log);
        assert.equal(status.bound, true); assert.equal(status.identifiedMemory, true);
        assert.deepEqual(await readJson(`${memoryPath}.identity`), identity);
        assert.equal((await readJson(join(runtime, 'memory-status.json')))?.talkedToCount, 0);
        return status;
      }
      // World boundaries isolate current facts and transient sessions. Their
      // transitions never allocate another player ID or contact a provider.
      await publishSession({token: 'test-local-world-1', generation: 1, ready: true}, true);
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
      assert.equal((await readJson(join(runtime, 'memory-status.json')))?.state, 'unavailable');
      await assert.rejects(readFile(`${memoryPath}.lock`), {code: 'ENOENT'});
      for (const retiredPath of [join(state, 'quest-memory.json'), join(runtime, 'knowledge-binding.json')]) {
        await assert.rejects(readFile(retiredPath), {code: 'ENOENT'});
      }
      const reopened = await PlayerMemory.open({path: memoryPath, characterIds: {}});
      try {
        assert.equal((await readJson(memoryPath)).endUserId, identity.endUserId);
        assert.deepEqual(await readJson(`${memoryPath}.identity`), identity);
        assert.equal(reopened.status().available, true);
        assert.equal(reopened.status().talkedToCount, 0);
        assert.deepEqual(reopened.status().actions, []);
      } finally { await reopened.close(); }
      await assert.rejects(readFile(`${memoryPath}.lock`), {code: 'ENOENT'});
      const forbidden = await readFile(sideEffects, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error));
      assert.equal(forbidden, '', `bridge attempted an external side effect: ${forbidden}`);
      // A status rename can lose a race with another Windows process (scanner, indexer) for longer than
      // the writer's own retries; the next poll succeeds, so a transient sharing error is not a failure.
      const persistent = errors.split(/\r?\n/).filter(line => !/poll: (?:EPERM|EACCES|EBUSY): .*(?:rename|unlink)/.test(line)).join('\n');
      assert.doesNotMatch(persistent, /poll:|Forbidden side effect|Unhandled|uncaught|TypeError|ReferenceError/, log());
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

// The settings file is absent on a first run, and for an instant while the game replaces it (remove, then rename): a poll that reads
// nothing must keep every setting as it was, never throw (the startup poll is a top-level await: a throw ends the process).
test('real bridge starts, polls and stops with no settings file',
  {timeout: 60000}, async () => {
    const folder = await mkdtemp(join(tmpdir(), prefix));
    const state = join(folder, 'state'), game = join(folder, 'game');
    const runtime = join(game, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', 'AiNpcCyberpunkMod', 'runtime');
    const control = join(state, 'bridge-control.json');
    const sideEffects = join(folder, 'forbidden-side-effects.log'), guardFile = join(folder, 'guard.mjs');
    let child, closed = null, output = '', errors = '';
    const log = () => `exit=${JSON.stringify(closed)}\nstdout=${output}\nstderr=${errors}`;
    try {
      await mkdir(state, {recursive: true}); await mkdir(runtime, {recursive: true});
      await Promise.all([
        writeFile(join(state, 'convai-key.txt'), 'api-key=isolated-test-key-not-a-real-credential\n'),
        writeFile(join(state, 'characters.json'), '{}'),
        writeFile(join(state, 'local-voices.json'), '{}'),
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
      await until(() => {
        assert.equal(closed, null, `bridge exited during startup\n${log()}`);
        return output;
      }, value => /Convai conversation bridge ready/.test(value), 'bridge did not become ready', log, 30000);
      await sleep(1200);   // a few settings polls, still no file
      assert.equal(closed, null, log());
      await atomicJson(control, {action: 'shutdown', pid: child.pid});
      await until(async () => closed, value => value !== null, 'shutdown control did not end the bridge', log, 10000);
      assert.deepEqual(closed, {code: 0, signal: null}, log());
      assert.doesNotMatch(errors, /TypeError|ReferenceError|Unhandled|uncaught/, log());
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
      const resolved = await realpath(folder);
      assert.equal(dirname(resolved).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(resolved).startsWith(prefix));
      await rm(resolved, {recursive: true, force: true});
    }
  });
