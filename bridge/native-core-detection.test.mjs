import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

// mod/native-core.lua decides, once at load and again at onInit and the first onUpdate, whether the optional plugin may be used at all,
// and then answers convaiNative.use(system) for every system. bridge/native-core.test.mjs covers the routing of the files and the happy
// path. This file covers the DETECTION: a plugin of another API, a plugin whose function table is incomplete or raises, a switch
// check that fails, and the cost of asking when there is no plugin. The rule behind every case is the same: the Lua path must produce
// the same files it always did, nothing may raise into the game, and a failed plugin must stop being called (FPS comes first).

const shim = readFileSync(new URL('../mod/native-core.lua', import.meta.url), 'utf8');

// A fake disk for the real io/os and a fake plugin whose worker sees the same disk (the same fakes as native-core.test.mjs, with
// the plugin's functions removable one at a time and every call counted).
const setup = String.raw`
local t = 0
disk, real, calls, appended, watches = {}, {open = 0, rename = 0, remove = 0}, {}, {}, {}
enabled, broken = true, false
local function count(name) calls[name] = (calls[name] or 0) + 1 end
local function memoryFile(path, mode)
  local first = mode:sub(1, 1)
  if first == 'r' then
    if disk[path] == nil then return nil, path .. ': missing' end
    local content, pos = disk[path], 1
    return {read = function(_, format)
      if type(format) == 'number' then local piece = content:sub(pos, pos + format - 1); pos = pos + #piece; return piece end
      local rest = content:sub(pos); pos = #content + 1; return rest end, close = function() return true end}
  end
  local parts = {}
  return {write = function(self, ...) for _, v in ipairs({...}) do parts[#parts + 1] = tostring(v) end; return self end,
    close = function()
      if first == 'a' then disk[path] = (disk[path] or '') .. table.concat(parts) else disk[path] = table.concat(parts) end
      return true end}
end
realIo = {open = function(path, mode) real.open = real.open + 1; return memoryFile(path, mode or 'r') end, marker = 'real io'}
realOs = {rename = function(a, b)
    real.rename = real.rename + 1
    if disk[a] == nil or disk[b] ~= nil then return nil, 'rename failed' end
    disk[b], disk[a] = disk[a], nil; return true end,
  remove = function(path) real.remove = real.remove + 1; if disk[path] == nil then return nil, 'missing' end; disk[path] = nil; return true end,
  time = function() return 1000 end}
-- The game's own io and os are the fake disk, so a plugin that is refused leaves working tables behind.
io, os = realIo, realOs
local revision, channels = 0, {}
local function publish(name)
  local content = disk['runtime/' .. name]
  local row = channels[name]
  if row and row.content == content then return end
  revision = revision + 1; channels[name] = {content = content, revision = revision}
end
function external(name, content) disk['runtime/' .. name] = content; publish(name) end
local function guard() if broken then error('native exploded') end end
fakeCore = {
  CheckVersion = function(api) count('CheckVersion'); return api == 1 end,
  PluginVersion = function() count('PluginVersion'); return '0.1.0' end,
  SystemEnabled = function(name) count('SystemEnabled'); return enabled end,
  Status = function() count('Status'); return '{"plugin":"0.1.0"}' end,
  GameProbe = function() count('GameProbe'); return '{"player":true}' end,
}
fakeIo = {
  Write = function(name, text) guard(); count('Write'); disk['runtime/' .. name] = text; publish(name); return true end,
  Append = function(name, text) guard(); count('Append'); appended[name] = (appended[name] or '') .. text; return true end,
  Remove = function(name) guard(); count('Remove'); disk['runtime/' .. name] = nil; publish(name); return true end,
  Rename = function(from, to) guard(); count('Rename')
    disk['runtime/' .. to], disk['runtime/' .. from] = disk['runtime/' .. from], nil; publish(to); publish(from); return true end,
  Watch = function(name, period, json) guard(); count('Watch'); watches[name] = {period, json}; publish(name); return true end,
  Read = function(name) guard(); count('Read'); publish(name); return channels[name].content or '' end,
  Revision = function(name) guard(); count('Revision'); publish(name)
    local row = channels[name]; return row.content and row.revision or -row.revision end,
  Flush = function() guard(); count('Flush'); return true end,
}
printed = {}
function advance(seconds) t = t + seconds end
lateCore, lateIo, resolved = nil, nil, 0
-- withPlugin: true = both classes bound; false = neither; 'late' = bound later through lateCore/lateIo (resolve is counted).
function boot(withPlugin)
  local M = (function() ${shim} end)()
  local resolve = withPlugin == 'late' and function() resolved = resolved + 1; return lateCore, lateIo end or nil
  if withPlugin == 'late' then withPlugin = false end
  return M, M.install({core = withPlugin and fakeCore or nil, io = withPlugin and fakeIo or nil, resolve = resolve, realIo = realIo,
    realOs = realOs, clock = function() return t end, print = function(line) printed[#printed + 1] = line end,
    date = function() return 'DATE' end})
end
function n(name) return calls[name] or 0 end
function lastPrint() return printed[#printed] end
function logText() return (disk['runtime/probe.log'] or '') .. (appended['probe.log'] or '') end
function logCount(text)
  local found = 0
  for line in logText():gmatch('[^\n]+') do if line:find(text, 1, true) then found = found + 1 end end
  return found
end
local IO_FUNCTIONS = {'Write', 'Append', 'Remove', 'Rename', 'Watch', 'Read', 'Revision', 'Flush'}
function ioCalls() local sum = 0; for _, name in ipairs(IO_FUNCTIONS) do sum = sum + n(name) end; return sum end
function allCalls() local sum = 0; for _, value in pairs(calls) do sum = sum + value end; return sum end

-- Every kind of routed operation of the mod, with the files it must leave behind whichever path served it.
function cycle(tag)
  local f = io.open('runtime/world-session.json', 'wb'); f:write('{"a":' .. tag .. '}'); assert(f:close(), 'in-place write')
  assert(os.rename('runtime/world-session.json', 'runtime/party-connections.json'), 'rename of a written file')
  f = io.open('runtime/reaction-lease.json.tmp', 'wb'); f:write('{"lease":' .. tag .. '}'); f:close()
  os.remove('runtime/reaction-lease.json')
  assert(os.rename('runtime/reaction-lease.json.tmp', 'runtime/reaction-lease.json') == true, 'temp file renamed into place')
  external('reply.json', '{"requestId":"r' .. tag .. '"}')
  f = io.open('runtime/reply.json', 'rb'); assert(f, 'a file the bridge wrote must open'); local got = f:read('*a'); f:close()
  assert(got == '{"requestId":"r' .. tag .. '"}', 'read ' .. tostring(got))
  f = io.open('runtime/probe.log', 'a'); f:write('line ' .. tag .. '\n'); f:close()
  assert(disk['runtime/party-connections.json'] == '{"a":' .. tag .. '}', 'renamed file')
  assert(disk['runtime/world-session.json'] == nil, 'the renamed file is gone from its old name')
  assert(disk['runtime/reaction-lease.json'] == '{"lease":' .. tag .. '}', 'lease')
  assert(logText():find('line ' .. tag .. '\n', 1, true), 'the log line must land once somewhere')
  assert(logCount('line ' .. tag) == 1, 'and only once')
  disk['runtime/party-connections.json'] = nil
end
`;

function run(body) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const status = lauxlib.luaL_dostring(vm, to_luastring(setup + '\n' + body));
  let out = '';
  if (status === lua.LUA_OK) {
    lua.lua_getglobal(vm, to_luastring('OUT'));
    out = lua.lua_isstring(vm, -1) ? to_jsstring(lua.lua_tostring(vm, -1)) : '';
  }
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(status, lua.LUA_OK, error);
  return out;
}

// ---- a plugin that is there but not usable ------------------------------------------------------------------------------------------------
test('a plugin of another API version leaves every system on Lua, touches nothing, and is asked once', () => run(`
fakeCore.CheckVersion = function(api) count('CheckVersion'); return false end
local before = io
local M, api = boot(true)
assert(io == before, 'the game io table is untouched')
assert(api.present == false and api.pending == nil, 'a plugin that answered "no" is final: nothing to wait for')
assert(lastPrint():find('Native core: io=lua %(plugin API differs or its file worker is not running%)'), lastPrint())
assert(n('Write') == 0 and n('Flush') == 0 and n('PluginVersion') == 0, 'no handshake with a plugin that refused the version')
assert(api.use('actuator') == false and api.use('io') == false)
assert(logCount('Native core: actuator=lua (plugin API differs') == 1, 'the first question about a system logs its state, once')
local opens = real.open
-- the shim never talks to it again, however often the game asks
for index = 1, 5000 do
  assert(api.use('actuator') == false and api.use('io') == false and api.verifying('actuator') == false)
  advance(0.01)
end
assert(n('CheckVersion') == 1 and n('SystemEnabled') == 0 and n('Revision') == 0, 'the plugin is never asked again')
assert(real.open == opens, 'asking costs no io.open')
assert(api.redetect == nil and api.revision == nil and api.flush == nil, 'the late-binding and routing parts of the API do not exist')
-- the status line says why, as valid JSON
OUT = api.status()
`));

test('the status of a missing plugin is JSON that names the reason', () => {
  const out = run(`
fakeCore.CheckVersion = function() return false end
local M, api = boot(true)
OUT = api.status()
`);
  assert.deepEqual(JSON.parse(out), {present: false, reason: 'plugin API differs or its file worker is not running'});
});

// Add-ons read this through handle:native().status() (mod/addons.lua). The reason of a plugin that failed the late checks carries the
// error text of the failed call, and error texts can hold a backslash (a path) or a line break; status() only swaps the quotes.
test('the status after a failed late check is valid JSON even when the error text holds a backslash or a line break',
  {todo: 'api.status() builds its JSON by hand and only replaces double quotes: a backslash or a newline in the reason makes it invalid JSON'}, () => {
  const out = run(`
fakeCore.CheckVersion = function()
  error('C:' .. string.char(92) .. 'Users' .. string.char(92) .. 'name "quoted" ' .. string.char(10) .. ' second line', 0)
end
local M, api = boot(true)
api.redetect('onInit'); api.redetect('onUpdate')
OUT = api.status()
`);
  const parsed = JSON.parse(out);
  assert.equal(parsed.present, false);
  assert.match(parsed.reason, /CheckVersion failed/);
});

test('CheckVersion that raises is retried at onInit and on the first onUpdate only, logs the last try once, and then stops asking', () => run(`
local attempts = 0
fakeCore.CheckVersion = function() attempts = attempts + 1; error('class not ready') end
local M, api = boot(true)
assert(api.pending == true and not api.present, 'a raising call is "not ready yet", not a verdict')
assert(attempts == 1)
local lines = #printed
assert(api.redetect('onInit') == false and api.pending == true and attempts == 2)
assert(#printed == lines, 'the first retry is silent: onUpdate is the last chance')
assert(api.redetect('onUpdate') == false and api.pending == false and attempts == 3)
assert(#printed == lines + 1 and lastPrint():find('Native core: io=lua %(CheckVersion failed: .*class not ready, checked at onUpdate%)'), lastPrint())
for _ = 1, 500 do api.redetect('onUpdate'); api.use('io') end
assert(attempts == 3 and #printed == lines + 1, 'nothing more is asked or logged')
assert(logCount('Native core: io=lua') == 2, 'one line at load and one at the end of the retries, not one per try')
`));

test('a CheckVersion that works at onInit after raising at load switches io to native with one changed line', () => run(`
local armed = false
local original = fakeCore.CheckVersion
fakeCore.CheckVersion = function(api) if not armed then error('not ready') end; return original(api) end
local M, api = boot(true)
local f = io.open('runtime/speech-state.json', 'wb'); f:write('{"early":1}'); f:close()
assert(disk['runtime/speech-state.json'] == '{"early":1}' and n('Write') == 0, 'the Lua path wrote it, synchronously')
armed = true
assert(api.redetect('onInit') == true and api.present == true and api.pending == false and api.use('io') == true)
assert(lastPrint():find('io=native %(plugin 0.1.0, api 1%) %[changed%]'), lastPrint())
f = io.open('runtime/speech-state.json', 'wb'); f:write('{"late":1}'); f:close()
assert(disk['runtime/speech-state.json'] == '{"late":1}' and n('Write') >= 1)
assert(logCount('Native core: io=') == 2, 'the Lua line and the native line, nothing else')
`));

test('PluginVersion that raises is not fatal: the plugin is used and its version reads as ?', () => run(`
fakeCore.PluginVersion = function() error('no version') end
local M, api = boot(true)
assert(api.present and api.use('io'))
assert(api.plugin == '?' and lastPrint():find('io=native %(plugin %?, api 1%)'), lastPrint())
`));


// ---- a plugin whose function table is incomplete ------------------------------------------------------------------------------------------
// A build of the plugin that lacks one function (an older DLL, a registration that dropped it) must never raise into the game and
// must never lose or double a file. Each case removes ONE function, runs every kind of routed operation twice, and checks the files.
const CORE_NAMES = ['CheckVersion', 'PluginVersion', 'SystemEnabled', 'Status', 'GameProbe'];
const IO_NAMES = ['Write', 'Append', 'Remove', 'Rename', 'Watch', 'Read', 'Revision', 'Flush'];

test('a plugin without CheckVersion is "not ready", retried, and finally left on Lua with the files intact', () => run(`
fakeCore.CheckVersion = nil
local M, api = boot(true)
assert(api.pending == true and not api.present)
-- The first look at the io switch tells the (unproven) plugin to flush: one Flush, nothing else, and it is the only call ever made.
local base = ioCalls()
assert(base <= 1 and n('Write') == 0 and n('Append') == 0 and n('Remove') == 0, 'only the flush of a switch that starts off: ' .. base)
cycle(1)
assert(api.redetect('onInit') == false and api.redetect('onUpdate') == false and api.pending == false)
assert(lastPrint():find('CheckVersion failed'), lastPrint())
cycle(2)
assert(ioCalls() == base and n('SystemEnabled') == 0 and n('Write') == 0, 'the plugin is never used')
`));

test('a plugin without SystemEnabled is present but every system, io included, stays on Lua', () => run(`
fakeCore.SystemEnabled = nil
local M, api = boot(true)
assert(api.present == true and api.use('io') == false and api.use('actuator') == false)
assert(lastPrint():find('switch check failed'), lastPrint())
local base = ioCalls() -- the handshake and the flush of a switch that starts off
cycle(1); cycle(2)
assert(ioCalls() == base, 'the routing is not used while the switch cannot be read')
for _ = 1, 30 do advance(0.6); api.use('io'); api.use('actuator') end
assert(logCount('Native core: io=lua') == 1 and logCount('Native core: actuator=lua') == 1, 'the same state is logged once, however often it is checked')
`));

test('a plugin without Status, GameProbe or PluginVersion is still used; the missing answers read as nil and a question mark', () => run(`
fakeCore.Status, fakeCore.GameProbe, fakeCore.PluginVersion = nil, nil, nil
local M, api = boot(true)
assert(api.present and api.use('io') and api.plugin == '?')
assert(api.status() == nil and api.probe() == nil, 'a missing function answers nil, never raises')
cycle(1)
assert(ioCalls() > 0, 'io runs through the plugin')
`));

for (const missing of ['Write', 'Flush', 'Remove']) {
  test('a plugin without Io.' + missing + ' fails the handshake that proves it: Lua keeps every file and the plugin is never used', () => run(`
fakeIo.${missing} = nil
local before = io
local M, api = boot(true)
assert(io == before and api.present == false and api.use('io') == false, 'the game io table is untouched')
assert(lastPrint():find('Native core: io=lua'), lastPrint())
local handshake = ioCalls()
assert(handshake <= 3, 'only the handshake itself touched the plugin')
cycle(1); cycle(2); cycle(3)
assert(ioCalls() == handshake, 'nothing after the handshake')
`));
}

for (const missing of ['Append', 'Rename', 'Watch', 'Read', 'Revision']) {
  test('a plugin without Io.' + missing + ' passes the handshake, fails once on first use, falls back for that very operation and stops being called', () => run(`
fakeIo.${missing} = nil
local M, api = boot(true)
assert(api.present, 'the handshake does not need ${missing}')
-- The "io=native" line of the boot is itself a routed log append, so a missing Append already fails there (and the line still lands).
if '${missing}' ~= 'Append' then assert(api.use('io')) end
cycle(1)
assert(api.use('io') == false and logCount('native call failed') == 1, 'one failure, logged once: ' .. logText())
assert(logCount('Native core: io=native') <= 1)
local after = ioCalls()
cycle(2); cycle(3)
assert(ioCalls() == after, 'a failed plugin is not called again: ' .. ioCalls() .. ' vs ' .. after)
assert(logCount('native call failed') == 1)
for _ = 1, 20 do advance(5); assert(api.use('io') == false, 'a failed system stays on Lua for the session') end
`));
}

test('the plugin breaking between a temp file and its rename still lands the file exactly once', () => run(`
local M, api = boot(true)
cycle(1)
local f = io.open('runtime/reaction-lease.json.tmp', 'wb'); f:write('{"lease":"in flight"}'); f:close()
assert(api.held() == 1 and disk['runtime/reaction-lease.json.tmp'] == nil, 'the temp bytes live only in memory')
broken = true
os.remove('runtime/reaction-lease.json')
assert(os.rename('runtime/reaction-lease.json.tmp', 'runtime/reaction-lease.json') == true)
assert(disk['runtime/reaction-lease.json'] == '{"lease":"in flight"}', 'the in-flight bytes were written by the real io')
assert(api.held() == 0 and disk['runtime/reaction-lease.json.tmp'] == nil)
assert(api.use('io') == false and logCount('native call failed') == 1)
local calls = ioCalls()
local reader = io.open('runtime/reaction-lease.json', 'rb'); assert(reader:read('*a') == '{"lease":"in flight"}')
cycle(2)
assert(ioCalls() == calls, 'after the failure only the real io is used')
`));

test('the plugin breaking while a read is cached: reads come from the real file, not the stale copy', () => run(`
local M, api = boot(true)
external('reply.json', '{"requestId":"old"}')
local f = io.open('runtime/reply.json', 'rb'); assert(f:read('*a') == '{"requestId":"old"}'); f:close()
broken = true
-- the bridge writes a new reply; the worker is dead, the cached Lua string must not be served again
disk['runtime/reply.json'] = '{"requestId":"new"}'
f = io.open('runtime/probe.log', 'a'); f:write('x'); f:close() -- the failing call that trips the system
assert(api.use('io') == false)
f = io.open('runtime/reply.json', 'rb'); assert(f:read('*a') == '{"requestId":"new"}', 'the Lua path reads the real file')
assert(api.revision('reply.json') == nil, 'no revision while io is on Lua')
`));


// ---- the switch: runtime/native-off.txt, SystemEnabled and the cost of asking ------------------------------------------------------------
// The plugin parses native-off.txt (native/core/src/core/Switches.cpp, pinned by io_tests.cpp and by bridge/native-switch-contract.test.mjs);
// the fake core below applies the same rules to the fake disk, so these tests show what the SHIM does with each answer: re-asks within
// 0.5 s, per system, logs each change once, and flushes the plugin's pending writes before Lua takes the files over.
const withSwitchFile = body => String.raw`
local function count(name) calls[name] = (calls[name] or 0) + 1 end
local function parse(content)
  local all, off = false, {}
  for line in (content .. string.char(10)):gmatch('([^' .. string.char(10) .. ']*)' .. string.char(10)) do
    line = line:gsub('#.*', ''):match('^%s*(.-)%s*$'):lower()
    if line ~= '' and #line <= 64 then if line == 'all' then all = true else off[line] = true end end
  end
  return all, off
end
fakeCore.SystemEnabled = function(name)
  count('SystemEnabled')
  local all, off = parse(disk['runtime/native-off.txt'] or '')
  return not all and not off[name]
end
local api
local function setSwitchFile(content) disk['runtime/native-off.txt'] = content; advance(0.6) end
local function state(system) return api.use(system) and 'native' or 'lua' end
local NL = string.char(10)
${body}`;
const SYSTEMS = "{'io', 'actuator', 'vehicles', 'chauffeur', 'passage', 'faces', 'gaze', 'clearance'}";

test('native-off.txt: a missing file and an empty file both leave every system on native (so an empty placeholder would switch the unproven systems on)', () => run(withSwitchFile(`
local M; M, api = boot(true)
for _, system in ipairs(${SYSTEMS}) do assert(state(system) == 'native', system .. ' with no file') end
setSwitchFile('')
for _, system in ipairs(${SYSTEMS}) do assert(state(system) == 'native', system .. ' with an empty file') end
setSwitchFile(NL .. '   ' .. NL .. '# faces' .. NL)
assert(state('faces') == 'native', 'blank lines and a commented name switch nothing off')
assert(logCount('=lua') == 0, 'no system ever left native: ' .. logText())
`)));

test('native-off.txt: a named line, a trailing comment, any case and an unknown name switch off only the system they name, each change logged once', () => run(withSwitchFile(`
local M; M, api = boot(true)
for _, system in ipairs({'faces', 'gaze', 'actuator', 'io'}) do assert(state(system) == 'native') end
setSwitchFile('# shipped list' .. NL .. 'FACES' .. NL .. 'gaze # why' .. NL .. 'vehicle' .. NL .. 'actuator.life' .. NL)
assert(state('faces') == 'lua' and state('gaze') == 'lua', 'case and a trailing comment do not matter')
assert(state('actuator') == 'native' and state('io') == 'native', 'an unknown name and a part name switch nothing else off')
assert(state('actuator.life') == 'lua', 'a part is its own switch')
for _ = 1, 40 do advance(0.6); state('faces'); state('gaze'); state('io') end
assert(logCount('faces=lua') == 1 and logCount('gaze=lua') == 1, 'a state that does not change is not logged again: ' .. logText())
assert(logCount('io=lua') == 0)
setSwitchFile('# shipped list' .. NL .. 'gaze' .. NL)
assert(state('faces') == 'native' and state('gaze') == 'lua', 'removing a line turns that system on again within one check')
assert(logCount('faces=native') == 2 and logCount('[changed]') >= 3, logText())
`)));

test('native-off.txt: "all" sends every system to Lua at once, flushes the plugin first, and emptying the file brings them back', () => run(withSwitchFile(`
local M; M, api = boot(true)
assert(state('io') == 'native' and state('faces') == 'native')
local flushes = n('Flush')
local f = io.open('runtime/speech-state.json', 'wb'); f:write('{"n":1}'); f:close()
assert(n('Write') >= 1)
setSwitchFile('ALL' .. NL)
assert(state('io') == 'lua' and state('faces') == 'lua' and state('anything') == 'lua')
assert(n('Flush') == flushes + 1, 'the plugin finishes its pending writes before the Lua path takes the files over')
local writes, opens = n('Write'), real.open
f = io.open('runtime/speech-state.json', 'wb'); f:write('{"n":2}'); f:close()
assert(n('Write') == writes and real.open == opens + 1 and disk['runtime/speech-state.json'] == '{"n":2}', 'Lua wrote it')
setSwitchFile('')
assert(state('io') == 'native' and state('faces') == 'native')
f = io.open('runtime/speech-state.json', 'wb'); f:write('{"n":3}'); f:close()
assert(n('Write') == writes + 1 and disk['runtime/speech-state.json'] == '{"n":3}')
`)));

test('a failed system stays on Lua even when its line is removed from native-off.txt or a switch check says on again', () => run(withSwitchFile(`
local M; M, api = boot(true)
assert(state('gaze') == 'native')
api.fail('gaze', 'Fill returned 2')
assert(state('gaze') == 'lua' and logCount('gaze=lua (native call failed: Fill returned 2)') == 1)
setSwitchFile('')
for _ = 1, 10 do advance(1); assert(state('gaze') == 'lua') end
setSwitchFile('gaze' .. NL); setSwitchFile('')
assert(state('gaze') == 'lua', 'the file cannot bring back a system that faulted in this session')
assert(state('faces') == 'native', 'the other systems are not affected')
api.fail('gaze', 'again')
assert(logCount('gaze=lua') == 1, 'a second report of the same failure is not logged again')
`)));

test('a SystemEnabled that raises or answers anything but true keeps the system on Lua, logs it once, and recovers when it answers true', () => run(`
local M, api = boot(true)
assert(api.use('gaze') == true)
for _, answer in ipairs({'raise', 'nil', 'yes', 1, false}) do
  fakeCore.SystemEnabled = function() calls.SystemEnabled = n('SystemEnabled') + 1; if answer == 'raise' then error('plugin lost its table') end; if answer == 'nil' then return nil end; return answer end
  advance(0.6)
  assert(api.use('gaze') == false, 'answer ' .. tostring(answer))
  for _ = 1, 20 do advance(0.6); assert(api.use('gaze') == false) end
  fakeCore.SystemEnabled = function() calls.SystemEnabled = n('SystemEnabled') + 1; return true end
  advance(0.6)
  assert(api.use('gaze') == true, 'back on after ' .. tostring(answer))
end
assert(logCount('gaze=lua') == 5, 'one line per outage, however many checks it lasted: ' .. logCount('gaze=lua'))
assert(logCount('gaze=lua (switch check failed') == 1 and logCount('gaze=lua (off (runtime/native-off.txt') == 4)
`));

test('asking for a switch costs one plugin call per system per half second, however often the game asks', () => run(`
local M, api = boot(true)
local before = n('SystemEnabled')
for index = 1, 20000 do
  api.use('actuator'); api.use('gaze'); api.use('io'); api.use('faces')
  if index % 100 == 0 then advance(0.01) end -- 200 steps: 2 s of game time at 10 000 asks a second
end
local asked = n('SystemEnabled') - before
-- 2 s / 0.5 s = about 4 rounds for each of 4 systems (io was already known from the boot)
assert(asked <= 4 * 5 and asked >= 4 * 3, 'the plugin was asked ' .. asked .. ' times in 2 s for 80 000 asks')
`));

test('without a plugin every call of the API is free: no native call, no io.open, no class lookup after the last try', () => run(`
local M, api = boot('late')
assert(api.pending == true)
assert(api.redetect('onInit') == false and api.pending == true)
assert(api.redetect('onUpdate') == false and api.pending == false)
local asked = resolved
for _, system in ipairs({'io', 'actuator', 'gaze', 'faces'}) do api.use(system) end -- the first look at each logs its state once
local opens = real.open
for _ = 1, 10000 do
  api.use('actuator'); api.use('gaze'); api.verifying('actuator'); api.redetect('onUpdate'); api.redetect('onInit')
  assert(api.revision == nil or api.revision('reply.json') == nil)
  advance(0.01)
end
assert(resolved == asked, 'the classes are not looked up again after the first onUpdate')
assert(real.open == opens, 'no io.open: not even a log line')
assert(allCalls() == 0, 'the plugin was never called')
assert(api.status():find('"present":false') and api.probe() == nil and api.present == false)
`));

test('installing twice returns the same API and wraps nothing again', () => run(`
local M, api = boot(true)
local wrappedIo, wrappedOs = io, os
local lines = #printed
local again = M.install({core = fakeCore, io = fakeIo, realIo = realIo, realOs = realOs, clock = function() return 0 end,
  print = function(line) printed[#printed + 1] = line end, date = function() return 'DATE' end})
assert(again == api and convaiNative == api)
assert(io == wrappedIo and os == wrappedOs, 'the proxies are not wrapped in a second layer')
assert(#printed == lines and n('CheckVersion') == 1, 'no second handshake, no second log line')
`));

// convaiNative.on / off (developer helpers that edit runtime/native-off.txt through the real io) compare whole lines, the plugin reads
// names the way Switches::ParseFile does (comment cut off, trimmed, lower-cased).
test('convaiNative.on removes a system from native-off.txt even when its line has a trailing comment or other capitals',
  {todo: 'BUG: mod/native-core.lua editSwitches compares the raw trimmed line with the system name, so "gaze # why" or "Gaze" is never removed (and off() appends a duplicate), while the plugin treats both as "gaze"'}, () => run(`
local M, api = boot(true)
for _, line in ipairs({'gaze # why', 'Gaze', 'GAZE  '}) do
  disk['runtime/native-off.txt'] = 'faces' .. string.char(10) .. line .. string.char(10)
  assert(api.on('gaze') == true)
  local left = disk['runtime/native-off.txt']
  assert(not left:lower():find('gaze', 1, true), 'gaze is still listed after on(): ' .. left)
  assert(left:find('faces', 1, true), 'the other lines stay')
end
`));

test('convaiNative.off and on keep comments and other names, never list a system twice, and a missing file is created by off and left empty by on', () => run(`
local M, api = boot(true)
local NL = string.char(10)
assert(disk['runtime/native-off.txt'] == nil)
assert(api.on('gaze') == true and disk['runtime/native-off.txt'] == '', 'on() with no file leaves an empty file: every system on')
assert(api.off('gaze') == true and disk['runtime/native-off.txt'] == 'gaze' .. NL)
assert(api.off('gaze') == true and disk['runtime/native-off.txt'] == 'gaze' .. NL, 'a name already listed is not added twice')
disk['runtime/native-off.txt'] = '# shipped' .. NL .. 'faces' .. NL .. 'gaze' .. NL
assert(api.on('gaze') == true and disk['runtime/native-off.txt'] == '# shipped' .. NL .. 'faces' .. NL)
assert(api.off() == true and disk['runtime/native-off.txt']:find('all', 1, true), 'no name means all')
assert(api.on() == true and not disk['runtime/native-off.txt']:find('all', 1, true))
assert(disk['runtime/native-off.txt'] == '# shipped' .. NL .. 'faces' .. NL, 'the rest of the file is as it was')
`));
