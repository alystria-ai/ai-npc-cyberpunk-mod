// The RACE group of bond quest primitives, the game half (mod/quest-prims-race.lua and its natives mod/quest-world-race.lua, docs/QUEST_PRIMITIVES.md, BOND_QUESTS.md
// section 21): race and convoy. Run on a fake game: a clock, a game clock, a world of positions whose rows die at every tick (the test fails if a module keeps one), V who
// drives toward a target, and cars that move toward the target of their last command when someone drives them. Nothing here starts the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, load, source, base, fakeCtx} from './quest-lua-fixture.mjs';

const harness = `
local Places = ${load('quest-places.lua')}
local Prims = ${load('quest-prims.lua')}
local Race = ${load('quest-prims-race.lua')}
${base}
${fakeCtx}
local game = {now = 0, gameClock = 100000, rate = 30, tick = 0, stale = false, calls = {},
  v = {pos = {x = 0, y = 0, z = 0}, target = nil, speed = 20, driving = true, mounted = true}, readFails = false,
  copy = {profileKey = 'jackie-welles', kind = 'visitor', position = {x = 0, y = 0, z = 0}}, heat = 0,
  units = {}, nextUnit = 1, spawnFail = 0, spawnFailAfter = nil, mountWorks = true, seatWorks = true, driveAccepted = true, followAccepted = true, autoAttach = true,
  deletes = {}, spawns = {}, unmounts = 0, seats = 0, followCalls = {}}
local function fresh(t)
  local gen = game.tick
  return setmetatable({}, {__index = function(_, k)
    if gen ~= game.tick then game.stale = true; error('a stale handle was used: ' .. tostring(k)) end
    return t[k]
  end})
end
local function counted(name, fn)
  return function(...) game.calls[name] = (game.calls[name] or 0) + 1; return fn(...) end
end
local function plainOf(p) return {x = p.x, y = p.y, z = p.z} end
local world = {
  playerPosition = counted('playerPosition', function() return fresh(game.v.pos) end),
  copyOf = counted('copyOf', function(key)
    if not game.copy or game.copy.profileKey ~= key then return nil end
    return fresh({kind = game.copy.kind, serial = 7, position = fresh(game.copy.position)})
  end),
  rayDown = function() return nil end,
  raceRead = counted('raceRead', function()
    if game.readFails then error('the mounting facility is not ready') end
    return fresh({mounted = game.v.mounted, driving = game.v.driving, at = fresh(game.v.pos)})
  end),
  readHeat = counted('readHeat', function() return game.heat end),
  driveSpawn = counted('driveSpawn', function(req)
    game.spawns[#game.spawns + 1] = req
    if game.spawnFail > 0 and (not game.spawnFailAfter or #game.spawns > game.spawnFailAfter) then game.spawnFail = game.spawnFail - 1; return nil, 'The game could not create the car.' end
    local u = {id = 'u' .. game.nextUnit, req = req, attached = false, driverIn = false, copyIn = false, alive = true, pos = {x = req.x, y = req.y, z = req.z},
      attachAt = game.now + 2, mountCalls = 0, toCalls = {}, followCalls = 0, maxSpeed = 0}
    game.nextUnit = game.nextUnit + 1
    game.units[u.id] = u
    return {id = u.id}
  end),
  driveLookup = counted('driveLookup', function(h)
    local u = game.units[h.id]
    if not u or u.deleted or not u.attached or u.destroyed then return fresh({attached = false}) end
    return fresh({attached = true, position = fresh(u.pos), driverIn = u.driverIn, alive = u.alive})
  end),
  driveMountDriver = counted('driveMountDriver', function(h)
    local u = game.units[h.id]; u.mountCalls = u.mountCalls + 1
    if game.mountWorks then u.driverIn = true end
    return true
  end),
  driveTo = counted('driveTo', function(h, target, speed)
    local u = game.units[h.id]
    u.toCalls[#u.toCalls + 1] = plainOf(target); u.target = plainOf(target); u.maxSpeed = speed; u.following = nil
    return game.driveAccepted
  end),
  driveFollowCar = counted('driveFollowCar', function(h, ahead, gap)
    local u = game.units[h.id]
    u.followCalls = u.followCalls + 1
    game.followCalls[#game.followCalls + 1] = {from = h.id, to = ahead.id, gap = gap}
    if game.followAccepted then u.following = ahead.id; u.target = nil; u.gap = gap end
    return game.followAccepted
  end),
  driveBrake = counted('driveBrake', function(h) local u = game.units[h.id]; u.braked = true; u.target = nil; u.following = nil; return true end),
  driveDelete = counted('driveDelete', function(h) local u = game.units[h.id]; u.deleted = true; game.deletes[#game.deletes + 1] = h.id; return true end),
  postCarMount = counted('postCarMount', function(serial, h, unmount)
    local u = game.units[h.id]
    if unmount then game.unmounts = game.unmounts + 1; u.copyIn = false
    else game.seats = game.seats + 1; if game.seatWorks then u.copyIn = true end end
    return true
  end),
  postCarMounted = counted('postCarMounted', function(serial, h) local u = game.units[h.id]; return u ~= nil and u.copyIn end),
}
local places = Places.new({world = world, clock = function() return game.now end, log = log})
local prims = Prims.new({places = places, world = world, clock = function() return game.now end, gameTime = function() return game.gameClock end, log = log})
assert(prims.extend(Race), 'the race group installs')
local function drive(ctx, specs)
  local insts = {}
  for _, spec in ipairs(specs) do
    local def = prims.get(spec.p)
    assert(def, 'unknown primitive ' .. spec.p)
    local state = def.arm(ctx, spec, prims.env)
    if state ~= nil then insts[#insts + 1] = {def = def, spec = spec, state = state, nextAt = 0} end
  end
  return insts
end
local function stepTo(p, target, speed)
  local dx, dy = target.x - p.x, target.y - p.y
  local d = math.sqrt(dx * dx + dy * dy)
  if d < 0.001 then return p end
  local step = math.min(d, speed)
  return {x = p.x + dx / d * step, y = p.y + dy / d * step, z = p.z}
end
local function canMove(u)
  if u.req.driver then return u.driverIn end
  return u.copyIn
end
local function advance(ctx, insts, seconds)
  for _ = 1, seconds do
    game.now = game.now + 1; game.gameClock = game.gameClock + game.rate; game.tick = game.tick + 1
    if game.v.target and game.v.speed > 0 then game.v.pos = stepTo(game.v.pos, game.v.target, game.v.speed) end
    for _, u in pairs(game.units) do
      if not u.attached and not u.deleted and game.autoAttach and game.now >= u.attachAt then u.attached = true end
      if u.attached and not u.deleted and not u.destroyed and canMove(u) and not u.blocked then
        if u.target then
          u.pos = stepTo(u.pos, u.target, u.maxSpeed or 10)
          if math.sqrt((u.target.x - u.pos.x) ^ 2 + (u.target.y - u.pos.y) ^ 2) < 0.5 then u.target = nil end
        elseif u.following then
          local ahead = game.units[u.following]
          if ahead and not ahead.deleted then
            local d = math.sqrt((ahead.pos.x - u.pos.x) ^ 2 + (ahead.pos.y - u.pos.y) ^ 2)
            if d > (u.gap or 12) then u.pos = stepTo(u.pos, ahead.pos, math.min(14, d - (u.gap or 12))) end
          end
        end
      end
    end
    for _, inst in ipairs(insts) do
      if inst.def.tick and not ctx.reaped and game.now >= inst.nextAt then
        inst.nextAt = game.now + (inst.def.interval or 1)
        inst.def.tick(ctx, inst.spec, inst.state, prims.env)
      end
    end
  end
end
local function stageCtx(character)
  local ctx = newCtx('pk', character or 'jackie-welles')
  function ctx:untrack(handle, run)
    for index = #self.tracked, 1, -1 do
      local item = self.tracked[index]
      if item.handle == handle then
        table.remove(self.tracked, index)
        if run ~= false and item.undo then item.undo(handle) end
        return true
      end
    end
    return false
  end
  ctx.places = {line = {x = 0, y = 0, z = 0, radius = 25}, finish = {x = 1000, y = 0, z = 0, radius = 30},
    s0 = {x = 0, y = 0, z = 0, radius = 25}, l1 = {x = 300, y = 0, z = 0, radius = 30}, l2 = {x = 600, y = 0, z = 0, radius = 30}, camp = {x = 900, y = 0, z = 0, radius = 30},
    alt1 = {x = 600, y = 300, z = 0, radius = 30}, alt2 = {x = 900, y = 300, z = 0, radius = 30}}
  return ctx
end
local function has(ctx, name) return ctx:count(name) > 0 end
local function eventsText(ctx) return table.concat(ctx.events, ',') end
local function unitCount() local n = 0 for _ in pairs(game.units) do n = n + 1 end return n end
local function alive() local n = 0 for _, u in pairs(game.units) do if not u.deleted then n = n + 1 end end return n end
local function firstUnit() return game.units.u1 end
`;
const withGame = code => run(`${harness}\n${code}\nassert(not game.stale, 'a handle was kept across ticks')`);

// ---- race ----------------------------------------------------------------------------------------------------------------------------------------------------------

test('race: her car is made at the line when V is near, she sits in it and waits, nothing moves before race:<id>:go, then started once', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'race', id = 'r', from = 'line', to = 'finish', vehicle = 'Vehicle.v_test_bike'}})
assert(#insts == 1)
game.v.pos = {x = 400, y = 0, z = 0}
advance(ctx, insts, 10)
assert(#game.spawns == 0, 'V is 400 m from the line: no car yet')
game.v.pos = {x = 100, y = 0, z = 0}
advance(ctx, insts, 12)
assert(#game.spawns == 1 and game.spawns[1].tag == 'CyberpunkConvaiQuest:pk' and game.spawns[1].kind == 'car' and game.spawns[1].vehicle == 'Vehicle.v_test_bike', 'tagged car')
assert(game.spawns[1].neutral == true, 'the neutral clone is asked for')
assert(game.spawns[1].x == 0 and game.spawns[1].y == 0, 'at the line')
assert(game.spawns[1].driver == nil, 'she drives, no nameless driver')
assert(#ctx.tracked == 1)
assert(firstUnit().copyIn == true and game.seats >= 1, 'she sits in her car')
assert((game.calls.driveTo or 0) == 0 and #ctx.events == 0, 'she waits at the line: ' .. eventsText(ctx))
advance(ctx, insts, 30)
assert((game.calls.driveTo or 0) == 0 and #ctx.events == 0, 'still waiting')
ctx:emit('race:r:go')
advance(ctx, insts, 2)
assert(ctx:count('race:r:started') == 1 and game.calls.driveTo == 1, eventsText(ctx))
assert(firstUnit().toCalls[1].x == 1000 and firstUnit().maxSpeed == 14, 'driven to the finish at 14 m/s')
ctx:emit('race:r:go'); advance(ctx, insts, 2)
assert(ctx:count('race:r:started') == 1, 'once')
`));

test('race: V arrives first and wins once, her car is braked and she gets out, nothing more is said or read', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'race', id = 'r', from = 'line', to = 'finish'}})
game.v.pos = {x = 0, y = -20, z = 0}
advance(ctx, insts, 8)
game.v.speed = 30; game.v.target = {x = 1000, y = 0, z = 0}
ctx:emit('race:r:go')
advance(ctx, insts, 60)
assert(ctx:count('race:r:won') == 1 and ctx:count('race:r:lost') == 0 and ctx:count('race:r:started') == 1, eventsText(ctx))
assert(firstUnit().braked == true and game.unmounts == 1 and firstUnit().copyIn == false, 'braked and out of the car')
local reads = game.calls.raceRead
advance(ctx, insts, 20)
assert(game.calls.raceRead == reads and ctx:count('race:r:won') == 1, 'a race that is over reads nothing')
`));

test('race: she arrives first and V loses, a tie goes to V, a V who is not driving does not arrive', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'race', id = 'r', from = 'line', to = 'finish', speed = 30}})
game.v.pos = {x = 0, y = -20, z = 0}; advance(ctx, insts, 8)
game.v.speed = 10; game.v.target = {x = 1000, y = 0, z = 0}
ctx:emit('race:r:go'); advance(ctx, insts, 60)
assert(ctx:count('race:r:lost') == 1 and ctx:count('race:r:won') == 0, eventsText(ctx))
-- A second race: V sits in the finish place but does not drive (a passenger of nobody): that is no arrival.
local c2 = stageCtx()
game.units = {}; game.nextUnit = 1; game.v.target = nil; game.v.pos = {x = 0, y = -20, z = 0}
local i2 = drive(c2, {{p = 'race', id = 'q', to = 'finish', speed = 5}})
advance(c2, i2, 10)
assert(c2:count('race:q:started') == 1, eventsText(c2))
game.v.pos = {x = 1000, y = 0, z = 0}; game.v.driving = false
advance(c2, i2, 4)
assert(c2:count('race:q:won') == 0, 'V on foot at the finish does not win: ' .. eventsText(c2))
game.v.driving = true; advance(c2, i2, 2)
assert(c2:count('race:q:won') == 1, eventsText(c2))
`));

test('race: headStart seconds after she sits starts it without a go, no from starts it at once, a go before she is ready is kept', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'race', id = 'h', from = 'line', to = 'finish', headStart = 10}})
game.v.pos = {x = 50, y = 0, z = 0}
advance(ctx, insts, 12)
assert(ctx:count('race:h:started') == 0, 'she has just sat down')
advance(ctx, insts, 12)
assert(ctx:count('race:h:started') == 1, eventsText(ctx))
local c2 = stageCtx()
game.units = {}; game.nextUnit = 1
local i2 = drive(c2, {{p = 'race', id = 'n', to = 'finish'}})
advance(c2, i2, 12)
assert(c2:count('race:n:started') == 1, 'no line, no waiting: ' .. eventsText(c2))
assert(game.spawns[#game.spawns].x == 0, 'her car stands where she stands')
local c3 = stageCtx()
game.units = {}; game.nextUnit = 1
local i3 = drive(c3, {{p = 'race', id = 'e', from = 'line', to = 'finish'}})
c3:emit('race:e:go')
advance(c3, i3, 14)
assert(c3:count('race:e:started') == 1, 'the early go starts her as soon as she sits: ' .. eventsText(c3))
`));

test('race: reversed, the slowest to arrive wins: she drives slowly, V arrives after her and wins, V arriving before her loses', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'race', id = 'r', from = 'line', to = 'finish', reversed = true}})
game.v.pos = {x = 0, y = -20, z = 0}; advance(ctx, insts, 8)
ctx:emit('race:r:go')
advance(ctx, insts, 2)
assert(firstUnit().maxSpeed == 6, 'a reversed race is driven slowly by default')
firstUnit().maxSpeed = 100
-- V creeps along at 9 m/s, she is quick here: she arrives first, V arrives later and so wins.
game.v.speed = 9; game.v.target = {x = 1000, y = 0, z = 0}
advance(ctx, insts, 140)
assert(ctx:count('race:r:won') == 1 and ctx:count('race:r:lost') == 0 and ctx:count('race:r:stopped') == 0, eventsText(ctx))
local c2 = stageCtx()
game.units = {}; game.nextUnit = 1
game.v.pos = {x = 0, y = -20, z = 0}; game.v.target = nil
local i2 = drive(c2, {{p = 'race', id = 'q', from = 'line', to = 'finish', reversed = true, speed = 5}})
advance(c2, i2, 8)
c2:emit('race:q:go')
game.v.speed = 40; game.v.target = {x = 1000, y = 0, z = 0}
advance(c2, i2, 300)
assert(c2:count('race:q:lost') == 1 and c2:count('race:q:won') == 0, 'V arrived first: ' .. eventsText(c2))
`));

test('race: reversed, a side that stands still for stillSeconds before it arrives loses: V stopped, or her car stuck', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'race', id = 'r', from = 'line', to = 'finish', reversed = true, stillSeconds = 5}})
game.v.pos = {x = 0, y = -20, z = 0}; advance(ctx, insts, 8)
ctx:emit('race:r:go')
game.v.speed = 8; game.v.target = {x = 1000, y = 0, z = 0}
advance(ctx, insts, 20)
assert(#ctx.events == 2 and ctx.events[2] == 'race:r:started', eventsText(ctx))
game.v.speed = 0
advance(ctx, insts, 3); assert(ctx:count('race:r:stopped') == 0, 'three seconds is not enough')
advance(ctx, insts, 4)
assert(ctx:count('race:r:stopped') == 1 and ctx:count('race:r:lost') == 1 and ctx:count('race:r:won') == 0, eventsText(ctx))
assert(ctx.events[#ctx.events - 1] == 'race:r:stopped' and ctx.events[#ctx.events] == 'race:r:lost', 'stopped, then the other side wins')
-- Her car is stuck: V wins.
local c2 = stageCtx()
game.units = {}; game.nextUnit = 1
game.v.pos = {x = 0, y = -20, z = 0}; game.v.target = nil; game.v.speed = 8
local i2 = drive(c2, {{p = 'race', id = 'q', from = 'line', to = 'finish', reversed = true}})
advance(c2, i2, 8)
c2:emit('race:q:go')
game.v.target = {x = 1000, y = 0, z = 0}
advance(c2, i2, 6)
firstUnit().blocked = true
advance(c2, i2, 12)
assert(c2:count('race:q:stopped') == 1 and c2:count('race:q:won') == 1 and c2:count('race:q:lost') == 0, eventsText(c2))
-- A plain race has no still rule.
local c3 = stageCtx()
game.units = {}; game.nextUnit = 1
game.v.pos = {x = 0, y = -20, z = 0}; game.v.target = nil
local i3 = drive(c3, {{p = 'race', id = 'p', from = 'line', to = 'finish'}})
advance(c3, i3, 8); c3:emit('race:p:go'); advance(c3, i3, 30)
assert(c3:count('race:p:stopped') == 0 and c3:count('race:p:won') == 0 and c3:count('race:p:lost') == 0, 'V sits still in a plain race: ' .. eventsText(c3))
`));

test('race: heat true voids it within two seconds of a wanted level, heat off never reads it', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'race', id = 'r', from = 'line', to = 'finish', heat = true}})
game.v.pos = {x = 0, y = -20, z = 0}; advance(ctx, insts, 8)
ctx:emit('race:r:go'); advance(ctx, insts, 4)
assert(ctx:count('race:r:started') == 1 and ctx:count('race:r:void') == 0)
game.heat = 2
advance(ctx, insts, 3)
assert(ctx:count('race:r:void') == 1 and ctx:count('race:r:won') == 0, eventsText(ctx))
assert(firstUnit().braked and game.unmounts == 1, 'her car stops and she gets out')
local reads = game.calls.readHeat
advance(ctx, insts, 20); assert(game.calls.readHeat == reads and ctx:count('race:r:void') == 1)
local c2 = stageCtx()
game.units = {}; game.nextUnit = 1; game.calls.readHeat = 0
local i2 = drive(c2, {{p = 'race', id = 'q', from = 'line', to = 'finish'}})
advance(c2, i2, 20)
assert(game.calls.readHeat == 0 and c2:count('race:q:void') == 0, 'no heat rule, no heat read')
`));

test('race: limitMinutes in game minutes from the start is race:<id>:timeout once, with no game clock the real clock stands in', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'race', id = 'r', from = 'line', to = 'finish', limitMinutes = 10}})
game.v.pos = {x = 0, y = -20, z = 0}; game.v.speed = 0; advance(ctx, insts, 8)
firstUnit().blocked = true
ctx:emit('race:r:go'); advance(ctx, insts, 3)
assert(ctx:count('race:r:started') == 1)
advance(ctx, insts, 15); assert(ctx:count('race:r:timeout') == 0, '600 game seconds are 20 s at 30 to 1')
advance(ctx, insts, 8); assert(ctx:count('race:r:timeout') == 1, eventsText(ctx))
advance(ctx, insts, 30); assert(ctx:count('race:r:timeout') == 1 and ctx:count('race:r:won') == 0 and ctx:count('race:r:lost') == 0)
assert(firstUnit().braked and game.unmounts == 1)
local bare = Prims.new({places = places, world = world, clock = function() return game.now end, log = log})
assert(bare.extend(Race))
local c2 = stageCtx()
game.units = {}; game.nextUnit = 1
local state = bare.get('race').arm(c2, {p = 'race', id = 'b', from = 'line', to = 'finish', limitMinutes = 2}, bare.env)
local inst = {{def = bare.get('race'), spec = {}, state = state, nextAt = 0}}
game.v.pos = {x = 0, y = -20, z = 0}; game.v.speed = 0
advance(c2, inst, 8); c2:emit('race:b:go'); advance(c2, inst, 2); assert(c2:count('race:b:started') == 1)
firstUnit().blocked = true
advance(c2, inst, 2); assert(c2:count('race:b:timeout') == 0)
advance(c2, inst, 4); assert(c2:count('race:b:timeout') == 1, 'two game minutes are four real seconds: ' .. eventsText(c2))
`));

test('race: it is void when it cannot be run: a party copy, no copy, a car that cannot be made, seated or driven, a car that vanishes, a copy that leaves it', () => withGame(`
local function fresh1(spec, setup)
  game.units = {}; game.nextUnit = 1; game.spawns = {}; game.spawnFail = 0; game.mountWorks = true; game.seatWorks = true; game.driveAccepted = true
  game.copy = {profileKey = 'jackie-welles', kind = 'visitor', position = {x = 0, y = 0, z = 0}}
  game.v.pos = {x = 0, y = -20, z = 0}; game.v.target = nil
  if setup then setup() end
  local ctx = stageCtx()
  return ctx, drive(ctx, {spec})
end
local spec = {p = 'race', id = 'r', from = 'line', to = 'finish'}
local ctx, insts = fresh1(spec, function() game.copy.kind = 'party' end)
advance(ctx, insts, 5)
assert(ctx:count('race:r:void') == 1 and #game.spawns == 0 and logged('placed through a cast'), eventsText(ctx))
ctx, insts = fresh1(spec, function() game.copy = nil end)
advance(ctx, insts, 31); assert(ctx:count('race:r:void') == 1 and #game.spawns == 0, 'never seen: ' .. eventsText(ctx))
ctx, insts = fresh1(spec, function() game.spawnFail = 99 end)
advance(ctx, insts, 40); assert(ctx:count('race:r:void') == 1 and #game.spawns == 5, 'five spawn tries then void: ' .. #game.spawns)
ctx, insts = fresh1(spec, function() game.seatWorks = false end)
advance(ctx, insts, 40); assert(ctx:count('race:r:void') == 1 and game.seats == 3 and logged('could not get into the car'), 'three seat tries: ' .. game.seats)
game.seats = 0
ctx, insts = fresh1(spec, function() game.driveAccepted = false end)
advance(ctx, insts, 8); ctx:emit('race:r:go'); advance(ctx, insts, 8)
assert(ctx:count('race:r:void') == 1 and ctx:count('race:r:started') == 0 and logged('cannot drive'), eventsText(ctx))
ctx, insts = fresh1(spec)
advance(ctx, insts, 8); ctx:emit('race:r:go'); advance(ctx, insts, 3)
firstUnit().destroyed = true
advance(ctx, insts, 5); assert(ctx:count('race:r:void') == 1 and ctx:count('race:r:won') == 0 and ctx:count('race:r:lost') == 0, eventsText(ctx))
ctx, insts = fresh1(spec)
advance(ctx, insts, 8); ctx:emit('race:r:go'); advance(ctx, insts, 3)
firstUnit().copyIn = false
advance(ctx, insts, 5); assert(ctx:count('race:r:void') == 1, 'she got out: ' .. eventsText(ctx))
local c3 = stageCtx()
c3.places = {}
assert(#drive(c3, {{p = 'race', id = 'x', to = 'nowhere'}, {p = 'race', to = 'finish'}, {p = 'race', id = 'y', to = 'finish', from = 'nowhere'}}) == 0)
`));

test('race: a read of V that fails counts for nothing, her side still arrives', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'race', id = 'r', from = 'line', to = 'finish', speed = 40}})
game.v.pos = {x = 0, y = -20, z = 0}; advance(ctx, insts, 8)
ctx:emit('race:r:go')
game.readFails = true
advance(ctx, insts, 60)
assert(ctx:count('race:r:lost') == 1 and ctx:count('race:r:void') == 0, eventsText(ctx))
`));

test('race: one reap deletes her car and gets her out first, nothing is made after it', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'race', id = 'r', from = 'line', to = 'finish'}})
game.v.pos = {x = 0, y = -20, z = 0}; advance(ctx, insts, 8)
assert(#ctx.tracked == 1 and firstUnit().copyIn)
ctx:reap()
assert(#ctx.tracked == 0 and #game.deletes == 1 and game.unmounts == 1 and firstUnit().deleted)
local spawns = #game.spawns
advance(ctx, insts, 20); assert(#game.spawns == spawns, 'nothing after the reap')
-- A reap before the car exists leaves nothing to delete.
local c2 = stageCtx()
local i2 = drive(c2, {{p = 'race', id = 'z', from = 'line', to = 'finish'}})
game.v.pos = {x = 900, y = 0, z = 0}
advance(c2, i2, 5); c2:reap()
assert(#game.spawns == spawns)
-- A car made after the ctx was reaped is removed at once.
local late = stageCtx()
late:reap()
function late:track(kind, handle, undo) pcall(undo, handle); return nil end
local more = drive(late, {{p = 'race', id = 'late', from = 'line', to = 'finish'}})
game.v.pos = {x = 0, y = -20, z = 0}
for _ = 1, 3 do game.now = game.now + 3; game.tick = game.tick + 1; more[1].def.tick(late, more[1].spec, more[1].state, prims.env) end
for id, u in pairs(game.units) do assert(u.deleted, id .. ' deleted') end
`));

test('race: the cost stays bounded over a simulated minute', () => withGame(`
local ctx = stageCtx()
local insts = drive(ctx, {{p = 'race', id = 'r', from = 'line', to = 'finish', heat = true}})
game.v.pos = {x = 0, y = -20, z = 0}; game.v.speed = 4
advance(ctx, insts, 10)
ctx:emit('race:r:go')
game.v.target = {x = 1000, y = 0, z = 0}
advance(ctx, insts, 50)
local c = game.calls
assert(c.raceRead <= 60, 'V is read once a second: ' .. c.raceRead)
assert(c.readHeat <= 31, 'heat every two seconds: ' .. c.readHeat)
assert(c.driveLookup <= 62, 'one lookup of her car a second: ' .. c.driveLookup)
assert((c.driveTo or 0) <= 5, 'the command is sent once: ' .. (c.driveTo or 0))
assert(c.copyOf <= 12, 'the copy is read only while the car is made: ' .. c.copyOf)
local total = 0
for _, n in pairs(c) do total = total + n end
assert(total <= 60 * 8, 'in all: ' .. total)
`));

// ---- convoy --------------------------------------------------------------------------------------------------------------------------------------------------------

const column = "{p = 'convoy', id = 'c', route = {'s0', 'l1', 'l2', 'camp'}, driver = 'Character.nomad', vehicle = 'Vehicle.v_test_truck'"
const startColumn = (extra = '') => `
local ctx = stageCtx('panam-palmer')
game.copy = {profileKey = 'panam-palmer', kind = 'visitor', position = {x = 0, y = 0, z = 0}}
local insts = drive(ctx, {${column}${extra}}})
game.v.pos = {x = 0, y = -30, z = 0}
`;

test('convoy: the column is made when V is within 150 m of the start, tagged, the copy leads in her car, two cars with nameless drivers follow', () => withGame(`
local ctx = stageCtx('panam-palmer')
game.copy = {profileKey = 'panam-palmer', kind = 'visitor', position = {x = 0, y = 0, z = 0}}
local insts = drive(ctx, {${column}}})
assert(#insts == 1)
game.v.pos = {x = 600, y = 0, z = 0}
advance(ctx, insts, 10)
assert(#game.spawns == 0, 'V is far: nothing yet')
game.v.pos = {x = 0, y = -60, z = 0}
advance(ctx, insts, 20)
assert(#game.spawns == 3, 'three cars: ' .. #game.spawns)
for _, s in ipairs(game.spawns) do assert(s.tag == 'CyberpunkConvaiQuest:pk' and s.kind == 'car' and s.vehicle == 'Vehicle.v_test_truck' and s.neutral == true) end
assert(game.spawns[1].driver == nil and game.spawns[2].driver == 'Character.nomad' and game.spawns[3].driver == 'Character.nomad', 'the copy drives the lead')
assert(game.spawns[1].y == 0 and game.spawns[2].y == 0 and game.spawns[2].x == -10 and game.spawns[3].x == -20, 'the column stands in a line behind the lead')
assert(#ctx.tracked == 3)
assert(game.units.u1.copyIn == true and game.units.u2.driverIn == true and game.units.u3.driverIn == true, 'everyone is seated')
assert(ctx:count('convoy:c:started') == 1, eventsText(ctx))
`));

test('convoy: the legs are reached in order, leg<N> at each place, arrived once at the last, followers follow the car ahead every two seconds', () => withGame(`
${startColumn()}
advance(ctx, insts, 24)
assert(ctx:count('convoy:c:started') == 1)
local lead = game.units.u1
assert(lead.toCalls[1].x == 300 and lead.maxSpeed == 12, 'the first leg is sent to the lead')
local f1, f2 = game.units.u2, game.units.u3
assert(f1.following == 'u1' and f2.following == 'u2', 'each follows the car ahead')
local before = f1.followCalls
advance(ctx, insts, 10)
assert(f1.followCalls - before >= 4 and f1.followCalls - before <= 6, 'every two seconds: ' .. (f1.followCalls - before))
advance(ctx, insts, 90)
assert(ctx.events[1] == 'convoy:c:started' and ctx.events[2] == 'convoy:c:leg1' and ctx.events[3] == 'convoy:c:leg2' and ctx.events[4] == 'convoy:c:leg3' and ctx.events[5] == 'convoy:c:arrived', eventsText(ctx))
assert(#ctx.events == 5, eventsText(ctx))
assert(lead.toCalls[2].x == 600 and lead.toCalls[3].x == 900, 'one command per leg')
assert(lead.braked and f1.braked and f2.braked and game.unmounts == 1, 'the column stops and the copy gets out')
advance(ctx, insts, 30); assert(#ctx.events == 5, 'nothing after the arrival')
local checks = game.calls.driveLookup
advance(ctx, insts, 10); assert(game.calls.driveLookup == checks, 'a finished convoy reads nothing')
`));

test('convoy: lead cars, a spawned lead with a driver leads and needs no copy', () => withGame(`
local ctx = stageCtx('panam-palmer')
game.copy = nil
local insts = drive(ctx, {{p = 'convoy', id = 'c', route = {'s0', 'l1', 'camp'}, lead = 'cars', cars = 1, driver = 'Character.nomad'}})
game.v.pos = {x = 0, y = -30, z = 0}
advance(ctx, insts, 12)
assert(#game.spawns == 2 and game.spawns[1].driver == 'Character.nomad' and game.spawns[1].vehicle == nil, 'a lead with a driver, the default vehicle')
assert(game.calls.postCarMount == nil, 'no copy is seated')
advance(ctx, insts, 90)
assert(ctx:count('convoy:c:leg1') == 1 and ctx:count('convoy:c:leg2') == 1 and ctx:count('convoy:c:arrived') == 1, eventsText(ctx))
assert(game.unmounts == 0)
`));

test('convoy: a destroyed follower is lost-one once and the column goes on, a follower far behind for 20 seconds too, the lead lost is failed', () => withGame(`
${startColumn()}
advance(ctx, insts, 30)
game.units.u3.destroyed = true
advance(ctx, insts, 6)
assert(ctx:count('convoy:c:lost-one') == 1, eventsText(ctx))
advance(ctx, insts, 6); assert(ctx:count('convoy:c:lost-one') == 1, 'once')
assert(ctx:count('convoy:c:failed') == 0, 'the column goes on')
-- A follower left far behind: its driver is dead or it is stuck.
game.units.u2.blocked = true
advance(ctx, insts, 40)
assert(ctx:count('convoy:c:lost-one') == 2, 'the second one fell behind: ' .. eventsText(ctx))
advance(ctx, insts, 130)
assert(ctx:count('convoy:c:arrived') == 1 and ctx:count('convoy:c:failed') == 0, 'the lead still arrives: ' .. eventsText(ctx))
`));

test('convoy: a follower with a dead driver is lost-one, the lead destroyed is failed and the cars stop', () => withGame(`
${startColumn()}
advance(ctx, insts, 30)
game.units.u2.alive = false
advance(ctx, insts, 3)
assert(ctx:count('convoy:c:lost-one') == 1, eventsText(ctx))
game.units.u1.destroyed = true
advance(ctx, insts, 5)
assert(ctx:count('convoy:c:failed') == 1 and ctx:count('convoy:c:arrived') == 0, eventsText(ctx))
assert(game.units.u3.braked == true, 'the others stop')
advance(ctx, insts, 20); assert(ctx:count('convoy:c:failed') == 1)
`));

test('convoy: reroute replaces the legs still to drive, rerouted once, the numbering of the legs goes on', () => withGame(`
${startColumn(", reroute = {'alt1', 'alt2'}")}
advance(ctx, insts, 24)
assert(ctx:count('convoy:c:started') == 1)
advance(ctx, insts, 30)
assert(ctx:count('convoy:c:leg1') == 1, eventsText(ctx))
ctx:emit('convoy:c:reroute')
advance(ctx, insts, 4)
assert(ctx:count('convoy:c:rerouted') == 1, eventsText(ctx))
ctx:emit('convoy:c:reroute'); advance(ctx, insts, 2); assert(ctx:count('convoy:c:rerouted') == 1, 'once')
local lead = game.units.u1
local sent = lead.toCalls[#lead.toCalls]
assert(sent.x == 600 and sent.y == 300, 'the lead heads for the first rerouted place: ' .. sent.x .. ',' .. sent.y)
advance(ctx, insts, 160)
assert(ctx:count('convoy:c:leg2') == 1 and ctx:count('convoy:c:leg3') == 1 and ctx:count('convoy:c:arrived') == 1, eventsText(ctx))
assert(lead.pos.y > 250, 'it went the other way')
assert(ctx:count('convoy:c:failed') == 0)
-- No reroute in the spec: the request is logged and nothing changes.
local c2 = stageCtx('panam-palmer')
game.units = {}; game.nextUnit = 1; game.spawns = {}
local i2 = drive(c2, {${column}}})
game.v.pos = {x = 0, y = -30, z = 0}
advance(c2, i2, 24)
c2:emit('convoy:c:reroute'); advance(c2, i2, 3)
assert(c2:count('convoy:c:rerouted') == 0 and logged('the stage has none'))
`));

test('convoy: holdLegs stops the column at a leg end until go, a reroute releases it, started is said once', () => withGame(`
${startColumn(", holdLegs = {0, 2}, reroute = {'alt1', 'alt2'}")}
advance(ctx, insts, 30)
assert(ctx:count('convoy:c:started') == 0 and (game.calls.driveTo or 0) == 0, 'held at the start: ' .. eventsText(ctx))
ctx:emit('convoy:c:go')
advance(ctx, insts, 90)
assert(ctx:count('convoy:c:leg2') == 1 and ctx:count('convoy:c:leg3') == 0 and ctx:count('convoy:c:started') == 1, eventsText(ctx))
advance(ctx, insts, 20)
assert(ctx:count('convoy:c:leg3') == 0, 'held at the end of leg 2')
assert(game.units.u1.braked == true)
ctx:emit('convoy:c:go')
advance(ctx, insts, 60)
assert(ctx:count('convoy:c:arrived') == 1 and ctx:count('convoy:c:started') == 1, eventsText(ctx))
-- A reroute also releases a hold.
local c2 = stageCtx('panam-palmer')
game.units = {}; game.nextUnit = 1; game.spawns = {}
local i2 = drive(c2, {${column}, holdLegs = {2}, reroute = {'alt1', 'alt2'}}})
game.v.pos = {x = 0, y = -30, z = 0}
advance(c2, i2, 150)
assert(c2:count('convoy:c:leg2') == 1 and c2:count('convoy:c:leg3') == 0, eventsText(c2))
c2:emit('convoy:c:reroute')
advance(c2, i2, 160)
assert(c2:count('convoy:c:rerouted') == 1 and c2:count('convoy:c:arrived') == 1, eventsText(c2))
`));

test('convoy: a car that cannot be made once is tried again, three seconds apart, up to five times', () => withGame(`
${startColumn()}
game.spawnFail = 2
advance(ctx, insts, 30)
assert(#game.spawns == 5, 'the lead failed twice, then three cars: ' .. #game.spawns)
assert(ctx:count('convoy:c:started') == 1 and ctx:count('convoy:c:failed') == 0, eventsText(ctx))
local c2 = stageCtx('panam-palmer')
game.units = {}; game.nextUnit = 1; game.spawns = {}; game.spawnFail = 99
local i2 = drive(c2, {${column}}})
advance(c2, i2, 40)
assert(#game.spawns == 5 and c2:count('convoy:c:failed') == 1 and c2:count('convoy:c:started') == 0, 'the lead could not be made five times: ' .. eventsText(c2))
`));

test('convoy: fallback, followers that cannot be made are removed, the lead goes on alone and says so, without fallback the convoy has failed', () => withGame(`
${startColumn(', fallback = true')}
game.spawnFail = 5; game.spawnFailAfter = 1
advance(ctx, insts, 40)
assert(ctx:count('convoy:c:fallback') == 1 and ctx:count('convoy:c:failed') == 0, eventsText(ctx))
assert(alive() == 1, 'only the lead is left: ' .. alive())
advance(ctx, insts, 120)
assert(ctx:count('convoy:c:started') == 1 and ctx:count('convoy:c:leg3') == 1 and ctx:count('convoy:c:arrived') == 1 and ctx:count('convoy:c:fallback') == 1, eventsText(ctx))
local c2 = stageCtx('panam-palmer')
game.units = {}; game.nextUnit = 1; game.spawns = {}; game.spawnFail = 5; game.spawnFailAfter = 1
local i2 = drive(c2, {${column}}})
game.v.pos = {x = 0, y = -30, z = 0}
advance(c2, i2, 40)
assert(c2:count('convoy:c:failed') == 1 and c2:count('convoy:c:fallback') == 0 and c2:count('convoy:c:started') == 0, eventsText(c2))
`));

test('convoy: fallback when a driver cannot get in, when the follow command is refused four times in a row, or when the spec has no driver record', () => withGame(`
-- Followers refuse the follow command.
${startColumn(', fallback = true')}
game.followAccepted = false
advance(ctx, insts, 30)
assert(ctx:count('convoy:c:fallback') == 1 and ctx:count('convoy:c:started') == 1, eventsText(ctx))
assert(alive() == 1)
advance(ctx, insts, 130)
assert(ctx:count('convoy:c:arrived') == 1, 'the lead goes on alone: ' .. eventsText(ctx))
game.followAccepted = true
-- A driver who never gets in.
game.units = {}; game.nextUnit = 1; game.spawns = {}
local c2 = stageCtx('panam-palmer')
game.copy = {profileKey = 'panam-palmer', kind = 'visitor', position = {x = 0, y = 0, z = 0}}
local i2 = drive(c2, {${column}, fallback = true}})
game.mountWorks = false
game.v.pos = {x = 0, y = -30, z = 0}
advance(c2, i2, 40)
assert(c2:count('convoy:c:fallback') == 1 and alive() == 1 and c2:count('convoy:c:started') == 1, eventsText(c2))
game.mountWorks = true
-- No driver record at all.
game.units = {}; game.nextUnit = 1; game.spawns = {}
local c3 = stageCtx('panam-palmer')
local i3 = drive(c3, {{p = 'convoy', id = 'n', route = {'s0', 'l1'}, fallback = true}})
advance(c3, i3, 20)
assert(c3:count('convoy:n:fallback') == 1 and c3:count('convoy:n:started') == 1 and logged('no driver record'), eventsText(c3))
local c4 = stageCtx('panam-palmer')
local i4 = drive(c4, {{p = 'convoy', id = 'm', route = {'s0', 'l1'}}})
advance(c4, i4, 5)
assert(c4:count('convoy:m:failed') == 1 and c4:count('convoy:m:started') == 0)
local c5 = stageCtx('panam-palmer')
local i5 = drive(c5, {{p = 'convoy', id = 'k', route = {'s0', 'l1'}, lead = 'cars'}})
advance(c5, i5, 5)
assert(c5:count('convoy:k:failed') == 1, 'a spawned lead needs a driver')
`));

test('convoy: a party copy cannot lead, a copy that is gone fails it, limitMinutes fails it, bad specs are not armed', () => withGame(`
game.copy = {profileKey = 'panam-palmer', kind = 'party', position = {x = 0, y = 0, z = 0}}
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {${column}}})
game.v.pos = {x = 0, y = -30, z = 0}
advance(ctx, insts, 5)
assert(ctx:count('convoy:c:failed') == 1 and #game.spawns == 0, eventsText(ctx))
game.copy = nil; game.units = {}; game.nextUnit = 1
local c2 = stageCtx('panam-palmer')
local i2 = drive(c2, {${column}}})
advance(c2, i2, 33)
assert(c2:count('convoy:c:failed') == 1, 'never seen: ' .. eventsText(c2))
game.copy = {profileKey = 'panam-palmer', kind = 'visitor', position = {x = 0, y = 0, z = 0}}; game.units = {}; game.nextUnit = 1; game.spawns = {}
local c3 = stageCtx('panam-palmer')
local i3 = drive(c3, {${column}, limitMinutes = 5}})
advance(c3, i3, 20)
assert(c3:count('convoy:c:started') == 1)
game.units.u1.blocked = true
advance(c3, i3, 15)
assert(c3:count('convoy:c:failed') == 1, eventsText(c3))
local c4 = stageCtx('panam-palmer')
assert(#drive(c4, {{p = 'convoy', route = {'s0', 'l1'}}, {p = 'convoy', id = 'a', route = {'s0'}}, {p = 'convoy', id = 'b', route = {'s0', 'nowhere'}}}) == 0)
local ok = drive(c4, {{p = 'convoy', id = 'r', route = {'s0', 'l1'}, reroute = {'nowhere'}, driver = 'Character.x'}})
assert(#ok == 1 and logged('the reroute is dropped'))
`));

test('convoy: the lead stuck on a leg is sent the command again and then the convoy has failed', () => withGame(`
${startColumn()}
advance(ctx, insts, 20)
game.units.u1.blocked = true
local before = game.calls.driveTo
advance(ctx, insts, 20)
assert(game.calls.driveTo > before and ctx:count('convoy:c:failed') == 0, 'sent again: ' .. (game.calls.driveTo - before))
advance(ctx, insts, 40)
assert(ctx:count('convoy:c:failed') == 1, eventsText(ctx))
`));

test('convoy: one reap deletes every car and driver, the copy gets out first, nothing is made after it', () => withGame(`
${startColumn()}
advance(ctx, insts, 24)
assert(#ctx.tracked == 3 and alive() == 3)
ctx:reap()
assert(#ctx.tracked == 0 and alive() == 0 and #game.deletes == 3 and game.unmounts == 1)
local spawns = #game.spawns
advance(ctx, insts, 20); assert(#game.spawns == spawns, 'nothing after the reap')
-- A reap before the column is made leaves nothing.
local c2 = stageCtx('panam-palmer')
local i2 = drive(c2, {${column}}})
game.v.pos = {x = 800, y = 0, z = 0}
advance(c2, i2, 5); c2:reap()
assert(#game.spawns == spawns)
`));

test('convoy: the cost stays bounded over a simulated minute', () => withGame(`
${startColumn()}
advance(ctx, insts, 60)
local c = game.calls
assert(c.driveLookup <= 3 * 62 + 10, 'one lookup of each car a second: ' .. c.driveLookup)
assert(c.driveFollowCar <= 2 * 31 + 2, 'each follower every two seconds: ' .. c.driveFollowCar)
assert(c.driveTo <= 6, 'a command per leg: ' .. c.driveTo)
assert(c.copyOf <= 12, 'the copy is read while the column is made: ' .. c.copyOf)
local total = 0
for _, n in pairs(c) do total = total + n end
assert(total <= 60 * 14, 'in all: ' .. total)
`));

// ---- with the real quest module: its ctx, timers, listeners and rows ------------------------------------------------------------------------------------------------------

const playHarness = `
local Lines = ${load('quest-lines.lua')}
local Play = ${load('quest-play.lua')}
local files = {}
local clock = function() return game.now end
local play
local lines = Lines.new({clock = clock, gameTime = function() return game.gameClock end, log = log, busy = function() return false end,
  start = function(entry) return 'r' end, subtitle = function() end, phone = function() return true end,
  emit = function(pack, name) play.emitPack(pack, name) end, onChange = function() play.rearm() end})
play = Play.new({enabled = function() return true end, clock = clock, gameTime = function() return game.gameClock end,
  read = function(path) return files[path] end, write = function(path, text) files[path] = text; return true end,
  encode = serialize, decode = decode, places = places, lines = lines, prims = prims, session = 's', log = log})
local function step(seconds)
  for _ = 1, math.floor(seconds * 10 + 0.5) do
    game.now = game.now + 0.1; game.gameClock = game.gameClock + 0.1 * game.rate; game.tick = game.tick + 1
    if game.v.target then game.v.pos = stepTo(game.v.pos, game.v.target, game.v.speed * 0.1) end
    for _, u in pairs(game.units) do
      if not u.attached and not u.deleted and game.now >= u.attachAt then u.attached = true end
      if u.attached and not u.deleted and canMove(u) and u.target then
        u.pos = stepTo(u.pos, u.target, (u.maxSpeed or 10) * 0.1)
        if math.sqrt((u.target.x - u.pos.x) ^ 2 + (u.target.y - u.pos.y) ^ 2) < 0.5 then u.target = nil end
      end
    end
    play.update('V', 0.1)
  end
end
local function quest(serial, doList, script)
  return {pack = 'race-pack', character = 'jackie-welles', stage = 'race' .. serial, serial = serial, since = 99990,
    places = {line = {x = 0, y = 0, z = 0, radius = 25}, finish = {x = 1000, y = 0, z = 0, radius = 30}},
    ['do'] = doList, script = script, lines = {}, gaps = {}}
end
local function setFile(q) files[Play.PLAY] = serialize({version = 1, revision = serial, quests = {q}}) end
local function names()
  local list = {}
  for _, e in ipairs(files[Play.EVENTS] and decode(files[Play.EVENTS]).events or {}) do list[#list + 1] = e.name end
  return table.concat(list, ' ')
end
`;
const withPlay = code => run(`${harness}\n${playHarness}\n${code}\nassert(not game.stale, 'a handle was kept across ticks')`);

test('the real quest module: a race armed from a play file runs on the stage events, a row answers the result, a stage change reaps her car', () => withPlay(`
game.v.pos = {x = 0, y = -20, z = 0}
setFile(quest(1, {{p = 'race', id = 'r', from = 'line', to = 'finish'}},
  {{when = 'stage:enter', event = 'race:r:go'}, {when = 'race:r:won', event = 'row:won'}, {when = 'race:r:lost', event = 'row:lost'}}))
assert(play.restore() == true)
game.v.speed = 40; game.v.target = {x = 1000, y = 0, z = 0}
step(60)
local text = names()
assert(text:find('stage:enter', 1, true) and text:find('race:r:started', 1, true) and text:find('race:r:won', 1, true) and text:find('row:won', 1, true), text)
assert(not text:find('row:lost', 1, true) and #game.spawns == 1 and game.spawns[1].tag == 'CyberpunkConvaiQuest:race-pack')
for id, u in pairs(game.units) do assert(not u.deleted, id) end
setFile(quest(2, {}, {}))
play.onPlayRevision()
for id, u in pairs(game.units) do assert(u.deleted, id .. ' removed with the stage') end
local reads = game.calls.raceRead
step(10); assert(game.calls.raceRead == reads, 'a reaped stage reads nothing')
`));

test('the real quest module: a convoy armed from a play file reports its legs and a reroute row, a stage change reaps the column', () => withPlay(`
game.copy = {profileKey = 'jackie-welles', kind = 'visitor', position = {x = 0, y = 0, z = 0}}
game.v.pos = {x = 0, y = -30, z = 0}
local q = quest(1, {{p = 'convoy', id = 'c', route = {'line', 'finish'}, driver = 'Character.nomad'}}, {{when = 'convoy:c:leg1', event = 'row:leg'}, {when = 'convoy:c:arrived', event = 'row:arrived'}})
setFile(q)
assert(play.restore() == true)
step(120)
local text = names()
assert(text:find('convoy:c:started', 1, true) and text:find('convoy:c:leg1', 1, true) and text:find('row:leg', 1, true) and text:find('convoy:c:arrived', 1, true) and text:find('row:arrived', 1, true), text)
assert(#game.spawns == 3)
setFile(quest(2, {}, {}))
play.onPlayRevision()
for id, u in pairs(game.units) do assert(u.deleted, id .. ' removed with the stage') end
`));

// ---- the natives and the module text -------------------------------------------------------------------------------------------------------------------------------

const natives = `
local Native = ${load('quest-world-race.lua')}
local entities, mounts = {}, {}
local function entity(key, x, y, z)
  local e = {key = key, x = x or 0, y = y or 0, z = z or 0, attached = true, sent = {}}
  function e:IsAttached() return self.attached end
  function e:GetWorldPosition() return {x = self.x, y = self.y, z = self.z} end
  function e:GetAIComponent() local me = self; return {SendCommand = function(_, command) me.sent[#me.sent + 1] = command; return me.accept ~= false end} end
  return e
end
local playerEntity = entity('player', 1, 2, 3)
local broken = false
Game = {
  GetPlayer = function() if broken then error('the game said no') end return playerEntity end,
  GetMountingFacility = function() return {GetMountingInfoSingleWithObjects = function(_, e)
    local m = mounts[e.key]
    if not m then return {parentId = {hash = 0}, slotId = {id = 'None'}} end
    return {parentId = {hash = m.parent}, slotId = {id = m.seat}}
  end} end,
  FindEntityByID = function(id) return entities[id.hash] end,
}
NameToString = function(v) return tostring(v) end
NewObject = function() local c = {}; function c:Copy() return self end; return c end
local W = Native.new({})
`;
const withNatives = code => run(`${base}\n${natives}\n${code}`);

test('natives: raceRead says whether V drives and where the vehicle is, V on foot reads V, a game that refuses is an error the caller catches', () => withNatives(`
local r = W.raceRead()
assert(r.mounted == false and r.driving == false and r.at.x == 1 and r.at.y == 2)
entities[7001] = entity('car', 100, 200, 5)
mounts.player = {parent = 7001, seat = 'seat_front_left'}
r = W.raceRead(); assert(r.mounted and r.driving and r.at.x == 100 and r.at.y == 200)
mounts.player.seat = 'seat_back_left'
r = W.raceRead(); assert(r.mounted and not r.driving, 'a passenger does not drive')
entities[7001].attached = false
r = W.raceRead(); assert(r.mounted and r.at.x == 1, 'a car that is not found: V is the position')
broken = true
assert(not pcall(W.raceRead))
`));

test('natives: driveFollowCar needs both cars attached and sends the follow command aimed at the car ahead', () => withNatives(`
local mine, ahead = entity('f', 10, 0, 0), entity('a', 30, 0, 0)
entities[11], entities[12] = mine, ahead
local h, a = {entityID = {hash = 11}}, {entityID = {hash = 12}}
assert(W.driveFollowCar(h, a, 15) == true)
local c = mine.sent[1]
assert(c.target == ahead and c.distanceMin == 15 and c.distanceMax == 27 and c.needDriver == true and c.stopWhenTargetReached == false)
assert(W.driveFollowCar(h, a) == true and mine.sent[2].distanceMin == 12, 'a default gap')
ahead.attached = false
assert(W.driveFollowCar(h, a, 15) == false, 'the car ahead is not attached')
ahead.attached = true; mine.accept = false
assert(W.driveFollowCar(h, a, 15) == false, 'a refused command')
assert(W.driveFollowCar(nil, a) == false and W.driveFollowCar(h, nil) == false)
`));

test('the modules are plain Lua 5.1 with no semicolon or dash in a comment, name no other mod and have no per-frame hook', () => {
  for (const name of ['quest-prims-race.lua', 'quest-world-race.lua']) {
    const text = source(name);
    assert.ok(!/\bgoto\b|table\.unpack|bit32|\/\/|~=\s*nil\s*\?/.test(text.replace(/--.*$/gm, '')), name + ' uses a newer Lua form');
    for (const line of text.split('\n')) {
      const at = line.indexOf('--');
      if (at >= 0) {
        const comment = line.slice(at + 2);
        assert.ok(!comment.includes(';') && !/(^|[^-])--([^-]|$)/.test(comment), name + ': no semicolon or double hyphen in a comment: ' + line);
      }
      assert.ok(!/[\u2013\u2014]/.test(line), name + ': no en or em dash: ' + line);
    }
    assert.ok(!/\bAMM\b|reference-amm|Night City Allies|codeware|TweakXL/i.test(text), name + ' names another mod');
    assert.ok(!/onUpdate|GameSession|\bonDraw\b/.test(text), name + ' has no per-frame hook');
  }
});
