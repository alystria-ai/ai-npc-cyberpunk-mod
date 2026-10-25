import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// mod/companion-vehicle-native.lua, the parts immersive invitations added: a car-sized space tested anywhere (clearAt, the footprint test the
// party's own cars use, factored out of spawnPoint), a car of her own with its own tag (spawnAt), and its deletion by that tag.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/companion-vehicle-native.lua', import.meta.url), 'utf8');
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
local budget = {left = 1000}
dofile = function(name)
  if name == 'companion-clearance.lua' then
    return {take = function(count) if budget.left < count then return false end budget.left = budget.left - count return true end,
      useBudget = function() end}
  end
  return {useSpatialBudget = function() end}
end
NameToString = function(value) return value end
TweakDBID = {new = function(value) return value end}
CName = {new = function(value) return value end}
EntityID = {new = function() return {hash = '0ULL'} end}
Vector4 = {new = function(x, y, z, w) return {x = x, y = y, z = z, w = w} end}
Quaternion = {ToEulerAngles = function(value) return value end}
EulerAngles = {new = function(roll, pitch, yaw) return {roll = roll, pitch = pitch, yaw = yaw} end, ToQuat = function(angles) return {yaw = angles.yaw} end}
local world = {ground = 0, slope = false, blockedGroup = nil, created = {}, deleted = {}, managed = true, tags = {}}
local spatial = {}
function spatial:SyncRaycastByCollisionGroup(from, to, group)
  if world.noGround then return false end
  if group ~= 'Static' then return false end
  return true, {position = {x = from.x, y = from.y, z = world.ground}, normal = {z = world.slope and 0.5 or 1}}
end
function spatial:Overlap(extents, center, rotation, group) return world.blockedGroup == group end
local system = {}
function system:IsReady() return true end
function system:CreateEntity(spec) world.created[#world.created + 1] = spec; return {hash = '55ULL'} end
function system:IsManaged() return world.managed end
function system:IsTagged(_, tag) return tag == world.tag end
function system:DeleteEntity(entityID) world.deleted[#world.deleted + 1] = entityID.hash; world.managed = false; return true end
Game = {GetSpatialQueriesSystem = function() return spatial end, GetDynamicEntitySystem = function() return system end}
TweakDB = {GetRecord = function(_, record) return {IsA = function(_, kind) return kind == 'gamedataVehicle_Record' end} end}
NewObject = function(kind) return {kind = kind} end
local native = (function() ${source} end)()
`;

test('clearAt: a level, empty car-sized space is returned a little above the ground; a slope, no ground or an obstacle refuses it', () => run(`
  local forward = {x = 0, y = 1}
  local spot = native.clearAt({x = 10, y = 20, z = 0.5, w = 1}, forward, {yaw = 0})
  assert(spot and spot.x == 10 and spot.y == 20 and math.abs(spot.z - 0.35) < 1e-6, spot and spot.z)
  world.slope = true; assert(native.clearAt({x = 10, y = 20, z = 0.5}, forward, {}) == nil); world.slope = false
  world.noGround = true; assert(native.clearAt({x = 10, y = 20, z = 0.5}, forward, {}) == nil); world.noGround = false
  world.ground = 3; assert(native.clearAt({x = 10, y = 20, z = 0.5}, forward, {}) == nil, 'the ground is not where the search started'); world.ground = 0
  world.blockedGroup = 'Vehicle'; assert(native.clearAt({x = 10, y = 20, z = 0.5}, forward, {}) == nil); world.blockedGroup = nil
  budget.left = 3
  local spot2, deferred = native.clearAt({x = 10, y = 20, z = 0.5}, forward, {})
  assert(spot2 == nil and deferred == true, 'a spent query budget asks again later')
`));

test('spawnAt: a car with its own tag, never persisted, facing the given heading; a missing record is refused', () => run(`
  local car = native.spawnAt({record = 'Vehicle.v_test', appearance = 'blue', name = 'Test'}, {x = 1, y = 2, z = 3}, 90, 'CyberpunkConvaiHerVehicle')
  assert(car and car.tag == 'CyberpunkConvaiHerVehicle' and car.owned == true and car.record == 'Vehicle.v_test' and car.id == '55ULL')
  local spec = world.created[1]
  assert(spec.tags[1] == 'CyberpunkConvaiHerVehicle' and spec.persistState == false and spec.persistSpawn == false and spec.alwaysSpawned == true)
  assert(spec.position.x == 1 and spec.orientation.yaw == 90 and spec.appearanceName == 'blue')
  local plain = native.spawnAt({record = 'Vehicle.v_test'}, {x = 1, y = 2, z = 3}, nil, nil)
  assert(plain.tag == 'CyberpunkConvaiPartyVehicle', 'the carpool tag when no other is given')
  TweakDB.GetRecord = function() return nil end
  local none, why = native.spawnAt({record = 'Vehicle.missing'}, {x = 1, y = 2, z = 3}, 0, 'x')
  assert(none == nil and why:find('unavailable'))
`));

test('destroy checks the car\'s own tag, so her car is deleted and a car with a foreign tag is not', () => run(`
  local car = native.spawnAt({record = 'Vehicle.v_test'}, {x = 1, y = 2, z = 3}, 0, 'CyberpunkConvaiHerVehicle')
  world.tag = 'CyberpunkConvaiPartyVehicle'
  car.entity = nil
  local done, why = native.destroy(car)
  assert(done == false and why:find('tag'), tostring(why))
  assert(#world.deleted == 0)
`));

test('surfaceAt: the ground height and its material name in lower case; none when the trace names none, no ground, or the budget is spent', () => run(`
  local hits = 0
  function spatial:SyncRaycastByCollisionGroup(from, to, group)
    hits = hits + 1
    if world.noGround then return false end
    if group == 'Terrain' then return true, {position = {x = from.x, y = from.y, z = world.ground - 0.5}, normal = {z = 1}, material = 'dirt.physmat'} end
    if group ~= 'Static' then return false end
    return true, {position = {x = from.x, y = from.y, z = world.ground}, normal = {z = 1}, material = world.material}
  end
  world.ground, world.material = 2, 'Asphalt.physmat'
  local z, material = native.surfaceAt(5, 6, 1)
  assert(z == 2 and material == 'asphalt.physmat' and hits == 2, tostring(z) .. ' ' .. tostring(material))
  world.material = nil
  z, material = native.surfaceAt(5, 6, 1)
  assert(z == 2 and material == nil, 'a trace with no material name')
  world.material = 'None'
  assert(select(2, native.surfaceAt(5, 6, 1)) == nil, 'the empty name is no name')
  world.noGround = true
  assert(native.surfaceAt(5, 6, 1) == nil, 'no ground')
  world.noGround = false; budget.left = 1
  local none, deferred = native.surfaceAt(5, 6, 1)
  assert(none == nil and deferred == true, 'the budget is spent: ask again')
`));
