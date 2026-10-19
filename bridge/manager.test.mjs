import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, readdirSync} from 'node:fs';
import path from 'node:path';
import fengari from 'fengari';
import {optionUnits} from './option-units.mjs';
import {MistralProvider, MistralControl} from './mistral-key.mjs';
import {createLocalSpeech} from './local-stt-capture.mjs';
import {companionModules, companionEngine, flatNavigation, flatSpatial} from './companion-fixture.mjs';
import {run, storage, managerFixture, nsuiFixture, queueSource, coreSource, hostSource, voicePreviewSource, fontsSource} from './manager-fixture.mjs';

const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const managerSource = readFileSync(new URL('../mod/manager.lua', import.meta.url), 'utf8');
const companionsSource = readFileSync(new URL('../mod/companions.lua', import.meta.url), 'utf8');
const noticesSource = readFileSync(new URL('../mod/notices.lua', import.meta.url), 'utf8');
const entrySource = readFileSync(new URL('../mod/nsui-entry.lua', import.meta.url), 'utf8');
const frenchUiSource = readFileSync(new URL('../mod/locales/fr.lua', import.meta.url), 'utf8');

// Night City Allies' Lucy and Rita (docs/NCA_FOLLOWERS_PLAN.md): the roster records only let the talk path recognise that
// mod's copy. invite = false keeps them out of every invite (Manager "Profile only", the manager unavailable, the party queue refuses).
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
    assert(queue.list()[9].state == 'failed' and queue.message():find('could not create', 1, true))
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

test('manager home owns the four destinations and every inner page has one parent Back action at the top', () => {
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
      for _, name in ipairs({'characters', 'party', 'models', 'settings'}) do
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
    assert(#category('navigation').settings == 4 and not row('party-count'))
    for _, name in ipairs({'characters', 'party', 'models', 'settings'}) do
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
    assert(party.dismiss('queued:1')); popupTick(true)
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

test('Auto-connect nearby characters is on by default, offered under Conversations and saved with the settings', () => {
  run(`${nsuiFixture}
    assert(manager.autoConnectNearby() == true and manager.snapshot(player).settings.autoConnectNearby == true)
    assert(invoke('tab:settings').ok)
    local auto = assert(row('autoConnectNearby'), 'the setting is not offered')
    assert(auto.type == 'bool' and auto.value == true and auto.defaultValue == true)
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

test('Johnny in your head is off by default, offered under Conversations and saved; his standing shows only while it is on', () => {
  run(`${nsuiFixture}
    assert(manager.johnnyInHead() == false and manager.snapshot(player).settings.johnnyInHead == false, 'a missing key is off')
    assert(saved.johnnyInHead == false, 'a new install saves the default Off')
    assert(invoke('tab:settings').ok)
    local johnny = assert(row('johnnyInHead'), 'the setting is not offered')
    assert(johnny.type == 'bool' and johnny.value == false and johnny.defaultValue == false)
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
    assert(standing.value == 'Grudging respect' and standing.label == 'Johnny’s standing' and standing.type == 'string')
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
  run(`${nsuiFixture}
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
  run(`${nsuiFixture}
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
  run(`${nsuiFixture}
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

test('Voice status names the voice that speaks: Voxtral and Inworld say so, only the Convai voice says Convai voices', () => {
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
    assert(#elements == 7 and elements[1] == 'Pocket · Performance' and elements[7] == 'Convai · Cloud voice')
    -- The entries keep plain labels (greyed out by the page, see the stepper test); the row's name says why.
    assert(elements[2] == 'OmniVoice · Balanced', elements[2])
    for index = 2, 5 do
      assert(elements[index]:find('OmniVoice', 1, true) and not elements[index]:find('needs pack', 1, true), 'entry ' .. index)
      assert(core.optionUnits(elements[index]) <= core.OPTION_BUDGET, 'entry ' .. index .. ' must stay short enough not to run over the arrows')
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


test('the saved way back is checked on load and on Apply, and is dropped with Mature content', () => {
  run(`${nsuiFixture}
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
    assert(widest <= core.OPTION_BUDGET and widest > 20, 'the widest option is ' .. widest)
  `);
});

test('the Inworld voice is a developer-mode voice: seven entries without Developer mode and eight with it, its key row only in Development, and a saved Inworld voice reads as Pocket TTS without it', () => {
  run(`${nsuiFixture}
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

test('the Mistral cloud voice speaks English only here: Multilingual conversations refuses it and moves a saved choice to the Convai cloud voice', () => {
  run(`${nsuiFixture}
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

test('the Inworld cloud voice says it needs an Inworld key and cannot be applied without one; with a key it applies, and the key is not the Mistral key', () => {
  run(`${nsuiFixture}
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
  run(`${nsuiFixture}
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

test('the Inworld cloud voice speaks English only here: Multilingual conversations refuses it and moves a saved choice off it', () => {
  run(`${nsuiFixture}
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
  run(`${nsuiFixture}${managerPopupFixture}
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
    assert(row('memory:select:person-20').value == 'Selected')
    assert(invoke('memory:forget-character').ok)
    local confirmation = token()
    assert(invoke('memory:settings').ok and managerUi.inspect().view == 'settings')
    assert(invoke('memory').ok and token() == confirmation and row('memory-confirmation'))
    assert(invoke('memory:cancel:' .. confirmation).ok and memoryWrites() == 0)
    assert(#members == 0 and #spawned == 0)
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
    assert(row('voice').type == 'bool' and row('omniSteps') == nil)
    assert(row('subtitles').type == 'bool' and row('subtitles').value == true)
    -- Order: 1 Cinematic subtitles (stored dialogue, the default), 2 Above the speaker (stored overhead).
    assert(row('subtitleStyle').type == 'select' and row('subtitleStyle').value == 1)
    assert(row('subtitleStyle').defaultValue == 1 and row('subtitleStyle').type == 'select')
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
    managerUi.update(player, true)
    assert(#spawned == 1 and members[1].profileKey == 'person-1')
    assert(invoke('settings:back').ok and invoke('tab:party').ok and row('dismiss:live:1'))
    managerUi.shutdown()
  `);
});

test('settings review wording: short voice description, Body gestures without a suffix, full Developer mode text, Model browser says what it lists', () => {
  run(`${nsuiFixture}
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
    assert(#row('ui:group').elements == 2 and row('ui:group').elements[2] == 'C')
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
    assert(row('dismiss:' .. id).value == 'Cancel invitation')
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
    for _, section in ipairs(loaded.categories) do
      for _, item in ipairs(section.id ~= 'navigation' and section.settings or {}) do
        total = total + 1
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
  run(`${nsuiFixture}
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
    managerUi.update(player, true)
    assert(#sent == 0, 'the default being switched off is silent')
    -- Turning it on beside the saved cloud voice is the player asking for it: the voice moves to Pocket TTS, with a notice.
    result = apply({'expressiveEmotions', true})
    assert(result.ok and saved.voiceProvider == 'pocket' and saved.expressiveEmotions == true and result.schemaChanged == true)
    assert(manager.snapshot(player).feedback == EMOTIONS, manager.snapshot(player).feedback)
    managerUi.update(player, true)
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
    managerUi.update(player, true)
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
  run(`${nsuiFixture}
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
  run(`${nsuiFixture}
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
  run(`${nsuiFixture}
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
  run(`${nsuiFixture}${multilingualApplyFixture}
    pack(true)
    assert(saved.voiceProvider == 'pocket')
    local result = apply({'multilingualConversations', true})
    assert(result.ok and result.schemaChanged == true and saved.multilingualConversations == true)
    assert(saved.voiceProvider == 'omni' and saved.omniSteps == 16 and saved.omniReference == 'short', 'the lightest Omni')
    local NOTICE = SWITCH .. 'OmniVoice · Balanced.'
    assert(manager.snapshot(player).feedback == NOTICE, manager.snapshot(player).feedback)
    managerUi.update(player, true); assert(#sent == 1 and sent[1] == NOTICE, tostring(sent[1]))
    managerUi.update(player, true); assert(#sent == 1, 'announced once')
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
  run(`${nsuiFixture}${multilingualApplyFixture}
    pack(false)
    local first = apply({'naturalSpeech', true}, {'expressiveEmotions', true})
    assert(first.ok and saved.voiceProvider == 'pocket', tostring(first.error) .. ' ' .. tostring(saved.voiceProvider))
    local result = apply({'multilingualConversations', true})
    assert(result.ok and result.schemaChanged == true and saved.multilingualConversations == true, 'on: ' .. tostring(result.error))
    assert(saved.voiceProvider == 'convai' and saved.naturalSpeech == false and saved.expressiveEmotions == false,
      'cloud: ' .. tostring(saved.voiceProvider) .. ' ' .. tostring(saved.naturalSpeech))
    local NOTICE = SWITCH .. 'Convai · Cloud voice. ' .. OFF
    assert(manager.snapshot(player).feedback == NOTICE, manager.snapshot(player).feedback)
    managerUi.update(player, true); assert(#sent == 1 and sent[1] == NOTICE, tostring(sent[1]))
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

test('Settings sections: Relationships is a button in Conversations, Conversation provider follows Conversations and sits before Voices, Development keeps Developer mode (and the Inworld key with it on), Voice status follows Companion voices', () => {
  run(`${nsuiFixture}
    assert(invoke('tab:settings').ok)
    local order = {}
    for _, category in ipairs(loaded.categories) do order[#order + 1] = category.id end
    local joined = table.concat(order, ',')
    assert(joined:find('navigation,interface,conversation-controls,conversation-provider,companion-behavior,voices,', 1, true) and not joined:find('relationships', 1, true), joined)
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
    assert(mistralHelp:find('You have used today’s 100 turns, which come back tomorrow.', 1, true) and mistralHelp:find('Mistral (with your free key, about 5,000 turns a day)', 1, true)
      and mistralHelp:find('Local AI (unlimited).', 1, true) and mistralHelp:find('It sets its own monthly cap, estimated at about 150,000 turns.', 1, true), mistralHelp)
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
    assert(provider.description:find('With Mistral or Local AI, Convai', 1, true), 'the voice paragraph names the option Local AI')
    assert(not provider.description:find('needs Local AI pack', 1, true) and not provider.description:find('Recommended', 1, true) and not provider.description:find('recommended', 1, true))
    assert(provider.description:find('not available yet', 1, true), 'without local speech recognition the help says so')
    local mistral = row('mistral-key')
    assert(mistral and mistral.type == 'action' and mistral.label == 'Mistral free API key' and mistral.value == 'Paste', mistral.label)
    assert(mistral.description:find('phone verification', 1, true) and mistral.description:find('player-mistral-key.txt', 1, true) and mistral.description:find('monthly cap', 1, true) and mistral.description:find('about 5,000 turns a day', 1, true))
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
