// The player's state files in runtime/ and the durable copy the service keeps outside the game folder (bridge/game-state.mjs,
// docs/PACKAGING.md "Mod Organizer 2: the player's state"). Every test uses its own temporary folders.
//   restore order       the launcher's pass fills missing and empty files in place, then publishes the signal, in that order
//   newer wins          a real, non-empty file always wins and refreshes the copy; an older real file keeps the newer copy it replaces
//   an empty file       an empty placeholder is restored in place; an empty or cut-short file never replaces a copy
//   the running service a stat of each file per poll, a copy only on a change, never anything filled in while the game runs
import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as realFs from 'node:fs/promises';
import {mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {GAME_STATE_FILES, GameStateSync, OLDER_FOLDER, RESTORE_SIGNAL, gameStateFolder, publishRestoreSignal, restoreGameState,
  usableState} from './game-state.mjs';
import {mergeHandlers} from './file-wake.mjs';
import {loadRuntimeExchange} from '../packaging/lib/runtime-exchange.mjs';

const project = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const put = async (path, text, seconds) => {
  await mkdir(dirname(path), {recursive: true});
  await writeFile(path, text);
  if (seconds !== undefined) await utimes(path, seconds, seconds);
};
const read = path => readFile(path, 'utf8');
const exists = path => stat(path).then(() => true, () => false);
const names = async dir => (await readdir(dir).catch(() => [])).sort();
const NOW = Math.floor(Date.now() / 1000);
const HOUR = 3600;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'ai npc game state Ünï '));
  const runtime = join(root, 'game', 'mods', 'AiNpcCyberpunkMod', 'runtime');
  const durable = gameStateFolder(join(root, 'LocalAppData', 'AiNpcCyberpunkMod', 'data'));
  await mkdir(runtime, {recursive: true});
  return {root, runtime, durable, cleanup: () => rm(root, {recursive: true, force: true})};
}

// An fs that records every call that reads or changes a file, in order.
function spyFs() {
  const calls = [];
  const spy = {...realFs};
  for (const name of ['readFile', 'writeFile', 'rename', 'rm', 'utimes']) {
    spy[name] = (...args) => { calls.push([name, String(args[0])]); return realFs[name](...args); };
  }
  return {fs: spy, calls};
}

test('the list of state files is the manifest\'s state class (a test keeps the bridge and the packaging in step)', async () => {
  const manifest = await loadRuntimeExchange(project);
  assert.deepEqual([...GAME_STATE_FILES].sort(), [...manifest.state].sort());
  assert(manifest.state.includes('npc-names.json'), 'the NPC names file is part of the player state');
  assert(manifest.exchange.includes(RESTORE_SIGNAL), 'the signal is an exchange file, shipped as an empty placeholder');
});

test('a missing state file is restored from the copy, and the copy that is not needed is left alone', async () => {
  const f = await fixture();
  try {
    await put(join(f.durable, 'settings.json'), '{"version":2,"voice":false}', NOW - HOUR);
    await put(join(f.durable, 'phone-history.json'), '{"version":3,"buckets":{}}', NOW - HOUR);
    const result = await restoreGameState({runtime: f.runtime, durable: f.durable});
    assert.deepEqual(result.restored.sort(), ['phone-history.json', 'settings.json']);
    assert.equal(await read(join(f.runtime, 'settings.json')), '{"version":2,"voice":false}');
    assert.equal(await read(join(f.runtime, 'phone-history.json')), '{"version":3,"buckets":{}}');
    assert.deepEqual(await names(f.runtime), ['phone-history.json', 'settings.json'], 'nothing else is created in runtime/');
    assert.equal((await stat(join(f.runtime, 'settings.json'))).mtimeMs, (await stat(join(f.durable, 'settings.json'))).mtimeMs,
      'the restored file carries the copy\'s time, so the two are in step');
    // A second pass finds both in step and does nothing, not even a read.
    const {fs, calls} = spyFs();
    const again = await restoreGameState({runtime: f.runtime, durable: f.durable, fs});
    assert.deepEqual([again.restored, again.refreshed, again.kept], [[], [], []]);
    assert.deepEqual(calls, [], 'files in step are not read or written');
  } finally { await f.cleanup(); }
});

test('an empty state file (the shipped placeholder, or a crash) is restored in place, not replaced', async () => {
  const f = await fixture();
  try {
    await put(join(f.runtime, 'settings.json'), '');
    await put(join(f.durable, 'settings.json'), '{"version":2,"voiceProvider":"omni"}');
    const before = await stat(join(f.runtime, 'settings.json'), {bigint: true});
    const result = await restoreGameState({runtime: f.runtime, durable: f.durable});
    assert.deepEqual(result.restored, ['settings.json']);
    assert.equal(await read(join(f.runtime, 'settings.json')), '{"version":2,"voiceProvider":"omni"}');
    const after = await stat(join(f.runtime, 'settings.json'), {bigint: true});
    if (before.ino !== 0n) assert.equal(after.ino, before.ino, 'the same file was written into (an existing file is modified, never swapped)');
    assert.deepEqual(await names(f.runtime), ['settings.json']);
  } finally { await f.cleanup(); }
});

test('a real, non-empty file always wins and refreshes the copy; the copy never overwrites it', async () => {
  const f = await fixture();
  try {
    await put(join(f.runtime, 'settings.json'), '{"version":2,"voice":true,"mine":"newer"}', NOW);
    await put(join(f.durable, 'settings.json'), '{"version":2,"voice":false}', NOW - HOUR);
    const realBefore = await stat(join(f.runtime, 'settings.json'));
    const result = await restoreGameState({runtime: f.runtime, durable: f.durable});
    assert.deepEqual([result.restored, result.refreshed, result.kept], [[], ['settings.json'], []]);
    assert.equal(await read(join(f.runtime, 'settings.json')), '{"version":2,"voice":true,"mine":"newer"}', 'the real file is untouched');
    assert.equal((await stat(join(f.runtime, 'settings.json'))).mtimeMs, realBefore.mtimeMs);
    assert.equal(await read(join(f.durable, 'settings.json')), '{"version":2,"voice":true,"mine":"newer"}', 'the copy follows it');
    assert.equal(await exists(join(f.durable, OLDER_FOLDER)), false, 'an older copy is not kept: nothing was lost');
  } finally { await f.cleanup(); }
});

test('an older real file still wins over a newer copy, and the newer copy is kept aside, not thrown away', async () => {
  const f = await fixture();
  try {
    // For example an old backup of the game folder put back, or a second install that shares the data folder.
    await put(join(f.runtime, 'phone-history.json'), '{"version":3,"buckets":{"old":{}}}', NOW - 3 * HOUR);
    await put(join(f.durable, 'phone-history.json'), '{"version":3,"buckets":{"new":{}}}', NOW - HOUR);
    const result = await restoreGameState({runtime: f.runtime, durable: f.durable});
    assert.deepEqual([result.restored, result.refreshed, result.kept], [[], ['phone-history.json'], ['phone-history.json']]);
    assert.equal(await read(join(f.runtime, 'phone-history.json')), '{"version":3,"buckets":{"old":{}}}', 'the real file is never replaced');
    assert.equal(await read(join(f.durable, 'phone-history.json')), '{"version":3,"buckets":{"old":{}}}');
    assert.equal(await read(join(f.durable, OLDER_FOLDER, 'phone-history.json')), '{"version":3,"buckets":{"new":{}}}', 'the newer copy it replaced is kept');
  } finally { await f.cleanup(); }
});

test('a copy that is not readable JSON is never restored, and an unreadable real file never replaces a good copy', async () => {
  const f = await fixture();
  try {
    const logs = [];
    await put(join(f.durable, 'settings.json'), '{"version":2,"vo');                  // a torn copy
    await put(join(f.durable, 'addon-settings.json'), '{"version":1,"addons":{}}');
    await put(join(f.runtime, 'addon-settings.json'), 'not json at all', NOW);        // a damaged real file
    const result = await restoreGameState({runtime: f.runtime, durable: f.durable, log: message => logs.push(message)});
    assert.deepEqual([result.restored, result.refreshed], [[], []]);
    assert.equal(await exists(join(f.runtime, 'settings.json')), false);
    assert.equal(await read(join(f.durable, 'addon-settings.json')), '{"version":1,"addons":{}}');
    assert(logs.some(line => /settings\.json.*not readable JSON/.test(line)) && logs.some(line => /addon-settings\.json is not readable JSON/.test(line)), logs.join('\n'));
    assert.equal(usableState(Buffer.from('﻿{"a":1}')), true, 'a byte order mark does not make a file unreadable');
    assert.equal(usableState(Buffer.from('42')) || usableState(Buffer.from('null')) || usableState(Buffer.from('')), false);
  } finally { await f.cleanup(); }
});

test('with nothing saved a start restores and creates nothing', async () => {
  const f = await fixture();
  try {
    const result = await restoreGameState({runtime: f.runtime, durable: f.durable});
    assert.deepEqual([result.restored, result.refreshed, result.kept, result.errors], [[], [], [], 0]);
    assert.deepEqual(await names(f.runtime), []);
    assert.equal(await exists(f.durable), false, 'not even the copies folder is made until there is a copy to write');
  } finally { await f.cleanup(); }
});

test('the restore settles every file even when one fails, and says so', async () => {
  const f = await fixture();
  try {
    await put(join(f.durable, 'settings.json'), '{"a":1}');
    await put(join(f.durable, 'witness-receipts.json'), '{"b":2}');
    const logs = [];
    const failing = {...realFs, writeFile: (path, ...rest) => /settings\.json$/.test(String(path)) ? Promise.reject(Object.assign(Error('denied'), {code: 'EPERM'})) : realFs.writeFile(path, ...rest)};
    const result = await restoreGameState({runtime: f.runtime, durable: f.durable, fs: failing, log: message => logs.push(message)});
    assert.deepEqual(result.restored, ['witness-receipts.json']);
    assert.equal(result.errors, 1);
    assert(logs.some(line => /Could not settle settings\.json \(EPERM\)/.test(line)), logs.join('\n'));
  } finally { await f.cleanup(); }
});

test('restore order: every file is back before the signal, and the signal is written into its placeholder in place', async () => {
  const f = await fixture();
  try {
    await put(join(f.runtime, RESTORE_SIGNAL), '');                                    // the shipped empty placeholder
    await put(join(f.durable, 'settings.json'), '{"voice":false}');
    await put(join(f.durable, 'memory-chat-resets.json'), '{"revision":3}');
    const before = await stat(join(f.runtime, RESTORE_SIGNAL), {bigint: true});
    const {fs, calls} = spyFs();
    const result = await restoreGameState({runtime: f.runtime, durable: f.durable, fs});
    assert.equal(await read(join(f.runtime, RESTORE_SIGNAL)), '', 'no signal until the restore has finished');
    assert.equal(await publishRestoreSignal({runtime: f.runtime, result, fs, now: () => 1_800_000_000_000}), true);
    const writes = calls.filter(([name]) => name === 'writeFile').map(([, path]) => path.slice(f.runtime.length + 1));
    assert.deepEqual(writes, ['settings.json', 'memory-chat-resets.json', RESTORE_SIGNAL], 'the signal is the last write');
    const signal = JSON.parse(await read(join(f.runtime, RESTORE_SIGNAL)));
    assert.deepEqual(signal, {version: 1, state: 'done', written: 1_800_000_000_000, restored: ['settings.json', 'memory-chat-resets.json'], refreshed: [], errors: 0});
    const after = await stat(join(f.runtime, RESTORE_SIGNAL), {bigint: true});
    if (before.ino !== 0n) assert.equal(after.ino, before.ino, 'the placeholder is modified, not replaced');
  } finally { await f.cleanup(); }
});

test('the sync copies a state file when the game saves it, and only then', async () => {
  const f = await fixture();
  try {
    const {fs, calls} = spyFs();
    const sync = new GameStateSync({runtime: f.runtime, durable: f.durable, fs});
    await sync.poll();
    assert.deepEqual(calls, [], 'no files, no work: one stat each');
    await put(join(f.runtime, 'settings.json'), '{"version":2,"voice":true}', NOW - 60);
    await sync.poll();
    assert.equal(await read(join(f.durable, 'settings.json')), '{"version":2,"voice":true}');
    assert.equal((await stat(join(f.durable, 'settings.json'))).mtimeMs, (await stat(join(f.runtime, 'settings.json'))).mtimeMs);
    calls.length = 0;
    await sync.poll(); await sync.poll();
    assert.deepEqual(calls, [], 'an unchanged file is not read again');
    await put(join(f.runtime, 'settings.json'), '{"version":2,"voice":false}', NOW - 30);
    await sync.poll();
    assert.equal(await read(join(f.durable, 'settings.json')), '{"version":2,"voice":false}');
    assert.deepEqual(await names(f.durable), ['settings.json'], 'no temporary file is left in the copies folder');
  } finally { await f.cleanup(); }
});

test('the sync never copies an empty, missing or cut-short file over a good copy, and never fills a file in', async () => {
  const f = await fixture();
  try {
    const sync = new GameStateSync({runtime: f.runtime, durable: f.durable});
    await put(join(f.runtime, 'settings.json'), '{"version":2,"voice":true}', NOW - 60);
    await sync.poll();
    const good = '{"version":2,"voice":true}';
    // The Lua's own save moves the old file aside before the new one is moved in: for a moment there is no settings.json.
    await rm(join(f.runtime, 'settings.json'));
    await sync.poll();
    assert.equal(await exists(join(f.runtime, 'settings.json')), false, 'the sync never puts a file into runtime/ while the game runs');
    assert.equal(await read(join(f.durable, 'settings.json')), good, 'a vanished file does not delete or empty the copy');
    await put(join(f.runtime, 'settings.json'), '', NOW - 50);                           // opened for writing, nothing in it yet
    await sync.poll();
    assert.equal(await read(join(f.durable, 'settings.json')), good);
    await put(join(f.runtime, 'settings.json'), '{"version":2,"vo', NOW - 40);           // cut off
    await sync.poll();
    assert.equal(await read(join(f.durable, 'settings.json')), good);
    await put(join(f.runtime, 'settings.json'), '{"version":2,"voice":false}', NOW - 30);   // the finished write
    await sync.poll();
    assert.equal(await read(join(f.durable, 'settings.json')), '{"version":2,"voice":false}', 'the finished file is copied once it can be read');
    // A service that starts while the file is empty (a restore that could not write, a crash) leaves it empty: only the launcher fills files in.
    await put(join(f.runtime, 'settings.json'), '', NOW - 20);
    const restarted = new GameStateSync({runtime: f.runtime, durable: f.durable});
    await restarted.poll();
    assert.equal(await read(join(f.runtime, 'settings.json')), '', 'an empty file is not filled in by the running service');
    assert.equal(await read(join(f.durable, 'settings.json')), '{"version":2,"voice":false}');
  } finally { await f.cleanup(); }
});

test('the first poll after a start reads nothing when the launcher\'s restore already put the copy in step', async () => {
  const f = await fixture();
  try {
    await put(join(f.durable, 'phone-history.json'), '{"version":3,"buckets":{}}', NOW - HOUR);
    await restoreGameState({runtime: f.runtime, durable: f.durable});
    const {fs, calls} = spyFs();
    const sync = new GameStateSync({runtime: f.runtime, durable: f.durable, fs});
    await sync.poll();
    assert.deepEqual(calls, []);
  } finally { await f.cleanup(); }
});

test('the first poll settles a file the Lua saved between the restore and the service: the real file wins, an older one keeps the newer copy', async () => {
  const f = await fixture();
  try {
    await put(join(f.durable, 'settings.json'), '{"voice":"copy"}', NOW - HOUR);
    await put(join(f.runtime, 'settings.json'), '{"voice":"saved"}', NOW);
    const sync = new GameStateSync({runtime: f.runtime, durable: f.durable});
    await sync.poll();
    assert.equal(await read(join(f.durable, 'settings.json')), '{"voice":"saved"}');
    await put(join(f.durable, 'witness-receipts.json'), '{"rows":["newer copy"]}', NOW - 60);
    await put(join(f.runtime, 'witness-receipts.json'), '{"rows":[]}', NOW - 4 * HOUR);
    const second = new GameStateSync({runtime: f.runtime, durable: f.durable});
    await second.poll();
    assert.equal(await read(join(f.durable, 'witness-receipts.json')), '{"rows":[]}');
    assert.equal(await read(join(f.durable, OLDER_FOLDER, 'witness-receipts.json')), '{"rows":["newer copy"]}');
  } finally { await f.cleanup(); }
});

test('a backup file is copied while it exists and its copy goes when the game removes it after a good save', async () => {
  const f = await fixture();
  try {
    const sync = new GameStateSync({runtime: f.runtime, durable: f.durable});
    await put(join(f.runtime, 'settings.json.previous'), '{"voice":"old"}', NOW - 60);
    await sync.poll();
    assert.equal(await read(join(f.durable, 'settings.json.previous')), '{"voice":"old"}');
    await rm(join(f.runtime, 'settings.json.previous'));
    await sync.poll();
    assert.equal(await exists(join(f.durable, 'settings.json.previous')), false);
    // A main file is never removed from the copies, whatever happens to it in runtime/.
    await put(join(f.runtime, 'settings.json'), '{"voice":"now"}', NOW - 30);
    await sync.poll();
    await rm(join(f.runtime, 'settings.json'));
    await sync.poll();
    assert.equal(await read(join(f.durable, 'settings.json')), '{"voice":"now"}');
  } finally { await f.cleanup(); }
});

test('a failed copy is tried again on the next poll, a file changed mid-read is left for the next poll, and flush waits for the pass', async () => {
  const f = await fixture();
  try {
    await put(join(f.runtime, 'settings.json'), '{"voice":true}', NOW - 60);
    let fail = true;
    const logs = [];
    const flaky = {...realFs, rename: (...args) => fail ? Promise.reject(Object.assign(Error('busy'), {code: 'EBUSY'})) : realFs.rename(...args)};
    const sync = new GameStateSync({runtime: f.runtime, durable: f.durable, fs: flaky, log: message => logs.push(message)});
    await sync.poll();
    assert.equal(await exists(join(f.durable, 'settings.json')), false);
    assert(logs.length === 1 && /Could not copy settings\.json \(EBUSY\)/.test(logs[0]), logs.join('\n'));
    fail = false;
    await sync.poll();
    assert.equal(await read(join(f.durable, 'settings.json')), '{"voice":true}', 'the same file is copied on the next poll');
    assert.deepEqual(await names(f.durable), ['settings.json'], 'a failed copy leaves no temporary file');
    // flush: the pass that is running finishes, and a change made during it is picked up by one more pass.
    await put(join(f.runtime, 'settings.json'), '{"voice":false}', NOW - 20);
    const pass = sync.poll();
    await put(join(f.runtime, 'settings.json'), '{"voice":"third"}', NOW - 10);
    const queued = sync.poll();
    assert.equal(queued, pass, 'a poll during a pass joins it');
    await sync.flush();
    assert.equal(await read(join(f.durable, 'settings.json')), '{"voice":"third"}');
  } finally { await f.cleanup(); }
});

test('the sync reads nothing per frame: a poll of the nine files is nine stats when nothing changed', async () => {
  const f = await fixture();
  try {
    for (const name of GAME_STATE_FILES) await put(join(f.runtime, name), `{"file":"${name}"}`, NOW - 60);
    const sync = new GameStateSync({runtime: f.runtime, durable: f.durable});
    await sync.poll();
    for (const name of GAME_STATE_FILES) assert.equal(await read(join(f.durable, name)), `{"file":"${name}"}`);
    let stats = 0;
    const counting = {...realFs, stat: (...args) => { stats++; return realFs.stat(...args); }, readFile: () => assert.fail('read'), writeFile: () => assert.fail('write')};
    const quiet = new GameStateSync({runtime: f.runtime, durable: f.durable, fs: counting});
    await quiet.poll();            // first look: the copies are in step, so two stats a file and no read
    stats = 0;
    await quiet.poll();
    assert.equal(stats, GAME_STATE_FILES.length, 'one stat per file per poll');
  } finally { await f.cleanup(); }
});

test('watchHandlers cover every state file, and a file named by two sets runs both handlers', async () => {
  const f = await fixture();
  const sync = new GameStateSync({runtime: f.runtime, durable: f.durable});
  try {
    assert.deepEqual(Object.keys(sync.watchHandlers()).sort(), [...GAME_STATE_FILES].sort());
    const ran = [];
    const merged = mergeHandlers({'addon-settings.json': () => { ran.push('addons'); }, 'a.json': () => { ran.push('a'); }},
      {'addon-settings.json': async () => { ran.push('state'); }}, undefined);
    assert.deepEqual(Object.keys(merged).sort(), ['a.json', 'addon-settings.json']);
    await merged['addon-settings.json']();
    await new Promise(done => setTimeout(done, 5));
    assert.deepEqual(ran.sort(), ['addons', 'state']);
    const failing = mergeHandlers({x: () => { throw Error('first'); }}, {x: () => 'second'});
    assert.equal(failing.x(), 'second', 'a failing handler never stops the next one');
  } finally { await f.cleanup(); }
});
