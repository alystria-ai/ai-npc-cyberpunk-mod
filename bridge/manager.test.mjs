import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';
import {companionModules, companionEngine, flatNavigation, flatSpatial} from './companion-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const managerSource = readFileSync(new URL('../mod/manager.lua', import.meta.url), 'utf8');
const companionsSource = readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8');
const queueSource = readFileSync(new URL('../mod/manager-party.lua', import.meta.url), 'utf8');
const mcmSource = readFileSync(new URL('../mod/mcm.lua', import.meta.url), 'utf8');
const entrySource = readFileSync(new URL('../mod/mcm-entry.lua', import.meta.url), 'utf8');
const voicePreviewSource = readFileSync(new URL('../mod/voice-preview.lua', import.meta.url), 'utf8');
const fontsSource = readFileSync(new URL('../mod/ui-fonts.lua', import.meta.url), 'utf8');
const mcmFontsSource = readFileSync(new URL('../mod/mcm-fonts.lua', import.meta.url), 'utf8');
const frenchUiSource = readFileSync(new URL('../mod/locales/fr.lua', import.meta.url), 'utf8');

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
    if #members >= 8 then return nil, 'There is no room for another companion. Dismiss one first.' end
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
    assert(queue.list()[9].state == 'failed' and queue.message():find('no room', 1, true))
    queue.flush(); assert(#spawned == 9, 'failed request must not retry every frame')
    api.dismiss = oldDismiss
    queue.bind(nil); assert(#queue.list() == 8, 'loading a save cancels pending work')
  `);
});

test('MCM settings apply as one saved transaction and leave playback unchanged on a save failure', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.snapshot(player)
    assert(manager.snapshot(player).settings.disappearingMessages == nil)
    assert(manager.subtitleStyle() == 'dialogue' and saved.subtitleStyle == 'dialogue')
    assert(manager.snapshot(player).settings.voiceProvider == 'omni', 'default voice is OmniVoice 16 steps')
    assert(manager.snapshot(player).settings.omniSteps == 16 and saved.omniSteps == 16)
    assert(manager.battleReactions() and manager.snapshot(player).settings.battleReactions)
    assert(manager.lootReactions() and manager.snapshot(player).settings.lootReactions)
    assert(not manager.followUpQuestions() and manager.snapshot(player).settings.followUpQuestions == false)
    assert(manager.applySettings(player, {lootReactions = false}))
    assert(not manager.lootReactions() and saved.lootReactions == false)
    assert(manager.applySettings(player, {lootReactions = 'on'}) == false)
    assert(manager.applySettings(player, {battleReactions = false}))
    assert(not manager.battleReactions() and saved.battleReactions == false)
    assert(manager.applySettings(player, {battleReactions = 'on'}) == false)
    assert(manager.applySettings(player, {voice = false, subtitleStyle = 'overhead', voiceProvider = 'convai', followUpQuestions = true, enabledByKey = {['johnny-silverhand'] = false}}))
    assert(player.voice == false and saved.omniSteps == 16 and not manager.profileEnabled('johnny-silverhand'))
    assert(saved.disappearingMessages == nil)
    assert(saved.followUpQuestions == true and manager.followUpQuestions())
    failSave = true
    assert(manager.applySettings(player, {voice = true, subtitles = false, subtitleStyle = 'dialogue', voiceProvider = 'pocket', followUpQuestions = false}) == false)
    local values = manager.snapshot(player).settings
    assert(values.voice == false and values.subtitles == true and values.omniSteps == 16)
    assert(player.voice == false and player.subtitles == true)
    assert(values.disappearingMessages == nil)
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
      assert(not state.battleReactions and not state.lootReactions and state.disappearingMessages == nil)
      if type(savedValue) ~= 'boolean' then
        assert(saved.followUpQuestions == false and saved.future.keep == 'unchanged', 'migration must save its default')
      end
      manager.reset()
      assert(manager.followUpQuestions() == enabled, 'reload did not preserve the persisted choice')
    end
  `);
});

test('relationship modes default to Auto and apply atomically without changing unrelated preferences', () => run(`${managerFixture}
  manager.configure(api, profiles)
  local initial=manager.snapshot(player).settings
  for _, row in ipairs(manager.relationshipChoices()) do assert(row.mode=='auto') end
  assert(manager.applySettings(player,{relationshipModes={['judy-alvarez']='on',['kerry-eurodyne']='off'}}))
  local current=manager.snapshot(player).settings
  assert(current.relationshipModes['judy-alvarez']=='on' and current.relationshipModes['kerry-eurodyne']=='off')
  assert(current.relationshipModes['meredith-stout']=='auto' and current.voiceProvider==initial.voiceProvider)
  current.relationshipModes['judy-alvarez']='off'
  assert(manager.snapshot(player).settings.relationshipModes['judy-alvarez']=='on','snapshot mutated policy')
  failSave=true
  assert(not manager.applySettings(player,{relationshipModes={['judy-alvarez']='off'}}))
  assert(manager.snapshot(player).settings.relationshipModes['judy-alvarez']=='on')
  failSave=false
  assert(not manager.applySettings(player,{relationshipModes={unknown='on'}}))
  assert(not manager.applySettings(player,{relationshipModes={['judy-alvarez']=true}}))
  manager.reset()
  assert(manager.snapshot(player).settings.relationshipModes['judy-alvarez']=='on')
`));

test('gaze choices preserve accepted defaults, reject invalid settings and survive reset atomically', () => {
  run(`${managerFixture}
    manager.configure(api, profiles)
    local values=manager.snapshot(player).settings
    assert(values.eyeContactHeight==0 and values.headFollowStrength==1)
    assert(saved.eyeContactHeight==0 and saved.headFollowStrength==1)
    local heights,strengths=manager.gazeChoices()
    assert(#heights==5 and heights[3]==0 and #strengths==4 and strengths[3]==1)
    heights[3],strengths[3]=0.10,0
    local current=api.gazeSettings(); current.eyeContactHeight=0.10
    assert(manager.gazeSettings().eyeContactHeight==0,'a caller mutated persisted policy')
    heights,strengths=manager.gazeChoices()
    assert(heights[3]==0 and strengths[3]==1,'MCM mutated domain choices')
    assert(manager.applySettings(player,{eyeContactHeight=0.05,headFollowStrength=1.5}))
    assert(api.gazeSettings().eyeContactHeight==0.05 and api.gazeSettings().headFollowStrength==1.5)
    for _,invalid in ipairs({-0.11,0.11,0.02,'0',false,math.huge,0/0}) do
      assert(not manager.applySettings(player,{voice=false,eyeContactHeight=invalid}))
      assert(manager.snapshot(player).settings.voice and manager.gazeSettings().eyeContactHeight==0.05)
    end
    for _,invalid in ipairs({-0.5,2,0.3,'1',false,math.huge,0/0}) do
      assert(not manager.applySettings(player,{headFollowStrength=invalid}))
      assert(manager.gazeSettings().headFollowStrength==1.5)
    end
    failSave=true
    assert(not manager.applySettings(nil,{eyeContactHeight=0,headFollowStrength=1}))
    assert(api.gazeSettings().eyeContactHeight==0.05 and api.gazeSettings().headFollowStrength==1.5)
    failSave=false; manager.reset()
    assert(api.gazeSettings().eyeContactHeight==0.05 and api.gazeSettings().headFollowStrength==1.5)
    assert(manager.applySettings(nil,{eyeContactHeight=0,headFollowStrength=1}))
    manager.reset()
    assert(api.gazeSettings().eyeContactHeight==0 and api.gazeSettings().headFollowStrength==1)
  `);
});

test('older settings migrate gaze independently and keep valid saved choices', () => {
  run(`${managerFixture}
    for _,value in ipairs({'missing',0.10,-0.05,0.02,'0',math.huge}) do
      seed={version=2,enabledByKey={},headFollowStrength=0.5,future={keep='unchanged'}}
      if value~='missing' then seed.eyeContactHeight=value end
      files['runtime/settings.json'],saved='seed',nil
      manager.configure(api,profiles)
      local current=manager.snapshot(player).settings
      local expected=(value==0.10 or value==-0.05) and value or 0
      assert(current.eyeContactHeight==expected and current.headFollowStrength==0.5)
      assert(saved.eyeContactHeight==expected and saved.headFollowStrength==0.5 and saved.future.keep=='unchanged')
    end
    for _,value in ipairs({'missing',0,1.5,0.3,'1',math.huge}) do
      seed={version=2,enabledByKey={},eyeContactHeight=-0.10,future={keep='unchanged'}}
      if value~='missing' then seed.headFollowStrength=value end
      files['runtime/settings.json'],saved='seed',nil
      manager.configure(api,profiles)
      local current=manager.snapshot(player).settings
      local expected=(value==0 or value==1.5) and value or 1
      assert(current.headFollowStrength==expected and current.eyeContactHeight==-0.10)
      assert(saved.headFollowStrength==expected and saved.eyeContactHeight==-0.10 and saved.future.keep=='unchanged')
    end
  `);
});

test('saved manager gaze reaches the real companion actuator only in the ordinary gameplay update', () => {
  run(`${companionEngine}${storage}
    local manager=(function() ${managerSource} end)()
    manager.configure(companions,{{key='judy-alvarez',name='Judy Alvarez',records={'Character.Judy'}},
      {key='panam-palmer',name='Panam Palmer',records={'Character.Panam'}}})
    local one=spawn(); local two=spawn('panam-palmer'); tick(4)
    local oldOne,oldTwo=next(one.looks),next(two.looks)
    assert(oldOne and oldTwo and oldOne.offset.z==0 and oldOne.parts[1].weight==0.05)
    local commandsOne,commandsTwo=#one.ai.commands,#two.ai.commands
    assert(manager.applySettings(nil,{eyeContactHeight=0.10,headFollowStrength=1.5}))
    assert(next(one.looks)==oldOne and next(two.looks)==oldTwo,'MCM Apply touched native actors in its callback')
    tick(1)
    local newOne,newTwo=next(one.looks),next(two.looks)
    assert(newOne~=oldOne and newTwo~=oldTwo)
    assert(newOne.targetPositionProvider.worldOffset.z==0.10 and newTwo.targetPositionProvider.worldOffset.z==0.10)
    assert(#one.ai.commands==commandsOne and #two.ai.commands==commandsTwo)
    manager.reset(); tick(1)
    assert(next(one.looks)==newOne,'world/settings reset forgot persisted gaze policy')
    assert(manager.applySettings(nil,{eyeContactHeight=0,headFollowStrength=1})); tick(1)
    assert(next(one.looks).targetPositionProvider.worldOffset==nil and next(one.looks).parts[1].weight==0.05)
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
      assert(not state.voice and state.omniSteps == 16 and saved.omniSteps == 16 and state.disappearingMessages == nil)
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
  local originalDofile = dofile
  dofile = function(path)
    if path == 'voice-preview.lua' then return (function() ${voicePreviewSource} end)() end
    if path == 'ui-fonts.lua' then return (function() ${fontsSource} end)() end
    if path == 'mcm-fonts.lua' then return (function() ${mcmFontsSource} end)() end
    return originalDofile(path)
  end
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
  local controller = {nativeIdentity = 101,
    McmUiEmitSearch = function(_, context, value) handlers.McmUiEmitSearch(nil, context, value) end}
  CalcSeed = function(value) return value.nativeIdentity end
  local function invoke(id)
    local result = registered.invokeAction('manager', id, {interaction = {controller = controller}})
    if result.ok and result.schemaChanged then loaded = registered.loadMod('manager') end
    return result
  end
`;

test('Current party has no drive initiation and defers active-trip stopping until gameplay resumes', () => {
  run(`${mcmFixture}
    api.spawn('johnny-silverhand');members[1].state='ready';members[1].entityID='42ULL'
    local trip={active=false,phase='idle'}
    local nativeCalls,paused=0,true
    api.chauffeurSnapshot=function()
      local result={};for key,value in pairs(trip)do result[key]=value end;return result
    end
    api.queueChauffeur=function()error('the manager initiated a driving request')end
    api.cancelChauffeur=function()
      assert(not paused);nativeCalls=nativeCalls+1;trip.phase='stopping';return true
    end
    assert(invoke('tab:party').ok)
    local id='chauffeur:drive:live:'..members[1].serial
    assert(not row(id)and not row('chauffeur:stop')and not row('chauffeur-state'))
    assert(mcm.party().drive==nil and mcm.party().cancelDrive==nil)
    local originalPlayer=Game.GetPlayer
    Game.GetPlayer=function()error('native player query from a removed drive action')end
    assert(not registered.invokeAction('manager',id,{}).ok and nativeCalls==0)
    Game.GetPlayer=originalPlayer
    trip={active=true,phase='waiting-for-player',offer={actor={serial=members[1].serial}}}
    loaded=registered.loadMod('manager')
    assert(row('chauffeur:stop').value=='Stop trip'and row('chauffeur-state').value=='Waiting for you to board')
    assert(not row(id))
    paused=true;Game.GetPlayer=function()error('native player query from a stop action callback')end
    assert(registered.invokeAction('manager','chauffeur:stop',{}).ok and nativeCalls==0)
    Game.GetPlayer=originalPlayer;mcm.update(player,false);assert(nativeCalls==0)
    paused=false;mcm.update(player,true);assert(nativeCalls==1 and trip.phase=='stopping')
    assert(invoke('party:back').ok and not row('chauffeur:stop'))
  `);
});

test('manager home owns the four destinations and every inner page has one parent Back action', () => {
  run(`${mcmFixture}
    local function category(id)
      for _, item in ipairs(loaded.categories) do if item.id == id then return item end end
    end
    local function inner(expected, back)
      assert(mcm.inspect().view == expected)
      assert(not category('navigation'), 'home navigation leaked onto an inner page')
      for _, name in ipairs({'characters', 'party', 'models', 'settings'}) do
        assert(not row('tab:' .. name), 'a root destination leaked onto an inner page')
      end
      local count = 0
      for _, section in ipairs(loaded.categories) do
        for _, item in ipairs(section.settings) do
          if item.value == 'Back' then count = count + 1; assert(item.id == back) end
          assert(item.label:sub(1, 1) ~= ' ' and item.indent == nil, 'label has artificial indentation')
        end
      end
      assert(count == 1 and loaded.categories[1].settings[1].id == back, 'parent Back must be first')
      if expected == 'party' then
        assert(category('party-status') and not row('party-count') and not row('feedback'),
          'Current party shows the companion limit or the last action')
      else
        assert(not category('party-status') and not row('party-count') and not row('feedback'),
          'party status leaked outside Current party')
      end
    end
    assert(mcm.inspect().view == 'home' and #loaded.categories == 1)
    assert(#category('navigation').settings == 4 and not row('party-count'))
    for _, name in ipairs({'characters', 'party', 'models', 'settings'}) do
      local destination = row('tab:' .. name)
      assert(destination and destination.value == 'Open' and not destination.disabled)
      assert(invoke(destination.id).ok)
      inner(name, name .. ':back')
      assert(not invoke(destination.id).ok, 'stale destination actions remained callable')
      assert(invoke(name .. ':back').ok and mcm.inspect().view == 'home')
    end
    assert(invoke('tab:settings').ok)
    for _, page in ipairs({'relationships', 'permissions', 'memory'}) do
      assert(invoke(page).ok)
      local back = page == 'memory' and 'memory:settings' or page .. ':back'
      inner(page, back)
      assert(invoke(back).ok and mcm.inspect().view == 'settings')
    end
    assert(invoke('memory').ok and invoke('memory:choose').ok)
    inner('memory-characters', 'memory:back')
    assert(invoke('memory:back').ok and invoke('memory:settings').ok and invoke('settings:back').ok)
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    inner('characters', 'characters:back')
    assert(invoke('characters:back').ok and invoke('tab:party').ok)
    inner('party', 'party:back')
    assert(not row('assign:queued:1') and not invoke('assign:queued:1').ok,
      'a per-copy conversation action remained on Current party')
    assert(not invoke('assignment:back').ok and not invoke('assign-profile:person-1').ok,
      'the removed conversation page remained callable')
  `);
});

test('voice selector arrows stay within their displayed direction and use effective drafts', () => {
  run(`${mcmFixture}
    assert(invoke('tab:settings').ok)
    handlers.McmUiSetContentTitle(controller, 'Companion Manager')
    local selector = {nativeIdentity = 202}
    local key = 'cyberpunk-convai:manager:voiceProvider'
    local effective, forwarded = 1, 0
    nativeApi.getValue = function(id) assert(id == key); return effective end
    if handlers.McmUiConfigureBase then handlers.McmUiConfigureBase(selector, controller, key) end
    local wrapped = function(forward)
      forwarded = forwarded + 1
      effective = effective + (forward and 1 or -1)
      if effective > 4 then effective = 1 elseif effective < 1 then effective = 4 end
    end
    local emit = function(forward)
      if handlers.McmUiEmitStep then return handlers.McmUiEmitStep(selector, forward, wrapped) end
      return wrapped(forward)
    end
    emit(false)
    assert(effective == 1 and forwarded == 0, 'left at OmniVoice 16 steps must not wrap right')
    for _, expected in ipairs({2, 3, 4}) do emit(true); assert(effective == expected and forwarded == expected - 1) end
    emit(true)
    assert(effective == 4 and forwarded == 3, 'right at Convai must not wrap left')
    for _, expected in ipairs({3, 2, 1}) do emit(false); assert(effective == expected and forwarded == 7 - expected) end
    emit(false); assert(effective == 1 and forwarded == 6, 'left at OmniVoice 16 steps must not wrap right')
    assert(row('voiceProvider').defaultValue == 1)
    assert(#row('voiceProvider').elements == 4 and row('voiceProvider').elements[1] == 'OmniVoice 16 steps')
    assert(row('voiceProvider').elements[2] == 'OmniVoice 32 steps' and row('voiceProvider').elements[3] == 'Pocket TTS')
    assert(row('voiceProvider').elements[4] == 'Convai cloud voice')
    assert(row('omniSteps') == nil, 'retired quality steps remain in the active menu')
    handlers.McmUiConfigureBase(selector, controller, 'another-mod:settings:voiceProvider')
    emit(false)
    assert(effective == 4 and forwarded == 7, 'foreign selector behavior must pass through')
  `);
});

test('local voice previews carry the effective four-choice draft and cancel on Revert, Apply or leaving the page', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(manager.applySettings(player, {voiceProvider = 'convai'}))
    local committed = saved
    local preview = (function() ${voicePreviewSource} end)().new({now = function() return 1000 end})
    -- Select order: 1 OmniVoice 16 steps, 2 OmniVoice 32 steps, 3 Pocket TTS, 4 Convai cloud voice.
    local effective, pending, callback, inCallback, reads = 1, true, nil, false, 0
    local bus = {
      subscribe = function(topic, listener) assert(topic == 'drafts.changed'); callback = listener; return 'preview-token' end,
      unsubscribe = function(token) assert(token == 'preview-token'); callback = nil end,
      hasDrafts = function(key) assert(not inCallback and key == 'cyberpunk-convai:manager'); return pending end,
      getValue = function(key)
        assert(not inCallback and key == 'cyberpunk-convai:manager:voiceProvider', 'preview queried a retired quality selector')
        reads = reads + 1; return effective
      end,
    }
    preview.bind(bus)
    local function changed()
      local writes = #fileWrites
      inCallback = true; callback({modKey = 'cyberpunk-convai:manager'}); inCallback = false
      assert(#fileWrites == writes, 'native draft callback performed filesystem IO')
    end
    local function update(visible)
      preview.update(visible ~= false, 'settings-controller', function() return manager.snapshot(player).settings end)
      return files['runtime/voice-preview.json'] and json.decode(files['runtime/voice-preview.json'])
    end
    changed()
    local lease = update()
    assert(lease.active and lease.provider == 'omni' and lease.omniSteps == 16 and lease.steps == nil and reads == 1)
    assert(saved == committed and manager.snapshot(player).settings.voiceProvider == 'convai')
    update(); assert(reads == 1, 'unchanged draft was queried again in the same poll interval')
    effective, pending = 4, false; changed()
    local cancelled = update()
    assert(not cancelled.active and cancelled.owner == lease.owner and cancelled.sequence > lease.sequence)
    assert(saved == committed and manager.snapshot(player).settings.voiceProvider == 'convai')
    effective, pending = 1, true; changed(); lease = update()
    assert(lease.active and lease.provider == 'omni' and lease.omniSteps == 16 and lease.steps == nil)
    effective = 2; changed(); local qualityPreview = update()
    assert(qualityPreview.active and qualityPreview.provider == 'omni' and qualityPreview.omniSteps == 32)
    assert(qualityPreview.sequence > lease.sequence, 'same-second quality change did not reach the backend')
    assert(saved == committed and manager.snapshot(player).settings.voiceProvider == 'convai')
    effective = 1; changed(); lease = update()
    assert(lease.active and lease.omniSteps == 16)
    assert(manager.applySettings(player, {voiceProvider = 'omni', omniSteps = 16})); pending = false; changed()
    assert(not update().active and manager.snapshot(player).settings.voiceProvider == 'omni')
    pending = true; changed(); assert(not update().active, 'an unrelated draft re-warmed the saved choice')
    effective = 2; changed(); assert(update().active and preview.inspect().omniSteps == 32)
    effective = 3; changed(); lease = update()
    assert(lease.active and lease.provider == 'pocket' and lease.omniSteps == nil, 'Pocket preview retained stale Omni quality')
    effective, pending = 1, false; changed(); assert(not update().active)
    assert(manager.snapshot(player).settings.voiceProvider == 'omni' and manager.snapshot(player).settings.omniSteps == 16)
    assert(manager.applySettings(player, {voiceProvider = 'convai'})); pending = true; changed()
    effective = 3
    lease = update(); assert(lease.active and lease.provider == 'pocket')
    assert(not update(false).active and manager.snapshot(player).settings.voiceProvider == 'convai')
    changed(); assert(update().active)
    preview.shutdown()
    assert(not json.decode(files['runtime/voice-preview.json']).active and callback == nil)
    assert(manager.snapshot(player).settings.voiceProvider == 'convai')
  `);
});

test('one MCM voice selector commits Pocket, both Omni qualities and Convai without an extra quality row', () => {
  run(`${mcmFixture}
    assert(invoke('tab:settings').ok)
    -- Pocket keeps the remembered Omni quality (32 after the second choice).
    for _, choice in ipairs({{1, 'omni', 16}, {2, 'omni', 32}, {3, 'pocket', 32}, {4, 'convai', 32}}) do
      assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = choice[1]}}).ok)
      loaded = registered.loadMod('manager')
      assert(row('voiceProvider').value == choice[1] and row('voiceProvider').defaultValue == 1)
      assert(row('omniSteps') == nil)
      local selected = manager.snapshot(player).settings
      assert(selected.voiceProvider == choice[2] and selected.omniSteps == choice[3])
      assert(saved.voiceProvider == choice[2] and saved.omniSteps == choice[3])
      manager.reset()
      assert(manager.snapshot(player).settings.voiceProvider == choice[2] and manager.snapshot(player).settings.omniSteps == choice[3])
    end
    for _, invalid in ipairs({0, 5, 2.5, '2', false, math.huge, 0/0}) do
      local before = saved
      assert(not registered.applyBatch('manager', {{id = 'voice', value = false}, {id = 'voiceProvider', value = invalid}}).ok)
      assert(saved == before and manager.snapshot(player).settings.voice and manager.snapshot(player).settings.voiceProvider == 'convai')
    end
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 2}}).ok)
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 3}}).ok)
    assert(saved.voiceProvider == 'pocket' and saved.omniSteps == 32, 'selecting Pocket erased the remembered Omni quality')
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 4}}).ok)
    assert(saved.voiceProvider == 'convai' and saved.omniSteps == 32)
  `);
});

test('interface language persists atomically, localizes the schema and preserves literal character names and voice choices',()=>{
  run(`${mcmFixture}
    local savedDofile=dofile
    dofile=function(path)
      if path=='locales/fr.lua' then return (function() ${frenchUiSource} end)() end
      return savedDofile(path)
    end
    profiles[1].name='Settings'
    assert(invoke('tab:settings').ok)
    assert(row('uiLanguage').value==1 and row('uiLanguage').defaultValue==1)
    local voiceBefore=manager.snapshot(player).settings.voiceProvider
    local stepsBefore=manager.snapshot(player).settings.omniSteps
    local choices=convaiUiLocale.choices();local french
    for i,choice in ipairs(choices)do if choice.value=='fr'then french=i end end
    assert(registered.applyBatch('manager',{{id='uiLanguage',value=french}}).ok)
    assert(saved.uiLanguage=='fr' and convaiUiLocale.selection()=='fr')
    assert(convaiUiLocale.update(0))
    loaded=registered.loadMod('manager')
    assert(row('settings:back').label=='Retour à la gestion des compagnons')
    assert(row('uiLanguage').label~='Interface language' and row('uiLanguage').value==french)
    assert(row('uiLanguage').elements[2]=='English','language names must remain natively recognizable')
    local snapshot=manager.snapshot(player)
    assert(snapshot.settings.voiceProvider==voiceBefore and snapshot.settings.omniSteps==stepsBefore)
    assert(invoke('settings:back').ok and row('tab:settings').label=='Paramètres')
    assert(invoke('tab:characters').ok)
    assert(row('invite:'..profiles[1].key).label=='Settings','a character name was translated as a UI key')
    local selected,notice=manager.selectMemoryCharacter(profiles[1].key)
    assert(selected and notice==convaiUiLocale.t('{name} selected for memory controls.',{name='Settings'}))
    assert(notice:find('Settings',1,true) and not notice:find('selected for memory controls',1,true))
    failSave=true
    assert(not manager.applySettings(player,{uiLanguage='de'}))
    assert(convaiUiLocale.selection()=='fr' and manager.snapshot(player).settings.uiLanguage=='fr')
    failSave=false
    assert(not manager.applySettings(player,{uiLanguage='../invalid'}))
    assert(saved.uiLanguage=='fr')
  `);
});

test('native settings styling waits for the final title, aligns scaled rows and retains native controls', () => {
  run(`${mcmFixture}
    CName = {new = function(value) return value end}
    NameToString = function(value) return value end
    local nativeHook, rootReads = false, 0
    local function widget(name, left, width, color, children)
      local value = {name = name, left = left or 0, width = width or 200, color = color, children = children or {}}
      function value:GetName() assert(not nativeHook, 'widget traversal inside a native observer'); return self.name end
      function value:GetNumChildren() return #self.children end
      function value:GetWidgetByIndex(index) return self.children[index + 1] end
      function value:GetMargin() return {left = self.left, top = 48, right = 0, bottom = 0} end
      function value:SetMargin(margin) assert(not nativeHook, 'widget setter inside a native observer'); self.left = margin.left; assert(margin.top == 48) end
      function value:GetWidth() return self.width end
      function value:SetWidth(width) self.width = width end
      function value:GetTintColor() return self.color end
      function value:SetTintColor(color) self.color = color end
      function value:BindProperty(property, color) assert(not nativeHook, 'widget binding inside a native observer'); assert(property == 'tintColor'); self.color = color end
      function value:GetScale() return {X = self.scale or 1, Y = self.scale or 1} end
      function value:GetController()
        if self.name == 'settingsCategory' then return {IsA = function(_, class) return class == 'SettingsCategoryController' end} end
      end
      return value
    end
    local content = widget('mcm_content_scroll_content')
    local root = widget('root', 0, 1000, nil, {content})
    local theme = 'native-label-colour'
    function controller:GetRootWidget()
      assert(not nativeHook, 'root traversal inside a native observer')
      rootReads = rootReads + 1; return root
    end
    function controller:McmUiAddReadonly(id)
      -- MCMContent.reds uses x=20 for the surface, while MCMRenderer.reds
      -- adds its frame-style list inset to the child label.
      local label = widget('label', 16, 184, theme)
      local surface = widget('mcm_action_' .. id, 20, 200, nil, {label})
      content.children[#content.children + 1] = surface
      return surface
    end
    local function reference(id)
      -- CET creates a fresh WeakReference wrapper for each native callback.
      -- Wrappers compare unequal even while CalcSeed identifies the same menu.
      return setmetatable({nativeIdentity = id or 101}, {__index = controller})
    end
    local function begin()
      -- Real MCM renders the provisional title first, then rows, and only
      -- publishes the actual provider title after all row construction.
      handlers.McmUiBegin(reference(), 'MCM', '', 'Mods', 'Mods', '', 0, '', true, true, 0, function() end)
    end
    local function finish(title)
      nativeHook = true
      handlers.McmUiSetContentTitle(reference(), title)
      nativeHook = false
    end
    local function frame()
      local before = rootReads
      mcm.update(player, false)
      assert(rootReads <= before + 1, 'page tree was traversed again for each row')
    end
    local function managed(id, kind)
      local label = widget(id .. '_managed_label', 48, 300, 'modified')
      local marker = widget(id .. '_managed_marker', 20, 20, 'modified')
      content.children[#content.children + 1] = label
      content.children[#content.children + 1] = marker
      return label, marker
    end
    begin()
    local category = widget('settingsCategory', 0, 1800, nil, {
      widget('label', 20, 1600, 'native-heading'), widget('line', 0, 1800, 'native-cyan-rule')})
    category.scale = 0.5
    content.children[#content.children + 1] = category
    local heading = category.children[1]
    local toggle, marker = managed('toggle', 'McmUiAddBool')
    local select = managed('select', 'McmUiBeginSelect')
    local readonly = controller:McmUiAddReadonly('status')
    local action = widget('action_label', 20, 400, theme)
    content.children[#content.children + 1] = action
    local cyanValue = widget('mcm_action_value', 620, 280, 'cyan')
    content.children[#content.children + 1] = cyanValue
    assert(toggle.left == 48 and toggle.color == 'modified', 'ownership was guessed from the provisional title')
    finish('Companion Manager')
    assert(toggle.left == 48 and rootReads == 0, 'native observer did work instead of deferring it')
    frame()
    assert(category.left + category.scale * heading.left == 20 and heading.color == 'MainColors.White')
    assert(category.children[2].color == 'native-cyan-rule', 'native section rule was recolored')
    assert(cyanValue.left == 620 and cyanValue.color == 'cyan', 'native option styling changed')
    assert(toggle.left == action.left and select.left == action.left)
    assert(readonly.left + readonly.children[1].left == action.left)
    assert(toggle.width == 328 and select.width == 328, 'moving labels must preserve their right edge')
    assert(marker.left + marker.width < toggle.left and marker.color == 'modified', 'draft marker lost its separate state')
    assert(toggle.color == 'MainColors.Red' and select.color == 'MainColors.Red' and action.color == 'MainColors.Red')
    assert(readonly.children[1].color == 'MainColors.Red')
    toggle.color = 'native-hover'
    handlers.McmUiSetManagedLabelState(reference(), 'toggle', true, true)
    assert(toggle.color == 'native-hover', 'hover feedback was flattened')
    toggle.color = 'modified'
    nativeHook = true
    handlers.McmUiSetManagedLabelState(reference(), 'toggle', false, true)
    nativeHook = false
    assert(toggle.color == 'modified', 'hover-out styling was not deferred')
    frame()
    assert(toggle.color == 'MainColors.Red' and toggle.width == 328, 'restyling accumulated width or retained a different label colour')
    assert(marker.color == 'modified')
    readonly.children[1].color = 'native-hover'
    handlers.McmUiEmitHover(reference(), 'status', '', true)
    assert(readonly.children[1].color == 'native-hover', 'read-only hover feedback was flattened')
    readonly.children[1].color = 'different-theme-colour'
    nativeHook = true
    handlers.McmUiEmitHover(reference(), 'status', '', false)
    nativeHook = false
    frame()
    assert(readonly.children[1].color == 'MainColors.Red', 'read-only hover-out did not restore default red')
    activeMod = 'another:mod'
    begin()
    local foreign, foreignMarker = managed('foreign', 'McmUiAddBool')
    finish('Another mod')
    frame()
    assert(foreign.left == 48 and foreign.color == 'modified' and foreignMarker.width == 20)
    activeMod = 'cyberpunk-convai:manager'
    begin()
    local global = managed('global', 'McmUiAddBool')
    finish('MCM Settings')
    frame()
    assert(global.left == 48 and global.color == 'modified', 'retained activeModKey leaked into another MCM route')
    content.children = {}
    begin()
    theme = 'changed-native-theme'
    controller:McmUiAddReadonly('new-category')
    local changed = managed('new-toggle', 'McmUiAddBool')
    finish('Companion Manager')
    frame()
    assert(changed.color == 'MainColors.Red', 'customized framework colours replaced the requested default red')
    handlers.McmUiSetManagedLabelState(reference(202), 'new-toggle', false, true)
    assert(not mcm.inspect().presentation.pending, 'another controller queued styling on this page')
    handlers.OnUninitialize(reference(202))
    assert(mcm.inspect().presentation.active, 'another controller cleared the current page')
    handlers.McmUiSetManagedLabelState(reference(), 'new-toggle', false, true)
    assert(mcm.inspect().presentation.pending, 'a fresh wrapper lost native menu ownership')
    handlers.OnUninitialize(reference())
    assert(not mcm.inspect().presentation.active, 'native menu detach retained the page wrapper')
    local readsBeforeDetach = rootReads
    frame()
    assert(rootReads == readsBeforeDetach, 'detached controller was used by a queued styling pass')
    CalcSeed = function() error('identity unavailable') end
    begin(); finish('Companion Manager'); frame()
    assert(not mcm.inspect().presentation.active and rootReads == readsBeforeDetach,
      'missing native identity must not fall back to wrapper ownership')
  `);
});

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
  mcm.configure(manager, api, {new = function(companions, preparation, options)
    assert(companions == api and preparation == readiness, 'MCM dropped the invitation readiness argument')
    assert(type(options.developerMode) == 'function', 'MCM dropped the cached developer predicate')
    return queueFactory.new(companions, preparation, options)
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

test('paused invitation preparation snapshots follow the newest ticket and revision without gameplay work', () => {
  run(`${mcmFixture}${invitationFixture}
    assert(party.preparationFeedback() == nil)
    assert(party.invite('johnny-silverhand'))
    local first = party.preparationFeedback()
    assert(first.id == 'queued:1' and first.revision == 1 and first.state == 'memory')
    assert(first.message == 'Johnny Silverhand: preparing memory...' and not first.failed)
    assert(party.preparationFeedback().signature == first.signature)
    readiness.receipts[first.id] = {state = 'connecting'}
    local connecting = party.preparationFeedback()
    assert(connecting.message == 'Johnny Silverhand: connecting...' and connecting.signature ~= first.signature)
    assert(party.invite('person-1'))
    local latest = party.preparationFeedback()
    assert(latest.id == 'queued:2' and latest.signature ~= first.signature)
    assert(party.assign(first.id, 'person-2', 'Person 2'))
    local revised = party.preparationFeedback()
    assert(revised.id == first.id and revised.revision == 2 and revised.signature ~= first.signature)
    readiness.receipts[first.id] = {state = 'error', error = 'Private provider detail'}
    local failed = party.preparationFeedback()
    assert(failed.failed and failed.message == 'Johnny Silverhand: preparation failed. Cancel and invite again.')
    assert(not failed.message:find('Private provider detail', 1, true))
    assert(party.dismiss(first.id) and party.preparationFeedback() == nil,
      'cancellation resurrected an older invitation banner')
    assert(party.count() == 1 and #spawned == 0 and #party.takeNotices() == 0)
    assert(party.invite('johnny-silverhand'))
    local last = party.preparationFeedback()
    readiness.receipts[last.id] = {state = 'ready'}
    assert(party.preparationFeedback().message == 'Johnny Silverhand is ready to join when you return to the game.')
    party.flush()
    assert(party.preparationFeedback() == nil and #spawned == 1)
    party.bind('another-world')
    assert(party.preparationFeedback() == nil and party.count() == 1)
  `);
});

const managerBannerFixture = `
  local clock, nativeHook, rootReads = 1000, false, 0
  os.time = function() return clock end
  CName = {new = function(value) return value end}
  NameToString = function(value) return value end
  local banner = {text = '', writes = 0}
  function banner:GetName() assert(not nativeHook); return 'status' end
  function banner:SetText(value)
    assert(not nativeHook, 'banner wrote native widgets from a callback')
    self.text, self.writes = value, self.writes + 1
  end
  local content = {GetName = function() assert(not nativeHook); return 'mcm_content_scroll_content' end,
    GetNumChildren = function() return 0 end}
  local root = {GetName = function() assert(not nativeHook); return 'MCMRenderRoot' end,
    GetNumChildren = function() return 2 end,
    GetWidgetByIndex = function(_, index) return index == 0 and banner or content end}
  function controller:GetRootWidget()
    assert(not nativeHook, 'banner traversed native widgets from a callback')
    rootReads = rootReads + 1; return root
  end
  local function paint(status, title, kind)
    local before = banner.writes
    nativeHook = true
    handlers.McmUiBegin(controller, 'MCM', '', 'Mods', 'Mods', status or '', kind or 1,
      activeMod or '', true, true, 0,
      function(_, _, _, _, value) banner.text = value end)
    handlers.McmUiSetContentTitle(controller, title or 'Companion Manager')
    nativeHook = false
    assert(banner.writes == before, 'render callback mutated the status widget')
  end
  local function tick() clock = clock + 1; mcm.update(player, false) end
`;

const managerPopupFixture = `
  local popupClock, nativeCallback, popups = 1000, false, {}
  os.time = function() return popupClock end
  function player:ConvaiPhoneFeedback(message)
    assert(not nativeCallback, 'manager action callback posted a native popup')
    popups[#popups + 1] = message
  end
  local function popupTick(worldReady)
    popupClock = popupClock + 1
    mcm.update(player, worldReady == true)
  end
  -- Routine progress popups are Developer mode only; it defaults to Off.
  local function developer(enabled)
    assert(registered.applyBatch('manager', {{id = 'developerMode', value = enabled == true}}).ok)
  end
`;

test('with Developer mode on, manager invitations use the phone native popup channel for each current preparation stage', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok)
    nativeCallback = true; assert(invoke('invite:johnny-silverhand').ok); nativeCallback = false
    assert(#popups == 0, 'invitation posted a popup inside its native action callback')
    popupTick(false)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand: preparing memory...')
    for _ = 1, 5 do popupTick(false) end
    assert(#popups == 1, 'same ticket/revision/state repeated its popup')
    readiness.receipts['queued:1'] = {state = 'connecting'}; popupTick(false)
    assert(#popups == 2 and popups[2] == 'Johnny Silverhand: connecting...')
    readiness.receipts['queued:1'] = {state = 'ready'}; popupTick(false)
    assert(#popups == 3 and popups[3] == 'Johnny Silverhand is ready to join when you return to the game.')
    assert(#spawned == 0)
    popupTick(true)
    assert(#popups == 4 and popups[4] == 'Johnny Silverhand is joining your party.')
    popupTick(true); assert(#popups == 4)
    members[1].state = 'ready'; popupTick(true)
    assert(#popups == 5 and popups[5] == 'Johnny Silverhand joined your group.')
    for _ = 1, 5 do popupTick(true) end
    assert(#popups == 5, 'obsolete preparation followed the joined notification')
  `);
});

test('leaving the manager replays only the current unresolved stage and keeps phone invitations independent', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    popupTick(false)
    readiness.receipts['queued:1'] = {state = 'connecting'}
    -- Resume inside the same clock second: do not reuse the paused memory sample.
    mcm.update(player, true)
    assert(#popups == 2 and popups[2] == 'Johnny Silverhand: connecting...')
    popupTick(true); assert(#popups == 2)
    assert(invoke('characters:back').ok and invoke('tab:settings').ok and invoke('memory').ok)
    assert(invoke('memory:choose').ok and invoke('memory:select:johnny-silverhand').ok)
    readiness.receipts['queued:1'] = {state = 'error', error = 'Private detail'}; popupTick(false)
    assert(#popups == 2, 'the paused menu consumed the failure notice')
    popupTick(true)
    assert(#popups == 3 and popups[3] == 'Johnny Silverhand could not prepare: Private detail',
      'an unrelated footer action disabled the in-world notification')
    assert(party.dismiss('queued:1')); popupTick(true)
    assert(#popups == 3, 'cancelled progress replayed on returning to gameplay')
    assert(party.invite('person-1')); popupTick(false)
    readiness.receipts['queued:2'] = {state = 'connecting'}; popupTick(false)
    assert(#popups == 3, 'manager added duplicate popups for a phone-owned invitation')
  `);
});

test('manager popup identities distinguish duplicate copies then expire on world reset', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok); popupTick(false)
    assert(invoke('invite:johnny-silverhand').ok); popupTick(false)
    assert(#popups == 2 and popups[1] == popups[2], 'new copy was deduplicated by its display text')
    assert(party.dismiss('queued:2')); popupTick(false)
    readiness.receipts['queued:1'] = {state = 'connecting'}; popupTick(false)
    assert(#popups == 2, 'removing the latest copy revived an older progress popup')
    mcm.resetSession(); popupTick(true)
    assert(#popups == 2 and #spawned == 0, 'world reset retained a stale popup or invitation')
  `);
});

test('a preparation popup hidden by the menu gets one gameplay presentation per stage', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok); popupTick(false)
    mcm.update(player, true)
    assert(#popups == 2 and popups[1] == popups[2] and popups[2] == 'Johnny Silverhand: preparing memory...')
    for _ = 1, 3 do popupTick(true); popupTick(false) end
    popupTick(true); assert(#popups == 2, 'reopening the menu repeated a stage already shown in gameplay')
    readiness.receipts['queued:1'] = {state = 'error', error = 'Bridge unavailable'}; popupTick(false)
    -- The paused menu shows the failure in its banner only and keeps the claim.
    for _ = 1, 3 do popupTick(false) end
    assert(#popups == 2, 'the paused menu consumed the single failure notice')
    popupTick(true)
    assert(#popups == 3 and popups[3] == 'Johnny Silverhand could not prepare: Bridge unavailable',
      'the failure was not posted when gameplay resumed')
    -- A failed attempt reports once: gameplay is the claim.
    for _ = 1, 3 do popupTick(true); popupTick(false) end
    assert(#popups == 3, 'the existing failure notice was duplicated by a second preparation failure')
  `);
});

test('with Developer mode off, preparation progress and the joined notice stay visible and only the joining step is hidden', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    assert(not manager.developerMode())
    assert(invoke('tab:characters').ok)
    nativeCallback = true; assert(invoke('invite:johnny-silverhand').ok); nativeCallback = false
    popupTick(false)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand: preparing memory...',
      'a slow preparation must show progress so it is not mistaken for a failure')
    readiness.receipts['queued:1'] = {state = 'connecting'}; popupTick(false)
    assert(#popups == 2 and popups[2] == 'Johnny Silverhand: connecting...')
    readiness.receipts['queued:1'] = {state = 'ready'}; popupTick(false)
    assert(#popups == 3 and popups[3] == 'Johnny Silverhand is ready to join when you return to the game.',
      'the instruction to return to the game must be shown')
    popupTick(true)
    assert(#popups == 3 and #spawned == 1, 'the routine joining stage posted a popup with Developer mode off')
    popupTick(true); popupTick(true); assert(#popups == 3)
    members[1].state = 'ready'; popupTick(true)
    assert(#popups == 4 and popups[4] == 'Johnny Silverhand joined your group.')
    for _ = 1, 3 do popupTick(true) end
    assert(#popups == 4)
  `);
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    popupTick(false)
    readiness.receipts['queued:1'] = {state = 'ready'}; popupTick(false)
    assert(#popups == 2)
    popupTick(true); assert(#popups == 2)
    -- Turning Developer mode on shows the joining step once, not a backlog.
    developer(true); popupTick(true)
    assert(#popups == 3 and popups[3] == 'Johnny Silverhand is joining your party.')
    popupTick(true); popupTick(true); assert(#popups == 3)
    developer(false); members[1].state = 'ready'; popupTick(true)
    assert(#popups == 4 and popups[4] == 'Johnny Silverhand joined your group.')
  `);
});

test('a preparation failure first seen in the paused menu posts exactly one gameplay notice with Developer mode off', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    popupTick(false)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand: preparing memory...')
    readiness.receipts['queued:1'] = {state = 'error', error = 'Bridge unavailable'}
    for _ = 1, 4 do popupTick(false) end
    assert(#popups == 1, 'the paused menu posted or consumed the failure notice')
    assert(party.preparationFeedback().failed, 'the manager banner must still show the failure')
    popupTick(true)
    assert(#popups == 2 and popups[2] == 'Johnny Silverhand could not prepare: Bridge unavailable')
    for _ = 1, 4 do popupTick(true); popupTick(false) end
    assert(#popups == 2 and #spawned == 0, 'the failed attempt notified again or was retried')
    -- Cancelling and inviting again is a new attempt with its own notice.
    assert(invoke('characters:back').ok and invoke('tab:party').ok and invoke('dismiss:queued:1').ok)
    assert(invoke('party:back').ok and invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok); popupTick(false)
    assert(#popups == 3 and popups[3] == 'Johnny Silverhand: preparing memory...')
    readiness.receipts['queued:2'] = {state = 'error', error = 'Still unavailable'}
    popupTick(false); assert(#popups == 3)
    popupTick(true)
    assert(#popups == 4 and popups[4] == 'Johnny Silverhand could not prepare: Still unavailable')
  `);
});

test('an already joined manager invitation cannot replay preparation when the game resumes', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok); popupTick(false)
    readiness.receipts['queued:1'] = {state = 'ready'}
    party.flush(); members[1].state = 'ready'
    mcm.update(player, true)
    assert(#popups == 2 and popups[2] == 'Johnny Silverhand joined your group.')
    for _ = 1, 5 do popupTick(true) end
    assert(#popups == 2)
  `);
});

test('a deferred world spawn presents the joining stage only once before attachment', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok); popupTick(false)
    readiness.receipts['queued:1'] = {state = 'ready'}
    local originalSpawn, attempts = api.spawn, 0
    api.spawn = function(key)
      attempts = attempts + 1
      if attempts < 3 then return nil, nil, true end
      return originalSpawn(key)
    end
    popupTick(true)
    assert(#spawned == 0 and #popups == 2 and popups[2] == 'Johnny Silverhand is joining your party.')
    popupTick(true); popupTick(true)
    assert(attempts == 3 and #spawned == 1 and #popups == 2,
      'admitting the deferred spawn repeated the same joining notification')
    members[1].state = 'ready'; popupTick(true)
    assert(#popups == 3 and popups[3] == 'Johnny Silverhand joined your group.')
  `);
});

test('an immediate preparation failure posts one gameplay failure notice outside the callback, regardless of Developer mode', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    readiness.prepare = function() return false, 'Bridge unavailable' end
    assert(invoke('tab:characters').ok)
    nativeCallback = true; assert(not invoke('invite:johnny-silverhand').ok); nativeCallback = false
    assert(#popups == 0)
    popupTick(false)
    assert(#popups == 0, 'the immediate failure already has its notice; the paused menu added a second one')
    popupTick(true)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand could not prepare: Bridge unavailable',
      'first gameplay flush did not post the single failure notice')
    for _ = 1, 3 do popupTick(true); popupTick(false) end
    assert(#popups == 1 and #spawned == 0)
  `);
});

test('manager invitation banner follows paused preparation without reloading drafts or showing party blocks', () => {
  run(`${mcmFixture}${invitationFixture}${managerBannerFixture}
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    drafts = true
    paint('Completed: Johnny Silverhand')
    local reloadBefore = reloads
    tick()
    assert(banner.text == 'Johnny Silverhand: preparing memory...' and rootReads == 1)
    assert(not row('party-count') and not row('feedback') and not row('tab:settings'))
    local writes = banner.writes
    tick(); tick()
    assert(banner.writes == writes, 'unchanged preparation repainted every frame')
    readiness.receipts['queued:1'] = {state = 'connecting'}; tick()
    assert(banner.text == 'Johnny Silverhand: connecting...' and banner.writes == writes + 1)
    writes = banner.writes
    paint('Completed: Johnny Silverhand'); tick()
    assert(banner.text == 'Johnny Silverhand: connecting...' and banner.writes == writes,
      'a page rebuild lost or duplicated the cached preparation update')
    readiness.receipts['queued:1'] = {state = 'ready'}; tick()
    assert(banner.text == 'Johnny Silverhand is ready to join when you return to the game.')
    readiness.receipts['queued:1'] = {state = 'error', error = 'Internal detail'}; tick()
    assert(banner.text == 'Johnny Silverhand: preparation failed. Cancel and invite again.')
    assert(reloads == reloadBefore and drafts and #spawned == 0, 'paused feedback mutated gameplay or drafts')
    assert(party.dismiss('queued:1')); tick()
    assert(banner.text == '', 'cancelled invitation left stale progress in the banner')
    writes = banner.writes; tick(); assert(banner.writes == writes)
  `);
});

test('preparation banners preserve native errors, memory action feedback, foreign pages and detached controllers', () => {
  run(`${mcmFixture}${invitationFixture}${memoryFixture}${managerBannerFixture}
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    paint('Action failed', nil, 2); tick()
    assert(banner.text == 'Action failed' and banner.writes == 0, 'native error was replaced')
    paint('Completed: Johnny Silverhand'); tick()
    assert(banner.text == 'Johnny Silverhand: preparing memory...', 'preparation did not resume on an eligible banner')
    assert(invoke('characters:back').ok and invoke('tab:settings').ok and invoke('memory').ok)
    memoryClock = clock
    publishMemory(1, {{profileKey = 'person-20'}}); loaded = registered.loadMod('manager')
    assert(invoke('memory:forget-all').ok and invoke('memory:cancel:' .. token()).ok)
    paint('Completed: Cancel')
    readiness.receipts['queued:1'] = {state = 'connecting'}; tick()
    assert(banner.text == 'Memory clear cancelled. Nothing was deleted.', 'preparation hid the memory result')
    assert(invoke('memory:settings').ok and invoke('settings:back').ok and invoke('tab:characters').ok)
    assert(invoke('invite:person-1').ok)
    paint('Completed: Person 01'); tick()
    assert(banner.text == 'Person 01: preparing memory...')
    activeMod = 'other:mod'
    paint('Foreign status', 'Another mod'); tick()
    assert(banner.text == 'Foreign status')
    activeMod = 'cyberpunk-convai:manager'
    paint('Completed: Person 01'); tick()
    local writes = banner.writes
    handlers.OnUninitialize(controller)
    readiness.receipts['queued:2'] = {state = 'ready'}; tick()
    assert(banner.writes == writes, 'detached status widget was used')
    mcm.resetSession(); paint(''); tick()
    assert(banner.text == '', 'world reset resurrected invitation feedback')
  `);
});

test('voice preparation status updates its owned readonly text without discarding an MCM draft', () => {
  run(`${mcmFixture}
    local clock, nativeHook, rootReads = 1000, false, 0
    os.time = function() return clock end
    CName = {new = function(value) return value end}
    NameToString = function(value) return value end
    local value = {text = 'Before preparation', writes = 0}
    function value:GetName() return 'cyberpunk-convai:manager:voice-status_value' end
    function value:GetController() return nil end
    function value:SetText(text)
      assert(not nativeHook, 'status touched ink inside the native callback')
      self.text, self.writes = text, self.writes + 1
    end
    local content = {GetName = function() return 'mcm_content_scroll_content' end,
      GetNumChildren = function() return 1 end, GetWidgetByIndex = function() return value end}
    function controller:GetRootWidget()
      assert(not nativeHook, 'status traversed ink inside the native callback')
      rootReads = rootReads + 1; return content
    end
    jsonFixtures['voice-runtime'] = {state = 'loading', provider = 'convai',
      previewActive = true, previewProvider = 'pocket', preparationOnly = true, updated = clock * 1000}
    files['runtime/local-voice-state.json'] = 'voice-runtime'
    assert(invoke('tab:settings').ok)
    drafts = true
    nativeHook = true; handlers.McmUiSetContentTitle(controller, 'Companion Manager'); nativeHook = false
    assert(rootReads == 0 and value.writes == 0)
    local before = reloads
    mcm.update(player, false)
    assert(value.text == 'Loading' and value.writes == 1 and rootReads == 1)
    clock = clock + 1; jsonFixtures['voice-runtime'].state = 'warming'; mcm.update(player, false)
    assert(value.text == 'Preparing voices' and value.writes == 2)
    clock = clock + 1; jsonFixtures['voice-runtime'].state = 'ready'; mcm.update(player, false)
    assert(value.text == 'Ready · Unsaved selection' and value.writes == 3)
    jsonFixtures['voice-runtime'].pending = true
    for _, state in ipairs({'loading', 'warming', 'ready'}) do
      clock = clock + 1; jsonFixtures['voice-runtime'].state = state; mcm.update(player, false)
      local labels = {loading = 'Loading', warming = 'Preparing voices', ready = 'Ready'}
      assert(value.text == labels[state] .. ' · After current reply', 'applied preparation progress was hidden')
    end
    jsonFixtures['voice-runtime'].previewActive = false
    clock = clock + 1; mcm.update(player, false)
    assert(value.text == 'Ready · After current reply', 'Apply was mislabeled as unsaved')
    jsonFixtures['voice-runtime'].pending = false
    clock = clock + 1; mcm.update(player, false)
    assert(value.text == 'Ready', 'absence of a draft was mislabeled as unsaved')
    jsonFixtures['voice-runtime'].previewActive = true
    jsonFixtures['voice-runtime'].previewProvider = 'convai'
    clock = clock + 1; mcm.update(player, false)
    assert(value.text == 'Ready', 'Convai draft was mislabeled as an unsaved Pocket selection')
    assert(reloads == before and drafts, 'read-only status discarded or reloaded a draft')
    local writes = value.writes
    handlers.OnUninitialize(controller)
    clock = clock + 1; jsonFixtures['voice-runtime'].state = 'remote'; mcm.update(player, false)
    assert(value.writes == writes, 'detached settings text was touched')
  `);
});

test('native Memory submenu has consistent parent navigation and preserves an unissued confirmation', () => {
  run(`${mcmFixture}${memoryFixture}
    publishMemory(1, {{profileKey = 'person-20'}})
    assert(invoke('tab:settings').ok)
    assert(row('memory').type == 'action' and row('memory').value == 'Manage')
    assert(not row('memory:choose') and not row('memory-count'), 'memory controls leaked into the Settings page')
    assert(invoke('permissions').ok and mcm.inspect().view == 'permissions')
    assert(not row('tab:settings') and row('permissions:back').label == 'Back to settings')
    assert(invoke('permissions:back').ok and mcm.inspect().view == 'settings')
    assert(invoke('memory').ok and mcm.inspect().view == 'memory')
    assert(not row('tab:settings') and row('memory:settings').label == 'Back to settings')
    assert(invoke('memory:choose').ok and mcm.inspect().view == 'memory-characters')
    assert(not row('tab:settings') and row('memory:back').label == 'Back to memory')
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
    assert(row('memory-chat-history').description:find('clears their saved Chat messages and drafts', 1, true))
    manager.selectMemoryCharacter('person-19'); reloadMemory()
    assert(not row('memory:forget-character').disabled, 'An uncontacted configured character may still have local Chat to clear')
    assert(invoke('memory:forget-character').ok)
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
    assert(row('memory-feedback').value == 'Memory clear cancelled. Nothing was deleted.')
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

test('backing out of the memory picker or cancelling a Forget confirmation says nothing was deleted and deletes nothing', () => {
  run(`${mcmFixture}${memoryFixture}${managerBannerFixture}
    memoryClock = clock -- the banner fixture owns os.time; keep the memory status fresh against it
    publishMemory(2, {{profileKey = 'johnny-silverhand'}, {profileKey = 'person-20'}})
    local removed, originalRemove = {}, os.remove
    os.remove = function(path) removed[#removed + 1] = path; return originalRemove(path) end
    local function nothingDeleted()
      assert(memoryWrites() == 0 and memoryRequest() == nil and #removed == 0, 'a back-out or cancel touched stored memory')
      assert(#members == 0 and #spawned == 0)
    end
    local pickerClosed = 'Character picker closed. Your selection is unchanged. Closing it deleted nothing.'
    local cancelled = 'Memory clear cancelled. Nothing was deleted.'
    openMemory()
    assert(not row('memory-feedback'), 'feedback appeared before any action')
    -- Open the picker and leave without choosing anyone.
    assert(invoke('memory:choose').ok and mcm.inspect().view == 'memory-characters')
    assert(invoke('memory:back').ok and mcm.inspect().view == 'memory')
    paint('Completed: Back to memory'); assert(banner.text == pickerClosed)
    assert(row('memory-feedback').value == pickerClosed)
    assert(row('memory:choose').value == 'Choose a character', 'backing out selected someone')
    assert(row('memory:forget-character').disabled)
    nothingDeleted()
    -- Choosing a character replaces that note and still asks before any Forget.
    assert(invoke('memory:choose').ok and invoke('memory:next').ok and invoke('memory:select:person-20').ok)
    assert(not row('memory-feedback') and row('memory:choose').value == 'Person 20')
    -- Backing out later keeps the choice.
    assert(invoke('memory:choose').ok and invoke('memory:back').ok)
    assert(row('memory:choose').value == 'Person 20' and row('memory-feedback').value == pickerClosed)
    nothingDeleted()
    -- A new confirmation must not sit beside the old note.
    assert(invoke('memory:forget-character').ok)
    assert(not row('memory-feedback') and row('memory-confirmation'))
    local firstToken = token()
    assert(invoke('memory:cancel:' .. firstToken).ok)
    paint('Completed: Cancel'); assert(banner.text == cancelled)
    assert(row('memory-feedback').value == cancelled and not row('memory-confirmation'))
    assert(row('memory:choose').value == 'Person 20')
    nothingDeleted()
    assert(not manager.confirmMemoryClear(firstToken))
    nothingDeleted()
    -- The same for Forget all.
    assert(invoke('memory:forget-all').ok and not row('memory-feedback'))
    assert(invoke('memory:cancel:' .. token()).ok)
    assert(row('memory-feedback').value == cancelled)
    nothingDeleted()
  `);
});

test('closing the memory picker keeps an earlier clear result visible', () => {
  run(`${mcmFixture}${memoryFixture}${managerBannerFixture}
    memoryClock = clock -- the banner fixture owns os.time; keep the memory status fresh against it
    publishMemory(2, {{profileKey = 'johnny-silverhand'}, {profileKey = 'person-20'}})
    openMemory()
    assert(invoke('memory:choose').ok and invoke('memory:next').ok and invoke('memory:select:person-20').ok)
    assert(invoke('memory:forget-character').ok and invoke('memory:confirm:' .. token()).ok)
    local command = assert(memoryRequest())
    publishMemory(2, {{profileKey = 'johnny-silverhand'}}, 'ready', memoryResult(command, 'failed'))
    reloadMemory()
    local failure = row('memory-feedback').value
    assert(failure:find('could not confirm', 1, true))
    assert(invoke('memory:choose').ok and invoke('memory:back').ok)
    paint('Completed: Back to memory')
    assert(banner.text == 'Character picker closed. Your selection is unchanged. Closing it deleted nothing.')
    assert(row('memory-feedback').value == failure, 'the picker note hid the failed clear')
    assert(memoryWrites() == 1)
  `);
});

test('Memory permits deliberate local Chat clearing with zero contacted provider pairs', () => run(`${mcmFixture}${memoryFixture}
  publishMemory(0,{})
  openMemory()
  assert(not row('memory:forget-all').disabled)
  assert(invoke('memory:forget-all').ok and memoryWrites()==0)
  assert(invoke('memory:cancel:'..token()).ok and memoryWrites()==0)
  manager.selectMemoryCharacter('person-20');reloadMemory()
  assert(not row('memory:forget-character').disabled)
  assert(invoke('memory:forget-character').ok and memoryWrites()==0)
  assert(invoke('memory:confirm:'..token()).ok and memoryWrites()==1)
  assert(memoryRequest().profileKey=='person-20')
`));

test('Relationships use their own MCM page and only applied selections reach saved modes', () => run(`${mcmFixture}
  assert(invoke('tab:settings').ok and row('relationships'))
  assert(invoke('relationships').ok)
  local selected=row('relationship:judy-alvarez')
  assert(selected and selected.value==1 and selected.defaultValue==1)
  assert(selected.elements[1]=='Auto' and selected.elements[2]=='On' and selected.elements[3]=='Off')
  assert(row('relationship:meredith-stout').description:find('does not imply an ongoing relationship',1,true))
  assert(manager.snapshot(player).settings.relationshipModes['judy-alvarez']=='auto')
  assert(registered.applyBatch('manager',{{id='relationship:judy-alvarez',value=2}}).ok)
  assert(saved.relationshipModes['judy-alvarez']=='on')
  assert(not registered.applyBatch('manager',{{id='relationship:judy-alvarez',value=4}}).ok)
  assert(saved.relationshipModes['judy-alvarez']=='on')
  assert(invoke('relationships:back').ok and row('relationships') and not row('disappearingMessages'))
`));

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
    assert(invoke('tab:characters').ok)
    assert(row('invite:johnny-silverhand').type == 'action')
    assert(invoke('invite:johnny-silverhand').ok)
    mcm.update(player, false)
    assert(#spawned == 0 and #mcm.inspect().party == 1)
    assert(invoke('characters:back').ok and invoke('tab:party').ok)
    assert(row('dismiss:queued:1').value == 'Cancel invitation')
    assert(not row('assign:queued:1'), 'a per-copy conversation entry remained on Current party')
    assert(mcm.party().assign('queued:1', 'person-1', 'Person 01'))
    assert(invoke('party:back').ok and invoke('tab:settings').ok)
    assert(row('voice').type == 'bool' and row('omniSteps') == nil)
    assert(row('subtitles').type == 'bool' and row('subtitles').value == true)
    assert(row('subtitleStyle').type == 'select' and row('subtitleStyle').value == 2)
    assert(row('subtitleStyle').defaultValue == 2 and row('subtitleStyle').capabilities.draft)
    assert(row('subtitleStyle').elements[1] == 'Above speaker' and row('subtitleStyle').elements[2] == 'Dialogue HUD')
    assert(row('voiceProvider').type == 'select' and row('voiceProvider').value == 1)
    assert(row('disappearingMessages') == nil)
    assert(row('battleReactions').type == 'bool' and row('battleReactions').value == true)
    assert(row('lootReactions').type == 'bool' and row('lootReactions').value == true)
    -- The retired follow-up question toggle is no longer offered.
    assert(row('followUpQuestions') == nil)
    assert(registered.applyBatch('manager', {{id = 'lootReactions', value = false}}).ok)
    assert(not manager.lootReactions())
    assert(registered.applyBatch('manager', {{id = 'battleReactions', value = false}}).ok)
    assert(not manager.battleReactions())
    local applied = registered.applyBatch('manager', {{id = 'voice', value = false}, {id = 'voiceProvider', value = 4}, {id = 'subtitleStyle', value = 1}})
    assert(applied.ok and applied.atomic and #applied.appliedIds == 3 and saved.omniSteps == 16)
    assert(saved.voiceProvider == 'convai')
    loaded = registered.loadMod('manager')
    assert(manager.subtitleStyle() == 'overhead' and row('subtitleStyle').value == 1)
    for _, invalid in ipairs({0, 3, '1', 'overhead', false}) do
      assert(not registered.applyBatch('manager', {{id = 'subtitles', value = false}, {id = 'subtitleStyle', value = invalid}}).ok)
      assert(manager.subtitleStyle() == 'overhead' and player.subtitles)
    end
    assert(registered.applyBatch('manager', {{id = 'subtitleStyle', value = 2}}).ok)
    assert(manager.subtitleStyle() == 'dialogue' and saved.voiceProvider == 'convai')
    assert(not registered.applyBatch('manager', {{id = 'voiceProvider', value = 5}}).ok)
    assert(not registered.applyBatch('manager', {{id = 'voice', value = true}, {id = 'omniSteps', value = 1}}).ok)
    assert(saved.voice == false and saved.voiceProvider == 'convai', 'retired quality changes partially applied')
    assert(not registered.applyBatch('manager', {{id = 'disappearingMessages', value = true}}).ok)
    assert(player.voice == false)
    drafts = true
    local before = reloads
    mcm.update(player, false); assert(reloads == before, 'external refresh must not erase MCM drafts')
    drafts = false
    mcm.update(player, true)
    assert(#spawned == 1 and members[1].profileKey == 'person-1')
    assert(invoke('settings:back').ok and invoke('tab:party').ok and row('dismiss:live:1'))
    mcm.shutdown(); assert(registered == nil)
  `);
});

test('MCM gaze controls use ordinary selectors, persist and reset without native refresh in Apply', () => {
  run(`${mcmFixture}
    assert(invoke('tab:settings').ok)
    for _,id in ipairs({'eyeContactHeight','headFollowStrength'}) do
      local setting=row(id)
      assert(setting and setting.type=='select' and setting.value==3 and setting.defaultValue==3)
      assert(setting.capabilities.draft and setting.capabilities.reset)
      assert(setting.color==nil and setting.indent==nil and setting.label:sub(1,1)~=' ')
    end
    assert(row('eyeContactHeight').elements[1]=='10 cm lower' and row('eyeContactHeight').elements[5]=='10 cm higher')
    assert(row('headFollowStrength').elements[1]=='Eyes only' and row('headFollowStrength').elements[4]=='More')
    local before=reloads
    local result=registered.applyBatch('manager',{{id='eyeContactHeight',value=5},{id='headFollowStrength',value=4}})
    assert(result.ok and result.atomic and not result.schemaChanged and reloads==before)
    assert(saved.eyeContactHeight==0.10 and saved.headFollowStrength==1.5)
    loaded=registered.loadMod('manager')
    assert(row('eyeContactHeight').value==5 and row('headFollowStrength').value==4)
    for _,invalid in ipairs({0,6,1.2,'1',false,math.huge,0/0}) do
      assert(not registered.applyBatch('manager',{{id='voice',value=false},{id='eyeContactHeight',value=invalid}}).ok)
      assert(manager.snapshot(player).settings.voice and saved.eyeContactHeight==0.10)
    end
    for _,invalid in ipairs({0,5,1.2,'1',false,math.huge,0/0}) do
      assert(not registered.applyBatch('manager',{{id='headFollowStrength',value=invalid}}).ok)
      assert(saved.headFollowStrength==1.5)
    end
    failSave=true
    assert(not registered.applyBatch('manager',{{id='eyeContactHeight',value=3},{id='headFollowStrength',value=3}}).ok)
    assert(saved.eyeContactHeight==0.10 and saved.headFollowStrength==1.5)
    failSave=false
    assert(registered.applyBatch('manager',{{id='eyeContactHeight',value=3},{id='headFollowStrength',value=3}}).ok)
    assert(saved.eyeContactHeight==0 and saved.headFollowStrength==1)
    loaded=registered.loadMod('manager')
    assert(row('eyeContactHeight').value==3 and row('headFollowStrength').value==3)
    drafts=true; mcm.update(player,false)
    assert(reloads==before,'ordinary gaze settings disturbed an open MCM draft')
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
    assert(invoke('models:back').ok and invoke('tab:party').ok and mcm.inspect().view == 'party')
  `);
});

test('native MCM action banner describes the queued invitation and leaves other pages and errors alone', () => {
  run(`${mcmFixture}
    assert(invoke('tab:characters').ok)
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
    assert(invoke('characters:back').ok and invoke('tab:settings').ok)
    assert(paint('Companion Manager', 'Completed: Settings') == 'Completed: Settings')
  `);
});

test('native MCM shows invitation preparation and keeps reserved copies editable until actual attachment', () => {
  run(`${mcmFixture}${invitationFixture}
    assert(invoke('tab:characters').ok)
    assert(invoke('invite:johnny-silverhand').ok)
    local id = party.list()[1].id
    assert(readiness.prepareCalls == 1 and readiness.jobs[id].profileKey == 'johnny-silverhand')
    assert(#spawned == 0 and party.count() == 1 and not row('party-count'))
    local rendered
    handlers.McmUiBegin({}, 'MCM', '', 'Mods', 'Companion Manager', 'Completed: Johnny Silverhand', 1, '', true, true, 0,
      function(title, subtitle, sidebar, content, message) rendered = message end)
    assert(rendered:lower():find('prepar', 1, true) and not rendered:find('Completed:', 1, true))
    assert(not rendered:find('joined your group', 1, true))
    assert(invoke('characters:back').ok and invoke('tab:party').ok)
    -- One row per copy: no status text, count, conversation entry or last action.
    assert(not row('party-count') and not row('feedback') and not row('state:' .. id) and not row('assign:' .. id))
    assert(row('dismiss:' .. id).value == 'Cancel invitation' and row('dismiss:' .. id).type == 'action')
    readiness.receipts[id] = {state = 'connecting'}
    readiness.update(); mcm.update(player, false)
    loaded = registered.loadMod('manager')
    assert(row('dismiss:' .. id) and not row('state:' .. id) and #spawned == 0)
    local revision = readiness.jobs[id].revision
    assert(party.assign(id, 'person-1', 'Person 01'))
    assert(readiness.prepareCalls == 2 and readiness.jobs[id].profileKey == 'person-1')
    assert(readiness.jobs[id].revision ~= revision)
    readiness.receipts[id] = {state = 'error', error = 'Preparation service unavailable'}
    loaded = registered.loadMod('manager')
    assert(row('dismiss:' .. id).description:find('Preparation service unavailable', 1, true))
    assert(row('error:' .. id).label:find('Preparation service unavailable', 1, true))
    assert(row('dismiss:' .. id).value == 'Cancel invitation')
    assert(invoke('dismiss:' .. id).ok and readiness.cancellations[id])
    assert(party.count() == 0 and not row('dismiss:' .. id) and not row('error:' .. id) and row('empty-party') and #spawned == 0)

    -- Phone and native actions receive the same queue and reserved capacity.
    assert(party.invite('johnny-silverhand'))
    id = party.list()[1].id
    readiness.receipts[id] = {state = 'ready'}
    loaded = registered.loadMod('manager')
    assert(row('dismiss:' .. id).value == 'Cancel invitation' and not row('state:' .. id) and not row('party-count'))
    mcm.update(player, false)
    assert(#spawned == 0, 'readiness created an actor while gameplay was paused')
    mcm.update(player, true)
    loaded = registered.loadMod('manager')
    assert(#spawned == 1 and row('dismiss:live:1').value == 'Dismiss' and not row('state:live:1'))
    assert(not party.message():find('joined your group', 1, true), 'accepted spawn was reported as joined')
    members[1].state = 'ready'; mcm.update(player, true)
    loaded = registered.loadMod('manager')
    assert(not row('state:live:1') and not row('feedback') and party.message():find('joined your group', 1, true))
    assert(row('dismiss:live:1').label == 'Johnny Silverhand #1', 'a copy row is its name and number')
  `);
});

test('Current party rows are a name, its number and Dismiss, in the same native row type as Back', () => {
  run(`${mcmFixture}
    api.spawn('johnny-silverhand'); api.spawn('johnny-silverhand'); api.spawn('person-1')
    for index, member in ipairs(members) do
      member.state = 'ready'; member.baseName = member.name
      if index < 3 then member.name = member.name .. ' #' .. index end
    end
    assert(invoke('tab:party').ok)
    local back = row('party:back')
    local names = {'Johnny Silverhand #1', 'Johnny Silverhand #2', 'Person 01 #3'}
    for index, id in ipairs({'dismiss:live:1', 'dismiss:live:2', 'dismiss:live:3'}) do
      local item = row(id)
      -- The same native action row as Back: one font role, one size, value on the right.
      assert(item.type == back.type and item.type == 'action' and item.value == 'Dismiss' and not item.disabled)
      assert(item.label == names[index], 'a row is the base name and its number: ' .. tostring(item.label))
    end
    local total = 0
    for _, section in ipairs(loaded.categories) do
      for _, item in ipairs(section.settings) do
        total = total + 1
        assert(not item.id:find('^state:') and not item.id:find('^assign') and item.id ~= 'feedback'
          and item.id ~= 'party-count', 'extra party row ' .. item.id)
        assert(not item.label:find('Following') and not item.value:find('Following') and not item.value:find('/ 8'))
      end
    end
    assert(total == 4, 'Back and one row per copy only: ' .. total)
    -- Joining and leaving never put a last-action line on the page.
    mcm.update(player, true); assert(not row('feedback'))
  `);
});

test('dismissing removes the row at once while paused, defers the despawn, and restores the row with the reason on failure', () => {
  run(`${mcmFixture}
    api.spawn('johnny-silverhand'); api.spawn('person-1')
    for _, member in ipairs(members) do member.state = 'ready'; member.baseName = member.name end
    assert(invoke('tab:party').ok)
    assert(row('dismiss:live:1') and row('dismiss:live:2'))
    -- Paused: the row is gone immediately, the copy is still in the world.
    mcm.update(player, false)
    assert(invoke('dismiss:live:1').ok)
    assert(not row('dismiss:live:1') and row('dismiss:live:2') and #members == 2, 'the row stayed or the copy left while paused')
    assert(mcm.party().count() == 1)
    mcm.update(player, false); assert(#members == 2 and not row('dismiss:live:1'))
    -- Gameplay resumes: the queued despawn runs once and the row stays gone.
    mcm.update(player, true)
    assert(#members == 1 and members[1].serial == 2)
    loaded = registered.loadMod('manager')
    assert(not row('dismiss:live:1') and row('dismiss:live:2') and not row('error:live:1'))
    -- The game refuses the next dismissal: the copy returns with the reason.
    local original = api.dismiss
    api.dismiss = function() return false, 'World unavailable' end
    assert(invoke('dismiss:live:2').ok and not row('dismiss:live:2') and row('empty-party'))
    mcm.update(player, true)
    loaded = registered.loadMod('manager')
    assert(#members == 1 and row('dismiss:live:2') and not row('empty-party'), 'a refused dismissal did not restore the row')
    assert(row('error:live:2').label:find('World unavailable', 1, true))
    assert(row('dismiss:live:2').description:find('World unavailable', 1, true))
    assert(mcm.inspect().party[1].dismissError == 'World unavailable')
    -- A later dismissal that succeeds clears the old reason.
    api.dismiss = original
    assert(invoke('dismiss:live:2').ok); mcm.update(player, true)
    loaded = registered.loadMod('manager')
    assert(#members == 0 and not row('dismiss:live:2') and not row('error:live:2') and row('empty-party'))
  `);
});

test('a phone dismissal and a menu dismissal share one optimistic path and one companion limit that is never displayed', () => {
  run(`${mcmFixture}
    for _ = 1, 8 do api.spawn('johnny-silverhand') end
    for _, member in ipairs(members) do member.state = 'ready' end
    assert(invoke('tab:characters').ok)
    -- A full party never shows a limit; the invitation is refused with a message.
    local invite = row('invite:johnny-silverhand')
    assert(not invite.disabled and invite.type == 'action')
    local refused = registered.invokeAction('manager', 'invite:johnny-silverhand', {})
    assert(refused.ok == false and not refused.error:find('8', 1, true) and not refused.error:lower():find('eight', 1, true), refused.error)
    assert(not (loaded.categories[1].description or ''):lower():find('eight', 1, true))
    for _, section in ipairs(loaded.categories) do
      assert(not (section.description or ''):lower():find('eight', 1, true) and not (section.description or ''):find('8', 1, true))
    end
    assert(invoke('characters:back').ok and invoke('tab:party').ok)
    assert(row('dismiss:live:8'))
    local accepted, message, dismissedId = mcm.party().dismissCharacter('johnny-silverhand')
    assert(accepted == true and dismissedId == 'live:8' and #members == 8)
    loaded = registered.loadMod('manager')
    assert(not row('dismiss:live:8') and row('dismiss:live:7'), 'a phone dismissal left its row on the page')
    mcm.update(player, true); assert(#members == 7)
    -- The freed place is usable at once.
    assert(invoke('party:back').ok and invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
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
    const nativeModel = readFileSync(path.join(root, '..', 'ModConfigurationMenu', 'mcm_ui', 'mcm_model.lua'), 'utf8');
    const filterStart = nativeModel.indexOf('function Model:flattenSettings(mod)');
    assert(filterStart >= 0, 'installed MCM settings filter is unavailable');
    const nativeFilter = nativeModel.slice(filterStart, nativeModel.indexOf('\nend', filterStart) + 4);
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
      local Model, Text = {}, {casefold = function(value) return tostring(value or ''):lower() end}
      ${nativeFilter}
      GetMod = function() return actual end
      mcm.install()
      assert(actual.refreshIndex())
      local key = 'cyberpunk-convai:manager'
      local function backSurvivesSearch(back, query)
        handlers.McmUiEmitSearch(nil, 'content', query)
        for _ = 1, 6 do mcm.update(player, false) end
        local renderer = {runtime = {state = {api = actual, settingsSortMode = 'file',
          searchQueries = {content = query}}, safe = function(_, value) return tostring(value or '') end}}
        for _, value in ipairs(Model.flattenSettings(renderer, {key = key})) do
          if value.kind == 'setting' and value.setting.id == key .. ':' .. back then return end
        end
        error('MCM filtered the only parent Back action: ' .. back)
      end
      assert(actual.openMod(key))
      assert(actual.invokeAction(key .. ':tab:characters'))
      backSurvivesSearch('characters:back', 'no matching character')
      handlers.McmUiEmitSearch(nil, 'content', '')
      for _ = 1, 6 do mcm.update(player, false) end
      assert(actual.invokeAction(key .. ':invite:johnny-silverhand'))
      assert(#spawned == 0 and #mcm.inspect().party == 1 and readiness.prepareCalls == 1)
      assert(actual.getValue(key .. ':party-count') == nil)
      assert(actual.invokeAction(key .. ':characters:back'))
      assert(actual.invokeAction(key .. ':tab:party'))
      assert(actual.getValue(key .. ':party-count') == nil and actual.getValue(key .. ':state:queued:1') == nil)
      assert(actual.getValue(key .. ':dismiss:queued:1') == 'Cancel invitation')
      assert(actual.getValue(key .. ':assign:queued:1') == nil)
      readiness.receipts['queued:1'] = {state = 'connecting'}
      assert(actual.reloadMod(key) and actual.getValue(key .. ':dismiss:queued:1') == 'Cancel invitation')
      assert(mcm.party().assign('queued:1', 'person-1', 'Person 01'))
      assert(readiness.prepareCalls == 2 and readiness.jobs['queued:1'].profileKey == 'person-1')
      readiness.receipts['queued:1'] = {state = 'ready'}
      assert(actual.reloadMod(key) and actual.getValue(key .. ':dismiss:queued:1') == 'Cancel invitation')
      mcm.update(player, false); assert(#spawned == 0)
      assert(actual.invokeAction(key .. ':party:back'))
      assert(actual.invokeAction(key .. ':tab:settings'))
      publishMemory(2, {{profileKey = 'johnny-silverhand'}, {profileKey = 'person-20'}})
      assert(actual.reloadMod(key))
      assert(actual.getValue(key .. ':memory') == 'Manage' and actual.getValue(key .. ':memory-count') == nil)
      assert(actual.setDraft(key .. ':voice', false))
      assert(actual.getValue(key .. ':omniSteps') == nil)
      assert(actual.setDraft(key .. ':voiceProvider', 4))
      assert(actual.setDraft(key .. ':subtitleStyle', 1))
      assert(actual.setDraft(key .. ':battleReactions', false))
      assert(actual.getValue(key .. ':eyeContactHeight') == 3 and actual.getValue(key .. ':headFollowStrength') == 3)
      assert(actual.setDraft(key .. ':eyeContactHeight', 5))
      assert(actual.setDraft(key .. ':headFollowStrength', 4))
      assert(manager.gazeSettings().eyeContactHeight == 0 and manager.gazeSettings().headFollowStrength == 1)
      assert(actual.getValue(key .. ':developerMode') == false)
      assert(actual.setDraft(key .. ':developerMode', true))
      assert(not manager.developerMode(), 'developer draft must not change runtime feedback')
      assert(actual.invokeAction(key .. ':settings:back') == false)
      assert(actual.invokeAction(key .. ':memory') == false and memoryWrites() == 0)
      assert(mcm.inspect().view == 'settings', 'a pending draft allowed submenu navigation')
      local ok, err = actual.apply(key)
      assert(ok, err)
      assert(actual.getValue(key .. ':voice') == false and actual.getValue(key .. ':omniSteps') == nil)
      assert(manager.snapshot(player).settings.omniSteps == 16 and not actual.hasDrafts(key))
      assert(actual.getValue(key .. ':voiceProvider') == 4)
      assert(manager.snapshot(player).settings.voiceProvider == 'convai')
      assert(actual.getValue(key .. ':subtitleStyle') == 1 and manager.subtitleStyle() == 'overhead')
      assert(not manager.battleReactions() and actual.getValue(key .. ':battleReactions') == false)
      assert(manager.developerMode() and actual.getValue(key .. ':developerMode') == true)
      assert(actual.getValue(key .. ':eyeContactHeight') == 5 and actual.getValue(key .. ':headFollowStrength') == 4)
      assert(manager.gazeSettings().eyeContactHeight == 0.10 and manager.gazeSettings().headFollowStrength == 1.5)
      -- Exercise the shipped public draft bus/getValue seam, not a synthetic
      -- native selector hook. Preparation is immediate, settings are not.
      function controller:GetRootWidget() return nil end
      handlers.McmUiSetContentTitle(controller, 'Companion Manager')
      assert(actual.setDraft(key .. ':voiceProvider', 3))
      assert(files['runtime/voice-preview.json'] == nil, 'draft callback performed filesystem IO')
      mcm.update(player, false)
      local preview = json.decode(files['runtime/voice-preview.json'])
      assert(preview.active and preview.provider == 'pocket' and preview.omniSteps == nil and preview.steps == nil)
      assert(manager.snapshot(player).settings.voiceProvider == 'convai')
      assert(actual.revert(key)); mcm.update(player, false)
      assert(not json.decode(files['runtime/voice-preview.json']).active)
      assert(manager.snapshot(player).settings.voiceProvider == 'convai')
      assert(actual.setModDraftsToDefaults(key)); mcm.update(player, false)
      preview = json.decode(files['runtime/voice-preview.json'])
      assert(preview.active and preview.provider == 'omni' and preview.omniSteps == 16 and preview.steps == nil, 'defaults preview OmniVoice 16 steps')
      assert(actual.revert(key)); mcm.update(player, false)
      assert(not json.decode(files['runtime/voice-preview.json']).active)
      assert(actual.setDraft(key .. ':voiceProvider', 1)); mcm.update(player, false)
      preview = json.decode(files['runtime/voice-preview.json'])
      assert(preview.active and preview.provider == 'omni' and preview.omniSteps == 16)
      assert(manager.snapshot(player).settings.voiceProvider == 'convai')
      assert(actual.setDraft(key .. ':voiceProvider', 2)); mcm.update(player, false)
      preview = json.decode(files['runtime/voice-preview.json'])
      assert(preview.active and preview.provider == 'omni' and preview.omniSteps == 32)
      assert(actual.apply(key)); mcm.update(player, false)
      assert(not json.decode(files['runtime/voice-preview.json']).active)
      assert(manager.snapshot(player).settings.voiceProvider == 'omni' and manager.snapshot(player).settings.omniSteps == 32)
      assert(actual.setDraft(key .. ':voiceProvider', 4)); assert(actual.apply(key)); mcm.update(player, false)
      assert(manager.snapshot(player).settings.voiceProvider == 'convai')
      assert(actual.setDraft(key .. ':subtitles', false))
      assert(actual.setDraft(key .. ':developerMode', false))
      assert(actual.invokeAction(key .. ':permissions') == false)
      assert(actual.revert(key) and actual.getValue(key .. ':subtitles') == true)
      assert(manager.developerMode() and actual.getValue(key .. ':developerMode') == true)
      assert(actual.resetDraft(key .. ':eyeContactHeight') and actual.resetDraft(key .. ':headFollowStrength'))
      assert(manager.gazeSettings().eyeContactHeight == 0.10 and manager.gazeSettings().headFollowStrength == 1.5)
      assert(actual.apply(key))
      assert(actual.getValue(key .. ':eyeContactHeight') == 3 and actual.getValue(key .. ':headFollowStrength') == 3)
      assert(manager.gazeSettings().eyeContactHeight == 0 and manager.gazeSettings().headFollowStrength == 1)
      assert(actual.invokeAction(key .. ':permissions') and mcm.inspect().view == 'permissions')
      assert(actual.getValue(key .. ':tab:settings') == nil and actual.getValue(key .. ':permissions:back') == 'Back')
      assert(actual.invokeAction(key .. ':permissions:back') and mcm.inspect().view == 'settings')
      assert(actual.invokeAction(key .. ':memory') and mcm.inspect().view == 'memory')
      assert(actual.getValue(key .. ':memory-count') == '2' and actual.getValue(key .. ':tab:settings') == nil)
      assert(actual.invokeAction(key .. ':memory:choose') and mcm.inspect().view == 'memory-characters')
      assert(actual.getValue(key .. ':tab:settings') == nil and actual.getValue(key .. ':memory:back') == 'Back')
      backSurvivesSearch('memory:back', 'no matching memories')
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
      assert(actual.invokeAction(key .. ':memory:settings'))
      assert(actual.invokeAction(key .. ':settings:back'))
      assert(actual.invokeAction(key .. ':tab:party'))
      assert(actual.invokeAction(key .. ':dismiss:queued:1'))
      assert(#mcm.inspect().party == 0 and #spawned == 0 and readiness.cancellations['queued:1'])
      assert(actual.invokeAction(key .. ':party:back'))
      assert(actual.invokeAction(key .. ':tab:models'))
      for _ = 1, 126 do mcm.update(player, false) end
      backSurvivesSearch('models:back', 'no matching model')
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
    assert(saved.keep == 'preserved' and json.decode(files['runtime/settings.json']) == saved)
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

test('OmniVoice 16 steps is the default while saved choices migrate to the nearest of the four voices', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved.voiceProvider == 'omni' and saved.omniSteps == 16)
    assert(saved.voice == true and saved.subtitles == true)
    for _, oldProvider in ipairs({'missing', 'hybrid', 'omni', 'omnivoice', 'pocket', 'pocket-student', 'Pocket-Base', 'convai', 'invalid', 'teacher', '', false, 7}) do
      seed = {version = 2, voice = false, subtitles = false, subtitleStyle = 'overhead',
        omniSteps = 16, followUpQuestions = true, battleReactions = false, lootReactions = false,
        enabledByKey = {}, future = {keep = 'unchanged'}}
      if oldProvider ~= 'missing' then seed.voiceProvider = oldProvider end
      for _, profile in ipairs(profiles) do seed.enabledByKey[profile.key] = true end
      seed.enabledByKey['johnny-silverhand'] = false
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      local expected = ({convai = 'convai', pocket = 'pocket', ['pocket-student'] = 'pocket', ['Pocket-Base'] = 'pocket'})[oldProvider]
        or 'omni'
      local state = manager.snapshot(player).settings
      assert(state.voiceProvider == expected and saved.voiceProvider == expected)
      assert(state.omniSteps == 16 and saved.omniSteps == 16)
      assert(not state.voice and not state.subtitles and state.subtitleStyle == 'overhead')
      assert(state.followUpQuestions and not state.battleReactions and not state.lootReactions)
      assert(not state.enabledByKey['johnny-silverhand'] and saved.future.keep == 'unchanged')
      manager.reset(); manager.prepare(player)
      assert(manager.snapshot(player).settings.voiceProvider == expected)
      assert(manager.snapshot(player).settings.omniSteps == 16)
    end
    for _, oldSteps in ipairs({'missing', 0, 8, '16', true, false, 16, 32}) do
      seed = {version = 2, voiceProvider = 'hybrid', enabledByKey = {}, future = {keep = 'unchanged'}}
      if oldSteps ~= 'missing' then seed.omniSteps = oldSteps end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      -- Only an explicit saved 32 stays 32; missing or invalid becomes the default 16.
      local expected = oldSteps == 32 and 32 or 16
      assert(saved.voiceProvider == 'omni' and saved.omniSteps == expected)
      assert(manager.snapshot(player).settings.omniSteps == expected and saved.future.keep == 'unchanged')
    end
    assert(manager.applySettings(player, {voiceProvider = 'convai', omniSteps = 16}))
    assert(manager.applySettings(player, {voiceProvider = 'hybrid'}))
    assert(saved.voiceProvider == 'omni' and saved.omniSteps == 16, 'legacy API provider lost its quality')
    local before = saved
    assert(not manager.applySettings(player, {voiceProvider = 'convai', omniSteps = 8}))
    assert(saved == before and manager.snapshot(player).settings.voiceProvider == 'omni')
  `);
});

test('party uses actual copy serials, assigns and clears profiles, reports asynchronous failures, and enforces the party limit', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    for _ = 1, 8 do request('spawn:person-1') end
    assert(#members == 8 and #spawned == 8)
    request('spawn:person-1')
    assert(#members == 8 and #spawned == 8 and player.feedback:find('no room', 1, true))
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
  function system:IsManaged(id) return entities[id.hash] ~= nil end
  function system:IsTagged(id, tag) return self:IsManaged(id) and tag == 'CyberpunkConvaiCompanion' end
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
  ${flatSpatial}
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

test('Developer mode is a cached default-Off choice and persists only after an atomic successful save', () => {
  run(`${managerFixture}
    assert(not manager.developerMode())
    manager.configure(api, profiles)
    assert(manager.snapshot(nil).settings.developerMode == false)
    assert(manager.applySettings(nil, {developerMode = false}))
    local open = io.open
    io.open = function() error('cached Developer mode attempted filesystem work') end
    Game = {GetPlayer = function() error('cached Developer mode queried a native handle') end}
    for i = 1, 20 do assert(not manager.developerMode()) end
    io.open = open
    failSave = true
    assert(not manager.applySettings(nil, {developerMode = true, followUpQuestions = true}))
    assert(not manager.developerMode() and not manager.followUpQuestions() and not saved.developerMode)
    failSave = false
    assert(manager.applySettings(nil, {developerMode = true}))
    assert(manager.developerMode() and saved.developerMode == true)
    failSave = true
    assert(not manager.applySettings(nil, {developerMode = false}))
    assert(manager.developerMode() and saved.developerMode == true)
    failSave = false
    assert(not manager.applySettings(nil, {developerMode = 'on'}))
    assert(manager.developerMode())
    manager = (function() ${managerSource} end)()
    manager.configure(api, profiles)
    assert(manager.snapshot(nil).settings.developerMode == true and manager.developerMode())
    assert(manager.applySettings(nil, {developerMode = false}))
    manager.reset()
    assert(manager.snapshot(nil).settings.developerMode == false and not manager.developerMode())
  `);
});

test('MCM puts Developer mode in Development and changing it updates existing party feedback without native work', () => {
  run(`${mcmFixture}
    local trip = {active = true, generation = 4, phase = 'waiting-for-player'}
    api.chauffeurSnapshot = function()
      local result = {}; for key, value in pairs(trip) do result[key] = value end; return result
    end
    local queue = mcm.party()
    queue.bind('player-1'); queue.flush(); assert(#queue.takeNotices() == 0)
    assert(invoke('tab:settings').ok)
    local item = assert(row('developerMode'))
    assert(item.label == 'Developer mode' and item.type == 'bool' and item.value == false)
    assert(item.defaultValue == false and item.capabilities.draft and item.indent == nil)
    local section
    for _, category in ipairs(loaded.categories) do if category.id == 'development' then section = category end end
    assert(section and section.name == 'Development' and section.settings[1].id == 'developerMode')
    assert(registered.applyBatch('manager', {{id = 'developerMode', value = true}}).ok)
    local getter = Game.GetPlayer
    Game.GetPlayer = function() error('Developer feedback queried a native player') end
    queue.flush(); queue.flush()
    local notices = queue.takeNotices()
    assert(#notices == 1 and notices[1].message:find('Get in the passenger seat', 1, true))
    Game.GetPlayer = getter
    failSave = true
    assert(not registered.applyBatch('manager', {{id = 'developerMode', value = false}}).ok)
    assert(manager.developerMode() and saved.developerMode == true)
    assert(not registered.applyBatch('manager', {{id = 'developerMode', value = 'true'}}).ok)
    failSave = false
    assert(registered.applyBatch('manager', {{id = 'developerMode', value = false}}).ok)
    trip.phase = 'driving'; queue.flush(); assert(#queue.takeNotices() == 0)
    assert(registered.applyBatch('manager', {{id = 'developerMode', value = true}}).ok)
    queue.flush(); queue.flush(); notices = queue.takeNotices()
    assert(#notices == 1 and notices[1].message:find('driving to the selected waypoint', 1, true))
    assert(#spawned == 0)
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

test('a voice that could not run is announced once in gameplay, again only after a new fallback', () => {
  run(`${mcmFixture}${managerPopupFixture}
    local state = {state = 'ready', provider = 'pocket', requestedProvider = 'omni', requestedOmniSteps = 16,
      omniSteps = 32, routedProfiles = {'johnny-silverhand'}, fallback = {from = 'omni', to = 'pocket'},
      updated = popupClock * 1000}
    jsonFixtures['voice-runtime'] = state
    files['runtime/local-voice-state.json'] = 'voice-runtime'
    popupTick(false); popupTick(false)
    assert(#popups == 0, 'a paused menu consumed the one fallback notice')
    popupTick(true)
    assert(#popups == 1 and popups[1] == 'OmniVoice 16 steps is unavailable. Companions are using Pocket TTS instead.', popups[1])
    for _ = 1, 6 do popupTick(true) end
    assert(#popups == 1, 'the same fallback was announced again')
    -- Omni recovers (the player chose it again and it loaded), then Pocket fails too.
    state.fallback, state.provider = nil, 'omni'
    for _ = 1, 3 do popupTick(true) end
    assert(#popups == 1)
    state.fallback, state.provider, state.routedProfiles = {from = 'pocket', to = 'convai'}, 'convai', {}
    for _ = 1, 3 do popupTick(true) end
    assert(#popups == 2 and popups[2] == 'Pocket TTS is unavailable. Companions are using Convai cloud voice instead.', popups[2])
    assert(manager.voiceLabel('omni', 32) == 'OmniVoice 32 steps' and manager.voiceLabel('omni', 16) == 'OmniVoice 16 steps')
    assert(manager.voiceLabel('pocket') == 'Pocket TTS' and manager.voiceLabel('convai') == 'Convai cloud voice')
  `);
});
