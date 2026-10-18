// A real bridge process in a disposable world, for tests that need to watch the startup order and the settings poll (the entry
// bridge/convai-bridge.mjs is a script, not a module). Test-only: nothing here is used by the mod.
//
//   const bridge = await launchBridge({settings: {audioDelay: 150}, runtimeFiles: {'microphone-command.json': ''}});
//   await bridge.ready();                         // the 'Convai conversation bridge ready' line
//   await bridge.until(() => bridge.read('audio-delay.json'), value => value?.delayMs === 150, 'delay applied');
//   await bridge.stop();                          // shutdown through bridge-control.json, the way the supervisor ends it
//
// Isolation: the state folder, the game folder (so runtime/), the temp folder and the Local AI folder all live in one temp directory. A
// guard module is imported before the bridge and refuses every outward effect (child processes, sockets, listening, fetch); each refusal is
// logged and `bridge.forbidden()` returns the log (a test asserts it is empty). The single exception is a FAKE `llama-server` the test names:
// `--list-devices` on it answers with one graphics card, and the spawn that would load a model is recorded (`bridge.llama()`) and then refused,
// so no model is ever loaded. The probe of the free port the real supervisor makes before the spawn is allowed on loopback only.
import {spawn} from 'node:child_process';
import {mkdtemp, mkdir, readFile, writeFile, rm, realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {atomicFile} from './guarded-file.mjs';

export const BRIDGE_ENTRY = fileURLToPath(new URL('./convai-bridge.mjs', import.meta.url));
const prefix = 'cyberpunk-bridge-run-';

const GUARD = `
import {appendFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {resolve} from 'node:path';
import child from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
const log = process.env.CYBERPUNK_TEST_SIDE_EFFECTS, llamaLog = process.env.CYBERPUNK_TEST_LLAMA_LOG;
const fake = process.env.CYBERPUNK_TEST_FAKE_LLAMA ? resolve(process.env.CYBERPUNK_TEST_FAKE_LLAMA).toLowerCase() : '';
const isFake = command => fake !== '' && typeof command === 'string' && resolve(command).toLowerCase() === fake;
const forbidden = kind => function() {
  appendFileSync(log, kind + '\\n');
  throw Error('Forbidden side effect in isolated bridge test: ' + kind);
};
for (const method of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) child[method] = forbidden(method);
child.execFile = function(command, args, options, callback) {
  const done = typeof options === 'function' ? options : callback;
  if (command === 'nvidia-smi') {
    // The designed probe of the card's size (once a minute, with two or more models installed): recorded, and answered as "no such tool".
    appendFileSync(llamaLog, JSON.stringify({event: 'nvidia-smi', args}) + '\\n');
    setImmediate(() => done(Object.assign(Error('spawn nvidia-smi ENOENT'), {code: 'ENOENT'}), '', ''));
    return {kill() {}};
  }
  if (!isFake(command)) return forbidden('execFile')();
  appendFileSync(llamaLog, JSON.stringify({event: 'list-devices', args}) + '\\n');
  setImmediate(() => done(null, process.env.CYBERPUNK_TEST_DEVICES || 'Available devices:\\n  Vulkan0: AMD Radeon Test Card (8000 MiB, 7000 MiB free)\\n', ''));
  return {kill() {}};
};
child.spawn = function(command, args) {
  if (!isFake(command)) return forbidden('spawn ' + String(command))();
  appendFileSync(llamaLog, JSON.stringify({event: 'spawn', args: (args || []).map(String)}) + '\\n');
  throw Error('the fake llama-server never starts');
};
http.request = forbidden('http.request'); http.get = forbidden('http.get');
https.request = forbidden('https.request'); https.get = forbidden('https.get');
net.Socket.prototype.connect = forbidden('socket.connect');
const listen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...args) {
  // Only the supervisor's probe for a free loopback port (it closes at once).
  if (args[1] === '127.0.0.1' && args[0] === 0) return listen.apply(this, args);
  return forbidden('server.listen')();
};
tls.connect = forbidden('tls.connect'); dgram.createSocket = forbidden('dgram.createSocket');
// The address is part of the log line: a test that expects the one warm-up request of a cloud provider can tell it from any other host.
globalThis.fetch = function(url) { return forbidden('fetch ' + (typeof url === 'string' ? url : url?.url ?? String(url)))(); };
globalThis.WebSocket = forbidden('WebSocket');
syncBuiltinESMExports();
`;

export const readJsonFile = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; } };

/** Polls `read` until `accepts` likes the value; on timeout the failure carries the last value and `context()` (the bridge's logs). */
export async function until(read, accepts, label, context = () => '', timeout = 10000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accepts(last)) return last;
    await sleep(60);
  }
  assert.fail(`${label}; last=${JSON.stringify(last)}\n${context()}`);
}

/**
 * Starts the bridge. Options:
 *   settings      runtime/settings.json: an object (written as JSON), a string (written as it is, '' is an empty file) or undefined (no file)
 *   runtimeFiles  {name: text} written into runtime/ before the start (an exchange placeholder is ''), and stateFiles {name: text} into the state folder
 *   localAi       {name: text} files written under <folder>/local-ai (the pack folder the bridge is pointed at); omitted: a folder that does not exist
 *   fakeLlama     path inside the pack folder of the server the guard may answer for (default none: every spawn is refused)
 *   env           more environment variables (a function value is called with the world's folder: `{NAME: folder => join(folder, 'x')}`)
 */
export async function launchBridge({settings, runtimeFiles = {}, stateFiles = {}, localAi = null, fakeLlama = null, env = {}} = {}) {
  const folder = await mkdtemp(join(tmpdir(), prefix));
  const state = join(folder, 'state'), game = join(folder, 'game'), temp = join(folder, 'tmp'), pack = join(folder, 'local-ai');
  const runtime = join(game, 'bin', 'x64', 'plugins', 'cyber_engine_tweaks', 'mods', 'AiNpcCyberpunkMod', 'runtime');
  const forbiddenLog = join(folder, 'forbidden-side-effects.log'), llamaLog = join(folder, 'llama-events.log'), guardFile = join(folder, 'guard.mjs');
  const control = join(state, 'bridge-control.json');
  let child = null, closed = null, output = '', errors = '';
  const context = () => `exit=${JSON.stringify(closed)}\nstdout=${output}\nstderr=${errors}`;
  const lines = async path => (await readFile(path, 'utf8').catch(() => '')).split(/\r?\n/).filter(Boolean);
  const write = async (name, text) => { await mkdir(dirname(join(runtime, name)), {recursive: true}); await writeFile(join(runtime, name), text); };
  const bridge = {
    folder, state, game, runtime, pack, context,
    get child() { return child; }, get closed() { return closed; },
    output: () => output, errors: () => errors,
    read: name => readJsonFile(join(runtime, name)),
    readText: name => readFile(join(runtime, name), 'utf8').catch(() => null),
    readState: name => readJsonFile(join(state, name)),
    // In place, like the game's Lua: the file is opened for writing (empty for an instant) and then filled.
    write, writeSettings: value => write('settings.json', typeof value === 'string' ? value : JSON.stringify(value)),
    remove: name => rm(join(runtime, name), {force: true}),
    // bridge-control.json in the state folder, where the supervisor writes its PID-addressed commands (a string is written as it is).
    writeControl: value => writeFile(control, typeof value === 'string' ? value : JSON.stringify(value)),
    // The pack folder changes while the bridge runs (a download unpacked, a model deleted by hand).
    installPack: async files => { for (const [name, text] of Object.entries(files)) { await mkdir(dirname(join(pack, name)), {recursive: true}); await writeFile(join(pack, name), text); } },
    removeFromPack: name => rm(join(pack, name), {force: true}),
    forbidden: () => lines(forbiddenLog),
    llama: async () => (await lines(llamaLog)).map(line => JSON.parse(line)),
    until: (read, accepts, label, timeout) => until(read, accepts, label, context, timeout),
    async ready(timeout = 30000) {
      return until(() => { assert.equal(closed, null, `the bridge exited during startup\n${context()}`); return output; },
        value => /Convai conversation bridge ready/.test(value), 'the bridge did not become ready', context, timeout);
    },
    /** Waits for `ms` of the bridge's own polling (the settings poll runs every 500 ms) and checks it is still alive. */
    async idle(ms) { await sleep(ms); assert.equal(closed, null, context()); },
    async shutdown(timeout = 10000) {
      await atomicFile(control, JSON.stringify({action: 'shutdown', pid: child.pid}));
      return until(async () => closed, value => value !== null, 'the shutdown control did not end the bridge', context, timeout);
    },
    async cleanup() {
      if (child && closed === null) {
        await atomicFile(control, JSON.stringify({action: 'shutdown', pid: child.pid})).catch(() => {});
        const deadline = Date.now() + 3000;
        while (closed === null && Date.now() < deadline) await sleep(50);
        if (closed === null) {
          child.kill();
          await until(async () => closed, value => value !== null, 'the owned test child did not exit', context, 3000);
        }
      }
      // Resolve and verify the exact disposable root before the recursive removal.
      const resolved = await realpath(folder);
      assert.equal(dirname(resolved).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
      assert.ok(basename(resolved).startsWith(prefix));
      await rm(resolved, {recursive: true, force: true});
    },
  };
  try {
    await Promise.all([mkdir(state, {recursive: true}), mkdir(runtime, {recursive: true}), mkdir(temp, {recursive: true})]);
    await Promise.all([
      writeFile(join(state, 'convai-key.txt'), 'api-key=isolated-test-key-not-a-real-credential\n'),
      writeFile(join(state, 'characters.json'), '{}'),
      writeFile(join(state, 'local-voices.json'), '{}'),
      writeFile(guardFile, GUARD),
      ...Object.entries(stateFiles).map(([name, text]) => writeFile(join(state, name), text)),
      ...Object.entries(runtimeFiles).map(([name, text]) => write(name, text)),
      ...Object.entries(localAi ?? {}).map(async ([name, text]) => { await mkdir(dirname(join(pack, name)), {recursive: true}); await writeFile(join(pack, name), text); }),
    ]);
    if (settings !== undefined) await bridge.writeSettings(settings);
    const environment = {...process.env, CYBERPUNK_CONVAI_STATE: state, CYBERPUNK_CONVAI_GAME: game,
      CYBERPUNK_CONVAI_KEY_FILE: join(state, 'convai-key.txt'), CYBERPUNK_TEST_SIDE_EFFECTS: forbiddenLog, CYBERPUNK_TEST_LLAMA_LOG: llamaLog,
      TEMP: temp, TMP: temp, TMPDIR: temp,
      ...Object.fromEntries(Object.entries(env).map(([name, value]) => [name, typeof value === 'function' ? value(folder) : value]))};
    delete environment.NODE_OPTIONS; delete environment.NODE_PATH;
    // The bridge reads the Local AI pack from <repo>/local-ai, a git-ignored link a developer fills with real models: point it at this world's
    // folder (an empty or missing one is a machine with no pack) and drop any developer override, so no test depends on the machine's models.
    for (const name of Object.keys(environment)) if (/^CYBERPUNK_CONVAI_LOCAL_/.test(name)) delete environment[name];
    environment.CYBERPUNK_CONVAI_LOCAL_AI = pack;
    if (fakeLlama) environment.CYBERPUNK_TEST_FAKE_LLAMA = join(pack, fakeLlama);
    child = spawn(process.execPath, ['--import', pathToFileURL(guardFile).href, BRIDGE_ENTRY], {
      cwd: folder, env: environment, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', data => { output = (output + data).slice(-20000); });
    child.stderr.on('data', data => { errors = (errors + data).slice(-40000); });
    child.on('error', error => { errors += error.message; });
    child.once('close', (code, signal) => { closed = {code, signal}; });
    return bridge;
  } catch (error) { await bridge.cleanup().catch(() => {}); throw error; }
}

/** A Local AI folder holding only a Mature pack: the marker that names the server and one model, and the two files (no standard or lite model). */
export function matureOnlyPack({model = 'Test-Uncensored-2B'} = {}) {
  return {
    'manifest.mature-lite.json': JSON.stringify({version: 1, pack: 'mature', server: 'llama/llama-server.exe',
      lite: {file: 'models/mature-lite.gguf', name: model, family: 'qwen'}}),
    'llama/llama-server.exe': 'fake server',
    'models/mature-lite.gguf': 'not a real model',
  };
}
