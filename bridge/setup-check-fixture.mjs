// The fake game shared by the setup-check tests (setup-check-lua.test.mjs, reds-requirements.test.mjs).
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import assert from 'node:assert/strict';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';


// mod/setup-check.lua over a fake game: the frameworks CET can see, a fake mod folder (files, directory listing, clock) and the real
// service-status.lua. Counts every file opened and every game call, so the "nothing runs per frame" promise is a test, not a comment.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
export const source = readFileSync(new URL('../mod/setup-check.lua', import.meta.url), 'utf8');
export const serviceSource = readFileSync(new URL('../mod/service-status.lua', import.meta.url), 'utf8');
export const supportSource = readFileSync(new URL('../mod/support-report.lua', import.meta.url), 'utf8');
export const catalog = JSON.parse(readFileSync(new URL('../localization/en.json', import.meta.url), 'utf8')).strings;

export function run(body) {
  const state = lauxlib.luaL_newstate(); lualib.luaL_openlibs(state);
  try {
    const program = uiLocaleBootstrap + fixture + body;
    const result = lauxlib.luaL_dostring(state, to_luastring(program));
    const error = result === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
    const line = Number(/\]:(\d+):/.exec(error)?.[1]);
    assert.equal(result, lua.LUA_OK, error + (line ? `\n${program.split('\n')[line - 1]}` : ''));
  } finally { lua.lua_close(state); }
}

export const fixture = String.raw`
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
  native = false, nsui = 'ok', mcm = 'none', player = true, paused = false, menu = false}
gameCalls, requirementCalls = 0, 0
function applyEnv()
  GetVersion = env.cet and function() return env.cet end or nil
  Codeware = env.codeware and {Version = function() return env.codeware end} or nil
  TweakXL = env.tweakxl and {Version = function() return env.tweakxl end} or nil
  convaiNative = env.native and {present = true} or nil
  GetMod = function(name)
    assert(name == 'nativeSettings' or name == 'NativeSettings' or name == 'ModConfigurationMenuAPI')
    local function noop() end
    -- Mod Configuration Menu: 'ok' is 0.10.5 with its public UI extension, 'old' is 0.10.3 (no api.ui), 'none' is not installed.
    if name == 'ModConfigurationMenuAPI' then
      if env.mcm == 'ok' then return {version = '0.10.5', apiVersion = 2, providers = {registerProvider = noop}, ui = {apiVersion = 1}} end
      if env.mcm == 'old' then return {version = '0.10.3', apiVersion = 2, providers = {registerProvider = noop}} end
      return nil
    end
    if env.nsui == 'ok' and name == 'nativeSettings' then
      return {version = 1.96, data = {}, addTab = noop, addSubcategory = noop, removeSubcategory = noop, removeOption = noop, addSwitch = noop,
        addRangeInt = noop, addSelectorString = noop, addButton = noop, setOption = noop, registerRestoreDefaultsCallback = noop}
    end
    -- An old copy has the tab and the options but not what a page that changes in place needs.
    if env.nsui == 'old' and name == 'nativeSettings' then return {version = 1.2, data = {}, addTab = noop, addSwitch = noop} end
    return nil
  end
  local real = {
    GetPlayer = function()
      if not env.player then return nil end
      -- env.requirements: nil is a scripts of 0.2.1 and older (no ConvaiRequirements); a string is what the new scripts answer
      return {ConvaiPhoneIsOpen = env.scripts == true and function() return false end or nil,
        ConvaiRequirements = env.scripts == true and (env.requirements ~= nil or env.requirementsError) and function()
          requirementCalls = requirementCalls + 1
          if env.requirementsError then error('ConvaiRequirements failed') end
          return env.requirements
        end or nil}
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
-- the service's answer: one document of eight checks, any of them replaced by the test
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
    {id = 'compiler', state = 'ok', code = 'found'},
  }
  for _, item in ipairs(defaults) do
    local replaced = checks and checks[item.id]
    document.checks[#document.checks + 1] = replaced or item
  end
  put('runtime/setup-check.json', document)
  return document
end
`;
