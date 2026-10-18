import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import fengari from 'fengari';
import {uiLocaleBootstrap} from './ui-locale-fixture.mjs';

// Settings > Conversation provider > Convai paid tier inside the real MCM adapter (docs/CONVAI_PAID_TIER.md). The harness is the one
// of support-help-ui.test.mjs (real manager.lua, mcm.lua and manager-party.lua over a fake native MCM and game) with
// convai-paid-tier.lua added to its module map. The conversation service is played by the test: it writes the status file the
// service would publish. Nothing here reaches Convai, Stripe or a browser.
const {lua, lauxlib, lualib, to_luastring, to_jsstring} = fengari;
const read = name => readFileSync(new URL(`../mod/${name}`, import.meta.url), 'utf8');
const managerSource = read('manager.lua'), queueSource = read('manager-party.lua'), mcmSource = read('mcm.lua');
const voicePreviewSource = read('voice-preview.lua'), fontsSource = read('ui-fonts.lua'), mcmFontsSource = read('mcm-fonts.lua');
const supportSource = read('support-report.lua'), serviceSource = read('service-status.lua'), editorSource = read('character-editor.lua');
const paidSource = read('convai-paid-tier.lua');

function run(code) {
  const state = lauxlib.luaL_newstate();
  lualib.luaL_openlibs(state);
  const status = lauxlib.luaL_dostring(state, to_luastring(uiLocaleBootstrap + code));
  const error = status === lua.LUA_OK ? '' : to_jsstring(lua.lua_tostring(state, -1));
  lua.lua_close(state);
  assert.equal(status, lua.LUA_OK, error);
}

const storage = `
  local files, saved, seed, extras = {}, nil, {}, nil
  local jsonFixtures, jsonSequence, fileWrites = {}, 0, {}
  local failSave = false
  io = {open = function(path, mode)
    if mode == 'rb' then
      if not files[path] then return nil end
      return {read = function() return files[path] end, close = function() return true end}
    end
    if failSave then return nil end
    return {write = function(_, value)
      fileWrites[#fileWrites + 1] = {path = path, value = value}
      files[path] = value; return true
    end, close = function() return true end}
  end}
  json = {decode = function(value)
    if jsonFixtures[value] then return jsonFixtures[value] end
    if value == 'seed' then return seed end
    if value == 'extras' then return extras end
    if value == 'saved' then return saved end
    error('unexpected JSON fixture')
  end, encode = function(value)
    if value.action == 'clear' then
      jsonSequence = jsonSequence + 1
      local token = 'memory-json-' .. jsonSequence
      jsonFixtures[token] = value
      return token
    end
    jsonSequence = jsonSequence + 1
    local token = 'settings-json-' .. jsonSequence
    jsonFixtures[token] = value
    return token
  end}
  os.rename = function(from, to)
    if not files[from] or files[to] then return nil end
    files[to], files[from] = files[from], nil
    if to == 'runtime/settings.json' then saved = jsonFixtures[files[to]] end
    return true
  end
  os.remove = function(path) files[path] = nil; return true end
`;

const managerFixture = `
  ${storage}
  local defs, members, spawned, nextSerial = {}, {}, {}, 0
  local api = {}
  function api.definition(key) return defs[key] end
  function api.registerDefinition(key, value) defs[key] = value; return true end
  function api.list() return members end
  function api.spawn(key)
    nextSerial = nextSerial + 1
    spawned[#spawned + 1] = key
    local def = assert(defs[key])
    members[#members + 1] = {serial = nextSerial, key = key, name = def.name,
      profileKey = def.profileKey, profileName = def.profileName or def.name,
      record = def.id, state = 'spawning'}
    return nextSerial
  end
  function api.dismiss(serial)
    for index, member in ipairs(members) do
      if member.serial == serial then table.remove(members, index); return true end
    end
    return false
  end
  function api.setProfile(serial, key, name)
    for _, member in ipairs(members) do
      if member.serial == serial then member.profileKey, member.profileName = key, name; return true end
    end
    return false, 'That companion is no longer in your party.'
  end
  local scans, visits = 0, 0
  TweakDB = {}
  function TweakDB:GetRecords(kind)
    assert(kind == 'gamedataCharacter_Record')
    scans = scans + 1
    local result = {}
    for index = 1, 6000 do
      local id = index == 1 and 'Character.Silverhand' or ('Character.Model_' .. index)
      result[index] = {GetID = function() visits = visits + 1; return id end}
    end
    return result
  end
  function TweakDB:GetFlat(id) return id:gsub('%.displayName$', '') end
  GetLocalizedText = function(text) return text end
  local player = {hash = 'player-1', open = true, queue = {}, rows = {}, voice = true, subtitles = true}
  function player:GetEntityID() return {hash = self.hash} end
  function player:ConvaiManagerIsOpen() return self.open end
  function player:ConvaiManagerTakeRequest() return table.remove(self.queue, 1) or '' end
  function player:ConvaiManagerClearRows() self.rows = {} end
  function player:ConvaiManagerAddRow(key, label, note, selected)
    self.rows[#self.rows + 1] = {key = key, label = label, note = note, selected = selected}
    assert(#self.rows <= 8, 'unbounded native rows')
  end
  function player:ConvaiManagerSetDetail(...) self.detail = {...} end
  function player:ConvaiManagerSetPage(...) self.page = {...} end
  function player:ConvaiManagerSetTab(value) self.tab = value end
  function player:ConvaiManagerSetSearch(value) self.search = value end
  function player:ConvaiManagerSetFeedback(value) self.feedback = value end
  function player:ConvaiManagerSetPartyStatus(value) self.partyStatus = value end
  function player:ConvaiManagerRefresh() self.refreshes = (self.refreshes or 0) + 1 end
  function player:ConvaiManagerSetVoice(value) self.voice = value end
  function player:ConvaiManagerVoice() return self.voice end
  function player:ConvaiManagerSetSubtitles(value) self.subtitles = value end
  function player:ConvaiManagerSubtitles() return self.subtitles end
  function player:ConvaiManagerSetEnabled(index, value) self['legacy' .. index] = value end
  local profiles = {{key = 'viktor-vektor', name = 'Viktor Vektor', records = {'Character.Victor_Vector'}},
    {key = 'johnny-silverhand', name = 'Johnny Silverhand', records = {'Character.Silverhand'}}}
  for index = 1, 20 do profiles[#profiles + 1] = {key = 'person-' .. index,
    name = string.format('Person %02d', index), records = {'Character.Person_' .. index}, summary = 'A distinct person.'} end
  local manager = (function() ${managerSource} end)()
  local function request(value, dt) player.queue[#player.queue + 1] = value; manager.update(player, dt or 0.1) end
`;

const mcmFixture = (withSupport = true) => `
  ${managerFixture}
  local originalDofile = dofile
  dofile = function(path)
    if path == 'voice-preview.lua' then return (function() ${voicePreviewSource} end)() end
    if path == 'support-report.lua' then if not ${withSupport} then error('module absent') end return (function() ${supportSource} end)() end
    if path == 'service-status.lua' then return (function() ${serviceSource} end)() end
    if path == 'character-editor.lua' then return (function() ${editorSource} end)() end
    if path == 'convai-paid-tier.lua' then return (function() ${paidSource} end)() end
    if path == 'ui-fonts.lua' then return (function() ${fontsSource} end)() end
    if path == 'mcm-fonts.lua' then return (function() ${mcmFontsSource} end)() end
    return originalDofile(path)
  end
  manager.configure(api, profiles)
  convaiNotices.configure(function() return manager.developerMode() end) -- as init.lua does
  local handlers, registered, loaded, activeMod = {}, nil, nil, nil
  local drafts, reloads = false, 0
  local nativeApi = {apiVersion = 2, providers = {}}
  nativeApi.providers.registerProvider = function(value) registered = value; return true end
  nativeApi.providers.unregisterProvider = function(id) assert(id == registered.id); registered = nil; return true end
  nativeApi.refreshProvider = function() return true end
  nativeApi.getDiagnostics = function() return {activeModKey = activeMod} end
  nativeApi.hasDrafts = function() return drafts end
  nativeApi.reloadMod = function()
    reloads = reloads + 1; loaded = registered.loadMod('manager'); return loaded
  end
  GetMod = function(name) assert(name == 'ModConfigurationMenuAPI'); return nativeApi end
  Game = {GetPlayer = function() return player end}
  Observe = function(class, method, callback) handlers[method] = callback end
  ObserveAfter = Observe
  Override = Observe
  local entryFactory = {new = function()
    return {install = function() end, update = function() end, selected = function() end,
      state = function() return 'idle' end, reset = function() end, open = function() return true end}
  end}
  local mcm = (function() ${mcmSource} end)()
  mcm.configure(manager, api, (function() ${queueSource} end)(), entryFactory)
  mcm.install()
  activeMod = 'cyberpunk-convai:manager'
  loaded = registered.loadMod('manager')
  local function row(id)
    for _, category in ipairs(loaded.categories) do
      for _, setting in ipairs(category.settings) do if setting.id == id then return setting end end
    end
  end
  local controller = {nativeIdentity = 101,
    McmUiEmitSearch = function(_, context, value) handlers.McmUiEmitSearch(nil, context, value) end}
  CalcSeed = function(value) return value.nativeIdentity end
  local function invoke(id)
    local result = registered.invokeAction('manager', id, {interaction = {controller = controller}})
    if result.ok and result.schemaChanged then loaded = registered.loadMod('manager') end
    return result
  end
`;

const paidFixture = `
  ${mcmFixture(true)}
  -- The fake CPU clock starts far ahead of the real one the modules read while the harness was built, so their throttles see time pass.
  local clockNow, popups, cpu = 1800000000, {}, 100000
  os.time = function() return clockNow end
  os.clock = function() return cpu end
  local function advance(seconds) clockNow = clockNow + seconds; cpu = cpu + seconds end
  local function pump(gameplay, frames) for _ = 1, frames or 10 do advance(0.5); mcm.update(player, gameplay) end end
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
    assert(invoke('paid-tier').ok and mcm.inspect().view == 'paid-tier')
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
  assert(invoke('paid-tier').ok and mcm.inspect().view == 'paid-tier')
  assert(command().action == 'refresh', 'opening the page asks the service for the plans and the plan state')
  loaded = registered.loadMod('manager')
  assert(mcm.inspect().back.id == 'paid-tier:back')
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
      assert(not text:find('price_', 1, true) and not text:lower():find('recommend') and not text:find('Inworld', 1, true), text)
    end
  end
  assert(invoke('paid-tier:back').ok and mcm.inspect().view == 'settings')
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
  assert(current and current.value == 'Current plan' and current.disabled == true and current.capabilities.action == false)
  assert(not row('paid:buy:gamer-monthly'), 'no Buy on the current plan')
  assert(current.description:find('500 Convai interactions a month.', 1, true) and current.description:find('your current plan', 1, true))
  local before = command().id
  assert(invoke('paid:current:gamer-monthly').ok and command().id == before, 'choosing it sends nothing')
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
  assert(mcm.inspect().paidStatus == nil and not mcm.inspect().paidStatusPending, 'nothing pending before a paid action')
  assert(invoke('paid:buy:gamer-monthly').ok)
  assert(mcm.inspect().paidStatus == 'Asking Convai for the payment page…' and mcm.inspect().paidStatusPending)
  service({plan = {name = 'Free', paid = false}, result = {id = command().id, state = 'working'}})
  pump(false, 6)
  assert(mcm.inspect().paidStatus == 'Contacting Convai…', tostring(mcm.inspect().paidStatus))
  service({plan = {name = 'Free', paid = false}, result = {id = command().id, state = 'opened'}, watch = {state = 'watching', plan = 'gamer-monthly'}})
  pump(false, 6)
  assert(mcm.inspect().paidStatus:find('payment page is open in your browser', 1, true), tostring(mcm.inspect().paidStatus))
  assert(mcm.inspect().paidStatusPending, 'still following the purchase')
  service({plan = {name = 'GamerPlanV2-Monthly', paid = true}, result = {id = command().id, state = 'opened'}, watch = {state = 'active', plan = 'gamer-monthly'}})
  pump(false, 6)
  assert(mcm.inspect().paidStatus == 'Your Convai plan is active.', tostring(mcm.inspect().paidStatus))
  assert(not mcm.inspect().paidStatusPending, 'final: no more looking')
  -- A check: "Checking your plan…", then the answer.
  assert(invoke('paid:check').ok)
  assert(mcm.inspect().paidStatus == 'Checking your plan…')
  service({plan = {name = 'Free', paid = false}, result = {id = command().id, state = 'not-yet'}})
  pump(false, 6)
  assert(mcm.inspect().paidStatus == 'Convai does not show a paid plan for your key yet.', tostring(mcm.inspect().paidStatus))
  assert(not mcm.inspect().paidStatusPending)
  -- A purchase Convai did not confirm in time, and a refused checkout.
  assert(invoke('paid:buy:pro-monthly').ok)
  service({result = {id = command().id, state = 'opened'}, watch = {state = 'timeout', plan = 'pro-monthly'}})
  pump(false, 6)
  assert(mcm.inspect().paidStatus:find('has not confirmed your plan yet', 1, true))
  assert(not mcm.inspect().paidStatusPending)
  assert(invoke('paid:buy:pro-yearly').ok)
  service({result = {id = command().id, state = 'invalid-key'}})
  pump(false, 6)
  assert(mcm.inspect().paidStatus == 'Convai did not accept your API key.')
  -- Leaving the page drops the line.
  assert(invoke('paid-tier:back').ok)
  pump(false, 4)
  assert(mcm.inspect().paidStatus == nil)
`));

test('the status line waits at most seven minutes for an answer that never comes, and reads nothing once it stopped', () => run(`${paidFixture}
  jsonFile('runtime/own-key-state.json', {version = 1, saved = true, tail = 'abcd', active = 'shared'})
  service({})
  openPage()
  assert(invoke('paid:check').ok)
  pump(false, 40)
  assert(mcm.inspect().paidStatus == 'Checking your plan…' and mcm.inspect().paidStatusPending, 'no answer yet: the first sentence stays')
  advance(430); pump(false, 4)
  assert(not mcm.inspect().paidStatusPending, 'gave up looking after seven minutes')
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
