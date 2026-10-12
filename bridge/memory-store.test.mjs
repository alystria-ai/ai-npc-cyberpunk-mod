import {test} from 'node:test';
import assert from 'node:assert/strict';
import {basename, dirname, join} from 'node:path';
import {MemoryStore, STORE_LIMITS} from './memory-store.mjs';
import {MEMORY_LIMITS} from './mistral-memory.mjs';

const T0 = 1_700_000_000_000;
const DAY = 24 * 3600 * 1000;
const DIR = join('virtual', 'local-memory');
const file = (key, player = 'player') => join(DIR, player, key + '.json');
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise(done => setImmediate(done)); };

// ---- fakes
function vectorOf(text, dim = 256) {
  const vec = new Float32Array(dim);
  for (const word of String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let hash = 2166136261;
    for (const ch of word) hash = Math.imul(hash ^ ch.charCodeAt(0), 16777619) >>> 0;
    vec[hash % dim] += 1;
  }
  const norm = Math.hypot(...vec);
  return norm ? vec.map(value => value / norm) : vec;
}
function fakeEmbedder({id = 'fake-1', dim = 256} = {}) {
  const embedder = {
    id, dim, ok: true, fail: false, hold: null, calls: [],
    available() { return this.ok; },
    async embed(texts) {
      this.calls.push([...texts]);
      if (this.fail) throw new Error('embedder down');
      if (this.hold) await this.hold;
      return texts.map(text => vectorOf(text, dim));
    },
  };
  return embedder;
}
function fakeFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const log = {writes: [], removes: [], renames: []};
  const missing = path => Object.assign(new Error('ENOENT ' + path), {code: 'ENOENT'});
  const api = {
    read: async path => { if (!files.has(path)) throw missing(path); return files.get(path); },
    write: async (path, text) => { log.writes.push(path); if (fs.failWrites) throw Object.assign(new Error('disk full'), {code: 'ENOSPC'}); files.set(path, text); return true; },
    readdir: async dir => {
      const names = [...files.keys()].filter(path => dirname(path) === dir).map(path => basename(path));
      if (!names.length) throw missing(dir);
      return names;
    },
    rename: async (from, to) => { log.renames.push([from, to]); if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from); },
    remove: async path => { log.removes.push(path); files.delete(path); },
  };
  const fs = {files, log, api, failWrites: false, names: dir => [...files.keys()].filter(path => dirname(path) === dir).map(path => basename(path)).sort()};
  return fs;
}
function fakeClock() {
  let now = T0, serial = 0;
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimer(fn, ms) { const timer = {id: ++serial, at: now + ms, fn, unref() { timer.unrefed = true; }}; timers.set(timer.id, timer); return timer; },
    clearTimer(timer) { if (timer) timers.delete(timer.id); },
    get count() { return timers.size; },
    get allUnref() { return [...timers.values()].every(timer => timer.unrefed); },
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.values()].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!next) break;
        timers.delete(next.id); now = Math.max(now, next.at); next.fn(); await settle();
      }
      now = end; await settle();
    },
    set(value) { now = value; },
  };
  return clock;
}
async function setup({files = {}, embedder = fakeEmbedder(), extractor, ...rest} = {}) {
  const fs = fakeFs(files), clock = fakeClock(), state = {gate: true};
  const store = await MemoryStore.open({dir: DIR, embedder, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    gate: () => state.gate, ...fs.api, ...rest});
  if (extractor) store.setExtractor(extractor);
  return {store, fs, clock, state, embedder};
}
const encode = vec => Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength).toString('base64');
function seedFile(files, key, records, {embedder = fakeEmbedder(), summary = '', player = 'player', pending = [], updated = T0} = {}) {
  files[file(key, player)] = JSON.stringify({
    version: 1, profileKey: key, updated, summary, overflow: [], channels: {private: [], phone: [], group: []},
    embedder: {id: embedder.id, dim: embedder.dim}, pending,
    records: records.map((record, i) => ({id: record.id ?? 'r' + i, kind: record.kind ?? 'fact', text: record.text, created: T0, updated: record.updated ?? T0,
      importance: record.importance ?? 0.5, pinned: !!record.pinned, source: 'chat', v: encode(vectorOf(record.text, embedder.dim))})),
  });
}
const exchange = (store, key, count, extra = {}) => { for (let i = 0; i < count; i++) store.record({profileKey: key, v: `question ${i}`, r: `answer ${i}`, ...extra}); };
const fact = (text, extra = {}) => ({text, kind: 'fact', importance: 0.5, ...extra});
const saved = (fs, key) => JSON.parse(fs.files.get(file(key)));

// ---- history and summary: the MistralMemory behaviour
test('the history keeps the last turns per character and channel; the rest rolls into the overflow', async () => {
  const memory = await MemoryStore.open({});
  exchange(memory, 'judy-alvarez', 12);
  exchange(memory, 'judy-alvarez', 3, {channel: 'phone'});
  const recalled = memory.recall({profileKey: 'judy-alvarez', channel: 'private'});
  assert.equal(recalled.turns.length, MEMORY_LIMITS.turns);
  assert.equal(recalled.turns[0].v, 'question 4');
  assert.equal(recalled.turns.at(-1).r, 'answer 11');
  assert.equal(memory.recall({profileKey: 'judy-alvarez', channel: 'phone'}).turns.length, 3);
  assert.equal(memory.recall({profileKey: 'panam-palmer'}).turns.length, 0);
  assert.equal(memory.pendingSummary('judy-alvarez'), null);
});

test('lines are cleaned and capped, and an empty side is not recorded', async () => {
  const memory = await MemoryStore.open({});
  assert.equal(memory.record({profileKey: 'judy-alvarez', v: '  hi\u0000\n there  ', r: 'x'.repeat(2000)}), true);
  const [turn] = memory.recall({profileKey: 'judy-alvarez'}).turns;
  assert.equal(turn.v, 'hi there');
  assert(turn.r.length <= MEMORY_LIMITS.line);
  assert.equal(memory.record({profileKey: 'judy-alvarez', v: '', r: 'answer'}), false);
  assert.equal(memory.record({profileKey: 'Bad Key!', v: 'a', r: 'b'}), false);
  assert.equal(memory.record({profileKey: 'judy-alvarez', channel: 'nowhere', v: 'a', r: 'b'}), false);
});

test('older exchanges are folded into a summary in batches; the summary goes to private and phone, not group', async () => {
  const memory = await MemoryStore.open({});
  exchange(memory, 'panam-palmer', MEMORY_LIMITS.turns + MEMORY_LIMITS.batch);
  const batch = memory.pendingSummary('panam-palmer');
  assert.equal(batch.turns.length, MEMORY_LIMITS.batch);
  assert.equal(batch.turns[0].v, 'question 0');
  memory.beginSummary('panam-palmer');
  assert.equal(memory.pendingSummary('panam-palmer'), null);
  assert.equal(memory.applySummary('panam-palmer', 'I told V about the Aldecaldos.', batch), true);
  assert.equal(memory.recall({profileKey: 'panam-palmer'}).summary, 'I told V about the Aldecaldos.');
  assert.equal(memory.recall({profileKey: 'panam-palmer', channel: 'phone'}).summary, 'I told V about the Aldecaldos.');
  assert.equal(memory.recall({profileKey: 'panam-palmer', channel: 'group'}).summary, '');
  assert.equal(memory.pendingSummary('panam-palmer'), null);
});

test('a failed summary leaves the exchanges for a later try', async () => {
  const memory = await MemoryStore.open({});
  exchange(memory, 'panam-palmer', MEMORY_LIMITS.turns + MEMORY_LIMITS.batch);
  memory.beginSummary('panam-palmer');
  memory.failSummary('panam-palmer');
  assert.equal(memory.pendingSummary('panam-palmer').turns.length, MEMORY_LIMITS.batch);
});

test('the overflow is bounded; a group conversation never feeds the summary', async () => {
  const memory = await MemoryStore.open({});
  exchange(memory, 'jackie-welles', MEMORY_LIMITS.turns + MEMORY_LIMITS.overflow + 30);
  assert.equal(memory.pendingSummary('jackie-welles').turns[0].v, 'question 30');
  const group = await MemoryStore.open({});
  exchange(group, 'jackie-welles', 40, {channel: 'group'});
  assert.equal(group.recall({profileKey: 'jackie-welles', channel: 'group'}).turns.length, MEMORY_LIMITS.turns);
  assert.equal(group.pendingSummary('jackie-welles'), null);
});

test('ordinary NPC conversations are remembered only in memory, bounded, and never written', async () => {
  const {store, fs, clock} = await setup();
  exchange(store, 'npc-food-vendor-male', 12, {ambientKey: 'vendor-1'});
  const recalled = store.recall({profileKey: 'npc-food-vendor-male', ambientKey: 'vendor-1'});
  assert.equal(recalled.turns.length, MEMORY_LIMITS.turns);
  assert.equal(recalled.summary, '');
  assert.equal(store.recall({profileKey: 'npc-food-vendor-male', ambientKey: 'vendor-2'}).turns.length, 0);
  for (let i = 0; i < MEMORY_LIMITS.ambient + 10; i++) store.record({profileKey: 'npc-x', ambientKey: `npc-${i}`, v: 'a', r: 'b'});
  assert(store.ambient.size <= MEMORY_LIMITS.ambient);
  await store.flush(); await clock.advance(5000);
  assert.equal(fs.log.writes.length, 0);
  assert.equal(fs.files.size, 0);
  assert.equal(store.size, 0);
  assert.equal(clock.count, 0, 'no timers without pending work');
});

test('forget clears one character or everything, and a summary requested before it is not applied after it', async () => {
  const memory = await MemoryStore.open({});
  exchange(memory, 'judy-alvarez', MEMORY_LIMITS.turns + MEMORY_LIMITS.batch);
  exchange(memory, 'panam-palmer', 3);
  exchange(memory, 'npc-x', 2, {ambientKey: 'a'});
  const batch = memory.pendingSummary('judy-alvarez');
  memory.beginSummary('judy-alvarez');
  assert.equal(memory.forget({profileKeys: ['judy-alvarez']}), 1);
  assert.equal(memory.applySummary('judy-alvarez', 'late summary', batch), false);
  assert.equal(memory.recall({profileKey: 'judy-alvarez'}).summary, '');
  assert.equal(memory.recall({profileKey: 'judy-alvarez'}).turns.length, 0);
  assert.equal(memory.recall({profileKey: 'panam-palmer'}).turns.length, 3);
  assert.equal(memory.recall({profileKey: 'npc-x', ambientKey: 'a'}).turns.length, 0);
  assert.equal(memory.forget({all: true}), 1);
  assert.equal(memory.size, 0);
});

test('the number of remembered characters is bounded; the least recently talked-to go first, and their files go too', async () => {
  const {store, fs, clock} = await setup({limits: {...MEMORY_LIMITS, characters: 3}});
  for (const key of ['a1', 'b1', 'c1', 'd1']) { exchange(store, key, 1); await clock.advance(10); }
  assert.equal(store.size, 3);
  assert.equal(store.recall({profileKey: 'a1'}).turns.length, 0);
  assert.equal(store.recall({profileKey: 'd1'}).turns.length, 1);
  await clock.advance(1000);
  assert.deepEqual(fs.names(join(DIR, 'player')), ['b1.json', 'c1.json', 'd1.json']);
});

// ---- file layout and saving
test('one file per player and character, debounced, and only the changed character is rewritten', async () => {
  const {store, fs, clock} = await setup({playerId: 'Player One!'});
  exchange(store, 'judy-alvarez', 2);
  exchange(store, 'panam-palmer', 1);
  await clock.advance(799);
  assert.equal(fs.log.writes.length, 0);
  await clock.advance(1);
  assert.deepEqual(fs.names(join(DIR, 'player-one')), ['judy-alvarez.json', 'panam-palmer.json']);
  const judy = JSON.parse(fs.files.get(join(DIR, 'player-one', 'judy-alvarez.json')));
  assert.equal(judy.version, 1);
  assert.equal(judy.profileKey, 'judy-alvarez');
  assert.equal(judy.channels.private.length, 2);
  assert.deepEqual(judy.records, []);
  assert.deepEqual(judy.pending, []);
  assert.equal(judy.embedder, null);
  assert.equal(clock.count, 0, 'the save timer is gone once nothing is dirty');
  fs.log.writes.length = 0;
  exchange(store, 'panam-palmer', 1);
  await clock.advance(800);
  assert.deepEqual(fs.log.writes.map(path => basename(path)), ['panam-palmer.json']);
});

test('the store reloads what it saved', async () => {
  const first = await setup();
  exchange(first.store, 'judy-alvarez', 3);
  first.store.beginSummary('judy-alvarez');
  await first.store.flush();
  const again = await setup({files: Object.fromEntries(first.fs.files)});
  assert.equal(again.store.recall({profileKey: 'judy-alvarez'}).turns[2].r, 'answer 2');
  assert.equal(again.store.size, 1);
});

test('unreadable, oversized, foreign and mislabelled files are skipped on open', async () => {
  const files = {
    [file('broken')]: 'not json', [file('big')]: JSON.stringify({version: 1, profileKey: 'big', summary: 'x'.repeat(200)}),
    [file('wrong-name')]: JSON.stringify({version: 1, profileKey: 'other'}), [join(DIR, 'player', 'Upper.json')]: '{}',
    [file('old')]: JSON.stringify({version: 2, profileKey: 'old'}),
    [file('fine')]: JSON.stringify({version: 1, profileKey: 'fine', summary: 's', channels: {private: [{v: 'a', r: 'b'}, {v: '', r: 'x'}]}}),
  };
  const {store} = await setup({files, limits: {characterBytes: 150}});
  assert.equal(store.size, 1);
  assert.equal(store.recall({profileKey: 'fine'}).turns.length, 1);
  assert.equal(store.recall({profileKey: 'fine'}).summary, 's');
});

// ---- migration
const legacy = () => JSON.stringify({version: 1, updated: 5, characters: {
  'judy-alvarez': {summary: 'Judy summary', overflow: [{v: 'o', r: 'p', at: 1}], channels: {private: [{v: 'hi', r: 'hello', at: 2}], phone: [{v: 'ring', r: 'yes', at: 3}], group: []}, updated: 9},
  'panam-palmer': {summary: 'old Panam', overflow: [], channels: {private: [{v: 'x', r: 'y', at: 1}]}, updated: 4},
  'Bad Key': {summary: 'x', channels: {}},
}});
const LEGACY = join('virtual', 'mistral-memory.json');

test('migration imports the legacy file into character files, never over an existing one, and renames it last', async () => {
  const files = {[LEGACY]: legacy()};
  seedFile(files, 'panam-palmer', [], {summary: 'newer Panam'});
  const before = files[file('panam-palmer')];
  const {store, fs} = await setup({files, legacyPath: LEGACY});
  const judy = saved(fs, 'judy-alvarez');
  assert.equal(judy.summary, 'Judy summary');
  assert.equal(judy.overflow.length, 1);
  assert.equal(judy.channels.private[0].r, 'hello');
  assert.equal(judy.channels.phone[0].v, 'ring');
  assert.equal(fs.files.get(file('panam-palmer')), before, 'an existing character file is untouched');
  assert.equal(store.recall({profileKey: 'panam-palmer'}).summary, 'newer Panam');
  assert.equal(store.recall({profileKey: 'judy-alvarez'}).summary, 'Judy summary');
  assert.equal(fs.files.has(LEGACY), false);
  assert.equal(fs.files.get(LEGACY + '.migrated'), legacy());
  assert.equal(fs.files.has(file('bad-key')), false);
  assert.equal(store.size, 2);
});

test('migration is idempotent and does nothing the second time', async () => {
  const first = await setup({files: {[LEGACY]: legacy()}, legacyPath: LEGACY});
  const again = await setup({files: Object.fromEntries(first.fs.files), legacyPath: LEGACY});
  assert.equal(again.fs.log.writes.length, 0);
  assert.equal(again.fs.log.renames.length, 0);
  assert.equal(again.store.size, 2);
});

test('migration is crash-safe: the legacy file stays until every character file is written, and a retry finishes it', async () => {
  const files = {[LEGACY]: legacy()};
  const fs = fakeFs(files);
  fs.failWrites = true;
  const options = {dir: DIR, legacyPath: LEGACY, ...fs.api};
  await MemoryStore.open(options);
  assert.equal(fs.files.has(LEGACY), true);
  assert.equal(fs.files.has(LEGACY + '.migrated'), false);
  assert.equal(fs.names(join(DIR, 'player')).length, 0);
  fs.failWrites = false;
  const retry = await MemoryStore.open(options);
  assert.equal(fs.files.has(LEGACY), false);
  assert.equal(retry.size, 2);
  assert.equal(saved(fs, 'judy-alvarez').summary, 'Judy summary');
});

test('migration works without an embedder', async () => {
  const {store} = await setup({files: {[LEGACY]: legacy()}, legacyPath: LEGACY, embedder: null});
  assert.equal(store.recall({profileKey: 'judy-alvarez', channel: 'phone'}).turns[0].v, 'ring');
});

// ---- records, vectors and the embedder
test('records round-trip with their vectors', async () => {
  const embedder = fakeEmbedder();
  const files = {};
  seedFile(files, 'judy-alvarez', [{id: 'a', text: 'V likes whiskey', kind: 'preference', importance: 0.7, pinned: true}, {id: 'b', text: 'Judy owes V a favour', kind: 'promise'}]);
  const first = await setup({files, embedder});
  assert.deepEqual(first.store.listRecords('judy-alvarez').map(r => r.id).sort(), ['a', 'b']);
  exchange(first.store, 'judy-alvarez', 1);
  await first.store.flush();
  const document = saved(first.fs, 'judy-alvarez');
  assert.deepEqual(document.embedder, {id: 'fake-1', dim: 256});
  const stored = document.records.find(r => r.id === 'a');
  assert.equal(stored.v, encode(vectorOf('V likes whiskey')));
  assert.equal(stored.kind, 'preference'); assert.equal(stored.pinned, true); assert.equal(stored.importance, 0.7);
  const again = await setup({files: Object.fromEntries(first.fs.files), embedder});
  const hits = await again.store.retrieve({profileKey: 'judy-alvarez', query: 'v whiskey'});
  assert.equal(hits[0].id, 'a');
  assert.deepEqual(Object.keys(hits[0]), ['id', 'kind', 'text']);
});

test('without an embedder (null or unavailable) the store is plain history plus summary and retrieve is empty', async () => {
  for (const embedder of [null, Object.assign(fakeEmbedder(), {ok: false})]) {
    let calls = 0;
    const {store, fs, clock} = await setup({embedder, extractor: async () => { calls++; return [fact('x y z')]; }});
    exchange(store, 'judy-alvarez', 8);
    assert.deepEqual(await store.retrieve({profileKey: 'judy-alvarez', query: 'anything'}), []);
    await clock.advance(60000);
    assert.equal(calls, 0);
    assert.equal(clock.count, 0);
    const document = saved(fs, 'judy-alvarez');
    assert.deepEqual(document.records, []);
    assert.deepEqual(document.pending, []);
    assert.equal(store.recall({profileKey: 'judy-alvarez'}).turns.length, 8);
  }
});

test('records saved with an embedder survive being opened without one', async () => {
  const files = {};
  seedFile(files, 'judy-alvarez', [{id: 'a', text: 'V likes whiskey'}]);
  const {store, fs} = await setup({files, embedder: null});
  assert.deepEqual(await store.retrieve({profileKey: 'judy-alvarez', query: 'v whiskey'}), []);
  exchange(store, 'judy-alvarez', 1);
  await store.flush();
  assert.equal(saved(fs, 'judy-alvarez').records.length, 1);
  assert.equal(saved(fs, 'judy-alvarez').records[0].v, encode(vectorOf('V likes whiskey')));
});

test('a different embedder keeps the text and re-embeds in the background, 8 at a time; until then nothing is retrieved', async () => {
  const files = {};
  seedFile(files, 'judy-alvarez', Array.from({length: 10}, (_, i) => ({id: 'r' + i, text: i === 0 ? 'V likes whiskey' : `unrelated memory number ${i} here`})), {embedder: fakeEmbedder()});
  const next = fakeEmbedder({id: 'fake-2', dim: 128});
  const {store, fs, clock} = await setup({files, embedder: next});
  assert.deepEqual(await store.retrieve({profileKey: 'judy-alvarez', query: 'v whiskey'}), []);
  assert.equal(store.listRecords('judy-alvarez').length, 10, 'the text is kept');
  assert.equal(next.calls.length, 0, 'nothing on open or on the hot path');
  await clock.advance(0);
  assert.deepEqual(next.calls.map(texts => texts.length), [8]);
  await clock.advance(500);
  assert.deepEqual(next.calls.map(texts => texts.length), [8, 2]);
  const hits = await store.retrieve({profileKey: 'judy-alvarez', query: 'v whiskey'});
  assert.equal(hits[0].text, 'V likes whiskey');
  await clock.advance(1000);
  assert.deepEqual(saved(fs, 'judy-alvarez').embedder, {id: 'fake-2', dim: 128});
  assert(saved(fs, 'judy-alvarez').records.every(record => record.v));
  assert.equal(clock.count, 0, 'the work finished and no timer is left');
});

test('re-embedding waits for the gate and backs off after a failure', async () => {
  const files = {};
  seedFile(files, 'judy-alvarez', [{text: 'V likes whiskey'}]);
  const next = fakeEmbedder({id: 'fake-2'});
  next.fail = true;
  const {store, clock, state} = await setup({files, embedder: next});
  state.gate = false;
  await clock.advance(10000);
  assert.equal(next.calls.length, 0);
  state.gate = true;
  await clock.advance(10000);
  assert.equal(next.calls.length, 1);
  await clock.advance(59999); assert.equal(next.calls.length, 1);
  await clock.advance(1); assert.equal(next.calls.length, 2);
  await clock.advance(119999); assert.equal(next.calls.length, 2);
  next.fail = false;
  await clock.advance(1); assert.equal(next.calls.length, 3);
  assert.equal((await store.retrieve({profileKey: 'judy-alvarez', query: 'v whiskey'})).length, 1);
});

test('the number of records per character is capped; pinned and important ones stay', async () => {
  const files = {};
  seedFile(files, 'judy-alvarez', [
    {id: 'a', text: 'alpha one', importance: 0.9}, {id: 'b', text: 'bravo two', importance: 0.1}, {id: 'c', text: 'charlie three', importance: 0.5, pinned: true},
    {id: 'd', text: 'delta four', importance: 0.2}, {id: 'e', text: 'echo five', importance: 0.8}]);
  const {store} = await setup({files, limits: {records: 3}});
  assert.deepEqual(store.listRecords('judy-alvarez').map(r => r.id).sort(), ['a', 'c', 'e']);
});

test('records can be listed, pinned and deleted for the editor', async () => {
  const files = {};
  seedFile(files, 'judy-alvarez', [{id: 'a', text: 'V likes whiskey', updated: T0 - 5}, {id: 'b', text: 'Judy owes V a favour', updated: T0}]);
  const {store, fs, clock} = await setup({files});
  assert.deepEqual(store.listRecords('judy-alvarez').map(r => r.id), ['b', 'a']);
  assert.deepEqual(Object.keys(store.listRecords('judy-alvarez')[0]).sort(), ['id', 'kind', 'pinned', 'text', 'updated']);
  assert.equal(store.pinRecord('judy-alvarez', 'a', true), true);
  assert.equal(store.deleteRecord('judy-alvarez', 'b'), true);
  assert.equal(store.deleteRecord('judy-alvarez', 'zzz'), false);
  assert.equal(store.pinRecord('nobody', 'a', true), false);
  await clock.advance(800);
  const document = saved(fs, 'judy-alvarez');
  assert.deepEqual(document.records.map(r => [r.id, r.pinned]), [['a', true]]);
  assert.deepEqual(await store.retrieve({profileKey: 'judy-alvarez', query: 'judy favour'}), []);
});

// ---- retrieval
const memories = () => {
  const files = {};
  seedFile(files, 'judy-alvarez', [
    {id: 'whiskey', text: 'V likes whiskey'}, {id: 'car', text: 'Panam car broke down near Santo Domingo'},
    {id: 'night', text: 'V drinks whiskey every night at Afterlife'}]);
  return files;
};

test('retrieve ranks by cosine, drops what is below the threshold, and respects k and the budget', async () => {
  const {store} = await setup({files: memories()});
  const ask = options => store.retrieve({profileKey: 'judy-alvarez', query: 'v whiskey', ...options});
  assert.deepEqual((await ask()).map(hit => hit.id), ['whiskey', 'night']);
  assert.deepEqual((await ask({minScore: 0.7})).map(hit => hit.id), ['whiskey']);
  assert.deepEqual((await ask({minScore: 0.99})).map(hit => hit.id), []);
  assert.deepEqual((await ask({k: 1})).map(hit => hit.id), ['whiskey']);
  assert.deepEqual((await ask({budgetChars: 20})).map(hit => hit.id), ['whiskey'], 'the second would exceed the budget');
  assert.deepEqual((await ask({budgetChars: 100})).map(hit => hit.id), ['whiskey', 'night']);
  assert.deepEqual(await store.retrieve({profileKey: 'judy-alvarez', query: 'santo domingo car'}).then(hits => hits.map(h => h.id)), ['car']);
});

test('recency, importance and pinning break ties between equally similar records', async () => {
  const files = {};
  const text = 'V likes whiskey';
  seedFile(files, 'judy-alvarez', [
    {id: 'old', text, updated: T0 - 29 * DAY, importance: 0.5}, {id: 'new', text, updated: T0, importance: 0.5},
    {id: 'important', text, updated: T0, importance: 1}, {id: 'pinned', text, updated: T0 - 29 * DAY, importance: 0, pinned: true},
    {id: 'ancient', text, updated: T0 - 90 * DAY, importance: 0.5}]);
  const {store} = await setup({files});
  const hits = await store.retrieve({profileKey: 'judy-alvarez', query: 'v likes whiskey', k: 5});
  assert.deepEqual(hits.map(hit => hit.id), ['pinned', 'important', 'new', 'old', 'ancient']);
});

test('retrieve is empty for ordinary NPCs, the group channel, an empty query, an unknown character and an aborted call', async () => {
  const {store, embedder} = await setup({files: memories()});
  const base = {profileKey: 'judy-alvarez', query: 'v whiskey'};
  assert.equal((await store.retrieve({...base, channel: 'phone'})).length, 2, 'the phone channel is private');
  assert.deepEqual(await store.retrieve({...base, ambientKey: 'npc-1'}), []);
  assert.deepEqual(await store.retrieve({...base, channel: 'group'}), []);
  assert.deepEqual(await store.retrieve({...base, query: '  \u0000 '}), []);
  assert.deepEqual(await store.retrieve({...base, profileKey: 'panam-palmer'}), []);
  const controller = new AbortController(); controller.abort();
  assert.deepEqual(await store.retrieve({...base, signal: controller.signal}), []);
  assert.equal(embedder.calls.length, 1, 'only the allowed call embedded');
});

test('retrieve never blocks longer than its timeout, and the late result is discarded', async () => {
  const {store, embedder, clock} = await setup({files: memories()});
  let release;
  embedder.hold = new Promise(done => { release = done; });
  const pending = store.retrieve({profileKey: 'judy-alvarez', query: 'v whiskey', timeoutMs: 400});
  let settled = false; pending.then(() => { settled = true; });
  await clock.advance(399); assert.equal(settled, false);
  await clock.advance(1);
  assert.deepEqual(await pending, []);
  release(); await settle();
  assert.equal(clock.count, 0, 'the timeout timer is cleared');
  embedder.hold = null;
  assert.equal((await store.retrieve({profileKey: 'judy-alvarez', query: 'v whiskey'})).length, 2);
});

test('a failing embedder or an abort during retrieve gives an empty result', async () => {
  const {store, embedder} = await setup({files: memories()});
  embedder.fail = true;
  assert.deepEqual(await store.retrieve({profileKey: 'judy-alvarez', query: 'v whiskey'}), []);
  embedder.fail = false;
  let release; embedder.hold = new Promise(done => { release = done; });
  const controller = new AbortController();
  const pending = store.retrieve({profileKey: 'judy-alvarez', query: 'v whiskey', signal: controller.signal});
  controller.abort();
  assert.deepEqual(await pending, []);
  release();
});

test('retrieval over 600 records is a fast flat scan', async () => {
  const files = {};
  seedFile(files, 'judy-alvarez', Array.from({length: 600}, (_, i) => ({id: 'r' + i, text: `memory number ${i} about topic ${i % 37} and thing ${i % 11}`})));
  const {store} = await setup({files});
  assert.equal(store.listRecords('judy-alvarez').length, 600);
  await store.retrieve({profileKey: 'judy-alvarez', query: 'topic 5'});
  const started = performance.now();
  for (let i = 0; i < 50; i++) await store.retrieve({profileKey: 'judy-alvarez', query: 'topic 5 thing 3'});
  const each = (performance.now() - started) / 50;
  assert(each < 5, `one retrieval took ${each.toFixed(2)} ms`);
});

// ---- extraction
const SAMPLE = [fact('V likes cheap whiskey', {kind: 'preference', importance: 0.7})];

test('extraction runs after 20 s of quiet, or at once after 6 exchanges, never for a group', async () => {
  const calls = [];
  const {store, clock, fs} = await setup({extractor: async args => { calls.push(args); return SAMPLE; }});
  exchange(store, 'judy-alvarez', 1);
  await clock.advance(19999); assert.equal(calls.length, 0);
  await clock.advance(1); assert.equal(calls.length, 1);
  assert.equal(calls[0].profileKey, 'judy-alvarez');
  assert.equal(calls[0].turns.length, 1);
  assert.deepEqual(calls[0].known, []);
  assert(calls[0].signal instanceof AbortSignal);
  exchange(store, 'panam-palmer', 5);
  await clock.advance(1000); assert.equal(calls.length, 1, 'five are not enough, and the idle time has not passed');
  exchange(store, 'panam-palmer', 1);
  await clock.advance(0); assert.equal(calls.length, 2);
  assert.equal(calls[1].turns.length, 6);
  exchange(store, 'jackie-welles', 20, {channel: 'group'});
  await clock.advance(120000); assert.equal(calls.length, 2, 'a group conversation never feeds extraction');
  assert.deepEqual(saved(fs, 'jackie-welles').pending, []);
  assert.deepEqual(saved(fs, 'judy-alvarez').pending, [], 'the covered exchanges left the pending list');
  assert.equal(clock.count, 0, 'no timer once nothing is pending');
  assert(clock.allUnref);
});

test('reactions and phone/private exchanges: reactions are not extracted, phone ones are', async () => {
  const calls = [];
  const {store, clock} = await setup({extractor: async args => { calls.push(args); return []; }});
  store.record({profileKey: 'judy-alvarez', v: 'boom', r: 'whoa', reaction: true});
  store.record({profileKey: 'judy-alvarez', channel: 'phone', v: 'hey', r: 'hello'});
  await clock.advance(20000);
  assert.equal(calls[0].turns.length, 1);
  assert.equal(calls[0].turns[0].v, 'hey');
});

test('extraction waits while the gate is closed, re-checking every 10 s, and runs one job at a time', async () => {
  const calls = [];
  const {store, clock, state} = await setup({extractor: async args => { calls.push(args); return []; }});
  state.gate = false;
  exchange(store, 'judy-alvarez', 6);
  exchange(store, 'panam-palmer', 6);
  await clock.advance(0); assert.equal(calls.length, 0);
  await clock.advance(30000); assert.equal(calls.length, 0);
  state.gate = true;
  await clock.advance(9999); assert.equal(calls.length, 0);
  await clock.advance(1);
  assert.equal(calls.length, 2, 'both characters ran, one after the other');
  assert.deepEqual(calls.map(call => call.profileKey).sort(), ['judy-alvarez', 'panam-palmer']);
  let running = 0, peak = 0;
  const {store: second, clock: clock2} = await setup({extractor: async () => { running++; peak = Math.max(peak, running); await settle(); running--; return []; }});
  exchange(second, 'judy-alvarez', 6); exchange(second, 'panam-palmer', 6);
  await clock2.advance(5000);
  assert.equal(peak, 1);
});

test('interrupt aborts the running extraction; its late result is discarded and the exchanges are retried later', async () => {
  let release, signals = [];
  const {store, clock} = await setup({extractor: ({signal}) => { signals.push(signal); return new Promise(done => { release = () => done(SAMPLE); }); }});
  exchange(store, 'judy-alvarez', 6);
  await clock.advance(0);
  assert.equal(signals.length, 1);
  store.interrupt();
  assert.equal(signals[0].aborted, true);
  release(); await settle();
  assert.deepEqual(store.listRecords('judy-alvarez'), []);
  await clock.advance(9999); assert.equal(signals.length, 1);
  await clock.advance(1); assert.equal(signals.length, 2, 'retried after the pause');
  assert.equal(signals[1].aborted, false);
  release(); await settle(); await clock.advance(0);
  assert.equal(store.listRecords('judy-alvarez').length, 1);
});

test('a failed extraction keeps the exchanges and backs off 60 s, doubling', async () => {
  let calls = 0, mode = 'fail';
  const {store, clock, fs} = await setup({extractor: async () => { calls++; if (mode === 'fail') throw new Error('llm down'); return SAMPLE; }});
  exchange(store, 'judy-alvarez', 6);
  await clock.advance(0); assert.equal(calls, 1);
  await clock.advance(59999); assert.equal(calls, 1);
  await clock.advance(1); assert.equal(calls, 2);
  await clock.advance(119999); assert.equal(calls, 2);
  await clock.advance(1); assert.equal(calls, 3);
  await store.flush();
  assert.equal(saved(fs, 'judy-alvarez').pending.length, 6, 'nothing lost');
  mode = 'ok';
  await clock.advance(239999); assert.equal(calls, 3);
  await clock.advance(1); assert.equal(calls, 4);
  assert.equal(store.listRecords('judy-alvarez').length, 1);
  await store.flush();
  assert.equal(saved(fs, 'judy-alvarez').pending.length, 0);
  exchange(store, 'judy-alvarez', 6);
  mode = 'fail';
  await clock.advance(0); assert.equal(calls, 5);
  await clock.advance(59999); assert.equal(calls, 5, 'a success reset the backoff');
  await clock.advance(1); assert.equal(calls, 6);
});

test('an extraction in flight when memory is forgotten is discarded, and nothing comes back', async () => {
  let release;
  const {store, clock, fs} = await setup({extractor: () => new Promise(done => { release = () => done(SAMPLE); })});
  exchange(store, 'judy-alvarez', 6);
  await clock.advance(0);
  store.forget({all: true});
  release(); await settle(); await clock.advance(120000);
  assert.equal(store.size, 0);
  assert.deepEqual(store.listRecords('judy-alvarez'), []);
  assert.equal(fs.files.size, 0);
  assert.equal(clock.count, 0);
});

test('extracted facts are cleaned, limited to three, deduplicated and typed', async () => {
  const long = 'x'.repeat(400);
  const {store, clock} = await setup({extractor: async () => [
    {text: ' V  likes\u0000 whiskey \n', kind: 'preference', importance: 2},
    {text: 'v likes WHISKEY', kind: 'fact', importance: 0.1},
    {text: long, kind: 'nonsense', importance: 'high'},
    {text: '', kind: 'fact'},
    {text: 'Judy owes V a favour', kind: 'promise', importance: 0.6},
    {text: 'fourth fact is dropped', kind: 'fact'}]});
  exchange(store, 'judy-alvarez', 6);
  await clock.advance(0);
  const records = store.listRecords('judy-alvarez');
  assert.equal(records.length, 3);
  const byText = Object.fromEntries(records.map(record => [record.text.slice(0, 12), record]));
  assert.equal(byText['V likes whis'].kind, 'preference');
  assert.equal(byText['xxxxxxxxxxxx'].kind, 'fact');
  assert(byText['xxxxxxxxxxxx'].text.length <= 220);
  assert.equal(byText['Judy owes V '].kind, 'promise');
  assert(records.every(record => !/[\u0000-\u001f]/.test(record.text)));
});

test('a near-duplicate fact updates the existing record; replaces swaps one; anything else is added', async () => {
  const files = {};
  seedFile(files, 'judy-alvarez', [
    {id: 'night', text: 'V really likes cheap whiskey after a long night shift', importance: 0.8, updated: T0 - DAY},
    {id: 'car', text: 'V drives an old Thorton Galena'}]);
  let output;
  const {store, clock, embedder, fs} = await setup({files, extractor: async args => { output.args = args; return output.facts; }});
  output = {facts: [fact('V really likes cheap whiskey after a long night shift nowadays', {importance: 0.3})]};
  exchange(store, 'judy-alvarez', 6);
  await clock.advance(0);
  let records = store.listRecords('judy-alvarez');
  assert.equal(records.length, 2, 'updated, not added');
  const night = records.find(record => record.id === 'night');
  assert.equal(night.text, 'V really likes cheap whiskey after a long night shift nowadays');
  assert.equal(night.updated, clock.now());
  await store.flush();
  assert.equal(saved(fs, 'judy-alvarez').records.find(r => r.id === 'night').importance, 0.8, 'the higher importance is kept');
  assert.deepEqual(output.args.known.map(k => k.id).sort(), ['car', 'night']);

  output = {facts: [fact('V sold the Thorton and now rides a bike', {replaces: 'car', kind: 'event', importance: 0.6})]};
  exchange(store, 'judy-alvarez', 6);
  await clock.advance(0);
  records = store.listRecords('judy-alvarez');
  assert.equal(records.length, 2);
  assert.equal(records.find(record => record.id === 'car').text, 'V sold the Thorton and now rides a bike');
  assert.equal(records.find(record => record.id === 'car').kind, 'event');
  assert.equal((await store.retrieve({profileKey: 'judy-alvarez', query: 'rides bike thorton'}))[0].id, 'car', 'the new vector is used');

  output = {facts: [fact('Panam trusts V completely', {kind: 'relationship', importance: 0.9})]};
  exchange(store, 'judy-alvarez', 6);
  await clock.advance(0);
  assert.equal(store.listRecords('judy-alvarez').length, 3);
  assert(embedder.calls.some(texts => texts[0] === 'Panam trusts V completely'));
});

test('the extractor is shown the 12 most relevant records, chosen by embedding the new exchanges', async () => {
  const files = {};
  seedFile(files, 'judy-alvarez', [
    ...Array.from({length: 14}, (_, i) => ({id: 'filler' + i, text: `filler topic alpha${i} beta${i} gamma${i}`})),
    {id: 'target', text: 'Judy fixed the braindance rig'}]);
  let known;
  const {store, clock} = await setup({files, extractor: async args => { known = args.known; return []; }});
  store.record({profileKey: 'judy-alvarez', v: 'did you fix the braindance rig', r: 'yes the braindance rig works'});
  await clock.advance(20000);
  assert.equal(known.length, 12);
  assert.equal(known[0].id, 'target');
});

test('more records than the cap are folded away when extraction adds them', async () => {
  const files = {};
  seedFile(files, 'judy-alvarez', [{id: 'keep', text: 'pinned and sacred', pinned: true, importance: 0}, {id: 'low', text: 'low value filler', importance: 0.1}, {id: 'high', text: 'high value stuff', importance: 0.9}]);
  const {store, clock} = await setup({files, limits: {records: 3}, extractor: async () => [fact('brand new thing', {importance: 0.5})]});
  exchange(store, 'judy-alvarez', 6);
  await clock.advance(0);
  assert.deepEqual(store.listRecords('judy-alvarez').map(r => r.text).sort(), ['brand new thing', 'high value stuff', 'pinned and sacred']);
});

test('extraction does not start while the embedder is unavailable and nothing is lost', async () => {
  const embedder = fakeEmbedder();
  let calls = 0;
  const {store, clock} = await setup({embedder, extractor: async () => { calls++; return SAMPLE; }});
  exchange(store, 'judy-alvarez', 6);
  embedder.ok = false;
  await clock.advance(30000); assert.equal(calls, 0);
  embedder.ok = true;
  await clock.advance(10000); assert.equal(calls, 1);
});

// ---- forget
test('forget one character removes its file and rows; others stay; forget all empties the folder; in-flight retrieval returns nothing', async () => {
  const files = memories();
  seedFile(files, 'panam-palmer', [{text: 'Panam likes the desert'}]);
  files[LEGACY + '.migrated'] = legacy();
  const {store, fs, embedder} = await setup({files, legacyPath: LEGACY});
  assert(fs.files.has(file('judy-alvarez')) && fs.files.has(file('panam-palmer')));
  assert.equal(store.forget({profileKeys: ['judy-alvarez', 'nobody']}), 1);
  await store.flush();
  assert.equal(fs.files.has(file('judy-alvarez')), false);
  assert.equal(fs.files.has(file('panam-palmer')), true);
  assert.deepEqual(await store.retrieve({profileKey: 'judy-alvarez', query: 'v whiskey'}), []);
  assert.equal((await store.retrieve({profileKey: 'panam-palmer', query: 'panam desert'})).length, 1);

  let release; embedder.hold = new Promise(done => { release = done; });
  const inflight = store.retrieve({profileKey: 'panam-palmer', query: 'panam desert'});
  fs.files.set(join(DIR, 'player', 'stray.json.1234.tmp'), 'partial');
  assert.equal(store.forget({all: true}), 1);
  release();
  assert.deepEqual(await inflight, []);
  await store.flush();
  assert.equal(store.size, 0);
  assert.deepEqual(fs.names(join(DIR, 'player')), []);
  assert.equal(fs.files.has(LEGACY + '.migrated'), false, 'the old combined copy goes too');
});

test('a character talked to again after a forget gets a fresh file', async () => {
  const {store, fs, clock} = await setup();
  exchange(store, 'judy-alvarez', 2);
  await clock.advance(800);
  store.forget({all: true});
  exchange(store, 'judy-alvarez', 1);
  await clock.advance(800);
  assert.equal(saved(fs, 'judy-alvarez').channels.private.length, 1);
});

test('timers exist only while there is work and are unref\'d', async () => {
  const {store, clock} = await setup({extractor: async () => []});
  assert.equal(clock.count, 0);
  exchange(store, 'judy-alvarez', 1);
  assert(clock.count > 0 && clock.allUnref);
  await clock.advance(25000);
  assert.equal(clock.count, 0);
  assert.equal(STORE_LIMITS.records, 600);
  assert.equal(STORE_LIMITS.characters, MEMORY_LIMITS.characters);
});

