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
  frames(3)
`;

test('every page builds on the tab and the tab always starts with the way back, in the order Native Settings UI keeps', () => run(`${harness()}
  ns.verify()
  assert(ns.data[TAB].label == 'AI NPC Cyberpunk Mod', 'one tab, named for the mod')
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
  -- Home: the four destinations and nothing else.
  local home = ns.sections()
  assert(#home == 1 and home[1].label == 'Companion Manager' and #home[1].options == 4)
  for index, label in ipairs({'Characters to invite', 'Current party', 'Model browser', 'Settings'}) do
    assert(home[1].options[index].label == label and home[1].options[index].buttonText == 'Open', label)
  end
  for _, page in ipairs({{'Characters to invite', 'Characters to invite'}, {'Current party', 'Current party'}, {'Model browser', 'Installed character models'},
      {'Settings', 'Interface'}}) do
    press(page[1])
    check(page[1], 'Back to Companion Manager')
    assert(ns.sections()[2].label == page[2], page[1] .. ': ' .. ns.sections()[2].label)
    press('Back to Companion Manager')
    assert(#ns.sections() == 1 and ns.sections()[1].options[1].label == 'Characters to invite', 'back on Home')
  end
  -- Settings has its sub-pages: Memory, Help and the paid tier, each with its Back to Settings at the top.
  press('Settings')
  assert(ns.find('Memory') and ns.find('Help and support') and ns.find('Convai paid tier'))
  for _, page in ipairs({'Memory', 'Help and support', 'Convai paid tier'}) do
    press(page)
    check(page, 'Back to settings')
    press('Back to settings')
    assert(ns.sections()[2].label == 'Interface', 'back on Settings after ' .. page)
  end
  -- Relationships are a section of Settings, the Memory character list is part of the Memory page.
  local labels = {}
  for _, section in ipairs(ns.sections()) do labels[#labels + 1] = section.label end
  assert(table.concat(labels, ','):find('Conversations,Relationships,Conversation provider', 1, true), table.concat(labels, ','))
  press('Memory')
  assert(ns.sections()[3].label == 'Whose memories' and ns.find('Selected character'))
`));

test('a long list is one page of rows: the page slider turns it, only the rows below it are replaced, and no page holds more than twelve rows', () => run(`${harness()}
  press('Characters to invite')
  local slider = assert(ns.find('Page'), 'a list of 22 characters has a page slider')
  assert(slider.type == 'rangeInt' and slider.min == 1 and slider.max == 2 and slider.currentValue == 1)
  local list = ns.sections()[2]
  local function invites() local count = 0; for _, option in ipairs(list.options) do if option.buttonText == 'Invite' then count = count + 1 end end; return count end
  assert(invites() == 12, 'twelve rows on a page')
  local back = ns.sections()[1].options[1]
  ns.resetCalls()
  -- The player drags the slider: nothing is rebuilt while it moves (the rows wait a moment), then the rows are replaced.
  ns.interact.slide(slider, 2)
  frames(1)
  assert(ns.callCount('removeOption') == 0 and ns.callCount('addSubcategory') == 0, 'the list is not rebuilt under the drag')
  frames(5); ns.verify()
  list = ns.sections()[2]
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
  assert(widgets <= 1 + 1 + 1 + 1 + 2 + 12, 'widgets on screen: ' .. widgets)
  -- Going away and coming back starts on the first page of the list.
  press('Back to Companion Manager'); press('Characters to invite')
  assert(ns.find('Page').currentValue == 1)
`));

test('the model browser reads the scan first, then a letter group and a page of rows; a row of a larger list is replaced alone when its state changes', () => run(`${harness()}
  press('Model browser')
  assert(ns.find('Reading installed models…') and not ns.find('Page'), 'only the status line while the models are read')
  frames(130)
  ns.verify()
  assert(ns.find('Starts with') and ns.find('Starts with').type == 'selectorString' and ns.find('Starts with').elements[1] == 'All')
  assert(ns.find('Page').max == 500, 'twelve models a page over 6000 models')
  local before = #ns.screen.children
  assert(before <= 1 + 1 + 1 + 1 + 1 + 1 + 12 + 1, 'widgets on screen: ' .. before)
  -- One row's button changes (an invite is made): only that row is replaced, in its place.
  local first
  for _, option in ipairs(ns.sections()[2].options) do if option.buttonText == 'Invite' then first = option; break end end
  local label = first.label
  local others = {}
  for _, option in ipairs(ns.sections()[2].options) do others[option] = true end
  ns.interact.press(first); frames(4); ns.verify()
  local survivors = 0
  for _, option in ipairs(ns.sections()[2].options) do if others[option] then survivors = survivors + 1 end end
  assert(survivors >= #ns.sections()[2].options - 1, 'only the invited model\\'s row was replaced: ' .. survivors .. ' of ' .. #ns.sections()[2].options)
`));

test('the manager opens on its first page: after leaving the tab, after closing the screen and on the shortcut', () => run(`${harness()}
  press('Settings'); press('Memory')
  assert(ns.sections()[2].label == 'Memory')
  -- Another tab is chosen (the closed callback), then ours again: the first page.
  ns.leave(); frames(3)
  assert(managerUi.inspect().view == 'home', 'leaving the tab resets the page')
  ns.openScreen(TAB); frames(3); ns.verify()
  assert(#ns.sections() == 1 and ns.sections()[1].options[1].label == 'Characters to invite', shownOutline())
  -- The screen is closed on a sub-page and opened again by hand: the hook of the Settings screen makes the page ready before it builds.
  press('Settings')
  ns.closeScreen(); frames(3)
  ns.openScreen(TAB)
  assert(#ns.sections() == 1 and ns.sections()[1].options[1].label == 'Characters to invite', 'ready before the widgets were built: ' .. shownOutline())
  frames(3); ns.verify()
  -- Nothing was built for the game's own Settings screen.
  press('Settings'); ns.closeScreen(); ns.fromMods = false
  local calls = #ns.calls
  ns.fire('SettingsMainGameController.OnInitialize', {nativeIdentity = 9})
  assert(#ns.calls == calls, 'the game\\'s own Settings screen is left alone')
`));

test('a change is applied for real after a moment, as one transaction; rows the rules corrected are put back in place with one line under the way back', () => run(`${harness()}
  press('Settings')
  local gestures = ns.find('Body gestures')
  assert(gestures.state == true)
  ns.interact.toggle(gestures)
  frames(1)
  assert(manager.snapshot(player).settings.bodyGestures == true, 'nothing is saved at the moment of the click')
  frames(6)
  assert(manager.snapshot(player).settings.bodyGestures == false and saved.bodyGestures == false, 'applied once the changes have settled')
  assert(ns.find('Body gestures') == gestures and gestures.state == false, 'the row is the same widget and shows the saved value')
  -- Two changes close together are one transaction (one save).
  local writes = #fileWrites
  ns.interact.toggle(ns.find('Subtitles')); ns.interact.toggle(ns.find('Voice playback'))
  frames(8)
  assert(saved.subtitles == false and saved.voice == false)
  local settingsWrites = 0
  for index = writes + 1, #fileWrites do if fileWrites[index].path == 'runtime/settings.json' or fileWrites[index].path:find('settings', 1, true) then settingsWrites = settingsWrites + 1 end end
  assert(settingsWrites <= 2, 'one transaction (a file and its swap), not one per change: ' .. settingsWrites)
  -- A refused choice goes back and says why; the other change in the same moment is kept.
  ns.interact.toggle(ns.find('Follow-up questions'))
  ns.interact.select(ns.find('Companion voices'), 6)   -- Voxtral without a Mistral key
  frames(8); ns.verify()
  assert(saved.followUpInterest == false, 'the change that could be made was made')
  assert(ns.find('Companion voices').selectedElementIndex == 1, 'the refused voice went back to the saved one')
  assert(managerUi.inspect().shown == 'Requires a Mistral key (add it in Settings > Conversation provider)', tostring(managerUi.inspect().shown))
  assert(ns.sections()[1].options[2].label:find('Requires a Mistral key', 1, true) == 1, 'the line is under the way back')
  -- A rule that moves another row: Natural speech beside the cloud voice moves the voice, in place, with the notice.
  ns.interact.select(ns.find('Companion voices'), 7)   -- Convai cloud voice
  frames(8); ns.verify()
  assert(saved.voiceProvider == 'convai' and ns.find('Companion voices').selectedElementIndex == 7)
  assert(saved.expressiveEmotions == false and ns.find('Expressive emotions').state == false, 'the cloud voice turned Expressive emotions off, and the row shows it')
  ns.interact.toggle(ns.find('Natural speech')); frames(8); ns.verify()
  assert(saved.naturalSpeech == true and saved.voiceProvider == 'pocket', 'Natural speech moved the voice to Pocket')
  assert(ns.find('Companion voices').selectedElementIndex == 1, 'the voice row shows it')
  assert(managerUi.inspect().shown:find('Natural speech needs a local voice', 1, true), tostring(managerUi.inspect().shown))
  assert(ns.sections()[1].options[2].label:find('Natural speech needs a local voice', 1, true) == 1)
  -- The line goes away with the next page.
  press('Back to Companion Manager')
  assert(not managerUi.inspect().shown)
`));

test('a slider is applied once, after it stops moving, and the page is not drawn again while it is held', () => run(`${harness()}
  press('Settings')
  local volume = ns.find('Voice volume (%)')
  assert(volume.type == 'rangeInt' and volume.min == 50 and volume.max == 200 and volume.step == 5)
  ns.resetCalls()
  for _, value in ipairs({105, 110, 120, 135, 150}) do ns.interact.slide(volume, value); frames(2, 0.1) end
  assert(manager.snapshot(player).settings.voiceVolume == 100, 'nothing saved while it moves')
  frames(10)
  assert(saved.voiceVolume == 150, tostring(saved.voiceVolume))
  assert(ns.find('Voice volume (%)') == volume and volume.currentValue == 150)
  assert(ns.callCount('removeOption') == 0, 'the slider was not rebuilt')
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
  press('Settings')
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
  assert(managerUi.inspect().shown == 'Needs Local AI.', tostring(managerUi.inspect().shown))
`));

test('Restore defaults goes through the same validated path, only on the Settings page', () => run(`${harness()}
  -- On another page it says where it works and changes nothing.
  ns.interact.restoreDefaults(); frames(4)
  assert(managerUi.inspect().shown == 'Open Settings to restore its defaults.', tostring(managerUi.inspect().shown))
  press('Settings')
  assert(manager.applySettings(player, {bodyGestures = false, subtitleStyle = 'overhead', voiceVolume = 150, battleReactions = true, voiceProvider = 'convai',
    naturalSpeech = false, expressiveEmotions = false}))
  frames(20)
  assert(ns.find('Body gestures').state == false and ns.find('Subtitle display').selectedElementIndex == 2)
  ns.interact.interact = nil
  ns.interact.restoreDefaults(); frames(8); ns.verify()
  local settings = manager.snapshot(player).settings
  assert(settings.bodyGestures == true and settings.subtitleStyle == 'dialogue' and settings.voiceVolume == 100 and settings.battleReactions == false)
  assert(settings.voiceProvider == 'pocket', 'the voice default, applied through the same rules')
  assert(ns.find('Body gestures').state == true and ns.find('Voice volume (%)').currentValue == 100 and ns.find('Battle reactions') == nil)
  assert(ns.find('React to battles').state == false and ns.find('Companion voices').selectedElementIndex == 1)
  assert(managerUi.inspect().shown == 'Defaults restored.', tostring(managerUi.inspect().shown))
  -- A default the rules would refuse is not forced: Expressive emotions with the cloud voice (turned off by the rule, quietly).
  assert(manager.applySettings(player, {voiceProvider = 'convai'}))
  frames(4)
  ns.interact.restoreDefaults(); frames(8)
  assert(manager.snapshot(player).settings.voiceProvider == 'pocket')
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
  assert(ns.find('Characters to invite'))
`));

test('add-on settings are rows of the Settings page, staged and committed with the main settings', () => run(`${harness()}
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
  local labels = {}
  for _, section in ipairs(ns.sections()) do labels[#labels + 1] = section.label end
  assert(table.concat(labels, ','):find('Skippy', 1, true), 'the add-on has its section: ' .. table.concat(labels, ','))
  local gap, marks = ns.find('Time between remarks'), ns.find('Mark our lines in the subtitles')
  assert(gap.type == 'selectorString' and gap.selectedElementIndex == 2 and marks.type == 'switch' and marks.state == true)
  -- An add-on change alone is saved by the add-on; with a main change in the same moment, after the main settings were saved.
  ns.interact.select(gap, 3); ns.interact.toggle(ns.find('Subtitles')); frames(8); ns.verify()
  assert(table.concat(committed, ',') == 'addon:skippy:remarkGap=3', table.concat(committed, ','))
  assert(saved.subtitles == false and ns.find('Time between remarks').selectedElementIndex == 3)
  -- A refused main change drops the add-on's staged change with it (nothing is half saved), and the row goes back.
  committed = {}
  ns.interact.toggle(marks)
  ns.interact.select(ns.find('Companion voices'), 6)
  frames(8)
  assert(table.concat(committed, ',') == 'addon:skippy:markLines=false', 'the add-on change is its own: ' .. table.concat(committed, ','))
  assert(ns.find('Companion voices').selectedElementIndex == 1)
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
  press('Current party')
  assert(ns.find('Johnny Silverhand #1') or ns.find('Johnny Silverhand'), shownOutline())
`));

test('the tab keeps what is on screen current: a state that changes is drawn, a state that does not change is not', () => run(`${harness()}
  press('Current party')
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
  for _, name in ipairs({'Settings', 'Back to Companion Manager', 'Characters to invite', 'Back to Companion Manager', 'Current party',
      'Back to Companion Manager', 'Settings', 'Memory', 'Back to settings', 'Help and support', 'Back to settings', 'Back to Companion Manager'}) do
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
  press('Settings'); ns.verify()
  assert(ns.find('Body gestures'), 'the page works')
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

test('Inworld shows only in Developer mode, and no row on any page speaks of a shared key or plan or calls an option recommended', () => run(`${harness()}
  local function everything()
    local text = {}
    for _, view in ipairs({'home', 'characters', 'party', 'models', 'settings', 'memory', 'help', 'paid-tier'}) do
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
  core.setView('settings'); frames(4)
  ns.interact.toggle(ns.find('Developer mode')); frames(10)
  assert(manager.snapshot(player).settings.developerMode == true)
  local on = everything()
  assert(on:find('inworld · needs key', 1, true) and on:find('inworld api key', 1, true), 'Developer mode lists the Inworld voice and its key row')
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
  assert(#popups == 1 and popups[1] == 'Open AI NPC Cyberpunk Mod in the Mods list.', tostring(popups[1]))
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
    assert(#popups == 1 and popups[1] ~= 'Open AI NPC Cyberpunk Mod in the Mods list.' and popups[1]:find('AI NPC Cyberpunk Mod', 1, true), tostring(popups[1]))
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
  assert(ns.sections()[2].label == 'Interface' and ns.find('Interface language'), shownOutline())
  titlePress('Back to Companion Manager')
  assert(#ns.sections() == 1 and ns.sections()[1].options[1].label == 'Characters to invite', shownOutline())
  -- Pages that need one say so, visibly, and their invite buttons are not offered as if they worked.
  for _, page in ipairs({'Characters to invite', 'Current party', 'Model browser'}) do
    titlePress(page)
    local note = assert(ns.find('Characters and party'), page .. ': no row that says a save is needed')
    assert(note.type == 'button' and note.buttonText == 'Load a save first', page)
    assert(not ns.find('Your party is empty'), page .. ': an empty party is not the answer without a save')
    titlePress('Back to Companion Manager')
  end
  -- Game.GetPlayer() can still hand back an object at the main menu (seen live 2026-10-19): that is not a loaded save.
  player = {hash = 'menu-object', GetEntityID = function(self) return {hash = self.hash} end}
  titlePress('Characters to invite')
  assert(ns.find('Characters and party'), 'a player object at the main menu is not a loaded save')
  titlePress('Back to Companion Manager')
  -- The same pages with a save loaded have no such row.
  local source = player
  player = {hash = 'player-1', open = true, queue = {}, rows = {}, GetEntityID = function(self) return {hash = self.hash} end}
  frames(4)
  press('Current party')  -- gameplay frames: init.lua passes the player once a save is loaded
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
  press('Settings'); press('Memory')
  local line = assert(ns.find('Memory service'))
  assert(line.buttonText == 'Ready' or line.buttonText == 'Unavailable', line.buttonText)
  assert(line.controller.offStateBody.visible == false and line.controller.onStateBody.visible == false, 'the frame of a text line is hidden')
  local button = assert(ns.find('Forget all memories'))
  assert(button.controller.offStateBody.visible == true and button.controller.onStateBody.visible == true, 'a real button keeps its frame')
  -- A line with a long value is the label alone, still without a frame.
  local identity = assert(ns.find('Player memory'))
  assert(identity.controller.offStateBody.visible == false)
  -- The screen is closed and opened again: the rows are made again, and the frames are hidden again.
  ns.closeScreen(); frames(3)
  ns.openScreen(TAB); frames(2)
  press('Settings'); press('Memory')
  assert(ns.find('Memory service').controller.offStateBody.visible == false)
  assert(ns.find('Forget all memories').controller.offStateBody.visible == true)
  -- A controller that does not answer is harmless.
  ns.find('Memory service').controller.offStateBody = nil
  press('Back to settings'); press('Memory')
  assert(managerUi.inspect().error == '' or managerUi.inspect().error == nil, tostring(managerUi.inspect().error))
`));
