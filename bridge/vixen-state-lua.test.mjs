import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// Other mods' state, the game side for the Digital Vixen mods (docs/DYNAMIC_INFO.md, "Other mods' state"): mod/vixen-state.lua reads Flesh and Chrome (FleshAndChrome.FACSystem) and
// Injuries (Injuries.InjuriesSystem) through the scriptable systems container, and the `vixen` reader in mod/init.lua loads that module only when one of them is there. Run in
// fengari with STRICT fakes that mirror the real class shapes (their redscript, deliverables/reference/*/extracted): a getter is a method taking `self` first and exactly the
// arguments the game's method has, so a call made with the wrong shape (a dot instead of a colon, a missing or extra argument) raises like the real binding would.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const moduleSource = read('../mod/vixen-state.lua');
const init = read('../mod/init.lua');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}

const world = `
  local counts = {lookups = 0, calls = 0, names = {}}
  local systems = {}
  CName = {new = function(text) return {text = text} end}
  TweakDBID = {new = function(text) return {tdb = text} end}
  Game = {}
  function Game.GetScriptableSystemsContainer()
    return {Get = function(self, name)
      assert(type(self) == 'table' and type(name) == 'table' and name.text, 'container:Get(CName)')
      counts.lookups = counts.lookups + 1
      counts.names[#counts.names + 1] = name.text
      local found = systems[name.text]
      if found == 'raise' then error('unknown class ' .. name.text) end
      return found
    end}
  end
  -- A strict method: needs the object as self and exactly n arguments after it; 'raise' raises.
  local function method(object, name, nargs, value)
    object[name] = function(self, ...)
      assert(self == object, name .. ' must be called with a colon')
      assert(select('#', ...) == nargs, name .. ' takes ' .. nargs .. ' arguments, got ' .. select('#', ...))
      counts.calls = counts.calls + 1
      if value == 'raise' then error('boom in ' .. name) end
      if type(value) == 'function' then return value(...) end
      return value
    end
  end
  local entity = {id = 'V-entity'}
  local effects, hasEffectCalls = {}, 0
  -- The game clock (seconds), the game's own stamina pool, Codeware's reflection (fields only reachable that way).
  local gameStamp, poolValue = 1000000.0, 0.0
  function Game.GetTimeSystem()
    local sys = {}
    method(sys, 'GetGameTimeStamp', 0, function() return gameStamp end)
    return sys
  end
  function Game.GetStatPoolsSystem()
    local sys = {}
    method(sys, 'GetStatPoolValue', 3, function(id, kind, perc)
      assert(id == entity and type(kind) == 'table' and kind.enum == 'gamedataStatPoolType' and kind.value == 'Stamina' and perc == true, 'GetStatPoolValue(id, Stamina, true)')
      return poolValue
    end)
    return sys
  end
  Enum = {new = function(enum, value) return {enum = enum, value = value} end}
  FromVariant = function(v) return v end
  ToVariant = function(v) return v end
  local ps = {}
  local player = {}
  -- GetPS answers the state table; psMode 'nothing' gives nil, 'raise' raises (the first live test could not read the persistent fields).
  local psMode = 'ps'
  method(player, 'GetPS', 0, function() if psMode == 'raise' then error('no GetPS') end if psMode == 'nothing' then return nil end return ps end)
  method(player, 'GetEntityID', 0, entity)
  function Game.GetStatusEffectSystem()
    local sys = {}
    method(sys, 'HasStatusEffect', 2, function(id, tdb)
      assert(id == entity and type(tdb) == 'table' and tdb.tdb, 'HasStatusEffect(EntityID, TweakDBID)')
      hasEffectCalls = hasEffectCalls + 1
      return effects[tdb.tdb] == true
    end)
    return sys
  end
  -- Flesh and Chrome (FleshAndChrome.reds): IsEnabled(), GetStaminaPercent(player), GetEnergyPercent(player); the persistent fields on PlayerPuppetPS.
  local function installFac(o)
    o = o or {}
    local fac = {}
    local function pick(k, d) if o[k] ~= nil then return o[k] end return d end
    method(fac, 'IsEnabled', 0, pick('enabled', true))
    method(fac, 'GetStaminaPercent', 1, function(p) assert(p == player, 'the player is passed'); return pick('stamina', 1.0) end)
    method(fac, 'GetEnergyPercent', 1, function(p) assert(p == player, 'the player is passed'); return pick('energy', 1.0) end)
    method(fac, 'GetTotalAlcohol', 1, function(p) assert(p == player, 'the player is passed'); return pick('alcoholTotal', 0) end)
    method(fac, 'GetTotalCigarettes', 1, function(p) assert(p == player, 'the player is passed'); return pick('cigaretteTotal', 0) end)
    method(fac, 'IsStaminaRegenning', 0, pick('regenning', false))
    method(fac, 'GetConfig', 0, pick('config', {alcoholSoberBaseHours = 6, alcoholSoberHoursPerExtraDrink = 1, smokingPenaltyDurationMinutes = 30}))
    systems['FleshAndChrome.FACSystem'] = fac
    for k in pairs(ps) do ps[k] = nil end
    if o.fields ~= false then
      ps.m_facInitialized = pick('initialized', true)
      ps.m_facLastTimestamp = pick('now', 100000.0)
      ps.m_facAlcoholDrinks = pick('drinks', 0)
      ps.m_facAlcoholSoberEnd = pick('soberEnd', 0.0)
      ps.m_facSmokingPenaltyEnd = pick('smokeEnd', 0.0)
      ps.m_facRegenCooldownEnd = pick('cooldownEnd', 0.0)
      ps.m_facStamina = pick('poolStamina', 5000.0)
      ps.m_facEnergy = pick('poolEnergy', 5000.0)
    end
    return fac
  end
  -- Injuries (Injuries_System.reds): IsLive(), GetAppliedTier(kind: Int32), GetSeverity(region: Int32).
  local function installInjuries(o)
    o = o or {}
    local inj = {}
    method(inj, 'IsLive', 0, o.live ~= false)
    method(inj, 'GetAppliedTier', 1, function(kind) assert(math.type == nil or true); return (o.applied or {})[kind] or 0 end)
    method(inj, 'GetSeverity', 1, function(region) return (o.severity or {})[region] or 0 end)
    systems['Injuries.InjuriesSystem'] = inj
    return inj
  end
  local function reset() counts.lookups, counts.calls, counts.names = 0, 0, {} end
  local function keys(t) local out = {} for k in pairs(t or {}) do out[#out + 1] = k end table.sort(out) return table.concat(out, ',') end
`;
const withModule = code => run(`${world}
  local M = (function() ${moduleSource} end)()
  local lines = {}
  local function log(line) lines[#lines + 1] = line end
${code}`);

test('Flesh and Chrome: stamina, energy, drink and a cigarette become small stages; a fresh V says nothing', () => withModule(`
  installFac()
  local out, notes = M.read(player, log)
  assert(out == nil, 'a rested, sober V is nil')
  assert(notes.fac == 'installed=yes read=ok state=breath0,energy0,drinks0,smoke0', notes.fac)
  assert(notes.inj == nil, 'Injuries is not installed: no note')
  installFac({stamina = 0.15, energy = 0.30, drinks = 2, soberEnd = 100000 + 3600, smokeEnd = 100000 + 600})
  out, notes = M.read(player, log)
  local f = out.fleshAndChrome
  assert(f.breath == 1 and f.energy == 1 and f.drinks == 1 and f.smoke == 1, keys(f))
  assert(notes.fac == 'installed=yes read=ok state=breath1,energy1,drinks1,smoke1', notes.fac)
  installFac({stamina = 0.08, energy = 0.09, drinks = 4, soberEnd = 100000 + 3600})
  f = M.read(player, log).fleshAndChrome
  assert(f.breath == 2 and f.energy == 3 and f.drinks == 2 and f.smoke == nil, 'stamina below 10 percent, energy below 20 and 10, four drinks')
  installFac({stamina = 0.03, energy = 0.02, drinks = 7, soberEnd = 100000 + 3600})
  f = M.read(player, log).fleshAndChrome
  assert(f.breath == 3 and f.energy == 4 and f.drinks == 3, 'gasping, exhausted energy, a lot to drink')
`));

test('Flesh and Chrome: exhausted is stamina 0, or the status of the mod still on while it recovers (one extra call, only down there)', () => withModule(`
  installFac({stamina = 0.0})
  reset(); hasEffectCalls = 0
  assert(M.read(player, log).fleshAndChrome.breath == 4)
  assert(hasEffectCalls == 0, 'no status check needed at zero')
  installFac({stamina = 0.03}); effects['FACStatusEffect.Exhausted'] = true
  assert(M.read(player, log).fleshAndChrome.breath == 4, 'still exhausted until it clears above 5 percent')
  effects['FACStatusEffect.Exhausted'] = false
  assert(M.read(player, log).fleshAndChrome.breath == 3)
  hasEffectCalls = 0
  installFac({stamina = 0.5}); M.read(player, log)
  assert(hasEffectCalls == 0, 'a rested V never asks the status system')
  installFac({stamina = 0.03})
  Game.GetStatusEffectSystem = function() error('no status system') end
  assert(M.read(player, log).fleshAndChrome.breath == 3, 'a missing status system is not an error')
`));

test('Flesh and Chrome: switched off in its own settings, or not initialised, says nothing', () => withModule(`
  installFac({enabled = false, stamina = 0.0})
  local out, notes = M.read(player, log)
  assert(out == nil and notes.fac == 'installed=yes read=off state=-', notes.fac)
  installFac({initialized = false, stamina = 0.04, drinks = 5, soberEnd = 200000})
  out = M.read(player, log)
  assert(keys(out.fleshAndChrome) == 'breath', 'the drink and smoke fields are not trusted before the mod initialised: ' .. keys(out.fleshAndChrome))
`));

test('Flesh and Chrome: a sober-up window that is over, or a clock that does not match, is not a drink', () => withModule(`
  installFac({drinks = 5, soberEnd = 99000})
  assert(M.read(player, log) == nil, 'the window ended before now')
  installFac({drinks = 5, soberEnd = 100000 + 10 * 86400})
  assert(M.read(player, log) == nil, 'a window days long cannot be this mod\\'s clock')
  installFac({drinks = 500, soberEnd = 100000 + 3600})
  assert(M.read(player, log) == nil, 'a drink count out of range is unknown')
  installFac({now = 0, drinks = 5, soberEnd = 3600})
  assert(M.read(player, log) == nil, 'the mod\\'s clock has not ticked: unknown')
  installFac({smokeEnd = 100000 - 5})
  assert(M.read(player, log) == nil, 'a cigarette long ago')
`));

test('Flesh and Chrome: out-of-range answers are unknown, never a guess; a getter that raises drops only itself', () => withModule(`
  for _, bad in ipairs({-0.5, 4, 'x', true}) do
    installFac({stamina = bad, energy = 0.09})
    local f = M.read(player, log).fleshAndChrome
    assert(f.breath == nil and f.energy == 3, tostring(bad))
  end
  local fac = installFac({energy = 0.09})
  method(fac, 'GetStaminaPercent', 1, 'raise')
  local out = M.read(player, log)
  assert(keys(out.fleshAndChrome) == 'energy', 'the energy still answers')
  method(fac, 'GetEnergyPercent', 1, 'raise')
  out, notes = M.read(player, log)
  assert(out == nil)
  local failures = 0
  for _, line in ipairs(lines) do if line:find('failed', 1, true) then failures = failures + 1 end end
  assert(failures == 2, 'each failing getter is logged once: ' .. failures)
`));

test('Injuries: the tier in effect per kind, and a treated injury (held back by a healing item) is told from none', () => withModule(`
  installInjuries()
  local out, notes = M.read(player, log)
  assert(out == nil and notes.inj == 'installed=yes read=ok state=limp0,arm0,head0,bleed0,treated0', notes.inj)
  installInjuries({applied = {[0] = 1, [3] = 2}})
  out, notes = M.read(player, log)
  assert(keys(out.injuries) == 'bleed,limp' and out.injuries.limp == 1 and out.injuries.bleed == 2, keys(out.injuries))
  assert(notes.inj == 'installed=yes read=ok state=limp1,arm0,head0,bleed2,treated0', notes.inj)
  -- A painkiller or a medkit: the injury is there (severity) but nothing is in effect.
  installInjuries({applied = {}, severity = {[2] = 3}})
  out, notes = M.read(player, log)
  assert(keys(out.injuries) == 'treated' and out.injuries.treated == 1, keys(out.injuries))
  assert(notes.inj:find('treated1', 1, true))
  -- A leg wound (region 5) with the limp in effect is not "treated".
  installInjuries({applied = {[0] = 2}, severity = {[5] = 2}})
  out = M.read(player, log)
  assert(keys(out.injuries) == 'limp', keys(out.injuries))
`));

test('Injuries: not live (no session, dead) and out-of-range tiers are unknown', () => withModule(`
  installInjuries({live = false, applied = {[3] = 3}})
  local out, notes = M.read(player, log)
  assert(out == nil and notes.inj == 'installed=yes read=idle state=-', notes.inj)
  installInjuries({applied = {[3] = 9, [1] = 2}})
  out = M.read(player, log)
  assert(keys(out.injuries) == 'arm', 'a tier of 9 is dropped: ' .. keys(out.injuries))
  local inj = installInjuries({applied = {[1] = 3}})
  method(inj, 'GetAppliedTier', 1, 'raise')
  out, notes = M.read(player, log)
  assert(out == nil and notes.inj == 'installed=yes read=none state=limp?,arm?,head?,bleed?,treated?', notes.inj)
`));

test('both mods read in one pass; one missing or broken never disables the other', () => withModule(`
  installFac({stamina = 0.04}); installInjuries({applied = {[3] = 1}})
  reset()
  local out, notes = M.read(player, log)
  assert(out.fleshAndChrome.breath == 3 and out.injuries.bleed == 1)
  assert(counts.lookups == 2, 'one lookup each: ' .. counts.lookups)
  assert(notes.fac and notes.inj)
  systems['FleshAndChrome.FACSystem'] = 'raise'
  out, notes = M.read(player, log)
  assert(keys(out) == 'injuries' and notes.fac == nil and notes.inj, 'Flesh and Chrome lookup raised')
  systems['Injuries.InjuriesSystem'] = nil
  assert(M.read(player, log) == nil)
  systems = {}
  local o, n = M.read(player, log)
  assert(o == nil and next(n) == nil, 'neither installed: nothing, no notes')
  Game = nil
  assert(M.read(player, log) == nil, 'no Game')
  assert(M.read(nil, log) == nil, 'no player')
`));

test('log: one line per distinct reading per mod, none for an unchanged one', () => withModule(`
  installFac({stamina = 0.04}); installInjuries({applied = {[0] = 2}})
  M.read(player, log); M.read(player, log); M.read(player, log)
  local stages = {}
  for _, line in ipairs(lines) do if line:find('^Mod state: ') then stages[#stages + 1] = line end end
  assert(#stages == 2, #stages)
  assert(stages[1] == 'Mod state: flesh-and-chrome breath=3 energy=0 drinks=0 smoke=0', stages[1])
  assert(stages[2] == 'Mod state: injuries limp=2 arm=0 head=0 bleed=0 treated=0', stages[2])
  installInjuries({applied = {[0] = 3}})
  M.read(player, log)
  stages = {}
  for _, line in ipairs(lines) do if line:find('^Mod state: ') then stages[#stages + 1] = line end end
  assert(#stages == 3 and stages[3]:find('limp=3', 1, true), stages[3])
  for _, line in ipairs(lines) do assert(#line < 260, line) end
`));

test('the result carries plain numbers and strings only, never a game object', () => withModule(`
  installFac({stamina = 0.04, drinks = 3, soberEnd = 200000}); installInjuries({applied = {[3] = 2}})
  local out, notes = M.read(player, log)
  local function plain(value)
    if type(value) == 'table' then for k, v in pairs(value) do assert(type(k) == 'string'); plain(v) end
    else assert(type(value) == 'number' or type(value) == 'string' or type(value) == 'boolean', type(value)) end
  end
  plain(out); plain(notes)
  for _, note in pairs(notes) do assert(note:match('^[a-z0-9=,?%- ]+$'), note) end
  assert(M.read(player) ~= nil, 'no logger is fine')
`));

test('the module is passive: no registered event, no timer, no observer, no write, no setter, no per-frame code', () => {
  const code = moduleSource.split('\n').filter(line => !line.trim().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /registerForEvent|registerHotkey|Observe\(|Override\(|ObserveAfter|onUpdate|DelayCallback|Cron|io\.|os\.execute|os\.remove|dofile|require/);
  assert.doesNotMatch(code, /:Set[A-Z]\w*\(|:Mod[A-Z]\w*\(|:Change\w*\(|:Apply\w*\(|:Cure\w*\(|:Add\w*\(|:Remove\w*\(|:Queue\w*\(|:Send\w*\(|:Register\w*\(|:Escalate\(|:Clear\w*\(/);
  // Only the documented getters are named, as strings handed to `ask`.
  const getters = new Set(code.match(/'(?:Get|Is)[A-Za-z]+'/g));
  assert.deepEqual([...getters].sort(), ["'GetAppliedTier'", "'GetConfig'", "'GetEnergyPercent'", "'GetSeverity'", "'GetStaminaPercent'", "'GetTotalAlcohol'", "'GetTotalCigarettes'", "'IsEnabled'", "'IsLive'", "'IsStaminaRegenning'"]);
  assert.deepEqual([...new Set(code.match(/Game\.[A-Za-z]+/g))].sort(), ['Game.GetScriptableSystemsContainer', 'Game.GetStatPoolsSystem', 'Game.GetStatusEffectSystem', 'Game.GetTimeSystem']);
  // The fields read from the player's state, nothing else.
  assert.deepEqual([...new Set(code.match(/'m_[A-Za-z]+'/g))].sort(), ["'m_facAlcoholDrinks'", "'m_facAlcoholSoberEnd'", "'m_facEnergy'", "'m_facInitialized'", "'m_facLastTimestamp'", "'m_facRegenCooldownEnd'", "'m_facSmokingPenaltyEnd'", "'m_facStamina'"]);
});

// ---------------------------------------------------------------------------------------------------------------------
// The first live test (2026-10-27): drinks and cigarettes read `?`, breath stayed at the top stage, injuries read zeros. The probes and the fallbacks.

test('drinks and cigarettes without the persistent fields: the mod\'s lifetime counts are watched from read to read', () => withModule(`
  os.time = function() return 5000 end
  installFac({fields = false, alcoholTotal = 4, cigaretteTotal = 2})
  local out, notes = M.read(player, log)
  assert(out == nil and notes.fac == 'installed=yes read=ok state=breath0,energy0,drinks0,smoke0', 'the first read is the baseline: nothing is known to be new: ' .. notes.fac)
  -- A drink: the count rose; the window is six hours from this read.
  installFac({fields = false, alcoholTotal = 5, cigaretteTotal = 2})
  out, notes = M.read(player, log)
  assert(out.fleshAndChrome.drinks == 1 and notes.fac:find('drinks1', 1, true), notes.fac)
  gameStamp = gameStamp + 3 * 3600
  out = M.read(player, log)
  assert(out.fleshAndChrome.drinks == 1, 'still inside the window')
  -- Two more while it is live: three in all (stage 2), the window one hour longer each.
  installFac({fields = false, alcoholTotal = 7, cigaretteTotal = 2})
  out = M.read(player, log)
  assert(out.fleshAndChrome.drinks == 2, 'three drinks in the window')
  gameStamp = gameStamp + 4 * 3600
  out = M.read(player, log)
  assert(out.fleshAndChrome.drinks == 2, 'the window runs 6h + 2h from the first drink: 7 hours in is still inside')
  gameStamp = gameStamp + 2 * 3600
  assert(M.read(player, log) == nil, 'sober again')
  -- A cigarette: thirty game minutes.
  installFac({fields = false, alcoholTotal = 7, cigaretteTotal = 3})
  out = M.read(player, log)
  assert(out.fleshAndChrome.smoke == 1 and keys(out.fleshAndChrome) == 'smoke', keys(out.fleshAndChrome))
  gameStamp = gameStamp + 29 * 60
  assert(M.read(player, log).fleshAndChrome.smoke == 1)
  gameStamp = gameStamp + 2 * 60
  assert(M.read(player, log) == nil, 'the cigarette is over')
  local probes = {}
  for _, line in ipairs(lines) do if line:find('drinks and cigarettes via=', 1, true) then probes[#probes + 1] = line end end
  assert(#probes >= 2 and probes[1]:find('via=counts', 1, true) and probes[1]:find('alcohol=4 cigarettes=2', 1, true), probes[1])
  assert(probes[2]:find('alcohol=5 cigarettes=2', 1, true) and probes[2]:find('drinks=1', 1, true), probes[2])
  local first = lines[1]
  assert(first:find('^Mod state probe: PlayerPuppetPS fields init=nil%(none%)'), first)
`));

test('drinks: a rise by several at once, a config that cannot be read, no game clock, a count that raises', () => withModule(`
  installFac({fields = false, alcoholTotal = 0, config = false})
  M.read(player, log)
  installFac({fields = false, alcoholTotal = 6, config = false})
  assert(M.read(player, log).fleshAndChrome.drinks == 3, 'six drinks at once: stage 3, with the mod\\'s default window')
  M.reset()
  Game.GetTimeSystem = function() error('no time system') end
  installFac({fields = false, alcoholTotal = 1})
  local out, notes = M.read(player, log)
  assert(out == nil and notes.fac:find('drinks?', 1, true) and notes.fac:find('smoke?', 1, true), 'no clock: unknown, not zero: ' .. notes.fac)
  M.reset()
  local fac = installFac({fields = false})
  method(fac, 'GetTotalAlcohol', 1, 'raise')
  method(fac, 'GetTotalCigarettes', 1, 'raise')
  out, notes = M.read(player, log)
  assert(out == nil, 'the counts raising is not an error')
`));

test('drinks and cigarettes: GetPS gone, or fields only reachable through reflection, are told apart in the probe line', () => withModule(`
  psMode = 'raise'
  installFac({stamina = 0.5})
  M.read(player, log)
  assert(lines[1]:find('^Mod state probe: player:GetPS%(%) failed %(.-no GetPS'), lines[1])
  psMode = 'nothing'; M.reset(); lines = {}
  M.read(player, log)
  assert(lines[1]:find('gave nothing', 1, true), lines[1])
  -- The fields exist only through Codeware's reflection.
  psMode = 'ps'; M.reset(); lines = {}
  installFac({fields = false})
  local hidden = {m_facInitialized = true, m_facLastTimestamp = 100000.0, m_facAlcoholDrinks = 3, m_facAlcoholSoberEnd = 103600.0, m_facSmokingPenaltyEnd = 0.0}
  Reflection = {GetClass = function(name)
    assert(name.text == 'PlayerPuppetPS', 'the class of the fields')
    return {GetProperty = function(self, prop) return {GetValue = function(self2, object) return hidden[prop.text] end} end}
  end}
  local out = M.read(player, log)
  assert(out.fleshAndChrome.drinks == 2, 'three drinks, read through reflection')
  assert(lines[1]:find('init=true%(reflection%)') and lines[1]:find('drinks=3%(reflection%)'), lines[1])
`));

test('breath probe: one line at the first read, at every change of stage and every two minutes while the stage is 3 or 4, with the raw numbers', () => withModule(`
  local clock = 10000
  os.time = function() return clock end
  installFac({stamina = 0.0, energy = 0.62, regenning = false, now = 100000.0, cooldownEnd = 100400.0})
  poolValue = 0.0
  local function probes()
    local found = {}
    for _, line in ipairs(lines) do if line:find('^Mod state probe: breath ') then found[#found + 1] = line end end
    return found
  end
  M.read(player, log)
  assert(#probes() == 1)
  assert(probes()[1] == 'Mod state probe: breath stage=4 stamina=0 energy=0.62 exhaustedStatus=nil regenning=false gamePool=0 cooldownLeft=400 clock=?', probes()[1])
  clock = clock + 30; gameStamp = gameStamp + 240
  M.read(player, log)
  assert(#probes() == 1, 'the same stage a few seconds later: no new line')
  clock = clock + 100; gameStamp = gameStamp + 800
  M.read(player, log)
  local lastLine = probes()[#probes()]
  assert(#probes() == 2 and lastLine:find('clock=8.0x', 1, true), 'two minutes at stage 4: the line again, with the pace of the game clock: ' .. lastLine)
  installFac({stamina = 0.5})
  M.read(player, log)
  assert(#probes() == 3 and probes()[3]:find('stage=0', 1, true), 'a change of stage')
  clock = clock + 1000
  M.read(player, log)
  assert(#probes() == 3, 'a rested V is not probed again')
  installFac({stamina = 0.03}); effects['FACStatusEffect.Exhausted'] = true
  M.read(player, log)
  assert(probes()[4]:find('exhaustedStatus=true', 1, true), probes()[4])
`));

test('breath probe: a status system, pool or regenning getter that is missing is a question mark, not an error', () => withModule(`
  local fac = installFac({stamina = 0.0})
  method(fac, 'IsStaminaRegenning', 0, 'raise')
  Game.GetStatPoolsSystem = function() error('no pools') end
  local out = M.read(player, log)
  assert(out.fleshAndChrome.breath == 4)
  local found
  for _, line in ipairs(lines) do if line:find('^Mod state probe: breath ') then found = line end end
  assert(found:find('regenning=? gamePool=?', 1, true), found)
`));

test('Injuries: an Injuries status effect in force is believed over a system that answers zeros, asked at most once a minute', () => withModule(`
  local clock = 1000
  os.time = function() return clock end
  installInjuries({applied = {}})
  effects['Injuries.Limp_T2'] = true
  hasEffectCalls = 0
  local out, notes = M.read(player, log)
  assert(out.injuries.limp == 2 and hasEffectCalls == 12, 'twelve questions, limp tier 2: ' .. hasEffectCalls)
  assert(notes.inj == 'installed=yes read=ok state=limp2,arm0,head0,bleed0,treated0', notes.inj)
  local said = 0
  for _, line in ipairs(lines) do if line:find('status effect Injuries.Limp_T2 is in force', 1, true) then said = said + 1 end end
  assert(said == 1)
  hasEffectCalls = 0
  clock = clock + 10
  out = M.read(player, log)
  assert(hasEffectCalls == 0 and out == nil, 'not asked again inside the minute')
  clock = clock + 60
  effects['Injuries.Limp_T2'] = false
  out = M.read(player, log)
  assert(hasEffectCalls == 12 and out == nil, 'asked again after a minute, and nothing is in force now')
  -- Not asked when the system itself shows an injury, or a treated one.
  installInjuries({applied = {[3] = 1}})
  hasEffectCalls = 0; clock = clock + 100
  M.read(player, log)
  assert(hasEffectCalls == 0)
  Game.GetStatusEffectSystem = function() error('no status system') end
  installInjuries({applied = {}}); clock = clock + 100
  assert(M.read(player, log) == nil, 'a missing status system is no error')
`));

test('Injuries: the probe line carries the raw tiers and every region\'s severity; it is written again only when they change', () => withModule(`
  os.time = function() return 1000 end
  installInjuries({applied = {[0] = 1}, severity = {[4] = 1, [1] = 2}})
  M.read(player, log); M.read(player, log)
  local found = {}
  for _, line in ipairs(lines) do if line:find('^Mod state probe: injuries ') then found[#found + 1] = line end end
  assert(#found == 1 and found[1] == 'Mod state probe: injuries live=true applied=1,0,0,0 severity=0,2,0,0,1,0 effects=unchecked', found[1])
  installInjuries({applied = {[0] = 2}, severity = {[4] = 2}})
  M.read(player, log)
  found = {}
  for _, line in ipairs(lines) do if line:find('^Mod state probe: injuries ') then found[#found + 1] = line end end
  assert(#found == 2 and found[2]:find('applied=2,0,0,0 severity=0,0,0,0,2,0', 1, true), found[2])
  installInjuries({live = false})
  M.read(player, log)
  local idle
  for _, line in ipairs(lines) do if line:find('^Mod state probe: injuries live=false') then idle = line end end
  assert(idle and idle:find('idle', 1, true), idle)
`));

test('a rested, sober V asks no status effect', () => withModule(`
  installFac({stamina = 0.9})
  hasEffectCalls = 0
  M.read(player, log)
  assert(hasEffectCalls == 0)
`));

// ---------------------------------------------------------------------------------------------------------------------
// The loader in init.lua: the module only when one of the mods is there; and the switch-off notes.

const between = (from, to) => {
  const start = init.indexOf(from), end = init.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return init.slice(start, end);
};
const presence = between('convaiVixenPresent = function()', 'convaiEquipmentExPresent = function()');
const equipmentExPresence = between('convaiEquipmentExPresent = function()', '-- Music and TV, the song');
const loader = between('vixen = function(player)', "-- Read the game's dialogue volume");

function withLoader(code) {
  run(`${world}
  local realModule = (function() ${moduleSource} end)()
  local clock, loads, brokenLoad = 1000, 0, false
  os.time = function() return clock end
  function dofile(path)
    assert(path == 'vixen-state.lua', path)
    loads = loads + 1
    if brokenLoad then error('missing file') end
    return realModule
  end
  local logged = {}
  convaiLogLine = function(line) logged[#logged + 1] = line end
  ${presence}
  ${equipmentExPresence}
  local options = {
    ${loader}
  }
${code}`);
}

test('loader: neither mod installed: the module is never read from disk, and the probe is two lookups at most once a minute', () => withLoader(`
  for i = 1, 40 do assert(options.vixen(player) == nil) end
  assert(loads == 0 and convaiVixenState == nil)
  assert(counts.lookups == 2, counts.lookups)
  clock = clock + 59
  assert(options.vixen(player) == nil and counts.lookups == 2)
  clock = clock + 2
  assert(options.vixen(player) == nil and counts.lookups == 4 and loads == 0)
  assert(#logged == 0 and counts.calls == 0)
`));

test('loader: a mod present from the start: loaded once, read every turn window, the probe is not repeated', () => withLoader(`
  installFac({stamina = 0.04})
  local out, notes = options.vixen(player)
  assert(loads == 1 and out.fleshAndChrome.breath == 3 and notes.fac)
  assert(logged[1] == 'Mod state: Flesh and Chrome found, reader loaded', logged[1])
  reset()
  out = options.vixen(player)
  assert(loads == 1 and counts.lookups == 2 and out.fleshAndChrome.breath == 3, 'two lookups (one per mod), no probe, no second load: ' .. counts.lookups)
`));

test('loader: Injuries alone is enough; a mod that appears later is found after a minute; a failed load is not retried', () => withLoader(`
  assert(options.vixen(player) == nil)
  installInjuries({applied = {[3] = 3}})
  clock = clock + 10
  assert(options.vixen(player) == nil and loads == 0, 'inside the minute it is not looked for')
  clock = clock + 60
  local out = options.vixen(player)
  assert(loads == 1 and out.injuries.bleed == 3)
  assert(logged[1] == 'Mod state: Injuries found, reader loaded', logged[1])
`));

test('loader: a module that fails to load is not retried', () => withLoader(`
  brokenLoad = true
  installInjuries()
  assert(options.vixen(player) == nil)
  assert(logged[1]:find('failed to load', 1, true))
  brokenLoad = false
  clock = clock + 500
  assert(options.vixen(player) == nil and loads == 1, 'not retried')
`));

test('loader: switch off: one probe line per installed mod, once, and nothing is read or loaded', () => withLoader(`
  installFac(); installInjuries()
  options.vixenOff(); options.vixenOff(); clock = clock + 100; options.vixenOff()
  assert(loads == 0 and counts.calls == 0)
  assert(#logged == 2, #logged)
  table.sort(logged)
  assert(logged[1]:find('^fac: installed=yes read=skipped state=%- switch=off asked=%? sent=none%(Other mods\\' state is off'), logged[1])
  assert(logged[2]:find('^inj: installed=yes read=skipped state=%- switch=off'), logged[2])
`));

test('loader: switch off and neither installed: three probes in a session, then none; no log line', () => withLoader(`
  for i = 1, 10 do options.vixenOff(); clock = clock + 61 end
  assert(counts.lookups == 6 and #logged == 0, counts.lookups)
`));

test('Equipment-EX presence (for the nudity note) is one lookup a minute', () => withLoader(`
  assert(convaiEquipmentExPresent() == false)
  for i = 1, 5 do convaiEquipmentExPresent() end
  assert(counts.lookups == 1)
  systems['EquipmentEx.OutfitSystem'] = {}
  clock = clock + 61
  assert(convaiEquipmentExPresent() == true)
`));

test('init.lua: the turn context merges the Digital Vixen result into the mods table and the reply notes are logged', () => {
  const turnContext = read('../mod/turn-context.lua');
  assert.match(turnContext, /call\(self\.options\.vixen, player\)/);
  assert.match(turnContext, /\{fac = 'facRead', inj = 'injRead'\}/);
  assert.match(turnContext, /call\(self\.options\.vixenOff\)/);
  assert.match(init, /for _, key in ipairs\(\{'fac', 'inj'\}\) do/);
});
