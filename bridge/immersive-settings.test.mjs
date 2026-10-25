import {test} from 'node:test';
import assert from 'node:assert/strict';
import {run, nsuiHarness, source} from './manager-fixture.mjs';

// Settings > Companion behavior > Immersive invitations: its own page on the Native Settings UI tab, saved as one table, Off by default,
// validated like every setting, and part of Restore defaults (docs/IMMERSIVE_INVITATIONS.md).
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

test('Companion behavior has an Open button for the page; the page starts Off with the documented defaults', () => run(`${harness()}
  press('Settings')
  local open = assert(ns.find('Immersive invitations'), 'no Immersive invitations button on Settings')
  assert(open.type == 'button' and open.buttonText == 'Open')
  press('Immersive invitations')
  assert(managerUi.inspect().view == 'immersive-invitations')
  local switch = assert(ns.find('Immersive invitations'))
  local rows = {}
  for _, row in ipairs(ns.outline()) do rows[#rows + 1] = row end
  assert(ns.find('Back to settings'))
  local master = nil
  for _, name in ipairs({'Immersive invitations', 'How she arrives', 'When she arrives', 'How long she waits',
      'Meet at my waypoint when I ask', 'She texts you'}) do assert(ns.find(name), 'no row ' .. name) end
  assert(ns.find('How she arrives').selectedElementIndex == 1, 'Walk is the default')
  assert(ns.find('When she arrives').selectedElementIndex == 1, 'Right now is the default')
  assert(ns.find('How long she waits').selectedElementIndex == 2, 'five minutes is the default')
  assert(ns.find('Meet at my waypoint when I ask').state == true and ns.find('She texts you').state == true)
  local settings = manager.snapshot(player).settings.immersive
  assert(settings.enabled == false and settings.arrival == 'walk' and settings.delay == 0 and settings.wait == 5)
  assert(manager.immersive().enabled == false)
`));

test('a change is applied and saved as one validated table, and Restore defaults puts everything back', () => run(`${harness()}
  press('Settings'); press('Immersive invitations')
  ns.interact.toggle(ns.find('Immersive invitations')); frames(8); ns.verify()
  ns.interact.select(ns.find('How she arrives'), 2); frames(8); ns.verify()
  ns.interact.select(ns.find('When she arrives'), 3); frames(8); ns.verify()
  ns.interact.select(ns.find('How long she waits'), 3); frames(8); ns.verify()
  ns.interact.toggle(ns.find('She texts you')); frames(8); ns.verify()
  local value = manager.immersive()
  assert(value.enabled == true and value.arrival == 'car' and value.delay == 5 and value.wait == 10 and value.texts == false and value.waypoint == true,
    value.arrival .. ' ' .. tostring(value.delay))
  assert(saved.immersive.enabled == true and saved.immersive.arrival == 'car' and saved.immersive.delay == 5 and saved.immersive.wait == 10,
    'saved in settings.json')
  ns.interact.restoreDefaults(); frames(8); ns.verify()
  value = manager.immersive()
  assert(value.enabled == false and value.arrival == 'walk' and value.delay == 0 and value.wait == 5 and value.texts == true)
  assert(ns.find('Immersive invitations').state == false and ns.find('When she arrives').selectedElementIndex == 1)
  press('Back to settings')
  assert(managerUi.inspect().view == 'settings')
`));

test('an invalid value is refused and changes nothing; a damaged saved value falls back to the default', () => run(`${harness()}
  assert(not manager.applySettings(player, {immersive = {arrival = 'bike'}}))
  assert(not manager.applySettings(player, {immersive = {delay = 3}}))
  assert(not manager.applySettings(player, {immersive = {wait = 1}}))
  assert(not manager.applySettings(player, {immersive = {enabled = 'yes'}}))
  assert(not manager.applySettings(player, {immersive = {bogus = true}}))
  assert(manager.immersive().enabled == false and manager.immersive().delay == 0)
  assert(manager.applySettings(player, {immersive = {enabled = true, delay = 10}}))
  assert(manager.immersive().enabled == true and manager.immersive().delay == 10 and manager.immersive().arrival == 'walk')
`));
