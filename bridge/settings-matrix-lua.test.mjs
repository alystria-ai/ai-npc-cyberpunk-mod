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

test('Mature content turned off after the Mistral key was removed: the switch goes off and the Voxtral voice it replaced is not forced back (no refusal loop)', () => run(`${harness()}
  bridge('key', {provider = 'convai', effective = 'convai', localAi = 'ready', saved = true, localModels = MODELS,
    localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
  voices(true)
  press('Settings'); frames(20)
  assert(manager.applySettings(player, {voiceProvider = 'voxtral'}))
  frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == true and saved.conversationProvider == 'local' and saved.voiceProvider == 'pocket', tostring(saved.voiceProvider))
  assert(saved.matureRestore and saved.matureRestore.voice.before.provider == 'voxtral')
  -- The player removes the Mistral key, then turns Mature content off.
  bridge('nokey', {provider = 'local', effective = 'local', localAi = 'ready', saved = false, localModels = MODELS,
    localModelDefault = 'mature:unc', localModelMatureDefault = 'mature:unc'})
  frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == false, 'Mature content could not be turned off: ' .. tostring(managerUi.inspect().shown))
  assert(saved.conversationProvider == 'convai', 'the provider it changed is put back')
  assert(saved.voiceProvider == 'pocket', 'a voice that needs the removed key is not chosen again')
  assert(ns.find('Mature content').state == false)
`));

test('Mature content turned off puts back an OmniVoice voice only while the OmniVoice pack is installed', () => run(`${harness()}
  bridge('ready', {provider = 'convai', effective = 'convai', localAi = 'ready', saved = false, localModels = MODELS,
    localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
  voices(true)
  press('Settings'); frames(20)
  -- Turned on from Convai with the Convai cloud voice: the voice moves to Pocket, and the record keeps the cloud voice.
  assert(manager.applySettings(player, {voiceProvider = 'convai', naturalSpeech = false, expressiveEmotions = false}))
  frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8)
  assert(saved.matureContent == true and saved.voiceProvider == 'pocket')
  -- A hand-made record that names OmniVoice (as a save from the Omni pack would), with the pack now gone.
  saved.matureRestore.voice.before = {provider = 'omni', steps = 16, reference = 'short'}
  voices(false)
  frames(8)
  assert(manager.omniPack().installed == false, 'the pack is reported missing')
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == false, 'Mature content could not be turned off: ' .. tostring(managerUi.inspect().shown))
  assert(saved.voiceProvider == 'pocket', tostring(saved.voiceProvider))
`));

test('Mature content with Local AI moves V’s voice engine off Voxtral, says so, and turning it off puts Voxtral back', () => run(`${harness()}
  bridge('key', {provider = 'convai', effective = 'convai', localAi = 'ready', saved = true, localModels = MODELS,
    localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
  voices(true)
  press('Settings'); frames(20)
  assert(manager.applySettings(player, {vVoiceEngine = 'voxtral'}))
  frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == true and saved.conversationProvider == 'local' and saved.vVoiceEngine == 'pocket')
  local shown = tostring(managerUi.inspect().shown)
  assert(shown:find('V’s voice engine', 1, true), 'the player is told V moved to Pocket: ' .. shown)
  assert(ns.find('V’s voice engine').selectedElementIndex == 1)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == false and saved.conversationProvider == 'convai')
  assert(saved.vVoiceEngine == 'voxtral', 'V’s voice engine is put back: ' .. tostring(saved.vVoiceEngine))
  -- Mistral with Mature content on, then Local AI: V leaves Voxtral there too, with the same line.
  assert(manager.applySettings(player, {conversationProvider = 'mistral', matureContent = true, vVoiceEngine = 'voxtral'}))
  frames(8)
  assert(saved.matureContent == true and saved.vVoiceEngine == 'voxtral')
  ns.interact.select(ns.find('Conversation provider'), 4); frames(8); ns.verify()
  assert(saved.conversationProvider == 'local' and saved.vVoiceEngine == 'pocket')
  shown = tostring(managerUi.inspect().shown)
  assert(shown:find('V’s voice engine', 1, true), 'the switch to Local AI names V’s voice engine: ' .. shown)
`));

test('Restore defaults while Mature content is on gives the default voice, not the cloud voice Mature content replaced', () => run(`${harness()}
  bridge('ready', {provider = 'convai', effective = 'convai', localAi = 'ready', saved = false, localModels = MODELS,
    localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
  voices(true)
  press('Settings'); frames(20)
  assert(manager.applySettings(player, {voiceProvider = 'convai', naturalSpeech = false, expressiveEmotions = false}))
  frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8)
  assert(saved.matureContent == true and saved.voiceProvider == 'pocket' and saved.matureRestore.voice.before.provider == 'convai')
  ns.interact.restoreDefaults(); frames(8); ns.verify()
  local now = settings()
  assert(now.matureContent == false and now.conversationProvider == 'convai')
  assert(now.voiceProvider == 'pocket', 'the default voice is Pocket, got ' .. tostring(now.voiceProvider))
  assert(now.expressiveEmotions == true, 'the default Expressive emotions stays on')
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
