import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {run, nsuiHarness, source} from './manager-fixture.mjs';

// The Companion Manager as a tab of Native Settings UI: the real host (mod/nsui.lua over mod/manager-ui.lua and mod/nsui-entry.lua) over a
// fake nativeSettings (bridge/nsui-fake.mjs) that keeps NSUI's own data rules and checks, at any moment, that the widgets on screen are
// what its data says (ns.verify()). The page logic itself (rows, rules, validation) is tested in manager.test.mjs.
const everything = {
  'service-status.lua': source('service-status.lua'), 'character-editor.lua': source('character-editor.lua'),
  'convai-paid-tier.lua': source('convai-paid-tier.lua'), 'support-report.lua': source('support-report.lua'),
  'setup-check.lua': source('setup-check.lua'), 'custom-provider.lua': source('custom-provider.lua'),
};
const harness = (options = {}) => nsuiHarness({modules: everything, ...options}) + `
  convaiNotices.configure(function() return manager.developerMode() end)
  local clock = 1000
  os.clock = function() return clock end
  local timeBase = os.time()
  os.time = function() return timeBase + math.floor(clock - 1000) end
  -- Frames of the game's update: the host does its work from them (never inside a callback of Native Settings UI).
  local function frames(count, step)
    for _ = 1, count or 6 do clock = clock + (step or 0.1); managerUi.update(player, true) end
    loaded = registered.loadMod('manager')
  end
  local function press(label)
    ns.interact.press(assert(ns.find(label), 'no row: ' .. label)); frames(3); ns.verify()
  end
  local function dense(tab)
    local count, highest = 0, 0
    for key in pairs(tab.keys) do count = count + 1; if key > highest then highest = key end end
    return count == highest
  end
  local function shownOutline() return table.concat(ns.outline(), ' | ') end
  -- Settings is a list of category pages: this opens one of them from Home.
  local function settingsPage(name) press('Settings'); press(name) end
  frames(3)
`;

test('every page builds on the tab and the tab always starts with the way back, in the order Native Settings UI keeps', () => run(`${harness()}
  ns.verify()
  assert(ns.data[TAB].label == 'AI Companions', 'one tab, named for the mod')
  local function check(name, back)
    ns.verify(); assert(dense(ns.data[TAB]), name .. ': Native Settings UI would hold a hole in its section list')
    local sections = ns.sections()
    assert(#sections >= 2 and sections[1].label == 'Companion Manager', name .. ': the first section is the way back')
    assert(sections[1].options[1].label == back and sections[1].options[1].buttonText == 'Back', name .. ': Back is the first row, at the top')
    for _, section in ipairs(sections) do
      assert(#section.options > 0 and section.label ~= '', name .. ': an empty section')
      for _, option in ipairs(section.options) do assert(option.label ~= '', name .. ': a row without a label') end
    end
  end
  -- Home: the seven destinations and nothing else (the Character editor opens the browser page at once, see its own test below).
  local home = ns.sections()
  assert(#home == 1 and home[1].label == 'Companion Manager' and #home[1].options == 8)
  for index, label in ipairs({'Main characters to invite', 'Side characters to invite', 'Parties', 'Model browser', 'Relationships', 'Character editor', 'Key bindings', 'Settings'}) do
    assert(home[1].options[index].label == label and home[1].options[index].buttonText == 'Open', label)
  end
  for _, page in ipairs({{'Main characters to invite', 'Main characters to invite'}, {'Side characters to invite', 'Side characters to invite'}, {'Parties', 'Current party'}, {'Model browser', 'Installed character models'}, {'Relationships', 'Relationships'},
      {'Key bindings', 'Talk by voice'}, {'Settings', 'Settings'}}) do
    press(page[1])
    check(page[1], 'Back to Companion Manager')
    -- The two character lists have the Search characters section between Back and the list.
    local at = (page[1] == 'Main characters to invite' or page[1] == 'Side characters to invite') and 3 or 2
    assert(ns.sections()[at].label == page[2], page[1] .. ': ' .. ns.sections()[at].label)
    press('Back to Companion Manager')
    assert(#ns.sections() == 1 and ns.sections()[1].options[1].label == 'Main characters to invite', 'back on Home')
  end
  -- Settings is a list of category pages, each with its Back to settings at the top, and no row of any category sits on the list itself.
  press('Settings')
  assert(not ns.find('Memory') and not ns.find('Subtitles') and not ns.find('Conversation provider'), 'the list holds the Open rows only')
  for _, page in ipairs({'AI provider', 'Voice AI and microphone', 'Conversations', 'Companions', 'Night City', 'Interface', 'Privacy and help'}) do
    press(page)
    check(page, 'Back to settings')
    assert(ns.sections()[2].label == page, page .. ': ' .. ns.sections()[2].label)
    press('Back to settings')
    assert(ns.sections()[2].label == 'Settings', 'back on the Settings list after ' .. page)
  end
  -- The pages that open from a row of a category page go back to that page (not to the list), each with its Back at the top.
  for _, case in ipairs({{'AI provider', {'Convai paid tier', 'Custom endpoint'}}, {'Conversations', {'Memory', 'Romantic relationships', 'Dynamic info'}},
      {'Companions', {'Immersive invitations', 'Housemates'}}, {'Privacy and help', {'Help and support'}}}) do
    press(case[1])
    for _, page in ipairs(case[2]) do
      press(page)
      check(page, 'Back to settings')
      press('Back to settings')
      assert(ns.sections()[2].label == case[1], 'back on ' .. case[1] .. ' after ' .. page .. ', not on ' .. ns.sections()[2].label)
    end
    press('Back to settings')
  end
  -- Relationships is a button in Conversations (a page of its own, with one row per character), the Memory character list is part of
  -- the Memory page.
  press('Conversations')
  local labels = {}
  for _, section in ipairs(ns.sections()) do labels[#labels + 1] = section.label end
  assert(table.concat(labels, ','):find('Conversations', 1, true) and not table.concat(labels, ','):find('Romantic relationships', 1, true),
    table.concat(labels, ','))
  press('Romantic relationships')
  assert(ns.sections()[2].label == 'Romantic relationships' and ns.find('Judy Alvarez') and not ns.find('Memory'))
  press('Back to settings')
  press('Memory')
  assert(ns.sections()[3].label == 'Whose memories' and ns.find('Selected character'))
`));

test('a long list is one page of rows: the page slider turns it, only the rows below it are replaced, and no page holds more than twelve rows', () => run(`${harness()}
  press('Main characters to invite')
  local slider = assert(ns.find('Page'), 'a list of 22 characters has a page slider')
  assert(slider.type == 'rangeInt' and slider.min == 1 and slider.max == 2 and slider.currentValue == 1)
  local list = ns.sections()[3]
  local function invites() local count = 0; for _, option in ipairs(list.options) do if option.buttonText == 'Invite' then count = count + 1 end end; return count end
  assert(invites() == 12, 'twelve rows on a page')
  local back = ns.sections()[1].options[1]
  ns.resetCalls()
  -- The player drags the slider: nothing is rebuilt while it moves (the rows wait a moment), then the rows are replaced.
  ns.interact.slide(slider, 2)
  frames(1)
  assert(ns.callCount('removeOption') == 0 and ns.callCount('addSubcategory') == 0, 'the list is not rebuilt under the drag')
  frames(5); ns.verify()
  list = ns.sections()[3]
  assert(ns.find('Page') == slider, 'the slider is the same widget: the player is still holding it')
  assert(ns.sections()[1].options[1] == back, 'the way back is untouched')
  assert(ns.callCount('removeSubcategory') == 0, 'a page of a list does not touch the sections')
  assert(invites() == 10, 'the second page holds the rest: ' .. invites())
  assert(ns.find('Viktor Vektor') and not ns.find('Johnny Silverhand'))
  -- A repeat value does nothing; back to the first page puts the first rows back.
  ns.resetCalls(); ns.interact.slide(slider, 2); frames(6)
  assert(#ns.calls == 0, 'the same page again changes nothing')
  ns.interact.slide(slider, 1); frames(6); ns.verify()
  assert(ns.find('Johnny Silverhand') and invites() == 12)
  -- A page of rows never creates more widgets than the page: at most 12 list rows + 2 controls + 1 way back.
  local widgets = #ns.screen.children
  assert(widgets <= 1 + 1 + 1 + 1 + 1 + 2 + 12, 'widgets on screen: ' .. widgets)
  -- Going away and coming back starts on the first page of the list.
  press('Back to Companion Manager'); press('Main characters to invite')
  assert(ns.find('Page').currentValue == 1)
`));

test('Native Settings UI has no text box of its own: the character lists draw the Search section with the Search by name button only (no pointer to MCM box), and keep the page slider and the Starts with letters', () => run(`${harness()}
  press('Main characters to invite')
  assert(ns.sections()[2].label == 'Search characters' and #ns.sections()[2].options == 1, shownOutline())
  local row = ns.sections()[2].options[1]
  assert(row.label == 'Search by name' and row.buttonText == 'Search', row.label)
  assert(not ns.find('Use the Search box, top right') and not ns.find('How to search'), shownOutline())
  assert(ns.find('Page') and #ns.sections() == 3, shownOutline())
  press('Back to Companion Manager'); press('Side characters to invite')
  assert(ns.sections()[2].label == 'Search characters', shownOutline())
  -- Without a text box on screen the button says so instead of doing nothing (the fake player has no search box).
  press('Search by name')
  assert(core.feedback():find('The search box could not open.', 1, true) and not core.feedback():find('Click the Search box', 1, true), tostring(core.feedback()))
`));

test('the model browser reads the scan first, then a letter group and a page of rows; a row of a larger list is replaced alone when its state changes', () => run(`${harness()}
  press('Model browser')
  assert(ns.find('Reading installed models…') and not ns.find('Page'), 'only the status line while the models are read')
  frames(130)
  ns.verify()
  assert(ns.find('Starts with') and ns.find('Starts with').type == 'selectorString' and ns.find('Starts with').elements[1] == 'All')
  assert(ns.find('Page').max == 500, 'twelve models a page over 6000 models')
  local before = #ns.screen.children
  assert(before <= 1 + 1 + 1 + 1 + 1 + 1 + 1 + 12 + 1, 'widgets on screen: ' .. before)
  -- One row's button changes (an invite is made): that row is replaced, in its place, and gets the Add to favorites row above it (the rows
  -- below it move down one, so they are drawn again too; the rows above it stay).
  local first
  for _, option in ipairs(ns.sections()[2].options) do if option.buttonText == 'Invite' then first = option; break end end
  local label = first.label
  local others = {}
  for _, option in ipairs(ns.sections()[2].options) do others[option] = true end
  ns.interact.press(first); frames(4); ns.verify()
  local survivors = 0
  for _, option in ipairs(ns.sections()[2].options) do if others[option] then survivors = survivors + 1 end end
  local rowsAbove = 0
  for _, option in ipairs(ns.sections()[2].options) do if option.label == label then break end rowsAbove = rowsAbove + 1 end
  assert(survivors >= rowsAbove, 'the rows above the invited model\\'s were kept: ' .. survivors .. ' of ' .. rowsAbove)
  assert(#ns.screen.children <= before + 1, 'one row more at most: ' .. #ns.screen.children .. ' / ' .. before)
`));

test('the manager opens on its first page: after leaving the tab, after closing the screen and on the shortcut', () => run(`${harness()}
  settingsPage('Conversations'); press('Memory')
  assert(ns.sections()[2].label == 'Memory')
  -- Another tab is chosen (the closed callback), then ours again: the first page.
  ns.leave(); frames(3)
  assert(managerUi.inspect().view == 'home', 'leaving the tab resets the page')
  ns.openScreen(TAB); frames(3); ns.verify()
  assert(#ns.sections() == 1 and ns.sections()[1].options[1].label == 'Main characters to invite', shownOutline())
  -- The screen is closed on a sub-page and opened again by hand: the hook of the Settings screen makes the page ready before it builds.
  press('Settings')
  ns.closeScreen(); frames(3)
  ns.openScreen(TAB)
  assert(#ns.sections() == 1 and ns.sections()[1].options[1].label == 'Main characters to invite', 'ready before the widgets were built: ' .. shownOutline())
  frames(3); ns.verify()
  -- Nothing was built for the game's own Settings screen.
  press('Settings'); ns.closeScreen(); ns.fromMods = false
  local calls = #ns.calls
  ns.fire('SettingsMainGameController.OnInitialize', {nativeIdentity = 9})
  assert(#ns.calls == calls, 'the game\\'s own Settings screen is left alone')
`));

test('a change is applied for real after a moment, as one transaction; rows the rules corrected are put back in place with one line under the way back', () => run(`${harness()}
  settingsPage('Companions')
  local reactions = ns.find('Companions react')
  assert(reactions.state == true, 'Companions react is on by default')
  ns.interact.toggle(reactions)
  frames(1)
  assert(manager.snapshot(player).settings.battleReactions == true, 'nothing is saved at the moment of the click')
  frames(6)
  assert(manager.snapshot(player).settings.battleReactions == false and saved.battleReactions == false and saved.lootReactions == false and saved.battleReactionsChosen == true and saved.lootReactionsChosen == true, 'applied once the changes have settled, as both stored settings')
  assert(ns.find('Companions react') == reactions and reactions.state == false, 'the row is the same widget and shows the saved value')
  -- Subtitles Off keeps the chosen display.
  press('Back to settings'); press('Interface')
  ns.interact.select(ns.find('Subtitles'), 1); frames(8)
  assert(saved.subtitles == false and saved.subtitleStyle == 'dialogue' and ns.find('Subtitles').selectedElementIndex == 1, 'Off, the chosen display is kept')
  press('Back to settings'); press('Voice AI and microphone')
  -- Two changes close together are one transaction (one save).
  local writes = #fileWrites
  ns.interact.select(ns.find('V’s voice'), 1); ns.interact.select(ns.find('Companion voices'), 1)
  frames(8)
  assert(saved.vVoice == false and saved.vVoiceMic == false and saved.voice == false and saved.voiceProvider == 'pocket', 'Off for both rows, the chosen voice is kept')
  assert(ns.find('Companion voices').selectedElementIndex == 1 and ns.find('V’s voice').selectedElementIndex == 1 and ns.find('Voice playback') == nil)
  local settingsWrites = 0
  for index = writes + 1, #fileWrites do if fileWrites[index].path == 'runtime/settings.json' or fileWrites[index].path:find('settings', 1, true) then settingsWrites = settingsWrites + 1 end end
  assert(settingsWrites <= 2, 'one transaction (a file and its swap), not one per change: ' .. settingsWrites)
  -- A voice after Off turns the playback back on in the same save.
  ns.interact.select(ns.find('Companion voices'), 2); frames(8); ns.verify()
  assert(saved.voice == true and saved.voiceProvider == 'pocket' and ns.find('Companion voices').selectedElementIndex == 2)
  -- A refused choice goes back and says why; the other change in the same moment is kept.
  ns.interact.toggle(ns.find('Speak dialogue choices'))
  ns.interact.select(ns.find('Companion voices'), 3)   -- Voxtral without a Mistral key
  frames(8); ns.verify()
  assert(saved.voiceChoices == true, 'the change that could be made was made')
  assert(ns.find('Companion voices').selectedElementIndex == 2, 'the refused voice went back to the saved one')
  assert(managerUi.inspect().shown == 'Requires a Mistral key (add it with the Mistral preset on the Custom endpoint page)', tostring(managerUi.inspect().shown))
  assert(ns.sections()[1].options[2].label:find('Requires a Mistral key', 1, true) == 1, 'the line is under the way back')
  -- A rule that moves another row: Natural speech beside the cloud voice moves the voice, in place, with the notice.
  ns.interact.select(ns.find('Companion voices'), 8)   -- Convai cloud voice
  frames(8); ns.verify()
  assert(saved.voiceProvider == 'convai' and ns.find('Companion voices').selectedElementIndex == 8)
  assert(ns.find('Expressive emotions') == nil and saved.expressiveEmotions == nil, 'Expressive emotions is not a setting any more')
  ns.interact.toggle(ns.find('Natural speech')); frames(8); ns.verify()
  assert(saved.naturalSpeech == true and saved.voiceProvider == 'pocket', 'Natural speech moved the voice to Pocket')
  assert(ns.find('Companion voices').selectedElementIndex == 2, 'the voice row shows it')
  assert(managerUi.inspect().shown:find('Natural speech needs a local voice', 1, true), tostring(managerUi.inspect().shown))
  assert(ns.sections()[1].options[2].label:find('Natural speech needs a local voice', 1, true) == 1)
  -- The line goes away with the next page.
  press('Back to settings')
  assert(not managerUi.inspect().shown)
`));

test('a slider is applied once, after it stops moving, and the page is not drawn again while it is held', () => run(`${harness()}
  settingsPage('Voice AI and microphone')
  local volume = ns.find('Companion voice volume (%)')
  assert(volume.type == 'rangeInt' and volume.min == 50 and volume.max == 300 and volume.step == 5)
  local vVolume = ns.find('V’s voice volume (%)')
  assert(vVolume.type == 'rangeInt' and vVolume.min == 50 and vVolume.max == 300 and vVolume.step == 5 and vVolume.currentValue == 150 and volume.currentValue == 150, "V's own slider, same range, default 150")
  ns.resetCalls()
  for _, value in ipairs({155, 160, 180, 235, 300}) do ns.interact.slide(volume, value); frames(2, 0.1) end
  assert(manager.snapshot(player).settings.voiceVolume == 150, 'nothing saved while it moves')
  frames(10)
  assert(saved.voiceVolume == 300 and saved.vVoiceVolume == 150, tostring(saved.voiceVolume) .. ' / ' .. tostring(saved.vVoiceVolume))
  assert(ns.find('Companion voice volume (%)') == volume and volume.currentValue == 300)
  assert(ns.callCount('removeOption') == 0, 'the slider was not rebuilt')
  -- V's slider is applied the same way and leaves the other one alone.
  ns.interact.slide(vVolume, 250); frames(10)
  assert(saved.vVoiceVolume == 250 and saved.voiceVolume == 300, tostring(saved.vVoiceVolume) .. ' / ' .. tostring(saved.voiceVolume))
  assert(ns.find('V’s voice volume (%)') == vVolume and vVolume.currentValue == 250 and ns.callCount('removeOption') == 0)
  -- Several quick drags in a row never wait for ever: the wait is capped.
  for value = 100, 160, 5 do ns.interact.slide(volume, value); frames(1, 0.5) end
  frames(10)
  assert(saved.voiceVolume == 160, tostring(saved.voiceVolume))
`));

test('Mature content turned on in place selects Local AI and the uncensored model, says so, and turning it off puts the rows back', () => run(`${harness()}
  local function bridge(tag, value) jsonFixtures['m-' .. tag] = value; files['runtime/mistral-state.json'] = 'm-' .. tag; clock = clock + 2; manager.snapshot(player) end
  bridge('ready', {provider = 'convai', effective = 'convai', localAi = 'ready',
    localModels = {{id = 'standard', name = 'Gemma', sizeMiB = 5000}, {id = 'mature:unc', name = 'Gemma uncensored', sizeMiB = 5200}},
    localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
  jsonFixtures['voice-state'] = {state = 'ready', provider = 'pocket', omniPack = {installed = true, missing = {}}, updated = clock * 1000}
  files['runtime/local-voice-state.json'] = 'voice-state'
  settingsPage('AI provider')
  frames(20)
  local provider, model, mature = ns.find('Conversation provider'), ns.find('Local AI model'), ns.find('Mature content')
  assert(provider and model and mature, 'the rows are there')
  assert(provider.selectedElementIndex == 1 and mature.state == false)
  ns.interact.toggle(mature); frames(8); ns.verify()
  assert(saved.matureContent == true and saved.conversationProvider == 'local' and saved.localModel == 'mature:unc')
  assert(ns.find('Conversation provider').selectedElementIndex == 4, 'the provider row shows Local AI')
  assert(ns.find('Local AI model').selectedElementIndex == 2, 'the model row shows the uncensored model')
  assert(ns.find('Mature content').state == true)
  assert(managerUi.inspect().shown:find('Local AI', 1, true), tostring(managerUi.inspect().shown))
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == false and saved.conversationProvider == 'convai' and saved.localModel == 'standard', tostring(saved.conversationProvider))
  assert(ns.find('Conversation provider').selectedElementIndex == 1 and ns.find('Local AI model').selectedElementIndex == 1)
  -- Without the Local AI pack the switch cannot stay on.
  bridge('nopack', {provider = 'convai', effective = 'convai'})
  frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent ~= true and ns.find('Mature content').state == false, 'the switch went back to off')
  assert(managerUi.inspect().shown == 'Needs Local AI or Custom.', tostring(managerUi.inspect().shown))
`));

test('Mature content turned off while the model row is on an uncensored model (no way back saved) moves the row to the standard model; a saved uncensored model with Mature off shows the default', () => run(`${harness()}
  local function bridge(tag, value) jsonFixtures['m-' .. tag] = value; files['runtime/mistral-state.json'] = 'm-' .. tag; clock = clock + 2; manager.snapshot(player) end
  bridge('ready', {provider = 'local', effective = 'local', localAi = 'ready',
    localModels = {{id = 'standard', name = 'Gemma', sizeMiB = 5000}, {id = 'mature:unc', name = 'Gemma uncensored', sizeMiB = 5200}},
    localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
  jsonFixtures['voice-state'] = {state = 'ready', provider = 'pocket', omniPack = {installed = true, missing = {}}, updated = clock * 1000}
  files['runtime/local-voice-state.json'] = 'voice-state'
  settingsPage('AI provider')
  frames(20)
  -- Both packs installed, Mature content on, the uncensored model chosen, and no earlier choice recorded (it was set by hand, or by an older version).
  assert(manager.applySettings(player, {conversationProvider = 'local', matureContent = true, localModel = 'mature:unc'}))
  frames(8)
  assert(saved.matureRestore == nil and saved.localModel == 'mature:unc')
  assert(ns.find('Local AI model').selectedElementIndex == 2, 'the row shows the uncensored model')
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == false and saved.localModel == 'standard', tostring(saved.localModel))
  assert(ns.find('Local AI model').selectedElementIndex == 1, 'the row shows the standard model')
  assert(saved.conversationProvider == 'local', 'Local AI stays')
  -- A saved uncensored model with Mature content off (the file was edited): the row shows the model that loads, the default.
  assert(manager.applySettings(player, {localModel = 'mature:unc'}))
  frames(8)
  assert(saved.matureContent == false and saved.localModel == 'mature:unc')
  assert(ns.find('Local AI model').selectedElementIndex == 1, 'the default is shown, not the uncensored model')
`));

test('Mature content beside Google Gemini or a saved legacy Mistral: turning it on selects Local AI and says so (never Mistral), choosing Google Gemini or Convai turns it off; beside Custom it is just turned on, and a Voxtral voice moves to Pocket in the same save', () => run(`${harness()}
  local function bridge(tag, value) jsonFixtures['m-' .. tag] = value; files['runtime/mistral-state.json'] = 'm-' .. tag; clock = clock + 2; manager.snapshot(player) end
  bridge('ready', {provider = 'mistral', effective = 'mistral', localAi = 'ready', saved = true,
    localModels = {{id = 'standard', name = 'Gemma', sizeMiB = 5000}, {id = 'mature:unc', name = 'Gemma uncensored', sizeMiB = 5200}},
    localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
  jsonFixtures['voice-state'] = {state = 'ready', provider = 'pocket', omniPack = {installed = true, missing = {}}, updated = clock * 1000}
  files['runtime/local-voice-state.json'] = 'voice-state'
  settingsPage('AI provider')
  frames(20)
  -- A saved legacy Mistral (shown as the third entry): Mature content cannot be on beside it, so turning it on selects Local AI and the uncensored model, and names them.
  assert(manager.applySettings(player, {conversationProvider = 'mistral'}))
  frames(8)
  local mature = ns.find('Mature content')
  assert(ns.find('Conversation provider').selectedElementIndex == 3 and ns.find('Conversation provider').elements[3] == 'Mistral (your key)' and mature.state == false)
  ns.interact.toggle(mature); frames(8); ns.verify()
  assert(saved.matureContent == true and saved.conversationProvider == 'local' and saved.localModel == 'mature:unc', tostring(saved.conversationProvider))
  assert(saved.matureRestore.conversationProvider.before == 'mistral' and saved.matureRestore.conversationProvider.set == 'local')
  assert(ns.find('Conversation provider').selectedElementIndex == 4 and ns.find('Mature content').state == true)
  assert(managerUi.inspect().shown == 'Also changed: Local AI, Uncensored model.', tostring(managerUi.inspect().shown))
  -- Choosing the third entry (Google Gemini now, Mistral has left the list) while it is on turns it off (and the rest stays as the player chose it).
  ns.interact.select(ns.find('Conversation provider'), 3); frames(8); ns.verify()
  assert(saved.conversationProvider == 'gemini' and saved.matureContent == false, 'Google Gemini turns it off')
  assert(ns.find('Mature content').state == false and ns.find('Conversation provider').elements[3] == 'Google Gemini (free plan)')
  -- Custom: it is just turned on; switching from Local AI to Custom keeps it on; Convai turns it off.
  assert(manager.applySettings(player, {conversationProvider = 'custom'}))
  frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == true and saved.conversationProvider == 'custom' and saved.localModel ~= 'mature:unc', 'Custom stays, the model is the player\\'s')
  assert(saved.matureRestore == nil, 'nothing was changed, so there is no way back to keep')
  ns.interact.select(ns.find('Conversation provider'), 4); frames(8); ns.verify()
  assert(saved.conversationProvider == 'local' and saved.matureContent == true, 'Local AI keeps Mature content on')
  ns.interact.select(ns.find('Conversation provider'), 1); frames(8); ns.verify()
  assert(saved.conversationProvider == 'convai' and saved.matureContent == false, 'Convai turns it off')
  -- Beside Custom with the companions and V on Voxtral, turning it on moves both to Pocket (named), and turning it off puts them back.
  assert(manager.applySettings(player, {conversationProvider = 'custom', voiceProvider = 'voxtral', vVoiceEngine = 'voxtral', naturalSpeech = false}))
  frames(8)
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == true and saved.conversationProvider == 'custom' and saved.voiceProvider == 'pocket' and saved.vVoiceEngine == 'pocket', tostring(saved.voiceProvider))
  assert(managerUi.inspect().shown == 'Also changed: Pocket · Performance, V’s voice engine.', tostring(managerUi.inspect().shown))
  press('Back to settings'); press('Voice AI and microphone')
  assert(ns.find('Companion voices').selectedElementIndex == 2 and ns.find('V’s voice engine').selectedElementIndex == 1)
  press('Back to settings'); press('AI provider')
  ns.interact.toggle(ns.find('Mature content')); frames(8); ns.verify()
  assert(saved.matureContent == false and saved.voiceProvider == 'voxtral' and saved.vVoiceEngine == 'voxtral', tostring(saved.voiceProvider))
  press('Back to settings'); press('Voice AI and microphone')
  assert(ns.find('Companion voices').selectedElementIndex == 3 and ns.find('V’s voice engine').selectedElementIndex == 2)
`));

test('with Mature content on the Voxtral entries say so in their labels and a click on one is refused in place (Native Settings UI has no greyed-out entries), the rows go back to what is saved', () => run(`${harness()}
  local function bridge(tag, value) jsonFixtures['m-' .. tag] = value; files['runtime/mistral-state.json'] = 'm-' .. tag; clock = clock + 2; manager.snapshot(player) end
  bridge('ready', {provider = 'local', effective = 'local', localAi = 'ready', saved = true,
    localModels = {{id = 'standard', name = 'Gemma', sizeMiB = 5000}, {id = 'mature:unc', name = 'Gemma uncensored', sizeMiB = 5200}},
    localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
  settingsPage('Voice AI and microphone')
  frames(20)
  assert(manager.applySettings(player, {conversationProvider = 'local', matureContent = true}))
  frames(8)
  local companions, engine = ns.find('Companion voices'), ns.find('V’s voice engine')
  local voxtral
  for index, label in ipairs(companions.elements) do if label:find('Voxtral', 1, true) then voxtral = index end end
  assert(companions.elements[voxtral] == 'Voxtral · not with Mature' and engine.elements[2] == 'Voxtral · not with Mature', tostring(companions.elements[voxtral]))
  ns.interact.select(companions, voxtral); frames(8); ns.verify()
  assert(saved.voiceProvider == 'pocket' and ns.find('Companion voices').selectedElementIndex == 2, 'refused, the row shows the saved voice')
  assert(managerUi.inspect().shown == 'Voxtral is not used with Mature content.', tostring(managerUi.inspect().shown))
  ns.interact.select(ns.find('V’s voice engine'), 2); frames(8); ns.verify()
  assert(saved.vVoiceEngine == 'pocket' and ns.find('V’s voice engine').selectedElementIndex == 1)
  assert(managerUi.inspect().shown == 'Voxtral is not used with Mature content.', tostring(managerUi.inspect().shown))
`));


test('Restore defaults goes through the same validated path, on Settings and every category page, and only there', () => run(`${harness()}
  -- On a page that has none (Home) it says where it works and changes nothing.
  ns.interact.restoreDefaults(); frames(4)
  assert(managerUi.inspect().shown == 'Open Settings to restore its defaults.', tostring(managerUi.inspect().shown))
  assert(manager.applySettings(player, {battleReactions = false, lootReactions = false, subtitleStyle = 'overhead', voiceVolume = 200, vVoiceVolume = 80, voiceProvider = 'convai',
    naturalSpeech = false, reputation = false}))
  frames(20)
  settingsPage('Voice AI and microphone')
  assert(ns.find('Companion voice volume (%)').currentValue == 200 and ns.find('V’s voice volume (%)').currentValue == 80)
  ns.interact.interact = nil
  ns.interact.restoreDefaults(); frames(8); ns.verify()
  local settings = manager.snapshot(player).settings
  assert(settings.lootReactions == true and settings.subtitleStyle == 'dialogue' and settings.voiceVolume == 150 and settings.vVoiceVolume == 150 and settings.battleReactions == true and settings.reputation == true,
    'the rows of every page, from the Voice page')
  assert(settings.voiceProvider == 'pocket', 'the voice default, applied through the same rules')
  assert(ns.find('Companion voice volume (%)').currentValue == 150 and ns.find('V’s voice volume (%)').currentValue == 150 and ns.find('Companion voices').selectedElementIndex == 2)
  assert(managerUi.inspect().shown == 'Defaults restored.', tostring(managerUi.inspect().shown))
  press('Back to settings'); press('Companions')
  assert(ns.find('Companions react').state == true and ns.find('Battle reactions') == nil)
  press('Back to settings'); press('Interface')
  assert(ns.find('Subtitles').selectedElementIndex == 2)
  -- Restore defaults after the cloud voice was chosen puts the default voice back, from the Settings list too.
  assert(manager.applySettings(player, {voiceProvider = 'convai'}))
  frames(4)
  press('Back to settings')
  ns.interact.restoreDefaults(); frames(8)
  assert(manager.snapshot(player).settings.voiceProvider == 'pocket')
  -- The Relationships page is part of Settings: its rows go back to Auto too.
  assert(manager.applySettings(player, {relationshipModes = {['judy-alvarez'] = 'on'}}))
  press('Conversations'); press('Romantic relationships'); frames(4)
  assert(ns.find('Judy Alvarez').selectedElementIndex == 2)
  ns.interact.restoreDefaults(); frames(8); ns.verify()
  assert(manager.snapshot(player).settings.relationshipModes['judy-alvarez'] == 'auto')
  assert(ns.find('Judy Alvarez').selectedElementIndex == 1)
`));

test('Dynamic info is a page of its own on the Native Settings UI tab: twelve switches in each of two sets (in person, phone calls and texts), applied and saved like any setting, and Restore defaults puts them back on', () => run(`${harness()}
  settingsPage('Conversations')
  local open = assert(ns.find('Dynamic info'), 'no Dynamic info button on Conversations')
  assert(open.type == 'button' and open.buttonText == 'Open')
  assert(not ns.find('Location'), 'the switches are on their own page')
  press('Dynamic info')
  assert(managerUi.inspect().view == 'dynamic-info')
  for _, name in ipairs({'Location', 'Time and weather', 'Company and vehicle', 'Health, heat and fights', 'V’s money', 'V’s gear and clothes',
      'V’s gender and lifepath', 'Quest and journal', 'Recent game dialogue', 'Time since last talk', 'Music and TV', 'Other mods’ state'}) do
    local switch = assert(ns.find(name), 'no switch ' .. name)
    assert(switch.type == 'switch' and switch.state == (name ~= 'Other mods’ state'), name .. ' is on by default, except Other mods’ state')
  end
  assert(ns.find('Back to settings'))
  -- The same twelve switches again under the second heading: the phone set (the first match of a name is the in-person one).
  local function inSet(set, name)
    for _, section in ipairs(ns.sections()) do
      if section.label == set then for _, option in pairs(section.options) do if option.label == name then return option end end end
    end
  end
  for _, name in ipairs({'Location', 'Time and weather', 'Company and vehicle', 'Health, heat and fights', 'V’s money', 'V’s gear and clothes',
      'V’s gender and lifepath', 'Quest and journal', 'Recent game dialogue', 'Time since last talk', 'Music and TV', 'Other mods’ state'}) do
    local person, phone = assert(inSet('In person', name), 'no in person ' .. name), assert(inSet('Phone calls and texts', name), 'no phone ' .. name)
    assert(person.type == 'switch' and phone.type == 'switch' and person.state == phone.state, name .. ' starts the same in both sets')
  end
  -- A change is applied for real, as one saved transaction.
  ns.interact.toggle(inSet('Phone calls and texts', 'Time and weather')); frames(8); ns.verify()
  assert(manager.snapshot(player).settings.dynamicInfoPhone.time == false and manager.snapshot(player).settings.dynamicInfo.time == true)
  assert(saved.dynamicInfoPhone.time == false and saved.dynamicInfo.time == true, 'the phone set is saved beside the in-person one')
  assert(manager.dynamicInfo('time') == true and convaiDynamicInfo.time == true, 'still read: the in-person set wants it')
  ns.interact.toggle(ns.find('Location')); frames(8); ns.verify()
  ns.interact.toggle(ns.find('V’s gear and clothes')); frames(8); ns.verify()
  local info = manager.snapshot(player).settings.dynamicInfo
  assert(info.location == false and info.gear == false and info.time == true and info.quest == true)
  assert(saved.dynamicInfo.location == false and saved.dynamicInfo.gear == false and saved.dynamicInfo.money == true, 'saved in settings.json')
  assert(manager.dynamicInfoSet('location', false) == false and manager.dynamicInfoSet('time', false) == true, 'the in-person switches')
  assert(manager.dynamicInfo('location') == true and convaiDynamicInfo.location == true and convaiDynamicInfo.gear == true, 'the phone set still wants them: the game is still read')
  assert(ns.find('Location').state == false and ns.find('Time and weather').state == true)
  -- Restore defaults works on this page, and the page does not need Settings to be open.
  ns.interact.restoreDefaults(); frames(8); ns.verify()
  info = manager.snapshot(player).settings.dynamicInfo
  for _, kind in ipairs(manager.dynamicInfoKinds()) do assert(info[kind] == (kind ~= 'mods'), kind) end
  assert(ns.find('Location').state == true and ns.find('Other mods’ state').state == false and managerUi.inspect().shown == 'Defaults restored.')
  assert(convaiDynamicInfo.location == true and saved.dynamicInfo.location == true)
  assert(inSet('Phone calls and texts', 'Time and weather').state == true and saved.dynamicInfoPhone.time == true, 'Restore defaults puts the phone set back too')
  press('Back to settings')
  assert(managerUi.inspect().view == 'settings-conversations')
`));

test('without Native Settings UI the shortcut says so; a copy that loads later is found and registered', () => run(`${harness({nsui: false, screen: false})}
  local popups = {}
  function player:ConvaiPhoneFeedback(message) popups[#popups + 1] = message end
  assert(ns.data[TAB] == nil, 'no tab without Native Settings UI')
  local ok, reason = managerUi.open()
  assert(ok == false and reason == 'The Companion Manager needs Mod Configuration Menu 0.10.5 or newer, or Native Settings UI', tostring(reason))
  assert(#popups == 1 and popups[1] == 'The Companion Manager needs Mod Configuration Menu 0.10.5 or newer, or Native Settings UI', tostring(popups[1]))
  -- Per frame it does nothing but look once a second.
  local looks = 0
  local original = GetMod
  GetMod = function(name) looks = looks + 1; return original(name) end
  frames(20, 0.05)
  assert(looks <= 3, 'the look for Native Settings UI is once a second: ' .. looks)
  -- Native Settings UI appears (it loaded after this mod): the tab is registered at the next look.
  GetMod = nsGetMod
  frames(15, 0.1)
  assert(ns.data[TAB] and #ns.sections(TAB) == 1, 'registered when it appeared')
  ns.openScreen(TAB); frames(3); ns.verify()
  assert(ns.find('Main characters to invite'))
`));

test('add-on settings are rows of the Content packs page, staged and committed with the main settings', () => run(`${harness()}
  local committed = {}
  convaiAddons = {live = true, staged = {}, values = {remarkGap = 2, markLines = true}}
  function convaiAddons.settingsSections()
    return {{id = 'addon-skippy', title = 'Skippy', description = '', items = {
      {rowId = 'addon:skippy:remarkGap', label = 'Time between remarks', kind = 'select', elements = {'10 s', '20 s', '30 s'}, value = convaiAddons.values.remarkGap,
        default = 2, description = 'The shortest quiet time between two remarks.'},
      {rowId = 'addon:skippy:markLines', label = 'Mark our lines in the subtitles', kind = 'bool', value = convaiAddons.values.markLines, default = true,
        description = 'Adds (AI) after the name.'}}}}
  end
  function convaiAddons.stageSetting(id, value) convaiAddons.staged[#convaiAddons.staged + 1] = {id = id, value = value}; return true end
  function convaiAddons.discardSettings() convaiAddons.staged = {} end
  function convaiAddons.commitSettings()
    for _, change in ipairs(convaiAddons.staged) do
      committed[#committed + 1] = change.id .. '=' .. tostring(change.value)
      if change.id:find('remarkGap') then convaiAddons.values.remarkGap = change.value else convaiAddons.values.markLines = change.value end
    end
    convaiAddons.staged = {}
    return true
  end
  function convaiAddons.signature() return tostring(convaiAddons.values.remarkGap) .. tostring(convaiAddons.values.markLines) end
  press('Settings'); frames(4)
  assert(ns.find('Content packs') and ns.find('Content packs').buttonText == 'Open', 'with an add-on that has settings the list has a Content packs page')
  assert(not ns.find('Time between remarks'), 'the add-on rows are not on the list')
  press('Content packs'); frames(4)
  local labels = {}
  for _, section in ipairs(ns.sections()) do labels[#labels + 1] = section.label end
  assert(table.concat(labels, ','):find('Skippy', 1, true), 'the add-on has its section: ' .. table.concat(labels, ','))
  local gap, marks = ns.find('Time between remarks'), ns.find('Mark our lines in the subtitles')
  assert(gap.type == 'selectorString' and gap.selectedElementIndex == 2 and marks.type == 'switch' and marks.state == true)
  -- An add-on change alone is saved by the add-on.
  ns.interact.select(gap, 3); frames(8); ns.verify()
  assert(table.concat(committed, ',') == 'addon:skippy:remarkGap=3', table.concat(committed, ','))
  assert(ns.find('Time between remarks').selectedElementIndex == 3)
  -- The add-on rows and the main rows sit on different pages, so a batch of both comes from Restore defaults or from another host: the add-on change is
  -- committed after the main settings were saved.
  committed = {}
  local result = core.apply({{id = 'addon:skippy:remarkGap', value = 1}, {id = 'subtitleStyle', value = 1}})
  assert(result.ok, tostring(result.error))
  assert(saved.subtitles == false and table.concat(committed, ',') == 'addon:skippy:remarkGap=1', table.concat(committed, ','))
  -- A refused main change drops the add-on's staged change with it (nothing is half saved).
  committed = {}
  convaiAddons.staged = {}
  local refused = core.apply({{id = 'addon:skippy:markLines', value = false}, {id = 'voiceProvider', value = 3}})   -- Voxtral without a Mistral key
  assert(not refused.ok, 'the batch is refused')
  assert(#committed == 0 and #convaiAddons.staged == 0, 'nothing of the add-on was kept: ' .. table.concat(committed, ','))
`));

test('nothing runs while the Mods screen is closed: no calls into Native Settings UI, no page build, no reads of the page state', () => run(`${harness()}
  press('Settings'); frames(4)
  ns.closeScreen(); frames(3)
  local builds, ticks = 0, 0
  local model, tick = core.model, core.tick
  core.model = function(...) builds = builds + 1; return model(...) end
  core.tick = function(...) ticks = ticks + 1; return tick(...) end
  ns.resetCalls()
  -- Only the game's own frames: the test's helper would build the page itself.
  local function idle(count, step) for _ = 1, count do clock = clock + step; managerUi.update(player, true) end end
  idle(200, 0.05)
  assert(builds == 0 and ticks == 0, 'the page was built or read while closed: ' .. builds .. ' ' .. ticks)
  assert(#ns.calls == 0, 'a call into Native Settings UI while closed: ' .. #ns.calls)
  -- A change in the game while closed (a copy joins) does not draw the page either.
  api.spawn('johnny-silverhand'); members[1].state = 'ready'
  idle(40, 0.05)
  assert(builds == 0 and #ns.calls == 0, 'the closed page followed the game')
  -- Opened again, it shows the party as it is now.
  ns.openScreen(TAB); frames(3)
  press('Parties')
  assert(ns.find('Johnny Silverhand #1') or ns.find('Johnny Silverhand'), shownOutline())
`));

test('the tab keeps what is on screen current: a state that changes is drawn, a state that does not change is not', () => run(`${harness()}
  press('Parties')
  assert(ns.find('Your party is empty'))
  ns.resetCalls()
  frames(40, 0.1)
  assert(#ns.calls == 0, 'an unchanged page was drawn again: ' .. #ns.calls)
  api.spawn('johnny-silverhand'); members[1].state = 'ready'
  frames(30, 0.1); ns.verify()
  assert(ns.find('Johnny Silverhand #1') or ns.find('Johnny Silverhand'), shownOutline())
  assert(not ns.find('Your party is empty'))
  -- Only the row that changed is replaced (the way back is not).
  local back = ns.sections()[1].options[1]
  assert(ns.sections()[1].options[1] == back)
  ns.resetCalls()
  -- A dismissal removes its row at once, and the empty line comes back.
  local row
  for _, option in ipairs(ns.sections()[2].options) do if option.buttonText == 'Dismiss' then row = option end end
  ns.interact.press(row); frames(8); ns.verify()
  assert(ns.find('Your party is empty') and ns.sections()[1].options[1] == back)
`));

test('sections are only ever removed from the end, so Native Settings UI never holds a hole in its list', () => run(`${harness()}
  local function holes() return not dense(ns.data[TAB]) end
  for _, name in ipairs({'Settings', 'Back to Companion Manager', 'Main characters to invite', 'Back to Companion Manager', 'Parties',
      'Back to Companion Manager', 'Settings', 'Conversations', 'Memory', 'Back to settings', 'Back to settings', 'Privacy and help', 'Help and support',
      'Back to settings', 'Back to settings', 'Back to Companion Manager'}) do
    press(name)
    assert(not holes(), 'a hole after ' .. name)
  end
  for _, call in ipairs(ns.calls) do assert(call[1] ~= 'removeSubcategory' or not call[2]:find('/navigation', 1, true), 'the first section was removed') end
`));

test('a long label, button text or text line is cut to what the row can show, and the whole text leads its description; short ones are untouched', () => run(`${harness()}
  local describe = managerUi._test.describe
  local NL2 = string.char(10, 10)
  local name = 'A very long name of a character that goes on and on and on'
  local long = describe({id = 'x', type = 'action', label = name, value = 'Invite', description = 'The whole name.'})
  assert(long.label:sub(-3) == '…' and long.label ~= name, long.label)
  assert(long.desc == name .. NL2 .. 'The whole name.', long.desc)
  -- Without a description of its own the whole text is the description.
  assert(describe({id = 'x2', type = 'bool', label = name, value = true, defaultValue = true, description = ''}).desc == name)
  -- Untouched: short text, and a description that is only what the row says.
  local short = describe({id = 'y', type = 'action', label = 'Settings', value = 'Open', description = 'Opens the settings.'})
  assert(short.label == 'Settings' and short.text == 'Open' and short.desc == 'Opens the settings.')
  local note = describe({id = 'z', type = 'string', label = 'Memory service', value = 'Ready', description = 'x'})
  -- A short value is the text where the button's would be (its frame is hidden); a long one, or none, stays in the label.
  assert(note.kind == 'button' and note.text == 'Ready' and note.label == 'Memory service' and note.readonly and note.desc == 'x')
  local bare = describe({id = 'z0', type = 'string', label = 'Your party is empty', value = '', description = 'x'})
  assert(bare.text == '' and bare.label == 'Your party is empty' and bare.readonly)
  -- A text line that is too long: the whole line leads the description.
  local value = 'Shared across your saves and kept until you clear it from the manager'
  local line = describe({id = 'z2', type = 'string', label = 'Player memory', value = value, description = 'Help.'})
  assert(line.label:sub(-3) == '…' and line.desc == 'Player memory: ' .. value .. NL2 .. 'Help.', line.desc)
  -- A button text that is too long: cut to the budget, the whole text in the description.
  local text = describe({id = 'w', type = 'action', label = 'Name', value = 'A button text that is much too long', description = ''})
  assert(core.optionUnits(text.text) <= managerUi.LAYOUT.buttonUnits + 0.5, text.text)
  assert(text.desc == 'Name: A button text that is much too long', text.desc)
  local select = describe({id = 'v', type = 'select', label = 'Pick', value = 9, defaultValue = 0, description = '', elements = {'one', 'two'}})
  assert(select.value == 2 and select.default == 1, 'a position outside the list is brought into it')
  local range = describe({id = 'u', type = 'int', label = 'Volume', value = 999, defaultValue = 1, min = 50, max = 200, step = 5, description = ''})
  assert(range.value == 200 and range.default == 50)
`));

test('Mod Configuration Menu installed beside it changes nothing for the host: the tab is registered the same and no check names MCM', () => run(`${harness()}
  local base = GetMod
  GetMod = function(name)
    if name == 'ModConfigurationMenuAPI' then return {apiVersion = 2, providers = {}} end
    return base(name)
  end
  frames(5)
  settingsPage('Companions'); ns.verify()
  assert(ns.find('Companions react'), 'the page works')
  assert(convaiSetupCheck, 'the setup check is loaded')
  convaiSetupCheck.run(os.time())
  local text = table.concat(convaiSetupCheck.reportLines(), '\\n')
  assert(text:find('nsui: ok found', 1, true) and not text:lower():find('mcm', 1, true), text)
  for _, item in ipairs(convaiSetupCheck.lines()) do assert(item.state ~= 'problem' or item.id ~= 'nsui', item.id) end
`));

test('with a language that has its own font family the rows get it in batches; with a Latin language nothing is touched', () => {
  const body = fonts => `${harness()}
    local applied, restored = {}, {}
    -- Widgets: a text widget with a font family, a style, a lock; a row root with two texts; the list holds three rows.
    local function textWidget(name)
      local widget = {name = name, fontFamily = {hash = 'raj'}, style = 'Medium', locked = false, text = name}
      function widget:IsA(class) return class == 'inkText' end
      function widget:GetText() return self.text end
      function widget:GetFontStyle() return self.style end
      function widget:GetLockFontInGame() return self.locked end
      function widget:SetLockFontInGame(value) self.locked = value end
      function widget:SetFontFamily(path, style) self.fontFamily = {hash = path}; self.family = path; self.style = style end
      function widget:GetNumChildren() return 0 end
      return widget
    end
    ResRef = {ToString = function(reference) return 'base\\\\gameplay\\\\gui\\\\fonts\\\\raj\\\\raj.inkfontfamily' end}
    NameToString = function(value) return value end
    CName = {new = function(value) return value end}
    CalcSeed = function(widget) return widget.seed or tostring(widget):gsub('[^%w]', '') end
    local rows = {}
    for index = 1, 3 do
      local root = {name = 'row' .. index, children = {textWidget('label' .. index), textWidget('value' .. index)}}
      function root:IsA() return false end
      function root:GetNumChildren() return #self.children end
      function root:GetWidgetByIndex(position) return self.children[position + 1] end
      rows[index] = root
    end
    local description = textWidget('description')
    ns.settingsMainController.descriptionText = description
    ns.settingsOptionsList = {widget = {GetNumChildren = function() return #rows end, GetWidgetByIndex = function(_, position) return rows[position + 1] end}}
    ${fonts}
  `;
  run(body(`
    convaiUiLocale.configure('ru'); convaiUiLocale.update(0); assert(convaiUiLocale.current() == 'ru')
    ns.leave(); ns.openScreen(TAB)
    ns.settingsOptionsList = {widget = {GetNumChildren = function() return #rows end, GetWidgetByIndex = function(_, position) return rows[position + 1] end}}
    ns.settingsMainController.descriptionText = description
    frames(6)
    local families = 0
    for _, row in ipairs(rows) do for _, child in ipairs(row.children) do if child.family and child.family:find('russian', 1, true) then families = families + 1 end end end
    assert(families == 6 and description.family and description.family:find('russian', 1, true), 'Russian rows got the Cyrillic family: ' .. families)
    assert(rows[1].children[1].locked == true)
    -- Leaving the tab gives the description area its font back.
    ns.leave(); frames(3)
    assert(description.locked == false and description.family == 'base\\\\gameplay\\\\gui\\\\fonts\\\\raj\\\\raj.inkfontfamily', tostring(description.family))
  `));
  run(body(`
    -- English: no walk, no native call on a widget.
    ns.leave(); ns.openScreen(TAB)
    ns.settingsOptionsList = {widget = {GetNumChildren = function() error('a Latin language walked the rows') end}}
    frames(6)
    assert(description.family == nil, 'the description area was not touched')
  `));
});

test('no row on any page speaks of Inworld, a shared key or plan or calls an option recommended, with Developer mode off or on', () => run(`${harness()}
  local function everything()
    local text = {}
    for _, view in ipairs({'home', 'characters', 'party', 'models', 'settings', 'settings-provider', 'settings-voice', 'settings-conversations', 'settings-companions',
        'settings-night-city', 'settings-interface', 'settings-privacy', 'dynamic-info', 'memory', 'help', 'paid-tier', 'custom-endpoint'}) do
      core.setView(view); frames(view == 'models' and 140 or 8)
      for _, section in ipairs(ns.sections()) do
        text[#text + 1] = section.label
        for _, option in ipairs(section.options) do
          text[#text + 1] = option.label; text[#text + 1] = option.desc or ''; text[#text + 1] = option.buttonText or ''
          for _, element in ipairs(option.elements or {}) do text[#text + 1] = element end
        end
      end
    end
    return table.concat(text, string.char(10)):lower()
  end
  local off = everything()
  assert(not off:find('inworld', 1, true), 'Inworld is visible with Developer mode off')
  assert(not off:find('recommend', 1, true) and not off:find('shared key', 1, true) and not off:find('shared plan', 1, true)
    and not off:find('shared convai', 1, true), 'a banned word is on a page')
  core.setView('settings-privacy'); frames(4)
  ns.interact.toggle(ns.find('Developer mode')); frames(10)
  assert(manager.snapshot(player).settings.developerMode == true)
  local on = everything()
  assert(not on:find('inworld', 1, true), 'Inworld is visible with Developer mode on')
  assert(not on:find('recommend', 1, true) and not on:find('shared key', 1, true) and not on:find('shared plan', 1, true))
`));

// ---- The shortcut beside Mod Configuration Menu (mod/nsui-entry.lua, docs/MANAGER_UI.md "Beside MCM") -------------------------------------
// The pause menu with Mod Configuration Menu installed: NSUI's Mods item is in the list with its widget hidden, MCM's own item (data
// labelled "Mods", event OnSwitchToMCM) is the one the walk activates. The host (mod/nsui.lua) turns the walk's stop into the notice.
const mcmMenu = (options = {}) => harness({screen: false, ...options}) + `
  local popups = {}
  function player:ConvaiPhoneFeedback(message) popups[#popups + 1] = message end
  function player:IsAttached() return true end
  function player:ConvaiComposerOpen() return false end
  NameToString = function(value) return value end
  CName = {new = function(value) return value end}
  CalcSeed = function(value) return value.nativeId or value.nativeIdentity end
  local function item(label, event) return {GetData = function() return {label = label, eventName = event} end, label = label} end
  local items = {item('Save', 'OnSwitchToSaveGame'), item('Settings', 'OnSwitchToSettings'), item('Mods', 'OnSwitchToSettings'),
    item('Mods', 'OnSwitchToMCM'), item('Resume', 'OnClosePauseMenu')}
  local nsuiHidden, activated = true, {}
  local pause = {IsA = function(_, class) return class == 'PauseMenuGameController' end,
    menuListController = {Size = function() return #items end, GetItemAt = function(_, index)
      return {GetController = function() return items[index + 1] end, IsVisible = function() return not (nsuiHidden and index == 2) end}
    end},
    OnMenuItemActivated = function(_, index, target) activated[#activated + 1] = index .. ':' .. target.label end}
  local defs = {UI_System = {IsInMenu = 'isInMenu'}}
  Game = {GetPlayer = function() return player end,
    GetSystemRequestsHandler = function() return {IsPreGame = function() return false end} end,
    GetAllBlackboardDefs = function() return defs end,
    GetBlackboardSystem = function() return {Get = function() return {GetBool = function() return true end} end} end,
    GetInkSystem = function() return {GetLayers = function() return {{GetGameControllers = function() return {pause} end}} end} end}
`;

test('beside MCM the real host walks to MCM\'s item, and once MCM\'s screen is up posts the notice once, under its own id', () => run(`${mcmMenu()}
  local ok = managerUi.open()
  assert(ok == true and #activated == 0)
  frames(3)
  assert(#activated == 1 and activated[1] == '3:Mods', table.concat(activated, ','))
  assert(managerUi.inspect().entry.route == 'mcm' and #popups == 0, 'no notice before MCM\\'s screen is up')
  ns.fire('SettingsMainGameController.OnInitialize', {nativeId = 901})
  frames(2)
  assert(#popups == 1 and popups[1] == 'Open AI Companions in the Mods list.', tostring(popups[1]))
  assert(managerUi.inspect().entry.stage == 'idle' and managerUi.inspect().entry.notice == 'mcm-list')
  -- Nothing else on NSUI\\'s side was touched by the walk: the tab was not selected, no widget was built.
  assert(ns.screen == nil and ns.currentTab == '' and ns.callCount('setOption') == 0)
  -- The same notice is not repeated inside its window, and is shown again after it.
  managerUi._test.notify('mcm-list'); assert(#popups == 1)
  clock = clock + 11; managerUi._test.notify('mcm-list'); assert(#popups == 2)
  managerUi._test.notify('other'); assert(#popups == 2, 'only the one kind of notice exists')
`));

test('beside MCM with its redirect off the real host walks through NSUI\'s item to the tab and posts no notice', () => run(`${mcmMenu()}
  nsuiHidden = false
  assert(managerUi.open() == true)
  frames(3)
  assert(#activated == 1 and activated[1] == '2:Mods' and managerUi.inspect().entry.route == 'nsui', table.concat(activated, ','))
  ns.openScreen(TAB); frames(3); ns.verify()
  assert(managerUi.inspect().entry.stage == 'idle' and managerUi.inspect().entry.shown and #popups == 0)
`));

test('beside MCM the notice is in the player\'s language and a translation never loses the name of the mod', () => {
  for (const code of ['de', 'ja', 'ru']) run(`${mcmMenu({locale: code})}
    convaiUiLocale.configure('${code}'); convaiUiLocale.update(0); assert(convaiUiLocale.current() == '${code}')
    managerUi._test.notify('mcm-list')
    assert(#popups == 1 and popups[1] ~= 'Open AI Companions in the Mods list.' and popups[1]:find('AI Companions', 1, true), tostring(popups[1]))
  `);
});

// ---- The main menu (no world), read-only rows ------------------------------------------------------------------------------------------

test('at the main menu the buttons work: Settings opens, and the pages that need a save say so in a row', () => run(`${harness()}
  -- init.lua's update runs the manager with no player and no world while there is no save loaded (managerUi.update(nil, false)).
  player = nil
  local function titleFrames(count) for _ = 1, count or 6 do clock = clock + 0.1; managerUi.update(nil, false) end end
  titleFrames(4)
  local function titlePress(label) ns.interact.press(assert(ns.find(label), 'no row: ' .. label)); titleFrames(6); ns.verify() end
  -- Pages that need no save open.
  titlePress('Settings')
  assert(ns.sections()[2].label == 'Settings' and ns.find('Interface'), shownOutline())
  titlePress('Interface')
  assert(ns.sections()[2].label == 'Interface' and ns.find('Interface language'), shownOutline())
  titlePress('Back to settings')
  titlePress('Back to Companion Manager')
  assert(#ns.sections() == 1 and ns.sections()[1].options[1].label == 'Main characters to invite', shownOutline())
  -- Pages that need one say so, visibly, and their invite buttons are not offered as if they worked.
  for _, page in ipairs({'Main characters to invite', 'Parties', 'Model browser'}) do
    titlePress(page)
    local note = assert(ns.find('Characters and party'), page .. ': no row that says a save is needed')
    assert(note.type == 'button' and note.buttonText == 'Load a save first', page)
    assert(not ns.find('Your party is empty'), page .. ': an empty party is not the answer without a save')
    titlePress('Back to Companion Manager')
  end
  -- Game.GetPlayer() can still hand back an object at the main menu (seen live 2026-10-19): that is not a loaded save.
  player = {hash = 'menu-object', GetEntityID = function(self) return {hash = self.hash} end}
  titlePress('Main characters to invite')
  assert(ns.find('Characters and party'), 'a player object at the main menu is not a loaded save')
  titlePress('Back to Companion Manager')
  -- The same pages with a save loaded have no such row.
  local source = player
  player = {hash = 'player-1', open = true, queue = {}, rows = {}, GetEntityID = function(self) return {hash = self.hash} end}
  frames(4)
  press('Parties')  -- gameplay frames: init.lua passes the player once a save is loaded
  assert(not ns.find('Characters and party') and ns.find('Your party is empty'), shownOutline())
`));

test('init.lua runs the manager from the frames that have no world, so a button of the page is answered at the main menu', () => {
  const init = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const branch = init.match(/if not sessionOk or not sessionReady then([\s\S]*?)\n    end\n    if fastTravelActive/);
  assert.ok(branch, 'the branch of onUpdate for frames without a world');
  assert.match(branch[1], /pcall\(managerUi\.update, nil, false\)/);
  assert.match(branch[1], /\n        return\n?$/, 'it still returns before any gameplay work');
  assert.ok(branch[1].indexOf('managerUi.update') < branch[1].lastIndexOf('return'));
});

test('a read-only row shows its value (or its line) where a button would be, and its frame is hidden; real buttons keep theirs', () => run(`${harness()}
  local function bare(row)
    local container = row.controller:GetRootWidget():GetWidgetByPath(BuildWidgetPath({'layout', 'container'}))
    for _, state in ipairs({'offState', 'onState'}) do
      assert(container:GetWidgetByPath(BuildWidgetPath({state})).visible == false, state .. ' widget hidden whole')
      assert(container:GetWidgetByPath(BuildWidgetPath({state, 'body'})).visible == false, state .. ' body hidden')
    end
    local parts = ns.parts(row.controller)
    assert(parts.bkFill == false and parts.bkBorder == false, 'bk_fill and bk_border (the outline) hidden')
    for _, state in ipairs({'off', 'on'}) do
      assert(parts[state].button == false and parts[state].buttonBorder == false and parts[state].txtValue == false, 'frame of ' .. state .. ' body hidden')
    end
    assert(row.controller.offStateBody.node.visible == false and row.controller.onStateBody.node.visible == false, 'the state bodies are hidden through the static reference')
  end
  local function openMemory() settingsPage('Conversations'); press('Memory') end
  openMemory()
  local line = assert(ns.find('Memory service'))
  assert(line.buttonText == 'Ready' or line.buttonText == 'Unavailable', line.buttonText)
  bare(line)
  -- A real button keeps the frame NSUI draws (the offState body: NSUI hides the onState one itself).
  local button = assert(ns.find('Forget all memories'))
  local kept = ns.parts(button.controller)
  assert(kept.off.button and kept.off.buttonBorder, 'a real button keeps its frame')
  assert(kept.bkFill and kept.bkBorder, 'a real button keeps its fill and border')
  local realContainer = button.controller:GetRootWidget():GetWidgetByPath(BuildWidgetPath({'layout', 'container'}))
  assert(realContainer:GetWidgetByPath(BuildWidgetPath({'offState'})).visible and realContainer:GetWidgetByPath(BuildWidgetPath({'offState', 'body'})).visible, 'a real button keeps its states')
  assert(button.controller.offStateBody.node.visible and button.controller.onStateBody.node.visible, 'a real button keeps its bodies')
  -- A line with a long value is the label alone, still without a frame.
  bare(assert(ns.find('Player memory')))
  -- The screen is closed and opened again: the rows are made again, and the frames are hidden again.
  ns.closeScreen(); frames(3)
  ns.openScreen(TAB); frames(2)
  openMemory()
  bare(ns.find('Memory service'))
  local realAgain = ns.parts(ns.find('Forget all memories').controller)
  assert(realAgain.off.button and realAgain.bkFill and realAgain.bkBorder, 'a real button keeps its frame after a redraw')
  -- A controller whose fields or widgets do not answer is harmless; the paths alone still hide the frame.
  local fresh = ns.find('Memory service')
  fresh.controller.offStateBody = nil
  press('Back to settings'); press('Memory')
  assert(managerUi.inspect().error == '' or managerUi.inspect().error == nil, tostring(managerUi.inspect().error))
  -- No widget paths at all (the root widget does not answer): the state bodies are still hidden through the static reference.
  ns.brokenRoot = true
  press('Back to settings'); press('Memory')
  local noPaths = ns.find('Memory service')
  assert(noPaths.controller.offStateBody.node.visible == false and noPaths.controller.onStateBody.node.visible == false, 'the static fallback hides the bodies')
  assert(managerUi.inspect().error == '' or managerUi.inspect().error == nil, tostring(managerUi.inspect().error))
  press('Back to settings'); press('Memory')
  local problemLines = 0
  for _, write in ipairs(fileWrites) do
    if write.path == 'runtime/mcm.log' and write.value:find('Read-only row frame not fully hidden', 1, true) then problemLines = problemLines + 1 end
  end
  assert(problemLines == 1, 'a failure to hide is logged once, got ' .. problemLines)
  ns.brokenRoot = false
`));

// What MCM's bridge does with this tab (ModConfigurationMenuAPI bridges/native_settings/provider.lua): it mirrors the tab, keeps each
// option as a handle {option, category, index, type, fullPath}, applies with nativeSettings.setOption(option) and finds the option again
// by index, type and path (resolveLiveOption). When it cannot, it says "Native Settings UI rebuilt this setting". The tab is not on
// screen the whole time, so nothing here goes through the widgets.
const mirror = `
  local function handles()
    local list = {}
    for _, key in pairs(ns.data[TAB].keys) do
      for index, option in pairs(ns.data[TAB].subcategories[key].options) do
        list[#list + 1] = {option = option, category = key, index = index, rawType = option.type, path = option.fullPath}
      end
    end
    return list
  end
  local function resolve(handle)
    local sub = ns.data[TAB].subcategories[handle.category]
    local option = sub and sub.options[handle.index]
    if option and option.type == handle.rawType and option.fullPath == handle.path then return option end
  end
  local function stale(held)
    local count = 0
    for _, handle in ipairs(held) do if resolve(handle) ~= handle.option then count = count + 1 end end
    return count
  end
  local function go(label) ns.find(label, TAB).callback(); frames(4) end
`;

test('a change applied through the mirror (setOption on the option MCM holds) keeps every option table in place, on the page and on the pages around it', () => run(`${harness({screen: false})}
  ${mirror}
  assert(ns.currentTab == '', 'the tab is not on screen')
  go('Settings')
  go('Voice AI and microphone')
  local held = handles()
  assert(#held > 10, 'the Voice AI and microphone page is mirrored: ' .. #held)
  -- A switch, a slider and a selector, each applied the way MCM does (a draft applied through setOption, one after the other).
  local choices = ns.find('Speak dialogue choices', TAB)
  ns.setOption(choices, not choices.state); frames(8)
  assert(manager.snapshot(player).settings.voiceChoices == true, 'the change was applied')
  assert(stale(held) == 0, 'switch: handles that no longer resolve to their option: ' .. stale(held))
  ns.setOption(ns.find('Companion voice volume (%)', TAB), 135); frames(8)
  assert(saved.voiceVolume == 135 and stale(held) == 0, 'slider: ' .. stale(held))
  ns.setOption(ns.find('V’s voice', TAB), 3); frames(8)
  assert(saved.vVoice == true and saved.vVoiceMic == true and stale(held) == 0, 'selector: ' .. stale(held))
  -- A rule that moves another row (Natural speech moves the voice) and puts a line under the way back: still the same options.
  ns.setOption(ns.find('Natural speech', TAB), true); frames(8)
  assert(saved.naturalSpeech == true and saved.voiceProvider == 'pocket', 'the rule ran')
  assert(stale(held) == 0, 'rule: ' .. stale(held))
  assert(ns.find('Companion voices', TAB).selectedElementIndex == 2, 'and the row shows the corrected value')
  -- Pressing a button through the mirror works while the tab is not on screen, and the page it opens is the page MCM reads next.
  go('Back to settings')
  go('Back to Companion Manager')
  assert(#ns.sections(TAB) == 1 and ns.sections(TAB)[1].options[1].label == 'Main characters to invite')
`));

test('a row whose text changes while the tab is not on screen is updated in place (same option table, new label); on screen it is replaced as before', () => run(`${harness({screen: false, locale: 'de'})}
  ${mirror}
  go('Settings')
  go('Companions')
  local held = handles()
  local gestures = ns.find('Companions react', TAB)
  local label = gestures.label
  ns.resetCalls()
  convaiUiLocale.configure('de'); convaiUiLocale.update(0)
  managerUi._test.render(); frames(2)
  assert(ns.find('Companions react', TAB) == nil, 'the page is drawn in German now')
  assert(gestures.label ~= label, 'the same option table carries the new label: ' .. gestures.label)
  assert(stale(held) == 0, 'no handle was invalidated by the language change: ' .. stale(held))
  assert(ns.callCount('removeOption') == 0, 'nothing was removed')
  -- The same change with the tab on screen replaces the rows (their widgets show what they were spawned with).
  convaiUiLocale.configure('en'); convaiUiLocale.update(0)
  ns.openScreen(TAB); frames(6); ns.verify()
  assert(ns.find('Companions react', TAB) ~= gestures, 'on screen the row is a new widget')
`));

test('a draw of the tab never rebuilds what has not changed: a value changed from the screen leaves every option table and no call but the setter', () => run(`${harness()}
  settingsPage('Companions')
  local held = (function() local list = {} for _, section in ipairs(ns.sections()) do for _, option in ipairs(section.options) do list[#list + 1] = option end end return list end)()
  ns.resetCalls()
  ns.interact.toggle(ns.find('Companions react')); frames(8); ns.verify()
  assert(ns.callCount('removeOption') == 0 and ns.callCount('removeSubcategory') == 0 and ns.callCount('addSubcategory') == 0,
    'a value change rebuilt something: ' .. ns.callCount('removeOption'))
  local now, same = {}, 0
  for _, section in ipairs(ns.sections()) do for _, option in ipairs(section.options) do now[option] = true end end
  for _, option in ipairs(held) do if now[option] then same = same + 1 end end
  assert(same >= #held - 1, 'the options kept: ' .. same .. ' of ' .. #held)
`));

// ---------------------------------------------------------------------------------------------------- settings decisions of 2026-10-20
const customRows = ['Mistral', 'Custom endpoint URL', 'Custom API key', 'Custom model ID'];
const withoutCustomModule = Object.fromEntries(Object.entries(everything).filter(([name]) => name !== 'custom-provider.lua'));
const customState = `
  files['runtime/custom-provider-command.json'] = ''
  local function service(tag, value)
    jsonFixtures['custom-' .. tag] = value; files['runtime/custom-provider-state.json'] = 'custom-' .. tag
    clock = clock + 2; frames(4); ns.verify()
  end
  local function command() return jsonFixtures[files['runtime/custom-provider-command.json']] end
  files['runtime/gemini-provider-command.json'] = ''
  local function geminiService(tag, value)
    jsonFixtures['gemini-' .. tag] = value; files['runtime/gemini-provider-state.json'] = 'gemini-' .. tag
    clock = clock + 2; frames(4); ns.verify()
  end
  local function geminiCommand() return jsonFixtures[files['runtime/gemini-provider-command.json']] end
`;

test('Custom endpoint is a page of its own: one button on AI provider where the four rows were, Back to settings returns, and the rows send their commands through the provider', () => run(`${harness()}
  ${customState}
  settingsPage('AI provider')
  assert(ns.find('Custom endpoint').buttonText == 'Open', 'one button on AI provider')
  for _, label in ipairs({${customRows.map(label => `'${label}'`).join(', ')}}) do assert(ns.find(label) == nil, label .. ' is not on AI provider any more') end
  -- The Google Gemini key and its connection test are rows of AI provider (a second instance of the same module, on its own files). Add sends preset-gemini, a saved key shows its last four characters.
  assert(ns.find('Mistral API key') == nil and ns.find('Google Gemini (free)') == nil)
  assert(ns.find('Google Gemini API key').buttonText == 'Add' and ns.find('Test connection') == nil, 'Google Gemini has the key row only: no Test connection')
  press('Google Gemini API key'); assert(geminiCommand().action == 'preset-gemini', tostring(geminiCommand() and geminiCommand().action))
  assert(files['runtime/custom-provider-command.json'] == '', 'the Custom endpoint channel is not used')
  -- The key just added is tried once by the service: the row says so while it runs, then what Google answered, on the key row itself.
  local addId = geminiCommand().id
  local savedState = {version = 1, ready = true, host = 'generativelanguage.googleapis.com', model = 'gemini-flash-lite', keySaved = true, tail = 'wxyz', preset = 'gemini'}
  local function withCheck(check) local value = {}; for key, item in pairs(savedState) do value[key] = item end; value.check = check; return value end
  geminiService('checking', withCheck({id = addId, state = 'checking'}))
  assert(ns.find('Google Gemini API key (Checking…)'), shownOutline())
  geminiService('accepted', withCheck({id = addId, state = 'ok'}))
  assert(ns.find('Google Gemini API key (…wxyz)').desc:find('Google accepted the key.', 1, true), shownOutline())
  geminiService('refused', withCheck({id = addId, state = 'failed', code = 'key', status = 400}))
  assert(ns.find('Google Gemini API key (…wxyz)').desc:find('Google did not accept this key. Check it in Google AI Studio, then Remove it and Add the right one.', 1, true), shownOutline())
  geminiService('saved', {version = 1, ready = true, host = 'generativelanguage.googleapis.com', model = 'gemini-flash-lite', keySaved = true, tail = 'wxyz', preset = 'gemini'})
  assert(ns.find('Google Gemini API key (…wxyz)').buttonText == 'Remove', shownOutline())
  press('Google Gemini API key (…wxyz)'); assert(geminiCommand().action == 'clear-preset-gemini', tostring(geminiCommand() and geminiCommand().action))
  geminiService('removed', {version = 1, ready = false, keySaved = false})
  assert(ns.find('Google Gemini API key').buttonText == 'Add')
  press('Custom endpoint')
  assert(managerUi.inspect().view == 'custom-endpoint')
  local sections = ns.sections()
  assert(sections[1].label == 'Companion Manager' and sections[1].options[1].label == 'Back to settings' and sections[1].options[1].buttonText == 'Back')
  assert(sections[2].label == 'Custom endpoint' and #sections == 2, tostring(sections[2] and sections[2].label) .. ' ' .. #sections)
  assert(dense(ns.data[TAB]))
  local shown = {}
  for _, option in ipairs(sections[2].options) do shown[#shown + 1] = option.label end
  assert(table.concat(shown, ' | ') == 'Mistral | Custom endpoint URL | Custom API key | Custom model ID | Test connection', table.concat(shown, ' | '))
  assert(ns.find('Conversation provider') == nil and ns.find('Subtitles') == nil, 'nothing of AI provider is on the page')
  press('Mistral'); assert(command().action == 'preset-mistral', tostring(command() and command().action))
  press('Custom endpoint URL'); assert(command().action == 'paste-url', tostring(command() and command().action))
  press('Custom API key'); assert(command().action == 'paste-key')
  press('Custom model ID'); assert(command().action == 'paste-model')
  service('saved', {version = 1, updated = 1, ready = true, host = 'x.ai', secure = true, ['local'] = false, model = 'llama3.2', keySaved = true, tail = 'wxyz'})
  assert(ns.find('Custom endpoint URL (x.ai)'), shownOutline())
  assert(ns.find('Custom endpoint URL (x.ai)').buttonText == 'Remove')
  press('Test connection')
  local id = command().id
  assert(command().action == 'test')
  service('testing', {version = 1, updated = 2, ready = true, host = 'x.ai', secure = true, ['local'] = false, model = 'llama3.2', keySaved = true, tail = 'wxyz',
    test = {id = id, state = 'testing'}})
  assert(ns.find('Test connection (Testing…)'), shownOutline())
  service('failed', {version = 1, updated = 3, ready = true, host = 'x.ai', secure = true, ['local'] = false, model = 'llama3.2', keySaved = true, tail = 'wxyz',
    test = {id = id, state = 'failed', code = 'model', detail = 'model not found'}})
  assert(ns.find('Test connection (Failed)'), shownOutline())
  assert(ns.find('Test connection (Failed)').desc:find('The endpoint does not know that model ID.', 1, true))
  press('Back to settings')
  assert(ns.sections()[2].label == 'AI provider' and ns.find('Custom endpoint') and ns.find('Custom endpoint URL (x.ai)') == nil, 'back on AI provider, not on the Settings list')
  press('Custom endpoint'); press('Back to settings'); press('Back to settings'); press('Back to Companion Manager')
  assert(#ns.sections() == 1 and ns.sections()[1].options[1].label == 'Main characters to invite')
`));

test('Custom endpoint with a change just made: the change is still applied after the page is opened, and the page has no pending state of its own', () => run(`${harness()}
  settingsPage('AI provider')
  ns.interact.toggle(ns.find('Allow Local AI to use RAM'))
  press('Custom endpoint')
  frames(8); ns.verify()
  assert(managerUi.inspect().view == 'custom-endpoint', 'still on the page')
  assert(saved.localOffload == true, 'the change made on AI provider was applied')
  press('Back to settings')
  assert(ns.find('Allow Local AI to use RAM').state == true, 'and shown on AI provider')
`));

test('Custom endpoint is not offered without the provider module: no button on AI provider, the page cannot be reached', () => run(`${harness({modules: withoutCustomModule})}
  settingsPage('AI provider')
  assert(ns.find('Custom endpoint') == nil, 'no button without the module')
  assert(ns.find('Conversation provider'), 'the rest of the page is there')
  core.setView('custom-endpoint'); frames(6)
  assert(managerUi.inspect().view ~= 'custom-endpoint', 'the view falls back: ' .. tostring(managerUi.inspect().view))
`));

test('Johnny in your head is one list: Off, On, Speaks up rarely, Speaks up normally, Speaks up often; it stores both settings together, and the old rows are gone', () => run(`${harness()}
  settingsPage('Conversations')
  assert(ns.find('Johnny speaks up') == nil and ns.find('Johnny’s standing') == nil, 'the separate rows are gone')
  local row = ns.find('Johnny in your head')
  assert(row.selectedElementIndex == 1 and table.concat(row.elements, ' | ') == 'Off | On | Speaks up rarely | Speaks up normally | Speaks up often', table.concat(row.elements, ' | '))
  local function stored() return tostring(saved.johnnyInHead) .. '/' .. tostring(saved.johnnyRemarks) end
  ns.interact.select(ns.find('Johnny in your head'), 3); frames(8); ns.verify()
  assert(stored() == 'true/rare', stored())
  assert(ns.find('Johnny in your head').selectedElementIndex == 3, 'the row shows what is saved')
  ns.interact.select(ns.find('Johnny in your head'), 4); frames(8); assert(stored() == 'true/medium', stored())
  assert(ns.find('Johnny in your head').selectedElementIndex == 4)
  ns.interact.select(ns.find('Johnny in your head'), 5); frames(8); assert(stored() == 'true/normal', stored())
  assert(ns.find('Johnny in your head').selectedElementIndex == 5)
  ns.interact.select(ns.find('Johnny in your head'), 2); frames(8); assert(stored() == 'true/off', stored())
  assert(ns.find('Johnny in your head').selectedElementIndex == 2)
  ns.interact.select(ns.find('Johnny in your head'), 1); frames(8); assert(stored() == 'false/off', stored())
  assert(ns.find('Johnny in your head').selectedElementIndex == 1)
  assert(manager.applySettings(player, {johnnyInHead = true, johnnyRemarks = 'rare'}))
  frames(10)
  assert(ns.find('Johnny in your head').selectedElementIndex == 3)
`));

test('Companions speak up is one list: Off, Speaks up rarely, Speaks up normally, Speaks up often; Often by default, stored as off, rare, medium, normal', () => run(`${harness()}
  settingsPage('Conversations')
  local row = ns.find('Companions speak up')
  assert(row.selectedElementIndex == 4 and table.concat(row.elements, ' | ') == 'Off | Speaks up rarely | Speaks up normally | Speaks up often', table.concat(row.elements, ' | '))
  assert(saved.companionSpeakUp == 'normal' and saved.speakUpOftenGiven == true, tostring(saved.companionSpeakUp))
  for _, case in ipairs({{1, 'off'}, {3, 'medium'}, {4, 'normal'}, {2, 'rare'}}) do
    ns.interact.select(ns.find('Companions speak up'), case[1]); frames(8); ns.verify()
    assert(saved.companionSpeakUp == case[2] and ns.find('Companions speak up').selectedElementIndex == case[1], case[2])
  end
  assert(saved.johnnyRemarks == 'off' and saved.johnnyInHead == false, 'the Johnny list is its own')
`));

test('V’s voice is one list over typed and spoken lines and its engine is its own list: choosing Voxtral without a Mistral key is refused with the key message, with a key it is saved', () => run(`${harness()}
  settingsPage('Voice AI and microphone')
  local name = 'V’s voice engine'
  assert(ns.find('V’s voice for typed lines') == nil and ns.find('V’s voice for microphone lines') == nil, 'the old rows are gone')
  local mode = ns.find('V’s voice')
  assert(mode.selectedElementIndex == 2 and table.concat(mode.elements, ' | ') == 'Off | Typed lines | Typed and spoken lines', 'Typed lines by default: ' .. table.concat(mode.elements, ' | '))
  local row = ns.find(name)
  assert(row.selectedElementIndex == 1, 'Pocket by default')
  assert(table.concat(row.elements, ' | ') == 'Pocket · On your PC | Voxtral · needs Mistral key | OmniVoice · needs Omni voice', table.concat(row.elements, ' | '))
  ns.interact.select(ns.find(name), 3); frames(8); ns.verify()
  assert(managerUi.inspect().shown == 'Requires the Companion voices to be an OmniVoice choice', tostring(managerUi.inspect().shown))
  assert(ns.find(name).selectedElementIndex == 1 and saved.vVoiceEngine == 'pocket' and saved.vVoice == true, 'the refused OmniVoice choice went back')
  ns.interact.select(ns.find(name), 2); frames(8); ns.verify()
  assert(managerUi.inspect().shown == 'Requires a Mistral key (add it with the Mistral preset on the Custom endpoint page)', tostring(managerUi.inspect().shown))
  assert(ns.find(name).selectedElementIndex == 1 and saved.vVoiceEngine == 'pocket' and saved.vVoice == true, 'the refused choice went back')
  -- The mode row: Off, Typed lines, Typed and spoken lines write the two stored settings.
  ns.interact.select(ns.find('V’s voice'), 1); frames(8); ns.verify()
  assert(saved.vVoice == false and saved.vVoiceMic == false and saved.vVoiceEngine == 'pocket' and saved.vVoiceChosen == true, tostring(saved.vVoice))
  assert(ns.find('V’s voice').selectedElementIndex == 1)
  ns.interact.select(ns.find('V’s voice'), 3); frames(8)
  assert(saved.vVoice == true and saved.vVoiceMic == true and ns.find('V’s voice').selectedElementIndex == 3)
  ns.interact.select(ns.find('V’s voice'), 2); frames(8)
  assert(saved.vVoice == true and saved.vVoiceMic == false and ns.find('V’s voice').selectedElementIndex == 2)
  -- The Mistral key is saved: the entry has its name and is saved.
  jsonFixtures['mistral-key'] = {provider = 'convai', effective = 'convai', saved = true}
  files['runtime/mistral-state.json'] = 'mistral-key'
  clock = clock + 2; manager.snapshot(player); frames(10); ns.verify()
  assert(ns.find(name).elements[2] == 'Voxtral · Mistral cloud', ns.find(name).elements[2])
  ns.interact.select(ns.find(name), 2); frames(8); ns.verify()
  assert(saved.vVoice == true and saved.vVoiceEngine == 'voxtral' and ns.find(name).selectedElementIndex == 2)
  -- The engine never turns V on or off: with V Off the engine that was saved stays.
  ns.interact.select(ns.find('V’s voice'), 1); frames(8)
  assert(saved.vVoice == false and saved.vVoiceEngine == 'voxtral')
  ns.interact.select(ns.find(name), 1); frames(8)
  assert(saved.vVoice == false and saved.vVoiceEngine == 'pocket')
`));

test('Companions react is on by default, and Restore defaults puts Johnny to Off, V’s voice to Typed lines with Pocket and the reactions on', () => run(`${harness()}
  settingsPage('Companions')
  assert(ns.find('Companions react').state == true and ns.find('React to battles') == nil and ns.find('React to collected loot') == nil)
  ns.interact.toggle(ns.find('Companions react'))
  frames(10); ns.verify()
  assert(saved.battleReactions == false and saved.lootReactions == false and saved.battleReactionsChosen == true and saved.lootReactionsChosen == true)
  press('Back to settings'); press('Conversations')
  ns.interact.select(ns.find('Johnny in your head'), 5); ns.interact.select(ns.find('Companions speak up'), 4)
  frames(10); ns.verify()
  assert(saved.companionSpeakUp == 'normal')
  press('Back to settings'); press('Voice AI and microphone')
  ns.interact.select(ns.find('V’s voice'), 1)
  frames(10); ns.verify()
  assert(saved.johnnyInHead == true and saved.johnnyRemarks == 'normal' and saved.vVoice == false)
  ns.interact.restoreDefaults(); frames(8); ns.verify()
  local settings = manager.snapshot(player).settings
  assert(settings.battleReactions == true and settings.lootReactions == true, 'the reactions are on again')
  assert(settings.johnnyInHead == false and settings.johnnyRemarks == 'off', 'Johnny is Off')
  assert(settings.companionSpeakUp == 'normal', 'companions are back to Often')
  assert(settings.vVoice == true and settings.vVoiceMic == false and settings.vVoiceEngine == 'pocket', 'V speaks typed lines with Pocket')
  assert(ns.find('V’s voice').selectedElementIndex == 2 and ns.find('V’s voice engine').selectedElementIndex == 1)
  assert(managerUi.inspect().shown == 'Defaults restored.', tostring(managerUi.inspect().shown))
  press('Back to settings'); press('Conversations')
  assert(ns.find('Johnny in your head').selectedElementIndex == 1 and ns.find('Companions speak up').selectedElementIndex == 4)
  press('Back to settings'); press('Companions')
  assert(ns.find('Companions react').state == true)
`));

// ---------------------------------------------------------------------------------------------------- Home > Character editor (2026-10-22)
// A Home row that is an action and not a navigation: pressing it goes through the host's press queue to the same M.invoke as every
// other button, writes the one editor command, and its notice shows under the way back while Home stays on screen.
test('Native Settings UI: the Character editor row of Home writes one editor command and shows the notice, and the page stays on Home', () => run(`${harness()}
  ns.verify()
  local function commandWrites() local n = 0 for _, write in ipairs(fileWrites) do if write.path == 'runtime/editor-command.json' then n = n + 1 end end return n end
  local open = assert(ns.find('Character editor'), 'the row is on Home')
  assert(open.buttonText == 'Open' and ns.sections()[1].options[6] == open, 'the sixth row of Home, a button')
  local before = commandWrites()
  press('Character editor')
  assert(commandWrites() == before + 1, 'exactly one command, got ' .. (commandWrites() - before))
  assert(fileWrites[#fileWrites].path == 'runtime/editor-command.json')
  assert(managerUi.inspect().view == 'home' and #ns.sections() == 1, 'no sub-page: Home stays')
  assert(managerUi.inspect().shown == 'Opening the editor in your browser. Switch to your browser if it does not come to the front.' and ns.sections()[1].options[9].label:find('Opening the editor in your browser', 1, true), 'the notice shows under the way back: ' .. shownOutline())
  -- A second click is a new command (the host counts one click once, not twice).
  clock = clock + 2
  press('Character editor')
  assert(commandWrites() == before + 2)
  frames(20)
  assert(commandWrites() == before + 2, 'nothing is sent by the frames that follow')
  -- Settings still has its own row for the same request.
  settingsPage('AI provider')
  assert(ns.find('Edit characters') and not ns.find('Character editor'), 'Edit characters on AI provider, the Home row only on Home')
`));

test('Native Settings UI: with the conversation service stopped the Character editor row says so and writes nothing; without the module it is not on Home', () => {
  run(`${harness()}
    jsonSequence = jsonSequence + 1
    jsonFixtures['svc-stopped'] = {state = 'stopped', updated = os.time() * 1000.0, since = os.time() * 1000.0 - 5000}
    files['runtime/bridge-service.json'] = 'svc-stopped'
    press('Character editor')
    assert(not files['runtime/editor-command.json'], 'nothing written')
    assert(managerUi.inspect().view == 'home')
    assert(managerUi.inspect().shown == 'The conversation service is not running, so the editor cannot open. Restart the game.' and ns.sections()[1].options[9].label:find('The conversation service is not running', 1, true), shownOutline())
  `);
  const bare = Object.fromEntries(Object.entries(everything).filter(([name]) => name !== 'character-editor.lua'));
  run(`${harness({modules: bare, absent: ['character-editor.lua']})}
    assert(#ns.sections()[1].options == 7 and not ns.find('Character editor'), shownOutline())
  `);
});

// ---------------------------------------------------------------------------------------------------- Key bindings (docs/KEY_BINDINGS.md)
// The page on Native Settings UI: one section for each action (the key set here, Set and Clear), starting with the five default keys, and Restore
// defaults, which puts the five default keys back. The redscript half is a fake player here.
test('Native Settings UI: Key bindings sits between Character editor and Settings, Set waits for a key, the key shows on the page, Clear and Restore defaults take it away', () => run(`${harness()}
  local keyQueue, keyList = {}, ''
  function player:ConvaiKeyBindsReady() return true end
  function player:ConvaiKeyBindsActive() return keyList end
  function player:ConvaiKeyBindsConfigure(value) keyList = value; return true end
  function player:ConvaiKeyBindsCapture(on) return true end
  function player:ConvaiKeyBindTake() return table.remove(keyQueue, 1) or '' end
  local function key(token) keyQueue[#keyQueue + 1] = token; convaiKeyBinds.take(player); frames(4); ns.verify() end
  local function section(name) for _, s in ipairs(ns.sections()) do if s.label == name then return s end end end
  local function option(name, label)
    for _, o in ipairs(assert(section(name), 'no section ' .. name).options) do if o.label == label then return o end end
  end
  local home = ns.sections()[1].options
  assert(home[6].label == 'Character editor' and home[7].label == 'Key bindings' and home[8].label == 'Settings' and home[7].buttonText == 'Open')
  press('Key bindings')
  assert(managerUi.inspect().view == 'key-bindings')
  local names = {}
  for _, s in ipairs(ns.sections()) do names[#names + 1] = s.label end
  assert(table.concat(names, ' | ') == 'Companion Manager | Talk by voice | Talk by text | Group voice chat | Group text chat | Talk to Johnny by voice | Talk to Johnny by text | Companion Manager', table.concat(names, ' | '))
  assert(ns.find('Controller talk button') == nil and section('Controller') == nil, 'the Controller talk button is gone')
  -- The five actions start with their default key (and a Clear beside it); the two Johnny ones have none.
  local defaultKeys = {['Talk by voice'] = 'F7', ['Talk by text'] = 'F6', ['Group voice chat'] = 'F10', ['Group text chat'] = 'F8'}
  for name, keyName in pairs(defaultKeys) do
    local target = section(name)
    assert(target.options[1].label == 'Key or button' and target.options[1].buttonText == keyName, name)
    assert(#target.options == 2 and option(name, 'Clear'), 'one look: the key (no Cyber Engine Tweaks row) and Clear: ' .. name)
  end
  local sections = ns.sections()
  assert(sections[8].options[1].buttonText == 'F4' and #sections[8].options == 2, 'Companion Manager starts with F4')
  for _, index in ipairs({6, 7}) do
    assert(sections[index].options[1].buttonText == 'Not set' and #sections[index].options == 1, 'Johnny has no default key: ' .. sections[index].label)
  end
  ns.interact.press(option('Talk by voice', 'Key or button')); frames(4); ns.verify()
  assert(managerUi.inspect().shown == 'Press the key or controller button for Talk by voice. Esc or B cancels.', tostring(managerUi.inspect().shown))
  assert(option('Talk by voice', 'Key or button').buttonText == 'Cancel')
  clock = clock + 1; key('kIK_F2')
  assert(managerUi.inspect().shown == 'Talk by voice is set to F2.', tostring(managerUi.inspect().shown))
  assert(option('Talk by voice', 'Key or button').buttonText == 'F2' and option('Talk by voice', 'Clear'), 'the key shows, Clear is there')
  assert(manager.keyBindings().voice == 'IK_F2' and keyList == 'IK_F2,IK_F6,IK_F10,IK_F8,IK_F4', keyList)
  -- A controller button, Clear, and Restore defaults.
  ns.interact.press(option('Talk by text', 'Key or button')); frames(3)
  clock = clock + 1; key('kIK_Pad_RightTrigger')
  assert(option('Talk by text', 'Key or button').buttonText == 'Controller RT' and manager.keyBindings().text == 'IK_Pad_RightTrigger')
  ns.interact.press(option('Talk by voice', 'Clear')); frames(4); ns.verify()
  assert(manager.keyBindings().voice == nil and option('Talk by voice', 'Key or button').buttonText == 'Not set' and not option('Talk by voice', 'Clear'))
  assert(managerUi.inspect().shown == 'Talk by voice cleared.', tostring(managerUi.inspect().shown))
  ns.interact.restoreDefaults(); frames(10); ns.verify()
  convaiKeyBinds.tick(player, true)
  local bindings = manager.keyBindings()
  assert(bindings.voice == 'IK_F7' and bindings.text == 'IK_F6' and bindings.group_voice == 'IK_F10' and bindings.group_text == 'IK_F8' and bindings.manager == 'IK_F4', 'the five default keys are back')
  assert(keyList == 'IK_F7,IK_F6,IK_F10,IK_F8,IK_F4', 'and the listeners follow: ' .. keyList)
  assert(option('Talk by voice', 'Key or button').buttonText == 'F7' and option('Talk by text', 'Key or button').buttonText == 'F6')
  assert(managerUi.inspect().shown == 'Defaults restored.', tostring(managerUi.inspect().shown))
`));

test('V’s voice has no row of its own for microphone lines any more: one list over typed and spoken lines, with the engine shared', () => run(`${harness()}
  settingsPage('Voice AI and microphone'); frames(8)
  assert(ns.find('V’s voice for microphone lines') == nil and ns.find('V’s voice for typed lines') == nil, 'the two old rows are gone')
  local mode, engine = ns.find('V’s voice'), ns.find('V’s voice engine')
  assert(mode.type == 'selectorString' and engine.type == 'selectorString' and #mode.elements == 3 and #engine.elements == 3)
  assert(mode.selectedElementIndex == 2 and engine.selectedElementIndex == 1, 'typed lines on Pocket by default')
  -- Typed and spoken lines: the microphone lines come on, the typed ones stay on, the engine is the one shared engine.
  ns.interact.select(mode, 3); frames(8); ns.verify()
  assert(saved.vVoiceMic == true and saved.vVoice == true and saved.vVoiceEngine == 'pocket')
  assert(ns.find('V’s voice').selectedElementIndex == 3)
  -- Off: both go off together. Typed lines: typed on, microphone off.
  ns.interact.select(ns.find('V’s voice'), 1); frames(8); ns.verify()
  assert(saved.vVoiceMic == false and saved.vVoice == false and ns.find('V’s voice').selectedElementIndex == 1)
  ns.interact.select(ns.find('V’s voice'), 2); frames(8); ns.verify()
  assert(saved.vVoiceMic == false and saved.vVoice == true and ns.find('V’s voice').selectedElementIndex == 2)
  -- A file that has the microphone on and typed lines off (the old pair) shows Typed and spoken lines and keeps the engine.
  assert(manager.applySettings(player, {vVoice = false, vVoiceMic = true}))
  frames(20)
  press('Back to settings'); press('Back to Companion Manager')
  settingsPage('Voice AI and microphone')
  assert(ns.find('V’s voice').selectedElementIndex == 3 and ns.find('V’s voice engine').selectedElementIndex == 1)
`));
