// The DRIVE group of bond quest primitives, the game half (mod/quest-prims-drive.lua and its natives mod/quest-world-drive.lua, docs/QUEST_PRIMITIVES.md,
// BOND_QUESTS.md section 21): ride, post, remote, runner, tail and check. Run on a fake game: a clock, a game clock, a world of positions whose rows die at every
// tick (the test fails if a module keeps one), cars and pedestrians that move toward the target of their last command. Nothing here starts the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, load, source, base, fakeCtx} from './quest-lua-fixture.mjs';

const harness = `
local Places = ${load('quest-places.lua')}
local Prims = ${load('quest-prims.lua')}
local Drive = ${load('quest-prims-drive.lua')}
${base}
${fakeCtx}
local game = {now = 0, gameClock = 100000, rate = 30, tick = 0, vpos = {x = 0, y = 0, z = 0}, stale = false, calls = {},
  ride = {mounted = true, driving = true, vehicleId = 'car1', at = {x = 0, y = 0, z = 0}, copy = 'aboard'}, rideFails = false,
  copy = nil, heat = 0, hour = 12, weather = 'clear', song = {playing = false}, gear = nil, items = {}, readFails = false,
  units = {}, nextUnit = 1, spawnFail = 0, mountWorks = true, driveAccepted = true, autoAttach = true, deletes = {}, spawns = {},
  remoteSupported = true, hold = nil, holdReleased = 0, postCar = {mounted = false}, walks = 0, holds = 0, stances = {}, fights = 0, fightTaken = false, mounts = {}}
-- A row of the world is good for the tick it was made in: using it later is the mistake this fake exists to catch.
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
  playerPosition = counted('playerPosition', function() return fresh(game.vpos) end),
  copyOf = counted('copyOf', function(key)
    if not game.copy or game.copy.profileKey ~= key then return nil end
    return fresh({kind = game.copy.kind, serial = 7, position = fresh(game.copy.position)})
  end),
  rayDown = function() return nil end,
  rideRead = counted('rideRead', function(key)
    if game.rideFails then error('the mounting facility is not ready') end
    local r = game.ride
    return fresh({mounted = r.mounted, driving = r.driving, vehicleId = r.vehicleId, at = fresh(r.at), copy = r.copy})
  end),
  readHeat = counted('readHeat', function() if game.readFails then error('no heat') end return game.heat end),
  readHour = counted('readHour', function() if game.readFails then error('no clock') end return game.hour, 0 end),
  readWeather = counted('readWeather', function() if game.readFails then error('no weather') end return game.weather end),
  readSong = counted('readSong', function() if game.readFails then error('no radio') end return game.song end),
  readGear = counted('readGear', function() if game.readFails then error('no gear') end return game.gear end),
  readItem = counted('readItem', function(id) if game.readFails then error('no items') end return game.items[id] end),
  remoteHold = counted('remoteHold', function(fn)
    if not game.remoteSupported then return nil end
    game.hold = fn
    return function() game.holdReleased = game.holdReleased + 1; game.hold = nil end
  end),
  postWalk = counted('postWalk', function(serial, target, gait) game.walks = game.walks + 1; game.walkTarget = plainOf(target); return true end),
  postHold = counted('postHold', function(serial) game.holds = game.holds + 1; return true end),
  postStance = counted('postStance', function(serial, stance) game.stances[#game.stances + 1] = stance; return true end),
  postFight = counted('postFight', function(serial, on) game.fights = game.fights + 1; return game.fightTaken end),
  postCarMount = counted('postCarMount', function(serial, handle, unmount)
    game.mounts[#game.mounts + 1] = unmount and 'out' or 'in'
    if not unmount and game.postCar.mountWorks then game.postCar.mounted = true end
    if unmount then game.postCar.mounted = false end
    return true
  end),
  postCarMounted = counted('postCarMounted', function() return game.postCar.mounted end),
  behindPlayer = counted('behindPlayer', function(m) return fresh({x = game.vpos.x - m, y = game.vpos.y, z = game.vpos.z, yaw = 90}) end),
  driveSpawn = counted('driveSpawn', function(req)
    game.spawns[#game.spawns + 1] = req
    if game.spawnFail > 0 then game.spawnFail = game.spawnFail - 1; return nil, 'The game could not create the car.' end
    local u = {id = 'u' .. game.nextUnit, kind = req.kind, req = req, attached = false, driverIn = false, alive = true, pos = {x = req.x, y = req.y, z = req.z},
      attachAt = game.now + 2, mountCalls = 0, toCalls = {}, followCalls = 0}
    game.nextUnit = game.nextUnit + 1
    game.units[u.id] = u
    return {id = u.id}
  end),
  driveLookup = counted('driveLookup', function(h)
    local u = game.units[h.id]
    if not u or u.deleted or not u.attached then return fresh({attached = false}) end
    return fresh({attached = true, position = fresh(u.pos), driverIn = u.driverIn, alive = u.alive})
  end),
  driveMountDriver = counted('driveMountDriver', function(h)
    local u = game.units[h.id]; u.mountCalls = u.mountCalls + 1
    if game.mountWorks then u.driverIn = true end
    return true
  end),
  driveTo = counted('driveTo', function(h, target, speed)
    local u = game.units[h.id]
    u.toCalls[#u.toCalls + 1] = plainOf(target); u.target = plainOf(target); u.maxSpeed = speed
    return game.driveAccepted
  end),
  driveFollow = counted('driveFollow', function(h, gap) local u = game.units[h.id]; u.followCalls = u.followCalls + 1; u.gap = gap; return true end),
  driveBrake = counted('driveBrake', function(h) local u = game.units[h.id]; u.braked = true; u.target = nil; return true end),
  driveDelete = counted('driveDelete', function(h) local u = game.units[h.id]; u.deleted = true; game.deletes[#game.deletes + 1] = h.id; return true end),
}
local places = Places.new({world = world, clock = function() return game.now end, log = log})
local prims = Prims.new({places = places, world = world, clock = function() return game.now end, gameTime = function() return game.gameClock end, log = log})
assert(prims.extend(Drive), 'the drive group installs')
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
local function advance(ctx, insts, seconds)
  for _ = 1, seconds do
    game.now = game.now + 1; game.gameClock = game.gameClock + game.rate; game.tick = game.tick + 1
    for _, u in pairs(game.units) do
      if not u.attached and not u.deleted and game.autoAttach and game.now >= u.attachAt then u.attached = true end
      if u.attached and not u.deleted and u.target and not u.blocked then
        local dx, dy = u.target.x - u.pos.x, u.target.y - u.pos.y
        local d = math.sqrt(dx * dx + dy * dy)
        local step = math.min(d, u.maxSpeed or 10)
        if d > 0.001 then u.pos = {x = u.pos.x + dx / d * step, y = u.pos.y + dy / d * step, z = u.pos.z} end
        if d <= (u.maxSpeed or 10) then u.target = nil end
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
  local ctx = newCtx('pk', character)
  ctx.places = {start = {x = 0, y = 0, z = 0, radius = 25}, cp1 = {x = 500, y = 0, z = 0, radius = 30}, cp2 = {x = 1000, y = 0, z = 0, radius = 30},
    dest = {x = 1500, y = 0, z = 0, radius = 30}, spot = {x = 40, y = 0, z = 0, radius = 2}, zone = {x = 2000, y = 0, z = 0, radius = 60},
    a = {x = 0, y = 300, z = 0, radius = 20}, b = {x = 200, y = 300, z = 0, radius = 20}, c = {x = 400, y = 300, z = 0, radius = 20}}
  return ctx
end
local function has(ctx, name) return ctx:count(name) > 0 end
local function eventsText(ctx) return table.concat(ctx.events, ',') end
`;
const withGame = code => run(`${harness}\n${code}\nassert(not game.stale, 'a handle was kept across ticks')`);

test('ride: no event before the copy is aboard and V drives, then ride:started once', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'ride', to = 'dest', checkpoints = {'cp1'}}})
assert(#insts == 1)
game.ride.copy = 'outside'
advance(ctx, insts, 30); assert(#ctx.events == 0, eventsText(ctx))
game.ride.copy = 'aboard'; game.ride.driving = false
advance(ctx, insts, 30); assert(#ctx.events == 0, 'V does not drive: ' .. eventsText(ctx))
game.ride.driving = true
advance(ctx, insts, 3); assert(ctx:count('ride:started') == 1 and #ctx.events == 1, eventsText(ctx))
advance(ctx, insts, 10); assert(ctx:count('ride:started') == 1)
assert(game.calls.rideRead >= 60 and game.calls.rideRead <= 80, 'one sample a second: ' .. game.calls.rideRead)
`));

test('ride: the checkpoints in order, then arrived once, a place driven out of order does not count, a step across a place counts', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'ride', to = 'dest', checkpoints = {'cp1', 'cp2'}}})
advance(ctx, insts, 2)
game.ride.at = {x = 1000, y = 0, z = 0}; advance(ctx, insts, 2)
assert(ctx:count('ride:checkpoint:cp2') == 0 and ctx:count('ride:arrived') == 0, 'cp2 before cp1 is no checkpoint: ' .. eventsText(ctx))
game.ride.at = {x = 1500, y = 0, z = 0}; advance(ctx, insts, 2)
assert(ctx:count('ride:arrived') == 0, 'the destination before the checkpoints is not an arrival')
game.ride.at = {x = 450, y = 0, z = 0}; advance(ctx, insts, 1)
game.ride.at = {x = 560, y = 0, z = 0}; advance(ctx, insts, 1)   -- crossed cp1 between two samples
assert(ctx:count('ride:checkpoint:cp1') == 1, eventsText(ctx))
game.ride.at = {x = 1000, y = 0, z = 0}; advance(ctx, insts, 1)
game.ride.at = {x = 1495, y = 0, z = 0}; advance(ctx, insts, 1)
assert(ctx.events[1] == 'ride:started' and ctx.events[2] == 'ride:checkpoint:cp1' and ctx.events[3] == 'ride:checkpoint:cp2' and ctx.events[4] == 'ride:arrived', eventsText(ctx))
advance(ctx, insts, 20); assert(#ctx.events == 4, 'nothing after the arrival')
`));

test('ride: a jump of the car (a load) is not a drive through a place, the copy must be aboard for an arrival', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'ride', to = 'dest', checkpoints = {'cp1'}}})
advance(ctx, insts, 2)
game.ride.at = {x = 100, y = 0, z = 0}; advance(ctx, insts, 1)
game.ride.at = {x = 900, y = 0, z = 0}; advance(ctx, insts, 1)    -- 800 m in a second: a jump over cp1
assert(ctx:count('ride:checkpoint:cp1') == 0, eventsText(ctx))
game.ride.at = {x = 500, y = 0, z = 0}; game.ride.copy = 'outside'; advance(ctx, insts, 2)
assert(ctx:count('ride:checkpoint:cp1') == 0, 'the copy is out of the car')
game.ride.copy = 'aboard'; advance(ctx, insts, 1)
assert(ctx:count('ride:checkpoint:cp1') == 1)
`));

test('ride: limitMinutes in game minutes from the start is ride:timeout once, with no game clock it falls back to the real clock', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'ride', to = 'dest', limitMinutes = 10}})
advance(ctx, insts, 2)
advance(ctx, insts, 15); assert(ctx:count('ride:timeout') == 0, '600 game seconds are 20 s at 30 to 1')
advance(ctx, insts, 8); assert(ctx:count('ride:timeout') == 1, eventsText(ctx))
advance(ctx, insts, 30); assert(ctx:count('ride:timeout') == 1 and ctx:count('ride:arrived') == 0)
local bare = Prims.new({places = places, world = world, clock = function() return game.now end, log = log})
assert(bare.extend(Drive))
local c2 = stageCtx('panam-palmer')
local state = bare.get('ride').arm(c2, {p = 'ride', to = 'dest', limitMinutes = 2}, bare.env)
local inst = {{def = bare.get('ride'), spec = {}, state = state, nextAt = 0}}
advance(c2, inst, 3); assert(c2:count('ride:started') == 1)
advance(c2, inst, 1); assert(c2:count('ride:timeout') == 0)
advance(c2, inst, 2); assert(c2:count('ride:timeout') == 1, 'two game minutes are four real seconds')
`));

test('ride: heat true ends it with ride:failed-heat within two seconds of a wanted level, heat off never reads it', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'ride', to = 'dest', heat = true}})
advance(ctx, insts, 10); assert(ctx:count('ride:failed-heat') == 0)
local reads = game.calls.readHeat
assert(reads >= 4 and reads <= 6, 'every two seconds: ' .. reads)
game.heat = 2; advance(ctx, insts, 3)
assert(ctx:count('ride:failed-heat') == 1, eventsText(ctx))
advance(ctx, insts, 10); assert(ctx:count('ride:failed-heat') == 1 and ctx:count('ride:abandoned') == 0)
local quiet = stageCtx('panam-palmer')
local more = drive(quiet, {{p = 'ride', to = 'dest'}})
local before = game.calls.readHeat
game.heat = 5; advance(quiet, more, 10)
assert(game.calls.readHeat == before and quiet:count('ride:failed-heat') == 0, 'a ride with no heat rule never reads the heat')
`));

test('ride: abandoned when the copy is out of the car for 20 s or V does not drive for 120 s, a short step out is forgiven', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'ride', to = 'dest'}})
advance(ctx, insts, 2)
game.ride.copy = 'outside'; advance(ctx, insts, 15); game.ride.copy = 'aboard'; advance(ctx, insts, 30)
assert(ctx:count('ride:abandoned') == 0, 'she got back in')
game.ride.copy = 'gone'; advance(ctx, insts, 18); assert(ctx:count('ride:abandoned') == 0)
advance(ctx, insts, 5); assert(ctx:count('ride:abandoned') == 1, eventsText(ctx))
advance(ctx, insts, 200); assert(ctx:count('ride:abandoned') == 1 and ctx:count('ride:timeout') == 0)
local c2 = stageCtx('panam-palmer')
game.ride.copy = 'aboard'
local more = drive(c2, {{p = 'ride', to = 'dest'}})
advance(c2, more, 2)
game.ride.mounted, game.ride.driving = false, false
advance(c2, more, 100); game.ride.mounted, game.ride.driving = true, true; advance(c2, more, 5)
assert(c2:count('ride:abandoned') == 0, 'V stepped out for a while and came back')
game.ride.mounted, game.ride.driving = false, false
advance(c2, more, 119); assert(c2:count('ride:abandoned') == 0)
advance(c2, more, 4); assert(c2:count('ride:abandoned') == 1, eventsText(c2))
`));

test('ride: a read that fails is no abandonment, bad specs are not armed and logged', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'ride', to = 'dest'}})
advance(ctx, insts, 2); assert(ctx:count('ride:started') == 1)
game.rideFails = true
advance(ctx, insts, 300); assert(#ctx.events == 1, 'a failing read changes nothing: ' .. eventsText(ctx))
game.rideFails = false
local bad = drive(ctx, {{p = 'ride', to = 'nowhere'}, {p = 'ride', to = 'dest', checkpoints = {'cp1', 'lost'}}, {p = 'ride', to = 'dest', checkpoints = 'cp1'}, {p = 'ride'}})
assert(#bad == 0 and logged('ride: place nowhere is not in the stage') and logged('checkpoint lost'))
`));

test('post: the copy walks to the spot, holds it, post:<id>:set once, the walk is sent again, the hold is renewed', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'post', id = 'roof', at = 'spot', stance = 'stand'}, {p = 'post', id = 'bad', at = 'nowhere'}, {p = 'post', at = 'spot'}, {p = 'post', id = 'x', at = 'spot', stance = 'swim'}})
assert(#insts == 1)
game.copy = {profileKey = 'panam-palmer', kind = 'visitor', position = {x = 0, y = 0, z = 0}}
advance(ctx, insts, 2); assert(game.walks == 1 and game.walkTarget.x == 40 and #ctx.events == 0)
advance(ctx, insts, 10); assert(game.walks == 2, 'the walk is sent again every eight seconds: ' .. game.walks)
game.copy.position = {x = 39, y = 0.5, z = 0}
advance(ctx, insts, 2); assert(ctx:count('post:roof:set') == 1 and game.holds == 1, eventsText(ctx))
advance(ctx, insts, 70); assert(ctx:count('post:roof:set') == 1 and game.holds >= 3 and game.holds <= 4, 'renewed about every 30 s: ' .. game.holds)
assert(#game.stances == 0 and ctx:count('post:roof:lost') == 0)
`));

test('post: prone asks for the stance, a party copy and a copy that is gone are lost, lost once', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'post', id = 'low', at = 'spot', stance = 'prone'}})
game.copy = {profileKey = 'panam-palmer', kind = 'visitor', position = {x = 40, y = 0, z = 0}}
advance(ctx, insts, 3); assert(ctx:count('post:low:set') == 1 and game.stances[1] == 'prone')
game.copy = nil
advance(ctx, insts, 3); assert(ctx:count('post:low:lost') == 0, 'one miss is not enough')
advance(ctx, insts, 4); assert(ctx:count('post:low:lost') == 1, eventsText(ctx))
advance(ctx, insts, 10); assert(ctx:count('post:low:lost') == 1)
local c2 = stageCtx('panam-palmer')
local more = drive(c2, {{p = 'post', id = 'p', at = 'spot'}})
game.copy = {profileKey = 'panam-palmer', kind = 'party', position = {x = 40, y = 0, z = 0}}
advance(c2, more, 3); assert(c2:count('post:p:lost') == 1 and c2:count('post:p:set') == 0 and logged('party'))
local c3 = stageCtx('panam-palmer')
local third = drive(c3, {{p = 'post', id = 'never', at = 'spot'}})
game.copy = nil
advance(c3, third, 29); assert(c3:count('post:never:lost') == 0)
advance(c3, third, 4); assert(c3:count('post:never:lost') == 1, 'never found for 30 s')
`));

test('post: a copy that never reaches the spot is lost after the walk times out, a copy pushed away is walked back and then lost', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'post', id = 'far', at = 'spot'}})
game.copy = {profileKey = 'panam-palmer', kind = 'visitor', position = {x = 0, y = 0, z = 0}}
advance(ctx, insts, 100); assert(ctx:count('post:far:lost') == 1 and game.walks <= 8, 'walks ' .. game.walks)
local c2 = stageCtx('panam-palmer')
local more = drive(c2, {{p = 'post', id = 'push', at = 'spot'}})
game.copy.position = {x = 40, y = 0, z = 0}
advance(c2, more, 3); assert(c2:count('post:push:set') == 1)
local walks = game.walks
for _ = 1, 3 do
  game.copy.position = {x = 80, y = 0, z = 0}; advance(c2, more, 4)
  assert(c2:count('post:push:lost') == 0, 'walked back')
  game.copy.position = {x = 40, y = 0, z = 0}; advance(c2, more, 4)
end
assert(game.walks == walks + 3 and c2:count('post:push:set') == 1, 'walked back three times, set is told once')
game.copy.position = {x = 80, y = 0, z = 0}; advance(c2, more, 6)
assert(c2:count('post:push:lost') == 1, eventsText(c2))
`));

test('post: the release event frees the copy once, fightFrom asks companion tactics on post:<id>:fight and tells it when they take it', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'post', id = 'ow', at = 'spot', release = 'stage:go', fightFrom = true}})
game.copy = {profileKey = 'panam-palmer', kind = 'visitor', position = {x = 40, y = 0, z = 0}}
advance(ctx, insts, 3); assert(ctx:count('post:ow:set') == 1)
ctx:emit('post:ow:fight')
assert(game.fights == 1 and ctx:count('post:ow:fighting') == 0 and logged('cannot fight from a post yet'), 'tactics did not take it')
local holds = game.holds
advance(ctx, insts, 60); assert(game.holds == holds, 'a fighting copy is not held any more')
ctx:emit('post:ow:fight'); assert(game.fights == 1, 'asked once')
local c2 = stageCtx('panam-palmer')
local more = drive(c2, {{p = 'post', id = 'ow2', at = 'spot', fightFrom = true, release = 'stage:go'}})
game.fightTaken = true
advance(c2, more, 3); c2:emit('post:ow2:fight'); assert(c2:count('post:ow2:fighting') == 1)
c2:emit('stage:go'); c2:emit('stage:go')
assert(c2:count('post:ow2:released') == 1)
local h = game.holds; advance(c2, more, 60); assert(game.holds == h and c2:count('post:ow2:lost') == 0, 'a released post is left alone')
local c3 = stageCtx('panam-palmer')
local third = drive(c3, {{p = 'post', id = 'plain', at = 'spot'}})
c3:emit('post:plain:fight'); assert(game.fights == 2, 'no fightFrom, no fight')
`));

test('post: stance car puts a tagged car at the spot when V is near, mounts the copy and checks the seat, release gets her out, the ctx removes the car', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'post', id = 'car', at = 'spot', stance = 'car', vehicle = 'Vehicle.v_test', release = 'stage:go'}})
game.copy = {profileKey = 'panam-palmer', kind = 'visitor', position = {x = 40, y = 0, z = 0}}
game.vpos = {x = 500, y = 0, z = 0}
advance(ctx, insts, 6); assert(#game.spawns == 0, 'V is 460 m away')
game.vpos = {x = 100, y = 0, z = 0}
advance(ctx, insts, 4); assert(#game.spawns == 1 and game.spawns[1].tag == 'CyberpunkConvaiQuest:pk' and game.spawns[1].vehicle == 'Vehicle.v_test' and game.spawns[1].driver == nil and game.spawns[1].x == 40)
game.postCar.mountWorks = false
advance(ctx, insts, 40); assert(ctx:count('post:car:set') == 0 and #game.mounts <= 3 and ctx:count('post:car:lost') == 1, 'mounted ' .. #game.mounts .. ' ' .. eventsText(ctx))
game.postCar.mountWorks = true
local c2 = stageCtx('panam-palmer')
game.postCar = {mounted = false, mountWorks = true}; game.mounts = {}
local more = drive(c2, {{p = 'post', id = 'ok', at = 'spot', stance = 'car', release = 'stage:go'}})
advance(c2, more, 12); assert(c2:count('post:ok:set') == 1, eventsText(c2) .. ' mounts ' .. #game.mounts)
game.postCar.mounted = false
advance(c2, more, 7); assert(c2:count('post:ok:lost') == 1, 'she left the car: ' .. eventsText(c2))
local c3 = stageCtx('panam-palmer')
game.postCar = {mounted = false, mountWorks = true}
local third = drive(c3, {{p = 'post', id = 'rel', at = 'spot', stance = 'car', release = 'stage:go'}})
advance(c3, third, 12); assert(c3:count('post:rel:set') == 1)
c3:emit('stage:go'); assert(game.mounts[#game.mounts] == 'out' and c3:count('post:rel:released') == 1)
local live = 0
for id, u in pairs(game.units) do if not u.deleted then live = live + 1 end end
assert(live >= 3)
c3:reap(); c2:reap(); ctx:reap()
for id, u in pairs(game.units) do assert(u.deleted, id .. ' is removed') end
`));

test('remote: the dead zone holds remote lines while V is inside, delivers them after, and says so', () => withGame(`
-- A tiny line queue that honours the hold, as the lines module will once it has the hook.
local queue, delivered = {}, {}
local function pump() if game.hold and game.hold() then return end while #queue > 0 do delivered[#delivered + 1] = table.remove(queue, 1) end end
local ctx = stageCtx('songbird')
local insts = drive(ctx, {{p = 'remote', deadZone = 'zone'}})
assert(#insts == 1 and game.hold ~= nil and not game.hold())
game.vpos = {x = 100, y = 0, z = 0}
advance(ctx, insts, 20); assert(#ctx.events == 0)
queue[#queue + 1] = 'before'; pump(); assert(#delivered == 1)
game.vpos = {x = 1990, y = 0, z = 0}
advance(ctx, insts, 2); assert(ctx:count('remote:silenced') == 1 and game.hold())
queue[#queue + 1] = 'inside.1'; queue[#queue + 1] = 'inside.2'; pump(); assert(#delivered == 1, 'held while inside')
advance(ctx, insts, 5); assert(ctx:count('remote:silenced') == 1)
game.vpos = {x = 2050, y = 0, z = 0}; advance(ctx, insts, 2)
assert(ctx:count('remote:resumed') == 0, 'hysteresis: just outside the radius is still inside the way out')
game.vpos = {x = 2100, y = 0, z = 0}; advance(ctx, insts, 2)
assert(ctx:count('remote:resumed') == 1 and not game.hold(), eventsText(ctx))
pump(); assert(#delivered == 3 and delivered[2] == 'inside.1' and delivered[3] == 'inside.2', 'delivered after V left')
game.vpos = {x = 2000, y = 0, z = 0}; advance(ctx, insts, 2); assert(ctx:count('remote:silenced') == 2, 'and again on the next entry')
ctx:reap(); assert(game.holdReleased == 1, 'the hold is released with the ctx')
`));

test('remote: reads V once a second near the zone and every five seconds far away, a marker with no zone reads nothing, an unsupported hold only reports events', () => withGame(`
local ctx = stageCtx('songbird')
local insts = drive(ctx, {{p = 'remote', deadZone = 'zone'}})
game.vpos = {x = 0, y = 0, z = 0}
advance(ctx, insts, 60)
assert(game.calls.playerPosition <= 13, 'every 5 s from far away: ' .. game.calls.playerPosition)
game.vpos = {x = 1800, y = 0, z = 0}
local before = game.calls.playerPosition
advance(ctx, insts, 60)
assert(game.calls.playerPosition - before >= 55 and game.calls.playerPosition - before <= 61, 'once a second near')
local marker = stageCtx('songbird')
local m = drive(marker, {{p = 'remote'}})
local reads = game.calls.playerPosition
advance(marker, m, 30); assert(game.calls.playerPosition == reads and #marker.events == 0 and game.calls.remoteHold == 1)
game.remoteSupported = false
local c3 = stageCtx('songbird')
local third = drive(c3, {{p = 'remote', deadZone = 'zone'}})
assert(logged('cannot be held yet'))
game.vpos = {x = 2000, y = 0, z = 0}; advance(c3, third, 3); assert(c3:count('remote:silenced') == 1)
local c4 = stageCtx('songbird')
local fourth = drive(c4, {{p = 'remote', deadZone = 'nowhere'}})
assert(logged('dead zone nowhere is not in the stage'))
advance(c4, fourth, 10); assert(#c4.events == 0)
`));

test('runner: a car spawned tagged when V is near, its driver seated, legs sent in order, arrival by distance, lost at the route end', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'runner', id = 'thief', route = {'a', 'b', 'c'}, vehicle = 'Vehicle.v_test', driver = 'Character.test_driver', speed = 14},
  {p = 'runner', id = 'bad1', route = {'a'}, vehicle = 'foot', driver = 'Character.x'}, {p = 'runner', id = 'bad2', route = {'a', 'b'}, vehicle = 'foot'},
  {p = 'runner', id = 'bad3', route = {'a', 'nowhere'}, vehicle = 'foot', driver = 'Character.x'}, {p = 'runner', route = {'a', 'b'}, vehicle = 'foot', driver = 'Character.x'}})
assert(#insts == 1)
game.vpos = {x = 0, y = 800, z = 0}
advance(ctx, insts, 10); assert(#game.spawns == 0, 'V is 500 m away')
game.vpos = {x = 0, y = 400, z = 0}
advance(ctx, insts, 1)
assert(#game.spawns == 1, 'spawned at 100 m')
local s = game.spawns[1]
assert(s.kind == 'car' and s.vehicle == 'Vehicle.v_test' and s.driver == 'Character.test_driver' and s.tag == 'CyberpunkConvaiQuest:pk' and s.x == 0 and s.y == 300)
assert(math.abs(s.yaw - (-90)) < 0.01, 'facing the next point: ' .. tostring(s.yaw))
advance(ctx, insts, 4)
local u = game.units['u1']
assert(u.attached and u.driverIn and u.mountCalls == 1, 'mounted once the game attached it')
assert(#u.toCalls >= 1 and u.toCalls[1].x == 200 and u.toCalls[1].y == 300, 'first leg goes to b')
advance(ctx, insts, 40)
assert(#u.toCalls >= 2 and u.toCalls[2].x == 400, 'second leg goes to c: ' .. #u.toCalls)
assert(ctx:count('runner:thief:lost') == 1, 'route end: ' .. eventsText(ctx) .. ' at ' .. u.pos.x)
advance(ctx, insts, 20); assert(ctx:count('runner:thief:lost') == 1 and ctx:count('runner:thief:caught') == 0)
ctx:reap(); assert(u.deleted and #game.deletes == 1, 'one reap removes the car')
`));

test('runner: caught by V or the copy within the metres only when it is stopped or slow, never while it drives away', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'runner', id = 'r', route = {'a', 'b', 'c'}, vehicle = 'Vehicle.v_test', driver = 'Character.d', speed = 14, caughtMetres = 12}})
game.vpos = {x = 0, y = 400, z = 0}
advance(ctx, insts, 8)
local u = game.units['u1']
assert(u.pos.x > 20, 'the car drives')
game.vpos = {x = u.pos.x + 3, y = u.pos.y, z = 0}
advance(ctx, insts, 1); assert(ctx:count('runner:r:caught') == 0, 'beside a car that drives away is not a catch')
game.vpos = {x = u.pos.x, y = u.pos.y - 100, z = 0}
u.blocked = true
advance(ctx, insts, 3); assert(ctx:count('runner:r:stopped') == 0 and ctx:count('runner:r:caught') == 0, 'three seconds of standing is not stopped yet')
advance(ctx, insts, 2)
assert(ctx:count('runner:r:stopped') == 1, 'stopped after four seconds: ' .. eventsText(ctx))
game.vpos = {x = u.pos.x + 8, y = u.pos.y, z = 0}
advance(ctx, insts, 1)
assert(ctx:count('runner:r:caught') == 1 and u.braked, eventsText(ctx))
advance(ctx, insts, 20); assert(ctx:count('runner:r:caught') == 1 and ctx:count('runner:r:stopped') == 1 and ctx:count('runner:r:lost') == 0)
-- The copy catches it when V is far.
local c2 = stageCtx('panam-palmer')
local more = drive(c2, {{p = 'runner', id = 'q', route = {'a', 'b'}, vehicle = 'Vehicle.v_test', driver = 'Character.d', speed = 14}})
game.vpos = {x = 0, y = 400, z = 0}
advance(c2, more, 6)
local u2 = game.units['u2']
u2.blocked = true
game.copy = {profileKey = 'panam-palmer', kind = 'party', position = {x = u2.pos.x + 30, y = u2.pos.y, z = 0}}
advance(c2, more, 8); assert(c2:count('runner:q:caught') == 0, 'the copy is 30 m away')
game.copy.position = {x = u2.pos.x + 5, y = u2.pos.y, z = 0}
advance(c2, more, 2); assert(c2:count('runner:q:caught') == 1, eventsText(c2))
`));

test('runner: lost when it is farther than 250 m from V for five seconds, or gone, or never attached', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'runner', id = 'far', route = {'a', 'b', 'c'}, vehicle = 'Vehicle.v_test', driver = 'Character.d', speed = 14}})
game.vpos = {x = 0, y = 400, z = 0}
advance(ctx, insts, 4)
game.vpos = {x = 0, y = 900, z = 0}
advance(ctx, insts, 4); assert(ctx:count('runner:far:lost') == 0)
advance(ctx, insts, 3); assert(ctx:count('runner:far:lost') == 1, eventsText(ctx))
local c2 = stageCtx('panam-palmer')
local more = drive(c2, {{p = 'runner', id = 'gone', route = {'a', 'b'}, vehicle = 'Vehicle.v_test', driver = 'Character.d', speed = 14}})
game.vpos = {x = 0, y = 400, z = 0}
advance(c2, more, 8); game.units['u2'].deleted = true
advance(c2, more, 2); assert(c2:count('runner:gone:lost') == 0)
advance(c2, more, 2); assert(c2:count('runner:gone:lost') == 1)
game.autoAttach = false
local c3 = stageCtx('panam-palmer')
local third = drive(c3, {{p = 'runner', id = 'ghost', route = {'a', 'b'}, vehicle = 'Vehicle.v_test', driver = 'Character.d'}})
advance(c3, third, 18); assert(c3:count('runner:ghost:lost') == 0)
advance(c3, third, 6); assert(c3:count('runner:ghost:lost') == 1 and logged('never attached'))
`));

test('runner: a spawn that fails five times is logged and called lost, a driver that cannot get in is called lost, a stuck leg is sent again and then skipped', () => withGame(`
game.spawnFail = 100
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'runner', id = 'nospawn', route = {'a', 'b'}, vehicle = 'Vehicle.v_test', driver = 'Character.d'}})
game.vpos = {x = 0, y = 400, z = 0}
advance(ctx, insts, 40); assert(#game.spawns == 5 and ctx:count('runner:nospawn:lost') == 1 and logged('spawn try 5 failed'))
game.spawnFail = 0
game.mountWorks = false
local c2 = stageCtx('panam-palmer')
local more = drive(c2, {{p = 'runner', id = 'nodriver', route = {'a', 'b'}, vehicle = 'Vehicle.v_test', driver = 'Character.d'}})
advance(c2, more, 30)
assert(game.units['u1'].mountCalls == 3 and c2:count('runner:nodriver:lost') == 1 and logged('could not get into the car'), 'mount calls ' .. game.units['u1'].mountCalls)
game.mountWorks = true
local c3 = stageCtx('panam-palmer')
local third = drive(c3, {{p = 'runner', id = 'stuck', route = {'a', 'b', 'c'}, vehicle = 'Vehicle.v_test', driver = 'Character.d'}})
advance(c3, third, 5)
local u = game.units['u2']
u.blocked = true
advance(c3, third, 30)
assert(#u.toCalls >= 4, 'sent again while it stands: ' .. #u.toCalls)
advance(c3, third, 60)
assert(logged('the leg is skipped'))
assert(c3:count('runner:stuck:stopped') == 1)
`));

test('runner: on foot it is a tagged pedestrian walked by the move command, caught within the metres, with no driver to seat', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'runner', id = 'walker', route = {'a', 'b'}, vehicle = 'foot', record = 'Character.civilian', speed = 2}})
game.vpos = {x = 0, y = 380, z = 0}
advance(ctx, insts, 6)
local u = game.units['u1']
assert(u.kind == 'foot' and u.req.driver == 'Character.civilian' and u.req.vehicle == nil and u.mountCalls == 0 and #u.toCalls == 1 and u.maxSpeed == 2)
game.vpos = {x = u.pos.x + 5, y = u.pos.y, z = 0}
advance(ctx, insts, 2); assert(ctx:count('runner:walker:caught') == 1, 'a walker is slower than 3 m/s: ' .. eventsText(ctx))
`));

test('tail: a tagged car appears behind V, follows at the gap with the command sent again every four seconds, noticed once when close, lost when far', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'tail', id = 'shadow', vehicle = 'Vehicle.v_test', driver = 'Character.d', gap = 30},
  {p = 'tail', id = 'nodriver', vehicle = 'Vehicle.v_test'}, {p = 'tail', gap = 20, driver = 'Character.d'}})
assert(#insts == 1)
game.vpos = {x = 1000, y = 1000, z = 0}
advance(ctx, insts, 1)
assert(#game.spawns == 1 and game.spawns[1].x == 1000 - 70 and game.spawns[1].tag == 'CyberpunkConvaiQuest:pk' and game.calls.behindPlayer == 1, 'behind V by the gap and 40 m')
advance(ctx, insts, 60)
local u = game.units['u1']
assert(u.driverIn and u.mountCalls == 1)
assert(u.followCalls >= 14 and u.followCalls <= 16 and u.gap == 30, 'follow sent every four seconds: ' .. u.followCalls)
assert(#ctx.events == 0, 'at the gap nobody noticed anything: ' .. eventsText(ctx))
u.pos = {x = game.vpos.x - 12, y = game.vpos.y, z = 0}
advance(ctx, insts, 1); assert(ctx:count('tail:shadow:noticed') == 0, 'one sample is not enough')
advance(ctx, insts, 3); assert(ctx:count('tail:shadow:noticed') == 1)
advance(ctx, insts, 10); assert(ctx:count('tail:shadow:noticed') == 1)
u.pos = {x = game.vpos.x - 500, y = game.vpos.y, z = 0}
advance(ctx, insts, 8); assert(ctx:count('tail:shadow:lost') == 0)
advance(ctx, insts, 4); assert(ctx:count('tail:shadow:lost') == 1, eventsText(ctx))
advance(ctx, insts, 20); assert(ctx:count('tail:shadow:lost') == 1)
ctx:reap(); assert(u.deleted)
`));

test('tail: from a place of the stage when V is near it, a car that cannot be made or seated is lost, one that vanishes is lost', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'tail', id = 'at', at = 'spot', vehicle = 'Vehicle.v_test', driver = 'Character.d'}})
game.vpos = {x = 600, y = 0, z = 0}
advance(ctx, insts, 5); assert(#game.spawns == 0)
game.vpos = {x = 100, y = 0, z = 0}
advance(ctx, insts, 2); assert(#game.spawns == 1 and game.spawns[1].x == 40)
advance(ctx, insts, 6); game.units['u1'].deleted = true
advance(ctx, insts, 5); assert(ctx:count('tail:at:lost') == 1)
game.spawnFail = 100
local c2 = stageCtx('panam-palmer')
local more = drive(c2, {{p = 'tail', id = 'x', vehicle = 'Vehicle.v_test', driver = 'Character.d'}})
advance(c2, more, 30); assert(c2:count('tail:x:lost') == 1 and logged('tail x spawn try 5 failed'))
game.spawnFail = 0; game.mountWorks = false
local c3 = stageCtx('panam-palmer')
local third = drive(c3, {{p = 'tail', id = 'y', vehicle = 'Vehicle.v_test', driver = 'Character.d'}})
advance(c3, third, 30); assert(c3:count('tail:y:lost') == 1 and c3:count('tail:y:noticed') == 0)
`));

test('check: the vocabulary is bounded, go or now triggers one read, unknown when it cannot be read', () => withGame(`
local function once(spec, set)
  local ctx = stageCtx('panam-palmer')
  local insts = drive(ctx, {spec})
  set()
  ctx:emit('check:' .. spec.id .. ':go')
  local out = {}
  for _, e in ipairs(ctx.events) do if e ~= 'check:' .. spec.id .. ':go' then out[#out + 1] = e end end
  assert(#out == 1, 'exactly one result: ' .. table.concat(out, ','))
  return out[1]
end
assert(once({p = 'check', id = 'h', what = 'hour'}, function() game.hour = 23 end) == 'check:h:night')
assert(once({p = 'check', id = 'h', what = 'hour'}, function() game.hour = 3 end) == 'check:h:night')
assert(once({p = 'check', id = 'h', what = 'hour'}, function() game.hour = 12 end) == 'check:h:day')
assert(once({p = 'check', id = 'h', what = 'hour', args = {nightFrom = 18, nightTo = 6}}, function() game.hour = 19 end) == 'check:h:night')
assert(once({p = 'check', id = 'h', what = 'hour', args = {nightFrom = 1, nightTo = 4}}, function() game.hour = 2 end) == 'check:h:night')
assert(once({p = 'check', id = 'h', what = 'hour', args = {nightFrom = 1, nightTo = 4}}, function() game.hour = 5 end) == 'check:h:day')
assert(once({p = 'check', id = 'w', what = 'weather'}, function() game.weather = 'heavy-rain' end) == 'check:w:heavy-rain')
assert(once({p = 'check', id = 'w', what = 'weather'}, function() game.weather = 'fog' end) == 'check:w:fog')
assert(once({p = 'check', id = 'w', what = 'weather'}, function() game.weather = 'purple haze' end) == 'check:w:unknown')
assert(once({p = 'check', id = 'e', what = 'heat'}, function() game.heat = 0 end) == 'check:e:0')
assert(once({p = 'check', id = 'e', what = 'heat'}, function() game.heat = 1 end) == 'check:e:1-2')
assert(once({p = 'check', id = 'e', what = 'heat'}, function() game.heat = 2 end) == 'check:e:1-2')
assert(once({p = 'check', id = 'e', what = 'heat'}, function() game.heat = 3 end) == 'check:e:3-5')
assert(once({p = 'check', id = 'e', what = 'heat'}, function() game.heat = 5 end) == 'check:e:3-5')
assert(once({p = 'check', id = 'e', what = 'heat'}, function() game.heat = 7 end) == 'check:e:unknown')
assert(once({p = 'check', id = 'e', what = 'heat'}, function() game.heat = 1.5 end) == 'check:e:unknown')
assert(once({p = 'check', id = 's', what = 'song'}, function() game.song = {playing = false} end) == 'check:s:silent')
assert(once({p = 'check', id = 's', what = 'song'}, function() game.song = {playing = true, station = '89.7 Growl FM'} end) == 'check:s:playing')
assert(once({p = 'check', id = 's', what = 'song', args = {match = 'growl'}}, function() game.song = {playing = true, station = '89.7 Growl FM'} end) == 'check:s:match')
assert(once({p = 'check', id = 's', what = 'song', args = {match = {'samurai', 'never fade'}}}, function() game.song = {playing = true, station = 'Pop', song = 'Never Fade Away'} end) == 'check:s:match')
assert(once({p = 'check', id = 's', what = 'song', args = {match = {'samurai'}}}, function() game.song = {playing = true, station = 'Pop', song = 'Other'} end) == 'check:s:other')
assert(once({p = 'check', id = 's', what = 'song', args = {match = 'samurai'}}, function() game.song = {playing = false} end) == 'check:s:silent')
local gear = {worn = {head = 'Black Cap', feet = 'Boots'}, hand = 'Pistol'}
assert(once({p = 'check', id = 'g', what = 'gear', args = {weapon = true}}, function() game.gear = gear end) == 'check:g:armed')
assert(once({p = 'check', id = 'g', what = 'gear', args = {weapon = true}}, function() game.gear = {worn = {}} end) == 'check:g:unarmed')
assert(once({p = 'check', id = 'g', what = 'gear', args = {slot = 'head'}}, function() game.gear = gear end) == 'check:g:worn')
assert(once({p = 'check', id = 'g', what = 'gear', args = {slot = 'legs'}}, function() game.gear = gear end) == 'check:g:empty')
assert(once({p = 'check', id = 'g', what = 'gear', args = {slot = 'head', match = 'cap'}}, function() game.gear = gear end) == 'check:g:match')
assert(once({p = 'check', id = 'g', what = 'gear', args = {slot = 'head', match = 'helmet'}}, function() game.gear = gear end) == 'check:g:other')
assert(once({p = 'check', id = 'g', what = 'gear', args = {slot = 'wrist'}}, function() game.gear = gear end) == 'check:g:unknown')
assert(once({p = 'check', id = 'g', what = 'gear', args = {weapon = true}}, function() game.gear = nil end) == 'check:g:unknown')
assert(once({p = 'check', id = 'g', what = 'gear'}, function() game.gear = gear end) == 'check:g:unknown')
assert(once({p = 'check', id = 'i', what = 'item', args = {item = 'Items.money', min = 500}}, function() game.items['Items.money'] = 900 end) == 'check:i:have')
assert(once({p = 'check', id = 'i', what = 'item', args = {item = 'Items.money', min = 500}}, function() game.items['Items.money'] = 20 end) == 'check:i:none')
assert(once({p = 'check', id = 'i', what = 'item', args = {item = 'Items.money'}}, function() game.items['Items.money'] = 1 end) == 'check:i:have')
assert(once({p = 'check', id = 'i', what = 'item', args = {item = 'Items.money'}}, function() game.items['Items.money'] = nil end) == 'check:i:unknown')
assert(once({p = 'check', id = 'i', what = 'item', args = {item = 'rm -rf'}}, function() end) == 'check:i:unknown')
assert(once({p = 'check', id = 'i', what = 'item'}, function() end) == 'check:i:unknown')
game.readFails = true
assert(once({p = 'check', id = 'h', what = 'hour'}, function() end) == 'check:h:unknown')
assert(once({p = 'check', id = 'e', what = 'heat'}, function() end) == 'check:e:unknown')
assert(once({p = 'check', id = 's', what = 'song'}, function() end) == 'check:s:unknown')
game.readFails = false
local none = stageCtx('panam-palmer')
assert(#drive(none, {{p = 'check', id = 'z', what = 'mood'}, {p = 'check', what = 'hour'}}) == 0 and logged('unknown kind mood'))
`));

test('check: now reads once on the next step, go reads again each time, nothing is read before then and nothing per second', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'check', id = 'n', what = 'hour', now = true}, {p = 'check', id = 'later', what = 'heat'}})
assert(#ctx.timers == 1 and ctx.timers[1].seconds == 0 and ctx.timers[1].opts.real == true and (game.calls.readHour or 0) == 0, 'nothing is read while arming')
ctx.timers[1].fn()
assert(ctx:count('check:n:day') == 1)
advance(ctx, insts, 60); assert((game.calls.readHour or 0) == 1 and (game.calls.readHeat or 0) == 0, 'no per-second work')
game.heat = 4; ctx:emit('check:later:go'); assert(ctx:count('check:later:3-5') == 1)
game.heat = 0; ctx:emit('check:later:go'); assert(ctx:count('check:later:0') == 1 and game.calls.readHeat == 2)
`));

test('tagged spawns: one reap removes every car and driver of runner, tail and post, nothing is created after it', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'runner', id = 'r', route = {'a', 'b', 'c'}, vehicle = 'Vehicle.v_test', driver = 'Character.d'},
  {p = 'runner', id = 'w', route = {'a', 'b'}, vehicle = 'foot', record = 'Character.civilian'},
  {p = 'tail', id = 't', vehicle = 'Vehicle.v_test', driver = 'Character.d'}, {p = 'post', id = 'c', at = 'spot', stance = 'car'}})
game.copy = {profileKey = 'panam-palmer', kind = 'visitor', position = {x = 40, y = 0, z = 0}}
game.vpos = {x = 0, y = 380, z = 0}
advance(ctx, insts, 12)
game.vpos = {x = 40, y = 60, z = 0}
advance(ctx, insts, 12)
assert(#game.spawns == 4, 'four spawns: ' .. #game.spawns)
for _, s in ipairs(game.spawns) do assert(s.tag == 'CyberpunkConvaiQuest:pk') end
assert(#ctx.tracked == 4)
ctx:reap()
assert(#ctx.tracked == 0 and #game.deletes == 4)
for id, u in pairs(game.units) do assert(u.deleted, id) end
local spawns = #game.spawns
advance(ctx, insts, 20); assert(#game.spawns == spawns, 'nothing after the reap')
-- A spawn made after the ctx was reaped is removed at once.
local late = stageCtx('panam-palmer')
late:reap()
function late:track(kind, handle, undo) pcall(undo, handle); return nil end   -- the real ctx removes what is made after its reap at once
local more = drive(late, {{p = 'tail', id = 'late', vehicle = 'Vehicle.v_test', driver = 'Character.d'}})
game.vpos = {x = 0, y = 380, z = 0}
for _ = 1, 3 do game.now = game.now + 3; game.tick = game.tick + 1; more[1].def.tick(late, more[1].spec, more[1].state, prims.env) end
for id, u in pairs(game.units) do assert(u.deleted, id .. ' deleted') end
`));

test('cost: the calls of every primitive stay bounded over a simulated minute', () => withGame(`
local ctx = stageCtx('panam-palmer')
local insts = drive(ctx, {{p = 'ride', to = 'dest', heat = true}, {p = 'post', id = 'p', at = 'spot'}, {p = 'remote', deadZone = 'zone'},
  {p = 'runner', id = 'r', route = {'a', 'b', 'c'}, vehicle = 'Vehicle.v_test', driver = 'Character.d'}, {p = 'tail', id = 't', vehicle = 'Vehicle.v_test', driver = 'Character.d'},
  {p = 'check', id = 'k', what = 'hour', now = true}})
game.copy = {profileKey = 'panam-palmer', kind = 'visitor', position = {x = 40, y = 0, z = 0}}
game.vpos = {x = 0, y = 380, z = 0}
game.ride.at = {x = 5, y = 0, z = 0}
advance(ctx, insts, 60)
local c = game.calls
assert(c.rideRead <= 60, 'ride samples at 1 Hz: ' .. c.rideRead)
assert(c.readHeat <= 30, 'heat every two seconds: ' .. c.readHeat)
assert(c.driveLookup <= 120, 'one lookup a second for each of the runner and the tail: ' .. c.driveLookup)
assert(c.driveFollow <= 16, 'the follow command every four seconds: ' .. c.driveFollow)
assert((c.driveTo or 0) <= 14, 'legs are sent when needed: ' .. (c.driveTo or 0))
assert(c.copyOf <= 90, 'copy reads: ' .. c.copyOf)
assert((c.postWalk or 0) <= 8 and (c.postHold or 0) <= 4)
assert(c.playerPosition <= 60 * 4, 'V reads: ' .. c.playerPosition)
assert((c.readHour or 0) == 0, 'the check read never ran: its timer did not fire here')
local total = 0
for _, n in pairs(c) do total = total + n end
assert(total <= 60 * 12, 'in all: ' .. total)
ctx:reap()
`));

test('install: with no world at all every primitive survives, the natives file that cannot be loaded is logged once', () => withGame(`
local empty = Prims.new({places = Places.new({world = {}, clock = function() return game.now end}), world = {}, clock = function() return game.now end, log = log})
assert(empty.extend(Drive))
assert(logged('could not be loaded'), 'the natives were not found')
local c = stageCtx('panam-palmer')
for _, spec in ipairs({{p = 'ride', to = 'dest', heat = true, limitMinutes = 1}, {p = 'post', id = 'p', at = 'spot'}, {p = 'remote', deadZone = 'zone'},
  {p = 'runner', id = 'r', route = {'a', 'b'}, vehicle = 'foot', record = 'Character.x'}, {p = 'tail', id = 't', driver = 'Character.x'}, {p = 'check', id = 'c', what = 'heat', now = true}}) do
  local def = empty.get(spec.p)
  assert(def, spec.p)
  local state = def.arm(c, spec, empty.env)
  if state ~= nil and def.tick then for _ = 1, 3 do game.now = game.now + 5; def.tick(c, spec, state, empty.env) end end
end
c.timers[1].fn(); assert(c:count('check:c:unknown') == 1)
assert(not Prims.new({world = {}}).extend(nil))
`));

// ---- with the real quest module: its ctx, timers, listeners and rows ----------------------------------------------------------------------------------------

const playHarness = `
local Lines = ${load('quest-lines.lua')}
local Play = ${load('quest-play.lua')}
local files = {}
local clock = function() return game.now end
local started = {}
local play
local lines = Lines.new({clock = clock, gameTime = function() return game.gameClock end, log = log, busy = function() return false end,
  start = function(entry) started[#started + 1] = entry; return 'r' .. #started end,
  subtitle = function() end, phone = function() return true end, emit = function(pack, name) play.emitPack(pack, name) end, onChange = function() play.rearm() end})
play = Play.new({enabled = function() return true end, clock = clock, gameTime = function() return game.gameClock end,
  read = function(path) return files[path] end, write = function(path, text) files[path] = text; return true end,
  encode = serialize, decode = decode, places = places, lines = lines, prims = prims, session = 's', log = log})
local function step(seconds)
  for _ = 1, math.floor(seconds * 10 + 0.5) do
    game.now = game.now + 0.1; game.gameClock = game.gameClock + 0.1 * game.rate; game.tick = game.tick + 1
    for _, u in pairs(game.units) do
      if not u.attached and not u.deleted and game.now >= u.attachAt then u.attached = true end
    end
    play.update('V', 0.1)
  end
end
local function quest(serial, doList, script)
  return {pack = 'drive-pack', character = 'panam-palmer', stage = 'drive' .. serial, serial = serial, since = 99990,
    places = {start = {x = 0, y = 0, z = 0, radius = 25}, cp1 = {x = 500, y = 0, z = 0, radius = 30}, dest = {x = 1500, y = 0, z = 0, radius = 30},
      zone = {x = 2000, y = 0, z = 0, radius = 60}, a = {x = 0, y = 300, z = 0, radius = 20}, b = {x = 200, y = 300, z = 0, radius = 20}},
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

test('the real quest module: ride, check and remote armed from a play file report their events, the rows answer them, a stage change reaps spawns and holds', () => withPlay(`
game.vpos = {x = 0, y = 380, z = 0}
game.ride.at = {x = 5, y = 0, z = 0}
setFile(quest(1, {{p = 'ride', to = 'dest', checkpoints = {'cp1'}}, {p = 'check', id = 'hr', what = 'hour', now = true}, {p = 'remote', deadZone = 'zone'},
    {p = 'runner', id = 'r', route = {'a', 'b'}, vehicle = 'Vehicle.v_test', driver = 'Character.d'}, {p = 'tail', id = 't', vehicle = 'Vehicle.v_test', driver = 'Character.d'}},
  {{when = 'ride:started', event = 'row:started'}, {when = 'check:hr:day', event = 'row:day'}, {when = 'ride:arrived', event = 'row:arrived'}}))
assert(play.restore() == true)
step(8)
local text = names()
assert(text:find('stage:enter', 1, true) and text:find('ride:started', 1, true) and text:find('row:started', 1, true), text)
assert(text:find('check:hr:day', 1, true) and text:find('row:day', 1, true), 'now reads on the next step of the quest module: ' .. text)
assert(#game.spawns == 2 and game.spawns[1].tag == 'CyberpunkConvaiQuest:drive-pack', 'a runner and a tail')
assert(game.hold ~= nil)
game.ride.at = {x = 500, y = 0, z = 0}; step(3)
game.ride.at = {x = 1500, y = 0, z = 0}; step(3)
text = names()
assert(text:find('ride:checkpoint:cp1', 1, true) and text:find('ride:arrived', 1, true) and text:find('row:arrived', 1, true), text)
for id, u in pairs(game.units) do assert(not u.deleted, id) end
-- The next stage: everything of this one is reaped, the hold included.
setFile(quest(2, {}, {}))
play.onPlayRevision()
for id, u in pairs(game.units) do assert(u.deleted, id .. ' removed with the stage') end
assert(game.holdReleased == 1 and game.hold == nil)
local calls = game.calls.rideRead
step(10); assert(game.calls.rideRead == calls, 'a reaped stage reads nothing')
`));

// ---- the natives (mod/quest-world-drive.lua) on a fake Game ---------------------------------------------------------------------------------------------

const natives = `
local Drive = ${load('quest-world-drive.lua')}
local entities, mounts = {}, {}
local playerEntity
local function entity(key, x, y, z)
  local e = {key = key, x = x or 0, y = y or 0, z = z or 0, attached = true, dead = false, playerMounted = false}
  function e:IsAttached() return self.attached end
  function e:IsDestroyed() return false end
  function e:IsDeadNoStatPool() return self.dead end
  function e:IsPlayerMounted() return self.playerMounted end
  function e:GetWorldPosition() return {x = self.x, y = self.y, z = self.z} end
  function e:GetWorldForward() return {x = 0, y = 1, z = 0} end
  function e:GetMountedVehicle() return self.vehicle end
  function e:GetPocketRadio() return self.radio end
  function e:IsRadioReceiverActive() return true end
  function e:GetRadioReceiverStationName() return 'Growl FM' end
  function e:ForceBrakesUntilStoppedOrFor() self.braked = true end
  return e
end
playerEntity = entity('player', 1, 2, 3)
local heat, seconds, weatherState, items = 2, 13 * 3600 + 600, '24h_weather_light_rain', {}
local broken = false
local function guard(v) if broken then error('the game said no') end return v end
Game = {
  GetPlayer = function() return guard(playerEntity) end,
  GetMountingFacility = function() return guard({GetMountingInfoSingleWithObjects = function(_, e)
    local m = mounts[e.key]
    if not m then return {parentId = {hash = 0}, slotId = {id = 'None'}} end
    return {parentId = {hash = m.parent}, slotId = {id = m.seat}}
  end}) end,
  FindEntityByID = function(id) return entities[id.hash] end,
  GetScriptableSystemsContainer = function() return guard({Get = function() return {GetHeatStageAsInt = function() return heat end} end}) end,
  GetTimeSystem = function() return guard({GetGameTime = function() return {seconds = seconds} end}) end,
  GetWeatherSystem = function() return guard({GetWeatherState = function() return weatherState end}) end,
  GetTransactionSystem = function() return guard({GetItemQuantity = function(_, p, id) return items[id] or 0 end}) end,
  NameToString = function(v) return tostring(v) end,
}
NameToString = function(v) return tostring(v) end
GameTime = {Hours = function(s) return math.floor(s.seconds / 3600) % 24 end, Minutes = function(s) return math.floor(s.seconds % 3600 / 60) end}
ItemID = {FromTDBID = function(id) return id end}
TweakDBID = {new = function(name) return name end}
Enum = {new = function(kind, name) return name end}
dofile = function(name) return ${load('turn-context.lua')} end
local candidates = {}
convaiCompanions = {conversationCandidates = function() return candidates end}
local W = Drive.new({log = log})
`;
const withNatives = code => run(`${base}\n${natives}\n${code}`);

test('natives: rideRead says who drives from the mounted vehicle, where the car is, and whether the party copy sits in it', () => withNatives(`
local car = entity('car', 100, 200, 5)
entities[7001] = car
local npc = entity('panam', 101, 200, 5)
candidates[1] = {profileKey = 'panam-palmer', party = true, npc = npc}
local r = W.rideRead('panam-palmer')
assert(r.mounted == false and r.driving == false and r.copy == 'outside' and r.at.x == 1 and r.vehicleId == nil)
mounts.player = {parent = 7001, seat = 'seat_front_left'}
r = W.rideRead('panam-palmer')
assert(r.mounted and r.driving and r.vehicleId == '7001' and r.at.x == 100 and r.at.y == 200 and r.copy == 'outside')
mounts.panam = {parent = 7001, seat = 'seat_front_right'}
assert(W.rideRead('panam-palmer').copy == 'aboard')
mounts.panam = {parent = 7002, seat = 'seat_front_right'}
assert(W.rideRead('panam-palmer').copy == 'outside', 'another car')
mounts.player.seat = 'seat_back_left'
r = W.rideRead('panam-palmer'); assert(r.mounted and not r.driving, 'a passenger does not drive')
candidates[1].party = false
assert(W.rideRead('panam-palmer').copy == 'gone', 'a visitor is not a party copy')
assert(W.rideRead('someone-else').copy == 'gone')
broken = true
assert(not pcall(W.rideRead, 'panam-palmer'), 'a game that refuses is an error the caller catches')
`));

test('natives: the reads of heat, hour, weather, item, song and gear return plain values and nothing else', () => withNatives(`
assert(W.readHeat() == 2)
heat = 0; assert(W.readHeat() == 0)
heat = 9; assert(W.readHeat() == nil, 'a heat out of range is no answer')
local h, m = W.readHour(); assert(h == 13 and m == 10)
assert(W.readWeather() == 'rain')
weatherState = 'bright'; assert(W.readWeather() == nil)
items['Items.money'] = 750
assert(W.readItem('Items.money') == 750 and W.readItem(5) == nil)
assert(W.readSong().playing == false, 'no radio on')
playerEntity.radio = {IsActive = function() return true end, GetStationName = function() return 'Growl FM' end}
local song = W.readSong(); assert(song.playing == true and song.station == 'Growl FM' and song.song == nil)
convaiMediaSong = {song = function(self, station) return station == 'Growl FM' and 'Never Fade Away' or nil end}
assert(W.readSong().song == 'Never Fade Away')
assert(W.readGear() == nil, 'no gear module, no answer')
convaiPlayerGear = {capture = function() return nil end, read = function() return {clothing = {{slot = 'head', name = 'Cap'}}, weapons = {{slot = 'hand', name = 'Pistol'}, {slot = 'slot1', name = 'Rifle'}}} end}
local g = W.readGear(); assert(g.worn.head == 'Cap' and g.hand == 'Pistol')
convaiPlayerGear = {capture = function() return {clothing = {}, weapons = {}} end}
g = W.readGear(); assert(g.hand == nil and next(g.worn) == nil)
broken = true
for _, name in ipairs({'readHeat', 'readHour', 'readWeather', 'readSong'}) do assert(not pcall(W[name]), name .. ' raises when the game refuses') end
`));

test('natives: remoteHold needs the hook on the lines module and answers nil without it, the post calls go to the visitor calls, the car calls need a world', () => withNatives(`
assert(W.remoteHold(function() return true end) == nil, 'no lines module')
convaiQuestLines = {}
assert(W.remoteHold(function() return true end) == nil, 'a lines module with no holdWhile')
local seen
convaiQuestLines = {holdWhile = function(channel, fn) seen = channel; return function() seen = 'released' end end}
local release = W.remoteHold(function() return true end)
assert(seen == 'remote' and type(release) == 'function'); release(); assert(seen == 'released')
convaiQuestLines = {holdWhile = function() error('no') end}
assert(W.remoteHold(function() end) == nil)
local walked
convaiCompanions.visitorWalk = function(serial, target, gait) walked = {serial, target.x, gait}; return true end
convaiCompanions.visitorHold = function(serial) return serial == 7 end
assert(W.postWalk(7, {x = 4, y = 5, z = 6}) == true and walked[1] == 7 and walked[2] == 4 and walked[3] == 'Walk')
assert(W.postHold(7) == true and W.postHold(8) == false)
convaiCompanions.visitorMount = function(serial, vehicle, seat, unmount, instant) return seat == 'seat_front_left' and vehicle.id == 'x' and unmount == false end
convaiCompanions.visitorMounted = function() return true end
assert(W.postCarMount(7, {id = 'x'}, false) == true and W.postCarMount(7, {id = 'x'}, true) == false and W.postCarMounted(7, {}) == true)
assert(W.postFight(7, true) == false, 'no tactics hold flag yet')
convaiCompanions.tactics = {fightFrom = function(serial, on) return serial == 7 and on end}
assert(W.postFight(7, true) == true)
assert(W.postStance(7, 'stand') == true, 'standing asks for nothing')
assert(W.postStance(7, 'prone') == false, 'no body')
local fire = Drive.new({})
convaiCompanions = nil
assert(fire.postWalk(1, {x = 0, y = 0, z = 0}) == false and fire.postHold(1) == false and fire.postCarMounted(1, {}) == false)
assert(W.driveLookup(nil) == nil and W.driveBrake(nil) == false and W.driveTo(nil, nil) == false)
local back = W.behindPlayer(60); assert(back.x == 1 and back.y == 2 - 60 and back.z == 3)
`));

test('natives: a lookup needs the entities attached, a dead driver is told, a car V sits in is not deleted', () => withNatives(`
local car, driver = entity('c', 10, 20, 0), entity('d', 12, 20, 0)
entities[41], entities[42] = car, driver
local handle = {kind = 'car', entityID = {hash = 41}, id = '41', driverID = {hash = 42}}
local look = W.driveLookup(handle)
assert(look.attached and look.position.x == 10 and look.driverIn == false and look.alive == true)
mounts.d = {parent = 41, seat = 'seat_front_left'}
assert(W.driveLookup(handle).driverIn == true)
mounts.d = {parent = 99, seat = 'seat_front_left'}
assert(W.driveLookup(handle).driverIn == false, 'another car')
driver.dead = true; assert(W.driveLookup(handle).alive == false)
driver.attached = false; look = W.driveLookup(handle); assert(look.attached == false and look.position.x == 10)
driver.attached = true
car.attached = false; look = W.driveLookup(handle); assert(look.attached == false and look.position == nil)
car.attached = true
local walker = {kind = 'foot', driverID = {hash = 42}}
look = W.driveLookup(walker); assert(look.attached and look.position.x == 12)
assert(W.driveBrake(handle) == true and car.braked)
car.playerMounted = true; car.braked = nil
assert(W.driveBrake(handle) == false and not car.braked, 'a car V sits in is not braked by the quest')
assert(W.driveLookup({}) .attached == false)
`));

test('the modules are plain Lua 5.1 with no semicolon in a comment and name no other mod', () => {
  for (const name of ['quest-prims-drive.lua', 'quest-world-drive.lua']) {
    const text = source(name);
    assert.ok(!/\bgoto\b|table\.unpack|bit32|\/\/|~=\s*nil\s*\?/.test(text.replace(/--.*$/gm, '')), name + ' uses a newer Lua form');
    for (const line of text.split('\n')) assert.ok(!/--.*;/.test(line), name + ': no semicolon in a comment: ' + line);
    assert.ok(!/\bAMM\b|reference-amm|Night City Allies|codeware/i.test(text), name + ' names another mod');
    assert.ok(!/onUpdate|GameSession|\bonDraw\b/.test(text), name + ' has no per-frame hook');
  }
});
