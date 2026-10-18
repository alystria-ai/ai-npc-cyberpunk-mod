import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

// The Help page inside the real MCM adapter. The harness below mirrors the one
// in manager.test.mjs (real manager.lua, mcm.lua and manager-party.lua over a
// fake native MCM and game), with support-report.lua added to its module map.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = name => readFileSync(new URL(`../mod/${name}`, import.meta.url), 'utf8');
const managerSource = read('manager.lua'), queueSource = read('manager-party.lua'), mcmSource = read('mcm.lua');
const voicePreviewSource = read('voice-preview.lua'), fontsSource = read('ui-fonts.lua'), mcmFontsSource = read('mcm-fonts.lua');
const supportSource = read('support-report.lua'), serviceSource = read('service-status.lua'), editorSource = read('character-editor.lua');

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(uiLocaleBootstrap + code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

const storage = `
  local files, saved, seed, extras = {}, nil, {}, nil
  local jsonFixtures, jsonSequence, fileWrites = {}, 0, {}
  local failSave = false
  io = {open = function(path, mode)
    if mode == 'rb' then
      if not files[path] then return nil end
      return {read = function() return files[path] end, close = function() return true end}
    end
    if failSave then return nil end
    return {write = function(_, value)
      fileWrites[#fileWrites + 1] = {path = path, value = value}
      files[path] = value; return true
    end, close = function() return true end}
  end}
  json = {decode = function(value)
    if jsonFixtures[value] then return jsonFixtures[value] end
    if value == 'seed' then return seed end
    if value == 'extras' then return extras end
    if value == 'saved' then return saved end
    error('unexpected JSON fixture')
  end, encode = function(value)
    if value.action == 'clear' then
      jsonSequence = jsonSequence + 1
      local token = 'memory-json-' .. jsonSequence
      jsonFixtures[token] = value
      return token
    end
    jsonSequence = jsonSequence + 1
    local token = 'settings-json-' .. jsonSequence
    jsonFixtures[token] = value
    return token
  end}
  os.rename = function(from, to)
    if not files[from] or files[to] then return nil end
    files[to], files[from] = files[from], nil
    if to == 'runtime/settings.json' then saved = jsonFixtures[files[to]] end
    return true
  end
  os.remove = function(path) files[path] = nil; return true end
`;

const managerFixture = `
  ${storage}
  local defs, members, spawned, nextSerial = {}, {}, {}, 0
  local api = {}
  function api.definition(key) return defs[key] end
  function api.registerDefinition(key, value) defs[key] = value; return true end
  function api.list() return members end
  function api.spawn(key)
    nextSerial = nextSerial + 1
    spawned[#spawned + 1] = key
    local def = assert(defs[key])
    members[#members + 1] = {serial = nextSerial, key = key, name = def.name,
      profileKey = def.profileKey, profileName = def.profileName or def.name,
      record = def.id, state = 'spawning'}
    return nextSerial
  end
  function api.dismiss(serial)
    for index, member in ipairs(members) do
      if member.serial == serial then table.remove(members, index); return true end
    end
    return false
  end
  function api.setProfile(serial, key, name)
    for _, member in ipairs(members) do
      if member.serial == serial then member.profileKey, member.profileName = key, name; return true end
    end
    return false, 'That companion is no longer in your party.'
  end
  local scans, visits = 0, 0
  TweakDB = {}
  function TweakDB:GetRecords(kind)
    assert(kind == 'gamedataCharacter_Record')
    scans = scans + 1
    local result = {}
    for index = 1, 6000 do
      local id = index == 1 and 'Character.Silverhand' or ('Character.Model_' .. index)
      result[index] = {GetID = function() visits = visits + 1; return id end}
    end
    return result
  end
  function TweakDB:GetFlat(id) return id:gsub('%.displayName$', '') end
  GetLocalizedText = function(text) return text end
  local player = {hash = 'player-1', open = true, queue = {}, rows = {}, voice = true, subtitles = true}
  function player:GetEntityID() return {hash = self.hash} end
  function player:ConvaiManagerIsOpen() return self.open end
  function player:ConvaiManagerTakeRequest() return table.remove(self.queue, 1) or '' end
  function player:ConvaiManagerClearRows() self.rows = {} end
  function player:ConvaiManagerAddRow(key, label, note, selected)
    self.rows[#self.rows + 1] = {key = key, label = label, note = note, selected = selected}
    assert(#self.rows <= 8, 'unbounded native rows')
  end
  function player:ConvaiManagerSetDetail(...) self.detail = {...} end
  function player:ConvaiManagerSetPage(...) self.page = {...} end
  function player:ConvaiManagerSetTab(value) self.tab = value end
  function player:ConvaiManagerSetSearch(value) self.search = value end
  function player:ConvaiManagerSetFeedback(value) self.feedback = value end
  function player:ConvaiManagerSetPartyStatus(value) self.partyStatus = value end
  function player:ConvaiManagerRefresh() self.refreshes = (self.refreshes or 0) + 1 end
  function player:ConvaiManagerSetVoice(value) self.voice = value end
  function player:ConvaiManagerVoice() return self.voice end
  function player:ConvaiManagerSetSubtitles(value) self.subtitles = value end
  function player:ConvaiManagerSubtitles() return self.subtitles end
  function player:ConvaiManagerSetEnabled(index, value) self['legacy' .. index] = value end
  local profiles = {{key = 'viktor-vektor', name = 'Viktor Vektor', records = {'Character.Victor_Vector'}},
    {key = 'johnny-silverhand', name = 'Johnny Silverhand', records = {'Character.Silverhand'}}}
  for index = 1, 20 do profiles[#profiles + 1] = {key = 'person-' .. index,
    name = string.format('Person %02d', index), records = {'Character.Person_' .. index}, summary = 'A distinct person.'} end
  local manager = (function() ${managerSource} end)()
  local function request(value, dt) player.queue[#player.queue + 1] = value; manager.update(player, dt or 0.1) end
`;

const mcmFixture = (withSupport = true) => `
  ${managerFixture}
  local originalDofile = dofile
  dofile = function(path)
    if path == 'voice-preview.lua' then return (function() ${voicePreviewSource} end)() end
    if path == 'support-report.lua' then if not ${withSupport} then error('module absent') end return (function() ${supportSource} end)() end
    if path == 'service-status.lua' then return (function() ${serviceSource} end)() end
    if path == 'character-editor.lua' then return (function() ${editorSource} end)() end
    if path == 'ui-fonts.lua' then return (function() ${fontsSource} end)() end
    if path == 'mcm-fonts.lua' then return (function() ${mcmFontsSource} end)() end
    return originalDofile(path)
  end
  manager.configure(api, profiles)
  convaiNotices.configure(function() return manager.developerMode() end) -- as init.lua does
  local handlers, registered, loaded, activeMod = {}, nil, nil, nil
  local drafts, reloads = false, 0
  local nativeApi = {apiVersion = 2, providers = {}}
  nativeApi.providers.registerProvider = function(value) registered = value; return true end
  nativeApi.providers.unregisterProvider = function(id) assert(id == registered.id); registered = nil; return true end
  nativeApi.refreshProvider = function() return true end
  nativeApi.getDiagnostics = function() return {activeModKey = activeMod} end
  nativeApi.hasDrafts = function() return drafts end
  nativeApi.reloadMod = function()
    reloads = reloads + 1; loaded = registered.loadMod('manager'); return loaded
  end
  GetMod = function(name) assert(name == 'ModConfigurationMenuAPI'); return nativeApi end
  Game = {GetPlayer = function() return player end}
  Observe = function(class, method, callback) handlers[method] = callback end
  ObserveAfter = Observe
  Override = Observe
  local entryFactory = {new = function()
    return {install = function() end, update = function() end, selected = function() end,
      state = function() return 'idle' end, reset = function() end, open = function() return true end}
  end}
  local mcm = (function() ${mcmSource} end)()
  mcm.configure(manager, api, (function() ${queueSource} end)(), entryFactory)
  mcm.install()
  activeMod = 'cyberpunk-convai:manager'
  loaded = registered.loadMod('manager')
  local function row(id)
    for _, category in ipairs(loaded.categories) do
      for _, setting in ipairs(category.settings) do if setting.id == id then return setting end end
    end
  end
  local controller = {nativeIdentity = 101,
    McmUiEmitSearch = function(_, context, value) handlers.McmUiEmitSearch(nil, context, value) end}
  CalcSeed = function(value) return value.nativeIdentity end
  local function invoke(id)
    local result = registered.invokeAction('manager', id, {interaction = {controller = controller}})
    if result.ok and result.schemaChanged then loaded = registered.loadMod('manager') end
    return result
  end
`;

const helpFixture = (withSupport = true) => `
  ${mcmFixture(withSupport)}
  local clockNow, popups = 1800000000, {}
  local cpu = 0
  os.time = function() return clockNow end
  os.clock = function() return cpu end
  local function advance(seconds) clockNow = clockNow + seconds; cpu = cpu + seconds end
  -- Navigation leaves MCM's search settling for a few frames before it refreshes the page.
  local function pump(gameplay, frames) for _ = 1, frames or 10 do advance(0.5); mcm.update(player, gameplay) end end
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
  assert(invoke('help').ok and mcm.inspect().view == 'help')
  assert(mcm.inspect().back.id == 'help:back' and countBack() == 0, 'parent Back must be the bottom-row button only')
  assert(not category('navigation') and not row('party-count'))
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
  assert(invoke('help:back').ok and mcm.inspect().view == 'settings' and row('help'))
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
  assert(row('help-log-launcher').description:find('red4ext\\\\plugins\\\\AiNpcCyberpunkMod\\\\launcher.log', 1, true), row('help-log-launcher').description)
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
  assert(open.description:find('Mistral and Local, not Convai', 1, true), 'the row says the editor does not apply to Convai')
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
  assert(command.strings['Save'] and command.strings['Convai is answering right now, so these changes have no effect yet. Choose Mistral or Local as the conversation provider in the settings.'])
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

test('a service that never started for want of a browser says so on Settings and on Help, and a plain stop does not', () => run(`${helpFixture()}
  local sentence = 'The conversation service needs a Chromium browser such as Microsoft Edge, Google Chrome, Brave or Opera. Install one, then restart the game.'
  jsonFile('runtime/bridge-service.json', {state = 'failed', code = 'browser-missing', updated = os.time() * 1000.0, since = os.time() * 1000.0 - 5000})
  assert(invoke('tab:settings').ok)
  -- The status line, and the Local AI model row that must not claim "No model installed" while nothing is running.
  assert(row('voice-status').value == 'Needs a browser', tostring(row('voice-status').value))
  assert(row('voice-status').description == sentence)
  local model = row('localModel')
  assert(model.elements[1] == 'Service not running' and model.description:sub(1, #sentence) == sentence, tostring(model.elements[1]))
  assert(invoke('help').ok)
  assert(row('help-service').value == 'Needs a browser' and row('help-service').description == sentence)
  -- A plain stop: the row says the service is not running with the ordinary sentence, and the status line is unchanged.
  jsonFile('runtime/bridge-service.json', {state = 'stopped', updated = os.time() * 1000.0, since = os.time() * 1000.0 - 5000})
  os.time = (function(real) return function() return real() + 2 end end)(os.time)
  assert(invoke('help:back').ok)
  assert(row('voice-status').value ~= 'Needs a browser')
  assert(row('localModel').elements[1] == 'Service not running' and row('localModel').description:find('is not running', 1, true))
  assert(invoke('help').ok)
  assert(row('help-service').value == 'Not running' and row('help-service').description:find('restart the game', 1, true))
`));
