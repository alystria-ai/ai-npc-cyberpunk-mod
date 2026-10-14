import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {parseWitnessReceipts, receiptWitnesses, witnessReceiptsReader} from './witness-receipts.mjs';
import {resolveKnowledge} from './world-knowledge.mjs';
import {PlayerKnowledge} from './player-knowledge.mjs';
import {conversationContext} from './quest-context.mjs';

// Witness receipts (docs/QUEST_DECISIONS.md section 4.3, step C2): the Lua collector reports the quest facts and journal entries that
// newly changed, mod/witness-receipts.lua stamps them with who stood within 15 m and writes runtime/witness-receipts.json when
// settings.witnessReceipts is on, and the bridge lets such a companion hear a `witnessed` rule it is not a declared speaker of.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const collectorSource = read('../mod/world-knowledge.lua');
const receiptsSource = read('../mod/witness-receipts.lua');
const managerSource = read('../mod/manager.lua');
const initSource = read('../mod/init.lua');

// ---------------------------------------------------------------- Lua helpers
function runLua(code) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const status = lauxlib.luaL_dostring(vm, to_luastring(code));
    const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(status, lua.LUA_OK, error + (line ? '\n' + code.split('\n')[line - 1] : ''));
    lua.lua_getglobal(vm, to_luastring('RESULT'));
    return lua.lua_isstring(vm, -1) ? to_jsstring(lua.lua_tostring(vm, -1)) : null;
  } finally { lua.lua_close(vm); }
}
function compiles(source, name) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const status = lauxlib.luaL_loadstring(vm, to_luastring(source));
    assert.equal(status, lua.LUA_OK, `${name}: ${status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1))}`);
  } finally { lua.lua_close(vm); }
}
const encoder = `
local function encode(value)
  local kind = type(value)
  if kind == 'string' then return '"' .. value:gsub('[%c"\\\\]', function(c) return string.format('\\\\u%04x', c:byte()) end) .. '"' end
  if kind == 'number' then return string.format('%d', value) end
  if kind == 'boolean' then return tostring(value) end
  if kind ~= 'table' then return 'null' end
  if #value > 0 then
    local parts = {}
    for _, item in ipairs(value) do parts[#parts + 1] = encode(item) end
    return '[' .. table.concat(parts, ',') .. ']'
  end
  local keys, parts = {}, {}
  for key in pairs(value) do keys[#keys + 1] = key end
  table.sort(keys)
  for _, key in ipairs(keys) do parts[#parts + 1] = encode(tostring(key)) .. ':' .. encode(value[key]) end
  return '{' .. table.concat(parts, ',') .. '}'
end
json = {encode = encode}`;

// ---------------------------------------------------------------- Lua: the collector's edges
const collector = `
${encoder}
local module = (function() ${collectorSource} end)()
local time, token = 100, 'world-a'
local values, journalRows, failing = {}, {}, {}
local pack = {version = 1, gameVersions = {'2.31'}, factAllowlist = {}, journalAllowlist = {}}
local function fact(key) pack.factAllowlist[key] = {evidenceRefs = {'native:fact'}} end
local function journal(key) pack.journalAllowlist[key] = {questKey = 'test-quest', evidenceRefs = {'native:journal'}} end
local context = {generation = 1, worldToken = token, audience = {channel = 'private', profileKeys = {'judy-alvarez'}}, identity = {status = 'unknown'}}
local wanted, edgeCalls, edgeLists, raising = true, 0, {}, false
local function build(track, batchSize)
  local m = module.new({now = function() return time end, cpuNow = function() return 0 end, batchSize = batchSize,
    utcNow = function() return '2026-09-30T12:00:00Z' end,
    currentGeneration = function() return 1 end, currentWorldToken = function() return token end,
    adapter = {isReady = function() return true end,
      readFact = function(key) if failing[key] then error('read failed') end return values[key] or 0 end,
      readJournal = function(key) return journalRows[key] end,
      readLifepath = function() return 'nomad' end}})
  if track then
    m.edgesWanted = function() return wanted end
    m.onEdges = function(edges) edgeCalls = edgeCalls + 1; edgeLists[#edgeLists + 1] = edges; if raising then error('listener failed') end end
  end
  assert(m:configure(pack, {gameVersion = '2.31'}))
  return m
end
-- One whole cycle: past the rest between cycles, then update until the job has published.
local function scan(m)
  time = time + 31
  for _ = 1, 200 do m:update(context); if not m.job then return end end
  error('scan never finished')
end
local function keys(edges) local out = {}; for _, e in ipairs(edges or {}) do out[#out + 1] = e.type .. ':' .. e.key .. '=' .. tostring(e.value) end; return table.concat(out, ',') end
local function last() return edgeLists[#edgeLists] end
`;
const lua$ = (body, prefix = collector) => runLua(prefix + '\n' + body);

test('the collector tracks nothing unless edges are wanted: no remembered values, no callback, same cache', () => {
  lua$(`
    fact('f1'); journal('1001'); values.f1 = 1; journalRows['1001'] = {value = 'active', revealed = true, isQuest = false}
    local plain = build(false); scan(plain); values.f1 = 2; scan(plain)
    assert(next(plain.lastKnown) == nil and edgeCalls == 0 and plain.baselined == false)
    wanted = false
    local off = build(true); scan(off); values.f1 = 3; scan(off)
    assert(next(off.lastKnown) == nil and edgeCalls == 0)
    assert(off.job == nil and off.cache ~= nil)
  `);
});

test('the first tracked scan after a reset only records a baseline; a later rise is an edge', () => {
  lua$(`
    fact('f1'); fact('f2'); values.f1 = 1
    local m = build(true); scan(m)
    assert(edgeCalls == 0 and m.lastKnown['fact:f1'] == 1 and m.baselined == true)
    scan(m); assert(edgeCalls == 0)
    values.f1, values.f2 = 2, 5; scan(m)
    assert(edgeCalls == 1 and keys(last()) == 'fact:f1=2,fact:f2=5', keys(last()))
    scan(m); assert(edgeCalls == 1)
    values.f1 = 0; scan(m); assert(edgeCalls == 1, 'a fact going back to zero is unknown, not an edge')
  `);
});

test('a world with nothing known on the first scan still takes that scan as its baseline', () => {
  lua$(`
    fact('f1'); local m = build(true); scan(m)
    values.f1 = 1; scan(m)
    assert(edgeCalls == 1 and keys(last()) == 'fact:f1=1')
  `);
});

test('a read that fails once and then returns the same value makes no edge', () => {
  lua$(`
    fact('f1'); journal('1001'); values.f1 = 3; journalRows['1001'] = {value = 'active', revealed = true, isQuest = false}
    local m = build(true); scan(m)
    failing.f1 = true; journalRows['1001'] = {value = 'active', revealed = false}; scan(m)
    assert(edgeCalls == 0 and m.lastKnown['fact:f1'] == 3 and m.lastKnown['journal:1001'] == 'active')
    failing.f1 = nil; journalRows['1001'] = {value = 'active', revealed = true, isQuest = false}; scan(m)
    assert(edgeCalls == 0, keys(last()))
  `);
});

test('journal entries make an edge when they appear and when their state changes', () => {
  lua$(`
    journal('1001'); journal('1002'); journalRows['1002'] = {value = 'active', revealed = true, isQuest = false}
    local m = build(true); scan(m)
    journalRows['1001'] = {value = 'active', revealed = true, isQuest = false}; scan(m)
    assert(edgeCalls == 1 and keys(last()) == 'journal:1001=active', keys(last()))
    journalRows['1001'] = {value = 'succeeded', revealed = true, isQuest = false}; journalRows['1002'] = {value = 'failed', revealed = true, isQuest = false}; scan(m)
    assert(edgeCalls == 2 and keys(last()) == 'journal:1001=succeeded,journal:1002=failed', keys(last()))
    scan(m); assert(edgeCalls == 2)
  `);
});

test('at most 48 edges per scan, and the rest are dropped', () => {
  lua$(`
    for i = 1, 60 do fact(string.format('f%02d', i)) end
    local m = build(true); scan(m)
    for i = 1, 60 do values[string.format('f%02d', i)] = 1 end
    scan(m); assert(edgeCalls == 1 and #last() == 48 and last()[48].key == 'f48')
    -- the dropped ones were still remembered: they are not edges on the next scan
    scan(m); assert(edgeCalls == 1)
  `);
});

test('a reset forgets everything, so the next scan is a baseline again', () => {
  lua$(`
    fact('f1'); values.f1 = 1
    local m = build(true); scan(m); values.f1 = 2; scan(m); assert(edgeCalls == 1)
    m:reset(1, 'world-reset', token)
    assert(next(m.lastKnown) == nil and m.baselined == false)
    values.f1 = 3; scan(m); assert(edgeCalls == 1 and m.lastKnown['fact:f1'] == 3)
    values.f1 = 4; scan(m); assert(edgeCalls == 2)
  `);
});

test('switching tracking off and on again starts a new baseline, so changes made meanwhile are not stamped as new', () => {
  lua$(`
    fact('f1'); values.f1 = 1
    local m = build(true); scan(m); values.f1 = 2; scan(m); assert(edgeCalls == 1)
    wanted = false; values.f1 = 3; scan(m)
    assert(next(m.lastKnown) == nil and m.baselined == false)
    wanted = true; values.f1 = 4; scan(m); assert(edgeCalls == 1)
    values.f1 = 5; scan(m); assert(edgeCalls == 2)
  `);
});

test('a listener that raises, or an edgesWanted that raises, never breaks the scan', () => {
  lua$(`
    fact('f1'); values.f1 = 1
    local m = build(true); scan(m); raising = true; values.f1 = 2; scan(m)
    assert(edgeCalls == 1 and m.cache ~= nil and m:capture(context).status == 'ready' and m.lastKnown['fact:f1'] == 2)
    local broken = build(true); broken.edgesWanted = function() error('boom') end
    scan(broken); values.f1 = 9; scan(broken)
    assert(broken.cache ~= nil and next(broken.lastKnown) == nil)
  `);
});

test('a scan that is dropped half way loses no edge: the next complete scan still reports it', () => {
  lua$(`
    fact('f1'); fact('f2'); fact('f3')
    local m = build(true, 1); scan(m)
    values.f1 = 1
    time = time + 31; m:update(context)
    assert(m.job ~= nil and edgeCalls == 0)
    time = time + 100; m:update(context) -- the window expired, the job is gone
    assert(edgeCalls == 0 and next(m.lastKnown) == nil)
    scan(m); assert(edgeCalls == 1 and keys(last()) == 'fact:f1=1', keys(last()))
  `);
});

test('revisions and the published observations are exactly those of a collector that tracks nothing', () => {
  const raw = lua$(`
    fact('f1'); fact('f2'); journal('1001'); values.f1, values.f2 = 1, 4
    local a, b = build(false), build(true)
    local function state(m)
      local c = m:capture(context)
      return m.revision .. '|' .. encode({facts = c.facts, journal = c.journal, lifepath = c.lifepath}) .. '|' .. m.cache.dataBytes
    end
    local out = {}
    for step = 1, 5 do
      if step == 2 then values.f1 = 2 end
      if step == 3 then journalRows['1001'] = {value = 'active', revealed = true, isQuest = true} end
      if step == 4 then failing.f2 = true end
      scan(a); scan(b)
      assert(state(a) == state(b), step .. ': ' .. state(a) .. ' vs ' .. state(b))
      out[#out + 1] = state(b):match('^%d+')
    end
    RESULT = table.concat(out, ',')
  `);
  assert.match(raw, /^\d+(,\d+){4}$/);
});

// ---------------------------------------------------------------- Lua: the receipts module
const receipts = `
${encoder}
local api = (function() ${receiptsSource} end)()
local on, token, clock, nearby = true, 'world-a', 5000, {'panam-palmer'}
local writes, logs = {}, {}
local r = api.new({enabled = function() return on end, worldToken = function() return token end,
  gameTime = function() return clock end, near = function() return nearby end,
  write = function(path, raw) writes[#writes + 1] = {path = path, raw = raw}; return true end,
  log = function(text) logs[#logs + 1] = text end})
local function edge(key, kind) return {type = kind or 'fact', key = key, value = 1} end
local function last() return writes[#writes] and writes[#writes].raw or '' end
`;
const receipts$ = body => runLua(receipts + '\n' + body);

test('receipts are off unless the setting is on: nothing held, nothing written, no log', () => {
  receipts$(`
    on = false
    assert(r:record({edge('a')}) == false)
    assert(#writes == 0 and #logs == 0 and r:status().rows == 0)
    local plain = api.new({})
    assert(plain:record({edge('a')}) == false and plain:status().enabled == false)
    local broken = api.new({enabled = function() error('boom') end})
    assert(broken:record({edge('a')}) == false)
  `);
});

test('an edge is written as a version 1 file bound to the world token and game clock, and the bridge parser accepts it', () => {
  const raw = receipts$(`
    assert(r:record({edge('a'), edge('j1', 'journal')}))
    assert(#writes == 1 and writes[1].path == 'runtime/witness-receipts.json')
    RESULT = last()
  `);
  const parsed = parseWitnessReceipts(JSON.parse(raw));
  assert.ok(parsed, raw);
  assert.equal(parsed.worldToken, 'world-a'); assert.equal(parsed.gameTimeSeconds, 5000);
  assert.deepEqual(parsed.edges.map(row => [row.type, row.key, row.t, [...row.near]]),
    [['fact', 'a', 5000, ['panam-palmer']], ['journal', 'j1', 5000, ['panam-palmer']]]);
  assert.ok(Array.isArray(JSON.parse(raw).edges));
});

test('an empty near list is a valid receipt and the field is omitted; it parses as nobody was near', () => {
  const raw = receipts$(`nearby = {}; assert(r:record({edge('a')})); RESULT = last()`);
  assert.equal(JSON.parse(raw).edges[0].near, undefined);
  assert.deepEqual([...parseWitnessReceipts(JSON.parse(raw)).edges[0].near], []);
});

test('near is de-duplicated, bounded to six, and keeps only profile keys', () => {
  const raw = receipts$(`
    nearby = {'a-1', 'a-1', 'b-2', 'c-3', 'D Bad', 'resident-x', 7, 'd-4', 'e-5', 'f-6', 'g-7', 'h-8'}
    assert(r:record({edge('a')})); RESULT = last()
  `);
  assert.deepEqual(JSON.parse(raw).edges[0].near, ['a-1', 'b-2', 'c-3', 'd-4', 'e-5', 'f-6']);
});

test('without a world token or a game clock nothing is recorded, and the skip is counted and logged once', () => {
  receipts$(`
    token = nil
    assert(r:record({edge('a')}) == false); assert(r:record({edge('b')}) == false)
    assert(#writes == 0 and r:status().skipped.unbound == 2)
    assert(#logs == 1 and logs[1] == 'Witness receipts: not recorded (unbound)', logs[1])
    token = 'world-a'; clock = nil
    assert(r:record({edge('a')}) == false and #writes == 0)
  `);
  receipts$(`
    nearby = nil
    assert(r:record({edge('a')}) == false and #writes == 0 and r:status().skipped['near-unavailable'] == 1)
    local failing = api.new({enabled = function() return true end, worldToken = function() return 'w' end, gameTime = function() return 1 end,
      near = function() error('lookup failed') end, write = function() return true end})
    assert(failing:record({edge('a')}) == false)
  `);
});

test('a newer edge for the same fact replaces the older row; other rows stay', () => {
  const raw = receipts$(`
    assert(r:record({edge('a'), edge('b')}))
    clock = 5100; nearby = {'judy-alvarez'}
    assert(r:record({edge('a'), edge('j', 'journal')}))
    RESULT = last()
  `);
  const rows = JSON.parse(raw).edges;
  assert.deepEqual(rows.map(row => `${row.type}:${row.key}@${row.t}`), ['fact:b@5000', 'fact:a@5100', 'journal:j@5100']);
  assert.deepEqual(rows[1].near, ['judy-alvarez']);
  // the same key as a fact and as a journal entry are two different rows
  const both = JSON.parse(receipts$(`assert(r:record({edge('x'), edge('x', 'journal'), edge('x')})); RESULT = last()`)).edges;
  assert.deepEqual(both.map(row => row.type), ['journal', 'fact']);
});

test('a world change starts empty, and rows stamped later than the game clock are dropped', () => {
  const fresh = JSON.parse(receipts$(`
    assert(r:record({edge('a')}))
    token = 'world-b'; clock = 5050
    assert(r:record({edge('b')})); RESULT = last()
  `));
  assert.equal(fresh.worldToken, 'world-b'); assert.deepEqual(fresh.edges.map(row => row.key), ['b']);
  const rolled = JSON.parse(receipts$(`
    assert(r:record({edge('a')})); clock = 5200; assert(r:record({edge('late')}))
    clock = 5100
    assert(r:record({edge('b')})); RESULT = last()
  `));
  assert.deepEqual(rolled.edges.map(row => [row.key, row.t]), [['a', 5000], ['b', 5100]]);
  assert.equal(rolled.gameTimeSeconds, 5100);
});

test('only the newest 256 rows are kept', () => {
  const rows = JSON.parse(receipts$(`
    for i = 1, 300 do clock = 5000 + i; assert(r:record({edge('f' .. i)})) end
    RESULT = last()
  `)).edges;
  assert.equal(rows.length, 256); assert.equal(rows[0].key, 'f45'); assert.equal(rows.at(-1).key, 'f300');
  assert.ok(parseWitnessReceipts({version: 1, worldToken: 'w', gameTimeSeconds: 6000, edges: rows}));
});

test('a failing writer, a failing encoder or a missing writer never breaks the caller, and the failure is counted', () => {
  receipts$(`
    local broken = api.new({enabled = function() return true end, worldToken = function() return 'w' end, gameTime = function() return 10 end,
      near = function() return {} end, write = function() error('disk full') end, log = function(text) logs[#logs + 1] = text end})
    assert(broken:record({edge('a')}) == false and broken:status().skipped['write-failed'] == 1)
    local refused = api.new({enabled = function() return true end, worldToken = function() return 'w' end, gameTime = function() return 10 end,
      near = function() return {} end, write = function() return false end})
    assert(refused:record({edge('a')}) == false)
    json = {encode = function() error('no codec') end}
    assert(r:record({edge('a')}) == false and r:status().skipped['encode-failed'] == 1)
    json = nil
    local inline = api.new({enabled = function() return true end, worldToken = function() return 'w' end, gameTime = function() return 10 end,
      near = function() return {} end})
    assert(inline:record({edge('a')}) == false) -- no codec and no file system access in the test VM: still no raise
  `);
});

test('the proof lines: the first three recorded calls and each skip reason once, with no fact names', () => {
  const raw = receipts$(`
    for i = 1, 5 do clock = clock + 1; assert(r:record({edge('quest_secret_fact_' .. i), edge('other_fact_' .. i)})) end
    token = nil; r:record({edge('x')}); r:record({edge('y')})
    RESULT = table.concat(logs, '\\n')
  `);
  const lines = raw.split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[0], 'Witness receipts: recorded #1 (edges=2 near=1)');
  assert.equal(lines[2], 'Witness receipts: recorded #3 (edges=2 near=1)');
  assert.equal(lines[3], 'Witness receipts: not recorded (unbound)');
  assert.doesNotMatch(raw, /secret|other_fact/);
});

test('the module is optional: the setting defaults to off, is a boolean, and init.lua wires it without any other hook', () => {
  assert.match(managerSource, /settings\.witnessReceipts, settingsNeedSave = false, true/);
  assert.match(managerSource, /function M\.witnessReceipts\(\)/);
  assert.match(managerSource, /witnessReceipts = settings\.witnessReceipts/);
  assert.match(managerSource, /key == 'decisionLedger' or key == 'witnessReceipts'/);
  assert.match(initSource, /pcall\(dofile, 'witness-receipts\.lua'\)/);
  assert.match(initSource, /worldKnowledge\.edgesWanted = function\(\) return convaiWitnessReceipts:on\(\) end/);
  assert.match(initSource, /worldKnowledge\.onEdges = /);
  assert.match(initSource, /conversationCandidates\(Game\.GetPlayer\(\), radius\)/);
});

test('the changed Lua files still compile', () => {
  for (const [name, source] of [['init.lua', initSource], ['manager.lua', managerSource], ['world-knowledge.lua', collectorSource],
    ['witness-receipts.lua', receiptsSource], ['game-dialogue.lua', read('../mod/game-dialogue.lua')]]) compiles(source, name);
});

// ---------------------------------------------------------------- bridge: parser and reader
const row = (key, t, near, extra = {}) => ({type: 'fact', key, t, ...(near === undefined ? {} : {near}), ...extra});
const file = (edges, extra = {}) => ({version: 1, worldToken: 'world-a', gameTimeSeconds: 9000, edges, ...extra});

test('the parser keeps bounded rows and rejects anything malformed', () => {
  const ok = parseWitnessReceipts(file([row('w1', 100, ['judy-alvarez']), {type: 'journal', key: '123456', t: 9000}]));
  assert.deepEqual(ok.edges.map(item => [item.type, item.key, item.t, [...item.near]]),
    [['fact', 'w1', 100, ['judy-alvarez']], ['journal', '123456', 9000, []]]);
  assert.equal(parseWitnessReceipts(file({})).edges.length, 0, 'an empty Lua list arrives as {}');
  assert.deepEqual([...parseWitnessReceipts(file([row('w1', 1, {})])).edges[0].near], []);
  const many = Array.from({length: 256}, (_, i) => row(`f${i}`, i));
  assert.equal(parseWitnessReceipts(file(many)).edges.length, 256);
  for (const bad of [null, undefined, [], 'text', {}, file([], {version: 2}), file([], {worldToken: 5}), file([], {worldToken: 'has space'}),
    file([], {worldToken: '__proto__'}), file([], {gameTimeSeconds: -1}), file([], {gameTimeSeconds: 1.5}), file('no'), file(null),
    file(Array.from({length: 257}, (_, i) => row(`f${i}`, i))), file([row('w1', 9001)]), file([row('w1', -1)]), file([row('w1', 1.5)]),
    file([row('w1', 'soon')]), file([{...row('w1', 1), type: 'lifepath'}]), file([{...row('w1', 1), type: undefined}]),
    file([row('', 1)]), file([row('has space', 1)]), file([row('k'.repeat(161), 1)]), file([row('constructor', 1)]), file([row(5, 1)]),
    file([row('w1', 1), row('w1', 2)]), file([null]), file(['x']),
    file([row('w1', 1, 'judy-alvarez')]), file([row('w1', 1, ['Judy'])]), file([row('w1', 1, ['resident-male'])]),
    file([row('w1', 1, ['a', 'a'])]), file([row('w1', 1, ['a', 'b', 'c', 'd', 'e', 'f', 'g'])]), file([row('w1', 1, [5])])]) {
    assert.equal(parseWitnessReceipts(bad), undefined, JSON.stringify(bad)?.slice(0, 120));
  }
});

test('the reader re-reads only when the file changed and never throws', () => {
  let stamp = {mtimeMs: 1, size: 10}, content = JSON.stringify(file([row('w1', 5, ['judy-alvarez'])])), reads = 0, stats = 0, failStat = false;
  const readReceipts = witnessReceiptsReader('runtime/witness-receipts.json', {
    readFile: () => { reads += 1; return content; }, statFile: () => { stats += 1; if (failStat) throw Error('ENOENT'); return stamp; }});
  assert.equal(readReceipts().edges[0].key, 'w1'); assert.equal(readReceipts().edges[0].key, 'w1');
  assert.equal(reads, 1); assert.equal(stats, 2);
  content = JSON.stringify(file([row('w1', 5), row('w2', 6)])); stamp = {mtimeMs: 2, size: 20};
  assert.equal(readReceipts().edges.length, 2); assert.equal(reads, 2);
  content = '{not json'; stamp = {mtimeMs: 3, size: 9};
  assert.equal(readReceipts(), undefined);
  failStat = true; assert.equal(readReceipts(), undefined);
  failStat = false; content = JSON.stringify(file([row('w3', 5)])); stamp = {mtimeMs: 4, size: 11};
  assert.equal(readReceipts().edges[0].key, 'w3');
});

// ---------------------------------------------------------------- bridge: who stood beside V
const leaf = (key, type = 'fact') => ({type, key, value: 1});
const ask = (edges, evidence, fields = {}) => receiptWitnesses({receipts: file(edges), worldToken: 'world-a', gameTimeSeconds: 9000, evidence, ...fields});

test('receiptWitnesses: no receipt at all, another world or a bad file means no widening', () => {
  assert.equal(ask([], [leaf('a')]), null);
  assert.equal(ask([row('b', 10, ['judy-alvarez'])], [leaf('a')]), null);
  assert.equal(ask([row('a', 10, ['judy-alvarez'])], [leaf('a')], {worldToken: 'world-b'}), null);
  assert.equal(ask([row('a', 10, ['judy-alvarez'])], [leaf('a')], {receipts: {version: 3}}), null);
  assert.equal(ask([row('a', 10, ['judy-alvarez'])], [leaf('a')], {receipts: undefined}), null);
  assert.equal(ask([row('a', 10, ['judy-alvarez'])], undefined), null);
  assert.equal(ask([row('a', 10, ['judy-alvarez'])], [{type: 'lifepath', value: 'nomad'}]), null);
  assert.equal(ask([row('a', 10, ['judy-alvarez'])], [{type: 'fact'}, null]), null);
});

test('receiptWitnesses: the rule became true at the item with the greatest t; items without a receipt do not block', () => {
  const edges = [row('a', 100, ['judy-alvarez', 'panam-palmer']), row('b', 200, ['judy-alvarez'])];
  assert.deepEqual([...ask(edges, [leaf('a'), leaf('b')]).near], ['judy-alvarez']);
  assert.equal(ask(edges, [leaf('a'), leaf('b')]).t, 200);
  assert.deepEqual([...ask(edges, [leaf('a')]).near].sort(), ['judy-alvarez', 'panam-palmer']);
  assert.deepEqual([...ask(edges, [leaf('a'), leaf('b'), leaf('never-seen')]).near], ['judy-alvarez']);
  assert.deepEqual([...ask(edges, [leaf('never-seen'), leaf('a')]).near].sort(), ['judy-alvarez', 'panam-palmer']);
});

test('receiptWitnesses: receipts that share the greatest t are intersected; an empty list means nobody', () => {
  const tied = [row('a', 200, ['judy-alvarez', 'panam-palmer']), row('b', 200, ['panam-palmer', 'river-ward']), row('c', 50, ['kerry-eurodyne'])];
  assert.deepEqual([...ask(tied, [leaf('a'), leaf('b'), leaf('c')]).near], ['panam-palmer']);
  assert.deepEqual([...ask([row('a', 200, ['judy-alvarez']), row('b', 200, ['panam-palmer'])], [leaf('a'), leaf('b')]).near], []);
  assert.deepEqual([...ask([row('a', 200), row('b', 100, ['judy-alvarez'])], [leaf('a'), leaf('b')]).near], []);
});

test('receiptWitnesses: a fact and a journal entry with the same key are different items', () => {
  const edges = [row('x', 100, ['judy-alvarez']), {type: 'journal', key: 'x', t: 300, near: ['panam-palmer']}];
  assert.deepEqual([...ask(edges, [leaf('x')]).near], ['judy-alvarez']);
  assert.deepEqual([...ask(edges, [leaf('x', 'journal')]).near], ['panam-palmer']);
});

test('receiptWitnesses: a receipt stamped later than the game clock is dropped (an earlier save was loaded)', () => {
  const edges = [row('a', 100, ['judy-alvarez']), row('b', 500, ['panam-palmer'])];
  assert.deepEqual([...ask(edges, [leaf('a'), leaf('b')], {gameTimeSeconds: 400}).near], ['judy-alvarez']);
  assert.equal(ask(edges, [leaf('b')], {gameTimeSeconds: 400}), null);
  // no clock from the snapshot: the file's own clock is the limit
  assert.deepEqual([...ask(edges, [leaf('b')], {gameTimeSeconds: undefined}).near], ['panam-palmer']);
  assert.equal(ask(edges, [leaf('b')], {gameTimeSeconds: 'soon'}).t, 500);
});

// ---------------------------------------------------------------- bridge: resolveKnowledge
const NOW = Date.parse('2026-09-30T12:00:00.000Z'), USER = 'bf5a7019-3e8c-47a2-9367-a9b6d179d89d';
const PROFILES = ['jackie-welles', 'judy-alvarez', 'panam-palmer', 'river-ward', 'resident-male'];
const observation = (value, fields = {}) => ({status: 'known', value, sourceId: 'native-capture', evidenceRefs: ['capture:12:observation'], ...fields});
const ruleOf = (id, fact, perspective, audience = {}, extra = {}) => ({
  id, revision: 1, questKey: 'the-heist', topic: `topic.${id}`, outcome: 'a', statement: `Statement of ${id}.`, status: 'source-verified', reviewed: true,
  gameVersions: ['2.31'], category: 'decision', priority: 5, stable: true, sourceIds: ['native-source'], evidenceRefs: ['native-branch'],
  condition: typeof fact === 'string' ? {type: 'fact', key: fact, op: 'eq', value: 1}
    : {all: fact.map(key => ({type: 'fact', key, op: 'eq', value: 1}))},
  audience: {speakers: ['jackie-welles'], perspective, channels: ['private', 'phone', 'group'], recipients: ['v', 'jackie-welles'], ...audience}, ...extra});
function pack() {
  return {version: 1, id: 'test-receipts', revision: 1, gameVersions: ['2.31'], profileKeys: PROFILES,
    sources: [{id: 'native-source', kind: 'native', locator: 'base/quest/example.quest'}],
    evidence: [{id: 'native-branch', kind: 'native', sourceId: 'native-source', locator: 'branch 123 -> scene 456', gameVersions: ['2.31']}],
    factAllowlist: Object.fromEntries(['w1', 'w2a', 'w2b', 'p1', 'r1', 't1', 'g1', 'c1'].map(key => [key, {evidenceRefs: ['native-branch']}])),
    journalAllowlist: {}, rules: [
      ruleOf('witnessed.one', 'w1', 'witnessed'),
      ruleOf('witnessed.two', ['w2a', 'w2b'], 'witnessed'),
      ruleOf('participant.one', 'p1', 'participant'),
      ruleOf('private.one', 'r1', 'private'),
      ruleOf('told.one', 't1', 'told-by-v'),
      ruleOf('witnessed.group', 'g1', 'witnessed', {recipients: ['v', 'jackie-welles', 'panam-palmer']}),
      ruleOf('witnessed.private-channel', 'c1', 'witnessed', {channels: ['private']})]};
}
function snapshot(profileKeys = ['judy-alvarez'], fields = {}) {
  const facts = Object.fromEntries(['w1', 'w2a', 'w2b', 'p1', 'r1', 't1', 'g1', 'c1'].map(key => [key, observation(1, {present: true})]));
  return {version: 1, status: 'ready', gameVersion: '2.31', generation: 12, worldToken: 'world-a', gameTimeSeconds: 9000,
    capturedAt: new Date(NOW).toISOString(), identity: {status: 'unknown'},
    audience: {channel: profileKeys.length > 1 ? 'group' : 'private', profileKeys}, activeQuestKeys: [], facts, journal: {},
    lifepath: {status: 'unknown'}, disclosures: [], ...fields};
}
const verified = {status: 'verified', userId: 'user-a', playthroughId: 'campaign-a', branchId: 'branch-a', checkpointId: 'checkpoint-a'};
const everything = ['w1', 'w2a', 'w2b', 'p1', 'r1', 't1', 'g1', 'c1'].map(key => row(key, 8000, ['judy-alvarez']));
const given = (edges, fields = {}) => ({receipts: parseWitnessReceipts(file(edges)), worldToken: 'world-a', gameTimeSeconds: 9000, ...fields});
const resolve = (profileKey, options = {}, snap = snapshot([profileKey])) => resolveKnowledge({pack: pack(), snapshot: snap, profileKey, query: '', maxChars: 8000, ...options});
const topicsOf = result => [...(JSON.parse(result.context.slice(result.context.indexOf('\n') + 1)).facts ?? []), ...(JSON.parse(result.context.slice(result.context.indexOf('\n') + 1)).choices ?? [])]
  .map(item => item.topic).sort();
const parsedContext = result => JSON.parse(result.context.slice(result.context.indexOf('\n') + 1));
const withoutReceiptCount = diagnostics => {
  const copy = structuredClone(diagnostics); delete copy.counts.receiptWitnessed; return copy;
};

test('without receipts a non-speaker hears nothing of a witnessed rule', () => {
  assert.deepEqual(topicsOf(resolve('judy-alvarez')), []);
  const jackie = topicsOf(resolve('jackie-welles'));
  assert.ok(jackie.includes('topic.witnessed.one') && jackie.includes('topic.participant.one'), jackie.join());
});

test('a nearby companion that is not a declared speaker hears a witnessed rule, labelled as approximate; others do not', () => {
  const options = {witnessReceipts: given(everything)};
  const judy = resolve('judy-alvarez', options);
  assert.deepEqual(topicsOf(judy), ['topic.witnessed.group', 'topic.witnessed.one', 'topic.witnessed.private-channel', 'topic.witnessed.two']);
  const entry = parsedContext(judy).choices?.[0] ?? parsedContext(judy).facts[0];
  assert.match(JSON.stringify(parsedContext(judy)), /was beside V when this happened \(approximate: where V's companions stood at the next world scan\)/);
  assert.equal(judy.diagnostics.counts.receiptWitnessed, 4);
  assert.ok(entry);
  // not near: Panam is in no receipt
  const panam = resolve('panam-palmer', options);
  assert.deepEqual(topicsOf(panam), []); assert.equal(panam.diagnostics.counts.receiptWitnessed, 0);
});

test('participant, private and told-by-v rules are never widened, and neither is a closed channel', () => {
  const options = {witnessReceipts: given(everything)};
  const topics = topicsOf(resolve('judy-alvarez', options));
  for (const topic of ['topic.participant.one', 'topic.private.one', 'topic.told.one']) assert.ok(!topics.includes(topic), topic);
  // the 'private' only rule on a phone call: the channel check still applies
  const phone = snapshot(['judy-alvarez'], {audience: {channel: 'phone', profileKeys: ['judy-alvarez']}});
  const onPhone = topicsOf(resolve('judy-alvarez', options, phone));
  assert.ok(onPhone.includes('topic.witnessed.one') && !onPhone.includes('topic.witnessed.private-channel'));
});

test('a declared speaker is unaffected, with or without receipts, near or not', () => {
  const plain = resolve('jackie-welles');
  for (const edges of [everything, [row('w1', 8000, [])], [row('w1', 8000, ['jackie-welles'])]]) {
    const result = resolve('jackie-welles', {witnessReceipts: given(edges)});
    assert.equal(result.context, plain.context); assert.deepEqual(result.events, plain.events); assert.deepEqual(result.shared, plain.shared);
    assert.equal(result.diagnostics.counts.receiptWitnessed, 0);
  }
});

test('in a group the other listeners must still be declared recipients; only the nearby character is relaxed', () => {
  const edges = [row('g1', 8000, ['judy-alvarez', 'river-ward'])];
  const group = (...keys) => snapshot(keys);
  // Panam is a declared recipient, so Judy hearing the rule in a group with her is allowed
  assert.deepEqual(topicsOf(resolve('judy-alvarez', {witnessReceipts: given(edges)}, group('judy-alvarez', 'panam-palmer'))), ['topic.witnessed.group']);
  // River is not a declared recipient: the group is not a safe audience for this rule
  assert.deepEqual(topicsOf(resolve('judy-alvarez', {witnessReceipts: given(edges)}, group('judy-alvarez', 'river-ward'))), []);
  // Two companions near, both outside the declared recipients: neither may hear it together
  assert.deepEqual(topicsOf(resolve('river-ward', {witnessReceipts: given(edges)}, group('judy-alvarez', 'river-ward'))), []);
});

test('the latest leaf decides: of a two-fact rule only who stood near when the last fact changed hears it', () => {
  const snap = snapshot(['judy-alvarez']);
  const hears = (profile, edges, fields) => topicsOf(resolve(profile, {witnessReceipts: given(edges, fields)}, snapshot([profile])))
    .includes('topic.witnessed.two');
  const edges = [row('w2a', 100, ['judy-alvarez', 'panam-palmer']), row('w2b', 200, ['judy-alvarez'])];
  assert.equal(hears('judy-alvarez', edges), true);
  assert.equal(hears('panam-palmer', edges), false);
  const tied = [row('w2a', 200, ['judy-alvarez', 'panam-palmer']), row('w2b', 200, ['panam-palmer', 'river-ward'])];
  assert.equal(hears('judy-alvarez', tied), false); assert.equal(hears('panam-palmer', tied), true);
  // one leaf has no receipt (true since before receipts began): the one that has one decides
  assert.equal(hears('judy-alvarez', [row('w2b', 200, ['judy-alvarez'])]), true);
  assert.equal(hears('panam-palmer', [row('w2b', 200, ['judy-alvarez'])]), false);
  assert.ok(snap);
});

test('a receipt from another world, from the future, or with nobody near widens nothing', () => {
  const heard = (witnessReceipts, snap) => topicsOf(resolve('judy-alvarez', {witnessReceipts}, snap)).includes('topic.witnessed.one');
  assert.equal(heard(given([row('w1', 8000, ['judy-alvarez'])])), true);
  assert.equal(heard(given([row('w1', 8000, ['judy-alvarez'])], {worldToken: 'world-b'})), false);
  assert.equal(heard(given([row('w1', 8000, ['judy-alvarez'])], {gameTimeSeconds: 7000})), false);
  assert.equal(heard(given([row('w1', 8000, [])])), false);
  assert.equal(heard({receipts: file([row('w1', 8000, ['judy-alvarez'])], {worldToken: 'world-b'}), worldToken: 'world-a', gameTimeSeconds: 9000}), false);
  assert.equal(heard({receipts: undefined, worldToken: 'world-a', gameTimeSeconds: 9000}), false);
  assert.equal(heard({receipts: 'garbage', worldToken: 'world-a', gameTimeSeconds: 9000}), false);
  // a raw (unparsed) file is validated here too
  assert.equal(heard({receipts: file([row('w1', 8000, ['judy-alvarez'])]), worldToken: 'world-a', gameTimeSeconds: 9000}), true);
});

test('what a receipt lets through is told this turn only: no stored event, no recency entry', () => {
  const identified = snapshot(['judy-alvarez'], {identity: verified});
  const judy = resolve('judy-alvarez', {witnessReceipts: given(everything)}, identified);
  assert.ok(topicsOf(judy).includes('topic.witnessed.one'));
  assert.deepEqual(judy.events, []);
  assert.deepEqual(judy.shared, []);
  assert.equal(judy.diagnostics.memory.candidates, 0);
  // the declared speaker's own copy of the same rule is still stored and listed
  const jackie = resolve('jackie-welles', {witnessReceipts: given(everything)}, snapshot(['jackie-welles'], {identity: verified}));
  assert.ok(jackie.events.some(event => event.topic === 'topic.witnessed.one'));
  assert.ok(jackie.shared.some(item => item.topic === 'topic.witnessed.one'));
});

test('output is byte-identical with the option absent, undefined, empty or from another world', () => {
  for (const profile of ['jackie-welles', 'judy-alvarez', 'panam-palmer']) {
    const snap = snapshot([profile], {identity: verified});
    const base = resolve(profile, {}, snap);
    for (const option of [undefined, null, {}, {receipts: undefined}, given([]), given(everything, {worldToken: 'world-b'}),
      given([row('w1', 8000, [])]), {receipts: 'junk', worldToken: 'world-a', gameTimeSeconds: 9000}]) {
      const result = resolve(profile, {witnessReceipts: option}, snap);
      assert.equal(result.context, base.context); assert.deepEqual(result.events, base.events); assert.deepEqual(result.shared, base.shared);
      assert.deepEqual(withoutReceiptCount(result.diagnostics), withoutReceiptCount(base.diagnostics));
    }
    // and the diagnostics are exactly as before when the option is not passed at all
    assert.equal(Object.hasOwn(base.diagnostics.counts, 'receiptWitnessed'), false);
  }
});

// ---------------------------------------------------------------- PlayerKnowledge integration
function router(witnessReceipts) {
  const ids = {'judy-alvarez': 'judy-provider'};
  const memory = {
    route(profileKey) {
      const guard = Object.freeze({endUserId: USER, characterId: ids[profileKey], resetEpoch: 0, characterEpoch: 0});
      return Object.freeze({endUserId: USER, guard, scope: 'ignored-core-scope'});
    },
    isCurrent: guard => guard?.endUserId === USER && guard.characterId === 'judy-provider' && guard.resetEpoch === 0 && guard.characterEpoch === 0};
  return new PlayerKnowledge({playerMemory: memory, pack: pack(), now: () => NOW,
    getBoundary: () => ({worldToken: 'world-a', generation: 12}),
    isWorldCurrent: binding => binding.worldToken === 'world-a' && binding.generation === 12, witnessReceipts});
}
const turnInput = () => ({requestId: '100-9-13ULL', generation: 9, entity: '13ULL', name: 'Judy', profileKey: 'judy-alvarez',
  text: 'What happened?', worldKnowledge: snapshot(['judy-alvarez'])});

test('the constructor rejects witness receipts that are not a function', () => {
  assert.throws(() => router('file'), error => /INVALID_CONFIGURATION/.test(`${error.code} ${error.message}`));
});

test('the router lets a nearby companion hear a witnessed rule when the receipts file says so, and not otherwise', async () => {
  const receipts = parseWitnessReceipts(file([row('w1', 8000, ['judy-alvarez'])]));
  const without = await router(undefined).prepare(turnInput());
  const withReceipts = await router(() => receipts).prepare(turnInput());
  assert.equal(without.status, 'ready'); assert.equal(withReceipts.status, 'ready');
  const base = conversationContext(without.input), extra = conversationContext(withReceipts.input);
  assert.doesNotMatch(base, /Statement of witnessed\.one/);
  assert.match(extra, /Statement of witnessed\.one/); assert.match(extra, /was beside V when this happened/);
  assert.doesNotMatch(extra, /Statement of witnessed\.two|Statement of participant\.one/);
});

test('receipts of another world, an unreadable file, an empty answer or a reader that throws leave the context byte-identical', async () => {
  const base = conversationContext((await router(undefined).prepare(turnInput())).input);
  const foreign = parseWitnessReceipts(file([row('w1', 8000, ['judy-alvarez'])], {worldToken: 'world-z'}));
  const future = parseWitnessReceipts(file([row('w1', 9000, ['judy-alvarez'])], {gameTimeSeconds: 9600}));
  const stale = parseWitnessReceipts(file([row('w1', 9500, ['judy-alvarez'])], {gameTimeSeconds: 9600}));
  for (const bad of [() => foreign, () => undefined, () => null, () => { throw Error('boom'); }, () => ({version: 9}), () => 'junk', () => stale,
    () => parseWitnessReceipts(file([row('w1', 8000, [])]))]) {
    const result = await router(bad).prepare(turnInput());
    assert.equal(result.status, 'ready');
    assert.equal(conversationContext(result.input), base);
  }
  assert.ok(future);
});
