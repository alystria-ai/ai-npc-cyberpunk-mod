import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

// The native companion tick (plugin system "actuator", mod/companion-tick-native.lua).
//   1. Records the Lua tick maths from the real mod/companions.lua into
//      native/core/tests/fixtures/actuator-sense.json (CONVAI_WRITE_FIXTURES=1), which
//      native/core/tests/actuator_tests.cpp replays. Otherwise the committed fixture must equal the Lua.
//   2. Drives the same scenario with a fake plugin and checks that every companion field, command
//      and event is identical with the native path on and off, that the native path makes far fewer
//      game calls, and that every fallback (read unavailable, fault, switch, missing capability)
//      returns to the original Lua without changing behaviour.

const shim = readFileSync(new URL('../mod/companion-tick-native.lua', import.meta.url), 'utf8');
const fixtureUrl = new URL('../native/core/tests/fixtures/actuator-sense.json', import.meta.url);
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

// The engine of the other companion suites, plus the tick shim as a loadable module and a hook on
// the behaviour module that keeps the context companions.lua built for the last decision.
const engine = companionEngine
  .replace("error('Unexpected module '..file)", () => `if file=='companion-tick-native.lua' then return (function() ${shim} end)() end
    error('Unexpected module '..file)`)
  .replace('  local companions=(function()', () => `  local baseDofile=dofile
  MODULES={}
  dofile=function(file) local module=baseDofile(file); MODULES[file]=module; return module end
  local companions=(function()`);

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(engine + code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  let out = '';
  if (status === lua.LUA_OK) {
    lua.lua_getglobal(state, to_luastring('OUT'));
    out = lua.lua_isstring(state, -1) ? to_jsstring(lua.lua_tostring(state, -1)) : '';
  }
  lua.lua_close(state); assert.equal(status, lua.LUA_OK, error);
  return out;
}

const f32 = Math.fround;
// Positions and vectors as the game hands them over: float32 values.
const steps = [];
function step(p) { steps.push({x: f32(p.x), y: f32(p.y), z: f32(p.z ?? 0), fx: f32(p.fx ?? 0), fy: f32(p.fy ?? 1),
  px: f32(p.px ?? 0), py: f32(p.py ?? 0), pz: f32(p.pz ?? 0), dt: p.dt ?? 0.2, name: p.name}); }
// standing still beside V, facing every cardinal direction
for (const [i, [fx, fy]] of [[0, 1], [1, 0], [-1, 0], [0, -1], [0.6, 0.8], [3, 4]].entries()) {
  step({name: `still facing ${fx},${fy}`, x: 1.5, y: 0.05, fx, fy});
}
// walking away along +y at 1.4 m/s, then running at 6 m/s, then jitter smaller than a step
let y = 0.05;
for (const speed of [1.4, 1.4, 1.4, 6, 6, 6, 0.004, 0.004, 0]) {
  y += speed * 0.2; step({name: `walk ${speed} m/s`, x: 1.5, y, fx: 0, fy: 1, px: 0, py: y - 0.05});
}
// forward vectors near the unit threshold (length < 0.0001 becomes (0, 1))
for (const [fx, fy] of [[0.00005, 0], [0.0001, 0], [0.0002, 0], [0, 0], [-0.00008, 0.00005]]) {
  step({name: `forward ${fx},${fy}`, x: 2, y: 3, fx, fy, px: 0, py: 2});
}
// V on the same ground spot (bearing 0 -> (0, 1)), ahead, behind, to the left; vertical offsets
step({name: 'V on the same spot', x: 3, y: 3, px: 3, py: 3, fx: 1, fy: 0});
step({name: 'V on the same spot, other z', x: 3, y: 3, z: 0.4, px: 3, py: 3, pz: 2, fx: 0, fy: 1});
step({name: 'facing V', x: 4, y: 0, px: 0, py: 0, fx: -1, fy: 0});
step({name: 'facing away from V', x: 4, y: 0, px: 0, py: 0, fx: 1, fy: 0});
step({name: 'V to the left', x: 4, y: 0, px: 4, py: 2, fx: 0, fy: 1});
step({name: 'V above', x: 4, y: 0, z: 0, px: 4, py: 1, pz: 3, fx: 0, fy: 1});
step({name: 'slightly off V', x: 4.0000001, y: 0.0000003, px: 0, py: 0, fx: -1, fy: 0.0000001});
// other step lengths
for (const dt of [0.1, 0.25, 0.5, 1, 2]) {
  step({name: `step ${dt}`, x: 2.5, y: 1 + dt, px: 0, py: 1, fx: 0.3, fy: 0.9, dt});
}
// negative and large world coordinates (the player walks, so the group frame stays continuous)
for (const [ox, oy, oz] of [[-1234.5678, -3200.123, 17.77], [4321.987, 2765.4321, -3.5]]) {
  step({name: `far from the origin ${ox}`, x: ox + 1.5, y: oy + 0.05, z: oz, px: ox, py: oy, pz: oz, fx: 0.2, fy: -0.97});
  step({name: `far from the origin, moved ${ox}`, x: ox + 1.7, y: oy + 0.65, z: oz, px: ox, py: oy + 0.6, pz: oz, fx: 0.25, fy: -0.95});
}

const lit = value => (typeof value === 'number' ? (Number.isInteger(value) ? String(value) : value.toPrecision(17)) : JSON.stringify(value));
const stepsLua = '{' + steps.map(s => `{x=${lit(s.x)},y=${lit(s.y)},z=${lit(s.z)},fx=${lit(s.fx)},fy=${lit(s.fy)},px=${lit(s.px)},py=${lit(s.py)},pz=${lit(s.pz)},dt=${lit(s.dt)},name=${JSON.stringify(s.name)}}`).join(',') + '}';

// A deterministic text form of any table: sorted keys, numbers with full precision.
const serializer = `
local function dump(value, out)
  local kind = type(value)
  if kind == 'number' then out[#out + 1] = string.format('%.17g', value)
  elseif kind == 'string' then out[#out + 1] = string.format('%q', value)
  elseif kind == 'table' then
    local keys = {}
    for key in pairs(value) do keys[#keys + 1] = key end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    out[#out + 1] = '{'
    for _, key in ipairs(keys) do
      if type(value[key]) ~= 'function' then
        out[#out + 1] = tostring(key) .. '='; dump(value[key], out); out[#out + 1] = ','
      end
    end
    out[#out + 1] = '}'
  else out[#out + 1] = tostring(value) end
end
function serialize(value) local out = {}; dump(value, out); return table.concat(out) end
`;

// The decision hook: companions.lua builds one context per companion per tick for behaviour.decide.
const hook = `
  LAST = nil
  do
    local behavior = MODULES['companion-behavior.lua']
    local decide = behavior.decide
    behavior.decide = function(person, context, stepSeconds) LAST = context; return decide(person, context, stepSeconds) end
  end
  local enum = {NotExecuting = 0, Enqueued = 1, Executing = 2, Cancelled = 3, Interrupted = 4, Success = 5, Failure = 6}
  ENUM = enum
  function useCetStates(npc)
    npc.ai.GetCommandState = function(_, command) return 'AICommandState : ' .. command.state .. ' (' .. enum[command.state] .. ')' end
  end
`;

test('the tick maths of the real companions.lua match the committed parity fixture', () => {
  const out = run(`${serializer}${hook}
    local STEPS = ${stepsLua}
    local npc = spawn(); useCetStates(npc)
    local rows = {}
    for index, s in ipairs(STEPS) do
      local hadPrevious = companions.list()[1].npcZ ~= nil
      local previous = npc.pos
      npc.pos = Vector4.new(s.x, s.y, s.z); npc.forward = Vector4.new(s.fx, s.fy)
      player.pos = Vector4.new(s.px, s.py, s.pz)
      LAST = nil
      companions.update(player, s.dt)
      local list = companions.list()[1]
      assert(not list.error, list.error)
      if LAST then
        rows[#rows + 1] = {name = s.name, hasPrevious = hadPrevious, previousX = previous.x, previousY = previous.y,
          x = s.x, y = s.y, z = s.z, forwardX = s.fx, forwardY = s.fy, playerX = s.px, playerY = s.py, playerZ = s.pz,
          step = s.dt, speed = LAST.speed, directionX = LAST.direction.x, directionY = LAST.direction.y,
          playerGap = LAST.playerGap, facingError = LAST.facingError,
          listSpeed = list.npcSpeed, listGap = list.distanceToPlayer, listFacing = list.facingErrorDegrees}
      end
    end
    local out = {}
    for _, row in ipairs(rows) do
      out[#out + 1] = string.format('%s\\t%s\\t%.17g\\t%.17g\\t%.17g\\t%.17g\\t%.17g\\t%.17g\\t%.17g\\t%.17g\\t%.17g\\t%.17g\\t%.17g\\t%.17g\\t%.17g\\t%.17g\\t%.17g\\t%.17g\\t%.17g\\t%.17g',
        row.name, tostring(row.hasPrevious), row.previousX, row.previousY, row.x, row.y, row.z, row.forwardX, row.forwardY,
        row.playerX, row.playerY, row.playerZ, row.step, row.speed, row.directionX, row.directionY, row.playerGap,
        row.facingError, row.listGap, row.listFacing)
      assert(row.listSpeed == row.speed and row.listGap == row.playerGap and row.listFacing == row.facingError)
    end
    OUT = table.concat(out, '\\n')
  `);
  const cases = out.split('\n').map(line => {
    const [name, hasPrevious, ...n] = line.split('\t');
    const v = n.map(Number);
    return {name, input: {hasPrevious: hasPrevious === 'true', previousX: v[0], previousY: v[1], x: v[2], y: v[3], z: v[4],
      forwardX: v[5], forwardY: v[6], playerX: v[7], playerY: v[8], playerZ: v[9], step: v[10]},
      output: {speed: v[11], directionX: v[12], directionY: v[13], playerGap: v[14], facingError: v[15]}};
  });
  assert.ok(cases.length >= 30, `only ${cases.length} steps reached a decision`);
  assert.ok(cases.some(c => !c.input.hasPrevious) || cases.every(c => c.input.hasPrevious));
  // The layout of the reply and the constants the plugin must agree with, taken from the shim itself.
  const meta = run(`
    local M = dofile('companion-tick-native.lua')
    local caps, names = {}, {}
    for name in pairs(M.CAPABILITY) do names[#names + 1] = name end
    table.sort(names)
    for _, name in ipairs(names) do caps[#caps + 1] = name .. '=' .. M.CAPABILITY[name] end
    local flags, flagNames = {}, {}
    for name in pairs(M.FLAG) do flagNames[#flagNames + 1] = name end
    table.sort(flagNames)
    for _, name in ipairs(flagNames) do flags[#flags + 1] = name .. '=' .. M.FLAG[name] end
    local states = {}
    for number = 0, #M.STATES do states[#states + 1] = M.LABEL[number] end
    OUT = M.FIELDS .. '\\n' .. table.concat(caps, ' ') .. '\\n' .. table.concat(flags, ' ') .. '\\n'
      .. table.concat(states, '|') .. '\\n' .. M.REQUIRED
  `).split('\n');
  const wire = {name: 'wire-layout', input: {}, output: {fields: meta[0], capabilities: meta[1], flags: meta[2], states: meta[3], required: Number(meta[4])}};
  const text = JSON.stringify({system: 'actuator', source: 'mod/companions.lua sense step + mod/companion-space.lua + mod/companion-tick-native.lua',
    cases: [wire, ...cases]}, null, 1) + '\n';
  if (process.env.CONVAI_WRITE_FIXTURES === '1') writeFileSync(fixtureUrl, text);
  assert.equal(readFileSync(fixtureUrl, 'utf8').replace(/\r\n/g, '\n'), text,
    'The Lua tick changed: re-record with CONVAI_WRITE_FIXTURES=1 and rebuild the native tests');
});

// A fake plugin: the same reads and maths from the fake game objects, in the wire format the C++ writes.
const fakePlugin = `
  calls = {}
  local function count(name) calls[name] = (calls[name] or 0) + 1 end
  failures = {}
  switchOn = true
  -- Only the actuator system exists in this fake plugin; the other systems stay on Lua.
  -- The system and its parts (actuator.life, actuator.sense, actuator.state) answer to the same switch,
  -- unless a test turns one part off on its own.
  partsOff = {}
  convaiNative = {use = function(name)
      if name ~= 'actuator' and not name:find('^actuator%.') then return false end
      count('use'); return switchOn and not partsOff[name] end,
    fail = function(name, detail) if name ~= 'actuator' then return end failures[#failures + 1] = tostring(detail); switchOn = false end}
  -- probe.log lines of the shim, for the tests that read them.
  LOGLINES = {}
  io.open = function() return {write = function(self, ...) LOGLINES[#LOGLINES + 1] = table.concat({...}); return self end,
    close = function() return true end} end
  -- The proof of the real shim takes 40 senses and the canary runs every 100th: the older tests ask for
  -- the native answers from the first tick, and the proof tests below configure their own.
  if not KEEP_PROOF then MODULES['companion-tick-native.lua'].configure(0, 0, 0) end
  local space = MODULES['companion-space.lua']
  local capabilities = 127
  function setCapabilities(value) capabilities = value end
  unavailable = {}      -- name -> true: the plugin cannot make this read
  local function num(value) return string.format('%.17g', value) end
  ConvaiNativeActuator = {
    Capabilities = function() count('Capabilities'); return capabilities end,
    Life = function(npc)
      count('Life'); if unavailable.life then return -1 end
      if npc.detached then return 0 end
      return npc.dead and 1 or 2
    end,
    CommandState = function(npc, command)
      count('CommandState'); if unavailable.state or npc.detached then return -1 end
      return ENUM[command.state]
    end,
  }
  local function sense(npc, command, hasPrevious, previousX, previousY, playerX, playerY, playerZ, stepSeconds)
    count('Sense'); if unavailable.sense then return '' end
    local p, f = npc.pos, npc.forward
    local speed = hasPrevious and space.ground({x = previousX, y = previousY}, p) / stepSeconds or 0
    local direction = space.unit(f.x, f.y)
    -- BIAS_Z: a plugin that reads a different height than the game does (a test sets it).
    local at, player = {x = p.x, y = p.y, z = (p.z or 0) + (BIAS_Z or 0), w = p.w or 1}, {x = playerX, y = playerY, z = playerZ}
    local gap = space.distance(at, player)
    local facing = space.angle(direction, space.bearing(at, player))
    local flags, state, id = 0, -1, -1
    if not unavailable.combat then flags = flags + 1 + (npc.combat and 2 or 0) end
    if command and not unavailable.state then flags = flags + 4; state = ENUM[command.state] end
    if command and not unavailable.id then flags = flags + 8; id = command.id or 0 end
    return table.concat({flags, num(at.x), num(at.y), num(at.z), num(at.w), num(f.x), num(f.y), state, id,
      num(speed), num(direction.x), num(direction.y), num(gap), num(facing)}, ' ')
  end
  ConvaiNativeActuator.Sense = function(npc, command, ...) return sense(npc, command, ...) end
  ConvaiNativeActuator.SenseIdle = function(npc, ...) return sense(npc, nil, ...) end
  -- Count what the Lua path asks the game for.
  function countGameCalls(npc)
    for _, name in ipairs({'IsAttached', 'IsDeadNoStatPool', 'GetWorldPosition', 'GetWorldForward', 'GetAIControllerComponent'}) do
      local original = npc[name]
      npc[name] = function(...) count('game.' .. name); return original(...) end
    end
    local ai = npc.ai
    local state = ai.GetCommandState
    ai.GetCommandState = function(...) count('game.GetCommandState'); return state(...) end
    local combat = NPCPuppet.IsInCombat
    NPCPuppet.IsInCombat = function(...) count('game.IsInCombat'); return combat(...) end
  end
`;

// One scenario with a mix of behaviours: standing, walking away with V, stopping, a combat flag, a release.
const scenario = `
  local STEPS = ${stepsLua}
  local npc = spawn(); useCetStates(npc); countGameCalls(npc)
  local log = {}
  local function snapshot(label)
    local rows = companions.list()
    log[#log + 1] = label .. ':' .. serialize(rows)
  end
  for index, s in ipairs(STEPS) do
    npc.pos = Vector4.new(s.x, s.y, s.z); npc.forward = Vector4.new(s.fx, s.fy)
    player.pos = Vector4.new(s.px, s.py, s.pz)
    npc.combat = index % 11 == 5
    companions.update(player, s.dt)
    snapshot(index)
  end
  for i = 1, 12 do companions.update(player, 0.5); snapshot('late' .. i) end
  OUT = table.concat(log, '\\n')
`;

const tally = `
    local names = {}
    for name, n in pairs(calls) do if name:find('^game%.') or name == 'Life' or name == 'Sense' or name == 'SenseIdle'
      or name == 'CommandState' then names[#names + 1] = name .. '=' .. n end end
    table.sort(names)
    OUT = OUT .. '\\nCALLS ' .. table.concat(names, ' ')
`;
const parseCalls = text => Object.fromEntries(text.slice(text.lastIndexOf('\nCALLS ') + 7).split(' ').filter(Boolean)
  .map(pair => { const [name, n] = pair.split('='); return [name, Number(n)]; }));
const ticks = text => text.slice(0, text.lastIndexOf('\nCALLS '));

test('with the plugin on, every companion field and command matches the Lua path, with far fewer game calls', () => {
  const body = `${serializer}${hook}${fakePlugin}`;
  const off = run(`${body}
    switchOn = false
    ${scenario}
    ${tally}`);
  const on = run(`${body}
    ${scenario}
    assert(#failures == 0, table.concat(failures, ';'))
    ${tally}`);
  const offLines = ticks(off).split('\n'), onLines = ticks(on).split('\n');
  assert.equal(onLines.length, offLines.length);
  for (let i = 0; i < offLines.length; i++) assert.equal(onLines[i], offLines[i], `snapshot ${i} differs`);
  const lua = parseCalls(off), native = parseCalls(on);
  const nativeCalls = (native.Life ?? 0) + (native.Sense ?? 0) + (native.SenseIdle ?? 0) + (native.CommandState ?? 0);
  const luaCalls = Object.entries(lua).filter(([name]) => name.startsWith('game.')).reduce((sum, [, n]) => sum + n, 0);
  const remaining = Object.entries(native).filter(([name]) => name.startsWith('game.')).reduce((sum, [, n]) => sum + n, 0);
  assert.equal(Object.keys(lua).filter(name => !name.startsWith('game.')).length, 0, 'the Lua run must not call the plugin');
  console.log(`game calls over ${offLines.length} snapshots: Lua path ${luaCalls}, native path ${remaining} + ${nativeCalls} plugin calls`);
  console.log(' Lua path:', JSON.stringify(lua)); console.log(' native path:', JSON.stringify(native));
  assert.ok(nativeCalls > 0);
  // The tick's own reads are gone from the game side: only calls made by other modules remain.
  for (const name of ['game.GetWorldForward', 'game.IsInCombat']) assert.equal(native[name] ?? 0, 0, name);
  assert.ok(remaining + nativeCalls < luaCalls * 0.6, `${remaining} + ${nativeCalls} vs ${luaCalls}`);
});

test('a read the plugin cannot make is read by Lua, with identical results', () => {
  const body = `${serializer}${hook}${fakePlugin}`;
  const reference = run(`${body}
    switchOn = false
    ${scenario}`);
  for (const name of ['life', 'sense', 'state', 'combat', 'id']) {
    const out = run(`${body}
      unavailable.${name} = true
      ${scenario}
      assert(#failures == 0, table.concat(failures, ';'))
      ${{life: "assert((calls['game.IsDeadNoStatPool'] or 0) > 0, 'Lua should have asked for the life state')",
        sense: "assert((calls['game.GetWorldForward'] or 0) > 0, 'Lua should have read the forward vector')",
        state: "assert((calls['game.GetCommandState'] or 0) > 0, 'Lua should have read the command state')",
        combat: "assert((calls['game.IsInCombat'] or 0) > 0, 'Lua should have read the combat flag')",
        id: ''}[name]}
    `);
    assert.equal(out, reference, `unavailable ${name} changed behaviour`);
  }
});

test('the kill switch flips both ways mid-scenario without changing behaviour', () => {
  const body = `${serializer}${hook}${fakePlugin}`;
  const reference = run(`${body}
    switchOn = false
    ${scenario}`);
  const out = run(`${body}
    local STEPS = ${stepsLua}
    local npc = spawn(); useCetStates(npc); countGameCalls(npc)
    local log = {}
    local nativeBefore, gameBefore
    for index, s in ipairs(STEPS) do
      switchOn = (index // 7) % 2 == 0   -- 7 ticks native, 7 ticks Lua, ...
      npc.pos = Vector4.new(s.x, s.y, s.z); npc.forward = Vector4.new(s.fx, s.fy)
      player.pos = Vector4.new(s.px, s.py, s.pz)
      npc.combat = index % 11 == 5
      companions.update(player, s.dt)
      log[#log + 1] = index .. ':' .. serialize(companions.list())
    end
    for i = 1, 12 do switchOn = i % 2 == 0; companions.update(player, 0.5); log[#log + 1] = 'late' .. i .. ':' .. serialize(companions.list()) end
    OUT = table.concat(log, '\\n')
    assert((calls.Sense or 0) + (calls.SenseIdle or 0) > 0 and (calls['game.GetWorldPosition'] or 0) > 0)
  `);
  assert.equal(out, reference);
});

test('a plugin fault turns the system off for the session and Lua carries on', () => {
  const body = `${serializer}${hook}${fakePlugin}`;
  const reference = run(`${body}
    switchOn = false
    ${scenario}`);
  for (const broken of ['Life', 'Sense', 'SenseIdle', 'CommandState']) {
    const out = run(`${body}
      ConvaiNativeActuator.${broken} = function() error('native exploded') end
      ${scenario}
      assert(#failures >= 1 and failures[1]:find('native exploded'), 'the fault must be reported once to convaiNative.fail')
      assert(#failures == 1, 'and only once')
    `);
    assert.equal(out, reference, `${broken} fault changed behaviour`);
  }
  // A reply the shim cannot read is a fault too.
  const garbled = run(`${body}
    ConvaiNativeActuator.Sense = function() return 'not a reply' end
    ConvaiNativeActuator.SenseIdle = ConvaiNativeActuator.Sense
    ${scenario}
    assert(#failures == 1 and failures[1]:find('unreadable'), table.concat(failures, ';'))
  `);
  assert.equal(garbled, reference);
});

test('a plugin without the required game functions is refused at the first use', () => {
  const body = `${serializer}${hook}${fakePlugin}`;
  const reference = run(`${body}
    switchOn = false
    ${scenario}`);
  const out = run(`${body}
    setCapabilities(127 - 4)  -- no GetWorldPosition
    ${scenario}
    assert(#failures == 1 and failures[1]:find('game functions missing: worldPosition'), table.concat(failures, ';'))
    assert((calls.Sense or 0) + (calls.SenseIdle or 0) + (calls.Life or 0) == 0)
  `);
  assert.equal(out, reference);
  // Optional capabilities (command state, id, combat) only make Lua keep those reads: no failure.
  const partial = run(`${body}
    setCapabilities(15)
    ${scenario}
    assert(#failures == 0)
  `);
  assert.equal(partial, reference);
});

test('without convaiNative or the module the original Lua reads run', () => {
  const body = `${serializer}${hook}${fakePlugin}`;
  const reference = run(`${body}
    switchOn = false
    ${scenario}`);
  const out = run(`${body}
    convaiNative = nil
    ${scenario}
    assert((calls.Sense or 0) + (calls.Life or 0) == 0)
  `);
  assert.equal(out, reference);
});

// The parity proof (2026-10-13): the plugin's answers are compared with Lua's own reads before they are used.
test('the parity proof: Lua answers while it runs, then the plugin, with identical results', () => {
  const body = `${serializer}${hook}${fakePlugin}`;
  const reference = run(`${body}
    switchOn = false
    ${scenario}`);
  const out = run(`KEEP_PROOF = true
    ${body}
    local shimModule = MODULES['companion-tick-native.lua']
    shimModule.configure(12, 3, 7)
    ${scenario}
    local state = shimModule.state()
    assert(state.proven == true, 'the proof should have finished: ' .. serialize(state))
    assert(state.mismatches == 0 and state.ticks == 12 and state.moving >= 3, serialize(state))
    assert(state.compared > 12, 'the canary keeps comparing after the proof: ' .. serialize(state))
    assert(#failures == 0, table.concat(failures, ';'))
    assert((calls.Sense or 0) + (calls.SenseIdle or 0) > 12, 'the plugin was called every tick')
    local proven = false
    for _, line in ipairs(LOGLINES) do
      if line:find('parity proven over 12 senses') then proven = true end
      assert(not line:find('PARITY MISMATCH'), line)
    end
    assert(proven, table.concat(LOGLINES, '|'))
  `);
  assert.equal(out, reference);
});

test('the proof needs the companion to walk: standing still proves nothing', () => {
  const body = `${serializer}${hook}${fakePlugin}`;
  const out = run(`KEEP_PROOF = true
    ${body}
    local shimModule = MODULES['companion-tick-native.lua']
    shimModule.configure(5, 3, 0)
    local npc = spawn(); useCetStates(npc)
    npc.pos = Vector4.new(1.5, 0.05, 0); npc.forward = Vector4.new(0, 1)
    for i = 1, 30 do companions.update(player, 0.2) end
    local state = shimModule.state()
    assert(state.proven == false and state.ticks >= 5 and state.moving == 0, serialize(state))
    OUT = 'ok'
  `);
  assert.equal(out, 'ok');
});

test('a plugin that reads a different height is caught by the proof, logged, and switched off', () => {
  const body = `${serializer}${hook}${fakePlugin}`;
  const reference = run(`${body}
    switchOn = false
    ${scenario}`);
  const out = run(`KEEP_PROOF = true
    ${body}
    local shimModule = MODULES['companion-tick-native.lua']
    shimModule.configure(12, 3, 7)
    BIAS_Z = 0.3
    ${scenario}
    local state = shimModule.state()
    assert(state.proven == false and state.mismatches >= 3, serialize(state))
    assert(#failures == 1 and failures[1]:find('parity'), table.concat(failures, ';'))
    local zLines = 0
    for _, line in ipairs(LOGLINES) do if line:find('PARITY MISMATCH position%.z: plugin') then zLines = zLines + 1 end end
    assert(zLines >= 1, table.concat(LOGLINES, '|'))
  `);
  // The Lua reads answered throughout: the companion behaved exactly as without the plugin.
  assert.equal(out, reference);
});

test('the canary catches a plugin that starts to differ after the proof passed', () => {
  const body = `${serializer}${hook}${fakePlugin}`;
  const out = run(`KEEP_PROOF = true
    ${body}
    local shimModule = MODULES['companion-tick-native.lua']
    shimModule.configure(8, 2, 3)
    local STEPS = ${stepsLua}
    local npc = spawn(); useCetStates(npc)
    local provenAt
    for index, s in ipairs(STEPS) do
      npc.pos = Vector4.new(s.x, s.y, s.z); npc.forward = Vector4.new(s.fx, s.fy)
      player.pos = Vector4.new(s.px, s.py, s.pz)
      if index == 24 then BIAS_Z = 0.3 end
      companions.update(player, s.dt)
      if not provenAt and shimModule.state().proven then provenAt = index end
    end
    assert(provenAt and provenAt < 24, 'proven before the plugin starts to differ: ' .. tostring(provenAt))
    assert(#failures == 1 and failures[1]:find('parity'), table.concat(failures, ';'))
    OUT = 'ok'
  `);
  assert.equal(out, 'ok');
});

test('verify mode compares every tick and never lets the plugin answer', () => {
  const body = `${serializer}${hook}${fakePlugin}`;
  const reference = run(`${body}
    switchOn = false
    ${scenario}`);
  const out = run(`KEEP_PROOF = true
    ${body}
    local shimModule = MODULES['companion-tick-native.lua']
    shimModule.configure(0, 0, 0)
    convaiNative.verifying = function(name) return name == 'actuator' end
    ${scenario}
    local state = shimModule.state()
    assert(state.compared >= 30 and state.mismatches == 0, serialize(state))
    assert(#failures == 0, table.concat(failures, ';'))
  `);
  assert.equal(out, reference);
  // A difference is reported in verify mode too, and Lua still answers.
  const bad = run(`KEEP_PROOF = true
    ${body}
    MODULES['companion-tick-native.lua'].configure(0, 0, 0)
    convaiNative.verifying = function() return true end
    BIAS_Z = 0.3
    ${scenario}
    assert(#failures == 1 and failures[1]:find('parity'), table.concat(failures, ';'))
  `);
  assert.equal(bad, reference);
});

test('one part of the system can be turned off on its own', () => {
  const body = `${serializer}${hook}${fakePlugin}`;
  const reference = run(`${body}
    switchOn = false
    ${scenario}`);
  for (const [part, silent, other] of [['life', 'Life', 'Sense'], ['sense', 'Sense', 'Life'], ['state', 'CommandState', 'Sense']]) {
    const out = run(`${body}
      partsOff['actuator.${part}'] = true
      ${scenario}
      assert((calls.${silent} or 0) == 0, '${part} is off, so ${silent} is never called')
      assert((calls.${other} or 0) + (calls.SenseIdle or 0) > 0, 'the other parts stay native')
      assert(#failures == 0)
    `);
    assert.equal(out, reference, `${part} off changed behaviour`);
  }
});

test('companions.lua and the actuator keep the shim optional and use it only in the tick', () => {
  const companions = readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8');
  const actuator = readFileSync(new URL('../mod/companion-actuator.lua', import.meta.url), 'utf8');
  assert.match(companions, /pcall\(dofile, 'companion-tick-native\.lua'\)/);
  assert.match(actuator, /function M\.useNativeTick/);
  // The shim only ever reads: no command, look or teleport goes through it.
  assert.ok(!/SendCommand|QueueEvent|Teleport/.test(shim));
});
