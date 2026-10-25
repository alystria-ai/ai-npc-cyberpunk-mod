import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, nsuiHarness, managerFixture, source} from './manager-fixture.mjs';

// Settings > Companion behavior > Housemates: its own page on the Native Settings UI tab, saved as one table, Off by default, validated like every
// setting, and part of Restore defaults (docs/HOUSEMATES.md).
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
  local function frames(count, step)
    for _ = 1, count or 6 do clock = clock + (step or 0.1); managerUi.update(player, true) end
    loaded = registered.loadMod('manager')
  end
  local function press(label)
    ns.interact.press(assert(ns.find(label), 'no row: ' .. label)); frames(3); ns.verify()
  end
  frames(3)
`;

test('Companion behavior has an Open button for the page; the page starts Off with the pair chat On', () => run(`${harness()}
  press('Settings')
  local open = assert(ns.find('Housemates'), 'no Housemates button on Settings')
  assert(open.type == 'button' and open.buttonText == 'Open')
  press('Housemates')
  assert(managerUi.inspect().view == 'housemates')
  assert(ns.find('Back to settings'))
  assert(ns.find('Housemates').type ~= 'button', 'the master switch is a switch')
  assert(ns.find('Housemates').state == false, 'Off by default')
  assert(ns.find('Housemates talk to each other').state == true, 'the pair chat is On by default')
  local settings = manager.snapshot(player).settings.housemates
  assert(settings.enabled == false and settings.chat == true)
  assert(manager.housemates().enabled == false and manager.housemates().chat == true)
`));

test('a change is applied and saved as one validated table, and Restore defaults puts everything back', () => run(`${harness()}
  press('Settings'); press('Housemates')
  ns.interact.toggle(ns.find('Housemates')); frames(8); ns.verify()
  ns.interact.toggle(ns.find('Housemates talk to each other')); frames(8); ns.verify()
  local value = manager.housemates()
  assert(value.enabled == true and value.chat == false)
  assert(saved.housemates.enabled == true and saved.housemates.chat == false, 'saved in settings.json')
  ns.interact.restoreDefaults(); frames(8); ns.verify()
  value = manager.housemates()
  assert(value.enabled == false and value.chat == true)
  assert(ns.find('Housemates').state == false and ns.find('Housemates talk to each other').state == true)
  press('Back to settings')
  assert(managerUi.inspect().view == 'settings')
`));

test('an invalid value is refused and changes nothing; a damaged saved value falls back to the default', () => run(`${harness()}
  assert(not manager.applySettings(player, {housemates = {enabled = 'yes'}}))
  assert(not manager.applySettings(player, {housemates = {chat = 1}}))
  assert(not manager.applySettings(player, {housemates = {bogus = true}}))
  assert(not manager.applySettings(player, {housemates = true}))
  assert(manager.housemates().enabled == false and manager.housemates().chat == true)
  assert(manager.applySettings(player, {housemates = {enabled = true}}))
  assert(manager.housemates().enabled == true and manager.housemates().chat == true)
  assert(manager.applySettings(player, {housemates = {chat = false}}))
  assert(manager.housemates().enabled == true and manager.housemates().chat == false, 'a field is merged, the other is kept')
`));

test('a saved bad value falls back to the default (Off, chat On) and the cleaned table is saved, other keys kept', () => run(`${managerFixture}
  for _, case in ipairs({
      {{enabled = 'yes', chat = 7, extra = 1}, false, true}, {{enabled = true, chat = 'no'}, true, true},
      {{enabled = false, chat = false}, false, false}, {'on', false, true}, {nil, false, true}}) do
    seed = {version = 2, voiceProvider = 'pocket', housemates = case[1], enabledByKey = {}, future = {keep = 'unchanged'}}
    files['runtime/settings.json'], saved = 'seed', nil
    manager.configure(api, profiles); manager.prepare(player)
    local value = manager.housemates()
    assert(value.enabled == case[2] and value.chat == case[3], tostring(case[1]) .. ' -> ' .. tostring(value.enabled) .. '/' .. tostring(value.chat))
    assert(saved.housemates.enabled == case[2] and saved.housemates.chat == case[3] and saved.housemates.extra == nil and saved.future.keep == 'unchanged')
  end
`));

test('the options: Move-in apartment lists Ask me and the flats V owns, the pause and the chat size are lists, and every change is saved', () => run(`${harness()}
  local owned = {{id = 'h10', name = 'Megabuilding H10'}, {id = 'glen', name = 'Heywood Glen'}}
  convaiHousemateOwned = function() return owned end
  press('Settings'); press('Housemates')
  local move = assert(ns.find('Move-in apartment'), 'no Move-in apartment row')
  assert(move.type == 'selectorString' and #move.elements == 3 and move.selectedElementIndex == 1, 'Ask me, then the two flats')
  assert(move.elements[1] == 'Ask me' and move.elements[2] == 'Megabuilding H10' and move.elements[3] == 'Heywood Glen')
  local pause, size = assert(ns.find('Pause between chats')), assert(ns.find('Housemates in one chat'))
  assert(#pause.elements == 4 and pause.selectedElementIndex == 2, 'the pause starts at 2 minutes')
  assert(pause.elements[1] == '1 minute' and pause.elements[4] == '10 minutes')
  assert(#size.elements == 3 and size.selectedElementIndex == 1, 'the chat starts as a pair')
  local value = manager.housemates()
  assert(value.moveIn == 'ask' and value.chatCooldown == 120 and value.chatSize == 2)
  ns.interact.select(move, 3); frames(8); ns.verify()
  ns.interact.select(ns.find('Pause between chats'), 4); frames(8); ns.verify()
  ns.interact.select(ns.find('Housemates in one chat'), 3); frames(8); ns.verify()
  value = manager.housemates()
  assert(value.moveIn == 'glen' and value.chatCooldown == 600 and value.chatSize == 4, value.moveIn)
  assert(saved.housemates.moveIn == 'glen' and saved.housemates.chatCooldown == 600 and saved.housemates.chatSize == 4, 'saved in settings.json')
  -- the flat is no longer owned: the page shows Ask me, and the saved word waits (it is only used when she can use it)
  owned = {{id = 'h10', name = 'Megabuilding H10'}}
  press('Back to settings'); press('Housemates')
  assert(ns.find('Move-in apartment').selectedElementIndex == 1 and #ns.find('Move-in apartment').elements == 2)
  assert(manager.housemates().moveIn == 'glen')
  ns.interact.restoreDefaults(); frames(8); ns.verify()
  value = manager.housemates()
  assert(value.moveIn == 'ask' and value.chatCooldown == 120 and value.chatSize == 2 and value.chat == true and value.enabled == false)
`));

test('the options are validated: a value outside the lists is refused, a damaged saved one is the default', () => run(`${harness()}
  for _, bad in ipairs({{chatCooldown = 90}, {chatCooldown = '120'}, {chatSize = 1}, {chatSize = 5}, {chatSize = 2.5}, {moveIn = 'penthouse'}, {moveIn = 3}, {moveIn = true}}) do
    assert(not manager.applySettings(player, {housemates = bad}), 'accepted ' .. tostring(next(bad)))
  end
  assert(manager.housemates().chatCooldown == 120 and manager.housemates().chatSize == 2 and manager.housemates().moveIn == 'ask')
  assert(manager.applySettings(player, {housemates = {chatCooldown = 60, chatSize = 3, moveIn = 'japan'}}))
  local value = manager.housemates()
  assert(value.chatCooldown == 60 and value.chatSize == 3 and value.moveIn == 'japan' and value.chat == true)
  assert(manager.applySettings(player, {housemates = {moveIn = 'ask'}}))
  assert(manager.housemates().moveIn == 'ask' and manager.housemates().chatCooldown == 60, 'a field is merged, the others are kept')
  local arrivals = {manager.housemateChoices()}
  assert(#arrivals[1] == 4 and arrivals[1][1] == 60 and arrivals[1][4] == 600 and #arrivals[2] == 3 and arrivals[2][3] == 4)
`));

test('a saved bad option falls back to its default, the cleaned table is saved and a good one is kept', () => run(`${managerFixture}
  for _, case in ipairs({
      {{chatCooldown = 90, chatSize = 9, moveIn = 'nowhere'}, 120, 2, 'ask'}, {{chatCooldown = 600, chatSize = 4, moveIn = 'corpo'}, 600, 4, 'corpo'},
      {{chatCooldown = '60', chatSize = '3', moveIn = false}, 120, 2, 'ask'}, {{}, 120, 2, 'ask'}}) do
    seed = {version = 2, voiceProvider = 'pocket', housemates = case[1], enabledByKey = {}}
    files['runtime/settings.json'], saved = 'seed', nil
    manager.configure(api, profiles); manager.prepare(player)
    local value = manager.housemates()
    assert(value.chatCooldown == case[2] and value.chatSize == case[3] and value.moveIn == case[4], tostring(value.chatCooldown) .. '/' .. tostring(value.chatSize) .. '/' .. tostring(value.moveIn))
    assert(saved.housemates.chatCooldown == case[2] and saved.housemates.chatSize == case[3] and saved.housemates.moveIn == case[4])
  end
`));

test('Evict all housemates is a button on the page: off while nobody lives there, then it evicts, says how many and the list is empty', () => run(`${harness()}
  local rows, evicted = {}, 0
  convaiHousemateRows = function() return rows end
  convaiHousemateEvictAll = function() evicted = evicted + 1; local n = #rows; rows = {}; return n end
  press('Settings'); press('Housemates')
  local button = assert(ns.find('Evict all housemates'), 'no Evict all housemates row')
  assert(button.type == 'button' and button.buttonText == 'Evict')
  ns.interact.press(button); frames(3); ns.verify()
  assert(evicted == 0, 'disabled while nobody lives there')
  rows = {{key = 'judy-alvarez', name = 'Judy', apartment = 'corpo', apartmentName = 'Corpo Plaza', state = 'home'},
    {key = 'rogue', name = 'Rogue', apartment = 'glen', apartmentName = 'Heywood Glen', state = 'party'}}
  press('Back to settings'); press('Housemates')
  ns.interact.press(ns.find('Evict all housemates')); frames(3); ns.verify()
  assert(evicted == 1 and #rows == 0)
`));
