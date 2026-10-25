import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lua} from './housemate-fixture.mjs';

// The whole chain on the Corpo Plaza flat (docs/COMPANION_SETTLE.md): the real settle module, the real seating controller, the real housemates' spot data,
// plan and spot preparer, against a fake game (a floor, cushions where the data has seats, a navmesh that accepts everything). Three companions follow V
// into the flat, V stays, and they spread out over the seats; V walks off and they get up and follow.
const EXTRA = ['companion-settle.lua', 'companion-seating.lua', 'gesture-workspot.lua'];
const FIXTURE = `
  local Seating = dofile('companion-seating.lua')
  local Settle = dofile('companion-settle.lua')
  local calls, logs = {}, {}
  local function count(name) local n = 0; for _, c in ipairs(calls) do if c.name == name then n = n + 1 end end return n end
  local data = dofile('housemate-spots-data.lua')
  local apartment = data.apartments.corpo
  local HEIGHT = {couch = .44, chair = .45, bar = .75, stool = .75}
  local native = {}
  local devices, entityOf = {}, {}
  function native.playerSeat(player, detail) return {inside = false} end
  -- Cushions: a disc of 0.45 m around every seat of the data, at the height of its kind. Everything else is floor at the flat's own level.
  function native.surface(x, y, top, bottom, floor)
    calls[#calls + 1] = {name = 'surface'}
    if floor then return top - 0.6 end
    local best
    for _, spot in ipairs(apartment.spots) do
      local h = HEIGHT[spot.kind]
      if h and math.sqrt((x - spot.x) ^ 2 + (y - spot.y) ^ 2) <= 0.45 and math.abs(spot.z - (top - 1.3)) < 0.5 then
        local z = spot.z + h
        if z >= bottom and (not best or z > best) then best = z end
      end
    end
    return best
  end
  function native.blocked() return false end
  function native.people() calls[#calls + 1] = {name = 'people'}; return {} end
  function native.spawnDevice(position, orientation, template)
    local id = {hash = #calls + 1}
    calls[#calls + 1] = {name = 'spawn', x = position.x, y = position.y, id = id}
    devices[id] = {x = position.x, y = position.y}
    return true, id
  end
  function native.deviceEntity(id) return {device = id} end
  function native.deleteDevice(id) calls[#calls + 1] = {name = 'delete'}; return true end
  function native.sweep() return true end
  function native.play(device, npc, component, slide)
    calls[#calls + 1] = {name = 'play', component = component, npc = npc}
    npc.entering = true; npc.seatAt = devices[device.device]
    return true
  end
  function native.inWorkspot(npc) return npc.inside end
  function native.exit(npc, instant) calls[#calls + 1] = {name = 'exit', instant = instant == true, npc = npc}; npc.leaving = true; return true end
  function native.stopInDevice() return true end
  function native.look() return true end
  function native.orientation(yaw) return {quat = true, yaw = yaw} end
  function native.navPoint(point) return {x = point.x, y = point.y, z = point.z} end
  function native.lineClear() return true end
  function native.workspotBusy() return false end
  function native.openness() return 4 end
  function native.stepOut(entry, spot) entry.position = {x = spot.x, y = spot.y, z = spot.z}; return true end
  function native.teleport(entry, spot) entry.position = {x = spot.x, y = spot.y, z = spot.z}; return true end
  function native.bodyClear() return true end
  function native.lookingAt() return false end
  function native.hiddenFrom() return true end
  local catalog = {device = 'dev.ent', seatComponents = {couch = 'convai_sit_couch', chair = 'convai_sit_chair', bar = 'convai_sit_bar', stool = 'convai_sit_stool'}}
  local seating = Seating.new({catalog = catalog, native = native})
  local v = {x = -1603.5, y = 357.5, z = 48.62}
  local player = {GetWorldPosition = function() return {x = v.x, y = v.y, z = v.z} end}
  local busy, here = nil, 'corpo'
  local clockNow = 0
  -- The world's clock for the ray windows of the spot preparer.
  local World = dofile('housemate-world.lua')
  local settle = Settle.new({
    load = dofile, seating = function() return seating end,
    vpos = function() return {x = v.x, y = v.y, z = v.z} end,
    held = function() return busy end, district = function() return here end,
    member = function(entity) for _, e in ipairs(party) do if e.entityID.hash == entity then return {serial = e.serial, key = 'k', name = 'N'} end end end,
    world = function(seat)
      World.RAYS_PER_WINDOW = Settle.RAYS
      return World.new({seating = {native = native}, catalog = {}, clock = function() return clockNow end, vpos = function() return {x = v.x, y = v.y, z = v.z} end})
    end,
    log = function(kind, fields) logs[#logs + 1] = {kind = kind, fields = fields} end})
  Game = {GetPlayer = function() return player end}
  Vector4 = {new = function(x, y, z, w) return {x = x, y = y, z = z, w = w} end}
  Quaternion = {BuildFromDirectionVector = function(vec) return {quat = true} end}
  local function companion(serial, x, y)
    local npc = {inside = false, serial = serial}
    return {serial = serial, entityID = {hash = tostring(70 + serial)}, npc = npc, position = {x = x, y = y, z = 48.62}, speed = 0,
      playerGap = math.sqrt((x - v.x) ^ 2 + (y - v.y) ^ 2), motor = {kind = 'hold', ticket = 'h', feedback = {}}}
  end
  party = {companion(1, -1604.5, 358.5), companion(2, -1602.5, 358.5), companion(3, -1605, 356)}
  local decisions, held = {}, {}
  local function step(seconds)
    for _ = 1, math.max(1, math.floor(seconds / .1 + .5)) do
      local rows = {}
      for _, e in ipairs(party) do rows[#rows + 1] = {entry = e} end
      clockNow = clockNow + .1
      seating.tick(player, .1, rows)
      settle.tick(player, .1, rows)
      for _, e in ipairs(party) do
        e.playerGap = math.sqrt((e.position.x - v.x) ^ 2 + (e.position.y - v.y) ^ 2)
        local npc = e.npc
        if npc.entering then npc.entering = nil; npc.inside = true; if npc.seatAt then e.position = {x = npc.seatAt.x, y = npc.seatAt.y, z = 48.62} end end
        if npc.leaving then npc.leaving = nil; npc.inside = false end
        local d = seating.steer(e, {combat = false, motion = e.motor.feedback, selected = false, facingError = 90, frame = {position = v}})
        decisions[e.serial] = d
        if d and d.operation then
          local op = d.operation
          e.motor.ticket, e.motor.kind = op.ticket, op.kind
          if op.kind == 'move' then e.position = {x = op.goal.x, y = op.goal.y, z = 48.62}; e.motor.feedback = {ticket = op.ticket, complete = true}
          else e.motor.feedback = {ticket = op.ticket} end
        end
        held[e.serial] = seating.observe(e, {combat = false, selected = false})
      end
    end
  end
  local function flat(a, b) return math.sqrt((a.x - b.x) ^ 2 + (a.y - b.y) ^ 2) end
`;
const run = body => lua(`${FIXTURE}\n${body}`, {extra: EXTRA});

test('three companions follow V into the Corpo Plaza flat, V stays: they spread over seats of the flat and sit', () => run(`
  settle.enter('corpo')
  step(9)
  assert(not seating.homeActive(), 'V has only been in the flat for 9 s')
  assert(count('play') == 0)
  step(40)
  assert(seating.homeActive(), 'settled')
  local seats = {}
  for serial = 1, 3 do assert(held[serial] == true, 'companion ' .. serial .. ' sits') end
  for _, call in ipairs(calls) do if call.name == 'spawn' then seats[#seats + 1] = {x = call.x, y = call.y} end end
  assert(#seats == 3, 'three seats: ' .. #seats)
  for i = 1, 3 do for j = i + 1, 3 do assert(flat(seats[i], seats[j]) >= 0.5, 'two companions on one seat') end end
  -- Every seat is one of the flat's own seats, and none is V's own root (the data's vslot).
  for _, seat in ipairs(seats) do
    local near
    for _, spot in ipairs(apartment.spots) do if flat(spot, seat) < 0.6 then near = spot end end
    assert(near and near.kind ~= 'bed' and not near.vslot, 'a seat of the flat: ' .. seat.x .. ' ' .. seat.y)
  end
  assert(count('surface') < 900, 'bounded search: ' .. count('surface') .. ' surface reads')
`));

test('V walks away: they get up with the native exit and follow again; nothing runs after V left the flat', () => run(`
  settle.enter('corpo')
  step(50)
  for serial = 1, 3 do assert(held[serial] == true) end
  v.x = v.x + 30
  step(1)
  assert(not seating.homeActive(), 'ended: V went far from them')
  assert(count('exit') == 3 and not (function() for _, c in ipairs(calls) do if c.name == 'exit' and c.instant then return true end end end)(), 'three normal exits')
  step(6)
  for serial = 1, 3 do assert(held[serial] == false and decisions[serial] == nil, 'following again: ' .. serial) end
  local before = #calls
  settle.leave('left the flat')
  step(5)
  local surfaceAfter = 0
  for i = before + 1, #calls do if calls[i].name == 'surface' then surfaceAfter = surfaceAfter + 1 end end
  assert(surfaceAfter == 0, 'no more surface reads after V left')
`));

test('a fight in the flat stands them up at once; after it they settle again once V has been quiet', () => run(`
  settle.enter('corpo')
  step(50)
  assert(held[1] == true)
  busy = 'combat'
  step(.6)
  assert(not seating.homeActive())
  step(.2)
  local instant = 0
  for _, c in ipairs(calls) do if c.name == 'exit' and c.instant then instant = instant + 1 end end
  assert(instant == 3, 'instant exits: ' .. instant)
  busy = nil
  step(20)
  assert(seating.homeActive(), 'settled again')
  step(10)
  for serial = 1, 3 do assert(held[serial] == true, 'seated again: ' .. serial) end
`));

test('"come with me" to one of them: she gets up and follows, the others stay seated', () => run(`
  settle.enter('corpo')
  step(50)
  local offer = settle.followOffer(party[2].entityID.hash, {profileKey = 'k', name = 'Judy'})
  assert(offer and offer.available, 'offered while seated')
  assert(settle.follow(party[2].entityID.hash) == true)
  step(6)
  assert(held[2] == false and decisions[2] == nil, 'she follows')
  assert(held[1] == true and held[3] == true, 'the others stay')
  assert(settle.followOffer(party[2].entityID.hash, {profileKey = 'k', name = 'Judy'}) == nil, 'no longer offered')
`));

test('a fourth and fifth companion join while V is at home: places for those who fit, the rest stand in the room', () => run(`
  settle.enter('corpo')
  step(50)
  party[#party + 1] = companion(4, -1600, 358)
  party[#party + 1] = companion(5, -1600, 354)
  step(40)
  local seen = {}
  for serial = 1, 5 do
    local row
    for _, r in ipairs(seating.snapshot().companions) do if r.serial == serial then row = r end end
    assert(row and row.home and row.place, 'companion ' .. serial .. ' has a place')
    assert(not seen[row.place], 'place used twice: ' .. row.place)
    seen[row.place] = true
  end
`));
