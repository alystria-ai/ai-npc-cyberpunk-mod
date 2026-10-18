// A simulated machine for the conversation service supervisor (bridge/bridge-supervisor.mjs), for tests that need the
// supervisor's real run loop, real status files and the real DEFAULT_TIMINGS without waiting for them:
//   - the clock moves only when a test says so (world.advance); the supervisor's sleeps just yield;
//   - bridges are fake children that the test makes ready, crash or ignore a stop; they obey the same PID-addressed
//     shutdown request that scripts/Stop-ConversationBridge.ps1 and the supervisor write to bridge-control.json;
//   - the game is a lifeline stream (world.endGame) or, with gamePid, a PID the test keeps alive.
// Everything else is real: the lock file, the log files, the ready-line scan, bridge-service.json and local-voice-state.json.
import {EventEmitter} from 'node:events';
import {appendFileSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, realpath, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, dirname, join} from 'node:path';
import {PassThrough} from 'node:stream';
import {setTimeout as realDelay} from 'node:timers/promises';
import assert from 'node:assert/strict';
import {BridgeSupervisor, MOD_RUNTIME, READY_MARKER} from './bridge-supervisor.mjs';

export const WORLD_PREFIX = 'cyberpunk-supervisor-world-';
export const FAKE_KEY = 'api-key=fixture-key-not-a-credential';
export const GAME_PID = 7777;

export class FakeBridge extends EventEmitter {
  constructor(world, pid, behavior) {
    super();
    Object.assign(this, {world, pid, behavior, exited: false, stdout: null, stderr: null});
  }
  exit(code = 1, signal = null) {
    if (this.exited) return;
    this.exited = true; this.world.alive.delete(this.pid);
    this.emit('exit', code, signal); this.emit('close', code, signal);
  }
  kill() { this.exit(null, 'SIGTERM'); }
}

// What each launched bridge does is taken from world.script (one entry per launch, the first not yet used), then from
// world.defaults: {ready: true} prints the ready line at once; {ready: false} never prints it; {obeys: false} ignores a
// shutdown request. A test ends a bridge itself with child.exit(code).
export async function createWorld(t, {key = true, ids = true, entry = true, gamePid = null, lifeline = true} = {}) {
  const root = await mkdtemp(join(tmpdir(), WORLD_PREFIX));
  const project = join(root, 'project'), state = join(root, 'state'), game = join(root, 'game');
  const runtime = join(game, ...MOD_RUNTIME.split('/'));
  await Promise.all([mkdir(join(project, 'bridge'), {recursive: true}), mkdir(state, {recursive: true}), mkdir(runtime, {recursive: true})]);
  if (entry) await writeFile(join(project, 'bridge/convai-bridge.mjs'), '// the bridge entry the fake spawn stands in for\n');
  if (key) await writeFile(join(state, 'convai-key.txt'), FAKE_KEY + '\n');
  if (ids) await writeFile(join(state, 'characters.json'), '{"judy-alvarez":"fixture-id"}');
  const world = {
    root, project, state, game, runtime,
    statusPath: join(runtime, 'bridge-service.json'), voicePath: join(runtime, 'local-voice-state.json'),
    controlPath: join(state, 'bridge-control.json'), keyPath: join(state, 'convai-key.txt'),
    logPath: join(state, 'bridge-service.log'), stdoutPath: join(state, 'bridge.stdout.log'),
    clock: Date.UTC(2026, 9, 19, 12, 0, 0), alive: new Set(gamePid ? [gamePid] : []), nextPid: 40_000,
    script: [], controlWrites: [], lastControlRead: 0, defaults: {ready: true, obeys: true}, spawned: [], kills: [], browser: true, history: [], turns: 0,
    supervisor: null, done: null, result: undefined, finished: false, lifeline: null,
    advance(ms) { world.clock += ms; },
    spawn(command, args, options) {
      if (world.spawnFault) return world.spawnFault(command, args, options);
      const behavior = {...world.defaults, ...world.script.shift()};
      const child = new FakeBridge(world, world.nextPid++, behavior);
      world.alive.add(child.pid);
      if (behavior.ready) appendFileSync(world.stdoutPath, `${READY_MARKER}\n`);
      world.spawned.push({command, args, options, child});
      return child;
    },
    isAlive: pid => world.alive.has(pid),
    async killTree(pid) { world.kills.push(pid); world.spawned.find(item => item.child.pid === pid)?.child.exit(1); },
    // One round of the world between two supervisor steps: bridges obey a stop addressed to them. The control file is looked
    // at only every 25 ms: on Windows a rename over a file that someone has open fails, and the supervisor renames over this one.
    async tick() {
      world.turns++;
      if (Date.now() - world.lastControlRead < 25) return;
      world.lastControlRead = Date.now();
      const raw = await readFile(world.controlPath, 'utf8').catch(() => '');
      if (raw && raw !== world.controlWrites.at(-1)) world.controlWrites.push(raw);
      let command = null; try { command = JSON.parse(raw); } catch {}
      for (const {child} of world.spawned) {
        if (child.exited) continue;
        if (command?.action === 'shutdown' && command.pid === child.pid && child.behavior.obeys) child.exit(0);
      }
    },
    // Called after every status write has landed, so the history holds every state the supervisor published.
    async record() {
      const status = await world.status();
      const last = world.history.at(-1);
      if (status && (!last || last.state !== status.state || last.code !== status.code || last.restarts !== status.restarts
          || last.bridgePid !== status.bridgePid || last.adopted !== status.adopted)) world.history.push(status);
    },
    async status() { return readFile(world.statusPath, 'utf8').then(JSON.parse).catch(() => null); },
    async turn(count = 3) { const target = world.turns + count; while (world.turns < target && !world.finished) await realDelay(1); },
    async until(read, accepts, label, timeout = 8000) {
      const deadline = Date.now() + timeout;
      let last;
      while (Date.now() < deadline) {
        last = await read();
        if (accepts(last)) return last;
        await realDelay(20);
      }
      const tail = (await world.logText()).split('\n').slice(-12).join('\n');
      assert.fail(`${label}; last=${JSON.stringify(last)}\nservice log:\n${tail}`);
    },
    untilStatus(accepts, label, timeout) { return world.until(world.status, value => value && accepts(value), label, timeout); },
    untilSpawned(count, label = `fewer than ${count} bridges were started`) {
      return world.until(async () => world.spawned.length, length => length >= count, label);
    },
    logText: () => readFile(world.logPath, 'utf8').catch(() => ''),
    async writeVoice({pid, state = 'ready', age = 0}) {
      await writeFile(world.voicePath, JSON.stringify({version: 1, state, bridgePid: pid, updated: world.clock - age}));
    },
    // The same PID-addressed request scripts/Stop-ConversationBridge.ps1 writes.
    async stopRequest(pid, nonce = 'developer-stop') { await writeFile(world.controlPath, JSON.stringify({action: 'shutdown', pid, nonce})); },
    supervise(options = {}) {
      world.lifeline = lifeline && !gamePid ? new PassThrough() : null;
      const supervisor = new BridgeSupervisor({project, stateDirectory: state, keyFile: world.keyPath, gameRoot: game,
        lifeline: world.lifeline, gamePid, now: () => world.clock, spawn: world.spawn, alive: world.isAlive,
        killTree: world.killTree, browserAvailable: () => world.browser,
        sleep: async () => { await world.tick(); await realDelay(1); }, ...options});
      world.supervisor = supervisor;
      const write = supervisor.writeStatus.bind(supervisor);
      supervisor.writeStatus = () => { const landed = write(); landed.then(() => world.record()); return landed; };
      world.done = supervisor.run().then(value => { world.result = value; return value; }).finally(async () => { world.finished = true; await world.record(); });
      return supervisor;
    },
    endGame() { if (gamePid) world.alive.delete(gamePid); else world.lifeline?.end(); },
    // The run, to its end: the game has gone, so the supervisor drains the bridge it holds.
    async finish() { world.endGame(); world.advance(1000); return world.done; },
  };
  t.after(async () => {
    if (world.supervisor && !world.finished) {
      world.supervisor.requestExit('test-cleanup');
      for (let round = 0; round < 400 && !world.finished; round++) { world.advance(60_000); await realDelay(5); }
    }
    for (const {child} of world.spawned) child.exit(0);
    const target = await realpath(root), base = await realpath(tmpdir());
    assert.equal(dirname(target).toLowerCase(), base.toLowerCase());
    assert(basename(target).startsWith(WORLD_PREFIX));
    await rm(target, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
  });
  return world;
}
