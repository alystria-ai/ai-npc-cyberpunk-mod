import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

// mod/setup-check.lua over a fake game: the frameworks CET can see, a fake mod folder (files, directory listing, clock) and the real
// service-status.lua. Counts every file opened and every game call, so the "nothing runs per frame" promise is a test, not a comment.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/setup-check.lua', import.meta.url), 'utf8');
const serviceSource = readFileSync(new URL('../mod/service-status.lua', import.meta.url), 'utf8');
const supportSource = readFileSync(new URL('../mod/support-report.lua', import.meta.url), 'utf8');
const catalog = JSON.parse(readFileSync(new URL('../localization/en.json', import.meta.url), 'utf8')).strings;

function run(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  try {
    const program = uiLocaleBootstrap + fixture + body;
    const result = lauxlib.luaL_dostring(state, to_luastring(program));
    const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(result, lua.LUA_OK, error + (line ? `\n${program.split('\n')[line - 1]}` : ''));
  } finally { lua.lua_close(state); }
}

const fixture = String.raw`
local escapes = {n = '\n', t = '\t', r = '\r', b = '\b', f = '\f', ['"'] = '"', ['\\'] = '\\', ['/'] = '/'}
local function skip(text, index) return text:find('%S', index) or #text + 1 end
local decodeValue
local function decodeString(text, index)
  local out, position = {}, index + 1
  while true do
    local char = text:sub(position, position)
    if char == '' then error('unterminated string') end
    if char == '"' then return table.concat(out), position + 1 end
    if char == '\\' then
      local next = text:sub(position + 1, position + 1)
      if next == 'u' then out[#out + 1] = utf8.char(tonumber(text:sub(position + 2, position + 5), 16)); position = position + 6
      else out[#out + 1] = escapes[next]; position = position + 2 end
    else out[#out + 1] = char; position = position + 1 end
  end
end
decodeValue = function(text, index)
  index = skip(text, index)
  local char = text:sub(index, index)
  if char == '{' then
    local result = {}; index = skip(text, index + 1)
    if text:sub(index, index) == '}' then return result, index + 1 end
    while true do
      local key; key, index = decodeString(text, skip(text, index))
      index = skip(text, index); assert(text:sub(index, index) == ':', 'colon'); local value
      value, index = decodeValue(text, index + 1); result[key] = value
      index = skip(text, index)
      local separator = text:sub(index, index); index = index + 1
      if separator == '}' then return result, index end
      assert(separator == ',', 'comma')
    end
  elseif char == '[' then
    local result = {}; index = skip(text, index + 1)
    if text:sub(index, index) == ']' then return result, index + 1 end
    while true do
      local value; value, index = decodeValue(text, index); result[#result + 1] = value
      index = skip(text, index)
      local separator = text:sub(index, index); index = index + 1
      if separator == ']' then return result, index end
      assert(separator == ',', 'comma')
    end
  elseif char == '"' then return decodeString(text, index)
  elseif text:sub(index, index + 3) == 'true' then return true, index + 4
  elseif text:sub(index, index + 4) == 'false' then return false, index + 5
  elseif text:sub(index, index + 3) == 'null' then return nil, index + 4
  else
    local number = text:match('^-?%d+%.?%d*[eE]?[+-]?%d*', index)
    assert(number and #number > 0, 'bad json at ' .. index)
    return tonumber(number), index + #number
  end
end
local function encodeValue(value)
  local kind = type(value)
  if kind == 'string' then return '"' .. value:gsub('[%c"\\]', function(c) return string.format('\\u%04x', c:byte()) end) .. '"' end
  if kind == 'number' or kind == 'boolean' then return tostring(value) end
  if kind == 'table' then
    local count, isArray = 0, true
    for key in pairs(value) do count = count + 1; if type(key) ~= 'number' then isArray = false end end
    local parts = {}
    if isArray then for _, item in ipairs(value) do parts[#parts + 1] = encodeValue(item) end return '[' .. table.concat(parts, ',') .. ']' end
    for key, item in pairs(value) do parts[#parts + 1] = encodeValue(tostring(key)) .. ':' .. encodeValue(item) end
    return '{' .. table.concat(parts, ',') .. '}'
  end
  return 'null'
end
json = {decode = function(text) return (decodeValue(text, 1)) end, encode = encodeValue}

-- time: os.time is the clock the module reads, advance() moves it (and os.clock with it)
local clock, cpu = 1800000000, 0
os.time = function() return clock end
os.clock = function() return cpu end
os.date = function() return '2026-10-19T12:00:00Z' end
function advance(seconds) clock = clock + seconds; cpu = cpu + seconds end
function ms(offset) return (clock + (offset or 0)) * 1000.0 end

-- files: every open is recorded; the module only ever reads, appends to probe.log and rewrites the request file in place
files, opened, console, removed = {}, {}, {}, {}
io.open = function(path, mode)
  opened[#opened + 1] = mode .. ' ' .. path
  if mode == 'rb' then
    local data = files[path]
    if data == nil then return nil end
    return {read = function(_, amount) return data:sub(1, amount) end, close = function() return true end}
  end
  local buffer = {}
  return {write = function(self, ...)
    for index = 1, select('#', ...) do buffer[#buffer + 1] = tostring((select(index, ...))) end
    return self
  end, close = function()
    files[path] = (mode == 'a' and (files[path] or '') or '') .. table.concat(buffer)
    return true
  end}
end
os.remove = function(path) removed[#removed + 1] = path; return true end
os.rename = function(from) error('os.rename ' .. from) end
dir = function(folder)
  local list, escaped = {}, folder:gsub('%p', '%%%0')
  for path in pairs(files) do
    local name = path:match('^' .. escaped .. '/([^/]+)$')
    if name then list[#list + 1] = {name = name, type = 'file'} end
  end
  return list
end
print = function(...)
  local parts = {}
  for index = 1, select('#', ...) do parts[#parts + 1] = tostring((select(index, ...))) end
  console[#console + 1] = table.concat(parts, ' ')
end
function put(path, value) files[path] = type(value) == 'string' and value or json.encode(value) end

-- the game as CET shows it: env says what is installed; applyEnv() builds the globals from it (call it again after changing env)
env = {cet = '1.37.1', gameVersion = '2.31', codeware = '1.20.5', tweakxl = '1.11.4', audioware = '1.9.9', scripts = true,
  native = false, mcm = 'ok', player = true, paused = false, menu = false}
gameCalls = 0
function applyEnv()
  GetVersion = env.cet and function() return env.cet end or nil
  Codeware = env.codeware and {Version = function() return env.codeware end} or nil
  TweakXL = env.tweakxl and {Version = function() return env.tweakxl end} or nil
  convaiNative = env.native and {present = true} or nil
  GetMod = function(name)
    assert(name == 'ModConfigurationMenuAPI')
    if env.mcm == 'ok' then return {apiVersion = 2, providers = {}} end
    if env.mcm == 'old' then return {apiVersion = 1} end
    return nil
  end
  local real = {
    GetPlayer = function()
      if not env.player then return nil end
      return {ConvaiPhoneIsOpen = env.scripts == true and function() return false end or nil}
    end,
    GetSystemRequestsHandler = function()
      return {GetGameVersion = function() return env.gameVersion end,
        IsPreGame = function() return false end, IsGamePaused = function() return env.paused end}
    end,
    GetAudioSystemExt = env.audioware and function() return {Version = function() return env.audioware end} end or nil,
    GetAllBlackboardDefs = function() return {UI_System = {IsInMenu = 'menu'}} end,
    GetBlackboardSystem = function() return {Get = function() return {GetBool = function() return env.menu end} end} end,
  }
  -- every access to Game is counted
  Game = setmetatable({}, {__index = function(_, key) gameCalls = gameCalls + 1; return real[key] end})
end
applyEnv()

convaiServiceStatus = (function() ${serviceSource} end)()
check = (function() ${source} end)()
convaiSetupCheck = check

function installFiles()
  for _, name in ipairs({'world-knowledge.json', 'manager-characters.json', 'conversation-characters.json', 'phone-contacts.json'}) do put(name, '{}') end
  for _, code in ipairs({'cs','de','es','fr','hu','it','ja','ko','pl','pt-br','ru','tr','uk','zh-cn','zh-tw'}) do put('locales/' .. code .. '.lua', 'return {}') end
  put('release.json', {product = 'AI-NPC-Cyberpunk-Mod', package = 'scripts', version = '0.2.1'})
end
function serviceRunning() put('runtime/knowledge-status.json', {version = 1, updated = ms()}) end
function lineOf(id)
  for _, item in ipairs(check.lines()) do if item.id == id then return item end end
end
function ids()
  local list = {}
  for _, item in ipairs(check.lines()) do list[#list + 1] = item.id .. '=' .. item.state end
  return table.concat(list, ' ')
end
function opens() return #opened end
-- the service's answer: one document of seven checks, any of them replaced by the test
function answer(checks, request)
  local document = {version = 1, updated = ms(), bridgePid = 4242, request = request, checks = {}}
  local defaults = {
    {id = 'versions', state = 'ok', code = 'match', scripts = '0.2.1', runtime = '0.2.1'},
    {id = 'packs', state = 'ok', code = 'ok', found = {}, nested = {}, moved = {}},
    {id = 'browser', state = 'ok', code = 'found', name = 'Microsoft Edge'},
    {id = 'local-ai', state = 'ok', code = 'not-used'},
    {id = 'internet', state = 'ok', code = 'reachable', service = 'convai', host = 'api.convai.com'},
    {id = 'gpu', state = 'ok', code = 'found', name = 'NVIDIA GeForce RTX 4070', memoryMiB = 12282},
    {id = 'mod-manager', state = 'ok', code = 'none', managers = {}},
  }
  for _, item in ipairs(defaults) do
    local replaced = checks and checks[item.id]
    document.checks[#document.checks + 1] = replaced or item
  end
  put('runtime/setup-check.json', document)
  return document
end
`;

test('every message the module can show is a catalogued English UI key', () => {
  const literals = [...source.matchAll(/ui\.t\('((?:[^'\\]|\\.)*)'/g)].map(match => match[1].replace(/\\'/g, "'"));
  assert(literals.length >= 40, `${literals.length} strings`);
  for (const text of literals) assert.equal(catalog[text], text, `missing from localization/en.json: ${text}`);
});

test('with everything installed every line says OK, nothing is a problem and the check opens only the files it names', () => run(String.raw`
  installFiles(); serviceRunning()
  assert(ids() == 'files=ok game=ok cet=ok red4ext=ok redscript=ok codeware=ok tweakxl=ok audioware=ok mcm=ok', ids())
  assert(check.problemCount() == 0 and #check.problems() == 0)
  local files_, game_, red4ext_ = lineOf('files'), lineOf('game'), lineOf('red4ext')
  assert(files_.label == 'Mod files' and files_.value == 'OK' and files_.description == 'All files found.')
  assert(game_.label == 'Game version' and game_.description == 'Version 2.31.')
  assert(red4ext_.label == 'RED4ext' and red4ext_.description == 'Loaded.')
  assert(lineOf('codeware').description == 'Version 1.20.5.' and lineOf('tweakxl').description == 'Version 1.11.4.' and lineOf('audioware').description == 'Version 1.9.9.')
  assert(lineOf('cet').description == 'Version 1.37.1.' and lineOf('mcm').description == 'Found.')
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
  -- RED4ext not loaded: nothing it loads answers, and this mod's scripts (which import Codeware and Audioware) did not compile either
  env.codeware, env.tweakxl, env.audioware, env.scripts, env.native = nil, nil, nil, false, false
  applyEnv(); check.run()
  assert(lineOf('red4ext').state == 'problem' and lineOf('red4ext').value == 'Problem')
  assert(lineOf('red4ext').description:find('RED4ext is not loaded', 1, true) and lineOf('red4ext').description:find('Nexus Mods', 1, true))
  for _, id in ipairs({'codeware', 'tweakxl', 'audioware', 'redscript'}) do assert(lineOf(id).state == 'problem', id) end
  assert(table.concat(check.problems(), ',') == 'red4ext,codeware,redscript,audioware,tweakxl', table.concat(check.problems(), ','))
  assert(check.problemCount() == 5)
  -- only TweakXL missing: the others stay OK and the fix names it
  env.codeware, env.tweakxl, env.audioware, env.scripts = '1.20.5', nil, '1.9.9', true
  applyEnv(); check.run()
  assert(table.concat(check.problems(), ',') == 'tweakxl')
  assert(lineOf('tweakxl').description == 'TweakXL is missing. Install it from Nexus Mods, then restart the game.')
  assert(lineOf('codeware').state == 'ok' and lineOf('red4ext').state == 'ok')
  -- Codeware and Audioware are implied by this mod's scripts having loaded, even when their own probes fail
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

test('Mod Configuration Menu: present, too old, or missing, each with its own code', () => run(String.raw`
  installFiles(); serviceRunning()
  check.run()
  assert(lineOf('mcm').state == 'ok')
  env.mcm = 'old'; applyEnv(); check.run()
  assert(lineOf('mcm').state == 'problem' and table.concat(check.problems(), ',') == 'mcm')
  assert(lineOf('mcm').description == 'Mod Configuration Menu is missing. Install it from Nexus Mods, then restart the game.')
  local old = table.concat(check.reportLines(), '\n')
  assert(old:find('mcm: problem old', 1, true), old)
  env.mcm = 'none'; applyEnv(); check.run()
  assert(table.concat(check.reportLines(), '\n'):find('mcm: problem missing', 1, true))
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
  for _, code in ipairs({'install-incomplete', 'bridge-missing', 'missing-character-ids', 'launcher-not-configured', 'launcher-program-missing', 'launcher-directory-missing'}) do
    advance(1); put('runtime/bridge-service.json', {version = 1, state = 'failed', code = code, updated = ms()})
    check.run()
    local line = check.serviceLine()
    assert(line and line.value == 'Not running' and line.description == 'The Runtime is incomplete (' .. code .. '). Download it again and extract it into the Cyberpunk 2077 folder, then restart the game.', code)
    assert(#check.problems() == 0, 'a failed service has its own notice (service-down), the first-load notice leaves it alone')
    assert(check.problemCount() == 1, 'but it counts on the page')
  end
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
  assert(ids() == 'files=ok game=ok cet=ok red4ext=ok redscript=ok codeware=ok tweakxl=ok audioware=ok mcm=ok', 'no answer yet: only the game side')
  -- an answer from an earlier game session (older than the mod's load) is ignored
  local old = answer(); old.updated = ms(-3600); put('runtime/setup-check.json', old)
  check.run()
  assert(not ids():find('browser', 1, true))
  answer(); check.run()
  assert(ids() == 'versions=ok files=ok game=ok cet=ok red4ext=ok redscript=ok codeware=ok tweakxl=ok audioware=ok mcm=ok packs=ok browser=ok local-ai=ok internet=ok gpu=ok mod-manager=ok', ids())
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
  assert(lineOf('versions').state == 'problem' and lineOf('versions').description == 'Scripts 0.2 and Runtime 0.2.1 do not match. Download both for the same version and extract them into the Cyberpunk 2077 folder.')
  assert(table.concat(check.problems(), ',') == 'versions' and check.lines()[1].id == 'versions', 'the versions line sits first, next to the service')
  -- a version check that could not be made shows no line
  answer({versions = {id = 'versions', state = 'unknown', code = 'unknown'}}); check.run()
  assert(lineOf('versions') == nil)
`));

test('optional packs: found, moved by the launcher, one folder too deep, and files it could not move', () => run(String.raw`
  installFiles(); serviceRunning()
  answer({packs = {id = 'packs', state = 'ok', code = 'ok', found = {'Local AI standard', 'OmniVoice'}, nested = {}, moved = {{pack = 'Mature lite', from = 'Mature-pack'}}}}); check.run()
  assert(lineOf('packs').state == 'ok' and lineOf('packs').description == 'Found: Local AI standard, OmniVoice.\nMoved into place from Mature-pack: Mature lite.', lineOf('packs').description)
  answer({packs = {id = 'packs', state = 'problem', code = 'nested', found = {}, nested = {{pack = 'Local AI standard', folder = 'AI-NPC-Local-AI-0.2.1'}, {pack = 'OmniVoice', folder = 'other'}}, moved = {}}}); check.run()
  assert(lineOf('packs').state == 'problem' and lineOf('packs').description == 'Local AI standard is one folder too deep, in AI-NPC-Local-AI-0.2.1. Move the red4ext folder inside it into the Cyberpunk 2077 folder, then restart the game.')
  assert(table.concat(check.problems(), ',') == 'packs')
  answer({packs = {id = 'packs', state = 'problem', code = 'conflict', found = {}, nested = {}, moved = {}}}); check.run()
  assert(lineOf('packs').description:find('could not be moved into place because different files are already there', 1, true))
  assert(table.concat(check.problems(), ',') == 'packs')
`));

test('the browser, Local AI and the internet: every state has its own line and fix', () => run(String.raw`
  installFiles(); serviceRunning()
  answer({browser = {id = 'browser', state = 'problem', code = 'missing'}}); check.run()
  assert(lineOf('browser').state == 'problem' and lineOf('browser').description == 'The conversation service needs a Chromium browser such as Microsoft Edge, Google Chrome, Brave or Opera. Install one, then restart the game.')
  assert(#check.problems() == 0, 'a missing browser is told by the service status and its own notice')
  answer({browser = {id = 'browser', state = 'unknown', code = 'unknown'}}); check.run()
  assert(lineOf('browser') == nil, 'a browser not looked up yet (the first, light answer) shows no line')
  local states = {
    {'ready', 'ok', 'Local AI is ready.'}, {'warming', 'ok', 'Local AI is warming up…'},
    {'not-installed', 'problem', 'No Local AI pack found. Download one from the mod’s Hugging Face page and extract it into the Cyberpunk 2077 folder, or choose another conversation provider.'},
    {'no-memory', 'problem', 'Not enough graphics memory for Local AI. A cloud provider is used instead.'},
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
  env.mcm = 'none'; applyEnv()
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
  assert(notice == 'Install Mod Configuration Menu from Nexus Mods to open the Companion Manager.', tostring(notice))
  assert(check.inspect().firstDone)
  -- without Mod Configuration Menu the CET console and probe.log say it too, in English
  assert(#console == 1 and console[1] == '[AiNpcCyberpunkMod] AI NPC Cyberpunk Mod: Mod Configuration Menu is missing or too old, so the Companion Manager cannot open. Install Mod Configuration Menu 0.10.3 or newer from Nexus Mods, then restart the game.', console[1])
  local log = files['runtime/probe.log']
  assert(log:find('Setup check: problems: mcm', 1, true) and log:find('Mod Configuration Menu is missing or too old', 1, true), log)
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
  assert(#console == 0, 'Mod Configuration Menu is there, so the console stays quiet')
`));

test('the first load announces one problem: the most fundamental, in the fixed order', () => run(String.raw`
  installFiles(); serviceRunning()
  -- TweakXL and Mod Configuration Menu both missing: TweakXL first; the console still names Mod Configuration Menu
  env.tweakxl, env.mcm = nil, 'none'; applyEnv()
  check.tick(true, true); advance(12); check.tick(true, true)
  local request = json.decode(files['runtime/setup-check-request.json'])
  answer({}, request.id); advance(1)
  local notice = check.tick(true, true)
  assert(notice == 'TweakXL is missing. Install it from Nexus Mods, then restart the game.', tostring(notice))
  assert(#console == 1 and console[1]:find('Mod Configuration Menu is missing or too old', 1, true))
  assert(table.concat(check.problems(), ',') == 'tweakxl,mcm', table.concat(check.problems(), ','))
`));

test('the first load names Scripts and Runtime of different versions, a pack one folder too deep and a blocked connection', () => {
  const cases = [
    ['versions', `{id = 'versions', state = 'problem', code = 'mismatch', scripts = '0.2', runtime = '0.2.1'}`,
      'The Scripts and Runtime versions do not match. Install the same version of both.'],
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
  assert(check.tick(false, true) == nil and check.inspect().held == 'This mod’s scripts did not load. Install redscript, then restart the game.', 'held while the game is paused')
  advance(1); env.menu = true
  assert(check.tick(false, true) == nil, 'held while a menu is open')
  advance(1); env.paused, env.menu = false, false
  assert(check.tick(false, true) == 'This mod’s scripts did not load. Install redscript, then restart the game.')
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
    'redscript: ok loaded', 'codeware: ok found 1.20.5', 'tweakxl: problem missing', 'audioware: ok found 1.9.9', 'mcm: ok found',
    'service versions: ok match scripts=0.2.1 runtime=0.2.1', 'service packs: problem nested found=Local AI lite nested=wrapped',
    'service browser: ok found name=Microsoft Edge', 'service internet: problem blocked host=api.mistral.ai service=mistral',
    'service gpu: ok found name=NVIDIA GeForce RTX 4070 memoryMiB=12282', 'service mod-manager: note vortex managers=vortex'}) do
    assert(lines:find(expected, 1, true), 'missing: ' .. expected .. '\n' .. lines)
  end
  local summary = check.summary()
  assert(#summary == 10 and summary[1].id == 'service' and summary[10].id == 'mcm')
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
  assert(text:find('tweakxl: problem missing', 1, true) and text:find('mcm: ok found', 1, true) and text:find('service checks: none from this game session', 1, true), text)
  -- without the module the section says so
  convaiSetupCheck = nil
  put('runtime/convai-report-lua.txt', '')
  assert(support.new({party = function() return {} end}).request())
  assert(files['runtime/convai-report-lua.txt']:find('== setup check ==\nnot available', 1, true))
`));
