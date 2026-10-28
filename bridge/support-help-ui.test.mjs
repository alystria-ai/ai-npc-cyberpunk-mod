import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {run, nsuiHarness} from './manager-fixture.mjs';

// The Help page inside the real manager host. The harness is the one of manager.test.mjs (real manager.lua, manager-ui.lua,
// nsui.lua and manager-party.lua over a fake Native Settings UI and game), with support-report.lua, the service status, the
// character editor and the setup check added to its module map.
const read = name => readFileSync(new URL(`../mod/${name}`, import.meta.url), 'utf8');
const supportSource = read('support-report.lua'), serviceSource = read('service-status.lua'), editorSource = read('character-editor.lua');
const setupSource = read('setup-check.lua');

const pageFixture = (withSupport = true, withSetup = false, withNsui = true) => nsuiHarness({
  modules: {'service-status.lua': serviceSource, 'character-editor.lua': editorSource,
    ...(withSupport ? {'support-report.lua': supportSource} : {}), ...(withSetup ? {'setup-check.lua': setupSource} : {})},
  absent: [...(withSupport ? [] : ['support-report.lua']), ...(withSetup ? [] : ['setup-check.lua'])],
  nsui: withNsui,
}) + `
  convaiNotices.configure(function() return manager.developerMode() end) -- as init.lua does
`;

const helpFixture = (withSupport = true, withSetup = false, withNsui = true) => `
  ${pageFixture(withSupport, withSetup, withNsui)}
  local clockNow, popups = 1800000000, {}
  local cpu = 0
  os.time = function() return clockNow end
  os.clock = function() return cpu end
  local function advance(seconds) clockNow = clockNow + seconds; cpu = cpu + seconds end
  -- The host draws the page again by itself when what it shows changes; the harness reads the page as it stands afterwards.
  local function pump(gameplay, frames)
    for _ = 1, frames or 10 do advance(0.5); managerUi.update(player, gameplay) end
    loaded = registered.loadMod('manager')
  end
  function player:ConvaiPhoneFeedback(text) popups[#popups + 1] = text end
  local function jsonFile(path, value)
    jsonSequence = jsonSequence + 1
    local token = 'help-fixture-' .. jsonSequence
    jsonFixtures[token] = value; files[path] = token
  end
  local function category(id)
    for _, item in ipairs(loaded.categories) do if item.id == id then return item end end
  end
  local function countBack()
    local count = 0
    for _, section in ipairs(loaded.categories) do
      for _, item in ipairs(section.settings) do if item.value == 'Back' then count = count + 1 end end
    end
    return count
  end
  local MOD = 'E:\\\\Game\\\\bin\\\\x64\\\\plugins\\\\cyber_engine_tweaks\\\\mods\\\\AiNpcCyberpunkMod'
  jsonFile('runtime/support-paths.json', {version = 1, gameRoot = 'E:\\\\Game', modRoot = MOD, runtime = MOD .. '\\\\runtime',
    reports = MOD .. '\\\\runtime\\\\reports', stateDirectory = 'D:\\\\project\\\\runtime',
    logs = {probe = {path = MOD .. '\\\\runtime\\\\probe.log'}, ['bridge-stderr'] = {path = 'D:\\\\project\\\\runtime\\\\bridge.stderr.log'},
      launcher = {path = 'E:\\\\Game\\\\red4ext\\\\plugins\\\\AiNpcCyberpunkMod\\\\launcher.log'},
      cet = {path = 'E:\\\\Game\\\\bin\\\\x64\\\\plugins\\\\cyber_engine_tweaks\\\\cyber_engine_tweaks.log'},
      redscript = {path = 'E:\\\\Game\\\\r6\\\\logs\\\\redscript_rCURRENT.log'},
      red4ext = {path = 'E:\\\\Game\\\\red4ext\\\\logs\\\\red4ext-2026-10-05-12-15-19.log'}}})
`;

test('Settings offers Help, and the Help page has one parent Back, guidance, the report actions and every log location', () => run(`${helpFixture()}
  assert(invoke('tab:settings').ok)
  local help = row('help')
  assert(help and help.value == 'Open' and not help.disabled and category('help') and category('help').name == 'Help')
  assert(invoke('help').ok and managerUi.inspect().view == 'help')
  assert(loaded.categories[1].id == 'navigation' and loaded.categories[1].settings[1].id == 'help:back' and countBack() == 1,
    'one parent Back, the first row of the page')
  assert(#category('navigation').settings == 1 and not row('party-count'))
  for _, id in ipairs({'help-steps', 'help-service', 'help:generate', 'help-last', 'help:copy', 'help-log-mod',
    'help-log-bridge', 'help-log-launcher', 'help-log-cet', 'help-log-redscript', 'help-log-red4ext', 'help-log-reports'}) do
    assert(row(id), 'missing ' .. id)
  end
  -- Real absolute paths from the service's published locations.
  assert(row('help-log-mod').description:find(MOD .. '\\\\runtime', 1, true))
  assert(row('help-log-bridge').description:find('D:\\\\project\\\\runtime', 1, true))
  assert(row('help-log-launcher').description:find('E:\\\\Game\\\\red4ext\\\\plugins\\\\AiNpcCyberpunkMod\\\\launcher.log', 1, true))
  assert(row('help-log-cet').description:find('E:\\\\Game\\\\bin\\\\x64\\\\plugins\\\\cyber_engine_tweaks', 1, true))
  assert(row('help-log-redscript').description:find('E:\\\\Game\\\\r6\\\\logs\\\\redscript_rCURRENT.log', 1, true))
  assert(row('help-log-red4ext').description:find('E:\\\\Game\\\\red4ext\\\\logs', 1, true))
  assert(row('help-log-reports').description:find(MOD .. '\\\\runtime\\\\reports', 1, true))
  assert(row('help-last').value == 'None yet')
  -- Copy is a real button even before a report exists; it then says what to do.
  assert(row('help:copy').type == 'action' and not row('help:copy').disabled and row('help:copy').value == 'Copy')
  local early = invoke('help:copy')
  assert(not early.ok and early.error == 'Create a report first.' and not files['runtime/clipboard-request.json'])
  assert(row('help:generate').value == 'Create' and not row('help:generate').disabled)
  assert(invoke('help:back').ok and managerUi.inspect().view == 'settings' and row('help'))
  assert(not invoke('help:generate').ok, 'a stale Help action stayed callable after leaving the page')
`));

test('with the conversation service running the page asks it for a report, shows the path and announces it once in gameplay', () => run(`${helpFixture()}
  jsonFile('runtime/knowledge-status.json', {updated = os.time() * 1000.0})
  assert(invoke('tab:settings').ok and invoke('help').ok)
  assert(row('help-service').value == 'Running')
  local result = invoke('help:generate')
  assert(result.ok)
  assert(row('help:generate').disabled == true, 'generate is disabled while the report is being created')
  local request = jsonFixtures[files['runtime/report-request.json']]
  assert(request and request.version == 1 and type(request.id) == 'string' and request.lua.view == 'help')
  assert(not next(request.lua.party), 'no party yet')
  -- Another request's answer is ignored; the right one completes the page.
  local path = MOD .. '\\\\runtime\\\\reports\\\\convai-report-20261005-120000.zip'
  jsonFile('runtime/report-result.json', {version = 1, id = 'someone-else', state = 'ready', path = 'X', fileName = 'X'})
  pump(false, 1)
  assert(row('help:generate').disabled == true and row('help-last').value == 'None yet')
  jsonFile('runtime/report-result.json', {version = 1, id = request.id, state = 'ready', mode = 'bridge', path = path,
    fileName = 'convai-report-20261005-120000.zip'})
  pump(false)
  assert(#popups == 0, 'a paused menu cannot show the popup, so it waits for gameplay')
  assert(row('help-last').value == 'convai-report-20261005-120000.zip', row('help-last').value)
  -- The page shows a short path with a soft break, never the long unbroken one.
  local short = '…\\\\runtime\\\\reports\\\\\\n' .. 'convai-report-20261005-120000.zip'
  assert(row('help-last').description:find(short, 1, true) and not row('help-last').description:find(MOD, 1, true),
    row('help-last').description)
  assert(not row('help:generate').disabled)
  pump(true, 4)
  assert(#popups == 0, 'the saved-report popup is for Developer mode only')
  -- Developer mode shows it once, with the short path.
  assert(registered.applyBatch('manager', {{id = 'developerMode', value = true}}).ok)
  assert(invoke('help:generate').ok)
  request = jsonFixtures[files['runtime/report-request.json']]
  jsonFile('runtime/report-result.json', {version = 1, id = request.id, state = 'ready', mode = 'bridge', path = path,
    fileName = 'convai-report-20261005-120000.zip'})
  pump(true, 3)
  assert(#popups == 1 and popups[1]:find(short, 1, true) and not popups[1]:find(MOD, 1, true), popups[1])
  pump(true, 3)
  assert(#popups == 1, 'the popup is shown once')
  -- Copy path is a button that asks the service to copy the full path, and also
  -- tries the game clipboard from the next top-level update.
  local copied
  ImGui = {SetClipboardText = function(text) copied = text end}
  local copy = invoke('help:copy')
  assert(copy.ok and copied == nil, 'the game clipboard must not run inside the menu callback')
  local requested = jsonFixtures[files['runtime/clipboard-request.json']]
  assert(requested.version == 1 and requested.text == path and type(requested.id) == 'string')
  pump(false, 1)
  assert(copied == path, 'the game clipboard runs from the top-level update')
  ImGui = nil
`));

test('with the conversation service stopped the page writes a short report itself and says so', () => run(`${helpFixture()}
  jsonFile('runtime/bridge-service.json', {state = 'stopped', updated = os.time() * 1000.0, since = os.time() * 1000.0 - 5000})
  assert(invoke('tab:settings').ok and invoke('help').ok)
  assert(row('help-service').value == 'Not running')
  assert(invoke('help:generate').ok)
  assert(not files['runtime/report-request.json'], 'no request is sent to a service that is not running')
  local report
  for _, write in ipairs(fileWrites) do
    if write.path == 'runtime/convai-report-lua.txt' then report = write end
  end
  assert(report, 'a Lua-side report file was written, in the one fixed file')
  assert(report.value:find('the conversation service was not running', 1, true))
  local last = row('help-last')
  assert(last.value == 'convai-report-lua.txt' and last.description:find('short report', 1, true))
  assert(last.description:find('…\\\\AiNpcCyberpunkMod\\\\runtime\\\\\\n' .. 'convai-report-lua.txt', 1, true) and not last.description:find(MOD, 1, true), last.description)
  for _, write in ipairs(fileWrites) do assert(not write.path:find('convai%-report') or write.path == 'runtime/convai-report-lua.txt', 'no other report name: ' .. write.path) end
  -- A second report rewrites the same file in place: no new name, nothing renamed or removed.
  fileWrites = {}
  os.remove = function(path) error('os.remove ' .. path) end
  os.rename = function(from, to) error('os.rename ' .. from) end
  pump(false, 1)
  assert(invoke('help:generate').ok)
  local rewrites = 0
  for _, write in ipairs(fileWrites) do if write.path == 'runtime/convai-report-lua.txt' then rewrites = rewrites + 1 end end
  assert(rewrites == 1, rewrites)
`));

test('before the service has published its folders the page says where the data and the reports are now, outside the game folder', () => run(`${helpFixture()}
  files['runtime/support-paths.json'] = nil
  assert(invoke('tab:settings').ok and invoke('help').ok)
  assert(row('help-log-bridge').description:find('%LOCALAPPDATA%\\\\AiNpcCyberpunkMod\\\\data', 1, true), row('help-log-bridge').description)
  assert(row('help-log-reports').description:find('%LOCALAPPDATA%\\\\AiNpcCyberpunkMod\\\\reports', 1, true), row('help-log-reports').description)
  assert(row('help-log-launcher').description:find('red4ext\\\\plugins\\\\AiNpcCyberpunkCode\\\\launcher.log', 1, true), row('help-log-launcher').description)
  assert(not row('help-log-bridge').description:find('mod folder', 1, true) and not row('help-log-launcher').description:find('CyberpunkConvaiLauncher', 1, true))
`));

test('without the support module the manager is unchanged and shows no Help entry', () => run(`${helpFixture(false)}
  assert(invoke('tab:settings').ok)
  assert(not row('help') and not category('help'))
`));
// ---- Settings > Edit characters (docs/CHARACTER_EDITOR.md): one action that writes one small command file, and nothing else
const editorPageSource = readFileSync(new URL('../bridge/character-editor-page.mjs', import.meta.url), 'utf8');
const pageSources = [...new Set([...editorPageSource.matchAll(/\bT\('((?:[^'\\]|\\.)*)'/g)].map(match => match[1]).concat(['Character editor', 'Close editor']))];
const catalogStrings = JSON.parse(readFileSync(new URL('../localization/en.json', import.meta.url), 'utf8')).strings;

test('Settings offers Edit characters, and Open writes one fresh command with every sentence of the page and the interface language', () => run(`${helpFixture()}
  jsonFile('runtime/knowledge-status.json', {updated = os.time() * 1000.0})
  assert(invoke('tab:settings').ok)
  local open = row('character-editor:open')
  assert(open and open.type == 'action' and open.value == 'Open' and not open.disabled, 'the Open row is offered')
  assert(open.label == 'Edit characters', 'the row label')
  assert(open.description:find('Mistral, Local AI and Custom, not Convai', 1, true), 'the row says the editor does not apply to Convai')
  local writesBefore = #fileWrites
  local result = invoke('character-editor:open')
  assert(result.ok, tostring(result.error))
  assert(#fileWrites == writesBefore + 1 and fileWrites[#fileWrites].path == 'runtime/editor-command.json', 'exactly one small file is written, got ' .. (#fileWrites - writesBefore))
  local command = jsonFixtures[files['runtime/editor-command.json']]
  assert(command.version == 1 and command.action == 'open' and command.language == 'en', 'command header')
  assert(type(command.id) == 'string' and command.id:match('^e%d+%-%d+$') and command.issuedAt == os.time() * 1000.0, 'id and time')
  local count = 0
  for source, text in pairs(command.strings) do count = count + 1; assert(type(source) == 'string' and text == source, 'English shows the source: ' .. source) end
  assert(count == ${pageSources.length}, 'every sentence of the page is sent, got ' .. count)
  assert(command.strings['Save'] and command.strings['Convai is answering right now, so these changes have no effect yet. Choose Mistral, Local AI or Custom as the conversation provider in the settings.'])
  local first = command.id
  advance(1)
  assert(invoke('character-editor:open').ok)
  assert(jsonFixtures[files['runtime/editor-command.json']].id ~= first, 'every click is a new command')
  -- Nothing is polled and nothing runs per frame: the module has no update, and a pumped menu writes nothing more.
  local function commandWrites() local n = 0 for _, write in ipairs(fileWrites) do if write.path == 'runtime/editor-command.json' then n = n + 1 end end return n end
  local settled = commandWrites()
  pump(true, 20); pump(false, 20)
  assert(commandWrites() == settled, 'a pumped menu sends no further command')
`));

test('Open says so when the conversation service is not running, and writes nothing', () => run(`${helpFixture()}
  jsonFile('runtime/bridge-service.json', {state = 'stopped', updated = os.time() * 1000.0, since = os.time() * 1000.0 - 5000})
  assert(invoke('tab:settings').ok)
  local result = invoke('character-editor:open')
  assert(not result.ok and result.error == 'The conversation service is not running, so the editor cannot open. Restart the game.', tostring(result.error))
  assert(not files['runtime/editor-command.json'])
`));

test('a failed write is reported, and without the module the settings page is unchanged', () => run(`${helpFixture()}
  jsonFile('runtime/knowledge-status.json', {updated = os.time() * 1000.0})
  assert(invoke('tab:settings').ok)
  failSave = true
  local result = invoke('character-editor:open')
  assert(not result.ok and result.error == 'The editor could not be opened. Try again.', tostring(result.error))
  failSave = false
  assert(invoke('character-editor:open').ok)
`));

test('the page sentences, the module and the catalogue agree, and every one is in all fifteen dictionaries', () => {
  const luaText = readFileSync(new URL('../mod/character-editor.lua', import.meta.url), 'utf8');
  const unescape = text => text.replace(/\\(['\\])/g, '$1');
  const inLua = [...luaText.matchAll(/\['((?:[^'\\]|\\.)*)'\] = ui\.t\('((?:[^'\\]|\\.)*)'\),/g)].map(match => { assert.equal(match[1], match[2]); return unescape(match[1]); });
  assert.deepEqual([...inLua].sort(), [...pageSources].sort(), 'mod/character-editor.lua sends exactly the sentences the page uses');
  for (const source of [...pageSources, 'Edit characters', 'The conversation service is not running, so the editor cannot open. Restart the game.',
    'The editor could not be opened. Try again.', 'Opening the editor in your browser. Switch to your browser if it does not come to the front.'])
    assert(source in catalogStrings, `${source} is in localization/en.json`);
  const forbidden = /\b(?:api key|token|secret|credential|password|AMM)\b/i;
  for (const source of pageSources) assert.doesNotMatch(source, forbidden, source);
  assert.doesNotMatch(luaText.replace(/--.*$/gm, ''), /\bupdate\b|Observe|Override|GameInstance|Game\./, 'no per-frame hook and no native call');
});

test('a service that never started for want of a browser says so on the Local AI model row and on Help (Settings has no status line), and a plain stop does not', () => run(`${helpFixture()}
  local sentence = 'The conversation service needs a Chromium browser such as Microsoft Edge, Google Chrome, Brave or Opera. Install one, or put the path of yours in a browser.txt file next to launcher.ini, then restart the game.'
  jsonFile('runtime/bridge-service.json', {state = 'failed', code = 'browser-missing', updated = os.time() * 1000.0, since = os.time() * 1000.0 - 5000})
  assert(invoke('tab:settings').ok)
  -- Settings has no status line (the Voice status row was removed 2026-10-20); the Local AI model row must not claim "No model installed"
  -- while nothing is running.
  assert(row('voice-status') == nil, 'the Settings page has no Voice status row')
  local model = row('localModel')
  assert(model.elements[1] == 'Service not running' and model.description:sub(1, #sentence) == sentence, tostring(model.elements[1]))
  assert(invoke('help').ok)
  assert(row('help-service').value == 'Needs a browser' and row('help-service').description == sentence)
  -- A plain stop: the row says the service is not running with the ordinary sentence.
  jsonFile('runtime/bridge-service.json', {state = 'stopped', updated = os.time() * 1000.0, since = os.time() * 1000.0 - 5000})
  os.time = (function(real) return function() return real() + 2 end end)(os.time)
  assert(invoke('help:back').ok)
  assert(row('voice-status') == nil)
  assert(row('localModel').elements[1] == 'Service not running' and row('localModel').description:find('is not running', 1, true))
  assert(invoke('help').ok)
  assert(row('help-service').value == 'Not running' and row('help-service').description:find('restart the game', 1, true))
`));

test('with no service at all the page writes the short report at once, and Copy path shows the whole path instead of copying', () => run(`${helpFixture()}
  assert(invoke('tab:settings').ok and invoke('help').ok)
  assert(row('help:copy').description == 'Create a report first, then copy its path.')
  assert(invoke('help:generate').ok)
  assert(not files['runtime/report-request.json'], 'no request is sent to a service that never started')
  assert(row('help:generate').disabled ~= true, 'no waiting phase: the button is free again at once')
  local report
  for _, write in ipairs(fileWrites) do
    if write.path == 'runtime/convai-report-lua.txt' then report = write end
  end
  assert(report, 'the short report was written during the click')
  local lines = {}
  for line in (report.value .. '\\n'):gmatch('(.-)\\n') do lines[#lines + 1] = line end
  assert(lines[2]:find('PROBLEM: the conversation service never started', 1, true), lines[2])
  assert(row('help-last').value == 'convai-report-lua.txt')
  -- Copy cannot work without the service: no request file, and the row's help carries the full path, line by line.
  local copy = row('help:copy')
  local full = MOD .. '\\\\runtime\\\\convai-report-lua.txt'
  assert(copy.description:find('needs the conversation service, which is not running', 1, true), copy.description)
  local shown = copy.description:match('is at: \\n(.*)$')
  assert(shown and shown:gsub('\\n', '') == full, tostring(shown))
  assert(shown:find('\\nconvai-report-lua.txt', 1, true), 'the file name is on its own line')
  local writes = #fileWrites
  local result = invoke('help:copy')
  assert(result.ok and not files['runtime/clipboard-request.json'] and #fileWrites == writes, 'nothing is queued for a service that is not running')
`));

test('with the service up the Copy row keeps its ordinary help, and shows the path once the service has gone quiet', () => run(`${helpFixture()}
  jsonFile('runtime/bridge-service.json', {state = 'ready', updated = os.time() * 1000.0, since = os.time() * 1000.0 - 30000})
  assert(invoke('tab:settings').ok and invoke('help').ok)
  assert(invoke('help:generate').ok)
  assert(files['runtime/report-request.json'] and row('help:generate').disabled == true, 'a service that is up is asked, and the page shows the wait')
  local request = jsonFixtures[files['runtime/report-request.json']]
  local path = MOD .. '\\\\runtime\\\\reports\\\\convai-report-20261005-120000.zip'
  jsonFile('runtime/report-result.json', {version = 1, id = request.id, state = 'ready', mode = 'bridge', path = path,
    fileName = 'convai-report-20261005-120000.zip'})
  pump(false, 4)
  assert(row('help-last').value == 'convai-report-20261005-120000.zip')
  assert(row('help:copy').description == 'Copy the report path to the clipboard so you can paste it into a message.', row('help:copy').description)
  -- The status is no longer refreshed (the service died): within a few seconds of the page's own poll the row shows the path.
  pump(false, 60)
  assert(row('help:copy').description:find('needs the conversation service, which is not running', 1, true), row('help:copy').description)
  assert(row('help:copy').description:match('is at: \\n(.*)$'):gsub('\\n', '') == path)
`));

// ---- Help > Setup check (docs/MANAGER_UI.md, mod/setup-check.lua): the first section of the page, over the real manager host
// The game as it is with everything installed; a test changes one thing of it. TweakXL and Audioware are there too: they are no
// requirements, so the page has no row for them and nothing about them is ever a problem.
const setupWorld = `
  Codeware = {Version = function() return '1.20.5' end}
  TweakXL = {Version = function() return '1.11.4' end}
  AudioSystemExt = {Version = function() return '1.9.9' end}
  GetVersion = function() return '1.37.1' end
  function player:ConvaiPhoneIsOpen() return false end
  for _, name in ipairs({'world-knowledge.json', 'manager-characters.json', 'conversation-characters.json', 'phone-contacts.json', 'locales/de.lua'}) do files[name] = 'x' end
  Game.GetSystemRequestsHandler = function() return {GetGameVersion = function() return '2.31' end,
    IsPreGame = function() return false end, IsGamePaused = function() return false end} end
  local consoleLines = {}
  print = function(...) consoleLines[#consoleLines + 1] = table.concat({...}, ' ') end
  local function serviceUp() jsonFile('runtime/knowledge-status.json', {updated = os.time() * 1000.0}) end
  serviceUp()
  local function setupRow(id) return row('setup:' .. id) end
  local function consoleHas(text)
    for _, line in ipairs(consoleLines) do if line:find(text, 1, true) then return true end end
    return false
  end
  local function requestWrites()
    local count = 0
    for _, write in ipairs(fileWrites) do if write.path == 'runtime/setup-check-request.json' then count = count + 1 end end
    return count
  end
`;

test('the Help page opens with the setup check: the service row, one line per check, and a count in the description', () => run(`${helpFixture(true, true)}
  ${setupWorld}
  assert(invoke('tab:settings').ok and invoke('help').ok)
  local first = loaded.categories[2]
  assert(loaded.categories[1].id == 'navigation' and first.id == 'help-setup' and first.name == 'Setup check', first.id)
  assert(first.description == 'No problem found. Select a line to see what was checked.', first.description)
  assert(first.settings[1].id == 'help-service', 'the Conversation service row first in the setup check (Back is the first section)')
  assert(loaded.categories[1].settings[1].id == 'help:back' and countBack() == 1, 'still one parent Back')
  assert(row('help-service').value == 'Running')
  for _, id in ipairs({'files', 'game', 'cet', 'red4ext', 'redscript', 'codeware', 'nsui'}) do
    local item = setupRow(id)
    assert(item and item.value == 'OK' and item.type == 'string' and item.description ~= '', id .. ' ' .. tostring(item and item.description))
  end
  assert(not setupRow('tweakxl') and not setupRow('audioware'), 'TweakXL and Audioware are no requirements: no row')
  assert(setupRow('codeware').label == 'Codeware' and setupRow('codeware').description == 'Version 1.20.5.')
  assert(setupRow('game').label == 'Game version' and setupRow('game').description == 'Version 2.31.')
  -- the existing groups follow, unchanged
  assert(category('help-trouble') and category('help-report') and category('help-logs') and row('help-steps') and row('help:generate'))
  assert(category('help-trouble').settings[1].id == 'help-steps')
`));

test('a missing framework, a missing file and a service that never started are Problems with their fix, counted in the description', () => run(`${helpFixture(true, true)}
  ${setupWorld}
  Codeware = nil; convaiNative = {present = true}; function player:ConvaiRequirements() return '' end
  files['phone-contacts.json'] = nil
  files['runtime/knowledge-status.json'] = nil
  assert(invoke('tab:settings').ok and invoke('help').ok)
  assert(row('help-service').value == 'Not running' and row('help-service').description:find('Runtime zip straight into the Cyberpunk 2077 folder', 1, true), row('help-service').description)
  assert(setupRow('codeware').value == 'Problem' and setupRow('codeware').description == 'Codeware is missing. Install it from Nexus Mods, then restart the game.')
  assert(setupRow('files').value == 'Problem' and setupRow('files').description:find('Missing: phone-contacts.json.', 1, true))
  assert(setupRow('red4ext').value == 'OK')
  assert(category('help-setup').description == 'Problems found: 3. Select a line marked Problem to read what to do.', category('help-setup').description)
`));

test('opening the page runs the check again and asks a running service once; the page redraws when its answer arrives', () => run(`${helpFixture(true, true)}
  ${setupWorld}
  assert(invoke('tab:settings').ok)
  pump(false, 2)
  assert(not files['runtime/setup-check-request.json'], 'nothing is asked while the page is closed')
  serviceUp()
  assert(invoke('help').ok)
  assert(not setupRow('browser'), 'no answer of the service yet')
  assert(requestWrites() == 0, 'not inside the menu callback')
  pump(false, 1)
  local request = jsonFixtures[files['runtime/setup-check-request.json']]
  assert(request and request.version == 1 and type(request.id) == 'string', 'the request is written from the next update')
  assert(requestWrites() == 1)
  jsonFile('runtime/setup-check.json', {version = 1, updated = os.time() * 1000.0, request = request.id, checks = {
    {id = 'browser', state = 'problem', code = 'missing'},
    {id = 'gpu', state = 'ok', code = 'found', name = 'NVIDIA GeForce RTX 4070', memoryMiB = 12282},
    {id = 'internet', state = 'problem', code = 'blocked', service = 'convai', host = 'api.convai.com'}}})
  serviceUp()
  pump(false, 6)
  assert(setupRow('browser') and setupRow('browser').value == 'Problem' and setupRow('browser').description:find('Chromium browser', 1, true))
  assert(setupRow('gpu').label == 'Graphics card' and setupRow('gpu').description == 'NVIDIA GeForce RTX 4070, 12 GB of video memory.')
  assert(setupRow('internet').description:find('Allow Node.js through your firewall', 1, true))
  assert(category('help-setup').description == 'Problems found: 2. Select a line marked Problem to read what to do.', category('help-setup').description)
  -- one request per opening: staying on the page and pumping asks nothing more (the first-load check asks once, twelve seconds in)
  serviceUp()
  pump(false, 10)
  assert(requestWrites() == 1, requestWrites())
`));

test('without the setup module the Help page keeps its groups and shows only the Conversation service row first', () => run(`${helpFixture()}
  assert(invoke('tab:settings').ok and invoke('help').ok)
  assert(loaded.categories[2].id == 'help-setup' and #loaded.categories[2].settings == 1 and loaded.categories[2].description == '')
  assert(row('help-service') and row('help-steps') and not row('setup:files') and not convaiSetupCheck)
`));

test('the first load: a missing framework is announced once in gameplay, after twelve seconds', () => run(`${helpFixture(true, true)}
  ${setupWorld}
  Codeware = nil; convaiNative = {present = true}; function player:ConvaiRequirements() return '' end
  files['runtime/knowledge-status.json'] = nil
  pump(true, 10)
  assert(#popups == 0, 'twelve seconds after the first world have not passed yet')
  pump(true, 20)
  assert(#popups == 1 and popups[1] == 'Codeware is missing. Install it from Nexus Mods, then restart the game.', popups[1] or 'no popup')
  pump(true, 60)
  assert(#popups == 1, 'once per game session')
  assert(consoleHas('Codeware is missing'), 'the notice is logged too')
  assert(not consoleHas('Native Settings UI is missing'), 'Native Settings UI is there, so its line is not printed')
`));

test('without Native Settings UI the CET console, probe.log and a game notification say so', () => run(`${helpFixture(true, true, false)}
  ${setupWorld}
  assert(ns.data[TAB] == nil, 'the manager has no tab without Native Settings UI')
  -- probe.log is appended to; the harness's files keep only a whole write, so this one is recorded line by line
  local probe, baseOpen = {}, io.open
  io.open = function(path, mode)
    if mode == 'a' and path == 'runtime/probe.log' then
      return {write = function(self, ...) for index = 1, select('#', ...) do probe[#probe + 1] = tostring((select(index, ...))) end return self end, close = function() return true end}
    end
    return baseOpen(path, mode)
  end
  files['runtime/knowledge-status.json'] = nil
  pump(true, 30)
  assert(consoleHas('AI NPC Cyberpunk Mod: the Companion Manager needs Mod Configuration Menu 0.10.5 or newer, or Native Settings UI 1.96 or newer, and neither was found. Install Mod Configuration Menu (https://www.nexusmods.com/cyberpunk2077/mods/31640) or Native Settings UI (https://www.nexusmods.com/cyberpunk2077/mods/3518) from Nexus Mods, then restart the game.'), table.concat(consoleLines, ' | '))
  local lines = 0
  for _, line in ipairs(consoleLines) do if line:find('neither was found', 1, true) then lines = lines + 1 end end
  assert(lines == 1, 'one clear line, not one per update')
  assert(table.concat(probe):find('neither was found', 1, true), 'probe.log has the line')
  assert(#popups == 1 and popups[1] == 'The Companion Manager needs Mod Configuration Menu 0.10.5 or newer, or Native Settings UI', popups[1] or 'no popup')
`));

test('without this mod’s scripts the notice is written to the warning line itself, once, when gameplay is on screen', () => run(`${helpFixture(true, true)}
  ${setupWorld}
  player.ConvaiPhoneIsOpen = nil
  player.ConvaiPhoneFeedback = nil
  local written, menu = {}, true
  local board = {SetVariant = function(_, id, value) written[#written + 1] = value end, GetBool = function() return menu end}
  Game.GetAllBlackboardDefs = function() return {UI_Notifications = {WarningMessage = 'warning'}, UI_System = {IsInMenu = 'menu'}} end
  Game.GetBlackboardSystem = function() return {Get = function() return board end} end
  SimpleScreenMessage = {new = function() return {} end}
  Enum = {new = function(name, value) return name .. '.' .. value end}
  ToVariant = function(value) return value end
  files['runtime/knowledge-status.json'] = nil
  pump(false, 30)
  assert(#written == 0 and #popups == 0, 'a menu is open: nothing is shown yet')
  menu = false
  pump(false, 6)
  assert(#written == 0, 'gameplay is back: the HUD may not exist yet, the notice waits for it to settle')
  pump(false, 14)
  assert(#written == 1 and #popups == 0, 'written to the warning line, not through this mod’s scripts')
  assert(written[1].message == 'Open r6/logs/redscript_rCURRENT.log. A mod it names is why the scripts did not load.' and written[1].isShown == true and written[1].duration == 9, written[1].message)
  pump(false, 60)
  assert(#written == 1, 'once')
`));

test('a player with none of the scripts’ methods: the menu update and the manager run quietly every frame, the Help page names the scripts, and the notice reaches the screen', () => run(`${helpFixture(true, true)}
  ${setupWorld}
  -- every method this mod's scripts add is gone (they did not compile); the game's own methods stay
  for key in pairs(player) do if key:find('^Convai') then player[key] = nil end end
  assert(player.ConvaiManagerSetVoice == nil and player.ConvaiPhoneIsOpen == nil and player.ConvaiComposerOpen == nil)
  local written, menu = {}, true
  local board = {SetVariant = function(_, id, value) written[#written + 1] = value end, GetBool = function() return menu end}
  Game.GetAllBlackboardDefs = function() return {UI_Notifications = {WarningMessage = 'warning'}, UI_System = {IsInMenu = 'menu'}} end
  Game.GetBlackboardSystem = function() return {Get = function() return board end} end
  SimpleScreenMessage = {new = function() return {} end}
  Enum = {new = function(name, value) return name .. '.' .. value end}
  ToVariant = function(value) return value end
  files['runtime/knowledge-status.json'] = nil
  -- the manager's tick, as init.lua makes it, and the menu's update: neither may raise, on any of 60 frames
  local function frames(count)
    for _ = 1, count do
      advance(0.5)
      local managed, why = pcall(manager.update, player, 0.1)
      assert(managed, tostring(why))
      managerUi.update(player, false)
    end
  end
  frames(60)
  assert(#written == 0, 'a menu is open: nothing is shown yet')
  assert(invoke('tab:settings').ok and invoke('help').ok, 'the settings and the Help page still open')
  assert(setupRow('redscript').value == 'Problem' and setupRow('redscript').description:find('r6/logs/redscript_rCURRENT.log', 1, true), setupRow('redscript').description)
  assert(setupRow('redscript').description:find('If the error names another mod, that mod is the problem.', 1, true))
  assert(setupRow('codeware').value == 'OK' or setupRow('codeware').value == 'Unknown')
  menu = false
  frames(6)
  assert(#written == 0, 'gameplay is back: the notice waits for it to settle')
  frames(14)
  assert(#written == 1 and written[1].message == 'Open r6/logs/redscript_rCURRENT.log. A mod it names is why the scripts did not load.', written[1] and written[1].message or 'no notice')
  assert(consoleHas("this mod's scripts did not load. Open r6/logs/redscript_rCURRENT.log."), table.concat(consoleLines, ' | '))
  frames(60)
  assert(#written == 1, 'once')
`));
