import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {describePlace, INTERIORS, HOME_PLACES} from './place-names.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const words = readFileSync(new URL('../mod/place-words.lua', import.meta.url), 'utf8');

// mod/place-words.lua words the place for a meeting in Lua; bridge/place-names.mjs words the place V is at for every turn. The two must
// agree, or a character would name the same bar two ways.
function place(district, area) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const program = `local words = (function() ${words} end)()
    return tostring(words.text(${JSON.stringify(district)}, ${area === undefined ? 'nil' : JSON.stringify(area)}))`;
  const status = lauxlib.luaL_dostring(state, to_luastring(program));
  const text = to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, text);
  return text;
}

test('every named interior and home is worded the same in Lua as in the bridge', () => {
  for (const area of [...Object.keys(INTERIORS), ...Object.keys(HOME_PLACES)]) {
    assert.equal(place('Watson', area), describePlace({district: 'Watson', area}).text, area);
  }
});

test('plain districts, neighbourhoods, apartments and the Badlands agree too', () => {
  const cases = [['Watson'], ['SantoDomingo'], ['JapanTown'], ['Watson', 'Kabuki'], ['SantoDomingo', 'Arroyo'], ['Westbrook', 'JapanTown'],
    ['Badlands', 'Badlands_RockyRidge'], ['Watson', 'Kabuki_Apartment'], ['CorpoPlaza', 'CorpoPlaza_ArasakaTower_Lobby'],
    ['Watson', 'Watson'], ['Heywood', 'Vista_del_Rey_Something']];
  for (const [district, area] of cases) {
    assert.equal(place(district, area), describePlace({district, area}).text, `${district} ${area}`);
  }
});

test('the compass words and an unreadable place', () => {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(`local words = (function() ${words} end)()
    assert(words.compass(0, 10) == 'north' and words.compass(10, 0) == 'east' and words.compass(-10, -10) == 'south-west')
    assert(words.compass(10, 10) == 'north-east' and words.compass(0, -5) == 'south' and words.compass(-5, 0) == 'west')
    assert(words.text(nil) == nil and words.text('') == nil and words.words('') == nil)`));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state); assert.equal(status, lua.LUA_OK, error);
});
