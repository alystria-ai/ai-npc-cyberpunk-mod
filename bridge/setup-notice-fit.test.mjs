// The setup check's first-load notice (mod/setup-check.lua shortText) is drawn on the game's warning line like the daily-limit notice:
// at most two lines of upper-case text in every language (the measure is in bridge/notice-fit.mjs, the numbers in docs/NOTIFICATIONS.md).
// The notice is one short paragraph: no line break, and nothing but the first critical problem.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {noticeProblems, NOTICE_MAX_ENGLISH, NOTICE_MAX_TRANSLATION} from './notice-fit.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const codes = ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko'];
const source = read('../mod/setup-check.lua').replace(/\r\n/g, '\n');
const catalog = JSON.parse(read('../localization/en.json')).strings;

// The sentences shortText can return: every ui.t('...') inside that function.
const body = /local function shortText\(id, names, old, values\)([\s\S]*?)\nend\n/.exec(source);
assert(body, 'shortText moved');
const notices = [...body[1].matchAll(/ui\.t\('((?:[^'\\]|\\.)*)'/g)].map(match => match[1].replace(/\\'/g, "'"));
// {name} is RED4ext or Codeware (a product name that stays English in every language); {names} is the widest
// list the notice can name: both of them (REQUIREMENT_IDS in the module), never Native Settings UI.
// {game}, {other}, {scripts} and {runtime} are game versions: 2.31 is the widest.
// {drive} is a letter and a colon, {free} the widest number the line shows (a drive just under 2 GB prints 1.9, an empty one 0.0).
const filled = text => text.replace('{name}', 'Codeware').replace('{names}', 'RED4ext, Codeware').replace(/\{(game|other|scripts|runtime)\}/g, '2.31').replace('{drive}', 'C:').replace('{free}', '1.9');

function localeTable(code) {
  const vm = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(vm);
  const status = lauxlib.luaL_dostring(vm, to_luastring(read(`../mod/locales/${code}.lua`)));
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

test('the notice is one of twenty-one short sentences, each catalogued and each within the English budget', () => {
  assert.equal(notices.length, 21, notices.join('\n'));
  for (const text of notices) {
    assert.equal(catalog[text], text, `missing from localization/en.json: ${text}`);
    assert.deepEqual(noticeProblems(filled(text), {english: true}), [], text);
    assert(!/\bAMM\b/.test(text));
  }
  assert(NOTICE_MAX_TRANSLATION > NOTICE_MAX_ENGLISH);
});

test('only the first critical problem is announced: shortText is the whole notice, with no second line', () => {
  const first = /local function firstLoad\(\)([\s\S]*?)\nend\n/.exec(source);
  assert(first, 'firstLoad moved');
  const code = first[1].replace(/--.*$/gm, '');
  // Every way out is nil or one shortText sentence: the first problem alone, or the requirements that are missing together named in one.
  const returns = [...code.matchAll(/return ([^\n]*)/g)].map(match => match[1]);
  assert(returns.length >= 3, returns.join('\n'));
  for (const value of returns) assert(/^(nil|shortText\()/.test(value) || /then return shortText\(/.test(value), `a return that is not one sentence: ${value}`);
  assert(/return shortText\(first\)/.test(code), 'the notice is the first problem alone');
  assert(!/\\n/.test(code), 'no line break is built here');
});

for (const code of codes) {
  test(`${code}: every sentence of the notice fits two lines of the warning line`, () => {
    const table = localeTable(code);
    const found = [];
    for (const text of notices) {
      assert(table[text], `${code} has no translation of: ${text}`);
      found.push(...noticeProblems(filled(table[text])).map(problem => `${code}: ${problem}`));
    }
    assert.deepEqual(found, []);
  });
}
