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
  assert(ids() == 'files=ok game=ok cet=ok red4ext=ok redscript=ok codeware=ok tweakxl=ok audioware=ok nsui=ok', ids())
  assert(check.problemCount() == 0 and #check.problems() == 0)
  local files_, game_, red4ext_ = lineOf('files'), lineOf('game'), lineOf('red4ext')
  assert(files_.label == 'Mod files' and files_.value == 'OK' and files_.description == 'All files found.')
  assert(game_.label == 'Game version' and game_.description == 'Version 2.31.')
  assert(red4ext_.label == 'RED4ext' and red4ext_.description == 'Loaded.')
  assert(lineOf('codeware').description == 'Version 1.20.5.' and lineOf('tweakxl').description == 'Version 1.11.4.' and lineOf('audioware').description == 'Version 1.9.9.')
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
  -- RED4ext not loaded, and the scripts (0.2.2 and newer compile without Codeware and Audioware) say nothing was there to compile against
  env.codeware, env.tweakxl, env.audioware, env.native, env.requirements = nil, nil, nil, false, ''
  applyEnv(); check.run()
  assert(lineOf('red4ext').state == 'problem' and lineOf('red4ext').value == 'Problem')
  assert(lineOf('red4ext').description:find('RED4ext is not loaded', 1, true) and lineOf('red4ext').description:find('Nexus Mods', 1, true))
  assert(lineOf('redscript').state == 'ok' and lineOf('redscript').description == 'Loaded.')
  for _, id in ipairs({'codeware', 'tweakxl', 'audioware'}) do assert(lineOf(id).state == 'problem', id) end
  assert(table.concat(check.problems(), ',') == 'red4ext,codeware,audioware,tweakxl', table.concat(check.problems(), ','))
  assert(check.problemCount() == 4)
  -- the scripts did not compile either: the frameworks cannot be judged from them (Unknown), but nothing RED4ext loads answers, not even
  -- this mod's native plugin, so RED4ext is still not loaded, and it comes first: without it Codeware's scripts never reach the compile
  env.scripts, env.requirements = false, nil
  applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'red4ext,redscript', table.concat(check.problems(), ','))
  assert(lineOf('red4ext').state == 'problem' and lineOf('red4ext').description:find('RED4ext is not loaded', 1, true))
  for _, id in ipairs({'codeware', 'tweakxl', 'audioware'}) do assert(lineOf(id).state == 'unknown' and lineOf(id).description == '', id) end
  assert(check.problemCount() == 2)
  -- the native plugin answers: RED4ext is loaded, and the scripts are the one problem
  env.native = true; applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'redscript', table.concat(check.problems(), ','))
  assert(lineOf('red4ext').state == 'ok')
  for _, id in ipairs({'codeware', 'tweakxl', 'audioware'}) do assert(lineOf(id).state == 'unknown', id) end
  env.native = false
  env.scripts = true
  -- only TweakXL missing: the others stay OK and the fix names it
  env.codeware, env.tweakxl, env.audioware, env.scripts = '1.20.5', nil, '1.9.9', true
  applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'tweakxl')
  assert(lineOf('tweakxl').description == 'TweakXL is missing. Install TweakXL from Nexus Mods (nexusmods.com/cyberpunk2077/mods/4197), extract it into the Cyberpunk 2077 folder, then restart the game.')
  assert(lineOf('codeware').state == 'ok' and lineOf('red4ext').state == 'ok')
  -- scripts of 0.2.1 and older (no ConvaiRequirements) imported Codeware and Audioware: loaded, they imply both, even when the probes fail
  env.codeware, env.tweakxl, env.audioware = nil, '1.11.4', nil
  applyEnv(); check.run()
  assert(lineOf('codeware').state == 'ok' and lineOf('audioware').state == 'ok' and lineOf('codeware').description == 'Found.')
  assert(#check.problems() == 0)
  -- the scripts themselves missing while the frameworks are there: redscript, with where its error is logged
  env.codeware, env.audioware, env.scripts = '1.20.5', '1.9.9', false
  applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'redscript')
  assert(lineOf('redscript').description:find('redscript_rCURRENT.log', 1, true))
  assert(lineOf('codeware').state == 'ok' and lineOf('audioware').state == 'ok')
  -- the native plugin alone also proves RED4ext
  env.codeware, env.tweakxl, env.audioware, env.scripts, env.native = nil, nil, nil, nil, true
  applyEnv(); check.run()
  assert(lineOf('red4ext').state == 'ok')
  -- no player (main menu): the scripts cannot be asked, so the line is Unknown and never a problem
  env.codeware, env.tweakxl, env.audioware, env.scripts, env.native, env.player = '1.20.5', '1.11.4', '1.9.9', true, false, false
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

test('the conversation service: no trace, an incomplete Runtime, a failed start, a missing browser or key, starting, running and stopped', () => run(String.raw`
  installFiles()
  -- nothing of this session: the Runtime is missing or did not load
  check.run()
  assert(table.concat(check.problems(), ',') == 'service')
  local never = check.serviceLine()
  assert(never.value == 'Not running' and never.description:find('Runtime zip straight into the Cyberpunk 2077 folder', 1, true))
  assert(never.description:find('red4ext/plugins/AiNpcCyberpunkMod', 1, true))
  -- a status file from an earlier game session says nothing about this one
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'install-incomplete', updated = ms(-3600)})
  check.run()
  assert(table.concat(check.problems(), ',') == 'service', 'an hour-old failure is no trace of this session')
  -- the Runtime's own files missing
  for _, code in ipairs({'install-incomplete', 'bridge-missing', 'missing-character-ids', 'launcher-program-missing', 'launcher-directory-missing'}) do
    advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = code, updated = ms()})
    check.run()
    local line = check.serviceLine()
    assert(line and line.value == 'Not running' and line.description == 'The Runtime is incomplete (' .. code .. '). Download it again and extract it into the Cyberpunk 2077 folder (or apply the Runtime update zips in order), then restart the game.', code)
    assert(#check.problems() == 0, 'a failed service has its own notice (service-down), the first-load notice leaves it alone')
    assert(check.problemCount() == 1, 'but it counts on the page')
  end
  -- an older launcher that found no launcher.ini (a 0.2.3 Vortex report) says which file and what to do, in plain words
  advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'launcher-not-configured', updated = ms()})
  check.run()
  local launcherLine = check.serviceLine()
  assert(launcherLine and launcherLine.value == 'Not running' and launcherLine.description == 'The settings file of the launcher, launcher.ini, is missing from red4ext/plugins/AiNpcCyberpunkMod, so the game cannot start the conversation service. Extract the Runtime zip straight into the Cyberpunk 2077 folder again (by hand, also with Vortex) and let it replace the files, then restart the game.', launcherLine and launcherLine.description)
  assert(#check.problems() == 0 and check.problemCount() == 1)
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

test('the service answer is shown only from this game session and every check becomes one line with its fix', () => run(String.raw`
  installFiles(); serviceRunning()
  check.run()
  assert(ids() == 'files=ok game=ok cet=ok red4ext=ok redscript=ok codeware=ok tweakxl=ok audioware=ok nsui=ok', 'no answer yet: only the game side')
  -- an answer from an earlier game session (older than the mod's load) is ignored
  local old = answer(); old.updated = ms(-3600); put('runtime/setup-check.json', old)
  check.run()
  assert(not ids():find('browser', 1, true))
  answer(); check.run()
  assert(ids() == 'versions=ok files=ok game=ok cet=ok red4ext=ok redscript=ok codeware=ok tweakxl=ok audioware=ok nsui=ok packs=ok browser=ok local-ai=ok internet=ok gpu=ok mod-manager=ok', ids())
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
  assert(lineOf('versions').state == 'problem' and lineOf('versions').description == 'Scripts 0.2 and Runtime 0.2.1 do not match. Update whichever is older: the Scripts from Nexus Mods, or the Runtime from the mod’s Hugging Face page (its update zips one by one, or the full Runtime). Extract into the Cyberpunk 2077 folder, then restart the game.')
  -- the Runtime is the older one (nearly every report): its update zips from the Hugging Face updates folder one by one, starting from the version the player has, or the full Runtime. No version number in the instruction.
  answer({versions = {id = 'versions', state = 'problem', code = 'mismatch', scripts = '0.2.8', runtime = '0.2.4'}}); check.run()
  local older = lineOf('versions').description
  assert(older == 'Scripts 0.2.8 and Runtime 0.2.4 do not match: the Runtime is out of date. Apply the Runtime update zips from the updates folder on the mod’s Hugging Face page one by one, starting from your version, or download the full Runtime. Extract each into the Cyberpunk 2077 folder, then restart the game.', older)
  assert(not older:sub(older:find('out of date')):find('%d%.%d'), 'no version number after the status')
  answer({versions = {id = 'versions', state = 'problem', code = 'mismatch', scripts = '0.2.10', runtime = '0.2.9'}}); check.run()
  assert(lineOf('versions').description:find('the Runtime is out of date', 1, true), 'compared as numbers, not as text')
  answer({versions = {id = 'versions', state = 'problem', code = 'mismatch', scripts = '0.2', runtime = '0.2.1'}}); check.run()
  assert(table.concat(check.problems(), ',') == 'versions' and check.lines()[1].id == 'versions', 'the versions line sits first, next to the service')
  -- the versions agree but an update step was skipped: the step is named, the instruction carries no version number
  answer({versions = {id = 'versions', state = 'problem', code = 'chain-gap', scripts = '0.2.9', runtime = '0.2.9', from = '0.2.7', to = '0.2.8'}}); check.run()
  local gap = lineOf('versions').description
  assert(lineOf('versions').state == 'problem' and gap == 'The Runtime update from 0.2.7 to 0.2.8 was never applied, so some Runtime files are old. Apply the Runtime update zips from the updates folder on the mod’s Hugging Face page one by one, starting from your version. Extract each into the Cyberpunk 2077 folder, then restart the game.', gap)
  assert(not gap:sub(gap:find('never applied')):find('%d%.%d'), 'no version number after the naming')
  assert(table.concat(check.problems(), ',') == 'versions')
  answer({versions = {id = 'versions', state = 'problem', code = 'chain-order', scripts = '0.2.8', runtime = '0.2.8'}}); check.run()
  assert(lineOf('versions').state == 'problem' and lineOf('versions').description:find('one by one, in order, starting from your version', 1, true))
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
  assert(lineOf('voice').state == 'problem' and lineOf('voice').description:find('Windows blocked a file', 1, true) and lineOf('voice').description:find('Smart App Control', 1, true)
    and lineOf('voice').description:find('another voice', 1, true) and not lineOf('voice').description:find('Restart', 1, true), tostring(lineOf('voice').description))
  assert(#check.problems() == 0)
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
  assert(lineOf('mod-manager').description == 'Mod Organizer 2. Files the mod creates go to its Overwrite folder; leave them there. Mention Mod Organizer 2 when you send a report.')
  answer({['mod-manager'] = {id = 'mod-manager', state = 'note', code = 'vortex', managers = {'vortex'}}}); check.run()
  assert(lineOf('mod-manager').description == 'Vortex. Install the Runtime and the optional packs by hand into the Cyberpunk 2077 folder, as the install steps say.')
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
  -- TweakXL and Native Settings UI both missing: TweakXL first; the console still names Native Settings UI
  env.tweakxl, env.nsui = nil, 'none'; applyEnv()
  check.tick(true, true); advance(12); check.tick(true, true)
  local request = json.decode(files['runtime/setup-check-request.json'])
  answer({}, request.id); advance(1)
  local notice = check.tick(true, true)
  assert(notice == 'TweakXL is missing. Install it from Nexus Mods, then restart the game.', tostring(notice))
  -- the console says each of them once, in English: the missing requirement and Native Settings UI
  assert(#console == 2 and console[1] == '[AiNpcCyberpunkMod] AI NPC Cyberpunk Mod: TweakXL is missing. Install TweakXL from Nexus Mods (https://www.nexusmods.com/cyberpunk2077/mods/4197), extract it into the Cyberpunk 2077 folder, then restart the game.', console[1])
  assert(console[2]:find('neither was found', 1, true))
  assert(table.concat(check.problems(), ',') == 'tweakxl,nsui', table.concat(check.problems(), ','))
`));

test('a missing Audioware says exactly what to install; Audioware that is there but unseen by the scripts says to update it', () => run(String.raw`
  installFiles(); serviceRunning()
  -- nothing of Audioware (no probe, and the scripts were built without it): install Audioware 1.9.9 or newer, with where it comes from
  env.audioware, env.requirements = nil, 'codeware codeware-ui codeware-textinput'
  applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'audioware', table.concat(check.problems(), ','))
  assert(lineOf('audioware').description == 'Audioware is missing. Install Audioware 1.9.9 or newer from Nexus Mods (nexusmods.com/cyberpunk2077/mods/12001), extract it into the Cyberpunk 2077 folder, then restart the game.', lineOf('audioware').description)
  assert(table.concat(check.reportLines(), '\n'):find('audioware: problem missing', 1, true))
  check.tick(true, true); advance(12); check.tick(true, true)
  answer({}, json.decode(files['runtime/setup-check-request.json']).id); advance(1)
  local notice = check.tick(true, true)
  assert(notice == 'Audioware is missing. Install it from Nexus Mods, then restart the game.', tostring(notice))
  assert(#console == 1 and console[1]:find('Install Audioware 1.9.9 or newer from Nexus Mods (https://www.nexusmods.com/cyberpunk2077/mods/12001)', 1, true), console[1])
`));

test('Audioware that Cyber Engine Tweaks sees while the scripts were built without it is its own problem: update it, not install it', () => run(String.raw`
  installFiles(); serviceRunning()
  -- the report of a player with a release candidate: its version answers, ConvaiRequirements has no 'audioware'
  env.audioware, env.requirements = '1.9.9-rc.0', 'codeware codeware-ui codeware-textinput'
  applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'audioware', table.concat(check.problems(), ','))
  local item = lineOf('audioware')
  assert(item.state == 'problem' and item.description == 'Audioware 1.9.9-rc.0 is installed, but this mod’s scripts were built without it. Update Audioware to 1.9.9 or newer from Nexus Mods, then restart the game. If it is already up to date, generate a report below and send it.', item.description)
  assert(not item.description:find('missing', 1, true), 'it is not missing')
  assert(table.concat(check.reportLines(), '\n'):find('audioware: problem unbuilt 1.9.9-rc.0', 1, true), table.concat(check.reportLines(), '\n'))
  check.tick(true, true); advance(12); check.tick(true, true)
  answer({}, json.decode(files['runtime/setup-check-request.json']).id); advance(1)
  local notice = check.tick(true, true)
  assert(notice == 'Audioware is installed but unused. Update it to 1.9.9 or newer, then restart the game.', tostring(notice))
  assert(#console == 1 and console[1]:find('Audioware is installed, but this mod\'s scripts were built without it. Update Audioware to 1.9.9 or newer', 1, true), console[1])
  -- beside another missing requirement the notice names both, as "install or update"
  env.tweakxl = nil; applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'audioware,tweakxl', table.concat(check.problems(), ','))
`));

test('the first load names Scripts and Runtime of different versions, a pack one folder too deep and a blocked connection', () => {
  const cases = [
    ['versions', `{id = 'versions', state = 'problem', code = 'mismatch', scripts = '0.2', runtime = '0.2.1'}`,
      'The Scripts and Runtime do not match. Update whichever is older. See Help in Settings.'],
    ['versions', `{id = 'versions', state = 'problem', code = 'mismatch', scripts = '0.2.8', runtime = '0.2.4'}`,
      'The Runtime is out of date. Apply its update zips one by one, or get the full Runtime.'],
    ['versions', `{id = 'versions', state = 'problem', code = 'chain-gap', scripts = '0.2.9', runtime = '0.2.9', from = '0.2.7', to = '0.2.8'}`,
      'A Runtime update step is missing. Apply its update zips one by one from the updates folder.'],
    ['versions', `{id = 'versions', state = 'problem', code = 'chain-order', scripts = '0.2.9', runtime = '0.2.9'}`,
      'A Runtime update step is missing. Apply its update zips one by one from the updates folder.'],
    ['packs', `{id = 'packs', state = 'problem', code = 'nested', found = {}, nested = {{pack = 'OmniVoice', folder = 'x'}}, moved = {}}`,
      'A pack is one folder too deep. See Help in Settings.'],
    ['internet', `{id = 'internet', state = 'problem', code = 'blocked', service = 'convai', host = 'api.convai.com'}`,
      'The conversation service cannot reach the internet. See Help in Settings.'],
    ['files', null, 'Some mod files are missing. Extract the Scripts zip again. See Help in Settings.'],
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

test('reports: one plain line per check for the short report, and at most ten short rows for the full report', () => run(String.raw`
  installFiles(); serviceRunning()
  env.tweakxl = nil; applyEnv()
  answer({internet = {id = 'internet', state = 'problem', code = 'blocked', service = 'mistral', host = 'api.mistral.ai'},
    packs = {id = 'packs', state = 'problem', code = 'nested', found = {'Local AI lite'}, nested = {{pack = 'Mature lite', folder = 'wrapped'}}, moved = {}},
    ['mod-manager'] = {id = 'mod-manager', state = 'note', code = 'vortex', managers = {'vortex'}}})
  check.run()
  local lines = table.concat(check.reportLines(), '\n')
  for _, expected in ipairs({'service: ok running', 'files: ok found 0.2.1', 'game: ok tested 2.31', 'cet: ok found 1.37.1', 'red4ext: ok loaded',
    'redscript: ok loaded', 'codeware: ok found 1.20.5', 'tweakxl: problem missing', 'audioware: ok found 1.9.9', 'nsui: ok found 1.96',
    'service versions: ok match scripts=0.2.1 runtime=0.2.1', 'service packs: problem nested found=Local AI lite nested=wrapped',
    'service browser: ok found name=Microsoft Edge', 'service internet: problem blocked host=api.mistral.ai service=mistral',
    'service gpu: ok found name=NVIDIA GeForce RTX 4070 memoryMiB=12282', 'service mod-manager: note vortex managers=vortex'}) do
    assert(lines:find(expected, 1, true), 'missing: ' .. expected .. '\n' .. lines)
  end
  local summary = check.summary()
  assert(#summary == 10 and summary[1].id == 'service' and summary[10].id == 'nsui')
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
  env.tweakxl = nil; applyEnv()
  convaiSetupCheck = check
  local support = (function() ${supportSource} end)()
  local s = support.new({party = function() return {} end})
  assert(s.request())
  local text = files['runtime/convai-report-lua.txt']
  assert(text, 'the short report was written')
  assert(text:find('== setup check ==', 1, true), text)
  assert(text:find('tweakxl: problem missing', 1, true) and text:find('nsui: ok found 1.96', 1, true) and text:find('service checks: none from this game session', 1, true), text)
  -- without the module the section says so
  convaiSetupCheck = nil
  put('runtime/convai-report-lua.txt', '')
  assert(support.new({party = function() return {} end}).request())
  assert(files['runtime/convai-report-lua.txt']:find('== setup check ==\nnot available', 1, true))
`));
