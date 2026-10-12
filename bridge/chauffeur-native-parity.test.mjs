import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkFixture, lit, luaEncoder, moduleSource, recordCases, vm} from './native-recorder.mjs';

// Parity recorder for the native chauffeur system (native/core/src/systems/chauffeur,
// mod/companion-chauffeur-native.lua: M.sample on a leased car and M.inspectDrive).
//
// The recorder runs the ORIGINAL Lua against a fake game whose answers come from a "raw" object, one
// field per field of the C++ raw structs (ChauffeurCore.hpp: ActorRaw, PlayerRaw, SummonRaw, CarRaw,
// AutoRaw, WaypointRaw, DriveRaw), so every case says exactly what the plugin's game reads would
// have returned. It writes the raw reads and the wire text each section must produce, derived from
// the tables the Lua returned (the encoder below is the specification of the format), to
// native/core/tests/fixtures/chauffeur-sample.json and chauffeur-drive.json. The C++ test builds the
// structs from the same raw object and requires the same wire text. The shim tests (second half)
// feed those wires to the shim through a fake ConvaiNativeChauffeur.
//
// Two values are not observable in the Lua tables and come from the raw object instead: the car
// position of the C section (the Lua only keeps the distance to the destination) and the raw
// destination name of the W section (the Lua keeps the localized name).

const source = moduleSource('companion-chauffeur-native.lua');
const DRIVE = 'AIVehicleDriveToPointAutonomousCommand';
const STATES = ['NotExecuting', 'Enqueued', 'Executing', 'Cancelled', 'Interrupted', 'Success', 'Failure'];

const world = `
${luaEncoder}
NameToString = function(value) return value end
CName = {new = function(s) return s end}
Enum = {new = function(_, s) return s end}
EntityID = {new = function() return {hash = '0ULL'} end}
NewObject = function() return nil end
Vector3 = {new = function(x, y, z) return {x = x, y = y, z = z} end}
Vector4 = {new = function(x, y, z, w) return {x = x, y = y, z = z, w = w} end}
local STATES = ${lit(STATES)}
local DESTINATIONS = {[0] = 'None', [1] = 'PlayerTracked', [2] = 'Quest'}
local function hash(id) return (id or '0') .. 'ULL' end
CALLS, TOTAL = {}, 0
-- Wraps every function of a fake so the tests can count the game calls a path makes.
local function counted(tbl)
  for key, value in pairs(tbl) do
    if type(value) == 'function' then
      tbl[key] = function(...) TOTAL = TOTAL + 1; CALLS[key] = (CALLS[key] or 0) + 1; return value(...) end
    end
  end
  return tbl
end

function build(c)
  local raw = c.raw
  ASKED = false
  local drive = raw.drive
  -- one AutoDrive system answers GetAutodriveEnabled for both sections of a sample
  assert(c.kind == 'drive' or drive.enabled == raw.auto.enabled, 'AutoDrive enabled differs between the sections')
  local autoEnabled = raw.auto.enabled
  if c.kind == 'drive' then autoEnabled = drive.enabled end
  assert(raw.waypoint.tracked == (raw.auto.destination ~= 0) and raw.waypoint.quest == (raw.auto.destination == 2)
    and raw.waypoint.id == raw.auto.destinationId, 'the waypoint raw follows the AutoDrive destination')

  local function command(read)
    if not read.present then return nil end
    return {id = read.id, GetClassName = function() return read.className end}
  end
  local current, direct, initial, given = command(drive.current), command(drive.direct), command(drive.initial), command(drive.given)
  local function active(id) ASKED = true; return drive.active == true end
  local ai = {
    GetReservedSeatsCount = function() if drive.typesValid then return drive.reservations end return 'many' end,
    GetInitCmd = function() return initial end,
    GetEnqueuedOrExecutingCommand = function(_, name, inherit)
      if name == 'AIVehicleCommand' and inherit == true then return current end
      assert(name == '${DRIVE}' and inherit == false, 'unexpected command query ' .. tostring(name))
      return direct
    end,
    IsCommandActive = function(_, id) return active(id) end,
    GetCommandState = function(_, handle) assert(handle == given or handle == direct) return STATES[drive.state + 1] end,
  }
  local carRaw = raw.car
  local car = {}
  car.IsAttached = function() return carRaw.live end
  car.IsVehicle = function() return true end
  car.IsPlayerVehicle = function() return true end
  car.IsDestroyed = function() return false end
  car.GetEntityID = function() return {hash = hash(carRaw.id)} end
  car.GetRecordID = function() return 'Vehicle.test' end
  car.GetRecord = function() return {DisplayName = function() return {key = 'name'} end,
    Type = function() return {Type = function() return carRaw.carValid and 'Car' or 'Bike' end} end} end
  car.GetWorldPosition = function() return carRaw.position end
  car.GetAIComponent = function() if drive.aiPresent then return ai end return nil end
  car.IsExecutingAnyCommand = function() return drive.executing end
  car.IsAutoDriveModeEnabled = function() if drive.typesValid then return drive.automatic end return nil end
  car.CommandsFromDriverEnabled = function() return drive.commands end
  car.IsPerformingSceneAnimation = function() return drive.scene end
  car.GetCurrentSlotLocalPathLength = function() return drive.pathLength end
  car.GetCurrentSlotLocalPathProgression = function() if drive.hasTelemetry then return drive.pathProgress end return 0 / 0 end

  counted(car); counted(ai)
  local a = raw.auto
  local vehicleEntity = a.vehicle ~= '0' and {GetEntityID = function() return {hash = hash(a.vehicle)} end} or nil
  local pin = {GetWorldPosition = function() if raw.waypoint.hasMarker then return raw.waypoint.marker end return nil end,
    GetDisplayName = function() return raw.waypoint.rawName end}
  AUTO = {
    GetAutodriveEnabled = function() return autoEnabled end,
    GetAutodriveIsDelamain = function() return a.delamain end,
    GetAutodriveVehicle = function() return vehicleEntity end,
    GetAutodriveAvailable = function() return a.available end,
    CheckCurrentLaneValidity = function() return a.laneValid and 'OnValidLane' or 'OffLane' end,
    GetAutodriveDestinationMappinID = function() return {value = hash(a.destinationId)} end,
    GetAutodriveDestination = function() if raw.waypoint.hasDestination then return raw.waypoint.destination end return nil end,
    GetAutodriveDestinationType = function() return DESTINATIONS[a.destination] end,
    GetFreeRoamEnabled = function() return a.freeRoam end,
    GetDistanceToCurrentDestination = function() return a.remaining end,
  }
  counted(AUTO); counted(pin)
  local actor = raw.actor
  local npc = {IsAttached = function() return actor.attached end, IsDeadNoStatPool = function() return actor.dead end,
    GetEntityID = function() return {hash = actor.sameEntity and '1001ULL' or '1002ULL'} end}
  OWNER = {IsReady = function() return actor.ownerReady end,
    IsManaged = function() return actor.managed end,
    IsTagged = function(_, _, tag) assert(tag == 'CyberpunkConvaiCompanion') return actor.tagged end}
  NPCPuppet = {IsInCombat = function() return actor.inCombat end}
  PLAYER = {GetEntityID = function() return {hash = hash(raw.player.id)} end, IsInCombat = function() return raw.player.combat end}
  PlayerPuppet = {GetCurrentVehicleState = function() return raw.player.passenger and 'Passenger' or 'Default' end}
  counted(npc); counted(OWNER); counted(PLAYER)
  Game = {
    GetDynamicEntitySystem = function() return actor.ownerPresent and OWNER or nil end,
    GetScriptableSystemsContainer = function() return {Get = function(_, name) assert(name == 'AutoDriveSystem') return AUTO end} end,
    GetAllBlackboardDefs = function() return {VehicleSummonData = {SummonedVehicleEntityID = 'id', SummonState = 'state'}} end,
    GetBlackboardSystem = function() return {Get = function() return {
      GetEntityID = function() return {hash = hash(raw.summon.summoned)} end,
      GetUint = function() return raw.summon.state end} end} end,
    GetMappinSystem = function() return {GetMappin = function(_, id)
      assert(id.value == hash(a.destinationId)) if raw.waypoint.pinPresent then return pin end return nil end} end,
    FindEntityByID = function(id) assert(id.hash == '2001ULL') return car end,
    GetLocalizedTextByKey = function() return 'Test vehicle' end,
  }
  counted(Game)
  local leased = {id = '2001ULL', entityID = {hash = '2001ULL'}, record = 'Vehicle.test', owned = false}
  local entry = {serial = 1, key = 'judy-alvarez', profileKey = 'panam-palmer', name = 'Judy', entityID = {hash = '1001ULL'},
    npc = actor.npcPresent and npc or nil, system = actor.ownerPresent and OWNER or nil}
  local operation
  if drive.hasOperation then
    operation = {carId = '2001ULL', handle = given, target = {x = 10, y = 20, z = 3}}
    if drive.hasReceipt then operation.driveReceipt = {id = drive.receiptId, class = drive.receiptClass} end
  end
  local api = {mounting = function() return nil end,
    inspect = function() return {ready = true, seats = {}, speed = 0, playerGap = 3, scene = false} end}
  return leased, entry, operation, api
end

local function stateNumber(name)
  for index, value in ipairs(STATES) do if value == name then return index - 1 end end
  error('unknown state ' .. tostring(name))
end
local function commandWord(value) if value == nil then return '-' end return num(value) end

-- "D ..." for a table inspectDrive returned.
function driveWire(d)
  if not d.known then
    local codes = {['Vehicle driving AI is unavailable.'] = 0, ['Vehicle control information is unavailable.'] = 1,
      ['The driving command identity is unavailable.'] = 2}
    assert(codes[d.error] ~= nil, 'unexpected drive error ' .. tostring(d.error))
    return 'D ' .. codes[d.error]
  end
  local state = '-'
  if d.state ~= nil then state = ASKED and '?' or tostring(stateNumber(d.state)) end
  return table.concat({'D 3', flag(d.ready), num(d.reservations), flag(d.busy), flag(d.foreign), flag(d.ownedActive), state,
    commandWord(d.commandId), commandWord(d.currentId), commandWord(d.remaining), d.currentClass or '-'}, ' ')
end

-- The scalar fields of a drive table (the game objects ai and entity are left out).
function driveSummary(d)
  return {known = d.known, error = d.error, ready = d.ready, reservations = d.reservations, busy = d.busy,
    foreign = d.foreign, ownedActive = d.ownedActive, state = d.state, commandId = d.commandId, currentId = d.currentId,
    currentClass = d.currentClass, remaining = d.remaining, distance = d.distance, hasAi = d.ai ~= nil, hasEntity = d.entity ~= nil}
end

function recordDrive(c)
  local leased, _, operation = build(c)
  local d = chauffeur.inspectDrive(leased, operation)
  assert(d.known or d.error ~= 'The borrowed car is unavailable.', 'drive cases use a live car')
  local out = driveSummary(d)
  out.asked = ASKED
  return {result = out, wires = {D = driveWire(d)}}
end

-- The scalar content of a sample table.
function sampleSummary(sample)
  local w, live, a = sample.waypoint, sample.car ~= nil, sample.auto
  return {actorValid = sample.actorValid, actorAttached = sample.actorAttached, actorDead = sample.actorDead,
    actorCalm = sample.actorCalm, carLive = live, carValid = sample.carValid, carId = live and sample.car.id or nil,
    carName = live and sample.car.name or nil, carRecord = live and sample.car.record or nil,
    infoReady = sample.info and sample.info.ready, name = w and w.name,
    drive = sample.drive and driveSummary(sample.drive) or nil,
    waypoint = w and {id = w.id, destinationType = w.destinationType, x = w.position.x, y = w.position.y, z = w.position.z,
      mx = w.markerPosition.x, my = w.markerPosition.y, mz = w.markerPosition.z} or nil,
    summonedId = sample.summonedId, summonState = sample.summonState, summonEnRoute = sample.summonEnRoute,
    playerId = sample.playerId, playerPassenger = sample.playerPassenger, playerCombat = sample.playerCombat,
    actorId = sample.actor.id, actorKey = sample.actor.key, actorName = sample.actor.name,
    auto = {enabled = a.enabled, delamain = a.delamain, available = a.available, laneValid = a.laneValid,
      playerTracked = a.playerTracked, questTracked = a.questTracked, freeRoam = a.freeRoam, remaining = a.remaining,
      vehicleId = a.vehicleId, destinationId = a.destinationId}}
end

function recordSample(c)
  local leased, entry, operation, api = build(c)
  local raw = c.raw
  local sample = chauffeur.sample(PLAYER, entry, leased, api, operation)
  local a = sample.auto
  local wires = {
    A = 'A ' .. flag(sample.actorAttached) .. ' ' .. flag(sample.actorDead) .. ' ' .. flag(sample.actorValid) .. ' ' .. flag(sample.actorCalm),
    P = 'P ' .. digits(sample.playerId) .. ' ' .. flag(sample.playerPassenger) .. ' ' .. flag(sample.playerCombat),
    S = 'S ' .. digits(sample.summonedId) .. ' ' .. num(sample.summonState),
    U = 'U ' .. flag(a.enabled) .. ' ' .. flag(a.delamain) .. ' ' .. flag(a.available) .. ' ' .. flag(a.laneValid) .. ' '
      .. (a.questTracked and 2 or a.playerTracked and 1 or 0) .. ' ' .. flag(a.freeRoam) .. ' ' .. num(a.remaining) .. ' '
      .. digits(a.vehicleId) .. ' ' .. digits(a.destinationId),
  }
  local live = sample.car ~= nil
  local position = raw.car.position
  local positionValid = raw.car.positionValid
  if live and sample.drive and (sample.waypoint or operation) then
    assert((sample.drive.distance ~= nil) == positionValid, 'the position check disagrees with the raw car')
  end
  wires.C = 'C ' .. flag(live) .. ' ' .. (live and digits(sample.car.id) or '0') .. ' ' .. flag(live and sample.carValid)
    .. ' ' .. flag(positionValid) .. ' ' .. (positionValid and (num(position.x) .. ' ' .. num(position.y) .. ' ' .. num(position.z)) or '0 0 0')
  if live then wires.D = driveWire(sample.drive) end
  local w = sample.waypoint
  if w then
    local name = raw.waypoint.rawName
    wires.W = 'W 1 ' .. digits(w.id) .. ' ' .. num(w.position.x) .. ' ' .. num(w.position.y) .. ' ' .. num(w.position.z) .. ' '
      .. num(w.markerPosition.x) .. ' ' .. num(w.markerPosition.y) .. ' ' .. num(w.markerPosition.z) .. ' '
      .. flag(w.destinationType == 'Quest') .. ' ' .. (name == '' and '-' or name)
  else wires.W = 'W 0' end
  local order = {'A', 'P', 'C'}
  if live then order[#order + 1] = 'D' end
  order[#order + 1] = 'U'; order[#order + 1] = 'W'
  local parts = {}
  for _, tag in ipairs(order) do parts[#parts + 1] = wires[tag] end
  return {result = sampleSummary(sample),
    wires = wires, wire = table.concat(parts, ' ')}
end
`;

// ---- the cases ---------------------------------------------------------------------------------
const command = (id, className = DRIVE) => ({present: true, id, className});
const none = {present: false, id: 0, className: ''};
const base = () => ({
  actor: {npcPresent: true, attached: true, dead: false, sameEntity: true, ownerPresent: true, ownerReady: true,
    managed: true, tagged: true, inCombat: false},
  player: {id: '1', passenger: true, combat: false},
  summon: {summoned: '2001', state: 0},
  car: {live: true, id: '2001', carValid: true, positionValid: true, position: {x: 0, y: 0, z: 3}},
  auto: {enabled: false, delamain: false, available: true, laneValid: true, destination: 1, freeRoam: false, remaining: 99,
    vehicle: '0', destinationId: '3001'},
  waypoint: {tracked: true, quest: false, id: '3001', pinPresent: true, hasDestination: true, destination: {x: 10, y: 20, z: 3},
    hasMarker: true, marker: {x: 10, y: 20, z: 4.2}, rawName: 'Waypoint'},
  drive: {aiPresent: true, typesValid: true, hasOperation: true, hasReceipt: true, receiptId: 1801, receiptClass: DRIVE,
    current: command(1801), direct: command(1801), initial: none, given: command(1801), executing: true, automatic: false,
    enabled: false, commands: true, scene: false, reservations: 0, state: 2, activeCheck: -1, hasTelemetry: true,
    pathLength: 100, pathProgress: 10, active: false},
});
const merge = (target, patch) => {
  for (const [key, value] of Object.entries(patch)) {
    target[key] = value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object'
      && !('present' in value) ? merge(target[key], value) : value;
  }
  return target;
};
const withRaw = patch => (Array.isArray(patch) ? patch : [patch]).reduce(merge, base());
const destination = (kind, id = '3001') => ({auto: {destination: kind, destinationId: id},
  waypoint: {tracked: kind !== 0, quest: kind === 2, id}});
const idle = {current: none, direct: none, initial: none, given: none, executing: false, hasOperation: false, hasReceipt: false,
  receiptId: 0, receiptClass: ''};

function sampleCases() {
  const list = [];
  const add = (name, patch = {}) => list.push({name, input: {kind: 'sample', raw: withRaw(patch)}});
  add('a trip under way with a valid actor');
  add('no operation yet: the pre-departure sample', {drive: idle});
  add('the npc is gone', {actor: {npcPresent: false, attached: false}});
  add('the npc is detached', {actor: {attached: false}});
  add('the npc is dead', {actor: {dead: true}});
  add('the npc is another entity', {actor: {sameEntity: false}});
  add('no entity system', {actor: {ownerPresent: false}});
  add('the entity system is not ready', {actor: {ownerReady: false}});
  add('the npc is not managed', {actor: {managed: false}});
  add('the npc is not tagged', {actor: {tagged: false}});
  add('the npc is in combat', {actor: {inCombat: true}});
  add('V is not a passenger', {player: {passenger: false}});
  add('V is in combat', {player: {combat: true}});
  add('V has a large entity id', {player: {id: '4294967297'}});
  add('the summoned vehicle is en route', {summon: {state: 1}});
  add('no summoned vehicle', {summon: {summoned: '0', state: 0}});
  add('a summon state above one', {summon: {state: 4}});
  add('the leased car is not live', {car: {live: false, id: '0', carValid: false, positionValid: false, position: {x: 0, y: 0, z: 0}}});
  add('the car is not a Car', {car: {carValid: false}});
  add('the car position is out of range', {car: {positionValid: false, position: {x: 100000000, y: 0, z: 0}}});
  add('the car position is exactly at the limit', {car: {position: {x: 10000000, y: -10000000, z: 10000000}}});
  add('a car far from the destination', {car: {position: {x: -1500.25, y: 322.125, z: 7.5}}});
  add('AutoDrive is enabled for another journey', {auto: {enabled: true, delamain: true, vehicle: '9001'}, drive: {enabled: true}});
  add('AutoDrive is enabled and drives this car', {auto: {enabled: true, vehicle: '2001'}, drive: {enabled: true}});
  add('AutoDrive is not available', {auto: {available: false}});
  add('the car is off a valid lane', {auto: {laneValid: false}});
  add('free roam is on', {auto: {freeRoam: true}});
  add('a long route remaining', {auto: {remaining: 1234.5678901234567}});
  add('a Quest destination', [destination(2), {waypoint: {rawName: 'LocKey#36647'}}]);
  add('a quest destination with a plain name', [destination(2), {waypoint: {rawName: 'Pacifica Dive'}}]);
  add('no destination selected', destination(0, '0'));
  add('a destination without a mappin id', destination(1, '0'));
  add('the map pin is gone', {waypoint: {pinPresent: false}});
  add('no native destination point', {waypoint: {hasDestination: false}});
  add('no marker position', {waypoint: {hasMarker: false}});
  add('the destination point is out of range', {waypoint: {destination: {x: 20000000, y: 20, z: 3}}});
  add('the marker is out of range', {waypoint: {marker: {x: 10, y: -20000000, z: 3}}});
  add('an empty destination name', {waypoint: {rawName: ''}});
  add('a destination name with several words', {waypoint: {rawName: 'North Oak Overpass - Westbrook'}});
  add('a different destination point', {waypoint: {destination: {x: -1691.3070068359, y: -603.80609130859, z: 7.6229648590088}}});
  add('the drive AI is missing', {drive: {aiPresent: false}});
  add('vehicle control information is unreadable', {drive: {typesValid: false}});
  add('a foreign vehicle command is current', {drive: {current: command(9001, 'AIVehicleFollowCommand'), direct: none}});
  add('the AI is still preparing the first command', {drive: {current: none, direct: none, initial: command(1801), given: command(1801), executing: false}});
  add('a scene took the car', {drive: {scene: true}});
  add('driver commands are disabled', {drive: {commands: false}});
  add('a seat is reserved', {drive: {reservations: 1}});
  add('no path telemetry', {drive: {hasTelemetry: false}});
  add('V is the destination already', {drive: {pathProgress: 120}});
  return list;
}

function driveCases() {
  const list = [];
  const add = (name, drive = {}) => list.push({name, input: {kind: 'drive', raw: withRaw({drive})}});
  add('the owned command is current and executing');
  add('no operation: an idle car', idle);
  add('no operation: an idle car with a foreign current command', {...idle, current: command(9001, 'AIVehicleFollowCommand')});
  add('no operation: a command in the init slot', {...idle, initial: command(7)});
  add('no operation: the car is executing something', {...idle, executing: true});
  add('no operation: AutoDrive is on', {...idle, enabled: true});
  add('no operation: the car drives itself', {...idle, automatic: true});
  add('an operation without a receipt', {hasReceipt: false, receiptId: 0, receiptClass: '', given: none, direct: none, current: none});
  add('the AI is missing', {aiPresent: false});
  add('the control information is unreadable', {typesValid: false});
  add('the held handle is not Executing but Success', {state: 5});
  add('the held handle is Enqueued', {state: 1});
  add('the held handle is NotExecuting', {state: 0});
  add('the held handle is Cancelled', {state: 3});
  add('the held handle is Interrupted', {state: 4});
  add('the held handle is Failure', {state: 6});
  add('the held handle has another id: IsCommandActive decides (active)', {given: command(1802), active: true});
  add('the held handle has another id: IsCommandActive decides (gone)', {given: command(1802), active: false});
  add('the held handle has another class', {given: command(1801, 'AIVehicleFollowCommand'), active: true});
  add('no held handle, the owned command is current', {given: none});
  add('no held handle and nothing owned is current: IsCommandActive (active)', {given: none, direct: none, current: none, executing: false, active: true});
  add('no held handle and nothing owned is current: IsCommandActive (gone)', {given: none, direct: none, current: none, executing: false, active: false});
  add('the direct command has another id', {direct: command(1803), given: none, active: false});
  add('the direct command has another class', {direct: command(1801, 'AIVehicleFollowCommand'), given: none, active: true});
  add('the current command is the receipt', {current: command(1801), direct: command(1801)});
  add('the current command is foreign and the owned one is also there', {current: command(9001, 'AIVehicleFollowCommand')});
  add('the init command is foreign', {initial: command(9001, 'AIVehicleFollowCommand')});
  add('the init command is the receipt', {initial: command(1801)});
  add('the car is executing and owns the command', {executing: true});
  add('the car is executing and the owned command is not current', {direct: none, given: command(1801), executing: true});
  add('AutoDrive is enabled', {enabled: true});
  add('the car drives itself', {automatic: true});
  add('the unassigned command id is no id', {current: command(4294967295, 'AIVehicleFollowCommand'), direct: none, given: none, active: false});
  add('a command id of zero is a real id', {current: command(0, 'AIVehicleFollowCommand'), direct: none, given: none, active: false});
  add('a large command id', {current: command(4294967294, 'AIVehicleFollowCommand'), direct: none, given: none, active: false});
  add('a scene is playing', {scene: true});
  add('driver commands are off', {commands: false, scene: true});
  add('several seats are reserved', {reservations: 3});
  add('no path telemetry', {hasTelemetry: false});
  add('the car has passed the end of its path', {pathProgress: 150});
  add('the path is fully driven', {pathProgress: 100});
  add('a fractional path remaining', {pathLength: 120.37, pathProgress: 33.2});
  return list;
}

const recorded = {
  sample: recordCases({prelude: `${world}\nchauffeur = (function() ${source}\nend)()`, cases: sampleCases(), system: 'chauffeur',
    source: 'mod/companion-chauffeur-native.lua', record: 'recordSample'}),
  drive: recordCases({prelude: `${world}\nchauffeur = (function() ${source}\nend)()`, cases: driveCases(), system: 'chauffeur',
    source: 'mod/companion-chauffeur-native.lua', record: 'recordDrive'}),
};

test('the chauffeur-sample parity fixture matches mod/companion-chauffeur-native.lua', () => {
  checkFixture('chauffeur-sample', recorded.sample, 'Lua chauffeur sample changed');
});
test('the chauffeur-drive parity fixture matches mod/companion-chauffeur-native.lua', () => {
  checkFixture('chauffeur-drive', recorded.drive, 'Lua chauffeur drive inspection changed');
});

test('the recorded cases cover every status and branch of the original', () => {
  const drives = recorded.drive.cases.map(item => item.output.wires.D);
  for (const prefix of ['D 0', 'D 1', 'D 2', 'D 3']) assert.ok(drives.some(wire => wire.startsWith(prefix + (prefix === 'D 3' ? ' ' : ''))), prefix);
  const states = new Set(drives.filter(wire => wire.startsWith('D 3')).map(wire => wire.split(' ')[7]));
  for (const state of ['-', '?', '0', '1', '2', '3', '4', '5', '6']) assert.ok(states.has(state), `state ${state}`);
  assert.ok(recorded.sample.cases.some(item => !item.output.result.carLive), 'a car that is not live');
  assert.ok(recorded.sample.cases.some(item => item.output.wires.W === 'W 0'), 'no waypoint');
  assert.ok(recorded.sample.cases.some(item => item.output.wires.W.startsWith('W 1')), 'a waypoint');
  assert.ok(recorded.sample.cases.some(item => item.output.result.actorCalm), 'a calm actor');
});

test('a sample answers sections in the documented order', () => {
  for (const item of recorded.sample.cases) {
    const tags = item.output.wire.split(' ').filter(token => /^[A-Z]$/.test(token));
    const live = item.output.result.carLive;
    assert.deepEqual(tags.slice(0, live ? 6 : 5), live ? ['A', 'P', 'C', 'D', 'U', 'W'] : ['A', 'P', 'C', 'U', 'W'], item.name);
  }
});


const json = value => JSON.stringify(value);

// ---- the shim against a fake plugin ------------------------------------------------------------
const shimWorld = `${world}
nativeOn, fails, SAMPLE_ARGS, DRIVE_ARGS, SAMPLE_WIRES, DRIVE_WIRES, NOTES = true, {}, {}, {}, {}, {}, {}
convaiNative = {
  use = function(name) return name == 'chauffeur' and nativeOn end,
  fail = function(name, why) fails[#fails + 1] = name .. ': ' .. (tostring(why):gsub('[%c"]', '?')); nativeOn = false end,
}
io = {open = function() return {write = function(_, ...) for _, part in ipairs({...}) do NOTES[#NOTES + 1] = part end end,
  close = function() return true end} end}
local function reply(list, args, ...)
  args[#args + 1] = {...}
  local wire = list[#args]
  if wire == 'error' then error('boom') end
  return wire
end
ConvaiNativeChauffeur = {
  Sample = function(...) return reply(SAMPLE_WIRES, SAMPLE_ARGS, ...) end,
  Drive = function(...) return reply(DRIVE_WIRES, DRIVE_ARGS, ...) end,
}
function prepare(o)
  nativeOn, fails, SAMPLE_ARGS, DRIVE_ARGS, NOTES = o.off ~= true, {}, {}, {}, {}
  SAMPLE_WIRES, DRIVE_WIRES = o.wires or {}, o.driveWires or {}
  if o.noClass then ConvaiNativeChauffeur = nil end
  -- verify = 'file' is runtime/native-verify.txt naming the system (api.verifying), not the Lua test hook
  convaiNative.chauffeurVerify = o.verify == true or nil
  convaiNative.verifying = o.verify == 'file' and function(name) return name == 'chauffeur' end or nil
  convaiNative.chauffeurStats = nil
  if o.trusted ~= false then
    convaiNative.chauffeurStats = {native = 0, lua = 0, fallback = 0, empty = 0, emptySample = 0, emptyDrive = 0, verifiedSample = 99,
      verifiedDrive = 99, compared = 0, mismatches = 0}
  end
  return (function() ${source}
  end)()
end
function report(extra)
  extra.fails, extra.stats, extra.total, extra.calls = fails, convaiNative.chauffeurStats, TOTAL, CALLS
  extra.notes = (table.concat(NOTES):gsub('[^%w %.:=%-]', '?'))
  extra.sampleCalls, extra.driveCalls = #SAMPLE_ARGS, #DRIVE_ARGS
  extra.sampleArgs, extra.driveArgs = SAMPLE_ARGS[1] and {SAMPLE_ARGS[1][6], SAMPLE_ARGS[1][7], SAMPLE_ARGS[1][8],
    SAMPLE_ARGS[1][9], SAMPLE_ARGS[1][10], SAMPLE_ARGS[1][11], SAMPLE_ARGS[1][5] ~= nil} or nil,
    DRIVE_ARGS[1] and {DRIVE_ARGS[1][2], DRIVE_ARGS[1][4], DRIVE_ARGS[1][5], DRIVE_ARGS[1][6], DRIVE_ARGS[1][7], DRIVE_ARGS[1][3] ~= nil} or nil
  return extra
end

function shimSample(c, o)
  o = o or {}
  local mod = prepare(o)
  local leased, entry, operation, api = build(c)
  if o.noLease then leased = nil end
  if o.recordMismatch then leased.record = 'Vehicle.other' end
  if o.names then
    -- count the localization calls of a car name across two samples
    local calls = 0
    Game.GetLocalizedTextByKey = function() calls = calls + 1 return 'Test vehicle' end
    mod.sample(PLAYER, entry, leased, api, operation)
    local second = mod.sample(PLAYER, entry, leased, api, operation)
    return report({summary = sampleSummary(second), localizations = calls})
  end
  if o.localize then GetLocalizedText = function(key) assert(key == 'LocKey#36647') return 'Selected quest title' end end
  TOTAL, CALLS = 0, {}
  local sample = mod.sample(PLAYER, entry, leased, api, operation)
  return report({summary = sampleSummary(sample)})
end

function shimDrive(c, o)
  o = o or {}
  local mod = prepare(o)
  local leased, _, operation = build(c)
  if o.noEntity then Game.FindEntityByID = function() return nil end end
  if o.recordMismatch then leased.record = 'Vehicle.other' end
  if o.otherCar and operation then operation.carId = '9999ULL' end
  TOTAL, CALLS = 0, {}
  local d = mod.inspectDrive(leased, operation)
  local out = driveSummary(d)
  out.asked = ASKED
  return report({summary = out})
end
`;

function shimRun(code) {
  const sandbox = vm();
  sandbox.run(shimWorld);
  sandbox.run(`OUT = enc((function() ${code} end)())`);
  const out = JSON.parse(sandbox.read('OUT'));
  sandbox.close();
  return out;
}
const named = (set, name) => set.cases.find(item => item.name === name);
const runSample = (item, options = {}) => shimRun(`return shimSample(${lit({...item.input, name: item.name})}, ${lit(options)})`);
const runDrive = (item, options = {}) => shimRun(`return shimDrive(${lit({...item.input, name: item.name})}, ${lit(options)})`);
const BASE = 'a trip under way with a valid actor';
const sampleOf = name => named(recorded.sample, name);
const driveOf = name => named(recorded.drive, name);
// The original sample asks the plugin for its inner drive read too: answer it with the recorded one.
const driveFor = item => Array(30).fill('1 ' + item.output.wires.D);
const withoutAsked = summary => Object.fromEntries(Object.entries(summary).filter(([key]) => key !== 'asked'));

test('the shim turns every recorded sample wire into the table the original built', () => {
  for (const item of recorded.sample.cases) {
    if (!item.output.result.carLive || item.output.wires.D === undefined) {
      const got = runSample(item, {wires: [item.output.wire]});
      assert.deepEqual(got.fails, [], item.name);
      assert.deepEqual(got.summary, item.output.result, item.name);
      continue;
    }
    const got = runSample(item, {wires: [item.output.wire]});
    assert.deepEqual(got.fails, [], item.name);
    assert.deepEqual(got.summary, item.output.result, item.name);
    assert.equal(got.sampleCalls, 1, item.name);
    assert.equal(got.stats.native, 1, item.name);
  }
});

test('a native sample makes a fraction of the game calls of the original', () => {
  const item = sampleOf(BASE);
  const native = runSample(item, {wires: [item.output.wire]});
  const lua = runSample(item, {off: true});
  assert.deepEqual(native.summary, lua.summary);
  assert.ok(lua.total >= 60, `the original makes ${lua.total} calls`);
  assert.ok(native.total <= 20, `the native path makes ${native.total} calls (${JSON.stringify(native.calls)})`);
  assert.equal(lua.sampleCalls, 0);
});

test('the plugin is told the ids, the entities and the command receipt of the trip', () => {
  const item = sampleOf(BASE);
  const got = runSample(item, {wires: [item.output.wire]});
  // actorHash, carHash, hasOperation, hasReceipt, receiptId, receiptClass, a held handle
  assert.deepEqual(got.sampleArgs, ['1001', '2001', true, true, 1801, DRIVE, true]);
  const idle = sampleOf('no operation yet: the pre-departure sample');
  assert.deepEqual(runSample(idle, {wires: [idle.output.wire]}).sampleArgs, ['1001', '2001', false, false, 0, '', false]);
});

test('a name is looked up once per car record', () => {
  const item = sampleOf(BASE);
  const got = runSample(item, {wires: [item.output.wire, item.output.wire], names: true});
  assert.equal(got.localizations, 1);
  assert.equal(got.summary.carName, 'Test vehicle');
});

test('a waypoint name that needs localization is localized like the original does', () => {
  const item = sampleOf('a Quest destination');
  const native = runSample(item, {wires: [item.output.wire], localize: true});
  const lua = runSample(item, {off: true, localize: true});
  assert.equal(native.summary.name, 'Selected quest title');
  assert.deepEqual(native.summary, lua.summary);
});

test('only a sample for a leased car goes native', () => {
  const item = sampleOf(BASE);
  const got = runSample(item, {wires: [item.output.wire], noLease: true, driveWires: driveFor(item)});
  assert.equal(got.sampleCalls, 0);
  assert.deepEqual(got.fails, []);
  assert.equal(got.summary.carLive, true); // the original selected the summoned car
});

test('the lease record check stays in Lua: a car with another record is not live', () => {
  const item = sampleOf(BASE);
  const native = runSample(item, {wires: [item.output.wire], recordMismatch: true});
  const lua = runSample(item, {off: true, recordMismatch: true});
  assert.equal(native.summary.carLive, false);
  assert.deepEqual(native.summary, lua.summary);
  assert.deepEqual(native.fails, []);
});

test('with the switch off the plugin is never called', () => {
  const item = sampleOf(BASE);
  const got = runSample(item, {off: true, wires: [item.output.wire]});
  assert.equal(got.sampleCalls, 0);
  assert.deepEqual(got.summary, item.output.result);
  const drive = driveOf('the owned command is current and executing');
  const off = runDrive(drive, {off: true, driveWires: ['1 ' + drive.output.wires.D]});
  assert.equal(off.driveCalls, 0);
});

test('the first samples of a session are compared with the original, which stays the answer', () => {
  for (const item of recorded.sample.cases) {
    const got = runSample(item, {wires: [item.output.wire], trusted: false});
    assert.deepEqual(got.fails, [], item.name);
    assert.deepEqual(got.summary, item.output.result, item.name);
    assert.equal(got.stats.verifiedSample, 1, item.name);
    assert.equal(got.stats.compared, 1, item.name);
  }
});

test('after eight matching samples the plugin is trusted', () => {
  const item = sampleOf(BASE);
  const got = shimRun(`
    local mod = prepare({trusted = false, wires = {${Array(10).fill(json(item.output.wire)).join(',')}}})
    local leased, entry, operation, api = build(${lit({...item.input, name: item.name})})
    local totals = {}
    for index = 1, 10 do
      TOTAL = 0
      mod.sample(PLAYER, entry, leased, api, operation)
      totals[index] = TOTAL
    end
    return report({totals = totals})`);
  assert.ok(got.totals.slice(0, 8).every(count => count >= 60));
  assert.ok(got.totals.slice(8).every(count => count <= 20));
  assert.equal(got.stats.verifiedSample, 8);
  assert.match(got.notes, /sample matched the Lua 8 times. now native/);
});

test('a plugin sample that differs from the original switches the system off and returns the original', () => {
  const item = sampleOf(BASE);
  const change = (from, to) => { assert.ok(item.output.wire.includes(from), from); return item.output.wire.replace(from, to); };
  const wires = [
    change('A 1 0 1 1', 'A 1 0 1 0'),
    change('P 1 1 0', 'P 1 0 0'),
    change('U 0 0 1 1 1 0 99', 'U 0 0 1 1 1 0 98'),
    change('W 1 3001 10 20 3', 'W 1 3001 11 20 3'),
    change('1801 1801 90', '1801 1801 91'),
    change('D 3 1 0 1 0 1 2', 'D 3 1 0 1 0 1 1'),
  ];
  for (const wire of wires) {
    const got = runSample(item, {wires: [wire], trusted: false});
    assert.equal(got.fails.length, 1, wire);
    assert.match(got.fails[0], /^chauffeur: sample differs from the Lua/);
    assert.deepEqual(got.summary, item.output.result, wire);
    assert.match(got.notes, /chauffeur MISMATCH in sample/);
  }
});

test('verify mode keeps comparing after the trust point', () => {
  const item = sampleOf(BASE);
  const got = runSample(item, {wires: [item.output.wire.replace('U 0 0 1 1 1 0 99', 'U 0 0 1 1 1 0 98')], verify: true});
  assert.equal(got.fails.length, 1);
});

test('a line in native-verify.txt keeps comparing after the trust point', () => {
  const item = sampleOf(BASE);
  const wire = item.output.wire.replace('U 0 0 1 1 1 0 99', 'U 0 0 1 1 1 0 98');
  assert.equal(runSample(item, {wires: [wire], verify: 'file'}).fails.length, 1);
  assert.equal(runSample(item, {wires: [wire]}).fails.length, 0, 'a trusted plugin is not compared without the line');
});

test('an empty answer or an unreadable section runs the original without a failure', () => {
  const item = sampleOf(BASE);
  for (const wire of ['', item.output.wire.replace('A 1 0 1 1', 'A !'), item.output.wire.replace('U 0 0 1 1 1 0 99 0 3001', 'U !'),
    item.output.wire.replace('C 1 2001 1 1 0 0 3', 'C !'), item.output.wire.replace(/ D 3 .*? U /, ' D ! U '),
    item.output.wire.replace(/ W .*$/, ' W !')]) {
    const got = runSample(item, {wires: [wire], driveWires: driveFor(item)});
    assert.deepEqual(got.fails, [], wire);
    assert.deepEqual(got.summary, item.output.result, wire);
    assert.equal(got.stats.empty, 1, wire);
  }
});

test('twenty empty answers in a row switch the system off', () => {
  const item = sampleOf(BASE);
  const got = shimRun(`
    local mod = prepare({wires = {}, driveWires = {}})
    local leased, entry, operation, api = build(${lit({...item.input, name: item.name})})
    for index = 1, 60 do DRIVE_WIRES[index] = ${json('1 ' + item.output.wires.D)} end
    for index = 1, 25 do SAMPLE_WIRES[index] = '' end
    for index = 1, 25 do mod.sample(PLAYER, entry, leased, api, operation) end
    return report({})`);
  assert.equal(got.fails.length, 1);
  assert.match(got.fails[0], /sample keeps answering unavailable/);
  assert.equal(got.sampleCalls, 20); // the 21st call finds the switch off
});

test('unreadable or throwing sample answers switch the system off and run the original', () => {
  const item = sampleOf(BASE);
  const wire = item.output.wire;
  for (const bad of ['garbage', 'A 1 0 1 1 P 1 1 0', wire.replace('A 1 0 1 1', 'A 1 0 1'), wire.replace('P 1 1 0', 'P 1 1'),
    wire.replace(/ U .* W /, ' U 0 0 W '), wire.replace(' W 1 3001 10 20 3 10 20 4.2 0 Waypoint', ' W 1 3001 10'),
    wire.replace(' D 3 1 0', ' D 3 1'), wire.replace(' D 3 1 0 1 0 1 2', ' D 3 1 0 1 0 1 9'), 'error']) {
    const got = runSample(item, {wires: [bad], driveWires: driveFor(item)});
    assert.equal(got.fails.length, 1, bad);
    assert.deepEqual(got.summary, item.output.result, bad);
    assert.equal(got.stats.fallback, 1, bad);
  }
});

test('without the plugin class the shim switches the system off and runs the original', () => {
  const item = sampleOf(BASE);
  const got = runSample(item, {noClass: true});
  assert.equal(got.fails.length, 1);
  assert.match(got.fails[0], /ConvaiNativeChauffeur is not registered/);
  assert.deepEqual(got.summary, item.output.result);
});

test('the shim turns every recorded drive wire into the table the original built', () => {
  for (const item of recorded.drive.cases) {
    const got = runDrive(item, {driveWires: ['1 ' + item.output.wires.D]});
    assert.deepEqual(got.fails, [], item.name);
    const expected = {...item.output.result, distance: undefined, hasAi: item.output.result.known, hasEntity: item.output.result.known};
    assert.deepEqual(withoutKeys(got.summary, ['distance']), withoutKeys(expected, ['distance']), item.name);
    assert.equal(got.driveCalls, 1, item.name);
  }
});

function withoutKeys(summary, keys) {
  return Object.fromEntries(Object.entries(summary).filter(([key, value]) => !keys.includes(key) && value !== undefined));
}

test('a native drive read makes a handful of game calls instead of about thirty', () => {
  const item = driveOf('the owned command is current and executing');
  const native = runDrive(item, {driveWires: ['1 ' + item.output.wires.D]});
  const lua = runDrive(item, {off: true});
  assert.ok(lua.total >= 20, `the original makes ${lua.total} calls`);
  assert.ok(native.total <= 6, `the native path makes ${native.total} calls (${JSON.stringify(native.calls)})`);
  assert.deepEqual(native.summary, lua.summary);
});

test('the drive read tells the plugin the receipt, and a lease of another car has no receipt', () => {
  const item = driveOf('the owned command is current and executing');
  const got = runDrive(item, {driveWires: ['1 ' + item.output.wires.D]});
  assert.deepEqual(got.driveArgs, ['2001', true, true, 1801, DRIVE, true]);
  const other = runDrive(item, {driveWires: ['1 D 2'], otherCar: true});
  assert.deepEqual(other.driveArgs.slice(1, 4), [true, false, 0]);
  assert.equal(other.summary.error, 'The driving command identity is unavailable.');
  assert.equal(other.summary.known, false);
});

test('a car that is gone, not live or of another record is unavailable', () => {
  const item = driveOf('the owned command is current and executing');
  const gone = runDrive(item, {noEntity: true, driveWires: ['0']});
  assert.equal(gone.summary.error, 'The borrowed car is unavailable.');
  assert.equal(gone.driveCalls, 0);
  const notLive = runDrive(item, {driveWires: ['0']});
  assert.equal(notLive.summary.error, 'The borrowed car is unavailable.');
  const record = runDrive(item, {recordMismatch: true, driveWires: ['1 ' + item.output.wires.D]});
  assert.equal(record.summary.error, 'The borrowed car is unavailable.');
  assert.deepEqual(record.fails, []);
});

test('the first drive reads of a session are compared with the original', () => {
  for (const item of recorded.drive.cases) {
    const got = runDrive(item, {driveWires: ['1 ' + item.output.wires.D], trusted: false});
    assert.deepEqual(got.fails, [], item.name);
    assert.equal(got.stats.verifiedDrive, 1, item.name);
    assert.deepEqual(withoutKeys(got.summary, ['distance']), withoutKeys({...item.output.result,
      hasAi: item.output.result.known, hasEntity: item.output.result.known}, ['distance']), item.name);
  }
  const item = driveOf('the owned command is current and executing');
  const bad = runDrive(item, {driveWires: ['1 ' + item.output.wires.D.replace('D 3 1 0 1 0 1 2', 'D 3 1 0 1 1 1 2')], trusted: false});
  assert.equal(bad.fails.length, 1);
  assert.match(bad.fails[0], /^chauffeur: inspectDrive differs from the Lua/);
  assert.match(bad.notes, /chauffeur MISMATCH in inspectDrive: drive.foreign/);
  assert.equal(bad.summary.foreign, false);
});

test('empty, unreadable and throwing drive answers run the original', () => {
  const item = driveOf('the owned command is current and executing');
  const wire = item.output.wires.D;
  const lua = runDrive(item, {off: true}).summary;
  const empty = runDrive(item, {driveWires: ['']});
  assert.deepEqual(empty.fails, []);
  assert.deepEqual(empty.summary, lua);
  for (const bad of ['garbage', '1 D 3 1 0', '1 ' + wire.replace('D 3', 'D 7'), '1 ' + wire.replace('2 1801', '9 1801'), 'error']) {
    const got = runDrive(item, {driveWires: [bad]});
    assert.equal(got.fails.length, 1, bad);
    assert.deepEqual(got.summary, lua, bad);
  }
});

test('without the plugin class inspectDrive runs the original', () => {
  const item = driveOf('the owned command is current and executing');
  const got = runDrive(item, {noClass: true});
  assert.equal(got.fails.length, 1);
  assert.equal(got.summary.known, true);
});
