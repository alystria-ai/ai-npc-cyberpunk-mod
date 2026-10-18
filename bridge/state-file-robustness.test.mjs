import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {readFileSync, statSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {atomicFile} from './guarded-file.mjs';
import {MemoryStore} from './memory-store.mjs';
import {CharacterOverrides} from './character-overrides.mjs';
import {VendorMemory} from './vendor-memory.mjs';
import {ChatMemoryResets} from './chat-memory-resets.mjs';
import {PlayerMemoryControl} from './player-memory-control.mjs';
import {PlayerMemory} from './player-memory.mjs';
import {witnessReceiptsReader} from './witness-receipts.mjs';
import {decisionLedgerReader} from './game-dialogue.mjs';
import {loadInstallId, readAuthSettings} from './convai-credential.mjs';

// The player's own state files (character memory, character edits, vendor memory, the Chat reset journal, the player memory registry,
// the witness receipts and the decision ledger, the install id) and the atomic writer under all of them, run against a real folder.
// Every module here is given the damaged files a real disk produces: an empty file, a file cut off in the middle, a file with a
// byte-order mark, a JSON array where an object belongs, a folder where the file should be, a file that is too big, a missing parent.
// The rules under test: a bad file never takes the bridge down (every one of these is opened at start-up), a bad file is never
// silently turned into a good one, and nothing is created, renamed or removed by the READER.

async function folder(t) {
  const directory = await mkdtemp(join(tmpdir(), 'state-robust-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
}
const names = async directory => (await readdir(directory)).sort();
async function filesUnder(directory) {
  const found = new Map();
  for (const entry of await readdir(directory, {withFileTypes: true})) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) for (const [inner, text] of await filesUnder(path)) found.set(inner, text);
    else found.set(path, await readFile(path, 'utf8'));
  }
  return found;
}

// ---------------------------------------------------------------- the atomic writer

test('atomicFile never creates a missing folder: it rejects and leaves nothing behind', async t => {
  const directory = await folder(t);
  await assert.rejects(atomicFile(join(directory, 'missing', 'state.json'), '{}'), {code: 'ENOENT'});
  assert.deepEqual(await names(directory), [], 'no folder and no temporary file appeared');
});

test('atomicFile over a folder rejects, keeps the folder and leaves no temporary file', async t => {
  const directory = await folder(t);
  const target = join(directory, 'state.json');
  await mkdir(target);
  await writeFile(join(target, 'inside.txt'), 'kept');
  const started = Date.now();
  await assert.rejects(atomicFile(target, '{}'));
  assert.ok(Date.now() - started < 3000, 'the retry backoff is bounded');
  assert.deepEqual(await names(directory), ['state.json']);
  assert.equal((await stat(target)).isDirectory(), true);
  assert.equal(await readFile(join(target, 'inside.txt'), 'utf8'), 'kept');
});

test('an exchange file shipped empty is replaced in place by every write, emptied again by an empty write, and never removed', async t => {
  const directory = await folder(t);
  const path = join(directory, 'reply.json');
  await writeFile(path, '');
  const big = JSON.stringify({id: 2, pad: 'x'.repeat(200_000)});
  for (const text of ['{"id":1}', '', big, '', '{"id":3}']) {
    assert.equal(await atomicFile(path, text), true);
    assert.equal(await readFile(path, 'utf8'), text);
    assert.deepEqual(await names(directory), ['reply.json'], 'one file, never a side file');
  }
});

test('a reader that polls while a file is replaced again and again never sees half a document', async t => {
  const directory = await folder(t);
  const path = join(directory, 'speech-state.json');
  await writeFile(path, '');
  let stop = false;
  const seen = {whole: 0, empty: 0, torn: 0, failed: 0};
  const reader = (async () => {
    while (!stop) {
      let text;
      // A failed open during the replacement counts as "nothing yet" for every bridge reader (they catch it), so it is not an error here.
      try { text = await readFile(path, 'utf8'); } catch { seen.failed++; await new Promise(done => setTimeout(done, 2)); continue; }
      if (text === '') { seen.empty++; }
      else { try { JSON.parse(text); seen.whole++; } catch { seen.torn++; } }
      // A pause between polls like the game's own (a poll every few milliseconds, not a hot loop: Windows can refuse a rename
      // over a file that a reader re-opens without pause, which is a property of the platform, not of atomicFile).
      await new Promise(done => setTimeout(done, 3));
    }
  })();
  try {
    for (let revision = 1; revision <= 40; revision++) {
      // Windows can refuse the rename while the reader has the file open (about one write in thirty here); atomicFile retries for
      // about 300 ms and then throws, and its callers catch that (see guarded-file.mjs). A write that loses the race must leave the
      // previous whole document and no temporary file, which the checks below assert; it must not be any other kind of error.
      try { assert.equal(await atomicFile(path, JSON.stringify({revision, pad: 'y'.repeat(60_000 + revision)})), true); }
      catch (error) { assert.match(error.code, /^(?:EPERM|EACCES|EBUSY)$/, error.message); seen.writeRefused = (seen.writeRefused ?? 0) + 1; }
      await new Promise(done => setTimeout(done, 2));
    }
  } finally { stop = true; await reader; }
  assert.equal(seen.torn, 0, JSON.stringify(seen));
  assert.ok(seen.whole > 0, 'the reader did observe the writes');
  assert.deepEqual(await names(directory), ['speech-state.json']);
});

// ---------------------------------------------------------------- character memory (MemoryStore)

async function seedMemoryFolder(directory) {
  const player = join(directory, 'local-memory', 'player');
  await mkdir(player, {recursive: true});
  const good = {version: 1, profileKey: 'judy-alvarez', summary: 'Judy remembers the rooftop.', channels: {private: [{v: 'hi', r: 'hey you'}]}};
  await writeFile(join(player, 'judy-alvarez.json'), JSON.stringify(good));
  await writeFile(join(player, 'empty.json'), '');
  await writeFile(join(player, 'truncated.json'), JSON.stringify({version: 1, profileKey: 'truncated', summary: 'cut off here'}).slice(0, -6));
  await writeFile(join(player, 'bom.json'), '﻿' + JSON.stringify({version: 1, profileKey: 'bom', summary: 'starts with a byte-order mark'}));
  await writeFile(join(player, 'array.json'), '[{"version":1,"profileKey":"array"}]');
  await writeFile(join(player, 'huge.json'), JSON.stringify({version: 1, profileKey: 'huge', summary: 'z'.repeat(5000)}));
  await mkdir(join(player, 'folder.json'));
  await writeFile(join(player, 'notes.txt'), 'not a character file');
  return {root: join(directory, 'local-memory'), player};
}

test('MemoryStore opens a folder of damaged files on a real disk: only the good file loads, and open changes nothing on disk', async t => {
  const directory = await folder(t);
  const {root, player} = await seedMemoryFolder(directory);
  const before = await filesUnder(root);
  const store = await MemoryStore.open({dir: root, limits: {characterBytes: 1000}});
  assert.equal(store.size, 1);
  assert.equal(store.recall({profileKey: 'judy-alvarez'}).summary, 'Judy remembers the rooftop.');
  for (const key of ['empty', 'truncated', 'bom', 'array', 'huge', 'folder']) assert.equal(store.recall({profileKey: key}).turns.length, 0, key);
  await store.flush();
  assert.deepEqual(await filesUnder(root), before, 'the damaged files and the good one are byte for byte as they were');
  assert.deepEqual(await names(player), ['array.json', 'bom.json', 'empty.json', 'folder.json', 'huge.json', 'judy-alvarez.json', 'notes.txt', 'truncated.json']);
});

test('MemoryStore on a root that is a file (or cannot be listed) starts empty, keeps new exchanges in memory and reports the failed save', async t => {
  const directory = await folder(t);
  const root = join(directory, 'local-memory');
  await writeFile(root, 'a file where the memory folder should be');
  const lines = [];
  const store = await MemoryStore.open({dir: root, log: line => lines.push(line)});
  assert.equal(store.size, 0);
  store.record({profileKey: 'judy-alvarez', v: 'hello', r: 'hi there'});
  await assert.rejects(store.flush());
  assert.equal(store.recall({profileKey: 'judy-alvarez'}).turns.length, 1, 'the exchange is still remembered for this run');
  assert.ok(lines.some(line => /memory save failed/.test(line)), JSON.stringify(lines));
  assert.equal(await readFile(root, 'utf8'), 'a file where the memory folder should be');
  // The failed save is retried, not dropped: once the obstacle is gone the same exchange reaches the disk.
  await rm(root);
  await store.flush();
  const saved = JSON.parse(await readFile(join(root, 'player', 'judy-alvarez.json'), 'utf8'));
  assert.equal(saved.channels.private[0].r, 'hi there');
});

test('a damaged character memory file is kept aside before the first save writes over it', {todo: 'MemoryStore skips a damaged character file silently (no log line) and the next save replaces it with no copy; VendorMemory keeps its damaged file as .corrupt'}, async t => {
  const directory = await folder(t);
  const {root, player} = await seedMemoryFolder(directory);
  const damaged = await readFile(join(player, 'truncated.json'), 'utf8');
  const store = await MemoryStore.open({dir: root, limits: {characterBytes: 1000}});
  store.record({profileKey: 'truncated', v: 'hello again', r: 'you are back'});
  await store.flush();
  const kept = [...await filesUnder(root)].filter(([path, text]) => path !== join(player, 'truncated.json') && text === damaged);
  assert.equal(kept.length, 1, 'the cut-off file survives somewhere beside the new one');
});

// ---------------------------------------------------------------- character edits (CharacterOverrides)

const BIO = 'A fixer who talks fast and trusts slowly, born in Heywood and never quite left it.';
async function seedOverrides(directory) {
  const dir = join(directory, 'character-overrides');
  await mkdir(dir, {recursive: true});
  await writeFile(join(dir, 'judy-alvarez.json'), JSON.stringify({version: 1, key: 'judy-alvarez', bio: BIO}));
  await writeFile(join(dir, 'empty-one.json'), '');
  await writeFile(join(dir, 'cut-off.json'), JSON.stringify({version: 1, key: 'cut-off', bio: BIO}).slice(0, -10));
  await writeFile(join(dir, 'bom-one.json'), '﻿' + JSON.stringify({version: 1, key: 'bom-one', bio: BIO}));
  await writeFile(join(dir, 'array-one.json'), JSON.stringify([{version: 1, key: 'array-one', bio: BIO}]));
  await mkdir(join(dir, 'folder-one.json'));
  await writeFile(join(dir, 'Upper-Case.json'), JSON.stringify({version: 1, key: 'Upper-Case', bio: BIO}));
  return dir;
}

test('CharacterOverrides on a real disk loads the good file, names each unreadable one in the log, and changes nothing at open', async t => {
  const directory = await folder(t);
  const dir = await seedOverrides(directory);
  const before = await filesUnder(dir);
  const lines = [];
  const overrides = await CharacterOverrides.open({dir, log: line => lines.push(line)});
  assert.deepEqual(overrides.keys(), ['judy-alvarez']);
  assert.equal(overrides.get('judy-alvarez').bio, BIO);
  for (const key of ['empty-one', 'cut-off', 'bom-one', 'folder-one']) {
    assert.ok(lines.some(line => line.includes(key)), `${key} is named in the log: ${JSON.stringify(lines)}`);
  }
  assert.deepEqual(await filesUnder(dir), before);
});

test('CharacterOverrides given a folder that does not exist, or a file instead of the folder, is an empty set', async t => {
  const directory = await folder(t);
  assert.deepEqual((await CharacterOverrides.open({dir: join(directory, 'nothing-here')})).keys(), []);
  const asFile = join(directory, 'character-overrides');
  await writeFile(asFile, 'not a folder');
  const overrides = await CharacterOverrides.open({dir: asFile});
  assert.deepEqual(overrides.keys(), []);
  await assert.rejects(overrides.set('judy-alvarez', {bio: BIO}), 'saving into it fails, and says so');
  assert.equal(overrides.get('judy-alvarez'), null, 'a failed save changes nothing in memory');
});

test('a damaged character edit file is kept aside before the player\'s next save writes over it', {todo: 'the load log says "they are left as they are", but set() replaces the damaged file with no copy'}, async t => {
  const directory = await folder(t);
  const dir = await seedOverrides(directory);
  const damaged = await readFile(join(dir, 'cut-off.json'), 'utf8');
  const overrides = await CharacterOverrides.open({dir});
  await overrides.set('cut-off', {bio: BIO + ' Edited again.'});
  const kept = [...await filesUnder(directory)].filter(([path, text]) => path !== join(dir, 'cut-off.json') && text === damaged);
  assert.equal(kept.length, 1);
});

// ---------------------------------------------------------------- vendor memory

test('VendorMemory with a folder where its file should be starts empty, never throws into the conversation, and warns once per kind', async t => {
  const directory = await folder(t);
  const path = join(directory, 'vendor-memory.json');
  await mkdir(path);
  const warnings = [];
  const memory = await VendorMemory.open({path, onWarning: message => warnings.push(message)});
  assert.equal(memory.status().vendors, 0);
  for (let turn = 0; turn < 3; turn++) {
    assert.equal(await memory.remember({memoryKey: 'shop_a', profileKey: 'resident-male', playerText: 'hi', replyText: 'what do you need'}), false);
  }
  assert.equal(warnings.length, 2, JSON.stringify(warnings));
  assert.match(warnings[0], /could not be read/);
  assert.match(warnings[1], /could not be written/);
  assert.equal(memory.contextFor({memoryKey: 'shop_a', profileKey: 'resident-male'}), '');
  assert.equal((await stat(path)).isDirectory(), true);
  assert.deepEqual(await names(directory), ['vendor-memory.json']);
});

// ---------------------------------------------------------------- the Chat reset journal

const idle = {actions: [], characters: []};

test('a Chat reset journal that is empty, cut off or has a byte-order mark is refused, never overwritten, and no side file appears', async t => {
  const directory = await folder(t);
  const path = join(directory, 'memory-chat-resets.json');
  const journal = await ChatMemoryResets.open({path, status: idle});
  await journal.start({id: 'forget-judy', scope: 'character', profileKey: 'judy-alvarez'});
  const valid = await readFile(path, 'utf8');
  assert.ok(JSON.parse(valid).pending.some(row => row.id === 'forget-judy'));
  for (const damaged of ['', '   \n', valid.slice(0, Math.floor(valid.length / 2)), '﻿' + valid, '[]', 'null']) {
    await writeFile(path, damaged);
    await assert.rejects(ChatMemoryResets.open({path, status: idle}), /Invalid Chat reset/, JSON.stringify(damaged.slice(0, 20)));
    assert.equal(await readFile(path, 'utf8'), damaged, 'the damaged journal is exactly as it was');
    assert.deepEqual(await names(directory), ['memory-chat-resets.json']);
  }
  await writeFile(path, valid);
  await ChatMemoryResets.open({path, status: idle});
});

test('a first run with no Chat reset journal creates it from the game status, in place, with no temporary file', async t => {
  const directory = await folder(t);
  const path = join(directory, 'memory-chat-resets.json');
  const status = {actions: [{id: 'old-clear', state: 'succeeded', scope: 'all'}], characters: []};
  await ChatMemoryResets.open({path, status});
  const state = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(state.baseline, [{id: 'old-clear', scope: 'all'}], 'an old clear is baselined, not replayed');
  assert.deepEqual(await names(directory), ['memory-chat-resets.json']);
});

test('PlayerMemoryControl.open rejects on a damaged Chat reset journal and leaves it as it was (the bridge awaits this at start-up)', async t => {
  const directory = await folder(t);
  const journal = join(directory, 'memory-chat-resets.json');
  await writeFile(journal, '');
  const memory = {status: () => ({available: true, talkedToCount: 0, characters: []}), clearCharacter() { throw Error('never'); }, clearAll() { throw Error('never'); }};
  const published = [];
  await assert.rejects(PlayerMemoryControl.open({memory, commandPath: join(directory, 'memory-command.json'), chatResetPath: journal,
    publish: async value => { published.push(value); }}), /Invalid Chat reset journal/);
  assert.equal(await readFile(journal, 'utf8'), '');
  assert.deepEqual(published, [], 'nothing was published as ready');
});

// ---------------------------------------------------------------- the player memory registry

async function openRegistry(path) {
  const provider = {async enableMemory() { return {enabled: true, changed: true}; }, async clearMemory() { return {accepted: true, providerEmptyObserved: true}; },
    async inspectMemory() { return {providerEmptyObserved: true}; }};
  return PlayerMemory.open({path, characterIds: {judy: 'owned-judy'}, provider, quiesce: async () => ({quiesced: true})});
}

test('a player memory registry that is empty, cut off, has a byte-order mark or is a folder fails closed and is never replaced', async t => {
  const directory = await folder(t);
  const path = join(directory, 'player-memory.json');
  await (await openRegistry(path)).close();
  const valid = await readFile(path, 'utf8'), anchor = await readFile(path + '.identity', 'utf8');
  for (const damaged of ['', '\n', valid.slice(0, 40), '﻿' + valid]) {
    await writeFile(path, damaged);
    await assert.rejects(openRegistry(path), {code: 'CORRUPT_REGISTRY'}, JSON.stringify(damaged.slice(0, 12)));
    assert.equal(await readFile(path, 'utf8'), damaged);
    assert.equal(await readFile(path + '.identity', 'utf8'), anchor, 'the identity anchor is untouched');
    assert.deepEqual(await names(directory), ['player-memory.json', 'player-memory.json.identity'], 'the lock is released after the failed open');
  }
  await rm(path);
  await mkdir(path);
  await assert.rejects(openRegistry(path), {code: 'CORRUPT_REGISTRY'});
  assert.equal((await stat(path)).isDirectory(), true);
  assert.equal(await readFile(path + '.identity', 'utf8'), anchor);
});

test('an empty identity anchor, or an anchor with no registry, never rotates the player identity', async t => {
  const directory = await folder(t);
  const path = join(directory, 'player-memory.json');
  await (await openRegistry(path)).close();
  const anchor = await readFile(path + '.identity', 'utf8');
  await writeFile(path + '.identity', '');
  await assert.rejects(openRegistry(path), {code: 'CORRUPT_REGISTRY'});
  assert.equal(await readFile(path + '.identity', 'utf8'), '');
  await writeFile(path + '.identity', anchor);
  await rm(path);
  await assert.rejects(openRegistry(path), {code: 'MISSING_ESTABLISHED_REGISTRY'});
  assert.deepEqual(await names(directory), ['player-memory.json.identity']);
});

test('a lock file left by a crashed bridge (its process is gone) is reclaimed, and the identity is the one that was there', async t => {
  const directory = await folder(t);
  const path = join(directory, 'player-memory.json');
  const first = await openRegistry(path);
  const identity = first.route('judy').endUserId;
  await first.close();
  const gone = spawnSync(process.execPath, ['-e', ''], {windowsHide: true});
  assert.ok(gone.pid > 0);
  await writeFile(path + '.lock', JSON.stringify({version: 1, pid: gone.pid, token: randomUUID()}) + '\n');
  const second = await openRegistry(path);
  assert.equal(second.route('judy').endUserId, identity);
  await second.close();
  assert.deepEqual(await names(directory), ['player-memory.json', 'player-memory.json.identity'], 'the stale lock and the reclaim claim are both gone');
});

// ---------------------------------------------------------------- witness receipts and the decision ledger (reader over a real file)

const receipts = rows => ({version: 1, worldToken: 'world-a', gameTimeSeconds: 9000, edges: rows});
const ledger = entries => ({version: 1, worldToken: 'world-a', gameTimeSeconds: 9000, entries});
const realIo = {readFile: path => readFileSync(path, 'utf8'), statFile: statSync};

for (const [name, make, good, check] of [
  ['witness receipts', path => witnessReceiptsReader(path, realIo), receipts([{type: 'fact', key: 'w1', t: 5, near: ['judy-alvarez']}]), value => value.edges[0].key],
  ['decision ledger', path => decisionLedgerReader(path, realIo), ledger([{t: 5, text: 'Tell her the truth', index: 0, addressee: 'judy-alvarez'}]), value => value.entries[0].text],
]) {
  test(`the ${name} reader follows a real file through every state it can be in, and never throws`, async t => {
    const directory = await folder(t);
    const path = join(directory, 'state.json');
    const read = make(path);
    const text = JSON.stringify(good);
    assert.equal(read(), undefined, 'missing');
    await writeFile(path, '');
    assert.equal(read(), undefined, 'empty');
    await writeFile(path, text);
    assert.ok(check(read()), 'whole');
    await writeFile(path, text.slice(0, Math.floor(text.length / 2)));
    assert.equal(read(), undefined, 'cut off in the middle: no stale copy of the last good read');
    await writeFile(path, '﻿' + text);
    assert.equal(read(), undefined, 'byte-order mark');
    await writeFile(path, '[]');
    assert.equal(read(), undefined, 'wrong shape');
    await writeFile(path, text);
    assert.ok(check(read()), 'whole again');
    await writeFile(path, '');
    assert.equal(read(), undefined, 'emptied again');
    await rm(path);
    await mkdir(path);
    assert.equal(read(), undefined, 'a folder where the file should be');
    await rm(path, {recursive: true});
    await writeFile(path, text);
    assert.ok(check(read()), 'back to whole');
  });
}

// ---------------------------------------------------------------- the install id and the sign-in settings

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

test('the install id is rebuilt from an empty, cut off, array, wrong-id or folder file, written atomically, and then stays the same', async t => {
  const directory = await folder(t);
  const path = join(directory, 'convai-install.json');
  const good = randomUUID();
  const valid = JSON.stringify({version: 1, installId: good}) + '\n';
  await writeFile(path, valid);
  assert.equal(await loadInstallId({path}), good);
  for (const damaged of ['', '{"version":1,"installId":"3f2a', '[]', '{"version":1,"installId":"not-a-uuid"}', '﻿' + valid, 'null']) {
    await writeFile(path, damaged);
    const id = await loadInstallId({path});
    assert.match(id, UUID_V4, JSON.stringify(damaged.slice(0, 20)));
    assert.equal(JSON.parse(await readFile(path, 'utf8')).installId, id, 'the new id was saved');
    assert.equal(await loadInstallId({path}), id, 'and is stable from then on');
    assert.deepEqual(await names(directory), ['convai-install.json'], 'no temporary file is left');
  }
  await rm(path);
  await mkdir(path);
  assert.match(await loadInstallId({path}), UUID_V4, 'a folder in the way still yields an id for this run');
  assert.deepEqual(await names(directory), ['convai-install.json']);
  assert.equal((await stat(path)).isDirectory(), true);
});

test('the install id of a missing folder is made for this run and not written anywhere', async t => {
  const directory = await folder(t);
  const id = await loadInstallId({path: join(directory, 'missing', 'convai-install.json')});
  assert.match(id, UUID_V4);
  assert.deepEqual(await names(directory), []);
});

test('the sign-in settings file is optional: empty, cut off, array or folder leave the backend off, and a valid file turns it on', async t => {
  const directory = await folder(t);
  const path = join(directory, 'convai-auth.json');
  const settings = {enabled: true, url: 'https://backend.example/token', secret: 's'.repeat(32)};
  for (const damaged of ['', '{"enabled":true,"url":"https://backend.exa', '[]', 'null', '"text"']) {
    await writeFile(path, damaged);
    const result = await readAuthSettings({env: {}, path});
    assert.equal(result.enabled, false, JSON.stringify(damaged));
    assert.equal(result.problem, null);
  }
  await rm(path);
  await mkdir(path);
  assert.equal((await readAuthSettings({env: {}, path})).enabled, false);
  await rm(path, {recursive: true});
  await writeFile(path, JSON.stringify(settings));
  assert.equal((await readAuthSettings({env: {}, path})).enabled, true);
});

test('a sign-in settings file with a byte-order mark is read like any other (PowerShell and Notepad can write one)', async t => {
  const directory = await folder(t);
  const path = join(directory, 'convai-auth.json');
  await writeFile(path, '﻿' + JSON.stringify({enabled: true, url: 'https://backend.example/token', secret: 's'.repeat(32)}));
  assert.equal((await readAuthSettings({env: {}, path})).enabled, true);
});
