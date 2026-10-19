import {test} from 'node:test';
import assert from 'node:assert/strict';
import {source, catalog, run} from './setup-check-fixture.mjs';

// This mod's redscript compiles without Codeware and Audioware (r6/scripts/CyberpunkConvai/Requirements.reds): a compile error would
// disable every redscript mod, so a missing requirement must show up as a short plain notice instead, and a mod whose scripts did not
// compile at all must be told apart from one that compiled without them. These tests run the real mod/setup-check.lua over the
// shared fake game (setup-check-fixture.mjs), where env.requirements is what PlayerPuppet:ConvaiRequirements answers.
// The last tests run the real mod/init.lua and the modules that call the scripts, with a player that has none of their methods.

const ALL = 'codeware codeware-ui codeware-textinput audioware';
// One whole first-load: the game session starts, twelve seconds pass, the service is asked, its answer comes, and the notice is
// returned (nil when nothing critical is wrong). The Lua text defines notice() for the test bodies.
const firstLoad = String.raw`
  function notice()
    check.tick(true, true); advance(12); check.tick(true, true)
    local request = files['runtime/setup-check-request.json'] and json.decode(files['runtime/setup-check-request.json'])
    if request then answer({}, request.id); advance(1) end
    return check.tick(true, true)
  end
`;

test('every requirement present: no problem, no notice, nothing on the console, and the answer is read once per check', () => run(String.raw`
  ${firstLoad}
  installFiles(); serviceRunning()
  env.requirements = '${ALL}'; applyEnv()
  check.run()
  assert(ids() == 'files=ok game=ok cet=ok red4ext=ok redscript=ok codeware=ok tweakxl=ok audioware=ok nsui=ok', ids())
  assert(check.problemCount() == 0 and #check.problems() == 0)
  assert(lineOf('redscript').description == 'Loaded.' and lineOf('codeware').description == 'Version 1.20.5.')
  for _, word in ipairs({'codeware', 'codeware-ui', 'codeware-textinput', 'audioware'}) do assert(check.requirement(word) == true, word) end
  assert(check.requirement('something-else') == false)
  assert(check.codewareNotice() == nil)
  assert(requirementCalls == 1, 'one call for the check; the answers after it come from the kept set: ' .. requirementCalls)
  assert(table.concat(check.reportLines(), '\n'):find('scripts compiled with: audioware codeware codeware-textinput codeware-ui', 1, true))
  assert(notice() == nil and #console == 0)
  assert(files['runtime/probe.log']:find('no critical problem', 1, true))
`));

test('the scripts without Audioware: the notice names Audioware only, from the scripts and not from the probe', () => run(String.raw`
  ${firstLoad}
  installFiles(); serviceRunning()
  -- Audioware's own probe may still answer (the class exists in CET); what the scripts were compiled with is the answer
  env.requirements = 'codeware codeware-ui codeware-textinput'; applyEnv()
  check.run()
  assert(table.concat(check.problems(), ',') == 'audioware', table.concat(check.problems(), ','))
  assert(lineOf('audioware').state == 'problem' and lineOf('audioware').description == 'Audioware is missing. Install it from Nexus Mods, then restart the game.')
  assert(lineOf('codeware').state == 'ok' and lineOf('redscript').state == 'ok' and lineOf('red4ext').state == 'ok')
  assert(check.requirement('audioware') == false and check.requirement('codeware') == true)
  local shown = notice()
  assert(shown == 'Audioware is missing. Install it from Nexus Mods, then restart the game.', tostring(shown))
  assert(not shown:find('Codeware', 1, true) and not shown:find('TweakXL', 1, true))
  assert(#console == 1 and console[1] == '[AiNpcCyberpunkMod] AI NPC Cyberpunk Mod: Audioware is missing. Install it from Nexus Mods, then restart the game.', console[1])
  assert(files['runtime/probe.log']:find('Setup check: problems: audioware', 1, true))
  -- once per game session
  for _ = 1, 40 do advance(1); assert(check.tick(true, true) == nil) end
  assert(#console == 1)
  -- the same without the probe seeing Audioware
  env.audioware = nil; applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'audioware')
`));

test('the scripts without Codeware: Codeware alone, and Codeware with Audioware as one notice naming both', () => run(String.raw`
  ${firstLoad}
  installFiles(); serviceRunning()
  env.requirements = 'audioware'; applyEnv()
  check.run()
  assert(table.concat(check.problems(), ',') == 'codeware', table.concat(check.problems(), ','))
  assert(lineOf('codeware').description == 'Codeware is missing. Install it from Nexus Mods, then restart the game.')
  assert(lineOf('audioware').state == 'ok' and lineOf('redscript').state == 'ok')
  assert(check.codewareNotice() == 'Codeware is missing. Install it from Nexus Mods, then restart the game.')
  assert(notice() == 'Codeware is missing. Install it from Nexus Mods, then restart the game.')
`));

test('Codeware and Audioware both missing is one notice naming both, and the console says each once', () => run(String.raw`
  ${firstLoad}
  installFiles(); serviceRunning()
  env.requirements = ''; applyEnv()
  check.run()
  assert(table.concat(check.problems(), ',') == 'codeware,audioware', table.concat(check.problems(), ','))
  assert(lineOf('red4ext').state == 'ok', 'the probes of the CET side still prove RED4ext')
  local shown = notice()
  assert(shown == 'Missing: Codeware, Audioware. Install them and restart the game.', tostring(shown))
  assert(#console == 2 and console[1]:find('Codeware is missing', 1, true) and console[2]:find('Audioware is missing', 1, true), table.concat(console, ' | '))
  assert(files['runtime/probe.log']:find('Setup check: problems: codeware, audioware', 1, true))
  for _ = 1, 40 do advance(1); assert(check.tick(true, true) == nil) end
  assert(#console == 2, 'once per game session')
  assert(check.codewareNotice() == 'Codeware is missing. Install it from Nexus Mods, then restart the game.')
`));

test('requirements missing together: up to four names, Native Settings UI left to its own notice, and a mix of missing and old', () => run(String.raw`
  ${firstLoad}
  installFiles(); serviceRunning()
  -- RED4ext, Codeware, Audioware and TweakXL all absent (nothing answers), and Native Settings UI too
  env.codeware, env.tweakxl, env.audioware, env.native, env.nsui, env.requirements = nil, nil, nil, false, 'none', ''
  applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'red4ext,codeware,audioware,tweakxl,nsui', table.concat(check.problems(), ','))
  local shown = notice()
  assert(shown == 'Missing: RED4ext, Codeware, Audioware, TweakXL. Install them and restart the game.', tostring(shown))
  assert(not shown:find('Native Settings UI', 1, true))
  assert(#console == 5 and console[5]:find('Native Settings UI is missing or too old', 1, true), 'one line each, Native Settings UI among them')
`));

test('Codeware too old: its text input part missing is a Problem with the update text, alone or with other requirements', () => run(String.raw`
  ${firstLoad}
  installFiles(); serviceRunning()
  -- Codeware without Codeware.UI.TextInput
  env.requirements = 'codeware codeware-ui audioware'; applyEnv()
  check.run()
  assert(table.concat(check.problems(), ',') == 'codeware')
  assert(lineOf('codeware').state == 'problem' and lineOf('codeware').description == 'Codeware is too old. Update it from Nexus Mods, then restart the game.', lineOf('codeware').description)
  assert(table.concat(check.reportLines(), '\n'):find('codeware: problem old', 1, true))
  assert(check.requirement('codeware-textinput') == false and check.requirement('codeware-ui') == true)
  assert(check.codewareNotice() == 'Codeware is too old. Update it from Nexus Mods, then restart the game.')
  local shown = notice()
  assert(shown == 'Codeware is too old. Update it from Nexus Mods, then restart the game.', tostring(shown))
  assert(#console == 1 and console[1]:find('Codeware is too old', 1, true) and console[1]:find('Update Codeware from Nexus Mods', 1, true), console[1])
  assert(not shown:find('missing', 1, true))
`));

test('Codeware without its UI part is also too old, and a mix of old Codeware and missing Audioware is one notice that says install or update', () => run(String.raw`
  ${firstLoad}
  installFiles(); serviceRunning()
  env.requirements = 'codeware audioware'; applyEnv()
  check.run()
  assert(lineOf('codeware').state == 'problem' and lineOf('codeware').description:find('too old', 1, true))
  assert(check.codewareNotice() == 'Codeware is too old. Update it from Nexus Mods, then restart the game.')
  env.requirements = 'codeware codeware-ui'; applyEnv()
  check.run()
  assert(table.concat(check.problems(), ',') == 'codeware,audioware', table.concat(check.problems(), ','))
  assert(lineOf('codeware').description:find('too old', 1, true) and lineOf('audioware').description:find('is missing', 1, true))
  local shown = notice()
  assert(shown == 'Install or update: Codeware, Audioware. Then restart the game.', tostring(shown))
`));

test('scripts that did not compile: announced first and alone, with the log to read, and no framework is blamed', () => run(String.raw`
  ${firstLoad}
  installFiles(); serviceRunning()
  -- Neither ConvaiRequirements nor the older ConvaiPhoneIsOpen answers: the player has none of this mod's methods. The frameworks the
  -- probes cannot see are exactly what a compile error hides (every redscript mod is off), so they are Unknown, never Missing.
  env.scripts, env.requirements = false, nil
  env.codeware, env.audioware, env.tweakxl, env.native = nil, nil, nil, false
  applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'redscript', table.concat(check.problems(), ','))
  assert(lineOf('redscript').state == 'problem')
  for _, id in ipairs({'red4ext', 'codeware', 'audioware', 'tweakxl'}) do assert(lineOf(id).state == 'unknown', id) end
  local help = lineOf('redscript').description
  assert(help:find('r6/logs/redscript_rCURRENT.log', 1, true) and help:find('If the error names another mod, that mod is the problem.', 1, true), help)
  assert(help:find('Missing or old Codeware, Audioware or redscript, or a game version other than 2.31, can also cause it.', 1, true))
  local shown = notice()
  assert(shown == 'Open r6/logs/redscript_rCURRENT.log. A mod it names is why the scripts did not load.', tostring(shown))
  assert(not shown:find('Codeware', 1, true) and not shown:find('Audioware', 1, true) and not shown:find('Missing', 1, true))
  assert(#console == 1 and console[1]:find("this mod's scripts did not load. Open r6/logs/redscript_rCURRENT.log. If the error names another mod, that mod is the problem.", 1, true), console[1])
  assert(files['runtime/probe.log']:find('Setup check: problems: redscript', 1, true))
  -- the frameworks the probes do find are shown as found; the scripts are still the one problem
  env.codeware, env.audioware, env.tweakxl = '1.20.5', '1.9.9', '1.11.4'; applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'redscript' and lineOf('codeware').state == 'ok' and lineOf('audioware').state == 'ok')
  assert(check.requirement('audioware') == nil and check.codewareNotice() == nil, 'nothing is known of the requirements')
`));

test('scripts that did not compile come first even when every other requirement is missing and other problems exist', () => run(String.raw`
  ${firstLoad}
  installFiles(); serviceRunning()
  files['phone-contacts.json'] = nil
  env.nsui, env.scripts, env.requirements = 'none', false, nil
  env.codeware, env.audioware, env.tweakxl, env.native = nil, nil, nil, false
  applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'redscript,nsui,files', table.concat(check.problems(), ','))
  assert(notice() == 'Open r6/logs/redscript_rCURRENT.log. A mod it names is why the scripts did not load.')
`));

test('ConvaiRequirements that raises or answers a non-string is read as scripts of an older version: they loaded, the frameworks are implied', () => run(String.raw`
  installFiles(); serviceRunning()
  -- scripts of 0.2.1 and older: ConvaiPhoneIsOpen answers, ConvaiRequirements does not exist
  env.codeware, env.audioware = nil, nil; applyEnv()
  check.run()
  assert(lineOf('redscript').state == 'ok' and lineOf('codeware').state == 'ok' and lineOf('audioware').state == 'ok' and #check.problems() == 0)
  assert(lineOf('codeware').description == 'Found.', 'implied, with no version')
  assert(check.requirement('audioware') == nil and check.codewareNotice() == nil, 'what they were compiled with is not known')
  -- a ConvaiRequirements that raises
  env.requirementsError = true; applyEnv(); check.run()
  assert(requirementCalls >= 1 and lineOf('redscript').state == 'ok' and lineOf('codeware').state == 'ok' and #check.problems() == 0)
  assert(check.requirement('audioware') == nil)
  -- one that answers something that is not text
  env.requirementsError, env.requirements = nil, 42; applyEnv(); check.run()
  assert(lineOf('redscript').state == 'ok' and #check.problems() == 0 and check.requirement('audioware') == nil)
`));

test('a requirement of the scripts is read when asked and kept: no player is Unknown, nothing is asked per tick', () => run(String.raw`
  installFiles(); serviceRunning()
  env.requirements = 'codeware codeware-ui codeware-textinput'; env.player = false; applyEnv()
  assert(check.requirement('audioware') == nil and requirementCalls == 0, 'no player yet')
  env.player = true; applyEnv()
  assert(check.requirement('audioware') == false and requirementCalls == 1)
  for _ = 1, 20 do assert(check.requirement('codeware') == true) end
  assert(requirementCalls == 1, 'kept for the session: ' .. requirementCalls)
  -- the first-load timer's idle ticks ask nothing, and neither does anything else per frame
  local before = gameCalls
  for _ = 1, 10 do advance(1); check.tick(true, true) end
  assert(requirementCalls == 1 and gameCalls == before, 'ticks before the check is due make no game call')
  -- a passed player is used instead of asking the game for one
  env.requirements = ''
  assert(check.requirement('codeware', {ConvaiRequirements = function() return '' end}) == true, 'the kept answer wins')
`));

test('every sentence the requirement notices can show is a catalogued English UI key', () => {
  const sentences = [
    'Open r6/logs/redscript_rCURRENT.log. A mod it names is why the scripts did not load.',
    'Missing: {names}. Install them and restart the game.',
    'Install or update: {names}. Then restart the game.',
    'Codeware is too old. Update it from Nexus Mods, then restart the game.',
    'This mod’s scripts did not load. Open r6/logs/redscript_rCURRENT.log. If the error names another mod, that mod is the problem. Missing or old Codeware, Audioware or redscript, or a game version other than 2.31, can also cause it.',
  ];
  for (const text of sentences) {
    assert.equal(catalog[text], text, `missing from localization/en.json: ${text}`);
    assert(source.includes(`ui.t('${text}'`), `setup-check.lua no longer says: ${text}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The real mod/init.lua over a player that has none of the scripts' methods (or only some). The harness is the one of
// knowledge-integration.test.mjs (init.lua with its modules stubbed), read from that file so the two cannot drift apart, with the
// real notices.lua and setup-check.lua added. The tests' bodies run after it, so they see its locals: player, modules, events, hooks,
// hotkeys, logs, feedback, now, looked, people, allowNative.
import {readFileSync, writeFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const modSource = name => readFileSync(new URL(`../mod/${name}.lua`, import.meta.url), 'utf8');
const knowledgeTest = readFileSync(new URL('./knowledge-integration.test.mjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const template = /\nconst fixture = `\n([\s\S]*?)\n`;\n/.exec(knowledgeTest);
assert(template, 'bridge/knowledge-integration.test.mjs no longer has its fixture in this shape');
const initSource = modSource('init').replace(/\r?\nreturn \{addons = [^\n]*\s*$/, '\n');
assert.notEqual(initSource, modSource('init'), 'init.lua no longer ends with the add-on API return');
const names = ['initSource', 'microphoneSource', 'groupSource', 'worldSource', 'historySource', 'partsSource', 'invitationSource',
  'gameplayActionsSource', 'seatedLookSource'];
const values = {initSource, microphoneSource: modSource('microphone'), groupSource: modSource('group-chat'),
  worldSource: modSource('world-knowledge'), historySource: modSource('journal-history'), partsSource: modSource('knowledge-parts'),
  invitationSource: modSource('invitation-readiness'), gameplayActionsSource: modSource('gameplay-actions'),
  seatedLookSource: modSource('seated-look')};
let harness = new Function(...names, `return \`${template[1]}\`;`)(...names.map(name => values[name]));
const withModule = (text, anchor, lua) => {
  assert(text.includes(anchor), `the harness no longer has: ${anchor}`);
  return text.replace(anchor, () => lua);
};
// The real gate for notices (a notice falls back to PlayerPuppet:ConvaiPhoneFeedback when the blackboard line cannot be written), and
// the setup check as a global, which is how init.lua and the modules reach it.
harness = withModule(harness, 'local modules={', `local modules={['notices.lua']=(function() ${modSource('notices')}\nend)(),\n`);
harness = 'withKnowledgeParts=false\nconvaiSetupCheck=(function() ' + modSource('setup-check') + '\nend)()\n' + harness;

function runInit(body) {
  if (process.env.DUMP_INIT) writeFileSync(process.env.DUMP_INIT, uiLocaleBootstrap + harness + body);
  const vm = lauxlib.luaL_newstate(); lualib.luaL_openlibs(vm);
  const checkedBody = '\nlocal fixtureOk,fixtureError=pcall(function()\n' + body
    + '\nend)\nif not fixtureOk then error(tostring(fixtureError).."\\nFixture logs:\\n"..table.concat(logs,"\\n"))end';
  const result = lauxlib.luaL_dostring(vm, to_luastring(uiLocaleBootstrap + harness + checkedBody));
  const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(vm, -1));
  lua.lua_close(vm); assert.equal(result, lua.LUA_OK, error);
}

// What a player has when this mod's scripts did not compile: the game's own methods, none of the Convai ones.
const barePlayer = String.raw`
  for key in pairs(player) do if key:find('^Convai') then player[key] = nil end end
  setmetatable(player, nil)
  assert(player.ConvaiComposerOpen == nil and player.ConvaiPhoneClearContacts == nil and player.ConvaiManagerSetVoice == nil)
`;

test('a player with none of the scripts’ methods: every frame runs, and the phone catalogue failure is written once, not ten times a second', () => runInit(String.raw`
  ${barePlayer}
  local attempts = 0
  modules['companions.lua'].registerPhoneContacts = function(who) attempts = attempts + 1; who:ConvaiPhoneClearContacts() end
  events.onInit(); allowNative = true
  local base = #logs   -- what the harness's stubbed modules said while init.lua loaded is not this test's concern
  for _ = 1, 100 do
    now = now + 0.1
    local ok, failure = pcall(events.onUpdate, 0.1)
    assert(ok, tostring(failure))
  end
  local function count(text)
    local found = 0
    for index = base + 1, #logs do if logs[index]:find(text, 1, true) then found = found + 1 end end
    return found
  end
  assert(attempts >= 10, 'it is still tried on the tick, as before: ' .. attempts)
  assert(count('Phone catalog registration failed') == 1, table.concat(logs, '\n', base + 1))
  -- nothing else failed in all those frames
  for index = base + 1, #logs do
    local line = logs[index]
    assert(not line:find('failed', 1, true) or line:find('Phone catalog registration failed', 1, true), line)
    assert(not line:find('rror', 1, true), line)
  end
  -- the scripts are there after all (a reload): the registration succeeds, and a failure after that is written again
  local registered = 0
  modules['companions.lua'].registerPhoneContacts = function() registered = registered + 1 end
  for _ = 1, 5 do now = now + 0.1; assert(pcall(events.onUpdate, 0.1)) end
  assert(registered == 1, 'registered once it can: ' .. registered)
  tearingDown = true; hooks.OnDetach(); tearingDown = false
  modules['companions.lua'].registerPhoneContacts = function(who) who:ConvaiPhoneClearContacts() end
  hooks.OnGameAttached(); hooks.OnGameRestored()
  for _ = 1, 5 do now = now + 0.1; assert(pcall(events.onUpdate, 0.1)) end
  assert(count('Phone catalog registration failed') == 2, 'the second failure after a success is written: ' .. count('Phone catalog registration failed'))
`));

test('a hook installer that raises no longer stops onInit: the menu registration and the later hooks still happen, one line each', () => runInit(String.raw`
  local installed = {}
  modules['subtitles.lua'].install = function() error('Override: method ConvaiShowReply not found in PlayerPuppet') end
  modules['phone-chat-style.lua'].install = function() error('ObserveAfter: no class ConvaiPhoneChatInput') end
  modules['phone-layout.lua'].install = function() error('ObserveAfter: no class PhoneContactItemVirtualController') end
  modules['nsui.lua'].install = function() installed.nsui = true end
  modules['loot-observer.lua'].install = function() error('hook failed') end
  events.onInit()
  assert(installed.nsui == true, 'the Native Settings UI registration after the failing installers ran')
  assert(hooks.OnDetach ~= nil and hooks.OnGameRestored ~= nil, 'the session hooks after them were installed')
  local function count(text)
    local found = 0
    for _, line in ipairs(logs) do if line:find(text, 1, true) then found = found + 1 end end
    return found
  end
  for _, label in ipairs({'Subtitle hooks failed:', 'Phone chat style hooks failed:', 'Phone layout hooks failed:', 'Loot observer hooks failed:'}) do
    assert(count(label) == 1, label .. ' ' .. count(label) .. '\n' .. table.concat(logs, '\n'))
  end
  assert(count('Game adapter initialized') == 1, 'onInit reached its last line')
`));

test('installers that work are called exactly as before: no arguments, and no failure line', () => runInit(String.raw`
  local calls = {}
  for _, name in ipairs({'subtitles.lua', 'phone-chat-style.lua', 'phone-layout.lua', 'loot-observer.lua'}) do
    modules[name].install = function(...) calls[#calls + 1] = name .. ':' .. select('#', ...) end
  end
  events.onInit()
  table.sort(calls)
  assert(table.concat(calls, ',') == 'loot-observer.lua:0,phone-chat-style.lua:0,phone-layout.lua:0,subtitles.lua:0', table.concat(calls, ','))
  for _, line in ipairs(logs) do assert(not line:find('hooks failed', 1, true), line) end
`));

test('the text box refused for want of Codeware: one probe.log line for the session, and the player is told on each press of the talk key', () => runInit(String.raw`
  ${barePlayer}
  -- scripts that compiled without Codeware: the box and the movement tracker answer, but the box cannot open
  function player:ConvaiRequirements() return 'audioware' end
  function player:ConvaiComposerOpen() return false end
  function player:ConvaiOpenComposer() return false end
  function player:ConvaiPhoneFeedback(text) feedback[#feedback + 1] = text end
  function player:ConvaiManagerVoice() return true end
  function player:ConvaiManagerSubtitles() return true end
  events.onInit(); allowNative = true; events.onUpdate(0)
  looked = alex; people = {alex}
  for press = 1, 3 do
    hotkeys.cyberpunk_convai_text()
    assert(not player.composer)
    now = now + 2; events.onUpdate(0.1)
  end
  local told = 0
  for _, text in ipairs(feedback) do
    if text == 'Codeware is missing. Install it from Nexus Mods, then restart the game.' then told = told + 1 end
  end
  assert(told == 3, 'each press says why: ' .. table.concat(feedback, ' | '))
  local lines = 0
  for _, line in ipairs(logs) do
    if line:find('Native composer unavailable: these scripts were compiled without the UI part of Codeware', 1, true) then lines = lines + 1 end
    assert(not line:find('Open failed', 1, true), line)
  end
  assert(lines == 1, 'logged once: ' .. lines)
`));

test('the text box refused by scripts that do not say what they were compiled with: logged once in the older words, nothing shown', () => runInit(String.raw`
  ${barePlayer}
  function player:ConvaiComposerOpen() return false end
  function player:ConvaiOpenComposer() return false end
  function player:ConvaiPhoneFeedback(text) feedback[#feedback + 1] = text end
  events.onInit(); allowNative = true; events.onUpdate(0)
  looked = alex; people = {alex}
  for _ = 1, 3 do hotkeys.cyberpunk_convai_text(); now = now + 2; events.onUpdate(0.1) end
  assert(#feedback == 0, table.concat(feedback, ' | '))
  local lines = 0
  for _, line in ipairs(logs) do if line:find('Native composer unavailable (check redscript and Codeware)', 1, true) then lines = lines + 1 end end
  assert(lines == 1)
`));

// ---------------------------------------------------------------------------------------------------------------------------------
// The modules that call the scripts, one by one, with what the scripts answer when they were compiled without a requirement.
import {run as runHost, diskLua, managerLua, modSource as hostSource} from './startup-lua-fixture.mjs';

// The setup check as init.lua's neighbours reach it: a global, created again for each player (it keeps what the first player said).
const freshSetupCheck = `convaiSetupCheck = nil; convaiSetupCheck = (function() ${hostSource('setup-check.lua')} end)()`;

test('speech offers audio to the service only when Audioware was there, and says why a voice did not start', () => runHost(`
  ${freshSetupCheck}
  local function playerWith(requirements, position)
    local voice = true
    local player = {GetEntityID = function() return {hash = 'player'} end, ConvaiManagerVoice = function() return true end,
      ConvaiSpeechStart = function() return false end, ConvaiSpeechStop = function() end}
    if requirements then player.ConvaiRequirements = function() return requirements end end
    if position then player.ConvaiSpeechPosition = function() return -1.0 end end
    return player
  end
  local board = {SetVariant = function() end, GetBool = function() return false end}
  local current
  Game = {GetPlayer = function() return current end,
    GetAllBlackboardDefs = function() return {UI_System = {}, UIGameData = {}} end,
    GetBlackboardSystem = function() return {Get = function() return board end} end}
  CRUID = function(v) return v end
  ToVariant = function(v) return v end
  CName = {new = function(v) return v end}
  scnDialogLineData = {new = function() return {} end}
  scnDialogLineType = {OwnerlessRegular = 1}
  io.open = function() return nil end
  local captions = (function() ${hostSource('subtitles.lua')} end)()
  local face = (function() ${hostSource('facial-playback.lua')} end)()
  dofile = function(path) return path == 'facial-playback.lua' and face or captions end
  local speech = (function() ${hostSource('speech.lua')} end)()
  local function available(requirements, position)
    convaiSetupCheck = nil; convaiSetupCheck = (function() ${hostSource('setup-check.lua')} end)()
    current = playerWith(requirements, position)
    speech.available = nil
    speech.update(2.5)
    return speech.available
  end
  -- scripts compiled with Audioware: audio can be offered
  assert(available('codeware codeware-ui codeware-textinput audioware', true) == true)
  -- scripts compiled without it: the stand-ins answer, but nothing can play, so the service is told there is no audio
  assert(available('codeware codeware-ui codeware-textinput', true) == false)
  assert(available('', true) == false)
  -- scripts of 0.2.1 and older say nothing about it: as before
  assert(available(nil, true) == true)
  -- no scripts at all: the method is not there
  assert(available(nil, false) == false)
  -- a voice that cannot start because Audioware is missing says so, and the subtitle still shows
  convaiSetupCheck = nil; convaiSetupCheck = (function() ${hostSource('setup-check.lua')} end)()
  current = playerWith('codeware', true)
  speech.available = true
  speech.target = {GetEntityID = function() return {hash = 'npc'} end, IsAttached = function() return true end,
    IsDeadNoStatPool = function() return false end}
  local started = speech.start({entity = 'npc', requestId = 'r1', name = 'Judy'},
    {text = 'Hello V', audio = {slot = 0, event = 'convai_reply_0', duration = 5}})
  assert(started == false and speech.state == 'playback-failed' and speech.error == 'Audioware is missing', tostring(speech.error))
  assert(captions.line, 'the reply is still shown as text')
  -- the same with Audioware there: the reason is the answer of the call
  convaiSetupCheck = nil; convaiSetupCheck = (function() ${hostSource('setup-check.lua')} end)()
  current = playerWith('codeware audioware', true)
  speech.available = true
  speech.start({entity = 'npc', requestId = 'r2', name = 'Judy'}, {text = 'Hello V', audio = {slot = 0, event = 'convai_reply_0', duration = 5}})
  assert(speech.error == 'false', tostring(speech.error))
`));

test('the Chat tab is offered no contact without Codeware’s text input, and every contact with it or when that is not known', () => {
  const chatWith = requirements => runHost(`
    ${diskLua}
    ${freshSetupCheck}
    files['phone-contacts.json'] = '[{"contact":"judy","key":"judy-alvarez"},{"contact":"panam","key":"panam-palmer"}]'
    NewObject = function() return {} end
    local chat = (function() ${hostSource('phone-chat.lua')} end)()
    chat.resetPeriod, chat.resetIdlePeriod = 0, 0
    local registered, cleared = {}, 0
    local player = {ConvaiPhoneChatContact = function() return '' end, ConvaiPhoneChatTick = function() end,
      ConvaiPhoneChatClearContacts = function() cleared = cleared + 1 end,
      ConvaiPhoneChatRegisterContact = function(_, id) registered[#registered + 1] = id end,
      ConvaiPhoneChatDraft = function() return nil end, ConvaiPhoneChatTakeSubmission = function() return nil end,
      ConvaiPhoneChatTyping = function() return false end, ConvaiPhoneChatPresent = function() end}
    ${requirements === null ? '' : `player.ConvaiRequirements = function() return '${requirements}' end`}
    chat.configure({{key = 'judy-alvarez'}, {key = 'panam-palmer'}}, {profileEnabled = function() return true end},
      {captureBinding = function() return {version = 1, status = 'unavailable', generation = 1} end})
    for _ = 1, 8 do chat.update(player, 0) end
    table.sort(registered)
    report('registered', table.concat(registered, ','))
    report('cleared', cleared)
    report('done', chat.registered == true)
  `);
  const without = chatWith('codeware codeware-ui audioware');
  assert.deepEqual([without.registered, without.cleared, without.done], ['', 1, true], 'cleared once, nothing offered');
  const withIt = chatWith('codeware codeware-ui codeware-textinput audioware');
  assert.deepEqual([withIt.registered, withIt.cleared], ['judy,panam', 1]);
  const noCodeware = chatWith('audioware');
  assert.equal(noCodeware.registered, '');
  const older = chatWith(null);
  assert.equal(older.registered, 'judy,panam', 'scripts that cannot say are offered as before');
});

test('the manager starts without the scripts’ methods: settings are written, and the update is quiet every tick', () => {
  const reports = runHost(`
    ${managerLua}
    local manager = newManager()
    -- a player whose scripts did not compile: only the game's own method
    local bare = {GetEntityID = function() return {hash = 'player-1'} end}
    for _ = 1, 5 do
      local ok, failure = pcall(manager.update, bare, 0.5)
      assert(ok, tostring(failure))
    end
    report('written', settingsText() ~= nil)
    report('version', settingsText() and settingsTable().version)
    -- a player with the methods is initialised as before
    local manager2 = newManager()
    local player = newPlayer()
    manager2.update(player, 0.5)
    report('voice', player.voice)
  `);
  assert.equal(reports.written, true, 'the settings file exists after the first update');
  assert.equal(reports.version, 2);
  assert.equal(reports.voice, true);
});

test('the story-talk and crowd switches name Codeware when its service container is absent, instead of failing on a nil', () => {
  const reports = runHost(`
    local function load()
      io.open = function() return nil end
      local captions = (function() ${hostSource('subtitles.lua')} end)()
      dofile = function() return captions end
      CName = {new = function(v) return v end}
      return (function() ${hostSource('facial-playback.lua')} end)()
    end
    -- CET without Codeware: the container function does not exist
    Game = {}
    local face = load()
    local ok, why = face.applyStoryTalk(true)
    report('absent', tostring(ok) .. '|' .. tostring(why))
    -- a container that has no such service
    Game = {GetScriptableServiceContainer = function() return {GetService = function() return nil end} end}
    ok, why = face.applyStoryTalk(false)
    report('noservice', tostring(ok) .. '|' .. tostring(why))
    -- a service that answers
    Game = {GetScriptableServiceContainer = function() return {GetService = function() return {SetStoryTalk = function(_, value) return value end} end} end}
    ok, why = face.applyStoryTalk(true)
    report('answers', tostring(ok) .. '|' .. tostring(why))
  `);
  assert.match(reports.absent, /^false\|the face service does not exist \(Codeware is missing\)$/);
  assert.match(reports.noservice, /^false\|the face service does not exist \(Codeware is missing\)$/);
  assert.equal(reports.answers, 'true|nil');
});

test('the phone style installs its later hooks even when the text input hooks cannot be placed', () => {
  const reports = runHost(`
    local placed = {}
    local function missing(class) return class:find('^CyberpunkConvai%.') or class:find('^Codeware%.') end
    ObserveAfter = function(class, method) if missing(class) then error('class ' .. class .. ' not found') end placed[#placed + 1] = class .. '.' .. method end
    ObserveBefore = ObserveAfter
    Override = function(class, method) placed[#placed + 1] = 'override ' .. class .. '.' .. method end
    local style = (function() ${hostSource('phone-chat-style.lua')} end)()
    local ok, failure = pcall(style.install)
    report('ok', ok)
    report('failure', tostring(failure))
    report('input', style.inputHooksInstalled == true)
    report('locale', style.localeHooksInstalled == true)
    report('feedback', style.feedbackLocaleHooksInstalled == true)
    report('placed', #placed)
  `);
  assert.equal(reports.ok, true, reports.failure);
  assert.deepEqual([reports.input, reports.locale, reports.feedback], [true, true, true]);
  assert(reports.placed > 10);
});

test('the phone input gate asks a player without the scripts once a second, not for every input event', () => {
  const reports = runHost(`
    local clock, queries = 100, 0
    os.clock = function() return clock end
    local player = {}
    Game = {GetPlayer = function() queries = queries + 1; return player end}
    local input = (function() ${hostSource('phone-input.lua')} end)()
    for _ = 1, 50 do clock = clock + 0.05; input.phoneState() end
    report('absent', queries)
    -- the scripts appear (a CET reload with a new install): the quick cadence is back at the next look
    player.ConvaiPhoneIsOpen = function() return true end
    player.ConvaiPhoneChatTyping = function() return false end
    clock = clock + 1.5
    local _, open = input.phoneState()
    report('open', open)
    queries = 0
    for _ = 1, 10 do clock = clock + 0.05; input.phoneState() end
    report('present', queries)
  `);
  assert(reports.absent <= 4, `a player without the scripts was asked ${reports.absent} times in 2.5 s`);
  assert.equal(reports.open, true);
  assert(reports.present >= 8, `with the scripts the answers stay at the quick cadence: ${reports.present}`);
});
