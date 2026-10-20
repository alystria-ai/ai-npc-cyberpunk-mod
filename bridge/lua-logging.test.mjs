// The game side's logging, in fengari: probe.log and mcm.log are cut back once per load (mod/init.lua, LOG-TRIM), a line that only says nothing failed does
// not force a flush, and an encoder that raises cannot leave the request file emptied with its handle open. Not run in the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function between(start, end) {
  const from = init.indexOf(start), to = init.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} .. ${end} not found in init.lua`);
  return init.slice(from, to + end.length);
}

function run(program) {
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  try {
    const status = lauxlib.luaL_dostring(L, to_luastring(program));
    const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1));
    assert.equal(status, lua.LUA_OK, error);
    return lua.lua_gettop(L) > 0 && lua.lua_type(L, -1) === lua.LUA_TSTRING ? to_jsstring(lua.lua_tostring(L, -1)) : undefined;
  } finally { lua.lua_close(L); }
}

// An in-memory file system with the calls the block uses: open (rb, wb), seek, read, write, close.
const FILES = String.raw`
files, opens = {}, {}
io = {open = function(path, mode)
    opens[#opens + 1] = mode .. ' ' .. path
    if mode == 'rb' then
        local text = files[path]
        if text == nil then return nil end
        local position = 0
        return {seek = function(_, whence, offset)
                if whence == 'end' then return #text end
                if whence == 'set' then position = offset; return position end
            end,
            read = function(_, count) local piece = text:sub(position + 1, position + count); position = position + #piece; return piece end,
            close = function() return true end}
    end
    return {write = function(_, data) files[path] = (files[path] and mode == 'ab' and files[path] or '') .. data; return true end, close = function() return true end}
end}
`;

test('a probe.log over 1 MB keeps its last 256 KB from a whole line; mcm.log over 256 KB keeps 64 KB; smaller files and missing files are left alone', () => {
  const block = between('-- LOG-TRIM-BEGIN', '-- LOG-TRIM-END');
  const out = run(`${FILES}
    local lines = {}
    for index = 1, 40000 do lines[index] = string.format('2026-10-19T10:00:00Z line %06d xxxxxxxxxxxxxxxxxxxxxxxxxxx', index) end
    files['runtime/probe.log'] = table.concat(lines, '\\n') .. '\\n'
    files['runtime/mcm.log'] = string.rep('m', 100) .. '\\n'
    local before = #files['runtime/probe.log']
    ${block}
    local probe = files['runtime/probe.log']
    assert(before > 1048576, 'the test file is over the cap: ' .. before)
    assert(#probe <= 262144 and #probe > 200000, 'kept ' .. #probe)
    assert(probe:sub(1, 20) == '2026-10-19T10:00:00Z', 'starts at a whole line')
    assert(probe:find('line 040000', 1, true), 'the newest line is kept')
    assert(files['runtime/mcm.log'] == string.rep('m', 100) .. '\\n', 'a small mcm.log is not rewritten')
    local rewrites = 0
    for _, entry in ipairs(opens) do if entry:find('^wb') then rewrites = rewrites + 1 end end
    assert(rewrites == 1, 'one rewrite: ' .. rewrites)
    -- Run again: now under the cap, nothing more is written.
    ${block}
    local again = 0
    for _, entry in ipairs(opens) do if entry:find('^wb') then again = again + 1 end end
    assert(again == 1, 'under the cap nothing is rewritten')
    return 'ok'`);
  assert.equal(out, 'ok');
});

test('the trim never raises: a missing log, a file that cannot be reopened for writing, and an io without seek', () => {
  const block = between('-- LOG-TRIM-BEGIN', '-- LOG-TRIM-END');
  assert.equal(run(`${FILES}
    ${block}
    local realOpen = io.open
    files['runtime/probe.log'] = string.rep('x', 2000000)
    io.open = function(path, mode) if mode == 'wb' then return nil end return realOpen(path, mode) end
    ${block}
    assert(#files['runtime/probe.log'] == 2000000, 'a failed reopen leaves the file as it was')
    io.open = function() return {close = function() end} end
    ${block}
    return 'ok'`), 'ok');
});

test('a log line that only says nothing failed waits for the batch; a real failure still flushes at once', () => {
  const block = between('convaiLogFile = function(line)', "convaiLogFlush() end\nend");
  assert.equal(run(`
    convaiLog = {lines = {}, n = 0, bytes = 0, at = 0}
    flushes = 0
    convaiLogFlush = function() flushes = flushes + 1; convaiLog.n, convaiLog.bytes = 0, 0 end
    ${block}
    convaiLogFile('Conversation result: error=false text=12')
    convaiLogFile('Face graphs: loaded failed:0 skipped:2')
    assert(flushes == 0, 'harmless lines wait: ' .. flushes)
    convaiLogFile('Conversation result: error=true')
    assert(flushes == 1, 'a real error flushes')
    convaiLogFile('Face graphs: failed:3')
    assert(flushes == 2, 'a real failure flushes')
    convaiLogFile('World abandoned')
    assert(flushes == 3)
    return 'ok'`), 'ok');
});

test('the request is encoded before its file is opened, so an encoder that raises cannot leave it emptied; the same for the lease and the group preparation', () => {
  const send = between("local encodedOk, encoded = pcall(json.encode, context)", "file:write(encoded); file:close()");
  assert.match(send, /request-write-failed/);
  assert.ok(send.indexOf('pcall(json.encode, context)') < send.indexOf("io.open('runtime/last-input.json', 'wb')"), 'encoded first');
  assert.doesNotMatch(init, /file:write\(json\.encode\(context\)\)/);
  assert.ok(init.indexOf("pcall(json.encode, preparation)") < init.indexOf("io.open('runtime/group-prefetch.json', 'wb')"));
  assert.ok(init.indexOf("local encodedOk, encoded = pcall(json.encode, {requestId = automatic.requestId") < init.indexOf("io.open('runtime/reaction-lease.json', 'wb')"));
});
