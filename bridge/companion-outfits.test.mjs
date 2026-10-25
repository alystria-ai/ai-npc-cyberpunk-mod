import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';
import {readOutfitList, appearancesOf, buildEvidence} from '../scripts/Extract-CompanionOutfitEvidence.mjs';

// Companions change outfits (docs/COMPANION_OUTFITS.md): the curated list (mod/companion-outfits-data.lua) against what the installed game lists
// (characters/companion-outfit-evidence.json), the decision and the check cycle of mod/companion-outfits.lua under fengari with stand-ins for the game,
// and the hooks in mod/companions.lua and mod/init.lua.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const moduleSource = read('../mod/companion-outfits.lua');
const dataSource = read('../mod/companion-outfits-data.lua');
const initSource = read('../mod/init.lua');
const evidence = JSON.parse(read('../characters/companion-outfit-evidence.json'));
const roster = JSON.parse(read('../characters/roster.json'));
const recordsSource = read('../mod/companion-records.lua');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

function runWith(program) {
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  try {
    const result = lauxlib.luaL_dostring(vm, to_luastring(program));
    const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(result, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
  } finally { lua.lua_close(vm); }
}

// ---------------------------------------------------------------- the list

// The data file is plain enough to read as text: one record per `['Character.X'] = {base = '...'` line, one outfit per `{'name', 'kind'}` line.
function parseData() {
  const characters = {};
  let current = null;
  for (const line of dataSource.split('\n')) {
    const head = /\['(Character\.[^']+)'\] = \{base = '([^']+)'(, explicit = true)?/.exec(line);
    if (head) { current = characters[head[1]] = {base: head[2], explicit: !!head[3], outfits: []}; continue; }
    const row = /^\s*\{'([^']+)', '(\w+)'\}/.exec(line);
    if (row && current) current.outfits.push({name: row[1], kind: row[2]});
  }
  return characters;
}
const data = parseData();
const KINDS = new Set(['any', 'day', 'night', 'home']);
// What an outfit may never be: undress, damage, another time, another state of being. (The file's header lists the same rule.)
const FORBIDDEN = /nude|naked|underwear|panties|undress|bdsm|sex|censored|shower|dead|corpse|wound|bleed|blood|dirt|burn|beaten|bruis|cyberspace|braindance|hologram|holocall|blendable|invisible|hallucin|possess|core_chip|carried|_wet|exhaust|plugged|disguise|disquise|funeral|prisoner|jail|kidnap|young|2013|2020|epilogue|two_years|finale|bossfight|boss|stage|morph|transparent|fpp|crying|apartment_02/i;

test('the list: every record is a roster character, every name is one the record\'s own template lists, no look is undress, damage or another time', () => {
  assert.ok(Object.keys(data).length >= 15, 'the list was not read');
  const rosterRecords = new Set(roster.flatMap(row => row.records ?? []));
  for (const [record, character] of Object.entries(data)) {
    assert.ok(rosterRecords.has(record), `${record} is not a record of any roster character`);
    const proof = evidence.records[record];
    assert.ok(proof, `${record}: no evidence`);
    const listed = new Set(proof.listedAppearances);
    const names = character.outfits.map(row => row.name);
    assert.equal(new Set(names).size, names.length, `${record}: a name twice`);
    assert.ok(names.length >= 2, `${record}: one look is no rotation`);
    for (const {name, kind} of character.outfits) {
      assert.ok(listed.has(name), `${record}: ${name} is not in its template (${proof.template})`);
      assert.ok(KINDS.has(kind), `${record}: ${name} has the kind ${kind}`);
      assert.doesNotMatch(name, FORBIDDEN, `${record}: ${name} is a look that must not be worn`);
    }
    const base = character.outfits.find(row => row.name === character.base);
    assert.ok(base && base.kind === 'any', `${record}: the base look is in the list and is worn day and night`);
    // The base is what a copy wears when nothing chooses: the template default, or the one appearance companion-records.lua selects (Kerry), or
    // (a template whose default is 'random') the one named here with explicit.
    if (record === 'Character.Kerry') assert.match(recordsSource, new RegExp(`kerryAppearance = '${character.base}'`));
    else if (proof.templateDefault === 'random') assert.equal(character.explicit, true, `${record}: a random default needs explicit`);
    else assert.equal(character.base, proof.templateDefault, `${record}: the base is not the template default`);
    // Never a template shared with the crowd: its looks belong to other people.
    assert.doesNotMatch(proof.template, /\/(?:citizen|gang|service|corpo|boss)\/|\/entities\/(?:citizen|gang)\//i, `${record}: a shared crowd template`);
  }
});

test('the list: home looks exist for the characters that live with V, and nobody has a home look without a rotation partner', () => {
  const home = Object.entries(data).filter(([, character]) => character.outfits.some(row => row.kind === 'home')).map(([record]) => record);
  for (const record of ['Character.Judy', 'Character.Panam', 'Character.Sobchak', 'Character.Kerry']) assert.ok(home.includes(record), record);
  assert.ok(!Object.values(data).some(character => character.outfits.every(row => row.kind === 'home')));
  const count = Object.values(data).reduce((total, character) => total + character.outfits.length, 0);
  assert.ok(count >= 40, `${count} outfits`);
});

test('the list: the evidence file names both game versions and lists the same names for each record it covers', () => {
  assert.match(evidence.about, /game 2\.5/);
  assert.match(evidence.about, /game 2\.31/);
  for (const [record, proof] of Object.entries(evidence.records)) {
    assert.ok(data[record], `${record} has evidence but no list`);
    assert.ok(proof.listedAppearances.length >= 2, record);
  }
});

test('the evidence script reads the same list this test reads, and refuses a name the template does not list or two games that disagree', () => {
  assert.deepEqual(Object.keys(readOutfitList(dataSource)).sort(), Object.keys(data).sort());
  assert.deepEqual(readOutfitList(dataSource)['Character.Judy'].outfits, data['Character.Judy'].outfits.map(row => row.name));
  assert.deepEqual(appearancesOf({Data: {RootChunk: {defaultAppearance: {$value: 'a'}, appearances: [{name: {$value: 'a'}}, {name: {$value: 'b'}}, {}]}}}), {default: 'a', names: ['a', 'b']});
  const TEMPLATE = 't' + String.fromCharCode(92) + 'x.ent';
  const list = {'Character.X': {base: 'a', outfits: ['a', 'b']}};
  const game = (names, template = TEMPLATE, root = 'g') => ({root, templates: {'Character.X': template}, read: {[template]: {default: 'a', names}}});
  assert.deepEqual(buildEvidence(list, [game(['b', 'a', 'c']), game(['c', 'a', 'b'], TEMPLATE, 'g2')]),
    {'Character.X': {template: 't/x.ent', templateDefault: 'a', listedAppearances: ['a', 'b', 'c']}});
  assert.throws(() => buildEvidence(list, [game(['a'])]), /b is not listed/);
  assert.throws(() => buildEvidence(list, [game(['a', 'b']), game(['a', 'b', 'c'], TEMPLATE, 'g2')]), /different appearances/);
  assert.throws(() => buildEvidence(list, [{root: 'g', templates: {}, read: {}}]), /no entity template/);
});

// ---------------------------------------------------------------- the module under fengari

const fixture = `
local clock, hours = 1000, 24 * 3 + 10   -- game day 3, 10:00
local outfits = (function() ${moduleSource} end)()
outfits.clock = function() return clock end
local realDofile = dofile
dofile = function(name)
  assert(name == 'companion-outfits-data.lua', name)
  return (function() ${dataSource} end)()
end
local f = {enabled = true, world = nil, busy = {}, seen = false, angle = nil, place = nil, failPrefetch = false, failApply = false, applyTakes = true, rolls = {}}
local worn, rowsList, logs, calls = {}, {}, {}, {rows = 0, hours = 0, world = 0, prefetch = {}, apply = {}, remember = {}, busy = 0, frustum = 0, place = 0}
outfits.deps = {
  enabled = function() return f.enabled end,
  rows = function()
    calls.rows = calls.rows + 1
    local out = {}
    for _, row in ipairs(rowsList) do out[#out + 1] = {serial = row.serial, key = row.key, record = row.record, npc = {serial = row.serial}} end
    return out
  end,
  current = function(row) return worn[row.serial] end,
  prefetch = function(row, name) if f.failPrefetch then error('no such appearance') end calls.prefetch[#calls.prefetch + 1] = row.serial .. ':' .. name end,
  apply = function(row, name)
    if f.failApply then error('the copy is gone') end
    calls.apply[#calls.apply + 1] = row.serial .. ':' .. name
    if f.applyTakes then worn[row.serial] = name end
  end,
  remember = function(row, name) calls.remember[#calls.remember + 1] = row.serial .. ':' .. tostring(name) end,
  gameHours = function() calls.hours = calls.hours + 1; return hours end,
  place = function() calls.place = calls.place + 1; return f.place end,
  world = function() calls.world = calls.world + 1; return f.world end,
  busy = function(row) calls.busy = calls.busy + 1; return f.busy[row.serial] end,
  frustum = function() calls.frustum = calls.frustum + 1; return f.seen end,
  angle = function() return f.angle end,
  random = function() if #f.rolls > 0 then return table.remove(f.rolls, 1) end return 0 end,
  log = function(line) logs[#logs + 1] = line end,
}
local function member(serial, key, record, name)
  rowsList[#rowsList + 1] = {serial = serial, key = key, record = record}
  worn[serial] = name
end
local function logged(text) for _, line in ipairs(logs) do if line:find(text, 1, true) then return true end end return false end
-- One check: the tick is given a step as long as the wait, so exactly one cycle runs.
local function cycle(seconds) clock = clock + (seconds or 20); outfits.tick({}, seconds or 20, true) end
local function at(day, hour) hours = day * 24 + hour end
local function count(list) return #list end
`;

test('the decision: day and night, required and variety, home, bad looks, and a look the list does not hold', () => runWith(`${fixture}
  assert(outfits.period(5) == 'night' and outfits.period(6) == 'day' and outfits.period(18) == 'day' and outfits.period(19) == 'night' and outfits.period(0) == 'night')
  local panam = outfits.character('Character.Panam')
  local function ctx(extra) local c = {period = 'day', home = false, hours = 100, hourChanged = false, bad = {}, random = function() return 0 end}
    for k, v in pairs(extra or {}) do c[k] = v end return c end
  -- Her day look at night is not allowed any more: she goes back to the one look that is worn at night.
  local name, why = outfits.choose(panam, 'panam_no_jacket', ctx({period = 'night'}))
  assert(name == 'panam_default' and why == 'required', tostring(name))
  -- Nothing to do while the worn look is allowed and no hour changed.
  assert(outfits.choose(panam, 'panam_default', ctx()) == nil)
  -- Variety: only on an hour change, after the dwell, and only when the roll is under the chance.
  assert(outfits.choose(panam, 'panam_default', ctx({hourChanged = true, random = function() return 0.1 end})) == 'panam_no_jacket')
  assert(outfits.choose(panam, 'panam_default', ctx({hourChanged = true, random = function() return 0.9 end})) == nil, 'a roll over the chance')
  assert(outfits.choose(panam, 'panam_default', ctx({hourChanged = true, changedAt = 98, random = function() return 0.1 end})) == nil, 'inside the dwell')
  assert(outfits.choose(panam, 'panam_default', ctx({hourChanged = true, changedAt = 90, random = function() return 0.1 end})) == 'panam_no_jacket', 'after the dwell')
  -- Home: only the home look; away from home never the home look; a looks list without one keeps its rotation.
  assert(outfits.choose(panam, 'panam_default', ctx({home = true})) == 'panam__mq055__apartment_01')
  assert(outfits.choose(panam, 'panam__mq055__apartment_01', ctx({home = false})) == 'panam_default', 'leaving home')
  assert(outfits.choose(panam, 'panam__mq055__apartment_01', ctx({home = true, hourChanged = true, random = function() return 0 end})) == nil, 'the only home look')
  local jackie = outfits.character('Character.Jackie')
  assert(outfits.choose(jackie, 'jackie_welles_default', ctx({home = true})) == nil, 'no home look: home changes nothing')
  assert(outfits.choose(jackie, 'jackie_welles_default', ctx({period = 'night', hourChanged = true, random = function() return 0.1 end})) == 'jackie_welles_valentino')
  -- A look that failed once is not chosen again.
  assert(outfits.choose(panam, 'panam_no_jacket', ctx({period = 'night', bad = {panam_default = true}})) == nil)
  -- A look the list does not hold (a world character's copy in the clothes the original wore) is left alone.
  assert(outfits.choose(panam, 'panam__q203__shower', ctx({period = 'night'})) == nil)
  assert(outfits.choose(nil, 'x', ctx()) == nil and outfits.choose(panam, nil, ctx()) == nil)
  -- Every character always has a look for every hour away from home (the base is worn day and night).
  for record, character in pairs((outfits.data or dofile('companion-outfits-data.lua')).characters) do
    for _, period in ipairs({'day', 'night'}) do
      local found = false
      for _, row in ipairs(character.outfits) do if row[2] == 'any' or row[2] == period then found = true end end
      assert(found, record .. ' ' .. period)
    end
  end
`));

test('a change waits until nobody is looking, then loads, schedules and is read back; the copy is then flagged as changed', () => runWith(`${fixture}
  member(1, 'panam-palmer', 'Character.Panam', 'panam_no_jacket')
  at(3, 17); cycle()                                   -- first look: sets the hour, no change due (it is a day look at 17:00)
  assert(#calls.prefetch == 0)
  at(3, 20); f.seen = true; cycle()                    -- night: the day look is not allowed, but the camera sees her
  assert(#calls.prefetch == 0 and #calls.apply == 0, 'nothing happens in view')
  assert(logged('waiting until nobody is looking'))
  assert(calls.frustum >= 1)
  f.seen = false; cycle()                              -- out of view: the look is loaded first
  assert(#calls.prefetch == 1 and calls.prefetch[1] == '1:panam_default' and #calls.apply == 0)
  assert(outfits.snapshot()[1].staged == 'panam_default')
  cycle(1.0)                                           -- a second later: still unseen, scheduled
  assert(#calls.apply == 1 and calls.apply[1] == '1:panam_default' and outfits.snapshot()[1].pending == 'panam_default')
  cycle(1.0)                                           -- read back: it shows
  assert(outfits.snapshot()[1].pending == nil and outfits.snapshot()[1].current == 'panam_default')
  assert(logged('now wears panam_default (required)'))
  assert(outfits.status(1) == nil, 'her base look is not a change of clothes')
  -- The day look again in the morning: out of view, now flagged.
  f.rolls = {0.9}; at(4, 7); cycle(); assert(#calls.prefetch == 1, 'a roll over the chance: nothing to change')
`));

test('the camera looks back between the load and the change: the change is dropped and tried again later', () => runWith(`${fixture}
  member(1, 'panam-palmer', 'Character.Panam', 'panam_no_jacket')
  f.seen = true
  at(3, 20); cycle(); f.seen = false; cycle()
  assert(#calls.prefetch == 1)
  f.seen = true; cycle(1.0)
  assert(#calls.apply == 0 and outfits.snapshot()[1].staged == nil, 'in view at the second step: nothing scheduled')
  f.seen = false; cycle(); assert(#calls.prefetch == 2)
  cycle(1.0); assert(#calls.apply == 1)
`));

test('never during a fight, a scene, a seat or a ride, and the reason is said once', () => runWith(`${fixture}
  member(1, 'panam-palmer', 'Character.Panam', 'panam_no_jacket')
  at(3, 20); f.world = 'combat'; cycle(); cycle(); cycle()
  assert(#calls.prefetch == 0 and logged('waiting for open gameplay (combat)'))
  local said = 0; for _, line in ipairs(logs) do if line:find('waiting for open gameplay', 1, true) then said = said + 1 end end
  assert(said == 1, 'said once: ' .. said)
  f.world = nil; f.busy[1] = 'seated'; cycle(); assert(#calls.prefetch == 0 and #calls.apply == 0)
  f.busy[1] = nil; cycle(); assert(#calls.prefetch == 1)
  -- A fight that starts between the load and the change keeps the change back.
  f.world = 'combat'; cycle(1.0); assert(#calls.apply == 0)
  f.world = nil; cycle(); cycle(1.0); assert(#calls.apply == 1)
`));

test('the frustum test is the games own; without it the angle decides, and an unreadable view counts as seen', () => runWith(`${fixture}
  member(1, 'panam-palmer', 'Character.Panam', 'panam_no_jacket')
  at(3, 20); f.seen = nil; f.angle = 30; cycle(); assert(#calls.prefetch == 0, 'inside the angle: seen')
  f.angle = 100; cycle(); assert(#calls.prefetch == 1, 'behind the camera: unseen')
  assert(logged('the camera angle decides'), 'said once why the angle decides')
  f.angle = nil; f.seen = nil
  local second = outfits.inView({npc = {}}, {})
  assert(second == true, 'nothing readable: seen')
  f.seen = true; assert(outfits.inView({npc = {}}, {}) == true)
  f.seen = false; assert(outfits.inView({npc = {}}, {}) == false)
`));

test('a look that never shows is given up after 20 s, the old name is remembered, and that look is not tried again', () => runWith(`${fixture}
  f.applyTakes = false
  member(1, 'panam-palmer', 'Character.Panam', 'panam_no_jacket')
  at(3, 20); cycle(); cycle(1.0)
  assert(#calls.prefetch == 1 and #calls.apply == 1)
  cycle(5.0); assert(outfits.snapshot()[1].pending == 'panam_default', 'still waiting')
  cycle(16.0)
  assert(outfits.snapshot()[1].pending == nil and #calls.remember == 1 and calls.remember[1] == '1:panam_no_jacket')
  assert(logged('did not change into panam_default'))
  cycle(); cycle(); assert(#calls.prefetch == 1, 'not tried again')
  -- An error from the game while preparing or scheduling is a bad look too.
  f.applyTakes = true; f.failPrefetch = true
  member(2, 'judy-alvarez', 'Character.Judy', 'judy__mq055__apartment_01')
  cycle(); assert(logged('could not prepare judy_default'))
  f.failPrefetch = false; cycle(); cycle(); assert(calls.prefetch[#calls.prefetch] ~= '2:judy_default', 'a look that failed to load is not retried')
`));

test('home: set by name, by the game district, and by nothing for a character without a home look', () => runWith(`${fixture}
  member(1, 'judy-alvarez', 'Character.Judy', 'judy_default')
  member(2, 'jackie-welles', 'Character.Jackie', 'jackie_welles_default')
  at(3, 12); cycle()
  assert(#calls.prefetch == 0, 'not at home')
  -- Another feature: she lives here. The next look is within a second, not at the next hour change.
  assert(outfits.setHome('judy-alvarez', true) == true)
  cycle(1.0); assert(calls.prefetch[1] == '1:judy__mq055__apartment_01' and #calls.prefetch == 1, 'only Judy has a home look')
  cycle(1.0); cycle(1.0)
  assert(outfits.status(1) == 'home' and outfits.status(2) == nil)
  assert(outfits.isHome('judy-alvarez') == true)
  -- Not home any more (explicit false beats the district).
  f.place = 'LittleChina_VApartment'
  outfits.setHome('judy-alvarez', false); cycle(1.0)
  assert(calls.prefetch[2] == '1:judy_default', 'back in her own clothes: ' .. tostring(calls.prefetch[2]))
  cycle(1.0); cycle(1.0); assert(outfits.status(1) == nil)
  -- nil: follow the district. V in the apartment puts everybody who has a home look into it.
  outfits.setHome('judy-alvarez', nil); cycle()
  assert(calls.prefetch[3] == '1:judy__mq055__apartment_01', 'the apartment district: ' .. tostring(calls.prefetch[3]))
  cycle(1.0); cycle(1.0)
  f.place = 'Watson_Kabuki'; cycle(); assert(calls.prefetch[4] == '1:judy_default', 'left the apartment')
  assert(outfits.setHome('', true) == false and outfits.setHome('x', 'yes') == false and outfits.setHome(nil, true) == false)
  for _, name in ipairs({'LittleChina_VApartment', 'Northside_Apartment', 'JapanTown_Apartment', 'Glen_Apartment', 'CorpoPlaza_Apartment'}) do
    f.place = name; assert(outfits.vAtHome() == true, name)
  end
  f.place = nil; assert(outfits.vAtHome() == nil)
  f.place = 'Watson'; assert(outfits.vAtHome() == false)
  assert(outfits.hasHomeOutfit('Character.Judy') and not outfits.hasHomeOutfit('Character.Jackie') and not outfits.hasHomeOutfit('Character.Nobody'))
`));

test('a new copy is created in the right clothes, so nothing is ever changed in front of V', () => runWith(`${fixture}
  at(3, 22)
  assert(outfits.spawnAppearance('Character.Jackie', 'jackie-welles') == nil, 'the base look is worn at night: nothing to say')
  assert(outfits.spawnAppearance('Character.Nobody', 'x') == nil)
  assert(outfits.spawnAppearance('Character.sq021_joss', 'joss-kutcher') == 'citizen__lowlife_wa__sq029__joss', 'a random default is always named')
  f.place = 'Glen_Apartment'
  assert(outfits.spawnAppearance('Character.Judy', 'judy-alvarez') == 'judy__mq055__apartment_01', 'at home she arrives in home clothes')
  assert(outfits.spawnAppearance('Character.Jackie', 'jackie-welles') == nil)
  f.place = 'Watson'; outfits.setHome('judy-alvarez', true)
  assert(outfits.spawnAppearance('Character.Judy', 'judy-alvarez') == 'judy__mq055__apartment_01', 'named home')
  outfits.setHome('judy-alvarez', nil)
  assert(outfits.spawnAppearance('Character.Judy', 'judy-alvarez') == nil)
  f.enabled = false; assert(outfits.spawnAppearance('Character.Judy', 'judy-alvarez') == nil, 'off: nothing')
  f.enabled = true; hours = nil
  outfits.deps.gameHours = function() return nil end
  assert(outfits.spawnAppearance('Character.Judy', 'judy-alvarez') == nil and outfits.spawnAppearance('Character.sq021_joss', 'j') == 'citizen__lowlife_wa__sq029__joss')
`));

test('the cost: nothing is read between checks, nothing while the setting is off or the world is not ready, and a copy the list does not hold is left alone', () => runWith(`${fixture}
  member(1, 'panam-palmer', 'Character.Panam', 'panam_default')
  for _ = 1, 150 do clock = clock + 0.1; outfits.tick({}, 0.1, true) end
  assert(calls.rows == 1, 'the first look runs at once and nothing was read for the next 15 s: ' .. calls.rows)
  for _ = 1, 60 do clock = clock + 0.1; outfits.tick({}, 0.1, true) end
  assert(calls.rows == 2, 'the next look, 20 s after the first: ' .. calls.rows)
  -- A world that is not ready, and a setting that is off, cost one comparison and nothing else.
  local before = calls.rows
  for _ = 1, 400 do outfits.tick({}, 0.1, false) end
  f.enabled = false
  for _ = 1, 400 do outfits.tick({}, 0.1, true) end
  assert(calls.rows == before and calls.hours == 2 and calls.world == 0)
  -- No copies to look at: the clock is not read.
  f.enabled = true; rowsList = {}
  local hoursBefore = calls.hours
  cycle(); assert(calls.hours == hoursBefore)
  -- A copy in a look the list does not hold.
  member(5, 'panam-palmer', 'Character.Panam', 'panam__q203__shower')
  at(3, 21); cycle(); cycle(); assert(#calls.prefetch == 0 and #calls.apply == 0)
  -- A record the list does not know (the rows would not carry it, but a stale row must not break the cycle).
  member(6, 'x', 'Character.Nobody', 'whatever')
  cycle(); assert(#calls.prefetch == 0)
  -- The module keeps no handle of the game between checks.
  for _, row in ipairs(outfits.snapshot()) do for k, v in pairs(row) do assert(type(v) ~= 'table' and type(v) ~= 'userdata', k) end end
  outfits.reset(); assert(#outfits.snapshot() == 0 and outfits.isHome('panam-palmer') == nil)
`));

test('a copy that was created in its look is known from the start, and fast travel keeps the members while a new session forgets them', () => runWith(`${fixture}
  outfits.created(7, 'judy-alvarez', 'Character.Judy', 'judy__mq055__apartment_01')
  assert(outfits.status(7) == 'home')
  outfits.created(8, 'judy-alvarez', 'Character.Judy', nil)
  assert(outfits.status(8) == nil)
  outfits.created(7, 'judy-alvarez', 'Character.Judy', nil); assert(outfits.status(7) == nil, 'made again in the base look (fast travel)')
  outfits.created(7, 'judy-alvarez', 'Character.Judy', 'judy__mq055__apartment_01'); assert(outfits.status(7) == 'home')
  outfits.forget(7); assert(outfits.status(7) == nil)
  outfits.created(9, 'jackie-welles', 'Character.Jackie', 'jackie_welles__q005_suit'); assert(outfits.status(9) == 'changed')
  outfits.reset(); assert(outfits.status(9) == nil)
`));

test('without a random function the module uses its own generator and leaves the shared math.random alone', () => runWith(`${fixture}
  outfits.deps.random = nil
  local before = math.random()
  math.randomseed(7); local expected = math.random()
  math.randomseed(7)
  local seen, distinct = {}, 0
  for _ = 1, 200 do
    local r = outfits.random()
    assert(r >= 0 and r < 1, tostring(r))
    if not seen[math.floor(r * 10)] then seen[math.floor(r * 10)] = true; distinct = distinct + 1 end
  end
  assert(distinct == 10, 'ten tenths all visited: ' .. distinct)
  assert(math.random() == expected, 'math.random was not consumed')
  member(1, 'panam-palmer', 'Character.Panam', 'panam_no_jacket')
  at(3, 20); cycle(); assert(#calls.prefetch == 1, 'a decision without deps.random')
`));

test('the module keeps no game handle and has no per-frame entry', () => {
  assert.doesNotMatch(moduleSource, /\.npc\s*=/, 'a row\'s npc is used inside a call, never stored');
  assert.doesNotMatch(moduleSource, /registerForEvent|onUpdate|Observe\(|ObserveAfter\(|Override\(|GameSession|Cron/);
  // Every game read is behind deps, so the tests above are the whole of it.
  assert.doesNotMatch(moduleSource, /Game\.|GetCameraSystem|GetPlayer|TweakDB/);
});

// ---------------------------------------------------------------- companions.lua

const engine = companionEngine + `
  companions.registerDefinition('judy-alvarez', {id = 'Character.Judy', name = 'Judy', profileKey = 'judy-alvarez'})
  companions.registerDefinition('kerry-eurodyne', {id = 'Character.Kerry', name = 'Kerry', profileKey = 'kerry-eurodyne'})
  companions.registerDefinition('panam-palmer', {id = 'Character.Panam', name = 'Panam', profileKey = 'panam-palmer'})
`;
function runCompanions(body) { runWith(engine + body); }

test('companions: a new copy is created in the look the hook names, and the hook is told the record and the profile key', () => runCompanions(`
  local seen = {}
  companions.spawnOutfit = function(record, key) seen[#seen + 1] = record .. '/' .. tostring(key); return 'judy__mq055__apartment_01' end
  local created = {}
  companions.outfitCreated = function(serial, key, record, name) created[#created + 1] = {serial, key, record, name} end
  local judy = spawn('judy-alvarez')
  assert(judy.spec.appearanceName == 'judy__mq055__apartment_01' and seen[1] == 'Character.Judy/judy-alvarez')
  assert(#created == 1 and created[1][2] == 'judy-alvarez' and created[1][3] == 'Character.Judy' and created[1][4] == 'judy__mq055__apartment_01')
  -- The hook has nothing to say: the copy is made exactly as before.
  companions.spawnOutfit = function() return nil end
  assert(spawn('panam-palmer').spec.appearanceName == nil)
  companions.spawnOutfit = function() error('the list could not be read') end
  assert(spawn('panam-palmer').spec.appearanceName == nil, 'a failing hook never stops a spawn')
  companions.spawnOutfit = nil
  assert(spawn('panam-palmer').spec.appearanceName == nil)
`));

test('companions: Kerry keeps his clothed appearance unless the hook names a look of his own', () => runCompanions(`
  companions.spawnOutfit = function() return nil end
  assert(spawn('kerry-eurodyne').spec.appearanceName == 'kerry_eurodyne_kerry_eurodyne_old_no_sunglasses')
  companions.spawnOutfit = function() return 'kerry_eurodyne__mq055__apartment_01' end
  assert(spawn('kerry-eurodyne').spec.appearanceName == 'kerry_eurodyne__mq055__apartment_01')
`));

test('companions: the rows are the ready copies the list knows, with a serial, a key, a record and the npc', () => runCompanions(`
  local judy = spawn('judy-alvarez'); local panam = spawn('panam-palmer')
  local rows = companions.outfitRows(function(record) return record == 'Character.Judy' end)
  assert(#rows == 1 and rows[1].record == 'Character.Judy' and rows[1].key == 'judy-alvarez' and rows[1].npc == judy and rows[1].serial == companions.list()[1].serial)
  assert(#companions.outfitRows(function() return true end) == 2)
  assert(#companions.outfitRows(function() return false end) == 0)
`));

test('companions: a resident of V\'s flat (a visiting copy owned by housemates) is dressed like a party copy; an immersive visitor and a stranger are not', () => runCompanions(`
  local seen = {}
  companions.outfitCreated = function(serial, key, record, name) seen[#seen + 1] = key end
  local forgotten = {}
  companions.outfitForget = function(serial) forgotten[#forgotten + 1] = serial end
  local function visit(key, id, owner)
    local serial = companions.spawn(key, {profileKey = key, profileName = key,
      appointment = {id = id, owner = owner, home = owner and 'glen' or nil, position = Vector4.new(40, 40, 0), facing = {x = -1, y = 0}}})
    tick()
    return serial, entities[sequence]
  end
  local residentSerial, resident = visit('judy-alvarez', 'hm:judy-alvarez', 'housemates')
  local visitorSerial, guest = visit('panam-palmer', 9, nil)
  assert(#seen == 2 and seen[1] == 'judy-alvarez', 'the outfit module is told about a resident like any new copy')
  local rows = companions.outfitRows(function() return true end)
  assert(#rows == 1 and rows[1].serial == residentSerial and rows[1].key == 'judy-alvarez', 'only the resident is listed')
  assert(companions.outfitBusy(residentSerial) == nil, 'she may change clothes at home')
  assert(companions.outfitBusy(visitorSerial) == 'not ready', 'a visitor may not')
  local asked = {}
  function resident:PrefetchAppearanceChange(name) asked[#asked + 1] = 'prefetch:' .. name end
  function resident:ScheduleAppearanceChange(name) asked[#asked + 1] = 'schedule:' .. name end
  assert(companions.changeAppearance(residentSerial, 'judy__mq055__apartment_01', 'prefetch'))
  assert(companions.changeAppearance(residentSerial, 'judy__mq055__apartment_01', 'apply'))
  assert(#asked == 2 and asked[2] == 'schedule:judy__mq055__apartment_01')
  assert(not pcall(companions.changeAppearance, visitorSerial, 'x', 'apply'), 'a visitor is refused')
  -- Moving out: she is forgotten by the outfit module; a visitor's end tells it nothing.
  companions.dismiss(visitorSerial)
  assert(#forgotten == 0)
  companions.dismiss(residentSerial)
  assert(#forgotten == 1 and forgotten[1] == residentSerial, 'a resident who is gone for good is forgotten')
`));

test('companions: prefetch changes nothing; apply schedules the look and a recreated copy is made in it; forget restores the name', () => runCompanions(`
  local judy = spawn('judy-alvarez'); local serial = companions.list()[1].serial
  local asked = {}
  function judy:PrefetchAppearanceChange(name) asked[#asked + 1] = 'prefetch:' .. name end
  function judy:ScheduleAppearanceChange(name) asked[#asked + 1] = 'schedule:' .. name end
  assert(companions.changeAppearance(serial, 'judy__mq055__apartment_01', 'prefetch'))
  assert(#asked == 1 and asked[1] == 'prefetch:judy__mq055__apartment_01')
  assert(companions.changeAppearance(serial, 'judy__mq055__apartment_01', 'apply'))
  assert(asked[2] == 'schedule:judy__mq055__apartment_01')
  assert(not pcall(companions.changeAppearance, 99999, 'x', 'apply'), 'a copy that is gone is an error')
  -- Fast travel: the copy is made again in the same clothes.
  assert(companions.beginFastTravel())
  entities[tonumber(judy.id.hash)] = nil
  assert(companions.fastTravel())
  tick(8)
  local again = entities[sequence]
  assert(again and again ~= judy and again.spec.appearanceName == 'judy__mq055__apartment_01', 'the recreated copy lost its clothes')
  -- A change that never showed is forgotten.
  local row = companions.list()[1]
  assert(companions.changeAppearance(row.serial, nil, 'forget'))
`));

test('companions: a copy that is not ready or is busy is not changed', () => runCompanions(`
  local judy = spawn('judy-alvarez'); local serial = companions.list()[1].serial
  assert(companions.outfitBusy(serial) == nil)
  assert(companions.outfitBusy(424242) == 'gone')
  judy.combat = true; tick(2)
  assert(companions.outfitBusy(serial) == 'combat', tostring(companions.outfitBusy(serial)))
  judy.combat = false
  function judy:IsDeadNoStatPool() return true end
  assert(not pcall(companions.changeAppearance, serial, 'x', 'apply'))
`));

test('companions: the turn context learns what each copy wears', () => runCompanions(`
  local judy = spawn('judy-alvarez')
  companions.outfitStatus = function(serial) return 'home' end
  assert(companions.activityInputs({}).rows['judy-alvarez'].outfit == 'home')
  companions.outfitStatus = function() error('boom') end
  assert(companions.activityInputs({}).rows['judy-alvarez'].outfit == nil, 'a failing read adds nothing')
  companions.outfitStatus = nil
  assert(companions.activityInputs({}).rows['judy-alvarez'].outfit == nil)
`));

// ---------------------------------------------------------------- init.lua

test('init.lua: the tick is in the 10 Hz branch after the poll gate, off costs one boolean, the module is loaded on use, and a new session resets it', () => {
  const gate = initSource.indexOf('if poll < 0.1 then return end');
  const tick = initSource.indexOf('pcall(convaiOutfitTick, player, elapsedPoll, worldReady)');
  assert.ok(gate > 0 && tick > gate, 'the outfit tick comes after the 0.1 s gate of onUpdate');
  assert.ok(tick < initSource.indexOf('registerForEvent(\'onShutdown\''));
  assert.match(initSource, /function convaiOutfitTick\(player, elapsed, ready\)\s*if not manager\.companionOutfits\(\) then return end\s*convaiOutfitModule\(\)\.tick\(player, elapsed, ready\)/);
  assert.match(initSource, /convaiOutfits = dofile\('companion-outfits\.lua'\)/);
  // Only companions.lua's three hooks and the API global leave init.lua; the module is not on the onUpdate path any other way.
  assert.equal([...initSource.matchAll(/convaiOutfitTick/g)].length, 2, 'defined once and called once (the pcall in the 10 Hz branch)');
  assert.match(initSource, /if convaiOutfits and preserveTransit ~= true then pcall\(convaiOutfits\.reset\) end/);
  assert.match(initSource, /companions\.spawnOutfit = function\(record, key\)\s*if not manager\.companionOutfits\(\) then return nil end/);
  assert.match(initSource, /convaiOutfitApi = \{\s*setHome = function\(key, on\)/);
  // The game's own frustum test and the margins its reaction code uses; the world check is the battle observer's.
  assert.match(initSource, /IsInCameraFrustum\(npc, 2\.0, 0\.75\)/);
  assert.match(initSource, /world = function\(\)\s*local sample = battleObserver\.sample\(Game\.GetPlayer\(\)\)/);
  assert.match(initSource, /gameHours = function\(\)\s*local seconds = worldKnowledgeModule\.nativeGameTime/);
});

test('init.lua: only our own copies are ever listed; the rows come from the managed party', () => {
  const companions = read('../mod/companions.lua');
  const rows = companions.slice(companions.indexOf('function M.outfitRows'), companions.indexOf('function M.outfitBusy'));
  assert.match(rows, /for _,entry in ipairs\(entries\) do/);
  assert.match(rows, /outfitEligible\(entry\)/);
  const eligible = companions.slice(companions.indexOf('local function outfitEligible'), companions.indexOf('function M.outfitRows'));
  assert.match(eligible, /entry\.state=='ready' or \(entry\.state=='visiting' and entry\.owner=='housemates'\)/, 'a resident of the flat counts, an immersive visitor does not');
  assert.doesNotMatch(rows, /GetTargetingSystem|GetLookAtObject|Game\./, 'nobody the game placed is reachable from here');
});
