import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

// Project rule since 2026-10-29: no recommendation labels anywhere in the UI (in-game menu, character editor page, manager), in any language.
// Nothing is tagged "recommended"; a voice or a provider is just named. (The Nexus page keeps its own "Recommended settings" block, which is not UI.)
const read = rel => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const codes = ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko'];
const BANNED = new RegExp([
  'recommend', 'recomend', 'recomand', 'empfohlen', 'empfehl', 'consigliat', 'consiglia', 'doporuč', 'ajánlott',
  'zalecan', 'zalecen', 'рекоменд', 'радим', 'önerilen', 'tavsiye', '推奨', '推荐', '推薦', '권장', '추천',
].join('|'), 'iu');

function localeTable(code) {
  const vm = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(vm);
  const status = lauxlib.luaL_dostring(vm, to_luastring(read(`mod/locales/${code}.lua`)));
  assert.equal(status, lua.LUA_OK, status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1)));
  const rows = {};
  lua.lua_pushnil(vm);
  while (lua.lua_next(vm, -2) !== 0) {
    rows[to_jsstring(lua.lua_tostring(vm, -2))] = to_jsstring(lua.lua_tostring(vm, -1));
    lua.lua_pop(vm, 1);
  }
  lua.lua_close(vm);
  return rows;
}

test('the English UI catalogue has no recommended label', () => {
  const catalog = JSON.parse(read('localization/en.json')).strings;
  for (const key of Object.keys(catalog)) assert.doesNotMatch(key, BANNED, key);
});

for (const code of codes) test(`${code} dictionary has no recommended label`, () => {
  for (const [key, value] of Object.entries(localeTable(code))) {
    assert.doesNotMatch(key, BANNED, `${code} key: ${key}`);
    assert.doesNotMatch(value, BANNED, `${code}: ${key}`);
  }
});

test('the character editor page and its server text carry no recommended label', () => {
  for (const rel of ['bridge/character-editor-page.mjs', 'bridge/character-editor.mjs', 'bridge/character-editor-server.mjs', 'bridge/prompting-editor.mjs', 'mod/character-editor.lua']) {
    assert.doesNotMatch(read(rel), /\brecommended\b/i, rel);
  }
});

test('the manager source builds no recommended label (menu rows, voice list, settings pages)', () => {
  for (const rel of ['mod/manager-ui.lua', 'mod/manager.lua', 'mod/manager-party.lua', 'mod/mcm-host.lua', 'mod/nsui.lua']) {
    const code = read(rel).split('\n').filter(line => !/^\s*--/.test(line)).join('\n');
    assert.doesNotMatch(code, /recommended/i, rel);
  }
});
