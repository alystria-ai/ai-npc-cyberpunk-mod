import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// mod/immersive-car.lua: the trip of a companion who arrives by car (create, stand on a road, board, drive to the road end point, brake, get out)
// against a fake game, and the native calls under it against fake engine objects.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/immersive-car.lua', import.meta.url), 'utf8');
function run(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = fixture + body;
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error + (line ? '\n' + program.split('\n')[line - 1] : ''));
}
const fixture = `
local Car = (function() ${source} end)()
local fake = {created = 0, status = {attached = true, lane = true, speed = 0, position = {x = 0, y = 0, z = 0}}, mounted = false,
  driveState = 'running', mountCalls = 0, unmounts = {}, brakes = 0, drives = {}, driveRefused = false}
local api = {}
function api.create(spec) fake.created = fake.created + 1; fake.spec = spec; if fake.createFails then return nil, 'no room' end return {id = 'car-' .. fake.created} end
function api.status(handle) return fake.status end
function api.mount(serial, handle) fake.mountCalls = fake.mountCalls + 1; return true end
function api.mounted(serial, handle) return fake.mounted end
function api.unmount(serial, handle, instant) fake.unmounts[#fake.unmounts + 1] = instant and 'instant' or 'animated'; return true end
function api.drive(handle, target) if fake.driveRefused then return nil, 'refused' end fake.drives[#fake.drives + 1] = target; return {id = #fake.drives} end
function api.driveState(operation) return fake.driveState end
function api.brake(handle) fake.brakes = fake.brakes + 1 end
local sequencer = Car.sequencer(api)
local spot = {car = {position = {x = 100, y = 0, z = 0}, yaw = 90}}
local a = {serial = 7, road = {x = 8, y = 0, z = 0}}
local function make() a.car = assert(sequencer.create(spot, {record = 'Vehicle.test'})); fake.status = {attached = true, lane = true, speed = 0, position = {x = 100, y = 0, z = 0}}; fake.mounted = false; fake.driveState = 'running' end
local function step(n, dt) local result, why for _ = 1, n or 1 do result, why = sequencer.step(a, dt or 0.5) end return result, why end
`;

test('the car is made at the spot with the chosen record, and a failure to make it is returned', () => run(`
  make()
  assert(fake.created == 1 and fake.spec.position.x == 100 and fake.spec.yaw == 90 and fake.spec.choice.record == 'Vehicle.test')
  assert(a.car.handle.id == 'car-1' and a.car.stage == 'created')
  fake.createFails = true
  local car, why = sequencer.create(spot, {})
  assert(car == nil and why == 'no room')
`));

test('ready: attached on a traffic lane is ready; not attached waits, then fails; off a lane fails after the patience; an unreadable lane is allowed', () => run(`
  make()
  assert(sequencer.ready(a.car, 0.5) == 'ready')
  fake.status = {attached = false}
  assert(sequencer.ready(a.car, 0.5) == 'wait')
  fake.status = {attached = false}
  for _ = 1, 30 do sequencer.ready(a.car, 0.5) end
  local state, why = sequencer.ready(a.car, 0.5)
  assert(state == 'bad' and why:find('attach'))
  make(); fake.status = {attached = true, lane = false, speed = 0, position = {x = 0, y = 0}}
  assert(sequencer.ready(a.car, 0.5) == 'wait' and sequencer.ready(a.car, 0.5) == 'wait' and sequencer.ready(a.car, 0.5) == 'wait')
  state, why = sequencer.ready(a.car, 0.5)
  assert(state == 'bad' and why:find('road'), tostring(state))
  make(); fake.status = {attached = true, lane = nil, speed = 0, position = {x = 0, y = 0}}
  for _ = 1, 4 do sequencer.ready(a.car, 0.5) end
  assert(sequencer.ready(a.car, 0.5) == 'ready', 'an engine that cannot say is not a reason to refuse')
  fake.status = nil
  assert(sequencer.ready(a.car, 0.5) == 'bad')
`));

test('the whole trip: board, drive to the road end point, brake, get out, arrived', () => run(`
  make()
  assert(step() == true and a.car.stage == 'boarding')
  assert(fake.mountCalls == 1, 'boarding is asked once')
  step(3); assert(fake.mountCalls == 1)
  fake.mounted = true
  assert(step() == true and a.car.stage == 'driving')
  assert(step() == true and #fake.drives == 1 and fake.drives[1].x == 8, 'one drive command, to the road end point')
  step(5); assert(#fake.drives == 1 and a.car.stage == 'driving')
  fake.status.position = {x = 20, y = 0, z = 0}; fake.status.speed = 6
  step(2); assert(a.car.stage == 'driving', 'still rolling 12 m from the end point')
  fake.status.position = {x = 12, y = 0, z = 0}; fake.status.speed = 0.4
  assert(step() == true and a.car.stage == 'braking')
  fake.status.speed = 2
  step(); assert(fake.brakes >= 1 and a.car.stage == 'braking')
  fake.status.speed = 0.1
  assert(step() == true and a.car.stage == 'exiting')
  assert(step() == true and #fake.unmounts == 1 and fake.unmounts[1] == 'animated', 'the animated exit')
  step(3); assert(#fake.unmounts == 1)
  fake.mounted = false
  assert(step() == 'arrived' and a.car.stage == 'parked')
`));

test('a successful drive command ends the drive even before the distance rule', () => run(`
  make(); fake.mounted = true
  step(3)
  assert(a.car.stage == 'driving')
  fake.driveState = 'success'
  assert(step() == true and a.car.stage == 'braking')
`));

test('every way the trip fails says so: she cannot board, the drive is refused or fails, the car is stuck or the trip runs too long, the exit hangs, the car is gone', () => run(`
  make()
  step()
  local result, why = step(45)
  assert(result == 'failed' and why:find('into the car'), tostring(why))
  make(); fake.mounted = true; fake.driveRefused = true
  step(2); result, why = step(); assert(result == 'failed' and why == 'refused')
  fake.driveRefused = false
  make(); fake.mounted = true; step(3)
  fake.driveState = 'failed'; result, why = step(); assert(result == 'failed' and why:find('could not drive'))
  fake.driveState = 'running'
  make(); fake.mounted = true; step(3)
  fake.status.position = {x = 60, y = 0, z = 0}
  result = step(60)
  assert(result == 'failed', 'no progress for the stall window')
  make(); fake.mounted = true; step(3)
  for i = 1, 600 do fake.status.position = {x = 90 - i * 0.4, y = 0, z = 0}; result = step() if result == 'failed' then break end end
  assert(result == 'failed' or fake.status.position.x < 20, 'a trip that makes progress but never ends is capped')
  make(); fake.mounted = true; fake.driveState = 'success'; step(4)
  assert(a.car.stage == 'exiting' or a.car.stage == 'braking')
  fake.status.speed = 0; step(3)
  result, why = step(40)
  assert(result == 'failed' and why:find('out of the car'), tostring(why))
  assert(table.concat(fake.unmounts, ','):find('instant'), 'the failsafe exit was tried first')
  make(); fake.status = nil
  result, why = step(); assert(result == 'failed' and why:find('gone'))
`));

// ---- the game side -----------------------------------------------------------------------------------------------------------

const nativeFixture = `
local handle = {id = 'car-1', entityID = {hash = '9ULL'}, system = {IsManaged = function() return fake.managed end}}
local entity = {attached = true, destroyed = false, lane = true, speed = -7.5, position = {x = 5, y = 6, z = 1}, commands = {}}
function entity:IsAttached() return self.attached end
function entity:IsDestroyed() return self.destroyed end
function entity:GetWorldPosition() return self.position end
function entity:IsInTrafficLane() return self.lane end
function entity:GetCurrentSpeed() return self.speed end
function entity:IsPlayerMounted() return false end
function entity:ForceBrakesUntilStoppedOrFor(seconds) fake.forced = seconds end
function entity:GetAIComponent()
  return {SendCommand = function(_, command) entity.commands[#entity.commands + 1] = command; return true end,
    GetCommandState = function(_, command) return command.state end}
end
Game = {FindEntityByID = function(id) return id.hash == '9ULL' and entity or nil end}
Vector3 = {new = function(x, y, z) return {x = x, y = y, z = z} end}
NewObject = function(kind) return {kind = kind, Copy = function(self) return self end} end
local calls = {}
local deps = {tag = 'CyberpunkConvaiHerVehicle',
  vehicle = {spawnAt = function(choice, position, yaw, tag) calls.spawn = {choice, position, yaw, tag}; return handle end,
    destroy = function(h) calls.destroy = h; return fake.destroyed, fake.destroyWhy end},
  companions = {visitorMount = function(serial, vehicle, seat, unmount, instant) calls.mount = {serial, seat, unmount, instant}; return true end,
    visitorMounted = function(serial, vehicle) return fake.sits end}}
local native = Car.nativeApi(deps)
`;

test('native: the car is spawned with her own tag, and its status reads the engine safely', () => run(nativeFixture + `
  local created = native.create({choice = {record = 'Vehicle.x'}, position = {x = 1, y = 2, z = 3}, yaw = 45})
  assert(created == handle and calls.spawn[4] == 'CyberpunkConvaiHerVehicle' and calls.spawn[3] == 45)
  local status = native.status(handle)
  assert(status.attached and status.lane == true and status.speed == 7.5 and status.position.x == 5)
  entity.lane = nil; status = native.status(handle); assert(status.lane == nil)
  entity.attached = false; fake.managed = true
  assert(native.status(handle).attached == false, 'created but not attached yet is not gone')
  fake.managed = false
  assert(native.status(handle) == nil, 'gone')
`));

test('native: boarding and leaving go through the visitor mount, the drive is the autonomous point command with the chauffeur flags', () => run(nativeFixture + `
  assert(native.mount(7, handle) == true and calls.mount[2] == 'seat_front_left' and calls.mount[3] == false)
  assert(native.unmount(7, handle, true) == true and calls.mount[3] == true and calls.mount[4] == true)
  fake.sits = true; assert(native.mounted(7, handle) == true)
  local operation = native.drive(handle, {x = 8, y = 9, z = 1})
  local command = entity.commands[1]
  assert(command.kind == 'AIVehicleDriveToPointAutonomousCommand' and command.targetPosition.x == 8)
  assert(command.needDriver == true and command.useKinematic == false and command.clearTrafficOnPath == false and command.driveDownTheRoadIndefinitely == false)
  assert(command.minimumDistanceToTarget == 3 and command.maxSpeed == 12 and command.minSpeed == -1)
  command.state = 'AICommandState : Executing (2)'; assert(native.driveState(operation) == 'running')
  command.state = 'AICommandState : Success (5)'; assert(native.driveState(operation) == 'success')
  command.state = 'AICommandState : Failure (6)'; assert(native.driveState(operation) == 'failed')
  command.state = 'AICommandState : Cancelled (3)'; assert(native.driveState(operation) == 'failed')
`));

test('native: braking, position, and deletion report what the game said', () => run(nativeFixture + `
  native.brake(handle); assert(fake.forced == 3)
  assert(native.position(handle).x == 5)
  entity.attached = false; assert(native.position(handle) == nil)
  fake.destroyed, fake.destroyWhy = false, 'A passenger remains in this car.'
  local done, why = native.delete(handle)
  assert(done == false and why:find('passenger') and calls.destroy == handle)
  fake.destroyed = true; assert(native.delete(handle) == true)
`));

test('the drive aims at the adjusted road point when the controller made one (never right on V)', () => run(`
  make(); fake.mounted = true
  a.roadEnd = {x = 20, y = 5, z = 0}
  step(3)
  assert(fake.drives[1].x == 20 and fake.drives[1].y == 5, 'roadEnd wins over the raw road point')
  fake.status.position = {x = 28, y = 5, z = 0}; fake.status.speed = 0.3
  assert(step() == true and a.car.stage == 'braking', 'the stop rule measures to the same point')
`));

test('halt: V reached the car on the way, it brakes and she gets out; only while it is driving', () => run(`
  make()
  assert(sequencer.halt(a.car) == false, 'not yet driving')
  fake.mounted = true; step(3)
  assert(a.car.stage == 'driving')
  fake.status.speed = 8
  assert(sequencer.halt(a.car) == true and a.car.stage == 'braking')
  step(); assert(fake.brakes >= 1)
  fake.status.speed = 0.1
  step(); assert(a.car.stage == 'exiting')
  fake.mounted = false
  assert(step() == 'arrived')
  assert(sequencer.halt(a.car) == false, 'a parked car is not halted again')
`));

test('ready: a spot known to be a street is ready as soon as the car stands, whatever the lane answer; the last try goes anyway; the report says what the car answered', () => run(`
  for _, how in ipairs({'trail', 'traffic', 'surface'}) do
    a.car = assert(sequencer.create({car = {position = {x = 1, y = 2, z = 0}, yaw = 0, road = how}}, {record = 'Vehicle.test'}))
    fake.status = {attached = true, lane = false, traffic = false, speed = 0, position = {x = 0, y = 0}}
    local state, note = sequencer.ready(a.car, 0.5)
    assert(state == 'ready' and note:find('lane=false traffic=false') and note:find(how), how .. ': ' .. tostring(state))
  end
  -- a ring spot (ground only) waits for the lane answer and is refused with what the car answered
  a.car = assert(sequencer.create({car = {position = {x = 1, y = 2, z = 0}, yaw = 0, road = 'ring'}}, {record = 'Vehicle.test'}))
  fake.status = {attached = true, lane = false, traffic = false, speed = 0, position = {x = 0, y = 0}}
  local state, why, code
  for _ = 1, 3 do state = sequencer.ready(a.car, 0.5) end
  assert(state == 'wait')
  state, why, code = sequencer.ready(a.car, 0.5)
  assert(state == 'bad' and code == 'off-lane' and why:find('lane=false traffic=false'), tostring(why))
  -- the same spot as the last try after the retries: taken as it is
  a.car = assert(sequencer.create({car = {position = {x = 1, y = 2, z = 0}, yaw = 0, road = 'ring'}, force = true}, {record = 'Vehicle.test'}))
  for _ = 1, 3 do sequencer.ready(a.car, 0.5) end
  state, why = sequencer.ready(a.car, 0.5)
  assert(state == 'ready' and why:find('driving anyway'), tostring(state))
  -- a lane that answers true is ready for any spot
  a.car = assert(sequencer.create({car = {position = {x = 1, y = 2, z = 0}, yaw = 0}}, {record = 'Vehicle.test'}))
  fake.status = {attached = true, lane = true, traffic = true, speed = 0, position = {x = 0, y = 0}}
  state, why = sequencer.ready(a.car, 0.5)
  assert(state == 'ready' and why:find('lane=true'))
`));

test('the native status reads both the lane answer and the traffic physics state, each guarded', () => run(`
  local entity = {IsAttached = function() return true end, IsDestroyed = function() return false end,
    GetWorldPosition = function() return {x = 1, y = 2, z = 3} end, GetCurrentSpeed = function() return -2 end,
    IsInTrafficLane = function() return false end, IsInTrafficPhysicsState = function() error('no such method') end}
  Game = {FindEntityByID = function() return entity end}
  local native = Car.nativeApi({vehicle = {}, companions = {}, tag = 't'})
  local status = native.status({entityID = {}})
  assert(status.attached and status.lane == false and status.traffic == nil and status.speed == 2, 'an unreadable state is nil, not an error')
  entity.IsInTrafficPhysicsState = function() return true end
  assert(native.status({entityID = {}}).traffic == true)
`));
