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
    saved = value; return 'saved'
  end}
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
    assert(not manager.followUpQuestions() and manager.snapshot(player).settings.followUpQuestions == false)
    assert(manager.applySettings(player, {lootReactions = false}))
    assert(not manager.lootReactions() and saved.lootReactions == false)
    assert(manager.applySettings(player, {lootReactions = 'on'}) == false)
    assert(manager.applySettings(player, {battleReactions = false}))
    assert(not manager.battleReactions() and saved.battleReactions == false)
    assert(manager.applySettings(player, {battleReactions = 'on'}) == false)
    assert(manager.applySettings(player, {voice = false, subtitleStyle = 'overhead', omniSteps = 16, voiceProvider = 'convai', disappearingMessages = true, followUpQuestions = true, enabledByKey = {['johnny-silverhand'] = false}}))
    assert(player.voice == false and saved.omniSteps == 16 and not manager.profileEnabled('johnny-silverhand'))
    assert(saved.disappearingMessages and manager.disappearingMessages())
    assert(saved.followUpQuestions == true and manager.followUpQuestions())
    failSave = true
    assert(manager.applySettings(player, {voice = true, subtitles = false, subtitleStyle = 'dialogue', omniSteps = 32, voiceProvider = 'hybrid', disappearingMessages = false, followUpQuestions = false}) == false)
    local values = manager.snapshot(player).settings
    assert(values.voice == false and values.subtitles == true and values.omniSteps == 16)
    assert(player.voice == false and player.subtitles == true)
    assert(values.disappearingMessages and manager.disappearingMessages())
    assert(values.followUpQuestions == true and manager.followUpQuestions())
    assert(values.voiceProvider == 'convai')
    assert(values.subtitleStyle == 'overhead' and manager.subtitleStyle() == 'overhead')
    failSave = false
    assert(manager.applySettings(player, {voice = true, omniSteps = 8}) == false)
    assert(manager.applySettings(player, {enabledByKey = {unknown = true}}) == false)
    assert(manager.applySettings(player, {disappearingMessages = 'yes'}) == false)
    assert(manager.applySettings(player, {voice = true, followUpQuestions = 'yes'}) == false)
    assert(not manager.snapshot(player).settings.voice and manager.followUpQuestions())
    assert(manager.applySettings(player, {voiceProvider = 'unknown'}) == false)
    assert(manager.applySettings(nil, {voice = true}))
    manager.reset(); manager.snapshot(player); assert(player.voice == true)
    assert(manager.followUpQuestions(), 'reset replaced the saved follow-up setting')
    assert(manager.subtitleStyle() == 'overhead', 'failed save or reset replaced explicit subtitle choice')
  `);
});

test('follow-up questions migrate to Off and retain explicit saved On or Off choices', () => {
  run(`${managerFixture}
    for _, savedValue in ipairs({'missing', 'on', 0, true, false}) do
      seed = {version = 2, voice = false, subtitles = false, subtitleStyle = 'dialogue',
        voiceProvider = 'convai', omniSteps = 16, battleReactions = false, lootReactions = false,
        disappearingMessages = true, enabledByKey = {}, future = {keep = 'unchanged'}}
      for _, profile in ipairs(profiles) do seed.enabledByKey[profile.key] = true end
      if savedValue ~= 'missing' then seed.followUpQuestions = savedValue end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles)
      local enabled = savedValue == true
      assert(manager.followUpQuestions() == enabled)
      local state = manager.snapshot(player).settings
      assert(state.followUpQuestions == enabled)
      assert(not state.voice and not state.subtitles and state.voiceProvider == 'convai' and state.omniSteps == 16)
      assert(not state.battleReactions and not state.lootReactions and state.disappearingMessages)
      if type(savedValue) ~= 'boolean' then
        assert(saved.followUpQuestions == false and saved.future.keep == 'unchanged', 'migration must save its default')
      end
      manager.reset()
      assert(manager.followUpQuestions() == enabled, 'reload did not preserve the persisted choice')
    end
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

const invitationFixture = `
  local readiness = {jobs = {}, receipts = {}, cancellations = {}, prepareCalls = 0}
  function readiness.bind(value) readiness.owner = value end
  function readiness.prepare(job)
    readiness.prepareCalls = readiness.prepareCalls + 1
    readiness.jobs[job.id] = {id = job.id, revision = job.revision, key = job.key, profileKey = job.profileKey}
    readiness.receipts[job.id] = {state = job.profileKey and 'memory' or 'model-only'}
    return true
  end
  function readiness.status(job) return readiness.receipts[job.id] end
  function readiness.cancel(job)
    readiness.cancellations[job.id] = true
    readiness.jobs[job.id], readiness.receipts[job.id] = nil, nil
  end
  function readiness.spawned(job, serial) readiness.lastSpawn = {id = job.id, serial = serial} end
  function readiness.finish(job) readiness.lastFinished = job.id end
  function readiness.update() readiness.updates = (readiness.updates or 0) + 1 end
  mcm.shutdown()
  local queueFactory = (function() ${queueSource} end)()
  mcm.configure(manager, api, {new = function(companions, preparation)
    assert(companions == api and preparation == readiness, 'MCM dropped the invitation readiness argument')
    return queueFactory.new(companions, preparation)
  end}, entryFactory, readiness)
  mcm.install()
  loaded = registered.loadMod('manager')
  local party = assert(mcm.party())
`;

const memoryFixture = `
  local memoryClock = 1800000000
  os.time = function() return memoryClock end
  local memoryStatus
  local function publishMemory(count, characters, state, command, updated)
    memoryStatus = {version = 1, updated = updated or memoryClock * 1000.0,
      state = state or 'ready', talkedToCount = count, characters = characters, command = command,
      endUserId = '12345678-1234-4234-9234-123456789abc'}
    jsonFixtures['memory-status'] = memoryStatus
    files['runtime/memory-status.json'] = 'memory-status'
  end
  local function memoryWrites()
    local count = 0
    for _, write in ipairs(fileWrites) do if write.path == 'runtime/memory-command.json.tmp' then count = count + 1 end end
    return count
  end
  local function memoryRequest()
    local raw = files['runtime/memory-command.json']
    return raw and json.decode(raw) or nil
  end
  local function memoryResult(command, state)
    return {id = command.id, scope = command.scope, profileKey = command.profileKey, state = state,
      message = 'Provider detail contains player 12345678-1234-4234-9234-123456789abc'}
  end
  local function reloadMemory()
    loaded = registered.loadMod('manager')
    return manager.snapshot(player).memory
  end
  local function openMemory()
    assert(invoke('tab:settings').ok and invoke('memory').ok)
  end
  local function token() return assert(manager.snapshot(player).memory.confirmation).token end
`;

test('native Memory submenu has consistent parent navigation and preserves an unissued confirmation', () => {
  run(`${mcmFixture}${memoryFixture}
    publishMemory(1, {{profileKey = 'person-20'}})
    assert(invoke('tab:settings').ok)
    assert(row('memory').type == 'action' and row('memory').value == 'Manage')
    assert(not row('memory:choose') and not row('memory-count'), 'memory controls leaked into the Settings page')
    assert(invoke('permissions').ok and mcm.inspect().view == 'permissions')
    assert(row('tab:settings').value == 'Selected' and row('tab:settings').disabled)
    assert(invoke('permissions:back').ok and mcm.inspect().view == 'settings')
    assert(invoke('memory').ok and mcm.inspect().view == 'memory')
    assert(row('tab:settings').value == 'Selected' and row('tab:settings').disabled)
    assert(invoke('memory:choose').ok and mcm.inspect().view == 'memory-characters')
    assert(row('tab:settings').value == 'Selected' and row('memory:back').label == 'Back to memory')
    handlers.McmUiEmitSearch(nil, 'content', 'Person 20')
    for _ = 1, 6 do mcm.update(player, false) end
    assert(invoke('memory:back').ok and mcm.inspect().view == 'memory')
    assert(invoke('memory:choose').ok and row('memory:next'), 'return retained the picker search')
    assert(invoke('memory:next').ok and invoke('memory:select:person-20').ok)
    assert(mcm.inspect().view == 'memory' and row('memory:choose').value == 'Person 20')
    assert(invoke('memory:forget-character').ok)
    local confirmation = token()
    assert(invoke('memory:settings').ok and mcm.inspect().view == 'settings')
    assert(invoke('memory').ok and token() == confirmation and row('memory-confirmation'))
    assert(invoke('memory:cancel:' .. confirmation).ok and memoryWrites() == 0)
    assert(#members == 0 and #spawned == 0)
  `);
});

test('native Memory controls use the contacted count and full catalogue without inviting a character or exposing identity', () => {
  run(`${mcmFixture}${memoryFixture}
    openMemory()
    assert(row('memory-service').value == 'Unavailable' and row('memory:forget-all').disabled)
    assert(not invoke('memory:forget-all').ok and memoryWrites() == 0)
    publishMemory(3, {{profileKey = 'johnny-silverhand'}, {profileKey = 'person-20'}, {profileKey = 'viktor-vektor'}})
    reloadMemory()
    assert(row('memory-count').value == '3' and not row('memory:forget-all').disabled)
    assert(row('memory:forget-character').disabled, 'selection must be explicit')
    assert(invoke('memory:choose').ok and row('memory:next'))
    assert(not row('memory:select:person-20'))
    handlers.McmUiEmitSearch(nil, 'content', 'pErSoN 20')
    for _ = 1, 6 do mcm.update(player, false) end
    assert(row('memory:select:person-20') and not row('memory:select:person-19'))
    assert(invoke('memory:select:person-20').ok)
    assert(row('memory:choose').value == 'Person 20' and not row('memory:forget-character').disabled)
    assert(#members == 0 and #spawned == 0 and memoryWrites() == 0)
    assert(saved.memoryProfileKey == nil and saved.endUserId == nil)
    for _, category in ipairs(loaded.categories) do
      for _, value in ipairs(category.settings) do
        local text = tostring(value.label) .. tostring(value.value) .. tostring(value.description)
        assert(not text:find(memoryStatus.endUserId, 1, true), 'raw player identity reached MCM')
      end
    end
    assert(row('memory-chat-history').description:find('saved Chat messages remain', 1, true))
    manager.selectMemoryCharacter('person-19'); reloadMemory()
    assert(row('memory:forget-character').disabled and not invoke('memory:forget-character').ok)
  `);
});

test('memory clear needs a separate confirmation, cancel sends nothing and deliberate double activation sends one command', () => {
  run(`${mcmFixture}${memoryFixture}
    publishMemory(2, {{profileKey = 'johnny-silverhand'}, {profileKey = 'person-20'}})
    openMemory()
    assert(invoke('memory:forget-all').ok)
    local cancelled = token()
    assert(row('memory-confirmation').value:find('all 2 characters', 1, true))
    assert(memoryWrites() == 0 and memoryRequest() == nil)
    assert(not manager.beginMemoryClear('all'))
    assert(invoke('memory:cancel:' .. cancelled).ok)
    assert(row('memory-feedback').value == 'Memory clear cancelled.')
    assert(not manager.confirmMemoryClear(cancelled) and memoryWrites() == 0)
    assert(manager.selectMemoryCharacter('person-20'))
    reloadMemory()
    assert(invoke('memory:forget-character').ok)
    local confirmation = token()
    assert(confirmation ~= cancelled)
    assert(row('memory-confirmation').value:find('Person 20', 1, true))
    assert(not invoke('memory:forget-character').ok and memoryWrites() == 0)
    assert(invoke('memory:confirm:' .. confirmation).ok)
    local command = assert(memoryRequest())
    assert(command.version == 1 and command.action == 'clear' and command.scope == 'character')
    assert(command.profileKey == 'person-20' and command.issuedAt == memoryClock * 1000.0)
    assert(command.id:match('^%x+%-%x+%-%x+%-%x+%-%x+:%d+$'))
    assert(command.id:sub(15, 15) == '4' and command.id:sub(20, 20):match('[89ab]'))
    assert(command.endUserId == nil and memoryWrites() == 1)
    assert(row('memory-feedback').value:find('Clearing memories', 1, true))
    assert(row('memory:forget-character').disabled and row('memory:forget-all').disabled)
    assert(not invoke('memory:confirm:' .. confirmation).ok)
    assert(not manager.confirmMemoryClear(confirmation) and not manager.beginMemoryClear('all'))
    for _ = 1, 25 do mcm.update(player, false) end
    assert(memoryWrites() == 1, 'pending cloud work was sent again')
  `);
});

test('memory completion requires exact ID, scope, profile and a current result; old success cannot complete a later request', () => {
  run(`${mcmFixture}${memoryFixture}
    publishMemory(2, {{profileKey = 'johnny-silverhand'}, {profileKey = 'person-20'}})
    openMemory()
    assert(manager.selectMemoryCharacter('johnny-silverhand'))
    reloadMemory(); assert(invoke('memory:forget-character').ok)
    assert(invoke('memory:confirm:' .. token()).ok)
    local first = memoryRequest()
    local wrong = memoryResult(first, 'succeeded'); wrong.id = 'unrelated'
    publishMemory(2, nil, 'ready', wrong); assert(reloadMemory().command.state == 'pending')
    wrong = memoryResult(first, 'succeeded'); wrong.scope, wrong.profileKey = 'all', nil
    publishMemory(2, nil, 'ready', wrong); assert(reloadMemory().command.state == 'pending')
    wrong = memoryResult(first, 'succeeded'); wrong.profileKey = 'person-20'
    publishMemory(2, nil, 'ready', wrong); assert(reloadMemory().command.state == 'pending')
    publishMemory(2, nil, 'ready', memoryResult(first, 'succeeded'), first.issuedAt - 1)
    assert(reloadMemory().command.state == 'pending')
    publishMemory(2, nil, 'ready', memoryResult(first, 'succeeded'))
    assert(reloadMemory().command.state == 'succeeded')
    assert(row('memory-feedback').value:find('confirmed for Johnny Silverhand', 1, true))
    assert(not row('memory-feedback').value:find(memoryStatus.endUserId, 1, true))
    publishMemory(2, nil, 'ready', memoryResult(first, 'failed'), first.issuedAt - 1)
    assert(reloadMemory().command.state == 'succeeded', 'late state replaced known completion')
    publishMemory(2, nil)
    reloadMemory(); assert(invoke('memory:forget-all').ok)
    assert(invoke('memory:confirm:' .. token()).ok)
    local second = memoryRequest()
    assert(first.id ~= second.id and second.id:sub(-2) == ':2' and second.scope == 'all' and second.profileKey == nil)
    publishMemory(2, nil, 'ready', memoryResult(first, 'succeeded'))
    assert(reloadMemory().command.state == 'pending')
    wrong = memoryResult(second, 'succeeded'); wrong.scope, wrong.profileKey = 'character', 'johnny-silverhand'
    publishMemory(2, nil, 'ready', wrong); assert(reloadMemory().command.state == 'pending')
    publishMemory(2, nil, 'ready', memoryResult(second, 'failed'))
    assert(reloadMemory().command.state == 'failed')
    assert(row('memory-feedback').value:find('could not confirm', 1, true))
    assert(not row('memory-feedback').value:find(memoryStatus.endUserId, 1, true))
    assert(memoryWrites() == 2)
  `);
});

test('pending memory commands survive manager, save and Lua reloads without a retry or timeout success', () => {
  run(`${mcmFixture}${memoryFixture}
    math.randomseed(42)
    publishMemory(1, {{profileKey = 'person-20'}})
    openMemory()
    assert(manager.selectMemoryCharacter('person-20'))
    reloadMemory(); assert(invoke('memory:forget-character').ok)
    assert(invoke('memory:confirm:' .. token()).ok)
    local command, raw = memoryRequest(), files['runtime/memory-command.json']
    manager.reset(); player.hash = 'player-2'; mcm.resetSession()
    assert(reloadMemory().command.id == command.id)
    assert(manager.snapshot(player).memory.command.state == 'pending' and memoryWrites() == 1)
    memoryClock = memoryClock + 60
    local state = reloadMemory()
    assert(state.state == 'unavailable' and state.command.state == 'pending')
    assert(row('memory-feedback').value:find('Waiting for the result', 1, true))
    assert(not manager.beginMemoryClear('all') and files['runtime/memory-command.json'] == raw)
    manager = (function() ${managerSource} end)()
    manager.configure(api, profiles)
    state = manager.snapshot(player).memory
    assert(state.command.id == command.id and state.command.state == 'pending' and memoryWrites() == 1)
    publishMemory(1, nil, 'unavailable', memoryResult(command, 'succeeded'), command.issuedAt + 1000)
    state = manager.snapshot(player).memory
    assert(state.command.state == 'succeeded' and state.state == 'unavailable')
    assert(not manager.beginMemoryClear('all') and memoryWrites() == 1)
    publishMemory(1, nil)
    math.randomseed(42)
    assert(manager.beginMemoryClear('all'))
    local nextToken = manager.snapshot(player).memory.confirmation.token
    assert(manager.confirmMemoryClear(nextToken))
    assert(memoryRequest().id ~= command.id and memoryWrites() == 2, 'fresh Lua RNG reused a command ID')
  `);
});

test('memory confirmation is cancelled on save reset, rejects a changed all count and handles service loss before submission', () => {
  run(`${mcmFixture}${memoryFixture}
    publishMemory(2, nil)
    openMemory(); assert(invoke('memory:forget-all').ok)
    local first = token()
    publishMemory(3, nil)
    assert(not manager.confirmMemoryClear(first) and memoryWrites() == 0)
    reloadMemory(); assert(not row('memory-confirmation'))
    assert(invoke('memory:forget-all').ok)
    local second = token()
    publishMemory(3, nil, 'unavailable')
    reloadMemory(); assert(row('memory:confirm:' .. second).disabled)
    assert(not invoke('memory:confirm:' .. second).ok and memoryWrites() == 0)
    assert(invoke('memory:cancel:' .. second).ok and memoryWrites() == 0)
    publishMemory(3, nil)
    reloadMemory(); assert(invoke('memory:forget-all').ok)
    local third = token()
    mcm.resetSession(); reloadMemory()
    assert(not manager.confirmMemoryClear(third) and not row('memory-confirmation'))
    assert(memoryWrites() == 0 and memoryRequest() == nil)
  `);
});

test('failed command publication shows failure, does not retry and leaves an earlier durable command intact', () => {
  run(`${mcmFixture}${memoryFixture}
    publishMemory(1, nil)
    openMemory(); assert(invoke('memory:forget-all').ok)
    local first = token()
    failSave = true
    assert(not invoke('memory:confirm:' .. first).ok)
    failSave = false
    reloadMemory()
    assert(row('memory-feedback').value:find('could not be sent', 1, true))
    assert(not manager.confirmMemoryClear(first) and memoryWrites() == 0 and memoryRequest() == nil)
    assert(invoke('memory:forget-all').ok and invoke('memory:confirm:' .. token()).ok)
    local command, raw = memoryRequest(), files['runtime/memory-command.json']
    publishMemory(1, nil, 'ready', memoryResult(command, 'succeeded')); reloadMemory()
    assert(invoke('memory:forget-all').ok)
    local failing = token()
    local rename = os.rename
    os.rename = function(from, to)
      if from == 'runtime/memory-command.json.tmp' then return nil end
      return rename(from, to)
    end
    assert(not invoke('memory:confirm:' .. failing).ok)
    os.rename = rename
    for _ = 1, 10 do mcm.update(player, false) end
    assert(files['runtime/memory-command.json'] == raw and memoryRequest().id == command.id)
    assert(not files['runtime/memory-command.json.tmp'] and not files['runtime/memory-command.json.previous'])
    assert(not manager.confirmMemoryClear(failing) and memoryWrites() == 2)
  `);
});

test('memory recovery reads an interrupted publication backup and blocks a corrupt previous request', () => {
  run(`${managerFixture}${memoryFixture}
    publishMemory(1, nil)
    local prior = {version = 1, id = 'saved-ui-session:4', action = 'clear', scope = 'all', issuedAt = memoryClock * 1000.0}
    jsonFixtures.previous = prior
    files['runtime/memory-command.json.previous'] = 'previous'
    manager.configure(api, profiles)
    assert(manager.snapshot(player).memory.command.id == prior.id)
    assert(not manager.beginMemoryClear('all') and memoryWrites() == 0)
    files['runtime/memory-command.json.previous'] = 'corrupt'
    manager = (function() ${managerSource} end)()
    manager.configure(api, profiles)
    local state = manager.snapshot(player).memory
    assert(state.state == 'unavailable' and state.feedback:find('could not be read', 1, true))
    assert(not manager.beginMemoryClear('all') and memoryWrites() == 0)
  `);
});

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
    assert(row('followUpQuestions').type == 'bool' and row('followUpQuestions').value == false)
    assert(row('followUpQuestions').defaultValue == false and row('followUpQuestions').capabilities.draft)
    assert(registered.applyBatch('manager', {{id = 'followUpQuestions', value = true}}).ok)
    assert(manager.followUpQuestions())
    assert(not registered.applyBatch('manager', {{id = 'followUpQuestions', value = 'off'}}).ok)
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

test('native MCM shows invitation preparation and keeps reserved copies editable until actual attachment', () => {
  run(`${mcmFixture}${invitationFixture}
    assert(invoke('invite:johnny-silverhand').ok)
    local id = party.list()[1].id
    assert(readiness.prepareCalls == 1 and readiness.jobs[id].profileKey == 'johnny-silverhand')
    assert(#spawned == 0 and party.count() == 1 and row('party-count').value == '1 / 8')
    local rendered
    handlers.McmUiBegin({}, 'MCM', '', 'Mods', 'Companion Manager', 'Completed: Johnny Silverhand', 1, '', true, true, 0,
      function(title, subtitle, sidebar, content, message) rendered = message end)
    assert(rendered:lower():find('prepar', 1, true) and not rendered:find('Completed:', 1, true))
    assert(not rendered:find('joined your group', 1, true))
    assert(invoke('tab:party').ok)
    assert(row('state:' .. id).value == 'Preparing memory')
    assert(row('dismiss:' .. id).value == 'Cancel invitation' and not row('assign:' .. id).disabled)
    readiness.receipts[id] = {state = 'connecting'}
    readiness.update(); mcm.update(player, false)
    loaded = registered.loadMod('manager')
    assert(row('state:' .. id).value == 'Connecting' and #spawned == 0)
    local revision = readiness.jobs[id].revision
    assert(invoke('assign:' .. id).ok and invoke('assign-profile:person-1').ok)
    assert(readiness.prepareCalls == 2 and readiness.jobs[id].profileKey == 'person-1')
    assert(readiness.jobs[id].revision ~= revision and row('state:' .. id).value == 'Preparing memory')
    readiness.receipts[id] = {state = 'error', error = 'Preparation service unavailable'}
    loaded = registered.loadMod('manager')
    assert(row('state:' .. id).value == 'Unavailable')
    assert(row('state:' .. id).description:find('Preparation service unavailable', 1, true))
    assert(not row('assign:' .. id).disabled and row('dismiss:' .. id).value == 'Cancel invitation')
    assert(invoke('dismiss:' .. id).ok and readiness.cancellations[id])
    assert(party.count() == 0 and row('party-count').value == '0 / 8' and #spawned == 0)

    -- Phone and native actions receive the same queue and reserved capacity.
    assert(party.invite('johnny-silverhand'))
    id = party.list()[1].id
    readiness.receipts[id] = {state = 'ready'}
    loaded = registered.loadMod('manager')
    assert(row('state:' .. id).value == 'Ready to join' and row('party-count').value == '1 / 8')
    mcm.update(player, false)
    assert(#spawned == 0, 'readiness created an actor while gameplay was paused')
    mcm.update(player, true)
    loaded = registered.loadMod('manager')
    assert(#spawned == 1 and row('state:live:1').value == 'Joining')
    assert(not party.message():find('joined your group', 1, true), 'accepted spawn was reported as joined')
    members[1].state = 'ready'; mcm.update(player, true)
    loaded = registered.loadMod('manager')
    assert(row('state:live:1').value == 'Following' and party.message():find('joined your group', 1, true))
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
    run(`${mcmFixture}${invitationFixture}${memoryFixture}
      mcm.shutdown()
      local encoded, jsonSequence = {}, 0
      json = {encode = function(value) jsonSequence = jsonSequence + 1; local id = 'json-' .. jsonSequence; encoded[id] = value; return id end,
        decode = function(value) return encoded[value] or jsonFixtures[value] or saved or {} end}
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
      assert(#spawned == 0 and #mcm.inspect().party == 1 and readiness.prepareCalls == 1)
      assert(actual.getValue(key .. ':party-count') == '1 / 8')
      assert(actual.invokeAction(key .. ':tab:party'))
      assert(actual.getValue(key .. ':state:queued:1') == 'Preparing memory')
      readiness.receipts['queued:1'] = {state = 'connecting'}
      assert(actual.reloadMod(key) and actual.getValue(key .. ':state:queued:1') == 'Connecting')
      assert(actual.invokeAction(key .. ':assign:queued:1'))
      assert(actual.invokeAction(key .. ':assign-profile:person-1'))
      assert(readiness.prepareCalls == 2 and readiness.jobs['queued:1'].profileKey == 'person-1')
      readiness.receipts['queued:1'] = {state = 'ready'}
      assert(actual.reloadMod(key) and actual.getValue(key .. ':state:queued:1') == 'Ready to join')
      mcm.update(player, false); assert(#spawned == 0)
      assert(actual.invokeAction(key .. ':tab:settings'))
      publishMemory(2, {{profileKey = 'johnny-silverhand'}, {profileKey = 'person-20'}})
      assert(actual.reloadMod(key))
      assert(actual.getValue(key .. ':memory') == 'Manage' and actual.getValue(key .. ':memory-count') == nil)
      assert(actual.setDraft(key .. ':voice', false))
      assert(actual.setDraft(key .. ':omniSteps', 1))
      assert(actual.setDraft(key .. ':voiceProvider', 2))
      assert(actual.setDraft(key .. ':subtitleStyle', 1))
      assert(actual.setDraft(key .. ':battleReactions', false))
      assert(actual.getValue(key .. ':followUpQuestions') == false)
      assert(actual.setDraft(key .. ':followUpQuestions', true))
      assert(not manager.followUpQuestions(), 'draft must not change running conversations')
      assert(actual.invokeAction(key .. ':tab:characters') == false)
      assert(actual.invokeAction(key .. ':memory') == false and memoryWrites() == 0)
      assert(mcm.inspect().view == 'settings', 'a pending draft allowed submenu navigation')
      local ok, err = actual.apply(key)
      assert(ok, err)
      assert(actual.getValue(key .. ':voice') == false and actual.getValue(key .. ':omniSteps') == 1)
      assert(manager.snapshot(player).settings.omniSteps == 16 and not actual.hasDrafts(key))
      assert(actual.getValue(key .. ':voiceProvider') == 2)
      assert(manager.snapshot(player).settings.voiceProvider == 'convai')
      assert(actual.getValue(key .. ':subtitleStyle') == 1 and manager.subtitleStyle() == 'overhead')
      assert(not manager.battleReactions() and actual.getValue(key .. ':battleReactions') == false)
      assert(manager.followUpQuestions() and actual.getValue(key .. ':followUpQuestions') == true)
      assert(actual.setDraft(key .. ':subtitles', false))
      assert(actual.setDraft(key .. ':followUpQuestions', false))
      assert(actual.invokeAction(key .. ':permissions') == false)
      assert(actual.revert(key) and actual.getValue(key .. ':subtitles') == true)
      assert(manager.followUpQuestions() and actual.getValue(key .. ':followUpQuestions') == true)
      assert(actual.invokeAction(key .. ':permissions') and mcm.inspect().view == 'permissions')
      assert(actual.getValue(key .. ':tab:settings') == 'Selected')
      assert(actual.invokeAction(key .. ':permissions:back') and mcm.inspect().view == 'settings')
      assert(actual.invokeAction(key .. ':memory') and mcm.inspect().view == 'memory')
      assert(actual.getValue(key .. ':memory-count') == '2' and actual.getValue(key .. ':tab:settings') == 'Selected')
      assert(actual.invokeAction(key .. ':memory:choose') and mcm.inspect().view == 'memory-characters')
      assert(actual.getValue(key .. ':tab:settings') == 'Selected')
      assert(actual.invokeAction(key .. ':memory:back') and mcm.inspect().view == 'memory')
      assert(actual.invokeAction(key .. ':memory:choose'))
      assert(actual.invokeAction(key .. ':memory:next'))
      assert(actual.invokeAction(key .. ':memory:select:person-20'))
      assert(mcm.inspect().view == 'memory' and actual.getValue(key .. ':memory:choose') == 'Person 20' and #members == 0)
      assert(actual.invokeAction(key .. ':memory:settings') and mcm.inspect().view == 'settings')
      assert(actual.getValue(key .. ':memory:choose') == nil and actual.getValue(key .. ':memory') == 'Manage')
      assert(actual.invokeAction(key .. ':memory') and actual.getValue(key .. ':memory:choose') == 'Person 20')
      assert(actual.invokeAction(key .. ':memory:forget-character'))
      local cancelToken = token()
      assert(actual.invokeAction(key .. ':memory:cancel:' .. cancelToken) and memoryWrites() == 0)
      assert(actual.invokeAction(key .. ':memory:forget-all'))
      local confirmToken = token()
      assert(actual.invokeAction(key .. ':memory:confirm:' .. confirmToken))
      local command = assert(memoryRequest())
      assert(command.scope == 'all' and command.profileKey == nil and memoryWrites() == 1)
      assert(actual.invokeAction(key .. ':memory:confirm:' .. confirmToken) == false)
      assert(actual.invokeAction(key .. ':memory:forget-all') == false)
      local old = memoryResult(command, 'succeeded'); old.id = 'another-command'
      publishMemory(2, nil, 'ready', old); assert(actual.reloadMod(key))
      assert(manager.snapshot(player).memory.command.state == 'pending')
      publishMemory(2, nil, 'ready', memoryResult(command, 'succeeded')); assert(actual.reloadMod(key))
      assert(actual.getValue(key .. ':memory-feedback'):find('Memory clear confirmed', 1, true))
      assert(memoryWrites() == 1 and #spawned == 0, 'memory controls caused world work or retried')
      assert(actual.invokeAction(key .. ':tab:party'))
      assert(actual.invokeAction(key .. ':dismiss:queued:1'))
      assert(#mcm.inspect().party == 0 and #spawned == 0 and readiness.cancellations['queued:1'])
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
