// This mod's scripts that compiled only in part (31 Oct 2026, one install on 0.4.0 with game 2.5 and redscript loaded: "attempt to call method
// 'ConvaiManagerSetVoice' (a nil value)" and "... 'ConvaiPhoneClearContacts' ..."): the Lua looks up the redscript methods it needs once, says so once
// (Help row, first-load notice, console line), files one setup-problem of the kind scripts-not-compiled instead of Lua errors, and the modules that would
// raise on every update stand down. The real mod/setup-check.lua over the shared fake game (setup-check-fixture.mjs), the real mod/error-reports.lua,
// and a coverage test that keeps the list of methods in step with r6/scripts and with the calls in mod/.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readdirSync, readFileSync} from 'node:fs';
import fengari from 'fengari';
import {source, catalog, run} from './setup-check-fixture.mjs';
import {LUA_HARNESS} from './addon-lua-harness.mjs';
import {parseGameEvents} from './error-events.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const NOTICE = 'Open r6/logs/redscript_rCURRENT.log. Scripts did not compile. Match Scripts and game.';

// One whole first-load (the same as bridge/reds-requirements.test.mjs): the game session starts, twelve seconds pass, the service answers, the notice is returned.
const firstLoad = String.raw`
  function notice()
    check.tick(true, true); advance(12); check.tick(true, true)
    local request = files['runtime/setup-check-request.json'] and json.decode(files['runtime/setup-check-request.json'])
    if request then answer({}, request.id); advance(1) end
    return check.tick(true, true)
  end
`;

// ---------------------------------------------------------------------------------------------------------------------------------
// The setup check
// ---------------------------------------------------------------------------------------------------------------------------------

test('scripts that compiled completely: nothing missing, no flag for the guards, no notice', () => run(String.raw`
  ${firstLoad}
  installFiles(); serviceRunning()
  env.requirements = 'codeware codeware-ui codeware-textinput'; applyEnv()
  check.run()
  assert(lineOf('redscript').state == 'ok' and lineOf('redscript').description == 'Loaded.')
  assert(#check.problems() == 0)
  local missing = check.scriptsMissing()
  assert(type(missing) == 'table' and #missing == 0, 'looked up, and nothing is missing')
  assert(convaiScriptsMissing == nil, 'the guards see nothing')
  assert(notice() == nil and #console == 0)
`));

test('the report’s case: ConvaiManagerSetVoice and ConvaiPhoneClearContacts missing: one Problem, one notice, one console line, the groups for the guards', () => run(String.raw`
  ${firstLoad}
  installFiles(); serviceRunning()
  env.requirements = 'codeware codeware-ui codeware-textinput'
  env.missingMethods = {ConvaiManagerSetVoice = true, ConvaiPhoneClearContacts = true}; applyEnv()
  local reported
  convaiErrorReports = {noteSetup = function(problems, checks) reported = {problems = problems, checks = checks} end}
  check.run()
  assert(table.concat(check.problems(), ',') == 'redscript', table.concat(check.problems(), ','))
  local row = lineOf('redscript')
  assert(row.state == 'problem')
  assert(row.description:find('did not compile completely', 1, true) and row.description:find('Functions it needs that are missing: 2 (ConvaiManagerSetVoice, ConvaiPhoneClearContacts).', 1, true), row.description)
  assert(row.description:find('r6/logs/redscript_rCURRENT.log', 1, true) and row.description:find('If the error names another mod, that mod is the problem.', 1, true))
  assert(row.description:find('build for game 2.31 and come from the same download as the Runtime', 1, true), row.description)
  -- the guards' flag: the groups that lack a method
  assert(type(convaiScriptsMissing) == 'table' and convaiScriptsMissing.manager == true and convaiScriptsMissing.phone == true)
  assert(convaiScriptsMissing.chat == nil and convaiScriptsMissing.composer == nil, 'a group that has all its methods stays up')
  assert(table.concat(check.scriptsMissing(), ',') == 'ConvaiManagerSetVoice,ConvaiPhoneClearContacts')
  -- the notice: one, in gameplay, the log to read and the Scripts to match
  local shown = notice()
  assert(shown == '${NOTICE}', tostring(shown))
  assert(#console == 1 and console[1]:find('did not compile completely (2 functions the Lua needs are missing: ConvaiManagerSetVoice, ConvaiPhoneClearContacts)', 1, true), console[1])
  assert(console[1]:find('build for game 2.31 and come from the same download as the Runtime', 1, true))
  assert(files['runtime/probe.log']:find('Setup check: problems: redscript', 1, true))
  for _ = 1, 40 do advance(1); assert(check.tick(true, true) == nil) end
  assert(#console == 1, 'once per game session')
  -- the report: the game's own setup check names the problem (the call happened in firstLoad)
  assert(reported and table.concat(reported.problems, ',') == 'redscript' and reported.checks.redscript.code == 'incomplete')
  assert(reported.checks.redscript.detail == '2 missing: ConvaiManagerSetVoice,ConvaiPhoneClearContacts', reported.checks.redscript.detail)
  assert(table.concat(check.reportLines(), '\n'):find('redscript: problem incomplete', 1, true))
  assert(table.concat(check.reportLines(), '\n'):find('scripts missing 2 functions: ConvaiManagerSetVoice ConvaiPhoneClearContacts', 1, true))
`));

test('many methods missing: the Help row and the report name the first four only', () => run(String.raw`
  installFiles(); serviceRunning()
  env.requirements = 'codeware codeware-ui codeware-textinput'
  env.missingMethods = {}
  for _, name in ipairs({'ConvaiManagerSetVoice', 'ConvaiManagerSetSubtitles', 'ConvaiManagerSetEnabled', 'ConvaiManagerVoice', 'ConvaiManagerSubtitles', 'ConvaiPhoneClearContacts'}) do
    env.missingMethods[name] = true
  end
  applyEnv(); check.run()
  local row = lineOf('redscript').description
  assert(row:find('missing: 6 (ConvaiManagerSetVoice, ConvaiManagerSetSubtitles, ConvaiManagerSetEnabled, ConvaiManagerVoice).', 1, true), row)
  assert(not row:find('ConvaiPhoneClearContacts', 1, true))
  assert(#check.scriptsMissing() == 6)
`));

test('the lookup is made once per game session: one read per method, then nothing on any tick', () => run(String.raw`
  installFiles(); serviceRunning()
  local lookups = 0
  local player = setmetatable({ConvaiPhoneIsOpen = function() return false end}, {__index = function(_, key)
    if type(key) == 'string' and key:find('^Convai') then lookups = lookups + 1; return function() end end
  end})
  check.tick(true, true, player)
  local once = lookups
  assert(once >= 60 and once <= 120, 'about eighty methods, one read each: ' .. once)
  for _ = 1, 200 do advance(1); check.tick(true, true, player); check.tick(false, false) end
  check.run(); check.run()
  assert(lookups == once + 0 or lookups == once + 1, 'run() reads ConvaiRequirements again, nothing else: ' .. lookups .. ' after ' .. once)
  assert(#check.scriptsMissing() == 0)
  -- no player, no lookup yet
`));

test('scripts that did not load at all keep their own row: redscript missing, not an incomplete one', () => run(String.raw`
  ${firstLoad}
  installFiles(); serviceRunning()
  env.scripts, env.requirements = false, nil
  env.codeware, env.native = nil, true
  applyEnv(); check.run()
  assert(lineOf('redscript').state == 'problem' and lineOf('redscript').description:find('This mod’s scripts did not load.', 1, true))
  assert(table.concat(check.problems(), ',') == 'redscript')
  assert(notice() == 'Open r6/logs/redscript_rCURRENT.log. A mod it names is why the scripts did not load.')
  -- a player with none of the scripts lacks every method: the guards stand down, and the row is still the one that says the scripts did not load
  assert(#check.scriptsMissing() > 60 and convaiScriptsMissing.chat == true and convaiScriptsMissing.manager == true)
  assert(lineOf('redscript').description:find('incomplete', 1, true) == nil and check.run().redscript.code == 'missing')
`));

test('a lookup made before the scripts were there is made again once, when the setup check finds them', () => run(String.raw`
  installFiles(); serviceRunning()
  env.scripts, env.requirements = false, nil; applyEnv()
  check.tick(true, true)   -- V exists, the scripts do not: every method is missing
  assert(#check.scriptsMissing() > 60 and convaiScriptsMissing ~= nil)
  env.scripts, env.requirements = true, 'codeware codeware-ui codeware-textinput'; applyEnv()
  check.run()
  assert(lineOf('redscript').state == 'ok', lineOf('redscript').description)
  assert(#check.scriptsMissing() == 0 and convaiScriptsMissing == nil, 'the guards are released')
`));

test('scripts of 0.2.1 and older still count as loaded when nothing else is missing (ConvaiRequirements is not on the list)', () => run(String.raw`
  installFiles(); serviceRunning()
  env.requirements = nil; applyEnv()
  check.run()
  assert(lineOf('redscript').state == 'ok' and #check.problems() == 0)
  assert(#check.scriptsMissing() == 0)
`));

test('the Help row, the notice and the console line are catalogued English UI keys, and the notice is one of the first-load sentences', () => {
  const rowText = 'This mod’s scripts did not compile completely. Functions it needs that are missing: {count} ({names}). Open r6/logs/redscript_rCURRENT.log. If the error names another mod, that mod is the problem. Also check that the Scripts are the build for game {game} and come from the same download as the Runtime, then restart the game.';
  for (const text of [rowText, NOTICE]) {
    assert.equal(catalog[text], text, `missing from localization/en.json: ${text}`);
    assert(source.includes(`ui.t('${text}'`) || source.includes(`ui.t('${text}',`), `setup-check.lua no longer says: ${text}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------------------------------------------

test('the game files one setup-problem of the kind scripts-not-compiled, not "redscript incomplete" and not a Lua error, and redscript missing keeps its own code', () => {
  const errorReports = read('../mod/error-reports.lua');
  const L = lauxlib.luaL_newstate(); lualib.luaL_openlibs(L);
  try {
    const program = `${LUA_HARNESS}
convaiUiLocale = {version = 1, t = function(text) return text end}
local domain = {errorReports = function() return true end, errorReportsNoticeDue = function() return false end, markErrorReportsNoticed = function() end}
local M = (function() ${errorReports} end)()
M.configure(domain)
assert(M.noteSetup({'redscript'}, {redscript = {state = 'problem', code = 'incomplete', detail = '2 missing: ConvaiManagerSetVoice,ConvaiPhoneClearContacts'}}) == true)
return files['runtime/error-events.json']`;
    const status = lauxlib.luaL_dostring(L, to_luastring(program));
    const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1));
    assert.equal(status, lua.LUA_OK, error);
    const parsed = parseGameEvents(to_jsstring(lua.lua_tostring(L, -1)));
    assert.deepEqual(parsed.events.map(row => [row.kind, row.message, row.frame]), [['setup-problem', 'scripts-not-compiled', 'game-setup']]);
    assert.equal(parsed.events[0].detail.detail, '2 missing: ConvaiManagerSetVoice,ConvaiPhoneClearContacts');
    assert.equal(parsed.game.redscript, 'incomplete');
    assert.ok(parsed.game.setup.includes('redscript: problem incomplete'), parsed.game.setup.join('|'));
  } finally { lua.lua_close(L); }
  const missing = lauxlib.luaL_newstate(); lualib.luaL_openlibs(missing);
  try {
    const program = `${LUA_HARNESS}
convaiUiLocale = {version = 1, t = function(text) return text end}
local domain = {errorReports = function() return true end, errorReportsNoticeDue = function() return false end, markErrorReportsNoticed = function() end}
local M = (function() ${errorReports} end)()
M.configure(domain)
assert(M.noteSetup({'redscript'}, {redscript = {state = 'problem', code = 'missing'}}) == true)
return files['runtime/error-events.json']`;
    assert.equal(lauxlib.luaL_dostring(missing, to_luastring(program)), lua.LUA_OK, to_jsstring(lua.lua_tostring(missing, -1)));
    assert.deepEqual(parseGameEvents(to_jsstring(lua.lua_tostring(missing, -1))).events.map(row => row.message), ['redscript missing']);
  } finally { lua.lua_close(missing); }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The list of methods, kept in step with the Scripts and with the Lua
// ---------------------------------------------------------------------------------------------------------------------------------

// The redscript methods of r6/scripts by class: {name -> {classes, always}}. A method that exists only for some Codeware builds
// (@if(ModuleExists(...)) without the @if(!ModuleExists(...)) twin) is not "always": it may be legitimately absent.
function scriptsMethods() {
  const folder = new URL('../r6/scripts/CyberpunkConvai/', import.meta.url);
  const found = {};
  for (const file of readdirSync(folder).filter(name => name.endsWith('.reds'))) {
    const lines = readFileSync(new URL(file, folder), 'utf8').split('\n');
    lines.forEach((line, index) => {
      const match = /func (Convai[A-Za-z0-9]+)\(/.exec(line);
      if (!match) return;
      let target = null, condition = null;
      for (let back = index - 1; back >= Math.max(0, index - 4); back--) {
        const add = /^@addMethod\((\w+)\)/.exec(lines[back]);
        if (add) target ??= add[1];
        const guard = /^@if\((.*)\)\s*$/.exec(lines[back]);
        if (guard) { condition ??= guard[1]; }
      }
      (found[match[1]] ??= []).push({target, condition});
    });
  }
  const always = rows => rows.some(row => !row.condition)
    || new Set(rows.filter(row => row.condition.startsWith('!')).map(row => row.condition.slice(1))).size > 0
      && rows.filter(row => !row.condition.startsWith('!')).some(row => rows.some(other => other.condition === `!${row.condition}`));
  return Object.fromEntries(Object.entries(found).map(([name, rows]) => [name, {targets: new Set(rows.map(row => row.target)), always: always(rows)}]));
}

function listedMethods() {
  const body = /local SCRIPT_METHODS = \{([\s\S]*?)\n\}\n/.exec(source.replace(/\r\n/g, '\n'));
  assert(body, 'SCRIPT_METHODS moved in mod/setup-check.lua');
  const groups = {};
  for (const row of body[1].matchAll(/\{'(\w+)',\s*((?:'[^']*'(?:\s*\.\.\s*)?\s*)+)\}/g)) {
    groups[row[1]] = [...row[2].matchAll(/'([^']*)'/g)].flatMap(part => part[1].split(/\s+/).filter(Boolean));
  }
  return groups;
}

test('every method on the list exists in the Scripts for the player, in every build of them (so a good install never gets the notice)', () => {
  const methods = scriptsMethods(), groups = listedMethods();
  assert(Object.keys(groups).length >= 8, Object.keys(groups).join(','));
  const names = Object.values(groups).flat();
  assert.equal(new Set(names).size, names.length, 'a method is listed once');
  for (const name of names) {
    assert(methods[name], `${name} is not defined in r6/scripts`);
    assert(methods[name].targets.has('PlayerPuppet') && methods[name].targets.size === 1, `${name} is not a method of PlayerPuppet only: ${[...methods[name].targets]}`);
    assert(methods[name].always, `${name} exists only for some builds of Codeware, so its absence is no sign of a failed compile`);
  }
});

test('every PlayerPuppet method that the shipped Lua calls is on the list, so a method added later is checked too', () => {
  const methods = scriptsMethods(), listed = new Set(Object.values(listedMethods()).flat());
  // The developer probes are not shipped to players' setups as features (mod/diagnostics.lua, face-probe.lua, face-test.lua), and ConvaiRequirements has its own rule.
  const skipped = new Set(['diagnostics.lua', 'face-probe.lua', 'face-test.lua']);
  const called = new Map();
  for (const file of readdirSync(new URL('../mod/', import.meta.url)).filter(name => name.endsWith('.lua') && !skipped.has(name))) {
    for (const match of read(`../mod/${file}`).matchAll(/:(Convai[A-Za-z0-9]+)\(/g)) (called.get(match[1]) ?? called.set(match[1], new Set()).get(match[1])).add(file);
  }
  assert(called.size > 60, `the scan found only ${called.size} methods`);
  for (const [name, files] of called) {
    const known = methods[name];
    if (!known) continue; // a name that is not a method of this mod's scripts (a local function called with a colon)
    if (name === 'ConvaiRequirements' || !known.targets.has('PlayerPuppet')) continue;
    assert(listed.has(name), `${name} (called in ${[...files].join(', ')}) is a PlayerPuppet method of the Scripts but is not in SCRIPT_METHODS in mod/setup-check.lua`);
  }
});

test('the groups the modules read exist on the list', () => {
  const groups = listedMethods();
  for (const [file, group] of [['phone-chat.lua', 'chat']]) {
    assert(groups[group], `${group} is not a group`);
    assert(read(`../mod/${file}`).includes(`gone.${group}`), `${file} no longer reads convaiScriptsMissing.${group}`);
  }
});
