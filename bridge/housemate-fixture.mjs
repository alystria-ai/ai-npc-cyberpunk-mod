// Runs the housemate Lua modules (mod/housemate-*.lua, mod/housemates.lua) in Fengari with the game replaced by seams. Every module is
// loaded from the real file; `dofile` finds them by name. A test passes Lua code that asserts; a failing assert fails the test with the
// Lua message.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import fengari from 'fengari';

const modDir = new URL('../mod/', import.meta.url);
const NAMES = ['housemate-registry.lua', 'housemate-plan.lua', 'housemate-chat.lua', 'housemates.lua', 'housemate-spots-data.lua',
  'housemate-world.lua', 'housemate-service.lua'];

export function modules(extra = []) {
  const sources = {};
  for (const name of [...NAMES, ...extra]) {
    try { sources[name] = readFileSync(new URL(name, modDir), 'utf8'); } catch { /* optional module */ }
  }
  return sources;
}

export function lua(code, {extra = [], prelude = ''} = {}) {
  const {lua: L, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const sources = modules(extra);
  const vm = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(vm);
  let table = 'local __src = {}\n';
  for (const [name, text] of Object.entries(sources)) table += `__src[${JSON.stringify(name)}] = [=====[${text}]=====]\n`;
  const boot = `${table}
local loaded = {}
function dofile(name)
  if loaded[name] ~= nil then return loaded[name] end
  assert(__src[name], 'no module ' .. name)
  local chunk, err = load(__src[name], '@' .. name)
  assert(chunk, err)
  local value = chunk()
  loaded[name] = value
  return value
end
json = {encode = function(value) return '{}' end, decode = function(text) return {} end}
${prelude}
`;
  const result = lauxlib.luaL_dostring(vm, to_luastring(boot + code));
  const error = result === L.LUA_OK ? '' : to_jsstring(L.lua_tostring(vm, -1));
  L.lua_close(vm);
  assert.equal(result, L.LUA_OK, error);
}

// FNV-1a 32 as the mod computes it, for the tests that compare the two.
export function fnv(text) {
  let h = 0x811c9dc5;
  for (const byte of Buffer.from(text)) { h ^= byte; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
