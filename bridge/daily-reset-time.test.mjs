import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';
import {dayOf} from './shared-key-guard.mjs';

// When the shared Convai key's daily turns come back, said in the player's own time: the sign-in backend's reset (its token response's allowance.resetAt,
// the next 00:00 UTC, the instant bridge/shared-key-guard.mjs changes day too) on this computer's clock, "5:30 AM" in English and "05:30" in the other
// languages. mod/ui-locale.lua dailyResetClock works that out when a message is shown (never per frame); the notice, the settings help, the invitation
// failure and the Phone Chat status use it. No text of the shared limit says "tomorrow" any more.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const probe = fileURLToPath(new URL('./daily-reset-time-probe.mjs', import.meta.url));
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
const at = (...parts) => Math.floor(Date.UTC(...parts) / 1000);

// What a clock in `zone` shows at the next UTC midnight after `seconds`, worked out by the JavaScript engine's own zone rules (not by the code under test).
function expected(seconds, zone) {
  const next = (Math.floor(seconds / 86400) + 1) * 86400 * 1000;
  return new Intl.DateTimeFormat('en-US', {timeZone: zone, hour: 'numeric', minute: '2-digit', hour12: true}).format(next).replace(/\s/g, ' ');
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
      assert.equal(row.text, `Today’s 500 Convai turns are used./It resets at ${want}. Try Local AI (unlimited) or Google Gemini (your own key).`, label);
      assert.match(row.direct, /^\d{1,2}:\d\d [AP]M$/);
    });
  }
});

test('known times: 5:30 AM in India and 5:45 AM in Nepal at noon UTC, an hour earlier after US clocks go back', () => {
  const noon = [at(2026, 9, 29, 12, 0, 0)];
  assert.equal(execFileSync(process.execPath, [probe, JSON.stringify(noon), 'Asia/Kolkata'], {encoding: 'utf8'}).includes('"5:30 AM|5:30 AM|'), true);
  assert.equal(execFileSync(process.execPath, [probe, JSON.stringify(noon), 'Asia/Kathmandu'], {encoding: 'utf8'}).includes('"5:45 AM|5:45 AM|'), true);
  // New York: 00:00 UTC is 20:00 in summer time and 19:00 once the clocks went back, the same call a day apart.
  const days = [at(2026, 9, 31, 15, 0, 0), at(2026, 10, 1, 15, 0, 0)];
  const rows = JSON.parse(execFileSync(process.execPath, [probe, JSON.stringify(days), 'America/New_York'], {encoding: 'utf8'}));
  assert.deepEqual(rows.map(row => row.split('|')[0]), ['8:00 PM', '7:00 PM']);
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

test('clockText: English reads a 12-hour clock, every other language the 24-hour one, and anything else comes back unchanged', () => {
  run(`
    local ui = convaiUiLocale
    local cases = {['00:00'] = '12:00 AM', ['00:30'] = '12:30 AM', ['05:30'] = '5:30 AM', ['11:59'] = '11:59 AM', ['12:00'] = '12:00 PM', ['12:45'] = '12:45 PM',
      ['13:05'] = '1:05 PM', ['20:08'] = '8:08 PM', ['23:59'] = '11:59 PM'}
    for from, to in pairs(cases) do assert(ui.clockText(from) == to, from .. ' -> ' .. tostring(ui.clockText(from))) end
    for _, other in ipairs({'soon', '5:30', '05:30 AM', '', 'tomorrow'}) do assert(ui.clockText(other) == other, other) end
    assert(ui.configure('de') and ui.update(10) ~= nil or true)
    assert(ui.current() == 'de', ui.current())
    for from in pairs(cases) do assert(ui.clockText(from) == from, 'German keeps ' .. from) end
    assert(ui.dailyResetClock(0):match('^%d%d:%d%d$'), 'the German reset time is 24-hour')
  `);
});

test('the reset time is the backend\'s own resetAt while it is ahead and within two days, else the next 00:00 UTC; stale or junk values are dropped', () => {
  run(`
    local ui = convaiUiLocale
    local utc = os.date
    os.date = function(format, at) return string.format('%02d:%02d', math.floor(at % 86400 / 3600), math.floor(at % 3600 / 60)) end   -- the clock of a player at UTC, so the expected texts do not depend on this machine
    local noon = 1790000000 - (1790000000 % 86400) + 12 * 3600
    assert(ui.dailyResetClock(noon) == '12:00 AM', 'no backend value: ' .. tostring(ui.dailyResetClock(noon)))
    ui.noteDailyReset(noon + 90 * 60)                    -- the backend says 13:30
    assert(ui.dailyResetClock(noon) == '1:30 PM', ui.dailyResetClock(noon))
    ui.noteDailyReset(noon - 60)                         -- already past: ignored
    assert(ui.dailyResetClock(noon) == '12:00 AM')
    ui.noteDailyReset(noon + 3 * 86400)                  -- more than two days away: ignored
    assert(ui.dailyResetClock(noon) == '12:00 AM')
    for _, bad in ipairs({'soon', false, {}, 0/0, -5, 1e12}) do ui.noteDailyReset(noon + 3600); ui.noteDailyReset(bad); assert(ui.dailyResetClock(noon) == '12:00 AM', tostring(bad)) end
    ui.noteDailyReset(nil)
    os.date = utc
  `);
});

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
    assert(dailyLimitText() == 'Today’s 500 Convai turns are used.\\nTry Local AI (unlimited) or Google Gemini (your own key).')
    limit = nil
    assert(dailyLimitText() == 'Today’s Convai turns are used.\\nTry Local AI (unlimited) or Google Gemini (your own key).')
    -- a limit unknown but a clock readable: the time without a number
    ui.dailyResetClock = function() return '05:30' end
    assert(dailyLimitText() == 'Today’s Convai turns are used.\\nIt resets at 05:30. Try Local AI (unlimited) or Google Gemini (your own key).')
    limit = 500
    assert(dailyLimitText() == 'Today’s 500 Convai turns are used.\\nIt resets at 05:30. Try Local AI (unlimited) or Google Gemini (your own key).')
  `);
});
