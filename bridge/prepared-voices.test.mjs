import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {PREPARED_VOICE_FILE, PreparedVoicesControl, clearPreparedVoices, listPreparedVoices, measurePreparedVoices,
  parsePreparedVoicesCommand, preparedVoicesFolder} from './prepared-voices.mjs';

const hex = n => String(n).padStart(24, 'a');
const prepared = (voice, n = 1) => `${voice}-${hex(n)}.safetensors`;

// A temporary Pocket work directory: prepared voices beside things that must survive (a reference, a model, a neighbour folder).
async function workDirectory() {
  const root = await mkdtemp(join(tmpdir(), 'prepared-voices-'));
  const work = join(root, 'pocket-voice-work'), folder = join(work, 'prepared-voices');
  await mkdir(folder, {recursive: true});
  await mkdir(join(root, 'voice-references'), {recursive: true});
  await mkdir(join(root, 'models'), {recursive: true});
  await writeFile(join(root, 'voice-references', 'judy.wav'), 'reference audio');
  await writeFile(join(root, 'models', 'model.safetensors'), 'model weights');
  await writeFile(join(work, 'other.safetensors'), 'outside the folder');
  return {root, work, folder, config: {runtime: {workDirectory: work}}};
}
const survivors = async root => ({
  reference: await readFile(join(root, 'voice-references', 'judy.wav'), 'utf8'),
  model: await readFile(join(root, 'models', 'model.safetensors'), 'utf8'),
  outside: await readFile(join(root, 'pocket-voice-work', 'other.safetensors'), 'utf8')});
const SURVIVORS = {reference: 'reference audio', model: 'model weights', outside: 'outside the folder'};

test('the folder is the Pocket work directory\'s prepared-voices folder, and only when the config names one', () => {
  assert.equal(preparedVoicesFolder({runtime: {workDirectory: join('x', 'work')}}), join('x', 'work', 'prepared-voices'));
  assert.equal(preparedVoicesFolder({}), null);
  assert.equal(preparedVoicesFolder(undefined), null);
  assert.equal(preparedVoicesFolder({runtime: {workDirectory: 7}}), null);
});

test('only the worker\'s exact file names count as prepared voices', () => {
  for (const name of [prepared('judy'), prepared('johnny-silverhand', 9), `${prepared('judy')}.tmp`, prepared('npc-merc-male-v2')]) assert.ok(PREPARED_VOICE_FILE.test(name), name);
  for (const name of ['judy.wav', 'judy.safetensors', 'judy-short.safetensors', `judy-${'a'.repeat(23)}.safetensors`, `judy-${'a'.repeat(25)}.safetensors`,
    `judy-${'g'.repeat(24)}.safetensors`, 'model.safetensors', `${prepared('judy')}.bak`, `../${prepared('judy')}`, `sub/${prepared('judy')}`, 'notes.txt'])
    assert.ok(!PREPARED_VOICE_FILE.test(name), name);
});

test('measuring counts prepared files and bytes, and a missing folder holds none', async () => {
  const {root, folder} = await workDirectory();
  assert.deepEqual(await measurePreparedVoices(folder), {files: 0, bytes: 0});
  await writeFile(join(folder, prepared('judy')), Buffer.alloc(1000));
  await writeFile(join(folder, prepared('panam', 2)), Buffer.alloc(2500));
  await writeFile(join(folder, `${prepared('river', 3)}.tmp`), Buffer.alloc(40));
  await writeFile(join(folder, 'readme.txt'), Buffer.alloc(9000));
  assert.deepEqual(await measurePreparedVoices(folder), {files: 3, bytes: 3540});
  assert.deepEqual(await measurePreparedVoices(join(root, 'nowhere')), {files: 0, bytes: 0});
});

test('clearing deletes exactly the prepared voice files: references, models, other files, folders and neighbours stay', async () => {
  const {root, folder} = await workDirectory();
  await writeFile(join(folder, prepared('judy')), Buffer.alloc(1000));
  await writeFile(join(folder, prepared('panam', 2)), Buffer.alloc(2000));
  await writeFile(join(folder, `${prepared('river', 3)}.tmp`), Buffer.alloc(30));
  for (const keep of ['readme.txt', 'judy.wav', 'model.safetensors', 'judy.safetensors', `${prepared('judy')}.bak`]) await writeFile(join(folder, keep), 'keep me');
  await mkdir(join(folder, prepared('folder', 4)));                    // a directory with a matching name is not a file
  await writeFile(join(folder, prepared('folder', 4), 'inner.txt'), 'inside');
  const removed = await clearPreparedVoices(folder);
  assert.deepEqual(removed, {files: 3, bytes: 3030});
  assert.deepEqual((await readdir(folder)).sort(), ['judy.safetensors', 'judy.wav', 'model.safetensors', 'readme.txt', `${prepared('judy')}.bak`, prepared('folder', 4)].sort());
  assert.equal(await readFile(join(folder, prepared('folder', 4), 'inner.txt'), 'utf8'), 'inside');
  assert.deepEqual(await survivors(root), SURVIVORS);
  assert.deepEqual(await clearPreparedVoices(folder), {files: 0, bytes: 0});      // nothing left to clear
  assert.deepEqual(await clearPreparedVoices(join(root, 'nowhere')), {files: 0, bytes: 0});
});

test('a link with a prepared voice\'s name is never followed or deleted', async t => {
  const {root, folder} = await workDirectory();
  const target = join(root, 'models', 'model.safetensors');
  try { await symlink(target, join(folder, prepared('linked', 5))); } catch (error) { t.skip(`no symlink permission: ${error.code}`); return; }
  await writeFile(join(folder, prepared('judy')), Buffer.alloc(10));
  assert.deepEqual((await listPreparedVoices(folder)).map(file => file.name), [prepared('judy')]);
  assert.deepEqual(await clearPreparedVoices(folder), {files: 1, bytes: 10});
  assert.ok(existsSync(target)); assert.ok(existsSync(join(folder, prepared('linked', 5))));
  assert.deepEqual(await survivors(root), SURVIVORS);
});

test('commands: version 1, a safe id, measure or clear, a sane time', () => {
  const now = 1_000_000, good = {version: 1, id: 'abc:pv:1', action: 'clear', issuedAt: now};
  assert.deepEqual(parsePreparedVoicesCommand(JSON.stringify(good), now), {id: 'abc:pv:1', action: 'clear'});
  assert.deepEqual(parsePreparedVoicesCommand(JSON.stringify({...good, action: 'measure'}), now), {id: 'abc:pv:1', action: 'measure'});
  for (const bad of [{...good, action: 'delete'}, {...good, action: 'clear-all'}, {...good, version: 2}, {...good, id: '../x'}, {...good, id: ''},
    {...good, issuedAt: now + 60_000}, {...good, issuedAt: -1}, {...good, issuedAt: 1.5}, [], null, 'text'])
    assert.equal(parsePreparedVoicesCommand(JSON.stringify(bad), now), null, JSON.stringify(bad));
  assert.equal(parsePreparedVoicesCommand('{not json', now), null);
  assert.equal(parsePreparedVoicesCommand('x'.repeat(5000), now), null);
  assert.equal(parsePreparedVoicesCommand(undefined, now), null);
});

test('the control measures on request, clears on request, publishes the result and ignores a repeated or stale command', async () => {
  const {root, folder, config} = await workDirectory();
  await writeFile(join(folder, prepared('judy')), Buffer.alloc(1500));
  await writeFile(join(folder, prepared('panam', 2)), Buffer.alloc(500));
  const commandPath = join(root, 'prepared-voices-command.json'), statePath = join(root, 'prepared-voices-state.json');
  let clock = 5_000_000;
  const stale = {version: 1, id: 'old:pv:1', action: 'clear', issuedAt: clock};
  await writeFile(commandPath, JSON.stringify(stale));                  // left by an earlier session: never run
  const control = await new PreparedVoicesControl({folder: () => preparedVoicesFolder(config), commandPath, statePath, now: () => clock}).open();
  await control.poll();
  assert.equal(await measurePreparedVoices(folder).then(m => m.files), 2);
  assert.equal(existsSync(statePath), false);                           // nothing is measured until the page asks
  const send = async (id, action) => { clock += 1000; await writeFile(commandPath, JSON.stringify({version: 1, id, action, issuedAt: clock})); await control.poll(); return JSON.parse(await readFile(statePath, 'utf8')); };
  const measured = await send('s:pv:1', 'measure');
  assert.deepEqual([measured.state, measured.files, measured.bytes, measured.result], ['ready', 2, 2000, {id: 's:pv:1', state: 'measured'}]);
  assert.equal(measured.version, 1); assert.equal(typeof measured.updated, 'number');
  assert.equal((await measurePreparedVoices(folder)).files, 2);         // measuring deletes nothing
  const cleared = await send('s:pv:2', 'clear');
  assert.deepEqual([cleared.state, cleared.files, cleared.bytes, cleared.result], ['ready', 0, 0, {id: 's:pv:2', state: 'cleared', files: 2, bytes: 2000}]);
  assert.deepEqual(await survivors(root), SURVIVORS);
  await writeFile(join(folder, prepared('river', 3)), Buffer.alloc(100));
  await control.poll();                                                 // the same command file again: not repeated
  assert.equal((await measurePreparedVoices(folder)).files, 1);
  await writeFile(commandPath, '{garbage'); await control.poll();       // unreadable: nothing happens
  assert.equal((await measurePreparedVoices(folder)).files, 1);
  assert.equal(JSON.parse(await readFile(statePath, 'utf8')).result.id, 's:pv:2');
});

test('with no prepared-voices folder named by the voice setup the control answers unavailable and deletes nothing', async () => {
  const {root, folder} = await workDirectory();
  await writeFile(join(folder, prepared('judy')), Buffer.alloc(10));
  const commandPath = join(root, 'cmd.json'), statePath = join(root, 'state.json');
  const control = await new PreparedVoicesControl({folder: () => null, commandPath, statePath, now: () => 7_000_000}).open();
  await writeFile(commandPath, JSON.stringify({version: 1, id: 'x:pv:1', action: 'clear', issuedAt: 7_000_000}));
  await control.poll();
  const state = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(state.state, 'unavailable'); assert.deepEqual(state.result, {id: 'x:pv:1', state: 'failed'});
  assert.equal((await measurePreparedVoices(folder)).files, 1);
  await rm(root, {recursive: true, force: true});
});
