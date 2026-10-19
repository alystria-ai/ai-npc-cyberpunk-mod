import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';
import {PLANTED, VECTORS} from './support-report-fixture.mjs';

// support-report.lua over a fake mod folder: files, directory listing, clock,
// JSON and clipboard. Reads of anything outside the allowed set fail the test.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const source = readFileSync(new URL('../mod/support-report.lua', import.meta.url), 'utf8');
const serviceSource = readFileSync(new URL('../mod/service-status.lua', import.meta.url), 'utf8');
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

const fixture = `
local json_ = {}
local function skip(text, index) return text:find('%S', index) or #text + 1 end
local decodeValue
local escapes = {n = '\\n', t = '\\t', r = '\\r', b = '\\b', f = '\\f', ['"'] = '"', ['\\\\'] = '\\\\', ['/'] = '/'}
local function decodeString(text, index)
  local out, position = {}, index + 1
  while true do
    local char = text:sub(position, position)
    if char == '' then error('unterminated string') end
    if char == '"' then return table.concat(out), position + 1 end
    if char == '\\\\' then
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
  if kind == 'string' then return '"' .. value:gsub('[%c"\\\\]', function(c) return string.format('\\\\u%04x', c:byte()) end) .. '"' end
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

local clock, cpu, stamps = 1800000000, 0, 0
os.time = function() return clock end
os.clock = function() return cpu end
os.date = function(format)
  if format == '%Y%m%d-%H%M%S' then stamps = stamps + 1; return string.format('20261005-12%04d', stamps) end
  return '2026-10-05 12:00:00'
end
function advance(seconds) clock = clock + seconds; cpu = cpu + seconds end

files, removed, readLog, blocked, reportsFolder, written = {}, {}, {}, {}, true, {}
local forbidden = {'convai%-key', 'token', 'huggingface', 'kaggle', '%.wav$', 'last%-input', 'phone%-chat', 'chat%-history', 'memory%-command'}
local function check(path)
  for _, pattern in ipairs(forbidden) do
    if path:lower():find(pattern) then error('forbidden read of ' .. path) end
  end
end
io.open = function(path, mode)
  if mode == 'rb' then
    readLog[#readLog + 1] = path; check(path)
    local data = files[path]
    if data == nil then return nil end
    local position = 0
    return {
      read = function(_, amount)
        if amount == '*a' then local rest = data:sub(position + 1); position = #data; return rest end
        local piece = data:sub(position + 1, position + amount); position = position + #piece; return piece
      end,
      seek = function(_, whence, offset)
        if whence == 'end' then position = #data + (offset or 0); return #data end
        position = offset or 0; return position
      end,
      close = function() return true end}
  end
  for prefix in pairs(blocked) do if path:sub(1, #prefix) == prefix then return nil end end
  if path:sub(1, 15) == 'runtime/reports' and not reportsFolder then return nil end
  local buffer = {}
  return {write = function(self, text) buffer[#buffer + 1] = text; return self end,
    close = function() files[path] = table.concat(buffer); written[#written + 1] = path; return true end}
end
dir = function(folder)
  if folder == 'runtime/reports' and not reportsFolder then error('no such directory') end
  local list, escaped = {}, folder:gsub('%p', '%%%0')
  for path in pairs(files) do
    local name = path:match('^' .. escaped .. '/([^/]+)$')
    if name then list[#list + 1] = {name = name, type = 'file'} end
  end
  return list
end
os.remove = function(path) removed[#removed + 1] = path; files[path] = nil; return true end
-- Windows cannot rename over an existing file, and a rename is a new file under Mod Organizer 2: the module must never rename.
os.rename = function(from, to) error('os.rename ' .. from .. ' -> ' .. to) end

function put(path, value)
  files[path] = type(value) == 'string' and value or json.encode(value)
end
function ms(offset) return (clock + (offset or 0)) * 1000.0 end
convaiServiceStatus = (function() ${serviceSource} end)()
local support = (function() ${source} end)()
function newSupport(options)
  options = options or {}
  options.party = options.party or function() return {} end
  return support.new(options)
end
function reportsWritten()
  local names = {}
  for path in pairs(files) do if path:match('convai%-report%-') then names[#names + 1] = path end end
  table.sort(names)
  return names
end
`;

test('every message the module can show is a catalogued English UI key', () => {
  const literals = [...source.matchAll(/ui\.t\('((?:[^'\\]|\\.)*)'/g)].map(match => match[1].replace(/\\'/g, "'"));
  assert(literals.length >= 12);
  for (const text of literals) assert.equal(catalog[text], text, `missing from localization/en.json: ${text}`);
});

test('the Lua redactor removes the same planted patterns as the service and keeps ordinary lines', () => {
  const cases = VECTORS.map(vector => ({...vector, input: vector.input}));
  const encode = value => JSON.stringify(value).replace(/\\u([0-9a-f]{4})/g, (_, hex) => `\\${parseInt(hex, 16)}`);
  run(`
    local redact = support.redactLine
    local cases = {}
    ${cases.map(vector => `cases[#cases + 1] = {input = ${encode(vector.input)}, gone = {${(vector.gone ?? []).map(encode).join(',')}}, keep = {${(vector.keep ?? []).map(encode).join(',')}}}`).join('\n    ')}
    for index, case in ipairs(cases) do
      local output = redact(case.input)
      for _, text in ipairs(case.gone) do assert(not output:find(text, 1, true), index .. ' kept ' .. text .. ' in ' .. output) end
      for _, text in ipairs(case.keep) do assert(output:find(text, 1, true), index .. ' lost ' .. text .. ' from ' .. output) end
    end
    assert(redact('bare ' .. ${encode(PLANTED.shortKey)}, {${encode(PLANTED.shortKey)}}):find(${encode(PLANTED.shortKey)}, 1, true) == nil)
    assert(redact('abc def', {'abc'}) == 'abc def', 'short strings are not secrets')
    local a, b = redact('id ${PLANTED.userId}'), redact('id ${PLANTED.userId}')
    assert(a == b and a:find('%[id:%x%x%x%x%x%x%x%x%]'), 'stable short id hash')
  `);
});

test('service reachable: the request goes to the service, the result completes it, and a notice follows once in gameplay', () => run(`
  put('runtime/knowledge-status.json', {version = 1, updated = ms()})
  local developer = false
  local s = newSupport({developerMode = function() return developer end,
    party = function() return {{key = 'bob-sagan', profileKey = 'bob-sagan', name = 'Bob', state = 'following', error = 'api-key=zzzSecret99'}} end})
  assert(s.serviceState() == 'running')
  local ok, message = s.request()
  assert(ok and message == 'Creating the report…' and s.status().phase == 'working')
  local request = json.decode(files['runtime/report-request.json'])
  assert(request.version == 1 and request.id:match('^r%d+%-1$') and request.issuedAt == clock * 1000 and request.lua.view == 'help')
  assert(request.lua.party[1].profile == 'bob-sagan' and request.lua.party[1].state == 'following')
  assert(not files['runtime/report-request.json']:find('zzzSecret99', 1, true), 'party errors are redacted before they are sent')
  assert(#reportsWritten() == 0, 'no Lua-side report while the service is answering')
  assert(not select(1, s.request()), 'only one report at a time')
  advance(1); put('runtime/report-result.json', {version = 1, id = 'other', state = 'ready', path = 'X', fileName = 'X'})
  assert(s.update(true) == nil and s.status().phase == 'working', 'another request id is ignored')
  advance(1); put('runtime/report-result.json', {version = 1, id = request.id, state = 'ready', mode = 'bridge',
    path = 'E:\\\\Game\\\\mod\\\\runtime\\\\reports\\\\convai-report-20261005-120000.zip', fileName = 'convai-report-20261005-120000.zip'})
  assert(s.update(false) == nil, 'a paused menu hides popups, so the notice waits')
  local status = s.status()
  assert(status.phase == 'ready' and status.mode == 'bridge' and status.fileName == 'convai-report-20261005-120000.zip')
  local short = '…' .. string.char(92) .. 'runtime' .. string.char(92) .. 'reports' .. string.char(92) .. string.char(10)
    .. 'convai-report-20261005-120000.zip'
  assert(s.displayPath() == short and not short:find('Game', 1, true))
  assert(s.banner() == 'Report saved: ' .. short, s.banner())
  assert(s.update(true) == nil, 'the saved-report popup is for Developer mode only')
  assert(s.update(true) == nil)
  -- With Developer mode on, a report announces itself once, with the short path.
  developer = true
  advance(1); local ok2 = s.request(); assert(ok2)
  local second = json.decode(files['runtime/report-request.json'])
  advance(1); put('runtime/report-result.json', {version = 1, id = second.id, state = 'ready', mode = 'bridge',
    path = status.path, fileName = 'convai-report-20261005-120000.zip'})
  assert(s.update(false) == nil)
  assert(s.update(true) == 'Support report saved: ' .. short)
  assert(s.update(true) == nil, 'announced once')
`));

test('a building service gets longer to finish; a silent one gets a short Lua report; a failed one does too', () => run(`
  put('runtime/knowledge-status.json', {version = 1, updated = ms()})
  local s = newSupport()
  s.request()
  local id = json.decode(files['runtime/report-request.json']).id
  advance(3); s.update(true)
  assert(s.status().phase == 'working')
  put('runtime/report-result.json', {version = 1, id = id, state = 'building'})
  advance(1); s.update(true)
  advance(15); put('runtime/knowledge-status.json', {version = 1, updated = ms()}); s.update(true)
  assert(s.status().phase == 'working', 'still building after 19 seconds')
  advance(15); s.update(true)
  assert(s.status().phase == 'ready' and s.status().mode == 'lua' and s.status().reason == 'no-response', 'gives up after 30 seconds')
  assert(s.banner():find('did not answer', 1, true))
  assert(files[reportsWritten()[1]]:find('the conversation service did not answer the request', 1, true))

  -- The supervisor says the service is up (fresh and ready) but no heartbeat file has appeared yet: ask it, wait the short time,
  -- show progress meanwhile, then fall back.
  files = {}
  put('runtime/bridge-service.json', {state = 'ready', updated = ms(), since = ms(-30)})
  local quiet = newSupport()
  assert(quiet.serviceState() == 'unknown' and quiet.serviceReach() == 'live')
  local started, startedMessage = quiet.request()
  assert(started and startedMessage == 'Creating the report…' and quiet.banner() == 'Creating the report…')
  assert(files['runtime/report-request.json'] and quiet.status().phase == 'working')
  advance(5); put('runtime/bridge-service.json', {state = 'ready', updated = ms(), since = ms(-30)})
  quiet.update(true); assert(quiet.status().phase == 'working')
  advance(2); quiet.update(true)
  assert(quiet.status().phase == 'ready' and quiet.status().reason == 'no-response')

  -- The service answers "failed".
  put('runtime/knowledge-status.json', {version = 1, updated = ms()})
  local failing = newSupport()
  failing.request()
  local failedId = json.decode(files['runtime/report-request.json']).id
  advance(1); put('runtime/report-result.json', {version = 1, id = failedId, state = 'failed', code = 'write-failed'})
  failing.update(true)
  assert(failing.status().mode == 'lua' and failing.status().reason == 'failed' and failing.banner():find('could not build the full report', 1, true))
  assert(files[reportsWritten()[#reportsWritten()]]:find('could not build the full report', 1, true))
`));

test('service stopped: a short report is written at once, says why, and no request is sent', () => run(`
  put('runtime/bridge-service.json', {state = 'stopped', updated = ms(), since = ms(-5)})
  put('runtime/convai-report-lua.txt', '')
  put('runtime/probe.log', '2026-10-05T10:00:00Z Game adapter initialized\\n')
  put('runtime/mcm.log', '2026-10-05T10:00:01Z Companion Manager registered\\n')
  put('AiNpcCyberpunkMod.log', "[2026-10-05 10:00:00] Type 'MovePolicies' not found.\\n")
  put('runtime/settings.json', {version = 2, voiceProvider = 'omni', enabledByKey = {['bob-sagan'] = true, ['judy-alvarez'] = false}})
  put('runtime/local-voice-state.json', {state = 'error', provider = 'omni', updated = ms(-60)})
  local s = newSupport({party = function() return {{profileKey = 'bob-sagan', name = 'Bob Sagan', state = 'following'}} end})
  assert(s.serviceState() == 'stopped')
  local ok, message = s.request()
  assert(ok and message:find('Short report saved because the conversation service is not running', 1, true))
  assert(not files['runtime/report-request.json'])
  local status = s.status()
  assert(status.phase == 'ready' and status.mode == 'lua' and status.reason == 'service-stopped')
  local name = status.fileName
  assert(name == 'convai-report-lua.txt', 'one fixed name, no time stamp')
  local text = files['runtime/' .. name]
  assert(text and text ~= '', 'the shipped empty file was filled in place')
  assert(status.path:find('runtime\\\\' .. name, 1, true) and status.path:find('the game folder', 1, true))
  assert(#removed == 0 and #written == 1 and written[1] == 'runtime/convai-report-lua.txt', 'one in-place write, nothing removed or renamed')
  for _, expected in ipairs({'short report', 'the conversation service was not running', '== versions ==', '== service status ==',
    '== settings ==', '== party ==', 'bob-sagan  state=following  name=Bob Sagan', 'conversationDisabled', 'judy-alvarez',
    '== log: runtime/probe.log ==', 'Game adapter initialized', '== log: runtime/mcm.log ==', 'Companion Manager registered',
    '== log: AiNpcCyberpunkMod.log ==', "MovePolicies' not found", 'Not included: CET, redscript, RED4ext'}) do
    assert(text:find(expected, 1, true), 'missing: ' .. expected)
  end
`));

test('the Lua report never reads credential, audio or conversation files and removes planted secrets, IDs and the Windows name', () => run(`
  put('runtime/bridge-service.json', {state = 'failed', code = 'bridge-crashed', updated = ms(), since = ms(-5)})
  put('runtime/convai-key.txt', 'api-key=${PLANTED.shortKey}')
  put('runtime/huggingface-token.txt', '${PLANTED.hfToken}')
  put('runtime/last-input.json', '{"text":"${PLANTED.chat}"}')
  put('runtime/phone-chat-output.json', '{"reply":"${PLANTED.chat}"}')
  put('runtime/microphone-capture.wav', '${PLANTED.chat}')
  put('runtime/chat-history.log', '${PLANTED.chat}')
  put('runtime/probe.log', table.concat({
    'Using key ${PLANTED.hexKey} for the first request',
    'Authorization: Bearer ${PLANTED.hexKey}',
    'request failed: api-key=${PLANTED.shortKey}',
    'character ${PLANTED.characterId} session ${PLANTED.sessionId} user ${PLANTED.userId}',
    'path C:\\\\Users\\\\${PLANTED.windowsUser}\\\\Desktop\\\\Code Palace\\\\mod'}, '\\n') .. '\\n')
  put('AiNpcCyberpunkMod.log', 'token=${PLANTED.base64}\\n')
  put('runtime/settings.json', {version = 2, apiKey = '${PLANTED.shortKey}', convaiUserId = '${PLANTED.userId}',
    endUserId = '${PLANTED.userId}', note = 'uses ${PLANTED.shortKey} and ${PLANTED.hfToken}', voiceProvider = 'pocket',
    enabledByKey = {x = true}})
  put('runtime/bridge-status.json', {state = 'ready', detail = '${PLANTED.userId}', sessionId = '${PLANTED.sessionId}'})
  put('runtime/party-connection-state.json', {profiles = {'bob'}, connections = {{profile = 'bob', sessionId = '${PLANTED.sessionId}'}}})
  local s = newSupport({party = function() return {{profileKey = 'bob', name = 'Bob', state = 'following',
    error = 'rejected ${PLANTED.shortKey}'}} end})
  assert(s.request())
  local text = files[reportsWritten()[1]]
  for _, planted in ipairs({'${PLANTED.hexKey}', '${PLANTED.shortKey}', '${PLANTED.hfToken}', '${PLANTED.userId}',
    '${PLANTED.characterId}', '${PLANTED.sessionId}', '${PLANTED.windowsUser}', '${PLANTED.base64}', '${PLANTED.chat}'}) do
    assert(not text:find(planted, 1, true), 'planted value leaked: ' .. planted)
  end
  assert(text:find('[redacted]', 1, true) and text:find('<user>', 1, true))
  assert(text:find('== log: runtime/probe.log ==', 1, true))
  assert(not text:find('chat%-history'), 'a log whose name suggests conversation content is not read')
  for _, path in ipairs(readLog) do check(path) end
`));

test('the short report is one fixed file in runtime/, rewritten in place: no new name, no rename, no removal, no pruning', () => run(`
  put('runtime/bridge-service.json', {state = 'stopped', updated = ms(), since = ms(-5)})
  put('runtime/support-paths.json', {version = 1, runtime = 'E:\\\\Game\\\\mod\\\\runtime', reports = 'C:\\\\Users\\\\V\\\\AppData\\\\Local\\\\AiNpcCyberpunkMod\\\\reports', logs = {}})
  put('runtime/convai-report-lua.txt', '')
  -- Reports of earlier versions and the zip folder are not the module's to touch.
  for index = 1, 7 do put('runtime/reports/convai-report-2026100' .. index .. '-100000.zip', 'old') end
  put('runtime/reports/convai-report-20261005-110000-lua.txt', 'old')
  put('runtime/convai-report-20260101-000000-lua.txt', 'old stray')
  put('runtime/reports/notes.txt', 'keep me')
  local before = 0
  for _ in pairs(files) do before = before + 1 end
  local s = newSupport()
  for _ = 1, 3 do
    assert(s.request())
    assert(s.status().fileName == 'convai-report-lua.txt')
    assert(s.status().path == 'E:\\\\Game\\\\mod\\\\runtime\\\\convai-report-lua.txt', s.status().path)
  end
  assert(#written == 3, 'three requests, three writes')
  for _, path in ipairs(written) do assert(path == 'runtime/convai-report-lua.txt', 'only the fixed file is written: ' .. path) end
  assert(#removed == 0, 'nothing is removed, not even an old report')
  local after = 0
  for _ in pairs(files) do after = after + 1 end
  assert(after == before, 'no file appears under any other name')
  assert(files['runtime/reports/convai-report-20261001-100000.zip'] and files['runtime/convai-report-20260101-000000-lua.txt']
    and files['runtime/reports/notes.txt'] == 'keep me', 'older files are left alone')
  assert(files['runtime/convai-report-lua.txt']:find('short report', 1, true))
  -- Written without the shipped placeholder it is simply created (a development folder); a folder that cannot be written fails.
  files['runtime/convai-report-lua.txt'] = nil
  assert(s.request() and files['runtime/convai-report-lua.txt'])
  blocked['runtime/'] = true
  local failed, why = s.request()
  assert(not failed and s.status().phase == 'failed' and why:find('could not be created', 1, true))
  assert(#removed == 0)
`));

test('empty exchange files read as missing: no result, no published paths, no request to answer', () => run(`
  put('runtime/knowledge-status.json', {version = 1, updated = ms()})
  put('runtime/report-request.json', '')
  put('runtime/report-result.json', '')
  put('runtime/support-paths.json', '')
  put('runtime/clipboard-request.json', '')
  local s = newSupport()
  local none = s.locations()
  assert(none.known == false and none.reports == '%LOCALAPPDATA%\\\\AiNpcCyberpunkMod\\\\reports', 'an empty support-paths.json is no published location')
  assert(s.request())
  advance(1); s.update(true)
  assert(s.status().phase == 'working', 'an empty report-result.json is no answer yet')
  assert(files['runtime/report-request.json'] ~= '' and json.decode(files['runtime/report-request.json']).version == 1, 'the request overwrote the empty file')
  advance(10); s.update(true)
  assert(s.status().phase == 'ready' and s.status().reason == 'no-response', 'no answer: the short report')
  assert(#removed == 0)
  -- Copy path writes over the empty placeholder, in place.
  local ok = s.copyPath()
  assert(ok and json.decode(files['runtime/clipboard-request.json']).text == s.status().path)
  assert(#removed == 0)
`));

test('log locations: exact paths from the service, derived paths from the launcher status, and honest placeholders otherwise', () => run(`
  local none = newSupport().locations()
  assert(none.known == false and none.launcher:find('the game folder\\\\red4ext\\\\plugins\\\\AiNpcCyberpunkMod\\\\launcher.log', 1, true))
  assert(not none.launcher:find('CyberpunkConvaiLauncher', 1, true))
  assert(none.mod:find('the game folder\\\\bin\\\\x64\\\\plugins\\\\cyber_engine_tweaks\\\\mods\\\\AiNpcCyberpunkMod\\\\runtime', 1, true))
  assert(none.redscript:find('r6\\\\logs\\\\redscript_rCURRENT.log', 1, true) and none.red4ext:find('red4ext\\\\logs', 1, true))
  -- The data and the reports now live outside the game folder; before the service says where, the page names the usual place.
  assert(none.bridge == '%LOCALAPPDATA%\\\\AiNpcCyberpunkMod\\\\data', none.bridge)
  assert(none.reports == '%LOCALAPPDATA%\\\\AiNpcCyberpunkMod\\\\reports', none.reports)
  put('runtime/bridge-service.json', {state = 'failed', updated = ms(), gameRoot = 'D:\\\\Games\\\\Cyberpunk 2077', stateDirectory = 'D:\\\\Mod\\\\runtime'})
  local derived = newSupport().locations()
  assert(derived.known and derived.bridge == 'D:\\\\Mod\\\\runtime')
  assert(derived.launcher == 'D:\\\\Games\\\\Cyberpunk 2077\\\\red4ext\\\\plugins\\\\AiNpcCyberpunkMod\\\\launcher.log')
  assert(derived.cet == 'D:\\\\Games\\\\Cyberpunk 2077\\\\bin\\\\x64\\\\plugins\\\\cyber_engine_tweaks')
  assert(derived.reports == '%LOCALAPPDATA%\\\\AiNpcCyberpunkMod\\\\reports')
  put('runtime/support-paths.json', {version = 1, gameRoot = 'E:\\\\G', runtime = 'E:\\\\G\\\\mod\\\\runtime', reports = 'C:\\\\Users\\\\V\\\\AppData\\\\Local\\\\AiNpcCyberpunkMod\\\\reports',
    stateDirectory = 'E:\\\\P\\\\runtime', logs = {probe = {path = 'E:\\\\G\\\\mod\\\\runtime\\\\probe.log'},
      ['bridge-stderr'] = {path = 'E:\\\\P\\\\runtime\\\\logs\\\\bridge.stderr.log'}, red4ext = {path = 'E:\\\\G\\\\red4ext\\\\logs\\\\red4ext-1.log'}}})
  local exact = newSupport().locations()
  assert(exact.mod == 'E:\\\\G\\\\mod\\\\runtime' and exact.bridge == 'E:\\\\P\\\\runtime\\\\logs' and exact.red4ext == 'E:\\\\G\\\\red4ext\\\\logs')
  assert(exact.reports == 'C:\\\\Users\\\\V\\\\AppData\\\\Local\\\\AiNpcCyberpunkMod\\\\reports', 'the service says the reports are outside the game folder')
`));

test('Copy path needs a report, asks the service and tries the game clipboard from the update, and never raises', () => run(`
  put('runtime/bridge-service.json', {state = 'stopped', updated = ms(), since = ms(-5)})
  local s = newSupport()
  local ok, message = s.copyPath()
  assert(not ok and message == 'Create a report first.' and not files['runtime/clipboard-request.json'])
  assert(s.request())
  assert(s.canCopy())
  -- No service to copy it: the request file is not written, and the message and the row's help show the whole path instead.
  assert(s.serviceReach() == 'stopped')
  ok, message = s.copyPath()
  assert(ok and not files['runtime/clipboard-request.json'], 'nothing is queued for a service that is not running')
  assert(message:find('needs the conversation service, which is not running', 1, true) and message:find(support.fullPath(s.status().path), 1, true), message)
  assert(s.copyUnavailableText() == message)
  -- The service comes up: the ordinary copy.
  advance(1); put('runtime/knowledge-status.json', {version = 1, updated = ms()})
  assert(s.serviceReach() == 'live' and s.copyUnavailableText() == nil)
  ok, message = s.copyPath()
  assert(ok and message == 'Report path copied to the clipboard.')
  local requested = json.decode(files['runtime/clipboard-request.json'])
  assert(requested.version == 1 and requested.text == s.status().path and requested.issuedAt == clock * 1000)
  local copied
  ImGui = {SetClipboardText = function(text) copied = text end}
  ok = s.copyPath(); assert(ok and copied == nil, 'no ImGui call inside the menu callback')
  s.update(true)
  assert(copied == s.status().path)
  copied = nil; s.update(true); assert(copied == nil, 'copied once')
  ImGui = {SetClipboardText = function() error('no ImGui context') end}
  ok = s.copyPath(); assert(ok); s.update(true)
  -- Neither route: the request file cannot be written and the game has no clipboard.
  ImGui = nil
  local realOpen = io.open
  io.open = function(path, mode) if path == 'runtime/clipboard-request.json' then return nil end return realOpen(path, mode) end
  ok, message = s.copyPath()
  assert(not ok and message:find('clipboard is not available', 1, true))
  io.open = realOpen
`));

test('empty status files, as the install ships them, read as no status in the locations and the service state', () => run(`
  for _, name in ipairs({'bridge-service', 'bridge-status', 'knowledge-status', 'local-voice-state', 'party-connection-state', 'support-paths'}) do
    put('runtime/' .. name .. '.json', '')
  end
  local support = newSupport()
  local where = support.locations()
  assert(where.known == false, 'an empty bridge-service.json or support-paths.json is not a source of paths')
  assert(convaiServiceStatus.unavailable() == nil and convaiServiceStatus.notice() == nil)
  assert(type(support.serviceState()) == 'string')
`));

test('a service that failed with browser-missing is named in the Help row, its help and the first lines of the short report', () => run(`
  put('runtime/bridge-service.json', {state = 'failed', code = 'browser-missing', updated = ms(), since = ms(-5)})
  reportsFolder = false
  local s = newSupport()
  assert(s.serviceState() == 'stopped', 'other callers still see a service that is not running')
  assert(s.serviceFault() == 'browser')
  assert(s.serviceLabel() == 'Needs a browser', s.serviceLabel())
  assert(s.serviceMessage():find('Chromium browser such as Microsoft Edge, Google Chrome, Brave or Opera', 1, true), s.serviceMessage())
  local ok = s.request()
  assert(ok and s.status().mode == 'lua')
  local text = files['runtime/' .. s.status().fileName]
  local lines = {}
  for line in (text .. '\\n'):gmatch('(.-)\\n') do lines[#lines + 1] = line end
  assert(lines[2]:find('PROBLEM: no browser for the conversation page', 1, true) and lines[2]:find('browser-missing', 1, true), lines[2])
  assert(text:find('Chromium browser such as Microsoft Edge, Google Chrome, Brave or Opera', 1, true))
  -- Any other failure keeps the ordinary wording and no problem line.
  put('runtime/bridge-service.json', {state = 'failed', code = 'bridge-crashed', updated = ms(), since = ms(-5)})
  advance(2)
  local other = newSupport()
  assert(other.serviceFault() == 'failed' and other.serviceLabel() == 'Not running' and other.serviceMessage():find('could not start', 1, true))
  other.request()
  assert(not files['runtime/' .. other.status().fileName]:find('PROBLEM', 1, true))
`));

// The service's process was started by the launcher and never reported (a Runtime that is a Mod Organizer 2 mod, in the report that led to
// this), or the start script said why it stopped: the first lines of the short report say so, with the status's own words.
test('a service that was started and never came up, or that stopped in its start, heads the short report with the status words and where its log is', () => run(`
  put('runtime/bridge-service.json', {version = 1, state = 'starting', code = 'launcher-started', source = 'launcher', error = 0, supervisorPid = 12584,
      since = ms(-5), updated = ms(-5)})
  advance(100)
  reportsFolder = false
  local s = newSupport()
  assert(s.serviceFault() == 'failed')
  assert(s.startProblem() == 'service-silent after launcher-started')
  assert(s.serviceMessage():find('(service-silent after launcher-started)', 1, true), s.serviceMessage())
  local ok = s.request()
  assert(ok and s.status().mode == 'lua')
  local text = files['runtime/' .. s.status().fileName]
  local lines = {}
  for line in (text .. '\\n'):gmatch('(.-)\\n') do lines[#lines + 1] = line end
  assert(lines[2]:find('PROBLEM: the conversation service did not come up (service-silent after launcher-started)', 1, true), lines[2])
  assert(lines[2]:find('bridge-service.log', 1, true) and lines[2]:find('"View:"', 1, true) and lines[2]:find('launcher.log', 1, true), lines[2])
  assert(text:find('source: launcher', 1, true) and text:find('code: launcher-started', 1, true), 'the status file is in the report as it is')
  -- A failure the start script reports carries its stage and reason into the report, both in the line and in the status section.
  put('runtime/bridge-service.json', {version = 1, state = 'failed', code = 'install-incomplete', source = 'service', stage = 'loading-modules',
      reason = "ERR_MODULE_NOT_FOUND: Cannot find module 'place-packs.mjs' imported from start-service.mjs", updated = ms(), since = ms()})
  advance(2)
  local other = newSupport()
  assert(other.startProblem():find("install-incomplete at loading-modules: ERR_MODULE_NOT_FOUND: Cannot find module 'place-packs.mjs'", 1, true))
  other.request()
  local second = files['runtime/' .. other.status().fileName]
  assert(second:find('PROBLEM: the conversation service did not come up (install-incomplete at loading-modules', 1, true))
  assert(second:find('reason: ERR_MODULE_NOT_FOUND', 1, true) and second:find('stage: loading-modules', 1, true))
  -- A bridge that crashed later is not a start problem: it has its own logs and keeps the ordinary report.
  put('runtime/bridge-service.json', {state = 'failed', code = 'bridge-crashed', updated = ms(), since = ms(-5)})
  advance(2)
  local crashed = newSupport()
  assert(crashed.startProblem() == nil)
`));

test('no service answering (never started, empty, unreadable or stale status): the short report at once, no request, no wait', () => run(`
  local function report(case)
    advance(1) -- the status module reads each file once a second: every case starts a new second
    local s = newSupport()
    local ok, message = s.request()
    assert(ok and message:find('Short report saved because the conversation service is not running', 1, true), case .. ': ' .. tostring(message))
    assert(not files['runtime/report-request.json'], case .. ': no request is sent when nothing answers')
    assert(s.status().phase == 'ready' and s.status().mode == 'lua', case .. ': ready at once, no waiting phase')
    assert(#removed == 0)
    local text = files['runtime/' .. s.status().fileName]
    local lines = {}
    for line in (text .. '\\n'):gmatch('(.-)\\n') do lines[#lines + 1] = line end
    return s, text, lines
  end
  local function neverStarted(case, s, text, lines)
    assert(s.status().reason == 'service-never-started', case .. ': ' .. tostring(s.status().reason))
    assert(s.serviceReach() == 'never', case)
    assert(lines[2]:find('PROBLEM: the conversation service never started', 1, true), case .. ': ' .. lines[2])
    for _, cause in ipairs({'red4ext\\\\plugins\\\\AiNpcCyberpunkMod\\\\', 'red4ext\\\\logs', 'antivirus', 'Chromium browser such as Microsoft Edge'}) do
      assert(lines[2]:find(cause, 1, true), case .. ': line 2 lacks ' .. cause)
    end
    assert(text:find('Why it is short: the conversation service never started in this game session', 1, true), case)
  end

  -- 1. No status file at all (the Runtime did not load).
  local s, text, lines = report('missing')
  assert(s.serviceState() == 'unknown', 'other callers keep their own answer for no evidence')
  neverStarted('missing', s, text, lines)
  assert(lines[1]:find('short report', 1, true) and not text:find('PROBLEM: no browser', 1, true))

  -- 2. The status file as the install ships it: empty.
  files = {}; put('runtime/bridge-service.json', '')
  s, text, lines = report('empty'); neverStarted('empty', s, text, lines)

  -- 3. Present but unreadable (not JSON, or a read that fails).
  files = {}; put('runtime/bridge-service.json', '{not json')
  s, text, lines = report('garbled'); neverStarted('garbled', s, text, lines)
  files = {}; put('runtime/bridge-service.json', {state = 'ready', updated = ms(), since = ms(-30)})
  local realOpen = io.open
  io.open = function(path, mode) if path == 'runtime/bridge-service.json' then error('sharing violation') end return realOpen(path, mode) end
  s, text, lines = report('unreadable'); neverStarted('unreadable', s, text, lines)
  io.open = realOpen

  -- 4. Left over from an earlier game session (an hour old, and this session started after it): nothing started this time.
  files = {}; put('runtime/bridge-service.json', {state = 'ready', updated = ms(-3600), since = ms(-7200)})
  put('runtime/knowledge-status.json', {version = 1, updated = ms(-3600)})
  s, text, lines = report('earlier session'); neverStarted('earlier session', s, text, lines)

  -- 5. The service ran in this session and went quiet: stale, but not "never started". Short report at once, no problem line.
  for _, trace in ipairs({
    {'runtime/bridge-service.json', {state = 'ready', updated = ms(-60), since = ms(-90)}},
    {'runtime/knowledge-status.json', {version = 1, updated = ms(-25)}},
    {'runtime/bridge-service.json', {state = 'failed', code = 'bridge-crashed', updated = ms(-60), since = ms(-60)}}}) do
    files = {}; put(trace[1], trace[2])
    s, text, lines = report(trace[1])
    assert(s.serviceReach() == 'stopped' and s.status().reason == 'service-stopped', trace[1])
    assert(not text:find('PROBLEM', 1, true) and text:find('Why it is short: the conversation service was not running', 1, true))
  end
`));

test('only a service that is up gets a request and a wait: a fresh heartbeat, or a fresh ready, starting or restarting status', () => run(`
  for _, case in ipairs({
    {'runtime/knowledge-status.json', {version = 1, updated = ms()}},
    {'runtime/local-voice-state.json', {state = 'ready', updated = ms(-5)}},
    {'runtime/bridge-service.json', {state = 'ready', updated = ms(), since = ms(-30)}},
    {'runtime/bridge-service.json', {state = 'starting', updated = ms(-3), since = ms(-3)}},
    {'runtime/bridge-service.json', {state = 'restarting', updated = ms(-3), since = ms(-3)}}}) do
    files, written = {}, {}
    put(case[1], case[2])
    local s = newSupport()
    assert(s.serviceReach() == 'live', case[1])
    local ok, message = s.request()
    assert(ok and message == 'Creating the report…' and s.status().phase == 'working')
    assert(files['runtime/report-request.json'] and #reportsWritten() == 0, 'asked the service, nothing written in Lua')
    advance(1)
  end
  -- A fresh status that is stopped, stopping or failed is not a service to wait for.
  for _, state in ipairs({'stopped', 'stopping', 'failed'}) do
    files = {}; put('runtime/bridge-service.json', {state = state, updated = ms(), since = ms(-2)})
    local s = newSupport()
    assert(s.serviceReach() == 'stopped', state)
    assert(s.request() and s.status().phase == 'ready' and not files['runtime/report-request.json'], state)
    advance(1)
  end
  -- A status module that cannot say is the same as no trace; a fresh heartbeat is still read directly.
  files = {}
  local s = newSupport()
  local realStatus = convaiServiceStatus
  convaiServiceStatus = {version = 1}
  assert(s.serviceReach() == 'never')
  advance(1); put('runtime/knowledge-status.json', {version = 1, updated = ms()})
  assert(s.serviceReach() == 'live')
  convaiServiceStatus = realStatus
`));

test('the whole path is broken after a folder separator, never mid-name, with the file name alone on the last line', () => run(`
  local path = 'the game folder\\\\bin\\\\x64\\\\plugins\\\\cyber_engine_tweaks\\\\mods\\\\AiNpcCyberpunkMod\\\\runtime\\\\convai-report-lua.txt'
  local text = support.fullPath(path)
  local lines = {}
  for line in (text .. '\\n'):gmatch('(.-)\\n') do lines[#lines + 1] = line end
  assert(#lines >= 3 and lines[#lines] == 'convai-report-lua.txt', text)
  for index = 1, #lines - 1 do
    assert(#lines[index] <= 44 and lines[index]:sub(-1) == '\\\\', index .. ': ' .. lines[index])
  end
  assert(text:gsub('\\n', '') == path, 'nothing is lost or added but the breaks')
  assert(support.fullPath('E:\\\\a\\\\b.txt') == 'E:\\\\a\\\\\\nb.txt', support.fullPath('E:\\\\a\\\\b.txt'))
  assert(support.fullPath('b.txt') == 'b.txt' and support.fullPath(nil) == '')
  -- A folder name longer than a line stays whole on a line of its own.
  local long = 'C:\\\\Users\\\\V\\\\AppData\\\\Local\\\\AiNpcCyberpunkMod\\\\' .. string.rep('x', 60) .. '\\\\convai-report-lua.txt'
  local out = support.fullPath(long)
  assert(out:find(string.rep('x', 60) .. '\\\\', 1, true) and out:gsub('\\n', '') == long)
`));
