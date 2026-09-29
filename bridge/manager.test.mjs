import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import fengari from 'fengari';
import {companionModules, flatNavigation} from './companion-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const managerSource = readFileSync(new URL('../mod/manager.lua', import.meta.url), 'utf8');
const companionsSource = readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8');
const queueSource = readFileSync(new URL('../mod/manager-party.lua', import.meta.url), 'utf8');
const mcmSource = readFileSync(new URL('../mod/mcm.lua', import.meta.url), 'utf8');
const entrySource = readFileSync(new URL('../mod/mcm-entry.lua', import.meta.url), 'utf8');

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

const storage = `
  local files, saved, seed, extras = {}, nil, {}, nil
  local failSave = false
  io = {open = function(path, mode)
    if mode == 'rb' then
      if not files[path] then return nil end
      return {read = function() return files[path] end, close = function() return true end}
    end
    if failSave then return nil end
    return {write = function(_, value) files[path] = value; return true end, close = function() return true end}
  end}
  json = {decode = function(value)
    if value == 'seed' then return seed end
    if value == 'extras' then return extras end
    if value == 'saved' then return saved end
    error('unexpected JSON fixture')
  end, encode = function(value) saved = value; return 'saved' end}
  os.rename = function(from, to)
    if not files[from] or files[to] then return nil end
    files[to], files[from] = files[from], nil
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
    if #members >= 8 then return nil, 'Your party has eight copies. Dismiss one first.' end
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

test('MCM party invitations reserve distinct copies, cancel without spawning and flush only once', () => {
  run(`${managerFixture}
    manager.configure(api, profiles)
    local queue = (function() ${queueSource} end)().new(api)
    assert(queue.invite('johnny-silverhand') == false)
    queue.bind('player-1')
    for _ = 1, 8 do assert(queue.invite('johnny-silverhand')) end
    assert(#spawned == 0 and queue.count() == 8 and #queue.list() == 8)
    assert(queue.invite('person-1') == false)
    local first, second = queue.list()[1].id, queue.list()[2].id
    assert(first ~= second and queue.list()[1].state == 'queued')
    assert(queue.dismiss(first) and queue.count() == 7 and #spawned == 0)
    assert(queue.assign(second, 'person-1', 'Person 01'))
    queue.flush()
    assert(#spawned == 7 and #members == 7 and members[1].profileKey == 'person-1')
    queue.flush(); assert(#spawned == 7, 'menu operation replayed')
    queue.bind(nil); queue.bind('player-2'); queue.flush()
    assert(#spawned == 7)
  `);
});

test('MCM dismissals free planned places, cannot undo into an overfull party and cleanly report world failures', () => {
  run(`${managerFixture}
    manager.configure(api, profiles)
    local queue = (function() ${queueSource} end)().new(api)
    queue.bind('player-1')
    for _ = 1, 8 do api.spawn('johnny-silverhand') end
    local id = queue.list()[1].id
    assert(queue.dismiss(id) and #members == 8 and queue.count() == 7)
    assert(queue.invite('person-1') and queue.count() == 8)
    assert(queue.undoDismiss(id) == false)
    assert(queue.list()[1].state == 'leaving')
    queue.flush()
    assert(#members == 8 and members[8].key == 'person-1')
    assert(queue.dismiss('live:123456') == false)
    queue.dismiss(queue.list()[1].id)
    local oldDismiss = api.dismiss
    api.dismiss = function() return false, 'World unavailable' end
    queue.invite('person-2')
    queue.flush()
    assert(#members == 8 and #spawned == 9)
    assert(queue.list()[9].state == 'failed' and queue.message():find('eight copies', 1, true))
    queue.flush(); assert(#spawned == 9, 'failed request must not retry every frame')
    api.dismiss = oldDismiss
    queue.bind(nil); assert(#queue.list() == 8, 'loading a save cancels pending work')
  `);
});

test('MCM settings apply as one saved transaction and leave playback unchanged on a save failure', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.snapshot(player)
    assert(not manager.disappearingMessages())
    assert(manager.subtitleStyle() == 'dialogue' and saved.subtitleStyle == 'dialogue')
    assert(manager.snapshot(player).settings.voiceProvider == 'hybrid')
    assert(manager.battleReactions() and manager.snapshot(player).settings.battleReactions)
    assert(manager.lootReactions() and manager.snapshot(player).settings.lootReactions)
    assert(manager.applySettings(player, {lootReactions = false}))
    assert(not manager.lootReactions() and saved.lootReactions == false)
    assert(manager.applySettings(player, {lootReactions = 'on'}) == false)
    assert(manager.applySettings(player, {battleReactions = false}))
    assert(not manager.battleReactions() and saved.battleReactions == false)
    assert(manager.applySettings(player, {battleReactions = 'on'}) == false)
    assert(manager.applySettings(player, {voice = false, subtitleStyle = 'overhead', omniSteps = 16, voiceProvider = 'convai', disappearingMessages = true, enabledByKey = {['johnny-silverhand'] = false}}))
    assert(player.voice == false and saved.omniSteps == 16 and not manager.profileEnabled('johnny-silverhand'))
    assert(saved.disappearingMessages and manager.disappearingMessages())
    failSave = true
    assert(manager.applySettings(player, {voice = true, subtitles = false, subtitleStyle = 'dialogue', omniSteps = 32, voiceProvider = 'hybrid', disappearingMessages = false}) == false)
    local values = manager.snapshot(player).settings
    assert(values.voice == false and values.subtitles == true and values.omniSteps == 16)
    assert(player.voice == false and player.subtitles == true)
    assert(values.disappearingMessages and manager.disappearingMessages())
    assert(values.voiceProvider == 'convai')
    assert(values.subtitleStyle == 'overhead' and manager.subtitleStyle() == 'overhead')
    failSave = false
    assert(manager.applySettings(player, {voice = true, omniSteps = 8}) == false)
    assert(manager.applySettings(player, {enabledByKey = {unknown = true}}) == false)
    assert(manager.applySettings(player, {disappearingMessages = 'yes'}) == false)
    assert(manager.applySettings(player, {voiceProvider = 'unknown'}) == false)
    assert(manager.applySettings(nil, {voice = true}))
    manager.reset(); manager.snapshot(player); assert(player.voice == true)
    assert(manager.subtitleStyle() == 'overhead', 'failed save or reset replaced explicit subtitle choice')
  `);
});

test('subtitle style defaults to dialogue and preserves explicit overhead, Convai voices and other saved fields', () => {
  run(`${managerFixture}
    for _, oldStyle in ipairs({'missing', 'invalid', false, 1}) do
      seed = {version = 2, voice = false, subtitles = false, voiceProvider = 'convai',
        omniSteps = 16, battleReactions = false, lootReactions = false,
        disappearingMessages = true, enabledByKey = {}, future = {keep = 'unchanged'}}
      if oldStyle ~= 'missing' then seed.subtitleStyle = oldStyle end
      for _, profile in ipairs(profiles) do seed.enabledByKey[profile.key] = true end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles)
      assert(manager.subtitleStyle() == 'dialogue')
      local state = manager.snapshot(player).settings
      assert(state.subtitleStyle == 'dialogue' and saved.subtitleStyle == 'dialogue')
      assert(not state.subtitles and not player.subtitles, 'migration enabled the master switch')
      assert(state.voiceProvider == 'convai' and saved.voiceProvider == 'convai')
      assert(not state.voice and state.omniSteps == 16 and state.disappearingMessages)
      assert(not state.battleReactions and not state.lootReactions)
      assert(saved.future.keep == 'unchanged')
      assert(manager.applySettings(player, {subtitleStyle = 'overhead'}))
      manager.reset()
      state = manager.snapshot(player).settings
      assert(manager.subtitleStyle() == 'overhead' and state.subtitleStyle == 'overhead')
      assert(not state.subtitles and state.voiceProvider == 'convai' and saved.future.keep == 'unchanged')
      assert(manager.applySettings(player, {subtitleStyle = 'dialogue'}))
      assert(manager.subtitleStyle() == 'dialogue' and not player.subtitles)
    end
  `);
});

test('subtitle style accepts only exact public values and rejects the whole settings transaction', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.snapshot(player)
    assert(manager.applySettings(player, {subtitleStyle = 'dialogue', voiceProvider = 'convai', subtitles = false}))
    for _, invalid in ipairs({'Above speaker', 'hud', 'Dialogue', 'overhead ', '', 1, false, {}}) do
      local before = saved
      assert(manager.applySettings(player, {subtitleStyle = invalid, voiceProvider = 'hybrid', subtitles = true}) == false)
      local state = manager.snapshot(player).settings
      assert(state.subtitleStyle == 'dialogue' and manager.subtitleStyle() == 'dialogue')
      assert(state.voiceProvider == 'convai' and not state.subtitles and not player.subtitles)
      assert(saved == before, 'rejected transaction wrote settings')
    end
  `);
});

test('MCM waits for NPC attachment, reports late failures once and discards notices on save change', () => {
  run(`${managerFixture}
    manager.configure(api, profiles)
    local queue = (function() ${queueSource} end)().new(api)
    queue.bind('player-1')
    queue.invite('johnny-silverhand'); queue.flush()
    assert(#queue.takeNotices() == 0, 'accepting CreateEntity is not a completed spawn')
    members[1].state = 'ready'; queue.flush()
    local notices = queue.takeNotices()
    assert(#notices == 1 and notices[1].message:find('joined your group', 1, true))
    queue.flush(); assert(#queue.takeNotices() == 0, 'confirmation repeated every frame')
    queue.invite('person-1'); queue.flush()
    members[2].state, members[2].error = 'failed', 'No walkable position'
    queue.flush(); notices = queue.takeNotices()
    assert(#notices == 1 and notices[1].failed and notices[1].message:find('No walkable position', 1, true))
    queue.flush(); assert(#queue.takeNotices() == 0)
    queue.invite('person-2'); queue.flush(); members[3].state = 'ready'
    queue.bind(nil); queue.bind('player-1'); queue.flush()
    assert(#queue.takeNotices() == 0, 'old session completion leaked into new save')
  `);
});

const mcmFixture = `
  ${managerFixture}
  manager.configure(api, profiles)
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
  local controller = {McmUiEmitSearch = function(_, context, value) handlers.McmUiEmitSearch(nil, context, value) end}
  local function invoke(id)
    local result = registered.invokeAction('manager', id, {interaction = {controller = controller}})
    if result.ok and result.schemaChanged then loaded = registered.loadMod('manager') end
    return result
  end
`;

test('MCM schema uses native controls, operates on current copies while paused, and preserves setting drafts', () => {
  run(`${mcmFixture}
    assert(registered.apiVersion == 2 and registered.listMods().mods[1].name == 'Companion Manager')
    assert(row('invite:johnny-silverhand').type == 'action')
    assert(invoke('invite:johnny-silverhand').ok)
    mcm.update(player, false)
    assert(#spawned == 0 and #mcm.inspect().party == 1)
    assert(invoke('tab:party').ok)
    assert(row('dismiss:queued:1').value == 'Cancel invitation')
    assert(invoke('assign:queued:1').ok and invoke('assign-profile:person-1').ok)
    assert(invoke('tab:settings').ok)
    assert(row('voice').type == 'bool' and row('omniSteps').type == 'select')
    assert(row('subtitles').type == 'bool' and row('subtitles').value == true)
    assert(row('subtitleStyle').type == 'select' and row('subtitleStyle').value == 2)
    assert(row('subtitleStyle').defaultValue == 2 and row('subtitleStyle').capabilities.draft)
    assert(row('subtitleStyle').elements[1] == 'Above speaker' and row('subtitleStyle').elements[2] == 'Dialogue HUD')
    assert(row('voiceProvider').type == 'select' and row('voiceProvider').value == 1)
    assert(row('disappearingMessages').type == 'bool' and row('disappearingMessages').value == false)
    assert(row('battleReactions').type == 'bool' and row('battleReactions').value == true)
    assert(row('lootReactions').type == 'bool' and row('lootReactions').value == true)
    assert(registered.applyBatch('manager', {{id = 'lootReactions', value = false}}).ok)
    assert(not manager.lootReactions())
    assert(registered.applyBatch('manager', {{id = 'battleReactions', value = false}}).ok)
    assert(not manager.battleReactions())
    local applied = registered.applyBatch('manager', {{id = 'voice', value = false}, {id = 'omniSteps', value = 1}, {id = 'disappearingMessages', value = true}, {id = 'voiceProvider', value = 2}, {id = 'subtitleStyle', value = 1}})
    assert(applied.ok and applied.atomic and #applied.appliedIds == 5 and saved.omniSteps == 16)
    assert(saved.voiceProvider == 'convai')
    loaded = registered.loadMod('manager')
    assert(manager.subtitleStyle() == 'overhead' and row('subtitleStyle').value == 1)
    for _, invalid in ipairs({0, 3, '1', 'overhead', false}) do
      assert(not registered.applyBatch('manager', {{id = 'subtitles', value = false}, {id = 'subtitleStyle', value = invalid}}).ok)
      assert(manager.subtitleStyle() == 'overhead' and player.subtitles)
    end
    assert(registered.applyBatch('manager', {{id = 'subtitleStyle', value = 2}}).ok)
    assert(manager.subtitleStyle() == 'dialogue' and saved.voiceProvider == 'convai')
    assert(not registered.applyBatch('manager', {{id = 'voiceProvider', value = 3}}).ok)
    assert(manager.disappearingMessages())
    assert(player.voice == false)
    drafts = true
    local before = reloads
    mcm.update(player, false); assert(reloads == before, 'external refresh must not erase MCM drafts')
    drafts = false
    mcm.update(player, true)
    assert(#spawned == 1 and members[1].profileKey == 'person-1')
    assert(invoke('tab:party').ok and row('dismiss:live:1'))
    mcm.shutdown(); assert(registered == nil)
  `);
});

test('MCM model search covers the full installed catalogue while exposing bounded result rows', () => {
  run(`${mcmFixture}
    assert(scans == 0)
    assert(invoke('tab:models').ok)
    for _ = 1, 126 do mcm.update(player, false) end
    assert(scans == 1 and visits == 6000)
    loaded = registered.loadMod('manager')
    local function countInvites()
      local count = 0
      for _, category in ipairs(loaded.categories) do
        for _, item in ipairs(category.settings) do
          if item.id:sub(1,7) == 'invite:' then count = count + 1 end
        end
      end
      return count
    end
    assert(countInvites() == 18 and row('models:next'))
    handlers.McmUiEmitSearch(nil, 'content', 'Model_6000')
    for _ = 1, 6 do mcm.update(player, false) end
    assert(countInvites() == 1 and row('invite:model:6000'))
    assert(invoke('invite:model:6000').ok and #spawned == 0)
    mcm.update(player, true); assert(members[1].key == 'model:6000')
    assert(members[1].profileKey == nil)
    assert(invoke('tab:party').ok and mcm.inspect().view == 'party')
  `);
});

test('native MCM action banner describes the queued invitation and leaves other pages and errors alone', () => {
  run(`${mcmFixture}
    assert(invoke('invite:johnny-silverhand').ok)
    local rendered
    local function paint(label, status)
      handlers.McmUiBegin({}, 'MCM', '', 'Mods', label, status, 1, '', true, true, 0,
        function(title, subtitle, sidebar, content, message) rendered = message end)
      return rendered
    end
    assert(paint('Companion Manager', 'Completed: Johnny Silverhand'):find('return to the game', 1, true))
    assert(paint('Other Mod', 'Completed: Johnny Silverhand') == 'Completed: Johnny Silverhand')
    assert(paint('Companion Manager', 'Action failed') == 'Action failed')
    invoke('tab:settings')
    assert(paint('Companion Manager', 'Completed: Settings') == 'Completed: Settings')
  `);
});

test('F5 goes through the real Mods entry and selects only its own native sidebar action', () => {
  run(`
    local callbacks, stageEvents, activated, selected, closed = {}, {}, 0, nil, 0
    Observe = function(_, method, callback) callbacks[method] = callback end
    ObserveAfter = Observe
    local inMenu = false
    local player = {IsAttached = function() return true end, ConvaiComposerOpen = function() return false end,
      GetEntityID = function() return {} end}
    local boards = {Get = function() return {GetBool = function() return inMenu end,
      SetName = function(_, field, name) stageEvents[#stageEvents + 1] = name end} end,
      GetLocalInstanced = function() return {GetInt = function() return 0 end} end}
    local attachedControllers = {}
    Game = {GetPlayer = function() return player end,
      GetSystemRequestsHandler = function() return {IsPreGame = function() return false end} end,
      GetInkSystem = function() return {GetLayers = function() return {{GetGameControllers = function() return attachedControllers end}} end} end,
      GetBlackboardSystem = function() return boards end,
      GetAllBlackboardDefs = function() return {UI_System = {}, MenuEventBlackboard = {}, PlayerStateMachine = {}} end}
    NameToString = function(value) return value end
    local mcmEvent = {}
    CName = {new = function(name) assert(name == 'OnSwitchToMCM'); return mcmEvent end}
    local entry = (function() ${entrySource} end)().new('Companion Manager', function() return true end, function() end)
    entry.install()
    assert(entry.open() and stageEvents[1] == 'OnOpenPauseMenu')
    assert(entry.open() and #stageEvents == 1)
    local pause = {menuListController = {Size = function() return 1 end,
      GetItemAt = function() return {GetController = function() return {GetData = function() return {eventName = mcmEvent, label = 'Mods'} end} end} end},
      OnMenuItemActivated = function() activated = activated + 1 end}
    -- The initialization observer may fire before the list exists. Keep the
    -- opening request alive and resolve the real attached controller later.
    callbacks.OnInitialize({})
    callbacks.PopulateMenuItemList({})
    entry.update(); assert(activated == 0 and entry.state() == 'pause')
    pause.IsA = function(_, name) return name == 'PauseMenuGameController' end
    attachedControllers = {pause}
    entry.update(); assert(activated == 1 and entry.state() == 'select')
    local settings = {McmUiEmitAction = function(_, id) selected = id end, McmUiIsActive = function() return true end,
      RequestClose = function() closed = closed + 1 end}
    callbacks.OnInitialize(settings)
    callbacks.McmUiAddSidebarItem(settings, 'other', '', 'Other Mod', '', false)
    entry.update(); assert(selected == nil)
    callbacks.McmUiAddSidebarItem(settings, 'manager-id', '', 'Companion Manager', '', false)
    entry.update(); assert(selected == 'manager-id')
    entry.selected(); assert(entry.state() == 'idle')
    assert(entry.open() and closed == 1)
    callbacks.OnUninitialize(); inMenu = true; attachedControllers = {}
    assert(entry.open() == false and #stageEvents == 1)
    attachedControllers = {pause}
    assert(entry.open())
    entry.update(); assert(activated == 2 and #stageEvents == 1, 'opening from Pause must not request a second pause host')
  `);
});

// Optional local integration gate: execute the actual installed API modules,
// without writing their data directory or copying third-party code into Git.
test('installed MCM API accepts the provider, actions, draft transactions and dynamic model schema',
  {skip: !process.env.CYBERPUNK_MCM_API}, () => {
    const root = process.env.CYBERPUNK_MCM_API;
    const preloads = readdirSync(path.join(root, 'modules'), {recursive: true})
      .filter(file => file.endsWith('.lua'))
      .map(file => {
        const key = `modules/${file.replaceAll('\\', '/').slice(0, -4)}`;
        return `package.preload[${JSON.stringify(key)}] = function()\n${readFileSync(path.join(root, 'modules', file), 'utf8')}\nend`;
      }).join('\n');
    run(`${mcmFixture}
      mcm.shutdown()
      local encoded, jsonSequence = {}, 0
      json = {encode = function(value) jsonSequence = jsonSequence + 1; local id = 'json-' .. jsonSequence; encoded[id] = value; return id end,
        decode = function(value) return encoded[value] or saved or {} end}
      ${preloads}
      local core = require('modules/core')
      core.init()
      local actual = core.getApi()
      GetMod = function() return actual end
      mcm.install()
      assert(actual.refreshIndex())
      local key = 'cyberpunk-convai:manager'
      assert(actual.openMod(key))
      assert(actual.invokeAction(key .. ':invite:johnny-silverhand'))
      assert(#spawned == 0 and #mcm.inspect().party == 1)
      assert(actual.invokeAction(key .. ':tab:settings'))
      assert(actual.setDraft(key .. ':voice', false))
      assert(actual.setDraft(key .. ':omniSteps', 1))
      assert(actual.setDraft(key .. ':voiceProvider', 2))
      assert(actual.setDraft(key .. ':subtitleStyle', 1))
      assert(actual.setDraft(key .. ':battleReactions', false))
      assert(actual.invokeAction(key .. ':tab:characters') == false)
      local ok, err = actual.apply(key)
      assert(ok, err)
      assert(actual.getValue(key .. ':voice') == false and actual.getValue(key .. ':omniSteps') == 1)
      assert(manager.snapshot(player).settings.omniSteps == 16 and not actual.hasDrafts(key))
      assert(actual.getValue(key .. ':voiceProvider') == 2)
      assert(manager.snapshot(player).settings.voiceProvider == 'convai')
      assert(actual.getValue(key .. ':subtitleStyle') == 1 and manager.subtitleStyle() == 'overhead')
      assert(not manager.battleReactions() and actual.getValue(key .. ':battleReactions') == false)
      assert(actual.invokeAction(key .. ':tab:party'))
      assert(actual.invokeAction(key .. ':dismiss:queued:1'))
      assert(#mcm.inspect().party == 0 and #spawned == 0)
      assert(actual.invokeAction(key .. ':tab:models'))
      for _ = 1, 126 do mcm.update(player, false) end
      assert(actual.reloadMod(key))
      local count = 0
      for _, row in ipairs(actual.listSettings(key)) do if row.type == 'action' then count = count + 1 end end
      assert(count < 30)
      assert(actual.closeMod())
      mcm.shutdown(); core.shutdown()
    `);
  });

test('native manager pages profiles, searches case-insensitively, and persists key-based chat settings with legacy migration', () => {
  run(`${managerFixture}
    seed = {voice = false, subtitles = true, enabled = {false, true, true, true, true, true}, keep = 'preserved'}
    files['runtime/settings.json'] = 'seed'
    manager.configure(api, profiles)
    assert(manager.prepare(player))
    assert(#player.rows == 8 and player.page[3] == true)
    assert(player.voice == false and manager.profileEnabled('viktor-vektor') == false)
    request('page:next')
    assert(player.page[2] == true and #player.rows == 8)
    request('search:pErSoN 15')
    assert(#player.rows == 1 and player.rows[1].key == 'profile:person-15')
    assert(player.detail[3] == 'spawn:person-15')
    request('toggle-profile:person-15')
    assert(manager.profileEnabled('person-15') == false)
    assert(saved.enabledByKey['person-15'] == false and saved.enabledByKey['viktor-vektor'] == false)
    assert(saved.keep == 'preserved' and files['runtime/settings.json'] == 'saved')
    manager.reset(); manager.prepare(player)
    assert(manager.profileEnabled('person-15') == false and player.voice == false)
    request('tab:settings'); request('toggle:subtitles')
    assert(player.subtitles == false and saved.subtitles == false)
    player.voice = true; manager.update(player, 0.1)
    assert(saved.voice == true)
    failSave = true; request('toggle-profile:person-15')
    assert(manager.profileEnabled('person-15') == true)
    assert(player.feedback:find('could not be saved', 1, true))
  `);
});

test('all installed models are discovered lazily in bounded batches, and closing the view stops scanning', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(scans == 0 and visits == 0)
    request('tab:models')
    assert(scans == 1 and visits == 48 and #player.rows <= 8)
    assert(defs['model:1'].profileKey == 'johnny-silverhand')
    assert(defs['model:2'].profileKey == nil)
    player.open = false
    for _ = 1, 10 do manager.update(player, 0.1) end
    assert(visits == 48)
    player.open = true
    for _ = 1, 125 do manager.update(player, 0.1) end
    assert(scans == 1 and visits == 6000 and defs['model:6000'])
    request('search:Model_6000')
    assert(#player.rows == 1 and player.detail[3] == 'spawn:model:6000')
    request(player.detail[3])
    assert(#members == 1 and members[1].profileKey == nil)
    assert(player.feedback:find('Creating a copy', 1, true))
  `);
});

test('OmniVoice defaults to 32 steps, switches without a native reload, and preserves quality through a manager reset', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved.omniSteps == 32)
    request('tab:settings'); request('select:setting:omniSteps')
    assert(player.detail[3] == 'omni:32' and player.detail[5] == false)
    assert(player.detail[6] == 'omni:16' and player.detail[8] == true)
    request('omni:16')
    assert(saved.omniSteps == 16 and player.detail[5] == true and player.detail[8] == false)
    manager.reset(); manager.prepare(player)
    request('tab:settings'); request('select:setting:omniSteps')
    assert(player.detail[8] == false)
    request('omni:8'); assert(saved.omniSteps == 16)
    request('omni:32'); assert(saved.omniSteps == 32)
    assert(saved.voice == true and saved.subtitles == true)
  `);
});

test('party uses actual copy serials, assigns and clears profiles, reports asynchronous failures, and enforces eight copies', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    for _ = 1, 8 do request('spawn:person-1') end
    assert(#members == 8 and #spawned == 8)
    request('spawn:person-1')
    assert(#members == 8 and #spawned == 8 and player.feedback:find('eight copies', 1, true))
    request('tab:party')
    assert(#player.rows == 8 and player.detail[3] == 'dismiss:1')
    request('assign:1'); request('search:Johnny')
    assert(player.detail[3] == 'assign-profile:1:johnny-silverhand')
    request(player.detail[3])
    assert(members[1].profileKey == 'johnny-silverhand' and members[1].key == 'person-1')
    assert(player.tab == 'party' and player.search == '')
    request('assign:1')
    assert(player.detail[3] == 'assign-none:1')
    request(player.detail[3]); assert(members[1].profileKey == nil)
    members[2].state, members[2].error = 'failed', 'No compatible AI controller.'
    manager.update(player, 0.6)
    assert(player.feedback:find('No compatible AI controller.', 1, true))
    request('dismiss:2')
    assert(#members == 7 and members[2].serial == 3)
    request('spawn:person-1'); assert(#members == 8 and members[8].serial == 9)
    request('dismiss:9999'); assert(#members == 8)
    player.hash = 'player-2'; manager.update(player, 0.1)
    assert(player.tab == 'characters' and player.search == '')
  `);
});

const engineFixture = `
  ${storage}
  local entities, deleted, nextEntity, deletionsFail = {}, {}, 0, false
  local player = {}
  Vector4 = {new = function(x,y,z,w) return {x=x,y=y,z=z,w=w or 1} end}
  function player:GetWorldPosition() return Vector4.new(0,0,0,1) end
  function player:GetWorldForward() return Vector4.new(0,1,0,0) end
  function player:GetWorldOrientation() return {} end
  TweakDBID = {new = function(id) return id end}
  CName = {new = function(value) return value end}
  TweakDB = {GetRecord = function(_, id)
    if id == 'Missing' then return nil end
    return {IsA = function(_, kind) return kind == 'gamedataCharacter_Record' and id ~= 'NotCharacter' end}
  end}
  NewObject = function(kind) return {kind = kind, OnRoleCleared = function() end} end
  Enum = {new = function(_, value) return value end}
  local system = {}
  function system:IsReady() return true end
  function system:CreateEntity(spec)
    nextEntity = nextEntity + 1
    local id = {hash = tostring(nextEntity)}
    local ai = {role = {IsA = function(_, kind) return kind == 'AINoRole' end}}
    function ai:GetAIRole() return self.role end
    function ai:SetAIRole(role) self.role = role end
    function ai:OnAttach() end
    function ai:SendCommand(command) end
    function ai:GetCommandState(command) return 'Executing' end
    function ai:StopExecutingCommand(command) end
    function ai:CancelCommand(command) end
    local npc = {id = id, ai = ai, record = spec.recordID, pos = spec.position}
    function npc:GetEntityID() return self.id end
    function npc:IsAttached() return true end
    function npc:IsA(kind) return kind == 'NPCPuppet' and self.record ~= 'NotNPC' end
    function npc:IsCrowd() return self.record == 'Crowd' end
    function npc:GetAIControllerComponent() if self.record ~= 'NoAI' then return self.ai end end
    function npc:GetComponents() return {} end
    function npc:IsDeadNoStatPool() return false end
    function npc:GetWorldPosition() return self.pos end
    function npc:GetWorldForward() return Vector4.new(0,1,0,0) end
    function npc:GetBodyType() return 'ManAverage' end
    if spec.recordID == 'Authored' then ai.role = {IsA = function() return false end} end
    entities[id.hash] = npc
    return id
  end
  function system:IsSpawned(id) return true end
  function system:GetEntity(id) return entities[id.hash] end
  function system:DeleteEntity(id)
    if deletionsFail or not entities[id.hash] then return false end
    deleted[#deleted + 1] = id.hash; entities[id.hash] = nil; return true
  end
  Game = {GetPlayer = function() return player end, GetDynamicEntitySystem = function() return system end,
    GetTargetingSystem = function() return {GetCrosshairData = function() return nil, Vector4.new(0,1,0,0) end} end,
    CreateEntityReference = function() return {} end}
  NPCPuppet = {IsInCombat = function() return false end}
  ${companionModules}
  ${flatNavigation}
  local companions = (function() ${companionsSource} end)()
`;

test('owned raw models have no implicit conversation identity; assigning a profile changes routing without changing the model', () => {
  run(`${engineFixture}
    companions.registerDefinition('raw', {id = 'Character.Raw', name = 'Raw model'})
    local serial = assert(companions.spawn('raw'))
    assert(#companions.connectionProfiles() == 0)
    companions.update(player, 0.5)
    local npc = entities['1']
    local key, name, owned = companions.identity(npc)
    assert(key == nil and name == 'Raw model' and owned == true)
    assert(#companions.conversationCandidates(player, 12) == 0)
    assert(companions.setProfile(serial, 'johnny-silverhand', 'Johnny Silverhand'))
    assert(companions.identity(npc) == 'johnny-silverhand')
    assert(companions.connectionProfiles()[1] == 'johnny-silverhand')
    assert(companions.conversationCandidates(player, 12)[1].profileKey == 'johnny-silverhand')
    assert(companions.list()[1].key == 'raw' and npc.record == 'Character.Raw')
    companions.setProfile(serial, nil)
    assert(#companions.connectionProfiles() == 0 and companions.identity(npc) == nil)
    local world = {GetEntityID = function() return {hash = 'world-quest-actor'} end}
    assert(companions.identity(world) == nil and not companions.owns(world))
    assert(companions.dismiss(serial) and deleted[1] == '1')
  `);
});

test('invalid character/NPC/AI records fail cleanly and only owned entity IDs are removed', () => {
  run(`${engineFixture}
    for _, id in ipairs({'Missing', 'NotCharacter'}) do
      companions.registerDefinition(id, {id=id, name=id})
      local serial, reason = companions.spawn(id)
      assert(serial == nil and type(reason) == 'string')
    end
    for _, id in ipairs({'NotNPC', 'NoAI', 'Crowd', 'Authored'}) do
      companions.registerDefinition(id, {id=id, name=id})
      local serial = assert(companions.spawn(id))
      companions.update(player, 0.5)
      local entry = companions.list()[1]
      assert(entry.state == 'failed' and entry.error ~= nil)
      assert(entities[entry.entityID] == nil)
      companions.dismiss(serial)
    end
    assert(#companions.list() == 0 and nextEntity == 4)
    for _, id in ipairs(deleted) do assert(tonumber(id) >= 1 and tonumber(id) <= 4) end
    companions.registerDefinition('valid', {id='Character.Valid', name='Valid', profileKey='person-1'})
    local serial = companions.spawn('valid')
    deletionsFail = true
    local removed, reason = companions.dismiss(serial)
    assert(removed == false and reason and #companions.list() == 1)
    assert(companions.dismissAll() == false and #companions.list() == 1)
    deletionsFail = false
    assert(companions.dismissAll() == true and #companions.list() == 0)
  `);
});
