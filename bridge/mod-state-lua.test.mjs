import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Other mods' state, the game side (docs/DYNAMIC_INFO.md, "Other mods' state"): mod/mod-state.lua reads Dark Future's script classes through the
// scriptable systems container, and the `mods` reader in mod/init.lua loads that module only when Dark Future is there. Run in fengari with a fake
// Game and CName, counting every lookup and call.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const moduleSource = read('../mod/mod-state.lua');
const init = read('../mod/init.lua');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

// A fake game: `systems` maps a class name to an object; every lookup and getter call is counted. A getter value of the string 'raise' raises.
const world = `
  local counts = {lookups = 0, calls = 0, names = {}}
  local systems = {}
  local containerFails = false
  CName = {new = function(text) return {text = text} end}
  Game = {GetScriptableSystemsContainer = function()
    if containerFails then error('no container') end
    return {Get = function(self, name)
      counts.lookups = counts.lookups + 1
      counts.names[#counts.names + 1] = name.text
      local found = systems[name.text]
      if found == 'raise' then error('unknown class ' .. name.text) end
      return found
    end}
  end}
  -- A system whose getters answer fixed values (a function value is called, 'raise' raises).
  local function system(values)
    local object = {}
    for method, value in pairs(values) do
      object[method] = function(self)
        counts.calls = counts.calls + 1
        if value == 'raise' then error('boom in ' .. method) end
        return value
      end
    end
    return object
  end
  local P = 'DarkFuture.Needs.'
  local A = 'DarkFuture.Addictions.'
  local C = 'DarkFuture.Conditions.'
  -- Every Dark Future system installed, fine (stage 0) unless overridden.
  local function install(over)
    over = over or {}
    local function pick(key, default) if over[key] ~= nil then return over[key] end return default end
    systems[P .. 'DFHydrationSystem'] = system({GetNeedStage = pick('hydration', 0)})
    systems[P .. 'DFNutritionSystem'] = system({GetNeedStage = pick('nutrition', 0)})
    systems[P .. 'DFEnergySystem'] = system({GetNeedStage = pick('energy', 0)})
    systems[P .. 'DFNerveSystem'] = system({GetNeedStage = pick('nerve', 0)})
    systems[A .. 'DFAlcoholAddictionSystem'] = system({GetWithdrawalLevel = pick('alcohol', 0), GetAddictionStage = pick('alcoholStage', 0)})
    systems[A .. 'DFNicotineAddictionSystem'] = system({GetWithdrawalLevel = pick('nicotine', 0), GetAddictionStage = pick('nicotineStage', 0)})
    systems[A .. 'DFNarcoticAddictionSystem'] = system({GetWithdrawalLevel = pick('narcotic', 0), GetAddictionStage = pick('narcoticStage', 0)})
    systems[C .. 'DFInjuryConditionSystem'] = system({GetConditionLevel = pick('injury', 0)})
    systems[C .. 'DFHumanityLossConditionSystem'] = system({GetConditionLevel = pick('humanity', 0)})
  end
  local function reset() counts.lookups, counts.calls, counts.names = 0, 0, {} end
  local function keys(t) local out = {} for k in pairs(t) do out[#out + 1] = k end table.sort(out) return table.concat(out, ',') end
`;
const withModule = code => run(`${world}
  local M = (function() ${moduleSource} end)()
  local lines = {}
  local function log(line) lines[#lines + 1] = line end
${code}`);

test('read: every notable stage of every system becomes one small table; stages below three are not sent', () => withModule(`
  install({hydration = 3, nutrition = 4, energy = 4, nerve = 2, alcohol = 4, alcoholStage = 3, nicotine = 2, narcotic = 3, narcoticStage = 1, injury = 3, humanity = 1})
  local out = M.read(nil, log)
  assert(type(out) == 'table' and type(out.darkFuture) == 'table')
  local d = out.darkFuture
  assert(d.hydration == 3 and d.nutrition == 4 and d.energy == 4, 'needs')
  assert(d.nerve == nil, 'nerve stage 2 is not worth saying')
  assert(d.injury == 3 and d.humanity == nil, 'conditions')
  assert(d.alcohol.withdrawal == 4 and d.alcohol.stage == 3, 'alcohol withdrawal with the addiction stage')
  assert(d.nicotine == nil, 'withdrawal level 2 is not sent')
  assert(d.narcotic.withdrawal == 3 and d.narcotic.stage == 1)
  assert(keys(d) == 'alcohol,energy,hydration,injury,narcotic,nutrition', keys(d))
`));

test('read: nothing notable is nil, so the snapshot drops the field', () => withModule(`
  install()
  assert(M.read(nil, log) == nil)
  install({hydration = 0, nutrition = 0, energy = 0, nerve = 2, alcohol = 2, alcoholStage = 4, nicotine = 1, injury = 2, humanity = 2})
  assert(M.read(nil, log) == nil, 'quiet stages of nerve and the conditions and an addiction without withdrawal say nothing')
  install({hydration = 1, nutrition = 1, energy = 2, nerve = 1})
  local d = M.read(nil, log).darkFuture
  assert(d.hydration == 1 and d.nutrition == 1 and d.energy == 2 and d.nerve == nil, 'hunger, thirst and tiredness are sent from stage 1 (Dark Future shows a status effect there), nerve is not')
`));

test('read: a system that is not running answers -1 (needs) or 0 (addictions, conditions): unknown, never a guess', () => withModule(`
  install({hydration = -1, nutrition = -1, energy = -1, nerve = -1})
  assert(M.read(nil, log) == nil, 'every need unknown')
  install({hydration = -1, energy = 4})
  local out = M.read(nil, log)
  assert(out.darkFuture.energy == 4 and out.darkFuture.hydration == nil, 'one unknown need does not hide the others')
  for _, bad in ipairs({7, -2, 2.5, 'x', true}) do
    install({energy = bad, hydration = 3})
    out = M.read(nil, log)
    assert(out.darkFuture.energy == nil and out.darkFuture.hydration == 3, tostring(bad))
  end
`));

test('read: the whole read is bounded: nine lookups and nine calls when everything is installed, at most eighteen and twelve in the worst case', () => withModule(`
  install({energy = 4})
  reset(); M.read(nil, log)
  assert(counts.lookups == 9 and counts.calls == 9, counts.lookups .. '/' .. counts.calls)
  -- With everything in withdrawal the addiction stage is asked too: three more calls.
  install({alcohol = 5, nicotine = 5, narcotic = 5})
  reset(); M.read(nil, log)
  assert(counts.lookups == 9 and counts.calls == 12, counts.lookups .. '/' .. counts.calls)
  -- Nothing installed: two candidate names for each of the nine.
  systems = {}
  M.reset(); reset()
  assert(M.read(nil, log) == nil)
  assert(counts.lookups == 18 and counts.calls == 0, counts.lookups .. '/' .. counts.calls)
`));

test('read: one missing system never disables the rest', () => withModule(`
  install({energy = 4, nerve = 3, injury = 3})
  systems[P .. 'DFHydrationSystem'] = nil
  systems[A .. 'DFAlcoholAddictionSystem'] = nil
  systems[C .. 'DFHumanityLossConditionSystem'] = nil
  local out = M.read(nil, log)
  assert(keys(out.darkFuture) == 'energy,injury,nerve', keys(out.darkFuture))
  -- A "Core" build that has only the basic needs.
  systems = {}
  systems[P .. 'DFHydrationSystem'] = system({GetNeedStage = 4})
  systems[P .. 'DFNutritionSystem'] = system({GetNeedStage = 3})
  out = M.read(nil, log)
  assert(keys(out.darkFuture) == 'hydration,nutrition', keys(out.darkFuture))
`));

test('read: a getter that raises, a lookup that raises, a missing method and a broken container never escape; they are logged once', () => withModule(`
  install({energy = 4})
  systems[P .. 'DFHydrationSystem'] = system({GetNeedStage = 'raise'})
  systems[P .. 'DFNutritionSystem'] = 'raise'
  systems[P .. 'DFNerveSystem'] = {}                       -- the class exists but the method does not
  systems[A .. 'DFAlcoholAddictionSystem'] = system({GetWithdrawalLevel = 'raise'})
  for round = 1, 3 do
    local out = M.read(nil, log)
    assert(out and keys(out.darkFuture) == 'energy', 'the rest still answers (round ' .. round .. ')')
  end
  local failures = 0
  for _, line in ipairs(lines) do if line:find('failed', 1, true) then failures = failures + 1 end end
  assert(failures <= 8, 'each failure kind is logged once, not every turn: ' .. failures)
  for _, line in ipairs(lines) do assert(#line < 260, 'a short line') end
  containerFails = true
  assert(M.read(nil, log) == nil, 'no container')
  containerFails = false
  Game = nil
  assert(M.read(nil, log) == nil, 'no Game')
  Game = {GetScriptableSystemsContainer = function() return nil end}
  assert(M.read(nil, log) == nil, 'no container object')
`));

test('read: a build whose class names moved to the bare names is found, and the name that answered is the one tried next', () => withModule(`
  systems['DFHydrationSystem'] = system({GetNeedStage = 4})
  systems['DFEnergySystem'] = system({GetNeedStage = 3})
  reset()
  local out = M.read(nil, log)
  assert(keys(out.darkFuture) == 'energy,hydration', keys(out.darkFuture))
  -- Nine systems, two names each, except the two found on the second name.
  local first = counts.lookups
  assert(first == 18)
  reset(); M.read(nil, log)
  local second = counts.lookups
  assert(second == 16, 'the two found systems are asked once now: ' .. second)
  reset(); M.read(nil, log)
  assert(counts.lookups == second, 'the same cost every turn, no growth')
  -- The remembered name goes first: hydration is asked once.
  reset(); M.read(nil, log)
  local asked = 0
  for _, name in ipairs(counts.names) do if name == 'DFHydrationSystem' then asked = asked + 1 end end
  assert(asked == 1)
  -- A class that disappears is looked up again under all its names.
  systems['DFHydrationSystem'] = nil
  out = M.read(nil, log)
  assert(keys(out.darkFuture) == 'energy')
`));

test('read: the result carries plain numbers and strings only, never a game object', () => withModule(`
  install({energy = 4, alcohol = 3})
  local out = M.read({}, log)
  local function plain(value)
    if type(value) == 'table' then for k, v in pairs(value) do assert(type(k) == 'string'); plain(v) end
    else assert(type(value) == 'number' or type(value) == 'string' or type(value) == 'boolean', type(value)) end
  end
  plain(out)
  assert(M.read(nil) ~= nil, 'no logger is fine')
  assert(M.read(nil, 'not a function') ~= nil)
`));

test('log: one line per distinct reading with the raw stages, none for an unchanged one; ? is unknown and - is a missing system', () => withModule(`
  install({energy = 4, hydration = 3, nerve = -1, alcohol = 3})
  systems[C .. 'DFHumanityLossConditionSystem'] = nil
  M.read(nil, log); M.read(nil, log); M.read(nil, log)
  local readings = {}
  for _, line in ipairs(lines) do if line:find('^Mod state: dark%-future ') then readings[#readings + 1] = line end end
  assert(#readings == 1, #readings)
  assert(readings[1] == 'Mod state: dark-future hydration=3 nutrition=0 energy=4 nerve=? alcohol=3 nicotine=0 narcotic=0 injury=0 humanity=-', readings[1])
  install({energy = 3, hydration = 3, nerve = 4, alcohol = 3})
  M.read(nil, log)
  readings = {}
  for _, line in ipairs(lines) do if line:find('^Mod state: dark%-future ') then readings[#readings + 1] = line end end
  assert(#readings == 2 and readings[2]:find('energy=3 nerve=4', 1, true), readings[2])
  -- The names that answered are logged once each.
  local found = 0
  for _, line in ipairs(lines) do if line:find('system found as', 1, true) then found = found + 1 end end
  assert(found == 9, found)   -- humanity was missing at first and found by the second reading: still once each
`));

test('log: when no system can be found at all it says so once and sends nothing', () => withModule(`
  M.read(nil, log); M.read(nil, log)
  local none = 0
  for _, line in ipairs(lines) do if line:find('none of its state systems', 1, true) then none = none + 1 end end
  assert(none == 1 and #lines == 1, none .. ' ' .. #lines)
`));

test('the module is passive: no registered event, no timer, no observer, no write, no setter, no per-frame code', () => {
  const code = moduleSource.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /registerForEvent|registerHotkey|Observe\(|Override\(|ObserveAfter|onUpdate|DelayCallback|Cron|io\.|os\.execute|os\.remove|dofile|require/);
  assert.doesNotMatch(code, /:Set[A-Z]\w*\(|:Mod[A-Z]\w*\(|:Change\w*\(|:Apply\w*\(|:Cure\w*\(|:Add\w*\(|:Remove\w*\(|:Queue\w*\(|:Send\w*\(|:Register\w*\(/);
  assert.doesNotMatch(code, /StatusEffect|Dark Future wiki|nexusmods/);
  // Only the documented getters are named.
  const getters = new Set(code.match(/'Get[A-Za-z]+'/g));
  assert.deepEqual([...getters].sort(), ["'GetAddictionStage'", "'GetConditionLevel'", "'GetNeedStage'", "'GetWithdrawalLevel'"]);
  assert.deepEqual([...new Set(code.match(/Game\.[A-Za-z]+/g))], ['Game.GetScriptableSystemsContainer']);
});

// ---------------------------------------------------------------------------------------------------------------------
// The loader in init.lua: Dark Future first, the module only when it is there.

const between = (from, to) => {
  const start = init.indexOf(from), end = init.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return init.slice(start, end);
};
const loader = between('mods = function(player)', "-- Read the game's dialogue volume");
// The presence probe is a global function of init.lua, shared by the reader and by the switch-off note.
const presence = between('convaiDarkFuturePresent = function()', '-- Music and TV, the song');

function withLoader(code) {
  run(`${world}
  local realModule = (function() ${moduleSource} end)()
  local clock, loads, brokenLoad = 1000, 0, false
  os.time = function() return clock end
  function dofile(path)
    assert(path == 'mod-state.lua', path)
    loads = loads + 1
    if brokenLoad then error('missing file') end
    return realModule
  end
  local logged = {}
  convaiLogLine = function(line) logged[#logged + 1] = line end
  ${presence}
  local options = {
    ${loader}
  }
${code}`);
}

test('loader: Dark Future absent: the module is never read from disk, and the probe is two lookups at most once a minute', () => withLoader(`
  for i = 1, 40 do assert(options.mods({}) == nil) end
  assert(loads == 0 and convaiModState == nil, 'not even read from disk')
  assert(counts.lookups == 2, 'one probe of two names, then silence for the minute: ' .. counts.lookups)
  clock = clock + 59
  assert(options.mods({}) == nil and counts.lookups == 2, 'still inside the minute')
  clock = clock + 2
  assert(options.mods({}) == nil and counts.lookups == 4 and loads == 0, 'probed again after a minute')
  clock = clock - 500   -- a clock that jumps back probes at once rather than waiting out a minute that never ends
  assert(options.mods({}) == nil and counts.lookups == 6 and loads == 0)
  assert(#logged == 0, 'a player without the mod gets no log line')
  assert(counts.calls == 0)
`));

test('loader: Dark Future present from the start: loaded once, read every turn window, the probe is not repeated', () => withLoader(`
  install({energy = 4})
  systems['DarkFuture.Main.DFMainSystem'] = {}
  reset()
  local out = options.mods({})
  assert(loads == 1 and out and out.darkFuture.energy == 4)
  assert(counts.names[1] == 'DarkFuture.Main.DFMainSystem', 'the main system is the probe')
  assert(counts.lookups == 1 + 9, 'one probe, nine reads: ' .. counts.lookups)
  reset()
  out = options.mods({})
  assert(loads == 1 and counts.lookups == 9 and out.darkFuture.energy == 4, 'no probe, no second load')
  assert(logged[1] == 'Mod state: Dark Future found, reader loaded')
`));

test('loader: the mod appears later (loaded after a loading screen): the next probe after a minute finds it', () => withLoader(`
  assert(options.mods({}) == nil and loads == 0)
  install({hydration = 4})
  systems['DarkFuture.Main.DFMainSystem'] = {}
  clock = clock + 10
  assert(options.mods({}) == nil and loads == 0, 'inside the minute it is not looked for')
  clock = clock + 60
  local out = options.mods({})
  assert(loads == 1 and out and out.darkFuture.hydration == 4)
`));

test('loader: a probe that finds the hydration system alone is enough (a build without the main system under that name)', () => withLoader(`
  install({nutrition = 3})
  local out = options.mods({})
  assert(loads == 1 and out.darkFuture.nutrition == 3)
`));

test('loader: a probe that raises is a miss; a module that fails to load is not retried; a reader that returns nothing gives nil', () => withLoader(`
  systems['DarkFuture.Main.DFMainSystem'] = 'raise'
  systems['DarkFuture.Needs.DFHydrationSystem'] = 'raise'
  assert(options.mods({}) == nil and loads == 0)
  systems['DarkFuture.Main.DFMainSystem'] = {}
  brokenLoad = true
  clock = clock + 100
  assert(options.mods({}) == nil and loads == 1)
  for i = 1, 5 do assert(options.mods({}) == nil) end
  assert(loads == 1 and convaiModState == false, 'a failed load is not retried every turn')
  assert(logged[#logged] == 'Mod state: Dark Future found, reader failed to load')
  Game = nil
  assert(options.mods({}) == nil, 'even with the game gone')
`));

test('loader: the reader holds nothing that runs by itself', () => {
  assert.doesNotMatch(loader, /registerForEvent|onUpdate|Observe|Cron|Delay/);
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"), init.indexOf("registerForEvent('onShutdown'"));
  assert.doesNotMatch(update, /convaiModState|mod-state/, 'onUpdate is untouched');
  assert.equal((init.match(/dofile, 'mod-state\.lua'/g) ?? []).length, 1, 'one loader');
});

test('turn context: the mods reader is called only while the switch is on, and a table it returns lands in the snapshot', () => run(`
  -- the real turn-context.lua, with a stubbed native adapter
  local TC = (function() ${read('../mod/turn-context.lua')} end)()
  local calls, on = 0, true
  local native = {player = function() return {} end, ready = function() return true end}
  local t = TC.new({native = native, enabled = function(kind) if kind == 'mods' then return on end return false end,
    mods = function() calls = calls + 1; return {darkFuture = {energy = 4}} end, now = function() return 100 end})
  local snapshot = t:capture()
  assert(snapshot and snapshot.mods and snapshot.mods.darkFuture.energy == 4 and calls == 1)
  on = false
  snapshot = t:capture()
  assert(calls == 1, 'off: the reader is not called')
  assert(snapshot == nil or snapshot.mods == nil)
  on = true
  local t2 = TC.new({native = native, enabled = function() return true end, mods = function() calls = calls + 1; error('Dark Future broke') end, now = function() return 100 end})
  t2:capture()
  assert(calls == 2, 'a raising reader does not break the capture')
`));

// ---------------------------------------------------------------------------------------------------------------------
// The probe line of 2026-10-26 (fix/df-hunger-3): what the game side found, as a note that rides the snapshot, and the switch-off line.

test('note: the compact text of what the last read found, for the turn\'s probe line; the needs always, the rest only while not 0', () => withModule(`
  assert(M.note() == nil, 'before any read')
  install({nutrition = 1, nerve = 1})
  assert(M.read(nil, log).darkFuture.nutrition == 1)
  assert(M.note() == 'installed=yes read=ok stage=hydration0,nutrition1,energy0,nerve1', M.note())
  install({hydration = -1, energy = 4, alcohol = 3, injury = 2})
  M.read(nil, log)
  assert(M.note() == 'installed=yes read=ok stage=hydration?,nutrition0,energy4,nerve0,alcohol3,injury2', M.note())
  -- Everything fine: no table to send, still a note (this is how the probe line tells "installed, read, nothing to say" from "not installed").
  install({})
  assert(M.read(nil, log) == nil)
  assert(M.note() == 'installed=yes read=ok stage=hydration0,nutrition0,energy0,nerve0', M.note())
  systems = {}
  M.reset()
  assert(M.note() == nil, 'a new save forgets it')
  M.read(nil, log)
  assert(M.note() == 'installed=yes read=none stage=hydration-,nutrition-,energy-,nerve-', M.note())
  containerFails = true
  M.read(nil, log)
  assert(M.note() == 'installed=yes read=failed stage=-', M.note())
`));

// A strict fake of the way CET and Dark Future 2.0.3 answer: the container and every getter are called with the object itself (a colon call), the class names
// are CName objects, an unknown class is nil, and a getter a class does not have is a missing method. Read from the game's own scripts: the needs have
// GetNeedStage (Int32, -1 while the system is not running), the addictions GetAddictionStage and GetWithdrawalLevel, the conditions GetConditionLevel (Uint32).
test('strict fake: the reader calls the container and every getter the way CET calls a script object, and reads the owner\'s live state (hungry at stage 1)', () => run(`
  local seen, calls = {}, {}
  local objects = {}
  local container = {}
  CName = {new = function(text) assert(type(text) == 'string', 'CName.new takes a string'); return setmetatable({text = text}, {__name = 'CName'}) end}
  function container.Get(self, name)
    assert(self == container, 'Get must be called with a colon')
    assert(getmetatable(name) and getmetatable(name).__name == 'CName', 'Get takes a CName, not a string')
    seen[#seen + 1] = name.text
    return objects[name.text]
  end
  Game = {GetScriptableSystemsContainer = function(...) assert(select('#', ...) == 0, 'no argument'); return container end}
  local function object(label, getters)
    local o = {}
    for method, value in pairs(getters) do
      o[method] = function(self, ...)
        assert(self == o, label .. ':' .. method .. ' must be called with a colon')
        assert(select('#', ...) == 0, method .. ' takes no argument')
        calls[#calls + 1] = label .. ':' .. method
        return value
      end
    end
    return o
  end
  -- The owner's state of 2026-10-26: nutrition 1, nerve 1, nothing else.
  objects['DarkFuture.Needs.DFHydrationSystem'] = object('hydration', {GetNeedStage = 0})
  objects['DarkFuture.Needs.DFNutritionSystem'] = object('nutrition', {GetNeedStage = 1})
  objects['DarkFuture.Needs.DFEnergySystem'] = object('energy', {GetNeedStage = 0})
  objects['DarkFuture.Needs.DFNerveSystem'] = object('nerve', {GetNeedStage = 1})
  objects['DarkFuture.Addictions.DFAlcoholAddictionSystem'] = object('alcohol', {GetAddictionStage = 2, GetWithdrawalLevel = 0})
  objects['DarkFuture.Addictions.DFNicotineAddictionSystem'] = object('nicotine', {GetAddictionStage = 0, GetWithdrawalLevel = 0})
  objects['DarkFuture.Addictions.DFNarcoticAddictionSystem'] = object('narcotic', {GetAddictionStage = 0, GetWithdrawalLevel = 0})
  objects['DarkFuture.Conditions.DFInjuryConditionSystem'] = object('injury', {GetConditionLevel = 0})
  objects['DarkFuture.Conditions.DFHumanityLossConditionSystem'] = object('humanity', {GetConditionLevel = 0})
  local M = (function() ${moduleSource} end)()
  local lines = {}
  local out = M.read(nil, function(line) lines[#lines + 1] = line end)
  local count = 0
  for _ in pairs(out.darkFuture) do count = count + 1 end
  assert(out and out.darkFuture.nutrition == 1 and out.darkFuture.nerve == nil and count == 1, 'only the hunger is worth sending')
  assert(#seen == 9 and #calls == 9, #seen .. '/' .. #calls)
  assert(M.note() == 'installed=yes read=ok stage=hydration0,nutrition1,energy0,nerve1', M.note())
  assert(lines[#lines] == 'Mod state: dark-future hydration=0 nutrition=1 energy=0 nerve=1 alcohol=0 nicotine=0 narcotic=0 injury=0 humanity=0', lines[#lines])
  -- A class with the wrong getter (a build that renamed it) is a missing method: logged once, the rest still answers.
  objects['DarkFuture.Needs.DFHydrationSystem'] = object('hydration', {GetStage = 4})
  M.reset(); lines = {}
  out = M.read(nil, function(line) lines[#lines + 1] = line end)
  assert(out and out.darkFuture.nutrition == 1 and out.darkFuture.hydration == nil)
  local failed = 0
  for _, line in ipairs(lines) do if line:find('hydration GetNeedStage failed', 1, true) then failed = failed + 1 end end
  assert(failed == 1, 'one line for the missing getter: ' .. failed)
`));

test('loader: the second answer is the note: installed and fine, a reader that failed to load; none while the mod is absent', () => withLoader(`
  local out, note = options.mods({})
  assert(out == nil and note == nil and loads == 0, 'absent: neither')
  install({})
  systems['DarkFuture.Main.DFMainSystem'] = {}
  clock = clock + 100
  out, note = options.mods({})
  assert(out == nil and note == 'installed=yes read=ok stage=hydration0,nutrition0,energy0,nerve0', tostring(note))
  install({nutrition = 1})
  out, note = options.mods({})
  assert(out and out.darkFuture.nutrition == 1 and note == 'installed=yes read=ok stage=hydration0,nutrition1,energy0,nerve0', tostring(note))
  convaiModState, brokenLoad, clock = nil, true, clock + 100
  out, note = options.mods({})
  assert(out == nil and note == 'installed=yes read=load-failed stage=-', tostring(note))
  out, note = options.mods({})
  assert(out == nil and note == 'installed=yes read=load-failed stage=-', 'the same on the next turn, no retry: ' .. tostring(note) .. ' ' .. loads)
`));

test('loader: switch off: one df line a session when Dark Future is installed (no state read, nothing loaded), none for a player without it, three probes at most', () => withLoader(`
  -- Without Dark Future: at most three probes, a minute apart, then silence; never a line.
  for i = 1, 30 do options.modsOff() end
  assert(counts.lookups == 2 and #logged == 0, 'one probe of two names inside the minute: ' .. counts.lookups)
  for round = 1, 6 do clock = clock + 61; for i = 1, 5 do options.modsOff() end end
  assert(counts.lookups == 6 and #logged == 0 and loads == 0 and counts.calls == 0, 'three probes in all: ' .. counts.lookups)
  -- With it (a new session): exactly one line, which names the switch and says nothing is read or told.
  convaiModOffNoted, convaiModOffProbedAt, convaiModOffProbes = nil, nil, nil
  install({nutrition = 1})
  systems['DarkFuture.Main.DFMainSystem'] = {}
  reset()
  for i = 1, 10 do options.modsOff() end
  assert(#logged == 1 and counts.calls == 0 and loads == 0, #logged .. ' ' .. counts.calls .. ' ' .. loads)
  assert(logged[1]:find('^df: installed=yes read=skipped stage=%- switch=off asked=%? sent=none%(') and logged[1]:find('nothing is read or told', 1, true), logged[1])
  clock = clock + 500
  options.modsOff()
  assert(#logged == 1, 'once a session')
`));

test('turn context: the note rides the snapshot (plain words only, bounded) and counts as nothing read; the switch-off callback is called only while the switch is off', () => run(`
  local TC = (function() ${read('../mod/turn-context.lua')} end)()
  local native = {player = function() return {} end, ready = function() return true end}
  local note, offCalls, on = 'installed=yes read=ok stage=hydration0,nutrition1,energy0,nerve1', 0, true
  local function snapshotOf(extra)
    local options = {native = native, enabled = function(kind) if kind == 'mods' then return on end return false end, now = function() return 100 end}
    for k, v in pairs(extra) do options[k] = v end
    return TC.new(options):capture()
  end
  local s = snapshotOf({mods = function() return {darkFuture = {nutrition = 1}}, note end})
  assert(s.mods.darkFuture.nutrition == 1 and s.modsRead == note)
  -- Nothing worth sending but the mod is there: no mods table, still the note; and a snapshot with nothing else is no snapshot.
  s = snapshotOf({mods = function() return nil, note end})
  assert(s == nil, 'a note alone is not something read')
  for _, bad in ipairs({'installed=yes; os.execute()', string.rep('a', 200), 12, true, 'Installed=YES'}) do
    s = snapshotOf({mods = function() return {darkFuture = {nutrition = 1}}, bad end})
    assert(s.modsRead == nil, tostring(bad))
  end
  on = false
  s = snapshotOf({mods = function() error('must not be read while off') end, modsOff = function() offCalls = offCalls + 1 end})
  assert(offCalls == 1 and (s == nil or (s.mods == nil and s.modsRead == nil)))
  on = true
  s = snapshotOf({mods = function() return {darkFuture = {energy = 4}}, note end, modsOff = function() offCalls = offCalls + 1 end})
  assert(offCalls == 1, 'not called while the switch is on')
  on = false
  snapshotOf({modsOff = function() error('boom') end})
`));
