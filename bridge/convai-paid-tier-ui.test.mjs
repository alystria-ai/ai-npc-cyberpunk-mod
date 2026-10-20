import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {run, nsuiHarness} from './manager-fixture.mjs';

// Settings > Conversation provider > Convai paid tier inside the real manager host (docs/CONVAI_PAID_TIER.md). The harness is the one
// of manager.test.mjs (real manager.lua, manager-ui.lua, nsui.lua and manager-party.lua over a fake Native Settings UI and game) with
// convai-paid-tier.lua added to its module map. The conversation service is played by the test: it writes the status file the
// service would publish. Nothing here reaches Convai, Stripe or a browser.
const read = name => readFileSync(new URL(`../mod/${name}`, import.meta.url), 'utf8');
const supportSource = read('support-report.lua'), serviceSource = read('service-status.lua'), editorSource = read('character-editor.lua');
const paidSource = read('convai-paid-tier.lua');

const pageFixture = (withSupport = true) => nsuiHarness({
  modules: {'service-status.lua': serviceSource, 'character-editor.lua': editorSource, 'convai-paid-tier.lua': paidSource,
    ...(withSupport ? {'support-report.lua': supportSource} : {})},
  absent: withSupport ? [] : ['support-report.lua'],
}) + `
  convaiNotices.configure(function() return manager.developerMode() end) -- as init.lua does
`;

const paidFixture = `
  ${pageFixture(true)}
  -- The fake CPU clock starts far ahead of the real one the modules read while the harness was built, so their throttles see time pass.
  local clockNow, popups, cpu = 1800000000, {}, 100000
  os.time = function() return clockNow end
  os.clock = function() return cpu end
  local function advance(seconds) clockNow = clockNow + seconds; cpu = cpu + seconds end
  local function pump(gameplay, frames)
    for _ = 1, frames or 10 do advance(0.5); managerUi.update(player, gameplay) end
    loaded = registered.loadMod('manager')
  end
  function player:ConvaiPhoneFeedback(text) popups[#popups + 1] = text end
  local function jsonFile(path, value)
    jsonSequence = jsonSequence + 1
    local token = 'paid-fixture-' .. jsonSequence
    jsonFixtures[token] = value; files[path] = token
  end
  local function category(id)
    for _, item in ipairs(loaded.categories) do if item.id == id then return item end end
  end
  local function command() return jsonFixtures[files['runtime/paid-tier-command.json']] end
  local PLANS = {
    {id = 'gamer-monthly', name = 'Gamer', period = 'monthly', price = '$4', interactions = 500, concurrency = 6},
    {id = 'gamer-yearly', name = 'Gamer', period = 'yearly', price = '$32', interactions = 500, concurrency = 6},
    {id = 'pro-monthly', name = 'Gamer Pro', period = 'monthly', price = '$8', interactions = 1000},
    {id = 'pro-yearly', name = 'Gamer Pro', period = 'yearly', price = '$64', interactions = 1000}}
  local function service(extra)
    local value = {version = 1, updated = clockNow * 1000.0, keySaved = true, plans = PLANS}
    for key, item in pairs(extra or {}) do value[key] = item end
    jsonFile('runtime/paid-tier-state.json', value)
  end
  local function openPage()
    assert(invoke('tab:settings').ok)
    assert(invoke('paid-tier').ok and managerUi.inspect().view == 'paid-tier')
    pump(false, 4)
    loaded = registered.loadMod('manager')
  end
`;

test('Settings lists Convai paid tier under the Convai API key row; the page shows the plans and needs a key to buy', () => run(`${paidFixture}
  jsonFile('runtime/own-key-state.json', {version = 1, saved = false, active = 'shared'})
  service({keySaved = false})
  assert(invoke('tab:settings').ok)
  local provider = category('conversation-provider').settings
  local ownIndex, paidIndex
  for index, item in ipairs(provider) do
    if item.id == 'own-key' then ownIndex = index end
    if item.id == 'paid-tier' then paidIndex = index end
  end
  assert(ownIndex and paidIndex == ownIndex + 1, 'the paid tier entry sits right under the Convai API key row')
  assert(row('paid-tier').value == 'Open')
  assert(not row('paid-tier').description:lower():find('recommend'), 'no option is called recommended')
  assert(invoke('paid-tier').ok and managerUi.inspect().view == 'paid-tier')
  assert(command().action == 'refresh', 'opening the page asks the service for the plans and the plan state')
  loaded = registered.loadMod('manager')
  assert(loaded.categories[1].settings[1].id == 'paid-tier:back')
  assert(row('paid-plan').value == 'No key added')
  assert(row('paid:sign-in') and row('paid:sign-in').value == 'Sign in' and row('paid:key-page') and row('paid-own-key') and row('paid-own-key').value == 'Paste')
  local labels = {}
  for _, plan in ipairs(category('paid-plans').settings) do labels[#labels + 1] = plan.label end
  assert(table.concat(labels, '|') == 'Gamer, $4 a month|Gamer, $32 a year|Gamer Pro, $8 a month|Gamer Pro, $64 a year|Check my plan|Manage or cancel plan',
    table.concat(labels, '|'))
  assert(row('paid:buy:gamer-monthly').description:find('500 Convai interactions a month.', 1, true))
  assert(row('paid:buy:pro-yearly').description:find('Billed once a year.', 1, true))
  assert(row('paid:buy:pro-monthly').description:find('1000 Convai interactions a month.', 1, true))
  assert(not row('paid:buy:pro-monthly').description:find('More Convai', 1, true), 'no vague more wording')
  assert(not invoke('paid:buy:gamer-monthly').ok, 'no purchase without a key')
  assert(command().action == 'refresh', 'a refused purchase sends nothing')
  assert(invoke('paid:manage').ok and command().action == 'manage')
  assert(invoke('paid:key-page').ok and command().action == 'key-page')
  for _, section in ipairs(loaded.categories) do
    for _, item in ipairs(section.settings) do
      local text = (item.label or '') .. ' ' .. (item.description or '') .. ' ' .. tostring(item.value or '')
      assert(not text:find('price_', 1, true) and not text:lower():find('recommend'), text)
    end
  end
  assert(invoke('paid-tier:back').ok and managerUi.inspect().view == 'settings')
`));

test('without the conversation service the page says so instead of showing plans', () => run(`${paidFixture}
  jsonFile('runtime/own-key-state.json', {version = 1, saved = true, tail = 'abcd', active = 'shared'})
  assert(invoke('tab:settings').ok and invoke('paid-tier').ok)
  loaded = registered.loadMod('manager')
  assert(row('paid-unavailable') and not category('paid-plans'))
`));

test('an empty status file (the shipped placeholder) is no service yet, and every command is written in place over the command file', () => run(`${paidFixture}
  jsonFile('runtime/own-key-state.json', {version = 1, saved = true, tail = 'abcd', active = 'shared'})
  files['runtime/paid-tier-state.json'] = ''
  files['runtime/paid-tier-command.json'] = ''
  local removed, renamed, opened = {}, {}, {}
  local function exempt(path) return tostring(path):find('runtime/settings.json', 1, true) == 1 end
  local remove, rename, open = os.remove, os.rename, io.open
  os.remove = function(path) if not exempt(path) then removed[#removed + 1] = path end return remove(path) end
  os.rename = function(from, to) if not exempt(from) then renamed[#renamed + 1] = from end return rename(from, to) end
  io.open = function(path, mode) if mode == 'wb' and not exempt(path) then opened[#opened + 1] = path end return open(path, mode) end
  assert(invoke('tab:settings').ok and invoke('paid-tier').ok)
  loaded = registered.loadMod('manager')
  assert(row('paid-unavailable') and not category('paid-plans'), 'an empty status file reads as no service')
  assert(command().action == 'refresh')
  assert(invoke('paid-tier:back').ok and invoke('paid-tier').ok and command().action == 'refresh')
  assert(#removed == 0 and #renamed == 0, 'the command file was removed or renamed: ' .. table.concat(removed, ',') .. '|' .. table.concat(renamed, ','))
  local commands = 0
  for _, path in ipairs(opened) do
    assert(not path:find('.tmp', 1, true) and not path:find('.previous', 1, true), 'a side file was written: ' .. path)
    if path == 'runtime/paid-tier-command.json' then commands = commands + 1 end
  end
  assert(commands == 2, commands)
`));

test('a confirmed purchase moves conversations to the player key and says so once in gameplay', () => run(`${paidFixture}
  jsonFile('runtime/own-key-state.json', {version = 1, saved = true, tail = 'abcd', active = 'shared'})
  service({plan = {name = 'Free', paid = false}})
  openPage()
  assert(row('paid-plan').value == 'Free', 'plan row: ' .. tostring(row('paid-plan') and row('paid-plan').value))
  local result = invoke('paid:buy:gamer-yearly')
  assert(result.ok, tostring(result.error))
  local sent = command()
  assert(sent.action == 'buy' and sent.plan == 'gamer-yearly' and sent.version == 1)
  -- The service opened Stripe and is following the plan.
  service({plan = {name = 'Free', paid = false}, result = {id = sent.id, state = 'opened'}, watch = {state = 'watching', plan = 'gamer-yearly'}})
  pump(false, 8)
  assert(saved == nil or saved.useOwnConvaiKey ~= true, 'nothing changes before Convai confirms the plan')
  assert(#popups == 0)
  -- Reopening the page during the purchase does not end it.
  assert(invoke('paid-tier:back').ok and invoke('paid-tier').ok)
  service({plan = {name = 'GamerPlanV2', paid = true}, result = {id = command().id, state = 'ready'}, watch = {state = 'active', plan = 'gamer-yearly'}})
  pump(false, 8)
  assert(saved and saved.useOwnConvaiKey == true and saved.conversationProvider == 'convai', 'the provider became Convai API key')
  assert(#popups == 0, 'the notice waits for gameplay')
  pump(true, 4)
  assert(#popups == 1 and popups[1]:find('Your Convai plan is active. Conversations now use your Convai API key.', 1, true), tostring(popups[1]))
  pump(true, 20)
  assert(#popups == 1, 'once')
`));

test('a purchase Convai does not confirm in time leaves the settings alone; a later check that finds the plan switches', () => run(`${paidFixture}
  jsonFile('runtime/own-key-state.json', {version = 1, saved = true, tail = 'abcd', active = 'shared'})
  service({})
  openPage()
  assert(invoke('paid:buy:pro-monthly').ok)
  service({result = {id = command().id, state = 'opened'}, watch = {state = 'timeout', plan = 'pro-monthly'}})
  pump(true, 8)
  assert(saved == nil or saved.useOwnConvaiKey ~= true)
  assert(#popups == 1 and popups[1]:find('Convai has not confirmed your plan yet.', 1, true), tostring(popups[1]))
  loaded = registered.loadMod('manager')
  assert(invoke('paid:check').ok and command().action == 'check')
  service({plan = {name = 'GamerProPlanV2', paid = true}, result = {id = command().id, state = 'active'}})
  pump(true, 8)
  assert(saved and saved.useOwnConvaiKey == true)
  assert(#popups == 2 and popups[2]:find('Your Convai plan is active.', 1, true), tostring(popups[2]))
`));

test('Sign in with Convai: the row sends a sign-in, the page words each outcome, and the row goes once a key is saved', () => run(`${paidFixture}
  jsonFile('runtime/own-key-state.json', {version = 1, saved = false, active = 'shared'})
  service({keySaved = false})
  openPage()
  local result = invoke('paid:sign-in')
  assert(result.ok and command().action == 'sign-in', 'the row sends a sign-in')
  service({keySaved = false, result = {id = command().id, state = 'signing-in'}})
  pump(false, 4)
  loaded = registered.loadMod('manager')
  assert(row('paid-plan').description:find('Sign in on the Convai page in your browser.', 1, true), row('paid-plan').description)
  service({keySaved = false, result = {id = command().id, state = 'signin-timeout'}})
  pump(false, 4)
  loaded = registered.loadMod('manager')
  assert(row('paid-plan').description:find('The sign-in took too long.', 1, true))
  assert(invoke('paid:sign-in').ok)
  service({keySaved = false, result = {id = command().id, state = 'signin-failed'}})
  pump(false, 4)
  loaded = registered.loadMod('manager')
  assert(row('paid-plan').description:find('copy your key from convai.com and choose Paste', 1, true))
  assert(invoke('paid:sign-in').ok)
  jsonFile('runtime/own-key-state.json', {version = 1, saved = true, tail = 'cdef', active = 'shared'})
  service({keySaved = true, result = {id = command().id, state = 'saved'}})
  pump(false, 4)
  loaded = registered.loadMod('manager')
  assert(row('paid-plan').description:find('Signed in. Your Convai API key is saved.', 1, true))
  assert(not row('paid:sign-in') and not row('paid:key-page'), 'with a key saved the sign-in and key page rows go')
  assert(row('paid-own-key').value == 'Remove' and row('paid-own-key').label:find('cdef', 1, true), 'the key row shows the saved key')
  assert(#popups == 0 and (saved == nil or saved.useOwnConvaiKey ~= true), 'a sign-in alone changes no setting, as Paste')
`));

test('a refused checkout is worded on the page and follows nothing', () => run(`${paidFixture}
  jsonFile('runtime/own-key-state.json', {version = 1, saved = true, tail = 'abcd', active = 'shared'})
  service({})
  openPage()
  assert(invoke('paid:buy:gamer-monthly').ok)
  service({result = {id = command().id, state = 'invalid-key'}})
  pump(true, 8)
  loaded = registered.loadMod('manager')
  assert(row('paid-plan').description:find('Convai did not accept your API key.', 1, true))
  assert(#popups == 0 and (saved == nil or saved.useOwnConvaiKey ~= true))
`));

test('the plan row names the plan in plain words: the four V2 names, Free for a free or trial plan, an unknown name as written', () => run(`${paidFixture}
  jsonFile('runtime/own-key-state.json', {version = 1, saved = true, tail = 'abcd', active = 'shared'})
  local cases = {
    {'GamerPlanV2-Monthly', true, 'Gamer, monthly'}, {'GamerPlanV2-Yearly', true, 'Gamer, yearly'},
    {'GamerProPlanV2-Monthly', true, 'Gamer Pro, monthly'}, {'GamerProPlanV2-Yearly', true, 'Gamer Pro, yearly'},
    {'Free', false, 'Free'}, {'trial', false, 'Free'}, {'SomethingNew', true, 'SomethingNew'}}
  service({plan = {name = 'Free', paid = false}})
  openPage()
  for _, case in ipairs(cases) do
    service({plan = {name = case[1], paid = case[2]}})
    pump(false, 4); loaded = registered.loadMod('manager')
    assert(row('paid-plan').value == case[3], case[1] .. ' shows ' .. tostring(row('paid-plan').value))
  end
`));

test('the row of the current plan says Current plan and buys nothing; the other plans stay buyable', () => run(`${paidFixture}
  jsonFile('runtime/own-key-state.json', {version = 1, saved = true, tail = 'abcd', active = 'shared'})
  service({plan = {name = 'GamerPlanV2-Monthly', paid = true}})
  openPage()
  local current = row('paid:current:gamer-monthly')
  assert(current and current.value == 'Current plan' and current.disabled == true)
  assert(not row('paid:buy:gamer-monthly'), 'no Buy on the current plan')
  assert(current.description:find('500 Convai interactions a month.', 1, true) and current.description:find('your current plan', 1, true))
  local before = command().id
  assert(not invoke('paid:current:gamer-monthly').ok and command().id == before, 'choosing it sends nothing (the row is not an action)')
  for _, id in ipairs({'gamer-yearly', 'pro-monthly', 'pro-yearly'}) do
    assert(row('paid:buy:' .. id) and row('paid:buy:' .. id).value == 'Buy' and not row('paid:buy:' .. id).disabled, id)
  end
  -- A free plan, an expired one or another plan of the same tier is not the current plan.
  service({plan = {name = 'GamerPlanV2-Monthly', paid = false}})
  pump(false, 4); loaded = registered.loadMod('manager')
  assert(row('paid:buy:gamer-monthly') and not row('paid:current:gamer-monthly'))
  service({plan = {name = 'GamerProPlanV2-Yearly', paid = true}})
  pump(false, 4); loaded = registered.loadMod('manager')
  assert(row('paid:current:pro-yearly') and row('paid:buy:pro-monthly') and row('paid:buy:gamer-monthly') and not row('paid:current:gamer-monthly'))
`));

test('the status line follows the answer: payment page opened, plan confirmed, a check, a refusal; and stops looking once it is final', () => run(`${paidFixture}
  jsonFile('runtime/own-key-state.json', {version = 1, saved = true, tail = 'abcd', active = 'shared'})
  service({plan = {name = 'Free', paid = false}})
  openPage()
  assert(managerUi.inspect().paidStatus == nil and not managerUi.inspect().paidStatusPending, 'nothing pending before a paid action')
  assert(invoke('paid:buy:gamer-monthly').ok)
  assert(managerUi.inspect().paidStatus == 'Asking Convai for the payment page…' and managerUi.inspect().paidStatusPending)
  service({plan = {name = 'Free', paid = false}, result = {id = command().id, state = 'working'}})
  pump(false, 6)
  assert(managerUi.inspect().paidStatus == 'Contacting Convai…', tostring(managerUi.inspect().paidStatus))
  service({plan = {name = 'Free', paid = false}, result = {id = command().id, state = 'opened'}, watch = {state = 'watching', plan = 'gamer-monthly'}})
  pump(false, 6)
  assert(managerUi.inspect().paidStatus:find('payment page is open in your browser', 1, true), tostring(managerUi.inspect().paidStatus))
  assert(managerUi.inspect().paidStatusPending, 'still following the purchase')
  service({plan = {name = 'GamerPlanV2-Monthly', paid = true}, result = {id = command().id, state = 'opened'}, watch = {state = 'active', plan = 'gamer-monthly'}})
  pump(false, 6)
  assert(managerUi.inspect().paidStatus == 'Your Convai plan is active.', tostring(managerUi.inspect().paidStatus))
  assert(not managerUi.inspect().paidStatusPending, 'final: no more looking')
  -- A check: "Checking your plan…", then the answer.
  assert(invoke('paid:check').ok)
  assert(managerUi.inspect().paidStatus == 'Checking your plan…')
  service({plan = {name = 'Free', paid = false}, result = {id = command().id, state = 'not-yet'}})
  pump(false, 6)
  assert(managerUi.inspect().paidStatus == 'Convai does not show a paid plan for your key yet.', tostring(managerUi.inspect().paidStatus))
  assert(not managerUi.inspect().paidStatusPending)
  -- A purchase Convai did not confirm in time, and a refused checkout.
  assert(invoke('paid:buy:pro-monthly').ok)
  service({result = {id = command().id, state = 'opened'}, watch = {state = 'timeout', plan = 'pro-monthly'}})
  pump(false, 6)
  assert(managerUi.inspect().paidStatus:find('has not confirmed your plan yet', 1, true))
  assert(not managerUi.inspect().paidStatusPending)
  assert(invoke('paid:buy:pro-yearly').ok)
  service({result = {id = command().id, state = 'invalid-key'}})
  pump(false, 6)
  assert(managerUi.inspect().paidStatus == 'Convai did not accept your API key.')
  -- Leaving the page drops the line.
  assert(invoke('paid-tier:back').ok)
  pump(false, 4)
  assert(managerUi.inspect().paidStatus == nil)
`));

test('the status line waits at most seven minutes for an answer that never comes, and reads nothing once it stopped', () => run(`${paidFixture}
  jsonFile('runtime/own-key-state.json', {version = 1, saved = true, tail = 'abcd', active = 'shared'})
  service({})
  openPage()
  assert(invoke('paid:check').ok)
  pump(false, 40)
  assert(managerUi.inspect().paidStatus == 'Checking your plan…' and managerUi.inspect().paidStatusPending, 'no answer yet: the first sentence stays')
  advance(430); pump(false, 4)
  assert(not managerUi.inspect().paidStatusPending, 'gave up looking after seven minutes')
`));

test('each of the four plan rows shows its own quota, whatever the running service sent: Gamer 500, Gamer Pro 1000', () => run(`${paidFixture}
  jsonFile('runtime/own-key-state.json', {version = 1, saved = true, tail = 'abcd', active = 'shared'})
  local function quotas()
    local seen = {}
    for _, id in ipairs({'gamer-monthly', 'gamer-yearly', 'pro-monthly', 'pro-yearly'}) do
      local item = row('paid:buy:' .. id) or row('paid:current:' .. id)
      local number = item.description:match('^(%d+) Convai interactions a month%.')
      seen[#seen + 1] = id .. '=' .. tostring(number)
    end
    return table.concat(seen, ' ')
  end
  local want = 'gamer-monthly=500 gamer-yearly=500 pro-monthly=1000 pro-yearly=1000'
  service({plan = {name = 'Free', paid = false}})
  openPage()
  assert(quotas() == want, quotas())
  -- A service started before this file changed still sends 1000 for Gamer and nothing for Gamer Pro.
  jsonFile('runtime/paid-tier-state.json', {version = 1, updated = clockNow * 1000.0, keySaved = true, plan = {name = 'Free', paid = false}, plans = {
    {id = 'gamer-monthly', name = 'Gamer', period = 'monthly', price = '$4', interactions = 1000, concurrency = 6},
    {id = 'gamer-yearly', name = 'Gamer', period = 'yearly', price = '$32', interactions = 1000, concurrency = 6},
    {id = 'pro-monthly', name = 'Gamer Pro', period = 'monthly', price = '$8'},
    {id = 'pro-yearly', name = 'Gamer Pro', period = 'yearly', price = '$64'}}})
  pump(false, 4); loaded = registered.loadMod('manager')
  assert(quotas() == want, 'stale service: ' .. quotas())
  -- The current plan's row and a plan family the page does not know.
  service({plan = {name = 'GamerProPlanV2-Monthly', paid = true}})
  pump(false, 4); loaded = registered.loadMod('manager')
  assert(quotas() == want, 'current plan: ' .. quotas())
`));

test('Conversation provider: the Mistral free API key row sits above the Convai API key row, the paid tier entry right under the Convai key', () => run(`${paidFixture}
  jsonFile('runtime/own-key-state.json', {version = 1, saved = false, active = 'shared'})
  service({keySaved = false})
  assert(invoke('tab:settings').ok)
  local at = {}
  for index, item in ipairs(category('conversation-provider').settings) do at[item.id] = index end
  assert(at['mistral-key'] and at['own-key'] and at['paid-tier'], 'all three rows are there')
  assert(at['mistral-key'] < at['own-key'] and at['paid-tier'] == at['own-key'] + 1, 'Mistral, then Convai, then the paid tier entry')
  assert(row('mistral-key').label == 'Mistral free API key', row('mistral-key').label)
  assert(row('own-key').label == 'Convai API key')
  assert(not (row('mistral-key').label .. row('mistral-key').description):lower():find('recommend'))
`));
