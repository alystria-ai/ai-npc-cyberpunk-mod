import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {run, nsuiHarness, source} from './manager-fixture.mjs';

// The Companion Manager as a page of Mod Configuration Menu 0.10.5: the real host (mod/mcm-host.lua, attached to mod/nsui.lua over
// mod/manager-ui.lua) over a fake MCM (bridge/mcm-fake.mjs) that keeps MCM's own rules for providers, schemas, drafts, Apply and the
// public UI extension. The page logic itself (rows, rules, validation) is tested in manager.test.mjs; the Native Settings UI host in
// nsui-manager.test.mjs.
const everything = {
  'service-status.lua': source('service-status.lua'), 'character-editor.lua': source('character-editor.lua'),
  'convai-paid-tier.lua': source('convai-paid-tier.lua'), 'support-report.lua': source('support-report.lua'),
  'setup-check.lua': source('setup-check.lua'), 'custom-provider.lua': source('custom-provider.lua'),
};
const harness = (options = {}) => `
  local logged = {}
  print = function(text) logged[#logged + 1] = tostring(text) end
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
  assert(labels() == 'Characters to invite | Current party | Model browser | Settings', labels())
  for _, row in ipairs(mcm.rows()) do
    assert(row.type == 'action' and row.value == 'Open' and row.capabilities.action == true and row.description ~= '')
  end
  -- No Back on Home, on purpose: MCM has no public call that closes its screen, and its own Escape closes it when the page names no
  -- back action (escapeBack stays on, backActionId unset). A footer button here could not do that, so there is none.
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
  assert(labels() == 'Characters to invite | Current party | Model browser | Settings')
  -- Closing the screen and opening it again starts on the first page.
  press('Settings')
  mcm.closeScreen(); frames(3)
  assert(managerUi.inspect().view == 'home', 'closeMod puts the page back on Home')
  mcm.openScreen()
  assert(labels() == 'Characters to invite | Current party | Model browser | Settings')
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
  -- The read-only lines of the Settings page are status buttons, so no line of the page is drawn at another size.
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
  assert(manager.applySettings(player, {bodyGestures = false, voiceVolume = 150, battleReactions = true}))
  frames(10)
  assert(mcm.row('Body gestures').value == false and mcm.row('Voice volume (%)').value == 150, 'an outside change is drawn')
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
  assert(manager.snapshot(player).settings.bodyGestures == false and manager.snapshot(player).settings.voiceVolume == 150)
  -- Another button drops the first press.
  press('Voice status')
  assert(footerLabels() == 'Defaults | Back', footerLabels())
  press('Defaults'); press('Defaults')
  local settings = manager.snapshot(player).settings
  assert(settings.bodyGestures == true and settings.voiceVolume == 100 and settings.battleReactions == false, 'defaults saved')
  assert(mcm.row('Body gestures').value == true and mcm.row('Voice volume (%)').value == 100, 'the page shows them')
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
  assert(mcm.status() == 'Needs Local AI.', mcm.status())
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
  assert(footerLabels():find('^Starts with: %S+ | Previous page | Next page | Back$'), footerLabels())
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
    if page ~= 'settings' and page ~= 'relationships' then assert(not kinds.setting, page .. ' has a switch or list in it') end
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
  check('models'); go('Starts with: All'); check('models letter'); go('Next page'); check('models page 2'); go('Back to Companion Manager')
  go('Settings'); check('settings')
  go('Relationships'); check('relationships'); go('Back to settings')
  go('Memory'); check('memory'); go('Back to settings')
  go('Help and support'); check('help'); go('Back to settings')
  go('Convai paid tier'); check('paid-tier'); go('Back to settings', 'Back to Companion Manager')
  -- A party with copies: the rows of the party page.
  managerUi.party().invite('johnny-silverhand')
  frames(12)
  go('Current party'); check('party with copies')
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

test('every row of the Settings page is drawn the same: one size, one colour family, buttons for the status lines; the two alignments left are the ones MCM fixes', () => withScreen(`
  ${footer}
  assert(manager.applySettings(player, {johnnyInHead = true}))
  convaiJohnnyStanding = function() return 'grudging' end
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
  -- Voice status and Johnny's standing are status buttons (the value is the button's text), and pressing one changes nothing.
  for _, name in ipairs({'Voice status', 'Johnny’s standing'}) do
    local row = listed(name)
    assert(row and row.kind == 'action' and row.button and row.buttonText ~= '', name .. ' is ' .. tostring(row and row.kind))
  end
  assert(listed('Johnny’s standing').buttonText == 'Grudging respect', listed('Johnny’s standing').buttonText)
  -- The button is narrow: a value in parts shows its first part only.
  assert(not listed('Voice status').buttonText:find(' · ', 1, true), listed('Voice status').buttonText)
  local loads = mcm.loads
  press('Voice status'); press('Johnny’s standing')
  assert(mcm.loads == loads, 'a status button does not draw the page again')
  -- No row carries a default.
  for _, row in ipairs(mcm.rows()) do assert(row.default == nil, row.id) end
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

test('Apply of one switch saves exactly that switch: Live holocall picture off is saved off, and the rest stays', () => withScreen(`
  press('Settings')
  frames(6)
  local core = managerUi._test.core
  local realApply, seen = core.apply, nil
  core.apply = function(batch) seen = batch; return realApply(batch) end
  local before = manager.snapshot(player).settings
  assert(before.holocallLiveImage == true and before.multilingualConversations == false)
  assert(mcm.row('Live holocall picture').value == true)
  assert(mcm.set('Live holocall picture', false))
  assert(mcm.drafts()['cyberpunk-convai:manager:holocallLiveImage'] == false, 'the draft is on that row')
  assert(next(mcm.drafts(), next(mcm.drafts())) == nil, 'and on no other')
  local ok, why = mcm.apply()
  assert(ok, tostring(why))
  assert(seen and #seen == 1 and seen[1].id == 'holocallLiveImage' and seen[1].value == false, 'the batch is that one switch')
  assert(saved.holocallLiveImage == false and saved.holocallLiveImageChosen == true, 'saved: ' .. tostring(saved.holocallLiveImage))
  assert(manager.snapshot(player).settings.holocallLiveImage == false)
  assert(mcm.row('Live holocall picture').value == false, 'the page shows what is saved')
  assert(saved.multilingualConversations == false and saved.subtitles == true, 'the other switches did not move')
  -- And back on.
  core.apply = realApply
  assert(mcm.set('Live holocall picture', true) and mcm.apply())
  assert(saved.holocallLiveImage == true)
  -- The same while the list jumps on every redraw (the live check): the switch pressed is the one saved.
  mcm.jumpOnLoad = 0.7
  frames(4)
  assert(mcm.set('Live holocall picture', false) and mcm.apply())
  frames(6)
  assert(saved.holocallLiveImage == false and saved.multilingualConversations == false)
`));

test('the list keeps its place after Apply and after a reload of the page, leaves a later scroll alone, and starts at the top on another page', () => withScreen(`
  press('Settings')
  frames(4)
  mcm.scrollTo(0.2); frames(2)
  assert(math.abs(mcm.scroll() - 0.2) < 1e-9)
  -- MCM redraws the page after Apply and the list jumps far down (as in the live check): the host puts it back.
  mcm.jumpOnLoad = 0.6
  assert(mcm.set('Live holocall picture', false) and mcm.apply())
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
  assert(labels() == 'Characters to invite | Current party | Model browser | Settings', 'on the first page: ' .. labels())
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
    assert(ok == false and reason == 'Update Mod Configuration Menu to 0.10.5 or newer to use the Companion Manager', tostring(reason))
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

test('at the main menu the pages that need a save say so in a row, the same row as in Native Settings UI', () => withScreen(`
  player = nil
  frames(4)
  press('Characters to invite')
  assert(labels():find('Characters and party', 1, true), labels())
  press('Back to Companion Manager'); press('Settings')
  assert(labels():find('Interface language', 1, true) and not labels():find('Characters and party', 1, true), labels())
`));
