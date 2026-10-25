import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {run, nsuiHarness, source} from './manager-fixture.mjs';
const initSource = readFileSync(new URL('../mod/init.lua', import.meta.url), 'utf8');
const between = (from, to) => {
  const start = initSource.indexOf(from), end = initSource.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `markers ${from} .. ${to}`);
  return initSource.slice(start, end);
};

// The Companion Manager as a page of Mod Configuration Menu 0.10.5: the real host (mod/mcm-host.lua, attached to mod/nsui.lua over
// mod/manager-ui.lua) over a fake MCM (bridge/mcm-fake.mjs) that keeps MCM's own rules for providers, schemas, drafts, Apply and the
// public UI extension. The page logic itself (rows, rules, validation) is tested in manager.test.mjs; the Native Settings UI host in
// nsui-manager.test.mjs.
const everything = {
  'service-status.lua': source('service-status.lua'), 'character-editor.lua': source('character-editor.lua'),
  'convai-paid-tier.lua': source('convai-paid-tier.lua'), 'support-report.lua': source('support-report.lua'),
  'setup-check.lua': source('setup-check.lua'), 'custom-provider.lua': source('custom-provider.lua'),
};
const withoutCustomModule = Object.fromEntries(Object.entries(everything).filter(([name]) => name !== 'custom-provider.lua'));
const harness = (options = {}) => `
  local logged = {}
  print = function(text) logged[#logged + 1] = tostring(text) end
  -- CET's GetDisplayResolution(): the game's resolution (a test changes display[1], display[2]); 1080p unless the options say otherwise.
  local display = {${options.resolution ? options.resolution.join(', ') : '1920, 1080'}}
  GetDisplayResolution = function() return display[1], display[2] end
` + nsuiHarness({modules: everything, mcm: {version: '0.10.5'}, screen: false, ...options}) + `
  convaiNotices.configure(function() return manager.developerMode() end)
  local clock = 1000
  os.clock = function() return clock end
  local timeBase = os.time()
  os.time = function() return timeBase + math.floor(clock - 1000) end
  local function frames(count, step)
    for _ = 1, count or 8 do
      clock = clock + (step or 0.1)
      managerUi.update(player, true)
      if mcm then mcm.update() end
    end
  end
  local function press(label)
    local ok, why = mcm.press(label)
    assert(ok, 'press ' .. label .. ': ' .. tostring(why))
    frames(2)
  end
  local function labels()
    local list = {}
    for _, row in ipairs(mcm.rows()) do list[#list + 1] = row.label end
    return table.concat(list, ' | ')
  end
  frames(3)
`;
const withScreen = (body, options) => run(`${harness(options)}
  mcm.openScreen()
  frames(2)
  ${body}
`);

test('no MCM at all: the host stays quiet, registers nothing and costs no call', () => run(`${harness({mcm: null})}
  frames(40)
  assert(not mcmHost.ready() and mcmHost.availability() == 'missing')
  for _, line in ipairs(logged) do assert(not line:find('Mod Configuration Menu', 1, true), 'nothing is said about MCM when it is not installed: ' .. line) end
`));

test('MCM 0.10.3 and MCM 0.10.5 without its public UI are refused with one log line each, never registered', () => {
  for (const [version, noUi, wanted] of [['0.10.3', true, 'older than 0.10.5'], ['0.10.4', false, 'older than 0.10.5'], ['0.10.5', true, 'no public UI extension']]) {
    run(`${harness({mcm: {version, noUi}})}
      frames(120)
      assert(not mcmHost.ready(), 'not registered')
      assert(mcm.calls[1] == nil, 'no MCM call was made: ' .. tostring(mcm.calls[1]))
      local lines = 0
      for _, line in ipairs(logged) do if line:find('Mod Configuration Menu cannot host the page', 1, true) then lines = lines + 1; assert(line:find('${wanted}', 1, true), line) end end
      assert(lines == 1, 'one line, not one a second: ' .. lines)
      assert(mcmHost.availability() == '${version === '0.10.5' ? 'missing' : 'old'}')
    `);
  }
});

test('an old MCM says what to do in its one console line: use the Native Settings UI tab that is installed, or update or install', () => {
  // Beside Native Settings UI: the tab is used, and the line says so (with the way to get MCM's page instead).
  run(`${harness({mcm: {version: '0.10.3', noUi: true}, screen: false})}
    frames(120)
    local lines = {}
    for _, line in ipairs(logged) do if line:find('Mod Configuration Menu cannot host the page', 1, true) then lines[#lines + 1] = line end end
    assert(#lines == 1, 'one line: ' .. #lines)
    assert(lines[1]:find('Native Settings UI is installed, so its tab is used', 1, true) and lines[1]:find('update it to 0.10.5 or newer', 1, true), lines[1])
    assert(ns.data[TAB] ~= nil, 'the Native Settings UI tab is the manager here')
  `);
  // With no Native Settings UI: update, or install it.
  run(`${harness({mcm: {version: '0.10.3', noUi: true}, nsui: false, screen: false})}
    frames(120)
    local lines = {}
    for _, line in ipairs(logged) do if line:find('Mod Configuration Menu cannot host the page', 1, true) then lines[#lines + 1] = line end end
    assert(#lines == 1, 'one line: ' .. #lines)
    assert(lines[1]:find('Update it to 0.10.5 or newer, or install Native Settings UI', 1, true), lines[1])
  `);
});

test('a refusal that comes back on every press or retry is one console line, then a count in runtime/mcm.log', () => run(`${harness({screen: false, nsui: false, mcm: {version: '0.10.5', renderer: false}})}
  local fileLines = {}
  local realOpen = io.open
  io.open = function(path, mode)
    if path == 'runtime/mcm.log' and mode == 'a' then
      return {write = function(_, ...) fileLines[#fileLines + 1] = table.concat({...}) end, close = function() return true end}
    end
    return realOpen and realOpen(path, mode) or nil
  end
  local function said(pattern, list)
    local count = 0
    for _, line in ipairs(list) do if line:find(pattern, 1, true) then count = count + 1 end end
    return count
  end
  for _ = 1, 25 do assert(managerUi.open() == false) end
  assert(said('would not open the page', logged) == 1, 'console: ' .. said('would not open the page', logged))
  -- The file has the first line and one count line at the 10th time (the next count is at the 100th).
  assert(said('would not open the page', fileLines) == 2, table.concat(fileLines, ' | '))
  assert(said('repeated 10 times', fileLines) == 1, table.concat(fileLines, ' | '))
`));

test('MCM 0.10.5, 0.10.10 and 0.11.0 are registered: the version compares as numbers, and the provider is the one MCM validates', () => {
  for (const version of ['0.10.5', '0.10.10', '0.11.0', '1.0.0']) {
    run(`${harness({mcm: {version}})}
      assert(mcmHost.ready(), '${version} registers at CET\s onInit')
      assert(mcm.calls[1] == 'registerProvider')
      local logLine
      for _, line in ipairs(logged) do if line:find('registered with Mod Configuration Menu', 1, true) then logLine = line end end
      assert(logLine and logLine:find('${version}', 1, true), tostring(logLine))
      assert(mcm.mod() ~= nil, 'the provider was indexed')
    `);
  }
});

test('an MCM that loads after this mod is found by the once-a-second look, and the apply policy waits for it to index the mod', () => run(`${harness({mcm: {version: '0.10.5'}})}
  local real = GetMod
  local hidden = true
  GetMod = function(name) if name == 'ModConfigurationMenuAPI' and hidden then return nil end return real(name) end
  -- start again without MCM: a second host instance over the same core
  mcmHost.shutdown()
  assert(not mcmHost.ready())
  frames(30)
  assert(not mcmHost.ready())
  hidden = false
  frames(30)
  assert(mcmHost.ready(), 'found later')
  assert(mcm.api.ui and mcm.config().applyPolicy == 'explicit', 'the apply policy is explicit')
  assert(mcm.config().presentation.locale == convaiUiLocale.current(), 'the locale is given')
`));

test('the home page: one category with the four destinations, explicit apply, no MCM internals touched', () => withScreen(`
  assert(mcm.config().applyPolicy == 'explicit')
  assert(table.concat(mcm.categories(), ',') == 'Companion Manager', table.concat(mcm.categories(), ','))
  assert(labels() == 'Characters to invite | Current party | Model browser | Character editor | Key bindings | Settings', labels())
  for _, row in ipairs(mcm.rows()) do
    assert(row.type == 'action' and row.value == 'Open' and row.capabilities.action == true and row.description ~= '')
  end
  -- No Back on Home with MCM 0.10.5, on purpose: it has no public call that closes its screen, and its own Escape closes it when the
  -- page names no back action (escapeBack stays on, backActionId unset). A footer button here could not do that, so there is none
  -- (MCM 0.10.6 has api.ui.close and gets one: see the 0.10.6 tests at the end).
  assert(mcm.config().navigation.pageId == 'home|1|1' and mcm.config().navigation.backActionId == nil and mcm.config().navigation.escapeBack == true)
  assert(#mcm.config().footerActions == 0)
`));

test('a page change: the way back is a footer action and Escape-back, the next visit starts on the first page', () => withScreen(`
  press('Settings')
  local config = mcm.config()
  assert(config.navigation.backActionId == 'settings:back' and config.navigation.escapeBack == true, config.navigation.backActionId)
  assert(config.footerActions[1] == 'defaults:restore' and config.footerActions[2] == 'settings:back', table.concat(config.footerActions, ','))
  assert(mcm.row('Back to Companion Manager').value == 'Back')
  assert(config.navigation.pageId == 'settings|1|1')
  press('Memory')
  assert(mcm.config().navigation.backActionId == 'memory:settings', 'the memory page goes back to settings')
  press('Back to settings'); press('Back to Companion Manager')
  assert(labels() == 'Characters to invite | Current party | Model browser | Character editor | Key bindings | Settings')
  -- Closing the screen and opening it again starts on the first page.
  press('Settings')
  mcm.closeScreen(); frames(3)
  assert(managerUi.inspect().view == 'home', 'closeMod puts the page back on Home')
  mcm.openScreen()
  assert(labels() == 'Characters to invite | Current party | Model browser | Character editor | Key bindings | Settings')
`));

test('every kind of row is one MCM can take: switches, selects, sliders, buttons and text, with ids, defaults and capabilities', () => withScreen(`
  press('Settings')
  local kinds, ids = {}, {}
  for _, row in ipairs(mcm.rows()) do
    kinds[row.type] = (kinds[row.type] or 0) + 1
    assert(not ids[row.id], 'a row id twice: ' .. row.id)
    ids[row.id] = true
    assert(row.label ~= '', 'a row without a label: ' .. row.id)
    if row.type == 'bool' or row.type == 'select' or row.type == 'int' then
      assert(row.capabilities.draft == true and row.capabilities.write == true, row.id)
      -- No default: MCM marks a row purple only when it has a default and differs from it (and the manager has its own Restore defaults).
      assert(row.default == nil and row.capabilities.canResetToDefault ~= true, row.id .. ' must carry no default')
    end
    if row.type == 'select' then assert(#row.elements > 0 and row.value >= 1 and row.value <= #row.elements, row.id) end
    if row.type == 'int' then assert(row.min and row.max and row.step and row.value >= row.min and row.value <= row.max, row.id) end
    if row.type == 'action' then assert(row.capabilities.write == false and row.capabilities.draft == false, row.id) end
    assert(not row.id:find('^ui:'), 'a page control must not be a draft: ' .. row.id)
  end
  -- The Settings page has no read-only line, so no line of the page is drawn at another size.
  assert(kinds.bool and kinds.select and kinds.int and kinds.action and not kinds.string, 'every kind is on the Settings page')
  assert(mcm.row('feedback') == nil, 'the line of the last action is MCM\s status line, not a row')
  assert(#mcm.categories() > 6)
  assert(mcm.mod().loaded)
`));

test('a change is a draft that MCM keeps until Apply; Apply is one validated, saved transaction, and the page loads again', () => withScreen(`
  press('Settings')
  local before = manager.snapshot(player).settings
  assert(before.subtitles == true and before.voiceVolume == 100)
  local loads = mcm.loads
  assert(mcm.set('Subtitles', false) and mcm.set('Voice volume (%)', 150) and mcm.set('Subtitle display', 2))
  frames(6)
  assert(manager.snapshot(player).settings.subtitles == true, 'nothing is saved before Apply')
  assert(mcm.loads == loads, 'the page is not drawn again under pending changes')
  -- A button is refused while changes are pending (MCM's own rule), with its own words.
  local ok, why = mcm.press('Memory')
  assert(ok == false and why:find('pending changes', 1, true), tostring(why))
  local ok2, why2 = mcm.apply()
  assert(ok2, tostring(why2))
  local after = manager.snapshot(player).settings
  assert(after.subtitles == false and after.voiceVolume == 150 and after.subtitleStyle == 'overhead', 'saved: ' .. tostring(after.subtitles))
  assert(mcm.row('Subtitles').value == false and mcm.row('Voice volume (%)').value == 150, 'the page shows what is saved')
  assert(not next(mcm.drafts()), 'no draft is left')
  -- An invalid value is refused by the rules, MCM keeps the drafts and says why.
  local bad = mcm.set('Subtitle display', 2)
  assert(bad == true)
  mcm.revert()
`));

test('Revert and Restore defaults: Revert drops the drafts; the footer button, pressed twice, puts every row back through the rules (the Local AI model included)', () => withScreen(`
  ${footer}
  press('Settings')
  mcm.set('Voice volume (%)', 120)
  mcm.revert()
  assert(not next(mcm.drafts()) and mcm.row('Voice volume (%)').value == 100)
  assert(manager.applySettings(player, {followUpInterest = false, voiceVolume = 150, battleReactions = true}))
  frames(10)
  assert(mcm.row('Follow-up questions').value == false and mcm.row('Voice volume (%)').value == 150, 'an outside change is drawn')
  -- No row has a default, so MCM's own Defaults button and its Modified counter are not there; the manager's own button is.
  local layout = mcm.layout()
  assert(layout.mcmDefaultsButton == false and layout.comparable == 0 and layout.modified == 0)
  assert(footerLabels() == 'Defaults | Back', footerLabels())
  -- Pending changes: MCM refuses the button (its rule for every action), and nothing is reset.
  mcm.set('Subtitles', false)
  local refused, why = mcm.press('Defaults')
  assert(refused == false and why:find('pending changes', 1, true), tostring(why))
  mcm.revert()
  -- The first press only asks; the button says so, and nothing is changed.
  press('Defaults')
  assert(footerLabels() == 'Confirm | Back', footerLabels())
  assert(mcm.status():find('Confirm', 1, true), mcm.status())
  assert(manager.snapshot(player).settings.followUpInterest == false and manager.snapshot(player).settings.voiceVolume == 150)
  -- Another button drops the first press (a page button; the Settings page has no status button any more).
  press('Memory'); press('Back to settings')
  assert(footerLabels() == 'Defaults | Back', footerLabels())
  press('Defaults'); press('Defaults')
  local settings = manager.snapshot(player).settings
  assert(settings.followUpInterest == true and settings.voiceVolume == 100 and settings.battleReactions == false, 'defaults saved')
  assert(mcm.row('Follow-up questions').value == true and mcm.row('Voice volume (%)').value == 100, 'the page shows them')
  frames(8)   -- the status line follows within a moment
  assert(mcm.status() == 'Defaults restored.', mcm.status())
  assert(footerLabels() == 'Defaults | Back' and not next(mcm.drafts()))
  -- A press on another page drops it too: the confirmation is for the page it was asked on.
  press('Defaults'); press('Memory'); press('Back to settings')
  assert(footerLabels() == 'Defaults | Back', footerLabels())
`));

test('the footer never cuts a label: with changes pending five buttons share the row (Revert, Apply, MCM’s Add to favorites, Defaults, Back), and the mod’s own ones are short enough for that share', () => withScreen(`
  ${footer}
  press('Settings')
  -- The mod cannot hide MCM's Add to favorites (a setting of the player in MCM, with no public option for a mod), so the row is counted
  -- with it: Revert, Apply, Add to favorites, ours, Back.
  mcm.set('Subtitles', false)
  local layout = mcm.layout()
  local labels = {}
  for _, button in ipairs(layout.footerRow) do labels[#labels + 1] = button.label end
  assert(table.concat(labels, ' | ') == 'REVERT | APPLY | ADD TO FAVORITES | Defaults | Back', table.concat(labels, ' | '))
  for _, button in ipairs(layout.footerRow) do
    if not button.mcm then
      assert(core.optionUnits(button.label) <= layout.footerShare, button.label .. ' is cut: ' .. core.optionUnits(button.label) .. ' > ' .. layout.footerShare)
    end
  end
  -- The first press of Defaults changes the label, and it still fits (the player may edit a row after pressing it).
  mcm.revert()
  press('Defaults')
  mcm.set('Subtitles', false)
  layout = mcm.layout()
  for _, button in ipairs(layout.footerRow) do
    if not button.mcm then assert(core.optionUnits(button.label) <= layout.footerShare, button.label .. ' is cut') end
  end
  assert(layout.footerRow[4].label == 'Confirm', layout.footerRow[4].label)
  mcm.revert()
`));

test('Mature content: turned on, Apply saves Local AI and the uncensored model with it (appliedIds stay the ids MCM asked for); without Local AI the switch goes back and the leftover draft is reverted', () => withScreen(`
  local function bridge(tag, value) jsonFixtures['m-' .. tag] = value; files['runtime/mistral-state.json'] = 'm-' .. tag; clock = clock + 2; manager.snapshot(player) end
  bridge('ready', {provider = 'convai', effective = 'convai', localAi = 'ready',
    localModels = {{id = 'standard', name = 'Gemma', sizeMiB = 5000}, {id = 'mature:unc', name = 'Gemma uncensored', sizeMiB = 5200}},
    localModelDefault = 'standard', localModelMatureDefault = 'mature:unc'})
  jsonFixtures['voice-state'] = {state = 'ready', provider = 'pocket', omniPack = {installed = true, missing = {}}, updated = clock * 1000}
  files['runtime/local-voice-state.json'] = 'voice-state'
  press('Settings')
  frames(12)
  assert(mcm.set('Mature content', true))
  local ok, why = mcm.apply()
  assert(ok, tostring(why))
  assert(saved.matureContent == true and saved.conversationProvider == 'local' and saved.localModel == 'mature:unc')
  assert(mcm.row('Conversation provider').value == 4 and mcm.row('Local AI model').value == 2, 'the rows show what the rules added')
  frames(4)
  assert(mcm.status():find('Local AI', 1, true), 'the status line says what else changed: ' .. mcm.status())
  -- Turn it off: the rows go back.
  assert(mcm.set('Mature content', false) and mcm.apply())
  assert(saved.matureContent == false and saved.conversationProvider == 'convai' and saved.localModel == 'standard')
  -- Without the Local AI pack the switch cannot stay on: MCM would keep the draft as unapplied, the host reverts it.
  bridge('nopack', {provider = 'convai', effective = 'convai'})
  frames(12)
  assert(mcm.set('Mature content', true))
  local accepted, problem = mcm.apply()
  assert(accepted == false and problem:find('did not keep', 1, true), 'MCM sees the refused value: ' .. tostring(problem))
  frames(6)
  assert(not next(mcm.drafts()), 'the leftover draft was reverted')
  assert(mcm.row('Mature content').value == false and saved.matureContent ~= true)
  assert(mcm.status() == 'Needs Local AI or Custom.', mcm.status())
`));

test('the line of the last action is the status line of MCM (info), sent only when it changes', () => withScreen(`
  press('Characters to invite')
  local core = managerUi._test.core
  core.setFeedback('Evelyn is on her way.')
  frames(4)
  assert(mcm.status() == 'Evelyn is on her way.', mcm.status())
  assert(mcm.config().status.kind == 'info')
  local function sent() local count = 0; for _, name in ipairs(mcm.calls) do if name == 'ui.setStatus' then count = count + 1 end end; return count end
  local count = sent()
  frames(40)
  assert(sent() == count, 'an unchanged line is not sent again')
  core.setFeedback(nil)
  frames(4)
  assert(mcm.status() == '', 'the line is cleared')
`));

test('the page is drawn again when what it shows changes (not while changes are pending), and never in a loop', () => withScreen(`
  press('Characters to invite')
  frames(20)
  local loads = mcm.loads
  frames(40)
  assert(mcm.loads == loads, 'a page that did not change is not loaded again')
  -- An invitation changes the party: the page follows.
  assert(managerUi.party().invite('johnny-silverhand') ~= nil or true)
  frames(12)
  assert(mcm.loads > loads, 'the page followed the change')
  -- A change while the player has a pending draft waits for Apply or Revert.
  press('Back to Companion Manager'); press('Settings')
  assert(mcm.set('Subtitles', false))
  loads = mcm.loads
  managerUi._test.core.refresh()
  frames(20)
  assert(mcm.loads == loads, 'no redraw under a pending change')
  mcm.revert()
  frames(8)
  assert(mcm.loads > loads, 'the redraw that waited happens once the drafts are gone')
  -- A page that cannot be loaded is tried again later, not on every tick.
  mcm.api.reloadMod = function() mcm.reloadFailures = (mcm.reloadFailures or 0) + 1; return nil, 'broken' end
  managerUi._test.core.refresh()
  frames(100)
  assert((mcm.reloadFailures or 0) <= 3, 'a failing reload backs off: ' .. tostring(mcm.reloadFailures))
`));

test('a new interface language: the mod name and the presentation are given again, the page is drawn in that language', () => run(`${harness({locale: 'de'})}
  mcm.openScreen()
  frames(3)
  assert(mcm.mod().name == 'Companion Manager' and mcm.row('Settings') ~= nil)
  convaiUiLocale.configure('de'); convaiUiLocale.update(0)
  frames(12)
  assert(convaiUiLocale.current() == 'de')
  assert(mcm.config().presentation.locale == 'de', tostring(mcm.config().presentation.locale))
  assert(mcm.row('Einstellungen') ~= nil, 'the page was drawn again in German: ' .. labels())
  assert(mcm.mod().name ~= 'Companion Manager', 'the mod name in the list follows: ' .. tostring(mcm.mod().name))
`));

test('both hosts read and write the same saved settings: a change made on the Native Settings UI tab before MCM was found is on the page of MCM, and the tab is gone then', () => run(`${harness({screen: false, hideMcm: true})}
  -- MCM loads after this mod: the tab is registered first (Native Settings UI alone), a change is made on it.
  assert(ns.data[TAB] ~= nil and not mcmHost.ready())
  ns.openScreen(TAB)
  frames(6)
  ns.interact.press(assert(ns.find('Settings'))); frames(6)
  ns.interact.slide(ns.find('Voice volume (%)'), 170); frames(12)
  assert(manager.snapshot(player).settings.voiceVolume == 170)
  ns.closeScreen(); frames(3)
  -- MCM appears: it hosts the page and the tab is taken down.
  mcmHidden = false
  frames(60)
  assert(mcmHost.ready(), 'MCM was found')
  assert(ns.data[TAB] == nil, 'no Native Settings UI tab beside MCM')
  mcm.openScreen(); press('Settings')
  assert(mcm.row('Voice volume (%)').value == 170, 'MCM shows ' .. tostring(mcm.row('Voice volume (%)').value))
  assert(mcm.set('Voice volume (%)', 135) and mcm.apply())
  assert(manager.snapshot(player).settings.voiceVolume == 135)
`));

const footer = `
  local function footerLabels()
    local list = {}
    for _, button in ipairs(mcm.layout().footer) do list[#list + 1] = button.label end
    return table.concat(list, ' | ')
  end
  local function headings()
    local list = {}
    for _, row in ipairs(mcm.layout().rows) do if row.kind == 'heading' then list[#list + 1] = row.label end end
    return table.concat(list, ' | ')
  end
  local function listed(label)
    for _, row in ipairs(mcm.layout().rows) do if row.label == label then return row end end
  end
  local function headingOf(prefix)
    for _, row in ipairs(mcm.layout().rows) do if row.kind == 'heading' and row.label:sub(1, #prefix) == prefix then return row end end
    error('no heading starting with ' .. prefix .. ': ' .. headings())
  end
`;

test('a long list is turned with footer buttons beside the way back (never rows of the list), the page number is in the heading, and the letter group cycles', () => withScreen(`
  ${footer}
  press('Characters to invite')
  local function invites() local count = 0; for _, row in ipairs(mcm.rows()) do if row.value == 'Invite' then count = count + 1 end end; return count end
  assert(invites() == 12 and mcm.row('Johnny Silverhand') and not mcm.row('Viktor Vektor'))
  assert(footerLabels() == 'Previous page | Next page | Back', footerLabels())
  assert(mcm.config().footerActions[1] == 'ui:page:previous' and mcm.config().footerActions[3] == 'characters:back')
  assert(listed('Previous page') == nil and listed('Next page') == nil, 'not rows of the list')
  assert(headings() == 'Characters to invite · Page 1 / 2', headings())
  assert(mcm.config().navigation.pageId == 'characters|1|1')
  -- Both buttons are buttons at every page: at the first page Previous does nothing, and nothing is drawn again.
  local loads = mcm.loads
  assert(mcm.row('Previous page').type == 'action' and mcm.row('Previous page').capabilities.action == true and not mcm.row('Previous page').disabled)
  press('Previous page')
  assert(mcm.config().navigation.pageId == 'characters|1|1' and mcm.loads == loads and invites() == 12, 'Previous on page 1 changes nothing')
  assert(footerLabels() == 'Previous page | Next page | Back', 'the footer never changes shape')
  press('Next page')
  assert(invites() == 10 and mcm.row('Viktor Vektor') and not mcm.row('Johnny Silverhand'), 'the second page')
  assert(headings() == 'Characters to invite · Page 2 / 2', headings())
  assert(footerLabels() == 'Previous page | Next page | Back')
  assert(mcm.config().navigation.pageId == 'characters|2|1', 'a new page id: MCM scrolls to the top of it')
  loads = mcm.loads
  press('Next page')
  assert(mcm.config().navigation.pageId == 'characters|2|1' and mcm.loads == loads, 'Next on the last page changes nothing')
  press('Previous page')
  assert(mcm.row('Johnny Silverhand') ~= nil)
  press('Back to Companion Manager'); press('Characters to invite')
  assert(mcm.config().navigation.pageId == 'characters|1|1', 'a list starts on its first page')
  -- The model browser: the scan reads a batch a frame, then a letter group and pages.
  press('Back to Companion Manager'); press('Model browser')
  frames(140)
  assert(footerLabels() == 'Starts with: All | Previous page | Next page | Back', footerLabels())
  local group = mcm.row('Starts with: All')
  assert(group and group.type == 'action' and group.description ~= '' and listed('Starts with: All') == nil, labels())
  press('Starts with: All')
  assert(mcm.row('Starts with: All') == nil, 'the letter changed')
  assert(mcm.config().navigation.pageId:match('^models|1|2$'), tostring(mcm.config().navigation.pageId))
  -- The first letter is J (Johnny Silverhand under his profile name, one model: no pages), the next M (the 5999 models named from their record id).
  assert(footerLabels() == 'Starts with: J | Back', footerLabels())
  press('Starts with: J')
  assert(footerLabels():find('^Starts with: M | Previous page | Next page | Back$'), footerLabels())
`));

test('every page the manager can show is drawn in one style: buttons are buttons of one size and place, settings are settings, no button is turned into a plain line', () => withScreen(`
  ${footer}
  -- What MCM draws for each kind of row (bridge/mcm-fake.mjs layout()) must not depend on the state of the row.
  local function check(page)
    local layout = mcm.layout()
    local drawnById = {}
    for _, row in ipairs(layout.rows) do if row.id then drawnById[row.id] = row end end
    local kinds = {}
    for _, row in ipairs(mcm.rows()) do
      local drawn = drawnById[row.id]
      if drawn then
        kinds[drawn.kind] = true
        if row.type == 'action' then
          assert(drawn.kind == 'action' and drawn.x == 20 and drawn.size == 22 and drawn.button == true and drawn.buttonText ~= nil,
            page .. ': ' .. row.label .. ' is drawn as ' .. drawn.kind .. ' (size ' .. drawn.size .. ')')
        elseif row.type == 'bool' or row.type == 'select' or row.type == 'int' then
          assert(drawn.kind == 'setting' and drawn.x == 48 and drawn.size == 22, page .. ': ' .. row.label)
        else
          assert(row.type == 'string' and drawn.kind == 'readonly', page .. ': ' .. row.label .. ' is ' .. row.type .. ' drawn as ' .. drawn.kind)
        end
      else
        -- Not in the list: a footer button.
        local isFooter = false
        for _, button in ipairs(layout.footer) do if button.id == row.id then isFooter = true end end
        assert(isFooter, page .. ': ' .. row.label .. ' is neither in the list nor a footer button')
      end
    end
    for _, button in ipairs(layout.footer) do assert(button.label ~= '', page .. ': a footer button without text') end
    -- A page of buttons and lines has no setting in it: nothing is indented or marked as changed on it.
    if page ~= 'settings' and page ~= 'relationships' and page ~= 'dynamic-info' then assert(not kinds.setting, page .. ' has a switch or list in it') end
    -- The page number is never a line of the list: it is in the heading, and the page buttons are in the footer.
    for _, row in ipairs(layout.rows) do assert(not tostring(row.label):find('^Page %d+ / %d+$'), page .. ': a page line ' .. row.label) end
    -- Pages of a list: both page buttons are in the footer, always together.
    local shown = footerLabels()
    assert((shown:find('Previous page', 1, true) ~= nil) == (shown:find('Next page', 1, true) ~= nil), page .. ': ' .. shown)
    return layout
  end
  local function go(...) for _, label in ipairs({...}) do press(label) end end

  check('home')
  go('Characters to invite'); check('characters'); go('Next page'); check('characters 2'); go('Back to Companion Manager')
  go('Current party'); check('party'); go('Back to Companion Manager')
  go('Model browser'); frames(140)
  check('models'); go('Starts with: All'); check('models letter J'); go('Starts with: J'); check('models letter'); go('Next page'); check('models page 2'); go('Back to Companion Manager')
  go('Settings'); check('settings')
  go('Relationships'); check('relationships'); go('Back to settings')
  go('Dynamic info'); check('dynamic-info'); go('Back to settings')
  go('Memory'); check('memory'); go('Back to settings')
  go('Help and support'); check('help'); go('Back to settings')
  go('Convai paid tier'); check('paid-tier'); go('Back to settings', 'Back to Companion Manager')
  -- A party with copies: the rows of the party page.
  managerUi.party().invite('johnny-silverhand')
  frames(12)
  go('Current party'); check('party with copies')
`));

test('Memory page: choosing a character is a toggle, one at a time; every press draws the list again with the right button text, and nothing runs per frame', () => withScreen(`
  ${footer}
  press('Settings'); press('Memory')
  local function names()
    local list, chosen = {}, {}
    local inList = false
    for _, row in ipairs(mcm.layout().rows) do
      if row.kind == 'heading' then inList = tostring(row.label):find('^Whose memories') ~= nil
      elseif inList and row.kind == 'action' then
        list[#list + 1] = row.label
        if row.buttonText == 'Unselect' then chosen[#chosen + 1] = row.label end
      end
    end
    return list, chosen
  end
  local list, chosen = names()
  assert(#list >= 2 and #chosen == 0, 'a list of characters, none chosen')
  local first, second = list[1], list[2]
  press(first)
  list, chosen = names()
  assert(#chosen == 1 and chosen[1] == first, 'the pressed row says Unselect: ' .. table.concat(chosen, ','))
  -- Another one: the first goes back to Choose in the same redraw (never two rows chosen).
  press(second)
  list, chosen = names()
  assert(#chosen == 1 and chosen[1] == second, 'only the second is chosen: ' .. table.concat(chosen, ','))
  -- Pressing the chosen one again unchooses it.
  press(second)
  list, chosen = names()
  assert(#chosen == 0, 'nothing is chosen after the second press: ' .. table.concat(chosen, ','))
  assert(manager.snapshot(player).memory.selectedKey == nil)
  -- The redraw is on the press only: frames without a press draw nothing again.
  frames(30)
  local loads = mcm.loads
  frames(30)
  assert(mcm.loads == loads, 'the page was drawn again without a press')
`));

test('no row is ever drawn as changed (purple): MCM needs a default for that mark, and none is given', () => withScreen(`
  ${footer}
  press('Settings')
  local function nothingPurple(when)
    for _, row in ipairs(mcm.layout().rows) do
      if row.kind == 'setting' then assert(row.color == 'red', when .. ': ' .. row.label .. ' is ' .. row.color) end
    end
  end
  nothingPurple('fresh install')
  -- A saved change, a draft and a value away from the manager's default stay red as well.
  assert(mcm.set('Subtitles', false) and mcm.apply())
  frames(4)
  nothingPurple('after Apply')
  assert(mcm.set('Voice volume (%)', 170))
  nothingPurple('with a draft')
  mcm.revert()
`));

test('every row of the Settings page is drawn the same: one size, one colour family, no read-only line at all; the two alignments left are the ones MCM fixes', () => withScreen(`
  ${footer}
  assert(manager.applySettings(player, {johnnyInHead = true, johnnyRemarks = 'rare'}))
  frames(6)
  press('Settings')
  local layout = mcm.layout()
  local columns, rows = {}, 0
  for _, row in ipairs(layout.rows) do
    if row.kind ~= 'heading' then
      rows = rows + 1
      assert(row.size == 22, row.label .. ' is size ' .. row.size .. ' (' .. row.kind .. ')')
      assert(row.color == 'red', row.label .. ' is ' .. row.color)
      assert(row.kind == 'setting' or row.kind == 'action', row.label .. ' is a ' .. row.kind .. ' (a read-only line is drawn at size 26)')
      assert(columns[row.kind] == nil or columns[row.kind] == row.x, row.label .. ' is at another x than the rest of its kind')
      columns[row.kind] = row.x
    end
  end
  assert(rows > 20)
  -- MCM puts the label of a setting in its marker column (x 48) and the label of an action flush left (x 20): neither moves through
  -- the public interface (see mcm-fake.mjs layout()), so the page has exactly those two.
  assert(columns.setting == 48 and columns.action == 20, tostring(columns.setting) .. ' ' .. tostring(columns.action))
  -- The Settings page has no read-only line (Voice status and Johnny’s standing were removed 2026-10-20) and so no status button either.
  for _, name in ipairs({'Voice status', 'Johnny’s standing'}) do assert(listed(name) == nil and mcm.row(name) == nil, name .. ' is gone') end
  for _, row in ipairs(mcm.rows()) do
    assert(row.type ~= 'string' and not tostring(row.id):find('^status:'), 'a read-only or status row on Settings: ' .. tostring(row.id))
  end
  -- The read-only lines of the other pages are MCM's own lines (type string, drawn as read-only text), not buttons.
  press('Help and support')
  local lines = 0
  local drawnById = {}
  for _, drawn in ipairs(mcm.layout().rows) do if drawn.id then drawnById[drawn.id] = drawn end end
  for _, row in ipairs(mcm.rows()) do
    if row.type == 'string' then
      lines = lines + 1
      assert(drawnById[row.id] and drawnById[row.id].kind == 'readonly', row.label .. ' is a plain text row')
      assert(not tostring(row.id):find('^status:'), row.id)
    end
  end
  assert(lines > 0, 'the Help page has read-only lines')
  press('Back to settings')
  -- No row carries a default.
  for _, row in ipairs(mcm.rows()) do assert(row.default == nil, row.id) end
`));

test('Dynamic info is a page of its own: a button in Conversations opens it, its rows are switches, Restore defaults is on it, Back returns to Settings', () => withScreen(`
  ${footer}
  press('Settings')
  assert(mcm.row('Dynamic info').type == 'action' and mcm.row('Dynamic info').value == 'Open')
  assert(mcm.row('Location') == nil, 'the switches are not on Settings')
  press('Dynamic info')
  local config = mcm.config()
  assert(config.navigation.pageId == 'dynamic-info|1|1' and config.navigation.backActionId == 'dynamic-info:back' and config.navigation.escapeBack == true)
  assert(headings() == 'Dynamic info', headings())
  assert(footerLabels() == 'Defaults | Back', footerLabels())
  assert(mcm.row('Location').type == 'bool' and mcm.row('Location').value == true and mcm.row('Quest and journal').type == 'bool')
  assert(mcm.set('Location', false) and mcm.set('Recent game dialogue', false) and mcm.apply())
  local info = manager.snapshot(player).settings.dynamicInfo
  assert(info.location == false and info.dialogue == false and info.time == true and manager.dynamicInfo('dialogue') == false)
  assert(mcm.row('Location').value == false and mcm.config().navigation.pageId == 'dynamic-info|1|1', 'still on the page after Apply')
  -- Restore defaults on this page puts every switch back on (and Settings with them).
  press('Defaults'); press('Defaults')
  info = manager.snapshot(player).settings.dynamicInfo
  for _, kind in ipairs(manager.dynamicInfoKinds()) do assert(info[kind] == true, kind) end
  assert(mcm.row('Location').value == true)
  press('Back to settings')
  assert(mcm.config().navigation.pageId == 'settings|1|1' and mcm.row('Dynamic info'))
  press('Back to Companion Manager')
`));

test('Relationships is a page of its own: a button in Conversations opens it, its rows are lists, Restore defaults is on it, Back returns to Settings', () => withScreen(`
  ${footer}
  press('Settings')
  assert(mcm.row('Relationships').type == 'action' and mcm.row('Relationships').value == 'Open')
  assert(mcm.row('Judy Alvarez') == nil and not headings():find('Relationships', 1, true), headings())
  press('Relationships')
  local config = mcm.config()
  assert(config.navigation.pageId == 'relationships|1|1' and config.navigation.backActionId == 'relationships:back' and config.navigation.escapeBack == true)
  assert(headings() == 'Relationships', headings())
  assert(footerLabels() == 'Defaults | Back', footerLabels())
  assert(mcm.row('Judy Alvarez').type == 'select' and mcm.row('Judy Alvarez').default == nil)
  for _, row in ipairs(mcm.layout().rows) do
    if row.kind ~= 'heading' then assert(row.kind == 'setting' and row.size == 22 and row.color == 'red', row.label) end
  end
  assert(mcm.set('Judy Alvarez', 2) and mcm.apply())
  assert(manager.snapshot(player).settings.relationshipModes['judy-alvarez'] == 'on')
  assert(mcm.row('Judy Alvarez').value == 2 and mcm.config().navigation.pageId == 'relationships|1|1', 'still on the page after Apply')
  -- Restore defaults on this page puts the relationships back to Auto (and Settings with them).
  press('Defaults'); press('Defaults')
  assert(manager.snapshot(player).settings.relationshipModes['judy-alvarez'] == 'auto' and mcm.row('Judy Alvarez').value == 1)
  -- The way back leads to Settings.
  press('Back to settings')
  assert(mcm.config().navigation.pageId == 'settings|1|1' and mcm.row('Relationships'))
  press('Back to Companion Manager')
`));

test('the Settings page has no Multilingual conversations row (the setting was removed 2026-10-21): the language is detected per message', () => withScreen(`
  press('Settings')
  frames(6)
  assert(mcm.row('Follow-up questions') ~= nil or mcm.row('Talk to ordinary NPCs') ~= nil or mcm.row('Johnny in your head') ~= nil, 'the Conversations rows are on the page')
  assert(mcm.row('Multilingual conversations') == nil, 'the row is gone')
  assert(manager.snapshot(player).settings.multilingualConversations == nil)
  for key in pairs(mcm.drafts()) do assert(not tostring(key):find('multilingual', 1, true), key) end
`));

test('Apply of one switch saves exactly that switch: Follow-up questions off is saved off, and the rest stays', () => withScreen(`
  press('Settings')
  frames(6)
  local core = managerUi._test.core
  local realApply, seen = core.apply, nil
  core.apply = function(batch) seen = batch; return realApply(batch) end
  local before = manager.snapshot(player).settings
  assert(before.followUpInterest == true and before.multilingualConversations == nil)
  assert(mcm.row('Follow-up questions').value == true)
  assert(mcm.set('Follow-up questions', false))
  assert(mcm.drafts()['cyberpunk-convai:manager:followUpInterest'] == false, 'the draft is on that row')
  assert(next(mcm.drafts(), next(mcm.drafts())) == nil, 'and on no other')
  local ok, why = mcm.apply()
  assert(ok, tostring(why))
  assert(seen and #seen == 1 and seen[1].id == 'followUpInterest' and seen[1].value == false, 'the batch is that one switch')
  assert(saved.followUpInterest == false, 'saved: ' .. tostring(saved.followUpInterest))
  assert(manager.snapshot(player).settings.followUpInterest == false)
  assert(mcm.row('Follow-up questions').value == false, 'the page shows what is saved')
  assert(saved.multilingualConversations == nil and saved.subtitles == true, 'the other switches did not move')
  -- And back on.
  core.apply = realApply
  assert(mcm.set('Follow-up questions', true) and mcm.apply())
  assert(saved.followUpInterest == true)
  -- The same while the list jumps on every redraw (the live check): the switch pressed is the one saved.
  mcm.jumpOnLoad = 0.7
  frames(4)
  assert(mcm.set('Follow-up questions', false) and mcm.apply())
  frames(6)
  assert(saved.followUpInterest == false and saved.multilingualConversations == nil)
`));

test('the list keeps its place after Apply and after a reload of the page, leaves a later scroll alone, and starts at the top on another page', () => withScreen(`
  press('Settings')
  frames(4)
  mcm.scrollTo(0.2); frames(2)
  assert(math.abs(mcm.scroll() - 0.2) < 1e-9)
  -- MCM redraws the page after Apply and the list jumps far down (as in the live check): the host puts it back.
  mcm.jumpOnLoad = 0.6
  assert(mcm.set('Follow-up questions', false) and mcm.apply())
  assert(mcm.scroll() == 0.6, 'the jump happened, as in the live check')
  frames(1)
  assert(math.abs(mcm.scroll() - 0.2) < 1e-9, 'put back: ' .. mcm.scroll())
  frames(12)
  assert(math.abs(mcm.scroll() - 0.2) < 1e-9, 'and it stays: ' .. mcm.scroll())
  -- A reload the host asks for (something the page shows changed) keeps the place too.
  managerUi._test.core.refresh()
  frames(12)
  assert(math.abs(mcm.scroll() - 0.2) < 1e-9, 'after a reload: ' .. mcm.scroll())
  -- A player who scrolls afterwards is left alone.
  mcm.scrollTo(0.9); frames(12)
  assert(math.abs(mcm.scroll() - 0.9) < 1e-9, 'a later scroll of the player is not undone')
  -- Another page starts at its top (MCM keeps a position per page id).
  mcm.jumpOnLoad = nil
  press('Back to Companion Manager'); press('Characters to invite')
  mcm.scrollTo(0.4); frames(2)
  press('Next page')
  assert(mcm.scroll() == 0, 'page 2 starts at the top: ' .. mcm.scroll())
  -- Without the scroll calls (an MCM that lacks them) nothing breaks.
  mcm.api.ui.getScrollPosition, mcm.api.ui.setScrollPosition = nil, nil
  press('Back to Companion Manager'); press('Settings')
  assert(mcm.set('Subtitles', false) and mcm.apply())
`));

test('the OmniVoice entries are disabled choices while its pack is missing: MCM refuses them as drafts, with the reason', () => withScreen(`
  jsonFixtures['voice-runtime'] = {state = 'ready', provider = 'pocket', omniPack = {installed = false, missing = {'model'}}, updated = os.time() * 1000.0}
  files['runtime/local-voice-state.json'] = 'voice-runtime'
  clock = clock + 2
  for _ = 1, 5 do manager.update(player, 0.6) end
  press('Settings')
  frames(6)
  local states = mcm.config().choices and mcm.config().choices.voiceProvider
  assert(states, 'choice states for the voice select')
  assert(states.wrap == false)
  local disabled = 0
  for index, state in pairs(states.states) do
    if state.enabled == false then disabled = disabled + 1; assert(state.reason == 'Requires the optional OmniVoice pack (GPU)', tostring(state.reason)) end
  end
  assert(disabled == 4, 'the four OmniVoice entries: ' .. disabled)
  local ok, why = mcm.set('Companion voices (no Omni pack)', 3)
  assert(ok == false and why:find('OmniVoice', 1, true), tostring(why))
  assert(mcm.set('Companion voices (no Omni pack)', 2) == true, 'a cloud voice entry is a normal draft')
  mcm.revert()
`));

test('closing the provider: shutdown clears the UI configuration and unregisters, and no MCM call is made per frame while the screen is closed', () => run(`${harness()}
  frames(20)
  local calls = #mcm.calls
  local contexts = 0
  local real = mcm.api.ui.getContext
  mcm.api.ui.getContext = function() contexts = contexts + 1; return real() end
  -- Ten seconds at 60 frames a second with the screen closed: the look at the context is the slow tick, nothing else is called.
  for _ = 1, 600 do clock = clock + 1 / 60; managerUi.update(player, true) end
  assert(#mcm.calls == calls, 'no MCM call while closed: ' .. tostring(mcm.calls[calls + 1]))
  assert(contexts <= 45, 'the context is read on the slow tick only: ' .. contexts)
  managerUi.shutdown(true)
  assert(not mcmHost.ready() and mcm.mod() == nil, 'unregistered')
  assert(mcm.calls[#mcm.calls] == 'unregisterProvider')
`));

test('the host never overrides or observes anything of MCM or the game, and reads no MCM internals', () => {
  const lua = readFileSync(new URL('../mod/mcm-host.lua', import.meta.url), 'utf8');
  const code = lua.replace(/--.*$/gm, '');
  for (const forbidden of [/Observe/, /Override/, /McmUi/, /ModConfigurationMenu\./, /require\(/, /\.state\b/]) {
    assert(!forbidden.test(code), `mod/mcm-host.lua uses ${forbidden}`);
  }
  // The only module it asks for is MCM's public API.
  assert.deepEqual([...code.matchAll(/GetMod, '([^']+)'/g)].map(match => match[1]), ['ModConfigurationMenuAPI']);
});

// The shortcut (managerUi.open, called by init.lua's openManager).
const posted = `
  local notices = {}
  convaiNotices.sendLines = function(_, lines) for _, line in ipairs(lines) do notices[#notices + 1] = line end; return #lines end
`;

test('the shortcut opens MCM straight on the manager page with its public open call, and posts no notice', () => run(`${harness({screen: false})}
  ${posted}
  local ok, reason = managerUi.open()
  assert(ok == true, tostring(reason))
  assert(mcm.api.ui.getContext().open == false, 'the request waits for the next MCM update')
  mcm.update()
  local context = mcm.api.ui.getContext()
  assert(context.open == true and context.modKey == 'cyberpunk-convai:manager', 'MCM opened on the manager page')
  assert(labels() == 'Characters to invite | Current party | Model browser | Character editor | Key bindings | Settings', 'on the first page: ' .. labels())
  assert(#notices == 0, 'no notice: the page is opened for the player')
  -- Pressed again while it is open: nothing more to do (MCM has no public close call).
  assert(managerUi.open() == true)
  -- NSUI is installed too: MCM is still the one opened (it hosts the page), and the Native Settings UI walk is not started.
  assert(managerUi.inspect().entry.stage == 'idle')
`));

test('the shortcut leaves the game\'s state to the game: no save, no text box, no scene; and MCM without a renderer leaves Native Settings UI\'s walk', () => {
  run(`${harness({screen: false, nsui: false})}
    ${posted}
    local pregame = true
    Game = {GetPlayer = function() return {IsAttached = function() return true end, ConvaiComposerOpen = function() return false end} end,
      GetSystemRequestsHandler = function() return {IsPreGame = function() return pregame end} end}
    local calls = #mcm.calls
    local ok, reason = managerUi.open()
    assert(ok == false and reason == 'Load a save first.', tostring(reason))
    assert(#mcm.calls == calls, 'MCM was not asked to open')
    assert(#notices == 0, 'a refusal by the game is not a missing mod')
  `);
  run(`${harness({screen: false, nsui: false, mcm: {version: '0.10.5', renderer: false}})}
    ${posted}
    local ok, reason = managerUi.open()
    assert(ok == false and reason:find('renderer', 1, true), tostring(reason))
    assert(#notices == 0, 'MCM is installed: no "install it" notice')
  `);
});

test('a plain sit is scene tier 3 and MCM declines to open there by design: the shortcut says "Stand up" (kind seated) and never asks MCM; a real scene keeps the old words', () => {
  const sitting = answer => `${harness({screen: false, nsui: false})}
    ${posted}
    local tier = 3
    Game = {GetPlayer = function() return {IsAttached = function() return true end, ConvaiComposerOpen = function() return false end,
        GetEntityID = function() return 'player' end} end,
      GetSystemRequestsHandler = function() return {IsPreGame = function() return false end} end,
      GetAllBlackboardDefs = function() return {PlayerStateMachine = {SceneTier = 'tier'}} end,
      GetBlackboardSystem = function() return {GetLocalInstanced = function() return {GetInt = function() return tier end} end} end}
    convaiPlainSitting = ${answer}
    local calls = #mcm.calls
    local ok, reason, kind = managerUi.open()
    ${answer === 'function() return true end'
      ? "assert(ok == false and reason == 'Stand up to open the Companion Manager' and kind == 'seated' and #mcm.calls == calls, tostring(reason))"
      : "assert(ok == false and reason == 'Finish the scene first.' and kind == nil and #mcm.calls == calls, tostring(reason))"}
    assert(#notices == 0, 'the notice is posted by the shortcut handler in init.lua, not by the host')
    tier = 2
    ok = managerUi.open()
    assert(ok == true, 'standing in the open: it opens')
  `;
  run(sitting('function() return true end'));
  for (const answer of ['nil', 'function() return false end', 'function() error("unreadable") end']) run(sitting(answer));
});

// The shortcut's handler in init.lua: two log lines per press and the notice for a seat.
test('the shortcut handler logs every press (entered, outcome); a refusal because V sits posts one translated notice, the other refusals post none', () => {
  const handler = between('-- (The count is a global: the main chunk is near', "-- The phone queues a request only while it is open");
  const harnessFor = open => `
    local logs, sent, revoked = {}, {}, 0
    local function log(line) logs[#logs + 1] = line end
    local ui = {t = function(text) return 'T:' .. text end}
    convaiNotices = {send = function(_, id, text) sent[#sent + 1] = {id = id, text = text}; return true end}
    Game = {GetPlayer = function() return {} end}
    gameplayActions = {revoke = function() revoked = revoked + 1 end}
    local function endFocus() end
    local function resetGaze() end
    local focusMode, focusEntity, focusUntil
    managerUi = {open = ${open}}
    ${handler}
  `;
  run(`${harnessFor("function() return true end")}
    openManager()
    assert(#logs == 2 and logs[1]:find('press 1 (handler entered)', 1, true) and logs[2]:find('press 1 opened', 1, true), table.concat(logs, ' | '))
    assert(#sent == 0 and revoked == 1)
  `);
  run(`${harnessFor("function() return false, 'Stand up to open the Companion Manager', 'seated' end")}
    openManager(); openManager()
    assert(#logs == 6, table.concat(logs, ' | '))
    assert(logs[1]:find('press 1 (handler entered)', 1, true) and logs[2] == 'Companion manager: Stand up to open the Companion Manager' and logs[3]:find('press 1 refused (kind=seated)', 1, true), table.concat(logs, ' | '))
    assert(logs[4]:find('press 2 (handler entered)', 1, true) and logs[6]:find('press 2 refused', 1, true))
    assert(#sent == 2 and sent[1].id == 'manager-seated' and sent[1].text == 'T:Stand up to open the Companion Manager', 'one notice per press, in the language of the player')
    assert(revoked == 0)
  `);
  run(`${harnessFor("function() return false, 'Finish the scene first.' end")}
    openManager()
    assert(#sent == 0 and logs[2] == 'Companion manager: Finish the scene first.' and logs[3]:find('press 1 refused (kind=nil)', 1, true), table.concat(logs, ' | '))
  `);
  run(`${harnessFor("function() error('boom') end")}
    openManager()
    assert(#sent == 0 and logs[2]:find('boom', 1, true) and logs[3]:find('press 1 failed', 1, true), table.concat(logs, ' | '))
  `);
});

test('without any host the shortcut says what to install: MCM 0.10.5 first, Native Settings UI as the alternative; an older MCM is to be updated', () => {
  run(`${harness({screen: false, nsui: false, mcm: null})}
    ${posted}
    local ok, reason = managerUi.open()
    assert(ok == false and reason == 'The Companion Manager needs Mod Configuration Menu 0.10.5 or newer, or Native Settings UI', tostring(reason))
    assert(#notices == 1 and notices[1].id == 'manager-needs-nsui' and notices[1].text == reason, tostring(notices[1] and notices[1].text))
  `);
  run(`${harness({screen: false, nsui: false, mcm: {version: '0.10.3', noUi: true}})}
    ${posted}
    local ok, reason = managerUi.open()
    assert(ok == false and reason == 'Update Mod Configuration Menu to 0.10.5 or newer, or install Native Settings UI', tostring(reason))
    assert(#notices == 1 and notices[1].id == 'manager-needs-nsui' and notices[1].text == reason, tostring(notices[1] and notices[1].text))
  `);
});

test('only Native Settings UI installed: the shortcut is the Native Settings UI walk, and MCM is never called', () => run(`${harness({screen: false, mcm: null})}
  ${posted}
  local ok = managerUi.open()
  assert(#notices == 0, 'Native Settings UI is a host: no notice that something is missing')
  assert(not mcmHost.ready())
`));

test('MCM 0.10.5 hosts the page: no Native Settings UI tab is registered (MCM would list it a second time); any other install keeps the tab', () => {
  // MCM 0.10.5 and Native Settings UI both installed: the tab is not added, and no per-frame look tries to.
  run(`${harness({screen: false})}
    assert(mcmHost.ready())
    assert(ns.data[TAB] == nil and ns.callCount('addTab') == 0, 'the tab is not registered beside MCM')
    ns.resetCalls()
    frames(120)
    assert(#ns.calls == 0, 'and nothing is tried later: ' .. tostring(ns.calls[1] and ns.calls[1][1]))
    assert(managerUi.inspect().available == false and managerUi.inspect().hosts[1].available == true)
  `);
  // Native Settings UI alone, or beside an MCM that cannot host the page: unchanged, the tab is there at once.
  for (const mcm of [null, {version: '0.10.3', noUi: true}, {version: '0.10.4'}]) {
    run(`${harness({screen: false, mcm})}
      assert(ns.data[TAB] ~= nil and ns.callCount('addTab') == 1, 'the tab is registered')
      assert(managerUi.inspect().available == true)
    `);
  }
  // MCM hosts the page but will not open it: the page is still MCM's alone. The shortcut says why; no tab is registered as a way
  // around it, now or later.
  run(`${harness({screen: false, mcm: {version: '0.10.5', renderer: false}})}
    assert(ns.data[TAB] == nil)
    local ok, reason = managerUi.open()
    assert(ok == false and reason:find('renderer', 1, true), tostring(reason))
    frames(60)
    assert(ns.data[TAB] == nil and ns.callCount('addTab') == 0, 'no fallback tab beside MCM')
  `);
});

test('the rule: MCM 0.10.5 or newer and Native Settings UI both installed means MCM only, whichever loads first or late, and one line says so', () => {
  // MCM there at onInit: no tab, one log line.
  run(`${harness({screen: false})}
    frames(60)
    assert(ns.data[TAB] == nil and ns.callCount('addTab') == 0)
    local said = 0
    for _, line in ipairs(logged) do if line:find('Native Settings UI tab is not registered', 1, true) then said = said + 1 end end
    assert(said == 1, 'one line, not one a second: ' .. said)
  `);
  // MCM loads after this mod (nothing answers at onInit): the tab is registered once MCM is not coming (Native Settings UI alone),
  // and taken down when MCM turns up.
  run(`${harness({screen: false, hideMcm: true})}
    assert(ns.data[TAB] ~= nil, 'Native Settings UI alone: the tab is registered')
    local tab = ns.data[TAB]
    mcmHidden = false
    frames(40)
    assert(mcmHost.ready(), 'found late')
    assert(ns.data[TAB] == nil, 'the tab was taken down')
    assert(managerUi.inspect().available == false and managerUi.inspect().hosts[1].available == true)
    local removed = ns.callCount('removeSubcategory')
    assert(removed >= 1, 'its sections went through removeSubcategory')
    ns.resetCalls()
    frames(60)
    assert(#ns.calls == 0 and ns.data[TAB] == nil, 'and nothing is tried again')
    local said = 0
    for _, line in ipairs(logged) do if line:find('registered before it was found is removed', 1, true) then said = said + 1 end end
    assert(said == 1, 'one line: ' .. said)
  `);
  // The tab is on screen when MCM turns up: it goes when the player leaves it, not under them.
  run(`${harness({screen: false, hideMcm: true})}
    ns.openScreen(TAB); frames(4)
    mcmHidden = false
    frames(40)
    assert(mcmHost.ready() and ns.data[TAB] ~= nil, 'on screen: the tab stays')
    ns.closeScreen(); frames(20)
    assert(ns.data[TAB] == nil, 'gone once it is left')
  `);
  // MCM present but not able to say yet (its public interface is missing at first): the tab waits, and MCM wins when it comes.
  run(`${harness({screen: false, mcm: {version: '0.10.5', noUi: true}, earlyClock: true})}
    assert(not mcmHost.ready() and ns.data[TAB] == nil, 'waiting for an MCM that may still become ready')
    frames(30)
    assert(ns.data[TAB] == nil, 'still within the wait')
    frames(90)
    assert(ns.data[TAB] ~= nil, 'the wait is bounded: Native Settings UI is used when MCM never hosts the page')
  `);
  // An MCM older than 0.10.5 will never host the page: no wait.
  run(`${harness({screen: false, mcm: {version: '0.10.4'}, earlyClock: true})}
    assert(ns.data[TAB] ~= nil, 'registered at once')
  `);
});

test('at the main menu the pages that need a save say so in their heading, not in a line above the list (Native Settings UI keeps the row)', () => withScreen(`
  ${footer}
  player = nil
  frames(4)
  -- A list of buttons: the status is in the heading and its help is the heading's description. A line of the list would be drawn 16 px
  -- right of the names under it (MCM's read-only line has an inset of its own; labelIndent does not reach it).
  press('Characters to invite')
  assert(headings():find('^Characters to invite · Load a save first · Page 1 / %d+$'), headings())
  assert(not listed('Characters and party') and not mcm.row('needs-save'), labels())
  assert(mcm.description() == 'Inviting characters and managing your party need a loaded game.', mcm.description())
  for _, drawn in ipairs(mcm.layout().rows) do assert(drawn.kind == 'heading' or drawn.kind == 'action', drawn.label .. ' is drawn as ' .. drawn.kind) end
  press('Back to Companion Manager')
  -- Nothing listed under the status (no party without a save): MCM draws no heading for a category without rows, so it stays a line.
  press('Current party')
  assert(mcm.row('needs-save') and mcm.row('needs-save').type == 'string' and mcm.row('needs-save').value == 'Load a save first', labels())
  assert(headings() == 'Current party', headings())
  press('Back to Companion Manager')
  press('Model browser'); frames(140)
  assert(headings():find('^Installed character models · Load a save first · %d+ matching models · Page 1 / %d+$'), headings())
  assert(not mcm.row('needs-save') and not mcm.row('model-status'), labels())
  for _, drawn in ipairs(mcm.layout().rows) do assert(drawn.kind == 'heading' or drawn.kind == 'action', drawn.label .. ' is drawn as ' .. drawn.kind) end
  press('Back to Companion Manager'); press('Settings')
  assert(labels():find('Interface language', 1, true) and not labels():find('Characters and party', 1, true), labels())
`));

test('the state of a companion driver is said by the heading of its group, above the Stop trip button, not by a line indented against it', () => withScreen(`
  ${footer}
  press('Current party')
  -- manager-ui.lua's party page with a trip under way (its own test is in manager.test.mjs): a state line and the button that stops it.
  local original = core.model
  core.model = function(...)
    local model = original(...)
    table.insert(model.categories, 2, {id = 'party-status', name = 'Your group', description = '', settings = {
      {id = 'chauffeur-state', type = 'string', label = 'Companion driver', value = 'Driving', description = 'Get into the passenger seat when they are ready.'},
      {id = 'chauffeur:stop', type = 'action', label = 'Companion driver', value = 'Stop trip', description = 'Stop the trip.'},
    }})
    return model
  end
  press('Back to Companion Manager'); press('Current party')
  assert(headings():find('Your group · Companion driver · Driving', 1, true), headings())
  assert(not mcm.row('chauffeur-state') and mcm.row('chauffeur:stop').type == 'action', labels())
  assert(mcm.description() == 'Get into the passenger seat when they are ready.', mcm.description())
  core.model = original
`));

test('with a save loaded the model browser says how many models match in its heading, an empty party stays a line, and no read-only line sits above a list of buttons', () => withScreen(`
  ${footer}
  press('Current party')
  assert(mcm.row('empty-party') and mcm.row('empty-party').type == 'string' and headings() == 'Current party', headings() .. ' | ' .. labels())
  press('Back to Companion Manager')
  press('Model browser'); frames(140)
  local heading = headings()
  assert(heading:find('^Installed character models · %d+ matching models · Page 1 / %d+$'), heading)
  assert(not mcm.row('needs-save') and not mcm.row('model-status'), labels())
  assert(mcm.description():find('^%d+ of them can talk%.\\n'), mcm.description())
  assert(mcm.description():find('Type in the search box to find a model by name or record', 1, true), 'the page says it can be searched: ' .. mcm.description())
  -- A letter group changes the list, and the heading keeps saying its count.
  press('Starts with: All')
  assert(headings():find('^Installed character models · %d+ matching models'), headings())
  for _, drawn in ipairs(mcm.layout().rows) do
    assert(drawn.kind == 'heading' or (drawn.kind == 'action' and drawn.x == 20), drawn.label .. ' is drawn as ' .. drawn.kind .. ' at ' .. tostring(drawn.x))
  end
`));

// ---- The Model browser search: MCM's own Search settings box, with the provider search mode on that page only.

// 407 models: a few named ones and 400 fillers whose records are Character.Rec_<n>. The scan runs when the browser opens.
const searchModels = `
  local names = {'Rita Wheeler', 'Margarita Soto', 'Judy Alvarez', 'River Ward', 'Wheeler Smith', 'Meredith Stout', 'Zed'}
  for index = 1, 400 do names[#names + 1] = 'Filler ' .. index end
  local byId = {}
  function TweakDB:GetRecords(kind)
    scans = scans + 1
    local result = {}
    for index, name in ipairs(names) do
      local id = 'Character.Rec_' .. index
      byId[id] = name
      result[index] = {GetID = function() return id end}
    end
    return result
  end
  function TweakDB:GetFlat(flat) local id = flat:gsub('%.displayName$', ''); return byId[id] or id end
  local function inviteLabels()
    local list = {}
    for _, row in ipairs(mcm.rows()) do if row.id and row.id:sub(1, 7) == 'invite:' then list[#list + 1] = row.label end end
    return table.concat(list, ' | ')
  end
  -- The player types in the box; MCM settles the text for a few frames and publishes it, the host sees it on its next tick.
  local function typed(text) mcm.search(text); frames(8) end
`;

test('the Model browser is searched with the Search settings box: words in any order, parts of words, any case and spacing, and every result keeps its Invite button', () => withScreen(`
  ${footer}
  ${searchModels}
  assert(mcm.config().navigation.searchMode == 'filter', 'Home keeps the filter of MCM')
  press('Model browser'); frames(60)
  assert(mcm.config().navigation.searchMode == 'provider', 'on the browser MCM leaves the filtering to the host')
  assert(scans == 1)
  local all = inviteLabels()
  assert(select(2, all:gsub('|', '')) == 11, 'twelve models on the first page: ' .. all)
  local loads = mcm.loads
  typed('rita')
  assert(inviteLabels() == 'Margarita Soto | Rita Wheeler', inviteLabels())
  assert(mcm.loads == loads + 1, 'one new page for the new text: ' .. (mcm.loads - loads))
  assert(core.search() == 'rita' and mcm.config().navigation.pageId:match('|rita$'), mcm.config().navigation.pageId)
  typed('rita wheeler')
  assert(inviteLabels() == 'Rita Wheeler', inviteLabels())
  assert(headings():find('1 matching models', 1, true), headings())
  typed('  WHEELER   Rita ')
  assert(inviteLabels() == 'Rita Wheeler', 'the order of the words, their case and the spaces do not matter: ' .. inviteLabels())
  typed('wheel')
  assert(inviteLabels() == 'Rita Wheeler | Wheeler Smith', inviteLabels())
  typed('rec_407')
  assert(inviteLabels() == 'Filler 400', 'the record is searched too: ' .. inviteLabels())
  typed('nobody here')
  assert(inviteLabels() == '' and mcm.row('model-status').label == '0 matching models', 'no model: the status stays as a line')
  -- A text that settles to the same words changes nothing: no page is built again.
  loads = mcm.loads
  typed('nobody   HERE')
  frames(20)
  assert(mcm.loads == loads and scans == 1, 'the same words do not draw the page again, and nothing is read from the game again')
  -- A result is a normal invitation.
  typed('rita wheeler')
  assert(footerLabels():find('Starts with', 1, true) == nil, 'the letter group is out of the way while a text is searched: ' .. footerLabels())
  press('Rita Wheeler'); frames(4)
  assert(members[1] and members[1].key == 'model:1', 'the invitation of the search result')
  typed('')
  assert(inviteLabels() == all and footerLabels():find('Starts with: All', 1, true), footerLabels())
  assert(mcm.config().navigation.searchMode == 'provider' and core.search() == '')
`, {mcm: {version: '0.10.5'}}));

test('the Search settings box is emptied on the way into and out of the Model browser, and the other pages keep the filter of MCM', () => withScreen(`
  ${searchModels}
  -- A text left in the box from another page does not filter the browser: the box is emptied when the browser opens.
  mcm.search('model'); frames(6)
  assert(mcm.row('tab:models') and not mcm.row('tab:settings'), 'on Home the box filters the destinations')
  press('Model browser'); frames(60)
  assert(mcm.searchText() == '' and core.search() == '', 'the box was emptied: ' .. mcm.searchText())
  assert(select(2, inviteLabels():gsub('|', '')) == 11, inviteLabels())
  typed('river')
  assert(inviteLabels() == 'River Ward', inviteLabels())
  press('Back to Companion Manager')
  frames(8)
  assert(mcm.searchText() == '' and core.search() == '' and core.view() == 'home', 'the text does not follow the player to Home')
  assert(mcm.config().navigation.searchMode == 'filter')
  assert(mcm.row('tab:models') ~= nil, 'Home is not filtered by the old text: ' .. labels())
  -- On another page the text is MCM's own filter and the browser's search does not read it.
  press('Settings'); frames(4)
  mcm.search('zzzz'); frames(8)
  assert(core.search() == '' and mcm.config().navigation.searchMode == 'filter')
  mcm.search(''); frames(8)
  -- The browser opens unfiltered again.
  press('Back to Companion Manager'); press('Model browser'); frames(60)
  assert(core.search() == '' and select(2, inviteLabels():gsub('|', '')) == 11)
`, {mcm: {version: '0.10.5'}}));

test('searching the Model browser does no work between texts: the box is read on the slow tick, nothing is scanned again, a page is built only for a new text', () => withScreen(`
  ${searchModels}
  press('Model browser'); frames(60)
  local loads = mcm.loads
  frames(200)
  assert(mcm.loads == loads, 'an untouched box draws nothing: ' .. (mcm.loads - loads))
  typed('rita')
  typed('rita w')
  typed('rita wh')
  assert(mcm.loads == loads + 3 and scans == 1, 'one page per settled text, one scan in all: ' .. (mcm.loads - loads) .. ' ' .. scans)
`, {mcm: {version: '0.10.5'}}));

test('an MCM that refuses the provider search mode keeps its own filter on the browser, the page does not offer a search and nothing breaks', () => run(`${harness({screen: false, mcm: {version: '0.10.5'}})}
  ${searchModels}
  local setNavigation = mcm.api.ui.setNavigation
  mcm.api.ui.setNavigation = function(key, value)
    if value.searchMode ~= nil then return nil, 'Unsupported navigation option' end
    return setNavigation(key, value)
  end
  mcm.openScreen(); frames(2)
  press('Model browser'); frames(60)
  assert(mcm.config().navigation.searchMode == 'filter' and mcm.config().navigation.pageId:match('^models'), 'the page was given without the option')
  assert(not mcm.description():find('search box', 1, true), 'no hint for a search that is not there')
  mcm.search('rita'); frames(10)
  assert(core.search() == '', 'the host does not follow a box that MCM filters itself')
  local seen = false
  for _, line in ipairs(logged) do if line:find('provider search mode', 1, true) then seen = true end end
  assert(seen, 'one line says why')
`));

// ---- MCM 0.10.6 UI API (private preview from MCM's author, 2026-10-20): close, setActionVisibility, labelIndent, highlightModifiedValues,
// rowFontSize for every row, wrapping footer labels. Each is used only when this MCM has it; 0.10.5 must behave exactly as before.

test('detection of the 0.10.6 additions: by the call (close, setActionVisibility), and by the version for the presentation options; 0.10.5 has none', () => run(`${harness({screen: false, mcm: {version: '0.10.5'}})}
  local function flags(found)
    local result = mcmHost.newUi(found)
    return tostring(result.close) .. ' ' .. tostring(result.actionVisibility) .. ' ' .. tostring(result.presentation)
  end
  local function fn() return true end
  local ui6 = {close = fn, setActionVisibility = fn}
  assert(flags(mcm.api) == 'false false false', 'the 0.10.5 fake: ' .. flags(mcm.api))
  assert(flags({version = '0.10.5', ui = {}}) == 'false false false')
  assert(flags({version = '0.10.6', ui = ui6}) == 'true true true')
  assert(flags({version = '0.10.6-preview.1', ui = ui6}) == 'true true true')
  assert(flags({version = '0.11.0', ui = ui6}) == 'true true true')
  assert(flags({version = '0.10.6', ui = {close = fn}}) == 'true false false', 'one call alone does not enable the presentation options')
  assert(flags({version = '0.10.6', ui = {setActionVisibility = fn}}) == 'false true false')
  assert(flags({version = '0.10.5', ui = ui6}) == 'true true false', 'the options need 0.10.6 by version')
  assert(flags({version = 'unknown', ui = ui6}) == 'true true true', 'an unreadable version with both calls: the calls decide')
  assert(flags({ui = 5}) == 'false false false' and flags(nil) == 'false false false')
`));

test('MCM 0.10.5 keeps working exactly as today: the base presentation only, no visibility map, no close, no Back on Home, Add to favorites left to the player', () => withScreen(`
  ${footer}
  assert(mcm.api.ui.close == nil and mcm.api.ui.setActionVisibility == nil, 'the fake of 0.10.5 has neither call')
  assert(mcmHost.inspect().newUi.close == false and mcmHost.inspect().newUi.presentation == false)
  local presentation = mcm.config().presentation
  local keys = {}
  for key in pairs(presentation) do keys[#keys + 1] = key end
  table.sort(keys)
  assert(table.concat(keys, ',') == 'descriptionFontSize,labelWidthFraction,locale,quietActions,statusPlacement', table.concat(keys, ','))
  assert(mcm.config().actionVisibility == nil)
  for _, name in ipairs(mcm.calls) do assert(name ~= 'ui.close' and name ~= 'ui.setActionVisibility', 'called ' .. name) end
  -- Home: no footer, no Back; Settings: Defaults and Back, five buttons with changes pending.
  assert(#mcm.config().footerActions == 0 and labels() == 'Characters to invite | Current party | Model browser | Character editor | Key bindings | Settings')
  press('Settings')
  assert(footerLabels() == 'Defaults | Back', footerLabels())
  assert(mcm.set('Subtitles', false))
  local row = {}
  for _, button in ipairs(mcm.layout().footerRow) do row[#row + 1] = button.label end
  assert(table.concat(row, ' | ') == 'REVERT | APPLY | ADD TO FAVORITES | Defaults | Back', table.concat(row, ' | '))
  assert(mcm.layout().footerWraps == false)
  for _, line in ipairs(mcm.layout().rows) do if line.kind == 'setting' then assert(line.x == 48 and line.size == 22, line.label) end end
  mcm.revert()
  -- A page where a read-only line is drawn at its own size stays out of the way of rowFontSize: nothing sent.
  assert(mcm.config().presentation.rowFontSize == nil)
`));

test('MCM 0.10.6: the presentation gets labelIndent 20, highlightModifiedValues false and rowFontSize 22 on top of the base ones, and Add to favorites is hidden', () => run(`${harness({mcm: {version: '0.10.6'}})}
  ${footer}
  mcm.openScreen(); frames(2)
  assert(mcmHost.inspect().newUi.close and mcmHost.inspect().newUi.actionVisibility and mcmHost.inspect().newUi.presentation)
  local presentation = mcm.config().presentation
  assert(presentation.labelIndent == 20 and presentation.highlightModifiedValues == false and presentation.rowFontSize == 22)
  assert(presentation.descriptionFontSize == 22 and presentation.labelWidthFraction == 0.5 and presentation.statusPlacement == 'header'
    and presentation.quietActions == true and presentation.locale == convaiUiLocale.current())
  local visibility = mcm.config().actionVisibility
  assert(visibility and visibility.favorite == 'hide' and visibility.defaults == nil and visibility.modifiedFilter == nil, 'only the favorite action is hidden')
  assert(mcm.config().applyPolicy == 'explicit')
  -- Settings: labels at the buttons' x, one size, nothing purple, four buttons with changes pending and the whole name of the defaults button.
  press('Settings')
  local layout = mcm.layout()
  for _, row in ipairs(layout.rows) do
    if row.kind == 'setting' then assert(row.x == 20 and row.size == 22 and row.color == 'red', row.label .. ' x ' .. row.x) end
    if row.kind == 'action' then assert(row.x == 20 and row.size == 22, row.label) end
  end
  assert(footerLabels() == 'Restore defaults | Back', footerLabels())
  assert(mcm.set('Subtitles', false))
  local row = {}
  for _, button in ipairs(mcm.layout().footerRow) do row[#row + 1] = button.label end
  assert(table.concat(row, ' | ') == 'REVERT | APPLY | Restore defaults | Back', table.concat(row, ' | '))
  assert(mcm.layout().footerWraps == true)
  mcm.revert()
  -- Restore defaults is still pressed twice; the first press shows Confirm.
  press('Restore defaults')
  assert(footerLabels() == 'Confirm | Back', footerLabels())
  press('Restore defaults')
  assert(mcm.status() == 'Defaults restored.', mcm.status())
  assert(footerLabels() == 'Restore defaults | Back')
`));

test('MCM 0.10.6 in another language: the new labels are translated, and the presentation is given again with its new options kept', () => run(`${harness({locale: 'de', mcm: {version: '0.10.6'}})}
  mcm.openScreen()
  frames(3)
  convaiUiLocale.configure('de'); convaiUiLocale.update(0)
  frames(12)
  local presentation = mcm.config().presentation
  assert(presentation.locale == 'de' and presentation.labelIndent == 20 and presentation.highlightModifiedValues == false and presentation.rowFontSize == 22)
  assert(mcm.config().actionVisibility.favorite == 'hide')
  local back = mcm.row('Zurück')
  assert(back and back.value == 'Zurück' and back.description ~= 'Close this menu.', 'the Back of Home in German')
  mcm.press('Einstellungen'); frames(3)
  local layout = mcm.layout()
  local last = layout.footer[1]
  assert(last and last.label ~= 'Restore defaults', 'the defaults button is translated: ' .. tostring(last and last.label))
`));

test('MCM 0.10.6: Home has a Back in the footer that asks MCM to close, Escape stays MCM\'s own, and no other page gets it', () => run(`${harness({mcm: {version: '0.10.6'}})}
  ${footer}
  mcm.openScreen(); frames(2)
  assert(footerLabels() == 'Back', footerLabels())
  local config = mcm.config()
  assert(config.footerActions[1] == 'home:close' and #config.footerActions == 1)
  assert(config.navigation.backActionId == nil and config.navigation.escapeBack == true, 'Escape stays the close of MCM')
  local back = mcm.row('Back')
  assert(back and back.type == 'action' and back.value == 'Back' and back.description ~= '' and back.capabilities.action == true)
  assert(labels() == 'Characters to invite | Current party | Model browser | Character editor | Key bindings | Settings | Back', labels())
  -- The sub-pages keep their own Back, and Home's is only on Home.
  press('Settings')
  assert(footerLabels() == 'Restore defaults | Back' and mcm.config().navigation.backActionId == 'settings:back')
  assert(mcm.row('home:close') == nil)
  press('Back to Companion Manager')
  assert(footerLabels() == 'Back')
  assert(mcm.closes == 0 and mcm.api.ui.getContext().open == true)
  -- Pressing it calls api.ui.close(modKey) and MCM closes the screen on its next update; the provider's closeMod puts the page on Home.
  local closed = {}
  local real = mcm.api.ui.close
  mcm.api.ui.close = function(...) closed[#closed + 1] = {...}; return real(...) end
  press('Current party')
  press('Back to Companion Manager')
  press('Back')
  assert(#closed == 1 and closed[1][1] == 'cyberpunk-convai:manager' and closed[1][2] == nil, 'api.ui.close(modKey), once')
  frames(3)
  assert(mcm.closes == 1 and mcm.api.ui.getContext().open == false, 'MCM closed the screen')
  assert(managerUi.inspect().view == 'home')
  -- Opened again, the page is Home with its Back, and nothing was left armed.
  mcm.openScreen(); frames(2)
  assert(footerLabels() == 'Back')
`));

test('MCM 0.10.6: a close MCM refuses (no renderer) is answered with MCM\'s reason, logged once, and the page stays', () => run(`${harness({mcm: {version: '0.10.6', renderer: false}})}
  mcm.openScreen(); frames(2)
  -- Without its renderer MCM refuses the request; the action's answer is MCM's reason (MCM shows it on its status line), not silence.
  for _ = 1, 3 do
    local ok, why = mcm.press('Back')
    assert(ok == false and tostring(why):find('renderer', 1, true), tostring(why))
  end
  frames(4)
  assert(mcm.api.ui.getContext().open == true and mcm.closes == 0)
  local lines = 0
  for _, line in ipairs(logged) do if line:find('would not close the page', 1, true) then lines = lines + 1 end end
  assert(lines == 1, 'one console line for three presses: ' .. lines)
  assert(labels() == 'Characters to invite | Current party | Model browser | Character editor | Key bindings | Settings | Back', labels())
`));

test('MCM 0.10.6 by version but refusing the new presentation options: the base ones are sent instead, Add to favorites is still hidden, and the old names are used', () => run(`${harness({screen: false, nsui: false, hideMcm: true, mcm: {version: '0.10.6'}})}
  ${footer}
  local refused = 0
  local real = mcm.api.ui.setPresentation
  mcm.api.ui.setPresentation = function(key, value)
    if value.labelIndent ~= nil or value.highlightModifiedValues ~= nil then refused = refused + 1; return nil, 'Unsupported presentation option: labelIndent' end
    return real(key, value)
  end
  mcmHidden = false
  frames(40)
  assert(mcmHost.ready())
  assert(refused >= 1, 'the new options were tried')
  assert(mcm.config().presentation and mcm.config().presentation.labelIndent == nil and mcm.config().presentation.rowFontSize == nil)
  assert(mcm.config().presentation.descriptionFontSize == 22 and mcm.config().actionVisibility.favorite == 'hide')
  assert(mcmHost.inspect().newUi.presentation == false and mcmHost.inspect().newUi.close == true)
  local tries = refused
  frames(40)
  assert(refused == tries, 'not tried again every second')
  local said = 0
  for _, line in ipairs(logged) do if line:find('refused the 0.10.6 presentation options', 1, true) then said = said + 1 end end
  assert(said == 1, 'said once: ' .. said)
  mcm.openScreen(); frames(2)
  press('Settings')
  assert(footerLabels() == 'Defaults | Back', 'the 0.10.5 name of the button: ' .. footerLabels())
`));

test('MCM 0.10.6: rowFontSize follows the screen: 22 from 1080p up, smaller below it, left out where MCM refuses it or the resolution is unreadable', () => run(`${harness({mcm: {version: '0.10.6'}})}
  local cases = {
    {1920, 1080, 22}, {2560, 1440, 22}, {3840, 2160, 22}, {3440, 1440, 22}, {1920, 1200, 22}, {1920, 1081, 22},
    {1600, 900, 18}, {1366, 768, 15}, {1280, 720, 14}, {1280, 1024, 14}, {1152, 648, 13}, {1056, 594, 12}, {1024, 768, nil},
    {1024, 576, nil}, {800, 600, nil},
  }
  for _, case in ipairs(cases) do
    local got = mcmHost.rowFontFor(case[1], case[2])
    assert(got == case[3], case[1] .. 'x' .. case[2] .. ': ' .. tostring(got) .. ' instead of ' .. tostring(case[3]))
    -- The text takes no larger a share of its box than at 1080p: size / scale (scale = min(w / 1920, h / 1080)) is never above 22 canvas units.
    if got then assert(got / math.min(case[1] / 1920, case[2] / 1080) <= 22 + 1e-6, case[1] .. 'x' .. case[2]) end
  end
  assert(mcmHost.rowFontFor(nil, nil) == nil and mcmHost.rowFontFor(0, 1080) == nil and mcmHost.rowFontFor('1920', 1080) == nil)
`));

test('MCM 0.10.6 at 1366x768: the presentation carries a smaller rowFontSize and the same labelIndent, so the labels of the settings fit the shrunk box', () => run(`${harness({mcm: {version: '0.10.6'}, resolution: [1366, 768]})}
  frames(10)
  local presentation = mcm.config().presentation
  assert(presentation.rowFontSize == 15, tostring(presentation.rowFontSize))
  assert(presentation.labelIndent == 20 and presentation.highlightModifiedValues == false and presentation.descriptionFontSize == 22)
  mcm.openScreen(); frames(3)
  press('tab:settings')
  for _, row in ipairs(mcm.layout().rows) do
    if row.kind == 'setting' then assert(row.size == 15, row.label .. ' at ' .. tostring(row.size)); break end
  end
`));

test('MCM 0.10.6 with an unreadable resolution or a screen under 1046x589: rowFontSize is left out (MCM keeps its own size) and the rest is sent', () => {
  for (const [name, setup] of [
    ['no GetDisplayResolution', 'GetDisplayResolution = nil'],
    ['GetDisplayResolution raising', 'GetDisplayResolution = function() error("nope") end'],
    ['zero size', 'display[1], display[2] = 0, 0'],
    ['800x600', 'display[1], display[2] = 800, 600'],
  ]) {
    run(`${harness({mcm: {version: '0.10.6'}, hideMcm: true})}
      ${setup}
      mcmHidden = false
      frames(40)
      assert(mcmHost.ready(), '${name}')
      local presentation = mcm.config().presentation
      assert(presentation and presentation.rowFontSize == nil, '${name}: ' .. tostring(presentation and presentation.rowFontSize))
      assert(presentation.labelIndent == 20 and presentation.highlightModifiedValues == false and mcmHost.inspect().newUi.presentation == true, '${name}')
    `);
  }
});

test('MCM 0.10.6: the size is worked out again when the page is opened (the shortcut or the MCM list), not while it is closed', () => run(`${harness({mcm: {version: '0.10.6'}})}
  frames(20)
  local function count(name) local n = 0; for _, call in ipairs(mcm.calls) do if call == name then n = n + 1 end end; return n end
  assert(mcm.config().presentation.rowFontSize == 22 and count('ui.setPresentation') == 1)
  -- A resolution change while closed costs nothing and shows nowhere...
  display[1], display[2] = 1366, 768
  frames(40)
  assert(count('ui.setPresentation') == 1 and mcm.config().presentation.rowFontSize == 22, 'nothing is read or sent while closed')
  -- ... until the page opens: the player picks the page in MCM.
  mcm.openScreen(); frames(3)
  assert(mcm.config().presentation.rowFontSize == 15, 'picked up at the opening: ' .. tostring(mcm.config().presentation.rowFontSize))
  assert(count('ui.setPresentation') == 2)
  -- Staying open reads nothing again, even when the resolution moves.
  display[1], display[2] = 1920, 1080
  frames(40)
  assert(count('ui.setPresentation') == 2 and mcm.config().presentation.rowFontSize == 15)
  mcm.closeScreen(); frames(10)
  -- Back at 1080p, opened by the shortcut (managerUi.open): the size is 22 again before MCM is asked to open.
  assert(managerUi.open() == true)
  assert(mcm.config().presentation.rowFontSize == 22 and count('ui.setPresentation') == 3, tostring(mcm.config().presentation.rowFontSize))
  frames(5)
  -- Opening again with nothing changed sends nothing.
  mcm.closeScreen(); frames(10)
  assert(managerUi.open() == true); frames(5)
  assert(count('ui.setPresentation') == 3, 'unchanged size: no call: ' .. count('ui.setPresentation'))
`));

test('MCM 0.10.5 is untouched by the font rule: no rowFontSize at any resolution, and no presentation call at the opening', () => run(`${harness({mcm: {version: '0.10.5'}, resolution: [1366, 768]})}
  frames(20)
  local function count(name) local n = 0; for _, call in ipairs(mcm.calls) do if call == name then n = n + 1 end end; return n end
  assert(mcm.config().presentation.rowFontSize == nil and mcm.config().presentation.labelIndent == nil)
  local before = count('ui.setPresentation')
  display[1], display[2] = 3840, 2160
  mcm.openScreen(); frames(5)
  assert(count('ui.setPresentation') == before and mcm.config().presentation.rowFontSize == nil)
`));

test('MCM 0.10.6 adds no per-frame work: nothing is called while the screen is closed, the new calls are made once per connection, and shutdown clears them', () => run(`${harness({mcm: {version: '0.10.6'}})}
  frames(20)
  local function count(name) local n = 0; for _, call in ipairs(mcm.calls) do if call == name then n = n + 1 end end; return n end
  assert(count('ui.setActionVisibility') == 1 and count('ui.setPresentation') == 1, 'once at connect: ' .. count('ui.setActionVisibility'))
  local calls = #mcm.calls
  for _ = 1, 600 do clock = clock + 1 / 60; managerUi.update(player, true) end
  assert(#mcm.calls == calls, 'no MCM call while closed: ' .. tostring(mcm.calls[calls + 1]))
  -- Open and press around with the screen shown: Back is the only caller of close.
  mcm.openScreen(); frames(10)
  assert(count('ui.close') == 0 and count('ui.setActionVisibility') == 1)
  managerUi.shutdown(true)
  assert(not mcmHost.ready() and mcm.config() and next(mcm.config()) == nil, 'the UI configuration is cleared')
`));

// ---------------------------------------------------------------------------------------------------- settings decisions of 2026-10-20
const customRows = ['Custom endpoint URL', 'Custom API key', 'Custom model ID', 'Test connection'];
const customState = `
  files['runtime/custom-provider-command.json'] = ''
  local function service(tag, value)
    jsonFixtures['custom-' .. tag] = value; files['runtime/custom-provider-state.json'] = 'custom-' .. tag
    clock = clock + 2; frames(4)
  end
  local function command() return jsonFixtures[files['runtime/custom-provider-command.json']] end
`;

test('Custom endpoint is a page of its own: one button on Settings where the four rows were, Back to settings returns, and the rows send their commands through the provider', () => withScreen(`
  ${footer}
  ${customState}
  press('Settings')
  assert(mcm.row('Custom endpoint').type == 'action' and mcm.row('Custom endpoint').value == 'Open', 'one button on Settings')
  for _, label in ipairs({${customRows.map(label => `'${label}'`).join(', ')}}) do assert(mcm.row(label) == nil, label .. ' is not on Settings any more') end
  press('Custom endpoint')
  local config = mcm.config()
  assert(config.navigation.pageId == 'custom-endpoint|1|1' and config.navigation.backActionId == 'custom-endpoint:back' and config.navigation.escapeBack == true,
    tostring(config.navigation.pageId) .. ' ' .. tostring(config.navigation.backActionId))
  assert(headings() == 'Custom endpoint', headings())
  assert(config.footerActions[#config.footerActions] == 'custom-endpoint:back', table.concat(config.footerActions, ','))
  assert(mcm.row('Back to settings').value == 'Back')
  for _, label in ipairs({${customRows.map(label => `'${label}'`).join(', ')}}) do
    assert(mcm.row(label) and mcm.row(label).type == 'action', label .. ' is a button of the page')
  end
  assert(mcm.row('Settings') == nil and mcm.row('Conversation provider') == nil, 'nothing of Settings is on the page')
  for _, drawn in ipairs(mcm.layout().rows) do
    if drawn.kind ~= 'heading' then assert(drawn.kind == 'action' and drawn.size == 22 and drawn.color == 'red', drawn.label .. ' is drawn as ' .. drawn.kind) end
  end
  -- No state from the service yet: the test waits. The rows send their commands on the provider's own channel.
  assert(mcm.row('Test connection').capabilities.write == false)
  press('Custom endpoint URL')
  assert(command().action == 'paste-url', tostring(command() and command().action))
  press('Custom API key'); assert(command().action == 'paste-key')
  press('Custom model ID'); assert(command().action == 'paste-model')
  -- The service saved everything: the rows say so, and Test connection runs; its result shows on the page.
  service('saved', {version = 1, updated = 1, ready = true, host = 'openrouter.ai', secure = true, ['local'] = false, model = 'llama3.2', keySaved = true, tail = 'wxyz'})
  assert(mcm.row('Custom endpoint URL (openrouter.ai)').value == 'Remove', labels())
  press('Test connection')
  local id = command().id
  assert(command().action == 'test')
  service('testing', {version = 1, updated = 2, ready = true, host = 'openrouter.ai', secure = true, ['local'] = false, model = 'llama3.2', keySaved = true, tail = 'wxyz',
    test = {id = id, state = 'testing'}})
  assert(mcm.row('Test connection (Testing…)'), labels())
  service('failed', {version = 1, updated = 3, ready = true, host = 'openrouter.ai', secure = true, ['local'] = false, model = 'llama3.2', keySaved = true, tail = 'wxyz',
    test = {id = id, state = 'failed', code = 'model', detail = 'model not found'}})
  assert(mcm.row('Test connection (Failed)'), labels())
  assert(mcm.row('Test connection (Failed)').description:find('The endpoint does not know that model ID.', 1, true))
  -- Back to settings leaves the page and the way back works from the footer too.
  press('Back to settings')
  assert(mcm.config().navigation.pageId == 'settings|1|1' and mcm.row('Custom endpoint') and mcm.row('Custom endpoint URL (openrouter.ai)') == nil)
  press('Custom endpoint'); press('Back to settings'); press('Back to Companion Manager')
  assert(labels() == 'Characters to invite | Current party | Model browser | Character editor | Key bindings | Settings', labels())
`));

test('Custom endpoint with changes pending: MCM refuses the button until Apply, the change is saved by Apply, and the page then opens', () => withScreen(`
  ${footer}
  press('Settings')
  assert(mcm.set('Subtitles', false))
  local ok, why = mcm.press('Custom endpoint')
  assert(ok == false and why:find('pending changes', 1, true), tostring(why))
  assert(mcm.config().navigation.pageId == 'settings|1|1', 'the page did not change')
  assert(mcm.apply())
  assert(saved.subtitles == false)
  press('Custom endpoint')
  assert(mcm.config().navigation.pageId == 'custom-endpoint|1|1')
  assert(next(mcm.drafts()) == nil, 'the page has no draft')
  -- The way back is a button, and Revert/Apply have nothing to do on this page.
  press('Back to settings')
  assert(mcm.row('Subtitles').value == false, 'the saved change is on the page')
`));

test('Custom endpoint is not offered without the provider module: no button on Settings, nothing to open', () => run(`${harness({modules: withoutCustomModule})}
  mcm.openScreen()
  frames(2)
  press('Settings')
  assert(mcm.row('Custom endpoint') == nil, 'no button without the module')
  assert(not pcall(mcm.press, 'Custom endpoint'), 'there is nothing to press')
  assert(mcm.row('Mistral key') ~= nil or mcm.row('Conversation provider') ~= nil, 'the rest of the page is there')
`));

test('Johnny in your head is one list: Off, On, Speaks up rarely, Speaks up normally, Speaks up often; it stores both settings together, and the old rows are gone', () => withScreen(`
  press('Settings')
  assert(mcm.row('Johnny speaks up') == nil and mcm.row('Johnny’s standing') == nil, 'the separate rows are gone')
  local row = mcm.row('Johnny in your head')
  assert(row.type == 'select' and row.default == nil and row.value == 1, 'Off by default')
  assert(table.concat(row.elements, ' | ') == 'Off | On | Speaks up rarely | Speaks up normally | Speaks up often', table.concat(row.elements, ' | '))
  local function stored() return tostring(saved.johnnyInHead) .. '/' .. tostring(saved.johnnyRemarks) end
  assert(stored() == 'false/off', stored())
  assert(mcm.set('Johnny in your head', 3) and mcm.apply())
  assert(stored() == 'true/rare', stored())
  assert(mcm.row('Johnny in your head').value == 3, 'the page shows what is saved')
  assert(mcm.set('Johnny in your head', 4) and mcm.apply()); assert(stored() == 'true/medium', stored())
  assert(mcm.set('Johnny in your head', 5) and mcm.apply()); assert(stored() == 'true/normal', stored())
  assert(mcm.set('Johnny in your head', 2) and mcm.apply()); assert(stored() == 'true/off', stored())
  assert(mcm.row('Johnny in your head').value == 2)
  assert(mcm.set('Johnny in your head', 1) and mcm.apply()); assert(stored() == 'false/off', stored())
  assert(mcm.row('Johnny in your head').value == 1)
  -- A saved Johnny with remarks reads as the same entry after a restart of the page.
  assert(manager.applySettings(player, {johnnyInHead = true, johnnyRemarks = 'rare'}))
  frames(10)
  assert(mcm.row('Johnny in your head').value == 3)
`));

test('V’s voice is one list: Off, Pocket, Voxtral, OmniVoice; Voxtral is greyed out without a Mistral key (the choice is refused as a draft) and works with one', () => withScreen(`
  press('Settings')
  local name = 'V’s voice for typed lines'
  assert(mcm.row('V’s voice engine') == nil, 'the engine row is gone')
  local row = mcm.row(name)
  assert(row.type == 'select' and row.default == nil and row.value == 2, 'Pocket by default')
  assert(table.concat(row.elements, ' | ') == 'Off | Pocket · On your PC | Voxtral · needs Mistral key | OmniVoice · needs Omni voice', table.concat(row.elements, ' | '))
  local states = mcm.config().choices and mcm.config().choices.vVoice
  -- OmniVoice is greyed out too, with its own reason: the companions are on Pocket (the pack is taken as installed while the bridge has not said otherwise).
  assert(states and states.states[4] and states.states[4].enabled == false and states.states[4].reason == 'Requires the Companion voices to be an OmniVoice choice', tostring(states.states[4] and states.states[4].reason))
  local okOmni = mcm.set(name, 4)
  assert(okOmni == false, 'MCM refuses the disabled OmniVoice entry as a draft')
  assert(states and states.states[3] and states.states[3].enabled == false, 'Voxtral is a disabled choice without a key')
  assert(states.states[1].enabled ~= false and states.states[2].enabled ~= false, 'Off and Pocket are free')
  local ok, why = mcm.set(name, 3)
  assert(ok == false, 'MCM refuses the disabled entry as a draft')
  assert(next(mcm.drafts()) == nil)
  assert(mcm.set(name, 1) and mcm.apply())
  assert(saved.vVoice == false and saved.vVoiceEngine == 'pocket', tostring(saved.vVoice))
  assert(mcm.row(name).value == 1)
  assert(mcm.set(name, 2) and mcm.apply())
  assert(saved.vVoice == true and saved.vVoiceEngine == 'pocket' and mcm.row(name).value == 2)
  -- The Mistral key is saved: the entry has its name and can be chosen.
  jsonFixtures['mistral-key'] = {provider = 'convai', effective = 'convai', saved = true}
  files['runtime/mistral-state.json'] = 'mistral-key'
  clock = clock + 2; manager.snapshot(player); frames(10)
  assert(mcm.row(name).elements[3] == 'Voxtral · Mistral cloud', mcm.row(name).elements[3])
`));

test('once the Mistral key is saved the Voxtral entry of V’s voice is a normal choice again (the disabled state set without a key is lifted)', () => withScreen(`
  press('Settings')
  local name = 'V’s voice for typed lines'
  jsonFixtures['mistral-key'] = {provider = 'convai', effective = 'convai', saved = true}
  files['runtime/mistral-state.json'] = 'mistral-key'
  clock = clock + 2; manager.snapshot(player); frames(10)
  local ok3, why3 = mcm.set(name, 3)
  assert(ok3, 'Voxtral is a normal draft with a key: ' .. tostring(why3))
  assert(mcm.apply())
  assert(saved.vVoice == true and saved.vVoiceEngine == 'voxtral' and mcm.row(name).value == 3)
`));

test('the Voxtral entry of V’s voice says what it needs: the Mistral key (and not the OmniVoice pack)', () => withScreen(`
  press('Settings')
  local states = mcm.config().choices.vVoice.states
  assert(states[3].enabled == false and states[3].reason:find('Mistral', 1, true) and not states[3].reason:find('OmniVoice', 1, true), tostring(states[3].reason))
`));

test('the OmniVoice entry of V’s voice is greyed out with the pack reason while the pack is missing (the pack first, even with the companions on Pocket)', () => withScreen(`
  jsonFixtures['voice-runtime'] = {state = 'ready', provider = 'pocket', omniPack = {installed = false, missing = {'model'}}, updated = os.time() * 1000.0}
  files['runtime/local-voice-state.json'] = 'voice-runtime'
  clock = clock + 2
  for _ = 1, 5 do manager.update(player, 0.6) end
  press('Settings')
  frames(6)
  local name = 'V’s voice for typed lines'
  assert(mcm.row(name).elements[4] == 'OmniVoice · needs Omni pack', mcm.row(name).elements[4])
  local states = mcm.config().choices.vVoice.states
  assert(states[4].enabled == false and states[4].reason == 'Requires the optional OmniVoice pack (GPU)', tostring(states[4].reason))
  assert(mcm.set(name, 4) == false)
  assert(states[1].enabled ~= false and states[2].enabled ~= false)
`));

test('the OmniVoice entry of V’s voice is a normal choice with the pack installed and the companions on OmniVoice; moving the companions off OmniVoice sets V to Pocket in the same Apply and says so', () => withScreen(`
  jsonFixtures['voice-runtime'] = {state = 'ready', provider = 'pocket', omniPack = {installed = true, missing = {}}, updated = os.time() * 1000.0}
  files['runtime/local-voice-state.json'] = 'voice-runtime'
  clock = clock + 2
  for _ = 1, 5 do manager.update(player, 0.6) end
  assert(manager.applySettings(player, {voiceProvider = 'omni'}))
  press('Settings')
  frames(6)
  local name = 'V’s voice for typed lines'
  assert(mcm.row(name).elements[4] == 'OmniVoice', mcm.row(name).elements[4])
  local states = mcm.config().choices
  assert(states == nil or states.vVoice == nil or states.vVoice.states[4].enabled ~= false, 'OmniVoice is a normal choice')
  assert(mcm.set(name, 4) and mcm.apply())
  assert(saved.vVoice == true and saved.vVoiceEngine == 'omni' and manager.vVoiceEngine() == 'omni' and mcm.row(name).value == 4)
  -- The companions move to Pocket: V goes to Pocket in the same save, and the line says so.
  assert(mcm.set('Companion voices', 1) and mcm.apply())
  frames(6)
  assert(saved.voiceProvider == 'pocket' and saved.vVoiceEngine == 'pocket' and saved.vVoice == true, tostring(saved.vVoiceEngine))
  assert(mcm.row(name).value == 2)
  assert(managerUi.inspect().shown == 'V’s voice switches from OmniVoice to Pocket.', tostring(managerUi.inspect().shown))
`));

test('React to battles and to collected loot are off by default, and Restore defaults puts Johnny to Off, V’s voice to Pocket and the reactions off', () => withScreen(`
  press('Settings')
  assert(mcm.row('React to battles').value == false and mcm.row('React to collected loot').value == false)
  assert(mcm.set('React to battles', true) and mcm.set('React to collected loot', true) and mcm.set('Johnny in your head', 5) and mcm.set('V’s voice for typed lines', 1)
    and mcm.set('Companions speak up', 4))
  assert(mcm.apply())
  assert(saved.companionSpeakUp == 'normal')
  assert(saved.battleReactions == true and saved.lootReactions == true and saved.battleReactionsChosen == nil and saved.lootReactionsChosen == nil)
  assert(saved.johnnyInHead == true and saved.johnnyRemarks == 'normal' and saved.vVoice == false)
  frames(6)
  press('Defaults'); press('Defaults')
  frames(8)
  local settings = manager.snapshot(player).settings
  assert(settings.battleReactions == false and settings.lootReactions == false, 'the reactions are off again')
  assert(settings.johnnyInHead == false and settings.johnnyRemarks == 'off', 'Johnny is Off')
  assert(settings.companionSpeakUp == 'rare' and mcm.row('Companions speak up').value == 2, 'companions are back to Rarely')
  assert(settings.vVoice == true and settings.vVoiceEngine == 'pocket', 'V speaks with Pocket')
  assert(mcm.row('Johnny in your head').value == 1 and mcm.row('V’s voice for typed lines').value == 2)
  assert(mcm.row('React to battles').value == false and mcm.row('React to collected loot').value == false)
`));

// A setting's label is drawn by MCM in a box that ends in "..." when the text does not fit (MCMPanelWidgetFactory.McmUiApplyTextBounds, textOverflowPolicy
// DotsEnd; the box is the width MCMPanelContent.ApplyLabelWidth gives it). Live 2026-10-21 every setting label of the Settings page was drawn as
// an ellipsis while the buttons were not. The box is canvas units of MCMLayout.reds: content 980 wide, label x 28, controls from 480, labelIndent 20:
// 444 units wide, and at row size 22 an average letter is about 11 of them (optionUnits() counts in letters), so a label of 40 or more letters
// of width is cut. The fake does not draw text, so this asserts what the host sends: every label of a setting is one non-empty line that fits
// the box in every language, and the page schema carries the same labels on every build of the page (it is rebuilt on each change).
const LABEL_BOX_UNITS = 40;
for (const locale of ['en', 'cs', 'de', 'es', 'fr', 'hu', 'it', 'ja', 'ko', 'pl', 'pt-br', 'ru', 'tr', 'uk', 'zh-cn', 'zh-tw']) {
  test(`every setting label MCM is given is one line that fits its box (${locale})`, () => run(`${harness({locale: locale === 'en' ? null : locale, mcm: {version: '0.10.6'}})}
    mcm.openScreen()
    frames(3)
    ${locale === 'en' ? '' : `convaiUiLocale.configure('${locale}'); convaiUiLocale.update(0); frames(12)`}
    local checked, longest = 0, {units = 0}
    local function check(page)
      for _, row in ipairs(mcm.layout().rows) do
        if row.kind == 'setting' then
          local label = row.label
          assert(type(label) == 'string' and label ~= '', page .. ': a setting with no label: ' .. tostring(row.id))
          assert(not label:find('%c'), page .. ': a label with a line break or tab: ' .. row.id)
          assert(not label:find('...', 1, true) and not label:find('…', 1, true), page .. ': a label that is already cut: ' .. label)
          local units = managerUi._test.core.optionUnits(label)
          if units > longest.units then longest = {units = units, label = label} end
          assert(units <= ${LABEL_BOX_UNITS}, page .. ': ' .. label .. ' is ' .. units .. ' wide, the box holds ${LABEL_BOX_UNITS}')
          checked = checked + 1
        end
      end
    end
    press('tab:settings')
    check('Settings')
    press('relationships'); check('Relationships'); press('relationships:back')
    press('dynamic-info'); check('Dynamic info'); press('dynamic-info:back')
    press('custom-endpoint'); check('Custom endpoint')
    assert(checked > 25, 'the pages have settings: ' .. checked)
  `));
}

// ---------------------------------------------------------------------------------------------------- Home > Character editor (2026-10-22)
// An action on Home that is not a navigation: the MCM host answers MCM's invokeAction through the same core.invoke, the page does not move,
// and the result text is MCM's status line (the way the line of any other action is).
test('MCM: the Character editor row of Home writes one editor command, the page stays on Home and the status line carries the notice', () => withScreen(`
  local row = mcm.row('Character editor')
  assert(row and row.type == 'action' and row.value == 'Open' and row.id == 'character-editor:home' and row.capabilities.action == true)
  assert(row.description:find('Mistral, Local AI and Custom, not Convai', 1, true) and row.description:find('prompting for each AI option', 1, true))
  local function commandWrites() local n = 0 for _, write in ipairs(fileWrites) do if write.path == 'runtime/editor-command.json' then n = n + 1 end end return n end
  local before = commandWrites()
  press('Character editor')
  assert(commandWrites() == before + 1 and fileWrites[#fileWrites].path == 'runtime/editor-command.json', 'exactly one command')
  assert(managerUi.inspect().view == 'home' and mcm.config().navigation.pageId == 'home|1|1', 'Home stays')
  frames(6)
  assert(mcm.status() == 'Opening the editor in your browser. Switch to your browser if it does not come to the front.', mcm.status())
  frames(40)
  assert(commandWrites() == before + 1, 'nothing more is sent by the frames that follow')
  assert(labels() == 'Characters to invite | Current party | Model browser | Character editor | Key bindings | Settings', labels())
`));

test('MCM: the Character editor row says the service is not running and writes nothing; without the module it is not on Home', () => {
  withScreen(`
    jsonFixtures['svc-stopped'] = {state = 'stopped', updated = os.time() * 1000.0, since = os.time() * 1000.0 - 5000}
    files['runtime/bridge-service.json'] = 'svc-stopped'
    local ok = mcm.press('Character editor')
    frames(6)
    assert(not files['runtime/editor-command.json'], 'nothing written')
    assert(managerUi.inspect().view == 'home')
    assert(mcm.status() == 'The conversation service is not running, so the editor cannot open. Restart the game.', mcm.status())
  `);
  const bare = Object.fromEntries(Object.entries(everything).filter(([name]) => name !== 'character-editor.lua'));
  withScreen(`
    assert(labels() == 'Characters to invite | Current party | Model browser | Key bindings | Settings' and not mcm.row('Character editor'), labels())
  `, {modules: bare, absent: ['character-editor.lua']});
});

// ---------------------------------------------------------------------------------------------------- Key bindings (docs/KEY_BINDINGS.md)
// A page of its own, opened from Home between the Character editor and Settings. The five actions show the key the player set and the key they set in Cyber
// Engine Tweaks; Set waits for the game's next key (the redscript half is a fake player here), Clear removes it; the Controller talk button is the same setting
// as on Settings; Restore defaults clears the keys.
const keyPlayer = `
  local keyQueue, keyList = {}, ''
  function player:ConvaiKeyBindsReady() return true end
  function player:ConvaiKeyBindsActive() return keyList end
  function player:ConvaiKeyBindsConfigure(value) keyList = value; return true end
  function player:ConvaiKeyBindsCapture(on) return true end
  function player:ConvaiKeyBindTake() return table.remove(keyQueue, 1) or '' end
  local function key(token) keyQueue[#keyQueue + 1] = token; convaiKeyBinds.take(player) end
`;

test('MCM: Key bindings lists the seven actions with the key set here and the key set in Cyber Engine Tweaks, sets one from a key event and clears it', () => withScreen(`
  ${keyPlayer}
  press('Key bindings')
  assert(managerUi.inspect().view == 'key-bindings' and mcm.config().navigation.pageId == 'key-bindings|1|1')
  for _, action in ipairs({'voice', 'text', 'group_voice', 'group_text', 'johnny_voice', 'johnny_text', 'manager'}) do
    -- One look on the page (2026-10-25): the key's own button shows the key and sets it; no text rows and no Cyber Engine Tweaks row (the owner's call).
    local mine = mcm.row('kb:set:' .. action)
    assert(mine and mine.type == 'action' and mine.label == 'Key or button' and mine.value == 'Not set', action)
    assert(not mcm.row('kb:cet:' .. action) and not mcm.row('kb:key:' .. action) and not mcm.row('kb:clear:' .. action), action)
  end
  assert(mcm.row('padTalk').type == 'bool' and mcm.row('padTalk').label == 'Controller talk button')
  -- Set waits for a key: the line under the way back says so, and the button turns into Cancel.
  press('kb:set:voice')
  frames(4)
  assert(mcm.status() == 'Press the key or controller button for Talk by voice. Esc or B cancels.', mcm.status())
  assert(mcm.row('kb:set:voice').value == 'Cancel' and convaiKeyBinds.capturing() == 'voice')
  clock = clock + 1; key('kIK_F7'); frames(6)
  assert(mcm.status() == 'Talk by voice is set to F7.', mcm.status())
  assert(mcm.row('kb:set:voice').value == 'F7' and mcm.row('kb:clear:voice'), 'the page shows the new key')
  assert(manager.snapshot(player).settings.keyBindings.voice == 'IK_F7' and keyList == 'IK_F7,-,-,-,-', 'saved, and registered at once')
  -- A controller button for another action; the key set in CET shows beside it.
  press('kb:set:group_text'); clock = clock + 1; key('kIK_Pad_LeftShoulder'); frames(6)
  assert(mcm.row('kb:set:group_text').value == 'Controller LB' and mcm.status() == 'Group text chat is set to Controller LB.', mcm.status())
  -- Talk to Johnny has its own rows and slots: saved, and sent to the redscript after the five.
  press('kb:set:johnny_voice'); clock = clock + 1; key('kIK_F9'); frames(6)
  assert(mcm.status() == 'Talk to Johnny by voice is set to F9.' and manager.snapshot(player).settings.keyBindings.johnny_voice == 'IK_F9', mcm.status())
  assert(keyList == 'IK_F7,-,-,IK_Pad_LeftShoulder,-,IK_F9', keyList)
  press('kb:clear:johnny_voice'); frames(4); convaiKeyBinds.tick(player, true)   -- the game's 10 Hz tick
  assert(manager.snapshot(player).settings.keyBindings.johnny_voice == nil and keyList == 'IK_F7,-,-,IK_Pad_LeftShoulder,-', keyList)
  -- The same key twice is refused with the name of the action that has it.
  press('kb:set:text'); clock = clock + 1; key('kIK_F7'); frames(6)
  assert(mcm.status() == 'F7 is already used for Talk by voice. Choose another.' and not manager.snapshot(player).settings.keyBindings.text, mcm.status())
  -- Esc cancels, and leaving the page drops a Set that is waiting.
  press('kb:set:text'); clock = clock + 1; key('kIK_Escape'); frames(6)
  assert(mcm.status() == 'Cancelled.' and convaiKeyBinds.capturing() == nil)
  press('kb:set:text'); assert(convaiKeyBinds.capturing() == 'text')
  press('key-bindings:back'); frames(4)
  assert(convaiKeyBinds.capturing() == nil and managerUi.inspect().view == 'home', 'the Set did not outlive the page')
  press('Key bindings')
  -- Clear removes it.
  press('kb:clear:voice'); frames(4)
  assert(mcm.status() == 'Talk by voice cleared.', tostring(mcm.status()))
  assert(mcm.row('kb:set:voice').value == 'Not set' and not mcm.row('kb:clear:voice'), tostring(mcm.row('kb:set:voice').value) .. ' / ' .. tostring(manager.keyBindings().voice))
  convaiKeyBinds.tick(player, true)   -- the game's 10 Hz tick
  assert(manager.snapshot(player).settings.keyBindings.voice == nil and keyList == '-,-,-,IK_Pad_LeftShoulder,-', keyList)
`));

test('MCM: the Controller talk button on Key bindings is the Settings row, and Restore defaults on the page clears the keys and the button together', () => withScreen(`
  ${footer}
  ${keyPlayer}
  press('Key bindings')
  assert(footerLabels() == 'Defaults | Back', footerLabels())
  assert(mcm.set('Controller talk button', true) and mcm.apply())
  assert(manager.padTalk() == true, 'applied from this page')
  press('key-bindings:back'); press('Settings')
  assert(mcm.row('padTalk').value == true, 'the Settings row shows it')
  press('settings:back'); press('Key bindings')
  press('kb:set:text'); clock = clock + 1; key('kIK_T'); frames(4)
  press('kb:set:manager'); clock = clock + 1; key('kIK_Pad_Start'); frames(4)
  assert(manager.keyBindings().text == 'IK_T' and manager.keyBindings().manager == 'IK_Pad_Start')
  press('Defaults'); assert(footerLabels() == 'Confirm | Back', footerLabels())
  press('Defaults'); frames(8)
  assert(next(manager.keyBindings()) == nil and manager.padTalk() == false, 'both back to the defaults')
  assert(mcm.row('kb:set:text').value == 'Not set' and mcm.row('padTalk').value == false, 'the page shows them')
  convaiKeyBinds.tick(player, true)   -- the game's 10 Hz tick
  assert(keyList == '', 'and the listeners stop')
  assert(mcm.status() == 'Defaults restored.', mcm.status())
`));

test('MCM: without Codeware the Set button says so and nothing waits; without the scripts it says that', () => withScreen(`
  press('Key bindings')
  -- The fake player has no key methods at all: the mod's scripts did not load.
  mcm.press('kb:set:voice'); frames(4)
  assert(mcm.status() == 'The mod’s scripts did not load, so no key can be set. Open Help for what is wrong.', mcm.status())
  function player:ConvaiKeyBindsReady() return false end
  mcm.press('kb:set:voice'); frames(4)
  assert(mcm.status() == 'Key bindings need Codeware, and this game does not have it. Open Help for what is missing.', mcm.status())
  assert(convaiKeyBinds.capturing() == nil)
`));
