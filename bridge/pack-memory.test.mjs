import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {basename, dirname, join} from 'node:path';
import {mkdtemp, readFile, writeFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {AddonHost, fixedProvider, sharedMemory, validateManifest} from './addons.mjs';
import {AddonContent} from './addon-content.mjs';
import {MemoryStore} from './memory-store.mjs';
import {MistralMemory} from './mistral-memory.mjs';
import {VendorMemory} from './vendor-memory.mjs';
import {PersonaBook} from './mistral-prompt.mjs';
import {TextProviderHost, mistralRoute} from './text-provider-host.mjs';
import {CharacterEditor} from './character-editor.mjs';
import {CharacterOverrides} from './character-overrides.mjs';
import {MEMORY_KEY, MEMORY_FILE_NAME, baseOf, fileScope, memoryScopes, overflowing, scopeOf, scopedMemory} from './memory-scope.mjs';

// A content pack that says memory "separate" (add-on API 1.1, bridge/addon-content.mjs) gives the characters a memory of their own while it is on, in every per-character store
// the text providers keep (bridge/memory-scope.mjs). The normal memory is never touched by it: no copy, no move, no delete, and Forget acts on the memory in use only.
const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const T0 = 1_700_000_000_000;
const DIR = join('virtual', 'local-memory');
const file = (key, player = 'player') => join(DIR, player, key + '.json');
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(done => setImmediate(done)); };

const pack = (id, memory, extra = {}) => ({id, name: `${id[0].toUpperCase()}${id.slice(1)} AI NPCs`, version: '1.0.0', requires: '1.1',
  content: {worldRules: ['People bow to lords.'], ...(memory ? {memory} : {})}, ...extra});
const dirOf = id => `/mods/AiNpcCyberpunkMod${id[0].toUpperCase()}${id.slice(1)}`;
function packs(...manifests) {
  const host = new AddonHost({addons: manifests.map(value => validateManifest(value, dirOf(value.id)))});
  const content = new AddonContent({host});
  const flip = values => host.observeSettings(JSON.stringify({version: 1, addons: Object.fromEntries(Object.entries(values).map(([id, on]) => [id, {contentEnabled: on}]))}));
  return {host, content, flip, scopes: memoryScopes(content)};
}

function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const missing = path => Object.assign(new Error('ENOENT ' + path), {code: 'ENOENT'});
  const api = {
    read: async path => { if (!files.has(path)) throw missing(path); return files.get(path); },
    write: async (path, text) => { files.set(path, text); return true; },
    readdir: async dir => {
      const names = [...files.keys()].filter(path => dirname(path) === dir).map(path => basename(path));
      if (!names.length) throw missing(dir);
      return names;
    },
    rename: async (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from); },
    remove: async path => { files.delete(path); },
  };
  return {files, api, names: dir => [...files.keys()].filter(path => dirname(path) === dir).map(path => basename(path)).sort()};
}
const openStore = async (fs, extra = {}) => MemoryStore.open({dir: DIR, now: () => T0, setTimer: () => ({unref() {}}), clearTimer() {}, ...fs.api, ...extra});

// ---- the mapping --------------------------------------------------------------------------------------------------------------------------

test('the key: the profile key with no pack, with a pack that shares its memory and while the pack is off; <key>@<pack> while a separate pack is on, and a switch counts at once', () => {
  const none = memoryScopes(new AddonContent({host: new AddonHost({addons: []})}));
  assert.equal(none.keyFor('judy-alvarez'), 'judy-alvarez');
  assert.equal(none.scope(), null);
  const shared = packs(pack('medieval'), pack('plain', 'shared'));
  assert.equal(shared.scopes.keyFor('judy-alvarez'), 'judy-alvarez', 'a pack without the flag shares the memory');
  assert.equal(shared.scopes.scope(), null);

  const one = packs(pack('medieval', 'separate'));
  assert.equal(one.scopes.scope(), 'medieval');
  assert.equal(one.scopes.keyFor('judy-alvarez'), 'judy-alvarez@medieval');
  assert.equal(one.scopes.packName(), 'Medieval AI NPCs');
  one.flip({medieval: false});
  assert.equal(one.scopes.keyFor('judy-alvarez'), 'judy-alvarez', 'off: the normal memory');
  assert.equal(one.scopes.scope(), null);
  assert.equal(one.scopes.packName(), null);
  one.flip({medieval: true});
  assert.equal(one.scopes.keyFor('judy-alvarez'), 'judy-alvarez@medieval', 'on again: the pack\'s memory');

  // An add-on speaker, a character the player made, and a key that already has a pack are never changed.
  assert.equal(one.scopes.keyFor('addon-skippy-gun'), 'addon-skippy-gun');
  assert.equal(one.scopes.keyFor('custom-my-friend'), 'custom-my-friend');
  assert.equal(one.scopes.keyFor('judy-alvarez@medieval'), 'judy-alvarez@medieval');
  assert.equal(one.scopes.keyFor(undefined), undefined);
  // An ordinary NPC (npc-...) is a profile key like the others: its in-memory conversations are kept apart too.
  assert.equal(one.scopes.keyFor('npc-gang-maelstrom'), 'npc-gang-maelstrom@medieval');
  // Two separate packs: the last one on (folder-name order) has the memory, as the bridge says.
  const two = packs(pack('aaa', 'separate'), pack('zzz', 'separate'));
  assert.equal(two.scopes.scope(), 'zzz');
  two.flip({zzz: false});
  assert.equal(two.scopes.scope(), 'aaa');
});

test('keys and file names: a pack\'s key fits the validators, has no way out of the folder, and tells the memories apart', () => {
  for (const key of ['judy-alvarez', 'judy-alvarez@medieval', 'a@bc', 'x'.repeat(80) + '@' + 'y'.repeat(24)]) {
    assert.ok(MEMORY_KEY.test(key), key);
    assert.ok(MEMORY_FILE_NAME.test(key + '.json'), key);
  }
  for (const key of ['judy@', '@medieval', 'judy@@medieval', 'judy@medieval@x', 'judy@Medieval', 'judy@1abc', 'judy/..@medieval', 'judy@med/ieval', 'judy@med.ieval', '..@medieval', 'x'.repeat(81) + '@abc',
    'judy@' + 'y'.repeat(25), 'Judy@medieval']) {
    assert.ok(!MEMORY_KEY.test(key), key);
    assert.ok(!MEMORY_FILE_NAME.test(key + '.json'), key);
  }
  assert.deepEqual([scopeOf('judy'), scopeOf('judy@medieval'), baseOf('judy'), baseOf('judy@medieval')], ['', 'medieval', 'judy', 'judy']);
  assert.deepEqual(['judy.json', 'judy@medieval.json', 'judy@medieval.json.corrupt', 'notes.txt'].map(fileScope), ['', 'medieval', 'medieval', '']);
  // Each memory keeps its own number of characters.
  const rows = new Map([['a', {updated: 1}], ['b', {updated: 2}], ['c', {updated: 3}], ['a@p', {updated: 0}], ['b@p', {updated: 5}]]);
  assert.deepEqual(overflowing(rows, 2), ['a']);
  assert.deepEqual(overflowing(rows, 5), []);
  assert.deepEqual(overflowing(new Map([['a', {updated: 1}], ['b', {updated: 2}], ['c', {updated: 3}]]), 2), ['a'], 'one memory: the least recent, as before');
});

// ---- the memory store ---------------------------------------------------------------------------------------------------------------------

test('the store keeps the two memories apart: no cross reads, own files, both loaded back, the normal one untouched by a round trip on -> off -> on', async () => {
  const fs = fakeFs();
  const store = await openStore(fs);
  store.record({profileKey: 'judy-alvarez', v: 'Hello Judy', r: 'Hey V.'});
  store.record({profileKey: 'judy-alvarez@medieval', v: 'Hail, lady', r: 'Well met, ser.'});
  store.record({profileKey: 'judy-alvarez@medieval', channel: 'phone', v: 'A raven for you', r: 'I read it.'});
  assert.deepEqual(store.recall({profileKey: 'judy-alvarez'}).turns.map(turn => turn.v), ['Hello Judy']);
  assert.deepEqual(store.recall({profileKey: 'judy-alvarez@medieval'}).turns.map(turn => turn.v), ['Hail, lady']);
  assert.deepEqual(store.recall({profileKey: 'judy-alvarez', channel: 'phone'}).turns, [], 'the pack\'s phone talk is not in the normal one');
  assert.deepEqual(store.recall({profileKey: 'judy-alvarez@medieval', channel: 'phone'}).turns.map(turn => turn.v), ['A raven for you']);
  // Facts and the summary (what "Picked up in your talks" and the older-talks summary show) live in their own rows.
  assert.equal(store.setSummary('judy-alvarez@medieval', 'Judy serves the court.'), 'Judy serves the court.');
  assert.equal(store.setSummary('judy-alvarez', 'Judy edits braindances.'), 'Judy edits braindances.');
  assert.equal(store.recall({profileKey: 'judy-alvarez'}).summary, 'Judy edits braindances.');
  assert.equal(store.recall({profileKey: 'judy-alvarez@medieval'}).summary, 'Judy serves the court.');
  assert.deepEqual(store.listRecords('judy-alvarez'), []);
  await store.flush();
  assert.deepEqual(fs.names(join(DIR, 'player')), ['judy-alvarez.json', 'judy-alvarez@medieval.json']);
  assert.equal(JSON.parse(fs.files.get(file('judy-alvarez@medieval'))).profileKey, 'judy-alvarez@medieval');
  const normalBefore = fs.files.get(file('judy-alvarez'));

  // A new run reads both files back, each under its own key.
  const again = await openStore(fs);
  assert.deepEqual(again.recall({profileKey: 'judy-alvarez'}).turns.map(turn => turn.v), ['Hello Judy']);
  assert.deepEqual(again.recall({profileKey: 'judy-alvarez@medieval'}).turns.map(turn => turn.v), ['Hail, lady']);
  assert.equal(again.size, 2);
  // The pack is off, the normal talk goes on, the pack is on again: the pack's memory resumes where it was left.
  again.record({profileKey: 'judy-alvarez', v: 'Second line', r: 'Yes?'});
  assert.deepEqual(again.recall({profileKey: 'judy-alvarez@medieval'}).turns.map(turn => turn.v), ['Hail, lady']);
  await again.flush();
  assert.equal(fs.files.get(file('judy-alvarez@medieval')), JSON.stringify(JSON.parse(fs.files.get(file('judy-alvarez@medieval')))), 'the pack\'s file is as the store wrote it');
  assert.notEqual(fs.files.get(file('judy-alvarez')), normalBefore, 'the normal memory kept growing in its own file');
  assert.equal(JSON.parse(fs.files.get(file('judy-alvarez@medieval'))).channels.private.length, 1, 'and the pack\'s did not');
});

test('each memory has its own character limit: a pack\'s talks never push the normal ones out', async () => {
  const fs = fakeFs();
  let now = T0;
  const store = await openStore(fs, {limits: {characters: 2}, now: () => ++now});
  store.record({profileKey: 'a', v: 'one', r: 'one'});
  store.record({profileKey: 'b', v: 'two', r: 'two'});
  for (const key of ['a@medieval', 'b@medieval', 'c@medieval']) store.record({profileKey: key, v: 'x', r: 'y'});
  assert.deepEqual([...store.rows.keys()].sort(), ['a', 'b', 'b@medieval', 'c@medieval'],'the normal two stay; the pack\'s oldest went');
  assert.equal(store.recall({profileKey: 'a'}).turns.length, 1);
  await store.flush();
  assert.deepEqual(fs.names(join(DIR, 'player')), ['a.json', 'b.json', 'b@medieval.json', 'c@medieval.json']);
});

test('ordinary NPCs\' in-memory talks are kept apart too, and Forget clears the ones of its memory only', async () => {
  for (const make of [async () => openStore(fakeFs()), async () => MistralMemory.open({path: null})]) {
    const memory = await make();
    memory.record({profileKey: 'npc-gang', ambientKey: 'npc-gang:1', v: 'normal', r: 'normal reply'});
    memory.record({profileKey: 'npc-gang@medieval', ambientKey: 'npc-gang:1', v: 'pack', r: 'pack reply'});
    assert.deepEqual(memory.recall({profileKey: 'npc-gang', ambientKey: 'npc-gang:1'}).turns.map(turn => turn.v), ['normal']);
    assert.deepEqual(memory.recall({profileKey: 'npc-gang@medieval', ambientKey: 'npc-gang:1'}).turns.map(turn => turn.v), ['pack']);
    memory.forget({all: true, scope: 'medieval'});
    assert.deepEqual(memory.recall({profileKey: 'npc-gang@medieval', ambientKey: 'npc-gang:1'}).turns, []);
    assert.deepEqual(memory.recall({profileKey: 'npc-gang', ambientKey: 'npc-gang:1'}).turns.map(turn => turn.v), ['normal'], 'the normal talk stays');
    memory.forget({all: true});
    assert.deepEqual(memory.recall({profileKey: 'npc-gang', ambientKey: 'npc-gang:1'}).turns, []);
  }
});

test('Forget acts on the memory in use only: everything of the pack leaves the normal one intact, everything normal leaves the pack\'s, and one character likewise', async () => {
  const fs = fakeFs({[join(DIR, 'player', 'stray.txt')]: 'x'});
  const store = await openStore(fs);
  for (const key of ['judy-alvarez', 'panam', 'judy-alvarez@medieval', 'panam@medieval']) store.record({profileKey: key, v: `to ${key}`, r: 'ok'});
  await store.flush();
  assert.equal(fs.names(join(DIR, 'player')).length, 5);

  // A character of the pack: only its file goes.
  assert.equal(store.forget({profileKeys: ['judy-alvarez@medieval']}), 1);
  await store.flush();
  assert.deepEqual(fs.names(join(DIR, 'player')), ['judy-alvarez.json', 'panam.json', 'panam@medieval.json', 'stray.txt']);
  assert.deepEqual(store.recall({profileKey: 'judy-alvarez@medieval'}).turns, []);
  assert.equal(store.recall({profileKey: 'judy-alvarez'}).turns.length, 1);

  // Everything of the pack.
  store.record({profileKey: 'judy-alvarez@medieval', v: 'again', r: 'ok'});
  assert.equal(store.forget({all: true, scope: 'medieval'}), 2);
  await store.flush();
  assert.deepEqual(fs.names(join(DIR, 'player')), ['judy-alvarez.json', 'panam.json', 'stray.txt']);
  assert.deepEqual([...store.rows.keys()].sort(), ['judy-alvarez', 'panam']);

  // Everything normal (the pack off): the pack's files stay.
  store.record({profileKey: 'panam@medieval', v: 'back', r: 'ok'});
  await store.flush();
  assert.equal(store.forget({all: true}), 2, 'without a scope, the normal memory');
  await store.flush();
  assert.deepEqual(fs.names(join(DIR, 'player')), ['panam@medieval.json'], 'the normal files and the stray file went, the pack\'s stayed');
  assert.deepEqual(store.recall({profileKey: 'panam@medieval'}).turns.map(turn => turn.v), ['back']);
  // A record written after a Forget of one memory is not lost with it.
  store.record({profileKey: 'panam', v: 'after', r: 'ok'});
  await store.flush();
  assert.deepEqual(fs.names(join(DIR, 'player')), ['panam.json', 'panam@medieval.json']);
});

test('Forget everything with no pack anywhere is what it was: the whole folder and the old single file go', async () => {
  const legacy = join('virtual', 'mistral-memory.json');
  const fs = fakeFs({[join(DIR, 'player', 'readme.txt')]: 'x', [legacy]: '{}', [legacy + '.migrated']: '{}', [join(DIR, 'player', 'judy.json.corrupt')]: 'x'});
  const store = await openStore(fs, {legacyPath: legacy});
  store.record({profileKey: 'judy', v: 'a', r: 'b'});
  await store.flush();
  store.forget({all: true});
  await store.flush();
  assert.deepEqual(fs.names(join(DIR, 'player')), []);
  assert.ok(!fs.files.has(legacy) && !fs.files.has(legacy + '.migrated'));
});

test('a damaged file of the pack is kept aside under its own name and the normal one is not involved', async () => {
  const fs = fakeFs({[file('judy@medieval')]: '{ not json', [file('judy')]: JSON.stringify({version: 1, profileKey: 'judy', updated: 1, summary: 'kept', overflow: [], channels: {}, records: []})});
  const store = await openStore(fs);
  assert.equal(store.recall({profileKey: 'judy'}).summary, 'kept');
  store.record({profileKey: 'judy@medieval', v: 'new', r: 'new reply'});
  await store.flush();
  assert.equal(fs.files.get(file('judy@medieval') + '.corrupt'), '{ not json');
  assert.equal(JSON.parse(fs.files.get(file('judy@medieval'))).profileKey, 'judy@medieval');
  store.forget({all: true, scope: 'medieval'});
  await store.flush();
  assert.ok(!fs.files.has(file('judy@medieval')) && !fs.files.has(file('judy@medieval') + '.corrupt'));
  assert.ok(fs.files.has(file('judy')));
});

test('MistralMemory (the older store the add-on checks use) follows the same rules', async () => {
  const memory = await MistralMemory.open({path: null});
  memory.record({profileKey: 'judy', v: 'a', r: 'b'});
  memory.record({profileKey: 'judy@medieval', v: 'c', r: 'd'});
  assert.deepEqual(memory.recall({profileKey: 'judy'}).turns.map(turn => turn.v), ['a']);
  assert.deepEqual(memory.recall({profileKey: 'judy@medieval'}).turns.map(turn => turn.v), ['c']);
  assert.equal(memory.forget({all: true, scope: 'medieval'}), 1);
  assert.equal(memory.recall({profileKey: 'judy'}).turns.length, 1);
  assert.equal(memory.forget({all: true}), 1);
  assert.equal(memory.size, 0);
  memory.record({profileKey: 'judy@medieval', v: 'c', r: 'd'});
  assert.equal(memory.forget({profileKeys: ['judy@medieval']}), 1);
  assert.equal(memory.record({profileKey: 'judy@Medieval', v: 'c', r: 'd'}), false, 'a key that is not valid is refused');
});

// ---- the text host: a turn and a summary keep the key they started with ---------------------------------------------------------------------

const rows = [{key: 'judy-alvarez', name: 'Judy Alvarez', kind: 'named', backstory: 'A braindance editor.', speakingStyleDescription: 'Dry.', speakingStyleSampleDialogues: []},
  {key: 'custom-friend', name: 'Friend', kind: 'named', backstory: 'A friend.', speakingStyleDescription: 'Warm.', speakingStyleSampleDialogues: []}];
const turnOf = (text, profileKey = 'judy-alvarez') => ({text, context: '', sessionId: 's', local: {profileKey, name: profileKey === 'judy-alvarez' ? 'Judy Alvarez' : 'Friend', channel: 'private'}});

async function textHost({memory, scopes, onCall, memoryKeyFor = scopes?.keyFor}) {
  const player = {apiKey: 'player-key', noteSuccess() {}, noteLimit() {}, limit: null};
  let calls = 0;
  const chat = async ({messages}) => {
    calls++;
    await onCall?.(calls, messages);
    return {text: calls === 1 ? 'Hey V.' : `Reply ${calls}.`, model: 'm', finishReason: 'stop'};
  };
  const host = new TextProviderHost({provider: fixedProvider(player, 'mistral'), memory, personas: new PersonaBook(rows), routes: {mistral: mistralRoute({provider: player, chat, gapMs: 0})},
    ...(memoryKeyFor ? {memoryKeyFor} : {})});
  return {host, calls: () => calls};
}

test('a turn is remembered in the memory it started in, even when the pack is switched while the model answers; the next turn follows the switch', async () => {
  const fs = fakeFs();
  const store = await openStore(fs);
  const world = packs(pack('medieval', 'separate'));
  const {host} = await textHost({memory: store, scopes: world.scopes, onCall: calls => { if (calls === 1) world.flip({medieval: false}); }});
  try {
    await host.reply(turnOf('Hello from the court'));      // started with the pack on, switched off while the model answered
    await settle();
    assert.deepEqual(store.recall({profileKey: 'judy-alvarez@medieval'}).turns.map(turn => turn.v), ['Hello from the court']);
    assert.deepEqual(store.recall({profileKey: 'judy-alvarez'}).turns, [], 'nothing leaked into the normal memory');
    await host.reply(turnOf('Hello from the street'));     // the pack is off now
    await settle();
    assert.deepEqual(store.recall({profileKey: 'judy-alvarez'}).turns.map(turn => turn.v), ['Hello from the street']);
    assert.equal(store.recall({profileKey: 'judy-alvarez@medieval'}).turns.length, 1);
  } finally { host.close(); }
});

test('the model is shown the memory in use only: what a pack\'s talk said is not in the normal prompt and the other way round', async () => {
  const store = await openStore(fakeFs());
  const world = packs(pack('medieval', 'separate'));
  store.record({profileKey: 'judy-alvarez', v: 'about the braindance', r: 'It is done.'});
  store.record({profileKey: 'judy-alvarez@medieval', v: 'about the dragon', r: 'It is slain.'});
  const seen = [];
  const {host} = await textHost({memory: store, scopes: world.scopes, onCall: (calls, messages) => seen.push(messages.map(message => message.content).join('\n'))});
  try {
    await host.reply(turnOf('Anything new?'));
    world.flip({medieval: false});
    await host.reply(turnOf('And now?'));
    assert.match(seen[0], /about the dragon/);
    assert.doesNotMatch(seen[0], /about the braindance/);
    assert.match(seen[1], /about the braindance/);
    assert.doesNotMatch(seen[1], /about the dragon/);
  } finally { host.close(); }
});

test('a summary started before a switch writes into the memory it started in', async () => {
  const store = await openStore(fakeFs(), {limits: {turns: 1, slide: 0, batch: 1}});
  const world = packs(pack('medieval', 'separate'));
  const summaryAsked = [];
  const {host, calls} = await textHost({memory: store, scopes: world.scopes, onCall: (count, messages) => {
    if (count === 3) { summaryAsked.push(messages.map(message => message.content).join('\n')); world.flip({medieval: false}); }   // the switch happens while the summary is written
  }});
  try {
    await host.reply(turnOf('First line'));
    await host.reply(turnOf('Second line'));    // the first exchange rolls into the overflow: a summary is requested (call 3)
    for (let i = 0; i < 40 && calls() < 3; i++) await settle();
    await settle(); await settle();
    assert.equal(calls(), 3);
    assert.match(summaryAsked[0], /First line/);
    assert.equal(store.recall({profileKey: 'judy-alvarez@medieval'}).summary, 'Reply 3.', 'the pack\'s summary');
    assert.equal(store.recall({profileKey: 'judy-alvarez'}).summary, '', 'the normal memory has none');
    assert.equal(store.rows.get('judy-alvarez@medieval').folding, false);
  } finally { host.close(); }
});

test('with no pack, or a pack that shares its memory, every key is the profile key: the files are the same as without the feature', async () => {
  for (const world of [packs(), packs(pack('medieval'))]) {
    const fs = fakeFs();
    const store = await openStore(fs);
    const {host} = await textHost({memory: store, scopes: world.scopes});
    try {
      await host.reply(turnOf('Hello'));
      await host.reply(turnOf('Hello again', 'custom-friend'));
      await store.flush();
      assert.deepEqual(fs.names(join(DIR, 'player')), ['custom-friend.json', 'judy-alvarez.json'], 'the plain keys, a custom character\'s too');
    } finally { host.close(); }
  }
  // And a host with no memoryKeyFor at all (an add-on host, the checks) behaves as before.
  const store = await openStore(fakeFs());
  const {host} = await textHost({memory: store, memoryKeyFor: null});
  try {
    await host.reply(turnOf('Hello'));
    assert.deepEqual([...store.rows.keys()], ['judy-alvarez']);
  } finally { host.close(); }
});

test('a character the player made is remembered under its own key while a pack is on', async () => {
  const store = await openStore(fakeFs());
  const world = packs(pack('medieval', 'separate'));
  const {host} = await textHost({memory: store, scopes: world.scopes});
  try {
    await host.reply(turnOf('Hello friend', 'custom-friend'));
    assert.deepEqual([...store.rows.keys()], ['custom-friend']);
  } finally { host.close(); }
});

test('the bridge gives the namespace to the Mistral host only: not to an add-on speaker\'s host, which shares the store', () => {
  assert.match(source, /const memoryNamespace = memoryScopes\(addonContent\);/);
  assert.match(source, /const mistralHost = new TextProviderHost\(\{provider: mistral, memory: mistralMemory,[^]*?memoryKeyFor: memoryNamespace\.keyFor,/);
  assert.match(source, /new TextProviderHost\(\{provider: fixedProvider\(mistral, route\), memory: sharedMemory\(mistralMemory\),/);
  const addonHostSource = source.slice(source.indexOf('function addonTextHost('), source.indexOf('// What an add-on speaker\'s turn may use right now'));
  assert.doesNotMatch(addonHostSource, /memoryKeyFor/);
  // An add-on speaker's key is never mapped, whatever pack is on.
  assert.equal(packs(pack('medieval', 'separate')).scopes.keyFor('addon-skippy-gun'), 'addon-skippy-gun');
});

// ---- the editor and Forget ----------------------------------------------------------------------------------------------------------------

test('the character editor shows and edits the memory in use, and not the other', async () => {
  const store = await openStore(fakeFs());
  const world = packs(pack('medieval', 'separate'));
  store.setSummary('judy-alvarez', 'Judy edits braindances.');
  store.setSummary('judy-alvarez@medieval', 'Judy serves the court.');
  const view = scopedMemory(store, world.scopes.keyFor);
  assert.equal(view.recall({profileKey: 'judy-alvarez', channel: 'private'}).summary, 'Judy serves the court.');
  assert.equal(view.setSummary('judy-alvarez', 'Edited in the pack.'), 'Edited in the pack.');
  assert.equal(store.recall({profileKey: 'judy-alvarez@medieval'}).summary, 'Edited in the pack.');
  assert.equal(store.recall({profileKey: 'judy-alvarez'}).summary, 'Judy edits braindances.');
  world.flip({medieval: false});
  assert.equal(view.recall({profileKey: 'judy-alvarez', channel: 'private'}).summary, 'Judy edits braindances.');
  assert.deepEqual(view.listRecords('judy-alvarez'), []);
  assert.equal(view.learns, store.learns);
  // The editor through the view: the page's memory part is the one in use.
  const dir = await mkdtemp(join(tmpdir(), 'pack-memory-'));
  try {
    const personas = new PersonaBook(rows.map(row => ({...row, kind: 'named'})));
    const editor = new CharacterEditor({personas, overrides: await CharacterOverrides.open({dir}), memory: view, route: () => 'mistral'});
    assert.equal(editor.details('judy-alvarez').memory.summary, 'Judy edits braindances.');
    world.flip({medieval: true});
    assert.equal(editor.details('judy-alvarez').memory.summary, 'Edited in the pack.');
    editor.setSummary('judy-alvarez', 'Judy rules the court.');
    assert.equal(store.recall({profileKey: 'judy-alvarez@medieval'}).summary, 'Judy rules the court.');
    assert.equal(store.recall({profileKey: 'judy-alvarez'}).summary, 'Judy edits braindances.', 'the normal memory is untouched');
  } finally { await rm(dir, {recursive: true, force: true}); }
  // Forget from the editor (a deleted character of the player) maps its keys the same way, and a custom key stays as it is.
  store.record({profileKey: 'custom-friend', v: 'a', r: 'b'});
  view.forget({profileKeys: ['custom-friend']});
  assert.deepEqual(store.recall({profileKey: 'custom-friend'}).turns, []);
});

test('the bridge\'s Forget acts on the memory in use at the time of the command, for the text store and for the vendors', () => {
  const quiesce = source.slice(source.indexOf('async function quiescePlayerMemory('), source.indexOf('async function admitPlayerConversation('));
  assert.match(quiesce, /const pack = memoryNamespace\.scope\(\);/);
  assert.match(quiesce, /vendorMemory\.forgetAll\(\{scope: pack\}\)/);
  assert.match(quiesce, /mistralMemory\.forget\(\{all: scope === 'all', profileKeys: \(profileKeys \?\? \[\]\)\.map\(memoryNamespace\.keyFor\), scope: pack\}\)/);
  assert.match(source, /memory: scopedMemory\(mistralMemory, memoryNamespace\.keyFor\)/);
});

// ---- vendors --------------------------------------------------------------------------------------------------------------------------------

async function vendors(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pack-vendors-'));
  const path = join(dir, 'vendor-memory.json');
  return {dir, path, open: () => VendorMemory.open({path, now: () => T0, ...extra})};
}
const VENDOR = 'wat_kab_ripperdoc_01', PROFILE = 'npc-ripperdoc';

test('vendors remember V in two memories: a pack\'s visits are apart from the normal ones, in the same file, and a Forget takes one of them', async () => {
  const w = await vendors();
  try {
    const memory = await w.open();
    await memory.remember({memoryKey: VENDOR, profileKey: PROFILE, playerText: 'Need chrome', replyText: 'Take a look.'});
    await memory.remember({memoryKey: VENDOR, profileKey: PROFILE, playerText: 'Need a potion', replyText: 'Fresh from the cauldron.', scope: 'medieval'});
    const normal = () => memory.contextFor({memoryKey: VENDOR, profileKey: PROFILE});
    const packs_ = () => memory.contextFor({memoryKey: VENDOR, profileKey: PROFILE, scope: 'medieval'});
    assert.match(normal(), /Need chrome/); assert.doesNotMatch(normal(), /potion/);
    assert.match(packs_(), /Need a potion/); assert.doesNotMatch(packs_(), /chrome/);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(w.path, 'utf8')).vendors).sort(), [VENDOR, VENDOR + '@medieval']);
    // A new run reads both back.
    const again = await w.open();
    assert.match(again.contextFor({memoryKey: VENDOR, profileKey: PROFILE}), /Need chrome/);
    assert.match(again.contextFor({memoryKey: VENDOR, profileKey: PROFILE, scope: 'medieval'}), /Need a potion/);
    assert.deepEqual(again.status(), {vendors: 2, exchanges: 2, damagedFileKept: false});
    // Forget the pack's: the normal stays, in the file too.
    assert.deepEqual(await again.forgetAll({scope: 'medieval'}), {ok: true});
    assert.equal(again.contextFor({memoryKey: VENDOR, profileKey: PROFILE, scope: 'medieval'}), '');
    assert.match(again.contextFor({memoryKey: VENDOR, profileKey: PROFILE}), /Need chrome/);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(w.path, 'utf8')).vendors), [VENDOR]);
    // The pack's visits come back after the normal Forget? No: the normal Forget takes the normal ones, and the file goes when nothing is left.
    await again.remember({memoryKey: VENDOR, profileKey: PROFILE, playerText: 'Back again', replyText: 'Welcome.', scope: 'medieval'});
    assert.deepEqual(await again.forgetAll({scope: null}), {ok: true});
    assert.equal(again.contextFor({memoryKey: VENDOR, profileKey: PROFILE}), '');
    assert.match(again.contextFor({memoryKey: VENDOR, profileKey: PROFILE, scope: 'medieval'}), /Back again/);
    assert.deepEqual(Object.keys(JSON.parse(await readFile(w.path, 'utf8')).vendors), [VENDOR + '@medieval']);
    assert.deepEqual(await again.forgetAll({scope: 'medieval'}), {ok: true});
    await assert.rejects(readFile(w.path, 'utf8'), {code: 'ENOENT'}, 'nothing left: the file goes, as before');
    // Everything, with no scope given (the older call): both.
    await again.remember({memoryKey: VENDOR, profileKey: PROFILE, playerText: 'One', replyText: 'Two.'});
    await again.remember({memoryKey: VENDOR, profileKey: PROFILE, playerText: 'Three', replyText: 'Four.', scope: 'medieval'});
    assert.deepEqual(await again.forgetAll(), {ok: true});
    assert.deepEqual(again.status(), {vendors: 0, exchanges: 0, damagedFileKept: false});
    // A scope that is not a pack id is refused rather than taken for the normal memory.
    assert.equal(await again.remember({memoryKey: VENDOR, profileKey: PROFILE, playerText: 'x', replyText: 'y', scope: '../etc'}), false);
    assert.equal(again.contextFor({memoryKey: VENDOR, profileKey: PROFILE, scope: 'Bad Scope'}), '');
    assert.deepEqual(await again.forgetAll({scope: 'Bad Scope'}), {ok: false});
  } finally { await rm(w.dir, {recursive: true, force: true}); }
});

test('a vendor write that began before a Forget of its memory is discarded, one of the other memory is not', async () => {
  const w = await vendors();
  try {
    const memory = await w.open();
    let release;
    const gate = new Promise(done => { release = done; });
    const slow = memory.remember({memoryKey: VENDOR, profileKey: PROFILE, playerText: 'Slow', replyText: 'Reply.', scope: 'medieval', isCurrent: () => true});
    const other = memory.remember({memoryKey: VENDOR, profileKey: PROFILE, playerText: 'Normal', replyText: 'Reply.'});
    const forgotten = memory.forgetAll({scope: 'medieval'});
    void gate; release();
    assert.equal(await slow, false, 'the pack\'s write began before its Forget');
    assert.equal(await other, true, 'the normal write is not affected');
    await forgotten;
    assert.match(memory.contextFor({memoryKey: VENDOR, profileKey: PROFILE}), /Normal/);
  } finally { await rm(w.dir, {recursive: true, force: true}); }
});

test('each vendor memory has its own limit, and a file over its size gives up its own memory\'s oldest first', async () => {
  const w = await vendors({limits: {vendors: 2}});
  try {
    let now = T0;
    const memory = await VendorMemory.open({path: w.path, now: () => ++now, limits: {vendors: 2}});
    for (const id of ['shop_one', 'shop_two']) await memory.remember({memoryKey: id, profileKey: PROFILE, playerText: 'Hi', replyText: 'Hello.'});
    for (const id of ['shop_one', 'shop_two', 'shop_three']) await memory.remember({memoryKey: id, profileKey: PROFILE, playerText: 'Hi', replyText: 'Hello.', scope: 'medieval'});
    const stored = Object.keys(JSON.parse(await readFile(w.path, 'utf8')).vendors).sort();
    assert.deepEqual(stored, ['shop_one', 'shop_three@medieval', 'shop_two', 'shop_two@medieval']);
  } finally { await rm(w.dir, {recursive: true, force: true}); }
  const small = await vendors({limits: {fileBytes: 700}});
  try {
    let now = T0;
    const memory = await VendorMemory.open({path: small.path, now: () => ++now, limits: {fileBytes: 700}});
    await memory.remember({memoryKey: 'shop_normal', profileKey: PROFILE, playerText: 'Hi', replyText: 'Hello.'});
    for (const id of ['shop_a', 'shop_b', 'shop_c', 'shop_d']) await memory.remember({memoryKey: id, profileKey: PROFILE, playerText: 'x'.repeat(100), replyText: 'y'.repeat(100), scope: 'medieval'});
    const stored = Object.keys(JSON.parse(await readFile(small.path, 'utf8')).vendors);
    assert.ok(stored.includes('shop_normal'), 'the normal visits stayed');
    assert.ok(stored.includes('shop_d@medieval') && !stored.includes('shop_a@medieval'), 'the pack\'s oldest went');
  } finally { await rm(small.dir, {recursive: true, force: true}); }
});

test('the vendor memory the bridge writes names its turn\'s memory once: the context sets it, the delivery uses it', () => {
  assert.match(source, /const vendorScope = prepared => \{\s*let scope = vendorScopes\.get\(prepared\);\s*if \(scope === undefined\) \{ scope = memoryNamespace\.scope\(\); vendorScopes\.set\(prepared, scope\); \}/);
  assert.match(source, /vendorMemory\.contextFor\(\{memoryKey: key, profileKey: prepared\.route\.profileKey, scope: vendorScope\(prepared\)\}\)/);
  assert.match(source, /vendorMemory\.remember\(\{memoryKey: key, profileKey: prepared\.route\.profileKey, scope: vendorScope\(prepared\),/);
});

// ---- what the game is told -----------------------------------------------------------------------------------------------------------

test('the status file tells the game which packs keep a memory of their own; a shared pack adds nothing to its entry', () => {
  const status = packs(pack('medieval', 'separate'), pack('plain', 'shared'), pack('quiet')).host.status();
  const entry = id => status.addons.find(item => item.id === id).content;
  assert.deepEqual(entry('medieval'), {worldRules: 1, prompting: [], memory: 'separate'});
  assert.deepEqual(entry('plain'), {worldRules: 1, prompting: []});
  assert.deepEqual(entry('quiet'), {worldRules: 1, prompting: []});
});

test('an add-on host sees the shared store through the same methods as before', async () => {
  const store = await openStore(fakeFs());
  const view = sharedMemory(store);
  view.record({profileKey: 'addon-skippy-gun', v: 'a', r: 'b'});
  assert.equal(view.recall({profileKey: 'addon-skippy-gun'}).turns.length, 1);
  assert.equal(view.forget({all: true}), 1, 'the older call: the normal memory, which holds the add-on speakers');
});

// A sanity check that the files written for the pack never leave the player's folder.
test('the on-disk name of a pack\'s memory is a plain file in the player\'s folder', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pack-disk-'));
  try {
    const store = await MemoryStore.open({dir, setTimer: () => ({unref() {}}), clearTimer() {}});
    store.record({profileKey: 'judy-alvarez@medieval', v: 'a', r: 'b'});
    store.record({profileKey: 'judy-alvarez', v: 'c', r: 'd'});
    await store.flush();
    assert.deepEqual((await readdir(join(dir, 'player'))).sort(), ['judy-alvarez.json', 'judy-alvarez@medieval.json']);
    const again = await MemoryStore.open({dir, setTimer: () => ({unref() {}}), clearTimer() {}});
    assert.equal(again.recall({profileKey: 'judy-alvarez@medieval'}).turns[0].v, 'a');
    assert.equal(again.recall({profileKey: 'judy-alvarez'}).turns[0].v, 'c');
    again.forget({all: true, scope: 'medieval'});
    await again.flush();
    assert.deepEqual(await readdir(join(dir, 'player')), ['judy-alvarez.json']);
    await writeFile(join(dir, 'player', 'x.txt'), 'x');
  } finally { await rm(dir, {recursive: true, force: true}); }
});
