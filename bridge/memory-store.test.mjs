import {test} from 'node:test';
import assert from 'node:assert/strict';
import {basename, dirname, join} from 'node:path';
import {MemoryStore, STORE_LIMITS, retrievalRuleFor, cutoffFor, isPureSmallTalk} from './memory-store.mjs';
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
      importance: record.importance ?? 0.5, pinned: !!record.pinned, source: 'chat', v: encode(record.vec ?? vectorOf(record.text, embedder.dim))})),
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
  const total = MEMORY_LIMITS.turns + MEMORY_LIMITS.overflow + 30;
  exchange(memory, 'jackie-welles', total);
  const kept = memory.recall({profileKey: 'jackie-welles'}).turns.length;
  assert.ok(kept >= MEMORY_LIMITS.turns && kept <= MEMORY_LIMITS.turns + MEMORY_LIMITS.slide);
  assert.equal(memory.pendingSummary('jackie-welles').turns[0].v, `question ${total - kept - MEMORY_LIMITS.overflow}`, 'the oldest exchanges beyond the overflow cap are dropped');
  const group = await MemoryStore.open({});
  exchange(group, 'jackie-welles', 41, {channel: 'group'});
  const groupKept = group.recall({profileKey: 'jackie-welles', channel: 'group'}).turns.length;
  assert.ok(groupKept >= MEMORY_LIMITS.turns && groupKept <= MEMORY_LIMITS.turns + MEMORY_LIMITS.slide);
  assert.equal(group.pendingSummary('jackie-welles'), null);
});

test('the history is cut back in one step once it has grown by `slide`, so its first exchange stays the same for several turns in a row (the prompt cache holds all of it)', async () => {
  const {turns, slide} = MEMORY_LIMITS;
  assert.ok(slide >= 2, 'a window that moves every turn is what made the whole history be read again every turn');
  const memory = await MemoryStore.open({});
  const firsts = [];
  for (let i = 0; i < turns + slide + 1 + 2 * (slide + 1); i++) {
    memory.record({profileKey: 'judy-alvarez', v: `question ${i}`, r: `answer ${i}`});
    const held = memory.recall({profileKey: 'judy-alvarez'}).turns;
    assert.ok(held.length <= turns + slide, `never more than ${turns + slide} exchanges`);
    assert.equal(held.at(-1).v, `question ${i}`, 'the newest exchange is always there');
    firsts.push(held[0].v);
  }
  // Runs of the same first exchange: each lasts `slide + 1` turns once the window is full, and the exchanges that left went to the overflow in order.
  const runs = [];
  for (const first of firsts) { if (runs.at(-1)?.first === first) runs.at(-1).length++; else runs.push({first, length: 1}); }
  assert.ok(runs.slice(1, -1).every(run => run.length === slide + 1), JSON.stringify(runs));
  const batch = memory.pendingSummary('judy-alvarez');
  assert.equal(batch.turns[0].v, 'question 0');
  assert.deepEqual(batch.turns.map(turn => turn.v), batch.turns.map((_, index) => `question ${index}`));
  // Groups and ordinary NPCs move the same way; a slide of 0 is the old one-at-a-time window.
  const ordinary = await MemoryStore.open({});
  exchange(ordinary, 'npc-food-vendor-male', turns + slide, {ambientKey: 'vendor-1'});
  assert.equal(ordinary.recall({profileKey: 'npc-food-vendor-male', ambientKey: 'vendor-1'}).turns.length, turns + slide);
  exchange(ordinary, 'npc-food-vendor-male', 1, {ambientKey: 'vendor-1'});
  assert.equal(ordinary.recall({profileKey: 'npc-food-vendor-male', ambientKey: 'vendor-1'}).turns.length, turns);
  const plain = await MemoryStore.open({limits: {slide: 0}});
  exchange(plain, 'judy-alvarez', turns + 5);
  assert.equal(plain.recall({profileKey: 'judy-alvarez'}).turns.length, turns);
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
  // A pinned record is one the player edited: it is in the turn whatever V asks (retrieve), here with no similarity to the line at all.
  assert.deepEqual(await store.retrieve({profileKey: 'judy-alvarez', query: 'judy favour'}), [{id: 'a', kind: 'fact', text: 'V likes whiskey'}]);
  store.pinRecord('judy-alvarez', 'a', false);
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

test('a record the player edited is in every private or phone turn, whatever V asks and whether or not an embedder is there, ahead of the matches; a bare greeting and the group get none', async () => {
  const files = {};
  seedFile(files, 'judy-alvarez', [{id: 'cat', text: 'V has a tabby cat called Biscuit.', pinned: true, updated: T0}, {id: 'sister', text: 'V has a sister called Lena.', pinned: true, updated: T0 - DAY},
    {id: 'whiskey', text: 'V likes whiskey'}, {id: 'car', text: 'Panam car broke down near Santo Domingo'}]);
  const {store, embedder} = await setup({files});
  const ids = async (query, options = {}) => (await store.retrieve({profileKey: 'judy-alvarez', query, ...options})).map(hit => hit.id);
  assert.deepEqual(await ids('what do you think about the rain tonight'), ['cat', 'sister'], 'newest edit first, nothing else matches');
  assert.deepEqual(await ids('v whiskey'), ['cat', 'sister', 'whiskey'], 'the matches follow, without repeating an edited record');
  assert.deepEqual(await ids('v likes whiskey', {channel: 'phone'}), ['cat', 'sister', 'whiskey']);
  assert.deepEqual(await ids('hey there'), [], 'a bare greeting brings up nothing');
  assert.deepEqual(await ids('thanks'), []);
  assert.deepEqual(await ids('what do you think about the rain tonight', {channel: 'group'}), [], 'private memories stay out of a group');
  assert.deepEqual(await ids('what do you think about the rain tonight', {ambientKey: 'x'}), []);
  assert.deepEqual(await ids('   '), []);
  embedder.ok = false;
  assert.deepEqual(await ids('anything at all, V?'), ['cat', 'sister'], 'the own words of the player do not wait for the embedding model');
  // At most three, within 600 characters, the newest first.
  const many = {};
  seedFile(many, 'judy-alvarez', [1, 2, 3, 4, 5].map(n => ({id: 'p' + n, text: `Edited fact number ${n}.`, pinned: true, updated: T0 + n})));
  const second = await setup({files: many});
  assert.deepEqual((await second.store.retrieve({profileKey: 'judy-alvarez', query: 'weather talk'})).map(hit => hit.id), ['p5', 'p4', 'p3']);
  const long = {};
  seedFile(long, 'judy-alvarez', [1, 2, 3].map(n => ({id: 'l' + n, text: 'x'.repeat(250) + n, pinned: true, updated: T0 + n})));
  const third = await setup({files: long});
  assert.deepEqual((await third.store.retrieve({profileKey: 'judy-alvarez', query: 'weather talk'})).map(hit => hit.id), ['l3', 'l2'], 'the third would pass 600 characters');
});

test('editing a record in the editor makes it a standing one: the next turn carries it before its new vector exists', async () => {
  const files = {};
  seedFile(files, 'judy-alvarez', [{id: 'orig', text: 'V mentioned a pet once.'}, {id: 'car', text: 'Panam car broke down near Santo Domingo'}]);
  const {store} = await setup({files});
  assert.deepEqual((await store.retrieve({profileKey: 'judy-alvarez', query: 'how is my cat doing today'})).map(hit => hit.id), []);
  store.editRecord('judy-alvarez', 'orig', 'V has a tabby cat called Biscuit.');
  const hits = await store.retrieve({profileKey: 'judy-alvarez', query: 'how is my cat doing today'});
  assert.deepEqual(hits, [{id: 'orig', kind: 'fact', text: 'V has a tabby cat called Biscuit.'}]);
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

test('an extraction the model server put off (a turn holds its one slot) is asked again in 10 s and never backs off', async () => {
  let calls = 0, busy = true;
  const {store, clock} = await setup({extractor: async () => { calls++; if (busy) throw Object.assign(new Error('busy'), {retryLater: true}); return SAMPLE; }});
  exchange(store, 'judy-alvarez', 6);
  await clock.advance(0); assert.equal(calls, 1);
  await clock.advance(9999); assert.equal(calls, 1);
  await clock.advance(1); assert.equal(calls, 2, 'asked again after the 10 s gate interval, not after the 60 s backoff');
  await clock.advance(10_000); assert.equal(calls, 3, 'and again: the pause does not double');
  busy = false;
  await clock.advance(10_000); assert.equal(calls, 4);
  assert.equal(store.listRecords('judy-alvarez').length, 1);
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
// ---- the character editor changes records and the summary (docs/CHARACTER_EDITOR.md)
test('an edited record is pinned, re-embedded, saved, and kept as the player wrote it; the summary can be set and cleared', async () => {
  const files = {};
  seedFile(files, 'judy-alvarez', [{id: 'a', text: 'V likes whiskey', updated: T0 - 5}, {id: 'b', text: 'Judy owes V a favour', updated: T0}], {summary: 'Old summary.'});
  const {store, fs, clock, embedder} = await setup({files});
  assert.equal(store.learns, true);
  const edited = store.editRecord('judy-alvarez', 'a', '  V likes   rye whiskey \u0000 ');
  assert.deepEqual(edited, {id: 'a', kind: 'fact', text: 'V likes rye whiskey', pinned: true, updated: clock.now()});
  assert.equal(store.editRecord('judy-alvarez', 'a', '   '), null);
  assert.equal(store.editRecord('judy-alvarez', 'zzz', 'text'), null);
  assert.equal(store.editRecord('nobody', 'a', 'text'), null);
  assert.equal(store.editRecord('judy-alvarez', 'b', 'x'.repeat(500)).text.length, STORE_LIMITS.fact);
  await clock.advance(0);
  await settle();
  assert(embedder.calls.some(texts => texts.includes('V likes rye whiskey')), 'the new text is embedded in the background');
  assert.equal((await store.retrieve({profileKey: 'judy-alvarez', query: 'rye whiskey'}))[0].id, 'a');
  assert.equal(store.setSummary('judy-alvarez', '  V asked   about the clinic. '), 'V asked about the clinic.');
  assert.equal(store.recall({profileKey: 'judy-alvarez'}).summary, 'V asked about the clinic.');
  assert.equal(store.setSummary('judy-alvarez', 's'.repeat(3000)).length, MEMORY_LIMITS.summary);
  assert.equal(store.setSummary('judy-alvarez', ''), '');
  assert.equal(store.setSummary('never-talked-to', ''), '', 'clearing a summary that is not there creates nothing');
  assert.equal(store.size, 1);
  assert.equal(store.setSummary('Bad Key!', 'text'), null);
  await clock.advance(800);
  const document = saved(fs, 'judy-alvarez');
  assert.equal(document.summary, '');
  assert.equal(document.records.find(record => record.id === 'a').pinned, true);
  assert.equal(document.records.find(record => record.id === 'a').text, 'V likes rye whiskey');
});


test('retrieve does not wait for an embedder that is not running: it is warmed for the next turn and this one gets nothing', async () => {
  const {store, embedder, clock} = await setup({files: memories()});
  let running = false, warms = 0;
  embedder.ready = () => running;
  embedder.warm = async () => { warms++; };
  const pending = store.retrieve({profileKey: 'judy-alvarez', query: 'v whiskey', timeoutMs: 400});
  let settled = false; pending.then(() => { settled = true; });
  await settle();
  assert.equal(settled, true, 'answered without advancing the clock');
  assert.deepEqual(await pending, []);
  assert.equal(warms, 0, 'the start waits until the turn has moved on');
  assert.equal(clock.count, 1, 'only the deferred start is armed, no timeout');
  await clock.advance(0);
  assert.equal(warms, 1);
  assert.equal(embedder.calls.length, 0, 'no query was sent to a server that is still starting');
  running = true;
  assert.equal((await store.retrieve({profileKey: 'judy-alvarez', query: 'v whiskey'})).length, 2, 'a running embedder is used as before');
  assert.equal(warms, 1);
});

test('warm() starts the embedder when there is one, never throws, and is false without one', async () => {
  const {store, embedder} = await setup({files: memories()});
  let warms = 0;
  assert.equal(store.warm(), false, 'an embedder without warm()');
  embedder.warm = () => { warms++; throw new Error('no'); };
  assert.equal(store.warm(), false);
  embedder.warm = async () => { warms++; throw new Error('later'); };
  assert.equal(store.warm(), true);
  await settle();
  assert.equal(warms, 2);
  const none = await setup({files: memories(), embedder: null});
  assert.equal(none.store.warm(), false);
});

test('a fact found later never rewrites a record the player wrote or edited', async () => {
  const files = {};
  seedFile(files, 'judy-alvarez', [{id: 'night', text: 'V really likes cheap whiskey after a long night shift', pinned: true}, {id: 'car', text: 'V drives an old Thorton Galena', pinned: true}]);
  let output;
  const {store, clock} = await setup({files, extractor: async () => output});
  output = [fact('V really likes cheap whiskey after a long night shift nowadays')];
  exchange(store, 'judy-alvarez', 6);
  await clock.advance(0);
  output = [fact('V sold the Thorton and now rides a bike', {replaces: 'car', kind: 'event'})];
  exchange(store, 'judy-alvarez', 6);
  await clock.advance(0);
  assert.deepEqual(store.listRecords('judy-alvarez').map(record => record.text).sort(), ['V drives an old Thorton Galena', 'V really likes cheap whiskey after a long night shift']);
});

// ---- extraction on a route that cannot do it (Convai keeps its own memory)
test('an extractor that cannot run on the current route is never scheduled: no attempt, no retry, no log line, no timer', async () => {
  const calls = [], logs = [], route = {on: false};
  const {store, clock} = await setup({log: line => logs.push(line)});
  store.setExtractor(async args => { calls.push(args); return SAMPLE; }, () => route.on);
  exchange(store, 'judy-alvarez', 8);
  await clock.advance(30 * 60 * 1000);
  assert.equal(calls.length, 0);
  assert.deepEqual(logs, []);
  assert.equal(clock.count, 0, 'nothing is armed while the route cannot extract');
  // The exchanges are kept: when the route can extract again (the provider was switched), a refresh schedules them at once.
  route.on = true; store.refresh();
  await clock.advance(1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].turns.length, 8);
  assert.deepEqual(logs, []);
});

test('an extractor with a route check that says yes runs as before, and a real failure still backs off and logs', async () => {
  const calls = [], logs = [];
  const {store, clock} = await setup({log: line => logs.push(line)});
  store.setExtractor(async args => { calls.push(args); throw new Error('boom'); }, () => true);
  exchange(store, 'judy-alvarez', 6);
  await clock.advance(1);
  assert.equal(calls.length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /memory extract failed \(boom\); retrying in 60 s/);
});

// ---- the cut-off belongs to the embedder (docs/COHERE_RETRIEVAL_EVAL_2026-10-30.md, "Follow-up: the cut-off")
const GRANITE = 'granite-embedding-107m-multilingual-q8_0', GEMMA = 'embeddinggemma-300m-q8_0';
// Three memories on the three axes; a query is a vector whose cosines to them are the numbers given (up to the unit length of the query itself).
const AXES = {whiskey: [1, 0, 0], car: [0, 1, 0], saul: [0, 0, 1]};
const QUERIES = {
  'tell me about the whiskey': [0.9, 0.3, 0.2],        // one memory is the answer: cosines 0.93 0.31 0.21
  'you remember the whiskey and the car': [0.8, 0.72, 0.1], // two memories are close: 0.74 0.67 0.09
  'what a strange night it is': [0.62, 0.60, 0.58],     // small talk: every memory looks about as close (0.60 0.58 0.56), the granite case
};
function axisEmbedder(id) {
  const norm = vec => { const length = Math.hypot(...vec); return Float32Array.from(vec.map(x => x / length)); };
  return {id, dim: 3, calls: [], available: () => true, async embed(texts) { this.calls.push([...texts]); return texts.map(text => norm(QUERIES[text])); }};
}
function axisMemories(embedder) {
  const files = {};
  seedFile(files, 'judy-alvarez', Object.entries(AXES).map(([id, vec]) => ({id, text: 'V ' + id, vec: Float32Array.from(vec)})), {embedder});
  return files;
}
const askAxes = async (embedderId, query, options) => {
  const embedder = axisEmbedder(embedderId);
  const {store} = await setup({files: axisMemories(embedder), embedder});
  return (await store.retrieve({profileKey: 'judy-alvarez', query, ...options})).map(hit => hit.id);
};

test('granite: small talk that scores 0.56 to 0.60 against every memory brings none, a real question brings the best, within a margin of it', async () => {
  assert.deepEqual(await askAxes(GRANITE, 'what a strange night it is'), []);
  assert.deepEqual(await askAxes(GRANITE, 'tell me about the whiskey'), ['whiskey']);
  assert.deepEqual(await askAxes(GRANITE, 'you remember the whiskey and the car'), ['whiskey', 'car'], 'both within 0.10 of the best');
});

test('EmbeddingGemma keeps its own cut-off of 0.40, so the same cosines give another answer than granite', async () => {
  assert.deepEqual(await askAxes(GEMMA, 'what a strange night it is'), ['whiskey', 'car', 'saul'], 'these cosines are only small talk to granite');
  assert.deepEqual(await askAxes(GEMMA, 'tell me about the whiskey'), ['whiskey']);
});

test('an embedder with no calibration keeps the old cut-off of 0.40, and a caller may still set its own minScore', async () => {
  assert.deepEqual(await askAxes('some-new-embedder', 'you remember the whiskey and the car'), ['whiskey', 'car']);
  assert.deepEqual(await askAxes('some-new-embedder', 'what a strange night it is'), ['whiskey', 'car', 'saul']);
  assert.deepEqual(await askAxes(GRANITE, 'what a strange night it is', {minScore: 0.5}), ['whiskey', 'car', 'saul'], 'minScore replaces the embedder rule');
  assert.deepEqual(await askAxes(GRANITE, 'tell me about the whiskey', {minScore: 0.95}), []);
});

test('retrievalRuleFor matches a model by the start of its id, so another quantisation of the same model keeps its rule', () => {
  assert.deepEqual(retrievalRuleFor('granite-embedding-107m-multilingual-q8_0'), {floor: 0.70, margin: 0.10});
  assert.deepEqual(retrievalRuleFor('granite-embedding-107m-multilingual-f16'), {floor: 0.70, margin: 0.10});
  assert.deepEqual(retrievalRuleFor('embeddinggemma-300m-q8_0'), {min: 0.40});
  assert.deepEqual(retrievalRuleFor('anything-else'), {min: 0.40});
  assert.deepEqual(retrievalRuleFor(undefined), {min: 0.40});
});

test('cutoffFor: the best must reach the floor, memories must be within the margin of it and above the minimum', () => {
  const rule = {floor: 0.70, margin: 0.10};
  assert.equal(cutoffFor(rule, [0.69, 0.5, 0.2]), null);
  assert.equal(cutoffFor(rule, []), null);
  assert.equal(cutoffFor(rule, [Number.NaN]), null);
  assert.ok(Math.abs(cutoffFor(rule, [0.85, 0.7, 0.2]) - 0.75) < 1e-12);
  assert.equal(cutoffFor({min: 0.40}, [0.39]), null);
  assert.equal(cutoffFor({min: 0.40}, [0.41, 0.2]), 0.40);
  assert.equal(cutoffFor({min: 0.70, margin: 0.3}, [0.9, 0.5]), 0.70, 'the minimum wins when it is higher than best minus margin');
});

test('a line of only greeting, thanks or yes/no words is small talk; anything with a question or a subject is not', () => {
  for (const line of ['hey', 'Hey!', 'ok', 'Okay, thanks.', 'thank you', 'see you later', 'good night', 'never mind', 'hello there', 'Got it', 'yeah sure', 'gracias', 'merci', 'danke']) {
    assert.equal(isPureSmallTalk(line), true, line);
  }
  for (const line of ['', '   ', '...', 'how are you doing today', 'hey, remember the whiskey?', 'thanks for the car', 'ok so about Saul', 'hey there how are you', 'good night and good luck with it',
    'hey hey hey hey hey hey', 'what', 'you remember Saul']) {
    assert.equal(isPureSmallTalk(line), false, line);
  }
  assert.equal(isPureSmallTalk(null), false);
});

test('a bare greeting is answered with nothing and costs no embed call; the same words inside a longer line are searched', async () => {
  const files = {}, embedder = fakeEmbedder();
  seedFile(files, 'judy-alvarez', [{id: 'thanks', text: 'thanks'}, {id: 'whiskey', text: 'V likes whiskey'}], {embedder});
  const {store} = await setup({files, embedder});
  assert.deepEqual(await store.retrieve({profileKey: 'judy-alvarez', query: 'Thanks!'}), []);
  assert.equal(embedder.calls.length, 0, 'no embed call for a pure greeting');
  assert.equal((await store.retrieve({profileKey: 'judy-alvarez', query: 'thanks V likes whiskey'})).some(hit => hit.id === 'whiskey'), true);
  assert.equal(embedder.calls.length, 1);
});

test('warmFor starts the embedder only for a character that has memories stored under it', async () => {
  const embedder = Object.assign(fakeEmbedder(), {warms: 0, warm() { this.warms++; return Promise.resolve(true); }});
  const files = {};
  seedFile(files, 'judy-alvarez', [{text: 'V likes whiskey'}], {embedder});
  seedFile(files, 'panam-palmer', [], {embedder});
  seedFile(files, 'johnny-silverhand', [{text: 'V likes whiskey'}], {embedder: fakeEmbedder({id: 'older-embedder'})});
  const {store} = await setup({files, embedder});
  assert.equal(store.warmFor('judy-alvarez'), true);
  assert.equal(embedder.warms, 1);
  for (const key of ['panam-palmer', 'unknown-person', 'johnny-silverhand']) assert.equal(store.warmFor(key), false, key);
  assert.equal(embedder.warms, 1, 'nothing was started for them');
  embedder.ok = false;
  assert.equal(store.warmFor('judy-alvarez'), false, 'an unavailable embedder is not started');
});
