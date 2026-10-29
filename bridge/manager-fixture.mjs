// Shared Lua test fixtures of the Companion Manager: the real manager.lua over a fake game and settings storage (managerFixture), and
// the real host (mod/nsui.lua, mod/manager-ui.lua, mod/nsui-entry.lua) over a fake Native Settings UI (nsuiFixture).
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';
import {nativeSettingsFake} from './nsui-fake.mjs';
import {mcmFake} from './mcm-fake.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
export const source = name => readFileSync(new URL('../mod/' + name, import.meta.url), 'utf8');
const managerSource = source('manager.lua');
export const queueSource = source('manager-party.lua');
export const coreSource = source('manager-ui.lua');
export const hostSource = source('nsui.lua');
export const entrySource = source('nsui-entry.lua');
export const mcmHostSource = source('mcm-host.lua');
export const voicePreviewSource = source('voice-preview.lua');
export const keyBindingsSource = source('key-bindings.lua');
export const fontsSource = source('ui-fonts.lua');
export const favoritesSource = source('favorites.lua');
export const savedPartiesSource = source('saved-parties.lua');

export function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  // The CET module environment has no _G: match it so that class of bug fails here.
  const source = '_G = nil; ' + uiLocaleBootstrap + code;
  const status = lauxlib.luaL_dostring(state, to_luastring('convaiPlayer = function() return Game.GetPlayer() end ' + source));
  // An error that is not a string (a table raised by the code under test) is described instead of breaking the report.
  let error = status === lua.LUA_OK ? '' : (lua.lua_type(state, -1) === lua.LUA_TSTRING ? to_jsstring(lua.lua_tostring(state, -1)) : to_jsstring(lauxlib.luaL_tolstring(state, -1)));
  // Name the failing Lua line: the message only carries its number in the generated chunk.
  const failedLine = /^\[string [^\]]*\]:(\d+):/.exec(error);
  if (failedLine) error += '\n>> ' + source.split('\n')[Number(failedLine[1]) - 1].trim().slice(0, 300);
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

export const storage = `
  local files, saved, seed, extras = {}, nil, {}, nil
  local jsonFixtures, jsonSequence, fileWrites = {}, 0, {}
  local failSave = false
  io = {open = function(path, mode)
    if mode == 'rb' then
      if not files[path] then return nil end
      return {read = function() return files[path] end, close = function() return true end}
    end
    if failSave then return nil end
    return {write = function(_, ...)
      local value = table.concat({...})
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

export const managerFixture = `
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

// The host over a fake Native Settings UI. The Lua names: ns (the fake, bridge/nsui-fake.mjs), managerUi (the host), core (the page
// logic, manager-ui.lua), and for tests that read the page as sections of rows: loaded (the page last built), row(id), invoke(id).
// `registered` keeps the old harness names (loadMod, invokeAction, applyBatch) over the same functions, so a test reads like it
// always did: invokeAction runs a button, applyBatch applies a batch of changes as the host does.
//   modules   {path: Lua source}: more modules the page loads with dofile (the Help page's support report, the setup check ...)
//   absent    [path]: modules whose dofile raises, as a missing file does
//   nsui      false: Native Settings UI is not installed (GetMod finds nothing); the host is installed and finds none
//   locale    a language code: its dictionary (mod/locales/<code>.lua) is available to the locale module, so the page can be
//             built in that language (convaiUiLocale.configure(code) then picks it)
//   mcm       an object {version, noUi, renderer} installs the fake Mod Configuration Menu (bridge/mcm-fake.mjs) as `mcm`, answering
//             GetMod('ModConfigurationMenuAPI'); null (the default) leaves it out. The MCM host (mod/mcm-host.lua) is attached either way.
//   hideMcm   true: GetMod does not answer for MCM until the test sets mcmHidden = false (MCM loads after this mod)
//   earlyClock true: os.clock reads 1000 from the start, so the host's waits (set at install) run on the test's own clock
//   screen    false: the Mods screen is not opened; true (the default) opens it on the manager's tab, as the old harness had the
//             page shown: it is then kept up to date and read once a second (a test that wants it closed calls ns.closeScreen())
export function nsuiHarness({modules = {}, absent = [], nsui = true, screen = true, locale = null, mcm = null, hideMcm = false, earlyClock = false} = {}) {
  const luaOptions = value => '{' + Object.entries(value ?? {}).map(([key, item]) => `${key} = ${typeof item === 'string' ? JSON.stringify(item) : item}`).join(', ') + '}';
  const lines = [];
  if (locale) lines.push(`    if path == 'locales/${locale}.lua' then return (function() ${readFileSync(new URL(`../mod/locales/${locale}.lua`, import.meta.url), 'utf8')} end)() end`);
  for (const [path, body] of Object.entries(modules)) lines.push(`    if path == '${path}' then return (function() ${body} end)() end`);
  for (const path of absent) lines.push(`    if path == '${path}' then error('module absent') end`);
  return `
  ${managerFixture}
  local originalDofile = dofile
  dofile = function(path)
    if path == 'voice-preview.lua' then return (function() ${voicePreviewSource} end)() end
    if path == 'ui-fonts.lua' then return (function() ${fontsSource} end)() end
    if path == 'favorites.lua' and not ${absent.includes('favorites.lua')} then return (function() ${favoritesSource} end)() end
    if path == 'saved-parties.lua' and not ${absent.includes('saved-parties.lua')} then return (function() ${savedPartiesSource} end)() end
    if path == 'manager-ui.lua' then return (function() ${coreSource} end)() end
    if path == 'nsui-entry.lua' then return (function() ${entrySource} end)() end
    if path == 'mcm-host.lua' then return (function() ${mcmHostSource} end)() end
${lines.join('\n')}
    return originalDofile(path)
  end
  manager.configure(api, profiles)
  ${earlyClock ? "os.clock = function() return 1000 end" : ""}
  ${nativeSettingsFake}
  ${mcm ? mcmFake + `
  local mcm = newMcm(${luaOptions(mcm)})` : 'local mcm = nil'}
  local nsGetMod = GetMod
  local mcmHidden = ${hideMcm}
  GetMod = function(name)
    if name == 'ModConfigurationMenuAPI' then if mcmHidden then return nil end return mcm and mcm.api or nil end
    if ${nsui} then return nsGetMod(name) end
    return nil
  end
  Game = {GetPlayer = function() return player end}
  local managerUi = (function() ${hostSource} end)()
  managerUi.configure(manager, api, (function() ${queueSource} end)())
  local mcmHost = dofile('mcm-host.lua')
  managerUi.attach(mcmHost)
  managerUi.install()
  local core = managerUi._test.core
  -- The own key bindings (init.lua convaiKeyBindsModule): the real module over the fake player, with the actions it would run recorded in keyRuns.
  local keyRuns, keyFile = {}, nil
  function convaiKeyBindsModule()
    if convaiKeyBinds then return convaiKeyBinds end
    convaiKeyBinds = (function() ${keyBindingsSource} end)()
    convaiKeyBinds.deps = {
      bindings = function() return manager.keyBindings() end,
      save = function(action, name) return manager.setKeyBinding(player, action, name) end,
      voice = function(action, down) keyRuns[#keyRuns + 1] = action .. (down and ':down' or ':up') end,
      tap = function(action) keyRuns[#keyRuns + 1] = action end,
      observe = function() end,
      readFile = function(path) return keyFile end,
      changed = function(result) core.keyBindResult(result) end,
      player = function() return player end,
      log = function() end,
    }
    return convaiKeyBinds
  end
  local TAB = 'aiNpcCyberpunkMod'
  if ${nsui && screen} then ns.openScreen(TAB) end
  local loaded = core.model()
  local function row(id)
    for _, category in ipairs(loaded.categories) do
      for _, setting in ipairs(category.settings) do if setting.id == id then return setting end end
    end
  end
  local registered = {id = 'cyberpunk-convai'}
  function registered.loadMod() loaded = core.model(); return loaded end
  function registered.invokeAction(_, actionId)
    local result = core.invoke(actionId)
    return {ok = result.ok, error = result.error, schemaChanged = result.ok}
  end
  function registered.applyBatch(_, changes)
    local result = core.apply(changes)
    return {ok = result.ok, error = result.error, atomic = true, partial = false, appliedIds = result.ids,
      schemaChanged = result.ok and (result.notice ~= nil or result.reload == true)}
  end
  local function invoke(id)
    local result = registered.invokeAction('manager', id)
    if result.ok and result.schemaChanged then loaded = registered.loadMod('manager') end
    return result
  end
`;
}

export const nsuiFixture = nsuiHarness();
