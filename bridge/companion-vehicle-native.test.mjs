import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkFixture, lit, luaEncoder, moduleSource, recordCases, vm} from './native-recorder.mjs';

// Parity recorder and shim checks for the native vehicles system
// (native/core/src/systems/vehicles, mod/companion-vehicle-native.lua: M.inspect and M.mounting).
//
// 1. The recorder runs the ORIGINAL Lua (no convaiNative) against a fake car and writes the raw game
//    reads, the tables the Lua returned and the wire text the plugin must answer with to
//    native/core/tests/fixtures/vehicles-inspect.json and vehicles-mounting.json.
// 2. The shim checks feed those wire texts to the shim through a fake ConvaiNativeVehicles and
//    require tables equal to the original's, then cover the switch, the faults and the verify mode.

const source = moduleSource('companion-vehicle-native.lua');
const MACKINAW = 'Vehicle.v_standard3_thorton_mackinaw_ncu_player';

// ---- the fake game ------------------------------------------------------------------------------
const world = `
${luaEncoder}
dofile = function() return {useBudget = function() end, useSpatialBudget = function() end} end
function NameToString(value) return value end
TweakDBID = {new = function(value) return value end}
EntityID = {new = function() return {hash = '0ULL'} end}
function NewObject() return {} end
CARID = '77ULL'
CALLS = {}
FACILITY = {}
Game = {GetMountingFacility = function() return FACILITY end}
function loadModule() return (function() ${source}
end)() end

-- Lua: the id helper's output with its suffix cut off.
function fakeCar(c)
  local seatsByName = {}
  for _, seat in ipairs(c.seats or {}) do seatsByName[seat.name] = seat end
  local ai = {IsSeatReserved = function(self, name) return seatsByName[name].reserved == true end}
  local entity = {}
  local function count(name) CALLS[name] = (CALLS[name] or 0) + 1 end
  function entity:IsAttached() count('IsAttached') return c.attached ~= false end
  function entity:IsVehicle() count('IsVehicle') return c.isVehicle ~= false end
  function entity:IsDestroyed() count('IsDestroyed') return c.destroyed == true end
  function entity:GetEntityID() count('GetEntityID') return {hash = CARID} end
  function entity:GetAIComponent() count('GetAIComponent') if c.ai then return ai end return nil end
  function entity:GetRecordID() count('GetRecordID') return c.mackinaw and '${MACKINAW}' or 'Vehicle.v_other' end
  function entity:HasOccupantSlot(name) count('HasOccupantSlot') return seatsByName[name].hasSlot == true end
  function entity:GetLinearVelocity() count('GetLinearVelocity') return {x = c.velocity[1], y = c.velocity[2], z = c.velocity[3]} end
  function entity:GetDistanceToPlayerSquared() count('GetDistanceToPlayerSquared') return c.distanceSquared end
  function entity:IsPlayerMounted() count('IsPlayerMounted') return c.playerMounted == true end
  function entity:IsPerformingSceneAnimation() count('IsPerformingSceneAnimation') return c.scene == true end
  function entity:GetRecord()
    count('GetRecord')
    return {VehDataPackage = function() return {VehSeatSet = function() return {VehSeats = function()
      local out = {}
      for index, seat in ipairs(c.seats or {}) do out[index] = {SeatName = function() return seat.name end} end
      return out
    end} end} end}
  end
  FACILITY.GetMountingInfoSingleWithIds = function(self, child, parent, slot)
    assert(child.hash == '0ULL' and parent.hash == CARID, 'the optional child ID must be explicit and empty')
    local seat = seatsByName[slot.id]
    if seat.noInfo then return nil end
    return {childId = {hash = (seat.occupant or '0') .. 'ULL'}}
  end
  Game.FindEntityByID = function() return entity end
  return entity
end

-- The wire text for what the original returned (the format of VehiclesCore.hpp).
function wireInspect(out)
  if out.ready == false then
    if out.invalid then return 'V 0' end
    if out.error then return 'V 1' end
    return 'V 3'
  end
  local parts = {'V 2', flag(out.invalid == true), flag(out.ai ~= nil), flag(out.playerMounted), flag(out.scene),
    num(out.speed), num(out.playerGap), #out.seats}
  for _, seat in ipairs(out.seats) do
    parts[#parts + 1] = seat.name
    parts[#parts + 1] = digits(seat.occupant)
    parts[#parts + 1] = flag(seat.reserved)
  end
  return table.concat(parts, ' ')
end

function summarize(out, vehicle)
  local result = {everAttached = vehicle.everAttached == true, wire = wireInspect(out)}
  if out.ready == false then
    result.status = out.invalid and 0 or out.error and 1 or 3
    result.error = out.error
  else
    result.status = 2
    result.invalid = out.invalid == true
    result.ai = out.ai ~= nil
    result.playerMounted, result.scene = out.playerMounted, out.scene
    result.speed, result.playerGap = out.speed, out.playerGap
    result.seats = {}
    for index, seat in ipairs(out.seats) do
      result.seats[index] = {name = seat.name, occupant = seat.occupant and digits(seat.occupant) or nil,
        reserved = seat.reserved}
    end
  end
  return result
end

function record(c)
  local mod = loadModule()
  local vehicle = {entity = fakeCar(c), owned = c.owned == true, entityID = {hash = CARID}}
  return summarize(mod.inspect(vehicle), vehicle)
end

function recordMounting(c)
  local mod = loadModule()
  local npc = {IsAttached = function() return c.attached ~= false end}
  FACILITY.GetMountingInfoSingleWithObjects = function(self, child)
    assert(child == npc)
    if c.info == 'none' then return nil end
    return {parentId = {hash = (c.parent or '0') .. 'ULL'}, slotId = {id = c.seat or 'seat_front_left'}}
  end
  local out = mod.mounting({npc = npc})
  local result = {}
  if out then result.mounted, result.vehicle, result.seat = true, digits(out.vehicle), out.seat
  else result.mounted = false end
  result.wire = out and ('M ' .. digits(out.vehicle) .. ' ' .. out.seat) or 'M -'
  return result
end
`;

// ---- the cases ---------------------------------------------------------------------------------
const CAR = ['seat_front_left', 'seat_front_right', 'seat_back_left', 'seat_back_right'];
const seat = (name, extra = {}) => ({name, hasSlot: true, occupant: null, reserved: false, ...extra});
const car = (names = CAR) => names.map(name => seat(name));

function inspectCases() {
  const cases = [];
  const add = (name, extra = {}) => cases.push({name, input: {
    attached: true, isVehicle: true, owned: false, destroyed: false, ai: true, mackinaw: false,
    seats: car(), velocity: [0, 0, 0], distanceSquared: 25, playerMounted: false, scene: false, ...extra}});
  add('a parked car with an AI and four free seats');
  add('no seats in the record', {seats: []});
  add('a bike with two seats', {seats: car(['seat_front', 'seat_back'])});
  add('eight seats', {seats: car(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8'])});
  add('the driver and a passenger sit', {seats: [seat('seat_front_left', {occupant: '1234567'}),
    seat('seat_front_right', {occupant: '7654321', reserved: true}), seat('seat_back_left'), seat('seat_back_right')]});
  add('a reserved seat without an occupant', {seats: [seat('seat_front_left', {reserved: true}),
    seat('seat_front_right')]});
  add('a 64-bit entity hash', {seats: [seat('seat_front_left', {occupant: '18446744073709551615'}),
    seat('seat_front_right', {occupant: '9007199254740993'})]});
  add('an occupant slot answered with no info', {seats: [seat('seat_front_left', {noInfo: true, occupant: '55'}),
    seat('seat_front_right', {occupant: '56'})]});
  add('seats the car has no slot for are skipped', {seats: [seat('seat_front_left'),
    seat('seat_front_right', {hasSlot: false, occupant: '9', reserved: true}), seat('seat_back_left')]});
  add('no AI component on a car the mod did not make', {ai: false, seats: [seat('seat_front_left', {occupant: '12'}),
    seat('seat_front_right', {reserved: true})]});
  add('a car the mod made, with its AI', {owned: true});
  add('a car the mod made, without its AI', {owned: true, ai: false});
  add('a car the mod made, destroyed, without its AI', {owned: true, ai: false, destroyed: true});
  add('a destroyed car with an AI', {destroyed: true});
  add('not a vehicle', {isVehicle: false});
  add('not a vehicle, owned, no AI', {isVehicle: false, owned: true, ai: false});
  add('detached', {attached: false});
  add('detached and owned', {attached: false, owned: true});
  add('the Mackinaw hides seat_back_right', {mackinaw: true, seats: car()});
  add('the Mackinaw keeps its other seats', {mackinaw: true, seats: [seat('seat_front_left', {occupant: '5'}),
    seat('seat_back_right', {occupant: '6', reserved: true}), seat('seat_back_left')]});
  add('the Mackinaw without that seat', {mackinaw: true, seats: car(['seat_front_left', 'seat_front_right'])});
  add('another car keeps seat_back_right', {mackinaw: false, seats: [seat('seat_back_right', {occupant: '6'})]});
  add('the Mackinaw seat without a slot', {mackinaw: true, seats: [seat('seat_back_right', {hasSlot: false})]});
  add('speed of a 3-4-0 velocity', {velocity: [3, 4, 0]});
  add('speed of a 2-3-6 velocity', {velocity: [2, 3, 6]});
  add('speed of a negative velocity', {velocity: [-1.5, -2.5, -0.5]});
  add('speed of float32-sized velocity', {velocity: [Math.fround(0.1), Math.fround(-7.3), Math.fround(0.0123)]});
  add('speed of a very fast car', {velocity: [310.25, -40.5, 12.125]});
  add('a tiny velocity', {velocity: [1e-12, 0, 0]});
  add('player gap of 0', {distanceSquared: 0});
  add('player gap of 100 m', {distanceSquared: 10000});
  add('player gap of a fraction', {distanceSquared: 0.3});
  add('a huge player gap', {distanceSquared: 1.5e9});
  add('a negative squared gap gives NaN', {distanceSquared: -4});
  add('V is in the car', {playerMounted: true});
  add('a scene has the car', {scene: true});
  add('V is in the car during a scene', {playerMounted: true, scene: true, destroyed: true});
  add('a full owned car at speed', {owned: true, velocity: [5, 0, 0], distanceSquared: 144, playerMounted: true,
    seats: [seat('seat_front_left', {occupant: '42', reserved: true}), seat('seat_front_right', {occupant: '43'})]});
  return cases;
}

function mountingCases() {
  const cases = [];
  const add = (name, extra = {}) => cases.push({name, input: {attached: true, info: 'parent', parent: '4294967297',
    seat: 'seat_front_left', ...extra}});
  add('mounted in the driver seat');
  add('mounted in a back seat', {seat: 'seat_back_right', parent: '12'});
  add('mounted to a 64-bit parent', {parent: '18446744073709551615'});
  add('no mounting info', {info: 'none'});
  add('a zero parent is not mounted', {info: 'zero', parent: '0'});
  add('detached', {attached: false});
  add('detached with a parent', {attached: false, parent: '99'});
  add('a bike seat', {seat: 'seat_front', parent: '300'});
  return cases;
}

const inspect = recordCases({prelude: world, cases: inspectCases(), system: 'vehicles',
  source: 'mod/companion-vehicle-native.lua'});
const mounting = recordCases({prelude: world, cases: mountingCases(), system: 'vehicles',
  source: 'mod/companion-vehicle-native.lua', record: 'recordMounting'});

test('the vehicles-inspect parity fixture matches mod/companion-vehicle-native.lua', () => {
  checkFixture('vehicles-inspect', inspect, 'Lua vehicle inspect changed');
});
test('the vehicles-mounting parity fixture matches mod/companion-vehicle-native.lua', () => {
  checkFixture('vehicles-mounting', mounting, 'Lua vehicle mounting changed');
});

test('the recorded cases cover every status of the original', () => {
  const statuses = new Set(inspect.cases.map(item => item.output.status));
  for (const status of [0, 1, 2, 3]) assert.ok(statuses.has(status), `status ${status}`);
  assert.ok(inspect.cases.some(item => item.output.seats?.some(row => row.occupant)));
  assert.ok(inspect.cases.some(item => item.output.playerGap === 'nan'));
  assert.ok(inspect.cases.some(item => item.output.seats?.length === 0));
  assert.ok(mounting.cases.some(item => item.output.mounted) && mounting.cases.some(item => !item.output.mounted));
});

test('the Mackinaw never lists seat_back_right and other cars do', () => {
  const find = text => inspect.cases.find(item => item.name === text).output.seats.map(row => row.name);
  assert.deepEqual(find('the Mackinaw hides seat_back_right'), CAR.slice(0, 3));
  assert.deepEqual(find('another car keeps seat_back_right'), ['seat_back_right']);
});



// ---- the shim against a fake plugin ------------------------------------------------------------
const shimWorld = `${world}
nativeOn, fails, nativeCalls, reply, mountReply = true, {}, {}, 'V 3', 'M -'
convaiNative = {
  use = function() return nativeOn end,
  fail = function(name, why) fails[#fails + 1] = name .. ': ' .. (tostring(why):gsub('[%c"]', '?')); nativeOn = false end,
}
io = {open = function() return {write = function() end, close = function() return true end} end}
local function answer(kind, value, ...)
  nativeCalls[#nativeCalls + 1] = kind
  if type(value) == 'function' then return value(...) end
  return value
end
ConvaiNativeVehicles = {
  Inspect = function(entity, owned) return answer('Inspect', reply, entity, owned) end,
  Mounting = function(npc) return answer('Mounting', mountReply, npc) end,
}
function reset(wire, options)
  options = options or {}
  nativeOn, fails, nativeCalls, CALLS = options.off ~= true, {}, {}, {}
  reply, mountReply = wire, wire
  convaiNative.vehiclesVerify = options.verify
  convaiNative.vehiclesStats = nil
  if options.trusted ~= false then
    convaiNative.vehiclesStats = {native = 0, lua = 0, fallback = 0, empty = 0, emptyRun_inspect = 0, emptyRun_mounting = 0, verified = 99, compared = 0, mismatches = 0}
  end
end
function total(counts) local sum = 0 for _, value in pairs(counts) do sum = sum + value end return sum end

function shimInspect(c, wire, options)
  reset(wire, options)
  local mod = loadModule()
  local vehicle = {entity = fakeCar(c), owned = c.owned == true, entityID = {hash = CARID}}
  local result = summarize(mod.inspect(vehicle), vehicle)
  result.nativeCalls, result.fails, result.calls, result.total = #nativeCalls, fails, CALLS, total(CALLS)
  return result
end
function shimInspectSeries(c, wire, times, options)
  reset(wire, options)
  local mod = loadModule()
  local vehicle = {entity = fakeCar(c), owned = c.owned == true, entityID = {hash = CARID}}
  local rows = {}
  for index = 1, times do
    CALLS = {}
    local result = summarize(mod.inspect(vehicle), vehicle)
    rows[index] = {wire = result.wire, game = total(CALLS) - (CALLS.GetEntityID or 0)}
  end
  return {rows = rows, fails = fails, stats = convaiNative.vehiclesStats}
end

function shimMounting(c, wire, options)
  reset(wire, options)
  local mod = loadModule()
  local facility = 0
  local npc = {IsAttached = function() return c.attached ~= false end, GetEntityID = function() return {hash = '5ULL'} end}
  FACILITY.GetMountingInfoSingleWithObjects = function(self, child)
    facility = facility + 1
    if c.info == 'none' then return nil end
    return {parentId = {hash = (c.parent or '0') .. 'ULL'}, slotId = {id = c.seat or 'seat_front_left'}}
  end
  local out = mod.mounting({npc = npc})
  return {mounted = out ~= nil, vehicle = out and digits(out.vehicle) or nil, seat = out and out.seat or nil,
    facility = facility, nativeCalls = #nativeCalls, fails = fails}
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
const caseNamed = (set, name) => set.cases.find(item => item.name === name);
const wireOf = item => item.output.wire;
const json = value => JSON.stringify(value);
const sansShim = out => Object.fromEntries(Object.entries(out).filter(([key]) =>
  !['nativeCalls', 'fails', 'calls', 'total'].includes(key)));
const sameOutput = (got, item) => assert.deepEqual(sansShim(got), item.output, item.name);
const luaTable = value => lit(value);

test('the shim turns every recorded wire into the table the original returned, with 2 game calls at most', () => {
  let checked = 0;
  for (const item of inspect.cases) {
    if (item.output.status === 3) continue;
    const got = shimRun(`return shimInspect(${luaTable(item.input)}, ${json(wireOf(item))})`);
    sameOutput(got, item);
    assert.equal(got.nativeCalls, 1, item.name);
    assert.deepEqual(got.fails, [], item.name);
    assert.ok(got.total <= 2, `${item.name}: ${got.total} game calls (${json(got.calls)})`);
    const names = Array.isArray(got.calls) ? [] : Object.keys(got.calls);
    assert.ok(names.every(key => ['GetEntityID', 'GetAIComponent'].includes(key)), item.name);
    checked++;
  }
  assert.ok(checked >= 35);
});

test('a detached answer runs the original, which re-resolves the entity', () => {
  const item = caseNamed(inspect, 'detached');
  const got = shimRun(`return shimInspect(${luaTable(item.input)}, ${json(wireOf(item))})`);
  sameOutput(got, item);
  assert.equal(got.nativeCalls, 1);
  assert.ok(got.calls.IsAttached >= 1, 'the original ran');
  assert.deepEqual(got.fails, []);
});

test('with the switch off the plugin is never called', () => {
  const item = caseNamed(inspect, 'a parked car with an AI and four free seats');
  const got = shimRun(`return shimInspect(${luaTable(item.input)}, ${json(wireOf(item))}, {off = true})`);
  sameOutput(got, item);
  assert.equal(got.nativeCalls, 0);
  assert.ok(got.total > 10);
});

test('the first answers of a session are compared with the original, then the plugin is trusted', () => {
  const item = caseNamed(inspect, 'a full owned car at speed');
  const got = shimRun(`return shimInspectSeries(${luaTable(item.input)}, ${json(wireOf(item))}, 12, {trusted = false})`);
  assert.deepEqual(got.fails, []);
  got.rows.forEach((row, index) => {
    assert.equal(row.wire, wireOf(item));
    if (index < 8) assert.ok(row.game > 10, `call ${index + 1} ran the original too`);
    else assert.ok(row.game <= 1, `call ${index + 1} was native only (${row.game})`);
  });
  assert.equal(got.stats.verified, 8);
  assert.equal(got.stats.native, 4);
});

test('a plugin answer that differs from the original switches the system off and returns the original', () => {
  const item = caseNamed(inspect, 'speed of a 3-4-0 velocity');
  const tokens = wireOf(item).split(' ');
  tokens[6] = '9';
  const got = shimRun(`return shimInspect(${luaTable(item.input)}, ${json(tokens.join(' '))}, {trusted = false})`);
  sameOutput(got, item);
  assert.equal(got.fails.length, 1);
  assert.match(got.fails[0], /^vehicles: inspect differs from the Lua/);

  const seats = caseNamed(inspect, 'the driver and a passenger sit');
  const other = wireOf(seats).replace('seat_front_left 1234567', 'seat_front_left 1234568');
  const second = shimRun(`return shimInspect(${luaTable(seats.input)}, ${json(other)}, {trusted = false})`);
  sameOutput(second, seats);
  assert.equal(second.fails.length, 1);
});

test('verify mode compares every call', () => {
  const item = caseNamed(inspect, 'V is in the car');
  const tokens = wireOf(item).split(' ');
  tokens[4] = '0'; // playerMounted
  const got = shimRun(`return shimInspect(${luaTable(item.input)}, ${json(tokens.join(' '))}, {verify = true})`);
  sameOutput(got, item);
  assert.equal(got.fails.length, 1);
});

test('an empty, unreadable or failing plugin answer runs the original', () => {
  const item = caseNamed(inspect, 'a parked car with an AI and four free seats');
  const input = luaTable(item.input);
  const empty = shimRun(`return shimInspect(${input}, '')`);
  sameOutput(empty, item);
  assert.deepEqual(empty.fails, []);
  assert.ok(empty.total > 10);

  for (const bad of ['garbage', 'V 2 0 1', 'V 2 0 1 0 0 0 5 4 seat_front_left 0 0', 'V 7', 'V 2 0 1 0 0 0 x 5 0']) {
    const got = shimRun(`return shimInspect(${input}, ${json(bad)})`);
    sameOutput(got, item);
    assert.equal(got.fails.length, 1, bad);
    assert.match(got.fails[0], /unreadable reply/);
  }
  const raised = shimRun(`return shimInspect(${input}, function() error('boom') end)`);
  sameOutput(raised, item);
  assert.match(raised.fails[0], /inspect: .*boom/);
});

test('twenty empty answers in a row switch the system off', () => {
  const item = caseNamed(inspect, 'a parked car with an AI and four free seats');
  const got = shimRun(`return shimInspectSeries(${luaTable(item.input)}, '', 25)`);
  assert.equal(got.fails.length, 1);
  assert.match(got.fails[0], /keeps answering unavailable/);
  got.rows.forEach(row => assert.equal(row.wire, wireOf(item)));
});

test('without the plugin class the shim switches the system off and runs the original', () => {
  const item = caseNamed(inspect, 'a parked car with an AI and four free seats');
  const got = shimRun(`ConvaiNativeVehicles = nil
    return shimInspect(${luaTable(item.input)}, 'V 3')`);
  sameOutput(got, item);
  assert.equal(got.fails.length, 1);
  assert.match(got.fails[0], /ConvaiNativeVehicles is not registered/);
});

test('a car without an entity is left to the original', () => {
  const got = shimRun(`reset('V 3')
    Game.FindEntityByID = function() return nil end
    local mod = loadModule()
    local out = mod.inspect({owned = true})
    return {ready = out.ready == true, calls = #nativeCalls}`);
  assert.deepEqual(got, {ready: false, calls: 0});
});

test('mounting: a not-mounted answer is native, a mounted one is checked against the original', () => {
  let none = 0, mounted = 0;
  for (const item of mounting.cases) {
    const got = shimRun(`return shimMounting(${luaTable(item.input)}, ${json(wireOf(item))})`);
    assert.equal(got.mounted, item.output.mounted, item.name);
    assert.equal(got.vehicle, item.output.vehicle, item.name);
    assert.equal(got.seat, item.output.seat, item.name);
    assert.deepEqual(got.fails, [], item.name);
    assert.equal(got.nativeCalls, 1);
    if (item.output.mounted) { mounted++; assert.equal(got.facility, 1, item.name); }
    else { none++; assert.equal(got.facility, 0, `${item.name} asked the game`); }
  }
  assert.ok(none >= 4 && mounted >= 3);
});

test('mounting: plugin answers that disagree with the original switch the system off', () => {
  const driver = caseNamed(mounting, 'mounted in the driver seat');
  const wrongParent = shimRun(`return shimMounting(${luaTable(driver.input)}, 'M 999 seat_front_left')`);
  assert.equal(wrongParent.vehicle, driver.output.vehicle, 'the original answer is returned');
  assert.equal(wrongParent.fails.length, 1);
  const wrongSeat = shimRun(`return shimMounting(${luaTable(driver.input)}, 'M 4294967297 seat_back_left')`);
  assert.equal(wrongSeat.fails.length, 1);
  const missed = shimRun(`return shimMounting(${luaTable(driver.input)}, 'M -', {trusted = false})`);
  assert.equal(missed.mounted, true);
  assert.equal(missed.fails.length, 1);
  assert.match(missed.fails[0], /^vehicles: mounting differs from the Lua/);
});

test('mounting: not-mounted answers are compared with the original until the plugin is trusted', () => {
  const item = caseNamed(mounting, 'no mounting info');
  const got = shimRun(`return shimMounting(${luaTable(item.input)}, 'M -', {trusted = false})`);
  assert.equal(got.mounted, false);
  assert.equal(got.facility, 1, 'the original ran as the check');
  assert.deepEqual(got.fails, []);
});

test('mounting: empty, unreadable and failing answers run the original', () => {
  const driver = caseNamed(mounting, 'mounted in the driver seat');
  const input = luaTable(driver.input);
  const empty = shimRun(`return shimMounting(${input}, '')`);
  assert.equal(empty.vehicle, driver.output.vehicle);
  assert.deepEqual(empty.fails, []);
  for (const bad of ['garbage', 'M', 'M abc seat', 'M 12', 'M 12 a b']) {
    const got = shimRun(`return shimMounting(${input}, ${json(bad)})`);
    assert.equal(got.vehicle, driver.output.vehicle, bad);
    assert.equal(got.fails.length, 1, bad);
  }
  const raised = shimRun(`return shimMounting(${input}, function() error('boom') end)`);
  assert.equal(raised.vehicle, driver.output.vehicle);
  assert.match(raised.fails[0], /mounting: .*boom/);
});

test('mounting: with the switch off the plugin is never called', () => {
  const item = caseNamed(mounting, 'no mounting info');
  const got = shimRun(`return shimMounting(${luaTable(item.input)}, 'M -', {off = true})`);
  assert.equal(got.nativeCalls, 0);
  assert.equal(got.facility, 1);
  assert.equal(got.mounted, false);
});
