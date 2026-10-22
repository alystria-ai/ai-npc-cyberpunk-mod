import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import fengari from 'fengari';

const shim = readFileSync(new URL('../mod/native-core.lua', import.meta.url), 'utf8');
const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');

// A fake disk for the real io/os, and a fake plugin whose worker sees the same disk.
const setup = `
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
  PluginVersion = function() return '0.1.0' end,
  SystemEnabled = function(name) count('SystemEnabled'); return enabled end,
  Status = function() return '{"plugin":"0.1.0"}' end,
  GameProbe = function() return '{"player":true}' end,
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
lateCore, lateIo = nil, nil
function boot(withPlugin)
  local M = (function() ${shim} end)()
  local resolve = withPlugin == 'late' and function() return lateCore, lateIo end or nil
  if withPlugin == 'late' then withPlugin = false end
  return M, M.install({core = withPlugin and fakeCore or nil, io = withPlugin and fakeIo or nil, resolve = resolve, realIo = realIo,
    realOs = realOs, clock = function() return t end, print = function(line) printed[#printed + 1] = line end,
    date = function() return 'DATE' end})
end
function n(name) return calls[name] or 0 end
function lastPrint() return printed[#printed] end
`;

function run(body) {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const status = lauxlib.luaL_dostring(vm, to_luastring(setup + '\n' + body));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(status, lua.LUA_OK, error);
}

test('without the plugin every call passes straight to the real io and the log says io=lua', () => run(`
local M, api = boot(false)
assert(not api.present and not api.use('io') and api.pending)
assert(lastPrint():find('Native core: io=lua %(plugin not bound yet; checking again at onInit%)'), lastPrint())
local opens, renames, removes = real.open, real.rename, real.remove
local f = io.open('runtime/world-session.json', 'wb'); f:write('lua'); f:close()
f = io.open('runtime/world-session.json.tmp', 'wb'); f:write('tmp'); f:close()
assert(os.remove('runtime/world-session.json') and os.rename('runtime/world-session.json.tmp', 'runtime/world-session.json'))
assert(real.open == opens + 2 and real.rename == renames + 1 and real.remove == removes + 1)
assert(disk['runtime/world-session.json'] == 'tmp' and n('Write') == 0)
assert(api.redetect('onInit') == false and api.pending, 'onInit is not the last try')
assert(api.redetect('onUpdate') == false and not api.pending)
assert(lastPrint():find('Native core: io=lua %(plugin not loaded, checked at onUpdate%)'), lastPrint())
assert(disk['runtime/probe.log']:find('DATE Native core: io=lua'), 'probe.log line missing')
lateCore, lateIo = fakeCore, fakeIo
assert(api.redetect('onUpdate') == false, 'detection stops after the first onUpdate')
`));

test('classes bound after load: onInit switches io to native and logs it', () => run(`
local M, api = boot('late')
assert(api.pending and not api.use('io'))
local f = io.open('runtime/speech-state.json', 'wb'); f:write('{"before":1}'); f:close()
assert(disk['runtime/speech-state.json'] == '{"before":1}' and n('Write') == 0)
lateCore, lateIo = fakeCore, fakeIo
assert(api.redetect('onInit') == true and api.present and not api.pending and api.use('io'))
assert(lastPrint():find('Native core: io=native %(plugin 0.1.0, api 1%) %[changed%]'), lastPrint())
assert(api.redetect('onUpdate') == true, 'later calls are no-ops')
local opens = real.open
f = io.open('runtime/speech-state.json', 'wb'); f:write('{"after":1}'); f:close()
assert(disk['runtime/speech-state.json'] == '{"after":1}' and real.open == opens)
f = io.open('runtime/speech-state.json', 'rb'); assert(f:read('*a') == '{"after":1}')
`));

test('the first onUpdate is the last chance to bind', () => run(`
local M, api = boot('late')
assert(api.redetect('onInit') == false and api.pending)
lateCore, lateIo = fakeCore, fakeIo
assert(api.redetect('onUpdate') == true and api.use('io'))
`));

test('the handover neither loses nor repeats a write made on the Lua path', () => run(`
local M, api = boot('late')
-- A Lua-path temp file left on disk before the switch, renamed into place after it.
local f = io.open('runtime/reaction-lease.json.tmp', 'wb'); f:write('{"lease":7}'); f:close()
assert(disk['runtime/reaction-lease.json.tmp'] == '{"lease":7}')
external('reply.json', '{"requestId":"r1"}')
lateCore, lateIo = fakeCore, fakeIo
assert(api.redetect('onInit'))
local writes = n('Write')
assert(os.remove('runtime/reaction-lease.json') == true)
assert(os.rename('runtime/reaction-lease.json.tmp', 'runtime/reaction-lease.json') == true)
assert(disk['runtime/reaction-lease.json'] == '{"lease":7}' and disk['runtime/reaction-lease.json.tmp'] == nil)
assert(n('Write') == writes and n('Rename') == 1, 'the file moved once; nothing was written twice')
f = io.open('runtime/reply.json', 'rb'); assert(f:read('*a') == '{"requestId":"r1"}')
`));

test('with the plugin, routed writes, reads and the temp-file dance never touch the real io', () => run(`
local M, api = boot(true)
assert(api.present and api.use('io'))
assert(lastPrint():find('Native core: io=native %(plugin 0.1.0, api 1%)'), lastPrint())
assert(io ~= realIo and io.marker == 'real io', 'io proxy must fall through to the real table')
local opens, renames, removes = real.open, real.rename, real.remove
-- in-place write
local f = io.open('runtime/world-session.json', 'wb'); assert(f:write('{"a":', 1, '}') == f); assert(f:close() == true)
assert(disk['runtime/world-session.json'] == '{"a":1}' and n('Write') >= 2)
-- tmp + remove + rename: one native write of the final file, the temp never exists
local writes = n('Write')
f = io.open('runtime/reaction-lease.json.tmp', 'wb'); f:write('{"lease":1}'); f:close()
assert(disk['runtime/reaction-lease.json.tmp'] == nil and api.held() == 1)
assert(os.remove('runtime/reaction-lease.json') == true)
assert(os.rename('runtime/reaction-lease.json.tmp', 'runtime/reaction-lease.json') == true)
assert(disk['runtime/reaction-lease.json'] == '{"lease":1}' and n('Write') == writes + 1 and api.held() == 0)
-- reads: the first read watches the file; an unchanged revision reuses the Lua string
external('companion-actions.json', '{"actions":[1]}')
f = io.open('runtime/companion-actions.json', 'rb'); assert(f:read(1000) == '{"actions":[1]}'); f:close()
assert(watches['companion-actions.json'][1] == 50 and watches['companion-actions.json'][2] == true)
local reads = n('Read')
for _ = 1, 10 do f = io.open('runtime/companion-actions.json', 'rb'); assert(f:read('*a') == '{"actions":[1]}'); f:close() end
assert(n('Read') == reads, 'unchanged revision must not copy the content again')
external('companion-actions.json', '{"actions":[2]}')
f = io.open('runtime/companion-actions.json', 'rb'); assert(f:read('*a') == '{"actions":[2]}'); f:close()
assert(n('Read') == reads + 1)
-- a missing file is nil, as with the real io
local missing, message = io.open('runtime/reply.json', 'rb')
assert(missing == nil and message:find('No such file'))
assert(real.open == opens and real.rename == renames and real.remove == removes, 'routed IO used the real io')
`));

// Mod Organizer 2: the turn path's exchange files are rewritten in place, and "no request" is an empty file (nothing is removed).
test('with the plugin, an in-place write and an empty in-place write of an exchange file are one native write each', () => run(`
local M, api = boot(true)
local opens, renames, removes = real.open, real.rename, real.remove
local writes, nativeRemoves, nativeRenames = n('Write'), n('Remove'), n('Rename')
local f = io.open('runtime/last-input.json', 'wb'); f:write('{"requestId":"1"}'); assert(f:close() == true)
assert(disk['runtime/last-input.json'] == '{"requestId":"1"}' and n('Write') == writes + 1)
-- Withdrawing the request: open and close with no bytes is a valid empty write, not a delete.
f = io.open('runtime/last-input.json', 'wb'); assert(f:close() == true)
assert(disk['runtime/last-input.json'] == '' and n('Write') == writes + 2 and n('Remove') == nativeRemoves)
for _, name in ipairs({'reaction-lease.json', 'battle-cancellations.json', 'group-prefetch.json', 'conversation-prewarm.json', 'continuous-control.json', 'speech-state.json'}) do
  f = io.open('runtime/' .. name, 'wb'); f:write('{}'); assert(f:close() == true)
  assert(disk['runtime/' .. name] == '{}', name)
end
assert(n('Rename') == nativeRenames and n('Remove') == nativeRemoves and api.held() == 0)
assert(real.open == opens and real.rename == renames and real.remove == removes, 'routed IO used the real io')
`));

test('files outside the whitelist and read-write modes use the real io', () => run(`
local M, api = boot(true)
local opens = real.open
disk['runtime/settings.json'] = '{}'
local f = io.open('runtime/settings.json', 'rb'); assert(f:read('*a') == '{}'); f:close()
f = io.open('phone-contacts.json', 'rb')
assert(real.open == opens + 2)
f = io.open('runtime/reply.json', 'r+b'); assert(real.open == opens + 3)
assert(M.channelOf('runtime/../reply.json') == nil and M.channelOf('runtime\\\\reply.json') == 'reply.json')
assert(M.channelOf('runtime/reply.json.tmp') == 'reply.json.tmp' and M.channelOf('runtime/unknown.json') == nil)
`));

test('log appends are buffered natively; reading a log flushes and uses the real file', () => run(`
local M, api = boot(true)
local f = io.open('runtime/probe.log', 'a'); f:write('DATE', ' ', 'line', '\\n'); f:close()
assert(appended['probe.log']:find('DATE line\\n', 1, true))
local flushes = n('Flush')
disk['runtime/probe.log'] = 'old'
f = io.open('runtime/probe.log', 'rb'); assert(f:read('*a') == 'old'); f:close()
assert(n('Flush') == flushes + 1)
`));

test('the reader supports the read formats this mod uses', () => run(`
local M, api = boot(true)
external('diagnostic-request.txt', 'first\\r\\nsecond\\n42 rest')
local f = io.open('runtime/diagnostic-request.txt', 'rb')
assert(watches['diagnostic-request.txt'][2] == false, 'a .txt channel is not JSON-gated')
assert(f:read('*l') == 'first' and f:read('l') == 'second')
assert(f:read('*n') == 42 and f:read(3) == ' re' and f:read(0) == '' and f:read('*a') == 'st')
assert(f:read('*a') == '' and f:read(1) == nil and f:read('*l') == nil)
f:close()
external('diagnostic-request.txt', 'a\\nb')
local lines = {}; for line in io.open('runtime/diagnostic-request.txt'):lines() do lines[#lines + 1] = line end
assert(#lines == 2 and lines[2] == 'b')
`));

test('the kill switch returns to Lua within 0.5 s, logs it, flushes, and comes back', () => run(`
local M, api = boot(true)
local flushes = n('Flush')
enabled = false
advance(0.1); assert(api.use('io'), 'the switch is re-read at most every 0.5 s')
advance(0.5); assert(not api.use('io'))
assert(lastPrint():find('io=lua %(off') and lastPrint():find('%[changed%]'), lastPrint())
assert(n('Flush') == flushes + 1, 'pending native writes are flushed before Lua takes over')
local opens = real.open
local f = io.open('runtime/world-session.json', 'wb'); f:write('lua'); f:close()
assert(real.open == opens + 1 and disk['runtime/world-session.json'] == 'lua')
enabled = true; advance(0.6); assert(api.use('io'))
assert(lastPrint():find('io=native'), lastPrint())
`));

test('a temp file held when the switch flips still lands', () => run(`
local M, api = boot(true)
local f = io.open('runtime/relationship-state.json.tmp', 'wb'); f:write('held'); f:close()
enabled = false; advance(1); assert(not api.use('io'))
local renames = real.rename
assert(os.remove('runtime/relationship-state.json') == nil or true)
assert(os.rename('runtime/relationship-state.json.tmp', 'runtime/relationship-state.json') == true)
assert(disk['runtime/relationship-state.json'] == 'held' and real.rename == renames and api.held() == 0)
`));

test('a failing native call puts io back on Lua for the session and the write still lands', () => run(`
local M, api = boot(true)
broken = true
local f = io.open('runtime/speech-state.json', 'wb'); f:write('{"s":1}'); assert(f:close())
assert(disk['runtime/speech-state.json'] == '{"s":1}')
assert(not api.use('io') and lastPrint():find('io=lua %(native call failed'), lastPrint())
broken = false; advance(5); assert(not api.use('io'), 'a failed native call keeps io on Lua')
`));

test('the plugin must be writing to this mod runtime folder', () => run(`
local write = fakeIo.Write
fakeIo.Write = function(name, text) return true end -- lands somewhere else
local before = io
local M, api = boot(true)
assert(io == before and api.present and not api.ioReady and not api.use('io'))
assert(lastPrint():find('different runtime folder'), lastPrint())
assert(api.ioReason:find('plugin folder') and api.ioReason:find('CET folder') and api.ioReason:find('file is missing'), api.ioReason)
assert(api.use('actuator') == true, 'a folder mismatch gates only io: the systems that touch no file keep running natively')
fakeIo.Write = write
`));

test('convaiNative.off/on edit native-off.txt through the real io', () => run(`
local M, api = boot(true)
disk['runtime/native-off.txt'] = 'gaze\\n'
assert(api.off('io')); assert(disk['runtime/native-off.txt'] == 'gaze\\nio\\n')
assert(api.on('io')); assert(disk['runtime/native-off.txt'] == 'gaze\\n')
assert(api.status():find('plugin') and api.probe():find('player'))
`));

test('init.lua installs the shim before the perf probe and any module opens a file', () => {
  // The once-per-load cut of probe.log and mcm.log (LOG-TRIM) runs first, with the game's own io, before the shim; it is not "a module".
  const code = init.replace(/-- LOG-TRIM-BEGIN[\s\S]*?-- LOG-TRIM-END/, '');
  const shimAt = code.indexOf("dofile('native-core.lua').install()");
  const probeAt = code.indexOf("dofile('perf-probe.lua').hookRegistrations()");
  const firstOpen = code.indexOf('io.open(');
  assert.ok(shimAt > 0 && shimAt < probeAt && shimAt < firstOpen);
  for (const event of ['onInit', 'onUpdate']) {
    const start = init.indexOf(`registerForEvent('${event}', function(`);
    const body = init.slice(start, start + 400);
    assert.ok(start > 0 && body.includes(`pcall(convaiNative.redetect, '${event}')`), `${event} must re-run native detection`);
  }
  assert.ok(code.slice(0, shimAt).split('\n').every(line => /^\s*(--.*)?\r?$/.test(line) || line.startsWith('pcall(')));
});

// Parity fixture for the native side (native/core/tests/io_tests.cpp): the channel each runtime path
// routes to. CONVAI_WRITE_FIXTURES=1 rewrites it; otherwise the committed file must match the Lua.
test('the io-channels parity fixture matches mod/native-core.lua', () => {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const body = `
local M = (function() ${shim} end)()
local paths = {}
local names = {}
for name in pairs(M.routed) do names[#names + 1] = name end
table.sort(names)
for _, name in ipairs(names) do
  paths[#paths + 1] = 'runtime/' .. name
  paths[#paths + 1] = 'runtime/' .. name .. '.tmp'
end
for _, path in ipairs({'runtime/phone-history.json.previous', './runtime/reply.json', 'runtime\\\\reply.json',
  'runtime/settings.json', 'runtime/../reply.json', 'runtime/reply.json/', 'C:/runtime/reply.json', 'reply.json',
  'runtime/.reply.json', 'runtime/sub/reply.json', 'runtime/reply.json.bak', ''}) do paths[#paths + 1] = path end
local lines = {}
for _, path in ipairs(paths) do lines[#lines + 1] = path .. '\\t' .. (M.channelOf(path) or '') end
OUT = table.concat(lines, '\\n')`;
  const status = lauxlib.luaL_dostring(vm, to_luastring(body));
  assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1)));
  lua.lua_getglobal(vm, to_luastring('OUT'));
  const out = to_jsstring(lua.lua_tostring(vm, -1)); lua.lua_close(vm);
  const cases = out.split('\n').map(line => {
    const [path, channel] = line.split('\t');
    return {name: path || '(empty)', input: {path}, output: {channel: channel || null}};
  });
  const fixture = JSON.stringify({system: 'io', source: 'mod/native-core.lua', cases}, null, 1) + '\n';
  const target = new URL('../native/core/tests/fixtures/io-channels.json', import.meta.url);
  if (process.env.CONVAI_WRITE_FIXTURES === '1') writeFileSync(target, fixture);
  assert.equal(readFileSync(target, 'utf8').replace(/\r\n/g, '\n'), fixture,'Lua routing changed: re-record with CONVAI_WRITE_FIXTURES=1 and rebuild the native tests');
  assert.ok(cases.some(item => item.output.channel === 'reply.json.tmp'));
  assert.ok(!cases.some(item => item.input.path.includes('..') && item.output.channel));
});

test('control files saved with a UTF-8 byte order mark or as UTF-16 parse like plain text (native-off.txt and native-verify.txt)', () => run(`
local M, api = boot(true)
local function utf16(text, big, mark)
  local out = {}
  if mark then out[1] = big and '\\254\\255' or '\\255\\254' end
  for index = 1, #text do out[#out + 1] = big and ('\\0' .. text:sub(index, index)) or (text:sub(index, index) .. '\\0') end
  return table.concat(out)
end
local text = '# comment\\r\\nActuator\\r\\nclearance\\r\\n'
assert(M.controlText(text) == text)
assert(M.controlText('\\239\\187\\191all') == 'all')
for _, form in ipairs({'\\239\\187\\191' .. text, utf16(text, false, true), utf16(text, true, true), utf16(text, false, false), utf16(text, true, false)}) do
  assert(M.controlText(form) == text, 'decoded the same text')
end
assert(M.controlText(nil) == '' and M.controlText('') == '')
-- verify mode reads a file with a mark
api.verifying('actuator')
external('native-verify.txt', '\\239\\187\\191' .. text); advance(1.1)
assert(api.verifying('actuator') == true and api.verifying('clearance') == true and api.verifying('gaze') == false)
external('native-verify.txt', utf16(text, false, true)); advance(1.1)
assert(api.verifying('actuator') == true and api.verifying('clearance') == true)
-- off/on edits a file with a mark and writes it back as plain text
disk['runtime/native-off.txt'] = '\\239\\187\\191gaze\\r\\n'
assert(api.off('io')); assert(disk['runtime/native-off.txt'] == 'gaze\\nio\\n', disk['runtime/native-off.txt'])
disk['runtime/native-off.txt'] = utf16('gaze\\r\\nio\\r\\n', false, true)
assert(api.on('io')); assert(disk['runtime/native-off.txt'] == 'gaze\\n', disk['runtime/native-off.txt'])
`));

test('runtime/native-verify.txt turns developer verify mode on per system, read once a second without a CET io.open', () => run(`
local M, api = boot(true)
assert(type(api.verifying) == 'function')
local opens = real.open
assert(api.verifying('actuator') == false and api.verifying('clearance') == false, 'no file: off')
assert(watches['native-verify.txt'] and watches['native-verify.txt'][1] == 1000, 'the plugin worker polls it')
external('native-verify.txt', '# a comment\\nActuator  \\n\\nclearance # trailing\\n')
assert(api.verifying('actuator') == false, 'checked at most once a second')
advance(1.1)
assert(api.verifying('actuator') == true and api.verifying('clearance') == true and api.verifying('gaze') == false)
assert(lastPrint():find('Native core: verify mode on for actuator, clearance'), lastPrint())
assert(real.open == opens, 'no CET io.open was needed')
external('native-verify.txt', 'all\\n')
advance(1.1)
assert(api.verifying('gaze') == true, 'all')
external('native-verify.txt', '')
advance(1.1)
assert(api.verifying('actuator') == false and lastPrint():find('Native core: verify mode off'), lastPrint())
-- the file disappears
external('native-verify.txt', 'actuator\\n'); advance(1.1); assert(api.verifying('actuator') == true)
disk['runtime/native-verify.txt'] = nil; external('native-verify.txt', nil); advance(1.1)
assert(api.verifying('actuator') == false)
-- a broken plugin never raises into the shim
broken = true; advance(1.1)
assert(api.verifying('actuator') == false)
`));

test('without the plugin verify mode is off and reads nothing', () => run(`
local M, api = boot(false)
assert(api.verifying('actuator') == false and n('Revision') == 0)
`));

test('revision(): nil without the plugin, before a file is read, for an unrouted name and while io is off; else the worker revision', () => run(`
local M, api = boot(false)
assert(api.revision('reply.json') == nil, 'no plugin')
convaiNative, io, os = nil, realIo, realOs
M, api = boot(true)
external('reply.json', '{"requestId":"1"}')
assert(api.revision('reply.json') == nil, 'not read yet: the worker does not watch it')
local f = io.open('runtime/reply.json', 'rb'); assert(f:read('*a') == '{"requestId":"1"}'); f:close()
local first = api.revision('reply.json')
assert(type(first) == 'number' and first > 0, tostring(first))
local reads = n('Read')
assert(api.revision('reply.json') == first, 'unchanged bytes keep their revision')
assert(n('Read') == reads, 'a revision check never reads the file')
external('reply.json', '{"requestId":"2"}')
local second = api.revision('reply.json')
assert(second ~= first, 'new bytes, new revision')
assert(api.revision('not-routed.json') == nil)
enabled = false; advance(1)
assert(api.revision('reply.json') == nil, 'io switched off')
`));

test('init.lua checks reply.json through revision() every 30 ms while a reply is due, before its 0.1 s throttle', () => {
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"));
  const probe = update.indexOf("convaiNative.revision('reply.json')");
  const throttle = update.indexOf('if poll < 0.1 then return end');
  assert.ok(probe > 0 && throttle > probe, 'the probe sits before the throttle');
  const block = update.slice(update.lastIndexOf('if pending', probe), throttle);
  assert.match(block, /replyProbe >= 0\.03/);
  assert.match(block, /poll = 0\.1/);
});

test('phone-chat.lua checks phone-chat-output.json through revision() every 30 ms while a reply is due, before its 0.1 s tick', () => {
  const phone = readFileSync(new URL('../mod/phone-chat.lua', import.meta.url), 'utf8');
  const update = phone.slice(phone.indexOf('function M.update(player, delta)'));
  const probe = update.indexOf("convaiNative.revision('phone-chat-output.json')");
  const tick = update.indexOf('if M.tick < 0.10 then return end');
  const early = update.indexOf('if M.tick < 0.10 and M.world then return end');
  assert.ok(probe > 0 && tick > probe, 'the probe sits before the tick');
  assert.ok(early > probe, 'and before the early return of the 10 Hz binding check, which would otherwise end every frame first');
  const block = update.slice(update.lastIndexOf('if M.pending', probe), tick);
  assert.match(block, /M\.replyProbe >= 0\.03/);
  assert.match(block, /M\.tick = 0\.10/);
});

test('init.lua opens runtime/reply.json again only when its native revision changed (or once a second, or without the plugin)', () => {
  const update = init.slice(init.indexOf("registerForEvent('onUpdate'"));
  const open = update.indexOf("io.open('runtime/reply.json', 'rb')");
  assert.ok(open > 0);
  const gate = update.slice(update.lastIndexOf('if pending then', open), open);
  assert.match(gate, /convaiNative\.revision\('reply\.json'\)/);
  assert.match(gate, /revision > 0 and revision == convaiHeartbeat\.replyReadRevision and replyRaw/);
  assert.match(gate, /clock - convaiHeartbeat\.replyReadAt < 1/);
  assert.match(gate, /raw = replyRaw/);
  assert.match(update.slice(open, open + 400), /if replyFile then/);
});
