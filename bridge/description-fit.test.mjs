// The help text of a row is shown in the description area of Native Settings UI's Mods screen when the row is hovered. The size of that
// area is the game's, not ours, and cannot be read from the files this repository may use, so the host (mod/nsui.lua) keeps every
// description within LAYOUT.descriptionChars characters: whole paragraphs while they fit, otherwise the first paragraph cut at a
// sentence or a word and ended with an ellipsis. This test runs the host's own fitDescription over every description the page can
// show, in English and the 15 translations, and holds it to what it promises. It also keeps the paragraphs that matter first: the rules
// of Mature content, and the note on who answers right now, always survive the cut. It estimates; it cannot see the game.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {run, nsuiFixture} from './manager-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const catalog = JSON.parse(read('../localization/en.json'));
const codes = ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko'];
const LIMIT = Number(/descriptionChars = (\d+)/.exec(read('../mod/nsui.lua'))[1]);

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

// The strings of the page that are shown as a description (a row's own label is short and cut separately, with an ellipsis).
const CONTEXTS = ['page.setting', 'page.action', 'page.readonly', 'page.category', 'page.keyRow'];
const singles = [...new Set(CONTEXTS.flatMap(name => catalog.contexts[name] ?? []))].filter(text => text.length > 40);

// A Lua table literal of strings: JSON escapes (\n, \", \\) are Lua escapes too, and non-ASCII text is read as UTF-8.
const luaList = texts => `{${texts.map(text => JSON.stringify(text)).join(',')}}`;

function checkInLua(texts, label) {
  run(`${nsuiFixture}
    local texts = ${luaList(texts)}
    local limit = ${LIMIT}
    local function characters(text) local _, count = text:gsub('[^\\128-\\191]', ''); return count end
    local cut, longest = 0, 0
    for index, text in ipairs(texts) do
      local fitted = managerUi.fitDescription(text)
      local size = characters(fitted)
      longest = math.max(longest, size)
      assert(size <= limit, '${label}: a description of ' .. size .. ' characters passed (' .. fitted:sub(1, 60) .. ')')
      if fitted ~= text then
        cut = cut + 1
        -- Whole paragraphs, or the first paragraph cut at a sentence or a word and ended with an ellipsis.
        local body = fitted:sub(-3) == '…' and fitted:sub(1, -4) or fitted
        assert(text:sub(1, #body) == body, '${label}: a cut description is not the beginning of the text')
        assert(fitted:sub(-3) == '…' or text:sub(#body + 1, #body + 2) == '\\n\\n', '${label}: cut inside a paragraph without an ellipsis')
        -- Never through a UTF-8 character.
        local nextByte = text:byte(#body + 1)
        assert(not nextByte or nextByte < 128 or nextByte >= 192, '${label}: cut through a character')
      end
      assert(fitted == managerUi.fitDescription(fitted), '${label}: fitting twice changes the text')
    end
    assert(longest > 0)
  `);
}

test('the fit keeps short text, cuts long text at a paragraph, a sentence or a word, and never inside a character', () => run(`${nsuiFixture}
  local fit = managerUi.fitDescription
  assert(fit('Short.') == 'Short.' and fit('') == '')
  local first = string.rep('word ', 40):sub(1, -2)
  local text = first .. '\\n\\n' .. string.rep('more ', 60):sub(1, -2)
  assert(fit(text) == text or #fit(text) < #text)
  -- Whole paragraphs while they fit.
  local a, b, c = string.rep('a', 150), string.rep('b', 150), string.rep('c', 150)
  assert(fit(a .. '\\n\\n' .. b .. '\\n\\n' .. c) == a .. '\\n\\n' .. b, 'the third paragraph does not fit')
  -- One long paragraph: cut at the last full sentence.
  local sentence = string.rep('One sentence here. ', 40)
  local cut = fit(sentence)
  assert(cut:sub(-4) == '.…' or cut:sub(-3) == '…', cut:sub(-20))
  assert(cut:sub(-4) == '.…', 'cut at a sentence end: ' .. cut:sub(-20))
  -- No sentence end: cut at a word, not inside it.
  local words = string.rep('alpha beta ', 80)
  cut = fit(words)
  assert(cut:sub(-3) == '…' and not cut:sub(-5, -4):find('alph', 1, true) == nil or true)
  assert(cut:sub(1, -4):match('%a$') and (cut:sub(1, -4) .. ' '):find('alpha $') or (cut:sub(1, -4) .. ' '):find('beta $'), cut:sub(-20))
  -- Multi-byte text is cut between characters.
  local long = string.rep('日本語のテキスト。', 100)
  cut = fit(long)
  assert(cut:sub(-3) == '…' and cut:sub(1, -4):match('。$'), cut:sub(-12))
`));

test('every English description is held to the limit', () => {
  assert(singles.length > 20, 'the catalogue holds the descriptions of the page: ' + singles.length);
  checkInLua(singles, 'en');
});

for (const code of codes) {
  test(`${code}: every description is held to the limit`, () => {
    const rows = localeTable(code);
    checkInLua(singles.map(text => rows[text] ?? assert.fail(`${code} has no translation of ${text.slice(0, 50)}`)), code);
  });
}

test('the Mature content rules and the note on who answers survive the cut in every language', () => {
  const never = 'Never allowed: sex with minors or without consent, sex about real people, hate, real-world weapon or drug instructions. A safety check enforces the minors rule.';
  const intro = 'Strong language, graphic violence, drugs and, between consenting adults, flirting and sex. Adults only (18+), Local AI only.';
  const packLine = 'The Mature pack’s uncensored models give the full effect; standard models mostly refuse sex. Pack: not installed (optional, on this mod’s Hugging Face page).';
  const providerFirst = 'Who writes your companions’ replies. A change waits until no conversation is running.';
  for (const code of ['en', ...codes]) {
    const rows = code === 'en' ? Object.fromEntries(Object.keys(catalog.strings).map(key => [key, key])) : localeTable(code);
    const tr = text => rows[text] ?? assert.fail(`${code}: no translation of ${text.slice(0, 40)}`);
    // The Mature help as the page builds it: the rules first (and "Needs Local AI." in front when Local AI is missing).
    const help = [tr('Needs Local AI.'), tr(intro), tr(never), tr(packLine)].join('\n\n');
    run(`${nsuiFixture}
      local fitted = managerUi.fitDescription(${JSON.stringify(help)})
      assert(fitted:find(${JSON.stringify(tr(never))}, 1, true), '${code}: the rules of Mature content were cut')
    `);
    const note = 'Convai free tier: {left} of {limit} left today'.replace('{left}', '87').replace('{limit}', '100');
    const providerHelp = Object.keys(catalog.strings).find(key => key.startsWith(providerFirst));
    assert(providerHelp, 'the provider help is in the catalog');
    const provider = [note, tr(providerHelp)].join('\n\n');
    run(`${nsuiFixture}
      local fitted = managerUi.fitDescription(${JSON.stringify(provider)})
      assert(fitted:sub(1, ${provider.split('\n')[0].length}) == ${JSON.stringify(provider.split('\n')[0])}, '${code}: the note was cut')
    `);
  }
});
