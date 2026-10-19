import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';
import {optionUnits} from './option-units.mjs';
import {MistralProvider, MistralControl} from './mistral-key.mjs';
import {createLocalSpeech} from './local-stt-capture.mjs';
import {companionModules, companionEngine, flatNavigation, flatSpatial} from './companion-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const managerSource = readFileSync(new URL('../mod/manager.lua', import.meta.url), 'utf8');
const companionsSource = readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8');
const queueSource = readFileSync(new URL('../mod/manager-party.lua', import.meta.url), 'utf8');
const mcmSource = readFileSync(new URL('../mod/mcm.lua', import.meta.url), 'utf8');
const noticesSource = readFileSync(new URL('../mod/notices.lua', import.meta.url), 'utf8');
const entrySource = readFileSync(new URL('../mod/mcm-entry.lua', import.meta.url), 'utf8');
const voicePreviewSource = readFileSync(new URL('../mod/voice-preview.lua', import.meta.url), 'utf8');
const fontsSource = readFileSync(new URL('../mod/ui-fonts.lua', import.meta.url), 'utf8');
const mcmFontsSource = readFileSync(new URL('../mod/mcm-fonts.lua', import.meta.url), 'utf8');
const frenchUiSource = readFileSync(new URL('../mod/locales/fr.lua', import.meta.url), 'utf8');

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  // The CET module environment has no _G: match it so that class of bug fails here.
  const source = '_G = nil; ' + uiLocaleBootstrap + code;
  const status = lauxlib.luaL_dostring(state, to_luastring(source));
  let error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  // Name the failing Lua line: the message only carries its number in the generated chunk.
  const failedLine = /^\[string [^\]]*\]:(\d+):/.exec(error);
  if (failedLine) error += '\n>> ' + source.split('\n')[Number(failedLine[1]) - 1].trim().slice(0, 300);
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

// Night City Allies' Lucy and Rita (docs/NCA_FOLLOWERS_PLAN.md): the roster records only let the talk path recognise that
// mod's copy. invite = false keeps them out of every invite (Manager "Profile only", MCM unavailable, the party queue refuses).
test('a roster profile marked invite = false is talk only: no companion definition, so nothing invites our own copy', () => {
  run(`${managerFixture}
    manager.configure(api, {{key = 'judy-alvarez', name = 'Judy Alvarez', records = {'Character.Judy'}},
      {key = 'lucy-kushinada', name = 'Lucy Kushinada', invite = false,
        records = {'Character.EdgerunnersLucy_Merc', 'NCA.Character.EdgerunnersLucy_Merc', 'Character.EdgerunnersLucy'}}})
    assert(defs['judy-alvarez'] and defs['judy-alvarez'].id == 'Character.Judy', 'an ordinary roster profile is still invitable')
    assert(defs['lucy-kushinada'] == nil and manager.definition('lucy-kushinada') == nil, 'no definition for a talk-only profile')
    local queue = (function() ${queueSource} end)().new(api)
    queue.bind('player-1')
    assert(not queue.invite('lucy-kushinada') and #spawned == 0, 'the party queue refuses it')
    assert(queue.invite('judy-alvarez'))
  `);
});

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
    assert(manager.snapshot(player).settings.matureContent == false and saved.matureContent == false, 'Mature content is off by default')
    do
      -- Mature content is part of the main mod and works without the optional Mature pack; the bridge reports the pack in
      -- runtime/mistral-state.json only so the setting's help can say whether the uncensored models are installed.
      local realClock, clock = os.clock, 1000
      os.clock = function() return clock end
      local function pack(installed)
        jsonFixtures['mature-pack-' .. tostring(installed)] = {provider = 'local', effective = 'local', maturePack = installed}
        files['runtime/mistral-state.json'] = 'mature-pack-' .. tostring(installed)
        clock = clock + 2
      end
      assert(manager.mistral().maturePack == false, 'no pack until the bridge says so')
      assert(manager.applySettings(player, {matureContent = 'yes'}) == false, 'Mature content must be on or off')
      assert(saved.matureContent == false and manager.snapshot(player).settings.matureContent == false)
      pack(true)
      assert(manager.mistral().maturePack == true)
      -- Mature content needs the Local AI provider: beside a cloud provider (here the default, Convai) it is saved as off, quietly.
      local matureOk, matureProblem, matureNotice, matureReload = manager.applySettings(player, {matureContent = true})
      assert(matureOk and saved.matureContent == false and manager.snapshot(player).settings.matureContent == false, 'not on beside Convai')
      assert(matureNotice == nil and matureReload == true, 'forced off without a notice, and the open page is asked to reload')
      matureOk, matureProblem, matureNotice = manager.applySettings(player, {matureContent = true, conversationProvider = 'local'})
      assert(matureOk and saved.matureContent == true and manager.snapshot(player).settings.matureContent == true)
      assert(saved.conversationProvider == 'local' and matureNotice == nil, 'turning it on shows no notice')
      local _, _, again = manager.applySettings(player, {matureContent = true})
      assert(again == nil)
      -- The pack is not installed: the setting is still on and still works.
      pack(false)
      assert(saved.matureContent == true and manager.snapshot(player).settings.matureContent == true, 'not forced off without the pack')
      assert(manager.applySettings(player, {matureContent = false}) and saved.matureContent == false)
      local _, _, noticeNoPack = manager.applySettings(player, {matureContent = true})
      assert(noticeNoPack == nil, 'no notice with or without the pack')
      assert(saved.matureContent == true, 'Local AI is still the provider')
      assert(manager.applySettings(player, {matureContent = false}) and saved.matureContent == false)
      -- Choosing a cloud provider in the same save turns it off; so does a save that leaves one in place.
      assert(manager.applySettings(player, {matureContent = true}) and saved.matureContent == true)
      local _, _, _, providerReload = manager.applySettings(player, {conversationProvider = 'mistral'})
      assert(saved.conversationProvider == 'mistral' and saved.matureContent == false and providerReload == true)
      assert(manager.applySettings(player, {matureContent = true, conversationProvider = 'local'}) and saved.matureContent == true)
      assert(manager.applySettings(player, {conversationProvider = 'convai'}) and saved.matureContent == false)
      assert(manager.applySettings(player, {conversationProvider = 'local'}) and saved.matureContent == false, 'Local alone does not turn it back on')
      os.clock = realClock
    end
    assert(not manager.battleReactions() and manager.snapshot(player).settings.battleReactions == false, 'battle reactions default off')
    assert(not manager.lootReactions() and manager.snapshot(player).settings.lootReactions == false, 'loot reactions default off')
    assert(manager.followUpQuestions == nil and manager.snapshot(player).settings.followUpQuestions == nil)
    assert(manager.applySettings(player, {lootReactions = true}))
    assert(manager.lootReactions() and saved.lootReactions == true)
    assert(manager.applySettings(player, {battleReactions = true}))
    assert(manager.battleReactions() and saved.battleReactions == true)
    assert(manager.applySettings(player, {lootReactions = false}))
    assert(not manager.lootReactions() and saved.lootReactions == false)
    assert(manager.applySettings(player, {lootReactions = 'on'}) == false)
    assert(manager.applySettings(player, {battleReactions = false}))
    assert(not manager.battleReactions() and saved.battleReactions == false)
    assert(manager.applySettings(player, {battleReactions = 'on'}) == false)
    assert(manager.applySettings(player, {voice = false, subtitleStyle = 'overhead', voiceProvider = 'convai', expressiveEmotions = false, enabledByKey = {['johnny-silverhand'] = false}}))
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
    assert(manager.applySettings(player, {subtitleStyle = 'dialogue', voiceProvider = 'convai', expressiveEmotions = false, subtitles = false}))
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
    assert(not row('permissions'), 'Who can talk is gone from the Settings page')
    assert(not invoke('permissions').ok and mcm.inspect().view == 'settings', 'the removed permissions page stayed callable')
    for _, page in ipairs({'relationships', 'memory'}) do
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
      if effective > 7 then effective = 1 elseif effective < 1 then effective = 7 end
    end
    local emit = function(forward)
      if handlers.McmUiEmitStep then return handlers.McmUiEmitStep(selector, forward, wrapped) end
      return wrapped(forward)
    end
    emit(false)
    assert(effective == 1 and forwarded == 0, 'left at Pocket TTS must not wrap right')
    -- Without developer mode the list is seven entries long (the Inworld voice is a developer-mode voice, listed last).
    for _, expected in ipairs({2, 3, 4, 5, 6, 7}) do emit(true); assert(effective == expected and forwarded == expected - 1) end
    emit(true)
    assert(effective == 7 and forwarded == 6, 'right at Convai must not wrap left')
    for _, expected in ipairs({6, 5, 4, 3, 2, 1}) do emit(false); assert(effective == expected and forwarded == 13 - expected) end
    emit(false); assert(effective == 1 and forwarded == 12, 'left at Pocket TTS must not wrap right')
    assert(row('voiceProvider').defaultValue == 1)
    local elements = row('voiceProvider').elements
    assert(#elements == 7 and elements[1] == 'Pocket · Performance')
    assert(elements[2] == 'OmniVoice · Balanced' and elements[3] == 'OmniVoice · Quality')
    assert(elements[4] == 'OmniVoice · High Quality' and elements[5] == 'OmniVoice · Ultra Quality')
    assert(elements[6] == 'Voxtral · needs Mistral key' and elements[7] == 'Convai · Cloud voice')
    assert(row('omniSteps') == nil and row('omniReference') == nil, 'retired quality steps remain in the active menu')
    assert(row('keepPreparedVoices') == nil and row('prepared-voices') == nil and row('prepared-voices:open') == nil, 'prepared voices have no row: they are always kept')
    assert(manager.snapshot(player).settings.keepPreparedVoices == true)
    handlers.McmUiConfigureBase(selector, controller, 'another-mod:settings:voiceProvider')
    emit(false)
    assert(effective == 7 and forwarded == 13, 'foreign selector behavior must pass through')
  `);
});

test('local voice previews carry the effective seven-choice draft and cancel on Revert, Apply or leaving the page', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(manager.applySettings(player, {voiceProvider = 'convai', expressiveEmotions = false}))
    local committed = saved
    local preview = (function() ${voicePreviewSource} end)().new({now = function() return 1000 end})
    -- Select order: 1 Pocket Performance, 2 Omni Balanced (16 short), 3 Omni Quality (16 long), 4 Omni High Quality (32 short), 5 Omni Ultra Quality (32 long), 6 Mistral cloud voice (Voxtral), 7 Convai Cloud voice.
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
    assert(manager.applySettings(player, {voiceProvider = 'convai', expressiveEmotions = false})); pending = true; changed()
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
    -- The click returns to the parent page. With pending changes it does what Esc does: MCM's own "Unsaved changes" dialog is
    -- asked for (McmUiEmitClosing, the call Esc ends in), the page stays, and a click while that dialog is open or within 2 s asks nothing more.
    local clock, asked = 700, 0
    os.clock = function() return clock end
    controller.McmUiEmitClosing = function() asked = asked + 1 end
    drafts = true; handlers.McmUiEmitAction(controller, 'convai-bottom-back')
    assert(mcm.inspect().view == 'settings' and asked == 1, 'Back with pending changes did not open the confirmation')
    clock = clock + 0.5; handlers.McmUiEmitAction(controller, 'convai-bottom-back')
    assert(mcm.inspect().view == 'settings' and asked == 1, 'a second click asked again within the window')
    clock = clock + 5; handlers.McmUiEmitAction(controller, 'convai-bottom-back')
    assert(mcm.inspect().view == 'settings' and asked == 2, 'Cancel then Back did not ask again')
    -- Apply or Discard clears the changes: Back goes back as usual.
    drafts = false; handlers.McmUiEmitAction(controller, 'convai-bottom-back')
    assert(mcm.inspect().view == 'home' and asked == 2, 'Back with nothing pending did not go back')
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
        tostring(s.relationshipModes['judy-alvarez']), tostring(s.conversationProvider), tostring(s.useOwnConvaiKey),
        tostring(s.autoConnectNearby)}, '|')
    end
    local before, writes = snapshotOf(), #fileWrites
    -- One setting of every kind: bool, select, voice, gaze, language, relationship, conversation.
    for _, change in ipairs({{'voiceProvider', 3}, {'voiceProvider', 2}, {'voiceProvider', 7}, {'voice', false}, {'subtitles', false},
        {'subtitleStyle', 2}, {'battleReactions', false}, {'lootReactions', false}, {'bodyGestures', true},
        {'developerMode', true}, {'eyeContactHeight', 5}, {'headFollowStrength', 4}, {'uiLanguage', 2},
        {'relationship:judy-alvarez', 2}, {'conversationProvider', 2}, {'autoConnectNearby', true}}) do
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
    local applied = registered.applyBatch('manager', {{id = 'voiceProvider', value = 7}, {id = 'expressiveEmotions', value = false}, {id = 'subtitles', value = false},
      {id = 'developerMode', value = true}, {id = 'eyeContactHeight', value = 5}, {id = 'conversationProvider', value = 2}})
    assert(applied.ok and applied.atomic)
    local after = manager.snapshot(player).settings
    assert(after.voiceProvider == 'convai' and not after.subtitles and after.developerMode)
    assert(after.conversationProvider == 'convai' and after.useOwnConvaiKey == true, 'the Convai API key entry sets both stored settings')
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
    local pending = 7
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
    assert(not mcm.inspect().presentation.pending and mcm.inspect().presentation.restyling == 0,
      'another controller queued styling on this page')
    handlers.OnUninitialize(reference(202))
    assert(mcm.inspect().presentation.active, 'another controller cleared the current page')
    handlers.McmUiSetManagedLabelState(reference(), 'new-toggle', false, true)
    assert(mcm.inspect().presentation.restyling == 1, 'a fresh wrapper lost native menu ownership')
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
    for _, write in ipairs(fileWrites) do if write.path == 'runtime/memory-command.json' then count = count + 1 end end
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
  -- The settings integration runs its gameplay work on a 0.25 s tick: every popup tick is longer.
  local popupHighRes = 5000
  os.clock = function() return popupHighRes end
  function player:ConvaiPhoneFeedback(message)
    assert(not nativeCallback, 'manager action callback posted a native popup')
    popups[#popups + 1] = message
  end
  -- One tick is four seconds: longer than the notice board's minimum show time (3 s)
  -- before routine progress and the next stage show, so existing flows still see each stage.
  local function popupTick(worldReady)
    popupClock, popupHighRes = popupClock + popupStep, popupHighRes + popupStep
    mcm.update(player, worldReady == true)
  end
  -- What a companion waits for is the loading notice's line (the real clock is not this fixture's, so the loading notice
  -- does not show here; the 'preparing notice' tests below drive it). No ordinary popup carries a preparing line.
  local function developer(enabled)
    assert(registered.applyBatch('manager', {{id = 'developerMode', value = enabled == true}}).ok)
  end
`;

test('with Developer mode on, a manager invitation posts no ordinary notice while it prepares, then joined, and no joining step', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok)
    nativeCallback = true; assert(invoke('invite:johnny-silverhand').ok); nativeCallback = false
    assert(#popups == 0, 'invitation posted a popup inside its native action callback')
    for _ = 1, 6 do popupTick(false) end
    assert(#popups == 0, 'a preparing popup was posted: ' .. tostring(popups[1]))
    readiness.receipts['queued:1'] = {state = 'connecting'}; popupTick(false)
    assert(#popups == 0, 'connecting posted a popup: ' .. tostring(popups[#popups]))
    readiness.receipts['queued:1'] = {state = 'ready'}; popupTick(false)
    assert(#popups == 0, 'the ready line posted a popup: ' .. tostring(popups[#popups]))
    assert(#spawned == 0)
    popupTick(true)
    assert(#popups == 0 and #spawned == 1, 'the joining step posted a popup: ' .. tostring(popups[#popups]))
    popupTick(true); assert(#popups == 0)
    members[1].state = 'ready'; popupTick(true)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand joined your group.', tostring(popups[#popups]))
    for _ = 1, 5 do popupTick(true) end
    assert(#popups == 1, 'the joined notice repeated')
  `);
});

test('a ticket first seen ready posts only joined', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    readiness.receipts['queued:1'] = {state = 'ready'}  -- ready before the board first looks
    popupTick(false); popupTick(false)
    assert(#popups == 0, 'a ticket first seen ready posted a notice: ' .. tostring(popups[1]))
    popupTick(true); assert(#spawned == 1 and #popups == 0)
    members[1].state = 'ready'; popupTick(true)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand joined your group.', tostring(popups[#popups]))
  `);
});

test('leaving the manager shows only an unresolved failure in gameplay, and keeps phone invitations independent', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    popupTick(false)
    readiness.receipts['queued:1'] = {state = 'connecting'}
    -- Resume inside the same clock second: do not reuse the paused memory sample.
    mcm.update(player, true)
    assert(#popups == 0, 'gameplay presented a preparing popup: ' .. tostring(popups[#popups]))
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

test('duplicate manager copies post no preparing popup, and a world reset leaves nothing behind', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok); popupTick(false)
    assert(invoke('invite:johnny-silverhand').ok); popupTick(false)
    assert(#popups == 0, 'a copy posted a preparing popup: ' .. tostring(popups[1]))
    assert(party.dismiss('queued:2')); popupTick(false)
    -- The older copy is still in flight: its later stages are not posted.
    readiness.receipts['queued:1'] = {state = 'connecting'}; popupTick(false)
    assert(#popups == 0, 'the older copy posted progress: ' .. tostring(popups[#popups]))
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

test('Talk to story characters is off by default, offered under Conversations and saved with the settings', () => {
  run(`${mcmFixture}
    assert(manager.storyConversations() == false and manager.snapshot(player).settings.storyConversations == false, 'a missing key is off')
    assert(invoke('tab:settings').ok)
    local story = assert(row('storyConversations'), 'the setting is not offered')
    assert(story.type == 'bool' and story.value == false and story.defaultValue == false and story.capabilities.draft)
    assert(story.label == 'Talk to story characters')
    local conversations
    for _, category in ipairs(loaded.categories) do if category.id == 'conversation-controls' then conversations = category end end
    local found = false
    for _, item in ipairs(conversations.settings) do if item.id == 'storyConversations' then found = true end end
    assert(found, 'the setting is not in the Conversations section')
    assert(saved.storyConversations == false, 'a new install saves the default Off')
    assert(registered.applyBatch('manager', {{id = 'storyConversations', value = true}}).ok and manager.storyConversations() == true and saved.storyConversations == true, 'an explicit On is kept')
    loaded = registered.loadMod('manager'); assert(row('storyConversations').value == true)
    assert(registered.applyBatch('manager', {{id = 'storyConversations', value = false}}).ok)
    assert(manager.storyConversations() == false and saved.storyConversations == false, 'an explicit Off is kept')
    assert(manager.snapshot(player).settings.storyConversations == false)
    loaded = registered.loadMod('manager'); assert(row('storyConversations').value == false)
    -- Only a boolean is accepted, and the neighbouring setting is not disturbed.
    assert(not manager.applySettings(player, {storyConversations = 'yes'}) and manager.storyConversations() == false)
    assert(manager.archetypeConversations() == true)
    assert(registered.applyBatch('manager', {{id = 'storyConversations', value = true}}).ok and manager.storyConversations())
  `);
});

test('Johnny in your head is off by default, offered under Conversations and saved; his standing shows only while it is on', () => {
  run(`${mcmFixture}
    assert(manager.johnnyInHead() == false and manager.snapshot(player).settings.johnnyInHead == false, 'a missing key is off')
    assert(saved.johnnyInHead == false, 'a new install saves the default Off')
    assert(invoke('tab:settings').ok)
    local johnny = assert(row('johnnyInHead'), 'the setting is not offered')
    assert(johnny.type == 'bool' and johnny.value == false and johnny.defaultValue == false and johnny.capabilities.draft)
    assert(johnny.label == 'Johnny in your head')
    assert(row('johnnyStanding') == nil, 'no standing row while the setting is off')
    local conversations
    for _, category in ipairs(loaded.categories) do if category.id == 'conversation-controls' then conversations = category end end
    local at, standingAt, last
    for index, item in ipairs(conversations.settings) do
      if item.id == 'johnnyInHead' then at = index end
      if item.id == 'johnnyStanding' then standingAt = index end
      last = item.id
    end
    assert(at, 'the setting is not in the Conversations section')
    assert(last == 'holocallLiveImage', 'the rows after it are all still there')
    -- On: the standing is read (once per draw) and shown right under the setting; the rows after it are kept.
    local reads = 0
    convaiJohnnyStanding = function() reads = reads + 1; return 'grudging' end
    assert(registered.applyBatch('manager', {{id = 'johnnyInHead', value = true}}).ok and manager.johnnyInHead() == true and saved.johnnyInHead == true, 'an explicit On is kept')
    loaded = registered.loadMod('manager'); assert(row('johnnyInHead').value == true)
    local standing = assert(row('johnnyStanding'), 'the standing row is shown while the setting is on')
    assert(standing.value == 'Grudging respect' and standing.label == 'Johnny’s standing' and standing.capabilities.write == false)
    assert(reads >= 1)
    for _, category in ipairs(loaded.categories) do if category.id == 'conversation-controls' then conversations = category end end
    for index, item in ipairs(conversations.settings) do
      if item.id == 'johnnyInHead' then at = index end
      if item.id == 'johnnyStanding' then standingAt = index end
      last = item.id
    end
    assert(standingAt == at + 1 and last == 'holocallLiveImage')
    -- A stage the page does not know, or a failing read, says Unknown and never breaks the page.
    convaiJohnnyStanding = function() error('no game') end
    loaded = registered.loadMod('manager'); assert(row('johnnyStanding').value == 'Unknown')
    convaiJohnnyStanding = function() return 'before' end
    loaded = registered.loadMod('manager'); assert(row('johnnyStanding').value == 'Not in your head yet')
    convaiJohnnyStanding = nil
    loaded = registered.loadMod('manager'); assert(row('johnnyStanding') == nil, 'no row without the reader')
    assert(registered.applyBatch('manager', {{id = 'johnnyInHead', value = false}}).ok)
    assert(manager.johnnyInHead() == false and saved.johnnyInHead == false, 'an explicit Off is kept')
    loaded = registered.loadMod('manager'); assert(row('johnnyInHead').value == false)
    -- Only a boolean is accepted, and the neighbouring setting is not disturbed.
    assert(not manager.applySettings(player, {johnnyInHead = 'yes'}) and manager.johnnyInHead() == false)
    assert(manager.storyConversations() == false)
  `);
});

test('Johnny speaks up is Off by default, a three-way select under Conversations, and saved', () => {
  run(`${mcmFixture}
    assert(manager.johnnyRemarks() == 'off' and manager.snapshot(player).settings.johnnyRemarks == 'off', 'a missing key is off')
    assert(saved.johnnyRemarks == 'off', 'a new install saves the default Off')
    assert(invoke('tab:settings').ok)
    local remarks = assert(row('johnnyRemarks'), 'the setting is not offered')
    assert(remarks.type == 'select' and remarks.value == 1 and remarks.defaultValue == 1 and remarks.label == 'Johnny speaks up')
    assert(#remarks.elements == 3 and remarks.elements[1] == 'Off' and remarks.elements[2] == 'Rare' and remarks.elements[3] == 'Normal')
    local conversations, at, remarksAt
    for _, category in ipairs(loaded.categories) do if category.id == 'conversation-controls' then conversations = category end end
    for index, item in ipairs(conversations.settings) do
      if item.id == 'johnnyInHead' then at = index end
      if item.id == 'johnnyRemarks' then remarksAt = index end
    end
    assert(remarksAt == at + 1, 'right under Johnny in your head')
    assert(registered.applyBatch('manager', {{id = 'johnnyRemarks', value = 3}}).ok and manager.johnnyRemarks() == 'normal' and saved.johnnyRemarks == 'normal')
    loaded = registered.loadMod('manager'); assert(row('johnnyRemarks').value == 3)
    assert(registered.applyBatch('manager', {{id = 'johnnyRemarks', value = 2}}).ok and manager.johnnyRemarks() == 'rare')
    assert(not registered.applyBatch('manager', {{id = 'johnnyRemarks', value = 4}}).ok and manager.johnnyRemarks() == 'rare')
    assert(not manager.applySettings(player, {johnnyRemarks = 'often'}) and manager.johnnyRemarks() == 'rare')
    assert(registered.applyBatch('manager', {{id = 'johnnyRemarks', value = 1}}).ok and manager.johnnyRemarks() == 'off' and saved.johnnyRemarks == 'off')
    assert(manager.johnnyInHead() == false, 'the neighbouring setting is not disturbed')
  `);
});

test('Johnnys hologram is Off by default, a switch under Conversations right after Johnny speaks up, and saved', () => {
  run(`${mcmFixture}
    assert(manager.johnnyHologram() == false and manager.snapshot(player).settings.johnnyHologram == false, 'a missing key is off')
    assert(saved.johnnyHologram == false, 'a new install saves the default Off')
    assert(invoke('tab:settings').ok)
    local hologram = assert(row('johnnyHologram'), 'the setting is not offered')
    assert(hologram.type == 'bool' and hologram.value == false and hologram.defaultValue == false and hologram.label == 'Johnny’s hologram')
    local conversations, remarksAt, hologramAt, last
    for _, category in ipairs(loaded.categories) do if category.id == 'conversation-controls' then conversations = category end end
    for index, item in ipairs(conversations.settings) do
      if item.id == 'johnnyRemarks' then remarksAt = index end
      if item.id == 'johnnyHologram' then hologramAt = index end
      last = item.id
    end
    assert(hologramAt == remarksAt + 1, 'right under Johnny speaks up')
    assert(last == 'holocallLiveImage', 'the rows after it are all still there')
    assert(registered.applyBatch('manager', {{id = 'johnnyHologram', value = true}}).ok and manager.johnnyHologram() == true and saved.johnnyHologram == true)
    loaded = registered.loadMod('manager'); assert(row('johnnyHologram').value == true)
    manager.reset(); manager.configure(api, profiles)
    assert(manager.johnnyHologram() == true, 'an explicit On survives a reload')
    assert(not manager.applySettings(player, {johnnyHologram = 'yes'}) and manager.johnnyHologram() == true, 'only a boolean')
    assert(not manager.applySettings(player, {johnnyHologram = 1}) and manager.johnnyHologram() == true)
    assert(registered.applyBatch('manager', {{id = 'johnnyHologram', value = false}}).ok and manager.johnnyHologram() == false and saved.johnnyHologram == false)
    assert(manager.johnnyInHead() == false and manager.johnnyRemarks() == 'off', 'the neighbouring settings are not disturbed')
  `);
});

test('the live holocall picture is on by default, offered under Conversations, and an explicit Off is kept', () => {
  run(`${mcmFixture}
    assert(manager.holocallLiveImage() == true and manager.snapshot(player).settings.holocallLiveImage == true)
    assert(invoke('tab:settings').ok)
    local live = assert(row('holocallLiveImage'), 'the setting is not offered')
    assert(live.type == 'bool' and live.value == true and live.defaultValue == true)
    assert(registered.applyBatch('manager', {{id = 'holocallLiveImage', value = false}}).ok)
    assert(manager.holocallLiveImage() == false and saved.holocallLiveImage == false and saved.holocallLiveImageChosen == true)
    manager.reset(); manager.configure(api, profiles)
    assert(manager.holocallLiveImage() == false, 'a chosen Off survives a reload')
    assert(registered.applyBatch('manager', {{id = 'holocallLiveImage', value = true}}).ok and manager.holocallLiveImage())
  `);
});

test('Companions can see has no setting any more: no row, an old saved companionVision (even false) is dropped on load, and an Apply for it is refused', () => {
  run(`${managerFixture}
    seed = {version = 2, subtitleStyle = 'dialogue', voiceProvider = 'convai', omniSteps = 16, enabledByKey = {}, companionVision = false}
    for _, profile in ipairs(profiles) do seed.enabledByKey[profile.key] = true end
    files['runtime/settings.json'], saved = 'seed', nil
    manager.reset(); manager.configure(api, profiles)
    assert(manager.snapshot(player).settings.companionVision == nil, 'the retired key is still in the snapshot')
    assert(saved and saved.companionVision == nil, 'the retired key was not dropped from settings.json')
    assert(not manager.applySettings(player, {companionVision = true}) and manager.snapshot(player).settings.companionVision == nil)
  `);
  run(`${mcmFixture}
    assert(invoke('tab:settings').ok)
    assert(row('companionVision') == nil, 'the setting is still offered')
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings or {}) do assert(item.label ~= 'Companions can see' and item.id ~= 'companionVision') end
    end
    local result = registered.applyBatch('manager', {{id = 'companionVision', value = false}})
    assert(result.ok == false, 'an Apply for the removed row was accepted')
  `);
});

test('Voice status names the voice that speaks: Voxtral and Inworld say so, only the Convai voice says Convai voices', () => {
  run(`${mcmFixture}
    local clock = 1000
    os.time = function() return clock end
    local n = 0
    local function status(state)
      clock, n = clock + 20, n + 1
      state.updated = clock * 1000
      jsonFixtures['voice-status-' .. n] = state
      files['runtime/local-voice-state.json'] = 'voice-status-' .. n
      manager.snapshot(player)
      loaded = registered.loadMod('manager')
      return row('voice-status').value
    end
    assert(invoke('tab:settings').ok)
    assert(status({state = 'remote', provider = 'convai', requestedProvider = 'convai'}) == 'Convai voices · Local model unloaded')
    assert(status({state = 'remote', provider = 'pocket', requestedProvider = 'pocket', cloudVoice = 'voxtral'}) == 'Voxtral cloud voice · Local model unloaded')
    assert(status({state = 'remote', provider = 'pocket', requestedProvider = 'pocket', cloudVoice = 'inworld'}) == 'Inworld cloud voice · Local model unloaded')
    -- Switching between the two cloud voices changes only cloudVoice: the row must still follow.
    assert(status({state = 'remote', provider = 'pocket', requestedProvider = 'pocket', cloudVoice = 'voxtral'}) == 'Voxtral cloud voice · Local model unloaded')
    -- A cloud voice that fell back to Convai is the Convai voice speaking.
    local fell = status({state = 'remote', provider = 'pocket', requestedProvider = 'pocket', cloudVoice = 'voxtral',
      fallback = {from = 'voxtral', to = 'convai', temporary = false, reason = 'no-key'}})
    assert(fell:find('Using', 1, true) and fell:find('Convai', 1, true) and not fell:find('Voxtral cloud voice', 1, true), fell)
    assert(status({state = 'ready', provider = 'pocket', requestedProvider = 'pocket'}) == 'Ready')
  `);
});

test('Names for passers-by has no setting any more: it is not offered, and a saved npcNames value is ignored', () => {
  run(`${mcmFixture}
    assert(manager.npcNames == nil and manager.snapshot(player).settings.npcNames == nil)
    assert(invoke('tab:settings').ok)
    assert(row('npcNames') == nil, 'the setting is still offered')
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings or {}) do assert(item.id ~= 'npcNames' and item.label ~= 'Names for passers-by') end
    end
    assert(not manager.applySettings(player, {npcNames = false}) or manager.snapshot(player).settings.npcNames == nil)
  `);
});

test('a saved live-picture false that the player never chose (the first version\'s default) becomes the new default, true', () => {
  run(`${managerFixture}
    for _, case in ipairs({{false, nil, true}, {false, false, true}, {false, true, false}, {true, true, true}, {nil, nil, true}}) do
      seed = {version = 2, subtitleStyle = 'dialogue', voiceProvider = 'convai', omniSteps = 16, enabledByKey = {},
        holocallLiveImage = case[1], holocallLiveImageChosen = case[2]}
      for _, profile in ipairs(profiles) do seed.enabledByKey[profile.key] = true end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.reset(); manager.configure(api, profiles)
      assert(manager.holocallLiveImage() == case[3], 'live=' .. tostring(case[1]) .. ' chosen=' .. tostring(case[2]))
    end
  `);
});

test('invitations made together post no progress, then one joined summary', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    popupStep = 11
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok); popupTick(false)
    assert(invoke('invite:person-1').ok); popupTick(false)
    assert(#popups == 0, 'a preparing popup was posted: ' .. tostring(popups[1]))
    readiness.receipts['queued:1'] = {state = 'connecting'}; popupTick(false)
    readiness.receipts['queued:2'] = {state = 'connecting'}; popupTick(false)
    readiness.receipts['queued:1'] = {state = 'ready'}; readiness.receipts['queued:2'] = {state = 'ready'}
    popupTick(false)
    assert(#popups == 0, 'progress was posted: ' .. tostring(popups[#popups]))
    popupTick(true)
    assert(#spawned == 2 and #popups == 0, 'the routine joining step posted')
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

test('a failure hidden by the menu is posted once in gameplay', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok); popupTick(false)
    mcm.update(player, true)
    for _ = 1, 3 do popupTick(true); popupTick(false) end
    popupTick(true); assert(#popups == 0, 'reopening the menu posted a preparing popup')
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

test('a quick manager invitation posts only joined, however long the wait', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    popupStep = 0.2
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    popupTick(false)
    readiness.receipts['queued:1'] = {state = 'connecting'}; popupTick(false)
    assert(#popups == 0, 'routine progress showed to a player: ' .. tostring(popups[#popups]))
    readiness.receipts['queued:1'] = {state = 'ready'}; popupTick(false)
    assert(#popups == 0, 'the ready line showed to a player: ' .. tostring(popups[#popups]))
    popupTick(true); assert(#spawned == 1 and #popups == 0)
    members[1].state = 'ready'
    for _ = 1, 30 do popupTick(true) end
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand joined your group.', 'the joined line did not show: ' .. tostring(popups[#popups]))
    -- A slower invitation posts nothing but its outcome either.
    popupStep = 11
    assert(invoke('invite:person-1').ok)
    popupTick(false); popupTick(false)
    readiness.receipts['queued:2'] = {state = 'ready'}; popupTick(false)
    assert(#popups == 1, 'a slow invitation posted progress: ' .. tostring(popups[#popups]))
  `);
});

test('a player sees only joined, and Developer mode adds no joining step', () => {
  run(`${mcmFixture}${invitationFixture}${managerPopupFixture}
    assert(not manager.developerMode())
    popupStep = 11
    assert(invoke('tab:characters').ok)
    nativeCallback = true; assert(invoke('invite:johnny-silverhand').ok); nativeCallback = false
    popupTick(false)
    assert(#popups == 0, 'a preparing popup for a player: ' .. tostring(popups[1]))
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
    -- Turning Developer mode on adds no joining step: only the joined line follows.
    developer(true); popupTick(true)
    assert(#popups == 0, 'turning Developer mode on posted the joining step: ' .. tostring(popups[#popups]))
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
    readiness.receipts['queued:1'] = {state = 'ready'}
    party.flush(); members[1].state = 'ready'
    mcm.update(player, true)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand joined your group.', tostring(popups[#popups]))
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
    assert(#spawned == 0 and #popups == 0, 'the deferred spawn posted a joining step: ' .. tostring(popups[#popups]))
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
    assert(#elements == 7 and elements[1] == 'Pocket · Performance' and elements[7] == 'Convai · Cloud voice')
    -- The entries keep plain labels (greyed out by the page, see the stepper test); the row's name says why.
    assert(elements[2] == 'OmniVoice · Balanced', elements[2])
    for index = 2, 5 do
      assert(elements[index]:find('OmniVoice', 1, true) and not elements[index]:find('needs pack', 1, true), 'entry ' .. index)
      assert(mcm.optionUnits(elements[index]) <= mcm.OPTION_BUDGET, 'entry ' .. index .. ' must stay short enough not to run over the arrows')
    end
    assert(row('voiceProvider').label == 'Companion voices (no Omni pack)', row('voiceProvider').label)
    assert(row('voice-pack') == nil, 'the OmniVoice pack has no row of its own')
    local before = saved.voiceProvider
    for index = 2, 5 do
      local result = registered.applyBatch('manager', {{id = 'voiceProvider', value = index}})
      assert(result.ok == false and result.error == 'Requires the optional OmniVoice pack (GPU)', 'entry ' .. index)
      assert(saved.voiceProvider == before)
    end
    assert(not manager.applySettings(player, {voiceProvider = 'omni'}))
    -- Pocket and Convai stay selectable (Expressive emotions, on by default, would move the cloud voice back to Pocket).
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 7}, {id = 'expressiveEmotions', value = false}}).ok and saved.voiceProvider == 'convai')
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 1}}).ok and saved.voiceProvider == 'pocket')
    -- The pack appears (installed while the game runs): the entries become plain labels and can be applied.
    clock = clock + 20
    -- Identical file text is one state (the manager decodes it once), so a changed state is a changed text.
    jsonFixtures['voice-runtime-pack'] = {state = 'ready', provider = 'pocket', omniPack = {installed = true, missing = {}},
      updated = clock * 1000}
    files['runtime/local-voice-state.json'] = 'voice-runtime-pack'
    manager.snapshot(player)
    loaded = registered.loadMod('manager')
    assert(row('voiceProvider').elements[2] == 'OmniVoice · Balanced')
    assert(row('voiceProvider').label == 'Companion voices', 'the pack is installed: the row is plain again')
    assert(row('voice-pack') == nil)
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 2}}).ok)
    assert(saved.voiceProvider == 'omni' and saved.omniSteps == 16 and saved.omniReference == 'short')
  `);
});

test('the Mistral cloud voice (Voxtral) says it needs a Mistral key and cannot be applied without one; with a key it applies beside any conversation provider', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    local function key(tag, value)
      jsonFixtures['mistral-' .. tag] = value
      files['runtime/mistral-state.json'] = 'mistral-' .. tag
      clock = clock + 2
    end
    local NEEDS = 'Voxtral · needs Mistral key'
    assert(invoke('tab:settings').ok)
    loaded = registered.loadMod('manager')
    local elements = row('voiceProvider').elements
    assert(#elements == 7 and elements[6] == NEEDS and elements[7] == 'Convai · Cloud voice', elements[6])
    assert(manager.voiceLabel('voxtral') == 'Mistral cloud voice (Voxtral)')
    local before = saved.voiceProvider
    local result = registered.applyBatch('manager', {{id = 'voiceProvider', value = 6}})
    assert(result.ok == false and result.error == 'Requires a Mistral key (add it in Settings > Conversation provider)', result.error)
    assert(saved.voiceProvider == before)
    assert(not manager.applySettings(player, {voiceProvider = 'voxtral'}))
    -- A key is saved (the Conversation provider stays Convai, the default): the entry is a plain label and can be applied.
    key('a', {provider = 'convai', effective = 'convai', saved = true})
    loaded = registered.loadMod('manager')
    assert(row('voiceProvider').elements[6] == 'Voxtral · Mistral cloud', row('voiceProvider').elements[6])
    assert(manager.snapshot(player).settings.conversationProvider == 'convai')
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 6}}).ok)
    assert(saved.voiceProvider == 'voxtral' and manager.snapshot(player).settings.voiceProvider == 'voxtral')
    -- It rides on Pocket, so Natural speech and Expressive emotions are not turned off by choosing it.
    assert(manager.snapshot(player).settings.expressiveEmotions == true)
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 6}}).ok)
    -- Convai stays selectable, and the saved voice is found again in the list.
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 7}, {id = 'expressiveEmotions', value = false}}).ok and saved.voiceProvider == 'convai')
    assert(dofile('voice-preview.lua').indexOf({voiceProvider = 'voxtral'}) == 6)
  `);
});

test('Mature content is a settings row with or without the Mature pack: the help says whether the uncensored models are installed and that the safety check runs on every model', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    local function state(tag, value)
      jsonFixtures['mature-' .. tag] = value
      files['runtime/mistral-state.json'] = 'mature-' .. tag
      clock = clock + 2
    end
    assert(invoke('tab:settings').ok)
    state('none', {provider = 'local', effective = 'local', saved = false})
    loaded = registered.loadMod('manager')
    local noPack = row('matureContent')
    assert(noPack ~= nil and noPack.label == 'Mature content', 'no Mature pack: the row is still there')
    assert(row('conversationProvider') ~= nil)
    assert(tostring(noPack.description):find('safety check', 1, true), 'the help says the minors check runs on every model')
    assert(tostring(noPack.description):find('not installed', 1, true), 'the help says the uncensored models are not installed')
    assert(tostring(noPack.description):find('Hugging Face page', 1, true), 'and where to get them')
    assert(tostring(noPack.description):find('Choosing a cloud provider turns it off.', 1, true), 'the help says a cloud provider turns it off')
    assert(not tostring(noPack.description):find('no effect yet', 1, true))
    -- Usable without the pack, beside the Local AI provider (index 4); beside a cloud provider it is saved as off.
    assert(registered.applyBatch('manager', {{id = 'matureContent', value = true}}).ok and saved.matureContent == false, 'not on beside Convai')
    assert(registered.applyBatch('manager', {{id = 'matureContent', value = true}, {id = 'conversationProvider', value = 4}}).ok and saved.matureContent == true, 'usable without the pack')
    assert(registered.applyBatch('manager', {{id = 'matureContent', value = false}}).ok and saved.matureContent == false)
    state('pack', {provider = 'local', effective = 'local', saved = false, maturePack = true})
    loaded = registered.loadMod('manager')
    local mature = row('matureContent')
    assert(mature ~= nil and mature.label == 'Mature content', 'the Mature pack is installed: the row is there')
    assert(tostring(mature.description):find('Mature pack’s uncensored models', 1, true), 'the help names where the full effect comes from')
    assert(tostring(mature.description):find('Pack: installed', 1, true), 'the help says the pack is installed')
    assert(not tostring(mature.description):find('not installed', 1, true))
    assert(not tostring(mature.description):find('Not using Local AI', 1, true), 'Local AI answers, so no warning')
    assert(registered.applyBatch('manager', {{id = 'matureContent', value = true}}).ok and saved.matureContent == true)
    -- Another provider answers: the row stays, with no "no effect" warning (a cloud provider turns the setting off instead).
    state('other', {provider = 'mistral', effective = 'mistral', saved = true, maturePack = true, localAi = 'ready'})
    loaded = registered.loadMod('manager')
    assert(not tostring(row('matureContent').description):find('Not using Local AI', 1, true), 'the retired warning is gone')
    assert(tostring(row('matureContent').description):find('Choosing a cloud provider turns it off.', 1, true))
    -- The pack goes away: the row stays, the setting stays on, and the help says the pack is not installed.
    state('gone', {provider = 'local', effective = 'local', saved = false, maturePack = false})
    loaded = registered.loadMod('manager')
    assert(row('matureContent') ~= nil)
    assert(tostring(row('matureContent').description):find('not installed', 1, true))
  `);
});

// Turning Mature content on stages the Local AI provider, the uncensored model and a local voice as pending changes (mod/mcm.lua,
// syncMature); turning it off puts back what that changed. A fake MCM keeps the drafts and emits 'drafts.changed' like the real one.
const matureFixture = `
  local clock = 1000
  os.clock = function() return clock end
  os.time = function() return clock end
  local PREFIX = 'cyberpunk-convai:manager:'
  local listeners, pending = {}, {}
  nativeApi.subscribe = function(name, callback) listeners[#listeners + 1] = callback; return #listeners end
  nativeApi.unsubscribe = function() return true end
  mcm.shutdown(); mcm.install()
  local function emit()
    local count = 0
    for _ in pairs(pending) do count = count + 1 end
    for _, callback in ipairs(listeners) do callback({modKey = 'cyberpunk-convai:manager', count = count}) end
  end
  nativeApi.getValue = function(id)
    local key = id:sub(#PREFIX + 1)
    if pending[key] ~= nil then return pending[key] end
    local found = row(key)
    return found and found.value
  end
  nativeApi.setDraft = function(id, value)
    local key = id:sub(#PREFIX + 1)
    local found = row(key)
    if not found then return false, 'unknown setting' end
    if found.value == value then pending[key] = nil else pending[key] = value end
    emit()
    return true
  end
  nativeApi.hasDrafts = function() return next(pending) ~= nil end
  local function state(tag, value)
    jsonFixtures['mature-' .. tag] = value
    files['runtime/mistral-state.json'] = 'mature-' .. tag
    clock = clock + 2
    manager.snapshot(player)
    loaded = registered.loadMod('manager')
  end
  local function voices(installed)
    clock = clock + 20
    jsonFixtures['voice-' .. tostring(installed) .. clock] = {state = 'ready', provider = 'pocket', omniPack = {installed = installed, missing = {}}, updated = clock * 1000}
    files['runtime/local-voice-state.json'] = 'voice-' .. tostring(installed) .. clock
    manager.snapshot(player)
  end
  -- The player's own change of one setting (a draft), and an Apply that commits some.
  local function user(key, value) assert(nativeApi.setDraft(PREFIX .. key, value)); mcm.update(player, false) end
  local function apply(changes)
    clock = clock + 2
    local result = registered.applyBatch('manager', changes)
    pending = {}
    loaded = registered.loadMod('manager')
    emit()
    mcm.update(player, false)
    return result
  end
  local function drafts() local list = {}; for key, value in pairs(pending) do list[#list + 1] = key .. '=' .. tostring(value) end; table.sort(list); return table.concat(list, ',') end
  -- Mistral answers with a pinned model and the Mistral cloud voice; Local AI and the OmniVoice pack are installed.
  local function startFrom(options)
    options = options or {}
    local report = {provider = 'mistral', effective = 'mistral', saved = true, localAi = 'ready',
      localModels = {{id = 'standard', name = 'Gemma', sizeMiB = 5000}, {id = 'mature:unc', name = 'Gemma uncensored', sizeMiB = 5200}, {id = 'lite', name = 'Qwen', sizeMiB = 1300}},
      localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'}
    if options.noMature then report.localModelMatureDefault = nil end
    if options.noPack then report.localAi = nil end
    state('ready', report)
    voices(options.omni ~= false)
    assert(invoke('tab:settings').ok)
    loaded = registered.loadMod('manager')
    assert(apply({{id = 'conversationProvider', value = 3}, {id = 'localModel', value = 2}, {id = 'voiceProvider', value = options.voice or 6}}).ok)
    assert(saved.conversationProvider == 'mistral' and saved.localModel == 'standard' and not saved.matureContent)
  end
`;

test('turning Mature content on stages Local AI, the uncensored model and a local voice as pending changes, names them in one line, and Apply saves them with the way back', () => {
  run(`${mcmFixture}${matureFixture}
    startFrom()
    assert(saved.voiceProvider == 'voxtral')
    user('matureContent', true)
    assert(drafts() == 'conversationProvider=4,localModel=3,matureContent=true,voiceProvider=1', drafts())
    local changes = mcm.inspect().mature.changes
    assert(changes and changes:find('Local AI', 1, true) and changes:find('Uncensored model', 1, true) and changes:find('Pocket', 1, true), changes)
    assert(mcm.inspect().mature.notice == nil, 'there is no Mature notice any more')
    -- No notice either: MCM's own "Pending: Mature content" status stays as it is, now and a while later.
    local shown
    handlers.McmUiBegin(controller, 'MCM', '', 'Mods', 'Companion Manager', 'Pending: Mature content', 0, '', true, true, 0, function(_, _, _, _, status) shown = status end)
    assert(shown == 'Pending: Mature content', tostring(shown))
    clock = clock + 9
    handlers.McmUiBegin(controller, 'MCM', '', 'Mods', 'Companion Manager', 'Pending: Mature content', 0, '', true, true, 0, function(_, _, _, _, status) shown = status end)
    assert(shown == 'Pending: Mature content', tostring(shown))
    -- Nothing is saved before Apply.
    assert(saved.conversationProvider == 'mistral' and saved.localModel == 'standard' and saved.voiceProvider == 'voxtral' and not saved.matureContent)
    assert(apply({{id = 'matureContent', value = true}, {id = 'conversationProvider', value = 4}, {id = 'localModel', value = 3}, {id = 'voiceProvider', value = 1}}).ok)
    assert(saved.matureContent == true and saved.conversationProvider == 'local' and saved.localModel == 'mature:unc' and saved.voiceProvider == 'pocket')
    local way = saved.matureRestore
    assert(way and way.conversationProvider.before == 'mistral' and way.conversationProvider.set == 'local'
      and way.localModel.before == 'standard' and way.localModel.set == 'mature:unc'
      and way.voice.before.provider == 'voxtral' and way.voice.set.provider == 'pocket', 'the way back was not saved')
    assert(manager.snapshot(player).settings.matureRestore.localModel.before == 'standard')
  `);
});

test('turning Mature content off puts the provider, model and voice back, except what the player changed since', () => {
  run(`${mcmFixture}${matureFixture}
    startFrom()
    user('matureContent', true)
    assert(apply({{id = 'matureContent', value = true}, {id = 'conversationProvider', value = 4}, {id = 'localModel', value = 3}, {id = 'voiceProvider', value = 1}}).ok)
    -- Off, nothing else touched: all three come back as pending changes, in one line.
    user('matureContent', false)
    assert(drafts() == 'conversationProvider=3,localModel=2,matureContent=false,voiceProvider=6', drafts())
    local changes = mcm.inspect().mature.changes
    assert(changes and changes:find('Conversation provider', 1, true) and changes:find('Local AI model', 1, true), changes)
    assert(apply({{id = 'matureContent', value = false}, {id = 'conversationProvider', value = 3}, {id = 'localModel', value = 2}, {id = 'voiceProvider', value = 6}}).ok)
    assert(saved.matureContent == false and saved.conversationProvider == 'mistral' and saved.localModel == 'standard' and saved.voiceProvider == 'voxtral')
    assert(saved.matureRestore == nil, 'the way back stayed after Mature content was turned off')
    -- On again, the player changes the model to Qwen before turning it off: that stays theirs (the provider cannot be changed to a
    -- cloud one and keep Mature content on: that turns it off, see the mutual exclusion test).
    user('matureContent', true)
    assert(apply({{id = 'matureContent', value = true}, {id = 'conversationProvider', value = 4}, {id = 'localModel', value = 3}, {id = 'voiceProvider', value = 1}}).ok)
    assert(apply({{id = 'localModel', value = 1}}).ok)
    user('matureContent', false)
    assert(drafts() == 'conversationProvider=3,matureContent=false,voiceProvider=6', 'the provider and the voice were still the ones Mature content chose: ' .. drafts())
  `);
});

test('Mature content turned on and off again before Apply leaves no pending change; Revert forgets the staging', () => {
  run(`${mcmFixture}${matureFixture}
    startFrom()
    user('matureContent', true)
    assert(drafts() ~= '' and mcm.inspect().mature.staged == true)
    user('matureContent', false)
    assert(drafts() == '', 'drafts left behind: ' .. drafts())
    assert(mcm.inspect().mature.staged == false)
    -- Revert: every draft is gone; a later On starts afresh and stages again.
    user('matureContent', true)
    assert(drafts() ~= '')
    pending = {}; emit(); mcm.update(player, false)
    assert(mcm.inspect().mature.staged == false)
    user('matureContent', true)
    assert(drafts() == 'conversationProvider=4,localModel=3,matureContent=true,voiceProvider=1', drafts())
    -- The player's own later change of the model while Mature content is on is theirs: turning it off does not undo it.
    user('localModel', 1)
    user('matureContent', false)
    -- The provider and the voice go back to what is saved (their drafts disappear); the model stays the player's own choice.
    assert(drafts() == 'localModel=1', 'the model the player chose was undone or others were left: ' .. drafts())
  `);
});

test('without the Local AI pack Mature content stages nothing else and the help says Local AI is needed', () => {
  run(`${mcmFixture}${matureFixture}
    startFrom({noPack = true})
    assert(tostring(row('matureContent').description):find('Needs Local AI.', 1, true), 'the help does not say Local AI is needed')
    -- Beside a cloud provider and with no Local AI pack there is nothing to switch to: the switch goes back to off, nothing else is staged.
    user('matureContent', true)
    assert(drafts() == '', 'the switch stayed on without Local AI: ' .. drafts())
    assert(nativeApi.getValue(PREFIX .. 'matureContent') == false)
    assert(mcm.inspect().mature.changes == nil and mcm.inspect().mature.notice == nil)
    assert(saved.matureContent == false and saved.conversationProvider == 'mistral' and saved.localModel == 'standard' and saved.voiceProvider == 'voxtral')
    assert(saved.matureRestore == nil, 'a way back was saved though nothing was changed')
  `);
});

test('the voice moves to Pocket TTS without the OmniVoice pack, is left when it is already local, and stays when Multilingual conversations has no local voice to offer', () => {
  run(`${mcmFixture}${matureFixture}
    startFrom({omni = false})
    user('matureContent', true)
    assert(drafts() == 'conversationProvider=4,localModel=3,matureContent=true,voiceProvider=1', drafts())
    assert(mcm.inspect().mature.changes:find('Pocket', 1, true), mcm.inspect().mature.changes)
    user('matureContent', false)
    assert(drafts() == '', 'staged then unstaged: ' .. drafts())
    -- A local voice already: the voice is not touched, and the staged names are only the other two.
    assert(apply({{id = 'voiceProvider', value = 1}}).ok)
    user('matureContent', true)
    assert(drafts() == 'conversationProvider=4,localModel=3,matureContent=true', drafts())
    assert(not mcm.inspect().mature.changes:find('Pocket', 1, true))
    user('matureContent', false)
    -- Already Local AI with the uncensored model and a local voice: nothing to stage.
    assert(apply({{id = 'conversationProvider', value = 4}, {id = 'localModel', value = 3}}).ok)
    mcm.update(player, false)
    user('matureContent', true)
    assert(drafts() == 'matureContent=true', drafts())
    assert(mcm.inspect().mature.changes == nil, tostring(mcm.inspect().mature.changes))
    assert(apply({{id = 'matureContent', value = true}}).ok and saved.matureRestore == nil)
    -- Multilingual conversations on, a cloud voice and no OmniVoice pack: there is no local voice to give, so the voice is left.
    assert(apply({{id = 'matureContent', value = false}, {id = 'voiceProvider', value = 7}, {id = 'expressiveEmotions', value = false}}).ok)
    assert(apply({{id = 'multilingualConversations', value = true}}).ok)
    user('matureContent', true)
    assert(not drafts():find('voiceProvider', 1, true), 'Pocket TTS was staged beside Multilingual conversations: ' .. drafts())
  `);
});

test('Mature content on never changes a local voice (Pocket or OmniVoice, even with the OmniVoice pack installed); every cloud voice moves to Pocket TTS', () => {
  run(`${mcmFixture}${matureFixture}
    startFrom()
    -- OmniVoice stays OmniVoice (any of its four choices): the voice is not staged and not named.
    for _, index in ipairs({2, 3, 4, 5}) do
      assert(apply({{id = 'voiceProvider', value = index}}).ok)
      user('matureContent', true)
      assert(drafts() == 'conversationProvider=4,localModel=3,matureContent=true', index .. ' ' .. drafts())
      assert(not mcm.inspect().mature.changes:find('Pocket', 1, true) and not mcm.inspect().mature.changes:find('OmniVoice', 1, true), mcm.inspect().mature.changes)
      user('matureContent', false)
    end
    -- Pocket stays Pocket.
    assert(apply({{id = 'voiceProvider', value = 1}}).ok)
    user('matureContent', true)
    assert(not drafts():find('voiceProvider', 1, true), drafts())
    user('matureContent', false)
    -- The Mistral (6) and Convai (7) cloud voices go to Pocket (1), not OmniVoice, though its pack is installed.
    for _, index in ipairs({6, 7}) do
      assert(apply({{id = 'voiceProvider', value = index}, {id = 'expressiveEmotions', value = false}, {id = 'naturalSpeech', value = false}}).ok, tostring(index))
      user('matureContent', true)
      assert(drafts():find('voiceProvider=1', 1, true), index .. ' ' .. drafts())
      assert(mcm.inspect().mature.changes:find('Pocket', 1, true) and not mcm.inspect().mature.changes:find('OmniVoice', 1, true), mcm.inspect().mature.changes)
      user('matureContent', false)
      assert(not drafts():find('voiceProvider', 1, true), 'turning Mature off puts the earlier voice back: ' .. drafts())
    end
    -- Multilingual conversations refuses Pocket TTS: with the OmniVoice pack the cloud voice moves to OmniVoice instead.
    assert(apply({{id = 'voiceProvider', value = 7}, {id = 'multilingualConversations', value = true}}).ok)
    user('matureContent', true)
    assert(drafts():find('voiceProvider=2', 1, true), drafts())
  `);
});

test('Mature content on with no uncensored model installed stages no model change and does not mention a model; turning it off leaves the model alone', () => {
  run(`${mcmFixture}${matureFixture}
    startFrom({noMature = true})
    user('matureContent', true)
    assert(drafts() == 'conversationProvider=4,matureContent=true,voiceProvider=1', drafts())
    local changes = mcm.inspect().mature.changes
    assert(changes and changes:find('Local AI', 1, true) and changes:find('Pocket', 1, true), changes)
    assert(not changes:lower():find('model', 1, true), 'a model was named though none was staged: ' .. changes)
    assert(apply({{id = 'matureContent', value = true}, {id = 'conversationProvider', value = 4}, {id = 'voiceProvider', value = 1}}).ok)
    assert(saved.matureContent == true and saved.localModel == 'standard', tostring(saved.localModel))
    assert(saved.matureRestore and saved.matureRestore.localModel == nil and saved.matureRestore.conversationProvider.before == 'mistral', 'a model part was recorded')
    user('matureContent', false)
    assert(drafts() == 'conversationProvider=3,matureContent=false,voiceProvider=6', drafts())
    assert(not mcm.inspect().mature.changes:find('Local AI model', 1, true), mcm.inspect().mature.changes)
    -- Only an uncensored model that is not in the list counts as none: a published id that is not listed stages nothing either.
    state('ghost', {provider = 'mistral', effective = 'mistral', saved = true, localAi = 'ready', localModelDefault = 'standard', localModelMatureDefault = 'ghost',
      localModels = {{id = 'standard', name = 'Gemma', sizeMiB = 5000}, {id = 'lite', name = 'Qwen', sizeMiB = 1300}}})
    pending = {}; emit(); mcm.update(player, false)
    user('matureContent', true)
    assert(not drafts():find('localModel', 1, true), drafts())
  `);
});

test('Mature content on with the model already the uncensored one stages no model change, and a legacy way back with set auto still restores the earlier model', () => {
  run(`${mcmFixture}${matureFixture}
    startFrom()
    assert(apply({{id = 'conversationProvider', value = 4}, {id = 'localModel', value = 3}}).ok and saved.localModel == 'mature:unc')
    user('matureContent', true)
    assert(not drafts():find('localModel', 1, true), 'the uncensored model was already chosen: ' .. drafts())
    user('matureContent', false)
    pending = {}; emit(); mcm.update(player, false)
    -- A way back an older version saved: the model it set was 'auto', which now stands for the default model (standard, position 2).
    assert(manager.applySettings(player, {matureContent = true, conversationProvider = 'local', localModel = 'standard',
      matureRestore = {localModel = {before = 'lite', set = 'auto'}}}))
    assert(saved.matureRestore and saved.matureRestore.localModel.before == 'lite' and saved.matureRestore.localModel.set == 'auto')
    loaded = registered.loadMod('manager'); pending = {}; emit(); mcm.update(player, false)
    user('matureContent', false)
    assert(drafts() == 'localModel=1,matureContent=false', drafts())
    assert(mcm.inspect().mature.changes:find('Local AI model', 1, true), mcm.inspect().mature.changes)
    assert(apply({{id = 'matureContent', value = false}, {id = 'localModel', value = 1}}).ok)
    assert(saved.localModel == 'lite' and saved.matureRestore == nil, tostring(saved.localModel))
  `);
});

test('the saved way back is checked on load and on Apply, and is dropped with Mature content', () => {
  run(`${mcmFixture}
    local ok = manager.applySettings(player, {matureContent = true, conversationProvider = 'local', matureRestore = {conversationProvider = {before = 'convai', set = 'local'},
      localModel = {before = 'bad id', set = 'auto'}, voice = {before = {provider = 'pocket'}, set = {provider = 'omni', steps = 16, reference = 'short'}}}})
    assert(ok)
    local way = manager.snapshot(player).settings.matureRestore
    assert(way.conversationProvider.before == 'convai' and way.localModel == nil and way.voice.set.steps == 16, 'a malformed part was kept')
    assert(not manager.applySettings(player, {matureRestore = {junk = true}}), 'a record with nothing valid was accepted')
    -- 'convai-key' (Convai with the player's own key, its own selector entry) is a provider a way back can name; anything else is dropped.
    assert(manager.applySettings(player, {matureRestore = {conversationProvider = {before = 'convai-key', set = 'local'}}}))
    assert(manager.snapshot(player).settings.matureRestore.conversationProvider.before == 'convai-key')
    assert(not manager.applySettings(player, {matureRestore = {conversationProvider = {before = 'groq', set = 'local'}}}), 'an unknown provider was kept')
    assert(manager.applySettings(player, {matureContent = false}))
    assert(manager.snapshot(player).settings.matureRestore == nil and saved.matureRestore == nil, 'the record outlived Mature content')
    -- Mature content with a cloud provider in the same save is saved as off, and its way back goes with it.
    assert(manager.applySettings(player, {matureContent = true, conversationProvider = 'local', matureRestore = {conversationProvider = {before = 'mistral', set = 'local'}}}))
    assert(manager.applySettings(player, {conversationProvider = 'mistral'}))
    assert(saved.matureContent == false and saved.matureRestore == nil, 'a cloud provider left a way back behind')
  `);
});

// ---- Settings round 3: the focused option budget, the voice stepper, the developer-only Inworld voice, the provider migration,
// ---- the key rows and the Mature / cloud provider exclusion.

test('select option width: the budget is the box minus the two key boxes a focused row draws, and a text that fit the old budget but not this one is cut', () => {
  run(`${mcmFixture}
    assert(mcm.OPTION_BOX_UNITS == 32 and mcm.KEY_HINT_UNITS == 3, 'the box and the key boxes are exposed')
    assert(mcm.OPTION_BUDGET == mcm.OPTION_BOX_UNITS - 2 * mcm.KEY_HINT_UNITS and mcm.OPTION_BUDGET == 26, tostring(mcm.OPTION_BUDGET))
    -- Between the budget and the box: it would have fit unfocused, but the key boxes of a focused row cover its ends.
    local between = string.rep('a', 29)
    assert(mcm.optionUnits(between) > mcm.OPTION_BUDGET and mcm.optionUnits(between) <= mcm.OPTION_BOX_UNITS, mcm.optionUnits(between))
    local cut = mcm.fitOption(between)
    assert(cut ~= between and cut:sub(-3) == '…' and mcm.optionUnits(cut) <= mcm.OPTION_BUDGET, cut)
    -- The reported case: a long model name with its marker keeps the marker and fits the budget.
    local model = mcm.fitOption('Gemma-4-E4B-MiniFoo-Heretic (uncensored)')
    assert(model:sub(-13) == ' (uncensored)' and model:find('…', 1, true) and mcm.optionUnits(model) <= mcm.OPTION_BUDGET, model)
    -- Exactly the budget is left as it is.
    local exact = string.rep('a', 26)
    assert(mcm.optionUnits(exact) <= mcm.OPTION_BUDGET and mcm.fitOption(exact) == exact)
  `);
});

test('select option width: every option of every select fits the focused budget in every runtime variant of the menus (developer mode, keys saved or not, OmniVoice pack, Local AI models with long names)', () => {
  run(`${mcmFixture}
    local clock = 1000
    os.clock = function() return clock end
    os.time = function() return clock end
    local widest, checked = 0, 0
    local function scan(tag)
      for _, category in ipairs(loaded.categories) do
        for _, setting in ipairs(category.settings) do
          if setting.type == 'select' and setting.elements then
            for index, label in ipairs(setting.elements) do
              local units = mcm.optionUnits(label)
              checked = checked + 1; widest = math.max(widest, units)
              assert(units <= mcm.OPTION_BUDGET, tag .. ' ' .. setting.id .. ' option ' .. index .. ': ' .. label .. ' (' .. units .. ')')
            end
          end
        end
      end
    end
    assert(invoke('tab:settings').ok)
    for _, developer in ipairs({false, true}) do
      for _, keys in ipairs({false, true}) do
        for _, pack in ipairs({false, true}) do
          clock = clock + 20
          local tag = (developer and 'dev' or 'plain') .. (keys and '-keys' or '-nokeys') .. (pack and '-pack' or '-nopack')
          jsonFixtures['voice-' .. tag] = {state = 'ready', provider = 'pocket', omniPack = {installed = pack, missing = {'model'}}, updated = clock * 1000}
          files['runtime/local-voice-state.json'] = 'voice-' .. tag
          jsonFixtures['state-' .. tag] = {provider = 'local', effective = 'local', saved = keys, tail = 'abcd', inworld = {saved = keys, tail = 'wxyz'}, localAi = 'warming',
            localModels = {{id = 'lite', name = 'Qwen3.5-2B', sizeMiB = 1311}, {id = 'mature:lite', name = 'Qwen3.5-4B-HauhauCS · uncensored', sizeMiB = 2700},
              {id = 'custom:long', name = 'My Own Fine-Tuned Companion Model 13B Instruct', sizeMiB = 7000, custom = true, needMiB = 8000},
              {id = 'custom:huge', name = 'Enormous Community Merge With A Very Long Name', sizeMiB = 40960, custom = true, needMiB = 42160, tooLarge = true}}}
          files['runtime/mistral-state.json'] = 'state-' .. tag
          assert(manager.applySettings(player, {developerMode = developer}))
          manager.snapshot(player)
          loaded = registered.loadMod('manager')
          assert(#row('voiceProvider').elements == (developer and 8 or 7), tag .. ': ' .. #row('voiceProvider').elements .. ' voices')
          scan(tag)
        end
      end
    end
    assert(checked >= 150, 'only ' .. checked .. ' options were looked at')
    assert(widest <= mcm.OPTION_BUDGET and widest > 20, 'the widest option is ' .. widest)
  `);
});

test('the Companion voices stepper skips greyed-out OmniVoice entries, stops at both ends of the list, and dims the value text of a greyed-out choice', () => {
  run(`${mcmFixture}
    local clock = 1000
    os.time = function() return clock end
    local key = 'cyberpunk-convai:manager:voiceProvider'
    local effective, forwarded, shownText, opacity = 1, 0, nil, nil
    local selector = {nativeIdentity = 202}
    nativeApi.getValue = function(id) assert(id == key); return effective end
    local function setPack(installed)
      clock = clock + 20
      local tag = 'voice-pack-' .. tostring(installed) .. clock
      jsonFixtures[tag] = {state = 'ready', provider = 'pocket', omniPack = {installed = installed, missing = {'model'}}, updated = clock * 1000}
      files['runtime/local-voice-state.json'] = tag
      manager.snapshot(player)
    end
    local function size() return #row('voiceProvider').elements end
    local function open()
      loaded = registered.loadMod('manager')
      handlers.McmUiSetContentTitle(controller, 'Companion Manager')
      handlers.McmUiConfigureBase(selector, controller, key)
    end
    local function wrapped(forward)
      forwarded = forwarded + 1
      effective = effective + (forward and 1 or -1)
      if effective > size() then effective = 1 elseif effective < 1 then effective = size() end
    end
    -- One press of an arrow, from a given entry: where the selector ends up and how many plain steps MCM was asked for.
    local function press(forward, from)
      effective, forwarded = from, 0
      handlers.McmUiEmitStep(selector, forward, wrapped)
      return effective, forwarded
    end
    local function expect(forward, from, landed, steps)
      local at, count = press(forward, from)
      assert(at == landed and count == steps, (forward and 'right' or 'left') .. ' from ' .. from .. ': ' .. at .. ' after ' .. count .. ' steps, expected ' .. landed .. ' after ' .. steps)
    end
    assert(invoke('tab:settings').ok)
    -- The OmniVoice pack is missing: entries 2 to 5 are greyed out and never landed on.
    setPack(false); open()
    assert(size() == 7)
    expect(true, 1, 6, 5)   -- Balanced to Ultra Quality are skipped
    expect(true, 2, 6, 4)   -- a saved greyed-out choice steps on past the others
    expect(true, 6, 7, 1)
    expect(true, 7, 7, 0)   -- the right end stops: no wrap to the first entry
    expect(false, 7, 6, 1)
    expect(false, 6, 1, 5)
    expect(false, 3, 1, 2)
    expect(false, 1, 1, 0)  -- the left end stops: no wrap to the last entry
    -- The pack is installed: every entry can be chosen, one step each, and the ends still stop.
    setPack(true); open()
    expect(true, 1, 2, 1)
    expect(true, 4, 5, 1)
    expect(false, 2, 1, 1)
    expect(false, 1, 1, 0)
    expect(true, 7, 7, 0)
    -- Developer mode adds the Inworld voice as the eighth entry: the list ends there.
    assert(manager.applySettings(player, {developerMode = true}))
    open()
    assert(size() == 8)
    expect(true, 7, 8, 1)
    expect(true, 8, 8, 0)
    expect(false, 8, 7, 1)
    setPack(false); open()
    expect(true, 1, 6, 5)
    expect(true, 7, 8, 1)
    expect(false, 6, 1, 5)
    -- A selector of another mod is left alone.
    handlers.McmUiConfigureBase(selector, controller, 'another-mod:settings:voiceProvider')
    local at, count = press(true, 1)
    assert(at == 2 and count == 1, 'a foreign selector must step as usual')
    handlers.McmUiConfigureBase(selector, controller, key)
    -- The value text of a greyed-out choice is dimmed (from the update tick, never in a hook); any other choice is shown plainly.
    local textWidget = {IsA = function(_, name) return name == 'inkText' end, GetText = function() return shownText end,
      SetOpacity = function(_, value) opacity = value end, GetName = function() return 'value' end}
    local root = {IsA = function() return false end, GetName = function() return 'root' end, GetNumChildren = function() return 1 end,
      GetWidgetByIndex = function() return textWidget end}
    function selector:GetRootWidget() return root end
    local function show(index)
      effective, shownText, opacity = index, row('voiceProvider').elements[index], nil
      handlers.McmUiFinishSelect(selector)
      assert(opacity == nil, 'the hook touched a widget')
      mcm.update(player, false)
    end
    show(3); assert(opacity == 0.4, 'a greyed-out choice is dimmed: ' .. tostring(opacity))
    show(1); assert(opacity == 1.0, 'a plain choice is shown at full strength: ' .. tostring(opacity))
    show(6); assert(opacity == 1.0)
    -- With the pack installed nothing is dimmed.
    setPack(true); open()
    show(3); assert(opacity ~= 0.4, 'an installed OmniVoice entry was dimmed')
  `);
});

test('the Inworld voice is a developer-mode voice: seven entries without Developer mode and eight with it, its key row only in Development, and a saved Inworld voice reads as Pocket TTS without it', () => {
  run(`${mcmFixture}
    local clock = 1000
    os.clock = function() return clock end
    os.time = function() return clock end
    local NL2 = string.char(10, 10)
    local function paragraphs(text)
      local list, from = {}, 1
      while true do
        local at = text:find(NL2, from, true)
        if not at then list[#list + 1] = text:sub(from); return list end
        list[#list + 1] = text:sub(from, at - 1); from = at + 2
      end
    end
    local function firstParagraph(text) return paragraphs(text)[1] end
    local function ids(category)
      local list = {}
      for _, item in ipairs(loaded.categories) do
        if item.id == category then for _, setting in ipairs(item.settings) do list[#list + 1] = setting.id end end
      end
      return table.concat(list, ',')
    end
    assert(invoke('tab:settings').ok)
    local function menu() return row('voiceProvider').elements end
    -- Without Developer mode: seven entries, none of them Inworld; no key row anywhere.
    assert(#menu() == 7 and menu()[7] == 'Convai · Cloud voice')
    for _, label in ipairs(menu()) do assert(not label:find('Inworld', 1, true), label) end
    assert(row('inworld-key') == nil and ids('development') == 'developerMode')
    assert(not row('voiceProvider').description:find('Inworld', 1, true))
    -- The voice cannot be applied without the mode either: the entry is not offered, and a stale draft index saves nothing new.
    local result = registered.applyBatch('manager', {{id = 'voiceProvider', value = 8}})
    assert(result.ok == false and saved.voiceProvider == 'pocket', 'the Inworld entry is not usable without its key')
    -- With Developer mode: eight entries, Inworld last and Convai before it; the key row follows Developer mode in Development.
    assert(manager.applySettings(player, {developerMode = true}))
    loaded = registered.loadMod('manager')
    assert(#menu() == 8 and menu()[7] == 'Convai · Cloud voice' and menu()[8] == 'Inworld · needs key', table.concat(menu(), '|'))
    assert(ids('development') == 'developerMode,inworld-key', ids('development'))
    assert(row('voiceProvider').description:find('Inworld', 1, true))
    -- The key row: Paste, then the failure first in its help (Not added), then Added with the last four characters (or just Added).
    local function publish(tag, inworld)
      jsonFixtures['inworld-' .. tag] = {provider = 'convai', effective = 'convai', saved = false, inworld = inworld}
      files['runtime/mistral-state.json'] = 'inworld-' .. tag
      clock = clock + 2; manager.snapshot(player); loaded = registered.loadMod('manager')
      return row('inworld-key')
    end
    local item = row('inworld-key')
    assert(item.label == 'Inworld API key' and item.value == 'Paste')
    assert(invoke('inworld-key').ok)
    local pasted = jsonFixtures[files['runtime/inworld-key-command.json']]
    item = publish('bad', {saved = false, result = {id = pasted.id, state = 'invalid'}})
    assert(item.label == 'Inworld API key (Not added)' and item.value == 'Paste' and firstParagraph(item.description) == 'Inworld did not accept that key.', item.label .. ' | ' .. item.description)
    item = publish('unreadable', {saved = false, result = {id = pasted.id, state = 'unreadable'}})
    assert(firstParagraph(item.description) == 'The clipboard could not be read.')
    item = publish('failed', {saved = false, result = {id = pasted.id, state = 'failed'}})
    assert(firstParagraph(item.description) == 'The key could not be saved.')
    item = publish('saved', {saved = true, tail = 'wxyz'})
    assert(item.label == 'Inworld API key (…wxyz)' and item.value == 'Remove' and not item.description:find('did not accept', 1, true), item.label)
    item = publish('no-tail', {saved = true})
    assert(item.label == 'Inworld API key (Added)' and item.value == 'Remove', item.label)
    assert(#menu() == 8 and menu()[8] == 'Inworld · Cloud voice', menu()[8])
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 8}}).ok and saved.voiceProvider == 'inworld')
    loaded = registered.loadMod('manager')
    assert(row('voiceProvider').value == 8, 'the saved Inworld voice is the eighth entry')
    -- Developer mode off again: a saved Inworld voice becomes Pocket TTS, quietly, and the open page is asked to reload.
    local ok, problem, notice, reload = manager.applySettings(player, {developerMode = false})
    assert(ok and notice == nil and reload == true and saved.voiceProvider == 'pocket' and manager.snapshot(player).settings.voiceProvider == 'pocket', tostring(problem))
    loaded = registered.loadMod('manager')
    assert(#menu() == 7 and row('voiceProvider').value == 1 and row('inworld-key') == nil)
    -- Developer mode and the Inworld voice chosen in the same save keep it.
    assert(manager.applySettings(player, {developerMode = true, voiceProvider = 'inworld'}) and saved.voiceProvider == 'inworld')
    -- A settings file saved with the voice and the mode on loads as it is; with the mode off the voice loads as Pocket and the file is corrected.
    for _, case in ipairs({{true, 'inworld'}, {false, 'pocket'}}) do
      seed = {version = 2, voiceProvider = 'inworld', developerMode = case[1], enabledByKey = {}}
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      assert(manager.snapshot(player).settings.voiceProvider == case[2] and saved.voiceProvider == case[2], tostring(case[1]))
    end
  `);
});

test('the old Use my own Convai API key switch migrates once: on with a saved key is Convai API key, otherwise Convai free tier; Mistral and Local are never overridden', () => {
  run(`${mcmFixture}
    local function start(settings, keyState)
      seed = {version = 2, voiceProvider = 'pocket', enabledByKey = {}}
      for key, value in pairs(settings) do seed[key] = value end
      files['runtime/settings.json'], saved = 'seed', nil
      files['runtime/own-key-state.json'] = nil
      if keyState ~= nil then jsonFixtures['own-key-' .. tostring(keyState.saved)] = keyState; files['runtime/own-key-state.json'] = 'own-key-' .. tostring(keyState.saved) end
      manager.configure(api, profiles); manager.prepare(player)
      return manager.snapshot(player).settings
    end
    local navigated = false
    local function shown()
      if not navigated then assert(invoke('tab:settings').ok); navigated = true end
      loaded = registered.loadMod('manager')
      return row('conversationProvider').value
    end
    -- On and a key saved: the player keeps using it, now as the Convai API key entry.
    local settings = start({useOwnConvaiKey = true}, {saved = true, tail = 'wxyz'})
    assert(settings.useOwnConvaiKey == true and settings.conversationProvider == 'convai' and saved.convaiProviderChoice == true)
    assert(shown() == 2)
    -- On but no key saved: Convai free tier.
    settings = start({useOwnConvaiKey = true}, {saved = false})
    assert(settings.useOwnConvaiKey == false and saved.useOwnConvaiKey == false and saved.convaiProviderChoice == true)
    assert(shown() == 1)
    -- Off: Convai free tier, with or without a key.
    settings = start({useOwnConvaiKey = false}, {saved = true, tail = 'wxyz'})
    assert(settings.useOwnConvaiKey == false and shown() == 1 and saved.convaiProviderChoice == true)
    settings = start({useOwnConvaiKey = false}, {saved = false})
    assert(settings.useOwnConvaiKey == false and shown() == 1)
    -- Never set: Convai free tier.
    settings = start({}, {saved = false})
    assert(settings.useOwnConvaiKey == false and settings.conversationProvider == 'convai' and shown() == 1)
    -- Mistral and Local stay as they were, whatever the old switch said.
    settings = start({useOwnConvaiKey = true, conversationProvider = 'mistral'}, {saved = true, tail = 'wxyz'})
    assert(settings.conversationProvider == 'mistral' and shown() == 3)
    settings = start({useOwnConvaiKey = true, conversationProvider = 'mistral'}, {saved = false})
    assert(settings.conversationProvider == 'mistral' and shown() == 3)
    settings = start({useOwnConvaiKey = true, conversationProvider = 'local'}, {saved = true, tail = 'wxyz'})
    assert(settings.conversationProvider == 'local' and shown() == 4)
    settings = start({useOwnConvaiKey = true, conversationProvider = 'local'}, {saved = false})
    assert(settings.conversationProvider == 'local' and shown() == 4)
    -- A key status the bridge has not published yet decides nothing: the switch stays as it was and the migration waits.
    settings = start({useOwnConvaiKey = true}, nil)
    assert(settings.useOwnConvaiKey == true and saved.convaiProviderChoice == nil, 'migrated without knowing whether a key is saved')
    jsonFixtures['own-key-late'] = {saved = false}
    files['runtime/own-key-state.json'] = 'own-key-late'
    manager.configure(api, profiles); manager.prepare(player)
    assert(manager.snapshot(player).settings.useOwnConvaiKey == false and saved.convaiProviderChoice == true, 'the migration did not run once the status was there')
    -- Once migrated, a later choice of the Convai API key entry is the player's own and is never undone by a missing key.
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 2}}).ok and saved.useOwnConvaiKey == true)
    manager.configure(api, profiles); manager.prepare(player)
    assert(manager.snapshot(player).settings.useOwnConvaiKey == true and saved.convaiProviderChoice == true, 'a deliberate choice was migrated away')
  `);
});

test('Mature content and a cloud provider exclude each other in loaded settings and in Apply (Convai free tier, Convai API key and Mistral turn it off; Local keeps it)', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    for _, case in ipairs({{'local', false, true}, {'convai', false, false}, {'convai', true, false}, {'mistral', false, false}, {'groq', false, false}, {nil, false, false}}) do
      seed = {version = 2, voiceProvider = 'pocket', matureContent = true, conversationProvider = case[1], useOwnConvaiKey = case[2], enabledByKey = {}}
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      local settings = manager.snapshot(player).settings
      assert(settings.matureContent == case[3] and saved.matureContent == case[3], tostring(case[1]) .. ' ' .. tostring(case[2]))
    end
    -- A saved way back goes with Mature content when a cloud provider turned it off.
    seed = {version = 2, voiceProvider = 'pocket', matureContent = true, conversationProvider = 'mistral', enabledByKey = {},
      matureRestore = {conversationProvider = {before = 'convai-key', set = 'local'}}}
    files['runtime/settings.json'], saved = 'seed', nil
    manager.configure(api, profiles); manager.prepare(player)
    assert(manager.snapshot(player).settings.matureContent == false and manager.snapshot(player).settings.matureRestore == nil and saved.matureRestore == nil)
    -- Apply: Mature content beside Local stays; beside any cloud provider in the result it is saved as off.
    assert(manager.applySettings(player, {matureContent = true, conversationProvider = 'local'}) and saved.matureContent == true)
    for _, provider in ipairs({'convai', 'mistral'}) do
      assert(manager.applySettings(player, {matureContent = true, conversationProvider = 'local'}) and saved.matureContent == true)
      local ok, _, _, reload = manager.applySettings(player, {conversationProvider = provider})
      assert(ok and saved.matureContent == false and reload == true, provider)
      assert(manager.applySettings(player, {conversationProvider = 'local'}) and saved.matureContent == false, 'Local alone does not turn it back on')
    end
    assert(manager.applySettings(player, {matureContent = true, conversationProvider = 'convai', useOwnConvaiKey = true}))
    assert(saved.matureContent == false and saved.useOwnConvaiKey == true)
  `);
});

test('in the drafts, picking Convai API key, Mistral or Convai free tier while Mature content is on turns it off and puts back what turning it on changed; picking Local does not', () => {
  run(`${mcmFixture}${matureFixture}
    startFrom()
    -- From Mistral: Mature on stages Local AI, the model and Pocket voice. Then each cloud entry turns it off again.
    local ON = 'conversationProvider=4,localModel=3,matureContent=true,voiceProvider=1'
    user('matureContent', true)
    assert(drafts() == ON, drafts())
    user('conversationProvider', 2)
    assert(nativeApi.getValue(PREFIX .. 'matureContent') == false and nativeApi.getValue(PREFIX .. 'conversationProvider') == 2)
    -- The model and the voice go back to what is saved; the provider the player picked is theirs.
    assert(drafts() == 'conversationProvider=2', drafts())
    assert(mcm.inspect().mature.changes and mcm.inspect().mature.changes:find('Local AI model', 1, true), tostring(mcm.inspect().mature.changes))
    pending = {}; emit(); mcm.update(player, false)
    user('matureContent', true)
    assert(drafts() == ON, drafts())
    user('conversationProvider', 1)
    assert(drafts() == 'conversationProvider=1', drafts())
    pending = {}; emit(); mcm.update(player, false)
    user('matureContent', true)
    assert(drafts() == ON, drafts())
    user('conversationProvider', 3)
    assert(drafts() == '', 'Mistral is the saved provider: nothing is left pending: ' .. drafts())
    pending = {}; emit(); mcm.update(player, false)
    -- Local keeps it: choosing Local again (or any other setting) does not touch Mature content.
    user('matureContent', true)
    assert(drafts() == ON, drafts())
    user('conversationProvider', 4)
    assert(drafts() == ON, 'Local kept Mature content on: ' .. drafts())
    user('localModel', 1)
    assert(nativeApi.getValue(PREFIX .. 'matureContent') == true)
    pending = {}; emit(); mcm.update(player, false)
    -- Saved Local with Mature on: a cloud pick turns it off, its way back is recorded, and choosing Local again does not turn it on.
    user('matureContent', true)
    assert(apply({{id = 'matureContent', value = true}, {id = 'conversationProvider', value = 4}, {id = 'localModel', value = 3}, {id = 'voiceProvider', value = 1}}).ok)
    assert(saved.matureContent == true and saved.conversationProvider == 'local')
    user('conversationProvider', 3)
    assert(nativeApi.getValue(PREFIX .. 'matureContent') == false, 'a cloud pick left Mature content on')
    assert(drafts() == 'conversationProvider=3,localModel=2,matureContent=false,voiceProvider=6', drafts())
    user('conversationProvider', 4)
    assert(nativeApi.getValue(PREFIX .. 'matureContent') == false and drafts():find('matureContent=false', 1, true), 'picking Local again turned it back on: ' .. drafts())
    -- Applying a cloud pick that turned Mature off saves it off, with the way back dropped.
    pending = {}; emit(); mcm.update(player, false)
    user('conversationProvider', 3)
    assert(apply({{id = 'conversationProvider', value = 3}, {id = 'matureContent', value = false}, {id = 'localModel', value = 2}, {id = 'voiceProvider', value = 6}}).ok)
    assert(saved.matureContent == false and saved.conversationProvider == 'mistral' and saved.matureRestore == nil)
  `);
});

test('Mature content remembers Convai API key as the provider it replaced, and turning it off puts that entry back (the free tier stays the free tier)', () => {
  run(`${mcmFixture}${matureFixture}
    startFrom()
    assert(apply({{id = 'conversationProvider', value = 2}}).ok)
    assert(saved.conversationProvider == 'convai' and saved.useOwnConvaiKey == true)
    user('matureContent', true)
    assert(drafts() == 'conversationProvider=4,localModel=3,matureContent=true,voiceProvider=1', drafts())
    assert(apply({{id = 'matureContent', value = true}, {id = 'conversationProvider', value = 4}, {id = 'localModel', value = 3}, {id = 'voiceProvider', value = 1}}).ok)
    assert(saved.conversationProvider == 'local' and saved.matureRestore.conversationProvider.before == 'convai-key', tostring(saved.matureRestore and saved.matureRestore.conversationProvider.before))
    user('matureContent', false)
    assert(drafts() == 'conversationProvider=2,localModel=2,matureContent=false,voiceProvider=6', drafts())
    assert(apply({{id = 'matureContent', value = false}, {id = 'conversationProvider', value = 2}, {id = 'localModel', value = 2}, {id = 'voiceProvider', value = 6}}).ok)
    assert(saved.conversationProvider == 'convai' and saved.useOwnConvaiKey == true and saved.matureContent == false and saved.matureRestore == nil)
    -- The free tier comes back as the free tier.
    assert(apply({{id = 'conversationProvider', value = 1}}).ok and saved.useOwnConvaiKey == false)
    user('matureContent', true)
    assert(apply({{id = 'matureContent', value = true}, {id = 'conversationProvider', value = 4}, {id = 'localModel', value = 3}, {id = 'voiceProvider', value = 1}}).ok)
    assert(saved.matureRestore.conversationProvider.before == 'convai', tostring(saved.matureRestore.conversationProvider.before))
    user('matureContent', false)
    assert(drafts() == 'conversationProvider=1,localModel=2,matureContent=false,voiceProvider=6', drafts())
  `);
});

test('Local AI model: a row with each installed model by its name from the smallest to the largest and no Auto, the default model selected until one is chosen, sizes in the help, the pin saved by id', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    local function state(tag, value)
      jsonFixtures['models-' .. tag] = value
      files['runtime/mistral-state.json'] = 'models-' .. tag
      clock = clock + 2
    end
    assert(manager.snapshot(player).settings.localModel == 'auto' and saved.localModel == 'auto', 'nothing chosen is the stored default')
    assert(invoke('tab:settings').ok)
    -- No model installed: the row is there with one placeholder, and nothing is said about sizes.
    state('none', {provider = 'local', effective = 'local', saved = false})
    loaded = registered.loadMod('manager')
    local bare = row('localModel')
    assert(bare ~= nil and bare.label == 'Local AI model' and bare.type == 'select' and bare.value == 1)
    assert(#bare.elements == 1 and bare.elements[1] == 'No model installed', table.concat(bare.elements, '|'))
    assert(not tostring(bare.description):find('Installed models', 1, true))
    assert(not tostring(bare.description):lower():find('recommended', 1, true), 'no option is ever called recommended')
    assert(#manager.localModelChoices() == 0 and manager.localModelDefaultId() == nil and manager.localModelMatureId() == nil)
    -- With no model installed an Apply leaves 'auto' as it is (there is no default model to save).
    assert(manager.applySettings(player, {followUpInterest = true}) and saved.localModel == 'auto', tostring(saved.localModel))
    -- Three installed models, as the bridge reports them, NOT in size order (a malformed entry is dropped): the row sorts them small to large.
    state('three', {provider = 'local', effective = 'local', saved = false, maturePack = true,
      localModelDefault = 'standard', localModelMatureDefault = 'mature:big', localModels = {
      {id = 'standard', name = 'Gemma-4-E4B', sizeMiB = 5280}, {id = 'mature:big', name = 'Gemma-4-E4B-uncensored', sizeMiB = 5400},
      {id = 'lite', name = 'Qwen3.5-2B', sizeMiB = 1311}, {id = 'bad id', name = 'Nope', sizeMiB = 1}, {id = 'x', name = 5}}})
    loaded = registered.loadMod('manager')
    local pick = row('localModel')
    assert(#pick.elements == 3 and pick.elements[1] == 'Qwen3.5-2B' and pick.elements[2] == 'Gemma-4-E4B' and pick.elements[3] == 'Gemma-4-E4B-uncensored', table.concat(pick.elements, '|'))
    for _, label in ipairs(pick.elements) do assert(label ~= 'Auto', 'there is no Auto entry') end
    assert(not tostring(pick.description):find('Auto', 1, true), pick.description)
    assert(manager.localModelDefaultId() == 'standard' and manager.localModelMatureId() == 'mature:big')
    -- Nothing chosen (saved 'auto'): the default model is shown as selected, and 'auto' stays saved until an Apply.
    assert(pick.value == 2, tostring(pick.value))
    assert(manager.snapshot(player).settings.localModel == 'auto' and saved.localModel == 'auto')
    assert(tostring(pick.description):find('Qwen3.5-2B (1.3 GB)' .. string.char(10) .. 'Gemma-4-E4B (5.2 GB)' .. string.char(10) .. 'Gemma-4-E4B-uncensored (5.3 GB)', 1, true), pick.description)
    assert(tostring(pick.description):find('Until you choose one', 1, true), pick.description)
    -- Choosing by position saves the model's id.
    assert(registered.applyBatch('manager', {{id = 'localModel', value = 1}}).ok and saved.localModel == 'lite')
    loaded = registered.loadMod('manager')
    assert(row('localModel').value == 1, 'the saved model is selected again')
    assert(registered.applyBatch('manager', {{id = 'localModel', value = 3}}).ok and saved.localModel == 'mature:big')
    assert(registered.applyBatch('manager', {{id = 'localModel', value = 2}}).ok and saved.localModel == 'standard')
    for _, bad in ipairs({0, 4, 1.5, 'lite', true}) do
      local result = registered.applyBatch('manager', {{id = 'localModel', value = bad}})
      assert(result.ok == false and saved.localModel == 'standard', tostring(bad))
    end
    -- A model the player added that is no longer there stays saved (the bridge falls back to the largest model that fits, with one notice); the row shows the default.
    assert(manager.applySettings(player, {localModel = 'custom:gone-model'}) and saved.localModel == 'custom:gone-model')
    loaded = registered.loadMod('manager')
    assert(row('localModel').value == 2, 'the default is selected when the saved model is gone')
    assert(manager.applySettings(player, {followUpInterest = false}) and saved.localModel == 'custom:gone-model', 'an Apply of something else must not change a model that is only missing')
    -- A saved model that left its pack is replaced and saved silently: a Mature id by the model the bridge names for Mature content, any other by the default.
    assert(manager.applySettings(player, {localModel = 'mature:qwen3.5-9b-uncensored-hauhaucs-aggressive-q4_k_m'}))
    assert(saved.localModel == 'mature:big', 'the Apply saved the model the bridge maps a gone Mature model to: ' .. tostring(saved.localModel))
    assert(manager.applySettings(player, {localModel = 'gemma-4-e2b-old'}) and saved.localModel == 'standard', tostring(saved.localModel))
    -- Without any Apply: the bridge's state is read and the saved value is repaired by itself (once; a valid choice is never touched).
    saved.localModel = 'mature:qwen3.5-9b-old'
    state('three-again', {provider = 'local', effective = 'local', saved = false, maturePack = true,
      localModelDefault = 'standard', localModelMatureDefault = 'mature:big', localModels = {
      {id = 'standard', name = 'Gemma-4-E4B', sizeMiB = 5280}, {id = 'mature:big', name = 'Gemma-4-E4B-uncensored', sizeMiB = 5400},
      {id = 'lite', name = 'Qwen3.5-2B', sizeMiB = 1311}}})
    loaded = registered.loadMod('manager')
    manager.snapshot(player)
    assert(saved.localModel == 'mature:big', 'the gone Mature model was replaced in the saved file: ' .. tostring(saved.localModel))
    saved.localModel = 'lite'
    manager.snapshot(player); clock = clock + 2; manager.mistral()
    assert(saved.localModel == 'lite', 'a listed model is left alone')
    saved.localModel = 'custom:mine'
    manager.snapshot(player); clock = clock + 2; manager.mistral()
    assert(saved.localModel == 'custom:mine', 'a model the player added is never replaced')
    -- No Mature model in the list: a gone Mature id has no replacement and stays (the bridge announces it).
    state('no-mature', {provider = 'local', effective = 'local', saved = false, localModelDefault = 'standard', localModelMatureDefault = nil, localModels = {
      {id = 'standard', name = 'Gemma-4-E4B', sizeMiB = 5280}, {id = 'lite', name = 'Qwen3.5-2B', sizeMiB = 1311}}})
    saved.localModel = 'mature:qwen3.5-9b-old'
    manager.snapshot(player); clock = clock + 2; manager.mistral()
    assert(saved.localModel == 'mature:qwen3.5-9b-old', tostring(saved.localModel))
    -- A saved 'auto' (an older version, or nothing chosen) is replaced by the default model's id on any Apply, silently.
    saved.localModel = 'auto'
    assert(manager.snapshot(player).settings.localModel == 'auto')
    local ok, err, notice = manager.applySettings(player, {followUpInterest = true})
    assert(ok and err == nil and notice == nil, 'the replacement is silent: ' .. tostring(err) .. ' ' .. tostring(notice))
    assert(saved.localModel == 'standard', tostring(saved.localModel))
    assert(manager.applySettings(player, {localModel = 'lite'}) and saved.localModel == 'lite')
    ok, err, notice = manager.applySettings(player, {localModel = 'auto'})
    assert(ok and notice == nil and saved.localModel == 'standard', 'choosing auto by hand saves the default model: ' .. tostring(saved.localModel))
    assert(manager.applySettings(player, {localModel = 'two words'}) == false and manager.applySettings(player, {localModel = 7}) == false)
    assert(saved.localModel == 'standard')
    -- A saved value that is not an id reads as 'auto'.
    saved.localModel = '../x'
    assert(manager.snapshot(player).settings.localModel == 'auto')
    -- No default published (or one that is not in the list): the first (smallest) model is shown as selected, and 'auto' stays on Apply.
    for _, default in ipairs({false, 'ghost', 'bad id'}) do
      state('nodefault-' .. tostring(default), {provider = 'local', effective = 'local', saved = false,
        localModelDefault = default or nil, localModelMatureDefault = 'ghost', localModels = {
        {id = 'standard', name = 'Gemma-4-E4B', sizeMiB = 5280}, {id = 'lite', name = 'Qwen3.5-2B', sizeMiB = 1311}}})
      saved.localModel = 'auto'
      loaded = registered.loadMod('manager')
      assert(manager.localModelDefaultId() == nil and manager.localModelMatureId() == nil, tostring(default))
      local shown = row('localModel')
      assert(shown.elements[1] == 'Qwen3.5-2B' and shown.value == 1, tostring(default) .. ' ' .. tostring(shown.value))
      assert(manager.applySettings(player, {followUpInterest = false}) and saved.localModel == 'auto', tostring(default) .. ' ' .. tostring(saved.localModel))
    end
    -- Equal sizes sort by name.
    state('ties', {provider = 'local', effective = 'local', saved = false, localModels = {
      {id = 'b', name = 'Bravo', sizeMiB = 2000}, {id = 'a', name = 'alpha', sizeMiB = 2000}, {id = 'c', name = 'Charlie', sizeMiB = 1000}}})
    loaded = registered.loadMod('manager')
    assert(table.concat(row('localModel').elements, '|') == 'Charlie|alpha|Bravo', table.concat(row('localModel').elements, '|'))
  `);
});

test('Local AI model: custom models are marked, show the memory they need or that the card is too small, and unusable ones are named in the help', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    local function state(tag, value)
      jsonFixtures['custom-' .. tag] = value
      files['runtime/mistral-state.json'] = 'custom-' .. tag
      clock = clock + 2
    end
    assert(invoke('tab:settings').ok)
    state('one', {provider = 'local', effective = 'local', saved = false, localModels = {
      {id = 'standard', name = 'Gemma-4-E4B', sizeMiB = 5280},
      {id = 'custom:mine', name = 'My Model', sizeMiB = 4096, custom = true, needMiB = 5296},
      {id = 'custom:huge', name = 'Huge', sizeMiB = 40960, custom = true, needMiB = 42160, tooLarge = true},
      {id = 'custom:odd', name = 'Odd', sizeMiB = 100, custom = false, tooLarge = true}},
      localModelProblems = {{name = 'Embedder', reason = 'embedding'}, {name = 'Gone', reason = 'missing'}, {name = 'Fake', reason = 'bad-gguf'},
        {name = 'Locked', reason = 'unreadable'}, {name = 'Bad', reason = 'other'}, {name = 5, reason = 'missing'}}})
    loaded = registered.loadMod('manager')
    local pick = row('localModel')
    assert(#pick.elements == 4 and pick.elements[1] == 'Odd' and pick.elements[3] == 'Gemma-4-E4B', table.concat(pick.elements, '|'))
    for _, label in ipairs(pick.elements) do assert(label ~= 'Auto', 'there is no Auto entry') end
    assert(pick.elements[2] == 'My Model (custom)' and pick.elements[4] == 'Huge (custom · too large)', table.concat(pick.elements, '|'))
    assert(pick.elements[1] == 'Odd', 'only custom models are marked, whatever else the file says')
    local help = tostring(pick.description)
    assert(help:find('Gemma-4-E4B (5.2 GB)', 1, true), help)
    assert(help:find('My Model (custom, 4.0 GB, needs 5.2 GB)', 1, true), help)
    assert(help:find('Huge (custom, 40.0 GB, too large for this card)', 1, true), help)
    assert(help:find('Custom models are ones you added;', 1, true), help)
    assert(help:find('Not usable: Embedder: an embedding model, not a chat model; Gone: file not found; Fake: not a valid GGUF file; Locked: could not be read.', 1, true), help)
    assert(not help:find('Bad', 1, true), 'an unknown reason is dropped')
    -- Pinning a custom model saves its id; it can be chosen even though it is too large (the bridge then falls back to the largest model that fits, with one notice).
    assert(registered.applyBatch('manager', {{id = 'localModel', value = 2}}).ok and saved.localModel == 'custom:mine')
    assert(registered.applyBatch('manager', {{id = 'localModel', value = 4}}).ok and saved.localModel == 'custom:huge')
    loaded = registered.loadMod('manager')
    assert(row('localModel').value == 4)
    -- No custom models: the row is as before, with no note about them.
    state('none', {provider = 'local', effective = 'local', saved = false, localModels = {{id = 'standard', name = 'Gemma-4-E4B', sizeMiB = 5280}}})
    loaded = registered.loadMod('manager')
    local plain = tostring(row('localModel').description)
    assert(not plain:find('custom', 1, true) and not plain:find('Not usable', 1, true), plain)
  `);
});

test('select option width: the Lua estimate equals the test estimate, and a name that is too long is cut with an ellipsis and keeps its marker', () => {
  const samples = ['Pocket · Performance', 'OmniVoice · Ultra Quality · needs pack', 'Qwen3.5-4B · uncensored', 'Mistral (free plan)', 'WWWW MMMM mmmm', '日本語のテスト', 'Español (México)', 'Русский', 'It’s'];
  const expected = samples.map(text => `{${JSON.stringify(text)}, ${optionUnits(text)}}`).join(', ');
  run(`${mcmFixture}
    for _, pair in ipairs({${expected}}) do
      assert(math.abs(mcm.optionUnits(pair[1]) - pair[2]) < 0.05, pair[1] .. ' ' .. mcm.optionUnits(pair[1]) .. ' vs ' .. pair[2])
    end
    local budget = mcm.OPTION_BUDGET
    local function valid(text) return utf8.len(text) ~= nil end
    -- A text that fits is returned as it is.
    assert(mcm.fitOption('Pocket · Performance') == 'Pocket · Performance')
    assert(mcm.fitOption('') == '' and mcm.fitOption(nil) == '')
    -- The name is cut, the marker stays.
    local long = mcm.fitOption('Qwen3.5-4B-HauhauCS-Aggressive-Extended (uncensored)')
    assert(long:find('…', 1, true) and long:sub(-13) == ' (uncensored)' and mcm.optionUnits(long) <= budget, long)
    local custom = mcm.fitOption('A very long custom model name from somebody (custom · too large)')
    assert(custom:sub(-22) == ' (custom · too large)' and custom:find('…', 1, true) and mcm.optionUnits(custom) <= budget, custom)
    local dotted = mcm.fitOption('Gemma 4 E4B Heretic Ultra Abliterated Edition · uncensored')
    assert(dotted:sub(-14) == ' · uncensored' and mcm.optionUnits(dotted) <= budget, dotted)
    -- No marker: the whole text is cut. Wide characters are cut on a character boundary, never inside one.
    local plain = mcm.fitOption(string.rep('M', 60))
    assert(plain:sub(-3) == '…' and mcm.optionUnits(plain) <= budget, plain)
    local wide = mcm.fitOption(string.rep('日本語', 20))
    assert(valid(wide) and wide:sub(-3) == '…' and mcm.optionUnits(wide) <= budget and #wide > 3, wide)
    local accented = mcm.fitOption(string.rep('é', 80))
    assert(valid(accented) and mcm.optionUnits(accented) <= budget, accented)
    -- A marker that is itself wider than the budget does not leave an empty name: the whole text is cut instead.
    local huge = mcm.fitOption('x (' .. string.rep('long marker ', 10) .. ')')
    assert(valid(huge) and mcm.optionUnits(huge) <= budget and huge:find('…', 1, true), huge)
  `);
});

test('select option width: every select of the settings page fits in English, the built-in model names are shown whole, and a custom model with a long name is cut', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    files['runtime/mistral-state.json'] = 'wide'
    jsonFixtures['wide'] = {provider = 'local', effective = 'local', saved = false, localModels = {
      {id = 'lite', name = 'Qwen3.5-2B', sizeMiB = 1311},
      {id = 'mature:lite', name = 'Qwen3.5-4B · uncensored', sizeMiB = 2700},
      {id = 'standard', name = 'Gemma 4 E4B', sizeMiB = 5280},
      {id = 'mature:good', name = 'Gemma 4 E4B · uncensored', sizeMiB = 5335},
      {id = 'custom:long', name = 'My Own Fine-Tuned Companion Model 13B Instruct', sizeMiB = 7000, custom = true, needMiB = 8000},
      {id = 'custom:huge', name = 'Enormous Community Merge With A Very Long Name', sizeMiB = 40960, custom = true, needMiB = 42160, tooLarge = true}}}
    clock = clock + 2
    files['runtime/local-voice-state.json'] = 'voice-runtime'
    assert(invoke('tab:settings').ok)
    loaded = registered.loadMod('manager')
    local checked, widest = 0, 0
    for _, category in ipairs(loaded.categories) do
      for _, setting in ipairs(category.settings) do
        if setting.type == 'select' and setting.elements then
          for index, label in ipairs(setting.elements) do
            checked = checked + 1
            widest = math.max(widest, mcm.optionUnits(label))
            assert(mcm.optionUnits(label) <= mcm.OPTION_BUDGET, setting.id .. ' option ' .. index .. ': ' .. label .. ' (' .. mcm.optionUnits(label) .. ')')
          end
        end
      end
    end
    assert(checked >= 30, 'only ' .. checked .. ' options were looked at')
    local models = row('localModel').elements
    assert(#models == 6, table.concat(models, '|'))
    assert(models[1] == 'Qwen3.5-2B' and models[2] == 'Qwen3.5-4B · uncensored' and models[3] == 'Gemma 4 E4B', table.concat(models, '|'))
    assert(models[4] == 'Gemma 4 E4B · uncensored', table.concat(models, '|'))
    local hasCustom, hasHuge = false, false
    for _, label in ipairs(models) do
      if label:find('(custom)', 1, true) then hasCustom = label:find('…', 1, true) ~= nil end
      if label:find('(custom · too large)', 1, true) then hasHuge = label:find('…', 1, true) ~= nil end
    end
    assert(hasCustom and hasHuge, 'a long custom name is cut with an ellipsis and keeps its marker: ' .. table.concat(models, '|'))
    -- The full names stay in the help of the row.
    assert(tostring(row('localModel').description):find('My Own Fine-Tuned Companion Model 13B Instruct (custom, 6.8 GB', 1, true), tostring(row('localModel').description))
  `);
});

test('the Mistral cloud voice speaks English only here: Multilingual conversations refuses it and moves a saved choice to the Convai cloud voice', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    jsonFixtures['mistral-a'] = {provider = 'convai', effective = 'convai', saved = true}
    files['runtime/mistral-state.json'] = 'mistral-a'
    clock = clock + 2
    assert(manager.applySettings(player, {voiceProvider = 'voxtral'}))
    assert(manager.snapshot(player).settings.voiceProvider == 'voxtral')
    -- Turning Multilingual on beside the saved choice moves the voice (the OmniVoice pack is unknown here, so it counts as installed).
    local ok, err = manager.applySettings(player, {multilingualConversations = true})
    assert(ok, err)
    assert(manager.snapshot(player).settings.voiceProvider ~= 'voxtral')
    -- With Multilingual on, choosing the Mistral cloud voice is refused with the reason.
    local refused, message = manager.applySettings(player, {voiceProvider = 'voxtral'})
    assert(refused == false and message == 'The Mistral cloud voice speaks only English here. Turn off Multilingual conversations to choose it.', message)
    assert(manager.snapshot(player).settings.voiceProvider ~= 'voxtral')
  `);
});

test('a Mistral cloud voice that fell back to Pocket is announced once, with the usual wording', () => {
  run(`${mcmFixture}${managerPopupFixture}
    popupStep = 1
    local state = {state = 'ready', provider = 'pocket', requestedProvider = 'pocket', cloudVoice = nil, routedProfiles = {'johnny-silverhand'},
      fallback = {from = 'voxtral', to = 'pocket', temporary = true, reason = 'timeout'}, updated = popupClock * 1000}
    jsonFixtures['voice-runtime'] = state
    files['runtime/local-voice-state.json'] = 'voice-runtime'
    popupTick(false); popupTick(false)
    assert(#popups == 0, 'a paused menu consumed the one fallback notice')
    popupTick(true)
    assert(#popups == 1 and popups[1] == 'Mistral cloud voice (Voxtral) is not ready yet. Companions are using Pocket · Performance for now.', popups[1])
    for _ = 1, 6 do popupTick(true) end
    assert(#popups == 1, 'the same fallback was announced again')
    state.fallback.temporary = false
    for _ = 1, 3 do popupTick(true) end
    assert(#popups == 2 and popups[2] == 'Mistral cloud voice (Voxtral) is unavailable. Companions are using Pocket · Performance instead.', popups[2])
  `);
});

test('the Inworld cloud voice says it needs an Inworld key and cannot be applied without one; with a key it applies, and the key is not the Mistral key', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    local function key(tag, value)
      jsonFixtures['mistral-' .. tag] = value
      files['runtime/mistral-state.json'] = 'mistral-' .. tag
      clock = clock + 2
    end
    local NEEDS = 'Inworld · needs key'
    -- The Inworld voice is a developer-mode voice: it is the eighth and last entry, listed with Developer mode on.
    assert(manager.applySettings(player, {developerMode = true}))
    assert(invoke('tab:settings').ok)
    loaded = registered.loadMod('manager')
    assert(row('voiceProvider').elements[8] == NEEDS, row('voiceProvider').elements[8])
    assert(manager.voiceLabel('inworld') == 'Inworld cloud voice')
    local before = saved.voiceProvider
    local result = registered.applyBatch('manager', {{id = 'voiceProvider', value = 8}})
    assert(result.ok == false and result.error == 'Requires an Inworld key (add it in Settings > Development)', result.error)
    assert(saved.voiceProvider == before)
    assert(not manager.applySettings(player, {voiceProvider = 'inworld'}))
    -- A Mistral key alone does not unlock it.
    key('a', {provider = 'convai', effective = 'convai', saved = true})
    loaded = registered.loadMod('manager')
    assert(row('voiceProvider').elements[8] == NEEDS, row('voiceProvider').elements[8])
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 8}}).ok == false)
    -- An Inworld key is saved: the entry is a plain label and can be applied.
    key('b', {provider = 'convai', effective = 'convai', saved = true, inworld = {saved = true, tail = 'wxyz'}})
    loaded = registered.loadMod('manager')
    assert(row('voiceProvider').elements[8] == 'Inworld · Cloud voice', row('voiceProvider').elements[8])
    assert(manager.mistral().inworld.saved == true and manager.mistral().inworld.tail == 'wxyz')
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 8}}).ok)
    assert(saved.voiceProvider == 'inworld' and manager.snapshot(player).settings.voiceProvider == 'inworld')
    -- It rides on Pocket, so Expressive emotions stay on: they become its steering.
    assert(manager.snapshot(player).settings.expressiveEmotions == true)
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 7}, {id = 'expressiveEmotions', value = false}}).ok and saved.voiceProvider == 'convai')
    assert(dofile('voice-preview.lua').indexOf({voiceProvider = 'inworld'}) == 8)
  `);
});

test('the Inworld key is one Paste or Remove row in Settings > Development, with Developer mode on; it goes through its own command file and the page shows only its last four characters', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    local function inCategory(category, id)
      for _, item in ipairs(loaded.categories) do
        if item.id == category then for _, setting in ipairs(item.settings) do if setting.id == id then return setting end end end
      end
    end
    assert(invoke('tab:settings').ok)
    assert(row('inworld-key') == nil, 'the Inworld key row is listed without Developer mode')
    assert(manager.applySettings(player, {developerMode = true}))
    loaded = registered.loadMod('manager')
    local item = row('inworld-key')
    assert(item and inCategory('development', 'inworld-key') and not inCategory('voices', 'inworld-key'), 'the row belongs to Development')
    assert(item.type == 'action' and item.label == 'Inworld API key' and item.value == 'Paste', item.label .. '|' .. tostring(item.value))
    assert(row('inworld-key-status') == nil and row('inworld-key:paste') == nil and row('inworld-key:remove') == nil, 'the old rows are gone')
    assert(invoke('inworld-key').ok, 'paste invoke')
    local command = jsonFixtures[files['runtime/inworld-key-command.json']]
    assert(command.version == 1 and command.action == 'paste' and command.id:find(':ikey:1', 1, true), 'command')
    assert(files['runtime/mistral-key-command.json'] == nil and files['runtime/groq-key-command.json'] == nil and files['runtime/memory-command.json'] == nil, 'other channels')
    jsonFixtures['mistral-i'] = {provider = 'convai', effective = 'convai', saved = false, inworld = {saved = true, tail = 'wxyz'}}
    files['runtime/mistral-state.json'] = 'mistral-i'
    clock = clock + 2
    manager.snapshot(player)
    loaded = registered.loadMod('manager')
    item = row('inworld-key')
    assert(item.label == 'Inworld API key (…wxyz)' and item.value == 'Remove', item.label .. '|' .. tostring(item.value))
    assert(invoke('inworld-key').ok)
    command = jsonFixtures[files['runtime/inworld-key-command.json']]
    assert(command.action == 'clear' and command.id:find(':ikey:', 1, true), 'clear command')
    -- Developer mode off again: the row is gone and a saved Inworld voice is Pocket TTS.
    assert(manager.applySettings(player, {developerMode = false}))
    loaded = registered.loadMod('manager')
    assert(row('inworld-key') == nil)
  `);
});

test('prepared voices are always kept: no switch, no disk row, no Clear action or page, and a saved false is ignored', () => {
  run(`${mcmFixture}
    assert(invoke('tab:settings').ok)
    for _, id in ipairs({'keepPreparedVoices', 'prepared-voices', 'prepared-voices:open', 'prepared-voices:confirm', 'prepared-voices:cancel'}) do
      assert(row(id) == nil, id .. ' is still offered')
    end
    assert(manager.preparedVoices == nil and manager.clearPreparedVoices == nil and manager.watchPreparedVoices == nil, 'the prepared voices commands are gone')
    assert(files['runtime/prepared-voices-command.json'] == nil, 'opening Settings asks the bridge to measure prepared voices')
    assert(manager.snapshot(player).settings.keepPreparedVoices == true and manager.snapshot(player).preparedVoices == nil)
    -- An older settings file that saved the switch off is read as on, and saved again as on.
    seed = {version = 2, voice = true, subtitles = true, subtitleStyle = 'dialogue', voiceProvider = 'pocket', keepPreparedVoices = false,
      battleReactions = false, lootReactions = false, enabledByKey = {}}
    for _, profile in ipairs(profiles) do seed.enabledByKey[profile.key] = true end
    files['runtime/settings.json'], saved = 'seed', nil
    manager.configure(api, profiles)
    assert(manager.snapshot(player).settings.keepPreparedVoices == true, 'a saved keepPreparedVoices = false was honoured')
    assert(saved and saved.keepPreparedVoices == true, 'the file was not corrected')
  `);
});

test('a saved Groq provider (the option was removed) reads as Convai free tier, as in the bridge', () => {
  run(`${mcmFixture}
    seed = {version = 2, voice = true, subtitles = true, subtitleStyle = 'dialogue', voiceProvider = 'pocket', conversationProvider = 'groq',
      battleReactions = false, lootReactions = false, enabledByKey = {}}
    for _, profile in ipairs(profiles) do seed.enabledByKey[profile.key] = true end
    files['runtime/settings.json'], saved = 'seed', nil
    jsonFixtures['mistral-groq'] = {provider = 'convai', effective = 'convai', saved = true}
    files['runtime/mistral-state.json'] = 'mistral-groq'
    manager.configure(api, profiles)
    assert(manager.snapshot(player).settings.conversationProvider == 'convai', 'a saved groq was kept')
    assert(saved and saved.conversationProvider == 'convai', 'the file was not corrected')
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 6}}).ok == false, 'there is no sixth provider')
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 0}}).ok == false, 'there is no zeroth provider')
  `);
});

test('the Inworld cloud voice speaks English only here: Multilingual conversations refuses it and moves a saved choice off it', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    jsonFixtures['mistral-a'] = {provider = 'convai', effective = 'convai', saved = true, inworld = {saved = true, tail = 'wxyz'}}
    files['runtime/mistral-state.json'] = 'mistral-a'
    clock = clock + 2
    -- The Inworld voice is a developer-mode voice.
    assert(manager.applySettings(player, {developerMode = true, voiceProvider = 'inworld'}))
    assert(manager.snapshot(player).settings.voiceProvider == 'inworld')
    local ok, err = manager.applySettings(player, {multilingualConversations = true})
    assert(ok, err)
    assert(manager.snapshot(player).settings.voiceProvider ~= 'inworld')
    local refused, message = manager.applySettings(player, {voiceProvider = 'inworld'})
    assert(refused == false and message == 'The Inworld cloud voice speaks only English here. Turn off Multilingual conversations to choose it.', message)
  `);
});

test('an Inworld cloud voice that fell back to Pocket is announced once, with the usual wording and its own name', () => {
  run(`${mcmFixture}${managerPopupFixture}
    popupStep = 1
    local state = {state = 'ready', provider = 'pocket', requestedProvider = 'pocket', cloudVoice = nil, routedProfiles = {'johnny-silverhand'},
      fallback = {from = 'inworld', to = 'pocket', temporary = true, reason = 'timeout'}, updated = popupClock * 1000}
    jsonFixtures['voice-runtime'] = state
    files['runtime/local-voice-state.json'] = 'voice-runtime'
    popupTick(false); popupTick(false)
    popupTick(true)
    assert(#popups == 1 and popups[1] == 'Inworld cloud voice is not ready yet. Companions are using Pocket · Performance for now.', popups[1])
    state.fallback.temporary = false
    for _ = 1, 3 do popupTick(true) end
    assert(#popups == 2 and popups[2] == 'Inworld cloud voice is unavailable. Companions are using Pocket · Performance instead.', popups[2])
  `);
});

test('native Memory submenu has consistent parent navigation and preserves an unissued confirmation', () => {
  run(`${mcmFixture}${memoryFixture}
    publishMemory(1, {{profileKey = 'person-20'}})
    assert(invoke('tab:settings').ok)
    assert(row('memory').type == 'action' and row('memory').value == 'Manage')
    assert(not row('memory:choose') and not row('memory-count'), 'memory controls leaked into the Settings page')
    assert(not row('permissions') and not invoke('permissions').ok and mcm.inspect().view == 'settings', 'Who can talk is gone')
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
      -- Settings saved or other exchange files may still swap through os.remove (a prepared-voices request used to); that is not stored memory.
      local touched = 0
      for _, path in ipairs(removed) do if not tostring(path):find('prepared-voices', 1, true) then touched = touched + 1 end end
      assert(memoryWrites() == 0 and memoryRequest() == nil and touched == 0, 'a back-out or cancel touched stored memory')
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
  assert(selected.description:find('Romantic: speaks to V as a partner',1,true) and not selected.description:find('Off uses',1,true))
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
  -- Nothing is on (Expressive emotions, Follow-up questions, V’s voice and Body gestures are on by default, so they are switched off first)
  -- and nobody is in the party: the description, the voice and the conversation, and no advice text.
  assert(manager.applySettings(player, {expressiveEmotions = false, followUpInterest = false, vVoice = false, bodyGestures = false})); reload()
  local plain = description('viktor-vektor')
  assert(plain == 'A ripperdoc.\\n\\nVoice: Convai voice\\nConversation: On', plain)
  assert(not plain:find('Invitations create', 1, true) and not plain:find('phone contacts', 1, true) and not plain:find('Memory and connection', 1, true))
  assert(description('judy-alvarez'):find('Relationship: Auto', 1, true), 'Judy has a relationship line')
  -- Judy in the party on OmniVoice, with the speech settings, Multilingual and a memory of the player.
  assert(manager.applySettings(player, {voiceProvider = 'omni', omniSteps = 16, omniReference = 'short', naturalSpeech = true,
    expressiveEmotions = true, followUpInterest = true, multilingualConversations = true, relationshipModes = {['judy-alvarez'] = 'on'},
    battleReactions = true, lootReactions = true}))
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
  jsonFixtures['voice-runtime-nopack'] = {state = 'ready', provider = 'pocket', routedProfiles = {}, updated = memoryClock * 1000.0,
    omniPack = {installed = false, missing = {}}}
  files['runtime/local-voice-state.json'] = 'voice-runtime-nopack'
  assert(manager.applySettings(player, {battleReactions = false, lootReactions = false, bodyGestures = true}))
  reload()
  assert(description('viktor-vektor'):find('Voice: OmniVoice · Balanced · needs Omni pack', 1, true), description('viktor-vektor'))
  local judyLines = description('judy-alvarez')
  assert(judyLines:sub(-#'\\nBehavior: Body gestures') == '\\nBehavior: Body gestures', judyLines)
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
    local open = io.open
    io.open = function(path, mode)
      if path == 'runtime/memory-command.json' and mode == 'wb' then return nil end
      return open(path, mode)
    end
    assert(not invoke('memory:confirm:' .. failing).ok)
    io.open = open
    for _ = 1, 10 do mcm.update(player, false) end
    assert(files['runtime/memory-command.json'] == raw and memoryRequest().id == command.id)
    assert(not files['runtime/memory-command.json.tmp'] and not files['runtime/memory-command.json.previous'])
    assert(not manager.confirmMemoryClear(failing) and memoryWrites() == 1)
  `);
});

test('memory recovery reads the saved request, ignores an empty or cut-short file, and blocks a request that parses but is not valid', () => {
  run(`${managerFixture}${memoryFixture}
    publishMemory(1, nil)
    local prior = {version = 1, id = 'saved-ui-session:4', action = 'clear', scope = 'all', issuedAt = memoryClock * 1000.0}
    jsonFixtures.previous = prior
    files['runtime/memory-command.json'] = 'previous'
    manager.configure(api, profiles)
    assert(manager.snapshot(player).memory.command.id == prior.id)
    assert(not manager.beginMemoryClear('all') and memoryWrites() == 0)
    -- The shipped placeholder is empty, and a write cut short does not parse: neither is a request, and neither blocks the page.
    -- (The old backup name is not read either: nothing writes it any more.)
    for _, content in ipairs({'', '   ', 'truncated'}) do
      files['runtime/memory-command.json'] = content
      files['runtime/memory-command.json.previous'] = 'previous'
      manager = (function() ${managerSource} end)()
      manager.configure(api, profiles)
      local state = manager.snapshot(player).memory
      assert(state.command == nil and state.state == 'ready' and not tostring(state.feedback):find('could not be read', 1, true), content)
      assert(manager.beginMemoryClear('all'), content)
    end
    jsonFixtures.invalid = {version = 1, id = 'x', action = 'clear', scope = 'nobody'}
    files['runtime/memory-command.json'] = 'invalid'
    manager = (function() ${managerSource} end)()
    manager.configure(api, profiles)
    local state = manager.snapshot(player).memory
    assert(state.state == 'unavailable' and state.feedback:find('could not be read', 1, true))
    assert(not manager.beginMemoryClear('all') and memoryWrites() == 0)
  `);
});

test('every command file is written in place: no temporary file, backup, remove or rename, and no key in any of them (Mod Organizer 2 only keeps writes to a file that exists)', () => {
  run(`${managerFixture}${memoryFixture}
    publishMemory(1, nil)
    manager.configure(api, profiles)
    local removed, renamed, opened = {}, {}, {}
    -- The player's saved settings keep their own protected write (a different class of file): only those paths are exempt.
    local function exempt(path) return tostring(path):find('runtime/settings.json', 1, true) == 1 end
    os.remove = function(path) if not exempt(path) then removed[#removed + 1] = path end return true end
    os.rename = function(from) if not exempt(from) then renamed[#renamed + 1] = from end return true end
    local open = io.open
    io.open = function(path, mode) if mode == 'wb' and not exempt(path) then opened[#opened + 1] = path end return open(path, mode) end
    assert(manager.pasteOwnKey() and manager.removeOwnKey())
    assert(manager.pasteMistralKey() and manager.removeMistralKey())
    assert(manager.pasteInworldKey() and manager.removeInworldKey())
    assert(manager.beginMemoryClear('all'))
    assert(manager.confirmMemoryClear(manager.snapshot(player).memory.confirmation.token))
    assert(#removed == 0 and #renamed == 0, 'a command file was removed or renamed: ' .. table.concat(removed, ',') .. '|' .. table.concat(renamed, ','))
    local seen = {}
    for _, path in ipairs(opened) do
      assert(not path:find('.tmp', 1, true) and not path:find('.previous', 1, true), 'a side file was opened: ' .. path)
      seen[path] = (seen[path] or 0) + 1
    end
    for _, path in ipairs({'own-key-command', 'mistral-key-command', 'inworld-key-command'}) do
      assert(seen['runtime/' .. path .. '.json'] == 2, path)
      -- Only the request: the key itself never leaves the clipboard for any file the game writes.
      local command = jsonFixtures[files['runtime/' .. path .. '.json']]
      local names = {}
      for name in pairs(command) do names[#names + 1] = name end
      table.sort(names)
      assert(table.concat(names, ',') == 'action,id,issuedAt,version', table.concat(names, ','))
    end
    assert(seen['runtime/memory-command.json'] == 1 and memoryRequest().scope == 'all')
  `);
});

test('an empty status file is no status: every status reader behaves as for a missing file', () => {
  run(`${managerFixture}${memoryFixture}
    for _, name in ipairs({'memory-status', 'own-key-state', 'mistral-state', 'local-voice-state', 'paid-tier-state'}) do
      files['runtime/' .. name .. '.json'] = ''
    end
    manager.configure(api, profiles)
    local state = manager.snapshot(player)
    assert(state.memory.state == 'unavailable' and state.memory.command == nil)
    local key = manager.ownKey()
    assert(key.saved == false and key.active == 'shared' and key.pending == false and key.result == nil)
    for _ = 1, 3 do manager.snapshot(player) end
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
    assert(row('keepPreparedVoices') == nil)
    assert(row('voice-pack') == nil, 'the OmniVoice pack has no row of its own')
    assert(row('disappearingMessages') == nil)
    assert(row('battleReactions').type == 'bool' and row('battleReactions').value == false)
    assert(row('lootReactions').type == 'bool' and row('lootReactions').value == false)
    -- The retired follow-up question toggle is no longer offered.
    assert(row('followUpQuestions') == nil)
    assert(registered.applyBatch('manager', {{id = 'lootReactions', value = false}}).ok)
    assert(not manager.lootReactions())
    assert(registered.applyBatch('manager', {{id = 'battleReactions', value = false}}).ok)
    assert(not manager.battleReactions())
    local applied = registered.applyBatch('manager', {{id = 'voice', value = false}, {id = 'voiceProvider', value = 7}, {id = 'subtitleStyle', value = 2}, {id = 'expressiveEmotions', value = false}})
    assert(applied.ok and applied.atomic and #applied.appliedIds == 4 and saved.omniSteps == 16)
    assert(saved.voiceProvider == 'convai')
    loaded = registered.loadMod('manager')
    assert(manager.subtitleStyle() == 'overhead' and row('subtitleStyle').value == 2)
    for _, invalid in ipairs({0, 3, '1', 'overhead', false}) do
      assert(not registered.applyBatch('manager', {{id = 'subtitles', value = false}, {id = 'subtitleStyle', value = invalid}}).ok)
      assert(manager.subtitleStyle() == 'overhead' and player.subtitles)
    end
    assert(registered.applyBatch('manager', {{id = 'subtitleStyle', value = 1}}).ok)
    assert(manager.subtitleStyle() == 'dialogue' and saved.voiceProvider == 'convai')
    assert(not registered.applyBatch('manager', {{id = 'voiceProvider', value = 9}}).ok)
    assert(not registered.applyBatch('manager', {{id = 'voiceProvider', value = 8}}).ok, 'the Inworld entry needs its key')
    assert(not registered.applyBatch('manager', {{id = 'voiceProvider', value = 0}}).ok)
    assert(not registered.applyBatch('manager', {{id = 'voiceProvider', value = '1'}}).ok)
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 3}}).ok)
    assert(saved.voiceProvider == 'omni' and saved.omniSteps == 16 and saved.omniReference == 'long')
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 4}}).ok)
    assert(saved.voiceProvider == 'omni' and saved.omniSteps == 32 and saved.omniReference == 'short')
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 7}}).ok and saved.voiceProvider == 'convai')
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

test('settings review wording: short voice description, Body gestures without a suffix, full Developer mode text, Model browser says what it lists', () => {
  run(`${mcmFixture}
    local home = row('tab:models')
    assert(home and home.label == 'Model browser')
    assert(home.description:find('without conversation support', 1, true) and home.description:find('do not talk', 1, true))
    assert(invoke('tab:settings').ok)
    local voices = row('voiceProvider')
    assert(voices.defaultValue == 1 and voices.value == 1)
    assert(voices.description:find('about 0.2 s', 1, true) and voices.description:find('1 to 2.5 s', 1, true))
    assert(not voices.description:find('%', 1, true), 'no listening percentages in the voice description')
    assert(utf8.len(voices.description) < 700 and select(2, voices.description:gsub(string.char(10) .. string.char(10), '')) >= 2, 'the voice description stays short and is split into blocks')
    assert(not voices.description:find('Inworld', 1, true), 'the Inworld voice is not mentioned without Developer mode')
    assert(not voices.description:lower():find('recommended', 1, true), 'no voice is called recommended')
    assert(row('bodyGestures').label == 'Body gestures' and row('bodyGestures').defaultValue == true and row('bodyGestures').value == true)
    assert(row('sitWithYou') == nil, 'companions always sit with V: there is no Sit with you setting')
    assert(row('autoConnectNearby').defaultValue == true and row('keepPreparedVoices') == nil)
    local developer = row('developerMode').description
    for _, part in ipairs({'popups', 'movement trace', 'gesture', 'support reports'}) do
      assert(developer:find(part, 1, true), 'Developer mode must say it enables ' .. part)
    end
    assert(row('headFollowStrength').defaultValue == 3)
    assert(manager.snapshot(player).settings.headFollowStrength == 1, 'the saved strength values are unchanged')
    -- Developer mode adds the Inworld voice to the description, as one more paragraph.
    assert(manager.applySettings(player, {developerMode = true}))
    loaded = registered.loadMod('manager')
    local withInworld = row('voiceProvider').description
    assert(withInworld:find('Inworld: the same with your own Inworld key, and it also speaks with emotion.', 1, true), 'the Inworld voice is described as speaking with emotion')
    assert(withInworld:sub(1, #voices.description) == voices.description, 'the Inworld paragraph comes after the common text')
    assert(utf8.len(withInworld) < 800 and not withInworld:lower():find('recommended', 1, true))
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
    -- The queue is flushed on the settings integration's 0.25 s tick.
    local tickClock = os.clock()
    os.clock = function() return tickClock + 1 end
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

test('Voice volume is a Voices slider (50 to 200, steps of 5, 100 by default) saved for the bridge', () => {
  run(`${mcmFixture}
    assert(manager.snapshot(player).settings.voiceVolume == 100)
    assert(invoke('tab:settings').ok)
    local item = assert(row('voiceVolume'))
    assert(item.type == 'int' and item.value == 100 and item.defaultValue == 100)
    assert(item.min == 50 and item.max == 200 and item.step == 5, 'a slider range, not a list of steps')
    assert(item.elements == nil and item.label:find('%', 1, true), 'the unit is in the name: MCM shows only the number')
    assert(not item.description:lower():find('recommended', 1, true))
    -- It sits in the Voices category, after the voice and delay rows.
    local category
    for _, c in ipairs(registered.loadMod('manager').categories or {}) do
      for _, s in ipairs(c.settings) do if s.id == 'voiceVolume' then category = c.id end end
    end
    assert(category == 'voices', 'found in ' .. tostring(category))
    saved = nil
    assert(registered.applyBatch('manager', {{id = 'voiceVolume', value = 150}}).ok)
    assert(manager.snapshot(player).settings.voiceVolume == 150)
    assert(saved and saved.voiceVolume == 150, 'runtime/settings.json carries the value the bridge polls')
    assert(registered.applyBatch('manager', {{id = 'voiceVolume', value = 53}}).ok)
    assert(manager.snapshot(player).settings.voiceVolume == 55, 'a value between steps lands on the nearest step')
    assert(registered.applyBatch('manager', {{id = 'voiceVolume', value = 200}}).ok and manager.snapshot(player).settings.voiceVolume == 200)
    assert(registered.applyBatch('manager', {{id = 'voiceVolume', value = 50}}).ok and manager.snapshot(player).settings.voiceVolume == 50)
    for _, bad in ipairs({49, 201, 'loud', 0 / 0}) do
      assert(not registered.applyBatch('manager', {{id = 'voiceVolume', value = bad}}).ok, 'refused: ' .. tostring(bad))
      assert(not manager.applySettings(player, {voiceVolume = bad}))
    end
    assert(manager.snapshot(player).settings.voiceVolume == 50, 'a refused value changes nothing')
  `);
});

test('a saved Voice volume survives loading, and a hand-edited value is brought back into range', () => {
  for (const [stored, expected, rewritten] of [[130, 130, false], [999, 100, true], [133, 135, true]]) {
    run(`${managerFixture}
      seed = {version = 2, subtitleStyle = 'dialogue', voiceProvider = 'convai', omniSteps = 16, enabledByKey = {}, voiceVolume = ${stored}}
      for _, profile in ipairs(profiles) do seed.enabledByKey[profile.key] = true end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.reset(); manager.configure(api, profiles)
      assert(manager.snapshot(player).settings.voiceVolume == ${expected}, 'loaded ' .. tostring(manager.snapshot(player).settings.voiceVolume))
      if ${rewritten} then assert(saved ~= nil and saved.voiceVolume == ${expected}, 'a repaired value is written back') end
    `);
  }
});

test('Current party shows no Play or game voice row under Dismiss, in Developer mode or out of it', () => {
  run(`${mcmFixture}
    api.spawn('johnny-silverhand')
    members[1].state = 'ready'; members[1].baseName = members[1].name; members[1].name = members[1].name .. ' #1'
    local function onlyDismiss(navigate)
      if navigate then assert(invoke('tab:party').ok) end
      assert(not row('gamevoice:live:1'), 'no game voice row')
      assert(row('dismiss:live:1'), 'Dismiss stays')
      for _, category in ipairs(loaded.categories) do
        for _, item in ipairs(category.settings) do assert(item.value ~= 'Play', 'no Play row: ' .. tostring(item.id)) end
      end
    end
    onlyDismiss(true)
    assert(registered.applyBatch('manager', {{id = 'developerMode', value = true}}).ok)
    loaded = registered.loadMod('manager')
    onlyDismiss(false)
  `);
});

test('The queue still queues one vanilla VO line per game voice request for gameplay', () => {
  run(`${managerFixture}
    manager.configure(api, profiles)
    local queue = (function() ${queueSource} end)().new(api)
    queue.bind('player-1')
    api.spawn('johnny-silverhand'); members[1].state = 'ready'
    local queued, contexts = {}, {}
    SoundPlayVo = {new = function() return {} end}
    CName = CName or {new = function(value) return value end}
    api.actor = function(serial) return serial == 1 and {QueueEvent = function(_, event) queued[#queued + 1] = event end} or nil end
    assert(queue.gameVoice('live:1'))
    assert(#queued == 0, 'nothing plays inside the menu')
    queue.flush()
    assert(#queued == 1 and queued[1].ignoreFrustumCheck and queued[1].ignoreDistanceCheck)
    contexts[1] = queued[1].voContext
    queue.flush(); assert(#queued == 1, 'one request plays one line')
    assert(queue.gameVoice('live:1')); queue.flush()
    assert(#queued == 2 and queued[2].voContext ~= contexts[1], 'the next request asks for another line')
    assert(queue.gameVoice('live:99') == false)
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
      assert(actual.setDraft(key .. ':voiceProvider', 7))
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
      assert(actual.getValue(key .. ':voiceProvider') == 7)
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
      assert(actual.revert(key) and actual.getValue(key .. ':voiceProvider') == 7)
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
      -- The Who can talk page is gone: its action is not there to invoke.
      assert(actual.invokeAction(key .. ':permissions') == false and mcm.inspect().view == 'settings')
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

test('the local voice state is decoded once per distinct file text, and a copy that goes stale stays stale', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    local clock = 1000
    os.time = function() return clock end
    jsonFixtures['voice-a'] = {state = 'ready', provider = 'pocket', routedProfiles = {'viktor-vektor'}, updated = clock * 1000}
    files['runtime/local-voice-state.json'] = 'voice-a'
    local decodes, decode = {}, json.decode
    json.decode = function(value) decodes[value] = (decodes[value] or 0) + 1; return decode(value) end
    -- Ten seconds of 10 Hz frames: five reads of the file, one decode of the same text.
    for _ = 1, 100 do clock = clock + 0.1; manager.update(player, 0.1) end
    assert(decodes['voice-a'] == 1, 'the same text was decoded ' .. tostring(decodes['voice-a']) .. ' times')
    assert(manager.snapshot(player).localVoice.state == 'ready')
    -- Nothing rewrites the file: its stamp ages past 15 s and the voices read as waiting, still without a decode.
    for _ = 1, 150 do clock = clock + 0.1; manager.update(player, 0.1) end
    assert(decodes['voice-a'] == 1, 'a stale state was decoded again')
    local stale = manager.snapshot(player).localVoice
    assert(stale.state == 'waiting' and #(stale.routedProfiles or {}) == 0, 'stale state: ' .. tostring(stale.state))
    -- The bridge rewrites it (new stamp, new text): decoded once more and fresh again.
    jsonFixtures['voice-b'] = {state = 'ready', provider = 'omni', routedProfiles = {'viktor-vektor'}, updated = clock * 1000}
    files['runtime/local-voice-state.json'] = 'voice-b'
    for _ = 1, 50 do clock = clock + 0.1; manager.update(player, 0.1) end
    assert(decodes['voice-b'] == 1 and decodes['voice-a'] == 1)
    local fresh = manager.snapshot(player).localVoice
    assert(fresh.state == 'ready' and fresh.provider == 'omni', 'a changed file was not picked up')
    -- The file disappears: nothing is cached over it.
    files['runtime/local-voice-state.json'] = nil
    for _ = 1, 50 do clock = clock + 0.1; manager.update(player, 0.1) end
    assert(manager.snapshot(player).localVoice.state == 'waiting')
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
      assert(saved.omniSteps == 32 and saved.keepPreparedVoices == true, 'an explicit choice was reset by migration, or the always-on prepared voices were not restored')
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

test('Natural speech is off by default and a saved pairing with the Convai cloud voice keeps the voice and turns it off', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved.naturalSpeech == false and manager.naturalSpeech() == false)
    assert(manager.snapshot(player).settings.naturalSpeech == false)
    for _, case in ipairs({{'missing', 'convai'}, {true, 'convai'}, {true, 'pocket'}, {true, 'omni'}, {false, 'convai'}, {'yes', 'convai'}}) do
      seed = {version = 2, voiceProvider = case[2], enabledByKey = {}, future = {keep = 'unchanged'}}
      if case[1] ~= 'missing' then seed.naturalSpeech = case[1] end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      -- Natural speech needs a local voice: beside the cloud voice it is turned off and the voice is kept (2026-10-11).
      local on = case[1] == true and case[2] ~= 'convai'
      assert(manager.naturalSpeech() == on and saved.naturalSpeech == on, tostring(case[1]))
      assert(saved.voiceProvider == case[2] and manager.snapshot(player).settings.voiceProvider == case[2])
      assert(saved.future.keep == 'unchanged')
    end
  `);
});

test('Natural speech and the cloud voice: choosing the cloud voice keeps it and turns Natural speech off with one notice; turning it on beside the saved cloud voice moves the voice to Pocket TTS', () => {
  run(`${mcmFixture}
    local clock = 5000
    os.clock = function() return clock end
    local sent = {}
    function player:ConvaiPhoneFeedback(text) sent[#sent + 1] = text end
    assert(invoke('tab:settings').ok)
    local entry = row('naturalSpeech')
    assert(entry and entry.type == 'bool' and entry.value == false and entry.defaultValue == false, 'off by default')
    local NOTICE = 'Natural speech needs a local voice, so Companion voices was switched to ' .. manager.voiceLabel('pocket') .. '.'
    local OFF = 'The Convai cloud voice cannot use Natural speech or Expressive emotions, so they were turned off.'
    -- The menu positions of the cloud voice, of Pocket and of the first OmniVoice entry, wherever the list puts them.
    local CLOUD, OMNI, POCKET
    for index, choice in ipairs(dofile('voice-preview.lua').CHOICES) do
      if choice.provider == 'convai' then CLOUD = index end
      if choice.provider == 'pocket' then POCKET = index end
      if choice.provider == 'omni' and not OMNI then OMNI = index end
    end
    assert(CLOUD and OMNI and POCKET)
    local function apply(...)
      clock = clock + 2
      local changes = {}
      for _, change in ipairs({...}) do changes[#changes + 1] = {id = change[1], value = change[2]} end
      return registered.applyBatch('manager', changes)
    end
    -- Expressive emotions is on by default and has the same cloud-voice rule: switch it off so only Natural speech is judged here.
    assert(apply({'expressiveEmotions', false}).ok)
    -- On with a local voice: nothing else changes and nothing is announced.
    local result = apply({'naturalSpeech', true})
    assert(result.ok and manager.naturalSpeech() and saved.naturalSpeech == true and saved.voiceProvider == 'pocket')
    assert(result.schemaChanged == false and manager.takeNaturalSpeechNotice() == nil)
    -- Choosing the cloud voice while it is on keeps the voice, turns Natural speech off, and says so once.
    result = apply({'voiceProvider', CLOUD})
    assert(result.ok and saved.voiceProvider == 'convai' and saved.naturalSpeech == false and not manager.naturalSpeech())
    assert(manager.snapshot(player).settings.voiceProvider == 'convai' and manager.snapshot(player).settings.naturalSpeech == false)
    assert(result.schemaChanged == true, 'the page reloads so the toggle shows off')
    assert(manager.snapshot(player).feedback == OFF, manager.snapshot(player).feedback)
    mcm.update(player, true)
    assert(#sent == 0, 'the popup is Developer-only: the Settings status line already says it')
    mcm.update(player, true); assert(#sent == 0)
    -- Turning it on while the cloud voice is saved is the player asking for the tags: the voice moves to Pocket, with a notice.
    -- Developer mode shows it once, in gameplay.
    convaiNotices.configure(function() return true end)
    result = apply({'naturalSpeech', true})
    assert(result.ok and saved.voiceProvider == 'pocket' and saved.naturalSpeech == true and result.schemaChanged == true)
    mcm.update(player, true)
    assert(#sent == 1 and sent[1] == NOTICE, 'the notice reaches a developer in gameplay: ' .. tostring(sent[1]))
    mcm.update(player, true); assert(#sent == 1, 'announced once')
    convaiNotices.configure(function() return false end)
    -- Natural speech off: the cloud voice is chosen with nothing to turn off, so there is no notice.
    assert(apply({'naturalSpeech', false}).ok and not manager.naturalSpeech())
    assert(apply({'voiceProvider', CLOUD}).ok and saved.voiceProvider == 'convai' and manager.takeNaturalSpeechNotice() == nil)
    -- Turning it on while the cloud voice is saved switches the voice in the same Apply.
    result = apply({'naturalSpeech', true})
    assert(result.ok and saved.naturalSpeech == true and saved.voiceProvider == 'pocket' and result.schemaChanged == true)
    assert(manager.takeNaturalSpeechNotice() == NOTICE and manager.takeNaturalSpeechNotice() == nil)
    -- Both staged together while the cloud voice is already saved: the voice is not being changed, so the setting wins.
    assert(apply({'naturalSpeech', false}).ok)
    assert(apply({'voiceProvider', CLOUD}).ok and saved.voiceProvider == 'convai')
    result = apply({'voiceProvider', CLOUD}, {'naturalSpeech', true})
    assert(result.ok and saved.voiceProvider == 'pocket' and saved.naturalSpeech == true)
    assert(manager.takeNaturalSpeechNotice() == NOTICE)
    -- Both staged together while the voice changes to the cloud voice: the voice choice wins and Natural speech is turned off.
    assert(apply({'naturalSpeech', false}).ok and saved.voiceProvider == 'pocket')
    result = apply({'voiceProvider', CLOUD}, {'naturalSpeech', true})
    assert(result.ok and saved.voiceProvider == 'convai' and saved.naturalSpeech == false and result.schemaChanged == true)
    assert(manager.takeNaturalSpeechNotice() == OFF and manager.takeNaturalSpeechNotice() == nil)
    -- Both staged together, but the voice moves to an OmniVoice choice instead: it is kept.
    result = apply({'voiceProvider', OMNI}, {'naturalSpeech', true})
    assert(result.ok and saved.voiceProvider == 'omni' and saved.naturalSpeech == true)
    assert(manager.takeNaturalSpeechNotice() == nil and result.schemaChanged == false)
    -- A failed save changes nothing and sends no notice, in either direction.
    assert(apply({'naturalSpeech', false}).ok and apply({'voiceProvider', CLOUD}).ok)
    failSave = true
    result = apply({'voiceProvider', CLOUD}, {'naturalSpeech', true})
    assert(result.ok == false and saved.voiceProvider == 'convai' and not manager.naturalSpeech())
    assert(manager.takeNaturalSpeechNotice() == nil)
    failSave = false
    assert(apply({'voiceProvider', POCKET}, {'naturalSpeech', true}).ok and saved.voiceProvider == 'pocket' and saved.naturalSpeech)
    failSave = true
    result = apply({'voiceProvider', CLOUD})
    assert(result.ok == false and saved.voiceProvider == 'pocket' and manager.naturalSpeech())
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
    assert(row('naturalSpeech').description:find('Pocket', 1, true) and row('naturalSpeech').description:find('Convai’s cloud voice', 1, true))
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

test('Expressive emotions is on by default (2026-10-11), a saved choice is kept, and a saved pairing with the Convai cloud voice keeps the voice and turns it off', () => {
  run(`${managerFixture}
    -- A new install (no settings file): Pocket, Expressive emotions, Follow-up questions and Body gestures on, no voice switch,
    -- no notice and no feedback on the first load.
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved.expressiveEmotions == true and manager.expressiveEmotions() == true)
    assert(manager.snapshot(player).settings.expressiveEmotions == true)
    assert(saved.voiceProvider == 'pocket' and saved.followUpInterest == true and saved.bodyGestures == true)
    assert(saved.naturalSpeech == false and saved.multilingualConversations == false)
    assert(manager.takeNaturalSpeechNotice() == nil and (manager.snapshot(player).feedback or '') == '', 'no voice switch notice on first load')
    -- A missing key is the default (on) except beside a saved cloud voice, which can never use it; a non-boolean is a missing
    -- key; a saved true with the cloud voice (an older save) keeps the cloud voice and turns the setting off. The voice never moves.
    for _, case in ipairs({{'missing', 'convai'}, {'missing', 'pocket'}, {'missing', 'omni'}, {true, 'convai'}, {true, 'pocket'},
        {true, 'omni'}, {false, 'convai'}, {false, 'pocket'}, {'yes', 'convai'}, {'yes', 'pocket'}}) do
      seed = {version = 2, voiceProvider = case[2], enabledByKey = {}, future = {keep = 'unchanged'}}
      if case[1] ~= 'missing' then seed.expressiveEmotions = case[1] end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      local on
      if case[1] == true or case[1] == false then on = case[1] else on = true end
      if case[2] == 'convai' then on = false end
      local label = tostring(case[1]) .. ' / ' .. case[2]
      assert(manager.expressiveEmotions() == on and saved.expressiveEmotions == on, label)
      assert(saved.voiceProvider == case[2] and manager.snapshot(player).settings.voiceProvider == case[2], label)
      assert(manager.takeNaturalSpeechNotice() == nil and (manager.snapshot(player).feedback or '') == '', 'a load is silent: ' .. label)
      assert(saved.future.keep == 'unchanged')
    end
    -- Multilingual conversations on: the existing rule still drops the tag settings with the cloud voice (a Pocket voice moves to
    -- the cloud voice first), and an OmniVoice choice keeps Expressive emotions on.
    for _, case in ipairs({{'pocket', 'convai', false}, {'convai', 'convai', false}, {'omni', 'omni', true}}) do
      seed = {version = 2, voiceProvider = case[1], multilingualConversations = true, enabledByKey = {}}
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      assert(saved.voiceProvider == case[2] and saved.expressiveEmotions == case[3] and manager.expressiveEmotions() == case[3], case[1])
    end
  `);
});

test('Expressive emotions and the cloud voice: choosing the cloud voice keeps it and turns the setting off (silently if only the default was on); turning it on beside the saved cloud voice moves the voice to Pocket TTS', () => {
  run(`${mcmFixture}
    local clock = 5000
    os.clock = function() return clock end
    local sent = {}
    function player:ConvaiPhoneFeedback(text) sent[#sent + 1] = text end
    convaiNotices.configure(function() return true end) -- this popup is Developer-only (docs/NOTIFICATIONS.md)
    assert(invoke('tab:settings').ok)
    local entry = row('expressiveEmotions')
    assert(entry and entry.type == 'bool' and entry.value == true and entry.defaultValue == true, 'on by default')
    local owner
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings) do if item.id == 'expressiveEmotions' then owner = category end end
    end
    assert(owner and owner.id == 'voices' and entry.label == 'Expressive emotions')
    assert(entry.description:find('Convai’s cloud voice', 1, true) and not entry.description:find('Inworld', 1, true), 'Inworld is not mentioned without Developer mode')
    assert(manager.applySettings(player, {developerMode = true}))
    loaded = registered.loadMod('manager')
    assert(row('expressiveEmotions').description:find('Inworld always speaks with emotion', 1, true), 'Developer mode adds the Inworld paragraph')
    assert(manager.applySettings(player, {developerMode = false}))
    loaded = registered.loadMod('manager')
    local EMOTIONS = 'Expressive emotions need a local voice, so Companion voices was switched to ' .. manager.voiceLabel('pocket') .. '.'
    local SPEECH = 'Natural speech needs a local voice, so Companion voices was switched to ' .. manager.voiceLabel('pocket') .. '.'
    local OFF = 'The Convai cloud voice cannot use Natural speech or Expressive emotions, so they were turned off.'
    local CLOUD, OMNI, POCKET
    for index, choice in ipairs(dofile('voice-preview.lua').CHOICES) do
      if choice.provider == 'convai' then CLOUD = index end
      if choice.provider == 'pocket' then POCKET = index end
      if choice.provider == 'omni' and not OMNI then OMNI = index end
    end
    local function apply(...)
      clock = clock + 2
      local changes = {}
      for _, change in ipairs({...}) do changes[#changes + 1] = {id = change[1], value = change[2]} end
      return registered.applyBatch('manager', changes)
    end
    -- Only the default is on (the player never set it): choosing the cloud voice keeps the voice and turns the setting off
    -- without a notice. The open page still reloads, so the toggle shows off.
    assert(manager.expressiveEmotions() and saved.voiceProvider == 'pocket' and saved.expressiveEmotions == true)
    local result = apply({'voiceProvider', CLOUD})
    assert(result.ok and saved.voiceProvider == 'convai' and saved.expressiveEmotions == false and not manager.expressiveEmotions())
    assert(result.schemaChanged == true and manager.takeNaturalSpeechNotice() == nil)
    assert(manager.snapshot(player).settings.voiceProvider == 'convai' and manager.snapshot(player).settings.expressiveEmotions == false)
    mcm.update(player, true)
    assert(#sent == 0, 'the default being switched off is silent')
    -- Turning it on beside the saved cloud voice is the player asking for it: the voice moves to Pocket TTS, with a notice.
    result = apply({'expressiveEmotions', true})
    assert(result.ok and saved.voiceProvider == 'pocket' and saved.expressiveEmotions == true and result.schemaChanged == true)
    assert(manager.snapshot(player).feedback == EMOTIONS, manager.snapshot(player).feedback)
    mcm.update(player, true)
    assert(#sent == 1 and sent[1] == EMOTIONS and not manager.takeNaturalSpeechNotice(), tostring(sent[1]))
    -- With a local voice, switching it off and on again changes nothing else and announces nothing.
    assert(apply({'expressiveEmotions', false}).ok and not manager.expressiveEmotions())
    result = apply({'expressiveEmotions', true})
    assert(result.ok and manager.expressiveEmotions() and saved.expressiveEmotions == true and saved.voiceProvider == 'pocket')
    assert(result.schemaChanged == false and manager.takeNaturalSpeechNotice() == nil and not manager.naturalSpeech())
    -- The player set it, so choosing the cloud voice now says it was turned off, once.
    result = apply({'voiceProvider', CLOUD})
    assert(result.ok and saved.voiceProvider == 'convai' and saved.expressiveEmotions == false and result.schemaChanged == true)
    assert(manager.snapshot(player).feedback == OFF, manager.snapshot(player).feedback)
    mcm.update(player, true)
    assert(#sent == 2 and sent[2] == OFF and not manager.takeNaturalSpeechNotice(), tostring(sent[2]))
    -- Off: nothing to turn off when the cloud voice is chosen, so no notice.
    assert(apply({'voiceProvider', POCKET}).ok and saved.voiceProvider == 'pocket')
    assert(apply({'expressiveEmotions', false}).ok)
    assert(apply({'voiceProvider', CLOUD}).ok and saved.voiceProvider == 'convai' and manager.takeNaturalSpeechNotice() == nil)
    -- Both staged together while the voice changes to the cloud voice: the voice choice wins, the setting is turned off.
    assert(apply({'voiceProvider', POCKET}).ok)
    result = apply({'voiceProvider', CLOUD}, {'expressiveEmotions', true})
    assert(result.ok and saved.voiceProvider == 'convai' and saved.expressiveEmotions == false and result.schemaChanged == true)
    assert(manager.takeNaturalSpeechNotice() == OFF)
    -- Both staged together while the cloud voice is already saved: the voice is not changing, so the setting wins.
    result = apply({'voiceProvider', CLOUD}, {'expressiveEmotions', true})
    assert(result.ok and saved.voiceProvider == 'pocket' and saved.expressiveEmotions == true)
    assert(manager.takeNaturalSpeechNotice() == EMOTIONS)
    -- Both settings turned on together beside the saved cloud voice stay together; the voice moves once, and the notice names Natural speech.
    assert(apply({'expressiveEmotions', false}).ok and apply({'voiceProvider', CLOUD}).ok and saved.voiceProvider == 'convai')
    result = apply({'expressiveEmotions', true}, {'naturalSpeech', true})
    assert(result.ok and saved.voiceProvider == 'pocket' and saved.expressiveEmotions == true and saved.naturalSpeech == true)
    assert(manager.takeNaturalSpeechNotice() == SPEECH and manager.takeNaturalSpeechNotice() == nil)
    -- Choosing the cloud voice with both on turns both off, with one notice.
    result = apply({'voiceProvider', CLOUD})
    assert(result.ok and saved.voiceProvider == 'convai' and saved.expressiveEmotions == false and saved.naturalSpeech == false)
    assert(manager.takeNaturalSpeechNotice() == OFF and manager.takeNaturalSpeechNotice() == nil)
    -- With only Natural speech on (always set by the player), the choice still says so.
    assert(apply({'voiceProvider', POCKET}, {'expressiveEmotions', false}, {'naturalSpeech', true}).ok and saved.voiceProvider == 'pocket')
    result = apply({'voiceProvider', CLOUD})
    assert(result.ok and saved.voiceProvider == 'convai' and saved.naturalSpeech == false)
    assert(manager.takeNaturalSpeechNotice() == OFF)
    -- OmniVoice is a local voice: it is kept with both on.
    result = apply({'voiceProvider', OMNI}, {'expressiveEmotions', true}, {'naturalSpeech', true})
    assert(result.ok and saved.voiceProvider == 'omni' and saved.expressiveEmotions == true and saved.naturalSpeech == true)
    assert(manager.takeNaturalSpeechNotice() == nil and result.schemaChanged == false)
    -- A failed save changes nothing and sends no notice; a non-boolean is refused.
    assert(apply({'expressiveEmotions', false}).ok and apply({'naturalSpeech', false}).ok and apply({'voiceProvider', CLOUD}).ok)
    failSave = true
    result = apply({'voiceProvider', CLOUD}, {'expressiveEmotions', true})
    assert(result.ok == false and saved.voiceProvider == 'convai' and not manager.expressiveEmotions())
    assert(manager.takeNaturalSpeechNotice() == nil)
    failSave = false
    assert(apply({'voiceProvider', POCKET}, {'expressiveEmotions', true}).ok and saved.voiceProvider == 'pocket')
    failSave = true
    result = apply({'voiceProvider', CLOUD})
    assert(result.ok == false and saved.voiceProvider == 'pocket' and manager.expressiveEmotions())
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
    local refused = registered.applyBatch('manager', {{id = 'expressiveEmotions', value = false}})
    assert(refused.ok == false and refused.error:find('Change pending', 1, true))
    assert(manager.expressiveEmotions() and saved.expressiveEmotions == true)
    clock = clock + 2
    assert(registered.applyBatch('manager', {{id = 'expressiveEmotions', value = false}}).ok and not manager.expressiveEmotions())
  `);
});

test('Follow-up questions is on by default (2026-10-11), a saved choice is kept, it works with any voice and is independent of the retired followUpQuestions key', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved.followUpInterest == true and manager.followUpInterest() == true)
    assert(manager.snapshot(player).settings.followUpInterest == true)
    assert(manager.followUpQuestions == nil, 'the retired setting has no accessor')
    for _, case in ipairs({{'missing', 'convai'}, {true, 'convai'}, {true, 'pocket'}, {true, 'omni'}, {false, 'convai'}, {'yes', 'pocket'}}) do
      seed = {version = 2, voiceProvider = case[2], enabledByKey = {}, future = {keep = 'unchanged'}}
      if case[1] ~= 'missing' then seed.followUpInterest = case[1] end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      local on = case[1] ~= false -- a missing or non-boolean value is the default, on
      assert(manager.followUpInterest() == on and saved.followUpInterest == on, tostring(case[1]))
      -- Unlike Natural speech it needs no local voice: the saved voice is never moved because of it.
      assert(saved.voiceProvider == case[2] and manager.snapshot(player).settings.voiceProvider == case[2])
      assert(saved.future.keep == 'unchanged')
    end
    -- A saved value of the retired setting neither turns the new one off nor survives: the new one gets its default (on).
    for _, retired in ipairs({true, false}) do
      seed = {version = 2, voiceProvider = 'pocket', followUpQuestions = retired, enabledByKey = {}}
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      assert(manager.followUpInterest() == true and saved.followUpQuestions == nil and saved.followUpInterest == true)
    end
    -- Apply keeps the choice, rejects anything but a boolean, and leaves the voice alone.
    assert(manager.applySettings(player, {followUpInterest = false}) and not manager.followUpInterest() and saved.followUpInterest == false)
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
    assert(row('followUpInterest').value == true and row('followUpInterest').defaultValue == true)
    assert(row('followUpInterest').description:find('never on every reply', 1, true) and not row('followUpInterest').description:find('Off by default', 1, true)
        and row('followUpInterest').description:find('Now and then', 1, true))
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
    local refused = registered.applyBatch('manager', {{id = 'followUpInterest', value = false}})
    assert(refused.ok == false and refused.error:find('Change pending', 1, true))
    assert(manager.followUpInterest() and saved.followUpInterest == true)
    clock = clock + 2
    local voiceBefore = manager.snapshot(player).settings.voiceProvider
    assert(registered.applyBatch('manager', {{id = 'followUpInterest', value = false}}).ok and not manager.followUpInterest())
    assert(manager.snapshot(player).settings.voiceProvider == voiceBefore, 'no voice switch, no notice')
    assert(manager.takeNaturalSpeechNotice() == nil)
  `);
});

test('V’s voice for typed lines is on by default and a saved choice is kept; whatever voice the companions use, the setting stays active', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved.vVoice == true and manager.vVoice() == true)
    assert(manager.snapshot(player).settings.vVoice == true)
    -- V has an engine of its own, so nothing the companions use (not even the Convai cloud voice) makes the setting inactive.
    assert(manager.vVoiceActive() == true)
    -- A case is {saved vVoice, saved voice, expected vVoice, developer mode (default off), the voice it loads as (default: as saved)}.
    for _, case in ipairs({{'missing', 'pocket', true}, {true, 'pocket', true}, {true, 'omni', true}, {true, 'voxtral', true}, {true, 'inworld', true, true},
        -- The Inworld voice is a developer-mode voice: without developer mode a saved one loads as Pocket TTS.
        {true, 'inworld', true, false, 'pocket'}, {false, 'inworld', false, false, 'pocket', true},
        -- Only an explicit false stays off; a value that is not a boolean is the default (on).
        {false, 'pocket', false, false, nil, true}, {false, 'convai', false, false, nil, true}, {false, 'pocket', true}, {false, 'omni', true}, {false, 'convai', true},
        {'yes', 'pocket', true}, {1, 'pocket', true},
        {true, 'convai', true}, {'missing', 'convai', true}}) do
      seed = {version = 2, voiceProvider = case[2], developerMode = case[4] == true, enabledByKey = {}, future = {keep = 'unchanged'}}
      if case[1] ~= 'missing' then seed.vVoice = case[1] end
      if case[6] then seed.vVoiceChosen = true end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      local loadedVoice = case[5] or case[2]
      assert(manager.vVoice() == case[3] and saved.vVoice == case[3], tostring(case[1]) .. ' ' .. case[2])
      assert(manager.snapshot(player).settings.vVoice == case[3])
      assert(manager.snapshot(player).settings.voiceProvider == loadedVoice, 'voice moved ' .. tostring(case[1]) .. ' ' .. case[2] .. ' -> ' .. tostring(manager.snapshot(player).settings.voiceProvider))
      assert(manager.vVoiceActive() == case[3], tostring(case[1]) .. ' ' .. case[2])
      assert(manager.takeNaturalSpeechNotice() == nil, 'no notice at load')
      assert(saved.future.keep == 'unchanged')
    end
    seed = {version = 2, voiceProvider = 'pocket', enabledByKey = {}}
    files['runtime/settings.json'], saved = 'seed', nil
    manager.configure(api, profiles); manager.prepare(player)
    assert(manager.vVoice() and manager.vVoiceActive())
    -- Choosing the Convai cloud voice keeps V's voice on and active (V's own engine speaks), with no notice.
    local ok, err, notice = manager.applySettings(player, {voiceProvider = 'convai'})
    assert(ok and not err and notice == nil and manager.vVoice() and saved.vVoice == true and saved.voiceProvider == 'convai', tostring(err))
    assert(manager.vVoiceActive() and manager.takeNaturalSpeechNotice() == nil)
    assert(manager.applySettings(player, {vVoice = false}) and not manager.vVoice() and not manager.vVoiceActive() and saved.vVoice == false and saved.vVoiceChosen == true and saved.voiceProvider == 'convai')
    assert(manager.applySettings(player, {vVoice = true}) and manager.vVoice() and manager.vVoiceActive() and saved.voiceProvider == 'convai')
    assert(manager.takeNaturalSpeechNotice() == nil)
    assert(manager.applySettings(player, {voiceProvider = 'pocket'}) and manager.vVoice() and manager.vVoiceActive())
    assert(manager.applySettings(player, {vVoice = 'yes'}) == false and manager.vVoice())
    assert(manager.applySettings(player, {voiceProvider = 'pocket', followUpInterest = false}) and manager.vVoice())
    -- Explicitly turned off stays off through a voice change.
    assert(manager.applySettings(player, {vVoice = false}) and manager.applySettings(player, {voiceProvider = 'convai'}) and manager.applySettings(player, {voiceProvider = 'pocket'}) and not manager.vVoice())
  `);
});

test('V’s voice engine is Pocket by default, only Pocket and Voxtral are kept, and Mature content keeps it off the cloud', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved.vVoiceEngine == 'pocket' and manager.vVoiceEngine() == 'pocket' and manager.snapshot(player).settings.vVoiceEngine == 'pocket')
    -- A case is {saved engine, saved Mature content, expected engine}. Mature content needs Local AI, so the seed carries it.
    for _, case in ipairs({{'missing', false, 'pocket'}, {'pocket', false, 'pocket'}, {'voxtral', false, 'voxtral'},
        {'omni', false, 'pocket'}, {'inworld', false, 'pocket'}, {'convai', false, 'pocket'}, {7, false, 'pocket'}, {true, false, 'pocket'},
        {'voxtral', true, 'pocket'}, {'pocket', true, 'pocket'}}) do
      seed = {version = 2, voiceProvider = 'pocket', matureContent = case[2], conversationProvider = case[2] and 'local' or 'convai', enabledByKey = {}, future = {keep = 'unchanged'}}
      if case[1] ~= 'missing' then seed.vVoiceEngine = case[1] end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      assert(manager.vVoiceEngine() == case[3] and saved.vVoiceEngine == case[3], tostring(case[1]) .. ' ' .. tostring(case[2]))
      assert(manager.snapshot(player).settings.vVoiceEngine == case[3])
      assert(saved.future.keep == 'unchanged')
    end
  `);
});

test('V’s voice engine: Voxtral needs the Mistral key, applies on its own beside any companion voice, is refused with Mature content on, and Mature content turning on moves V to Pocket', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    local function key(tag, value)
      jsonFixtures['mistral-' .. tag] = value
      files['runtime/mistral-state.json'] = 'mistral-' .. tag
      clock = clock + 2
    end
    assert(invoke('tab:settings').ok)
    loaded = registered.loadMod('manager')
    -- The row sits right after the V's voice switch, in the Voices category, and says what Voxtral needs while there is no key.
    local order, at = {}, {}
    for _, category in ipairs(loaded.categories) do
      if category.id == 'voices' then for _, item in ipairs(category.settings) do order[#order + 1] = item.id end end
    end
    for index, id in ipairs(order) do at[id] = index end
    assert(at.vVoiceEngine == at.vVoice + 1, 'the engine row follows the switch')
    local engine = row('vVoiceEngine')
    assert(engine.label == 'V’s voice engine' and engine.type == 'select' and engine.value == 1 and engine.defaultValue == 1)
    assert(#engine.elements == 2 and engine.elements[1] == 'Pocket · On your PC' and engine.elements[2] == 'Voxtral · needs Mistral key', engine.elements[2])
    for _, banned in ipairs({'recommended', 'inworld', 'antivirus', 'embedded', 'paid'}) do
      assert(not tostring(engine.description):lower():find(banned, 1, true), banned)
      for _, element in ipairs(engine.elements) do assert(not element:lower():find(banned, 1, true), banned) end
    end
    assert(not row('vVoice').description:lower():find('inworld', 1, true))
    assert(engine.description:find('Pocket', 1, true) and engine.description:find('Voxtral', 1, true) and engine.description:find('Mistral key', 1, true))
    -- No key: refused with the one short reason, nothing changes.
    local result = registered.applyBatch('manager', {{id = 'vVoiceEngine', value = 2}})
    assert(result.ok == false and result.error == 'Requires a Mistral key (add it in Settings > Conversation provider)', result.error)
    assert(saved.vVoiceEngine == 'pocket')
    assert(not manager.applySettings(player, {vVoiceEngine = 'voxtral'}) and manager.vVoiceEngine() == 'pocket')
    assert(registered.applyBatch('manager', {{id = 'vVoiceEngine', value = 3}}).ok == false)
    assert(not manager.applySettings(player, {vVoiceEngine = 'omni'}) and not manager.applySettings(player, {vVoiceEngine = 'inworld'}))
    -- A key is saved: the entry is a plain label and applies, whatever the companions use (here Pocket, then the Convai cloud voice).
    key('a', {provider = 'convai', effective = 'convai', saved = true})
    loaded = registered.loadMod('manager')
    assert(row('vVoiceEngine').elements[2] == 'Voxtral · Mistral cloud', row('vVoiceEngine').elements[2])
    assert(registered.applyBatch('manager', {{id = 'vVoiceEngine', value = 2}}).ok)
    assert(saved.vVoiceEngine == 'voxtral' and manager.vVoiceEngine() == 'voxtral' and manager.snapshot(player).settings.vVoiceEngine == 'voxtral')
    assert(saved.voiceProvider == 'pocket' and saved.vVoice == true, 'the companions\\' voice and the switch are untouched')
    loaded = registered.loadMod('manager')
    assert(row('vVoiceEngine').value == 2)
    assert(manager.applySettings(player, {voiceProvider = 'convai'}) and manager.vVoiceEngine() == 'voxtral' and manager.vVoiceActive(), 'beside the Convai voice V still has its own engine')
    assert(manager.applySettings(player, {voiceProvider = 'pocket'}) and manager.vVoiceEngine() == 'voxtral')
    -- Back to Pocket, always allowed.
    assert(registered.applyBatch('manager', {{id = 'vVoiceEngine', value = 1}}).ok and saved.vVoiceEngine == 'pocket')
    -- Mature content keeps the player's words off the cloud: Voxtral is refused while it is on, and turning it on moves V to Pocket.
    assert(manager.applySettings(player, {vVoiceEngine = 'voxtral'}) and saved.vVoiceEngine == 'voxtral')
    local ok, err, notice, reload = manager.applySettings(player, {conversationProvider = 'local', matureContent = true})
    assert(ok and saved.matureContent == true and saved.vVoiceEngine == 'pocket' and reload == true, tostring(err))
    local refused, why = manager.applySettings(player, {vVoiceEngine = 'voxtral'})
    assert(refused == false and why == 'Voxtral sends your line to Mistral. Turn off Mature content to choose it.', tostring(why))
    assert(saved.vVoiceEngine == 'pocket')
    assert(manager.applySettings(player, {matureContent = false}) and manager.applySettings(player, {vVoiceEngine = 'voxtral'}) and saved.vVoiceEngine == 'voxtral')
    -- Both in one Apply while Mature content is on or turns on: Mature content wins and V is Pocket.
    assert(manager.applySettings(player, {matureContent = true, vVoiceEngine = 'voxtral'}) and saved.vVoiceEngine == 'pocket')
  `);
});

test('V’s voice sits in the Voices category after Follow-up questions, is on by default, and applies on its own; the old Convai-voice note is gone', () => {
  run(`${mcmFixture}
    assert(invoke('tab:settings').ok)
    local owner, order = nil, {}
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings) do
        if category.id == 'voices' then order[#order + 1] = item.id end
        if item.id == 'vVoice' then owner = category end
      end
    end
    assert(owner and owner.id == 'voices' and row('vVoice').label == 'V’s voice for typed lines')
    assert(row('vVoice').value == true and row('vVoice').defaultValue == true)
    assert(row('vVoice').description:find('type a line', 1, true)
        and row('vVoice').description:find('Push-to-talk', 1, true))
    assert(not row('vVoice').description:find('Off by default', 1, true) and not row('vVoice').description:find('cannot clone', 1, true))
    for _, banned in ipairs({'recommended', 'antivirus', 'embedded', 'paid', 'inworld'}) do
      assert(not row('vVoice').description:lower():find(banned, 1, true), banned)
    end
    local at = {}
    for index, id in ipairs(order) do at[id] = index end
    assert(at.followUpInterest < at.vVoice, 'with the other speech settings')
    -- No voice makes the row differ: V's engine is its own row now.
    local plain = row('vVoice').description
    assert(manager.applySettings(player, {voiceProvider = 'convai'}))
    loaded = registered.loadMod('manager')
    assert(row('vVoice').description == plain and not row('vVoice').description:find('Works with', 1, true))
    assert(manager.applySettings(player, {developerMode = true}))
    loaded = registered.loadMod('manager')
    assert(row('vVoice').description == plain and not row('vVoiceEngine').description:lower():find('inworld', 1, true), 'Developer mode adds no Inworld text here')
    assert(manager.applySettings(player, {voiceProvider = 'pocket', developerMode = false}))
    loaded = registered.loadMod('manager')
    local clock = 5000
    os.clock = function() return clock end
    local listeners = {}
    nativeApi.subscribe = function(name, callback) listeners[#listeners + 1] = callback; return #listeners end
    nativeApi.unsubscribe = function() return true end
    mcm.shutdown(); mcm.install()
    for _, callback in ipairs(listeners) do callback({modKey = 'cyberpunk-convai:manager', count = 1}) end
    local refused = registered.applyBatch('manager', {{id = 'vVoice', value = false}})
    assert(refused.ok == false and refused.error:find('Change pending', 1, true))
    assert(manager.vVoice() and saved.vVoice == true)
    clock = clock + 2
    local voiceBefore = manager.snapshot(player).settings.voiceProvider
    assert(registered.applyBatch('manager', {{id = 'vVoice', value = false}}).ok and not manager.vVoice())
    assert(manager.snapshot(player).settings.voiceProvider == voiceBefore, 'no voice switch')
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
    local CLOUD_OFF = 'The Convai cloud voice cannot use Natural speech or Expressive emotions, so they were turned off.'
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
    assert(entry.description:find('OmniVoice · Balanced', 1, true) and entry.description:find('English only', 1, true))
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
    -- The cloud voice chosen while a tag setting is on is kept (2026-10-11): both tag settings are turned off, with one notice.
    result = apply({'voiceProvider', CLOUD})
    assert(result.ok and saved.voiceProvider == 'convai' and not saved.naturalSpeech and not saved.expressiveEmotions)
    assert(result.schemaChanged == true and manager.takeNaturalSpeechNotice() == CLOUD_OFF)
    -- A tag setting turned on beside the saved cloud voice moves the voice to OmniVoice · Balanced, never to Pocket.
    result = apply({'naturalSpeech', true})
    assert(result.ok and saved.voiceProvider == 'omni' and saved.omniSteps == 16 and saved.omniReference == 'short' and saved.naturalSpeech)
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
    -- With Natural speech on, a cloud voice chosen in the same Apply is kept and Natural speech is turned off.
    assert(apply({'multilingualConversations', false}, {'voiceProvider', POCKET}).ok and apply({'naturalSpeech', true}).ok)
    result = apply({'multilingualConversations', true}, {'voiceProvider', CLOUD})
    assert(result.ok and saved.voiceProvider == 'convai' and saved.naturalSpeech == false)
    assert(manager.takeNaturalSpeechNotice() == CLOUD_OFF)
    -- Without choosing the cloud voice, turning Multilingual on beside a saved local voice with the tags on keeps them (Omni).
    assert(apply({'multilingualConversations', false}, {'voiceProvider', ULTRA}).ok and apply({'naturalSpeech', true}).ok)
    result = apply({'multilingualConversations', true})
    assert(result.ok and saved.voiceProvider == 'omni' and saved.naturalSpeech == true and manager.takeNaturalSpeechNotice() == nil)
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
    -- Multilingual off, Pocket, then the cloud voice chosen with Natural speech turned on in the same Apply, Multilingual on:
    -- the voice choice wins and the tag is dropped with the cloud-voice notice (not the OmniVoice-pack refusal).
    assert(apply({'multilingualConversations', false}, {'voiceProvider', POCKET}).ok)
    result = apply({'multilingualConversations', true}, {'voiceProvider', CLOUD}, {'naturalSpeech', true})
    assert(result.ok and saved.voiceProvider == 'convai' and saved.naturalSpeech == false, tostring(result.error))
    assert(manager.takeNaturalSpeechNotice() == CLOUD_OFF)
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

test('the Convai and Mistral key rows are always listed, whichever provider is chosen, with or without Developer mode, and the old switch is gone', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    assert(invoke('tab:settings').ok)
    local ids = {'own-key', 'mistral-key'}
    for _, id in ipairs(ids) do assert(row(id) and row(id).type == 'action', id .. ' is listed without Developer mode') end
    assert(row('conversationProvider'))
    assert(row('useOwnConvaiKey') == nil, 'the separate switch is gone')
    for _, id in ipairs({'own-key-status', 'own-key:paste', 'own-key:remove', 'own-key-using', 'mistral-key-status', 'mistral-key:paste', 'mistral-key:remove', 'local-ai-status'}) do
      assert(row(id) == nil, id .. ' is still offered')
    end
    assert(registered.applyBatch('manager', {{id = 'developerMode', value = true}}).ok); loaded = registered.loadMod('manager')
    for _, id in ipairs(ids) do assert(row(id), id .. ' is still listed in Developer mode') end
    assert(registered.applyBatch('manager', {{id = 'developerMode', value = false}}).ok); loaded = registered.loadMod('manager')
    for _, id in ipairs(ids) do assert(row(id), id .. ' is listed with Developer mode off') end
    -- Every provider entry (free tier, Convai API key, Mistral, Local) keeps both key rows.
    for index = 1, 4 do
      clock = clock + 2
      assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = index}}).ok); loaded = registered.loadMod('manager')
      assert(row('conversationProvider').value == index)
      for _, id in ipairs(ids) do assert(row(id), id .. ' is missing with provider ' .. index) end
    end
    -- The switch is not a setting any more: the selector entry sets it (see the provider setting test).
    clock = clock + 2
    assert(registered.applyBatch('manager', {{id = 'useOwnConvaiKey', value = true}}).ok == false, 'useOwnConvaiKey is not an accepted setting id')
    -- The player-facing text never names the embedded key or a paid plan.
    for _, id in ipairs({'own-key', 'mistral-key', 'conversationProvider'}) do
      local text = (row(id).label or '') .. ' ' .. tostring(row(id).description or '') .. ' ' .. tostring(row(id).value or '')
      for _, word in ipairs({'embedded', 'shipped', 'paid', 'premium', 'subscription'}) do
        assert(not text:lower():find(word, 1, true), id .. ' mentions ' .. word)
      end
    end
  `);
});

test('Settings sections: Conversation provider sits after Conversations and before Voices, Development keeps Developer mode (and the Inworld key with it on), Voice status follows Companion voices', () => {
  run(`${mcmFixture}
    assert(invoke('tab:settings').ok)
    local order = {}
    for _, category in ipairs(loaded.categories) do order[#order + 1] = category.id end
    local joined = table.concat(order, ',')
    assert(joined:find('conversation-controls,conversation-provider,companion-behavior,voices,', 1, true), joined)
    local function idsOf(categoryId)
      for _, category in ipairs(loaded.categories) do
        if category.id == categoryId then
          local ids = {}
          for _, item in ipairs(category.settings) do ids[#ids + 1] = item.id end
          return ids
        end
      end
    end
    assert(table.concat(idsOf('conversation-provider'), ',') == table.concat({'conversationProvider', 'matureContent', 'localModel', 'mistral-key', 'own-key'}, ','),
      table.concat(idsOf('conversation-provider'), ','))
    assert(table.concat(idsOf('development'), ',') == 'developerMode', table.concat(idsOf('development'), ','))
    local voices = idsOf('voices')
    assert(voices[1] == 'voice' and voices[2] == 'voiceProvider' and voices[3] == 'voice-status', table.concat(voices, ','))
    for _, id in ipairs(voices) do assert(not id:find('inworld', 1, true) and id ~= 'voice-pack', id .. ' is in Voices') end
    for _, id in ipairs({'groq-key-status', 'groq-key:paste', 'groq-key:remove', 'permissions', 'enabled:person-1'}) do assert(row(id) == nil, id .. ' is still offered') end
    local elements = row('conversationProvider').elements
    assert(#elements == 5 and elements[1] == 'Convai free tier' and elements[2] == 'Convai API key' and elements[3] == 'Mistral (free plan)' and elements[4] == 'Local AI'
      and elements[5] == 'Custom (OpenAI-compatible)')
    assert(not tostring(row('conversationProvider').description):find('Groq', 1, true))
    -- Developer mode: the Inworld key is the row after Developer mode.
    assert(registered.applyBatch('manager', {{id = 'developerMode', value = true}}).ok); loaded = registered.loadMod('manager')
    assert(table.concat(idsOf('development'), ',') == 'developerMode,inworld-key', table.concat(idsOf('development'), ','))
  `);
});

test('The Convai API key row: Paste or Remove with the state in brackets, the failure first in its help, no free-key promotion, two commands, and a status that never shows the key', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    
    local NL2 = string.char(10, 10)
    local function paragraphs(text)
      local list, from = {}, 1
      while true do
        local at = text:find(NL2, from, true)
        if not at then list[#list + 1] = text:sub(from); return list end
        list[#list + 1] = text:sub(from, at - 1); from = at + 2
      end
    end
    local function firstParagraph(text) return paragraphs(text)[1] end
    local function lastParagraph(text) local list = paragraphs(text); return list[#list] end

    assert(invoke('tab:settings').ok)
    local provider = row('conversationProvider')
    assert(provider.value == 1 and provider.defaultValue == 1 and manager.snapshot(player).settings.useOwnConvaiKey == false, 'Convai free tier by default')
    local item = row('own-key')
    assert(item and item.type == 'action' and item.label == 'Convai API key' and item.value == 'Paste', item.label .. '|' .. tostring(item.value))
    assert(not item.description:find('free', 1, true) and not item.description:find('convai.com', 1, true))
    assert(not item.description:find('embedded', 1, true) and not item.description:find('shipped', 1, true))
    assert(not item.description:find('daily', 1, true) and not item.description:find('recommended', 1, true) and not item.description:find('Mistral', 1, true))
    assert(item.description:find('Copy your key first', 1, true))
    local function refresh() clock = clock + 2; manager.snapshot(player); loaded = registered.loadMod('manager'); return row('own-key') end
    local function answer(tag, state)
      local token = 'own-state-' .. tag
      jsonFixtures[token] = state
      files['runtime/own-key-state.json'] = token
      return refresh()
    end
    -- Paste: one command on the Convai key channel only.
    assert(invoke('own-key').ok)
    local command = jsonFixtures[files['runtime/own-key-command.json']]
    assert(command.version == 1 and command.action == 'paste' and command.id:find(':key:1', 1, true))
    assert(files['runtime/memory-command.json'] == nil and files['runtime/mistral-key-command.json'] == nil, 'a key command must not use another channel')
    local function id(number) return (command.id:gsub(':1$', ':' .. number)) end
    -- Checking, then a refusal: Not added, the message first in the help, Paste still offered.
    item = answer('checking', {saved = false, active = 'shared', result = {id = id(1), state = 'checking'}})
    assert(item.label == 'Convai API key (Checking…)' and item.value == 'Paste', item.label)
    item = answer('invalid', {saved = false, active = 'shared', result = {id = id(1), state = 'invalid'}})
    assert(item.label == 'Convai API key (Not added)' and item.value == 'Paste', item.label)
    assert(firstParagraph(item.description) == 'Convai did not accept that key.', item.description)
    for state, text in pairs({empty = 'The clipboard is empty. Copy your key first.', ['not-a-key'] = 'The clipboard does not hold a Convai API key.',
        clipboard = 'The clipboard could not be read.', failed = 'The key could not be saved.'}) do
      item = answer('fail-' .. state, {saved = false, active = 'shared', result = {id = id(1), state = state}})
      assert(item.label == 'Convai API key (Not added)' and firstParagraph(item.description) == text, state .. ': ' .. item.description)
    end
    -- A second paste works: Added with the last four characters, and the action turns into Remove.
    assert(invoke('own-key').ok)
    item = answer('saved', {saved = true, tail = 'wxyz', active = 'player', result = {id = id(2), state = 'saved'}})
    assert(item.label == 'Convai API key (…wxyz)' and item.value == 'Remove', item.label .. '|' .. tostring(item.value))
    assert(item.description:find('Deletes the saved key', 1, true) and item.description:find('last four characters', 1, true))
    assert(not item.description:find('Convai did not accept', 1, true), 'a saved key shows no failure')
    -- A key saved but without the last four characters (an older bridge) reads Added.
    item = answer('no-tail', {saved = true, active = 'player'})
    assert(item.label == 'Convai API key (Added)' and item.value == 'Remove', item.label)
    -- A refusal beside a saved key (a second paste that failed) still shows the saved key and puts the message first.
    item = answer('saved-invalid', {saved = true, tail = 'wxyz', active = 'player', result = {id = id(2), state = 'invalid'}})
    assert(item.label == 'Convai API key (…wxyz)' and item.value == 'Remove' and firstParagraph(item.description) == 'Convai did not accept that key.', item.description)
    -- Remove is the same row: one clear command.
    assert(invoke('own-key').ok and jsonFixtures[files['runtime/own-key-command.json']].action == 'clear')
    item = answer('cleared', {saved = false, active = 'shared', limit = {state = 'used-up', own = false}, result = {id = id(3), state = 'cleared'}})
    assert(item.label == 'Convai API key' and item.value == 'Paste', item.label)
    -- Who answers is the last paragraph of the provider row's help, never a row of its own.
    assert(lastParagraph(row('conversationProvider').description) == 'Convai free tier: limit used up', lastParagraph(row('conversationProvider').description))
    answer('own-limit', {saved = true, tail = 'wxyz', active = 'player', limit = {state = 'used-up', own = true}})
    assert(lastParagraph(row('conversationProvider').description) == 'Your key: plan limit reached')
    -- A result belonging to an older command is not shown again.
    item = answer('someone-else', {saved = false, active = 'shared', result = {id = 'old:key:9', state = 'invalid'}})
    assert(item.label == 'Convai API key' and not item.description:find('Convai did not accept', 1, true))
    -- The Convai API key entry of the provider selector is what turns the own key on; no key text is ever stored in the settings.
    assert(manager.snapshot(player).settings.useOwnConvaiKey == false)
    clock = clock + 2
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 2}}).ok)
    assert(manager.snapshot(player).settings.useOwnConvaiKey == true and saved.useOwnConvaiKey == true and saved.conversationProvider == 'convai')
    assert(not manager.applySettings(player, {useOwnConvaiKey = 'yes'}))
    for key, value in pairs(saved) do assert(not tostring(value):find('wxyz', 1, true), key .. ' holds key text') end
  `);
});

test('The provider row says when the player key runs without memory or cannot hold the conversations at all', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    
    local NL2 = string.char(10, 10)
    local function paragraphs(text)
      local list, from = {}, 1
      while true do
        local at = text:find(NL2, from, true)
        if not at then list[#list + 1] = text:sub(from); return list end
        list[#list + 1] = text:sub(from, at - 1); from = at + 2
      end
    end
    local function firstParagraph(text) return paragraphs(text)[1] end
    local function lastParagraph(text) local list = paragraphs(text); return list[#list] end

    assert(invoke('tab:settings').ok)
    local base = row('conversationProvider').description
    -- The note is the paragraph added after the provider row's own help (nil when there is none).
    local function note()
      local text = row('conversationProvider').description
      if text == base then return nil end
      assert(text:sub(1, #base + 2) == base .. NL2, 'the note comes after the help')
      return text:sub(#base + 3)
    end
    local function state(value, tag)
      local token = 'own-state-' .. tag
      jsonFixtures[token] = value
      files['runtime/own-key-state.json'] = token
      clock = clock + 2; manager.snapshot(player); loaded = registered.loadMod('manager')
    end
    state({saved = true, tail = 'wxyz', active = 'player', memory = 'on'}, 'on')
    assert(note() == nil, 'an own key that works needs no words')
    state({saved = true, tail = 'wxyz', active = 'player', memory = 'off'}, 'off')
    assert(note() == 'Your own key, without memory')
    assert(manager.ownKey().memoryOff == true)
    state({saved = true, tail = 'wxyz', active = 'player', memory = 'off', limit = {state = 'memory-needed', own = true}}, 'needed')
    assert(note() == 'Your key: no room for memory')
    state({saved = true, tail = 'wxyz', active = 'player', limit = {state = 'rejected', own = true}}, 'rejected')
    assert(note() == 'Your key: not accepted')
    -- A speaker limit is not a used-up plan: only a real usage limit says that.
    state({saved = true, tail = 'wxyz', active = 'player', memory = 'off'}, 'again')
    assert(note() ~= 'Your key: plan limit reached' and note() ~= 'Convai free tier: limit used up')
    state({saved = false, active = 'shared', memory = 'on'}, 'shared')
    assert(note() == nil and manager.ownKey().memoryOff == false)
    -- The shared plan's daily allowance, published by the bridge only while the shared key is in use.
    state({saved = false, active = 'shared', daily = {limit = 100, left = 63, blocked = false}}, 'daily')
    assert(note() == 'Convai free tier: 63 of 100 left today', tostring(note()))
    state({saved = false, active = 'shared', daily = {limit = 100, left = 0, blocked = true}}, 'blocked')
    -- The provider help ends with the status. What to do ends the Mistral key row's help (the provider help has no room for it in
    -- every language): the limit (from the server), the reset, Mistral's rounded estimate, Local AI without a limit.
    assert(note() == 'Convai free tier: daily limit reached', tostring(note()))
    local mistralHelp = row('mistral-key').description
    assert(mistralHelp:find('You have used today’s 100 turns, which come back tomorrow.', 1, true) and mistralHelp:find('Mistral (with your free key, about 5,000 turns a day)', 1, true)
      and mistralHelp:find('Local AI (unlimited), then Apply', 1, true) and mistralHelp:find('It sets its own monthly cap, estimated at about 150,000 turns.', 1, true), mistralHelp)
    assert(lastParagraph(mistralHelp):find('You have used today’s', 1, true) == 1, 'it is the last paragraph of the Mistral key help')
    local limitText = lastParagraph(mistralHelp)
    assert(not limitText:lower():find('recommend', 1, true) and not limitText:lower():find('embedded', 1, true) and not limitText:lower():find('paid', 1, true), limitText)
    state({saved = false, active = 'shared', daily = {limit = 150, left = 0, blocked = true}}, 'blocked150')
    assert(row('mistral-key').description:find('today’s 150 turns', 1, true), 'the number is the one the bridge reports')
    state({saved = false, active = 'shared', daily = {limit = 100, left = 63, blocked = false}}, 'daily-again')
    assert(note() == 'Convai free tier: 63 of 100 left today', 'the extra text appears only while the limit is reached')
    assert(not row('mistral-key').description:find('You have used today’s', 1, true), 'the Mistral key help has it only while the limit is reached')
    state({saved = false, active = 'shared', daily = {limit = 100, left = 0, blocked = true}}, 'blocked-again')
    state({saved = true, tail = 'wxyz', active = 'player', daily = {limit = 100, left = 0, blocked = true}}, 'own')
    assert(note() == nil, 'an own key is never shown as limited')
    state({saved = false, active = 'shared', daily = {limit = 'x', left = -4}}, 'garbled')
    assert(note() == nil and manager.ownKey().daily == nil, 'a damaged status is ignored')
    -- The state is never a row of its own, in Development or anywhere else.
    assert(registered.applyBatch('manager', {{id = 'developerMode', value = true}}).ok); loaded = registered.loadMod('manager')
    assert(row('own-key-using') == nil and row('own-key-status') == nil)
  `);
});

test('the reply notices for the key: a used-up plan, a refused key, memory off or needed, and nothing for an ordinary reply', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  const start = init.indexOf('local function dailyLimitText'), end = init.indexOf('local function reactionCanDeliver');
  assert(start > 0 && end > start, 'the key notice functions moved');
  run(`
    local ui = {t = function(text, args) return (text:gsub('{(%w+)}', function(key) return args and args[key] ~= nil and tostring(args[key]) or '{' .. key .. '}' end)) end}
    local ownKey = {daily = {limit = 100, left = 0, blocked = true}}
    local manager = {ownKey = function() if ownKey == 'error' then error('no state') end return ownKey end}
    ${init.slice(start, end)}
    local function notice(reply) local id, text = keyReplyNotice(reply); return id, text end
    local id, text = notice({errorCode = 'quota-shared'})
    assert(id == 'quota-exhausted' and text:find('Mistral', 1, true) and text:find('Settings > Conversation provider', 1, true), text)
    assert(not text:find('convai.com', 1, true) and not text:find('free API key', 1, true) and not text:find('Convai key', 1, true))
    assert(not text:lower():find('embedded', 1, true) and not text:lower():find('shipped', 1, true))
    id, text = notice({errorCode = 'quota-own'}); assert(id == 'quota-exhausted' and text:find('plan limit', 1, true))
    id, text = notice({errorCode = 'key-rejected'}); assert(id == 'quota-exhausted' and text:find('did not accept', 1, true))
    id, text = notice({errorCode = 'key-memory-needed'}); assert(id == 'quota-exhausted' and text:find('memory', 1, true))
    id, text = notice({errorCode = 'daily-limit', error = 'x'})
    -- The notice names today's turns (the limit the backend set, never a number written in the code) and the two ways on: Mistral with a
    -- free key (about 5,000 a day) and Local AI (unlimited). It is two lines with a forced break in the game's warning frame, the first
    -- sentence on line 1 and the detailed choice starting on a fresh line 2 (the width itself is checked in bridge/daily-notice-fit.test.mjs).
    assert(id == 'daily-limit' and text == 'Today’s 100 Convai turns are used.\\nTry Mistral (free key, ~5,000 a day) or Local AI (unlimited).', text)
    ownKey = {daily = {limit = 150, left = 0, blocked = true}}
    id, text = notice({errorCode = 'daily-limit', error = 'x'}); assert(text:find('Today’s 150 Convai turns', 1, true), 'the limit the status reports: ' .. text)
    ownKey = {}; id, text = notice({errorCode = 'daily-limit', error = 'x'})
    assert(text == 'Today’s Convai turns are used.\\nTry Mistral (free key, ~5,000 a day) or Local AI (unlimited).' and not text:find('{', 1, true), 'no limit known: ' .. text)
    ownKey = 'error'; id, text = notice({errorCode = 'daily-limit', error = 'x'})
    assert(text:find('Today’s Convai turns are used.', 1, true), 'the status could not be read: ' .. text)
    ownKey = {daily = {limit = 100, left = 0, blocked = true}}
    id, text = notice({errorCode = 'daily-limit', error = 'x'})
    assert(not text:lower():find('recommend', 1, true) and utf8.len(text) <= 100 and select(2, text:gsub('\\n', '')) == 1, 'short enough for two lines of the warning frame: ' .. utf8.len(text))
    assert(not text:lower():find('embedded', 1, true) and not text:lower():find('shared', 1, true) and not text:lower():find('project', 1, true))
    -- No own-key offer, no paid tier, no "includes voice", no "text only", no credentials wording.
    assert(not text:find('Convai API key', 1, true) and not text:find('convai.com', 1, true) and not text:find('phone verification', 1, true), text)
    for _, word in ipairs({'paid', 'plan', 'subscription', 'voice', 'text only', 'token', 'secret', 'credential', 'antivirus', 'Defender'}) do
      assert(not text:lower():find(word:lower(), 1, true), word .. ' in: ' .. text)
    end
    id, text = notice({errorCode = 'key-memory', error = 'x'}); assert(id == 'key-memory' and text:find('will not remember', 1, true))
    id, text = notice({keyNotice = 'memory-off', text = 'Hello'}); assert(id == 'key-memory')
    assert(notice({text = 'Hello'}) == nil and notice({error = 'plain failure'}) == nil and notice({keyNotice = 'other'}) == nil)
  `);
});

test('The Conversation provider section offers the provider, Mature content, the Local AI model and one Paste or Remove row for Convai and for Mistral: Convai free tier by default, two commands, a status that never shows the key', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    
    local NL2 = string.char(10, 10)
    local function paragraphs(text)
      local list, from = {}, 1
      while true do
        local at = text:find(NL2, from, true)
        if not at then list[#list + 1] = text:sub(from); return list end
        list[#list + 1] = text:sub(from, at - 1); from = at + 2
      end
    end
    local function firstParagraph(text) return paragraphs(text)[1] end
    local function lastParagraph(text) local list = paragraphs(text); return list[#list] end

    assert(invoke('tab:settings').ok)
    local provider = row('conversationProvider')
    assert(provider and provider.type == 'select' and provider.value == 1 and provider.defaultValue == 1)
    assert(#provider.elements == 5 and provider.elements[1] == 'Convai free tier' and provider.elements[2] == 'Convai API key'
      and provider.elements[3] == 'Mistral (free plan)' and provider.elements[4] == 'Local AI' and provider.elements[5] == 'Custom (OpenAI-compatible)')
    assert(provider.description:find('memory stays on this computer', 1, true) and provider.description:find('Convai API key uses your own key', 1, true))
    assert(not provider.description:lower():find('text only', 1, true), 'Mistral is not described as text only')
    assert(provider.description:find('local voice', 1, true) and provider.description:find('until no conversation is running', 1, true))
    assert(provider.description:find('With Mistral or Local AI, Convai', 1, true), 'the voice paragraph names the option Local AI')
    assert(not provider.description:find('needs Local AI pack', 1, true) and not provider.description:find('Recommended', 1, true) and not provider.description:find('recommended', 1, true))
    assert(provider.description:find('not available yet', 1, true), 'without local speech recognition the help says so')
    local mistral = row('mistral-key')
    assert(mistral and mistral.type == 'action' and mistral.label == 'Mistral free API key' and mistral.value == 'Paste', mistral.label)
    assert(mistral.description:find('phone verification', 1, true) and mistral.description:find('player-mistral-key.txt', 1, true) and mistral.description:find('monthly cap', 1, true) and mistral.description:find('about 5,000 turns a day', 1, true))
    assert(row('local-ai-status') == nil and row('own-key-using') == nil and row('mistral-key-status') == nil, 'the status rows are gone')
    assert(lastParagraph(provider.description) == lastParagraph(row('conversationProvider').description))
    assert(not provider.description:find('Your own key', 1, true) and not provider.description:find('Convai free tier:', 1, true), 'no note while nothing needs one')
    local order = {}
    for _, category in ipairs(loaded.categories) do
      if category.id == 'conversation-provider' then for _, item in ipairs(category.settings) do order[#order + 1] = item.id end end
    end
    assert(table.concat(order, ',') == 'conversationProvider,matureContent,localModel,mistral-key,own-key', table.concat(order, ','))
    local function refresh() clock = clock + 2; manager.snapshot(player); loaded = registered.loadMod('manager') end
    local function answer(tag, state)
      jsonFixtures['or-state-' .. tag] = state
      files['runtime/mistral-state.json'] = 'or-state-' .. tag
      refresh()
    end
    local function note() return lastParagraph(row('conversationProvider').description) end
    local base = provider.description
    -- Paste and Remove are two commands of one row, on their own channel, never the memory or the Convai key channel.
    assert(invoke('mistral-key').ok)
    local command = jsonFixtures[files['runtime/mistral-key-command.json']]
    assert(command.version == 1 and command.action == 'paste' and command.id:find(':mkey:1', 1, true))
    assert(files['runtime/memory-command.json'] == nil and files['runtime/own-key-command.json'] == nil)
    local function id(number) return (command.id:gsub(':1$', ':' .. number)) end
    answer('invalid', {version = 1, provider = 'convai', effective = 'convai', saved = false, result = {id = id(1), state = 'invalid'}})
    mistral = row('mistral-key')
    assert(mistral.label == 'Mistral free API key (Not added)' and mistral.value == 'Paste' and firstParagraph(mistral.description) == 'Mistral did not accept that key.', mistral.label)
    answer('unreadable', {provider = 'convai', effective = 'convai', saved = false, result = {id = id(1), state = 'unreadable'}})
    assert(firstParagraph(row('mistral-key').description) == 'The clipboard could not be read.')
    answer('failed', {provider = 'convai', effective = 'convai', saved = false, result = {id = id(1), state = 'failed'}})
    assert(firstParagraph(row('mistral-key').description) == 'The key could not be saved.')
    assert(invoke('mistral-key').ok)
    answer('saved', {version = 1, provider = 'mistral', effective = 'mistral', saved = true, tail = 'abcd', stt = false,
      model = 'mistral-small-latest', result = {id = id(2), state = 'saved'}})
    mistral = row('mistral-key')
    assert(mistral.label == 'Mistral free API key (…abcd)' and mistral.value == 'Remove', mistral.label)
    assert(mistral.description:find('Deletes the saved key', 1, true) and mistral.description:find('last four characters', 1, true))
    assert(not mistral.description:find('Mistral did not accept', 1, true))
    answer('no-tail', {provider = 'mistral', effective = 'mistral', saved = true})
    assert(row('mistral-key').label == 'Mistral free API key (Added)' and row('mistral-key').value == 'Remove')
    -- An answer to an older command is not shown, a damaged status reads as Convai without a key.
    answer('old', {provider = 'mistral', effective = 'mistral', saved = true, tail = 'abcd', result = {id = 'x:mkey:9', state = 'invalid'}})
    assert(row('mistral-key').label == 'Mistral free API key (…abcd)' and not row('mistral-key').description:find('Mistral did not accept', 1, true))
    answer('garbled', {provider = 7, effective = {}, saved = 'yes', tail = 5, limit = 'sometimes', stt = 'yes', model = 12})
    local state = manager.mistral()
    assert(state.provider == 'convai' and state.effective == 'convai' and state.saved == false and state.tail == nil
      and state.limit == nil and state.stt == false and state.model == nil and state.result == nil)
    assert(row('mistral-key').label == 'Mistral free API key' and row('mistral-key').value == 'Paste')
    -- Limits and the waiting state are told in the last paragraph of the provider row's help.
    for limit, text in pairs({rate = 'Mistral: free limit reached for now', daily = 'Mistral: free limit reached for now',
      invalid = 'Mistral: key not accepted', model = 'Mistral: model unavailable'}) do
      answer('limit-' .. limit, {provider = 'mistral', effective = 'mistral', saved = true, tail = 'abcd', limit = limit})
      assert(note() == text, limit .. ': ' .. note())
    end
    answer('mistral-fine', {provider = 'mistral', effective = 'mistral', saved = true, tail = 'abcd'})
    assert(row('conversationProvider').description == base, 'Mistral answering with no problem needs no note')
    -- Local AI: the state is on the Local AI model row (its name in brackets, its help starting with the loading sentence);
    -- an unknown value never invents a state.
    local WAIT = {warming = {'Local AI model (Warming up)', 'Local AI is warming up…'},
      ['no-memory'] = {'Local AI model (Not enough memory)', 'Not enough graphics memory for Local AI. A cloud provider is used instead.'},
      failed = {'Local AI model (Unavailable)', 'Local AI could not start. Check Local AI in Settings > Conversation provider.'}}
    for value, expected in pairs({ready = false, warming = WAIT.warming, ['no-memory'] = WAIT['no-memory'], failed = WAIT.failed,
        ['not-installed'] = false, sometimes = false, [7] = false}) do
      answer('local-ai-' .. tostring(value), {provider = 'local', effective = 'local', localAi = value})
      local model = row('localModel')
      if expected then
        assert(model.label == expected[1] and firstParagraph(model.description) == expected[2], tostring(value) .. ': ' .. model.label .. ' | ' .. firstParagraph(model.description))
      else
        assert(model.label == 'Local AI model', tostring(value) .. ': ' .. model.label)
        assert(not model.description:find('Local AI is warming up', 1, true) and not model.description:find('could not start', 1, true))
      end
      assert(row('local-ai-status') == nil)
    end
    -- Only Mature models (a Mature-only install, or a server of the player's marked uncensored) with Mature content off: the bridge says
    -- localReason = 'mature-off' beside a failed Local AI, and the model row says what to do instead of the generic line. Any other reason,
    -- or none (an older Runtime), keeps the generic line; a reason without a failure shows nothing.
    do
      local MATURE_OFF = 'Only Mature models found. Turn on Mature content to use them.'
      answer('local-ai-mature-off', {provider = 'local', effective = 'convai', localAi = 'failed', localReason = 'mature-off'})
      local model = row('localModel')
      assert(manager.mistral().localReason == 'mature-off')
      assert(model.label == 'Local AI model (Unavailable)' and firstParagraph(model.description) == MATURE_OFF, model.label .. ' | ' .. firstParagraph(model.description))
      assert(not model.description:find('could not start', 1, true))
      for _, other in ipairs({'low-memory', 'start-failed', 7, true}) do
        answer('local-ai-reason-' .. tostring(other), {provider = 'local', effective = 'convai', localAi = 'failed', localReason = other})
        assert(manager.mistral().localReason == nil and firstParagraph(row('localModel').description) == WAIT.failed[2], tostring(other))
      end
      answer('local-ai-failed-no-reason', {provider = 'local', effective = 'convai', localAi = 'failed'})
      assert(firstParagraph(row('localModel').description) == WAIT.failed[2])
      answer('local-ai-ready-with-reason', {provider = 'local', effective = 'local', localAi = 'ready', localReason = 'mature-off'})
      assert(row('localModel').label == 'Local AI model' and not row('localModel').description:find(MATURE_OFF, 1, true))
    end
    answer('local-ai-none', {provider = 'convai', effective = 'convai'})
    assert(row('localModel').label == 'Local AI model' and manager.mistral().localAi == nil)
    -- Who answers: Local AI needs no note when the bridge uses it, a plain reason when Local is chosen but Convai answers.
    answer('use-local', {provider = 'local', effective = 'local', localAi = 'ready'})
    assert(row('conversationProvider').description == base)
    assert(manager.mistral().provider == 'local' and manager.mistral().effective == 'local' and manager.mistral().localAi == 'ready')
    answer('use-local-pending', {provider = 'local', effective = 'convai', localAi = 'warming', pending = true})
    assert(note() == 'Waiting for the conversation to end')
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 4}}).ok); loaded = registered.loadMod('manager')
    assert(row('conversationProvider').value == 4, 'the saved local choice shows as the fourth element')
    answer('use-local-fallback', {provider = 'local', effective = 'convai', localAi = 'not-installed'})
    assert(note() == 'Convai: Local AI is not ready')
    clock = clock + 2
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 3}}).ok); loaded = registered.loadMod('manager')
    assert(row('conversationProvider').value == 3)
    answer('mistral-no-key', {provider = 'mistral', effective = 'convai', saved = false})
    assert(note() == 'Convai: Mistral has no key yet', note())
    clock = clock + 2
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 2}}).ok); loaded = registered.loadMod('manager')
    assert(row('conversationProvider').value == 2 and saved.useOwnConvaiKey == true)
    clock = clock + 2
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 1}}).ok); loaded = registered.loadMod('manager')
    assert(row('conversationProvider').value == 1 and saved.useOwnConvaiKey == false)
    answer('pending', {provider = 'convai', effective = 'convai', saved = true, tail = 'abcd', pending = true})
    assert(note() == 'Waiting for the conversation to end')
    assert(row('mistral-key').value == 'Remove')
    assert(invoke('mistral-key').ok and jsonFixtures[files['runtime/mistral-key-command.json']].action == 'clear')
  `);
});

test('the Conversation provider setting: five entries stored as a provider and the own-key choice, Convai free tier by default, saved like the other settings, validated', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    local function settings() return manager.snapshot(player).settings end
    assert(invoke('tab:settings').ok)
    assert(settings().conversationProvider == 'convai' and settings().useOwnConvaiKey == false)
    -- 1 Convai free tier, 2 Convai API key, 3 Mistral, 4 Local, 5 Custom.
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 3}}).ok)
    assert(settings().conversationProvider == 'mistral' and saved.conversationProvider == 'mistral' and saved.useOwnConvaiKey == false)
    for _, bad in ipairs({6, 0, -1, 2.5, 'mistral', 'local', 'custom', 'groq', true}) do
      assert(not registered.applyBatch('manager', {{id = 'conversationProvider', value = bad}}).ok, tostring(bad))
    end
    assert(not manager.applySettings(player, {conversationProvider = 'other'}))
    assert(settings().conversationProvider == 'mistral', 'a refused value changes nothing')
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 4}}).ok)
    assert(settings().conversationProvider == 'local' and saved.conversationProvider == 'local' and saved.useOwnConvaiKey == false)
    assert(not registered.applyBatch('manager', {{id = 'conversationProvider', value = 6}}).ok, 'there is no sixth provider')
    assert(not manager.applySettings(player, {conversationProvider = 'groq'}), 'a Groq provider is refused')
    assert(settings().conversationProvider == 'local', 'a refused value changes nothing')
    -- Custom (OpenAI-compatible): the fifth entry, stored as 'custom'; the own-key choice is left as it was.
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 5}}).ok)
    assert(settings().conversationProvider == 'custom' and saved.conversationProvider == 'custom' and saved.useOwnConvaiKey == false)
    loaded = registered.loadMod('manager')
    assert(row('conversationProvider').value == 5, 'a saved custom provider reads as the fifth entry')
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 4}}).ok)
    assert(manager.applySettings(player, {conversationProvider = 'custom'}) and settings().conversationProvider == 'custom')
    assert(manager.applySettings(player, {conversationProvider = 'local'}) and settings().conversationProvider == 'local')
    -- Convai API key: stored as 'convai' with the own-key choice on; Convai free tier turns it off again.
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 2}}).ok)
    assert(settings().conversationProvider == 'convai' and settings().useOwnConvaiKey == true and saved.conversationProvider == 'convai' and saved.useOwnConvaiKey == true)
    loaded = registered.loadMod('manager')
    assert(row('conversationProvider').value == 2, 'convai with the own key reads as the Convai API key entry')
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 1}}).ok)
    assert(settings().conversationProvider == 'convai' and settings().useOwnConvaiKey == false and saved.useOwnConvaiKey == false)
    loaded = registered.loadMod('manager')
    assert(row('conversationProvider').value == 1)
    -- Mistral and Local leave the own-key choice as it was, so it comes back with the Convai entry the player used last.
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 2}}).ok)
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 3}}).ok)
    assert(settings().conversationProvider == 'mistral' and settings().useOwnConvaiKey == true)
    loaded = registered.loadMod('manager')
    assert(row('conversationProvider').value == 3, 'Mistral wins over a stored own-key choice')
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 4}}).ok and settings().useOwnConvaiKey == true)
    -- Both stored settings change together in one transaction, and a failed save changes neither.
    failSave = true
    assert(not registered.applyBatch('manager', {{id = 'conversationProvider', value = 1}}).ok)
    assert(settings().conversationProvider == 'local' and settings().useOwnConvaiKey == true, 'a failed save changed only one of the two')
    failSave = false
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 1}}).ok)
    assert(settings().conversationProvider == 'convai' and settings().useOwnConvaiKey == false)
  `);
});

test('the voice key waits for Convai only while Mistral is in use and this computer cannot recognise speech', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    local function status(tag, value)
      jsonFixtures['voice-' .. tag] = value
      files['runtime/mistral-state.json'] = 'voice-' .. tag
      clock = clock + 2
    end
    local function choose(index) assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = index}}).ok) end
    local MISTRAL, LOCAL = 3, 4
    assert(manager.voiceNeedsConvai() == false, 'Convai is the default')
    status('a', {provider = 'mistral', effective = 'mistral', saved = true, stt = false})
    assert(manager.voiceNeedsConvai() == false, 'the setting is still Convai')
    choose(2)
    assert(manager.voiceNeedsConvai() == false, 'the Convai API key entry is Convai too')
    choose(MISTRAL)
    assert(manager.voiceNeedsConvai() == true)
    status('b', {provider = 'mistral', effective = 'mistral', saved = true, stt = true})
    assert(manager.voiceNeedsConvai() == false, 'local speech recognition makes the voice key work')
    status('c', {provider = 'mistral', effective = 'convai', saved = false, stt = false})
    assert(manager.voiceNeedsConvai() == false, 'no key saved: Convai is used, so the voice key works')
    status('d', {provider = 'mistral', effective = 'mistral', saved = true})
    assert(manager.voiceNeedsConvai() == true, 'a status without stt means no local speech recognition')
    files['runtime/mistral-state.json'] = nil; clock = clock + 2
    assert(manager.voiceNeedsConvai() == false, 'no status file: the safe default')
    status('e', {provider = 'mistral', effective = 'mistral', saved = true, stt = false})
    choose(1)
    assert(manager.voiceNeedsConvai() == false)
    -- Local AI follows the same logic: only while it is the chosen provider and the bridge reports it in use without speech recognition.
    choose(LOCAL)
    status('f', {provider = 'local', effective = 'local', localAi = 'ready', stt = false})
    assert(manager.voiceNeedsConvai() == true, 'Local AI without local speech recognition: the voice key waits for Convai')
    status('g', {provider = 'local', effective = 'local', localAi = 'ready', stt = true})
    assert(manager.voiceNeedsConvai() == false, 'local speech recognition makes the voice key work')
    status('h', {provider = 'local', effective = 'convai', localAi = 'not-installed', stt = false})
    assert(manager.voiceNeedsConvai() == false, 'Local AI could not start: Convai answers, so the voice key works')
    status('i', {provider = 'mistral', effective = 'mistral', saved = true, stt = false})
    assert(manager.voiceNeedsConvai() == false, 'the bridge is on another provider than the chosen one')
    choose(MISTRAL)
    status('j', {provider = 'local', effective = 'local', localAi = 'ready', stt = false})
    assert(manager.voiceNeedsConvai() == false, 'Mistral chosen, Local AI reported: not this check')
  `);
});

test('an add-on voice hears V whenever this computer can recognise speech, whichever provider is chosen', () => {
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    local function status(tag, value)
      jsonFixtures['addon-voice-' .. tag] = value
      files['runtime/mistral-state.json'] = 'addon-voice-' .. tag
      clock = clock + 2
    end
    local function choose(index) assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = index}}).ok) end
    assert(manager.speechRecognitionReady() == false, 'no status file: not ready')
    status('a', {provider = 'convai', effective = 'convai', stt = true})
    assert(manager.speechRecognitionReady() == true, 'a Convai player with the recogniser installed')
    status('b', {provider = 'convai', effective = 'convai', stt = false})
    assert(manager.speechRecognitionReady() == false)
    status('c', {provider = 'convai', effective = 'convai'})
    assert(manager.speechRecognitionReady() == false, 'a status without stt means no recognition')
    for _, index in ipairs({2, 3, 4}) do
      choose(index)
      status('p' .. index, {provider = 'mistral', effective = 'mistral', saved = true, stt = true})
      assert(manager.speechRecognitionReady() == true)
    end
    choose(1)
    assert(manager.voiceNeedsConvai() == false, 'the companion check is untouched')
  `);
});

test('the voice key follows the status file the bridge really publishes for Mistral, with and without local speech recognition', async () => {
  const KEY = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0hL';
  // The bridge side as convai-bridge.mjs wires it: the recogniser's availability becomes provider.sttAvailable, and the
  // control publishes the status file that mod/manager.lua reads.
  async function published(sttAvailable) {
    const speech = createLocalSpeech({stt: {availability: () => ({available: sttAvailable, reason: sttAvailable ? null : 'model-missing'})}, capture: {}});
    const provider = new MistralProvider({keyPath: 'k.txt', readText: async () => `api-key=${KEY}\n`, writeText: async () => {}, removeFile: async () => {}});
    await provider.load();
    provider.setPreference('mistral'); provider.apply();
    provider.sttAvailable = speech.available() === true;
    let status;
    await new MistralControl({provider, commandPath: 'c.json', publish: value => { status = JSON.parse(JSON.stringify(value)); },
      model: () => 'mistral-small-latest', read: async () => ''}).publishStatus();
    return status;
  }
  const lua = value => Array.isArray(value) ? '{}' : value === null ? 'nil' : typeof value === 'object'
    ? '{' + Object.entries(value).map(([k, v]) => `${k}=${lua(v)}`).join(',') + '}' : JSON.stringify(value);
  const withStt = await published(true), without = await published(false);
  assert.equal(withStt.stt, true); assert.equal(without.stt, false);
  assert(!JSON.stringify(withStt).includes(KEY), 'the key never enters the status file');
  run(`${mcmFixture}
    local clock = 1000; os.clock = function() return clock end
    local function status(tag, value)
      jsonFixtures['voice-' .. tag] = value
      files['runtime/mistral-state.json'] = 'voice-' .. tag
      clock = clock + 2
    end
    assert(registered.applyBatch('manager', {{id = 'conversationProvider', value = 3}}).ok)
    status('with', ${lua(withStt)})
    assert(manager.mistral().effective == 'mistral' and manager.mistral().stt == true)
    assert(manager.voiceNeedsConvai() == false, 'Mistral with local speech recognition: the voice key works')
    status('without', ${lua(without)})
    assert(manager.voiceNeedsConvai() == true, 'Mistral without local speech recognition: the voice key waits for Convai')
  `);
});

test('the reply notices for Mistral: three failures, two one-time notices, nothing for an ordinary reply', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  const start = init.indexOf('local function keyNoticeText'), end = init.indexOf('local function reactionCanDeliver');
  assert(start > 0 && end > start, 'the key notice functions moved');
  run(`
    local ui = {t = function(text, params) if params then text = text:gsub('{(%w+)}', function(key) return tostring(params[key]) end) end return text end}
    local sent = {}
    convaiNotices = {send = function(_, id, text) sent[#sent + 1] = id .. '=' .. text; return true end}
    ${init.slice(start, end)}
    local function notice(reply) local id, text = keyReplyNotice(reply); return id, text end
    local id, text = notice({errorCode = 'mistral-key', error = 'x'})
    assert(id == 'mistral-key' and text:find('did not accept your key', 1, true) and text:find('Settings > Conversation provider', 1, true), text)
    id, text = notice({errorCode = 'mistral-limit', error = 'x'})
    assert(id == 'mistral-limit' and text:find('free limit', 1, true) and not text:find('Convai', 1, true), text)
    id, text = notice({errorCode = 'mistral-model', error = 'x'})
    assert(id == 'mistral-model' and text:find('unavailable', 1, true) and text:find('a minute', 1, true), text)
    id, text = notice({keyNotice = 'mistral-no-key', text = 'Hello'})
    assert(id == 'mistral-no-key' and text:find('no key yet', 1, true) and text:find('Convai is used', 1, true), text)
    id, text = notice({keyNotice = 'mistral-voice', text = 'Hello'})
    assert(id == 'mistral-voice' and text:find('local voice', 1, true), text)
    -- The one-time notices go through the gate under their own ids; anything else sends nothing.
    -- Local AI fell back to Convai: the same line on the first reply (keyNotice) and on a failed turn (errorCode).
    local expected = 'Local AI could not start, so a cloud provider is used. Check Local AI in Settings > Conversation provider.'
    id, text = notice({keyNotice = 'local-fallback', text = 'Hello'})
    assert(id == 'local-fallback' and text == expected, text)
    id, text = notice({errorCode = 'local-fallback', error = 'x'})
    assert(id == 'local-fallback' and text == expected, text)
    assert(not text:lower():find('mistral', 1, true) and not text:lower():find('paid', 1, true) and not text:lower():find('text only', 1, true))
    sendProviderNotice({}, 'mistral-no-key', 'a'); sendProviderNotice({}, 'mistral-voice', 'b'); sendProviderNotice({}, 'key-memory', 'c')
    assert(#sent == 2 and sent[1] == 'mistral-no-key=a' and sent[2] == 'mistral-voice=b', table.concat(sent, ';'))
    sendProviderNotice({}, 'local-fallback', 'd')
    assert(#sent == 3 and sent[3] == 'local-fallback=d', table.concat(sent, ';'))
    -- The Local AI model the player chose is missing or does not fit: one line on the reply that follows, under its own id.
    -- It names the model that was used instead (the reply carries its name); a missing or odd name reads 'another model'.
    id, text = notice({keyNotice = 'local-model-fallback', keyNoticeModel = 'Qwen3.5-2B', text = 'Hello'})
    assert(id == 'local-model-fallback' and text == 'The Local AI model you chose is missing, does not fit in the free graphics memory or did not start, so Qwen3.5-2B was used instead.', text)
    for _, odd in ipairs({'', string.rep('a', 81), 'bad' .. string.char(10) .. 'name', 'bad' .. string.char(0) .. 'name', 7, true, {}}) do
      id, text = notice({keyNotice = 'local-model-fallback', keyNoticeModel = odd, text = 'Hello'})
      assert(id == 'local-model-fallback' and text == 'The Local AI model you chose is missing, does not fit in the free graphics memory or did not start, so another model was used instead.', tostring(odd) .. ': ' .. text)
    end
    id, text = notice({keyNotice = 'local-model-fallback', keyNoticeModel = string.rep('a', 80), text = 'Hello'})
    assert(text:find(string.rep('a', 80) .. ' was used instead.', 1, true), text)
    id, text = notice({keyNotice = 'local-model-fallback', text = 'Hello'})
    assert(id == 'local-model-fallback' and text == 'The Local AI model you chose is missing, does not fit in the free graphics memory or did not start, so another model was used instead.', text)
    assert(not text:find('Auto', 1, true))
    sendProviderNotice({}, 'local-model-fallback', 'e')
    assert(#sent == 4 and sent[4] == 'local-model-fallback=e', table.concat(sent, ';'))
    assert(notice({errorCode = 'quota-shared'}) == 'quota-exhausted', 'the Convai refusals keep their own notice')
    assert(notice({text = 'Hello'}) == nil and notice({keyNotice = 'other'}) == nil)
  `);
});

// A companion the repo knows is invited only when the installed copies of the roster (conversation-characters.json) and
// manager-characters.json carry her too. A stale install of those data files answered "That character model is unavailable."
// for Alt Cunningham on 2026-10-11, so this pins what the committed data must resolve and what the stale shape looks like.
function luaLiteral(value) {
  if (Array.isArray(value)) return '{' + value.map(luaLiteral).join(',') + '}';
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value).map(([key, item]) => `[${JSON.stringify(key)}]=${luaLiteral(item)}`).join(',') + '}';
  }
  return JSON.stringify(value);
}
const repoJson = name => JSON.parse(readFileSync(new URL('../' + name, import.meta.url), 'utf8'));

test('every manager-characters.json row resolves, with its profile, from the committed roster, and Alt Cunningham can be invited', () => {
  const roster = repoJson('characters/roster.json');
  const profiles = (Array.isArray(roster) ? roster : roster.characters || roster.profiles)
    .map(row => ({key: row.key, name: row.name, records: row.records}));
  const rows = repoJson('characters/manager-characters.json');
  assert(rows.some(row => row.key === 'alt-cunningham' && row.record === 'Character.Alt'), 'Alt has a manager row');
  assert(profiles.some(row => row.key === 'alt-cunningham' && row.records.includes('Character.Alt')), 'Alt is in the roster');
  run(`${managerFixture}
    files['manager-characters.json'] = 'extras'
    extras = ${luaLiteral(rows)}
    manager.configure(api, ${luaLiteral(profiles)})
    for _, row in ipairs(extras) do
      local definition = api.definition(row.key)
      assert(definition and definition.id == row.record, row.key .. ' has no companion definition')
      assert(definition.profileKey == (row.profileKey or row.key), row.key .. ' lost its conversation profile')
    end
    local alt = api.definition('alt-cunningham')
    assert(alt.id == 'Character.Alt' and alt.profileKey == 'alt-cunningham' and alt.name == 'Alt Cunningham')
    local queue = (function() ${queueSource} end)().new(api)
    queue.bind('player-1')
    assert(queue.invite('alt-cunningham') == true)
  `);
});

test('a stale install without Alt (roster and manager-characters from before 2026-10-10) is refused with the model-unavailable notice', () => {
  const roster = repoJson('characters/roster.json');
  const profiles = (Array.isArray(roster) ? roster : roster.characters || roster.profiles)
    .filter(row => row.key !== 'alt-cunningham').map(row => ({key: row.key, name: row.name, records: row.records}));
  const rows = repoJson('characters/manager-characters.json').filter(row => row.key !== 'alt-cunningham');
  run(`${managerFixture}
    files['manager-characters.json'] = 'extras'
    extras = ${luaLiteral(rows)}
    manager.configure(api, ${luaLiteral(profiles)})
    local queue = (function() ${queueSource} end)().new(api)
    queue.bind('player-1')
    local ok, message = queue.invite('alt-cunningham')
    assert(ok == false and message == 'That character model is unavailable.', tostring(message))
  `);
});

test('the per-frame MCM update asks MCM for its diagnostics once a second while our page is not shown and four times a second while it is', () => {
  run(`${mcmFixture}
    local clock, reads = 10, 0
    os.clock = function() return clock end
    local diagnostics = nativeApi.getDiagnostics
    nativeApi.getDiagnostics = function() reads = reads + 1; return diagnostics() end
    for _ = 1, 60 do mcm.update(player, true); clock = clock + 1 / 60 end
    assert(reads <= 2, 'diagnostics read ' .. reads .. ' times in one second with the page closed')
    -- Our page opening is noticed by the hooks in the same frame (presentation.pending), and
    -- while it is shown the answer is re-read every 0.25 s, not on every frame.
    handlers.McmUiSetContentTitle(controller, 'Companion Manager')
    assert(mcm.inspect().presentation.active, 'the hook did not mark our page shown')
    reads = 0
    for _ = 1, 30 do mcm.update(player, true); clock = clock + 1 / 60 end
    assert(reads >= 1 and reads <= 5, 'page shown: diagnostics read ' .. reads .. ' times in half a second')
  `);
});

test('with the settings menu closed the queue flush, notices and player identity run on a 0.25 s tick, and a queue change or resume runs it at once', () => {
  run(`${mcmFixture}
    local clock, flushes, identities = 10, 0, 0
    os.clock = function() return clock end
    -- The once-a-second work (settings re-install, preparation feedback) follows the wall clock os.time, which also reads the
    -- player on a real second boundary: hold it still so the count below is only the tick.
    os.time = function() return 0 end
    local party = mcm.party()
    local flush = party.flush
    party.flush = function(...) flushes = flushes + 1; return flush(...) end
    local getId = player.GetEntityID
    function player:GetEntityID() identities = identities + 1; return getId(self) end
    for _ = 1, 120 do mcm.update(player, true); clock = clock + 1 / 60 end
    assert(flushes >= 7 and flushes <= 9, 'flushed ' .. flushes .. ' times in two seconds')
    assert(identities <= flushes + 3, 'the player identity was read outside the tick: ' .. identities .. ' for ' .. flushes)
    -- A queue change is flushed by the next frame, inside the tick period.
    mcm.update(player, true)
    local before = flushes
    party.dismiss('no-such-copy')
    mcm.update(player, true)
    assert(flushes == before + 1, 'a queue change waited for the tick')
    -- Returning to gameplay runs it at once, so a spawn is not held a quarter second after a menu.
    mcm.update(player, false)
    before = flushes
    mcm.update(player, true)
    assert(flushes == before + 1, 'the first gameplay frame did not flush')
  `);
});

test('a notice is held at most one tick: a voice switch reaches the player once and is never lost', () => {
  run(`${mcmFixture}
    local clock = 10
    os.clock = function() return clock end
    local sent = {}
    convaiNotices = {sendLines = function(_, lines) for _, line in ipairs(lines) do sent[#sent + 1] = line.id end return #lines end}
    mcm.update(player, true); clock = clock + 1 / 60
    local taken = 0
    manager.takeNaturalSpeechNotice = function() taken = taken + 1; return taken == 1 and 'Voice switched.' or nil end
    local frames = 0
    while #sent == 0 and frames < 60 do mcm.update(player, true); clock = clock + 1 / 60; frames = frames + 1 end
    assert(#sent == 1 and sent[1] == 'voice-switched', 'the notice was lost')
    assert(frames <= 16, 'the notice waited ' .. frames .. ' frames')
    for _ = 1, 60 do mcm.update(player, true); clock = clock + 1 / 60 end
    assert(#sent == 1, 'the notice repeated')
  `);
});

const stylingFixture = `
  CName = {new = function(value) return value end}
  NameToString = function(value) return value end
  local counters = {binds = {}, content = 0, indexed = 0}
  local function widget(name, left, children)
    local value = {name = name, left = left or 0, width = 200, children = children or {}}
    function value:GetName() return self.name end
    function value:GetNumChildren() if self == counters.contentWidget then counters.content = counters.content + 1 end return #self.children end
    function value:GetWidgetByIndex(index) counters.indexed = counters.indexed + 1; return self.children[index + 1] end
    function value:GetMargin() return {left = self.left, top = 48, right = 0, bottom = 0} end
    function value:SetMargin(margin) self.left = margin.left end
    function value:GetWidth() return self.width end
    function value:GetHeight() return 10 end
    function value:SetWidth(width) self.width = width end
    function value:GetScale() return {X = 1, Y = 1} end
    function value:GetController() return nil end
    function value:BindProperty(property, color)
      self.color = color; counters.binds[self.name] = (counters.binds[self.name] or 0) + 1
    end
    return value
  end
  local content = widget('mcm_content_scroll_content')
  counters.contentWidget = content
  local status = widget('status')
  local sidebar = widget('mcm_sidebar_scroll_content', 0, {widget('mod-entry')})
  local render = widget('MCMRenderRoot', 0, {content, status, sidebar})
  local root = widget('root', 0, {render})
  function controller:GetRootWidget() return root end
  local function reference() return setmetatable({nativeIdentity = 101}, {__index = controller}) end
  local function open()
    handlers.McmUiBegin(reference(), 'MCM', '', 'Mods', 'Mods', '', 0, '', true, true, 0, function() end)
    handlers.McmUiSetContentTitle(reference(), 'Companion Manager')
  end
`;

test('a hover-out re-tints only its own label instead of walking the page again', () => {
  run(`${mcmFixture}${stylingFixture}
    local labels = {}
    for _, id in ipairs({'a', 'b', 'c'}) do
      labels[id] = widget(id .. '_managed_label', 48)
      content.children[#content.children + 1] = labels[id]
    end
    open()
    mcm.update(player, false)
    assert(not mcm.inspect().presentation.pending and labels.a.color == 'MainColors.Red' and labels.c.color == 'MainColors.Red')
    local binds, reads, indexed = counters.binds.b_managed_label, counters.content, counters.indexed
    labels.b.color = 'native-cyan'
    handlers.McmUiSetManagedLabelState(reference(), 'b', true, true)
    handlers.McmUiSetManagedLabelState(reference(), 'b', false, true)
    assert(mcm.inspect().presentation.restyling == 1 and not mcm.inspect().presentation.pending)
    mcm.update(player, false)
    assert(labels.b.color == 'MainColors.Red', 'the hovered label kept its native tint')
    assert(counters.binds.b_managed_label == binds + 1 and counters.binds.a_managed_label == 1 and counters.binds.c_managed_label == 1)
    assert(counters.content == reads and counters.indexed == indexed, 'the page was walked again for one label')
    assert(mcm.inspect().presentation.restyling == 0)
    -- A row still hovered is left to the native feedback.
    labels.a.color = 'native-hover'
    handlers.McmUiEmitHover(reference(), 'a', '', true)
    handlers.McmUiEmitHover(reference(), 'c', '', false)
    mcm.update(player, false)
    assert(labels.a.color == 'native-hover' and labels.c.color == 'MainColors.Red')
  `);
});

test('a freshly drawn page is styled in bounded batches, every row is styled, and the Back button waits for the last batch', () => {
  run(`${mcmFixture}${stylingFixture}
    local rows = {}
    for index = 1, 500 do
      rows[index] = widget('r' .. index .. '_managed_label', 48)
      content.children[#content.children + 1] = rows[index]
    end
    open()
    local before = counters.indexed
    mcm.update(player, false)
    assert(counters.indexed - before <= 310, 'the first frame visited ' .. (counters.indexed - before) .. ' widgets')
    assert(mcm.inspect().presentation.pending and mcm.inspect().presentation.styling, 'a 500-row page finished in one frame')
    assert(#bottomActions == 0, 'the Back button was placed before the page was styled')
    local frames = 1
    while mcm.inspect().presentation.pending and frames < 40 do
      before = counters.indexed
      mcm.update(player, false); frames = frames + 1
      assert(counters.indexed - before <= 310, 'a batch visited ' .. (counters.indexed - before) .. ' widgets')
    end
    assert(not mcm.inspect().presentation.pending and frames <= 20, 'styling took ' .. frames .. ' frames')
    for index = 1, 500 do assert(rows[index].color == 'MainColors.Red', 'row ' .. index .. ' was not styled') end
    -- A new render drops an unfinished batch and starts again.
    content.children = {widget('x_managed_label', 48)}
    open(); mcm.update(player, false)
    assert(not mcm.inspect().presentation.pending and content.children[1].color == 'MainColors.Red')
  `);
});

// Settings flicker: a drawn page is hidden until styled, and a page is drawn again only when what it shows changed.
const opacityFixture = `
  content.opacity = 1
  local opacities = {}
  function content:GetOpacity() return self.opacity end
  function content:SetOpacity(value) self.opacity = value; opacities[#opacities + 1] = value end
`;

test('a freshly drawn page is hidden until it is styled, shown again at its own opacity, and never hidden longer than 0.75 s', () => {
  run(`${mcmFixture}${stylingFixture}
    local clock = 10
    os.clock = function() return clock end
    ${opacityFixture}
    content.opacity = 0.9
    local function fill()
      content.children = {}
      for index = 1, 500 do content.children[index] = widget('r' .. index .. '_managed_label', 48) end
    end
    fill(); open()
    assert(content.opacity == 0.9 and #opacities == 0, 'the veil was raised inside the native observer')
    mcm.update(player, false)
    assert(content.opacity == 0 and mcm.inspect().presentation.pending)
    local frames = 1
    while mcm.inspect().presentation.pending and frames < 40 do
      assert(content.opacity == 0, 'rows were visible while unstyled (frame ' .. frames .. ')')
      mcm.update(player, false); frames = frames + 1
    end
    assert(not mcm.inspect().presentation.pending and frames > 1)
    assert(content.opacity == 0.9 and #opacities == 2 and opacities[1] == 0 and opacities[2] == 0.9,
      'the page was not shown again at its own opacity: ' .. tostring(content.opacity))
    -- A page whose styling is slow is shown after 0.75 s anyway, unfinished rather than hidden.
    fill(); open(); mcm.update(player, false)
    assert(content.opacity == 0 and mcm.inspect().presentation.pending)
    clock = clock + 1; mcm.update(player, false)
    assert(content.opacity == 0.9, 'the veil outlived its limit')
    -- A page that cannot be styled (no content) is never left hidden.
    content.children = {}; open(); mcm.update(player, false); mcm.update(player, false)
    assert(content.opacity == 0.9 and not mcm.inspect().presentation.pending)
  `);
});

// A value change (slider, option, toggle) makes MCM draw the whole page again from its own update, after this module's in the
// frame. The new page's content must never show in MCM's default look: it is created hidden, in the same call, and shown when
// it is styled.
const valueChangeFixture = `
  local clock = 10
  os.clock = function() return clock end
  ${opacityFixture}
`;
const drawFixture = `
  local wrapper = {visible = true, sets = {}}
  function wrapper:SetVisible(value) self.visible = value; self.sets[#self.sets + 1] = value end
  local scroll = {GetParentWidget = function() return wrapper end}
  content.GetParentWidget = function() return scroll end
  local passed = {}
  -- What MCM does for one draw, in its own order; wrapper starts visible like a freshly created scroll area.
  local function draw(title, text, kind)
    wrapper.visible = true
    content.opacity = 1
    handlers.McmUiBegin(reference(), 'MCM', '', 'Mods', title or 'Companion Manager', text or '', kind or 0, '', true, true, 0,
      function(_, _, _, _, statusArg) passed.status = statusArg end)
    handlers.McmUiBeginContent(reference(), 400, 0.25, true, function(height, scrollPosition, ready)
      passed.ready, passed.height, passed.scroll = ready, height, scrollPosition
      wrapper.visible = ready
    end)
    handlers.McmUiSetContentTitle(reference(), 'Companion Manager')
  end
  local function fill(count)
    content.children = {}
    for index = 1, count do content.children[index] = widget('r' .. index .. '_managed_label', 48) end
  end
`;

test('a value change draws the page with its content hidden in the same call, and shows it once it is styled', () => {
  run(`${mcmFixture}${stylingFixture}${valueChangeFixture}${drawFixture}
    fill(500)
    for change = 1, 4 do
      draw('Companion Manager', 'Pending: Voice')
      assert(passed.ready == false and wrapper.visible == false, 'the page was created visible (change ' .. change .. ')')
      -- The first draw opens the page afresh (top); a redraw of the open page keeps MCM's position.
      assert(passed.height == 400 and passed.scroll == (change == 1 and 0 or 0.25), 'the other arguments were changed')
      assert(passed.status == 'Pending: Voice', 'the status text was changed: ' .. tostring(passed.status))
      local frames = 0
      repeat
        assert(wrapper.visible == false, 'the content showed while unstyled (change ' .. change .. ', frame ' .. frames .. ')')
        mcm.update(player, false); frames = frames + 1
      until not mcm.inspect().presentation.pending or frames > 40
      mcm.update(player, false)
      assert(wrapper.visible == true and content.opacity == 1, 'the styled page was not shown (change ' .. change .. ')')
    end
    assert(#wrapper.sets == 4 and wrapper.sets[4] == true, 'the content was shown more than once per draw')
  `);
});

test('only the manager is held: another mod page, and a page that wants itself hidden, are left as they are', () => {
  run(`${mcmFixture}${stylingFixture}${valueChangeFixture}${drawFixture}
    fill(5)
    -- Another mod's page.
    handlers.McmUiBegin(reference(), 'MCM', '', 'Mods', 'Another Mod', 'Opened.', 0, '', true, true, 0,
      function(_, _, _, _, statusArg) passed.status = statusArg end)
    handlers.McmUiBeginContent(reference(), 400, 0, true, function(_, _, ready) passed.ready = ready end)
    assert(passed.ready == true and passed.status == 'Opened.', 'a foreign page was held')
    -- Ours, but MCM itself wants the content hidden (it does for a page that still has to be measured): unchanged.
    handlers.McmUiBegin(reference(), 'MCM', '', 'Mods', 'Companion Manager', '', 0, '', true, true, 0, function() end)
    handlers.McmUiBeginContent(reference(), 400, 0, false, function(_, _, ready) passed.ready = ready end)
    assert(passed.ready == false)
    draw('Companion Manager', '')
    for _ = 1, 4 do mcm.update(player, false) end
    assert(wrapper.visible == true)
  `);
});

test('a held page that was never styled is shown after 1.5 s, and a page that cannot be released switches the hold off', () => {
  run(`${mcmFixture}${stylingFixture}${valueChangeFixture}${drawFixture}
    fill(5)
    draw('Companion Manager', 'Pending: Voice')
    assert(wrapper.visible == false)
    -- The settings page stops being the manager's before any styling ran (another mod is selected): the content comes back.
    activeMod = 'another-mod:page'
    mcm.update(player, false); assert(wrapper.visible == false, 'released too early')
    clock = clock + 2
    mcm.update(player, false)
    assert(wrapper.visible == true, 'a page that is no longer ours stayed hidden')
    -- A page whose scroll wrapper cannot be found is drawn again, and from then on never held.
    activeMod = 'cyberpunk-convai:manager'
    content.GetParentWidget = function() error('no parent') end
    draw('Companion Manager', '')
    assert(passed.ready == false)
    activeMod = 'another-mod:page'
    clock = clock + 2; mcm.update(player, false)
    draw('Companion Manager', 'Pending: Voice')
    assert(passed.ready == true, 'a page was held after the hold failed')
  `);
});

// The early style (mod/mcm.lua, "Early style"): a page MCM draws again after a value change is given its final look while it is
// drawn and shown in the same call, so there is no frame of the default look, no blank page and no jump of the status line or the
// bottom buttons. This fixture plays MCM's draw in its own order through the handlers the module registers.
const earlyFixture = `
  CName = {new = function(value) return value end}
  NameToString = function(value) return value end
  IsDefined = function(value) return value ~= nil end
  textWrappingPolicy = {Default = 0}
  textVerticalAlignment = {Top = 'top'}
  local clock = 10
  os.clock = function() return clock end
  -- Every widget method the module calls is counted: work on widgets shows up as a changed count.
  local calls = 0
  local methods = {}
  local meta = {__index = function(_, key)
    local method = methods[key]
    if method then calls = calls + 1 end
    return method
  end}
  local function widget(name, left, top, width, height, children, size)
    return setmetatable({name = name, margin = {left = left or 0, top = top or 0}, width = width or 100, height = height or 40,
      children = children or {}, fontSize = size or 22, scale = 1, opacity = 1, sets = 0}, meta)
  end
  methods.GetName = function(self) return self.name end
  methods.GetMargin = function(self) return {left = self.margin.left, top = self.margin.top, right = 0, bottom = 0} end
  methods.SetMargin = function(self, m) self.margin = {left = m.left, top = m.top} end
  methods.GetWidth = function(self) return self.width end
  methods.SetWidth = function(self, v) self.width = v end
  methods.GetHeight = function(self) return self.height end
  methods.SetHeight = function(self, v) self.height = v end
  methods.GetNumChildren = function(self) return #self.children end
  methods.GetWidgetByIndex = function(self, i) return self.children[i + 1] end
  methods.GetParentWidget = function(self) return self.parent end
  methods.Reparent = function(self, parent)
    local old = self.parent
    if old then for i, child in ipairs(old.children) do if child == self then table.remove(old.children, i) break end end end
    self.parent = parent; parent.children[#parent.children + 1] = self
  end
  methods.SetVerticalAlignment = function() end
  methods.GetFontSize = function(self) return self.fontSize end
  methods.SetFontSize = function(self, v) self.fontSize = v end
  methods.SetWrapping = function() end
  methods.BindProperty = function(self, _, color) self.color = color end
  methods.GetScale = function(self) return {X = self.scale, Y = self.scale} end
  methods.GetController = function() return nil end
  methods.SetVisible = function(self, v) self.visible = v; self.sets = self.sets + 1 end
  methods.GetOpacity = function(self) return self.opacity end
  methods.SetOpacity = function(self, v) self.opacity = v end
  -- What the game's McmUiCreateText makes.
  local function rawText(parent, name, value, x, y, width, height, size, color)
    local text = widget(name, x, y, width, height, nil, size)
    text.color, text.text = color, value
    text.parent = parent; parent.children[#parent.children + 1] = text
    return text
  end
  local ref = setmetatable({nativeIdentity = 101}, {__index = controller})
  controller.McmUiGetLayoutMetric = function(_, metric) return ({[13] = 320, [20] = 100, [23] = 800, [27] = 1000, [28] = 900})[metric] or -1 end
  local page
  function controller:GetRootWidget() return page.root end
  -- The content scroll position: what the page being replaced reports, and what is set on the new scroll controller.
  local scrollNow, scrolls = 0, 0
  controller.McmUiGetContentScrollPosition = function() return scrollNow end
  -- One draw of the manager's page, in MCM's order. Options: rows = {managed, action, readonly}, categories, bar (labels of the
  -- buttons on the bar line), plain (the text override does nothing: the creations bypass it), ignoresX (the game ignores the
  -- x it is given for a managed label), noState (no managed-label state call), badCategory, finish = false (the draw never ends),
  -- title and status.
  local function draw(o)
    o = o or {}
    local p = {render = widget('MCMRenderRoot', 0, 0, 1920, 1080), list = widget('mcm_sidebar_scroll_content', 0, 0, 340, 126),
      content = widget('mcm_content_scroll_content', 0, 0, 800, 2000), wrapper = widget('mcm_content_scroll', 100, 200, 800, 700),
      viewport = widget('scroll_area', 0, 0, 800, 700), texts = {}, markers = {}, labels = {}, actions = {}, readonly = {},
      values = {}, headings = {}, passed = {}}
    p.root = widget('root', 0, 0, 1920, 1080, {p.render}); p.render.parent = p.root
    p.scroll = 0
    p.wrapper.GetController = function()
      return {GetScrollPosition = function() return p.scroll end,
        SetScrollPosition = function(_, value) p.scroll = value; scrolls = scrolls + 1 end}
    end
    if o.badScroller then p.wrapper.GetController = function() error('no controller') end end
    for i = 0, 2 do
      local entry = widget('mcm_entry_' .. i, 20, i * 42, 300, 42); entry.parent = p.list; p.list.children[i + 1] = entry
    end
    page = p
    local raw = rawText
    if o.ignoresX then
      raw = function(parent, name, value, x, ...) return rawText(parent, name, value, name:find('_managed_label', 1, true) and 48 or x, ...) end
    end
    local function mk(parent, name, value, x, width, size, color)
      if o.plain then return raw(parent, name, value, x, 0, width, 42, size or 22, color or 'native-secondary', 0) end
      return handlers.McmUiCreateText(ref, parent, name, value, x, 0, width, 42, size or 22, color or 'native-secondary', 0, raw)
    end
    handlers.McmUiBegin(ref, 'MCM', '', 'Mods', o.title or 'Companion Manager', o.status or 'Pending: Voice', 0, '', true, true, 0, function()
      for _, name in ipairs({'title', 'subtitle', 'sidebar_title', 'content_title', 'status'}) do
        local text = mk(p.render, name, name, 10, 200, 24, 'native-blue')
        if name == 'status' then p.status = text else p.texts[name] = text end
      end
    end)
    handlers.McmUiCreateScrollArea(ref, p.render, 'mcm_sidebar_scroll', 0, 0, 340, 700, 700, function()
      local sidebar = widget('sidebar_wrapper')
      sidebar.children, p.list.parent, sidebar.parent = {p.list}, sidebar, p.render
      p.render.children[#p.render.children + 1] = sidebar
      return {content = p.list, wrapper = sidebar}
    end)
    handlers.McmUiBeginContent(ref, 400, o.scroll or 0, true, function(height, scroll, ready)
      p.beginScroll = scroll
      p.scroll = o.sticks and scroll or 0
      handlers.McmUiCreateScrollArea(ref, p.render, 'mcm_content_scroll', 100, 200, 800, 700, 2000, function()
        p.wrapper.children, p.viewport.children = {p.viewport}, {p.content}
        p.content.parent, p.viewport.parent, p.wrapper.parent = p.viewport, p.wrapper, p.render
        p.render.children[#p.render.children + 1] = p.wrapper
        return {content = p.content, wrapper = p.wrapper}
      end)
      p.wrapper.visible = ready
    end)
    local rows = o.rows or {}
    for i = 1, (o.categories or 0) do
      local label = widget('label', 20, 0, 1600, 40, nil, 30); label.color = 'native-heading'
      if o.badCategory then label.BindProperty = function() error('native failure') end end
      local category = widget('settingsCategory', 0, 100 * i, 1800, 80, {widget('line', 0, 0, 1800, 4), label})
      category.scale = 0.5; category.parent = p.content; p.content.children[#p.content.children + 1] = category
      p.headings[i] = {root = category, label = label, line = category.children[1]}
      handlers.McmUiSetup({GetRootWidget = function() return category end})
      handlers.McmUiAddCategory(ref, 'category' .. i, 'Heading', 'd', '')
    end
    for i = 1, (rows.managed or 0) do
      local id = 'mcm_1_' .. i
      handlers.McmUiAddManagedLabel(ref, id, 'Label', '*', false, 0, function()
        p.markers[i] = mk(p.content, id .. '_managed_marker', '*', 100, 40, 22, 'native-purple')
        p.labels[i] = mk(p.content, id .. '_managed_label', 'Label', 48, 300, 22, 'native-secondary')
      end)
      if not o.noState then handlers.McmUiSetManagedLabelState(ref, id, false, false) end
    end
    for i = 1, (rows.action or 0) do
      local id = 'mcm_2_' .. i
      handlers.McmUiAddActionSetting(ref, id, 'Label', 'd', 'Open', function()
        p.actions[i] = mk(p.content, id .. '_label', 'Label', 20, 300, 22, 'native-secondary')
      end)
    end
    for i = 1, (rows.readonly or 0) do
      local id = 'mcm_3_' .. i
      handlers.McmUiAddReadonly(ref, id, 'Label', 'd', 'value', function()
        local surface = widget('mcm_action_' .. id, 20, 0, 400, 42)
        surface.parent = p.content; p.content.children[#p.content.children + 1] = surface
        p.readonly[i] = mk(surface, 'label', 'Label', 30, 340, 26, 'native-secondary')
        p.values[i] = mk(p.content, id .. '_value', 'value', 500, 360, 22, 'native-muted')
      end)
    end
    for index, label in ipairs(o.bar or {}) do
      handlers.McmUiAddBottomActionAt(ref, 'bar' .. index, label, 300 + (index - 1) * 160, 1000, 140, false, function(...)
        p.passed[#p.passed + 1] = table.pack(...)
      end)
    end
    if o.finish ~= false then handlers.McmUiSetContentTitle(ref, o.title or 'Companion Manager') end
    return p
  end
  -- Frames until the older pass has styled and shown a page that was held back.
  local function settle()
    local frames = 0
    while frames < 40 and (page.wrapper.visible ~= true or mcm.inspect().presentation.pending) do
      mcm.update(player, false); frames = frames + 1
    end
    assert(page.wrapper.visible == true and not mcm.inspect().presentation.pending, 'the older pass did not show the page')
    return frames
  end
  local function backs()
    local count = 0
    for _, button in ipairs(bottomActions) do if button.id == 'convai-bottom-back' then count = count + 1 end end
    return count
  end
`;

test('a value change draws the page in its final look and shows it in the same call, with no frame of the default look', () => {
  run(`${mcmFixture}${earlyFixture}
    assert(invoke('tab:settings').ok)
    for _ = 1, 3 do mcm.update(player, false) end
    local p = draw({rows = {managed = 3, action = 2, readonly = 2}, categories = 2, bar = {'Revert', 'Apply'}})
    -- Shown at once, before any update runs.
    assert(p.wrapper.visible == true, 'the page stayed hidden after the draw')
    local info = mcm.inspect()
    assert(info.early.hooks and info.early.shown == 1 and info.early.held == 0, 'the early style did not complete: ' .. info.early.reason)
    assert(not info.presentation.pending and not info.presentation.styling and info.presentation.active)
    -- Managed rows: label at x 20 keeping its right edge, marker 12 wide at 0 keeping its colour, the red label colour.
    for i = 1, 3 do
      assert(p.labels[i].margin.left == 20 and p.labels[i].width == 328 and p.labels[i].color == 'MainColors.Red', 'managed label ' .. i)
      assert(p.markers[i].margin.left == 0 and p.markers[i].width == 12 and p.markers[i].color == 'native-purple', 'managed marker ' .. i)
    end
    for i = 1, 2 do
      assert(p.actions[i].color == 'MainColors.Red' and p.actions[i].margin.left == 20 and p.actions[i].width == 300, 'action label ' .. i)
      local text = p.readonly[i]
      assert(text.margin.left == 0 and text.width == 370 and text.fontSize == 22 and text.color == 'MainColors.Red', 'read-only label ' .. i)
      assert(p.values[i].margin.left == 500 and p.values[i].width == 360 and p.values[i].color == 'native-muted', 'a value text was changed')
    end
    -- Texts that are not rows are left as MCM made them.
    for _, name in ipairs({'title', 'subtitle', 'sidebar_title', 'content_title'}) do
      assert(p.texts[name].margin.left == 10 and p.texts[name].width == 200 and p.texts[name].color == 'native-blue', name .. ' was changed')
    end
    -- Section headings: white, at the content edge in content coordinates; the native rule is left alone.
    for i = 1, 2 do
      local heading = p.headings[i]
      assert(heading.root.margin.left + heading.root.scale * heading.label.margin.left == 20 and heading.label.color == 'MainColors.White', 'heading ' .. i)
      assert(heading.line.color == nil, 'the native rule was recoloured')
    end
    -- The status line is under the mod list; the bar line is complete, created in this call: held buttons shifted left by the
    -- Back button's width and gap, Back at the right end.
    assert(p.status.parent == p.list and p.status.margin.left == 20 and p.status.margin.top == 126 + 14 and p.status.width == 320, 'status line misplaced')
    assert(#bottomActions == 3 and #p.passed == 0, 'the bar was not created in the draw: ' .. #bottomActions)
    assert(bottomActions[1].id == 'bar1' and bottomActions[1].x == 140 and bottomActions[2].id == 'bar2' and bottomActions[2].x == 300, 'bar buttons were not shifted')
    assert(bottomActions[3].id == 'convai-bottom-back' and bottomActions[3].x == 760 and bottomActions[3].y == 1000 and bottomActions[3].width == 140, 'Back misplaced')
    -- Frames after the draw do no work on the page: no walk, no veil, no second Back.
    mcm.update(player, false)
    local before = calls
    for _ = 1, 8 do mcm.update(player, false) end
    assert(calls == before, 'idle frames made ' .. (calls - before) .. ' widget calls')
    assert(p.content.opacity == 1 and p.wrapper.sets == 1 and #bottomActions == 3, 'idle frames touched the page')
    -- A hover-out puts the row's label back to the red label colour (MCM tints it with the native colour on hover).
    p.labels[2].color = 'native-cyan'
    handlers.McmUiSetManagedLabelState(ref, 'mcm_1_2', true, false)
    handlers.McmUiSetManagedLabelState(ref, 'mcm_1_2', false, false)
    mcm.update(player, false)
    assert(p.labels[2].color == 'MainColors.Red', 'the label kept the native colour after the hover')
    assert(p.labels[1].color == 'MainColors.Red' and p.labels[3].color == 'MainColors.Red')
  `);
});

test('every value change draws the same finished page again, each shown once in its own call', () => {
  run(`${mcmFixture}${earlyFixture}
    assert(invoke('tab:settings').ok)
    for change = 1, 5 do
      local p = draw({rows = {managed = 3, action = 1, readonly = 1}, categories = 1, bar = {'Revert', 'Apply'}})
      assert(p.wrapper.visible == true and p.wrapper.sets == 1 and p.labels[1].margin.left == 20, 'draw ' .. change)
      mcm.update(player, false)
      assert(p.wrapper.sets == 1 and not mcm.inspect().presentation.pending, 'update ' .. change)
    end
    assert(mcm.inspect().early.shown == 5 and mcm.inspect().early.held == 0 and mcm.inspect().early.failures == 0)
    assert(#bottomActions == 15 and backs() == 5, 'every draw makes exactly one bar: ' .. #bottomActions)
  `);
});

test('a draw the early style cannot vouch for stays hidden and is styled and shown by the older pass, with Back placed once', () => {
  run(`${mcmFixture}${earlyFixture}
    assert(invoke('tab:settings').ok)
    local rows = {managed = 3, action = 1, readonly = 1}
    -- The text override does nothing on some game version: nothing is captured, the page waits for the older pass.
    local p = draw({rows = rows, plain = true, bar = {'Revert'}})
    assert(p.wrapper.visible == false and mcm.inspect().presentation.pending, 'an unverified page was shown')
    assert(mcm.inspect().early.reason:find('widgets missing', 1, true), mcm.inspect().early.reason)
    assert(backs() == 1, 'Back was not placed with the bar')
    settle()
    for i = 1, 3 do assert(p.labels[i].margin.left == 20 and p.labels[i].color == 'MainColors.Red', 'the older pass did not style row ' .. i) end
    assert(p.status.parent == p.list and backs() == 1, 'status line or Back misplaced by the older pass')
    -- The managed-row hook count disagrees with MCM's own: held.
    p = draw({rows = rows, noState = true})
    assert(p.wrapper.visible == false and mcm.inspect().early.reason:find('row hook count', 1, true), mcm.inspect().early.reason)
    settle()
    -- A draw that completes resets the count of failures in a row (three in a row switch the early style off).
    p = draw({rows = rows})
    assert(p.wrapper.visible == true and mcm.inspect().early.shown == 1 and mcm.inspect().early.failures == 0)
    -- MCM ignores the x it is given for the label: the page is not what the styling gives, held.
    p = draw({rows = rows, ignoresX = true})
    assert(p.wrapper.visible == false and mcm.inspect().early.reason == 'label geometry', mcm.inspect().early.reason)
    settle()
    assert(p.labels[1].margin.left == 20, 'the older pass left the label where MCM put it')
    -- A heading that cannot be styled: held with the reason.
    p = draw({rows = rows, categories = 1, badCategory = true})
    assert(p.wrapper.visible == false and mcm.inspect().early.reason:find('a step failed: category', 1, true), mcm.inspect().early.reason)
    settle()
    assert(mcm.inspect().early.held == 4 and mcm.inspect().early.shown == 1 and not mcm.inspect().early.off)
  `);
});

test('a page whose language needs a font of its own keeps the font pass, and that is not counted as a failure', () => {
  run(`${mcmFixture}${earlyFixture}
    assert(invoke('tab:settings').ok)
    local chosen
    for i, choice in ipairs(convaiUiLocale.choices()) do if choice.value == 'ru' then chosen = i end end
    assert(chosen, 'no Russian choice')
    -- Russian chosen but not applied yet: its text is shown only after the font pass.
    nativeApi.getValue = function() return chosen end
    for _ = 1, 4 do
      local p = draw({rows = {managed = 2, action = 1, readonly = 1}})
      assert(p.wrapper.visible == false and mcm.inspect().early.reason == 'fonts', mcm.inspect().early.reason)
      settle()
    end
    assert(mcm.inspect().early.failures == 0 and not mcm.inspect().early.off, 'font pages switched the early style off')
    nativeApi.getValue = nil
    local p = draw({rows = {managed = 2}})
    assert(p.wrapper.visible == true and mcm.inspect().early.shown == 1, 'English page was not shown again')
  `);
});

test('three draws in a row that the early style could not complete switch it off, and then the page is drawn as before', () => {
  run(`${mcmFixture}${earlyFixture}
    assert(invoke('tab:settings').ok)
    local rows = {managed = 3, action = 1}
    for _ = 1, 3 do draw({rows = rows, ignoresX = true}); settle() end
    assert(mcm.inspect().early.off == true and mcm.inspect().early.failures == 3, 'still trying after three failures')
    local before = #bottomActions
    local p = draw({rows = rows, bar = {'Revert'}})
    -- The overrides pass everything straight on now: MCM's geometry and colour, the hidden page, the held bar line as MCM made it.
    assert(p.labels[1].margin.left == 48 and p.labels[1].width == 300 and p.labels[1].color == 'native-secondary', 'a switched-off style still changed rows')
    assert(p.wrapper.visible == false and mcm.inspect().presentation.pending and #p.passed == 1, 'the older path was not used')
    settle()
    assert(p.labels[1].margin.left == 20 and p.labels[1].color == 'MainColors.Red' and backs() == 4)
  `);
});

test('every held bottom button is created: Back that cannot be placed, and a draw that never ends', () => {
  run(`${mcmFixture}${earlyFixture}
    assert(invoke('tab:settings').ok)
    -- Back cannot be placed: the held buttons are created anyway, and Back becomes a row of the page.
    local original = controller.McmUiAddBottomActionAt
    controller.McmUiAddBottomActionAt = function(self, id, ...)
      if id == 'convai-bottom-back' then error('no bar') end
      return original(self, id, ...)
    end
    local p = draw({rows = {managed = 2}, bar = {'Revert', 'Apply'}})
    assert(#bottomActions == 2 and bottomActions[1].id == 'bar1' and bottomActions[2].id == 'bar2', 'a button was lost')
    assert(mcm.inspect().backMode == 'list', 'Back was not moved to a row')
    settle()
  `);
});

test('a draw that never reaches its end still gets its held bottom buttons, where MCM put them, and the page is shown', () => {
  run(`${mcmFixture}${earlyFixture}
    assert(invoke('tab:settings').ok)
    mcm.update(player, false)
    -- The draw never reaches its end (an error in MCM): half a second later the held buttons are created where MCM put them.
    local count = #bottomActions
    local p = draw({rows = {managed = 2}, bar = {'Revert', 'Apply'}, finish = false})
    assert(#bottomActions == count, 'a button was made before the draw ended')
    mcm.update(player, false)
    assert(#bottomActions == count, 'a button was made at once')
    clock = clock + 1
    mcm.update(player, false)
    assert(#bottomActions == count + 2 and bottomActions[count + 1].id == 'bar1' and bottomActions[count + 1].x == 300
      and bottomActions[count + 2].id == 'bar2' and bottomActions[count + 2].x == 460, 'the held buttons were not made in place')
    -- The hidden content is shown by the stale-hold release.
    clock = clock + 1
    mcm.update(player, false)
    assert(p.wrapper.visible == true, 'the page stayed hidden after a draw that never ended')
  `);
});

test('a redrawn page keeps its scroll position, whether MCM lost it or never set it, and a page that was left starts at the top', () => {
  run(`${mcmFixture}${earlyFixture}
    assert(invoke('tab:settings').ok)
    local rows = {managed = 3, action = 1}
    -- MCM hands over its captured position but it does not hold on the hidden, still empty page: set again with the show.
    draw({rows = rows})
    local p = draw({rows = rows, scroll = 0.4})
    assert(p.beginScroll == 0.4 and p.wrapper.visible == true and p.scroll == 0.4 and scrolls == 1, 'position lost: ' .. tostring(p.scroll))
    -- It holds: nothing is set again.
    p = draw({rows = rows, scroll = 0.4, sticks = true})
    assert(p.scroll == 0.4 and scrolls == 1, 'a position that held was set again')
    -- MCM skipped its capture (it passes 0) but the page being replaced is at 0.6: the same page, so 0.6 is kept and MCM is told.
    scrollNow = 0.6
    p = draw({rows = rows, scroll = 0})
    assert(p.beginScroll == 0.6 and p.scroll == 0.6 and scrolls == 2, 'the old position was not carried over: ' .. tostring(p.scroll))
    -- At the top both ways: nothing to restore.
    scrollNow = 0
    p = draw({rows = rows, scroll = 0})
    assert(p.beginScroll == 0 and p.scroll == 0 and scrolls == 2)
    -- Idle frames never touch the scroll.
    mcm.update(player, false); local before = calls
    for _ = 1, 6 do mcm.update(player, false) end
    assert(calls == before and scrolls == 2)
    -- Another page of the manager: the old position is not carried over (the first draw of a page has no 'same page').
    scrollNow = 0.7
    assert(invoke('settings:back').ok)
    p = draw({rows = rows, scroll = 0})
    assert(p.beginScroll == 0 and p.scroll == 0 and scrolls == 2, 'a new page inherited the old scroll position')
    -- The page after that is the same page again.
    p = draw({rows = rows, scroll = 0})
    assert(p.scroll == 0.7 and scrolls == 3)
  `);
});

test('a page opened afresh starts at the top even when MCM hands over the position of the page it came from', () => {
  run(`${mcmFixture}${earlyFixture}
    assert(invoke('tab:settings').ok)
    local rows = {managed = 3, action = 1}
    -- The screen opens: nothing was drawn before, MCM restores the position it kept from last time.
    local p = draw({rows = rows, scroll = 0.8, sticks = true})
    assert(p.beginScroll == 0 and p.scroll == 0, 'a page opened afresh kept the old position: ' .. tostring(p.beginScroll))
    -- Scrolling in the open page, then Apply or a refresh redraws it: MCM captures the position and it is kept.
    scrollNow = 0.6
    p = draw({rows = rows, scroll = 0.6, sticks = true})
    assert(p.beginScroll == 0.6 and p.scroll == 0.6, 'a redraw of the open page jumped: ' .. tostring(p.beginScroll))
    p = draw({rows = rows, scroll = 0, sticks = true})
    assert(p.beginScroll == 0.6, 'a redraw MCM lost the position of did not keep it')
    -- A button opens another page (here Back): MCM reads the page on screen, the new page still starts at the top.
    assert(invoke('settings:back').ok)
    p = draw({rows = rows, scroll = 0.6, sticks = true})
    assert(p.beginScroll == 0 and p.scroll == 0, 'a sub-page opened from a scrolled page was scrolled: ' .. tostring(p.beginScroll))
    -- Scroll there, open the first page again: top, and a redraw afterwards keeps what was scrolled.
    scrollNow = 0.3
    assert(invoke('tab:settings').ok)
    p = draw({rows = rows, scroll = 0.3, sticks = true})
    assert(p.beginScroll == 0 and p.scroll == 0, 'coming back to a page restored its old position')
    scrollNow = 0.5
    p = draw({rows = rows, scroll = 0.5, sticks = true})
    assert(p.beginScroll == 0.5 and p.scroll == 0.5)
    -- Another mod is shown, then ours again: fresh.
    handlers.McmUiBegin(ref, 'MCM', '', 'Mods', 'Another Mod', 'Opened.', 0, '', true, true, 0, function() end)
    handlers.McmUiSetContentTitle(ref, 'Another Mod')
    p = draw({rows = rows, scroll = 0.5, sticks = true})
    assert(p.beginScroll == 0 and p.scroll == 0, 'coming back from another mod restored the old position')
    -- The Settings screen closes and opens again.
    scrollNow = 0.4
    handlers.OnUninitialize(ref)
    p = draw({rows = rows, scroll = 0.4, sticks = true})
    assert(p.beginScroll == 0 and p.scroll == 0, 'the screen opened again with the old position')
    -- Nothing runs per frame.
    mcm.update(player, false); local before = calls
    for _ = 1, 6 do mcm.update(player, false) end
    assert(calls == before)
  `);
});

test('a page held for the older pass gets its scroll position back when it is shown', () => {
  run(`${mcmFixture}${earlyFixture}
    assert(invoke('tab:settings').ok)
    local rows = {managed = 3}
    draw({rows = rows})
    scrollNow = 0.5
    local p = draw({rows = rows, scroll = 0.5, ignoresX = true})
    assert(p.wrapper.visible == false and p.scroll == 0, 'the held page was shown or scrolled early')
    settle()
    assert(p.wrapper.visible == true and p.scroll == 0.5, 'the older pass did not restore the scroll position: ' .. tostring(p.scroll))
    -- A draw that never ends: the stale-hold release restores it as well.
    local q = draw({rows = rows, scroll = 0.3, finish = false})
    clock = clock + 2
    mcm.update(player, false)
    assert(q.wrapper.visible == true and q.scroll == 0.3, 'the stale hold did not restore the scroll position')
    -- A scroll controller that fails never stops the page from being shown.
    local r = draw({rows = rows, scroll = 0.2, badScroller = true})
    assert(r.wrapper.visible == true and mcm.inspect().early.shown >= 1, 'a failing scroll controller stopped the page from being shown')
  `);
});

test('another mod page is drawn exactly as MCM draws it, with no widget work and no held button', () => {
  run(`${mcmFixture}${earlyFixture}
    assert(invoke('tab:settings').ok)
    mcm.update(player, false)
    local before = calls
    local seen
    local function record(...) seen = table.pack(...); return widget('x') end
    handlers.McmUiBegin(ref, 'MCM', '', 'Mods', 'Another Mod', 'Opened.', 0, '', true, true, 0, function()
      handlers.McmUiCreateText(ref, widget('r'), 'status', 'v', 10, 20, 200, 30, 24, 'native-blue', 0, record)
    end)
    assert(seen.n == 10 and seen[4] == 10 and seen[5] == 20 and seen[6] == 200 and seen[7] == 30 and seen[8] == 24 and seen[9] == 'native-blue', 'a foreign text was changed')
    handlers.McmUiAddManagedLabel(ref, 'x', 'L', '*', false, 0, function()
      handlers.McmUiCreateText(ref, widget('c'), 'x_managed_label', 'L', 48, 0, 300, 42, 22, 'native-secondary', 0, record)
    end)
    assert(seen[4] == 48 and seen[6] == 300 and seen[9] == 'native-secondary', 'a foreign managed label was changed')
    local passed
    handlers.McmUiAddBottomActionAt(ref, 'revert', 'Revert', 300, 1000, 140, false, function(...) passed = table.pack(...) end)
    assert(passed and passed[1] == 'revert' and passed[3] == 300, 'a foreign button was held back')
    handlers.McmUiSetContentTitle(ref, 'Another Mod')
    assert(calls == before, 'widgets were touched for another mod page')
    assert(mcm.inspect().early.shown == 0 and mcm.inspect().early.held == 0 and #bottomActions == 0)
  `);
});

test('a page that failed to style is shown, and a page the manager leaves is not left hidden', () => {
  run(`${mcmFixture}${stylingFixture}
    local clock = 10
    os.clock = function() return clock end
    ${opacityFixture}
    for index = 1, 50 do content.children[index] = widget('r' .. index .. '_managed_label', 48) end
    content.children[20].GetName = function() error('native failure') end
    open(); mcm.update(player, false)
    assert(content.opacity == 0 or content.opacity == 1)
    for _ = 1, 5 do mcm.update(player, false) end
    assert(content.opacity == 1, 'a styling error left the page hidden')
    assert(not mcm.inspect().presentation.pending)
    -- The page stops being the manager's while it is hidden (another mod is selected): the rows come back.
    for index = 1, 500 do content.children[index] = widget('s' .. index .. '_managed_label', 48) end
    open(); mcm.update(player, false)
    assert(content.opacity == 0)
    activeMod = 'another-mod:page'
    clock = clock + 2
    mcm.update(player, false); mcm.update(player, false)
    assert(content.opacity == 1, 'a page that is no longer ours stayed hidden')
  `);
});

test('a state the page does not show never draws it again, a visible change does, and a change made under pending drafts is dropped when the page was drawn since', () => {
  run(`${mcmFixture}${stylingFixture}
    local clock = 1000
    os.time = function() return clock end
    os.clock = function() return clock end
    ${opacityFixture}
    -- A drawn page is made of new widgets, which start at full opacity.
    local drawn = open
    open = function() content.opacity = 1; drawn() end
    nativeApi.reloadMod = function()
      reloads = reloads + 1; loaded = registered.loadMod('manager'); open(); return loaded
    end
    local voice = {state = 'loading', provider = 'pocket', workerBackend = 'omni', requestedProvider = 'omni',
      omniPack = {installed = false, missing = {'model'}}, updated = clock * 1000}
    jsonFixtures['voice-flicker'] = voice
    files['runtime/local-voice-state.json'] = 'voice-flicker'
    -- The Back button can be added to this page (a page that cannot take it is drawn again as a list, which is not what is tested).
    local addBottom = controller.McmUiAddBottomActionAt
    controller.McmUiAddBottomActionAt = function(self, id, label, x, y, width, active)
      addBottom(self, id, label, x, y, width, active)
      render.children[#render.children + 1] = widget('mcm_action_' .. id, 0)
    end
    local function second()
      clock = clock + 1; voice.updated = clock * 1000; mcm.update(player, false)
    end
    -- The first update of a session draws once (the interface language is read); only what follows is counted.
    mcm.update(player, false); reloads = 0
    assert(invoke('tab:settings').ok)
    open(); mcm.update(player, false)
    assert(reloads == 0, 'drawn on opening: ' .. reloads)
    -- The Settings page shows the voice status in place: loading, warming, speaking and ready never draw it again.
    for _, state in ipairs({'loading', 'warming', 'ready', 'speaking', 'ready', 'loading', 'ready'}) do
      voice.state = state; second()
      assert(reloads == 0, 'drawn after the state ' .. state)
    end
    for _ = 1, 5 do second() end
    assert(reloads == 0, 'the Settings page was drawn ' .. reloads .. ' times for voice states and for opening')
    -- What it does show: the OmniVoice pack appearing changes the voice list. The page is hidden at once, in that frame.
    voice.omniPack = {installed = true, missing = {}}; second()
    assert(reloads == 1, 'a visible change did not draw the page')
    assert(content.opacity == 0, 'the new page was shown unstyled')
    second(); second()
    assert(content.opacity == 1 and not mcm.inspect().presentation.pending, 'the new page stayed hidden')
    second(); second(); assert(reloads == 1, 'the page was drawn again for nothing')
    -- Pending drafts hold a redraw; the page that MCM draws after Apply already shows the change, so no second draw follows.
    drafts = true
    voice.omniPack = {installed = false, missing = {'model'}}; second(); second()
    assert(reloads == 1, 'a draft was discarded by a redraw')
    loaded = registered.loadMod('manager'); open()
    drafts = false
    second(); second(); second()
    assert(reloads == 1, 'a change already shown by the page drawn after Apply drew it again')
    voice.omniPack = {installed = true, missing = {}}; second()
    assert(reloads == 2, 'a later visible change was missed')
    -- Characters: the voice state is not shown, the voice in use is.
    assert(invoke('settings:back').ok, 'back'); assert(invoke('tab:characters').ok, 'characters')
    open(); second(); second()
    local before = reloads
    for _, state in ipairs({'loading', 'ready', 'speaking', 'ready'}) do voice.state = state; second() end
    assert(reloads == before, 'Characters was drawn again for a voice state')
    voice.provider = 'omni'; second()
    assert(reloads == before + 1, 'Characters did not follow the voice in use')
    -- Home shows nothing that changes by itself.
    assert(invoke('characters:back').ok, 'home')
    open(); second(); second()
    before = reloads
    voice.provider, voice.omniPack = 'pocket', {installed = false, missing = {'model'}}
    for _ = 1, 4 do second() end
    assert(reloads == before, 'Home was drawn again')
  `);
});

test('the models page follows the scan by the number of models found, not by the clock, and stops when it is finished', () => {
  run(`${mcmFixture}
    local clock = 1000
    os.time = function() return clock end
    os.clock = function() return clock end
    mcm.update(player, false); reloads = 0
    assert(invoke('tab:models').ok)
    local ticks = 0
    while not manager.snapshot(player).scan.finished and ticks < 200 do clock = clock + 1; mcm.update(player, false); ticks = ticks + 1 end
    assert(manager.snapshot(player).scan.finished, 'the scan did not finish')
    assert(reloads <= ticks + 1, 'drawn ' .. reloads .. ' times in ' .. ticks .. ' seconds')
    clock = clock + 1; mcm.update(player, false); clock = clock + 1; mcm.update(player, false)
    local settled = reloads
    for _ = 1, 8 do clock = clock + 1; mcm.update(player, false) end
    assert(reloads == settled, 'a finished scan kept drawing the page')
  `);
});

// Loading notices: a slow OmniVoice or Local AI load is one notice held on screen until its outcome replaces it (mod/notices.lua
// loading board, manager.loadStatus, mod/mcm.lua). Gameplay frames of 0.25 s; the manager reads the bridge's files as it does in
// the game. The game's warning line is a mock: `posts` is what the HUD was given as the held notice, `clears` what hid it, `shown`
// the ordinary five-second notices (the outcome lines).
const loadingFixture = `
  local clock = 1000
  os.time = function() return clock end
  os.clock = function() return clock end
  local shown, posts, clears, screen = {}, {}, 0, {'', false}
  function player:ConvaiPhoneFeedback(text) shown[#shown + 1] = text; screen = {text, true} end
  convaiNotices = (function() ${noticesSource} end)()
  convaiNotices.configure(function() return false end)
  convaiNotices.screen = {
    post = function(_, text, instant) posts[#posts + 1] = {text = text, instant = instant}; screen = {text, true}; return 'native' end,
    clear = function() clears = clears + 1; screen = {'', false} end,
    read = function() return screen[1], screen[2] end}
  local voice = {state = 'loading', provider = 'pocket', workerBackend = 'omni', requestedProvider = 'omni',
    omniPack = {installed = true, missing = {}}, updated = clock * 1000}
  jsonFixtures['voice-loading'] = voice
  files['runtime/local-voice-state.json'] = 'voice-loading'
  local function step(seconds, world)
    for _ = 1, seconds * 4 do
      clock = clock + 0.25; voice.updated = clock * 1000
      manager.update(player, 0.25)
      mcm.update(player, world ~= false)
    end
  end
  mcm.update(player, true)
`;

test('OmniVoice loading is one notice after 1.5 s that stays until one ready line replaces it; a quick load says nothing', () => {
  run(`${mcmFixture}${loadingFixture}
    step(1); assert(#posts == 0 and #shown == 0, 'a notice before the load had lasted 1.5 s: ' .. tostring(shown[1]))
    step(1.5)
    assert(#posts == 1 and posts[1].text == 'Loading the OmniVoice voice…' and not posts[1].instant, tostring(posts[1] and posts[1].text))
    step(60)
    assert(#posts == 1 and #shown == 0 and clears == 0, 'the notice was posted again or something else was shown: ' .. #posts)
    -- warming and speaking are per-character work, not a load
    voice.state = 'ready'; step(1)
    assert(#shown == 1 and shown[1] == 'OmniVoice voice is ready.', tostring(shown[1]))
    assert(#posts == 1 and clears == 0, 'the ready line replaces the notice')
    voice.state = 'warming'; step(10); voice.state = 'speaking'; step(10); voice.state = 'ready'; step(10)
    assert(#shown == 1 and #posts == 1, 'a per-character preparation was announced')
    -- A load that ends before the loading line is due is silent.
    shown, posts = {}, {}
    voice.state = 'loading'; step(1); voice.state = 'ready'; step(10)
    assert(#shown == 0 and #posts == 0, 'a one-second load was announced')
  `);
});

test('a voice load that fails says what to do once, unless a fallback voice has its own notice', () => {
  run(`${mcmFixture}${loadingFixture}
    step(4); assert(#posts == 1)
    voice.state = 'error'; step(2)
    assert(shown[#shown] == 'OmniVoice could not load. See Help in Settings.', tostring(shown[#shown]))
    local count = #shown
    step(30); assert(#shown == count and #posts == 1, 'the failure repeated')
    -- With a fallback the bridge's own fallback notice speaks; the loading notice just comes down.
    voice.state = 'loading'; step(4)
    local before, hidden = #shown, clears
    voice.state = 'error'; voice.fallback = {from = 'omni', to = 'pocket'}; step(20)
    for index = before + 1, #shown do assert(shown[index] ~= 'OmniVoice could not load. See Help in Settings.', 'doubled the fallback notice') end
    assert(screen[1] ~= 'Loading the OmniVoice voice…', 'the loading notice stayed up after the load ended')
    -- Switching to another voice mid-load cancels it silently and takes the notice down.
    voice.fallback = nil; voice.state = 'loading'; voice.requestedProvider = 'omni'; step(4)
    local seen, posted = #shown, #posts
    hidden = clears
    voice.requestedProvider = 'pocket'; voice.workerBackend = 'omni'; step(20)
    assert(#shown == seen and #posts == posted, 'a load nobody wants anymore was announced')
    assert(clears == hidden + 1, 'a cancelled load left its notice up')
  `);
});

test('the Pocket voice load is announced the same way and a load in a menu is announced when gameplay returns', () => {
  run(`${mcmFixture}${loadingFixture}
    voice.workerBackend, voice.requestedProvider = 'pocket', 'pocket'
    step(4); assert(posts[#posts].text == 'Loading the Pocket voice…', tostring(posts[#posts] and posts[#posts].text))
    -- A menu opens mid-load: nothing is posted there, and the notice is posted again, instantly, when gameplay is back.
    local held = #posts
    step(10, false); assert(#posts == held and #shown == 0, 'a popup was posted from a menu')
    step(1); assert(#posts == held + 1 and posts[#posts].instant == true, 'the notice did not return after the menu')
    -- The load ends while a menu is open: no popup there, one line when gameplay is back.
    local before = #shown
    voice.state = 'ready'; step(10, false)
    assert(#shown == before, 'a popup was posted from a menu')
    step(1)
    assert(#shown == before + 1 and shown[#shown] == 'Pocket voice is ready.', tostring(shown[#shown]))
  `);
});

test('Local AI warming up is one held notice while Local is the provider, with a ready line, and its state is not read otherwise', () => {
  run(`${mcmFixture}${loadingFixture}
    voice.state = 'ready'
    activeMod = nil   -- the settings page is not open: only the loading board reads anything
    local reads = 0
    local open = io.open
    io.open = function(path, mode) if path == 'runtime/mistral-state.json' then reads = reads + 1 end return open(path, mode) end
    local mistral = {provider = 'local', effective = 'local', localAi = 'warming'}
    jsonFixtures['mistral-loading'] = mistral
    files['runtime/mistral-state.json'] = 'mistral-loading'
    -- Convai is the provider: Local AI is not read at all.
    step(10)
    assert(reads == 0, 'mistral-state.json was read while Local was not the provider: ' .. reads)
    local applied, why = manager.applySettings(player, {conversationProvider = 'local'}); assert(applied, tostring(why))
    -- Idle, the state is looked at once a second; then the load must last 1.5 s.
    step(3)
    assert(#posts == 1 and posts[1].text == 'Local AI is warming up…', tostring(posts[#posts] and posts[#posts].text))
    step(30); assert(#posts == 1 and #shown == 0, 'the notice was posted again')
    mistral.localAi = 'ready'; step(2)
    assert(shown[#shown] == 'Local AI is ready.', tostring(shown[#shown]))
    local count = #shown
    step(20); assert(#shown == count and #posts == 1)
    -- A server that was unloaded after idle time warms up again when it is needed.
    mistral.localAi = 'warming'; step(3); assert(posts[#posts].text == 'Local AI is warming up…' and #posts == 2)
    mistral.localAi = 'no-memory'; step(2)
    assert(shown[#shown] == 'Not enough graphics memory for Local AI. A cloud provider is used instead.', tostring(shown[#shown]))
    mistral.localAi = 'warming'; step(3); mistral.localAi = 'failed'; step(2)
    assert(shown[#shown] == 'Local AI could not start. Check Local AI in Settings > Conversation provider.', tostring(shown[#shown]))
  `);
});

test('OmniVoice and Local AI loading together are one notice with a line each', () => {
  run(`${mcmFixture}${loadingFixture}
    activeMod = nil
    local mistral = {provider = 'local', effective = 'local', localAi = 'warming'}
    jsonFixtures['mistral-loading'] = mistral
    files['runtime/mistral-state.json'] = 'mistral-loading'
    local applied, why = manager.applySettings(player, {conversationProvider = 'local'}); assert(applied, tostring(why))
    step(6)
    local last = posts[#posts]
    assert(last.text:find('Loading the OmniVoice voice…', 1, true) and last.text:find('Local AI is warming up…', 1, true),
      'both loads were not listed: ' .. last.text)
    local count = #posts
    step(40); assert(#posts == count and #shown == 0, 'the notice was posted again')
    voice.state, mistral.localAi = 'ready', 'ready'; step(2)
    assert(#shown == 1 and shown[1]:find('OmniVoice voice is ready.', 1, true) and shown[1]:find('Local AI is ready.', 1, true), tostring(shown[1]))
  `);
});

// A companion still being prepared is a line of the same held notice: "Preparing {name}: waiting for ...", naming the step that
// blocks her, following it as it changes, listing every companion waiting, and down only once she has spawned (or failed, which
// is a notice of its own). Nothing is posted per frame: the board is read on the manager's 0.25 s tick.
test('a companion that is still preparing is one held notice line naming what she waits for, until she has spawned', () => {
  run(`${mcmFixture}${invitationFixture}${loadingFixture}
    voice.state = 'ready'
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    readiness.receipts['queued:1'] = {state = 'memory', wait = 'bridge'}
    step(1); assert(#posts == 0 and #shown == 0, 'a notice before the wait had lasted 1.5 s: ' .. tostring(posts[1] and posts[1].text))
    step(1.5)
    assert(#posts == 1 and posts[1].text == 'Preparing Johnny Silverhand: waiting for the conversation service to connect…'
        and not posts[1].instant, tostring(posts[1] and posts[1].text))
    step(30); assert(#posts == 1 and #shown == 0 and clears == 0, 'the held notice was posted again or hidden: ' .. #posts)
    -- The step changes: the same notice is updated in place, instantly.
    readiness.receipts['queued:1'] = {state = 'memory', wait = 'voice'}; step(1)
    assert(#posts == 2 and posts[2].instant == true and posts[2].text == 'Preparing Johnny Silverhand: waiting for the voice model to load…',
      tostring(posts[#posts].text))
    readiness.receipts['queued:1'] = {state = 'connecting', wait = 'connection'}; step(1)
    assert(#posts == 3 and posts[3].text == 'Preparing Johnny Silverhand: waiting for the conversation connection to open…', posts[#posts].text)
    -- A second request while the first is preparing: both names, the first line unchanged.
    assert(invoke('invite:person-1').ok)
    readiness.receipts['queued:2'] = {state = 'memory', wait = 'memory'}; step(1)
    assert(#posts == 3, 'the second line showed before it had lasted 1.5 s')
    step(1.5)
    assert(#posts == 4 and posts[4].text == 'Preparing Johnny Silverhand: waiting for the conversation connection to open…\\n'
        .. 'Preparing Person 01: waiting for the memory service…', posts[#posts].text)
    -- The first one is ready and spawns; its line goes, hers stays. The held notice never lapses in between.
    readiness.receipts['queued:1'] = {state = 'ready'}; step(1)
    assert(#spawned == 1)
    members[1].state = 'ready'; step(1)
    assert(posts[#posts].text:find('Preparing Person 01', 1, true) and not posts[#posts].text:find('Johnny', 1, true), posts[#posts].text)
    -- Her joined line waits up to 4 s for the other companion of the burst, then shows on its own.
    step(5)
    assert(shown[#shown] == 'Johnny Silverhand joined your group.', tostring(shown[#shown]))
    -- She fails: the notice comes down and her failure is its own notice, naming what failed and what to do.
    shown = {}
    readiness.receipts['queued:2'] = {state = 'error', error = 'Bridge text', kind = 'voice'}; step(1)
    -- (The board merges it with the earlier joined line of the same burst, as it always has.)
    assert(shown[#shown]:find('Person 01 could not prepare: The voice model did not load. Check the voice in Settings or choose another one, then invite again.', 1, true),
      tostring(shown[#shown]))
    step(30)
    assert(screen[1] ~= 'Preparing Person 01: waiting for the memory service…', 'the wait stayed up after the failure: ' .. tostring(screen[1]))
  `);
});

test('a companion that is ready before the wait notice is due shows nothing, and the wait notice is never put on screen from a menu', () => {
  run(`${mcmFixture}${invitationFixture}${loadingFixture}
    voice.state = 'ready'
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    readiness.receipts['queued:1'] = {state = 'memory', wait = 'memory'}
    step(1)
    readiness.receipts['queued:1'] = {state = 'ready'}; step(1)
    members[1].state = 'ready'; step(10)
    assert(#posts == 0 and #shown == 1 and shown[1] == 'Johnny Silverhand joined your group.', 'a quick preparation announced a wait: ' .. tostring(posts[1] and posts[1].text))
    shown = {}
    assert(invoke('invite:person-1').ok)
    readiness.receipts['queued:2'] = {state = 'memory', wait = 'voice'}
    step(10, false)
    assert(#posts == 0 and #shown == 0, 'a popup was posted from a menu')
    step(1)
    assert(#posts == 1 and posts[1].text == 'Preparing Person 01: waiting for the voice model to load…', tostring(posts[1] and posts[1].text))
  `);
});

test('a slow component and a preparing companion share the one held notice', () => {
  run(`${mcmFixture}${invitationFixture}${loadingFixture}
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    readiness.receipts['queued:1'] = {state = 'memory', wait = 'voice'}
    step(3)
    assert(#posts == 1 and posts[1].text == 'Loading the OmniVoice voice…\\nPreparing Johnny Silverhand: waiting for the voice model to load…', posts[#posts].text)
    -- The voice finishes: its ready line is its own notice; the companion's wait goes on in the held one.
    voice.state = 'ready'; step(1)
    assert(shown[#shown] == 'OmniVoice voice is ready.', tostring(shown[#shown]))
    step(6)
    assert(posts[#posts].text == 'Preparing Johnny Silverhand: waiting for the voice model to load…', posts[#posts].text)
  `);
});

test('with nothing loading the loading status is read about once a second and costs no notice work, and a new session forgets old loads', () => {
  run(`${mcmFixture}${loadingFixture}
    voice.state = 'ready'
    local calls = 0
    local status = manager.loadStatus
    manager.loadStatus = function() calls = calls + 1; return status() end
    step(20)
    assert(calls >= 18 and calls <= 22, 'read ' .. calls .. ' times in 20 s')
    assert(#shown == 0 and #posts == 0)
    voice.state = 'loading'; step(4)
    assert(#posts >= 1)
    mcm.resetSession()
    voice.state = 'ready'; shown = {}
    step(10); assert(#shown == 0, 'an old session announced its outcome: ' .. tostring(shown[1]))
  `);
});

test('the developer notice trigger shows the daily-limit notice only with Developer mode on, only for a notice request, and never per frame', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
  const textStart = init.indexOf('local function dailyLimitText'), textEnd = init.indexOf('local function keyNoticeText');
  const start = init.indexOf('speech.devNotice = function'), end = init.indexOf('local function groupAudience');
  assert(textStart > 0 && textEnd > textStart && start > 0 && end > start, 'the developer notice code moved');
  // The poll in onUpdate hands "notice:" requests to speech.devNotice, "johnny-probe:" requests to the Johnny probes and everything else
  // to the diagnostic capture, once per new request.
  assert.match(init, /if nonce:find\('\^notice:'\) then pcall\(speech\.devNotice, nonce\)\s+elseif nonce:find\('\^johnny%-probe:'\) then pcall\(convaiJohnnyProbeRun, nonce\)\s+else captureDiagnostic\(\) end/);
  const devNoticeBody = init.slice(start, end);
  assert(!/onUpdate|registerForEvent/.test(devNoticeBody), 'no event hook of its own: it adds no per-frame work');
  run(`
    local ui = {t = function(text) return text end}
    local sent, logged, developer, player = {}, {}, false, {}
    local manager = {developerMode = function() return developer end}
    local convaiNotices = {send = function(who, id, text) sent[#sent + 1] = {id = id, text = text}; return true end}
    local Game = {GetPlayer = function() return player end}
    local function log(message) logged[#logged + 1] = message end
    local speech = {}
    ${init.slice(textStart, textEnd)}
    ${devNoticeBody}
    assert(speech.devNotice('notice:daily-limit:123') == false and #sent == 0, 'inert while Developer mode is off')
    developer = true
    assert(select(1, speech.devNotice('notice:daily-limit:123')) == true and #sent == 1)
    assert(sent[1].id == 'daily-limit' and sent[1].text == dailyLimitText(), 'the same text a failed reply shows')
    assert(speech.devNotice('notice:unknown:1') == false and speech.devNotice('daily-limit') == false and speech.devNotice(nil) == false and #sent == 1)
    player = nil
    assert(speech.devNotice('notice:daily-limit:2') == false and #sent == 1, 'no player yet: nothing is shown')
  `);
});
