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
