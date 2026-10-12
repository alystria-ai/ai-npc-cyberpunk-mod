import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

// The parity recorder and the shim checks for the native "gaze" system (native/core/src/systems/gaze).
// The fixture native/core/tests/fixtures/gaze-requests.json holds what mod/companion-actuator.lua's own
// look() builds for a grid of styles, settings and mood drops. CONVAI_WRITE_FIXTURES=1 rewrites it;
// otherwise the committed file must equal the Lua output, so a Lua change that breaks parity fails here.

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  const output = result === lua.LUA_OK && lua.lua_isstring(state, -1) ? to_jsstring(lua.lua_tostring(state, -1)) : '';
  lua.lua_close(state); assert.equal(result, lua.LUA_OK, error);
  return output;
}

// Fakes that remember what look() writes. SetStyle keeps its argument (the shared fixture ignores it).
const recordingEvent = `
  LookAtAddEvent={new=function() return {request={limits={}},
    SetEntityTarget=function(self,target,slot,offset)
      self.target,self.slot,self.offset=target,slot,offset
      self.targetPositionProvider={SetWorldOffset=function(provider,value) provider.worldOffset=value end}
    end,
    SetStyle=function(self,value) self.styleValue=value end,
    SetAdditionalPartsArray=function(self,parts) self.parts=parts end} end}
`;

const fixture = `${companionEngine}
  ${recordingEvent}
  local actuator=dofile('companion-actuator.lua')
  local id=system:CreateEntity({position=Vector4.new(1.5,0)})
  local npc=system:GetEntity(id)
  local function fresh()
    local motor=actuator.new(npc)
    return motor
  end
`;

// A tiny deterministic JSON writer (sorted keys, %.17g numbers) so the fixture is stable text.
const encoder = `
  local function encode(value, indent)
    local kind = type(value)
    if kind == 'nil' then return 'null' end
    if kind == 'boolean' then return tostring(value) end
    if kind == 'number' then
      if value ~= value or value == math.huge or value == -math.huge then error('non-finite number in fixture') end
      if value == math.floor(value) and math.abs(value) < 1e15 then return string.format('%d', value) end
      return string.format('%.17g', value)
    end
    if kind == 'string' then return '"' .. value:gsub('[%c"\\\\]', function(c) return string.format('\\\\u%04x', c:byte()) end) .. '"' end
    local keys, isArray = {}, #value > 0
    for key in pairs(value) do keys[#keys + 1] = key end
    -- Depth 0 and 1 are spread over lines (one case per line group); everything deeper is inline.
    local flat = indent >= 2
    local pad, inner = flat and '' or string.rep('  ', indent), flat and '' or string.rep('  ', indent + 1)
    local newline, colon = flat and '' or '\\n', flat and ':' or ': '
    local parts = {}
    if isArray then
      for index = 1, #value do parts[#parts + 1] = inner .. encode(value[index], indent + 1) end
      return '[' .. newline .. table.concat(parts, ',' .. newline) .. newline .. pad .. ']'
    end
    table.sort(keys)
    if #keys == 0 then return '{}' end
    for _, key in ipairs(keys) do parts[#parts + 1] = inner .. '"' .. key .. '"' .. colon .. encode(value[key], indent + 1) end
    return '{' .. newline .. table.concat(parts, ',' .. newline) .. newline .. pad .. '}'
  end
`;

function recordLua() {
  return run(`${fixture}
  ${encoder}
  local NAN, INF = 0/0, math.huge
  local styles = {'full', 'side', 'wide'}
  local heights = {{'unset', nil}, {'0.05', 0.05}, {'-0.1', -0.1}, {'0.11', 0.11}, {'nan', NAN}, {'text', '0.1'}}
  local strengths = {{'unset', nil}, {'0', 0}, {'0.5', 0.5}, {'1.5', 1.5}, {'2', 2}, {'nan', NAN}, {'-1', -1}}
  local drops = {0, -0.15}
  local cases = {}
  for _, style in ipairs(styles) do
    for _, seated in ipairs({false, true}) do
      for _, height in ipairs(heights) do
        for _, strength in ipairs(strengths) do
          for _, drop in ipairs(drops) do
            convaiFacialPlayback = {gazeDrop = function() return drop end}
            local motor = fresh()
            local settings = nil
            if height[2] ~= nil or strength[2] ~= nil then settings = {eyeContactHeight = height[2], headFollowStrength = strength[2]} end
            local ok, err = actuator.applyLook(motor, style, player, settings, seated)
            assert(ok, err)
            local event = motor.look
            assert(event, 'no look for ' .. style)
            local parts = {}
            for index, part in ipairs(event.parts) do
              parts[index] = {name = part.partName, weight = part.weight, suppress = part.suppress, mode = part.mode}
            end
            local limits = event.request.limits
            cases[#cases + 1] = {
              name = string.format('%s %s height=%s strength=%s drop=%s', style, seated and 'seated' or 'standing', height[1], strength[1], tostring(drop)),
              input = {style = style, seated = seated, height = motor.lookHeight, strength = motor.lookStrength,
                settingHeight = height[1], settingStrength = strength[1], drop = drop},
              output = {slot = event.slot, body = event.bodyPart, styleValue = event.styleValue,
                offset = event.offset.z, hasWorldOffset = event.targetPositionProvider.worldOffset ~= nil,
                worldOffsetZ = event.targetPositionProvider.worldOffset and event.targetPositionProvider.worldOffset.z or 0,
                soft = limits.softLimitDegrees, hard = limits.hardLimitDegrees, back = limits.backLimitDegrees,
                distance = limits.hardLimitDistance, parts = parts},
            }
          end
        end
      end
    end
  end
  return encode({system = 'gaze', source = 'mod/companion-actuator.lua', cases = cases}, 0) .. '\\n'
`);
}

test('the gaze fixture equals what the Lua look() builds', () => {
  const recorded = recordLua();
  const target = new URL('../native/core/tests/fixtures/gaze-requests.json', import.meta.url);
  if (process.env.CONVAI_WRITE_FIXTURES === '1') writeFileSync(target, recorded);
  assert.equal(readFileSync(target, 'utf8').replace(/\r\n/g, '\n'), recorded,
    'Lua gaze changed: re-record with CONVAI_WRITE_FIXTURES=1 and rebuild the native tests');
  const parsed = JSON.parse(recorded);
  assert.ok(parsed.cases.length >= 400, 'the grid shrank');
  // Spot checks on the recorded Lua behaviour, so the fixture cannot silently record nonsense.
  const find = (name) => parsed.cases.find((item) => item.name === name);
  const standing = find('side standing height=unset strength=unset drop=0');
  assert.equal(standing.output.parts.length, 2);
  assert.equal(standing.output.soft, 45); assert.equal(standing.output.hard, 100);
  assert.equal(standing.output.hasWorldOffset, false);
  const seatedFull = find('full seated height=0.05 strength=1.5 drop=-0.15');
  assert.equal(seatedFull.output.parts.length, 1);
  assert.equal(seatedFull.output.soft, 70); assert.equal(seatedFull.output.hard, 120);
  assert.ok(Math.abs(seatedFull.output.worldOffsetZ - (-0.1)) < 1e-12);
  assert.ok(Math.abs(seatedFull.output.parts[0].weight - 0.27) < 1e-12);
});

// The shim: a fake plugin whose Fill writes the same fields the native does, with no method calls
// on the event, and a convaiNative stand-in with the real use/fail contract.
const shim = `${fixture}
  local logLines = {}
  local switchOn, failures = true, {}
  convaiNative = {
    use = function(name) assert(name == 'gaze'); return switchOn end,
    fail = function(name, detail) assert(name == 'gaze'); failures[#failures + 1] = tostring(detail); switchOn = false end,
  }
  nativeCalls, fillCode, fillError, problem = 0, 0, nil, 'why'
  ConvaiNativeGaze = {
    Fill = function(event, p, style, height, strength, seated)
      nativeCalls = nativeCalls + 1
      if fillError then error(fillError) end
      if fillCode == 0 then
        rawset(event, 'builtNative', {style = style, height = height, strength = strength, seated = seated, player = p})
      end
      return fillCode
    end,
    Problem = function() return problem end,
  }
  local luaBuilds = 0
  local plain = LookAtAddEvent.new
  LookAtAddEvent = {new = function() local e = plain(); local original = e.SetEntityTarget
    e.SetEntityTarget = function(...) luaBuilds = luaBuilds + 1; return original(...) end
    return e end}
  local function make() return actuator.new(npc) end
  local function owned() local count = 0; for _ in pairs(npc.looks) do count = count + 1 end; return count end
`;

test('with the plugin on, the event comes from one native call and Lua keeps ownership', () => run(`${shim}
  local motor = make()
  local ok, err = actuator.applyLook(motor, 'full', player, {eyeContactHeight = 0.05, headFollowStrength = 0.5}, false)
  assert(ok, err)
  assert(nativeCalls == 1 and luaBuilds == 0, 'the Lua builder ran')
  local first = motor.look
  assert(first and first.builtNative and npc.looks[first] and owned() == 1)
  assert(first.builtNative.style == 'full' and first.builtNative.height == 0.05 and first.builtNative.strength == 0.5)
  assert(first.builtNative.seated == false and first.builtNative.player == player)
  for _ = 1, 30 do assert(actuator.applyLook(motor, 'full', player, {eyeContactHeight = 0.05, headFollowStrength = 0.5}, false)) end
  assert(nativeCalls == 1 and motor.look == first, 'steady state must make no native call')
  assert(actuator.applyLook(motor, 'side', player, {eyeContactHeight = 0.05, headFollowStrength = 0.5}, false))
  assert(nativeCalls == 2 and motor.look ~= first and not npc.looks[first] and owned() == 1, 'replacement keeps one owner')
  assert(actuator.applyLook(motor, 'none', player))
  assert(not motor.look and owned() == 0 and #failures == 0)
`));

test('a seated request passes the seated flag and the mood drop reaches the native height', () => run(`${shim}
  convaiFacialPlayback = {gazeDrop = function() return -0.15 end}
  local motor = make()
  assert(actuator.applyLook(motor, 'full', player, {eyeContactHeight = 0.1, headFollowStrength = 1}, true))
  local call = motor.look.builtNative
  assert(call.seated == true and math.abs(call.height - (-0.05)) < 1e-12 and call.strength == 1)
`));

test('with the kill switch off or no plugin, the Lua builder runs unchanged', () => run(`${shim}
  switchOn = false
  local motor = make()
  assert(actuator.applyLook(motor, 'full', player, nil, false))
  assert(nativeCalls == 0 and luaBuilds == 1 and motor.look.slot == 'pla_default_tgt' and #motor.look.parts == 2)
  convaiNative = nil
  local other = make()
  assert(actuator.applyLook(other, 'side', player, nil, false))
  assert(nativeCalls == 0 and luaBuilds == 2 and #failures == 0)
  convaiNative = {use = function() error('use must be guarded by the type check') end}
  convaiNative.use = nil
  local third = make()
  assert(actuator.applyLook(third, 'side', player, nil, true))
  assert(luaBuilds == 3 and #third.look.parts == 1)
`));

test('a declined input is built by Lua and the system stays on', () => run(`${shim}
  fillCode = 1
  local motor = make()
  assert(actuator.applyLook(motor, 'full', player, nil, false))
  assert(nativeCalls == 1 and luaBuilds == 1 and not motor.look.builtNative and #failures == 0 and switchOn)
`));

test('an unavailable plugin or a native error switches gaze to Lua and the request still builds', () => run(`${shim}
  fillCode = 2; problem = 'class LookAtAddEvent not found'
  local motor = make()
  assert(actuator.applyLook(motor, 'full', player, nil, false))
  assert(luaBuilds == 1 and #failures == 1 and failures[1] == 'class LookAtAddEvent not found' and not motor.look.builtNative)
  local again = make()
  assert(actuator.applyLook(again, 'full', player, nil, false))
  assert(nativeCalls == 1, 'native was called again after fail()')
`));

test('a native call that raises is reported once and the Lua path takes over', () => run(`${shim}
  fillError = 'attempt to call a nil value'
  local motor = make()
  assert(actuator.applyLook(motor, 'side', player, nil, false))
  assert(#failures == 1 and failures[1]:find('nil value') and luaBuilds == 1 and motor.look)
`));

test('a missing target provider fails the same way on both paths', () => run(`${shim}
  fillCode = 1
  local motor = make()
  local original = LookAtAddEvent.new
  LookAtAddEvent = {new = function() local e = original(); local set = e.SetEntityTarget
    e.SetEntityTarget = function(self, ...) set(self, ...); self.targetPositionProvider = nil end
    return e end}
  local ok, err = actuator.applyLook(motor, 'full', player, {eyeContactHeight = 0.05}, false)
  assert(ok == false and tostring(err):find('target provider unavailable'), tostring(err))
  assert(not motor.look and owned() == 0)
`));

test('a removal that fails keeps the native-built owner for the retry', () => run(`${shim}
  local motor = make()
  assert(actuator.applyLook(motor, 'full', player, nil, false))
  local first = motor.look
  local original = LookAtRemoveEvent.QueueRemoveLookatEvent
  local blocked, attempts = true, 0
  LookAtRemoveEvent.QueueRemoveLookatEvent = function(actor, event)
    attempts = attempts + 1; assert(event == first)
    if blocked then return false end
    return original(actor, event)
  end
  local ok = actuator.applyLook(motor, 'side', player, nil, false)
  assert(ok == false and motor.look == first and nativeCalls == 2, 'the replacement is built before the old one is retired')
  blocked = false
  motor.clock = motor.clock + 3.1
  assert(actuator.applyLook(motor, 'side', player, nil, false))
  assert(attempts == 2 and motor.look ~= first and not npc.looks[first] and owned() == 1)
`));
