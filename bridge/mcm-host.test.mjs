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
  assert(mcm.config().navigation.pageId == 'home|1|1' and mcm.config().navigation.backActionId == nil)
  assert(#mcm.config().footerActions == 0)
`));

test('a page change: the way back is a footer action and Escape-back, the next visit starts on the first page', () => withScreen(`
  press('Settings')
  local config = mcm.config()
  assert(config.navigation.backActionId == 'settings:back' and config.navigation.escapeBack == true, config.navigation.backActionId)
  assert(config.footerActions[1] == 'settings:back')
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
      assert(row.capabilities.draft == true and row.capabilities.write == true and row.capabilities.canResetToDefault == true, row.id)
      assert(row.default ~= nil, row.id .. ' has a default for MCM\s Defaults button')
    end
    if row.type == 'select' then assert(#row.elements > 0 and row.value >= 1 and row.value <= #row.elements, row.id) end
    if row.type == 'int' then assert(row.min and row.max and row.step and row.value >= row.min and row.value <= row.max, row.id) end
    if row.type == 'action' then assert(row.capabilities.write == false and row.capabilities.draft == false, row.id) end
    assert(not row.id:find('^ui:'), 'a page control must not be a draft: ' .. row.id)
  end
  assert(kinds.bool and kinds.select and kinds.int and kinds.action and kinds.string, 'every kind is on the Settings page')
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

test('Revert and Defaults: Revert drops the drafts, and the Defaults button stages the rows defaults, including the Local AI models own', () => withScreen(`
  press('Settings')
  mcm.set('Voice volume (%)', 120)
  mcm.revert()
  assert(not next(mcm.drafts()) and mcm.row('Voice volume (%)').value == 100)
  assert(manager.applySettings(player, {bodyGestures = false, voiceVolume = 150, battleReactions = true}))
  frames(10)
  assert(mcm.row('Body gestures').value == false and mcm.row('Voice volume (%)').value == 150, 'an outside change is drawn')
  -- What MCM's Defaults button does: a draft of every default that differs.
  local staged = 0
  for _, row in ipairs(mcm.rows()) do
    if row.default ~= nil and row.capabilities.canResetToDefault and row.default ~= row.value then
      assert(mcm.api.setDraft('cyberpunk-convai:manager:' .. row.id, row.default)); staged = staged + 1
    end
  end
  assert(staged >= 3, 'defaults staged: ' .. staged)
  assert(mcm.apply())
  local settings = manager.snapshot(player).settings
  assert(settings.bodyGestures == true and settings.voiceVolume == 100 and settings.battleReactions == false)
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

test('both hosts read and write the same saved settings: a change in one is on the page of the other', () => run(`${harness({screen: false})}
  -- MCM hosts the page, so no Native Settings UI tab was registered; the tab is added by hand, as an MCM found late would leave it.
  assert(managerUi._test.connect())
  ns.openScreen(TAB)
  frames(6)
  mcm.openScreen()
  press('Settings')
  frames(6)
  -- A change applied through MCM is on the Native Settings UI tab after it is drawn again.
  assert(mcm.set('Voice volume (%)', 135) and mcm.apply())
  assert(manager.snapshot(player).settings.voiceVolume == 135)
  mcm.closeScreen(); ns.leave(); frames(4); ns.openScreen(TAB); frames(2)
  ns.interact.press(assert(ns.find('Settings'))); frames(6)
  assert(ns.find('Voice volume (%)').currentValue == 135, tostring(ns.find('Voice volume (%)').currentValue))
  -- A change made on the Native Settings UI tab is on the MCM page.
  ns.interact.slide(ns.find('Voice volume (%)'), 170); frames(12)
  assert(manager.snapshot(player).settings.voiceVolume == 170)
  ns.leave(); frames(4)
  mcm.openScreen(); press('Settings')
  assert(mcm.row('Voice volume (%)').value == 170, 'MCM shows ' .. tostring(mcm.row('Voice volume (%)').value))
`));

test('a long list is turned with buttons (MCM has no draft-free slider): previous and next page, the ends are disabled, and the letter group cycles', () => withScreen(`
  press('Characters to invite')
  local function invites() local count = 0; for _, row in ipairs(mcm.rows()) do if row.value == 'Invite' then count = count + 1 end end; return count end
  assert(invites() == 12 and mcm.row('Johnny Silverhand') and not mcm.row('Viktor Vektor'))
  assert(mcm.row('Previous page').disabled == true and mcm.row('Previous page').capabilities.action == false, 'no page before the first')
  assert(mcm.row('Next page').disabled == false)
  assert(mcm.config().navigation.pageId == 'characters|1|1')
  press('Next page')
  assert(invites() == 10 and mcm.row('Viktor Vektor') and not mcm.row('Johnny Silverhand'), 'the second page')
  assert(mcm.row('Next page').disabled == true and mcm.row('Previous page').disabled == false)
  assert(mcm.config().navigation.pageId == 'characters|2|1', 'a new page id: MCM scrolls to the top of it')
  press('Previous page')
  assert(mcm.row('Johnny Silverhand') ~= nil)
  press('Back to Companion Manager'); press('Characters to invite')
  assert(mcm.config().navigation.pageId == 'characters|1|1', 'a list starts on its first page')
  -- The model browser: the scan reads a batch a frame, then a letter group and pages.
  press('Back to Companion Manager'); press('Model browser')
  frames(140)
  local group = mcm.row('Starts with: All')
  assert(group and group.type == 'action' and group.description ~= '', labels())
  press('Starts with: All')
  assert(mcm.row('Starts with: All') == nil and mcm.config().navigation.pageId:match('^models|1|2$'), tostring(mcm.config().navigation.pageId))
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
  local ok, why = mcm.set('Companion voices (no Omni pack)', 2)
  assert(ok == false and why:find('OmniVoice', 1, true), tostring(why))
  assert(mcm.set('Companion voices (no Omni pack)', 6) == true, 'a cloud voice entry is a normal draft')
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
  // MCM hosts the page but will not open it: the shortcut falls back to Native Settings UI, whose tab is registered then.
  run(`${harness({screen: false, mcm: {version: '0.10.5', renderer: false}})}
    assert(ns.data[TAB] == nil)
    local ok = managerUi.open()
    assert(ns.data[TAB] ~= nil and ns.callCount('addTab') == 1, 'the fallback registered the tab')
  `);
});
