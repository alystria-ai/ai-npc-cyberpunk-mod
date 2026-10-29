// Run by daily-reset-time.test.mjs in a child process with TZ set (a process reads its time zone once, at start): prints, as JSON (argv: instants, zone), what the game's Lua
// shows as the reset time of the shared Convai key's daily limit for each given instant (epoch seconds), read from the real mod/ui-locale.lua and the
// real dailyLimitText in mod/init.lua. Nothing here touches a network, a game or the real clock: os.time is replaced by the given instant.
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
const start = init.indexOf('local function dailyLimitText'), end = init.indexOf('local function keyNoticeText');
if (start < 0 || end < start) throw new Error('dailyLimitText moved');

// The zone is set here, before any date is read: a TZ given to a Windows child process by its parent is not always honoured, assigning it inside is.
process.env.TZ = process.argv[3];
const instants = JSON.parse(process.argv[2]);
const state = lauxlib.luaL_newstate();
lualib.luaL_openlibs(state);
const code = `
  local ui = convaiUiLocale
  local manager = {ownKey = function() return {daily = {limit = 500, left = 0, blocked = true}} end}
  ${init.slice(start, end)}
  local realTime = os.time
  local results = {}
  for _, now in ipairs(INSTANTS) do
    local direct = ui.dailyResetClock(now)
    os.time = function() return now end
    local viaClock = ui.dailyResetClock()
    local text = dailyLimitText()
    os.time = realTime
    results[#results + 1] = (direct or 'nil') .. '|' .. (viaClock or 'nil') .. '|' .. text:gsub('\\n', '/')
  end
  return table.concat(results, '\\n')
`;
const header = `INSTANTS = {${instants.join(',')}}\n`;
const status = lauxlib.luaL_dostring(state, to_luastring(uiLocaleBootstrap + header + code));
if (status !== lua.LUA_OK) { console.error(to_jsstring(lua.lua_tostring(state, -1))); process.exit(1); }
console.log(JSON.stringify(to_jsstring(lua.lua_tostring(state, -1)).split('\n')));
