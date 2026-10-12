import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import fengari from 'fengari';

// Parity recorder and shim checks for the native clearance system
// (native/core/src/systems/clearance, mod/companion-clearance.lua).
//
// 1. The recorder runs the ORIGINAL Lua (no convaiNative) against a fake spatial system and writes
//    what it did to native/core/tests/fixtures/clearance-boxes.json and clearance-rays.json:
//    inputs, the queries it issued in order, the results it returned, the budget it spent, and
//    the wire text the plugin must answer with (the encoder below is the specification of the
//    format in ClearanceCore.hpp). CONVAI_WRITE_FIXTURES=1 rewrites them; otherwise the committed
//    files must equal the Lua output, so a Lua change that breaks parity fails npm test.
// 2. The shim checks feed those wire texts to the shim through a fake ConvaiNativeClearance and
//    require the same results and budget as the original, then cover the switch, the faults, the
//    self-test and the verify mode.

const source = readFileSync(new URL('../mod/companion-clearance.lua', import.meta.url), 'utf8');
const target = name => new URL(`../native/core/tests/fixtures/${name}.json`, import.meta.url);

const GROUPS = ['Static', 'Dynamic', 'Vehicle', 'Terrain', 'Collider', 'Destructible'];
const SIGHT_GROUPS = ['Static', 'Dynamic', 'Terrain', 'Collider', 'Destructible', 'Vehicle'];

// ---- Lua literals and the fake game ----------------------------------------------------------
function lit(value) {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '(0/0)';
    if (value === Infinity) return 'math.huge';
    if (value === -Infinity) return '(-math.huge)';
    return Object.is(value, -0) ? '(-0.0)' : String(value);
  }
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `{${value.map(lit).join(',')}}`;
  return `{${Object.entries(value).filter(([, item]) => item !== undefined && item !== null)
    .map(([key, item]) => `[${JSON.stringify(key)}]=${lit(item)}`).join(',')}}`;
}

const prelude = `
local function f32(v) return (string.unpack('<f', string.pack('<f', v))) end
Vector4 = {new = function(x, y, z, w) return {x = f32(x), y = f32(y), z = f32(z), w = f32(w)} end}
EulerAngles = {new = function(r, p, y) return {roll = f32(r), pitch = f32(p), yaw = f32(y)} end}
CName = {new = function(name) return name end}
Quaternion = {
  BuildFromDirectionVector = function(v) return {dir = v} end,
  ToEulerAngles = function(q) return EulerAngles.new(0, 0, math.atan(-q.dir.x + 0.0, q.dir.y) * 180 / math.pi) end,
}
queries, hitAt, rayHit, rayZ = {}, -1, false, nil
spatial = {}
function spatial:Overlap(half, position, rotation, group)
  local index = #queries
  queries[#queries + 1] = {group = group, half = {half.x, half.y, half.z},
    center = {position.x, position.y, position.z}, rot = {rotation.roll, rotation.pitch, rotation.yaw}}
  return index == hitAt, {position = {x = 1, y = 2, z = 3}}
end
function spatial:SyncRaycastByCollisionGroup(a, b, group, c, d)
  local index = #queries
  queries[#queries + 1] = {group = group, from = {a.x, a.y, a.z}, to = {b.x, b.y, b.z}}
  if rayZ ~= nil then
    if not rayHit then return false, nil end
    return true, {position = {x = 0, y = 0, z = f32(rayZ)}}
  end
  return index == hitAt, nil
end
Game = {GetSpatialQueriesSystem = function() return spatial end}
logLines = {}
io = {open = function(path)
  return {write = function(self, ...) logLines[#logLines + 1] = table.concat({...}) return self end,
    close = function() return true end}
end}
function loadModule() return (function() ${source}
end)() end

-- JSON for the fixture (sorted keys; ASCII text without quotes or backslashes).
function enc(v)
  local kind = type(v)
  if v == nil then return 'null' end
  if kind == 'boolean' then return tostring(v) end
  if kind == 'number' then
    if v ~= v then return '"nan"' end
    if v == math.huge then return '"inf"' end
    if v == -math.huge then return '"-inf"' end
    if v == math.floor(v) and math.abs(v) < 1e15 then return string.format('%d', v) end
    return string.format('%.17g', v)
  end
  if kind == 'string' then
    assert(not v:find('["%c]') and not v:find(string.char(92), 1, true), 'unsupported text: ' .. v)
    return '"' .. v .. '"'
  end
  local out = {}
  if next(v) == nil then return '[]' end
  if #v > 0 then
    for _, item in ipairs(v) do out[#out + 1] = enc(item) end
    return '[' .. table.concat(out, ',') .. ']'
  end
  local keys = {}
  for key in pairs(v) do keys[#keys + 1] = key end
  table.sort(keys)
  for _, key in ipairs(keys) do out[#out + 1] = '"' .. key .. '":' .. enc(v[key]) end
  return '{' .. table.concat(out, ',') .. '}'
end

local function num(v) return string.format('%.17g', v) end
local function groupIndex(name, list)
  for index, group in ipairs(list) do if group == name then return index end end
  error('unknown group ' .. tostring(name))
end
GROUPS = {${GROUPS.map(g => `'${g}'`).join(',')}}
SIGHT_GROUPS = {${SIGHT_GROUPS.map(g => `'${g}'`).join(',')}}

-- The wire text for a recorded result (the format of ClearanceCore.hpp).
function wireBox(r, used, segment, nextBox)
  local rej = r.rejection
  if r.clear == true then return '0 ' .. used end
  if r.deferred then return segment and ('2 ' .. used .. ' ' .. nextBox) or ('2 ' .. used) end
  if rej and rej.unavailable then return '3 0' end
  if rej and rej.geometryType then
    return table.concat({'5', '0', rej.geometryType == 'route-size' and 1 or 2, num(rej.length), num(rej.rise),
      num(rej.deltaZ), num(rej.allowedRise), rej.boxes}, ' ')
  end
  local parts = {'1', used, groupIndex(rej.group, GROUPS), num(rej.center.x), num(rej.center.y), num(rej.center.z),
    num(rej.halfExtents.x), num(rej.halfExtents.y), num(rej.halfExtents.z), num(rej.rotation.roll),
    num(rej.rotation.pitch), num(rej.rotation.yaw)}
  if segment then parts[#parts + 1] = rej.box; parts[#parts + 1] = rej.boxes end
  return table.concat(parts, ' ')
end
local function statusOf(r)
  if r.clear == true then return 'clear' end
  if r.deferred then return 'deferred' end
  if r.rejection and r.rejection.unavailable then return 'unavailable' end
  if r.rejection and r.rejection.geometryType then return 'geometry' end
  return 'blocked'
end

-- Runs one case through the original Lua and returns the recorded output.
function record(c)
  queries, hitAt, rayHit, rayZ = {}, c.hitAt or -1, c.rayHit == true, c.rayZ
  local mod = loadModule()
  local budget = c.budget and {limit = c.budget.limit, used = c.budget.used, deferred = 0} or nil
  mod.useBudget(budget)
  local r, out = {}, {}
  local progress = c.progress and {next = c.startBox} or nil
  if c.fn == 'body' then r.clear, r.reason, r.deferred, r.rejection = mod.body(c.feet, c.dimensions)
  elseif c.fn == 'recheck' then r.clear, r.reason, r.deferred, r.rejection = mod.recheck(c.rejection)
  elseif c.fn == 'segment' then
    r.clear, r.reason, r.deferred, r.rejection = mod.segment(c.from, c.to, c.dimensions, progress, c.projection)
  elseif c.fn == 'sight' then
    local ok, visible = pcall(mod.sightClear, c.from, c.to)
    assert(ok, visible)
    out.visible = visible
  elseif c.fn == 'floor' then
    local ok, z = pcall(mod.floorZ, c.at, c.maxDrop)
    assert(ok, z)
    out.z = z
  else error('unknown fn ' .. tostring(c.fn)) end
  out.queries = queries
  out.used = #queries
  if budget then
    assert(budget.used - c.budget.used == #queries, 'budget and queries disagree in ' .. c.name)
    out.deferredCount = budget.deferred
  end
  if c.fn == 'sight' then
    local blocked = not out.visible
    local blockedAt = blocked and #queries or nil
    if blocked then assert(queries[#queries]) end
    out.wire = out.visible and ('0 ' .. #queries) or ('1 ' .. #queries .. ' ' .. groupIndex(queries[#queries].group, SIGHT_GROUPS))
  elseif c.fn == 'floor' then
    out.wire = out.z and ('1 ' .. num(out.z)) or '0 0'
  else
    out.status = statusOf(r)
    out.clear, out.reason, out.deferred, out.rejection = r.clear, r.reason, r.deferred, r.rejection
    if c.progress then out.next = progress.next end
    out.wire = wireBox(r, #queries, c.fn == 'segment', progress and progress.next or c.startBox)
  end
  return out
end
`;

function vm() {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const run = code => {
    const status = lauxlib.luaL_dostring(state, to_luastring(code));
    if (status !== lua.LUA_OK) {
      const error = to_jsstring(lua.lua_tostring(state, -1));
      lua.lua_close(state);
      assert.fail(error);
    }
  };
  const read = name => {
    lua.lua_getglobal(state, to_luastring(name));
    const text = to_jsstring(lua.lua_tostring(state, -1));
    lua.lua_pop(state, 1);
    return text;
  };
  return {run, read, close: () => lua.lua_close(state)};
}

// ---- the cases ---------------------------------------------------------------------------------
const P = (x, y, z) => ({x, y, z});
const budget = (limit, used) => ({limit, used});
const f32 = Math.fround;

function boxCases() {
  const cases = [];
  const add = (name, input) => cases.push({name, input: {fn: input.fn, ...input}});
  const body = (name, extra) => add(name, {fn: 'body', feet: P(10, 20, 5), dimensions: null, budget: budget(192, 0), hitAt: -1, ...extra});
  body('body: clear, default humanoid');
  body('body: clear, no budget', {budget: null});
  body('body: large shape', {dimensions: {radius: 0.9, height: 3}});
  body('body: negative coordinates', {feet: P(-1234.56789, -0.001, -42.5)});
  GROUPS.forEach((group, index) => body(`body: blocked by ${group}`, {hitAt: index}));
  body('body: blocked by the last group costs six', {hitAt: 5, budget: budget(192, 100)});
  body('body: exactly six queries left', {budget: budget(192, 186)});
  body('body: five queries left defers', {budget: budget(192, 187)});
  body('body: budget spent defers', {budget: budget(192, 192)});
  body('body: a hit with a tight budget', {budget: budget(192, 186), hitAt: 0});
  for (const radius of [0.2, 3]) body(`body: radius ${radius} is valid`, {dimensions: {radius, height: 2}});
  for (const radius of [0.19, 3.01]) body(`body: radius ${radius} is refused`, {dimensions: {radius, height: 2}});
  for (const height of [0.5, 6]) body(`body: height ${height} is valid`, {dimensions: {radius: 0.4, height}});
  for (const height of [0.49, 6.01]) body(`body: height ${height} is refused`, {dimensions: {radius: 0.4, height}});
  body('body: non-finite radius is refused', {dimensions: {radius: NaN, height: 2}});
  body('body: missing height is refused', {dimensions: {radius: 0.4}});
  body('body: coordinate just under 1e7 is valid', {feet: P(9999999, 0, 0)});
  body('body: coordinate 1e7 is refused', {feet: P(10000000, 0, 0)});
  body('body: negative 1e7 is refused', {feet: P(0, -10000000, 0)});
  body('body: NaN is refused', {feet: P(NaN, 0, 0)});
  body('body: infinity is refused', {feet: P(0, Infinity, 0)});
  body('body: missing z is refused', {feet: {x: 1, y: 2}});
  body('body: no position is refused', {feet: null});

  const recheck = (name, extra) => add(name, {fn: 'recheck', budget: budget(192, 0), hitAt: -1,
    rejection: {group: 'Static', center: P(1, 2, 3), halfExtents: P(0.4, 0.4, 1.05), rotation: {roll: 0, pitch: 0, yaw: 0}}, ...extra});
  recheck('recheck: clear');
  recheck('recheck: still blocked by the last group', {hitAt: 5});
  recheck('recheck: no rotation table', {rejection: {center: P(1, 2, 3), halfExtents: P(0.4, 0.4, 1.05)}});
  recheck('recheck: rotated box', {rejection: {center: P(-5.5, 7.25, 60), halfExtents: P(0.5, 1.25, 2),
    rotation: {roll: 5, pitch: -10, yaw: 123.456}}});
  recheck('recheck: half extent at the limits', {rejection: {center: P(0, 0, 0), halfExtents: P(100, 100, 10), rotation: {}}});
  recheck('recheck: x over 100 is refused', {rejection: {center: P(0, 0, 0), halfExtents: P(100.5, 1, 1), rotation: {}}});
  recheck('recheck: z over 10 is refused', {rejection: {center: P(0, 0, 0), halfExtents: P(1, 1, 10.5), rotation: {}}});
  recheck('recheck: zero extent is refused', {rejection: {center: P(0, 0, 0), halfExtents: P(1, 0, 1), rotation: {}}});
  recheck('recheck: negative extent is refused', {rejection: {center: P(0, 0, 0), halfExtents: P(-1, 1, 1), rotation: {}}});
  recheck('recheck: non-finite centre is refused', {rejection: {center: P(NaN, 0, 0), halfExtents: P(1, 1, 1), rotation: {}}});
  recheck('recheck: missing extents are refused', {rejection: {center: P(0, 0, 0)}});
  recheck('recheck: five queries left defers', {budget: budget(192, 187)});

  const segment = (name, extra) => add(name, {fn: 'segment', from: P(0, 0, 0), to: P(0, 2, 0), dimensions: null,
    budget: budget(192, 0), hitAt: -1, progress: false, startBox: null, projection: false, ...extra});
  segment('segment: one flat box');
  segment('segment: no budget', {budget: null});
  segment('segment: 6 m ahead is three boxes', {from: P(1, 1, 10), to: P(1, 7, 10)});
  segment('segment: diagonal 45 degrees', {from: P(0, 0, 0), to: P(5, 5, 0)});
  segment('segment: heading west', {from: P(10, 10, 2), to: P(2, 10.5, 2.2)});
  segment('segment: heading south', {from: P(0, 0, 0), to: P(0, -4.5, 0)});
  segment('segment: heading east', {from: P(0, 0, 0), to: P(4, 0, 0.1)});
  segment('segment: large shape', {from: P(0, 0, 0), to: P(3, 4, 0), dimensions: {radius: 0.9, height: 3}});
  segment('segment: shorter than a millimetre has no rotation', {from: P(3, 3, 3), to: P(3.0005, 3, 3)});
  segment('segment: standing still is one box', {from: P(3, 3, 3), to: P(3, 3, 3)});
  segment('segment: climb of 0.6 m', {from: P(0, 0, 0), to: P(0, 4, 0.6)});
  segment('segment: climb of 1 m over 6 m', {from: P(0, 0, 0), to: P(6, 0, 1)});
  segment('segment: descent of 1.2 m over 6 m', {from: P(0, 0, 5), to: P(0, 6, 3.8)});
  segment('segment: hit in the first box', {from: P(0, 0, 0), to: P(0, 6, 0), hitAt: 0});
  segment('segment: hit in the second box, group Vehicle', {from: P(0, 0, 0), to: P(0, 6, 0), hitAt: 6 + 2});
  segment('segment: hit in the last box', {from: P(0, 0, 0), to: P(0, 6, 0), hitAt: 12 + 5});
  segment('segment: budget for two boxes of three defers at box 3', {from: P(0, 0, 0), to: P(0, 6, 0),
    budget: budget(192, 192 - 12), progress: true});
  segment('segment: nine queries left defers at box 2', {from: P(0, 0, 0), to: P(0, 6, 0), budget: budget(192, 183), progress: true});
  segment('segment: spent budget defers at box 1', {from: P(0, 0, 0), to: P(0, 6, 0), budget: budget(192, 192), progress: true});
  segment('segment: resumes at box 2', {from: P(0, 0, 0), to: P(0, 6, 0), progress: true, startBox: 2});
  segment('segment: resumes at the last box', {from: P(0, 0, 0), to: P(0, 6, 0), progress: true, startBox: 3});
  segment('segment: a cursor past the end is clear', {from: P(0, 0, 0), to: P(0, 6, 0), progress: true, startBox: 4});
  segment('segment: progress table without a cursor', {from: P(0, 0, 0), to: P(0, 6, 0), progress: true, startBox: null});
  segment('segment: resumed and blocked keeps the original box index', {from: P(0, 0, 0), to: P(0, 6, 0), progress: true, startBox: 2, hitAt: 3});
  segment('segment: 64 boxes is allowed', {from: P(0, 0, 0), to: P(0, 128, 0), budget: null});
  segment('segment: 65 boxes is a route-size refusal', {from: P(0, 0, 0), to: P(0, 130, 0)});
  segment('segment: 200 m is a route-size refusal', {from: P(0, 0, 0), to: P(120, 160, 0)});
  segment('segment: step of 1 m in 1 m is a step-slope refusal', {from: P(0, 0, 0), to: P(0, 1, 1)});
  segment('segment: rise just inside the allowed rise', {from: P(0, 0, 0), to: P(0, 1, 0.8)});
  segment('segment: rise just over the allowed rise', {from: P(0, 0, 0), to: P(0, 1, 0.81)});
  segment('segment: short rise of 0.34 m', {from: P(0, 0, 0), to: P(0, 0.1, 0.34)});
  segment('segment: short rise of 0.36 m is refused', {from: P(0, 0, 0), to: P(0, 0.1, 0.36)});
  segment('segment: drop of 0.6 m in 2 m', {from: P(0, 0, 1), to: P(0, 2, 0.4)});
  segment('segment: origin projection of 0.5 m is allowed', {from: P(4, 4, 4), to: P(4, 4.01, 4.5), projection: true});
  segment('segment: origin projection of 0.5 m on a vertical connector', {from: P(4, 4, 4), to: P(4, 4, 4.5), projection: true});
  segment('segment: projection flag with a 0.3 m rise', {from: P(4, 4, 4), to: P(4, 4, 4.3), projection: true});
  segment('segment: projection of 0.65 m', {from: P(4, 4, 4), to: P(4, 4, 4.65), projection: true});
  segment('segment: projection of 0.7 m is refused', {from: P(4, 4, 4), to: P(4, 4, 4.7), projection: true});
  segment('segment: 0.5 m rise without the projection flag is refused', {from: P(4, 4, 4), to: P(4, 4, 4.5)});
  segment('segment: projection over 2 cm of run keeps the step rule', {from: P(4, 4, 4), to: P(4, 4.05, 4.5), projection: true});
  segment('segment: projection blocked', {from: P(4, 4, 4), to: P(4, 4, 4.5), projection: true, hitAt: 1});
  segment('segment: negative rise is not a projection', {from: P(4, 4, 4), to: P(4, 4, 3.5), projection: true});
  segment('segment: invalid shape is refused', {dimensions: {radius: 0.1, height: 2}});
  segment('segment: non-finite end is refused', {to: P(0, NaN, 0)});
  segment('segment: missing start is refused', {from: null});
  segment('segment: boundary 0.6/0.2 rounds up to three boxes', {from: P(0, 0, 0), to: P(0, 0.3, 0.6)});
  segment('segment: boundary 1/0.2 is five boxes', {from: P(0, 0, 0), to: P(0, 1.2, 1)});
  return cases;
}

function rayCases() {
  const cases = [];
  const add = (name, input) => cases.push({name, input});
  const sight = (name, extra) => add(name, {fn: 'sight', from: P(100, 200, 51.6), to: P(110, 205, 51.2),
    budget: budget(192, 0), hitAt: -1, ...extra});
  sight('sight: visible');
  sight('sight: visible, no budget', {budget: null});
  SIGHT_GROUPS.forEach((group, index) => sight(`sight: blocked by ${group}`, {hitAt: index}));
  sight('sight: exactly six queries left', {budget: budget(192, 186)});
  sight('sight: negative coordinates', {from: P(-3.3, -4.4, -5.5), to: P(-30, 40, 5)});
  const floor = (name, extra) => add(name, {fn: 'floor', at: P(10, 20, 50), maxDrop: null, rayHit: true, rayZ: f32(49.7), ...extra});
  floor('floor: a floor 0.3 m below');
  floor('floor: drop of 0.04 m is too small', {rayZ: f32(49.96)});
  floor('floor: drop of 0.06 m', {rayZ: f32(49.94)});
  floor('floor: drop of 0.36 m is over the default', {rayZ: f32(49.64)});
  floor('floor: drop of 0.36 m under maxDrop 0.45', {rayZ: f32(49.64), maxDrop: 0.45});
  floor('floor: drop of 0.5 m over maxDrop 0.45', {rayZ: f32(49.5), maxDrop: 0.45});
  floor('floor: floor above the point', {rayZ: f32(50.2)});
  floor('floor: no hit', {rayHit: false, rayZ: f32(49.7)});
  floor('floor: negative coordinates', {at: P(-100.5, -200.25, -3), rayZ: f32(-3.3)});
  return cases;
}

function record(cases, system) {
  const sandbox = vm();
  sandbox.run(prelude);
  const out = [];
  for (const item of cases) {
    sandbox.run(`OUT = enc(record((function() local c = ${lit({...item.input, name: item.name})} return c end)()))`);
    out.push({name: item.name, input: item.input, output: JSON.parse(sandbox.read('OUT'))});
  }
  sandbox.close();
  return {system, source: 'mod/companion-clearance.lua', cases: out};
}
// JSON with small objects and arrays kept on one line (each query is one line of the file).
const replacer = (key, value) =>
  typeof value === 'number' && !Number.isFinite(value) ? (Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf') : value;
function pretty(value, depth = 0) {
  const inline = JSON.stringify(value, replacer);
  if (inline.length <= 200 || typeof value !== 'object' || value === null) return inline;
  const pad = ' '.repeat(depth + 1), end = ' '.repeat(depth);
  if (Array.isArray(value)) return '[\n' + value.map(item => pad + pretty(item, depth + 1)).join(',\n') + '\n' + end + ']';
  const rows = Object.entries(value).map(([key, item]) => pad + JSON.stringify(key) + ': ' + pretty(item, depth + 1));
  return '{\n' + rows.join(',\n') + '\n' + end + '}';
}
const encode = fixture => pretty(fixture) + '\n';

const recorded = {
  boxes: record(boxCases(), 'clearance'),
  rays: record(rayCases(), 'clearance'),
};

for (const [key, name] of [['boxes', 'clearance-boxes'], ['rays', 'clearance-rays']]) {
  test(`the ${name} parity fixture matches mod/companion-clearance.lua`, () => {
    const text = encode(recorded[key]);
    if (process.env.CONVAI_WRITE_FIXTURES === '1') writeFileSync(target(name), text);
    assert.equal(readFileSync(target(name), 'utf8').replace(/\r\n/g, '\n'), text,
      'Lua clearance changed: re-record with CONVAI_WRITE_FIXTURES=1 and rebuild the native tests');
  });
}

test('the recorded cases cover every outcome of the original', () => {
  const statuses = new Set(recorded.boxes.cases.map(item => item.output.status));
  for (const status of ['clear', 'blocked', 'deferred', 'unavailable', 'geometry']) assert.ok(statuses.has(status), status);
  const blocked = recorded.boxes.cases.filter(item => item.output.status === 'blocked');
  for (const group of GROUPS) assert.ok(blocked.some(item => item.output.rejection.group === group), group);
  assert.ok(recorded.boxes.cases.some(item => item.output.rejection?.geometryType === 'route-size'));
  assert.ok(recorded.boxes.cases.some(item => item.output.rejection?.geometryType === 'step-slope'));
  assert.ok(recorded.boxes.cases.some(item => item.output.next === 2), 'a deferred segment records its cursor');
  assert.ok(recorded.rays.cases.some(item => typeof item.output.z === 'number'));
});

// ---- the shim against a fake plugin ------------------------------------------------------------
const shimSetup = `
${prelude}
nativeOn, fails, calls, reply, selfTest, orientationShift = true, {}, {}, '0 6', 'ok', 0
convaiNative = {
  use = function(name) return nativeOn end,
  fail = function(name, why) fails[#fails + 1] = name .. ': ' .. tostring(why); nativeOn = false end,
}
local function answer(name)
  return function(...) calls[#calls + 1] = {name, ...}
    if type(reply) == 'function' then return reply(name, ...) end
    return reply end
end
ConvaiNativeClearance = {
  SelfTest = function() return selfTest end,
  Orientation = function(dx, dy) return '0 0 ' .. tostring(math.atan(-dx + 0.0, dy) * 180 / math.pi + orientationShift) end,
  Body = answer('Body'), Box = answer('Box'), Segment = answer('Segment'), Sight = answer('Sight'), Floor = answer('Floor'),
}
function show(list)
  local out = {}
  for index = 1, #list do out[index] = tostring(list[index]) end
  return table.concat(out, ',')
end
function deepEqual(a, b)
  if type(a) ~= type(b) then return false end
  if type(a) ~= 'table' then return a == b end
  for key, value in pairs(a) do if not deepEqual(value, b[key]) then return false end end
  for key in pairs(b) do if a[key] == nil then return false end end
  return true
end
function fresh(budgetValue)
  local mod = loadModule()
  mod.useBudget(budgetValue)
  return mod
end
`;
function shim(body) {
  const sandbox = vm();
  try { sandbox.run(shimSetup + '\n' + body); } finally { sandbox.close(); }
}

test('the shim rebuilds every recorded result from the wire text, with the same budget and cursor', () => {
  for (const [key, label] of [['boxes', 'boxes'], ['rays', 'rays']]) {
    shim(`
      local cases = ${lit(recorded[key].cases.map(item => ({name: item.name, input: item.input, output: item.output})))}
      local failures = {}
      for _, case in ipairs(cases) do
        local c, out = case.input, case.output
        queries, calls, fails, nativeOn = {}, {}, {}, true
        local budgetValue = c.budget and {limit = c.budget.limit, used = c.budget.used, deferred = 0} or nil
        local mod = fresh(budgetValue)
        reply = out.wire
        local progress = c.progress and {next = c.startBox} or nil
        local clear, reason, deferred, rejection, visible, z
        if c.fn == 'body' then clear, reason, deferred, rejection = mod.body(c.feet, c.dimensions)
        elseif c.fn == 'recheck' then clear, reason, deferred, rejection = mod.recheck(c.rejection)
        elseif c.fn == 'segment' then clear, reason, deferred, rejection = mod.segment(c.from, c.to, c.dimensions, progress, c.projection)
        elseif c.fn == 'sight' then visible = mod.sightClear(c.from, c.to)
        elseif c.fn == 'floor' then z = mod.floorZ(c.at, c.maxDrop) end
        local function check(ok, what) if not ok then failures[#failures + 1] = case.name .. ': ' .. what end end
        check(#fails == 0, 'failed: ' .. table.concat(fails, ';'))
        check(#queries == 0, 'queried the game ' .. #queries .. ' times')
        -- input the Lua refuses is answered without asking the plugin
        check(#calls == (out.status == 'unavailable' and 0 or 1), 'native calls: ' .. #calls)
        if c.fn == 'sight' then check(visible == out.visible, 'visible')
        elseif c.fn == 'floor' then check(z == out.z, 'floor z ' .. tostring(z) .. ' vs ' .. tostring(out.z))
        else
          check(clear == out.clear, 'clear ' .. tostring(clear) .. ' vs ' .. tostring(out.clear))
          check(reason == out.reason, 'reason')
          check(deferred == out.deferred, 'deferred')
          check(deepEqual(rejection, out.rejection), 'rejection')
          if c.progress then check(progress.next == out.next, 'cursor ' .. tostring(progress.next) .. ' vs ' .. tostring(out.next)) end
        end
        if budgetValue and c.fn ~= 'floor' then
          check(budgetValue.used - c.budget.used == out.used, 'budget used ' .. (budgetValue.used - c.budget.used) .. ' vs ' .. out.used)
          check(budgetValue.deferred == out.deferredCount, 'deferred count ' .. budgetValue.deferred .. ' vs ' .. tostring(out.deferredCount))
        end
      end
      assert(#failures == 0, table.concat(failures, ' | '))
    `);
    assert.ok(label);
  }
});

test('the plugin is told what is left of the budget and the inputs as the Lua had them', () => shim(`
  local mod = fresh({limit = 192, used = 100, deferred = 0})
  mod.body({x = 1, y = 2, z = 3}, {radius = 0.5, height = 1.8})
  local call = calls[1]
  assert(call[1] == 'Body' and call[2] == 1 and call[3] == 2 and call[4] == 3 and call[5] == 0.5 and call[6] == 1.8 and call[7] == 92, show(call))
  calls = {}
  mod = fresh(nil)
  mod.body({x = 1, y = 2, z = 3})
  assert(calls[1][5] == 0.4 and calls[1][6] == 2.1 and calls[1][7] == 1000000, show(calls[1]))
  calls = {}
  mod = fresh({limit = 192, used = 192, deferred = 0})
  mod.body({x = 1, y = 2, z = 3})
  assert(calls[1][7] == 0)
  calls, reply = {}, '0 0'
  mod = fresh({limit = 192, used = 0, deferred = 0})
  mod.segment({x = 0, y = 0, z = 0}, {x = 0, y = 6, z = 0}, nil, {next = 2}, true)
  call = calls[1]
  assert(call[1] == 'Segment' and call[8] == 0.4 and call[9] == 2.1 and call[10] == 2 and call[11] == true and call[12] == 192, show(call))
  calls = {}
  mod.segment({x = 0, y = 0, z = 0}, {x = 0, y = 6, z = 0})
  assert(calls[1][10] == 1 and calls[1][11] == false)
  calls = {}
  mod.recheck({center = {x = 1, y = 2, z = 3}, halfExtents = {x = 4, y = 5, z = 6}, rotation = {yaw = 90}})
  call = calls[1]
  assert(call[1] == 'Box' and call[8] == 0 and call[9] == 0 and call[10] == 90, show(call))
`));

test('with the switch off the original Lua runs and the plugin is never called', () => shim(`
  nativeOn = false
  local budgetValue = {limit = 192, used = 0, deferred = 0}
  local mod = fresh(budgetValue)
  local clear = mod.body({x = 1, y = 2, z = 3})
  assert(clear == true and #queries == 6 and #calls == 0 and budgetValue.used == 6)
  assert(mod.sightClear({x = 0, y = 0, z = 0}, {x = 1, y = 1, z = 1}) == true and #calls == 0)
  hitAt = 0
  queries = {}
  mod.segment({x = 0, y = 0, z = 0}, {x = 0, y = 4, z = 0})
  assert(#calls == 0 and #queries == 1)
`));

test('without convaiNative at all the original Lua runs', () => shim(`
  convaiNative = nil
  local mod = fresh({limit = 192, used = 0, deferred = 0})
  assert(mod.body({x = 1, y = 2, z = 3}) == true and #queries == 6 and #calls == 0)
`));

test('a native call that raises switches the system off once and the Lua answers', () => shim(`
  reply = function() error('native exploded') end
  local budgetValue = {limit = 192, used = 0, deferred = 0}
  local mod = fresh(budgetValue)
  local clear = mod.body({x = 1, y = 2, z = 3})
  assert(clear == true and #queries == 6 and budgetValue.used == 6)
  assert(#fails == 1 and fails[1]:find('clearance: body: ') and fails[1]:find('native exploded'), table.concat(fails, ';'))
  queries = {}
  mod.body({x = 1, y = 2, z = 3})
  assert(#fails == 1 and #calls == 1 and #queries == 6, 'the Lua path stays for the session')
`));

test('a failed game query keeps its spent queries in the budget, switches off and lets the Lua answer', () => shim(`
  reply = '4 2 3'
  local budgetValue = {limit = 192, used = 10, deferred = 0}
  local mod = fresh(budgetValue)
  local clear = mod.body({x = 1, y = 2, z = 3})
  assert(clear == true and #queries == 6 and budgetValue.used == 10 + 2 + 6, budgetValue.used)
  assert(#fails == 1 and fails[1]:find('code 3'), table.concat(fails, ';'))
`));

test('an unreadable reply switches the system off', () => shim(`
  for _, bad in ipairs({'', 'x y', '7', 12}) do
    nativeOn, fails, queries = true, {}, {}
    reply = bad
    local mod = fresh({limit = 192, used = 0, deferred = 0})
    assert(mod.body({x = 1, y = 2, z = 3}) == true and #queries == 6 and #fails == 1, tostring(bad))
  end
`));

test('arguments the plugin does not take run the Lua without switching anything off', () => shim(`
  local mod = fresh({limit = 192, used = 0, deferred = 0})
  local clear = mod.recheck({center = {x = 1, y = 2, z = 3}, halfExtents = {x = 1, y = 1, z = 1}, rotation = {yaw = 0 / 0}})
  assert(#calls == 0 and #fails == 0 and #queries == 6)
  queries = {}
  assert(mod.sightClear({x = 0 / 0, y = 0, z = 0}, {x = 1, y = 1, z = 1}) == true and #calls == 0 and #fails == 0)
  queries = {}
  mod.segment({x = 0, y = 0, z = 0}, {x = 0, y = 6, z = 0}, nil, {next = 1.5})
  assert(#calls == 0 and #fails == 0)
`));

test('invalid input is answered like the Lua without a native call', () => shim(`
  local budgetValue = {limit = 192, used = 0, deferred = 0}
  local mod = fresh(budgetValue)
  local clear, reason, deferred, rejection = mod.body({x = 0 / 0, y = 0, z = 0})
  assert(clear == false and reason == 'The game could not verify companion body clearance.' and deferred == nil and rejection.unavailable == true)
  assert(#calls == 0 and #queries == 0 and budgetValue.used == 0 and #fails == 0)
  clear, reason, deferred, rejection = mod.segment({x = 0, y = 0, z = 0}, {x = 1, y = 1, z = 1}, {radius = 5, height = 2})
  assert(clear == false and rejection.unavailable == true and #calls == 0)
`));

test('the self-test: a failure keeps the Lua, a missing world waits and retries', () => shim(`
  selfTest = 'fail void box reported a hit'
  local mod = fresh({limit = 192, used = 0, deferred = 0})
  assert(mod.body({x = 1, y = 2, z = 3}) == true and #queries == 6 and #calls == 0)
  assert(#fails == 1 and fails[1]:find('self%-test: fail void box'), table.concat(fails, ';'))

  nativeOn, fails, queries, selfTest = true, {}, {}, 'wait no player'
  convaiNative.clearanceProven, convaiNative.clearanceRetry = nil, nil
  mod = fresh({limit = 192, used = 0, deferred = 0})
  assert(mod.body({x = 1, y = 2, z = 3}) == true and #queries == 6 and #calls == 0 and #fails == 0)
  queries = {}
  mod.body({x = 1, y = 2, z = 3})
  assert(#calls == 0 and #queries == 6, 'no new attempt inside the 2 s wait')
  selfTest, convaiNative.clearanceRetry, queries = 'ok', os.clock() - 1, {}
  mod.body({x = 1, y = 2, z = 3})
  assert(#calls == 1 and #queries == 0 and convaiNative.clearanceProven == true, 'native after the wait')
  assert(logLines[#logLines]:find('clearance self%-test passed'))
`));

test('the self-test: a plugin whose box orientation differs from the game stays off', () => shim(`
  orientationShift = 5
  local mod = fresh({limit = 192, used = 0, deferred = 0})
  assert(mod.body({x = 1, y = 2, z = 3}) == true and #queries == 6 and #calls == 0)
  assert(#fails == 1 and fails[1]:find('orientation of'), table.concat(fails, ';'))
`));

test('a missing plugin class keeps the Lua and says so', () => shim(`
  ConvaiNativeClearance = nil
  local mod = fresh({limit = 192, used = 0, deferred = 0})
  assert(mod.body({x = 1, y = 2, z = 3}) == true and #queries == 6)
  assert(#fails == 1 and fails[1]:find('not registered'), table.concat(fails, ';'))
`));

test('a deferred segment stores its cursor and a finished one clears it', () => shim(`
  local budgetValue = {limit = 192, used = 0, deferred = 0}
  local mod = fresh(budgetValue)
  local progress = {next = 2}
  reply = '2 12 3'
  local clear, reason, deferred = mod.segment({x = 0, y = 0, z = 0}, {x = 0, y = 6, z = 0}, nil, progress)
  assert(clear == nil and reason == nil and deferred == true and progress.next == 3)
  assert(budgetValue.used == 12 and budgetValue.deferred == 1)
  reply = '0 6'
  assert(mod.segment({x = 0, y = 0, z = 0}, {x = 0, y = 6, z = 0}, nil, progress) == true and progress.next == nil)
  progress.next = 2
  reply = '1 3 1 0 0 0 1 1 1 0 0 0 2 3'
  assert(mod.segment({x = 0, y = 0, z = 0}, {x = 0, y = 6, z = 0}, nil, progress) == false and progress.next == 2, 'a rejection leaves the cursor')
`));

test('verify mode runs both paths, returns the Lua answer and logs a difference', () => shim(`
  convaiNative.clearanceVerify = true
  local budgetValue = {limit = 192, used = 0, deferred = 0}
  local mod = fresh(budgetValue)
  reply = '0 6'
  assert(mod.body({x = 1, y = 2, z = 3}) == true)
  assert(#queries == 6 and budgetValue.used == 6, 'the Lua path ran and spent the budget once')
  assert(convaiNative.clearanceStats.compared == 1 and convaiNative.clearanceStats.mismatches == 0 and #logLines == 1)

  hitAt, queries = 2, {}
  reply = '0 6' -- the plugin says clear, the world says blocked
  local clear, reason, deferred, rejection = mod.body({x = 1, y = 2, z = 3})
  assert(clear == false and rejection.group == 'Vehicle', 'the answer is the Lua one')
  assert(convaiNative.clearanceStats.mismatches == 1, 'one mismatch')
  assert(logLines[#logLines]:find('clearance MISMATCH in body'), logLines[#logLines])

  hitAt, queries = -1, {}
  reply = '0 5' -- same answer, different cost
  mod.body({x = 1, y = 2, z = 3})
  assert(convaiNative.clearanceStats.mismatches == 2)
`));

test('statistics count what ran where', () => shim(`
  local mod = fresh({limit = 192, used = 0, deferred = 0})
  reply = '0 6'
  mod.body({x = 1, y = 2, z = 3})
  mod.body({x = 1, y = 2, z = 3})
  assert(convaiNative.clearanceStats.native == 2 and convaiNative.clearanceStats.fallback == 0)
`));

test('the active path is announced once, after the plugin check has finished', () => shim(`
  local asked = 0
  convaiNative.pending = true
  convaiNative.use = function() asked = asked + 1; return true end
  local mod = loadModule()
  mod.useBudget({limit = 192, used = 0, deferred = 0})
  mod.useBudget({limit = 192, used = 0, deferred = 0})
  assert(asked == 0, 'not while the plugin may still be bound later')
  convaiNative.pending = false
  mod.useBudget({limit = 192, used = 0, deferred = 0})
  mod.useBudget({limit = 192, used = 0, deferred = 0})
  assert(asked == 1, 'asked ' .. asked)
`));

test('a ray without a point runs the Lua and never switches the system off', () => shim(`
  local mod = fresh({limit = 192, used = 0, deferred = 0})
  local ok = pcall(mod.sightClear, nil, {x = 1, y = 1, z = 1})
  assert(not ok and #fails == 0 and #calls == 0, 'the original raises on a missing point')
  ok = pcall(mod.floorZ, nil, 0.35)
  assert(not ok and #fails == 0 and #calls == 0)
`));
