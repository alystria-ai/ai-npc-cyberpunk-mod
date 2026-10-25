import {test} from 'node:test';
import assert from 'node:assert/strict';
import {lua} from './housemate-fixture.mjs';

// The game-side adapter against a fake native layer: a floor at z 0, a couch made of boxes, a chair, a stool.
const NATIVE = `
  Game = {GetPlayer = function() return {} end}
  Vector4 = {new = function(x, y, z, w) return {x = x, y = y, z = z, w = w} end}
  Quaternion = {BuildFromDirectionVector = function(v) return {quat = true, x = v.x, y = v.y} end}
  local World = dofile('housemate-world.lua')
  local now = 0
  local boxes = {}
  local function box(x1, x2, y1, y2, h) boxes[#boxes + 1] = {x1 = x1, x2 = x2, y1 = y1, y2 = y2, h = h} end
  -- a couch facing +y: seat 0.44 high, y -0.5..0.1; a back 0.9 high at y 0.1..0.3 would face -y... here the back is BEHIND (at y -0.7..-0.5)
  box(-1, 1, -0.5, 0.2, 0.44)       -- the cushion
  box(-1, 1, -0.75, -0.5, 0.95)      -- the backrest, behind the sitter (the sitter faces +y)
  local calls = {surface = 0, devices = 0, plays = 0, exits = 0, deleted = 0, walks = 0, faces = 0, steps = 0, holds = 0}
  local npcPosition = {x = 0, y = -2, z = 0}
  local inWorkspot, busy = false, false
  local nat = {}
  function nat.surface(x, y, top, bottom, floor)
    calls.surface = calls.surface + 1
    local best = 0
    for _, b in ipairs(boxes) do if x >= b.x1 and x <= b.x2 and y >= b.y1 and y <= b.y2 and b.h > best and b.h <= top then best = b.h end end
    if floor then return 0 end
    if best >= bottom then return best end
    return nil
  end
  function nat.navPoint(p) if world and world.noNav then return nil end return {x = p.x, y = p.y, z = p.z} end
  function nat.people() return world and world.people or {} end
  function nat.spawnDevice(position, orientation, template) calls.devices = calls.devices + 1; return true, {hash = 1} end
  function nat.deviceEntity(id) return {device = true} end
  function nat.hasComponent(device, name) return not (world and world.noComponent) end
  function nat.deleteDevice(id) calls.deleted = calls.deleted + 1 end
  function nat.play(device, npc, component, slide) calls.plays = calls.plays + 1; calls.lastComponent = component; calls.slide = slide; inWorkspot = true; return true end
  function nat.inWorkspot(npc) return inWorkspot end
  function nat.workspotBusy(npc) return busy end
  function nat.exit(npc, instant) calls.exits = calls.exits + 1; calls.instant = instant; inWorkspot = false end
  world = {people = {}}
  local queued = {}
  local companions = {
    visitors = function() return {{serial = 1}} end,
    dismissVisitor = function(serial) calls.dismissed = serial end,
    residentVisible = function(serial, visible) calls.visible = visible end,
    residentNpc = function(serial) return {npc = true} end,
    visitorSense = function() return {active = true} end,
    visitorWalk = function(serial, target, gait) calls.walks = calls.walks + 1; calls.walkTarget = target; return true end,
    visitorHold = function() calls.holds = calls.holds + 1 return true end,
    visitorFace = function(serial, pos, yaw) calls.faces = calls.faces + 1; calls.faceYaw = yaw; return true end,
    visitorStep = function(serial, target) calls.steps = calls.steps + 1; return true end,
    definition = function(key) return {id = 'Character.' .. key} end,
  }
  -- the NPC position is read through GetWorldPosition on the object residentNpc returns
  companions.residentNpc = function() return {GetWorldPosition = function() return {x = npcPosition.x, y = npcPosition.y, z = npcPosition.z} end} end
  local catalog = {device = 'device.ent', seatComponents = {couch = 'convai_sit_couch', chair = 'convai_sit_chair', bar = 'convai_sit_bar',
    stool = 'convai_sit_stool', bed = 'convai_sit_bed', chairsleep = 'convai_sit_chairsleep', lean = 'convai_sit_lean', sink = 'convai_sit_sink'}}
  local adapter = World.new({seating = {native = nat}, catalog = catalog, companions = companions, clock = function() return now end,
    vpos = function() return {x = 0, y = 5, z = 0} end, log = function(kind, fields) calls.logs = calls.logs or {}; calls.logs[#calls.logs + 1] = kind .. ' ' .. tostring(fields.error or fields.why or '') end,
    queue = function() return {invite = function(key, extra) queued[#queued + 1] = {key = key, extra = extra} return true, '', 'id' end} end})
  local function tick(seconds) now = now + seconds end
  -- run prepare to completion across rays windows
  local function prepare(spot, r)
    for _ = 1, 400 do
      local a, b, c = adapter.prepare(spot, r)
      if c == 'wait' then tick(0.11) else if not a and b == 'error' then error('prepare error: ' .. tostring(calls.logs and calls.logs[#calls.logs])) end return a, b end
    end
    error('prepare never finished')
  end
`;

test('a seed on a couch is snapped to the cushion, faces away from the backrest, and gets a way up in front', () => {
  lua(`${NATIVE}
    local spot = prepare({id = 's', kind = 'couch', x = 0.15, y = -0.1, z = 0, conf = 'A'}, {key = 'judy'})
    assert(spot, 'no spot')
    -- the sitter faces +y: yaw 0 (the game's forward is +y)
    assert(math.abs(spot.yaw) < 1 or math.abs(spot.yaw - 360) < 1, 'yaw ' .. spot.yaw)
    -- the root is 0.3 m in front of the cushion's middle
    assert(spot.y > -0.25 and spot.y < 0.45, 'y ' .. spot.y)
    assert(spot.approach and spot.approach.y > spot.y, 'the way up is in front')
    assert(spot.component == 'couch')
  `);
});

test('a seed with no seat surface near it is rejected with a reason', () => {
  lua(`${NATIVE}
    local spot, why = prepare({id = 'nothing', kind = 'chair', x = 10, y = 10, z = 0, conf = 'A'}, {key = 'judy'})
    assert(spot == nil and why:find('no seat surface'), tostring(why))
  `);
});

test('a seat with no ground to walk up from, or a stranger sitting on it, is rejected', () => {
  lua(`${NATIVE}
    world.noNav = true
    local spot, why = prepare({id = 's', kind = 'couch', x = 0, y = -0.1, z = 0, conf = 'A'}, {key = 'a'})
    assert(spot == nil and why:find('way up'), tostring(why))
    world.noNav = false
    world.people = {{x = 0, y = 0.1, z = 0}}
    local occupied, reason = prepare({id = 's2', kind = 'couch', x = 0, y = -0.1, z = 0, conf = 'A'}, {key = 'b'})
    assert(occupied == nil and reason == 'occupied', tostring(reason))
  `);
});

test('the ray budget: one window never spends more than 36 rays and the search resumes in the next', () => {
  lua(`${NATIVE}
    local before = calls.surface
    local a, b, c = adapter.prepare({id = 's', kind = 'couch', x = 0, y = -0.1, z = 0, conf = 'A'}, {key = 'a'})
    assert(c == 'wait')
    assert(calls.surface - before <= 36, 'spent ' .. (calls.surface - before))
    tick(0.11)
    local spot = prepare({id = 's', kind = 'couch', x = 0, y = -0.1, z = 0, conf = 'A'}, {key = 'a'})
    assert(spot)
  `);
});

test('a measured spot is only checked, not searched', () => {
  lua(`${NATIVE}
    local before = calls.surface
    local spot = prepare({id = 'm', kind = 'couch', x = 0, y = 0.05, z = 0, yaw = 0, conf = 'M'}, {key = 'a'})
    assert(spot and spot.yaw == 0)
    assert(calls.surface - before < 30, 'searched anyway: ' .. (calls.surface - before))
  `);
});

test('standing places are snapped to the walkable ground and face the window or V', () => {
  lua(`${NATIVE}
    local window = prepare({id = 'w', kind = 'window', x = 3, y = 3, z = 0, face = {x = 3, y = 8}}, {key = 'a'})
    assert(window and math.abs(window.yaw) < 1, 'window yaw ' .. tostring(window and window.yaw))
    local stand = prepare({id = 'st', kind = 'stand', x = 3, y = 0, z = 0}, {key = 'a'})
    assert(stand and stand.yaw ~= nil)
    world.noNav = true
    local none, why = prepare({id = 'st2', kind = 'stand', x = 3, y = 0, z = 0}, {key = 'a'})
    assert(none == nil and why == 'no walkable ground')
  `);
});

test('a bed slot needs a bed under it and as wide as the slot says', () => {
  lua(`${NATIVE}
    box(5, 7, -1, 1, 0.5)      -- a mattress 2 x 2 at height 0.5
    local ok = prepare({id = 'b:1', kind = 'bed', x = 6, y = 0, z = 0, yaw = 0}, {key = 'a'})
    assert(ok and ok.bed and math.abs(ok.z - 0.5) < 0.01)
    local edge, why = prepare({id = 'b:2', kind = 'bed', x = 6.9, y = 0, z = 0, yaw = 0}, {key = 'a'})
    assert(edge == nil and why:find('narrow'), tostring(why))
    local none, why2 = prepare({id = 'b:3', kind = 'bed', x = 20, y = 0, z = 0, yaw = 0}, {key = 'a'})
    assert(none == nil and why2:find('no bed'))
  `);
});

test('occupying a seat: walk to the way up, put the device down, play the workspot, ready; leave: exit, wait, step off, delete the device', () => {
  lua(`${NATIVE}
    local spot = prepare({id = 's', kind = 'couch', x = 0.15, y = -0.1, z = 0, conf = 'A'}, {key = 'judy'})
    local h = adapter.seats.occupy(1, spot, {})
    assert(adapter.seats.status(h) == 'busy', 'walk first')
    assert(calls.walks == 1 and calls.walkTarget.y == spot.approach.y)
    -- she arrives
    npcPosition = {x = spot.approach.x, y = spot.approach.y, z = 0}
    local status
    for _ = 1, 20 do status = adapter.seats.status(h); tick(0.3); if status == 'ready' then break end end
    assert(status == 'ready', status)
    assert(calls.devices == 1 and calls.plays == 1 and calls.lastComponent == 'convai_sit_couch')
    -- leaving
    adapter.seats.release(h, false)
    assert(calls.exits == 1 and calls.instant == false)
    inWorkspot = false; busy = false
    local out
    for _ = 1, 40 do out = adapter.seats.status(h); tick(0.3); if out == 'released' then break end end
    assert(out == 'released', out)
    assert(calls.steps == 1, 'no step off')
    assert(calls.deleted == 1)
  `);
});

test('standing: she walks, is turned toward the window and held, and nothing is spawned', () => {
  lua(`${NATIVE}
    local spot = prepare({id = 'w', kind = 'window', x = 3, y = 3, z = 0, face = {x = 3, y = 8}}, {key = 'a'})
    local h = adapter.seats.occupy(1, spot, {})
    adapter.seats.status(h)
    npcPosition = {x = spot.x, y = spot.y, z = 0}
    local status
    for _ = 1, 5 do status = adapter.seats.status(h); tick(0.3) end
    assert(status == 'ready' and calls.faces == 1 and calls.holds == 1 and calls.devices == 0)
    adapter.seats.release(h, false)
    assert(adapter.seats.status(h) == 'released')
  `);
});

test('an archive without the component fails the seat cleanly, and the device is cleaned up', () => {
  lua(`${NATIVE}
    world.noComponent = true
    local spot = prepare({id = 's', kind = 'couch', x = 0.15, y = -0.1, z = 0, conf = 'A'}, {key = 'judy'})
    npcPosition = {x = spot.approach.x, y = spot.approach.y, z = 0}
    local h = adapter.seats.occupy(1, spot, {})
    local status
    for _ = 1, 10 do status = adapter.seats.status(h); tick(0.3); if status == 'failed' then break end end
    assert(status == 'failed' and calls.deleted == 1 and calls.plays == 0)
  `);
});

test('she never reaches the seat: the walk times out', () => {
  lua(`${NATIVE}
    local spot = prepare({id = 's', kind = 'couch', x = 0.15, y = -0.1, z = 0, conf = 'A'}, {key = 'judy'})
    local h = adapter.seats.occupy(1, spot, {})
    local status
    for _ = 1, 400 do status = adapter.seats.status(h); tick(0.5); if status == 'failed' then break end end
    assert(status == 'failed')
  `);
});

test('sleeping in a chair uses the chair-sleep component; a bed uses the bed component', () => {
  lua(`${NATIVE}
    box(5, 5.6, -0.3, 0.3, 0.45); box(5, 5.6, -0.55, -0.3, 1.0)
    local spot = prepare({id = 'c', kind = 'chair', x = 5.3, y = 0, z = 0, conf = 'A'}, {key = 'judy', sleep = true})
    assert(spot and spot.component == 'chairsleep', tostring(spot and spot.component))
  `);
});

test('procedural standing places: near V, on the ground, away from the ones taken, and never the same twice', () => {
  lua(`${NATIVE}
    local one
    for _ = 1, 50 do local a, b = adapter.proc('corpo', {key = 'a'}, {}); if a then one = a break end tick(0.11) end
    assert(one and one.id == 'proc:a')
    local two
    for _ = 1, 50 do local a = adapter.proc('corpo', {key = 'b'}, {one}); if a then two = a break end tick(0.11) end
    assert(two)
    assert(math.sqrt((one.x - two.x) ^ 2 + (one.y - two.y) ^ 2) >= 1.2)
  `);
});

test('creating a body goes through the party queue as a quiet resident with her flat and an id that names her', () => {
  lua(`${NATIVE}
    local ok = adapter.bodies.spawn({key = 'judy-alvarez', apt = 'glen'}, {x = 1, y = 2, z = 3, yaw = 90})
    assert(ok == true and #queued == 1)
    local extra = queued[1].extra
    assert(queued[1].key == 'judy-alvarez' and extra.quiet == true and extra.resident == true)
    assert(extra.appointment.id == 'hm:judy-alvarez' and extra.appointment.owner == 'housemates' and extra.appointment.home == 'glen')
    assert(extra.appointment.position.x == 1 and math.abs(extra.appointment.facing.x + 1) < 1e-6)
  `);
});

// A bar stool has no backrest: the higher surface beside it is the counter, and she faces it. (Before, the couch rule - face away from the higher
// surface - turned every home-seated bar stool 180 degrees.) A stool at x 20 so the couch of the fixture does not interfere.
test('a bar stool and a stool face the counter, and a straight counter gives a straight facing', () => {
  lua(`${NATIVE}
    box(19.8, 20.2, -0.2, 0.2, 0.75)    -- the stool seat
    box(19.0, 19.7, -2, 2, 1.05)        -- a counter on the -x side, along y
    local bar = prepare({id = 'bar', kind = 'bar', x = 20, y = 0, z = 0, conf = 'A'}, {key = 'bar'})
    assert(bar, 'no bar spot')
    -- facing -x is game yaw 90 (forward = (-sin, cos)); the diagonals that see the same counter are averaged into a straight 90
    assert(math.abs(bar.yaw - 90) < 1, 'bar yaw ' .. tostring(bar.yaw))
    local stool = prepare({id = 'stool', kind = 'stool', x = 20, y = 0, z = 0, conf = 'A'}, {key = 'stool'})
    assert(stool and math.abs(stool.yaw - 90) < 1, 'stool yaw ' .. tostring(stool and stool.yaw))
  `);
});

// The final facing of a home-seated stool is the quaternion built from the direction she should face; V's own seated body, which the V-triggered
// path copies onto the device, faces the counter by definition. Both go through the strict placement call (a real Vector4 is required).
test('the home path and the V-triggered path turn the same stool the same way (strict placement fake)', () => {
  lua(`${NATIVE}
    local VectorMeta = {}
    Vector4 = {new = function(x, y, z, w) return setmetatable({x = x, y = y, z = z, w = w}, VectorMeta) end}
    local built = {}
    Quaternion = {BuildFromDirectionVector = function(v)
      assert(getmetatable(v) == VectorMeta, 'BuildFromDirectionVector needs a Vector4')
      built[#built + 1] = {x = v.x, y = v.y}
      return {quat = true, x = v.x, y = v.y}
    end}
    local Seating = dofile('companion-seating.lua')
    box(19.8, 20.2, -0.2, 0.2, 0.75)
    box(19.0, 19.7, -2, 2, 1.05)
    local bar = prepare({id = 'bar', kind = 'bar', x = 20, y = 0, z = 0, conf = 'A'}, {key = 'bar'})
    assert(bar, 'no bar spot')
    local home = Seating.native.orientation(bar.yaw)
    assert(home, 'no home orientation')
    -- V sitting on the same stool looks at the counter: toward -x. The device takes V's world orientation, i.e. the same direction vector.
    local viaV = Quaternion.BuildFromDirectionVector(Vector4.new(-1, 0, 0, 0))
    assert(math.abs(home.x - viaV.x) < 1e-6 and math.abs(home.y - viaV.y) < 1e-6, 'home facing ' .. home.x .. ',' .. home.y .. ' vs V ' .. viaV.x .. ',' .. viaV.y)
  `, {extra: ['companion-seating.lua', 'gesture-workspot.lua']});
});
