import {test} from 'node:test';
import assert from 'node:assert/strict';
import {checkFixture, lit, luaEncoder, moduleSource, recordCases, vm} from './native-recorder.mjs';

// Parity recorder and shim checks for the native passage system
// (native/core/src/systems/passage, mod/companion-passage.lua: M.carSpot, the standing-spot search
// inside a LIFT car; it has nothing to do with vehicle seats).
//
// 1. The recorder runs the ORIGINAL Lua carSpot, with the real companion-clearance.lua, against a
//    fake physics world (floors, walls and obstacles given per case) and writes every query it
//    made, in order, with the answer it got, plus the tables it returned, to
//    native/core/tests/fixtures/passage-carspot.json. The C++ test feeds the recorded answers back
//    to the C++ loop and requires the same queries in the same order, the same budget use and the
//    same wire text (the encoder below is the specification of the format in PassageCore.hpp).
// 2. The shim checks feed those wire texts to the shim through a fake ConvaiNativePassage.

const passageSource = moduleSource('companion-passage.lua');
const clearanceSource = moduleSource('companion-clearance.lua');

const world = `
${luaEncoder}
local function f32(v) return (string.unpack('<f', string.pack('<f', v))) end
-- rx, ry, rz keep the unrounded numbers: the plugin works in doubles and the Lua shim rounds them
-- the same way Vector4.new does, so the recorded wire carries the unrounded spot.
Vector4 = {new = function(x, y, z, w)
  return {x = f32(x), y = f32(y), z = f32(z), w = f32(w or 0), rx = x, ry = y, rz = z} end}
EulerAngles = {new = function(r, p, y) return {roll = f32(r), pitch = f32(p), yaw = f32(y)} end}
CName = {new = function(name) return name end}
QUERIES, WORLD = {}, {}

local function inRect(rect, x, y) return rect and x >= rect[1] and x <= rect[3] and y >= rect[2] and y <= rect[4] end
-- Does the ground-plane segment a-b touch the rectangle? (slab test)
local function crosses(rect, a, b)
  local t0, t1 = 0, 1
  for _, axis in ipairs({{'x', 1, 3}, {'y', 2, 4}}) do
    local from, delta = a[axis[1]], b[axis[1]] - a[axis[1]]
    local low, high = rect[axis[2]], rect[axis[3]]
    if math.abs(delta) < 1e-12 then
      if from < low or from > high then return false end
    else
      local near, far = (low - from) / delta, (high - from) / delta
      if near > far then near, far = far, near end
      t0, t1 = math.max(t0, near), math.min(t1, far)
      if t0 > t1 then return false end
    end
  end
  return true
end

local spatial = {}
function spatial:SyncRaycastByCollisionGroup(a, b, group)
  local row = {kind = 'ray', group = group, from = {a.x, a.y, a.z}, to = {b.x, b.y, b.z}}
  QUERIES[#QUERIES + 1] = row
  if a.x == b.x and a.y == b.y then -- a floor ray, straight down
    local floor = WORLD.floors and WORLD.floors[group]
    if floor and inRect(floor.rect, a.x, a.y) and f32(floor.z) <= a.z and f32(floor.z) >= b.z then
      row.hit, row.z = true, f32(floor.z)
      return true, {position = {x = a.x, y = a.y, z = f32(floor.z)}}
    end
    row.hit = false
    return false, nil
  end
  for _, wall in ipairs(WORLD.walls or {}) do
    if wall.group == group and crosses(wall.rect, a, b) then
      row.hit = true
      return true, {position = {x = a.x, y = a.y, z = a.z}}
    end
  end
  row.hit = false
  return false, nil
end
function spatial:Overlap(half, position, rotation, group)
  local row = {kind = 'overlap', group = group, half = {half.x, half.y, half.z},
    center = {position.x, position.y, position.z}, rot = {rotation.roll, rotation.pitch, rotation.yaw}}
  QUERIES[#QUERIES + 1] = row
  for _, obstacle in ipairs(WORLD.obstacles or {}) do
    local gap = math.sqrt((position.x - obstacle.x) ^ 2 + (position.y - obstacle.y) ^ 2)
    if obstacle.group == group and gap < obstacle.r + half.x then
      row.hit = true
      return true, {position = {x = 1, y = 2, z = 3}}
    end
  end
  row.hit = false
  return false, {position = {x = 1, y = 2, z = 3}}
end
Game = {GetSpatialQueriesSystem = function() return spatial end}
function loadClearance() return (function() ${clearanceSource}
end)() end
function loadPassage() return (function() ${passageSource}
end)() end

-- The wire text for what carSpot returned (the format of PassageCore.hpp).
function wireOf(used, deferred, state, spot, reason, pending)
  local head = used .. ' ' .. deferred .. ' ' .. state.index .. ' ' .. (state.floor ~= nil and 1 or 0) .. ' '
    .. num(state.floor or 0)
  if spot then return '0 ' .. head .. ' ' .. num(spot.rx) .. ' ' .. num(spot.ry) .. ' ' .. num(spot.rz) end
  if reason then return '1 ' .. head .. ' ' .. (reason == 'no-car-floor' and 1 or 2) end
  assert(pending, 'carSpot returned nothing')
  return '2 ' .. head
end

function record(c)
  local clearance, passage = loadClearance(), loadPassage()
  if c.carQueries then passage.policy.carQueries = c.carQueries end
  WORLD = c.world
  local occupied = {}
  for index, point in ipairs(c.occupied or {}) do
    occupied[index] = c.occupiedForm == 'position' and {position = {x = point.x, y = point.y, z = c.v.z}} or
      {x = point.x, y = point.y, z = c.v.z}
  end
  local state, steps, candidates = {}, {}, nil
  for index = 1, c.steps do
    QUERIES = {}
    local budget = c.budget and {limit = c.budget.limit, used = c.budget.used, deferred = 0} or nil
    clearance.useBudget(budget)
    local spot, reason, pending = passage.carSpot(state, c.v, c.towards, occupied, c.body, clearance)
    if not candidates then
      candidates = {}
      for position, item in ipairs(state.candidates) do
        candidates[position] = {x = item.x, y = item.y, ux = item.ux, uy = item.uy}
      end
    end
    local used = #QUERIES
    local deferred = budget and budget.deferred or 0
    if budget then assert(budget.used - c.budget.used == used, 'budget and queries disagree in ' .. c.name) end
    local step = {queries = QUERIES, used = used, deferred = deferred, index = state.index,
      hasFloor = state.floor ~= nil, floor = state.floor or 0,
      status = spot and 'spot' or reason and 'none' or 'pending', reason = reason,
      wire = wireOf(used, deferred, state, spot, reason, pending)}
    if spot then step.spot = {x = spot.rx, y = spot.ry, z = spot.rz} end
    steps[#steps + 1] = step
    if spot or reason then break end
  end
  return {candidates = candidates, steps = steps}
end
`;

// ---- the cases ---------------------------------------------------------------------------------
const V = {x: 100, y: 200, z: 50};
const AHEAD = {x: 110, y: 200, z: 50};
const CAR_FLOOR = {Static: {rect: [98.2, 198.2, 101.8, 201.8], z: 50}};
const budget = (limit, used) => ({limit, used});
// Candidate k of ring r: V + r * (rotation by step k of the direction towards (110, 200)).
const STEPS = [0, 1, -1, 2, -2, 3, -3, 4];
const candidate = (ring, index) => {
  const radius = [0.95, 1.3][ring], angle = STEPS[index] * Math.PI / 4;
  return {x: V.x + Math.cos(angle) * radius, y: V.y + Math.sin(angle) * radius};
};

function cases() {
  const list = [];
  const add = (name, extra = {}, worldExtra = {}) => list.push({name, input: {
    world: {floors: CAR_FLOOR, walls: [], obstacles: [], ...worldExtra},
    v: V, towards: AHEAD, occupied: [], occupiedForm: 'plain', body: null, budget: budget(192, 0),
    carQueries: null, steps: 1, ...extra}});

  add('open car: the first spot beside V fits');
  add('open car, no budget table', {budget: null});
  add('the companion at V\'s own position: the direction defaults to +Y', {towards: V});
  add('towards behind V', {towards: {x: 90, y: 200, z: 50}});
  add('towards diagonal', {towards: {x: 105, y: 205, z: 50}});
  add('a large body', {body: {radius: 0.9, height: 3}});
  add('a body with a name field', {body: {radius: 0.4, height: 2.1, kind: 'humanoid'}});
  add('no car floor under V', {}, {floors: {Static: {rect: [10, 10, 20, 20], z: 50}}});
  add('no floor anywhere', {}, {floors: {}});
  add('the floor under V is 0.5 m off', {}, {floors: {Static: {rect: [98.2, 198.2, 101.8, 201.8], z: 50.5}}});
  add('the floor under V is 0.29 m off', {}, {floors: {Static: {rect: [98.2, 198.2, 101.8, 201.8], z: 49.71}}});
  add('the floor under V is 0.31 m off', {}, {floors: {Static: {rect: [98.2, 198.2, 101.8, 201.8], z: 49.69}}});
  add('Dynamic collision is a floor too', {}, {floors: {Dynamic: {rect: [98.2, 198.2, 101.8, 201.8], z: 50}}});
  add('terrain below the car loses to the car floor', {}, {floors: {Static: CAR_FLOOR.Static,
    Terrain: {rect: [0, 0, 500, 500], z: 49.5}}});
  add('terrain alone at the right height is a floor', {}, {floors: {Terrain: {rect: [0, 0, 500, 500], z: 50.1}}});
  add('a floor above the ray start is not hit', {}, {floors: {Static: {rect: [98.2, 198.2, 101.8, 201.8], z: 51.5}}});
  add('floor only under V: every candidate is off the floor', {}, {floors: {Static: {rect: [99.5, 199.5, 100.5, 200.5], z: 50}}});
  add('a candidate within 0.9 m of an occupied spot is skipped without queries', {occupied: [candidate(0, 0)]});
  add('occupied spots in the {position} form', {occupied: [candidate(0, 0), candidate(0, 1)], occupiedForm: 'position'});
  add('an occupied spot just outside 0.9 m', {occupied: [{x: candidate(0, 0).x + 0.9, y: candidate(0, 0).y}]});
  add('an occupied spot far away', {occupied: [{x: 150, y: 150}]});
  add('a Static wall between V and the first spot', {}, {walls: [{group: 'Static', rect: [100.5, 199, 100.6, 201]}]});
  add('a Dynamic wall between V and the first spot', {}, {walls: [{group: 'Dynamic', rect: [100.5, 199, 100.6, 201]}]});
  add('a wall beside the first spot, off the ray', {}, {walls: [{group: 'Static', rect: [101, 205, 102, 206]}]});
  ['Static', 'Dynamic', 'Vehicle', 'Terrain', 'Collider', 'Destructible'].forEach(group =>
    add(`an obstacle at the first spot in group ${group}`, {}, {obstacles: [{group, x: candidate(0, 0).x, y: candidate(0, 0).y, r: 0.3}]}));
  add('obstacles at the first three spots', {}, {obstacles: [0, 1, 2].map(index =>
    ({group: 'Static', x: candidate(0, index).x, y: candidate(0, index).y, r: 0.3}))});
  add('walls and obstacles at the first spots', {}, {walls: [{group: 'Static', rect: [100.5, 199, 100.6, 201]}],
    obstacles: [{group: 'Dynamic', x: candidate(0, 1).x, y: candidate(0, 1).y, r: 0.3}]});
  add('everything is blocked: no spot after every candidate, in several updates', {steps: 12, carQueries: 100},
    {obstacles: [{group: 'Static', x: 100, y: 200, r: 5}]});
  add('everything is blocked with the default 24 units a call', {steps: 12},
    {obstacles: [{group: 'Static', x: 100, y: 200, r: 5}]});
  add('a late spot is found over several updates', {steps: 8, carQueries: 12}, {obstacles:
    [0, 1, 2, 3, 4, 5].map(index => ({group: 'Static', x: candidate(0, index).x, y: candidate(0, index).y, r: 0.3}))});
  add('three units a call: the car floor read alone', {carQueries: 3, steps: 3});
  add('five units a call', {carQueries: 5, steps: 6});
  add('the search resumes with the cached floor', {carQueries: 8, steps: 4}, {obstacles:
    [0, 1].map(index => ({group: 'Static', x: candidate(0, index).x, y: candidate(0, index).y, r: 0.3}))});
  add('budget spent: deferred before any query', {budget: budget(192, 192)});
  add('two queries left: deferred at the car floor', {budget: budget(192, 190)});
  add('exactly three queries left: floor only, then deferred at the next floor', {budget: budget(192, 189)});
  add('six left: V floor and one candidate floor', {budget: budget(192, 186)});
  add('eight left: deferred before the wall rays finish', {budget: budget(192, 184)});
  add('nine left: the wall rays fit, the body does not', {budget: budget(192, 183)});
  add('fourteen left: a whole first candidate fits', {budget: budget(192, 178)});
  add('a tight budget with a blocked first spot', {budget: budget(192, 176)}, {obstacles:
    [{group: 'Static', x: candidate(0, 0).x, y: candidate(0, 0).y, r: 0.3}]});
  add('a budget that lets the second update continue', {budget: budget(14, 0), steps: 4}, {obstacles:
    [0, 1, 2, 3].map(index => ({group: 'Static', x: candidate(0, index).x, y: candidate(0, index).y, r: 0.3}))});
  add('an invalid body (radius too small) fits nowhere', {body: {radius: 0.1, height: 2}, steps: 12, carQueries: 100});
  add('V at a different height', {v: {x: -20.5, y: 33.25, z: -4}, towards: {x: -30, y: 33.25, z: -4}},
    {floors: {Static: {rect: [-23, 31, -18, 36], z: -4}}});
  add('V with fractional coordinates', {v: {x: 1234.5678, y: -987.6543, z: 12.3456}, towards: {x: 1240, y: -980, z: 12.3456}},
    {floors: {Static: {rect: [1232, -990, 1238, -985], z: 12.3456}}});
  return list;
}

const recorded = recordCases({prelude: world, cases: cases(), system: 'passage', source: 'mod/companion-passage.lua'});

test('the passage-carspot parity fixture matches mod/companion-passage.lua', () => {
  checkFixture('passage-carspot', recorded, 'Lua lift-car spot search changed');
});

test('the recorded cases cover every outcome of the original', () => {
  const statuses = new Set(recorded.cases.flatMap(item => item.output.steps.map(step => step.status)));
  for (const status of ['spot', 'none', 'pending']) assert.ok(statuses.has(status), status);
  const reasons = new Set(recorded.cases.flatMap(item => item.output.steps.map(step => step.reason)));
  assert.ok(reasons.has('no-car-floor'));
  assert.ok(recorded.cases.some(item => item.output.steps.some(step => step.deferred === 1)), 'a budget wait');
  assert.ok(recorded.cases.some(item => item.output.steps.length > 3), 'a search over several updates');
  const groups = new Set(recorded.cases.flatMap(item => item.output.steps.flatMap(step =>
    step.queries.filter(query => query.kind === 'overlap' && query.hit).map(query => query.group))));
  for (const group of ['Static', 'Dynamic', 'Vehicle', 'Terrain', 'Collider', 'Destructible']) assert.ok(groups.has(group), group);
  assert.ok(recorded.cases.every(item => item.output.candidates.length === 16));
});

test('every query a case issues is a floor ray, a wall ray or a body overlap in the documented order', () => {
  for (const item of recorded.cases) {
    for (const step of item.output.steps) {
      const kinds = step.queries.map(query => query.kind === 'overlap' ? 'o' : query.from[0] === query.to[0] && query.from[1] === query.to[1] ? 'f' : 'w');
      // floors come three at a time, walls two at a time, overlaps up to six at a time
      const text = kinds.join('');
      assert.match(text, /^(f{3}|(f{3}w{1,2}(o{1,6})?)?)*$/, `${item.name}: ${text}`);
    }
  }
});


// ---- the shim against a fake plugin ------------------------------------------------------------
const shimWorld = `${world}
nativeOn, fails, ARGS, CLOCK, WIRES, SELFTESTS, NOTES = true, {}, {}, 0, {}, 0, {}
convaiNative = {
  use = function(name) return name == 'passage' and nativeOn end, -- clearance stays on its Lua
  fail = function(name, why) fails[#fails + 1] = name .. ': ' .. (tostring(why):gsub('[%c"]', '?')); nativeOn = false end,
}
os.clock = function() CLOCK = CLOCK + 10 return CLOCK end
io = {open = function() return {write = function(_, ...) for _, part in ipairs({...}) do NOTES[#NOTES + 1] = part end end,
  close = function() return true end} end}
ConvaiNativePassage = {
  SelfTest = function() SELFTESTS = SELFTESTS + 1 return SELFTEST end,
  CarSpot = function(...)
    ARGS[#ARGS + 1] = {...}
    local wire = WIRES[#ARGS]
    if wire == 'error' then error('boom') end
    if type(wire) == 'function' then return wire(...) end
    return wire
  end,
}

-- Runs carSpot like record() does (a fresh budget each update), through the shim.
function shimRecord(c, o)
  o = o or {}
  nativeOn, fails, ARGS, WIRES, SELFTESTS, NOTES, SELFTEST = o.off ~= true, {}, {}, o.wires or {}, 0, {}, o.selftest or 'ok'
  if o.noClass then ConvaiNativePassage = nil end
  convaiNative.passageProven = (o.proven ~= false) or nil
  convaiNative.passageRetry, convaiNative.passageWaits = nil, nil
  -- verify = 'file' is runtime/native-verify.txt naming the system (api.verifying), not the Lua test hook
  convaiNative.passageVerify = o.verify == true or nil
  convaiNative.verifying = o.verify == 'file' and function(name) return name == 'passage' end or nil
  convaiNative.passageStats = nil
  if o.trusted ~= false then
    convaiNative.passageStats = {native = 0, lua = 0, fallback = 0, verified = 99, compared = 0, mismatches = 0}
  end
  local clearance, passage = loadClearance(), loadPassage()
  if o.noSpend then clearance.spend = nil end
  if c.carQueries then passage.policy.carQueries = c.carQueries end
  WORLD = c.world
  local occupied = {}
  for index, point in ipairs(c.occupied or {}) do
    if o.badOccupied then point = {x = 0 / 0, y = point.y} end
    occupied[index] = c.occupiedForm == 'position' and {position = {x = point.x, y = point.y, z = c.v.z}} or
      {x = point.x, y = point.y, z = c.v.z}
  end
  local body = c.body
  if o.body == 'text' then body = {radius = 'big', height = 2} end
  local state, rows = {}, {}
  for index = 1, o.times or c.steps do
    QUERIES = {}
    local budget = c.budget and {limit = c.budget.limit, used = c.budget.used, deferred = 0} or nil
    clearance.useBudget(budget)
    local spot, reason, pending = passage.carSpot(state, c.v, c.towards, occupied, body, clearance)
    local row = {queries = #QUERIES, index = state.index, hasFloor = state.floor ~= nil, floor = state.floor or 0,
      reason = reason, pending = pending == true, deferred = budget and budget.deferred or 0,
      budgetUsed = budget and budget.used - c.budget.used or 0, plugin = #ARGS}
    if spot then row.spot = {x = spot.rx, y = spot.ry, z = spot.rz} end
    rows[#rows + 1] = row
    if not o.times and (spot or reason) then break end
  end
  return {rows = rows, fails = fails, args = ARGS, selftests = SELFTESTS, stats = convaiNative.passageStats,
    notes = (table.concat(NOTES):gsub('[^%w %.:=%-]', '?'))}
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
const json = value => JSON.stringify(value);
const named = name => recorded.cases.find(item => item.name === name);
const CLEAN = 'open car: the first spot beside V fits';
const run = (item, options = {}) => shimRun(`return shimRecord(${lit({...item.input, name: item.name})}, ${lit(options)})`);
const wiresOf = item => item.output.steps.map(step => step.wire);
const sameStep = (row, step, label, budgeted = true) => {
  assert.equal(row.index, step.index, label);
  assert.equal(row.hasFloor, step.hasFloor, label);
  assert.ok(Math.abs(row.floor - step.floor) < 1e-9, label);
  assert.equal(row.reason, step.reason, label);
  assert.equal(row.pending, step.status === 'pending', label);
  assert.equal(row.deferred, step.deferred, label);
  if (budgeted) assert.equal(row.budgetUsed, step.used, label);
  if (step.spot) {
    for (const axis of ['x', 'y', 'z']) assert.ok(Math.abs(row.spot[axis] - step.spot[axis]) < 1e-9, label);
  } else assert.equal(row.spot, undefined, label);
};

test('the shim turns every recorded wire into the spot, state and budget use of the original with no game queries', () => {
  for (const item of recorded.cases) {
    const got = run(item, {wires: wiresOf(item)});
    assert.deepEqual(got.fails, [], item.name);
    assert.equal(got.rows.length, item.output.steps.length, item.name);
    got.rows.forEach((row, index) => {
      assert.equal(row.queries, 0, item.name);
      assert.equal(row.plugin, index + 1, item.name);
      sameStep(row, item.output.steps[index], `${item.name}, update ${index + 1}`, item.input.budget !== null);
    });
    assert.equal(got.stats.native, item.output.steps.length, item.name);
  }
});

test('the shim sends the search state, the candidates, the occupied points and the budget left', () => {
  const item = named('a late spot is found over several updates');
  const got = run(item, {wires: wiresOf(item)});
  const first = got.args[0];
  assert.deepEqual(first.slice(0, 3), [item.input.v.x, item.input.v.y, item.input.v.z]);
  assert.equal(first[3].split(' ').length, 64); // 16 candidates, 4 numbers each
  assert.equal(first[4], '');
  assert.deepEqual(first.slice(5), [0.4, 2.1, 12, 0.3, 192, 1, false, 0]);
  const later = got.args[1];
  assert.equal(later[10], item.output.steps[0].index);
  assert.equal(later[11], item.output.steps[0].hasFloor);
  assert.ok(Math.abs(later[12] - item.output.steps[0].floor) < 1e-9);

  const open = named('open car, no budget table');
  assert.equal(run(open, {wires: wiresOf(open)}).args[0][9], 1000000);
  const occupied = named('occupied spots in the {position} form');
  const points = run(occupied, {wires: wiresOf(occupied)}).args[0][4].split(' ').map(Number);
  assert.equal(points.length, 4);
  assert.ok(Math.abs(points[0] - occupied.input.occupied[0].x) < 1e-12);
  const large = named('a large body');
  assert.deepEqual(run(large, {wires: wiresOf(large)}).args[0].slice(5, 7), [0.9, 3]);
});

test('with the switch off the plugin is never called', () => {
  const item = named(CLEAN);
  const got = run(item, {off: true, wires: wiresOf(item)});
  assert.equal(got.args.length, 0);
  assert.ok(got.rows[0].queries > 10);
  assert.equal(got.rows[0].spot.z, item.output.steps[0].spot.z);
});

test('the first answers of a session are compared with the original, which stays the answer', () => {
  for (const item of recorded.cases) {
    const got = run(item, {wires: wiresOf(item), trusted: false});
    assert.deepEqual(got.fails, [], item.name);
    got.rows.forEach((row, index) => {
      assert.equal(row.queries, item.output.steps[index].used, item.name); // the Lua ran
      sameStep(row, item.output.steps[index], item.name, item.input.budget !== null);
    });
    assert.equal(got.stats.compared, item.output.steps.length, item.name);
    assert.equal(got.stats.verified, item.output.steps.length, item.name);
    assert.equal(got.stats.mismatches, 0, item.name);
  }
  const item = named('everything is blocked with the default 24 units a call');
  const got = run(item, {wires: wiresOf(item), verify: true});
  assert.deepEqual(got.fails, []);
  assert.equal(got.stats.compared, item.output.steps.length);
});

test('a line in native-verify.txt compares every call too', () => {
  const item = named('everything is blocked with the default 24 units a call');
  const got = run(item, {wires: wiresOf(item), verify: 'file'});
  assert.deepEqual(got.fails, []);
  assert.equal(got.stats.compared, item.output.steps.length);
  const quiet = run(item, {wires: wiresOf(item)});
  assert.equal(quiet.stats.compared, 0, 'a trusted plugin is not compared without the line');
});

test('after eight matching answers the plugin is trusted', () => {
  const item = named(CLEAN);
  const first = wiresOf(item)[0];
  const again = first.split(' '); again[1] = '11'; // the floor under V is cached after the first update
  const got = run(item, {wires: [first, ...Array(9).fill(again.join(' '))], trusted: false, times: 10});
  assert.deepEqual(got.rows.map(row => row.queries > 0), [true, true, true, true, true, true, true, true, false, false]);
  assert.equal(got.stats.verified, 8);
  assert.match(got.notes, /matched the Lua 8 times. now native/);
});

test('a plugin answer that differs from the original switches the system off and returns the original', () => {
  const item = named(CLEAN);
  const tokens = wiresOf(item)[0].split(' ');
  const change = (index, delta) => { const copy = [...tokens]; copy[index] = String(Number(copy[index]) + delta); return copy.join(' '); };
  const none = ['1', ...tokens.slice(1, 6), '1'].join(' ');
  for (const wire of [change(6, 1), change(1, 1), change(5, 1), none]) {
    const got = run(item, {wires: [wire], trusted: false});
    assert.equal(got.fails.length, 1, wire);
    assert.match(got.fails[0], /^passage: carSpot differs from the Lua/);
    sameStep(got.rows[0], item.output.steps[0], wire);
    assert.equal(got.stats.mismatches, 1);
    assert.match(got.notes, /passage MISMATCH/);
  }
});

test('verify mode keeps comparing after the trust point', () => {
  const item = named(CLEAN);
  const tokens = wiresOf(item)[0].split(' ');
  tokens[6] = String(Number(tokens[6]) + 1);
  const got = run(item, {wires: [tokens.join(' ')], verify: true});
  assert.equal(got.fails.length, 1);
  sameStep(got.rows[0], item.output.steps[0], 'verified');
});

test('an empty answer runs the original without a failure', () => {
  const item = named(CLEAN);
  const got = run(item, {wires: ['']});
  assert.deepEqual(got.fails, []);
  assert.equal(got.stats.lua, 1);
  assert.ok(got.rows[0].queries > 10);
  sameStep(got.rows[0], item.output.steps[0], 'empty');
});

test('unreadable, short, odd or throwing answers switch the system off and run the original', () => {
  const item = named(CLEAN);
  for (const wire of ['garbage', '0 14 0 1 1 50', '0 14 0 1 1 50 100.95 200', '9 0 0 1 0 0', '1 3 0 1 0 0',
    '2 0 1 1 0 0 5', '4 3', 'error']) {
    const got = run(item, {wires: [wire]});
    assert.equal(got.fails.length, 1, wire);
    sameStep(got.rows[0], item.output.steps[0], wire);
    assert.equal(got.stats.fallback, 1, wire);
  }
});

test('a game query that failed inside the plugin charges the queries it made, then the original runs', () => {
  const item = named(CLEAN);
  const got = run(item, {wires: ['4 5 9']});
  assert.equal(got.fails.length, 1);
  assert.match(got.fails[0], /^passage: carSpot: game query failed \(code 9\)/);
  assert.equal(got.rows[0].budgetUsed, 5 + item.output.steps[0].used);
  assert.equal(got.rows[0].queries, item.output.steps[0].used);
  assert.equal(got.rows[0].spot.z, item.output.steps[0].spot.z);
});

test('without the plugin class the shim switches the system off and runs the original', () => {
  const item = named(CLEAN);
  const got = run(item, {noClass: true});
  assert.equal(got.fails.length, 1);
  assert.match(got.fails[0], /ConvaiNativePassage is not registered/);
  sameStep(got.rows[0], item.output.steps[0], 'no class');
});

test('the self-test: wait runs the original and retries without ever failing, a failure fails', () => {
  const item = named(CLEAN);
  const wait = run(item, {proven: false, selftest: 'wait no world', wires: wiresOf(item)});
  assert.deepEqual(wait.fails, []);
  assert.equal(wait.args.length, 0);
  assert.equal(wait.selftests, 1);
  sameStep(wait.rows[0], item.output.steps[0], 'wait');
  // No world is a wait, never a failure, however long it lasts (the main menu can be open for an hour).
  const many = run(item, {proven: false, selftest: 'wait no world', times: 7});
  assert.equal(many.selftests, 7);
  assert.deepEqual(many.fails, []);
  assert.match(many.notes, /passage self-test waits .wait no world. wait 1/);
  const bad = run(item, {proven: false, selftest: 'fail the floor ray is unreadable'});
  assert.match(bad.fails[0], /^passage: self-test: fail the floor ray is unreadable/);
  sameStep(bad.rows[0], item.output.steps[0], 'fail');
  const good = run(item, {proven: false, selftest: 'ok', wires: wiresOf(item)});
  assert.deepEqual(good.fails, []);
  assert.equal(good.args.length, 1);
  assert.match(good.notes, /passage self-test passed/);
  const twice = run(item, {proven: false, selftest: 'ok', times: 2, wires: [wiresOf(item)[0], wiresOf(item)[0]]});
  assert.equal(twice.selftests, 1);
});

test('a clearance module without the budget helpers runs the original', () => {
  const item = named(CLEAN);
  const got = run(item, {noSpend: true, wires: wiresOf(item)});
  assert.equal(got.args.length, 0);
  assert.deepEqual(got.fails, []);
  sameStep(got.rows[0], item.output.steps[0], 'no spend');
});

test('a body, an occupied point or a position the plugin cannot take runs the original without a failure', () => {
  const item = named(CLEAN);
  const body = run(item, {body: 'text', wires: wiresOf(item)});
  assert.equal(body.args.length, 0);
  assert.deepEqual(body.fails, []);
  const occupied = named('an occupied spot far away');
  const odd = run(occupied, {badOccupied: true, wires: wiresOf(occupied)});
  assert.equal(odd.args.length, 0);
  assert.deepEqual(odd.fails, []);
  const far = {...item, input: {...item.input, v: {x: 1e9, y: 0, z: 0}}};
  assert.equal(run(far, {wires: ['0 1']}).args.length, 0);
});
