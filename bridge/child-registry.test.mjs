// A bridge that dies hard leaves llama-server running with the card's memory; the next bridge (and the supervisor, right after the exit) stops it, and only it
// (bridge/child-registry.mjs). Offline: temporary folders, fake process lookups. Nothing real is ever stopped here.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChildRegistry, CHILDREN_FILE, reapChildren, imageOf, START_TOLERANCE_MS} from './child-registry.mjs';
import {LlamaProcess} from './local-llm-server.mjs';

const EXE = 'C:\\Games\\Cyberpunk 2077\\AI NPC Runtime\\llama-server.exe';
function folder() { const dir = mkdtempSync(join(tmpdir(), 'children-test-')); return {dir, file: join(dir, CHILDREN_FILE), done: () => rmSync(dir, {recursive: true, force: true})}; }
const children = file => JSON.parse(readFileSync(file, 'utf8')).children;

test('a child is written down when it starts and removed when it exits; the file is gone when nothing is left', () => {
  const {file, done} = folder();
  try {
    let clock = 1000;
    const registry = new ChildRegistry({file, bridgePid: 4242, now: () => clock});
    assert.equal(registry.add({pid: 111, exe: EXE, label: 'llama-server'}), true);
    clock = 2000; registry.add({pid: 222, exe: EXE, label: 'embedding llama-server'});
    assert.deepEqual(children(file), [{pid: 111, exe: EXE, label: 'llama-server', startedAt: 1000, bridgePid: 4242},
      {pid: 222, exe: EXE, label: 'embedding llama-server', startedAt: 2000, bridgePid: 4242}]);
    registry.add({pid: 111, exe: EXE, label: 'llama-server'});
    assert.equal(children(file).filter(entry => entry.pid === 111).length, 1, 'one entry per pid');
    registry.remove(111); registry.remove(999);
    assert.deepEqual(children(file).map(entry => entry.pid), [222]);
    registry.remove(222);
    assert.equal(existsSync(file), false);
    assert.equal(registry.add({pid: -1, exe: EXE}), false); assert.equal(registry.add({pid: 5}), false);
  } finally { done(); }
});

test('an orphan of a bridge that is gone is stopped when it is exactly the exe and the start that were written down, and its exit is confirmed', async () => {
  const {file, done} = folder();
  try {
    new ChildRegistry({file, bridgePid: 4242, now: () => 50_000}).add({pid: 777, exe: EXE, label: 'llama-server'});
    const running = new Set([777]);
    const killed = [], logs = [];
    const results = await reapChildren({file, log: line => logs.push(line),
      alive: pid => running.has(pid),
      image: async pid => ({path: EXE.toUpperCase().replace(/\\/g, '/'), startMs: 50_000 - 2000}),   // same exe by another spelling, started 2 s before the record
      kill: pid => { killed.push(pid); setTimeout(() => running.delete(pid), 30); },
      wait: ms => new Promise(resolveWait => setTimeout(resolveWait, 10))});
    assert.deepEqual(killed, [777]);
    assert.deepEqual(results.map(result => result.outcome), ['stopped']);
    assert.equal(running.has(777), false, 'the exit was waited for');
    assert.match(logs.join('\n'), /llama-server \(PID 777\) was left running by a bridge that ended without cleaning up: stopped, exit confirmed/);
    assert.equal(existsSync(file), false, 'the entry is gone');
  } finally { done(); }
});

test('nothing else is ever stopped: a live owner, a pid that is not running, another program that got the pid, the same exe started long before, an unreadable process', async () => {
  const {file, done} = folder();
  try {
    const at = 100_000;
    const write = children => writeFileSync(file, JSON.stringify({version: 1, children}));
    const entry = (pid, extra = {}) => ({pid, exe: EXE, label: 'llama-server', startedAt: at, bridgePid: 4242, ...extra});
    const killed = [];
    const base = {file, kill: pid => killed.push(pid), wait: async () => {}, log: () => {}};
    // The bridge that owns the child is alive (a second bridge on the same folder): its child is not an orphan.
    write([entry(1)]);
    assert.deepEqual((await reapChildren({...base, alive: pid => pid === 4242 || pid === 1, image: async () => ({path: EXE, startMs: at}) })).map(r => r.outcome), ['owner-running']);
    assert.equal(children(file).length, 1, 'the live owner\'s entry stays in the file');
    // The pid is not running any more.
    write([entry(2)]);
    assert.deepEqual((await reapChildren({...base, alive: () => false})).map(r => r.outcome), ['gone']);
    assert.equal(existsSync(file), false);
    // Running, but another program now: a different image.
    write([entry(3)]);
    assert.deepEqual((await reapChildren({...base, alive: pid => pid === 3, image: async () => ({path: 'C:\\Windows\\System32\\notepad.exe', startMs: at})})).map(r => r.outcome), ['foreign']);
    // The same exe path but started long before the record (another copy of it, or an older run): not ours.
    write([entry(4)]);
    assert.deepEqual((await reapChildren({...base, alive: pid => pid === 4, image: async () => ({path: EXE, startMs: at - START_TOLERANCE_MS - 1})})).map(r => r.outcome), ['foreign']);
    // A process whose image cannot be read is not stopped on a guess.
    write([entry(5)]);
    assert.deepEqual((await reapChildren({...base, alive: pid => pid === 5, image: async () => null})).map(r => r.outcome), ['unreadable']);
    write([entry(6)]);
    assert.deepEqual((await reapChildren({...base, alive: pid => pid === 6, image: async () => { throw Error('powershell failed'); }})).map(r => r.outcome), ['unreadable']);
    assert.deepEqual(killed, [], 'not one process was stopped');
  } finally { done(); }
});

test('an orphan that does not exit stays on the list for the next look; a missing or corrupt file is nothing to do', async () => {
  const {file, dir, done} = folder();
  try {
    new ChildRegistry({file, bridgePid: 1, now: () => 10}).add({pid: 31, exe: EXE, label: 'llama-server'});
    const results = await reapChildren({file, alive: pid => pid === 31, image: async () => ({path: EXE, startMs: 10}), kill: () => {}, wait: async () => {}, confirmMs: 400, log: () => {}});
    assert.deepEqual(results.map(r => r.outcome), ['still-running']);
    assert.deepEqual(children(file).map(entry => entry.pid), [31]);
    assert.deepEqual(await reapChildren({file: join(dir, 'missing.json')}), []);
    writeFileSync(file, '{not json');
    assert.deepEqual(await reapChildren({file}), []);
  } finally { done(); }
});

test('imageOf asks for one pid through PowerShell on Windows only and reads the path and the start time from its two lines', async () => {
  const seen = [];
  const runner = async (command, args) => { seen.push([command, args.join(' ')]); return `${EXE}\r\n1760000000123\r\n`; };
  assert.deepEqual(await imageOf(321, {runner, platform: 'win32'}), {path: EXE, startMs: 1760000000123});
  assert.match(seen[0][1], /Get-Process -Id 321 /);
  assert.equal(await imageOf(321, {runner, platform: 'linux'}), null);
  assert.equal(await imageOf('321; calc', {runner, platform: 'win32'}), null, 'only a number is ever put into the command');
  assert.equal(await imageOf(321, {runner: async () => '', platform: 'win32'}), null, 'no such process');
  assert.equal(await imageOf(321, {runner: async () => null, platform: 'win32'}), null, 'a failed run');
});

test('LlamaProcess writes its child down at spawn and takes it off the list when it exits or is stopped', async () => {
  const added = [], removed = [];
  const registry = {add: entry => added.push(entry), remove: pid => removed.push(pid)};
  const {EventEmitter} = await import('node:events');
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = 5150; child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.kill = () => { setTimeout(() => child.emit('exit', 0, null), 5); return true; };
    return child;
  };
  const proc = new LlamaProcess({command: EXE, buildArgs: () => [], spawnImpl, registry, platform: 'linux', tmpDir: tmpdir(), lowerPriority: false, startupMs: 2000, pollMs: 10, label: 'llama-server',
    fetchImpl: async () => ({status: 200, arrayBuffer: async () => new ArrayBuffer(0)}), findPort: async () => 45678});
  await proc.start();
  assert.deepEqual(added, [{pid: 5150, exe: EXE, label: 'llama-server'}]);
  assert.deepEqual(removed, []);
  await proc.stop();
  assert.deepEqual(removed, [5150]);
});

test('the bridge and the supervisor use the registry: reap at start, record what is spawned, reap right after an unexpected exit', () => {
  const read = name => readFileSync(new URL(`./${name}`, import.meta.url), 'utf8').split('\r\n').join('\n');
  const bridge = read('convai-bridge.mjs'), supervisor = read('bridge-supervisor.mjs');
  assert.ok(bridge.includes('await reapChildren({file: childrenFile'), 'the bridge reaps before its servers start');
  assert.ok(bridge.indexOf('await reapChildren(') < bridge.indexOf('const localServer = new LocalLlmServer('));
  assert.ok(bridge.includes('processOptions: {registry: childRegistry}'));
  assert.equal((bridge.match(/registry: childRegistry/g) ?? []).length, 2, 'the chat server and the embedder');
  assert.ok(supervisor.includes('reapChildren({file: resolve(this.stateDirectory, CHILDREN_FILE)'));
});
