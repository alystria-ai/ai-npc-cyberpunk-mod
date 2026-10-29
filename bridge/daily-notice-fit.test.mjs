// The daily-limit notice is drawn by the game's warning line (WarningMessageGameController): the text is Rajdhani Semi-Bold at 35 pt,
// UPPER CASE, wrapped at 800 px, in a frame 851 px wide that grows with the text. The frame was drawn for one line (80 px) and holds two
// (about 107 px); the first version of this notice was 263 letters, six lines, about 240 px. Measured from the game's own files
// (warning_message.inkwidget: DangerousArea fontSize 35, wrappingAtPosition 800, letterCase UpperCase; raj-semibold.fnt decompressed).
// The measure itself (the upper-case advances at 35 px, 20 px for a Cyrillic capital, 35 px for a full-width character) is in
// bridge/notice-fit.mjs. It is an estimate and cannot see the game; it keeps every language to two lines with room for a word that wraps early.
// The text carries a forced break ("\n"): the first sentence ("Today's {limit} Convai turns are used.") is line 1 and must fit ONE
// line; the detailed choice (Try Mistral, free key, about 5,000 a day, or Local AI, unlimited) starts on a fresh line and may wrap
// to a second, so the whole notice is at most three rendered lines (a third line makes the frame a taller block, about 140 px,
// but it is shown for 9 s after the frame opens, and the reading-time test below still holds for its roughly 100 letters). The warning
// text is an ordinary ink text and breaks at "\n" (the mod's loading notice already joins its lines with it).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {widthOf, linesOf} from './notice-fit.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const codes = ['zh-cn', 'zh-tw', 'es', 'pt-br', 'fr', 'de', 'it', 'pl', 'cs', 'hu', 'tr', 'ru', 'uk', 'ja', 'ko'];

const FORCED = 2;          // the forced break gives two parts: line 1 and the detailed sentence
const MAX_LINES = 3;       // rendered lines in all: line 1 on one line, the sentence on at most two
// px of upper-case text on line 1, which must stay ONE line; English keeps a wider margin (translations run longer).
const LINE_ENGLISH = 770, LINE_TRANSLATION = 785;
// px of upper-case text for the detailed sentence, which may wrap to a second line: at most two wrap widths less room for a word that wraps early
const DETAIL_MAX = 1460;


/** The text's forced lines (split at "\n"), each with its width and the number of lines it takes in the frame on its own. */
function forcedLines(text) {
  return text.split('\n').map(line => ({line, px: widthOf(line.toUpperCase()), wrapped: linesOf(line).length}));
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
// The source text is Lua: the "\n" in it is the two characters backslash and n, which Lua turns into a line break.
const [withLimit, withoutLimit] = [source[1], source[2]].map(text => text.replaceAll('\\n', '\n'));
// Sample limits: the real one is 100 now; a four-digit one must still fit.
const filled = (text, limit) => text.replace('{limit}', String(limit));
const english = filled(withLimit, 100);
const THOUSANDS = /5[\s\u00a0\u202f.,]?000/;
const catalog = JSON.parse(read('../localization/en.json'));
const notices = read('../mod/notices.lua');
const showTable = /M\.showS = \{([^}]*)\}/.exec(notices);
const showS = Number(/\['daily-limit'\] = (\d+)/.exec(showTable?.[1] ?? '')?.[1]);

/** Whether the parts of a notice fit: line 1 on one line (at most `lineMax` px), the detail within two lines, three lines in all. Returns problems. */
function problems(text, lineMax) {
  const [first, detail, ...extra] = forcedLines(text);
  const found = [];
  if (extra.length || !detail) return [`needs exactly one line break: ${JSON.stringify(text)}`];
  if (first.wrapped !== 1) found.push(`line 1 wraps (${Math.round(first.px)} px): ${first.line}`);
  else if (first.px > lineMax) found.push(`line 1 is ${Math.round(first.px)} px of upper-case text, more than ${lineMax}: ${first.line}`);
  if (detail.px > DETAIL_MAX || detail.wrapped > 2) found.push(`line 2 takes ${detail.wrapped} lines (${Math.round(detail.px)} px): ${detail.line}`);
  if (first.wrapped + detail.wrapped > MAX_LINES) found.push(`${first.wrapped + detail.wrapped} lines in all: ${text}`);
  return found;
}

test('the English daily-limit notice is line 1 on one line plus a detailed line 2 starting fresh, at most three lines, and tells the player what to do', () => {
  assert.equal(withLimit.split('\n').length, FORCED, 'one forced break');
  assert.equal(withoutLimit.split('\n').length, FORCED, 'one forced break');
  for (const limit of [100, 1500]) {
    const shown = forcedLines(filled(withLimit, limit));
    assert.equal(shown.length, FORCED);
    assert.equal(shown[0].line, `Today’s ${limit} Convai turns are used.`);
    assert.equal(shown[1].line, 'Try Mistral (free key, ~5,000 a day) or Local AI (unlimited).');
    assert.deepEqual(problems(filled(withLimit, limit), LINE_ENGLISH), []);
    assert(shown[0].wrapped + shown[1].wrapped <= MAX_LINES, `${shown[0].wrapped + shown[1].wrapped} lines`);
  }
  assert(english.length <= 100, `${english.length} letters`);
  assert.equal(withLimit.split('{limit}').length, 2, 'the limit appears once, as {limit}');
  assert(!/\d/.test(withLimit.replace('{limit}', '')) || /^[^\d]*5,000[^\d]*$/.test(withLimit.replace('{limit}', '')), 'only the 5,000 may be a number');
  assert(/^Today’s \{limit\} Convai turns are used\.\nTry Mistral \(free key, ~5,000 a day\) or Local AI \(unlimited\)\.$/.test(withLimit), withLimit);
  assert(withLimit.indexOf('Local AI (unlimited)') > withLimit.indexOf('Mistral'), '"unlimited" stays beside Local AI');
  assert(!withoutLimit.includes('{') && withoutLimit.startsWith('Today’s Convai turns are used.\n') && withoutLimit.endsWith(withLimit.split('\n')[1]), withoutLimit);
  assert.deepEqual(problems(withoutLimit, LINE_ENGLISH), [], 'the line without a limit fits too');
  for (const word of ['recommend', 'embedded', 'shared', 'antivirus', 'defender', 'paid', 'subscription', 'token']) {
    assert(!english.toLowerCase().includes(word), `${word} in: ${english}`);
  }
});

test('the notice stays long enough to read at 15 letters a second, and only the daily limit and the setup problem stay longer', () => {
  assert(Number.isFinite(showS), 'M.showS["daily-limit"] not found');
  assert(showS >= 8 && showS <= 12, `${showS} s`);
  // the game counts the duration after its 2.7 s intro; the text is readable from about 1.3 s into it
  assert(english.length / 15 <= showS + 1.4, `reading time ${english.length / 15} s`);
  // The setup problem's notice (mod/setup-check.lua) is the other one: it is written to the warning line without this mod's scripts.
  assert.deepEqual([...showTable[1].matchAll(/\['([a-z-]+)'\]/g)].map(match => match[1]), ['daily-limit', 'setup-problem'], 'another notice got a longer duration');
});

test('every language has the notice with the same forced break: line 1 fits one line, the whole notice three lines', () => {
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
      // the same forced break as the English: line 1 on one line, the full Mistral / Local AI sentence (with "free") starting line 2, three lines at most
      assert.equal(text.split('\n').length, FORCED, `${code}: needs exactly one line break: ${JSON.stringify(text)}`);
      assert(text.split('\n')[1].includes('Mistral') && !text.split('\n')[0].includes('Mistral'), `${code}: the choice belongs on line 2: ${JSON.stringify(text)}`);
      for (const limit of hasLimit ? [100, 1500] : [0]) {
        for (const found of problems(hasLimit ? filled(text, limit) : text, LINE_TRANSLATION)) tooLong.push(`${code}: ${found}`);
      }
    }
  }
  assert.deepEqual(tooLong, [], 'notices that do not fit line 1 on one line and the rest in three lines');
});

test('Phone Chat keeps the long version, which has room, and both are in the catalogue', () => {
  const phone = read('../mod/phone-chat.lua');
  const long = /local DAILY_LIMIT_STATUS = '([^'\n]*)'/.exec(phone);
  assert(long && long[1].length > 200, 'Phone Chat lost its long daily-limit status');
  assert(catalog.strings[long[1]], 'the long text is no longer in the catalogue');
  for (const code of codes) assert(localeTable(code)[long[1]], `${code}: the long Phone Chat text lost its translation`);
});

// With the clock readable the notice also says when the turns come back, in the player's time (mod/ui-locale.lua dailyResetClock, "HH:MM" like the custom
// provider's): the sentence starts line 2, which is allowed two rendered lines, so the notice is still at most three lines. The two texts above stay as the
// wording for a clock that cannot be read.
const timed = /return ui\.t\('([^'\n]*)', \{limit = limit, time = at\}\)[\s\S]*?return ui\.t\('([^'\n]*)', \{time = at\}\)/.exec(init);
assert(timed, 'dailyLimitText no longer wraps the two strings with a reset time');
const [timedWithLimit, timedWithoutLimit] = [timed[1], timed[2]].map(text => text.replaceAll('\\n', '\n'));
const withTime = (text, limit, time) => text.replace('{limit}', String(limit)).replace('{time}', time);
// The widest clock texts: a four-digit limit and the digits 00:00 / 23:59 (the digit widths differ a little).
const SAMPLES = [[100, '05:30'], [1500, '23:59'], [500, '00:00'], [500, '20:08']];

test('the English notice with a reset time keeps line 1 on one line and fits three lines in all', () => {
  assert.equal(timedWithLimit, 'Today’s {limit} Convai turns are used.\nIt resets at {time}. Try Mistral (free key, ~5,000 a day) or Local AI (unlimited).');
  assert.equal(timedWithoutLimit, 'Today’s Convai turns are used.\nIt resets at {time}. Try Mistral (free key, ~5,000 a day) or Local AI (unlimited).');
  for (const [limit, time] of SAMPLES) {
    for (const text of [withTime(timedWithLimit, limit, time), withTime(timedWithoutLimit, limit, time)]) {
      assert.deepEqual(problems(text, LINE_ENGLISH), [], text);
      assert(text.length / 15 <= showS + 1.4, `reading time ${text.length / 15} s: ${text}`);
    }
  }
  assert(catalog.strings[timedWithLimit] && catalog.strings[timedWithoutLimit], 'the timed notice is missing from localization/en.json');
});

test('every language has the notice with a reset time: both placeholders once, the same line 1 as before, the choice on line 2, and it fits', () => {
  const tooLong = [];
  for (const code of codes) {
    const table = localeTable(code);
    for (const [source, plain, hasLimit] of [[timedWithLimit, withLimit, true], [timedWithoutLimit, withoutLimit, false]]) {
      const text = table[source];
      assert(typeof text === 'string' && text.length > 0, `${code}: no translation of ${source.slice(0, 40)}`);
      assert.notEqual(text, source, `${code}: still English`);
      assert.equal(text.split('{time}').length - 1, 1, `${code}: {time} count: ${text}`);
      assert.equal(text.split('{limit}').length - 1, hasLimit ? 1 : 0, `${code}: {limit} count: ${text}`);
      const rest = text.replace('{limit}', '').replace('{time}', '');
      assert(THOUSANDS.test(rest) && !/[{}]/.test(rest) && !/\d/.test(rest.replace(THOUSANDS, '')), `${code}: a stray placeholder or number: ${text}`);
      assert(!rest.includes(';') && text === text.trim(), `${code}: a semicolon or stray space: ${text}`);
      const lines = text.split('\n');
      assert.equal(lines.length, FORCED, `${code}: needs exactly one line break: ${JSON.stringify(text)}`);
      assert(lines[1].includes('Mistral') && !lines[0].includes('Mistral'), `${code}: the choice belongs on line 2: ${JSON.stringify(text)}`);
      assert.equal(lines[0], table[plain].split('\n')[0], `${code}: line 1 changed from the notice without a time`);
      assert(lines[1].indexOf('{time}') < lines[1].indexOf('Mistral'), `${code}: the time comes before the choice: ${text}`);
      for (const [limit, time] of SAMPLES) for (const found of problems(withTime(text, limit, time), LINE_TRANSLATION)) tooLong.push(`${code}: ${found}`);
    }
  }
  assert.deepEqual(tooLong, [], 'notices with a reset time that do not fit line 1 on one line and the rest in three lines');
});

test('the settings help, the invitation failure and the Phone Chat status have a reset-time version in every language', () => {
  const sources = [
    'You have used today’s {limit} turns, which come back at {time}. To keep talking now, choose Mistral (with your free key, about 5,000 turns a day) or Local AI (unlimited).',
    'The Convai daily limit is used up. It resets at {time}. Choose another provider in Settings, or invite again then.',
    read('../mod/phone-chat.lua').match(/local DAILY_LIMIT_STATUS_AT = '([^'\n]*)'/)?.[1],
  ];
  for (const source of sources) {
    assert(source && catalog.strings[source], `not in localization/en.json: ${source}`);
    for (const code of codes) {
      const text = localeTable(code)[source];
      assert(typeof text === 'string' && text !== source, `${code}: not translated: ${source.slice(0, 40)}`);
      assert.equal(text.split('{time}').length - 1, 1, `${code}: {time} count: ${text}`);
      assert.equal(text.split('{limit}').length - 1, source.includes('{limit}') ? 1 : 0, `${code}: {limit} count: ${text}`);
      assert(!text.includes(';'), `${code}: a semicolon: ${text}`);
    }
  }
});
