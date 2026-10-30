import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// mod/immersive-world.lua, the road lookup for a car arrival: the engine's answer, then V's drive trail, the traffic cars on a lane near V, the
// engine's intersection ahead, and V's own spot as the last guess. Every game call is faked with the methods the engine really has; a missing
// method is an error the module must survive (pcall), never a crash.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/immersive-world.lua', import.meta.url), 'utf8');
const catalogSource = readFileSync(new URL('../mod/companion-vehicle-catalog.lua', import.meta.url), 'utf8');
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
dofile = function(name)
  if name == 'place-words.lua' then return {text = function() return 'Watson' end, compass = function() return 'north' end} end
  error('Unexpected module ' .. name)
end
Enum = {new = function(_, value) return value end}
CName = {new = function(value) return value end}
Vector4 = {new = function(x, y, z, w) return {x = x, y = y, z = z, w = w} end}
TSQ_ALL = function() return {} end
TS_TargetPartInfo = {GetComponent = function(part) return part end}
local fake = {road = {point = {x = 0, y = 0, z = 0}, pathLength = -1}, intersection = nil, vehicles = {}, queries = 0, targetFails = false}
local V = {x = 100, y = 200, z = 5}
local player = {GetWorldPosition = function() return V end}
local function vehicle(spec)
  local entity = {}
  function entity:IsVehicle() return true end
  function entity:IsAttached() return true end
  function entity:GetEntityID() return {hash = spec.id} end
  function entity:IsPlayerVehicle() return spec.mine == true end
  function entity:IsPlayerMounted() return false end
  function entity:IsInTrafficPhysicsState() if spec.noState then error('no such method') end return spec.lane == true end
  function entity:IsCrowdVehicle() return spec.crowd == true end
  function entity:GetCurrentSpeed() return spec.speed or 0 end
  function entity:GetWorldPosition() return {x = spec.x, y = spec.y, z = spec.z or 5} end
  function entity:GetWorldForward() return {x = spec.hx or 0, y = spec.hy or 1, z = 0} end
  return {GetEntity = function() return entity end}
end
Game = {
  GetPlayer = function() return player end,
  GetDynamicEntitySystem = function() return {IsReady = function() return false end} end,
  GetPreventionSpawnSystem = function() return {
    GetNearestRoadFromPlayerInfo = function() return fake.road end,
    GetIntersectionInFrontOfPlayerPos = function() if fake.intersection == 'error' then error('boom') end return fake.intersection end} end,
  GetTargetingSystem = function() return {GetTargetParts = function()
    fake.queries = fake.queries + 1
    if fake.targetFails then error('targeting is down') end
    local parts = {}
    for _, spec in ipairs(fake.vehicles) do parts[#parts + 1] = vehicle(spec) end
    return true, parts
  end} end,
}
local logs = {}
local World = (function() ${source} end)()
local world = World.new({companions = {findCarSpot = function(key, request, state) fake.request = request; return nil, 'none' end}})
local function here() return world.describe('here', true) end
`;

test('the engine road is used when it reads, and nothing else is asked', () => run(`
  fake.road = {point = {x = 130, y = 210, z = 5}, pathLength = 31}
  local result = here()
  assert(result.roadHow == 'engine' and result.road.x == 130 and fake.queries == 0)
`));

test('an empty engine struct (point 0,0,0, pathLength -1) falls to the traffic cars on a lane, nearest first, with the count in the note', () => run(`
  fake.vehicles = {
    {id = 'far', x = 100, y = 380, lane = true},                    -- 180 m: outside the census
    {id = 'near', x = 130, y = 200, lane = true, hx = 0, hy = 3},   -- 30 m, heading north (not normalised)
    {id = 'crowd', x = 100, y = 140, crowd = true, speed = 6, noState = true, hx = 1, hy = 0},  -- 60 m, moving crowd car, state unreadable
    {id = 'parked', x = 105, y = 205, lane = false},                -- parked: not a lane
    {id = 'slow', x = 90, y = 210, crowd = true, speed = 0.5},      -- a crowd car that stands: not a lane
    {id = 'mine', x = 101, y = 201, lane = true, mine = true},      -- V's own car
    {id = 'near', x = 130, y = 200, lane = true},                   -- the same entity twice is counted once
  }
  local result = here()
  assert(result.roadHow == 'traffic' and result.road.x == 130 and result.road.y == 200, tostring(result.roadHow))
  assert(result.roadWhy == 'zero-point' and result.roadNote:find('point=0,0,0 pathLength=%-1'), result.roadNote)
  assert(result.roadNote:find('traffic=6/2 nearest 30 m'), 'six distinct vehicles seen, two on a lane: ' .. result.roadNote)
  -- the lanes are offered to the spot search with their headings
  world.findSpot({key = 'judy', road = result.road, dest = V, spotTries = 0}, 'car')
  local lanes = fake.request.lanes
  assert(#lanes == 2 and lanes[1].hx == 0 and math.abs(lanes[1].hy - 1) < 1e-9 and lanes[2].y == 140, 'normalised heading, nearest first')
  assert(fake.request.trail ~= nil and fake.request.destination.x == 130)
`));

test('the road end point is the point of the lane nearest to V, not the traffic car itself', () => run(`
  fake.vehicles = {
    {id = 'ahead', x = 130, y = 230, lane = true, hx = 1, hy = 0},   -- 42 m away, on a street running east-west 30 m north of V
    {id = 'cross', x = 160, y = 200, lane = true, hx = 0, hy = 1},   -- the crossing street runs through x = 160: 60 m from V
  }
  local result = here()
  assert(result.roadHow == 'traffic' and math.abs(result.road.x - 100) < 1e-6 and math.abs(result.road.y - 230) < 1e-6, result.road.x .. ',' .. result.road.y)
  assert(result.roadNote:find('lane point 30 m'), result.roadNote)
`));

test('a lane too far to walk from is not the road end point, but still offers its lane for the car spot', () => run(`
  fake.vehicles = {{id = 'a', x = 100, y = 290, lane = true, hx = 1, hy = 0}}   -- 90 m, on a street running east-west
  local result = here()
  assert(result.roadHow == 'guess' and result.road.x == 100 and result.road.y == 200, tostring(result.roadHow))
  assert(result.roadNote:find('traffic=1/1 nearest 90 m'), result.roadNote)
  world.findSpot({key = 'judy', road = result.road, dest = V, spotTries = 0}, 'car')
  assert(#fake.request.lanes == 1)
`));

test('no traffic: the intersection the engine names ahead is used within 150 m; zero, far, unreadable or a failed call end in the spot V stands on', () => run(`
  fake.intersection = {x = 160, y = 260, z = 5}
  local result = here()
  assert(result.roadHow == 'intersection' and result.road.x == 160 and result.roadNote:find('traffic=0/0') and result.roadNote:find('intersection=160,260,5'), result.roadNote)
  for _, case in ipairs({{{x = 0, y = 0, z = 0}, 'intersection=zero'}, {{x = 900, y = 900, z = 0}, 'intersection=far:'}, {nil, 'intersection=none'},
      {'error', 'intersection=error'}, {false, 'intersection=none'}}) do
    fake.intersection = case[1]
    result = here()
    assert(result.roadHow == 'guess' and result.road.x == 100 and result.road.y == 200 and result.roadNote:find(case[2], 1, true), tostring(case[2]) .. ': ' .. result.roadNote)
  end
`));

test('a targeting query that fails is a note, not an error, and the road is still the spot V stands on', () => run(`
  fake.targetFails = true
  local result = here()
  assert(result.roadHow == 'guess' and result.roadNote:find('traffic=0/0') and result.roadNote:find('targeting is down'), result.roadNote)
`));

test('a road that is too far or has no path is no road, and the census is not asked', () => run(`
  fake.road = {point = {x = 400, y = 200, z = 5}, pathLength = 300}
  local result = here()
  assert(result.road == nil and result.roadWhy:find('far:') and fake.queries == 0)
  fake.road = {point = {x = 110, y = 200, z = 5}, pathLength = -1}
  result = here()
  assert(result.road == nil and result.roadWhy == 'no-path' and fake.queries == 0)
`));

// Her own car may be unavailable for a while (a story pack, mod/bonds.lua vehicleBlocked): she arrives on foot, and only a character who owns a car can lose it.
test('a blocked personal car makes her walk; the ordinary car, an unblocked owner and an unknown hook do not', () => run(`
  local realDofile = dofile
  dofile = function(name)
    if name == 'companion-vehicle-catalog.lua' then return (function() ${catalogSource} end)() end
    return realDofile(name)
  end
  local blocked = {}
  local defs = {panam = {id = 'Character.Panam'}, judy = {id = 'Character.Judy'}, rita = {id = 'Character.Rita'}}
  local companions = {definition = function(key) return defs[key] end, findCarSpot = function() return nil, 'none' end,
    vehicleBlocked = function(profileKey) return blocked[profileKey] == true end}
  local w = World.new({companions = companions})
  local catalog = (function() ${catalogSource} end)()
  assert(w.carBlocked({key = 'panam'}) == false and w.carChoice({key = 'panam'}).name == "Panam's truck")
  blocked['panam-palmer'] = true
  assert(w.carBlocked({key = 'panam'}) == true, 'her truck is not available')
  assert(w.carChoice({key = 'panam'}) == catalog.fallback or w.carChoice({key = 'panam'}).record == catalog.fallback.record, 'and if asked anyway, it is not her truck')
  assert(w.carBlocked({key = 'judy'}) == false and w.carChoice({key = 'judy'}).name == "Judy's van", 'another owner')
  blocked['rita-wheeler'] = true
  assert(w.carBlocked({key = 'rita'}) == false, 'a character with no personal car has nothing to lose: she arrives in the ordinary car')
  assert(w.carBlocked({key = 'nobody'}) == false)
  companions.vehicleBlocked = function() error('boom') end
  assert(w.carBlocked({key = 'panam'}) == false, 'a raising hook blocks nothing')
  companions.vehicleBlocked = nil
  assert(w.carBlocked({key = 'panam'}) == false and w.carChoice({key = 'panam'}).name == "Panam's truck", 'no hook: nothing is blocked')
`));
