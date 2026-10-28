// Shared harness for the startup and settings tests of the Lua side (settings-file-lua, status-files-lua, init-startup-lua).
//
// Two things the older Lua tests fake are real here, because the startup bugs live in them:
//   * json: a host JSON codec (JSON.parse and JSON.stringify behind json.decode and json.encode) that fails on an empty string, a
//     cut-short file, a byte order mark or trailing text like the codec CET gives the mod, and writes an empty table as [].
//     Tests put raw file text on the fake disk and the real manager.lua decodes it.
//   * the disk: io and os over a table of paths. os.rename never replaces an existing file (Windows), and every write, rename and
//     remove is one numbered step that a test can fail or crash, so the temp file and backup protection can be tried at each step.
// A test builds its Lua from these pieces, runs it, and reads values back with report(name, value) instead of asserting only in Lua.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;

export const modSource = name => readFileSync(new URL(`../mod/${name}`, import.meta.url), 'utf8');

function pushValue(L, value, depth = 0) {
  if (depth > 64) throw new Error('too deep');
  if (value === null || value === undefined) lua.lua_pushnil(L);
  else if (typeof value === 'boolean') lua.lua_pushboolean(L, value);
  else if (typeof value === 'number') {
    // fengari integers are 32 bit: only a small whole number is one, everything else (a millisecond clock) stays a float.
    if (Number.isInteger(value) && Math.abs(value) < 2 ** 31) lua.lua_pushinteger(L, value);
    else lua.lua_pushnumber(L, value);
  } else if (typeof value === 'string') lua.lua_pushstring(L, to_luastring(value));
  else if (Array.isArray(value)) {
    lua.lua_createtable(L, value.length, 0);
    value.forEach((item, index) => { pushValue(L, item, depth + 1); lua.lua_rawseti(L, -2, index + 1); });
  } else {
    lua.lua_createtable(L, 0, 0);
    for (const [key, item] of Object.entries(value)) {
      pushValue(L, item, depth + 1);
      lua.lua_setfield(L, -2, to_luastring(key));
    }
  }
}

function readValue(L, index, depth = 0) {
  if (depth > 64) throw new Error('table too deep or circular');
  index = lua.lua_absindex(L, index);
  switch (lua.lua_type(L, index)) {
    case lua.LUA_TNIL: return null;
    case lua.LUA_TBOOLEAN: return lua.lua_toboolean(L, index);
    case lua.LUA_TNUMBER: {
      const number = lua.lua_tonumber(L, index);
      if (!Number.isFinite(number)) throw new Error(`unexpected number value '${number}'`);
      return number;
    }
    case lua.LUA_TSTRING: return to_jsstring(lua.lua_tostring(L, index));
    case lua.LUA_TTABLE: {
      const entries = [];
      lua.lua_pushnil(L);
      while (lua.lua_next(L, index) !== 0) {
        const keyType = lua.lua_type(L, -2);
        let key;
        if (keyType === lua.LUA_TSTRING) key = to_jsstring(lua.lua_tostring(L, -2));
        else if (keyType === lua.LUA_TNUMBER) key = lua.lua_tonumber(L, -2);
        else throw new Error('invalid table: mixed or invalid key types');
        entries.push([key, readValue(L, -1, depth + 1)]);
        lua.lua_pop(L, 1);
      }
      if (entries.every(([key]) => typeof key === 'number')) {
        entries.sort((a, b) => a[0] - b[0]);
        if (entries.every(([key], position) => key === position + 1)) return entries.map(([, item]) => item);
      }
      if (entries.some(([key]) => typeof key === 'number')) throw new Error('invalid table: mixed or invalid key types');
      entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return Object.fromEntries(entries);
    }
    default: throw new Error(`unexpected type '${lua.lua_typename(L, lua.lua_type(L, index))}'`);
  }
}

function installHost(L, reports) {
  lua.lua_newtable(L);
  lua.lua_pushcfunction(L, state => {
    const text = lauxlib.luaL_checklstring(state, 1);
    let value;
    try { value = JSON.parse(to_jsstring(text)); } catch (error) { return lauxlib.luaL_error(state, to_luastring(`json decode: ${error.message}`)); }
    pushValue(state, value);
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring('decode'));
  lua.lua_pushcfunction(L, state => {
    let text;
    try { text = JSON.stringify(readValue(state, 1)); } catch (error) { return lauxlib.luaL_error(state, to_luastring(error.message)); }
    lua.lua_pushstring(state, to_luastring(text));
    return 1;
  });
  lua.lua_setfield(L, -2, to_luastring('encode'));
  lua.lua_setglobal(L, to_luastring('json'));
  lua.lua_pushcfunction(L, state => {
    const name = to_jsstring(lauxlib.luaL_checklstring(state, 1));
    reports[name] = readValue(state, 2);
    return 0;
  });
  lua.lua_setglobal(L, to_luastring('report'));
}

// Runs Lua text in a new state with the host json and report() installed. The CET module environment has no _G: neither does this,
// so code that reaches for it fails here. Returns what the code reported.
export function run(code, {locale = true} = {}) {
  const L = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(L);
  const reports = {};
  installHost(L, reports);
  const source = (locale ? '_G = nil; ' + uiLocaleBootstrap : '_G = nil; ') + code;
  const status = lauxlib.luaL_dostring(L, to_luastring(source));
  let error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(L, -1));
  const failedLine = /^\[string [^\]]*\]:(\d+):/.exec(error);
  if (failedLine) error += '\n>> ' + source.split('\n')[Number(failedLine[1]) - 1].trim().slice(0, 300);
  lua.lua_close(L);
  assert.equal(status, lua.LUA_OK, error);
  return reports;
}

// The fake disk. `files` maps a path to its text; a path that is absent does not exist. Every change goes through step():
//   ops      the log of changes, in order ('open-w runtime/settings.json.tmp', 'rename a>b', 'remove p', 'write p')
//   failOn   function(kind, path) -> true makes that one change fail the way the OS would (open returns nil, rename returns nil)
//   crashAt  the number of the change at which the whole save is cut off: the change is not made (a write is torn in half) and
//            the call raises, like a game that is closed or loses power there
export const diskLua = `
  local files, ops, failOn, crashAt, opCount = {}, {}, nil, nil, 0
  local function step(kind, path, partial)
    opCount = opCount + 1
    ops[#ops + 1] = kind .. ' ' .. path
    if crashAt and opCount == crashAt then
      if partial then partial() end
      error('crash at step ' .. opCount .. ' (' .. kind .. ' ' .. path .. ')', 0)
    end
    if failOn and failOn(kind, path) then return false end
    return true
  end
  local readCounts = {}
  local function resetOps() ops, opCount, readCounts = {}, 0, {} end
  local function writes(path)
    local count = 0
    for _, op in ipairs(ops) do if op == 'open-w ' .. path then count = count + 1 end end
    return count
  end
  io = {open = function(path, mode)
    if mode == 'rb' or mode == 'r' then
      readCounts[path] = (readCounts[path] or 0) + 1
      if files[path] == nil then return nil end
      local text = files[path]
      return {read = function(_, count)
        if type(count) == 'number' then
          if text == '' then return nil end
          return text:sub(1, count)
        end
        return text
      end, close = function() return true end}
    end
    local appending = mode == 'a'
    if not step('open-w', path) then return nil end
    if not appending then files[path] = '' else files[path] = files[path] or '' end
    return {write = function(_, ...)
      local pieces = {...}
      for index, value in ipairs(pieces) do pieces[index] = tostring(value) end
      local text = table.concat(pieces)
      if not step('write', path, function() files[path] = files[path] .. text:sub(1, math.floor(#text / 2)) end) then return nil end
      files[path] = files[path] .. text
      return true
    end, close = function() return true end}
  end}
  -- Windows: renaming onto an existing file fails, which is why the settings save moves the old file aside first.
  os.rename = function(from, to)
    if not step('rename', from .. '>' .. to) then return nil end
    if files[from] == nil or files[to] ~= nil then return nil end
    files[to], files[from] = files[from], nil
    return true
  end
  os.remove = function(path)
    if not step('remove', path) then return nil end
    if files[path] == nil then return nil end
    files[path] = nil
    return true
  end
  local clock = 1000000
  os.time = function() return math.floor(clock) end
  os.clock = function() return clock end
  local function advance(seconds) clock = clock + seconds end
`;

const managerSource = modSource('manager.lua');

// The real manager.lua over the fake disk, one companion API and the roster below. newManager() is a fresh Lua module state, which is
// what a game start or a CET reload gives it (the files stay).
export const managerLua = `
  ${diskLua}
  -- The six profiles the legacy enabled list stands for (mod/manager.lua legacyKeys), and Johnny.
  local roster = {{key = 'viktor-vektor', name = 'Viktor Vektor', records = {'Character.Victor_Vector'}},
    {key = 'misty-olszewski', name = 'Misty Olszewski', records = {'Character.Misty'}},
    {key = 'judy-alvarez', name = 'Judy Alvarez', records = {'Character.Judy'}},
    {key = 'panam-palmer', name = 'Panam Palmer', records = {'Character.Panam'}},
    {key = 'resident-male', name = 'Resident (male)', records = {'Character.ResidentMale'}},
    {key = 'resident-female', name = 'Resident (female)', records = {'Character.ResidentFemale'}},
    {key = 'johnny-silverhand', name = 'Johnny Silverhand', records = {'Character.Silverhand'}}}
  local companionApi = {}
  local definitions, members = {}, {}
  function companionApi.definition(key) return definitions[key] end
  function companionApi.registerDefinition(key, value) definitions[key] = value; return true end
  function companionApi.list() return members end
  function companionApi.spawn() return 1 end
  function companionApi.dismiss() return false end
  function companionApi.setProfile() return false end
  GetLocalizedText = function(text) return text end
  local function newPlayer()
    local player = {hash = 'player-1', open = false, queue = {}, voice = true, subtitles = true}
    function player:GetEntityID() return {hash = self.hash} end
    function player:ConvaiManagerIsOpen() return self.open end
    function player:ConvaiManagerTakeRequest() return table.remove(self.queue, 1) or '' end
    function player:ConvaiManagerClearRows() end
    function player:ConvaiManagerAddRow() end
    function player:ConvaiManagerSetDetail() end
    function player:ConvaiManagerSetPage() end
    function player:ConvaiManagerSetTab() end
    function player:ConvaiManagerSetSearch() end
    function player:ConvaiManagerSetFeedback() end
    function player:ConvaiManagerSetPartyStatus() end
    function player:ConvaiManagerRefresh() end
    function player:ConvaiManagerSetVoice(value) self.voice = value end
    function player:ConvaiManagerVoice() return self.voice end
    function player:ConvaiManagerSetSubtitles(value) self.subtitles = value end
    function player:ConvaiManagerSubtitles() return self.subtitles end
    function player:ConvaiManagerSetEnabled() end
    return player
  end
  local function newManager(profiles)
    local manager = (function() ${managerSource} end)()
    manager.configure(companionApi, profiles or roster)
    return manager
  end
  local function settingsText() return files['runtime/settings.json'] end
  local function settingsTable() return json.decode(files['runtime/settings.json']) end
`;

// Every key a first start writes, with the value it gets when nothing is saved (mod/manager.lua loadSettings). The roster above gives
// the seven enabledByKey entries. The legacy six-place "enabled" projection is written with them.
export const freshSettings = {
  version: 2, uiLanguage: 'auto', voice: true, subtitles: true, errorReports: true, subtitleStyle: 'dialogue', audioDelay: 'auto', replyLanguage: 'en', voiceVolume: 100,
  relationshipModes: {'judy-alvarez': 'auto', 'panam-palmer': 'auto', 'river-ward': 'auto', 'kerry-eurodyne': 'auto', 'meredith-stout': 'auto'},
  dynamicInfo: {location: true, time: true, company: true, condition: true, money: true, gear: true, about: true, quest: true, dialogue: true, lastTalk: true, media: true, mods: false},
  immersive: {enabled: false, arrival: 'walk', delay: 0, wait: 5, waypoint: true, texts: true},
  housemates: {enabled: false, chat: true, chatCooldown: 120, chatSize: 2, moveIn: 'ask'},
  developerMode: false, useOwnConvaiKey: false, conversationProvider: 'convai',
  battleReactionsChosen: false, battleReactions: true, lootReactionsChosen: false, lootReactions: true, decisionLedger: true, witnessReceipts: true, defaultsRevision: 1,
  eyeContactHeight: 0, headFollowStrength: 1, voiceProvider: 'pocket', omniSteps: 16, omniReference: 'long', keepPreparedVoices: true,
  archetypeConversations: true, storyConversations: false, johnnyInHead: false, johnnyRemarks: 'off', companionSpeakUp: 'normal', speakUpOftenGiven: true,
  reputation: false, npcThreats: false, revengeAmbushes: false, voiceActivation: false, voiceChoices: false, remoteOmni: false, amdMiopen: true,
  // A first start gives the five actions that have a default key their key, once (keyDefaultsGiven); the two Johnny actions have none.
  keyBindings: {manager: 'IK_F4', text: 'IK_F6', voice: 'IK_F7', group_text: 'IK_F8', group_voice: 'IK_F10'}, keyDefaultsGiven: true, companionOutfits: false, characterEddies: false,
  naturalSpeech: false, followUpInterest: true,
  matureContent: false, localModel: 'auto',
  vVoiceChosen: false, vVoice: true, vVoiceEngine: 'pocket', vVoiceMic: false, vVoiceMicOwn: true,
  enabledByKey: {'viktor-vektor': true, 'misty-olszewski': true, 'judy-alvarez': true, 'panam-palmer': true, 'resident-male': true,
    'resident-female': true, 'johnny-silverhand': true},
  enabled: [true, true, true, true, true, true],
};
