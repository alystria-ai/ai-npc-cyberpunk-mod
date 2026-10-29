// mod/player-guard.lua: the one getter for V (error report aa500cce: another CET mod replaced Game.GetPlayer with a table, and every
// frame of this mod raised "attempt to call field 'GetPlayer' (a table value)").
//   * the original function: called as it always was, nothing logged;
//   * a table without __call, a nil, a number: the captured original answers, or Game.GetPlayerSystem when none was captured;
//   * a table with __call: it is called;
//   * the line about it goes out once per session, in words that are not a Lua error, and never a popup;
//   * every module asks through it (no Game.GetPlayer() call is left in mod/*.lua except the Developer-only diagnostics.lua).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import fengari from 'fengari';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const modDir = new URL('../mod/', import.meta.url);
const read = name => readFileSync(new URL(name, modDir), 'utf8').replace(/\r\n/g, '\n');
const guardSource = read('player-guard.lua');
const FALLBACK = 'local convaiPlayer = convaiPlayer or function() return Game.GetPlayer() end';

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

// A fake Game, a log that records what convaiLogOnce was given, and a guard loaded the way init.lua loads it.
// `original` is what Game.GetPlayer is when the guard loads ('function', 'table' or 'none'); hasSystem says whether
// Game.GetPlayerSystem exists.
const fixture = (original = 'function', hasSystem = true) => `
  local calls = {original = 0, system = 0}
  local V, systemV = {name = 'V'}, {name = 'V from the system'}
  local lines = {}
  Game = {}
  if '${original}' == 'function' then Game.GetPlayer = function() calls.original = calls.original + 1; return V end
  elseif '${original}' == 'table' then Game.GetPlayer = {} end
  if ${hasSystem} then
    Game.GetPlayerSystem = function()
      calls.system = calls.system + 1
      return {GetLocalPlayerMainGameObject = function() return systemV end}
    end
  end
  convaiLogOnce = function(key, line) lines[#lines + 1] = key .. ' | ' .. line; return true end
  local guard = (function() ${guardSource} end)()
  local get = guard.get
`;

test('the original function is called as it always was, with nothing logged', () => run(`${fixture()}
  assert(get() == V and get() == V)
  assert(calls.original == 2 and calls.system == 0)
  assert(#lines == 0 and guard.mode() == nil)
`));

test('a stub that replaces a working function with another function is simply called', () => run(`${fixture()}
  local other = {name = 'other'}
  Game.GetPlayer = function() return other end
  assert(get() == other and get() == other)
  assert(calls.original == 0 and #lines == 0 and guard.mode() == 'call')
`));

test('a table without __call: the captured original answers, one line, no popup', () => run(`${fixture()}
  Game.GetPlayer = setmetatable({}, {__index = function() return 'x' end})
  for _ = 1, 50 do assert(get() == V) end
  assert(calls.original == 50 and calls.system == 0, 'the original answers, the system is not asked')
  assert(#lines == 1, 'one line for fifty calls, got ' .. #lines)
  assert(lines[1]:find('player-getter-replaced', 1, true) and lines[1]:find('Another mod replaced Game.GetPlayer', 1, true))
  assert(lines[1]:find('a table now', 1, true) and lines[1]:find('the original function', 1, true))
  assert(not lines[1]:lower():find('error') and not lines[1]:find('%.lua:%d+'), 'not shaped like a Lua error, so no error report')
  assert(guard.mode() == 'original')
`));

test('a plain table, a number and a string are all worked around', () => run(`${fixture()}
  for _, broken in ipairs({{}, 42, 'GetPlayer'}) do
    Game.GetPlayer = broken
    assert(get() == V, type(broken))
  end
  assert(calls.original == 3)
`));

test('a table with __call is called', () => run(`${fixture()}
  local seen = 0
  Game.GetPlayer = setmetatable({}, {__call = function() seen = seen + 1; return systemV end})
  assert(get() == systemV and get() == systemV)
  assert(seen == 2 and calls.original == 0 and #lines == 0 and guard.mode() == 'call')
`));

test('a __call that is not a function does not count as callable', () => run(`${fixture()}
  Game.GetPlayer = setmetatable({}, {__call = 5})
  assert(get() == V and #lines == 1)
`));

test('nil: the captured original answers, and the line says nil', () => run(`${fixture()}
  Game.GetPlayer = nil
  assert(get() == V and get() == V)
  assert(#lines == 1 and lines[1]:find('it is nil now', 1, true))
`));

test('no original captured (already replaced when the guard loaded): Game.GetPlayerSystem answers', () => run(`${fixture('table')}
  assert(get() == systemV and get() == systemV)
  assert(calls.system == 2 and calls.original == 0)
  assert(#lines == 1 and lines[1]:find('Game.GetPlayerSystem', 1, true), lines[1])
  assert(guard.mode() == 'system')
`));

test('no original and no Game.GetPlayer at all: the system answers', () => run(`${fixture('none')}
  assert(get() == systemV)
  assert(#lines == 1 and lines[1]:find('it is nil now', 1, true))
`));

test('nothing can answer: nil, and a second line says so once', () => run(`${fixture('table', false)}
  for _ = 1, 20 do assert(get() == nil) end
  assert(#lines == 2, 'two lines in all, got ' .. #lines)
  assert(lines[2]:find('player-getter-lost', 1, true) and lines[2]:find('not available', 1, true))
`));

test('the system answering nil (no player yet) is not a failure and logs nothing more', () => run(`${fixture('table')}
  Game.GetPlayerSystem = function() return {GetLocalPlayerMainGameObject = function() return nil end} end
  assert(get() == nil and get() == nil)
  assert(#lines == 1)
`));

test('a line due before convaiLogOnce exists waits for it, and is then said once', () => run(`${fixture()}
  local late = convaiLogOnce
  convaiLogOnce = nil
  Game.GetPlayer = {}
  assert(get() == V and #lines == 0)
  convaiLogOnce = late
  assert(get() == V and #lines == 1)
  for _ = 1, 10 do get() end
  assert(#lines == 1)
`));

test('the value coming back to the original, and going wrong again, says nothing more', () => run(`${fixture()}
  local original = Game.GetPlayer
  Game.GetPlayer = {}
  assert(get() == V and #lines == 1)
  Game.GetPlayer = original
  assert(get() == V and calls.original == 2)
  Game.GetPlayer = nil
  assert(get() == V and #lines == 1, 'still one line for the session')
`));

test('the ordinary frame makes no type() call, no pcall and builds no table: one compare and the call', () => {
  const body = /function M\.get\(\)([\s\S]*?)\nend/.exec(guardSource)[1];
  assert.doesNotMatch(body, /type\(|pcall|\{|function\(/, body);
  assert.match(body, /value == original then return value\(\)/);
});

test('the fast path costs what the plain call did (same order of magnitude over 200,000 calls)', () => run(`${fixture()}
  local function plain() return Game.GetPlayer() end
  local started = os.clock()
  for _ = 1, 200000 do plain() end
  local base = os.clock() - started
  started = os.clock()
  for _ = 1, 200000 do get() end
  local guarded = os.clock() - started
  -- One more compare and one more call than the plain form: well under three times it, and no pcall.
  assert(guarded < math.max(base * 3, 1.0), 'guarded ' .. guarded .. ' s against plain ' .. base .. ' s')
`));

test('init.lua loads the guard before any module asks for V, and falls back to the plain call without it', () => {
  const init = read('init.lua');
  const at = init.indexOf("pcall(dofile, 'player-guard.lua')");
  // After the native io shim and the perf probe (the shim must come before anything that opens a file), before every other module.
  assert.ok(at > init.indexOf("dofile('perf-probe.lua')") && at < init.indexOf("pcall(dofile, 'addons.lua')"), 'loaded before any module');
  assert.ok(init.includes('convaiPlayer = convaiPlayerGuard and convaiPlayerGuard.get or function() return Game.GetPlayer() end'));
});

test('no mod file calls Game.GetPlayer() any more, except the Developer-only diagnostics.lua and comments', () => {
  const left = [];
  for (const name of readdirSync(modDir).filter(n => n.endsWith('.lua') && n !== 'diagnostics.lua' && n !== 'player-guard.lua')) {
    read(name).split('\n').forEach((line, index) => {
      const comment = line.indexOf('--');
      const code = comment < 0 ? line : line.slice(0, comment);
      if (/Game\.GetPlayer\b/.test(code) && code !== FALLBACK && !code.includes('convaiPlayerGuard and')) left.push(`${name}:${index + 1}`);
    });
  }
  assert.deepEqual(left, []);
});

test('a module that asks through convaiPlayer carries the one-line fallback first, so it works without init.lua', () => {
  const missing = [];
  for (const name of readdirSync(modDir).filter(n => n.endsWith('.lua') && !['diagnostics.lua', 'player-guard.lua', 'init.lua'].includes(n))) {
    const text = read(name);
    if (/\bconvaiPlayer\b/.test(text) && text.split('\n')[0] !== FALLBACK) missing.push(name);
  }
  assert.deepEqual(missing, []);
});
