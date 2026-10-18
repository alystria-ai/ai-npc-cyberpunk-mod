// Failure paths of the conversation provider and the Mistral key (bridge/mistral-key.mjs) that mistral-key.test.mjs does not pin: a key file
// that cannot be written or removed, the settings commands failing half way, commands that are malformed or from the future, a fresh install
// with an empty key file, and the key never showing in any published status.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile, readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MistralProvider, MistralControl, parseMistralKey, parseKeyCommand, writePrivate} from './mistral-key.mjs';

const KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
const OTHER = 'Zy9xW8vU7tS6rQ5pO4nM3lK2jI1hG0fE';

function memory(text = null, {failWrite = false, failRemove = false, failRead = false} = {}) {
  const files = new Map(text === null ? [] : [['k.txt', text]]);
  const state = {failWrite, failRemove, failRead};
  return {files, state, provider: new MistralProvider({keyPath: 'k.txt',
    readText: async path => { if (state.failRead) throw Object.assign(Error('EACCES: permission denied'), {code: 'EACCES'}); if (!files.has(path)) throw Error('ENOENT'); return files.get(path); },
    writeText: async (path, value) => { if (state.failWrite) throw Object.assign(Error('ENOSPC: no space left on device'), {code: 'ENOSPC'}); files.set(path, value); },
    removeFile: async path => { if (state.failRemove) throw Object.assign(Error('EBUSY: resource busy'), {code: 'EBUSY'}); files.delete(path); }})};
}

// ---- a fresh install: the key file is empty or missing ----------------------------------------------------------------------------

test('a fresh install (empty, blank, byte-order-mark-only or unreadable key file) has no key and never throws; choosing Mistral falls back to Convai with one notice', async () => {
  for (const text of ['', '\n', '   \r\n', '﻿', '﻿\n', 'api-key=\n', 'api-key =   ', '# no key yet']) {
    const {provider} = memory(text);
    assert.equal((await provider.load()).key, null, JSON.stringify(text));
    provider.setPreference('mistral');
    assert.equal(provider.requested, 'convai');
    assert.equal(provider.takeNotice(), 'mistral-no-key');
    assert.equal(provider.tail, null);
    assert.deepEqual(provider.secrets(), []);
  }
  const unreadable = memory(`api-key=${KEY}\n`, {failRead: true});
  assert.equal((await unreadable.provider.load()).key, null, 'a key file that cannot be read is no key');
  const noPath = await new MistralProvider({}).load();
  assert.equal(noPath.key, null);
});

test('a key file that holds a key and something else, a key that is too long or too short, or two keys is no key: nothing half-valid is ever sent', () => {
  for (const text of [`api-key=${KEY}\nextra=1`, `${KEY} ${OTHER}`, `api-key=${KEY.slice(0, 19)}`, `api-key=${'a'.repeat(129)}`, `api-key="${KEY}"`, `Bearer ${KEY}`, `api-key=${KEY}`.repeat(200)])
    assert.equal(parseMistralKey(text), null, text.slice(0, 40));
  assert.equal(parseMistralKey(`api-key=${'a'.repeat(128)}`), 'a'.repeat(128), 'the longest accepted key');
  assert.equal(parseMistralKey(`api-key=${'a'.repeat(20)}`), 'a'.repeat(20), 'the shortest accepted key');
});

test('a fresh install pastes a key: the notice that said "no key" is not repeated, Mistral is taken at the next idle boundary, and its voice notice follows once', async () => {
  const {provider} = memory('');
  await provider.load();
  provider.setPreference('mistral');
  assert.equal(provider.takeNotice(), 'mistral-no-key');
  await provider.save(KEY);
  assert.equal(provider.requested, 'mistral');
  assert.equal(provider.pending, true);
  assert.equal(provider.takeNotice(), undefined, 'the no-key notice was already taken and is not asked for again');
  assert.equal(provider.apply(), true);
  assert.equal(provider.takeNotice({cloudVoice: true}), 'mistral-voice');
  assert.equal(provider.takeNotice({cloudVoice: true}), undefined);
});

// ---- saving and removing -----------------------------------------------------------------------------------------------------------------

test('a key that cannot be saved (disk full, locked file) is an error to the caller and changes nothing: the old key stays, no change is announced', async () => {
  const {provider, files, state} = memory(`api-key=${KEY}\n`);
  await provider.load();
  let heard = 0;
  provider.onChange(() => heard++);
  provider.noteLimit('rate'); heard = 0;
  state.failWrite = true;
  await assert.rejects(provider.save(OTHER), /ENOSPC/);
  assert.equal(provider.key, KEY);
  assert.equal(provider.limit.kind, 'rate', 'the limit note stays: nothing about the account changed');
  assert.equal(heard, 0);
  assert.equal(files.get('k.txt'), `api-key=${KEY}\n`);
  state.failWrite = false;
  await provider.save(OTHER);
  assert.equal(provider.key, OTHER);
  assert.equal(provider.limit, null);
  assert.equal(heard, 1);
});

test('a key that cannot be removed stays in use and saved, and the error reaches the caller; a second try works', async () => {
  const {provider, files, state} = memory(`api-key=${KEY}\n`);
  await provider.load();
  provider.setPreference('mistral'); provider.apply();
  state.failRemove = true;
  await assert.rejects(provider.remove(), /EBUSY/);
  assert.equal(provider.key, KEY);
  assert.equal(provider.active, true);
  assert.ok(files.has('k.txt'));
  state.failRemove = false;
  await provider.remove();
  assert.equal(provider.key, null);
  assert.equal(provider.pending, true);
});

test('writePrivate leaves no temporary file behind when the write fails, and the old file is untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mkey-'));
  try {
    const path = join(dir, 'player-mistral-key.txt');
    await writeFile(path, `api-key=${KEY}\n`);
    // A target that is a directory cannot be replaced by a file: the rename fails after the temporary file was written.
    const blocked = join(dir, 'blocked');
    await rm(blocked, {recursive: true, force: true});
    await import('node:fs/promises').then(fs => fs.mkdir(blocked));
    await assert.rejects(writePrivate(blocked, `api-key=${OTHER}\n`));
    assert.deepEqual((await readdir(dir)).sort(), ['blocked', 'player-mistral-key.txt'], 'the temporary file was removed');
    assert.equal(await readFile(path, 'utf8'), `api-key=${KEY}\n`);
  } finally { await rm(dir, {recursive: true, force: true}); }
});

// ---- the settings commands ---------------------------------------------------------------------------------------------------------------

function control({clipboard = KEY, validate = async () => 'valid', mem = memory(), command = ''} = {}) {
  const published = [];
  let current = command;
  const instance = new MistralControl({provider: mem.provider, commandPath: 'cmd.json', publish: async value => published.push(JSON.parse(JSON.stringify(value))), model: 'm/free',
    readClipboard: async () => { if (clipboard instanceof Error) throw clipboard; return clipboard; }, validate,
    read: async () => { if (current instanceof Error) throw current; return current; }, now: () => 10_000});
  return {...mem, published, instance, send: value => { current = JSON.stringify({version: 1, issuedAt: 9_999, ...value}); }, raw: text => { current = text; }, fail: error => { current = error; }};
}

test('a paste whose save fails is reported as failed and clears the busy flag: the next command is run, and no status ever holds the key', async () => {
  const c = control();
  await c.provider.load(); await c.instance.open();
  c.state.failWrite = true;
  c.send({id: 'a1', action: 'paste'});
  await c.instance.poll();
  assert.equal(c.published.at(-1).result.state, 'failed');
  assert.equal(c.provider.key, null);
  assert.equal(c.instance.busy, false);
  c.state.failWrite = false;
  c.send({id: 'a2', action: 'paste'});
  await c.instance.poll();
  assert.equal(c.published.at(-1).result.state, 'saved');
  assert.equal(c.provider.key, KEY);
  assert.doesNotMatch(JSON.stringify(c.published), new RegExp(KEY));
});

test('a check of the key that throws, a clipboard that returns something that is not text, and a removal that fails are each a reported result, never a crash', async () => {
  const throwing = control({validate: async () => { throw Error('network layer fault'); }});
  await throwing.provider.load(); await throwing.instance.open();
  throwing.send({id: 'b1', action: 'paste'}); await throwing.instance.poll();
  assert.equal(throwing.published.at(-1).result.state, 'failed');
  assert.equal(throwing.provider.key, null, 'a key whose check blew up is not saved');
  for (const clipboard of [null, 12345, {text: KEY}, ['x']]) {
    const c = control({clipboard});
    await c.provider.load(); await c.instance.open();
    c.send({id: 'b2', action: 'paste'}); await c.instance.poll();
    assert.equal(c.published.at(-1).result.state, 'unreadable', JSON.stringify(clipboard));
    assert.equal(c.provider.key, null);
  }
  const stuck = control({mem: memory(`api-key=${KEY}\n`, {failRemove: true})});
  await stuck.provider.load(); await stuck.instance.open();
  stuck.send({id: 'b3', action: 'clear'}); await stuck.instance.poll();
  assert.equal(stuck.published.at(-1).result.state, 'failed');
  assert.equal(stuck.published.at(-1).saved, true, 'the status says the key is still saved');
});

test('a command file that is unreadable, empty, garbled, from the future, or is not a command is ignored; a garbled one is not parsed again and a good one after it still runs', async () => {
  const c = control();
  await c.provider.load(); await c.instance.open();
  const count = () => c.published.length;
  const before = count();
  c.fail(Error('EBUSY'));            // the file cannot be read right now
  await c.instance.poll();
  c.raw('');                          // truncated to nothing while being written
  await c.instance.poll();
  c.raw('{"version":1,"id":"c1","action":"pa');   // half written
  await c.instance.poll();
  c.raw(JSON.stringify({version: 1, id: 'c2', action: 'paste', issuedAt: 10_000 + 60_000}));   // a clock a minute ahead
  await c.instance.poll();
  c.raw(JSON.stringify({version: 1, id: 'c3', action: 'format-disk', issuedAt: 9_999}));
  await c.instance.poll();
  assert.equal(count(), before, 'nothing ran and nothing was published');
  assert.equal(c.provider.key, null);
  c.send({id: 'c4', action: 'paste'});
  await c.instance.poll();
  assert.equal(c.provider.key, KEY);
});

test('key commands: ids of 160 characters pass and 161 do not, an unsafe or fractional time is refused, and only the id and the action come out', () => {
  const now = 1_000_000;
  const command = extra => JSON.stringify({version: 1, id: 'a1', action: 'clear', issuedAt: now, ...extra});
  assert.deepEqual(parseKeyCommand(command({id: 'a'.repeat(160), key: KEY, extra: true}), now), {id: 'a'.repeat(160), action: 'clear'});
  assert.equal(parseKeyCommand(command({id: 'a'.repeat(161)}), now), null);
  for (const bad of [{issuedAt: Number.MAX_SAFE_INTEGER + 2}, {issuedAt: '1000000'}, {version: '1'}, {id: '../x'}, {id: ''}, {action: 'Paste'}])
    assert.equal(parseKeyCommand(command(bad), now), null, JSON.stringify(bad));
  for (const bad of [null, undefined, 12, {}, '[]', 'null', '"text"']) assert.equal(parseKeyCommand(bad, now), null, String(bad));
  assert.equal(parseKeyCommand(command({issuedAt: now + 5000}), now)?.action, 'clear', 'five seconds ahead is allowed for clock differences');
  assert.equal(parseKeyCommand(command({issuedAt: now + 5001}), now), null);
});

test('the control refuses to be built without a provider, a command path or a publisher, and a status publish that failed does not wedge the next one', async () => {
  const mem = memory();
  assert.throws(() => new MistralControl({commandPath: 'c.json', publish() {}}), /Invalid Mistral configuration/);
  assert.throws(() => new MistralControl({provider: mem.provider, publish() {}}), /Invalid Mistral configuration/);
  assert.throws(() => new MistralControl({provider: mem.provider, commandPath: 'c.json'}), /Invalid Mistral configuration/);
  let fail = true;
  const seen = [];
  const instance = new MistralControl({provider: mem.provider, commandPath: 'c.json', publish: async value => { if (fail) throw Error('disk full'); seen.push(value); }, read: async () => ''});
  await assert.rejects(instance.publishStatus(), /disk full/);
  fail = false;
  await instance.publishStatus();
  assert.equal(seen.length, 1, 'the next publish is not blocked by the one that failed');
});
