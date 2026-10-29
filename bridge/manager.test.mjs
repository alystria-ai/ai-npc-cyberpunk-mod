import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import fengari from 'fengari';
import {optionUnits} from './option-units.mjs';
import {MistralProvider, MistralControl} from './mistral-key.mjs';
import {createLocalSpeech} from './local-stt-capture.mjs';
import {companionModules, companionEngine, flatNavigation, flatSpatial} from './companion-fixture.mjs';
import {run, nsuiHarness, source as moduleSource, storage, managerFixture, nsuiFixture, queueSource, coreSource, hostSource, voicePreviewSource, fontsSource} from './manager-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const managerSource = readFileSync(new URL('../mod/manager.lua', import.meta.url), 'utf8');
const companionsSource = readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8');
const noticesSource = readFileSync(new URL('../mod/notices.lua', import.meta.url), 'utf8');
const entrySource = readFileSync(new URL('../mod/nsui-entry.lua', import.meta.url), 'utf8');
const frenchUiSource = readFileSync(new URL('../mod/locales/fr.lua', import.meta.url), 'utf8');

// Night City Allies' Lucy (docs/NCA_FOLLOWERS_PLAN.md): the roster records only let the talk path recognise that mod's copy.
// invite = false keeps her out of every invite (Manager "Profile only", the manager unavailable, the party queue refuses). Rita has
// been invitable since 2026-10-25.
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

test('Manager party invitations reserve distinct copies, cancel without spawning and flush only once', () => {
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

test('Manager dismissals free planned places, can be undone at any party size and cleanly report world failures', () => {
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
    -- The refused spawn is reported once and the invitation leaves the list: it is no copy, and must not look pending forever.
    assert(#queue.list() == 8 and queue.count() == 8 and queue.message():find('could not create', 1, true))
    queue.flush(); assert(#spawned == 9, 'failed request must not retry every frame')
    api.spawn = oldSpawn
    api.dismiss = oldDismiss
    queue.bind(nil); assert(#queue.list() == 8, 'loading a save cancels pending work')
  `);
});

test('Manager settings apply as one saved transaction and leave playback unchanged on a save failure', () => {
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
      -- Custom keeps it (it takes the layer too); Mistral and Convai never do (owner decision 2026-10-20): a save that puts either beside it turns it off, quietly, with a reload.
      assert(manager.applySettings(player, {matureContent = true}) and saved.matureContent == true)
      local _, _, _, providerReload = manager.applySettings(player, {conversationProvider = 'mistral'})
      assert(saved.conversationProvider == 'mistral' and saved.matureContent == false and providerReload == true, 'Mistral turns it off')
      assert(manager.applySettings(player, {matureContent = true}) and saved.matureContent == false, 'and it cannot be turned on beside Mistral')
      assert(manager.applySettings(player, {conversationProvider = 'custom'}) and saved.conversationProvider == 'custom' and saved.matureContent == false)
      assert(manager.applySettings(player, {matureContent = true}) and saved.matureContent == true, 'Custom takes it')
      assert(manager.applySettings(player, {matureContent = true, conversationProvider = 'local'}) and saved.matureContent == true)
      _, _, _, providerReload = manager.applySettings(player, {conversationProvider = 'convai'})
      assert(saved.matureContent == false and providerReload == true)
      assert(manager.applySettings(player, {conversationProvider = 'local'}) and saved.matureContent == false, 'Local alone does not turn it back on')
      os.clock = realClock
    end
    assert(manager.battleReactions() and manager.snapshot(player).settings.battleReactions == true, 'battle reactions default on')
    assert(manager.lootReactions() and manager.snapshot(player).settings.lootReactions == true, 'loot reactions default on')
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
    assert(saved.expressiveEmotions == nil, 'a retired key an old caller passes is accepted and not saved')
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
        voiceProvider = 'convai', omniSteps = 16, battleReactions = false, battleReactionsChosen = true, lootReactions = false, lootReactionsChosen = true,
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
    assert(heights[3]==0 and strengths[3]==1,'the page mutated domain choices')
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
    assert(next(one.looks)==oldOne and next(two.looks)==oldTwo,'the manager touched native actors in its callback')
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
        omniSteps = 16, battleReactions = false, battleReactionsChosen = true, lootReactions = false, lootReactionsChosen = true,
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

test('Manager waits for NPC attachment, reports late failures once and discards notices on save change', () => {
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


test('Current party has no drive initiation and defers active-trip stopping until gameplay resumes', () => {
  run(`${nsuiFixture}
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
    assert(managerUi.party().drive==nil and managerUi.party().cancelDrive==nil)
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
    Game.GetPlayer=originalPlayer;managerUi.update(player,false);assert(nativeCalls==0)
    paused=false;managerUi.update(player,true);assert(nativeCalls==1 and trip.phase=='stopping')
    assert(invoke('party:back').ok and not row('chauffeur:stop'))
  `);
});

test('manager home owns the five destinations and every inner page has one parent Back action at the top', () => {
  run(`${nsuiFixture}
    local function category(id)
      for _, item in ipairs(loaded.categories) do if item.id == id then return item end end
    end
    -- Every page starts with the navigation section: on an inner page it is the way back and nothing else (no destinations).
    local function inner(expected, back)
      assert(managerUi.inspect().view == expected)
      assert(loaded.categories[1].id == 'navigation', 'the way back is not the first section')
      local first = loaded.categories[1].settings
      assert(#first == 1 and first[1].id == back and first[1].value == 'Back', 'the first row of ' .. expected .. ' is not its Back')
      for _, name in ipairs({'characters', 'party', 'models', 'bonds', 'key-bindings', 'settings'}) do
        assert(not row('tab:' .. name), 'a root destination leaked onto an inner page')
      end
      local count = 0
      for _, section in ipairs(loaded.categories) do
        assert(#section.settings > 0, 'an empty section is left on the page')
        for _, item in ipairs(section.settings) do
          if item.value == 'Back' then count = count + 1 end
          assert(item.label:sub(1, 1) ~= ' ' and item.indent == nil, 'label has artificial indentation')
        end
      end
      assert(count == 1, 'a page has exactly one Back')
      assert(not row('apply-hint'), 'a status row is on the page')
      assert(not category('party-status') and not row('party-count') and not row('feedback'),
        'party status, the limit or the last action leaked onto the page')
    end
    assert(managerUi.inspect().view == 'home' and #loaded.categories == 1)
    assert(#category('navigation').settings == 6 and not row('party-count'))
    for _, name in ipairs({'characters', 'party', 'models', 'bonds', 'key-bindings', 'settings'}) do
      local destination = row('tab:' .. name)
      assert(destination and destination.value == 'Open' and not destination.disabled)
      assert(invoke(destination.id).ok)
      inner(name, name .. ':back')
      assert(not invoke(destination.id).ok, 'stale destination actions remained callable')
      assert(invoke(name .. ':back').ok and managerUi.inspect().view == 'home')
    end
    assert(invoke('tab:settings').ok)
    assert(not row('permissions'), 'Who can talk is gone from the Settings page')
    assert(not invoke('permissions').ok and managerUi.inspect().view == 'settings', 'the removed permissions page stayed callable')
    -- Relationships is a page that opens from Conversations (a button beside Memory), with one Back to Settings.
    local open = row('relationships')
    assert(open and open.type == 'action' and open.value == 'Open' and not open.disabled and not row('relationship:judy-alvarez'))
    assert(invoke('relationships').ok)
    inner('relationships', 'relationships:back')
    assert(row('relationship:judy-alvarez') and not row('relationships') and not row('archetypeConversations'))
    assert(invoke('relationships:back').ok and managerUi.inspect().view == 'settings' and not row('relationship:judy-alvarez'))
    assert(invoke('memory').ok)
    inner('memory', 'memory:settings')
    assert(not row('memory:choose') and row('memory-selected'), 'the memory picker is part of the Memory page')
    assert(invoke('memory:settings').ok and managerUi.inspect().view == 'settings')
    assert(invoke('settings:back').ok)
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

test('interface language persists atomically, localizes the schema and preserves literal character names and voice choices',()=>{
  run(`${nsuiFixture}
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
    assert(loaded.categories[1].settings[1].label=='Retour au gestionnaire')
    assert(row('uiLanguage').label~='Interface language' and row('uiLanguage').value==french)
    assert(row('uiLanguage').elements[2]=='English','language names must remain natively recognizable')
    local snapshot=manager.snapshot(player)
    assert(snapshot.settings.voiceProvider==voiceBefore and snapshot.settings.omniSteps==stepsBefore)
    assert(invoke('settings:back').ok and row('tab:settings').label=='Paramètres')
    assert(invoke('tab:characters').ok)
    -- The renamed profile is the last of 22 in the list: the second of two pages.
    assert(core.setUi('ui:page', 2)); loaded=registered.loadMod('manager')
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

test('the Voice language row: English by default, then Automatic and the mod languages; it saves, survives a reload and refuses what is not listed',()=>{
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    local language=row('replyLanguage')
    assert(language and language.type=='select' and language.value==1 and language.defaultValue==1, 'English is the default')
    local expected={'English','Automatic','German','French','Spanish','Italian','Portuguese','Polish','Russian','Ukrainian','Turkish','Czech','Hungarian','Japanese','Korean','Chinese'}
    assert(#language.elements==#expected)
    for i,name in ipairs(expected) do assert(language.elements[i]==name, i..' '..tostring(language.elements[i])) end
    assert(manager.snapshot(player).settings.replyLanguage=='en')
    -- It sits in Voices, right after the companion voice: shown with Companion voices Off as well, its description says it only counts while voices are on.
    assert(language.description:find('Counts only while Companion voices is not Off',1,true))
    assert(registered.applyBatch('manager',{{id='replyLanguage',value=2}}).ok)
    assert(saved.replyLanguage=='auto')
    assert(registered.applyBatch('manager',{{id='replyLanguage',value=14}}).ok)
    assert(saved.replyLanguage=='ja')
    loaded=registered.loadMod('manager')
    assert(row('replyLanguage').value==14, 'the saved choice is the one shown')
    assert(registered.applyBatch('manager',{{id='voiceProvider',value=1}}).ok and saved.voice==false)
    assert(row('replyLanguage') and saved.replyLanguage=='ja', 'the choice stays while voices are off')
    assert(not registered.applyBatch('manager',{{id='replyLanguage',value=99}}).ok and saved.replyLanguage=='ja')
    assert(not manager.applySettings(player,{replyLanguage='klingon'}) and not manager.applySettings(player,{replyLanguage=3}))
    assert(manager.snapshot(player).settings.replyLanguage=='ja')
    assert(manager.applySettings(player,{replyLanguage='en'}) and saved.replyLanguage=='en')
  `);
});

test('the Voice language choices are the bridge\'s, in the same order', async () => {
  const {REPLY_LANGUAGES} = await import('./multilingual.mjs');
  const lua = readFileSync(new URL('../mod/manager.lua', import.meta.url), 'utf8');
  const list = [...lua.match(/local replyLanguages = \{([^}]*)\}/)[1].matchAll(/'([a-z-]+)'/g)].map(match => match[1]);
  assert.deepEqual(list, [...REPLY_LANGUAGES]);
  const ui = readFileSync(new URL('../mod/manager-ui.lua', import.meta.url), 'utf8');
  for (const code of list) assert.match(ui, new RegExp(`\\b${code} = '[A-Z][a-z]+'`), `${code} has a name in REPLY_LANGUAGE_NAMES`);
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
  managerUi.shutdown()
  local queueFactory = (function() ${queueSource} end)()
  managerUi.configure(manager, api, {new = function(companions, preparation, options)
    assert(companions == api and preparation == readiness, 'the manager dropped the invitation readiness argument')
    assert(type(options.developerMode) == 'function', 'the manager dropped the cached developer predicate')
    return queueFactory.new(companions, preparation, options)
  end}, readiness)
  managerUi.install()
  loaded = registered.loadMod('manager')
  local party = assert(managerUi.party())
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
  run(`${nsuiFixture}${invitationFixture}
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
    managerUi.update(player, worldReady == true)
  end
  -- What a companion waits for is the loading notice's line (the real clock is not this fixture's, so the loading notice
  -- does not show here; the 'preparing notice' tests below drive it). No ordinary popup carries a preparing line.
  local function developer(enabled)
    assert(registered.applyBatch('manager', {{id = 'developerMode', value = enabled == true}}).ok)
  end
`;

test('with Developer mode on, a manager invitation posts no ordinary notice while it prepares, then joined, and no joining step', () => {
  run(`${nsuiFixture}${invitationFixture}${managerPopupFixture}
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
  run(`${nsuiFixture}${invitationFixture}${managerPopupFixture}
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
  run(`${nsuiFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    popupTick(false)
    readiness.receipts['queued:1'] = {state = 'connecting'}
    -- Resume inside the same clock second: do not reuse the paused memory sample.
    managerUi.update(player, true)
    assert(#popups == 0, 'gameplay presented a preparing popup: ' .. tostring(popups[#popups]))
    popupTick(true); assert(#popups == 0)
    assert(invoke('characters:back').ok and invoke('tab:settings').ok and invoke('memory').ok)
    assert(invoke('memory:select:johnny-silverhand').ok)
    readiness.receipts['queued:1'] = {state = 'error', error = 'Private detail'}; popupTick(false)
    assert(#popups == 0, 'the paused menu consumed the failure notice')
    popupTick(true)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand could not prepare: Private detail',
      'an unrelated footer action disabled the in-world notification')
    -- The failure notice said it: the failed invitation is no longer listed as a pending one.
    assert(party.count() == 0 and not party.dismiss('queued:1')); popupTick(true)
    assert(#popups == 1, 'cancelled progress replayed on returning to gameplay')
    assert(party.invite('person-1')); popupTick(false)
    readiness.receipts['queued:2'] = {state = 'connecting'}; popupTick(false)
    assert(#popups == 1, 'manager added popups for a phone-owned invitation')
  `);
});

test('duplicate manager copies post no preparing popup, and a world reset leaves nothing behind', () => {
  run(`${nsuiFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok); popupTick(false)
    assert(invoke('invite:johnny-silverhand').ok); popupTick(false)
    assert(#popups == 0, 'a copy posted a preparing popup: ' .. tostring(popups[1]))
    assert(party.dismiss('queued:2')); popupTick(false)
    -- The older copy is still in flight: its later stages are not posted.
    readiness.receipts['queued:1'] = {state = 'connecting'}; popupTick(false)
    assert(#popups == 0, 'the older copy posted progress: ' .. tostring(popups[#popups]))
    managerUi.resetSession(); popupTick(true)
    assert(#popups == 0 and #spawned == 0, 'world reset retained a stale popup or invitation')
  `);
});

test('Talk to story characters is off by default, offered under Conversations and saved with the settings', () => {
  run(`${nsuiFixture}
    assert(manager.storyConversations() == false and manager.snapshot(player).settings.storyConversations == false, 'a missing key is off')
    assert(invoke('tab:settings').ok)
    local story = assert(row('storyConversations'), 'the setting is not offered')
    assert(story.type == 'bool' and story.value == false and story.defaultValue == false)
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

test('Voice activation is off by default, offered under Voices, saved with the settings, and only a boolean is accepted', () => {
  run(`${nsuiFixture}
    assert(manager.voiceActivation() == false and manager.snapshot(player).settings.voiceActivation == false, 'a missing key is off')
    assert(invoke('tab:settings').ok)
    local setting = assert(row('voiceActivation'), 'the setting is not offered')
    assert(setting.type == 'bool' and setting.value == false and setting.defaultValue == false)
    assert(setting.label == 'Voice activation')
    local voices
    for _, category in ipairs(loaded.categories) do if category.id == 'voices' then voices = category end end
    local found = false
    for _, item in ipairs(voices.settings) do if item.id == 'voiceActivation' then found = true end end
    assert(found, 'the setting is not in the Voices section')
    assert(saved.voiceActivation == false, 'a new install saves the default Off')
    assert(registered.applyBatch('manager', {{id = 'voiceActivation', value = true}}).ok and manager.voiceActivation() == true and saved.voiceActivation == true, 'an explicit On is kept')
    loaded = registered.loadMod('manager'); assert(row('voiceActivation').value == true)
    assert(registered.applyBatch('manager', {{id = 'voiceActivation', value = false}}).ok)
    assert(manager.voiceActivation() == false and saved.voiceActivation == false, 'an explicit Off is kept')
    loaded = registered.loadMod('manager'); assert(row('voiceActivation').value == false)
    assert(not manager.applySettings(player, {voiceActivation = 'yes'}) and manager.voiceActivation() == false)
    assert(manager.storyConversations() == false, 'the neighbouring setting is not disturbed')
  `);
});

test('Johnny in your head and Johnny speaks up are one select row: Off by default, five entries mapped onto the two stored settings both ways, and no standing row', () => {
  run(`${nsuiFixture}
    assert(manager.johnnyInHead() == false and manager.snapshot(player).settings.johnnyInHead == false, 'a missing key is off')
    assert(manager.johnnyRemarks() == 'off' and manager.snapshot(player).settings.johnnyRemarks == 'off')
    assert(saved.johnnyInHead == false and saved.johnnyRemarks == 'off', 'a new install saves the default Off')
    assert(invoke('tab:settings').ok)
    local johnny = assert(row('johnnyInHead'), 'the setting is not offered')
    assert(johnny.type == 'select' and johnny.value == 1 and johnny.defaultValue == 1 and johnny.label == 'Johnny in your head')
    assert(#johnny.elements == 5 and johnny.elements[1] == 'Off' and johnny.elements[2] == 'On'
      and johnny.elements[3] == 'Speaks up rarely' and johnny.elements[4] == 'Speaks up normally' and johnny.elements[5] == 'Speaks up often', 'five entries')
    assert(row('johnnyRemarks') == nil and row('johnnyStanding') == nil, 'no second row and no standing row')
    local conversations, ids = nil, {}
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings) do
        ids[item.id] = true
        if item.id == 'johnnyInHead' then conversations = category end
      end
    end
    assert(conversations and conversations.id == 'conversation-controls', 'in Conversations')
    assert(not ids.johnnyStanding and not ids.johnnyRemarks)
    -- Apply: 1 Off (not in his head, no remarks), 2 On (no remarks), 3 rare, 4 medium (Normally), 5 normal (Often, the name it has always had in the file).
    local cases = {{1, false, 'off'}, {2, true, 'off'}, {3, true, 'rare'}, {4, true, 'medium'}, {5, true, 'normal'}}
    for _, case in ipairs({cases[5], cases[4], cases[2], cases[3], cases[1], cases[3]}) do
      assert(registered.applyBatch('manager', {{id = 'johnnyInHead', value = case[1]}}).ok, case[1])
      assert(manager.johnnyInHead() == case[2] and manager.johnnyRemarks() == case[3], case[1])
      assert(saved.johnnyInHead == case[2] and saved.johnnyRemarks == case[3], case[1])
      local state = manager.snapshot(player).settings
      assert(state.johnnyInHead == case[2] and state.johnnyRemarks == case[3], case[1])
      loaded = registered.loadMod('manager'); assert(row('johnnyInHead').value == case[1], case[1])
    end
    -- Only the five positions are accepted; the apply key johnnyRemarks is gone from the page.
    for _, invalid in ipairs({0, 6, 2.5, '2', true, false}) do
      assert(not registered.applyBatch('manager', {{id = 'johnnyInHead', value = invalid}}).ok, tostring(invalid))
      assert(manager.johnnyRemarks() == 'rare' and manager.johnnyInHead() == true)
    end
    assert(registered.applyBatch('manager', {{id = 'johnnyRemarks', value = 2}}).error == 'That setting is read-only.')
    assert(not manager.applySettings(player, {johnnyInHead = 'yes'}) and manager.johnnyInHead() == true)
    assert(not manager.applySettings(player, {johnnyRemarks = 'often'}) and manager.johnnyRemarks() == 'rare')
    assert(manager.storyConversations() == false, 'the neighbouring setting is not disturbed')
    -- Restore defaults puts the row back to Off.
    local changes = core.defaults()
    local back
    for _, change in ipairs(changes) do if change.id == 'johnnyInHead' then back = change.value end end
    assert(back == 1, tostring(back))
    assert(registered.applyBatch('manager', changes).ok)
    assert(manager.johnnyInHead() == false and manager.johnnyRemarks() == 'off')
  `);
});

test('Johnny in your head: a saved file maps to the row at load (false with remarks is Off, true with none is On, true with rare is 3, true with medium is 4, true with normal is 5) and the remarks of an Off are put to off once', () => {
  run(`${managerFixture}
    -- A case is {saved johnnyInHead, saved johnnyRemarks, loaded johnnyInHead, loaded johnnyRemarks, row position}.
    for _, case in ipairs({{false, 'rare', false, 'off', 1}, {false, 'normal', false, 'off', 1}, {false, 'off', false, 'off', 1},
        {true, 'off', true, 'off', 2}, {true, 'rare', true, 'rare', 3}, {true, 'medium', true, 'medium', 4}, {true, 'normal', true, 'normal', 5},
        {true, 'sometimes', true, 'off', 2}, {'yes', 'rare', false, 'off', 1}}) do
      seed = {version = 2, voiceProvider = 'pocket', johnnyInHead = case[1], johnnyRemarks = case[2], enabledByKey = {}, future = {keep = 'unchanged'}}
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      local label = tostring(case[1]) .. '/' .. tostring(case[2])
      assert(manager.johnnyInHead() == case[3] and manager.johnnyRemarks() == case[4], label)
      assert(saved.johnnyInHead == case[3] and saved.johnnyRemarks == case[4] and saved.future.keep == 'unchanged', label)
    end
  `);
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    for _, case in ipairs({{false, 'rare', 1}, {true, 'off', 2}, {true, 'rare', 3}, {true, 'medium', 4}, {true, 'normal', 5}}) do
      seed = {version = 2, voiceProvider = 'pocket', johnnyInHead = case[1], johnnyRemarks = case[2], enabledByKey = {}}
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      loaded = registered.loadMod('manager')
      assert(row('johnnyInHead').value == case[3], tostring(case[1]) .. '/' .. case[2])
    end
  `);
});
test('Companions speak up is one select row, Often by default: four entries (Off, Rarely, Normally, Often) stored as off, rare, medium, normal, and a bad stored value reads as Often', () => {
  run(`${nsuiFixture}
    assert(manager.companionSpeakUp() == 'normal' and manager.snapshot(player).settings.companionSpeakUp == 'normal', 'a missing key is Often')
    assert(saved.companionSpeakUp == 'normal' and saved.speakUpOftenGiven == true, 'a new install saves the default and the marker')
    assert(invoke('tab:settings').ok)
    local speak = assert(row('companionSpeakUp'), 'the setting is not offered')
    assert(speak.type == 'select' and speak.value == 4 and speak.defaultValue == 4 and speak.label == 'Companions speak up')
    assert(#speak.elements == 4 and speak.elements[1] == 'Off' and speak.elements[2] == 'Speaks up rarely'
      and speak.elements[3] == 'Speaks up normally' and speak.elements[4] == 'Speaks up often', 'four entries')
    local cases = {{1, 'off'}, {2, 'rare'}, {3, 'medium'}, {4, 'normal'}}
    for _, case in ipairs({cases[4], cases[3], cases[1], cases[2]}) do
      assert(registered.applyBatch('manager', {{id = 'companionSpeakUp', value = case[1]}}).ok, case[1])
      assert(manager.companionSpeakUp() == case[2] and saved.companionSpeakUp == case[2], case[1])
      assert(manager.snapshot(player).settings.companionSpeakUp == case[2], case[1])
      loaded = registered.loadMod('manager'); assert(row('companionSpeakUp').value == case[1], case[1])
    end
    for _, invalid in ipairs({0, 5, 2.5, '2', true, false}) do
      assert(not registered.applyBatch('manager', {{id = 'companionSpeakUp', value = invalid}}).ok, tostring(invalid))
      assert(manager.companionSpeakUp() == 'rare')
    end
    assert(not manager.applySettings(player, {companionSpeakUp = 'often'}) and manager.companionSpeakUp() == 'rare')
    assert(manager.applySettings(player, {companionSpeakUp = 'normal'}) and manager.companionSpeakUp() == 'normal')
    -- Restore defaults puts it back to Often, and Johnny's list is left to its own default.
    assert(manager.applySettings(player, {companionSpeakUp = 'rare'}) and manager.companionSpeakUp() == 'rare')
    local back
    for _, change in ipairs(core.defaults()) do if change.id == 'companionSpeakUp' then back = change.value end end
    assert(back == 4, tostring(back))
    assert(registered.applyBatch('manager', core.defaults()).ok)
    assert(manager.companionSpeakUp() == 'normal' and manager.johnnyRemarks() == 'off')
  `);
  run(`${managerFixture}
    -- A file that has not been through the 0.3.4 move (no speakUpOftenGiven): the old default Rarely moves to Often once; Off, Normally and Often stay; a value that
    -- is not one of the four reads as Often. The marker is saved either way.
    for _, case in ipairs({{'off', 'off'}, {'rare', 'normal'}, {'medium', 'medium'}, {'normal', 'normal'}, {'often', 'normal'}, {true, 'normal'}, {7, 'normal'}}) do
      seed = {version = 2, voiceProvider = 'pocket', companionSpeakUp = case[1], enabledByKey = {}, future = {keep = 'unchanged'}}
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      assert(manager.companionSpeakUp() == case[2], tostring(case[1]))
      assert(saved.companionSpeakUp == case[2] and saved.speakUpOftenGiven == true and saved.future.keep == 'unchanged', tostring(case[1]))
    end
    -- A file that has: a Rarely the player chose afterwards is kept, and the marker is not written again.
    for _, case in ipairs({{'rare', 'rare'}, {'off', 'off'}, {'medium', 'medium'}, {'often', 'normal'}}) do
      seed = {version = 2, voiceProvider = 'pocket', companionSpeakUp = case[1], speakUpOftenGiven = true, enabledByKey = {}, future = {keep = 'unchanged'}}
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      assert(manager.companionSpeakUp() == case[2], 'marked ' .. tostring(case[1]))
      assert(saved == nil or (saved.companionSpeakUp == case[2] and saved.speakUpOftenGiven == true), 'marked ' .. tostring(case[1]))
    end
    -- No key at all: Often, with the marker.
    seed = {version = 2, voiceProvider = 'pocket', enabledByKey = {}}
    files['runtime/settings.json'], saved = 'seed', nil
    manager.configure(api, profiles); manager.prepare(player)
    assert(manager.companionSpeakUp() == 'normal' and saved.companionSpeakUp == 'normal' and saved.speakUpOftenGiven == true)
    -- Once moved, the player chooses Rarely, restarts, and it stays: the move happens one time only.
    assert(manager.applySettings(player, {companionSpeakUp = 'rare'}) and saved.companionSpeakUp == 'rare')
    seed = saved; files['runtime/settings.json'], saved = 'seed', nil
    manager.configure(api, profiles); manager.prepare(player)
    assert(manager.companionSpeakUp() == 'rare', 'a later choice of Rarely is kept')
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
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    assert(row('companionVision') == nil, 'the setting is still offered')
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings or {}) do assert(item.label ~= 'Companions can see' and item.id ~= 'companionVision') end
    end
    local result = registered.applyBatch('manager', {{id = 'companionVision', value = false}})
    assert(result.ok == false, 'an Apply for the removed row was accepted')
  `);
});

test('the Settings page has no read-only rows at all and no Voice status row, and the voice state still drives the fallback notice', () => {
  run(`${nsuiFixture}
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
    end
    assert(invoke('tab:settings').ok)
    local function walk()
      local count = 0
      for _, category in ipairs(loaded.categories) do
        for _, item in ipairs(category.settings) do
          count = count + 1
          assert(item.type ~= 'string', 'a read-only row on the Settings page: ' .. item.id)
          assert(item.id ~= 'voice-status' and item.label ~= 'Voice status', item.id)
          for _, text in ipairs({tostring(item.label), tostring(item.description), tostring(item.value)}) do
            assert(not text:find('Voice status', 1, true), item.id .. ': ' .. text)
          end
        end
      end
      return count
    end
    assert(walk() > 10)
    -- Whatever the voice service reports, no row appears for it.
    for _, state in ipairs({{state = 'remote', provider = 'convai', requestedProvider = 'convai'},
        {state = 'remote', provider = 'pocket', requestedProvider = 'pocket', cloudVoice = 'voxtral'},
        {state = 'ready', provider = 'pocket', requestedProvider = 'pocket'},
        {state = 'remote', provider = 'pocket', requestedProvider = 'pocket', cloudVoice = 'voxtral',
          fallback = {from = 'voxtral', to = 'text', temporary = false, reason = 'no-key'}}}) do
      status(state)
      walk()
      assert(row('voice-status') == nil)
    end
    -- The voice that became unavailable is still announced once (the notice of the voice state, not a row): replies are written, never given to the Convai voice.
    local notice = manager.takeVoiceFallbackNotice()
    assert(notice == 'Mistral cloud voice (Voxtral) is unavailable right now. Replies show as text until it is back.', tostring(notice))
    assert(manager.takeVoiceFallbackNotice() == nil)
  `);
});
test('Names for passers-by has no setting any more: it is not offered, and a saved npcNames value is ignored', () => {
  run(`${nsuiFixture}
    assert(manager.npcNames == nil and manager.snapshot(player).settings.npcNames == nil)
    assert(invoke('tab:settings').ok)
    assert(row('npcNames') == nil, 'the setting is still offered')
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings or {}) do assert(item.id ~= 'npcNames' and item.label ~= 'Names for passers-by') end
    end
    assert(not manager.applySettings(player, {npcNames = false}) or manager.snapshot(player).settings.npcNames == nil)
  `);
});

test('invitations made together post no progress, then one joined summary', () => {
  run(`${nsuiFixture}${invitationFixture}${managerPopupFixture}
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
  run(`${nsuiFixture}${invitationFixture}${managerPopupFixture}
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
  run(`${nsuiFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok); popupTick(false)
    managerUi.update(player, true)
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
  run(`${nsuiFixture}${invitationFixture}${managerPopupFixture}
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
  run(`${nsuiFixture}${invitationFixture}${managerPopupFixture}
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
  run(`${nsuiFixture}${invitationFixture}${managerPopupFixture}
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

test('Current party shows one action per state: Cancel invitation while preparing, Dismiss once joined, Remove when failed, and a failed invitation leaves after its notice', () => {
  run(`${nsuiFixture}${invitationFixture}
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
    assert(invoke('invite:person-1').ok)
    assert(invoke('characters:back').ok and invoke('tab:party').ok)
    -- Preparing: Cancel invitation, no Dismiss.
    assert(row('dismiss:queued:1').value == 'Cancel invitation' and row('dismiss:queued:2').value == 'Cancel invitation')
    -- The first becomes ready and joins; the second fails to prepare.
    readiness.receipts['queued:1'] = {state = 'ready'}
    readiness.receipts['queued:2'] = {state = 'error', error = 'The conversation connection did not open'}
    managerUi.update(player, false)
    loaded = registered.loadMod('manager')
    -- Paused: nothing is flushed yet. The failed invitation reads as failed (Remove, with its reason), never Cancel invitation.
    assert(#spawned == 0 and row('dismiss:queued:1').value == 'Cancel invitation')
    assert(row('dismiss:queued:2').value == 'Remove' and row('error:queued:2').label:find('connection did not open', 1, true))
    -- Back in gameplay the queue flush spawns the first (one row, Dismiss only) and, having said why, drops the failed one.
    managerUi.update(player, true)
    loaded = registered.loadMod('manager')
    assert(#spawned == 1 and party.count() == 1)
    assert(row('dismiss:live:1').value == 'Dismiss' and not row('dismiss:queued:1'))
    assert(not row('dismiss:queued:2') and not row('error:queued:2'), 'the failed invitation stayed listed')
    assert(readiness.cancellations['queued:2'], 'the failed reservation was not released')
  `);
});

test('a preparation failure first seen in the paused menu posts exactly one gameplay notice with Developer mode off', () => {
  run(`${nsuiFixture}${invitationFixture}${managerPopupFixture}
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
    -- The notice said it: the failed invitation left the party list. Inviting again is a new attempt with its own notice.
    assert(invoke('characters:back').ok and invoke('tab:party').ok and not row('dismiss:queued:1') and row('empty-party'))
    assert(invoke('party:back').ok and invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok); popupTick(false)
    assert(#popups == 1)
    readiness.receipts['queued:2'] = {state = 'error', error = 'Still unavailable'}
    popupTick(false); assert(#popups == 1)
    popupTick(true)
    assert(#popups == 2 and popups[2] == 'Johnny Silverhand could not prepare: Still unavailable')
  `);
});

test('an already joined manager invitation cannot replay preparation when the game resumes', () => {
  run(`${nsuiFixture}${invitationFixture}${managerPopupFixture}
    developer(true)
    assert(invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok); popupTick(false)
    readiness.receipts['queued:1'] = {state = 'ready'}
    party.flush(); members[1].state = 'ready'
    managerUi.update(player, true)
    assert(#popups == 1 and popups[1] == 'Johnny Silverhand joined your group.', tostring(popups[#popups]))
    for _ = 1, 5 do popupTick(true) end
    assert(#popups == 1)
  `);
});

test('a deferred world spawn posts no joining text, and the joined line once it attaches', () => {
  run(`${nsuiFixture}${invitationFixture}${managerPopupFixture}
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
  run(`${nsuiFixture}${invitationFixture}${managerPopupFixture}
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

test('without the optional OmniVoice pack Omni entries say what they need and cannot be applied; unknown status never locks them', () => {
  run(`${nsuiFixture}
    local clock = 1000
    os.time = function() return clock end
    jsonFixtures['voice-runtime'] = {state = 'ready', provider = 'pocket', omniPack = {installed = false, missing = {'model'}},
      updated = clock * 1000}
    files['runtime/local-voice-state.json'] = 'voice-runtime'
    assert(invoke('tab:settings').ok)
    loaded = registered.loadMod('manager')
    local elements = row('voiceProvider').elements
    assert(#elements == 8 and elements[1] == 'Off' and elements[2] == 'Pocket · Performance' and elements[8] == 'Convai · Cloud voice')
    -- Voxtral follows Pocket and is the one entry that says recommended (the owner's rule for the voice list).
    assert(elements[3] == 'Voxtral · needs Mistral key' or elements[3] == 'Voxtral (recommended)', elements[3])
    -- The entries keep plain labels (greyed out by the page, see the stepper test); the row's name says why.
    assert(elements[4] == 'OmniVoice · Balanced', elements[4])
    for index = 4, 7 do
      assert(elements[index]:find('OmniVoice', 1, true) and not elements[index]:find('needs pack', 1, true), 'entry ' .. index)
      assert(core.optionUnits(elements[index]) <= core.OPTION_BUDGET, 'entry ' .. index .. ' must stay short enough not to run over the arrows')
    end
    assert(row('voiceProvider').label == 'Companion voices (no Omni pack)', row('voiceProvider').label)
    assert(row('voice-pack') == nil, 'the OmniVoice pack has no row of its own')
    local before = saved.voiceProvider
    for index = 4, 7 do
      local result = registered.applyBatch('manager', {{id = 'voiceProvider', value = index}})
      assert(result.ok == false and result.error == 'Requires the optional OmniVoice pack (GPU)', 'entry ' .. index)
      assert(saved.voiceProvider == before)
    end
    assert(not manager.applySettings(player, {voiceProvider = 'omni'}))
    -- Pocket and Convai stay selectable.
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 8}}).ok and saved.voiceProvider == 'convai')
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 2}}).ok and saved.voiceProvider == 'pocket')
    -- The pack appears (installed while the game runs): the entries become plain labels and can be applied.
    clock = clock + 20
    -- Identical file text is one state (the manager decodes it once), so a changed state is a changed text.
    jsonFixtures['voice-runtime-pack'] = {state = 'ready', provider = 'pocket', omniPack = {installed = true, missing = {}},
      updated = clock * 1000}
    files['runtime/local-voice-state.json'] = 'voice-runtime-pack'
    manager.snapshot(player)
    loaded = registered.loadMod('manager')
    assert(row('voiceProvider').elements[4] == 'OmniVoice · Balanced')
    assert(row('voiceProvider').label == 'Companion voices', 'the pack is installed: the row is plain again')
    assert(row('voice-pack') == nil)
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 4}}).ok)
    assert(saved.voiceProvider == 'omni' and saved.omniSteps == 16 and saved.omniReference == 'short')
  `);
});

test('a PC the bridge knows has no NVIDIA card gets a note on the OmniVoice entries, which stay choosable; unknown or stale claims nothing', () => {
  run(`${nsuiFixture}
    local clock = 1000
    os.time = function() return clock end
    local function show(tag, state)
      clock = clock + 20
      state.state, state.provider, state.updated = 'ready', 'pocket', clock * 1000
      jsonFixtures['voice-' .. tag] = state
      files['runtime/local-voice-state.json'] = 'voice-' .. tag
      manager.snapshot(player)
      loaded = registered.loadMod('manager')
    end
    assert(invoke('tab:settings').ok)
    show('plain', {omniPack = {installed = true, missing = {}}})
    assert(row('voiceProvider').label == 'Companion voices' and manager.omniPack().noNvidia == false)
    show('unknown', {omniPack = {installed = true, missing = {}}, omniNoNvidia = false, gpuVendors = {}})
    assert(row('voiceProvider').label == 'Companion voices' and not row('voiceProvider').description:find('NVIDIA', 1, true))
    show('amd', {omniPack = {installed = true, missing = {}}, omniNoNvidia = true, gpuVendors = {'amd'}})
    assert(manager.omniPack().noNvidia == true)
    assert(row('voiceProvider').label == 'Companion voices (OmniVoice needs NVIDIA)', row('voiceProvider').label)
    local description = row('voiceProvider').description
    assert(description:find('^This PC has no NVIDIA graphics card, which OmniVoice needs. OmniVoice will not start here. Choose Pocket to hear voices.'), description)
    assert(description:find('Pocket: the lightest', 1, true), 'the usual help follows the note')
    local elements = row('voiceProvider').elements
    assert(#elements == 8 and elements[4] == 'OmniVoice · Balanced', 'the entries are not renamed (they must fit the box)')
    assert(row('voiceProvider').disabledElements == nil, 'no entry is greyed out or removed: a card the list does not show may still work')
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 4}}).ok and saved.voiceProvider == 'omni')
    -- An AMD Radeon card without an NVIDIA one, OmniVoice not set up on it yet: the row points to the in-game setup instead of 'needs NVIDIA'.
    show('amd-route', {omniPack = {installed = true, missing = {}}, omniNoNvidia = true, omniAmdRoute = true, gpuVendors = {'amd'}})
    assert(manager.omniPack().amdRoute == true)
    assert(row('voiceProvider').label == 'Companion voices (OmniVoice on AMD: set up first)', row('voiceProvider').label)
    description = row('voiceProvider').description
    assert(description:find('^Your AMD Radeon card can run OmniVoice. Set it up in Settings > Voices > OmniVoice for AMD: one download, then it starts by itself. Until then Pocket speaks.'), description)
    assert(not description:find('OMNIVOICE_AMD', 1, true) and description:find('Pocket: the lightest', 1, true))
    show('amd-route-integrated', {omniPack = {installed = true, missing = {}}, omniNoNvidia = true, omniAmdRoute = false, gpuVendors = {'intel'}})
    assert(manager.omniPack().amdRoute == false and row('voiceProvider').label == 'Companion voices (OmniVoice needs NVIDIA)')
    -- A stale report claims nothing.
    clock = clock + 60
    assert(manager.omniPack().noNvidia == false and manager.omniPack().amdRoute == false)
    -- The missing pack comes first in the row's name.
    show('both', {omniPack = {installed = false, missing = {'model'}}, omniNoNvidia = true})
    assert(row('voiceProvider').label == 'Companion voices (no Omni pack)', row('voiceProvider').label)
  `);
});

test('OmniVoice that needs an NVIDIA card is announced once as its own notice, whatever voice speaks instead, and not as a retry', () => {
  run(`${nsuiFixture}${managerPopupFixture}
    popupStep = 1
    local state = {state = 'ready', provider = 'text', requestedProvider = 'omni', requestedOmniSteps = 16,
      requestedOmniReference = 'short', routedProfiles = {},
      fallback = {from = 'omni', to = 'text', reason = 'omni-no-nvidia'}, updated = popupClock * 1000}
    jsonFixtures['voice-runtime'] = state
    files['runtime/local-voice-state.json'] = 'voice-runtime'
    popupTick(false); popupTick(false)
    assert(#popups == 0, 'a paused menu consumed the one notice')
    popupTick(true)
    assert(#popups == 1 and popups[1] == 'OmniVoice needs an NVIDIA graphics card, and this PC has none that works. Replies show as text. Choose Pocket in Settings to hear voices.', popups[1])
    assert(not popups[1]:find('not ready yet', 1, true) and not popups[1]:find('Convai', 1, true) and not popups[1]:find('Mistral', 1, true))
    for _ = 1, 8 do popupTick(true) end
    assert(#popups == 1, 'the same fallback was announced again')
    -- With Pocket already loaded it speaks instead and the notice says so; a different fallback id, so said once more.
    popupClock = popupClock + 700
    state.fallback, state.provider, state.updated = {from = 'omni', to = 'pocket', reason = 'omni-no-nvidia'}, 'pocket', popupClock * 1000
    for _ = 1, 3 do popupTick(true) end
    assert(#popups == 2 and popups[2] == 'OmniVoice needs an NVIDIA graphics card, and this PC has none that works. Companions are using Pocket · Performance instead.', popups[2])
    for _ = 1, 8 do popupTick(true) end
    assert(#popups == 2)
    -- A fallback with another reason (or none) keeps the usual wording.
    popupClock = popupClock + 700
    state.fallback, state.updated = {from = 'omni', to = 'pocket'}, popupClock * 1000
    for _ = 1, 3 do popupTick(true) end
    assert(popups[#popups] == 'OmniVoice · Balanced is unavailable. Companions are using Pocket · Performance instead.', popups[#popups])
  `);
});

test('a card the bridge knows has under 12 GB gets "OmniVoice needs 12 GB" on the voice row and a note; the NVIDIA hint comes first; stale or unknown claims nothing', () => {
  run(`${nsuiFixture}
    local clock = 1000
    os.time = function() return clock end
    local function show(tag, state)
      clock = clock + 20
      state.state, state.provider, state.updated = 'ready', 'pocket', clock * 1000
      jsonFixtures['voice-' .. tag] = state
      files['runtime/local-voice-state.json'] = 'voice-' .. tag
      manager.snapshot(player)
      loaded = registered.loadMod('manager')
    end
    assert(invoke('tab:settings').ok)
    show('big', {omniPack = {installed = true, missing = {}}, omniNoNvidia = false, omniSmallCard = false})
    assert(row('voiceProvider').label == 'Companion voices' and manager.omniPack().smallCard == false)
    assert(not row('voiceProvider').description:find('12 GB', 1, true))
    show('small', {omniPack = {installed = true, missing = {}}, omniNoNvidia = false, omniSmallCard = true})
    assert(manager.omniPack().smallCard == true)
    assert(row('voiceProvider').label == 'Companion voices (OmniVoice needs 12 GB)', row('voiceProvider').label)
    local description = row('voiceProvider').description
    assert(description:find('^The graphics card in this PC has less than the 12 GB OmniVoice needs next to the game.'), description)
    assert(description:find('Pocket: the lightest', 1, true), 'the usual help follows the note')
    local elements = row('voiceProvider').elements
    assert(#elements == 8 and elements[4] == 'OmniVoice · Balanced', 'the entries are not renamed')
    assert(row('voiceProvider').disabledElements == nil, 'no entry is greyed out')
    show('both', {omniPack = {installed = true, missing = {}}, omniNoNvidia = true, omniSmallCard = true})
    assert(row('voiceProvider').label == 'Companion voices (OmniVoice needs NVIDIA)', row('voiceProvider').label)
    show('nopack', {omniPack = {installed = false, missing = {'model'}}, omniSmallCard = true})
    assert(row('voiceProvider').label == 'Companion voices (no Omni pack)', row('voiceProvider').label)
    show('again', {omniPack = {installed = true, missing = {}}, omniSmallCard = true})
    clock = clock + 60
    assert(manager.omniPack().smallCard == false, 'a stale report claims nothing')
  `);
});

test('OmniVoice that cannot get the graphics memory is announced once as its own notice when Pocket takes over, and not as a retry or a plain "unavailable"', () => {
  run(`${nsuiFixture}${managerPopupFixture}
    popupStep = 1
    local state = {state = 'ready', provider = 'pocket', requestedProvider = 'omni', requestedOmniSteps = 16,
      requestedOmniReference = 'short', routedProfiles = {},
      fallback = {from = 'omni', to = 'pocket', reason = 'omni-memory'}, updated = popupClock * 1000}
    jsonFixtures['voice-runtime'] = state
    files['runtime/local-voice-state.json'] = 'voice-runtime'
    popupTick(false); popupTick(false)
    assert(#popups == 0, 'a paused menu consumed the one notice')
    popupTick(true)
    local expected = 'OmniVoice needs more graphics memory than is free next to the game. Pocket is used.'
    assert(#popups == 1 and popups[1] == expected, popups[1])
    for _ = 1, 8 do popupTick(true) end
    assert(#popups == 1, 'the same fallback was announced again')
    -- The reason without Pocket (replies written) keeps the usual wording, as a different fallback.
    popupClock = popupClock + 700
    state.fallback, state.provider, state.updated = {from = 'omni', to = 'text', reason = 'omni-memory'}, 'text', popupClock * 1000
    for _ = 1, 3 do popupTick(true) end
    assert(popups[#popups] == 'OmniVoice · Balanced is unavailable right now. Replies show as text until it is back.', popups[#popups])
  `);
});

test('Windows running out of memory for the voice (the paging file is too small) is its own notice, once, for OmniVoice falling to Pocket or to text and for Pocket itself', () => {
  run(`${nsuiFixture}${managerPopupFixture}
    popupStep = 1
    local expected = 'Windows ran out of memory for the voice. A larger paging file or closing other apps helps.'
    local state = {state = 'ready', provider = 'pocket', requestedProvider = 'omni', requestedOmniSteps = 16,
      requestedOmniReference = 'short', routedProfiles = {},
      fallback = {from = 'omni', to = 'pocket', reason = 'virtual-memory'}, updated = popupClock * 1000}
    jsonFixtures['voice-runtime'] = state
    files['runtime/local-voice-state.json'] = 'voice-runtime'
    popupTick(false); popupTick(false)
    assert(#popups == 0, 'a paused menu consumed the one notice')
    popupTick(true)
    assert(#popups == 1 and popups[1] == expected, popups[1])
    for _ = 1, 8 do popupTick(true) end
    assert(#popups == 1, 'the same fallback was announced again')
    -- OmniVoice and then Pocket failed the same way: replies are written, said again as a different fallback, with the same sentence.
    popupClock = popupClock + 700
    state.fallback, state.provider, state.updated = {from = 'omni', to = 'text', reason = 'virtual-memory'}, 'text', popupClock * 1000
    for _ = 1, 3 do popupTick(true) end
    assert(#popups == 2 and popups[2] == expected, popups[#popups])
    -- Pocket itself, chosen by the player.
    popupClock = popupClock + 700
    state.requestedProvider = 'pocket'
    state.fallback, state.updated = {from = 'pocket', to = 'text', reason = 'virtual-memory'}, popupClock * 1000
    for _ = 1, 3 do popupTick(true) end
    assert(#popups == 3 and popups[3] == expected, popups[#popups])
    -- Another Pocket failure keeps the usual wording.
    popupClock = popupClock + 700
    state.fallback, state.updated = {from = 'pocket', to = 'text'}, popupClock * 1000
    for _ = 1, 3 do popupTick(true) end
    assert(#popups == 4 and popups[4] == 'Pocket · Performance is unavailable right now. Replies show as text until it is back.', popups[#popups])
  `);
});

test('the Mistral cloud voice (Voxtral) says it needs a Mistral key and cannot be applied without one; with a key it applies beside any conversation provider', () => {
  run(`${nsuiFixture}
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
    assert(#elements == 8 and elements[3] == NEEDS and elements[8] == 'Convai · Cloud voice', elements[3])
    assert(manager.voiceLabel('voxtral') == 'Mistral cloud voice (Voxtral)')
    local before = saved.voiceProvider
    local result = registered.applyBatch('manager', {{id = 'voiceProvider', value = 3}})
    assert(result.ok == false and result.error == 'Requires a Mistral key (add it in Settings > Conversation provider)', result.error)
    assert(saved.voiceProvider == before)
    assert(not manager.applySettings(player, {voiceProvider = 'voxtral'}))
    -- A key is saved (the Conversation provider stays Convai, the default): the entry is a plain label and can be applied.
    key('a', {provider = 'convai', effective = 'convai', saved = true})
    loaded = registered.loadMod('manager')
    assert(row('voiceProvider').elements[3] == 'Voxtral (recommended)', row('voiceProvider').elements[3])
    assert(manager.snapshot(player).settings.conversationProvider == 'convai')
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 3}}).ok)
    assert(saved.voiceProvider == 'voxtral' and manager.snapshot(player).settings.voiceProvider == 'voxtral')
    -- It rides on Pocket, so Natural speech is not turned off by choosing it.
    assert(registered.applyBatch('manager', {{id = 'naturalSpeech', value = true}}).ok and manager.naturalSpeech() == true)
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 3}}).ok)
    assert(manager.naturalSpeech() == true and manager.snapshot(player).settings.voiceProvider == 'voxtral')
    assert(registered.applyBatch('manager', {{id = 'naturalSpeech', value = false}}).ok)
    -- Convai stays selectable, and the saved voice is found again in the list.
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 8}}).ok and saved.voiceProvider == 'convai')
    -- What is saved is the provider (and for OmniVoice the steps and reference), never a list position: each saved choice finds its own
    -- entry in the reordered list (Voxtral directly after Pocket), so no one's voice changes with the order.
    local choices = dofile('voice-preview.lua')
    assert(choices.indexOf({voiceProvider = 'voxtral'}) == 2 and choices.indexOf({voiceProvider = 'pocket'}) == 1)
    assert(choices.indexOf({voiceProvider = 'convai'}) == 7 and #choices.CHOICES == 7)
    assert(choices.indexOf({voiceProvider = 'omni', omniSteps = 16, omniReference = 'short'}) == 3)
    assert(choices.indexOf({voiceProvider = 'omni', omniSteps = 16, omniReference = 'long'}) == 4)
    assert(choices.indexOf({voiceProvider = 'omni', omniSteps = 32, omniReference = 'short'}) == 5)
    assert(choices.indexOf({voiceProvider = 'omni', omniSteps = 32, omniReference = 'long'}) == 6)
    assert(choices.indexOf({voiceProvider = 'hybrid', omniSteps = 32, omniReference = 'long'}) == 6, 'a legacy hybrid choice reads as OmniVoice')
    for position, choice in ipairs(choices.CHOICES) do
      assert(choices.indexOf({voiceProvider = choice.provider, omniSteps = choice.steps, omniReference = choice.reference}) == position, choice.provider)
    end
  `);
});

test('Mature content is a settings row with or without the Mature pack: the help says whether the uncensored models are installed and that the safety check runs on every model', () => {
  run(`${nsuiFixture}
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
    assert(tostring(noPack.description):find('Pack: not installed', 1, true), 'the help says the uncensored models are not installed')
    assert(tostring(noPack.description):find('From Convai or Mistral, turning it on selects Local AI, or Custom when Local AI is not installed. With Local AI it also selects the largest uncensored model that fits. Turning it off restores your choices. Choosing Convai or Mistral turns it off. Voxtral is not used with it: a voice on Voxtral moves to Pocket and comes back when it is turned off.', 1, true),
      'the help names what turning it on from Convai or Mistral selects, never Mistral, and what happens to a Voxtral voice')
    assert(not tostring(noPack.description):find('Mistral or Custom when Local AI', 1, true), 'Mistral is never selected')
    assert(not tostring(noPack.description):find('local voice instead of a cloud one', 1, true), 'the old voice sentence is gone')
    assert(not tostring(noPack.description):find('recommended', 1, true))
    assert(tostring(noPack.description):find('Hugging Face page', 1, true), 'and where to get them')
    assert(tostring(noPack.description):find('Choosing Convai or Mistral turns it off.', 1, true), 'the help says Convai and Mistral turn it off')
    assert(tostring(noPack.description):find('Needs Local AI or Custom.', 1, true), 'the help names the two providers')
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
    assert(not tostring(mature.description):find('Pack: not installed', 1, true))
    assert(not tostring(mature.description):find('Not using Local AI', 1, true), 'Local AI answers, so no warning')
    assert(registered.applyBatch('manager', {{id = 'matureContent', value = true}}).ok and saved.matureContent == true)
    -- Another provider answers: the row stays, with no "no effect" warning (a cloud provider turns the setting off instead).
    state('other', {provider = 'mistral', effective = 'mistral', saved = true, maturePack = true, localAi = 'ready'})
    loaded = registered.loadMod('manager')
    assert(not tostring(row('matureContent').description):find('Not using Local AI', 1, true), 'the retired warning is gone')
    assert(tostring(row('matureContent').description):find('Choosing Convai or Mistral turns it off.', 1, true))
    assert(tostring(row('matureContent').description):find('Needs Local AI or Custom.', 1, true), 'the help names the two providers')
    assert(not tostring(row('matureContent').description):find('Works with Local AI, Mistral and Custom.', 1, true), 'Mistral is not named as a provider for it')
    assert(not tostring(row('matureContent').description):find('Local AI only', 1, true))
    -- The pack goes away: the row stays, the setting stays on, and the help says the pack is not installed.
    state('gone', {provider = 'local', effective = 'local', saved = false, maturePack = false})
    loaded = registered.loadMod('manager')
    assert(row('matureContent') ~= nil)
    assert(tostring(row('matureContent').description):find('Pack: not installed', 1, true))
  `);
});


test('the saved way back is checked on load and on Apply, and is dropped with Mature content', () => {
  run(`${nsuiFixture}
    local ok = manager.applySettings(player, {matureContent = true, conversationProvider = 'local', matureRestore = {conversationProvider = {before = 'convai', set = 'local'},
      localModel = {before = 'bad id', set = 'auto'}, voice = {before = {provider = 'pocket'}, set = {provider = 'omni', steps = 16, reference = 'short'}}}})
    assert(ok)
    local way = manager.snapshot(player).settings.matureRestore
    assert(way.conversationProvider.before == 'convai' and way.localModel == nil, 'a malformed part was kept')
    assert(way.voice and way.voice.before.provider == 'pocket' and way.voice.set.provider == 'omni' and way.voice.set.steps == 16 and way.voice.set.reference == 'short', 'the voice part is kept (Voxtral is not used beside Mature content, so the way back names the voice again)')
    assert(not manager.applySettings(player, {matureRestore = {junk = true}}), 'a record with nothing valid was accepted')
    assert(not manager.applySettings(player, {matureRestore = {voice = {before = {provider = 'groq'}, set = {provider = 'pocket'}}}}), 'a voice part with an unknown provider is no record')
    assert(manager.applySettings(player, {matureRestore = {vVoiceEngine = {before = 'voxtral', set = 'pocket'}}}) and manager.snapshot(player).settings.matureRestore.vVoiceEngine.before == 'voxtral', 'the V part is kept')
    assert(not manager.applySettings(player, {matureRestore = {vVoiceEngine = {before = 'pocket', set = 'pocket'}}}), 'a V part that changes nothing is no record')
    -- 'convai-key' (Convai with the player's own key, its own selector entry) is a provider a way back can name; anything else is dropped.
    assert(manager.applySettings(player, {matureRestore = {conversationProvider = {before = 'convai-key', set = 'local'}}}))
    assert(manager.snapshot(player).settings.matureRestore.conversationProvider.before == 'convai-key')
    assert(not manager.applySettings(player, {matureRestore = {conversationProvider = {before = 'groq', set = 'local'}}}), 'an unknown provider was kept')
    assert(manager.applySettings(player, {matureContent = false}))
    assert(manager.snapshot(player).settings.matureRestore == nil and saved.matureRestore == nil, 'the record outlived Mature content')
    -- Mature content with Convai in the same save is saved as off, and its way back goes with it.
    assert(manager.applySettings(player, {matureContent = true, conversationProvider = 'local', matureRestore = {conversationProvider = {before = 'mistral', set = 'local'}}}))
    assert(manager.applySettings(player, {conversationProvider = 'convai'}))
    assert(saved.matureContent == false and saved.matureRestore == nil, 'Convai left a way back behind')
  `);
});

// ---- Settings round 3: the focused option budget, the voice stepper, the provider migration,
// ---- the key rows and the Mature / cloud provider exclusion.

test('select option width: the budget is the box minus the two key boxes a focused row draws, and a text that fit the old budget but not this one is cut', () => {
  run(`${nsuiFixture}
    assert(core.OPTION_BOX_UNITS == 32 and core.KEY_HINT_UNITS == 3, 'the box and the key boxes are exposed')
    assert(core.OPTION_BUDGET == core.OPTION_BOX_UNITS - 2 * core.KEY_HINT_UNITS and core.OPTION_BUDGET == 26, tostring(core.OPTION_BUDGET))
    -- Between the budget and the box: it would have fit unfocused, but the key boxes of a focused row cover its ends.
    local between = string.rep('a', 29)
    assert(core.optionUnits(between) > core.OPTION_BUDGET and core.optionUnits(between) <= core.OPTION_BOX_UNITS, core.optionUnits(between))
    local cut = core.fitOption(between)
    assert(cut ~= between and cut:sub(-3) == '…' and core.optionUnits(cut) <= core.OPTION_BUDGET, cut)
    -- The reported case: a long model name with its marker keeps the marker and fits the budget.
    local model = core.fitOption('Gemma-4-E4B-MiniFoo-Heretic (uncensored)')
    assert(model:sub(-13) == ' (uncensored)' and model:find('…', 1, true) and core.optionUnits(model) <= core.OPTION_BUDGET, model)
    -- Exactly the budget is left as it is.
    local exact = string.rep('a', 26)
    assert(core.optionUnits(exact) <= core.OPTION_BUDGET and core.fitOption(exact) == exact)
  `);
});

test('select option width: every option of every select fits the focused budget in every runtime variant of the menus (developer mode, keys saved or not, OmniVoice pack, Local AI models with long names)', () => {
  run(`${nsuiFixture}
    local clock = 1000
    os.clock = function() return clock end
    os.time = function() return clock end
    local widest, checked = 0, 0
    local function scan(tag)
      for _, category in ipairs(loaded.categories) do
        for _, setting in ipairs(category.settings) do
          if setting.type == 'select' and setting.elements then
            for index, label in ipairs(setting.elements) do
              local units = core.optionUnits(label)
              checked = checked + 1; widest = math.max(widest, units)
              assert(units <= core.OPTION_BUDGET, tag .. ' ' .. setting.id .. ' option ' .. index .. ': ' .. label .. ' (' .. units .. ')')
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
          jsonFixtures['state-' .. tag] = {provider = 'local', effective = 'local', saved = keys, tail = 'abcd', localAi = 'warming',
            localModels = {{id = 'lite', name = 'Qwen3.5-2B', sizeMiB = 1311}, {id = 'mature:lite', name = 'Qwen3.5-4B-HauhauCS · uncensored', sizeMiB = 2700},
              {id = 'custom:long', name = 'My Own Fine-Tuned Companion Model 13B Instruct', sizeMiB = 7000, custom = true, needMiB = 8000},
              {id = 'custom:huge', name = 'Enormous Community Merge With A Very Long Name', sizeMiB = 40960, custom = true, needMiB = 42160, tooLarge = true}}}
          files['runtime/mistral-state.json'] = 'state-' .. tag
          assert(manager.applySettings(player, {developerMode = developer}))
          manager.snapshot(player)
          loaded = registered.loadMod('manager')
          assert(#row('voiceProvider').elements == 8, tag .. ': ' .. #row('voiceProvider').elements .. ' voices')
          scan(tag)
        end
      end
    end
    assert(checked >= 150, 'only ' .. checked .. ' options were looked at')
    assert(widest <= core.OPTION_BUDGET and widest > 20, 'the widest option is ' .. widest)
  `);
});

test('the removed Inworld voice: the list has seven entries with or without Developer mode, no Inworld key row, an Apply for it is refused, and a saved Inworld voice loads as Pocket TTS once, with the file corrected and no Apply loop', () => {
  run(`${nsuiFixture}
    local clock = 1000
    os.clock = function() return clock end
    os.time = function() return clock end
    local function ids(category)
      local list = {}
      for _, item in ipairs(loaded.categories) do
        if item.id == category then for _, setting in ipairs(item.settings) do list[#list + 1] = setting.id end end
      end
      return table.concat(list, ',')
    end
    assert(invoke('tab:settings').ok)
    local function menu() return row('voiceProvider').elements end
    for _, developer in ipairs({false, true}) do
      assert(manager.applySettings(player, {developerMode = developer}))
      loaded = registered.loadMod('manager')
      assert(#menu() == 8 and menu()[1] == 'Off' and menu()[8] == 'Convai · Cloud voice', table.concat(menu(), '|'))
      for _, label in ipairs(menu()) do assert(not label:find('Inworld', 1, true), label) end
      assert(row('inworld-key') == nil and ids('development') == 'developerMode', ids('development'))
      assert(not row('voiceProvider').description:find('Inworld', 1, true))
      -- A stale draft index past the end saves nothing, and the removed name is not a voice to choose.
      local result = registered.applyBatch('manager', {{id = 'voiceProvider', value = 9}})
      assert(result.ok == false and saved.voiceProvider == 'pocket', 'there is no eighth voice')
      assert(manager.applySettings(player, {voiceProvider = 'inworld'}) == false and saved.voiceProvider == 'pocket')
    end
    -- A settings file that still names the removed voice loads as the default voice, with or without Developer mode, and is corrected
    -- once: loading the corrected file saves nothing more, and the page shows the default voice as the saved one (nothing pending).
    for _, developer in ipairs({true, false}) do
      seed = {version = 2, voiceProvider = 'inworld', developerMode = developer, enabledByKey = {}, future = {keep = 'unchanged'}}
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      assert(manager.snapshot(player).settings.voiceProvider == 'pocket' and saved.voiceProvider == 'pocket', tostring(developer))
      assert(saved.future.keep == 'unchanged' and manager.takeNaturalSpeechNotice() == nil)
      seed, saved = saved, nil
      files['runtime/settings.json'] = 'seed'
      manager.configure(api, profiles); manager.prepare(player)
      assert(saved == nil, 'the corrected file is saved again')
      loaded = registered.loadMod('manager')
      assert(row('voiceProvider').value == 2 and row('voiceProvider').defaultValue == 2 and #menu() == 8)
    end
    -- A retired Multilingual value beside it changes nothing: the removed name still ends at the default voice.
    seed = {version = 2, voiceProvider = 'inworld', multilingualConversations = true, enabledByKey = {}}
    files['runtime/settings.json'], saved = 'seed', nil
    manager.configure(api, profiles); manager.prepare(player)
    assert(manager.snapshot(player).settings.voiceProvider == 'pocket' and saved.voiceProvider == 'pocket' and saved.multilingualConversations == nil)
  `);
});

test('the old Use my own Convai API key switch migrates once: on with a saved key is Convai API key, otherwise Convai free tier; Mistral and Local are never overridden', () => {
  run(`${nsuiFixture}
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

test('Mature content and a cloud provider exclude each other in loaded settings and in Apply (Convai free tier, Convai API key and Mistral turn it off; Local and Custom keep it)', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    for _, case in ipairs({{'local', false, true}, {'convai', false, false}, {'convai', true, false}, {'mistral', false, false}, {'custom', false, true}, {'groq', false, false}, {nil, false, false}}) do
      seed = {version = 2, voiceProvider = 'pocket', matureContent = true, conversationProvider = case[1], useOwnConvaiKey = case[2], enabledByKey = {}}
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      local settings = manager.snapshot(player).settings
      assert(settings.matureContent == case[3] and saved.matureContent == case[3], tostring(case[1]) .. ' ' .. tostring(case[2]))
    end
    -- A saved way back goes with Mature content when Convai turned it off.
    seed = {version = 2, voiceProvider = 'pocket', matureContent = true, conversationProvider = 'convai', enabledByKey = {},
      matureRestore = {conversationProvider = {before = 'convai-key', set = 'local'}}}
    files['runtime/settings.json'], saved = 'seed', nil
    manager.configure(api, profiles); manager.prepare(player)
    assert(manager.snapshot(player).settings.matureContent == false and manager.snapshot(player).settings.matureRestore == nil and saved.matureRestore == nil)
    -- Apply: Mature content beside Local or Custom stays; beside Convai or Mistral in the result it is saved as off (a reload is asked for quietly).
    assert(manager.applySettings(player, {matureContent = true, conversationProvider = 'local'}) and saved.matureContent == true)
    for _, provider in ipairs({'custom'}) do
      assert(manager.applySettings(player, {matureContent = true, conversationProvider = provider}) and saved.matureContent == true, provider)
      assert(manager.applySettings(player, {conversationProvider = 'local'}) and saved.matureContent == true)
    end
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

test('Local AI model: a row with each installed model by its name from the smallest to the largest and no Auto, the default model selected until one is chosen, sizes in the help, the pin saved by id', () => {
  run(`${nsuiFixture}
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
    assert(manager.applySettings(player, {witnessReceipts = true}) and saved.localModel == 'auto', tostring(saved.localModel))
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
    assert(manager.applySettings(player, {witnessReceipts = false}) and saved.localModel == 'custom:gone-model', 'an Apply of something else must not change a model that is only missing')
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
    local ok, err, notice = manager.applySettings(player, {witnessReceipts = true})
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
      assert(manager.applySettings(player, {witnessReceipts = false}) and saved.localModel == 'auto', tostring(default) .. ' ' .. tostring(saved.localModel))
    end
    -- Equal sizes sort by name.
    state('ties', {provider = 'local', effective = 'local', saved = false, localModels = {
      {id = 'b', name = 'Bravo', sizeMiB = 2000}, {id = 'a', name = 'alpha', sizeMiB = 2000}, {id = 'c', name = 'Charlie', sizeMiB = 1000}}})
    loaded = registered.loadMod('manager')
    assert(table.concat(row('localModel').elements, '|') == 'Charlie|alpha|Bravo', table.concat(row('localModel').elements, '|'))
  `);
});

test('Local AI model: custom models are marked, show the memory they need or that the card is too small, and unusable ones are named in the help', () => {
  run(`${nsuiFixture}
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
  run(`${nsuiFixture}
    for _, pair in ipairs({${expected}}) do
      assert(math.abs(core.optionUnits(pair[1]) - pair[2]) < 0.05, pair[1] .. ' ' .. core.optionUnits(pair[1]) .. ' vs ' .. pair[2])
    end
    local budget = core.OPTION_BUDGET
    local function valid(text) return utf8.len(text) ~= nil end
    -- A text that fits is returned as it is.
    assert(core.fitOption('Pocket · Performance') == 'Pocket · Performance')
    assert(core.fitOption('') == '' and core.fitOption(nil) == '')
    -- The name is cut, the marker stays.
    local long = core.fitOption('Qwen3.5-4B-HauhauCS-Aggressive-Extended (uncensored)')
    assert(long:find('…', 1, true) and long:sub(-13) == ' (uncensored)' and core.optionUnits(long) <= budget, long)
    local custom = core.fitOption('A very long custom model name from somebody (custom · too large)')
    assert(custom:sub(-22) == ' (custom · too large)' and custom:find('…', 1, true) and core.optionUnits(custom) <= budget, custom)
    local dotted = core.fitOption('Gemma 4 E4B Heretic Ultra Abliterated Edition · uncensored')
    assert(dotted:sub(-14) == ' · uncensored' and core.optionUnits(dotted) <= budget, dotted)
    -- No marker: the whole text is cut. Wide characters are cut on a character boundary, never inside one.
    local plain = core.fitOption(string.rep('M', 60))
    assert(plain:sub(-3) == '…' and core.optionUnits(plain) <= budget, plain)
    local wide = core.fitOption(string.rep('日本語', 20))
    assert(valid(wide) and wide:sub(-3) == '…' and core.optionUnits(wide) <= budget and #wide > 3, wide)
    local accented = core.fitOption(string.rep('é', 80))
    assert(valid(accented) and core.optionUnits(accented) <= budget, accented)
    -- A marker that is itself wider than the budget does not leave an empty name: the whole text is cut instead.
    local huge = core.fitOption('x (' .. string.rep('long marker ', 10) .. ')')
    assert(valid(huge) and core.optionUnits(huge) <= budget and huge:find('…', 1, true), huge)
  `);
});

test('select option width: every select of the settings page fits in English, the built-in model names are shown whole, and a custom model with a long name is cut', () => {
  run(`${nsuiFixture}
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
            widest = math.max(widest, core.optionUnits(label))
            assert(core.optionUnits(label) <= core.OPTION_BUDGET, setting.id .. ' option ' .. index .. ': ' .. label .. ' (' .. core.optionUnits(label) .. ')')
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

test('the Mistral cloud voice (Voxtral TTS 3) speaks the language of the text: no voice is moved or refused for it, so a saved choice stays and Pocket can be chosen', () => {
  run(`${nsuiFixture}
    local clock = 1000; os.clock = function() return clock end
    jsonFixtures['mistral-a'] = {provider = 'convai', effective = 'convai', saved = true}
    files['runtime/mistral-state.json'] = 'mistral-a'
    clock = clock + 2
    assert(manager.applySettings(player, {voiceProvider = 'voxtral'}))
    assert(manager.snapshot(player).settings.voiceProvider == 'voxtral')
    -- An Apply that still carries the retired Multilingual key keeps the saved choice and says nothing.
    local ok, err, notice = manager.applySettings(player, {multilingualConversations = true})
    assert(ok and notice == nil, err)
    assert(manager.snapshot(player).settings.voiceProvider == 'voxtral')
    -- Choosing the Mistral cloud voice again is accepted, and so is Pocket (nothing refuses it for its language any more).
    local again, message = manager.applySettings(player, {voiceProvider = 'voxtral'})
    assert(again, message)
    assert(manager.snapshot(player).settings.voiceProvider == 'voxtral')
    local chosen, why = manager.applySettings(player, {voiceProvider = 'pocket'})
    assert(chosen, tostring(why))
    assert(manager.snapshot(player).settings.voiceProvider == 'pocket')
  `);
});

test('a Mistral cloud voice that fell back to Pocket is announced once, with the usual wording', () => {
  run(`${nsuiFixture}${managerPopupFixture}
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

test('prepared voices are always kept: no switch, no disk row, no Clear action or page, and a saved false is ignored', () => {
  run(`${nsuiFixture}
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
  run(`${nsuiFixture}
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

test('a fallback reported from the removed Inworld voice is ignored: no notice is shown for a voice that is no longer offered', () => {
  run(`${nsuiFixture}${managerPopupFixture}
    popupStep = 1
    local state = {state = 'ready', provider = 'pocket', requestedProvider = 'pocket', cloudVoice = nil, routedProfiles = {'johnny-silverhand'},
      fallback = {from = 'inworld', to = 'pocket', temporary = true, reason = 'timeout'}, updated = popupClock * 1000}
    jsonFixtures['voice-runtime'] = state
    files['runtime/local-voice-state.json'] = 'voice-runtime'
    popupTick(false); popupTick(false)
    popupTick(true)
    state.fallback.temporary = false
    for _ = 1, 3 do popupTick(true) end
    assert(#popups == 0, table.concat(popups, '|'))
  `);
});

test('native Memory submenu has consistent parent navigation and preserves an unissued confirmation', () => {
  run(`${nsuiFixture}${memoryFixture}
    publishMemory(1, {{profileKey = 'person-20'}})
    assert(invoke('tab:settings').ok)
    assert(row('memory').type == 'action' and row('memory').value == 'Manage')
    assert(not row('memory:choose') and not row('memory-count'), 'memory controls leaked into the Settings page')
    assert(not row('permissions') and not invoke('permissions').ok and managerUi.inspect().view == 'settings', 'Who can talk is gone')
    assert(invoke('memory').ok and managerUi.inspect().view == 'memory')
    assert(not row('tab:settings') and loaded.categories[1].settings[1].label == 'Back to settings')
    -- The character is chosen from a list on the Memory page itself: 22 characters, 12 to a page, read with the page slider.
    assert(not row('memory:choose') and row('memory-selected').value == 'Choose a character')
    assert(row('ui:page') and row('ui:page').max == 2 and row('ui:page').value == 1 and not row('memory:select:person-20'))
    assert(core.setUi('ui:page', 2)); loaded = registered.loadMod('manager')
    assert(row('memory:select:person-20') and row('memory:select:person-20').value == 'Choose' and not row('memory:select:person-01'))
    assert(invoke('memory:select:person-20').ok)
    assert(managerUi.inspect().view == 'memory' and row('memory-selected').value == 'Person 20')
    assert(row('memory:select:person-20').value == 'Unselect')
    assert(invoke('memory:forget-character').ok)
    local confirmation = token()
    assert(invoke('memory:settings').ok and managerUi.inspect().view == 'settings')
    assert(invoke('memory').ok and token() == confirmation and row('memory-confirmation'))
    assert(invoke('memory:cancel:' .. confirmation).ok and memoryWrites() == 0)
    assert(#members == 0 and #spawned == 0)
  `);
});

test('Memory: pressing the chosen character again unchooses it, the button says so, and a confirmed forget clears the choice', () => {
  run(`${nsuiFixture}${memoryFixture}
    publishMemory(2, {{profileKey = 'johnny-silverhand'}, {profileKey = 'person-20'}})
    openMemory()
    local function choiceRows()
      local chosen, unchosen = 0, 0
      for _, category in ipairs(loaded.categories) do
        for _, value in ipairs(category.settings) do
          if tostring(value.id):find('^memory:select:') then
            if value.value == 'Unselect' then chosen = chosen + 1 elseif value.value == 'Choose' then unchosen = unchosen + 1 end
          end
        end
      end
      return chosen, unchosen
    end
    local chosen, unchosen = choiceRows()
    assert(chosen == 0 and unchosen == 12, 'nothing is chosen at first')
    local before = managerUi.inspect().page
    -- Choose one, then another: only the second shows as chosen (a single choice), never two.
    assert(invoke('memory:select:johnny-silverhand').ok)
    chosen = choiceRows()
    assert(chosen == 1 and row('memory:select:johnny-silverhand').value == 'Unselect' and row('memory-selected').value == 'Johnny Silverhand')
    assert(core.setUi('ui:page', 2)); loaded = registered.loadMod('manager')
    assert(invoke('memory:select:person-20').ok)
    chosen = choiceRows()
    assert(chosen == 1 and row('memory:select:person-20').value == 'Unselect' and row('memory-selected').value == 'Person 20')
    assert(core.setUi('ui:page', 1)); loaded = registered.loadMod('manager')
    assert(row('memory:select:johnny-silverhand').value == 'Choose', 'the earlier choice is not still drawn as chosen')
    -- Pressing the chosen one again unchooses it: the button, the Selected character line and the Forget button follow at once.
    assert(core.setUi('ui:page', 2)); loaded = registered.loadMod('manager')
    local unselected = invoke('memory:select:person-20')
    assert(unselected.ok and row('memory:select:person-20').value == 'Choose')
    assert(row('memory-selected').value == 'Choose a character' and row('memory:forget-character').disabled)
    assert(manager.snapshot(player).memory.selectedKey == nil)
    assert(managerUi.inspect().shown == 'Person 20 unselected.', 'the line under the way back says what happened: ' .. tostring(managerUi.inspect().shown))
    -- Unchoosing drops a review that was waiting for Confirm, and nothing was sent.
    assert(invoke('memory:select:person-20').ok and invoke('memory:forget-character').ok and row('memory-confirmation'))
    assert(invoke('memory:select:person-20').ok and not row('memory-confirmation') and memoryWrites() == 0)
    assert(row('memory:forget-character').disabled)
    -- The choice survives leaving the page and coming back (the page says so: "Your selection is unchanged").
    assert(invoke('memory:select:person-20').ok)
    assert(invoke('memory:settings').ok and invoke('memory').ok)
    assert(row('memory-selected').value == 'Person 20')
    -- A confirmed forget clears the choice once the service reports it done; a failed one keeps it.
    reloadMemory(); assert(invoke('memory:forget-character').ok and invoke('memory:confirm:' .. token()).ok)
    local command = memoryRequest()
    assert(reloadMemory().selectedKey == 'person-20', 'the choice stays while the clear is pending')
    publishMemory(2, nil, 'ready', memoryResult(command, 'failed'))
    assert(reloadMemory().selectedKey == 'person-20' and reloadMemory().command.state == 'failed', 'a failed clear keeps the choice')
    -- Forget again from the kept choice; this time the service confirms it.
    publishMemory(2, nil)
    reloadMemory(); assert(invoke('memory:forget-character').ok and invoke('memory:confirm:' .. token()).ok)
    command = memoryRequest()
    publishMemory(2, nil, 'ready', memoryResult(command, 'succeeded'))
    local after = reloadMemory()
    assert(after.command.state == 'succeeded' and after.selectedKey == nil, 'a confirmed forget clears the choice')
    assert(row('memory-selected').value == 'Choose a character' and row('memory:forget-character').disabled)
    assert(row('memory-feedback').value:find('confirmed for Person 20', 1, true))
  `);
});

test('native Memory controls use the contacted count and full catalogue without inviting a character or exposing identity', () => {
  run(`${nsuiFixture}${memoryFixture}
    openMemory()
    assert(row('memory-service').value == 'Unavailable' and row('memory:forget-all').disabled)
    assert(not invoke('memory:forget-all').ok and memoryWrites() == 0)
    publishMemory(3, {{profileKey = 'johnny-silverhand'}, {profileKey = 'person-20'}, {profileKey = 'viktor-vektor'}})
    reloadMemory()
    assert(row('memory-count').value == '3' and not row('memory:forget-all').disabled)
    assert(row('memory:forget-character').disabled, 'selection must be explicit')
    -- The list is on the page, 12 characters to a page: Person 20 is on the second page.
    assert(row('ui:page').max == 2 and not row('memory:select:person-20'))
    assert(core.setUi('ui:page', 2)); loaded = registered.loadMod('manager')
    assert(row('memory:select:person-20') and not row('memory:select:person-01'))
    assert(invoke('memory:select:person-20').ok)
    assert(row('memory-selected').value == 'Person 20' and not row('memory:forget-character').disabled)
    assert(#members == 0 and #spawned == 0 and memoryWrites() == 0)
    assert(saved.memoryProfileKey == nil and saved.endUserId == nil)
    for _, category in ipairs(loaded.categories) do
      for _, value in ipairs(category.settings) do
        local text = tostring(value.label) .. tostring(value.value) .. tostring(value.description)
        assert(not text:find(memoryStatus.endUserId, 1, true), 'raw player identity reached the page')
      end
    end
    assert(row('memory-chat-history').description:find('clears their saved Chat messages and drafts', 1, true))
    manager.selectMemoryCharacter('person-19'); reloadMemory()
    assert(not row('memory:forget-character').disabled, 'An uncontacted configured character may still have local Chat to clear')
    assert(invoke('memory:forget-character').ok)
  `);
});

test('memory clear needs a separate confirmation, cancel sends nothing and deliberate double activation sends one command', () => {
  run(`${nsuiFixture}${memoryFixture}
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
    for _ = 1, 25 do managerUi.update(player, false) end
    assert(memoryWrites() == 1, 'pending cloud work was sent again')
  `);
});

test('choosing a character and cancelling a Forget confirmation say nothing was deleted and delete nothing', () => {
  run(`${nsuiFixture}${memoryFixture}
    publishMemory(2, {{profileKey = 'johnny-silverhand'}, {profileKey = 'person-20'}})
    local removed, originalRemove = {}, os.remove
    os.remove = function(path) removed[#removed + 1] = path; return originalRemove(path) end
    local function nothingDeleted()
      -- Settings saved or other exchange files may still swap through os.remove (a prepared-voices request used to); that is not stored memory.
      local touched = 0
      for _, path in ipairs(removed) do if not tostring(path):find('prepared-voices', 1, true) then touched = touched + 1 end end
      assert(memoryWrites() == 0 and memoryRequest() == nil and touched == 0, 'a choice or cancel touched stored memory')
      assert(#members == 0 and #spawned == 0)
    end
    local cancelled = 'Memory clear cancelled. Nothing was deleted.'
    openMemory()
    assert(not row('memory-feedback'), 'feedback appeared before any action')
    assert(row('memory-selected').value == 'Choose a character' and row('memory:forget-character').disabled)
    nothingDeleted()
    -- Choosing a character (on the second page of the list) asks before any Forget.
    assert(core.setUi('ui:page', 2)); loaded = registered.loadMod('manager')
    assert(invoke('memory:select:person-20').ok)
    assert(row('memory-selected').value == 'Person 20')
    nothingDeleted()
    -- A new confirmation must not sit beside an old note.
    assert(invoke('memory:forget-character').ok)
    assert(not row('memory-feedback') and row('memory-confirmation'))
    local firstToken = token()
    assert(invoke('memory:cancel:' .. firstToken).ok)
    assert(managerUi.inspect().shown == cancelled, 'the line under the way back says nothing was deleted')
    assert(row('memory-feedback').value == cancelled and not row('memory-confirmation'))
    assert(row('memory-selected').value == 'Person 20')
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

test('the Forget all row names what it does and carries the count in its name ("Forget all memories (6 characters)"); its button says only Forget', () => run(`${nsuiFixture}${memoryFixture}
  publishMemory(6, {})
  openMemory()
  local forget = row('memory:forget-all')
  assert(forget.type == 'action', 'a button row')
  assert(forget.label == 'Forget all memories (6 characters)', forget.label)
  assert(forget.value == 'Forget', 'the button text is one word, not "Forget (6 characters)": ' .. tostring(forget.value))
  assert(core.optionUnits(forget.label) <= core.BUTTON_LABEL_UNITS, 'the name fits a button row: ' .. core.optionUnits(forget.label))
  assert(managerUi.LAYOUT.buttonLabelUnits == core.BUTTON_LABEL_UNITS, 'the host and the page cut to the same figure')
  -- Two digits do not fit with the word, so the name carries the bare count; it never goes past the budget.
  publishMemory(12, {}); reloadMemory()
  assert(row('memory:forget-all').label == 'Forget all memories (12)' and core.optionUnits(row('memory:forget-all').label) <= core.BUTTON_LABEL_UNITS, row('memory:forget-all').label)
  publishMemory(0, {}); reloadMemory()
  assert(row('memory:forget-all').label == 'Forget all memories (0 characters)')
`));

test('a translation that is too wide for a button row falls back to the bare count and is never cut', () => run(`${nsuiFixture}${memoryFixture}
  convaiUiLocale.configure('en')
  local original = convaiUiLocale.t
  convaiUiLocale.t = function(text, values)
    if text == 'Forget all memories ({count} characters)' then return 'Forget every memory of every character you have talked to ({count} characters)' end
    return original(text, values)
  end
  publishMemory(6, {})
  openMemory()
  assert(row('memory:forget-all').label == 'Forget all memories (6)', 'a translation that does not fit keeps only the number: ' .. row('memory:forget-all').label)
  convaiUiLocale.t = original
`));

test('with a content pack that keeps a memory of its own, the memory page names the memory Forget acts on (the pack by name while it is on, the normal one when off); without such a pack nothing changes', () => run(`${nsuiFixture}${memoryFixture}
  publishMemory(6, {})
  openMemory()
  local plainAll, plainCharacter = row('memory:forget-all').description, row('memory:forget-character').description
  assert(not row('memory-in-use'), 'no content pack: no row')
  assert(not plainAll:find('memory in use', 1, true) and not plainCharacter:find('memory in use', 1, true))
  -- A pack that shares its memory (or none installed) reports nothing to name.
  convaiAddons = {contentMemory = function() return false, nil end}
  reloadMemory()
  assert(not row('memory-in-use') and row('memory:forget-all').description == plainAll)
  -- A pack with a separate memory is on: the page says so, by name, and every Forget row repeats it.
  convaiAddons = {contentMemory = function() return true, 'Medieval AI NPCs' end}
  reloadMemory()
  assert(row('memory-in-use').label == 'Memory in use' and row('memory-in-use').value == 'Medieval AI NPCs', tostring(row('memory-in-use') and row('memory-in-use').value))
  assert(row('memory-in-use').description:find('only the memory shown here', 1, true))
  assert(row('memory:forget-all').description == plainAll .. '\\n\\nThis clears the memory in use: Medieval AI NPCs.', row('memory:forget-all').description)
  assert(row('memory:forget-character').description:find('This clears the memory in use: Medieval AI NPCs.', 1, true))
  assert(invoke('memory:forget-all').ok)
  assert(row('memory-confirmation').description:find('This clears the memory in use: Medieval AI NPCs.', 1, true), row('memory-confirmation').description)
  assert(invoke('memory:cancel:' .. token()).ok)
  -- The pack is installed but switched off: the normal memory is the one in use.
  convaiAddons = {contentMemory = function() return true, nil end}
  reloadMemory()
  assert(row('memory-in-use').value == 'Normal memory')
  assert(row('memory:forget-all').description:find('This clears the memory in use: Normal memory.', 1, true))
`));

test('Memory permits deliberate local Chat clearing with zero contacted provider pairs', () => run(`${nsuiFixture}${memoryFixture}
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

test('Relationships are a page that opens from Conversations and only applied selections reach saved modes', () => run(`${nsuiFixture}
  assert(invoke('tab:settings').ok and row('relationships').value=='Open' and not row('relationship:judy-alvarez'))
  assert(invoke('relationships').ok and row('relationships:back').value=='Back')
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
  assert(row('relationship:judy-alvarez') and not row('disappearingMessages'))
`));

test('the Characters sidebar shows the settings in effect for each character, not invitation advice', () => run(`${nsuiFixture}${memoryFixture}
  local list = {{key = 'judy-alvarez', name = 'Judy Alvarez', records = {'Character.Judy'}, summary = 'A braindance editor.', voiceName = 'Julia'},
    {key = 'viktor-vektor', name = 'Viktor Vektor', records = {'Character.Victor_Vector'}, summary = 'A ripperdoc.'}}
  for index = 1, 40 do list[#list + 1] = {key = 'extra-' .. index, name = string.format('Extra %02d', index), records = {'Character.Extra_' .. index}} end
  manager.configure(api, list)
  -- Characters are listed 12 to a page: look for the row on each page in turn, and leave the list on its first.
  local function description(key)
    local found
    for page = 1, 20 do
      core.setUi('ui:page', page); loaded = registered.loadMod('manager')
      found = row('invite:' .. key)
      if found or not row('ui:page') or page >= row('ui:page').max then break end
    end
    core.setUi('ui:page', 1)
    return assert(found, key).description
  end
  local function reload() core.setUi('ui:page', 1); loaded = registered.loadMod('manager') end
  assert(invoke('tab:characters').ok)
  reload()
  -- Nothing is on (V’s voice and both reactions are on by default, so they are switched off first)
  -- and nobody is in the party: the description, the voice and the conversation, and no advice text.
  assert(manager.applySettings(player, {vVoice = false, battleReactions = false, lootReactions = false})); reload()
  local plain = description('viktor-vektor')
  -- The default voice is Pocket and the bridge has not answered: the settings predict it (the Convai voice is named only when it speaks).
  assert(plain == 'A ripperdoc.\\n\\nVoice: Pocket · Performance\\nConversation: On', plain)
  assert(not plain:find('Invitations create', 1, true) and not plain:find('phone contacts', 1, true) and not plain:find('Memory and connection', 1, true))
  assert(description('judy-alvarez'):find('Relationship: Auto', 1, true), 'Judy has a relationship line')
  -- Judy in the party on OmniVoice, with the speech settings and a memory of the player.
  assert(manager.applySettings(player, {voiceProvider = 'omni', omniSteps = 16, omniReference = 'short', naturalSpeech = true,
    relationshipModes = {['judy-alvarez'] = 'on'},
    battleReactions = true, lootReactions = true}))
  jsonFixtures['voice-runtime'] = {state = 'ready', provider = 'omni', omniSteps = 16, omniReference = 'short',
    routedProfiles = {'judy-alvarez'}, updated = memoryClock * 1000.0}
  files['runtime/local-voice-state.json'] = 'voice-runtime'
  publishMemory(1, {{profileKey = 'judy-alvarez'}})
  api.spawn('judy-alvarez'); members[1].state = 'ready'
  reload()
  local judy = description('judy-alvarez')
  assert(judy == table.concat({'A braindance editor.', '', 'Voice: OmniVoice · Balanced', 'Conversation: On', 'Relationship: Romantic',
    'Speech: Natural speech',
    'Memory: remembers your conversations', 'In your party: 1',
    'Behavior: React to battles · React to collected loot'}, '\\n'), judy)
  -- A character who is not in the party keeps the speech lines, not the party ones; with no memory there is no memory line.
  local viktor = description('viktor-vektor')
  assert(viktor:find('Speech: Natural speech', 1, true) and not viktor:find('Multilingual', 1, true), 'no Multilingual line: the language is automatic')
  assert(not viktor:find('Expressive emotions', 1, true) and not viktor:find('Body gestures', 1, true), 'the retired settings are never named')
  assert(not viktor:find('Memory:', 1, true) and not viktor:find('In your party', 1, true) and not viktor:find('Behavior', 1, true)
    and not viktor:find('Relationship', 1, true), viktor)
  -- Without the optional pack, a saved OmniVoice choice that is not running says so; switching a behavior off drops its name.
  jsonFixtures['voice-runtime-nopack'] = {state = 'ready', provider = 'pocket', routedProfiles = {}, updated = memoryClock * 1000.0,
    omniPack = {installed = false, missing = {}}}
  files['runtime/local-voice-state.json'] = 'voice-runtime-nopack'
  assert(manager.applySettings(player, {battleReactions = false, lootReactions = false}))
  reload()
  assert(description('viktor-vektor'):find('Voice: OmniVoice · Balanced · needs Omni pack', 1, true), description('viktor-vektor'))
  local judyLines = description('judy-alvarez')
  assert(not judyLines:find('Behavior', 1, true) and not judyLines:find('Body gestures', 1, true), judyLines)
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

// The "Voice:" line names the voice that really speaks (feat/features-on): the Convai voice only when it speaks, "Text only" when none does.
test('the Characters sidebar names the voice actually used, or text when there is none, never a Convai voice that is not speaking', () => run(`${nsuiFixture}${memoryFixture}
  local list = {{key = 'judy-alvarez', name = 'Judy Alvarez', records = {'Character.Judy'}, summary = 'A braindance editor.', voiceName = 'Julia'},
    {key = 'viktor-vektor', name = 'Viktor Vektor', records = {'Character.Victor_Vector'}, summary = 'A ripperdoc.', voiceName = 'Viktor Voice'}}
  manager.configure(api, list)
  local function voiceOf(key)
    local found
    core.setUi('ui:page', 1); loaded = registered.loadMod('manager')
    found = assert(row('invite:' .. key), key).description
    return found:match('Voice: ([^\\n]*)')
  end
  local function bridge(state)
    state.updated = memoryClock * 1000.0
    labelSequence = (labelSequence or 0) + 1 -- a new token each time: the same text is the same (cached) state
    local token = 'voice-label-' .. labelSequence
    jsonFixtures[token] = state
    files['runtime/local-voice-state.json'] = token
  end
  assert(invoke('tab:characters').ok)
  -- No answer from the bridge yet: the settings predict the route.
  assert(manager.applySettings(player, {voiceProvider = 'convai'}))
  assert(voiceOf('judy-alvarez') == 'Julia', 'the Convai voice, on a Convai provider')
  assert(manager.applySettings(player, {conversationProvider = 'local'}))
  assert(voiceOf('judy-alvarez') == 'Pocket · Performance', 'beside a text provider the Convai voice choice plays Pocket: ' .. tostring(voiceOf('judy-alvarez')))
  assert(manager.applySettings(player, {conversationProvider = 'convai', voiceProvider = 'pocket'}))
  assert(voiceOf('judy-alvarez') == 'Pocket · Performance')
  -- The bridge answers: Pocket speaks Judy, not Viktor (no clip of him), so his replies are written, not given the Convai voice.
  bridge({state = 'ready', provider = 'pocket', requestedProvider = 'pocket', routedProfiles = {'judy-alvarez'}, playbackEnabled = true})
  assert(voiceOf('judy-alvarez') == 'Pocket · Performance')
  assert(voiceOf('viktor-vektor') == 'Text only (no voice)', 'an unrouted character is written: ' .. tostring(voiceOf('viktor-vektor')))
  -- The voice list still being checked: the chosen voice is named, not a flash of text.
  bridge({state = 'loading', provider = 'pocket', requestedProvider = 'pocket', routedProfiles = {}, availabilityPending = true, playbackEnabled = true})
  assert(voiceOf('viktor-vektor') == 'Pocket · Performance')
  -- The chosen local voice cannot run and nothing stands in for it (the route is text), whatever the settings say.
  assert(manager.applySettings(player, {voiceProvider = 'convai'}))
  bridge({state = 'disabled', provider = 'text', requestedProvider = 'omni', routedProfiles = {}, playbackEnabled = true,
    fallback = {from = 'omni', to = 'text'}})
  assert(voiceOf('judy-alvarez') == 'Text only (no voice)', tostring(voiceOf('judy-alvarez')))
  -- The player chose the Convai voice and the bridge routes it: the character's Convai voice name.
  bridge({state = 'remote', provider = 'convai', requestedProvider = 'convai', routedProfiles = {}, playbackEnabled = true})
  assert(voiceOf('judy-alvarez') == 'Julia' and voiceOf('viktor-vektor') == 'Viktor Voice')
  -- Local AI or another text provider writes the replies and the bridge plays Pocket for the Convai voice choice.
  bridge({state = 'ready', provider = 'pocket', requestedProvider = 'convai', routedProfiles = {'judy-alvarez'}, playbackEnabled = true})
  assert(voiceOf('judy-alvarez') == 'Pocket · Performance' and voiceOf('viktor-vektor') == 'Text only (no voice)')
  -- The Mistral voice that cannot be asked (a refused key, a limit cooling down) falls to written text; without a key it says so.
  local clock = 1000; os.clock = function() return clock end
  local function mistralKey(saved)
    mistralSequence = (mistralSequence or 0) + 1
    jsonFixtures['mistral-label-' .. mistralSequence] = {provider = 'convai', effective = 'convai', saved = saved}
    files['runtime/mistral-state.json'] = 'mistral-label-' .. mistralSequence
    clock = clock + 2
  end
  mistralKey(true)
  assert(manager.applySettings(player, {voiceProvider = 'voxtral'}))
  bridge({state = 'remote', provider = 'pocket', requestedProvider = 'voxtral', cloudVoice = 'voxtral', routedProfiles = {'judy-alvarez'},
    playbackEnabled = true})
  assert(voiceOf('judy-alvarez') == 'Mistral cloud voice (Voxtral)', tostring(voiceOf('judy-alvarez')))
  bridge({state = 'remote', provider = 'pocket', requestedProvider = 'voxtral', cloudVoice = 'voxtral', routedProfiles = {'judy-alvarez'},
    playbackEnabled = true, fallback = {from = 'voxtral', to = 'text', reason = 'quota'}})
  assert(voiceOf('judy-alvarez') == 'Text only (no voice)', 'a cloud voice that cannot be asked is written: ' .. tostring(voiceOf('judy-alvarez')))
  mistralKey(false)
  assert(voiceOf('judy-alvarez'):find('needs Mistral key', 1, true), tostring(voiceOf('judy-alvarez')))
  mistralKey(true)
  -- Voice playback off: nothing is spoken, whatever the voice choice is.
  assert(manager.applySettings(player, {voiceProvider = 'pocket', voice = false}))
  bridge({state = 'stopped', provider = 'pocket', requestedProvider = 'pocket', routedProfiles = {'judy-alvarez'}, playbackEnabled = false})
  assert(voiceOf('judy-alvarez') == 'Text only (no voice)')
  assert(manager.applySettings(player, {voice = true}))
  bridge({state = 'ready', provider = 'pocket', requestedProvider = 'pocket', routedProfiles = {'judy-alvarez'}, playbackEnabled = false})
  assert(voiceOf('judy-alvarez') == 'Text only (no voice)', 'the bridge says playback is off')
`));

test('memory completion requires exact ID, scope, profile and a current result; old success cannot complete a later request', () => {
  run(`${nsuiFixture}${memoryFixture}
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
  run(`${nsuiFixture}${memoryFixture}
    math.randomseed(42)
    publishMemory(1, {{profileKey = 'person-20'}})
    openMemory()
    assert(manager.selectMemoryCharacter('person-20'))
    reloadMemory(); assert(invoke('memory:forget-character').ok)
    assert(invoke('memory:confirm:' .. token()).ok)
    local command, raw = memoryRequest(), files['runtime/memory-command.json']
    manager.reset(); player.hash = 'player-2'; managerUi.resetSession()
    assert(reloadMemory().command.id == command.id)
    assert(manager.snapshot(player).memory.command.state == 'pending' and memoryWrites() == 1)
    memoryClock = memoryClock + 60
    local state = reloadMemory()
    assert(state.state == 'unavailable' and state.command.state == 'pending')
    -- A new world starts on the first page: open the Memory page again.
    openMemory(); loaded = registered.loadMod('manager')
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
  run(`${nsuiFixture}${memoryFixture}
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
    managerUi.resetSession(); reloadMemory()
    assert(not manager.confirmMemoryClear(third) and not row('memory-confirmation'))
    assert(memoryWrites() == 0 and memoryRequest() == nil)
  `);
});

test('failed command publication shows failure, does not retry and leaves an earlier durable command intact', () => {
  run(`${nsuiFixture}${memoryFixture}
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
    for _ = 1, 10 do managerUi.update(player, false) end
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
    assert(manager.beginMemoryClear('all'))
    assert(manager.confirmMemoryClear(manager.snapshot(player).memory.confirmation.token))
    assert(#removed == 0 and #renamed == 0, 'a command file was removed or renamed: ' .. table.concat(removed, ',') .. '|' .. table.concat(renamed, ','))
    local seen = {}
    for _, path in ipairs(opened) do
      assert(not path:find('.tmp', 1, true) and not path:find('.previous', 1, true), 'a side file was opened: ' .. path)
      seen[path] = (seen[path] or 0) + 1
    end
    for _, path in ipairs({'own-key-command', 'mistral-key-command'}) do
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

test('the manager page uses real controls, operates on current copies while paused, and applies settings as one transaction', () => {
  run(`${nsuiFixture}
    assert(core.model().name == 'Companion Manager' and loaded.categories[1].id == 'navigation')
    assert(invoke('tab:characters').ok)
    assert(row('invite:johnny-silverhand').type == 'action')
    assert(invoke('invite:johnny-silverhand').ok)
    managerUi.update(player, false)
    assert(#spawned == 0 and #managerUi.inspect().party == 1)
    assert(invoke('characters:back').ok and invoke('tab:party').ok)
    assert(row('dismiss:queued:1').value == 'Cancel invitation')
    assert(not row('assign:queued:1'), 'a per-copy conversation entry remained on Current party')
    assert(managerUi.party().assign('queued:1', 'person-1', 'Person 01'))
    assert(invoke('party:back').ok and invoke('tab:settings').ok)
    assert(row('voice') == nil and row('omniSteps') == nil, 'the playback switch is the Off entry of Companion voices')
    assert(row('subtitles') == nil, 'the Subtitles switch is the Off entry of the Subtitles list')
    -- Order: 1 Off (stored subtitles false), 2 Cinematic subtitles (stored dialogue, the default), 3 Above the speaker (stored overhead).
    assert(row('subtitleStyle').type == 'select' and row('subtitleStyle').value == 2)
    assert(row('subtitleStyle').defaultValue == 2 and row('subtitleStyle').type == 'select')
    assert(row('subtitleStyle').elements[1] == 'Off' and row('subtitleStyle').elements[2] == 'Cinematic subtitles' and row('subtitleStyle').elements[3] == 'Above the speaker')
    assert(row('voiceProvider').type == 'select' and row('voiceProvider').value == 2)
    assert(row('keepPreparedVoices') == nil)
    assert(row('voice-pack') == nil, 'the OmniVoice pack has no row of its own')
    assert(row('disappearingMessages') == nil)
    assert(row('battleReactions').type == 'bool' and row('battleReactions').value == true and row('battleReactions').defaultValue == true)
    assert(row('lootReactions').type == 'bool' and row('lootReactions').value == true and row('lootReactions').defaultValue == true)
    -- The retired follow-up question toggle is no longer offered.
    assert(row('followUpQuestions') == nil)
    assert(registered.applyBatch('manager', {{id = 'lootReactions', value = false}}).ok)
    assert(not manager.lootReactions())
    assert(registered.applyBatch('manager', {{id = 'battleReactions', value = false}}).ok)
    assert(not manager.battleReactions())
    local applied = registered.applyBatch('manager', {{id = 'voice', value = false}, {id = 'voiceProvider', value = 8}, {id = 'subtitleStyle', value = 3}})
    assert(applied.ok and applied.atomic and #applied.appliedIds == 4 and saved.omniSteps == 16)
    local retired = registered.applyBatch('manager', {{id = 'expressiveEmotions', value = false}})
    assert(retired.ok == false and retired.error == 'That setting is read-only.', 'a setting that is gone has no Apply branch')
    assert(saved.voiceProvider == 'convai')
    loaded = registered.loadMod('manager')
    assert(manager.subtitleStyle() == 'overhead' and row('subtitleStyle').value == 3)
    for _, invalid in ipairs({0, 4, '1', 'overhead', false}) do
      assert(not registered.applyBatch('manager', {{id = 'subtitles', value = false}, {id = 'subtitleStyle', value = invalid}}).ok)
      assert(manager.subtitleStyle() == 'overhead' and player.subtitles)
    end
    assert(registered.applyBatch('manager', {{id = 'subtitleStyle', value = 2}}).ok)
    assert(manager.subtitleStyle() == 'dialogue' and saved.voiceProvider == 'convai')
    assert(not registered.applyBatch('manager', {{id = 'voiceProvider', value = 10}}).ok)
    assert(not registered.applyBatch('manager', {{id = 'voiceProvider', value = 9}}).ok, 'there are seven voices and Off')
    assert(not registered.applyBatch('manager', {{id = 'voiceProvider', value = 0}}).ok)
    assert(not registered.applyBatch('manager', {{id = 'voiceProvider', value = '1'}}).ok)
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 5}}).ok)
    assert(saved.voiceProvider == 'omni' and saved.omniSteps == 16 and saved.omniReference == 'long')
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 6}}).ok)
    assert(saved.voiceProvider == 'omni' and saved.omniSteps == 32 and saved.omniReference == 'short')
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 8}}).ok and saved.voiceProvider == 'convai')
    assert(not registered.applyBatch('manager', {{id = 'voiceProvider', value = 1}, {id = 'omniSteps', value = 1}}).ok)
    assert(saved.voice == true and saved.voiceProvider == 'convai', 'retired quality changes partially applied')
    assert(not registered.applyBatch('manager', {{id = 'disappearingMessages', value = true}}).ok)
    assert(player.voice == true)
    managerUi.update(player, true)
    assert(#spawned == 1 and members[1].profileKey == 'person-1')
    assert(invoke('settings:back').ok and invoke('tab:party').ok and row('dismiss:live:1'))
    managerUi.shutdown()
  `);
});

test('settings review wording: short voice description, no Body gestures or Auto-connect row, full Developer mode text, Model browser says what it lists', () => {
  run(`${nsuiFixture}
    local home = row('tab:models')
    assert(home and home.label == 'Model browser')
    assert(home.description:find('without conversation support', 1, true) and home.description:find('do not talk', 1, true))
    assert(invoke('tab:settings').ok)
    local voices = row('voiceProvider')
    assert(voices.defaultValue == 2 and voices.value == 2)
    assert(voices.description:find('about 0.2 s', 1, true) and voices.description:find('1 to 2.5 s', 1, true))
    assert(not voices.description:find('%', 1, true), 'no listening percentages in the voice description')
    assert(utf8.len(voices.description) < 700 and select(2, voices.description:gsub(string.char(10) .. string.char(10), '')) >= 2, 'the voice description stays short and is split into blocks')
    assert(not voices.description:lower():find('recommended', 1, true), 'the voice description does not call a voice recommended; the Voxtral entry does')
    -- Only the Voxtral entry says recommended, directly after Pocket (with a Mistral key saved); every other voice entry stays plain.
    for index, label in ipairs(voices.elements) do
      assert((label:lower():find('recommended', 1, true) ~= nil) == (index == 3 and label == 'Voxtral (recommended)'), 'entry ' .. index .. ': ' .. label)
    end
    assert(voices.elements[1] == 'Off' and voices.elements[2] == 'Pocket · Performance' and voices.elements[3]:find('Voxtral', 1, true) == 1, voices.elements[3])
    assert(row('bodyGestures') == nil, 'body gestures are always on: there is no row')
    assert(row('sitWithYou') == nil, 'companions always sit with V: there is no Sit with you setting')
    assert(row('autoConnectNearby') == nil and row('keepPreparedVoices') == nil)
    local developer = row('developerMode').description
    for _, part in ipairs({'popups', 'movement trace', 'gesture', 'support reports'}) do
      assert(developer:find(part, 1, true), 'Developer mode must say it enables ' .. part)
    end
    assert(row('headFollowStrength').defaultValue == 3)
    assert(manager.snapshot(player).settings.headFollowStrength == 1, 'the saved strength values are unchanged')
    -- Developer mode adds nothing to the voice description.
    assert(manager.applySettings(player, {developerMode = true}))
    loaded = registered.loadMod('manager')
    assert(row('voiceProvider').description == voices.description)
  `);
});

test('gaze controls use ordinary selectors and persist', () => {
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    for _,id in ipairs({'eyeContactHeight','headFollowStrength'}) do
      local setting=row(id)
      assert(setting and setting.type=='select' and setting.value==3 and setting.defaultValue==3)
      assert(setting.type == 'select' and setting.defaultValue ~= nil)
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
    drafts=true; managerUi.update(player,false)
    assert(reloads==before,'ordinary gaze settings disturbed the open page')
  `);
});

test('the model browser leaves out the game\'s retired records ("!OBSOLETE ..."), lists unnamed records and internal codes after the real names, and counts what it lists', () => {
  run(`${nsuiFixture}
    local names = {'!OBSOLETE', '!OBSOLETE - 6th Street Soldier', 'Zed', '1H-DNC-LAÖ', 'Anna', 'T-Bug', 'Judy', 'Саша-2', '  !hidden', 'Old OBSOLETE Guard'}
    local byId = {}
    function TweakDB:GetRecords(kind)
      local result = {}
      for index, name in ipairs(names) do
        local id = 'Character.Rec_' .. index
        byId[id] = name
        result[index] = {GetID = function() return id end}
      end
      return result
    end
    function TweakDB:GetFlat(flat) local id = flat:gsub('%.displayName$', ''); return byId[id] or id end
    assert(invoke('tab:models').ok)
    for _ = 1, 8 do managerUi.update(player, false) end
    loaded = registered.loadMod('manager')
    assert(row('model-status').label == '6 matching models', 'the count is what is listed: ' .. tostring(row('model-status').label))
    local listed = {}
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings) do if item.id:sub(1, 7) == 'invite:' then listed[#listed + 1] = item.label end end
    end
    assert(table.concat(listed, ' | ') == 'Anna | Judy | T-Bug | Zed | Саша-2 | 1H-DNC-LAÖ', table.concat(listed, ' | '))
    assert(core.retiredModel({name = '!OBSOLETE'}) and not core.retiredModel({name = 'Judy Alvarez'}))
    assert(not core.placeholderModel({name = 'V'}) and not core.placeholderModel({name = 'NCPD'}) and not core.placeholderModel({name = 'Saša'}))
    assert(core.placeholderModel({name = 'DNC-12'}) and core.placeholderModel({name = 'Character.X', record = 'Character.X'}))
    -- A letter group counts the same way: the codes are in the # group, and the retired records in none.
    local groups = row('ui:group').elements
    assert(groups[2] == '#' and table.concat(groups, ','):find('!', 1, true) == nil, table.concat(groups, ','))
  `);
});

// 2026-10-25 (owner): our own Rita Wheeler is invitable like anyone else, even with Night City Allies installed. Lucy stays talk only.
test('Rita Wheeler is invitable from the Characters page and the Model browser; the model shows her profile name, not the generic "Mox", and "mox" still finds her', () => {
  run(`${nsuiFixture}
    local rita = {key = 'rita-wheeler', name = 'Rita Wheeler', records = {'Character.lizzies_bouncer', 'NCA.Character.lizzies_bouncer'}}
    manager.configure(api, {rita, {key = 'lucy-kushinada', name = 'Lucy Kushinada', invite = false,
      records = {'Character.EdgerunnersLucy_Merc', 'NCA.Character.EdgerunnersLucy_Merc'}}})
    assert(defs['rita-wheeler'] and defs['rita-wheeler'].id == 'Character.lizzies_bouncer', 'a definition from her first record')
    assert(defs['lucy-kushinada'] == nil, 'Lucy stays talk only')
    local names = {['Character.lizzies_bouncer'] = 'Mox', ['Character.q105_valentino_ma'] = 'Valentino'}
    local ids = {'Character.lizzies_bouncer', 'NCA.Character.lizzies_bouncer', 'Character.q105_valentino_ma', 'Character.CorpoWomanBag',
      'Character.tyger_claws_gang3_katana_wa', 'Character.wat_kab_ripperdoc_01', 'Character.NCPDOfficer', 'Character.01'}
    function TweakDB:GetRecords()
      local result = {}
      for index, id in ipairs(ids) do result[index] = {GetID = function() return id end} end
      return result
    end
    function TweakDB:GetFlat(flat) local id = flat:gsub('%.displayName$', ''); return names[id] or id end
    assert(invoke('tab:characters').ok); loaded = registered.loadMod('manager')
    assert(row('invite:rita-wheeler') and row('invite:rita-wheeler').value == 'Invite', 'Rita is in the Characters list with an Invite')
    assert(row('invite:lucy-kushinada') and row('invite:lucy-kushinada').value == 'Profile only', 'Lucy is a profile only')
    assert(invoke('invite:rita-wheeler').ok); managerUi.update(player, true)
    assert(members[1].key == 'rita-wheeler' and members[1].profileKey == 'rita-wheeler')
    assert(invoke('characters:back').ok and invoke('tab:models').ok)
    for _ = 1, 4 do managerUi.update(player, false) end
    loaded = registered.loadMod('manager')
    local byRecord = {}
    for _, model in ipairs(manager.snapshot(player).models) do byRecord[model.record] = model end
    local function check(id, name, derived)
      assert(byRecord[id] and byRecord[id].name == name, id .. ' -> ' .. tostring(byRecord[id] and byRecord[id].name))
      assert((byRecord[id].derived == true) == derived, id .. ' derived')
    end
    -- The roster profile's name first (the game calls her Mox), then the game's name, then one made from the record id.
    check('Character.lizzies_bouncer', 'Rita Wheeler', false)
    check('NCA.Character.lizzies_bouncer', 'Rita Wheeler', false)
    check('Character.q105_valentino_ma', 'Valentino', false)
    check('Character.CorpoWomanBag', 'Corpo Woman Bag', true)
    check('Character.tyger_claws_gang3_katana_wa', 'Tyger Claws Gang 3 Katana (F)', true)
    check('Character.wat_kab_ripperdoc_01', 'Wat Kab Ripperdoc 1', true)
    check('Character.NCPDOfficer', 'NCPD Officer', true)
    assert(byRecord['Character.01'].unnamedIndex == 8 and byRecord['Character.01'].name == 'Unnamed model 8', 'nothing readable left: an unnamed model')
    assert(manager.readableRecordName('Character.lizzies_bouncer') == 'Lizzies Bouncer'
      and manager.readableRecordName('Character.sq012_panamPalmer_2') == 'Panam Palmer 2' and manager.readableRecordName('x.y') == 'Y'
      and manager.readableRecordName('Character.') == nil and manager.readableRecordName(nil) == nil)
    -- The raw record stays in the details and in the search, with the game's own name for the replaced one.
    local function matching(typed) core.setSearch(typed); loaded = registered.loadMod('manager'); return row('model-status').label end
    assert(matching('rita') == '2 matching models' and matching('lizzies_bouncer') == '2 matching models')
    assert(matching('mox') == '1 matching models', 'the game name of a profiled record is searched too')
    assert(matching('corpo woman') == '1 matching models' and matching('Character.CorpoWomanBag') == '1 matching models')
    core.setSearch('rita'); loaded = registered.loadMod('manager')
    local description
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings) do
        if item.id == 'invite:' .. byRecord['Character.lizzies_bouncer'].key then description = item.description end
      end
    end
    assert(description:find('Character.lizzies_bouncer', 1, true) and description:find('Conversation: Rita Wheeler', 1, true), description)
    -- The names made from a record id are listed after the real ones, in the group of their first letter.
    core.setSearch(''); loaded = registered.loadMod('manager')
    local listed = {}
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings) do if item.id:sub(1, 7) == 'invite:' then listed[#listed + 1] = item.label end end
    end
    assert(listed[1] == 'Rita Wheeler' and listed[2] == 'Rita Wheeler' and listed[3] == 'Valentino' and listed[4] == 'Corpo Woman Bag', table.concat(listed, ' | '))
  `);
});

test('the Model browser search words: any order, parts of words, any case and spacing; the search belongs to the browser page and is dropped when the page is left', () => {
  run(`${nsuiFixture}
    local text, words = core.searchWords('  Rita   WHEELER ')
    assert(text == 'rita wheeler' and #words == 2 and words[1] == 'rita' and words[2] == 'wheeler')
    assert(core.searchWords(nil) == '' and core.searchWords('   ') == '' and #select(2, core.searchWords('')) == 0)
    assert(#core.searchWords(string.rep('ab ', 100)) <= 100, 'a very long text is cut')
    local rita = {name = 'Rita Wheeler', record = 'Character.rita_wheeler', profileName = 'Rita Wheeler',
      search = 'rita wheeler character.rita_wheeler rita wheeler'}
    local function matches(model, typed) return core.modelMatches(model, select(2, core.searchWords(typed))) end
    for _, typed in ipairs({'rita', 'wheel', 'RITA wheeler', 'wheeler   rita', 'rita_wheel', 'a w', ''}) do assert(matches(rita, typed), typed) end
    for _, typed in ipairs({'rita smith', 'judy', 'wheelers', 'ritaa'}) do assert(not matches(rita, typed), typed) end
    -- A model without the text the scan makes is searched by its name, its record and its conversation profile.
    local judy = {name = 'Judy Alvarez', record = 'Character.judy', profileName = 'Judy Alvarez'}
    assert(matches(judy, 'ALVAREZ judy') and matches(judy, 'character.judy') and not matches(judy, 'rita'))
    assert(matches({name = 'Zed'}, 'zed') and not matches({}, 'zed'))

    -- Only the browser has a search: another page ignores it.
    assert(core.setSearch('rita') == false and core.search() == '')
    assert(invoke('tab:models').ok)
    for _ = 1, 126 do managerUi.update(player, false) end
    loaded = registered.loadMod('manager')
    assert(scans == 1 and row('model-status').label == '6000 matching models')
    local id = core.pageId()
    assert(core.setSearch('  MODEL_600 ') == true and core.search() == 'model_600')
    assert(core.pageId() == id .. '|model_600', 'a new text is a new page: ' .. core.pageId())
    assert(core.setSearch('model_600') == false and core.setSearch('Model_600   ') == false, 'the same words are no change')
    assert(core.stale(), 'the page is drawn again for the text')
    loaded = registered.loadMod('manager')
    assert(row('model-status').label == '2 matching models', row('model-status').label)
    local listed = {}
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings) do if item.id:sub(1, 7) == 'invite:' then listed[#listed + 1] = item.label end end
    end
    assert(table.concat(listed, ' | ') == 'Model 600 | Model 6000', table.concat(listed, ' | '))
    assert(row('ui:group') == nil and row('ui:page') == nil, 'a letter group and a page slider are no use for two models')
    -- A result is invited like any other row, and the scan is not made again.
    assert(invoke('invite:model:600').ok)
    assert(scans == 1, 'a search never reads the game again')
    core.setSearch('nobody at all'); loaded = registered.loadMod('manager')
    assert(row('model-status').label == '0 matching models' and not row('invite:model:600'))
    -- Leaving the page drops the text; so does opening it again.
    assert(invoke('models:back').ok and core.search() == '' and core.view() == 'home')
    assert(invoke('tab:models').ok and core.search() == '')
    core.setSearch('model_6000'); core.setView('models'); assert(core.search() == '', 'a page opened by the host starts unfiltered')
  `);
});

test('the Model browser tells a host that has a search box how to use it, and says nothing to one that has none', () => {
  run(`${nsuiFixture}
    assert(invoke('tab:models').ok)
    for _ = 1, 126 do managerUi.update(player, false) end
    loaded = registered.loadMod('manager')
    assert(not row('model-status').description:find('search box', 1, true), 'Native Settings UI has no search box: ' .. row('model-status').description)
    core.offerSearch(true); loaded = registered.loadMod('manager')
    local help = row('model-status').description
    assert(help:find('Type in the search box to find a model by name or record', 1, true), help)
    core.offerSearch(false); loaded = registered.loadMod('manager')
    assert(not row('model-status').description:find('search box', 1, true))
  `);
});

test('the model browser covers the full installed catalogue while exposing bounded pages of rows', () => {
  run(`${nsuiFixture}
    assert(scans == 0)
    assert(invoke('tab:models').ok)
    -- Reading the models: only the status line shows until the scan has finished (the list is sorted then).
    managerUi.update(player, false)
    loaded = registered.loadMod('manager')
    assert(row('model-status').label == 'Reading installed models…' and not row('ui:page'))
    for _ = 1, 126 do managerUi.update(player, false) end
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
    -- Twelve rows a page, 500 pages, all one letter group: the pages are read with the slider.
    assert(countInvites() == 12 and row('ui:page').max == 500 and row('ui:group') and row('ui:group').elements[1] == 'All')
    -- Silverhand shows under the roster profile's name (J), the 5999 records without a name under the one made from the record id (M).
    assert(table.concat(row('ui:group').elements, ',') == 'All,J,M', table.concat(row('ui:group').elements, ','))
    local at
    for page = 1, 500 do
      assert(core.setUi('ui:page', page) or page == 1); loaded = registered.loadMod('manager')
      assert(countInvites() <= 12, 'a page holds more than twelve rows')
      if row('invite:model:6000') then at = page; break end
    end
    assert(at, 'the last model is on no page')
    assert(invoke('invite:model:6000').ok and #spawned == 0)
    managerUi.update(player, true); assert(members[1].key == 'model:6000')
    assert(members[1].profileKey == nil)
    assert(invoke('models:back').ok and invoke('tab:party').ok and managerUi.inspect().view == 'party')
  `);
});

test('the manager shows no invitation progress and keeps reserved copies editable until actual attachment', () => {
  run(`${nsuiFixture}${invitationFixture}
    assert(invoke('tab:characters').ok)
    assert(invoke('invite:johnny-silverhand').ok)
    local id = party.list()[1].id
    assert(readiness.prepareCalls == 1 and readiness.jobs[id].profileKey == 'johnny-silverhand')
    assert(#spawned == 0 and party.count() == 1 and not row('party-count'))
    assert(invoke('characters:back').ok and invoke('tab:party').ok)
    -- One row per copy: no status text, count, conversation entry or last action.
    assert(not row('party-count') and not row('feedback') and not row('state:' .. id) and not row('assign:' .. id))
    assert(row('dismiss:' .. id).value == 'Cancel invitation' and row('dismiss:' .. id).type == 'action')
    readiness.receipts[id] = {state = 'connecting'}
    readiness.update(); managerUi.update(player, false)
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
    -- A failed invitation reads as failed (Remove, not Cancel invitation) while the paused menu still lists it.
    assert(row('dismiss:' .. id).value == 'Remove')
    assert(invoke('dismiss:' .. id).ok and readiness.cancellations[id])
    assert(party.count() == 0 and not row('dismiss:' .. id) and not row('error:' .. id) and row('empty-party') and #spawned == 0)

    -- Phone and native actions receive the same queue and reserved capacity.
    assert(party.invite('johnny-silverhand'))
    id = party.list()[1].id
    readiness.receipts[id] = {state = 'ready'}
    loaded = registered.loadMod('manager')
    assert(row('dismiss:' .. id).value == 'Cancel invitation' and not row('state:' .. id) and not row('party-count'))
    managerUi.update(player, false)
    assert(#spawned == 0, 'readiness created an actor while gameplay was paused')
    managerUi.update(player, true)
    loaded = registered.loadMod('manager')
    assert(#spawned == 1 and row('dismiss:live:1').value == 'Dismiss' and not row('state:live:1'))
    assert(not party.message():find('joined your group', 1, true), 'accepted spawn was reported as joined')
    -- The queue is flushed on the settings integration's 0.25 s tick.
    local tickClock = os.clock()
    os.clock = function() return tickClock + 1 end
    members[1].state = 'ready'; managerUi.update(player, true)
    loaded = registered.loadMod('manager')
    assert(not row('state:live:1') and party.message():find('joined your group', 1, true))
    assert(row('dismiss:live:1').label == 'Johnny Silverhand #1', 'a copy row is its name and number')
  `);
});

test('Microphone is a Voices select: Windows default first, then the listed inputs, a saved input that is gone follows as not connected; the choice is saved by its name', () => {
  run(`${nsuiFixture}
    local clock = 1000; os.clock = function() return clock end
    assert(invoke('tab:settings').ok)
    local loaded = registered.loadMod('manager')
    -- Nothing listed yet: only the default, and the page asked the service for the list (one command, not one per build).
    local item = assert(row('micDevice'))
    assert(item.type == 'select' and item.value == 1 and #item.elements == 1 and item.elements[1] == 'Windows default')
    local ask = jsonFixtures[files['runtime/microphone-devices-command.json']]
    assert(ask and ask.version == 1 and ask.action == 'list' and ask.id:find(':mic:1', 1, true), 'the page asked for the list')
    registered.loadMod('manager')
    assert(jsonFixtures[files['runtime/microphone-devices-command.json']] == ask, 'a rebuilt page does not ask again at once')
    -- The service answers: the row lists the inputs in its order.
    jsonFixtures['mics-1'] = {version = 1, state = 'ok', inputs = {'Microphone (Realtek(R) Audio)', 'Headset Mic (USB)', 'Headset Mic (USB)', 'bad' .. string.char(1)}}
    files['runtime/microphone-devices.json'] = 'mics-1'; clock = clock + 2
    registered.loadMod('manager')
    item = assert(row('micDevice'))
    assert(#item.elements == 3 and item.elements[2] == 'Microphone (Realtek(R) Audio)' and item.elements[3] == 'Headset Mic (USB)', table.concat(item.elements, '|'))
    assert(manager.snapshot(player).settings.micDevice == nil, 'no choice is no key')
    -- Choosing an input saves its name; the default clears it; a position that is not listed is refused.
    assert(registered.applyBatch('manager', {{id = 'micDevice', value = 3}}).ok)
    assert(manager.snapshot(player).settings.micDevice == 'Headset Mic (USB)')
    assert(saved.micDevice == 'Headset Mic (USB)', 'saved in settings.json for the bridge')
    registered.loadMod('manager')
    assert(row('micDevice').value == 3)
    assert(not registered.applyBatch('manager', {{id = 'micDevice', value = 9}}).ok)
    assert(not manager.applySettings(player, {micDevice = 'x' .. string.char(2)}))
    assert(manager.snapshot(player).settings.micDevice == 'Headset Mic (USB)')
    -- The saved input is not in the list any more (unplugged): it stays selected and says so.
    jsonFixtures['mics-2'] = {version = 1, state = 'ok', inputs = {'Microphone (Realtek(R) Audio)'}}
    files['runtime/microphone-devices.json'] = 'mics-2'; clock = clock + 2
    registered.loadMod('manager')
    item = assert(row('micDevice'))
    assert(#item.elements == 3 and item.elements[3]:find('(not connected)', 1, true) and item.value == 3, table.concat(item.elements, '|'))
    assert(item.elements[3]:sub(-15) == '(not connected)', 'the marker is kept whole: ' .. item.elements[3])
    assert(registered.applyBatch('manager', {{id = 'micDevice', value = 1}}).ok)
    assert(manager.snapshot(player).settings.micDevice == nil and saved.micDevice == nil, 'Windows default removes the choice')
  `);
});

test('Lip sync delay (Bluetooth) is a Voices select: Auto by default, Off and milliseconds saved for the bridge', () => {
  run(`${nsuiFixture}
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
  run(`${nsuiFixture}
    assert(manager.snapshot(player).settings.voiceVolume == 100)
    assert(invoke('tab:settings').ok)
    local item = assert(row('voiceVolume'))
    assert(item.type == 'int' and item.value == 100 and item.defaultValue == 100)
    assert(item.min == 50 and item.max == 200 and item.step == 5, 'a slider range, not a list of steps')
    assert(item.elements == nil and item.label:find('%', 1, true), 'the unit is in the name: the page shows only the number')
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
  run(`${nsuiFixture}
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
  run(`${nsuiFixture}
    api.spawn('johnny-silverhand'); api.spawn('johnny-silverhand'); api.spawn('person-1')
    for index, member in ipairs(members) do
      member.state = 'ready'; member.baseName = member.name
      if index < 3 then member.name = member.name .. ' #' .. index end
    end
    assert(invoke('tab:party').ok)
    local back = {type = 'action'}
    assert(loaded.categories[1].settings[1].id == 'party:back')
    local names = {'Johnny Silverhand #1', 'Johnny Silverhand #2', 'Person 01 #3'}
    for index, id in ipairs({'dismiss:live:1', 'dismiss:live:2', 'dismiss:live:3'}) do
      local item = row(id)
      -- The same native action row as Back: one font role, one size, value on the right.
      assert(item.type == back.type and item.type == 'action' and item.value == 'Dismiss' and not item.disabled)
      assert(item.label == names[index], 'a row is the base name and its number: ' .. tostring(item.label))
    end
    local total = 0
    -- Save current party (saved parties) closes the section once somebody is in it: it is no copy's row.
    assert(row('party:save') and row('party:save').value == 'Save')
    for _, section in ipairs(loaded.categories) do
      for _, item in ipairs(section.id ~= 'navigation' and section.settings or {}) do
        if item.id ~= 'party:save' then total = total + 1 end
        assert(not item.id:find('^state:') and not item.id:find('^assign') and item.id ~= 'feedback'
          and item.id ~= 'party-count', 'extra party row ' .. item.id)
        assert(not item.label:find('Following') and not item.value:find('Following') and not item.value:find('/ 8'))
      end
    end
    assert(total == 3, 'one row per copy only: ' .. total)
    -- Joining and leaving never put a last-action line on the page.
    managerUi.update(player, true); assert(not row('feedback'))
  `);
});

test('dismissing removes the row at once while paused, defers the despawn, and restores the row with the reason on failure', () => {
  run(`${nsuiFixture}
    api.spawn('johnny-silverhand'); api.spawn('person-1')
    for _, member in ipairs(members) do member.state = 'ready'; member.baseName = member.name end
    assert(invoke('tab:party').ok)
    assert(row('dismiss:live:1') and row('dismiss:live:2'))
    -- Paused: the row is gone immediately, the copy is still in the world.
    managerUi.update(player, false)
    assert(invoke('dismiss:live:1').ok)
    assert(not row('dismiss:live:1') and row('dismiss:live:2') and #members == 2, 'the row stayed or the copy left while paused')
    assert(managerUi.party().count() == 1)
    managerUi.update(player, false); assert(#members == 2 and not row('dismiss:live:1'))
    -- Gameplay resumes: the queued despawn runs once and the row stays gone.
    managerUi.update(player, true)
    assert(#members == 1 and members[1].serial == 2)
    loaded = registered.loadMod('manager')
    assert(not row('dismiss:live:1') and row('dismiss:live:2') and not row('error:live:1'))
    -- The game refuses the next dismissal: the copy returns with the reason.
    local original = api.dismiss
    api.dismiss = function() return false, 'World unavailable' end
    assert(invoke('dismiss:live:2').ok and not row('dismiss:live:2') and row('empty-party'))
    managerUi.update(player, true)
    loaded = registered.loadMod('manager')
    assert(#members == 1 and row('dismiss:live:2') and not row('empty-party'), 'a refused dismissal did not restore the row')
    assert(row('error:live:2').label:find('World unavailable', 1, true))
    assert(row('dismiss:live:2').description:find('World unavailable', 1, true))
    assert(managerUi.inspect().party[1].dismissError == 'World unavailable')
    -- A later dismissal that succeeds clears the old reason.
    api.dismiss = original
    assert(invoke('dismiss:live:2').ok); managerUi.update(player, true)
    loaded = registered.loadMod('manager')
    assert(#members == 0 and not row('dismiss:live:2') and not row('error:live:2') and row('empty-party'))
  `);
});

test('a phone dismissal and a menu dismissal share one optimistic path and a full eight-place party never shows or enforces a limit', () => {
  run(`${nsuiFixture}
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
    managerUi.update(player, true); assert(#members == 9)
    for _, member in ipairs(members) do member.state = 'ready' end
    assert(invoke('characters:back').ok and invoke('tab:party').ok)
    assert(row('dismiss:live:9'))
    local accepted, message, dismissedId = managerUi.party().dismissCharacter('johnny-silverhand')
    assert(accepted == true and dismissedId == 'live:9' and #members == 9)
    loaded = registered.loadMod('manager')
    assert(not row('dismiss:live:9') and row('dismiss:live:8'), 'a phone dismissal left its row on the page')
    managerUi.update(player, true); assert(#members == 8)
    assert(invoke('party:back').ok and invoke('tab:characters').ok and invoke('invite:johnny-silverhand').ok)
  `);
});

// Optional local integration gate: execute the actual installed API modules,
// without writing their data directory or copying third-party code into Git.
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
        omniSteps = 16, followUpQuestions = true, battleReactions = false, battleReactionsChosen = true, lootReactions = false, lootReactionsChosen = true,
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

test('Manager puts Developer mode in Development and changing it updates existing party feedback without native work', () => {
  run(`${nsuiFixture}
    local trip = {active = true, generation = 4, phase = 'waiting-for-player'}
    api.chauffeurSnapshot = function()
      local result = {}; for key, value in pairs(trip) do result[key] = value end; return result
    end
    local queue = managerUi.party()
    queue.bind('player-1'); queue.flush(); assert(#queue.takeNotices() == 0)
    assert(invoke('tab:settings').ok)
    local item = assert(row('developerMode'))
    assert(item.label == 'Developer mode' and item.type == 'bool' and item.value == false)
    assert(item.defaultValue == false and item.type == 'bool' and item.indent == nil)
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
  run(`${nsuiFixture}${managerPopupFixture}
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
    -- A local voice that cannot run is never replaced by a cloud voice: the replies are shown as text (the bridge's route 'text').
    state.fallback, state.provider, state.routedProfiles = {from = 'pocket', to = 'text'}, 'text', {}
    for _ = 1, 3 do popupTick(true) end
    assert(#popups == 2 and popups[2] == 'Pocket · Performance is unavailable right now. Replies show as text until it is back.', #popups .. ' ' .. tostring(popups[2]))
    assert(not popups[2]:find('Convai') and not popups[2]:find('Mistral'), 'the notice suggests no cloud voice')
    -- The same wording while the voice is being loaded again in the background (temporary), once.
    state.fallback, state.provider, state.updated = {from = 'omni', to = 'text', temporary = true}, 'text', popupClock * 1000
    for _ = 1, 3 do popupTick(true) end
    assert(#popups == 3 and popups[3] == 'OmniVoice · Balanced is unavailable right now. Replies show as text until it is back.', #popups .. ' ' .. tostring(popups[3]))
    assert(manager.voiceLabel('omni', 32, 'short') == 'OmniVoice · High Quality')
    assert(manager.voiceLabel('omni', 32, 'long') == 'OmniVoice · Ultra Quality')
    assert(manager.voiceLabel('omni', 16, 'short') == 'OmniVoice · Balanced')
    assert(manager.voiceLabel('omni', 16) == 'OmniVoice · Quality')
    assert(manager.voiceLabel('pocket') == 'Pocket · Performance' and manager.voiceLabel('convai') == 'Convai · Cloud voice')
  `);
});

test('a temporary fallback is announced once as not ready yet, the return to OmniVoice is silent, and giving up is announced separately', () => {
  run(`${nsuiFixture}${managerPopupFixture}
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
  run(`${nsuiFixture}
    local clock = 5000
    os.clock = function() return clock end
    local sent = {}
    function player:ConvaiPhoneFeedback(text) sent[#sent + 1] = text end
    assert(invoke('tab:settings').ok)
    local entry = row('naturalSpeech')
    assert(entry and entry.type == 'bool' and entry.value == false and entry.defaultValue == false, 'off by default')
    local NOTICE = 'Natural speech needs a local voice, so Companion voices was switched to ' .. manager.voiceLabel('pocket') .. '.'
    local OFF = 'The Convai cloud voice cannot use Natural speech, so it was turned off.'
    -- The row positions of the cloud voice, of Pocket and of the first OmniVoice entry, wherever the list puts them (entry 1 of the row is Off, so one after the list position).
    local CLOUD, OMNI, POCKET
    for index, choice in ipairs(dofile('voice-preview.lua').CHOICES) do
      if choice.provider == 'convai' then CLOUD = index + 1 end
      if choice.provider == 'pocket' then POCKET = index + 1 end
      if choice.provider == 'omni' and not OMNI then OMNI = index + 1 end
    end
    assert(CLOUD and OMNI and POCKET)
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
    -- Choosing the cloud voice while it is on keeps the voice, turns Natural speech off, and says so once.
    result = apply({'voiceProvider', CLOUD})
    assert(result.ok and saved.voiceProvider == 'convai' and saved.naturalSpeech == false and not manager.naturalSpeech())
    assert(manager.snapshot(player).settings.voiceProvider == 'convai' and manager.snapshot(player).settings.naturalSpeech == false)
    assert(result.schemaChanged == true, 'the page reloads so the toggle shows off')
    assert(manager.snapshot(player).feedback == OFF, manager.snapshot(player).feedback)
    managerUi.update(player, true)
    assert(#sent == 0, 'the popup is Developer-only: the Settings status line already says it')
    managerUi.update(player, true); assert(#sent == 0)
    -- Turning it on while the cloud voice is saved is the player asking for the tags: the voice moves to Pocket, with a notice.
    -- Developer mode shows it once, in gameplay.
    convaiNotices.configure(function() return true end)
    result = apply({'naturalSpeech', true})
    assert(result.ok and saved.voiceProvider == 'pocket' and saved.naturalSpeech == true and result.schemaChanged == true)
    managerUi.update(player, true)
    assert(#sent == 1 and sent[1] == NOTICE, 'the notice reaches a developer in gameplay: ' .. tostring(sent[1]))
    managerUi.update(player, true); assert(#sent == 1, 'announced once')
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

test('Natural speech sits in the Voices category and applies on its own', () => {
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    local owner
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings) do if item.id == 'naturalSpeech' then owner = category end end
    end
    assert(owner and owner.id == 'voices' and row('voiceProvider') and row('naturalSpeech').label == 'Natural speech')
    assert(row('naturalSpeech').description:find('Pocket', 1, true) and row('naturalSpeech').description:find('Convai’s cloud voice', 1, true))
    assert(registered.applyBatch('manager', {{id = 'naturalSpeech', value = true}}).ok and manager.naturalSpeech())
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
    for _, case in ipairs({{'missing', 'pocket', true}, {true, 'pocket', true}, {true, 'omni', true}, {true, 'voxtral', true},
        -- The removed Inworld voice: a saved one loads as Pocket TTS, with or without developer mode.
        {true, 'inworld', true, false, 'pocket'}, {true, 'inworld', true, true, 'pocket'}, {false, 'inworld', false, false, 'pocket', true},
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
    assert(manager.applySettings(player, {voiceProvider = 'pocket', witnessReceipts = false}) and manager.vVoice())
    -- Explicitly turned off stays off through a voice change.
    assert(manager.applySettings(player, {vVoice = false}) and manager.applySettings(player, {voiceProvider = 'convai'}) and manager.applySettings(player, {voiceProvider = 'pocket'}) and not manager.vVoice())
  `);
});

test('V’s voice engine is Pocket by default, only Pocket, Voxtral and OmniVoice are kept (OmniVoice reads as Pocket until it can be used, the file keeps it), and a saved file with Mature content on never keeps Voxtral (it is Pocket)', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved.vVoiceEngine == 'pocket' and manager.vVoiceEngine() == 'pocket' and manager.snapshot(player).settings.vVoiceEngine == 'pocket')
    -- A case is {saved engine, saved Mature content, expected engine, saved voice (default pocket), the engine left in the file (default: the expected one)}.
    -- Mature content needs Local AI, so the seed carries it; a hand-edited file with Mature content, Local AI and Voxtral loads as Pocket and is saved so
    -- (Voxtral is not used beside Mature content, 2026-10-20). A saved 'omni' survives the load: it is used while the companions speak with OmniVoice
    -- (the pack is taken as installed when the bridge has not said otherwise), and read as Pocket, the file untouched, while they do not.
    for _, case in ipairs({{'missing', false, 'pocket'}, {'pocket', false, 'pocket'}, {'voxtral', false, 'voxtral'},
        {'omni', false, 'pocket', 'pocket', 'omni'}, {'omni', false, 'omni', 'omni'}, {'omni', false, 'pocket', 'voxtral', 'omni'},
        {'inworld', false, 'pocket'}, {'convai', false, 'pocket'}, {7, false, 'pocket'}, {true, false, 'pocket'},
        {'voxtral', true, 'pocket'}, {'pocket', true, 'pocket'}}) do
      seed = {version = 2, voiceProvider = case[4] or 'pocket', matureContent = case[2], conversationProvider = case[2] and 'local' or 'convai', enabledByKey = {}, future = {keep = 'unchanged'}}
      if case[1] ~= 'missing' then seed.vVoiceEngine = case[1] end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      assert(manager.vVoiceEngine() == case[3] and saved.vVoiceEngine == (case[5] or case[3]), tostring(case[1]) .. ' ' .. tostring(case[2]))
      assert(manager.snapshot(player).settings.vVoiceEngine == (case[5] or case[3]))
      assert(saved.future.keep == 'unchanged')
    end
  `);
});

test('V’s voice is one row (Off, Pocket, Voxtral, OmniVoice): Voxtral needs the Mistral key and is greyed out without it, applies beside any companion voice, Off keeps the engine, and with Mature content on it is greyed out, moved to Pocket and refused', () => {
  run(`${nsuiFixture}
    local clock = 1000; os.clock = function() return clock end
    local function key(tag, value)
      jsonFixtures['mistral-' .. tag] = value
      files['runtime/mistral-state.json'] = 'mistral-' .. tag
      clock = clock + 2
    end
    assert(invoke('tab:settings').ok)
    loaded = registered.loadMod('manager')
    -- V's voice and V's engine are ONE row in the Voices category (1 Off, 2 Pocket, 3 Voxtral, 4 OmniVoice), and the row says what Voxtral needs while there is no key.
    local order = {}
    for _, category in ipairs(loaded.categories) do
      if category.id == 'voices' then for _, item in ipairs(category.settings) do order[#order + 1] = item.id end end
    end
    for _, id in ipairs(order) do assert(id ~= 'vVoiceEngine', 'no separate engine row') end
    assert(row('vVoiceEngine') == nil)
    local engine = row('vVoice')
    assert(engine.label == 'V’s voice for typed lines' and engine.type == 'select' and engine.value == 2 and engine.defaultValue == 2)
    assert(#engine.elements == 4 and engine.elements[1] == 'Off' and engine.elements[2] == 'Pocket · On your PC'
      and engine.elements[3] == 'Voxtral · needs Mistral key' and engine.elements[4] == 'OmniVoice · needs Omni voice', engine.elements[3] .. ' | ' .. engine.elements[4])
    assert(engine.disabledElements and engine.disabledElements[3] == true and not engine.disabledElements[1] and not engine.disabledElements[2],
      'Voxtral is greyed out without a key')
    assert(engine.disabledElements[4] == 'Requires the Companion voices to be an OmniVoice choice', 'OmniVoice is greyed out, with its own reason, while the companions are on Pocket')
    for _, banned in ipairs({'recommended', 'antivirus', 'embedded', 'paid'}) do
      assert(not tostring(engine.description):lower():find(banned, 1, true), banned)
      for _, element in ipairs(engine.elements) do assert(not element:lower():find(banned, 1, true), banned) end
    end
    assert(engine.description:find('Pocket', 1, true) and engine.description:find('Voxtral', 1, true) and engine.description:find('Mistral key', 1, true))
    -- No key: refused with the one short reason, nothing changes.
    local result = registered.applyBatch('manager', {{id = 'vVoice', value = 3}})
    assert(result.ok == false and result.error == 'Requires a Mistral key (add it in Settings > Conversation provider)', result.error)
    assert(saved.vVoiceEngine == 'pocket' and saved.vVoice == true)
    assert(not manager.applySettings(player, {vVoiceEngine = 'voxtral'}) and manager.vVoiceEngine() == 'pocket')
    assert(registered.applyBatch('manager', {{id = 'vVoice', value = 5}}).ok == false)
    assert(registered.applyBatch('manager', {{id = 'vVoice', value = 0}}).ok == false)
    assert(registered.applyBatch('manager', {{id = 'vVoice', value = true}}).ok == false, 'the row is a position, not a switch')
    assert(registered.applyBatch('manager', {{id = 'vVoiceEngine', value = 2}}).error == 'That setting is read-only.', 'no apply key for a second row')
    assert(not manager.applySettings(player, {vVoiceEngine = 'omni'}) and not manager.applySettings(player, {vVoiceEngine = 'inworld'}))
    -- Off keeps the saved engine and turns the switch off; the next entry turns it on again.
    assert(registered.applyBatch('manager', {{id = 'vVoice', value = 1}}).ok and saved.vVoice == false and saved.vVoiceEngine == 'pocket' and saved.vVoiceChosen == true)
    loaded = registered.loadMod('manager'); assert(row('vVoice').value == 1)
    assert(registered.applyBatch('manager', {{id = 'vVoice', value = 2}}).ok and saved.vVoice == true and saved.vVoiceEngine == 'pocket')
    loaded = registered.loadMod('manager'); assert(row('vVoice').value == 2)
    -- A key is saved: the entry is a plain label, no longer greyed out, and applies whatever the companions use (here Pocket, then the Convai cloud voice).
    key('a', {provider = 'convai', effective = 'convai', saved = true})
    loaded = registered.loadMod('manager')
    assert(row('vVoice').elements[3] == 'Voxtral · Mistral cloud', row('vVoice').elements[3])
    assert((row('vVoice').disabledElements or {})[3] == nil, 'Voxtral is not greyed out with a key')
    assert(registered.applyBatch('manager', {{id = 'vVoice', value = 3}}).ok)
    assert(saved.vVoiceEngine == 'voxtral' and saved.vVoice == true and manager.vVoiceEngine() == 'voxtral' and manager.snapshot(player).settings.vVoiceEngine == 'voxtral')
    assert(saved.voiceProvider == 'pocket', 'the voice of the companions is untouched')
    loaded = registered.loadMod('manager')
    assert(row('vVoice').value == 3)
    assert(manager.applySettings(player, {voiceProvider = 'convai'}) and manager.vVoiceEngine() == 'voxtral' and manager.vVoiceActive(), 'beside the Convai voice V still has its own engine')
    assert(manager.applySettings(player, {voiceProvider = 'pocket'}) and manager.vVoiceEngine() == 'voxtral')
    -- Off keeps the saved engine: the row reads Off, and On again by Pocket changes the engine back.
    assert(registered.applyBatch('manager', {{id = 'vVoice', value = 1}}).ok and saved.vVoice == false and saved.vVoiceEngine == 'voxtral')
    -- Back to Pocket, always allowed.
    assert(registered.applyBatch('manager', {{id = 'vVoice', value = 2}}).ok and saved.vVoiceEngine == 'pocket' and saved.vVoice == true)
    loaded = registered.loadMod('manager'); assert(row('vVoice').value == 2)
    -- A file that says Voxtral while no key is saved shows Voxtral (3) in the row (V's voice follows its own setting; the entry is greyed out and says it needs the key).
    assert(manager.applySettings(player, {vVoiceEngine = 'voxtral'}) and saved.vVoiceEngine == 'voxtral')
    key('b', {provider = 'convai', effective = 'convai', saved = false})
    loaded = registered.loadMod('manager')
    assert(row('vVoice').value == 3 and row('vVoice').disabledElements[3] == true and row('vVoice').elements[3] == 'Voxtral · needs Mistral key', 'Voxtral without a key still reads as Voxtral, with its note')
    key('c', {provider = 'convai', effective = 'convai', saved = true})
    loaded = registered.loadMod('manager'); assert(row('vVoice').value == 3)
    assert(registered.applyBatch('manager', {{id = 'vVoice', value = 2}}).ok and saved.vVoiceEngine == 'pocket')
    -- Mature content (2026-10-20, after Voxtral refused Mature lines in a live test): V's Voxtral is not used beside it, with any provider. A caller
    -- that turns it on beside a saved Voxtral gets Pocket (quietly, with a reload; the page stages and names it instead).
    assert(manager.applySettings(player, {vVoiceEngine = 'voxtral'}) and saved.vVoiceEngine == 'voxtral')
    local ok, err, notice, reload = manager.applySettings(player, {conversationProvider = 'local', matureContent = true})
    assert(ok and saved.matureContent == true and saved.vVoiceEngine == 'pocket' and notice == nil and reload == true, tostring(err))
    -- Choosing Voxtral while it stays on is refused and nothing is saved.
    local chosen, why = manager.applySettings(player, {vVoiceEngine = 'voxtral'})
    assert(chosen == false and why == 'Voxtral is not used with Mature content.' and saved.vVoiceEngine == 'pocket' and saved.matureContent == true, tostring(why))
    -- The page: with the key saved the entry is still greyed out, says why, and the row is refused.
    loaded = registered.loadMod('manager')
    local mature = row('vVoice')
    assert(mature.elements[3] == 'Voxtral · not with Mature' and mature.disabledElements and mature.disabledElements[3] == true and mature.value == 2, tostring(mature.elements[3]))
    assert(mature.disabledReason == 'Voxtral is not used with Mature content.', tostring(mature.disabledReason))
    local refused = registered.applyBatch('manager', {{id = 'vVoice', value = 3}})
    assert(refused.ok == false and refused.error == 'Voxtral is not used with Mature content.' and saved.vVoiceEngine == 'pocket', tostring(refused.error))
    for _, element in ipairs(mature.elements) do assert(core.optionUnits(element) <= core.OPTION_BUDGET, element) end
    -- Turned off, Voxtral can be chosen again.
    assert(manager.applySettings(player, {matureContent = false}) and saved.vVoiceEngine == 'pocket')
    assert(manager.applySettings(player, {vVoiceEngine = 'voxtral'}) and saved.vVoiceEngine == 'voxtral')
    -- Both in one Apply: Mature content is on and V is Pocket.
    assert(manager.applySettings(player, {matureContent = true, vVoiceEngine = 'voxtral'}) and saved.vVoiceEngine == 'pocket' and saved.matureContent == true)
    -- Custom text is the same; Mistral text takes Mature content off instead (the voice then stays as it was).
    assert(manager.applySettings(player, {conversationProvider = 'custom'}) and saved.matureContent == true and saved.vVoiceEngine == 'pocket')
    assert(not manager.applySettings(player, {vVoiceEngine = 'voxtral'}) and saved.vVoiceEngine == 'pocket')
    assert(manager.applySettings(player, {conversationProvider = 'mistral', vVoiceEngine = 'voxtral'}))
    assert(saved.matureContent == false and saved.conversationProvider == 'mistral' and saved.vVoiceEngine == 'voxtral')
  `);
});

test('V’s voice on OmniVoice (fourth entry): it needs the OmniVoice pack (named first) and companions saved on OmniVoice, a batch is judged by its final values, a saved OmniVoice reads as Pocket while it cannot be used, and moving the companions off OmniVoice sets V to Pocket in the same save with a notice', () => {
  run(`${nsuiFixture}
    local clock = 1000
    os.clock = function() return clock end
    os.time = function() return clock end
    local NEEDS_VOICE = 'Requires the Companion voices to be an OmniVoice choice'
    local NEEDS_PACK = 'Requires the optional OmniVoice pack (GPU)'
    local function pack(installed)
      clock = clock + 20
      jsonFixtures['voice-' .. clock] = {state = 'ready', provider = 'pocket', updated = clock * 1000,
        omniPack = {installed = installed, missing = installed and {} or {'model'}}}
      files['runtime/local-voice-state.json'] = 'voice-' .. clock
      manager.snapshot(player)
      loaded = registered.loadMod('manager')
    end
    local POCKET, BALANCED
    for index, choice in ipairs(dofile('voice-preview.lua').CHOICES) do
      if choice.provider == 'pocket' then POCKET = index + 1 end
      if choice.provider == 'omni' and choice.steps == 16 and choice.reference == 'short' then BALANCED = index + 1 end
    end
    assert(POCKET and BALANCED)
    assert(invoke('tab:settings').ok)
    pack(true)
    -- Pack installed, companions on Pocket: the fourth entry is greyed out with the voice reason, and choosing it is refused.
    local engine = row('vVoice')
    assert(#engine.elements == 4 and engine.elements[4] == 'OmniVoice · needs Omni voice', tostring(engine.elements[4]))
    assert(engine.disabledElements[4] == NEEDS_VOICE and engine.value == 2)
    local result = registered.applyBatch('manager', {{id = 'vVoice', value = 4}})
    assert(result.ok == false and result.error == NEEDS_VOICE and saved.vVoiceEngine == 'pocket', tostring(result.error))
    local ok, why = manager.applySettings(player, {vVoiceEngine = 'omni'})
    assert(ok == false and why == NEEDS_VOICE and saved.vVoiceEngine == 'pocket', tostring(why))
    -- Pack missing: its reason comes first (here and with the companions saved on OmniVoice below).
    pack(false)
    engine = row('vVoice')
    assert(engine.elements[4] == 'OmniVoice · needs Omni pack' and engine.disabledElements[4] == NEEDS_PACK, tostring(engine.elements[4]))
    result = registered.applyBatch('manager', {{id = 'vVoice', value = 4}})
    assert(result.ok == false and result.error == NEEDS_PACK and saved.vVoiceEngine == 'pocket', tostring(result.error))
    ok, why = manager.applySettings(player, {vVoiceEngine = 'omni'})
    assert(ok == false and why == NEEDS_PACK, tostring(why))
    -- Both together: the companions move to OmniVoice and V to OmniVoice in one batch (the final values judge it).
    pack(true)
    result = registered.applyBatch('manager', {{id = 'vVoice', value = 4}, {id = 'voiceProvider', value = BALANCED}})
    assert(result.ok and saved.voiceProvider == 'omni' and saved.vVoiceEngine == 'omni' and saved.vVoice == true, tostring(result.error))
    assert(manager.vVoiceEngine() == 'omni' and manager.snapshot(player).settings.vVoiceEngine == 'omni')
    loaded = registered.loadMod('manager')
    engine = row('vVoice')
    assert(engine.value == 4 and engine.elements[4] == 'OmniVoice' and (engine.disabledElements or {})[4] == nil, tostring(engine.value))
    -- A batch that moves the companions away and keeps V on OmniVoice is refused, nothing is saved.
    result = registered.applyBatch('manager', {{id = 'voiceProvider', value = POCKET}, {id = 'vVoice', value = 4}})
    assert(result.ok == false and result.error == NEEDS_VOICE and saved.voiceProvider == 'omni' and saved.vVoiceEngine == 'omni', tostring(result.error))
    -- The pack goes away: the row reads Pocket, the engine is Pocket, the file keeps 'omni'; it comes back with the pack.
    pack(false)
    assert(row('vVoice').value == 2 and manager.vVoiceEngine() == 'pocket' and saved.vVoiceEngine == 'omni', tostring(row('vVoice').value))
    assert(row('vVoice').elements[4] == 'OmniVoice · needs Omni pack' and row('vVoice').disabledElements[4] == NEEDS_PACK, 'the pack first, with the companions saved on OmniVoice')
    result = registered.applyBatch('manager', {{id = 'vVoice', value = 4}})
    assert(result.ok == false and result.error == NEEDS_PACK, tostring(result.error))
    pack(true)
    assert(row('vVoice').value == 4 and manager.vVoiceEngine() == 'omni')
    -- The companions move off OmniVoice: V goes to Pocket in the same save, and the line says so.
    result = registered.applyBatch('manager', {{id = 'voiceProvider', value = POCKET}})
    assert(result.ok and saved.voiceProvider == 'pocket' and saved.vVoiceEngine == 'pocket' and saved.vVoice == true, tostring(result.error))
    assert(managerUi.inspect().shown == 'V’s voice switches from OmniVoice to Pocket.', tostring(managerUi.inspect().shown))
    loaded = registered.loadMod('manager'); assert(row('vVoice').value == 2)
    -- V on OmniVoice again; V Off with the companions leaving OmniVoice: the engine still goes to Pocket, V stays off, and nothing is said about V.
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = BALANCED}, {id = 'vVoice', value = 4}}).ok)
    result = registered.applyBatch('manager', {{id = 'voiceProvider', value = POCKET}, {id = 'vVoice', value = 1}})
    assert(result.ok and saved.vVoice == false and saved.vVoiceEngine == 'pocket' and saved.voiceProvider == 'pocket', tostring(result.error))
    assert(managerUi.inspect().shown ~= 'V’s voice switches from OmniVoice to Pocket.', tostring(managerUi.inspect().shown))
    -- A save that does not touch the voices leaves the saved engine alone.
    assert(manager.applySettings(player, {vVoice = true, voiceProvider = 'omni'}) and manager.applySettings(player, {vVoiceEngine = 'omni'}))
    assert(manager.applySettings(player, {subtitles = false}) and saved.vVoiceEngine == 'omni' and saved.voiceProvider == 'omni')
  `);
});

test('V’s voice engine with Mature content in a saved file: Voxtral is Pocket with Local AI and Custom text; beside Mistral Mature content is off and Voxtral stays', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    -- A case is {conversation provider, expected engine, expected Mature content} with Mature content on and Voxtral saved.
    for _, case in ipairs({{'local', 'pocket', true}, {'mistral', 'voxtral', false}, {'custom', 'pocket', true}}) do
      seed = {version = 2, voiceProvider = 'pocket', matureContent = true, conversationProvider = case[1], vVoiceEngine = 'voxtral', enabledByKey = {}}
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      assert(manager.vVoiceEngine() == case[2] and saved.vVoiceEngine == case[2] and saved.matureContent == case[3], case[1])
    end
  `);
});

test('V’s voice sits in the Voices category after the voice choice, is on by default, and applies on its own; the old Convai-voice note is gone', () => {
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    local owner, order = nil, {}
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings) do
        if category.id == 'voices' then order[#order + 1] = item.id end
        if item.id == 'vVoice' then owner = category end
      end
    end
    assert(owner and owner.id == 'voices' and row('vVoice').label == 'V’s voice for typed lines')
    assert(row('vVoice').type == 'select' and row('vVoice').value == 2 and row('vVoice').defaultValue == 2, 'Pocket, on, by default')
    assert(row('vVoice').description:find('Your typed lines', 1, true)
        and row('vVoice').description:find('always waited for', 1, true))
    assert(not row('vVoice').description:find('Off by default', 1, true) and not row('vVoice').description:find('cannot clone', 1, true))
    for _, banned in ipairs({'recommended', 'antivirus', 'embedded', 'paid'}) do
      assert(not row('vVoice').description:lower():find(banned, 1, true), banned)
    end
    local at = {}
    for index, id in ipairs(order) do at[id] = index end
    assert(at.naturalSpeech < at.vVoice and at.followUpInterest == nil, 'with the other speech settings')
    -- No companion voice makes the row differ: V has its own engine.
    local plain = row('vVoice').description
    assert(manager.applySettings(player, {voiceProvider = 'convai'}))
    loaded = registered.loadMod('manager')
    assert(row('vVoice').description == plain and not row('vVoice').description:find('Works with', 1, true))
    assert(manager.applySettings(player, {developerMode = true}))
    loaded = registered.loadMod('manager')
    assert(row('vVoice').description == plain, 'Developer mode adds no text here')
    assert(manager.applySettings(player, {voiceProvider = 'pocket', developerMode = false}))
    loaded = registered.loadMod('manager')
    local voiceBefore = manager.snapshot(player).settings.voiceProvider
    assert(registered.applyBatch('manager', {{id = 'vVoice', value = 1}}).ok and not manager.vVoice())
    assert(manager.snapshot(player).settings.voiceProvider == voiceBefore, 'no voice switch')
    assert(manager.takeNaturalSpeechNotice() == nil)
  `);
});

test('Multilingual conversations is a retired setting (2026-10-21): any saved value is dropped on load, never reaches the snapshot, and leaves the voice alone', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved.multilingualConversations == nil and manager.snapshot(player).settings.multilingualConversations == nil)
    assert(manager.multilingualConversations == nil and manager.multilingualActive == nil and manager.resolveMultilingualVoice == nil, 'no accessor is left')
    for _, case in ipairs({true, false, 'yes', 1}) do
      for _, voice in ipairs({'pocket', 'convai', 'omni'}) do
        seed = {version = 2, voiceProvider = voice, enabledByKey = {}, multilingualConversations = case, future = {keep = 'unchanged'}}
        files['runtime/settings.json'], saved = 'seed', nil
        manager.configure(api, profiles); manager.prepare(player)
        assert(saved ~= nil and saved.multilingualConversations == nil, 'the key is dropped from the file: ' .. tostring(case))
        assert(saved.voiceProvider == voice, 'the voice was moved: ' .. voice .. ' became ' .. tostring(saved.voiceProvider))
        assert(manager.snapshot(player).settings.multilingualConversations == nil and manager.snapshot(player).settings.voiceProvider == voice)
        assert(saved.future.keep == 'unchanged')
        seed, saved = saved, nil
        files['runtime/settings.json'] = 'seed'
        manager.configure(api, profiles); manager.prepare(player)
        assert(saved == nil, 'the corrected file is saved again')
      end
    end
  `);
});

// Shared by the staged-Apply cases: the voice row positions (entry 1 is Off, so one after the list position) and a batch helper (each Apply after the Auto Apply window).
const voiceApplyFixture = `
    local clock, wall = 5000, 1000
    os.clock = function() return clock end
    os.time = function() return wall end
    local sent = {}
    function player:ConvaiPhoneFeedback(text) sent[#sent + 1] = text end
    convaiNotices.configure(function() return true end) -- this popup is Developer-only (docs/NOTIFICATIONS.md)
    local POCKET, BALANCED, ULTRA, CLOUD
    for index, choice in ipairs(dofile('voice-preview.lua').CHOICES) do
      if choice.provider == 'pocket' then POCKET = index + 1 end
      if choice.provider == 'convai' then CLOUD = index + 1 end
      if choice.provider == 'omni' and choice.steps == 16 and choice.reference == 'short' then BALANCED = index + 1 end
      if choice.provider == 'omni' and choice.steps == 32 and choice.reference == 'long' then ULTRA = index + 1 end
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
    local CLOUD_OFF = 'The Convai cloud voice cannot use Natural speech, so it was turned off.'
    assert(invoke('tab:settings').ok)
`;

test('the Multilingual conversations row is gone: no row in any category, a staged change for it is refused as read-only, and an Apply that still carries it is ignored', () => {
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings) do
        assert(item.id ~= 'multilingualConversations' and item.label ~= 'Multilingual conversations', category.id .. ': ' .. tostring(item.id))
        assert(not tostring(item.description):find('Multilingual conversations', 1, true), tostring(item.id))
      end
    end
    assert(registered.applyBatch('manager', {{id = 'multilingualConversations', value = true}}).ok == false, 'a setting that is gone has no Apply branch on the page')
    assert(saved == nil or saved.multilingualConversations == nil)
    local voice = manager.snapshot(player).settings.voiceProvider
    for _, value in ipairs({true, false, 'yes', 1}) do
      local ok, err, notice = manager.applySettings(player, {multilingualConversations = value})
      assert(ok == true and err == nil and notice == nil, tostring(value) .. ': ' .. tostring(err))
      assert(saved.multilingualConversations == nil and manager.snapshot(player).settings.multilingualConversations == nil, 'nothing is saved for it')
      assert(manager.snapshot(player).settings.voiceProvider == voice)
    end
  `);
});

test('Pocket TTS is never refused or moved for a retired Multilingual value: choosing it, or an Apply that carries the old key, leaves the voice as chosen, with or without the OmniVoice pack', () => {
  run(`${nsuiFixture}${voiceApplyFixture}
    for _, installed in ipairs({true, false}) do
      pack(installed)
      assert(apply({'voiceProvider', ULTRA}).ok or not installed)
      assert(apply({'voiceProvider', CLOUD}).ok and saved.voiceProvider == 'convai')
      assert(apply({'voiceProvider', POCKET}).ok and saved.voiceProvider == 'pocket', 'Pocket can be chosen')
      local ok, err, notice = manager.applySettings(player, {multilingualConversations = true})
      assert(ok and err == nil and notice == nil and saved.voiceProvider == 'pocket' and saved.multilingualConversations == nil, tostring(err))
      ok, err = manager.applySettings(player, {voiceProvider = 'pocket', multilingualConversations = true, naturalSpeech = true})
      assert(ok and saved.voiceProvider == 'pocket' and saved.naturalSpeech == true, tostring(err))
      assert(manager.takeNaturalSpeechNotice() == nil)
      assert(apply({'naturalSpeech', false}).ok)
    end
  `);
});

test('Natural speech and the Convai cloud voice on the Convai provider: the voice chosen with it on is kept and Natural speech goes off; turned on beside the cloud voice it moves the voice to Pocket, never to OmniVoice', () => {
  run(`${nsuiFixture}${voiceApplyFixture}
    for _, installed in ipairs({true, false}) do
      pack(installed)
      if installed then
        assert(apply({'voiceProvider', ULTRA}).ok and saved.omniSteps == 32 and saved.omniReference == 'long')
        assert(apply({'naturalSpeech', true}).ok and saved.voiceProvider == 'omni')
        assert(manager.takeNaturalSpeechNotice() == nil and saved.naturalSpeech)
      else
        assert(apply({'voiceProvider', POCKET}).ok and apply({'naturalSpeech', true}).ok and saved.naturalSpeech)
      end
      -- The cloud voice chosen while Natural speech is on is kept: Natural speech is turned off, with one notice.
      local result = apply({'voiceProvider', CLOUD})
      assert(result.ok and saved.voiceProvider == 'convai' and not saved.naturalSpeech)
      assert(result.schemaChanged == true and manager.takeNaturalSpeechNotice() == CLOUD_OFF)
      -- Natural speech turned on beside the saved cloud voice moves the voice to Pocket.
      result = apply({'naturalSpeech', true})
      assert(result.ok and saved.voiceProvider == 'pocket' and saved.naturalSpeech, tostring(saved.voiceProvider))
      assert(manager.takeNaturalSpeechNotice() == 'Natural speech needs a local voice, so Companion voices was switched to ' .. manager.voiceLabel('pocket') .. '.')
      assert(apply({'naturalSpeech', false}).ok)
    end
  `);
});

test('a saved pairing with the cloud voice and Natural speech cannot stand on a Convai provider; Pocket and OmniVoice pairings stand, whatever a retired Multilingual value says', () => {
  run(`${managerFixture}
    for _, case in ipairs({
      {{voiceProvider = 'pocket'}, 'pocket', false},
      {{voiceProvider = 'pocket', naturalSpeech = true}, 'pocket', true},
      {{voiceProvider = 'convai', naturalSpeech = true}, 'convai', false},
      {{voiceProvider = 'convai', expressiveEmotions = true}, 'convai', false},
      {{voiceProvider = 'omni', naturalSpeech = true}, 'omni', true},
    }) do
      seed = {version = 2, enabledByKey = {}, multilingualConversations = true}
      for key, value in pairs(case[1]) do seed[key] = value end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      assert(saved.voiceProvider == case[2] and (saved.naturalSpeech == true) == case[3], case[1].voiceProvider)
      assert(saved.expressiveEmotions == nil, 'the retired key is dropped')
      assert(saved.multilingualConversations == nil, 'the retired Multilingual key is dropped')
    end
  `);
});

// Model browser records map to NPC archetype profiles (docs/NPC_ARCHETYPES.md).
const catalogSource = readFileSync(new URL('../mod/character-catalog.lua', import.meta.url), 'utf8');
test('Model browser maps generic records to archetypes, shows it in the row, counts talkers and invites them talking', () => {
  run(`${nsuiFixture}
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
    for _ = 1, 4 do managerUi.update(player, false) end
    loaded = registered.loadMod('manager')
    local byRecord = {}
    for _, model in ipairs(manager.snapshot(player).models) do byRecord[model.record] = model end
    local expected = {['Character.Silverhand'] = 'johnny-silverhand',
      ['Character.maelstrom_grunt1_ranged1_lexington_ma'] = 'npc-maelstrom-male',
      ['Character.tyger_claws_gang3_katana_wa'] = 'npc-tyger-claws-female',
      ['Character.wat_kab_ripperdoc_01'] = 'npc-ripperdoc-male', ['Character.CorpoWomanBag'] = 'npc-corpo-resident-female',
      ['Character.Waitress'] = false, ['Character.maxtac_rifle_ma'] = 'npc-maxtac-male', ['Character.q105_valentino_ma'] = false,
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
    assert(description('Character.maxtac_rifle_ma'):find('Conversation: MaxTac officer (archetype)', 1, true))
    assert(row('model-status').description:find('6 of them can talk.', 1, true))
    -- A Waitress has no gender in its name and no resident kind: it stays a silent follower.
    assert(description('Character.Waitress'):find('No conversation profile', 1, true))
    -- Invited, the copy joins as a model (nothing to prepare) and talks as the archetype once spawned.
    local key = byRecord['Character.maelstrom_grunt1_ranged1_lexington_ma'].key
    assert(invoke('invite:' .. key).ok and #spawned == 0)
    managerUi.update(player, true)
    assert(members[1].key == key and members[1].profileKey == 'npc-maelstrom-male' and members[1].profileName == 'Maelstrom ganger')
    local named = byRecord['Character.Silverhand'].key
    assert(invoke('invite:' .. named).ok); managerUi.update(player, true)
    assert(members[2].profileKey == 'johnny-silverhand', 'named records keep their prepared profile')
  `);
});

test('the Convai and Mistral key rows are always listed, whichever provider is chosen, with or without Developer mode, and the old switch is gone', () => {
  run(`${nsuiFixture}
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

test('Settings sections: Relationships is a button in Conversations, Conversation provider follows Conversations and sits before Voices, Development keeps Developer mode, the Voices category has no Voice status row', () => {
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    local order = {}
    for _, category in ipairs(loaded.categories) do order[#order + 1] = category.id end
    local joined = table.concat(order, ',')
    assert(joined:find('navigation,interface,conversation-controls,conversation-provider,companion-behavior,gameplay,voices,', 1, true) and not joined:find('relationships', 1, true), joined)
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
    assert(voices[1] == 'voiceProvider' and voices[2] == 'replyLanguage' and voices[3] == 'subtitleStyle' and voices[4] == 'audioDelay', table.concat(voices, ','))
    for _, id in ipairs(voices) do assert(id ~= 'voice-pack' and id ~= 'voice-status', id .. ' is in Voices') end
    for _, id in ipairs({'groq-key-status', 'groq-key:paste', 'groq-key:remove', 'permissions', 'enabled:person-1'}) do assert(row(id) == nil, id .. ' is still offered') end
    local elements = row('conversationProvider').elements
    assert(#elements == 5 and elements[1] == 'Convai free tier' and elements[2] == 'Convai API key' and elements[3] == 'Mistral (free plan)' and elements[4] == 'Local AI'
      and elements[5] == 'Custom (OpenAI-compatible)')
    assert(not tostring(row('conversationProvider').description):find('Groq', 1, true))
    -- Developer mode adds no row to Development.
    assert(registered.applyBatch('manager', {{id = 'developerMode', value = true}}).ok); loaded = registered.loadMod('manager')
    assert(table.concat(idsOf('development'), ',') == 'developerMode', table.concat(idsOf('development'), ','))
  `);
});

test('The Convai API key row: Paste or Remove with the state in brackets, the failure first in its help, no free-key promotion, two commands, and a status that never shows the key', () => {
  run(`${nsuiFixture}
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
    assert(firstParagraph(row('conversationProvider').description) == 'Convai free tier: limit used up', firstParagraph(row('conversationProvider').description))
    answer('own-limit', {saved = true, tail = 'wxyz', active = 'player', limit = {state = 'used-up', own = true}})
    assert(firstParagraph(row('conversationProvider').description) == 'Your key: plan limit reached')
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
  run(`${nsuiFixture}
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
    -- The note is the paragraph added before the provider row's own help (nil when there is none): the description area holds only so much.
    local function note()
      local text = row('conversationProvider').description
      if text == base then return nil end
      assert(text:sub(-(#base + 2)) == NL2 .. base, 'the note comes before the help')
      return text:sub(1, #text - #base - 2)
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
    -- It says when the turns come back on this computer's clock (the next 00:00 UTC, convaiUiLocale.dailyResetClock), not "tomorrow".
    local resetAt = convaiUiLocale.dailyResetClock()
    assert(resetAt and resetAt:match('^%d%d:%d%d$'), tostring(resetAt))
    assert(mistralHelp:find('You have used today’s 100 turns, which come back at ' .. resetAt .. '.', 1, true) and not mistralHelp:find('tomorrow', 1, true) and mistralHelp:find('Mistral (with your free key, about 5,000 turns a day)', 1, true)
      and mistralHelp:find('Local AI (unlimited).', 1, true) and mistralHelp:find('about 5,000 turns a day', 1, true), mistralHelp)
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
  run(`${nsuiFixture}
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
    assert(provider.description:find('With Mistral, Local AI or Custom, Convai', 1, true), 'the voice paragraph names the options Local AI and Custom')
    assert(not provider.description:find('needs Local AI pack', 1, true) and not provider.description:find('Recommended', 1, true) and not provider.description:find('recommended', 1, true))
    assert(provider.description:find('not available yet', 1, true), 'without local speech recognition the help says so')
    local mistral = row('mistral-key')
    assert(mistral and mistral.type == 'action' and mistral.label == 'Mistral free API key' and mistral.value == 'Paste', mistral.label)
    assert(mistral.description:find('phone verification', 1, true) and mistral.description:find('player-mistral-key.txt', 1, true) and mistral.description:find('about 5,000 turns a day', 1, true))
    assert(row('local-ai-status') == nil and row('own-key-using') == nil and row('mistral-key-status') == nil, 'the status rows are gone')
    assert(firstParagraph(provider.description) == firstParagraph(row('conversationProvider').description))
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
    local function note() return firstParagraph(row('conversationProvider').description) end
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
    -- Limits and the waiting state are told in the first paragraph of the provider row's help.
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
      ['no-memory'] = {'Local AI model (Not enough memory)', 'Not enough free graphics memory to start Local AI. Try a smaller model in Settings.'},
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
    -- Why a failed Local AI is down, in the bridge's own plain words (a model server the player runs that does not answer): shown after the row's sentence, only while it is
    -- failed, never when it is Mature-off (that sentence says what to do), and never a control character or a long text.
    do
      local WHY = 'the model server you added does not answer: start it (and load its model), then the next turn tries again'
      answer('local-ai-detail', {provider = 'local', effective = 'local', localAi = 'failed', localDetail = WHY})
      local model = row('localModel')
      assert(manager.mistral().localDetail == WHY)
      assert(model.label == 'Local AI model (Unavailable)' and firstParagraph(model.description) == WAIT.failed[2] and model.description:find(WHY, 1, true), model.description)
      answer('local-ai-detail-mature', {provider = 'local', effective = 'local', localAi = 'failed', localReason = 'mature-off', localDetail = WHY})
      assert(not row('localModel').description:find(WHY, 1, true))
      answer('local-ai-detail-ready', {provider = 'local', effective = 'local', localAi = 'ready', localDetail = WHY})
      assert(not row('localModel').description:find(WHY, 1, true))
      for _, bad in ipairs({'line\\nbreak', string.rep('x', 161), 7, true}) do
        answer('local-ai-detail-bad-' .. tostring(#tostring(bad)), {provider = 'local', effective = 'local', localAi = 'failed', localDetail = bad})
        assert(manager.mistral().localDetail == nil and firstParagraph(row('localModel').description) == WAIT.failed[2])
      end
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
  run(`${nsuiFixture}
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
  run(`${nsuiFixture}
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
  run(`${nsuiFixture}
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
  run(`${nsuiFixture}
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
    -- A text provider answered in a language the English-only voice cannot speak: shown as text; OmniVoice is named.
    id, text = notice({keyNotice = 'voice-language', text = 'Salut'})
    assert(id == 'voice-language' and text:find('does not speak', 1, true) and text:find('Voxtral', 1, true) and text:find('OmniVoice', 1, true) and not text:find('Recommended', 1, true), text)
    sendProviderNotice({}, 'voice-language', 'v'); assert(sent[#sent] == 'voice-language=v', table.concat(sent, ';')); sent[#sent] = nil
    -- The one-time notices go through the gate under their own ids; anything else sends nothing.
    -- Local AI never hands its turns to a cloud provider (owner rule 2026-10-21): an older bridge's local-fallback (on the first reply or on a failed turn) reads as
    -- Local AI's own sentence under the local-unavailable id, and there is no per-turn cloud notice.
    local expected = 'Local AI could not start. Check Local AI in Settings > Conversation provider.'
    id, text = notice({keyNotice = 'local-fallback', text = 'Hello'})
    assert(id == 'local-unavailable' and text == expected, text)
    id, text = notice({errorCode = 'local-fallback', error = 'x'})
    assert(id == 'local-unavailable' and text == expected, text)
    assert(not text:lower():find('cloud', 1, true) and not text:lower():find('mistral', 1, true) and not text:lower():find('paid', 1, true) and not text:lower():find('text only', 1, true))
    assert(notice({keyNotice = 'local-turn-fallback', text = 'Hello'}) == nil, 'no notice says a cloud provider answered')
    -- Local AI stepped down: the model is named; an older bridge's step-down without a name reads 'another model', never a cloud provider.
    id, text = notice({keyNotice = 'local-stepdown', keyNoticeModel = 'Qwen3.5-2B', text = 'Hello'})
    assert(id == 'local-stepdown' and text == 'Local AI switched to Qwen3.5-2B: the game is using most of your graphics memory.', text)
    id, text = notice({keyNotice = 'local-stepdown', text = 'Hello'})
    assert(id == 'local-stepdown' and text == 'Local AI switched to another model: the game is using most of your graphics memory.', text)
    sendProviderNotice({}, 'mistral-no-key', 'a'); sendProviderNotice({}, 'mistral-voice', 'b'); sendProviderNotice({}, 'key-memory', 'c')
    assert(#sent == 2 and sent[1] == 'mistral-no-key=a' and sent[2] == 'mistral-voice=b', table.concat(sent, ';'))
    sendProviderNotice({}, 'local-fallback', 'd'); sendProviderNotice({}, 'local-turn-fallback', 'd')
    assert(#sent == 2, 'the retired cloud notices send nothing: ' .. table.concat(sent, ';'))
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
    assert(#sent == 3 and sent[3] == 'local-model-fallback=e', table.concat(sent, ';'))
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

test('with the settings menu closed the queue flush, notices and player identity run on a 0.25 s tick, and a queue change or resume runs it at once', () => {
  run(`${nsuiFixture}
    local clock, flushes, identities = 10, 0, 0
    os.clock = function() return clock end
    -- The once-a-second work (settings re-install, preparation feedback) follows the wall clock os.time, which also reads the
    -- player on a real second boundary: hold it still so the count below is only the tick.
    os.time = function() return 0 end
    local party = managerUi.party()
    local flush = party.flush
    party.flush = function(...) flushes = flushes + 1; return flush(...) end
    local getId = player.GetEntityID
    function player:GetEntityID() identities = identities + 1; return getId(self) end
    for _ = 1, 120 do managerUi.update(player, true); clock = clock + 1 / 60 end
    assert(flushes >= 7 and flushes <= 9, 'flushed ' .. flushes .. ' times in two seconds')
    assert(identities <= flushes + 3, 'the player identity was read outside the tick: ' .. identities .. ' for ' .. flushes)
    -- A queue change is flushed by the next frame, inside the tick period.
    managerUi.update(player, true)
    local before = flushes
    party.dismiss('no-such-copy')
    managerUi.update(player, true)
    assert(flushes == before + 1, 'a queue change waited for the tick')
    -- Returning to gameplay runs it at once, so a spawn is not held a quarter second after a menu.
    managerUi.update(player, false)
    before = flushes
    managerUi.update(player, true)
    assert(flushes == before + 1, 'the first gameplay frame did not flush')
  `);
});

test('a notice is held at most one tick: a voice switch reaches the player once and is never lost', () => {
  run(`${nsuiFixture}
    local clock = 10
    os.clock = function() return clock end
    local sent = {}
    convaiNotices = {sendLines = function(_, lines) for _, line in ipairs(lines) do sent[#sent + 1] = line.id end return #lines end}
    managerUi.update(player, true); clock = clock + 1 / 60
    local taken = 0
    manager.takeNaturalSpeechNotice = function() taken = taken + 1; return taken == 1 and 'Voice switched.' or nil end
    local frames = 0
    while #sent == 0 and frames < 60 do managerUi.update(player, true); clock = clock + 1 / 60; frames = frames + 1 end
    assert(#sent == 1 and sent[1] == 'voice-switched', 'the notice was lost')
    assert(frames <= 16, 'the notice waited ' .. frames .. ' frames')
    for _ = 1, 60 do managerUi.update(player, true); clock = clock + 1 / 60 end
    assert(#sent == 1, 'the notice repeated')
  `);
});

// Loading notices: a slow OmniVoice or Local AI load is one notice held on screen until its outcome replaces it (mod/notices.lua
// loading board, manager.loadStatus, mod/manager-ui.lua). Gameplay frames of 0.25 s; the manager reads the bridge's files as it does in
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
      managerUi.update(player, world ~= false)
    end
  end
  managerUi.update(player, true)
`;

test('OmniVoice loading is one notice after 1.5 s that stays until one ready line replaces it; a quick load says nothing', () => {
  run(`${nsuiFixture}${loadingFixture}
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
  run(`${nsuiFixture}${loadingFixture}
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
  run(`${nsuiFixture}${loadingFixture}
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
  run(`${nsuiFixture}${loadingFixture}
    voice.state = 'ready'
    ns.closeScreen()   -- the settings page is not open: only the loading board reads anything
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
    assert(shown[#shown] == 'Not enough free graphics memory to start Local AI. Try a smaller model in Settings.', tostring(shown[#shown]))
    mistral.localAi = 'warming'; step(3); mistral.localAi = 'failed'; step(2)
    assert(shown[#shown] == 'Local AI could not start. Check Local AI in Settings > Conversation provider.', tostring(shown[#shown]))
  `);
});

test('OmniVoice and Local AI loading together are one notice with a line each', () => {
  run(`${nsuiFixture}${loadingFixture}
    ns.closeScreen()
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
  run(`${nsuiFixture}${invitationFixture}${loadingFixture}
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
  run(`${nsuiFixture}${invitationFixture}${loadingFixture}
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
  run(`${nsuiFixture}${invitationFixture}${loadingFixture}
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
  run(`${nsuiFixture}${loadingFixture}
    voice.state = 'ready'
    local calls = 0
    local status = manager.loadStatus
    manager.loadStatus = function() calls = calls + 1; return status() end
    step(20)
    assert(calls >= 18 and calls <= 22, 'read ' .. calls .. ' times in 20 s')
    assert(#shown == 0 and #posts == 0)
    voice.state = 'loading'; step(4)
    assert(#posts >= 1)
    managerUi.resetSession()
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

test('error reports are on by default, apply as on or off only, and the one-time notice is remembered in settings.json', () => run(`${managerFixture}
  manager.configure(api, profiles)
  assert(manager.snapshot(player).settings.errorReports == true and manager.errorReports() == true, 'on by default')
  assert(manager.errorReportsNoticeDue() == true, 'the notice is due once')
  assert(manager.markErrorReportsNoticed() == true and saved.errorReportsNoticed == true)
  assert(manager.errorReportsNoticeDue() == false)
  assert(manager.applySettings(player, {errorReports = 'no'}) == false, 'on or off only')
  assert(manager.errorReports() == true)
  assert(manager.applySettings(player, {errorReports = false}) and saved.errorReports == false)
  assert(manager.errorReports() == false and manager.snapshot(player).settings.errorReports == false)
  assert(manager.errorReportsNoticeDue() == false, 'never due while off')
  assert(manager.applySettings(player, {errorReports = true}) and saved.errorReports == true and saved.errorReportsNoticed == true)
`));

test('a settings file that cannot be read acts as a fresh install for error reports: the setting is never saved off for it, and the notice is due again before anything is sent', () => run(`${managerFixture}
  files['runtime/settings.json'], saved = 'not json at all', nil
  manager.configure(api, profiles)
  assert(manager.errorReports() == true, 'the default, not an opt-out the player never made')
  assert(manager.errorReportsNoticeDue() == true, 'the flag is gone, so the notice is shown and marked again; the service sends nothing before that')
  assert(manager.snapshot(player).settings.errorReports == true)
  assert(manager.snapshot(player).settings.errorReportsNoticed == nil)
`));

test('a hand-edited error-report value that is not true or false is not read as an opt-in: the notice is due again before anything is sent', () => run(`${managerFixture}
  for _, odd in ipairs({'false', 0, 'no'}) do
    seed = {version = 2, errorReports = odd, errorReportsNoticed = true, enabledByKey = {}}
    files['runtime/settings.json'], saved = 'seed', nil
    manager.configure(api, profiles)
    assert(manager.errorReports() == true)
    assert(manager.errorReportsNoticeDue() == true, 'the notice flag went with the value, so the notice shows (and is marked) again')
  end
  seed = {version = 2, errorReports = false, errorReportsNoticed = true, enabledByKey = {}}
  files['runtime/settings.json'], saved = 'seed', nil
  manager.configure(api, profiles)
  assert(manager.errorReports() == false and manager.errorReportsNoticeDue() == false, 'a real opt-out is untouched')
`));

// ---- The owner's settings decisions of 2026-10-20 (the notes: scratchpad/decisions.md, the code: mod/manager.lua, mod/manager-ui.lua).

// What the bridge publishes (runtime/mistral-state.json) as the page reads it, and the way Mature content tests set the Local AI models up.
const matureStateFixture = `
  local clock = 1000
  os.clock = function() return clock end
  local wall = 1000
  os.time = function() return wall end
  local stateCount = 0
  local function file(path, value)
    stateCount = stateCount + 1
    jsonFixtures['state-' .. stateCount] = value
    files[path] = 'state-' .. stateCount
    clock = clock + 2
    manager.snapshot(player)
    loaded = registered.loadMod('manager')
  end
  local function bridge(value) file('runtime/mistral-state.json', value) end
  local MODELS = {{id = 'standard', name = 'Gemma', sizeMiB = 5000}, {id = 'mature:unc', name = 'Gemma uncensored', sizeMiB = 5200}}
  -- Local AI installed, with its uncensored model; a Mistral key saved or not.
  local function withLocalAi(keySaved)
    bridge({provider = 'convai', effective = 'convai', localAi = 'ready', saved = keySaved, localModels = MODELS,
      localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
  end
  -- No Local AI pack: only the Mistral key (saved or not).
  local function withoutLocalAi(keySaved) bridge({provider = 'convai', effective = 'convai', saved = keySaved}) end
  local function shown() return managerUi.inspect().shown end
  -- Back to a plain starting point with Mature content off (the choices stay as they are).
  local function matureOff() assert(manager.applySettings(player, {matureContent = false})) end
`;

test('Mature content and Voxtral: turning it on moves a companion voice and V from Voxtral to Pocket (named in the line, recorded), whatever the provider; the Convai cloud voice and OmniVoice stay; turning it off puts Voxtral back while the key is saved', () => {
  run(`${nsuiFixture}${matureStateFixture}
    withLocalAi(true)
    assert(invoke('tab:settings').ok); loaded = registered.loadMod('manager')
    -- The page's way of turning it off puts back what turning it on changed (applySettings alone does not).
    local function pageOff() assert(core.apply({{id = 'matureContent', value = false}}).ok) end
    -- Companion and V on Voxtral, Convai text, Local AI installed: Mature content on selects Local AI and the uncensored model, and both voices move to Pocket.
    assert(manager.applySettings(player, {voiceProvider = 'voxtral', vVoiceEngine = 'voxtral'}))
    local result = core.apply({{id = 'matureContent', value = true}})
    assert(result.ok and result.refusal == nil, tostring(result.error))
    assert(saved.matureContent == true and saved.conversationProvider == 'local' and saved.localModel == 'mature:unc')
    assert(saved.voiceProvider == 'pocket' and saved.vVoiceEngine == 'pocket' and saved.vVoice == true, tostring(saved.voiceProvider) .. ' ' .. tostring(saved.vVoiceEngine))
    assert(table.concat(result.names, ', ') == 'Local AI, Uncensored model, Pocket · Performance, V’s voice for typed lines', table.concat(result.names, ', '))
    assert(shown() == 'Also changed: Local AI, Uncensored model, Pocket · Performance, V’s voice for typed lines.', tostring(shown()))
    -- The way back names all four.
    local way = saved.matureRestore
    assert(way.conversationProvider.before == 'convai' and way.conversationProvider.set == 'local', 'provider part')
    assert(way.localModel.before == 'standard' and way.localModel.set == 'mature:unc', 'model part')
    assert(way.voice.before.provider == 'voxtral' and way.voice.set.provider == 'pocket', 'voice part')
    assert(way.vVoiceEngine.before == 'voxtral' and way.vVoiceEngine.set == 'pocket', 'V part')
    -- Turning it off puts all four back (the key is saved).
    result = core.apply({{id = 'matureContent', value = false}})
    assert(result.ok and saved.matureContent == false and saved.conversationProvider == 'convai' and saved.localModel == 'standard', tostring(result.error))
    assert(saved.voiceProvider == 'voxtral' and saved.vVoiceEngine == 'voxtral' and saved.vVoice == true and saved.matureRestore == nil)
    assert(table.concat(result.names, ', '):find('Companion voices', 1, true) and table.concat(result.names, ', '):find('V’s voice for typed lines', 1, true), table.concat(result.names, ', '))
    -- The Convai cloud voice and OmniVoice stay where they are, from any provider.
    for _, voice in ipairs({'convai', 'omni'}) do
      assert(manager.applySettings(player, {voiceProvider = voice, vVoiceEngine = 'pocket'}), voice)
      result = core.apply({{id = 'matureContent', value = true}})
      assert(result.ok and saved.matureContent == true and saved.voiceProvider == voice and saved.vVoiceEngine == 'pocket', voice)
      assert(table.concat(result.names, ', ') == 'Local AI, Uncensored model' and saved.matureRestore.voice == nil and saved.matureRestore.vVoiceEngine == nil, voice .. ' ' .. table.concat(result.names, ', '))
      pageOff()
    end
    -- Local AI and Custom text, a companion on Voxtral and V on Voxtral: both move; Pocket and V Off are left alone.
    for _, provider in ipairs({'local', 'custom'}) do
      assert(manager.applySettings(player, {conversationProvider = provider, voiceProvider = 'voxtral', vVoiceEngine = 'voxtral'}), provider)
      result = core.apply({{id = 'matureContent', value = true}})
      assert(result.ok and saved.matureContent == true and saved.conversationProvider == provider, provider)
      assert(saved.voiceProvider == 'pocket' and saved.vVoiceEngine == 'pocket', provider)
      pageOff()
      assert(saved.voiceProvider == 'voxtral' and saved.vVoiceEngine == 'voxtral', provider .. ' back')
    end
    assert(manager.applySettings(player, {conversationProvider = 'local', voiceProvider = 'pocket', vVoice = false, vVoiceEngine = 'voxtral'}))
    result = core.apply({{id = 'matureContent', value = true}})
    assert(result.ok and saved.vVoice == false and saved.vVoiceEngine == 'pocket' and saved.voiceProvider == 'pocket', 'V Off: the saved engine still moves, V stays off')
    pageOff()
    -- Mistral text with Mature content: it is Local AI (the pack is installed) that Mature content selects, and the voices move with it.
    assert(manager.applySettings(player, {conversationProvider = 'mistral', voiceProvider = 'voxtral', vVoice = true, vVoiceEngine = 'voxtral'}))
    result = core.apply({{id = 'matureContent', value = true}})
    assert(result.ok and saved.matureContent == true and saved.conversationProvider == 'local' and saved.voiceProvider == 'pocket' and saved.vVoiceEngine == 'pocket')
    assert(saved.matureRestore.conversationProvider.before == 'mistral')
    pageOff()
    assert(saved.conversationProvider == 'mistral' and saved.voiceProvider == 'voxtral' and saved.vVoiceEngine == 'voxtral', 'turning it off puts Mistral and Voxtral back')
    -- The key is removed while it is on: turning it off still works (no refusal loop) and the voices stay on Pocket.
    assert(manager.applySettings(player, {conversationProvider = 'local', voiceProvider = 'voxtral', vVoiceEngine = 'voxtral'}))
    assert(core.apply({{id = 'matureContent', value = true}}).ok)
    withLocalAi(false)
    result = core.apply({{id = 'matureContent', value = false}})
    assert(result.ok and saved.matureContent == false and saved.voiceProvider == 'pocket' and saved.vVoiceEngine == 'pocket', tostring(result.error))
    withLocalAi(true)
    -- A voice the player changed while it was on is not put back; a voice chosen in the same batch wins.
    assert(manager.applySettings(player, {conversationProvider = 'local', voiceProvider = 'voxtral', vVoiceEngine = 'voxtral'}))
    assert(core.apply({{id = 'matureContent', value = true}}).ok and saved.voiceProvider == 'pocket')
    assert(manager.applySettings(player, {voiceProvider = 'omni'}))
    result = core.apply({{id = 'matureContent', value = false}})
    assert(result.ok and saved.voiceProvider == 'omni' and saved.vVoiceEngine == 'voxtral', 'the companion voice stays on what the player chose; V goes back')
    local OMNI
    for index, choice in ipairs(dofile('voice-preview.lua').CHOICES) do if choice.provider == 'convai' then OMNI = index + 1 end end
    assert(manager.applySettings(player, {conversationProvider = 'local', voiceProvider = 'voxtral', vVoiceEngine = 'voxtral'}))
    assert(core.apply({{id = 'matureContent', value = true}}).ok)
    result = core.apply({{id = 'matureContent', value = false}, {id = 'voiceProvider', value = OMNI}, {id = 'vVoice', value = 2}})
    assert(result.ok and saved.voiceProvider == 'convai' and saved.vVoiceEngine == 'pocket', 'what the batch asks for wins')
  `);
});

test('Mature content refuses a Voxtral choice (companions and V), greys the entry out with its own reason and says so in its label; with it off Voxtral is chosen as before', () => {
  run(`${nsuiFixture}${matureStateFixture}
    withLocalAi(true)
    assert(invoke('tab:settings').ok); loaded = registered.loadMod('manager')
    local VOXTRAL
    for index, choice in ipairs(dofile('voice-preview.lua').CHOICES) do if choice.provider == 'voxtral' then VOXTRAL = index + 1 end end
    -- Off: Voxtral is a plain, enabled entry (the key is saved).
    assert(row('voiceProvider').elements[VOXTRAL] == 'Voxtral (recommended)' and (row('voiceProvider').disabledElements == nil or row('voiceProvider').disabledElements[VOXTRAL] == nil))
    assert(row('vVoice').elements[3] == 'Voxtral · Mistral cloud' and (row('vVoice').disabledElements or {})[3] == nil)
    assert(core.apply({{id = 'voiceProvider', value = VOXTRAL}}).ok and saved.voiceProvider == 'voxtral')
    assert(core.apply({{id = 'vVoice', value = 3}}).ok and saved.vVoiceEngine == 'voxtral')
    assert(core.apply({{id = 'voiceProvider', value = 2}, {id = 'vVoice', value = 2}}).ok)
    -- On (Local AI): both entries are greyed out with the reason, and their labels say so, whatever the key.
    assert(core.apply({{id = 'matureContent', value = true}}).ok and saved.matureContent == true)
    loaded = registered.loadMod('manager')
    local companions, engine = row('voiceProvider'), row('vVoice')
    assert(companions.elements[VOXTRAL] == 'Voxtral · not with Mature' and engine.elements[3] == 'Voxtral · not with Mature', companions.elements[VOXTRAL])
    assert(companions.disabledElements[VOXTRAL] == 'Voxtral is not used with Mature content.', tostring(companions.disabledElements[VOXTRAL]))
    assert(engine.disabledElements[3] == true and engine.disabledReason == 'Voxtral is not used with Mature content.', tostring(engine.disabledReason))
    for _, element in ipairs(companions.elements) do assert(core.optionUnits(element) <= core.OPTION_BUDGET, element) end
    for _, element in ipairs(engine.elements) do assert(core.optionUnits(element) <= core.OPTION_BUDGET, element) end
    for _, banned in ipairs({'recommended', 'antivirus'}) do assert(not companions.elements[VOXTRAL]:lower():find(banned, 1, true)) end
    -- The page refuses them and saves nothing; so does the manager for a caller of its own.
    for _, change in ipairs({{id = 'voiceProvider', value = VOXTRAL}, {id = 'vVoice', value = 3}}) do
      local result = core.apply({change})
      assert(result.ok == false and result.error == 'Voxtral is not used with Mature content.', change.id .. ' ' .. tostring(result.error))
    end
    assert(saved.voiceProvider == 'pocket' and saved.vVoiceEngine == 'pocket' and saved.matureContent == true)
    local refused, why = manager.applySettings(player, {voiceProvider = 'voxtral'})
    assert(refused == false and why == 'Voxtral is not used with Mature content.')
    refused, why = manager.applySettings(player, {vVoiceEngine = 'voxtral'})
    assert(refused == false and why == 'Voxtral is not used with Mature content.')
    -- A batch that turns Mature content off and chooses Voxtral at once is fine.
    assert(core.apply({{id = 'matureContent', value = false}, {id = 'voiceProvider', value = VOXTRAL}}).ok and saved.voiceProvider == 'voxtral' and saved.matureContent == false)
    -- A batch that turns it on and chooses Voxtral at once moves it to Pocket instead of refusing, and names it.
    local result = core.apply({{id = 'matureContent', value = true}, {id = 'voiceProvider', value = VOXTRAL}, {id = 'vVoice', value = 3}})
    assert(result.ok and saved.matureContent == true and saved.voiceProvider == 'pocket' and saved.vVoiceEngine == 'pocket', tostring(result.error))
    -- The key is not what decides it: without a key the entry says the key is missing when Mature content is off.
    matureOff()
    withLocalAi(false)
    assert(row('voiceProvider').elements[VOXTRAL] == 'Voxtral · needs Mistral key' and row('vVoice').elements[3] == 'Voxtral · needs Mistral key')
  `);
});

// The owner's rule (2026-10-26): the Local AI model row always lists every installed model, with Mature content on or off, and choosing a model of the
// Local AI packs (not a Mature one) while Mature content is on and a Mature model is installed turns Mature content off in that Apply, with a sentence.
test('The Local AI model row lists every installed model with Mature content on or off; choosing a standard model while it is on turns Mature content off (provider stays Local AI, sentence shown); a Mature model, a custom model, no Mature model installed and a Mature switch in the same batch behave as before', () => {
  run(`${nsuiFixture}${matureStateFixture}
    local SENTENCE = 'Mature content is turned off because you chose a model that is not a Mature model.'
    local function names()
      local list = {}
      for _, choice in ipairs(manager.localModelChoices()) do list[#list + 1] = choice.id end
      return table.concat(list, ',')
    end
    withLocalAi(true)
    assert(invoke('tab:settings').ok); loaded = registered.loadMod('manager')
    -- Off: both models are listed, and turning Mature content on does not hide the standard one.
    assert(names() == 'standard,mature:unc' and #row('localModel').elements == 2, names())
    assert(core.apply({{id = 'conversationProvider', value = 4}}).ok)
    assert(core.apply({{id = 'matureContent', value = true}}).ok and saved.matureContent == true and saved.localModel == 'mature:unc')
    loaded = registered.loadMod('manager')
    assert(names() == 'standard,mature:unc' and #row('localModel').elements == 2 and row('localModel').value == 2, 'on: still both models, the Mature one selected')
    -- Picking the Mature model again changes nothing.
    local result = core.apply({{id = 'localModel', value = 2}})
    assert(result.ok and saved.matureContent == true and saved.localModel == 'mature:unc' and shown() ~= SENTENCE, tostring(shown()))
    -- Picking the standard model: Mature content goes off in the same Apply, the model stays, Local AI stays the provider, and the line says why.
    result = core.apply({{id = 'localModel', value = 1}})
    assert(result.ok and saved.matureContent == false and saved.localModel == 'standard' and saved.conversationProvider == 'local', tostring(result.error))
    assert(shown() == SENTENCE, tostring(shown()))
    assert(saved.matureRestore == nil, 'the way back goes with Mature content')
    loaded = registered.loadMod('manager')
    assert(names() == 'standard,mature:unc' and row('localModel').value == 1, 'off: both models are still listed')
    -- The reverse: Mature content off while the Mature model is selected moves the row to the standard model, named in the line (the bridge never loads a Mature model with it off).
    assert(core.apply({{id = 'matureContent', value = true}}).ok and saved.localModel == 'mature:unc')
    result = core.apply({{id = 'matureContent', value = false}})
    assert(result.ok and saved.matureContent == false and saved.localModel == 'standard' and shown():find('Local AI model', 1, true), tostring(shown()))
    -- Turning it on and choosing the standard model in one batch: turning it on wins, as before (the uncensored model is selected and named, the way back remembers the standard one).
    result = core.apply({{id = 'matureContent', value = true}, {id = 'localModel', value = 1}})
    assert(result.ok and saved.matureContent == true and saved.localModel == 'mature:unc' and saved.matureRestore.localModel.before == 'standard', tostring(result.error))
    -- Custom provider: the model row does not matter there, nothing is turned off.
    assert(core.apply({{id = 'matureContent', value = false}}).ok)
    -- A model the player added is not judged: Mature content stays on.
    bridge({provider = 'local', effective = 'local', localAi = 'ready', saved = true, localModelDefault = 'standard', localModelMatureDefault = 'mature:unc',
      localModels = {MODELS[1], MODELS[2], {id = 'custom:mine', name = 'Mine', sizeMiB = 6000, custom = true, needMiB = 7000}}})
    assert(core.apply({{id = 'matureContent', value = true}, {id = 'localModel', value = 2}}).ok and saved.matureContent == true)
    result = core.apply({{id = 'localModel', value = 3}})
    assert(result.ok and saved.localModel == 'custom:mine' and saved.matureContent == true and shown() ~= SENTENCE, tostring(shown()))
    -- No Mature model installed: Mature content works with any model, so choosing another one leaves it on.
    matureOff()
    bridge({provider = 'local', effective = 'local', localAi = 'ready', saved = true, localModelDefault = 'lite',
      localModels = {{id = 'lite', name = 'Bonsai', sizeMiB = 1100}, {id = 'standard', name = 'Gemma', sizeMiB = 5000}}})
    assert(core.apply({{id = 'matureContent', value = true}}).ok and saved.matureContent == true)
    result = core.apply({{id = 'localModel', value = 2}})
    assert(result.ok and saved.localModel == 'standard' and saved.matureContent == true and shown() ~= SENTENCE, tostring(shown()))
  `);
});

test('Mature content and the way back: an old saved record keeps its voice parts, a Voxtral voice beside Mature content in a saved file is Pocket, Mature content off puts Voxtral back only while the key is saved and the voice is still Pocket, and Restore defaults wins', () => {
  run(`${nsuiFixture}${matureStateFixture}
    local function load(extra)
      seed = {version = 2, subtitleStyle = 'dialogue', omniSteps = 16, enabledByKey = {}, matureContent = true, conversationProvider = 'local',
        localModel = 'mature:unc', voiceProvider = 'pocket', vVoiceEngine = 'pocket'}
      for key, value in pairs(extra) do seed[key] = value end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.reset(); manager.configure(api, profiles)
      return manager.snapshot(player).settings
    end
    local VOICES = {voice = {before = {provider = 'voxtral'}, set = {provider = 'pocket'}}, vVoiceEngine = {before = 'voxtral', set = 'pocket'}}
    local state = load({matureRestore = {conversationProvider = {before = 'convai', set = 'local'}, localModel = {before = 'standard', set = 'mature:unc'},
      voice = VOICES.voice, vVoiceEngine = VOICES.vVoiceEngine}})
    local way = state.matureRestore
    assert(way and way.conversationProvider.before == 'convai' and way.localModel.before == 'standard', 'provider and model parts are kept')
    assert(way.voice.before.provider == 'voxtral' and way.voice.set.provider == 'pocket' and way.vVoiceEngine.before == 'voxtral', 'the voice parts are kept')
    assert(state.matureContent == true and state.voiceProvider == 'pocket' and state.vVoiceEngine == 'pocket')
    -- A record with only voice parts is a record.
    state = load({matureRestore = {voice = VOICES.voice, vVoiceEngine = VOICES.vVoiceEngine}})
    assert(state.matureRestore and state.matureRestore.voice and state.matureRestore.vVoiceEngine)
    -- A saved Voxtral beside Mature content (an older file, a hand edit) loads as Pocket, for the companions and for V, and the file is mended.
    state = load({voiceProvider = 'voxtral', vVoiceEngine = 'voxtral'})
    assert(state.voiceProvider == 'pocket' and state.vVoiceEngine == 'pocket' and saved.voiceProvider == 'pocket' and saved.vVoiceEngine == 'pocket' and state.matureContent == true)
    -- With Mature content off the same file keeps Voxtral.
    state = load({matureContent = false, conversationProvider = 'convai', voiceProvider = 'voxtral', vVoiceEngine = 'voxtral'})
    assert(state.voiceProvider == 'voxtral' and state.vVoiceEngine == 'voxtral')
    -- Mature content off with the record: Voxtral comes back when the key is saved and the voices are still Pocket.
    withLocalAi(true)
    local opened = false
    local function turnOff(extra, changes)
      load(extra)
      if not opened then opened = true; assert(invoke('tab:settings').ok); loaded = registered.loadMod('manager') end
      local batch = {{id = 'matureContent', value = false}}
      for _, change in ipairs(changes or {}) do batch[#batch + 1] = change end
      return core.apply(batch)
    end
    local RECORD = {conversationProvider = {before = 'convai', set = 'local'}, localModel = {before = 'standard', set = 'mature:unc'}, voice = VOICES.voice, vVoiceEngine = VOICES.vVoiceEngine}
    local result = turnOff({matureRestore = RECORD})
    assert(result.ok and saved.matureContent == false and saved.conversationProvider == 'convai' and saved.voiceProvider == 'voxtral' and saved.vVoiceEngine == 'voxtral', tostring(result.error))
    withLocalAi(false)
    result = turnOff({matureRestore = RECORD})
    assert(result.ok and saved.matureContent == false and saved.voiceProvider == 'pocket' and saved.vVoiceEngine == 'pocket', 'no key: Voxtral stays off and Mature content still turns off')
    withLocalAi(true)
    result = turnOff({matureRestore = RECORD, voiceProvider = 'omni'})
    assert(result.ok and saved.voiceProvider == 'omni' and saved.vVoiceEngine == 'voxtral', 'a voice the player changed is not put back')
    result = turnOff({matureRestore = RECORD, vVoice = false, vVoiceChosen = true})
    assert(result.ok and saved.vVoice == false and saved.vVoiceEngine == 'pocket' and saved.voiceProvider == 'voxtral', 'V Off stays off')
    -- Restore defaults with Mature content on and such a record: the rows it names are at their defaults (Pocket), Voxtral does not come back.
    load({matureRestore = RECORD})
    local changes = core.defaults()
    local at = {}
    for index, change in ipairs(changes) do at[change.id] = index end
    assert(at.matureContent and at.conversationProvider and at.voiceProvider and at.vVoice, 'the rows the way back would put back are named at their default')
    assert(changes[at.matureContent].value == false and changes[at.conversationProvider].value == 1 and changes[at.voiceProvider].value == 2 and changes[at.vVoice].value == 2)
    assert(core.apply(changes).ok)
    assert(saved.matureContent == false and saved.conversationProvider == 'convai' and saved.voiceProvider == 'pocket' and saved.vVoiceEngine == 'pocket' and saved.vVoice == true)
    local ids = {}
    for _, change in ipairs(changes) do ids[#ids + 1] = change.id end
    assert(not table.concat(ids, ','):find('vVoiceEngine', 1, true), 'no separate engine entry')
  `);
});


test('Johnnys hologram and V talks on their own are gone: an old saved value is ignored and dropped from the file once, there is no row (not even with Developer mode), no getter, and an Apply that carries them is ignored', () => {
  run(`${managerFixture}
    for _, case in ipairs({{true, 'normal'}, {false, 'off'}, {true, 'rare'}, {'yes', 7}, {false, 'sometimes'}}) do
      seed = {version = 2, subtitleStyle = 'dialogue', voiceProvider = 'pocket', omniSteps = 16, enabledByKey = {},
        johnnyHologram = case[1], vTalks = case[2], future = {keep = 'unchanged'}}
      files['runtime/settings.json'], saved = 'seed', nil
      manager.reset(); manager.configure(api, profiles)
      local state = manager.snapshot(player).settings
      assert(state.johnnyHologram == nil and state.vTalks == nil, 'not in the snapshot')
      assert(manager.johnnyHologram == nil and manager.vTalks == nil, 'no getters')
      assert(saved and saved.johnnyHologram == nil and saved.vTalks == nil and saved.future.keep == 'unchanged', 'dropped from the saved file')
      -- Once: the next load finds nothing to drop and saves nothing.
      local before = saved
      manager.reset(); manager.configure(api, profiles); manager.snapshot(player)
      assert(saved == before, 'the second load saved again')
    end
    -- An Apply from an old caller that still passes them: accepted, nothing saved for them, whatever the value.
    manager.reset(); manager.configure(api, profiles)
    assert(manager.applySettings(player, {johnnyHologram = true, vTalks = 'normal'}))
    assert(saved.johnnyHologram == nil and saved.vTalks == nil and manager.snapshot(player).settings.johnnyHologram == nil)
    assert(manager.applySettings(player, {johnnyHologram = 'yes', vTalks = 'never', voice = false}))
    assert(saved.johnnyHologram == nil and saved.vTalks == nil and saved.voice == false, 'the rest of the Apply was saved')
  `);
  run(`${nsuiFixture}
    local function offered()
      local found = {}
      for _, category in ipairs(loaded.categories) do
        for _, item in ipairs(category.settings) do
          found[#found + 1] = tostring(item.id) .. '|' .. tostring(item.label) .. '|' .. tostring(item.description)
        end
      end
      return table.concat(found, string.char(10))
    end
    assert(invoke('tab:settings').ok)
    for _, developer in ipairs({false, true}) do
      assert(manager.applySettings(player, {developerMode = developer}))
      loaded = registered.loadMod('manager')
      assert(row('johnnyHologram') == nil and row('vTalks') == nil, 'no row, developer ' .. tostring(developer))
      local text = offered()
      for _, banned in ipairs({'johnnyHologram', 'vTalks', 'hologram', 'V talks on their own'}) do
        assert(not text:find(banned, 1, true), banned .. ' is on the page, developer ' .. tostring(developer))
      end
    end
    -- Developer mode itself is unchanged: its row, and its text about the movement trace.
    assert(row('developerMode').type == 'bool' and row('developerMode').value == true)
    assert(row('developerMode').description:find('movement trace', 1, true))
    -- An Apply for them through the page is refused as the removed rows are: nothing saved.
    for _, id in ipairs({'johnnyHologram', 'vTalks'}) do
      local result = registered.applyBatch('manager', {{id = id, value = 3}})
      assert(result.ok == false and saved[id] == nil, id)
    end
  `);
});

// A ready Custom endpoint as the bridge publishes it (mod/custom-provider.lua reads runtime/custom-provider-state.json).
const customReadyFixture = `
  local function custom(ready)
    stateCount = stateCount + 1
    jsonFixtures['custom-' .. stateCount] = {version = 1, updated = stateCount, ready = ready, host = ready and 'localhost:11434' or nil, secure = false,
      ['local'] = true, model = ready and 'llama3.2' or nil, keySaved = false}
    files['runtime/custom-provider-state.json'] = 'custom-' .. stateCount
    clock = clock + 2
    manager.snapshot(player)
    loaded = registered.loadMod('manager')
  end
`;

test('Mature content on from Convai or Mistral without the Local AI pack: a ready Custom endpoint selects Custom, else it is refused, never Mistral, whatever key is saved; Local AI still comes first; choosing Convai or Mistral in the same batch is refused', () => {
  run(`${nsuiHarness({modules: {'custom-provider.lua': moduleSource('custom-provider.lua')}})}${matureStateFixture}${customReadyFixture}
    assert(invoke('tab:settings').ok)
    local REFUSED = 'Needs Local AI or Custom.'
    local function mature(value) return core.apply({{id = 'matureContent', value = value}}) end
    -- Convai free tier, a Mistral key saved, no Local AI pack and no Custom endpoint: refused (Mistral is never selected).
    withoutLocalAi(true); custom(false)
    local result = mature(true)
    assert(result.ok and result.refusal == REFUSED, tostring(result.refusal))
    assert(saved.matureContent == false and saved.conversationProvider == 'convai' and saved.matureRestore == nil, tostring(saved.conversationProvider))
    assert(shown() == REFUSED, tostring(shown()))
    loaded = registered.loadMod('manager'); assert(row('matureContent').value == false)
    -- The same from Mistral itself: refused, and it stays on Mistral.
    assert(manager.applySettings(player, {conversationProvider = 'mistral'}))
    result = mature(true)
    assert(result.refusal == REFUSED and saved.matureContent == false and saved.conversationProvider == 'mistral')
    assert(manager.applySettings(player, {conversationProvider = 'convai'}))
    -- A ready Custom endpoint: Custom, whether or not a key is saved. Turning it off puts the provider back.
    withoutLocalAi(true); custom(true)
    result = mature(true)
    assert(result.ok and result.refusal == nil and saved.matureContent == true and saved.conversationProvider == 'custom', tostring(saved.conversationProvider))
    assert(saved.matureRestore.conversationProvider.before == 'convai' and saved.matureRestore.conversationProvider.set == 'custom')
    assert(table.concat(result.names, ', ') == 'Custom (OpenAI-compatible)' and shown() == 'Also changed: Custom (OpenAI-compatible).', tostring(shown()))
    result = mature(false)
    assert(result.ok and saved.conversationProvider == 'convai' and saved.matureContent == false and saved.matureRestore == nil)
    -- The own-key entry of Convai (Convai API key): the record says so, and the own key comes back.
    assert(manager.applySettings(player, {conversationProvider = 'convai', useOwnConvaiKey = true}))
    result = mature(true)
    assert(result.ok and saved.matureContent == true and saved.conversationProvider == 'custom')
    assert(saved.matureRestore.conversationProvider.before == 'convai-key' and saved.matureRestore.conversationProvider.set == 'custom')
    result = mature(false)
    assert(result.ok and saved.conversationProvider == 'convai' and saved.useOwnConvaiKey == true and saved.matureContent == false)
    assert(manager.applySettings(player, {conversationProvider = 'convai', useOwnConvaiKey = false}))
    -- From Mistral with a ready Custom endpoint: Custom, and turning it off goes back to Mistral.
    assert(manager.applySettings(player, {conversationProvider = 'mistral'}))
    result = mature(true)
    assert(result.ok and saved.matureContent == true and saved.conversationProvider == 'custom')
    assert(saved.matureRestore.conversationProvider.before == 'mistral' and saved.matureRestore.conversationProvider.set == 'custom')
    result = mature(false)
    assert(result.ok and saved.conversationProvider == 'mistral' and saved.matureContent == false, 'back to Mistral')
    assert(manager.applySettings(player, {conversationProvider = 'convai'}))
    -- An endpoint that is not ready (no address or model ID) counts as none; the Convai API key entry is refused the same way.
    withoutLocalAi(true); custom(false)
    assert(manager.applySettings(player, {conversationProvider = 'convai', useOwnConvaiKey = true}))
    result = mature(true)
    assert(result.refusal == REFUSED and saved.matureContent == false and saved.conversationProvider == 'convai' and saved.useOwnConvaiKey == true)
    assert(manager.applySettings(player, {useOwnConvaiKey = false}))
    -- Local AI installed still selects Local AI first, even with a Mistral key and a ready Custom endpoint.
    withLocalAi(true); custom(true)
    result = mature(true)
    assert(result.ok and saved.matureContent == true and saved.conversationProvider == 'local', tostring(saved.conversationProvider))
    assert(saved.matureRestore.conversationProvider.set == 'local' and table.concat(result.names, ', ') == 'Local AI, Uncensored model')
    assert(mature(false).ok and saved.conversationProvider == 'convai')
    -- The same batch choosing Convai or Mistral: the player's choice stays and Mature content is refused, whatever else is set up.
    for _, case in ipairs({{true, 'key + Local AI'}, {false, 'Custom only'}}) do
      if case[1] then withLocalAi(true) else withoutLocalAi(false); custom(true) end
      for _, entry in ipairs({1, 2, 3}) do
        result = core.apply({{id = 'matureContent', value = true}, {id = 'conversationProvider', value = entry}})
        assert(result.ok and result.refusal == REFUSED, case[2] .. ' ' .. entry .. ': ' .. tostring(result.refusal))
        assert(saved.matureContent == false and saved.conversationProvider == (entry == 3 and 'mistral' or 'convai') and saved.useOwnConvaiKey == (entry == 2), case[2] .. ' ' .. entry)
        assert(manager.applySettings(player, {conversationProvider = 'convai', useOwnConvaiKey = false}))
      end
    end
    -- Beside Custom already chosen, it changes nothing else.
    withoutLocalAi(true)
    assert(manager.applySettings(player, {conversationProvider = 'custom'}))
    result = mature(true)
    assert(result.ok and saved.matureContent == true and saved.conversationProvider == 'custom' and #result.names == 0 and result.refusal == nil)
    -- Choosing Mistral while it is on turns it off, and puts nothing else back it did not change.
    result = core.apply({{id = 'conversationProvider', value = 3}})
    assert(result.ok and saved.conversationProvider == 'mistral' and saved.matureContent == false)
    -- Choosing Convai (either entry) while it is on turns it off as before.
    assert(manager.applySettings(player, {conversationProvider = 'custom'}))
    assert(mature(true).ok and saved.matureContent == true)
    result = core.apply({{id = 'conversationProvider', value = 1}})
    assert(result.ok and saved.conversationProvider == 'convai' and saved.matureContent == false)
  `);
});


test('the Mistral key row\'s Remove help says what the key still powers: the conversations on Mistral, the companions on Voxtral, V on Voxtral, both, or nothing; the Convai key rows keep their old help', () => {
  run(`${nsuiFixture}${matureStateFixture}
    local NL2 = string.char(10, 10)
    local TAIL = NL2 .. 'Saved on this computer only. Only the last four characters are ever shown.'
    local FIXED = 'Deletes the saved key.'
    bridge({provider = 'convai', effective = 'convai', saved = true, tail = 'abcd'})
    assert(invoke('tab:settings').ok); loaded = registered.loadMod('manager')
    local function help() loaded = registered.loadMod('manager'); return row('mistral-key').description end
    local function set(values) assert(manager.applySettings(player, values)); return help() end
    assert(row('mistral-key').value == 'Remove')
    -- Nothing depends on it: Convai text, Pocket companions, V on Pocket.
    assert(help() == FIXED .. ' Nothing you use now depends on it.' .. TAIL, help())
    -- Conversations on Mistral only.
    assert(set({conversationProvider = 'mistral'}) == FIXED .. ' Conversations go back to Convai free tier.' .. TAIL, help())
    -- Companions on Voxtral only.
    assert(set({conversationProvider = 'convai', voiceProvider = 'voxtral'}) == FIXED .. ' Voxtral stops speaking; companion replies show as text until a key is saved.' .. TAIL, help())
    -- V on Voxtral only (V's voice on).
    assert(set({voiceProvider = 'pocket', vVoiceEngine = 'voxtral'}) == FIXED .. ' V’s voice switches from Voxtral to Pocket.' .. TAIL, help())
    -- V's voice off keeps the engine, but it powers nothing.
    assert(set({vVoice = false}) == FIXED .. ' Nothing you use now depends on it.' .. TAIL, help())
    assert(set({vVoice = true}) == FIXED .. ' V’s voice switches from Voxtral to Pocket.' .. TAIL)
    -- Mistral and Voxtral together: both sentences, in that order.
    assert(set({conversationProvider = 'mistral', voiceProvider = 'voxtral', vVoiceEngine = 'pocket'})
      == FIXED .. ' Conversations go back to Convai free tier. Voxtral stops speaking; companion replies show as text until a key is saved.' .. TAIL, help())
    assert(set({conversationProvider = 'mistral', voiceProvider = 'pocket', vVoiceEngine = 'voxtral'})
      == FIXED .. ' Conversations go back to Convai free tier. V’s voice switches from Voxtral to Pocket.' .. TAIL, help())
    assert(set({voiceProvider = 'voxtral'})
      == FIXED .. ' Conversations go back to Convai free tier. Voxtral stops speaking; companion replies show as text until a key is saved. V’s voice switches from Voxtral to Pocket.' .. TAIL, help())
    -- Without a saved key the row is the paste row and says nothing about removal.
    bridge({provider = 'convai', effective = 'convai', saved = false})
    loaded = registered.loadMod('manager')
    assert(row('mistral-key').value == 'Paste' and not row('mistral-key').description:find('Deletes the saved key', 1, true))
    -- The Convai API key row keeps its own help, whatever Mistral powers.
    local token = 'own-saved'
    jsonFixtures[token] = {saved = true, tail = 'wxyz', active = 'player'}
    files['runtime/own-key-state.json'] = token
    clock = clock + 2; manager.snapshot(player); loaded = registered.loadMod('manager')
    assert(row('own-key').value == 'Remove')
    assert(row('own-key').description == 'Deletes the saved key. Conversations go back to Convai free tier.' .. TAIL, row('own-key').description)
    assert(set({conversationProvider = 'convai', voiceProvider = 'pocket'}) and row('own-key').description == 'Deletes the saved key. Conversations go back to Convai free tier.' .. TAIL)
  `);
});

test('the Interface language help says the microphone uses it as a hint for non-English speech', () => {
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    local language = row('uiLanguage')
    assert(language.description == 'Changes this mod’s menus and notices only.' .. string.char(10, 10)
      .. 'Character voices and the language you talk in are separate. The microphone uses this language as a hint for non-English speech.', language.description)
  `);
});

test('Natural speech at load: the Convai cloud voice beside Convai (free tier or own key) turns it off silently; beside Mistral, Local AI or Custom it stays on; other voices keep it', () => {
  run(`${managerFixture}
    -- A case is {saved Natural speech, voice, provider, own key, expected Natural speech}.
    for _, case in ipairs({
      {true, 'convai', 'convai', false, false}, {true, 'convai', 'convai', true, false},
      {true, 'convai', 'mistral', false, true}, {true, 'convai', 'local', false, true}, {true, 'convai', 'custom', false, true},
      {true, 'pocket', 'convai', false, true}, {true, 'omni', 'convai', true, true}, {true, 'voxtral', 'convai', false, true},
      {false, 'convai', 'convai', false, false}, {false, 'convai', 'mistral', false, false}}) do
      seed = {version = 2, voiceProvider = case[2], conversationProvider = case[3], useOwnConvaiKey = case[4], naturalSpeech = case[1],
        enabledByKey = {}, future = {keep = 'unchanged'}}
      files['runtime/settings.json'], saved = 'seed', nil
      manager.reset(); manager.configure(api, profiles); manager.prepare(player)
      local label = tostring(case[1]) .. ' ' .. case[2] .. ' ' .. case[3] .. ' ' .. tostring(case[4])
      assert(manager.naturalSpeech() == case[5] and saved.naturalSpeech == case[5], label)
      assert(saved.voiceProvider == case[2] and saved.conversationProvider == case[3] and saved.future.keep == 'unchanged', 'only Natural speech moves: ' .. label)
      assert(manager.takeNaturalSpeechNotice() == nil and (manager.snapshot(player).feedback or '') == '', 'a load is silent: ' .. label)
    end
  `);
});

test('Natural speech and the provider: the Convai voice beside Mistral, Local AI or Custom keeps it on and moves nothing; making the pairing on Convai turns it off with one notice; turning it on beside the pairing moves the voice to Pocket', () => {
  run(`${nsuiFixture}
    local clock = 5000
    os.clock = function() return clock end
    assert(invoke('tab:settings').ok)
    local OFF = 'The Convai cloud voice cannot use Natural speech, so it was turned off.'
    local SWITCHED = 'Natural speech needs a local voice, so Companion voices was switched to ' .. manager.voiceLabel('pocket') .. '.'
    local CLOUD, POCKET
    for index, choice in ipairs(dofile('voice-preview.lua').CHOICES) do
      if choice.provider == 'convai' then CLOUD = index + 1 end
      if choice.provider == 'pocket' then POCKET = index + 1 end
    end
    local FREE, OWN, MISTRAL, LOCAL, CUSTOM = 1, 2, 3, 4, 5
    local function apply(...)
      clock = clock + 2
      local changes = {}
      for _, change in ipairs({...}) do changes[#changes + 1] = {id = change[1], value = change[2]} end
      return registered.applyBatch('manager', changes)
    end
    -- Starting points: set the saved choices directly (the manager takes any pairing a file could hold except the blocked one).
    local function start(provider, voice, speech)
      assert(manager.applySettings(player, {conversationProvider = provider, useOwnConvaiKey = false, voiceProvider = voice, naturalSpeech = false}))
      if speech then assert(manager.applySettings(player, {naturalSpeech = true})) end
      manager.takeNaturalSpeechNotice()
    end
    -- Choosing the Convai voice while the provider is Mistral, Local AI or Custom keeps Natural speech on, moves no voice, says nothing.
    for _, case in ipairs({{'mistral', MISTRAL}, {'local', LOCAL}, {'custom', CUSTOM}}) do
      start(case[1], 'pocket', true)
      local result = apply({'voiceProvider', CLOUD})
      assert(result.ok and saved.voiceProvider == 'convai' and saved.naturalSpeech == true, case[1])
      assert(manager.takeNaturalSpeechNotice() == nil and result.schemaChanged == false, case[1] .. ' needs no notice and no redraw')
      assert(manager.naturalSpeech() == true)
      -- Natural speech turned on beside the Convai voice there does nothing to the voice either.
      assert(apply({'naturalSpeech', false}).ok)
      result = apply({'naturalSpeech', true})
      assert(result.ok and saved.voiceProvider == 'convai' and saved.naturalSpeech == true, case[1])
      assert(manager.takeNaturalSpeechNotice() == nil and result.schemaChanged == false)
      -- Choosing another provider from there with the Convai voice and Natural speech on: Convai makes the pairing.
      local back = apply({'conversationProvider', FREE})
      assert(back.ok and saved.conversationProvider == 'convai' and saved.voiceProvider == 'convai' and saved.naturalSpeech == false, case[1])
      assert(manager.takeNaturalSpeechNotice() == OFF, case[1])
    end
    -- Choosing the Convai voice on the Convai provider (free tier, then own key) turns Natural speech off with the notice.
    for _, provider in ipairs({FREE, OWN}) do
      start('convai', 'pocket', true)
      if provider == OWN then assert(manager.applySettings(player, {useOwnConvaiKey = true})) end
      local result = apply({'voiceProvider', CLOUD})
      assert(result.ok and saved.voiceProvider == 'convai' and saved.naturalSpeech == false, provider)
      assert(result.schemaChanged == true and manager.takeNaturalSpeechNotice() == OFF, provider)
    end
    -- Choosing the Convai provider (free tier and own key) while the voice is the Convai voice and Natural speech is on: both choices stay, it goes off.
    for _, case in ipairs({{FREE, false}, {OWN, true}}) do
      start('mistral', 'convai', true)
      local result = apply({'conversationProvider', case[1]})
      assert(result.ok and saved.conversationProvider == 'convai' and saved.useOwnConvaiKey == case[2], case[1])
      assert(saved.voiceProvider == 'convai' and saved.naturalSpeech == false, 'both choices are kept, Natural speech is off: ' .. case[1])
      assert(result.schemaChanged == true and manager.takeNaturalSpeechNotice() == OFF and manager.takeNaturalSpeechNotice() == nil, case[1])
      assert(manager.snapshot(player).settings.naturalSpeech == false)
    end
    -- Choosing Local AI or Custom from the Convai pairing is not a blocked pairing: Natural speech does not come back by itself.
    assert(apply({'conversationProvider', LOCAL}).ok and saved.naturalSpeech == false and manager.takeNaturalSpeechNotice() == nil)
    -- Turning Natural speech on beside the Convai voice on the Convai provider moves the voice to Pocket, with the notice.
    for _, provider in ipairs({FREE, OWN}) do
      start('convai', 'convai', false)
      if provider == OWN then assert(manager.applySettings(player, {useOwnConvaiKey = true})) end
      local result = apply({'naturalSpeech', true})
      assert(result.ok and saved.voiceProvider == 'pocket' and saved.naturalSpeech == true and result.schemaChanged == true, provider)
      assert(manager.takeNaturalSpeechNotice() == SWITCHED, provider)
    end
    -- Both in one Apply: the provider chosen with Natural speech on beside the saved Convai voice. The pairing is made by the provider choice,
    -- so the choices stay and Natural speech goes off.
    start('mistral', 'convai', true)
    local result = apply({'conversationProvider', FREE}, {'naturalSpeech', true})
    assert(result.ok and saved.voiceProvider == 'convai' and saved.naturalSpeech == false)
    assert(manager.takeNaturalSpeechNotice() == OFF)
    -- The help of the row tells the provider-aware rule.
    loaded = registered.loadMod('manager')
    assert(row('naturalSpeech').description:find('Not available with Convai’s cloud voice: choosing it turns this off', 1, true))
  `);
});

test('Natural speech beside other providers is unaffected by a retired Multilingual value: Pocket and Natural speech stay on Mistral, back on the Convai free tier and on a player key', () => {
  run(`${nsuiFixture}${voiceApplyFixture}
    pack(false)
    assert(manager.applySettings(player, {conversationProvider = 'mistral', naturalSpeech = true}))
    local ok, err, notice = manager.applySettings(player, {multilingualConversations = true})
    assert(ok and saved.voiceProvider == 'pocket' and saved.naturalSpeech == true and notice == nil, tostring(err))
    assert(manager.takeNaturalSpeechNotice() == nil)
    -- Back to the Convai free tier: no voice rule moves Pocket or turns Natural speech off.
    local result = apply({'conversationProvider', 1})
    assert(result.ok and saved.conversationProvider == 'convai' and saved.voiceProvider == 'pocket' and saved.naturalSpeech == true, tostring(result.error))
    assert(manager.takeNaturalSpeechNotice() == nil)
    -- A player's own Convai key: the same.
    assert(manager.applySettings(player, {useOwnConvaiKey = true}))
    assert(manager.applySettings(player, {multilingualConversations = true}) and saved.voiceProvider == 'pocket' and saved.naturalSpeech == true)
  `);
});

test('Settings that are gone (Auto-connect nearby characters, Expressive emotions, Continue from game dialogue, Live holocall picture, Body gestures): no row, no snapshot key, no getter, no text on the page, no Apply branch, Companion behavior keeps the two gaze rows, and Gameplay holds the rest (Street reputation, NPCs react to threats and commands, Companions change outfits, the Immersive invitations and Housemates buttons, Revenge ambushes)', () => {
  run(`${nsuiFixture}
    local GONE = {autoConnectNearby = 'Auto-connect nearby characters', expressiveEmotions = 'Expressive emotions', gameDialogueContext = 'Continue from game dialogue',
      holocallLiveImage = 'Live holocall picture', bodyGestures = 'Body gestures', followUpInterest = 'Follow-up questions'}
    local snapshot = manager.snapshot(player).settings
    for key in pairs(GONE) do
      assert(manager[key] == nil, 'a getter: ' .. key)
      assert(snapshot[key] == nil and snapshot[key .. 'Chosen'] == nil, 'a snapshot key: ' .. key)
    end
    assert(manager.johnnyHologram == nil and manager.vTalks == nil)
    -- Walk every row of every category: no id, no label, no description and no choice names a removed setting.
    local function everything()
      local text = {}
      for _, category in ipairs(loaded.categories) do
        text[#text + 1] = tostring(category.id) .. '|' .. tostring(category.name) .. '|' .. tostring(category.description)
        for _, item in ipairs(category.settings) do
          text[#text + 1] = tostring(item.id) .. '|' .. tostring(item.label) .. '|' .. tostring(item.description) .. '|' .. tostring(item.value)
          for _, element in ipairs(item.elements or {}) do text[#text + 1] = tostring(element) end
        end
      end
      return table.concat(text, string.char(10))
    end
    assert(invoke('tab:settings').ok)
    for _, developer in ipairs({false, true}) do
      assert(manager.applySettings(player, {developerMode = developer}))
      loaded = registered.loadMod('manager')
      local text = everything()
      for key, label in pairs(GONE) do
        assert(row(key) == nil, key .. ' is offered')
        assert(not text:find(key, 1, true), key .. ' is on the page')
        assert(not text:find(label, 1, true), label .. ' is on the page')
      end
      -- No category is empty, and Companion behavior keeps its three rows.
      for _, category in ipairs(loaded.categories) do
        assert(#category.settings > 0, 'an empty category: ' .. tostring(category.id))
      end
      local behavior
      for _, category in ipairs(loaded.categories) do if category.id == 'companion-behavior' then behavior = category end end
      assert(behavior and behavior.name == 'Companion behavior' and #behavior.settings == 2, 'Companion behavior: the two gaze rows')
      assert(behavior.settings[1].id == 'eyeContactHeight' and behavior.settings[2].id == 'headFollowStrength')
      local gameplay
      for _, category in ipairs(loaded.categories) do if category.id == 'gameplay' then gameplay = category end end
      assert(gameplay and gameplay.name == 'Gameplay' and #gameplay.settings == 13, 'Gameplay: thirteen rows')
      local want = {'reputation', 'npcThreats', 'companionOutfits', 'characterEddies', 'characterBonds', 'storyPacks', 'reachOuts', 'immersive-invitations', 'housemates', 'revengeAmbushes', 'voiceChoices', 'battleReactions', 'lootReactions'}
      for index, id in ipairs(want) do assert(gameplay.settings[index].id == id, 'Gameplay row ' .. index .. ': ' .. tostring(gameplay.settings[index].id)) end
    end
    -- The page has no Apply branch for them: a batch carrying one is refused and nothing in it is saved; Restore defaults never names them.
    for key in pairs(GONE) do
      local result = registered.applyBatch('manager', {{id = 'battleReactions', value = false}, {id = key, value = false}})
      assert(result.ok == false and #(result.appliedIds or {}) == 0, key)
      assert(manager.battleReactions() == true and saved[key] == nil, key)
    end
    for _, change in ipairs(core.defaults()) do assert(GONE[change.id] == nil and change.id ~= 'johnnyHologram' and change.id ~= 'vTalks', change.id) end
    -- A normal batch applies none of them: the ids the page reports are the ones asked for.
    local ok = registered.applyBatch('manager', {{id = 'battleReactions', value = false}, {id = 'lootReactions', value = false}})
    assert(ok.ok and #ok.appliedIds == 2)
    for key in pairs(GONE) do assert(saved[key] == nil, key) end
    -- Natural speech STAYS: a row, its default (off), and it applies on its own.
    assert(registered.applyBatch('manager', {{id = 'naturalSpeech', value = false}}).ok)
    loaded = registered.loadMod('manager')
    local natural = row('naturalSpeech')
    assert(natural.type == 'bool' and natural.value == false and natural.defaultValue == false and natural.label == 'Natural speech')
    local voiceBefore = saved.voiceProvider
    assert(registered.applyBatch('manager', {{id = 'naturalSpeech', value = true}}).ok and saved.naturalSpeech == true and saved.voiceProvider == voiceBefore)
  `);
});

test('an old settings.json with a removed setting set to false loads fine as if it were on: the key is dropped from the file once, the second load saves nothing, and an Apply that carries one is accepted and ignored', () => {
  run(`${managerFixture}
    local KEYS = {'autoConnectNearby', 'expressiveEmotions', 'expressiveEmotionsChosen', 'gameDialogueContext', 'holocallLiveImage', 'holocallLiveImageChosen', 'bodyGestures',
      'followUpInterest'}
    local function load(extra)
      seed = {version = 2, subtitleStyle = 'dialogue', voiceProvider = 'pocket', omniSteps = 16, enabledByKey = {}, future = {keep = 'unchanged'}}
      for key, value in pairs(extra) do seed[key] = value end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.reset(); manager.configure(api, profiles)
      return manager.snapshot(player).settings
    end
    local function assertGone(state, label)
      for _, key in ipairs(KEYS) do
        assert(state[key] == nil and manager[key] == nil, label .. ': ' .. key .. ' is still read')
        assert(saved[key] == nil, label .. ': ' .. key .. ' is still saved')
      end
      assert(saved.future.keep == 'unchanged', label)
    end
    for _, key in ipairs(KEYS) do
      local state = load({[key] = false})
      assertGone(state, key)
      -- Once: a second load finds nothing to drop.
      local before = saved
      manager.reset(); manager.configure(api, profiles); manager.snapshot(player)
      assert(saved == before, key .. ': the second load saved again')
    end
    -- All of them together, as an old file holds them, with a true as well.
    local everything = {}
    for _, key in ipairs(KEYS) do everything[key] = false end
    everything.bodyGestures = true
    assertGone(load(everything), 'all')
    everything.followUpInterest = true
    assertGone(load(everything), 'all, opposite value')
    -- Behaviour is as if on, and nothing else moves: the Convai voice beside an old Expressive emotions true stays, silently.
    local state = load({voiceProvider = 'convai', expressiveEmotions = true, naturalSpeech = false})
    assert(state.voiceProvider == 'convai' and saved.voiceProvider == 'convai' and manager.takeNaturalSpeechNotice() == nil)
    assertGone(state, 'expressive with the cloud voice')
    -- An Apply carrying a removed key is accepted and ignored, and saves the rest.
    load({})
    for _, key in ipairs(KEYS) do
      assert(manager.applySettings(player, {[key] = false, witnessReceipts = false}), key)
      assert(saved[key] == nil and manager.snapshot(player).settings[key] == nil and saved.witnessReceipts == false, key)
      assert(manager.applySettings(player, {witnessReceipts = true}))
    end
    assert(manager.applySettings(player, {expressiveEmotions = 'maybe', bodyGestures = 7}), 'whatever the value')
    assertGone(manager.snapshot(player).settings, 'odd values')
  `);
});

test('Follow-up questions is retired: an old file holding either value loads with no error, feedback or notice, drops the key, keeps everything else, and an Apply that carries it saves nothing for it', () => {
  run(`${managerFixture}
    assert(manager.followUpInterest == nil and manager.followUpQuestions == nil, 'no getters')
    assert(manager.naturalSpeech ~= nil and manager.takeNaturalSpeechNotice ~= nil, 'Natural speech is not retired')
    for _, value in ipairs({true, false}) do
      local label = tostring(value)
      seed = {version = 2, subtitleStyle = 'dialogue', voiceProvider = 'convai', conversationProvider = 'convai', omniSteps = 16,
        enabledByKey = {}, future = {keep = 'unchanged'}, followUpInterest = value}
      files['runtime/settings.json'], saved = 'seed', nil
      manager.reset(); manager.configure(api, profiles); manager.prepare(player)
      local snapshot = manager.snapshot(player)
      assert(saved ~= nil and saved.followUpInterest == nil, 'dropped from the file: ' .. label)
      assert(saved.voiceProvider == 'convai' and saved.conversationProvider == 'convai' and saved.subtitleStyle == 'dialogue'
        and saved.omniSteps == 16 and saved.future.keep == 'unchanged', 'the rest is untouched: ' .. label)
      assert(snapshot.settings.followUpInterest == nil, label)
      assert(snapshot.settings.voiceProvider == 'convai', 'the Convai voice stays, silently: ' .. label)
      assert((snapshot.feedback or '') == '', 'a load says nothing: ' .. label .. ' ' .. tostring(snapshot.feedback))
      assert(manager.takeNaturalSpeechNotice() == nil, 'no notice at load: ' .. label)
      -- Once: a second load finds nothing to drop.
      local before = saved
      manager.reset(); manager.configure(api, profiles); manager.snapshot(player)
      assert(saved == before, 'the second load saved again: ' .. label)
      -- An Apply that carries it is accepted and ignored, with no error text, no notice and nothing written for it.
      local ok, err, notice = manager.applySettings(player, {followUpInterest = value})
      assert(ok == true and err == nil and notice == nil, label .. ': ' .. tostring(err))
      assert(saved.followUpInterest == nil and saved.voiceProvider == 'convai', label)
      assert(manager.snapshot(player).settings.followUpInterest == nil, label)
      local feedback = manager.snapshot(player).feedback or ''
      assert(feedback == '' or feedback == 'Settings saved.', 'an Apply says only that it saved: ' .. label .. ' ' .. feedback)
      -- Beside a real setting it saves that one and still nothing for it.
      ok, err, notice = manager.applySettings(player, {followUpInterest = value, witnessReceipts = false, voiceProvider = 'pocket'})
      assert(ok == true and err == nil and notice == nil and saved.witnessReceipts == false and saved.voiceProvider == 'pocket', label)
      assert(saved.followUpInterest == nil, label)
    end
  `);
});

test('Battle and loot reactions are on by default; an unchosen saved false moves to on once, a chosen false stays; Restore defaults sets both back on', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(manager.battleReactions() == true and manager.lootReactions() == true)
    assert(saved.battleReactions == true and saved.lootReactions == true, 'a fresh file')
    assert(saved.battleReactionsChosen == false and saved.lootReactionsChosen == false, 'nothing is chosen yet')
    local snapshot = manager.snapshot(player).settings
    assert(snapshot.battleReactions == true and snapshot.lootReactions == true)
    local function load(extra)
      seed = {version = 2, subtitleStyle = 'dialogue', voiceProvider = 'pocket', omniSteps = 16, enabledByKey = {}}
      for key, value in pairs(extra) do seed[key] = value end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.reset(); manager.configure(api, profiles); manager.prepare(player)
    end
    -- {saved value, Chosen flag, result}: only a false the player chose stays false.
    for _, case in ipairs({{false, nil, true}, {false, false, true}, {false, true, false}, {true, nil, true}, {true, true, true}, {true, false, true},
        {nil, nil, true}, {nil, true, true}, {'no', nil, true}, {'no', true, true}}) do
      for _, key in ipairs({'battleReactions', 'lootReactions'}) do
        local chosen = key .. 'Chosen'
        load({[key] = case[1], [chosen] = case[2]})
        local label = key .. ' ' .. tostring(case[1]) .. ' chosen ' .. tostring(case[2])
        assert(manager[key]() == case[3] and saved[key] == case[3], label)
        assert(manager.snapshot(player).settings[key] == case[3], label)
        -- The other one was absent from the file: it is the default, on.
        local other = key == 'battleReactions' and 'lootReactions' or 'battleReactions'
        assert(manager[other]() == true, label)
      end
    end
    -- An Apply that carries one writes the value and that key's Chosen flag; it survives a reload; a refused Apply changes nothing.
    load({})
    assert(manager.applySettings(player, {battleReactions = false}))
    assert(saved.battleReactions == false and saved.lootReactions == true and saved.battleReactionsChosen == true and saved.lootReactionsChosen == false)
    manager.reset(); manager.configure(api, profiles); manager.prepare(player)
    assert(manager.battleReactions() == false and manager.lootReactions() == true, 'a chosen off survives a reload')
    assert(manager.applySettings(player, {lootReactions = false}))
    manager.reset(); manager.configure(api, profiles); manager.prepare(player)
    assert(manager.battleReactions() == false and manager.lootReactions() == false)
    assert(manager.applySettings(player, {battleReactions = true, lootReactions = true}))
    assert(manager.battleReactions() == true and manager.lootReactions() == true and saved.battleReactionsChosen == true)
    assert(not manager.applySettings(player, {battleReactions = 'on'}) and manager.battleReactions() == true, 'a refused Apply changes nothing')
  `);
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    local battle, loot = row('battleReactions'), row('lootReactions')
    assert(battle.type == 'bool' and battle.defaultValue == true and battle.value == true and battle.label == 'React to battles')
    assert(loot.type == 'bool' and loot.defaultValue == true and loot.value == true and loot.label == 'React to collected loot')
    assert(registered.applyBatch('manager', {{id = 'battleReactions', value = false}, {id = 'lootReactions', value = false}}).ok)
    assert(saved.battleReactions == false and saved.lootReactions == false and saved.battleReactionsChosen == true and saved.lootReactionsChosen == true)
    loaded = registered.loadMod('manager')
    assert(row('battleReactions').value == false and row('lootReactions').value == false)
    -- Restore defaults sets both back on.
    local changes = core.defaults()
    local back = {}
    for _, change in ipairs(changes) do back[change.id] = change.value end
    assert(back.battleReactions == true and back.lootReactions == true, 'both are named, at their default')
    assert(registered.applyBatch('manager', changes).ok)
    assert(saved.battleReactions == true and saved.lootReactions == true and manager.battleReactions() and manager.lootReactions())
    manager.reset(); manager.configure(api, profiles); manager.prepare(player)
    assert(manager.battleReactions() == true and manager.lootReactions() == true, 'a reload keeps the restored defaults')
  `);
});

test('Custom endpoint is one button after the Mistral key row that opens a page of its own: the rows of the Custom provider, Back to Settings, absent without the module, and the page follows the custom state', () => {
  run(`${nsuiHarness({modules: {'custom-provider.lua': moduleSource('custom-provider.lua')}})}${matureStateFixture}${customReadyFixture}
    assert(invoke('tab:settings').ok)
    custom(false)
    -- The button sits right after the Mistral key row; the four Custom rows are not on the Settings page any more.
    local order = {}
    for _, category in ipairs(loaded.categories) do
      if category.id == 'conversation-provider' then for _, item in ipairs(category.settings) do order[#order + 1] = item.id end end
    end
    assert(table.concat(order, ',') == 'conversationProvider,matureContent,localModel,mistral-key,custom-endpoint,own-key', table.concat(order, ','))
    for _, id in ipairs({'custom-url', 'custom-key', 'custom-model', 'custom-test'}) do assert(row(id) == nil, id .. ' is still on Settings') end
    local button = row('custom-endpoint')
    assert(button.type == 'action' and button.label == 'Custom endpoint' and button.value == 'Open', button.label)
    assert(button.description:find('Used when Custom is the Conversation provider.', 1, true))
    -- It opens the page: its category holds the rows of the provider module, Back returns to Settings.
    assert(invoke('custom-endpoint').ok)
    assert(core.view() == 'custom-endpoint')
    local page
    for _, category in ipairs(loaded.categories) do if category.id == 'custom-endpoint' then page = category end end
    assert(page and page.name == 'Custom endpoint', 'the page category')
    local ids = {}
    for _, item in ipairs(page.settings) do ids[#ids + 1] = item.id end
    assert(table.concat(ids, ',') == 'custom-url,custom-key,custom-model,custom-test', table.concat(ids, ','))
    for _, item in ipairs(page.settings) do assert(item.type == 'action', item.id) end
    local rows = dofile('custom-provider.lua').new({readJSON = function() return nil end}).rows()
    assert(#rows == 4, 'the module has four rows')
    for index, item in ipairs(rows) do assert(page.settings[index].id == item.id and page.settings[index].label == item.label, item.id) end
    local back = row('custom-endpoint:back')
    assert(back, 'a Back action at the top of the page')
    assert(invoke('custom-endpoint:back').ok)
    assert(core.view() == 'settings' and row('conversationProvider') ~= nil and row('custom-endpoint') ~= nil, 'back on Settings')
    -- The page follows the custom state: a new answer from the service makes it stale (drawn again), an unchanged one does not.
    assert(invoke('custom-endpoint').ok)
    loaded = core.model()
    wall = wall + 2; core.tick(player)
    core.stale()
    loaded = core.model()
    wall = wall + 2; core.tick(player)
    assert(core.stale() == false, 'nothing changed, nothing drawn again')
    -- The service publishes a new state while the page is up: the next tick sees it and the page is drawn again.
    stateCount = stateCount + 1
    jsonFixtures['custom-' .. stateCount] = {version = 1, updated = stateCount, ready = true, host = 'localhost:11434', secure = false, ['local'] = true,
      model = 'llama3.2', keySaved = false}
    files['runtime/custom-provider-state.json'] = 'custom-' .. stateCount
    clock = clock + 2; wall = wall + 2
    core.tick(player)
    assert(core.stale() == true, 'a new custom state redraws the page')
    loaded = core.model()
    assert(row('custom-test').disabled == false, 'a ready endpoint can be tested')
  `);
  // Without the module the button is not there and the page is the home page.
  run(`${nsuiHarness({absent: ['custom-provider.lua']})}
    assert(invoke('tab:settings').ok)
    assert(row('custom-endpoint') == nil, 'no button without the module')
    for _, id in ipairs({'custom-url', 'custom-key', 'custom-model', 'custom-test'}) do assert(row(id) == nil, id) end
    core.setView('custom-endpoint')
    assert(core.view() == 'home', core.view())
  `);
});

// ---------------------------------------------------------------------------------------------------- Home > Character editor (2026-10-22)
// The fifth destination of Home opens the browser page at once, through the same request as Settings > Edit characters
// (mod/character-editor.lua request()): an action row that answers with the request's result, not a navigation.
const homeEditorModules = {'service-status.lua': moduleSource('service-status.lua'), 'character-editor.lua': moduleSource('character-editor.lua'),
  'support-report.lua': moduleSource('support-report.lua')};
const homeEditorFixture = (options = {}) => `${nsuiHarness({modules: homeEditorModules, ...options})}
  local clockNow = 1800000000
  os.time = function() return clockNow end
  local function jsonFile(path, value)
    jsonSequence = jsonSequence + 1
    local token = 'editor-home-' .. jsonSequence
    jsonFixtures[token] = value; files[path] = token
  end
  local function commandWrites() local n = 0 for _, write in ipairs(fileWrites) do if write.path == 'runtime/editor-command.json' then n = n + 1 end end return n end
`;

test('Home offers the Character editor as the fourth row, then Key bindings, above Settings, an action with its own id, and the Settings row stays', () => {
  run(`${homeEditorFixture()}
    assert(managerUi.inspect().view == 'home')
    local nav = loaded.categories[1].settings
    -- The owner's order: the Character editor, then Key bindings, above Settings, which stays last.
    assert(#nav == 7 and nav[3].id == 'tab:models' and nav[4].id == 'tab:bonds' and nav[5].id == 'character-editor:home' and nav[6].id == 'tab:key-bindings' and nav[7].id == 'tab:settings', 'seven rows, Relationships right after the Model browser, the editor and Key bindings above Settings: ' .. #nav)
    local open = row('character-editor:home')
    assert(open and open.type == 'action' and open.label == 'Character editor' and open.value == 'Open' and not open.disabled)
    assert(open.description:find('bios, rules and memories, and the prompting for each AI option', 1, true), open.description)
    assert(open.description:find('Mistral, Local AI and Custom, not Convai', 1, true) and open.description:find('Changes apply from the next reply', 1, true))
    -- Ids are unique on the page and the navigations keep theirs.
    local seen = {}
    for _, item in ipairs(nav) do assert(not seen[item.id], 'id twice: ' .. item.id); seen[item.id] = true end
    for _, name in ipairs({'characters', 'party', 'models', 'bonds', 'key-bindings', 'settings'}) do assert(row('tab:' .. name)) end
    -- It is on Home only: an inner page has neither it nor a second Back.
    assert(invoke('tab:settings').ok and not row('character-editor:home'))
    local settingsRow = row('character-editor:open')
    assert(settingsRow and settingsRow.label == 'Edit characters' and settingsRow.description:find('and the prompting for each AI option', 1, true))
    assert(invoke('settings:back').ok and row('character-editor:home'))
  `);
});

test('Home > Character editor writes exactly one runtime/editor-command.json, the very command Settings > Edit characters writes, and stays on Home', () => {
  run(`${homeEditorFixture()}
    jsonFile('runtime/knowledge-status.json', {updated = os.time() * 1000.0})
    local writesBefore = #fileWrites
    local result = invoke('character-editor:home')
    assert(result.ok, tostring(result.error))
    assert(#fileWrites == writesBefore + 1 and fileWrites[#fileWrites].path == 'runtime/editor-command.json', 'exactly one small file, got ' .. (#fileWrites - writesBefore))
    assert(managerUi.inspect().view == 'home' and core.view() == 'home', 'no sub-page in the game')
    assert(core.feedback() == 'Opening the editor in your browser. Switch to your browser if it does not come to the front.', tostring(core.feedback()))
    local home = jsonFixtures[files['runtime/editor-command.json']]
    assert(home.version == 1 and home.action == 'open' and home.language == 'en' and type(home.id) == 'string')
    -- The Settings row sends the same command (a new id, the same everything else).
    clockNow = clockNow + 1
    assert(invoke('tab:settings').ok and invoke('character-editor:open').ok)
    assert(commandWrites() == 2)
    local settings = jsonFixtures[files['runtime/editor-command.json']]
    assert(settings.id ~= home.id and settings.version == home.version and settings.action == home.action and settings.language == home.language)
    local count, same = 0, true
    for source, text in pairs(home.strings) do count = count + 1; if settings.strings[source] ~= text then same = false end end
    for _ in pairs(settings.strings) do count = count - 1 end
    assert(same and count == 0, 'the same sentences for the page')
    -- Every press is a new command, and a pumped menu sends nothing more.
    assert(invoke('settings:back').ok)
    clockNow = clockNow + 1
    assert(invoke('character-editor:home').ok and commandWrites() == 3)
    local settled = commandWrites()
    for _ = 1, 20 do core.tick(player) end
    assert(commandWrites() == settled, 'nothing is polled')
  `);
});

test('Home > Character editor says so when the service is stopped or the write fails, and the page stays on Home', () => {
  run(`${homeEditorFixture()}
    jsonFile('runtime/bridge-service.json', {state = 'stopped', updated = os.time() * 1000.0, since = os.time() * 1000.0 - 5000})
    local result = invoke('character-editor:home')
    assert(not result.ok and result.error == 'The conversation service is not running, so the editor cannot open. Restart the game.', tostring(result.error))
    assert(commandWrites() == 0 and not files['runtime/editor-command.json'])
    assert(core.feedback() == result.error and core.view() == 'home')
    jsonFile('runtime/bridge-service.json', {state = 'ready', updated = os.time() * 1000.0, since = os.time() * 1000.0 - 30000})
    jsonFile('runtime/knowledge-status.json', {updated = os.time() * 1000.0})
    failSave = true
    local failed = invoke('character-editor:home')
    assert(not failed.ok and failed.error == 'The editor could not be opened. Try again.', tostring(failed.error))
    failSave = false
    assert(invoke('character-editor:home').ok and commandWrites() == 1)
  `);
});

test('Home has no Character editor row without the editor module, and the other destinations are as before', () => {
  run(`${homeEditorFixture({modules: {'service-status.lua': homeEditorModules['service-status.lua'], 'support-report.lua': homeEditorModules['support-report.lua']}, absent: ['character-editor.lua']})}
    assert(#loaded.categories[1].settings == 6 and not row('character-editor:home'), 'no row without the module')
    assert(not invoke('character-editor:home').ok, 'a stale press does nothing')
    assert(invoke('tab:settings').ok and not row('character-editor:open'))
  `);
});

test('V’s voice for microphone lines is off by default, only a boolean is kept, an Apply stores it, and the select sits under V’s voice with the reason for the default', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved.vVoiceMic == false and manager.vVoiceMic() == false and manager.snapshot(player).settings.vVoiceMic == false, 'off by default, and saved so')
    -- A saved choice is kept; anything that is not a boolean is the default, off.
    for _, case in ipairs({{true, true}, {false, false}, {'yes', false}, {1, false}, {'missing', false}}) do
      seed = {version = 2, voiceProvider = 'pocket', enabledByKey = {}, future = {keep = 'unchanged'}}
      if case[1] ~= 'missing' then seed.vVoiceMic = case[1] end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      assert(manager.vVoiceMic() == case[2] and saved.vVoiceMic == case[2], tostring(case[1]))
      assert(manager.snapshot(player).settings.vVoiceMic == case[2])
      assert(saved.future.keep == 'unchanged')
    end
    seed = {version = 2, voiceProvider = 'pocket', enabledByKey = {}}
    files['runtime/settings.json'], saved = 'seed', nil
    manager.configure(api, profiles); manager.prepare(player)
    assert(manager.applySettings(player, {vVoiceMic = true}) and manager.vVoiceMic() and saved.vVoiceMic == true)
    assert(saved.vVoice == true and saved.vVoiceChosen ~= true, 'V’s voice itself is untouched by this key')
    assert(manager.applySettings(player, {vVoiceMic = 'yes'}) == false and manager.vVoiceMic(), 'a non-boolean is refused')
    -- It survives other changes, and typed lines going off keeps the choice: the two are independent, so microphone lines alone keep V’s voice active.
    assert(manager.applySettings(player, {witnessReceipts = false}) and manager.vVoiceMic())
    assert(manager.applySettings(player, {vVoice = false}) and manager.vVoiceMic() and saved.vVoiceMic == true and not manager.vVoice() and manager.vVoiceActive())
    assert(manager.applySettings(player, {vVoiceMic = false}) and not manager.vVoiceMic() and saved.vVoiceMic == false and not manager.vVoiceActive(), 'both off: V is not active')
  `);
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    loaded = registered.loadMod('manager')
    local order = {}
    for _, category in ipairs(loaded.categories) do
      if category.id == 'voices' then for _, item in ipairs(category.settings) do order[#order + 1] = item.id end end
    end
    local at = {}
    for index, id in ipairs(order) do at[id] = index end
    assert(at.vVoiceMic and at.vVoiceMic == at.vVoice + 1, 'right under V’s voice')
    local item = row('vVoiceMic')
    assert(item.label == 'V’s voice for microphone lines' and item.type == 'select' and item.value == 1 and item.defaultValue == 1)
    assert(#item.elements == 4 and item.elements[1] == 'Off' and item.elements[2] == 'Pocket · On your PC' and table.concat(item.elements, '|') == table.concat(row('vVoice').elements, '|'), 'the same four choices as typed lines')
    assert(item.description:find('works on its own', 1, true) and not item.description:find('Needs V’s voice on', 1, true) and item.description:find('Off by default, because you just said it yourself', 1, true)
        and item.description:find('the reply follows V’s line', 1, true) and not item.description:find('never waits', 1, true)
        and not item.description:find('cut short', 1, true) and not item.description:find('OmniVoice', 1, true))
    -- Stored through the settings page like any switch, and shown as on afterwards.
    assert(registered.applyBatch('manager', {{id = 'vVoiceMic', value = 2}}).ok and saved.vVoiceMic == true and saved.vVoiceEngine == 'pocket')
    loaded = registered.loadMod('manager')
    assert(row('vVoiceMic').value == 2)
    assert(registered.applyBatch('manager', {{id = 'vVoiceMic', value = 1}}).ok and saved.vVoiceMic == false)
  `);
});

test('own key bindings: only game key names of the seven actions are kept, no key twice, and a binding is set and cleared in one validated save', () => {
  run(`${managerFixture}
    manager.configure(api, profiles); manager.prepare(player)
    assert(type(saved.keyBindings) == 'table' and saved.keyDefaultsGiven == true and saved.keyBindings.voice == 'IK_F7' and manager.keyBindings().voice == 'IK_F7', 'the default keys, and saved so')
    assert(manager.snapshot(player).settings.keyBindings.manager == 'IK_F4')
    -- The cleaning below is judged without the defaults (keyDefaultsGiven marks a file that has had them). A saved file is cleaned up: an unknown action, a value that is no game key name and a key another action already has are dropped; the rest is kept.
    seed = {version = 2, voiceProvider = 'pocket', enabledByKey = {}, future = {keep = 'unchanged'}, keyDefaultsGiven = true,
      keyBindings = {voice = 'IK_F7', text = 'IK_F7', group_voice = 'IK_Pad_Start', group_text = 5, manager = 'not a key', nonsense = 'IK_A', johnny_voice = 'IK_J', johnny_text = 'IK_J'}}
    files['runtime/settings.json'], saved = 'seed', nil
    manager.configure(api, profiles); manager.prepare(player)
    local keys = manager.keyBindings()
    assert(keys.voice == 'IK_F7' and keys.text == nil and keys.group_voice == 'IK_Pad_Start' and keys.group_text == nil and keys.manager == nil and keys.nonsense == nil)
    assert(keys.johnny_voice == 'IK_J' and keys.johnny_text == nil, 'the Johnny actions are kept, and a key twice is dropped for them too')
    assert(saved.keyBindings.voice == 'IK_F7' and saved.keyBindings.nonsense == nil and saved.future.keep == 'unchanged', 'the cleaned table was saved, the rest untouched')
    -- A combination in a saved file is kept, a malformed one (modifiers out of order, a controller button with one) is dropped.
    seed = {version = 2, voiceProvider = 'pocket', enabledByKey = {}, keyDefaultsGiven = true,
      keyBindings = {voice = 'IK_LShift+IK_F5', text = 'IK_LShift+IK_LControl+IK_F6', group_voice = 'IK_LShift+IK_Pad_Start', group_text = 'IK_F5'}}
    files['runtime/settings.json'], saved = 'seed', nil
    manager.configure(api, profiles); manager.prepare(player)
    keys = manager.keyBindings()
    assert(keys.voice == 'IK_LShift+IK_F5' and keys.text == nil and keys.group_voice == nil and keys.group_text == 'IK_F5', 'F5 and Shift+F5 are two bindings')
    -- A file that holds something else than a table gets the default.
    for _, wrong in ipairs({'IK_F7', 5, true}) do
      seed = {version = 2, voiceProvider = 'pocket', enabledByKey = {}, keyDefaultsGiven = true, keyBindings = wrong}
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      assert(next(manager.keyBindings()) == nil and type(saved.keyBindings) == 'table', tostring(wrong))
    end
    seed = {version = 2, voiceProvider = 'pocket', enabledByKey = {}, keyDefaultsGiven = true}
    files['runtime/settings.json'], saved = 'seed', nil
    manager.configure(api, profiles); manager.prepare(player)
    -- One save sets a binding; another action keeps its own; setKeyBinding clears with nil.
    assert(manager.setKeyBinding(player, 'voice', 'IK_F7') and saved.keyBindings.voice == 'IK_F7')
    assert(manager.setKeyBinding(player, 'text', 'IK_Pad_LeftShoulder') and saved.keyBindings.text == 'IK_Pad_LeftShoulder' and saved.keyBindings.voice == 'IK_F7')
    assert(manager.setKeyBinding(player, 'voice', nil) and saved.keyBindings.voice == nil and saved.keyBindings.text == 'IK_Pad_LeftShoulder')
    -- Refused, and nothing changes: a key another action has, a name that is no key, an unknown action, a value of the wrong kind.
    local ok, why = manager.setKeyBinding(player, 'voice', 'IK_Pad_LeftShoulder')
    assert(ok == false and why == 'That key is already used for another action.' and manager.keyBindings().voice == nil)
    for _, bad in ipairs({{'voice', 'F7'}, {'voice', 7}, {'voice', ''}, {'voice', 'IK_' .. string.rep('A', 70)}, {'nonsense', 'IK_A'}}) do
      local accepted, reason = manager.setKeyBinding(player, bad[1], bad[2])
      assert(accepted == false and reason == 'Choose a key or a controller button.', tostring(bad[2]))
    end
    -- A combination (Shift, Ctrl, Alt held with a keyboard key) is stored as the modifiers' game names in one order, then the key. The same key with another set of modifiers is another binding.
    assert(manager.setKeyBinding(player, 'voice', 'IK_LShift+IK_F5') and saved.keyBindings.voice == 'IK_LShift+IK_F5')
    assert(manager.setKeyBinding(player, 'group_voice', 'IK_F5') and manager.setKeyBinding(player, 'johnny_voice', 'IK_LControl+IK_Alt+IK_LShift+IK_F5'))
    local twice, twiceWhy = manager.setKeyBinding(player, 'johnny_text', 'IK_LShift+IK_F5')
    assert(twice == false and twiceWhy == 'That key is already used for another action.', 'the clash check is on the whole combination')
    for _, malformed in ipairs({'IK_LShift+IK_LControl+IK_F5', 'IK_LShift+IK_LShift+IK_F5', 'IK_LShift+', 'IK_LShift+IK_Pad_A_CROSS', 'IK_RShift+IK_F5', 'Shift+IK_F5'}) do
      local accepted, reason = manager.setKeyBinding(player, 'johnny_text', malformed)
      assert(accepted == false and reason == 'Choose a key or a controller button.', malformed)
    end
    assert(manager.setKeyBinding(player, 'voice', nil) and manager.setKeyBinding(player, 'group_voice', nil) and manager.setKeyBinding(player, 'johnny_voice', nil))
    assert(manager.applySettings(player, {keyBindings = 'IK_F7'}) == false)
    -- It survives other changes, and a batch with a bad binding changes nothing at all.
    assert(manager.applySettings(player, {witnessReceipts = false}) and manager.keyBindings().text == 'IK_Pad_LeftShoulder')
    local mixed = manager.applySettings(player, {witnessReceipts = true, keyBindings = {voice = 'bad'}})
    assert(mixed == false and manager.snapshot(player).settings.witnessReceipts == false)
    -- Every action at once, as Restore defaults clears them.
    assert(manager.setKeyBinding(player, 'voice', 'IK_F7') and manager.setKeyBinding(player, 'manager', 'IK_F4'))
    assert(manager.applySettings(player, {keyBindings = {voice = false, text = false, group_voice = false, group_text = false, manager = false}}))
    assert(next(manager.keyBindings()) == nil and next(saved.keyBindings) == nil and saved.keyDefaultsGiven == true, 'a cleared key stays cleared')
    -- Restore defaults is one batch: the default key for the five actions, and none (false) for the two Johnny actions.
    assert(manager.setKeyBinding(player, 'johnny_voice', 'IK_J'))
    assert(manager.applySettings(player, {keyBindings = manager.defaultKeyBindings()}))
    assert(manager.keyBindings().voice == 'IK_F7' and manager.keyBindings().text == 'IK_F6' and manager.keyBindings().johnny_voice == nil and manager.keyBindings().johnny_text == nil)
  `);
});

test('Key bindings page: Restore defaults lists one change that puts the default keys back, and nothing when the keys are the defaults; the Controller talk button is gone from the page', () => {
  run(`${nsuiFixture}
    assert(next(core.defaults()) == nil, 'nothing to restore: a fresh file holds the default keys')
    local function ids()
      local list = {}
      for _, change in ipairs(core.defaults()) do list[#list + 1] = change.id end
      table.sort(list)
      return table.concat(list, ',')
    end
    assert(manager.setKeyBinding(player, 'voice', 'IK_F2'))
    assert(ids() == 'keyBindings:reset', ids())
    local result = core.apply(core.defaults())
    assert(result.ok, tostring(result.error))
    assert(manager.keyBindings().voice == 'IK_F7' and manager.keyBindings().manager == 'IK_F4' and ids() == '')
    -- A key cleared on purpose differs from the defaults too, and so does a key on a Johnny action (they have none).
    assert(manager.setKeyBinding(player, 'manager', nil) and ids() == 'keyBindings:reset')
    assert(core.apply(core.defaults()).ok and manager.keyBindings().manager == 'IK_F4' and ids() == '')
    assert(manager.setKeyBinding(player, 'johnny_text', 'IK_J') and ids() == 'keyBindings:reset')
    assert(core.apply(core.defaults()).ok and manager.keyBindings().johnny_text == nil and ids() == '')
    -- The old id is gone, and so is the Controller category with its setting.
    local old = core.apply({{id = 'keyBindings:clear', value = true}})
    assert(old.ok == false and old.error == 'That setting is read-only.', tostring(old.error))
    assert(invoke('tab:key-bindings').ok)
    for _, category in ipairs(loaded.categories) do
      assert(category.id ~= 'kb:controller' and category.name ~= 'Controller', tostring(category.id))
      for _, item in ipairs(category.settings) do
        assert(item.id ~= 'padTalk' and item.label ~= 'Controller talk button', tostring(item.id))
        assert(not tostring(item.description):find('Controller talk button', 1, true), tostring(item.id))
      end
    end
    assert(core.model().description:find('Set from the start: F7 talk by voice, F6 talk by text, F10 group voice chat, F8 group text chat and F4 the Companion Manager.', 1, true), 'the page says which keys are set from the start')
  `);
});

test('Default key bindings are given once: a fresh file gets F4, F6, F7, F8 and F10, an old file keeps the keys it has and skips a default another action holds, a cleared key stays cleared, and defaultKeyBindings is the Restore defaults batch', () => {
  run(`${managerFixture}
    local DEFAULTS = {manager = 'IK_F4', text = 'IK_F6', voice = 'IK_F7', group_text = 'IK_F8', group_voice = 'IK_F10'}
    local function load(extra)
      seed = {version = 2, voiceProvider = 'pocket', enabledByKey = {}, future = {keep = 'unchanged'}}
      for key, value in pairs(extra) do seed[key] = value end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      return manager.keyBindings()
    end
    local function expect(keys, expected, label)
      for action, key in pairs(expected) do assert(keys[action] == key, label .. ': ' .. action .. ' ' .. tostring(keys[action])) end
      for action, key in pairs(keys) do assert(expected[action] == key, label .. ': unexpected ' .. action .. ' ' .. tostring(key)) end
    end
    -- A fresh file: the five defaults, the Johnny actions have none, and the file says they were given.
    local keys = load({})
    expect(keys, DEFAULTS, 'fresh')
    assert(saved.keyDefaultsGiven == true and saved.future.keep == 'unchanged')
    expect(saved.keyBindings, DEFAULTS, 'saved')
    expect(manager.snapshot(player).settings.keyBindings, DEFAULTS, 'snapshot')
    -- Once: the file that was just written loads without another save.
    seed, saved = saved, nil
    files['runtime/settings.json'] = 'seed'
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved == nil, 'the second load saved again')
    expect(manager.keyBindings(), DEFAULTS, 'second load')
    -- An old file with no keys at all (an empty table, no marker) is rewritten once with the defaults.
    expect(load({keyBindings = {}}), DEFAULTS, 'old empty')
    assert(saved.keyDefaultsGiven == true)
    -- An old file with one key already set keeps it, and the default another action holds is skipped (F10 is Group voice chat by default, text has it here).
    keys = load({keyBindings = {text = 'IK_F10'}})
    expect(keys, {text = 'IK_F10', manager = 'IK_F4', voice = 'IK_F7', group_text = 'IK_F8'}, 'one key set')
    assert(keys.group_voice == nil and saved.keyDefaultsGiven == true)
    -- A Johnny action holding F4 keeps it as well: the Manager default is skipped.
    keys = load({keyBindings = {johnny_voice = 'IK_F4'}})
    expect(keys, {johnny_voice = 'IK_F4', text = 'IK_F6', voice = 'IK_F7', group_text = 'IK_F8', group_voice = 'IK_F10'}, 'johnny key')
    -- A file that has had the defaults is left alone: an empty table means the player cleared every key.
    expect(load({keyBindings = {}, keyDefaultsGiven = true}), {}, 'marked empty')
    assert(next(saved.keyBindings) == nil and saved.keyDefaultsGiven == true, 'nothing is given to a file that has had the defaults')
    -- A key cleared later stays cleared, through a reload.
    load({})
    assert(manager.setKeyBinding(player, 'voice', nil) and saved.keyBindings.voice == nil and saved.keyDefaultsGiven == true)
    seed, saved = saved, nil
    files['runtime/settings.json'] = 'seed'
    manager.configure(api, profiles); manager.prepare(player)
    expect(manager.keyBindings(), {manager = 'IK_F4', text = 'IK_F6', group_text = 'IK_F8', group_voice = 'IK_F10'}, 'cleared stays cleared')
    -- The batch for Restore defaults: each action's default key, false for the two Johnny actions (the batch clears them).
    local batch = manager.defaultKeyBindings()
    for action, key in pairs(DEFAULTS) do assert(batch[action] == key, action) end
    assert(batch.johnny_voice == false and batch.johnny_text == false)
    assert(manager.applySettings(player, {keyBindings = batch}))
    expect(manager.keyBindings(), DEFAULTS, 'restored')
  `);
});

test('The Controller talk button is gone: no setting, getter or snapshot key, and a saved padTalk = true quietly becomes the Talk by voice binding on the left stick click; the key is removed from the file either way', () => {
  run(`${managerFixture}
    local function load(extra)
      seed = {version = 2, voiceProvider = 'pocket', enabledByKey = {}, future = {keep = 'unchanged'}}
      for key, value in pairs(extra) do seed[key] = value end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      return manager.keyBindings()
    end
    local keys = load({})
    assert(manager.padTalk == nil and manager.snapshot(player).settings.padTalk == nil and saved.padTalk == nil, 'no getter, no snapshot key, nothing saved')
    -- On, Talk by voice has no key and nobody holds the click: the click becomes its key. The other actions still get their default keys.
    keys = load({padTalk = true})
    assert(keys.voice == 'IK_Pad_LeftThumb' and saved.keyBindings.voice == 'IK_Pad_LeftThumb', tostring(keys.voice))
    assert(keys.text == 'IK_F6' and keys.group_voice == 'IK_F10' and keys.group_text == 'IK_F8' and keys.manager == 'IK_F4')
    assert(saved.padTalk == nil and manager.snapshot(player).settings.padTalk == nil and saved.future.keep == 'unchanged', 'the key is removed from the file')
    -- Once: the migrated file loads without another save.
    seed, saved = saved, nil
    files['runtime/settings.json'] = 'seed'
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved == nil and manager.keyBindings().voice == 'IK_Pad_LeftThumb', 'the second load saved again')
    -- Off: the key is removed, nothing is bound to the click, and Talk by voice gets its default key.
    keys = load({padTalk = false})
    assert(saved.padTalk == nil and keys.voice == 'IK_F7')
    for _, key in pairs(keys) do assert(key ~= 'IK_Pad_LeftThumb') end
    -- Talk by voice already has a key: it keeps that one, and the click is not bound.
    keys = load({padTalk = true, keyBindings = {voice = 'IK_F2'}})
    assert(saved.padTalk == nil and keys.voice == 'IK_F2')
    for _, key in pairs(keys) do assert(key ~= 'IK_Pad_LeftThumb') end
    -- Another action holds the click: Talk by voice does not take it (with the defaults already given it stays unbound).
    keys = load({padTalk = true, keyDefaultsGiven = true, keyBindings = {text = 'IK_Pad_LeftThumb'}})
    assert(saved.padTalk == nil and keys.text == 'IK_Pad_LeftThumb' and keys.voice == nil)
    -- An Apply from an old caller that still carries it saves nothing for it.
    manager.applySettings(player, {padTalk = true})
    assert(saved.padTalk == nil and manager.snapshot(player).settings.padTalk == nil)
  `);
  run(`${nsuiFixture}
    local function check(page)
      for _, category in ipairs(loaded.categories) do
        assert(category.id ~= 'kb:controller' and category.name ~= 'Controller', page .. ': ' .. tostring(category.id))
        for _, item in ipairs(category.settings) do
          assert(item.id ~= 'padTalk' and item.label ~= 'Controller talk button', page .. ': ' .. tostring(item.id))
          assert(not tostring(item.description):find('Controller talk button', 1, true), page .. ': ' .. tostring(item.id))
        end
      end
    end
    assert(invoke('tab:settings').ok)
    assert(row('padTalk') == nil)
    check('settings')
    assert(invoke('settings:back').ok and invoke('tab:key-bindings').ok)
    check('key bindings')
  `);
});

test('Companion voices: the first entry is Off (the old playback switch), it saves voice = false and keeps the saved voice, choosing a voice turns voices back on, and there is no Voice playback row', () => {
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    assert(row('voice') == nil, 'the playback switch has no row of its own')
    local entry = row('voiceProvider')
    assert(#entry.elements == 8 and entry.elements[1] == 'Off' and entry.elements[2] == 'Pocket · Performance' and entry.elements[8] == 'Convai · Cloud voice')
    assert(entry.value == 2 and entry.defaultValue == 2 and manager.snapshot(player).settings.voice == true)
    assert(entry.description:find('^Off: replies are text only and no voice is generated.') and entry.description:find('Pocket: the lightest', 1, true), 'Off is explained first')
    -- Choose the Convai voice, then Off: voice is false, the saved voice stays, and the row reads Off after a reload.
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 8}}).ok and saved.voiceProvider == 'convai' and saved.voice == true)
    local result = registered.applyBatch('manager', {{id = 'voiceProvider', value = 1}})
    assert(result.ok and saved.voice == false and saved.voiceProvider == 'convai' and manager.snapshot(player).settings.voice == false)
    loaded = registered.loadMod('manager')
    assert(row('voiceProvider').value == 1 and row('replyLanguage') ~= nil and row('voice') == nil)
    -- The same voice again turns voices back on; Off keeps the voice every time.
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 8}}).ok and saved.voice == true and saved.voiceProvider == 'convai')
    loaded = registered.loadMod('manager')
    assert(row('voiceProvider').value == 8)
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 1}}).ok and saved.voice == false and saved.voiceProvider == 'convai')
    -- A different voice turns voices on and is saved.
    assert(registered.applyBatch('manager', {{id = 'voiceProvider', value = 2}}).ok and saved.voice == true and saved.voiceProvider == 'pocket')
    -- The stored switch still applies under its own id, and a batch that carries it decides it.
    assert(registered.applyBatch('manager', {{id = 'voice', value = false}, {id = 'voiceProvider', value = 8}}).ok and saved.voice == false and saved.voiceProvider == 'convai')
    assert(registered.applyBatch('manager', {{id = 'voice', value = true}}).ok and saved.voice == true and saved.voiceProvider == 'convai')
    assert(manager.applySettings(player, {voice = false}) and saved.voice == false and saved.voiceProvider == 'convai')
    -- Entries that are not in the list are refused and nothing is saved.
    for _, invalid in ipairs({0, 9, 1.5, '2', false}) do
      assert(not registered.applyBatch('manager', {{id = 'voiceProvider', value = invalid}}).ok and saved.voice == false and saved.voiceProvider == 'convai', tostring(invalid))
    end
  `);
  // Entries that cannot be chosen are keyed by the shifted entry number: without the OmniVoice pack the four OmniVoice entries (4 to 7) are greyed out.
  run(`${nsuiFixture}
    local clock = 1000
    os.time = function() return clock end
    jsonFixtures['voice-runtime'] = {state = 'ready', provider = 'pocket', omniPack = {installed = false, missing = {'model'}}, updated = clock * 1000}
    files['runtime/local-voice-state.json'] = 'voice-runtime'
    assert(invoke('tab:settings').ok)
    loaded = registered.loadMod('manager')
    local entry = row('voiceProvider')
    local disabled = entry.disabledElements or {}
    for index = 4, 7 do assert(disabled[index] ~= nil, 'entry ' .. index .. ' is greyed out') end
    for _, index in ipairs({1, 2, 8}) do assert(disabled[index] == nil, 'entry ' .. index .. ' stays choosable') end
  `);
});

test('Subtitles: one select in Voices right after Voice language (Off, Cinematic subtitles, Above the speaker); Off saves subtitles = false and keeps the saved style, choosing a style turns subtitles back on', () => {
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    assert(row('subtitles') == nil, 'the Subtitles switch has no row of its own')
    local voices = {}
    for _, category in ipairs(loaded.categories) do
      assert(category.id ~= 'subtitles' and category.id ~= 'reactions' and category.name ~= 'Subtitles' and category.name ~= 'Automatic reactions', tostring(category.id))
      if category.id == 'voices' then for _, item in ipairs(category.settings) do voices[#voices + 1] = item.id end end
    end
    local at = {}
    for index, id in ipairs(voices) do at[id] = index end
    assert(at.replyLanguage and at.subtitleStyle == at.replyLanguage + 1, 'right after Voice language: ' .. table.concat(voices, ','))
    local entry = row('subtitleStyle')
    assert(entry.label == 'Subtitles' and entry.type == 'select' and entry.value == 2 and entry.defaultValue == 2)
    assert(#entry.elements == 3 and entry.elements[1] == 'Off' and entry.elements[2] == 'Cinematic subtitles' and entry.elements[3] == 'Above the speaker')
    assert(not entry.description:find('Subtitle display', 1, true))
    for _, category in ipairs(loaded.categories) do
      for _, item in ipairs(category.settings) do assert(item.label ~= 'Subtitle display', tostring(item.id)) end
    end
    local snapshot = manager.snapshot(player).settings
    assert(snapshot.subtitles == true and snapshot.subtitleStyle == 'dialogue')
    -- Above the speaker: the style is saved and subtitles are on.
    assert(registered.applyBatch('manager', {{id = 'subtitleStyle', value = 3}}).ok and saved.subtitleStyle == 'overhead' and saved.subtitles == true)
    -- Off: subtitles false, the saved style untouched, and the row reads Off after a reload.
    assert(registered.applyBatch('manager', {{id = 'subtitleStyle', value = 1}}).ok and saved.subtitles == false and saved.subtitleStyle == 'overhead')
    loaded = registered.loadMod('manager')
    assert(row('subtitleStyle').value == 1 and manager.subtitleStyle() == 'overhead')
    -- Choosing a style turns subtitles back on: the saved one comes back, or another is saved.
    assert(registered.applyBatch('manager', {{id = 'subtitleStyle', value = 3}}).ok and saved.subtitles == true and saved.subtitleStyle == 'overhead')
    loaded = registered.loadMod('manager')
    assert(row('subtitleStyle').value == 3)
    assert(registered.applyBatch('manager', {{id = 'subtitleStyle', value = 1}}).ok and registered.applyBatch('manager', {{id = 'subtitleStyle', value = 2}}).ok)
    assert(saved.subtitles == true and saved.subtitleStyle == 'dialogue')
    -- The stored switch still applies under its own id, and a batch that carries it decides it.
    assert(registered.applyBatch('manager', {{id = 'subtitles', value = false}, {id = 'subtitleStyle', value = 3}}).ok and saved.subtitles == false and saved.subtitleStyle == 'overhead')
    -- Entries that are not in the list are refused and nothing is saved.
    for _, invalid in ipairs({0, 4, 1.5, '2', false}) do
      assert(not registered.applyBatch('manager', {{id = 'subtitleStyle', value = invalid}}).ok and saved.subtitles == false and saved.subtitleStyle == 'overhead', tostring(invalid))
    end
  `);
});

test('React to battles and React to collected loot are the last two rows of Gameplay, on by default, apply on their own and are listed by Restore defaults; there is no Automatic reactions category', () => {
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    local gameplay
    for _, category in ipairs(loaded.categories) do
      assert(category.id ~= 'reactions' and category.name ~= 'Automatic reactions', tostring(category.id))
      if category.id == 'gameplay' then gameplay = category end
    end
    assert(gameplay and #gameplay.settings >= 3)
    local battle, loot = gameplay.settings[#gameplay.settings - 1], gameplay.settings[#gameplay.settings]
    assert(battle.id == 'battleReactions' and battle.label == 'React to battles' and battle.type == 'bool' and battle.value == true and battle.defaultValue == true)
    assert(loot.id == 'lootReactions' and loot.label == 'React to collected loot' and loot.type == 'bool' and loot.value == true and loot.defaultValue == true)
    assert(battle.description:find('Ten-minute cooldown after a fight', 1, true) and loot.description:find('Storage transfers stay silent', 1, true))
    assert(registered.applyBatch('manager', {{id = 'battleReactions', value = false}}).ok and saved.battleReactions == false and saved.lootReactions == true)
    assert(registered.applyBatch('manager', {{id = 'lootReactions', value = false}}).ok and saved.lootReactions == false and saved.battleReactions == false)
    local at = {}
    for _, change in ipairs(core.defaults()) do at[change.id] = change.value end
    assert(at.battleReactions == true and at.lootReactions == true, 'Restore defaults names both')
    assert(core.apply(core.defaults()).ok and saved.battleReactions == true and saved.lootReactions == true)
  `);
});

test('V’s voice for microphone lines is a select beside typed lines: all four typed/microphone on/off pairs are saved by one Apply, V has one engine (two different ones are refused, a choice names the other row), and each row reads its own value', () => {
  run(`${nsuiFixture}
    local clock = 1000
    os.clock = function() return clock end
    jsonFixtures['mistral-key'] = {provider = 'convai', effective = 'convai', saved = true}
    files['runtime/mistral-state.json'] = 'mistral-key'
    clock = clock + 2
    assert(invoke('tab:settings').ok)
    loaded = registered.loadMod('manager')
    local SAME = 'V’s typed and microphone lines use the same voice. Choose the same one for both, or Off for one.'
    local function apply(...)
      clock = clock + 2
      local changes = {}
      for _, change in ipairs({...}) do changes[#changes + 1] = {id = change[1], value = change[2]} end
      return core.apply(changes)
    end
    -- Every pair of Off / Pocket, typed and microphone.
    for typed = 1, 2 do
      for mic = 1, 2 do
        local tag = 'typed ' .. typed .. ' mic ' .. mic
        local result = apply({'vVoice', typed}, {'vVoiceMic', mic})
        assert(result.ok, tag .. ': ' .. tostring(result.error))
        assert(saved.vVoice == (typed ~= 1) and saved.vVoiceMic == (mic ~= 1), tag)
        assert(manager.vVoice() == (typed ~= 1) and manager.vVoiceMic() == (mic ~= 1) and manager.vVoiceActive() == (typed ~= 1 or mic ~= 1), tag)
        loaded = registered.loadMod('manager')
        assert(row('vVoice').value == typed and row('vVoiceMic').value == mic, tag .. ': each row reads its own value')
      end
    end
    -- One engine: two different engines in one Apply are refused and nothing is saved, whichever row comes first.
    assert(apply({'vVoice', 2}, {'vVoiceMic', 2}).ok)
    for _, pair in ipairs({{2, 3}, {3, 2}}) do
      local result = apply({'vVoice', pair[1]}, {'vVoiceMic', pair[2]})
      assert(result.ok == false and result.error == SAME and saved.vVoiceEngine == 'pocket', tostring(result.error))
    end
    -- The same engine for both is one save; Off for one and an engine for the other is fine.
    assert(apply({'vVoice', 3}, {'vVoiceMic', 3}).ok and saved.vVoiceEngine == 'voxtral' and saved.vVoice == true and saved.vVoiceMic == true)
    assert(apply({'vVoice', 1}, {'vVoiceMic', 2}).ok and saved.vVoiceEngine == 'pocket' and saved.vVoice == false and saved.vVoiceMic == true)
    assert(apply({'vVoice', 3}, {'vVoiceMic', 1}).ok and saved.vVoiceEngine == 'voxtral' and saved.vVoice == true and saved.vVoiceMic == false)
    -- Off on one row leaves the engine and the other row as they are.
    assert(apply({'vVoice', 3}, {'vVoiceMic', 3}).ok and apply({'vVoiceMic', 1}).ok)
    assert(saved.vVoiceEngine == 'voxtral' and saved.vVoice == true and saved.vVoiceMic == false)
    -- An engine chosen on one row while the other row is on moves the other, and the line names it; with the other Off nothing is named.
    assert(apply({'vVoice', 2}, {'vVoiceMic', 2}).ok)
    local result = apply({'vVoiceMic', 3})
    assert(result.ok and saved.vVoiceEngine == 'voxtral' and saved.vVoice == true and saved.vVoiceMic == true, tostring(result.error))
    assert(table.concat(result.names, ', ') == 'V’s voice for typed lines', table.concat(result.names, ', '))
    result = apply({'vVoice', 3})
    assert(result.ok and #result.names == 0, 'the same engine again changes nothing else')
    result = apply({'vVoice', 2})
    assert(result.ok and saved.vVoiceEngine == 'pocket' and table.concat(result.names, ', ') == 'V’s voice for microphone lines', table.concat(result.names, ', '))
    assert(apply({'vVoiceMic', 1}).ok)
    result = apply({'vVoice', 3})
    assert(result.ok and saved.vVoiceEngine == 'voxtral' and saved.vVoiceMic == false and #result.names == 0, 'the microphone row is Off: nothing is named')
    -- Voxtral needs the key on this row too, and a value that is not in the list is refused.
    jsonFixtures['mistral-none'] = {provider = 'convai', effective = 'convai', saved = false}
    files['runtime/mistral-state.json'] = 'mistral-none'
    clock = clock + 2
    manager.snapshot(player)
    result = apply({'vVoiceMic', 3})
    assert(result.ok == false and result.error == 'Requires a Mistral key (add it in Settings > Conversation provider)', tostring(result.error))
    for _, invalid in ipairs({0, 5, 1.5, '2', true, false}) do
      result = apply({'vVoiceMic', invalid})
      assert(result.ok == false and result.error == 'Choose one of the listed voices for V.', tostring(invalid) .. ' ' .. tostring(result.error))
    end
  `);
});

test('V’s voice for microphone lines is migrated once: a file saved before it was a setting of its own keeps what the player heard (typed lines Off made microphone lines silent), and vVoiceMicOwn marks the file', () => {
  run(`${managerFixture}
    local function load(extra)
      seed = {version = 2, voiceProvider = 'pocket', enabledByKey = {}, future = {keep = 'unchanged'}}
      for key, value in pairs(extra) do seed[key] = value end
      files['runtime/settings.json'], saved = 'seed', nil
      manager.configure(api, profiles); manager.prepare(player)
      return manager.snapshot(player).settings
    end
    -- Typed lines Off with microphone lines on, no marker: that was silent, so it becomes off, once.
    local state = load({vVoice = false, vVoiceChosen = true, vVoiceMic = true})
    assert(state.vVoice == false and state.vVoiceMic == false and saved.vVoiceMic == false and saved.vVoiceMicOwn == true, 'migrated')
    assert(not manager.vVoiceMic() and not manager.vVoiceActive() and saved.future.keep == 'unchanged')
    -- Once: the migrated file loads without another save, and the choice made afterwards stays.
    seed, saved = saved, nil
    files['runtime/settings.json'] = 'seed'
    manager.configure(api, profiles); manager.prepare(player)
    assert(saved == nil and not manager.vVoiceMic(), 'the second load saved again')
    assert(manager.applySettings(player, {vVoiceMic = true}) and manager.vVoiceMic() and manager.vVoiceActive() and not manager.vVoice())
    seed, saved = saved, nil
    files['runtime/settings.json'] = 'seed'
    manager.configure(api, profiles); manager.prepare(player)
    assert(manager.vVoiceMic() and not manager.vVoice() and saved == nil, 'with the marker nothing is forced')
    -- With the marker in the file nothing is forced either.
    state = load({vVoice = false, vVoiceChosen = true, vVoiceMic = true, vVoiceMicOwn = true})
    assert(state.vVoice == false and state.vVoiceMic == true and saved.vVoiceMicOwn == true and saved.vVoiceMic == true)
    -- Typed lines on keep microphone lines as saved; the marker is added.
    state = load({vVoice = true, vVoiceMic = true})
    assert(state.vVoiceMic == true and saved.vVoiceMicOwn == true)
    state = load({vVoice = true, vVoiceMic = false})
    assert(state.vVoiceMic == false and saved.vVoiceMicOwn == true)
    state = load({vVoice = false, vVoiceChosen = true, vVoiceMic = false})
    assert(state.vVoiceMic == false and saved.vVoiceMicOwn == true)
    -- A file without either key: typed lines on by default, microphone lines off.
    state = load({})
    assert(state.vVoice == true and state.vVoiceMic == false and saved.vVoiceMicOwn == true)
  `);
});

// ---- Home > Relationships (the characters V has talked to, with their bond details) ----------------------------------------------------------
const bondsPageFixture = `${nsuiFixture}
  local calls, list = 0, nil
  convaiBondsList = function() calls = calls + 1; return list end
  local DAY = 86400000
  local function now() return os.time() * 1000.0 end
  local function rows() local out = {} for _, category in ipairs(loaded.categories) do for _, item in ipairs(category.settings) do out[#out + 1] = item end end return out end
  local function reload() loaded = registered.loadMod('manager') end
  local function open() assert(invoke('tab:bonds').ok); reload() end
  local function leave() assert(invoke('bonds:back').ok); reload() end
  local judy = {profileKey = 'judy-alvarez', name = 'Judy Alvarez', level = 5, title = 'Good friend', points = 262, from = 240, next = 350, warm = 120, hurt = 12,
    hurtDays = 6, story = 150, talk = 112, arcDone = 6, arcTotal = 9, lastAt = now() - 3 * DAY - 5000,
    packs = {{title = 'Dressed for Dinner', state = 'active', label = 'She wants your honest eye on a dress'}, {title = 'The Long Debt', state = 'done', label = ''}}}
`;

test('Relationships sits right after the Model browser on Home, opens its own page with one Back, and nothing is read until it opens', () => run(`${bondsPageFixture}
  assert(managerUi.inspect().view == 'home')
  local nav = loaded.categories[1].settings
  assert(nav[3].id == 'tab:models' and nav[4].id == 'tab:bonds' and nav[4].label == 'Relationships' and nav[4].value == 'Open', 'right after the Model browser')
  assert(nav[4].description:find('how close each one is to you', 1, true))
  assert(calls == 0, 'Home reads nothing')
  assert(manager.applySettings(player, {characterBonds = true}))
  list = {judy}
  reload()
  assert(calls == 0, 'Home still reads nothing')
  open()
  local opened = calls
  assert(managerUi.inspect().view == 'bonds' and opened >= 1 and opened <= 2, 'the list is asked for when the page is built (the status file behind it is cached): ' .. calls)
  assert(loaded.categories[1].id == 'navigation' and #loaded.categories[1].settings == 1 and loaded.categories[1].settings[1].id == 'bonds:back' and loaded.categories[1].settings[1].value == 'Back')
  assert(not row('tab:models'), 'no destinations on an inner page')
  -- Ticks while the page is open read nothing more.
  for _ = 1, 30 do core.tick(player) end
  assert(calls == opened, 'no polling: ' .. calls)
  assert(invoke('bonds:back').ok and managerUi.inspect().view == 'home')
`));

test('Relationships with Character bonds off says so and where to turn it on and asks for nothing; with nobody listed it says nobody yet', () => run(`${bondsPageFixture}
  list = {judy}
  open()
  local off = row('bonds-off')
  assert(off and off.label == 'Character bonds are off' and off.description:find('Turn it on in Settings, under Gameplay', 1, true), 'off state')
  assert(calls == 0, 'the list is not asked for while the setting is off')
  assert(not row('bond:1') and not row('ui:page'))
  leave()
  assert(manager.applySettings(player, {characterBonds = true}))
  list = {}
  open()
  local empty = row('bonds-empty')
  assert(empty and empty.label == 'Nobody yet' and empty.description == 'Talk to a character and your bond with them shows here.', 'empty state')
  assert(not row('bonds-off') and not row('bond:1'))
  -- The bridge's file unreadable or the module missing: the same empty page, no error.
  leave()
  list = nil
  open()
  assert(row('bonds-empty') and (managerUi.inspect().error or '') == '')
  leave()
  convaiBondsList = function() error('boom') end
  open()
  assert(row('bonds-empty') and (managerUi.inspect().error or '') == '', 'a throwing list is an empty page')
  leave()
  convaiBondsList = nil
  open()
  assert(row('bonds-empty'), 'no list function at all')
`));

test('Relationships lists each character with level, progress, warmth, hurt, both parts, quests, last talk and stories, in the order given', () => run(`${bondsPageFixture}
  assert(manager.applySettings(player, {characterBonds = true, storyPacks = true}))
  local ann = {name = 'Ann', level = 10, title = 'Ride or die', points = 3000, from = 2000, warm = 40, hurt = 0, story = 10, talk = 30, arcDone = 3, arcTotal = 3, lastAt = now() - 1000, packs = {}}
  local bob = {name = 'Bob', level = 2, title = 'Familiar face', lastAt = now() - 1 * DAY - 1000, packs = {{title = 'One Pack', state = 'active'}}}
  list = {judy, ann, bob}
  open()
  local first = row('bond:1')
  assert(first.label == 'Judy Alvarez' and first.value == 'Level 5')
  assert(first.description == table.concat({'Bond: level 5, Good friend', '262 of 350 points to level 6', 'Warmth: 120', 'Hurt: 12, gone in about 6 game days',
    'From their story: 150, from talking: 112', 'Their quests: 6 of 9 finished', 'Last talked: 3 days ago'}, '\\n'), first.description)
  assert(row('bond:1:pack:1').label == 'Dressed for Dinner: She wants your honest eye on a dress')
  assert(row('bond:1:pack:2').label == 'The Long Debt (finished)')
  -- The rows come in the bridge's order: Judy, her stories, Ann, Bob.
  local order = {}
  for _, item in ipairs(rows()) do if item.id:match('^bond:') then order[#order + 1] = item.id end end
  assert(table.concat(order, ' ') == 'bond:1 bond:1:pack:1 bond:1:pack:2 bond:2 bond:3 bond:3:pack:1', table.concat(order, ' '))
  -- Level 10: highest level, no hurt line without hurt, and a character with no story says so.
  assert(row('bond:2').description == table.concat({'Bond: level 10, Ride or die', 'Highest level', 'Warmth: 40', 'From their story: 10, from talking: 30',
    'Their quests: 3 of 3 finished', 'Last talked: today', 'No story yet'}, '\\n'), row('bond:2').description)
  -- Almost nothing known: only what is there (a story with no label shows its title).
  assert(row('bond:3').description == 'Bond: level 2, Familiar face\\nLast talked: yesterday', row('bond:3').description)
  assert(row('bond:3:pack:1').label == 'One Pack')
  -- One hurt day, an unknown time, and a quests line only with an arc.
  list = {{name = 'Cat', level = 3, title = 'Friendly', points = 5, next = 100, hurt = 4, hurtDays = 1, arcTotal = 0, arcDone = 0, packs = {}},
    {name = 'Dan', level = 3, title = 'Friendly', hurt = 4, packs = {}}}
  leave(); open()
  assert(row('bond:1').description:find('Hurt: 4, gone in about a game day', 1, true) and not row('bond:1').description:find('Their quests', 1, true))
  assert(row('bond:2').description:find('Hurt: 4', 1, true) and not row('bond:2').description:find('gone in', 1, true))
  -- Story packs off: no story rows and no "No story yet".
  assert(manager.applySettings(player, {storyPacks = false}))
  list = {judy}
  leave(); open()
  assert(row('bond:1') and not row('bond:1:pack:1') and not row('bond:1').description:find('No story yet', 1, true))
`));

test('Relationships turns pages like the Characters list, and a character with little data is still a row and never an error', () => run(`${bondsPageFixture}
  assert(manager.applySettings(player, {characterBonds = true, storyPacks = true}))
  list = {}
  for index = 1, 30 do list[index] = {name = 'Person ' .. index, level = 1 + index % 10, title = 'T', packs = {}} end
  list[2] = {name = 'Only a name'}
  list[3] = {name = 'Odd', level = 4, title = 'Friend', points = 'x', next = {}, hurt = 'y', arcTotal = 'z', lastAt = 'never', packs = {}}
  open()
  local slider = row('ui:page')
  assert(slider and slider.max == 3, 'thirty characters are three pages of twelve')
  assert(row('bond:12') and not row('bond:13'))
  assert(row('bond:2').label == 'Only a name' and row('bond:2').value == '' and row('bond:2').description == 'No story yet')
  assert(row('bond:3').description == 'Bond: level 4, Friend\\nNo story yet', row('bond:3').description)
  assert(core.setUi('ui:page', 3)); reload()
  assert(row('bond:25') and row('bond:30') and not row('bond:12'))
  assert(row('list-range').description:find('characters 25 to 30', 1, true), row('list-range').description)
  -- Leaving and coming back starts on the first page.
  leave(); open()
  assert(row('bond:1') and not row('bond:25'))
`));

test('Relationships: the fullest English description fits the host\'s description limit uncut', () => run(`${bondsPageFixture}
  assert(manager.applySettings(player, {characterBonds = true, storyPacks = true}))
  list = {{name = 'Judy Alvarez', level = 9, title = 'Confidant', points = 1234567, next = 2345678, warm = 1234567, hurt = 123456, hurtDays = 12345,
    story = 1234567, talk = 1234567, arcDone = 12345, arcTotal = 12345, lastAt = now() - 400.0 * DAY, packs = {}}}
  open()
  local text = row('bond:1').description
  assert(text:find('Last talked: 400 days ago', 1, true), text)
  local count = select(2, text:gsub('[^\\128-\\191]', ''))
  assert(count <= 420 and managerUi.fitDescription(text) == text, 'the details are not cut: ' .. count)
`));
