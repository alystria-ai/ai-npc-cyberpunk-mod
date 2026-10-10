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
  // The CET module environment has no _G: match it so that class of bug fails here.
  const status = lauxlib.luaL_dostring(state, to_luastring('_G = nil; ' + uiLocaleBootstrap + code));
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

test('MCM party invitations reserve distinct copies, cancel without spawning and flush only once', () => {
  run(`${managerFixture}
    manager.configure(api, profiles)
    local queue = (function() ${queueSource} end)().new(api)
    assert(queue.invite('johnny-silverhand') == false)
    queue.bind('player-1')
    -- The party has no size limit: well past the eight formation places every invitation is accepted.
    for _ = 1, 12 do assert(queue.invite('johnny-silverhand')) end
    assert(#spawned == 0 and queue.count() == 12 and #queue.list() == 12)
    assert(queue.invite('person-1') and queue.count() == 13)
    local first, second = queue.list()[1].id, queue.list()[2].id
    assert(first ~= second and queue.list()[1].state == 'queued')
    assert(queue.dismiss(first) and queue.count() == 12 and #spawned == 0)
    assert(queue.assign(second, 'person-1', 'Person 01'))
    queue.flush()
    assert(#spawned == 12 and #members == 12 and members[1].profileKey == 'person-1')
    queue.flush(); assert(#spawned == 12, 'menu operation replayed')
    queue.bind(nil); queue.bind('player-2'); queue.flush()
    assert(#spawned == 12)
  `);
});

test('MCM dismissals free planned places, can be undone at any party size and cleanly report world failures', () => {
  run(`${managerFixture}
    manager.configure(api, profiles)
    local queue = (function() ${queueSource} end)().new(api)
    queue.bind('player-1')
    for _ = 1, 8 do api.spawn('johnny-silverhand') end
    local id = queue.list()[1].id
    assert(queue.dismiss(id) and #members == 8 and queue.count() == 7)
    assert(queue.invite('person-1') and queue.count() == 8)
    -- A dismissal can be undone however large the party is.
    assert(queue.undoDismiss(id) == true and queue.count() == 9)
    assert(queue.list()[1].state ~= 'leaving')
    assert(queue.dismiss(id) and queue.count() == 8)
    assert(queue.list()[1].state == 'leaving')
    queue.flush()
    assert(#members == 8 and members[8].key == 'person-1')
    assert(queue.dismiss('live:123456') == false)
    queue.dismiss(queue.list()[1].id)
    local oldDismiss = api.dismiss
    api.dismiss = function() return false, 'World unavailable' end
    local oldSpawn = api.spawn
    api.spawn = function() return nil, 'The game could not create a copy of this model.' end
    queue.invite('person-2')
    queue.flush()
    assert(#members == 8 and #spawned == 9)
    assert(queue.list()[9].state == 'failed' and queue.message():find('could not create', 1, true))
    queue.flush(); assert(#spawned == 9, 'failed request must not retry every frame')
    api.spawn = oldSpawn
    api.dismiss = oldDismiss
    queue.bind(nil); assert(#queue.list() == 8, 'loading a save cancels pending work')
  `);
});

test('MCM settings apply as one saved transaction and leave playback unchanged on a save failure', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.snapshot(player)
    assert(manager.snapshot(player).settings.disappearingMessages == nil)
    assert(manager.subtitleStyle() == 'dialogue' and saved.subtitleStyle == 'dialogue')
    assert(manager.snapshot(player).settings.voiceProvider == 'pocket', 'default voice is Pocket TTS')
    assert(manager.snapshot(player).settings.omniSteps == 16 and saved.omniSteps == 16)
    assert(manager.snapshot(player).settings.omniReference == 'long' and saved.omniReference == 'long')
    assert(manager.snapshot(player).settings.keepPreparedVoices == true and saved.keepPreparedVoices == true)
    assert(manager.battleReactions() and manager.snapshot(player).settings.battleReactions)
    assert(manager.lootReactions() and manager.snapshot(player).settings.lootReactions)
    assert(manager.followUpQuestions == nil and manager.snapshot(player).settings.followUpQuestions == nil)
    assert(manager.applySettings(player, {lootReactions = false}))
    assert(not manager.lootReactions() and saved.lootReactions == false)
    assert(manager.applySettings(player, {lootReactions = 'on'}) == false)
    assert(manager.applySettings(player, {battleReactions = false}))
    assert(not manager.battleReactions() and saved.battleReactions == false)
    assert(manager.applySettings(player, {battleReactions = 'on'}) == false)
    assert(manager.applySettings(player, {voice = false, subtitleStyle = 'overhead', voiceProvider = 'convai', enabledByKey = {['johnny-silverhand'] = false}}))
    assert(player.voice == false and saved.omniSteps == 16 and not manager.profileEnabled('johnny-silverhand'))
    assert(saved.disappearingMessages == nil)
    assert(saved.followUpQuestions == nil)
    failSave = true
    assert(manager.applySettings(player, {voice = true, subtitles = false, subtitleStyle = 'dialogue', voiceProvider = 'pocket'}) == false)
    local values = manager.snapshot(player).settings
    assert(values.voice == false and values.subtitles == true and values.omniSteps == 16)
    assert(player.voice == false and player.subtitles == true)
    assert(values.disappearingMessages == nil)
    assert(values.followUpQuestions == nil)
    assert(values.voiceProvider == 'convai')
    assert(values.subtitleStyle == 'overhead' and manager.subtitleStyle() == 'overhead')
    failSave = false
    assert(manager.applySettings(player, {voice = true, omniSteps = 8}) == false)
    assert(manager.applySettings(player, {voice = true, omniReference = 'medium'}) == false)
    assert(manager.applySettings(player, {voice = true, keepPreparedVoices = 'yes'}) == false)
    assert(manager.applySettings(player, {enabledByKey = {unknown = true}}) == false)
    assert(manager.applySettings(player, {disappearingMessages = 'yes'}) == false)
    assert(not manager.snapshot(player).settings.voice)
    assert(manager.applySettings(player, {voiceProvider = 'unknown'}) == false)
    assert(manager.applySettings(nil, {voice = true}))
    manager.reset(); manager.snapshot(player); assert(player.voice == true)
    assert(manager.subtitleStyle() == 'overhead', 'failed save or reset replaced explicit subtitle choice')
  `);
});

test('a saved retired follow-up setting loads fine, is dropped from the file and never reaches the snapshot', () => {
  run(`${managerFixture}
    for _, savedValue in ipairs({'missing', 'on', 0, true, false}) do
      seed = {version = 2, voice = false, subtitles = false, subtitleStyle = 'dialogue',
        voiceProvider = 'convai', omniSteps = 16, battleReactions = false, lootReactions = false,
        disappearingMessages = true, enabledByKey = {}, future = {keep = 'unchanged'}}
      for _, profile in ipairs(profiles) do seed.enabledByKey[profile.key] = true end
      if savedValue ~= 'missing' then seed.followUpQuestions = savedValue end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles)
      assert(manager.followUpQuestions == nil)
      local state = manager.snapshot(player).settings
      assert(state.followUpQuestions == nil)
      assert(not state.voice and not state.subtitles and state.voiceProvider == 'convai' and state.omniSteps == 16)
      assert(not state.battleReactions and not state.lootReactions and state.disappearingMessages == nil)
      if savedValue ~= 'missing' then
        assert(saved and saved.followUpQuestions == nil and saved.future.keep == 'unchanged', 'the retired key must be dropped and re-saved')
      end
      manager.reset(); manager.configure(api, profiles)
      assert(manager.snapshot(player).settings.followUpQuestions == nil)
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

test('a quiet invitation or dismissal (the development probes) posts no joined or dismissed notice, an ordinary one still does', () => {
  run(`${managerFixture}
    manager.configure(api, profiles)
    local queue = (function() ${queueSource} end)().new(api)
    queue.bind('player-1')
    queue.invite('johnny-silverhand', {quiet = true}); queue.flush()
    members[1].state = 'ready'; queue.flush()
    assert(#queue.takeNotices() == 0, 'a probe copy joins without a notice')
    queue.invite('person-1'); queue.flush()
    members[2].state = 'ready'; queue.flush()
    local joined = queue.takeNotices()
    assert(#joined == 1 and joined[1].message:find('joined your group', 1, true), 'an ordinary invitation still reports')
    local function dismissed(id, quiet)
      assert(queue.dismiss(id, quiet)); queue.flush()
      local count = 0
      for _, notice in ipairs(queue.takeNotices()) do if notice.message:find('dismissed', 1, true) then count = count + 1 end end
      return count
    end
    local list = queue.list()
    assert(dismissed(list[1].id, true) == 0, 'a quiet dismissal posts nothing')
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
  local bottomActions = {}
  local controller = {nativeIdentity = 101,
    McmUiEmitSearch = function(_, context, value) handlers.McmUiEmitSearch(nil, context, value) end,
    McmUiGetLayoutMetric = function(_, metric) return ({[10] = 40, [11] = 400, [27] = 1000})[metric] or -1 end,
    McmUiAddBottomActionAt = function(_, id, label, x, y, width, active)
      bottomActions[#bottomActions + 1] = {id = id, label = label, x = x, y = y, width = width, active = active}
    end}
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
        assert(#section.settings > 0, 'an empty section is left on the page')
        for _, item in ipairs(section.settings) do
          if item.value == 'Back' then count = count + 1; assert(item.id == back) end
          assert(item.label:sub(1, 1) ~= ' ' and item.indent == nil, 'label has artificial indentation')
        end
      end
      -- Back is the bottom-bar button, not a row; its callback belongs to this page.
      assert(count == 0, 'Back is still a row of the list')
      assert(mcm.inspect().back.id == back and mcm.inspect().backMode == 'bottom')
      assert(not row('apply-hint'), 'a status row is on the page')
      assert(not category('party-status') and not row('party-count') and not row('feedback'),
        'party status, the limit or the last action leaked onto the page')
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
      if effective > 6 then effective = 1 elseif effective < 1 then effective = 6 end
    end
    local emit = function(forward)
      if handlers.McmUiEmitStep then return handlers.McmUiEmitStep(selector, forward, wrapped) end
      return wrapped(forward)
    end
    emit(false)
    assert(effective == 1 and forwarded == 0, 'left at Pocket TTS must not wrap right')
    for _, expected in ipairs({2, 3, 4, 5, 6}) do emit(true); assert(effective == expected and forwarded == expected - 1) end
    emit(true)
    assert(effective == 6 and forwarded == 5, 'right at Convai must not wrap left')
    for _, expected in ipairs({5, 4, 3, 2, 1}) do emit(false); assert(effective == expected and forwarded == 11 - expected) end
    emit(false); assert(effective == 1 and forwarded == 10, 'left at Pocket TTS must not wrap right')
    assert(row('voiceProvider').defaultValue == 1)
    local elements = row('voiceProvider').elements
    assert(#elements == 6 and elements[1] == 'Pocket · Performance')
    assert(elements[2] == 'OmniVoice · Balanced' and elements[3] == 'OmniVoice · Quality')
    assert(elements[4] == 'OmniVoice · High Quality' and elements[5] == 'OmniVoice · Ultra Quality')
    assert(elements[6] == 'Convai · Cloud voice')
    assert(row('omniSteps') == nil and row('omniReference') == nil, 'retired quality steps remain in the active menu')
    assert(row('keepPreparedVoices').type == 'bool' and row('keepPreparedVoices').value == true
      and row('keepPreparedVoices').defaultValue == true, 'Keep prepared voices is on by default')
    handlers.McmUiConfigureBase(selector, controller, 'another-mod:settings:voiceProvider')
    emit(false)
    assert(effective == 6 and forwarded == 11, 'foreign selector behavior must pass through')
  `);
});

test('local voice previews carry the effective six-choice draft and cancel on Revert, Apply or leaving the page', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(manager.applySettings(player, {voiceProvider = 'convai'}))
    local committed = saved
    local preview = (function() ${voicePreviewSource} end)().new({now = function() return 1000 end})
    -- Select order: 1 Pocket Performance, 2 Omni Balanced (16 short), 3 Omni Quality (16 long), 4 Omni High Quality (32 short), 5 Omni Ultra Quality (32 long), 6 Convai Cloud voice.
    local effective, pending, callback, inCallback, reads = 3, true, nil, false, 0
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
    assert(lease.active and lease.provider == 'omni' and lease.omniSteps == 16 and lease.omniReference == 'long'
      and lease.steps == nil and reads == 1)
    assert(saved == committed and manager.snapshot(player).settings.voiceProvider == 'convai')
    update(); assert(reads == 1, 'unchanged draft was queried again in the same poll interval')
    effective, pending = 6, false; changed()
    local cancelled = update()
    assert(not cancelled.active and cancelled.owner == lease.owner and cancelled.sequence > lease.sequence)
    assert(saved == committed and manager.snapshot(player).settings.voiceProvider == 'convai')
    effective, pending = 3, true; changed(); lease = update()
    assert(lease.active and lease.provider == 'omni' and lease.omniSteps == 16 and lease.steps == nil)
    effective = 5; changed(); local qualityPreview = update()
    assert(qualityPreview.active and qualityPreview.provider == 'omni' and qualityPreview.omniSteps == 32
      and qualityPreview.omniReference == 'long')
    assert(qualityPreview.sequence > lease.sequence, 'same-second quality change did not reach the backend')
    effective = 4; changed(); local referencePreview = update()
    assert(referencePreview.active and referencePreview.omniSteps == 32 and referencePreview.omniReference == 'short')
    assert(referencePreview.sequence > qualityPreview.sequence, 'same-second reference change did not reach the backend')
    assert(saved == committed and manager.snapshot(player).settings.voiceProvider == 'convai')
    effective = 3; changed(); lease = update()
    assert(lease.active and lease.omniSteps == 16 and lease.omniReference == 'long')
    assert(manager.applySettings(player, {voiceProvider = 'omni', omniSteps = 16, omniReference = 'long'})); pending = false; changed()
    assert(not update().active and manager.snapshot(player).settings.voiceProvider == 'omni')
    pending = true; changed(); assert(not update().active, 'an unrelated draft re-warmed the saved choice')
    effective = 2; changed(); lease = update()
    assert(lease.active and lease.omniReference == 'short' and preview.inspect().omniSteps == 16
      and preview.inspect().omniReference == 'short', 'a reference-only change was not previewed')
    effective = 5; changed(); assert(update().active and preview.inspect().omniSteps == 32)
    effective = 1; changed(); lease = update()
    assert(lease.active and lease.provider == 'pocket' and lease.omniSteps == nil and lease.omniReference == nil,
      'Pocket preview retained stale Omni quality')
    effective, pending = 3, false; changed(); assert(not update().active)
    assert(manager.snapshot(player).settings.voiceProvider == 'omni' and manager.snapshot(player).settings.omniSteps == 16)
    assert(manager.applySettings(player, {voiceProvider = 'convai'})); pending = true; changed()
    effective = 1
    lease = update(); assert(lease.active and lease.provider == 'pocket')
    assert(not update(false).active and manager.snapshot(player).settings.voiceProvider == 'convai')
    changed(); assert(update().active)
    preview.shutdown()
    assert(not json.decode(files['runtime/voice-preview.json']).active and callback == nil)
    assert(manager.snapshot(player).settings.voiceProvider == 'convai')
  `);
});

test('Back joins the bottom button row, the status line moves to the top left, and rows return if the bar rejects Back', () => {
  run(`${mcmFixture}
    CName = {new = function(value) return value end}
    NameToString = function(value) return value end
    IsDefined = function(value) return value ~= nil end
    local function widget(name, left, top, width, height, children)
      local w = {name = name, margin = {left = left, top = top, right = 0, bottom = 0}, width = width, height = height,
        children = children or {}}
      function w:GetName() return self.name end
      function w:GetMargin() return {left = self.margin.left, top = self.margin.top, right = 0, bottom = 0} end
      function w:SetMargin(value) self.margin = {left = value.left, top = value.top, right = 0, bottom = 0} end
      function w:GetWidth() return self.width end
      function w:GetHeight() return self.height end
      function w:GetNumChildren() return #self.children end
      function w:GetWidgetByIndex(index) return self.children[index + 1] end
      function w:SetText(value) self.text = value end
      function w:SetHeight(v) self.height = v end
      function w:SetVerticalAlignment(v) self.valign = v end
      function w:GetFontSize() return self.fontSize or 23 end
      function w:SetWidth(v) self.width = v end
      function w:SetWrapping(on, at) self.wrap = {on, at} end
      function w:GetParentWidget() return self.parent end
      function w:Reparent(parent)
        local old = self.parent
        if old then for i, c in ipairs(old.children) do if c == self then table.remove(old.children, i) break end end end
        self.parent = parent; parent.children[#parent.children + 1] = self
      end
      return w
    end
    local entries = {widget('mcm_action_a', 20, 0, 300, 42), widget('mcm_action_b', 20, 42, 300, 42), widget('mcm_action_c', 20, 84, 300, 42)}
    local list = widget('mcm_sidebar_scroll_content', 0, 0, 340, 126, entries)
    local scroller = widget('sidebar_scroll', 40, 200, 340, 700, {list})
    list.parent = scroller
    textWrappingPolicy = {Default = 0}
    textVerticalAlignment = {Top = 'top'}
    local subtitle = widget('content_title', 393, 140, 600, 40)
    local status = widget('status', 60, 1040, 900, 30)
    local revert, apply = widget('mcm_action_revert', 300, 1000, 140, 46), widget('mcm_action_apply', 460, 1000, 140, 46)
    local render = widget('MCMRenderRoot', 0, 0, 1920, 1080, {subtitle, status, scroller,
      widget('mcm_content_scroll_content', 100, 200, 800, 700), revert, apply})
    scroller.parent = render
    status.parent = render
    local root = widget('root', 0, 0, 1920, 1080, {render})
    function controller:GetRootWidget() return root end
    controller.McmUiGetLayoutMetric = function(_, metric) return ({[13] = 320, [20] = 100, [23] = 800, [27] = 1000, [28] = 900})[metric] or -1 end
    controller.McmUiAddBottomActionAt = function(_, id, label, x, y, width, active)
      bottomActions[#bottomActions + 1] = {id = id, label = label, x = x, y = y, width = width, active = active}
      render.children[#render.children + 1] = widget('mcm_action_' .. id, x, y, width, 46)
    end
    assert(invoke('tab:settings').ok)
    handlers.McmUiSetContentTitle(controller, 'Companion Manager')
    mcm.update(player, false)
    -- Back takes the rightmost place; Revert and Apply flow to its left.
    assert(#bottomActions == 1, 'Back was not added to the bottom row')
    local back = bottomActions[1]
    assert(back.id == 'convai-bottom-back' and back.label == 'Back' and back.y == 1000 and back.width == 140 and back.x == 760 and not back.active)
    assert(revert.margin.left == 300 - 160 and apply.margin.left == 460 - 160 and apply.margin.top == 1000,
      'the other buttons were not made room for')
    -- The status line sits in the sidebar, below the last mod entry, wrapped to the list width.
    assert(status.parent == list and status.margin.left == 20 and status.margin.top == 126 + 14,
      'status line not placed just below the last entry: ' .. status.margin.left .. ',' .. status.margin.top)
    assert(status.valign == 'top' and status.height < 120, 'the status text is not anchored to the top of a small box: ' .. tostring(status.height))
    assert(status.width == 320 and status.wrap and status.wrap[1] == true and status.wrap[2] == 320, 'status line not wrapped to the column')
    mcm.update(player, false); mcm.update(player, false)
    assert(#bottomActions == 1, 'Back was added again within one render')
    -- With no other buttons, Back takes the place where the last button would be.
    revert.margin.top, apply.margin.top = 0, 0
    handlers.McmUiSetContentTitle(controller, 'Companion Manager')
    mcm.update(player, false)
    assert(#bottomActions == 2 and bottomActions[2].x == 760)
    -- The click returns to the parent page; pending changes block it like every MCM action.
    drafts = true; handlers.McmUiEmitAction(controller, 'convai-bottom-back')
    assert(mcm.inspect().view == 'settings', 'Back ignored pending changes')
    drafts = false; handlers.McmUiEmitAction(controller, 'convai-bottom-back')
    assert(mcm.inspect().view == 'home')
    loaded = registered.loadMod('manager')
    handlers.McmUiEmitAction(controller, 'something-else'); assert(mcm.inspect().view == 'home')
    -- Leaving our page restores a status widget that survives.
    status.margin.left, status.margin.top = 60, 68
    handlers.McmUiSetContentTitle(controller, 'Other Mod'); mcm.update(player, false)
    assert(status.parent == render and status.margin.top == 1040 and status.height == 30 and status.width == 900,
      'the status line was left in the sidebar')
    -- If the row cannot take the button, Back is the last row of the page instead.
    assert(invoke('tab:party').ok)
    controller.McmUiAddBottomActionAt = function() error('no bottom row') end
    handlers.McmUiSetContentTitle(controller, 'Companion Manager')
    mcm.update(player, false)
    assert(mcm.inspect().backMode == 'list')
    loaded = registered.loadMod('manager')
    local last = loaded.categories[#loaded.categories].settings
    assert(last[#last].id == 'party:back' and last[#last].value == 'Back', 'no Back row at the end of the page')
  `);
});

test('Esc on a sub-page goes back to its parent, Esc on Home closes, and Home has no duplicate section header', () => {
  run(`${mcmFixture}
    CName = {new = function(value) return value end}
    IsDefined = function(value) return value ~= nil end
    local clock, closed = 900, 0
    os.clock = function() return clock end
    controller.McmUiEmitClosing = function() end
    handlers.McmUiSetContentTitle(controller, 'Companion Manager')
    local function esc() return handlers.OnBack(controller, function() closed = closed + 1; return false end) end
    -- Home: the section header is blank, the page title already names the manager.
    loaded = registered.loadMod('manager')
    assert(loaded.categories[1].name == ' ' and #loaded.categories == 1, 'Home still repeats the manager name')
    assert(esc() == false and closed == 1, 'Esc on Home must close Settings')
    for _, name in ipairs({'characters', 'party', 'models', 'settings'}) do
      assert(invoke('tab:' .. name).ok)
      clock = clock + 1
      assert(esc() == true and closed == 1, name .. ': Esc closed Settings instead of going back')
      assert(mcm.inspect().view == 'home', name .. ': Esc did not return to Home')
      loaded = registered.loadMod('manager')
    end
    -- A second page level: Esc returns to the parent, not to Home.
    assert(invoke('tab:settings').ok and invoke('memory').ok)
    clock = clock + 1; assert(esc() == true and mcm.inspect().view == 'settings')
    loaded = registered.loadMod('manager')
    clock = clock + 1; assert(esc() == true and mcm.inspect().view == 'home')
    loaded = registered.loadMod('manager')
    -- A repeated event for the same key does not go back twice, nor close from Home.
    assert(invoke('tab:party').ok); clock = clock + 1
    assert(esc() == true and mcm.inspect().view == 'home')
    loaded = registered.loadMod('manager')
    assert(esc() == true and closed == 1, 'a repeated event closed Settings')
    clock = clock + 1
    assert(esc() == false and closed == 2, 'Esc on Home no longer closes')
    -- Unapplied changes keep the dialog instead of going back.
    clock = clock + 5; loaded = registered.loadMod('manager')
    assert(invoke('tab:settings').ok); drafts = true; clock = clock + 5
    local before = closed
    assert(esc() == true and mcm.inspect().view == 'settings' and closed == before, 'pending changes were ignored')
  `);
});

test('placement is computed from the live layout, so it holds at every resolution and aspect ratio', () => {
  run(`${mcmFixture}
    CName = {new = function(value) return value end}
    NameToString = function(value) return value end
    IsDefined = function(value) return value ~= nil end
    textWrappingPolicy = {Default = 0}; textVerticalAlignment = {Top = 'top'}
    local function widget(name, left, top, width, height, children)
      local w = {name = name, margin = {left = left, top = top, right = 0, bottom = 0}, width = width, height = height, children = children or {}, fontSize = 22}
      function w:GetName() return self.name end
      function w:GetMargin() return {left = self.margin.left, top = self.margin.top, right = 0, bottom = 0} end
      function w:SetMargin(v) self.margin = {left = v.left, top = v.top, right = 0, bottom = 0} end
      function w:GetWidth() return self.width end
      function w:GetHeight() return self.height end
      function w:SetWidth(v) self.width = v end
      function w:SetHeight(v) self.height = v end
      function w:GetNumChildren() return #self.children end
      function w:GetWidgetByIndex(i) return self.children[i + 1] end
      function w:SetText() end
      function w:SetWrapping() end
      function w:SetVerticalAlignment(v) self.valign = v end
      function w:GetFontSize() return self.fontSize end
      function w:SetFontSize(v) self.fontSize = v end
      function w:BindProperty() end
      function w:GetController() return nil end
      function w:GetParentWidget() return self.parent end
      function w:Reparent(parent) self.parent = parent; parent.children[#parent.children + 1] = self end
      return w
    end
    assert(invoke('tab:settings').ok)
    -- 1080p 16:9, 1440p 16:9, 4K 16:9 and 21:9 ultrawide: the canvas scale and sizes differ.
    for _, layout in ipairs({{1920, 1080, 1.0}, {2560, 1440, 1.333}, {3840, 2160, 2.0}, {3440, 1440, 1.333}}) do
      local scale = layout[3]
      local entry = widget('mcm_action_a', 20 * scale, 0, 340 * scale, 42 * scale)
      local list = widget('mcm_sidebar_scroll_content', 0, 0, 360 * scale, 42 * scale, {entry})
      local status = widget('status', 60 * scale, 1000 * scale, 900 * scale, 30 * scale)
      local readonlyLabel = widget('label', 30, 0, 300, 42); readonlyLabel.fontSize = 26
      local surface = widget('mcm_action_cyberpunk-convai:manager:voice-pack', 20, 0, 300, 42, {readonlyLabel})
      local revert = widget('mcm_action_revert', 700 * scale, 960 * scale, 160 * scale, 46)
      local render = widget('MCMRenderRoot', 0, 0, layout[1], layout[2], {status, list, widget('mcm_content_scroll_content', 0, 0, 800, 600, {surface}), revert})
      list.parent, status.parent, revert.parent = render, render, render
      local added
      function controller:GetRootWidget() return widget('root', 0, 0, layout[1], layout[2], {render}) end
      controller.McmUiGetLayoutMetric = function(_, metric)
        return ({[13] = 340 * scale, [20] = 100 * scale, [23] = 800 * scale, [27] = 960 * scale, [28] = 1700 * scale})[metric] or -1
      end
      controller.McmUiAddBottomActionAt = function(_, id, label, x, y, width) added = {x = x, y = y, width = width} ; render.children[#render.children + 1] = widget('mcm_action_' .. id, x, y, width, 46) end
      handlers.McmUiSetContentTitle(controller, 'Companion Manager')
      mcm.update(player, false)
      -- Status: in the list column, 14 below the entry, wrapped to the live column width, never a fixed pixel.
      assert(status.parent == list and status.margin.left == 20 * scale and status.margin.top == 42 * scale + 14,
        layout[1] .. ': status misplaced ' .. status.margin.left .. ',' .. status.margin.top)
      assert(status.width <= 340 * scale and status.valign == 'top', layout[1] .. ': status width or alignment')
      -- Back: at the live bar line and right edge, with the existing button moved left by its own width.
      assert(added and added.y == 960 * scale and added.x + added.width == 1700 * scale, layout[1] .. ': Back not on the live bar')
      assert(revert.margin.left == 700 * scale - (160 * scale + 20), layout[1] .. ': buttons not shifted by the live width')
      -- Fonts: read-only labels take the setting size whatever the layout scale.
      assert(readonlyLabel.fontSize == 22, layout[1] .. ': read-only label font')
    end
  `);
});

test('the game OnBack is held while changes are pending, so the dialog is not closed with the page', () => {
  run(`${mcmFixture}
    CName = {new = function(value) return value end}
    IsDefined = function(value) return value ~= nil end
    local clock, asked, original = 800, 0, 0
    os.clock = function() return clock end
    controller.McmUiEmitClosing = function() asked = asked + 1 end
    handlers.McmUiSetContentTitle(controller, 'Companion Manager')
    local function onBack() return handlers.OnBack(controller, function() original = original + 1; return false end) end
    drafts = false
    assert(onBack() == false and original == 1 and asked == 0, 'a clean page was held')
    drafts = true
    assert(onBack() == true and original == 1 and asked == 1, 'OnBack closed the page with pending changes')
    -- While the question is in flight it is held without asking again.
    clock = clock + 0.5
    assert(onBack() == true and original == 1 and asked == 1)
    -- Cancel keeps the changes: still held, and asked again after the window.
    clock = clock + 5
    assert(onBack() == true and original == 1 and asked == 2)
    -- Apply or Discard clears the changes: the close goes ahead.
    drafts = false
    assert(onBack() == false and original == 2)
    -- Never trapped: repeated holds let the close through.
    drafts = true
    for _ = 1, 8 do clock = clock + 5; onBack() end
    assert(original >= 3, 'repeated OnBack calls trapped the player')
    -- Another mod page is never held.
    handlers.McmUiSetContentTitle(controller, 'Other Mod'); drafts = true; clock = clock + 60
    local before = original; onBack(); assert(original == before + 1)
  `);
});

test('read-only rows use the setting row font size, and routine opened or completed messages are dropped', () => {
  run(`${mcmFixture}
    CName = {new = function(value) return value end}
    NameToString = function(value) return value end
    assert(invoke('tab:settings').ok)
    loaded = registered.loadMod('manager')
    assert(not row('apply-hint'), 'a status row is on the Settings page')
    local function widget(name, left, children)
      local w = {name = name, left = left, children = children or {}, size = 26}
      function w:GetName() return self.name end
      function w:GetMargin() return {left = self.left, top = 0, right = 0, bottom = 0} end
      function w:SetMargin(m) self.left = m.left end
      function w:GetWidth() return 300 end
      function w:SetWidth() end
      function w:GetNumChildren() return #self.children end
      function w:GetWidgetByIndex(i) return self.children[i + 1] end
      function w:SetFontSize(v) self.size = v end
      function w:BindProperty() end
      function w:GetController() return nil end
      return w
    end
    local label = widget('label', 30)
    local surface = widget('mcm_action_cyberpunk-convai:manager:voice-status', 20, {label})
    local content = widget('mcm_content_scroll_content', 0, {surface})
    local render = widget('MCMRenderRoot', 0, {content})
    function controller:GetRootWidget() return widget('root', 0, {render}) end
    handlers.McmUiSetContentTitle(controller, 'Companion Manager')
    mcm.update(player, false)
    assert(label.size == 22, 'a read-only label kept the larger size: ' .. label.size)
    -- "Opened Companion Manager." and "Completed: <page>" never reach the status line.
    local shown
    local function begin(status)
      handlers.McmUiBegin({}, 'MCM', '', 'Mods', 'Companion Manager', status, 0, '', true, true, 0,
        function(_, _, _, _, text) shown = text end)
    end
    begin('Opened Companion Manager.'); assert(shown == '', shown)
    begin('Completed: Characters'); assert(shown == '', shown)
    begin('Failed to apply settings for Companion Manager: Change pending. Choose Apply to use it, or Revert to discard it.')
    assert(shown:find('Change pending', 1, true), 'a pending message was dropped')
  `);
});

test('the Esc and back keys ask first when changes are pending, before MCM closes the mod and discards them', () => {
  run(`${mcmFixture}
    CName = {new = function(value) return value end}
    IsDefined = function(value) return value ~= nil end
    local clock, emitted, wrapped = 500, 0, 0
    os.clock = function() return clock end
    controller.McmUiEmitClosing = function() emitted = emitted + 1 end
    handlers.McmUiSetContentTitle(controller, 'Companion Manager')
    local function key(method, action)
      local event = {IsAction = function(_, name) return name == action end}
      local consumed = handlers[method](controller, event, function() wrapped = wrapped + 1; return false end)
      return consumed == true
    end
    drafts = false
    assert(not key('OnButtonRelease', 'back') and wrapped == 1 and emitted == 0, 'a clean page was held')
    drafts = true
    assert(not key('OnButtonRelease', 'accept') and wrapped == 2 and emitted == 0, 'an ordinary key was held')
    -- A close key with pending changes is consumed, and MCM's own dialog is asked for.
    assert(key('OnButtonPress', 'back') and emitted == 1 and wrapped == 2)
    -- The release of that same key must not reach MCM, whose handler would cancel its new dialog.
    assert(key('OnButtonRelease', 'back') and emitted == 1 and wrapped == 2)
    -- With the dialog open, a later close key goes to MCM (it cancels the dialog).
    clock = clock + 5; controller.m_mcmUiModal = {}
    assert(not key('OnButtonRelease', 'cancel') and wrapped == 3 and emitted == 1)
    controller.m_mcmUiModal = nil
    -- The release alone (no press seen) also asks, for either action name.
    clock = clock + 5
    assert(key('OnButtonRelease', 'cancel') and emitted == 2)
    -- After Apply or Discard nothing is pending and the key passes.
    drafts = false; clock = clock + 5
    assert(not key('OnButtonRelease', 'back') and wrapped == 4)
    -- Another page of MCM, with the same controller, is never held.
    drafts = true; activeMod = 'other:mod'; handlers.McmUiSetContentTitle(controller, 'Other Mod'); clock = clock + 5
    assert(not key('OnButtonRelease', 'back') and emitted == 2, 'another mod page was held')
  `);
});

test('leaving Settings through RequestClose with unapplied changes asks via MCM first, and only then', () => {
  run(`${mcmFixture}
    local emitted, wrappedCalls, clock = 0, 0, 100
    os.clock = function() return clock end
    controller.McmUiEmitClosing = function() emitted = emitted + 1 end
    local function wrapped() wrappedCalls = wrappedCalls + 1 end
    local function requestClose() return handlers.RequestClose(controller, wrapped) end
    -- Nothing pending: the close goes straight through and no question is asked.
    drafts = false
    requestClose(); assert(wrappedCalls == 1 and emitted == 0, 'a clean page asked or blocked')
    -- Unapplied changes: the close is held and MCM's own closing handler (its dialog) runs.
    drafts = true
    requestClose(); assert(wrappedCalls == 1 and emitted == 1, 'a pending change was lost without asking')
    -- MCM resumes the close after Apply or Discard; the drafts are gone, so it passes.
    drafts = false; requestClose(); assert(wrappedCalls == 2 and emitted == 1)
    -- Another mod's page is never held.
    drafts = true; activeMod = 'other:mod'
    requestClose(); assert(wrappedCalls == 3 and emitted == 1, 'another mod page was blocked')
    activeMod = 'cyberpunk-convai:manager'
    -- Never trapped: repeated requests, or a dialog that cannot be shown, let the close through.
    for _ = 1, 5 do clock = clock + 1; requestClose() end
    assert(wrappedCalls >= 4, 'repeated requests trapped the player')
    clock = clock + 60; controller.McmUiEmitClosing = function() error('no dialog') end
    local before = wrappedCalls
    requestClose(); assert(wrappedCalls == before + 1, 'a dialog that could not open trapped the player')
  `);
});

test('with Auto Apply every setting waits for an explicit Apply: the automatic apply is refused, nothing is saved or sent, and a later Apply commits', () => {
  run(`${mcmFixture}
    assert(invoke('tab:settings').ok)
    local clock = 5000
    os.clock = function() return clock end
    -- A fake MCM: a draft change emits 'drafts.changed' and Auto Apply applies in the same instant.
    local listeners = {}
    nativeApi.subscribe = function(name, callback) listeners[#listeners + 1] = callback; return #listeners end
    nativeApi.unsubscribe = function() return true end
    mcm.shutdown(); mcm.install()
    local function setDraft(id, value, count)
      for _, callback in ipairs(listeners) do callback({modKey = 'cyberpunk-convai:manager', count = count or 1}) end
      return {id = id, value = value}
    end
    local function autoApply(...)
      local changes = {}
      for _, change in ipairs({...}) do changes[#changes + 1] = setDraft(change[1], change[2]) end
      return registered.applyBatch('manager', changes)
    end
    local function snapshotOf()
      local s = manager.snapshot(player).settings
      return table.concat({tostring(s.voiceProvider), tostring(s.omniSteps), tostring(s.omniReference),
        tostring(s.keepPreparedVoices), tostring(s.voice), tostring(s.subtitles),
        tostring(s.subtitleStyle), tostring(s.battleReactions), tostring(s.lootReactions), tostring(s.bodyGestures),
        tostring(s.developerMode), tostring(s.eyeContactHeight), tostring(s.headFollowStrength), tostring(s.uiLanguage),
        tostring(s.relationshipModes['judy-alvarez']), tostring(s.enabledByKey['person-1']), tostring(s.autoConnectNearby)}, '|')
    end
    local before, writes = snapshotOf(), #fileWrites
    -- One setting of every kind: bool, select, voice, gaze, language, relationship, conversation.
    for _, change in ipairs({{'voiceProvider', 3}, {'voiceProvider', 2}, {'voiceProvider', 6}, {'keepPreparedVoices', false}, {'voice', false}, {'subtitles', false},
        {'subtitleStyle', 2}, {'battleReactions', false}, {'lootReactions', false}, {'bodyGestures', true},
        {'developerMode', true}, {'eyeContactHeight', 5}, {'headFollowStrength', 4}, {'uiLanguage', 2},
        {'relationship:judy-alvarez', 2}, {'enabled:person-1', false}, {'autoConnectNearby', true}}) do
      local result = autoApply(change)
      assert(result.ok == false and result.error:find('Change pending', 1, true), change[1] .. ' was applied automatically')
      assert(snapshotOf() == before, change[1] .. ' reached the settings')
      assert(#fileWrites == writes, change[1] .. ' wrote a file')
      assert(files['runtime/voice-preview.json'] == nil, change[1] .. ' offered a worker preview')
      clock = clock + 0.001
    end
    mcm.update(player, false); mcm.update(player, true)
    assert(snapshotOf() == before and #fileWrites == writes and files['runtime/voice-preview.json'] == nil)
    -- The person presses Apply later: all of it commits at once.
    clock = clock + 2
    local applied = registered.applyBatch('manager', {{id = 'voiceProvider', value = 6}, {id = 'subtitles', value = false},
      {id = 'developerMode', value = true}, {id = 'eyeContactHeight', value = 5}, {id = 'enabled:person-1', value = false}})
    assert(applied.ok and applied.atomic)
    local after = manager.snapshot(player).settings
    assert(after.voiceProvider == 'convai' and not after.subtitles and after.developerMode and not after.enabledByKey['person-1'])
    assert(#fileWrites > writes)
    -- The refusal window is short: a later change followed at once by apply is refused again.
    local second = autoApply({'voice', false})
    assert(second.ok == false)
    clock = clock + 2
    assert(registered.applyBatch('manager', {{id = 'voice', value = false}}).ok and not manager.snapshot(player).settings.voice)
  `);
});

test('the voice status names a pending voice in a short line and nothing prepares a model before Apply', () => {
  run(`${mcmFixture}
    assert(invoke('tab:settings').ok)
    local pending = 6
    nativeApi.getValue = function(key) assert(key == 'cyberpunk-convai:manager:voiceProvider'); return pending end
    nativeApi.hasDrafts = function() return false end
    CName = {new = function(value) return value end}
    NameToString = function(value) return value end
    local text
    local value = {GetName = function() return 'cyberpunk-convai:manager:voice-status_value' end,
      GetController = function() return nil end, SetText = function(_, next) text = next end}
    local content = {GetName = function() return 'mcm_content_scroll_content' end,
      GetNumChildren = function() return 1 end, GetWidgetByIndex = function() return value end}
    function controller:GetRootWidget() return content end
    handlers.McmUiSetContentTitle(controller, 'Companion Manager')
    mcm.update(player, false)
    assert(text == 'Pending: Convai · Cloud voice', text)
    assert(utf8.len(text) < 30, 'the pending line must stay short')
    pending = 3
    handlers.McmUiSetContentTitle(controller, 'Companion Manager')
    local sooner = os.time() + 5
    os.time = function() return sooner end
    mcm.update(player, false)
    assert(text == 'Pending: OmniVoice · Quality', text)
    pending = 1
    handlers.McmUiSetContentTitle(controller, 'Companion Manager')
    local later = os.time() + 10
    os.time = function() return later end
    mcm.update(player, false); mcm.update(player, false)
    assert(text ~= nil and not text:find('Pending', 1, true))
    assert(files['runtime/voice-preview.json'] == nil, 'a pending voice prepared a model')
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
    assert(mcm.inspect().back.label=='Retour à la gestion des compagnons')
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
    assert(first.message == '' and not first.failed, 'preparation showed text')
    assert(party.preparationFeedback().signature == first.signature)
    readiness.receipts[first.id] = {state = 'connecting'}
    local connecting = party.preparationFeedback()
    assert(connecting.message == '' and connecting.state == 'connecting' and connecting.signature ~= first.signature)
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
    assert(party.preparationFeedback().state == 'ready' and party.preparationFeedback().message == '')
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
  local popupClock, nativeCallback, popups, popupStep = 1000, false, {}, 4
  os.time = function() return popupClock end
  function player:ConvaiPhoneFeedback(message)
    assert(not nativeCallback, 'manager action callback posted a native popup')
    popups[#popups + 1] = message
  end
  -- One tick is four seconds: longer than the notice board's minimum show time (3 s)
  -- before routine progress and the next stage show, so existing flows still see each stage.
  local function popupTick(worldReady)
    popupClock = popupClock + popupStep
    mcm.update(player, worldReady == true)
  end
  -- Routine progress popups are Developer mode only; it defaults to Off.
  local function developer(enabled)
    assert(registered.applyBatch('manager', {{id = 'developerMode', value = enabled == true}}).ok)
  end
`;

test('with Developer mode on, manager invitations post no preparation popup, only the joined one', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok)
    nativeCallback = true; assert(invoke('invite:johnny-silverhand').ok); nativeCallback = false
    assert(#popups == 0, 'invitation posted a popup inside its native action callback')
    popupTick(false)
    assert(#popups == 0, 'preparation posted a popup: ' .. tostring(popups[1]))
    for _ = 1, 5 do popupTick(false) end
    readiness.receipts['queued:1'] = {state = 'connecting'}; popupTick(false)
    assert(#popups == 0, 'connecting posted a popup: ' .. tostring(popups[1]))
    readiness.receipts['queued:1'] = {state = 'ready'}; popupTick(false)
    assert(#popups == 0, 'the ready line posted a popup: ' .. tostring(popups[1]))
    assert(#spawned == 0)
    popupTick(true)
    assert(#popups == 0 and #spawned == 1, 'the joining step posted a popup with Developer mode on: ' .. tostring(popups[1]))
    popupTick(true); assert(#popups == 0)
    members[1].state = 'ready'; popupTick(true)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand joined your group.', tostring(popups[#popups]))
    for _ = 1, 5 do popupTick(true) end
    assert(#popups == 1, 'the joined notice repeated')
  `);
});

test('leaving the manager posts only an unresolved failure, and keeps phone invitations independent', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    popupTick(false)
    readiness.receipts['queued:1'] = {state = 'connecting'}
    -- Resume inside the same clock second: do not reuse the paused memory sample.
    mcm.update(player, true)
    assert(#popups == 0, 'connecting posted a popup on resume: ' .. tostring(popups[1]))
    popupTick(true); assert(#popups == 0)
    assert(invoke('characters:back').ok and invoke('tab:settings').ok and invoke('memory').ok)
    assert(invoke('memory:choose').ok and invoke('memory:select:johnny-silverhand').ok)
    readiness.receipts['queued:1'] = {state = 'error', error = 'Private detail'}; popupTick(false)
    assert(#popups == 0, 'the paused menu consumed the failure notice')
    popupTick(true)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand could not prepare: Private detail',
      'an unrelated footer action disabled the in-world notification')
    assert(party.dismiss('queued:1')); popupTick(true)
    assert(#popups == 1, 'cancelled progress replayed on returning to gameplay')
    assert(party.invite('person-1')); popupTick(false)
    readiness.receipts['queued:2'] = {state = 'connecting'}; popupTick(false)
    assert(#popups == 1, 'manager added popups for a phone-owned invitation')
  `);
});

test('duplicate manager copies post no progress, and a world reset leaves nothing behind', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok); popupTick(false)
    assert(invoke('invite:johnny-silverhand').ok); popupTick(false)
    assert(#popups == 0, 'a duplicate copy posted progress: ' .. tostring(popups[1]))
    assert(party.dismiss('queued:2')); popupTick(false)
    -- The older copy is still in flight: its stages are not posted either.
    readiness.receipts['queued:1'] = {state = 'connecting'}; popupTick(false)
    assert(#popups == 0, 'the older copy posted progress: ' .. tostring(popups[1]))
    mcm.resetSession(); popupTick(true)
    assert(#popups == 0 and #spawned == 0, 'world reset retained a stale popup or invitation')
  `);
});

test('Auto-connect nearby characters is on by default, offered under Conversations and saved with the settings', () => {
  run(`${mcmFixture}
    assert(manager.autoConnectNearby() == true and manager.snapshot(player).settings.autoConnectNearby == true)
    assert(invoke('tab:settings').ok)
    local auto = assert(row('autoConnectNearby'), 'the setting is not offered')
    assert(auto.type == 'bool' and auto.value == true and auto.defaultValue == true and auto.capabilities.draft)
    assert(auto.label == 'Auto-connect nearby characters')
    local conversations
    for _, category in ipairs(loaded.categories) do if category.id == 'conversation-controls' then conversations = category end end
    local found = false
    for _, item in ipairs(conversations.settings) do if item.id == 'autoConnectNearby' then found = true end end
    assert(found, 'the setting is not in the Conversations section')
    assert(registered.applyBatch('manager', {{id = 'autoConnectNearby', value = false}}).ok)
    assert(manager.autoConnectNearby() == false and saved.autoConnectNearby == false, 'an explicit Off is kept')
    loaded = registered.loadMod('manager'); assert(row('autoConnectNearby').value == false)
    -- It does not disturb the other settings, and only a boolean is accepted.
    assert(manager.snapshot(player).settings.voice == true)
    assert(not manager.applySettings(player, {autoConnectNearby = 'yes'}) and manager.autoConnectNearby() == false)
    assert(registered.applyBatch('manager', {{id = 'autoConnectNearby', value = true}}).ok and manager.autoConnectNearby())
  `);
});

test('invitations made together show a player one joined summary and no progress', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    popupStep = 11
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok); popupTick(false)
    assert(invoke('invite:person-1').ok); popupTick(false)
    readiness.receipts['queued:1'] = {state = 'connecting'}; popupTick(false)
    readiness.receipts['queued:2'] = {state = 'connecting'}; popupTick(false)
    readiness.receipts['queued:1'] = {state = 'ready'}; readiness.receipts['queued:2'] = {state = 'ready'}
    popupTick(false)
    assert(#popups == 0, 'a player was told about the preparation: ' .. tostring(popups[1]))
    popupTick(true)
    assert(#spawned == 2 and #popups == 0, 'the routine joining step posted with Developer mode off')
    members[1].state = 'ready'; members[2].state = 'ready'; popupTick(true)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand and Person 01 joined your group.', popups[#popups])
    for _ = 1, 4 do popupTick(true) end
    assert(#popups == 1, 'the finished burst repeated')
  `);
});

test('one companion failing to prepare is reported without hiding the other one joining', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok and invoke('invite:person-1').ok)
    popupTick(false)
    readiness.receipts['queued:1'] = {state = 'ready'}
    readiness.receipts['queued:2'] = {state = 'error', error = 'Bridge unavailable'}
    popupTick(false); popupTick(true)
    members[1].state = 'ready'; popupTick(true)
    local last = popups[#popups]
    assert(last:find('Johnny Silverhand joined your group.', 1, true) and last:find('Person 01 could not prepare: Bridge unavailable', 1, true), last)
    for _ = 1, 4 do popupTick(true) end
    assert(popups[#popups] == last, 'the outcome was repeated')
  `);
});

test('a failure hidden by the menu is posted once in gameplay, and no preparation posts anything', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok); popupTick(false)
    mcm.update(player, true)
    assert(#popups == 0, 'a preparation showed in gameplay: ' .. tostring(popups[1]))
    for _ = 1, 3 do popupTick(true); popupTick(false) end
    popupTick(true); assert(#popups == 0, 'reopening the menu posted a preparation popup')
    readiness.receipts['queued:1'] = {state = 'error', error = 'Bridge unavailable'}; popupTick(false)
    -- The paused menu shows the failure in its banner only and keeps the claim.
    for _ = 1, 3 do popupTick(false) end
    assert(#popups == 0, 'the paused menu consumed the single failure notice')
    popupTick(true)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand could not prepare: Bridge unavailable',
      'the failure was not posted when gameplay resumed')
    -- A failed attempt reports once: gameplay is the claim.
    for _ = 1, 3 do popupTick(true); popupTick(false) end
    assert(#popups == 1, 'the existing failure notice was duplicated by a second preparation failure')
  `);
});

test('a quick manager invitation shows a player only its joined line, and a slow one shows nothing while it waits', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    popupStep = 0.2
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    popupTick(false)
    readiness.receipts['queued:1'] = {state = 'connecting'}; popupTick(false)
    assert(#popups == 0, 'routine progress showed to a player: ' .. tostring(popups[1]))
    readiness.receipts['queued:1'] = {state = 'ready'}; popupTick(false)
    assert(#popups == 0, 'the ready line showed to a player: ' .. tostring(popups[1]))
    popupTick(true); assert(#spawned == 1 and #popups == 0)
    members[1].state = 'ready'; popupTick(true)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand joined your group.', 'the joined line did not show: ' .. tostring(popups[#popups]))
    -- A slower invitation shows nothing to a player while it waits, however long the wait.
    popupStep = 11
    assert(invoke('invite:person-1').ok)
    popupTick(false); popupTick(false)
    readiness.receipts['queued:2'] = {state = 'ready'}; popupTick(false)
    assert(#popups == 1, 'a slow invitation showed progress to a player: ' .. tostring(popups[#popups]))
  `);
});

test('with Developer mode off a player sees only joined, and Developer mode adds no joining step', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    assert(not manager.developerMode())
    popupStep = 11
    assert(invoke('tab:characters').ok)
    nativeCallback = true; assert(invoke('invite:johnny-silverhand').ok); nativeCallback = false
    popupTick(false)
    assert(#popups == 0, 'a preparation showed to a player: ' .. tostring(popups[1]))
    readiness.receipts['queued:1'] = {state = 'connecting'}; popupTick(false)
    readiness.receipts['queued:1'] = {state = 'ready'}; popupTick(false)
    assert(#popups == 0, 'the ready line showed to a player')
    popupTick(true)
    assert(#popups == 0 and #spawned == 1, 'the routine joining stage posted a popup with Developer mode off')
    popupTick(true); popupTick(true); assert(#popups == 0)
    members[1].state = 'ready'; popupTick(true)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand joined your group.')
    for _ = 1, 3 do popupTick(true) end
    assert(#popups == 1)
  `);
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    popupStep = 11
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    popupTick(false)
    readiness.receipts['queued:1'] = {state = 'ready'}; popupTick(false)
    assert(#popups == 0, 'the ready line waits or shows for a player')
    popupTick(true); assert(#popups == 0)
    -- Turning Developer mode on adds no joining step: only the joined line is ever posted.
    developer(true); popupTick(true)
    assert(#popups == 0, 'turning Developer mode on posted the joining step: ' .. tostring(popups[1]))
    popupTick(true); popupTick(true); assert(#popups == 0)
    developer(false); members[1].state = 'ready'; popupTick(true)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand joined your group.')
  `);
});

test('a preparation failure first seen in the paused menu posts exactly one gameplay notice with Developer mode off', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    popupStep = 11
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    popupTick(false)
    assert(#popups == 0, 'a preparation showed to a player: ' .. tostring(popups[1]))
    readiness.receipts['queued:1'] = {state = 'error', error = 'Bridge unavailable'}
    for _ = 1, 4 do popupTick(false) end
    assert(#popups == 0, 'the paused menu posted the failure notice')
    assert(party.preparationFeedback().failed, 'the manager banner must still show the failure')
    popupTick(true)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand could not prepare: Bridge unavailable')
    for _ = 1, 4 do popupTick(true); popupTick(false) end
    assert(#popups == 1 and #spawned == 0, 'the failed attempt notified again or was retried')
    -- Cancelling and inviting again is a new attempt with its own notice.
    assert(invoke('characters:back').ok and invoke('tab:party').ok and invoke('dismiss:queued:1').ok)
    assert(invoke('party:back').ok and invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok); popupTick(false)
    assert(#popups == 1)
    readiness.receipts['queued:2'] = {state = 'error', error = 'Still unavailable'}
    popupTick(false); assert(#popups == 1)
    popupTick(true)
    assert(#popups == 2 and popups[2] == 'Johnny Silverhand could not prepare: Still unavailable')
  `);
});

test('an already joined manager invitation cannot replay preparation when the game resumes', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok); popupTick(false)
    assert(#popups == 0, 'a preparation showed: ' .. tostring(popups[1]))
    readiness.receipts['queued:1'] = {state = 'ready'}
    party.flush(); members[1].state = 'ready'
    mcm.update(player, true)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand joined your group.')
    for _ = 1, 5 do popupTick(true) end
    assert(#popups == 1)
  `);
});

test('a deferred world spawn posts no joining text, and the joined line once it attaches', () => {
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
    assert(#spawned == 0 and #popups == 0, 'the deferred spawn posted a joining step: ' .. tostring(popups[1]))
    popupTick(true); popupTick(true)
    assert(attempts == 3 and #spawned == 1 and #popups == 0,
      'admitting the deferred spawn posted a notice before the companion joined')
    members[1].state = 'ready'; popupTick(true)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand joined your group.')
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

test('manager invitation banner shows no preparation text, and does not reload drafts or show party blocks', () => {
  run(`${mcmFixture}${invitationFixture}${managerBannerFixture}
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    drafts = true
    paint('Completed: Johnny Silverhand')
    local reloadBefore = reloads
    tick()
    assert(banner.text == '' and rootReads == 1, 'preparation text showed in the banner: ' .. banner.text)
    assert(not row('party-count') and not row('feedback') and not row('tab:settings'))
    local writes = banner.writes
    tick(); tick()
    assert(banner.writes == writes, 'unchanged preparation repainted every frame')
    readiness.receipts['queued:1'] = {state = 'connecting'}; tick()
    assert(banner.text == '' and banner.writes == writes + 1, 'the connecting state did not reach the banner')
    writes = banner.writes
    paint('Completed: Johnny Silverhand'); tick()
    assert(banner.text == '' and banner.writes == writes, 'a page rebuild lost or duplicated the cached preparation update')
    readiness.receipts['queued:1'] = {state = 'ready'}; tick()
    assert(banner.text == '')
    readiness.receipts['queued:1'] = {state = 'error', error = 'Internal detail'}; tick()
    assert(banner.text == 'Johnny Silverhand: preparation failed. Cancel and invite again.')
    assert(reloads == reloadBefore and drafts and #spawned == 0, 'paused feedback mutated gameplay or drafts')
    assert(party.dismiss('queued:1')); tick()
    assert(banner.text == '', 'cancelled invitation left stale text in the banner')
    writes = banner.writes; tick(); assert(banner.writes == writes)
  `);
});

test('preparation banners preserve native errors, memory action feedback, foreign pages and detached controllers', () => {
  run(`${mcmFixture}${invitationFixture}${memoryFixture}${managerBannerFixture}
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    paint('Action failed', nil, 2); tick()
    assert(banner.text == 'Action failed' and banner.writes == 0, 'native error was replaced')
    paint('Completed: Johnny Silverhand'); tick()
    assert(banner.text == '', 'progress showed on an eligible banner')
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
    assert(banner.text == '', 'progress showed for the second invitation')
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

test('without the optional OmniVoice pack Omni entries say what they need and cannot be applied; unknown status never locks them', () => {
  run(`${mcmFixture}
    local clock = 1000
    os.time = function() return clock end
    jsonFixtures['voice-runtime'] = {state = 'ready', provider = 'pocket', omniPack = {installed = false, missing = {'model'}},
      updated = clock * 1000}
    files['runtime/local-voice-state.json'] = 'voice-runtime'
    assert(invoke('tab:settings').ok)
    loaded = registered.loadMod('manager')
    local elements = row('voiceProvider').elements
    assert(elements[1] == 'Pocket · Performance' and elements[6] == 'Convai · Cloud voice')
    assert(elements[2] == 'OmniVoice · Balanced · needs Omni pack', elements[2])
    for index = 2, 5 do
      assert(elements[index]:find(' · needs Omni pack', 1, true), 'entry ' .. index)
      assert(utf8.len(elements[index]) <= 44, 'entry ' .. index .. ' must stay short enough not to truncate')
    end
    assert(row('voice-pack').value == 'Not installed')
    local before = saved.voiceProvider
    for index = 2, 5 do
      local result = registered.applyBatch('manager', {{id = 'voiceProvider', value = index}})
      assert(result.ok == false and result.error == 'Requires the optional OmniVoice pack (GPU)', 'entry ' .. index)
      assert(saved.voiceProvider == before)
    end
    assert(not manager.applySettings(player, {voiceProvider = 'omni'}))
    -- Pocket and Convai stay selectable.
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 6}}).ok and saved.voiceProvider == 'convai')
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 1}}).ok and saved.voiceProvider == 'pocket')
    -- The pack appears (installed while the game runs): the entries become plain labels and can be applied.
    clock = clock + 20
    jsonFixtures['voice-runtime'] = {state = 'ready', provider = 'pocket', omniPack = {installed = true, missing = {}},
      updated = clock * 1000}
    manager.snapshot(player)
    loaded = registered.loadMod('manager')
    assert(row('voiceProvider').elements[2] == 'OmniVoice · Balanced')
    assert(row('voice-pack').value == 'Installed')
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 2}}).ok)
    assert(saved.voiceProvider == 'omni' and saved.omniSteps == 16 and saved.omniReference == 'short')
  `);
});

test('native Memory submenu has consistent parent navigation and preserves an unissued confirmation', () => {
  run(`${mcmFixture}${memoryFixture}
    publishMemory(1, {{profileKey = 'person-20'}})
    assert(invoke('tab:settings').ok)
    assert(row('memory').type == 'action' and row('memory').value == 'Manage')
    assert(not row('memory:choose') and not row('memory-count'), 'memory controls leaked into the Settings page')
    assert(invoke('permissions').ok and mcm.inspect().view == 'permissions')
    assert(not row('tab:settings') and mcm.inspect().back.label == 'Back to settings')
    assert(invoke('permissions:back').ok and mcm.inspect().view == 'settings')
    assert(invoke('memory').ok and mcm.inspect().view == 'memory')
    assert(not row('tab:settings') and mcm.inspect().back.label == 'Back to settings')
    assert(invoke('memory:choose').ok and mcm.inspect().view == 'memory-characters')
    assert(not row('tab:settings') and mcm.inspect().back.label == 'Back to memory')
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
  assert(selected.elements[1]=='Auto' and selected.elements[2]=='Romantic' and selected.elements[3]=='Ordinary')
  assert(selected.description:find('Romantic has them speak to V as a partner',1,true) and not selected.description:find('Off uses',1,true))
  local meredith=row('relationship:meredith-stout')
  assert(meredith.elements[1]=='Auto' and meredith.elements[2]=='Casual' and meredith.elements[3]=='Ordinary')
  assert(meredith.description:find('does not imply an ongoing relationship',1,true))
  assert(row('relationship:panam-palmer').elements[2]=='Romantic' and row('relationship:river-ward').elements[2]=='Romantic')
  assert(row('relationship:kerry-eurodyne').elements[2]=='Romantic')
  assert(manager.snapshot(player).settings.relationshipModes['judy-alvarez']=='auto')
  assert(registered.applyBatch('manager',{{id='relationship:judy-alvarez',value=2}}).ok)
  assert(saved.relationshipModes['judy-alvarez']=='on')
  assert(not registered.applyBatch('manager',{{id='relationship:judy-alvarez',value=4}}).ok)
  assert(saved.relationshipModes['judy-alvarez']=='on')
  assert(invoke('relationships:back').ok and row('relationships') and not row('disappearingMessages'))
`));

test('the Characters sidebar shows the settings in effect for each character, not invitation advice', () => run(`${mcmFixture}${memoryFixture}
  local list = {{key = 'judy-alvarez', name = 'Judy Alvarez', records = {'Character.Judy'}, summary = 'A braindance editor.', voiceName = 'Julia'},
    {key = 'viktor-vektor', name = 'Viktor Vektor', records = {'Character.Victor_Vector'}, summary = 'A ripperdoc.'}}
  for index = 1, 40 do list[#list + 1] = {key = 'extra-' .. index, name = string.format('Extra %02d', index), records = {'Character.Extra_' .. index}} end
  manager.configure(api, list)
  local function description(key) return assert(row('invite:' .. key), key).description end
  local function reload() loaded = registered.loadMod('manager') end
  assert(invoke('tab:characters').ok)
  reload()
  -- Nothing is on and nobody is in the party: the description, the voice and the conversation, and no advice text.
  local plain = description('viktor-vektor')
  assert(plain == 'A ripperdoc.\\n\\nVoice: Convai voice\\nConversation: On', plain)
  assert(not plain:find('Invitations create', 1, true) and not plain:find('phone contacts', 1, true) and not plain:find('Memory and connection', 1, true))
  assert(description('judy-alvarez'):find('Relationship: Auto', 1, true), 'Judy has a relationship line')
  -- Judy in the party on OmniVoice, with the speech settings, Multilingual and a memory of the player.
  assert(manager.applySettings(player, {voiceProvider = 'omni', omniSteps = 16, omniReference = 'short', naturalSpeech = true,
    expressiveEmotions = true, followUpInterest = true, multilingualConversations = true, relationshipModes = {['judy-alvarez'] = 'on'}}))
  jsonFixtures['voice-runtime'] = {state = 'ready', provider = 'omni', omniSteps = 16, omniReference = 'short',
    routedProfiles = {'judy-alvarez'}, updated = memoryClock * 1000.0}
  files['runtime/local-voice-state.json'] = 'voice-runtime'
  publishMemory(1, {{profileKey = 'judy-alvarez'}})
  api.spawn('judy-alvarez'); members[1].state = 'ready'
  reload()
  local judy = description('judy-alvarez')
  assert(judy == table.concat({'A braindance editor.', '', 'Voice: OmniVoice · Balanced', 'Conversation: On', 'Relationship: Romantic',
    'Speech: Natural speech · Expressive emotions · Follow-up questions', 'Multilingual: replies in your language',
    'Memory: remembers your conversations', 'In your party: 1',
    'Behavior: React to battles · React to collected loot'}, '\\n'), judy)
  -- A character who is not in the party keeps the speech lines, not the party ones; with no memory there is no memory line.
  local viktor = description('viktor-vektor')
  assert(viktor:find('Speech: Natural speech · Expressive emotions · Follow-up questions', 1, true) and viktor:find('Multilingual: replies', 1, true))
  assert(not viktor:find('Memory:', 1, true) and not viktor:find('In your party', 1, true) and not viktor:find('Behavior', 1, true)
    and not viktor:find('Relationship', 1, true), viktor)
  -- Without the optional pack, a saved OmniVoice choice that is not running says so; switching a behavior off drops its name.
  jsonFixtures['voice-runtime'] = {state = 'ready', provider = 'pocket', routedProfiles = {}, updated = memoryClock * 1000.0,
    omniPack = {installed = false, missing = {}}}
  assert(manager.applySettings(player, {battleReactions = false, lootReactions = false, bodyGestures = true}))
  reload()
  assert(description('viktor-vektor'):find('Voice: OmniVoice · Balanced · needs Omni pack', 1, true), description('viktor-vektor'))
  local judyLines = description('judy-alvarez')
  assert(judyLines:sub(-#'\\nBehavior: Body gestures (experimental)') == '\\nBehavior: Body gestures (experimental)', judyLines)
  -- A character with conversations switched off shows only that, and Auto / Ordinary read as such for the others.
  assert(manager.applySettings(player, {enabledByKey = {['judy-alvarez'] = false}}))
  reload()
  local off = description('judy-alvarez')
  assert(off:find('Conversation: Off', 1, true) and not off:find('Speech', 1, true) and not off:find('Relationship', 1, true)
    and not off:find('Memory:', 1, true) and off:find('In your party: 1', 1, true), off)
  assert(manager.applySettings(player, {enabledByKey = {['judy-alvarez'] = true}, relationshipModes = {['judy-alvarez'] = 'off', ['panam-palmer'] = 'auto'}}))
  reload()
  assert(description('judy-alvarez'):find('Relationship: Ordinary', 1, true))
  -- Building the sidebar reads no file per character: the same reads with 42 characters as with 2.
  local reads = 0
  local rawOpen = io.open
  io.open = function(path, mode) if mode == 'rb' then reads = reads + 1 end; return rawOpen(path, mode) end
  reload(); local withMany = reads
  reads = 0
  manager.configure(api, {list[1], list[2]}); reload(); reads = 0; reload()
  assert(withMany == reads, 'sidebar text read files per character: ' .. withMany .. ' vs ' .. reads)
  io.open = rawOpen
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
    -- Order: 1 Cinematic subtitles (stored dialogue, the default), 2 Above the speaker (stored overhead).
    assert(row('subtitleStyle').type == 'select' and row('subtitleStyle').value == 1)
    assert(row('subtitleStyle').defaultValue == 1 and row('subtitleStyle').capabilities.draft)
    assert(row('subtitleStyle').elements[1] == 'Cinematic subtitles' and row('subtitleStyle').elements[2] == 'Above the speaker')
    assert(row('voiceProvider').type == 'select' and row('voiceProvider').value == 1)
    assert(row('keepPreparedVoices').type == 'bool' and row('keepPreparedVoices').value == true)
    assert(row('voice-pack').value == 'Waiting for voice service' or row('voice-pack').value == 'Installed')
    assert(row('disappearingMessages') == nil)
    assert(row('battleReactions').type == 'bool' and row('battleReactions').value == true)
    assert(row('lootReactions').type == 'bool' and row('lootReactions').value == true)
    -- The retired follow-up question toggle is no longer offered.
    assert(row('followUpQuestions') == nil)
    assert(registered.applyBatch('manager', {{id = 'lootReactions', value = false}}).ok)
    assert(not manager.lootReactions())
    assert(registered.applyBatch('manager', {{id = 'battleReactions', value = false}}).ok)
    assert(not manager.battleReactions())
    local applied = registered.applyBatch('manager', {{id = 'voice', value = false}, {id = 'voiceProvider', value = 6}, {id = 'subtitleStyle', value = 2}})
    assert(applied.ok and applied.atomic and #applied.appliedIds == 3 and saved.omniSteps == 16)
    assert(saved.voiceProvider == 'convai')
    loaded = registered.loadMod('manager')
    assert(manager.subtitleStyle() == 'overhead' and row('subtitleStyle').value == 2)
    for _, invalid in ipairs({0, 3, '1', 'overhead', false}) do
      assert(not registered.applyBatch('manager', {{id = 'subtitles', value = false}, {id = 'subtitleStyle', value = invalid}}).ok)
      assert(manager.subtitleStyle() == 'overhead' and player.subtitles)
    end
    assert(registered.applyBatch('manager', {{id = 'subtitleStyle', value = 1}}).ok)
    assert(manager.subtitleStyle() == 'dialogue' and saved.voiceProvider == 'convai')
    assert(not registered.applyBatch('manager', {{id = 'voiceProvider', value = 7}}).ok)
    assert(not registered.applyBatch('manager', {{id = 'voiceProvider', value = 0}}).ok)
    assert(not registered.applyBatch('manager', {{id = 'voiceProvider', value = '1'}}).ok)
    assert(registered.applyBatch('manager', {{id = 'keepPreparedVoices', value = false}}).ok and saved.keepPreparedVoices == false)
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 3}}).ok)
    assert(saved.voiceProvider == 'omni' and saved.omniSteps == 16 and saved.omniReference == 'long')
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 4}}).ok)
    assert(saved.voiceProvider == 'omni' and saved.omniSteps == 32 and saved.omniReference == 'short')
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 6}}).ok and saved.voiceProvider == 'convai')
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

test('settings review wording: short voice description, experimental gestures, full Developer mode text, Model browser says what it lists', () => {
  run(`${mcmFixture}
    local home = row('tab:models')
    assert(home and home.label == 'Model browser')
    assert(home.description:find('without conversation support', 1, true) and home.description:find('do not talk', 1, true))
    assert(invoke('tab:settings').ok)
    local voices = row('voiceProvider')
    assert(voices.defaultValue == 1 and voices.value == 1)
    assert(voices.description:find('about 0.2 s', 1, true) and voices.description:find('1 to 2.5 s', 1, true))
    assert(not voices.description:find('%', 1, true), 'no listening percentages in the voice description')
    assert(not voices.description:find(string.char(10), 1, true) and utf8.len(voices.description) < 600, 'the voice description stays short')
    assert(row('bodyGestures').label == 'Body gestures (experimental)' and row('bodyGestures').defaultValue == false)
    assert(row('sitWithYou') == nil, 'companions always sit with V: there is no Sit with you setting')
    assert(row('autoConnectNearby').defaultValue == true and row('keepPreparedVoices').defaultValue == true)
    local developer = row('developerMode').description
    for _, part in ipairs({'popups', 'movement trace', 'gesture', 'support reports'}) do
      assert(developer:find(part, 1, true), 'Developer mode must say it enables ' .. part)
    end
    assert(row('headFollowStrength').defaultValue == 3)
    assert(manager.snapshot(player).settings.headFollowStrength == 1, 'the saved strength values are unchanged')
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
    assert(row('headFollowStrength').elements[1]=='Eyes only' and row('headFollowStrength').elements[2]=='Subtle' and row('headFollowStrength').elements[3]=='Gentle (default)' and row('headFollowStrength').elements[4]=='Strong')
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

test('native MCM action banner shows no progress for the queued invitation and leaves other pages and errors alone', () => {
  run(`${mcmFixture}
    assert(invoke('tab:characters').ok)
    assert(invoke('invite:johnny-silverhand').ok)
    local rendered
    local function paint(label, status)
      handlers.McmUiBegin({}, 'MCM', '', 'Mods', label, status, 1, '', true, true, 0,
        function(title, subtitle, sidebar, content, message) rendered = message end)
      return rendered
    end
    assert(paint('Companion Manager', 'Completed: Johnny Silverhand') == '', 'the queued invitation showed progress in the banner')
    assert(paint('Other Mod', 'Completed: Johnny Silverhand') == 'Completed: Johnny Silverhand')
    assert(paint('Companion Manager', 'Action failed') == 'Action failed')
    assert(invoke('characters:back').ok and invoke('tab:settings').ok)
    assert(paint('Companion Manager', 'Completed: Settings') == '', 'a routine navigation message was shown')
  `);
});

test('native MCM shows no invitation progress and keeps reserved copies editable until actual attachment', () => {
  run(`${mcmFixture}${invitationFixture}
    assert(invoke('tab:characters').ok)
    assert(invoke('invite:johnny-silverhand').ok)
    local id = party.list()[1].id
    assert(readiness.prepareCalls == 1 and readiness.jobs[id].profileKey == 'johnny-silverhand')
    assert(#spawned == 0 and party.count() == 1 and not row('party-count'))
    local rendered
    handlers.McmUiBegin({}, 'MCM', '', 'Mods', 'Companion Manager', 'Completed: Johnny Silverhand', 1, '', true, true, 0,
      function(title, subtitle, sidebar, content, message) rendered = message end)
    assert(rendered == '', 'the banner showed progress or the raw action text: ' .. tostring(rendered))
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

test('Lip sync delay (Bluetooth) is a Voices select: Auto by default, Off and milliseconds saved for the bridge', () => {
  run(`${mcmFixture}
    assert(manager.snapshot(player).settings.audioDelay == 'auto')
    assert(invoke('tab:settings').ok)
    local item = assert(row('audioDelay'))
    assert(item.type == 'select' and item.value == 1 and #item.elements == 7)
    assert(item.elements[3] == '50 ms' and item.elements[7] == '250 ms')
    assert(registered.applyBatch('manager', {{id = 'audioDelay', value = 5}}).ok)
    assert(manager.snapshot(player).settings.audioDelay == 150)
    assert(registered.applyBatch('manager', {{id = 'audioDelay', value = 2}}).ok)
    assert(manager.snapshot(player).settings.audioDelay == 0, 'Off saves 0')
    assert(not registered.applyBatch('manager', {{id = 'audioDelay', value = 8}}).ok)
    assert(not manager.applySettings(player, {audioDelay = 75}))
    assert(manager.snapshot(player).settings.audioDelay == 0)
  `);
});

test('Developer mode adds a game voice row per ready copy that queues one vanilla VO line for gameplay', () => {
  run(`${mcmFixture}
    api.spawn('johnny-silverhand')
    members[1].state = 'ready'; members[1].baseName = members[1].name; members[1].name = members[1].name .. ' #1'
    assert(invoke('tab:party').ok); assert(not row('gamevoice:live:1'), 'hidden outside Developer mode')
    assert(registered.applyBatch('manager', {{id = 'developerMode', value = true}}).ok)
    loaded = registered.loadMod('manager')
    local item = assert(row('gamevoice:live:1'))
    assert(item.type == 'action' and item.value == 'Play' and item.label:find('game voice', 1, true))
    local queued, contexts = {}, {}
    SoundPlayVo = {new = function() return {} end}
    CName = CName or {new = function(value) return value end}
    api.actor = function(serial) return serial == 1 and {QueueEvent = function(_, event) queued[#queued + 1] = event end} or nil end
    assert(invoke('gamevoice:live:1').ok)
    assert(#queued == 0, 'nothing plays inside the menu')
    mcm.update(player, true)
    assert(#queued == 1 and queued[1].ignoreFrustumCheck and queued[1].ignoreDistanceCheck)
    contexts[1] = queued[1].voContext
    mcm.update(player, true); assert(#queued == 1, 'one press plays one line')
    assert(invoke('gamevoice:live:1').ok); mcm.update(player, true)
    assert(#queued == 2 and queued[2].voContext ~= contexts[1], 'the next press asks for another line')
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
    local back = {type = 'action'}
    assert(mcm.inspect().back.id == 'party:back')
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
    assert(total == 3, 'one row per copy only: ' .. total)
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

test('a phone dismissal and a menu dismissal share one optimistic path and a full eight-place party never shows or enforces a limit', () => {
  run(`${mcmFixture}
    for _ = 1, 8 do api.spawn('johnny-silverhand') end
    for _, member in ipairs(members) do member.state = 'ready' end
    assert(invoke('tab:characters').ok)
    -- There is no party size limit: a full party neither shows one nor refuses a ninth invitation.
    local invite = row('invite:johnny-silverhand')
    assert(not invite.disabled and invite.type == 'action')
    for _, section in ipairs(loaded.categories) do
      assert(not (section.description or ''):lower():find('eight', 1, true) and not (section.description or ''):find('8', 1, true))
    end
    local ninth = registered.invokeAction('manager', 'invite:johnny-silverhand', {})
    assert(ninth.ok == true, ninth.error)
    mcm.update(player, true); assert(#members == 9)
    for _, member in ipairs(members) do member.state = 'ready' end
    assert(invoke('characters:back').ok and invoke('tab:party').ok)
    assert(row('dismiss:live:9'))
    local accepted, message, dismissedId = mcm.party().dismissCharacter('johnny-silverhand')
    assert(accepted == true and dismissedId == 'live:9' and #members == 9)
    loaded = registered.loadMod('manager')
    assert(not row('dismiss:live:9') and row('dismiss:live:8'), 'a phone dismissal left its row on the page')
    mcm.update(player, true); assert(#members == 8)
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
      -- Auto Apply sets a draft and applies in the same instant; a person's Apply comes later.
      local autoClock = 7000
      os.clock = function() return autoClock end
      local function later() autoClock = autoClock + 1 end
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
      -- Back is a button in the bottom row: its click reaches the provider through the key MCM
      -- emits for it, and (like every MCM action) it is ignored while changes are pending.
      local function goBack(id)
        local current = mcm.inspect().back
        if not current or current.id ~= id or actual.hasDrafts(key) then return false end
        handlers.McmUiEmitAction(controller, 'convai-bottom-back')
        return actual.reloadMod(key) ~= nil
      end
      local function backSurvivesSearch(back, query)
        -- A search cannot hide the page Back: it is not a row that MCM filters.
        handlers.McmUiEmitSearch(nil, 'content', query)
        for _ = 1, 6 do mcm.update(player, false) end
        assert(mcm.inspect().back and mcm.inspect().back.id == back, 'Back is missing during a search: ' .. back)
        local renderer = {runtime = {state = {api = actual, settingsSortMode = 'file',
          searchQueries = {content = query}}, safe = function(_, value) return tostring(value or '') end}}
        for _, value in ipairs(Model.flattenSettings(renderer, {key = key})) do
          assert(not (value.kind == 'setting' and value.setting.id == key .. ':' .. back), 'Back is a filtered row')
        end
      end
      assert(actual.openMod(key))
      assert(actual.invokeAction(key .. ':tab:characters'))
      backSurvivesSearch('characters:back', 'no matching character')
      handlers.McmUiEmitSearch(nil, 'content', '')
      for _ = 1, 6 do mcm.update(player, false) end
      assert(actual.invokeAction(key .. ':invite:johnny-silverhand'))
      assert(#spawned == 0 and #mcm.inspect().party == 1 and readiness.prepareCalls == 1)
      assert(actual.getValue(key .. ':party-count') == nil)
      assert(goBack('characters:back'))
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
      assert(goBack('party:back'))
      assert(actual.invokeAction(key .. ':tab:settings'))
      publishMemory(2, {{profileKey = 'johnny-silverhand'}, {profileKey = 'person-20'}})
      assert(actual.reloadMod(key))
      assert(actual.getValue(key .. ':memory') == 'Manage' and actual.getValue(key .. ':memory-count') == nil)
      assert(actual.setDraft(key .. ':voice', false))
      assert(actual.getValue(key .. ':omniSteps') == nil)
      assert(actual.setDraft(key .. ':voiceProvider', 6))
      assert(actual.setDraft(key .. ':subtitleStyle', 2))
      assert(actual.setDraft(key .. ':battleReactions', false))
      assert(actual.getValue(key .. ':eyeContactHeight') == 3 and actual.getValue(key .. ':headFollowStrength') == 3)
      assert(actual.setDraft(key .. ':eyeContactHeight', 5))
      assert(actual.setDraft(key .. ':headFollowStrength', 4))
      assert(manager.gazeSettings().eyeContactHeight == 0 and manager.gazeSettings().headFollowStrength == 1)
      assert(actual.getValue(key .. ':developerMode') == false)
      assert(actual.setDraft(key .. ':developerMode', true))
      assert(not manager.developerMode(), 'developer draft must not change runtime feedback')
      assert(goBack('settings:back') == false)
      assert(actual.invokeAction(key .. ':memory') == false and memoryWrites() == 0)
      assert(mcm.inspect().view == 'settings', 'a pending draft allowed submenu navigation')
      -- Auto Apply: the immediate apply after a draft is refused and every draft stays pending.
      local autoOk, autoErr = actual.apply(key)
      assert(autoOk == false and tostring(autoErr):find('Change pending', 1, true), tostring(autoErr))
      assert(actual.hasDrafts(key), 'the refused automatic apply discarded the drafts')
      assert(manager.snapshot(player).settings.voiceProvider == 'pocket' and manager.snapshot(player).settings.voice == true
        and manager.snapshot(player).settings.developerMode == false and manager.snapshot(player).settings.omniSteps == 16)
      assert(files['runtime/voice-preview.json'] == nil, 'a pending voice offered a worker preview')
      -- MCM's own leave prompt and close guard key off this: drafts are pending.
      assert(goBack('settings:back') == false)
      later()
      local ok, err = actual.apply(key)
      assert(ok, err)
      assert(actual.getValue(key .. ':voice') == false and actual.getValue(key .. ':omniSteps') == nil)
      assert(manager.snapshot(player).settings.omniSteps == 16 and not actual.hasDrafts(key))
      assert(actual.getValue(key .. ':voiceProvider') == 6)
      assert(manager.snapshot(player).settings.voiceProvider == 'convai')
      assert(actual.getValue(key .. ':subtitleStyle') == 2 and manager.subtitleStyle() == 'overhead')
      assert(not manager.battleReactions() and actual.getValue(key .. ':battleReactions') == false)
      assert(manager.developerMode() and actual.getValue(key .. ':developerMode') == true)
      assert(actual.getValue(key .. ':eyeContactHeight') == 5 and actual.getValue(key .. ':headFollowStrength') == 4)
      assert(manager.gazeSettings().eyeContactHeight == 0.10 and manager.gazeSettings().headFollowStrength == 1.5)
      -- A pending voice never prepares a model; Revert discards it and Apply commits it.
      CName = {new = function(value) return value end}
      NameToString = function(value) return value end
      local function node(name, children)
        local w = {name = name, children = children or {}}
        function w:GetName() return self.name end
        function w:GetNumChildren() return #self.children end
        function w:GetWidgetByIndex(index) return self.children[index + 1] end
        function w:GetMargin() return {left = 0, top = 0, right = 0, bottom = 0} end
        function w:SetMargin() end
        function w:GetWidth() return 100 end
        function w:GetHeight() return 24 end
        return w
      end
      local barRender = node('MCMRenderRoot', {node('subtitle'), node('status'), node('mcm_content_scroll_content')})
      function controller:GetRootWidget() return node('root', {barRender}) end
      controller.McmUiAddBottomActionAt = function(_, id)
        barRender.children[#barRender.children + 1] = node('mcm_action_' .. id)
      end
      handlers.McmUiSetContentTitle(controller, 'Companion Manager')
      assert(actual.setDraft(key .. ':voiceProvider', 1))
      for _ = 1, 3 do mcm.update(player, false) end
      assert(files['runtime/voice-preview.json'] == nil, 'a pending voice offered a worker preview')
      assert(manager.snapshot(player).settings.voiceProvider == 'convai')
      assert(actual.revert(key) and actual.getValue(key .. ':voiceProvider') == 6)
      assert(actual.setDraft(key .. ':voiceProvider', 4)); later(); assert(actual.apply(key))
      assert(manager.snapshot(player).settings.voiceProvider == 'omni' and manager.snapshot(player).settings.omniSteps == 32
        and manager.snapshot(player).settings.omniReference == 'short')
      assert(actual.setDraft(key .. ':subtitles', false))
      assert(actual.setDraft(key .. ':developerMode', false))
      assert(actual.invokeAction(key .. ':permissions') == false)
      assert(actual.revert(key) and actual.getValue(key .. ':subtitles') == true)
      assert(manager.developerMode() and actual.getValue(key .. ':developerMode') == true)
      assert(actual.resetDraft(key .. ':eyeContactHeight') and actual.resetDraft(key .. ':headFollowStrength'))
      assert(manager.gazeSettings().eyeContactHeight == 0.10 and manager.gazeSettings().headFollowStrength == 1.5)
      later(); assert(actual.apply(key))
      assert(actual.getValue(key .. ':eyeContactHeight') == 3 and actual.getValue(key .. ':headFollowStrength') == 3)
      assert(manager.gazeSettings().eyeContactHeight == 0 and manager.gazeSettings().headFollowStrength == 1)
      assert(actual.invokeAction(key .. ':permissions') and mcm.inspect().view == 'permissions')
      assert(actual.getValue(key .. ':tab:settings') == nil and mcm.inspect().back.id == 'permissions:back')
      assert(goBack('permissions:back') and mcm.inspect().view == 'settings')
      assert(actual.invokeAction(key .. ':memory') and mcm.inspect().view == 'memory')
      assert(actual.getValue(key .. ':memory-count') == '2' and actual.getValue(key .. ':tab:settings') == nil)
      assert(actual.invokeAction(key .. ':memory:choose') and mcm.inspect().view == 'memory-characters')
      assert(actual.getValue(key .. ':tab:settings') == nil and mcm.inspect().back.id == 'memory:back')
      backSurvivesSearch('memory:back', 'no matching memories')
      assert(goBack('memory:back') and mcm.inspect().view == 'memory')
      assert(actual.invokeAction(key .. ':memory:choose'))
      assert(actual.invokeAction(key .. ':memory:next'))
      assert(actual.invokeAction(key .. ':memory:select:person-20'))
      assert(mcm.inspect().view == 'memory' and actual.getValue(key .. ':memory:choose') == 'Person 20' and #members == 0)
      assert(goBack('memory:settings') and mcm.inspect().view == 'settings')
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
      assert(goBack('memory:settings'))
      assert(goBack('settings:back'))
      assert(actual.invokeAction(key .. ':tab:party'))
      assert(actual.invokeAction(key .. ':dismiss:queued:1'))
      assert(#mcm.inspect().party == 0 and #spawned == 0 and readiness.cancellations['queued:1'])
      assert(goBack('party:back'))
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

test('Pocket TTS is the default while saved choices migrate to the nearest voice, and OmniVoice saves gain the long reference', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved.voiceProvider == 'pocket' and saved.omniSteps == 16 and saved.omniReference == 'long')
    assert(saved.keepPreparedVoices == true)
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
      local expected = ({convai = 'convai', pocket = 'pocket', ['pocket-student'] = 'pocket', ['Pocket-Base'] = 'pocket',
        hybrid = 'omni', omni = 'omni', omnivoice = 'omni'})[oldProvider] or 'pocket'
      local state = manager.snapshot(player).settings
      assert(state.voiceProvider == expected and saved.voiceProvider == expected)
      assert(state.omniSteps == 16 and saved.omniSteps == 16)
      -- A save from before the short/long choice has no reference: OmniVoice players land on the long one.
      assert(state.omniReference == 'long' and saved.omniReference == 'long' and state.keepPreparedVoices == true)
      assert(not state.voice and not state.subtitles and state.subtitleStyle == 'overhead')
      assert(state.followUpQuestions == nil and not state.battleReactions and not state.lootReactions)
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
    for _, oldReference in ipairs({'short', 'long', 'medium', 5, false}) do
      seed = {version = 2, voiceProvider = 'omni', omniSteps = 32, omniReference = oldReference, keepPreparedVoices = false,
        enabledByKey = {}}
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      local expected = oldReference == 'short' and 'short' or 'long'
      assert(saved.omniReference == expected and manager.snapshot(player).settings.omniReference == expected)
      assert(saved.omniSteps == 32 and saved.keepPreparedVoices == false, 'an explicit choice was reset by migration')
    end
    assert(manager.applySettings(player, {voiceProvider = 'convai', omniSteps = 16}))
    assert(manager.applySettings(player, {voiceProvider = 'hybrid'}))
    assert(saved.voiceProvider == 'omni' and saved.omniSteps == 16, 'legacy API provider lost its quality')
    local before = saved
    assert(not manager.applySettings(player, {voiceProvider = 'convai', omniSteps = 8}))
    assert(saved == before and manager.snapshot(player).settings.voiceProvider == 'omni')
  `);
});

test('party uses actual copy serials, assigns and clears profiles, reports asynchronous failures, and has no party size limit', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    for _ = 1, 8 do request('spawn:person-1') end
    assert(#members == 8 and #spawned == 8)
    -- A ninth copy is added: the party has no size limit and the page shows no capacity.
    request('spawn:person-1')
    assert(#members == 9 and #spawned == 9 and not (player.feedback or ''):find('no room', 1, true))
    assert(player.partyStatus == 'Party: 9', tostring(player.partyStatus))
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
    assert(#members == 8 and members[2].serial == 3)
    request('spawn:person-1'); assert(#members == 9 and members[9].serial == 10)
    request('dismiss:9999'); assert(#members == 9)
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
    assert(not manager.applySettings(nil, {developerMode = true}))
    assert(not manager.developerMode() and not saved.developerMode)
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
    popupStep = 1 -- the voice state file goes stale after a few seconds
    local state = {state = 'ready', provider = 'pocket', requestedProvider = 'omni', requestedOmniSteps = 16,
      requestedOmniReference = 'short', omniSteps = 32, routedProfiles = {'johnny-silverhand'}, fallback = {from = 'omni', to = 'pocket'},
      updated = popupClock * 1000}
    jsonFixtures['voice-runtime'] = state
    files['runtime/local-voice-state.json'] = 'voice-runtime'
    popupTick(false); popupTick(false)
    assert(#popups == 0, 'a paused menu consumed the one fallback notice')
    popupTick(true)
    assert(#popups == 1 and popups[1] == 'OmniVoice · Balanced is unavailable. Companions are using Pocket · Performance instead.', popups[1])
    for _ = 1, 6 do popupTick(true) end
    assert(#popups == 1, 'the same fallback was announced again')
    -- Omni recovers (the player chose it again and it loaded), then Pocket fails too.
    state.fallback, state.provider = nil, 'omni'
    for _ = 1, 3 do popupTick(true) end
    assert(#popups == 1)
    state.fallback, state.provider, state.routedProfiles = {from = 'pocket', to = 'convai'}, 'convai', {}
    for _ = 1, 3 do popupTick(true) end
    assert(#popups == 2 and popups[2] == 'Pocket · Performance is unavailable. Companions are using Convai · Cloud voice instead.', popups[2])
    assert(manager.voiceLabel('omni', 32, 'short') == 'OmniVoice · High Quality')
    assert(manager.voiceLabel('omni', 32, 'long') == 'OmniVoice · Ultra Quality')
    assert(manager.voiceLabel('omni', 16, 'short') == 'OmniVoice · Balanced')
    assert(manager.voiceLabel('omni', 16) == 'OmniVoice · Quality')
    assert(manager.voiceLabel('pocket') == 'Pocket · Performance' and manager.voiceLabel('convai') == 'Convai · Cloud voice')
  `);
});

test('a temporary fallback is announced once as not ready yet, the return to OmniVoice is silent, and giving up is announced separately', () => {
  run(`${mcmFixture}${managerPopupFixture}
    popupStep = 1 -- the voice state file goes stale after a few seconds
    local state = {state = 'ready', provider = 'pocket', requestedProvider = 'omni', requestedOmniSteps = 16,
      requestedOmniReference = 'short', omniSteps = 32, routedProfiles = {'johnny-silverhand'},
      fallback = {from = 'omni', to = 'pocket', temporary = true}, updated = popupClock * 1000}
    jsonFixtures['voice-runtime'] = state
    files['runtime/local-voice-state.json'] = 'voice-runtime'
    popupTick(false); popupTick(false)
    assert(#popups == 0, 'a paused menu consumed the one fallback notice')
    popupTick(true)
    assert(#popups == 1 and popups[1] == 'OmniVoice · Balanced is not ready yet. Companions are using Pocket · Performance for now.', popups[1])
    for _ = 1, 6 do popupTick(true) end
    assert(#popups == 1, 'the same temporary fallback was announced again')
    -- OmniVoice finished loading in the background and took over at an idle boundary: nothing is said.
    state.fallback, state.provider, state.updated = nil, 'omni', popupClock * 1000
    for _ = 1, 6 do popupTick(true) end
    assert(#popups == 1, 'the silent return to OmniVoice posted a notice')
    -- It fails again soon after (same text, inside the gate's repeat window), and finally the bridge gives up,
    -- which is a different, permanent fallback and is said once.
    state.fallback, state.provider, state.updated = {from = 'omni', to = 'pocket', temporary = true}, 'pocket', popupClock * 1000
    for _ = 1, 3 do popupTick(true) end
    assert(#popups == 1, 'the notice gate holds an identical text inside its repeat window')
    state.fallback, state.updated = {from = 'omni', to = 'pocket'}, popupClock * 1000
    for _ = 1, 3 do popupTick(true) end
    assert(#popups == 2 and popups[2] == 'OmniVoice · Balanced is unavailable. Companions are using Pocket · Performance instead.', popups[2])
  `);
});

test('Natural speech is off by default and a saved pairing with the Convai cloud voice cannot stand', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved.naturalSpeech == false and manager.naturalSpeech() == false)
    assert(manager.snapshot(player).settings.naturalSpeech == false)
    for _, case in ipairs({{'missing', 'convai'}, {true, 'convai'}, {true, 'pocket'}, {true, 'omni'}, {false, 'convai'}, {'yes', 'convai'}}) do
      seed = {version = 2, voiceProvider = case[2], enabledByKey = {}, future = {keep = 'unchanged'}}
      if case[1] ~= 'missing' then seed.naturalSpeech = case[1] end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      local on = case[1] == true
      assert(manager.naturalSpeech() == on and saved.naturalSpeech == on, tostring(case[1]))
      -- Natural speech needs a local voice: only the cloud voice with the setting on is moved, to Pocket TTS.
      local expected = (on and case[2] == 'convai') and 'pocket' or case[2]
      assert(saved.voiceProvider == expected and manager.snapshot(player).settings.voiceProvider == expected)
      assert(saved.future.keep == 'unchanged')
    end
  `);
});

test('Natural speech applies with the voice in one Apply: the cloud voice is switched to Pocket TTS, once, with a clear notice', () => {
  run(`${mcmFixture}
    local clock = 5000
    os.clock = function() return clock end
    local sent = {}
    function player:ConvaiPhoneFeedback(text) sent[#sent + 1] = text end
    assert(invoke('tab:settings').ok)
    local entry = row('naturalSpeech')
    assert(entry and entry.type == 'bool' and entry.value == false and entry.defaultValue == false, 'off by default')
    local NOTICE = 'Natural speech needs a local voice, so Companion voices was switched to ' .. manager.voiceLabel('pocket') .. '.'
    -- The menu positions of the cloud voice and of the first OmniVoice entry, wherever the list puts them.
    local CLOUD, OMNI
    for index, choice in ipairs(dofile('voice-preview.lua').CHOICES) do
      if choice.provider == 'convai' then CLOUD = index end
      if choice.provider == 'omni' and not OMNI then OMNI = index end
    end
    assert(CLOUD and OMNI)
    local function apply(...)
      clock = clock + 2
      local changes = {}
      for _, change in ipairs({...}) do changes[#changes + 1] = {id = change[1], value = change[2]} end
      return registered.applyBatch('manager', changes)
    end
    -- On with a local voice: nothing else changes and nothing is announced.
    local result = apply({'naturalSpeech', true})
    assert(result.ok and manager.naturalSpeech() and saved.naturalSpeech == true and saved.voiceProvider == 'pocket')
    assert(result.schemaChanged == false and manager.takeNaturalSpeechNotice() == nil)
    -- Choosing the cloud voice while it is on ends on Pocket TTS, and says so.
    result = apply({'voiceProvider', CLOUD})
    assert(result.ok and saved.voiceProvider == 'pocket' and saved.naturalSpeech == true)
    assert(manager.snapshot(player).settings.voiceProvider == 'pocket' and result.schemaChanged == true)
    assert(manager.snapshot(player).feedback == NOTICE, manager.snapshot(player).feedback)
    mcm.update(player, true)
    assert(#sent == 0, 'the popup is Developer-only: the Settings status line already says it')
    mcm.update(player, true); assert(#sent == 0)
    -- Developer mode shows it once, in gameplay.
    convaiNotices.configure(function() return true end)
    assert(apply({'naturalSpeech', false}).ok and apply({'voiceProvider', CLOUD}).ok)
    assert(apply({'naturalSpeech', true}).ok and saved.voiceProvider == 'pocket')
    mcm.update(player, true)
    assert(#sent == 1 and sent[1] == NOTICE, 'the notice reaches a developer in gameplay: ' .. tostring(sent[1]))
    mcm.update(player, true); assert(#sent == 1, 'announced once')
    convaiNotices.configure(function() return false end)
    -- Natural speech off: the cloud voice is allowed again.
    assert(apply({'naturalSpeech', false}).ok and not manager.naturalSpeech())
    assert(apply({'voiceProvider', CLOUD}).ok and saved.voiceProvider == 'convai' and manager.takeNaturalSpeechNotice() == nil)
    -- Turning it on while the cloud voice is saved switches the voice in the same Apply.
    result = apply({'naturalSpeech', true})
    assert(result.ok and saved.naturalSpeech == true and saved.voiceProvider == 'pocket' and result.schemaChanged == true)
    assert(manager.takeNaturalSpeechNotice() == NOTICE and manager.takeNaturalSpeechNotice() == nil)
    -- Both staged together (drafts are applied as one batch): natural speech on and the cloud voice picked.
    assert(apply({'naturalSpeech', false}).ok)
    assert(apply({'voiceProvider', CLOUD}).ok and saved.voiceProvider == 'convai')
    result = apply({'voiceProvider', CLOUD}, {'naturalSpeech', true})
    assert(result.ok and saved.voiceProvider == 'pocket' and saved.naturalSpeech == true)
    assert(manager.takeNaturalSpeechNotice() == NOTICE)
    -- Both staged together, but the voice moves to an OmniVoice choice instead: it is kept.
    assert(apply({'naturalSpeech', false}).ok and apply({'voiceProvider', CLOUD}).ok)
    result = apply({'voiceProvider', OMNI}, {'naturalSpeech', true})
    assert(result.ok and saved.voiceProvider == 'omni' and saved.naturalSpeech == true)
    assert(manager.takeNaturalSpeechNotice() == nil and result.schemaChanged == false)
    -- A failed save changes nothing and sends no notice.
    assert(apply({'naturalSpeech', false}).ok and apply({'voiceProvider', CLOUD}).ok)
    failSave = true
    result = apply({'voiceProvider', CLOUD}, {'naturalSpeech', true})
    assert(result.ok == false and saved.voiceProvider == 'convai' and not manager.naturalSpeech())
    assert(manager.takeNaturalSpeechNotice() == nil)
    failSave = false
    assert(registered.applyBatch('manager', {{id = 'naturalSpeech', value = 'yes'}}).ok == false)
  `);
});

test('Natural speech sits in the Voices category and Auto Apply cannot commit it before the person chooses Apply', () => {
  run(`${mcmFixture}
    assert(invoke('tab:settings').ok)
    local owner
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings) do if item.id == 'naturalSpeech' then owner = category end end
    end
    assert(owner and owner.id == 'voices' and row('voiceProvider') and row('naturalSpeech').label == 'Natural speech')
    assert(row('naturalSpeech').description:find('Pocket TTS', 1, true) and row('naturalSpeech').description:find('Off by default', 1, true))
    local clock = 5000
    os.clock = function() return clock end
    local listeners = {}
    nativeApi.subscribe = function(name, callback) listeners[#listeners + 1] = callback; return #listeners end
    nativeApi.unsubscribe = function() return true end
    mcm.shutdown(); mcm.install()
    for _, callback in ipairs(listeners) do callback({modKey = 'cyberpunk-convai:manager', count = 1}) end
    local refused = registered.applyBatch('manager', {{id = 'naturalSpeech', value = true}})
    assert(refused.ok == false and refused.error:find('Change pending', 1, true))
    assert(not manager.naturalSpeech() and saved.naturalSpeech == false)
    clock = clock + 2
    assert(registered.applyBatch('manager', {{id = 'naturalSpeech', value = true}}).ok and manager.naturalSpeech())
  `);
});

test('Expressive emotions is off by default and a saved pairing with the Convai cloud voice cannot stand', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved.expressiveEmotions == false and manager.expressiveEmotions() == false)
    assert(manager.snapshot(player).settings.expressiveEmotions == false)
    for _, case in ipairs({{'missing', 'convai'}, {true, 'convai'}, {true, 'pocket'}, {true, 'omni'}, {false, 'convai'}, {'yes', 'convai'}}) do
      seed = {version = 2, voiceProvider = case[2], enabledByKey = {}, future = {keep = 'unchanged'}}
      if case[1] ~= 'missing' then seed.expressiveEmotions = case[1] end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      local on = case[1] == true
      assert(manager.expressiveEmotions() == on and saved.expressiveEmotions == on, tostring(case[1]))
      local expected = (on and case[2] == 'convai') and 'pocket' or case[2]
      assert(saved.voiceProvider == expected and manager.snapshot(player).settings.voiceProvider == expected)
      assert(saved.future.keep == 'unchanged')
    end
  `);
});

test('Expressive emotions needs a local voice too: the cloud voice is switched to Pocket TTS in the same Apply, with its own notice, and both settings coexist', () => {
  run(`${mcmFixture}
    local clock = 5000
    os.clock = function() return clock end
    local sent = {}
    function player:ConvaiPhoneFeedback(text) sent[#sent + 1] = text end
    convaiNotices.configure(function() return true end) -- this popup is Developer-only (docs/NOTIFICATIONS.md)
    assert(invoke('tab:settings').ok)
    local entry = row('expressiveEmotions')
    assert(entry and entry.type == 'bool' and entry.value == false and entry.defaultValue == false, 'off by default')
    local owner
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings) do if item.id == 'expressiveEmotions' then owner = category end end
    end
    assert(owner and owner.id == 'voices' and entry.label == 'Expressive emotions')
    assert(entry.description:find('Off by default', 1, true) and entry.description:find('local voice', 1, true))
    local EMOTIONS = 'Expressive emotions need a local voice, so Companion voices was switched to ' .. manager.voiceLabel('pocket') .. '.'
    local SPEECH = 'Natural speech needs a local voice, so Companion voices was switched to ' .. manager.voiceLabel('pocket') .. '.'
    local CLOUD, OMNI
    for index, choice in ipairs(dofile('voice-preview.lua').CHOICES) do
      if choice.provider == 'convai' then CLOUD = index end
      if choice.provider == 'omni' and not OMNI then OMNI = index end
    end
    local function apply(...)
      clock = clock + 2
      local changes = {}
      for _, change in ipairs({...}) do changes[#changes + 1] = {id = change[1], value = change[2]} end
      return registered.applyBatch('manager', changes)
    end
    -- On with a local voice: nothing else changes and nothing is announced.
    local result = apply({'expressiveEmotions', true})
    assert(result.ok and manager.expressiveEmotions() and saved.expressiveEmotions == true and saved.voiceProvider == 'pocket')
    assert(result.schemaChanged == false and manager.takeNaturalSpeechNotice() == nil and not manager.naturalSpeech())
    -- Choosing the cloud voice while it is on ends on Pocket TTS and says so.
    result = apply({'voiceProvider', CLOUD})
    assert(result.ok and saved.voiceProvider == 'pocket' and saved.expressiveEmotions == true and result.schemaChanged == true)
    assert(manager.snapshot(player).feedback == EMOTIONS, manager.snapshot(player).feedback)
    mcm.update(player, true)
    assert(#sent == 1 and sent[1] == EMOTIONS and not manager.takeNaturalSpeechNotice(), tostring(sent[1]))
    -- Off: the cloud voice is allowed again. Turning it on while the cloud voice is saved switches the voice in that Apply.
    assert(apply({'expressiveEmotions', false}).ok and apply({'voiceProvider', CLOUD}).ok and saved.voiceProvider == 'convai')
    assert(manager.takeNaturalSpeechNotice() == nil)
    result = apply({'expressiveEmotions', true})
    assert(result.ok and saved.voiceProvider == 'pocket' and result.schemaChanged == true)
    assert(manager.takeNaturalSpeechNotice() == EMOTIONS)
    -- Both staged together: the setting on and the cloud voice picked, in one batch.
    assert(apply({'expressiveEmotions', false}).ok and apply({'voiceProvider', CLOUD}).ok)
    result = apply({'voiceProvider', CLOUD}, {'expressiveEmotions', true})
    assert(result.ok and saved.voiceProvider == 'pocket' and saved.expressiveEmotions == true)
    assert(manager.takeNaturalSpeechNotice() == EMOTIONS)
    -- Both settings on together stay together; the voice moves once, and the notice names Natural speech.
    assert(apply({'expressiveEmotions', false}).ok and apply({'voiceProvider', CLOUD}).ok)
    result = apply({'expressiveEmotions', true}, {'naturalSpeech', true})
    assert(result.ok and saved.voiceProvider == 'pocket' and saved.expressiveEmotions == true and saved.naturalSpeech == true)
    assert(manager.takeNaturalSpeechNotice() == SPEECH and manager.takeNaturalSpeechNotice() == nil)
    -- With Natural speech still on, turning Expressive emotions off leaves the voice rule in force for the other one.
    assert(apply({'expressiveEmotions', false}).ok and manager.naturalSpeech() and not manager.expressiveEmotions())
    result = apply({'voiceProvider', CLOUD})
    assert(result.ok and saved.voiceProvider == 'pocket' and manager.takeNaturalSpeechNotice() == SPEECH)
    -- OmniVoice is a local voice: it is kept with both on.
    result = apply({'voiceProvider', OMNI}, {'expressiveEmotions', true})
    assert(result.ok and saved.voiceProvider == 'omni' and saved.expressiveEmotions == true and saved.naturalSpeech == true)
    assert(manager.takeNaturalSpeechNotice() == nil and result.schemaChanged == false)
    -- A failed save changes nothing and sends no notice; a non-boolean is refused.
    assert(apply({'expressiveEmotions', false}).ok and apply({'naturalSpeech', false}).ok and apply({'voiceProvider', CLOUD}).ok)
    failSave = true
    result = apply({'voiceProvider', CLOUD}, {'expressiveEmotions', true})
    assert(result.ok == false and saved.voiceProvider == 'convai' and not manager.expressiveEmotions())
    assert(manager.takeNaturalSpeechNotice() == nil)
    failSave = false
    assert(registered.applyBatch('manager', {{id = 'expressiveEmotions', value = 'yes'}}).ok == false)
  `);
});

test('Auto Apply cannot commit Expressive emotions before the person chooses Apply', () => {
  run(`${mcmFixture}
    assert(invoke('tab:settings').ok)
    local clock = 5000
    os.clock = function() return clock end
    local listeners = {}
    nativeApi.subscribe = function(name, callback) listeners[#listeners + 1] = callback; return #listeners end
    nativeApi.unsubscribe = function() return true end
    mcm.shutdown(); mcm.install()
    for _, callback in ipairs(listeners) do callback({modKey = 'cyberpunk-convai:manager', count = 1}) end
    local refused = registered.applyBatch('manager', {{id = 'expressiveEmotions', value = true}})
    assert(refused.ok == false and refused.error:find('Change pending', 1, true))
    assert(not manager.expressiveEmotions() and saved.expressiveEmotions == false)
    clock = clock + 2
    assert(registered.applyBatch('manager', {{id = 'expressiveEmotions', value = true}}).ok and manager.expressiveEmotions())
  `);
});

test('Follow-up questions is off by default, works with any voice and is independent of the retired followUpQuestions key', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved.followUpInterest == false and manager.followUpInterest() == false)
    assert(manager.snapshot(player).settings.followUpInterest == false)
    assert(manager.followUpQuestions == nil, 'the retired setting has no accessor')
    for _, case in ipairs({{'missing', 'convai'}, {true, 'convai'}, {true, 'pocket'}, {true, 'omni'}, {false, 'convai'}, {'yes', 'pocket'}}) do
      seed = {version = 2, voiceProvider = case[2], enabledByKey = {}, future = {keep = 'unchanged'}}
      if case[1] ~= 'missing' then seed.followUpInterest = case[1] end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      local on = case[1] == true
      assert(manager.followUpInterest() == on and saved.followUpInterest == on, tostring(case[1]))
      -- Unlike Natural speech it needs no local voice: the saved voice is never moved because of it.
      assert(saved.voiceProvider == case[2] and manager.snapshot(player).settings.voiceProvider == case[2])
      assert(saved.future.keep == 'unchanged')
    end
    -- A saved value of the retired setting neither turns the new one on nor survives.
    seed = {version = 2, voiceProvider = 'pocket', followUpQuestions = true, enabledByKey = {}}
    files['runtime/settings.json'], saved = 'seed', nil
    manager.configure(api, profiles); manager.prepare(player)
    assert(manager.followUpInterest() == false and saved.followUpQuestions == nil and saved.followUpInterest == false)
    -- Apply keeps the choice, rejects anything but a boolean, and leaves the voice alone.
    assert(manager.applySettings(player, {followUpInterest = true}) and manager.followUpInterest() and saved.followUpInterest == true)
    assert(saved.voiceProvider == 'pocket')
    assert(manager.applySettings(player, {followUpInterest = 'yes'}) == false and manager.followUpInterest())
    assert(manager.applySettings(player, {followUpInterest = false}) and not manager.followUpInterest())
  `);
});

test('Follow-up questions sits in the Voices category after Expressive emotions, applies on its own, and joins the Speech line', () => {
  run(`${mcmFixture}
    assert(invoke('tab:settings').ok)
    local owner, order = nil, {}
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings) do
        if category.id == 'voices' then order[#order + 1] = item.id end
        if item.id == 'followUpInterest' then owner = category end
      end
    end
    assert(owner and owner.id == 'voices' and row('followUpInterest').label == 'Follow-up questions')
    assert(row('followUpInterest').description:find('Off by default', 1, true) and row('followUpInterest').description:find('now and then', 1, true))
    local at = {}
    for index, id in ipairs(order) do at[id] = index end
    assert(at.naturalSpeech < at.expressiveEmotions and at.expressiveEmotions < at.followUpInterest, 'next to the other two speech settings')
    local clock = 5000
    os.clock = function() return clock end
    local listeners = {}
    nativeApi.subscribe = function(name, callback) listeners[#listeners + 1] = callback; return #listeners end
    nativeApi.unsubscribe = function() return true end
    mcm.shutdown(); mcm.install()
    for _, callback in ipairs(listeners) do callback({modKey = 'cyberpunk-convai:manager', count = 1}) end
    local refused = registered.applyBatch('manager', {{id = 'followUpInterest', value = true}})
    assert(refused.ok == false and refused.error:find('Change pending', 1, true))
    assert(not manager.followUpInterest() and saved.followUpInterest == false)
    clock = clock + 2
    local voiceBefore = manager.snapshot(player).settings.voiceProvider
    assert(registered.applyBatch('manager', {{id = 'followUpInterest', value = true}}).ok and manager.followUpInterest())
    assert(manager.snapshot(player).settings.voiceProvider == voiceBefore, 'no voice switch, no notice')
    assert(manager.takeNaturalSpeechNotice() == nil)
  `);
});

test('Multilingual conversations is off by default and only a saved boolean is kept', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved.multilingualConversations == false and manager.multilingualConversations() == false)
    assert(manager.snapshot(player).settings.multilingualConversations == false)
    for _, case in ipairs({{'missing', false}, {true, true}, {false, false}, {'yes', false}, {1, false}}) do
      seed = {version = 2, enabledByKey = {}, future = {keep = 'unchanged'}}
      if case[1] ~= 'missing' then seed.multilingualConversations = case[1] end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      assert(manager.multilingualConversations() == case[2] and saved.multilingualConversations == case[2], tostring(case[1]))
      assert(manager.snapshot(player).settings.multilingualConversations == case[2])
      assert(saved.future.keep == 'unchanged')
    end
  `);
});

// Shared by the staged-Apply cases: the voice menu positions and a batch helper (each Apply after the Auto Apply window).
const multilingualApplyFixture = `
    local clock, wall = 5000, 1000
    os.clock = function() return clock end
    os.time = function() return wall end
    local sent = {}
    function player:ConvaiPhoneFeedback(text) sent[#sent + 1] = text end
    convaiNotices.configure(function() return true end) -- this popup is Developer-only (docs/NOTIFICATIONS.md)
    local POCKET, BALANCED, ULTRA, CLOUD
    for index, choice in ipairs(dofile('voice-preview.lua').CHOICES) do
      if choice.provider == 'pocket' then POCKET = index end
      if choice.provider == 'convai' then CLOUD = index end
      if choice.provider == 'omni' and choice.steps == 16 and choice.reference == 'short' then BALANCED = index end
      if choice.provider == 'omni' and choice.steps == 32 and choice.reference == 'long' then ULTRA = index end
    end
    assert(POCKET and BALANCED and ULTRA and CLOUD)
    local function apply(...)
      clock = clock + 2
      local changes = {}
      for _, change in ipairs({...}) do changes[#changes + 1] = {id = change[1], value = change[2]} end
      return registered.applyBatch('manager', changes)
    end
    local function pack(installed)
      jsonFixtures['voice-runtime'] = {state = 'ready', provider = 'pocket', updated = wall * 1000,
        omniPack = {installed = installed, missing = installed and {} or {'model'}}}
      files['runtime/local-voice-state.json'] = 'voice-runtime'
      manager.snapshot(player)
    end
    local SWITCH = 'Multilingual conversations needs a voice that speaks every language, so Companion voices was switched to '
    local OFF = 'Natural speech and Expressive emotions were turned off: the Convai cloud voice would read their tags aloud. With the OmniVoice pack, all three work together.'
    local NO_POCKET = 'Pocket TTS speaks only English. Turn off Multilingual conversations to choose it.'
    local NO_TAGS = 'Natural speech and Expressive emotions need the OmniVoice pack while Multilingual conversations is on: the Convai cloud voice would read their tags aloud.'
    assert(invoke('tab:settings').ok)
`;

test('Multilingual conversations sits in Conversations and is off by default', () => {
  run(`${mcmFixture}
    assert(invoke('tab:settings').ok)
    local owner
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings) do if item.id == 'multilingualConversations' then owner = category end end
    end
    local entry = row('multilingualConversations')
    assert(owner and owner.id == 'conversation-controls', 'in Conversations')
    assert(entry.type == 'bool' and entry.value == false and entry.defaultValue == false and entry.label == 'Multilingual conversations')
    assert(entry.description:find('OmniVoice · Balanced', 1, true) and entry.description:find('Off by default', 1, true))
    assert(registered.applyBatch('manager', {{id = 'multilingualConversations', value = 'yes'}}).ok == false)
    assert(not manager.applySettings(player, {multilingualConversations = 1}))
  `);
});

test('with the Omni pack, turning Multilingual on moves Pocket to OmniVoice · Balanced once; Pocket is refused while on; off keeps the voice', () => {
  run(`${mcmFixture}${multilingualApplyFixture}
    pack(true)
    assert(saved.voiceProvider == 'pocket')
    local result = apply({'multilingualConversations', true})
    assert(result.ok and result.schemaChanged == true and saved.multilingualConversations == true)
    assert(saved.voiceProvider == 'omni' and saved.omniSteps == 16 and saved.omniReference == 'short', 'the lightest Omni')
    local NOTICE = SWITCH .. 'OmniVoice · Balanced.'
    assert(manager.snapshot(player).feedback == NOTICE, manager.snapshot(player).feedback)
    mcm.update(player, true); assert(#sent == 1 and sent[1] == NOTICE, tostring(sent[1]))
    mcm.update(player, true); assert(#sent == 1, 'announced once')
    -- Pocket while it is on: refused, nothing saved, the draft stays pending.
    result = apply({'voiceProvider', POCKET})
    assert(result.ok == false and result.error == NO_POCKET and saved.voiceProvider == 'omni')
    -- Another Omni tier and the cloud voice are fine; Natural speech works with Omni.
    assert(apply({'voiceProvider', ULTRA}).ok and saved.omniSteps == 32 and saved.omniReference == 'long')
    assert(apply({'naturalSpeech', true}, {'expressiveEmotions', true}).ok and saved.voiceProvider == 'omni')
    assert(manager.takeNaturalSpeechNotice() == nil and saved.naturalSpeech and saved.expressiveEmotions)
    -- The cloud voice chosen while a tag setting is on moves to OmniVoice · Balanced, never to Pocket.
    result = apply({'voiceProvider', CLOUD})
    assert(result.ok and saved.voiceProvider == 'omni' and saved.omniSteps == 16 and saved.omniReference == 'short')
    assert(manager.takeNaturalSpeechNotice() == 'Natural speech needs a local voice, so Companion voices was switched to OmniVoice · Balanced.')
    assert(apply({'naturalSpeech', false}, {'expressiveEmotions', false}).ok)
    assert(apply({'voiceProvider', CLOUD}).ok and saved.voiceProvider == 'convai' and manager.takeNaturalSpeechNotice() == nil)
    -- Off: the voice stays as it is (no silent switch back).
    assert(apply({'multilingualConversations', false}).ok and saved.voiceProvider == 'convai')
    assert(manager.takeNaturalSpeechNotice() == nil)
    -- Off and Pocket in one batch is allowed.
    assert(apply({'multilingualConversations', true}).ok and saved.voiceProvider == 'omni', 'the saved cloud voice moves to Omni')
    assert(manager.takeNaturalSpeechNotice() == NOTICE)
    assert(apply({'multilingualConversations', false}, {'voiceProvider', POCKET}).ok and saved.voiceProvider == 'pocket')
    -- On together with Pocket in one batch is refused.
    result = apply({'multilingualConversations', true}, {'voiceProvider', POCKET})
    assert(result.ok == false and result.error == NO_POCKET and saved.multilingualConversations == false)
    -- An Omni tier is kept; a cloud voice chosen in the same Apply is kept.
    assert(apply({'voiceProvider', ULTRA}).ok)
    result = apply({'multilingualConversations', true})
    assert(result.ok and saved.voiceProvider == 'omni' and saved.omniSteps == 32 and saved.omniReference == 'long')
    assert(result.schemaChanged == false and manager.takeNaturalSpeechNotice() == nil)
    assert(apply({'multilingualConversations', false}, {'voiceProvider', POCKET}).ok)
    result = apply({'multilingualConversations', true}, {'voiceProvider', CLOUD})
    assert(result.ok and saved.voiceProvider == 'convai' and manager.takeNaturalSpeechNotice() == nil)
    -- With Natural speech on, a cloud voice chosen with it still ends on Omni (it needs a local voice).
    assert(apply({'multilingualConversations', false}, {'voiceProvider', POCKET}).ok and apply({'naturalSpeech', true}).ok)
    result = apply({'multilingualConversations', true}, {'voiceProvider', CLOUD})
    assert(result.ok and saved.voiceProvider == 'omni' and saved.naturalSpeech == true)
    assert(manager.takeNaturalSpeechNotice() == NOTICE)
  `);
});

test('without the Omni pack, Multilingual moves to the cloud voice and wins over Natural speech and Expressive emotions', () => {
  run(`${mcmFixture}${multilingualApplyFixture}
    pack(false)
    local first = apply({'naturalSpeech', true}, {'expressiveEmotions', true})
    assert(first.ok and saved.voiceProvider == 'pocket', tostring(first.error) .. ' ' .. tostring(saved.voiceProvider))
    local result = apply({'multilingualConversations', true})
    assert(result.ok and result.schemaChanged == true and saved.multilingualConversations == true, 'on: ' .. tostring(result.error))
    assert(saved.voiceProvider == 'convai' and saved.naturalSpeech == false and saved.expressiveEmotions == false,
      'cloud: ' .. tostring(saved.voiceProvider) .. ' ' .. tostring(saved.naturalSpeech))
    local NOTICE = SWITCH .. 'Convai · Cloud voice. ' .. OFF
    assert(manager.snapshot(player).feedback == NOTICE, manager.snapshot(player).feedback)
    mcm.update(player, true); assert(#sent == 1 and sent[1] == NOTICE, tostring(sent[1]))
    -- While it is on, either tag setting is refused with the reason; Pocket and Omni are refused too.
    for _, key in ipairs({'naturalSpeech', 'expressiveEmotions'}) do
      result = apply({key, true})
      assert(result.ok == false and result.error == NO_TAGS and saved[key] == false, key)
    end
    assert(apply({'voiceProvider', POCKET}).error == NO_POCKET)
    assert(apply({'voiceProvider', BALANCED}).error == 'Requires the optional OmniVoice pack (GPU)')
    -- Off: the voice stays the cloud voice and the two settings stay off.
    assert(apply({'multilingualConversations', false}).ok and saved.voiceProvider == 'convai' and not saved.naturalSpeech)
    assert(manager.takeNaturalSpeechNotice() == nil)
    -- Turning it on together with Natural speech: Multilingual wins in the same Apply.
    assert(apply({'multilingualConversations', true}, {'naturalSpeech', true}).ok)
    assert(saved.multilingualConversations and saved.voiceProvider == 'convai' and saved.naturalSpeech == false)
    assert(manager.takeNaturalSpeechNotice() == OFF, 'already on the cloud voice: only the settings notice')
    -- A failed save changes nothing.
    assert(apply({'multilingualConversations', false}, {'voiceProvider', POCKET}).ok and apply({'naturalSpeech', true}).ok)
    failSave = true
    result = apply({'multilingualConversations', true})
    assert(result.ok == false and saved.multilingualConversations == false and saved.voiceProvider == 'pocket' and saved.naturalSpeech)
    assert(manager.takeNaturalSpeechNotice() == nil)
    failSave = false
  `);
});

test('a saved Multilingual pairing with Pocket or with the cloud voice and a tag setting cannot stand', () => {
  run(`${managerFixture}
    for _, case in ipairs({
      {{voiceProvider = 'pocket'}, 'convai', false},
      {{voiceProvider = 'pocket', naturalSpeech = true}, 'convai', false},
      {{voiceProvider = 'convai', expressiveEmotions = true}, 'convai', false},
      {{voiceProvider = 'omni', naturalSpeech = true}, 'omni', true},
    }) do
      seed = {version = 2, enabledByKey = {}, multilingualConversations = true}
      for key, value in pairs(case[1]) do seed[key] = value end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      local effects = saved.naturalSpeech or saved.expressiveEmotions
      assert(saved.voiceProvider == case[2] and effects == case[3], case[1].voiceProvider)
      assert(saved.multilingualConversations == true)
    end
  `);
});

// Model browser records map to NPC archetype profiles (docs/NPC_ARCHETYPES.md).
const catalogSource = readFileSync(new URL('../mod/character-catalog.lua', import.meta.url), 'utf8');
test('Model browser maps generic records to archetypes, shows it in the row, counts talkers and invites them talking', () => {
  run(`${mcmFixture}
    local catalog = (function() ${catalogSource} end)()
    local index = catalog.buildArchetypes(catalog.ARCHETYPES)
    manager.configure(api, {{key = 'johnny-silverhand', name = 'Johnny Silverhand', records = {'Character.Silverhand'}},
      {key = 'resident-male', name = 'Night City Resident Male'}, {key = 'resident-female', name = 'Night City Resident Female'}})
    manager.configureArchetypes(index.keys, function(facts) return (catalog.classifyRecord(index, facts)) end,
      function(key) return catalog.archetypeLabel(index, key) end)
    local enum = function(name) return name and {EnumName = function() return name end} or nil end
    local function record(id, facts)
      return {GetID = function() return id end, Affiliation = function() return enum(facts.affiliation) end,
        IsCrowd = function() return facts.crowd == true end, IsChild = function() return facts.child == true end,
        CharacterType = function() return enum(facts.kind or 'Human') end, Quest = function() return enum(facts.quest) end,
        VendorID = function() return facts.vendor and {VendorType = function() return enum(facts.vendor) end} or nil end}
    end
    function TweakDB:GetRecords()
      scans = scans + 1
      return {record('Character.Silverhand', {affiliation = 'Unaffiliated'}),
        record('Character.maelstrom_grunt1_ranged1_lexington_ma', {affiliation = 'Maelstrom'}),
        record('Character.tyger_claws_gang3_katana_wa', {affiliation = 'TygerClaws'}),
        record('Character.wat_kab_ripperdoc_01', {affiliation = 'Civilian', vendor = 'RipperDoc'}),
        record('Character.CorpoWomanBag', {crowd = true, affiliation = 'Civilian'}),
        record('Character.Waitress', {crowd = true, affiliation = 'Civilian'}),
        record('Character.maxtac_rifle_ma', {affiliation = 'NCPD'}),
        record('Character.q105_valentino_ma', {affiliation = 'Valentinos'}),
        record('Character.valentinos_grunt_ma', {affiliation = 'Valentinos', quest = 'MainQuest'}),
        record('Character.maelstrom_base_android', {affiliation = 'MaelstromAndroid', kind = 'Android'}),
        record('Character.ChildPoor_ma', {crowd = true, child = true})}
    end
    assert(invoke('tab:models').ok)
    for _ = 1, 4 do mcm.update(player, false) end
    loaded = registered.loadMod('manager')
    local byRecord = {}
    for _, model in ipairs(manager.snapshot(player).models) do byRecord[model.record] = model end
    local expected = {['Character.Silverhand'] = 'johnny-silverhand',
      ['Character.maelstrom_grunt1_ranged1_lexington_ma'] = 'npc-maelstrom-male',
      ['Character.tyger_claws_gang3_katana_wa'] = 'npc-tyger-claws-female',
      ['Character.wat_kab_ripperdoc_01'] = 'npc-ripperdoc-male', ['Character.CorpoWomanBag'] = 'npc-corpo-resident-female',
      ['Character.Waitress'] = false, ['Character.maxtac_rifle_ma'] = false, ['Character.q105_valentino_ma'] = false,
      ['Character.valentinos_grunt_ma'] = false, ['Character.maelstrom_base_android'] = false, ['Character.ChildPoor_ma'] = false}
    for id, key in pairs(expected) do
      assert(byRecord[id], id)
      assert(byRecord[id].profileKey == (key or nil), id .. ' -> ' .. tostring(byRecord[id].profileKey))
    end
    local function description(record)
      for _, category in ipairs(loaded.categories) do
        for _, item in ipairs(category.settings) do
          if item.id == 'invite:' .. byRecord[record].key then return item.description end
        end
      end
    end
    assert(description('Character.maelstrom_grunt1_ranged1_lexington_ma'):find('Conversation: Maelstrom ganger (archetype)', 1, true))
    assert(description('Character.Silverhand'):find('Conversation: Johnny Silverhand', 1, true))
    assert(not description('Character.Silverhand'):find('archetype', 1, true))
    assert(description('Character.maxtac_rifle_ma'):find('No conversation profile', 1, true))
    assert(row('model-status').description:find('5 of them can talk.', 1, true))
    -- A Waitress has no gender in its name and no resident kind: it stays a silent follower.
    assert(description('Character.Waitress'):find('No conversation profile', 1, true))
    -- Invited, the copy joins as a model (nothing to prepare) and talks as the archetype once spawned.
    local key = byRecord['Character.maelstrom_grunt1_ranged1_lexington_ma'].key
    assert(invoke('invite:' .. key).ok and #spawned == 0)
    mcm.update(player, true)
    assert(members[1].key == key and members[1].profileKey == 'npc-maelstrom-male' and members[1].profileName == 'Maelstrom ganger')
    local named = byRecord['Character.Silverhand'].key
    assert(invoke('invite:' .. named).ok); mcm.update(player, true)
    assert(members[2].profileKey == 'johnny-silverhand', 'named records keep their prepared profile')
  `);
});

test('Development offers the own Convai key: off by default, free-key wording, two commands, and a status that never shows the key', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    assert(invoke('tab:settings').ok)
    local use = row('useOwnConvaiKey')
    assert(use and use.type == 'bool' and use.value == false and use.defaultValue == false)
    assert(use.description:find('free', 1, true) and use.description:find('convai.com', 1, true))
    assert(not use.description:find('embedded', 1, true) and not use.description:find('shipped', 1, true))
    assert(row('own-key-status').value == 'Not added' and row('own-key-using').value == 'The shared plan')
    assert(row('own-key:remove').disabled == true, 'there is nothing to remove yet')
    assert(row('own-key:paste').disabled ~= true)
    local first = invoke('own-key:paste')
    assert(first.ok)
    local command = jsonFixtures[files['runtime/own-key-command.json']]
    assert(command.version == 1 and command.action == 'paste' and command.id:find(':key:1', 1, true))
    assert(files['runtime/memory-command.json'] == nil, 'a key command must not use the memory channel')
    local function answer(id, state)
      local token = 'own-state-' .. id
      jsonFixtures[token] = state
      files['runtime/own-key-state.json'] = token
    end
    local idOf = function(number) return (command.id:gsub(':1$', ':' .. number)) end
    answer(idOf(2), {saved = true, tail = 'wxyz', active = 'player', result = {id = idOf(2), state = 'saved'}})
    assert(invoke('own-key:paste').ok)
    assert(row('own-key-status').value == 'Added (ends in wxyz)' and row('own-key-using').value == 'Your own key')
    assert(row('own-key:remove').disabled ~= true)
    answer(idOf(3), {saved = true, tail = 'wxyz', active = 'player', result = {id = idOf(3), state = 'invalid'}})
    assert(invoke('own-key:paste').ok)
    assert(row('own-key-status').value == 'Convai did not accept that key.')
    answer(idOf(4), {saved = false, active = 'shared', limit = {state = 'used-up', own = false}, result = {id = idOf(4), state = 'cleared'}})
    assert(invoke('own-key:remove').ok and jsonFixtures[files['runtime/own-key-command.json']].action == 'clear')
    assert(row('own-key-status').value == 'Not added' and row('own-key-using').value == 'Shared plan: limit used up')
    answer(idOf(5), {saved = true, tail = 'wxyz', active = 'player', limit = {state = 'used-up', own = true}})
    assert(invoke('own-key:paste').ok)
    assert(row('own-key-using').value == 'Your key: plan limit reached')
    -- A result belonging to an older command is not shown again.
    answer('someone-else', {saved = false, active = 'shared', result = {id = 'old:key:9', state = 'invalid'}})
    assert(invoke('own-key:paste').ok)
    assert(row('own-key-status').value == 'Not added')
    -- The switch is an ordinary saved setting.
    assert(manager.snapshot(player).settings.useOwnConvaiKey == false)
    clock = clock + 2
    assert(registered.applyBatch('manager', {{id = 'useOwnConvaiKey', value = true}}).ok)
    assert(manager.snapshot(player).settings.useOwnConvaiKey == true and saved.useOwnConvaiKey == true)
    assert(not manager.applySettings({useOwnConvaiKey = 'yes'}))
  `);
});

test('Development says when the player key runs without memory or cannot hold the conversations at all', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    local function state(value, tag)
      local token = 'own-state-' .. tag
      jsonFixtures[token] = value
      files['runtime/own-key-state.json'] = token
      assert(invoke('own-key:paste').ok) -- a command resets the status read
    end
    assert(invoke('tab:settings').ok)
    state({saved = true, tail = 'wxyz', active = 'player', memory = 'on'}, 'on')
    assert(row('own-key-using').value == 'Your own key')
    state({saved = true, tail = 'wxyz', active = 'player', memory = 'off'}, 'off')
    assert(row('own-key-using').value == 'Your own key, without memory')
    assert(manager.ownKey().memoryOff == true)
    state({saved = true, tail = 'wxyz', active = 'player', memory = 'off', limit = {state = 'memory-needed', own = true}}, 'needed')
    assert(row('own-key-using').value == 'Your key: no room for memory')
    -- A speaker limit is not a used-up plan: only a real usage limit says that.
    state({saved = true, tail = 'wxyz', active = 'player', memory = 'off'}, 'again')
    assert(row('own-key-using').value ~= 'Your key: plan limit reached' and row('own-key-using').value ~= 'Shared plan: limit used up')
    state({saved = false, active = 'shared', memory = 'on'}, 'shared')
    assert(row('own-key-using').value == 'The shared plan' and manager.ownKey().memoryOff == false)
  `);
});

test('the reply notices for the key: a used-up plan, a refused key, memory off or needed, and nothing for an ordinary reply', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  const start = init.indexOf('local function keyNoticeText'), end = init.indexOf('local function reactionCanDeliver');
  assert(start > 0 && end > start, 'the key notice functions moved');
  run(`
    local ui = {t = function(text) return text end}
    ${init.slice(start, end)}
    local function notice(reply) local id, text = keyReplyNotice(reply); return id, text end
    local id, text = notice({errorCode = 'quota-shared'})
    assert(id == 'quota-exhausted' and text:find('free API key at convai.com', 1, true) and text:find('Settings > Development', 1, true))
    assert(not text:lower():find('embedded', 1, true) and not text:lower():find('shipped', 1, true))
    id, text = notice({errorCode = 'quota-own'}); assert(id == 'quota-exhausted' and text:find('plan limit', 1, true))
    id, text = notice({errorCode = 'key-rejected'}); assert(id == 'quota-exhausted' and text:find('did not accept', 1, true))
    id, text = notice({errorCode = 'key-memory-needed'}); assert(id == 'quota-exhausted' and text:find('memory', 1, true))
    id, text = notice({errorCode = 'key-memory', error = 'x'}); assert(id == 'key-memory' and text:find('will not remember', 1, true))
    id, text = notice({keyNotice = 'memory-off', text = 'Hello'}); assert(id == 'key-memory')
    assert(notice({text = 'Hello'}) == nil and notice({error = 'plain failure'}) == nil and notice({keyNotice = 'other'}) == nil)
  `);
});
