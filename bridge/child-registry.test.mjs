// A bridge that dies hard leaves llama-server running with the card's memory; the next bridge (and the supervisor, right after the exit) stops it, and only it
// (bridge/child-registry.mjs). Offline: temporary folders, fake process lookups. Nothing real is ever stopped here.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ChildRegistry, CHILDREN_FILE, reapChildren, stopIfMatching, pidAlive, START_TOLERANCE_MS, UNREADABLE_KEEP_MS} from './child-registry.mjs';
import {LlamaProcess} from './local-llm-server.mjs';

const reap = options => reapChildren({bootedAt: 0, ...options});
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

test('an orphan of a bridge that is gone is stopped by the one call that checked it, and the record goes only then', async () => {
  const {file, done} = folder();
  try {
    new ChildRegistry({file, bridgePid: 4242, now: () => 50_000}).add({pid: 777, exe: EXE, label: 'llama-server'});
    const running = new Set([777]);
    const asked = [], logs = [];
    const results = await reap({file, log: line => logs.push(line), alive: pid => running.has(pid),
      stop: async (entry, options) => { asked.push([entry.pid, entry.exe, entry.startedAt, options.toleranceMs]); running.delete(entry.pid); return 'stopped'; }});
    assert.deepEqual(asked, [[777, EXE, 50_000, START_TOLERANCE_MS]], 'one call carries the record: pid, exe path, start time and tolerance');
    assert.deepEqual(results.map(result => result.outcome), ['stopped']);
    assert.match(logs.join('\n'), /llama-server \(PID 777\) was left running by a bridge that ended without cleaning up: stopped, exit confirmed/);
    assert.equal(existsSync(file), false, 'the record is gone');
  } finally { done(); }
});

test('nothing else is ever stopped, and a record leaves the file only when its process is stopped, gone or someone else\'s', async () => {
  const {file, done} = folder();
  try {
    const at = 100_000;
    const write = children => writeFileSync(file, JSON.stringify({version: 1, children}));
    const entry = (pid, extra = {}) => ({pid, exe: EXE, label: 'llama-server', startedAt: at, bridgePid: 4242, ...extra});
    const stopped = [];
    const stopWith = outcome => async e => { stopped.push(e.pid); return outcome; };
    // The bridge that owns the child is alive (a second bridge on the same folder): its child is not an orphan, and its record stays.
    write([entry(1)]);
    assert.deepEqual((await reap({file, alive: pid => pid === 4242 || pid === 1, stop: stopWith('stopped')})).map(r => r.outcome), ['owner-running']);
    assert.equal(children(file).length, 1);
    // The pid is not running any more: nothing to stop, the record goes.
    write([entry(2)]);
    assert.deepEqual((await reap({file, alive: () => false, stop: stopWith('stopped')})).map(r => r.outcome), ['gone']);
    assert.equal(existsSync(file), false);
    // Another program has the pid now: left alone, the record goes (it describes nothing of ours).
    write([entry(3)]);
    assert.deepEqual((await reap({file, alive: pid => pid === 3, stop: stopWith('foreign')})).map(r => r.outcome), ['foreign']);
    assert.equal(existsSync(file), false);
    // A look that failed or timed out (a slow PowerShell under a busy game) keeps the record for the next start: this leaked server is the one it exists for.
    write([entry(4)]);
    assert.deepEqual((await reap({file, alive: pid => pid === 4, stop: stopWith('unreadable'), now: () => at + 1000})).map(r => r.outcome), ['unreadable']);
    assert.deepEqual(children(file).map(e => e.pid), [4]);
    write([entry(5)]);
    assert.deepEqual((await reap({file, alive: pid => pid === 5, stop: async () => { throw Error('powershell failed'); }, now: () => at + 1000})).map(r => r.outcome), ['unreadable']);
    assert.deepEqual(children(file).map(e => e.pid), [5]);
    // One that did not exit stays too. One unreadable for days is let go.
    write([entry(6)]);
    await reap({file, alive: pid => pid === 6, stop: stopWith('still-running'), log: () => {}, now: () => at + 1000});
    assert.deepEqual(children(file).map(e => e.pid), [6]);
    write([entry(7, {startedAt: at})]);
    await reap({file, alive: pid => pid === 7, stop: stopWith('unreadable'), now: () => at + UNREADABLE_KEEP_MS + 1});
    assert.equal(existsSync(file), false);
  } finally { done(); }
});

test('a cleanup that runs long never erases the records a newer bridge wrote meanwhile, and the cap ends it', async () => {
  const {file, done} = folder();
  try {
    const old = {pid: 10, exe: EXE, label: 'llama-server', startedAt: 1000, bridgePid: 1};
    const kept = {pid: 11, exe: EXE, label: 'embedding llama-server', startedAt: 1000, bridgePid: 1};
    writeFileSync(file, JSON.stringify({version: 1, children: [old, kept]}));
    const newer = new ChildRegistry({file, bridgePid: 9999, now: () => 5000});
    const results = await reap({file, alive: pid => pid === 10 || pid === 11,
      stop: async entry => {
        if (entry.pid === 10) { newer.add({pid: 12, exe: EXE, label: 'llama-server'}); newer.add({pid: 10, exe: EXE, label: 'llama-server'}); return 'stopped'; }   // the new bridge's own, one with a reused pid
        return 'unreadable';
      }, log: () => {}, now: () => 2000});
    assert.deepEqual(results.map(r => r.outcome), ['stopped', 'unreadable']);
    const left = children(file);
    assert.deepEqual(left.map(e => `${e.pid}:${e.startedAt}`).sort(), ['10:5000', '11:1000', '12:5000'], 'the new bridge\'s records are all still there, even the one with the reused pid');
    // The cap: nothing is started after it, and what was not reached stays.
    writeFileSync(file, JSON.stringify({version: 1, children: [old, kept]}));
    const cap = new AbortController();
    const second = await reap({file, alive: pid => pid === 10 || pid === 11, signal: cap.signal, log: () => {}, stop: async entry => { cap.abort(); return 'stopped'; }});
    assert.deepEqual(second.map(r => r.outcome), ['stopped', 'skipped']);
    assert.deepEqual(children(file).map(e => e.pid), [11]);
  } finally { done(); }
});

test('an orphan that did not exit stays on the list for the next look; a missing or corrupt file is nothing to do', async () => {
  const {file, dir, done} = folder();
  try {
    new ChildRegistry({file, bridgePid: 1, now: () => 10}).add({pid: 31, exe: EXE, label: 'llama-server'});
    const results = await reap({file, alive: pid => pid === 31, stop: async () => 'still-running', log: () => {}});
    assert.deepEqual(results.map(r => r.outcome), ['still-running']);
    assert.deepEqual(children(file).map(entry => entry.pid), [31]);
    assert.deepEqual(await reap({file: join(dir, 'missing.json')}), []);
    writeFileSync(file, '{not json');
    assert.deepEqual(await reap({file}), []);
  } finally { done(); }
});

test('stopIfMatching: one PowerShell call checks and stops, the values go in through the environment, and anything but a clear answer is "unreadable", never a stop', async () => {
  const entry = {pid: 321, exe: EXE, startedAt: 1760000000123.4};
  const seen = [];
  const runner = answer => async (command, args, timeout, env) => { seen.push({command, args, timeout, env}); return answer; };
  assert.equal(await stopIfMatching(entry, {runner: runner('stopped\r\n'), platform: 'win32'}), 'stopped');
  const call = seen[0];
  assert.equal(call.command, 'powershell.exe');
  const script = call.args.at(-1);
  assert.match(script, /Get-Process -Id/); assert.match(script, /\$p\.Kill\(\)/); assert.match(script, /\$path -ne \$env:CHILD_EXE/);
  assert.ok(script.indexOf('Get-Process') < script.indexOf('.Kill()'), 'the process looked at is the one that is ended');
  assert.equal((script.match(/Get-Process/g) ?? []).length, 1, 'the process is looked up once: no second lookup between the check and the stop');
  assert.ok(!script.includes('321') && !script.includes('llama-server'), 'no value is put into the command text');
  assert.equal(call.env.CHILD_PID, '321'); assert.equal(call.env.CHILD_EXE.toLowerCase(), EXE.toLowerCase()); assert.equal(call.env.CHILD_START, '1760000000123');
  assert.equal(call.env.CHILD_TOLERANCE, String(START_TOLERANCE_MS)); assert.ok(START_TOLERANCE_MS <= 10_000);
  for (const word of ['gone', 'foreign', 'still-running', 'unreadable']) assert.equal(await stopIfMatching(entry, {runner: runner(word + '\n'), platform: 'win32'}), word);
  for (const bad of ['', null, 'killed', 'Access is denied', 'stopped now'])  assert.equal(await stopIfMatching(entry, {runner: runner(bad), platform: 'win32'}), 'unreadable', String(bad));
  assert.equal(await stopIfMatching(entry, {runner: async () => { throw Error('spawn failed'); }, platform: 'win32'}), 'unreadable');
  const before = seen.length;
  assert.equal(await stopIfMatching(entry, {runner: runner('stopped'), platform: 'linux'}), 'unreadable');
  for (const bad of [{...entry, pid: '321; calc'}, {...entry, pid: -1}, {...entry, exe: undefined}, {...entry, startedAt: 'now'}]) assert.equal(await stopIfMatching(bad, {runner: runner('stopped'), platform: 'win32'}), 'unreadable');
  assert.equal(seen.length, before, 'no call for a platform or a record that cannot be checked');
});

// The real PowerShell call, on a process this test starts itself (a node that only waits): a record that does not match leaves it running, the one that matches ends it.
test('stopIfMatching on a real process: another exe or another start time is "foreign" and leaves it running; the recorded exe and start end it', {skip: process.platform !== 'win32', timeout: 60_000}, async () => {
  const {spawn} = await import('node:child_process');
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 40000)'], {stdio: 'ignore'});
  const startedAt = Date.now();
  try {
    await new Promise(resolveWait => setTimeout(resolveWait, 400));
    const record = {pid: child.pid, exe: process.execPath, startedAt};
    assert.equal(await stopIfMatching({...record, exe: join(tmpdir(), 'not-the-same.exe')}), 'foreign');
    assert.equal(await stopIfMatching({...record, startedAt: startedAt - 60_000}), 'foreign');
    assert.equal(pidAlive(child.pid), true, 'a record that does not match ends nothing');
    assert.equal(await stopIfMatching(record), 'stopped');
    assert.equal(pidAlive(child.pid), false);
    assert.equal(await stopIfMatching(record), 'gone');
  } finally { try { child.kill(); } catch { /* already gone */ } }
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
  assert.ok(supervisor.includes('signal: cap.signal'), 'the cap ends the cleanup, not only the wait for it');
});

test('a record from before this boot is dropped without a look, and the stop script opens the handle first and calls a start mismatch foreign even when the path cannot be read', async () => {
  const {file, done} = folder();
  try {
    writeFileSync(file, JSON.stringify({version: 1, children: [{pid: 4, exe: EXE, label: 'llama-server', startedAt: 1_000_000, bridgePid: 1}]}));
    const asked = [];
    const results = await reapChildren({file, alive: pid => pid === 4, bootedAt: 5_000_000, stop: async entry => { asked.push(entry.pid); return 'stopped'; }});
    assert.deepEqual(results.map(r => r.outcome), ['gone']);
    assert.deepEqual(asked, [], 'no PowerShell call for it');
    assert.equal(existsSync(file), false);
  } finally { done(); }
  let script = '';
  await stopIfMatching({pid: 5, exe: EXE, startedAt: 1}, {platform: 'win32', runner: async (command, args) => { script = args.at(-1); return 'gone'; }});
  assert.ok(script.indexOf('$p.Handle') > 0 && script.indexOf('$p.Handle') < script.indexOf('.StartTime') && script.indexOf('.StartTime') < script.indexOf('.Kill()'), 'handle, then start time, then the stop');
  assert.ok(script.indexOf("'foreign'") < script.indexOf("'unreadable'"), 'a start time that does not match is decided before an unreadable path');
});
