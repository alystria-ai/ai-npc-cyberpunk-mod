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

test('D1: Mature content turned on with Local AI changes no voice, and turning it off (after the Mistral key was removed) leaves the voice alone too', () => run(`${harness()}
  bridge('key', {provider = 'convai', effective = 'convai', localAi = 'ready', saved = true, localModels = MODELS,
    localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
  voices(true)
  press('Settings'); frames(20)
  assert(manager.applySettings(player, {voiceProvider = 'voxtral'}))
  frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == true and saved.conversationProvider == 'local', 'Mature content is on with Local AI')
  assert(saved.voiceProvider == 'voxtral', 'the voice stays: ' .. tostring(saved.voiceProvider))
  assert(saved.matureRestore and saved.matureRestore.conversationProvider and saved.matureRestore.localModel, 'the provider and the model are kept for the way back')
  assert(saved.matureRestore.voice == nil and saved.matureRestore.vVoiceEngine == nil, 'no voice part is recorded')
  assert(not tostring(managerUi.inspect().shown):find('voice', 1, true), 'nothing is said about a voice: ' .. tostring(managerUi.inspect().shown))
  -- The player removes the Mistral key, then turns Mature content off.
  bridge('nokey', {provider = 'local', effective = 'local', localAi = 'ready', saved = false, localModels = MODELS,
    localModelDefault = 'mature:unc', localModelMatureDefault = 'mature:unc'})
  frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == false, 'Mature content could not be turned off: ' .. tostring(managerUi.inspect().shown))
  assert(saved.conversationProvider == 'convai', 'the provider it changed is put back')
  assert(saved.voiceProvider == 'voxtral', 'the voice is the player’s: ' .. tostring(saved.voiceProvider))
  assert(ns.find('Mature content').state == false)
`));

test('D1: Mature content never moves the companion voice or V’s voice, on or off, with or without the OmniVoice pack, with Local AI or Mistral', () => run(`${harness()}
  bridge('ready', {provider = 'convai', effective = 'convai', localAi = 'ready', saved = true, localModels = MODELS,
    localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
  voices(true)
  press('Settings'); frames(20)
  assert(manager.applySettings(player, {voiceProvider = 'convai', vVoice = true, vVoiceEngine = 'voxtral'}))
  frames(8)
  for _, pack in ipairs({true, false}) do
    voices(pack); frames(8)
    ns.interact.toggle(ns.find('Mature content')); frames(8)
    assert(saved.matureContent == true and saved.voiceProvider == 'convai' and saved.vVoiceEngine == 'voxtral' and saved.vVoice == true, 'on, pack ' .. tostring(pack))
    ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
    assert(saved.matureContent == false and saved.voiceProvider == 'convai' and saved.vVoiceEngine == 'voxtral', 'off, pack ' .. tostring(pack))
  end
  -- Mistral, then Local AI, with Mature content on: still the same voices, and no line about them.
  assert(manager.applySettings(player, {conversationProvider = 'mistral', matureContent = true}))
  frames(8)
  ns.interact.select(ns.find('Conversation provider'), 4); frames(8); ns.verify()
  assert(saved.conversationProvider == 'local' and saved.matureContent == true and saved.voiceProvider == 'convai' and saved.vVoiceEngine == 'voxtral')
  assert(not tostring(managerUi.inspect().shown):find('voice', 1, true), tostring(managerUi.inspect().shown))
`));

test('D1: a saved Mature record from before keeps its provider and model parts; its voice parts are dropped without a word', () => run(`${harness()}
  bridge('ready', {provider = 'local', effective = 'local', localAi = 'ready', saved = false, localModels = MODELS,
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
  assert(old.matureRestore.voice == nil and old.matureRestore.vVoiceEngine == nil, 'the voice parts are dropped')
  assert(old.voiceProvider == 'pocket' and old.vVoiceEngine == 'pocket')
  -- A record that held only voice parts is no record at all.
  old = load({conversationProvider = 'local', matureContent = true, matureRestore = {voice = {before = {provider = 'convai'}, set = {provider = 'pocket'}}}})
  assert(old.matureRestore == nil, 'a record of voice parts only is gone')
  -- Turning it off with the kept parts puts the provider back and leaves the voice.
  load({conversationProvider = 'local', matureContent = true, voiceProvider = 'omni', matureRestore = {
    conversationProvider = {before = 'convai', set = 'local'}, voice = {before = {provider = 'convai'}, set = {provider = 'omni'}}}})
  press('Settings'); frames(20)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == false and saved.conversationProvider == 'convai' and saved.voiceProvider == 'omni', tostring(saved.voiceProvider))
`));

test('Restore defaults while Mature content is on gives the default voices, whatever voice was chosen', () => run(`${harness()}
  bridge('ready', {provider = 'convai', effective = 'convai', localAi = 'ready', saved = true, localModels = MODELS,
    localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
  voices(true)
  press('Settings'); frames(20)
  assert(manager.applySettings(player, {voiceProvider = 'convai', naturalSpeech = false, vVoiceEngine = 'voxtral'}))
  frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8)
  assert(saved.matureContent == true and saved.voiceProvider == 'convai')
  ns.interact.restoreDefaults(); frames(8); ns.verify()
  local now = settings()
  assert(now.matureContent == false and now.conversationProvider == 'convai')
  assert(now.voiceProvider == 'pocket', 'the default voice is Pocket, got ' .. tostring(now.voiceProvider))
  assert(now.vVoice == true and now.vVoiceEngine == 'pocket', 'V speaks with Pocket by default')
  assert(now.battleReactions == true and now.lootReactions == true and now.johnnyInHead == false and now.johnnyRemarks == 'off')
`));

test('D3: Mature content from Convai without the Local AI pack selects Mistral when a key is saved, else Custom when it is ready, else it refuses', () => run(`${harness()}
  local function customState(ready) jsonFixtures['custom-' .. tostring(ready)] = {version = 1, updated = 1, ready = ready, host = 'openrouter.ai', secure = true,
    ['local'] = false, model = ready and 'llama3.2' or nil, keySaved = true, tail = 'wxyz'}
    files['runtime/custom-provider-state.json'] = 'custom-' .. tostring(ready); clock = clock + 2; manager.snapshot(player) end
  press('Settings'); frames(20)
  -- A Mistral key, no Local AI pack: Mistral is selected, and the line names it.
  bridge('key', {provider = 'convai', effective = 'convai', localAi = 'absent', saved = true})
  frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == true and saved.conversationProvider == 'mistral', tostring(saved.conversationProvider))
  assert(saved.matureRestore.conversationProvider.before == 'convai' and saved.matureRestore.conversationProvider.set == 'mistral')
  assert(tostring(managerUi.inspect().shown):find('Mistral (free plan)', 1, true), tostring(managerUi.inspect().shown))
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == false and saved.conversationProvider == 'convai', 'turning it off puts Convai back')
  -- No key, a Custom endpoint that is ready: Custom is selected.
  bridge('nokey', {provider = 'convai', effective = 'convai', localAi = 'absent', saved = false})
  customState(true); frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == true and saved.conversationProvider == 'custom', tostring(saved.conversationProvider))
  assert(tostring(managerUi.inspect().shown):find('Custom (OpenAI-compatible)', 1, true), tostring(managerUi.inspect().shown))
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == false and saved.conversationProvider == 'convai')
  -- A Custom endpoint that is not ready, no key, no pack: refused, nothing changes.
  customState(false); frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == false and saved.conversationProvider == 'convai', 'refused: ' .. tostring(saved.conversationProvider))
  assert(tostring(managerUi.inspect().shown):find('Needs Local AI, Mistral or Custom.', 1, true), tostring(managerUi.inspect().shown))
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

test('Multilingual conversations acts only where the bridge uses it (Convai free tier): with Mistral it moves no voice and refuses none', () => run(`${harness()}
  bridge('key', {provider = 'mistral', effective = 'mistral', saved = true})
  voices(true)
  press('Settings'); frames(20)
  assert(manager.applySettings(player, {conversationProvider = 'mistral', voiceProvider = 'voxtral'}))
  -- On beside Mistral: the bridge keeps it off there (bridge/convai-bridge.mjs, text providers), so the voice stays.
  local ok, err, notice = manager.applySettings(player, {multilingualConversations = true})
  assert(ok, err)
  assert(settings().voiceProvider == 'voxtral', 'the voice was moved for a setting that does nothing here: ' .. tostring(settings().voiceProvider))
  assert(notice == nil, tostring(notice))
  ok, err = manager.applySettings(player, {voiceProvider = 'pocket'})
  assert(ok, 'Pocket refused beside Mistral: ' .. tostring(err))
  assert(manager.applySettings(player, {naturalSpeech = true}))
  -- The Convai API key: the bridge keeps it off on a player's key too.
  assert(manager.applySettings(player, {conversationProvider = 'convai', useOwnConvaiKey = true}))
  assert(settings().voiceProvider == 'pocket' and settings().naturalSpeech == true)
  -- Back to Convai free tier, where it works: the voice moves now, with the usual line.
  ok, err, notice = manager.applySettings(player, {conversationProvider = 'convai', useOwnConvaiKey = false})
  assert(ok, err)
  assert(settings().voiceProvider == 'omni' and settings().omniSteps == 16 and settings().omniReference == 'short', tostring(settings().voiceProvider))
  assert(notice and notice:find('Multilingual conversations needs a voice that speaks every language', 1, true), tostring(notice))
  -- Now Pocket is refused, as before.
  local refused, message = manager.applySettings(player, {voiceProvider = 'pocket'})
  assert(refused == false and message == 'Pocket TTS speaks only English. Turn off Multilingual conversations to choose it.', tostring(message))
`));

test('a saved Multilingual pairing with Voxtral beside Mistral is kept on load; beside Convai free tier it moves to the cloud voice', () => run(`${harness()}
  bridge('key', {provider = 'mistral', effective = 'mistral', saved = true})
  local function load(values)
    local file = {version = 2, enabledByKey = {}}
    for key, value in pairs(values) do file[key] = value end
    jsonFixtures['saved-file'] = file
    files['runtime/settings.json'] = 'saved-file'
    manager.reset()
    return manager.snapshot(player).settings
  end
  local loadedSettings = load({conversationProvider = 'mistral', voiceProvider = 'voxtral', multilingualConversations = true})
  assert(loadedSettings.voiceProvider == 'voxtral', tostring(loadedSettings.voiceProvider))
  loadedSettings = load({conversationProvider = 'convai', voiceProvider = 'voxtral', multilingualConversations = true})
  assert(loadedSettings.voiceProvider == 'convai', tostring(loadedSettings.voiceProvider))
`));
