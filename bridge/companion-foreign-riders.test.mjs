import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

// The native read behind the foreign-rider hold (mod/companion-vehicle-native.lua, M.foreignRiders; the policy is in
// mod/companion-vehicles.lua and tested in bridge/companion-vehicles.test.mjs; docs/COMPANION_VEHICLES_DESIGN.md, "Other mods' riders").
// Another mod seats its own followers in V's car the moment V gets in. This read counts them from the shared
// spawned-character service: managed by the dynamic entity system and not ours (the service decides that), in V's attitude
// group, friendly to V, near V, alive, not a machine, and standing outside every vehicle.
const native = readFileSync(new URL('../mod/companion-vehicle-native.lua', import.meta.url), 'utf8');
const policy = readFileSync(new URL('../mod/companion-vehicles.lua', import.meta.url), 'utf8');

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(status, lua.LUA_OK, error);
}

const world = `
dofile = function() return {useBudget = function() end, useSpatialBudget = function() end} end
function NameToString(value) return value end
TweakDBID = {new = function(value) return value end}
EntityID = {new = function() return {hash = '0ULL'} end}
Enum = {new = function(kind, name) return kind .. '.' .. name end}
function NewObject() return {} end
CARID = '77ULL'
FACILITY = {mounts = {}}
function FACILITY:GetMountingInfoSingleWithObjects(npc)
  local at = self.mounts[npc]
  if not at then return nil end
  return {parentId = {hash = at.vehicle}, slotId = {id = at.seat}}
end
Game = {GetMountingFacility = function() return FACILITY end, FindEntityByID = function(id) return ENTITIES and ENTITIES[id] end}
local mod = (function() ${native}
end)()

PLAYER_GROUP = 'player'
local playerAgent = {GetAttitudeGroup = function() return PLAYER_GROUP end}
player = {GetAttitudeAgent = function() return playerAgent end}
CALLS = {nearby = 0, radius = nil}

-- One nearby character: the fields the read looks at.
function person(options)
  options = options or {}
  local agent = {
    GetAttitudeGroup = function() return options.group or PLAYER_GROUP end,
    GetAttitudeTowards = function() return options.towards or 'EAIAttitude : AIA_Friendly (2)' end,
  }
  local npc = {}
  function npc:IsAttached() return options.attached ~= false end
  function npc:IsDeadNoStatPool() return options.dead == true end
  function npc:GetAttitudeAgent() return agent end
  NEXT_ID = (NEXT_ID or 100) + 1
  local id = {hash = tostring(NEXT_ID) .. 'ULL', n = NEXT_ID}
  function npc:GetEntityID() return id end
  if options.follower ~= nil then function npc:IsPlayerCompanion() return options.follower end end
  ENTITIES = ENTITIES or {}
  ENTITIES[id] = npc
  if options.drone ~= nil or options.mech ~= nil then
    function npc:IsMech() return options.mech == true end
    function npc:IsDrone() return options.drone == true end
  end
  if options.mounted then FACILITY.mounts[npc] = options.mounted end
  return {npc = npc}
end

function service(rows, failure)
  _G.convaiSpawnedCharacters = {nearby = function(self, p, radius)
    CALLS.nearby = CALLS.nearby + 1; CALLS.radius = radius
    if failure then error(failure) end
    return rows
  end}
end

function car(bike)
  local entity = {}
  function entity:GetRecord()
    return {Type = function() return {Type = function() return bike and 'gamedataVehicleType.Bike' or 'gamedataVehicleType.Car' end} end}
  end
  return {entity = entity, id = CARID}
end
`;

test('a friendly follower of V that stands outside every vehicle is a pending rider; one per character', () => run(`${world}
  service({person(), person(), person()})
  assert(mod.foreignRiders(player, car()) == 3)
  assert(CALLS.nearby == 1 and CALLS.radius == 50, tostring(CALLS.radius))
`));

test('only followers, or friendly characters of V group, that are alive and attached count', () => run(`${world}
  service({
    person(),                                                  -- friendly, V's group
    person({group = 'civilian'}),                              -- a roamer or a placed character: another attitude group
    person({towards = 'EAIAttitude : AIA_Hostile (0)'}),       -- an enemy
    person({towards = 'EAIAttitude : AIA_Neutral (1)'}),
    person({dead = true}), person({attached = false}),
  })
  assert(mod.foreignRiders(player, car()) == 1)
`));

test('a character that follows V (the engine follower role) counts whatever its attitude group reads', () => run(`${world}
  service({person({follower = true, group = 'civilian', towards = 'EAIAttitude : AIA_Neutral (1)'}),
           person({follower = false, group = 'civilian'}), person({follower = false})})
  local count, report = mod.foreignRiders(player, car())
  assert(count == 2, count)
  assert(#report.ids == 2)
  assert(report.rows[1].why == 'follower' and report.rows[1].counted == true)
  assert(report.rows[2].why == 'other-group' and report.rows[2].counted == false)
  assert(report.rows[3].why == 'friendly-group' and report.rows[3].counted == true)
`));

test('the report names who was counted and who not and why, with the distance, for probe.log', () => run(`${world}
  local keyed = person({dead = true}); keyed.key = 'judy-alvarez'; keyed.distance = 8.24
  local far = person({towards = 'EAIAttitude : AIA_Hostile (0)'}); far.entity = 5551234; far.distance = 30
  service({keyed, person({mounted = {vehicle = CARID, seat = 'seat_back_left'}}), far, person()})
  local count, report = mod.foreignRiders(player, car())
  assert(count == 1)
  local why = {}
  for _, row in ipairs(report.rows) do why[#why + 1] = row.why end
  assert(table.concat(why, ',') == 'dead,mounted,not-friendly,friendly-group', table.concat(why, ','))
  assert(report.rows[1].who == 'judy-alvarez' and report.rows[1].distance == 8.2)
  assert(report.rows[3].who == '5551234')
`));

test('foreignPending counts the counted characters that still stand outside every vehicle', () => run(`${world}
  service({person(), person(), person()})
  local count, report = mod.foreignRiders(player, car())
  assert(count == 3 and mod.foreignPending(report.ids) == 3)
  FACILITY.mounts[ENTITIES[report.ids[1]]] = {vehicle = CARID, seat = 'seat_front_right'}
  assert(mod.foreignPending(report.ids) == 2)
  ENTITIES[report.ids[2]] = nil                                -- gone from the world
  assert(mod.foreignPending(report.ids) == 1)
  assert(mod.foreignPending({}) == 0 and mod.foreignPending(nil) == 0)
`));

test('the spawned-character service is found as a global of the mod environment; without it the report says so', () => run(`${world}
  service({person()})
  assert(mod.foreignRiders(player, car()) == 1)
  _G.convaiSpawnedCharacters = nil
  local count, report = mod.foreignRiders(player, car())
  assert(count == 0 and report.why == 'no spawned-character service', tostring(report.why))
`));

test('a character already mounted anywhere is not pending: its seat is read from the car, a foreign car is not ours to plan', () => run(`${world}
  service({person({mounted = {vehicle = CARID, seat = 'seat_front_right'}}),
           person({mounted = {vehicle = '99ULL', seat = 'seat_front_left'}}), person()})
  assert(mod.foreignRiders(player, car()) == 1)
`));

test('drones and mechs never ride; a game without those reads still counts the person', () => run(`${world}
  service({person({drone = true}), person({mech = true}), person({drone = false, mech = false}), person()})
  assert(mod.foreignRiders(player, car()) == 2)
`));

test('a bike has no passenger seats for another mod either: nothing is held and nothing is asked', () => run(`${world}
  service({person(), person()})
  assert(mod.foreignRiders(player, car(true)) == 0 and CALLS.nearby == 0)
`));

test('without the spawned-character service, or without a vehicle, the answer is none', () => run(`${world}
  _G.convaiSpawnedCharacters = nil
  assert(mod.foreignRiders(player, car()) == 0)
  service({person()})
  assert(mod.foreignRiders(player, nil) == 0 and mod.foreignRiders(nil, car()) == 0 and mod.foreignRiders(player, {}) == 0)
`));

test('a failed lookup raises, so the policy keeps the ordinary seat choice; one unreadable character does not stop the count', () => run(`${world}
  service({}, 'no targeting system')
  local ok, err = pcall(mod.foreignRiders, player, car())
  assert(not ok and tostring(err):find('no targeting system', 1, true), tostring(err))
  local broken = {npc = {IsAttached = function() error('stale handle') end}}
  service({broken, person()})
  assert(mod.foreignRiders(player, car()) == 1)
`));

test('the read sends nothing and changes nothing: it only reads identity, attitude and mount state', () => {
  const body = native.slice(native.indexOf('function M.foreignRiders'), native.indexOf('function M.brake'));
  assert.ok(body.length > 200);
  assert.doesNotMatch(body, /SendCommand|:Teleport|SetAttitude|Mount\(|AIMountCommand|:Cancel|:Despawn|DeleteEntity/);
});

test('the policy takes the count from the adapter once, with the player and V car', () => run(`
  local catalog = {drives = function() return true end, choose = function() return nil, nil end, fallback = {}}
  dofile = function() return catalog end
  local transport = (function() ${policy} end)()
  local seen
  local car = {id = 'v-car', entityID = {hash = 'v-car'}, info = {ready = true, speed = 0,
    seats = {{name = 'seat_front_left', occupant = 'player'}, {name = 'seat_front_right'}, {name = 'seat_back_left'}}}}
  local api = {player = function() return car end, inspect = function() return car.info end,
    mounting = function() return nil end, mount = function() return {state = 'Executing'} end,
    commandState = function() return 'Executing' end, cancel = function() return true end,
    foreignRiders = function(p, c) seen = {p, c}; return 1 end}
  local fleet = transport.new(api)
  local player = {}
  local entries = {{serial = 1, key = 'a', npc = {}, entityID = {hash = 'npc-1'}, slot = 1}}
  transport.update(fleet, player, entries, 0.1, {release = function() return true end, resumed = function() end})
  assert(seen and seen[1] == player and seen[2] == fleet.primary)
  assert(fleet.people[1].seat == 'seat_back_left', tostring(fleet.people[1].seat))
`));

test('the service is read as a bare global of the mod environment first, and the fleet report reaches probe.log', () => {
  // Live 2026-10-19: rawget(_G, ...) alone found nothing in the game, so the first version counted nobody. A bare global read is
  // the form every other module uses for init.lua's globals; rawget(_G) stays as the second try.
  assert.match(native, /pcall\(function\(\) return convaiSpawnedCharacters end\)/);
  const companions = readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8');
  assert.match(companions, /fleet\.report = function\(kind, fields\)[^\n]*M\.recoveryLog, 'vehicle-' \.\. kind, fields/);
  assert.match(policy, /report\(s,'boarding'/);
  assert.match(policy, /report\(s,'exit-start'/);
});
