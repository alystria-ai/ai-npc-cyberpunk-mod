// The game side of the automatic error reports (mod/error-reports.lua, docs/ERROR_REPORTS.md) in fengari, with a real JSON encoder and an
// in-memory file system (bridge/addon-lua-harness.mjs): what it writes is read back by the service's own parser (bridge/error-events.mjs).
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {LUA_HARNESS} from './addon-lua-harness.mjs';
import {parseGameEvents} from './error-events.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/error-reports.lua', import.meta.url), 'utf8');
const NOTICE = 'Error reports go to the developer automatically. Turn them off in Settings > Privacy.';

/** Runs `body` with M = mod/error-reports.lua configured with a fake settings domain; returns the string the body returns, if any. */
function run(body) {
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  try {
    const program = `${LUA_HARNESS}
convaiUiLocale = {version = 1, t = function(text) return 'T:' .. text end}
setting, noticed, marks = true, false, 0
local domain = {errorReports = function() return setting end,
  errorReportsNoticeDue = function() return setting and not noticed end,
  markErrorReportsNoticed = function() noticed, marks = true, marks + 1; return true end}
local M = (function() ${source} end)()
M.configure(domain)
local function file() return files['runtime/error-events.json'] end
${body}`;
    const status = lauxlib.luaL_dostring(L, to_luastring(program));
    const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1));
    assert.equal(status, lua.LUA_OK, error);
    return lua.lua_gettop(L) > 0 && lua.lua_type(L, -1) === lua.LUA_TSTRING ? to_jsstring(lua.lua_tostring(L, -1)) : undefined;
  } finally { lua.lua_close(L); }
}

test('an event is written once per kind and code, as JSON the service reads, and nothing while the setting is off', () => {
  const text = run(`
    assert(M.record('service-silent', 'service-silent', 'service-silent after service-starting at preparing', 'service') == true)
    assert(M.record('service-silent', 'service-silent', 'again') == false, 'once per kind and code')
    assert(M.record('service-failed', 'install-incomplete', 'install-incomplete: ENOENT: x.mjs', 'service') == true)
    assert(M.record('Bad Kind', 'x') == false and M.record('service-failed', '') == false)
    return file()`);
  const parsed = parseGameEvents(text);
  assert.deepEqual(parsed.events.map(row => [row.kind, row.message, row.frame]),
    [['service-silent', 'service-silent', 'service'], ['service-failed', 'install-incomplete', 'service']]);
  assert.equal(parsed.events[0].detail.detail, 'service-silent after service-starting at preparing');
  assert.ok(parsed.events.every(row => Number.isFinite(row.at)));
  assert.equal(run(`setting = false
    assert(M.record('service-silent', 'service-silent') == false)
    return tostring(file())`), 'nil');
});

test('at most ten events a session; a week-old event is dropped from the file, newer ones are kept', () => {
  const text = run(`
    files['runtime/error-events.json'] = json.encode({version = 1, events = {
      {kind = 'service-failed', code = 'old', at = (now - 8 * 24 * 3600) * 1000.0},
      {kind = 'service-failed', code = 'recent', at = (now - 3600) * 1000.0}}})
    for index = 1, 14 do M.record('setup-problem', 'problem ' .. index) end
    assert(M.inspect().count == 10)
    return file()`);
  const parsed = parseGameEvents(text);
  assert.equal(parsed.events.length, 10);
  assert.ok(!parsed.events.some(row => row.message === 'old'));
  assert.equal(parsed.events.at(-1).message, 'problem 10');
});

test('the first-load setup check gives the versions and check lines, and an event per critical problem the game found', () => {
  const text = run(`
    local checks = {game = {state = 'ok', code = 'tested', version = '2.31'}, cet = {state = 'ok', code = 'found', version = 'v1.35.0'},
      codeware = {state = 'problem', code = 'old', version = '1.12.0'}, audioware = {state = 'ok', code = 'found', version = '1.3.0'},
      tweakxl = {state = 'problem', code = 'missing'}, redscript = {state = 'ok', code = 'loaded'}, files = {state = 'ok', code = 'found', version = '0.2.2'},
      service = {state = 'ok', code = 'running'}}
    assert(M.noteSetup({'codeware', 'tweakxl', 'versions'}, checks) == true)
    return file()`);
  const parsed = parseGameEvents(text);
  assert.deepEqual({game: parsed.game.game, cet: parsed.game.cet, codeware: parsed.game.codeware, scripts: parsed.game.scripts, redscript: parsed.game.redscript},
    {game: '2.31', cet: 'v1.35.0', codeware: '1.12.0', scripts: '0.2.2', redscript: 'loaded'});
  assert.ok(parsed.game.setup.includes('codeware: problem old'));
  assert.deepEqual(parsed.events.map(row => row.message), ['codeware old', 'tweakxl missing'], 'only problems the game itself found');
  assert.ok(parsed.events.every(row => row.frame === 'game-setup'));
  const quiet = parseGameEvents(run(`assert(M.noteSetup({}, {cet = {state = 'ok', code = 'found', version = 'v1.35.0'}}))
    return file()`));
  assert.equal(quiet.game.cet, 'v1.35.0', 'the facts alone are written when nothing is wrong');
  assert.deepEqual(quiet.events, []);
});

test('a report says which host of the Companion Manager the player had: the nsui line and the Mod Configuration Menu version', () => {
  const text = (nsui, problems = '') => run(`
    local checks = {cet = {state = 'ok', code = 'found', version = 'v1.35.0'}, nsui = ${nsui}}
    assert(M.noteSetup({${problems}}, checks) == true)
    return file()`);
  // Neither host: the problem is an event, and the line shows it was neither (a report of 0.2.2 had no line and no way to tell).
  const none = parseGameEvents(text("{state = 'problem', code = 'missing'}", "'nsui'"));
  assert.ok(none.game.setup.includes('nsui: problem missing'), none.game.setup.join('|'));
  assert.deepEqual(none.events.map(row => row.message), ['nsui missing']);
  assert.equal(none.game.mcm, undefined);
  // Mod Configuration Menu 0.10.5 or newer works: no event, and its version is in the report.
  const mcm = parseGameEvents(text("{state = 'ok', code = 'mcm', version = '0.10.5'}"));
  assert.ok(mcm.game.setup.includes('nsui: ok mcm 0.10.5'), mcm.game.setup.join('|'));
  assert.equal(mcm.game.mcm, '0.10.5');
  assert.deepEqual(mcm.events, [], 'with Mod Configuration Menu the manager works: nothing is reported');
  const old = parseGameEvents(text("{state = 'problem', code = 'mcm-old', version = '0.9.1'}", "'nsui'"));
  assert.equal(old.game.mcm, '0.9.1');
  assert.deepEqual(old.events.map(row => row.message), ['nsui mcm-old']);
  const native = parseGameEvents(text("{state = 'ok', code = 'found', version = '1.96'}"));
  assert.ok(native.game.setup.includes('nsui: ok found 1.96'));
  assert.equal(native.game.mcm, undefined);
});

test('the one-time notice waits for gameplay and 40 s, shows once, is remembered, and never shows with the setting off', () => {
  const shown = run(`
    assert(M.tick(false) == nil)
    assert(M.tick(true) == nil, 'starts the wait')
    now = now + 39; assert(M.tick(true) == nil)
    now = now + 1; local text = M.tick(true)
    assert(M.tick(true) == nil and marks == 1, 'once, and remembered')
    return text`);
  assert.equal(shown, `T:${NOTICE}`);
  assert.equal(run(`noticed = true; M.tick(true); now = now + 60; return tostring(M.tick(true))`), 'nil', 'already shown at an earlier load');
  assert.equal(run(`setting = false; M.tick(true); now = now + 60; return tostring(M.tick(true)) .. marks`), 'nil0');
});
