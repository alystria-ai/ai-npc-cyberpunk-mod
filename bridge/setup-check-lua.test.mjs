import {test} from 'node:test';
import assert from 'node:assert/strict';
import {source, supportSource, catalog, run} from './setup-check-fixture.mjs';


test('every message the module can show is a catalogued English UI key', () => {
  const literals = [...source.matchAll(/ui\.t\('((?:[^'\\]|\\.)*)'/g)].map(match => match[1].replace(/\\'/g, "'"));
  assert(literals.length >= 40, `${literals.length} strings`);
  for (const text of literals) assert.equal(catalog[text], text, `missing from localization/en.json: ${text}`);
});

test('with everything installed every line says OK, nothing is a problem and the check opens only the files it names', () => run(String.raw`
  installFiles(); serviceRunning()
  assert(ids() == 'files=ok game=ok cet=ok red4ext=ok redscript=ok codeware=ok nsui=ok', ids())
  assert(check.problemCount() == 0 and #check.problems() == 0)
  local files_, game_, red4ext_ = lineOf('files'), lineOf('game'), lineOf('red4ext')
  assert(files_.label == 'Mod files' and files_.value == 'OK' and files_.description == 'All files found.')
  assert(game_.label == 'Game version' and game_.description == 'Version 2.31.')
  assert(red4ext_.label == 'RED4ext' and red4ext_.description == 'Loaded.')
  assert(lineOf('codeware').description == 'Version 1.20.5.')
  assert(lineOf('cet').description == 'Version 1.37.1.' and lineOf('nsui').description == 'Version 1.96.')
  assert(check.serviceLine() == nil, 'a running service is explained by the existing Conversation service row')
  -- the files the check opens: the four catalogs, release.json, the answer (none yet) and the service status files; the folder list
  local allowed = {}
  for _, path in ipairs({'world-knowledge.json', 'manager-characters.json', 'conversation-characters.json', 'phone-contacts.json', 'release.json',
    'runtime/setup-check.json', 'runtime/knowledge-status.json', 'runtime/local-voice-state.json', 'runtime/bridge-service.json'}) do allowed['rb ' .. path] = true end
  for _, line in ipairs(opened) do assert(allowed[line], 'opened ' .. line) end
  assert(#removed == 0)
`));

test('each missing framework is a Problem with its own fix, and the most fundamental one is announced first', () => run(String.raw`
  installFiles(); serviceRunning()
  -- RED4ext not loaded, and the scripts (0.2.2 and newer compile without Codeware) say nothing was there to compile against
  env.codeware, env.native, env.requirements = nil, false, ''
  applyEnv(); check.run()
  assert(lineOf('red4ext').state == 'problem' and lineOf('red4ext').value == 'Problem')
  assert(lineOf('red4ext').description:find('RED4ext is not loaded', 1, true) and lineOf('red4ext').description:find('Nexus Mods', 1, true))
  assert(lineOf('redscript').state == 'ok' and lineOf('redscript').description == 'Loaded.')
  assert(lineOf('codeware').state == 'problem')
  assert(table.concat(check.problems(), ',') == 'red4ext,codeware', table.concat(check.problems(), ','))
  assert(check.problemCount() == 2)
  -- the scripts did not compile either: the frameworks cannot be judged from them (Unknown). With no service of this session and nothing RED4ext loads answering, not even
  -- this mod's native plugin, RED4ext is still not loaded, and it comes first: without it Codeware's scripts never reach the compile
  files['runtime/knowledge-status.json'] = nil; advance(60)
  env.scripts, env.requirements = false, nil
  applyEnv(); check.run()
  assert(lineOf('red4ext').state == 'problem' and lineOf('red4ext').description:find('RED4ext is not loaded', 1, true))
  assert(lineOf('codeware').state == 'unknown' and lineOf('codeware').description == '')
  -- The launcher of this mod is a RED4ext plugin: its conversation service answering in this session proves RED4ext although the native plugin did not bind and the scripts did not
  -- compile (0.4.0 reports bbbc0ad4 and 4fdccb3f: a compile that broke in Mod Configuration Menu, "RED4ext is not loaded" in the Help page of a player whose service was running)
  serviceRunning(); advance(6); serviceRunning(); applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'redscript', table.concat(check.problems(), ','))
  assert(lineOf('red4ext').state == 'ok' and lineOf('red4ext').description == 'Loaded.')
  assert(lineOf('redscript').state == 'problem' and lineOf('codeware').state == 'unknown')
  -- the native plugin answers: RED4ext is loaded, and the scripts are the one problem
  env.native = true; applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'redscript', table.concat(check.problems(), ','))
  assert(lineOf('red4ext').state == 'ok')
  assert(lineOf('codeware').state == 'unknown')
  env.native = false
  env.scripts = true
  -- only Codeware missing (the scripts were compiled without it, RED4ext's native plugin answers): the others stay OK and the fix names it
  env.codeware, env.native, env.requirements, env.scripts = nil, true, '', true
  applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'codeware', table.concat(check.problems(), ','))
  assert(lineOf('codeware').description == 'Codeware is missing. Install it from Nexus Mods, then restart the game.', lineOf('codeware').description)
  assert(lineOf('red4ext').state == 'ok' and lineOf('redscript').state == 'ok')
  -- scripts of 0.2.1 and older (no ConvaiRequirements) imported Codeware: loaded, they imply it, even when the probe fails
  env.codeware, env.native, env.requirements = nil, false, nil
  applyEnv(); check.run()
  assert(lineOf('codeware').state == 'ok' and lineOf('codeware').description == 'Found.')
  assert(#check.problems() == 0)
  -- the scripts themselves missing while Codeware is there: redscript, with where its error is logged
  env.codeware, env.scripts = '1.20.5', false
  applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'redscript')
  assert(lineOf('redscript').description:find('redscript_rCURRENT.log', 1, true))
  assert(lineOf('codeware').state == 'ok')
  -- the native plugin alone also proves RED4ext
  env.codeware, env.scripts, env.native = nil, nil, true
  applyEnv(); check.run()
  assert(lineOf('red4ext').state == 'ok')
  -- no player (main menu): the scripts cannot be asked, so the line is Unknown and never a problem
  env.codeware, env.scripts, env.native, env.player = '1.20.5', true, false, false
  applyEnv(); check.run()
  assert(lineOf('redscript').state == 'unknown' and lineOf('redscript').value == 'Unknown' and #check.problems() == 0)
`));

test('the Companion Manager host: Mod Configuration Menu 0.10.5 or newer, or Native Settings UI; too old or missing is a problem with its own code and words', () => run(String.raw`
  installFiles(); serviceRunning()
  check.run()
  assert(lineOf('nsui').state == 'ok')
  env.nsui = 'old'; applyEnv(); check.run()
  assert(lineOf('nsui').state == 'problem' and table.concat(check.problems(), ',') == 'nsui')
  assert(lineOf('nsui').description == 'The Companion Manager needs Mod Configuration Menu 0.10.5 or newer, or Native Settings UI 1.96 or newer. Either one is enough. Install one from Nexus Mods, then restart the game.')
  local old = table.concat(check.reportLines(), '\n')
  assert(old:find('nsui: problem old', 1, true), old)
  env.nsui = 'none'; applyEnv(); check.run()
  assert(lineOf('nsui').description == 'The Companion Manager needs Mod Configuration Menu 0.10.5 or newer, or Native Settings UI 1.96 or newer. Either one is enough. Install one from Nexus Mods, then restart the game.')
  assert(table.concat(check.reportLines(), '\n'):find('nsui: problem missing', 1, true))
  -- Mod Configuration Menu 0.10.5 is the default host: it meets the requirement alone, and its line names it with its version.
  env.nsui, env.mcm = 'none', 'ok'; applyEnv(); check.run()
  assert(lineOf('nsui').state == 'ok' and lineOf('nsui').label == 'Mod Configuration Menu' and lineOf('nsui').description == 'Version 0.10.5.', tostring(lineOf('nsui').description))
  assert(#check.problems() == 0 and table.concat(check.reportLines(), '\n'):find('nsui: ok mcm 0.10.5', 1, true), table.concat(check.reportLines(), '\n'))
  -- Both installed: Mod Configuration Menu is the one named, Native Settings UI is the alternative and is not a problem either way.
  env.nsui = 'ok'; applyEnv(); check.run()
  assert(lineOf('nsui').label == 'Mod Configuration Menu' and #check.problems() == 0)
  env.nsui, env.mcm = 'old', 'ok'; applyEnv(); check.run()
  assert(#check.problems() == 0, 'an old Native Settings UI does not matter beside MCM 0.10.5')
  -- An older Mod Configuration Menu alone (no public interface for the page): update it. Beside a working Native Settings UI it is no problem.
  env.nsui, env.mcm = 'none', 'old'; applyEnv(); check.run()
  assert(lineOf('nsui').state == 'problem' and lineOf('nsui').label == 'Mod Configuration Menu' and table.concat(check.problems(), ',') == 'nsui')
  assert(lineOf('nsui').description == 'Mod Configuration Menu is too old. Update it to 0.10.5 or newer, or install Native Settings UI, then restart the game.', lineOf('nsui').description)
  assert(table.concat(check.reportLines(), '\n'):find('nsui: problem mcm-old', 1, true))
  env.nsui = 'ok'; applyEnv(); check.run()
  assert(#check.problems() == 0 and lineOf('nsui').label == 'Native Settings UI', 'Native Settings UI carries it when MCM is too old')
  env.nsui, env.mcm = 'ok', 'none'; applyEnv(); check.run()
`));

test('mod files: a missing catalog or locale, an unreadable folder, and the Scripts version', () => run(String.raw`
  installFiles(); serviceRunning()
  check.run()
  assert(check.summary()[2].id == 'files' and check.summary()[2].version == '0.2.1', 'the Scripts version comes from release.json')
  files['phone-contacts.json'] = nil
  files['locales/ko.lua'] = nil
  check.run()
  local item = lineOf('files')
  assert(item.state == 'problem' and item.description == 'Missing: phone-contacts.json, locales. Extract the Scripts zip into the Cyberpunk 2077 folder again and let it replace the files.', item.description)
  assert(table.concat(check.problems(), ',') == 'files')
  -- a folder list that fails falls back to the one file that proves the folder
  installFiles()
  dir = function() error('no such folder') end
  check.run()
  assert(lineOf('files').state == 'ok')
  files['locales/de.lua'] = nil
  check.run()
  assert(lineOf('files').state == 'problem' and lineOf('files').description:find('Missing: locales.', 1, true))
  -- no release.json (a development install): still fine, no version
  installFiles(); files['release.json'] = nil
  dir = function(folder)
    local list = {}
    for path in pairs(files) do local name = path:match('^locales/([^/]+)$'); if name and folder == 'locales' then list[#list + 1] = {name = name} end end
    return list
  end
  check.run()
  assert(lineOf('files').state == 'ok' and check.summary()[2].version == nil)
`));

test('the game version: the tested one is OK, another is a note and never a problem, none readable is Unknown', () => run(String.raw`
  installFiles(); serviceRunning()
  for _, version in ipairs({'2.31', '2.31.1', '2.31 hotfix'}) do
    env.gameVersion = version; applyEnv(); check.run()
    assert(lineOf('game').state == 'ok' and lineOf('game').description == 'Version ' .. version .. '.', version)
  end
  for _, version in ipairs({'2.32', '2.3', '2.310', '3.0'}) do
    env.gameVersion = version; applyEnv(); check.run()
    assert(lineOf('game').state == 'note' and lineOf('game').value == 'Note', version)
    assert(lineOf('game').description == 'Version ' .. version .. '. The mod is tested on 2.31 only, so some things may not work.')
    assert(#check.problems() == 0 and check.problemCount() == 0, 'a newer game is a note, not a problem')
  end
  env.gameVersion = nil; applyEnv(); check.run()
  assert(lineOf('game').state == 'unknown' and lineOf('game').description == 'The game version could not be read.')
  env.gameVersion = ('9'):rep(200); applyEnv(); check.run()
  assert(#lineOf('game').description < 150, 'a long version string is cut')
`));

test('two builds, one per game: the 2.5 build accepts 2.5 and names the Native Settings UI it needs, the wrong build for the running game is a Problem with the build to get', () => run(String.raw`
  installFiles(); serviceRunning()
  -- a release.json without a game field is the 2.31 build (every build before the 2.5 one); the game field names the build
  put('release.json', {product = 'AI-NPC-Cyberpunk-Mod', package = 'scripts', version = '0.3.1', game = '2.5'})
  for _, version in ipairs({'2.5', '2.50', '2.5.0', '2.50 hotfix'}) do
    env.gameVersion = version; applyEnv(); check.run()
    assert(lineOf('game').state == 'ok' and lineOf('game').description == 'Version ' .. version .. '.', version)
  end
  -- the 2.5 build on a later patch is only a note
  env.gameVersion = '2.51'; applyEnv(); check.run()
  assert(lineOf('game').state == 'note' and lineOf('game').description == 'Version 2.51. The mod is tested on 2.5 only, so some things may not work.', lineOf('game').description)
  -- the 2.5 build on a 2.31 game: a Problem that names both games
  env.gameVersion = '2.31'; applyEnv(); check.run()
  local wrong = lineOf('game')
  assert(wrong.state == 'problem' and wrong.description:find('mod build for game 2.5', 1, true) and wrong.description:find('install zip made for game 2.31', 1, true), wrong.description)
  -- the 2.31 build on a 2.5 game, with and without the game field
  put('release.json', {product = 'AI-NPC-Cyberpunk-Mod', package = 'scripts', version = '0.3.1', game = '2.31'})
  env.gameVersion = '2.5'; applyEnv(); check.run()
  assert(lineOf('game').state == 'problem' and lineOf('game').description:find('mod build for game 2.31', 1, true) and lineOf('game').description:find('install zip made for game 2.5', 1, true))
  put('release.json', {product = 'AI-NPC-Cyberpunk-Mod', package = 'scripts', version = '0.2.1'})
  check.run()
  assert(lineOf('game').state == 'problem' and lineOf('game').description:find('mod build for game 2.31', 1, true), 'no game field is the 2.31 build')
  -- an unreadable or unknown game field falls back to the 2.31 build
  put('release.json', {package = 'scripts', version = '0.3.1', game = 'banana'})
  env.gameVersion = '2.31'; applyEnv(); check.run()
  assert(lineOf('game').state == 'ok')
  -- the Native Settings UI the build was made against
  env.nsui, env.mcm = false, false; env.nsuiPresent = false; applyEnv()
  put('release.json', {package = 'scripts', version = '0.3.1', game = '2.5'})
  env.gameVersion = '2.5'; applyEnv(); check.run()
  local manager = lineOf('nsui')
  assert(manager.state == 'problem' and manager.description:find('Native Settings UI 1.97 or newer', 1, true), manager.description)
  put('release.json', {package = 'scripts', version = '0.3.1', game = '2.31'})
  env.gameVersion = '2.31'; applyEnv(); check.run()
  assert(lineOf('nsui').description:find('Native Settings UI 1.96 or newer', 1, true), lineOf('nsui').description)
`));

test('the conversation service: no trace, an incomplete Runtime, a failed start, a missing browser or key, starting, running and stopped', () => run(String.raw`
  installFiles()
  -- nothing of this session: the Runtime is missing or did not load
  check.run()
  assert(table.concat(check.problems(), ',') == 'service')
  local never = check.serviceLine()
  assert(never.value == 'Not running' and never.description:find('full install zip (AI-Companions-LLM) straight into the Cyberpunk 2077 folder', 1, true))
  assert(never.description:find('red4ext/plugins/AiNpcCyberpunkMod', 1, true))
  assert(not never.description:find('With a mod manager', 1, true), 'no manager, no manager hint')
  -- under a mod manager the Runtime missing row says how the full install zip goes in: one mod, the old separate mods removed first
  answer({['mod-manager'] = {id = 'mod-manager', state = 'note', code = 'mo2', managers = {'mo2'}}}); check.run()
  assert(check.serviceLine().description:sub(-#'With a mod manager: remove the old Scripts and Runtime mods, then install the full install zip as one mod.') == 'With a mod manager: remove the old Scripts and Runtime mods, then install the full install zip as one mod.')
  answer({}); check.run()
  -- the row says why (2026-10-24 triage): this mod's native plugin did not load, or it did and still nothing reported
  assert(check.inspect().game.checks.service.detail == 'plugin-not-loaded', 'no native plugin: the Runtime is missing or not loaded')
  env.native = true; applyEnv(); check.run()
  assert(check.inspect().game.checks.service.code == 'never' and check.inspect().game.checks.service.detail == 'no-launcher-trace', 'plugin loaded, no trace')
  assert(check.serviceLine().value == 'Not running', 'the line for the player is the same')
  env.native = false; applyEnv(); check.run()
  -- a status file from an earlier game session says nothing about this one
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'install-incomplete', updated = ms(-3600)})
  check.run()
  assert(table.concat(check.problems(), ',') == 'service', 'an hour-old failure is no trace of this session')
  -- the Runtime's own files missing
  for _, code in ipairs({'install-incomplete', 'bridge-missing', 'missing-character-ids', 'launcher-program-missing', 'launcher-directory-missing'}) do
    advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = code, updated = ms()})
    check.run()
    local line = check.serviceLine()
    assert(line and line.value == 'Not running' and line.description == 'The Runtime is incomplete (' .. code .. '). Extract the full install zip (AI-Companions-LLM) into the Cyberpunk 2077 folder again and let it replace the files, then restart the game.', code)
    assert(#check.problems() == 0, 'a failed service has its own notice (service-down), the first-load notice leaves it alone')
    assert(check.problemCount() == 1, 'but it counts on the page')
  end
  -- an older launcher that found no launcher.ini (a 0.2.3 Vortex report) says which file and what to do, in plain words
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'launcher-not-configured', updated = ms()})
  check.run()
  local launcherLine = check.serviceLine()
  assert(launcherLine and launcherLine.value == 'Not running' and launcherLine.description == 'The settings file of the launcher, launcher.ini, is missing from red4ext/plugins/AiNpcCyberpunkMod, so the game cannot start the conversation service. Extract the full install zip (AI-Companions-LLM) straight into the Cyberpunk 2077 folder again (by hand, also with Vortex) and let it replace the files, then restart the game.', launcherLine and launcherLine.description)
  assert(#check.problems() == 0 and check.problemCount() == 1)
  -- Mod Organizer 2 holding the Runtime's own file where the program cannot see it (report c44c3c95): not "extract the zip again", the one fix instead
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'install-incomplete', reason = 'mo2-hidden-file', updated = ms()})
  check.run()
  local hiddenLine = check.serviceLine()
  assert(hiddenLine and hiddenLine.value == 'Not running' and hiddenLine.description == 'Mod Organizer 2 does not show a file of the Runtime to the program. Close the game and Mod Organizer 2, extract the full install zip (AI-Companions-LLM) into the Cyberpunk 2077 folder by hand, then start the game.', hiddenLine and hiddenLine.description)
  assert(not hiddenLine.description:find('again', 1, true) and not hiddenLine.description:find('With a mod manager', 1, true))
  assert(#check.problems() == 0 and check.problemCount() == 1)
  -- any other reason, or one with odd characters, keeps the ordinary incomplete line
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'install-incomplete', reason = 'mo2-hidden-file; <b>', updated = ms()})
  check.run()
  assert(check.serviceLine().description:find('The Runtime is incomplete (install-incomplete).', 1, true))
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'bridge-crashed', reason = 'mo2-hidden-file', updated = ms()})
  check.run()
  assert(check.serviceLine().description:find('could not start (bridge-crashed)', 1, true), 'the word only counts with install-incomplete')
  -- any other failure: restart, then send a report; the code is kept short and plain
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'bridge-crashed', updated = ms()})
  check.run()
  assert(check.serviceLine().description == 'The conversation service could not start (bridge-crashed). Restart the game. If it happens again, generate a report below and send it.')
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'bad code; <script>', updated = ms()})
  check.run()
  assert(check.serviceLine().description:find('(?)', 1, true), 'a code with odd characters is not echoed')
  -- a missing browser and a missing key are explained by the existing row, not by a second sentence
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'browser-missing', updated = ms()})
  check.run()
  assert(check.serviceLine() == nil and check.summary()[1].code == 'browser-missing')
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'missing-key', updated = ms()})
  check.run()
  assert(check.serviceLine() == nil and check.summary()[1].code == 'missing-key')
  -- starting and running are not problems
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'starting', updated = ms()})
  check.run()
  assert(check.summary()[1].state == 'ok' and check.summary()[1].code == 'starting' and check.problemCount() == 0)
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'ready', updated = ms()})
  check.run()
  assert(check.summary()[1].code == 'running')
  -- it ran and went quiet
  advance(60)
  check.run()
  assert(check.summary()[1].state == 'problem' and check.summary()[1].code == 'stopped' and #check.problems() == 0 and check.serviceLine() == nil)
`));

// 27 Oct triage: two Discord players on Local AI had "Service not running" on the model row and nothing else. serviceWhy gives that row the reason.
test('serviceWhy: a service that is down says why on the Local AI model row, and a service that is up, starting or stopped on purpose says nothing', () => run(String.raw`
  installFiles()
  -- no trace of this session: the Runtime's plugin did not load, then the plugin is there and still nothing reported
  local why = check.serviceWhy()
  assert(why and why.label == 'Service not running (Runtime not loaded)', why and why.label)
  assert(why.description:find('Extract the full install zip (AI-Companions-LLM) straight into the Cyberpunk 2077 folder', 1, true) and why.description:find('newest log in red4ext/logs', 1, true))
  env.native = true; applyEnv()
  why = check.serviceWhy()
  assert(why.label == 'Service not running (Did not start)' and why.description:find('launcher.log in red4ext/plugins/AiNpcCyberpunkCode', 1, true), why.label)
  assert(why.key ~= check.serviceWhy().label, 'a key the page compares')
  env.native = false; applyEnv()
  -- the Runtime incomplete: its own sentence (the same as the Help page's)
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'install-incomplete', updated = ms()})
  why = check.serviceWhy()
  assert(why.label == 'Service not running (Runtime incomplete)' and why.description:find('The Runtime is incomplete (install-incomplete)', 1, true), why.description)
  -- Windows refused the start: the number the launcher wrote is in the sentence
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'launcher-failed', source = 'launcher', error = 1260, updated = ms()})
  why = check.serviceWhy()
  assert(why.label == 'Service not running (Could not start)' and why.description:find('(error 1260)', 1, true) and why.description:find('node.exe', 1, true), why.description)
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'launcher-failed', source = 'launcher', error = 'x; drop', updated = ms()})
  assert(check.serviceWhy().description:find('(error ?)', 1, true), 'an error that is not a number is not echoed')
  -- the service started and never reported / cannot see the mod folder / crashed
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'service-silent', updated = ms()})
  assert(check.serviceWhy().label == 'Service not running (Did not start)' and check.serviceWhy().description:find('security program', 1, true))
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'game-folder-not-visible', updated = ms()})
  assert(check.serviceWhy().description:find('virtual folders', 1, true))
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'bridge-crashed', updated = ms()})
  why = check.serviceWhy()
  assert(why.label == 'Service not running (Could not start)' and why.description:find('(bridge-crashed)', 1, true))
  -- no browser: the existing words
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'browser-missing', updated = ms()})
  why = check.serviceWhy()
  assert(why.label == 'Needs a browser' and why.description:find('Chromium browser', 1, true))
  -- starting, running: nothing to add
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'starting', updated = ms()})
  assert(check.serviceWhy() == nil)
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'ready', updated = ms()})
  assert(check.serviceWhy() == nil)
`));

test('the service answer is shown only from this game session and every check becomes one line with its fix', () => run(String.raw`
  installFiles(); serviceRunning()
  check.run()
  assert(ids() == 'files=ok game=ok cet=ok red4ext=ok redscript=ok codeware=ok nsui=ok', 'no answer yet: only the game side')
  -- an answer from an earlier game session (older than the mod's load) is ignored
  local old = answer(); old.updated = ms(-3600); put('runtime/setup-check.json', old)
  check.run()
  assert(not ids():find('browser', 1, true))
  answer(); check.run()
  assert(ids() == 'versions=ok files=ok game=ok cet=ok red4ext=ok redscript=ok codeware=ok nsui=ok packs=ok browser=ok local-ai=ok internet=ok gpu=ok mod-manager=ok', ids())
  assert(lineOf('versions').label == 'Scripts and Runtime' and lineOf('versions').description == 'Scripts 0.2.1 and Runtime 0.2.1.')
  assert(lineOf('packs').label == 'Optional packs' and lineOf('packs').description == 'None installed. They are optional.')
  assert(lineOf('browser').description == 'Found: Microsoft Edge.')
  assert(lineOf('local-ai').value == 'Not used' and lineOf('local-ai').description:find('Settings > Conversation provider', 1, true))
  assert(lineOf('internet').description == 'Reached api.convai.com.')
  assert(lineOf('gpu').label == 'Graphics card' and lineOf('gpu').description == 'NVIDIA GeForce RTX 4070, 12 GB of video memory.', lineOf('gpu').description)
  assert(lineOf('mod-manager').label == 'Mod manager' and lineOf('mod-manager').description == 'None found: installed by hand.')
  assert(check.problemCount() == 0)
  -- a card whose memory is unknown, and one with an exact number of gigabytes
  answer({gpu = {id = 'gpu', state = 'ok', code = 'found', name = 'AMD Radeon RX 7800 XT'}}); check.run()
  assert(lineOf('gpu').description == 'Found: AMD Radeon RX 7800 XT.')
  answer({gpu = {id = 'gpu', state = 'ok', code = 'found', name = 'NVIDIA GeForce RTX 3060', memoryMiB = 12288}}); check.run()
  assert(lineOf('gpu').description == 'NVIDIA GeForce RTX 3060, 12 GB of video memory.')
  -- Scripts and Runtime of different versions
  answer({versions = {id = 'versions', state = 'problem', code = 'mismatch', scripts = '0.2', runtime = '0.2.1'}}); check.run()
  -- the Scripts are the older one: update whichever is older, the Scripts from Nexus Mods
  assert(lineOf('versions').state == 'problem' and lineOf('versions').description == 'Scripts 0.2 and Runtime 0.2.1 do not match. If the Scripts are older, install the update zip from Nexus Mods. If the Runtime is older, install the full install zip (AI-Companions-LLM). Extract into the Cyberpunk 2077 folder, then restart the game.')
  -- the Runtime is the older one (nearly every report): the full install zip, no steps to apply in order. No version number in the instruction.
  answer({versions = {id = 'versions', state = 'problem', code = 'mismatch', scripts = '0.2.8', runtime = '0.2.4'}}); check.run()
  local older = lineOf('versions').description
  assert(older == 'Scripts 0.2.8 and Runtime 0.2.4 do not match: the Runtime is out of date. Extract the full install zip (AI-Companions-LLM, on Nexus Mods) into the Cyberpunk 2077 folder, then restart the game.', older)
  assert(not older:sub(older:find('out of date')):find('%d%.%d'), 'no version number after the status')
  answer({versions = {id = 'versions', state = 'problem', code = 'mismatch', scripts = '0.2.10', runtime = '0.2.9'}}); check.run()
  assert(lineOf('versions').description:find('the Runtime is out of date', 1, true), 'compared as numbers, not as text')
  answer({versions = {id = 'versions', state = 'problem', code = 'mismatch', scripts = '0.2', runtime = '0.2.1'}}); check.run()
  assert(table.concat(check.problems(), ',') == 'versions' and check.lines()[1].id == 'versions', 'the versions line sits first, next to the service')
  -- the same version, built for different games: the 'Build for your game' row names both games and the Runtime to get (every combination: bridge/setup-check-build.test.mjs)
  put('release.json', {product = 'AI-NPC-Cyberpunk-Mod', package = 'scripts', version = '0.3.1', game = '2.5'}); env.gameVersion = '2.5'; applyEnv()
  answer({versions = {id = 'versions', state = 'problem', code = 'game-mismatch', scripts = '0.3.1', runtime = '0.3.1', scriptsGame = '2.5', runtimeGame = '2.31'}}); check.run()
  assert(lineOf('versions') == nil, 'the build row replaces the versions row')
  assert(lineOf('build').state == 'problem' and lineOf('build').label == 'Build for your game' and lineOf('build').description:find('the Runtime is the one for game 2.31', 1, true), tostring(lineOf('build') and lineOf('build').description))
  assert(table.concat(check.problems(), ',') == 'build', 'a pure game mismatch is one problem, not also a versions problem')
  installFiles(); env.gameVersion = '2.31'; applyEnv(); check.run()
  -- the versions agree but an update step was skipped: the step is named, the instruction carries no version number
  answer({versions = {id = 'versions', state = 'problem', code = 'chain-gap', scripts = '0.2.9', runtime = '0.2.9', from = '0.2.7', to = '0.2.8'}}); check.run()
  local gap = lineOf('versions').description
  assert(lineOf('versions').state == 'problem' and gap == 'The Runtime update from 0.2.7 to 0.2.8 was never applied, so some Runtime files are old. Extract the full install zip (AI-Companions-LLM, on Nexus Mods) into the Cyberpunk 2077 folder, then restart the game.', gap)
  assert(not gap:sub(gap:find('never applied')):find('%d%.%d'), 'no version number after the naming')
  assert(table.concat(check.problems(), ',') == 'versions')
  answer({versions = {id = 'versions', state = 'problem', code = 'chain-order', scripts = '0.2.8', runtime = '0.2.8'}}); check.run()
  assert(lineOf('versions').state == 'problem' and lineOf('versions').description:find('Extract the full install zip (AI-Companions-LLM, on Nexus Mods) into the Cyberpunk 2077 folder again', 1, true))
  -- from 0.3.4 the code is in the Scripts and the Runtime is the base: the row names the base, and an older base the base needed
  answer({versions = {id = 'versions', state = 'ok', code = 'match', scripts = '0.3.4', runtime = '0.3.3', required = '0.3.3', base = true}}); check.run()
  assert(lineOf('versions').state == 'ok' and lineOf('versions').description == 'Scripts 0.3.4 on Runtime base 0.3.3.', lineOf('versions').description)
  answer({versions = {id = 'versions', state = 'problem', code = 'base-old', scripts = '0.3.4', runtime = '0.3.2', required = '0.3.3', base = true}}); check.run()
  assert(lineOf('versions').state == 'problem' and lineOf('versions').description:find('need the Runtime base 0.3.3 or newer, and your Runtime is 0.3.2', 1, true))
  assert(table.concat(check.problems(), ',') == 'versions')
  -- a version check that could not be made shows no line
  answer({versions = {id = 'versions', state = 'unknown', code = 'unknown'}}); check.run()
  assert(lineOf('versions') == nil)
`));

test('optional packs: found, moved by the launcher, one folder too deep, and files it could not move', () => run(String.raw`
  installFiles(); serviceRunning()
  answer({packs = {id = 'packs', state = 'ok', code = 'ok', found = {'Local AI standard', 'OmniVoice'}, nested = {}, moved = {{pack = 'Mature lite', from = 'Mature-pack'}}}}); check.run()
  assert(lineOf('packs').state == 'ok' and lineOf('packs').description == 'Found: Local AI standard, OmniVoice.\nMoved into place from Mature-pack: Mature lite.', lineOf('packs').description)
  answer({packs = {id = 'packs', state = 'problem', code = 'nested', found = {}, nested = {{pack = 'Local AI standard', folder = 'AI-NPC-Local-AI-0.2.1'}, {pack = 'OmniVoice', folder = 'other'}}, moved = {}}}); check.run()
  assert(lineOf('packs').state == 'problem' and lineOf('packs').description == 'Local AI standard is one folder too deep, in AI-NPC-Local-AI-0.2.1. Restart the game and the mod moves it into place. If it is still there afterwards, move the red4ext folder inside it into the Cyberpunk 2077 folder.')
  assert(table.concat(check.problems(), ',') == 'packs')
  answer({packs = {id = 'packs', state = 'problem', code = 'conflict', found = {}, nested = {}, moved = {}}}); check.run()
  assert(lineOf('packs').description:find('could not be moved into place because different files are already there', 1, true))
  assert(table.concat(check.problems(), ',') == 'packs')
`));

test('omni-python: the own Python for OmniVoice names its backend or why it was refused, on the Help page and once in probe.log', () => run(String.raw`
  installFiles(); serviceRunning()
  answer({}); check.run()
  assert(lineOf('omni-python') == nil, 'no omni-python.txt, no line')
  answer({['omni-python'] = {id = 'omni-python', state = 'ok', code = 'used', backend = 'rocm', device = 'AMD Radeon RX 9070 XT', memoryMiB = 16304}}); check.run()
  assert(lineOf('omni-python').state == 'ok' and lineOf('omni-python').description == 'Your own Python (omni-python.txt) runs OmniVoice with ROCm on AMD Radeon RX 9070 XT, 15.9 GB. Experimental.', tostring(lineOf('omni-python').description))
  assert(files['runtime/probe.log']:find('Setup check: omni-python used backend=rocm card=AMD Radeon RX 9070 XT memoryMiB=16304', 1, true), tostring(files['runtime/probe.log']))
  check.run()
  local _, said = files['runtime/probe.log']:gsub('omni%-python used', '')
  assert(said == 1, 'the same answer is logged once')
  answer({['omni-python'] = {id = 'omni-python', state = 'ok', code = 'used', backend = 'cuda', device = 'NVIDIA GeForce RTX 4070'}}); check.run()
  assert(lineOf('omni-python').description == 'Your own Python (omni-python.txt) runs OmniVoice with CUDA on NVIDIA GeForce RTX 4070. Experimental.', tostring(lineOf('omni-python').description))
  local reasons = {
    {'no-gpu', 'its PyTorch finds no graphics card (no CUDA or ROCm)'}, {'not-found', 'the file does not name a python.exe that exists'},
    {'no-torch', 'PyTorch is not installed in it'}, {'op-failed', 'a test on the graphics card failed'}, {'no-pack', 'the OmniVoice pack is not installed'},
    {'timed-out', 'it did not start or did not answer in time'}, {'omnivoice-failed', 'OmniVoice’s code could not load in it'},
  }
  for _, case in ipairs(reasons) do
    answer({['omni-python'] = {id = 'omni-python', state = 'problem', code = 'refused', reason = case[1], backend = 'none'}}); check.run()
    assert(lineOf('omni-python').state == 'problem' and lineOf('omni-python').description == 'Your own Python (omni-python.txt) was not used: ' .. case[2] .. '. OmniVoice uses the Runtime’s Python, which needs an NVIDIA card.', case[1] .. ': ' .. tostring(lineOf('omni-python').description))
  end
  answer({['omni-python'] = {id = 'omni-python', state = 'problem', code = 'refused', reason = 'missing-module', module = 'transformers', backend = 'rocm'}}); check.run()
  assert(lineOf('omni-python').description:find('the module transformers is missing in it', 1, true), tostring(lineOf('omni-python').description))
  assert(files['runtime/probe.log']:find('omni-python refused backend=rocm reason=missing-module module=transformers', 1, true))
  assert(#check.problems() == 0, 'an experimental setup is no first-load notice')
  -- The AMD setup's own Python (Settings > Voices > OmniVoice for AMD) has its own words, not omni-python.txt's.
  answer({['omni-python'] = {id = 'omni-python', state = 'ok', code = 'used', managed = true, backend = 'rocm', device = 'AMD Radeon RX 9070 XT', memoryMiB = 16304}}); check.run()
  assert(lineOf('omni-python').state == 'ok' and lineOf('omni-python').description:find('^The AMD setup %(Settings > Voices > OmniVoice for AMD%) runs OmniVoice with ROCm on AMD Radeon RX 9070 XT, 15.9 GB.'), tostring(lineOf('omni-python').description))
  answer({['omni-python'] = {id = 'omni-python', state = 'problem', code = 'refused', managed = true, reason = 'op-failed', backend = 'rocm'}}); check.run()
  assert(lineOf('omni-python').description == 'The AMD setup was not used: a test on the graphics card failed. Choose Reinstall in Settings > Voices > OmniVoice for AMD. Until then Pocket speaks.', tostring(lineOf('omni-python').description))
  answer({['omni-python'] = {id = 'omni-python', state = 'unknown', code = 'testing'}}); check.run()
  assert(lineOf('omni-python').state == 'note' and lineOf('omni-python').description:find('being tested', 1, true))
  answer({['omni-python'] = {id = 'omni-python', state = 'unknown', code = 'untested'}}); check.run()
  assert(lineOf('omni-python').state == 'note' and lineOf('omni-python').description:find('tested when OmniVoice starts', 1, true))
  answer({['omni-python'] = {id = 'omni-python', state = 'note', code = 'amd-route', device = 'AMD Radeon RX 9070 XT'}}); check.run()
  assert(lineOf('omni-python').state == 'note' and lineOf('omni-python').description:find('^Your AMD Radeon card %(AMD Radeon RX 9070 XT%) can run OmniVoice. Set it up in Settings > Voices > OmniVoice for AMD') and not lineOf('omni-python').description:find('OMNIVOICE_AMD', 1, true), tostring(lineOf('omni-python').description))
  assert(#check.problems() == 0 and files['runtime/probe.log']:find('omni-python amd-route', 1, true))
`));

test('the microphone: the input in use, chosen or the Windows default, and a note when the chosen one is not connected', () => run(String.raw`
  installFiles(); serviceRunning()
  answer({}); check.run()
  assert(lineOf('microphone') == nil, 'no row before an input was opened or chosen')
  answer({microphone = {id = 'microphone', state = 'ok', code = 'default', device = 'Microphone (Realtek(R) Audio)'}}); check.run()
  assert(lineOf('microphone').state == 'ok' and lineOf('microphone').label == 'Microphone'
    and lineOf('microphone').description == 'Microphone (Realtek(R) Audio), the Windows default input. Settings > Voices > Microphone chooses another.', tostring(lineOf('microphone').description))
  answer({microphone = {id = 'microphone', state = 'ok', code = 'chosen', device = 'Headset Mic (USB)', chosen = 'Headset Mic (USB)'}}); check.run()
  assert(lineOf('microphone').state == 'ok' and lineOf('microphone').description == 'Headset Mic (USB), chosen in Settings > Voices.', tostring(lineOf('microphone').description))
  local listed = false
  for _, reported in ipairs(check.reportLines()) do if reported == 'service microphone: ok chosen device=Headset Mic (USB)' then listed = true end end
  assert(listed, 'the report lists the input in use, by its label')
  answer({microphone = {id = 'microphone', state = 'note', code = 'missing', device = 'Microphone (Realtek(R) Audio)', chosen = 'Headset Mic (USB)'}}); check.run()
  assert(lineOf('microphone').state == 'note' and lineOf('microphone').description:find('Headset Mic (USB)', 1, true) and lineOf('microphone').description:find('is not connected', 1, true)
    and lineOf('microphone').description:find('Microphone (Realtek(R) Audio)', 1, true), tostring(lineOf('microphone').description))
  assert(#check.problems() == 0, 'a note is not a problem')
  answer({microphone = {id = 'microphone', state = 'note', code = 'loopback', device = 'Default - Stereo Mix (Realtek(R) Audio)'}}); check.run()
  assert(lineOf('microphone').state == 'note' and lineOf('microphone').description:find('Default - Stereo Mix (Realtek(R) Audio)', 1, true)
    and lineOf('microphone').description:find('carries PC sound', 1, true) and lineOf('microphone').description:find('Settings > Voices > Microphone', 1, true), tostring(lineOf('microphone').description))
  assert(#check.problems() == 0, 'the loopback note is not a problem')
`));

test('the browser, Local AI and the internet: every state has its own line and fix', () => run(String.raw`
  installFiles(); serviceRunning()
  answer({browser = {id = 'browser', state = 'problem', code = 'missing'}}); check.run()
  assert(lineOf('browser').state == 'problem' and lineOf('browser').description == 'The conversation service needs a Chromium browser such as Microsoft Edge, Google Chrome, Brave or Opera. Install one, or put the path of yours in a browser.txt file next to launcher.ini, then restart the game.')
  assert(#check.problems() == 0, 'a missing browser is told by the service status and its own notice')
  answer({browser = {id = 'browser', state = 'unknown', code = 'unknown'}}); check.run()
  assert(lineOf('browser') == nil, 'a browser not looked up yet (the first, light answer) shows no line')
  -- The Pocket voice: a line only when it failed to start, and it says nothing needs installing.
  answer({voice = {id = 'voice', state = 'ok', code = 'ok'}}); check.run()
  assert(lineOf('voice') == nil, 'a working Pocket voice needs no line')
  answer({voice = {id = 'voice', state = 'problem', code = 'pocket-failed', engine = 'v-helper'}}); check.run()
  assert(lineOf('voice').state == 'problem' and lineOf('voice').description:find('nothing else needs installing', 1, true) and lineOf('voice').description:find('generate a report', 1, true), tostring(lineOf('voice').description))
  assert(#check.problems() == 0, 'it has no first-load notice: the Help page tells it')
  -- Windows refused to load a file of the voice: restarting cannot help, so the line names what blocked it and offers another voice.
  answer({voice = {id = 'voice', state = 'problem', code = 'pocket-failed', engine = 'pocket', cause = 'blocked'}}); check.run()
  assert(lineOf('voice').state == 'problem' and lineOf('voice').description:find('blocks the files of the voice', 1, true) and lineOf('voice').description:find('Smart App Control', 1, true)
    and lineOf('voice').description:find('Choose a cloud voice (Voxtral) in Settings', 1, true) and not lineOf('voice').description:find('OmniVoice', 1, true)
    and not lineOf('voice').description:find('Restart', 1, true), tostring(lineOf('voice').description))
  assert(#check.problems() == 0)
  -- Windows ran out of memory it can promise (error 1455): restarting cannot help, a larger paging file or fewer programs can; the same sentence as the in-game notice.
  answer({voice = {id = 'voice', state = 'problem', code = 'pocket-failed', engine = 'pocket', cause = 'virtual-memory'}}); check.run()
  assert(lineOf('voice').state == 'problem' and lineOf('voice').description == 'Windows ran out of memory for the voice. A larger paging file or closing other apps helps.', tostring(lineOf('voice').description))
  assert(#check.problems() == 0)
  -- Local AI whose model server Windows would not run: the same advice, for a cloud conversation provider; a plain start failure keeps its own line.
  answer({['local-ai'] = {id = 'local-ai', state = 'problem', code = 'start-failed', selected = true, cause = 'blocked'}}); check.run()
  assert(lineOf('local-ai').state == 'problem' and lineOf('local-ai').description:find('blocks the files of the model server', 1, true)
    and lineOf('local-ai').description:find('Choose a cloud conversation provider in Settings', 1, true) and not lineOf('local-ai').description:find('OmniVoice', 1, true), tostring(lineOf('local-ai').description))
  answer({['local-ai'] = {id = 'local-ai', state = 'problem', code = 'start-failed', selected = true}}); check.run()
  assert(lineOf('local-ai').description:find('Local AI could not start', 1, true), 'without the cause the generic line stays')
  answer({voice = {id = 'voice', state = 'unknown', code = 'unknown'}}); check.run()
  assert(lineOf('voice') == nil)
  local states = {
    {'ready', 'ok', 'Local AI is ready.'}, {'warming', 'ok', 'Local AI is warming up…'},
    {'not-installed', 'problem', 'No Local AI pack found. Download one from the mod’s Hugging Face page and extract it into the Cyberpunk 2077 folder, or choose another conversation provider.'},
    {'no-memory', 'problem', 'Not enough free graphics memory to start Local AI. Try a smaller model in Settings.'},
    {'mature-off', 'problem', 'Only Mature models found. Turn on Mature content to use them.'},
    {'no-gpu', 'problem', 'Local AI found no graphics card it can use. It needs an NVIDIA or AMD card with a current driver. Update the driver, or choose another conversation provider.'},
    {'start-failed', 'problem', 'Local AI could not start. Generate a report below and send it, or choose another conversation provider.'},
    {'crashed', 'problem', 'Local AI could not start. Generate a report below and send it, or choose another conversation provider.'},
  }
  for _, case in ipairs(states) do
    answer({['local-ai'] = {id = 'local-ai', state = case[2], code = case[1], selected = true}}); check.run()
    assert(lineOf('local-ai').state == case[2] and lineOf('local-ai').description == case[3], case[1] .. ': ' .. tostring(lineOf('local-ai').description))
  end
  assert(#check.problems() == 0, 'Local AI has its own fallback notices; it is not announced at the first load')
  local internet = {
    {'no-dns', 'This PC cannot look up api.mistral.ai. Check your internet connection, then restart the game.'},
    {'blocked', 'The conversation service cannot reach api.mistral.ai. Allow Node.js through your firewall or antivirus (Windows asks once; choose Allow), check your internet, then restart the game.'},
    {'timeout', 'The conversation service cannot reach api.mistral.ai. Allow Node.js through your firewall or antivirus (Windows asks once; choose Allow), check your internet, then restart the game.'},
  }
  for _, case in ipairs(internet) do
    answer({internet = {id = 'internet', state = 'problem', code = case[1], service = 'mistral', host = 'api.mistral.ai'}}); check.run()
    assert(lineOf('internet').state == 'problem' and lineOf('internet').description == case[2], case[1])
  end
  assert(table.concat(check.problems(), ',') == 'internet')
  answer({internet = {id = 'internet', state = 'ok', code = 'not-needed'}}); check.run()
  assert(lineOf('internet').description == 'Not needed: Local AI and the voice run on this PC.')
  answer({internet = {id = 'internet', state = 'unknown', code = 'unknown', service = 'convai', host = 'api.convai.com'}}); check.run()
  assert(lineOf('internet') == nil, 'a connection test not made yet shows no line')
`));

test('mod managers are a note with the one thing that matters for each', () => run(String.raw`
  installFiles(); serviceRunning()
  answer({['mod-manager'] = {id = 'mod-manager', state = 'note', code = 'mo2', managers = {'mo2'}}}); check.run()
  assert(lineOf('mod-manager').state == 'note' and lineOf('mod-manager').value == 'Note')
  assert(lineOf('mod-manager').description == 'Mod Organizer 2. Files the mod creates go to its Overwrite folder; leave them there. Install the full install zip as one mod and update that mod with each new full install zip. Extract multilingual packs into that mod’s folder, not as new mods. Mention Mod Organizer 2 when you send a report.')
  -- Under a mod manager (Mod Organizer 2 or Vortex) a version or update-step problem says how to install the full install zip as one mod; elsewhere it does not
  local mo2 = {['mod-manager'] = {id = 'mod-manager', state = 'note', code = 'mo2', managers = {'mo2'}}}
  local hint = 'With a mod manager: remove the old Scripts and Runtime mods, then install the full install zip as one mod.'
  for _, versions in ipairs({{id = 'versions', state = 'problem', code = 'mismatch', scripts = '0.2.8', runtime = '0.2.4'},
      {id = 'versions', state = 'problem', code = 'chain-gap', scripts = '0.2.9', runtime = '0.2.9', from = '0.2.7', to = '0.2.8'}}) do
    answer({versions = versions, ['mod-manager'] = mo2['mod-manager']}); check.run()
    assert(lineOf('versions').description:sub(-#hint - 1) == "\n" .. hint, 'MO2 hint on ' .. versions.code)
    answer({versions = versions, ['mod-manager'] = {id = 'mod-manager', state = 'note', code = 'vortex', managers = {'vortex'}}}); check.run()
    assert(lineOf('versions').description:sub(-#hint - 1) == "\n" .. hint, 'the same hint on ' .. versions.code .. ' under Vortex')
    answer({versions = versions}); check.run()
    assert(not lineOf('versions').description:find('With a mod manager', 1, true), 'no hint without a mod manager')
  end
  answer({versions = {id = 'versions', state = 'ok', code = 'match', scripts = '0.2.9', runtime = '0.2.9'}, ['mod-manager'] = mo2['mod-manager']}); check.run()
  assert(not lineOf('versions').description:find('With a mod manager', 1, true), 'an agreeing version has nothing to say about it')
  answer({['mod-manager'] = {id = 'mod-manager', state = 'note', code = 'vortex', managers = {'vortex'}}}); check.run()
  assert(lineOf('mod-manager').description == 'Vortex. Install the optional packs by hand into the Cyberpunk 2077 folder, as the install steps say. Install the full install zip as one mod and update that mod with each new full install zip.')
  assert(check.problemCount() == 0 and #check.problems() == 0, 'a mod manager is never a problem')
`));

test('a hostile or malformed answer never raises and never puts control characters or long text on the page', () => run(String.raw`
  installFiles(); serviceRunning()
  -- documents of the wrong shape are not read at all
  for _, wrong in ipairs({'{"version":2,"updated":1,"checks":[]}', '{"version":1,"checks":{}}', '[]', 'not json', '', '{"version":1,"updated":"now","checks":[]}'}) do
    put('runtime/setup-check.json', wrong); check.run()
    assert(not ids():find('browser', 1, true), wrong)
  end
  local long = ('x'):rep(5000)
  local hostile = {
    {id = 'versions', state = 'problem', code = 'mismatch', scripts = long, runtime = 42},
    {id = 'packs', state = 'problem', code = 'nested', found = {7, {}, long}, nested = {{pack = long, folder = long}, 'text', 5}, moved = 'no'},
    {id = 'browser', state = 'ok', code = 'found', name = 'Edge' .. string.char(1, 2, 10) .. long},
    {id = 'local-ai', code = 99},
    {id = 'internet', state = 'problem', code = 'blocked', host = {1, 2}},
    {id = 'gpu', code = 'found', name = long, memoryMiB = 'lots'},
    'not a table', 12, {id = 7},
    {id = 'mod-manager', code = 'unheard-of', managers = long},
  }
  local document = {version = 1, updated = ms(), checks = hostile}
  put('runtime/setup-check.json', document)
  check.run()
  local lines = check.lines()
  assert(#lines >= 9)
  for _, item in ipairs(lines) do
    assert(#item.description < 700, item.id .. ' ' .. #item.description)
    assert(not item.description:gsub('\n', ''):find('%c') and not item.label:find('%c') and not item.value:find('%c'), item.id)
  end
  assert(check.problemCount() >= 1)
  for _, text in ipairs(check.reportLines()) do assert(#text < 700 and not text:find('%c'), text) end
`));

test('opening the Help page asks a running service once and follows its answer; nothing is asked of a service that is not running', () => run(String.raw`
  installFiles(); serviceRunning()
  check.run()
  local signature = check.signature()
  -- nothing happens until the page asks; then the next tick runs the checks and writes the request in place
  check.tick(true, true)
  assert(files['runtime/setup-check-request.json'] == nil)
  check.refresh()
  check.tick(true, true)
  local request = json.decode(files['runtime/setup-check-request.json'])
  assert(request.version == 1 and request.id:match('^s%d+%-1$') and request.issuedAt == clock * 1000, files['runtime/setup-check-request.json'])
  assert(check.inspect().pending.id == request.id)
  -- the file is rewritten in place: opened for writing, never removed or renamed
  assert(#removed == 0)
  -- another request's answer is ignored; the right one is taken and changes the page's signature
  answer({}, 'someone-else')
  advance(2); check.tick(true, true)
  assert(check.inspect().pending and not ids():find('browser', 1, true))
  answer({browser = {id = 'browser', state = 'ok', code = 'found', name = 'Brave'}}, request.id)
  advance(1); check.tick(true, true)
  assert(check.inspect().pending == nil and lineOf('browser').description == 'Found: Brave.')
  assert(check.signature() ~= signature, 'the page redraws when the answer arrives')
  -- an unanswered request is followed for 15 seconds only
  check.refresh(); advance(5); check.tick(true, true)
  local pending = check.inspect().pending
  assert(pending)
  advance(16); check.tick(true, true)
  assert(check.inspect().pending == nil)
  -- no service, no request: the file is left as it was
  files['runtime/knowledge-status.json'] = nil
  advance(60)
  local before = files['runtime/setup-check-request.json']
  check.refresh(); check.tick(true, true)
  assert(files['runtime/setup-check-request.json'] == before and check.inspect().pending == nil)
`));

test('the first load: nothing for twelve seconds, then one notice for the first critical problem, once', () => run(String.raw`
  installFiles(); serviceRunning()
  env.nsui = 'none'; applyEnv()
  -- in the main menu there is no player: the timer does not start
  for _ = 1, 20 do advance(1); assert(check.tick(false, false) == nil) end
  assert(check.inspect().firstDue == nil and opens() == 0 and #console == 0)
  -- a session starts: the timer is set on the first tick, and twelve seconds later the check runs and the service is asked
  serviceRunning()
  assert(check.tick(true, true) == nil)
  assert(check.inspect().firstDue == clock + 12)
  advance(11); assert(check.tick(true, true) == nil and files['runtime/setup-check-request.json'] == nil)
  advance(1); assert(check.tick(true, true) == nil)
  local request = json.decode(files['runtime/setup-check-request.json'])
  assert(request and check.inspect().pending.id == request.id, 'the service is asked for its full answer first')
  assert(not check.inspect().firstDone, 'the notice waits for the answer')
  answer({}, request.id)
  advance(1)
  local notice = check.tick(true, true)
  assert(notice == 'The Companion Manager needs Mod Configuration Menu 0.10.5 or newer, or Native Settings UI', tostring(notice))
  assert(check.inspect().firstDone)
  -- without Native Settings UI the CET console and probe.log say it too, in English
  assert(#console == 1 and console[1] == '[AiNpcCyberpunkMod] AI NPC Cyberpunk Mod: the Companion Manager needs Mod Configuration Menu 0.10.5 or newer, or Native Settings UI 1.96 or newer, and neither was found. Install Mod Configuration Menu (https://www.nexusmods.com/cyberpunk2077/mods/31640) or Native Settings UI (https://www.nexusmods.com/cyberpunk2077/mods/3518) from Nexus Mods, then restart the game.', console[1])
  local log = files['runtime/probe.log']
  assert(log:find('Setup check: problems: nsui', 1, true) and log:find('neither was found', 1, true), log)
  -- once per game session
  for _ = 1, 50 do advance(1); assert(check.tick(true, true) == nil) end
  assert(#console == 1)
`));

test('the first load without a running service decides at once, and names a service that never started', () => run(String.raw`
  installFiles()
  check.tick(true, true)
  advance(12)
  local notice = check.tick(true, true)
  assert(files['runtime/setup-check-request.json'] == nil and check.inspect().pending == nil, 'nothing is asked of a service that is not running')
  assert(notice == 'The conversation service did not start. Is the Runtime installed? See Help in Settings.', tostring(notice))
  assert(#console == 0, 'Native Settings UI is there, so the console stays quiet')
`));

test('the first load announces one problem: the most fundamental, in the fixed order', () => run(String.raw`
  installFiles(); serviceRunning()
  -- Codeware and Native Settings UI both missing: Codeware first; the console still names Native Settings UI
  env.codeware, env.native, env.requirements, env.nsui = nil, true, '', 'none'; applyEnv()
  check.tick(true, true); advance(12); check.tick(true, true)
  local request = json.decode(files['runtime/setup-check-request.json'])
  answer({}, request.id); advance(1)
  local notice = check.tick(true, true)
  assert(notice == 'Codeware is missing. Install it from Nexus Mods, then restart the game.', tostring(notice))
  -- the console says each of them once, in English: the missing requirement and Native Settings UI
  assert(#console == 2 and console[1] == '[AiNpcCyberpunkMod] AI NPC Cyberpunk Mod: Codeware is missing. Install it from Nexus Mods, then restart the game.', console[1])
  assert(console[2]:find('neither was found', 1, true))
  assert(table.concat(check.problems(), ',') == 'codeware,nsui', table.concat(check.problems(), ','))
`));

test('RED4ext and Codeware both missing is one grouped notice naming both, and the console says each once', () => run(String.raw`
  installFiles(); serviceRunning()
  env.codeware, env.native, env.requirements = nil, false, ''; applyEnv()
  assert(table.concat(check.problems(), ',') == 'red4ext,codeware', table.concat(check.problems(), ','))
  check.tick(true, true); advance(12); check.tick(true, true)
  answer({}, json.decode(files['runtime/setup-check-request.json']).id); advance(1)
  local notice = check.tick(true, true)
  assert(notice == 'Missing: RED4ext, Codeware. Install them and restart the game.', tostring(notice))
  assert(#console == 2 and console[1]:find('RED4ext is missing', 1, true) and console[2]:find('Codeware is missing', 1, true), table.concat(console, ' | '))
  assert(files['runtime/probe.log']:find('Setup check: problems: red4ext, codeware', 1, true))
`));

test('Codeware that is too old is its own sentence, in the Help line, the notice and the console', () => run(String.raw`
  installFiles(); serviceRunning()
  env.requirements, env.codeware = 'codeware', '1.12.0'; applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'codeware' and lineOf('codeware').description == 'Codeware is too old. Update it from Nexus Mods, then restart the game.')
  check.tick(true, true); advance(12); check.tick(true, true)
  answer({}, json.decode(files['runtime/setup-check-request.json']).id); advance(1)
  assert(check.tick(true, true) == 'Codeware is too old. Update it from Nexus Mods, then restart the game.')
  assert(#console == 1 and console[1]:find('Codeware is too old', 1, true), console[1])
`));

// Audioware and TweakXL are no requirements: with or without them nothing is said, listed, reported or asked of them
test('a game WITH Audioware and TweakXL installed gets no notice, no line, no console message and no report row for them, and nothing asks them anything', () => run(String.raw`
  installFiles(); serviceRunning()
  assert(env.tweakxl and env.audioware, 'the fixture game has both')
  check.run()
  assert(ids() == 'files=ok game=ok cet=ok red4ext=ok redscript=ok codeware=ok nsui=ok', ids())
  assert(lineOf('tweakxl') == nil and lineOf('audioware') == nil)
  assert(check.problemCount() == 0 and #check.problems() == 0)
  check.tick(true, true); advance(12); check.tick(true, true)
  answer({}, json.decode(files['runtime/setup-check-request.json']).id); advance(1)
  assert(check.tick(true, true) == nil, 'no notice')
  assert(#console == 0, table.concat(console, ' | '))
  local lines = table.concat(check.reportLines(), '\n'):lower()
  assert(not lines:find('audioware', 1, true) and not lines:find('tweakxl', 1, true), lines)
  assert(not files['runtime/probe.log']:lower():find('audioware', 1, true) and not files['runtime/probe.log']:lower():find('tweakxl', 1, true))
  for _, row in ipairs(check.summary()) do assert(row.id ~= 'audioware' and row.id ~= 'tweakxl', row.id) end
  assert(retiredProbes == 0, 'asked ' .. retiredProbes .. ' times')
  -- the same with the scripts compiled with every word there is (new scripts): still nothing about them
  env.requirements = 'codeware codeware-ui codeware-textinput'; applyEnv(); check.run()
  assert(#check.problems() == 0 and lineOf('audioware') == nil and retiredProbes == 0)
  -- both installed beside a real problem: only the real problem is named
  env.codeware, env.native, env.requirements = nil, true, ''; applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'codeware' and retiredProbes == 0)
  assert(not (lineOf('codeware').description .. check.reportLines()[1]):lower():find('audioware', 1, true))
`));

test('a game WITHOUT Audioware and TweakXL is fully OK, with the scripts of 0.2.1 and older and with the newer ones', () => run(String.raw`
  installFiles(); serviceRunning()
  env.tweakxl, env.audioware = nil, nil; applyEnv(); check.run()
  assert(ids() == 'files=ok game=ok cet=ok red4ext=ok redscript=ok codeware=ok nsui=ok', ids())
  assert(check.problemCount() == 0 and #check.problems() == 0)
  env.requirements = 'codeware codeware-ui codeware-textinput'; applyEnv(); check.run()
  assert(ids() == 'files=ok game=ok cet=ok red4ext=ok redscript=ok codeware=ok nsui=ok', ids())
  assert(#check.problems() == 0 and check.requirement('codeware') == true)
  check.tick(true, true); advance(12); check.tick(true, true)
  answer({}, json.decode(files['runtime/setup-check-request.json']).id); advance(1)
  assert(check.tick(true, true) == nil and #console == 0)
  assert(table.concat(check.reportLines(), '\n'):find('scripts compiled with: codeware codeware-textinput codeware-ui', 1, true))
`));

test('the first load names Scripts and Runtime of different versions, a pack one folder too deep and a blocked connection', () => {
  const cases = [
    ['versions', `{id = 'versions', state = 'problem', code = 'mismatch', scripts = '0.2', runtime = '0.2.1'}`,
      'The Scripts and Runtime do not match. Update whichever is older. See Help in Settings.'],
    ['versions', `{id = 'versions', state = 'problem', code = 'mismatch', scripts = '0.2.8', runtime = '0.2.4'}`,
      'The Runtime is out of date. Get the full install zip.'],
    ['versions', `{id = 'versions', state = 'problem', code = 'base-old', scripts = '0.3.4', runtime = '0.3.2', required = '0.3.3', base = true}`,
      'The Runtime is older than 0.3.3. Get the full install zip.'],
    ['versions', `{id = 'versions', state = 'problem', code = 'chain-gap', scripts = '0.2.9', runtime = '0.2.9', from = '0.2.7', to = '0.2.8'}`,
      'Runtime files are old. Get the full install zip.'],
    ['versions', `{id = 'versions', state = 'problem', code = 'chain-order', scripts = '0.2.9', runtime = '0.2.9'}`,
      'Runtime files are old. Get the full install zip.'],
    ['packs', `{id = 'packs', state = 'problem', code = 'nested', found = {}, nested = {{pack = 'OmniVoice', folder = 'x'}}, moved = {}}`,
      'A pack is one folder too deep. See Help in Settings.'],
    ['internet', `{id = 'internet', state = 'problem', code = 'blocked', service = 'convai', host = 'api.convai.com'}`,
      'The conversation service cannot reach the internet. See Help in Settings.'],
    ['disk', `{id = 'disk', state = 'problem', code = 'low', drive = 'C', freeGiB = 0.8}`,
      'Your C: drive is almost full (0.8 GB free). Free space so the mod can save logs and memories.'],
    ['files', null, 'Some mod files are missing. Extract the update zip again. See Help in Settings.'],
  ];
  for (const [id, document, expected] of cases) {
    run(String.raw`
      installFiles(); serviceRunning()
      ${id === 'files' ? "files['phone-contacts.json'] = nil" : ''}
      check.tick(true, true); advance(12); check.tick(true, true)
      local request = json.decode(files['runtime/setup-check-request.json'])
      answer(${document ? `{[${JSON.stringify(id)}] = ${document}}` : 'nil'}, request.id); advance(1)
      local notice = check.tick(true, true)
      assert(notice == ${JSON.stringify(expected)}, tostring(notice))
      assert(#console == 0)
    `);
  }
});

test('a drive that is almost full has a Help row and is a problem the first load announces; a drive with room has neither', () => run(String.raw`
  installFiles(); serviceRunning()
  answer({disk = {id = 'disk', state = 'ok', code = 'enough', drive = 'C', freeGiB = 120.3}}); check.run()
  assert(lineOf('disk') == nil and #check.problems() == 0, 'a drive with room needs no row')
  answer({disk = {id = 'disk', state = 'unknown', code = 'unknown'}}); check.run()
  assert(lineOf('disk') == nil and #check.problems() == 0, 'a drive that could not be read says nothing')
  answer({disk = {id = 'disk', state = 'problem', code = 'low', drive = 'D', freeGiB = 1.9}}); check.run()
  assert(lineOf('disk').state == 'problem' and lineOf('disk').label == 'Disk space', 'the row')
  assert(lineOf('disk').description == 'Your D: drive is almost full (1.9 GB free). Free space so the mod can save logs and memories.', lineOf('disk').description)
  assert(table.concat(check.problems(), ',') == 'disk')
  assert(table.concat(check.reportLines(), '\n'):find('service disk: problem low drive=D freeGiB=1.9', 1, true), 'the short report carries the drive and the free space')
`));

test('voice files that are not on the disk (report 0b8367fd0ebd2f2f, No module named urllib): a Help row, the first-load notice, the short report; a worker that failed on them says the same', () => run(String.raw`
  installFiles(); serviceRunning()
  answer({python = {id = 'python', state = 'ok', code = 'ok', layout = 'lib', missing = {}, missingCount = 0}}); check.run()
  assert(lineOf('python') == nil and #check.problems() == 0, 'a complete Python needs no row')
  answer({python = {id = 'python', state = 'unknown', code = 'unknown', missing = {}, missingCount = 0}}); check.run()
  assert(lineOf('python') == nil and #check.problems() == 0, 'a Python not looked at says nothing')
  answer({python = {id = 'python', state = 'problem', code = 'incomplete', layout = 'lib', missing = {'urllib', 'urllib.parse', '_distutils_hack'}, missingCount = 3}}); check.run()
  assert(lineOf('python').state == 'problem' and lineOf('python').label == 'Voice files', 'the row')
  assert(lineOf('python').description:find('Reinstall the Full download from Nexus Mods', 1, true) and not lineOf('python').description:find('Hugging', 1, true), lineOf('python').description)
  assert(table.concat(check.problems(), ',') == 'python', 'a critical problem')
  assert(table.concat(check.reportLines(), '\n'):find('service python: problem incomplete layout=lib missing=urllib+urllib.parse+_distutils_hack', 1, true), 'the short report names the modules')
  -- The same words when a voice worker failed on a missing module: the Help row of the Pocket voice.
  answer({python = {id = 'python', state = 'ok', code = 'ok', missing = {}, missingCount = 0},
    voice = {id = 'voice', state = 'problem', code = 'pocket-failed', engine = 'pocket', cause = 'missing-files'}}); check.run()
  assert(lineOf('voice').state == 'problem' and lineOf('voice').label == 'Pocket voice' and lineOf('voice').description:find('Reinstall the Full download from Nexus Mods', 1, true)
    and not lineOf('voice').description:find('Restart the game', 1, true), tostring(lineOf('voice').description))
  assert(#check.problems() == 0, 'the worker row has no first-load notice of its own: the python row is the one that announces')
`));

test('the first load announces voice files that are not on the disk, once, and the console says it in English too', () => run(String.raw`
  installFiles(); serviceRunning()
  check.tick(true, true); advance(12); check.tick(true, true)
  local request = json.decode(files['runtime/setup-check-request.json'])
  answer({python = {id = 'python', state = 'problem', code = 'incomplete', layout = 'lib', missing = {'urllib', 'urllib.parse'}, missingCount = 2}}, request.id); advance(1)
  local notice = check.tick(true, true)
  assert(notice == 'The voice files are incomplete. Reinstall the Full download from Nexus Mods.', tostring(notice))
  assert(check.tick(true, true) == nil, 'once')
  assert(#console == 1 and console[1]:find('the voice files are incomplete', 1, true), 'the console says it in English for the report')
  assert(files['runtime/probe.log']:find('Setup check: problems: python', 1, true))
`));

test('without Native Settings UI the console says which modules Python cannot find, in English, for the report', () => run(String.raw`
  installFiles(); serviceRunning()
  env.nsui = 'none'; applyEnv()
  check.tick(true, true); advance(12); check.tick(true, true)
  local request = json.decode(files['runtime/setup-check-request.json'])
  answer({python = {id = 'python', state = 'problem', code = 'incomplete', layout = 'lib', missing = {'urllib', '_distutils_hack'}, missingCount = 2}}, request.id); advance(1)
  local notice = check.tick(true, true)
  assert(notice == 'The Companion Manager needs Mod Configuration Menu 0.10.5 or newer, or Native Settings UI', 'Native Settings UI comes first in the fixed order: ' .. tostring(notice))
  local said = table.concat(console, ' | ')
  assert(said:find('the voice files are incomplete (Python cannot find: urllib, _distutils_hack). Reinstall the Full download from Nexus Mods', 1, true), said)
  assert(not said:find('Hugging', 1, true))
`));

test('the first load stays silent when only a failed service, Local AI, a missing browser or a mod manager are wrong', () => run(String.raw`
  installFiles()
  put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'browser-missing', updated = ms()})
  answer({['local-ai'] = {id = 'local-ai', state = 'problem', code = 'no-memory', selected = true},
    browser = {id = 'browser', state = 'problem', code = 'missing'}, ['mod-manager'] = {id = 'mod-manager', state = 'note', code = 'mo2', managers = {'mo2'}}})
  env.gameVersion = '2.32'; applyEnv()
  check.tick(true, true); advance(12)
  assert(check.tick(true, true) == nil and check.inspect().firstDone)
  assert(files['runtime/probe.log']:find('no critical problem', 1, true))
`));

test('without this mod’s scripts the notice waits for gameplay on its own check, and is shown once', () => run(String.raw`
  installFiles(); serviceRunning()
  env.scripts = false; applyEnv()
  -- the caller's worldReady never turns true (it needs one of the scripts' methods), but V is in a session
  check.tick(false, true); advance(12); check.tick(false, true)
  local request = json.decode(files['runtime/setup-check-request.json'])
  answer({}, request.id); advance(1)
  env.paused = true
  assert(check.tick(false, true) == nil and check.inspect().held == 'Open r6/logs/redscript_rCURRENT.log. A mod it names is why the scripts did not load.', 'held while the game is paused')
  advance(1); env.menu = true
  assert(check.tick(false, true) == nil, 'held while a menu is open')
  advance(1); env.paused, env.menu = false, false
  assert(check.tick(false, true) == nil, 'gameplay is back: the notice waits until it has been on screen for a few seconds')
  advance(7); assert(check.tick(false, true) == nil)
  advance(1)
  assert(check.tick(false, true) == 'Open r6/logs/redscript_rCURRENT.log. A mod it names is why the scripts did not load.')
  -- the console and probe.log say it once, in English, with the same advice and the other causes
  assert(#console == 1 and console[1]:find("this mod's scripts did not load. Open r6/logs/redscript_rCURRENT.log. If the error names another mod, that mod is the problem.", 1, true), console[1])
  assert(console[1]:find('a game version other than 2.31', 1, true) and files['runtime/probe.log']:find('Setup check: problems: redscript', 1, true))
  advance(1); assert(check.tick(false, true) == nil and check.inspect().held == nil)
`));

test('nothing runs per frame: idle ticks open no file and make no game call, in the menu, while waiting and after the first load', () => run(String.raw`
  installFiles(); serviceRunning()
  local function idle(label, count)
    local files_, game_ = opens(), gameCalls
    for _ = 1, count do check.tick(true, true) end
    assert(opens() == files_ and gameCalls == game_, label .. ': ' .. (opens() - files_) .. ' files, ' .. (gameCalls - game_) .. ' game calls')
  end
  -- in the main menu
  local before, calls = opens(), gameCalls
  for _ = 1, 500 do check.tick(false, false) end
  assert(opens() == before and gameCalls == calls, 'the menu')
  -- waiting out the twelve seconds (the clock does not move between ticks of one frame burst)
  check.tick(true, true)
  idle('waiting', 500)
  -- after the first load and its follow window
  advance(12); check.tick(true, true)
  advance(20); check.tick(true, true)
  assert(check.inspect().firstDone and check.inspect().pending == nil)
  idle('after the first load', 2000)
  -- the signature the Help page compares is a stored string, not rebuilt
  local signature = check.signature()
  for _ = 1, 100 do assert(check.signature() == signature) end
`));

test('reports: one plain line per check for the short report, and at most eight short rows for the full report', () => run(String.raw`
  installFiles(); serviceRunning()
  env.codeware, env.native, env.requirements = nil, true, ''; applyEnv()
  answer({internet = {id = 'internet', state = 'problem', code = 'blocked', service = 'mistral', host = 'api.mistral.ai'},
    packs = {id = 'packs', state = 'problem', code = 'nested', found = {'Local AI lite'}, nested = {{pack = 'Mature lite', folder = 'wrapped'}}, moved = {}},
    ['mod-manager'] = {id = 'mod-manager', state = 'note', code = 'vortex', managers = {'vortex'}}})
  check.run()
  local lines = table.concat(check.reportLines(), '\n')
  for _, expected in ipairs({'service: ok running', 'files: ok found 0.2.1', 'game: ok tested 2.31', 'cet: ok found 1.37.1', 'red4ext: ok loaded',
    'redscript: ok loaded', 'build: ok match (scripts=2.31 runtime=? game=2.31)', 'codeware: problem missing', 'scripts compiled with: no Codeware', 'nsui: ok found 1.96',
    'service versions: ok match scripts=0.2.1 runtime=0.2.1', 'service packs: problem nested found=Local AI lite nested=wrapped',
    'service browser: ok found name=Microsoft Edge', 'service internet: problem blocked host=api.mistral.ai service=mistral',
    'service gpu: ok found name=NVIDIA GeForce RTX 4070 memoryMiB=12282', 'service mod-manager: note vortex managers=vortex'}) do
    assert(lines:find(expected, 1, true), 'missing: ' .. expected .. '\n' .. lines)
  end
  local summary = check.summary()
  assert(#summary == 9 and summary[1].id == 'service' and summary[9].id == 'nsui')
  for _, row in ipairs(summary) do
    assert(type(row.id) == 'string' and type(row.state) == 'string' and type(row.code) == 'string')
    for key in pairs(row) do assert(key == 'id' or key == 'state' or key == 'code' or key == 'version', 'only short tokens: ' .. key) end
  end
  -- with no answer of this session the report says so
  files['runtime/setup-check.json'] = nil
  convaiSetupCheck = nil
  check = (function() ${source} end)()
  assert(table.concat(check.reportLines(), '\n'):find('service checks: none from this game session', 1, true))
`));

test('the short report written by the game holds the setup check, with the same redaction as the rest', () => run(String.raw`
  installFiles()
  put('runtime/bridge-service.json', {version = 1, state = 'stopped', updated = ms(), since = ms(-5)})
  put('runtime/convai-report-lua.txt', '')
  env.codeware, env.native, env.requirements = nil, true, ''; applyEnv()
  convaiSetupCheck = check
  local support = (function() ${supportSource} end)()
  local s = support.new({party = function() return {} end})
  assert(s.request())
  local text = files['runtime/convai-report-lua.txt']
  assert(text, 'the short report was written')
  assert(text:find('== setup check ==', 1, true), text)
  assert(text:find('codeware: problem missing', 1, true) and text:find('nsui: ok found 1.96', 1, true) and text:find('service checks: none from this game session', 1, true), text)
  -- without the module the section says so
  convaiSetupCheck = nil
  put('runtime/convai-report-lua.txt', '')
  assert(support.new({party = function() return {} end}).request())
  assert(files['runtime/convai-report-lua.txt']:find('== setup check ==\nnot available', 1, true))
`));
