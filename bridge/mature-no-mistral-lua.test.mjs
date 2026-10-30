import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {run, nsuiHarness, source} from './manager-fixture.mjs';

// Mature content is for Local AI and Custom only, and no Voxtral voice is used beside it (owner decision 2026-10-20, after a live test in which Mistral's
// Voxtral voice refused Mature lines: "let's not risk their API key"). The page logic (mod/manager-ui.lua, mod/manager.lua) is tested in manager.test.mjs,
// nsui-manager.test.mjs, mcm-host.test.mjs and settings-matrix-lua.test.mjs; this file holds what ties it together and the live-test report of a false
// "Mistral not ready, switching to Convai" notice after Apply.
const everything = {
  'service-status.lua': source('service-status.lua'), 'character-editor.lua': source('character-editor.lua'),
  'convai-paid-tier.lua': source('convai-paid-tier.lua'), 'support-report.lua': source('support-report.lua'),
  'setup-check.lua': source('setup-check.lua'), 'custom-provider.lua': source('custom-provider.lua'),
};
const harness = () => `
  local logged = {}
  print = function(text) logged[#logged + 1] = tostring(text) end
` + nsuiHarness({modules: everything, mcm: {version: '0.10.5'}, screen: false}) + `
  convaiNotices.configure(function() return manager.developerMode() end)
  local clock = 1000
  os.clock = function() return clock end
  local timeBase = os.time()
  os.time = function() return timeBase + math.floor(clock - 1000) end
  local function frames(count, step)
    for _ = 1, count or 8 do clock = clock + (step or 0.1); managerUi.update(player, true); if mcm then mcm.update() end end
  end
  local function press(label) local ok, why = mcm.press(label); assert(ok, why); frames(2) end
  -- Mature content is on the AI provider page. The first call walks Settings > AI provider, a later one finds itself already there.
  local function toProvider() pcall(press, 'Settings'); pcall(press, 'AI provider'); frames(8) end
  local MODELS = {{id = 'lite', name = 'Bonsai', sizeMiB = 1156}, {id = 'mature:lite', name = 'Qwen uncensored', sizeMiB = 2582},
    {id = 'standard', name = 'Gemma', sizeMiB = 4916}, {id = 'mature:good', name = 'Gemma uncensored', sizeMiB = 5088}}
  local stateCount = 0
  local function file(path, value)
    stateCount = stateCount + 1
    jsonFixtures['state-' .. stateCount] = value
    files[path] = 'state-' .. stateCount
    clock = clock + 2
    manager.snapshot(player)
  end
  -- What the bridge publishes: the provider it applied, the key, the Local AI pack; the Custom endpoint's state; the voice service.
  local function bridge(provider, keySaved, pack)
    file('runtime/mistral-state.json', {provider = provider, effective = provider, saved = keySaved, maturePack = pack, localAi = pack and 'ready' or 'absent',
      localModels = pack and MODELS or nil, localModelDefault = pack and 'standard' or nil, localModelMatureDefault = pack and 'mature:good' or nil})
  end
  local function custom(ready)
    file('runtime/custom-provider-state.json', {version = 1, updated = stateCount, ready = ready, host = ready and 'localhost:11434' or nil, secure = false,
      ['local'] = true, model = ready and 'llama3.2' or nil, keySaved = false})
  end
  file('runtime/local-voice-state.json', {state = 'ready', provider = 'pocket', omniPack = {installed = true, missing = {}}, updated = os.time() * 1000.0})
  frames(3)
`;

test('Apply writes the settings once, and no saved state ever has Convai in it while the player is on Mistral (the 2026-10-20 live report: "Conversation provider: convai" then "mistral" around turning Mature content on)', () => run(`${harness()}
  mcm.openScreen(); frames(2)
  local function writesSince(count)
    local seen = {}
    for index = count + 1, #fileWrites do
      local write = fileWrites[index]
      if write.path == 'runtime/settings.json.tmp' then
        local value = jsonFixtures[write.value]
        seen[#seen + 1] = {provider = value.conversationProvider, own = value.useOwnConvaiKey, mature = value.matureContent == true, voice = value.voiceProvider, v = value.vVoiceEngine}
      end
    end
    return seen
  end
  local failures = {}
  local function check(label, before, initial, expectFinal)
    local seen = writesSince(before)
    local final = saved.conversationProvider
    if #seen > 1 then failures[#failures + 1] = label .. ': ' .. #seen .. ' saves for one Apply' end
    for _, state in ipairs(seen) do
      if state.provider ~= initial and state.provider ~= final then failures[#failures + 1] = label .. ': a save passed through ' .. tostring(state.provider) end
      if state.mature and state.provider ~= 'local' and state.provider ~= 'custom' then failures[#failures + 1] = label .. ': Mature content saved beside ' .. tostring(state.provider) end
      if state.mature and (state.voice == 'voxtral' or state.v == 'voxtral') then failures[#failures + 1] = label .. ': Mature content saved beside Voxtral' end
    end
    if expectFinal and final ~= expectFinal then failures[#failures + 1] = label .. ': ended on ' .. tostring(final) .. ', wanted ' .. expectFinal end
  end
  local runs = 0
  for _, initial in ipairs({'convai', 'mistral', 'custom', 'local'}) do
    for _, pack in ipairs({true, false}) do
      for _, key in ipairs({true, false}) do
        for _, ready in ipairs({true, false}) do
          bridge(initial, key, pack); custom(ready)
          local cloudVoice = key and 'voxtral' or 'pocket'
          assert(manager.applySettings(player, {matureContent = false, conversationProvider = initial, useOwnConvaiKey = false, voiceProvider = cloudVoice, vVoice = true, vVoiceEngine = cloudVoice}))
          toProvider(); frames(4)
          local label = initial .. ' pack ' .. tostring(pack) .. ' key ' .. tostring(key) .. ' custom ' .. tostring(ready)
          -- Turn Mature content on and press Apply.
          local before = #fileWrites
          local want = initial == 'local' and 'local' or initial == 'custom' and 'custom' or pack and 'local' or ready and 'custom' or initial
          mcm.set('Mature content', true)
          mcm.apply(); frames(8)
          check(label .. ' on', before, initial, want)
          local on = saved.matureContent == true
          assert(on == (want == 'local' or want == 'custom'), label .. ' Mature content ' .. tostring(on))
          if on then assert(saved.voiceProvider == 'pocket' and saved.vVoiceEngine == 'pocket', label .. ': voices ' .. tostring(saved.voiceProvider) .. ' ' .. tostring(saved.vVoiceEngine)) end
          if on and key then assert(saved.matureRestore.voice.before.provider == 'voxtral' and saved.matureRestore.vVoiceEngine.before == 'voxtral', label .. ': the way back names Voxtral') end
          mcm.revert(); frames(4)
          -- And off again.
          before = #fileWrites
          bridge(saved.conversationProvider, key, pack); frames(8)
          toProvider()
          mcm.set('Mature content', false)
          mcm.apply(); frames(8)
          check(label .. ' off', before, want, initial)
          assert(saved.matureContent == false, label .. ' could not be turned off')
          mcm.revert(); frames(4)
          runs = runs + 1
        end
      end
    end
  end
  assert(#failures == 0, runs .. ' runs: ' .. table.concat(failures, ' | '))
  assert(runs == 32)
`));

test('the live-test settings (Mistral, a key, the Local AI pack, Voxtral voices): turning Mature content on and pressing Apply is one save with Local AI and Pocket, never Convai; Mistral is not selected and Voxtral is not used', () => run(`${harness()}
  mcm.openScreen(); frames(2)
  bridge('mistral', true, true); custom(false)
  assert(manager.applySettings(player, {conversationProvider = 'mistral', voiceProvider = 'voxtral', vVoice = true, vVoiceEngine = 'pocket'}))
  press('Settings'); press('AI provider'); frames(12)
  local before = #fileWrites
  assert(mcm.set('Mature content', true))
  local ok, why = mcm.apply()
  assert(ok, tostring(why))
  frames(10)
  local writes = 0
  for index = before + 1, #fileWrites do
    if fileWrites[index].path == 'runtime/settings.json.tmp' then
      writes = writes + 1
      local value = jsonFixtures[fileWrites[index].value]
      assert(value.conversationProvider == 'local' and value.matureContent == true and value.voiceProvider == 'pocket', tostring(value.conversationProvider))
    end
  end
  assert(writes == 1, 'one save: ' .. writes)
  assert(saved.matureRestore.conversationProvider.before == 'mistral' and saved.matureRestore.voice.before.provider == 'voxtral')
  assert(mcm.status():find('Local AI', 1, true) and mcm.status():find('Pocket', 1, true), mcm.status())
  -- Voxtral entries are greyed out with the Mature reason (MCM's own choice states), and come back when it is turned off.
  local function states(id)
    local choices = mcm.config().choices and mcm.config().choices[id]
    return choices and choices.states
  end
  frames(4)
  -- The voice rows are on the Voice AI and microphone page: MCM only knows the page on screen.
  press('Back to settings'); press('Voice AI and microphone'); frames(4)
  local companions = states('voiceProvider')
  assert(companions, 'MCM was given choice states for the companion voices')
  local greyed = {}
  for index, state in pairs(companions) do if state.enabled == false then greyed[#greyed + 1] = index .. ':' .. tostring(state.reason) end end
  assert(#greyed == 1 and greyed[1]:find('Voxtral is not used with Mature content.', 1, true), table.concat(greyed, ' | '))
  local engine = states('vVoiceEngine')
  assert(engine and engine[2].enabled == false and engine[2].reason == 'Voxtral is not used with Mature content.', engine and tostring(engine[2].reason))
  assert(engine[1].enabled ~= false)
  -- MCM refuses a draft on a greyed-out entry, naming the reason.
  local drafted, refusal = mcm.set('V’s voice engine', 2)
  assert(drafted == false and tostring(refusal):find('Mature', 1, true), tostring(refusal))
  press('Back to settings'); press('AI provider'); frames(4)
  mcm.set('Mature content', false); assert(mcm.apply()); frames(8)
  press('Back to settings'); press('Voice AI and microphone'); frames(4)
  assert(saved.matureContent == false and saved.conversationProvider == 'mistral' and saved.voiceProvider == 'voxtral')
  companions = states('voiceProvider')
  for index, state in pairs(companions) do assert(state.enabled ~= false, 'entry ' .. index .. ' is enabled again') end
  engine = states('vVoiceEngine')
  assert(engine[2].enabled ~= false, 'V’s Voxtral is enabled again (the key is saved)')
`));

test('the settings poll mapping in the bridge: Mature content makes a saved Voxtral Pocket for the companions and V, off again when it is off, and a Mature turn on Local AI that fails is not handed to Mistral', () => {
  const bridge = readFileSync(new URL('./convai-bridge.mjs', import.meta.url), 'utf8');
  assert.match(bridge, /cloudBarred: \(\) => !matureAllowsCloudVoice\(matureContent\.enabled\)/, 'the voice selection is told when no cloud voice may speak');
  assert.match(bridge, /cloudUsable: matureAllowsCloudVoice\(matureContent\.enabled\)/, 'V reads as Pocket (vSettingsFor)');
  assert.match(bridge, /if \(!matureAllowsCloudVoice\(matureContent\.enabled\)\) return 'Mature content is on';/, 'and V\'s cloud line has a net');
});
