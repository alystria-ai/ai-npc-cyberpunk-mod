import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';
import {dayOf} from './shared-key-guard.mjs';

// When the shared Convai key's daily turns come back, said in the player's own time: the next 00:00 UTC (the instant bridge/shared-key-guard.mjs and
// the sign-in backend change day), as "HH:MM" on this computer's clock like the custom provider's reset time. mod/ui-locale.lua dailyResetClock works
// that out when a message is shown (never per frame); the notice, the settings help, the invitation failure and the Phone Chat status use it.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const probe = fileURLToPath(new URL('./daily-reset-time-probe.mjs', import.meta.url));
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const at = (...parts) => Math.floor(Date.UTC(...parts) / 1000);

// What a clock in `zone` shows at the next UTC midnight after `seconds`, worked out by the JavaScript engine's own zone rules (not by the code under test).
function expected(seconds, zone) {
  const next = (Math.floor(seconds / 86400) + 1) * 86400 * 1000;
  return new Intl.DateTimeFormat('en-GB', {timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(next);
}

// Zones around the world, half-hour and 45-minute ones, a half-hour DST one (Lord Howe), the day before and after clocks change, midnight itself, and a leap day.
const ZONES = ['UTC', 'Asia/Kolkata', 'America/New_York', 'America/Los_Angeles', 'America/St_Johns', 'Asia/Kathmandu', 'Australia/Lord_Howe',
  'Pacific/Chatham', 'Pacific/Auckland', 'Pacific/Kiritimati', 'Pacific/Pago_Pago', 'Europe/London', 'Europe/Berlin', 'Asia/Tokyo'];
const INSTANTS = [
  at(2026, 9, 29, 12, 0, 0),    // an ordinary noon UTC
  at(2026, 9, 29, 0, 0, 0),     // exactly 00:00 UTC: the next reset is a whole day away, not now
  at(2026, 9, 29, 23, 59, 59),  // one second before it
  at(2026, 9, 31, 15, 0, 0),    // the evening before US clocks go back
  at(2026, 10, 1, 3, 0, 0),     // just after they did
  at(2026, 2, 8, 12, 0, 0),     // US clocks go forward
  at(2026, 2, 28, 12, 0, 0),    // the day before European clocks go forward
  at(2026, 3, 4, 12, 0, 0),     // Lord Howe and New Zealand clocks go back around here
  at(2026, 8, 26, 12, 0, 0),    // New Zealand clocks go forward around here
  at(2028, 1, 28, 23, 0, 0),    // a leap day follows
  at(2026, 11, 31, 20, 0, 0),   // the end of the year
];

function shown(zone) {
  const output = execFileSync(process.execPath, [probe, JSON.stringify(INSTANTS), zone], {encoding: 'utf8'});
  return JSON.parse(output).map(line => { const [direct, viaClock, ...text] = line.split('|'); return {direct, viaClock, text: text.join('|')}; });
}

test('the reset time is the next 00:00 UTC on this computer\'s clock in every time zone, half-hour ones and DST days included', () => {
  for (const zone of ZONES) {
    const rows = shown(zone);
    assert.equal(rows.length, INSTANTS.length);
    rows.forEach((row, index) => {
      const want = expected(INSTANTS[index], zone), label = `${zone} at ${new Date(INSTANTS[index] * 1000).toISOString()}`;
      assert.equal(row.direct, want, `${label}: given a time`);
      assert.equal(row.viaClock, want, `${label}: from the real clock (os.time)`);
      // The notice carries the same time, filled in once, in the form the custom provider uses.
      assert.equal(row.text, `Today’s 500 Convai turns are used./It resets at ${want}. Try Mistral (free key, ~5,000 a day) or Local AI (unlimited).`, label);
      assert.match(row.direct, /^\d\d:\d\d$/);
    });
  }
});

test('known times: 5:30 in India and 05:45 in Nepal at noon UTC, an hour earlier after US clocks go back', () => {
  const noon = [at(2026, 9, 29, 12, 0, 0)];
  assert.equal(execFileSync(process.execPath, [probe, JSON.stringify(noon), 'Asia/Kolkata'], {encoding: 'utf8'}).includes('"05:30|05:30|'), true);
  assert.equal(execFileSync(process.execPath, [probe, JSON.stringify(noon), 'Asia/Kathmandu'], {encoding: 'utf8'}).includes('"05:45|05:45|'), true);
  // New York: 00:00 UTC is 20:00 in summer time and 19:00 once the clocks went back, the same call a day apart.
  const days = [at(2026, 9, 31, 15, 0, 0), at(2026, 10, 1, 15, 0, 0)];
  const rows = JSON.parse(execFileSync(process.execPath, [probe, JSON.stringify(days), 'America/New_York'], {encoding: 'utf8'}));
  assert.deepEqual(rows.map(row => row.split('|')[0]), ['20:00', '19:00']);
});

test('the reset instant is the one the guard\'s day changes at', () => {
  // 00:00 UTC is the start of the day dayOf names next, in the same instant that is shown as the reset time.
  for (const now of INSTANTS) {
    const next = (Math.floor(now / 86400) + 1) * 86400 * 1000;
    assert.notEqual(dayOf(next), dayOf(now * 1000), 'the reset starts a new counted day');
    assert.equal(dayOf(next - 1), dayOf(now * 1000), 'and nothing before it does');
  }
});

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(uiLocaleBootstrap + code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

test('an unreadable clock gives no time, and every message then keeps its wording without one', () => {
  const init = read('../mod/init.lua');
  const start = init.indexOf('local function dailyLimitText'), end = init.indexOf('local function keyNoticeText');
  assert(start > 0 && end > start);
  run(`
    local ui = convaiUiLocale
    for _, bad in ipairs({-1, 0/0, math.huge, 1e12, 'x', false, {}}) do assert(ui.dailyResetClock(bad) == nil, tostring(bad)) end
    assert(ui.dailyResetClock(0) ~= nil)
    local realTime, realDate = os.time, os.date
    -- os.time failing, or answering nothing usable, or os.date failing: no time (a pcall inside, never an error to the caller)
    os.time = function() error('no clock') end; assert(ui.dailyResetClock() == nil)
    os.time = function() return nil end; assert(ui.dailyResetClock() == nil)
    os.time = realTime
    os.date = function() error('no date') end; assert(ui.dailyResetClock(100000) == nil)
    os.date = function() return 'soon' end; assert(ui.dailyResetClock(100000) == nil)
    os.date = realDate
    -- the notice without a readable clock is the earlier sentence, with and without the limit
    local limit = 500
    local manager = {ownKey = function() return {daily = {limit = limit}} end}
    local ui = {t = convaiUiLocale.t, dailyResetClock = function() return nil end}
    ${init.slice(start, end)}
    assert(dailyLimitText() == 'Today’s 500 Convai turns are used.\\nTry Mistral (free key, ~5,000 a day) or Local AI (unlimited).')
    limit = nil
    assert(dailyLimitText() == 'Today’s Convai turns are used.\\nTry Mistral (free key, ~5,000 a day) or Local AI (unlimited).')
    -- a limit unknown but a clock readable: the time without a number
    ui.dailyResetClock = function() return '05:30' end
    assert(dailyLimitText() == 'Today’s Convai turns are used.\\nIt resets at 05:30. Try Mistral (free key, ~5,000 a day) or Local AI (unlimited).')
    limit = 500
    assert(dailyLimitText() == 'Today’s 500 Convai turns are used.\\nIt resets at 05:30. Try Mistral (free key, ~5,000 a day) or Local AI (unlimited).')
  `);
});
