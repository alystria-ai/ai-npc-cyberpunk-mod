import {test} from 'node:test';
import {run, nsuiHarness, source} from './manager-fixture.mjs';

// Settings that change each other (deliverables/settings-audit-2026-10-20.md): the real page logic (mod/manager-ui.lua, mod/manager.lua) under
// the Native Settings UI host, as a player reaches each combination. One test per rule that once broke.
const everything = {
  'service-status.lua': source('service-status.lua'), 'support-report.lua': source('support-report.lua'),
  'setup-check.lua': source('setup-check.lua'), 'custom-provider.lua': source('custom-provider.lua'),
};
const harness = () => nsuiHarness({modules: everything}) + `
  local clock = 1000
  os.clock = function() return clock end
  local timeBase = os.time()
  os.time = function() return timeBase + math.floor(clock - 1000) end
  local function frames(count, step)
    for _ = 1, count or 6 do clock = clock + (step or 0.1); managerUi.update(player, true) end
    loaded = registered.loadMod('manager')
  end
  local function press(label)
    ns.interact.press(assert(ns.find(label), 'no row: ' .. label)); frames(3); ns.verify()
  end
  -- What the bridge publishes (runtime/mistral-state.json) and the voice service state (runtime/local-voice-state.json).
  local function bridge(tag, value) jsonFixtures['m-' .. tag] = value; files['runtime/mistral-state.json'] = 'm-' .. tag; clock = clock + 2; manager.snapshot(player) end
  local function voices(pack)
    local tag = 'voice-state-' .. tostring(pack)
    jsonFixtures[tag] = {state = 'ready', provider = 'pocket', omniPack = {installed = pack, missing = {}}, updated = os.time() * 1000.0}
    files['runtime/local-voice-state.json'] = tag
  end
  local MODELS = {{id = 'standard', name = 'Gemma', sizeMiB = 5000}, {id = 'mature:unc', name = 'Gemma uncensored', sizeMiB = 5200}}
  local function settings() return manager.snapshot(player).settings end
  frames(3)
`;

test('D1 (2026-10-20, revised after a live test): Mature content turned on with Local AI moves a Voxtral voice to Pocket and says so; turning it off after the Mistral key was removed leaves Pocket (no refusal loop)', () => run(`${harness()}
  bridge('key', {provider = 'convai', effective = 'convai', localAi = 'ready', saved = true, localModels = MODELS,
    localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
  voices(true)
  press('Settings'); frames(20)
  assert(manager.applySettings(player, {voiceProvider = 'voxtral'}))
  frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == true and saved.conversationProvider == 'local', 'Mature content is on with Local AI')
  assert(saved.voiceProvider == 'pocket', 'the voice moved to Pocket: ' .. tostring(saved.voiceProvider))
  assert(saved.matureRestore and saved.matureRestore.conversationProvider and saved.matureRestore.localModel, 'the provider and the model are kept for the way back')
  assert(saved.matureRestore.voice.before.provider == 'voxtral' and saved.matureRestore.voice.set.provider == 'pocket', 'and the voice')
  assert(tostring(managerUi.inspect().shown):find('Pocket · Performance', 1, true), 'the line names the voice: ' .. tostring(managerUi.inspect().shown))
  -- The player removes the Mistral key, then turns Mature content off: it works, and the voice stays on Pocket (Voxtral cannot be chosen without the key).
  bridge('nokey', {provider = 'local', effective = 'local', localAi = 'ready', saved = false, localModels = MODELS,
    localModelDefault = 'mature:unc', localModelMatureDefault = 'mature:unc'})
  frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == false, 'Mature content could not be turned off: ' .. tostring(managerUi.inspect().shown))
  assert(saved.conversationProvider == 'convai', 'the provider it changed is put back')
  assert(saved.voiceProvider == 'pocket', 'the voice stays on Pocket: ' .. tostring(saved.voiceProvider))
  assert(ns.find('Mature content').state == false)
`));

test('Mature content moves only a Voxtral voice: the Convai cloud voice and OmniVoice stay, with or without the OmniVoice pack, on Local AI and Custom; Mistral and Convai text turn it off', () => run(`${harness()}
  bridge('ready', {provider = 'convai', effective = 'convai', localAi = 'ready', saved = true, localModels = MODELS,
    localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
  voices(true)
  press('Settings'); frames(20)
  assert(manager.applySettings(player, {voiceProvider = 'convai', vVoice = true, vVoiceEngine = 'voxtral'}))
  frames(8)
  -- The companions on the Convai cloud voice stay; V on Voxtral moves to Pocket (and comes back with the setting off).
  for _, pack in ipairs({true, false}) do
    voices(pack); frames(8)
    ns.interact.toggle(ns.find('Mature content')); frames(8)
    assert(saved.matureContent == true and saved.voiceProvider == 'convai' and saved.vVoiceEngine == 'pocket' and saved.vVoice == true, 'on, pack ' .. tostring(pack))
    ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
    assert(saved.matureContent == false and saved.voiceProvider == 'convai' and saved.vVoiceEngine == 'voxtral', 'off, pack ' .. tostring(pack))
  end
  -- Mistral text: Mature content turned on from there selects Local AI (the pack is installed) and the voices move with it.
  assert(manager.applySettings(player, {conversationProvider = 'mistral', voiceProvider = 'voxtral'}))
  frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == true and saved.conversationProvider == 'local' and saved.voiceProvider == 'pocket' and saved.vVoiceEngine == 'pocket')
  -- Choosing Mistral again turns it off, and puts Voxtral back for both (nothing was changed since).
  ns.interact.select(ns.find('Conversation provider'), 3); frames(8); ns.verify()
  assert(saved.conversationProvider == 'mistral' and saved.matureContent == false and saved.voiceProvider == 'voxtral' and saved.vVoiceEngine == 'voxtral',
    tostring(saved.voiceProvider) .. ' ' .. tostring(saved.vVoiceEngine))
`));

test('A saved Mature record from before keeps all its parts; a Voxtral voice beside Mature content in a saved file is Pocket; turning it off with the kept parts puts the provider and Voxtral back', () => run(`${harness()}
  bridge('ready', {provider = 'local', effective = 'local', localAi = 'ready', saved = true, localModels = MODELS,
    localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
  voices(true)
  local function load(values)
    local file = {version = 2, enabledByKey = {}}
    for key, value in pairs(values) do file[key] = value end
    jsonFixtures['saved-old'] = file
    files['runtime/settings.json'] = 'saved-old'
    manager.reset()
    return manager.snapshot(player).settings
  end
  local old = load({conversationProvider = 'local', matureContent = true, voiceProvider = 'pocket', vVoiceEngine = 'pocket', matureRestore = {
    conversationProvider = {before = 'convai', set = 'local'},
    voice = {before = {provider = 'omni', steps = 16, reference = 'short'}, set = {provider = 'pocket'}},
    vVoiceEngine = {before = 'voxtral', set = 'pocket'}}})
  assert(old.matureRestore and old.matureRestore.conversationProvider.before == 'convai', 'the provider part is kept')
  assert(old.matureRestore.voice.before.provider == 'omni' and old.matureRestore.voice.before.steps == 16 and old.matureRestore.vVoiceEngine.before == 'voxtral', 'the voice parts are kept')
  assert(old.voiceProvider == 'pocket' and old.vVoiceEngine == 'pocket')
  -- A hand-edited file with Voxtral and Mature content: both voices load as Pocket.
  old = load({conversationProvider = 'local', matureContent = true, voiceProvider = 'voxtral', vVoiceEngine = 'voxtral'})
  assert(old.voiceProvider == 'pocket' and old.vVoiceEngine == 'pocket' and old.matureContent == true)
  -- Turning it off with the kept parts puts the provider, OmniVoice and Voxtral back.
  load({conversationProvider = 'local', matureContent = true, voiceProvider = 'pocket', vVoiceEngine = 'pocket', matureRestore = {
    conversationProvider = {before = 'convai', set = 'local'},
    voice = {before = {provider = 'omni', steps = 16, reference = 'short'}, set = {provider = 'pocket'}},
    vVoiceEngine = {before = 'voxtral', set = 'pocket'}}})
  press('Settings'); frames(20)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == false and saved.conversationProvider == 'convai' and saved.voiceProvider == 'omni' and saved.vVoiceEngine == 'voxtral', tostring(saved.voiceProvider))
`));

test('Restore defaults while Mature content is on gives the default voices, whatever voice was chosen', () => run(`${harness()}
  bridge('ready', {provider = 'convai', effective = 'convai', localAi = 'ready', saved = true, localModels = MODELS,
    localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
  voices(true)
  press('Settings'); frames(20)
  assert(manager.applySettings(player, {voiceProvider = 'voxtral', naturalSpeech = false, vVoiceEngine = 'voxtral'}))
  frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8)
  assert(saved.matureContent == true and saved.voiceProvider == 'pocket' and saved.vVoiceEngine == 'pocket')
  ns.interact.restoreDefaults(); frames(8); ns.verify()
  local now = settings()
  assert(now.matureContent == false and now.conversationProvider == 'convai')
  assert(now.voiceProvider == 'pocket', 'the default voice is Pocket, got ' .. tostring(now.voiceProvider))
  assert(now.vVoice == true and now.vVoiceEngine == 'pocket', 'V speaks with Pocket by default')
  assert(now.battleReactions == false and now.lootReactions == false and now.johnnyInHead == false and now.johnnyRemarks == 'off')
`));

test('D3 (2026-10-20, revised): Mature content from Convai or Mistral without the Local AI pack selects Custom when it is ready, else it refuses, and never selects Mistral, with or without a key', () => run(`${harness()}
  local function customState(ready) jsonFixtures['custom-' .. tostring(ready)] = {version = 1, updated = 1, ready = ready, host = 'openrouter.ai', secure = true,
    ['local'] = false, model = ready and 'llama3.2' or nil, keySaved = true, tail = 'wxyz'}
    files['runtime/custom-provider-state.json'] = 'custom-' .. tostring(ready); clock = clock + 2; manager.snapshot(player) end
  press('Settings'); frames(20)
  -- A Mistral key, no Local AI pack, no Custom endpoint: refused (Mistral is never selected), nothing changes.
  bridge('key', {provider = 'convai', effective = 'convai', localAi = 'absent', saved = true})
  customState(false); frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == false and saved.conversationProvider == 'convai', 'refused: ' .. tostring(saved.conversationProvider))
  assert(tostring(managerUi.inspect().shown):find('Needs Local AI or Custom.', 1, true), tostring(managerUi.inspect().shown))
  -- A Custom endpoint that is ready: Custom is selected, with or without the key, and the line names it; turning it off puts Convai back.
  customState(true); frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == true and saved.conversationProvider == 'custom', tostring(saved.conversationProvider))
  assert(tostring(managerUi.inspect().shown):find('Custom (OpenAI-compatible)', 1, true), tostring(managerUi.inspect().shown))
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == false and saved.conversationProvider == 'convai')
  bridge('nokey', {provider = 'convai', effective = 'convai', localAi = 'absent', saved = false}); frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == true and saved.conversationProvider == 'custom')
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  -- From Mistral with a key and no other way: refused, and Mistral stays.
  customState(false); frames(8)
  assert(manager.applySettings(player, {conversationProvider = 'mistral'}))
  bridge('key2', {provider = 'mistral', effective = 'mistral', localAi = 'absent', saved = true}); frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == false and saved.conversationProvider == 'mistral' and ns.find('Mature content').state == false)
  assert(tostring(managerUi.inspect().shown):find('Needs Local AI or Custom.', 1, true), tostring(managerUi.inspect().shown))
`));


test('D8: Natural speech is blocked only by the Convai cloud voice on a Convai provider; Mistral, Local AI and Custom keep it with that voice', () => run(`${harness()}
  bridge('key', {provider = 'mistral', effective = 'mistral', saved = true})
  voices(true)
  press('Settings'); frames(20)
  for _, provider in ipairs({'mistral', 'local', 'custom'}) do
    assert(manager.applySettings(player, {conversationProvider = provider, voiceProvider = 'convai', naturalSpeech = true}))
    assert(settings().naturalSpeech == true and settings().voiceProvider == 'convai', provider)
    -- The row is not greyed out there.
    frames(8)
    assert(not ns.find('Natural speech').disabled, provider .. ': the row is usable')
  end
  -- Back on a Convai provider the pairing cannot stand: the voice is kept and Natural speech goes off, with a line.
  local ok, err, notice = manager.applySettings(player, {conversationProvider = 'convai'})
  assert(ok, err)
  assert(settings().voiceProvider == 'convai' and settings().naturalSpeech == false, 'the voice stays, Natural speech is off')
  assert(notice == 'The Convai cloud voice cannot use Natural speech, so it was turned off.', tostring(notice))
  -- And turning it on beside the Convai provider and voice moves the voice to Pocket.
  ok, err, notice = manager.applySettings(player, {naturalSpeech = true})
  assert(ok, err)
  assert(settings().naturalSpeech == true and settings().voiceProvider == 'pocket', tostring(settings().voiceProvider))
  assert(notice and notice:find('Natural speech needs a local voice', 1, true), tostring(notice))
`));

test('the Multilingual conversations switch is gone (2026-10-21): an Apply that still carries it is ignored, nothing moves, nothing is saved or said, on every provider and voice', () => run(`${harness()}
  bridge('key', {provider = 'mistral', effective = 'mistral', saved = true})
  voices(true)
  press('Settings'); frames(20)
  for _, provider in ipairs({'convai', 'mistral', 'local', 'custom'}) do
    for _, voice in ipairs({'pocket', 'voxtral', 'convai', 'omni'}) do
      assert(manager.applySettings(player, {conversationProvider = provider, voiceProvider = voice, naturalSpeech = false}))
      local before = settings()
      local ok, err, notice = manager.applySettings(player, {multilingualConversations = true})
      assert(ok, provider .. '/' .. voice .. ': ' .. tostring(err))
      assert(notice == nil, provider .. '/' .. voice .. ': a notice for a setting that is gone: ' .. tostring(notice))
      assert(settings().voiceProvider == before.voiceProvider and settings().voiceProvider == voice, provider .. '/' .. voice .. ' moved to ' .. tostring(settings().voiceProvider))
      assert(settings().multilingualConversations == nil and saved.multilingualConversations == nil, 'nothing is saved for it')
    end
  end
  -- Pocket is no longer refused for a switch: it can be chosen on the Convai free tier as on any provider.
  assert(manager.applySettings(player, {conversationProvider = 'convai', voiceProvider = 'omni'}))
  local ok, err = manager.applySettings(player, {voiceProvider = 'pocket', multilingualConversations = true})
  assert(ok, tostring(err))
  assert(settings().voiceProvider == 'pocket', tostring(settings().voiceProvider))
  assert(manager.multilingualConversations == nil and manager.multilingualActive == nil and manager.resolveMultilingualVoice == nil)
`));

test('the Native Settings page has no Multilingual conversations row, and the snapshot no key for it', () => run(`${harness()}
  bridge('key', {provider = 'convai', effective = 'convai', saved = true})
  voices(true)
  press('Settings'); frames(20)
  assert(ns.find('Talk to ordinary NPCs'), 'the Conversations rows are on the page')
  assert(ns.find('Multilingual conversations') == nil, 'the row is gone')
  assert(settings().multilingualConversations == nil)
  assert(not tostring(managerUi.inspect().shown):find('Multilingual', 1, true), tostring(managerUi.inspect().shown))
`));

test('a saved multilingualConversations: true is dropped on load and leaves every voice alone, Pocket TTS included, beside every provider', () => run(`${harness()}
  bridge('key', {provider = 'mistral', effective = 'mistral', saved = true})
  local function load(values)
    local file = {version = 2, enabledByKey = {}}
    for key, value in pairs(values) do file[key] = value end
    jsonFixtures['saved-file'] = file
    files['runtime/settings.json'] = 'saved-file'
    manager.reset()
    return manager.snapshot(player).settings
  end
  for _, provider in ipairs({'convai', 'mistral', 'local', 'custom'}) do
    for _, voice in ipairs({'pocket', 'voxtral', 'convai', 'omni'}) do
      local loadedSettings = load({conversationProvider = provider, voiceProvider = voice, multilingualConversations = true})
      assert(loadedSettings.voiceProvider == voice, provider .. '/' .. voice .. ' became ' .. tostring(loadedSettings.voiceProvider))
      assert(loadedSettings.multilingualConversations == nil, 'the key is not in the snapshot')
    end
  end
`));
