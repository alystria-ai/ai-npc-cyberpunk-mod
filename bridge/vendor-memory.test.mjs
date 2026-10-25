import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile, stat} from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';
import {VendorMemory, VENDOR_MEMORY_LIMITS, cleanLine, vendorMemoryKey} from './vendor-memory.mjs';

// The store runs against temporary directories only. The bridge wiring tests execute the production helper
// sections of convai-bridge.mjs in a vm with fake knowledge guards; no bridge startup, provider or game
// side effect is reachable.
const KEY = 'wat_kab_ripperdoc_01', PROFILE = 'npc-medic-vendor-male';
async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), 'vendor-memory-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return {dir, path: join(dir, 'vendor-memory.json')};
}
const open = (path, options = {}) => VendorMemory.open({path, ...options});
const say = (memory, n, extra = {}) => memory.remember({memoryKey: KEY, profileKey: PROFILE,
  playerText: `question ${n}`, replyText: `answer ${n}`, ...extra});
const files = async dir => (await readdir(dir)).sort();

test('remember stores an exchange, survives a reopen and is returned oldest first', async t => {
  const {path} = await sandbox(t);
  let clock = 1000;
  const memory = await open(path, {now: () => clock++});
  assert.equal(memory.contextFor({memoryKey: KEY, profileKey: PROFILE}), '');
  assert.equal(await say(memory, 1), true); assert.equal(await say(memory, 2), true);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.version, 1);
  assert.deepEqual(saved.vendors[KEY].exchanges.map(row => row.v), ['question 1', 'question 2']);
  assert.equal(saved.vendors[KEY].profileKey, PROFILE);
  assert.equal(saved.vendors[KEY].updatedAt, 1001);
  const reopened = await open(path);
  const context = reopened.contextFor({memoryKey: KEY, profileKey: PROFILE});
  assert.ok(context.indexOf('question 1') > 0 && context.indexOf('question 1') < context.indexOf('question 2'));
  assert.deepEqual(reopened.status(), {vendors: 1, exchanges: 2, damagedFileKept: false});
});

test('context frames the memory as the vendor\'s own and never as current game facts', async t => {
  const {path} = await sandbox(t);
  const memory = await open(path);
  await say(memory, 1, {playerText: 'Do you have a "Kiroshi" mod?', replyText: 'I do.\nCome back with eddies.'});
  const context = memory.contextFor({memoryKey: KEY.toUpperCase(), profileKey: PROFILE});
  assert.match(context, /^WHAT YOU REMEMBER OF V \(earlier talks at this shop\)\n/);
  assert.match(context, /your own memory of V/);
  assert.match(context, /never recite it/);
  assert.match(context, /not facts about the current game state/);
  assert.match(context, /know nothing about V’s story beyond what V told you here/);
  assert.match(context, /- V said: "Do you have a 'Kiroshi' mod\?" You answered: "I do\. Come back with eddies\."/);
  // No real dates or relative days: the model must not invent a calendar from it.
  assert.doesNotMatch(context, /\b(19|20)\d\d\b|yesterday|last week|ago/i);
  assert.equal(context.split('\n').filter(line => line.startsWith('- ')).length, 1);
});

test('context is empty for another vendor, another kind of character, an invalid key or no memory', async t => {
  const {path} = await sandbox(t);
  const memory = await open(path);
  await say(memory, 1);
  assert.equal(memory.contextFor({memoryKey: 'wat_kab_ripperdoc_02', profileKey: PROFILE}), '');
  assert.equal(memory.contextFor({memoryKey: KEY, profileKey: 'npc-medic-vendor-female'}), '');
  assert.equal(memory.contextFor({memoryKey: '../x', profileKey: PROFILE}), '');
  assert.equal(memory.contextFor({}), ''); assert.equal(memory.contextFor(), '');
  assert.notEqual(memory.contextFor({memoryKey: KEY, profileKey: PROFILE}), '');
});

test('each vendor keeps its last ten exchanges and each side is clipped to 300 characters', async t => {
  const {path} = await sandbox(t);
  const memory = await open(path);
  for (let n = 1; n <= 14; n++) await say(memory, n);
  await say(memory, 15, {playerText: 'x'.repeat(900), replyText: '\u{1F600}'.repeat(400)});
  const rows = JSON.parse(await readFile(path, 'utf8')).vendors[KEY].exchanges;
  assert.equal(rows.length, VENDOR_MEMORY_LIMITS.exchangesPerVendor);
  assert.equal(rows[0].v, 'question 6');
  const last = rows.at(-1);
  assert.equal(Array.from(last.v).length, 300); assert.ok(last.v.endsWith('…'));
  assert.equal(Array.from(last.npc).length, 300); // clipped by code points: no lone surrogate
  assert.doesNotMatch(last.npc, /[\ud800-\udbff](?![\udc00-\udfff])/);
});

test('text is cleaned and only real dialogue is accepted', async t => {
  assert.equal(cleanLine('  a\u0000b \n\t c  '), 'a b c');
  assert.equal(cleanLine('[Microphone]'), ''); assert.equal(cleanLine('   '), ''); assert.equal(cleanLine(7), '');
  const {path} = await sandbox(t);
  const memory = await open(path);
  assert.equal(await say(memory, 1, {playerText: '[Microphone]'}), false);
  assert.equal(await say(memory, 1, {playerText: '  '}), false);
  assert.equal(await say(memory, 1, {replyText: ''}), false);
  assert.equal(await say(memory, 1, {memoryKey: 'a b'}), false);
  assert.equal(await say(memory, 1, {memoryKey: 'ab'}), false);
  assert.equal(await say(memory, 1, {memoryKey: 'x'.repeat(65)}), false);
  assert.equal(await say(memory, 1, {profileKey: 'resident male'}), false);
  assert.equal(memory.status().vendors, 0);
  await assert.rejects(stat(path), {code: 'ENOENT'});
});

test('vendors are bounded and the least recently updated is evicted', async t => {
  const {path} = await sandbox(t);
  let clock = 1;
  const memory = await open(path, {now: () => clock++, limits: {vendors: 3}});
  const put = key => memory.remember({memoryKey: key, profileKey: PROFILE, playerText: 'hi', replyText: 'hello'});
  for (const key of ['shop_a', 'shop_b', 'shop_c']) await put(key);
  await put('shop_a'); // a is now the most recent; b is the oldest
  await put('shop_d');
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(saved.vendors).sort(), ['shop_a', 'shop_c', 'shop_d']);
  assert.equal(memory.status().vendors, 3);
  assert.equal(memory.contextFor({memoryKey: 'shop_b', profileKey: PROFILE}), '');
  assert.equal(saved.vendors.shop_a.exchanges.length, 2);
});

test('the real limits bound the vendor count', async t => {
  const {path} = await sandbox(t);
  let clock = 1;
  const memory = await open(path, {now: () => clock++});
  for (let n = 0; n < VENDOR_MEMORY_LIMITS.vendors + 5; n++) {
    await memory.remember({memoryKey: `shop_${n}`, profileKey: PROFILE, playerText: 'hi', replyText: 'hello'});
  }
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(Object.keys(saved.vendors).length, VENDOR_MEMORY_LIMITS.vendors);
  assert.equal(saved.vendors.shop_0, undefined); assert.ok(saved.vendors[`shop_${VENDOR_MEMORY_LIMITS.vendors + 4}`]);
});

test('the file size cap evicts the oldest vendors and never the one just written', async t => {
  const {path} = await sandbox(t);
  let clock = 1;
  const memory = await open(path, {now: () => clock++, limits: {fileBytes: 900}});
  const long = 'w'.repeat(250);
  for (const key of ['shop_a', 'shop_b', 'shop_c', 'shop_d']) {
    assert.equal(await memory.remember({memoryKey: key, profileKey: PROFILE, playerText: long, replyText: long}), true);
  }
  const text = await readFile(path, 'utf8');
  assert.ok(Buffer.byteLength(text) <= 900, String(Buffer.byteLength(text)));
  const saved = JSON.parse(text);
  assert.ok(saved.vendors.shop_d); assert.equal(saved.vendors.shop_a, undefined);
  assert.deepEqual(Object.keys(saved.vendors), Object.keys(saved.vendors).filter(key => memory.contextFor({memoryKey: key, profileKey: PROFILE})));
  // One vendor alone that cannot fit is refused rather than written over the cap.
  const tiny = await open(join(path, '..', 'tiny.json'), {limits: {fileBytes: 100}});
  assert.equal(await tiny.remember({memoryKey: 'shop_a', profileKey: PROFILE, playerText: long, replyText: long}), false);
});

test('a damaged file starts empty, is kept aside and never throws into the conversation', async t => {
  for (const [name, content] of [['not json', '{broken'], ['wrong version', '{"version":2,"vendors":{}}'],
    ['wrong shape', '{"version":1,"vendors":[]}'], ['array', '[]'], ['empty', '']]) {
    const {dir, path} = await sandbox(t);
    await writeFile(path, content);
    const warnings = [];
    const memory = await open(path, {onWarning: message => warnings.push(message)});
    assert.deepEqual(memory.status(), {vendors: 0, exchanges: 0, damagedFileKept: true}, name);
    assert.equal(warnings.length, 1, name);
    assert.equal(await readFile(path + '.corrupt', 'utf8'), content, name);
    await assert.rejects(stat(path), {code: 'ENOENT'});
    assert.equal(await say(memory, 1), true, name);
    assert.equal(await readFile(path + '.corrupt', 'utf8'), content, name);
    assert.deepEqual((await files(dir)), ['vendor-memory.json', 'vendor-memory.json.corrupt'], name);
  }
});

test('an oversize file is not read and is kept aside', async t => {
  const {path} = await sandbox(t);
  const big = JSON.stringify({version: 1, vendors: {shop_a: {profileKey: PROFILE, updatedAt: 1,
    exchanges: [{at: 1, v: 'hi', npc: 'hello'}]}}}) + ' '.repeat(3000);
  await writeFile(path, big);
  const memory = await open(path, {limits: {fileBytes: 2000}});
  assert.equal(memory.status().vendors, 0); assert.equal(memory.status().damagedFileKept, true);
  assert.equal(await readFile(path + '.corrupt', 'utf8'), big);
});

test('one bad vendor or exchange in an otherwise valid file is dropped, the rest is kept', async t => {
  const {path} = await sandbox(t);
  await writeFile(path, JSON.stringify({version: 1, vendors: {
    shop_ok: {profileKey: PROFILE, updatedAt: 5, exchanges: [{at: 1, v: 'hi', npc: 'hello'}, {at: 'x', v: 'bad', npc: 'bad'}, null,
      {at: 2, v: '[Microphone]', npc: 'no'}, ...Array.from({length: 14}, (_, n) => ({at: 3 + n, v: `q${n}`, npc: `a${n}`}))]},
    'bad key!': {profileKey: PROFILE, updatedAt: 1, exchanges: [{at: 1, v: 'a', npc: 'b'}]},
    shop_noprofile: {profileKey: 'Not A Profile', updatedAt: 1, exchanges: [{at: 1, v: 'a', npc: 'b'}]},
    shop_empty: {profileKey: PROFILE, updatedAt: 1, exchanges: []},
  }}));
  const memory = await open(path);
  assert.deepEqual(memory.status(), {vendors: 1, exchanges: 10, damagedFileKept: false});
  assert.match(memory.contextFor({memoryKey: 'shop_ok', profileKey: PROFILE}), /q13/);
});

test('a failed write leaves the previous file and state untouched and leaves no temp file', async t => {
  const {dir, path} = await sandbox(t);
  const warnings = [];
  const failing = {rename: () => { throw Object.assign(Error('disk full'), {code: 'ENOSPC'}); }};
  const memory = await open(path, {onWarning: message => warnings.push(message)});
  await say(memory, 1);
  const before = await readFile(path, 'utf8');
  const broken = await open(path, {files: failing, onWarning: message => warnings.push(message)});
  assert.equal(await say(broken, 2), false);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual(await files(dir), ['vendor-memory.json']);
  assert.deepEqual(broken.status(), {vendors: 1, exchanges: 1, damagedFileKept: false});
  assert.equal(warnings.length, 1);
  assert.equal(await say(broken, 3), false); assert.equal(warnings.length, 1); // reported once
});

test('a write is a temp file plus a rename: the target is never partially written', async t => {
  const {dir, path} = await sandbox(t);
  const memory = await open(path);
  await say(memory, 1);
  const seen = [];
  const watching = await open(path, {files: {rename: (from, to) => {
    seen.push({temp: from.endsWith('.tmp'), same: from.startsWith(path)});
    return import('node:fs').then(fs => fs.renameSync(from, to));
  }}});
  await say(watching, 2);
  assert.deepEqual(seen, [{temp: true, same: true}]);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).vendors[KEY].exchanges.length, 2);
  assert.deepEqual(await files(dir), ['vendor-memory.json']);
});

test('concurrent writes are serialized in call order and none is lost', async t => {
  const {path} = await sandbox(t);
  const memory = await open(path);
  const results = await Promise.all(Array.from({length: 8}, (_, n) => say(memory, n + 1)));
  assert.deepEqual(results, Array(8).fill(true));
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).vendors[KEY].exchanges.map(row => row.v),
    Array.from({length: 8}, (_, n) => `question ${n + 1}`));
});

test('isCurrent is checked again right before the file is replaced', async t => {
  const {path} = await sandbox(t);
  const memory = await open(path);
  let allowed = true;
  assert.equal(await say(memory, 1, {isCurrent: () => allowed}), true);
  allowed = false;
  assert.equal(await say(memory, 2, {isCurrent: () => allowed}), false);
  assert.equal(await say(memory, 3, {isCurrent: () => 'yes'}), false);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).vendors[KEY].exchanges.map(row => row.v), ['question 1']);
  // A guard that turns false while the write is waiting behind another one discards it.
  let ready = true;
  const first = say(memory, 4), second = say(memory, 5, {isCurrent: () => ready});
  ready = false;
  assert.deepEqual(await Promise.all([first, second]), [true, false]);
});

test('Forget all empties memory at once, removes the file and the damaged copy, and keeps working afterwards', async t => {
  const {dir, path} = await sandbox(t);
  await writeFile(path, '{broken');
  const memory = await open(path);
  await say(memory, 1);
  assert.deepEqual(await files(dir), ['vendor-memory.json', 'vendor-memory.json.corrupt']);
  const forgetting = memory.forgetAll();
  assert.equal(memory.contextFor({memoryKey: KEY, profileKey: PROFILE}), ''); // before any I/O finished
  assert.deepEqual(await forgetting, {ok: true});
  assert.deepEqual(await files(dir), []);
  assert.deepEqual(memory.status(), {vendors: 0, exchanges: 0, damagedFileKept: false});
  assert.deepEqual(await memory.forgetAll(), {ok: true}); // nothing left is not an error
  assert.equal(await say(memory, 9), true);
  assert.equal((await open(path)).status().exchanges, 1);
});

test('a write issued before Forget all can never re-populate the store, even if it is already past its checks', async t => {
  const {dir, path} = await sandbox(t);
  const memory = await open(path);
  await say(memory, 1);
  const early = say(memory, 2), late = say(memory, 3, {isCurrent: () => true});
  const forgetting = memory.forgetAll();
  const after = say(memory, 4);
  assert.deepEqual(await Promise.all([early, late, forgetting, after]), [false, false, {ok: true}, true]);
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).vendors[KEY].exchanges.map(row => row.v), ['question 4']);
  assert.deepEqual(await files(dir), ['vendor-memory.json']);
});

test('a write whose commit is in flight when Forget is called is discarded before the rename', async t => {
  const {path} = await sandbox(t);
  let memory;
  const gate = {release: null};
  const files = {open: async (...args) => {
    await new Promise(done => { gate.release = done; });
    return (await import('node:fs/promises')).open(...args);
  }};
  memory = await open(path, {files});
  const writing = say(memory, 1);
  while (!gate.release) await new Promise(done => setImmediate(done));
  const forgetting = memory.forgetAll();
  gate.release();
  assert.equal(await writing, false); assert.deepEqual(await forgetting, {ok: true});
  await assert.rejects(stat(path), {code: 'ENOENT'});
  assert.equal(memory.status().vendors, 0);
});

test('a failed removal reports not ok but the in-memory store is already empty', async t => {
  const {path} = await sandbox(t);
  const warnings = [];
  const memory = await open(path, {io: {rm: async () => { throw Object.assign(Error('busy'), {code: 'EBUSY'}); }},
    onWarning: message => warnings.push(message)});
  await say(memory, 1);
  assert.deepEqual(await memory.forgetAll(), {ok: false});
  assert.equal(memory.contextFor({memoryKey: KEY, profileKey: PROFILE}), '');
  assert.equal(warnings.length, 1);
});

test('forgetVendor removes one vendor and discards its in-flight writes only', async t => {
  const {path} = await sandbox(t);
  const memory = await open(path);
  await memory.remember({memoryKey: 'shop_a', profileKey: PROFILE, playerText: 'hi', replyText: 'hello'});
  await memory.remember({memoryKey: 'shop_b', profileKey: PROFILE, playerText: 'hi', replyText: 'hello'});
  const a = memory.remember({memoryKey: 'shop_a', profileKey: PROFILE, playerText: 'again', replyText: 'yes'});
  const b = memory.remember({memoryKey: 'shop_b', profileKey: PROFILE, playerText: 'again', replyText: 'yes'});
  const forgetting = memory.forgetVendor('SHOP_A');
  assert.deepEqual(await Promise.all([a, b, forgetting]), [false, true, {ok: true, removed: true}]);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(Object.keys(saved.vendors), ['shop_b']); assert.equal(saved.vendors.shop_b.exchanges.length, 2);
  assert.deepEqual(await memory.forgetVendor('shop_a'), {ok: true, removed: false});
  assert.deepEqual(await memory.forgetVendor('shop_b'), {ok: true, removed: true});
  await assert.rejects(stat(path), {code: 'ENOENT'});
  assert.deepEqual(await memory.forgetVendor('!'), {ok: false, removed: false});
});

test('a record that now belongs to a different kind of character starts over', async t => {
  const {path} = await sandbox(t);
  const memory = await open(path);
  await say(memory, 1);
  await say(memory, 2, {profileKey: 'npc-medic-vendor-female'});
  const row = JSON.parse(await readFile(path, 'utf8')).vendors[KEY];
  assert.equal(row.profileKey, 'npc-medic-vendor-female'); assert.deepEqual(row.exchanges.map(item => item.v), ['question 2']);
});

test('status exposes counts only, never dialogue', async t => {
  const {path} = await sandbox(t);
  const memory = await open(path);
  await say(memory, 1, {playerText: 'a secret about Jackie'});
  const status = memory.status();
  assert.deepEqual(Object.keys(status).sort(), ['damagedFileKept', 'exchanges', 'vendors']);
  assert.doesNotMatch(JSON.stringify(status), /secret|Jackie/);
  assert.throws(() => new VendorMemory({}), /Invalid vendor memory configuration/);
});

const turn = (overrides = {}) => {
  const {input = {}, route = {}, ...rest} = overrides;
  return {route: {profileKey: PROFILE, channel: 'private', transport: 'private', ...route},
    input: {requestId: '1-2-3ULL', entity: '3ULL', generation: 2, profileKey: PROFILE, text: 'Got any stims?',
      archetype: {category: 'vendor', vendorType: 'RipperDoc', memoryKey: KEY}, ...input}, ...rest};
};

test('only a private text or voice turn of a vendor with a valid record key has a vendor identity', () => {
  assert.equal(vendorMemoryKey(turn()), KEY);
  assert.equal(vendorMemoryKey(turn({input: {archetype: {category: 'vendor', memoryKey: 'WAT_KAB_Ripperdoc_01'}}})), KEY);
  assert.equal(vendorMemoryKey(turn({route: {transport: 'microphone'}})), KEY);
  const none = [turn({input: {archetype: {category: 'vendor'}}}),
    turn({input: {archetype: {category: 'vendor', memoryKey: 'ab'}}}),
    turn({input: {archetype: {category: 'vendor', memoryKey: 'a-b-c'}}}),
    turn({input: {archetype: {category: 'vendor', memoryKey: 'x'.repeat(65)}}}),
    turn({input: {archetype: {category: 'gang', memoryKey: KEY}}}),
    turn({input: {archetype: undefined}}), turn({input: {archetype: 'vendor'}}),
    turn({input: {profileKey: 'judy-alvarez'}, route: {profileKey: 'judy-alvarez'}}),
    turn({input: {profileKey: 'resident-male'}, route: {profileKey: 'resident-male'}}),
    turn({route: {profileKey: 'npc-medic-vendor-female'}}),
    turn({route: {channel: 'group'}}), turn({route: {channel: 'phone'}}), turn({input: {channel: 'phone'}}),
    turn({input: {group: {index: 1}}}), turn({input: {reaction: {phase: 'battle'}}}), null, {}, {input: null}];
  for (const prepared of none) assert.equal(vendorMemoryKey(prepared), null, JSON.stringify(prepared));
});

// ---- Bridge wiring: the production helper sections of convai-bridge.mjs, executed with fake guards ----

const source = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
const section = (start, end) => {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing production helper section: ${start}`);
  return source.slice(a, b);
};
const wiring = section('const knowledgeTurns =', 'async function cancelMicrophone(')
  + section('const vendorMemoryContext =', 'const conversationContext =')
  + section('async function quiescePlayerMemory(', 'async function admitPlayerConversation(')
  + section('const deliveredReceipts =', 'async function pollKnowledge(');
const flush = () => new Promise(done => setImmediate(done));

async function bridge(t, {memory} = {}) {
  const {dir, path} = await sandbox(t);
  const f = {dir, path, now: 100000, live: true, calls: [], resets: 0, vendorMemory: memory ?? await open(path)};
  const sandboxed = {Date: {now: () => f.now}, vendorMemory: f.vendorMemory, vendorMemoryKey, mistralMemory: {forget: () => 0, flush: async () => {}}, lastTalk: {forget: () => 0}, memoryNamespace: {scope: () => null, keyFor: key => key},
    readSpeechState: async () => ({}),
    throwIfCancelled: () => {},
    resetLiveRoutes: async () => { f.resets++; },
    knowledgeRouter: {currentSync: () => f.live,
      activity: async (prepared, kind, receipt) => {
        f.calls.push(kind);
        const result = f.live ? {status: 'current'} : {status: 'unavailable'}; // decided when the receipt is checked
        await f.onActivity?.(prepared, kind, receipt);
        return result;
      }}};
  runInNewContext(`let stopped = false, memoryQuiescing = 0;${wiring};globalThis.api = {rememberKnowledgeTurn, noteKnowledgeTurn,
    stagedKnowledgeTurn, recordDelivery, quiescePlayerMemory, vendorMemoryContext, knowledgeTurns,
    stop: () => { stopped = true; }, quiescing: value => { memoryQuiescing = value; }};`, sandboxed);
  f.api = sandboxed.api;
  f.receiptFor = prepared => ({version: 1, id: 'speech-1', sequence: 1, source: 'continuous-playback', state: 'completed',
    backend: 'browser-pcm', partial: false, cancelled: false, requestId: prepared.input.requestId, entity: prepared.input.entity,
    generation: prepared.input.generation, completedAt: f.now, totalChunks: 1, completedChunks: 1});
  // A reply that was generated for this turn and then heard to the end.
  f.deliver = async (prepared, exchange = {replyText: 'Sure, choom. Chrome is cheap today.'}) => {
    f.api.rememberKnowledgeTurn(prepared); f.api.stagedKnowledgeTurn(prepared, exchange);
    await f.api.recordDelivery(f.receiptFor(prepared));
    await f.vendorMemory.idle();
  };
  f.stored = () => f.vendorMemory.contextFor({memoryKey: KEY, profileKey: PROFILE});
  return f;
}

test('wiring: the context is built next to the archetype context and only for an admitted current turn', async t => {
  assert.match(source, /block\('world', archetypeContext\(input, \{place: dynamicInfo\.on\('location'\)\}\)\),\s*block\('world', admitted \? vendorMemoryContext\(prepared\) : ''\)/);
  const f = await bridge(t);
  await f.vendorMemory.remember({memoryKey: KEY, profileKey: PROFILE, playerText: 'Got any stims?', replyText: 'Sure.'});
  assert.match(f.api.vendorMemoryContext(turn()), /WHAT YOU REMEMBER OF V/);
  assert.equal(f.api.vendorMemoryContext(turn({input: {archetype: {category: 'vendor'}}})), '');
  assert.equal(f.api.vendorMemoryContext(turn({route: {channel: 'group'}})), '');
});

test('wiring: a delivered private text reply of a vendor is remembered with the player\'s words', async t => {
  const f = await bridge(t);
  await f.deliver(turn());
  assert.deepEqual(f.calls, ['delivered-reply']);
  assert.match(f.stored(), /- V said: "Got any stims\?" You answered: "Sure, choom\. Chrome is cheap today\."/);
  assert.equal((await open(f.path)).status().exchanges, 1);
});

test('wiring: a reply that was never delivered, or cancelled, is not remembered', async t => {
  const f = await bridge(t);
  const prepared = turn();
  f.api.rememberKnowledgeTurn(prepared); f.api.stagedKnowledgeTurn(prepared, {replyText: 'Sure.'});
  await f.vendorMemory.idle();
  assert.equal(f.stored(), ''); // generated, but nothing heard yet
  const wrong = {...f.receiptFor(prepared), entity: '9ULL'};
  await f.api.recordDelivery(wrong); await f.vendorMemory.idle();
  assert.equal(f.stored(), '');
  await f.api.recordDelivery({...f.receiptFor(prepared), partial: true}); await f.vendorMemory.idle();
  assert.equal(f.stored(), '');
  const stale = await bridge(t); stale.live = false;
  await stale.deliver(turn()); // the guard refuses the delivered receipt itself
  assert.equal(stale.stored(), '');
});

test('wiring: no key, non-vendor, group, phone and automatic reactions stay session-only', async t => {
  for (const prepared of [turn({input: {archetype: {category: 'vendor'}}}), turn({input: {archetype: {category: 'gang', memoryKey: KEY}}}),
    turn({route: {channel: 'group'}, input: {group: {index: 1}}}), turn({route: {channel: 'phone'}, input: {channel: 'phone'}}),
    turn({input: {reaction: {phase: 'battle'}, text: 'Shots fired!'}}), turn({input: {profileKey: 'resident-male'}, route: {profileKey: 'resident-male'}})]) {
    const f = await bridge(t);
    // Group and phone receipts are different; use the playback receipt only to prove even a heard reply is not stored.
    await f.deliver(prepared);
    assert.equal(f.stored(), '', JSON.stringify(prepared.input.archetype));
    assert.equal(f.vendorMemory.status().vendors, 0);
  }
});

test('wiring: a microphone turn is remembered by the recognized words, never by the placeholder', async t => {
  const f = await bridge(t);
  const prepared = turn({route: {transport: 'microphone'}, input: {text: '[Microphone]', source: 'microphone'}});
  f.api.rememberKnowledgeTurn(prepared);
  f.api.noteKnowledgeTurn(prepared, {userText: 'Can you fix my arm?'});
  f.api.stagedKnowledgeTurn(prepared, {replyText: 'Sit down.'});
  await f.api.recordDelivery(f.receiptFor(prepared)); await f.vendorMemory.idle();
  const stored = f.stored();
  assert.match(stored, /V said: "Can you fix my arm\?" You answered: "Sit down\."/);
  assert.doesNotMatch(stored, /Microphone/);
  const silent = await bridge(t);
  const unheard = turn({route: {transport: 'microphone'}, input: {text: '[Microphone]', source: 'microphone', requestId: '4-5-6ULL', entity: '6ULL'}});
  await silent.deliver(unheard);
  assert.equal(silent.stored(), ''); // no transcript: skipped
});

test('wiring: a reply staged without text, or text noted for another turn, is not remembered', async t => {
  const f = await bridge(t);
  const prepared = turn();
  f.api.rememberKnowledgeTurn(prepared); f.api.stagedKnowledgeTurn(prepared);
  f.api.noteKnowledgeTurn(turn({input: {requestId: '7-8-9ULL'}}), {replyText: 'foreign'});
  f.api.noteKnowledgeTurn(null, {replyText: 'nothing'});
  await f.api.recordDelivery(f.receiptFor(prepared)); await f.vendorMemory.idle();
  assert.equal(f.stored(), '');
});

test('wiring: a Forget pending (the turn guard is stale) records nothing', async t => {
  const f = await bridge(t);
  // The reply is heard, the game's receipt is accepted, then the turn's guard goes stale before the write commits.
  const prepared = turn();
  f.api.rememberKnowledgeTurn(prepared); f.api.stagedKnowledgeTurn(prepared, {replyText: 'Sure.'});
  const writing = f.api.recordDelivery(f.receiptFor(prepared));
  f.live = false; // the fence of a Forget raised while the receipt was being processed
  await writing; await f.vendorMemory.idle();
  assert.deepEqual(f.calls, ['delivered-reply']); // the receipt itself was accepted; only the memory write was refused
  assert.equal(f.stored(), '');
  await assert.rejects(stat(f.path), {code: 'ENOENT'});
});

test('wiring: the write is also refused while the bridge stops or a memory reset is quiescing', async t => {
  for (const block of [api => api.stop(), api => api.quiescing(1)]) {
    const f = await bridge(t);
    block(f.api);
    await f.deliver(turn());
    assert.equal(f.stored(), '');
  }
});

test('wiring: Forget all clears the vendor store while closing the old conversations; Forget character does not', async t => {
  const f = await bridge(t);
  await f.deliver(turn());
  assert.notEqual(f.stored(), '');
  // (The sandbox is another realm: compare serialized.)
  assert.equal(JSON.stringify(await f.api.quiescePlayerMemory({scope: 'character', profileKeys: [PROFILE], signal: undefined})), '{"quiesced":true}');
  assert.notEqual(f.stored(), ''); assert.equal(f.resets, 1);
  assert.equal(JSON.stringify(await f.api.quiescePlayerMemory({scope: 'all', signal: undefined})), '{"quiesced":true}');
  assert.equal(f.stored(), ''); assert.equal(f.resets, 2);
  await assert.rejects(stat(f.path), {code: 'ENOENT'});
  assert.equal((await open(f.path)).status().vendors, 0);
});

test('wiring: a turn in flight when Forget all runs cannot write afterwards', async t => {
  const f = await bridge(t);
  const prepared = turn();
  f.api.rememberKnowledgeTurn(prepared); f.api.stagedKnowledgeTurn(prepared, {replyText: 'Sure.'});
  let release;
  f.onActivity = () => { f.onActivity = undefined; return new Promise(done => { release = done; }); };
  const delivering = f.api.recordDelivery(f.receiptFor(prepared));
  while (!release) await flush();
  // Forget all: PlayerMemory fences first (its reset epoch changes, so this turn's guard stays stale for good),
  // then quiesce clears the store.
  f.live = false;
  await f.api.quiescePlayerMemory({scope: 'all'});
  release();
  await delivering; await f.vendorMemory.idle();
  assert.equal(f.stored(), '');
  // A new conversation after the Forget has a fresh guard and is remembered again.
  f.live = true;
  const next = turn({input: {requestId: '10-11-12ULL', entity: '12ULL', text: 'Hello again'}});
  await f.deliver(next, {replyText: 'Who are you?'});
  assert.match(f.stored(), /Hello again/);
});

test('wiring: if the vendor store cannot be cleared the Forget all fails instead of reporting success', async t => {
  const dir = await sandbox(t);
  const stuck = await open(dir.path, {io: {rm: async () => { throw Object.assign(Error('busy'), {code: 'EBUSY'}); }}, onWarning: () => {}});
  const f = await bridge(t, {memory: stuck});
  await assert.rejects(f.api.quiescePlayerMemory({scope: 'all'}), /Vendor memory could not be cleared/);
  assert.equal(f.resets, 1);
  // The counter still returns to zero so a retry is not blocked.
  await f.api.quiescePlayerMemory({scope: 'character'});
});

test('the bridge passes the clear scope to its quiesce callback and flushes before shutdown', () => {
  assert.match(source, /async function quiescePlayerMemory\(\{signal, scope, profileKeys\} = \{\}\)/);
  assert.match(source, /await vendorMemory\.idle\(\)\.catch\(\(\) => \{\}\);\r?\n\s+await memoryControl\.close\(\)/);
  assert.match(source, /VendorMemory\.open\(\{path: resolve\(stateDirectory, 'vendor-memory\.json'\)/);
  for (const site of ['{replyText: text}', '{replyText: result.text}', '{replyText: result.text, userText: result.userText}']) {
    assert.ok(source.includes(`stagedKnowledgeTurn(`) && source.includes(site), site);
  }
});
