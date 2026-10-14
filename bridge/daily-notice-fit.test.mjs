// The daily-limit notice is drawn by the game's warning line (WarningMessageGameController): the text is Rajdhani Semi-Bold at 35 pt,
// UPPER CASE, wrapped at 800 px, in a frame 851 px wide that grows with the text. The frame was drawn for one line (80 px) and holds two
// (about 107 px); the first version of this notice was 263 letters, six lines, about 240 px. Measured from the game's own files
// (warning_message.inkwidget: DangerousArea fontSize 35, wrappingAtPosition 800, letterCase UpperCase; raj-semibold.fnt decompressed):
// ADVANCES below are the upper-case advances of that font at 35 px for the letters the notice texts use. The font has no Cyrillic or
// CJK glyphs (the game falls back to another font there), so those are estimated: 20 px for a Cyrillic capital, 35 px for a full-width
// character. This is an estimate and cannot see the game; it keeps every language to two lines with room for a word that wraps early.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const codes = ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko'];

const GLYPHS = "0123456789 !\"%&'(),-./:;>?ABCDEFGHIJKLMNOPQRSTUVWXYZ~ÁÉÍÓÖÜČŚŠŮŻ–—’";
const ADVANCES = [
  18, 11, 17, 18, 19, 17, 18, 14, 19, 18, 8, 8, 12, 26, 21, 7, 10, 10, 7, 11, 7, 14, 7, 7, 19, 16, 19, 19, 19, 19, 17,
  16, 19, 20, 9, 18, 19, 16, 25, 20, 19, 18, 20, 19, 19, 15, 20, 18, 28, 18, 18, 18, 19, 19, 17, 9, 19, 19, 20, 19, 19,
  19, 20, 18, 14, 21, 6
];
const CAPITAL = 18.7;      // the average capital, for a letter not in the table
const CYRILLIC = 20, FULL_WIDTH = 35;
const WRAP = 800;          // wrappingAtPosition of the text box
const LINES = 2;
const TOTAL_ENGLISH = 1460, TOTAL_TRANSLATION = 1560;   // px of upper-case text in all; English keeps a wider margin (translations run longer)

function advance(char) {
  const code = char.codePointAt(0);
  if (code === 0xa0 || code === 0x202f) return 8;      // a no-break space (thousands separator) is as wide as a space
  if (code >= 0x0400 && code <= 0x04ff) return CYRILLIC;
  if (code >= 0x2e80) return FULL_WIDTH;
  const at = GLYPHS.indexOf(char);
  return at >= 0 ? ADVANCES[at] : CAPITAL;
}
const widthOf = text => [...text].reduce((sum, char) => sum + advance(char), 0);

/** Width of each line the text takes in the frame: words wrap at spaces, a full-width character can end a line anywhere. */
function linesOf(text) {
  const tokens = text.toUpperCase().match(/[⺀-￿]|[^ \t⺀-￿]+|[ \t]+/gu) ?? [];
  const widths = [];
  let used = 0;
  for (const token of tokens) {
    if (/^[ \t]+$/u.test(token)) { if (used > 0) used += widthOf(' '); continue; }
    const width = widthOf(token);
    if (used > 0 && used + width > WRAP) { widths.push(used); used = 0; }
    used += width;
  }
  widths.push(used);
  return widths;
}

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

const init = read('../mod/init.lua');
// The notice has the limit the backend set in it ({limit}, filled in from the settings state) and a line for when that is not known.
const source = /local function dailyLimitText\(\)[\s\S]*?ui\.t\('([^'\n]*)', \{limit = limit\}\)[\s\S]*?return ui\.t\('([^'\n]*)'\)\s*end/.exec(init);
assert(source, 'dailyLimitText moved or no longer wraps these two ui.t strings');
const [, withLimit, withoutLimit] = source;
// Sample limits: the real one is 100 now; a four-digit one must still fit.
const filled = (text, limit) => text.replace('{limit}', String(limit));
const english = filled(withLimit, 100);
const THOUSANDS = /5[\s\u00a0\u202f.,]?000/;
const catalog = JSON.parse(read('../localization/en.json'));
const notices = read('../mod/notices.lua');
const showTable = /M\.showS = \{([^}]*)\}/.exec(notices);
const showS = Number(/\['daily-limit'\] = (\d+)/.exec(showTable?.[1] ?? '')?.[1]);

test('the English daily-limit notice is two lines in the warning frame and tells the player what to do', () => {
  for (const limit of [100, 1500]) {
    const text = filled(withLimit, limit);
    const lines = linesOf(text);
    assert(lines.length <= LINES, `limit ${limit}: ${lines.length} lines: ${lines.map(Math.round)}`);
    assert(widthOf(text.toUpperCase()) <= TOTAL_ENGLISH + (limit > 999 ? 20 : 0), `${Math.round(widthOf(text.toUpperCase()))} px of upper-case text`);
  }
  assert(english.length <= 100, `${english.length} letters`);
  assert.equal(withLimit.split('{limit}').length, 2, 'the limit appears once, as {limit}');
  assert(!/\d/.test(withLimit.replace('{limit}', '')) || /^[^\d]*5,000[^\d]*$/.test(withLimit.replace('{limit}', '')), 'only the 5,000 may be a number');
  assert(/Today’s \{limit\} Convai turns are used\./.test(withLimit), withLimit);
  assert(/Try Mistral \(free key, ~5,000 a day\) or Local AI \(unlimited\)\./.test(withLimit), withLimit);
  assert(!withoutLimit.includes('{') && withoutLimit.startsWith('Today’s Convai turns are used.') && withoutLimit.endsWith(withLimit.split('. ').slice(1).join('. ')), withoutLimit);
  assert(widthOf(withoutLimit.toUpperCase()) <= TOTAL_ENGLISH && linesOf(withoutLimit).length <= LINES, 'the line without a limit fits too');
  for (const word of ['recommend', 'embedded', 'shared', 'antivirus', 'defender', 'paid', 'subscription', 'token']) {
    assert(!english.toLowerCase().includes(word), `${word} in: ${english}`);
  }
});

test('the notice stays long enough to read at 15 letters a second, and only the daily limit stays longer', () => {
  assert(Number.isFinite(showS), 'M.showS["daily-limit"] not found');
  assert(showS >= 8 && showS <= 12, `${showS} s`);
  // the game counts the duration after its 2.7 s intro; the text is readable from about 1.3 s into it
  assert(english.length / 15 <= showS + 1.4, `reading time ${english.length / 15} s`);
  assert.deepEqual([...showTable[1].matchAll(/\['([a-z-]+)'\]/g)].map(match => match[1]), ['daily-limit'], 'another notice got a longer duration');
});

test('every language has the notice, and it fits two lines like the English one', () => {
  assert(catalog.strings[withLimit] && catalog.strings[withoutLimit], 'the notice is missing from localization/en.json');
  const tooLong = [];
  for (const code of codes) {
    const table = localeTable(code);
    for (const [source, hasLimit] of [[withLimit, true], [withoutLimit, false]]) {
      const text = table[source];
      assert(typeof text === 'string' && text.length > 0, `${code}: no translation of ${source.slice(0, 30)}`);
      assert.notEqual(text, source, `${code}: still English`);
      assert(text.includes('Convai') && text.includes('Mistral'), `${code}: product names missing: ${text}`);
      // {limit} survives exactly once (and not at all in the line for an unknown limit); the 5,000 is there, in the language's own format
      assert.equal(text.split('{limit}').length - 1, hasLimit ? 1 : 0, `${code}: {limit} count: ${text}`);
      const rest = text.replace('{limit}', '');
      assert(THOUSANDS.test(rest), `${code}: the 5,000 a day is missing or not a number: ${text}`);
      assert(!/[{}]/.test(rest) && !/\d/.test(rest.replace(THOUSANDS, '')), `${code}: a stray placeholder or number: ${text}`);
      assert.equal(text, text.trim(), `${code}: stray space`);
      for (const limit of hasLimit ? [100, 1500] : [0]) {
        const shown = hasLimit ? filled(text, limit) : text;
        const lines = linesOf(shown);
        const total = widthOf(shown.toUpperCase());
        if (lines.length > LINES) tooLong.push(`${code}: ${lines.length} lines (${lines.map(Math.round)}): ${shown}`);
        if (total > TOTAL_TRANSLATION + (limit > 999 ? 20 : 0)) tooLong.push(`${code}: ${Math.round(total)} px of upper-case text: ${shown}`);
      }
    }
  }
  assert.deepEqual(tooLong, [], 'texts that do not fit two lines');
});

test('Phone Chat keeps the long version, which has room, and both are in the catalogue', () => {
  const phone = read('../mod/phone-chat.lua');
  const long = /local DAILY_LIMIT_STATUS = '([^'\n]*)'/.exec(phone);
  assert(long && long[1].length > 200, 'Phone Chat lost its long daily-limit status');
  assert(catalog.strings[long[1]], 'the long text is no longer in the catalogue');
  for (const code of codes) assert(localeTable(code)[long[1]], `${code}: the long Phone Chat text lost its translation`);
});
