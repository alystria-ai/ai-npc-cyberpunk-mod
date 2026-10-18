import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// The combat feats cost study (mod/combat-feats-probe.lua, docs/JOHNNY_IN_YOUR_HEAD.md phase 2): candidate hooks registered late with
// O(1) counters gated on a run, the bounds, the report a reader of a heavy fight gets, and the calibration behind its estimates.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/combat-feats-probe.lua', import.meta.url), 'utf8');
function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
}
// A fake game: a clock moved by hand (and by each native round trip: 20 us), observers kept by name, the counters in plain tables.
const fixture = code => run(`
  local t, now, registrations = 1000, 5000, 0
  os.clock = function() return t end
  os.time = function() return now end
  local after, before = {}, {}
  ObserveAfter = function(class, method, fn) registrations = registrations + 1; after[class .. '.' .. method] = fn end
  ObserveBefore = function(class, method, fn) registrations = registrations + 1; before[class .. '.' .. method] = fn end
  Enum = {new = function(_, value) return value end}
  CName = {new = function(value) return value end}
  TDBID = {ToStringDEBUG = function(id) return id end}
  local facts = {gmpl_npcs_killed_by_player = 10, gmpl_npcs_defeated_by_player = 2, gmpl_player_range_attacks = 400}
  local system = {m_downedWithRanged = 5, m_downedWithMelee = 1, m_downedInTimeDilatation = 0}
  local skills = {CoolSkill = {level = 20, exp = 100}, IntelligenceSkill = {level = 9, exp = 900}}
  local dilation, combat = {}, true
  local player = {IsInCombat = function() return combat end, IsPlayer = function() return true end}
  Game = {
    GetPlayer = function() t = t + 0.00002; return player end,
    GetQuestsSystem = function() return {GetFactStr = function(_, name) return facts[name] or 0 end} end,
    GetScriptableSystemsContainer = function() return {Get = function(_, name) assert(name == 'DataTrackingSystem'); return system end} end,
    GetTimeSystem = function() return {IsTimeDilationActive = function(_, reason) return dilation[reason] == true end} end,
  }
  PlayerDevelopmentSystem = {GetData = function() return {
    GetProficiencyLevel = function(_, kind) return skills[kind] and skills[kind].level or 1 end,
    GetCurrentLevelProficiencyExp = function(_, kind) return skills[kind] and skills[kind].exp or 0 end} end}
  local env = {player = player}
  local npc = {IsPlayer = function() return false end}
  local function attack(byV, headshot)
    return {GetInstigator = function() return {IsPlayer = function() return byV end} end,
      HasFlag = function(_, flag) return headshot and flag == 'Headshot' end, GetAttackType = function() return 'Ranged' end}
  end
  local function effect(id) return {staticData = {GetID = function() return id end}} end
  -- Every value plain (no functions, no native stand-ins) and every table JSON-shaped: string keys, or a 1..n list.
  local function plain(value, path)
    path = path or 'report'
    if type(value) ~= 'table' then
      assert(type(value) == 'string' or type(value) == 'number' or type(value) == 'boolean', path .. ' is ' .. type(value)); return
    end
    local strings, count = 0, 0
    for key, item in pairs(value) do
      count = count + 1
      if type(key) == 'string' then strings = strings + 1 else assert(math.type(key) == 'integer', path .. ' key') end
      plain(item, path .. '.' .. tostring(key))
    end
    assert(strings == 0 or strings == count, path .. ' mixes list and map keys')
    if strings == 0 then assert(#value == count, path .. ' is a sparse list') end
  end
  local m = (function() ${source} end)()
${code}`);

test('nothing registers at load; start registers each hook once; callbacks count only while a run is active and never return a value', () => fixture(`
  assert(registrations == 0 and next(after) == nil, 'loading the file registers nothing')
  local report = m.start(env, 60)
  assert(report.active and report.hooks['NPCPuppet.OnHit'].registration == 'registered')
  for _, spec in ipairs(m.HOOKS) do assert(after[spec[1] .. '.' .. spec[2]], spec[1] .. '.' .. spec[2] .. ' not registered') end
  assert(before['PlayerPuppet.OnDeath'] and before['PlayerPuppet.OnDetach'], 'the lifecycle hooks')
  local count = registrations
  m.stop(env); m.start(env, 60)
  assert(registrations == count, 'a second start reuses the hooks')
  local hit = after['NPCPuppet.OnHit']
  assert(hit(npc, {}) == nil and hit(npc, {}) == nil and hit(npc, {}) == nil, 'an observer leaves the game call alone')
  assert(m.hooks['NPCPuppet.OnHit'].calls == 3)
  m.stop(env)
  hit(npc, {}); hit(npc, {})
  assert(m.hooks['NPCPuppet.OnHit'].calls == 3, 'stopped: the callback is one flag check')
  assert(m.status(env).hooks['NPCPuppet.OnHit'].calls == 3)
  m.start(env, 60)
  assert(m.hooks['NPCPuppet.OnHit'].calls == 0, 'a new run starts from zero')
`));

test('a hook that cannot register is reported and does not stop the others', () => fixture(`
  local original = ObserveAfter
  ObserveAfter = function(class, method, fn)
    if class == 'QuickhacksListGameController' then error('class not found') end
    return original(class, method, fn)
  end
  local report = m.start(env, 60)
  local row = report.hooks['QuickhacksListGameController.ApplyQuickHack']
  assert(row.registration == 'registration-unavailable' and row.verdict == 'registration-unavailable' and row.error:find('class not found'))
  assert(report.hooks['DataTrackingSystem.OnNPCKillDataTrackingRequest'].registration == 'registered' and report.active)
  ObserveAfter = original
  m.stop(env); m.start(env, 60)
  assert(m.hooks['QuickhacksListGameController.ApplyQuickHack'].registered, 'retried on the next start')
`));

test('bounds: the run length, expiry from inside a callback, V dying or detaching, windows and labels', () => fixture(`
  assert(m.start(env, 9999).expiresAt == now + 300, 'at most 300 s')
  assert(m.run('start:1', env).expiresAt == now + 10, 'at least 10 s')
  assert(m.run('start', env).expiresAt == now + 300, 'default: the longest run')
  -- Expiry: a callback past the end stops counting; the next tick reads the counters and ends the run.
  m.start(env, 20)
  local kill = after['DataTrackingSystem.OnNPCKillDataTrackingRequest']
  t = t + 21
  kill({}, {damageEntry = {hitEvent = {attackData = attack(true, false)}}, eventType = 'EDownedType : Killed (0)'})
  assert(m.hooks['DataTrackingSystem.OnNPCKillDataTrackingRequest'].calls == 0 and not m.active)
  assert(m.tick(env) == false)
  local report = m.status(env)
  assert(report.stopReason == 'expired' and report.counters.stop ~= nil)
  -- V dies: the stop waits for the tick and still reads the counters. V detaches (a load): nothing is read.
  m.start(env, 60); before['PlayerPuppet.OnDeath']()
  assert(not m.active and m.tick(env) == false and m.status(env).stopReason == 'player-died' and m.status(env).counters.stop)
  m.start(env, 60); before['PlayerPuppet.OnDetach']()
  report = m.status(env)
  assert(report.stopReason == 'player-detached' and report.counters.stop == nil and report.counters.diff == nil)
  -- Windows: at most MAX_WINDOWS kept (the peak still counts the rest).
  m.MAX_WINDOWS = 3
  m.start(env, 300)
  local hit = after['NPCPuppet.OnHit']
  for window = 1, 5 do
    for _ = 1, window * 10 do hit(npc, {}) end
    t = t + 10; assert(m.tick(env))
  end
  report = m.status(env)
  assert(#report.windows == 3 and report.windowsDropped == 2 and report.windows[1].calls['NPCPuppet.OnHit'] == 10)
  assert(report.hooks['NPCPuppet.OnHit'].peakCallsPerSecond == 5, 'the peak comes from the fifth window: 50 in 10 s')
  -- Labels: the first SAMPLE_LIMIT calls only, at most MAX_LABELS distinct.
  local applied = after['NPCPuppet.OnStatusEffectApplied']
  for index = 1, 100 do applied(npc, effect('BaseStatusEffect.Effect' .. index)) end
  local row = m.status(env).hooks['NPCPuppet.OnStatusEffectApplied']
  local distinct, total = 0, 0
  for _, count in pairs(row.labels) do distinct = distinct + 1; total = total + count end
  assert(row.calls == 100 and row.sampledCalls == 64 and total == 64 and distinct == 17 and row.labels.other == 48)
`));

test('report: plain and JSON-shaped, what fired each hook, the counters before and after and their difference, the time dilation samples', () => fixture(`
  m.start(env, 120)
  local kill = after['DataTrackingSystem.OnNPCKillDataTrackingRequest']
  kill({}, {damageEntry = {hitEvent = {attackData = attack(true, true)}}, eventType = 'EDownedType : Killed (0)'})
  kill({}, {damageEntry = {hitEvent = {attackData = attack(false, false)}}, eventType = 'EDownedType : Defeated (2)'})
  after['PlayerPuppet.OnStatusEffectApplied'](player, effect('BaseStatusEffect.Sandevistan'))
  dilation.sandevistan = true; t = t + 0.5; m.tick(env); t = t + 0.5; m.tick(env)
  dilation.sandevistan = false; t = t + 0.5; m.tick(env)
  dilation.sandevistan = true; t = t + 0.5; m.tick(env)
  facts.gmpl_npcs_killed_by_player, facts.gmpl_player_range_attacks = 13, 460
  system.m_downedWithRanged, system.m_downedInTimeDilatation = 7, 2
  skills.CoolSkill.exp, skills.IntelligenceSkill.level = 160, 10
  local report = m.stop(env)
  plain(report)
  assert(report.probe == 'combat-feats-cost' and report.version == 1 and not report.active and report.stopReason == 'stopped')
  local row = report.hooks['DataTrackingSystem.OnNPCKillDataTrackingRequest']
  assert(row.calls == 2 and row.labels['by-V:headshot:Killed'] == 1 and row.labels['other:Defeated'] == 1, 'the kill carries killer and flags')
  assert(row.kind == 'per-kill' and row.source:find('dataTrackingSystem.script:258') and row.what and row.expectedInHeavyFight)
  assert(report.hooks['PlayerPuppet.OnStatusEffectApplied'].labels['BaseStatusEffect.Sandevistan'] == 1)
  assert(report.hooks['NPCPuppet.OnHit'].verdict == 'not-observed')
  local diff = report.counters.diff
  assert(diff.facts.gmpl_npcs_killed_by_player == 3 and diff.facts.gmpl_player_range_attacks == 60 and diff.facts.gmpl_npcs_defeated_by_player == 0)
  assert(diff.fields.m_downedWithRanged == 2 and diff.fields.m_downedInTimeDilatation == 2 and report.counters.start.fieldRead == 'field')
  assert(diff.skills.Headhunter == 60 and diff.skills.Netrunner == 'level-up')
  assert(report.counters.notes.facts.gmpl_npcs_killed_by_player:find('by anyone'), 'the note says what the fact really counts')
  assert(report.dilation.sandevistan.starts == 2 and report.dilation.sandevistan.samples == 3 and report.dilation.combatSeconds == 2)
  local text = table.concat(report.summary, '\\n')
  assert(text:find('Calibration:') and text:find('Counter gmpl_npcs_killed_by_player: 3') and text:find('Sandevistan 2 starts'))
  assert(text:find('reload CET') and report.howToRead:find('44 ms/s is 1 ms per frame'))
`));

test('counters: a script field CET cannot read falls back to reflection, and an unreadable one says so', () => fixture(`
  local hidden = {}
  setmetatable(system, {__index = function() error('not exposed') end})
  system.m_downedWithRanged, system.m_downedWithMelee, system.m_downedInTimeDilatation = nil, nil, nil
  local values = {m_downedWithRanged = 4}
  Reflection = {GetClass = function() return {GetProperty = function(_, name) return {GetValue = function() return values[name] end} end} end}
  ToVariant = function(value) return value end
  FromVariant = function(value) return value end
  local snapshot = m.counters(player)
  assert(snapshot.fields.m_downedWithRanged == 4 and snapshot.fieldRead == 'reflection')
  assert(snapshot.fields.m_downedWithMelee == 'unavailable')
  Game.GetQuestsSystem = function() error('no quests system') end
  snapshot = m.counters(player)
  assert(snapshot.facts.gmpl_npcs_killed_by_player == 'unavailable')
`));

test('calibration: per-callback Lua time and the boundary round trip from timed batches, and the estimate behind every verdict', () => fixture(`
  -- A clock that moves 1 us on every read: a callback reads it twice, so the batch is (2N + 1) us.
  local step = 0.000001
  os.clock = function() t = t + step; return t end
  local cal = m.calibrate()
  local n, k = m.CALIBRATION.callbacks, m.CALIBRATION.native
  assert(math.abs(cal.callbackUs - 1e6 * (2 * n + 1) * step / n) < 1e-6 and not cal.callbackBelowResolution, 'callback ' .. cal.callbackUs)
  assert(math.abs(cal.boundaryUs - 1e6 * (k * 0.00002 + step) / k) < 1e-6 and cal.boundarySource == 'measured', 'boundary ' .. cal.boundaryUs)
  assert(math.abs(cal.perCallUs - (cal.callbackUs + 2 * cal.boundaryUs)) < 1e-9)
  -- A clock that does not move over a batch gives an upper bound (1 ms over the batch), never zero; no game: the plan's 25 us.
  os.clock = function() return t end
  Game.GetPlayer = function() error('no game') end
  cal = m.calibrate()
  assert(cal.callbackBelowResolution and math.abs(cal.callbackUs - 1000 / n) < 1e-9)
  assert(cal.boundarySource == 'assumed' and cal.boundaryUs == 25 and math.abs(cal.perCallUs - (1000 / n + 50)) < 1e-9)
  -- The estimate: calls per second times the cost of one dispatch, and the FPS that is at 48 fps.
  local ms, fps = m.estimate(60, {perCallUs = 42})
  assert(math.abs(ms - 2.52) < 1e-9 and math.abs(fps - 48 * 2.52 / 1000) < 1e-9)
  assert(m.verdict(0.5) == 'negligible' and m.verdict(2.52) == 'small' and m.verdict(5) == 'too-costly')
`));

test('the report applies the calibration: the busiest window sets the peak, the whole run the mean', () => fixture(`
  m.start(env, 120)
  -- Calibrated at start: the clock stood still over the callback batch (0.05 us, an upper bound) and each round trip took 20 us.
  local cal = m.calibration
  -- (the fake clock is a float near 1000, so a sum of 500 round trips of 20 us carries rounding noise well under a thousandth of a us)
  assert(math.abs(cal.callbackUs - 0.05) < 1e-9 and math.abs(cal.boundaryUs - 20) < 1e-3 and math.abs(cal.perCallUs - 40.05) < 1e-3)
  local hit = after['NPCPuppet.OnHit']
  for _ = 1, 600 do hit(npc, {}) end
  t = t + 10; m.tick(env)
  for _ = 1, 100 do hit(npc, {}) end
  t = t + 10
  local row = m.stop(env).hooks['NPCPuppet.OnHit']
  assert(row.calls == 700 and row.callsPerSecond == 35 and row.peakCallsPerSecond == 60)
  assert(row.estimatedMsPerSecond == math.floor(35 * 40.05 + 0.5) / 1000, 'mean ' .. row.estimatedMsPerSecond)
  assert(row.peakEstimatedMsPerSecond == math.floor(60 * 40.05 + 0.5) / 1000 and row.verdict == 'small')
  assert(row.peakFpsAt48 == math.floor(48 * 60 * 40.05 / 1000 + 0.5) / 1000)
  assert(row.callsPerCombatSecond == 1400, 'one combat sample of 0.5 s')
`));
