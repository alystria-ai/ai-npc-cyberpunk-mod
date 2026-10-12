import assert from 'node:assert/strict';
import {readFileSync, writeFileSync} from 'node:fs';
import fengari from 'fengari';

// Shared pieces of the native-port parity recorders (bridge/<module>-native.test.mjs): a fengari
// sandbox, JS values as Lua literals, the Lua fixture encoder, and the fixture writer/checker.
// A recorder runs the ORIGINAL Lua module against a fake game and writes the inputs, the outputs
// and the wire text the plugin must answer with to native/core/tests/fixtures/<name>.json.
// CONVAI_WRITE_FIXTURES=1 rewrites the files; otherwise the committed file must equal the Lua
// output, so a Lua change that breaks parity fails npm test.

export const fixtureUrl = name => new URL(`../native/core/tests/fixtures/${name}.json`, import.meta.url);
export const moduleSource = file => readFileSync(new URL(`../mod/${file}`, import.meta.url), 'utf8');

// A JS value as a Lua literal. Strings are JSON-quoted (the recorders only use plain ASCII).
export function lit(value) {
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

// Lua source: enc(value) -> JSON text with sorted keys; non-finite numbers are the strings
// "nan", "inf", "-inf"; num(v) -> %.17g text (the wire number format); words(v) -> the wire word.
export const luaEncoder = `
function enc(v)
  local kind = type(v)
  if v == nil then return 'null' end
  if kind == 'boolean' then return tostring(v) end
  if kind == 'number' then
    if v ~= v then return '"nan"' end
    if v == math.huge then return '"inf"' end
    if v == -math.huge then return '"-inf"' end
    -- fengari integers are 32 bit: larger whole numbers are floats and go through %.0f
    if v == 0 then return '0' end
    if v == math.floor(v) and math.abs(v) < 1e15 then return string.format('%.0f', v) end
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
function num(v)
  if v ~= v then return 'nan' end
  if v == math.huge then return 'inf' end
  if v == -math.huge then return '-inf' end
  return string.format('%.17g', v)
end
function flag(v) return v and '1' or '0' end
-- "123ULL" (the text CET prints for an entity hash) -> "123"; nil -> "0".
function digits(text)
  if text == nil then return '0' end
  return (tostring(text):gsub('[uUlL]+$', ''))
end
`;

export function vm() {
  const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
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

// JSON with small objects and arrays kept on one line.
const replacer = (key, value) =>
  typeof value === 'number' && !Number.isFinite(value) ? (Number.isNaN(value) ? 'nan' : value > 0 ? 'inf' : '-inf') : value;
export function pretty(value, depth = 0) {
  const inline = JSON.stringify(value, replacer);
  if (inline.length <= 200 || typeof value !== 'object' || value === null) return inline;
  const pad = ' '.repeat(depth + 1), end = ' '.repeat(depth);
  if (Array.isArray(value)) return '[\n' + value.map(item => pad + pretty(item, depth + 1)).join(',\n') + '\n' + end + ']';
  const rows = Object.entries(value).map(([key, item]) => pad + JSON.stringify(key) + ': ' + pretty(item, depth + 1));
  return '{\n' + rows.join(',\n') + '\n' + end + '}';
}
export const encodeFixture = fixture => pretty(fixture) + '\n';

// Runs each case through `record` (a Lua function name taking the input table and returning the
// output table) in a fresh sandbox that already ran `prelude`.
export function recordCases({prelude, cases, system, source, record = 'record'}) {
  const sandbox = vm();
  sandbox.run(prelude);
  const out = [];
  for (const item of cases) {
    sandbox.run(`OUT = enc(${record}((function() local c = ${lit({...item.input, name: item.name})} return c end)()))`);
    out.push({name: item.name, input: item.input, output: JSON.parse(sandbox.read('OUT'))});
  }
  sandbox.close();
  return {system, source, cases: out};
}

// The fixture on disk must equal what the Lua just produced (or is rewritten when asked).
export function checkFixture(name, fixture, hint) {
  const text = encodeFixture(fixture);
  if (process.env.CONVAI_WRITE_FIXTURES === '1') writeFileSync(fixtureUrl(name), text);
  assert.equal(readFileSync(fixtureUrl(name), 'utf8').replace(/\r\n/g, '\n'), text,
    `${hint}: re-record with CONVAI_WRITE_FIXTURES=1 and rebuild the native tests`);
}
