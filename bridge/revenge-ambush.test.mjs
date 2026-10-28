// Revenge ambushes, the decision module (mod/revenge-ambush.lua, docs/AMBUSHES.md) under fengari with stand-ins for the game: the grudge, the cases that keep a
// squad away, the placing, the fight, the single taunt, the saved grudge and the cleanup. The game side (mod/revenge-ambush-world.lua) is checked by reading it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const moduleSource = read('../mod/revenge-ambush.lua');
const worldSource = read('../mod/revenge-ambush-world.lua');
const initSource = read('../mod/init.lua');
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

// A tiny `json` (the game's is native): tables are written as Lua source.
const harness = `
json = {}
local function ser(v)
  if type(v) == 'table' then
    local out = {}
    for k, x in pairs(v) do out[#out + 1] = '[' .. ser(k) .. ']=' .. ser(x) end
    return '{' .. table.concat(out, ',') .. '}'
  elseif type(v) == 'string' then return string.format('%q', v) end
  return tostring(v)
end
function json.encode(v) return 'return ' .. ser(v) end
function json.decode(s) return load(s)() end
local Ambush = (function() ${moduleSource} end)()
local clockNow, gameNow, rolls = 1000, 5000000, 0
local files, calls, barks, world, spots = {}, {created = {}, deleted = {}, armed = 0}, {}, nil, 0
local npcs, enabled, fighterOk = {}, true, true
local function make(extra)
  local options = {
    enabled = function() return enabled end,
    clock = function() return clockNow end,
    gameTime = function() return gameNow end,
    random = function() rolls = rolls + 1; return 0 end,
    world = function() return world end,
    recordOf = function(npc) return npc.record end,
    verify = function(record, group) return fighterOk and record:find('Character.', 1, true) == 1 end,
    findSpot = function(state, relax)
      spots = spots + 1
      return {position = {x = 1, y = 2, z = 3}, facing = {x = 1, y = 0}}
    end,
    create = function(record, spot, index, count)
      calls.created[#calls.created + 1] = record
      local npc = {handle = #calls.created, alive = true, armed = false, near = 20}
      npcs[npc.handle] = npc
      return npc.handle
    end,
    entity = function(handle) return npcs[handle] end,
    alive = function(npc) return npc.alive end,
    playerNear = function(npc) return npc.near end,
    arm = function(npc) npc.armed = true; calls.armed = calls.armed + 1; return true end,
    hidden = function(npc) return true end,
    delete = function(handle) calls.deleted[#calls.deleted + 1] = handle; npcs[handle] = nil end,
    bark = function(npc, info) barks[#barks + 1] = info; return true end,
    read = function(path) return files[path] end,
    write = function(path, text) files[path] = text; return true end,
    log = function() end,
  }
  for k, v in pairs(extra or {}) do options[k] = v end
  return Ambush.new(options)
end
-- Kills as the Street reputation recorder reports them (a = the game's affiliation name, w = seen).
local function kill(A, n, affiliation, record, witnessed)
  if record == nil then record = 'Character.maelstrom_grunt1_ranged1_lexington_ma' elseif record == false then record = nil end
  for _ = 1, n do A.deed({k = 'kill', a = affiliation or 'Maelstrom', w = witnessed ~= false, t = gameNow}, {record = record}) end
end
-- Runs the module's tick as the mod does: 0.1 s steps; returns the last non-nil result.
local function run(A, seconds, ready)
  local last
  for _ = 1, math.floor(seconds * 10) do
    clockNow = clockNow + 0.1
    local r = A.tick(0.1, ready ~= false)
    if r then last = r end
  end
  return last
end
-- Plays on until a squad stands (at most ten minutes of play).
local function untilSquad(A)
  for _ = 1, 120 do run(A, 5); if A.status().active then return true end end
  return false
end
`;

test('off by default: no grudge, no tick work, nothing built', () => runWith(`${harness}
  enabled = false
  local A = make()
  assert(A.deed({k = 'kill', a = 'Maelstrom', w = true, t = gameNow}, nil) == false)
  assert(next(A.groups) == nil)
  assert(run(A, 600) == nil)
  assert(A.status().looks == 0 and A.status().squads == 0)
`));

test('only a gang V kills counts: police, crowd, other kinds and unknown affiliations leave no grudge', () => runWith(`${harness}
  local A = make()
  assert(A.deed({k = 'kill', a = 'Maelstrom', w = true, p = true, t = gameNow}) == false)
  assert(A.deed({k = 'kill', a = 'Maelstrom', w = true, c = true, t = gameNow}) == false)
  assert(A.deed({k = 'react', a = 'Maelstrom', w = true, t = gameNow}) == false)
  assert(A.deed({k = 'kill', a = 'Nobody', w = true, t = gameNow}) == false)
  assert(A.deed({k = 'kill', a = 'NCPD', w = true, t = gameNow}) == false)
  assert(next(A.groups) == nil)
  assert(A.deed({k = 'kill', a = 'MaelstromAndroid', w = true, t = gameNow}) and A.points('maelstrom') == 1)
  assert(A.deed({k = 'kill', a = 'Maelstrom', w = false, t = gameNow}) and math.abs(A.points('maelstrom') - 1.25) < 1e-9)
  assert(A.deed({k = 'defeat', a = 'TygerClaws', w = true, t = gameNow}) and math.abs(A.points('tyger-claws') - 0.4) < 1e-9)
`));

test('the grudge halves in fourteen game days and is capped', () => runWith(`${harness}
  local A = make()
  kill(A, 100)
  assert(A.points('maelstrom') == Ambush.MAX_POINTS)
  gameNow = gameNow + 14 * 86400
  assert(math.abs(A.points('maelstrom') - Ambush.MAX_POINTS / 2) < 1e-6)
`));

test('below the threshold nothing ever comes, however long V plays', () => runWith(`${harness}
  local A = make()
  kill(A, 5)
  assert(run(A, 3600) ~= 'planned')
  assert(A.status().squads == 0 and #calls.created == 0)
`));

test('the cases that keep a squad away: not ready, just after a load, a fight, a scene, a call, a vehicle, indoors, wanted, too soon after a fight', () => runWith(`${harness}
  local A = make()
  kill(A, 8)
  -- the world is not ready: the counters stay at zero
  run(A, 600, false)
  assert(A.status().looks == 0)
  -- just after a load
  assert(run(A, 100) == 'after-load' or run(A, 100) == nil)
  assert(#calls.created == 0)
  for _, reason in ipairs({'combat', 'scene', 'call', 'vehicle', 'interior', 'wanted', 'safe-zone', 'unreadable'}) do
    world = reason
    local r = run(A, 300)
    assert(r == 'world:' .. reason, reason .. ' -> ' .. tostring(r))
    assert(A.status().squads == 0 and #calls.created == 0)
  end
  -- out of the fight: V must stay calm for CALM seconds before a squad may come
  world = nil
  A.calm = 0
  A.acc = 0
  local r
  for _ = 1, 25 do r = A.tick(1, true); if r then break end end
  assert(r == nil or r == 'calm' or r == 'planned' or r == 'after-load', tostring(r))
`));

test('a squad comes once: placed at the spot, armed, one taunt from the nearest member, then removed; a long cooldown follows', () => runWith(`${harness}
  local A = make()
  kill(A, 8)
  local result
  for _ = 1, 40 do result = run(A, 31); if A.status().phase ~= 'idle' then break end end
  assert(A.status().phase == 'search' or A.status().phase == 'active', A.status().phase)
  run(A, 5)
  assert(A.status().squads == 1, 'squads ' .. A.status().squads)
  assert(#calls.created == 2 and calls.created[1]:find('Character.', 1, true) == 1)
  -- a point of the grudge is spent: about half is left
  assert(A.points('maelstrom') < 5 and A.points('maelstrom') > 1.5, A.points('maelstrom'))
  -- they run at V: the taunt comes once, from within range
  for _, npc in pairs(npcs) do npc.near = 15 end
  run(A, 5)
  assert(calls.armed == 2, calls.armed)
  assert(#barks == 1 and barks[1].group == 'maelstrom' and barks[1].count == 2, #barks)
  run(A, 10)
  assert(#barks == 1, 'the line is said once')
  -- they all fall: the dead stay a little, then go
  for _, npc in pairs(npcs) do npc.alive = false end
  run(A, 5)
  assert(A.status().phase == 'idle' and A.status().active == nil)
  run(A, Ambush.CORPSE_KEEP + 40)
  assert(#calls.deleted == 2, #calls.deleted)
  -- the next squad is a long wait away, even with a grudge left over
  kill(A, 20)
  run(A, 600)
  assert(A.status().squads == 1, 'the cooldown held')
`));

test('what the gang sends is what V killed, else the game\'s own retaliation fighters; a gang with neither sends nobody', () => runWith(`${harness}
  local A = make()
  kill(A, 8, 'Maelstrom', 'Character.maelstrom_grunt1_ranged1_lexington_ma')
  kill(A, 1, 'Maelstrom', 'Character.maelstrom_boss_x')
  kill(A, 1, 'Maelstrom', 'Character.maelstrom_netrunner_y')
  local list = A.fighters('maelstrom')
  assert(#list == 1 and list[1] == 'Character.maelstrom_grunt1_ranged1_lexington_ma', table.concat(list, ','))
  -- nobody learned: the seeds, each only if the game has it
  local B = make()
  kill(B, 8, 'Wraiths', false)
  local seeds = B.fighters('wraiths')
  assert(#seeds == 3 and seeds[1]:find('gang_retaliation_enemies_wraiths', 1, true), table.concat(seeds, ','))
  fighterOk = false
  assert(#B.fighters('wraiths') == 0)
  fighterOk = true
  local C = make()
  kill(C, 8, 'VoodooBoys', false)
  assert(#C.fighters('voodoo-boys') == 0)
  assert(Ambush.SEEDS.maelstrom[1]:find('gang_retaliation_enemies', 1, true))
`));

test('a spot that cannot be found is given up after a few rungs and tried again after a short wait; nothing is spent', () => runWith(`${harness}
  local A = make({findSpot = function() return nil, 'no ground' end})
  kill(A, 10)
  local before = A.points('maelstrom')
  run(A, 600)
  assert(A.status().squads == 0 and A.status().failed >= 1 and #calls.created == 0)
  assert(math.abs(A.points('maelstrom') - before) < 1e-6)
  assert(A.cooldown == Ambush.RETRY_COOLDOWN)
`));

test('a squad left behind or timed out goes out of sight; turning the setting off removes it at once', () => runWith(`${harness}
  local A = make()
  kill(A, 8)
  assert(untilSquad(A), 'a squad was sent')
  for _, npc in pairs(npcs) do npc.near = Ambush.FAR + 10 end
  run(A, 3)
  assert(A.status().active == nil)
  run(A, 35)
  assert(#calls.deleted == 2)
  -- a second squad, removed by the setting
  calls.deleted, calls.created = {}, {}
  A.lastAt = nil; A.cooldown = nil
  kill(A, 10)
  assert(untilSquad(A), 'the second squad')
  local made = #calls.created
  assert(made == 3, 'a bigger grudge sends three: ' .. made)
  enabled = false
  run(A, 1)
  assert(A.status().active == nil and #calls.deleted == made, #calls.deleted)
`));

test('the grudge is saved and read back; a grudge from a later game clock, or older than sixty days, is dropped; a load can only forget', () => runWith(`${harness}
  local A = make()
  kill(A, 8)
  assert(A.flush('test') == true)
  local raw = files[Ambush.PATH]
  assert(type(raw) == 'string' and raw:find('maelstrom', 1, true))
  local B = make()
  run(B, 31)
  assert(B.points('maelstrom') > 7, B.points('maelstrom'))
  -- from the future (another playthrough)
  files[Ambush.PATH] = json.encode({version = 1, groups = {maelstrom = {p = 9, t = gameNow + 86400}}})
  local C = make()
  run(C, 31)
  assert(C.points('maelstrom') == 0)
  -- too old
  files[Ambush.PATH] = json.encode({version = 1, groups = {maelstrom = {p = 9, t = gameNow - 61 * 86400}}})
  local D = make()
  run(D, 31)
  assert(D.points('maelstrom') == 0)
  -- junk and unknown gangs
  files[Ambush.PATH] = 'not a table'
  local E = make(); run(E, 31)
  files[Ambush.PATH] = json.encode({version = 1, groups = {nobody = {p = 9, t = gameNow}}})
  local F = make(); run(F, 31)
  assert(next(F.groups) == nil)
`));

test('reset drops every reference without a native call and keeps the file', () => runWith(`${harness}
  local A = make()
  kill(A, 8)
  run(A, 400)
  local deletedBefore = #calls.deleted
  A.reset('load')
  assert(#calls.deleted == deletedBefore, 'reset made a native call')
  assert(A.status().phase == 'idle' and A.status().active == nil and next(A.groups) == nil)
  assert(files[Ambush.PATH] ~= nil)
`));

test('the game side asks for nothing it should not: new tagged copies only, no per-frame hook, every native call guarded', () => {
  assert.match(worldSource, /DynamicEntitySystem/);
  assert.match(worldSource, /spec\.tags = \{CName\.new\(M\.TAG\)\}/);
  assert.doesNotMatch(worldSource, /registerForEvent|Observe\(|Override\(|onUpdate/);
  assert.doesNotMatch(moduleSource, /registerForEvent|Observe\(|Override\(|onUpdate|Game\./);
  assert.doesNotMatch(moduleSource + worldSource, /\bAMM\b/);
});

test('init.lua: one boolean while off, the tick is the mod\'s own, the recorder is shared with Street reputation, the world keeps no handle', () => {
  assert.match(initSource, /function convaiAmbushTick\(player, elapsed, ready\)\s*\n\s*if type\(manager\.revengeAmbushes\) ~= 'function' or not manager\.revengeAmbushes\(\) then/);
  assert.match(initSource, /pcall\(convaiAmbushTick, player, elapsedPoll, worldReady\)/);
  assert.match(initSource, /onDeed = function\(row, npc\) if convaiAmbush then convaiAmbush\.deed\(row, npc\) end end/);
  assert.match(initSource, /if convaiAmbush then pcall\(convaiAmbush\.reset, reason\) end/);
});

test('init.lua: the deed recorder also starts at load when only Revenge ambushes is on (not just Street reputation)', () => {
  assert.match(initSource, /if convaiDeedsWanted\(\) then pcall\(convaiReputationWanted\) end/);
  assert.doesNotMatch(initSource, /if type\(manager\.reputation\) == 'function' and manager\.reputation\(\) then pcall\(convaiReputationWanted\) end/);
  assert.match(initSource, /function convaiDeedsWanted\(\)[\s\S]*?manager\.revengeAmbushes\(\) == true/);
});
