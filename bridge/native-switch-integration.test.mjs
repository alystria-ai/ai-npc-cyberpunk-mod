import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {companionEngine} from './companion-fixture.mjs';

// The REAL mod/native-core.lua in front of the REAL native companion tick (mod/companion-tick-native.lua, system "actuator") inside the
// real companions.lua. The shim suites (companion-tick-native.test.mjs and the others) fake convaiNative with a table of two functions,
// and native-core.test.mjs fakes the shims, so the contract between them was never run: what use() answers while the plugin is absent,
// late, off by file, failed or lying; that a failure is logged and called once and not again; and that the file switch, the part switches
// and a missing plugin leave the companion behaving exactly as the Lua path does.

const core = readFileSync(new URL('../mod/native-core.lua', import.meta.url), 'utf8');
const tick = readFileSync(new URL('../mod/companion-tick-native.lua', import.meta.url), 'utf8');
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

const engine = companionEngine
  .replace("error('Unexpected module '..file)", () => `if file=='companion-tick-native.lua' then return (function() ${tick} end)() end
    error('Unexpected module '..file)`)
  .replace('  local companions=(function()', () => `  local baseDofile=dofile
  MODULES={}
  dofile=function(file) local module=baseDofile(file); MODULES[file]=module; return module end
  local companions=(function()`);

function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(engine + setup + code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  let out = '';
  if (status === lua.LUA_OK) {
    lua.lua_getglobal(state, to_luastring('OUT'));
    out = lua.lua_isstring(state, -1) ? to_jsstring(lua.lua_tostring(state, -1)) : '';
  }
  lua.lua_close(state); assert.equal(status, lua.LUA_OK, error);
  return out;
}

// A fake disk and plugin for native-core, and the actuator class, all behind the real convaiNative.
//   boot(mode): 'present' (both classes bound), 'absent' (no classes, never), 'late' (bound by bindPlugin()).
//   The fake core's SystemEnabled applies the plugin's switch-file rules to disk['runtime/native-off.txt'] (Switches::ParseFile).
const setup = String.raw`
local origOs = os
T = 0
disk, calls, appended = {}, {}, {}
local function count(name) calls[name] = (calls[name] or 0) + 1 end
function n(name) return calls[name] or 0 end
local function memoryFile(path, mode)
  if mode:sub(1, 1) == 'r' then
    if disk[path] == nil then return nil, path .. ': missing' end
    local content = disk[path]
    return {read = function() return content end, close = function() return true end}
  end
  local parts = {}
  return {write = function(self, ...) for _, v in ipairs({...}) do parts[#parts + 1] = tostring(v) end; return self end,
    close = function() disk[path] = (mode:sub(1, 1) == 'a' and (disk[path] or '') or '') .. table.concat(parts); return true end}
end
local realIo = {open = function(path, mode) return memoryFile(path, mode or 'r') end}
local realOs = setmetatable({rename = function() return nil end, remove = function() return nil end, clock = function() return T end},
  {__index = origOs})
local NL = string.char(10)
local function parseOff(content)
  local all, off = false, {}
  for line in (content .. NL):gmatch('([^' .. NL .. ']*)' .. NL) do
    line = line:gsub('#.*', ''):match('^%s*(.-)%s*$'):lower()
    if line ~= '' and #line <= 64 then if line == 'all' then all = true else off[line] = true end end
  end
  return all, off
end
broken, actuatorBroken = false, false -- broken: the file worker; actuatorBroken: only the actuator class
local function guard() if broken then error('native exploded') end end
local function actuatorGuard() if actuatorBroken then error('native exploded') end end
fakeCore = {
  CheckVersion = function(api) return api == 1 end,
  PluginVersion = function() return '0.1.0' end,
  SystemEnabled = function(name)
    count('SystemEnabled:' .. name)
    local all, off = parseOff(disk['runtime/native-off.txt'] or '')
    return not all and not off[name]
  end,
  Status = function() return '{}' end, GameProbe = function() return '{}' end,
}
local channels = {}
fakeIo = {
  Write = function(name, text) guard(); disk['runtime/' .. name] = text; return true end,
  Append = function(name, text) guard(); appended[name] = (appended[name] or '') .. text; return true end,
  Remove = function(name) guard(); disk['runtime/' .. name] = nil; return true end,
  Rename = function() guard(); return true end, Watch = function() guard(); return true end,
  Read = function(name) guard(); return disk['runtime/' .. name] or '' end,
  Revision = function(name) guard(); return disk['runtime/' .. name] and 1 or -1 end,
  Flush = function() guard(); return true end,
}
function logText() return (disk['runtime/probe.log'] or '') .. (appended['probe.log'] or '') end
function logCount(text)
  local found = 0
  for line in logText():gmatch('[^' .. NL .. ']+') do if line:find(text, 1, true) then found = found + 1 end end
  return found
end
printed = {}
local bound = false
function bindPlugin() bound = true end
function boot(mode)
  local M = (function() ${core} end)()
  api = M.install({core = mode == 'present' and fakeCore or nil, io = mode == 'present' and fakeIo or nil,
    resolve = mode ~= 'present' and function() if mode == 'late' and bound then return fakeCore, fakeIo end; return nil, nil end or nil,
    realIo = realIo, realOs = realOs, clock = function() return T end, print = function(line) printed[#printed + 1] = line end,
    date = function() return 'DATE' end})
  return api
end
os.clock = realOs.clock

-- The actuator class: the same reads and maths as the Lua path, in the wire format the plugin writes (the tick suite's fake).
local space = MODULES['companion-space.lua']
local ENUM = {NotExecuting = 0, Enqueued = 1, Executing = 2, Cancelled = 3, Interrupted = 4, Success = 5, Failure = 6}
capabilities = 127
local function num(value) return string.format('%.17g', value) end
local function sense(npc, command, hasPrevious, previousX, previousY, playerX, playerY, playerZ, stepSeconds)
  count('Sense'); actuatorGuard()
  local p, f = npc.pos, npc.forward
  local speed = hasPrevious and space.ground({x = previousX, y = previousY}, p) / stepSeconds or 0
  local direction = space.unit(f.x, f.y)
  local at, player = {x = p.x, y = p.y, z = p.z or 0, w = p.w or 1}, {x = playerX, y = playerY, z = playerZ}
  local gap = space.distance(at, player)
  local facing = space.angle(direction, space.bearing(at, player))
  local flags, state, id = 1 + ((npc.combat and true or false) and 2 or 0), -1, -1
  if command then flags = flags + 4 + 8; state = ENUM[command.state]; id = command.id or 0 end
  return table.concat({flags, num(at.x), num(at.y), num(at.z), num(at.w), num(f.x), num(f.y), state, id,
    num(speed), num(direction.x), num(direction.y), num(gap), num(facing)}, ' ')
end
function bindActuatorClass()
  ConvaiNativeActuator = {
    Capabilities = function() count('Capabilities'); if capabilities == 'raise' then error('no table') end; return capabilities end,
    Life = function(npc) count('Life'); actuatorGuard(); if npc.detached then return 0 end; return npc.dead and 1 or 2 end,
    CommandState = function(npc, command) count('CommandState'); actuatorGuard(); return ENUM[command.state] end,
    Sense = function(npc, command, ...) return sense(npc, command, ...) end,
    SenseIdle = function(npc, ...) return sense(npc, nil, ...) end,
  }
end
MODULES['companion-tick-native.lua'].configure(0, 0, 0) -- the parity proof has its own suite: answer natively from the first sense

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
      if type(value[key]) ~= 'function' then out[#out + 1] = tostring(key) .. '='; dump(value[key], out); out[#out + 1] = ',' end
    end
    out[#out + 1] = '}'
  else out[#out + 1] = tostring(value) end
end
function serialize(value) local out = {}; dump(value, out); return table.concat(out) end

-- A companion that walks away from V along +y, with a combat flag now and then. Returns the serialized rows of every tick.
function walker()
  local npc = spawn()
  npc.ai.GetCommandState = function(_, command) return 'AICommandState : ' .. command.state .. ' (' .. ENUM[command.state] .. ')' end
  local rows, y = {}, 0.05
  local step = 0
  local function walk(count, perTick)
    for _ = 1, count do
      step = step + 1
      y = y + (perTick or 0.28)
      npc.pos = Vector4.new(1.5, y, 0); npc.forward = Vector4.new(0, 1); npc.combat = step % 11 == 5
      player.pos = Vector4.new(0, y - 0.05, 0)
      T = T + 0.2
      companions.update(player, 0.2)
      rows[#rows + 1] = step .. ':' .. serialize(companions.list())
    end
  end
  return npc, walk, rows
end
`;

const prologue = `
local npc, walk, rows = walker()
`;

test('behaviour is identical with the plugin, with its file switch on, and with no plugin at all, and only the plugin runs the native reads', () => {
  const reference = run(`
boot('absent'); bindActuatorClass()
${prologue}
walk(60)
assert(n('Sense') + n('Life') + n('CommandState') == 0, 'no plugin, no native read')
OUT = table.concat(rows, '\\n')
`);
  const native = run(`
boot('present'); bindActuatorClass()
${prologue}
walk(60)
assert(n('Sense') + n('Life') > 100, 'the plugin answered the reads: ' .. n('Sense') .. '/' .. n('Life'))
assert(logCount('actuator=native') == 1 and logCount('actuator=lua (native call failed') == 0, logText())
OUT = table.concat(rows, '\\n')
`);
  const switchedOff = run(`
boot('present'); bindActuatorClass()
disk['runtime/native-off.txt'] = '# actuator is not proven yet' .. string.char(10) .. 'actuator' .. string.char(10)
${prologue}
walk(60)
assert(n('Sense') + n('Life') + n('CommandState') == 0, 'the line keeps the plugin out of the tick')
assert(logCount('actuator=lua (off (runtime/native-off.txt') == 1, logText())
OUT = table.concat(rows, '\\n')
`);
  assert.ok(reference.split('\n').length === 60);
  assert.equal(native, reference, 'the plugin changes nothing the companion does');
  assert.equal(switchedOff, reference);
});

test('adding and removing the actuator line in native-off.txt while the companion walks switches within half a second and changes nothing', () => {
  const reference = run(`
boot('absent'); bindActuatorClass()
${prologue}
walk(80)
OUT = table.concat(rows, '\\n')
`);
  const out = run(`
boot('present'); bindActuatorClass()
${prologue}
walk(20)
local before = n('Sense') + n('SenseIdle') + n('Life')
assert(before > 0)
disk['runtime/native-off.txt'] = 'actuator' .. string.char(10)
walk(3) -- 0.6 s of game time: the switch is re-read at most every 0.5 s
local settled = n('Sense') + n('SenseIdle') + n('Life') + n('CommandState')
walk(20)
assert(n('Sense') + n('SenseIdle') + n('Life') + n('CommandState') == settled, 'off by file: the plugin is not called any more')
disk['runtime/native-off.txt'] = ''
walk(3)
local resumed = n('Sense') + n('SenseIdle') + n('Life')
walk(20)
assert(n('Sense') + n('SenseIdle') + n('Life') > resumed + 20, 'emptied file: the plugin answers again')
walk(14)
assert(logCount('actuator=lua') == 1 and logCount('actuator=native') == 2, 'one line per change: ' .. logText())
OUT = table.concat(rows, '\\n')
`);
  assert.equal(out, reference);
});

test('one part of the actuator can be sent back to Lua by file while the others stay native, with the same behaviour', () => {
  const reference = run(`
boot('absent'); bindActuatorClass()
${prologue}
walk(60)
OUT = table.concat(rows, '\\n')
`);
  for (const [part, silent] of [['life', 'Life'], ['sense', 'Sense']]) {
    const out = run(`
boot('present'); bindActuatorClass()
disk['runtime/native-off.txt'] = 'actuator.${part}' .. string.char(10)
${prologue}
walk(60)
assert(n('${silent}') == 0, '${part} is off, so ${silent} is never called')
assert(n('${part === 'life' ? 'Sense' : 'Life'}') > 20, 'the other part stays native')
assert(logCount('actuator.${part}=lua') == 1 and logCount('actuator=lua (native call failed') == 0, logText())
OUT = table.concat(rows, '\\n')
`);
    assert.equal(out, reference, `${part} off changed behaviour`);
  }
  // The line "actuator" alone does not name a part, and a part line does not turn the whole system off.
  const whole = run(`
boot('present'); bindActuatorClass()
disk['runtime/native-off.txt'] = 'actuator.life' .. string.char(10)
${prologue}
walk(5)
assert(api.use('actuator') == true and api.use('actuator.life') == false and api.use('actuator.sense') == true)
OUT = 'ok'
`);
  assert.equal(whole, 'ok');
});

test('a native call that raises is reported once to the real core, the plugin is not called again, and no file edit brings it back', () => {
  const reference = run(`
boot('absent'); bindActuatorClass()
${prologue}
walk(60)
OUT = table.concat(rows, '\\n')
`);
  const out = run(`
boot('present'); bindActuatorClass()
${prologue}
walk(15)
actuatorBroken = true
walk(3)
local afterFault = n('Sense') + n('SenseIdle') + n('Life') + n('CommandState')
actuatorBroken = false
walk(42)
assert(n('Sense') + n('SenseIdle') + n('Life') + n('CommandState') <= afterFault + 1, 'a failed system is not called again')
assert(logCount('actuator=lua (native call failed') == 1, 'logged once: ' .. logText())
disk['runtime/native-off.txt'] = ''; T = T + 2
assert(api.use('actuator') == false, 'the switch file cannot restore a system that faulted')
OUT = table.concat(rows, '\\n')
`);
  assert.equal(out, reference, 'the walk is the same on the Lua path, including the tick that met the fault');
});

test('a plugin whose Capabilities call raises or answers a non-number is refused once and never asked again', () => {
  for (const answer of ["'raise'", "'many'"]) {
    const out = run(`
boot('present'); bindActuatorClass()
capabilities = ${answer}
${prologue}
walk(60)
assert(n('Capabilities') == 1, 'asked ' .. n('Capabilities') .. ' times')
assert(n('Sense') + n('SenseIdle') + n('Life') == 0, 'no read through a plugin that cannot say what it can read')
assert(logCount('actuator=lua (native call failed: Capabilities failed') == 1, logText())
OUT = 'ok'
`);
    assert.equal(out, 'ok');
  }
});

test('a plugin that is bound late is looked up at most once every five seconds until it appears, then used without a failure', () => {
  const out = run(`
boot('present')
local lookups = 0
setmetatable(_G, {__index = function(_, key) if key == 'ConvaiNativeActuator' then lookups = lookups + 1 end; return nil end})
${prologue}
walk(100) -- 20 s of game time with the switch on and the class not bound
assert(lookups >= 3 and lookups <= 5, 'the class global was looked up ' .. lookups .. ' times in 20 s')
assert(n('Sense') + n('Life') == 0 and logCount('actuator=lua (native call failed') == 0, 'waiting for the class is not a failure')
bindActuatorClass()
setmetatable(_G, nil)
walk(40)
assert(n('Sense') + n('Life') > 10, 'once bound (within the next retry), the plugin answers: ' .. n('Sense'))
assert(logCount('actuator=lua (native call failed') == 0)
local rowsAfter = #rows
OUT = tostring(rowsAfter)
`);
  assert.equal(out, '140');
});

test('with no plugin at all a long walk makes no plugin call, no class lookup and no log write after the first line', () => {
  const out = run(`
boot('absent')
local lookups = 0
setmetatable(_G, {__index = function(_, key) if type(key) == 'string' and key:find('^ConvaiNative') then lookups = lookups + 1 end; return nil end})
${prologue}
walk(5)
local lines = #(disk['runtime/probe.log'] or '')
lookups = 0
walk(400)
assert(lookups == 0, 'the class names are not looked up when the plugin is absent: ' .. lookups)
assert(#(disk['runtime/probe.log'] or '') == lines, 'nothing is logged while nothing changes')
assert(n('Capabilities') + n('Sense') + n('Life') == 0 and api.present == false)
OUT = 'ok'
`);
  assert.equal(out, 'ok');
});
