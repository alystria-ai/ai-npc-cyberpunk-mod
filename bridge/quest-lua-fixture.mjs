// Shared pieces of the offline tests of the bond quest game modules (mod/quest-*.lua): running Lua in fengari, reading a module's source, and a fake game in Lua
// (a clock, files in memory, a table literal in place of json, a fake world whose entity handles die at every tick). Nothing here starts the game.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

export const read = path => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
export const source = name => read(`../mod/${name}`);

export function run(code) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const result = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  const line = Number(/\]:(\d+):/.exec(error)?.[1]);
  assert.equal(result, lua.LUA_OK, error + (line ? '\n>> ' + code.split('\n')[line - 1].trim() : ''));
}

// A module's source as a Lua expression that evaluates to the module table.
export const load = name => `(function() ${source(name)} end)()`;

// Lua helpers: serialize (a table literal stands in for json), decode, a counter of calls, and the fake game state.
export const base = `
local function serialize(value)
  if type(value) == 'table' then
    local keys = {}
    for k in pairs(value) do keys[#keys + 1] = k end
    table.sort(keys, function(a, b) return tostring(a) < tostring(b) end)
    local parts = {}
    for _, k in ipairs(keys) do parts[#parts + 1] = '[' .. serialize(k) .. ']=' .. serialize(value[k]) end
    return '{' .. table.concat(parts, ',') .. '}'
  elseif type(value) == 'string' then return string.format('%q', value)
  else return tostring(value) end
end
local function decode(text) return load('return ' .. text)() end
local logs = {}
local function log(line) logs[#logs + 1] = line end
local function logged(pattern)
  for _, line in ipairs(logs) do if line:find(pattern, 1, true) then return true end end
  return false
end
`;

// A fake ctx for the modules that take one (places, prims): it tracks, reaps LIFO, records events, and offers listeners and timers like the real one.
export const fakeCtx = `
local function newCtx(pack, character)
  local ctx = {pack = pack, character = character or 'panam-palmer', tracked = {}, events = {}, listeners = {}, timers = {}, places = {}, tag = 'CyberpunkConvaiQuest:' .. pack, reaped = false}
  function ctx:track(kind, handle, undo) self.tracked[#self.tracked + 1] = {kind = kind, handle = handle, undo = undo}; return handle end
  function ctx:emit(name)
    if self.reaped then return end
    self.events[#self.events + 1] = name
    for _, l in ipairs(self.listeners) do if l.name == name then l.fn(name) end end
  end
  function ctx:on(name, fn) self.listeners[#self.listeners + 1] = {name = name, fn = fn} end
  function ctx:after(seconds, fn, opts) self.timers[#self.timers + 1] = {seconds = seconds, fn = fn, opts = opts} end
  function ctx:reap()
    self.reaped = true
    for i = #self.tracked, 1, -1 do local t = self.tracked[i]; self.tracked[i] = nil; if t.undo then t.undo(t.handle) end end
  end
  function ctx:count(name) local n = 0 for _, e in ipairs(self.events) do if e == name then n = n + 1 end end return n end
  return ctx
end
`;
